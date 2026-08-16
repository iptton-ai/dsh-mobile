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
      + '.dshm_rail{position:relative;border-radius:50%;justify-content:center;gap:0;width:36px;height:36px;padding:0}'
      + '.dshm_rail .dshm_icon svg{width:18px;height:18px}'
      + '.dshm_railCount{position:absolute;top:-2px;right:-2px;min-width:15px;height:15px;padding:0 3px;box-sizing:border-box;background:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-bg-canvas-solid,var(--dsw-alias-bg-base));border-radius:999px;font-size:10px;line-height:15px;text-align:center;font-variant-numeric:tabular-nums}'
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
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
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

      const online = R.useMemo(
        () => (tokens ?? []).filter((t) => t.connected && !t.revoked).length,
        [tokens],
      )

      // 常态轮询:tokens(经 ssh,开销由 ControlPersist 复用摊薄)+ tunnel/label(本地)。
      R.useEffect(() => {
        let alive = true
        const tick = async () => {
          if (document.hidden) return
          const [t, k, l, a] = await Promise.allSettled([
            jget(PAIR_API + '/tunnel'), jget(PAIR_API + '/tokens'), jget(PAIR_API + '/label'), jget(PAIR_API + '/admin-key'),
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

      const h = R.createElement
      const esc = (s) => String(s ?? '')

      // ── 配对区(按会话状态)──
      const pairArea = (() => {
        if (pair === null) {
          return h('div', { key: 'idle', className: 'dshm_row', style: { marginTop: '4px' } }, [
            h('button', { key: 'scan', type: 'button', className: 'dshm_btn', disabled: busy, onClick: startScan }, '配对手机(扫码)'),
            h('span', { key: 'hint', className: 'dshm_dim' }, 'App 相机扫码;或系统相机扫 → 落地页「复制」→ App 粘贴'),
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

      // ── 设备表 ──
      const deviceRows = (tokens ?? []).map((t) => h('tr', { key: t.jti }, [
        h('td', { key: 'd' }, esc(t.device)),
        h('td', { key: 'l' }, esc(t.host_label || '-')),
        h('td', { key: 'p' }, t.upstream_port == null ? '-' : String(t.upstream_port)),
        h('td', { key: 's' }, t.revoked
          ? h('span', { className: 'dshm_bad' }, '已吊销')
          : h('span', null, h('span', { className: t.connected ? 'dshm_dot dshm_on' : 'dshm_dot' }), t.connected ? '在线' : '离线')),
        h('td', { key: 'a' }, t.revoked ? null
          : h('button', { type: 'button', className: 'dshm_btnWarn', onClick: () => revoke(t.jti, t.device) }, '吊销')),
      ]))

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
          h('div', { key: 'tun', className: 'dshm_dim' }, tunnel === null ? '读取中…' : [
            h('span', { key: 'd', className: tunnel.up ? 'dshm_dot dshm_on' : 'dshm_dot' }),
            tunnel.mode === 'cloudflared'
              ? (tunnel.up ? '隧道已连接' : '重连中(第 ' + String(tunnel.attempts) + ' 次)') + '  cloudflared ' + esc(tunnel.target) + ' ⇄ 本机 :' + String(tunnel.localPort)
              : (tunnel.up ? '已连接' : '重连中(第 ' + String(tunnel.attempts) + ' 次)') + '  ' + esc(tunnel.target) + ' 127.0.0.1:' + String(tunnel.remotePort) + ' ⇄ 本机 :' + String(tunnel.localPort),
          ]),
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
          (tunnel === null || tunnel.mode === 'cloudflared') && h('div', { key: 'h-key', className: 'dshm_h2' }, '管理密钥(CF 形态)'),
          (tunnel === null || tunnel.mode === 'cloudflared') && h('div', { key: 'key', className: 'dshm_row' }, [
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
          hostLabel !== null && hostLabel.editable === false
            ? h('div', { key: 'labn', className: 'dshm_dim', style: { marginTop: '4px' } }, '当前:' + esc(hostLabel.label) + '(此 dsh 版本不支持在线改名,用 cordis.patch.yml 的 label 配置)')
            : h('div', { key: 'labn', className: 'dshm_dim', style: { marginTop: '4px' } }, '手机端显示「已连接 <机器名>」;默认设备名,修改即时生效并持久化'),
          h('div', { key: 'h-pair', className: 'dshm_h2' }, '配对手机'),
          pairArea,
          pair === null ? h('div', { key: 'manual', className: 'dshm_row', style: { marginTop: '8px' } }, [
            h('input', {
              key: 'in', className: 'dshm_input', maxLength: 12, autoComplete: 'off',
              spellCheck: false, placeholder: '手机已生成配对码?输入 10 位码',
              value: manual, onChange: (e) => setManual(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') startManual() },
            }),
            h('button', { key: 'go', type: 'button', className: 'dshm_btn', disabled: busy, onClick: startManual }, '应约'),
          ]) : null,
          actErr === null ? null : h('div', { key: 'ae', className: 'dshm_bad', style: { marginTop: '6px' } }, esc(actErr)),
          h('div', { key: 'h-dev', className: 'dshm_h2' }, '已配对设备'),
          tokensErr === null ? null : h('div', { key: 'te', className: 'dshm_bad' }, esc(tokensErr)),
          (tokens ?? []).length === 0 && tokensErr === null
            ? h('div', { key: 'empty', className: 'dshm_dim' }, tokens === null ? '读取中…' : '(尚无已发令牌)')
            : h('table', { key: 'tbl', className: 'dshm_table' }, [
                h('thead', { key: 'th' }, h('tr', null, [
                  h('th', { key: 'a' }, '设备'), h('th', { key: 'b' }, '来源'),
                  h('th', { key: 'c' }, '隧道'), h('th', { key: 'd' }, '状态'), h('th', { key: 'e' }, ''),
                ])),
                h('tbody', { key: 'tb' }, deviceRows),
              ]),
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

    function apply(ctx) {
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
