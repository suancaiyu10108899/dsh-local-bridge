# Optional Codex daily receiver

MIT licensed. Optional, experimental source package with target-scoped reception, an installed companion mode, and explicitly authorized dot client requests. Installing the source and enabling an original target are separate operations; see the version's release notes for its actual host validation. The published alpha.1 is the historical receiver baseline.

This receiver targets an existing Codex conversation on the same Windows machine and OS user through the installed native `codex queue` command. Installed mode uses one shared installation locator, Hub and companion. Explicit manual mode can add a new owner-approved target to an existing legacy Hub without installing a locator or migrating the shared service. Neither mode starts a host or acts as a marketplace plugin. Existing receivers keep their original tool and lifecycle unless a migration is explicitly reviewed.

Requires Node 24.15.0 or newer on Windows. Historical native reception used Codex CLI 0.163.0-alpha.11; current compatibility discovery also checks 0.166.0-alpha.5.1. A version/help check does not prove queue consumption or model wake. `node:sqlite`, the owner's local `state_5.sqlite` row and that thread's rollout lifecycle format are version-sensitive prerequisites. Do not distribute any Codex executable, state database or chat transcript.

## 当前手动接入入口

完整流程与共享请求查询见 [手动接入指南](../docs/MANUAL-ONBOARDING.md)。旧私有 `adapters/codex/README.md` 的 v1 / 无常驻说明是历史能力记录，不是当前 daily receiver 的入口。不要为了修正文档修改现役 watched source、HMR 或共享宿主。

手动表示显式执行命令：在已获用户授权或真实目标 owner opt-in 的范围内可由对话直接完成，不需要 PCA 逐条转述、配对审批或另发探针。来源和目标必须是精确真实 ID；消息权限不提供产品 writer/publisher 权。

先在 core 根执行 `node bin/lab-bridge.mjs onboard discover --runtime '<明确当前Hub数据根>'`，并用 `onboard request/list/status/retry/revoke` 保留同一个请求 ID。未配对也能登记；没有授权的请求等待 owner consent，不自动放行未知来源。请求文件位于 `<Hub数据根>/onboarding/requests/`，不依赖 PCA 私有目录。`retry` 只核对状态，不重发业务消息；`revoke` 请求不自动关闭其他目标。

接收器配置操作必须在**目标真实 Codex 原线程**执行。只读取宿主原生 `$env:CODEX_THREAD_ID` 核对自己；不要手工设置为另一个线程的 ID。`OWNER_THREAD_MISMATCH` 时回到目标原线程，不能用复制环境变量或另一个 executor 绕过。

### 新目标接入当前 legacy Hub（无需先迁移 companion）

在 receiver 包根、目标原线程中执行；`--manual-runtime` 是已有 Hub 数据根，包含其既有 `hub/config.json` 与 `hub/token`，不是 receiver 目录：

```powershell
$cli = (Get-Command codex.exe -ErrorAction Stop).Source
node adapters/codex/receiver-control.mjs prepare --manual-runtime '<明确当前Hub数据根>' --sender 'dsh:session-<已获授权的真实session UUID>' --cli $cli
node adapters/codex/receiver-control.mjs status '<prepare返回的config_path>'
node adapters/codex/receiver-control.mjs enable '<prepare返回的config_path>'
node adapters/codex/receiver-control.mjs status '<prepare返回的config_path>'
```

先按 core 指引登记精确 source 与 target 的 pairing，目标 `allowed_senders` 只列已授权来源。Prepare 只生成 `<Hub数据根>/codex/<当前真实thread ID>/receiver-config.json`，默认 disabled；enable 才启动这个目标的手动监督器/worker。它不创建 Hub、token、locator、companion、profile 或 Task，也不启用登录启动。已有 locator、runtime 冲突、越界 junction 或未标记的旧配置都会拒绝，不据此静默迁移。

配置完成、配对完成、接收器健康、原生队列接受、Hub consume 和模型回执是不同证据。`ONLINE_IDLE` 只说明本轮状态；等待实际业务消息，按原 msg_id 核实模型回执。模型在活跃回合用普通 CLI 读到消息也不算 idle 唤醒。空队列不调用模型，自动回复默认关闭。

### 旧配置 CLI 路径失效：修复后仍用原生命周期

已有旧配置不要重新执行 `prepare --manual-runtime`，也不要删除锁或账本。目标原线程先运行只读 doctor 和限定 CLI 修复：

```powershell
node adapters/codex/receiver-control.mjs doctor '<已有config_path>'
node adapters/codex/receiver-control.mjs repair-cli '<已有config_path>'
```

修复只更新同 vendor 根内可验证的 CLI 元数据，保留原 thread/cwd/rollout、allowed_senders、window/epoch、额度、ledger、enabled/startup 选择。随后用**该旧接收器原来的 receiver-control 入口** enable/status；不拿本候选的 installed/epoch 要求冒充当前旧 Hub，也不通过新 supervisor 覆盖仍在运行的旧 worker。仅修复 CLI 不会 enable 或提交消息。歧义、不兼容、未知旧锁或不确定 native 结果应保留暂停，按中文 guidance 核对后恢复。

### 已批准切换 companion：原 owner 显式迁移旧 daily 配置

只有 core 已完成同一个 runtime 的安装切换、旧 worker/supervisor 已停止时，原 Codex 对话才运行新版入口：

```powershell
node adapters/codex/receiver-control.mjs adopt '<existing-config-path>' --installation-root '<installed-core-root>'
node adapters/codex/receiver-control.mjs enable '<same-config-path>'
```

`adopt` 核对原 owner、原生 thread/cwd/rollout、同 runtime 安装和兼容 CLI。系统默认必须确认旧记录中的全部 PID 已不存在；存活、复用、未知进程或外部编辑均拒绝，不发信号。它备份该配置、归档该目标已确认失效的旧锁，保留 window、ledger、来源白名单、额度与 no-login 选择，仅移除精确匹配的旧 HKCU Run 值，不新增启动项。注册表查询读取 .NET 的结构化 presence/type 结果；本地化的 `reg.exe` 缺值提示和退出码不能代替缺值证明。迁移得到 disabled、新 epoch 的安装配置；原 owner 的明确 `enable` 才登记 companion 成员。旧未标注 epoch 的消息保留待核对，不擅自补标投递。已有不确定原生结果仍需核对；迁移不授予重投许可。

部分失败保留 `legacy-adoption.transaction`。status 会报告恢复待处理，prepare/enable/repair-cli 不越过它。由原 owner 在同一安装执行：

```powershell
node adapters/codex/receiver-control.mjs adopt-resume '<same-config-path>' --installation-root '<same-core-root>'
# 仅在配置尚未提交、需要终止这条事务时：
node adapters/codex/receiver-control.mjs adopt-abort '<same-config-path>' --installation-root '<same-core-root>'
```

恢复核对 journal nonce、精确原备份、当前配置和锁指纹、原 owner/原生绑定及 fresh CIM。它可以继续旧版在写配置之前中断的事务，也能完成新版在写完 disabled 配置后中断的锁归档；不会把旧备份覆盖回更新后的配置或账本。终止只归档未提交配置的事务，不重新创建旧登录注册。未知或并发变化保留暂停，不能手删 journal 绕过。

若旧 Node PID 明确被复用为新 `conhost.exe`，原 owner 可在 `adopt` 或 `adopt-resume` 上显式加 `--accept-proven-reuse`。仅当系统同时提供该 exe 路径和晚于所有旧记录的出生时间时，才归档本目标旧锁；不向那个进程发信号。Node、路径/时间不明或不能证明复用的 PID 仍拒绝。此选项不是强制接管。

### Codex 接收器健康，但发往 DSH 的消息未投递

先用所选 Hub 的工具查询**原业务 msg_id**，先看当前 `state` 和 `delivered_at`。若已 `state=delivered` 且有投递时间，即已完成该条消息的传输确认；残留的 `last_error=session-not-live` 是历史错误，不应继续提示离线或要求恢复。只有消息仍为 `queued` / `delivery_unknown`、无 `delivered_at` 且 `last_error=session-not-live` 时，才按 DSH 会话未加载处理；`delivery_unknown` 单独不足以确定原因。Hub 配对、DSH adapter 已连接、Codex 接收器心跳正常，都不能证明精确的 DSH 目标会话已加载。

由 DSH 目标原 owner 使用宿主原生入口打开/恢复**同一个原会话**。保留现有消息与 TTL，等待 Hub 对原 msg_id 的正常延后重试；这种延后不消耗有界 attempts，仍受 TTL 限制。不要为此重复 pair/enable、创建替代会话、换 ID 重发业务、开启管理工具或重启共享宿主。`onboard retry` 只更新请求观察，不会重发业务。恢复后核对原消息的实际投递和目标处理结果；投递确认与模型处理、业务完成分别记录。已过期或出现其他错误时保留原记录，按真实状态决定下一步。

## Scoped dot client peers

A supporting core can grant an exact `client:dot-<uuid>` identity a local, expiring and revocable request/reply scope. The client is separate from the DSH/Codex adapter roles. It receives its own credential file and reply mailbox; the existing Hub token stays local. `--origin`, pairing alone, or adding a sender string is not a substitute for that grant. Client reception requires `welcome.capabilities.client_requests_v1=true` and the authoritative submission gate before a request can reach the native queue.

The target owner prepares and enables its own exact conversation using the current installation mode. For an existing companion installation:

```powershell
node adapters/codex/receiver-control.mjs prepare --installation-root '<existing-core-installation>' --client-sender 'client:dot-<approved-client-uuid>' --cli '<verified-installed-codex.exe>'
node adapters/codex/receiver-control.mjs enable '<returned-config-path>'
```

`allowed_clients` defaults to empty. It and the existing DSH `allowed_senders` have a combined daily limit of eight exact identities. A client-only target can have no DSH sender; do not invent a DSH session to pass validation. Existing installations and legacy configs keep their supported migration/owner procedure. Preparation starts disabled; it does not silently adopt old configs, grant client access, start another Hub, or change another target.

Requests carry an immutable `client_request_id` and a fixed reply mailbox equal to the sender identity. Before a new native submission the receiver must pass the core's current grant/expiry/cancel/lease gate; a local allowlist alone cannot authorize it. Busy targets wait, and an uncertain native outcome pauses. After confirmed native acceptance, lost outcome/consume acknowledgements are reconciled from the existing ledger without another native submission. Requests already committed to a native queue cannot be promised retractable.

After the target model actually handles the request, the native wrapper provides a reply argument array with the real request ID and a reply-file path below that target's `runtime_dir/replies`. Write only the bounded UTF-8 answer there and use the actual original-thread turn ID:

```powershell
node adapters/codex/receiver-control.mjs reply '<config-path>' --request-id '<original-request-id>' --turn-id '<actual-current-native-turn-id>' --body-file '<reply-file-path-from-wrapper>'
```

Reply checks the original owner and target binding, the matching request/message/window, the existing native queue evidence, and the saved message fingerprint. It refuses arbitrary file paths, outside-directory links, empty/binary/oversized answers and unknown evidence. The CLI emits receipt metadata, not the reply body or credentials. A missing local model-receipt file does not erase a separately confirmed server reply. Query the same client request/result after uncertainty; do not create another ID or submit native work again. Reply evidence is owner-context-correlated and model-reported, not independent host/cloud authentication or automatic business acceptance. Communication grants do not grant repository writes, PR disposition or member contact.

## Installed DSH sender opt-in

Use this path when a reviewed core installation/locator already exists in `COMPANION_OWNED` mode. It is not a prerequisite for the explicit legacy manual path above. From the original native Codex target conversation, use the receiver package root, with the actual host thread environment. Pair only intended peers through the supported core setup. Then:

```powershell
node adapters/codex/receiver-control.mjs prepare --installation-root '<core-installation-root>' --sender dsh:session-<approved-session-id> --cli '<installed-codex.exe>'
node adapters/codex/receiver-control.mjs status '<config-path-returned-by-prepare>'
node adapters/codex/receiver-control.mjs enable '<config-path-returned-by-prepare>'
```

Preparation leaves the receiver disabled. Enable persists exact owner opt-in and membership; the companion discovers and starts that worker directly. `PENDING_COMPANION` means no verified worker has started and is not a delivery receipt. Enable never starts another Hub or supervisor. Daily mode has no fixed expiry, defaults to six submissions per rolling hour and a 30-second cooldown, and preserves existing custom limits when setup only repairs the CLI. No eligible messages means no model call. Message TTL still applies. Busy targets wait for their current turn; a legacy role-wide Codex adapter blocks reception instead of being replaced.

The installed default locator is `%LOCALAPPDATA%/LocalAgentBridge/installation.json`; its `runtime_root` is authoritative for the Hub, membership and receiver files. The target config is `<runtime_root>/codex/<thread-id>/receiver-config.json`. An ambient runtime override, wrong instance, escaping junction or unexpected config location fails rather than selecting a package-local runtime. Existing unbound configurations require an explicit migration to installed mode; manual onboarding does not perform that migration. The separate internal `runtimeRoot` API remains for synthetic tests/development.

`enable CONFIG --login` records this target's login preference; `--no-login` clears it. Omitting both preserves the preference. These commands do not register a task or an HKCU Run value. The single companion startup task is managed separately by the core installer after its footprint is reviewed. Legacy manual configurations retain a limited manual supervisor path; they are not the installed production route.

## CLI compatibility and diagnosis

Prepare, enable, worker recovery and doctor share one resolver. A valid pinned CLI wins. If removed by an update, resolution stays within the recorded vendor `Codex/bin` root and verifies the real path, version, queue flags and binary hash. An in-root PATH entry is a hint; arbitrary PATH executables and file-age guesses are rejected. Ambiguous or incompatible candidates pause. No binary is downloaded or installed.

```powershell
node adapters/codex/receiver-control.mjs doctor '<config-path>'
node adapters/codex/receiver-control.mjs repair-cli '<config-path>'
```

Doctor is read-only. The owner-only repair updates CLI metadata with a backup and audit record while preserving binding, quota, login preference and message ledger. A concurrent owner configuration change aborts the repair. Neither command submits a message or enables the target.

Status schema v3 separates the installation `instance_id` from the process `worker_nonce`. Health requires the matching process creation time, executable/entry, nonce and fresh heartbeat. Incomplete old locks are `IDENTITY_REVIEW_REQUIRED`; a reused PID is not treated as the receiver. Interrupted lock transactions and corrupt restart snapshots require review rather than silently resetting state. Preserve those records during diagnosis.

CLI errors and receiver status include an optional `guidance` object: stable `code`, `blocked_step`, Chinese `message_zh`/`next_steps`, `retry_policy` and explicit evidence boundaries. Suggested commands are argv arrays, not shell snippets. `OWNER_THREAD_MISMATCH`, offline/CLI repair, quota/cooldown and uncertain native outcomes have distinct recovery paths. Missing model receipt is `NOT_ESTABLISHED`, even if pairing or worker health succeeded. Unknown errors do not expose raw exception text, tokens or chat content.

Status also reports the declared installation version, the actual package/code hash and the worker's startup code identity separately. Changed code is `PENDING_RELOAD`; a running worker pauses before another submission if its package bytes change. Code identity excludes runtime tokens/messages. Matching a version string alone is not deployment evidence.

Native queue acceptance, Hub consume and model receipt are separate events. Uncertain native outcomes pause without blind retry. Peer text is external AI data, never a new human grant or approval. Allowlisted sender IDs and self-reported local binding do not provide independent host authentication against another process running as the same OS user.

Installed reception also requires a same-instance protocol-v1 Hub that advertises server-side binding epochs. An older or mismatched Hub is `PAUSED_PROTOCOL_BINDING_REQUIRED`. Old unstamped or previous-epoch messages remain queued for an explicit backlog decision; the receiver never assigns them the current epoch. Legacy unbound configurations retain their earlier experimental semantics.

## Stop and uninstall

```powershell
node adapters/codex/receiver-control.mjs disable '<config-path>'
```

Disable records the owner's disabled desired state and stops only that target through its companion or declared legacy path. `stop_confirmed=false` means the stop is unconfirmed, not successful. Unknown process identity does not authorize signalling a PID. Legacy startup cleanup and source-link/profile migration belong to a reviewed core migration. After a confirmed stop, preserve the shared Hub, pairings, other targets, profiles and user histories; removal of user data is a separate explicit choice. Real sign-out/reboot recovery remains NOT_RUN.

## Privacy and limits

Hub and receiver runtime can contain full message text, identifiers, absolute paths, native receipts and local tokens. Do not publish them or upload logs automatically. The native message is submitted to the user's configured model service and may incur its usual model cost. This companion adds no cloud relay and provides no end-to-end encryption or multi-user authentication claim.

Historical supported claim: local Windows same-user experimental daily target-scoped reception with original-thread busy-to-idle samples. The new Stage A candidate is undergoing isolated validation; those old samples are not proof that this branch is installed or validated in a live host. No exactly-once business-action, unattended uptime, cross-device/cloud/multi-user, generic Linux/macOS, project/session creation or future-build compatibility guarantee.

Tests do not prove cold third-party host installation. NOT_RUN unless separately recorded in a version's acceptance evidence: independent third-party cold install/A9, real sign-out/reboot, long real-time soak, broad upgrade/rollback and host-build matrix, uninstallation after adversarial external edits, and official plugin/marketplace host mounting. Historical executor-cell wake failure and sender-fixture escaping failure remain history; no raw transcripts are included.

Run `node --test tests/*.test.mjs` from the receiver package. CLI/locator/identity/cold-path tests use synthetic files and injected CLI responses; they never run the installed native queue. The client integration tests use a real isolated core server and require the complete repository; a standalone receiver export explicitly skips those tests. Independent process tests use only their own busy fixture workers. Test counts belong to their saved checkpoint outputs and are not a stable-version claim. Shared `src/` files are generated from the canonical core; do not edit that snapshot independently.
