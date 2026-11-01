import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createInstallation, writeInstallationAtomic } from '../src/installation.mjs';
import { readMembership, membershipPath, writeMembershipAtomic } from '../src/membership.mjs';
import { prepareDaily, enableDaily, disableDaily, receiverStatus, inspectDaily } from '../adapters/codex/receiver-control.mjs';
import { receiverHubOptions } from '../adapters/codex/receiver-context.mjs';

const originalThread = process.env.CODEX_THREAD_ID, originalRuntime = process.env.LAB_BRIDGE_RUNTIME_DIR;
const thread = originalThread ?? crypto.randomUUID();
if (!originalThread) process.env.CODEX_THREAD_ID = thread;
delete process.env.LAB_BRIDGE_RUNTIME_DIR;
after(() => {
  if (!originalThread) delete process.env.CODEX_THREAD_ID;
  if (originalRuntime === undefined) delete process.env.LAB_BRIDGE_RUNTIME_DIR; else process.env.LAB_BRIDGE_RUNTIME_DIR = originalRuntime;
});
const cliOptions = { inspect: async () => ({ help: '--thread --message', version: 'codex-cli 0.163.0-alpha.11.2' }), envPath: '' };
function fixture(t, { mode = 'COMPANION_OWNED' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-installed-receiver-'));
  t.after(() => {
    const absolute = path.resolve(dir);
    assert.ok(absolute.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(absolute).startsWith('lab-installed-receiver-'));
    fs.rmSync(absolute, { recursive: true, force: true });
  });
  const root = path.join(dir, 'installation');
  const installation = createInstallation({ root, runtimeRoot: path.join(dir, 'runtime'), activeVersion: '0.1.0-stage-a', hubOwnerKind: mode });
  const cli = path.join(dir, 'OpenAI', 'Codex', 'bin', 'aaaaaaaaaaaaaaaa', 'codex.exe');
  fs.mkdirSync(path.dirname(cli), { recursive: true }); fs.writeFileSync(cli, 'inert, never executed by these tests');
  const stateDb = path.join(dir, 'state.sqlite'), rollout = path.join(dir, 'rollout.jsonl');
  const db = new DatabaseSync(stateDb); db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, archived INTEGER)');
  db.prepare('INSERT INTO threads VALUES(?,?,?,0)').run(thread, rollout, dir); db.close();
  fs.writeFileSync(rollout, JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'task_started' } }) + '\n');
  const options = { installationRoot: root, cli, senders: ['dsh:session-11111111-1111-4111-8111-111111111111'], stateDb, cliOptions };
  return { dir, root, installation, cli, stateDb, options };
}

test('installed prepare uses only the locator runtime and leaves target disabled', async (t) => {
  const f = fixture(t), prepared = await prepareDaily(f.options), c = prepared.config;
  assert.equal(c.runtime_dir, path.join(f.installation.runtime_root, 'codex', thread));
  assert.equal(c.hub_runtime_root, f.installation.runtime_root); assert.equal(c.installation_id, f.installation.installation_id);
  assert.equal(c.instance_id, f.installation.instance_id); assert.equal(c.enabled, false); assert.equal(c.owner_opt_in, false);
  assert.equal(c.start_at_logon, false); assert.equal(fs.existsSync(membershipPath(f.installation.runtime_root, 'codex:' + thread)), false);
  assert.equal((await receiverStatus(prepared.config_path)).status, 'DISABLED');
});

test('installed enable creates exact membership and no independent service/startup entry', async (t) => {
  const f = fixture(t), p = await prepareDaily(f.options), enabled = await enableDaily(p.config_path, { cliOptions });
  assert.equal(enabled.action, 'ENABLE_REGISTERED'); assert.equal(enabled.status, 'PENDING_COMPANION'); assert.equal(enabled.background_spawned, false);
  const member = readMembership(membershipPath(f.installation.runtime_root, 'codex:' + thread));
  assert.equal(member.installation_id, f.installation.installation_id); assert.equal(member.instance_id, f.installation.instance_id);
  assert.equal(member.binding_epoch, p.config.binding_epoch); assert.equal(member.config_path, p.config_path);
  assert.equal(member.owner_opt_in, true); assert.equal(member.enabled, true); assert.equal(member.start_at_logon, false);
  for (const file of ['receiver.lock', 'service.lock', 'startup.json']) assert.equal(fs.existsSync(path.join(p.config.runtime_dir, file)), false);
  const stopped = await disableDaily(p.config_path); assert.equal(stopped.stop_confirmed, true);
  assert.equal(readMembership(member.file ?? membershipPath(f.installation.runtime_root, member.target)).enabled, false);
});

test('login preference changes only explicitly and never registers HKCU Run', async (t) => {
  const f = fixture(t), p = await prepareDaily(f.options);
  await enableDaily(p.config_path, { cliOptions, loginStartup: true });
  await disableDaily(p.config_path); await enableDaily(p.config_path, { cliOptions });
  assert.equal(readMembership(membershipPath(f.installation.runtime_root, 'codex:' + thread)).start_at_logon, true);
  assert.equal(fs.existsSync(path.join(p.config.runtime_dir, 'stop')), false);
  await enableDaily(p.config_path, { cliOptions, loginStartup: false });
  assert.equal(readMembership(membershipPath(f.installation.runtime_root, 'codex:' + thread)).start_at_logon, false);
  assert.equal(fs.existsSync(path.join(p.config.runtime_dir, 'startup.json')), false);
});

test('an instance switch fails before CLI inspection and never edits the old target', async (t) => {
  const f = fixture(t), p = await prepareDaily(f.options), before = fs.readFileSync(p.config_path, 'utf8');
  writeInstallationAtomic({ root: f.root, installation: { ...f.installation, instance_id: crypto.randomUUID() } }); let inspected = 0;
  await assert.rejects(enableDaily(p.config_path, { cliOptions: { inspect: async () => { inspected++; return cliOptions.inspect(); } } }), /RECEIVER_INSTANCE_MISMATCH/);
  assert.equal(inspected, 0); assert.equal(fs.readFileSync(p.config_path, 'utf8'), before);
});

test('a production locator cannot be redirected by an ambient runtime override', async (t) => {
  const f = fixture(t); process.env.LAB_BRIDGE_RUNTIME_DIR = path.join(f.dir, 'wrong-runtime');
  try { await assert.rejects(prepareDaily(f.options), (error) => error.code === 'RUNTIME_INSTANCE_CONFLICT'); }
  finally { delete process.env.LAB_BRIDGE_RUNTIME_DIR; }
  assert.equal(fs.existsSync(path.join(f.dir, 'wrong-runtime')), false);
});

test('a junction escaping runtime is rejected before the first config write', async (t) => {
  const f = fixture(t), outside = path.join(f.dir, 'outside'); fs.mkdirSync(outside);
  fs.mkdirSync(f.installation.runtime_root, { recursive: true });
  fs.symlinkSync(outside, path.join(f.installation.runtime_root, 'codex'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepareDaily(f.options), /RUNTIME_INSTANCE_CONFLICT/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('an installed config path cannot be redirected outside its exact target directory', async (t) => {
  const f = fixture(t), unrelated = path.join(f.dir, 'unrelated.json');
  await assert.rejects(prepareDaily({ ...f.options, configPath: unrelated }), /RECEIVER_CONFIG_PATH_CONFLICT/);
  assert.equal(fs.existsSync(unrelated), false);
});

test('non-companion owner mode cannot quietly fall back to a legacy supervisor', async (t) => {
  const f = fixture(t, { mode: 'EXTERNAL_UNMANAGED' }), p = await prepareDaily(f.options);
  await assert.rejects(enableDaily(p.config_path, { cliOptions }), /RECEIVER_REQUIRES_COMPANION_MODE/);
  assert.equal(JSON.parse(fs.readFileSync(p.config_path)).enabled, false);
  assert.equal(fs.existsSync(path.join(p.config.runtime_dir, 'service.lock')), false);
});

test('installed Hub options use the bound runtime, never the package directory', async (t) => {
  const f = fixture(t), p = await prepareDaily(f.options), hub = path.join(f.installation.runtime_root, 'hub'); fs.mkdirSync(hub, { recursive: true });
  const fixtureToken = 'synthetic-installed-token'.padEnd(64, 'x');
  fs.writeFileSync(path.join(hub, 'config.json'), JSON.stringify({ host: '127.0.0.1', port: 49777 }));
  fs.writeFileSync(path.join(hub, 'token'), fixtureToken);
  assert.deepEqual(receiverHubOptions(p.config), { host: '127.0.0.1', port: 49777, token: fixtureToken });
  fs.writeFileSync(path.join(hub, 'config.json'), JSON.stringify({ host: '0.0.0.0', port: 49777 }));
  assert.throws(() => receiverHubOptions(p.config), /HUB_CONFIG_INVALID/);
});

test('doctor is read-only for an installed disabled receiver', async (t) => {
  const f = fixture(t), p = await prepareDaily(f.options), before = fs.readFileSync(p.config_path, 'utf8');
  const result = await inspectDaily(p.config_path, { cliOptions });
  assert.equal(result.config_changed, false); assert.equal(result.cli_compatible, true); assert.equal(result.enabled, false);
  assert.equal(fs.readFileSync(p.config_path, 'utf8'), before);
  assert.equal(fs.existsSync(membershipPath(f.installation.runtime_root, 'codex:' + thread)), false);
});

test('enable cannot overwrite a foreign membership occupying the same target slot', async (t) => {
  const f = fixture(t), p = await prepareDaily(f.options); await enableDaily(p.config_path, { cliOptions });
  const memberPath = membershipPath(f.installation.runtime_root, 'codex:' + thread);
  const member = readMembership(memberPath);
  writeMembershipAtomic(f.installation.runtime_root, { ...member, instance_id: crypto.randomUUID() });
  const before = fs.readFileSync(memberPath, 'utf8');
  await assert.rejects(enableDaily(p.config_path, { cliOptions }), /MEMBERSHIP_BINDING_MISMATCH/);
  assert.equal(fs.readFileSync(memberPath, 'utf8'), before);
});

test('explicit reconfiguration revokes its old membership while preserving window and ledger', async (t) => {
  const f = fixture(t), p = await prepareDaily(f.options); await enableDaily(p.config_path, { cliOptions });
  const ledger = path.join(p.config.runtime_dir, 'ledger.json'), raw = '{"v":1,"entries":{}}'; fs.writeFileSync(ledger, raw);
  const changed = await prepareDaily({ ...f.options, perHour: 9 });
  assert.equal(changed.config.enabled, false); assert.equal(changed.config.owner_opt_in, false);
  assert.notEqual(changed.config.binding_epoch, p.config.binding_epoch); assert.equal(changed.config.window_id, p.config.window_id);
  assert.equal(changed.config.rate_limit.max_submissions, 9); assert.equal(fs.readFileSync(ledger, 'utf8'), raw);
  const oldMember = readMembership(membershipPath(f.installation.runtime_root, 'codex:' + thread)); assert.equal(oldMember.enabled, false);
  await enableDaily(p.config_path, { cliOptions });
  assert.equal(readMembership(membershipPath(f.installation.runtime_root, 'codex:' + thread)).binding_epoch, changed.config.binding_epoch);
});
