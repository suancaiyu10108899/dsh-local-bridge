import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { prepareDaily, enableDaily, disableDaily, inspectDaily, repairDailyCli } from '../adapters/codex/receiver-control.mjs';
import { runDaily, binaryHash } from '../adapters/codex/daily-receiver.mjs';

const originalThread = process.env.CODEX_THREAD_ID;
const thread = originalThread ?? crypto.randomUUID();
// Only isolated synthetic SQLite/rollout fixtures use this context when no host
// environment exists. No installed host or native queue is accessed by tests.
if (!originalThread) process.env.CODEX_THREAD_ID = thread;
after(() => { if (!originalThread) delete process.env.CODEX_THREAD_ID; });
const inspect = async () => ({ help: '--thread UUID --message TEXT', version: 'codex-cli 0.163.0-alpha.11.2' });
const cliOptions = { inspect, envPath: '' };
const unitIdentity = async (pid) => ({ pid, alive: true, available: true, source: 'injected-unit',
  created_at: '2026-01-01T00:00:00.000Z', exe_path: process.execPath, entry_path: fileURLToPath(import.meta.url) });

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-cold-cli-'));
  t.after(() => {
    const absolute = path.resolve(dir);
    assert.ok(absolute.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(absolute).startsWith('lab-cold-cli-'));
    fs.rmSync(absolute, { recursive: true, force: true });
  });
  const root = path.join(dir, 'OpenAI', 'Codex', 'bin');
  const old = path.join(root, 'aaaaaaaaaaaaaaaa', 'codex.exe'); fs.mkdirSync(path.dirname(old), { recursive: true }); fs.writeFileSync(old, 'inert old fixture');
  const c = { v: 2, mode: 'daily', transport: 'target-pull', enabled: false, thread_id: thread,
    allowed_senders: ['dsh:session-11111111-1111-4111-8111-111111111111'], cli: old, cli_sha256: binaryHash(old),
    cli_version: 'codex-cli 0.163.0-alpha.11', cli_install_root: root, allow_installed_cli_refresh: true,
    workspace: dir, rollout_path: path.join(dir, 'rollout.jsonl'), state_db: path.join(dir, 'state.sqlite'),
    runtime_dir: path.join(dir, 'runtime'), activated_at: new Date(Date.now() - 10000).toISOString(), expires_at: null,
    window_id: crypto.randomUUID(), binding_epoch: crypto.randomUUID(), start_at_logon: false, max_native_submissions: null,
    rate_limit: { max_submissions: 11, window_ms: 3600000 }, min_interval_ms: 30000, idle_settle_ms: 3000,
    poll_interval_ms: 500, max_text_bytes: 12000, accept_backlog: true };
  fs.mkdirSync(c.runtime_dir); const file = path.join(dir, 'config.json'); fs.writeFileSync(file, JSON.stringify(c));
  const db = new DatabaseSync(c.state_db); db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, archived INTEGER)');
  db.prepare('INSERT INTO threads VALUES(?,?,?,0)').run(thread, c.rollout_path, dir); db.close();
  fs.writeFileSync(c.rollout_path, JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'task_started', turn_id: crypto.randomUUID() } }) + '\n');
  fs.unlinkSync(old); const current = path.join(root, 'bbbbbbbbbbbbbbbb', 'codex.exe'); fs.mkdirSync(path.dirname(current)); fs.writeFileSync(current, 'inert replacement, never execute');
  return { dir, c, file, current };
}

test('cold prepare repairs a removed CLI without resetting custom quota, epoch, window or ledger', async (t) => {
  const f = fixture(t), ledger = path.join(f.c.runtime_dir, 'ledger.json'), ledgerText = '{"v":1,"entries":{}}'; fs.writeFileSync(ledger, ledgerText);
  const result = await prepareDaily({ configPath: f.file, stateDb: f.c.state_db, runtimeRoot: f.c.runtime_dir, cliOptions });
  assert.equal(result.status, 'ALREADY_CONFIGURED'); assert.equal(result.cli_refreshed, true);
  const after = JSON.parse(fs.readFileSync(f.file)); assert.equal(after.cli, fs.realpathSync(f.current));
  assert.equal(after.rate_limit.max_submissions, 11); assert.equal(after.window_id, f.c.window_id);
  assert.equal(after.binding_epoch, f.c.binding_epoch); assert.equal(after.start_at_logon, false); assert.equal(after.enabled, false);
  assert.deepEqual(after.allowed_senders, f.c.allowed_senders); assert.equal(fs.readFileSync(ledger, 'utf8'), ledgerText);
});

test('cold owner enable repairs the removed CLI and starts only its isolated busy worker', { skip: process.platform !== 'win32' }, async (t) => {
  const f = fixture(t);
  try {
    const result = await enableDaily(f.file, { cliOptions });
    assert.equal(result.action, 'ENABLED'); assert.equal(result.healthy, true);
    assert.equal(JSON.parse(fs.readFileSync(f.file)).cli, fs.realpathSync(f.current));
    assert.equal(fs.existsSync(path.join(f.c.runtime_dir, 'last-dispatch.json')), false);
    assert.equal((await disableDaily(f.file)).running, false);
  } finally { await disableDaily(f.file); }
});

test('unsupported cold enable leaves the target disabled and starts no process', async (t) => {
  const f = fixture(t), before = fs.readFileSync(f.file, 'utf8');
  await assert.rejects(enableDaily(f.file, { cliOptions: { inspect: async () => ({ help: '--different', version: 'codex-cli 1.2.3' }) } }), /CLI_QUEUE_UNSUPPORTED/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(f.c.runtime_dir, 'receiver.lock')), false);
  assert.equal(fs.existsSync(path.join(f.c.runtime_dir, 'service.lock')), false);
});

test('doctor reports a repair proposal without changing config; explicit owner repair preserves disabled state', async (t) => {
  const f = fixture(t), before = fs.readFileSync(f.file, 'utf8');
  const doctor = await inspectDaily(f.file, { cliOptions });
  assert.equal(doctor.cli_compatible, true); assert.equal(doctor.cli_repair_required, true); assert.equal(doctor.config_changed, false);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  const result = await repairDailyCli(f.file, { cliOptions });
  assert.equal(result.status, 'CLI_REPAIRED'); assert.equal(result.enabled, false); assert.equal(result.binding_changed, false);
});

test('the worker cold path repairs the same removed pin without Hub or native work', async (t) => {
  const f = fixture(t); fs.writeFileSync(f.file, JSON.stringify({ ...f.c, enabled: true })); let calls = 0, ticks = 0;
  await runDaily(f.file, { cliOptions, identityProvider: unitIdentity, lifecycle: () => [{ type: 'task_started' }],
    executeNative: async () => { calls++; throw new Error('native must not run'); },
    wait: async () => { if (++ticks >= 2) fs.writeFileSync(f.file, JSON.stringify({ ...JSON.parse(fs.readFileSync(f.file)), enabled: false })); } });
  assert.equal(calls, 0); assert.equal(JSON.parse(fs.readFileSync(f.file)).cli, fs.realpathSync(f.current));
  assert.equal(fs.existsSync(path.join(f.c.runtime_dir, 'receiver.lock')), false);
});

test('invalid setup input fails before CLI inspection or any partial repair', async (t) => {
  for (const patch of [{ perHour: 0 }, { perHour: Number.NaN }, { senders: ['cli:operator'] }]) {
    const f = fixture(t), before = fs.readFileSync(f.file, 'utf8'); let calls = 0;
    await assert.rejects(prepareDaily({ configPath: f.file, stateDb: f.c.state_db, runtimeRoot: f.c.runtime_dir, ...patch,
      cliOptions: { inspect: async () => { calls++; return inspect(); } } }), /RECEIVER_(RATE_LIMIT|SENDERS)_INVALID/);
    assert.equal(calls, 0); assert.equal(fs.readFileSync(f.file, 'utf8'), before);
    assert.equal(fs.existsSync(path.join(f.c.runtime_dir, 'cli-refresh.jsonl')), false);
  }
});
