// Thin receiver side of the core's authoritative claim/begin/outcome protocol.
// Scoped clients cannot call these operator RPCs or supply this lease proof.
import crypto from 'node:crypto';
import { UUID_RE } from './queue-inbox.mjs';
import { clientRequestContext } from './client-peer.mjs';

const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const noCallCodes = new Set(['client-grant-revoked', 'client-grant-expired', 'client-request-cancelled',
  'client-request-expired', 'client-target-unpaired', 'client-target-not-allowed',
  'client-grant-submit-budget-exhausted', 'client-claim-expired', 'client-begin-target-unpaired']);
const outcomeCodes = new Set(['native-output-not-confirmed', 'native-command-uncertain', 'interrupted-submission-no-retry',
  'message-expired', 'receiver-disabled-or-expired', 'rate-limit', 'cooldown', 'BUSY_OR_DISABLED_BEFORE_SUBMIT']);
export const clientRequestsSupported = (client) => client.welcomeInfo?.capabilities?.client_requests_v1 === true;

export function clientDispatchProof(value) {
  if (!UUID_RE.test(value?.lease_id ?? '') || !/^[a-f0-9]{32,128}$/i.test(value?.fencing_token ?? '')) {
    fail('CLIENT_DISPATCH_RECEIPT_INVALID');
  }
  return { lease_id: value.lease_id, fencing_token: value.fencing_token };
}

async function rpc(client, frame, expected) {
  let result;
  try { result = await client.request(frame); }
  catch (error) {
    // A policy refusal is not a Hub outage. Network failures keep their original
    // transport type so the existing connection backoff remains applicable.
    if (typeof error.code === 'string' && /^client-/.test(error.code)) fail(error.code);
    throw error;
  }
  if (result?.type !== expected || result.ok !== true) {
    fail(typeof result?.code === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,119}$/.test(result.code)
      ? result.code : 'CLIENT_DISPATCH_RECEIPT_INVALID');
  }
  return result;
}

export async function postClientOutcome(client, config, entry) {
  if (!clientRequestsSupported(client)) fail('CLIENT_REQUEST_PROTOCOL_REQUIRED');
  const proof = clientDispatchProof(entry.client_dispatch);
  if (!['NATIVE_QUEUED', 'UNCERTAIN', 'NOT_SUBMITTED'].includes(entry.status)) fail('CLIENT_OUTCOME_LOCAL_STATE_INVALID');
  const response = await rpc(client, { type: 'client-outcome',
    client_identity: entry.client_identity, client_request_id: entry.client_request_id,
    target_identity: 'codex:' + config.thread_id, request_msg_id: entry.msg_id,
    ...proof, status: entry.status, native_queue_id: entry.native_queue_id ?? null,
    reason: outcomeCodes.has(entry.reason) ? entry.reason : entry.reason ? 'NATIVE_OUTCOME_UNCERTAIN' : null }, 'client-outcome-result');
  const request = response.request;
  if (request?.request_id !== entry.client_request_id || request.client_identity !== entry.client_identity ||
      request.target_identity !== 'codex:' + config.thread_id || request.request_msg_id !== entry.msg_id ||
      entry.status === 'NATIVE_QUEUED' && request.native_queue_id !== entry.native_queue_id) fail('CLIENT_DISPATCH_RECEIPT_MISMATCH');
  return { state: request.state, native_queue_id: request.native_queue_id, native_outcome_at: request.native_outcome_at ?? null };
}

export function clientDispatchHooks({ client, config, message, isReady = () => true, now = Date.now }) {
  const context = clientRequestContext(message), target = 'codex:' + config.thread_id;
  if (message.to !== target) fail('CLIENT_DISPATCH_TARGET_MISMATCH');
  let dispatch = null;
  const noNative = async () => {
    await postClientOutcome(client, config, { ...context, msg_id: message.msg_id,
      client_dispatch: dispatch, status: 'NOT_SUBMITTED', reason: 'BUSY_OR_DISABLED_BEFORE_SUBMIT' });
    return { ok: false, reason: 'BUSY_OR_DISABLED_BEFORE_SUBMIT' };
  };
  const matches = (value) => value?.request_id === context.client_request_id &&
    value.client_identity === message.from && value.target_identity === target && value.request_msg_id === message.msg_id;
  return {
    async beforeNative() {
      if (!clientRequestsSupported(client)) fail('CLIENT_REQUEST_PROTOCOL_REQUIRED');
      if (!isReady()) return { ok: false, reason: 'BUSY_OR_DISABLED_BEFORE_SUBMIT' };
      try {
        const claim = await rpc(client, { type: 'client-claim', client_identity: message.from,
          client_request_id: context.client_request_id, target_identity: target, request_msg_id: message.msg_id,
          claim_lease_ms: 30000, owner_identity: target,
          ...(config.binding_epoch ? { binding_epoch: config.binding_epoch } : {}) }, 'client-claim-result');
        if (!matches(claim.request) || claim.request.state !== 'CLAIMED' || claim.lease?.owner_identity !== target ||
            Date.parse(claim.lease.expires_at) <= now() || !Number.isFinite(Date.parse(claim.lease.expires_at)) ||
            claim.request.body_sha256 !== crypto.createHash('sha256').update(message.text).digest('hex')) fail('CLIENT_DISPATCH_RECEIPT_MISMATCH');
        dispatch = clientDispatchProof({ lease_id: claim.lease.id, fencing_token: claim.lease.fencing_token });
        if (!isReady()) return noNative();
        const begun = await rpc(client, { type: 'client-begin-submit', client_identity: message.from,
          client_request_id: context.client_request_id, request_msg_id: message.msg_id, target_identity: target, ...dispatch }, 'client-begin-submit-result');
        if (!matches(begun.request) || begun.request.state !== 'SUBMITTING' || begun.lease?.id !== dispatch.lease_id ||
            begun.lease.fencing_token !== dispatch.fencing_token) fail('CLIENT_DISPATCH_RECEIPT_MISMATCH');
        if (!isReady()) return noNative();
        return { ok: true, dispatch };
      } catch (error) {
        if (noCallCodes.has(error.code)) return { ok: false, reason: error.code };
        throw error;
      }
    },
    async onNativeOutcome(entry) {
      return postClientOutcome(client, config, { ...entry, client_dispatch: entry.client_dispatch ?? dispatch });
    },
  };
}
