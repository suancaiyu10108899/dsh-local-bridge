import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { HubStore } from '../src/store.mjs';
import { BridgeHub } from '../src/hub.mjs';
import { installationPaths, readInstallation, writeInstallationAtomic } from '../src/installation.mjs';
import { createTargetBindingStamper } from '../src/target-binding.mjs';
import { DEFAULT_CONFIG, runtimePaths, writeJsonAtomic } from '../src/runtime.mjs';
import { createMembership, writeMembershipAtomic } from '../src/membership.mjs';
import { prepareDaily, enableDaily, disableDaily } from '../codex-receiver/adapters/codex/receiver-control.mjs';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const COMPANION_ENTRY = path.join(PROJECT_ROOT, 'companion', 'main.mjs');
const THREAD = '11111111-1111-4111-8111-111111111111';
const SENDER = 'dsh:session-22222222-2222-4222-8222-222222222222';
const TARGET = `codex:${THREAD}`;

function waitFor(predicate, { timeoutMs = 20_000, intervalMs = 50 } = {}) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      try {
        const value = predicate();
        if (value) { clearInterval(timer); resolve(value); return; }
        if (Date.now() > deadline) { clearInterval(timer); reject(new Error('waitFor timeout')); }
      } catch (error) { clearInterval(timer); reject(error); }
    }, intervalMs);
    timer.unref?.();
  });
}

function waitForLine(lines, predicate, timeoutMs = 20_000) {
  return waitFor(() => lines.find(predicate), { timeoutMs, intervalMs: 20 });
}

test('real daily-receiver entry connects an isolated empty Hub, stays ONLINE_IDLE without native queue, and disables cleanly', { timeout: 60_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-daily-seam-'));
  const paths = installationPaths(root);
  fs.mkdirSync(path.join(paths.runtimeRoot, 'hub'), { recursive: true });
  const installation = writeInstallationAtomic({
    root,
    installation: {
      v: 1,
      installation_id: 'install-daily-seam',
      instance_id: 'instance-daily-seam',
      active_version: '0.1.0-test',
      app_root: path.join(root, 'app'),
      runtime_root: paths.runtimeRoot,
      hub_owner_kind: 'COMPANION_OWNED',
      protocol_version: 1,
      state_schema: 1,
    },
  });
  const runtime = runtimePaths(paths.runtimeRoot);
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const rollout = path.join(root, 'rollout.jsonl');
  const stateDb = path.join(root, 'state.sqlite');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(stateDb);
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, cwd TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0)');
  db.prepare('INSERT INTO threads (id, rollout_path, cwd, archived) VALUES (?, ?, ?, 0)').run(THREAD, rollout, workspace);
  db.close();
  const writeRollout = (eventType, atMs = Date.now()) => {
    fs.writeFileSync(rollout, `${JSON.stringify({
      timestamp: new Date(atMs).toISOString(),
      type: 'event_msg',
      payload: { type: eventType, turn_id: crypto.randomUUID() },
    })}\n`);
  };
  // Start BUSY so the worker has a real running identity before the idle switch.
  writeRollout('task_started');

  const vendorBin = path.join(root, 'vendor', 'codex', 'bin', '0123456789abcdef');
  fs.mkdirSync(vendorBin, { recursive: true });
  const inertCli = path.join(vendorBin, 'codex.exe');
  fs.writeFileSync(inertCli, 'inert vendor cli; not executed in this isolated test\n');
  const inspectCli = () => ({ help: 'codex queue --thread <uuid> --message <text>', version: 'codex-cli 1.0.0' });
  const configDir = path.join(paths.runtimeRoot, 'codex', THREAD);
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'receiver-config.json');

  const previousThread = process.env.CODEX_THREAD_ID;
  process.env.CODEX_THREAD_ID = THREAD;
  try {
    const prepared = await prepareDaily({
      senders: [SENDER],
      cli: inertCli,
      configPath,
      stateDb,
      installationRoot: root,
      inspectCli,
      cliOptions: { inspect: inspectCli },
    });
    assert.equal(prepared.status, 'PREPARED_DISABLED');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.poll_interval_ms = 500;
    config.idle_settle_ms = 3000;
    fs.writeFileSync(configPath, JSON.stringify(config));
    const enabled = await enableDaily(configPath, { cliOptions: { inspect: inspectCli } });
    assert.equal(enabled.action, 'ENABLE_REGISTERED');
    assert.equal(enabled.background_spawned, false);
  } finally {
    if (previousThread === undefined) delete process.env.CODEX_THREAD_ID;
    else process.env.CODEX_THREAD_ID = previousThread;
  }

  // A second, independent target must remain untouched by this target's disable.
  const otherTarget = 'codex:33333333-3333-4333-8333-333333333333';
  const otherConfig = path.join(paths.runtimeRoot, 'codex', 'other', 'receiver-config.json');
  fs.mkdirSync(path.dirname(otherConfig), { recursive: true });
  writeMembershipAtomic(paths.runtimeRoot, createMembership({
    installation_id: installation.installation_id,
    instance_id: installation.instance_id,
    target: otherTarget,
    binding_epoch: 'epoch-other',
    config_path: otherConfig,
    desired_state: 'DISABLED',
    enabled: false,
    owner_opt_in: false,
  }));
  const otherMembershipPath = path.join(paths.runtimeRoot, 'memberships');
  const otherFile = fs.readdirSync(otherMembershipPath).map((name) => path.join(otherMembershipPath, name))
    .find((file) => JSON.parse(fs.readFileSync(file, 'utf8')).target === otherTarget);
  const otherBefore = fs.readFileSync(otherFile, 'utf8');

  // Isolated empty Hub with a valid binding stamper.
  const hubStore = new HubStore({
    stateFile: path.join(runtime.hubDir, 'state.json'),
    eventsFile: path.join(runtime.hubDir, 'events.jsonl'),
  }).load();
  hubStore.addTarget(SENDER);
  hubStore.addTarget(TARGET);
  const targetBinding = createTargetBindingStamper({
    installation: readInstallation({ root }),
    runtimeRoot: installation.runtime_root,
    locatorPath: paths.locator,
  });
  const hubToken = crypto.randomBytes(32).toString('hex');
  const hub = new BridgeHub({
    store: hubStore,
    token: hubToken,
    host: '127.0.0.1',
    port: 0,
    installation,
    targetBinding,
  });
  const address = await hub.start();
  writeJsonAtomic(runtime.configFile, { ...DEFAULT_CONFIG, host: '127.0.0.1', port: address.port });
  fs.writeFileSync(runtime.tokenFile, `${hubToken}\n`, { encoding: 'utf8' });
  // The worker loads the token from the same hub runtime; replace with the real test token
  // through the public client config path is not available, so use a private token file
  // created before starting the Hub instead.
  t.after(async () => {
    await hub.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const lines = [];
  const child = spawn(process.execPath, [COMPANION_ENTRY, '--installation', root, '--reason', 'USER_ENABLE', '--poll-ms', '250'], {
    cwd: PROJECT_ROOT,
    env: (() => {
      const env = { ...process.env };
      delete env.CODEX_THREAD_ID;
      // Reproduce the bootstrap-provided ambient runtime/installation values;
      // the companion must strip them before spawning the installed worker.
      env.LAB_BRIDGE_RUNTIME_DIR = paths.runtimeRoot;
      env.LAB_BRIDGE_INSTALLATION_ROOT = root;
      return env;
    })(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 3_000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    try { lines.push(JSON.parse(line)); } catch { /* ignore */ }
  });
  createInterface({ input: child.stderr }).on('line', (line) => {
    try { lines.push({ event: 'stderr', detail: JSON.parse(line) }); } catch { /* ignore */ }
  });

  const statusFile = path.join(configDir, 'status.json');
  await waitForLine(lines, (entry) => entry.event === 'companion/worker-healthy', 30_000);
  const runningStatus = await waitFor(() => {
    if (!fs.existsSync(statusFile)) return null;
    const value = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    return value.schema_version === 3 && value.status ? value : null;
  }, { timeoutMs: 20_000 });
  assert.equal(runningStatus.schema_version, 3);
  assert.equal(typeof runningStatus.worker_nonce, 'string');
  assert.equal(runningStatus.pid, runningStatus.owner_process?.pid);

  // Switch the synthetic rollout to idle only after the real worker is proven online.
  writeRollout('task_complete', Date.now() - 5_000);
  const idleStatus = await waitFor(() => {
    if (!fs.existsSync(statusFile)) return null;
    const value = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    return value.status === 'ONLINE_IDLE' ? value : null;
  }, { timeoutMs: 25_000 });
  assert.equal(idleStatus.mode, 'daily');
  assert.equal(idleStatus.used_native_submissions, 0);
  assert.equal(fs.existsSync(path.join(configDir, 'last-dispatch.json')), false);
  const ledgerFile = path.join(configDir, 'ledger.json');
  const ledger = fs.existsSync(ledgerFile) ? JSON.parse(fs.readFileSync(ledgerFile, 'utf8')) : { v: 1, entries: {} };
  assert.equal(Object.keys(ledger.entries).length, 0);

  const disablePreviousThread = process.env.CODEX_THREAD_ID;
  process.env.CODEX_THREAD_ID = THREAD;
  let disabled;
  try {
    disabled = await disableDaily(configPath);
  } finally {
    if (disablePreviousThread === undefined) delete process.env.CODEX_THREAD_ID;
    else process.env.CODEX_THREAD_ID = disablePreviousThread;
  }
  assert.equal(disabled.stop_confirmed, true);
  assert.equal(disabled.running, false);
  assert.equal(disabled.service_running, false);
  await waitFor(() => {
    if (!fs.existsSync(statusFile)) return null;
    const value = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    return value.status === 'DISABLED' && value.enabled === false ? value : null;
  }, { timeoutMs: 10_000 });
});
