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
const SettingsSchema = z.object({
  label: z.string().required(false),
  adminKey: z.string().required(false),
})

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
 * 无活动自动退),单次调用只剩一次远端 exec。master 挂掉时 auto 自动重建。 */
const SSH_CTRL = [
  '-o', 'ControlMaster=auto',
  '-o', 'ControlPath=~/.ssh/dsh-mobile-%C',
  '-o', 'ControlPersist=10m',
]

const sshCurl = (target, cli, timeoutMs) =>
  new Promise((resolve) => {
    const child = spawn(SSH, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', ...SSH_CTRL, String(target), cli], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let out = ''
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(String(v).trim())
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      finish('')
    }, timeoutMs ?? 15000)
    child.stdout.on('data', (d) => { out += String(d) })
    child.on('exit', () => finish(out))
    child.on('error', () => finish(''))
  })

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
    child.stderr.on('data', (d) => {
      const text = String(d).trim()
      if (text && !text.includes('Permanently added')) emit('warning', text)
    })
    child.on('exit', (code, signal) => {
      child = null
      if (stopped) return
      const delay = Math.min(1000 * 2 ** Math.min(attempt, 5), 30000)
      // 寿命 <60s = 未立稳(bind 失败约 1s 即退);连续短命退出触发残留自愈
      if (Date.now() - bornAt < 60000) {
        failStreak += 1
        if (failStreak >= HEAL_AFTER_FAILS) void healStaleSocket()
      } else {
        failStreak = 0
      }
      attempt += 1
      emit('warning', 'ssh exited (code=' + String(code) + ' signal=' + String(signal) + '); restart in ' + String(delay) + 'ms — 检查落点 ' + remoteListen + ' 是否被占用(UDS 残留:ssh 服务器 rm ' + remoteListen + ')')
      timer = setTimeout(start, delay)
    })
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
    let sawRegister = false
    child.stderr.on('data', (d) => {
      const text = String(d).trim()
      if (!text) return
      if (text.includes('Registered tunnel connection')) sawRegister = true
      if (!sawRegister || text.includes('ERR')) emit('warning', text)
    })
    child.on('exit', (code, signal) => {
      child = null
      if (stopped) return
      const delay = Math.min(1000 * 2 ** Math.min(attempt, 5), 30000)
      attempt += 1
      emit('warning', 'cloudflared exited (code=' + String(code) + ' signal=' + String(signal) + '); restart in ' + String(delay) + 'ms')
      timer = setTimeout(start, delay)
    })
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
const pairViaCf = (o) => Boolean(o.gateway) && hostOf(o.publicUrl) === hostOf(o.gateway)
const cfNeedsKey = (o) => pairViaCf(o) && !o.adminKey

function createPairService(options) {
  // 双网关并存(2026-08-16):配对 pending 只存在于手机 start 的那个网关,
  // 两网关 DB 不互通 —— 打错网关的症状就是「手机停在等待页,claim 404
  // no phone waiting」。Mac 侧同时握有两边管理凭证(ssh = Rust 信任根,
  // ADMIN_KEY = CF 信任根),因此 claim/status/tokens/revoke 对全部可用
  // 传输「双发」:手机等在哪个网关,哪边的调用就成交,另一边的 404 忽略。
  //   · CF 传输:gateway+adminKey 都配置才可用(fetch 直连 Worker);
  //   · Rust 传输:target 配置即可用(经 ssh 在服务器本机 curl loopback)。
  // 唯一例外:扫码模式手机被 QR 锚定到 publicUrl 的 host,锚定 CF 而密钥
  // 缺失时维持 fail-closed 报错 —— 双发救不了「锚定网关本身调不了」,
  // 静默 rust-only 只会退回「no phone waiting」老症状。adminKey 可在
  // 「移动接入」dialog 随时补(settings watch 即时生效)。
  const needKeyHint = () => '配对走 CF 网关 ' + hostOf(options.publicUrl)
    + ',尚未填管理密钥 —— 在下方「管理密钥」填写保存后重试'
  const admin = 'http://127.0.0.1:' + String(options.adminPort)
  // DSH_GATEWAY_ADMIN_TOKEN 非空时网关管理面要求 bearer;服务器侧就地读取注入
  // (远端命令内展开),凭证不出服务器;env 未配置时头值 "Bearer ",网关放行。
  const AH = "-H \"authorization: Bearer $(sed -n 's/^DSH_GATEWAY_ADMIN_TOKEN=//p' /etc/dsh-gateway.env)\" "

  /** 当前可用传输清单(每次调用现算 —— adminKey 经 settings watch 可变)。 */
  const transports = () => {
    const list = []
    if (options.gateway && options.adminKey) list.push('cf')
    if (options.target) list.push('rust')
    return list
  }

  /** CF 形态:直连 Worker 管理面(ADMIN_KEY 信任根);失败/非 JSON 统一 null。 */
  const cfFetch = async (path, method, payload) => {
    try {
      const resp = await fetch(options.gateway + path, {
        method,
        signal: AbortSignal.timeout(10000),
        headers: {
          authorization: 'Bearer ' + options.adminKey,
          ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: payload !== undefined ? JSON.stringify(payload) : undefined,
      })
      return tryJson(await resp.text())
    } catch {
      return null
    }
  }

  /** Rust 形态:经 ssh 在服务器本机 curl 管理面;payload 一律 base64 传输、
   *  远端解码后经 stdin 喂 curl —— 不把 JSON 拼进 shell 单引号(JSON.stringify
   *  不转义单引号,裸拼 = 远端命令注入面,2026-08-17 审计修复);base64 字符集
   *  天然 shell 安全。返回值与 cfFetch 对齐为「解析后的 JSON 对象或 null」
   *  (sshCurl resolve '' → tryJson('') = null),调用方无需再分形态判型 ——
   *  此前裸返字符串曾令 rust 形态的 claim/status 永远判不中(存量 bug,
   *  2026-08-16 双发重构时修复)。 */
  const rustFetch = async (path, payload) => {
    const cli = payload !== undefined
      ? "printf %s '" + Buffer.from(JSON.stringify(payload)).toString('base64')
        + "' | base64 -d | curl -s " + AH + "--max-time 8 -X POST " + admin + path
        + " -H 'content-type: application/json' --data-binary @-"
      : "curl -s " + AH + "--max-time 8 '" + admin + path + "'"
    return tryJson(await sshCurl(options.target, cli))
  }

  /** 单传输管理面调用;via = 'cf' | 'rust'。 */
  const adminCall = (via, path, method, payload) =>
    via === 'cf' ? cfFetch(path, method, payload) : rustFetch(path, payload)

  const unreachableHint = () => {
    const parts = []
    if (options.gateway) parts.push('CF 网关 ' + options.gateway + (options.adminKey ? '' : '(缺管理密钥)'))
    if (options.target) parts.push('ssh ' + String(options.target) + ' 管理口 ' + String(options.adminPort))
    return parts.length > 0
      ? '网关管理面不可达:检查 ' + parts.join('、')
      : '无可用网关传输(未配 target / gateway+adminKey)'
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
    return {
      code: session.code,
      displayCode: session.code.slice(0, 5) + '-' + session.code.slice(5),
      hostCode: session.hostCode.slice(0, 3) + '-' + session.hostCode.slice(3),
      label: session.label,
      port: session.port,
      publicUrl: session.publicUrl,
      // 形态自述(页面 confirmed 文案选隧道标识用):cf → cloudflared 主机名,
      // rust → 隧道端口。已成交时以成交传输为准(手机可能等在任一网关),
      // 未成交前用锚定形态占位。
      via: session.via ?? (pairViaCf(options) ? 'cf' : 'rust'),
      tunnelHost: (session.via ?? (pairViaCf(options) ? 'cf' : 'rust')) === 'cf' ? options.cfHostname : '',
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

  /** claim 请求体按形态构造(契约不同):Rust 带 port(隧道端口);CF 带
   *  tunnel_host(cloudflared 公网主机名 —— Worker 据此把手机 WS 下行路由到
   *  本机隧道,未配 cfHostname 时省略,靠 Worker 侧 TUNNEL_HOST 兜底)。 */
  const claimPayload = (via) =>
    via === 'cf'
      ? {
          code: session.code, host_code: session.hostCode, host_label: session.label,
          ...(options.cfHostname ? { tunnel_host: options.cfHostname } : {}),
        }
      : { code: session.code, host_code: session.hostCode, host_label: session.label, port: session.port }

  /** 双发 claim:对每个可用传输各登记一次,返回 [{via, json}]。
   *  json = 响应对象(成交 {claim_id,…} / 拒绝 {error,…})或 null(传输
   *  不可达);pending 只在手机所在那个网关,另一边 404 属预期,调用方忽略。 */
  const claimAll = () =>
    Promise.all(transports().map(async (via) => ({
      via,
      json: await adminCall(via, '/admin/pair/claim', 'POST', claimPayload(via)),
    })))

  /** 双发全部被拒时的聚合报错(任一边成交则不会走到这里):有错误体就
   *  逐条列出(哪边拒绝一目了然);全部传输不可达才报网络提示;锚定 CF
   *  缺密钥(CF 传输因此缺席)时追加补钥提示。 */
  const mergeClaimErrors = (results) => {
    const errs = results
      .filter((r) => r.json !== null && typeof r.json.error === 'string')
      .map((r) => r.json.error)
    if (errs.length === 0) return unreachableHint()
    if (pairViaCf(options) && !options.adminKey) errs.push(needKeyHint())
    return '网关拒绝:' + errs.join(' / ') + ' —— 确认手机停留在配对等待页且码未过期'
  }

  const tick = async (myGen) => {
    while (myGen === generation && session !== null) {
      if (Date.now() - session.startedAt > PAIRING_WINDOW_MS) {
        session.state = 'timeout'
        return
      }
      if (session.state === 'waiting') {
        const ok = (await claimAll()).find((r) => r.json !== null && r.json.claim_id)
        if (ok) {
          session.state = 'claimed'
          session.via = ok.via // 只轮询成交侧(手机只会在那边 confirm)
          emitPage(null) // 状态变化由页面轮询拉取;无推送,占位
        }
      } else if (session.state === 'claimed') {
        const j = await adminCall(session.via, '/admin/pair/status?code=' + session.code, 'GET')
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
    /** 开始一次配对:铸码 → 向网关要 QR → 后台 claim 重试循环。 */
    start: async () => {
      generation += 1
      const myGen = generation
      clearTimer()
      const code = genCode(10)
      const hostCode = genCode(6)
      const inviteUrl = options.publicUrl + '#c=' + code + '&h=' + hostCode + '&l=' + encodeURIComponent(options.label)
      session = {
        code, hostCode, label: options.label, port: options.remotePort,
        publicUrl: options.publicUrl, qr: null, modules: null, mode: 'scan',
        expiresAt: Date.now() + 10 * 60 * 1000, startedAt: Date.now(),
        state: 'waiting', device: null, jti: null, error: null, timer: null, via: null,
      }
      if (cfNeedsKey(options)) {
        session.state = 'error'
        session.error = needKeyHint()
        return snapshot()
      }
      // QR 是纯文本渲染(与内容无关),任一可用网关的管理面都能出;锚定形态
      // 优先,锚定侧不可达时借另一侧渲染(内容同样是 inviteUrl,不影响锚定)。
      const anchor = pairViaCf(options) ? 'cf' : 'rust'
      const order = transports().sort((a, b) => (b === anchor) - (a === anchor))
      let j = null
      for (const via of order) {
        j = await adminCall(via, '/admin/pair/qr', 'POST', { text: inviteUrl })
        if (j !== null && typeof j.qr === 'string' && j.qr.length > 0) break
        j = null
      }
      if (j === null) {
        session.state = 'error'
        session.error = '二维码获取失败:' + unreachableHint() + '(需 /admin/pair/qr)'
        return snapshot()
      }
      session.qr = j.qr.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PRZcf-nqry=><]/g, '') // 剥 ANSI(网关发 ESC 序列),浏览器纯文本渲染
      session.modules = j.modules ?? null
      session.timer = setTimeout(() => tick(myGen), 300)
      return snapshot()
    },
    /** 手输模式应约:手机已亮码等待,本机登记 claim 后轮询其确认(码打错快速失败)。 */
    startManual: async (codeRaw) => {
      const code = String(codeRaw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
      if (code.length !== 10) {
        return { state: 'error', mode: 'manual', error: '配对码应为 10 位字母数字(如 ABCDE-FGHJK)' }
      }
      // 无可用传输 = 锚定 CF 缺密钥且未配 ssh target(apply 启动门保证两者必配
      // 其一)—— 维持 fail-closed 补钥提示。有 rust 传输时不再因缺 CF 密钥拒绝
      // 手输:手机未被 QR 锚定,可能正等在 Rust 网关,双发自会命中。
      if (transports().length === 0) {
        return { state: 'error', mode: 'manual', error: needKeyHint() }
      }
      generation += 1
      const myGen = generation
      clearTimer()
      session = {
        code, hostCode: genCode(6), label: options.label, port: options.remotePort,
        publicUrl: options.publicUrl, qr: null, modules: null, mode: 'manual',
        expiresAt: Date.now() + 10 * 60 * 1000, startedAt: Date.now(),
        state: 'waiting', device: null, jti: null, error: null, timer: null, via: null,
      }
      const results = await claimAll()
      const ok = results.find((r) => r.json !== null && r.json.claim_id)
      if (ok) {
        session.state = 'claimed'
        session.via = ok.via
        session.device = ok.json.device ?? null
        schedule(myGen, 3000)
      } else {
        session.state = 'error'
        session.error = mergeClaimErrors(results)
      }
      return snapshot()
    },
    stop: () => {
      generation += 1
      clearTimer()
      session = null
    },
    /** 已发令牌清单(双网关合并,逐条带 via 归属;全部传输不可达才 null)。 */
    tokens: async () => {
      const lists = await Promise.all(transports().map(async (via) => ({
        via,
        json: await adminCall(via, '/admin/pair/tokens', 'GET'),
      })))
      const merged = []
      for (const { via, json } of lists) {
        if (Array.isArray(json)) for (const t of json) merged.push({ ...t, via })
      }
      return lists.some((x) => Array.isArray(x.json)) ? merged : null
    },
    /** 吊销令牌(双发:持有该 jti 的网关撤销成功即成功;两边都不可达才附带提示)。 */
    revoke: async (jti) => {
      const results = await Promise.all(transports().map(async (via) => ({
        via,
        json: await adminCall(via, '/admin/pair/revoke-token', 'POST', { jti: String(jti) }),
      })))
      if (results.some((r) => r.json !== null && r.json.revoked === true)) return { revoked: true }
      return results.some((r) => r.json !== null)
        ? { revoked: false }
        : { revoked: false, error: unreachableHint() }
    },
    /** 可用传输清单(/api/mode 透出给页面)。 */
    transports,
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
    target: process.env.DSH_MOBILE_TARGET ?? config?.target ?? '',
    remotePort: Number(process.env.DSH_MOBILE_REMOTE_PORT ?? config?.remotePort ?? 13100),
    sockDir: process.env.DSH_MOBILE_SOCK_DIR ?? config?.sockDir ?? '',
    adminPort: Number(process.env.DSH_MOBILE_ADMIN_PORT ?? config?.adminPort ?? 8103),
    // CF 形态(dsh-gateway-worker):gateway = Worker 网关地址,adminKey = 部署时
    // 填的 ADMIN_KEY。配对/设备管理直连 HTTPS;cloudflared 隧道由本插件随
    // dsh web 拉起(一次性准备:tunnel login/create/route dns)。
    gateway: (process.env.DSH_MOBILE_GATEWAY ?? config?.gateway ?? '').replace(/\/+$/, ''),
    adminKey: process.env.DSH_MOBILE_ADMIN_KEY ?? config?.adminKey ?? '',
    // cloudflared 隧道三件套:tunnel UUID(DNS 记录指向它)、隧道公网主机名、
    // cloudflared 二进制(默认 PATH 查找)。config.yml 由插件生成维护。
    cfTunnelId: process.env.DSH_MOBILE_CF_TUNNEL_ID ?? config?.cfTunnelId ?? '',
    cfHostname: process.env.DSH_MOBILE_CF_HOSTNAME ?? config?.cfHostname ?? '',
    cfConfigPath: process.env.DSH_MOBILE_CF_CONFIG ?? config?.cfConfigPath ?? (homedir() + '/.cloudflared/dsh-mobile.yml'),
    cloudflaredBin: process.env.DSH_MOBILE_CLOUDFLARED_BIN ?? config?.cloudflaredBin ?? 'cloudflared',
    publicUrl: process.env.DSH_MOBILE_PUBLIC_URL ?? config?.publicUrl ?? 'https://dsh.example.com/pair',
    pagePath: config?.pagePath ?? '/pair',
    label: sanitizeLabel(process.env.DSH_MOBILE_LABEL ?? config?.label) || shortHostname(),
  }
  for (const key of ['remotePort', 'adminPort']) {
    if (!Number.isInteger(options[key]) || options[key] <= 0 || options[key] > 65535) {
      throw new Error('dsh-mobile: invalid ' + key + ' ' + String(options[key]))
    }
  }
  if (options.gateway && !/^https:\/\/[a-zA-Z0-9.-]+(:\d+)?$/.test(options.gateway)) {
    throw new Error('dsh-mobile: invalid gateway ' + options.gateway + ' (expect https URL, no path)')
  }
  if (!options.target && !options.gateway) {
    throw new Error('dsh-mobile: need ssh target (Rust 形态) or gateway (CF 形态)')
  }

  // 机器名/管理密钥注册进 dsh 用户 settings(base = patch.yml config/环境变量;
  // 用户层可在「移动接入」dialog 改,持久化;watch 让运行中的配对/二维码即时生效 ——
  // adminKey 保存后无需重启即可配对)。settings 服务缺席(过旧 dsh)时静默保持
  // 静态值 —— 其余功能不受影响。
  let labelScope = null
  ctx.inject(['settings'], (sctx) => {
    labelScope = sctx.settings.register(settingsNamespace(LABEL_NS), SettingsSchema, {
      base: {
        label: sanitizeLabel(process.env.DSH_MOBILE_LABEL ?? config?.label) || shortHostname(),
        adminKey: sanitizeAdminKey(process.env.DSH_MOBILE_ADMIN_KEY ?? config?.adminKey),
      },
    })
    options.label = sanitizeLabel(labelScope.get().label) || shortHostname()
    options.adminKey = sanitizeAdminKey(labelScope.get().adminKey)
    sctx.effect(() => labelScope.watch((next) => {
      options.label = sanitizeLabel(next.label) || shortHostname()
      options.adminKey = sanitizeAdminKey(next.adminKey)
    }))
  })

  const emit = (level, message) => {
    const logger = ctx.logger
    const line = 'dsh-mobile: ' + message
    if (logger && typeof logger[level] === 'function') logger[level](line)
    else console[level === 'warning' ? 'warn' : 'log']('[' + line + ']')
  }

  if (typeof options.sockDir !== 'string' || options.sockDir.includes(':')) {
    throw new Error('dsh-mobile: invalid sockDir ' + String(options.sockDir))
  }
  // 隧道两通道各自独立、可并存:target = Rust 形态 ssh -R(随 dsh web 拉起);
  // cfTunnelId = CF 形态 cloudflared(同样随 dsh web 拉起,替代机器级服务)。
  const cfWanted = options.cfTunnelId !== ''
  if (options.gateway && !cfWanted) {
    emit('warning', '配置了 gateway 但缺 cfTunnelId —— CF 隧道不会拉起(手机将连不上),补 cfTunnelId/cfHostname 后重启')
  }
  if (cfWanted && options.cfHostname === '') {
    throw new Error('dsh-mobile: cfTunnelId 需要 cfHostname(隧道公网主机名)')
  }
  const tunnel = options.target
    ? startTunnel(emit, options.target, options.remotePort, ws.port, options.sockDir)
    : null
  const cfTunnel = cfWanted
    ? startCloudflared(emit, options.cloudflaredBin, options.cfConfigPath, options.cfTunnelId, options.cfHostname, ws.port)
    : null
  const pair = createPairService(options)

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
          return sendJson(res, 200, {
            ok: true,
            label: options.label,
            hostname: hostname(),
            port: options.remotePort,
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
        // CF 形态管理密钥:GET 只报配置状态与掩码(不回显全值);POST 保存进
        // 用户层 settings,即时生效(配对传输动态判定,无需重启)。
        if (u.pathname === '/api/admin-key' && req.method === 'GET') {
          return sendJson(res, 200, {
            ok: true,
            configured: Boolean(options.adminKey),
            masked: options.adminKey ? options.adminKey.slice(0, 4) + '…' + options.adminKey.slice(-4) : '',
            editable: labelScope !== null,
          })
        }
        if (u.pathname === '/api/admin-key' && req.method === 'POST') {
          const body = await readBody(req)
          if (body === null || typeof body.adminKey !== 'string') {
            return sendJson(res, 400, { ok: false, error: 'adminKey required' })
          }
          if (labelScope === null) {
            return sendJson(res, 503, { ok: false, error: 'settings service unavailable (dsh too old); set via DSH_MOBILE_ADMIN_KEY env' })
          }
          const next = sanitizeAdminKey(body.adminKey)
          if (next.length !== 0 && next.length < 16) {
            return sendJson(res, 400, { ok: false, error: 'adminKey 至少 16 字符(openssl rand -hex 32)' })
          }
          try {
            await labelScope.update({ adminKey: next })
          } catch (e) {
            return sendJson(res, 409, { ok: false, error: String(e && e.message ? e.message : e) })
          }
          return sendJson(res, 200, { ok: true, configured: next.length > 0 })
        }
        if (u.pathname === '/api/tunnel' && req.method === 'GET') {
          // 两通道并存都上报;mode 字段 = 当前配对形态对应的那条(兼容旧页面)。
          const cf = cfTunnel !== null ? cfTunnel.state() : null
          const rust = tunnel !== null ? tunnel.state() : null
          const active = pairViaCf(options) ? cf : rust
          return sendJson(res, 200, {
            ...(active ?? { mode: 'none', up: false }),
            via: pairViaCf(options) ? 'cf' : 'rust',
            cf, rust,
          })
        }
        // 配对形态自述(徽标卡数据源;全部非敏感 —— 无密钥值,只有掩码状态)。
        if (u.pathname === '/api/mode' && req.method === 'GET') {
          return sendJson(res, 200, {
            ok: true,
            via: pairViaCf(options) ? 'cf' : 'rust',
            // 双发实际参与的传输(双网关并存;锚定形态仅决定 QR 去处与展示)。
            transports: pair.transports(),
            publicUrl: options.publicUrl,
            gateway: options.gateway,
            keyConfigured: Boolean(options.adminKey),
            needsKey: cfNeedsKey(options),
            target: options.target,
            adminPort: options.adminPort,
            remotePort: options.remotePort,
            cfHostname: options.cfHostname,
          })
        }
        if (u.pathname === '/api/start' && req.method === 'POST') {
          return sendJson(res, 200, await pair.start())
        }
        if (u.pathname === '/api/claim' && req.method === 'POST') {
          const body = await readBody(req)
          if (body === null || typeof body.code !== 'string') {
            return sendJson(res, 400, { error: 'code required' })
          }
          return sendJson(res, 200, await pair.startManual(body.code))
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
    if (tunnel !== null) tunnel.stop()
    if (cfTunnel !== null) cfTunnel.stop()
    pair.stop()
    for (const dispose of disposers) {
      try { dispose() } catch {}
    }
  })
}
