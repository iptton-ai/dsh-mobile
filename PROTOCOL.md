# DSH-REMOTE P2P 协议(v1)

yltech.store 网关只做**配对 + WebRTC 信令**,不再中转任何业务流量。
手机 ↔ Mac 经 WebRTC DataChannel(SCTP/DTLS,自带加密)直连;
DataChannel 上跑虚拟字节流(vstream),Mac 侧落地回 `127.0.0.1:<dsh web 端口>`。

```
手机 App ──wss(signaling only)──→ 网关 ←─wss─ Mac 插件 dsh-mobile
   │                                    │
   └────────── WebRTC DataChannel(直连,流量不经服务器)──────┘
```

## 1. 信令(网关公开面,复用现有 TLS 反代)

WS 端点(均 JSON 文本帧):

| 端点 | 鉴权 | 说明 |
|---|---|---|
| `GET /signal/host?ticket=<jwt>` | host ticket(管理面签发) | Mac 常驻信令通道 |
| `GET /signal/client?token=<device-jwt>` | 设备令牌(配对签发) | 手机按需信令通道 |
| `GET /signal/caps` | 无 | 能力探测:`{"signaling":true,"ice":[...]}` |

**host ticket**:Mac 经管理面(公网 HTTPS + Bearer adminKey/租户钥)
`POST /admin/signal/ticket {"host":"<宿主路由键>"}` 获取,JWT claims
`{sub:"dsh-host", host, iat, exp}`(TTL 900s,Mac 每 5min 刷新)。
host = 宿主在网关的登记标识(如 `<主机名>.p2p`),仅作信令路由键,无隧道语义;
已登记宿主受租户归属仲裁(别家租户钥签不出它的 ticket,防宿主冒充)。

### 消息

- 手机→网关 `{"t":"connect"}`;网关按令牌绑定的 host 路由键
  (tokens.tunnel_host)找在线 host,找不到回
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
- 心跳:网关每 20s 发 `{"t":"ping"}`,客户端须回 `{"t":"pong"}`(实现层为
  DO 闹钟轮询全体套接字;**没有**「60s 静默掐断」计数 —— 网关只发不判)。

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

- 打洞失败(对称 NAT 等)无 TURN 时连接失败:**没有中转可退**(P2P-only,
  旧中转面已删除,网关对旧客户端一律 410 指路);需要打通时给 ICE 配 TURN。
- ICE 服务器(两侧来源不对称是现状):手机侧用网关 Worker env `ICE_SERVERS`
  (JSON 数组,含 `urls/username/credential`;空 = 公共 STUN)经 `/signal/caps`
  与 connect ack 下发;Mac 侧用插件 config `iceServers` / env
  `DSH_MOBILE_ICE_SERVERS`(本地 gather,不取网关下发)。
- 信令安全 = 设备令牌(手机)+ host ticket(管理面 ADMIN_KEY/租户钥签发,
  宿主归属仲裁);业务通道安全 = DTLS(WebRTC 强制)。
