import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { BridgeHub } from '../src/hub.mjs';
import { HubStore } from '../src/store.mjs';
import { installationPaths, writeInstallationAtomic } from '../src/installation.mjs';
import { DEFAULT_CONFIG, runtimePaths, writeJsonAtomic } from '../src/runtime.mjs';
import { createTargetBindingStamper } from '../src/target-binding.mjs';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const COMPANION_ENTRY = path.join(PROJECT_ROOT, 'companion', 'main.mjs');

function waitFor(predicate, { timeoutMs = 20_000, intervalMs = 50 } = {}) {
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

test('companion/main with no targets and a warm Hub stays alive under RUNNING and exits cleanly on STOP', { timeout: 40_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-main-lifetime-'));
  const paths = installationPaths(root);
  fs.mkdirSync(path.join(paths.runtimeRoot, 'hub'), { recursive: true });
  const installation = writeInstallationAtomic({
    root,
    installation: {
      v: 1, installation_id: 'install-main-lifetime', instance_id: 'instance-main-lifetime',
      active_version: '0.1.0-test', app_root: path.join(root, 'app'), runtime_root: paths.runtimeRoot,
      hub_owner_kind: 'COMPANION_OWNED', protocol_version: 1, state_schema: 1,
    },
  });
  const runtime = runtimePaths(paths.runtimeRoot);
  const store = new HubStore({ stateFile: path.join(runtime.hubDir, 'state.json'), eventsFile: path.join(runtime.hubDir, 'events.jsonl') }).load();
  const token = crypto.randomBytes(32).toString('hex');
  const targetBinding = createTargetBindingStamper({
    installation, runtimeRoot: installation.runtime_root, locatorPath: paths.locator,
  });
  const hub = new BridgeHub({ store, token, host: '127.0.0.1', port: 0, installation, targetBinding });
  const address = await hub.start();
  writeJsonAtomic(runtime.configFile, { ...DEFAULT_CONFIG, host: '127.0.0.1', port: address.port });
  fs.writeFileSync(runtime.tokenFile, `${token}\n`, 'utf8');
  const lines = [];
  const child = spawn(process.execPath, [COMPANION_ENTRY, '--installation', root, '--reason', 'MANUAL_START', '--poll-ms', '250'], {
    cwd: PROJECT_ROOT,
    env: (() => { const env = { ...process.env }; delete env.CODEX_THREAD_ID; return env; })(),
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  const onData = (chunk) => { for (const line of String(chunk).split(/\r?\n/)) if (line.length > 0) lines.push(line); };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  try {
    await waitFor(() => lines.some((line) => line.includes('companion/status')), { timeoutMs: 20_000 });
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    assert.equal(child.exitCode, null, 'main must remain alive with no targets while desired RUNNING');
    const status = JSON.parse(lines.find((line) => line.includes('companion/status')));
    assert.deepEqual(status.targets, {});
    assert.equal(status.hub.lifecycle, 'READY');

    fs.writeFileSync(path.join(installation.runtime_root, 'desired-state.json'), JSON.stringify({ desired_state: 'STOPPED' }));
    await waitFor(() => child.exitCode !== null, { timeoutMs: 15_000 });
    assert.equal(child.exitCode, 0);
    assert.ok(lines.some((line) => line.includes('companion/stopped')));
    assert.equal(hub.connections >= 0, true);
  } finally {
    if (child.exitCode === null) { try { child.kill('SIGTERM'); } catch { /* gone */ } }
    await hub.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
