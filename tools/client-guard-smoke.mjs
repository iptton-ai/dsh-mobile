// 客户端入口冒烟:跑 lib/client.js 的真实 factory + apply(),核对侧栏 foot
// 「移动接入」入口的可见性矩阵 —— 哪些源该挂、哪些源不该挂。零网络、零 DOM、
// 零依赖,用于每次改守卫/升级 dsh 后的第一道客户端门(node --check 只查语法,
// 本脚本查行为)。
//
// client.js 是「已构建 bundle」形态:window.__ModuleLoader__.load({id, factory})
// 包裹,工厂内只 require 静态注册表模块(react)。这里用最小桩取出 factory,
// 再以不同 location 调 apply() —— apply() 只做 effect → slots.inject →
// slots.register 三件事,不需要真实渲染。
//
// 用法:node tools/client-guard-smoke.mjs   (exit 0 = 全部通过)
const fs = await import('node:fs/promises')

const source = await fs.readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

let registration = null
const windowStub = { __ModuleLoader__: { load: (reg) => { registration = reg } } }
// 顶层只执行 window.__ModuleLoader__.load(...);factory 不在此刻运行。
new Function('window', source)(windowStub)

if (registration === null || typeof registration.factory !== 'function') {
  console.error('FAIL: bundle 未通过 window.__ModuleLoader__.load 注册 factory')
  process.exit(1)
}

// factory 里 react 只在组件内部用(R.useState / R.createElement),本脚本不渲染,
// 给个「任意属性都是函数」的桩即可,不引入运行时依赖。
const reactStub = new Proxy({}, { get: () => () => {} })
const mod = registration.factory((name) => {
  if (name === 'react') return reactStub
  throw new Error('unexpected require: ' + name)
})

const checks = []
const assert = (name, cond, extra = '') => {
  checks.push({ name, ok: !!cond })
  if (!cond) { console.error('FAIL:', name, extra); process.exitCode = 1 }
  else console.log('ok  :', name, extra)
}

/** 以给定 location 跑一次 apply(),回收入口注册情况。 */
function runApply(location) {
  const registered = []
  const injected = []
  const ctx = {
    effect: (fn) => { fn(); return () => {} },
    slots: {
      inject: (name, fn) => { injected.push(name); fn() },
      register: (spec) => { registered.push(spec) },
    },
  }
  Object.defineProperty(globalThis, 'location', { value: location, configurable: true, writable: true })
  mod.apply(ctx)
  return { registered, injected }
}

// [标签, location, 是否应挂入口]
const matrix = [
  ['desktop 外壳 dsh-app://app', { protocol: 'dsh-app:', hostname: 'app' }, true],
  ['回环 IPv4 http://127.0.0.1:3080', { protocol: 'http:', hostname: '127.0.0.1' }, true],
  ['localhost', { protocol: 'http:', hostname: 'localhost' }, true],
  ['IPv6 回环 [::1]', { protocol: 'http:', hostname: '[::1]' }, true],
  ['IPv6 回环 ::1', { protocol: 'http:', hostname: '::1' }, true],
  ['局域网 http://192.168.1.5:3080', { protocol: 'http:', hostname: '192.168.1.5' }, false],
  ['公网 https://dsh.example.com', { protocol: 'https:', hostname: 'dsh.example.com' }, false],
  ['同名主机但非外壳协议 https://app', { protocol: 'https:', hostname: 'app' }, false],
  ['desktop 其它页面 dsh-app://shell', { protocol: 'dsh-app:', hostname: 'shell' }, false],
]

for (const [label, location, expected] of matrix) {
  const { registered, injected } = runApply(location)
  const visible = registered.length === 1 && registered[0].name === 'sidebar.footer.action'
  assert(`${expected ? '挂  ' : '不挂'} ${label}`, visible === expected,
    visible ? JSON.stringify(registered[0]) : `registered=${registered.length}`)
  if (expected) assert(`      槽位为 sidebar.footer.action(${label})`, injected[0] === 'sidebar.footer.action')
}

// 宿主按 dsh.client.inject 决定加载顺序,槽位服务必须在位。
assert('exports.inject 声明 slots', Array.isArray(mod.inject) && mod.inject.includes('slots'))

const failed = checks.filter((c) => !c.ok).length
console.log(`\n${checks.length - failed}/${checks.length} 通过`)
