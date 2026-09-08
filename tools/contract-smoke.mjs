// 契约冒烟:mock 宿主 ctx 跑 lib/index.js 的真实 apply(),核对当前 dsh 的
// 服务形状 —— webServer.register(route) / settings.register(ns, schema, {base})
// 的 get/watch/update / connection.authenticatedUrl / ctx.inject / ctx.effect
// —— 以及管理面的 loopback + 同源三重门。零网络、零副作用,用于每次 dsh
// 版本升级后的第一道兼容门(node --check 只查语法,本脚本查契约)。
//
// 用法:node tools/contract-smoke.mjs   (exit 0 = 全部通过)
const mod = await import(new URL('../lib/index.js', import.meta.url))

const checks = []
const assert = (name, cond, extra = '') => {
  checks.push({ name, ok: !!cond })
  if (!cond) { console.error('FAIL:', name, extra); process.exitCode = 1 }
  else console.log('ok  :', name, extra)
}

const disposers = []
let route = null
let registeredNs = null
let registeredOpts = null
const scope = {
  _v: { label: 'smoke-host' }, _w: [],
  get() { return this._v },
  watch(fn) { this._w.push(fn); return () => { this._w = this._w.filter((x) => x !== fn) } },
  async update(patch) { this._v = { ...this._v, ...patch }; for (const w of this._w) await w(this._v) },
}

const fakeWs = {
  port: 45999,
  register(r) { route = r; return () => { route = null } },
}
const fakeConn = { authenticatedUrl: (base) => base + '?token=smoke-token' }

const ctx = {
  logger: { info() {}, warning() {}, error() {} },
  get: (n) => (n === 'webServer' ? fakeWs : n === 'connection' ? fakeConn : undefined),
  inject: (deps, fn) => {
    if (!deps.includes('settings')) return
    fn({
      effect: (f) => { const d = f(); if (typeof d === 'function') disposers.push(d) },
      settings: {
        register: (ns, schema, opts) => { registeredNs = ns; registeredOpts = opts; return scope },
      },
    })
  },
  effect: (f) => { const d = f(); if (typeof d === 'function') disposers.push(d) },
}

mod.apply(ctx, { gateway: '', label: 'smoke-host' })
assert('webServer.register 注册了 prefix 路由', route !== null && route.kind === 'prefix' && route.path === '/pair')
assert('settings.register 用裸字符串命名空间', registeredNs === 'dsh-mobile', 'ns=' + String(registeredNs))
assert('settings.register 带 base 层', registeredOpts && registeredOpts.base && registeredOpts.base.label === 'smoke-host')

const call = async (method, url, headers = { host: '127.0.0.1:45999' }, body = null) => {
  const res = { status: 0, headers: null, text: '', writeHead(s, h) { this.status = s; this.headers = h }, end(b) { this.text = String(b ?? '') } }
  const req = {
    method, url, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
    on: (ev, fn) => { if (ev === 'data' && body) fn(Buffer.from(JSON.stringify(body))); if (ev === 'end') fn() },
  }
  await route.handler(req, res)
  let json = null; try { json = JSON.parse(res.text) } catch {}
  return { status: res.status, json }
}

const host = await call('GET', '/pair/api/host')
assert('/api/host 200 + p2p 模式', host.status === 200 && host.json.mode === 'p2p', JSON.stringify(host.json))
assert('/api/host 回机器名与宿主键', host.json.label === 'smoke-host' && typeof host.json.host === 'string')

const auth = await call('GET', '/pair/api/auth-url')
assert('/api/auth-url 200 + 交付 launch token URL', auth.status === 200 && auth.json.url.endsWith('token=smoke-token'), JSON.stringify(auth.json))

const labelGet = await call('GET', '/pair/api/label')
assert('/api/label GET 可编辑', labelGet.status === 200 && labelGet.json.editable === true)
const labelPost = await call('POST', '/pair/api/label', { host: '127.0.0.1:45999', 'x-dsh-mobile': '1' }, { label: 'renamed' })
assert('/api/label POST 经 settings scope 落盘', labelPost.status === 200 && labelPost.json.label === 'renamed', JSON.stringify(labelPost.json))
assert('settings scope 值已更新', scope.get().label === 'renamed')

const keyGet = await call('GET', '/pair/api/admin-key')
assert('/api/admin-key GET 掩码语义', keyGet.status === 200 && keyGet.json.configured === false && keyGet.json.editable === true)
const keyShort = await call('POST', '/pair/api/admin-key', { host: '127.0.0.1:45999', 'x-dsh-mobile': '1' }, { adminKey: 'short' })
assert('/api/admin-key POST 拒 <16 字符', keyShort.status === 400, JSON.stringify(keyShort.json))

const state = await call('GET', '/pair/api/state')
assert('/api/state 200 + p2p 信号状态', state.status === 200 && state.json.mode === 'p2p' && state.json.signal.connected === false)

const sec = await call('GET', '/pair/api/security-log')
assert('/api/security-log 200 + events 数组', sec.status === 200 && Array.isArray(sec.json.events) && sec.json.unack === 0)
const ack = await call('POST', '/pair/api/security-log/ack', { host: '127.0.0.1:45999', 'x-dsh-mobile': '1' })
assert('/api/security-log/ack 200', ack.status === 200 && ack.json.ok === true)

const nonLoop = await call('GET', '/pair/api/host', { host: '10.0.0.9:45999' })
assert('非 loopback Host 403(管理面三重门)', nonLoop.status === 403)
const cross = await call('GET', '/pair/api/host', { host: '127.0.0.1:45999', origin: 'https://evil.example.com' })
assert('跨源 Origin 403', cross.status === 403)
const noHeader = await call('POST', '/pair/api/stop', { host: '127.0.0.1:45999' })
assert('写操作缺 x-dsh-mobile 头 403', noHeader.status === 403)

for (const d of disposers) { try { d() } catch (e) { assert('disposer 无异常', false, String(e)) } }
assert('dispose 后路由撤销', route === null)

console.log('\n' + (process.exitCode ? 'CONTRACT SMOKE FAILED' : 'CONTRACT SMOKE OK ✅ ' + checks.length + ' checks'))
