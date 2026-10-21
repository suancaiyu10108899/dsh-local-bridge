# 变更日志

本文件记录重要变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循 SemVer。

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