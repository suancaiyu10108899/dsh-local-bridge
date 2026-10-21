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