import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createInstallation } from '../src/installation.mjs';
import { adoptLegacyDaily, enableDaily, receiverStatus } from '../adapters/codex/receiver-control.mjs';

const sender = 'dsh:session-11111111-1111-4111-8111-111111111111';
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-legacy-adoption-'));
  const saved = process.env.CODEX_THREAD_ID, oldRuntime = process.env.LAB_BRIDGE_RUNTIME_DIR;
  const thread = saved ?? crypto.randomUUID();
  if (!saved) process.env.CODEX_THREAD_ID = thread;
  delete process.env.LAB_BRIDGE_RUNTIME_DIR;
  t.after(() => {
    if (saved === undefined) delete process.env.CODEX_THREAD_ID; else process.env.CODEX_THREAD_ID = saved;
    if (oldRuntime === undefined) delete process.env.LAB_BRIDGE_RUNTIME_DIR; else process.env.LAB_BRIDGE_RUNTIME_DIR = oldRuntime;
    const absolute = path.resolve(dir);
    assert.ok(absolute.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(absolute).startsWith('lab-legacy-adoption-'));
    fs.rmSync(absolute, { recursive: true, force: true });
  });
  const root = path.join(dir, 'runtime'), runtime = path.join(root, 'codex', thread), installationRoot = path.join(dir, 'installation');
  fs.mkdirSync(runtime, { recursive: true });
  createInstallation({ root: installationRoot, hubOwnerKind: 'COMPANION_OWNED', runtimeRoot: root });
  const cli = path.join(dir, 'OpenAI/Codex/bin/aaaaaaaaaaaaaaaa/codex.exe');
  fs.mkdirSync(path.dirname(cli), { recursive: true }); fs.writeFileSync(cli, 'inert CLI; never executed');
  const state = path.join(dir, 'state.sqlite'), rollout = path.join(dir, 'rollout.jsonl');
  const db = new DatabaseSync(state); db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, archived INTEGER)');
  db.prepare('INSERT INTO threads VALUES(?,?,?,0)').run(thread, rollout, dir); db.close(); fs.writeFileSync(rollout, '');
  const config = { v: 2, mode: 'daily', transport: 'target-pull', enabled: true, thread_id: thread,
    allowed_senders: [sender], cli, cli_sha256: 'a'.repeat(64), workspace: dir, rollout_path: rollout, state_db: state,
    runtime_dir: runtime, activated_at: new Date().toISOString(), expires_at: null, max_native_submissions: null, window_id: crypto.randomUUID(),
    rate_limit: { max_submissions: 3, window_ms: 3600000 }, min_interval_ms: 40000, idle_settle_ms: 3000,
    poll_interval_ms: 2000, max_text_bytes: 12000, accept_backlog: true, start_at_logon: false };
  const file = path.join(runtime, 'receiver-config.json'); fs.writeFileSync(file, JSON.stringify(config));
  fs.writeFileSync(path.join(runtime, 'ledger.json'), JSON.stringify({ v: 1, entries: { preserved: { status: 'UNCERTAIN', reason: 'historical-only' } } }));
  for (const [name, pid] of [['receiver.lock', 33553360], ['service.lock', 33553361]]) {
    fs.writeFileSync(path.join(runtime, name), JSON.stringify({ pid, thread_id: thread, config_path: file }));
  }
  const startup = { thread_id: thread, key: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
    name: 'LocalAgentBridge-' + thread, command: 'known-inert-legacy-command', enabled: true };
  fs.writeFileSync(path.join(runtime, 'startup.json'), JSON.stringify(startup));
  let removed = 0;
  const registry = { get: async () => startup.command, remove: async () => { removed++; }, set: async () => assert.fail('no startup registration') };
  const options = { installationRoot, registry,
    identityProvider: async (pid) => ({ pid, alive: false, available: false, source: 'windows-cim', unavailable_reason: 'PROCESS_NOT_FOUND' }),
    cliOptions: { envPath: '', inspect: async () => ({ help: '--thread --message', version: 'codex-cli 0.166.0-alpha.5.1' }) } };
  return { dir, root, runtime, installationRoot, config, file, options, removed: () => removed };
}

test('explicit owner adoption preserves ledger/window/sources/limits/no-login and prepares a disabled installed target', async (t) => {
  const f = fixture(t), ledger = fs.readFileSync(path.join(f.runtime, 'ledger.json'));
  const before = fs.readFileSync(f.file), result = await adoptLegacyDaily(f.file, f.options);
  const c = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  assert.equal(result.status, 'ADOPTED_DISABLED'); assert.equal(c.enabled, false); assert.equal(c.owner_opt_in, false);
  for (const key of ['window_id', 'activated_at', 'workspace', 'rollout_path', 'state_db', 'allowed_senders', 'rate_limit',
    'min_interval_ms', 'max_text_bytes', 'accept_backlog', 'start_at_logon']) assert.deepEqual(c[key], f.config[key]);
  assert.equal(c.hub_runtime_root, f.root); assert.ok(c.installation_id); assert.ok(c.binding_epoch);
  assert.equal(c.cli_version, 'codex-cli 0.166.0-alpha.5.1'); assert.equal(c.allowed_clients, undefined);
  assert.ok(fs.readFileSync(result.backup).equals(before)); assert.ok(fs.readFileSync(path.join(f.runtime, 'ledger.json')).equals(ledger));
  assert.equal(fs.existsSync(path.join(f.runtime, 'receiver.lock')), false); assert.equal(f.removed(), 1);
  const stable = fs.readFileSync(f.file);
  assert.equal((await adoptLegacyDaily(f.file, f.options)).status, 'ALREADY_ADOPTED');
  assert.ok(fs.readFileSync(f.file).equals(stable)); assert.equal(f.removed(), 1);
});

test('adoption cannot target another original owner or another runtime', async (t) => {
  const f = fixture(t), before = fs.readFileSync(f.file);
  process.env.CODEX_THREAD_ID = crypto.randomUUID();
  await assert.rejects(adoptLegacyDaily(f.file, f.options), /OWNER_THREAD_MISMATCH/);
  process.env.CODEX_THREAD_ID = f.config.thread_id;
  const other = path.join(f.dir, 'other-install'); createInstallation({ root: other, hubOwnerKind: 'COMPANION_OWNED' });
  await assert.rejects(adoptLegacyDaily(f.file, { ...f.options, installationRoot: other }), /RUNTIME_INSTANCE_CONFLICT/);
  assert.ok(fs.readFileSync(f.file).equals(before)); assert.equal(f.removed(), 0);
});

test('live, reused or unverifiable legacy PIDs leave config, startup and old locks unchanged', async (t) => {
  const f = fixture(t), before = fs.readFileSync(f.file);
  for (const proof of [{ alive: true, available: true }, { alive: true, available: false },
    { alive: false, available: false, unavailable_reason: 'CIM_FAILED' }]) {
    await assert.rejects(adoptLegacyDaily(f.file, { ...f.options,
      identityProvider: async (pid) => ({ pid, source: 'windows-cim', ...proof }) }), /LEGACY_PROCESS_NOT_PROVEN_ABSENT/);
  }
  assert.ok(fs.readFileSync(f.file).equals(before)); assert.equal(f.removed(), 0);
  assert.ok(fs.existsSync(path.join(f.runtime, 'receiver.lock')));
  assert.equal(fs.existsSync(path.join(f.runtime, 'legacy-adoption.transaction')), false);
});

test('a concurrent config edit is detected and never overwritten by adoption', async (t) => {
  const f = fixture(t), changed = JSON.stringify({ ...f.config, min_interval_ms: 50000 });
  await assert.rejects(adoptLegacyDaily(f.file, { ...f.options, cliOptions: { envPath: '', inspect: async () => {
    fs.writeFileSync(f.file, changed); return { help: '--thread --message', version: 'codex-cli 0.166.0-alpha.5.1' };
  } } }), /LEGACY_RECORD_CHANGED/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), changed); assert.equal(f.removed(), 0);
});

test('ambiguous startup ownership retains an adoption journal and never enables or archives old locks', async (t) => {
  const f = fixture(t), before = fs.readFileSync(f.file);
  await assert.rejects(adoptLegacyDaily(f.file, { ...f.options, registry: { get: async () => 'unrelated-owner-command' } }), /STARTUP_ENTRY_CONFLICT/);
  assert.ok(fs.readFileSync(f.file).equals(before)); assert.ok(fs.existsSync(path.join(f.runtime, 'receiver.lock')));
  assert.ok(fs.existsSync(path.join(f.runtime, 'legacy-adoption.transaction')));
  await assert.rejects(adoptLegacyDaily(f.file, f.options), /LEGACY_ADOPTION_REVIEW_REQUIRED/);
});

async function interrupted(f) {
  await assert.rejects(adoptLegacyDaily(f.file, { ...f.options, registry: {
    get: async () => { throw new Error('STARTUP_REGISTRY_READ_FAILED'); },
  } }), /STARTUP_REGISTRY_READ_FAILED/);
  const journal = path.join(f.runtime, 'legacy-adoption.transaction');
  return { journal, data: JSON.parse(fs.readFileSync(journal, 'utf8')) };
}

test('the original owner resumes a real v1 pre-config journal after a read-only registry failure', async (t) => {
  const f = fixture(t), original = fs.readFileSync(f.file), ledger = fs.readFileSync(path.join(f.runtime, 'ledger.json'));
  const j = await interrupted(f);
  fs.writeFileSync(j.journal, JSON.stringify({ nonce: j.data.nonce, thread_id: f.config.thread_id, config_path: f.file,
    backup: j.data.backup, status: 'ADOPTING_DISABLED', pids_proven_absent: j.data.pids_reviewed }));
  const result = await adoptLegacyDaily(f.file, { ...f.options, resume: true, registry: {
    get: async () => null, remove: async () => assert.fail('missing value is never deleted'),
  } });
  assert.equal(result.action, 'ADOPTION_RESUMED'); assert.equal(result.status, 'ADOPTED_DISABLED');
  assert.ok(fs.readFileSync(result.backup).equals(original)); assert.ok(fs.readFileSync(path.join(f.runtime, 'ledger.json')).equals(ledger));
  assert.ok(fs.existsSync(j.journal + '.completed-' + j.data.nonce));
  assert.equal(JSON.parse(fs.readFileSync(f.file)).window_id, f.config.window_id);
});

test('pending adoption is visible and enable cannot bypass its recovery boundary', async (t) => {
  const f = fixture(t); await interrupted(f);
  const status = await receiverStatus(f.file, Date.now(), { identityProvider: f.options.identityProvider });
  assert.equal(status.status, 'LEGACY_ADOPTION_REVIEW_REQUIRED'); assert.equal(status.adoption_recovery_present, true);
  assert.equal(status.recovery_transaction_present, true);
  await assert.rejects(enableDaily(f.file, f.options), /LEGACY_ADOPTION_REVIEW_REQUIRED/);
});

test('resume refuses changed config, wrong owner, an active PID and a changed PID record', async (t) => {
  const f = fixture(t), original = fs.readFileSync(f.file); await interrupted(f);
  process.env.CODEX_THREAD_ID = crypto.randomUUID();
  await assert.rejects(adoptLegacyDaily(f.file, { ...f.options, resume: true }), /OWNER_THREAD_MISMATCH/);
  process.env.CODEX_THREAD_ID = f.config.thread_id;
  fs.writeFileSync(f.file, JSON.stringify({ ...f.config, min_interval_ms: 50000 }));
  await assert.rejects(adoptLegacyDaily(f.file, { ...f.options, resume: true }), /LEGACY_ADOPTION_CONFIG_CHANGED/);
  fs.writeFileSync(f.file, original);
  await assert.rejects(adoptLegacyDaily(f.file, { ...f.options, resume: true,
    identityProvider: async (pid) => ({ pid, alive: true, available: false, source: 'windows-cim' }) }), /LEGACY_PROCESS_NOT_PROVEN_ABSENT/);
  const lock = path.join(f.runtime, 'receiver.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: 33553362, thread_id: f.config.thread_id, config_path: f.file }));
  await assert.rejects(adoptLegacyDaily(f.file, { ...f.options, resume: true }), /LEGACY_ADOPTION_LOCK_CHANGED/);
  assert.ok(fs.readFileSync(f.file).equals(original));
});

test('post-config recovery finalizes exact partial lock archival without rewriting the installed config', async (t) => {
  const f = fixture(t), done = await adoptLegacyDaily(f.file, f.options), installed = fs.readFileSync(f.file);
  const journal = path.join(f.runtime, 'legacy-adoption.transaction');
  const completed = fs.readdirSync(f.runtime).find((n) => n.startsWith('legacy-adoption.transaction.completed-'));
  const nonce = JSON.parse(fs.readFileSync(path.join(f.runtime, completed))).nonce;
  fs.renameSync(path.join(f.runtime, completed), journal);
  fs.renameSync(path.join(f.runtime, 'receiver.lock.pre-adoption-' + nonce), path.join(f.runtime, 'receiver.lock'));
  const result = await adoptLegacyDaily(f.file, { ...f.options, resume: true, registry: { get: async () => null } });
  assert.equal(result.action, 'ADOPTION_RESUMED'); assert.equal(result.binding_epoch, done.binding_epoch);
  assert.ok(fs.readFileSync(f.file).equals(installed)); assert.equal(fs.existsSync(path.join(f.runtime, 'receiver.lock')), false);
  assert.ok(fs.existsSync(journal + '.completed-' + nonce));
});

test('an original owner can terminate a pre-config journal without restoring a backup over current data', async (t) => {
  const f = fixture(t), original = fs.readFileSync(f.file), j = await interrupted(f);
  const result = await adoptLegacyDaily(f.file, { ...f.options, abort: true });
  assert.equal(result.status, 'ADOPTION_ABORTED'); assert.equal(result.config_restored, false);
  assert.ok(fs.readFileSync(f.file).equals(original)); assert.ok(fs.existsSync(j.journal + '.aborted-' + j.data.nonce));
  assert.ok(fs.existsSync(path.join(f.runtime, 'receiver.lock')));
});

test('explicit proven-reuse recovery archives an older Node lock for a newly born conhost without signalling it', async (t) => {
  const f = fixture(t), before = new Date(Date.now() - 60000);
  for (const name of ['receiver.lock', 'service.lock']) fs.utimesSync(path.join(f.runtime, name), before, before);
  const identityProvider = async (pid) => pid === 33553361
    ? { pid, source: 'windows-cim', alive: true, available: false, exe_path: path.resolve(f.dir, 'conhost.exe'), created_at: new Date().toISOString() }
    : f.options.identityProvider(pid);
  await assert.rejects(adoptLegacyDaily(f.file, { ...f.options, identityProvider }), /LEGACY_PROCESS_NOT_PROVEN_ABSENT/);
  const result = await adoptLegacyDaily(f.file, { ...f.options, identityProvider, acceptProvenReuse: true });
  assert.equal(result.process_proofs.find((p) => p.pid === 33553361).status, 'PROVEN_REUSED_CONSOLE_HOST');
  assert.equal(result.enabled, false);
});

test('two recovery calls cannot overlap while the first is checking registry state', async (t) => {
  const f = fixture(t); await interrupted(f);
  let entered, release;
  const ready = new Promise((r) => { entered = r; }), gate = new Promise((r) => { release = r; });
  const first = adoptLegacyDaily(f.file, { ...f.options, resume: true, registry: { get: async () => { entered(); await gate; return null; } } });
  await ready;
  await assert.rejects(adoptLegacyDaily(f.file, { ...f.options, resume: true }), /LEGACY_ADOPTION_RECOVERY_HELD/);
  release(); assert.equal((await first).status, 'ADOPTED_DISABLED');
});

test('an exact dead recovery guard is archived and the same journal can continue', async (t) => {
  const f = fixture(t); await interrupted(f);
  const nonce = crypto.randomUUID(), guard = path.join(f.runtime, 'legacy-adoption.recovery.lock');
  fs.writeFileSync(guard, JSON.stringify({ nonce, pid: 33553399, thread_id: f.config.thread_id, config_path: f.file }));
  const result = await adoptLegacyDaily(f.file, { ...f.options, resume: true, registry: { get: async () => null } });
  assert.equal(result.status, 'ADOPTED_DISABLED'); assert.ok(fs.existsSync(guard + '.stale-' + nonce));
  assert.equal(fs.existsSync(guard), false);
});

test('proven-reuse is not a force flag for a Node process, missing identity or a birth older than the record', async (t) => {
  const f = fixture(t), before = new Date(Date.now() - 60000);
  for (const name of ['receiver.lock', 'service.lock']) fs.utimesSync(path.join(f.runtime, name), before, before);
  for (const bad of [
    { exe_path: path.resolve(f.dir, 'node.exe'), created_at: new Date().toISOString() },
    { exe_path: null, created_at: new Date().toISOString() },
    { exe_path: path.resolve(f.dir, 'conhost.exe'), created_at: new Date(Date.now() - 120000).toISOString() },
  ]) {
    await assert.rejects(adoptLegacyDaily(f.file, { ...f.options, acceptProvenReuse: true,
      identityProvider: async (pid) => ({ pid, alive: true, available: false, source: 'windows-cim', ...bad }),
    }), /LEGACY_PROCESS_NOT_PROVEN_ABSENT/);
  }
  assert.equal(fs.existsSync(path.join(f.runtime, 'legacy-adoption.transaction')), false);
});
