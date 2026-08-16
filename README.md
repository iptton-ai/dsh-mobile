# dsh-mobile

DeepSeek Harness 的移动接入插件:一条命令把 Mac 侧的全部移动接入收进 dsh ——
SSH 反向隧道 + GUI 扫码配对 + 设备管理。配合移动客户端
[DeepseekHarnessApp](https://github.com/iptton-ai/DeepseekHarnessApp) 使用。

## 功能

- **隧道**:`dsh web` 启动即自动 `ssh -R`(断线退避重启,`--port 0` 也正确),dsh 退出即断;
- **主界面入口**:侧栏底部「移动接入」按钮(官方 `sidebar.footer.action` 座,与设置按钮同区;
  宽栏=图标+文字行,收起栏=36px 圆钮),点击弹**原生 React dialog**(同源直调管理 API,无
  iframe,dsw 主题变量染色)—— 浏览器半边由 package.json 的 `dsh.client` 声明自动收录进
  web boot 图,无需配置;
- **在线指示器**:入口按钮兼指示器 —— 有手机在线(持有事件 WebSocket)时点亮手机图标并
  显示台数(收起栏为角标数字);数据来自网关 tokens 清单的 `connected` 字段(M6.3 在线
  计数),常态 15s 轮询,dialog 打开时 4s,页面隐藏时暂停;
- **配对页**(原生 dialog 或直接开 `/pair` 页)—— 两种发起方式(双向亮码防抢注):
  - **扫码(推荐)**:点「配对手机」出二维码,App 内置相机直接扫
    (或系统相机扫 → 落地页「复制」→ App 粘贴)→ 绿卡点选即成;
  - **手输应约**:手机 App 先「生成配对码」,在本页输入框输入 10 位码点「应约」,
    本页显示主机码,回手机点选一致的那个(码不存在/过期快速失败);
- **机器名**:本机在手机端「已连接 xxx」里显示的名字。默认取设备 hostname,
  在 dialog/`/pair` 页随时可改(dsh-mobile settings 命名空间 `label` 字段,持久化进
  用户 settings 文档,改动即时生效 —— 新 claim、二维码 `l=` 参数与手机端展示同步);
- **设备管理**:已配对设备清单 + 一键吊销(30 天设备令牌)。

## 安装

```bash
dsh plugin --profile web add github:iptton-ai/dsh-mobile
```

然后把 [cordis.patch.yml](cordis.patch.yml) 里的 insert 段合并进
`~/.dsh/profiles/web/cordis.patch.yml`,config 按你的部署改
(target/remotePort/adminPort/publicUrl),重启 `dsh web`。

前置:`ssh <target>` 免密可登你的网关服务器(信任根 = 你的 ssh key:
能发起配对 = 有服务器权限,管理面公网不可达,只经 ssh 调用)。
服务端网关的部署说明见
[DeepseekHarnessApp](https://github.com/iptton-ai/DeepseekHarnessApp) 仓库。

## 环境变量(测试覆盖)

`DSH_MOBILE_TARGET` / `DSH_MOBILE_REMOTE_PORT` / `DSH_MOBILE_ADMIN_PORT` / `DSH_MOBILE_PUBLIC_URL` / `DSH_MOBILE_LABEL`

## 机器名与 `/pair/api/host`

手机 App 持设备令牌经网关隧道访问本插件(web 信任面内),连接就绪后
`GET /pair/api/host` → `{ok, label, hostname, port}`,取 `label` 显示「已连接 <机器名>」。
label 解析层级:**用户 settings 层**(`/pair` 页或 dsh 设置页编辑)> **组合 base**
(cordis.patch.yml 的 `label` config / `DSH_MOBILE_LABEL` 环境变量)> **设备 hostname**。
改名即时生效(无需重启),已发令牌的 `host_label` 快照不回填,手机端以 `/api/host` 为准。

## 安全模型

- 管理 API(`/pair/api/*`)仅接受 loopback Host(dsh 绑 0.0.0.0 也不暴露给局域网);
- 二维码内容 = 公网落地页 URL(fragment 携带配对码+主机码,不进服务器日志);
- 配对秘密 43 位只存在手机内存;令牌可随时吊销(本页或服务器管理面);
- 在线状态 = 该令牌当前是否持有下行 WS(网关内存计数,不落盘);ssh 调用带
  ControlMaster 复用(ControlPersist 10m),轮询不放大连接数。

MIT License.