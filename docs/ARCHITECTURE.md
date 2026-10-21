# 架构

本文描述公开 alpha 的架构，仅覆盖 DSH 侧桥接。

## 组件

1. **Hub**（`src/hub.mjs`、`hub/main.mjs`）
   - 只绑定 `127.0.0.1` 的 TCP 服务。
   - 基于 token 的消息认证。
   - 持久状态在 `.local/runtime/hub/`（`state.json`、`events.jsonl`）。
   - 消息生命周期：`queued` → `delivering` → `delivered` / `delivery_unknown` / `failed` / `expired`。
   - 重试/退避、按 message id 去重、TTL 过期、配对白名单。
   - 仅当目标身份已配对且启用时，才投递给目标 role 的已连接 adapter。

2. **DSH 宿主插件**（`adapters/dsh/plugin.mjs`）
   - 由 profile patch 加载的 Cordis 模块。
   - 向宿主注册出站工具（`bridge_send`、`bridge_status`、`bridge_targets`）。
   - 接收 Hub 的入站投递，对精确的存活 DSH 会话调用宿主 `agent.followup`。
   - 等到 durable inbox 事件（`agent/inbox/spliced`）后才 ACK 投递。
   - Hub 不可用时每几秒重连；可选 Hub 缺失绝不能让宿主崩溃。

3. **CLI**（`bin/lab-bridge.mjs`）
   - `init`、`check`、`send`、`status`、`pair`、`consume`。
   - 可逆 profile 安装：`install-dsh-plugin`、`uninstall-dsh-plugin`、`dsh-plugin-status`、`module-watch-status`。

## 投递语义

- Hub `accepted` 只表示消息已持久入队。
- `delivered` 表示目标 adapter 已确认；DSH 侧只有在观察到 durable inbox 事件后才算确认。
- 启动模型 turn 是宿主 `agent.followup` 的属性；桥接报告投递，不报告任务完成。
- 冷/未加载的 DSH 会话返回可重试的 `session-not-live`；消息留在队列，不消耗 attempts。
- `delivery_unknown` 表示 Hub 无法证明投递成功；不要假装成功。

## 信任边界

- 仅 loopback 监听；没有远程 HTTP/WS API。
- bearer token 在 `.local/`；永不提交。
- 配对是授权白名单。身份字符串是本地标识，不是密码学身份。
- 插件运行在 DSH 宿主进程内；只有安装器会修改 profile，并保留备份。

## 状态布局

```text
.local/
  runtime/
    hub/        # 配置、令牌、state.json、events.jsonl
    dsh-plugin/ # 安装备份、module-watch 状态、plugin.log
```

`.local/` 已被 gitignore；运行时密钥/状态只应放在这里。

## 本 alpha 的非目标

- Codex native queue receiver 与 MCP App 实验。
- 多目标路由、跨机传输、多用户隔离。
- 后台服务安装或 GUI。
- 超出本地 token 与配对白名单的强身份/认证。