import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { readClientReply, postClientReply } from '../adapters/codex/client-reply.mjs';
import { messageKey, messageFingerprint, QueueInbox } from '../adapters/codex/queue-inbox.mjs';
import { clientDispatchHooks } from '../adapters/codex/client-dispatch.mjs';

const owner = '33333333-3333-4333-8333-333333333333';
const client = 'client:dot-22222222-2222-4222-8222-222222222222';
const turn = '44444444-4444-4444-8444-444444444444';
const dispatch = { lease_id: '55555555-5555-4555-8555-555555555555', fencing_token: 'a'.repeat(32) };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-client-reply-'));
  t.after(() => {
    const absolute = path.resolve(dir);
    assert.ok(absolute.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(absolute).startsWith('lab-client-reply-'));
    fs.rmSync(absolute, { recursive: true, force: true });
  });
  const runtime = path.join(dir, 'receiver'); fs.mkdirSync(path.join(runtime, 'replies'), { recursive: true });
  const config = { v: 2, mode: 'daily', enabled: true, transport: 'target-pull', thread_id: owner,
    allowed_senders: [], allowed_clients: [client], cli: path.join(dir, 'codex.exe'), cli_sha256: 'a'.repeat(64),
    workspace: dir, rollout_path: path.join(dir, 'synthetic-rollout.jsonl'), state_db: path.join(dir, 'synthetic-state.sqlite'),
    runtime_dir: runtime, activated_at: new Date(Date.now() - 1000).toISOString(), expires_at: null, window_id: owner,
    rate_limit: { max_submissions: 6, window_ms: 3600000 }, min_interval_ms: 30000, idle_settle_ms: 3000,
    poll_interval_ms: 2000, max_text_bytes: 12000, accept_backlog: true };
  const message = { msg_id: 'synthetic-client-message', from: client, from_role: 'client', to: 'codex:' + owner,
    kind: 'text', text: 'Evaluate and report only', meta: { client_request_id: 'synthetic-request' } };
  const entry = { msg_id: message.msg_id, client_request_id: 'synthetic-request', client_identity: client, reply_to: client,
    window_id: owner, status: 'NATIVE_QUEUED', native_queue_id: 'synthetic-native-queue', fingerprint: messageFingerprint(message) };
  const ledgerPath = path.join(runtime, 'ledger.json'), payloadPath = path.join(runtime, messageKey(message.msg_id) + '.message.json');
  fs.writeFileSync(ledgerPath, JSON.stringify({ v: 1, entries: { [messageKey(entry.msg_id)]: entry } }));
  fs.writeFileSync(payloadPath, JSON.stringify(message));
  const bodyFile = path.join(runtime, 'replies', 'synthetic-request.txt'); fs.writeFileSync(bodyFile, 'Actual reply: 检查结果\nwith exact newlines.');
  return { dir, config, entry, message, ledgerPath, payloadPath, bodyFile,
    args: { requestId: 'synthetic-request', turnId: turn, bodyFile, threadId: owner } };
}

test('reply links exact target/request/native evidence, preserves UTF-8 text and does not mutate evidence', (t) => {
  const f = fixture(t), before = [f.ledgerPath, f.payloadPath, f.bodyFile].map((p) => fs.readFileSync(p, 'utf8'));
  const reply = readClientReply(f.config, f.args);
  assert.equal(reply.target, 'codex:' + owner); assert.equal(reply.reply_to, client);
  assert.equal(reply.client_request_id, 'synthetic-request'); assert.equal(reply.native_queue_id, 'synthetic-native-queue');
  assert.equal(reply.receiving_turn_id, turn); assert.equal(reply.text, before[2]);
  assert.match(reply.evidence_grade, /^MODEL_REPORTED/);
  assert.deepEqual([f.ledgerPath, f.payloadPath, f.bodyFile].map((p) => fs.readFileSync(p, 'utf8')), before);
});

test('wrong owner, invalid actual turn or another request cannot manufacture a reply', (t) => {
  const f = fixture(t);
  for (const patch of [{ threadId: turn }, { turnId: 'latest' }, { requestId: 'another-request' }]) {
    assert.throws(() => readClientReply(f.config, { ...f.args, ...patch }));
  }
});

test('uncertain/native-unaccepted evidence and changed message/window remain blocked', (t) => {
  const f = fixture(t);
  for (const patch of [{ status: 'UNCERTAIN' }, { status: 'SUBMITTING' }, { native_queue_id: null }, { window_id: turn }]) {
    fs.writeFileSync(f.ledgerPath, JSON.stringify({ v: 1, entries: { one: { ...f.entry, ...patch } } }));
    assert.throws(() => readClientReply(f.config, f.args), /CLIENT_REPLY_NATIVE_RECEIPT_REQUIRED/);
  }
  fs.writeFileSync(f.ledgerPath, JSON.stringify({ v: 1, entries: { one: f.entry } }));
  fs.writeFileSync(f.payloadPath, JSON.stringify({ ...f.message, text: 'changed after submission' }));
  assert.throws(() => readClientReply(f.config, f.args), /CLIENT_REPLY_REQUEST_MISMATCH/);
});

test('reply cannot upload arbitrary files or oversized/binary/empty bodies', (t) => {
  const f = fixture(t), outside = path.join(f.dir, 'unrelated.txt'); fs.writeFileSync(outside, 'unrelated');
  assert.throws(() => readClientReply(f.config, { ...f.args, bodyFile: outside }), /CLIENT_REPLY_FILE_OUTSIDE_TARGET/);
  for (const [body, code] of [[Buffer.alloc(12001, 65), 'CLIENT_REPLY_TOO_LARGE'], [Buffer.from([0xff, 0xfe]), 'CLIENT_REPLY_UTF8_REQUIRED'], ['w\u0000r\u0000o\u0000n\u0000g', 'CLIENT_REPLY_UTF8_REQUIRED'], [' \n', 'CLIENT_REPLY_EMPTY']]) {
    fs.writeFileSync(f.bodyFile, body);
    assert.throws(() => readClientReply(f.config, f.args), new RegExp(code));
  }
});

test('ambiguous receipts and reply-directory link escapes are refused', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.ledgerPath, JSON.stringify({ v: 1, entries: { one: f.entry, two: { ...f.entry, msg_id: 'different-msg' } } }));
  assert.throws(() => readClientReply(f.config, f.args), /CLIENT_REPLY_REQUEST_AMBIGUOUS/);
  fs.writeFileSync(f.ledgerPath, JSON.stringify({ v: 1, entries: { one: f.entry } }));
  const outside = path.join(f.dir, 'outside-reply-root'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'unrelated.txt'), 'unrelated data');
  const link = path.join(f.config.runtime_dir, 'replies', 'linked');
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => readClientReply(f.config, { ...f.args, bodyFile: path.join(link, 'unrelated.txt') }), /CLIENT_REPLY_FILE_OUTSIDE_TARGET/);
});

function submissionFixture(t) {
  const f = fixture(t), now = Date.now();
  fs.writeFileSync(f.ledgerPath, JSON.stringify({ v: 1, entries: {} }));
  const message = { ...f.message, to_role: 'codex', created_at: new Date(now).toISOString(), expires_at: new Date(now + 60000).toISOString() };
  const inbox = new QueueInbox(f.config, { now: () => now });
  return { ...f, now, message, inbox, targets: [{ identity: message.to, enabled: true }] };
}

test('a rejected submission gate makes no native call and consumes no local budget', async (t) => {
  const f = submissionFixture(t); let calls = 0;
  const result = await f.inbox.submit(f.message, f.targets, async () => { calls++; }, {
    beforeNative: async () => ({ ok: false, reason: 'grant-revoked' }), onNativeOutcome: async () => assert.fail('no attempted outcome'),
  });
  assert.equal(result.status, 'DEFERRED'); assert.equal(calls, 0); assert.equal(f.inbox.remaining(), 6);
  assert.deepEqual(f.inbox.data.entries, {});
});

test('expiry after an asynchronous gate is a known no-call outcome, not UNCERTAIN or a replay', async (t) => {
  const f = submissionFixture(t); let calls = 0, outcome;
  f.inbox.now = () => f.now;
  const result = await f.inbox.submit(f.message, f.targets, async () => { calls++; }, {
    beforeNative: async () => { f.now += 60001; return { ok: true, dispatch }; }, onNativeOutcome: async (entry) => { outcome = entry; },
  });
  assert.equal(result.reason, 'message-expired'); assert.equal(calls, 0); assert.equal(outcome.status, 'NOT_SUBMITTED');
  assert.deepEqual(f.inbox.data.entries, {});
});

test('lost outcome acknowledgement preserves native acceptance and recovery reports without a second native submission', async (t) => {
  const f = submissionFixture(t); let calls = 0, reports = 0;
  const execute = async () => { calls++; return { stdout: `Queued message native-accepted-1 for thread ${owner}.` }; };
  await assert.rejects(f.inbox.submit(f.message, f.targets, execute, {
    beforeNative: async () => ({ ok: true, dispatch }), onNativeOutcome: async () => { reports++; throw new Error('simulated receipt loss'); },
  }), /simulated receipt loss/);
  assert.equal(f.inbox.entry(f.message.msg_id).status, 'NATIVE_QUEUED');
  const recovered = new QueueInbox(f.config, { now: () => f.now });
  const result = await recovered.submit(f.message, f.targets, execute, {
    beforeNative: async () => assert.fail('must not begin another native submission'),
    onNativeOutcome: async (entry, context) => { reports++; assert.equal(entry.native_queue_id, 'native-accepted-1'); assert.equal(context.replay, true); },
  });
  assert.equal(result.replay, true); assert.equal(calls, 1); assert.equal(reports, 2);
  assert.equal(result.client_request_id, 'synthetic-request');
  const changed = { ...f.message, meta: { client_request_id: 'same-text-different-request' } };
  await assert.rejects(recovered.submit(changed, f.targets, execute), /msg-id-content-conflict/);
});

test('reply RPC keeps the real operator connection, binds all correlation fields and emits metadata only', async (t) => {
  const f = fixture(t), payload = readClientReply(f.config, f.args); let frame;
  const q = { welcomeInfo: { capabilities: { client_requests_v1: true } }, request: async (input) => {
    frame = input;
    return { type: 'client-reply-result', ok: true, idempotent: true,
      request: { request_id: payload.client_request_id, request_msg_id: payload.msg_id, target_identity: payload.target, client_identity: payload.reply_to },
      reply: { reply_msg_id: 'reply-1', body_sha256: payload.text_sha256, bytes: Buffer.byteLength(payload.text), turn_id: turn } };
  } };
  const result = await postClientReply(q, payload);
  assert.equal(frame.type, 'client-reply'); assert.equal(frame.client_request_id, payload.client_request_id);
  assert.equal(frame.target_identity, payload.target); assert.equal(frame.request_msg_id, payload.msg_id);
  assert.equal(frame.body, payload.text); assert.equal(frame.from, undefined); assert.equal(frame.role, undefined);
  assert.equal(result.action, 'CLIENT_REPLY_RECORDED'); assert.equal(result.body, undefined);
  assert.equal(result.text, undefined); assert.equal(result.idempotent, true);
});

test('UTF-8 BOM is preserved in the transmitted text and hash rather than silently producing a hash mismatch', (t) => {
  const f = fixture(t), bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('reply with BOM')]);
  fs.writeFileSync(f.bodyFile, bytes);
  const payload = readClientReply(f.config, f.args);
  assert.equal(payload.text.charCodeAt(0), 0xfeff);
  assert.equal(crypto.createHash('sha256').update(payload.text).digest('hex'), payload.text_sha256);
  assert.equal(Buffer.byteLength(payload.text), bytes.length);
});

test('old Hub capability or a mismatched reply receipt is not reported as success', async (t) => {
  const f = fixture(t), payload = readClientReply(f.config, f.args); let calls = 0;
  await assert.rejects(postClientReply({ request: async () => { calls++; } }, payload), /CLIENT_REQUEST_PROTOCOL_REQUIRED/);
  assert.equal(calls, 0);
  await assert.rejects(postClientReply({ welcomeInfo: { capabilities: { client_requests_v1: true } }, request: async () => ({
    type: 'client-reply-result', ok: true, request: { request_id: 'another-request' }, reply: { reply_msg_id: 'reply-1' },
  }) }, payload), /CLIENT_REPLY_RECEIPT_MISMATCH/);
});

function operatorFixture(f, { corruptClaim = false, beginError = null } = {}) {
  const frames = [], base = { request_id: 'synthetic-request', client_identity: client,
    target_identity: 'codex:' + owner, request_msg_id: f.message.msg_id };
  return { frames, q: { welcomeInfo: { capabilities: { client_requests_v1: true } }, request: async (frame) => {
    frames.push(frame);
    if (frame.type === 'client-claim') return { type: 'client-claim-result', ok: true,
      request: { ...base, state: 'CLAIMED', body_sha256: corruptClaim ? 'b'.repeat(64) : crypto.createHash('sha256').update(f.message.text).digest('hex') },
      lease: { id: dispatch.lease_id, fencing_token: dispatch.fencing_token, owner_identity: 'codex:' + owner, expires_at: new Date(Date.now() + 30000).toISOString() } };
    if (frame.type === 'client-begin-submit') {
      if (beginError) throw Object.assign(new Error(beginError), { code: beginError });
      return { type: 'client-begin-submit-result', ok: true, request: { ...base, state: 'SUBMITTING' },
        lease: { id: dispatch.lease_id, fencing_token: dispatch.fencing_token } };
    }
    if (frame.type === 'client-outcome') return { type: 'client-outcome-result', ok: true,
      request: { ...base, state: frame.status, native_queue_id: frame.native_queue_id } };
    assert.fail('unexpected operator RPC');
  } } };
}

test('dispatch verifies core body/route and commits a fenced begin before native execution', async (t) => {
  const f = submissionFixture(t), op = operatorFixture(f); let calls = 0;
  const hooks = clientDispatchHooks({ client: op.q, config: f.config, message: f.message });
  const result = await f.inbox.submit(f.message, f.targets, async () => {
    calls++; assert.deepEqual(op.frames.map((x) => x.type), ['client-claim', 'client-begin-submit']);
    return { stdout: `Queued message native-1 for thread ${owner}.` };
  }, hooks);
  assert.equal(result.status, 'NATIVE_QUEUED'); assert.deepEqual(result.client_dispatch, dispatch); assert.equal(calls, 1);
  assert.equal(op.frames.at(-1).status, 'NATIVE_QUEUED');
});

test('invalid claim evidence or grant revocation at begin never invokes native', async (t) => {
  const f = submissionFixture(t); let calls = 0;
  const bad = operatorFixture(f, { corruptClaim: true });
  await assert.rejects(f.inbox.submit(f.message, f.targets, async () => { calls++; },
    clientDispatchHooks({ client: bad.q, config: f.config, message: f.message })), /CLIENT_DISPATCH_RECEIPT_MISMATCH/);
  assert.equal(bad.frames.some((x) => x.type === 'client-begin-submit'), false);
  const revoked = operatorFixture(f, { beginError: 'client-grant-revoked' });
  const result = await f.inbox.submit(f.message, f.targets, async () => { calls++; },
    clientDispatchHooks({ client: revoked.q, config: f.config, message: f.message }));
  assert.equal(result.reason, 'client-grant-revoked'); assert.equal(calls, 0); assert.deepEqual(f.inbox.data.entries, {});
});

test('a busy target discovered after begin reports a known no-native outcome without forging a native receipt', async (t) => {
  const f = submissionFixture(t), op = operatorFixture(f); let checks = 0, calls = 0;
  const result = await f.inbox.submit(f.message, f.targets, async () => { calls++; }, clientDispatchHooks({
    client: op.q, config: f.config, message: f.message, isReady: () => ++checks < 3,
  }));
  assert.equal(result.reason, 'BUSY_OR_DISABLED_BEFORE_SUBMIT'); assert.equal(calls, 0);
  assert.equal(op.frames.at(-1).status, 'NOT_SUBMITTED'); assert.equal(op.frames.at(-1).native_queue_id, null);
  assert.deepEqual(f.inbox.data.entries, {});
});

test('a busy target after claim releases the request as a known no-call without beginning submission', async (t) => {
  const f = submissionFixture(t), op = operatorFixture(f); let checks = 0, calls = 0;
  const result = await f.inbox.submit(f.message, f.targets, async () => { calls++; }, clientDispatchHooks({
    client: op.q, config: f.config, message: f.message, isReady: () => ++checks < 2,
  }));
  assert.equal(result.reason, 'BUSY_OR_DISABLED_BEFORE_SUBMIT'); assert.equal(calls, 0);
  assert.deepEqual(op.frames.map((x) => x.type), ['client-claim', 'client-outcome']);
  assert.equal(op.frames.at(-1).status, 'NOT_SUBMITTED'); assert.deepEqual(f.inbox.data.entries, {});
});

test('native errors keep typed evidence without copying raw command text, output or credential-like stderr into receipts', async (t) => {
  const f = submissionFixture(t), op = operatorFixture(f), privateValue = 'synthetic-credential-MUST-NOT-LEAK';
  const result = await f.inbox.submit(f.message, f.targets, async () => {
    throw Object.assign(new Error('Command failed with ' + privateValue), { code: 1, stdout: 'unrecognized ' + privateValue, stderr: privateValue });
  }, clientDispatchHooks({ client: op.q, config: f.config, message: f.message }));
  assert.equal(result.status, 'UNCERTAIN'); assert.equal(result.diagnostic.code, 1);
  assert.equal(result.diagnostic.stderr_bytes, Buffer.byteLength(privateValue));
  assert.equal(JSON.stringify(result).includes(privateValue), false);
  assert.equal(JSON.stringify(op.frames).includes(privateValue), false);
});
