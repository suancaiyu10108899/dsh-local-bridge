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

const ACTIVE_PHASES = new Set(['online-idle', 'waiting', 'starting', 'native-queued', 'backoff', 'rate-limited']);

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
  const active = enabled && !expired && ACTIVE_PHASES.has(phase);
  const pid = asInteger(source.pid);
  const explicitPidAlive = firstDefined(source, ['pidAlive', 'pid_alive']);
  const heartbeatAt = firstDefined(source, ['heartbeat_at', 'heartbeatAt', 'last_heartbeat_at', 'at']);
  const heartbeatMs = typeof heartbeatAt === 'string' ? Date.parse(heartbeatAt) : Number.NaN;
  const maxNativeSubmissions = asInteger(firstDefined(source, ['max_native_submissions', 'maxNativeSubmissions']));
  const usedNativeSubmissions = asInteger(firstDefined(source, ['used_native_submissions', 'usedNativeSubmissions', 'used']));
  const remainingRaw = asInteger(firstDefined(source, ['remaining_native_submissions', 'remainingNativeSubmissions', 'remaining']));
  const remainingNativeSubmissions = remainingRaw ?? (
    maxNativeSubmissions !== undefined && usedNativeSubmissions !== undefined
      ? Math.max(0, maxNativeSubmissions - usedNativeSubmissions)
      : undefined
  );

  return {
    threadId: typeof source.thread_id === 'string' ? source.thread_id : dirName,
    mode,
    enabled,
    status: rawStatus,
    phase,
    active,
    ready: phase === 'online-idle' && enabled,
    pid,
    pidAlive: typeof explicitPidAlive === 'boolean' ? explicitPidAlive : typeof pid === 'number' ? pidAlive(pid) : undefined,
    heartbeatAt: typeof heartbeatAt === 'string' ? heartbeatAt : undefined,
    heartbeatAgeMs: Number.isFinite(heartbeatMs) ? Math.max(0, now - heartbeatMs) : undefined,
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
