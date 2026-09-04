# dsh-mobile(CF Worker 网关 + P2P)

DeepSeek Harness 的移动接入插件:网关(Cloudflare Worker,
[dsh-gateway-worker](https://github.com/iptton-ai/dsh-gateway-worker))只做
**配对 + WebRTC 信令**,业务流量全部手机 ↔ Mac 直连(DataChannel,DTLS
加密)—— 零中转、零隧道、零 ssh、零服务器。配合移动客户端
[DeepseekHarnessApp](https://github.com/iptton-ai/DeepseekHarnessApp) 使用。

```
手机 App ──wss(仅信令)──→ CF Worker 网关 ←─wss(仅信令)─ 本插件
   └────────── WebRTC DataChannel(直连,业务流量不经网关)──────────┘
```

- **配对**:扫码/手输(双向亮码防抢注);设备令牌由 Worker 签发/吊销,
  令牌绑定的 host 路由键只是登记标识;
- **直连**:Mac 是 offerer;手机 `connect` → Worker 派 sid → offer/answer/
  ICE 经信令面交换 → DataChannel `dsh` 建立;
- **虚拟流**:DataChannel 上的 vstream 二进制帧(OPEN/DATA/CLOSE,
  16KB 分片)多路复用 TCP 字节流,Mac 侧落地 `127.0.0.1:<dsh web 端口>`;
  手机侧同样起本地回环代理 —— 两端 HTTP/WebSocket 栈零改动;
- **UI**:侧栏 foot「移动接入」dialog:P2P 状态(信令通道/活跃会话/
  虚拟流计数)+ 机器名 + 配对 + 设备管理(链路徽章)+ 安全事件横幅
  (配对/吊销 OS 通知与角标)。

协议细节(信令消息 + vstream 帧格式)见 [PROTOCOL.md](PROTOCOL.md)。

## 安装

前置:
- **pnpm** 在 PATH 上(`dsh plugin` 本体只是对 profile 目录的 pnpm 转发器,
  没有 pnpm 直接报 127 退出);
- 网关 Worker 已部署且含信令面(`/signal/*` + `/admin/signal/ticket`);
- 手机 App 为支持 P2P 的版本(探测 `/signal/caps` 自动走直连)。

### 1. 装插件

```bash
dsh plugin --profile web add github:iptton-ai/dsh-mobile   # 或本地目录: add ./dsh-mobile
```

> **报 `ERR_PNPM_ADDING_TO_ROOT`?** profile 目录里已有 `pnpm-workspace.yaml`
> (比如已跑过一次 approve-builds),pnpm 会把它当 workspace、拒绝把依赖加到
> workspace root。两个解法任选:
> ① 命令尾追加 `-w`(dsh 转发器原样透传参数):
>    `dsh plugin --profile web add github:iptton-ai/dsh-mobile -w`;
> ② 在 profile 的 `pnpm-workspace.yaml` 加一行 `ignoreWorkspaceRootCheck: true`
>    后重跑原命令(以后 add/update 其他插件也不再问)。

### 2. 放行 node-datachannel 的安装脚本(必做,跳过 = 插件静默坏)

pnpm ≥ 10 默认**不执行依赖的 install 脚本**;本插件的 WebRTC 依赖
`node-datachannel` 全靠 install 脚本下载预编译原生二进制。跳过的后果是
**安装期零报错**:`dsh web` 启动时插件 import 崩,侧栏不出现「移动接入」
入口。在 **profile 目录**(缺省 `~/.dsh/profiles/web/`;设了 `DSH_HOME`
则在其下)执行:

```bash
cd ~/.dsh/profiles/web
pnpm approve-builds                     # ⚠️ 交互式命令,不带包名(见下);勾选 node-datachannel
dsh plugin --profile web install        # 重跑安装,补跑被跳过的脚本
```

> **报 `Command "approve-builds" not found`?** 两个常见原因:
> ① 给 `approve-builds` 传了包名 —— 它是交互式命令不接参数,带参会当成
>    "执行叫 approve-builds 的命令" 而报 `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL`;
> ② pnpm < 10 根本没有这个子命令(`pnpm -v` 确认)。
> **跨版本最稳的手写法**(不依赖该命令):直接编辑 profile 的
> `pnpm-workspace.yaml`,加入:
>
> ```yaml
> onlyBuiltDependencies:
>   - node-datachannel
> ```
>
> 然后重跑 `dsh plugin --profile web install`。

审批写入 profile 的 `pnpm-workspace.yaml` 持久生效,后续
`dsh plugin --profile web update` 不再丢。

### 3. 合并 patch + 填 config

把 [cordis.patch.yml](cordis.patch.yml) 的 insert 段(+ 前面的
`directory-picker` 禁用行)合并进 `~/.dsh/profiles/web/cordis.patch.yml`,
config 按你的部署改(键位见下节「配置」)。

### 4. 重启 `dsh web` 并验证

重启后 dsh web 侧栏底部出现**「移动接入」**入口即装好。没出现时按序查:
① `dsh web` 日志有无 `node-datachannel` import 报错(= 第 2 步被跳过);
② patch 合并是否完整(insert 段 + `directory-picker` 禁用行);
③ 改完 patch 后是否重启了 `dsh web`。

## 配置

cordis.patch.yml 的 `dsh-mobile` 行 config(`DSH_MOBILE_*` 环境变量可覆盖):

| 键 | 说明 | 默认 |
|---|---|---|
| `gateway` | CF Worker 网关地址(如 `https://dsh.example.com`) | 必填 |
| `adminKey` | 管理密钥(部署 Worker 时的 ADMIN_KEY,≥16 字符)。**优先级:env `DSH_MOBILE_ADMIN_KEY` > 面板「管理密钥」栏(用户 settings)> 此处 config** —— config 是明文模板位,profile yml 常随 dotfiles 同步,能不用就不用 | 必填* |
| `host` | 宿主路由键(多宿主各占一个;仅登记标识,无隧道语义) | `<短主机名>.p2p` |
| `publicUrl` | 扫码落地页 | `<gateway>/pair` |
| `label` | 机器名(缺省 hostname;面板可改,持久化) | — |
| `iceServers` | ICE 服务器(JSON 数组字符串;缺省公共 STUN,无 TURN;只作用于 Mac 侧 gather,手机侧由网关 `ICE_SERVERS` 下发) | 公共 STUN |

\* adminKey 三处任一有效即可;全缺时插件**不再拒绝加载**(2026-08-29 前
会在启动时 throw),配对/信令以运行时错误文案指路,面板「管理密钥」栏可补。

环境变量:`DSH_MOBILE_GATEWAY` / `DSH_MOBILE_ADMIN_KEY` / `DSH_MOBILE_HOST` /
`DSH_MOBILE_PUBLIC_URL` / `DSH_MOBILE_LABEL` / `DSH_MOBILE_ICE_SERVERS`

## 从中转版迁移

- 管理通道从「ssh 到网关服务器 loopback」换成「HTTPS+Bearer adminKey 直连
  Worker」:不再需要 `target`/`adminPort`,也不再依赖任何服务器与 ssh key;
- **adminKey 迁移(2026-08-29 修复)**:旧版在 webui「管理密钥」栏保存过的
  密钥存储在 dsh 用户 settings,升级后**自动沿用**(优先级 env > settings >
  config);此前一段时间(78974c0–6f1dd43)settings 值被静默忽略、缺 config
  即加载失败 —— 升级到本版后两个问题都不存在,面板密钥栏同步恢复;
- `remotePort`(服务器隧道口)→ `host`(路由键):多宿主仍各占一个,
  网关按它把手机信令路由到本宿主;
- 移除 ssh -R / cloudflared / Rust 网关 / CF Worker 中转面 / Web 远程访问
  (网关浏览器登录)/ 多租户免 ssh 通道 —— 服务器带宽占用归零;
- 旧(中转时代)配对的令牌绑定的是旧 tunnel_host,需重新配对一次。

打洞失败(对称 NAT 等)无 TURN 时连接失败;要 TURN 时给 `iceServers` 配
(或 Worker env `ICE_SERVERS`),经 `/signal/caps` 与 ack 下发。

## 安全模型

- 管理 API(`/pair/api/*`)仅接受 loopback Host + 同源三重门
  (Sec-Fetch-Site/Origin 双检、写操作强制 `x-dsh-mobile` 头、JSON 体限
  `application/json`);
- 网关管理面信任根 = ADMIN_KEY(Bearer);host ticket 为短时 JWT(900s);
- 业务通道安全 = DTLS(WebRTC 强制);信令安全 = 设备令牌 + ADMIN_KEY;
- 配对秘密只存在手机内存;令牌可随时吊销;安全事件(配对成交/吊销)
  OS 通知 + 面板横幅显性化。

## 端到端冒烟

```bash
npm install
GATEWAY=https://dsh.example.com ADMIN_KEY=<密钥> node tools/e2e-smoke.mjs   # 独立脚本模拟两侧
node tools/plugin-live-smoke.mjs                                            # 插件真实代码路径(读 /tmp/.dshgw_admin_key)
```

通过判据:消息经 P2P 通道原样返回(业务流量不经过 Worker)。

MIT License.
