// Manual onboarding request ledger and read-only discovery.
//
// This is deliberately not pairing, owner enable, receiver enable or message
// delivery. It persists one exact source/target request under the selected
// runtime and records what the current Hub/receiver already reports. It never
// writes a Hub token, queue/ledger content or chat text.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HubClient } from './client.mjs';
import { defaultInstallationRoot, installationPaths, readInstallation } from './installation.mjs';
import { RUNTIME_DIR, runtimePaths } from './runtime.mjs';
import { isValidIdentity, isValidMessageId, identityRole } from './protocol.mjs';
import { readReceiverStatusesAsync } from './receiver-status.mjs';
import { listMemberships } from './membership.mjs';

export const ONBOARDING_SCHEMA_VERSION = 1;
export const ONBOARDING_STATES = Object.freeze([
  'REQUESTED', 'WAITING_OWNER_CONSENT', 'WAITING_PAIR', 'WAITING_TARGET_ALLOWLIST', 'WAITING_OWNER_OPT_IN', 'WAITING_OWNER_ENABLE', 'WAITING_TARGET', 'OBSERVED_LEGACY_UNVERIFIED', 'LEGACY_METADATA_UNSUPPORTED', 'OBSERVED_READY', 'BLOCKED', 'REVOKED', 'UNKNOWN',
]);

export class OnboardingError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'OnboardingError';
    this.code = code;
    this.details = details;
  }
}

const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WINDOWS_DEVICE_NAME_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\\..*)?$/i;
const MAX_NOTE = 1_000;

function fail(code, message, details = {}) {
  throw new OnboardingError(code, message, details);
}

function ensureAbsolute(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0 || !path.isAbsolute(value)) {
    fail('ONBOARD_PATH_INVALID', `${field} must be an absolute path`, { field, message_zh: `${field} 必须是绝对路径` });
  }
  return path.resolve(value);
}

function inside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function realpathRoot(runtimeRoot) {
  let real;
  try { real = fs.realpathSync.native ? fs.realpathSync.native(runtimeRoot) : fs.realpathSync(runtimeRoot); }
  catch {
    fail('ONBOARD_RUNTIME_MISSING', `runtime root does not exist: ${runtimeRoot}`, {
      runtime_root: runtimeRoot, message_zh: '所选 runtime 不存在；未创建目录，未写入请求。',
    });
  }
  let stat;
  try { stat = fs.statSync(real); } catch { stat = null; }
  if (stat === null || !stat.isDirectory()) fail('ONBOARD_RUNTIME_INVALID', `runtime root is not a directory: ${runtimeRoot}`, { message_zh: '所选 runtime 不是目录。' });
  return real;
}

function isReparseOrSymlink(file) {
  try {
    const stat = fs.lstatSync(file);
    return stat.isSymbolicLink();
  } catch { return false; }
}

function ensureSafeDirectory(runtimeRoot, targetDir) {
  const rootReal = realpathRoot(runtimeRoot);
  const rootAbs = path.resolve(runtimeRoot);
  const targetAbs = path.resolve(targetDir);
  if (!inside(rootAbs, targetAbs)) fail('ONBOARD_PATH_OUTSIDE', `directory escapes runtime: ${targetDir}`, { message_zh: 'onboarding 目录越出 runtime，已拒绝。' });
  let current = rootAbs;
  const rel = path.relative(rootAbs, targetAbs);
  for (const part of rel.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.existsSync(current)) {
      if (isReparseOrSymlink(current)) fail('ONBOARD_PATH_REPARSE', `reparse point in onboarding path: ${current}`, { message_zh: 'onboarding 路径包含 reparse/junction；暂停，不跟随写入。' });
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory()) fail('ONBOARD_PATH_NOT_DIRECTORY', `not a directory: ${current}`, { message_zh: 'onboarding 路径不是目录。' });
    } else {
      fs.mkdirSync(current, { mode: 0o700 });
      if (isReparseOrSymlink(current)) fail('ONBOARD_PATH_REPARSE', `reparse point created in onboarding path: ${current}`, { message_zh: 'onboarding 路径出现 reparse；暂停。' });
    }
  }
  const targetReal = fs.realpathSync.native ? fs.realpathSync.native(targetAbs) : fs.realpathSync(targetAbs);
  if (!inside(rootReal, targetReal)) fail('ONBOARD_PATH_OUTSIDE', `realpath escapes runtime: ${targetDir}`, { message_zh: 'onboarding 目录 realpath 越出 runtime，已拒绝。' });
  return targetReal;
}

function safeReadPath(runtimeRoot, file) {
  const rootReal = realpathRoot(runtimeRoot);
  let real;
  try { real = fs.realpathSync.native ? fs.realpathSync.native(file) : fs.realpathSync(file); }
  catch { return false; }
  if (!inside(rootReal, real)) fail('ONBOARD_PATH_OUTSIDE', `read path realpath escapes runtime: ${file}`, { message_zh: '读取路径 realpath 越出 runtime，已拒绝。' });
  try {
    if (fs.lstatSync(file).isSymbolicLink()) fail('ONBOARD_PATH_REPARSE', `symlink read rejected: ${file}`, { message_zh: '读取路径是 symlink/junction，已暂停。' });
  } catch (error) {
    if (error instanceof OnboardingError) throw error;
  }
  return true;
}
function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch { /* best effort */ }
  }
}

export function onboardingPaths(runtimeRoot) {
  const root = path.resolve(runtimeRoot);
  return {
    root,
    onboardingDir: path.join(root, 'onboarding'),
    requestsDir: path.join(root, 'onboarding', 'requests'),
    requestFile: (requestId) => path.join(root, 'onboarding', 'requests', `${requestId}.json`),
    lockFile: (requestId) => path.join(root, 'onboarding', 'requests', `${requestId}.lock`),
  };
}

/**
 * Resolve one explicit runtime, a locator runtime, or the current default.
 * An explicit runtime is required for legacy/current Hubs without a locator.
 */
export function resolveOnboardingRuntime({ runtimeDir, installationRoot, env = process.env, homedir } = {}) {
  let explicitRuntime = null;
  if (runtimeDir !== undefined && runtimeDir !== null) explicitRuntime = ensureAbsolute(runtimeDir, 'runtimeDir');
  const explicitInstallation = installationRoot !== undefined && installationRoot !== null;
  const root = explicitInstallation ? ensureAbsolute(installationRoot, 'installationRoot') : defaultInstallationRoot({ env, ...(homedir === undefined ? {} : { homedir }) });
  const paths = installationPaths(root);
  let locator = null;
  // An explicit runtime alone means the caller selected a legacy/current Hub
  // runtime deliberately; do not let an unrelated default locator override it.
  if (explicitInstallation || explicitRuntime === null) {
    try {
      locator = readInstallation({ root, env, required: false });
    } catch (error) {
      throw new OnboardingError_From(error, 'ONBOARD_LOCATOR_INVALID');
    }
  }
  if (locator !== null) {
    const locatorRuntime = path.resolve(locator.runtime_root);
    if (explicitRuntime !== null && path.resolve(explicitRuntime) !== locatorRuntime) {
      fail('ONBOARD_RUNTIME_CONFLICT', 'explicit runtime conflicts with locator runtime_root', {
        explicit_runtime: explicitRuntime,
        locator_runtime: locatorRuntime,
        message_zh: '显式 runtime 与 locator 的 runtime_root 冲突；请只指定一个实例，不能混用。',
        next_steps: ['去掉 --runtime，或去掉 --installation', '重新运行 onboard discover 核对 runtime'],
      });
    }
    return {
      runtime_root: locatorRuntime,
      installation: locator,
      locator_path: paths.locator,
      resolution: explicitRuntime === null ? 'locator' : 'explicit+locator',
      explicit_runtime: explicitRuntime !== null,
    };
  }
  if (explicitRuntime !== null && !explicitInstallation) {
    return {
      runtime_root: explicitRuntime,
      installation: null,
      locator_path: paths.locator,
      resolution: 'explicit',
      explicit_runtime: true,
    };
  }
  if (explicitInstallation) {
    fail('ONBOARD_LOCATOR_MISSING', `installation locator missing: ${paths.locator}`, {
      installation_root: root,
      message_zh: '指定的 installation 没有 locator；请改用手动 --runtime 指向当前 Hub 数据根。',
      next_steps: ['onboard discover --runtime <current-hub-runtime>'],
    });
  }
  return {
    runtime_root: path.resolve(RUNTIME_DIR),
    installation: null,
    locator_path: paths.locator,
    resolution: 'default',
    explicit_runtime: false,
  };
}

function OnboardingError_From(error, code) {
  return new OnboardingError(code, String(error?.message ?? error), {
    cause: String(error?.message ?? error),
    message_zh: '无法读取 installation locator；请检查 --installation 路径或改用显式 --runtime。',
  });
}

function readArtifact(artifactPath) {
  if (artifactPath === undefined || artifactPath === null) return null;
  const absolute = ensureAbsolute(artifactPath, 'originArtifact');
  let content;
  try { content = fs.readFileSync(absolute); } catch (error) {
    fail('ONBOARD_ARTIFACT_INVALID', `cannot read origin artifact: ${absolute}`, {
      path: absolute,
      message_zh: '原 artifact 不可读；未创建请求。请确认路径后重试，不能伪造或丢弃请求来源。',
      next_steps: ['确认 outbox/artifact 路径仍存在', '重新运行 onboard request 并带 --origin-artifact'],
    });
  }
  return { path: absolute, sha256: sha256(content), bytes: content.length };
}

function pickGuidance(status) {
  const value = status?.guidance;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    code: typeof value.code === 'string' ? value.code : null,
    blocked_step: typeof value.blocked_step === 'string' ? value.blocked_step : null,
    message_zh: typeof value.message_zh === 'string' ? value.message_zh : null,
    next_steps: Array.isArray(value.next_steps) ? value.next_steps.slice(0, 8).map(String) : [],
    retry_policy: value.retry_policy === undefined ? null : value.retry_policy,
    evidence: value.evidence === undefined ? null : value.evidence,
  };
}

function receiverRecoveryGuidance(receiver) {
  const supplied = pickGuidance(receiver);
  if (supplied !== null) return supplied;
  const phase = receiver?.phase;
  const reason = `${receiver?.reasonCode ?? ''} ${receiver?.lastError ?? ''} ${receiver?.status ?? ''}`.toLowerCase();
  if (phase === 'rate-limited') {
    return {
      code: 'RECEIVER_RATE_LIMITED',
      blocked_step: 'receiver_rate_limit',
      message_zh: 'target receiver 处于 rate-limited；进程 ACTIVE 不等于立即可投递。按窗口/资格时间恢复，不自动续期或拉起。',
      next_steps: ['查看 receiver-status next_eligible_at/remaining quota', '等待限流窗口结束并人工确认', '不要重发/不要由 request 自动 enable'],
      retry_policy: 'MANUAL_RETRY_AFTER_RATE_LIMIT',
    };
  }
  if (phase === 'paused-uncertain' || reason.includes('uncertain')) {
    return {
      code: 'RECEIVER_PAUSED_UNCERTAIN',
      blocked_step: 'receiver_uncertain_review',
      message_zh: 'target receiver 处于 paused/uncertain；不能当作已投递或可立即投递，需人工核对 native 状态。',
      next_steps: ['先核对 native/queue 与 receiver 状态', '保留账本/配置，不重发', '人工确认后再 retry'],
      retry_policy: 'MANUAL_RETRY_AFTER_UNCERTAIN_REVIEW',
    };
  }
  if (phase === 'halted' || phase === 'disabled' || reason.includes('cli')) {
    return {
      code: 'RECEIVER_CLI_PAUSED',
      blocked_step: 'receiver_cli_paused',
      message_zh: 'target receiver 因 CLI/暂停状态停机；不能自动恢复或当作立即可投递。',
      next_steps: ['按 receiver 原工具 doctor/repair-cli 后人工 enable', '保留 bindings/window/ledger/rate/startup', '不要由 request 自动拉起'],
      retry_policy: 'MANUAL_RETRY_AFTER_CLI_RECOVERY',
    };
  }
  if (phase !== 'online-idle') {
    return {
      code: 'RECEIVER_NOT_DELIVERABLE',
      blocked_step: 'receiver_not_deliverable',
      message_zh: 'receiver 当前 phase 不是 online-idle；进程/worker 存在不等于立即可投递。',
      next_steps: ['检查 receiver-status phase/reason', '等待或按原工具恢复后人工 retry', '不要重发/不要自动 enable'],
      retry_policy: 'MANUAL_RETRY_AFTER_DELIVERABLE',
    };
  }
  return null;
}

function readHubConfig(runtimeRoot) {
  const paths = runtimePaths(runtimeRoot);
  if (fs.existsSync(paths.configFile) && !safeReadPath(runtimeRoot, paths.configFile)) return { ok: false, code: 'HUB_CONFIG_UNSAFE', path: paths.configFile };
  if (fs.existsSync(paths.tokenFile) && !safeReadPath(runtimeRoot, paths.tokenFile)) return { ok: false, code: 'HUB_TOKEN_UNSAFE', path: paths.tokenFile };
  const config = readJsonSafe(paths.configFile);
  if (config === null || typeof config !== 'object' || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    return { ok: false, code: 'HUB_CONFIG_MISSING', path: paths.configFile };
  }
  const host = config.host ?? '127.0.0.1';
  if (host !== '127.0.0.1') {
    return { ok: false, code: 'HUB_NON_LOOPBACK', host, configFile: paths.configFile };
  }
  let token;
  try { token = fs.readFileSync(paths.tokenFile, 'utf8').trim(); } catch { token = ''; }
  if (token.length < 32) return { ok: false, code: 'HUB_TOKEN_MISSING', path: paths.tokenFile };
  return { ok: true, config, token, configFile: paths.configFile };
}

function targetObservation(targets, identity) {
  const matches = targets.filter((target) => target.identity === identity);
  if (matches.length === 0) return { state: 'ABSENT', enabled: false };
  return {
    state: matches.some((target) => target.enabled === true) ? 'PAIRED' : 'PRESENT_DISABLED',
    enabled: matches.some((target) => target.enabled === true),
    labels: matches.map((target) => target.label ?? '').filter(Boolean),
  };
}

function receiverObservation(receivers, target, targetRole) {
  if (targetRole !== 'codex') return null;
  const threadId = target.slice('codex:'.length);
  const receiver = receivers.find((item) => item.threadId === threadId);
  if (receiver === undefined) return { state: 'ABSENT', thread_id: threadId, guidance: null };
  const identityVerified = receiver.health === 'IDENTITY_VERIFIED';
  const processActive = identityVerified && receiver.active === true;
  const deliverableNow = processActive && receiver.ready === true && receiver.phase === 'online-idle'
    && (receiver.reasonCode === undefined || receiver.reasonCode === null);
  const legacy = !(Number.isInteger(receiver.schemaVersion) && receiver.schemaVersion >= 3);
  const guidance = deliverableNow ? pickGuidance(receiver) : receiverRecoveryGuidance(receiver);
  return {
    state: deliverableNow ? 'ACTIVE' : processActive ? 'ACTIVE_NOT_DELIVERABLE' : legacy ? 'LEGACY_UNVERIFIED' : 'UNVERIFIED',
    active: identityVerified ? processActive : null,
    process_active: identityVerified ? processActive : null,
    deliverable_now: identityVerified ? deliverableNow : null,
    reported_online_idle: receiver.status === 'ONLINE_IDLE',
    reported: {
      status: receiver.status ?? null,
      phase: receiver.phase ?? null,
      reported_active: typeof receiver.reportedActive === 'boolean' ? receiver.reportedActive : null,
      reported_ready: typeof receiver.reportedReady === 'boolean' ? receiver.reportedReady : null,
      heartbeat_at: receiver.heartbeatAt ?? null,
      heartbeat_fresh: typeof receiver.heartbeatFresh === 'boolean' ? receiver.heartbeatFresh : null,
    },
    verified_process: {
      state: identityVerified ? (deliverableNow ? 'VERIFIED_READY' : 'VERIFIED_NOT_READY') : 'UNVERIFIED',
      active: identityVerified ? processActive : null,
      ready: identityVerified ? deliverableNow : null,
      health: receiver.health ?? 'UNVERIFIED',
      readiness: receiver.readiness ?? 'UNVERIFIED',
    },
    phase: receiver.phase ?? null,
    reason_code: receiver.reasonCode ?? receiver.lastError ?? null,
    thread_id: threadId,
    status: receiver.status ?? null,
    schema_version: receiver.schemaVersion ?? null,
    health: receiver.health ?? 'UNVERIFIED',
    readiness: receiver.readiness ?? 'UNVERIFIED',
    identity_verdict: receiver.identityVerdict ?? 'UNVERIFIED',
    evidence_grade: processActive ? 'V3_ASYNC_IDENTITY_VERIFIED' : legacy ? 'LEGACY_V2_NO_V3_IDENTITY' : 'V3_IDENTITY_UNVERIFIED',
    guidance,
  };
}

function membershipObservation(memberships, target) {
  const membership = memberships.find((item) => item.target === target);
  if (membership === undefined) return { state: 'ABSENT' };
  return {
    state: membership.desired_state,
    owner_opt_in: membership.owner_opt_in === true,
    enabled: membership.enabled === true,
    receiver_kind: membership.receiver_kind,
    binding_epoch: membership.binding_epoch,
    config_path: membership.config_path,
    evidence_grade: 'MEMBERSHIP_FILE_OBSERVED',
  };
}

function targetConfigObservation(runtimeRoot, target, source) {
  const role = identityRole(target);
  if (role !== 'codex') return { state: 'ABSENT', reason: 'TARGET_NOT_CODEX' };
  const threadId = target.slice('codex:'.length);
  const codexRoot = path.join(runtimeRoot, 'codex');
  if (fs.existsSync(codexRoot) && !safeReadPath(runtimeRoot, codexRoot)) return { state: 'INVALID', reason: 'CODEX_ROOT_REPARSE' };
  const matches = [];
  let entries = [];
  try { entries = fs.readdirSync(codexRoot, { withFileTypes: true }); } catch { entries = []; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const configPath = path.join(codexRoot, entry.name, 'receiver-config.json');
    if (!fs.existsSync(configPath)) continue;
    let config;
    try {
      if (!safeReadPath(runtimeRoot, configPath)) continue;
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch { continue; }
    if (config?.thread_id === threadId) matches.push({ config, configPath });
  }
  if (matches.length === 0) return { state: 'ABSENT', reason: 'CONFIG_ABSENT' };
  if (matches.length > 1) return { state: 'AMBIGUOUS', count: matches.length, evidence_grade: 'REVIEW_REQUIRED' };
  const { config, configPath } = matches[0];
  let runtimeDirSafe = false;
  if (typeof config.runtime_dir === 'string' && path.isAbsolute(config.runtime_dir) && inside(runtimeRoot, config.runtime_dir)) {
    try { runtimeDirSafe = safeReadPath(runtimeRoot, config.runtime_dir); } catch { runtimeDirSafe = false; }
  }
  const configuredHubRoot = typeof config.hub_runtime_root === 'string' && path.isAbsolute(config.hub_runtime_root)
    ? path.resolve(config.hub_runtime_root) : null;
  const inferredHubRoot = path.resolve(config.runtime_dir ?? '', '..', '..');
  const hubRoot = configuredHubRoot ?? inferredHubRoot;
  const hubRootMatches = runtimeDirSafe && path.resolve(runtimeRoot) === hubRoot;
  const ownerOptInPresent = Object.hasOwn(config, 'owner_opt_in') && typeof config.owner_opt_in === 'boolean';
  const ownerOptIn = ownerOptInPresent ? config.owner_opt_in : null;
  const runtimeModePresent = typeof config.runtime_mode === 'string' || typeof config.runtimeMode === 'string';
  const runtimeMode = typeof config.runtime_mode === 'string'
    ? config.runtime_mode
    : typeof config.runtimeMode === 'string' ? config.runtimeMode : null;
  const metadataUnsupported = !ownerOptInPresent || !runtimeModePresent;
  const enabledPresent = Object.hasOwn(config, 'enabled') && typeof config.enabled === 'boolean';
  const enabled = enabledPresent ? config.enabled : null;
  const allowedSendersPresent = Array.isArray(config.allowed_senders);
  const allowedSenders = allowedSendersPresent
    ? config.allowed_senders.filter((value) => typeof value === 'string').slice(0, 200)
    : null;
  const sourceAllowedByTarget = allowedSendersPresent && typeof source === 'string'
    ? allowedSenders.includes(source) : null;
  const evidenceGrade = ownerOptIn === true && hubRootMatches
    ? 'MANUAL_LEGACY_HUB_CONFIG_OWNER_OPT_IN'
    : ownerOptIn === true ? 'CONFIG_OWNER_OPT_IN_HUB_ROOT_UNVERIFIED'
      : metadataUnsupported ? 'LEGACY_UNMARKED_CONFIG_METADATA_UNSUPPORTED'
        : 'ORIGINAL_TOOL_CONFIG_OBSERVED';
  return {
    state: runtimeDirSafe ? 'PRESENT' : 'INVALID_RUNTIME',
    path: configPath,
    runtime_dir: typeof config.runtime_dir === 'string' ? config.runtime_dir : null,
    hub_runtime_root: configuredHubRoot,
    hub_root_matches: hubRootMatches,
    hub_root_evidence: configuredHubRoot === null ? 'INFERRED_FROM_RUNTIME_DIR' : 'CONFIG_DECLARED',
    owner_opt_in: ownerOptIn,
    owner_opt_in_present: ownerOptInPresent,
    owner_opt_in_supported: ownerOptInPresent,
    owner_opt_in_source: ownerOptInPresent ? 'EXPLICIT' : 'MISSING_OR_INVALID',
    runtime_mode: runtimeMode,
    runtime_mode_present: runtimeModePresent,
    metadata_support: metadataUnsupported ? 'UNSUPPORTED_LEGACY_FIELDS' : 'SUPPORTED',
    metadata_unsupported: metadataUnsupported,
    legacy_format_unmarked: metadataUnsupported && ownerOptIn === null,
    enabled,
    enabled_present: enabledPresent,
    allowed_senders_present: allowedSendersPresent,
    allowed_senders: allowedSenders,
    source_allowed_by_target: sourceAllowedByTarget,
    installation_id: config.installation_id ?? null,
    instance_id: config.instance_id ?? null,
    binding_epoch: config.binding_epoch ?? null,
    receiver_kind: config.mode === 'daily' ? 'daily' : (config.mode === 'bounded' ? 'bounded' : config.mode ?? null),
    evidence_grade: evidenceGrade,
    note_zh: metadataUnsupported
      ? '旧/未标记 config 缺少 owner_opt_in 或 runtime_mode；owner_opt_in 为 null（不是 false），enabled 缺失也为 null；只读观察，不自动 enable/改配置。'
      : ownerOptIn === true
        ? 'config 的 owner_opt_in 观察；不是新建 companion membership，也不自动 enable。'
        : 'config 明确 owner_opt_in=false；保留等待，不自动放行。',
  };
}


function readModelReceipt({ runtimeRoot, target, messageId, now }) {
  if (typeof messageId !== 'string' || messageId.length === 0) {
    return {
      status: 'UNKNOWN', code: 'NO_MESSAGE_ID', received_confirmed: false,
      model_status: 'UNKNOWN', native_correlation: 'UNVERIFIED', rollout_correlation: 'UNVERIFIED',
      message_zh: '未提供 message_id；无法关联已有 model-receipt，不能声称模型收信。',
    };
  }
  const role = identityRole(target);
  if (role !== 'codex') {
    return { status: 'UNKNOWN', code: 'TARGET_NOT_CODEX', received_confirmed: false, model_status: 'UNKNOWN', native_correlation: 'UNVERIFIED', rollout_correlation: 'UNVERIFIED' };
  }
  const threadId = target.slice('codex:'.length);
  const codexRoot = path.join(runtimeRoot, 'codex');
  if (fs.existsSync(codexRoot) && !safeReadPath(runtimeRoot, codexRoot)) return { status: 'INVALID', code: 'MODEL_RECEIPT_CODEX_ROOT_REPARSE', received_confirmed: false, model_status: 'UNKNOWN', native_correlation: 'UNVERIFIED', rollout_correlation: 'UNVERIFIED', message_zh: 'codex 路径包含 reparse；暂停，不读取回执。' };
  const configs = [];
  try {
    for (const entry of fs.readdirSync(codexRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const configPath = path.join(codexRoot, entry.name, 'receiver-config.json');
      if (fs.existsSync(configPath) && !safeReadPath(runtimeRoot, configPath)) continue;
      const config = readJsonSafe(configPath);
      if (config?.thread_id === threadId) configs.push({ config, configPath });
    }
  } catch { /* no receiver configs */ }
  if (configs.length === 0) {
    return { status: 'UNKNOWN', code: 'MODEL_RECEIPT_CONFIG_ABSENT', received_confirmed: false, model_status: 'UNKNOWN', native_correlation: 'UNVERIFIED', rollout_correlation: 'UNVERIFIED', message_zh: '没有找到该 target 的既有 receiver 配置；不能推断模型收信。' };
  }
  if (configs.length > 1) {
    return { status: 'UNKNOWN', code: 'MODEL_RECEIPT_AMBIGUOUS_CONFIG', received_confirmed: false, model_status: 'UNKNOWN', native_correlation: 'UNVERIFIED', rollout_correlation: 'UNVERIFIED', message_zh: '同一 target 存在多个 receiver 配置；暂停，不猜测收信状态。' };
  }
  const { config, configPath } = configs[0];
  if (typeof config.runtime_dir !== 'string' || !path.isAbsolute(config.runtime_dir) || !inside(runtimeRoot, config.runtime_dir) || !safeReadPath(runtimeRoot, config.runtime_dir) || !safeReadPath(runtimeRoot, configPath)) {
    return { status: 'INVALID', code: 'MODEL_RECEIPT_RUNTIME_OUTSIDE', received_confirmed: false, model_status: 'UNKNOWN', native_correlation: 'UNVERIFIED', rollout_correlation: 'UNVERIFIED', message_zh: 'receiver runtime_dir 不在所选 runtime 内；暂停，不读取任意外部路径。' };
  }
  const key = sha256(Buffer.from(messageId));
  const receiptFile = path.join(config.runtime_dir, `${key}.model-receipt.json`);
  if (fs.existsSync(receiptFile) && !safeReadPath(runtimeRoot, receiptFile)) {
    return { status: 'INVALID', code: 'MODEL_RECEIPT_UNSAFE_PATH', received_confirmed: false, model_status: 'UNKNOWN', native_correlation: 'UNVERIFIED', rollout_correlation: 'UNVERIFIED', message_zh: 'model-receipt 路径是 symlink/reparse 或越根；暂停。' };
  }
  const receipt = readJsonSafe(receiptFile);
  if (receipt === undefined) {
    return { status: 'UNKNOWN', code: 'MODEL_RECEIPT_ABSENT', received_confirmed: false, model_status: 'UNKNOWN', native_correlation: 'UNVERIFIED', rollout_correlation: 'UNVERIFIED', message_zh: '尚无该 message_id 的 model-receipt；pair 或 ONLINE_IDLE 不等于模型收信。' };
  }
  if (receipt.msg_id !== messageId || receipt.thread_id !== threadId) {
    return { status: 'INVALID', code: 'MODEL_RECEIPT_IDENTITY_MISMATCH', received_confirmed: false, model_status: 'UNKNOWN', native_correlation: 'UNVERIFIED', rollout_correlation: 'UNVERIFIED', message_zh: 'model-receipt 的 message/thread 与请求不一致；暂停。' };
  }
  const reported = receipt.status === 'MODEL_RECEIVED' || receipt.status === 'MODEL_REPORTED';
  return {
    status: reported ? 'MODEL_REPORTED' : 'UNVERIFIED',
    code: reported ? 'MODEL_REPORTED' : `MODEL_RECEIPT_STATUS_${String(receipt.status ?? 'UNKNOWN')}`,
    received_confirmed: false,
    model_status: reported ? 'MODEL_REPORTED' : 'UNVERIFIED',
    native_correlation: 'UNVERIFIED',
    rollout_correlation: 'UNVERIFIED',
    evidence_grade: receipt.evidence_grade ?? null,
    native_queue_id: receipt.native_queue_id ?? null,
    receiving_turn_id: receipt.receiving_turn_id ?? null,
    file: receiptFile,
    message_zh: reported
      ? '存在 MODEL_REPORTED 的 model-receipt；仍需 native/rollout 关联，不能把 pair/ONLINE_IDLE 或该文件单独当作完整送达。'
      : 'model-receipt 存在但状态不是 MODEL_REPORTED；不能声称模型收信。',
    observed_at: new Date(now).toISOString(),
  };
}

/** Read-only discovery of the current Hub and local receiver state. */
export async function discoverOnboarding({ runtimeRoot, installation, locatorPath, resolution, processProvider, timeoutMs = 2_000, now = Date.now() } = {}) {
  const resolved = installation === undefined || installation === null
    ? resolveOnboardingRuntime({ runtimeDir: runtimeRoot })
    : { runtime_root: path.resolve(runtimeRoot), installation, locator_path: locatorPath ?? null, resolution: resolution ?? 'locator', explicit_runtime: false };
  const root = resolved.runtime_root;
  const hubRead = readHubConfig(root);
  let hub = { reachable: false, code: hubRead.ok ? 'HUB_UNREACHABLE' : hubRead.code, config_file: hubRead.configFile ?? null };
  let targets = [];
  let roles = [];
  if (hubRead.ok) {
    const client = new HubClient({
      host: hubRead.config.host ?? '127.0.0.1',
      port: hubRead.config.port,
      token: hubRead.token,
      role: 'cli',
      identity: 'cli:operator',
    });
    try {
      await client.connect({ timeoutMs });
      const welcome = client.welcomeInfo;
      targets = await client.targets();
      roles = await client.roles();
      const expected = resolved.installation;
      const compatible = expected === null || (
        welcome?.installation_id === expected.installation_id &&
        welcome?.instance_id === expected.instance_id
      );
      hub = {
        reachable: true,
        compatible,
        code: compatible ? 'HUB_READY' : 'HUB_INSTANCE_MISMATCH',
        welcome: welcome === null ? null : {
          protocol_version: welcome?.protocol_version ?? null,
          installation_id: welcome?.installation_id ?? null,
          instance_id: welcome?.instance_id ?? null,
          capabilities: welcome?.capabilities ?? {},
        },
        expected_installation: expected === null ? null : {
          installation_id: expected.installation_id,
          instance_id: expected.instance_id,
        },
        targets_count: targets.length,
        roles,
      };
    } catch (error) {
      hub = { reachable: false, code: error?.code ?? 'HUB_UNREACHABLE', message: String(error?.message ?? error) };
    } finally {
      await client.close();
    }
  }
  let receivers = { root: path.join(root, 'codex'), receivers: [] };
  try {
    receivers = await readReceiverStatusesAsync({ runtimeDir: root, now, processProvider });
  } catch {
    receivers = { root: path.join(root, 'codex'), receivers: [] };
  }
  const memberships = listMemberships(root);
  return {
    schema_version: ONBOARDING_SCHEMA_VERSION,
    read_only: true,
    runtime_root: root,
    resolution: resolved.resolution,
    installation: resolved.installation === null ? null : {
      installation_id: resolved.installation.installation_id,
      instance_id: resolved.installation.instance_id,
      active_version: resolved.installation.active_version,
      runtime_root: resolved.installation.runtime_root,
      hub_owner_kind: resolved.installation.hub_owner_kind,
    },
    locator_path: resolved.locator_path,
    observed_at: new Date(now).toISOString(),
    hub,
    targets,
    roles,
    receivers: receivers.receivers,
    memberships: { memberships: memberships.memberships, invalid: memberships.invalid },
  };
}

function knownRequestGeneration(request) {
  const generation = request?.generation;
  const installationId = generation?.installation_id ?? request?.installation_id ?? null;
  const instanceId = generation?.instance_id ?? request?.instance_id ?? null;
  const known = typeof installationId === 'string' && installationId.length > 0
    && typeof instanceId === 'string' && instanceId.length > 0;
  return {
    known,
    installation_id: known ? installationId : null,
    instance_id: known ? instanceId : null,
    source: generation?.source ?? (known ? 'REQUEST_TOP_LEVEL_IDS' : 'LEGACY_UNVERIFIED'),
  };
}

function trustedGeneration({ installation, discovery, now = Date.now() }) {
  const locatorKnown = typeof installation?.installation_id === 'string' && installation.installation_id.length > 0
    && typeof installation?.instance_id === 'string' && installation.instance_id.length > 0;
  const welcome = discovery?.hub?.welcome;
  const welcomeKnown = typeof welcome?.installation_id === 'string' && welcome.installation_id.length > 0
    && typeof welcome?.instance_id === 'string' && welcome.instance_id.length > 0;
  if (locatorKnown) {
    return {
      installation_id: installation.installation_id,
      instance_id: installation.instance_id,
      source: welcomeKnown ? 'LOCATOR_AND_WELCOME' : 'LOCATOR_CONTEXT',
      captured_at: new Date(now).toISOString(),
    };
  }
  if (welcomeKnown) {
    return {
      installation_id: welcome.installation_id,
      instance_id: welcome.instance_id,
      source: 'HUB_WELCOME',
      captured_at: new Date(now).toISOString(),
    };
  }
  return {
    installation_id: null,
    instance_id: null,
    source: 'LEGACY_UNVERIFIED',
    captured_at: new Date(now).toISOString(),
  };
}

/**
 * Compare the request's first trusted generation tuple with the selected
 * locator context and the actual Hub welcome. A known tuple is never replaced
 * by a newer Hub instance. Missing legacy IDs stay unverified; they are not
 * invented from a later welcome.
 */
function generationCheck({ request, hubWelcome, locatorInstallation }) {
  const expected = knownRequestGeneration(request);
  if (!expected.known) {
    return { state: 'LEGACY_UNVERIFIED', expected, hub: hubWelcome ?? null, locator: locatorInstallation ?? null };
  }
  const hubKnown = typeof hubWelcome?.installation_id === 'string' && hubWelcome.installation_id.length > 0
    && typeof hubWelcome?.instance_id === 'string' && hubWelcome.instance_id.length > 0;
  const locatorKnown = typeof locatorInstallation?.installation_id === 'string' && locatorInstallation.installation_id.length > 0
    && typeof locatorInstallation?.instance_id === 'string' && locatorInstallation.instance_id.length > 0;
  if (locatorKnown && (locatorInstallation.installation_id !== expected.installation_id || locatorInstallation.instance_id !== expected.instance_id)) {
    return {
      state: 'DRIFT', expected,
      hub: hubWelcome ?? null, locator: locatorInstallation,
      code: 'ONBOARD_INSTANCE_DRIFT', blocked_step: 'verify_generation',
      message_zh: 'request 保存的 installation/instance 与所选 locator 不一致；不覆盖成新实例。',
    };
  }
  if (hubKnown && (hubWelcome.installation_id !== expected.installation_id || hubWelcome.instance_id !== expected.instance_id)) {
    return {
      state: 'DRIFT', expected,
      hub: hubWelcome, locator: locatorInstallation ?? null,
      code: 'ONBOARD_INSTANCE_DRIFT', blocked_step: 'verify_generation',
      message_zh: 'request 保存的 installation/instance 与实际 Hub welcome 不一致；BLOCKED，不覆盖成新实例。',
    };
  }
  if (!hubKnown) {
    return {
      state: 'UNVERIFIED', expected,
      hub: hubWelcome ?? null, locator: locatorInstallation ?? null,
      code: 'ONBOARD_LEGACY_HUB_NO_IDS', blocked_step: 'verify_generation',
      message_zh: 'request 有既有 generation tuple，但当前 Hub welcome 没有 IDs；保持 legacy unverified，不编造、不覆盖。',
    };
  }
  return { state: 'MATCH', expected, hub: hubWelcome, locator: locatorInstallation ?? null };
}

function annotateOnboardingError(error, { requestId = null, operation = null, blockedStep = null, persisted = false } = {}) {
  if (error instanceof OnboardingError) {
    error.details = {
      ...(error.details ?? {}),
      ...(requestId === null ? {} : { request_id: requestId }),
      ...(operation === null ? {} : { operation: error.details?.operation ?? operation }),
      ...(blockedStep === null ? {} : { blocked_step: error.details?.blocked_step ?? blockedStep }),
      persisted: error.details?.persisted ?? persisted,
      ...(requestId === null ? {} : { retryable_same_request_id: error.details?.retryable_same_request_id ?? true }),
      ...(error.details?.message_zh === undefined ? { message_zh: 'request 持久化/锁/路径操作失败；未声称已持久，可用同一 request_id 查询或重试。' } : {}),
    };
    return error;
  }
  return new OnboardingError(error?.code ?? 'ONBOARD_IO_ERROR', String(error?.message ?? error), {
    request_id: requestId,
    operation,
    blocked_step: blockedStep,
    persisted,
    cause_code: error?.code ?? null,
    retryable_same_request_id: requestId !== null,
    message_zh: 'request 持久化/锁/路径操作失败；未声称已持久，可用同一 request_id 查询或重试。',
  });
}
function stateAndGuidance({ discovery, sourcePaired, targetPaired, membership, receiver, targetConfig, userAuthorized }) {
  if (userAuthorized !== true) {
    return {
      state: 'WAITING_OWNER_CONSENT',
      guidance: {
        code: 'REQUEST_WAITING_OWNER_CONSENT',
        blocked_step: 'explicit_owner_consent',
        message_zh: '请求已持久登记，但还没有调用方声明的用户/owner 授权引用；不会自动 pair、enable 或发送。',
        next_steps: [
          '由用户确认 source/target 后，重新运行 onboard retry <request_id> --user-authorized（这是调用方声明/授权引用，不是 PCA 认证）',
          '人工完成 pair / owner opt-in / receiver enable；retry 只观察，不重发',
          '撤销请求不会删除共用 source pairing，也不会关闭其他 target',
        ],
        retry_policy: 'MANUAL_RETRY_AFTER_OWNER_CONSENT',
        evidence: { hub_reachable: discovery.hub.reachable, source_paired: sourcePaired, target_paired: targetPaired },
      },
    };
  }
  if (discovery.hub.compatible === false) {
    return {
      state: 'BLOCKED',
      guidance: {
        code: 'HUB_INSTANCE_MISMATCH',
        blocked_step: 'verify_runtime_to_hub',
        message_zh: '当前 runtime 的 locator/installation 与所连 Hub 的 welcome installation/instance 不一致；不把 A runtime 数据指向 B Hub 当作成功。',
        next_steps: [
          '核对 --runtime / --installation 与当前 Hub 是否同一 installation/instance',
          '使用正确的显式 runtime 重新 discover',
          '不写 token、不启动第二个 Hub',
        ],
        retry_policy: 'MANUAL_AFTER_RUNTIME_HUB_MATCH',
        evidence: {
          expected_installation: discovery.hub.expected_installation,
          welcome: discovery.hub.welcome,
        },
      },
    };
  }
  if (discovery.hub.reachable !== true) {
    return {
      state: 'UNKNOWN',
      guidance: {
        code: 'HUB_DISCOVERY_UNAVAILABLE',
        blocked_step: 'discover_current_hub',
        message_zh: '当前 Hub 不可达或旧 Hub 不支持本次只读查询；请求可以本地持久登记，但不能自动配对或声称收信。',
        next_steps: [
          `显式 runtime：${discovery.runtime_root}`,
          '确认 Hub/config/token 后运行 onboard discover --runtime <runtime>',
          '配对和 owner enable 仍由人工显式完成；不要启动第二个 Hub',
        ],
        retry_policy: 'MANUAL_RETRY_AFTER_HUB_READY',
        evidence: { hub_code: discovery.hub.code ?? null },
      },
    };
  }
  if (!sourcePaired || !targetPaired) {
    return {
      state: 'WAITING_PAIR',
      guidance: {
        code: 'REQUEST_WAITING_PAIR',
        blocked_step: 'explicit_pair',
        message_zh: '请求已持久登记，但 source/target 尚未在 Hub 配对；不会自动添加未知 source。',
        next_steps: [
          `人工确认后运行：node bin/lab-bridge.mjs pair add ${discovery.source_identity_hint ?? '<source>'}`,
          '再配对精确 target；随后 onboard retry <request_id>',
          '不改 token、不启动第二 Hub',
        ],
        retry_policy: 'MANUAL_RETRY_AFTER_PAIR',
        evidence: { source_paired: sourcePaired, target_paired: targetPaired },
      },
    };
  }
  if (targetConfig?.state === 'PRESENT' && targetConfig.source_allowed_by_target !== true) {
    return {
      state: 'WAITING_TARGET_ALLOWLIST',
      guidance: {
        code: 'REQUEST_WAITING_TARGET_ALLOWLIST',
        blocked_step: 'target_allowlist_review',
        message_zh: targetConfig.allowed_senders_present
          ? 'target config 存在，但本 request 的 source 不在 allowed_senders 内；不能 READY，也不会自动修改配置。'
          : 'target config 缺少 allowed_senders；不能 READY，也不会自动修改配置。',
        next_steps: [
          `由目标 owner 用原工具把 ${targetConfig.source_allowed_by_target === false ? '本 source' : '本 source'} 加入完整 allowed_senders 集合`,
          '保留原有其他已授权 source，不得覆盖或删除',
          '更新后人工确认 config，再运行 onboard retry <request_id>',
          '本命令只读观察；不写 receiver config、不自动 enable',
        ],
        retry_policy: 'MANUAL_RETRY_AFTER_TARGET_ALLOWLIST',
        evidence: {
          source_allowed_by_target: targetConfig.source_allowed_by_target,
          allowed_senders_present: targetConfig.allowed_senders_present,
          allowed_senders: targetConfig.allowed_senders,
          target_config: targetConfig,
        },
      },
    };
  }
  const configPresent = targetConfig?.state === 'PRESENT';
  const legacyMetadataUnsupported = configPresent && targetConfig.metadata_unsupported === true && targetConfig.owner_opt_in === null;
  const legacyObserved = legacyMetadataUnsupported
    && targetConfig.enabled === true
    && targetConfig.source_allowed_by_target === true;
  if (legacyObserved) {
    return {
      state: 'OBSERVED_LEGACY_UNVERIFIED',
      guidance: {
        code: 'REQUEST_LEGACY_OBSERVED_UNVERIFIED',
        blocked_step: 'legacy_owner_evidence',
        message_zh: '旧未标记 config 缺少 owner_opt_in/runtime_mode；owner_opt_in 为 null（不是 false）。原工具 enabled=true 且 allowed_senders 含本 source，用户授权已记录；不重复 enable、不改配置/重启，也不回 PCA 审批。',
        next_steps: [
          '只读原 receiver 工具 status/doctor，核对目标原线程是否仍 healthy',
          '检查已有 native/model receipt；有真实业务回合时由 target 原线程按实际 turn 记录 manual receipt',
          '可用 onboard receipt <request_id> --message-id <真实id> --turn-id <真实UUID> --runtime $rt；不要伪造 env/turn',
          '仅运行 onboard retry 更新本条 request 的观察/history；不重复 enable、不重配、不重启',
        ],
        retry_policy: 'OBSERVE_ONLY_NO_REENABLE',
        evidence: {
          request_user_authorized: true,
          target_config: targetConfig,
          config_owner_opt_in: targetConfig.owner_opt_in,
          config_enabled: targetConfig.enabled,
          source_allowed_by_target: targetConfig.source_allowed_by_target,
          receiver,
        },
      },
    };
  }
  if (legacyMetadataUnsupported) {
    return {
      state: 'LEGACY_METADATA_UNSUPPORTED',
      guidance: {
        code: 'REQUEST_LEGACY_METADATA_UNSUPPORTED',
        blocked_step: 'legacy_owner_evidence',
        message_zh: '旧 config 缺少 owner_opt_in/runtime_mode（owner_opt_in=null，不是 false；enabled 缺失也不等于已停止）。不能确认已启用，也不能据此重复 enable。',
        next_steps: [
          '只读原 receiver 工具 status/doctor，核对实际 enabled/健康状态',
          '若原工具确认已启用且 allowed_senders 含本 source，保留原状态；不要重配/重启',
          '不要由 request 自动 enable；确认后 onboard retry 更新观察/history',
          '不伪造 CODEX_THREAD_ID/turn，不把旧 v2 状态当 v3 已验证',
        ],
        retry_policy: 'OBSERVE_ONLY_NO_REENABLE',
        evidence: {
          target_config: targetConfig,
          config_owner_opt_in: targetConfig.owner_opt_in,
          config_enabled: targetConfig.enabled,
          metadata_support: targetConfig.metadata_support,
          receiver,
        },
      },
    };
  }
  const membershipPresent = membership !== null && membership.state !== 'ABSENT';
  const membershipOptIn = membershipPresent && membership.owner_opt_in === true;
  const membershipEnabled = membershipPresent && membership.state === 'ENABLED' && membership.enabled === true;
  const configConsent = targetConfig?.state === 'PRESENT'
    && targetConfig.owner_opt_in === true
    && targetConfig.hub_root_matches === true;
  const configEnabled = targetConfig?.state === 'PRESENT' && targetConfig.enabled === true;
  const consentPresent = membershipOptIn || configConsent;
  const enabledNow = membershipEnabled || configEnabled;
  const disabledObserved = (membershipPresent && (membership.state !== 'ENABLED' || membership.enabled !== true))
    || (targetConfig?.state === 'PRESENT' && targetConfig.owner_opt_in === true && targetConfig.enabled === false);
  const enabledUnknown = targetConfig?.state === 'PRESENT' && targetConfig.enabled === null;
  if (!consentPresent) {
    const legacyObserved = targetConfig?.state === 'PRESENT';
    const hubRootMismatch = legacyObserved && targetConfig.owner_opt_in === true && targetConfig.hub_root_matches !== true;
    return {
      state: 'WAITING_OWNER_OPT_IN',
      guidance: {
        code: hubRootMismatch ? 'REQUEST_LEGACY_CONFIG_HUB_ROOT_REVIEW' : legacyObserved ? 'REQUEST_LEGACY_CONFIG_OWNER_OPT_IN_REQUIRED' : 'REQUEST_WAITING_OWNER_OPT_IN',
        blocked_step: 'target_owner_opt_in',
        message_zh: legacyObserved
          ? '观察到 target 旧 config，但 owner_opt_in/Hub 根尚未被确认为当前 MANUAL_LEGACY_HUB；不要求也不伪造 companion membership。'
          : 'target 尚未由目标 owner 明确 opt-in；没有 companion membership 不是自动失败，但请求不等于 enable。',
        next_steps: [
          '由目标 owner 用原 receiver 工具/当前 manual mode 明确 enable（保留 binding/window/ledger/rate/startup）',
          legacyObserved ? '核对该 config 的 runtime_dir/hub_runtime_root 确属当前 Hub' : '确认精确 target thread 与 Hub runtime 后重试',
          '保留 request_id；完成后 onboard retry <request_id>',
          '不创建 companion membership、不伪造 CODEX_THREAD_ID、不把 ONLINE_IDLE 当收信',
        ],
        retry_policy: 'MANUAL_RETRY_AFTER_OWNER_OPT_IN',
        evidence: {
          membership: membership ?? { state: 'ABSENT' },
          target_config: targetConfig ?? null,
          source_allowed_by_target: targetConfig?.source_allowed_by_target ?? null,
          legacy_observation: legacyObserved,
        },
      },
    };
  }
  if (!enabledNow || disabledObserved) {
    return {
      state: 'WAITING_OWNER_ENABLE',
      guidance: {
        code: 'REQUEST_WAITING_OWNER_ENABLE',
        blocked_step: 'target_owner_enable',
        message_zh: enabledUnknown
          ? '已保留 owner consent/opt-in 证据，但 config 没有可确认的 enabled 字段；不能确认已停止或已启用，旧 status ACTIVE 也不能 READY。'
          : '已保留 owner consent/opt-in 证据，但 target 当前 enabled/desired_state 不是启用；旧 status 仍 ACTIVE 也不能 READY，request 不会自动拉起。',
        next_steps: [
          '由目标 owner 用原 receiver 工具/当前 manual mode 显式恢复 enable',
          '先读实际 state、保留 config/锁/账本/窗口/rate/startup',
          '不要因旧 status ACTIVE 就当成可投递；不要由 request 自动启动',
          '恢复后人工确认，再运行 onboard retry <request_id>',
        ],
        retry_policy: 'MANUAL_RETRY_AFTER_OWNER_ENABLE',
        evidence: {
          membership: membership ?? { state: 'ABSENT' },
          target_config: targetConfig ?? null,
          consent_present: true,
          enabled_now: enabledNow,
          enabled_unknown: enabledUnknown,
          disabled_observed: disabledObserved,
        },
      },
    };
  }
  if (receiver !== null && receiver.state !== 'ACTIVE') {
    const legacy = receiver.evidence_grade === 'LEGACY_V2_NO_V3_IDENTITY';
    const recovery = receiver.guidance;
    return {
      state: 'WAITING_TARGET',
      guidance: {
        code: recovery?.code ?? (legacy ? 'REQUEST_WAITING_TARGET_LEGACY_STATUS_UNVERIFIED' : 'REQUEST_WAITING_TARGET'),
        blocked_step: recovery?.blocked_step ?? 'target_receiver',
        message_zh: recovery?.message_zh ?? (legacy
          ? '目标 config/owner opt-in 已观察，但 receiver 只有 legacy/v2 状态；不能冒称新身份验证健康，也不能声称模型收信。'
          : '目标 owner/config 已 opt-in，但 receiver 当前不是经 v3 async identity 验证且可立即投递的 ACTIVE。'),
        next_steps: recovery?.next_steps?.length
          ? recovery.next_steps
          : [
            '检查 receiver-status / 目标线程是否在线',
            '旧 v2 状态需原工具 doctor/repair/enable 或核对新 manual mode；不要伪造身份',
            'pair/ONLINE_IDLE 不等于模型收信',
          ],
        retry_policy: recovery?.retry_policy ?? 'MANUAL_RETRY_AFTER_VERIFIED_RECEIVER',
        evidence: {
          receiver,
          receiver_guidance: recovery ?? null,
          target_config: targetConfig ?? null,
          membership: membership ?? null,
        },
      },
    };
  }
  return {
    state: 'OBSERVED_READY',
    guidance: {
      code: 'REQUEST_OBSERVED_READY',
      blocked_step: null,
      message_zh: '当前只读观察到配对/owner opt-in/receiver ACTIVE；这不等于消息已接收，也不等于 native/rollout 已确认。',
      next_steps: ['如已有 message_id，运行 onboard status 查看 model-receipt 关联', '不要把该状态当成模型收信或 pair 授权'],
      retry_policy: 'READ_ONLY_OBSERVATION',
      evidence: { receiver: receiver?.state ?? null },
    },
  };
}

function requestFingerprint({ source, target, messageId, authorizedBy, artifact }) {
  return sha256(Buffer.from(JSON.stringify({
    source, target, message_id: messageId ?? null,
    authorized_by: authorizedBy ?? null,
    artifact: artifact === null ? null : { path: artifact.path, sha256: artifact.sha256 },
  })));
}

function validateRequestId(requestId) {
  if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId)) {
    fail('ONBOARD_REQUEST_ID_INVALID', 'request_id must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}', {
      message_zh: 'request_id 格式无效；只能使用字母数字、点、下划线、短横线，最长 128。',
    });
  }
  if (WINDOWS_DEVICE_NAME_RE.test(requestId) || WINDOWS_DEVICE_NAME_RE.test(requestId.split('.')[0])) {
    fail('ONBOARD_REQUEST_ID_DEVICE_NAME', 'request_id is a reserved Windows device name', {
      request_id: requestId, message_zh: 'request_id 不能使用 Windows 设备名（CON/NUL/COM1/LPT1 等）。',
    });
  }
  return requestId;
}

async function withRequestLock(runtimeRoot, requestId, operation) {
  const paths = onboardingPaths(runtimeRoot);
  const lock = paths.lockFile(requestId);
  let handle;
  let lockCreated = false;
  try {
    ensureSafeDirectory(runtimeRoot, paths.requestsDir);
    handle = fs.openSync(lock, 'wx', 0o600);
    lockCreated = true;
    const now = new Date().toISOString();
    fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, at: now }), 'utf8');
    fs.fsyncSync(handle);
    if (handle !== undefined) try { fs.closeSync(handle); } catch { /* best effort */ }
    handle = undefined;
    return await operation();
  } catch (error) {
    if (error?.code === 'EEXIST') {
      fail('ONBOARD_REQUEST_BUSY', 'request is being updated by another process', {
        request_id: requestId,
        operation: 'persist_request',
        blocked_step: 'acquire_request_lock',
        persisted: false,
        retryable_same_request_id: true,
        message_zh: '该 request 正在被另一个进程更新；稍后用同一 request_id 重试。',
      });
    }
    throw annotateOnboardingError(error, {
      requestId,
      operation: 'persist_request',
      blockedStep: 'request_lock_or_write',
      persisted: false,
    });
  } finally {
    if (handle !== undefined) try { fs.closeSync(handle); } catch { /* best effort */ }
    if (lockCreated) try { fs.rmSync(lock, { force: true }); } catch { /* best effort */ }
  }
}

function readRequestFile(runtimeRoot, requestId) {
  const file = onboardingPaths(runtimeRoot).requestFile(requestId);
  if (fs.existsSync(file)) safeReadPath(runtimeRoot, file);
  const value = readJsonSafe(file);
  if (value === undefined) {
    if (!fs.existsSync(file)) fail('ONBOARD_REQUEST_NOT_FOUND', `request not found: ${requestId}`, { request_id: requestId, message_zh: '没有找到该 request；请检查 --runtime 和 request_id。' });
    fail('ONBOARD_REQUEST_CORRUPT', `request is not valid JSON: ${requestId}`, { request_id: requestId, message_zh: 'request 文件损坏；保留原文件，不覆盖。' });
  }
  if (value.schema_version !== ONBOARDING_SCHEMA_VERSION || value.request_id !== requestId || !ONBOARDING_STATES.includes(value.request_state)) {
    fail('ONBOARD_REQUEST_CORRUPT', `request shape is invalid: ${requestId}`, { request_id: requestId, message_zh: 'request 文件结构不符合当前 schema；暂停，不覆盖。' });
  }
  return { file, request: value };
}

function discoveryForRequest(runtimeRoot, source, target, messageId, now, context = {}, userAuthorized = false, request = null) {
  return (async () => {
    const discovery = await discoverOnboarding({
      runtimeRoot,
      installation: context.installation,
      locatorPath: context.locator_path,
      resolution: context.resolution,
      now,
    });
    discovery.source_identity_hint = source;
    const sourceObs = targetObservation(discovery.targets, source);
    const targetObs = targetObservation(discovery.targets, target);
    const receiver = receiverObservation(discovery.receivers, target, identityRole(target));
    const membership = membershipObservation(discovery.memberships.memberships, target);
    const targetConfig = targetConfigObservation(runtimeRoot, target, source);
    const generation = request === null ? null : generationCheck({
      request, hubWelcome: discovery.hub.welcome, locatorInstallation: context.installation,
    });
    const generationBlocked = generation !== null
      && (generation.state === 'DRIFT' || (generation.state === 'UNVERIFIED' && discovery.hub.reachable === true));
    const state = generationBlocked
      ? {
        state: 'BLOCKED',
        guidance: {
          code: generation.code,
          blocked_step: generation.blocked_step,
          message_zh: generation.message_zh,
          next_steps: [
            '保留 request/history；不要用新 Hub 的 IDs 覆盖既有 request',
            '核对当前 --runtime 是否仍是 request 记录的 installation/instance',
            '确认同一 runtime 后 onboard status 复查；不启动第二个 Hub',
          ],
          retry_policy: 'MANUAL_AFTER_INSTANCE_MATCH',
          evidence: { generation },
        },
      }
      : stateAndGuidance({ discovery, sourcePaired: sourceObs.enabled, targetPaired: targetObs.enabled, membership, receiver, targetConfig, userAuthorized: userAuthorized === true });
    const modelReceipt = readModelReceipt({ runtimeRoot, target, messageId, now });
    return {
      discovery,
      observations: {
        hub: discovery.hub,
        source_pair: sourceObs,
        target_pair: targetObs,
        receiver,
        membership,
        target_config: targetConfig,
        source_allowed_by_target: targetConfig?.source_allowed_by_target ?? null,
        generation,
        target_identity: target,
        source_identity: source,
        guidance: state.guidance,
        model_receipt: modelReceipt,
        observed_at: new Date(now).toISOString(),
      },
      request_state: state.state,
      guidance: state.guidance,
      model_receipt: modelReceipt,
    };
  })();
}

function normalizeInput({ source, target, messageId, userAuthorized, requestedBy, authorizedBy, note }) {
  if (typeof source !== 'string' || !isValidIdentity(source) || identityRole(source) === 'cli') {
    fail('ONBOARD_SOURCE_INVALID', 'source must be an exact non-cli role:id identity', { message_zh: 'source 必须是精确的 role:id 身份，且不能是 cli。' });
  }
  if (typeof target !== 'string' || !isValidIdentity(target) || identityRole(target) === 'cli') {
    fail('ONBOARD_TARGET_INVALID', 'target must be an exact non-cli role:id identity', { message_zh: 'target 必须是精确的 role:id 身份，且不能是 cli。' });
  }
  if (source === target) fail('ONBOARD_SOURCE_TARGET_SAME', 'source and target must differ', { message_zh: 'source 与 target 不能相同。' });
  // --user-authorized is a caller declaration / authorization reference, not
  // PCA or independent authentication. Missing consent still persists a request
  // as WAITING_OWNER_CONSENT; it never pairs or enables automatically.
  if (messageId !== undefined && messageId !== null && !isValidMessageId(messageId)) {
    fail('ONBOARD_MESSAGE_ID_INVALID', 'message_id has an unsupported shape', { message_zh: 'message_id 格式无效；只接受现有协议的消息 ID。' });
  }
  if (note !== undefined && (typeof note !== 'string' || note.length > MAX_NOTE)) {
    fail('ONBOARD_NOTE_INVALID', `note must be a string <= ${MAX_NOTE} chars`, { message_zh: `note 最多 ${MAX_NOTE} 字符，且不能替代聊天正文。` });
  }
  return {
    source,
    target,
    message_id: messageId ?? null,
    user_authorized: userAuthorized === true,
    requested_by: typeof requestedBy === 'string' && requestedBy.length > 0 ? requestedBy : 'cli:operator',
    authorized_by: typeof authorizedBy === 'string' && authorizedBy.length > 0 ? authorizedBy : 'cli:operator',
    note: note ?? '',
  };
}

/** Create a request record. No pairing/enable/delivery mutation occurs here. */
function readRequestForRuntime(runtimeRoot, requestId) {
  validateRequestId(requestId);
  let loaded;
  try {
    loaded = readRequestFile(runtimeRoot, requestId);
  } catch (error) {
    throw annotateOnboardingError(error, {
      requestId,
      operation: 'read',
      blockedStep: 'read_request',
      persisted: false,
    });
  }
  if (path.resolve(loaded.request.runtime_root) !== path.resolve(runtimeRoot)) {
    fail('ONBOARD_RUNTIME_CONFLICT', 'request belongs to a different runtime', {
      request_id: requestId,
      request_runtime_root: loaded.request.runtime_root,
      selected_runtime_root: path.resolve(runtimeRoot),
      operation: 'read',
      blocked_step: 'verify_request_runtime',
      persisted: true,
      message_zh: '该 request 属于另一个 runtime；不能跨实例查询或修改。',
    });
  }
  return loaded;
}

export async function listOnboardingRequests({ runtimeDir, installationRoot, state, limit = 100 } = {}) {
  const runtime = resolveOnboardingRuntime({ runtimeDir, installationRoot });
  const paths = onboardingPaths(runtime.runtime_root);
  const requests = [];
  const invalid = [];
  let entries = [];
  if (fs.existsSync(paths.requestsDir) && !safeReadPath(runtime.runtime_root, paths.requestsDir)) {
    fail('ONBOARD_PATH_REPARSE', 'requests directory is a reparse point', { runtime_root: runtime.runtime_root, message_zh: 'onboarding/requests 是 reparse/junction；暂停，不读取或写入。' });
  }
  try { entries = fs.readdirSync(paths.requestsDir, { withFileTypes: true }); } catch { /* no requests */ }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const requestId = entry.name.slice(0, -'.json'.length);
    if (!REQUEST_ID_RE.test(requestId)) continue;
    try {
      const loaded = readRequestForRuntime(runtime.runtime_root, requestId);
      if (state === undefined || loaded.request.request_state === state) requests.push(loaded.request);
    } catch (error) {
      invalid.push({ request_id: requestId, code: error?.code ?? 'ONBOARD_REQUEST_CORRUPT', message: String(error?.message ?? error) });
    }
  }
  requests.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return {
    ok: true,
    runtime_root: runtime.runtime_root,
    resolution: runtime.resolution,
    count: requests.length,
    requests: requests.slice(0, Math.max(0, Math.min(Number(limit) || 100, 500))),
    invalid,
  };
}

export async function getOnboardingRequest({ runtimeDir, installationRoot, requestId, refresh = true, now = Date.now() } = {}) {
  const runtime = resolveOnboardingRuntime({ runtimeDir, installationRoot });
  const loaded = readRequestForRuntime(runtime.runtime_root, requestId);
  const result = {
    ok: true,
    runtime_root: runtime.runtime_root,
    request: loaded.request,
    request_file: loaded.file,
    stored_state: loaded.request.request_state,
    stored_guidance: loaded.request.guidance,
    stored_updated_at: loaded.request.updated_at,
  };
  if (refresh === true) {
    const observed = await discoveryForRequest(
      runtime.runtime_root, loaded.request.source_identity, loaded.request.target_identity, loaded.request.message_id, now, runtime,
      loaded.request.authorization?.user_authorized === true, loaded.request,
    );
    result.live_observation = {
      request_state: observed.request_state,
      observations: observed.observations,
      model_receipt: observed.model_receipt,
      guidance: observed.guidance,
      observed_at: new Date(now).toISOString(),
    };
    result.current_state = observed.request_state;
    result.current_guidance = observed.guidance;
  } else {
    result.current_state = loaded.request.request_state;
    result.current_guidance = loaded.request.guidance;
  }
  return result;
}

export async function retryOnboardingRequest({ runtimeDir, installationRoot, requestId, actor = 'cli:operator', userAuthorized = undefined, authorizedBy = undefined, now = Date.now() } = {}) {
  const runtime = resolveOnboardingRuntime({ runtimeDir, installationRoot });
  validateRequestId(requestId);
  return withRequestLock(runtime.runtime_root, requestId, async () => {
    const loaded = readRequestForRuntime(runtime.runtime_root, requestId);
    if (loaded.request.request_state === 'REVOKED') {
      fail('ONBOARD_REQUEST_REVOKED', 'revoked request cannot be retried', {
        request_id: requestId, message_zh: '该 request 已撤销；保留历史，不能自动恢复。',
      });
    }
    const old = loaded.request;
    const authorized = userAuthorized === true ? true : old.authorization?.user_authorized === true;
    const observed = await discoveryForRequest(runtime.runtime_root, old.source_identity, old.target_identity, old.message_id, now, runtime, authorized, old);
    const generation = observed.observations.generation;
    if (generation !== null && (generation.state === 'DRIFT' || (generation.state === 'UNVERIFIED' && observed.discovery.hub.reachable === true))) {
      fail(generation.code, generation.message_zh, {
        request_id: requestId,
        operation: 'retry',
        blocked_step: generation.blocked_step,
        persisted: true,
        expected_generation: generation.expected,
        actual_hub: generation.hub,
        actual_locator: generation.locator,
        message_zh: `${generation.message_zh} 未覆盖 request，也未重发。`,
      });
    }
    const authorization = userAuthorized === true ? {
      ...(old.authorization ?? {}),
      user_authorized: true,
      authorized_by: typeof authorizedBy === 'string' && authorizedBy.length > 0 ? authorizedBy : (old.authorization?.authorized_by ?? actor),
      authorized_at: new Date(now).toISOString(),
      scope: 'one-request',
      declaration: 'caller_declared_no_independent_auth',
    } : old.authorization;
    const updated = {
      ...old,
      updated_at: new Date(now).toISOString(),
      authorization,
      request_state: observed.request_state,
      observations: observed.observations,
      model_receipt: observed.model_receipt,
      guidance: observed.guidance,
      history: [...(Array.isArray(old.history) ? old.history : []), {
        at: new Date(now).toISOString(),
        action: userAuthorized === true && old.authorization?.user_authorized !== true ? 'OWNER_CONSENT_DECLARED' : 'RETRY_OBSERVED',
        actor,
        request_state: observed.request_state,
        artifact_sha256: old.origin_artifact?.sha256 ?? null,
        message_id: old.message_id,
      }],
    };
    atomicWriteJson(loaded.file, updated);
    return { ok: true, idempotent: false, request: updated, runtime_root: runtime.runtime_root, request_file: loaded.file };
  });
}

const MANUAL_TURN_RE = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

/**
 * Record an active-turn manual model declaration from the target's native
 * thread. This never consumes/re-sends a Hub message and never claims native
 * acceptance or idle wake. The strict native-queue receipt reader is separate.
 */
export async function recordManualOnboardingReceipt({
  runtimeDir, installationRoot, requestId, messageId, turnId,
  env = process.env, now = Date.now(),
} = {}) {
  const runtime = resolveOnboardingRuntime({ runtimeDir, installationRoot });
  const loaded = readRequestForRuntime(runtime.runtime_root, requestId);
  if (loaded.request.request_state === 'REVOKED') {
    fail('ONBOARD_REQUEST_REVOKED', 'revoked request cannot record a receipt', { request_id: requestId, message_zh: '该 request 已撤销；不能补记回执。' });
  }
  if (typeof messageId !== 'string' || !isValidMessageId(messageId)) {
    fail('ONBOARD_MESSAGE_ID_INVALID', 'receipt requires a valid --message-id', { message_zh: 'receipt 需要有效的 --message-id。' });
  }
  if (typeof turnId !== 'string' || !MANUAL_TURN_RE.test(turnId)) {
    fail('ONBOARD_TURN_ID_INVALID', 'receipt requires a UUID --turn-id', { message_zh: 'receipt 需要有效的 turn UUID。' });
  }
  const request = loaded.request;
  if (request.message_id !== null && request.message_id !== messageId) {
    fail('ONBOARD_RECEIPT_MESSAGE_MISMATCH', 'receipt message_id differs from the request', {
      request_id: requestId, request_message_id: request.message_id, receipt_message_id: messageId,
      message_zh: 'receipt 的 message_id 与 request 不一致；未写入，保留原记录。',
    });
  }
  const target = request.target_identity;
  if (!target.startsWith('codex:')) {
    fail('ONBOARD_RECEIPT_TARGET_NOT_CODEX', 'manual active-turn receipt requires a codex target', { message_zh: 'manual receipt 仅适用于 codex 目标。' });
  }
  const targetThread = target.slice('codex:'.length);
  const nativeThread = env.CODEX_THREAD_ID;
  if (nativeThread !== targetThread) {
    fail('ONBOARD_RECEIPT_OWNER_THREAD_MISMATCH', 'native CODEX_THREAD_ID must equal target thread', {
      expected_thread_id: targetThread, native_thread_id: nativeThread ?? null,
      message_zh: '当前原生 CODEX_THREAD_ID 不等于 request.target；不伪造 owner 线程，未写入回执。',
      next_steps: ['在 target 原线程中运行 receipt 命令', '不要设置/伪造 CODEX_THREAD_ID'],
    });
  }
  const hubRead = readHubConfig(runtime.runtime_root);
  if (!hubRead.ok) {
    fail('ONBOARD_RECEIPT_HUB_UNAVAILABLE', 'cannot read current Hub for receipt validation', {
      code_detail: hubRead.code, message_zh: '当前 Hub 不可读；未写入回执，也没有 consume/重发。',
    });
  }
  let record;
  let hubWelcome = null;
  const client = new HubClient({
    host: hubRead.config.host ?? '127.0.0.1', port: hubRead.config.port,
    token: hubRead.token, role: 'cli', identity: 'cli:operator',
  });
  try {
    hubWelcome = await client.connect({ timeoutMs: 2_000 });
    record = await client.status(messageId);
  } catch (error) {
    fail('ONBOARD_RECEIPT_HUB_ERROR', String(error?.message ?? error), {
      message_zh: '无法读取 Hub 中该消息；未写入回执。',
    });
  } finally {
    await client.close();
  }
  const generation = generationCheck({
    request,
    hubWelcome: hubWelcome ?? client.welcomeInfo ?? null,
    locatorInstallation: runtime.installation,
  });
  if (generation.state === 'DRIFT' || generation.state === 'UNVERIFIED') {
    fail(generation.code, generation.message_zh, {
      request_id: requestId,
      operation: 'receipt',
      blocked_step: generation.blocked_step,
      persisted: true,
      expected_generation: generation.expected,
      actual_hub: generation.hub,
      actual_locator: generation.locator,
      message_zh: `${generation.message_zh} 未写入 manual receipt。`,
    });
  }
  if (record === undefined) {
    fail('ONBOARD_RECEIPT_MESSAGE_NOT_FOUND', 'message is not present in the current Hub', {
      message_id: messageId, message_zh: '当前 Hub 没有该 message_id；未写入回执。',
    });
  }
  if (record.from !== request.source_identity || record.to !== request.target_identity) {
    fail('ONBOARD_RECEIPT_ROUTE_MISMATCH', 'Hub message route does not match the request', {
      expected_from: request.source_identity, expected_to: request.target_identity,
      actual_from: record.from ?? null, actual_to: record.to ?? null,
      message_zh: 'Hub 中该消息的 source/target 与 request 不匹配；未写入回执。',
    });
  }
  return withRequestLock(runtime.runtime_root, requestId, async () => {
    const current = readRequestForRuntime(runtime.runtime_root, requestId);
    if (current.request.request_state === 'REVOKED') {
      fail('ONBOARD_REQUEST_REVOKED', 'revoked request cannot record a receipt', {
        request_id: requestId, message_zh: '该 request 在回执写入前已撤销；保留历史，未写入回执。',
      });
    }
    if (current.request.source_identity !== request.source_identity ||
        current.request.target_identity !== request.target_identity ||
        current.request.message_id !== null && current.request.message_id !== messageId) {
      fail('ONBOARD_RECEIPT_BINDING_CHANGED', 'request binding changed while receipt was being verified', {
        request_id: requestId, message_zh: '锁定后 request 的 source/target/message 绑定已变化；未写入回执。',
      });
    }
    const prior = current.request.manual_receipt ?? null;
    if (prior !== null && prior.message_id === messageId && prior.turn_id === turnId && prior.route === 'MANUAL_ACTIVE_TURN') {
      return { ok: true, idempotent: true, request: current.request, runtime_root: runtime.runtime_root, request_file: current.file };
    }
    if (prior !== null) {
      fail('ONBOARD_RECEIPT_CONFLICT', 'a different manual receipt is already recorded', {
        request_id: requestId, existing_message_id: prior.message_id, existing_turn_id: prior.turn_id,
        message_zh: '该 request 已有不同 manual receipt；保留原记录，不覆盖。',
      });
    }
    const manualReceipt = {
      route: 'MANUAL_ACTIVE_TURN',
      model_status: 'MODEL_REPORTED_MANUAL',
      native_accepted: 'UNKNOWN',
      idle_wake: 'NOT_CLAIMED',
      received_confirmed: false,
      message_id: messageId,
      turn_id: turnId,
      thread_id: targetThread,
      source_identity: request.source_identity,
      target_identity: request.target_identity,
      native_thread_id_verified: true,
      native_thread_evidence: 'CODEX_THREAD_ID_ENV_SELF_REPORT',
      same_user_self_report_only: true,
      hub_source_target_verified: true,
      observed_at: new Date(now).toISOString(),
      note: 'Manual active-turn declaration: model receipt is not native queue acceptance or idle wake evidence.',
    };
    const updated = {
      ...current.request,
      updated_at: new Date(now).toISOString(),
      manual_receipt: manualReceipt,
      history: [...(Array.isArray(current.request.history) ? current.request.history : []), {
        at: new Date(now).toISOString(),
        action: 'MANUAL_RECEIPT_RECORDED',
        request_state: current.request.request_state,
        message_id: messageId,
        turn_id: turnId,
        route: 'MANUAL_ACTIVE_TURN',
        native_accepted: 'UNKNOWN',
      }],
    };
    atomicWriteJson(current.file, updated);
    return { ok: true, idempotent: false, request: updated, runtime_root: runtime.runtime_root, request_file: current.file };
  });
}
export async function revokeOnboardingRequest({ runtimeDir, installationRoot, requestId, actor = 'cli:operator', reason = '', now = Date.now() } = {}) {
  const runtime = resolveOnboardingRuntime({ runtimeDir, installationRoot });
  validateRequestId(requestId);
  return withRequestLock(runtime.runtime_root, requestId, async () => {
    const loaded = readRequestForRuntime(runtime.runtime_root, requestId);
    if (loaded.request.request_state === 'REVOKED') {
      return { ok: true, idempotent: true, request: loaded.request, runtime_root: runtime.runtime_root, request_file: loaded.file };
    }
    const updated = {
      ...loaded.request,
      updated_at: new Date(now).toISOString(),
      request_state: 'REVOKED',
      revoked_at: new Date(now).toISOString(),
      revoke_reason: String(reason).slice(0, MAX_NOTE),
      history: [...(Array.isArray(loaded.request.history) ? loaded.request.history : []), {
        at: new Date(now).toISOString(),
        action: 'REVOKED',
        actor,
        request_state: 'REVOKED',
        reason: String(reason).slice(0, MAX_NOTE),
      }],
    };
    atomicWriteJson(loaded.file, updated);
    return { ok: true, idempotent: false, request: updated, runtime_root: runtime.runtime_root, request_file: loaded.file };
  });
}

export async function createOnboardingRequest({
  runtimeDir, installationRoot, source, target, messageId, userAuthorized,
  requestedBy, authorizedBy, note, originArtifact, requestId, now = Date.now(),
} = {}) {
  const runtime = resolveOnboardingRuntime({ runtimeDir, installationRoot });
  const input = normalizeInput({ source, target, messageId, userAuthorized, requestedBy, authorizedBy, note });
  const artifact = readArtifact(originArtifact);
  const id = requestId === undefined || requestId === null ? `onb-${crypto.randomUUID()}` : validateRequestId(requestId);
  const paths = onboardingPaths(runtime.runtime_root);
  try {
    return await withRequestLock(runtime.runtime_root, id, async () => {
    const requestFile = paths.requestFile(id);
    const exists = fs.existsSync(requestFile);
    const existing = readJsonSafe(requestFile);
    if (exists && existing === undefined) {
      fail('ONBOARD_REQUEST_CORRUPT', `request is not valid JSON: ${id}`, {
        request_id: id, existing_request_file: requestFile,
        message_zh: 'request_id 已存在但文件损坏；保留原文件，不覆盖。',
      });
    }
    const observed = await discoveryForRequest(runtime.runtime_root, input.source, input.target, input.message_id, now, runtime, input.user_authorized === true);
    if (existing !== undefined) {
      const generation = generationCheck({
        request: existing,
        hubWelcome: observed.discovery.hub.welcome,
        locatorInstallation: runtime.installation,
      });
      if (generation.state === 'DRIFT' || (generation.state === 'UNVERIFIED' && observed.discovery.hub.reachable === true)) {
        fail(generation.code, generation.message_zh, {
          request_id: id,
          operation: 'create',
          blocked_step: generation.blocked_step,
          persisted: true,
          expected_generation: generation.expected,
          actual_hub: generation.hub,
          actual_locator: generation.locator,
          message_zh: generation.message_zh,
        });
      }
      if (existing.fingerprint === requestFingerprint({ source: input.source, target: input.target, messageId: input.message_id, authorizedBy: input.authorized_by, artifact })) {
        return { ok: true, idempotent: true, request: existing, runtime_root: runtime.runtime_root, request_file: requestFile };
      }
      fail('ONBOARD_REQUEST_ID_CONFLICT', `request_id already exists with different source/target/authorization: ${id}`, {
        request_id: id, existing_request_file: requestFile,
        message_zh: 'request_id 已存在且内容不同；保留原 request，不覆盖。请换一个 request_id。',
      });
    }
    const generation = trustedGeneration({ installation: runtime.installation, discovery: observed.discovery, now });
    const request = {
      schema_version: ONBOARDING_SCHEMA_VERSION,
      request_id: id,
      created_at: new Date(now).toISOString(),
      updated_at: new Date(now).toISOString(),
      runtime_root: runtime.runtime_root,
      installation_id: generation.installation_id,
      instance_id: generation.instance_id,
      generation,
      source_identity: input.source,
      target_identity: input.target,
      message_id: input.message_id,
      requested_by: input.requested_by,
      authorization: {
        user_authorized: input.user_authorized === true,
        authorized_by: input.user_authorized === true ? input.authorized_by : null,
        authorized_at: input.user_authorized === true ? new Date(now).toISOString() : null,
        scope: 'one-request',
        declaration: 'caller_declared_no_independent_auth',
      },
      note: input.note,
      origin_artifact: artifact,
      fingerprint: requestFingerprint({ source: input.source, target: input.target, messageId: input.message_id, authorizedBy: input.authorized_by, artifact }),
      request_state: observed.request_state,
      observations: observed.observations,
      model_receipt: observed.model_receipt,
      guidance: observed.guidance,
      history: [{
        at: new Date(now).toISOString(), action: 'CREATED', actor: input.requested_by,
        request_state: observed.request_state,
        artifact_sha256: artifact?.sha256 ?? null,
        message_id: input.message_id,
      }],
    };
    atomicWriteJson(requestFile, request);
    return { ok: true, idempotent: false, request, runtime_root: runtime.runtime_root, request_file: requestFile };
    });
  } catch (error) {
    throw annotateOnboardingError(error, {
      requestId: id,
      operation: 'create',
      blockedStep: 'persist_request',
      persisted: false,
    });
  }
}
