import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectServiceStatus } from '../src/service-status.mjs';
import { computeCodeIdentity, writeComponentIdentity } from '../src/code-identity.mjs';
import { installationPaths, writeInstallationAtomic } from '../src/installation.mjs';

test('collectServiceStatus reads Hub health and receiver state without mutating anything', () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-service-status-'));
  const hubDir = path.join(runtime, 'hub');
  const receiverDir = path.join(runtime, 'codex', 'thread-a');
  fs.mkdirSync(hubDir, { recursive: true });
  fs.mkdirSync(receiverDir, { recursive: true });
  fs.writeFileSync(path.join(hubDir, 'server.json'), JSON.stringify({
    pid: process.pid,
    host: '127.0.0.1',
    port: 47831,
    server_id: 'server-test',
  }), 'utf8');
  fs.writeFileSync(path.join(receiverDir, 'status.json'), JSON.stringify({
    mode: 'daily',
    enabled: true,
    expires_at: null,
    status: 'ONLINE_IDLE',
    thread_id: 'thread-a',
  }), 'utf8');

  const status = collectServiceStatus({ runtimeDir: runtime, now: Date.parse('2026-10-21T12:00:00Z') });
  assert.equal(status.hub.present, true);
  assert.equal(status.hub.pidAlive, true);
  assert.equal(status.hub.pid, process.pid);
  assert.equal(status.receivers.length, 1);
  assert.equal(status.receivers[0].mode, 'daily');
  assert.equal(status.receivers[0].active, false);
  assert.equal(status.receivers[0].reportedActive, true);
  assert.equal(fs.existsSync(path.join(receiverDir, 'status.json')), true);
});
test('doctor separates declared/installed/running identity, marks old fields UNVERIFIED and is read-only', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-service-identity-'));
  try {
    const paths = installationPaths(root);
    const app = path.join(root, 'app');
    fs.mkdirSync(path.join(app, 'src'), { recursive: true });
    fs.mkdirSync(path.join(app, 'hub'), { recursive: true });
    fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'dsh-local-bridge', version: '0.1.0-alpha.6' }));
    fs.writeFileSync(path.join(app, 'src', 'core.mjs'), 'export const value = 1;\n');
    fs.writeFileSync(path.join(app, 'hub', 'main.mjs'), 'export const hub = true;\n');
    const installed = computeCodeIdentity({ rootDir: app, component: 'hub', entry: path.join(app, 'hub', 'main.mjs'), now: 1_000 });
    const locator = {
      v: 1, installation_id: 'install-id', instance_id: 'instance-id', active_version: '0.1.0-alpha.6',
      app_root: app, runtime_root: paths.runtimeRoot, hub_owner_kind: 'MANUAL', protocol_version: 1, state_schema: 1,
      code_identity: installed,
    };
    writeInstallationAtomic({ root, installation: locator });
    const runtime = paths.runtimeRoot;
    fs.mkdirSync(path.join(runtime, 'hub'), { recursive: true });
    const serverFile = path.join(runtime, 'hub', 'server.json');
    writeServer(serverFile, installed);
    const pluginIdentity = computeCodeIdentity({ rootDir: app, component: 'dsh-plugin', entry: path.join(app, 'src', 'core.mjs'), now: 2_000 });
    writeComponentIdentity({ runtimeDir: runtime, component: 'dsh-plugin', identity: pluginIdentity });
    const before = fs.readFileSync(serverFile);
    const status = collectServiceStatus({ runtimeDir: runtime, installationRoot: root, now: 3_000 });
    assert.equal(status.hub.package_version, '0.1.0-alpha.6');
    assert.equal(status.identity.hub.installed_program.source_sha256, installed.source_sha256);
    assert.equal(status.identity.hub.running_identity.source_sha256, installed.source_sha256);
    assert.equal(status.identity.hub.verdict, 'MATCH');
    assert.equal(status.identity.dsh_plugin.status, 'OBSERVED');
    assert.equal(fs.readFileSync(serverFile).equals(before), true);
    assert.equal(fs.existsSync(path.join(runtime, 'hub', 'hub-identity.json')), false);

    // Old server record without identity cannot be matched against the locator.
    fs.writeFileSync(serverFile, JSON.stringify({ pid: process.pid, port: 47831, package_version: '0.1.0-alpha.6' }));
    const old = collectServiceStatus({ runtimeDir: runtime, installationRoot: root, now: 4_000 });
    assert.equal(old.identity.hub.running_identity.status, 'UNVERIFIED');
    assert.equal(old.identity.hub.verdict, 'UNVERIFIED');

    // Same version string but different running source hash is a reload, not a match.
    const changed = { ...installed, source_sha256: '0'.repeat(64) };
    writeServer(serverFile, changed);
    const pending = collectServiceStatus({ runtimeDir: runtime, installationRoot: root, now: 5_000 });
    assert.equal(pending.identity.hub.verdict, 'PENDING_RELOAD');
    assert.equal(pending.identity.hub.requires_reload, true);
    assert.ok(pending.identity.hub.mismatches.includes('INSTALLED_VS_RUNNING_SOURCE_HASH'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function writeServer(file, identity) {
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, host: '127.0.0.1', port: 47831, package_version: identity.package_version, code_identity: identity }));
}