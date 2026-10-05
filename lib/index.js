// dsh-mobile — Mac 侧移动接入(dsh 插件,CF Worker 网关 + relay 中转,唯一数据链路)。
//
// 架构:网关(Cloudflare Worker,dsh-gateway-worker)做配对 + 中转数据面
// (relay;无 ssh -R / 无 cloudflared / 无 Rust 服务器)。vstream 帧经网关
// WS 逐帧透传,扫码配对的设备启用端到端加密(PSK 走 QR 带外,网关只见
// 密文,见 PROTOCOL.md §5)。Mac 侧落地回 127.0.0.1:<dsh web 端口>;手机
// App 侧同样起本地回环代理 —— 两端的 HTTP/WebSocket 栈零改动。
// (P2P DataChannel 信令面 2026-09-23 拆除:App 自 2026-09-10 起只用中转。)
//
//   手机 App ──wss(vstream 帧中转,E2E 加密)──→ CF Worker 网关 ←─wss─ 本插件
import { spawn } from 'node:child_process'
import { randomInt } from 'node:crypto'
import net from 'node:net'
import { hostname } from 'node:os'

import z from '@deepseek-ai/schemastery'

import { createPskStore } from './psk-store.js'
import { deriveKeys, genPsk, open as envOpen, seal } from './relay-crypto.js'

export const name = 'dsh-mobile'
export const inject = ['webServer']

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // 与网关一致(去 I/L/O/0/1)

const genCode = (n) => {
  let out = ''
  for (let i = 0; i < n; i += 1) out += CODE_CHARS[randomInt(CODE_CHARS.length)]
  return out
}

const tryJson = (s) => {
  try { return JSON.parse(s) } catch { return null }
}

// ── 安全事件 OS 通知(审计缓解,与历版同款)────────────────────────────────
// 配对完成/令牌吊销是「本地 foothold 远程化」的关键动作;本地管理 API 的
// 三重门只防浏览器,防不了同用户进程 —— 无法进程内鉴权,只能显性化:
// OS 通知即时提醒 + 面板横幅/侧栏角标持久标记(/api/security-log)。
const asq = (s) => String(s ?? '').replace(/[\\"]/g, "'")

const notifyUser = (title, body) => {
  try {
    let cmd = null
    let args = null
    if (process.platform === 'darwin') {
      cmd = '/usr/bin/osascript'
      args = ['-e', 'display notification "' + asq(body) + '" with title "' + asq(title) + '" sound name "default"']
    } else if (process.platform === 'linux') {
      cmd = 'notify-send'
      args = ['-a', 'dsh', String(title), String(body)]
    }
    if (cmd === null) return
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
  } catch {}
}

// ── 清洗/校验 ────────────────────────────────────────────────────────────
// settings 命名空间:旧宿主(≤0.1.6)走 settings.register scope API;上游
// 0.1.7-alpha.2 起该 API 被整体移除(dsh-settings-file 包删除),见下方
// Config 注释。
const LABEL_NS = 'dsh-mobile'

/** volatile 字段读取:0.1.7 起宿主把 config 字段解析成稳定引用(.get()),
 * 旧宿主/裸值为纯字符串;两态归一。 */
const readVolatile = (v) =>
  (v !== null && typeof v === 'object' && typeof v.get === 'function' ? v.get() : v)

const sanitizeLabel = (raw) => {
  const s = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return [...s].slice(0, 32).join('')
}
const shortHostname = () => hostname().split('.')[0].slice(0, 32)
const sanitizePairUrl = (raw) => String(raw ?? '').trim().split('#')[0]
const isValidPairUrl = (raw) => {
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}

/** 宿主路由键缺省值:<短主机名 slug>.host(与网关 validHostname 对齐:须含点)。 */
const defaultHostKey = () =>
  shortHostname().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) + '.host'

// adminKey 字段沿用中转时代 webui「管理密钥」栏的存储位(用户层持久化,
// 见 8176227)—— 老用户升级到 P2P 版后已保存的密钥自动生效,迁移不断裂。
// 优先级:env DSH_MOBILE_ADMIN_KEY > settings(面板可改可清)> 组合 config
// (明文模板位,最不推荐 —— profile yml 常随 dotfiles 同步外泄)。
const SettingsSchema = z.object({
  label: z.string().required(false),
  adminKey: z.string().required(false),
})

/** 可选 volatile 字符串:schemastery ≥3.18.3 有 .volatile(),旧版降级。 */
const volatileString = () => {
  const s = z.string().required(false)
  return typeof s.volatile === 'function' ? s.volatile() : s
}

// 上游 0.1.7-alpha.2 起 settings.register(ns, schema, {base}) scope API 被
// 整体移除(packages/settings/settings-file 删除,SettingsForms 重写):用户
// 可改字段改为插件 Config 的 volatile 投影,持久化经 settings.update(
// entryId, patch) 写进 profile 合并块,值变更经 'loader/volatile-update'
// 事件热更新到 config 引用。导出 Config 让新宿主把本插件收进 settings
// 表单(label/adminKey 标 volatile);旧宿主继续走上面的 register 兼容腿。
export const Config = z.object({
  pagePath: z.string().required(false),
  gateway: z.string().required(false),
  // adminKey:volatile —— profile 覆盖层即旧「settings 层」,优先级见下。
  // volatile() 需 schemastery ≥3.18.3;缺方法时降级为普通字段(旧宿主
  // 走 register 腿,不依赖 volatile)。
  adminKey: volatileString(z),
  host: z.string().required(false),
  publicUrl: z.string().required(false),
  iceServers: z.any().required(false),
  label: volatileString(z),
})

/** 管理密钥清洗:仅去首尾空白(与旧版一致)。 */
const sanitizeAdminKey = (raw) => String(raw ?? '').trim()

// ── 配对会话(语义不变;claim 的 tunnel_host 现在只是宿主路由键)──────────
const PAIRING_WINDOW_MS = 5.5 * 60 * 1000

function createPairService({ getConfig, getLabel, onEvent, emit, psks }) {
  /** 管理面直连(Bearer adminKey 经公网 HTTPS;失败/非 JSON 统一 null)。 */
  const admin = async (path, method, payload) => {
    const { gateway, adminKey } = getConfig()
    if (!gateway || !adminKey) return null
    try {
      const resp = await fetch(gateway + path, {
        method,
        signal: AbortSignal.timeout(10000),
        headers: {
          authorization: 'Bearer ' + adminKey,
          ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
          // 同 ticket 通道:dsh 0.1.7 http-proxy dispatcher 不解压,禁压缩。
          'accept-encoding': 'identity',
        },
        body: payload !== undefined ? JSON.stringify(payload) : undefined,
      })
      if (!resp.ok) {
        emit('warning', '管理面 ' + method + ' ' + path + ' → HTTP ' + resp.status
          + ' (gw=' + gateway + ', key=' + adminKey.slice(0, 8) + '…len=' + adminKey.length + ')')
      }
      return tryJson(await resp.text())
    } catch (e) {
      // 真机排障(2026-08-30):不可达时必须看到根因(超时/DNS/TLS/拒绝),
      // 否则只剩「检查密钥/网络」一句没法定位。
      emit('warning', '管理面 ' + method + ' ' + path + ' 异常: '
        + String(e && e.message ? e.message : e)
        + (e && e.cause ? ' | cause: ' + String(e.cause.message ?? e.cause) : ''))
      return null
    }
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
      publicUrl: sanitizePairUrl(getConfig().publicUrl),
      qr: session.qr,
      mode: session.mode,
      expiresAt: session.expiresAt,
      startedAt: session.startedAt,
      state: session.state,
      device: session.device ?? null,
      error: session.error ?? null,
      // 本轮配对是否携带端到端加密 PSK(扫码 = 有;手输 = 无,中转明文)
      enc: Boolean(session.psk),
    }
  }

  const schedule = (myGen, ms) => {
    if (myGen !== generation || session === null) return
    session.timer = setTimeout(() => tick(myGen), ms)
  }

  const unreachable = () => {
    const { gateway, adminKey } = getConfig()
    if (!gateway) return '未配置 gateway(Worker 地址,如 https://dsh.example.com)'
    return 'CF 网关 ' + gateway + (adminKey ? '' : '(缺 adminKey)') + ' 不可达(检查密钥/网络)'
  }

  const tick = async (myGen) => {
    while (myGen === generation && session !== null) {
      if (Date.now() - session.startedAt > PAIRING_WINDOW_MS) {
        session.state = 'timeout'
        return
      }
      if (session.state === 'waiting') {
        const j = await admin('/admin/pair/claim', 'POST', {
          code: session.code, host_code: session.hostCode,
          host_label: session.label, tunnel_host: getConfig().host,
        })
        if (j !== null && j.claim_id) session.state = 'claimed'
        else if (j === null) {
          session.state = 'error'
          session.error = unreachable()
        }
      } else if (session.state === 'claimed') {
        const j = await admin('/admin/pair/status?code=' + session.code, 'GET')
        if (j && j.status === 'confirmed') {
          session.state = 'confirmed'
          session.device = (j.token && j.token.device) || null
          // 扫码配对携带的 PSK 在成交时落库(此后手机侧中转可端到端加密)。
          if (session.psk && psks) psks.add(session.psk, session.device)
          // 安全事件:配对成交 = 远程访问能力签发,无论会话由谁发起都通告。
          if (onEvent) onEvent('paired', '设备「' + (session.device ?? '?') + '」'
            + (session.psk ? '(端到端加密已启用)' : '(手输配对,中转明文)'))
          return
        }
        if (j && j.status === 'expired') {
          session.state = 'expired'
          return
        }
      } else {
        return
      }
      schedule(myGen, 3000)
      return
    }
  }

  return {
    snapshot,
    start: async () => {
      generation += 1
      const myGen = generation
      clearTimer()
      const config = getConfig()
      const code = genCode(10)
      const hostCode = genCode(6)
      // 端到端加密 PSK:仅经二维码 fragment 带外分发(不落网关/信令面)。
      // 手输配对(startManual)没有带外通道,不携带 → 中转降级明文(面板警示)。
      const psk = genPsk()
      const inviteUrl = sanitizePairUrl(config.publicUrl) + '#c=' + code + '&h=' + hostCode
        + '&l=' + encodeURIComponent(getLabel()) + '&k=' + psk
      session = {
        code, hostCode, label: getLabel(), qr: null, mode: 'scan',
        expiresAt: Date.now() + 10 * 60 * 1000, startedAt: Date.now(),
        state: 'waiting', device: null, error: null, timer: null,
        psk,
      }
      if (!config.gateway || !config.adminKey) {
        session.state = 'error'
        session.error = unreachable()
        return snapshot()
      }
      if (!isValidPairUrl(sanitizePairUrl(config.publicUrl))) {
        session.state = 'error'
        session.error = '配对入口 URL 无效(' + String(config.publicUrl) + ')—— 需如 https://dsh.example.com/pair'
        return snapshot()
      }
      const j = await admin('/admin/pair/qr', 'POST', { text: inviteUrl })
      if (j === null || typeof j.qr !== 'string' || j.qr.length === 0) {
        session.state = 'error'
        session.error = '二维码获取失败:' + unreachable()
        return snapshot()
      }
      session.qr = j.qr.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PRZcf-nqry=><]/g, '') // 剥 ANSI(网关发 ESC 序列),浏览器纯文本渲染
      session.timer = setTimeout(() => tick(myGen), 300)
      return snapshot()
    },
    startManual: async (codeRaw) => {
      const code = String(codeRaw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
      if (code.length !== 10) {
        return { state: 'error', mode: 'manual', error: '配对码应为 10 位字母数字(如 ABCDE-FGHJK)' }
      }
      const config = getConfig()
      if (!config.gateway || !config.adminKey) {
        return { state: 'error', mode: 'manual', error: unreachable() }
      }
      generation += 1
      const myGen = generation
      clearTimer()
      session = {
        code, hostCode: genCode(6), label: getLabel(), qr: null, mode: 'manual',
        expiresAt: Date.now() + 10 * 60 * 1000, startedAt: Date.now(),
        state: 'waiting', device: null, error: null, timer: null,
        psk: null, // 手输配对无带外通道:该设备中转保持明文(警示)
      }
      const j = await admin('/admin/pair/claim', 'POST', {
        code, host_code: session.hostCode, host_label: session.label, tunnel_host: config.host,
      })
      if (j !== null && j.claim_id) {
        session.state = 'claimed'
        session.device = j.device ?? null
        schedule(myGen, 3000)
      } else {
        session.state = 'error'
        session.error = j !== null && typeof j.error === 'string'
          ? '网关拒绝:' + j.error + ' —— 确认手机在等且码未过期'
          : unreachable()
      }
      return snapshot()
    },
    stop: () => {
      generation += 1
      clearTimer()
      session = null
    },
    tokens: async () => {
      const j = await admin('/admin/pair/tokens', 'GET')
      if (!Array.isArray(j)) return null
      // 只展示绑定本机路由键的令牌(多宿主网关;按 tunnel_host 归属过滤)。
      return j.filter((t) => String(t.tunnel_host ?? '') === String(getConfig().host ?? ''))
    },
    revoke: async (jti) => {
      const j = await admin('/admin/pair/revoke-token', 'POST', { jti: String(jti) })
      if (j !== null && j.revoked === true) return { revoked: true }
      return j !== null ? { revoked: false } : { revoked: false, error: '网关管理面不可达' }
    },
  }
}

// ── vstream 泵(模块级,中转 WS 用)──────────────────────────────────────
// 帧格式(vstream,与手机端逐字节一致,见 PROTOCOL.md):
//   magic u8 = 0xD5 / sid u32 BE / cmd u8(1=OPEN 2=DATA 3=CLOSE 4=PING)/ len u32 BE / payload
// 帧头 10 字节:magic(1)+sid(4)+cmd(1)+len(4);payload 从偏移 10 起。
// sendFrame 由调用方注入(中转 WS 的 send),泵体对载体无感知。
const VS_MAGIC = 0xd5
const VS_OPEN = 1
const VS_DATA = 2
const VS_CLOSE = 3
const VS_CHUNK = 16 * 1024

// ── vstream 泵(模块级,信令/中转两服务共用)────────────────────────────
// 帧头 10 字节:magic(1)+sid(4)+cmd(1)+len(4);payload 从偏移 10 起。
// sendFrame 由调用方注入(DataChannel 的 sendMessageBinary / 中转 WS 的
// send),泵体对载体无感知;二者消息边界同构(每消息恰一帧)。
const vsFrame = (sid, cmd, payload) => {
  const head = Buffer.alloc(10)
  head.writeUInt8(VS_MAGIC, 0)
  head.writeUInt32BE(sid, 1)
  head.writeUInt8(cmd, 5)
  head.writeUInt32BE(payload.length, 6)
  return Buffer.concat([head, payload])
}

// 一条 vstream ↔ TCP(127.0.0.1:localPort,dsh web 运行端口)。
// 泵体必须收口:载体关闭(native 通道/WS)后 TCP data 仍到达,close 后
// send 同步 throw —— 不兜就是 uncaught exception 崩掉整个 dsh 宿主
// (「泵崩宿主」审计残留点)。兜底 = 断 TCP;close 钩子照常摘流
// (streams.delete)并发 CLOSE 帧。
const vsAttachStream = (sess, sid, sendFrame, localPort, emit) => {
  const sock = net.connect(localPort, '127.0.0.1')
  sess.streams.set(sid, sock)
  let pending = Buffer.alloc(0)
  const parse = () => {
    for (;;) {
      if (pending.length < 10) return
      if (pending[0] !== VS_MAGIC) {
        emit('warning', 'vstream 帧 magic 错误,丢弃该流(sid=' + sid + ')')
        sock.destroy()
        return
      }
      const fsid = pending.readUInt32BE(1)
      const cmd = pending.readUInt8(5)
      const len = pending.readUInt32BE(6)
      if (pending.length < 10 + len) return
      const payload = pending.subarray(10, 10 + len)
      pending = pending.subarray(10 + len)
      if (fsid !== sid) continue // 不可能(每流一帧);防御
      if (cmd === VS_DATA) {
        if (!sock.write(payload)) {
          sock.pause()
          sock.once('drain', () => sock.resume())
        }
      } else if (cmd === VS_CLOSE) {
        sock.end()
        return
      } else if (cmd === VS_OPEN || cmd === 4 /* PING */) {
        // OPEN 已处理;PING 忽略
      }
    }
  }
  sock.on('data', (chunk) => {
    // TCP → 发送面:16KB 分片(DataChannel 时代为 SCTP 消息舒适区间;
    // 中转 WS 沿用同限,网关逐帧透传不重组)。
    for (let off = 0; off < chunk.length; off += VS_CHUNK) {
      try {
        sendFrame(vsFrame(sid, VS_DATA, chunk.subarray(off, off + VS_CHUNK)))
      } catch {
        try { sock.destroy() } catch {}
        return
      }
    }
  })
  sock.on('close', () => {
    sess.streams.delete(sid)
    try { sendFrame(vsFrame(sid, VS_CLOSE, Buffer.alloc(0))) } catch {}
  })
  sock.on('error', () => { try { sock.destroy() } catch {} })
  return {
    feed: (chunk) => { pending = Buffer.concat([pending, chunk]); parse() },
    closed: () => { sock.destroy() },
  }
}

// 单帧分发:OPEN 连 TCP / DATA 喂流 / CLOSE 断流;畸形帧静默丢弃。
const vsDispatchFrame = (sess, sendFrame, buf, localPort, emit) => {
  if (buf.length < 10 || buf[0] !== VS_MAGIC) return
  const vsid = buf.readUInt32BE(1)
  const cmd = buf.readUInt8(5)
  const len = buf.readUInt32BE(6)
  if (buf.length < 10 + len) return
  if (cmd === VS_OPEN) {
    if (sess.feeds.has(vsid)) return // 重复 OPEN:忽略,防重复连 TCP
    const feed = vsAttachStream(sess, vsid, sendFrame, localPort, emit)
    sess.feeds.set(vsid, feed)
  } else if (cmd === VS_DATA) {
    sess.feeds.get(vsid)?.feed(buf.subarray(0, 10 + len))
  } else if (cmd === VS_CLOSE) {
    sess.feeds.get(vsid)?.closed()
    sess.feeds.delete(vsid)
  } // PING 忽略
}

// host ticket 管理器(信令/中转两服务共用):管理面签发,TTL 900s,每
// 5min 刷新。
// 刷新失败告警限频 5min:connect() 退避重试期间每轮都会调到这里,
// 不限频会持续刷屏;刷新成功即重置,下次真故障第一时间可见。
const createTicketManager = ({ getConfig, emit }) => {
  let ticket = ''
  let ticketExp = 0
  let timer = null
  let stopped = false
  let ticketWarnAt = 0
  const TICKET_WARN_THROTTLE_MS = 5 * 60 * 1000
  const refresh = async () => {
    if (stopped) return
    const { gateway, adminKey, host } = getConfig()
    if (!gateway || !adminKey) return
    try {
      const resp = await fetch(gateway + '/admin/signal/ticket', {
        method: 'POST',
        signal: AbortSignal.timeout(10000),
        headers: {
          authorization: 'Bearer ' + adminKey,
          'content-type': 'application/json',
          // dsh 0.1.7 的 http-proxy dispatcher 层不解压响应体(裸 undici 正常),
          // 禁压缩拿 identity 原文,否则 tryJson 吃到 gzip 乱码永远失败。
          'accept-encoding': 'identity',
        },
        body: JSON.stringify({ host }),
      })
      const raw = await resp.text()
      const j = tryJson(raw)
      if (j !== null && typeof j.ticket === 'string' && j.ticket.length > 0) {
        ticket = j.ticket
        ticketExp = Number(j.expires_at) * 1000
        ticketWarnAt = 0
        return
      }
      // 诊断:网关返回了非 ticket 响应(如 CF challenge HTML),状态码+响应体片段暴露出来
      emit('warning', 'ticket 响应异常: status=' + resp.status + ' body=' + raw.slice(0, 120).replace(/\s+/g, ' '))
    } catch (e) {
      // 诊断:网络/超时/TLS 层错误不再静默
      emit('warning', 'ticket 请求失败: ' + (e?.message ?? String(e)) + (e?.cause?.message ? ' | cause: ' + e.cause.message : ''))
    }
    if (ticketExp < Date.now() + 60_000 && Date.now() - ticketWarnAt > TICKET_WARN_THROTTLE_MS) {
      ticketWarnAt = Date.now()
      emit('warning', 'host ticket 刷新失败(' + String(gateway) + ');信令/中转通道将无法重连')
    }
  }
  // fresh():余量 >30s 的票据,否则 ''(调用方先 refresh 再取)。
  const fresh = () => (ticketExp > Date.now() + 30_000 ? ticket : '')
  const expiringSoon = () => ticketExp < Date.now() + 30_000
  const start = () => {
    void refresh()
    timer = setInterval(() => { void refresh() }, 5 * 60 * 1000)
  }
  const stop = () => {
    stopped = true
    if (timer !== null) clearInterval(timer)
  }
  return { refresh, fresh, expiringSoon, start, stop }
}


// ── 中转服务(2026-09-10 还原)────────────────────────────────────────────
// 数据面走网关 WS(P2P 在办公网/蜂窝不可用后的默认链路;信令面保留给
// P2P 备选)。两条腿:
//   控制腿 wss://gateway/relay/host?ticket=  常驻;收 relay-open{rsid}
//   数据腿 wss://gateway/relay/host?ticket=&rsid=  每对手机一条;ready 后
//   二进制消息 = vstream 帧(与 DataChannel 同构),dispatchFrame 共泵。
// 宿主侧全程被动:配对由手机发起(手机带 rsid 接入,网关才通知我们拨
// 数据腿);数据腿断 = 清会话流,手机重连拿新 rsid 自愈。
function createRelayService({ getConfig, emit, tickets, psks }) {
  let ctrl = null         // 控制腿 WebSocket
  let stopped = false
  let attempt = 0
  let reconnectTimer = null
  // 应用层活性 ping(handmux 借鉴):CF 空闲 WS ~126s 被掐 + NAT/蜂窝网关
  // 静默丢半开连接,平台 pong 不代表应用态连通。40s 周期 {"t":"ping"},
  // 10s 内无 pong 或 send 抛错 → 主动 close 走既有指数退避重建。仅控制腿
  // (常驻、低频);数据腿由业务流量天然保活。服务器 pong 走 DO 自动应答
  // (平台层,不唤醒 DO),宿主回的 pong 才是本守卫的判定对象。
  let ctrlPingTimer = null
  let ctrlPongTimer = null
  const ctrlPingStop = () => {
    if (ctrlPingTimer !== null) { clearInterval(ctrlPingTimer); ctrlPingTimer = null }
    if (ctrlPongTimer !== null) { clearTimeout(ctrlPongTimer); ctrlPongTimer = null }
  }
  const CTRL_PING_MS = 40000
  const CTRL_PONG_MS = 10000
  const pairs = new Map() // rsid → { ws, ready, streams, feeds, jti, device, crypto }

  const state = () => ({
    connected: ctrl !== null,
    pairs: [...pairs.values()].map((p) => ({
      rsid: p.rsid,
      ready: p.ready === true,
      enc: p.crypto?.state === 'on',
      streams: p.streams.size,
      device: p.device ?? '',
    })),
    // 当前中转在线设备(设备表链路标记数据源):ready 的配对。
    devices: [...pairs.values()]
      .filter((p) => p.ready === true)
      .map((p) => ({ jti: p.jti, device: p.device, streams: p.streams.size, enc: p.crypto?.state === 'on' })),
  })

  const relayUrl = (path) => {
    const u = new URL(getConfig().gateway)
    return (u.protocol === 'https:' ? 'wss://' : 'ws://') + u.host + path
  }

  const destroyPair = (sess) => {
    for (const feed of sess.feeds.values()) feed.closed()
    sess.feeds.clear()
    for (const s of sess.streams.values()) { try { s.destroy() } catch {} }
    sess.streams.clear()
  }

  // 数据腿:relay-open 到达即拨;ready 前的二进制帧丢弃(网关只在双方
  // 就绪后转发,迟到残帧无消费方)。
  // 加密:ready 后若本机存有 PSK(历史扫码配对),8s 内等手机 crypto
  // 握手;握手成功转入密文(见 lib/relay-crypto.js),超时保持明文 +
  // 警示(旧版 App/手输配对设备)。
  const openDataLeg = async (rsid, msg) => {
    if (stopped || typeof rsid !== 'string' || rsid.length === 0 || pairs.has(rsid)) return
    const sess = {
      rsid,
      ws: null,
      ready: false,
      streams: new Map(),
      feeds: new Map(),
      jti: String(msg.jti ?? ''),
      device: String(msg.device ?? ''),
      crypto: null, // { state:'on', tk, rk, tx, rx }
    }
    pairs.set(rsid, sess)
    let ticket = tickets.fresh()
    if (ticket === '') {
      await tickets.refresh()
      ticket = tickets.fresh()
    }
    if (stopped || ticket === '') {
      pairs.delete(rsid)
      emit('warning', '中转数据腿拨号失败(rsid=' + rsid.slice(0, 8) + '…):无有效 host ticket')
      return
    }
    let socket
    try {
      socket = new WebSocket(relayUrl('/relay/host') + '?ticket=' + encodeURIComponent(ticket)
        + '&rsid=' + encodeURIComponent(rsid))
    } catch (e) {
      pairs.delete(rsid)
      emit('warning', '中转数据腿创建失败(rsid=' + rsid.slice(0, 8) + '…):' + String(e && e.message ? e.message : e))
      return
    }
    sess.ws = socket
    // Node undici WebSocket 的二进制消息默认是 Blob(Buffer.from 直接炸,
    // e2e 实锤)—— 显式切 'arraybuffer',Buffer.from 才吃得下。
    socket.binaryType = 'arraybuffer'
    // 发送统一走这里:密文态逐帧封装(计数器单调),明文态原样。
    const sendFrame = (b) => {
      const out = sess.crypto?.state === 'on' ? seal(sess.crypto.tk, sess.crypto.tx++, b) : b
      try { socket.send(out) } catch { /* onclose 会清场 */ }
    }
    socket.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        const j = tryJson(ev.data)
        if (j === null) return
        if (j.t === 'ping') { try { socket.send('{"t":"pong"}') } catch {}; return }
        if (j.t === 'ready') {
          sess.ready = true
          emit('info', '中转通道就绪(rsid=' + rsid.slice(0, 8) + '…)设备 ' + (sess.device || '?'))
          // 加密握手窗口:本机有 PSK 才等;没有则无事可谈。
          if (psks && psks.count() > 0) {
            sess.cryptoTimer = setTimeout(() => {
              if (sess.crypto?.state !== 'on' && pairs.get(rsid) === sess) {
                emit('warning', '设备「' + (sess.device || '?') + '」中转未启用端到端加密'
                  + '(旧版 App 或手输配对)—— 业务字节明文经网关,建议重新扫码配对')
              }
            }, 8000)
          }
          return
        }
        if (j.t === 'crypto') {
          // 手机侧加密握手:按 kid 找 PSK → 派生方向子密钥 → crypto-ok。
          clearTimeout(sess.cryptoTimer)
          const entry = psks && typeof j.kid === 'string' ? psks.byKid(j.kid) : null
          if (!entry) {
            emit('warning', '设备「' + (sess.device || '?') + '」请求加密但无匹配 PSK(kid='
              + String(j.kid ?? '?') + ')—— 请重新扫码配对;本轮明文中转')
            try { socket.send('{"t":"crypto-na"}') } catch {}
            return
          }
          const keys = deriveKeys(entry.psk, rsid)
          sess.crypto = { state: 'on', tk: keys.h2c, rk: keys.c2h, tx: 0, rx: 0 }
          try { socket.send('{"t":"crypto-ok","v":1,"kid":"' + entry.kid + '"}') } catch {}
          emit('info', '端到端加密已启用(rsid=' + rsid.slice(0, 8) + '…)设备 ' + (sess.device || '?'))
          return
        }
        return
      }
      if (!sess.ready) return
      const buf = Buffer.isBuffer(ev.data) ? ev.data : Buffer.from(ev.data)
      if (sess.crypto?.state === 'on') {
        // 密文态:计数器严格连续 + AEAD 校验,任一失败 = 串音/篡改,断腿
        // 让手机重连重同步(新腿 = 新 rsid = 新子密钥)。
        try {
          const frame = envOpen(sess.crypto.rk, sess.crypto.rx++, buf)
          vsDispatchFrame(sess, sendFrame, frame, getConfig().localPort, emit)
        } catch (e) {
          emit('warning', '中转密文帧解密失败(' + String(e && e.message ? e.message : e)
            + ')—— 断腿重连;若反复出现请重新扫码配对')
          try { socket.close(1011, 'crypto frame rejected') } catch {}
        }
        return
      }
      vsDispatchFrame(sess, sendFrame, buf, getConfig().localPort, emit)
    }
    socket.onclose = () => {
      clearTimeout(sess.cryptoTimer)
      if (pairs.get(rsid) === sess) pairs.delete(rsid)
      destroyPair(sess)
    }
    socket.onerror = () => { /* onclose 会跟 */ }
  }

  // ── 控制腿 WS 生命周期(信令腿同款骨架:票据门 + 指数退避) ──────────
  const connectCtrl = () => {
    if (stopped) return
    if (typeof WebSocket !== 'function') {
      emit('warning', '运行时无全局 WebSocket(需 Node 22+)—— 中转通道不可用')
      return
    }
    if (tickets.expiringSoon()) {
      void tickets.refresh().then(() => {
        if (stopped) return
        clearTimeout(reconnectTimer)
        if (!tickets.expiringSoon()) {
          reconnectTimer = setTimeout(connectCtrl, 500)
        } else {
          const delay = Math.min(1000 * 2 ** Math.min(attempt, 5), 30000)
          attempt += 1
          reconnectTimer = setTimeout(connectCtrl, delay)
        }
      })
      return
    }
    let socket
    try {
      socket = new WebSocket(relayUrl('/relay/host') + '?ticket=' + encodeURIComponent(tickets.fresh()))
    } catch (e) {
      emit('warning', '中转控制腿创建失败:' + String(e && e.message ? e.message : e))
      scheduleReconnect()
      return
    }
    ctrl = socket
    socket.onopen = () => {
      attempt = 0
      ctrlPingStop()
      emit('info', '中转控制腿已连接(' + new URL(relayUrl('/relay/host')).host + ';待手机接入)')
      // 活性守卫:每 40s ping,10s 无 pong 判死(见 ctrlPingTimer 声明处)。
      ctrlPingTimer = setInterval(() => {
        if (socket.readyState !== 1) return
        try {
          socket.send('{"t":"ping"}')
          if (ctrlPongTimer !== null) clearTimeout(ctrlPongTimer)
          ctrlPongTimer = setTimeout(() => {
            emit('warning', '中转控制腿 ping 超时(10s 无 pong)—— 主动重连')
            try { socket.close(4000, 'pong timeout') } catch {}
          }, CTRL_PONG_MS)
        } catch { /* send 失败 = 连接已死,onclose 会跟 */ }
      }, CTRL_PING_MS)
      ctrlPingTimer.unref?.()
    }
    socket.onmessage = (ev) => {
      const j = typeof ev.data === 'string' ? tryJson(ev.data) : null
      if (j === null) return
      const t = j.t
      if (t === 'ping') { try { socket.send('{"t":"pong"}') } catch {}; return }
      if (t === 'pong' && ctrlPongTimer !== null) {
        clearTimeout(ctrlPongTimer)
        ctrlPongTimer = null
        return
      }
      if (t === 'relay-open') { void openDataLeg(String(j.rsid ?? ''), j); return }
    }
    socket.onclose = () => {
      ctrlPingStop()
      if (ctrl === socket) { ctrl = null; scheduleReconnect() }
    }
    socket.onerror = () => { /* onclose 会跟 */ }
  }

  const scheduleReconnect = () => {
    if (stopped) return
    const delay = Math.min(1000 * 2 ** Math.min(attempt, 5), 30000)
    attempt += 1
    reconnectTimer = setTimeout(connectCtrl, delay)
  }

  const start = () => {
    connectCtrl()
  }

  const stop = () => {
    stopped = true
    ctrlPingStop()
    if (reconnectTimer !== null) clearTimeout(reconnectTimer)
    for (const sess of pairs.values()) {
      destroyPair(sess)
      if (sess.ws !== null) { try { sess.ws.close() } catch {} }
    }
    pairs.clear()
    if (ctrl !== null) {
      try { ctrl.close() } catch {}
      ctrl = null
    }
  }

  return { start, stop, state }
}

// ── loopback 判定 + 同源门(管理 API 三重门,与历版一致)──────────────────

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

const sameOriginGate = (req) => {
  const sfs = req.headers['sec-fetch-site']
  if (sfs !== undefined && sfs !== 'same-origin' && sfs !== 'none') return false
  const origin = req.headers.origin
  if (origin !== undefined) {
    try { return isLoopbackAuthority(new URL(origin).host) } catch { return false }
  }
  return true
}

// ── 插件入口 ───────────────────────────────────────────────────────────────

export function apply(ctx, config = {}) {
  const ws = ctx.get('webServer')
  if (ws === undefined) return

  const options = {
    pagePath: config?.pagePath ?? '/pair',
  }

  const emit = (level, message) => {
    const logger = ctx.logger
    const line = 'dsh-mobile: ' + message
    if (logger && typeof logger[level] === 'function') logger[level](line)
    else console[level === 'warning' ? 'warn' : 'log']('[' + line + ']')
  }

  // 组合 config(cordis.patch.yml)+ env → 运行时配置(含 localPort 注入)。
  // CF Worker 网关形态:gateway+adminKey 为管理通道(公网 HTTPS+Bearer,
  // 信任根 = 密钥);host 为宿主路由键(仅登记用,无隧道语义)。
  const gatewayRaw = String(process.env.DSH_MOBILE_GATEWAY ?? config?.gateway ?? '').replace(/\/+$/, '')
  const envAdminKey = String(process.env.DSH_MOBILE_ADMIN_KEY ?? '').trim()
  const configAdminKey = sanitizeAdminKey(readVolatile(config?.adminKey))
  // settings 注入后动态更新(优先级见 SettingsSchema 注释)。
  let settingsAdminKey = ''
  const runtime = {
    gateway: gatewayRaw,
    host: String(process.env.DSH_MOBILE_HOST ?? config?.host ?? '').trim().toLowerCase() || defaultHostKey(),
    publicUrl: sanitizePairUrl(process.env.DSH_MOBILE_PUBLIC_URL ?? config?.publicUrl ?? (gatewayRaw ? gatewayRaw + '/pair' : '')),
    // iceServers 随 P2P 信令面拆除而废弃;网关 /signal/caps 的 ICE 下发同废。
    // 字段保留读取兼容旧 profile/env,不再参与任何运行时行为。
    localPort: ws.port,
  }
  // 配置缺失不再 throw(2026-08-29 审计:throw 使插件整体加载失败,连
  // 「修配置」的面板都没了,老用户升级即全损)—— 降级为告警,配对/信令
  // 各处的运行时错误文案已覆盖修复指引。
  if (!isValidPairUrl(runtime.gateway)) {
    emit('warning', 'gateway 无效(需如 https://dsh.example.com,指向 CF Worker 网关)—— 配对与信令不可用;检查 DSH_MOBILE_GATEWAY / cordis.patch.yml')
  }

  let settingsApi = null // { editable, update(patch) } —— 新旧宿主共用写面
  let label = sanitizeLabel(process.env.DSH_MOBILE_LABEL ?? readVolatile(config?.label)) || shortHostname()
  // 先于 ctx.inject 定义:settings 回调里要用(防框架同步调起时的 TDZ)。
  const getConfig = () => ({
    ...runtime,
    adminKey: envAdminKey || settingsAdminKey || sanitizeAdminKey(readVolatile(config?.adminKey)),
  })
  ctx.inject(['settings'], (sctx) => {
    const svc = sctx.settings
    const warnIfNoKey = () => {
      // adminKey 检查放 settings 装载后:旧版 webui 保存过的密钥此时才可见。
      if (getConfig().adminKey.length < 16) {
        emit('warning', 'adminKey 缺失或过短(<16 字符)—— 配对与信令不可用;env DSH_MOBILE_ADMIN_KEY 或面板「管理密钥」栏配置(旧版保存过的自动沿用)')
      }
    }
    if (svc !== null && typeof svc.register === 'function') {
      // 旧宿主(≤0.1.6):settings.register(ns, schema, {base}) scope API。
      const scope = svc.register(LABEL_NS, SettingsSchema, { base: { label } })
      const applySettings = (next) => {
        label = sanitizeLabel(next.label) || shortHostname()
        settingsAdminKey = sanitizeAdminKey(next.adminKey)
      }
      applySettings(scope.get())
      warnIfNoKey()
      sctx.effect(() => scope.watch(applySettings))
      settingsApi = { editable: true, update: (patch) => scope.update(patch) }
      return
    }
    // 新宿主(≥0.1.7):Config volatile 投影。profile 覆盖层(旧「settings
    // 层」)已被 cordis 归并进 config 引用,这里镜像 label 并监听热更新;
    // 写面走 settings.update(entryId, patch),entryId = profile 条目 id。
    const entryId = (sctx.fiber?.entry ?? ctx.fiber?.entry)?.options?.id
    const envLabel = process.env.DSH_MOBILE_LABEL ?? ''
    const applyVolatile = () => {
      // 新宿主腿不走 settingsAdminKey 镜像:profile 覆盖层已归并进 config
      // 引用,这里清零让 getConfig 直接读 volatile(POST 后的即时镜像由
      // handler 补,下一次 volatile-update 归位)。
      settingsAdminKey = ''
      label = sanitizeLabel(envLabel || readVolatile(config?.label)) || shortHostname()
    }
    applyVolatile()
    warnIfNoKey()
    sctx.on('loader/volatile-update', applyVolatile)
    settingsApi = {
      editable: entryId !== undefined,
      update: async (patch) => {
        if (entryId === undefined) throw new Error('no profile entry for dsh-mobile')
        await svc.update(entryId, patch)
        applyVolatile()
      },
    }
  })
  const getLabel = () => label

  // ── 安全事件日志(内存态,随 dsh 重启清零;目标是显性化非审计留痕)──────
  const SEC_MAX = 50
  const securityLog = []
  let securitySeq = 0
  const recordSecurityEvent = (kind, detail) => {
    securityLog.push({ id: (securitySeq += 1), kind, detail: String(detail ?? ''), at: Date.now(), acked: false })
    if (securityLog.length > SEC_MAX) securityLog.shift()
    const text = kind === 'paired' ? '新设备完成配对' : '设备令牌被吊销'
    emit('info', '安全事件:' + text + ' · ' + String(detail ?? ''))
    notifyUser('DSH 移动接入(dsh-mobile)', text + ':' + String(detail ?? '') + ' — 若非你本人操作,请打开「移动接入」面板处理')
  }

  const psks = createPskStore({ emit })
  const pair = createPairService({ getConfig, getLabel, onEvent: recordSecurityEvent, emit, psks })
  // 票据管理器(中转控制腿/数据腿共用,统一 5min 刷新);中转 = 唯一数据链路
  // (2026-09-23 拆除 P2P 信令/WebRTC 备选,App 端 2026-09-10 起已只用中转)。
  const tickets = createTicketManager({ getConfig, emit })
  const relay = createRelayService({ getConfig, emit, tickets, psks })
  relay.start()
  tickets.start()

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
      const prefix = options.pagePath.replace(/\/$/, '')
      let url = req.url ?? ''
      if (url.startsWith(prefix + '/')) url = url.slice(prefix.length)
      if (!url.startsWith('/api/')) {
        return sendJson(res, 404, { error: 'not found' })
      }
      // 管理 API:仅 loopback 页面可用 + 同源三重门(防跨源 CSRF)。
      if (!isLoopbackAuthority(req.headers.host)) {
        return sendJson(res, 403, { ok: false, error: 'management API is loopback-only' })
      }
      if (!sameOriginGate(req)) {
        return sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' })
      }
      if (req.method !== 'GET' && req.headers['x-dsh-mobile'] !== '1') {
        return sendJson(res, 403, { ok: false, error: 'write API requires dsh-mobile client header' })
      }
      const u = new URL(url, 'http://x')
      try {
        // 宿主自述:手机 App 经 P2P 通道连接就绪后 GET 此处,取机器名显示
        // 「已连接 xxx」。路径 /pair/api/host 由 App 硬编码,不可改。
        if (u.pathname === '/api/host' && req.method === 'GET') {
          return sendJson(res, 200, {
            ok: true,
            label,
            hostname: hostname(),
            mode: 'relay',
            host: runtime.host,
            // 本机已存的配对 PSK 数(>0 = 具备端到端加密能力)
            psks: psks.count(),
          })
        }
        // dsh 0.1.2-alpha 起 /api 全面前置 browser-session cookie 鉴权,原生
        // 客户端拿不到 cookie 即全 401。此处把宿主进程的 launch-token 根 URL
        // (ctx.connection.authenticatedUrl)交给 App:App 对**自己的 base**
        // (P2P 形态 = 本机代理端口)做 GET /?token=... 兑换 authority 绑定的
        // 签名 cookie —— cookie 的 authority 必须与后续 /api 请求的 Host 一致,
        // 所以 App 只取 token、不直接用此 URL 的 authority。
        if (u.pathname === '/api/auth-url' && req.method === 'GET') {
          let conn = null
          try { conn = ctx.get('connection') } catch { conn = null }
          const authenticatedUrl = conn && typeof conn.authenticatedUrl === 'function'
            ? conn.authenticatedUrl('http://127.0.0.1:' + String(runtime.localPort) + '/')
            : null
          if (typeof authenticatedUrl !== 'string' || authenticatedUrl.length === 0) {
            return sendJson(res, 503, { ok: false, error: 'connection service unavailable (dsh < 0.1.2-alpha has no browser auth)' })
          }
          return sendJson(res, 200, { ok: true, url: authenticatedUrl })
        }
        if (u.pathname === '/api/label' && req.method === 'GET') {
          return sendJson(res, 200, { ok: true, label, editable: settingsApi !== null && settingsApi.editable })
        }
        if (u.pathname === '/api/label' && req.method === 'POST') {
          const body = await readBody(req)
          if (body === null || typeof body.label !== 'string') {
            return sendJson(res, 400, { ok: false, error: 'label required' })
          }
          if (settingsApi === null) {
            return sendJson(res, 503, { ok: false, error: 'settings service unavailable' })
          }
          const next = sanitizeLabel(body.label)
          if (next.length === 0) {
            return sendJson(res, 400, { ok: false, error: 'label must be 1-32 chars' })
          }
          try {
            await settingsApi.update({ label: next })
          } catch (e) {
            return sendJson(res, 409, { ok: false, error: String(e && e.message ? e.message : e) })
          }
          return sendJson(res, 200, { ok: true, label })
        }
        // 管理密钥(用户层持久化;优先级 env > settings > 组合 config):
        // GET 只回掩码不回明文,POST 空串 = 清除回落 config/env。
        if (u.pathname === '/api/admin-key' && req.method === 'GET') {
          const key = getConfig().adminKey
          return sendJson(res, 200, {
            ok: true,
            configured: key.length >= 16,
            masked: key.length >= 16 ? key.slice(0, 4) + '…' + key.slice(-4) : '',
            fromEnv: envAdminKey.length >= 16,
            editable: settingsApi !== null && settingsApi.editable && envAdminKey.length < 16,
          })
        }
        if (u.pathname === '/api/admin-key' && req.method === 'POST') {
          const body = await readBody(req)
          if (body === null || typeof body.adminKey !== 'string') {
            return sendJson(res, 400, { ok: false, error: 'adminKey required' })
          }
          if (settingsApi === null || !settingsApi.editable) {
            return sendJson(res, 503, { ok: false, error: 'settings service unavailable (dsh too old); set via DSH_MOBILE_ADMIN_KEY env' })
          }
          if (envAdminKey.length >= 16) {
            return sendJson(res, 409, { ok: false, error: 'DSH_MOBILE_ADMIN_KEY env 已生效,面板值不参与;清掉 env 后再改' })
          }
          const next = sanitizeAdminKey(body.adminKey)
          if (next.length !== 0 && next.length < 16) {
            return sendJson(res, 400, { ok: false, error: 'adminKey 至少 16 字符(openssl rand -hex 32);留空保存 = 清除回落 config' })
          }
          try {
            await settingsApi.update({ adminKey: next })
          } catch (e) {
            return sendJson(res, 409, { ok: false, error: String(e && e.message ? e.message : e) })
          }
          // 旧宿主腿 watch 异步落变量,这里即时镜像;新宿主腿 update 内已
          // applyVolatile,再镜像一次保证 GET 立即可见(幂等)。
          settingsAdminKey = next
          return sendJson(res, 200, { ok: true, configured: next.length >= 16 })
        }
        // 移动接入状态(中转 = 唯一数据链路;signal 字段保留恒空形状以兼容
        // 旧面板/探针,拆除信令面后不再有真实状态)。
        if (u.pathname === '/api/state' && req.method === 'GET') {
          return sendJson(res, 200, {
            ok: true,
            mode: 'relay',
            relay: relay.state(),
            signal: { connected: false, ticketValid: false, sessions: [], devices: [] },
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
        if (u.pathname === '/api/pair-state' && req.method === 'GET') {
          const code = (u.searchParams.get('code') ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
          const s = pair.snapshot()
          if (s === null || s.code !== code) return sendJson(res, 404, { error: 'no such pairing' })
          return sendJson(res, 200, s)
        }
        if (u.pathname === '/api/tokens' && req.method === 'GET') {
          const list = await pair.tokens()
          if (list === null) return sendJson(res, 502, { error: 'gateway admin unreachable' })
          // 链路标注:relay = 本机活跃中转配对;connected 近似(5min 内有
          // 管理面活动)= 'relay';'' = 离线。(P2P 链路标注随信令面拆除)
          const relayJtis = new Set(relay.state().devices.map((d) => d.jti).filter(Boolean))
          for (const t of list) {
            t.link = relayJtis.has(t.jti)
              ? 'relay'
              : (t.connected ? 'relay' : '')
          }
          return sendJson(res, 200, list)
        }
        if (u.pathname === '/api/revoke' && req.method === 'POST') {
          const body = await readBody(req)
          if (body === null || typeof body.jti !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.jti)) {
            return sendJson(res, 400, { error: 'jti required([A-Za-z0-9_-])' })
          }
          const r = await pair.revoke(body.jti)
          // 安全事件:吊销成功必通告(已吊销令牌仍留在网关清单里,可反查设备名)。
          if (r !== null && r.revoked === true) {
            let who = body.jti
            try {
              const t = ((await pair.tokens()) ?? []).find((x) => x.jti === body.jti)
              if (t !== undefined && t.device) who = '设备「' + t.device + '」'
            } catch {}
            recordSecurityEvent('revoked', who)
          }
          return sendJson(res, 200, r)
        }
        // 安全事件日志(审计缓解):面板横幅/侧栏角标数据源;ack 消除未确认态。
        if (u.pathname === '/api/security-log' && req.method === 'GET') {
          return sendJson(res, 200, {
            ok: true,
            events: securityLog.slice(),
            unack: securityLog.filter((e) => !e.acked).length,
          })
        }
        if (u.pathname === '/api/security-log/ack' && req.method === 'POST') {
          for (const e of securityLog) e.acked = true
          return sendJson(res, 200, { ok: true })
        }
        return sendJson(res, 404, { error: 'not found' })
      } catch (e) {
        return sendJson(res, 500, { error: String(e && e.message ? e.message : e) })
      }
    },
  }
  const disposers = []
  disposers.push(ws.register(route))

  ctx.effect(() => () => {
    relay.stop()
    tickets.stop()
    pair.stop()
    for (const dispose of disposers) {
      try { dispose() } catch {}
    }
  })
}
