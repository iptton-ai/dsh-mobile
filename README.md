# dsh-mobile

DeepSeek Harness 的移动接入插件:一条命令把 Mac 侧的全部移动接入收进 dsh ——
SSH 反向隧道 + GUI 扫码配对 + 设备管理。配合 singleman App 与 dsh-gateway 使用。

## 功能

- **隧道**:`dsh web` 启动即自动 `ssh -R`(断线退避重启,`--port 0` 也正确),dsh 退出即断;
- **配对页**:dsh web GUI 内 `/pair` —— 点「配对手机」出二维码,手机系统相机扫码 →
  落地页「复制」→ singleman 粘贴 → 绿卡点选即成(双向亮码防抢注,与网关语义一致);
- **设备管理**:已发令牌清单 + 一键吊销(30 天设备令牌,网关 SQLite 登记)。

## 安装

```bash
dsh plugin --profile web add github:<you>/dsh-mobile   # 或本地路径
```

然后把 `cordis.patch.yml` 里的 insert 段合并进 `~/.dsh/profiles/web/cordis.patch.yml`,
config 按部署改(target/remotePort/adminPort/publicUrl),重启 `dsh web`。

前置:网关已部署(dsh-gateway,Rust 服务);`ssh <target>` 免密可登(信任根 = 你的 ssh key:
能发起配对 = 有服务器权限,公网不可达的管理面只经 ssh 调用)。

## 环境变量(测试覆盖)

`DSH_MOBILE_TARGET` / `DSH_MOBILE_REMOTE_PORT` / `DSH_MOBILE_ADMIN_PORT` / `DSH_MOBILE_PUBLIC_URL`

## 安全模型

- 管理 API(`/pair/api/*`)仅接受 loopback Host(服务器绑 0.0.0.0 也不暴露给局域网);
- 二维码内容 = 公网落地页 URL(fragment 携带配对码+主机码,不进服务器日志);
- 配对秘密 43 位只存在手机内存;令牌可随时吊销(本页或网关管理面)。

MIT License.