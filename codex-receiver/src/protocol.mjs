// Wire protocol primitives for the Local Agent Bridge.
// Shared by the hub, the DSH host plugin, the Codex adapter and the CLI.
//
// Transport: TCP 127.0.0.1, length-prefixed JSON frames:
//   [uint32 LE payload length][UTF-8 JSON payload]
// This matches the framing used by the Codex Desktop app-tools pipe, so the
// same helpers are reused there.

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const MAX_TEXT_CHARS = 64 * 1024;

/** Durable message states. `delivering` is a transient attempt marker. */
export const STATES = Object.freeze({
  QUEUED: 'queued',
  DELIVERING: 'delivering',
  DELIVERED: 'delivered',
  DELIVERY_UNKNOWN: 'delivery_unknown',
  FAILED: 'failed',
  EXPIRED: 'expired',
});

const TRANSITIONS = Object.freeze({
  [STATES.QUEUED]: [STATES.DELIVERING, STATES.FAILED, STATES.EXPIRED],
  [STATES.DELIVERING]: [STATES.DELIVERED, STATES.DELIVERY_UNKNOWN, STATES.FAILED],
  [STATES.DELIVERED]: [],
  [STATES.DELIVERY_UNKNOWN]: [STATES.DELIVERING, STATES.FAILED, STATES.EXPIRED],
  [STATES.FAILED]: [],
  [STATES.EXPIRED]: [],
});

export function canTransition(from, to) {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function isTerminalState(state) {
  return (TRANSITIONS[state] ?? []).length === 0;
}

/** Roles allowed by the hub. CLI is an operator surface, not a chat peer. */
export const ROLES = Object.freeze(['dsh', 'codex', 'cli']);

/** Identities are `role:opaque-id`; the opaque part must be non-empty. */
const IDENTITY_RE = /^(dsh|codex|cli):[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MESSAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function identityRole(identity) {
  const match = IDENTITY_RE.exec(identity ?? '');
  return match ? match[1] : undefined;
}

export function isValidIdentity(identity) {
  return IDENTITY_RE.test(identity ?? '');
}

export function isValidMessageId(msgId) {
  return MESSAGE_ID_RE.test(msgId ?? '');
}

export function newMessageId() {
  const time = Date.now().toString(36);
  const random = globalThis.crypto?.randomUUID?.().replaceAll('-', '').slice(0, 10)
    ?? Math.random().toString(36).slice(2, 12);
  return `m-${time}-${random}`;
}

export class ProtocolError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Validate a durable message envelope sent by a client.
 * @param {unknown} value candidate envelope
 * @param {{now?: number}} [options]
 * @returns {{ok: true, envelope: object} | {ok: false, code: string, message: string}}
 */
export function validateEnvelope(value, options = {}) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, code: 'envelope-invalid', message: 'message must be an object' };
  }
  const now = options.now ?? Date.now();
  const msg = value;

  if (msg.v !== PROTOCOL_VERSION) {
    return { ok: false, code: 'version-unsupported', message: `expected v=${PROTOCOL_VERSION}` };
  }
  const to = msg.to;
  const from = msg.from;
  if (!isValidIdentity(to)) {
    return { ok: false, code: 'target-invalid', message: 'to must be a role:identifier identity' };
  }
  if (!isValidIdentity(from)) {
    return { ok: false, code: 'source-invalid', message: 'from must be a role:identifier identity' };
  }
  if (identityRole(to) === 'cli') {
    return { ok: false, code: 'target-invalid', message: 'cli is not a message target' };
  }
  if (msg.kind !== 'text') {
    return { ok: false, code: 'kind-unsupported', message: 'only kind="text" is supported in v1' };
  }
  if (typeof msg.text !== 'string' || msg.text.trim().length === 0) {
    return { ok: false, code: 'text-empty', message: 'text must be a non-empty string' };
  }
  if (msg.text.length > MAX_TEXT_CHARS) {
    return { ok: false, code: 'text-too-large', message: `text must be <= ${MAX_TEXT_CHARS} characters` };
  }
  if (msg.msg_id !== undefined && !isValidMessageId(msg.msg_id)) {
    return { ok: false, code: 'msg-id-invalid', message: 'msg_id has an unsupported shape' };
  }
  let ttlMs = msg.ttl_ms;
  if (ttlMs !== undefined) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 30 * 24 * 60 * 60 * 1000) {
      return { ok: false, code: 'ttl-invalid', message: 'ttl_ms must be a positive integer <= 30 days' };
    }
  } else {
    ttlMs = 24 * 60 * 60 * 1000;
  }
  if (msg.meta !== undefined && (msg.meta === null || typeof msg.meta !== 'object' || Array.isArray(msg.meta))) {
    return { ok: false, code: 'meta-invalid', message: 'meta must be an object when present' };
  }
  return {
    ok: true,
    envelope: {
      v: PROTOCOL_VERSION,
      msg_id: msg.msg_id ?? newMessageId(),
      from,
      to,
      kind: 'text',
      text: msg.text,
      ttl_ms: ttlMs,
      created_at: new Date(now).toISOString(),
      meta: msg.meta ?? {},
    },
  };
}

/** Encode one length-prefixed frame. */
export function encodeFrame(value) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  if (payload.length > MAX_FRAME_BYTES) {
    throw new ProtocolError('frame-too-large', `frame exceeds ${MAX_FRAME_BYTES} bytes`);
  }
  const head = Buffer.alloc(4);
  head.writeUInt32LE(payload.length, 0);
  return Buffer.concat([head, payload]);
}

/**
 * Incremental frame decoder. Feed chunks, receive complete JSON values.
 * @returns {{push: (chunk: Buffer) => unknown[], pendingBytes: () => number}}
 */
export function createFrameDecoder() {
  let buffer = Buffer.alloc(0);
  return {
    push(chunk) {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      const frames = [];
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (length > MAX_FRAME_BYTES) {
          throw new ProtocolError('frame-too-large', `peer frame length ${length} exceeds limit`);
        }
        if (buffer.length < length + 4) break;
        const payload = buffer.subarray(4, length + 4);
        buffer = buffer.subarray(length + 4);
        let value;
        try {
          value = JSON.parse(payload.toString('utf8'));
        } catch {
          throw new ProtocolError('frame-invalid-json', 'peer frame is not valid JSON');
        }
        frames.push(value);
      }
      return frames;
    },
    pendingBytes: () => buffer.length,
  };
}

/** Constant-time-ish comparison for the shared pairing token. */
export function tokenEquals(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length !== right.length || left.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

/** Build a stable, human-readable identity for a DSH session. */
export function dshIdentity(sessionId) {
  return `dsh:${sessionId}`;
}

/** Build a stable identity for a Codex thread. */
export function codexIdentity(threadId) {
  return `codex:${threadId}`;
}
