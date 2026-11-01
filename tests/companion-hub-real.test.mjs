import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createCompanionHub } from '../src/companion-hub.mjs';
import { writeInstallationAtomic, installationPaths } from '../src/installation.mjs';
import { DEFAULT_CONFIG, runtimePaths, writeJsonAtomic } from '../src/runtime.mjs';
import { hubOwnerLockFile } from '../src/hub-owner.mjs';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');

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

test('COMPANION_OWNED actually starts a real isolated Hub, records service state and stops it', { timeout: 30_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-companion-real-hub-'));
  try {
    const paths = installationPaths(root);
    const installation = writeInstallationAtomic({
      root,
      installation: {
        v: 1,
        installation_id: 'install-real-hub',
        instance_id: 'instance-real-hub',
        active_version: '0.1.0-test',
        app_root: path.join(root, 'app'),
        runtime_root: paths.runtimeRoot,
        hub_owner_kind: 'COMPANION_OWNED',
        protocol_version: 1,
        state_schema: 1,
      },
    });
    const runtime = runtimePaths(paths.runtimeRoot);
    fs.mkdirSync(runtime.hubDir, { recursive: true });
    writeJsonAtomic(runtime.configFile, { ...DEFAULT_CONFIG, port: await freePort() });
    const manager = createCompanionHub({
      installation,
      runtimeRoot: installation.runtime_root,
      locatorPath: paths.locator,
      hubEntry: path.join(PROJECT_ROOT, 'hub', 'main.mjs'),
      processProvider: (pid) => Promise.resolve({
        pid,
        alive: true,
        available: true,
        source: 'injected',
        created_at: '2026-10-23T12:00:00.000Z',
        exe_path: path.join('C:', 'Program Files', 'nodejs', 'node.exe'),
        entry_path: path.join(PROJECT_ROOT, 'companion', 'main.mjs'),
      }),
      startTimeoutMs: 15_000,
    });
    const started = await manager.start();
    assert.equal(started.lifecycle, 'READY');
    assert.equal(Number.isInteger(started.child_pid), true);
    assert.equal(fs.existsSync(hubOwnerLockFile(paths.runtimeRoot)), true);
    const serviceFile = path.join(paths.runtimeRoot, 'companion', 'hub-service-state.json');
    const service = JSON.parse(fs.readFileSync(serviceFile, 'utf8'));
    assert.equal(service.component, 'hub');
    assert.equal(service.state, 'READY');
    assert.equal(service.pid, started.child_pid);
    await manager.stop();
    assert.equal(fs.existsSync(hubOwnerLockFile(paths.runtimeRoot)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
