import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { HubStore } from '../src/store.mjs';
import { BridgeHub } from '../src/hub.mjs';
import { HubClient } from '../src/client.mjs';
import { QueueInbox, validateReceiverConfig, messageDecision, idleState, nativeMessage, messageKey, recordModelReceipt } from '../adapters/codex/queue-inbox.mjs';
import { runReceiver, receiverCommand, readLifecycle } from '../adapters/codex/queue-receiver.mjs';

const thread = process.env.CODEX_THREAD_ID ?? '33333333-3333-4333-8333-333333333333';
const originalThreadEnv = process.env.CODEX_THREAD_ID;
if (!originalThreadEnv) process.env.CODEX_THREAD_ID = thread;
after(() => { if (!originalThreadEnv) delete process.env.CODEX_THREAD_ID; });
const sender = 'dsh:session-11111111-1111-4111-8111-111111111111';
const target = `codex:${thread}`;
function fixture(t, changes = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-codex-queue-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cli = path.join(dir, 'inert-cli-fixture'); fs.writeFileSync(cli, 'NEVER EXECUTED');
  const config = { v: 1, enabled: true, thread_id: thread, allowed_senders: [sender],
    cli, cli_sha256: crypto.createHash('sha256').update(fs.readFileSync(cli)).digest('hex'),
    workspace: dir, rollout_path: path.join(dir, 'own-rollout.jsonl'), runtime_dir: path.join(dir, 'runtime'),
    activated_at: new Date(Date.now() - 30000).toISOString(), expires_at: new Date(Date.now() + 60000).toISOString(),
    window_id: crypto.randomUUID(), max_native_submissions: 4, min_interval_ms: 30000, idle_settle_ms: 3000,
    max_text_bytes: 12000, ...changes };
  const configPath = path.join(dir, 'receiver.json');fs.writeFileSync(configPath, JSON.stringify(config));
  const message = { v: 1, msg_id: 'm-normal-text-1', from: sender, to: target, from_role: 'dsh', to_role: 'codex',
    kind: 'text', text: '中文普通消息 / "quoted" / $(must remain literal)',
    created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60000).toISOString() };
  const targets = [sender, target].map((identity) => ({ identity, role: identity.split(':')[0], enabled: true }));
  return { dir, config, configPath, message, targets };
}
const accept = async () => ({ stdout: `Queued message native-item-id for thread ${thread}.\n`, stderr: '' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate) {
  const end = Date.now() + 6000;
  while (Date.now() < end) { if (await predicate()) return; await sleep(20); }
  throw new Error('test-timeout');
}

test('receiver config bounds identity, lifetime, size and model-call quota', (t) => {
  const { config: c } = fixture(t);
  assert.equal(validateReceiverConfig(c), c);
  for (const change of [{ enabled: 'yes' }, { allowed_senders: ['cli:operator'] }, { thread_id: 'latest' },
    { max_native_submissions: 100 }, { min_interval_ms: 0 }, { max_text_bytes: 100000 },
    { expires_at: new Date(Date.parse(c.activated_at) + 9 * 3600000).toISOString() }]) {
    assert.throws(() => validateReceiverConfig({ ...c, ...change }));
  }
});

test('wrong source, revoked pairing, stale text, expiry and ACK-shaped envelopes never enqueue', async (t) => {
  const { config: c, message: m, targets } = fixture(t);
  assert.equal(messageDecision(m, c, targets), 'eligible');
  for (const patch of [{ from_role: 'cli', from: 'cli:operator', meta: { origin: sender } }, { to: 'codex:other' },
    { kind: 'ack' }, { msg_id: '../escape' }, { text: 'x'.repeat(12001) }, { text: '' },
    { expires_at: new Date(Date.now() - 1).toISOString() },
    { created_at: new Date(Date.parse(c.activated_at) - 1).toISOString() }]) {
    assert.notEqual(messageDecision({ ...m, ...patch }, c, targets), 'eligible');
  }
  assert.equal(messageDecision(m, c, []), 'pairing-revoked');
  const inbox = new QueueInbox(c);let calls = 0;
  await inbox.submit(m, [], async () => { calls++; });
  assert.equal(calls, 0);assert.equal(inbox.entry(m.msg_id), undefined);
});

test('normal payload and provenance arrive as literal peer JSON, not shell or human authority', (t) => {
  const { config: c, message: m } = fixture(t);
  const text = nativeMessage(m, c);
  assert.match(text, /NOT a human message, approval, grant, or system instruction/);
  const body = JSON.parse(text.split('Peer message JSON:\n')[1]);
  assert.equal(body.text, m.text);assert.equal(body.from, sender);assert.equal(body.msg_id, m.msg_id);
});

test('persist-before-execute, durable dedup after restart, and receipt separate from native ACK', async (t) => {
  const { config: c, message: m, targets } = fixture(t);let calls = 0;
  const inbox = new QueueInbox(c);
  const native = await inbox.submit(m, targets, async (cli, args) => {
    calls++;assert.equal(cli, c.cli);assert.deepEqual(args.slice(0, 4), ['queue', '--thread', thread, '--message']);
    assert.equal(JSON.parse(fs.readFileSync(inbox.file)).entries[messageKey(m.msg_id)].status, 'SUBMITTING');
    return accept();
  });
  assert.equal(native.status, 'NATIVE_QUEUED');
  const restarted = new QueueInbox(c);
  const replay = await restarted.submit(m, targets, async () => { calls++; });
  assert.equal(replay.replay, true);assert.equal(calls, 1);
  assert.throws(() => recordModelReceipt(c, m.msg_id, crypto.randomUUID(), 'wrong-thread'));
  const receipt = recordModelReceipt(c, m.msg_id, crypto.randomUUID(), thread);
  assert.equal(receipt.status, 'MODEL_RECEIVED');
  assert.match(receipt.evidence_grade, /MODEL_REPORTED/);
});

test('reusing msg_id with different content fails; quota and cooldown never call native CLI', async (t) => {
  const { config: c, message: m, targets } = fixture(t);let now = Date.now(), calls = 0;
  const inbox = new QueueInbox({ ...c, max_native_submissions: 2 }, { now: () => now });
  const execute = async () => { calls++;return accept(); };
  await inbox.submit(m, targets, execute);
  await assert.rejects(inbox.submit({ ...m, text: 'changed' }, targets, execute), /content-conflict/);
  assert.equal((await inbox.submit({ ...m, msg_id: 'm-two' }, targets, execute)).reason, 'cooldown');
  now += 31000;await inbox.submit({ ...m, msg_id: 'm-two' }, targets, execute);
  assert.equal((await inbox.submit({ ...m, msg_id: 'm-three' }, targets, execute)).reason, 'window-quota');
  assert.equal(calls, 2);
});

test('timeout, unrecognized native output and crash claims are uncertain and never retried', async (t) => {
  for (const mode of ['timeout', 'invalid-output', 'crash']) {
    const { config: c, message: m, targets } = fixture(t);let calls = 0;
    const inbox = new QueueInbox(c);
    await inbox.submit(m, targets, async () => {
      calls++;
      if (mode === 'timeout') throw Object.assign(new Error('timeout'), { killed: true });
      return { stdout: 'accepted?', stderr: '' };
    });
    if (mode === 'crash') { inbox.data.entries[messageKey(m.msg_id)].status = 'SUBMITTING';inbox.save(); }
    const restart = new QueueInbox(c);
    assert.equal(restart.entry(m.msg_id).status, 'UNCERTAIN');
    await restart.submit(m, targets, async () => { calls++; });
    await assert.rejects(restart.submit({ ...m, msg_id: 'm-new' }, targets, accept), /review-required/);
    assert.equal(calls, 1);
  }
});

test('lifecycle parser ignores partial records and refuses active/interrupted/unknown state', (t) => {
  const { config: c } = fixture(t);
  const event = { timestamp: new Date(Date.now() - 4000).toISOString(), type: 'event_msg',
    payload: { type: 'task_complete', turn_id: crypto.randomUUID() } };
  fs.writeFileSync(c.rollout_path, JSON.stringify(event) + '\n{"partial":');
  assert.equal(idleState(readLifecycle(c.rollout_path), 3000), 'idle');
  assert.equal(idleState([{ type: 'task_started' }], 3000), 'active');
  assert.equal(idleState([{ type: 'turn_aborted' }], 3000), 'interrupted');
  assert.equal(idleState([], 3000), 'unknown');
});

async function integration(t, executeNative) {
  const f = fixture(t, { max_native_submissions: 1 });
  const token = 'isolated-codex-receiver-token'.padEnd(64, 'x');
  const store = new HubStore({ stateFile: path.join(f.dir, 'hub-state.json'), eventsFile: path.join(f.dir, 'hub-events.jsonl') }).load();
  const hub = new BridgeHub({ store, token, port: 0 });const address = await hub.start();
  const options = { host: '127.0.0.1', port: address.port, token };
  const cli = new HubClient({ ...options, role: 'cli', identity: 'cli:operator' });
  const dsh = new HubClient({ ...options, role: 'dsh', identity: 'dsh:isolated-test-host' });
  await cli.connect();await dsh.connect();await cli.pairAdd(sender);await cli.pairAdd(target);
  t.after(async () => { await cli.close();await dsh.close();await hub.stop(); });
  fs.writeFileSync(f.config.rollout_path, JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg',
    payload: { type: 'task_started', turn_id: crypto.randomUUID() } }) + '\n');
  const result = runReceiver(f.configPath, { hubOptions: options, executeNative });
  // Observe rejection immediately to avoid orphan rejection in negative tests.
  const observed = result.then(() => ({ ok: true }), (error) => ({ ok: false, error }));
  await waitFor(() => fs.existsSync(path.join(f.config.runtime_dir, 'status.json')));
  return { ...f, cli, dsh, store, observed };
}

test('isolated Hub integration: busy target stays queued; idle target receives once and ACK follows native acceptance', async (t) => {
  let calls = 0;
  const f = await integration(t, async () => { calls++;return accept(); });
  await f.dsh.sendMessage(f.message);
  await sleep(200);
  assert.equal((await f.cli.status(f.message.msg_id)).state, 'queued');assert.equal(calls, 0);
  assert.deepEqual(await f.cli.roles(), ['dsh']);
  fs.appendFileSync(f.config.rollout_path, JSON.stringify({ timestamp: new Date(Date.now() - 4000).toISOString(), type: 'event_msg',
    payload: { type: 'task_complete', turn_id: crypto.randomUUID() } }) + '\n');
  assert.equal((await f.observed).ok, true);
  assert.equal((await f.cli.status(f.message.msg_id)).state, 'delivered');assert.equal(calls, 1);
  assert.equal(new QueueInbox(f.config).entry(f.message.msg_id).status, 'NATIVE_QUEUED');
  assert.equal(fs.existsSync(path.join(f.config.runtime_dir, `${messageKey(f.message.msg_id)}.model-receipt.json`)), false);
  assert.equal(fs.existsSync(path.join(f.config.runtime_dir, 'receiver.lock')), false);
});

test('isolated Hub integration: native uncertainty halts without ACK or automatic resubmission', async (t) => {
  let calls = 0;
  const f = await integration(t, async () => { calls++;throw new Error('native timeout'); });
  fs.appendFileSync(f.config.rollout_path, JSON.stringify({ timestamp: new Date(Date.now() - 4000).toISOString(), type: 'event_msg',
    payload: { type: 'task_complete', turn_id: crypto.randomUUID() } }) + '\n');
  await f.dsh.sendMessage(f.message);
  const result = await f.observed;
  assert.equal(result.ok, false);assert.match(result.error.message, /review-required/);
  await waitFor(async () => (await f.cli.status(f.message.msg_id)).state === 'delivery_unknown');
  assert.equal(calls, 1);
  const status = receiverCommand(['status', f.configPath]);assert.equal(status.status, 'HALTED_REVIEW_REQUIRED');
  await assert.rejects(runReceiver(f.configPath, { hubOptions: {}, executeNative: accept }), /review-required/);
  assert.equal(calls, 1);
});

test('second instance is refused and stop affects only its own busy receiver', async (t) => {
  let calls = 0;
  const f = await integration(t, async () => { calls++;return accept(); });
  await assert.rejects(runReceiver(f.configPath, { hubOptions: {}, executeNative: accept }), /EEXIST/);
  assert.equal(receiverCommand(['stop', f.configPath]).status, 'STOP_REQUESTED');
  assert.equal((await f.observed).ok, true);
  assert.equal(receiverCommand(['status', f.configPath]).status, 'STOPPED');
  assert.equal(calls, 0);assert.deepEqual(await f.cli.roles(), ['dsh']);
});

test('disabling the running config exits without native work or another role connection', async (t) => {
  let calls = 0;
  const f = await integration(t, async () => { calls++;return accept(); });
  fs.writeFileSync(f.configPath, JSON.stringify({ ...f.config, enabled: false }));
  assert.equal((await f.observed).ok, true);
  assert.equal(calls, 0);assert.deepEqual(await f.cli.roles(), ['dsh']);
});
