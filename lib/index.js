// dsh-mobile — Mac 侧移动接入一键化(dsh 插件)。
// 合并原 dsh-tunnel(SSH 反向隧道)与 pair.sh(扫码配对/设备管理):
//   · 隧道:webserver 绑定后 spawn 'ssh -R',断线退避重启,dsh 退出即断
//     (--port 0 也正确:本机端口读运行时值);
//   · 配对:侧栏「移动接入」dialog —— 扫码模式点「配对手机」出二维码(网关渲染,
//     浏览器显示),App 内置相机直接扫(或系统相机扫码 → 落地页「复制」→ 粘贴)
//     → 绿卡点选即成;手输模式:手机先「生成配对码」,dialog 输入 10 位码点「应约」
//     (复刻 pair.sh 手输分支;码不存在/过期快速失败,不再傻等 5 分钟);
//   · 机器名:dsh-mobile settings 命名空间的 label 字段(默认设备 hostname,
//     dialog/dsh 设置页可改,持久化进用户 settings 文档);手机 App 经
//     GET /pair/api/host 读取,设置页显示「已连接 <机器名>」;
//   · 设备管理:已发令牌清单 + 一键吊销(网关管理面,经 ssh,公网不可达)。
// 主界面入口在浏览器半边(lib/client.js):侧栏 foot「移动接入」按钮
// (sidebar.footer.action 座,与设置按钮同区),点击弹 dialog —— 唯一管理 UI
// (独立 /pair 管理页已删),数据走 /pair/api/*。
// 信任根 = 用户 ssh key(「能 claim = 有服务器权限」),与 pair.sh 完全一致。
//
// 配置(cordis.patch.yml 的 dsh-mobile 行 config;DSH_MOBILE_* 环境变量可覆盖):
//   target / remotePort / adminPort / publicUrl / pagePath / label / gateway / cfHostname
//   双网关并存:CF(gateway+adminKey)与 Rust(ssh target)两传输同时参与
//   claim/status/tokens/revoke 双发,手机等在哪个网关哪边成交;publicUrl 仅作
//   扫码锚定(QR 编码它,手机 start 到它的 host)与展示。详见 createPairService 注释。
import { spawn } from 'node:child_process'
import { randomInt } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname, homedir } from 'node:os'

import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-mobile'
export const inject = ['webServer']

const SSH = '/usr/bin/ssh'
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // 与网关一致(去 I/L/O/0/1)

const genCode = (n) => {
  let out = ''
  for (let i = 0; i < n; i += 1) out += CODE_CHARS[randomInt(CODE_CHARS.length)]
  return out
}

const tryJson = (s) => {
  try { return JSON.parse(s) } catch { return null }
}

// ── 机器名(dsh-mobile settings 命名空间;手机端「已连接 xxx」展示) ────────
// 解析层级:schema 默认 → 组合 base(patch.yml config / 环境变量)→ 用户层
// (本页或 dsh 设置页编辑,持久化)。用户层清空即回落 base/设备名。
const LABEL_NS = 'dsh-mobile'
// schema 只做类型门(此版 schemastery 无 .trim;长度/清洗统一由 sanitizeLabel
// 在每次读取时兜底 —— 手改 settings.yaml 超长也会被截到 32 码点)。
// adminKey:CF 形态管理密钥(部署 Worker 时的 ADMIN_KEY),/pair 页填写、
// 用户层持久化 —— 不进 cordis.patch.yml(密钥不落配置文件)。
// tenantKey:Rust 网关多租户密钥(运营者经 /admin/tenants 签发),配 adminUrl
// 后 Rust 管理面走 HTTPS 直连(免 ssh),全部操作被网关围栏在本租户。
// gateways:中转服务器注册表(多宿主/多形态的核心模型)—— 每条自洽描述一台
// 网关:类型(rust/cf)、配对入口 pairUrl(二维码锚定)、管理通道凭证(按类型
// 内聚)、数据隧道参数。扫码/手输前先从列表选定服务器,claim 定向到那台;
// 扁平 config/env 键派生为初始条目(迁移),用户层编辑后整体接管。
// 隧道参数(target/remotePort/sockDir/cfTunnelId/cfHostname)改动需重启 dsh
// web;凭证/pairUrl/名称经 settings watch 即时生效。
const GatewayEntrySchema = z.object({
  id: z.string().required(false),
  type: z.union([z.const('rust'), z.const('cf')]).required(),
  name: z.string().required(false),
  pairUrl: z.string().required(false),
  // rust:管理通道双模 —— adminUrl+tenantKey(多租户 HTTPS 直连)优先,
  // 否则 target+adminPort(运营者 ssh loopback);数据隧道 target → ssh -R。
  target: z.string().required(false),
  adminPort: z.natural().required(false),
  remotePort: z.natural().required(false),
  sockDir: z.string().required(false),
  adminUrl: z.string().required(false),
  tenantKey: z.string().required(false),
  // cf:gateway+adminKey 管理面;cfTunnelId+cfHostname 数据隧道。
  gateway: z.string().required(false),
  adminKey: z.string().required(false),
  cfTunnelId: z.string().required(false),
  cfHostname: z.string().required(false),
})
const SettingsSchema = z.object({
  label: z.string().required(false),
  adminKey: z.string().required(false),
  tenantKey: z.string().required(false),
  gateways: z.array(GatewayEntrySchema).required(false),
})

/** 条目 id 清洗:小写 slug(≤32),空则由调用方生成。 */
const slugifyGatewayId = (raw) =>
  String(raw ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)

/** pairUrl 清洗:去空白、剥既有 fragment(邀请码以 #c=… 追加,已含 # 会拼坏)。 */
const sanitizePairUrl = (raw) => String(raw ?? '').trim().split('#')[0]

/** pairUrl 校验:可解析 URL 且 http(s) 协议(QR 锚定手机必须可达)。 */
const isValidPairUrl = (raw) => {
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}

/** 管理密钥清洗:仅去首尾空白(整行粘贴带前缀的容错由网关侧 accessHeaderValue 兜)。 */
const sanitizeAdminKey = (raw) => String(raw ?? '').trim()

/** 机器名清洗:去控制符、折叠空白、≤32 码点;空串回落设备短名。 */
const sanitizeLabel = (raw) => {
  const s = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return [...s].slice(0, 32).join('')
}

const shortHostname = () => hostname().split('.')[0].slice(0, 32)

/** 经 ssh 在网关服务器本机执行 curl(管理面仅 127.0.0.1 可达);失败 resolve ''。
 * ControlMaster 复用:web 端在线指示器每 15s 轮询一次 tokens,不带复用时
 * 每次轮询都要完整 TCP+鉴权握手;复用后走常驻 master(ControlPersist 10 分钟
 * 无活动自动退),单次调用只剩一次远端 exec。master 挂掉时 auto 自动重建。
 *
 * CM 降级(2026-08-17):宿主环境可能禁止在 ~/.ssh 绑定 unix socket
 * (dsh 沙箱/seatlock 下 ssh 报 unix_listener: cannot bind … Operation not
 * permitted,exit 255)—— 此时带 CM 的调用全灭,rust 管理面整列静默消失
 * (设备表只剩 CF 行、在线指示器数错边)。对策:SSH 进程非零退出且 stderr
 * 带 bind 失败特征时,去掉 CM 三参原样重试一次;成功后记住降级,后续
 * 调用不再尝试 CM。普通网络失败(超时/不可达)不重试,避免双倍等待。 */
const SSH_BASE = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8']
const SSH_CTRL = [
  '-o', 'ControlMaster=auto',
  '-o', 'ControlPath=~/.ssh/dsh-mobile-%C',
  '-o', 'ControlPersist=10m',
]
let sshCtrlDisabled = false

const sshSpawn = (target, cli, timeoutMs, withCtrl) =>
  new Promise((resolve) => {
    const args = [...SSH_BASE, ...(withCtrl ? SSH_CTRL : []), String(target), cli]
    const child = spawn(SSH, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    let done = false
    const finish = (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ out: String(out).trim(), code, err: String(err) })
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      finish(-1)
    }, timeoutMs ?? 15000)
    child.stdout.on('data', (d) => { out += String(d) })
    child.stderr.on('data', (d) => { err += String(d) })
    child.on('exit', (code) => finish(code ?? -1))
    child.on('error', () => finish(-1))
  })

const sshCurl = async (target, cli, timeoutMs) => {
  let r = await sshSpawn(target, cli, timeoutMs, !sshCtrlDisabled)
  // CM socket 绑定被拒(权限/沙箱):去 CM 重试并永久降级。
  if (r.code !== 0 && /cannot bind|Operation not permitted|Permission denied/.test(r.err)) {
    sshCtrlDisabled = true
    r = await sshSpawn(target, cli, timeoutMs, false)
  }
  return r.code === 0 ? r.out : ''
}

// ── 隧道监管(继承 dsh-tunnel 语义) ─────────────────────────────────────────

function startTunnel(emit, target, remotePort, localPort, sockDir) {
  let child = null
  let stopped = false
  let attempt = 0
  let timer = null

  // 服务器侧监听落点:sockDir 配置 = UDS(权限由目录属主把守,网关双模
  // 自动识别);否则经典 TCP 回环端口。
  const remoteListen = sockDir
    ? sockDir + '/tunnel-' + String(remotePort) + '.sock'
    : '127.0.0.1:' + String(remotePort)

  const args = () => [
    '-N', '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=15',
    '-R', remoteListen + ':127.0.0.1:' + String(localPort),
    String(target),
  ]

  // UDS 残留自愈(2026-08-16 事故根因):sshd 异常终止(对端硬杀/网络静默断)
  // 不会 unlink streamlocal socket 文件;残留文件令后续所有 bind 永远
  // EADDRINUSE,退避重试永远无法自愈,此前只能服务器手动 rm。判据与运维手册
  // (singleman server/LOCAL.md 隧道节)一致:文件存在 && 不在 /proc/net/unix
  // (= 无 listener)= 残留 → rm;有 listener(活隧道/僵尸 sshd 守口)绝不动。
  const HEAL_AFTER_FAILS = 3
  let failStreak = 0
  let healing = false
  const healStaleSocket = async () => {
    if (!sockDir || healing) return
    healing = true
    try {
      const cli = "p='" + remoteListen + "'; [ -e \"$p\" ] && { grep -qF \"$p\" /proc/net/unix || { rm -f \"$p\" && echo stale-removed; }; } || echo absent"
      const out = await sshCurl(target, cli, 12000)
      if (out === 'stale-removed') {
        attempt = 0 // 残留已清,下一轮按 1s 快速重试
        failStreak = 0
        emit('info', 'UDS 残留 socket 已清理(无 listener):' + remoteListen + ' — 下一轮重试应恢复')
      } else if (out !== 'absent') {
        // out === '':文件存在且在 /proc/net/unix(被活会话持有)或检查通道
        // 本身失败(sshCurl 出错也 resolve '')—— 两种情况都不该动文件。
        emit('warning', '落点 ' + remoteListen + ' 被活会话持有(僵尸 sshd?)或自愈检查通道失败 — 跳过,人工处置见 server/LOCAL.md 隧道节')
      }
    } finally {
      healing = false
    }
  }

  const start = () => {
    if (stopped) return
    const bornAt = Date.now()
    child = spawn(SSH, args(), { stdio: ['ignore', 'pipe', 'pipe'] })
    // spawn 失败(二进制缺失等)只发 'error' 不发 'exit',未接管会成为
    // unhandled 'error' 直接崩掉整个 dsh 进程 —— exit/error 两路都收口
    // 到同一退避;reaped 防个别平台两事件都发的双触发。
    let reaped = false
    const die = (code, signal, err) => {
      if (reaped) return
      reaped = true
      child = null
      if (stopped) return
      const delay = Math.min(1000 * 2 ** Math.min(attempt, 5), 30000)
      // 寿命 <60s = 未立稳(bind 失败约 1s 即退;spawn 失败寿命 0);连续短命退出触发残留自愈
      if (Date.now() - bornAt < 60000) {
        failStreak += 1
        if (failStreak >= HEAL_AFTER_FAILS) void healStaleSocket()
      } else {
        failStreak = 0
      }
      attempt += 1
      emit('warning', (err
        ? 'ssh spawn 失败(' + String(err.code ?? err.message) + ' — 二进制缺失/不可执行?容器镜像需含 openssh-client)'
        : 'ssh exited (code=' + String(code) + ' signal=' + String(signal) + ')')
        + '; restart in ' + String(delay) + 'ms — 检查落点 ' + remoteListen + ' 是否被占用(UDS 残留:ssh 服务器 rm ' + remoteListen + ')')
      timer = setTimeout(start, delay)
    }
    child.stderr.on('data', (d) => {
      const text = String(d).trim()
      if (text && !text.includes('Permanently added')) emit('warning', text)
    })
    child.on('exit', (code, signal) => die(code, signal))
    child.on('error', (err) => die(-1, null, err))
  }

  emit('info', 'up: ' + String(target) + ' ' + remoteListen + ' -> local :' + String(localPort))
  start()

  return {
    state: () => ({ target, remoteListen, remotePort, localPort, up: child !== null, attempts: attempt }),
    stop: () => {
      stopped = true
      if (timer !== null) clearTimeout(timer)
      if (child !== null) child.kill('SIGTERM')
    },
  }
}

// ── cloudflared 隧道监管(CF 形态:随 dsh web 启停,不依赖机器级服务) ─────────
// 与 ssh 隧道同款生命周期语义:绑定成功即拉起、断线退避重启、dsh 退出即断。
// ingress 每次启动按 dsh web 运行时端口重写(--port 0 随机端口也正确),
// httpHostHeader 改写是 dsh 信任围栏的硬要求(等价 Rust 版 DSH_GATEWAY_UPSTREAM_HOST)。
// 一次性准备(插件外只此一次):cloudflared tunnel login → create → route dns。

function startCloudflared(emit, bin, configPath, tunnelId, tunnelHost, localPort) {
  const credsFile = homedir() + '/.cloudflared/' + tunnelId + '.json'
  if (!existsSync(credsFile)) {
    emit('warning', 'cloudflared 凭证缺失:' + credsFile + '(先 cloudflared tunnel login/create)')
    return { state: () => ({ mode: 'cloudflared', target: '', remotePort: null, localPort, up: false, attempts: 0 }), stop: () => {} }
  }
  // 独立配置文件 + 防误毁:目标已存在且首行不是本插件标记 → 拒绝覆盖(别把
  // 用户自己的 cloudflared 配置整个重写掉;要换路径用 cfConfigPath)。
  if (existsSync(configPath) && !readFileSync(configPath, 'utf8').startsWith('# dsh-mobile 自动生成')) {
    emit('warning', configPath + ' 已存在且非本插件生成,拒绝覆盖 —— 用 cfConfigPath 指定独立文件,或确认后手动删除')
    return { state: () => ({ mode: 'cloudflared', target: '', remotePort: null, localPort, up: false, attempts: 0 }), stop: () => {} }
  }
  writeFileSync(configPath,
    '# dsh-mobile 自动生成(随 dsh web 启动重写;ingress 指向本机运行时端口)\n' +
    'tunnel: ' + tunnelId + '\n' +
    'credentials-file: ' + credsFile + '\n' +
    'protocol: http2\n' +
    '\n' +
    'ingress:\n' +
    '  - hostname: ' + tunnelHost + '\n' +
    '    service: http://localhost:' + String(localPort) + '\n' +
    '    originRequest:\n' +
    '      httpHostHeader: 127.0.0.1:' + String(localPort) + '\n' +
    '  - service: http_status:404\n')

  let child = null
  let stopped = false
  let attempt = 0
  let timer = null

  const start = () => {
    if (stopped) return
    child = spawn(bin, ['tunnel', '--config', configPath, 'run'], { stdio: ['ignore', 'pipe', 'pipe'] })
    // 同 startTunnel:spawn 失败只有 'error' 事件,不接管会崩掉 dsh。
    let reaped = false
    let sawRegister = false
    const die = (code, signal, err) => {
      if (reaped) return
      reaped = true
      child = null
      if (stopped) return
      const delay = Math.min(1000 * 2 ** Math.min(attempt, 5), 30000)
      attempt += 1
      emit('warning', (err
        ? 'cloudflared spawn 失败(' + String(err.code ?? err.message) + ' — ' + bin + ' 缺失/不可执行?)'
        : 'cloudflared exited (code=' + String(code) + ' signal=' + String(signal) + ')')
        + '; restart in ' + String(delay) + 'ms')
      timer = setTimeout(start, delay)
    }
    child.stderr.on('data', (d) => {
      const text = String(d).trim()
      if (!text) return
      if (text.includes('Registered tunnel connection')) sawRegister = true
      if (!sawRegister || text.includes('ERR')) emit('warning', text)
    })
    child.on('exit', (code, signal) => die(code, signal))
    child.on('error', (err) => die(-1, null, err))
  }

  emit('info', 'up: cloudflared tunnel ' + tunnelId.slice(0, 8) + '… -> local :' + String(localPort))
  start()

  return {
    state: () => ({ mode: 'cloudflared', target: tunnelHost, remotePort: null, localPort, up: child !== null, attempts: attempt }),
    stop: () => {
      stopped = true
      if (timer !== null) clearTimeout(timer)
      if (child !== null) child.kill('SIGTERM')
    },
  }
}

// ── 配对会话(复刻 pair.sh 扫码模式:铸码 → QR → claim 重试 → 状态轮询) ────

const PAIRING_WINDOW_MS = 5.5 * 60 * 1000 // 网关 pending TTL 10min;claim 重试 5.5min

// ── 配对形态判定(模块级;页面 API 也要报)─────────────────────────────
// publicUrl 是锚:其 host 决定「锚定形态」= 扫码模式下手机 start 的去处
// (QR 编码的就是 publicUrl),也用于隧道徽标等展示;claim/status 的实际
// 走向见 createPairService 的双发注释。
const hostOf = (u) => { try { return new URL(u).host.toLowerCase() } catch { return '' } }

/** 从扁平 config/env 派生初始网关条目(迁移与默认来源):rust 一条
 *  (target 或 adminUrl+tenantKey)、cf 一条(gateway)。用户层 settings 的
 *  gateways 非空时整体接管,不再看这里。 */
function deriveBaseGateways(config) {
  const env = process.env
  const pairUrl = sanitizePairUrl(env.DSH_MOBILE_PUBLIC_URL ?? config?.publicUrl ?? '')
  const gateway = (env.DSH_MOBILE_GATEWAY ?? config?.gateway ?? '').replace(/\/+$/, '')
  const target = env.DSH_MOBILE_TARGET ?? config?.target ?? ''
  const adminUrl = (env.DSH_MOBILE_ADMIN_URL ?? config?.adminUrl ?? '').replace(/\/+$/, '')
  const tenantKey = env.DSH_MOBILE_TENANT_KEY ?? config?.tenantKey ?? ''
  const entries = []
  if (gateway) {
    entries.push({
      id: 'cf-1', type: 'cf',
      name: hostOf(gateway) || 'CF 网关',
      pairUrl: pairUrl || (gateway ? 'https://' + hostOf(gateway) + '/pair' : ''),
      gateway,
      adminKey: env.DSH_MOBILE_ADMIN_KEY ?? config?.adminKey ?? '',
      cfTunnelId: env.DSH_MOBILE_CF_TUNNEL_ID ?? config?.cfTunnelId ?? '',
      cfHostname: env.DSH_MOBILE_CF_HOSTNAME ?? config?.cfHostname ?? '',
    })
  }
  if (target || (adminUrl && tenantKey)) {
    entries.push({
      id: 'rust-1', type: 'rust',
      name: hostOf(adminUrl) || hostOf(pairUrl) || String(target).split('@').pop() || 'Rust 网关',
      pairUrl,
      target,
      adminPort: Number(env.DSH_MOBILE_ADMIN_PORT ?? config?.adminPort ?? 8103),
      remotePort: Number(env.DSH_MOBILE_REMOTE_PORT ?? config?.remotePort ?? 13100),
      sockDir: env.DSH_MOBILE_SOCK_DIR ?? config?.sockDir ?? '',
      adminUrl,
      tenantKey,
    })
  }
  return entries
}

/** 条目管理通道是否就绪(决定「能否配对」;数据隧道状态另算)。 */
const gatewayAdminReady = (g) =>
  g.type === 'cf'
    ? Boolean(g.gateway && g.adminKey)
    : Boolean((g.adminUrl && g.tenantKey) || g.target)

/** 同服务器自撞校验:两条 rust 条目同 target+remotePort = 同一落点两个
 *  监听者,必撞(见多隧道并发设计 §3)。cf 条目按 gateway+cfTunnelId 同理。 */
const gatewayConflicts = (entries) => {
  const seen = new Map()
  const conflicts = []
  for (const g of entries) {
    const key = g.type === 'cf'
      ? 'cf|' + String(g.gateway) + '|' + String(g.cfTunnelId)
      : 'rust|' + String(g.target || g.adminUrl) + '|' + String(g.remotePort)
    if (seen.has(key)) conflicts.push([seen.get(key), g.id])
    else seen.set(key, g.id)
  }
  return conflicts
}

function createPairService({ getGateways, getLabel }) {
  // 服务器注册表模型(多宿主/多形态,2026-08-18):配对前先从注册表选定网关
  // 条目 —— QR 锚定该条目的 pairUrl,claim/status 定向到那一台,错误信息
  // 具名到服务器(「yltech.store 上没有这个码」≠「管理通道连不上」)。
  // 旧的双发碰运气语义仅保留在 revoke(吊销时不知令牌在哪台)与 tokens
  // (清单本就跨服务器聚合)。配对 pending 只存在于手机 start 的那个网关,
  // 所以选择器对齐(面板选哪台,手机就等在哪台)是成交前提。
  // DSH_GATEWAY_ADMIN_TOKEN 非空时网关管理面要求 bearer;服务器侧就地读取注入
  // (远端命令内展开),凭证不出服务器;env 未配置时头值 "Bearer ",网关放行。
  const AH = "-H \"authorization: Bearer $(sed -n 's/^DSH_GATEWAY_ADMIN_TOKEN=//p' /etc/dsh-gateway.env)\" "

  /** 通用 HTTP 管理面直连(CF Worker 与 Rust 多租户共用):Bearer 密钥;
   *  失败/非 JSON 统一 null。 */
  const httpFetch = async (base, key, path, method, payload) => {
    try {
      const resp = await fetch(base + path, {
        method,
        signal: AbortSignal.timeout(10000),
        headers: {
          authorization: 'Bearer ' + key,
          ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: payload !== undefined ? JSON.stringify(payload) : undefined,
      })
      return tryJson(await resp.text())
    } catch {
      return null
    }
  }

  /** 条目的管理面调用器(按条目类型/凭证现算,settings watch 后的下次调用
   *  即用新值):cf → gateway+adminKey;rust → adminUrl+tenantKey(多租户
   *  HTTPS)优先,否则 target+adminPort(运营者 ssh loopback,payload 一律
   *  base64 传输 —— JSON.stringify 不转义单引号,裸拼是注入面,2026-08-17
   *  审计修复)。无管理通道 → null。 */
  const adminOf = (g) => {
    if (g.type === 'cf') {
      if (!(g.gateway && g.adminKey)) return null
      return (path, method, payload) => httpFetch(g.gateway, g.adminKey, path, method, payload)
    }
    if (g.adminUrl && g.tenantKey) {
      return (path, method, payload) => httpFetch(g.adminUrl, g.tenantKey, path, method, payload)
    }
    if (g.target) {
      const admin = 'http://127.0.0.1:' + String(g.adminPort ?? 8103)
      return async (path, method, payload) => {
        const cli = payload !== undefined
          ? "printf %s '" + Buffer.from(JSON.stringify(payload)).toString('base64')
            + "' | base64 -d | curl -s " + AH + "--max-time 8 -X POST " + admin + path
            + " -H 'content-type: application/json' --data-binary @-"
          : "curl -s " + AH + "--max-time 8 '" + admin + path + "'"
        return tryJson(await sshCurl(g.target, cli))
      }
    }
    return null
  }

  /** 条目的人类可读名(错误/徽标具名用)。 */
  const nameOf = (g) => g.name || g.id || (g.type === 'cf' ? hostOf(g.gateway ?? '') : String(g.target ?? ''))

  const unreachableHint = (g) => {
    if (g.type === 'cf') {
      return 'CF 网关 ' + String(g.gateway ?? '') + (g.adminKey ? '' : '(缺管理密钥,在服务器卡片中填写)') + ' 不可达'
    }
    if (g.adminUrl && g.tenantKey) return 'Rust 管理面 ' + g.adminUrl + ' 不可达(检查租户密钥/网络)'
    if (g.target) return 'ssh ' + String(g.target) + ' 管理口 ' + String(g.adminPort ?? 8103) + ' 不可达'
    return nameOf(g) + ' 未配管理通道(cf: gateway+adminKey;rust: adminUrl+tenantKey 或 target)'
  }

  /** 多宿主共享网关时的本机归属判定(tokens 清单按条目过滤):Rust 按该条目
   *  隧道端口、CF 按该条目隧道主机名 —— 别家宿主配对的设备不混进本机面板。
   *  Rust 侧 port 为 null 的令牌(密码登录/默认上游,非配对签发)不展示:
   *  它不绑定任何宿主,多宿主下归属不明。CF 侧未配 cfHostname 时保守不过滤。 */
  const belongsHere = (g, t) => {
    if (g.type === 'rust') {
      if (t.upstream_port === null || t.upstream_port === undefined) return false
      return Number(t.upstream_port) === Number(g.remotePort)
    }
    if (!g.cfHostname) return true
    return t.tunnel_host === g.cfHostname
  }

  let session = null
  let generation = 0

  const clearTimer = () => {
    if (session && session.timer !== null) {
      clearTimeout(session.timer)
      session.timer = null
    }
  }

  const snapshot = () => {
    if (session === null) return null
    const g = session.gateway ?? null
    return {
      code: session.code,
      displayCode: session.code.slice(0, 5) + '-' + session.code.slice(5),
      hostCode: session.hostCode.slice(0, 3) + '-' + session.hostCode.slice(3),
      label: session.label,
      port: g !== null && g.type === 'rust' ? g.remotePort : null,
      publicUrl: g !== null ? g.pairUrl : '',
      gatewayId: g !== null ? g.id : null,
      gatewayName: g !== null ? nameOf(g) : '',
      via: g !== null ? g.type : null,
      tunnelHost: g !== null && g.type === 'cf' ? String(g.cfHostname ?? '') : '',
      qr: session.qr,
      modules: session.modules,
      mode: session.mode,
      expiresAt: session.expiresAt,
      startedAt: session.startedAt,
      state: session.state,
      device: session.device ?? null,
      jti: session.jti ?? null,
      error: session.error ?? null,
    }
  }

  const schedule = (myGen, ms) => {
    if (myGen !== generation || session === null) return
    session.timer = setTimeout(() => tick(myGen), ms)
  }

  /** claim 请求体按条目类型构造(契约不同):Rust 带 port(隧道端口,
   *  网关按它把手机路由回本机);CF 带 tunnel_host(cloudflared 公网主机名,
   *  Worker 据此路由 WS 下行,未配 cfHostname 时省略靠 Worker 兜底)。 */
  const claimPayload = (g) =>
    g.type === 'cf'
      ? {
          code: session.code, host_code: session.hostCode, host_label: session.label,
          ...(g.cfHostname ? { tunnel_host: g.cfHostname } : {}),
        }
      : { code: session.code, host_code: session.hostCode, host_label: session.label, port: g.remotePort }

  const tick = async (myGen) => {
    while (myGen === generation && session !== null) {
      if (Date.now() - session.startedAt > PAIRING_WINDOW_MS) {
        session.state = 'timeout'
        return
      }
      if (session.state === 'waiting') {
        const g = getGateways().find((x) => x.id === session.gatewayId) ?? session.gateway
        const call = adminOf(g)
        const j = call !== null ? await call('/admin/pair/claim', 'POST', claimPayload(g)) : null
        if (j !== null && j.claim_id) {
          session.state = 'claimed'
          session.gateway = g
        } else if (call === null) {
          session.state = 'error'
          session.error = unreachableHint(g)
        }
      } else if (session.state === 'claimed') {
        const g = session.gateway
        const call = adminOf(g)
        const j = call !== null ? await call('/admin/pair/status?code=' + session.code, 'GET') : null
        if (j && j.status === 'confirmed') {
          session.state = 'confirmed'
          session.device = (j.token && j.token.device) || null
          session.jti = (j.token && j.token.jti) || null
          return
        }
        if (j && j.status === 'expired') {
          session.state = 'expired'
          return
        }
      } else {
        return // confirmed / expired / timeout / error — 终态
      }
      schedule(myGen, 3000)
      return
    }
  }

  // 页面无推送通道;保留钩子(未来可接 ws)
  const emitPage = () => {}

  return {
    snapshot,
    /** 开始一次配对(扫码模式):选定网关条目 → 铸码 → 经该条目管理面出 QR
     *  (QR 编码其 pairUrl,手机由此锚定到同一台)→ 定向 claim 重试循环。
     *  gatewayId 缺省 = 第一个管理通道就绪的条目。 */
    start: async (gatewayId) => {
      generation += 1
      const myGen = generation
      clearTimer()
      const gateways = getGateways()
      const g = (gatewayId !== undefined && gatewayId !== null && gatewayId !== ''
          ? gateways.find((x) => x.id === gatewayId)
          : gateways.find((x) => adminOf(x) !== null)) ?? gateways[0]
      if (g === undefined) {
        return { state: 'error', mode: 'scan', error: '未配置任何中转服务器 —— 在上方「中转服务器」添加' }
      }
      const call = adminOf(g)
      const code = genCode(10)
      const hostCode = genCode(6)
      const inviteUrl = sanitizePairUrl(g.pairUrl) + '#c=' + code + '&h=' + hostCode + '&l=' + encodeURIComponent(getLabel())
      session = {
        code, hostCode, label: getLabel(), gateway: g, qr: null, modules: null, mode: 'scan',
        expiresAt: Date.now() + 10 * 60 * 1000, startedAt: Date.now(),
        state: 'waiting', device: null, jti: null, error: null, timer: null,
      }
      if (call === null) {
        session.state = 'error'
        session.error = unreachableHint(g)
        return snapshot()
      }
      if (!isValidPairUrl(sanitizePairUrl(g.pairUrl))) {
        session.state = 'error'
        session.error = nameOf(g) + ' 的配对入口 URL 无效(' + String(g.pairUrl ?? '') + ')—— 在服务器卡片中填写(如 https://dsh.example.com/pair)'
        return snapshot()
      }
      const j = await call('/admin/pair/qr', 'POST', { text: inviteUrl })
      if (j === null || typeof j.qr !== 'string' || j.qr.length === 0) {
        session.state = 'error'
        session.error = '二维码获取失败:' + unreachableHint(g) + '(需 /admin/pair/qr)'
        return snapshot()
      }
      session.qr = j.qr.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PRZcf-nqry=><]/g, '') // 剥 ANSI(网关发 ESC 序列),浏览器纯文本渲染
      session.modules = j.modules ?? null
      session.timer = setTimeout(() => tick(myGen), 300)
      return snapshot()
    },
    /** 手输模式应约:手机已在选定服务器上亮码等待,本机定向登记 claim 后轮询
     *  其确认(码打错快速失败)。gatewayId 必填语义由面板选择器保证 —— 手机
     *  等在哪台,面板就选哪台(选择器对齐,见注册表设计 §5.1)。 */
    startManual: async (gatewayId, codeRaw) => {
      const code = String(codeRaw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
      if (code.length !== 10) {
        return { state: 'error', mode: 'manual', error: '配对码应为 10 位字母数字(如 ABCDE-FGHJK)' }
      }
      const gateways = getGateways()
      const g = (gatewayId !== undefined && gatewayId !== null && gatewayId !== ''
          ? gateways.find((x) => x.id === gatewayId)
          : gateways.find((x) => adminOf(x) !== null)) ?? gateways[0]
      if (g === undefined) {
        return { state: 'error', mode: 'manual', error: '未配置任何中转服务器 —— 在上方「中转服务器」添加' }
      }
      const call = adminOf(g)
      if (call === null) {
        return { state: 'error', mode: 'manual', error: unreachableHint(g) }
      }
      generation += 1
      const myGen = generation
      clearTimer()
      session = {
        code, hostCode: genCode(6), label: getLabel(), gateway: g, qr: null, modules: null, mode: 'manual',
        expiresAt: Date.now() + 10 * 60 * 1000, startedAt: Date.now(),
        state: 'waiting', device: null, jti: null, error: null, timer: null,
      }
      const j = await call('/admin/pair/claim', 'POST', claimPayload(g))
      if (j !== null && j.claim_id) {
        session.state = 'claimed'
        session.device = j.device ?? null
        schedule(myGen, 3000)
      } else {
        session.state = 'error'
        session.error = j !== null && typeof j.error === 'string'
          ? nameOf(g) + ' 拒绝:' + j.error + ' —— 确认手机在『' + nameOf(g) + '』上等待且码未过期(选择器要与手机端一致)'
          : unreachableHint(g)
      }
      return snapshot()
    },
    stop: () => {
      generation += 1
      clearTimer()
      session = null
    },
    /** 已发令牌清单(跨服务器聚合,逐条带 via=服务器名/type 归属;全部条目
     *  不可达才 null)。多宿主/多租户过滤:只保留绑定本机(该条目
     *  upstream_port/tunnel_host)的令牌 —— 单运营者多机部署时每台宿主
     *  面板只见自己的设备。 */
    tokens: async () => {
      const lists = await Promise.all(getGateways().map(async (g) => {
        const call = adminOf(g)
        return { g, json: call !== null ? await call('/admin/pair/tokens', 'GET') : null }
      }))
      const merged = []
      for (const { g, json } of lists) {
        if (Array.isArray(json)) {
          for (const t of json) {
            if (belongsHere(g, t)) merged.push({ ...t, via: nameOf(g), viaType: g.type })
          }
        }
      }
      return lists.some((x) => Array.isArray(x.json)) ? merged : null
    },
    /** 吊销令牌(逐条目尝试:持有该 jti 的网关撤销成功即成功;全部不可达才提示)。 */
    revoke: async (jti) => {
      const results = await Promise.all(getGateways().map(async (g) => {
        const call = adminOf(g)
        return { json: call !== null ? await call('/admin/pair/revoke-token', 'POST', { jti: String(jti) }) : null }
      }))
      if (results.some((r) => r.json !== null && r.json.revoked === true)) return { revoked: true }
      return results.some((r) => r.json !== null)
        ? { revoked: false }
        : { revoked: false, error: '全部网关管理面不可达' }
    },
    /** 可用传输类型清单(legacy /api/mode 兼容;新面板用 /api/gateways)。 */
    transports: () => {
      const list = []
      for (const g of getGateways()) {
        if (adminOf(g) !== null && !list.includes(g.type)) list.push(g.type)
      }
      return list
    },
    /** Web 面(浏览器远程访问 dsh web)密码管理 —— 仅 Rust(ssh 运营者通道)
     *  网关有此面;作用于第一个具备 target 的 rust 条目。status:GET 查询;
     *  save:POST 明文密码(经 ssh base64 通道,网关侧 argon2 落库)/
     *  clear:true 关闭。CF/纯租户形态无此面,统一 unsupported 提示。 */
    webPassword: async (action, password) => {
      const g = getGateways().find((x) => x.type === 'rust' && x.target)
      if (g === undefined) return { error: 'Web 面仅 Rust(ssh)网关支持(未配 target 的条目)' }
      const call = adminOf(g)
      if (call === null) return { error: unreachableHint(g) }
      if (action === 'status') {
        return (await call('/admin/web/password', 'GET')) ?? { error: unreachableHint(g) }
      }
      if (action === 'clear') {
        return (await call('/admin/web/password', 'POST', { clear: true })) ?? { error: unreachableHint(g) }
      }
      if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
        return { error: '密码需 8-128 字符' }
      }
      return (await call('/admin/web/password', 'POST', { password })) ?? { error: unreachableHint(g) }
    },
  }
}

// ── loopback 判定(管理面 API 只对本机页面开放;参照 dsh 官方插件的围栏) ────

const isLoopbackAuthority = (hostHeader) => {
  if (!hostHeader) return false
  try {
    const h = new URL('http://' + String(hostHeader)).hostname
    if (h === 'localhost' || h === '[::1]') return true
    const parts = h.split('.')
    return parts.length === 4 && parts[0] === '127' && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
  } catch {
    return false
  }
}

/** 同源门(2026-08-17 审计补):浏览器跨源请求一律拒(Sec-Fetch-Site / Origin
 *  双检),与写操作强制的 x-dsh-mobile 自定义头(见 route)组成 CSRF 三重门。
 *  原生客户端不带这些浏览器头 —— 手机 App 经网关隧道 GET /api/host、运维
 *  curl 都不受影响。 */
const sameOriginGate = (req) => {
  const sfs = req.headers['sec-fetch-site']
  if (sfs !== undefined && sfs !== 'same-origin' && sfs !== 'none') return false
  const origin = req.headers.origin
  if (origin !== undefined) {
    try { return isLoopbackAuthority(new URL(origin).host) } catch { return false }
  }
  return true
}

// (独立 /pair 管理页已删:管理 UI 只剩浏览器半边 dialog(lib/client.js),
//  公网扫码落地页由网关自持(Rust pair_page_handler / CF Worker pairPage),
//  与本插件无关。/pair 前缀下只剩 /pair/api/* 管理 API。)

// ── 插件入口 ───────────────────────────────────────────────────────────────

export function apply(ctx, config = {}) {
  const ws = ctx.get('webServer')
  if (ws === undefined) return

  const options = {
    pagePath: config?.pagePath ?? '/pair',
    cloudflaredBin: process.env.DSH_MOBILE_CLOUDFLARED_BIN ?? config?.cloudflaredBin ?? 'cloudflared',
    label: sanitizeLabel(process.env.DSH_MOBILE_LABEL ?? config?.label) || shortHostname(),
  }

  const emit = (level, message) => {
    const logger = ctx.logger
    const line = 'dsh-mobile: ' + message
    if (logger && typeof logger[level] === 'function') logger[level](line)
    else console[level === 'warning' ? 'warn' : 'log']('[' + line + ']')
  }

  // ── 中转服务器注册表 ─────────────────────────────────────────────────────
  // base = 扁平 config/env 派生(迁移来源);用户层 settings 的 gateways 非空
  // 时整体接管。凭证/pairUrl/名称经 settings watch 即时生效;隧道参数
  // (target/remotePort/sockDir/cfTunnelId/cfHostname)改动需重启 dsh web。
  const baseGateways = deriveBaseGateways(config)

  /** 注册表校验:pairUrl 可解析 http(s)、rust 端口合法、同服务器落点去重。
   *  抛出的错误即面板保存/启动时的 fail-loud 文案。 */
  const validateGateways = (entries) => {
    for (const g of entries) {
      if (g.type !== 'rust' && g.type !== 'cf') throw new Error('网关类型须为 rust/cf')
      if (g.pairUrl !== undefined && g.pairUrl !== '' && !isValidPairUrl(sanitizePairUrl(g.pairUrl))) {
        throw new Error('「' + String(g.name || g.id) + '」配对入口 URL 无效:' + String(g.pairUrl))
      }
      if (g.type === 'rust') {
        if (g.remotePort !== undefined && g.remotePort !== null && (!Number.isInteger(g.remotePort) || g.remotePort <= 0 || g.remotePort > 65535)) {
          throw new Error('「' + String(g.name || g.id) + '」remotePort 无效:' + String(g.remotePort))
        }
        if (typeof g.sockDir !== 'string' || String(g.sockDir).includes(':')) {
          throw new Error('「' + String(g.name || g.id) + '」sockDir 无效:' + String(g.sockDir))
        }
        if (!g.pairUrl && !g.target && !(g.adminUrl && g.tenantKey)) {
          throw new Error('「' + String(g.name || g.id) + '」rust 条目至少需要 target(ssh)或 adminUrl+tenantKey(多租户)')
        }
      }
      if (g.type === 'cf') {
        if (!g.gateway) throw new Error('「' + String(g.name || g.id) + '」cf 条目需要 gateway(Worker 地址)')
        if (g.cfTunnelId && !g.cfHostname) throw new Error('「' + String(g.name || g.id) + '」cfTunnelId 需要 cfHostname')
      }
    }
    for (const [a, b] of gatewayConflicts(entries)) {
      throw new Error('网关 ' + String(a) + ' 与 ' + String(b) + ' 在同一服务器同一落点(target+remotePort / gateway+cfTunnelId 重复)')
    }
  }

  validateGateways(baseGateways)
  if (baseGateways.length === 0) {
    throw new Error('dsh-mobile: no gateway configured (rust: target 或 adminUrl+tenantKey;cf: gateway)')
  }
  let gateways = baseGateways

  // 机器名/注册表注册进 dsh 用户 settings(base = 派生条目;用户层 gateways
  // 非空时接管)。watch 里校验失败只告警不崩(fail loud,拒绝该次变更)。
  // settings 服务缺席(过旧 dsh)时静默保持 base —— 其余功能不受影响。
  let labelScope = null
  ctx.inject(['settings'], (sctx) => {
    labelScope = sctx.settings.register(settingsNamespace(LABEL_NS), SettingsSchema, {
      base: {
        label: sanitizeLabel(process.env.DSH_MOBILE_LABEL ?? config?.label) || shortHostname(),
        adminKey: sanitizeAdminKey(process.env.DSH_MOBILE_ADMIN_KEY ?? config?.adminKey),
        tenantKey: sanitizeAdminKey(process.env.DSH_MOBILE_TENANT_KEY ?? config?.tenantKey),
        gateways: [],
      },
    })
    options.label = sanitizeLabel(labelScope.get().label) || shortHostname()
    const applyUserGateways = (user) => {
      const list = Array.isArray(user) && user.length > 0 ? user : baseGateways
      validateGateways(list)
      gateways = list
    }
    try {
      applyUserGateways(labelScope.get().gateways)
    } catch (e) {
      emit('warning', 'settings 注册表非法,回落派生条目:' + String(e && e.message ? e.message : e))
    }
    sctx.effect(() => labelScope.watch((next) => {
      options.label = sanitizeLabel(next.label) || shortHostname()
      try {
        applyUserGateways(next.gateways)
      } catch (e) {
        emit('warning', '注册表变更被拒绝(保持原值):' + String(e && e.message ? e.message : e))
      }
    }))
  })

  /** 持久化注册表变更:以用户层为基准(为空则先把派生条目收编进去)→ 变异 →
   *  校验 → settings.update。 tunnels 仍是启动时的实例集合 —— 隧道参数
   *  改动写盘成功后提示重启生效。 */
  const saveGateways = async (mutate) => {
    if (labelScope === null) {
      return { ok: false, error: 'settings service unavailable (dsh too old); 配置经 cordis.patch.yml / 环境变量' }
    }
    const current = Array.isArray(labelScope.get().gateways) && labelScope.get().gateways.length > 0
      ? structuredClone(labelScope.get().gateways)
      : structuredClone(baseGateways)
    const next = mutate(current)
    validateGateways(next)
    try {
      await labelScope.update({ gateways: next })
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) }
    }
    return { ok: true }
  }

  // 隧道按条目实例化(多 Rust/CF 并发,各自独立退避监管;见多隧道并发设计):
  // rust+target → ssh -R;cf+cfTunnelId → cloudflared(配置文件按条目分文件)。
  const tunnels = new Map()
  for (const g of gateways) {
    if (g.type === 'rust' && g.target) {
      tunnels.set(g.id, startTunnel(emit, g.target, g.remotePort, ws.port, g.sockDir))
    } else if (g.type === 'cf' && g.cfTunnelId) {
      tunnels.set(g.id, startCloudflared(emit, options.cloudflaredBin,
        homedir() + '/.cloudflared/dsh-mobile-' + String(g.id) + '.yml', g.cfTunnelId, g.cfHostname, ws.port))
    } else if (g.type === 'cf' && g.gateway) {
      emit('warning', '「' + String(g.name || g.id) + '」配置了 gateway 但缺 cfTunnelId —— CF 隧道不会拉起(手机将连不上),补齐后重启')
    }
  }

  const pair = createPairService({
    getGateways: () => gateways,
    getLabel: () => options.label,
  })

  const readBody = (req) =>
    new Promise((resolve) => {
      // JSON 体端点强制 application/json:跨源「简单请求」(text/plain)不发
      // 预检,是绕过同源门的主通道;本插件页面(client.js)始终带此头。
      const ct = String(req.headers['content-type'] ?? '').toLowerCase()
      if (!ct.startsWith('application/json')) { resolve(null); return }
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { resolve(null) }
      })
      req.on('error', () => resolve(null))
    })

  const sendJson = (res, status, value) => {
    const body = JSON.stringify(value)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' })
    res.end(body)
  }

  const route = {
    kind: 'prefix',
    path: options.pagePath,
    handler: async (req, res) => {
      // prefix 路由收到的 req.url 仍带 pagePath 前缀(/pair/api/…):剥掉再分发。
      // 独立管理页已删:非 /api/* 一律 404,管理 UI 只有侧栏 dialog(client.js)。
      const prefix = options.pagePath.replace(/\/$/, '')
      let url = req.url ?? ''
      if (url.startsWith(prefix + '/')) url = url.slice(prefix.length)
      if (!url.startsWith('/api/')) {
        return sendJson(res, 404, { error: 'not found' })
      }
      // 管理 API:仅 loopback 页面可用(防 host 0.0.0.0 部署时被局域网操纵)。
      if (!isLoopbackAuthority(req.headers.host)) {
        return sendJson(res, 403, { ok: false, error: 'management API is loopback-only' })
      }
      // 同源三重门(2026-08-17 审计加固,防恶意网页跨源 CSRF):①Sec-Fetch-Site
      // /Origin 非同源即拒(堵简单请求);②写操作强制 x-dsh-mobile 自定义头
      // (跨源 fetch 带自定义头必过预检,预检不过请求根本不发出);③readBody
      // 限 application/json。GET 只读,仅过①。
      if (!sameOriginGate(req)) {
        return sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' })
      }
      if (req.method !== 'GET' && req.headers['x-dsh-mobile'] !== '1') {
        return sendJson(res, 403, { ok: false, error: 'write API requires dsh-mobile client header' })
      }
      const u = new URL(url, 'http://x')
      try {
        // 宿主自述:手机 App(经网关隧道,Host 已被网关改写为 loopback)连接
        // 就绪后 GET 此处,取机器名显示「已连接 xxx」。非敏感,无需写操作。
        if (u.pathname === '/api/host' && req.method === 'GET') {
          const rustGw = gateways.find((g) => g.type === 'rust')
          return sendJson(res, 200, {
            ok: true,
            label: options.label,
            hostname: hostname(),
            port: rustGw !== undefined ? rustGw.remotePort : null,
          })
        }
        if (u.pathname === '/api/label' && req.method === 'GET') {
          return sendJson(res, 200, { ok: true, label: options.label, editable: labelScope !== null })
        }
        if (u.pathname === '/api/label' && req.method === 'POST') {
          const body = await readBody(req)
          if (body === null || typeof body.label !== 'string') {
            return sendJson(res, 400, { ok: false, error: 'label required' })
          }
          if (labelScope === null) {
            return sendJson(res, 503, { ok: false, error: 'settings service unavailable (dsh too old); set label via cordis.patch.yml config' })
          }
          const next = sanitizeLabel(body.label)
          if (next.length === 0) {
            return sendJson(res, 400, { ok: false, error: 'label must be 1-32 chars' })
          }
          try {
            await labelScope.update({ label: next })
          } catch (e) {
            return sendJson(res, 409, { ok: false, error: String(e && e.message ? e.message : e) })
          }
          return sendJson(res, 200, { ok: true, label: options.label })
        }
        // CF 管理密钥(legacy 垫片 → 第一个 cf 条目;新面板用 /api/gateways):
        // GET 只报配置状态与掩码(不回显全值);POST 写进注册表用户层即时生效。
        if (u.pathname === '/api/admin-key' && req.method === 'GET') {
          const g = gateways.find((x) => x.type === 'cf')
          return sendJson(res, 200, {
            ok: true,
            configured: g !== undefined && Boolean(g.adminKey),
            masked: g !== undefined && g.adminKey ? g.adminKey.slice(0, 4) + '…' + g.adminKey.slice(-4) : '',
            editable: labelScope !== null,
          })
        }
        if (u.pathname === '/api/admin-key' && req.method === 'POST') {
          const body = await readBody(req)
          if (body === null || typeof body.adminKey !== 'string') {
            return sendJson(res, 400, { ok: false, error: 'adminKey required' })
          }
          const next = sanitizeAdminKey(body.adminKey)
          if (next.length !== 0 && next.length < 16) {
            return sendJson(res, 400, { ok: false, error: 'adminKey 至少 16 字符(openssl rand -hex 32)' })
          }
          const r = await saveGateways((list) => {
            const g = list.find((x) => x.type === 'cf')
            if (g === undefined) throw new Error('未配置 cf 条目 —— 在「中转服务器」添加后填写')
            g.adminKey = next
            return list
          })
          return sendJson(res, r.ok ? 200 : 409, { ...r, configured: next.length > 0 })
        }
        // Rust 多租户密钥(与 adminKey 同款语义:GET 只报状态掩码,POST 保存进
        // 用户层 settings 即时生效)。配 adminUrl 后 Rust 管理面走 HTTPS 直连。
        if (u.pathname === '/api/tenant-key' && req.method === 'GET') {
          const g = gateways.find((x) => x.type === 'rust')
          return sendJson(res, 200, {
            ok: true,
            configured: g !== undefined && Boolean(g.tenantKey),
            masked: g !== undefined && g.tenantKey ? g.tenantKey.slice(0, 4) + '…' + g.tenantKey.slice(-4) : '',
            adminUrl: g !== undefined ? g.adminUrl : '',
            editable: labelScope !== null,
          })
        }
        if (u.pathname === '/api/tenant-key' && req.method === 'POST') {
          const body = await readBody(req)
          if (body === null || typeof body.tenantKey !== 'string') {
            return sendJson(res, 400, { ok: false, error: 'tenantKey required' })
          }
          const next = sanitizeAdminKey(body.tenantKey)
          if (next.length !== 0 && next.length < 16) {
            return sendJson(res, 400, { ok: false, error: 'tenantKey 至少 16 字符(运营者经 /admin/tenants 签发)' })
          }
          const r = await saveGateways((list) => {
            const g = list.find((x) => x.type === 'rust')
            if (g === undefined) throw new Error('未配置 rust 条目 —— 在「中转服务器」添加后填写')
            g.tenantKey = next
            return list
          })
          return sendJson(res, r.ok ? 200 : 409, { ...r, configured: next.length > 0 })
        }
        // ── 中转服务器注册表(新面板主数据源)────────────────────────────
        // GET:条目清单 + 状态(管理通道就绪、隧道状态;密钥只报掩码状态)。
        if (u.pathname === '/api/gateways' && req.method === 'GET') {
          return sendJson(res, 200, {
            ok: true,
            editable: labelScope !== null,
            gateways: gateways.map((g) => ({
              id: g.id,
              type: g.type,
              name: g.name ?? '',
              pairUrl: sanitizePairUrl(g.pairUrl ?? ''),
              target: g.target ?? '',
              adminPort: g.adminPort ?? 8103,
              remotePort: g.remotePort ?? null,
              sockDir: g.sockDir ?? '',
              adminUrl: g.adminUrl ?? '',
              gateway: g.gateway ?? '',
              cfTunnelId: g.cfTunnelId ?? '',
              cfHostname: g.cfHostname ?? '',
              adminReady: gatewayAdminReady(g),
              adminKeyConfigured: Boolean(g.adminKey),
              tenantKeyConfigured: Boolean(g.tenantKey),
              tunnel: tunnels.has(g.id) ? tunnels.get(g.id).state() : null,
            })),
          })
        }
        // POST:upsert 条目 { entry } 或删除 { remove: id }。隧道参数改动保存
        // 成功后需重启 dsh web 才生效(返回 restartTunnel 提示位)。
        if (u.pathname === '/api/gateways' && req.method === 'POST') {
          const body = await readBody(req)
          if (body === null) return sendJson(res, 400, { ok: false, error: 'invalid body' })
          if (body.remove === true) {
            if (typeof body.id !== 'string' || body.id === '') {
              return sendJson(res, 400, { ok: false, error: 'id required' })
            }
            const r = await saveGateways((list) => list.filter((x) => x.id !== body.id))
            return sendJson(res, r.ok ? 200 : 409, r)
          }
          const e = body.entry
          if (e === null || typeof e !== 'object' || (e.type !== 'rust' && e.type !== 'cf')) {
            return sendJson(res, 400, { ok: false, error: 'entry {type: rust|cf, …} required' })
          }
          const id = slugifyGatewayId(e.id) || slugifyGatewayId(e.name) || (e.type + '-' + String(Date.now().toString(36)))
          const str = (v) => String(v ?? '').trim()
          const entry = {
            id,
            type: e.type,
            name: sanitizeLabel(e.name),
            pairUrl: sanitizePairUrl(e.pairUrl),
            ...(e.type === 'rust'
              ? {
                  target: str(e.target),
                  adminPort: Number(e.adminPort ?? 8103) || 8103,
                  remotePort: Number(e.remotePort ?? 0) || null,
                  sockDir: str(e.sockDir),
                  adminUrl: str(e.adminUrl).replace(/\/+$/, ''),
                  // 密键 undefined = 编辑器留空(保持现值);传串(含空)才覆盖。
                  ...(e.tenantKey === undefined ? {} : { tenantKey: sanitizeAdminKey(e.tenantKey) }),
                }
              : {
                  gateway: str(e.gateway).replace(/\/+$/, ''),
                  ...(e.adminKey === undefined ? {} : { adminKey: sanitizeAdminKey(e.adminKey) }),
                  cfTunnelId: str(e.cfTunnelId),
                  cfHostname: str(e.cfHostname),
                }),
          }
          const r = await saveGateways((list) => {
            const i = list.findIndex((x) => x.id === id)
            // 密钥 undefined = 保持现值(编辑器留空);显式传串(含空)才覆盖。
            if (i >= 0) {
              if (entry.adminKey === undefined) entry.adminKey = list[i].adminKey ?? ''
              if (entry.tenantKey === undefined) entry.tenantKey = list[i].tenantKey ?? ''
              list[i] = entry
            } else {
              list.push(entry)
            }
            return list
          })
          if (!r.ok) return sendJson(res, 409, r)
          return sendJson(res, 200, { ok: true, entry, restartTunnel: true })
        }
        if (u.pathname === '/api/tunnel' && req.method === 'GET') {
          // 按条目上报全部隧道;顶层字段取第一个条目(兼容旧页面)。
          const list = [...tunnels.entries()].map(([id, t]) => ({ id, ...t.state() }))
          const first = gateways[0]
          const active = first !== undefined ? (tunnels.get(first.id)?.state() ?? null) : null
          return sendJson(res, 200, {
            ...(active ?? { mode: 'none', up: false }),
            via: first !== undefined ? first.type : 'none',
            gateways: list,
          })
        }
        // 配对形态自述(legacy 兼容;新面板以 /api/gateways 为准)。
        if (u.pathname === '/api/mode' && req.method === 'GET') {
          const g = gateways[0]
          return sendJson(res, 200, {
            ok: true,
            via: g !== undefined ? g.type : 'none',
            transports: pair.transports(),
            publicUrl: g !== undefined ? sanitizePairUrl(g.pairUrl ?? '') : '',
            gateway: g !== undefined ? String(g.gateway ?? '') : '',
            keyConfigured: g !== undefined && Boolean(g.adminKey),
            target: g !== undefined ? String(g.target ?? '') : '',
            adminPort: g !== undefined ? Number(g.adminPort ?? 8103) : null,
            remotePort: g !== undefined ? (g.remotePort ?? null) : null,
            cfHostname: g !== undefined ? String(g.cfHostname ?? '') : '',
            adminUrl: g !== undefined ? String(g.adminUrl ?? '') : '',
            tenantKeyConfigured: g !== undefined && Boolean(g.tenantKey),
          })
        }
        if (u.pathname === '/api/start' && req.method === 'POST') {
          const body = await readBody(req)
          return sendJson(res, 200, await pair.start(body !== null ? body.gatewayId : undefined))
        }
        if (u.pathname === '/api/claim' && req.method === 'POST') {
          const body = await readBody(req)
          if (body === null || typeof body.code !== 'string') {
            return sendJson(res, 400, { error: 'code required' })
          }
          return sendJson(res, 200, await pair.startManual(body.gatewayId, body.code))
        }
        if (u.pathname === '/api/stop' && req.method === 'POST') {
          pair.stop()
          return sendJson(res, 200, { ok: true })
        }
        if (u.pathname === '/api/state' && req.method === 'GET') {
          const code = (u.searchParams.get('code') ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
          const s = pair.snapshot()
          if (s === null || s.code !== code) return sendJson(res, 404, { error: 'no such pairing' })
          return sendJson(res, 200, s)
        }
        // Web 面(浏览器远程访问)密码:GET 状态;POST 保存/清除。明文密码只
        // 经 loopback 管理页 → 插件 → ssh base64 通道,不落任何日志。
        if (u.pathname === '/api/web-password' && req.method === 'GET') {
          return sendJson(res, 200, await pair.webPassword('status'))
        }
        if (u.pathname === '/api/web-password' && req.method === 'POST') {
          const body = await readBody(req)
          if (body === null) return sendJson(res, 400, { error: 'invalid body' })
          if (body.clear === true) return sendJson(res, 200, await pair.webPassword('clear'))
          if (typeof body.password !== 'string') return sendJson(res, 400, { error: 'password required' })
          return sendJson(res, 200, await pair.webPassword('save', body.password))
        }
        if (u.pathname === '/api/tokens' && req.method === 'GET') {
          const list = await pair.tokens()
          if (list === null) return sendJson(res, 502, { error: 'gateway admin unreachable' })
          // 每个令牌已带 via 归属(设备表隧道徽章数据源):令牌只存在于配对时
          // 登记它的那个网关,DB 不互通 —— 双网关部署时清单为两边合并。
          return sendJson(res, 200, list)
        }
        if (u.pathname === '/api/revoke' && req.method === 'POST') {
          const body = await readBody(req)
          // jti 字符白名单(注入纵深;payload 虽已 base64 化,入参仍不放松)。
          if (body === null || typeof body.jti !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.jti)) {
            return sendJson(res, 400, { error: 'jti required([A-Za-z0-9_-])' })
          }
          return sendJson(res, 200, await pair.revoke(body.jti))
        }
        return sendJson(res, 404, { error: 'not found' })
      } catch (e) {
        return sendJson(res, 500, { error: String(e && e.message ? e.message : e) })
      }
    },
  }
  const disposers = []
  disposers.push(ws.register(route))

  // 主界面入口不再走 tapIndex fixed 角标(会遮住侧栏 foot 的设置按钮)——
  // 入口在浏览器半边(lib/client.js):注册 sidebar.footer.action 座,与设置
  // 按钮同区,点击弹 dialog。独立 /pair 管理页已删,这里只剩 /pair/api 路由。

  ctx.effect(() => () => {
    for (const t of tunnels.values()) t.stop()
    pair.stop()
    for (const dispose of disposers) {
      try { dispose() } catch {}
    }
  })
}
