# dsh-mobile(P2P)

DeepSeek Harness 的移动接入插件(p2p-only 重构版):网关只做
配对 + WebRTC 信令,**业务流量全部手机 ↔ Mac 直连**(DataChannel,
DTLS 加密),服务器零中转、零隧道。配合移动客户端
[DeepseekHarnessApp](https://github.com/iptton-ai/DeepseekHarnessApp) 使用。

```
手机 App ──wss(仅信令)──→ 网关 ←─wss(仅信令)─ 本插件
   └────────── WebRTC DataChannel(直连,流量不经服务器)──────────┘
```

- **配对**:扫码/手输(双向亮码防抢注);设备令牌仍由网关签发/吊销,
  令牌绑定的端口现在只是信令路由键;
- **直连**:Mac 是 offerer;手机 `connect` → 网关派 sid → offer/answer/
  ICE 经信令面交换 → DataChannel `dsh` 建立;
- **虚拟流**:DataChannel 上的 vstream 二进制帧(OPEN/DATA/CLOSE,
  16KB 分片)多路复用 TCP 字节流,Mac 侧落地 `127.0.0.1:<dsh web 端口>`;
  手机侧同样起本地回环代理 —— 两端 HTTP/WebSocket 栈零改动;
- **UI**:侧栏 foot「移动接入」dialog:P2P 状态(信令通道/活跃会话/
  虚拟流计数)+ 机器名 + 配对 + 设备管理(链路徽章 P2P 直连/中转/离线)
  + 安全事件横幅(配对/吊销 OS 通知与角标)。

协议细节(信令消息 + vstream 帧格式)见 [PROTOCOL.md](PROTOCOL.md)。

## 安装

```bash
dsh plugin --profile web add github:iptton-ai/dsh-mobile   # 或本地目录
cd <插件目录> && npm install   # node-datachannel 是预编译原生模块,必须装
```

把 [cordis.patch.yml](cordis.patch.yml) 的 insert 段(+ 前面的
`directory-picker` 禁用行)合并进 `~/.dsh/profiles/web/cordis.patch.yml`,
config 按你的部署改,重启 `dsh web`。

前置:
- 网关(dsh-mobile-gateway)已部署信令面(`/signal/*` +
  `/admin/signal/ticket`,signal 提交之后版本);
- `ssh <target>` 免密可登网关服务器(信任根 = ssh key;host ticket 经
  ssh 管理面签发,TTL 900s,插件每 5min 刷新);
- 手机 App 为支持 P2P 的版本(探测 `/signal/caps` 自动走直连)。

## 配置

cordis.patch.yml 的 `dsh-mobile` 行 config(`DSH_MOBILE_*` 环境变量可覆盖):

| 键 | 说明 | 默认 |
|---|---|---|
| `target` | ssh 别名(网关服务器) | 必填 |
| `adminPort` | 网关管理面端口(仅服务器本机;插件经 ssh 调用) | 8103 |
| `remotePort` | 宿主标识(信令路由键,13100-13199 每机一个;不再是隧道口) | 13100 |
| `publicUrl` | 扫码落地页 URL(网关公开 `/pair`;信令 WS 同域推导) | 必填 |
| `label` | 机器名(缺省 hostname;面板可改,持久化) | — |
| `iceServers` | ICE 服务器(JSON 数组字符串;缺省公共 STUN,无 TURN) | 公共 STUN |

环境变量:`DSH_MOBILE_TARGET` / `DSH_MOBILE_ADMIN_PORT` /
`DSH_MOBILE_REMOTE_PORT` / `DSH_MOBILE_PUBLIC_URL` / `DSH_MOBILE_LABEL` /
`DSH_MOBILE_ICE_SERVERS`

## 从中转版迁移(p2p-only 分支)

config 键与旧版同名,存量部署**改插件不改配置**即可;语义差异与移除项:

- **移除 ssh -R 反向隧道 / cloudflared / CF Worker 网关形态**:服务器不再
  承载业务流量,带宽占用 ≈0(几 KB 信令);`sockDir`/`gateway`/`cfTunnelId`/
  `cfHostname`/`adminKey`/`adminUrl`/`tenantKey` 等键全部失效;
- **移除 Web 远程访问(浏览器经网关登录)**:该功能依赖网关中转链路;
- **移除多租户免 ssh 管理通道**(`/admin/signal/ticket` 只在服务器本机
  管理面挂载,P2P 的 host ticket 必须走 ssh);
- `remotePort` 从「服务器隧道口」变为「信令路由键」—— 多宿主仍各占一个
  (13100-13199),网关按它把手机信令路由到本宿主;
- 旧客户端(仍持中转 WS 的 App 版本)在网关侧照常工作(回退形态),
  设备表以「中转」徽章标注;网关 `relay.rs` 保留给旧客户端。

打洞失败(对称 NAT 等)无 TURN 时连接失败:App 提示切回中转模式。
要 TURN 时给 `iceServers` 配(或网关 env `DSH_GATEWAY_ICE_SERVERS`),
经 `/signal/caps` 与 ack 下发。

## 安全模型

- 管理 API(`/pair/api/*`)仅接受 loopback Host + 同源三重门
  (Sec-Fetch-Site/Origin 双检、写操作强制 `x-dsh-mobile` 头、JSON 体限
  `application/json`);
- 经 ssh 的管理面调用 payload 一律 base64 传输(不拼 shell 字符串);
  host ticket 凭证不出服务器(JWT 网关侧签发);
- 业务通道安全 = DTLS(WebRTC 强制);信令安全 = 配对令牌 + ssh 信任根;
- 配对秘密 43 位只存在手机内存;令牌可随时吊销;安全事件(配对成交/
  吊销)OS 通知 + 面板横幅显性化。

## 端到端冒烟

```bash
npm install
GATEWAY=https://dsh.example.com ADMIN=http://127.0.0.1:8103 node tools/e2e-smoke.mjs
```

模拟「手机 connect → offer/answer → vstream 往返」全链路,通过判据为
消息经 P2P 通道原样返回(需网关管理面可达,经 ssh 转发本地端口)。

MIT License.
