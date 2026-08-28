// dsh-mobile — Mac 侧移动接入(dsh 插件,CF Worker 网关 + P2P-only 版)。
//
// 架构:网关(Cloudflare Worker,dsh-gateway-worker)只做配对 + WebRTC
// 信令,**不中转任何业务流量** —— 无 ssh -R 隧道 / 无 cloudflared / 无
// Rust 服务器。手机与 Mac 经 WebRTC DataChannel(DTLS 加密)直连;
// DataChannel 上跑虚拟字节流(vstream,协议见 PROTOCOL.md),Mac 侧落地回
// 127.0.0.1:<dsh web 端口>。手机 App 侧同样起本地回环代理 —— 两端的
// HTTP/WebSocket 栈零改动。
//
//   手机 App ──wss(仅信令)──→ CF Worker 网关 ←─wss(仅信令)─ 本插件
//      └──────── WebRTC DataChannel(直连,业务流量不经网关)────────┘
//
// 信任根:管理面 = 网关 ADMIN_KEY(Bearer 经公网 HTTPS 调用,同构端点);
// host ticket 由管理面签发(TTL 900s,本插件每 5min 刷新);宿主路由键
// host(如 mac-01.p2p)只是网关登记标识,不再有任何隧道语义。
//
// 配置(cordis.patch.yml 的 dsh-mobile 行 config;DSH_MOBILE_* 可覆盖):
//   gateway(Worker 地址,如 https://dsh.pan2017.cn)
//   adminKey(管理密钥,≥16 字符)/ host(宿主路由键,缺省 <短主机名>.p2p)
//   publicUrl(扫码落地页,缺省 <gateway>/pair)/ label / iceServers
import { spawn } from 'node:child_process'
import { randomInt } from 'node:crypto'
import net from 'node:net'
import { hostname } from 'node:os'

import { PeerConnection as DcPeerConnection } from 'node-datachannel'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-mobile'
export const inject = ['webServer']

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // 与网关一致(去 I/L/O/0/1)
const DEFAULT_ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }]

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
const LABEL_NS = 'dsh-mobile'

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

/** 宿主路由键缺省值:<短主机名 slug>.p2p(与网关 validHostname 对齐:须含点)。 */
const defaultHostKey = () =>
  shortHostname().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) + '.p2p'

const SettingsSchema = z.object({
  label: z.string().required(false),
})

// ── 配对会话(语义不变;claim 的 tunnel_host 现在只是宿主路由键)──────────
const PAIRING_WINDOW_MS = 5.5 * 60 * 1000

function createPairService({ getConfig, getLabel, onEvent }) {
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
        },
        body: payload !== undefined ? JSON.stringify(payload) : undefined,
      })
      return tryJson(await resp.text())
    } catch {
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
          // 安全事件:配对成交 = 远程访问能力签发,无论会话由谁发起都通告。
          if (onEvent) onEvent('paired', '设备「' + (session.device ?? '?') + '」')
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
      const inviteUrl = sanitizePairUrl(config.publicUrl) + '#c=' + code + '&h=' + hostCode + '&l=' + encodeURIComponent(getLabel())
      session = {
        code, hostCode, label: getLabel(), qr: null, mode: 'scan',
        expiresAt: Date.now() + 10 * 60 * 1000, startedAt: Date.now(),
        state: 'waiting', device: null, error: null, timer: null,
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

// ── 信令客户端 + WebRTC offerer + vstream 落地 ───────────────────────────
// 帧格式(vstream,与手机端逐字节一致,见 PROTOCOL.md):
//   magic u8 = 0xD5 / sid u32 BE / cmd u8(1=OPEN 2=DATA 3=CLOSE 4=PING)/ len u32 BE / payload

// 标准 ICE 服务器({urls,...})→ libdatachannel 形({hostname,port,...})。
// node-datachannel 是 libdatachannel 原生 API(非 W3C polyfill),STUN/TURN
// 以 hostname+port 表达;TURN 另带 username/password/relayType。
const toLdcIce = (servers) => {
  const out = []
  for (const srv of servers ?? []) {
    const urls = Array.isArray(srv.urls) ? srv.urls : (srv.urls ? [srv.urls] : [])
    for (const raw of urls) {
      try {
        const u = new URL(raw.replace(/^(stun|turn|turns):/, 'http://'))
        if (raw.startsWith('stun:')) {
          out.push({ hostname: u.hostname, port: Number(u.port) || 3478 })
        } else {
          out.push({
            hostname: u.hostname,
            port: Number(u.port) || 3478,
            username: srv.username ?? '',
            password: srv.credential ?? '',
            relayType: 'turn',
          })
        }
      } catch {}
    }
  }
  return out
}

const VS_MAGIC = 0xd5
const VS_OPEN = 1
const VS_DATA = 2
const VS_CLOSE = 3
const VS_CHUNK = 16 * 1024

function createSignalService({ getConfig, emit }) {
  let ws = null            // 信令 WebSocket(全局 WebSocket,Node 22+)
  let ticket = ''          // host ticket JWT
  let ticketExp = 0
  let stopped = false
  let attempt = 0
  let reconnectTimer = null
  let ticketTimer = null
  const sessions = new Map() // sid → { pc, dc, dcOpen, streams, feeds, pcState, jti, device }

  const state = () => ({
    connected: ws !== null,
    ticketValid: ticketExp > Date.now() + 30_000,
    sessions: [...sessions.entries()].map(([sid, s]) => ({
      sid,
      open: s.dcOpen === true,
      streams: s.streams.size,
      state: s.pcState ?? 'new',
      device: s.device ?? '',
    })),
    // 当前 P2P 在线设备(设备表链路标记数据源):DataChannel 打开的会话。
    devices: [...sessions.values()]
      .filter((s) => s.dcOpen === true)
      .map((s) => ({ jti: s.jti, device: s.device, streams: s.streams.size })),
  })

  const signalUrl = () => {
    const u = new URL(getConfig().gateway)
    return (u.protocol === 'https:' ? 'wss://' : 'ws://') + u.host + '/signal/host'
  }

  const send = (obj) => {
    if (ws !== null) {
      try { ws.send(JSON.stringify(obj)) } catch {}
    }
  }

  // host ticket:管理面签发,TTL 900s,每 5min 刷新。
  // 刷新失败告警限频 5min:connect() 退避重试期间每轮都会调到这里,
  // 不限频会持续刷屏;刷新成功即重置,下次真故障第一时间可见。
  let ticketWarnAt = 0
  const TICKET_WARN_THROTTLE_MS = 5 * 60 * 1000
  const refreshTicket = async () => {
    if (stopped) return
    const { gateway, adminKey, host } = getConfig()
    if (!gateway || !adminKey) return
    try {
      const resp = await fetch(gateway + '/admin/signal/ticket', {
        method: 'POST',
        signal: AbortSignal.timeout(10000),
        headers: { authorization: 'Bearer ' + adminKey, 'content-type': 'application/json' },
        body: JSON.stringify({ host }),
      })
      const j = tryJson(await resp.text())
      if (j !== null && typeof j.ticket === 'string' && j.ticket.length > 0) {
        ticket = j.ticket
        ticketExp = Number(j.expires_at) * 1000
        ticketWarnAt = 0
        return
      }
    } catch {}
    if (ticketExp < Date.now() + 60_000 && Date.now() - ticketWarnAt > TICKET_WARN_THROTTLE_MS) {
      ticketWarnAt = Date.now()
      emit('warning', 'host ticket 刷新失败(' + String(gateway) + ');信令通道将无法重连')
    }
  }

  // ── vstream:DataChannel ↔ TCP(127.0.0.1:localPort) ───────────────────
  // 帧头 10 字节:magic(1)+sid(4)+cmd(1)+len(4);payload 从偏移 10 起。
  const frame = (sid, cmd, payload) => {
    const head = Buffer.alloc(10)
    head.writeUInt8(VS_MAGIC, 0)
    head.writeUInt32BE(sid, 1)
    head.writeUInt8(cmd, 5)
    head.writeUInt32BE(payload.length, 6)
    return Buffer.concat([head, payload])
  }

  const attachStream = (sess, sid, dc, localPort) => {
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
      // TCP → DC:分片发送,背压由 SCTP 缓冲吸收(16KB 对齐 SCTP 消息舒适区间)。
      for (let off = 0; off < chunk.length; off += VS_CHUNK) {
        dc.sendMessageBinary(frame(sid, VS_DATA, chunk.subarray(off, off + VS_CHUNK)))
      }
    })
    sock.on('close', () => {
      sess.streams.delete(sid)
      try { dc.sendMessageBinary(frame(sid, VS_CLOSE, Buffer.alloc(0))) } catch {}
    })
    sock.on('error', () => { try { sock.destroy() } catch {} })
    return {
      feed: (chunk) => { pending = Buffer.concat([pending, chunk]); parse() },
      closed: () => { sock.destroy() },
    }
  }

  // offer-req 处理:任何一步失败都必须收口(关 pc / 摘会话 / 告警),
  // 绝不让异常逃逸成 unhandled rejection 拖垮 dsh 进程。
  const startSession = async (msg) => {
    const sid = String(msg.sid ?? '')
    if (sid.length === 0) return
    const peer = { jti: String(msg.jti ?? ''), device: String(msg.device ?? '') }
    const { iceServers } = getConfig()
    const wsPort = getConfig().localPort // dsh web 运行时端口(apply 注入)
    const ice = toLdcIce(Array.isArray(iceServers) && iceServers.length > 0 ? iceServers : DEFAULT_ICE)
    let pc = null
    try {
      pc = new DcPeerConnection('dsh-mobile-' + sid.slice(0, 8), { iceServers: ice })
      const sess = { pc, dc: null, dcOpen: false, streams: new Map(), feeds: new Map(), pcState: 'connecting', ...peer }
      sessions.set(sid, sess)
      const dc = pc.createDataChannel('dsh', { ordered: true })
      sess.dc = dc
      dc.onOpen(() => {
        sess.dcOpen = true
        emit('info', 'P2P 通道就绪(sid=' + sid.slice(0, 8) + '…)设备 ' + String(msg.device ?? '?'))
      })
      dc.onMessage((data) => {
        // 二进制帧:每帧头部带 vstream sid(手机侧分配,从 1 递增)。
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
        if (buf.length < 10 || buf[0] !== VS_MAGIC) return
        const vsid = buf.readUInt32BE(1)
        const cmd = buf.readUInt8(5)
        const len = buf.readUInt32BE(6)
        if (buf.length < 10 + len) return
        const payload = buf.subarray(10, 10 + len)
        if (cmd === VS_OPEN) {
          if (sess.feeds.has(vsid)) return // 重复 OPEN:忽略,防重复连 TCP
          const feed = attachStream(sess, vsid, dc, wsPort)
          sess.feeds.set(vsid, feed)
        } else if (cmd === VS_DATA) {
          sess.feeds.get(vsid)?.feed(buf.subarray(0, 10 + len))
        } else if (cmd === VS_CLOSE) {
          sess.feeds.get(vsid)?.closed()
          sess.feeds.delete(vsid)
        } // PING 忽略
      })
      dc.onClosed(() => {
        sess.dcOpen = false
        for (const feed of sess.feeds.values()) feed.closed()
        sess.feeds.clear()
        for (const s of sess.streams.values()) { try { s.destroy() } catch {} }
        sess.streams.clear()
        sessions.delete(sid)
      })
      pc.onStateChange((st) => {
        sess.pcState = st
        if (st === 'failed' || st === 'disconnected' || st === 'closed') {
          try { pc.close() } catch {}
          sessions.delete(sid)
        }
      })
      // 非 trickle:调 setLocalDescription 后轮询等 gathering complete
      // (立即读 localDescription 可能拿到无候选 SDP 或 null —— e2e 实证)。
      pc.setLocalDescription()
      const t0 = Date.now()
      while (pc.gatheringState() !== 'complete') {
        if (Date.now() - t0 > 8000) throw new Error('ice gathering timeout: ' + pc.gatheringState())
        await new Promise((r) => setTimeout(r, 50))
      }
      const desc = pc.localDescription()
      if (desc === null || typeof desc.sdp !== 'string') {
        throw new Error('SDP 生成失败')
      }
      emit('info', 'offer 就绪(sid=' + sid.slice(0, 8) + '…,候选 '
        + (String(desc.sdp).match(/^a=candidate/gm) ?? []).length + ' 条,pcState='
        + sess.pcState + ')')
      send({ t: 'signal', sid, data: { type: 'offer', sdp: desc.sdp } })
    } catch (e) {
      if (pc !== null) { try { pc.close() } catch {} }
      sessions.delete(sid)
      emit('warning', 'P2P 会话建立失败(sid=' + sid.slice(0, 8) + '…):' + String(e && e.message ? e.message : e))
    }
  }

  const onSignalData = (sid, data) => {
    const sess = sessions.get(sid)
    if (sess === undefined) return
    if (data.type === 'answer') {
      // libdatachannel 的 answer 带 a=setup:actpass(offer 语义),offerer
      // 应用会被拒(Illegal role)—— 统一改写成 passive(e2e 实证)。
      const sdp = String(data.sdp).replace(/a=setup:actpass/g, 'a=setup:passive')
      try { sess.pc.setRemoteDescription(sdp, 'answer') } catch (e) {
        emit('warning', 'answer 应用失败(sid=' + sid.slice(0, 8) + '…):' + String(e && e.message ? e.message : e))
      }
    } else if (data.type === 'candidate') {
      // 手机的 trickle 候选(2026-08-28 真机实锤):libwebrtc answerer 会把
      // 候选经信令漂过来,PROTOCOL §1 本就规定 ICE 双向走 signal 信封 ——
      // 旧实现只处理 answer,Mac 拿不到手机侧候选,跨 NAT 打洞必死
      // (ICE 恒停在 connecting);同机 live smoke 靠 host+prflx 兜底掩盖了它。
      const cand = String(data.candidate ?? '')
      if (cand.length > 0) {
        try {
          sess.pc.addRemoteCandidate(cand, String(data.sdpMid ?? ''))
          emit('info', '候选注入(sid=' + sid.slice(0, 8) + '…):' + cand.slice(0, 80))
        } catch (e) {
          emit('warning', '候选注入失败(sid=' + sid.slice(0, 8) + '…):' + String(e && e.message ? e.message : e))
        }
      }
    }
  }

  // ── 信令 WS 生命周期 ──────────────────────────────────────────────────
  const connect = () => {
    if (stopped) return
    if (typeof WebSocket !== 'function') {
      emit('warning', '运行时无全局 WebSocket(需 Node 22+)—— 信令通道不可用')
      return
    }
    if (ticketExp < Date.now() + 30_000) {
      // ticket 过期/将过期:先刷新再连。刷新失败按指数退避重试 —— 固定
      // 500ms 会紧循环,请求与告警双轰炸(实证)。
      void refreshTicket().then(() => {
        if (stopped) return
        clearTimeout(reconnectTimer)
        if (ticketExp > Date.now() + 30_000) {
          reconnectTimer = setTimeout(connect, 500)
        } else {
          const delay = Math.min(1000 * 2 ** Math.min(attempt, 5), 30000)
          attempt += 1
          reconnectTimer = setTimeout(connect, delay)
        }
      })
      return
    }
    let socket
    try {
      socket = new WebSocket(signalUrl() + '?ticket=' + encodeURIComponent(ticket))
    } catch (e) {
      emit('warning', '信令连接创建失败:' + String(e && e.message ? e.message : e))
      scheduleReconnect()
      return
    }
    ws = socket
    socket.onopen = () => {
      attempt = 0
      emit('info', '信令通道已连接(' + new URL(signalUrl()).host + ';P2P 待命)')
    }
    socket.onmessage = (ev) => {
      const j = typeof ev.data === 'string' ? tryJson(ev.data) : null
      if (j === null) return
      const t = j.t
      if (t === 'ping') { send({ t: 'pong' }); return }
      if (t === 'offer-req') { void startSession(j); return }
      if (t === 'signal' && j.sid && j.data) { onSignalData(String(j.sid), j.data); return }
      if (t === 'bye') {
        const sess = sessions.get(String(j.sid))
        if (sess) {
          try { sess.pc.close() } catch {}
          sessions.delete(String(j.sid))
        }
      }
    }
    socket.onclose = () => { if (ws === socket) { ws = null; scheduleReconnect() } }
    socket.onerror = () => { /* onclose 会跟 */ }
  }

  const scheduleReconnect = () => {
    if (stopped) return
    const delay = Math.min(1000 * 2 ** Math.min(attempt, 5), 30000)
    attempt += 1
    reconnectTimer = setTimeout(connect, delay)
  }

  const start = () => {
    void refreshTicket()
    ticketTimer = setInterval(() => { void refreshTicket() }, 5 * 60 * 1000)
    connect()
  }

  const stop = () => {
    stopped = true
    if (ticketTimer !== null) clearInterval(ticketTimer)
    if (reconnectTimer !== null) clearTimeout(reconnectTimer)
    for (const sess of sessions.values()) {
      try { sess.pc.close() } catch {}
      for (const s of sess.streams.values()) { try { s.destroy() } catch {} }
    }
    sessions.clear()
    if (ws !== null) {
      try { ws.close() } catch {}
      ws = null
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
  const runtime = {
    gateway: gatewayRaw,
    adminKey: String(process.env.DSH_MOBILE_ADMIN_KEY ?? config?.adminKey ?? '').trim(),
    host: String(process.env.DSH_MOBILE_HOST ?? config?.host ?? '').trim().toLowerCase() || defaultHostKey(),
    publicUrl: sanitizePairUrl(process.env.DSH_MOBILE_PUBLIC_URL ?? config?.publicUrl ?? (gatewayRaw ? gatewayRaw + '/pair' : '')),
    iceServers: (() => {
      const raw = process.env.DSH_MOBILE_ICE_SERVERS ?? config?.iceServers
      if (typeof raw === 'string') { const j = tryJson(raw); return Array.isArray(j) ? j : DEFAULT_ICE }
      return Array.isArray(raw) ? raw : DEFAULT_ICE
    })(),
    localPort: ws.port,
  }
  if (!isValidPairUrl(runtime.gateway)) {
    throw new Error('dsh-mobile: gateway invalid(需如 https://dsh.example.com,指向 CF Worker 网关)')
  }
  if (runtime.adminKey.length < 16) {
    throw new Error('dsh-mobile: adminKey 至少 16 字符(部署 Worker 时的 ADMIN_KEY)')
  }

  let labelScope = null
  let label = sanitizeLabel(process.env.DSH_MOBILE_LABEL ?? config?.label) || shortHostname()
  ctx.inject(['settings'], (sctx) => {
    labelScope = sctx.settings.register(settingsNamespace(LABEL_NS), SettingsSchema, {
      base: { label },
    })
    label = sanitizeLabel(labelScope.get().label) || shortHostname()
    sctx.effect(() => labelScope.watch((next) => {
      label = sanitizeLabel(next.label) || shortHostname()
    }))
  })

  const getConfig = () => runtime
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

  const pair = createPairService({ getConfig, getLabel, onEvent: recordSecurityEvent })
  const signal = createSignalService({ getConfig, emit })
  signal.start()

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
            mode: 'p2p',
            host: runtime.host,
          })
        }
        if (u.pathname === '/api/label' && req.method === 'GET') {
          return sendJson(res, 200, { ok: true, label, editable: labelScope !== null })
        }
        if (u.pathname === '/api/label' && req.method === 'POST') {
          const body = await readBody(req)
          if (body === null || typeof body.label !== 'string') {
            return sendJson(res, 400, { ok: false, error: 'label required' })
          }
          if (labelScope === null) {
            return sendJson(res, 503, { ok: false, error: 'settings service unavailable' })
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
          return sendJson(res, 200, { ok: true, label })
        }
        // P2P 状态(信令通道 + 活跃会话)。
        if (u.pathname === '/api/state' && req.method === 'GET') {
          return sendJson(res, 200, { ok: true, mode: 'p2p', signal: signal.state() })
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
          // 链路标注:p2p = 本机活跃 DataChannel 会话(按 jti 对账);
          // relay = 网关侧 connected 近似(5min 内有管理/中转活动);'' = 离线。
          const p2pJtis = new Set(signal.state().devices.map((d) => d.jti).filter(Boolean))
          for (const t of list) {
            t.link = p2pJtis.has(t.jti) ? 'p2p' : (t.connected ? 'relay' : '')
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
    signal.stop()
    pair.stop()
    for (const dispose of disposers) {
      try { dispose() } catch {}
    }
  })
}
