// 插件代码 × 网关中转面全链路:插件 harness 跑真实 apply()(中转控制腿
// 连网关),模拟手机 pair → /relay/client 数据腿 → 插件收到 relay-open 自动
// 拨数据腿 → ready → vstream 帧经网关双跳落地 echo(假 dsh web)→ 往返校验。
// 验证 lib/index.js 中转路径的每一环(票据/控制腿/数据腿/共享 vstream 泵)。
//
// 用法(先起本地 dev 网关 `npm run dev`,或指 GATEWAY 打生产):
//   GATEWAY=http://127.0.0.1:8787 ADMIN_KEY=... node tools/relay-e2e-smoke.mjs
import net from 'node:net'
import { randomUUID } from 'node:crypto'

const GATEWAY = (process.env.GATEWAY ?? 'http://127.0.0.1:8787').replace(/\/+$/, '')
const ADMIN_KEY = process.env.ADMIN_KEY ?? ''
const HOSTKEY = 'plugrelay-' + randomUUID().slice(0, 6) + '.p2p'
if (!ADMIN_KEY) {
  console.error('需 ADMIN_KEY(网关管理密钥)')
  process.exit(1)
}
const log = (...a) => console.log('[relay-e2e]', ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── echo(假 dsh web,插件 vstream 的落地口)──
const echo = net.createServer((s) => {
  s.on('data', (d) => s.write(d))
  s.on('error', () => {}) // 插件侧断流时 RST 会打到 echo socket,吞掉防崩 harness
})
await new Promise((r) => echo.listen(0, '127.0.0.1', r))
const echoPort = echo.address().port

// ── 插件 harness:真实 apply()(与 contract-smoke 同款 mock ctx)──
const disposers = []
let route = null
const scope = {
  _v: { label: 'plug-relay' }, _w: [],
  get() { return this._v },
  watch(fn) { this._w.push(fn); return () => {} },
  async update(n) { this._v = { ...this._v, ...n }; for (const w of this._w) w(this._v) },
}
const fakeWs = {
  port: echoPort,
  register(r) { route = r; return () => { route = null } },
}
const ctx = {
  logger: { info() {}, warning() {}, error() {} },
  get: (n) => (n === 'webServer' ? fakeWs : undefined),
  inject: (deps, fn) => fn({
    effect: (f) => { const d = f(); if (typeof d === 'function') disposers.push(d) },
    settings: { register: () => scope },
  }),
  effect: (f) => disposers.push(f),
}
const mod = await import(new URL('../lib/index.js', import.meta.url).href)
mod.apply(ctx, { gateway: GATEWAY, adminKey: ADMIN_KEY, host: HOSTKEY })
if (route === null) throw new Error('route not registered')

const call = async (method, url, headers = {}) => {
  const res = { status: 0, text: '', writeHead(s) { this.status = s }, end(b) { this.text = String(b ?? '') } }
  const req = { method, url, headers, on: (ev, fn) => { if (ev === 'end') fn() } }
  await route.handler(req, res)
  let json = null; try { json = JSON.parse(res.text) } catch {}
  return { status: res.status, json }
}

// ① 控制腿自愈(真实 WS + 真实票据管理面)
let ctrlOk = false
for (let i = 0; i < 15; i++) {
  await sleep(2000)
  const s = await call('GET', '/pair/api/state', { host: '127.0.0.1:3080' })
  if (s.json?.relay?.connected === true) { log('ctrl leg connected after', (i + 1) * 2, 's'); ctrlOk = true; break }
}
if (!ctrlOk) throw new Error('plugin relay ctrl WS did not connect')
const st = await call('GET', '/pair/api/state', { host: '127.0.0.1:3080' })
log('state:', JSON.stringify(st.json.relay))

// ② 模拟手机:配对拿令牌(绑定 HOSTKEY)
const j = async (path, method, payload) => {
  const r = await fetch(GATEWAY + path, {
    method, headers: { ...(payload ? { 'content-type': 'application/json' } : {}) },
    body: payload ? JSON.stringify(payload) : undefined,
  })
  const t = await r.text()
  if (!r.ok) throw new Error(method + ' ' + path + ' → ' + r.status + ' ' + t)
  return JSON.parse(t)
}
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const code = Array.from({ length: 10 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('')
const secret = randomUUID().replace(/-/g, '')
const { pairing_id } = await j('/pair/start', 'POST', { code, secret, device: 'relay-smoke-phone' })
const claimResp = await fetch(GATEWAY + '/admin/pair/claim', {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + ADMIN_KEY },
  body: JSON.stringify({ code, host_code: 'ABC234', host_label: 'plug-relay', tunnel_host: HOSTKEY }),
})
if (!claimResp.ok) throw new Error('claim failed: ' + await claimResp.text())
const claim = await claimResp.json()
const confirm = await j('/pair/confirm', 'POST', { pairing_id, secret, claim_id: claim.claim_id, host_code: 'ABC234' })
log('phone token ok (bound to', HOSTKEY + ')')

// ③ 手机数据腿:rsid 自生成 → 等插件自动拨数据腿 → 双 ready
const wsUrl = GATEWAY.replace(/^http/, 'ws')
const rsid = randomUUID()
const phone = new WebSocket(`${wsUrl}/relay/client?token=${encodeURIComponent(confirm.token)}&rsid=${rsid}`)
await new Promise((res, rej) => { phone.onopen = res; phone.onerror = (e) => rej(new Error('phone ws: ' + e.message)) })
phone.binaryType = 'arraybuffer'
let readyResolve
const readyP = new Promise((r) => (readyResolve = r))
let phoneBuf = Buffer.alloc(0)
const respChunks = []
let respDone, respDoneP = new Promise((r) => (respDone = r))
phone.onmessage = (m) => {
  if (typeof m.data === 'string') {
    const jj = JSON.parse(m.data)
    if (jj.t === 'ping') { try { phone.send('{"t":"pong"}') } catch {} }
    if (jj.t === 'ready') readyResolve()
    return
  }
  phoneBuf = Buffer.concat([phoneBuf, Buffer.from(m.data)])
  // echo 场景:整段回来
  respChunks.push(Buffer.from(m.data))
  phoneBuf = Buffer.alloc(0)
}
await Promise.race([readyP, sleep(15000).then(() => { throw new Error('phone ready timeout') })])
log('phone leg ready')

// ④ vstream 往返:OPEN + DATA(echo 协议)→ 等 CLOSE 语义
const VS_MAGIC = 0xd5, VS_OPEN = 1, VS_DATA = 2, VS_CLOSE = 3
const frame = (sid, cmd, payload = Buffer.alloc(0)) => {
  const h = Buffer.alloc(10)
  h.writeUInt8(VS_MAGIC, 0); h.writeUInt32BE(sid, 1); h.writeUInt8(cmd, 5); h.writeUInt32BE(payload.length, 6)
  return Buffer.concat([h, payload])
}
// 真实时序:OPEN + DATA,等 echo 回包后再 CLOSE(手机侧 CLOSE = 本地
// socket 收完响应的 onDone,与 App VstreamProxy 同款;发早了会把插件侧
// 排队中的 TCP 写入 destroy 掉 —— 那不是中转链路的真实形态)。
const msg = Buffer.from('relay-e2e-payload-' + randomUUID())
phone.send(frame(1, VS_OPEN))
phone.send(frame(1, VS_DATA, msg))

// 收帧:等 DATA 回来(拆 vstream 头比对 payload)
const deadline = Date.now() + 10000
let got = Buffer.alloc(0)
while (Date.now() < deadline) {
  await sleep(200)
  got = Buffer.concat(respChunks)
  if (got.length >= 10 + msg.length) break
}
if (got.length < 10 || got[0] !== VS_MAGIC) throw new Error('no vstream DATA frame back: ' + got.length + ' bytes')
const len = got.readUInt32BE(6)
const payloadBack = got.subarray(10, 10 + len)
if (!payloadBack.equals(msg)) {
  throw new Error('payload mismatch: ' + payloadBack.toString() + ' vs ' + msg.toString())
}
phone.send(frame(1, VS_CLOSE))
log('vstream round-trip OK via plugin relay (echo)')

// ⑤ 状态面:relay.pairs 应显示 ready 配对
let pairShown = false
for (let i = 0; i < 5; i++) {
  const s = await call('GET', '/pair/api/state', { host: '127.0.0.1:3080' })
  if (s.json?.relay?.pairs?.some((x) => x.ready && x.device === 'relay-smoke-phone')) { pairShown = true; break }
  await sleep(1000)
}
if (!pairShown) throw new Error('relay pair not visible in /api/state')
log('/api/state shows ready relay pair')

// ⑥ 清理
const jti = JSON.parse(Buffer.from(confirm.token.split('.')[1], 'base64').toString()).jti
await fetch(GATEWAY + '/auth/revoke', {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + confirm.token },
  body: JSON.stringify({ jti }),
})
phone.close()
for (const d of disposers) { try { d() } catch {} }
echo.close()
log('PASS ✅  plugin relay e2e (apply() → ctrl leg → phone pair → data leg → vstream round-trip → revoke)')
process.exit(0)
