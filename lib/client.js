// dsh-mobile client — 浏览器半边:侧栏 foot「移动接入(P2P)」入口 + dialog。
// 由 dsh-client-modules 按 package.json 的 dsh.client 声明收录进 __DSH_BOOT__,
// 经 /plugins/dsh-mobile/client.js 下发。本文件必须是「已构建 bundle」形态:
// window.__ModuleLoader__.load 包裹,工厂内只 require 静态注册表模块(react),
// 不出现裸 import/export —— 与内置插件下发的 client.js 一致。
//
// p2p-only 重构:无隧道区/中转服务器注册表/Web 密码区,新增
// 「P2P 状态」区(信令通道 + 活跃会话/虚拟流计数);入口按钮兼 P2P 在线
// 指示器(在线 = 活跃 DataChannel 会话数,数据源 /api/state)。
// 「管理密钥」区 2026-08-29 恢复(8176227 语义):adminKey 用户层持久化,
// 老用户升级迁移 + 明文 config 之外的落点。
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
      + '.dshm_table th{color:var(--dsw-alias-label-caption);text-transform:none;letter-spacing:.04em;font-weight:500;padding:5px 6px;border-bottom:1px solid var(--dsw-alias-border-l2);text-align:left;white-space:nowrap;width:1%}'
      + '.dshm_table td{color:var(--dsw-alias-label-primary);padding:6px;border-bottom:1px solid var(--dsw-alias-border-l1)}'
      + '.dshm_dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary);margin-right:5px;vertical-align:1px}'
      + '.dshm_dot.dshm_on{background:var(--dsw-alias-state-success-primary)}'
      // 链路徽章:P2P 直连(成功色)/ 中转(信息色,旧客户端回退形态)
      + '.dshm_tagP2p{display:inline-block;flex:none;padding:1px 7px;border-radius:999px;font-size:10px;line-height:14px;font-weight:600;letter-spacing:.02em;white-space:nowrap;background:color-mix(in srgb, var(--dsw-alias-state-success-primary, #61d47a) 18%, transparent);color:var(--dsw-alias-state-success-primary, #61d47a)}'
      + '.dshm_tagRelay{display:inline-block;flex:none;padding:1px 7px;border-radius:999px;font-size:10px;line-height:14px;font-weight:600;letter-spacing:.02em;white-space:nowrap;background:color-mix(in srgb, var(--dsw-alias-state-info-primary, #7ab0ff) 18%, transparent);color:var(--dsw-alias-state-info-primary, #7ab0ff)}'
      // 安全事件横幅/角标(2026-08-20 审计缓解:配对完成/吊销显性化)
      + '.dshm_sec{margin-top:10px;border:1px solid var(--dsw-alias-state-error-primary,#ff6b6b);background:color-mix(in srgb, var(--dsw-alias-state-error-primary,#ff6b6b) 10%, transparent);border-radius:10px;padding:10px 12px}'
      + '.dshm_secTitle{color:var(--dsw-alias-state-error-primary,#ff6b6b);font-weight:600;font-size:13px;line-height:18px}'
      + '.dshm_secItem{color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;margin-top:2px}'
      + '.dshm_alertChip{flex:none;color:var(--dsw-alias-state-error-primary,#ff6b6b);font-weight:700;font-size:12px;line-height:16px}'
      + '.dshm_railAlert{position:absolute;top:-3px;left:-3px;min-width:16px;height:16px;padding:0 4px;box-sizing:border-box;background:var(--dsw-alias-state-error-primary,#ff6b6b);color:#fff;border-radius:999px;font-size:10px;line-height:16px;text-align:center;font-weight:700}'
    const tagId = 'dsh-mobile/MobileAccessAction.module.css'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-mobile'
      tag.dataset.pluginCss = tagId
      tag.textContent = css
      document.head.appendChild(tag)
    }

    // 手机轮廓 + 直连链路图标(P2P)。
    const ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">'
      + '<rect x="4.25" y="1.75" width="7.5" height="12.5" rx="1.8" stroke="currentColor" stroke-width="1.3"/>'
      + '<line x1="6.9" y1="11.7" x2="9.1" y2="11.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>'
      + '<path d="M1.5 5.5c1.5-1.2 3-1.8 4.5-1.8M1.5 10.5c1.5 1.2 3 1.8 4.5 1.8M14.5 5.5c-1.5-1.2-3-1.8-4.5-1.8M14.5 10.5c-1.5 1.2-3 1.8-4.5 1.8" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" opacity=".65"/></svg>'

    // 与服务端 ws.register 的 pagePath 默认值对齐(/pair;App 侧硬编码
    // /pair/api/host,此前缀不可改)。
    const API = '/pair/api'

    async function jget(path) {
      const r = await fetch(path)
      if (!r.ok) throw new Error('HTTP ' + String(r.status))
      return r.json()
    }
    async function jpost(path, body) {
      const r = await fetch(path, {
        method: 'POST',
        headers: body === undefined
          ? { 'x-dsh-mobile': '1' }
          : { 'content-type': 'application/json', 'x-dsh-mobile': '1' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (!r.ok) throw new Error('HTTP ' + String(r.status))
      return r.json()
    }

    function MobileAccessAction({ wide }) {
      const [open, setOpen] = R.useState(false)
      const [tokens, setTokens] = R.useState(null)
      const [tokensErr, setTokensErr] = R.useState(null)
      const [pair, setPair] = R.useState(null)
      const [busy, setBusy] = R.useState(false)
      const [manual, setManual] = R.useState('')
      const [actErr, setActErr] = R.useState(null)
      const [hostLabel, setHostLabel] = R.useState(null)
      const [labelDraft, setLabelDraft] = R.useState('')
      const [labelBusy, setLabelBusy] = R.useState(false)
      // 管理密钥(settings 迁移恢复):/api/admin-key 只回掩码/来源。
      const [keyInfo, setKeyInfo] = R.useState(null)
      const [keyDraft, setKeyDraft] = R.useState('')
      const [keyBusy, setKeyBusy] = R.useState(false)
      const [p2p, setP2p] = R.useState(null)
      const [showRevoked, setShowRevoked] = R.useState(false)
      // 安全事件(/api/security-log):unack>0 时侧栏角标 + dialog 横幅。
      const [sec, setSec] = R.useState(null)

      // 在线数 = 活跃中转配对(默认链路)+ P2P DataChannel 会话(备选)。
      const online = R.useMemo(
        () => {
          const relayN = p2p && p2p.relay ? p2p.relay.pairs.filter((x) => x.ready).length : 0
          const p2pN = p2p && p2p.signal ? p2p.signal.sessions.filter((s) => s.open).length : 0
          return relayN + p2pN
        },
        [p2p],
      )
      const unack = sec !== null && typeof sec.unack === 'number' ? sec.unack : 0

      R.useEffect(() => {
        let alive = true
        const tick = async () => {
          if (document.hidden) return
          const [k, l, s, c, a] = await Promise.allSettled([
            jget(API + '/tokens'), jget(API + '/label'), jget(API + '/state'),
            jget(API + '/security-log'), jget(API + '/admin-key'),
          ])
          if (!alive) return
          if (k.status === 'fulfilled') { setTokens(k.value); setTokensErr(null) }
          else setTokensErr('读取失败:' + String(k.reason && k.reason.message ? k.reason.message : k.reason))
          if (l.status === 'fulfilled') {
            setHostLabel(l.value)
            setLabelDraft((prev) => (prev === '' ? String(l.value.label ?? '') : prev))
          }
          if (s.status === 'fulfilled') setP2p(s.value)
          // 旧服务端无此端点(404)→ sec 保持 null,横幅/角标静默不出现。
          if (c.status === 'fulfilled') setSec(c.value)
          if (a.status === 'fulfilled') setKeyInfo(a.value)
        }
        tick()
        const timer = window.setInterval(tick, open ? 4000 : 15000)
        return () => { alive = false; window.clearInterval(timer) }
      }, [open])

      R.useEffect(() => {
        if (pair === null || (pair.state !== 'waiting' && pair.state !== 'claimed')) return undefined
        const code = pair.code
        const timer = window.setInterval(async () => {
          try { setPair(await jget(API + '/pair-state?code=' + String(code))) } catch (e) { /* 404=会话已换 */ }
        }, 2000)
        return () => window.clearInterval(timer)
      }, [pair])

      R.useEffect(() => {
        if (!open) return undefined
        const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open])

      const startScan = async () => {
        setBusy(true); setActErr(null)
        try { setPair(await jpost(API + '/start')) }
        catch (e) { setActErr('发起失败:' + String(e.message)) }
        setBusy(false)
      }
      const startManual = async () => {
        setBusy(true); setActErr(null)
        try { setPair(await jpost(API + '/claim', { code: manual })) }
        catch (e) { setActErr('应约失败:' + String(e.message)) }
        setBusy(false)
      }
      const stopPair = async () => {
        try { await jpost(API + '/stop') } catch (e) {}
        setPair(null)
      }
      const revoke = async (jti, device) => {
        if (!window.confirm('吊销设备「' + String(device) + '」的令牌?它将立即失联。')) return
        try { await jpost(API + '/revoke', { jti }) } catch (e) { window.alert('吊销失败:' + String(e.message)) }
        try { setTokens(await jget(API + '/tokens')) } catch (e) {}
      }
      const saveLabel = async () => {
        setLabelBusy(true)
        try {
          const r = await jpost(API + '/label', { label: labelDraft })
          if (r && r.ok) setHostLabel(r)
          else window.alert('保存失败:' + String(r && r.error ? r.error : '未知错误'))
        } catch (e) { window.alert('保存失败:' + String(e.message)) }
        setLabelBusy(false)
      }

      const saveKey = async () => {
        setKeyBusy(true)
        try {
          const r = await jpost(API + '/admin-key', { adminKey: keyDraft })
          if (r && r.ok) {
            setKeyDraft('')
            try { setKeyInfo(await jget(API + '/admin-key')) } catch (e) {}
          } else window.alert('保存失败:' + String(r && r.error ? r.error : '未知错误'))
        } catch (e) { window.alert('保存失败:' + String(e.message)) }
        setKeyBusy(false)
      }

      const ackSecurity = async () => {
        try { await jpost(API + '/security-log/ack') } catch (e) {}
        try { setSec(await jget(API + '/security-log')) } catch (e) {}
      }

      const h = R.createElement
      const esc = (s) => String(s ?? '')

      // ── 中转状态区(默认链路)──
      const rly = p2p === null ? null : p2p.relay
      const relayArea = h('div', { key: 'relay' }, [
        h('div', { key: 'row', className: 'dshm_row' }, [
          h('span', { key: 'd', className: rly && rly.connected ? 'dshm_dot dshm_on' : 'dshm_dot' }),
          h('span', { key: 'tag', className: 'dshm_tagRelay' }, '中转'),
          h('span', { key: 't', className: 'dshm_dim' },
            rly === null ? '读取中…'
              : (rly.connected
                  ? '中转通道已连接 —— 手机经网关中转接入(默认链路)'
                  : '中转通道未连接(重连中;检查 adminKey 与网关 /relay)')),
        ]),
        rly && rly.pairs.length > 0 ? h('table', { key: 'tbl', className: 'dshm_table', style: { marginTop: '6px' } }, [
          h('thead', { key: 'th' }, h('tr', null, [
            h('th', { key: 'a' }, '设备'), h('th', { key: 'b' }, '数据腿'), h('th', { key: 'c' }, '虚拟流'),
          ])),
          h('tbody', { key: 'tb' }, rly.pairs.map((x) => h('tr', { key: x.rsid }, [
            h('td', { key: 'i' }, esc(x.device || x.rsid.slice(0, 8) + '…')),
            h('td', { key: 'd' }, h('span', null, h('span', { className: x.ready ? 'dshm_dot dshm_on' : 'dshm_dot' }), x.ready ? 'ready' : 'connecting')),
            h('td', { key: 'v' }, String(x.streams)),
          ]))),
        ]) : null,
      ])

      // ── P2P 状态区(备选直连)──
      const sig = p2p === null ? null : p2p.signal
      const p2pArea = h('div', { key: 'p2p' }, [
        h('div', { key: 'row', className: 'dshm_row' }, [
          h('span', { key: 'd', className: sig && sig.connected ? 'dshm_dot dshm_on' : 'dshm_dot' }),
          h('span', { key: 'tag', className: 'dshm_tagP2p' }, 'P2P'),
          h('span', { key: 't', className: 'dshm_dim' },
            sig === null ? '读取中…'
              : (sig.connected
                  ? '信令通道已连接 —— 等手机直连,业务流量不经服务器'
                  : '信令通道未连接(重连中;检查 ssh 管理通道与网关 /signal)')),
        ]),
        sig && sig.sessions.length > 0 ? h('table', { key: 'tbl', className: 'dshm_table', style: { marginTop: '6px' } }, [
          h('thead', { key: 'th' }, h('tr', null, [
            h('th', { key: 'a' }, '设备'), h('th', { key: 'b' }, 'DataChannel'), h('th', { key: 'c' }, '虚拟流'),
          ])),
          h('tbody', { key: 'tb' }, sig.sessions.map((s) => h('tr', { key: s.sid }, [
            h('td', { key: 'i' }, esc(s.device || s.sid.slice(0, 8) + '…')),
            h('td', { key: 'd' }, h('span', null, h('span', { className: s.open ? 'dshm_dot dshm_on' : 'dshm_dot' }), s.open ? 'open' : esc(s.state))),
            h('td', { key: 'v' }, String(s.streams)),
          ]))),
        ]) : null,
        h('div', { key: 'hint', className: 'dshm_dim', style: { marginTop: '4px' } },
          '配对仍经网关(令牌签发/吊销);连接建立后手机 ↔ 本机 WebRTC 直连(DTLS 加密)。'),
      ])

      // ── 配对区(按会话状态)──
      const pairArea = (() => {
        if (pair === null) {
          return h('div', { key: 'idle' }, [
            h('div', { key: 'row', className: 'dshm_row', style: { marginTop: '4px' } }, [
              h('button', { key: 'scan', type: 'button', className: 'dshm_btn', disabled: busy, onClick: startScan }, '配对手机(扫码)'),
            ]),
            h('div', { key: 'hint', className: 'dshm_dim', style: { marginTop: '6px' } },
              '二维码编码网关配对入口 —— 手机扫码后与网关完成配对,之后经 P2P 直连本机。'),
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
        return h('div', { key: 'err' }, [
          h('div', { key: 'm', className: 'dshm_bad' }, '❌ ' + esc(pair.error || pair.state) + ' —— 请重新发起'),
          h('button', { key: 'retry', type: 'button', className: 'dshm_btn', style: { marginTop: '8px' }, onClick: () => setPair(null) }, '重新配对'),
        ])
      })()

      // ── 设备表 ──
      const rowOf = (t) => h('tr', { key: t.jti }, [
        h('td', { key: 'd' }, esc(t.device)),
        h('td', { key: 'l' }, esc(t.host_label || '-')),
        h('td', { key: 'p' }, t.link === 'p2p'
          ? h('span', { key: 'p2p', className: 'dshm_tagP2p', title: 'WebRTC DataChannel 直连,流量不经服务器' }, 'P2P 直连')
          : t.link === 'relay'
            ? h('span', { key: 'rl', className: 'dshm_tagRelay', title: '经网关服务器中转(默认链路,P2P 不稳定网络的兜底)' }, '中转')
            : h('span', { key: 'off', className: 'dshm_dim' }, '—')),
        h('td', { key: 's' }, t.revoked
          ? h('span', { className: 'dshm_bad' }, '已吊销')
          : h('span', null, h('span', { className: t.link ? 'dshm_dot dshm_on' : 'dshm_dot' }), t.link ? '在线' : '离线')),
        h('td', { key: 'a' }, t.revoked ? null
          : h('button', { type: 'button', className: 'dshm_btnWarn', onClick: () => revoke(t.jti, t.device) }, '吊销')),
      ])
      const rankOf = (t) => (t.revoked ? 2 : t.link ? 0 : 1)
      const sortedTokens = [...(tokens ?? [])].sort((a, b) => rankOf(a) - rankOf(b))
      const revokedCount = sortedTokens.filter((t) => t.revoked).length
      const visibleTokens = showRevoked ? sortedTokens : sortedTokens.filter((t) => !t.revoked)
      const deviceRows = visibleTokens.map(rowOf)

      // ── 安全事件横幅(未确认事件存在时置顶显示;数据源 /api/security-log)──
      const SEC_LABEL = { paired: '新设备完成配对', revoked: '设备令牌被吊销' }
      const secEvents = sec !== null && Array.isArray(sec.events) ? sec.events.filter((e) => !e.acked) : []
      const secBanner = secEvents.length === 0 ? null : h('div', { key: 'secBanner', className: 'dshm_sec' }, [
        h('div', { key: 't', className: 'dshm_secTitle' },
          '⚠ 安全事件未确认(' + String(secEvents.length) + ')— 若非你本人操作,请立即吊销设备'),
        ...secEvents.slice(-5).reverse().map((e) => h('div', { key: 'e' + String(e.id), className: 'dshm_secItem' },
          new Date(e.at).toLocaleTimeString() + ' · ' + String(SEC_LABEL[e.kind] || e.kind) + ' · ' + esc(e.detail))),
        h('button', { key: 'ok', type: 'button', className: 'dshm_btn', style: { marginTop: '8px' }, onClick: ackSecurity },
          '知道了(均为本人操作)'),
      ])

      const dialog = !open ? null : h('div', {
        key: 'overlay', className: 'dshm_overlay',
        onClick: (e) => { if (e.target === e.currentTarget) setOpen(false) },
      }, h('div', { key: 'dialog', className: 'dshm_dialog', role: 'dialog', 'aria-label': 'DSH 移动接入(P2P)' }, [
        h('div', { key: 'head', className: 'dshm_head' }, [
          h('span', { key: 't', className: 'dshm_title' }, 'DSH 移动接入(P2P)'),
          h('button', { key: 'x', type: 'button', className: 'dshm_close', 'aria-label': '关闭', onClick: () => setOpen(false) }, '×'),
        ]),
        h('div', { key: 'body', className: 'dshm_body' }, [
          secBanner,
          h('div', { key: 'h-relay', className: 'dshm_h2' }, '连接状态'),
          relayArea,
          h('div', { key: 'h-p2p', className: 'dshm_h2' }, 'P2P 备选'),
          p2pArea,
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
          hostLabel !== null && hostLabel.editable === false
            ? h('div', { key: 'labn', className: 'dshm_dim', style: { marginTop: '4px' } }, '当前:' + esc(hostLabel.label) + '(此 dsh 版本不支持在线改名)')
            : h('div', { key: 'labn', className: 'dshm_dim', style: { marginTop: '4px' } }, '手机端显示「已连接 <机器名>」;默认设备名,修改即时生效并持久化'),
          h('div', { key: 'h-key', className: 'dshm_h2' }, '管理密钥'),
          h('div', { key: 'key', className: 'dshm_row' }, [
            h('input', {
              key: 'in', className: 'dshm_input', type: 'password', maxLength: 128,
              autoComplete: 'off', spellCheck: false, placeholder: '网关 ADMIN_KEY(openssl rand -hex 32)',
              value: keyDraft, onChange: (e) => setKeyDraft(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') saveKey() },
            }),
            h('button', {
              key: 'go', type: 'button', className: 'dshm_btn',
              disabled: keyBusy || (keyInfo !== null && keyInfo.editable === false),
              onClick: saveKey,
            }, keyBusy ? '保存中…' : '保存'),
          ]),
          h('div', { key: 'keyn', className: 'dshm_dim', style: { marginTop: '4px' } },
            keyInfo === null ? '管理密钥状态读取中…'
              : keyInfo.fromEnv ? '已由 DSH_MOBILE_ADMIN_KEY 环境变量生效(面板值不参与)'
              : keyInfo.configured
                ? '已配置 ' + esc(keyInfo.masked) + '(留空保存 = 清除,回落 cordis.patch.yml;env 变量更优先)'
                : '未配置 —— 配对与信令不可用;保存在本机 dsh 用户设置,不进配置文件'),
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
                  h('th', { key: 'c' }, '链路'), h('th', { key: 'd' }, '状态'), h('th', { key: 'e' }, ''),
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
          h('div', { key: 'foot', className: 'dshm_dim', style: { marginTop: '12px' } }, '管理 API 仅接受 loopback 来源;令牌吊销即时生效。在线 = 当前持有活跃 P2P 会话。'),
        ]),
      ]))

      const on = online > 0
      const label = (on ? '移动接入 · ' + String(online) + ' 台直连' : '移动接入')
        + (unack > 0 ? ' · ⚠ 未确认安全事件 ' + String(unack) : '')
      return h(R.Fragment, null, [
        h('button', {
          key: 'trigger', type: 'button',
          className: (wide ? 'dshm_badge' : 'dshm_badge dshm_rail') + (on ? ' dshm_on' : ''),
          title: label, 'aria-label': label,
          onClick: () => setOpen(true),
        }, [
          h('span', { key: 'icon', className: 'dshm_icon', dangerouslySetInnerHTML: { __html: ICON } }),
          wide ? h('span', { key: 'label', className: 'dshm_label' }, '移动接入') : null,
          wide ? h('span', { key: 'right', style: { marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: '6px', flex: 'none' } }, [
            on ? h('span', { key: 'count', className: 'dshm_count', style: { marginLeft: 0 } }, String(online)) : null,
            unack > 0 ? h('span', { key: 'al', className: 'dshm_alertChip' }, '⚠ ' + String(unack)) : null,
          ]) : null,
          !wide && on ? h('span', { key: 'rc', className: 'dshm_railCount' }, String(online)) : null,
          !wide && unack > 0 ? h('span', { key: 'ra', className: 'dshm_railAlert' }, '!') : null,
        ]),
        dialog,
      ])
    }

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
        { name: 'sidebar.footer.action', id: 'dsh-mobile', order: 9, label: '移动接入(P2P)' },
        MobileAccessAction,
      )), 'dsh-mobile: sidebar footer action')
    }

    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  }
})
