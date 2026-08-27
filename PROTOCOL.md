# DSH-REMOTE P2P 协议(v1)

yltech.store 网关只做**配对 + WebRTC 信令**,不再中转任何业务流量。
手机 ↔ Mac 经 WebRTC DataChannel(SCTP/DTLS,自带加密)直连;
DataChannel 上跑虚拟字节流(vstream),Mac 侧落地回 `127.0.0.1:<dsh web 端口>`。

```
手机 App ──wss(signaling only)──→ yltech.store 网关 ←─wss─ Mac 插件 dsh-remote
   │                                                      │
   └────────── WebRTC DataChannel(直连,流量不经服务器)────┘
```

## 1. 信令(网关公开面,复用现有 TLS 反代)

WS 端点(均 JSON 文本帧):

| 端点 | 鉴权 | 说明 |
|---|---|---|
| `GET /signal/host?ticket=<jwt>` | host ticket(管理面签发) | Mac 常驻信令通道 |
| `GET /signal/client?token=<device-jwt>` | 设备令牌(配对签发) | 手机按需信令通道 |
| `GET /signal/caps` | 无 | 能力探测:`{"signaling":true,"ice":[...]}` |

**host ticket**:Mac 经 ssh 管理面 `POST /admin/signal/ticket {port}` 获取,
JWT claims `{sub:"dsh-host", port, iat, exp}`(TTL 900s,Mac 每 5min 刷新)。
port = 该宿主在网关注册的标识(沿用原隧道端口段,仅作路由键,不再有隧道)。

### 消息

- 手机→网关 `{"t":"connect"}`;网关按令牌绑定 port 找在线 host,找不到回
  `{"t":"error","error":"host-offline"}`;找到则生成 `sid`,回
  `{"t":"ack","sid":..,"ice":[...]}` 并向 host 转 `{"t":"offer-req","sid":..,"jti":..,"device":..}`。
- **Mac 是 offerer**(DataChannel 创建方):收到 offer-req 即建
  RTCPeerConnection + DataChannel `dsh`,等 ICE gathering 完成后发完整 offer
  (非 trickle);**手机是 answerer**:应用 offer 后 answer 由本地栈回调交付
  (libdatachannel 系:经 onLocalDescription;且其 answer 的 `a=setup` 为
  actpass,offerer 应用前需改写为 passive —— 两侧实现均已带此兼容)。
- 双向 SDP/ICE 统一封装:`{"t":"signal","sid":..,"data":{"type":"offer"|"answer"|"candidate",...}}`,
  网关按 sid 转发给对端。
- 任一侧断开 → 网关向对端发 `{"t":"bye","sid":..}`。
- 心跳:网关每 20s 发 `{"t":"ping"}`,60s 无 pong/上行即断。

网关只转发上述 JSON,**永不接触业务字节**。

## 2. DataChannel 虚拟流(vstream)

DataChannel `dsh`(ordered + reliable 默认)。二进制帧(**帧头 10 字节**,payload 从偏移 10 起):

```
magic   u8    = 0xD5
sid     u32   BE  虚拟流 id(发起侧分配;Mac 侧递增,手机侧递增,冲突不可能
                 —— 只有两侧各自的 OPEN 各自编号,帧方向已区分)
cmd     u8    1=OPEN 2=DATA 3=CLOSE 4=PING(保活,忽略)
len     u32   BE  payload 字节数
payload bytes
```

- DATA 帧 payload ≤ 16KB(SCTP 舒适区间,发送侧自行分片)。
- Mac 侧收到 OPEN → `net.connect(127.0.0.1:<dsh 端口>)` 起一条 TCP,
  双向泵;TCP 断 → 发 CLOSE。
- 手机侧:本地 `ServerSocket(127.0.0.1:0)`,每条 accepted 连接 = 一条
  vstream(OPEN→桥接)。App 的 baseUri = `http://127.0.0.1:<该端口>`,
  HttpClient/WS 零改动;Host 头天然 loopback,满足 dsh 信任围栏。

## 3. 回退与安全

- 打洞失败(对称 NAT 等)无 TURN 时连接失败:App 提示切回中转模式
  (旧 dsh-mobile 网关面仍在)。
- ICE 服务器:网关 env `DSH_GATEWAY_ICE_SERVERS`(JSON 数组,含
  `urls/username/credential`),经 `/signal/caps` 与 ack 下发。
- 信令安全 = 配对令牌 + 管理面 ssh 信任根,与原模型一致;
  业务通道安全 = DTLS-SRTP(WebRTC 强制)。
