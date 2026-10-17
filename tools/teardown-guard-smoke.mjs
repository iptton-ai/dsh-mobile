// 宿主退出兜底冒烟:模拟桌面壳(DSH Desktop)的退出握手 —— 子进程加载真实
// lib/index.js(安装「断开 IPC 后兜底退出」守卫)并持有一个永不自然关闭的句柄
// (模拟网关未回 WebSocket close 握手时 undici 继续持有的隧道 socket),父进程
// 断开 IPC 后断言子进程在宽限内以 0 退出。
//
// 背景:桌面升级在收到 shutdown-complete 后调用 process.disconnect(),随后最多
// 再等 10s 宿主进程退出,超时即判 unclean teardown 并中止升级(报
// `desktop update: Host did not complete graceful task teardown ... graceful
// deadline exceeded true`)。有句柄排不空时宿主不会自然退出,故这里校验兜底
// 守卫能把它拉回 0 退出。
//
// 用法:node tools/teardown-guard-smoke.mjs   (exit 0 = 全部通过)
import { spawn } from 'node:child_process'

const pluginUrl = new URL('../lib/index.js', import.meta.url).href

const checks = []
const assert = (name, cond, extra = '') => {
  checks.push({ name, ok: !!cond })
  if (!cond) { console.error('FAIL:', name, extra); process.exitCode = 1 }
  else console.log('ok  :', name, extra)
}

// 子进程:withGuard 时加载真实插件入口(安装守卫),然后持有一个永不 close 的
// TCP server 模拟「无法自然关闭的句柄」,报告 ready 等父进程断开 IPC。
const childSource = `
import net from 'node:net'
if (process.env.SMOKE_WITH_GUARD === '1') {
  const mod = await import(process.env.SMOKE_PLUGIN_URL)
  mod.apply({ get: () => undefined }, {})
}
const server = net.createServer()
server.listen(0, '127.0.0.1', () => process.send?.({ type: 'ready' }))
`

const spawnChild = (withGuard) => spawn(process.execPath, ['--input-type=module', '-e', childSource], {
  env: { ...process.env, SMOKE_WITH_GUARD: withGuard ? '1' : '0', SMOKE_PLUGIN_URL: pluginUrl },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
})

// 场景 A(对照):不装守卫时,断开 IPC 后进程应仍被句柄保活;若它反而退出,
// 说明本用例没真正构造出「事件循环排不空」的前提,兜底断言就失去意义。
const control = spawnChild(false)
const controlResult = await new Promise((resolve) => {
  let disconnectedAt = 0
  const timer = setTimeout(() => { control.kill('SIGKILL'); resolve({ alive: true }) }, 1500)
  control.on('message', (message) => {
    if (message?.type !== 'ready' || disconnectedAt !== 0) return
    disconnectedAt = Date.now()
    control.disconnect()
  })
  control.on('exit', () => { clearTimeout(timer); resolve({ alive: false }) })
})
assert('对照组:断开 IPC 后未装守卫的进程仍被泄漏句柄保活', controlResult.alive === true)

// 场景 B:装守卫后,断开 IPC 应触发兜底,宽限内以 0 退出(桌面壳据此判定优雅退出)。
const guarded = spawnChild(true)
const guardedResult = await new Promise((resolve) => {
  let disconnectedAt = 0
  const timer = setTimeout(() => {
    guarded.kill('SIGKILL')
    resolve({ code: null, signal: 'SIGKILL', elapsed: Infinity, timedOut: true })
  }, 6000)
  guarded.on('message', (message) => {
    if (message?.type !== 'ready' || disconnectedAt !== 0) return
    disconnectedAt = Date.now()
    guarded.disconnect()
  })
  guarded.on('exit', (code, signal) => {
    clearTimeout(timer)
    resolve({
      code,
      signal,
      elapsed: disconnectedAt === 0 ? Infinity : Date.now() - disconnectedAt,
    })
  })
})
assert('装守卫:断开 IPC 后以 0 正常退出', guardedResult.code === 0 && guardedResult.signal === null,
  JSON.stringify(guardedResult))
assert('装守卫:在桌面端 10s 优雅窗口内退出', guardedResult.elapsed < 5000,
  `elapsed=${guardedResult.elapsed}ms`)

const failed = checks.filter((check) => !check.ok).length
if (failed > 0) console.error(`\n${failed} 项失败`)
else console.log(`\n全部通过(${checks.length} 项)`)
