// 端到端冒烟(CF Worker 网关版):pair + 信令 + WebRTC + vstream 全链路。
// 拓扑:
//   host 脚本(模拟 Mac 插件)──wss 信令──→ CF Worker ←─wss 信令──client 脚本(模拟手机)
//   host:DataChannel offerer,OPEN→连 TCP 回声服务器;DATA 双向泵
//   client:answerer,本地起「假 HttpClient」:OPEN+DATA 发文本,收回显校验
// 通过判据:client 发的 N 条消息经 P2P 通道到回声服务器原样返回,字节一致;
// 全程业务流量不经过 Worker(Worker 只见 SDP/ICE 信令帧)。
//
// 用法:
//   GATEWAY=https://dsh.pan2017.cn ADMIN_KEY=<管理密钥> node tools/e2e-smoke.mjs
import { PeerConnection } from 'node-datachannel'
import net from 'node:net'
import { randomUUID } from 'node:crypto'

const GATEWAY = (process.env.GATEWAY ?? 'https://dsh.pan2017.cn').replace(/\/+$/, '')
const ADMIN_KEY = process.env.ADMIN_KEY ?? ''
const HOST = process.env.HOST ?? 'e2e-' + randomUUID().slice(0, 6) + '.p2p'

if (!ADMIN_KEY) {
  console.error('需 ADMIN_KEY(网关管理密钥)')
  process.exit(1)
}
const log = (...a) => console.log('[e2e]', ...a)
const j = async (path, method, payload, headers = {}) => {
  const r = await fetch(GATEWAY + path, {
    method,
    headers: {
      ...(payload ? { 'content-type': 'application/json' } : {}),
      authorization: 'Bearer ' + ADMIN_KEY,
      ...headers,
    },
    body: payload ? JSON.stringify(payload) : undefined,
  })
  const t = await r.text()
  if (!r.ok) throw new Error(method + ' ' + path + ' → ' + r.status + ' ' + t)
  return JSON.parse(t)
}

// ── 1. 能力探测 + 配对拿设备令牌(手机亮码 → host claim → 手机 confirm) ──
const caps = await j('/signal/caps', 'GET')
if (caps.signaling !== true) throw new Error('gateway signaling not enabled')
log('caps ok, ice:', JSON.stringify(caps.ice))

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const code = Array.from({ length: 10 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('')
const secret = randomUUID().replace(/-/g, '')
const { pairing_id } = await j('/pair/start', 'POST', { code, secret, device: 'e2e-fake-phone' })
log('pairing started', pairing_id)
const claim = await j('/admin/pair/claim', 'POST', {
  code, host_code: 'ABC234', host_label: 'e2e-host', tunnel_host: HOST,
})
log('claim offered', claim.claim_id, '(host key:', HOST + ')')
const { token } = await j('/pair/confirm', 'POST', { pairing_id, secret, claim_id: claim.claim_id, host_code: 'ABC234' })
log('token ok (device e2e-fake-phone)')

// ── 2. host ticket + 信令通道 ────────────────────────────────────────────
const { ticket } = await j('/admin/signal/ticket', 'POST', { host: HOST })
log('host ticket ok')

// ── 3. TCP 回声服务器(扮演 dsh web) ────────────────────────────────────
// 纯字节回声:大消息跨多个 DATA 帧/TCP 块,逐块加前缀会让长度对不上。
const echo = net.createServer((sock) => {
  sock.on('data', (d) => sock.write(d))
})
await new Promise((r) => echo.listen(0, '127.0.0.1', r))
const echoPort = echo.address().port
log('echo server on', echoPort)

// ── vstream 帧(与 PROTOCOL.md 一致)─────────────────────────────────────
// 等 ICE 收集完成(SDP 非含候选即发必失败 —— 双方都收不到对方地址)。
// libdatachannel 生成的 answer 里 setup 仍是 actpass(offer 语义),
// 对端 setRemoteDescription 会拒 —— 收 answer 侧统一改写成 passive。
const fixAnswerSdp = (sdp) => String(sdp).replace(/a=setup:actpass/g, 'a=setup:passive')

const waitGathered = (pc, ms = 8000) => new Promise((res, rej) => {
  const t0 = Date.now()
  const tick = () => {
    if (pc.gatheringState() === 'complete') return res()
    if (Date.now() - t0 > ms) return rej(new Error('ice gathering timeout: ' + pc.gatheringState()))
    setTimeout(tick, 50)
  }
  tick()
})

const VS_MAGIC = 0xd5, VS_OPEN = 1, VS_DATA = 2, VS_CLOSE = 3
// 帧头 10 字节:magic(1)+sid(4)+cmd(1)+len(4);payload 从偏移 10 起。
const frame = (sid, cmd, payload) => {
  const h = Buffer.alloc(10)
  h.writeUInt8(VS_MAGIC, 0); h.writeUInt32BE(sid, 1); h.writeUInt8(cmd, 5); h.writeUInt32BE(payload.length, 6)
  return Buffer.concat([h, payload])
}

// ── host:信令 WS + offerer + vstream→TCP 桥 ─────────────────────────────
const hostWs = new WebSocket(GATEWAY.replace(/^http/, 'ws') + '/signal/host?ticket=' + encodeURIComponent(ticket))
await new Promise((res, rej) => { hostWs.onopen = res; hostWs.onerror = (e) => rej(new Error('host ws: ' + (e.message || e.type))) })
log('host signal ws open')
const hostSend = (o) => hostWs.send(JSON.stringify(o))
const hostPcs = new Map()
const hostStreams = new Map()

const offerFor = async (sid) => {
  const pc = new PeerConnection('host-' + sid.slice(0, 6), { iceServers: [] })
  hostPcs.set(sid, pc)
  const dc = pc.createDataChannel('dsh')
  dc.onOpen(() => log('host dc open sid=' + sid.slice(0, 8)))
  dc.onMessage((data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
    if (buf.length < 10 || buf[0] !== VS_MAGIC) return
    const vsid = buf.readUInt32BE(1), cmd = buf.readUInt8(5), len = buf.readUInt32BE(6)
    const payload = buf.subarray(10, 10 + len)
    if (cmd === VS_OPEN) {
      const sock = net.connect(echoPort, '127.0.0.1')
      hostStreams.set(vsid, sock)
      sock.on('data', (d) => { try { dc.sendMessageBinary(frame(vsid, VS_DATA, d)) } catch {} })
      sock.on('close', () => { try { dc.sendMessageBinary(frame(vsid, VS_CLOSE, Buffer.alloc(0))) } catch {} })
      log('host stream open vsid=' + vsid)
    } else if (cmd === VS_DATA) {
      hostStreams.get(vsid)?.write(payload)
    } else if (cmd === VS_CLOSE) {
      hostStreams.get(vsid)?.end()
    }
  })
  pc.onStateChange((s) => { if (s === 'failed') hostPcs.delete(sid) })
  pc.setLocalDescription()
  await waitGathered(pc, 8000)
  log('gathered, sending offer len=' + pc.localDescription().sdp.length)
  hostSend({ t: 'signal', sid, data: { type: 'offer', sdp: pc.localDescription().sdp } })
}

hostWs.onmessage = async (ev) => {
  const v = JSON.parse('' + ev.data)
  if (v.t === 'ping') return hostWs.send(JSON.stringify({ t: 'pong' }))
  if (v.t === 'offer-req') { log('offer-req recv'); await offerFor(String(v.sid)) }
  if (v.t === 'signal' && v.data.type === 'answer') {
    log('host applying answer')
    hostPcs.get(String(v.sid))?.setRemoteDescription(fixAnswerSdp(v.data.sdp), 'answer')
  }
}

// ── client:信令 WS + answerer + 本地消费 ────────────────────────────────
const clientWs = new WebSocket(GATEWAY.replace(/^http/, 'ws') + '/signal/client?token=' + encodeURIComponent(token))
await new Promise((res, rej) => { clientWs.onopen = res; clientWs.onerror = (e) => rej(new Error('client ws: ' + (e.message || e.type))) })
log('client signal ws open')
let clientDc = null
let clientPc = null
const pending = []
let waiter = null
const nextFrame = () => new Promise((res) => { if (pending.length) res(pending.shift()); else waiter = res })

clientWs.onmessage = async (ev) => {
  const v = JSON.parse('' + ev.data)
  if (v.t === 'ping') return clientWs.send(JSON.stringify({ t: 'pong' }))
  if (v.t === 'ack') { log('ack sid=' + String(v.sid).slice(0, 8)); return }
  if (v.t === 'signal' && v.data.type === 'offer') {
    try {
      clientPc = new PeerConnection('client', { iceServers: [] })
      clientPc.onDataChannel((dc) => {
        clientDc = dc
        dc.onMessage((msg) => {
          const buf = Buffer.isBuffer(msg) ? msg : Buffer.from(msg)
          if (waiter) { const w = waiter; waiter = null; w(buf) } else pending.push(buf)
        })
        dc.onOpen(() => log('client dc open'))
      })
      // libdatachannel answerer 惯用法:remote offer 应用后,answer 经
      // onLocalDescription 回调交付(无需也不应调 setLocalDescription)。
      const answerReady = new Promise((res, rej) => {
        clientPc.onLocalDescription((sdp, type) => { if (type === 'answer') res(sdp) })
        setTimeout(() => rej(new Error('answer generation timeout')), 8000)
      })
      clientPc.setRemoteDescription(v.data.sdp, 'offer')
      const sdp = await answerReady
      clientWs.send(JSON.stringify({ t: 'signal', sid: v.sid, data: { type: 'answer', sdp } }))
    } catch (e) { log('client offer handling failed: ' + e.message) }
  }
}
clientWs.send(JSON.stringify({ t: 'connect' }))

// ── 等 DataChannel 就绪,跑载荷往返 ──────────────────────────────────────
const dcReady = new Promise((res) => {
  const t = setInterval(() => { if (clientDc && clientDc.isOpen && clientDc.isOpen()) { clearInterval(t); res() } }, 100)
})
await Promise.race([dcReady, new Promise((_, rej) => setTimeout(() => rej(new Error('dc timeout')), 20000))])

const VSID = 1
clientDc.sendMessageBinary(frame(VSID, VS_OPEN, Buffer.alloc(0)))
await new Promise((r) => setTimeout(r, 300))
const messages = ['hello p2p over cf-worker', '第二段:多字节 utf-8 🚀', 'x'.repeat(50_000)]
for (const [i, m] of messages.entries()) {
  const payload = Buffer.from(m, 'utf8')
  for (let off = 0; off < payload.length; off += 16 * 1024) {
    clientDc.sendMessageBinary(frame(VSID, VS_DATA, payload.subarray(off, off + 16 * 1024)))
  }
  // 收回显(大消息跨多个 DATA 帧,按长度重组)。
  let acc = Buffer.alloc(0)
  const want = payload.length
  while (acc.length < want) {
    const buf = await Promise.race([nextFrame(), new Promise((_, rej) => setTimeout(() => rej(new Error('recv timeout msg#' + i)), 15000))])
    if (buf.length < 10 || buf[0] !== VS_MAGIC) continue
    const cmd = buf.readUInt8(5), len = buf.readUInt32BE(6)
    if (cmd === VS_DATA) acc = Buffer.concat([acc, buf.subarray(10, 10 + len)])
  }
  if (Buffer.compare(acc.subarray(0, want), payload) !== 0) {
    throw new Error('mismatch at msg#' + i + ': gotLen=' + acc.length + ' wantLen=' + want.length)
  }
  log('round-trip ok msg#' + i, '(' + payload.length + ' bytes)')
}
clientDc.sendMessageBinary(frame(VSID, VS_CLOSE, Buffer.alloc(0)))
log('ALL PASS ✅  CF pair + 信令 + WebRTC + vstream 全链路通(业务流量未过 Worker)')
process.exit(0)
