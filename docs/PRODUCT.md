# 产品形态（最终目标）

本文描述 DSH Local Bridge 想成为的最终产品，以及当前 alpha 与最终目标之间的距离。当前事实以 [README](../README.md)、[能力矩阵](CAPABILITY-MATRIX.md)、[运维](OPERATIONS.md) 和实际 release 为准。

## 一句话

**让同一台 Windows 机器上同时运行多个 DSH（以后可选 Codex）长会话的人，安装一次插件，就能安全地互相发消息、唤醒、查看状态，并且随时能看见、停掉和卸载它。**

不是聊天客户端，不是云服务，也不是通用 agent 协议。

## 目标用户

- 同时维护多个长期 DSH 对话/项目，需要跨会话交接、审查、提问、回执的人。
- 以后希望把 DSH 的审查/提问送到一个**仍保持原线程**的 Codex 长会话，而不是把 Codex 当成一次性子任务。
- 单机、单用户、Windows 优先；能接受本地进程和显式配对，不要求 SaaS。

## 用户最终拿到什么

1. **GitHub release + 固定 tag**
   - MIT 开源仓库、CHANGELOG、测试与 CI。
   - 可审阅的 bundle manifest、安装/卸载/隐私/进程足迹说明。

2. **DSH 安装包**
   - 通过 `dsh plugin --profile <profile> add github:<owner>/<repo>`、插件市场或本地路径安装。
   - `engines.dsh` 限制已测试的 DSH 版本；不承诺未测试版本。
   - 安装后不需要用户手动找 `node_modules` 里的 CLI 启动 Hub。

3. **一个可见的本地 companion**
   - 托管 Hub；已有外部 Hub 只复用，不抢占、不停止。
   - Hub 子进程异常退出时按有界退避自动重启；达到上限时显示 `auto_restart_halted`，不无限重启。
   - companion 只管理自己启动的子进程；卸载/禁用时清理自己的进程。
   - 状态通过 `service-status` / `bridge_service_status` 可见。

4. **DSH 插件工具**
   - `bridge_send`：向显式配对的目标发送消息。
   - `bridge_status`：查询投递状态。
   - `bridge_targets`：列出已配对目标。
   - `bridge_service_status`：只读查看 Hub、连接、managed Hub 重启状态和 receiver 状态。

5. **可选 Codex 支持面（实验性，已获精确导出批准）**
   - 公开仓的 `codex-receiver/` 是独立 optional CLI source package，MIT，source `c1da001`；不进入 DSH bundle、不自动启动/登录/扩目标。
   - target-scoped receiver：每个 Codex 目标只拉取自己的消息，不注册/替换全局 Codex adapter。
   - daily 模式：无固定期限、滚动提交限额、显式 disable/renew；状态可见。
   - 没有 npm 发布、官方 Codex marketplace/plugin 挂载；第三方冷安装/重启恢复/soak/升级矩阵仍 NOT_RUN。

6. **文档**
   - 安装、配对、升级、回滚、卸载、故障排查。
   - 安全模型、权限、隐私、进程/注册表足迹。
   - 明确的“不保证”和“不包含”清单。

## 正常使用流程（目标）

1. 安装 DSH bundle。
2. 启动 DSH；companion 自动确保 Hub 运行。
3. 用 CLI/设置入口配对目标会话（明确 identity，不自动猜目标）。
4. 在对话中使用 `bridge_send` / `bridge_status` / `bridge_targets`。
5. 用 `bridge_service_status` 确认 companion/Hub 状态。
6. 需要 Codex 时，单独安装经批准的 Codex 包，从原生 Codex 线程自绑定 receiver。
7. 不用时 disable/uninstall，清理自己的进程和运行态。

## 安全与信任边界

- Hub 只监听 loopback；每个 Hub 有本地令牌。
- 配对是显式 allowlist；未配对发送/接收被拒绝。
- 不自动回复、不伪造发送者身份、不做模型空轮询、不盲目重试 native 提交。
- 不静默修改全局 Codex/DSH 配置；不替换另一个 adapter。
- 不自动下载/安装 vendor binary；不扩展到跨机/云。
- 同一用户本机集成，不是独立宿主认证，也不是无人值守服务。

## 当前 alpha 与最终目标的距离

| 能力 | alpha.6 现状 | 最终目标 |
|---|---|---|
| DSH bundle 安装 | 支持 GitHub/本地 | marketplace/稳定版安装入口 |
| Hub 生命周期 | 插件托管 + 自愈重启 | companion 生命周期完整可见/可控 |
| 配对/发送/唤醒 | CLI + DSH tools | 更少手写路径的设置/引导 |
| 服务状态 | `service-status` / `bridge_service_status` 只读 | CLI + 可选 GUI/托盘 |
| DSH↔DSH | 支持，单机 | 稳定支持面 |
| DSH↔Codex | 可选 `codex-receiver/` 实验源包（MIT、精确导出；不随 DSH bundle 安装/启动） | 经批准的独立可选包；无 marketplace/默认进程 |
| GUI/托盘 | 无 | 可选，非第一优先 |
| 跨机/云/多用户 | 不支持 | 仍不支持 |

## 路线

1. **DSH-only 可用产品（当前）**：bundle、managed Hub、状态工具、安装/卸载文档。
2. **首次使用体验**：配对/自检/故障排查更顺；减少对 `node_modules/.bin` 路径的依赖；评估设置界面/托盘。
3. **Codex 公开导出（已完成精确导出，待 tag）**：7 模块 + 2 脱敏 tests + 说明已按批准 allowlist 进入 `codex-receiver/`；不覆盖 public core；保持 experimental/NOT_RUN 限制，不做 npm/marketplace。
4. **稳定版**：固定支持矩阵、升级/回滚、干净安装验证、第三方试用反馈。

## 不承诺

- 不承诺所有 DSH/Codex 版本兼容。
- 不承诺无人值守、自动登录、跨机、多用户或 SLA。
- 不承诺 Codex 侧在公开 alpha 中可用。
- 不承诺没有进程/注册表/运行态足迹；这些会明确记录。
