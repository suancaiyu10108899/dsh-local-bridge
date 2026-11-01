import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import { writeMembershipAtomic } from '../src/membership.mjs';

const rootDir = path.resolve(import.meta.dirname, '..');
const fakeWorker = path.join(rootDir, 'tests', 'fixtures', 'fake-worker.mjs');
const companionEntry = path.join(rootDir, 'companion', 'main.mjs');

function waitFor(fn, { timeoutMs = 8_000, intervalMs = 25 } = {}) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(async () => {
      try {
        const value = await fn();
        if (value) { clearInterval(timer); resolve(value); }
        else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('waitFor timeout')); }
      } catch (error) { clearInterval(timer); reject(error); }
    }, intervalMs);
  });
}

test('combined companion entry starts Hub, syncs an enabled membership and inert worker', { timeout: 30_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-combined-entry-'));
  const installationRoot = path.join(root, 'installation');
  const appRoot = path.join(rootDir);
  const runtimeRoot = path.join(root, 'runtime');
  const hubDir = path.join(runtimeRoot, 'hub');
  const configDir = path.join(runtimeRoot, 'codex', '01a99999-9999-4999-8999-999999999999');
  const locatorPath = path.join(installationRoot, 'installation.json');
  const fakeOut = path.join(root, 'worker-output.json');
  const fakeStatus = path.join(configDir, 'status.json');
  fs.mkdirSync(hubDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(installationRoot, { recursive: true });
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(hubDir, 'token'), `${token}\n`, 'utf8');
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); });
  });
  fs.writeFileSync(path.join(hubDir, 'config.json'), JSON.stringify({ v: 1, host: '127.0.0.1', port }), 'utf8');
  const installation = {
    v: 1, installation_id: 'install-combined-test', instance_id: 'instance-combined-test',
    active_version: 'test', app_root: appRoot, runtime_root: runtimeRoot,
    hub_owner_kind: 'COMPANION_OWNED', protocol_version: 1, state_schema: 1,
    component_versions: { core: 'test' }, profiles: ['test'],
  };
  fs.writeFileSync(locatorPath, `${JSON.stringify(installation, null, 2)}\n`, 'utf8');
  const configPath = path.join(configDir, 'receiver-config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    v: 2, mode: 'daily', enabled: true, thread_id: '01a99999-9999-4999-8999-999999999999',
    installation_id: installation.installation_id, instance_id: installation.instance_id,
    binding_epoch: 'epoch-combined', runtime_dir: configDir, locator_path: locatorPath,
    owner_opt_in: true,
  }), 'utf8');
  writeMembershipAtomic(runtimeRoot, {
    v: 1, installation_id: installation.installation_id, instance_id: installation.instance_id,
    target: 'codex:01a99999-9999-4999-8999-999999999999', platform: 'codex',
    binding_epoch: 'epoch-combined', config_path: configPath, receiver_kind: 'daily',
    desired_state: 'ENABLED', enabled: true, owner_opt_in: true, start_at_logon: false,
    owner_opt_in_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    registration_nonce: 'combined-test-nonce',
  });
  const child = spawn(process.execPath, [companionEntry, '--installation', installationRoot, '--worker-entry', fakeWorker, '--poll-ms', '250'], {
    cwd: rootDir,
    env: {
      ...process.env, LAB_BRIDGE_INSTALLATION_ROOT: installationRoot,
      FAKE_WORKER_OUT: fakeOut, FAKE_WORKER_STATUS: fakeStatus,
      FAKE_WORKER_INSTALLATION_ID: installation.installation_id, FAKE_WORKER_INSTANCE_ID: installation.instance_id,
      FAKE_WORKER_THREAD_ID: '01a99999-9999-4999-8999-999999999999', FAKE_WORKER_BINDING_EPOCH: 'epoch-combined',
      FAKE_WORKER_CREATED_AT: new Date().toISOString(), FAKE_WORKER_EXE: process.execPath,
      FAKE_WORKER_ENTRY: fakeWorker,
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  try {
    try {
      await waitFor(() => fs.existsSync(fakeOut));
    } catch (error) {
      throw new Error(`${error.message}; exit=${child.exitCode}; stderr=${stderr}; stdout=${stdout}`);
    }
    const worker = JSON.parse(fs.readFileSync(fakeOut, 'utf8'));
    assert.equal(Number.isInteger(worker.pid), true);
    assert.equal(worker.thread, null);
    try {
      await waitFor(() => stdout.includes('"event":"companion/status"'));
    } catch (error) {
      throw new Error(`${error.message}; exit=${child.exitCode}; stderr=${stderr}; stdout=${stdout}`);
    }
    assert.match(stdout, /companion-hub\/status/);
    try {
      await waitFor(() => fs.existsSync(path.join(runtimeRoot, 'companion', 'targets')), { timeoutMs: 3_000 });
      await waitFor(() => fs.existsSync(path.join(runtimeRoot, 'companion', 'launch')), { timeoutMs: 3_000 });
      await waitFor(() => fs.existsSync(path.join(runtimeRoot, 'hub', 'server.json')), { timeoutMs: 8_000 });
    } catch (error) {
      throw new Error(`${error.message}; exit=${child.exitCode}; stderr=${stderr}; stdout=${stdout}`);
    }
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      if (child.exitCode !== null) { resolve(); return; }
      child.once('exit', resolve);
      setTimeout(resolve, 8_000).unref?.();
    });
    if (child.exitCode === null) {
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* best effort */ }
    }
    try {
      const serverFile = path.join(runtimeRoot, 'hub', 'server.json');
      if (fs.existsSync(serverFile)) {
        const server = JSON.parse(fs.readFileSync(serverFile, 'utf8'));
        if (Number.isInteger(server.pid)) execFileSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      }
    } catch { /* best effort */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
});