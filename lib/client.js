// dsh-mobile client — 浏览器半边:侧栏 foot「移动接入」入口 + 原生 dialog。
// 由 dsh-client-modules 按 package.json 的 dsh.client 声明收录进 __DSH_BOOT__,
// 经 /plugins/dsh-mobile/client.js 下发。本文件必须是「已构建 bundle」形态:
// window.__ModuleLoader__.load 包裹,工厂内只 require 静态注册表模块(react),
// 不出现裸 import/export —— 与内置插件下发的 client.js 一致。
//
// 入口注册进 sidebar foot 的 footer.action 座(官方契约:"Optional actions
// beside Settings at the sidebar foot",现役占用者 Cordis 面板)。按钮兼作
// 在线指示器:轮询 /pair/api/tokens 的 connected 字段(网关按「令牌当前是否
// 持有下行 WS」判定),有手机在线时点亮图标并示数。
// 点击弹原生 React dialog —— 直接同源调 /pair/api/*(管理 API 仅接受
// loopback Host,dsh web 本机访问天然满足),无 iframe,主题用 dsw 变量。
window.__ModuleLoader__.load({
  id: 'dsh-mobile',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const R = require('react')

    const css = '.dshm_badge{width:100%;height:49px;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border:none;border-radius:12px;align-items:center;gap:8px;padding:0 8px 0 6px;font-family:inherit;font-size:14px;display:inline-flex;overflow:hidden}'
      + '.dshm_badge:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}'
      + '.dshm_icon{display:inline-flex;flex:none;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary)}'
      + '.dshm_icon svg{display:block}'
      + '.dshm_badge.dshm_on .dshm_icon{color:var(--dsw-alias-state-success-primary)}'
      + '.dshm_label{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}'
      + '.dshm_count{color:var(--dsw-alias-state-success-primary);font-variant-numeric:tabular-nums;flex:none;margin-left:auto;font-size:12px;line-height:16px}'
      + '.dshm_rail{position:relative;border-radius:50%;justify-content:center;gap:0;width:36px;height:36px;padding:0;overflow:visible}'
      + '.dshm_rail .dshm_icon svg{width:18px;height:18px}'
      + '.dshm_railCount{position:absolute;top:-3px;right:-3px;min-width:16px;height:16px;padding:0 4px;box-sizing:border-box;background:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-bg-canvas-solid,var(--dsw-alias-bg-base));border-radius:999px;font-size:10px;line-height:16px;text-align:center;font-variant-numeric:tabular-nums}'
      + '.dshm_overlay{position:fixed;inset:0;z-index:60;background:color-mix(in srgb, var(--dsw-alias-bg-canvas, #000) 45%, transparent);display:flex;align-items:center;justify-content:center}'
      + '.dshm_dialog{width:560px;max-width:92vw;max-height:84vh;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);box-shadow:var(--dsw-shadow-lv2);border-radius:12px;flex-direction:column;display:flex;overflow:hidden}'
      + '.dshm_head{box-sizing:border-box;border-bottom:1px solid var(--dsw-alias-border-l2);flex:none;justify-content:space-between;align-items:center;min-height:44px;padding:10px 14px;display:flex}'
      + '.dshm_title{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px}'
      + '.dshm_close{color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:8px;font-family:inherit;font-size:18px;line-height:1;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center}'
      + '.dshm_close:hover{background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}'
      + '.dshm_body{flex:1;min-height:0;overflow-y:auto;padding:4px 14px 14px;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}'
      + '.dshm_h2{color:var(--dsw-alias-label-caption);text-transform:uppercase;letter-spacing:.04em;margin:14px 0 8px;font-size:11px;font-weight:500;line-height:16px}'
      + '.dshm_dim{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}'
      + '.dshm_row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}'
      + '.dshm_btn{cursor:pointer;background:var(--dsw-alias-interactive-bg-solid,var(--dsw-alias-interactive-bg-hover-solid));color:var(--dsw-alias-label-primary);border:none;border-radius:8px;font-family:inherit;font-size:13px;padding:7px 12px}'
      + '.dshm_btn:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}'
      + '.dshm_btnWarn{cursor:pointer;background:0 0;color:var(--dsw-alias-state-error-primary);border:none;border-radius:8px;font-family:inherit;font-size:12px;text-decoration:underline;padding:2px 4px}'
      + '.dshm_input{flex:1;min-width:120px;color:var(--dsw-alias-label-primary);caret-color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-fill,var(--dsw-alias-bg-canvas));border:1px solid var(--dsw-alias-border-l2);border-radius:8px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;letter-spacing:1px;padding:7px 10px;outline:none}'
      + '.dshm_input:focus{border-color:var(--dsw-alias-interactive-accent)}'
      + '.dshm_code{color:var(--dsw-alias-label-primary);font-size:24px;font-weight:700;letter-spacing:3px;font-family:ui-monospace,Menlo,Consolas,monospace}'
      + '.dshm_qr{display:inline-block;background:#fff;color:#000;padding:12px;line-height:2ch;font-size:14px;font-family:ui-monospace,Menlo,Consolas,monospace;border-radius:8px;max-width:100%;overflow:auto}'
      + '.dshm_ok{color:var(--dsw-alias-state-success-primary)}'
      + '.dshm_bad{color:var(--dsw-alias-state-error-primary)}'
      + '.dshm_table{width:100%;border-collapse:collapse;font-size:12px}'
      + '.dshm_table th{color:var(--dsw-alias-label-caption);text-align:left;font-weight:500;padding:5px 6px;border-bottom:1px solid var(--dsw-alias-border-l2)}'
      + '.dshm_table td{color:var(--dsw-alias-label-primary);padding:6px;border-bottom:1px solid var(--dsw-alias-border-l1)}'
      + '.dshm_dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary);margin-right:5px;vertical-align:1px}'
      + '.dshm_dot.dshm_on{background:var(--dsw-alias-state-success-primary)}'
      // 隧道形态徽章(隧道区/设备表共用,色系对齐 legacy 页 tag-cf/tag-rust)
      + '.dshm_tag{display:inline-block;flex:none;padding:1px 7px;border-radius:999px;font-size:10px;line-height:14px;font-weight:600;letter-spacing:.02em;white-space:nowrap}'
      + '.dshm_tagRust{background:color-mix(in srgb, var(--dsw-alias-state-info-primary, #7ab0ff) 20%, transparent);color:var(--dsw-alias-state-info-primary, #7ab0ff)}'
      + '.dshm_tagCf{background:color-mix(in srgb, var(--dsw-alias-state-warning-primary, #ffc270) 20%, transparent);color:var(--dsw-alias-state-warning-primary, #ffc270)}'
      + '.dshm_tagOn{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-caption)}'
    const tagId = 'dsh-mobile/MobileAccessAction.module.css'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-mobile'
      tag.dataset.pluginCss = tagId
      tag.textContent = css
      document.head.appendChild(tag)
    }

    // 手机轮廓图标(16px,描边随 currentColor;在线态由 .dshm_on 变色)。
    const ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">'
      + '<rect x="4.25" y="1.75" width="7.5" height="12.5" rx="1.8" stroke="currentColor" stroke-width="1.3"/>'
      + '<line x1="6.9" y1="11.7" x2="9.1" y2="11.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>'

    // 与服务端 ws.register 的 pagePath 默认值对齐(/pair);改服务端配置需同步这里。
    const PAIR_API = '/pair/api'

    async function jget(path) {
      const r = await fetch(path)
      if (!r.ok) throw new Error('HTTP ' + String(r.status))
      return r.json()
    }
    async function jpost(path, body) {
      const r = await fetch(path, {
        method: 'POST',
        // x-dsh-mobile 自定义头:服务端写操作强制校验 —— 跨源 fetch 带自定义头
        // 必过 CORS 预检,预检不过请求根本不发出(2026-08-17 审计加固)。
        headers: body === undefined
          ? { 'x-dsh-mobile': '1' }
          : { 'content-type': 'application/json', 'x-dsh-mobile': '1' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (!r.ok) throw new Error('HTTP ' + String(r.status))
      return r.json()
    }

    /**
     * sidebar.footer.action 座内容:foot 按钮(宽栏=图标+文字+在线数,窄栏=36px
     * 圆钮+角标数)+ 原生 dialog(隧道/配对/设备管理)。轮询:tunnel+tokens
     * 常态 15s、dialog 打开 4s,页面隐藏时跳过;配对会话进行中 2s 拉状态。
     */
    function MobileAccessAction({ wide }) {
      const [open, setOpen] = R.useState(false)
      const [tunnel, setTunnel] = R.useState(null)
      const [tokens, setTokens] = R.useState(null)
      const [tokensErr, setTokensErr] = R.useState(null)
      const [pair, setPair] = R.useState(null)
      const [busy, setBusy] = R.useState(false)
      const [manual, setManual] = R.useState('')
      const [actErr, setActErr] = R.useState(null)
      const [hostLabel, setHostLabel] = R.useState(null)
      const [labelDraft, setLabelDraft] = R.useState('')
      const [labelBusy, setLabelBusy] = R.useState(false)
      const [keyInfo, setKeyInfo] = R.useState(null)
      const [keyDraft, setKeyDraft] = R.useState('')
      const [keyBusy, setKeyBusy] = R.useState(false)
      const [tenantInfo, setTenantInfo] = R.useState(null)
      const [tenantDraft, setTenantDraft] = R.useState('')
      const [tenantBusy, setTenantBusy] = R.useState(false)
      const [modeInfo, setModeInfo] = R.useState(null)
      const [showRevoked, setShowRevoked] = R.useState(false)
      const [webInfo, setWebInfo] = R.useState(null)
      const [webDraft, setWebDraft] = R.useState('')
      const [webBusy, setWebBusy] = R.useState(false)
      const [webMsg, setWebMsg] = R.useState(null)

      const online = R.useMemo(
        () => (tokens ?? []).filter((t) => t.connected && !t.revoked).length,
        [tokens],
      )

      // 常态轮询:tokens(经 ssh,开销由 ControlPersist 复用摊薄)+ tunnel/label(本地)。
      R.useEffect(() => {
        let alive = true
        const tick = async () => {
          if (document.hidden) return
        const [t, k, l, a, tk, m, w] = await Promise.allSettled([
          jget(PAIR_API + '/tunnel'), jget(PAIR_API + '/tokens'), jget(PAIR_API + '/label'), jget(PAIR_API + '/admin-key'),
          jget(PAIR_API + '/tenant-key'),
          jget(PAIR_API + '/mode'),
          jget(PAIR_API + '/web-password'),
        ])
        if (!alive) return
        if (t.status === 'fulfilled') setTunnel(t.value)
        if (k.status === 'fulfilled') { setTokens(k.value); setTokensErr(null) }
        else setTokensErr('读取失败:' + String(k.reason && k.reason.message ? k.reason.message : k.reason))
        if (l.status === 'fulfilled') {
          setHostLabel(l.value)
          setLabelDraft((prev) => (prev === '' ? String(l.value.label ?? '') : prev))
        }
        if (a.status === 'fulfilled') setKeyInfo(a.value)
        if (tk.status === 'fulfilled') setTenantInfo(tk.value)
        if (m.status === 'fulfilled') setModeInfo(m.value)
        if (w.status === 'fulfilled') setWebInfo(w.value)
        }
        tick()
        const timer = window.setInterval(tick, open ? 4000 : 15000)
        return () => { alive = false; window.clearInterval(timer) }
      }, [open])

      // 配对会话轮询:waiting/claimed 期间 2s 拉快照(dialog 关着也继续,
      // 会话在服务端跑;重开 dialog 能看到最新状态)。
      R.useEffect(() => {
        if (pair === null || (pair.state !== 'waiting' && pair.state !== 'claimed')) return undefined
        const code = pair.code
        const timer = window.setInterval(async () => {
          try { setPair(await jget(PAIR_API + '/state?code=' + String(code))) } catch (e) { /* 404=会话已换 */ }
        }, 2000)
        return () => window.clearInterval(timer)
      }, [pair])

      // Esc 关闭。
      R.useEffect(() => {
        if (!open) return undefined
        const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open])

      const startScan = async () => {
        setBusy(true); setActErr(null)
        try { setPair(await jpost(PAIR_API + '/start')) }
        catch (e) { setActErr('发起失败:' + String(e.message)) }
        setBusy(false)
      }
      const startManual = async () => {
        setBusy(true); setActErr(null)
        try {
          const s = await jpost(PAIR_API + '/claim', { code: manual })
          setPair(s) // 格式/网关错误也以 error 快照返回,统一渲染
        } catch (e) { setActErr('应约失败:' + String(e.message)) }
        setBusy(false)
      }
      const stopPair = async () => {
        try { await jpost(PAIR_API + '/stop') } catch (e) {}
        setPair(null)
      }
      const revoke = async (jti, device) => {
        if (!window.confirm('吊销设备「' + String(device) + '」的令牌?它将立即失联。')) return
        try { await jpost(PAIR_API + '/revoke', { jti }) } catch (e) { window.alert('吊销失败:' + String(e.message)) }
        try { setTokens(await jget(PAIR_API + '/tokens')) } catch (e) {}
      }
      const saveLabel = async () => {
        setLabelBusy(true)
        try {
          const r = await jpost(PAIR_API + '/label', { label: labelDraft })
          if (r && r.ok) setHostLabel(r)
          else window.alert('保存失败:' + String(r && r.error ? r.error : '未知错误'))
        } catch (e) { window.alert('保存失败:' + String(e.message)) }
        setLabelBusy(false)
      }
      const saveKey = async () => {
        setKeyBusy(true)
        try {
          const r = await jpost(PAIR_API + '/admin-key', { adminKey: keyDraft })
          if (r && r.ok) { setKeyDraft(''); setKeyInfo(r.configured === false ? { configured: false, editable: true } : { configured: true, masked: '', editable: true }) }
          else window.alert('保存失败:' + String(r && r.error ? r.error : '未知错误'))
        } catch (e) { window.alert('保存失败:' + String(e.message)) }
        setKeyBusy(false)
      }
      const saveTenantKey = async () => {
        setTenantBusy(true)
        try {
          const r = await jpost(PAIR_API + '/tenant-key', { tenantKey: tenantDraft })
          if (r && r.ok) { setTenantDraft(''); setTenantInfo(await jget(PAIR_API + '/tenant-key')) }
          else window.alert('保存失败:' + String(r && r.error ? r.error : '未知错误'))
        } catch (e) { window.alert('保存失败:' + String(e.message)) }
        setTenantBusy(false)
      }

      const saveWebPassword = async (clear) => {
        setWebBusy(true); setWebMsg(null)
        try {
          const r = clear
            ? await jpost(PAIR_API + '/web-password', { clear: true })
            : await jpost(PAIR_API + '/web-password', { password: webDraft })
          if (r && (r.ok === true || r.enabled !== undefined)) {
            setWebDraft('')
            setWebInfo(await jget(PAIR_API + '/web-password'))
            setWebMsg(clear ? '已清除(Web 面登录关闭)' : '已保存(旧会话全部失效)')
          } else {
            setWebMsg('失败:' + String(r && r.error ? r.error : '未知错误'))
          }
        } catch (e) { setWebMsg('失败:' + String(e.message)) }
        setWebBusy(false)
      }

      const h = R.createElement
      const esc = (s) => String(s ?? '')

      // ── 配对区(按会话状态)──
      const pairArea = (() => {
        if (pair === null) {
          // 扫码/粘贴邀请模式:QR 编码 publicUrl(锚定形态),手机发起的网关
          // 由二维码决定 —— 明示实际锚定的域名,防「手机手填了另一网关却被
          // 二维码覆盖」的误解(锚定是有意设计:防两边各打一个网关的错位)。
          const anchorHost = (() => {
            try { return new URL(modeInfo !== null && modeInfo.publicUrl ? modeInfo.publicUrl : '').host } catch { return '' }
          })()
          return h('div', { key: 'idle' }, [
            h('div', { key: 'row', className: 'dshm_row', style: { marginTop: '4px' } }, [
              h('button', { key: 'scan', type: 'button', className: 'dshm_btn', disabled: busy, onClick: startScan }, '配对手机(扫码)'),
            ]),
            h('div', { key: 'hint', className: 'dshm_dim', style: { marginTop: '6px' } },
              '二维码自带网关地址' + (anchorHost ? '(当前锚定 ' + anchorHost + ')' : '') +
              ' —— 手机扫码后连该网关,与其在 App 里手填的地址无关。App 相机扫码;或系统相机扫 → 落地页「复制」→ App 粘贴(同样以邀请里的网关为准)'),
          ])
        }
        if (pair.state === 'waiting' || pair.state === 'claimed') {
          return h('div', { key: 'wait' }, [
            pair.qr ? h('pre', { key: 'qr', className: 'dshm_qr' }, pair.qr) : null,
            h('div', { key: 'c', style: { marginTop: '10px' } }, [
              h('div', { key: 'cl', className: 'dshm_dim' }, '配对码'),
              h('div', { key: 'cv', className: 'dshm_code' }, pair.displayCode),
            ]),
            h('div', { key: 'hc', style: { marginTop: '8px' } }, [
              h('div', { key: 'hl', className: 'dshm_dim' }, '主机码(手机上点选一致的那个)'),
              h('div', { key: 'hv', className: 'dshm_code dshm_ok' }, pair.hostCode),
            ]),
            h('div', { key: 'st', className: 'dshm_dim', style: { marginTop: '10px' } },
              pair.state === 'waiting'
                ? (pair.mode === 'manual' ? '等网关确认手机在场…' : '等待手机粘贴邀请…(配对码 10 分钟内有效)')
                : '手机已就绪,等它在 App 里点选主机码…'),
            h('button', { key: 'cancel', type: 'button', className: 'dshm_btnWarn', style: { marginTop: '8px' }, onClick: stopPair }, '取消配对'),
          ])
        }
        if (pair.state === 'confirmed') {
          return h('div', { key: 'done' }, [
            h('div', { key: 'm', className: 'dshm_ok' }, '✅ 已配对:设备「' + esc(pair.device) + '」获得 30 天令牌。不是自己的手机?在下方立即吊销。'),
            h('button', { key: 'again', type: 'button', className: 'dshm_btn', style: { marginTop: '8px' }, onClick: () => setPair(null) }, '再配一台'),
          ])
        }
        // error / expired / timeout
        return h('div', { key: 'err' }, [
          h('div', { key: 'm', className: 'dshm_bad' }, '❌ ' + esc(pair.error || pair.state) + ' —— 请重新发起'),
          h('button', { key: 'retry', type: 'button', className: 'dshm_btn', style: { marginTop: '8px' }, onClick: () => setPair(null) }, '重新配对'),
        ])
      })()

      // ── 设备表 ── 排序:在线 → 离线 → 已吊销;已吊销默认折叠(下方
      // 按钮展开)。「隧道」列 = 形态徽章 + 落点(Rust=绑定端口,CF=
      // cloudflared 主机名);via 由服务端 /api/tokens 标注(令牌归属的
      // 网关),旧服务端无此字段时回落裸端口。
      const rowOf = (t) => h('tr', { key: t.jti }, [
        h('td', { key: 'd' }, esc(t.device)),
        h('td', { key: 'l' }, esc(t.host_label || '-')),
        h('td', { key: 'p' }, [
          t.via === 'cf'
            ? h('span', { key: 'tg', className: 'dshm_tag dshm_tagCf' }, 'CF')
            : t.via === 'rust'
              ? h('span', { key: 'tg', className: 'dshm_tag dshm_tagRust' }, 'Rust')
              : null,
          ' ' + (t.via === 'cf'
            ? (tunnel !== null && tunnel.cf != null && tunnel.cf.target !== '' ? esc(tunnel.cf.target) : 'cloudflared')
            : (t.upstream_port == null ? '-' : String(t.upstream_port))),
        ]),
        h('td', { key: 's' }, t.revoked
          ? h('span', { className: 'dshm_bad' }, '已吊销')
          : h('span', null, h('span', { className: t.connected ? 'dshm_dot dshm_on' : 'dshm_dot' }), t.connected ? '在线' : '离线')),
        h('td', { key: 'a' }, t.revoked ? null
          : h('button', { type: 'button', className: 'dshm_btnWarn', onClick: () => revoke(t.jti, t.device) }, '吊销')),
      ])
      const rankOf = (t) => (t.revoked ? 2 : t.connected ? 0 : 1)
      const sortedTokens = [...(tokens ?? [])].sort((a, b) => rankOf(a) - rankOf(b))
      const revokedCount = sortedTokens.filter((t) => t.revoked).length
      const visibleTokens = showRevoked ? sortedTokens : sortedTokens.filter((t) => !t.revoked)
      const deviceRows = visibleTokens.map(rowOf)
      // 开发期连通性验证(冒烟脚本 / 手工探测)签发的测试令牌:未吊销的
      // 识别到就在表下出说明,免得「来源 probe」被当成可疑设备。
      const hasProbeRow = sortedTokens.some((t) => !t.revoked &&
        /probe|smoke/i.test(String(t.device ?? '') + ' ' + String(t.host_label ?? '')))

      // ── 隧道行 ── /api/tunnel 的 cf/rust 两通道各自独立、可并存,有几条
      // 渲染几条;via 字段标「配对走这条」的那条(令牌/QR 都只存在于该网关)。
      const tunnelDesc = (via, s) => via === 'cf'
        ? (s.target === ''
            ? 'cloudflared 凭证缺失(先 cloudflared tunnel login/create)'
            : 'cloudflared ' + esc(s.target) + ' ⇄ 本机 :' + String(s.localPort))
        : esc(s.target) + ' ' + (s.remoteListen ?? '127.0.0.1:' + String(s.remotePort)) + ' ⇄ 本机 :' + String(s.localPort)
      const tunnelRow = (via, s) => h('div', { key: via, className: 'dshm_row', style: { marginTop: '6px' } }, [
        h('span', { key: 'd', className: s.up ? 'dshm_dot dshm_on' : 'dshm_dot' }),
        h('span', { key: 'tg', className: via === 'cf' ? 'dshm_tag dshm_tagCf' : 'dshm_tag dshm_tagRust' }, via === 'cf' ? 'CF' : 'Rust'),
        h('span', { key: 'x' }, (s.up ? '已连接' : '重连中(第 ' + String(s.attempts) + ' 次)') + '  ' + tunnelDesc(via, s)),
        tunnel !== null && tunnel.via === via
          ? h('span', { key: 'on', className: 'dshm_tag dshm_tagOn' }, '配对走这条')
          : null,
      ])
      const tunnelRows = tunnel === null ? null : [
        tunnel.rust != null ? tunnelRow('rust', tunnel.rust) : null,
        tunnel.cf != null ? tunnelRow('cf', tunnel.cf) : null,
      ].filter(Boolean)

      const dialog = !open ? null : h('div', {
        key: 'overlay', className: 'dshm_overlay',
        onClick: (e) => { if (e.target === e.currentTarget) setOpen(false) },
      }, h('div', { key: 'dialog', className: 'dshm_dialog', role: 'dialog', 'aria-label': 'DSH 移动接入' }, [
        h('div', { key: 'head', className: 'dshm_head' }, [
          h('span', { key: 't', className: 'dshm_title' }, 'DSH 移动接入'),
          h('button', { key: 'x', type: 'button', className: 'dshm_close', 'aria-label': '关闭', onClick: () => setOpen(false) }, '×'),
        ]),
        h('div', { key: 'body', className: 'dshm_body' }, [
          h('div', { key: 'h-tun', className: 'dshm_h2' }, '隧道'),
          h('div', { key: 'tun' }, tunnelRows === null
            ? h('div', { className: 'dshm_dim' }, '读取中…')
            : (tunnelRows.length === 0
                ? h('div', { className: 'dshm_dim' }, '(无隧道在跑 —— 检查 cordis.patch.yml 的 target / cfTunnelId 配置)')
                : tunnelRows)),
          h('div', { key: 'h-lab', className: 'dshm_h2' }, '机器名'),
          h('div', { key: 'lab', className: 'dshm_row' }, [
            h('input', {
              key: 'in', className: 'dshm_input', maxLength: 32, autoComplete: 'off',
              spellCheck: false, placeholder: '设备名称',
              value: labelDraft, onChange: (e) => setLabelDraft(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') saveLabel() },
            }),
            h('button', { key: 'go', type: 'button', className: 'dshm_btn', disabled: labelBusy || (hostLabel !== null && hostLabel.editable === false), onClick: saveLabel }, labelBusy ? '保存中…' : '保存'),
          ]),
          (tunnel === null || tunnel.via === 'cf') && h('div', { key: 'h-key', className: 'dshm_h2' }, '管理密钥(CF 形态)'),
          (tunnel === null || tunnel.via === 'cf') && h('div', { key: 'key', className: 'dshm_row' }, [
            h('input', {
              key: 'in', className: 'dshm_input', type: 'password', autoComplete: 'off', spellCheck: false,
              placeholder: keyInfo !== null && keyInfo.configured
                ? '已配置 ' + String(keyInfo.masked ?? '') + '(留空保存 = 清除)'
                : 'ADMIN_KEY(openssl rand -hex 32)',
              value: keyDraft, onChange: (e) => setKeyDraft(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') saveKey() },
            }),
            h('button', { key: 'go', type: 'button', className: 'dshm_btn', disabled: keyBusy || (keyInfo !== null && keyInfo.editable === false), onClick: saveKey }, keyBusy ? '保存中…' : '保存'),
          ]),
          (tunnel === null || tunnel.via === 'rust') && h('div', { key: 'h-tkey', className: 'dshm_h2' }, '租户密钥(Rust 网关多租户)'),
          (tunnel === null || tunnel.via === 'rust') && h('div', { key: 'tkey', className: 'dshm_row' }, [
            h('input', {
              key: 'in', className: 'dshm_input', type: 'password', autoComplete: 'off', spellCheck: false,
              placeholder: tenantInfo !== null && tenantInfo.configured
                ? '已配置 ' + String(tenantInfo.masked ?? '') + (tenantInfo.adminUrl ? '(经 ' + String(tenantInfo.adminUrl) + ')' : '') + '(留空保存 = 清除)'
                : '运营者签发的租户密钥(配 adminUrl 走 HTTPS 免 ssh)',
              value: tenantDraft, onChange: (e) => setTenantDraft(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') saveTenantKey() },
            }),
            h('button', { key: 'go', type: 'button', className: 'dshm_btn', disabled: tenantBusy || (tenantInfo !== null && tenantInfo.editable === false), onClick: saveTenantKey }, tenantBusy ? '保存中…' : '保存'),
          ]),
          webInfo !== null && webInfo.error === undefined && h('div', { key: 'h-web', className: 'dshm_h2' }, 'Web 远程访问(浏览器)'),
          webInfo !== null && webInfo.error === undefined && h('div', { key: 'web' }, [
            h('div', { key: 'st', className: 'dshm_dim' }, webInfo.enabled
              ? '已启用(来源 ' + esc(webInfo.source) + ',版本 v' + String(webInfo.version) + ')— 浏览器打开网关 web 域名,输此密码登录'
              : '未启用 —— 设置密码后,可用任意浏览器经网关安全访问本机 dsh'),
            h('div', { key: 'row', className: 'dshm_row', style: { marginTop: '6px' } }, [
              h('input', {
                key: 'in', className: 'dshm_input', type: 'password', autoComplete: 'new-password', spellCheck: false,
                placeholder: 'Web 访问密码(8-128 字符)', value: webDraft,
                onChange: (e) => setWebDraft(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter') saveWebPassword(false) },
              }),
              h('button', { key: 'go', type: 'button', className: 'dshm_btn', disabled: webBusy || webDraft.length < 8, onClick: () => saveWebPassword(false) }, webBusy ? '处理中…' : '保存'),
            ]),
            h('div', { key: 'act', className: 'dshm_row', style: { marginTop: '6px' } }, [
              webInfo.enabled
                ? h('button', { key: 'clr', type: 'button', className: 'dshm_btnWarn', disabled: webBusy, onClick: () => { if (window.confirm('清除 Web 密码?清除后浏览器远程访问关闭(未配 env 兜底时)。')) saveWebPassword(true) } }, '清除密码(关闭)')
                : null,
              webMsg === null ? null : h('span', { key: 'm', className: webMsg.startsWith('已') ? 'dshm_ok' : 'dshm_bad' }, esc(webMsg)),
            ]),
          ]),
          hostLabel !== null && hostLabel.editable === false
            ? h('div', { key: 'labn', className: 'dshm_dim', style: { marginTop: '4px' } }, '当前:' + esc(hostLabel.label) + '(此 dsh 版本不支持在线改名,用 cordis.patch.yml 的 label 配置)')
            : h('div', { key: 'labn', className: 'dshm_dim', style: { marginTop: '4px' } }, '手机端显示「已连接 <机器名>」;默认设备名,修改即时生效并持久化'),
          h('div', { key: 'h-pair', className: 'dshm_h2' }, '配对手机'),
          pairArea,
          pair === null ? h('div', { key: 'manual', style: { marginTop: '8px' } }, [
            h('div', { key: 'row', className: 'dshm_row' }, [
              h('input', {
                key: 'in', className: 'dshm_input', maxLength: 12, autoComplete: 'off',
                spellCheck: false, placeholder: '手机已生成配对码?输入 10 位码',
                value: manual, onChange: (e) => setManual(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter') startManual() },
              }),
              h('button', { key: 'go', type: 'button', className: 'dshm_btn', disabled: busy, onClick: startManual }, '应约'),
            ]),
            h('div', { key: 'hint', className: 'dshm_dim', style: { marginTop: '4px' } },
              '手输模式:手机在 App 里自选网关地址(以其手填为准)生成配对码;Mac 对两网关双发应约 —— 手机等在哪个网关,哪边成交'),
          ]) : null,
          actErr === null ? null : h('div', { key: 'ae', className: 'dshm_bad', style: { marginTop: '6px' } }, esc(actErr)),
          h('div', { key: 'h-dev', className: 'dshm_h2' }, '已配对设备'),
          tokensErr === null ? null : h('div', { key: 'te', className: 'dshm_bad' }, esc(tokensErr)),
          visibleTokens.length === 0 && tokensErr === null
            ? h('div', { key: 'empty', className: 'dshm_dim' }, tokens === null
                ? '读取中…'
                : (tokens.length === 0 ? '(尚无已发令牌)' : '(在用令牌为 0;已吊销设备已隐藏)'))
            : h('table', { key: 'tbl', className: 'dshm_table' }, [
                h('thead', { key: 'th' }, h('tr', null, [
                  h('th', { key: 'a' }, '设备'), h('th', { key: 'b' }, '来源'),
                  h('th', { key: 'c' }, '隧道'), h('th', { key: 'd' }, '状态'), h('th', { key: 'e' }, ''),
                ])),
                h('tbody', { key: 'tb' }, deviceRows),
              ]),
          revokedCount > 0
            ? h('div', { key: 'revokedToggle', style: { marginTop: '6px' } },
                h('button', {
                  type: 'button', className: 'dshm_btn',
                  onClick: () => setShowRevoked(!showRevoked),
                }, showRevoked ? '收起已吊销设备' : '展开已吊销设备(' + String(revokedCount) + ')'))
            : null,
          hasProbeRow
            ? h('div', { key: 'probeHint', className: 'dshm_dim', style: { marginTop: '6px' } },
                '说明:设备/来源含 probe、smoke 的行 = 开发期连通性验证(冒烟脚本或手工探测)签发的测试令牌,不是真实手机;确认无用可直接吊销。')
            : null,
          h('div', { key: 'foot', className: 'dshm_dim', style: { marginTop: '12px' } }, '管理 API 仅接受 loopback 来源;令牌吊销即时生效。在线 = 该设备当前持有事件 WebSocket。'),
        ]),
      ]))

      // ── foot 触发按钮(兼在线指示器)──
      const on = online > 0
      const label = on ? '移动接入 · ' + String(online) + ' 台在线' : '移动接入'
      return h(R.Fragment, null, [
        h('button', {
          key: 'trigger', type: 'button',
          className: (wide ? 'dshm_badge' : 'dshm_badge dshm_rail') + (on ? ' dshm_on' : ''),
          title: label, 'aria-label': label,
          onClick: () => setOpen(true),
        }, [
          h('span', { key: 'icon', className: 'dshm_icon', dangerouslySetInnerHTML: { __html: ICON } }),
          wide ? h('span', { key: 'label', className: 'dshm_label' }, '移动接入') : null,
          wide && on ? h('span', { key: 'count', className: 'dshm_count' }, String(online)) : null,
          !wide && on ? h('span', { key: 'rc', className: 'dshm_railCount' }, String(online)) : null,
        ]),
        dialog,
      ])
    }

    // 仅宿主本机界面加载:这是主机管理 UI(配对/令牌/Web 密码),远程访问
    // (网关 web 面)时管理通道 /pair/api 已被网关封禁,注册只会持续刷错。
    // 判据 = 页面 hostname 为 loopback(桌面 web / 本机访问)。
    function isLoopbackPage() {
      try {
        var h = (typeof location !== 'undefined' && location.hostname) || ''
        if (h === 'localhost' || h === '[::1]' || h === '::1') return true
        var m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h)
        return m !== null && Number(m[1]) === 127
      } catch (e) { return false }
    }

    function apply(ctx) {
      if (!isLoopbackPage()) return
      ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
        { name: 'sidebar.footer.action', id: 'dsh-mobile', order: 10, label: '移动接入' },
        MobileAccessAction,
      )), 'dsh-mobile: sidebar footer action')
    }

    // 客户端 ctx 的服务按声明暴露:ctx.slots 需要 inject: ['slots']
    // (契约示例同款;漏声明 → "cannot get property "slots" without inject")。
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  }
})
