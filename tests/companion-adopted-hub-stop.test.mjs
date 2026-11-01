import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { installationPaths, writeInstallationAtomic } from '../src/installation.mjs';
import { DEFAULT_CONFIG, runtimePaths, writeJsonAtomic } from '../src/runtime.mjs';
import { readProcessIdentity } from '../src/process-identity.mjs';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const HUB_ENTRY = path.join(PROJECT_ROOT, 'hub', 'main.mjs');
const COMPANION_ENTRY = path.join(PROJECT_ROOT, 'companion', 'main.mjs');

function waitFor(predicate, { timeoutMs = 20_000, intervalMs = 50 } = {}) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    let timer = null;
    let timeout = null;
    let inFlight = false;
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      if (timer !== null) clearInterval(timer);
      if (timeout !== null) clearTimeout(timeout);
      if (error) reject(error); else resolve(value);
    };
    const tick = async () => {
      if (done || inFlight) return;
      if (Date.now() > deadline) { finish(new Error('waitFor timeout')); return; }
      inFlight = true;
      try {
        const value = await predicate();
        if (value) finish(null, value);
      } catch (error) {
        finish(error);
      } finally {
        inFlight = false;
        if (!done && Date.now() > deadline) finish(new Error('waitFor timeout'));
      }
    };
    timer = setInterval(() => { void tick(); }, intervalMs);
    timer.unref?.();
    timeout = setTimeout(() => finish(new Error('waitFor timeout')), timeoutMs);
    timeout.unref?.();
    void tick();
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

test('global STOP stops an adopted own Hub that was not crashed first', { timeout: 60_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-adopt-stop-'));
  const paths = installationPaths(root);
  fs.mkdirSync(path.join(paths.runtimeRoot, 'hub'), { recursive: true });
  const installation = writeInstallationAtomic({
    root,
    installation: {
      v: 1, installation_id: 'install-adopt-stop', instance_id: 'instance-adopt-stop',
      active_version: '0.1.0-test', app_root: path.join(root, 'app'), runtime_root: paths.runtimeRoot,
      hub_owner_kind: 'COMPANION_OWNED', protocol_version: 1, state_schema: 1,
    },
  });
  const runtime = runtimePaths(paths.runtimeRoot);
  writeJsonAtomic(runtime.configFile, { ...DEFAULT_CONFIG, host: '127.0.0.1', port: await freePort() });
  const hubChild = spawn(process.execPath, [HUB_ENTRY], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, LAB_BRIDGE_INSTALLATION_ROOT: root },
    stdio: 'ignore', windowsHide: true,
  });
  let mainChild = null;
  let hubStopped = false;
  try {
    const server = await waitFor(() => (fs.existsSync(runtime.serverInfoFile) ? JSON.parse(fs.readFileSync(runtime.serverInfoFile, 'utf8')) : null), { timeoutMs: 20_000 });
    const identity = await waitFor(async () => {
      const value = await readProcessIdentity(server.pid);
      return value.alive === true && value.available === true &&
        typeof value.created_at === 'string' && typeof value.exe_path === 'string' && typeof value.entry_path === 'string'
        ? value : null;
    }, { timeoutMs: 45_000 }).catch((error) => {
      throw new Error(`${error.message}; identity_proof_unavailable pid=${server.pid} hubExit=${hubChild.exitCode}`);
    });
    assert.equal(identity.alive, true);
    fs.mkdirSync(path.join(runtime.runtimeRoot ?? installation.runtime_root, 'companion'), { recursive: true });
    fs.writeFileSync(path.join(installation.runtime_root, 'companion', 'hub-generation.json'), JSON.stringify({
      v: 1, installation_id: installation.installation_id, instance_id: installation.instance_id,
      owner_mode: 'COMPANION_OWNED', owner_epoch: 1, owner_nonce: 'pre-recovery-owner', generation: 1,
      child: { pid: server.pid, created_at: identity.created_at, exe_path: identity.exe_path, entry_path: identity.entry_path },
      server_pid: server.pid, started_at: new Date().toISOString(), last_exit: null,
    }));
    const lines = [];
    mainChild = spawn(process.execPath, [COMPANION_ENTRY, '--installation', root, '--reason', 'MANUAL_START', '--poll-ms', '250'], {
      cwd: PROJECT_ROOT,
      env: (() => { const env = { ...process.env }; delete env.CODEX_THREAD_ID; return env; })(),
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    const onData = (chunk) => { for (const line of String(chunk).split(/\r?\n/)) if (line.length > 0) lines.push(line); };
    mainChild.stdout.on('data', onData);
    mainChild.stderr.on('data', onData);
    await waitFor(() => lines.some((line) => line.includes('companion/status')), { timeoutMs: 20_000 });
    await waitFor(() => lines.some((line) => line.includes('adopted_own_hub":true')), { timeoutMs: 20_000 }).catch((error) => {
      throw new Error(`${error.message}; adopted_status_missing mainExit=${mainChild.exitCode}`);
    });
    assert.equal((await readProcessIdentity(server.pid)).alive, true);
    fs.writeFileSync(path.join(installation.runtime_root, 'desired-state.json'), JSON.stringify({ desired_state: 'STOPPED' }));
    await waitFor(() => mainChild.exitCode !== null, { timeoutMs: 20_000 });
    assert.equal(mainChild.exitCode, 0);
    assert.equal((await readProcessIdentity(server.pid)).alive, false, 'global STOP must stop the adopted own Hub');
    hubStopped = true;
  } finally {
    if (mainChild !== null && mainChild.exitCode === null) { try { mainChild.kill('SIGTERM'); } catch { /* gone */ } }
    if (!hubStopped) { try { hubChild.kill('SIGTERM'); } catch { /* gone */ } }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
