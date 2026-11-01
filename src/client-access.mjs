// Restricted local client access for dot-like peers.
//
// A client is deliberately not an adapter/operator identity. It can only send
// exact-target requests under a local scoped grant, read its own request state,
// read replies, and cancel before the submit boundary. Tokens, full history and
// global operator operations never cross this module's public output.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { identityRole, isValidIdentity, isValidMessageId } from './protocol.mjs';
import { writeJsonAtomic } from './runtime.mjs';

export const CLIENT_SCHEMA_VERSION = 1;
export const CLIENT_ID_RE = /^client:dot-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const GRANT_ID_RE = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const TURN_ID_RE = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const ACTIVE_REQUEST_STATES = new Set(['SUBMITTING', 'QUEUED', 'DELIVERED', 'CLAIMED', 'NATIVE_QUEUED', 'UNCERTAIN']);

export class ClientAccessError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ClientAccessError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new ClientAccessError(code, message, details);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function isValidClientIdentity(value) {
  return typeof value === 'string' && CLIENT_ID_RE.test(value);
}

export function clientPaths(runtimeDir) {
  const root = path.resolve(runtimeDir);
  const clients = path.join(root, 'clients');
  return {
    root,
    clients,
    grants: path.join(clients, 'grants'),
    secrets: path.join(clients, 'secrets'),
    requests: path.join(clients, 'requests'),
    replies: path.join(clients, 'replies'),
    grantFile: (grantId) => path.join(clients, 'grants', `${grantId}.json`),
    secretFile: (grantId) => path.join(clients, 'secrets', `${grantId}.secret`),
    requestFile: (clientIdentity, requestId) => path.join(
      clients, 'requests', `${sha256(`${clientIdentity}\u0000${requestId}`)}.json`,
    ),
    replyFile: (clientIdentity, requestId) => path.join(
      clients, 'replies', `${sha256(`${clientIdentity}\u0000${requestId}`)}.json`,
    ),
  };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

function constantTimeHexEqual(left, right) {
  const a = Buffer.from(String(left ?? ''), 'utf8');
  const b = Buffer.from(String(right ?? ''), 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

function clientIdentityFromInput(value) {
  if (isValidClientIdentity(value)) return value;
  fail('client-identity-invalid', 'client identity must be client:dot-<uuid>', { client_identity: value ?? null });
}

function targetsFromInput(targets) {
  if (!Array.isArray(targets) || targets.length === 0) fail('client-targets-invalid', 'at least one exact target is required');
  const result = [];
  for (const target of targets) {
    if (typeof target !== 'string' || !isValidIdentity(target)) fail('client-target-invalid', 'target must be an exact role:id');
    const role = identityRole(target);
    if (role !== 'dsh' && role !== 'codex') fail('client-target-invalid', 'client target must be dsh or codex');
    if (!result.includes(target)) result.push(target);
  }
  if (result.length > 16) fail('client-targets-invalid', 'too many targets in one grant');
  return result.sort();
}

function readGrant(runtimeDir, grantId) {
  if (typeof grantId !== 'string' || !GRANT_ID_RE.test(grantId)) fail('client-grant-invalid', 'grant_id is invalid');
  const file = clientPaths(runtimeDir).grantFile(grantId);
  const grant = readJson(file);
  if (grant === undefined) fail('client-grant-missing', 'client grant not found', { grant_id: grantId });
  if (grant.v !== CLIENT_SCHEMA_VERSION || grant.grant_id !== grantId || !isValidClientIdentity(grant.client_identity)
      || !Array.isArray(grant.targets) || !Array.isArray(grant.allowed_operations)
      || typeof grant.credential_sha256 !== 'string') {
    fail('client-grant-corrupt', 'client grant is invalid', { grant_id: grantId });
  }
  return { grant, file };
}

export function createClientGrant({
  runtimeDir, clientIdentity, targets, leaseMs = 120_000, ttlMs = 24 * 60 * 60 * 1000,
  maxPending = 4, maxTextBytes = 12_000, maxRequests = 32, maxSubmits = 16, now = Date.now(),
} = {}) {
  const identity = clientIdentityFromInput(clientIdentity);
  const allowedTargets = targetsFromInput(targets);
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 15 * 60 * 1000) fail('client-lease-invalid', 'lease must be 1s..15m');
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 30 * 24 * 60 * 60 * 1000) fail('client-ttl-invalid', 'grant ttl must be 1m..30d');
  if (!Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 16) fail('client-max-pending-invalid', 'max_pending must be 1..16');
  if (!Number.isSafeInteger(maxTextBytes) || maxTextBytes < 1 || maxTextBytes > 64 * 1024) fail('client-max-text-invalid', 'max_text_bytes must be <= 64KiB');
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 10_000) fail('client-max-requests-invalid', 'max_requests must be 1..10000');
  if (!Number.isSafeInteger(maxSubmits) || maxSubmits < 1 || maxSubmits > 10_000) fail('client-max-submits-invalid', 'max_submits must be 1..10000');
  const paths = clientPaths(runtimeDir);
  ensureDir(paths.grants); ensureDir(paths.secrets); ensureDir(paths.requests); ensureDir(paths.replies);
  const grantId = crypto.randomUUID();
  const secret = crypto.randomBytes(32).toString('hex');
  const grant = {
    v: CLIENT_SCHEMA_VERSION,
    grant_id: grantId,
    client_identity: identity,
    targets: allowedTargets,
    allowed_operations: ['request', 'status-own', 'resume', 'cancel-own', 'ping'],
    mailbox: identity,
    lease_ms: leaseMs,
    ttl_ms: ttlMs,
    max_pending: maxPending,
    max_text_bytes: maxTextBytes,
    max_requests: maxRequests,
    max_submits: maxSubmits,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttlMs).toISOString(),
    revoked_at: null,
    credential_sha256: sha256(secret),
  };
  const secretFile = paths.secretFile(grantId);
  try {
    fs.writeFileSync(secretFile, `${secret}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    writeJsonAtomic(paths.grantFile(grantId), grant);
  } catch (error) {
    try { fs.rmSync(secretFile, { force: true }); } catch { /* best effort */ }
    fail('client-grant-write-failed', String(error?.message ?? error));
  }
  return {
    ok: true,
    grant_id: grantId,
    client_identity: identity,
    targets: allowedTargets,
    mailbox: identity,
    lease_ms: leaseMs,
    expires_at: grant.expires_at,
    credential_file: secretFile,
  };
}

export function loadClientGrant({ runtimeDir, grantId, now = Date.now(), allowExpired = false } = {}) {
  const { grant } = readGrant(runtimeDir, grantId);
  if (!allowExpired) {
    if (grant.revoked_at !== null) fail('client-grant-revoked', 'client grant was revoked', { grant_id: grantId });
    if (Date.parse(grant.expires_at) <= now) fail('client-grant-expired', 'client grant expired', { grant_id: grantId });
  }
  return grant;
}

export function authenticateClientGrant({ runtimeDir, grantId, clientIdentity, credential, now = Date.now() } = {}) {
  const grant = loadClientGrant({ runtimeDir, grantId, now });
  if (!isValidClientIdentity(clientIdentity) || clientIdentity !== grant.client_identity) {
    fail('client-auth-failed', 'client identity does not match grant');
  }
  if (typeof credential !== 'string' || credential.length < 32
      || !constantTimeHexEqual(sha256(credential), grant.credential_sha256)) {
    fail('client-auth-failed', 'client credential rejected');
  }
  return grant;
}

export function revokeClientGrant({ runtimeDir, grantId, reason = '', now = Date.now() } = {}) {
  const { grant } = readGrant(runtimeDir, grantId);
  if (grant.revoked_at !== null) return { ok: true, idempotent: true, grant };
  const updated = { ...grant, revoked_at: new Date(now).toISOString(), revocation_reason: String(reason).slice(0, 500) };
  writeJsonAtomic(clientPaths(runtimeDir).grantFile(grantId), updated);
  return { ok: true, idempotent: false, grant: updated };
}

function requestFingerprint({ target, text }) {
  return sha256(JSON.stringify({ target, body: sha256(text) }));
}

function ensureRequestWithinGrant(grant, { target, text, pathNow }) {
  if (Date.parse(grant.expires_at) <= pathNow) fail('client-grant-expired', 'client grant expired');
  if (!grant.targets.includes(target)) fail('client-target-not-allowed', 'target is not in this grant', { target });
  if (typeof text !== 'string' || text.length === 0) fail('client-request-empty', 'request text is required');
  if (Buffer.byteLength(text, 'utf8') > grant.max_text_bytes) fail('client-request-too-large', 'request body exceeds grant limit');
}

export function beginClientRequest({
  runtimeDir, grant, clientIdentity, requestId, target, text, ttlMs,
  now = Date.now(),
} = {}) {
  if (!isValidClientIdentity(clientIdentity) || clientIdentity !== grant.client_identity) fail('client-auth-failed', 'client identity mismatch');
  if (typeof requestId !== 'string' || !isValidMessageId(requestId)) fail('client-request-id-invalid', 'request_id has invalid shape');
  if (typeof target !== 'string' || !isValidIdentity(target)) fail('client-request-target-invalid', 'target must be role:id');
  ensureRequestWithinGrant(grant, { target, text, pathNow: now });
  const leaseMs = grant.lease_ms;
  const paths = clientPaths(runtimeDir);
  ensureDir(paths.requests);
  const file = paths.requestFile(clientIdentity, requestId);
  const fingerprint = requestFingerprint({ target, text });
  const existed = fs.existsSync(file);
  const existing = readJson(file);
  if (existed && existing === undefined) {
    fail('client-request-corrupt', 'existing request record is corrupt; preserving it', { request_id: requestId, file });
  }
  if (existing !== undefined) {
    if (existing.client_identity !== clientIdentity || existing.request_id !== requestId) fail('client-request-corrupt', 'request record identity mismatch');
    if (existing.grant_id !== grant.grant_id) fail('client-request-scope-mismatch', 'request_id belongs to another grant');
    if (existing.target_identity === target && existing.body_sha256 === sha256(text)) {
      return { ok: true, idempotent: true, request: existing, file };
    }
    fail('client-request-conflict', 'request_id already exists with different target/body', { request_id: requestId });
  }
  const allForGrant = listAllClientRequests({ runtimeDir, clientIdentity })
    .filter((request) => request.grant_id === grant.grant_id);
  if (allForGrant.length >= (Number.isSafeInteger(grant.max_requests) ? grant.max_requests : 32)) {
    fail('client-grant-request-budget-exhausted', 'grant request budget exhausted', { grant_id: grant.grant_id, max_requests: grant.max_requests ?? 32 });
  }
  const active = allForGrant.filter((request) => ACTIVE_REQUEST_STATES.has(request.state));
  if (active.length >= grant.max_pending) fail('client-request-limit', 'too many active requests for this grant', { max_pending: grant.max_pending });
  const request = {
    v: CLIENT_SCHEMA_VERSION,
    request_id: requestId,
    client_identity: clientIdentity,
    grant_id: grant.grant_id,
    target_identity: target,
    msg_id: null,
    state: 'SUBMITTING',
    body_sha256: sha256(text),
    body_bytes: Buffer.byteLength(text, 'utf8'),
    request_fingerprint: fingerprint,
    grant_expires_at: grant.expires_at,
    lease: {
      id: crypto.randomUUID(),
      fencing_token: crypto.randomBytes(16).toString('hex'),
      expires_at: null,
    },
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + Math.min(ttlMs ?? grant.ttl_ms, grant.ttl_ms)).toISOString(),
    submitted_at: null,
    cancelled_at: null,
    uncertain_at: null,
    reply: { reply_msg_id: null, body_sha256: null, bytes: null, recorded_at: null },
  };
  writeJsonAtomic(file, request);
  return { ok: true, idempotent: false, request, file };
}

export function getClientRequest({ runtimeDir, clientIdentity, requestId, grantId = null } = {}) {
  if (!isValidClientIdentity(clientIdentity)) fail('client-identity-invalid', 'client identity invalid');
  if (typeof requestId !== 'string' || !isValidMessageId(requestId)) fail('client-request-id-invalid', 'request_id invalid');
  const file = clientPaths(runtimeDir).requestFile(clientIdentity, requestId);
  const request = readJson(file);
  if (request === undefined) fail('client-request-missing', 'request not found', { request_id: requestId });
  if (grantId !== null && request.grant_id !== grantId) fail('client-request-scope-mismatch', 'request belongs to another grant', { request_id: requestId });
  return { request, file };
}

export function listClientRequests({ runtimeDir, clientIdentity, now = Date.now(), limit = 100 } = {}) {
  if (!isValidClientIdentity(clientIdentity)) fail('client-identity-invalid', 'client identity invalid');
  const dir = clientPaths(runtimeDir).requests;
  const result = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { entries = []; }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const request = readJson(path.join(dir, entry.name));
    if (request?.client_identity !== clientIdentity) continue;
    result.push(request);
  }
  result.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  return { ok: true, requests: result.slice(0, Math.max(0, Math.min(Number(limit) || 100, 500))), now };
}

/** Internal complete scan for budgets; never use the public pagination window. */
function listAllClientRequests({ runtimeDir, clientIdentity }) {
  const dir = clientPaths(runtimeDir).requests;
  const result = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { entries = []; }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const request = readJson(path.join(dir, entry.name));
    if (request?.client_identity === clientIdentity) result.push(request);
  }
  return result;
}

/** Expire only never-submitted active requests; submitted/native/reply states never downgrade. */
export function expireUnsubmittedClientRequests({ runtimeDir, now = Date.now() } = {}) {
  const dir = clientPaths(runtimeDir).requests;
  const expired = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { entries = []; }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(dir, entry.name);
    const request = readJson(file);
    if (request === undefined || request === null) continue;
    if (request.submitted_at !== null) continue;
    if (!['QUEUED', 'DELIVERED', 'CLAIMED'].includes(request.state)) continue;
    const expiresAt = Date.parse(request.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt > now) continue;
    writeJsonAtomic(file, {
      ...request, state: 'EXPIRED', expired_at: new Date(now).toISOString(), expired_code: 'client-request-expired',
    });
    expired.push({ request_id: request.request_id, client_identity: request.client_identity, msg_id: request.msg_id });
  }
  return { ok: true, expired };
}

function updateRequest(runtimeDir, clientIdentity, requestId, mutate) {
  const { request, file } = getClientRequest({ runtimeDir, clientIdentity, requestId });
  const next = mutate({ ...request });
  writeJsonAtomic(file, next);
  return { request: next, file };
}

export function claimClientRequest({
  runtimeDir, clientIdentity, requestId, targetIdentity, requestMsgId,
  leaseMs = 30_000, ownerIdentity = null, leaseId = null, fencingToken = null, receiverNonce = null, bindingEpoch = null, now = Date.now(),
} = {}) {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 15 * 60 * 1000) fail('client-claim-lease-invalid', 'claim lease must be 1s..15m');
  return updateRequest(runtimeDir, clientIdentity, requestId, (request) => {
    if (Date.parse(request.expires_at) <= now) fail('client-request-expired', 'request expired before claim');
    if (request.grant_expires_at !== undefined && request.grant_expires_at !== null && Date.parse(request.grant_expires_at) <= now) {
      fail('client-grant-expired', 'grant expired before claim');
    }
    const { grant } = readGrant(runtimeDir, request.grant_id);
    if (grant.revoked_at !== null) fail('client-grant-revoked', 'grant revoked before claim');
    if (!grant.targets.includes(request.target_identity)) fail('client-target-not-allowed', 'request target no longer in grant');
    if (request.target_identity !== targetIdentity) fail('client-claim-target-mismatch', 'claim target mismatch');
    if (ownerIdentity !== null && ownerIdentity !== request.target_identity) fail('client-claim-owner-mismatch', 'claim owner does not match the exact target');
    if (bindingEpoch !== null && request.target_binding_epoch !== bindingEpoch) fail('client-claim-epoch-mismatch', 'request target binding epoch does not match');
    if (request.msg_id !== requestMsgId) fail('client-claim-message-mismatch', 'claim request msg_id mismatch');
    if (request.state === 'CLAIMED' && leaseId !== null && request.claim?.lease_id === leaseId && request.claim?.fencing_token === fencingToken) {
      return request;
    }
    if (request.state === 'CLAIMED') {
      const claimExpired = request.claim === null || request.claim === undefined
        || !Number.isFinite(Date.parse(request.claim.expires_at))
        || Date.parse(request.claim.expires_at) <= now;
      if (!claimExpired || request.submitted_at !== null) {
        fail('client-claim-unavailable', 'request is claimed by a live lease', { state: request.state });
      }
      // An expired claim is safe to reclaim only before begin. The old fence is
      // retained nowhere and an old worker's begin will fail its fence check.
    } else if (!['QUEUED', 'DELIVERED'].includes(request.state)) {
      fail('client-claim-unavailable', `request is ${request.state}`, { state: request.state });
    }
    return {
      ...request,
      state: 'CLAIMED',
      claim: {
        lease_id: leaseId ?? crypto.randomUUID(),
        fencing_token: fencingToken ?? crypto.randomBytes(16).toString('hex'),
        owner_identity: ownerIdentity,
        receiver_nonce: receiverNonce,
        target_binding_epoch: bindingEpoch ?? request.target_binding_epoch ?? null,
        claimed_at: new Date(now).toISOString(),
        expires_at: new Date(now + leaseMs).toISOString(),
      },
    };
  });
}

export function beginClientSubmit({
  runtimeDir, clientIdentity, requestId, leaseId, fencingToken, requestMsgId = null, targetIdentity = null, verifyTarget = null, submissionTimeoutMs = null, now = Date.now(),
} = {}) {
  return updateRequest(runtimeDir, clientIdentity, requestId, (request) => {
    if (request.state === 'SUBMITTING' && request.claim?.lease_id === leaseId && request.claim?.fencing_token === fencingToken) return request;
    if (request.state !== 'CLAIMED') fail('client-begin-unavailable', `request is ${request.state}`, { state: request.state });
    if (requestMsgId !== null && request.msg_id !== requestMsgId) fail('client-begin-message-mismatch', 'begin request msg_id mismatch');
    if (targetIdentity !== null && request.target_identity !== targetIdentity) fail('client-begin-target-mismatch', 'begin target mismatch');
    if (request.claim?.lease_id !== leaseId || request.claim?.fencing_token !== fencingToken) {
      fail('client-begin-fence-mismatch', 'claim lease/fence does not match');
    }
    if (Date.parse(request.claim.expires_at) <= now) fail('client-claim-expired', 'claim lease expired before begin');
    if (Date.parse(request.expires_at) <= now) fail('client-request-expired', 'request expired before begin');
    const grant = loadClientGrant({ runtimeDir, grantId: request.grant_id, now });
    const submitted = listAllClientRequests({ runtimeDir, clientIdentity })
      .filter((entry) => entry.grant_id === request.grant_id && (entry.submitted_at !== null || ['SUBMITTING', 'NATIVE_QUEUED', 'REPLY_READY'].includes(entry.state)));
    if (submitted.length >= (Number.isSafeInteger(grant.max_submits) ? grant.max_submits : 16)) {
      fail('client-grant-submit-budget-exhausted', 'grant submit budget exhausted', { grant_id: grant.grant_id, max_submits: grant.max_submits ?? 16 });
    }
    if (typeof verifyTarget === 'function') {
      const checked = verifyTarget(request);
      if (checked === null || typeof checked !== 'object' || checked.ok !== true) {
        fail(checked?.code ?? 'client-begin-target-rejected', checked?.message ?? 'target is not valid at native submit boundary');
      }
    }
    const effectiveSubmissionTimeoutMs = Number.isSafeInteger(submissionTimeoutMs) && submissionTimeoutMs > 0
      ? Math.min(submissionTimeoutMs, Math.max(1_000, Date.parse(request.expires_at) - now))
      : Math.min(grant.lease_ms, Math.max(1_000, Date.parse(request.expires_at) - now));
    return { ...request, state: 'SUBMITTING', submitted_at: new Date(now).toISOString(), submission_deadline_at: new Date(now + effectiveSubmissionTimeoutMs).toISOString() };
  });
}

export function recordClientOutcome({
  runtimeDir, clientIdentity, requestId, outcome, nativeQueueId = null,
  leaseId = null, fencingToken = null, code = null, requestMsgId = null, targetIdentity = null, now = Date.now(),
} = {}) {
  if (!['NATIVE_QUEUED', 'UNCERTAIN', 'NOT_SUBMITTED'].includes(outcome)) fail('client-outcome-invalid', 'outcome must be NATIVE_QUEUED, UNCERTAIN or NOT_SUBMITTED');
  return updateRequest(runtimeDir, clientIdentity, requestId, (request) => {
    if (requestMsgId !== null && request.msg_id !== requestMsgId) fail('client-outcome-message-mismatch', 'outcome request msg_id mismatch');
    if (targetIdentity !== null && request.target_identity !== targetIdentity) fail('client-outcome-target-mismatch', 'outcome target mismatch');
    if (request.state === 'NATIVE_QUEUED' || request.state === 'REPLY_READY') {
      if (outcome === 'NATIVE_QUEUED' && request.native_queue_id === nativeQueueId) return request;
      if (outcome === 'UNCERTAIN') return request;
      return request;
    }
    if (request.state === 'CANCELLED' || request.state === 'FAILED' || request.state === 'EXPIRED') {
      fail('client-outcome-too-late', `request is ${request.state}`, { state: request.state });
    }
    if (leaseId === null || fencingToken === null) fail('client-outcome-fence-required', 'claim lease/fence required for the native outcome');
    if (request.claim?.lease_id !== leaseId || request.claim?.fencing_token !== fencingToken) {
      fail('client-outcome-fence-mismatch', 'claim lease/fence does not match');
    }
    if (outcome === 'NOT_SUBMITTED') {
      return { ...request, state: 'NOT_SUBMITTED', not_submitted_at: new Date(now).toISOString(), not_submitted_reason: String(code ?? 'native-not-submitted').slice(0, 200), claim: null };
    }
    if (outcome === 'UNCERTAIN') {
      return { ...request, state: 'UNCERTAIN', uncertain_at: new Date(now).toISOString(), uncertain_code: String(code ?? 'native-uncertain').slice(0, 200) };
    }
    if (typeof nativeQueueId !== 'string' || nativeQueueId.length === 0) fail('client-outcome-queue-id-required', 'NATIVE_QUEUED requires native_queue_id');
    if (request.native_queue_id !== undefined && request.native_queue_id !== null && request.native_queue_id !== nativeQueueId) {
      fail('client-outcome-native-conflict', 'different native_queue_id already recorded');
    }
    return { ...request, state: 'NATIVE_QUEUED', native_queue_id: nativeQueueId, native_outcome_at: new Date(now).toISOString() };
  });
}

export function markClientRequestQueued({ runtimeDir, clientIdentity, requestId, msgId, targetBindingEpoch = null, now = Date.now() } = {}) {
  if (typeof msgId !== 'string' || !isValidMessageId(msgId)) fail('client-msg-id-invalid', 'msg_id invalid');
  return updateRequest(runtimeDir, clientIdentity, requestId, (request) => {
    if (request.state !== 'SUBMITTING') fail('client-request-state-invalid', `cannot queue request in ${request.state}`);
    return { ...request, msg_id: msgId, state: 'QUEUED', queued_at: new Date(now).toISOString(), target_binding_epoch: targetBindingEpoch };
  });
}

export function markClientRequestDelivered({ runtimeDir, clientIdentity, requestId, now = Date.now() } = {}) {
  return updateRequest(runtimeDir, clientIdentity, requestId, (request) => {
    const deliveredAt = request.hub_delivered_at ?? new Date(now).toISOString();
    if (['DELIVERED', 'CLAIMED', 'SUBMITTING', 'NATIVE_QUEUED', 'REPLY_READY', 'UNCERTAIN', 'CANCELLED', 'FAILED', 'EXPIRED'].includes(request.state)) {
      return { ...request, hub_delivered_at: deliveredAt };
    }
    if (request.state !== 'QUEUED') fail('client-request-state-invalid', `cannot mark delivered from ${request.state}`);
    return { ...request, state: 'DELIVERED', hub_delivered_at: deliveredAt, delivered_at: deliveredAt };
  });
}

export function markClientRequestUncertain({ runtimeDir, clientIdentity, requestId, code = 'delivery-uncertain', now = Date.now() } = {}) {
  return updateRequest(runtimeDir, clientIdentity, requestId, (request) => {
    if (['UNCERTAIN', 'FAILED', 'CANCELLED', 'REPLY_READY', 'DELIVERED', 'NATIVE_QUEUED', 'NOT_SUBMITTED'].includes(request.state)) return request;
    return { ...request, state: 'UNCERTAIN', uncertain_at: new Date(now).toISOString(), uncertain_code: String(code).slice(0, 200) };
  });
}

export function cancelClientRequest({ runtimeDir, clientIdentity, requestId, grantId = null, now = Date.now() } = {}) {
  return updateRequest(runtimeDir, clientIdentity, requestId, (request) => {
    if (grantId !== null && request.grant_id !== grantId) {
      fail('client-request-scope-mismatch', 'request belongs to another grant', { request_id: requestId });
    }
    if (request.state === 'CANCELLED') return request;
    if (request.submitted_at !== null || !['QUEUED', 'DELIVERED', 'CLAIMED', 'SUBMITTING'].includes(request.state)) {
      fail('client-cancel-too-late', 'request already crossed the submit boundary', { state: request.state });
    }
    return { ...request, state: 'CANCELLED', cancelled_at: new Date(now).toISOString() };
  });
}

export function recordClientReply({
  runtimeDir, clientIdentity, requestId, targetIdentity, requestMsgId,
  turnId, body, bodySha256, now = Date.now(),
} = {}) {
  if (!isValidClientIdentity(clientIdentity)) fail('client-identity-invalid', 'client identity invalid');
  if (typeof body !== 'string' || body.length === 0) fail('client-reply-empty', 'reply body required');
  if (Buffer.byteLength(body, 'utf8') > 256 * 1024) fail('client-reply-too-large', 'reply body exceeds 256KiB');
  if (typeof turnId !== 'string' || !TURN_ID_RE.test(turnId)) fail('client-reply-turn-invalid', 'turn_id must be UUID');
  const digest = sha256(body);
  if (bodySha256 !== undefined && String(bodySha256).toLowerCase() !== digest) fail('client-reply-hash-mismatch', 'reply body hash mismatch');
  const { request, file: requestFile } = getClientRequest({ runtimeDir, clientIdentity, requestId });
  if (request.target_identity !== targetIdentity) fail('client-reply-target-mismatch', 'reply target does not match request');
  if (request.msg_id !== requestMsgId) fail('client-reply-message-mismatch', 'reply request msg_id mismatch');
  const paths = clientPaths(runtimeDir);
  ensureDir(paths.replies);
  const replyFile = paths.replyFile(clientIdentity, requestId);
  const existed = fs.existsSync(replyFile);
  const existingReply = readJson(replyFile);
  if (existed && existingReply === undefined) fail('client-reply-corrupt', 'existing reply record is corrupt; preserving it', { request_id: requestId, file: replyFile });
  if (existingReply !== undefined) {
    if (existingReply.request_id !== requestId || existingReply.target_identity !== targetIdentity
        || existingReply.request_msg_id !== requestMsgId
        || existingReply.client_identity !== clientIdentity) {
      fail('client-reply-scope-mismatch', 'existing reply does not match request scope');
    }
    if (existingReply.body_sha256 !== digest) fail('client-reply-conflict', 'different reply body already recorded');
    const next = request.state === 'REPLY_READY' ? request : {
      ...request,
      state: 'REPLY_READY',
      reply: { reply_msg_id: existingReply.reply_msg_id, body_sha256: existingReply.body_sha256, bytes: existingReply.bytes, recorded_at: existingReply.recorded_at },
    };
    if (request.state !== 'REPLY_READY') writeJsonAtomic(requestFile, next);
    return { ok: true, idempotent: true, request: next, reply: existingReply, file: replyFile };
  }
  if (request.state === 'REPLY_READY') fail('client-reply-corrupt', 'reply state exists without reply record; preserving request', { request_id: requestId });
  if (!['DELIVERED', 'NATIVE_QUEUED', 'UNCERTAIN'].includes(request.state)) fail('client-reply-too-early', `request state is ${request.state}`, { state: request.state });
  const replyId = `m-${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
  const reply = {
    v: CLIENT_SCHEMA_VERSION,
    request_id: requestId,
    client_identity: clientIdentity,
    target_identity: targetIdentity,
    request_msg_id: requestMsgId,
    reply_msg_id: replyId,
    turn_id: turnId,
    body,
    body_sha256: digest,
    bytes: Buffer.byteLength(body, 'utf8'),
    recorded_at: new Date(now).toISOString(),
    expires_at: request.expires_at,
  };
  writeJsonAtomic(replyFile, reply);
  const next = {
    ...request,
    state: 'REPLY_READY',
    reply: { reply_msg_id: replyId, body_sha256: digest, bytes: reply.bytes, recorded_at: reply.recorded_at, turn_id: turnId },
  };
  writeJsonAtomic(requestFile, next);
  return { ok: true, idempotent: false, request: next, reply, file: replyFile };
}

/**
 * Mark stale target-submitting requests UNCERTAIN after their finite outcome
 * deadline. The request is never requeued; only an actual outcome can refine it.
 */
export function expireStaleClientSubmissions({ runtimeDir, now = Date.now() } = {}) {
  const dir = clientPaths(runtimeDir).requests;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { entries = []; }
  const expired = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(dir, entry.name);
    const request = readJson(file);
    if (request === undefined || request === null) continue;
    if (request.state !== 'SUBMITTING') continue;
    const deadline = Date.parse(request.submission_deadline_at);
    if (!Number.isFinite(deadline) || deadline > now) continue;
    const next = {
      ...request,
      state: 'UNCERTAIN',
      uncertain_at: new Date(now).toISOString(),
      uncertain_code: 'submission-outcome-timeout',
      submission_timed_out_at: new Date(now).toISOString(),
    };
    writeJsonAtomic(file, next);
    expired.push({ request_id: request.request_id, client_identity: request.client_identity, msg_id: request.msg_id, submission_deadline_at: request.submission_deadline_at });
  }
  return { ok: true, expired };
}
export function resumeClientReply({ runtimeDir, clientIdentity, requestId, grantId = null } = {}) {
  const { request } = getClientRequest({ runtimeDir, clientIdentity, requestId, grantId });
  if (request.state !== 'REPLY_READY') return { ok: true, state: request.state, reply: null };
  const file = clientPaths(runtimeDir).replyFile(clientIdentity, requestId);
  const existed = fs.existsSync(file);
  const reply = readJson(file);
  if (!existed || reply === undefined) fail('client-reply-corrupt', 'reply record missing for REPLY_READY', { request_id: requestId, file });
  return { ok: true, state: request.state, reply };
}