// 真实宿主冒烟:用「已安装 dsh」的全局包(@deepseek-ai/cordis +
// dsh-host-webserver + dsh-settings-file)起真实 cordis Context 与真实 HTTP
// 服务,跑 lib/index.js 的真实 apply(),再经 node:http 逐项请求断言。
// 与 contract-smoke(mock 宿主)互补:那边查「我们对宿主形状的假设」,
// 这边查「已安装 dsh 的真实形状」——真实 prefix 路由、真实 .port getter、
// 真实 settings scope(get/watch/update)与磁盘落盘。connection 服务因拖
// credentials 持久化不起真身,按 rc.1 dsh-client-connection 的
// authenticatedUrl 形状给桩(该形状已逐版核对)。零 ~/.dsh 触碰、零外网。
//
// 用法:node tools/host-live-smoke.mjs   (exit 0 = 全部通过)
//   已装 dsh 定位:DSH_GLOBAL_ROOT 环境变量,缺省 `npm root -g` 下的
//   @deepseek-ai/dsh/node_modules。
import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const require_ = createRequire(import.meta.url)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 定位已安装 dsh 的随包依赖(GUI 运行的就是这一份)─────────────────────
const globalRoot = process.env.DSH_GLOBAL_ROOT ?? (() => {
  try {
    return path.join(execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(),
      '@deepseek-ai', 'dsh', 'node_modules')
  } catch {
    return null
  }
})()
if (!globalRoot || !fs.existsSync(globalRoot)) {
  console.error('无法定位已安装 dsh 的 node_modules(设 DSH_GLOBAL_ROOT 后重试)')
  process.exit(1)
}
const installed = (name) => pathToFileURL(path.join(globalRoot, ...name.split('/'), 'lib', 'index.js')).href

const checks = []
const assert = (name, cond, extra = '') => {
  checks.push({ name, ok: !!cond })
  if (!cond) { console.error('FAIL:', name, extra); process.exitCode = 1 }
  else console.log('ok  :', name, extra)
}

// ── 起真实宿主:cordis Context + WebServer + FileSettingsProvider ─────────
const { Context } = await import(installed('@deepseek-ai/cordis'))
const { WebServer } = await import(installed('@deepseek-ai/dsh-host-webserver'))
const { FileSettingsProvider } = await import(installed('@deepseek-ai/dsh-settings-file'))
const mod = await import(new URL('../lib/index.js', import.meta.url))

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshm-live-'))
const settingsPath = path.join(workDir, 'settings.yaml')

const ctx = new Context()
await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }) // port 0 = OS 分配,考 .port getter
await ctx.plugin(FileSettingsProvider, {
  path: settingsPath, dshHome: workDir, watch: false, // 临时文件,绝不触 ~/.dsh
})
// connection 桩(真实服务会初始化 credentials 持久化;形状按
// dsh-client-connection authenticatedUrl:根路径 + 注入 launch token 查询参数)
ctx.provide('connection', {
  authenticatedUrl: (base) => {
    const u = new URL(base)
    u.search = ''
    u.hash = ''
    u.searchParams.set('token', 'live-token')
    return u.href
  },
})

mod.apply(ctx, { gateway: '', label: 'live-host' }) // gateway 留空:走「未配置」降级路径,零外网
await sleep(150) // 等 ctx.inject(['settings']) 与路由注册落地

const ws = ctx.get('webServer')
const port = ws?.port
assert('webServer 服务在跑且 .port 为 OS 分配端口', Number.isInteger(port) && port > 0, 'port=' + String(port))

// ── 真实 HTTP 请求助手(全走 node:http,头部完全可控)────────────────────
const call = (method, urlPath, headers = {}, body = null) =>
  new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: urlPath, headers: {
        ...(body !== null ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
        ...headers,
      } },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          let json = null
          try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {}
          resolve({ status: res.statusCode, json })
        })
      })
    req.on('error', () => resolve(null))
    req.end(body)
  })
const loopback = { host: '127.0.0.1:' + port }
const write = { 'x-dsh-mobile': '1' }

// ── 断言面(与 contract-smoke 同清单,但过的是真实 rc.1 宿主)────────────
const host = await call('GET', '/pair/api/host', loopback)
assert('真实路由 /pair/api/host 200', host?.status === 200, JSON.stringify(host?.json))
assert('host 自述 relay 模式 + label + 宿主键', host?.json?.mode === 'relay' && host?.json?.label === 'live-host'
  && String(host?.json?.host ?? '').endsWith('.p2p'))

const auth = await call('GET', '/pair/api/auth-url', loopback)
assert('auth-url 经真实 ctx.get(connection) 取桩 URL', auth?.status === 200
  && String(auth?.json?.url ?? '').endsWith('token=live-token'), JSON.stringify(auth?.json))

const label0 = await call('GET', '/pair/api/label', loopback)
assert('label GET(settings scope 已注入)', label0?.status === 200 && label0?.json?.editable === true)

const labelSet = await call('POST', '/pair/api/label', { ...loopback, ...write }, JSON.stringify({ label: 'renamed-live' }))
assert('label POST 200', labelSet?.status === 200, JSON.stringify(labelSet?.json))
await sleep(250) // 等 settings 落盘
let onDisk = ''
try { onDisk = fs.readFileSync(settingsPath, 'utf8') } catch {}
assert('真实 settings 磁盘落盘含 dsh-mobile 命名空间', onDisk.includes('dsh-mobile') && onDisk.includes('renamed-live'),
  'file=' + settingsPath)
const label1 = await call('GET', '/pair/api/label', loopback)
assert('watch 回调已把内存 label 更新', label1?.json?.label === 'renamed-live', JSON.stringify(label1?.json))

const state = await call('GET', '/pair/api/state', loopback)
assert('state 200:中转/信令两服务状态在', state?.status === 200 && state?.json?.relay && state?.json?.signal
  && state?.json?.relay?.connected === false)

const sec = await call('GET', '/pair/api/security-log', loopback)
assert('security-log 200 + 空事件表', sec?.status === 200 && Array.isArray(sec?.json?.events))
const ack = await call('POST', '/pair/api/security-log/ack', { ...loopback, ...write }, '{}')
assert('security-log/ack 200', ack?.status === 200)

// ── 管理面三重门(真实 HTTP 头路径)───────────────────────────────────────
const cross = await call('GET', '/pair/api/host', { ...loopback, origin: 'https://evil.example.com' })
assert('跨源 Origin 403', cross?.status === 403)
const noHeader = await call('POST', '/pair/api/stop', loopback, '{}')
assert('写操作缺 x-dsh-mobile 头 403', noHeader?.status === 403)
const nonLoop = await new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/pair/api/host',
    headers: { host: '10.0.0.9:' + port } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)) })
  req.on('error', () => resolve(null))
  req.end()
})
assert('非 loopback Host 403', nonLoop === 403)

// ── dispose:路由撤销 + 服务下线(端口关闭)────────────────────────────────
await ctx.fiber.dispose()
const after = await call('GET', '/pair/api/host', loopback)
assert('dispose 后 HTTP 服务已下线(连接拒绝)', after === null)

try { fs.rmSync(workDir, { recursive: true, force: true }) } catch {}

console.log('\n' + (process.exitCode
  ? 'HOST LIVE SMOKE FAILED'
  : 'HOST LIVE SMOKE OK ✅ ' + checks.length + ' checks(真实宿主:' + globalRoot + ')'))
