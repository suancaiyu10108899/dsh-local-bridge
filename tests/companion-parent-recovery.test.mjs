import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { installationPaths, readInstallation, writeInstallationAtomic } from '../src/installation.mjs';
import { runtimePaths, writeJsonAtomic } from '../src/runtime.mjs';
import { DEFAULT_CONFIG } from '../src/runtime.mjs';
import { createCompanion } from '../src/companion.mjs';
import { createCompanionHub } from '../src/companion-hub.mjs';
import { createMembership, registerMembershipDisable, registerMembershipEnable, writeMembershipAtomic } from '../src/membership.mjs';
import { readProcessIdentity } from '../src/process-identity.mjs';
import { prepareDaily, enableDaily } from '../codex-receiver/adapters/codex/receiver-control.mjs';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const COMPANION_ENTRY = path.join(PROJECT_ROOT, 'companion', 'main.mjs');
const THREAD = '44444444-4444-4444-8444-444444444444';
const TARGET = `codex:${THREAD}`;
const SENDER = 'dsh:session-22222222-2222-4222-8222-222222222222';

function waitFor(predicate, { timeoutMs = 30_000, intervalMs = 50 } = {}) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      Promise.resolve().then(predicate).then((value) => {
        if (value) { clearInterval(timer); resolve(value); return; }
        if (Date.now() > deadline) { clearInterval(timer); reject(new Error('waitFor timeout')); }
      }).catch((error) => { clearInterval(timer); reject(error); });
    }, intervalMs);
    timer.unref?.();
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function verifiedKill(pid, expected, label, signal = 'SIGTERM') {
  const actual = await readProcessIdentity(pid);
  if (actual.alive !== true || !actual.available) return { skipped: true, reason: 'not-alive', label };
  if (expected.created_at !== undefined && actual.created_at !== expected.created_at) return { skipped: true, reason: 'identity-changed', label };
  if (expected.entry_path !== undefined && actual.entry_path !== expected.entry_path) return { skipped: true, reason: 'entry-changed', label };
  try { process.kill(pid, signal); } catch { /* gone */ }
  return { killed: true, label };
}

test('real parent SIGKILL leaves Hub/worker alive; same-instance restart adopts one worker without duplicate spawn or ledger reset', { timeout: 150_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-parent-recovery-'));
  const paths = installationPaths(root);
  fs.mkdirSync(path.join(paths.runtimeRoot, 'hub'), { recursive: true });
  const installation = writeInstallationAtomic({
    root,
    installation: {
      v: 1, installation_id: 'install-parent-recovery', instance_id: 'instance-parent-recovery',
      active_version: '0.1.0-test', app_root: path.join(root, 'app'), runtime_root: paths.runtimeRoot,
      hub_owner_kind: 'COMPANION_OWNED', protocol_version: 1, state_schema: 1,
    },
  });
  const runtime = runtimePaths(paths.runtimeRoot);
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const rollout = path.join(root, 'rollout.jsonl');
  fs.writeFileSync(rollout, `${JSON.stringify({
    timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_started', turn_id: crypto.randomUUID() },
  })}\n`);
  const stateDb = path.join(root, 'state.sqlite');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(stateDb);
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, cwd TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0)');
  db.prepare('INSERT INTO threads (id, rollout_path, cwd, archived) VALUES (?, ?, ?, 0)').run(THREAD, rollout, workspace);
  db.close();
  const vendorBin = path.join(root, 'vendor', 'codex', 'bin', '0123456789abcdef');
  fs.mkdirSync(vendorBin, { recursive: true });
  const inertCli = path.join(vendorBin, 'codex.exe');
  fs.writeFileSync(inertCli, 'inert vendor cli; no native queue in this test\n');
  const inspectCli = () => ({ help: 'codex queue --thread <uuid> --message <text>', version: 'codex-cli 1.0.0' });
  const configDir = path.join(paths.runtimeRoot, 'codex', THREAD);
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'receiver-config.json');
  const previousThread = process.env.CODEX_THREAD_ID;
  process.env.CODEX_THREAD_ID = THREAD;
  try {
    await prepareDaily({ senders: [SENDER], cli: inertCli, configPath, stateDb, installationRoot: root, inspectCli, cliOptions: { inspect: inspectCli } });
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.poll_interval_ms = 500;
    fs.writeFileSync(configPath, JSON.stringify(config));
    await enableDaily(configPath, { cliOptions: { inspect: inspectCli } });
  } finally {
    if (previousThread === undefined) delete process.env.CODEX_THREAD_ID;
    else process.env.CODEX_THREAD_ID = previousThread;
  }
  writeJsonAtomic(runtime.configFile, { ...DEFAULT_CONFIG, host: '127.0.0.1', port: await freePort() });

  const parent = spawn(process.execPath, [COMPANION_ENTRY, '--installation', root, '--reason', 'USER_ENABLE', '--poll-ms', '250'], {
    cwd: PROJECT_ROOT,
    env: (() => { const env = { ...process.env }; delete env.CODEX_THREAD_ID; return env; })(),
    stdio: 'ignore', windowsHide: true,
  });
  const pids = { worker: null, hub: null, parent: parent.pid };
  try {
    const statusFile = path.join(configDir, 'status.json');
    const workerStatus = await waitFor(() => {
      if (!fs.existsSync(statusFile)) return null;
      const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
      return status.enabled === true && status.heartbeat_at ? status : null;
    }, { timeoutMs: 30_000 });
    pids.worker = workerStatus.pid;
    const server = await waitFor(() => (fs.existsSync(runtime.serverInfoFile) ? JSON.parse(fs.readFileSync(runtime.serverInfoFile, 'utf8')) : null), { timeoutMs: 20_000 });
    pids.hub = server.pid;
    const workerBefore = fs.readFileSync(statusFile);
    const ledgerFile = path.join(configDir, 'ledger.json');
    const ledgerBefore = fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile) : null;
    const otherTarget = 'codex:55555555-5555-4555-8555-555555555555';
    const otherConfig = path.join(paths.runtimeRoot, 'codex', 'other', 'receiver-config.json');
    fs.mkdirSync(path.dirname(otherConfig), { recursive: true });
    writeMembershipAtomic(paths.runtimeRoot, createMembership({
      installation_id: installation.installation_id,
      instance_id: installation.instance_id,
      target: otherTarget,
      binding_epoch: 'other-epoch',
      config_path: otherConfig,
      desired_state: 'DISABLED',
      enabled: false,
      owner_opt_in: false,
    }));
    const otherMembershipDir = path.join(paths.runtimeRoot, 'memberships');
    const otherFile = fs.readdirSync(otherMembershipDir).map((name) => path.join(otherMembershipDir, name))
      .find((file) => JSON.parse(fs.readFileSync(file, 'utf8')).target === otherTarget);
    const otherBefore = fs.readFileSync(otherFile);

    process.kill(parent.pid, 'SIGKILL');
    pids.parent = null;
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal((await readProcessIdentity(pids.worker)).alive, true, 'worker must survive parent SIGKILL');
    assert.equal((await readProcessIdentity(pids.hub)).alive, true, 'hub must survive parent SIGKILL');

    const lines = [];
    const newMain = spawn(process.execPath, [COMPANION_ENTRY, '--installation', root, '--reason', 'RECOVERY', '--poll-ms', '250'], {
      cwd: PROJECT_ROOT,
      env: (() => { const env = { ...process.env }; delete env.CODEX_THREAD_ID; return env; })(),
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    const onData = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) if (line.length > 0) lines.push(line);
    };
    newMain.stdout.on('data', onData);
    newMain.stderr.on('data', onData);
    let productStopped = false;
    try {
      const adoption = await waitFor(() => lines.find((line) => line.includes('companion/worker-adopted')), { timeoutMs: 30_000 });
      assert.ok(adoption);
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      assert.equal(newMain.exitCode, null, 'new companion/main must stay alive');
      assert.equal((await readProcessIdentity(pids.worker)).alive, true);
      assert.equal((await readProcessIdentity(pids.hub)).alive, true);
      assert.equal(lines.some((line) => line.includes('companion/worker-started')), false, 'adoption must not spawn a second worker');
      const statusAfterAdoption = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
      const workerBeforeStatus = JSON.parse(workerBefore.toString('utf8'));
      assert.equal(statusAfterAdoption.pid, workerBeforeStatus.pid, 'adoption must not replace the worker');
      assert.equal(statusAfterAdoption.worker_nonce, workerBeforeStatus.worker_nonce, 'adoption must not reset worker nonce');
      if (ledgerBefore !== null) assert.equal(fs.readFileSync(ledgerFile).equals(ledgerBefore), true, 'ledger must not be reset by adoption');
      assert.equal(fs.readFileSync(otherFile).equals(otherBefore), true, 'other target membership must be untouched');

      // Product-owned adopted Hub: crash it and prove the same instance recovers
      // it under the persisted Hub policy before a global STOP.
      const oldHubPid = pids.hub;
      await verifiedKill(oldHubPid, { entry_path: path.join(PROJECT_ROOT, 'hub', 'main.mjs') }, 'adopted-hub-crash', 'SIGKILL');
      const recoveredHub = await waitFor(() => {
        if (!fs.existsSync(runtime.serverInfoFile)) return null;
        const current = JSON.parse(fs.readFileSync(runtime.serverInfoFile, 'utf8'));
        return Number.isInteger(current.pid) && current.pid !== oldHubPid ? current : null;
      }, { timeoutMs: 30_000 });
      assert.notEqual(recoveredHub.pid, oldHubPid);
      pids.hub = recoveredHub.pid;

      // A subsequent owner enable is discovered by the still-running main.
      registerMembershipDisable({ root: paths.runtimeRoot, target: TARGET });
      await waitFor(() => lines.some((line) => line.includes('companion/worker-stop-cooperative-confirmed')), { timeoutMs: 10_000 }).catch(() => null);
      registerMembershipEnable({
        root: paths.runtimeRoot,
        installation_id: installation.installation_id,
        instance_id: installation.instance_id,
        target: TARGET,
        binding_epoch: JSON.parse(fs.readFileSync(configPath, 'utf8')).binding_epoch,
        config_path: configPath,
        registration_nonce: 'post-recovery-owner-enable',
      });
      await waitFor(() => lines.some((line) => line.includes('companion/worker-started')), { timeoutMs: 20_000 });
      pids.worker = JSON.parse(fs.readFileSync(statusFile, 'utf8')).pid;
      assert.equal(newMain.exitCode, null);

      fs.writeFileSync(path.join(runtime.runtimeDir, 'desired-state.json'), JSON.stringify({ desired_state: 'STOPPED' }));
      await new Promise((resolve) => {
        if (newMain.exitCode !== null) { resolve(); return; }
        newMain.once('exit', resolve);
        setTimeout(resolve, 10_000);
      });
      assert.equal(newMain.exitCode, 0, 'explicit global STOP is a normal main exit');
      assert.equal((await readProcessIdentity(pids.hub)).alive, false, 'global STOP must stop the adopted/recovered Hub');
      assert.equal((await readProcessIdentity(pids.worker)).alive, false, 'global STOP must stop the adopted/recovered worker');
      productStopped = true;
    } finally {
      if (newMain.exitCode === null) { try { newMain.kill('SIGTERM'); } catch { /* gone */ } }
      if (!productStopped) await verifiedKill(pids.hub, { entry_path: path.join(PROJECT_ROOT, 'hub', 'main.mjs') }, 'hub-cleanup');
    }
  } finally {
    if (pids.parent !== null && parent.exitCode === null) {
      try { process.kill(pids.parent, 'SIGKILL'); } catch { /* gone */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (pids.worker !== null) {
      const identity = await readProcessIdentity(pids.worker).catch(() => ({ alive: false }));
      if (identity.alive === true) {
        const statusFile = path.join(configDir, 'status.json');
        const expected = fs.existsSync(statusFile) ? JSON.parse(fs.readFileSync(statusFile, 'utf8')) : {};
        await verifiedKill(pids.worker, {
          created_at: expected.process_created_at,
          entry_path: path.join(PROJECT_ROOT, 'codex-receiver', 'adapters', 'codex', 'daily-receiver.mjs'),
        }, 'worker');
      }
    }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* retained for OS cleanup */ }
    }
  }
});
