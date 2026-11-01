# 手动接入（Manual Onboarding）

本文件是 DSH root lane 的手动接入入口。它**不是**自动配对器、owner enable 器、receiver 启动器或消息发送器。

## 一句话边界

- `request` 只登记一个精确 source/target 请求。
- `request` 不等于 pair。
- `request` 不等于 owner opt-in / receiver enable。
- `request` 不等于消息 received。
- `pair` 或 `ONLINE_IDLE` 不等于 model receipt。
- 未知 source 不会被自动放行。

## 使用统一 runtime

默认使用当前安装/源码 runtime。要接入当前已存在的旧 Hub，可显式指定其数据根：

```powershell
node bin/lab-bridge.mjs onboard discover --runtime D:/path/to/current/hub-data
```

- `--runtime`：显式当前 Hub runtime 根，其中包含 `hub/config.json`、`hub/token`；不需要 locator/companion 全切换。
- `--installation`：有 locator 时使用 locator 的 runtime；显式 runtime 与 locator 冲突会 fail closed。
- 两者都不给时使用当前默认 runtime。
- 不会启动 Hub、companion、receiver 或 Task。

## 发现（只读）

```powershell
node bin/lab-bridge.mjs onboard discover --runtime D:/path/to/current/hub-data
node bin/lab-bridge.mjs onboard discover --installation D:/path/to/LocalAgentBridge
```

只读展示：

- Hub 是否可达、welcome 的 installation/instance/protocol
- 当前已配对 targets
- 本地 receiver statuses
- memberships 与 owner opt-in
- 当前可执行 next steps

不会写 token、queue、ledger、profile 或 Hub 状态。

## 登记请求

```powershell
node bin/lab-bridge.mjs onboard request `
  --runtime D:/path/to/current/hub-data `
  --source dsh:session-<dsh-session-id> `
  --target codex:<codex-thread-id> `
  --user-authorized `
  --request-id onb-<local-request-id> `
  --origin-artifact D:/path/to/outbox/request.json
```

- `--source` / `--target` 必须是精确 `role:id`，不能是 `cli:`，不能相同。
- `--user-authorized` 是调用方声明/授权引用，不是 PCA 认证；缺失时请求仍持久保存为 `WAITING_OWNER_CONSENT`，不会 pair/enable/发送。可稍后用 `onboard retry <request_id> --user-authorized` 声明。
- `--origin-artifact` 只记录路径、大小、sha256，不写正文。
- `--message-id` 可选，仅记录消息 ID，不记录消息正文。
- 默认生成 `onb-<uuid>`；指定 `--request-id` 时重复同内容幂等，不同内容冲突且不覆盖。

请求保存在：

```text
<runtime_root>/onboarding/requests/<request_id>.json
```

每个 request 一个原子文件；history 保留 create/observe/retry/revoke。没有 token、聊天正文，也不跨 runtime 混写。

## 查询 / 重试 / 撤销

```powershell
node bin/lab-bridge.mjs onboard list --runtime D:/path/to/current/hub-data
node bin/lab-bridge.mjs onboard status onb-<local-request-id> --runtime D:/path/to/current/hub-data
node bin/lab-bridge.mjs onboard retry onb-<local-request-id> --runtime D:/path/to/current/hub-data
node bin/lab-bridge.mjs onboard receipt onb-<local-request-id> --message-id <message-id> --turn-id <uuid> --runtime D:/path/to/current/hub-data
node bin/lab-bridge.mjs onboard revoke onb-<local-request-id> --runtime D:/path/to/current/hub-data --reason "人工取消"
```

- `retry` 只重新做只读 discovery 并更新观察/history；不会自动 pair 或 enable。
- `revoke` 只标记 REVOKED，不删除历史、账本或 artifact；不自动删除可能共用的 source pairing，也不关闭其他 target。
- 同一 request_id 同时被另一个进程更新时返回 `ONBOARD_REQUEST_BUSY`，不覆盖。

## 未配对 / 旧 Hub

如果 Hub 可达但 source/target 未配对，请求仍会持久保存，返回：

```json
{
  "request_state": "WAITING_PAIR",
  "guidance": {
    "code": "REQUEST_WAITING_PAIR",
    "message_zh": "请求已持久登记，但 source/target 尚未在 Hub 配对；不会自动添加未知 source。",
    "next_steps": [
      "人工确认后运行 pair add <source>",
      "再配对精确 target",
      "随后 onboard retry <request_id>"
    ],
    "retry_policy": "MANUAL_RETRY_AFTER_PAIR"
  }
}
```

旧 Hub 不可达/不支持只读查询时，请求照样本地保存，状态为 `UNKNOWN`，guidance code 为 `HUB_DISCOVERY_UNAVAILABLE`；不会要求先切换 companion/locator，也不会启动第二个 Hub。

## 手动 pair / owner enable / receiver enable

顺序必须由显式命令明确完成；“手动”是指有人/已授权 owner 对话执行这些命令，不要求逐条粘贴自然语言或经过 PCA 审批：

1. 用现有 CLI 显式 `pair add <source>` 和 `pair add <target>`；不要用未知 source 的自动加入。
2. 目标 owner 在原工具中显式 enable；receiver 新 manual mode 由其 owner lane 提供时，按该 lane 的 `--manual-runtime` 指引启用。
3. 确认 receiver 状态；不要把 `ONLINE_IDLE` 当模型收信。
4. `onboard retry` 只更新观察；仍不会自动 enable、启动或发送。
5. 当前旧 Hub 的活跃回合可在 target 原线程执行 `onboard receipt` 记录真实模型声明；见下文。

## message_id 与 model-receipt

如果请求带 `--message-id`，`status`/`retry` 会按 **精确 target + message_id** 读取既有：

```text
<codex receiver runtime_dir>/<sha256(message_id)>.model-receipt.json
```

只有存在且 `msg_id`/`thread_id` 匹配时，才显示：

- `model_status: MODEL_REPORTED`
- `received_confirmed: false`
- `native_correlation: UNVERIFIED`
- `rollout_correlation: UNVERIFIED`

因此：

- `MODEL_REPORTED` 不是 native/rollout 关联完成
- pair、receiver ONLINE_IDLE、model-receipt 文件任一项都不能单独当完整送达
- 无 `message_id` 时 model receipt 为 `UNKNOWN`
- 没有 receipt 时不会伪造 RECEIVED 状态

## 活跃回合手动回执（当前旧 Hub 可用）

如果真实消息已经在 target 原线程的活跃回合被正常 CLI 读到/consume，可能没有 native ledger 或 model-receipt 文件。可在 target 原线程执行：

```powershell
node bin/lab-bridge.mjs onboard receipt onb-<local-request-id> `
  --message-id <message-id> --turn-id <turn-uuid> `
  --runtime D:/path/to/current/hub-data
```

写入前强制校验：

- 当前原生 `CODEX_THREAD_ID` 必须等于 `request.target` 的 thread；不伪造 owner 线程。
- Hub 中该 message_id 的 `from`/`to` 必须等于 request 的 source/target。
- 校验失败不写入；保留原 request/history。

写入字段：

```json
{
  "route": "MANUAL_ACTIVE_TURN",
  "model_status": "MODEL_REPORTED_MANUAL",
  "native_accepted": "UNKNOWN",
  "idle_wake": "NOT_CLAIMED",
  "received_confirmed": false
}
```

- 
ative_thread_id_verified 只是 same-user/self-report 环境变量核对，不是强认证；Hub route 仍独立校验。
- 只记录真实活跃回合的手动声明，不 consume、不重发、不伪造 native queue。
- 不等于 native queue acceptance，也不等于 idle wake。
- 原 native `<sha>.model-receipt.json` 路径仍严格要求原生 queue 证据；manual receipt 不替代、不弱化它。

## 中文失败/恢复

CLI 失败返回稳定 `code` 和 `message_zh`/`next_steps`，不会把失败改写成成功；缺 consent 不是丢记录，而是持久等待：

```json
{
  "ok": true,
  "request": {
    "request_state": "WAITING_OWNER_CONSENT",
    "guidance": {
      "code": "REQUEST_WAITING_OWNER_CONSENT",
      "message_zh": "请求已持久登记，但还没有调用方声明的用户/owner 授权引用；不会自动 pair、enable 或发送。",
      "next_steps": [
        "由用户确认后运行 onboard retry <request_id> --user-authorized",
        "人工完成 pair / owner opt-in / receiver enable；retry 只观察，不重发"
      ]
    }
  }
}
```

硬冲突示例：

```json
{
  "ok": false,
  "code": "ONBOARD_RUNTIME_CONFLICT",
  "message_zh": "显式 runtime 与 locator 的 runtime_root 冲突；请只指定一个实例，不能混用。"
}
```

receiver 的 owner-thread mismatch、offline、CLI 失效、限流、uncertain 等可选中文 guidance 由 Codex lane 提供；root 只消费稳定 code/可选 guidance，不依赖其文案做授权判断。

## 常见失败一页表（raw code → 停在哪步 → 恢复入口）

以下命令都在同一个已发现的 Hub 数据根上执行；把 `$rt` 换成当前 Hub 数据根，不要求读源码，也不等 PCA 转述。普通 consented 操作由原 owner 直接执行，不需要逐条审批。

| raw code 示例 | 停在哪步 | 当前可执行恢复入口 |
| --- | --- | --- |
| `source-unpaired`（旧 DSH/Hub 原文保留；root 侧常见 `REQUEST_WAITING_PAIR`） | `explicit_pair` / `PAIR_EXACT_PEERS` | `node bin/lab-bridge.mjs onboard request --source <source> --target <target> --user-authorized --runtime $rt`，然后同根 `pair add <source> --runtime $rt`，再 `onboard status <request_id> --runtime $rt`。未知 source 不自动放行。 |
| `target-unpaired`（同上） | `explicit_pair` / `PAIR_EXACT_PEERS` | 同根 `pair add <target> --runtime $rt`；确认 target config 的 `allowed_senders` 含本 source，且保留其他 source；再 `onboard status`。不要自动 pair 或改 config。 |
| `OWNER_THREAD_MISMATCH` / `OWNER_TARGET_MISMATCH` / `BACKGROUND_WORKER_CONTEXT_NOT_SANITIZED` | `TARGET_OWNER_CONTEXT` | 切到 target 的真实 Codex 原对话，由它执行 receipt/prepare/enable；核对原生 `CODEX_THREAD_ID`，不要手工设置、不要让 PCA/另一对话冒充。可使用 `onboard receipt <request_id> --turn-id <uuid> --message-id <msg> --runtime $rt`。 |
| `OFFLINE` / `RECEIVER_NOT_RUNNING` / `NOT_STARTED` / `RECOVERING_WORKER` | `START_OR_RECOVER_OWNER_RECEIVER` | `node bin/lab-bridge.mjs receiver-status --runtime $rt` 查看目标状态；由 target 原 owner 按原 receiver 工具 prepare/enable；不启动第二个 Hub、不切换现役 profile/Task。 |
| `CLI_PATH_REQUIRED` / `CLI_*` / `NO_COMPATIBLE_INSTALLED_CLI` / `PAUSED_BINARY_CHANGED` | `SELECT_INSTALLED_CLI` / `VERIFY_INSTALLED_CLI` | 在原线程用原 receiver 工具运行只读 `doctor`，核对唯一 vendor CLI；再 `repair-cli`；随后用原入口 `enable`。保留 binding/window/ledger/rate/startup；不要下载、猜测 PATH 或清状态。 |
| `RATE_LIMITED` / `WAITING_COOLDOWN` / `ROLLING_BUDGET_OR_COOLDOWN` | `WAIT_FOR_QUOTA` | `receiver-status --runtime $rt` 查看 `remaining_native_submissions`、`next_eligible_at` 与消息 TTL；等待窗口恢复后人工 retry。不要重建窗口、清账本、增加预算或重发。 |
| `NATIVE_OUTCOME_UNCERTAIN` / `PAUSED_UNCERTAIN` / `native-output-not-confirmed` / `uncertain-native-submission-review-required` | `REVIEW_NATIVE_OUTCOME` | 保留原 `request_id`/`msg_id`/ledger/native queue 证据；由 target 原 owner 查 `status`/`doctor` 和目标线程实际结果。**不重发、不换新 msg_id、不清账本、不重复 enable**；确认原消息结果后才决定恢复。 |
| 尚未投递的 `queued` / `delivery_unknown`、无 `delivered_at` 且 `last_error=session-not-live` | DSH 原会话加载 | 核对消息的精确 `to=dsh:session-<id>`；由该会话原 owner 使用宿主原生入口打开/恢复**同一个**会话。Hub 配对、DSH adapter 已连接、Codex receiver 健康均不证明该 DSH 会话已 live。不重新 pair、不新建替代会话、不重启共享宿主、不开启 Bridge 管理工具。恢复后查询原 `msg_id`；未过 TTL 的原消息由 Hub 自动延后重试，不重发/换 ID。若已 `delivered` 且有投递时间，残留 `last_error` 仅作历史，不再要求恢复。 |

## DSH 会话未加载：session-not-live

先在同一个 runtime 查询原消息：

```powershell
node bin/lab-bridge.mjs status --msg-id '<已有业务消息ID>' --runtime $rt
```

先看当前 `state` / `delivered_at`：

- `state=delivered` 且有 `delivered_at`：该条消息传输已确认；残留历史 `last_error=session-not-live` 不继续提示离线，也不要求再恢复。
- 只有仍 `queued` / `delivery_unknown`、无 `delivered_at` 且实际 `last_error=session-not-live` 才按冷会话处理；`delivery_unknown` 单独不足以确定原因。

配对是准入记录，adapter 已连接表示传输通道可用，目标 DSH agent 是否已加载仍需原宿主确认。由目标原 owner 通过宿主原生入口恢复**同一个原会话**后，保留当前消息与原 TTL，等待 Hub 自动延后重试；不要创建替代会话、重复业务、重配全部目标或停止其他会话，也不要在共享宿主/Hub 上做重启。

`session-not-live` 是可延后的投递，不消耗有界 attempts，但受消息 TTL 限制。恢复后继续查同一 `msg_id` 的实际 `state` / `delivered_at`；DSH durable inbox 投递确认仍不等于模型处理或业务完成。消息已过期或出现其他错误时保留原记录，按真实状态决定下一步，不能自动换新 ID 重发。`onboard retry` 只更新请求观察，不是业务消息重发。

补充：

- 现役旧 DSH 工具返回的 `source-unpaired` 原文不重写、不伪造；当前恢复入口是同一数据根上的 `onboard request` 与 `onboard status`，不是为改提示去部署 watched plugin。
- 原 owner 的普通 consented prepare/enable/repair/receipt 直接执行；只有目标 owner 能代表目标执行 owner 操作。
- `uncertain` 的硬规则：不重发、不换 msg_id、不清 ledger；先核对实际结果。
- root 侧对应状态码包括 `REQUEST_WAITING_PAIR`、`REQUEST_WAITING_TARGET_ALLOWLIST`、`REQUEST_WAITING_OWNER_ENABLE`、`ONBOARD_RECEIPT_OWNER_THREAD_MISMATCH`；receiver 侧 guidance 可提供更具体 step/evidence。

## Synthetic 示例（通用可分发）

```text
source: dsh:session-<dsh-session-id>
target: codex:<codex-thread-id>
artifact: D:/path/to/outbox/<request-artifact>.json
request_id: onb-<local-request-id>
```

真实业务/私有路径只放在共享 runtime 的本地请求记录和本地审计，不写进通用可分发文档，也不从 PCA 私有审计目录读取或复制。

## 限制

- 这是手动接入控制面，不是生产自动迁移器。
- 不建立安装根、不注册 Task、不启动共享宿主、不发送 native queue、不发布公开产物。
- 真实 owner handover、Task/login/reboot、schema migration、实际 live migration/rollback 和完整 V19 仍为 NOT_RUN。
- 不把消息权限当成 writer/publisher 权限。

## 新目标首次 prepare（当前 receiver 工具）

新目标第一次接入时，先由目标 owner 在原 Codex 线程上下文中运行 receiver 的 `prepare`/enable；如果当前 Hub 没有 locator、但已有当前 Hub 数据根，使用 receiver 的显式 manual runtime 入口（receiver lane 提供时语法为 `--manual-runtime <current-hub-data-root>`）：

```text
prepare: 目标 owner 当前线程 -> 生成真实 codex/<thread> 配置与 receiver 状态
enable:  owner 明确 opt-in，配对/窗口/ledger/rate 保留
```

- 不创建 Hub/token/Task。
- 不伪造 `CODEX_THREAD_ID`。
- 不要求全 companion/locator 迁移。
- 已有 locator/runtime 冲突、混 installation flag、路径越界时 fail closed。
- 旧未标记 receiver 继续用原工具，不由此静默迁移。
- 本仓库 root 只登记请求和观察；不调用 receiver prepare/enable。

## 旧 CLI pin 消失时（原线程修复顺序）

如果旧目标曾使用的 CLI pin 被更新/移除，不要重装/重建 target：

```text
1. 先运行现有 receiver 的 doctor / repair-cli（或等价 validate/refresh）
2. 确认 pin 仍落在原来的 vendor Codex/bin 根内，检查真实路径/version/queue flags/binary hash
3. 再用原工具执行 enable
4. 保留原 binding_epoch / window / ledger / rate limit / startup=false
5. 不新建第二个 receiver/窗口，不调用 native queue，不伪造 owner 上下文
```

CLI 不兼容、pin 候选歧义或路径越界时 pause/review；不要用旧 age/任意 PATH 猜测。

## 历史/当前入口

- 当前手动接入入口：本文件。
- 旧 `adapters/codex/README.md`（v1）属于历史说明，不是常驻入口，也不代表当前 receiver 两模式。
- receiver 的当前模式、manual runtime、中文 guidance 由其 README 补充；root 只消费稳定 code/可选 guidance。
- 不为了改文档去写私有 watched root 或启用 HMR；不改旧私有 README。

## 旧 Hub / 无 locator

`--runtime <current-hub-data-root>` 是当前 Hub 的显式入口：

- 只读 config/token 查询现有 Hub；
- 请求落在该 runtime 的 `onboarding/requests/`；
- 未配对/不可达仍持久保存；
- 不要求 companion/locator 全切换；
- 不启动第二个 Hub；
- 私有 PCA 审计目录不是通用 onboarding 队列。

## 未标记 legacy config / stored vs current status

旧 v2 config 可能缺少 `owner_opt_in` / `runtime_mode` 支持字段；不能把缺失压成 `owner_opt_in=false`。

`onboard status`/`retry` 的 target config 观察会区分：

- `owner_opt_in: null` + `owner_opt_in_present:false` + `metadata_support:"UNSUPPORTED_LEGACY_FIELDS"`：字段缺失/不支持，不是明确拒绝。
- `enabled: null`：字段缺失，不代表确实停止；只有显式 `false` 才可标 disabled。
- `owner_opt_in:false` / `enabled:false`：明确 false/disabled，仍进入真实等待，不自动放行。

receiver 观察分开显示：

- `reported`: 旧 status/phase/raw heartbeat（例如 `ONLINE_IDLE`）；
- `verified_process`: v3 identity 验证结果；旧 v2 为 `UNVERIFIED`；
- `active` / `process_active` / `deliverable_now`：旧 v2 identity 未知时为 `null`，不是 false 或 v3 true；
- 旧 v2 `LEGACY_UNVERIFIED` 不冒充新身份健康，也不当模型收信。

当 request 已有用户授权、旧 config `enabled:true`、`allowed_senders` 含本 source、但支持字段缺失：

- 状态为 `OBSERVED_LEGACY_UNVERIFIED`（不是 `OBSERVED_READY`，也不是 `WAITING_OWNER_OPT_IN`）；
- 中文 next step：只读原工具 status、核已有 receipt，或在 target 原线程真实业务回合后记 manual receipt；
- 不重复 enable、不重配/重启、不回 PCA 逐条审批；
- 只读；只有 `onboard retry` 会更新 request observation/history。

字段缺失且无法确认 enabled/source 合规时使用 `LEGACY_METADATA_UNSUPPORTED`，仍不自动放行。

`status` 同时给出：

- `stored_state` / `stored_guidance`：request 文件里的 snapshot；
- `current_state` / `current_guidance`：本次 fresh 只读观察；
- `live_observation`：完整现场观察。

顶层 `request` 仍可能显示旧 snapshot；判断当前状态请用 `current_state`，或执行 `onboard retry` 更新持久 history。不同 message_id 的 native/model/pre_dispatch 证据不可挪用到另一请求；不得代 target 伪造 env/turn。
## 旧 config / manual owner opt-in（不要求 companion membership）

manual 新目标可能没有 companion membership；这不应被自动判成永久 `WAITING_OWNER_OPT_IN`。

discovery 会检查 exact target thread 的当前 receiver config：

- `owner_opt_in:true` + `runtime_dir`/`hub_runtime_root` 与所选 runtime 一致 → 作为当前 MANUAL_LEGACY_HUB 的 config 观察，证据等级标为 `MANUAL_LEGACY_HUB_CONFIG_OWNER_OPT_IN`。
- config 存在但 owner opt-in 未确认、Hub 根不一致或旧字段不完整 → 保留旧工具观察/待核对，不要求也不伪造 companion membership。
- 没有 membership 不是自动失败；但 request 仍不等于 enable/receiver active。

receiver 状态现在使用 async identity 验证：

- v3 `schema_version>=3` 且新鲜 heartbeat/identity 匹配才可能 `ACTIVE`；
- 旧 v2/legacy 状态只显示 legacy/unverified，不会冒称新身份验证健康，也不会转成 model received；
- 旧 config 需由原工具 doctor/repair/enable 或新 manual mode 核对。

## Hub 目标与 loopback 约束

- 只接受 config `host=127.0.0.1`；非 loopback 不连接、不发送 token。
- 使用 `--installation` 时核对 welcome 的 installation/instance 与所选 locator；不一致 → `HUB_INSTANCE_MISMATCH`，request 标 BLOCKED，不把 A runtime 数据指向 B Hub。
- `--runtime` 显式子进程只读取该 runtime 的 config/token；不会创建/启动 Hub。

## 手动回执的认证边界

`onboard receipt` 的 `native_thread_id_verified` 依据当前 `CODEX_THREAD_ID` 环境变量，是 same-user/self-report 声明，不是强认证。仍必须：

- native thread 等于 request.target；
- Hub 中 message source/target 等于 request；
- request 锁内 fresh 再核对未 REVOKED、绑定未变化；
- 不 consume/不重发；不据此声称 native accepted 或 idle wake。

## 路径安全

- `onboarding/requests` 在首次 mkdir/写前按 projected realpath 核对；junction/symlink/reparse 越根 → 暂停，不写。
- receipt 的 `config.runtime_dir`/receipt 文件只接受所选 runtime realpath 内路径；junction 越根拒绝读取。
- Windows 设备名 request_id（CON/NUL/COM1/LPT1 等）拒绝，避免特殊文件名。
- 只持久请求元数据/路径 hash；不读全文聊天或 token 到输出。

## request generation（installation/instance）绑定

`onboard request` 首次创建时保存可信 generation tuple：

- 有 locator/installation 上下文：保存该 installation/instance，并记录 Hub welcome 是否也匹配。
- 显式 `--runtime` 且无 locator：若当前 Hub welcome 带 `installation_id` + `instance_id`，保存这组首个可信 welcome tuple。
- 旧 Hub welcome 没有 IDs：保持 `LEGACY_UNVERIFIED`，不编造 ID。

后续 `status` / `retry` / `receipt` 不只比较 runtime 路径：

- 用已保存 tuple 核对当前 Hub welcome 与所选 locator；
- tuple 变化 → `ONBOARD_INSTANCE_DRIFT` / `BLOCKED`，保留原 request/IDs，不覆盖成新实例；
- 已保存 tuple 但当前 Hub 无 IDs → legacy unverified，不冒充匹配；
- `same runtime later instance change` 反例已覆盖。

## request 持久化错误字段

写/锁/路径失败不会输出“已持久”。错误对象带有：

```json
{
  "request_id": "<id>",
  "operation": "create|retry|receipt|read|persist_request",
  "blocked_step": "persist_request|acquire_request_lock|read_request|verify_generation",
  "persisted": false,
  "retryable_same_request_id": true
}
```

生成 ID 后发生 fs 错误时，caller 应按同一 `request_id` 查询/重试；失败不覆盖原 metadata，不重发消息。`retry` 仍只观察，不发送。

## target allowed_senders（source 级授权）

配对是全局 source/target 登记；request 的 source 还必须出现在该 target 的 `receiver-config.json` 的 `allowed_senders` 内。

- `status`/`retry` 单独展示 `source_allowed_by_target`。
- config 存在但 `allowed_senders` 缺失或不含本 source → `WAITING_TARGET_ALLOWLIST`。
- 由原 target owner 用原工具修改**完整** allowlist；保留其他已授权 source，不得覆盖/删除。
- 本命令只读观察，不自动改 config、不自动 enable、不自动把新 source 加入。
- 更新后人工确认，再 `onboard retry`。

## owner enable / disabled 状态

owner opt-in/consent 与 enabled 是两件事：

- 有 owner_opt_in 但 membership `desired_state=DISABLED` 或 config `enabled=false` → `WAITING_OWNER_ENABLE`；保留 consent 证据，不 READY。
- 旧 status 仍显示 `ACTIVE` 也不能当成可投递；必须由 owner 用原工具显式恢复 enable。
- request 不会自动启动/拉起 receiver，不改 config/锁/账本/窗口/rate/startup。

## receiver guidance / 可投递性

shared `receiver-status` summary 只透传约定的安全 guidance 字段：

```text
code, blocked_step, message_zh, next_steps, retry_policy
```

不 spread 原始 status/raw guidance。rate-limited、paused-uncertain、CLI 暂停等会显示对应 blocked_step 和中文恢复步骤。

- 进程/worker `ACTIVE` 不等于立即可投递；只有 v3 identity + 新鲜心跳 + `online-idle` 且无暂停原因才可能 `ACTIVE`/READY。
- 非 `online-idle` 的 active 状态为 `ACTIVE_NOT_DELIVERABLE`，进入 WAITING_TARGET。
- 接入、worker、model receipt 仍是不同证据，不因 ACTIVE 合并成 received。

## 同一 runtime 的完整可执行流程（新增 --runtime 接缝）

network CLI（`pair` / `targets` / `send` / `status` / `consume`）现在支持显式 `--runtime <existing-hub-data-root>`；`--runtime` 是**该命令进程**的选择，不是全局状态，也不会 init/创建 config/token。

```powershell
$rt = 'D:/path/to/current/hub-data'

# 1. 只读发现现役 Hub
node bin/lab-bridge.mjs onboard discover --runtime $rt

# 2. 同一 root 配对，不要省略 --runtime
node bin/lab-bridge.mjs pair add 'dsh:session-<dsh-session-id>' --runtime $rt
node bin/lab-bridge.mjs pair add 'codex:<codex-thread-id>' --runtime $rt

# 3. 由 owner 在原 receiver 工具中修改 config：owner_opt_in/enabled=true，
#    allowed_senders 必须包含本 source，且保留其他既有 source；不自动改
node bin/lab-bridge.mjs onboard retry <request_id> --runtime $rt

# 4. 同一 root 读状态 / 发送 / 消费；全部显式同一 $rt
node bin/lab-bridge.mjs status --runtime $rt
node bin/lab-bridge.mjs send --to 'dsh:session-<dsh-session-id>' --text '...' --runtime $rt
node bin/lab-bridge.mjs status --msg-id <message-id> --runtime $rt
node bin/lab-bridge.mjs consume --msg-id <message-id> --runtime $rt
node bin/lab-bridge.mjs onboard status <request_id> --runtime $rt
```

- `--runtime` 必须指向已有 Hub 数据根；缺失 config/token 会 fail closed，不会创建新 runtime/token。
- 只接受 loopback `127.0.0.1`；非 loopback 不连接。
- 可选 `--installation <local-install-root>`：核对 locator runtime、Hub welcome installation/instance；不一致 fail `runtime-installation-mismatch` / `hub-instance-mismatch`。
- 同一进程不共享选择；每个命令都要带 `--runtime`（或下列仅该进程生效的 env）。

### 只对当前命令行生效的 env 替代

`LAB_BRIDGE_RUNTIME_DIR` 只对该子进程生效；不在 shell 中永久修改，使用 `finally` 恢复：

```powershell
$rt = 'D:/path/to/current/hub-data'
$old = $env:LAB_BRIDGE_RUNTIME_DIR
try {
  $env:LAB_BRIDGE_RUNTIME_DIR = $rt
  node bin/lab-bridge.mjs pair add 'dsh:session-<dsh-session-id>'
  node bin/lab-bridge.mjs status
} finally {
  if ($null -eq $old) { Remove-Item Env:LAB_BRIDGE_RUNTIME_DIR -ErrorAction SilentlyContinue }
  else { $env:LAB_BRIDGE_RUNTIME_DIR = $old }
}
```

`--runtime` 不是旧命令的全局参数；只有明确支持它的命令才使用它。`init` 不会用 `--runtime` 给接入创建新状态。
