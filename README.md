# dsh-mobile

DeepSeek Harness 的移动接入插件:一条命令把 Mac 侧的全部移动接入收进 dsh ——
SSH 反向隧道 + GUI 扫码配对 + 设备管理。配合移动客户端
[DeepseekHarnessApp](https://github.com/iptton-ai/DeepseekHarnessApp) 使用。

## 功能

- **隧道**:`dsh web` 启动即自动 `ssh -R`(断线退避重启,`--port 0` 也正确),dsh 退出即断;
  CF 形态再拉起 cloudflared,两通道独立并存 —— dialog 隧道区**有几条显示几条**
  (形态徽章 `Rust`/`CF` + 「配对走这条」标记);
- **主界面入口**:侧栏底部「移动接入」按钮(官方 `sidebar.footer.action` 座,与设置按钮同区;
  宽栏=图标+文字行,收起栏=36px 圆钮),点击弹**原生 React dialog**(同源直调管理 API,无
  iframe,dsw 主题变量染色)—— 浏览器半边由 package.json 的 `dsh.client` 声明自动收录进
  web boot 图,无需配置;
- **在线指示器**:入口按钮兼指示器 —— 有手机在线(持有事件 WebSocket)时点亮手机图标并
  显示台数(收起栏为角标数字);数据来自网关 tokens 清单的 `connected` 字段(M6.3 在线
  计数),常态 15s 轮询,dialog 打开时 4s,页面隐藏时暂停;
- **配对**(原生 dialog)—— 两种发起方式(双向亮码防抢注):
  - **扫码(推荐)**:点「配对手机」出二维码,App 内置相机直接扫
    (或系统相机扫 → 落地页「复制」→ App 粘贴)→ 绿卡点选即成;
  - **手输应约**:手机 App 先「生成配对码」,在 dialog 输入框输入 10 位码点「应约」,
    dialog 显示主机码,回手机点选一致的那个(码不存在/过期快速失败);
- **机器名**:本机在手机端「已连接 xxx」里显示的名字。默认取设备 hostname,
  在 dialog 随时可改(dsh-mobile settings 命名空间 `label` 字段,持久化进
  用户 settings 文档,改动即时生效 —— 新 claim、二维码 `l=` 参数与手机端展示同步);
- **设备管理**:已配对设备清单 + 一键吊销(30 天设备令牌);「隧道」列带形态徽章
  (令牌归属网关:`Rust`=绑定端口,`CF`=cloudflared 主机名)。

## 安装

```bash
dsh plugin --profile web add github:iptton-ai/dsh-mobile
```

然后把 [cordis.patch.yml](cordis.patch.yml) 里的整段(insert 段 + 前面的
`directory-picker` 禁用行)合并进 `~/.dsh/profiles/web/cordis.patch.yml`,
config 按你的部署改(target/remotePort/adminPort/publicUrl),重启 `dsh web`。

### 移动端目录浏览(为什么禁用 `directory-picker`)

App 里「添加工作区」需要 `host.listDirectory` / `host.createDirectory`,而官方
auto 选择器在桌面形态(loopback 绑定 + GUI 会话启动)会解析成 **native**
—— 宿主屏上弹 OS 对话框,远程客户端无法驱动,这两个 RPC 直接被拒
(`directory-picker-unavailable`)。模板里禁用 auto、成对挂上 browse 后端 +
browse 前端,手机即可浏览/下钻/新建文件夹选任意宿主路径;代价是桌面 web
「添加工作区」也从 OS 对话框变成网页内浏览(pick/browse 在上游是互斥设计)。

前置:`ssh <target>` 免密可登你的网关服务器(信任根 = 你的 ssh key:
能发起配对 = 有服务器权限,管理面公网不可达,只经 ssh 调用)。
服务端网关的部署说明见
[DeepseekHarnessApp](https://github.com/iptton-ai/DeepseekHarnessApp) 仓库。

### CF 形态(dsh-gateway-worker)

无服务器场景改用 Cloudflare Worker 网关:config 里给 `gateway`(Worker 网关
地址)+ `cfTunnelId`/`cfHostname`(cloudflared 隧道)即可。配对/设备管理直连
HTTPS、免 ssh;cloudflared 隧道**由本插件随 dsh web 拉起**(与 ssh 隧道同款
生命周期:断线退避重启、dsh web 退出即断、独立配置文件按运行时端口自动生成,
默认 `~/.cloudflared/dsh-mobile.yml`),不依赖任何机器级服务。`publicUrl` 指向
Worker 的 `/pair` 落地页。

**ADMIN_KEY 不进配置文件**:在「移动接入」dialog 的「管理密钥」
栏填写部署 Worker 时的 ADMIN_KEY —— 持久化在 dsh 用户层 settings,保存即
生效(配对传输动态判定,无需重启);GET 只回掩码不回显全值,留空保存即清除。

```yaml
- id: dsh-mobile
  name: 'dsh-mobile'
  config:
    gateway: https://gw.example.com
    cfTunnelId: <cloudflared tunnel UUID>
    cfHostname: mac-xxxx.example.com   # 隧道公网主机名(DNS 记录指向)
    publicUrl: https://gw.example.com/pair
```

插件外的一次性准备(仅三步,之后全自动):
`cloudflared tunnel login` → `cloudflared tunnel create <名>`(记下 UUID)
→ `cloudflared tunnel route dns <名> <cfHostname>`。

两形态可并存:保留 `target` 则 ssh 隧道照常(存量手机凭证继续可用),
webui 配对/设备管理走 CF —— 平滑迁移。Worker 网关部署
([Deploy Button / AGENT-DEPLOY.md](https://github.com/iptton-ai/dsh-gateway-worker))。

### 双网关并存的配对会合(claim 双发)

两形态同时配置时,配对 pending 只存在于手机 start 的那个网关(两网关 DB
不互通),打错网关的症状是「手机停在等待页,claim 404 no phone waiting」。
插件对 claim / status / 令牌清单 / 吊销一律**双发**到全部可用传输
(CF = `gateway`+ADMIN_KEY,Rust = ssh `target`):手机等在哪个网关,哪边
就成交,另一边的 404 忽略 —— 手输应约不再要求手机与 `publicUrl` 同网关;
令牌清单为两边合并(逐条带 `via` 徽章),吊销两边同发。`publicUrl` 仅作
扫码锚定(QR 编码它)与展示;唯一例外:扫码模式锚定 CF 而密钥缺失时仍
fail-closed 提示补钥(双发救不了锚定网关本身调不了)。

## 环境变量(测试覆盖)

`DSH_MOBILE_TARGET` / `DSH_MOBILE_REMOTE_PORT` / `DSH_MOBILE_ADMIN_PORT` / `DSH_MOBILE_PUBLIC_URL` / `DSH_MOBILE_LABEL`

## 机器名与 `/pair/api/host`

手机 App 持设备令牌经网关隧道访问本插件(web 信任面内),连接就绪后
`GET /pair/api/host` → `{ok, label, hostname, port}`,取 `label` 显示「已连接 <机器名>」。
label 解析层级:**用户 settings 层**(「移动接入」dialog 或 dsh 设置页编辑)> **组合 base**
(cordis.patch.yml 的 `label` config / `DSH_MOBILE_LABEL` 环境变量)> **设备 hostname**。
改名即时生效(无需重启),已发令牌的 `host_label` 快照不回填,手机端以 `/api/host` 为准。

## 安全模型

- 管理 API(`/pair/api/*`)仅接受 loopback Host(dsh 绑 0.0.0.0 也不暴露给局域网);
- 管理 API 同源三重门(防恶意网页跨源 CSRF):写操作强制 `x-dsh-mobile` 自定义头
  (跨源必过 CORS 预检)+ `Sec-Fetch-Site`/`Origin` 非同源即拒 + JSON 体限
  `application/json`;原生客户端(App / curl)不带浏览器头,不受影响;
- 经 ssh 的管理面调用 payload 一律 base64 传输、远端解码再喂 curl(不拼 shell
  字符串);`jti` 等入参做字符白名单(注入纵深);
- cloudflared 配置写入独立文件(默认 `~/.cloudflared/dsh-mobile.yml`),拒绝
  覆盖非本插件生成的配置;
- 二维码内容 = 公网落地页 URL(fragment 携带配对码+主机码,不进服务器日志);
- 配对秘密 43 位只存在手机内存;令牌可随时吊销(本页或服务器管理面);
- 在线状态 = 该令牌当前是否持有下行 WS(网关内存计数,不落盘);ssh 调用带
  ControlMaster 复用(ControlPersist 10m),轮询不放大连接数。

MIT License.
## 多宿主 / 多租户(2026-08-18)

两版网关均已支持「一个网关挂 N 台 dsh 宿主」与「多租户共享网关」(见各自仓库
`004` 迁移 / `tenants` 表)。插件侧的配合语义:

- **tokens 按本机归属过滤**:dialog 设备表/在线角标只统计绑定本机的令牌 ——
  Rust 形态按 `upstream_port === remotePort`,CF 形态按 `tunnel_host === cfHostname`
  (未配 cfHostname 时保守不过滤 = 单宿主旧语义)。多台 Mac 共用一个网关时,
  每台面板只见自己的设备;`upstream_port` 为 null 的密码登录令牌不在宿主面板展示。
- **Rust 多租户免 ssh 管理通道**:配置 `adminUrl`(网关公开管理面基址,如
  `https://gw.example.com`)+ 租户密钥(dialog「租户密钥」栏或
  `DSH_MOBILE_TENANT_KEY`/`DSH_MOBILE_ADMIN_URL` env)后,claim/status/tokens/
  revoke 走 HTTPS 直连网关公开面,网关按租户钥把全部操作围栏在本租户 ——
  不再依赖服务器 ssh(数据隧道的 `ssh -R` 仍需 target,租户通常配受限
  ssh 账号 + sshd `PermitListen` 钉死本宿主端口)。未配时回落传统 ssh 通道
  (运营者形态,行为不变)。
- **宿主端口分配**:同网关多台 Mac 各占一个 `remotePort`(Rust,13100–13199 段,
  运营者经 `/admin/hosts` 登记归属);CF 形态每台一个 cloudflared 隧道主机名
  (`/admin/hosts` 登记)。默认 13100 会撞车 —— 多机部署必改。
- 配对协议本身多宿主原生(同一码多 offers 手机点选),QR 邀请 URL 可带 `t=`
  租户参数锚定(网关侧过滤跨租户 offers);手输模式为开放配对,靠主机码 OOB 把关。
