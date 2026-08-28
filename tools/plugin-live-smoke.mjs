// 插件代码 × 线上 CF Worker 全链路:插件在 harness 里跑真实 createSignalService
// (host WS 连线上 Worker),再模拟手机客户端 connect → 插件 offerer → vstream
// 落地到 echo(假 dsh web)→ 往返校验。验证的是 lib/index.js 的真实路径。
import { PeerConnection } from 'node-datachannel'
import net from 'node:net'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'

const ADMIN_KEY = fs.readFileSync('/tmp/.dshgw_admin_key', 'utf8').trim()
const GATEWAY = 'https://dsh.pan2017.cn'
const HOSTKEY = 'plugtest-' + randomUUID().slice(0, 6) + '.p2p'

// ── echo(假 dsh web,插件 vstream 的落地口)──
const echo = net.createServer((s) => s.on('data', (d) => s.write(d)))
await new Promise((r) => echo.listen(0, '127.0.0.1', r))
const echoPort = echo.address().port

// ── 插件 harness:真实 apply() ──
const disposers = []
let route = null
const scope = {
  _v: { label: 'plug-live' }, _w: [],
  get() { return this._v },
  watch(fn) { this._w.push(fn); return () => {} },
  async update(n) { this._v = { ...this._v, ...n }; for (const w of this._w) w(this._v) },
}
const fakeWs = {
  port: echoPort, // ← 插件 vstream 落地到 echo
  register(r) { route = r; return () => { route = null } },
}
const ctx = {
  get: (n) => (n === 'webServer' ? fakeWs : undefined),
  inject: (deps, fn) => fn({
    effect: (f) => { const d = f(); if (typeof d === 'function') disposers.push(d) },
    settings: { register: () => scope },
  }),
  effect: (f) => disposers.push(f),
}
const mod = await import('/Users/zxnap/code/MyWorks/yltech.apps/dsh-mobile/lib/index.js')
mod.apply(ctx, { gateway: GATEWAY, adminKey: ADMIN_KEY, host: HOSTKEY })
if (route === null) throw new Error('route not registered')

const call = async (method, url, headers = {}, body = null) => {
  const res = { status: 0, text: '', writeHead(s) { this.status = s }, end(b) { this.text = String(b ?? '') } }
  const req = { method, url, headers, on: (ev, fn) => { if (ev === 'data' && body) fn(Buffer.from(JSON.stringify(body))); if (ev === 'end') fn() } }
  await route.handler(req, res)
  let json = null; try { json = JSON.parse(res.text) } catch {}
  return { status: res.status, json }
}

// ① 信令通道自愈(真实 WS 连线上 Worker,ticket 经真实管理面)
let ok = false
for (let i = 0; i < 12; i++) {
  await new Promise((r) => setTimeout(r, 5000))
  const s = await call('GET', '/pair/api/state', { host: '127.0.0.1:3080' })
  if (s.json?.signal?.connected === true) { console.log('plugin signal connected after', (i + 1) * 5, 's, ticketValid=', s.json.signal.ticketValid); ok = true; break }
}
if (!ok) throw new Error('plugin signal WS did not connect')
const host1 = await call('GET', '/pair/api/host', { host: '127.0.0.1:3080' })
console.log('/api/host:', JSON.stringify(host1.json))

// ② 模拟手机:配对拿令牌(绑定 HOSTKEY)→ 信令 client → connect
const j = async (path, method, payload) => {
  const r = await fetch(GATEWAY + path, {
    method, headers: { authorization: 'Bearer ' + ADMIN_KEY, ...(payload ? { 'content-type': 'application/json' } : {}) },
    body: payload ? JSON.stringify(payload) : undefined,
  })
  const t = await r.text()
  if (!r.ok) throw new Error(method + ' ' + path + ' → ' + r.status + ' ' + t)
  return JSON.parse(t)
}
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const code = Array.from({ length: 10 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('')
const secret = randomUUID().replace(/-/g, '')
const { pairing_id } = await j('/pair/start', 'POST', { code, secret, device: 'plugin-smoke-phone' })
const claim = await j('/admin/pair/claim', 'POST', { code, host_code: 'ABC234', host_label: 'plug-live', tunnel_host: HOSTKEY })
const { token } = await j('/pair/confirm', 'POST', { pairing_id, secret, claim_id: claim.claim_id, host_code: 'ABC234' })
console.log('phone token ok (bound to', HOSTKEY + ')')

// 设备表应包含新令牌(插件 tokens 过滤按 host key)
const toks = await call('GET', '/pair/api/tokens', { host: '127.0.0.1:3080' })
const mine = (toks.json ?? []).filter((t) => t.tunnel_host === HOSTKEY)
console.log('tokens visible to plugin host:', mine.length)

// ── 手机半边:answerer(与 App 同协议)──
const fixAnswerSdp = (s) => String(s).replace(/a=setup:actpass/g, 'a=setup:passive')
const cws = new WebSocket(GATEWAY.replace(/^http/, 'ws') + '/signal/client?token=' + encodeURIComponent(token))
await new Promise((res, rej) => { cws.onopen = res; cws.onerror = (e) => rej(new Error('client ws: ' + e.type)) })
let cDc = null
const pending = []; let waiter = null
cws.onmessage = async (ev) => {
  const v = JSON.parse('' + ev.data)
  if (v.t === 'ping') return cws.send('{"t":"pong"}')
  if (v.t === 'signal' && v.data?.type === 'offer') {
    const pc = new PeerConnection('phone', { iceServers: [] })
    pc.onDataChannel((dc) => {
      cDc = dc
      dc.onMessage((m) => { const b = Buffer.isBuffer(m) ? m : Buffer.from(m); if (waiter) { const w = waiter; waiter = null; w(b) } else pending.push(b) })
    })
    const ready = new Promise((res2, rej2) => {
      pc.onLocalDescription((sdp, type) => { if (type === 'answer') res2(sdp) })
      setTimeout(() => rej2(new Error('answer timeout')), 8000)
    })
    pc.setRemoteDescription(v.data.sdp, 'offer')
    const sdp = await ready
    cws.send(JSON.stringify({ t: 'signal', sid: v.sid, data: { type: 'answer', sdp } }))
  }
}
cws.send('{"t":"connect"}')

const dcReady = new Promise((res, rej) => {
  const t = setInterval(() => { if (cDc && cDc.isOpen && cDc.isOpen()) { clearInterval(t); res() } }, 100)
  setTimeout(() => rej(new Error('dc timeout')), 20000)
})
await dcReady
console.log('phone dc open(经插件 offerer,线上信令)')

// ── vstream 往返(插件 attachStream → echo)──
const VS_MAGIC = 0xd5
const frame = (sid, cmd, payload) => {
  const h = Buffer.alloc(10)
  h.writeUInt8(VS_MAGIC, 0); h.writeUInt32BE(sid, 1); h.writeUInt8(cmd, 5); h.writeUInt32BE(payload.length, 6)
  return Buffer.concat([h, payload])
}
const nextFrame = () => new Promise((res) => { if (pending.length) res(pending.shift()); else waiter = res })
cDc.sendMessageBinary(frame(1, 1, Buffer.alloc(0))) // OPEN
await new Promise((r) => setTimeout(r, 300))
const msg = Buffer.from('插件路径全链路 round-trip 🚀 + ' + 'y'.repeat(40000), 'utf8')
for (let off = 0; off < msg.length; off += 16384) cDc.sendMessageBinary(frame(1, 2, msg.subarray(off, off + 16384)))
let acc = Buffer.alloc(0)
while (acc.length < msg.length) {
  const b = await Promise.race([nextFrame(), new Promise((_, rej) => setTimeout(() => rej(new Error('recv timeout')), 15000))])
  if (b.length < 10 || b[0] !== VS_MAGIC) continue
  const cmd = b.readUInt8(5), len = b.readUInt32BE(6)
  if (cmd === 2) acc = Buffer.concat([acc, b.subarray(10, 10 + len)])
}
if (Buffer.compare(acc.subarray(0, msg.length), msg) !== 0) throw new Error('payload mismatch')
console.log('round-trip ok(' + msg.length + ' bytes,经插件 vstream → echo)')

// 状态复核:插件应有 1 个活跃会话/在线设备
const st = await call('GET', '/pair/api/state', { host: '127.0.0.1:3080' })
console.log('plugin sessions:', st.json.signal.sessions.length, 'devices:', st.json.signal.devices.length)

for (const d of disposers) { try { d() } catch {} }
console.log('PLUGIN LIVE SMOKE OK ✅(插件代码 × 线上 CF Worker × P2P 全链路)')
process.exit(0)
