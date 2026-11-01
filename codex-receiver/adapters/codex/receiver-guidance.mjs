// Presentation only. Stable machine codes remain authoritative; this module
// never pairs a peer, enables a receiver, retries a message, or reads a token.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidMessageId } from '../../src/protocol.mjs';

const entry = fileURLToPath(new URL('./receiver-control.mjs', import.meta.url));
const guide = fileURLToPath(new URL('../../README-CODEX.md', import.meta.url));
const namedCodes = new Set(['OFFLINE', 'DISABLED', 'EXPIRED', 'STARTED', 'UNRESPONSIVE', 'RATE_LIMITED', 'PREPARED_DISABLED',
  'IDENTITY_REVIEW_REQUIRED', 'PENDING_RELOAD', 'CONFIG_PATH_REQUIRED', 'source-unpaired', 'target-unpaired',
  'auth-failed', 'connect-failed', 'connection-closed', 'not-connected', 'request-timeout', 'welcome-timeout',
  'EACCES', 'EPERM', 'EBUSY', 'EEXIST', 'ENOENT', 'ENOTDIR', 'EROFS', 'ENOSPC']);
const stableCode = (value) => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(value) ? value : null;
function knownErrorCode(value) {
  if (stableCode(value) === null) return null;
  if (namedCodes.has(value)) return value;
  return /^(?:OWNER|BACKGROUND|BINDING|CLI|CLIENT|NO_COMPATIBLE|RECEIVER|PREPARE|MEMBERSHIP|RUNTIME|MANUAL|LEGACY|HUB|LOCK|LEDGER|SERVICE|STARTUP|RESTART|WORKER|WAIT|WAITING|PAUSED|BACKOFF|BLOCKED|TARGET|NATIVE|MODEL|ONLINE|ALREADY|DISABLE|UNKNOWN|CODE|ERR)_/.test(value) ||
    /^(?:client|receiver|receipt|native|ledger|msg-id|uncertain)-/.test(value) ? value : null;
}
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export function receiverErrorCode(error) {
  return knownErrorCode(error?.code) ?? knownErrorCode(error?.message) ?? 'RECEIVER_OPERATION_FAILED';
}

export function receiverGuidance(input = {}, { configPath } = {}) {
  const statusFirst = ['DISABLED', 'STOP_REQUESTED', 'PENDING_COMPANION', 'PREPARED_DISABLED', 'ALREADY_CONFIGURED',
    'CLI_REPAIRED', 'MODEL_RECEIVED', 'CLIENT_REPLY_RECORDED', 'ADOPTED_DISABLED', 'ALREADY_ADOPTED',
    'IDENTITY_REVIEW_REQUIRED', 'LOCK_RECOVERY_REVIEW_REQUIRED', 'PENDING_RELOAD'];
  const code = input.cli_repair_required === true ? 'CLI_REFRESH_REQUIRED' : stableCode(input.code) ??
    (statusFirst.includes(input.status) ? stableCode(input.status) : null) ??
    stableCode(input.reason_code) ?? stableCode(input.last_error) ?? stableCode(input.status) ?? 'RECEIVER_STATE_UNKNOWN';
  const status = input.status ?? null;
  const clientReplyProof = status === 'CLIENT_REPLY_RECORDED' && isValidMessageId(input.client_request_id) &&
    isValidMessageId(input.reply_msg_id) && isValidMessageId(input.msg_id) && uuid.test(input.receiving_turn_id ?? '') &&
    String(input.evidence_grade ?? '').startsWith('MODEL_REPORTED');
  const nativeProof = (['NATIVE_QUEUED_NOT_MODEL_PROOF', 'NATIVE_QUEUED', 'MODEL_RECEIVED'].includes(status) || clientReplyProof) && typeof input.native_queue_id === 'string' && input.native_queue_id.length > 0;
  const modelProof = (status === 'MODEL_RECEIVED' || clientReplyProof && input.model_receipt_status === 'MODEL_RECEIVED') && (nativeProof || input.delivery_route === 'MANUAL_ACTIVE_TURN') && uuid.test(input.receiving_turn_id ?? '') &&
    isValidMessageId(input.msg_id) && String(input.evidence_grade ?? '').startsWith('MODEL_REPORTED');
  let blockedStep = 'INSPECT_RECEIVER', retryPolicy = 'RECHECK_STATUS';
  let message = '接收状态尚未核实；保留原请求和消息 ID，先查询状态，不据此声称已收信。';
  let steps = ['查询同一请求 ID 的 onboard status，并核对目标、Hub 数据根和当前配置。', '运行 receiver status/doctor；未知状态不要删除锁、账本或改用另一个线程。'];
  let actions = ['status', 'doctor'];
  if (['OWNER_THREAD_MISMATCH', 'OWNER_TARGET_MISMATCH', 'BACKGROUND_WORKER_CONTEXT_NOT_SANITIZED', 'receipt-identity-invalid'].includes(code)) {
    blockedStep = 'TARGET_OWNER_CONTEXT'; retryPolicy = 'ORIGINAL_THREAD_ONLY';
    message = '当前执行上下文不属于目标原线程，操作已拒绝。';
    steps = ['切到目标的真实 Codex 原对话，由该对话执行 prepare/enable/repair 或收信回执。', '核对宿主原生 CODEX_THREAD_ID；不要手工设置成别的线程 ID，也不要让 PCA 或另一对话冒充目标。', '原请求仍保留；配对完成也不能替代目标 owner opt-in。'];
    actions = ['status'];
  } else if (['EPERM', 'EACCES', 'EBUSY', 'EROFS', 'ENOSPC'].includes(code)) {
    blockedStep = 'PERSIST_OWNER_CONFIGURATION'; retryPolicy = 'VERIFY_STATE_BEFORE_OWNER_RETRY';
    message = '配置写入被占用、权限或磁盘状态阻止，操作尚未确认完成。';
    steps = ['先查询当前 enabled/stop/进程状态，保留现有配置、锁、账本和请求 ID。', '解除该目标文件占用或磁盘问题后，由原 owner 重试同一配置操作；不要删除目标文件或清账本来强行成功。', '这不是原生消息重试许可；如同时有不确定提交，先核对原 msg_id 的实际结果。'];
    actions = ['status'];
  } else if (['source-unpaired', 'target-unpaired', 'TARGET_UNPAIRED', 'PAUSED_PAIRING_REVOKED'].includes(code)) {
    blockedStep = 'PAIR_EXACT_PEERS'; retryPolicy = 'RECHECK_PAIRING_BEFORE_SAME_MESSAGE';
    message = '指定来源或目标尚未配对，或配对已撤销。';
    steps = ['用 onboard request --source <真实来源> --target <真实目标> --user-authorized --request-id <原请求ID> --runtime <已发现数据根> 持久登记。', '按明确用户授权或双方 owner opt-in 只登记这两个精确身份，再核对目标 allowed_senders。未知来源不默认放行。', '明确被 Hub 拒绝的消息可在修复后复用原 msg_id 和原正文重试；若原生结果不确定，先按不确定流程核对。'];
    actions = ['status'];
  } else if (clientReplyProof) {
    blockedStep = null; retryPolicy = 'QUERY_SAME_REQUEST_NO_NEW_SUBMISSION';
    message = '关联答复已获 Hub 保存确认；本地模型收信文件状态另列，不据此代替业务验收。';
    steps = ['用原客户端身份查询同一个 request_id 的状态和结果；保留原 msg_id、回复 ID 与正文 hash。', '本地 receipt 写入未确认时保留答复成功状态，不重新提交 native 或更换请求 ID。'];
    actions = ['status'];
  } else if (/CLIENT_REPLY_.*(?:MISMATCH|NOT_CONFIRMED)|client-.*uncertain|CLIENT_.*UNCERTAIN/.test(code)) {
    blockedStep = 'RECONCILE_CLIENT_REQUEST'; retryPolicy = 'NO_RESUBMIT_REVIEW_REQUIRED';
    message = '客户端答复或提交回执尚未确认，原操作可能已经完成。';
    steps = ['保留原 request_id/msg_id/native queue 和回复文件，查询同一客户端请求的状态与结果。', '不要换请求 ID、重交 native 或清账本；已有答复只补确认。'];
    actions = ['status'];
  } else if (/^CLIENT_|^client-/.test(code)) {
    blockedStep = 'VERIFY_CLIENT_CORE_GRANT_AND_REPLY'; retryPolicy = 'RECHECK_SAME_CLIENT_REQUEST';
    message = '客户端协议、精确授权或回复证据尚未通过核验。';
    steps = ['核对所选 core 的 client_requests_v1 能力、精确客户端/target、grant 期限/撤销状态与原请求 ID。', '由原 owner 核对 allowed_clients；回复正文仅放本 target runtime/replies 下的有界 UTF-8 文件。', '不借用 DSH/操作员身份、不自动配对/续授权；结果不明时只查原请求，不换 ID 重投。'];
    actions = ['status'];
  } else if (code === 'CLI_REPAIRED') {
    blockedStep = 'RECHECK_OWNER_RECEIVER'; retryPolicy = 'RECHECK_STATUS';
    message = 'CLI 元数据已修复，绑定和启用状态保持原样。';
    steps = ['重新查询 receiver status/doctor；若目标仍停用，由真实原线程按原模式 enable。', '不要因修复成功声称 worker 已运行或模型已收信。'];
    actions = ['status', 'doctor'];
  } else if (code === 'CLI_PATH_REQUIRED') {
    blockedStep = 'SELECT_INSTALLED_CLI'; retryPolicy = 'ORIGINAL_THREAD_PREPARE';
    message = '首次 prepare 需要明确选择已安装的 Codex CLI。';
    steps = ['在原线程用 Get-Command codex.exe | Select-Object -ExpandProperty Source 只查询当前安装路径，将其作为 --cli 参数。', 'prepare 会进一步验证原 vendor 根、版本、queue 能力和文件 hash；不要下载或随意执行其他 PATH 程序。'];
    actions = [];
  } else if (/CLI_|^NO_COMPATIBLE_INSTALLED_CLI$/.test(code) || code === 'PAUSED_BINARY_CHANGED') {
    blockedStep = 'VERIFY_INSTALLED_CLI'; retryPolicy = 'OWNER_REPAIR_THEN_RECHECK';
    message = 'Codex CLI 路径、版本或能力未通过核验，接收已暂停。';
    steps = ['先运行只读 doctor，核对原 vendor Codex/bin 根下唯一可验证的 CLI。', '由真实目标原线程运行 repair-cli，随后重新查询状态；修复不应更换绑定、额度、窗口或账本。', '存在多个候选、越根、构建不兼容时保留暂停，不按文件时间猜测、不下载替代程序。'];
    actions = ['status', 'doctor', 'repair-cli'];
  } else if (['NATIVE_OUTCOME_UNCERTAIN', 'PAUSED_UNCERTAIN', 'native-output-not-confirmed', 'uncertain-native-submission-review-required'].includes(code)) {
    blockedStep = 'REVIEW_NATIVE_OUTCOME'; retryPolicy = 'NO_RESUBMIT_REVIEW_REQUIRED';
    message = '原生提交结果不确定，已暂停；该消息可能已经执行。';
    steps = ['保留原 request_id、msg_id、ledger 和原生队列证据，核对目标原线程与原生 queue ID。', '不要重发、换新 msg_id、清账本或重复 enable 来绕过暂停。', '只有确认原消息的实际结果后再决定恢复；native 已接受但 Hub 未 consume 时只补确认。'];
    actions = ['status'];
  } else if (['RATE_LIMITED', 'WAITING_COOLDOWN', 'ROLLING_BUDGET_OR_COOLDOWN'].includes(code)) {
    blockedStep = 'WAIT_FOR_QUOTA'; retryPolicy = 'WAIT_UNTIL_ELIGIBLE';
    message = '正在等待滚动额度或最短间隔，消息仍按原有效期排队。';
    steps = ['查看 remaining_native_submissions、next_eligible_at 与消息 TTL，等待可提交时间。', '不要重建窗口、删除账本或临时增加预算；重启不会刷新额度。'];
    actions = ['status'];
  } else if (['PENDING_COMPANION', 'NO_VERIFIED_COMPANION_WORKER'].includes(code)) {
    blockedStep = 'WAIT_FOR_VERIFIED_WORKER'; retryPolicy = 'RECHECK_SELECTED_COMPANION';
    message = '启用意愿已登记，但尚无经过核验的 companion worker。';
    steps = ['核对原安装 locator、runtime 和 companion 状态；PENDING_COMPANION 不是接收器已运行或模型收信。', '不要另起 Hub 或第二 supervisor，也不要为接入而切换现役 profile/Task；按当前安装恢复路径处理。'];
    actions = ['status', 'doctor'];
  } else if (['OFFLINE', 'RECEIVER_NOT_RUNNING', 'NOT_STARTED', 'RECOVERING_WORKER'].includes(code)) {
    blockedStep = 'START_OR_RECOVER_OWNER_RECEIVER'; retryPolicy = 'OWNER_ACTION_ONLY';
    message = '尚无核实的目标接收器，配对成功并不表示能够自动收信。';
    steps = ['由目标真实原线程核对配置，完成 prepare/enable；已有监督器恢复中时先查询其状态。', '只处理该目标，保留其他接收器、Hub 和配对；运行中的未知进程不允许强制替换。'];
    actions = ['status', 'doctor'];
  } else if (code === 'ADOPTION_ABORTED') {
    blockedStep = 'INSPECT_RECEIVER'; retryPolicy = 'ORIGINAL_OWNER_REVIEW_ONLY';
    message = '已终止这条迁移记录；未把旧备份覆盖回当前配置，也未恢复旧登录启动项，接收器状态仍需核实。';
    steps = ['核对原 config/window/ledger 和实际进程；终止迁移不等于接收器在线。', '需要再次迁移时，由原 owner 在同一安装重新执行 adopt，保留完成或终止审计。'];
    actions = ['status', 'doctor'];
  } else if (code.startsWith('LEGACY_') || code.startsWith('STARTUP_')) {
    blockedStep = 'LEGACY_OWNER_HANDOVER'; retryPolicy = 'ORIGINAL_OWNER_REVIEW_ONLY';
    message = '旧接收器迁移尚未确认；保留原配置、锁、账本和迁移记录。';
    steps = ['仅由真实原对话核对同一安装和 runtime；旧 PID 默认须由系统确认不存在，不向存活或未知进程发信号。',
      '有 adoption transaction 时，用原 owner 的 adopt-resume 在同安装核 nonce/config/backup 和 fresh CIM 后继续；adopt-abort 仅终止未提交配置的事务，不覆盖新配置。不要手删 journal 或盲重跑普通 adopt。',
      '仅显式 --accept-proven-reuse 才允许归档经 CIM 路径与出生时间证明为新 conhost 的旧 Node 锁；Node/未知进程仍拒绝且不发信号。注册表读取使用结构化只读结果，权限/未知错误不算缺值。',
      '迁移完成只产生 disabled 配置，原 owner 再明确 enable；不添加 Windows 启动项，不改变其他接收器。'];
    actions = ['status', 'doctor'];
  } else if (['PREPARED_DISABLED', 'ALREADY_CONFIGURED', 'ADOPTED_DISABLED', 'DISABLED', 'DISABLED_BY_OWNER'].includes(code)) {
    blockedStep = 'OWNER_ENABLE'; retryPolicy = 'ORIGINAL_THREAD_OPT_IN';
    message = '配置已准备或目标已停用；尚不能据此声称接收器在运行。';
    steps = ['核对精确 allowed_senders 后，由目标真实原线程执行 enable。', '再次查询状态和进程健康；随后等待实际业务消息与模型回执，不为验证自动发送探针。'];
    actions = ['status', 'enable'];
  } else if (['WAITING_FOR_TARGET_IDLE', 'BUSY', 'BUSY_OR_DISABLED_BEFORE_SUBMIT'].includes(code)) {
    blockedStep = 'WAIT_FOR_ORIGINAL_THREAD_IDLE'; retryPolicy = 'WAIT_NO_DUPLICATE_SUBMIT';
    message = '目标原线程忙碌，等待当前轮结束。';
    steps = ['保留排队消息，等待原线程空闲、额度和 TTL 同时允许。', '不要抢占当前轮、开第二 executor 或换目标发送。'];
    actions = ['status'];
  } else if (['HUB_UNREACHABLE', 'BACKOFF_HUB', 'HUB_CONFIG_MISSING_OR_INVALID', 'HUB_CONFIG_INVALID', 'HUB_TOKEN_MISSING', 'HUB_TOKEN_INVALID', 'HUB_RUNTIME_UNBOUND_LEGACY', 'MANUAL_HUB_RUNTIME_NOT_READY'].includes(code)) {
    blockedStep = 'DISCOVER_SELECTED_HUB'; retryPolicy = 'RECHECK_SAME_RUNTIME';
    message = '所选 Hub 数据根尚未绑定或当前不可达。';
    steps = ['用 onboard discover --runtime <明确现有数据根> 核对当前 Hub、实例和配对；多份 runtime 时先裁决，不自动合并。', '保留原请求，用 onboard status/retry 重新只读发现；不要初始化第二份 token/runtime 或停止别人的 Hub。'];
    actions = ['status'];
  } else if (['LEGACY_CONFIG_REQUIRES_EXISTING_TOOL', 'LEGACY_ADOPTION_REQUIRES_EXPLICIT_MIGRATION', 'MANUAL_RUNTIME_REQUIRES_LEGACY_HUB', 'LEGACY_STARTUP_REQUIRES_MIGRATION'].includes(code)) {
    blockedStep = 'SELECT_EXISTING_INSTALLATION_PATH'; retryPolicy = 'REVIEW_EXISTING_MODE';
    message = '当前是已有安装或旧接收器，不能通过新手动接入静默迁移。';
    steps = ['已有 locator 用安装模式；已有旧 receiver 用其原工具和原线程恢复。', 'prepare --manual-runtime 只用于明确选择现有 legacy Hub 的新目标；不注册登录启动，也不替代整套迁移批准。'];
    actions = ['status'];
  } else if (/INSTANCE|RUNTIME_.*CONFLICT|REPARSE|CONFIG_PATH_CONFLICT|PROTOCOL_BINDING|HUB_OWNER_MODE_CHANGED/.test(code)) {
    blockedStep = 'VERIFY_RUNTIME_AND_BINDING'; retryPolicy = 'PAUSE_INSTANCE_REVIEW';
    message = 'Hub 实例、运行数据根或目标绑定存在冲突，操作已暂停。';
    steps = ['比较 onboard discover 的所选 runtime/installation/instance 与 receiver 配置；不要回退到包目录或另一个实例。', '确认准确现役实例和绑定后按该路径修复；未知代际和旧积压保留待决定。'];
    actions = ['status'];
  } else if (/LOCK|IDENTITY|UNRESPONSIVE|UNCONFIRMED|NO_REPLACEMENT|WAIT_FOR_DISABLE|RESTART|HALTED|LEDGER_INVALID|CAPACITY|PENDING_RELOAD|CODE_CHANGED/.test(code)) {
    blockedStep = 'REVIEW_OWNER_AND_PERSISTED_STATE'; retryPolicy = 'NO_AUTOMATIC_TAKEOVER';
    message = '进程身份、恢复预算、账本或运行代码需要复核。';
    steps = ['保留锁、创建时间/入口/nonce、ledger 和失败计数，查询 status/doctor 的具体原因。', '不要按 PID/TTL 强抢、删除锁或清空恢复预算；确认该目标旧 worker 已安全退出后才按 owner 流程恢复。'];
    actions = ['status', 'doctor'];
  } else if (status === 'NATIVE_QUEUED_NOT_MODEL_PROOF' || code === 'NATIVE_QUEUED') {
    blockedStep = 'WAIT_FOR_MODEL_RECEIPT'; retryPolicy = 'NO_RESUBMIT_AFTER_NATIVE_ACCEPTANCE';
    message = '已报告原生队列接受；仍需目标原线程的实际模型收信回执。';
    steps = ['保留原 msg_id/native_queue_id，查询同一请求；Hub consume 也不是模型已处理。', '模型实际读到消息后，由目标原线程用真实 receiving turn ID 记录 receipt；不要预先伪造回执或重发。'];
    actions = ['status'];
  } else if (status === 'MODEL_RECEIVED' && modelProof) {
    blockedStep = null; retryPolicy = 'NO_AUTOMATIC_REPLY';
    message = '目标原线程已记录模型收信声明；这不表示业务完成或必须回复。';
    steps = ['保留 msg_id、receiving_turn_id，以及存在时的原生 queue ID；活跃回合手动读取不是 idle 唤醒证明，唤醒验收另与原生线程/rollout 关联。'];
    actions = ['status'];
  } else if (status === 'ONLINE_IDLE') {
    blockedStep = 'WAIT_FOR_BUSINESS_MESSAGE'; retryPolicy = 'NO_PROBE_REQUIRED';
    message = '接收器当前报告空闲；这不是任意业务消息已经收到的证明。';
    steps = ['查询进程核验与配对，等待实际业务消息；通过原 msg_id 和模型回执确认收信。'];
    actions = ['status'];
  }
  return {
    code, blocked_step: blockedStep, message_zh: message, next_steps: steps, retry_policy: retryPolicy,
    evidence: { receiver_running: typeof input.running === 'boolean' ? input.running : null,
      receiver_healthy: typeof input.healthy === 'boolean' ? input.healthy : null,
      native_queue_accepted: nativeProof ? true : input.native_submitted === false ? false : null,
      model_receipt_reported: modelProof ? true : null,
      client_reply_recorded: clientReplyProof ? true : null,
      model_receipt_grade: modelProof ? 'MODEL_REPORTED; correlate with native thread/rollout' : 'NOT_ESTABLISHED' },
    next_commands: typeof configPath === 'string' ? actions.map((action) => ({
      argv: [process.execPath, entry, action, path.resolve(configPath)],
      requires_original_thread: ['enable', 'repair-cli'].includes(action),
      effect: ['enable', 'repair-cli'].includes(action) ? 'OWNER_CONFIG_WRITE' : 'READ_ONLY',
    })) : [],
    guide_path: guide,
  };
}
