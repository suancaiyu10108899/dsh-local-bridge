# 变更日志

本文件记录重要变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循 SemVer。

## [0.1.0-alpha.6] - 2026-10-21

### 新增

- Managed Hub 子进程异常退出后的有界退避自动重启（1s→2s→5s→10s→30s，最多 10 次），只重启自己启动的 Hub；外部 Hub 仍只复用、不停止。
- `service-status` CLI 与 DSH 工具 `bridge_service_status`（只读）：Hub 健康、连接状态、managed Hub 重启计数/下次重试/上次退出、receiver 状态。
- 文档补充 companion 健康与恢复。

### 说明

- 仅新增生命周期韧性/只读可见性，不改变消息协议、配对或 receiver 行为。
- 达到重试上限后显示 `auto_restart_halted`，不无限重启。
- Codex 仍未公开导出。

## [0.1.0-alpha.5] - 2026-10-21

### 新增

- 只读 receiver 状态兼容 daily 模式：`mode=daily`、`enabled`、`expires_at=null` 不当过期；滚动提交计数、`next_eligible_at`、heartbeat/pidAlive、reason code。
- 识别 `BACKOFF`、`RATE_LIMITED`、`PAUSED_UNCERTAIN`、`DISABLED`；`RATE_LIMITED` 显示为延迟，不是终止。
- `check` 按已配对 Codex 目标逐个报告 receiver 状态；legacy 全局 codex adapter 冲突可见但不停止/替换。
- `status` 的 delivery_hint 覆盖 daily/限流/退避/暂停等状态。
- 测试覆盖 daily null expiry、滚动计数、限流/退避/暂停、多 receiver 和 legacy 兼容。

### 说明

- 仅 DSH 侧只读集成；不实现、启动、续期 receiver，不编辑 PCA reserved lane。
- 无自动 ACK/reply；receiver lifecycle 本体仍由 PCA lane 负责。

## [0.1.0-alpha.4] - 2026-10-21

### 新增

- 插件默认自动启动并管理 Hub 子进程；已有 Hub 会复用，插件释放时只停止自己启动的 Hub。
- `manageHub: false` 可关闭自动管理，改为外部/手动启动。
- 新增 managed-hub 单元测试（启动、复用、停止、状态文件清理）。

### 说明

- Hub 仍是独立进程，但安装 bundle 后不再要求用户手动定位 node_modules CLI。
- receiver 的 enable/disable/renew、Codex plugin 仍不在本 alpha。

## [0.1.0-alpha.3] - 2026-10-21

### 新增

- DSH bundle manifest：`dsh.bundle.patch`、根插件入口、`engines.dsh`，支持 `dsh plugin --profile ... add github:<owner>/<repo>`。
- 已安装 bundle 使用 `$DSH_HOME/local-agent-bridge/runtime` 作为运行态目录；源码 checkout 继续使用 `.local/runtime`。
- 只读的 `receiver-status` 命令，以及 `check` / `status` 中的 receiver 生命周期 warning / `delivery_hint`。
- bundle 安装、运行时目录与 receiver 状态的文档。

### 说明

- 本 alpha 不会自动启动 Hub/receiver；没有 enable/disable/renew；不改变 PCA reserved lane。
- Codex native queue receiver、MCP App、host-management 仍不在公开支持面。

## [0.1.0-alpha.2] - 2026-10-21

### 变更

- 中文成为 canonical 文档；英文作为翻译，并在文件顶部标注可能滞后。
- README 与 docs 增加语言切换/翻译链接。
- `CONTRIBUTING`、`SECURITY`、`CHANGELOG` 增加中文主版与英文翻译。
- 修复英文 README 语言切换标题的换行格式。

### 说明

- 本版本无行为/协议/代码变更，只是文档与版本元数据；CI 仍覆盖 Windows + Node 22/24。
- Codex native queue receiver、MCP App、host-management 模块仍不在公开支持面。
## [0.1.0-alpha.1] - 2026-10-21

### 新增

- 本地 loopback Hub：持久队列、TTL、重试、去重、配对白名单、审计事件。
- CLI：`init`、`send`、`status`、`pair`、`consume`、`check`、`install-dsh-plugin`、`uninstall-dsh-plugin`、`dsh-plugin-status`、`module-watch-status`。
- DSH 宿主插件：入站 durable inbox ACK；出站 `bridge_send` / `bridge_status` / `bridge_targets`。
- 可逆的 DSH profile 安装，带备份；安全时按字节回滚。
- Hub、协议、存储、客户端启动、插件、安装的核心测试。
- 公开 alpha 文档。

### 已知限制

- 本 alpha 仅 Windows；测试版本 DSH Desktop 0.2.1-rc.2。
- 单机、单用户；手动配对；无 GUI。
- Codex native queue receiver 不包含在本 alpha。
- Codex、MCP App、host-management 模块均为排除项。
- 无独立冷机验证；支持为尽力而为。