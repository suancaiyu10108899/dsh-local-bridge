// Read-only visibility for optional peer receivers.
//
// The Codex native queue receiver (a separate, PCA-owned component) writes
// status.json files under <runtime>/codex/<thread-id>/status.json. The public
// DSH alpha does not ship that receiver, but when it exists locally its state
// must be visible instead of looking like a silent delivery stall.
import fs from 'node:fs';
import path from 'node:path';
import { RUNTIME_DIR } from './runtime.mjs';

export function receiverStatusRoot(runtimeDir = RUNTIME_DIR) {
  return path.join(runtimeDir, 'codex');
}

/** Convert a receiver status.json payload into a small, stable view. */
export function summarizeReceiver(status, { dirName = '', now = Date.now() } = {}) {
  const rawStatus = typeof status?.status === 'string' ? status.status : 'UNKNOWN';
  const expiresAt = typeof status?.expires_at === 'string' ? status.expires_at : undefined;
  const expiresMs = expiresAt === undefined ? Number.NaN : Date.parse(expiresAt);
  const expiresInFuture = Number.isFinite(expiresMs) ? expiresMs > now : false;
  const expired = rawStatus === 'EXPIRED' || (Number.isFinite(expiresMs) && expiresMs <= now);
  const halted = rawStatus.startsWith('HALTED') || rawStatus === 'STOPPED' || rawStatus === 'STOP_REQUESTED';
  let phase = 'unknown';
  if (expired) phase = 'expired';
  else if (rawStatus === 'ONLINE_IDLE') phase = 'online-idle';
  else if (rawStatus === 'WAITING_FOR_TARGET_IDLE_OR_COOLDOWN') phase = 'waiting';
  else if (rawStatus === 'STARTED') phase = 'starting';
  else if (rawStatus.includes('NATIVE_QUEUED')) phase = 'native-queued';
  else if (halted) phase = 'halted';
  else if (rawStatus === 'HALTED_REVIEW_REQUIRED') phase = 'halted';
  const active = !expired && !halted && ['online-idle', 'waiting', 'starting', 'native-queued'].includes(phase);
  return {
    threadId: typeof status?.thread_id === 'string' ? status.thread_id : dirName,
    status: rawStatus,
    phase,
    active,
    ready: phase === 'online-idle',
    pid: Number.isInteger(status?.pid) ? status.pid : undefined,
    windowId: typeof status?.window_id === 'string' ? status.window_id : undefined,
    updatedAt: typeof status?.at === 'string' ? status.at : undefined,
    expiresAt,
    expiresInFuture: Number.isFinite(expiresMs) ? expiresMs > now : undefined,
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
 * Explain why a message to a peer is queued. This is output-only; it never
 * changes receiver state, renews a window, or claims delivery.
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
      detail: 'no local receiver status for this thread; messages stay queued until a receiver window is active',
    };
  }
  const detailByPhase = {
    expired: 'receiver window expired; the message stays queued until a new window is explicitly started',
    'online-idle': 'receiver is online and idle; delivery is possible',
    waiting: 'receiver is online but waiting for the target thread to become idle; the message remains queued',
    starting: 'receiver is starting; the message remains queued',
    'native-queued': 'receiver has queued the message natively; this is not proof the model processed it',
    halted: 'receiver is halted and needs review; do not retry blindly',
    stopped: 'receiver was stopped; the message remains queued',
    unknown: 'receiver status is unknown; inspect it before retrying',
  };
  return {
    code: `receiver-${receiver.phase}`,
    phase: receiver.phase,
    status: receiver.status,
    expiresAt: receiver.expiresAt,
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
