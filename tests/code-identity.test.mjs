import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  compareCodeIdentities,
  computeCodeIdentity,
  readComponentIdentity,
  writeComponentIdentity,
} from '../src/code-identity.mjs';

function tempProgram() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-code-identity-'));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'hub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'dsh-local-bridge', version: '0.1.0-alpha.6' }));
  fs.writeFileSync(path.join(root, 'src', 'core.mjs'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(root, 'hub', 'main.mjs'), 'export const hub = true;\n');
  return root;
}

test('actual source identity hashes only program files and marks checkout DEV_UNRELEASED', () => {
  const root = tempProgram();
  try {
    const entry = path.join(root, 'hub', 'main.mjs');
    const first = computeCodeIdentity({ rootDir: root, component: 'hub', entry, now: 1_000 });
    assert.equal(first.status, 'OBSERVED');
    assert.equal(first.package_version, '0.1.0-alpha.6');
    assert.equal(first.release_channel, 'DEV_UNRELEASED');
    assert.equal(first.released, false);
    assert.equal(typeof first.source_sha256, 'string');
    assert.equal(first.entry, entry);

    // Runtime data/tokens/queues are not program inputs.
    fs.writeFileSync(path.join(root, 'token'), 'secret-token');
    fs.writeFileSync(path.join(root, 'src', 'not-a-program.txt'), 'ignored');
    const afterData = computeCodeIdentity({ rootDir: root, component: 'hub', entry, now: 2_000 });
    assert.equal(afterData.source_sha256, first.source_sha256);

    // Same version string, different source hash.
    fs.writeFileSync(path.join(root, 'src', 'core.mjs'), 'export const value = 2;\n');
    const changed = computeCodeIdentity({ rootDir: root, component: 'hub', entry, now: 3_000 });
    assert.equal(changed.package_version, first.package_version);
    assert.notEqual(changed.source_sha256, first.source_sha256);

    const comparison = compareCodeIdentities({
      declared: { ...first, source_sha256: first.source_sha256 },
      installed: changed,
      running: first,
    });
    assert.equal(comparison.verdict, 'PENDING_RELOAD');
    assert.equal(comparison.requires_reload, true);
    assert.ok(comparison.mismatches.includes('INSTALLED_VS_RUNNING_SOURCE_HASH'));

    const missingRunning = compareCodeIdentities({ declared: first, installed: changed, running: null });
    assert.equal(missingRunning.verdict, 'UNVERIFIED');
    const oldFields = compareCodeIdentities({ declared: null, installed: changed, running: { package_version: '0.1.0-alpha.6' } });
    assert.equal(oldFields.verdict, 'UNVERIFIED');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('component identity file is metadata only and can be read back', () => {
  const root = tempProgram();
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-code-runtime-'));
  try {
    const identity = computeCodeIdentity({ rootDir: root, component: 'dsh-plugin', entry: path.join(root, 'src', 'core.mjs') });
    assert.equal(identity.status, 'OBSERVED');
    const written = writeComponentIdentity({ runtimeDir: runtime, component: 'dsh-plugin', identity });
    assert.equal(written.written, true);
    const read = readComponentIdentity({ runtimeDir: runtime, component: 'dsh-plugin' });
    assert.equal(read.source_sha256, identity.source_sha256);
    assert.equal(fs.existsSync(path.join(runtime, 'dsh-plugin', 'dsh-plugin-identity.json')), true);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(runtime, 'dsh-plugin', 'dsh-plugin-identity.json'))).digest('hex').length, 64);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(runtime, { recursive: true, force: true });
  }
});
test('actual checkout Hub and DSH plugin identities are observable and the declared version is explicitly DEV_UNRELEASED', () => {
  const projectRoot = path.resolve(import.meta.dirname, '..');
  const declaredVersion = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version;
  const hub = computeCodeIdentity({ rootDir: projectRoot, component: 'hub', entry: path.join(projectRoot, 'hub', 'main.mjs') });
  const plugin = computeCodeIdentity({ rootDir: projectRoot, component: 'dsh-plugin', entry: path.join(projectRoot, 'adapters', 'dsh', 'plugin.mjs') });
  assert.equal(hub.status, 'OBSERVED');
  assert.equal(plugin.status, 'OBSERVED');
  assert.equal(hub.package_version, declaredVersion);
  assert.equal(plugin.package_version, declaredVersion);
  assert.equal(hub.release_channel, 'DEV_UNRELEASED');
  assert.equal(plugin.release_channel, 'DEV_UNRELEASED');
  assert.equal(hub.released, false);
  assert.equal(plugin.released, false);
  assert.notEqual(hub.source_sha256, plugin.source_sha256);
});