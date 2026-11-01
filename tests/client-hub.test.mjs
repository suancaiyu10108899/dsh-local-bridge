import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { BridgeHub } from '../src/hub.mjs';
import { HubStore } from '../src/store.mjs';
import { HubClient } from '../src/client.mjs';
import { createClientGrant, authenticateClientGrant } from '../src/client-access.mjs';

const clientIdentity = 'client:dot-22222222-2222-4222-8222-222222222222';
const target = 'codex:33333333-3333-4333-8333-333333333333';
const turn = '44444444-4444-4444-8444-444444444444';

function withDeadline(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function temp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-client-hub-'));
  fs.mkdirSync(path.join(root, 'hub'), { recursive: true });
  return root;
}

test('restricted client can request/reply-read exact target but cannot pair/global-status/consume', async () => {
  const runtime = temp();
  const store = new HubStore({
    stateFile: path.join(runtime, 'hub', 'state.json'),
    eventsFile: path.join(runtime, 'hub', 'events.jsonl'),
  }).load();
  store.addTarget(target);
  const baseToken = crypto.randomBytes(32).toString('hex');
  const hub = new BridgeHub({
    store, token: baseToken, runtimeRoot: runtime, host: '127.0.0.1', port: 0, ackTimeoutMs: 1_000,
    targetBinding: (envelope) => ({ ok: true, envelope: { ...envelope, meta: { ...(envelope.meta ?? {}), target_binding_epoch: 'epoch-client-test' } } }),
  });
  const address = await hub.start();
  const created = createClientGrant({ runtimeDir: runtime, clientIdentity, targets: [target], leaseMs: 60_000, ttlMs: 3_600_000 });
  const secret = fs.readFileSync(created.credential_file, 'utf8').trim();
  const grant = authenticateClientGrant({ runtimeDir: runtime, grantId: created.grant_id, clientIdentity, credential: secret });
  const targetClient = new HubClient({ host: '127.0.0.1', port: address.port, token: baseToken, role: 'codex', identity: target });
  const client = new HubClient({ host: '127.0.0.1', port: address.port, token: secret, role: 'client', identity: clientIdentity, grantId: grant.grant_id });
  const operator = new HubClient({ host: '127.0.0.1', port: address.port, token: baseToken, role: 'cli', identity: 'cli:operator' });
  let deliveredCount = 0;
  try {
    await targetClient.connect();
    targetClient.onDelivery((_message, context) => {
      deliveredCount += 1;
      context.ack({ ok: true });
    });
    const welcome = await client.connect();
    assert.equal(welcome.role, 'client');
    assert.equal(welcome.grant_id, grant.grant_id);
    await operator.connect();

    const accepted = await client.clientRequest({ clientRequestId: 'm-client-request-1', to: target, text: 'synthetic client request' });
    assert.equal(accepted.state, 'QUEUED');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(deliveredCount, 0, 'restricted client request must not be role-pushed to a codex adapter');
    const status = await client.clientStatus('m-client-request-1');
    assert.equal(status.state, 'QUEUED');
    assert.equal(status.msg_id, accepted.msg_id);

    const claimed = await operator.request({
      type: 'client-claim', client_identity: clientIdentity, client_request_id: 'm-client-request-1',
      target_identity: target, request_msg_id: accepted.msg_id, claim_lease_ms: 60_000,
      owner_identity: target, receiver_nonce: 'receiver-synthetic', binding_epoch: 'epoch-client-test',
    });
    assert.equal(claimed.type, 'client-claim-result');
    assert.equal(claimed.ok, true);
    assert.equal(claimed.request.state, 'CLAIMED');
    assert.equal(claimed.request.request_msg_id, accepted.msg_id);
    assert.ok(claimed.lease.id);
    const begun = await operator.request({
      type: 'client-begin-submit', client_identity: clientIdentity, client_request_id: 'm-client-request-1',
      target_identity: target, request_msg_id: accepted.msg_id,
      lease_id: claimed.lease.id, fencing_token: claimed.lease.fencing_token,
    });
    assert.equal(begun.type, 'client-begin-submit-result');
    assert.equal(begun.request.state, 'SUBMITTING');
    const outcome = await operator.request({
      type: 'client-outcome', client_identity: clientIdentity, client_request_id: 'm-client-request-1',
      target_identity: target, request_msg_id: accepted.msg_id,
      status: 'NATIVE_QUEUED', native_queue_id: 'native-synthetic-1',
      lease_id: claimed.lease.id, fencing_token: claimed.lease.fencing_token,
    });
    assert.equal(outcome.type, 'client-outcome-result');
    assert.equal(outcome.status, 'NATIVE_QUEUED');
    assert.equal(outcome.request.state, 'NATIVE_QUEUED');
    const afterNative = await client.clientStatus('m-client-request-1');
    assert.equal(afterNative.state, 'NATIVE_QUEUED');
    assert.equal(afterNative.target_binding_epoch, 'epoch-client-test');
    const reply = await operator.clientReply({
      clientIdentity, clientRequestId: 'm-client-request-1', targetIdentity: target,
      msgId: accepted.msg_id, turnId: turn, body: 'synthetic client reply',
    });
    assert.equal(reply.ok, true);
    assert.equal(reply.reply.turn_id, turn);
    const repeatedReply = await operator.clientReply({
      clientIdentity, clientRequestId: 'm-client-request-1', targetIdentity: target,
      msgId: accepted.msg_id, turnId: '55555555-5555-4555-8555-555555555555', body: 'synthetic client reply',
    });
    assert.equal(repeatedReply.idempotent, true);
    assert.equal(repeatedReply.reply.reply_msg_id, reply.reply.reply_msg_id);
    assert.equal(repeatedReply.reply.turn_id, turn);
    await assert.rejects(operator.clientReply({
      clientIdentity, clientRequestId: 'm-client-request-1', targetIdentity: target,
      msgId: accepted.msg_id, turnId: turn, body: 'different synthetic reply',
    }), (error) => error.code === 'client-reply-conflict');
    const resumed = await client.clientResume('m-client-request-1');
    assert.equal(resumed.state, 'REPLY_READY');
    assert.equal(resumed.reply.body, 'synthetic client reply');
    assert.equal(resumed.reply.body_sha256, crypto.createHash('sha256').update('synthetic client reply').digest('hex'));

    await assert.rejects(client.clientCancel('m-client-request-1'), (error) => error.code === 'client-cancel-too-late');
    let forbidden = await client.request({ type: 'targets-query' });
    assert.equal(forbidden.type, 'client-rejected');
    assert.equal(forbidden.code, 'client-forbidden');
    forbidden = await client.request({ type: 'pair-add', identity: 'dsh:session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    assert.equal(forbidden.type, 'client-rejected');
    assert.equal(forbidden.code, 'client-forbidden');
    forbidden = await client.request({ type: 'client-request', client_request_id: 'm-client-request-2', to: 'dsh:session-not-paired', text: 'x' });
    assert.equal(forbidden.type, 'client-rejected');
    assert.equal(forbidden.code, 'client-target-unpaired');
  } finally {
    await client.close(); await targetClient.close(); await operator.close(); await hub.stop();
    fs.rmSync(runtime, { recursive: true, force: true });
  }
});
test('client-DSH push timeout becomes server-authoritative UNCERTAIN and is never auto-retried', async () => {
  const runtime = temp();
  const store = new HubStore({ stateFile: path.join(runtime, 'hub', 'state.json'), eventsFile: path.join(runtime, 'hub', 'events.jsonl') }).load();
  const dshTarget = 'dsh:session-77777777-7777-4777-8777-777777777777';
  store.addTarget(dshTarget);
  const baseToken = crypto.randomBytes(32).toString('hex');
  const hub = new BridgeHub({ store, token: baseToken, runtimeRoot: runtime, host: '127.0.0.1', port: 0, ackTimeoutMs: 120, maxAttempts: 5 });
  const address = await hub.start();
  const created = createClientGrant({ runtimeDir: runtime, clientIdentity, targets: [dshTarget], leaseMs: 60_000, ttlMs: 3_600_000 });
  const secret = fs.readFileSync(created.credential_file, 'utf8').trim();
  const targetClient = new HubClient({ host: '127.0.0.1', port: address.port, token: baseToken, role: 'dsh', identity: dshTarget, capabilities: { client_requests_v1: true } });
  const client = new HubClient({ host: '127.0.0.1', port: address.port, token: secret, role: 'client', identity: clientIdentity, grantId: created.grant_id });
  let deliveries = 0;
  try {
    await targetClient.connect();
    targetClient.onDelivery(() => { deliveries += 1; /* intentionally no ACK */ });
    await client.connect();
    await client.clientRequest({ clientRequestId: 'm-client-uncertain-1', to: dshTarget, text: 'uncertain synthetic request' });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const status = await client.clientStatus('m-client-uncertain-1');
    assert.equal(status.state, 'UNCERTAIN');
    assert.equal(deliveries, 1);
    const record = store.getMessage(status.msg_id);
    assert.equal(record.state, 'failed');
    assert.equal(record.attempts, 1);
  } finally {
    await client.close(); await targetClient.close(); await hub.stop(); fs.rmSync(runtime, { recursive: true, force: true });
  }
});
test('begin rechecks target pairing and epoch after claim', async () => {
  const runtime = temp();
  const store = new HubStore({ stateFile: path.join(runtime, 'hub', 'state.json'), eventsFile: path.join(runtime, 'hub', 'events.jsonl') }).load();
  store.addTarget(target);
  const baseToken = crypto.randomBytes(32).toString('hex');
  let epoch = 'epoch-begin-1';
  const hub = new BridgeHub({
    store, token: baseToken, runtimeRoot: runtime, host: '127.0.0.1', port: 0, ackTimeoutMs: 1_000,
    targetBinding: (envelope) => ({ ok: true, envelope: { ...envelope, meta: { ...(envelope.meta ?? {}), target_binding_epoch: epoch } } }),
  });
  const address = await hub.start();
  const created = createClientGrant({ runtimeDir: runtime, clientIdentity, targets: [target] });
  const secret = fs.readFileSync(created.credential_file, 'utf8').trim();
  const client = new HubClient({ host: '127.0.0.1', port: address.port, token: secret, role: 'client', identity: clientIdentity, grantId: created.grant_id });
  const operator = new HubClient({ host: '127.0.0.1', port: address.port, token: baseToken, role: 'cli', identity: 'cli:operator' });
  const attempt = async (requestId, text) => {
    await client.clientRequest({ clientRequestId: requestId, to: target, text });
    const current = await client.clientStatus(requestId);
    return operator.request({
      type: 'client-claim', client_identity: clientIdentity, client_request_id: requestId,
      target_identity: target, request_msg_id: current.msg_id, claim_lease_ms: 60_000,
      owner_identity: target, binding_epoch: 'epoch-begin-1',
    });
  };
  try {
    await client.connect(); await operator.connect();
    const claimed = await attempt('m-begin-unpaired', 'synthetic begin unpaired');
    store.removeTarget(target);
    const unpaired = await operator.request({
      type: 'client-begin-submit', client_identity: clientIdentity, client_request_id: 'm-begin-unpaired',
      target_identity: target, request_msg_id: claimed.request.request_msg_id,
      lease_id: claimed.lease.id, fencing_token: claimed.lease.fencing_token,
    });
    assert.equal(unpaired.ok, false);
    assert.equal(unpaired.code, 'client-begin-target-unpaired');

    store.addTarget(target);
    const claimed2 = await attempt('m-begin-epoch', 'synthetic begin epoch');
    epoch = 'epoch-begin-2';
    const changed = await operator.request({
      type: 'client-begin-submit', client_identity: clientIdentity, client_request_id: 'm-begin-epoch',
      target_identity: target, request_msg_id: claimed2.request.request_msg_id,
      lease_id: claimed2.lease.id, fencing_token: claimed2.lease.fencing_token,
    });
    assert.equal(changed.ok, false);
    assert.equal(changed.code, 'client-begin-target-epoch-mismatch');
  } finally {
    await client.close(); await operator.close(); await hub.stop(); fs.rmSync(runtime, { recursive: true, force: true });
  }
});
test('legacy DSH to Codex role delivery remains enabled', async () => {
  const runtime = temp();
  const store = new HubStore({ stateFile: path.join(runtime, 'hub', 'state.json'), eventsFile: path.join(runtime, 'hub', 'events.jsonl') }).load();
  const dshSource = 'dsh:session-88888888-8888-4888-8888-888888888888';
  store.addTarget(dshSource);
  store.addTarget(target);
  const baseToken = crypto.randomBytes(32).toString('hex');
  const hub = new BridgeHub({ store, token: baseToken, runtimeRoot: runtime, host: '127.0.0.1', port: 0, ackTimeoutMs: 1_000 });
  const address = await hub.start();
  const codex = new HubClient({ host: '127.0.0.1', port: address.port, token: baseToken, role: 'codex', identity: target });
  const dsh = new HubClient({ host: '127.0.0.1', port: address.port, token: baseToken, role: 'dsh', identity: dshSource });
  let received;
  const delivered = new Promise((resolve) => { received = resolve; });
  try {
    await codex.connect();
    codex.onDelivery((message, context) => { received(message); context.ack({ ok: true }); });
    await dsh.connect();
    await dsh.sendMessage({ v: 1, from: dshSource, to: target, kind: 'text', text: 'legacy synthetic message' });
    const incoming = await withDeadline(delivered, 5_000, 'legacy DSH delivery');
    assert.equal(incoming.from_role, 'dsh');
    assert.equal(incoming.meta?.client_request_id, undefined);
  } finally {
    await dsh.close(); await codex.close(); await hub.stop(); fs.rmSync(runtime, { recursive: true, force: true });
  }
});
test('DSH own-target can claim/begin/outcome and write the client reply', async () => {
  const runtime = temp();
  const targetDsh = 'dsh:session-99999999-9999-4999-8999-999999999999';
  const store = new HubStore({ stateFile: path.join(runtime, 'hub', 'state.json'), eventsFile: path.join(runtime, 'hub', 'events.jsonl') }).load();
  store.addTarget(targetDsh);
  const baseToken = crypto.randomBytes(32).toString('hex');
  const hub = new BridgeHub({ store, token: baseToken, runtimeRoot: runtime, host: '127.0.0.1', port: 0, ackTimeoutMs: 5_000 });
  const address = await hub.start();
  const created = createClientGrant({ runtimeDir: runtime, clientIdentity, targets: [targetDsh] });
  const secret = fs.readFileSync(created.credential_file, 'utf8').trim();
  const client = new HubClient({ host: '127.0.0.1', port: address.port, token: secret, role: 'client', identity: clientIdentity, grantId: created.grant_id });
  const dsh = new HubClient({ host: '127.0.0.1', port: address.port, token: baseToken, role: 'dsh', identity: 'dsh:host:test' });
  try {
    await client.connect(); await dsh.connect();
    const accepted = await client.clientRequest({ clientRequestId: 'm-dsh-route-1', to: targetDsh, text: 'synthetic dsh route' });
    const claimed = await dsh.clientClaim({ clientIdentity, clientRequestId: 'm-dsh-route-1', targetIdentity: targetDsh, requestMsgId: accepted.msg_id, ownerIdentity: targetDsh });
    const begun = await dsh.clientBegin({ clientIdentity, clientRequestId: 'm-dsh-route-1', targetIdentity: targetDsh, requestMsgId: accepted.msg_id, leaseId: claimed.claim.lease_id, fencingToken: claimed.claim.fencing_token });
    assert.equal(begun.state, 'SUBMITTING');
    const outcome = await dsh.clientOutcome({ clientIdentity, clientRequestId: 'm-dsh-route-1', targetIdentity: targetDsh, requestMsgId: accepted.msg_id, outcome: 'NATIVE_QUEUED', nativeQueueId: 'native-dsh-1', leaseId: claimed.claim.lease_id, fencingToken: claimed.claim.fencing_token });
    assert.equal(outcome.state, 'NATIVE_QUEUED');
    const reply = await dsh.clientReply({ clientIdentity, clientRequestId: 'm-dsh-route-1', targetIdentity: targetDsh, requestMsgId: accepted.msg_id, turnId: turn, body: 'synthetic dsh reply' });
    assert.equal(reply.ok, true);
    const resumed = await client.clientResume('m-dsh-route-1');
    assert.equal(resumed.reply.body, 'synthetic dsh reply');
  } finally {
    await client.close(); await dsh.close(); await hub.stop(); fs.rmSync(runtime, { recursive: true, force: true });
  }
});
test('NOT_SUBMITTED finalizes the Hub message as failed and is not reclaimable', async () => {
  const runtime = temp();
  const store = new HubStore({ stateFile: path.join(runtime, 'hub', 'state.json'), eventsFile: path.join(runtime, 'hub', 'events.jsonl') }).load();
  store.addTarget(target);
  const baseToken = crypto.randomBytes(32).toString('hex');
  const hub = new BridgeHub({ store, token: baseToken, runtimeRoot: runtime, host: '127.0.0.1', port: 0, ackTimeoutMs: 1_000 });
  const address = await hub.start();
  const created = createClientGrant({ runtimeDir: runtime, clientIdentity, targets: [target] });
  const secret = fs.readFileSync(created.credential_file, 'utf8').trim();
  const client = new HubClient({ host: '127.0.0.1', port: address.port, token: secret, role: 'client', identity: clientIdentity, grantId: created.grant_id });
  const operator = new HubClient({ host: '127.0.0.1', port: address.port, token: baseToken, role: 'cli', identity: 'cli:operator' });
  try {
    await client.connect(); await operator.connect();
    const accepted = await client.clientRequest({ clientRequestId: 'm-not-submitted-hub', to: target, text: 'synthetic not submitted' });
    const claim = await operator.request({ type: 'client-claim', client_identity: clientIdentity, client_request_id: 'm-not-submitted-hub', target_identity: target, request_msg_id: accepted.msg_id, owner_identity: target });
    await operator.request({ type: 'client-begin-submit', client_identity: clientIdentity, client_request_id: 'm-not-submitted-hub', target_identity: target, request_msg_id: accepted.msg_id, lease_id: claim.lease.id, fencing_token: claim.lease.fencing_token });
    const outcome = await operator.request({ type: 'client-outcome', client_identity: clientIdentity, client_request_id: 'm-not-submitted-hub', target_identity: target, request_msg_id: accepted.msg_id, status: 'NOT_SUBMITTED', reason: 'busy-after-begin', lease_id: claim.lease.id, fencing_token: claim.lease.fencing_token });
    assert.equal(outcome.request.state, 'NOT_SUBMITTED');
    assert.equal(outcome.finalization.finalized, true);
    assert.equal(store.getMessage(accepted.msg_id).state, 'failed');
    assert.equal(store.getMessage(accepted.msg_id).last_error, 'client-not-submitted');
    assert.equal((await client.clientStatus('m-not-submitted-hub')).state, 'NOT_SUBMITTED');
    const reclaimed = await operator.request({ type: 'client-claim', client_identity: clientIdentity, client_request_id: 'm-not-submitted-hub', target_identity: target, request_msg_id: accepted.msg_id, owner_identity: target });
    assert.equal(reclaimed.ok, false);
    assert.equal(reclaimed.code, 'client-claim-unavailable');
  } finally {
    await client.close(); await operator.close(); await hub.stop(); fs.rmSync(runtime, { recursive: true, force: true });
  }
});
test('Hub sweeps a lost begin ACK to UNCERTAIN and never requeues it', async () => {
  const runtime = temp();
  const store = new HubStore({ stateFile: path.join(runtime, 'hub', 'state.json'), eventsFile: path.join(runtime, 'hub', 'events.jsonl') }).load();
  store.addTarget(target);
  const baseToken = crypto.randomBytes(32).toString('hex');
  const hub = new BridgeHub({ store, token: baseToken, runtimeRoot: runtime, host: '127.0.0.1', port: 0, ackTimeoutMs: 1_000 });
  const address = await hub.start();
  const created = createClientGrant({ runtimeDir: runtime, clientIdentity, targets: [target], leaseMs: 1_000 });
  const secret = fs.readFileSync(created.credential_file, 'utf8').trim();
  const client = new HubClient({ host: '127.0.0.1', port: address.port, token: secret, role: 'client', identity: clientIdentity, grantId: created.grant_id });
  const operator = new HubClient({ host: '127.0.0.1', port: address.port, token: baseToken, role: 'cli', identity: 'cli:operator' });
  try {
    await client.connect(); await operator.connect();
    const accepted = await client.clientRequest({ clientRequestId: 'm-lost-begin-ack', to: target, text: 'synthetic lost begin ack' });
    const claim = await operator.request({ type: 'client-claim', client_identity: clientIdentity, client_request_id: 'm-lost-begin-ack', target_identity: target, request_msg_id: accepted.msg_id, owner_identity: target });
    await operator.request({ type: 'client-begin-submit', client_identity: clientIdentity, client_request_id: 'm-lost-begin-ack', target_identity: target, request_msg_id: accepted.msg_id, lease_id: claim.lease.id, fencing_token: claim.lease.fencing_token });
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    const status = await client.clientStatus('m-lost-begin-ack');
    assert.equal(status.state, 'UNCERTAIN');
    assert.equal(store.getMessage(accepted.msg_id).state, 'failed');
    const reclaimed = await operator.request({ type: 'client-claim', client_identity: clientIdentity, client_request_id: 'm-lost-begin-ack', target_identity: target, request_msg_id: accepted.msg_id, owner_identity: target });
    assert.equal(reclaimed.ok, false);
    assert.equal(reclaimed.code, 'client-claim-unavailable');
  } finally {
    await client.close(); await operator.close(); await hub.stop(); fs.rmSync(runtime, { recursive: true, force: true });
  }
});
test('a second grant same client identity cannot mutate or leak the first grant request on reused ID', async () => {
  const runtime = temp();
  const store = new HubStore({ stateFile: path.join(runtime, 'hub', 'state.json'), eventsFile: path.join(runtime, 'hub', 'events.jsonl') }).load();
  store.addTarget(target);
  const baseToken = crypto.randomBytes(32).toString('hex');
  const hub = new BridgeHub({ store, token: baseToken, runtimeRoot: runtime, host: '127.0.0.1', port: 0, ackTimeoutMs: 1_000 });
  const address = await hub.start();
  const first = createClientGrant({ runtimeDir: runtime, clientIdentity, targets: [target] });
  const second = createClientGrant({ runtimeDir: runtime, clientIdentity, targets: [target] });
  const firstSecret = fs.readFileSync(first.credential_file, 'utf8').trim();
  const secondSecret = fs.readFileSync(second.credential_file, 'utf8').trim();
  const clientA = new HubClient({ host: '127.0.0.1', port: address.port, token: firstSecret, role: 'client', identity: clientIdentity, grantId: first.grant_id });
  const clientB = new HubClient({ host: '127.0.0.1', port: address.port, token: secondSecret, role: 'client', identity: clientIdentity, grantId: second.grant_id });
  try {
    await clientA.connect(); await clientB.connect();
    const accepted = await clientA.clientRequest({ clientRequestId: 'm-cross-grant-hub', to: target, text: 'first grant legal' });
    const rejected = await clientB.request({ type: 'client-request', request_id: 'm-cross-grant-hub', client_request_id: 'm-cross-grant-hub', to: target, text: 'second grant illegal' });
    assert.equal(rejected.type, 'client-rejected');
    assert.equal(rejected.code, 'client-request-scope-mismatch');
    assert.equal('msg_id' in rejected, false);
    assert.equal('state' in rejected, false);
    const still = await clientA.clientStatus('m-cross-grant-hub');
    assert.equal(still.state, 'QUEUED');
    assert.equal(still.msg_id, accepted.msg_id);
    const cancelRejected = await clientB.request({ type: 'client-cancel', request_id: 'm-cross-grant-cancel', client_request_id: 'm-cross-grant-hub' });
    assert.equal(cancelRejected.type, 'client-rejected');
    assert.equal(cancelRejected.code, 'client-request-scope-mismatch');
    assert.equal((await clientA.clientStatus('m-cross-grant-hub')).state, 'QUEUED');
  } finally {
    await clientA.close(); await clientB.close(); await hub.stop(); fs.rmSync(runtime, { recursive: true, force: true });
  }
});
test('legacy DSH adapter without client-gate capability never receives a restricted client message', async () => {
  const runtime = temp();
  const store = new HubStore({ stateFile: path.join(runtime, 'hub', 'state.json'), eventsFile: path.join(runtime, 'hub', 'events.jsonl') }).load();
  const dshTarget = 'dsh:session-77777777-7777-4777-8777-777777777777';
  store.addTarget(dshTarget);
  const baseToken = crypto.randomBytes(32).toString('hex');
  const hub = new BridgeHub({ store, token: baseToken, runtimeRoot: runtime, host: '127.0.0.1', port: 0, ackTimeoutMs: 500 });
  const address = await hub.start();
  const created = createClientGrant({ runtimeDir: runtime, clientIdentity, targets: [dshTarget] });
  const secret = fs.readFileSync(created.credential_file, 'utf8').trim();
  const client = new HubClient({ host: '127.0.0.1', port: address.port, token: secret, role: 'client', identity: clientIdentity, grantId: created.grant_id });
  const legacy = new HubClient({ host: '127.0.0.1', port: address.port, token: baseToken, role: 'dsh', identity: dshTarget });
  let legacyDeliveries = 0;
  legacy.onDelivery(() => { legacyDeliveries += 1; });
  try {
    await legacy.connect(); await client.connect();
    await client.clientRequest({ clientRequestId: 'm-legacy-dsh-gate', to: dshTarget, text: 'must not reach legacy adapter' });
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    assert.equal(legacyDeliveries, 0);
    assert.equal((await client.clientStatus('m-legacy-dsh-gate')).state, 'QUEUED');
    await legacy.close();
    const capable = new HubClient({ host: '127.0.0.1', port: address.port, token: baseToken, role: 'dsh', identity: dshTarget, capabilities: { client_requests_v1: true } });
    const incoming = new Promise((resolve) => capable.onDelivery((message, context) => { resolve(message); context.ack({ ok: true }); }));
    await capable.connect();
    const message = await withDeadline(incoming, 5_000, 'capable DSH delivery');
    assert.equal(message.meta.client_request_id, 'm-legacy-dsh-gate');
    await capable.close();
  } finally {
    await client.close(); await hub.stop(); fs.rmSync(runtime, { recursive: true, force: true });
  }
});
test('real Hub expires an unclaimed request before native and status/resume agree', async () => {
  const runtime = temp();
  const store = new HubStore({ stateFile: path.join(runtime, 'hub', 'state.json'), eventsFile: path.join(runtime, 'hub', 'events.jsonl') }).load();
  store.addTarget(target);
  const token = crypto.randomBytes(32).toString('hex');
  const hub = new BridgeHub({ store, token, runtimeRoot: runtime, host: '127.0.0.1', port: 0, ackTimeoutMs: 500 });
  const address = await hub.start();
  const created = createClientGrant({ runtimeDir: runtime, clientIdentity, targets: [target], maxPending: 1, maxRequests: 4, leaseMs: 60_000, ttlMs: 86_400_000 });
  const secret = fs.readFileSync(created.credential_file, 'utf8').trim();
  const client = new HubClient({ host: '127.0.0.1', port: address.port, token: secret, role: 'client', identity: clientIdentity, grantId: created.grant_id });
  try {
    await client.connect();
    const accepted = await client.clientRequest({ clientRequestId: 'm-expired-unclaimed', to: target, text: 'ttl before claim', ttlMs: 1_000 });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const status = await client.clientStatus('m-expired-unclaimed');
    assert.equal(status.state, 'EXPIRED');
    assert.equal(status.submitted_at, null);
    const resumed = await client.request({ type: 'client-resume', request_id: 'm-expired-resume', client_request_id: 'm-expired-unclaimed' });
    assert.equal(resumed.state, 'EXPIRED');
    assert.equal(resumed.reply, null);
    assert.equal(store.getMessage(accepted.msg_id).state, 'expired');
    const replacement = await client.clientRequest({ clientRequestId: 'm-expired-replacement', to: target, text: 'pending slot released', ttlMs: 86_400_000 });
    assert.equal(replacement.state, 'QUEUED');
  } finally { await client.close(); await hub.stop(); fs.rmSync(runtime, { recursive: true, force: true }); }
});
test('legacy DSH without claim/begin gets zero native calls and can cancel before begin', async () => {
  const runtime = temp();
  const store = new HubStore({ stateFile: path.join(runtime, 'hub', 'state.json'), eventsFile: path.join(runtime, 'hub', 'events.jsonl') }).load();
  const dshTarget = 'dsh:session-66666666-6666-4666-8666-666666666666';
  store.addTarget(dshTarget);
  const token = crypto.randomBytes(32).toString('hex');
  const hub = new BridgeHub({ store, token, runtimeRoot: runtime, host: '127.0.0.1', port: 0, ackTimeoutMs: 500 });
  const address = await hub.start();
  const created = createClientGrant({ runtimeDir: runtime, clientIdentity, targets: [dshTarget] });
  const secret = fs.readFileSync(created.credential_file, 'utf8').trim();
  const client = new HubClient({ host: '127.0.0.1', port: address.port, token: secret, role: 'client', identity: clientIdentity, grantId: created.grant_id });
  const legacy = new HubClient({ host: '127.0.0.1', port: address.port, token, role: 'dsh', identity: dshTarget });
  let nativeCalls = 0;
  legacy.onDelivery((_message, context) => { nativeCalls += 1; context.ack({ ok: true }); });
  try {
    await legacy.connect(); await client.connect();
    await client.clientRequest({ clientRequestId: 'm-legacy-no-claim', to: dshTarget, text: 'legacy must not reach native' });
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    assert.equal(nativeCalls, 0);
    assert.equal((await client.clientStatus('m-legacy-no-claim')).state, 'QUEUED');
    const cancelled = await client.clientCancel('m-legacy-no-claim');
    assert.equal(cancelled.state, 'CANCELLED');
    assert.equal((await client.clientStatus('m-legacy-no-claim')).state, 'CANCELLED');
  } finally { await legacy.close(); await client.close(); await hub.stop(); fs.rmSync(runtime, { recursive: true, force: true }); }
});

test('capable DSH adapter performs full claim/begin/outcome/reply round trip', async () => {
  const runtime = temp();
  const dshTarget = 'dsh:session-55555555-5555-4555-8555-555555555555';
  const store = new HubStore({ stateFile: path.join(runtime, 'hub', 'state.json'), eventsFile: path.join(runtime, 'hub', 'events.jsonl') }).load();
  store.addTarget(dshTarget);
  const token = crypto.randomBytes(32).toString('hex');
  const hub = new BridgeHub({ store, token, runtimeRoot: runtime, host: '127.0.0.1', port: 0, ackTimeoutMs: 5_000 });
  const address = await hub.start();
  const created = createClientGrant({ runtimeDir: runtime, clientIdentity, targets: [dshTarget] });
  const secret = fs.readFileSync(created.credential_file, 'utf8').trim();
  const client = new HubClient({ host: '127.0.0.1', port: address.port, token: secret, role: 'client', identity: clientIdentity, grantId: created.grant_id });
  const dsh = new HubClient({ host: '127.0.0.1', port: address.port, token, role: 'dsh', identity: 'dsh:host:capable', capabilities: { client_requests_v1: true } });
  const handled = new Promise((resolve, reject) => {
    dsh.onDelivery(async (message, context) => {
      try {
        const requestId = message.meta.client_request_id;
        const claimed = await dsh.clientClaim({ clientIdentity: message.from, clientRequestId: requestId, targetIdentity: dshTarget, requestMsgId: message.msg_id, ownerIdentity: dshTarget });
        await dsh.clientBegin({ clientIdentity: message.from, clientRequestId: requestId, targetIdentity: dshTarget, requestMsgId: message.msg_id, leaseId: claimed.claim.lease_id, fencingToken: claimed.claim.fencing_token });
        await dsh.clientOutcome({ clientIdentity: message.from, clientRequestId: requestId, targetIdentity: dshTarget, requestMsgId: message.msg_id, outcome: 'NATIVE_QUEUED', nativeQueueId: 'native-capable-1', leaseId: claimed.claim.lease_id, fencingToken: claimed.claim.fencing_token });
        await dsh.clientReply({ clientIdentity: message.from, clientRequestId: requestId, targetIdentity: dshTarget, requestMsgId: message.msg_id, turnId: turn, body: 'capable synthetic reply' });
        context.ack({ ok: true });
        resolve(requestId);
      } catch (error) { reject(error); }
    });
  });
  try {
    await dsh.connect(); await client.connect();
    await client.clientRequest({ clientRequestId: 'm-capable-roundtrip', to: dshTarget, text: 'capable adapter roundtrip' });
    const requestId = await withDeadline(handled, 5_000, 'capable DSH roundtrip');
    assert.equal(requestId, 'm-capable-roundtrip');
    assert.equal((await client.clientStatus('m-capable-roundtrip')).state, 'REPLY_READY');
    const resumed = await client.clientResume('m-capable-roundtrip');
    assert.equal(resumed.reply.body, 'capable synthetic reply');
  } finally { await dsh.close(); await client.close(); await hub.stop(); fs.rmSync(runtime, { recursive: true, force: true }); }
});