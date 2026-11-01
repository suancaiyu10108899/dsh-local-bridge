import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { QueueInbox, messageDecision, nativeMessage } from '../adapters/codex/queue-inbox.mjs';
import { dailyTick } from '../adapters/codex/daily-receiver.mjs';
import { HubStore } from '../src/store.mjs';
import { BridgeHub } from '../src/hub.mjs';
import { HubClient } from '../src/client.mjs';
import { createTargetBindingStamper } from '../src/target-binding.mjs';
import { registerMembershipEnable } from '../src/membership.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-receiver-epoch-'));
  t.after(() => {
    const absolute = path.resolve(dir);
    assert.ok(absolute.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(absolute).startsWith('lab-receiver-epoch-'));
    fs.rmSync(absolute, { recursive: true, force: true });
  });
  const thread = crypto.randomUUID(), sender = 'dsh:session-11111111-1111-4111-8111-111111111111';
  const c = { enabled: true, mode: 'daily', thread_id: thread, runtime_dir: dir, window_id: crypto.randomUUID(),
    installation_id: 'synthetic-installed-fixture', binding_epoch: crypto.randomUUID(), cli: 'inert-fixture-not-executed',
    allowed_senders: [sender], accept_backlog: true, activated_at: new Date(Date.now() - 10000).toISOString(),
    max_text_bytes: 12000, rate_limit: { max_submissions: 6, window_ms: 3600000 }, min_interval_ms: 30000 };
  const m = { msg_id: 'm-installed-epoch', from: sender, from_role: 'dsh', to: 'codex:' + thread, to_role: 'codex',
    kind: 'text', text: '中文 / "quoted" / \\literal', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600000).toISOString() };
  const targets = [sender, m.to].map((identity) => ({ identity, enabled: true }));
  return { c, m, targets };
}

test('installed receivers retain unstamped and old-generation backlog without native submission', async (t) => {
  const { c, m, targets } = fixture(t), inbox = new QueueInbox(c); let calls = 0;
  const execute = async () => { calls++; throw new Error('must not submit'); };
  assert.equal(messageDecision(m, c, targets), 'binding-epoch-missing');
  assert.equal((await inbox.submit(m, targets, execute)).reason, 'binding-epoch-missing');
  assert.equal((await inbox.submit({ ...m, meta: { target_binding_epoch: crypto.randomUUID() } }, targets, execute)).reason, 'binding-epoch-mismatch');
  assert.equal(calls, 0); assert.equal(Object.keys(inbox.data.entries).length, 0);
});

test('matching server epoch preserves exact text and appears separately in peer metadata', async (t) => {
  const { c, m, targets } = fixture(t), stamped = { ...m, meta: { target_binding_epoch: c.binding_epoch } }, inbox = new QueueInbox(c); let calls = 0;
  const result = await inbox.submit(stamped, targets, async (_cli, args) => {
    calls++; const body = JSON.parse(args[4].split('Peer message JSON:\n')[1]);
    assert.equal(body.text, m.text); assert.equal(body.target_binding_epoch, c.binding_epoch);
    return { stdout: 'Queued message fixture-queue for thread ' + c.thread_id + '.' };
  });
  assert.equal(result.status, 'NATIVE_QUEUED'); assert.equal(calls, 1);
  const rebound = new QueueInbox({ ...c, binding_epoch: crypto.randomUUID() });
  assert.equal((await rebound.submit(stamped, targets, async () => { calls++; })).reason, 'binding-epoch-mismatch');
  assert.equal(calls, 1); assert.equal(Object.keys(rebound.data.entries).length, 1);
});

test('explicit legacy configurations keep their existing unstamped message semantics', (t) => {
  const { c, m, targets } = fixture(t); delete c.installation_id;
  assert.equal(messageDecision(m, c, targets), 'eligible');
  assert.equal(JSON.parse(nativeMessage(m, c).split('Peer message JSON:\n')[1]).text, m.text);
});

test('an old Hub cannot authorize installed delivery by accepting a self-reported epoch', async (t) => {
  const { c, m, targets } = fixture(t); c.instance_id = 'synthetic-instance'; c.idle_settle_ms = 3000;
  const token = crypto.randomBytes(32).toString('hex');
  const store = new HubStore({ stateFile: path.join(c.runtime_dir, 'hub-state.json'), eventsFile: path.join(c.runtime_dir, 'hub-events.jsonl') }).load();
  const hub = new BridgeHub({ store, token, port: 0 }), address = await hub.start(); let q, dsh, calls = 0;
  const options = { host: '127.0.0.1', port: address.port, token };
  try {
    q = new HubClient({ ...options, role: 'cli', identity: 'cli:operator' }); await q.connect();
    dsh = new HubClient({ ...options, role: 'dsh', identity: 'dsh:isolated-epoch-host' }); await dsh.connect();
    for (const target of targets) await q.pairAdd(target.identity);
    await dsh.sendMessage({ ...m, v: 1, meta: { target_binding_epoch: c.binding_epoch } });
    const result = await dailyTick({ config: c, inbox: new QueueInbox(c), hubOptions: options,
      lifecycle: () => [{ type: 'task_complete', timestamp: new Date(Date.now() - 5000).toISOString() }],
      executeNative: async () => { calls++; throw new Error('native must not run'); } });
    assert.equal(result.status, 'PAUSED_PROTOCOL_BINDING_REQUIRED'); assert.equal(calls, 0);
    assert.equal((await q.status(m.msg_id)).state, 'queued');
  } finally { await dsh?.close(); await q?.close(); await hub.stop(); }
});

test('same-instance Hub stamps new traffic while unstamped backlog remains held for review', async (t) => {
  const { c, m, targets } = fixture(t), runtimeRoot = c.runtime_dir;
  c.instance_id = 'synthetic-instance'; c.idle_settle_ms = 3000; c.owner_opt_in = true;
  c.runtime_dir = path.join(runtimeRoot, 'codex', c.thread_id); fs.mkdirSync(c.runtime_dir, { recursive: true });
  c.locator_path = path.join(runtimeRoot, 'installation.json');
  const installation = { installation_id: c.installation_id, instance_id: c.instance_id, protocol_version: 1,
    runtime_root: runtimeRoot, hub_owner_kind: 'COMPANION_OWNED' };
  const configPath = path.join(c.runtime_dir, 'receiver-config.json'); fs.writeFileSync(configPath, JSON.stringify(c));
  const token = crypto.randomBytes(32).toString('hex');
  const store = new HubStore({ stateFile: path.join(runtimeRoot, 'hub-state.json'), eventsFile: path.join(runtimeRoot, 'hub-events.jsonl') }).load();
  const stamper = createTargetBindingStamper({ installation, runtimeRoot, locatorPath: c.locator_path });
  const hub = new BridgeHub({ store, token, port: 0, installation, targetBinding: stamper });
  const address = await hub.start(), options = { host: '127.0.0.1', port: address.port, token }; let q, dsh, calls = 0, now = Date.now();
  try {
    q = new HubClient({ ...options, role: 'cli', identity: 'cli:operator' }); await q.connect();
    dsh = new HubClient({ ...options, role: 'dsh', identity: 'dsh:isolated-stamping-host' }); await dsh.connect();
    assert.equal(q.welcomeInfo.installation_id, c.installation_id); assert.equal(q.welcomeInfo.protocol_version, 1);
    assert.equal(q.welcomeInfo.capabilities.target_binding_epoch, true);
    for (const target of targets) await q.pairAdd(target.identity);
    await dsh.sendMessage({ ...m, v: 1, msg_id: 'm-before-membership' });
    registerMembershipEnable({ root: runtimeRoot, installation_id: c.installation_id, instance_id: c.instance_id,
      target: m.to, binding_epoch: c.binding_epoch, config_path: configPath });
    await dsh.sendMessage({ ...m, v: 1, msg_id: 'm-after-membership' });
    const inbox = new QueueInbox(c, { now: () => now });
    const tick = () => dailyTick({ config: c, inbox, hubOptions: options,
      lifecycle: () => [{ type: 'task_complete', timestamp: new Date(now - 5000).toISOString() }],
      executeNative: async (_cli, args) => {
        calls++; const body = JSON.parse(args[4].split('Peer message JSON:\n')[1]);
        assert.equal(body.msg_id, 'm-after-membership'); assert.equal(body.target_binding_epoch, c.binding_epoch); assert.equal(body.text, m.text);
        return { stdout: 'Queued message synthetic-queue for thread ' + c.thread_id + '.' };
      } });
    assert.equal((await tick()).status, 'NATIVE_QUEUED_NOT_MODEL_PROOF'); assert.equal(calls, 1);
    assert.equal((await q.status('m-after-membership')).state, 'delivered');
    const old = await q.status('m-before-membership'); assert.equal(old.state, 'queued'); assert.equal(old.meta.target_binding_epoch, undefined);
    now += 31000;
    assert.equal((await tick()).status, 'PAUSED_BINDING_BACKLOG'); assert.equal(calls, 1);
    assert.equal((await q.status('m-before-membership')).meta.target_binding_epoch, undefined);
  } finally { await dsh?.close(); await q?.close(); await hub.stop(); }
});

test('binding capability does not bypass a wrong instance or unsupported protocol', async (t) => {
  for (const mismatch of [{ instance_id: 'another-instance', protocol_version: 1 }, { instance_id: 'expected-instance', protocol_version: 2 }]) {
    const { c } = fixture(t); c.instance_id = 'expected-instance'; c.idle_settle_ms = 3000;
    const token = crypto.randomBytes(32).toString('hex');
    const store = new HubStore({ stateFile: path.join(c.runtime_dir, 'hub-state.json'), eventsFile: path.join(c.runtime_dir, 'events.jsonl') }).load();
    const hub = new BridgeHub({ store, token, port: 0, installation: { installation_id: c.installation_id, ...mismatch },
      targetBinding: (envelope) => ({ ok: true, envelope }) });
    const address = await hub.start(); let calls = 0;
    try {
      const result = await dailyTick({ config: c, inbox: new QueueInbox(c), hubOptions: { host: '127.0.0.1', port: address.port, token },
        lifecycle: () => [{ type: 'task_complete', timestamp: new Date(Date.now() - 5000).toISOString() }],
        executeNative: async () => { calls++; throw new Error('must not submit'); } });
      assert.equal(result.status, 'PAUSED_PROTOCOL_BINDING_REQUIRED'); assert.equal(calls, 0);
    } finally { await hub.stop(); }
  }
});
