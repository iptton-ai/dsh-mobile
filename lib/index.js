// dsh-mobile — Mac 侧移动接入一键化(dsh 插件)。
// 合并原 dsh-tunnel(SSH 反向隧道)与 pair.sh(扫码配对/设备管理):
//   · 隧道:webserver 绑定后 spawn 'ssh -R',断线退避重启,dsh 退出即断
//     (--port 0 也正确:本机端口读运行时值);
//   · 配对页:web GUI 内 /pair —— 点「配对手机」出二维码(网关渲染,浏览器显示),
//     手机系统相机扫码 → 落地页「复制」→ singleman 粘贴 → 绿卡点选即成;
//   · 设备管理:已发令牌清单 + 一键吊销(网关管理面,经 ssh,公网不可达)。
// 信任根 = 用户 ssh key(「能 claim = 有服务器权限」),与 pair.sh 完全一致。
//
// 配置(cordis.patch.yml 的 dsh-mobile 行 config;DSH_MOBILE_* 环境变量可覆盖):
//   target / remotePort / adminPort / publicUrl / pagePath / label
import { spawn } from 'node:child_process'
import { randomInt } from 'node:crypto'
import { hostname } from 'node:os'

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

/** 经 ssh 在网关服务器本机执行 curl(管理面仅 127.0.0.1 可达);失败 resolve ''。 */
const sshCurl = (target, cli, timeoutMs) =>
  new Promise((resolve) => {
    const child = spawn(SSH, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', String(target), cli], {
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

function startTunnel(emit, target, remotePort, localPort) {
  let child = null
  let stopped = false
  let attempt = 0
  let timer = null

  const args = () => [
    '-N', '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=15',
    '-R', '127.0.0.1:' + String(remotePort) + ':127.0.0.1:' + String(localPort),
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
      emit('warning', 'ssh exited (code=' + String(code) + ' signal=' + String(signal) + '); restart in ' + String(delay) + 'ms — 检查 remotePort ' + String(remotePort) + ' 是否被占用')
      timer = setTimeout(start, delay)
    })
  }

  emit('info', 'up: ' + String(target) + ' 127.0.0.1:' + String(remotePort) + ' -> local :' + String(localPort))
  start()

  return {
    state: () => ({ target, remotePort, localPort, up: child !== null, attempts: attempt }),
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
  const admin = 'http://127.0.0.1:' + String(options.adminPort)
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

  const tick = async (myGen) => {
    while (myGen === generation && session !== null) {
      if (Date.now() - session.startedAt > PAIRING_WINDOW_MS) {
        session.state = 'timeout'
        return
      }
      if (session.state === 'waiting') {
        const body = await sshCurl(options.target,
          "curl -s --max-time 8 -X POST " + admin + "/admin/pair/claim -H 'content-type: application/json' -d '" +
          JSON.stringify({ code: session.code, host_code: session.hostCode, host_label: session.label, port: session.port }) + "'")
        const j = tryJson(body)
        if (j && j.claim_id) {
          session.state = 'claimed'
          emitPage(null) // 状态变化由页面轮询拉取;无推送,占位
        }
      } else if (session.state === 'claimed') {
        const body = await sshCurl(options.target,
          "curl -s --max-time 8 '" + admin + "/admin/pair/status?code=" + session.code + "'")
        const j = tryJson(body)
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
        publicUrl: options.publicUrl, qr: null, modules: null,
        expiresAt: Date.now() + 10 * 60 * 1000, startedAt: Date.now(),
        state: 'waiting', device: null, jti: null, error: null, timer: null,
      }
      const body = await sshCurl(options.target,
        "curl -s --max-time 10 -X POST " + admin + "/admin/pair/qr -H 'content-type: application/json' -d '" +
        JSON.stringify({ text: inviteUrl }) + "'")
      const j = tryJson(body)
      if (j === null || typeof j.qr !== 'string' || j.qr.length === 0) {
        session.state = 'error'
        session.error = '二维码获取失败:网关不可达或版本过旧(需 /admin/pair/qr;检查 ssh ' + String(options.target) + ' 与 adminPort ' + String(options.adminPort) + ')'
        return snapshot()
      }
      session.qr = j.qr.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PRZcf-nqry=><]/g, '') // 剥 ANSI(网关发 ESC 序列),浏览器纯文本渲染
      session.modules = j.modules ?? null
      session.timer = setTimeout(() => tick(myGen), 300)
      return snapshot()
    },
    stop: () => {
      generation += 1
      clearTimer()
      session = null
    },
    /** 已发令牌清单(经 ssh)。 */
    tokens: async () => {
      const body = await sshCurl(options.target, "curl -s --max-time 8 '" + admin + "/admin/pair/tokens'")
      return tryJson(body) ?? null
    },
    /** 吊销令牌(经 ssh)。 */
    revoke: async (jti) => {
      const body = await sshCurl(options.target,
        "curl -s --max-time 8 -X POST " + admin + "/admin/pair/revoke-token -H 'content-type: application/json' -d '" +
        JSON.stringify({ jti: String(jti) }) + "'")
      return tryJson(body) ?? { revoked: false }
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
<div class="card"><h2>配对手机</h2>
 <div id="pairarea"><button id="start">配对手机</button>
 <span class="dim"> 手机扫码 → 落地页「复制」→ singleman 粘贴</span></div></div>
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
      + ' &nbsp;' + esc(t.target) + ' 127.0.0.1:' + t.remotePort + ' ⇄ 本机 :' + t.localPort;
  } catch (e) { $('tunnel').textContent = '读取失败:' + e.message; }
}

function renderPair(s) {
  if (s === null) { location.reload(); return; }
  const area = $('pairarea');
  if (s.state === 'waiting' || s.state === 'claimed') {
    area.innerHTML = (s.qr ? '<pre id="qr">' + esc(s.qr) + '</pre><br>' : '')
      + '<div class="dim">配对码</div><div class="code">' + esc(s.displayCode) + '</div>'
      + '<div class="dim">主机码</div><div class="code">' + esc(s.hostCode) + '</div>'
      + '<div class="dim">' + (s.state === 'waiting' ? '等待手机粘贴邀请…(配对码 10 分钟内有效)'
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
        + (t.upstream_port ?? '-') + '</td><td>' + (t.revoked ? '<span class="bad">已吊销</span>' : '<span class="ok">有效</span>')
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
$('refresh').onclick = loadTokens;
loadTunnel(); loadTokens();
setInterval(loadTunnel, 5000);
</script></body></html>`;

// ── 插件入口 ───────────────────────────────────────────────────────────────

export function apply(ctx, config = {}) {
  const ws = ctx.get('webServer')
  if (ws === undefined) return

  const options = {
    target: process.env.DSH_MOBILE_TARGET ?? config?.target ?? '',
    remotePort: Number(process.env.DSH_MOBILE_REMOTE_PORT ?? config?.remotePort ?? 13100),
    adminPort: Number(process.env.DSH_MOBILE_ADMIN_PORT ?? config?.adminPort ?? 8103),
    publicUrl: process.env.DSH_MOBILE_PUBLIC_URL ?? config?.publicUrl ?? 'https://dsh.example.com/pair',
    pagePath: config?.pagePath ?? '/pair',
    label: config?.label ?? hostname().split('.')[0].slice(0, 32),
  }
  for (const key of ['remotePort', 'adminPort']) {
    if (!Number.isInteger(options[key]) || options[key] <= 0 || options[key] > 65535) {
      throw new Error('dsh-mobile: invalid ' + key + ' ' + String(options[key]))
    }
  }

  const emit = (level, message) => {
    const logger = ctx.logger
    const line = 'dsh-mobile: ' + message
    if (logger && typeof logger[level] === 'function') logger[level](line)
    else console[level === 'warning' ? 'warn' : 'log']('[' + line + ']')
  }

  const tunnel = startTunnel(emit, options.target, options.remotePort, ws.port)
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
        if (u.pathname === '/api/tunnel' && req.method === 'GET') {
          return sendJson(res, 200, tunnel.state())
        }
        if (u.pathname === '/api/start' && req.method === 'POST') {
          return sendJson(res, 200, await pair.start())
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

  // 主界面入口角标(可选 API;失败静默)。
  if (typeof ws.tapIndex === 'function') {
    try {
      const badge = '<a href="' + options.pagePath + '" style="position:fixed;left:14px;bottom:14px;z-index:9999;'
        + 'background:#2f6fed;color:#fff;text-decoration:none;font-size:12px;padding:6px 12px;'
        + 'border-radius:999px;opacity:.85" title="配对手机 / 设备管理">📱 移动接入</a>'
      const dispose = ws.tapIndex((html) => html.replace('</body>', badge + '</body>'))
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch {}
  }

  ctx.effect(() => () => {
    tunnel.stop()
    pair.stop()
    for (const dispose of disposers) {
      try { dispose() } catch {}
    }
  })
}
