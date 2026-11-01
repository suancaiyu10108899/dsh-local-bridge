// Real isolated core TCP/auth/state with an inert native executor: no production
// queue, model call, credential, owner database, or application restart.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HubClient as ReceiverHubClient } from '../src/client.mjs';
import { QueueInbox, messageKey } from '../adapters/codex/queue-inbox.mjs';
import { dailyTick } from '../adapters/codex/daily-receiver.mjs';
import { readClientReply, postClientReply } from '../adapters/codex/client-reply.mjs';

// A standalone receiver source export has its own shared client snapshot, but
// not the core server. Keep its unit suite runnable and label these checks as
// requiring the complete repository rather than silently mocking the core.
const hasCore = fs.existsSync(new URL('../../src/hub.mjs', import.meta.url));
const core = hasCore ? await Promise.all([import('../../src/hub.mjs'), import('../../src/store.mjs'),
  import('../../src/client.mjs'), import('../../src/client-access.mjs')]) : [];
const BridgeHub = core[0]?.BridgeHub, HubStore = core[1]?.HubStore,
  HubClient = core[2]?.HubClient, createClientGrant = core[3]?.createClientGrant;
const integration = (name, body) => test(name, { skip: hasCore ? false : 'requires full core repository' }, body);

const execute = promisify(execFile);
const owner = '33333333-3333-4333-8333-333333333333';
const clientIdentity = 'client:dot-22222222-2222-4222-8222-222222222222';
const turn = '44444444-4444-4444-8444-444444444444';
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-client-integration-'));
  const root = path.join(dir, 'runtime'), token = crypto.randomBytes(32).toString('hex');
  const store = new HubStore({ stateFile: path.join(root, 'hub/state.json'), eventsFile: path.join(root, 'hub/events.jsonl') }).load();
  const target = 'codex:' + owner; store.addTarget(target);
  const grant = createClientGrant({ runtimeDir: root, clientIdentity, targets: [target], maxRequests: 4, maxSubmits: 4 });
  const hub = new BridgeHub({ store, token, runtimeRoot: root }); const address = await hub.start();
  fs.writeFileSync(path.join(root, 'hub/config.json'), JSON.stringify({ v: 1, host: '127.0.0.1', port: address.port }));
  // Deliberately no base-token file: a scoped client needs only its own credential.
  const clients = [];
  t.after(async () => {
    for (const c of clients) await c.close(); await hub.stop();
    const absolute = path.resolve(dir);
    assert.ok(absolute.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(absolute).startsWith('lab-client-integration-'));
    fs.rmSync(absolute, { recursive: true, force: true });
  });
  const options = { host: '127.0.0.1', port: address.port, token };
  const operator = new HubClient({ ...options, role: 'cli', identity: 'cli:operator' }); clients.push(operator); await operator.connect();
  const scoped = new HubClient({ ...options, token: fs.readFileSync(grant.credential_file, 'utf8').trim(),
    role: 'client', identity: clientIdentity, grantId: grant.grant_id }); clients.push(scoped); await scoped.connect();
  const runtime = path.join(root, 'codex', owner); fs.mkdirSync(runtime, { recursive: true });
  const config = { v: 2, mode: 'daily', enabled: true, transport: 'target-pull', thread_id: owner,
    allowed_senders: [], allowed_clients: [clientIdentity], cli: path.join(dir, 'inert-codex.exe'), cli_sha256: 'a'.repeat(64),
    workspace: dir, rollout_path: path.join(dir, 'synthetic-rollout.jsonl'), state_db: path.join(dir, 'synthetic-state.sqlite'),
    runtime_dir: runtime, activated_at: new Date(Date.now() - 10000).toISOString(), expires_at: null, window_id: owner,
    rate_limit: { max_submissions: 6, window_ms: 3600000 }, min_interval_ms: 30000,
    idle_settle_ms: 3000, poll_interval_ms: 2000, max_text_bytes: 12000, accept_backlog: true };
  const inbox = new QueueInbox(config), idle = () => [{ type: 'task_complete', timestamp: new Date(Date.now() - 5000).toISOString() }];
  return { dir, root, store, hub, clients, operator, scoped, options, config, inbox, idle, target, grant };
}

integration('isolated scoped request crosses the native gate once and returns an exact correlated owner-reported reply', async (t) => {
  const f = await fixture(t); let calls = 0;
  const accepted = await f.scoped.clientRequest({ clientRequestId: 'integration-request', to: f.target, text: 'Review and report only', ttlMs: 60000 });
  const result = await dailyTick({ config: f.config, inbox: f.inbox, hubOptions: f.options, lifecycle: f.idle,
    executeNative: async (_file, args) => { calls++; assert.ok(args.at(-1).includes('integration-request')); return { stdout: `Queued message integration-native-1 for thread ${owner}.` }; } });
  assert.equal(result.status, 'NATIVE_QUEUED_NOT_MODEL_PROOF'); assert.equal(calls, 1);
  assert.equal(f.inbox.entry(accepted.msg_id).client_request_id, 'integration-request');
  fs.mkdirSync(path.join(f.config.runtime_dir, 'replies'));
  const bodyFile = path.join(f.config.runtime_dir, 'replies', messageKey('integration-request') + '.txt');
  fs.writeFileSync(bodyFile, 'A bounded synthetic assessment. No project changes.');
  const payload = readClientReply(f.config, { requestId: 'integration-request', turnId: turn, bodyFile, threadId: owner });
  const reply = await postClientReply(f.operator, payload);
  const fetched = await f.scoped.clientResume('integration-request');
  assert.equal(fetched.reply.body, payload.text); assert.equal(fetched.reply.request_msg_id, accepted.msg_id);
  assert.equal(fetched.reply.target_identity, f.target); assert.equal(reply.reply_msg_id, fetched.reply.reply_msg_id);
  const replay = await postClientReply(f.operator, payload);
  assert.equal(replay.reply_msg_id, reply.reply_msg_id); assert.equal(replay.idempotent, true);
  assert.equal(calls, 1);
});

integration('a busy target stays unsubmitted and the scoped caller can cancel the same queued request', async (t) => {
  const f = await fixture(t); let calls = 0;
  const accepted = await f.scoped.clientRequest({ clientRequestId: 'cancel-while-busy', to: f.target, text: 'Wait for original target', ttlMs: 60000 });
  const busy = await dailyTick({ config: f.config, inbox: f.inbox, hubOptions: f.options,
    lifecycle: () => [{ type: 'task_started', timestamp: new Date().toISOString() }], executeNative: async () => { calls++; } });
  assert.equal(busy.status, 'WAITING_FOR_TARGET_IDLE');
  assert.equal((await f.scoped.clientCancel('cancel-while-busy')).state, 'CANCELLED');
  assert.equal(calls, 0); assert.deepEqual(f.inbox.data.entries, {});
  assert.notEqual(f.store.getMessage(accepted.msg_id).state, 'delivered');
});

integration('the real scoped CLI authenticates without reading or creating the base Hub token file', async (t) => {
  const f = await fixture(t), textFile = path.join(f.dir, 'request.txt'); fs.writeFileSync(textFile, 'One scoped CLI request');
  const result = await execute(process.execPath, [path.resolve(import.meta.dirname, '../../bin/lab-bridge.mjs'),
    'client', 'request', '--runtime', f.root, '--grant', f.grant.grant_id, '--credential-file', f.grant.credential_file,
    '--to', f.target, '--request-id', 'cli-no-admin-token', '--text-file', textFile], { windowsHide: true, timeout: 15000 });
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true); assert.equal(output.request_id, 'cli-no-admin-token');
  assert.equal(fs.existsSync(path.join(f.root, 'hub/token')), false);
});

integration('a lost outcome ACK recovers from the saved native receipt after restart without invoking native again', async (t) => {
  const f = await fixture(t); let calls = 0, lost = false;
  const accepted = await f.scoped.clientRequest({ clientRequestId: 'outcome-ack-lost', to: f.target, text: 'Report only', ttlMs: 60000 });
  const original = ReceiverHubClient.prototype.request;
  t.after(() => { ReceiverHubClient.prototype.request = original; });
  ReceiverHubClient.prototype.request = async function (frame, ...args) {
    const result = await original.call(this, frame, ...args);
    if (frame.type === 'client-outcome' && !lost) { lost = true; throw Object.assign(new Error('synthetic ACK loss'), { code: 'ETIMEDOUT' }); }
    return result;
  };
  const executeNative = async () => { calls++; return { stdout: `Queued message ack-lost-native for thread ${owner}.` }; };
  await assert.rejects(dailyTick({ config: f.config, inbox: f.inbox, hubOptions: f.options,
    lifecycle: f.idle, executeNative }), { code: 'ETIMEDOUT' });
  const restarted = new QueueInbox(f.config);
  assert.equal(restarted.entry(accepted.msg_id).status, 'NATIVE_QUEUED');
  const result = await dailyTick({ config: f.config, inbox: restarted, hubOptions: f.options,
    lifecycle: () => [{ type: 'task_started', timestamp: new Date().toISOString() }], executeNative });
  assert.equal(result.status, 'WAITING_FOR_TARGET_IDLE');
  assert.equal(calls, 1); assert.ok(restarted.entry(accepted.msg_id).hub_consumed_at);
  assert.equal((await f.scoped.clientStatus('outcome-ack-lost')).state, 'NATIVE_QUEUED');
});

integration('becoming busy just before native leaves a terminal known no-call and no receiver submission ledger', async (t) => {
  const f = await fixture(t); let checks = 0, calls = 0;
  const accepted = await f.scoped.clientRequest({ clientRequestId: 'busy-after-begin', to: f.target, text: 'Report only', ttlMs: 60000 });
  const result = await dailyTick({ config: f.config, inbox: f.inbox, hubOptions: f.options, lifecycle: f.idle,
    beforeSubmit: () => ++checks < 4, executeNative: async () => { calls++; } });
  assert.equal(result.status, 'WAITING_CLIENT_AUTHORIZATION');
  assert.equal((await f.scoped.clientStatus('busy-after-begin')).state, 'NOT_SUBMITTED');
  assert.equal(calls, 0); assert.deepEqual(f.inbox.data.entries, {});
  // Terminal no-call must not remain a live queue head that poisons the receiver.
  assert.equal(f.store.getMessage(accepted.msg_id).state, 'failed');
  f.inbox.clientDeferrals.clear();
  const next = await dailyTick({ config: f.config, inbox: f.inbox, hubOptions: f.options, lifecycle: f.idle,
    executeNative: async () => { calls++; } });
  assert.equal(next.status, 'ONLINE_IDLE'); assert.equal(calls, 0);
});

integration('a legacy role-wide Codex adapter never receives restricted client requests', async (t) => {
  const f = await fixture(t); let deliveries = 0, native = 0;
  const legacy = new HubClient({ ...f.options, role: 'codex', identity: f.target }); f.clients.push(legacy);
  legacy.onDelivery((_m, d) => { deliveries++; d.ack({ ok: true }); }); await legacy.connect();
  await f.scoped.clientRequest({ clientRequestId: 'no-legacy-push', to: f.target, text: 'Only the scoped receiver may submit', ttlMs: 60000 });
  await f.operator.request({ type: 'ping' }); // Request barrier, not a model poll.
  const result = await dailyTick({ config: f.config, inbox: f.inbox, hubOptions: f.options,
    lifecycle: f.idle, executeNative: async () => { native++; } });
  assert.equal(result.status, 'BLOCKED_OTHER_ADAPTER');
  assert.equal(deliveries, 0); assert.equal(native, 0);
  assert.equal((await f.scoped.clientStatus('no-legacy-push')).state, 'QUEUED');
});

integration('unpairing after claim is rejected again at the native begin boundary', async (t) => {
  const f = await fixture(t); let calls = 0;
  await f.scoped.clientRequest({ clientRequestId: 'unpair-before-begin', to: f.target, text: 'Report only', ttlMs: 60000 });
  const original = ReceiverHubClient.prototype.request;
  t.after(() => { ReceiverHubClient.prototype.request = original; });
  ReceiverHubClient.prototype.request = async function (frame, ...args) {
    if (frame.type === 'client-begin-submit') f.store.removeTarget(f.target);
    return original.call(this, frame, ...args);
  };
  const result = await dailyTick({ config: f.config, inbox: f.inbox, hubOptions: f.options, lifecycle: f.idle,
    executeNative: async () => { calls++; return { stdout: `Queued message must-not-submit for thread ${owner}.` }; } });
  assert.equal(result.reason_code, 'client-begin-target-unpaired'); assert.equal(calls, 0);
  assert.deepEqual(f.inbox.data.entries, {});
});
