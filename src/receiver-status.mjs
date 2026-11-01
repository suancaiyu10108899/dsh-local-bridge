// Read-only visibility for optional peer receivers.
//
// Receivers may operate in legacy bounded-window mode or in daily mode
// (mode=daily, expires_at=null, rolling submission limits). This module only
// reads/derives state for humans and CLI hints; it never starts, renews,
// disables or otherwise changes a receiver.
import fs from 'node:fs';
import path from 'node:path';
import { RUNTIME_DIR } from './runtime.mjs';
import { pidAlive } from './health.mjs';
import { readProcessIdentity, sameProcess } from './process-identity.mjs';

const ACTIVE_PHASES = new Set(['online-idle', 'waiting', 'starting', 'native-queued', 'backoff', 'rate-limited']);
export const RECEIVER_HEARTBEAT_STALE_MS = 90_000;
export const RECEIVER_HEARTBEAT_FUTURE_SKEW_MS = 5_000;

export function receiverStatusRoot(runtimeDir = RUNTIME_DIR) {
  return path.join(runtimeDir, 'codex');
}

function asInteger(value) {
  if (Number.isInteger(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Math.trunc(Number(value));
  return undefined;
}

function firstDefined(source, keys) {
  for (const key of keys) {
    if (source !== null && typeof source === 'object' && Object.hasOwn(source, key)) return source[key];
  }
  return undefined;
}

function receiverIdentity(source) {
  const owner = source?.owner_process !== null && typeof source?.owner_process === 'object' ? source.owner_process : {};
  const pid = asInteger(firstDefined(source, ['pid']) ?? firstDefined(owner, ['pid']));
  const createdAt = firstDefined(source, ['process_created_at', 'created_at']);
  const created = typeof createdAt === 'string'
    ? createdAt
    : typeof owner.created_at === 'string' ? owner.created_at : null;
  const exe = firstDefined(source, ['exe_path', 'exe_realpath']);
  const entry = firstDefined(source, ['entry_path', 'entry_realpath']);
  const configPath = firstDefined(source, ['config_path']);
  return {
    pid,
    created_at: created,
    exe_path: typeof exe === 'string' ? exe : (typeof owner.exe_path === 'string' ? owner.exe_path : (typeof owner.exe_realpath === 'string' ? owner.exe_realpath : null)),
    entry_path: typeof entry === 'string' ? entry : (typeof owner.entry_path === 'string' ? owner.entry_path : (typeof owner.entry_realpath === 'string' ? owner.entry_realpath : null)),
    config_path: typeof configPath === 'string' ? configPath : (typeof owner.config_path === 'string' ? owner.config_path : null),
    nonce: firstDefined(source, ['worker_nonce', 'nonce']) ?? (typeof owner.nonce === 'string' ? owner.nonce : null),
    thread_id: firstDefined(source, ['thread_id']) ?? (typeof owner.thread_id === 'string' ? owner.thread_id : null),
  };
}

function identityComplete(identity) {
  return Number.isInteger(identity.pid) &&
    typeof identity.created_at === 'string' &&
    typeof identity.exe_path === 'string' &&
    typeof identity.entry_path === 'string';
}

function safeReceiverGuidance(source) {
  const value = source?.guidance;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    code: typeof value.code === 'string' ? value.code : null,
    blocked_step: typeof value.blocked_step === 'string' ? value.blocked_step : null,
    message_zh: typeof value.message_zh === 'string' ? value.message_zh : null,
    next_steps: Array.isArray(value.next_steps) ? value.next_steps.slice(0, 8).map(String) : [],
    retry_policy: typeof value.retry_policy === 'string' ? value.retry_policy : null,
  };
}

/** Convert a receiver status.json payload into a small, stable read-only view. */
export function summarizeReceiver(status, { dirName = '', now = Date.now() } = {}) {
  const source = status !== null && typeof status === 'object' ? status : {};
  const rawStatus = typeof source.status === 'string' ? source.status : 'UNKNOWN';
  const hasNullExpiry = Object.hasOwn(source, 'expires_at') && source.expires_at === null;
  const mode = source.mode === 'daily' ? 'daily' : source.mode === 'bounded' ? 'bounded' : hasNullExpiry ? 'daily' : 'bounded';
  const expiresAt = typeof source.expires_at === 'string' ? source.expires_at : hasNullExpiry ? null : undefined;
  const expiresMs = expiresAt === undefined || expiresAt === null ? Number.NaN : Date.parse(expiresAt);
  const expired = mode !== 'daily' && (rawStatus === 'EXPIRED' || (Number.isFinite(expiresMs) && expiresMs <= now));
  const disabled = source.enabled === false || ['DISABLED', 'STOPPED', 'STOP_REQUESTED'].includes(rawStatus);
  const halted = rawStatus.startsWith('HALTED');
  const reasonCode = firstDefined(source, ['reason_code', 'reasonCode']);
  const reason = firstDefined(source, ['reason', 'message']);
  const lastError = firstDefined(source, ['last_error', 'lastError']);
  const identity = receiverIdentity(source);
  const heartbeatAt = firstDefined(source, ['heartbeat_at', 'heartbeatAt', 'last_heartbeat_at', 'at']);
  const heartbeatMs = typeof heartbeatAt === 'string' ? Date.parse(heartbeatAt) : Number.NaN;
  const heartbeatAgeMs = Number.isFinite(heartbeatMs) ? Math.max(0, now - heartbeatMs) : undefined;
  const heartbeatFuture = Number.isFinite(heartbeatMs) && heartbeatMs > now + RECEIVER_HEARTBEAT_FUTURE_SKEW_MS;
  const heartbeatFresh = Number.isFinite(heartbeatMs) && !heartbeatFuture && now - heartbeatMs <= RECEIVER_HEARTBEAT_STALE_MS;

  let phase = 'unknown';
  if (disabled) phase = 'disabled';
  else if (rawStatus.includes('PAUSED_UNCERTAIN')) phase = 'paused-uncertain';
  else if (rawStatus.includes('RATE_LIMITED')) phase = 'rate-limited';
  else if (rawStatus.includes('BACKOFF')) phase = 'backoff';
  else if (halted) phase = 'halted';
  else if (expired) phase = 'expired';
  else if (rawStatus === 'ONLINE_IDLE') phase = 'online-idle';
  else if (rawStatus === 'WAITING_FOR_TARGET_IDLE_OR_COOLDOWN') phase = 'waiting';
  else if (rawStatus === 'STARTED') phase = 'starting';
  else if (rawStatus.includes('NATIVE_QUEUED')) phase = 'native-queued';

  const enabled = disabled ? false : true;
  const reportedActive = enabled && !expired && ACTIVE_PHASES.has(phase);
  const reportedReady = phase === 'online-idle' && enabled;
  const pid = identity.pid;
  const explicitPidAlive = firstDefined(source, ['pidAlive', 'pid_alive']);
  const maxNativeSubmissions = asInteger(firstDefined(source, ['max_native_submissions', 'maxNativeSubmissions']));
  const usedNativeSubmissions = asInteger(firstDefined(source, ['used_native_submissions', 'usedNativeSubmissions', 'used']));
  const remainingRaw = asInteger(firstDefined(source, ['remaining_native_submissions', 'remainingNativeSubmissions', 'remaining']));
  const remainingNativeSubmissions = remainingRaw ?? (
    maxNativeSubmissions !== undefined && usedNativeSubmissions !== undefined
      ? Math.max(0, maxNativeSubmissions - usedNativeSubmissions)
      : undefined
  );
  const schemaVersion = asInteger(firstDefined(source, ['schema_version', 'schemaVersion']));

  return {
    schemaVersion,
    installationId: typeof source.installation_id === 'string' ? source.installation_id : undefined,
    instanceId: typeof source.instance_id === 'string' ? source.instance_id : undefined,
    workerNonce: identity.nonce,
    threadId: typeof source.thread_id === 'string' ? source.thread_id : (identity.thread_id ?? dirName),
    mode,
    enabled,
    status: rawStatus,
    phase,
    reportedPhase: phase,
    reportedActive,
    reportedReady,
    // Effective reachability starts UNVERIFIED. Only the async identity view can
    // promote active/ready after a fresh, non-future heartbeat proves liveness.
    active: false,
    ready: false,
    effectiveActive: false,
    effectiveReady: false,
    health: 'UNVERIFIED',
    readiness: 'UNVERIFIED_IDENTITY',
    pid,
    // Kept for diagnostics only. It is never promoted to health by this module.
    pidAlive: typeof explicitPidAlive === 'boolean' ? explicitPidAlive : typeof pid === 'number' ? pidAlive(pid) : undefined,
    processCreatedAt: identity.created_at,
    processExe: identity.exe_path,
    processEntry: identity.entry_path,
    configPath: identity.config_path,
    identityComplete: identityComplete(identity),
    identityVerdict: 'UNVERIFIED',
    heartbeatAt: typeof heartbeatAt === 'string' ? heartbeatAt : undefined,
    heartbeatMs: Number.isFinite(heartbeatMs) ? heartbeatMs : undefined,
    heartbeatAgeMs,
    heartbeatFresh,
    heartbeatFuture,
    heartbeatStale: Number.isFinite(heartbeatMs) ? !heartbeatFresh && !heartbeatFuture : true,
    windowId: typeof source.window_id === 'string' ? source.window_id : undefined,
    updatedAt: typeof source.at === 'string' ? source.at : undefined,
    expiresAt,
    expiresInFuture: mode !== 'daily' && Number.isFinite(expiresMs) ? expiresMs > now : undefined,
    maxNativeSubmissions,
    usedNativeSubmissions,
    remainingNativeSubmissions,
    nextEligibleAt: typeof source.next_eligible_at === 'string' ? source.next_eligible_at : undefined,
    reasonCode: typeof reasonCode === 'string' ? reasonCode : undefined,
    reason: typeof reason === 'string' ? reason : undefined,
    lastError: typeof lastError === 'string' ? lastError : undefined,
    guidance: safeReceiverGuidance(source),
  };
}

/** Read all receiver status.json files without starting, renewing or changing any receiver. */
export function readReceiverStatuses({ runtimeDir = RUNTIME_DIR, now = Date.now() } = {}) {
  const root = receiverStatusRoot(runtimeDir);
  const receivers = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { root, receivers };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const statusFile = path.join(root, entry.name, 'status.json');
    try {
      const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
      receivers.push(summarizeReceiver(status, { dirName: entry.name, now }));
    } catch {
      receivers.push({
        threadId: entry.name,
        mode: 'unknown',
        enabled: false,
        status: 'UNREADABLE',
        phase: 'unknown',
        active: false,
        ready: false,
      });
    }
  }
  receivers.sort((a, b) => String(a.threadId).localeCompare(String(b.threadId)));
  return { root, receivers };
}

/**
 * Async receiver view that verifies v3 process identity. A missing identity is
 * UNVERIFIED, not healthy; this deliberately does not use pidAlive as proof.
 */
export async function readReceiverStatusesAsync({ runtimeDir = RUNTIME_DIR, now = Date.now(), processProvider } = {}) {
  const base = readReceiverStatuses({ runtimeDir, now });
  const receivers = [];
  for (const receiver of base.receivers) {
    if (receiver.identityComplete !== true) {
      receivers.push({
        ...receiver,
        identityVerdict: 'UNKNOWN',
        health: 'UNVERIFIED',
        readiness: 'UNVERIFIED_IDENTITY',
        active: false,
        ready: false,
        effectiveActive: false,
        effectiveReady: false,
        identityChecks: null,
        identityReasons: ['IDENTITY_FIELDS_MISSING'],
      });
      continue;
    }
    const expected = {
      pid: receiver.pid,
      created_at: receiver.processCreatedAt,
      exe_path: receiver.processExe,
      entry_path: receiver.processEntry,
    };
    const identity = await readProcessIdentity(receiver.pid, { provider: processProvider });
    const comparison = sameProcess(identity, expected);
    let health;
    let readiness;
    if (comparison.verdict === 'DIFFERENT') {
      health = 'IDENTITY_MISMATCH';
      readiness = 'IDENTITY_MISMATCH';
    } else if (comparison.verdict !== 'SAME') {
      health = 'UNVERIFIED';
      readiness = 'UNVERIFIED_IDENTITY';
    } else if (receiver.heartbeatFuture === true) {
      health = 'FUTURE_HEARTBEAT';
      readiness = 'FUTURE_HEARTBEAT';
    } else if (receiver.heartbeatFresh !== true) {
      health = 'STALE_HEARTBEAT';
      readiness = 'STALE_HEARTBEAT';
    } else if (receiver.reportedActive !== true) {
      health = 'IDENTITY_VERIFIED';
      readiness = receiver.reportedPhase === 'online-idle' ? 'REPORTED_NOT_READY' : 'REPORTED_OFFLINE';
    } else if (receiver.reportedReady === true) {
      health = 'IDENTITY_VERIFIED';
      readiness = 'READY';
    } else {
      health = 'IDENTITY_VERIFIED';
      readiness = 'ACTIVE_NOT_READY';
    }
    const effectiveActive = health === 'IDENTITY_VERIFIED' && receiver.reportedActive === true;
    const effectiveReady = health === 'IDENTITY_VERIFIED' && receiver.reportedReady === true;
    receivers.push({
      ...receiver,
      identityVerdict: comparison.verdict,
      health,
      readiness,
      identity,
      identityChecks: comparison.checks,
      identityReasons: comparison.reasons,
      active: effectiveActive,
      ready: effectiveReady,
      effectiveActive,
      effectiveReady,
    });
  }
  return { ...base, receivers };
}

/**
 * Explain why a message to a peer is queued. Output-only; never changes
 * receiver state, renews a window, or claims delivery.
 */
export function deliveryHint(message, statuses) {
  const target = typeof message?.to === 'string' ? message.to : '';
  if (!target.startsWith('codex:')) return undefined;
  if (!['queued', 'delivering', 'delivery_unknown'].includes(message?.state)) return undefined;
  const threadId = target.slice('codex:'.length);
  const receiver = (statuses?.receivers ?? []).find((item) => item.threadId === threadId);
  if (receiver === undefined) {
    return {
      code: 'receiver-absent',
      phase: 'absent',
      detail: 'no local receiver status for this thread; messages stay queued until a receiver status is published',
    };
  }
  const definitivePhase = ['expired', 'disabled', 'halted', 'paused-uncertain'].includes(receiver.phase);
  if (!definitivePhase && (receiver.health !== 'IDENTITY_VERIFIED' || receiver.effectiveActive !== true)) {
    const healthCode = receiver.health === 'IDENTITY_MISMATCH'
      ? 'receiver-mismatch'
      : receiver.health === 'STALE_HEARTBEAT'
        ? 'receiver-stale'
        : receiver.health === 'FUTURE_HEARTBEAT'
          ? 'receiver-heartbeat-future'
          : 'receiver-unverified';
    return {
      code: healthCode,
      phase: receiver.phase,
      health: receiver.health,
      readiness: receiver.readiness,
      mode: receiver.mode,
      status: receiver.status,
      detail: 'receiver identity/heartbeat is not verified as current; wait or diagnose before assuming delivery is possible',
    };
  }
  if (!definitivePhase && receiver.phase === 'online-idle' && receiver.ready !== true) {
    return {
      code: 'receiver-not-ready',
      phase: receiver.phase,
      health: receiver.health,
      readiness: receiver.readiness,
      mode: receiver.mode,
      status: receiver.status,
      detail: 'receiver process is alive but not effective-ready; wait for verification / fresh heartbeat',
    };
  }
  const detailByPhase = {
    expired: 'legacy bounded receiver window expired; the message stays queued until a new window is explicitly started',
    'online-idle': receiver.mode === 'daily'
      ? 'daily receiver is online and idle; delivery is possible without a fixed expiry'
      : 'receiver is online and idle; delivery is possible',
    waiting: 'receiver is online but waiting for the target thread to become idle; the message remains queued',
    starting: 'receiver is starting; the message remains queued',
    'native-queued': 'receiver has queued the message natively; this is not proof the model processed it',
    backoff: 'receiver is in automatic backoff and will retry its Hub connection; the message remains queued',
    'rate-limited': 'rolling native-submission limit reached; delivery is delayed until the next eligible time, not terminated',
    'paused-uncertain': 'receiver paused because a native submission outcome is uncertain; review before any retry',
    halted: 'receiver is halted and needs review; do not retry blindly',
    disabled: 'receiver is disabled; the message remains queued until explicitly enabled',
    unknown: 'receiver status is unknown; inspect it before retrying',
  };
  return {
    code: `receiver-${receiver.phase}`,
    phase: receiver.phase,
    health: receiver.health,
    readiness: receiver.readiness,
    mode: receiver.mode,
    status: receiver.status,
    expiresAt: receiver.expiresAt,
    nextEligibleAt: receiver.nextEligibleAt,
    remainingNativeSubmissions: receiver.remainingNativeSubmissions,
    reasonCode: receiver.reasonCode,
    detail: detailByPhase[receiver.phase] ?? detailByPhase.unknown,
  };
}

/** Add output-only delivery hints to message records. */
export function attachDeliveryHints(messages, statuses) {
  return messages.map((message) => {
    const hint = deliveryHint(message, statuses);
    return hint === undefined ? message : { ...message, delivery_hint: hint };
  });
}
