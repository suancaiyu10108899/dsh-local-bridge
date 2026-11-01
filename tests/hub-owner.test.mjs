import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HUB_OWNER_LEASE_MS,
  acquireHubOwner,
  createHubOwnerRecord,
  hubOwnerLockFile,
  inspectHubOwner,
  releaseHubOwner,
} from '../src/hub-owner.mjs';

const installation = {
  installation_id: 'install-owner',
  instance_id: 'instance-owner',
  protocol_version: 1,
  hub_owner_kind: 'COMPANION_OWNED',
};

const ownerProcess = {
  pid: 4321,
  created_at: '2026-10-23T12:00:00.000Z',
  exe_realpath: path.join('C:', 'Program Files', 'nodejs', 'node.exe'),
  entry_realpath: path.join('C:', 'Dev', 'bridge', 'companion', 'main.mjs'),
  config_path: path.join('C:', 'Dev', 'bridge', 'installation.json'),
};

const provider = (pid) => Promise.resolve({
  pid,
  alive: true,
  available: true,
  source: 'injected',
  created_at: ownerProcess.created_at,
  exe_path: ownerProcess.exe_realpath,
  entry_path: ownerProcess.entry_realpath,
});

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-owner-'));
}

test('owner lease acquires atomically, rejects a second owner, and never TTL-takes-over', async () => {
  const root = tempRoot();
  try {
    const runtimeDir = path.join(root, 'runtime');
    const first = await acquireHubOwner({
      runtimeDir,
      installation,
      mode: 'COMPANION_OWNED',
      owner_component: 'companion',
      owner_process: ownerProcess,
      owner_epoch: 1,
      nonce: 'owner-nonce-1',
      now: 1_000,
    });
    assert.equal(first.ok, true);
    assert.equal(fs.existsSync(hubOwnerLockFile(runtimeDir)), true);
    const second = await acquireHubOwner({
      runtimeDir,
      installation,
      mode: 'COMPANION_OWNED',
      owner_component: 'other',
      owner_process: ownerProcess,
      owner_epoch: 2,
      nonce: 'owner-nonce-2',
      now: 2_000,
    });
    assert.equal(second.ok, false);
    assert.equal(second.code, 'LOCK_HELD');

    const alive = await inspectHubOwner({ runtimeDir, provider, now: 2_000 });
    assert.equal(alive.ok, true);
    assert.equal(alive.state, 'ALIVE');

    const expired = await inspectHubOwner({ runtimeDir, provider, now: 1_000 + HUB_OWNER_LEASE_MS + 60_000 });
    assert.equal(expired.ok, true);
    assert.notEqual(expired.state, 'ALIVE');
    assert.equal(fs.existsSync(hubOwnerLockFile(runtimeDir)), true, 'not reclaimed by TTL');

    assert.equal(releaseHubOwner({ runtimeDir, nonce: 'wrong' }).ok, false);
    assert.equal(releaseHubOwner({ runtimeDir, nonce: 'owner-nonce-1' }).ok, true);
    assert.equal(fs.existsSync(hubOwnerLockFile(runtimeDir)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('owner record rejects mismatched mode and relative process paths', () => {
  assert.throws(() => createHubOwnerRecord({
    installation,
    mode: 'MANUAL',
    owner_component: 'companion',
    owner_process: ownerProcess,
    owner_epoch: 1,
    nonce: 'n',
  }), (error) => error.code === 'HUB_OWNER_MODE_MISMATCH');
  assert.throws(() => createHubOwnerRecord({
    installation,
    mode: 'COMPANION_OWNED',
    owner_component: 'companion',
    owner_process: { ...ownerProcess, entry_realpath: 'relative/companion.mjs' },
    owner_epoch: 1,
    nonce: 'n',
  }), (error) => error.code === 'HUB_OWNER_INVALID' && error.details?.field === 'owner_process.entry_realpath');
});