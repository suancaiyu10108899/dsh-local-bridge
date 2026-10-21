# 运维

## 安装 / 首次运行

```powershell
node --version        # 22 或 24
node --test
node bin/lab-bridge.mjs init
node hub/main.mjs     # 终端 1
node bin/lab-bridge.mjs check   # 终端 2
```

`init` 创建 `.local/runtime/hub/`、令牌和空状态。使用桥接期间保持 Hub 运行。

## 作为 DSH bundle 安装

```powershell
# GitHub（需要 DSH 0.2.1-rc.2）
dsh plugin --profile web add github:suancaiyu10108899/dsh-local-bridge
# 或本地路径
dsh plugin --profile web add D:\Dev\dsh-local-bridge-public
```

- bundle 安装后插件默认**自动启动并管理 Hub**；已有 Hub 会复用，不会被插件停止。
- 设置 `manageHub: false` 可关闭自动管理，改为自行启动 Hub。
- 插件释放时会停止它自己启动的 Hub；已有/外部 Hub 不受影响。
- 已安装 bundle 的运行态在 `$DSH_HOME/local-agent-bridge/runtime`（不是 node_modules 内）。
- 手动管理/诊断时可用安装后的 CLI：

```powershell
$cli = "$env:USERPROFILE\.dsh\profiles\web\node_modules\.bin\dsh-local-bridge.cmd"
& $cli init
& $cli serve   # 仅在 manageHub:false 或外部管理时需要
& $cli check
```

- 从源码/`link:` 安装时，运行态仍在 checkout 的 `.local/runtime`。
- 需要显式覆盖时设置 `LAB_BRIDGE_RUNTIME_DIR`，并保证 Hub 与插件使用同一个值。

## 接收端状态（只读）

```powershell
node bin/lab-bridge.mjs receiver-status
node bin/lab-bridge.mjs check
node bin/lab-bridge.mjs status --to 'codex:<thread>' --state queued
```

- `receiver-status` 只读取 runtime 下的 `codex/*/status.json`，不会启动、续期、停止或修改 receiver。
- `check` 会按已配对 Codex 目标逐个显示 receiver 状态；缺失/disabled/expired/halted/PAUSED_UNCERTAIN 会给出 warning。若检测到 legacy 全局 codex adapter，会提示冲突可见，但不会停止或替换它。
- `status` 对排队中的 Codex 消息给出 `delivery_hint`：absent/expired/waiting/ready/backoff/rate-limited/paused-uncertain/disabled 等。
- **daily 模式**：`mode=daily`、`enabled=true`、`expires_at=null` 表示持续启用，**null expiry 不是过期**；滚动 `max/used/remaining native submissions` 和 `next_eligible_at` 表示限流（`RATE_LIMITED` 延迟而非终止）；`BACKOFF` 是自动 Hub 重连退避；`PAUSED_UNCERTAIN` 需人工检查，不能盲目重试。
- legacy bounded 窗口仍兼容：`expires_at` 字符串到期显示 `expired`；两者都只读展示。
- 本 alpha 不包含 receiver 本体；enable/disable/renew 属于 receiver owner 的后续工作。

## 配对

双向都需要配对。已配对身份才允许发送和接收。

```powershell
node bin/lab-bridge.mjs pair add 'dsh:session-<session-id>' --label 'DSH session'
node bin/lab-bridge.mjs pair list
```

移除：

```powershell
node bin/lab-bridge.mjs pair remove 'dsh:session-<session-id>'
```

使用精确的 session id。CLI 会拒绝未配对的发送方和目标。

## 发送 / 查询

```powershell
node bin/lab-bridge.mjs send --to 'dsh:session-<session-id>' --text 'hello'
node bin/lab-bridge.mjs status --msg-id <message-id>
node bin/lab-bridge.mjs status --to 'dsh:session-<session-id>' --limit 10
```

CLI 的 `send` 使用 `cli` operator role。声明（不是冒充）来源用 `--origin`；`--from codex:...` 会被有意拒绝。

## 消费

如果接收方在插件之外处理了消息（例如活跃 agent 用官方工具消费），请记录：

```powershell
node bin/lab-bridge.mjs consume --msg-id <message-id> --consumer 'dsh:session-<session-id>' --note 'handled by host tool'
```

消费记录责任，本身不证明模型处理了内容。

## DSH 插件安装 / 状态 / 卸载

```powershell
node bin/lab-bridge.mjs install-dsh-plugin
node bin/lab-bridge.mjs dsh-plugin-status
node bin/lab-bridge.mjs module-watch-status
node bin/lab-bridge.mjs uninstall-dsh-plugin
```

- 安装前备份 profile，随后添加本项目行。
- 卸载时，若文件未被外部修改则按字节恢复；否则只移除本项目行并报告冲突。
- 已存在不同的 `hmr` 行会报 `watch-row-conflict`；请人工检查，不要强推。

## Hub 生命周期

- Hub 是前台 CLI 进程；本 alpha 没有服务/自启动。
- 状态跨 Hub 重启持久。
- Hub 关闭时，DSH 插件会重试，宿主保持运行；稍后启动 Hub 是安全的。

## 备份与恢复

如需保留排队消息和审计事件，备份 `.local/runtime/hub/`。令牌也在其中，备份要按敏感数据对待。

Hub 运行时不要手动改 `state.json`/`events.jsonl`。

## 排障

| 现象 | 检查 |
|---|---|
| `check` 连不上 Hub | `node hub/main.mjs` 是否在运行？端口是否被占用？ |
| `source-unpaired` | 配对发送方身份（`pair add`），不能只配目标。 |
| `target-unpaired` | 配对并启用目标身份。 |
| `session-not-live` | DSH 对话未打开/未加载；消息会留在队列等待重试。 |
| 插件工具缺失 | 插件是否安装并加载？看 `dsh-plugin-status` 和插件日志。 |
| 插件安装冲突 | profile 被外部修改；按报告的冲突处理，不要强推。 |
| 启动时 Hub 缺失导致宿主崩溃 | 本 alpha 应容忍 Hub 缺失；请带版本/日志报告（不要带 token）。 |

## 升级

1. 停止 Hub 和宿主。
2. 备份 `.local/`。
3. 更新代码。
4. 运行 `node --test`。
5. 先启动宿主，再启动 Hub。
6. 跑 `check` 和 `dsh-plugin-status`。

本 alpha 没有自动迁移；0.x 版本之间状态格式可能变化。