// dsh-mobile — Mac 侧移动接入一键化(dsh 插件)。
// 合并原 dsh-tunnel(SSH 反向隧道)与 pair.sh(扫码配对/设备管理):
//   · 隧道:webserver 绑定后 spawn 'ssh -R',断线退避重启,dsh 退出即断
//     (--port 0 也正确:本机端口读运行时值);
//   · 配对页:web GUI 内 /pair —— 扫码模式点「配对手机」出二维码(网关渲染,浏览器显示),
//     App 内置相机直接扫(或系统相机扫码 → 落地页「复制」→ 粘贴)→ 绿卡点选即成;
//     手输模式:手机先「生成配对码」,在本页输入框粘贴/输入 10 位码点「应约」
//     (复刻 pair.sh 手输分支;码不存在/过期快速失败,不再傻等 5 分钟);
//   · 机器名:dsh-mobile settings 命名空间的 label 字段(默认设备 hostname,
//     本页/dsh 设置页可改,持久化进用户 settings 文档);手机 App 经
//     GET /pair/api/host 读取,设置页显示「已连接 <机器名>」;
//   · 设备管理:已发令牌清单 + 一键吊销(网关管理面,经 ssh,公网不可达)。
// 主界面入口在浏览器半边(lib/client.js):侧栏 foot「移动接入」按钮
// (sidebar.footer.action 座,与设置按钮同区),点击弹 dialog 内嵌 /pair。
// 信任根 = 用户 ssh key(「能 claim = 有服务器权限」),与 pair.sh 完全一致。
//
// 配置(cordis.patch.yml 的 dsh-mobile 行 config;DSH_MOBILE_* 环境变量可覆盖):
//   target / remotePort / adminPort / publicUrl / pagePath / label
import { spawn } from 'node:child_process'
import { randomInt } from 'node:crypto'
import { hostname } from 'node:os'

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
const LabelSchema = z.object({ label: z.string().required(false) })

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

  const start = () => {
    if (stopped) return
    child = spawn(SSH, args(), { stdio: ['ignore', 'pipe', 'pipe'] })
    child.stderr.on('data', (d) => {
      const text = String(d).trim()
      if (text && !text.includes('Permanently added')) emit('warning', text)
    })
    child.on('exit', (code, signal) => {
      child = null
      if (stopped) return
      const delay = Math.min(1000 * 2 ** Math.min(attempt, 5), 30000)
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

// ── 配对会话(复刻 pair.sh 扫码模式:铸码 → QR → claim 重试 → 状态轮询) ────

const PAIRING_WINDOW_MS = 5.5 * 60 * 1000 // 网关 pending TTL 10min;claim 重试 5.5min

function createPairService(options) {
  // 两种管理面传输:CF 形态(gateway+adminKey → 直连 HTTPS,免 ssh)与
  // Rust 形态(target+adminPort → 经 ssh 在服务器本机 curl loopback)。
  // 两者可并存:target 只管隧道,gateway/adminKey 只管配对与设备管理。
  const cfMode = Boolean(options.gateway && options.adminKey)
  const admin = 'http://127.0.0.1:' + String(options.adminPort)
  // DSH_GATEWAY_ADMIN_TOKEN 非空时网关管理面要求 bearer;服务器侧就地读取注入
  // (远端命令内展开),凭证不出服务器;env 未配置时头值 "Bearer ",网关放行。
  const AH = "-H \"authorization: Bearer $(sed -n 's/^DSH_GATEWAY_ADMIN_TOKEN=//p' /etc/dsh-gateway.env)\" "

  /** CF 形态:直连 Worker 管理面(ADMIN_KEY 信任根);失败/非 JSON 统一 null
   *  (与 sshCurl resolve '' 的失败语义对齐,调用方 tryJson 判定)。 */
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

  /** 管理面 POST(两种传输择一)。 */
  const adminPost = (path, payload) =>
    cfMode
      ? cfFetch(path, 'POST', payload)
      : sshCurl(options.target,
        "curl -s " + AH + "--max-time 8 -X POST " + admin + path + " -H 'content-type: application/json' -d '" +
        JSON.stringify(payload) + "'")

  /** 管理面 GET。 */
  const adminGet = (path) =>
    cfMode
      ? cfFetch(path, 'GET')
      : sshCurl(options.target, "curl -s " + AH + "--max-time 8 '" + admin + path + "'")

  const unreachableHint = cfMode
    ? '网关不可达:检查 gateway ' + options.gateway + ' 与 adminKey(部署时填的 ADMIN_KEY)'
    : '网关不可达:检查 ssh ' + String(options.target) + ' 与管理口 ' + String(options.adminPort)

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

  /** 向网关登记一次 claim(错误响应体 {"error":…} 原样带回供判定)。 */
  const claimOnce = () => adminPost('/admin/pair/claim',
    { code: session.code, host_code: session.hostCode, host_label: session.label, port: session.port })

  const tick = async (myGen) => {
    while (myGen === generation && session !== null) {
      if (Date.now() - session.startedAt > PAIRING_WINDOW_MS) {
        session.state = 'timeout'
        return
      }
      if (session.state === 'waiting') {
        const j = await claimOnce()
        if (j && j.claim_id) {
          session.state = 'claimed'
          emitPage(null) // 状态变化由页面轮询拉取;无推送,占位
        }
      } else if (session.state === 'claimed') {
        const j = await adminGet('/admin/pair/status?code=' + session.code)
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
        state: 'waiting', device: null, jti: null, error: null, timer: null,
      }
      const j = await adminPost('/admin/pair/qr', { text: inviteUrl })
      if (j === null || typeof j.qr !== 'string' || j.qr.length === 0) {
        session.state = 'error'
        session.error = '二维码获取失败:' + unreachableHint + '(需 /admin/pair/qr)'
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
      generation += 1
      const myGen = generation
      clearTimer()
      session = {
        code, hostCode: genCode(6), label: options.label, port: options.remotePort,
        publicUrl: options.publicUrl, qr: null, modules: null, mode: 'manual',
        expiresAt: Date.now() + 10 * 60 * 1000, startedAt: Date.now(),
        state: 'waiting', device: null, jti: null, error: null, timer: null,
      }
      const j = await claimOnce()
      if (j !== null && j.claim_id) {
        session.state = 'claimed'
        session.device = j.device ?? null
        schedule(myGen, 3000)
      } else if (j !== null && typeof j.error === 'string') {
        session.state = 'error'
        session.error = '网关拒绝:' + j.error + ' —— 确认手机停留在配对等待页且码未过期'
      } else {
        session.state = 'error'
        session.error = unreachableHint
      }
      return snapshot()
    },
    stop: () => {
      generation += 1
      clearTimer()
      session = null
    },
    /** 已发令牌清单。 */
    tokens: async () => await adminGet('/admin/pair/tokens'),
    /** 吊销令牌。 */
    revoke: async (jti) =>
      (await adminPost('/admin/pair/revoke-token', { jti: String(jti) })) ?? { revoked: false },
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

// ── 页面(单文件内联,零外部资源) ──────────────────────────────────────────

const pageHtml = (pagePath) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>DSH 移动接入</title>
<style>
 body{font-family:system-ui,-apple-system,sans-serif;background:#111;color:#eee;max-width:680px;margin:0 auto;padding:24px 16px}
 h1{font-size:20px} h2{font-size:15px;color:#9bb}
 .card{background:#1d1d1f;border-radius:14px;padding:16px;margin:14px 0}
 .ok{color:#7fd38a} .bad{color:#e57373} .dim{color:#999;font-size:13px}
 button{padding:10px 18px;font-size:14px;border:none;border-radius:10px;background:#2f6fed;color:#fff;cursor:pointer}
 button.warn{background:#8a2f2f}
 #qr{display:inline-block;background:#fff;color:#000;padding:14px;line-height:2ch;font-size:16px;
     font-family:ui-monospace,Menlo,Consolas,monospace;letter-spacing:0;border-radius:6px}
 .code{font-size:26px;font-weight:700;letter-spacing:3px;font-family:ui-monospace,monospace}
 table{width:100%;border-collapse:collapse;font-size:13px}
 td,th{padding:6px 8px;border-bottom:1px solid #333;text-align:left}
 .rev{background:none;border:none;color:#e57373;font-size:12px;text-decoration:underline;padding:0}
</style></head><body>
<h1>DSH 移动接入</h1>
<div class="card"><h2>隧道</h2><div id="tunnel" class="dim">读取中…</div></div>
<div class="card"><h2>机器名</h2>
 <div style="display:flex;gap:8px">
  <input id="label" maxlength="32" autocomplete="off" spellcheck="false" placeholder="设备名称"
   style="flex:1;min-width:0;padding:9px 12px;font-size:15px;border:1px solid #3a3a3c;border-radius:10px;background:#151516;color:#eee">
  <button id="setLabel">保存</button></div>
 <span class="dim">手机端显示「已连接 <机器名>」;默认设备名,修改即时生效并持久化</span></div>
<div class="card"><h2>配对手机</h2>
 <div id="pairarea"><button id="start">配对手机(扫码)</button>
 <span class="dim"> App 输入框右侧相机图标扫码;或系统相机扫 → 落地页「复制」→ App 粘贴</span>
 <div style="margin-top:12px;display:flex;gap:8px">
  <input id="phoneCode" maxlength="12" autocomplete="off" autocapitalize="characters" spellcheck="false"
   placeholder="手机已生成配对码?输入 10 位码"
   style="flex:1;min-width:0;padding:9px 12px;font-size:15px;letter-spacing:1px;border:1px solid #3a3a3c;border-radius:10px;background:#151516;color:#eee;font-family:ui-monospace,Menlo,monospace">
  <button id="claim">应约</button></div>
 <span class="dim"> 手机先亮码时用:应约后本页显示主机码,回手机点选一致的那个</span></div></div>
<div class="card"><h2>已配对设备</h2>
 <div><button id="refresh">刷新</button></div>
 <div id="tokens" class="dim">读取中…</div></div>
<div class="dim">管理 API 仅接受 loopback 来源;令牌吊销即时生效。</div>
<script>
const AP = location.pathname.replace(/\\/$/,'');
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let pollTimer = null;

async function api(path, init) {
  const r = await fetch(AP + path, init);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function loadTunnel() {
  try {
    const t = await api('/api/tunnel');
    $('tunnel').innerHTML = (t.up ? '<span class="ok">● 已连接</span>' : '<span class="bad">● 重连中(第 ' + t.attempts + ' 次)</span>')
      + ' &nbsp;' + esc(t.target) + ' ' + (t.remoteListen ?? '127.0.0.1:' + t.remotePort) + ' ⇄ 本机 :' + t.localPort;
  } catch (e) { $('tunnel').textContent = '读取失败:' + e.message; }
}

async function loadLabel() {
  try {
    const l = await api('/api/label');
    if (l.label && $('label').value === '') $('label').value = l.label;
    if (l.editable === false) $('label').disabled = true;
  } catch (e) { $('label').disabled = true; }
}

async function saveLabel() {
  const btn = $('setLabel');
  btn.disabled = true;
  try {
    const r = await api('/api/label', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: $('label').value }) });
    btn.textContent = r.ok ? '已保存' : ('失败:' + (r.error || '?'));
  } catch (e) { btn.textContent = '失败:' + e.message; }
  setTimeout(() => { btn.disabled = false; btn.textContent = '保存'; }, 1500);
}

function renderPair(s) {
  if (s === null) { location.reload(); return; }
  const area = $('pairarea');
  if (s.state === 'waiting' || s.state === 'claimed') {
    area.innerHTML = (s.qr ? '<pre id="qr">' + esc(s.qr) + '</pre><br>' : '')
      + '<div class="dim">配对码</div><div class="code">' + esc(s.displayCode) + '</div>'
      + '<div class="dim">主机码</div><div class="code">' + esc(s.hostCode) + '</div>'
      + '<div class="dim">' + (s.state === 'waiting'
          ? (s.mode === 'manual'
              ? '等网关确认手机在场…'
              : '等待手机粘贴邀请…(配对码 10 分钟内有效)')
          : '手机已就绪,等它在 App 里点选主机码 ' + esc(s.hostCode) + ' …') + '</div>'
      + '<button class="warn" onclick="stopPair()">取消</button>';
  } else if (s.state === 'confirmed') {
    area.innerHTML = '<span class="ok">✅ 已配对:设备「' + esc(s.device) + '」获得 30 天令牌(隧道 ' + s.port + ')。'
      + '不是自己的手机?在下方设备清单立即吊销。</span>'
      + '<br><button onclick="location.reload()">再配一台</button>';
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    loadTokens();
  } else if (s.state === 'error') {
    area.innerHTML = '<span class="bad">❌ ' + esc(s.error) + '</span><br><button onclick="location.reload()">重试</button>';
  } else { // expired / timeout
    area.innerHTML = '<span class="bad">配对已失效(' + esc(s.state) + '),请重新发起。</span>'
      + '<br><button onclick="location.reload()">重新配对</button>';
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }
}

async function startPair() {
  try {
    const s = await api('/api/start', { method: 'POST' });
    renderPair(s);
    pollTimer = setInterval(async () => {
      try { renderPair(await api('/api/state?code=' + s.code)); } catch (e) {}
    }, 2000);
  } catch (e) { alert('发起失败:' + e.message); }
}
async function startManual() {
  try {
    const s = await api('/api/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: $('phoneCode').value }) });
    if (s.state === 'error') { alert(s.error || '应约失败'); return; }
    renderPair(s);
    pollTimer = setInterval(async () => {
      try { renderPair(await api('/api/state?code=' + s.code)); } catch (e) {}
    }, 2000);
  } catch (e) { alert('应约失败:' + e.message); }
}
async function stopPair() {
  try { await api('/api/stop', { method: 'POST' }); } catch (e) {}
  location.reload();
}

async function loadTokens() {
  try {
    const list = await api('/api/tokens');
    if (!Array.isArray(list) || list.length === 0) { $('tokens').textContent = '(尚无已发令牌)'; return; }
    $('tokens').innerHTML = '<table><tr><th>设备</th><th>来源</th><th>隧道</th><th>状态</th><th></th></tr>'
      + list.map((t) => '<tr><td>' + esc(t.device) + '</td><td>' + esc(t.host_label) + '</td><td>'
        + (t.upstream_port ?? '-') + '</td><td>' + (t.revoked ? '<span class="bad">已吊销</span>'
          : '<span class="' + (t.connected ? 'ok' : 'dim') + '">' + (t.connected ? '● 在线' : '○ 离线') + '</span>')
        + '</td><td>' + (t.revoked ? '' : '<button class="rev" data-jti="' + esc(t.jti) + '">吊销</button>') + '</td></tr>').join('')
      + '</table>';
    document.querySelectorAll('.rev').forEach((b) => b.onclick = async () => {
      if (!confirm('吊销该设备令牌?它将立即失联。')) return;
      try { await api('/api/revoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jti: b.dataset.jti }) }); loadTokens(); }
      catch (e) { alert('吊销失败:' + e.message); }
    });
  } catch (e) { $('tokens').textContent = '读取失败:' + e.message; }
}

$('start').onclick = startPair;
$('claim').onclick = startManual;
$('phoneCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') startManual(); });
$('setLabel').onclick = saveLabel;
$('refresh').onclick = loadTokens;
loadTunnel(); loadLabel(); loadTokens();
setInterval(loadTunnel, 5000);
</script></body></html>`;

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
    // 填的 ADMIN_KEY。配对/设备管理直连 HTTPS;隧道由 cloudflared 负责
    // (LaunchAgent/系统服务,生命周期独立于 dsh web),本插件不拉 ssh。
    gateway: (process.env.DSH_MOBILE_GATEWAY ?? config?.gateway ?? '').replace(/\/+$/, ''),
    adminKey: process.env.DSH_MOBILE_ADMIN_KEY ?? config?.adminKey ?? '',
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
  if (!options.target && !(options.gateway && options.adminKey)) {
    throw new Error('dsh-mobile: need either ssh target (Rust 形态) or gateway+adminKey (CF 形态)')
  }

  // 机器名注册进 dsh 用户 settings(base = patch.yml config/环境变量;用户层
  // 可在 /pair 页或 dsh 设置页改,持久化;watch 让运行中的隧道/二维码即时换名)。
  // settings 服务缺席(过旧 dsh)时静默保持静态 label —— 其余功能不受影响。
  let labelScope = null
  ctx.inject(['settings'], (sctx) => {
    labelScope = sctx.settings.register(settingsNamespace(LABEL_NS), LabelSchema, {
      base: { label: sanitizeLabel(process.env.DSH_MOBILE_LABEL ?? config?.label) || shortHostname() },
    })
    options.label = sanitizeLabel(labelScope.get().label) || shortHostname()
    sctx.effect(() => labelScope.watch((next) => {
      options.label = sanitizeLabel(next.label) || shortHostname()
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
  // 隧道:target 配置 = Rust 形态随 dsh web 拉起 ssh -R;CF 形态无 target,
  // 隧道是机器级 cloudflared 服务,这里只做健康探测(healthz 的 upstream 即隧道通断)。
  const cfTunnelState = async () => {
    const base = { mode: 'cloudflared', target: options.gateway, remotePort: null, localPort: ws.port, attempts: 0 }
    if (!options.gateway) return { ...base, up: false }
    try {
      const resp = await fetch(options.gateway + '/healthz', { signal: AbortSignal.timeout(6000) })
      const j = tryJson(await resp.text())
      return { ...base, up: Boolean(j && j.upstream) }
    } catch {
      return { ...base, up: false }
    }
  }
  const tunnel = options.target
    ? startTunnel(emit, options.target, options.remotePort, ws.port, options.sockDir)
    : null
  const pair = createPairService(options)

  const readBody = (req) =>
    new Promise((resolve) => {
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
      const prefix = options.pagePath.replace(/\/$/, '')
      let url = req.url ?? ''
      if (url === prefix || url === prefix + '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(pageHtml(options.pagePath))
        return
      }
      if (url.startsWith(prefix + '/')) url = url.slice(prefix.length)
      if (!url.startsWith('/api/')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(pageHtml(options.pagePath))
        return
      }
      // 管理 API:仅 loopback 页面可用(防 host 0.0.0.0 部署时被局域网操纵)。
      if (!isLoopbackAuthority(req.headers.host)) {
        return sendJson(res, 403, { ok: false, error: 'management API is loopback-only' })
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
        if (u.pathname === '/api/tunnel' && req.method === 'GET') {
          return sendJson(res, 200, await (tunnel !== null ? tunnel.state() : cfTunnelState()))
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
          return sendJson(res, 200, list)
        }
        if (u.pathname === '/api/revoke' && req.method === 'POST') {
          const body = await readBody(req)
          if (body === null || typeof body.jti !== 'string' || body.jti.length === 0) {
            return sendJson(res, 400, { error: 'jti required' })
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
  // 入口移入浏览器半边(lib/client.js):注册 sidebar.footer.action 座,
  // 与设置按钮同区,点击弹 dialog 内嵌本页。这里只保留 /pair 路由本体。

  ctx.effect(() => () => {
    if (tunnel !== null) tunnel.stop()
    pair.stop()
    for (const dispose of disposers) {
      try { dispose() } catch {}
    }
  })
}
