// 端到端冒烟:网关信令面 + WebRTC + vstream 全链路。
// 拓扑:
//   host 脚本(模拟 Mac 插件)──ws 信令──→ 本地网关 ←─ws 信令──client 脚本(模拟手机)
//   host:DataChannel offerer,OPEN→连 TCP 回声服务器;DATA 双向泵
//   client:answerer,本地起「假 HttpClient」:OPEN+DATA 发文本,收回显校验
// 通过判据:client 发的 N 条消息经 P2P 通道到回声服务器原样返回,字节一致。
import { PeerConnection } from 'node-datachannel'
import net from 'node:net'
import { randomUUID } from 'node:crypto'

const GATEWAY = process.env.GATEWAY ?? 'http://127.0.0.1:18102'
const ADMIN = process.env.ADMIN ?? 'http://127.0.0.1:18103'
const PORT = 13100

const log = (...a) => console.log('[e2e]', ...a)
const j = async (base, path, method, payload, headers = {}) => {
  const r = await fetch(base + path, {
    method, headers: { ...(payload ? { 'content-type': 'application/json' } : {}), ...headers },
    body: payload ? JSON.stringify(payload) : undefined,
  })
  const t = await r.text()
  if (!r.ok) throw new Error(method + ' ' + path + ' → ' + r.status + ' ' + t)
  return JSON.parse(t)
}

// ── 1. 配对拿设备令牌(手机亮码 → host claim → 手机 confirm) ────────────
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const code = Array.from({ length: 10 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('')
const secret = randomUUID().replace(/-/g, '')
const { pairing_id } = await j(GATEWAY, '/pair/start', 'POST', { code, secret, device: 'e2e-fake-phone' })
log('pairing started', pairing_id)
const claim = await j(ADMIN, '/admin/pair/claim', 'POST', { code, host_code: 'ABC234', host_label: 'e2e-host', port: PORT })
log('claim offered', claim.claim_id)
const { token } = await j(GATEWAY, '/pair/confirm', 'POST', { pairing_id, secret, claim_id: claim.claim_id, host_code: 'ABC234' })
log('token ok (device e2e-fake-phone)')

// ── 2. host ticket + 信令通道 ────────────────────────────────────────────
const { ticket } = await j(ADMIN, '/admin/signal/ticket', 'POST', { port: PORT })
const caps = await j(GATEWAY, '/signal/caps', 'GET')
log('caps', JSON.stringify(caps))

// ── 3. TCP 回声服务器(扮演 dsh web) ────────────────────────────────────
// 纯字节回声:大消息跨多个 DATA 帧/TCP 块,逐块加前缀会让长度对不上。
const echo = net.createServer((sock) => {
  sock.on('data', (d) => sock.write(d))
})
await new Promise((r) => echo.listen(0, '127.0.0.1', r))
const echoPort = echo.address().port
log('echo server on', echoPort)

// ── vstream 帧(与 PROTOCOL.md 一致) ────────────────────────────────────
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
const hostWs = new WebSocket(('' + GATEWAY).replace('http', 'ws') + '/signal/host?ticket=' + encodeURIComponent(ticket))
await new Promise((res, rej) => { hostWs.onopen = res; hostWs.onerror = (e) => rej(new Error('host ws: ' + (e.message || e.type))) })
log('host signal ws open')
const hostSend = (o) => hostWs.send(JSON.stringify(o))
const hostPcs = new Map()
const hostStreams = new Map()

const offerFor = async (sid) => {
  log('offerFor enter')
  const pc = new PeerConnection('host-' + sid.slice(0, 6), { iceServers: [] })
  log('pc created')
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
  pc.onStateChange((s) => { console.log('[e2e] host pc state', s); if (s === 'failed') { console.log('host sel pair', JSON.stringify(pc.getSelectedCandidatePair())); hostPcs.delete(sid) } })
  pc.onIceStateChange((st) => console.log('[e2e] host ice', st))
  pc.setLocalDescription()
  log('setLocalDescription called')
  await waitGathered(pc, 8000).catch((e) => { log('gather err ' + e.message); throw e })
  log('gathered, sending offer len=' + pc.localDescription().sdp.length); console.log(pc.localDescription().sdp.split('\n').filter(l=>l.includes('candidate')||l.includes('setup')||l.includes('fingerprint')).join('\n'))
  hostSend({ t: 'signal', sid, data: { type: 'offer', sdp: pc.localDescription().sdp } })
  return { pc }
}

hostWs.onmessage = async (ev) => {
  const v = JSON.parse('' + ev.data)
  log('host ws msg t=' + v.t + (v.data ? ' type=' + v.data.type : ''))
  if (v.t === 'ping') return hostWs.send(JSON.stringify({ t: 'pong' }))
  if (v.t === 'offer-req') { log('offer-req recv'); await offerFor(String(v.sid)) }
  if (v.t === 'signal' && v.data.type === 'answer') {
    log('host applying answer')
    hostPcs.get(String(v.sid))?.setRemoteDescription(fixAnswerSdp(v.data.sdp), 'answer')
    log('host answer applied')
  }
}

// ── client:信令 WS + answerer + 本地消费 ────────────────────────────────
const clientWs = new WebSocket(('' + GATEWAY).replace('http', 'ws') + '/signal/client?token=' + encodeURIComponent(token))
await new Promise((res, rej) => { clientWs.onopen = res; clientWs.onerror = (e) => rej(new Error('client ws: ' + (e.message || e.type))) })
log('client signal ws open')
let clientDc = null
let clientPc = null
const pending = []
let waiter = null
const nextFrame = () => new Promise((res) => { if (pending.length) res(pending.shift()); else waiter = res })

clientWs.onmessage = async (ev) => {
  const v = JSON.parse('' + ev.data)
  log('client ws msg t=' + v.t + (v.data ? ' type=' + v.data.type + ' len=' + String(v.data.sdp || '').length : ''))
  if (v.t === 'ping') return clientWs.send(JSON.stringify({ t: 'pong' }))
  if (v.t === 'ack') { log('ack sid=' + String(v.sid).slice(0, 8)); return }
  if (v.t === 'signal' && v.data.type === 'offer') {
    try {
      clientPc = new PeerConnection('client', { iceServers: [] })
      clientPc.onStateChange((st) => log('client pc state ' + st))
      clientPc.onIceStateChange((st) => log('client ice ' + st))
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
      log('client answer ready len=' + sdp.length + ' setup=' + (sdp.match(/a=setup:\S+/) || ['?'])[0])
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
const messages = ['hello p2p', '第二段:多字节 utf-8 🚀', 'x'.repeat(50_000)]
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
  const expect = payload
  if (Buffer.compare(acc.subarray(0, expect.length), expect) !== 0) {
    throw new Error('mismatch at msg#' + i + ': gotLen=' + acc.length + ' wantLen=' + expect.length + ' got=' + JSON.stringify(acc.subarray(0, 40).toString('utf8')))
  }
  log('round-trip ok msg#' + i, '(' + payload.length + ' bytes)')
}
clientDc.sendMessageBinary(frame(VSID, VS_CLOSE, Buffer.alloc(0)))
log('ALL PASS ✅  信令 + WebRTC + vstream 全链路通(流量未过网关)')
process.exit(0)
