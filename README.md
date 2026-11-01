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
- 不是无人值守的 Codex 桥。新版 bundle **附带**可选的 Codex receiver 源码、worker 入口和 shared core metadata，但 receiver/worker 默认不启用；必须由真实原 Codex owner 显式 opt-in/配对后才可能启动。它仍是实验性、强版本依赖的；legacy/source-link 模式保持独立说明，不会被自动迁移。
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
bridge_service_status
```

CLI 操作：

```powershell
node bin/lab-bridge.mjs send --to 'dsh:session-<session-id>' --text 'hello through the bridge'
node bin/lab-bridge.mjs status --msg-id <message-id>
node bin/lab-bridge.mjs consume --msg-id <message-id> --consumer 'dsh:session-<session-id>' --note 'handled'
node bin/lab-bridge.mjs service-status
```

## 作为 DSH bundle 安装（alpha）

DSH 的插件管理器可以从 GitHub 或本地路径安装 bundle。安装后插件会**自动启动并管理 Hub**（已有 Hub 会复用；设置 `manageHub: false` 可自行管理）。Hub 仍是独立子进程，但用户不需要手动定位 node_modules 里的 CLI。Hub 子进程异常退出时，companion 会按有界退避自动重启它；已有/外部 Hub 只复用，不停止。

> 插件管理器需要 `pnpm`；如果 CLI 报 `pnpm not found`，请先安装 pnpm，或使用 Desktop 插件页的安装入口。安装会做版本/构建检查，可能要求确认。

```powershell
# GitHub（需要 DSH 0.2.1-rc.2；bundle 声明了 engines.dsh）
dsh plugin --profile web add github:suancaiyu10108899/dsh-local-bridge

# 或本地 checkout
dsh plugin --profile web add D:\Dev\dsh-local-bridge-public

# 安装后的 bundle 使用 $DSH_HOME/local-agent-bridge/runtime 作为运行态目录
$cli = "$env:USERPROFILE\.dsh\profiles\web\node_modules\.bin\dsh-local-bridge.cmd"
& $cli init       # 仅首次；插件启动 Hub 时也会创建配置/令牌
& $cli pair add 'dsh:session-<session-id>' --label 'DSH session'
& $cli check      # 诊断用；Hub 已由插件管理时无需手动 serve
& $cli service-status
```

如果关闭自动管理（`manageHub: false`），再用 `& $cli serve` 显式启动 Hub。

如果本地 checkout 用 `link:` 安装，运行态仍跟随 checkout 的 `.local/runtime`；从源码运行时继续使用上面的快速开始即可。

## 手动接入 / 请求查询（当前入口）

需要把一个新 source/target 手动接入、持久登记请求并查询失败/重试/撤销时，使用当前入口：

- [docs/MANUAL-ONBOARDING.md](docs/MANUAL-ONBOARDING.md)
- [受限 client access](docs/CLIENT-ACCESS.md)
- [DSH companion lifecycle](docs/COMPANION-LIFECYCLE.md)
- [Restricted-client rollback / old-Hub handover](docs/CLIENT-ROLLBACK.md)
- CLI：`node bin/lab-bridge.mjs onboard discover|request|list|status|retry|revoke`
- 同一 Hub 根操作：`pair` / `targets` / `send` / `status` / `consume` 也支持显式 `--runtime <existing-hub-data-root>`；每个命令都要带同一根，详见文档。

边界：

- `request` 只登记，不等于 pair、owner enable 或 message received。
- 缺 consent 仍会持久保存为 `WAITING_OWNER_CONSENT`，不会 auto-pair/enable/send；`--user-authorized` 是调用方声明/授权引用，不是 PCA 认证。
- 可用显式 `--runtime <current-hub-data-root>` 接入已有旧 Hub，不要求 companion/locator 全切换。
- 旧私有 `adapters/codex/README.md`（v1）是历史说明，不是常驻入口，也不代表当前 receiver 两模式；receiver 当前模式以对应 README 为准。无需为改文档写私有 watched root/HMR。
## 可选 Codex receiver（以源/worker形式随包附带；默认不启用）

仓库和 npm bundle 现在都附带 `codex-receiver/` 的源码、worker 入口、shared core 和 receiver metadata（MIT）。但它**不是默认启用的桥**：`enabled=false` 起步，只有真实原 Codex owner 通过当前安装的 core CLI 显式 opt-in/enable 后，COMPANION_OWNED 才会恢复 ENABLED 成员；不会创建登录项，也不会扩展目标。legacy/source-link 安装模式仍独立说明，不自动迁移。

- 要求：Windows 同一用户、Node `>=24.15.0`、用户已安装的 Codex CLI；`node:sqlite` 和 rollout 格式是强版本依赖。
- 入口、owner opt-in 与限制：[codex-receiver/README-CODEX.md](codex-receiver/README-CODEX.md)。
- 单独测试：`node --test codex-receiver/tests/*.test.mjs`。
- 没有 npm 发布 receiver 独立包、没有官方 Codex marketplace/plugin 挂载；真实第三方冷安装、登出/重启恢复、多日 soak、广泛升级矩阵仍是 NOT_RUN。

## 卸载

源码安装：

```powershell
node bin/lab-bridge.mjs uninstall-dsh-plugin
```

DSH bundle 安装：

```powershell
dsh plugin --profile web remove dsh-local-bridge
# 确认没有其他 profile 使用后再清理运行态（会删除令牌、队列和日志）：
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\local-agent-bridge"
```

安装器会保留字节级备份，只移除本项目自己的 profile 行；如果 profile 被外部修改，会拒绝覆盖冲突并提示人工检查。卸载/清理前请确认没有其他对话仍在使用该 Hub。

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
- npm bundle 附带可选的 Codex receiver 源码、worker 入口、shared core 和 receiver metadata；receiver/worker 默认不启用，必须由真实原 owner opt-in/enable。
- MCP App、host-management 模块仍排除；legacy/source-link 模式保持独立说明，不自动迁移。
- 受限 client request/reply 已接入；说明见 [CLIENT-ACCESS](docs/CLIENT-ACCESS.md)。本机 Codex 原 MRI 已完成一次真实 request/reply；云 dot 业务、DSH 当前宿主的新 plugin 实载仍未验证。
- companion lifecycle/安装模式说明见 [COMPANION-LIFECYCLE](docs/COMPANION-LIFECYCLE.md)。
- 尚未做独立冷机验证。
- 0.x 版本之间 API/状态格式可能变化。
- 支持为尽力而为，无 SLA。

## 文档

- [产品形态](docs/PRODUCT.md)
- [可选 Codex receiver](codex-receiver/README-CODEX.md)（实验性，独立于 DSH bundle）
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