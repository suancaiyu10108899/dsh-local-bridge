# DSH Local Bridge

简体中文 | [English](README.en.md)

> 同一台 Windows 机器上，为多个 DeepSeek Harness（DSH）对话提供持久、可审计的本地消息投递与唤醒。

**状态：alpha / 研究预览。** 这是一个个人向、Windows 优先的项目，不是成熟产品；支持面刻意保持很窄。使用前请先读“这不是什么”。

## 这是什么

- 一个只监听 `127.0.0.1` 的**本地 Hub**：持久状态、TTL、重试、去重、配对白名单、审计事件。
- 一个 **DSH 宿主插件**：把入站消息投递到精确的、存活的 DSH 会话，并注册 `bridge_send`、`bridge_status`、`bridge_targets` 工具。
- 一个 **CLI**：Hub 生命周期、配对、发送、状态、消费，以及可逆的插件安装/卸载。
- 面向同一台 Windows 机器上的单用户、多 DSH 对话。

“投递成功”的定义是：目标 DSH 对话收到消息，并且宿主启动了模型 turn。Hub 接受消息不等于投递成功。

## 这不是什么

- 不是通用 agent-to-agent 协议。
- 不是跨机、云服务或多用户服务。
- 不是无人值守的 Codex 桥。Codex native queue receiver 是实验性、强版本依赖的，**不包含在本 alpha 中**。
- 不是 GUI，也不是托管产品。
- 不保证兼容测试版本以外的 DSH 版本。
- 不承诺“开箱即用”支持所有 DSH 对话。

## 架构

```text
DSH 对话 A
  └─ 宿主插件（出站工具）──┐
                          ▼
                   本地 Hub（127.0.0.1）
                   持久队列、配对、重试、
                   TTL、审计
                          ▲
DSH 对话 B                │
  └─ 宿主插件（入站投递，durable inbox ACK）
```

Hub 只监听 loopback。配对是显式白名单：未配对身份不能发送或接收。运行态（令牌、队列、日志、插件备份）在 `.local/`，永不提交。

## 环境要求

- Windows 10/11（本 alpha 仅支持 Windows；已测试）。
- Node.js 22 或 24。
- DSH Desktop 0.2.1-rc.2（测试版本；其他版本可能可用但未验证）。
- 单用户、单机。

## 快速开始

把 `<session-id>` 换成真实的 DSH 会话 ID。所有命令在仓库根目录执行。

```powershell
node --test

# 创建本地运行配置（令牌、Hub 状态目录）
node bin/lab-bridge.mjs init

# 终端 1：启动 Hub，并保持运行
node hub/main.mjs

# 终端 2：检查可达性，并配对 DSH 会话
node bin/lab-bridge.mjs check
node bin/lab-bridge.mjs pair add 'dsh:session-<session-id>' --label 'DSH session'

# 安装 DSH 宿主插件（可逆；先写备份，再改 profile）
node bin/lab-bridge.mjs install-dsh-plugin
node bin/lab-bridge.mjs dsh-plugin-status
```

在已配对的 DSH 对话中：

```text
bridge_send to='dsh:session-<session-id>' text='hello'
bridge_status msg_id='<message-id>'
```

CLI 操作：

```powershell
node bin/lab-bridge.mjs send --to 'dsh:session-<session-id>' --text 'hello through the bridge'
node bin/lab-bridge.mjs status --msg-id <message-id>
node bin/lab-bridge.mjs consume --msg-id <message-id> --consumer 'dsh:session-<session-id>' --note 'handled'
```

## 卸载

```powershell
node bin/lab-bridge.mjs uninstall-dsh-plugin
```

安装器会保留字节级备份，只移除本项目自己的 profile 行；如果 profile 被外部修改，会拒绝覆盖冲突并提示人工检查。

## 安全模型

- Hub 只监听 loopback，不提供远程监听。
- 每个 Hub 使用 64 位十六进制令牌保护控制/数据连接。
- 配对是显式白名单；未配对的发送方/目标会被拒绝。
- `.local/` 含令牌、队列状态和日志，已加入 `.gitignore`。
- 不要把 `.local/` 内容或令牌贴进 issue。

## 限制（alpha）

- 单机、单用户；不是服务。
- 手动配对；没有自动发现向导。
- 只有 CLI，没有 GUI。
- DSH profile 改动对版本敏感；请保留安装器生成的备份。
- Codex native queue receiver 不包含在本 alpha。
- Codex、MCP App、host-management 模块均为排除项。
- 尚未做独立冷机验证。
- 0.x 版本之间 API/状态格式可能变化。
- 支持为尽力而为，无 SLA。

## 文档

- [架构](docs/ARCHITECTURE.md)
- [运维](docs/OPERATIONS.md)
- [能力矩阵](docs/CAPABILITY-MATRIX.md)
- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)

英文翻译：[README.en.md](README.en.md)、[docs/en](docs/en/)。

## 贡献

欢迎早期反馈和小修复。大 PR 前先开 issue。见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

MIT。见 [LICENSE](LICENSE)。