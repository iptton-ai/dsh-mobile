// 契约冒烟:mock 宿主 ctx 跑 lib/index.js 的真实 apply(),核对当前 dsh 的
// 服务形状 —— webServer.register(route) / connection.authenticatedUrl /
// ctx.inject / ctx.effect —— 以及管理面的 loopback + 同源三重门。零网络、
// 零副作用,用于每次 dsh 版本升级后的第一道兼容门(node --check 只查语法,
// 本脚本查契约)。套件跑两轮,覆盖两代宿主:
//  A. 旧宿主(≤0.1.6):settings 服务带 register(ns, schema, {base}) scope API;
//  B. 新宿主(≥0.1.7-alpha.2):register 已移除,写面 settings.update(entryId,
//     patch),读面 config volatile 引用 + 'loader/volatile-update' 事件。
//
// 用法:node tools/contract-smoke.mjs   (exit 0 = 全部通过)
const mod = await import(new URL('../lib/index.js', import.meta.url))

const checks = []
const assert = (name, cond, extra = '') => {
  checks.push({ name, ok: !!cond })
  if (!cond) { console.error('FAIL:', name, extra); process.exitCode = 1 }
  else console.log('ok  :', name, extra)
}

async function runScenario(tag, buildHost) {
  const disposers = []
  let route = null
  const host = buildHost({
    disposers,
    setRoute: (r) => { route = r },
    registerRoute: (r) => { route = r; return () => { route = null } },
  })

  mod.apply(host.ctx, host.config)

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

  assert(`[${tag}] webServer.register 注册了 prefix 路由`, route !== null && route.kind === 'prefix' && route.path === '/pair')

  const h = await call('GET', '/pair/api/host')
  assert(`[${tag}] /api/host 200 + relay 模式`, h.status === 200 && h.json.mode === 'relay', JSON.stringify(h.json))
  assert(`[${tag}] /api/host 回机器名与宿主键`, h.json.label === 'smoke-host' && typeof h.json.host === 'string')
  const auth = await call('GET', '/pair/api/auth-url')
  assert(`[${tag}] /api/auth-url 200 + 交付 launch token URL`, auth.status === 200 && auth.json.url.endsWith('token=smoke-token'), JSON.stringify(auth.json))
  const labelGet = await call('GET', '/pair/api/label')
  assert(`[${tag}] /api/label GET 可编辑`, labelGet.status === 200 && labelGet.json.editable === true && labelGet.json.label === 'smoke-host', JSON.stringify(labelGet.json))
  const labelPost = await call('POST', '/pair/api/label', { host: '127.0.0.1:45999', 'x-dsh-mobile': '1' }, { label: 'renamed' })
  assert(`[${tag}] /api/label POST 经 settings 写面落盘`, labelPost.status === 200 && labelPost.json.label === 'renamed', JSON.stringify(labelPost.json))
  assert(`[${tag}] 宿主侧 settings 值已更新`, host.readPersisted().label === 'renamed')
  const keyGet = await call('GET', '/pair/api/admin-key')
  assert(`[${tag}] /api/admin-key GET 掩码语义`, keyGet.status === 200 && keyGet.json.configured === false && keyGet.json.editable === true)
  const keyShort = await call('POST', '/pair/api/admin-key', { host: '127.0.0.1:45999', 'x-dsh-mobile': '1' }, { adminKey: 'short' })
  assert(`[${tag}] /api/admin-key POST 拒 <16 字符`, keyShort.status === 400, JSON.stringify(keyShort.json))
  const keyPost = await call('POST', '/pair/api/admin-key', { host: '127.0.0.1:45999', 'x-dsh-mobile': '1' }, { adminKey: '0123456789abcdef' })
  assert(`[${tag}] /api/admin-key POST 落盘 + 掩码`, keyPost.status === 200 && keyPost.json.configured === true
    && host.readPersisted().adminKey === '0123456789abcdef', JSON.stringify(keyPost.json))

  const state = await call('GET', '/pair/api/state')
  assert(`[${tag}] /api/state 200 + relay/信号状态`, state.status === 200 && state.json.mode === 'relay'
    && state.json.relay && state.json.relay.connected === false
    && state.json.signal && state.json.signal.connected === false)
  const sec = await call('GET', '/pair/api/security-log')
  assert(`[${tag}] /api/security-log 200 + events 数组`, sec.status === 200 && Array.isArray(sec.json.events) && sec.json.unack === 0)
  const ack = await call('POST', '/pair/api/security-log/ack', { host: '127.0.0.1:45999', 'x-dsh-mobile': '1' })
  assert(`[${tag}] /api/security-log/ack 200`, ack.status === 200 && ack.json.ok === true)

  const nonLoop = await call('GET', '/pair/api/host', { host: '10.0.0.9:45999' })
  assert(`[${tag}] 非 loopback Host 403(管理面三重门)`, nonLoop.status === 403)
  const cross = await call('GET', '/pair/api/host', { host: '127.0.0.1:45999', origin: 'https://evil.example.com' })
  assert(`[${tag}] 跨源 Origin 403`, cross.status === 403)
  const noHeader = await call('POST', '/pair/api/stop', { host: '127.0.0.1:45999' })
  assert(`[${tag}] 写操作缺 x-dsh-mobile 头 403`, noHeader.status === 403)

  for (const d of disposers) { try { d() } catch (e) { assert(`[${tag}] disposer 无异常`, false, String(e)) } }
  assert(`[${tag}] dispose 后路由撤销`, route === null)
}

// ── A. 旧宿主(≤0.1.6):register scope API ─────────────────────────────────
await runScenario('legacy', ({ disposers, registerRoute }) => {
  let registeredNs = null
  let registeredOpts = null
  const scope = {
    _v: { label: 'smoke-host' }, _w: [],
    get() { return this._v },
    watch(fn) { this._w.push(fn); return () => { this._w = this._w.filter((x) => x !== fn) } },
    async update(patch) { this._v = { ...this._v, ...patch }; for (const w of this._w) await w(this._v) },
  }
  const ctx = {
    logger: { info() {}, warning() {}, error() {} },
    get: (n) => (n === 'webServer'
      ? { port: 45999, register: registerRoute }
      : n === 'connection'
        ? { authenticatedUrl: (base) => base + '?token=smoke-token' }
        : undefined),
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
  // 注册断言放进微任务:apply 内 inject 是同步派发,结束后即可核对。
  queueMicrotask(() => {
    assert('[legacy] settings.register 用裸字符串命名空间', registeredNs === 'dsh-mobile', 'ns=' + String(registeredNs))
    assert('[legacy] settings.register 带 base 层', registeredOpts && registeredOpts.base && registeredOpts.base.label === 'smoke-host')
  })
  return { ctx, config: { gateway: '', label: 'smoke-host' }, readPersisted: () => scope.get() }
})

// ── B. 新宿主(≥0.1.7-alpha.2):update 写面 + volatile 读面 ──────────────────
await runScenario('volatile', ({ disposers, registerRoute }) => {
  // 模拟 cordis volatile 投影:config 字段为稳定引用,.get() 读当前值;
  // settings.update(entryId, patch) 改底层数据后广播 volatile-update 事件。
  const store = { label: 'smoke-host', adminKey: '' }
  const volatileRef = (key) => ({ get: () => store[key] })
  let updates = []
  const listeners = new Set()
  const settingsService = {
    async update(entryId, patch) {
      assert('[volatile] settings.update 用 entryId=dsh-mobile', entryId === 'dsh-mobile', 'entryId=' + String(entryId))
      Object.assign(store, patch)
      updates = patch
      for (const fn of listeners) fn()
    },
  }
  const fakeWs = { port: 45999, register: registerRoute }
  const ctx = {
    logger: { info() {}, warning() {}, error() {} },
    get: (n) => (n === 'webServer'
      ? fakeWs
      : n === 'connection'
        ? { authenticatedUrl: (base) => base + '?token=smoke-token' }
        : undefined),
    inject: (deps, fn) => {
      if (!deps.includes('settings')) return
      fn({
        // 新宿主腿:无 register;fiber.entry.options.id 提供 entryId。
        fiber: { entry: { options: { id: 'dsh-mobile' } } },
        on: (ev, cb) => {
          if (ev !== 'loader/volatile-update') return () => {}
          listeners.add(cb)
          return () => { listeners.delete(cb) }
        },
        effect: (f) => { const d = f(); if (typeof d === 'function') disposers.push(d) },
        settings: settingsService,
      })
    },
    effect: (f) => { const d = f(); if (typeof d === 'function') disposers.push(d) },
  }
  return {
    ctx,
    config: {
      gateway: '',
      label: volatileRef('label'),
      adminKey: volatileRef('adminKey'),
    },
    readPersisted: () => ({ label: store.label, adminKey: store.adminKey }),
  }
})

console.log('\n' + (process.exitCode ? 'CONTRACT SMOKE FAILED' : 'CONTRACT SMOKE OK ✅ ' + checks.length + ' checks'))
