import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createClientGrant, authenticateClientGrant, beginClientRequest, cancelClientRequest,
  markClientRequestQueued, markClientRequestDelivered, claimClientRequest, beginClientSubmit, recordClientOutcome,
  recordClientReply, resumeClientReply, revokeClientGrant, clientPaths, expireStaleClientSubmissions, expireUnsubmittedClientRequests, getClientRequest,
} from '../src/client-access.mjs';

const client = 'client:dot-22222222-2222-4222-8222-222222222222';
const target = 'codex:33333333-3333-4333-8333-333333333333';
const turn = '44444444-4444-4444-8444-444444444444';

function temp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'lab-client-access-')); }

test('scoped grant writes only local secret and authenticates exact identity', () => {
  const root = temp();
  try {
    const created = createClientGrant({ runtimeDir: root, clientIdentity: client, targets: [target], leaseMs: 60_000, ttlMs: 3_600_000 });
    assert.equal(created.client_identity, client);
    assert.equal(created.targets[0], target);
    const secret = fs.readFileSync(created.credential_file, 'utf8').trim();
    assert.ok(secret.length >= 32);
    assert.equal(JSON.stringify(created).includes(secret), false, 'secret must never be returned');
    const grant = authenticateClientGrant({ runtimeDir: root, grantId: created.grant_id, clientIdentity: client, credential: secret });
    assert.equal(grant.grant_id, created.grant_id);
    assert.throws(() => authenticateClientGrant({ runtimeDir: root, grantId: created.grant_id, clientIdentity: client, credential: 'x'.repeat(64) }), (e) => e.code === 'client-auth-failed');
    assert.throws(() => authenticateClientGrant({ runtimeDir: root, grantId: created.grant_id, clientIdentity: 'client:dot-55555555-5555-4555-8555-555555555555', credential: secret }), (e) => e.code === 'client-auth-failed');
    revokeClientGrant({ runtimeDir: root, grantId: created.grant_id, reason: 'test' });
    assert.throws(() => authenticateClientGrant({ runtimeDir: root, grantId: created.grant_id, clientIdentity: client, credential: secret }), (e) => e.code === 'client-grant-revoked');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('request lifecycle is durable/idempotent, cancel is pre-begin, claim/begin/outcome and one-shot reply', () => {
  const root = temp();
  try {
    const created = createClientGrant({ runtimeDir: root, clientIdentity: client, targets: [target] });
    const grant = authenticateClientGrant({ runtimeDir: root, grantId: created.grant_id, clientIdentity: client, credential: fs.readFileSync(created.credential_file, 'utf8').trim() });
    const first = beginClientRequest({ runtimeDir: root, grant, clientIdentity: client, requestId: 'synthetic-request-1', target, text: 'synthetic body' });
    assert.equal(first.request.state, 'SUBMITTING');
    const duplicate = beginClientRequest({ runtimeDir: root, grant, clientIdentity: client, requestId: 'synthetic-request-1', target, text: 'synthetic body' });
    assert.equal(duplicate.idempotent, true);
    assert.throws(() => beginClientRequest({ runtimeDir: root, grant, clientIdentity: client, requestId: 'synthetic-request-1', target, text: 'different body' }), (e) => e.code === 'client-request-conflict');
    cancelClientRequest({ runtimeDir: root, clientIdentity: client, requestId: 'synthetic-request-1' });
    assert.equal(cancelClientRequest({ runtimeDir: root, clientIdentity: client, requestId: 'synthetic-request-1' }).request.state, 'CANCELLED');

    beginClientRequest({ runtimeDir: root, grant, clientIdentity: client, requestId: 'synthetic-request-2', target, text: 'second body' });
    markClientRequestQueued({ runtimeDir: root, clientIdentity: client, requestId: 'synthetic-request-2', msgId: 'm-synthetic-2' });
    assert.equal(cancelClientRequest({ runtimeDir: root, clientIdentity: client, requestId: 'synthetic-request-2' }).request.state, 'CANCELLED');

    beginClientRequest({ runtimeDir: root, grant, clientIdentity: client, requestId: 'synthetic-request-3', target, text: 'third body' });
    const queued = markClientRequestQueued({ runtimeDir: root, clientIdentity: client, requestId: 'synthetic-request-3', msgId: 'm-synthetic-3' });
    assert.equal(queued.request.submitted_at, null);
    const claim = claimClientRequest({ runtimeDir: root, clientIdentity: client, requestId: 'synthetic-request-3', targetIdentity: target, requestMsgId: 'm-synthetic-3', leaseMs: 60_000 });
    assert.equal(claim.request.state, 'CLAIMED');
    const begun = beginClientSubmit({ runtimeDir: root, clientIdentity: client, requestId: 'synthetic-request-3', leaseId: claim.request.claim.lease_id, fencingToken: claim.request.claim.fencing_token });
    assert.ok(begun.request.submitted_at);
    assert.throws(() => cancelClientRequest({ runtimeDir: root, clientIdentity: client, requestId: 'synthetic-request-3' }), (e) => e.code === 'client-cancel-too-late');
    markClientRequestDelivered({ runtimeDir: root, clientIdentity: client, requestId: 'synthetic-request-3' });
    const native = recordClientOutcome({ runtimeDir: root, clientIdentity: client, requestId: 'synthetic-request-3', outcome: 'NATIVE_QUEUED', nativeQueueId: 'native-synthetic-3', leaseId: claim.request.claim.lease_id, fencingToken: claim.request.claim.fencing_token });
    assert.equal(native.request.state, 'NATIVE_QUEUED');
    const reply = recordClientReply({ runtimeDir: root, clientIdentity: client, requestId: 'synthetic-request-3', targetIdentity: target, requestMsgId: 'm-synthetic-3', turnId: turn, body: 'synthetic reply' });
    assert.equal(reply.request.state, 'REPLY_READY');
    assert.equal(reply.reply.body, 'synthetic reply');
    const repeated = recordClientReply({ runtimeDir: root, clientIdentity: client, requestId: 'synthetic-request-3', targetIdentity: target, requestMsgId: 'm-synthetic-3', turnId: turn, body: 'synthetic reply' });
    assert.equal(repeated.idempotent, true);
    assert.equal(repeated.reply.reply_msg_id, reply.reply.reply_msg_id);
    assert.throws(() => recordClientReply({ runtimeDir: root, clientIdentity: client, requestId: 'synthetic-request-3', targetIdentity: target, requestMsgId: 'm-synthetic-3', turnId: turn, body: 'second reply' }), (e) => e.code === 'client-reply-conflict');
    assert.equal(resumeClientReply({ runtimeDir: root, clientIdentity: client, requestId: 'synthetic-request-3' }).reply.body, 'synthetic reply');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('grant budgets, expiry, and corrupt request records fail closed', () => {
  const root = temp();
  try {
    const created = createClientGrant({ runtimeDir: root, clientIdentity: client, targets: [target], maxRequests: 1, maxSubmits: 1, ttlMs: 600_000 });
    const grant = authenticateClientGrant({ runtimeDir: root, grantId: created.grant_id, clientIdentity: client, credential: fs.readFileSync(created.credential_file, 'utf8').trim() });
    beginClientRequest({ runtimeDir: root, grant, clientIdentity: client, requestId: 'budget-1', target, text: 'one' });
    assert.throws(() => beginClientRequest({ runtimeDir: root, grant, clientIdentity: client, requestId: 'budget-2', target, text: 'two' }), (e) => e.code === 'client-grant-request-budget-exhausted');

    const corruptFile = clientPaths(root).requestFile(client, 'corrupt-request');
    fs.mkdirSync(path.dirname(corruptFile), { recursive: true });
    fs.writeFileSync(corruptFile, '{not-json', 'utf8');
    assert.throws(() => beginClientRequest({ runtimeDir: root, grant, clientIdentity: client, requestId: 'corrupt-request', target, text: 'corrupt' }), (e) => e.code === 'client-request-corrupt');
    assert.equal(fs.readFileSync(corruptFile, 'utf8'), '{not-json');

    const expired = createClientGrant({ runtimeDir: root, clientIdentity: client, targets: [target], ttlMs: 60_000, now: 1_000 });
    const expiredGrant = authenticateClientGrant({ runtimeDir: root, grantId: expired.grant_id, clientIdentity: client, credential: fs.readFileSync(expired.credential_file, 'utf8').trim(), now: 1_000 });
    beginClientRequest({ runtimeDir: root, grant: expiredGrant, clientIdentity: client, requestId: 'expiry-1', target, text: 'expiry', now: 1_000 });
    assert.throws(() => claimClientRequest({ runtimeDir: root, clientIdentity: client, requestId: 'expiry-1', targetIdentity: target, requestMsgId: 'm-expiry-1', now: 62_000 }), (e) => e.code === 'client-request-expired');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('NOT_SUBMITTED is terminal, fence-bound, and never becomes a re-delivery', () => {
  const root = temp();
  try {
    const created = createClientGrant({ runtimeDir: root, clientIdentity: client, targets: [target] });
    const grant = authenticateClientGrant({ runtimeDir: root, grantId: created.grant_id, clientIdentity: client, credential: fs.readFileSync(created.credential_file, 'utf8').trim() });
    beginClientRequest({ runtimeDir: root, grant, clientIdentity: client, requestId: 'not-submitted-1', target, text: 'synthetic' });
    markClientRequestQueued({ runtimeDir: root, clientIdentity: client, requestId: 'not-submitted-1', msgId: 'm-not-submitted-1' });
    const claim = claimClientRequest({ runtimeDir: root, clientIdentity: client, requestId: 'not-submitted-1', targetIdentity: target, requestMsgId: 'm-not-submitted-1', ownerIdentity: target });
    assert.throws(() => recordClientOutcome({ runtimeDir: root, clientIdentity: client, requestId: 'not-submitted-1', outcome: 'NOT_SUBMITTED' }), (e) => e.code === 'client-outcome-fence-required');
    const result = recordClientOutcome({ runtimeDir: root, clientIdentity: client, requestId: 'not-submitted-1', outcome: 'NOT_SUBMITTED', leaseId: claim.request.claim.lease_id, fencingToken: claim.request.claim.fencing_token, requestMsgId: 'm-not-submitted-1', targetIdentity: target, code: 'target-busy' });
    assert.equal(result.request.state, 'NOT_SUBMITTED');
    assert.throws(() => claimClientRequest({ runtimeDir: root, clientIdentity: client, requestId: 'not-submitted-1', targetIdentity: target, requestMsgId: 'm-not-submitted-1' }), (e) => e.code === 'client-claim-unavailable');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('completed replies do not consume max_pending slots', () => {
  const root = temp();
  try {
    const created = createClientGrant({ runtimeDir: root, clientIdentity: client, targets: [target], maxPending: 1, maxRequests: 4, maxSubmits: 4 });
    const grant = authenticateClientGrant({ runtimeDir: root, grantId: created.grant_id, clientIdentity: client, credential: fs.readFileSync(created.credential_file, 'utf8').trim() });
    beginClientRequest({ runtimeDir: root, grant, clientIdentity: client, requestId: 'complete-1', target, text: 'one' });
    markClientRequestQueued({ runtimeDir: root, clientIdentity: client, requestId: 'complete-1', msgId: 'm-complete-1' });
    const claim = claimClientRequest({ runtimeDir: root, clientIdentity: client, requestId: 'complete-1', targetIdentity: target, requestMsgId: 'm-complete-1', ownerIdentity: target });
    beginClientSubmit({ runtimeDir: root, clientIdentity: client, requestId: 'complete-1', leaseId: claim.request.claim.lease_id, fencingToken: claim.request.claim.fencing_token });
    recordClientOutcome({ runtimeDir: root, clientIdentity: client, requestId: 'complete-1', outcome: 'NATIVE_QUEUED', nativeQueueId: 'native-complete-1', leaseId: claim.request.claim.lease_id, fencingToken: claim.request.claim.fencing_token });
    recordClientReply({ runtimeDir: root, clientIdentity: client, requestId: 'complete-1', targetIdentity: target, requestMsgId: 'm-complete-1', turnId: turn, body: 'done' });
    assert.equal(beginClientRequest({ runtimeDir: root, grant, clientIdentity: client, requestId: 'complete-2', target, text: 'two' }).request.state, 'SUBMITTING');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('an expired CLAIMED lease can be reclaimed, but the old fence cannot begin and SUBMITTING is not requeued', () => {
  const root = temp();
  try {
    const created = createClientGrant({ runtimeDir: root, clientIdentity: client, targets: [target] });
    const grant = authenticateClientGrant({ runtimeDir: root, grantId: created.grant_id, clientIdentity: client, credential: fs.readFileSync(created.credential_file, 'utf8').trim() });
    beginClientRequest({ runtimeDir: root, grant, clientIdentity: client, requestId: 'reclaim-1', target, text: 'reclaim', now: 1_000 });
    markClientRequestQueued({ runtimeDir: root, clientIdentity: client, requestId: 'reclaim-1', msgId: 'm-reclaim-1', now: 1_000 });
    const oldClaim = claimClientRequest({ runtimeDir: root, clientIdentity: client, requestId: 'reclaim-1', targetIdentity: target, requestMsgId: 'm-reclaim-1', ownerIdentity: target, leaseMs: 1_000, now: 1_000 });
    const newClaim = claimClientRequest({ runtimeDir: root, clientIdentity: client, requestId: 'reclaim-1', targetIdentity: target, requestMsgId: 'm-reclaim-1', ownerIdentity: target, leaseMs: 60_000, now: 2_500 });
    assert.notEqual(newClaim.request.claim.lease_id, oldClaim.request.claim.lease_id);
    assert.throws(() => beginClientSubmit({ runtimeDir: root, clientIdentity: client, requestId: 'reclaim-1', leaseId: oldClaim.request.claim.lease_id, fencingToken: oldClaim.request.claim.fencing_token, now: 2_500 }), (e) => e.code === 'client-begin-fence-mismatch');
    const begun = beginClientSubmit({ runtimeDir: root, clientIdentity: client, requestId: 'reclaim-1', leaseId: newClaim.request.claim.lease_id, fencingToken: newClaim.request.claim.fencing_token, now: 2_500 });
    assert.equal(begun.request.state, 'SUBMITTING');
    assert.throws(() => claimClientRequest({ runtimeDir: root, clientIdentity: client, requestId: 'reclaim-1', targetIdentity: target, requestMsgId: 'm-reclaim-1', ownerIdentity: target, now: 2_500 }), (e) => e.code === 'client-claim-unavailable');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('a stale SUBMITTING request becomes UNCERTAIN at its finite deadline and never requeues', () => {
  const root = temp();
  try {
    const created = createClientGrant({ runtimeDir: root, clientIdentity: client, targets: [target], leaseMs: 1_000, ttlMs: 600_000 });
    const grant = authenticateClientGrant({ runtimeDir: root, grantId: created.grant_id, clientIdentity: client, credential: fs.readFileSync(created.credential_file, 'utf8').trim() });
    beginClientRequest({ runtimeDir: root, grant, clientIdentity: client, requestId: 'stale-submit-1', target, text: 'stale', now: 1_000 });
    markClientRequestQueued({ runtimeDir: root, clientIdentity: client, requestId: 'stale-submit-1', msgId: 'm-stale-submit-1', now: 1_000 });
    const claim = claimClientRequest({ runtimeDir: root, clientIdentity: client, requestId: 'stale-submit-1', targetIdentity: target, requestMsgId: 'm-stale-submit-1', ownerIdentity: target, leaseMs: 60_000, now: 1_000 });
    const begun = beginClientSubmit({ runtimeDir: root, clientIdentity: client, requestId: 'stale-submit-1', leaseId: claim.request.claim.lease_id, fencingToken: claim.request.claim.fencing_token, now: 1_000 });
    assert.equal(begun.request.state, 'SUBMITTING');
    assert.ok(begun.request.submission_deadline_at);
    const expired = expireStaleClientSubmissions({ runtimeDir: root, now: 3_000 });
    assert.equal(expired.expired.length, 1);
    assert.equal(getClientRequest({ runtimeDir: root, clientIdentity: client, requestId: 'stale-submit-1' }).request.state, 'UNCERTAIN');
    assert.throws(() => claimClientRequest({ runtimeDir: root, clientIdentity: client, requestId: 'stale-submit-1', targetIdentity: target, requestMsgId: 'm-stale-submit-1', ownerIdentity: target, now: 3_000 }), (e) => e.code === 'client-claim-unavailable');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('two grants with the same client identity cannot read/cancel/overwrite each other via reused request ID', () => {
  const root = temp();
  try {
    const first = createClientGrant({ runtimeDir: root, clientIdentity: client, targets: [target] });
    const second = createClientGrant({ runtimeDir: root, clientIdentity: client, targets: [target] });
    const firstGrant = authenticateClientGrant({ runtimeDir: root, grantId: first.grant_id, clientIdentity: client, credential: fs.readFileSync(first.credential_file, 'utf8').trim() });
    const secondGrant = authenticateClientGrant({ runtimeDir: root, grantId: second.grant_id, clientIdentity: client, credential: fs.readFileSync(second.credential_file, 'utf8').trim() });
    const requestId = 'cross-grant-same-id';
    beginClientRequest({ runtimeDir: root, grant: firstGrant, clientIdentity: client, requestId, target, text: 'first legal request' });
    const queued = markClientRequestQueued({ runtimeDir: root, clientIdentity: client, requestId, msgId: 'm-cross-grant-1' });
    assert.equal(queued.request.grant_id, firstGrant.grant_id);
    assert.throws(() => beginClientRequest({ runtimeDir: root, grant: secondGrant, clientIdentity: client, requestId, target, text: 'second grant reuse' }), (error) => {
      assert.equal(error.code, 'client-request-scope-mismatch');
      assert.equal('msg_id' in (error.details ?? {}), false);
      assert.equal('state' in (error.details ?? {}), false);
      return true;
    });
    const unchanged = getClientRequest({ runtimeDir: root, clientIdentity: client, requestId, grantId: firstGrant.grant_id });
    assert.equal(unchanged.request.state, 'QUEUED');
    assert.equal(unchanged.request.msg_id, 'm-cross-grant-1');
    cancelClientRequest({ runtimeDir: root, clientIdentity: client, requestId, grantId: firstGrant.grant_id });
    assert.throws(() => cancelClientRequest({ runtimeDir: root, clientIdentity: client, requestId, grantId: secondGrant.grant_id }), (e) => e.code === 'client-request-scope-mismatch');
    assert.equal(getClientRequest({ runtimeDir: root, clientIdentity: client, requestId, grantId: firstGrant.grant_id }).request.state, 'CANCELLED');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('expired unsubmitted requests become EXPIRED and release max_pending without downgrading submitted work', () => {
  const root = temp();
  try {
    const created = createClientGrant({ runtimeDir: root, clientIdentity: client, targets: [target], ttlMs: 30 * 24 * 60 * 60 * 1000, maxPending: 1, maxRequests: 4 });
    const grant = authenticateClientGrant({ runtimeDir: root, grantId: created.grant_id, clientIdentity: client, credential: fs.readFileSync(created.credential_file, 'utf8').trim() });
    const base = Date.now();
    beginClientRequest({ runtimeDir: root, grant, clientIdentity: client, requestId: 'expire-unsubmitted-1', target, text: 'expires before submit', ttlMs: 1_000, now: base });
    markClientRequestQueued({ runtimeDir: root, clientIdentity: client, requestId: 'expire-unsubmitted-1', msgId: 'm-expire-unsubmitted-1' });
    const expired = expireUnsubmittedClientRequests({ runtimeDir: root, now: base + 2_000 });
    assert.equal(expired.expired.length, 1);
    assert.equal(getClientRequest({ runtimeDir: root, clientIdentity: client, requestId: 'expire-unsubmitted-1' }).request.state, 'EXPIRED');
    beginClientRequest({ runtimeDir: root, grant, clientIdentity: client, requestId: 'expire-unsubmitted-2', target, text: 'slot released', now: base + 2_000 });
    assert.equal(getClientRequest({ runtimeDir: root, clientIdentity: client, requestId: 'expire-unsubmitted-2' }).request.state, 'SUBMITTING');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('internal grant budgets count complete history, not the public 500-row page', () => {
  const root = temp();
  try {
    const old = createClientGrant({ runtimeDir: root, clientIdentity: client, targets: [target], maxPending: 16, maxRequests: 600, ttlMs: 30 * 24 * 60 * 60 * 1000 });
    const requestsDir = clientPaths(root).requests;
    fs.mkdirSync(requestsDir, { recursive: true });
    for (let index = 0; index < 500; index += 1) {
      const requestId = `history-old-${String(index).padStart(4, '0')}`;
      fs.writeFileSync(path.join(requestsDir, `history-${index}.json`), `${JSON.stringify({
        v: 1, request_id: requestId, client_identity: client, grant_id: old.grant_id,
        target_identity: target, msg_id: null, state: 'EXPIRED', submitted_at: null,
        created_at: new Date(1_000 + index).toISOString(), expires_at: new Date(1_000 + index + 1_000).toISOString(),
      })}\n`, 'utf8');
    }
    const fresh = createClientGrant({ runtimeDir: root, clientIdentity: client, targets: [target], maxPending: 1, maxRequests: 1, ttlMs: 30 * 24 * 60 * 60 * 1000 });
    const freshGrant = authenticateClientGrant({ runtimeDir: root, grantId: fresh.grant_id, clientIdentity: client, credential: fs.readFileSync(fresh.credential_file, 'utf8').trim() });
    beginClientRequest({ runtimeDir: root, grant: freshGrant, clientIdentity: client, requestId: 'history-fresh-1', target, text: 'fresh one' });
    assert.throws(() => beginClientRequest({ runtimeDir: root, grant: freshGrant, clientIdentity: client, requestId: 'history-fresh-2', target, text: 'fresh two' }), (error) => error.code === 'client-grant-request-budget-exhausted');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('expired CLAIMED before begin becomes EXPIRED and the old fence cannot begin', () => {
  const root = temp();
  try {
    const created = createClientGrant({ runtimeDir: root, clientIdentity: client, targets: [target], ttlMs: 30 * 24 * 60 * 60 * 1000 });
    const grant = authenticateClientGrant({ runtimeDir: root, grantId: created.grant_id, clientIdentity: client, credential: fs.readFileSync(created.credential_file, 'utf8').trim() });
    const base = Date.now();
    beginClientRequest({ runtimeDir: root, grant, clientIdentity: client, requestId: 'expired-claimed-before-native', target, text: 'claim but do not begin', ttlMs: 1_000, now: base });
    markClientRequestQueued({ runtimeDir: root, clientIdentity: client, requestId: 'expired-claimed-before-native', msgId: 'm-expired-claimed-before-native' });
    const claimed = claimClientRequest({ runtimeDir: root, clientIdentity: client, requestId: 'expired-claimed-before-native', targetIdentity: target, requestMsgId: 'm-expired-claimed-before-native', ownerIdentity: target, now: base + 10 });
    expireUnsubmittedClientRequests({ runtimeDir: root, now: base + 2_000 });
    assert.equal(getClientRequest({ runtimeDir: root, clientIdentity: client, requestId: 'expired-claimed-before-native' }).request.state, 'EXPIRED');
    assert.throws(() => beginClientSubmit({ runtimeDir: root, clientIdentity: client, requestId: 'expired-claimed-before-native', leaseId: claimed.request.claim.lease_id, fencingToken: claimed.request.claim.fencing_token, now: base + 2_000 }), (error) => error.code === 'client-begin-unavailable');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('submit budget also counts complete history instead of the public 500-row page', () => {
  const root = temp();
  try {
    const old = createClientGrant({ runtimeDir: root, clientIdentity: client, targets: [target], maxPending: 16, maxRequests: 600, ttlMs: 30 * 24 * 60 * 60 * 1000 });
    const requestsDir = clientPaths(root).requests;
    fs.mkdirSync(requestsDir, { recursive: true });
    for (let index = 0; index < 500; index += 1) {
      fs.writeFileSync(path.join(requestsDir, `submit-history-${index}.json`), `${JSON.stringify({
        v: 1, request_id: `submit-history-${index}`, client_identity: client, grant_id: old.grant_id,
        target_identity: target, msg_id: null, state: 'CANCELLED', submitted_at: null,
        created_at: new Date(1_000 + index).toISOString(), expires_at: new Date(1_000 + index + 1_000).toISOString(),
      })}\n`, 'utf8');
    }
    const fresh = createClientGrant({ runtimeDir: root, clientIdentity: client, targets: [target], maxPending: 4, maxRequests: 4, maxSubmits: 1, ttlMs: 30 * 24 * 60 * 60 * 1000 });
    const grant = authenticateClientGrant({ runtimeDir: root, grantId: fresh.grant_id, clientIdentity: client, credential: fs.readFileSync(fresh.credential_file, 'utf8').trim() });
    for (const suffix of ['1', '2']) {
      beginClientRequest({ runtimeDir: root, grant, clientIdentity: client, requestId: `submit-fresh-${suffix}`, target, text: `submit ${suffix}` });
      markClientRequestQueued({ runtimeDir: root, clientIdentity: client, requestId: `submit-fresh-${suffix}`, msgId: `m-submit-fresh-${suffix}` });
      claimClientRequest({ runtimeDir: root, clientIdentity: client, requestId: `submit-fresh-${suffix}`, targetIdentity: target, requestMsgId: `m-submit-fresh-${suffix}`, ownerIdentity: target, leaseMs: 60_000 });
    }
    const firstClaim = getClientRequest({ runtimeDir: root, clientIdentity: client, requestId: 'submit-fresh-1' }).request.claim;
    beginClientSubmit({ runtimeDir: root, clientIdentity: client, requestId: 'submit-fresh-1', leaseId: firstClaim.lease_id, fencingToken: firstClaim.fencing_token });
    const secondClaim = getClientRequest({ runtimeDir: root, clientIdentity: client, requestId: 'submit-fresh-2' }).request.claim;
    assert.throws(() => beginClientSubmit({ runtimeDir: root, clientIdentity: client, requestId: 'submit-fresh-2', leaseId: secondClaim.lease_id, fencingToken: secondClaim.fencing_token }), (error) => error.code === 'client-grant-submit-budget-exhausted');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});