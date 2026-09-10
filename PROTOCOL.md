# DSH-REMOTE 协议(v2:中转为默认,P2P 备选)

yltech.store 网关做**配对 + 信令 + WS 中转**。数据链路两种,同构共用
vstream 帧格式:

- **中转(默认,2026-09-10 还原)**:vstream 帧经网关 WS 转发。P2P 在
  办公网(UDP 过滤)/蜂窝(无公网 IP)环境下不可用,中转是唯一可靠路径。
- **P2P 直连(备选)**:WebRTC DataChannel(SCTP/DTLS),流量不经服务器;
  信令面原样保留,网络条件允许时仍可用。

```
中转(默认):
手机 App ──wss /relay/client──→ 网关 DO ←─wss /relay/host(数据腿)── Mac 插件
                                  ↑ wss /relay/host(控制腿,常驻)───────┘

P2P(备选):
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

## 3. WS 中转(默认数据链路,2026-09-10 还原)

WS 端点(JSON 文本帧 + 二进制 vstream 帧,与信令同一 DO):

| 端点 | 鉴权 | 说明 |
|---|---|---|
| `GET /relay/host?ticket=<jwt>` | host ticket | Mac **控制腿**(常驻;无 rsid 参数) |
| `GET /relay/host?ticket=<jwt>&rsid=<id>` | host ticket + rsid 行归属 | Mac **数据腿**(每对手机一条) |
| `GET /relay/client?token=<device-jwt>&rsid=<id>` | 设备令牌 | 手机数据腿;rsid 由**手机生成**(`[A-Za-z0-9-]{8,64}`) |

配对流(全由手机发起,宿主被动):

1. Mac 控制腿常驻(票据鉴权同信令面;同 host key 新连接顶旧 1008)。
2. 手机带自生成 `rsid` 连 `/relay/client`;网关按令牌 tunnel_host 找
   在线控制腿:无 → 升级前 503 `host-offline`;有 → 落 `relay_pairs` 行
   (rsid→host_key,休眠安全)→ 手机回 `{"t":"ack"}` → 控制腿收
   `{"t":"relay-open","rsid":..,"jti":..,"device":..}`。
3. Mac 收 relay-open 即拨数据腿(`/relay/host?ticket&rsid`);网关校验
   rsid 行存在且归属本宿主(防跨宿主抢占)→ **双方**收 `{"t":"ready"}`。
4. ready 后:二进制消息 = vstream 帧(§2 同格式),网关逐帧透传
   (tag 即路由,零拷贝);每消息恰一帧(WS 消息边界与 DataChannel 同构)。

清理语义:

- 任一数据腿断 → 网关关对端 + 删行;手机重连拿**新 rsid** 从头走配对流。
- 控制腿断 **不拆**既有配对(票据刷新抖动无害);宿主真死则数据腿必同死
  自愈;半开配对由网关 20s 告警清扫(数据腿 90s 不建立即回收)。
- 心跳:与信令面共用(网关 20s ping,客户端回 pong)。
- 安全:手机腿 = 设备令牌(路由被 tokenRoute 锚死在配对宿主);数据腿 =
  ticket + rsid 行归属双重校验;网关对 vstream 帧内容不解析不落盘。

## 4. 回退与安全

- 打洞失败(对称 NAT / UDP 被过滤)时直接走中转(默认);中转与 P2P 共用
  vstream 帧,手机侧本地代理与 Mac 侧泵对载体无感知。旧 HTTP 中转面
  (Host 改写直通 dsh)已由 /relay/* 取代,旧路径 410 指路。
- ICE 服务器(两侧来源不对称是现状):手机侧用网关 Worker env `ICE_SERVERS`
  (JSON 数组,含 `urls/username/credential`;空 = 公共 STUN)经 `/signal/caps`
  与 connect ack 下发;Mac 侧用插件 config `iceServers` / env
  `DSH_MOBILE_ICE_SERVERS`(本地 gather,不取网关下发)。
- 信令安全 = 设备令牌(手机)+ host ticket(管理面 ADMIN_KEY/租户钥签发,
  宿主归属仲裁);P2P 业务通道安全 = DTLS(WebRTC 强制);中转业务通道
  安全 = WSS(TLS 到网关)+ 网关→宿主 WSS;vstream 内容对网关不透明解析,
  但** confidentiality 信任边界包含网关**(与 P2P 不同,自部署时知悉)。
