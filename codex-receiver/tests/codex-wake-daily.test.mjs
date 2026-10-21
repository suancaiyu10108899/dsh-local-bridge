import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { HubStore } from '../src/store.mjs';
import { BridgeHub } from '../src/hub.mjs';
import { HubClient } from '../src/client.mjs';
import { QueueInbox, validateReceiverConfig, messageDecision } from '../adapters/codex/queue-inbox.mjs';
import { dailyTick, runDaily, binaryHash } from '../adapters/codex/daily-receiver.mjs';
import { prepareDaily, enableDaily, disableDaily, receiverStatus } from '../adapters/codex/receiver-control.mjs';
import { installStartup, removeStartup, startupPlan } from '../adapters/codex/receiver-startup.mjs';
import { discoverInstalledCli, refreshInstalledCli } from '../adapters/codex/installed-cli.mjs';

const saved = process.env.CODEX_THREAD_ID;
const thread = saved ?? crypto.randomUUID();
process.env.CODEX_THREAD_ID = thread;
after(() => { if (!saved) delete process.env.CODEX_THREAD_ID; });
const sender = 'dsh:session-11111111-1111-4111-8111-111111111111';
const sender2 = 'dsh:session-22222222-2222-4222-8222-222222222222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-daily-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cli = path.join(dir, 'inert-cli');fs.writeFileSync(cli, 'never executed');
  const c = { v: 2, mode: 'daily', transport: 'target-pull', enabled: true, thread_id: thread,
    allowed_senders: [sender, sender2], cli, cli_sha256: binaryHash(cli), workspace: dir,
    rollout_path: path.join(dir, 'rollout.jsonl'), state_db: path.join(dir, 'state.sqlite'), runtime_dir: path.join(dir, 'runtime'),
    activated_at: new Date(Date.now() - 10000).toISOString(), expires_at: null, window_id: crypto.randomUUID(),
    max_native_submissions: null, rate_limit: { max_submissions: 6, window_ms: 3600000 }, min_interval_ms: 30000,
    idle_settle_ms: 3000, poll_interval_ms: 500, max_text_bytes: 12000, accept_backlog: true };
  fs.mkdirSync(c.runtime_dir);const file = path.join(dir, 'config.json');fs.writeFileSync(file, JSON.stringify(c));
  const db = new DatabaseSync(c.state_db);db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, archived INTEGER)');
  db.prepare('INSERT INTO threads VALUES(?,?,?,0)').run(thread, c.rollout_path, dir);db.close();
  fs.writeFileSync(c.rollout_path, JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(),
    payload: { type: 'task_started', turn_id: crypto.randomUUID() } }) + '\n');
  return { dir, c, file };
}
const idle = (now = Date.now()) => [{ type: 'task_complete', timestamp: new Date(now - 5000).toISOString(), turn_id: crypto.randomUUID() }];
const message = (to, id = 'm-daily-1') => ({ v: 1, msg_id: id, from: sender, to: `codex:${to}`, kind: 'text',
  text: 'ordinary daily peer message', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString() });
async function hubFixture(t, dir) {
  const token = 'daily-isolated-token'.padEnd(64, 'x');
  const paths = { stateFile: path.join(dir, 'hub-state.json'), eventsFile: path.join(dir, 'hub-events.jsonl') };
  const store = new HubStore(paths).load(), hub = new BridgeHub({ store, token, port: 0 });
  const addr = await hub.start();const options = { host: '127.0.0.1', port: addr.port, token };
  const q = new HubClient({ ...options, role: 'cli', identity: 'cli:operator' });
  const dsh = new HubClient({ ...options, role: 'dsh', identity: 'dsh:test-daily-host' });
  await q.connect();await dsh.connect();await q.pairAdd(sender);await q.pairAdd(`codex:${thread}`);
  t.after(async () => { await q.close();await dsh.close();await hub.stop(); });
  return { q, dsh, hub, options, store, token, paths };
}

test('daily mode has no expiry, validates multiple exact DSH sources, and survives two days without renewal', (t) => {
  const { c } = fixture(t);
  assert.equal(validateReceiverConfig(c).expires_at, null);
  assert.equal(validateReceiverConfig(c, Date.now() + 2 * 86400000).mode, 'daily');
  for (const patch of [{ expires_at: new Date().toISOString() }, { allowed_senders: ['cli:operator'] },
    { rate_limit: { max_submissions: 0, window_ms: 3600000 } }, { transport: 'role-push' }]) {
    assert.throws(() => validateReceiverConfig({ ...c, ...patch }));
  }
});

test('rolling quota resets with time without a new window, while backlog remains eligible', async (t) => {
  const { c } = fixture(t);let now = Date.now(), calls = 0;
  c.rate_limit.max_submissions = 2;
  const inbox = new QueueInbox(c, { now: () => now });
  const targets = [sender, `codex:${thread}`].map((identity) => ({ identity, enabled: true }));
  const m = { ...message(thread), from_role: 'dsh', to_role: 'codex', created_at: new Date(now - 86400000).toISOString() };
  assert.equal(messageDecision(m, c, targets, now), 'eligible');
  const execute = async () => { calls++;return { stdout: `Queued message native-id for thread ${thread}.` }; };
  await inbox.submit(m, targets, execute);now += 31000;
  await inbox.submit({ ...m, msg_id: 'm-two' }, targets, execute);
  assert.equal((await inbox.submit({ ...m, msg_id: 'm-three' }, targets, execute)).reason, 'rate-limit');
  assert.ok(Date.parse(inbox.nextEligibleAt()) > now);
  now += 3600001;
  const restarted = new QueueInbox(c, { now: () => now });
  assert.equal((await restarted.submit({ ...m, msg_id: 'm-three' }, targets, execute)).status, 'NATIVE_QUEUED');
  assert.equal(calls, 3);
});

test('target pull handles two Codex queues independently without registering or replacing an adapter', async (t) => {
  const { c, dir } = fixture(t), h = await hubFixture(t, dir);const other = crypto.randomUUID();
  await h.q.pairAdd(`codex:${other}`);await h.dsh.sendMessage(message(thread));await h.dsh.sendMessage(message(other, 'm-other'));
  let calls = 0;const inbox = new QueueInbox(c);
  const result = await dailyTick({ config: c, inbox, hubOptions: h.options, lifecycle: () => idle(), executeNative: async (_cli, args) => {
    calls++;assert.equal(args[2], thread);return { stdout: `Queued message n1 for thread ${thread}.` };
  } });
  assert.equal(result.status, 'NATIVE_QUEUED_NOT_MODEL_PROOF');assert.equal(calls, 1);
  assert.equal((await h.q.status('m-daily-1')).state, 'delivered');assert.equal((await h.q.status('m-other')).state, 'queued');
  assert.deepEqual(await h.q.roles(), ['dsh']);
});

test('busy target and existing legacy adapter are deferred without native calls or takeover', async (t) => {
  const { c, dir } = fixture(t), h = await hubFixture(t, dir);let calls = 0;const inbox = new QueueInbox(c);
  await h.dsh.sendMessage(message(thread));
  const busy = await dailyTick({ config: c, inbox, hubOptions: h.options,
    lifecycle: () => [{ type: 'task_started' }], executeNative: async () => { calls++; } });
  assert.equal(busy.status, 'WAITING_FOR_TARGET_IDLE');assert.equal((await h.q.status('m-daily-1')).state, 'queued');
  const legacy = new HubClient({ ...h.options, role: 'codex', identity: `codex:${crypto.randomUUID()}` });
  await legacy.connect();t.after(() => legacy.close());
  const blocked = await dailyTick({ config: c, inbox, hubOptions: h.options, lifecycle: () => idle(), executeNative: async () => { calls++; } });
  assert.equal(blocked.status, 'BLOCKED_OTHER_ADAPTER');assert.equal(legacy.closed, false);assert.equal(calls, 0);
});

test('Hub failure after native acceptance is reconciled without a second native submission', async (t) => {
  const { c, dir } = fixture(t), h = await hubFixture(t, dir);let calls = 0;
  await h.dsh.sendMessage(message(thread));const inbox = new QueueInbox(c);
  await assert.rejects(dailyTick({ config: c, inbox, hubOptions: h.options, lifecycle: () => idle(), executeNative: async () => {
    calls++;await h.hub.stop();return { stdout: `Queued message persisted-id for thread ${thread}.` };
  } }));
  const store = new HubStore(h.paths).load(), next = new BridgeHub({ store, token: h.token, port: 0 });const addr = await next.start();
  t.after(() => next.stop());
  const result = await dailyTick({ config: c, inbox: new QueueInbox(c), hubOptions: { ...h.options, port: addr.port },
    lifecycle: () => [{ type: 'task_started' }], executeNative: async () => { calls++; } });
  assert.equal(result.status, 'WAITING_FOR_TARGET_IDLE');assert.equal(store.getMessage('m-daily-1').state, 'delivered');assert.equal(calls, 1);
});

test('uncertain native outcome stays paused, never blindly retried', async (t) => {
  const { c, dir } = fixture(t), h = await hubFixture(t, dir);await h.dsh.sendMessage(message(thread));let calls = 0;
  const inbox = new QueueInbox(c);
  const options = { config: c, inbox, hubOptions: h.options, lifecycle: () => idle(), executeNative: async () => { calls++;throw new Error('timeout'); } };
  assert.equal((await dailyTick(options)).status, 'PAUSED_UNCERTAIN');
  assert.equal((await dailyTick({ ...options, inbox: new QueueInbox(c) })).status, 'PAUSED_UNCERTAIN');
  assert.equal(calls, 1);assert.equal((await h.q.status('m-daily-1')).state, 'queued');
});

test('daily loop retries Hub loss, recovers, stays alive beyond old expiry, then disables gracefully', async (t) => {
  const { c, file, dir } = fixture(t);const h = await hubFixture(t, dir);await h.hub.stop();
  let now = Date.now(), cycles = 0, recovered = false;let next;
  const options = { ...h.options };
  await runDaily(file, { hubOptions: options, now: () => now, lifecycle: () => idle(now), checkBinding: async () => true,
    wait: async (ms) => {
      now += ms;cycles++;
      if (cycles === 3) {
        next = new BridgeHub({ store: new HubStore(h.paths).load(), token: h.token, port: 0 });const addr = await next.start();options.port = addr.port;
        now += 3 * 3600000;
      }
      const status = JSON.parse(fs.readFileSync(path.join(c.runtime_dir, 'status.json')));
      if (status.status === 'ONLINE_IDLE') recovered = true;
      if ((recovered && cycles > 4) || cycles > 20) fs.writeFileSync(file, JSON.stringify({ ...c, enabled: false }));
    } });
  if (next) await next.stop();
  assert.equal(recovered, true);assert.ok(now > Date.now() + 2 * 3600000);
  assert.equal(JSON.parse(fs.readFileSync(path.join(c.runtime_dir, 'status.json'))).status, 'DISABLED');
  assert.equal(fs.existsSync(path.join(c.runtime_dir, 'receiver.lock')), false);
});

test('owner lifecycle prepare is idempotent and cannot overwrite another target', async (t) => {
  const { c, file, dir } = fixture(t);fs.unlinkSync(file);
  const opts = { senders: [sender], cli: c.cli, configPath: file, stateDb: c.state_db, runtimeRoot: c.runtime_dir,
    inspectCli: async () => ({ stdout: '--thread --message' }) };
  const a = await prepareDaily(opts), b = await prepareDaily(opts);
  assert.equal(a.status, 'PREPARED_DISABLED');assert.equal(b.status, 'ALREADY_CONFIGURED');
  assert.equal(a.config.window_id, b.config.window_id);
  const other = path.join(dir, 'other.json');fs.writeFileSync(other, JSON.stringify({ ...a.config, thread_id: crypto.randomUUID() }));
  await assert.rejects(prepareDaily({ ...opts, configPath: other }), /OWNER_TARGET_MISMATCH/);
});

test('real independent busy worker enable/disable is idempotent and never connects to production Hub', async (t) => {
  const { c, file } = fixture(t);fs.writeFileSync(file, JSON.stringify({ ...c, enabled: false }));
  try {
    const a = await enableDaily(file), b = await enableDaily(file);
    assert.equal(a.action, 'ENABLED');assert.equal(b.action, 'ALREADY_RUNNING');assert.equal(a.pid, b.pid);
    assert.equal(receiverStatus(file).expires_at, null);
    const d = await disableDaily(file);assert.equal(d.status, 'DISABLED');assert.equal(d.running, false);
    assert.equal((await disableDaily(file)).status, 'DISABLED');
  } finally { await disableDaily(file); }
});

test('supervisor recovers only its own crashed worker without restarting any host or losing the ledger', async (t) => {
  const { c, file } = fixture(t);fs.writeFileSync(file, JSON.stringify({ ...c, enabled: false }));
  try {
    const original = await enableDaily(file);
    const lock = JSON.parse(fs.readFileSync(path.join(c.runtime_dir, 'receiver.lock')));
    assert.equal(lock.pid, original.pid);assert.equal(lock.thread_id, thread);
    // This PID is the isolated worker just started by this test, never a shared process.
    process.kill(original.pid, 'SIGKILL');
    const end = Date.now() + 7000;let recovered;
    while (Date.now() < end) {
      const status = receiverStatus(file);
      if (status.healthy && status.pid !== original.pid) { recovered = status;break; }
      await sleep(30);
    }
    assert.ok(recovered);assert.equal(recovered.service_pid, original.service_pid);
    assert.equal(recovered.expires_at, null);
  } finally { await disableDaily(file); }
});

test('user-logon registration is exact-value, reviewable, idempotent and reversible without touching another startup entry', async (t) => {
  const { c, file } = fixture(t);let actual = null, writes = 0, deletes = 0;
  const unrelated = 'unchanged';
  const registry = { get: async () => actual, set: async (p) => { actual = p.command;writes++; }, remove: async () => { actual = null;deletes++; } };
  const plan = startupPlan(c, file);
  assert.equal(plan.name, `LocalAgentBridge-${thread}`);assert.match(plan.command, /-WindowStyle Hidden/);
  assert.doesNotMatch(plan.command, /ExecutionPolicy|EncodedCommand|token|auth/i);
  await installStartup(c, file, registry);await installStartup(c, file, registry);assert.equal(writes, 1);
  const correct = actual;actual = 'someone-elses-command';
  await assert.rejects(removeStartup(c, registry), /STARTUP_ENTRY_CONFLICT/);assert.equal(deletes, 0);
  actual = correct;await removeStartup(c, registry);await removeStartup(c, registry);
  assert.equal(deletes, 1);assert.equal(unrelated, 'unchanged');
  actual = 'pre-existing-other-value';await assert.rejects(installStartup(c, file, registry), /STARTUP_ENTRY_CONFLICT/);
});

test('CLI path drift uses only verified binaries already in the configured vendor install root', async (t) => {
  const { c, dir, file } = fixture(t);
  const root = path.join(dir, 'OpenAI', 'Codex', 'bin'), folder = path.join(root, '6257d9e8f63c0f2b');fs.mkdirSync(folder, { recursive: true });
  const current = path.join(folder, 'codex.exe');fs.writeFileSync(current, 'new-installed-cli');
  const config = { ...c, cli: path.join(root, '896a0166b774037a', 'codex.exe'), cli_install_root: root, allow_installed_cli_refresh: true };
  fs.writeFileSync(file, JSON.stringify(config));let inspected = 0;
  const inspect = async (p) => { inspected++;assert.equal(p, current);return { help: '--thread --message', version: 'codex-cli 0.163.0-alpha.11' }; };
  const found = await discoverInstalledCli(config, { inspect, envPath: folder + path.delimiter + path.join(dir, 'untrusted') });
  assert.equal(found.cli, current);
  await refreshInstalledCli(config, file, { inspect, envPath: folder });
  assert.equal(JSON.parse(fs.readFileSync(file)).cli, current);assert.ok(inspected > 0);
  assert.match(fs.readFileSync(path.join(c.runtime_dir, 'cli-refresh.jsonl'), 'utf8'), /software_installed":false/);
  await assert.rejects(discoverInstalledCli({ ...config, cli_install_root: path.join(dir, 'other') }, { inspect }), /UNSUPPORTED/);
});
