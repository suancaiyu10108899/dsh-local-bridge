# 能力矩阵（公开 alpha）

| 能力 | 状态 | 备注 |
|---|---|---|
| 本地 Hub，loopback + token | 支持 | 单用户 |
| 持久队列/状态/事件 | 支持 | `.local/runtime/hub/` |
| 配对白名单 | 支持 | 手动；未配对发送/接收被拒绝 |
| CLI send/status/consume/pair | 支持 | Windows PowerShell 示例 |
| DSH 宿主插件 + 工具 | 支持 | 针对 DSH Desktop 0.2.1-rc.2 测试 |
| DSH 入站投递 + 唤醒 | 支持 | durable inbox 事件后才 ACK |
| DSH↔DSH 跨会话消息 | 支持 | 手动配对；单机 |
| 重试/TTL/去重 | 支持 | 重试不代表投递成功 |
| Hub 重启持久化 | 支持 | 前台进程；无服务 |
| 可逆插件安装/卸载 | 支持 | 安全时按字节备份 |
| DSH bundle 安装（GitHub/本地） | 支持（alpha） | 需要 DSH 0.2.1-rc.2 与 pnpm |
| managed Hub 子进程 | 支持（默认） | 插件启动/复用/停止自有 Hub；`manageHub:false` 可外部管理 |
| receiver 状态只读 | 支持 | daily/legacy 模式；`receiver-status` / `check` 按目标 warning / `status` delivery_hint；不启动、不续期、不替换 adapter |
| receiver enable/disable/renew | 不支持 | 下一阶段生命周期工作 |
| 多目标 | 不支持 | 每条消息一个目标；无路由 |
| 跨机 / 云 | 不支持 | 仅 loopback |
| GUI / 设置界面 | 不支持 | 只有 CLI |
| 无人值守服务 / 自启动 | 不支持 | 插件可托管 Hub，但宿主本身不自启动 |
| Codex native queue receiver | 实验性，未包含 | 强版本依赖；另有独立 lane |
| MCP App 集成 | 不支持 | 独立实验 |
| host-management 工具 | 未包含在本 alpha | 为缩小支持面而排除 |
| 独立冷机验证 | 未做 | 欢迎报告你的环境 |

## 投递语义

- `accepted`：已持久入队。
- `delivered`：目标 adapter 已确认；DSH 侧仅在 durable inbox 写入后。
- 模型 turn 是否启动是宿主的职责；桥接不声称任务完成。
- `delivery_unknown`：不是成功证明——重试前先检查。