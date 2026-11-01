import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { HubClient } from '../src/client.mjs';
import { DEFAULT_CONFIG, runtimePaths, writeJsonAtomic } from '../src/runtime.mjs';
import { installationPaths, writeInstallationAtomic } from '../src/installation.mjs';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');

function waitFor(predicate, { timeoutMs = 10_000, intervalMs = 50 } = {}) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      try {
        const value = predicate();
        if (value) {
          clearInterval(timer);
          resolve(value);
        } else if (Date.now() > deadline) {
          clearInterval(timer);
          reject(new Error('waitFor timeout'));
        }
      } catch (error) {
        clearInterval(timer);
        reject(error);
      }
    }, intervalMs);
    timer.unref?.();
  });
}

test('Hub main derives config/state/token/server-info from locator runtime_root and advertises binding capability', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-hub-main-'));
  const paths = installationPaths(root);
  const runtime = runtimePaths(paths.runtimeRoot);
  fs.mkdirSync(runtime.hubDir, { recursive: true });
  writeJsonAtomic(runtime.configFile, { ...DEFAULT_CONFIG, port: 0 });
  const installation = writeInstallationAtomic({
    root,
    installation: {
      v: 1,
      installation_id: 'install-main-test',
      instance_id: 'instance-main-test',
      active_version: '0.1.0-test',
      app_root: path.join(root, 'app'),
      runtime_root: paths.runtimeRoot,
      hub_owner_kind: 'COMPANION_OWNED',
      protocol_version: 1,
      state_schema: 1,
    },
  });
  const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'hub', 'main.mjs')], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, LAB_BRIDGE_INSTALLATION_ROOT: root, LAB_BRIDGE_RUNTIME_DIR: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
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

  const serverInfo = await waitFor(() => {
    if (fs.existsSync(runtime.serverInfoFile)) return JSON.parse(fs.readFileSync(runtime.serverInfoFile, 'utf8'));
    if (child.exitCode !== null) throw new Error(`hub main exited ${child.exitCode}: ${stderr}`);
    return null;
  });
  assert.equal(serverInfo.runtime_root, paths.runtimeRoot);
  assert.equal(serverInfo.installation_id, installation.installation_id);
  assert.equal(serverInfo.instance_id, installation.instance_id);
  assert.equal(serverInfo.package_version, '0.1.0-alpha.7');
  assert.equal(serverInfo.code_identity.release_channel, 'DEV_UNRELEASED');
  assert.equal(typeof serverInfo.code_identity.source_sha256, 'string');
  assert.equal(serverInfo.code_identity.entry, path.join(path.resolve(import.meta.dirname, '..'), 'hub', 'main.mjs'));
  assert.equal(fs.existsSync(runtime.stateFile), true);
  assert.equal(fs.existsSync(runtime.tokenFile), true);
  assert.equal(fs.existsSync(runtime.configFile), true);
  const token = fs.readFileSync(runtime.tokenFile, 'utf8').trim();
  const client = new HubClient({
    host: serverInfo.host,
    port: serverInfo.port,
    token,
    role: 'cli',
    identity: 'cli:operator',
  });
  try {
    await client.connect();
    assert.equal(client.welcomeInfo.installation_id, installation.installation_id);
    assert.equal(client.welcomeInfo.instance_id, installation.instance_id);
    assert.equal(client.welcomeInfo.protocol_version, 1);
    assert.equal(client.welcomeInfo.capabilities.target_binding_epoch, true);
    assert.equal(client.serverInfo, client.welcomeInfo);
    assert.deepEqual(Object.keys(client.welcomeInfo).sort(), ['capabilities', 'installation_id', 'instance_id', 'protocol_version']);
    assert.equal(client.welcome.server.code_identity.source_sha256, serverInfo.code_identity.source_sha256);
    assert.equal(client.welcomeInfo.code_identity, undefined);
  } finally {
    await client.close();
  }
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    if (child.exitCode !== null) { resolve(); return; }
    const timer = setTimeout(resolve, 3_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
});
