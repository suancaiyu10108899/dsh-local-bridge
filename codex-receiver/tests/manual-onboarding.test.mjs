import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_CONFIG, runtimePaths } from '../src/runtime.mjs';
import { HubStore } from '../src/store.mjs';
import { createInstallation, defaultInstallationRoot } from '../src/installation.mjs';
import { prepareDaily, enableDaily, disableDaily, receiverStatus, control } from '../adapters/codex/receiver-control.mjs';
import { receiverHubOptions } from '../adapters/codex/receiver-context.mjs';

const canonical = path.resolve(import.meta.dirname, '../..');
const source = 'dsh:session-11111111-1111-4111-8111-111111111111';
const hash = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(predicate, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await delay(100); }
  throw new Error('isolated manual onboarding timed out');
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-manual-onboard-'));
  const saved = Object.fromEntries(['CODEX_THREAD_ID', 'LOCALAPPDATA', 'LAB_BRIDGE_RUNTIME_DIR'].map((k) => [k, process.env[k]]));
  const thread = saved.CODEX_THREAD_ID ?? crypto.randomUUID();
  // Synthetic local SQLite/rollout and inert CLI only; never a production target.
  if (!saved.CODEX_THREAD_ID) process.env.CODEX_THREAD_ID = thread;
  process.env.LOCALAPPDATA = path.join(dir, 'user-local'); delete process.env.LAB_BRIDGE_RUNTIME_DIR;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    const absolute = path.resolve(dir);
    assert.ok(absolute.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(absolute).startsWith('lab-manual-onboard-'));
    fs.rmSync(absolute, { recursive: true, force: true });
  });
  const root = path.join(dir, 'existing-runtime');
  const runtime = runtimePaths(root);
  fs.mkdirSync(runtime.hubDir, { recursive: true });
  fs.writeFileSync(runtime.configFile, JSON.stringify({ ...DEFAULT_CONFIG, host: '127.0.0.1', port: 47832 }));
  fs.writeFileSync(runtime.tokenFile, 'synthetic-token-only-'.repeat(4));
  const cli = path.join(dir, 'OpenAI', 'Codex', 'bin', 'aaaaaaaaaaaaaaaa', 'codex.exe');
  fs.mkdirSync(path.dirname(cli), { recursive: true }); fs.writeFileSync(cli, 'inert vendor fixture; never execute');
  const stateDb = path.join(dir, 'state.sqlite'), rollout = path.join(dir, 'rollout.jsonl'), turn = crypto.randomUUID();
  const db = new DatabaseSync(stateDb);
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, archived INTEGER)');
  db.prepare('INSERT INTO threads VALUES(?,?,?,0)').run(thread, rollout, dir); db.close();
  fs.writeFileSync(rollout, `${JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'task_started', turn_id: turn } })}\n`);
  const cliOptions = { inspect: async () => ({ help: '--thread --message', version: 'codex-cli 0.163.0-alpha.11.2' }), envPath: '' };
  return { dir, root, runtime, thread, rollout, turn, cliOptions,
    options: { manualRuntimeRoot: root, cli, stateDb, senders: [source], cliOptions } };
}

test('explicit legacy Hub prepare creates only the exact disabled owner target, not a locator/Hub/startup', async (t) => {
  const f = fixture(t), beforeToken = hash(f.runtime.tokenFile), beforeHub = hash(f.runtime.configFile);
  const p = await prepareDaily(f.options);
  assert.equal(p.status, 'PREPARED_DISABLED');
  assert.equal(p.config.runtime_dir, path.join(f.root, 'codex', f.thread));
  assert.equal(p.config.hub_runtime_root, f.root); assert.equal(p.config.runtime_mode, 'MANUAL_LEGACY_HUB');
  assert.equal(p.config.enabled, false); assert.equal(p.config.owner_opt_in, false);
  assert.equal(p.config.start_at_logon, false); assert.equal(p.config.installation_id, undefined);
  assert.equal(receiverHubOptions(p.config).port, 47832);
  assert.equal(hash(f.runtime.tokenFile), beforeToken); assert.equal(hash(f.runtime.configFile), beforeHub);
  assert.equal(fs.existsSync(defaultInstallationRoot()), false);
  for (const file of ['receiver.lock', 'service.lock', 'startup.json']) assert.equal(fs.existsSync(path.join(p.config.runtime_dir, file)), false);
  const again = await prepareDaily(f.options);
  assert.equal(again.config.window_id, p.config.window_id); assert.equal(again.config.binding_epoch, p.config.binding_epoch);
});

test('manual runtime conflicts, missing existing Hub and old unmarked config fail before mutation', async (t) => {
  const f = fixture(t);
  await assert.rejects(control(['prepare', '--manual-runtime', f.root, '--installation-root', path.join(f.dir, 'installation')]), /RUNTIME_INSTANCE_CONFLICT/);
  await assert.rejects(prepareDaily({ ...f.options, manualRuntimeRoot: path.join(f.dir, 'not-existing') }), /MANUAL_HUB_RUNTIME_NOT_READY/);
  assert.equal(fs.existsSync(path.join(f.dir, 'not-existing')), false);
  const p = await prepareDaily(f.options), prior = { ...p.config };
  delete prior.runtime_mode; delete prior.hub_runtime_root;
  fs.writeFileSync(p.config_path, JSON.stringify(prior));
  const before = fs.readFileSync(p.config_path, 'utf8');
  await assert.rejects(prepareDaily(f.options), /LEGACY_CONFIG_REQUIRES_EXISTING_TOOL/);
  assert.equal(fs.readFileSync(p.config_path, 'utf8'), before);
});

test('a locator appearing after manual prepare prevents parallel legacy enable', async (t) => {
  const f = fixture(t), p = await prepareDaily(f.options), before = fs.readFileSync(p.config_path, 'utf8');
  createInstallation({ root: defaultInstallationRoot(), activeVersion: 'fixture-installed', hubOwnerKind: 'COMPANION_OWNED' });
  await assert.rejects(enableDaily(p.config_path, { cliOptions: f.cliOptions }), /MANUAL_RUNTIME_REQUIRES_LEGACY_HUB/);
  assert.equal(fs.readFileSync(p.config_path, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(p.config.runtime_dir, 'service.lock')), false);
});

test('manual first write rejects a receiver junction escaping the selected Hub runtime', { skip: process.platform !== 'win32' }, async (t) => {
  const f = fixture(t), outside = path.join(f.dir, 'outside-selected-runtime'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.root, 'codex'), 'junction');
  await assert.rejects(prepareDaily(f.options), /RUNTIME_INSTANCE_CONFLICT/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('manual new target uses a real isolated legacy Hub, reaches idle with zero native submissions and stops only itself', { skip: process.platform !== 'win32', timeout: 65000 }, async (t) => {
  const f = fixture(t);
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer(); server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); });
  });
  fs.writeFileSync(f.runtime.configFile, JSON.stringify({ ...DEFAULT_CONFIG, host: '127.0.0.1', port }));
  const store = new HubStore({ stateFile: f.runtime.stateFile, eventsFile: f.runtime.eventsFile }).load();
  store.addTarget(source); store.addTarget(`codex:${f.thread}`);
  const env = { ...process.env, LAB_BRIDGE_RUNTIME_DIR: f.root }; delete env.CODEX_THREAD_ID; delete env.LAB_BRIDGE_INSTALLATION_ROOT;
  const hub = spawn(process.execPath, [path.join(canonical, 'hub/main.mjs')], { cwd: canonical, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let hubOutput = '', stage = 'HUB_START';
  hub.stdout.on('data', (chunk) => { hubOutput = (hubOutput + chunk).slice(-3000); });
  hub.stderr.on('data', (chunk) => { hubOutput = (hubOutput + chunk).slice(-3000); });
  let p;
  try {
    await waitFor(() => {
      if (hub.exitCode !== null || hub.signalCode !== null) throw new Error('fixture Hub exited before ready');
      return fs.existsSync(f.runtime.serverInfoFile) && JSON.parse(fs.readFileSync(f.runtime.serverInfoFile)).pid === hub.pid;
    });
    stage = 'OWNER_PREPARE_ENABLE';
    p = await prepareDaily(f.options);
    const enabled = await enableDaily(p.config_path, { cliOptions: f.cliOptions });
    assert.equal(enabled.healthy, true);
    assert.equal(JSON.parse(fs.readFileSync(p.config_path)).owner_opt_in, true);
    stage = 'WAIT_FOR_IDLE';
    fs.appendFileSync(f.rollout, `${JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'task_complete', turn_id: f.turn } })}\n`);
    await waitFor(() => {
      try { return JSON.parse(fs.readFileSync(path.join(p.config.runtime_dir, 'status.json'))).status === 'ONLINE_IDLE'; } catch { return false; }
    });
    const status = await receiverStatus(p.config_path);
    assert.equal(status.healthy, true); assert.equal(status.guidance.evidence.model_receipt_reported, null);
    assert.equal(fs.existsSync(path.join(p.config.runtime_dir, 'last-dispatch.json')), false);
    const ledger = path.join(p.config.runtime_dir, 'ledger.json');
    assert.deepEqual(fs.existsSync(ledger) ? JSON.parse(fs.readFileSync(ledger)).entries : {}, {});
    assert.equal(status.used_native_submissions, 0);
    assert.equal(fs.existsSync(defaultInstallationRoot()), false);
    const stopped = await disableDaily(p.config_path); assert.equal(stopped.stop_confirmed, true);
    assert.equal(hub.exitCode, null, 'disabling this target must preserve the selected Hub');
    assert.equal(hub.signalCode, null);
  } catch (error) {
    const details = {};
    if (p) {
      for (const name of ['service-status.json', 'status.json']) {
        try { const s = JSON.parse(fs.readFileSync(path.join(p.config.runtime_dir, name))); details[name] = {
          status: s.status, reason_code: s.reason_code, last_error: s.last_error, pid: s.pid, worker_nonce: s.worker_nonce,
        }; } catch { details[name] = 'not-written'; }
      }
      try { details.stderr = fs.readFileSync(path.join(p.config.runtime_dir, 'stderr.log'), 'utf8').slice(-2000); } catch { /* fixture had no stderr */ }
    }
    error.message = `${stage}: ${error.message}; receiver: ${JSON.stringify(details)}; fixture Hub output: ${hubOutput}`;
    throw error;
  } finally {
    if (p) await disableDaily(p.config_path);
    if (hub.exitCode === null && hub.signalCode === null) { hub.kill('SIGTERM'); await Promise.race([new Promise((r) => hub.once('exit', r)), delay(4000)]); }
    assert.ok(hub.exitCode !== null || hub.signalCode !== null, 'the fixture Hub must be confirmed stopped before cleanup');
  }
});
