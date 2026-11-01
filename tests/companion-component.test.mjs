import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { installationPaths, readInstallation, writeInstallationAtomic } from '../src/installation.mjs';
import {
  membershipPath,
  readMembership,
  registerMembershipDisable,
  registerMembershipEnable,
} from '../src/membership.mjs';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const COMPANION_ENTRY = path.join(PROJECT_ROOT, 'companion', 'main.mjs');
const FAKE_WORKER = path.join(PROJECT_ROOT, 'tests', 'fixtures', 'fake-worker.mjs');
const TARGET = 'codex:thread-seam-1';
const THREAD = 'thread-seam-1';

function waitForLine(child, lines, predicate, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      reject(new Error(`timed out waiting for companion log; last=${JSON.stringify(lines.slice(-5))}`));
    }, timeoutMs);
    const timer = setInterval(() => {
      const match = lines.find(predicate);
      if (match) {
        clearTimeout(deadline);
        clearInterval(timer);
        resolve(match);
      }
      if (child.exitCode !== null) {
        clearTimeout(deadline);
        clearInterval(timer);
        reject(new Error(`companion exited ${child.exitCode} before expected log; last=${JSON.stringify(lines.slice(-5))}`));
      }
    }, 20);
    timer.unref?.();
  });
}

test('component: isolated companion fake-worker lifecycle with owner enable, opt-in/nonce/locator and verified stop', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-companion-seam-'));
  const paths = installationPaths(root);
  fs.mkdirSync(paths.runtimeRoot, { recursive: true });
  writeInstallationAtomic({
    root,
    installation: {
      v: 1,
      installation_id: 'install-seam',
      instance_id: 'instance-seam',
      active_version: '0.1.0-test',
      app_root: path.join(root, 'app'),
      runtime_root: paths.runtimeRoot,
      hub_owner_kind: 'COMPANION_OWNED',
      protocol_version: 1,
      state_schema: 1,
    },
  });
  const installation = readInstallation({ root });
  const configDir = path.join(paths.runtimeRoot, 'codex', THREAD);
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'receiver-config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    mode: 'daily',
    expires_at: null,
    thread_id: THREAD,
    installation_id: installation.installation_id,
    instance_id: installation.instance_id,
    binding_epoch: 'epoch-seam-1',
    enabled: true,
    owner_opt_in: true,
    runtime_dir: configDir,
    locator: paths.locator,
  }));

  const enable = registerMembershipEnable({
    root: paths.runtimeRoot,
    installation_id: installation.installation_id,
    instance_id: installation.instance_id,
    target: TARGET,
    binding_epoch: 'epoch-seam-1',
    config_path: configPath,
    start_at_logon: false,
  });
  assert.equal(enable.owner_opt_in, true);
  assert.equal(enable.enabled, true);
  assert.equal(typeof enable.registration_nonce, 'string');
  assert.equal(enable.binding_epoch, 'epoch-seam-1');
  assert.equal(path.dirname(membershipPath(paths.runtimeRoot, TARGET)), path.join(paths.runtimeRoot, 'memberships'));
  assert.equal(fs.existsSync(path.join(paths.dataRoot, 'memberships')), false);
  const persisted = readMembership(membershipPath(paths.runtimeRoot, TARGET));
  assert.equal(persisted.owner_opt_in, true);
  assert.equal(persisted.registration_nonce, enable.registration_nonce);
  const persistedConfig = JSON.parse(fs.readFileSync(persisted.config_path, 'utf8'));
  assert.equal(persistedConfig.locator, paths.locator);
  assert.equal(persistedConfig.runtime_dir, configDir);

  const outputPath = path.join(root, 'worker-output.json');
  const statusPath = path.join(configDir, 'status.json');
  const lines = [];
  const child = spawn(process.execPath, [
    COMPANION_ENTRY,
    '--installation', root,
    '--worker-entry', FAKE_WORKER,
    '--reason', 'USER_ENABLE',
    '--poll-ms', '250',
    '--no-hub',
  ], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      CODEX_THREAD_ID: 'ambient-conversation-must-not-pass',
      FAKE_WORKER_OUT: outputPath,
      FAKE_WORKER_STATUS: statusPath,
      FAKE_WORKER_INSTALLATION_ID: installation.installation_id,
      FAKE_WORKER_INSTANCE_ID: installation.instance_id,
      FAKE_WORKER_THREAD_ID: THREAD,
      FAKE_WORKER_BINDING_EPOCH: 'epoch-seam-1',
      FAKE_WORKER_REAL_IDENTITY: '1',
    },
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
    fs.rmSync(root, { recursive: true, force: true });
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    try { lines.push(JSON.parse(line)); } catch { /* ignore non-JSON */ }
  });
  createInterface({ input: child.stderr }).on('line', (line) => {
    try { lines.push({ event: 'stderr', detail: JSON.parse(line) }); } catch { /* ignore */ }
  });

  await waitForLine(child, lines, (entry) => entry.event === 'companion/worker-healthy');
  assert.equal(fs.existsSync(outputPath), true);
  const workerOutput = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.equal(workerOutput.thread, null, 'ambient CODEX_THREAD_ID must be removed');
  assert.equal(workerOutput.args[0], configPath);

  registerMembershipDisable({ root: paths.runtimeRoot, target: TARGET });
  const stopped = await waitForLine(child, lines, (entry) => entry.event === 'companion/worker-stopped');
  assert.equal(stopped.signal, 'SIGTERM', 'verified identity must allow a direct owned stop');
  assert.equal(stopped.code ?? null, null);

  child.kill('SIGTERM');
  await new Promise((resolve) => {
    if (child.exitCode !== null) { resolve(); return; }
    child.once('exit', resolve);
    setTimeout(resolve, 3_000);
  });
});
