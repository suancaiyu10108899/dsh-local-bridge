import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acquireOwnerLock,
  heartbeatOwnerLock,
  isOwnerAlive,
  readOwnerLock,
  readProcessIdentity,
  releaseOwnerLock,
  sameProcess,
} from '../src/process-identity.mjs';

function tempFile() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-owner-lock-'));
  return { root, file: path.join(root, 'owner.lock') };
}

const provider = (pid) => () => Promise.resolve({
  pid,
  alive: true,
  available: true,
  source: 'injected',
  created_at: '2026-10-23T12:00:00.000Z',
  exe_path: 'C:\\Program Files\\nodejs\\node.exe',
  entry_path: 'C:\\Dev\\bridge\\companion.mjs',
});

const lock = (overrides = {}) => ({
  v: 1,
  installation_id: 'install-1',
  instance_id: 'instance-1',
  owner_epoch: 1,
  mode: 'COMPANION_OWNED',
  owner_component: 'companion',
  owner_process: {
    pid: 1234,
    created_at: '2026-10-23T12:00:00.000Z',
    exe_realpath: 'C:\\Program Files\\nodejs\\node.exe',
    entry_realpath: 'C:\\Dev\\bridge\\companion.mjs',
  },
  nonce: 'nonce-1',
  heartbeat_at: new Date().toISOString(),
  lease_expires_at: new Date(Date.now() + 30_000).toISOString(),
  ...overrides,
});

test('readProcessIdentity normalizes an injected provider and never defaults to SAME', async () => {
  const identity = await readProcessIdentity(1234, { provider: provider(1234) });
  assert.equal(identity.available, true);
  assert.equal(identity.pid, 1234);
  assert.equal(identity.alive, true);
  const expected = {
    ...lock().owner_process,
    exe_path: lock().owner_process.exe_realpath,
    entry_path: lock().owner_process.entry_realpath,
  };
  const comparison = sameProcess(identity, expected);
  assert.equal(comparison.verdict, 'SAME');
  assert.equal(comparison.checks.created_at, 'SAME');
  assert.equal(comparison.checks.pid, 'SAME');
});

test('sameProcess requires every identity field; pid+creation alone is UNKNOWN', () => {
  const complete = {
    pid: 1234,
    available: true,
    created_at: '2026-10-23T12:00:00.000Z',
    exe_path: 'C:\\Program Files\\nodejs\\node.exe',
    entry_path: 'C:\\Dev\\bridge\\companion.mjs',
  };
  const withoutEntry = { ...complete, entry_path: null };
  assert.equal(sameProcess(complete, withoutEntry).verdict, 'UNKNOWN');
  const withoutExe = { ...complete, exe_path: null };
  assert.equal(sameProcess(complete, withoutExe).verdict, 'UNKNOWN');
  assert.equal(sameProcess(complete, complete).verdict, 'SAME');
});

test('Windows default provider can identify its own test child and not claim unknown identity', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows-only provider');
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [path.resolve(import.meta.dirname, 'fixtures', 'fake-worker.mjs')], {
    env: { ...process.env, FAKE_WORKER_EXIT_MS: '10000' },
    stdio: 'ignore',
    windowsHide: true,
  });
  try {
    const identity = await readProcessIdentity(child.pid);
    assert.equal(identity.pid, child.pid);
    assert.equal(identity.alive, true);
    assert.equal(identity.available, true);
    assert.equal(identity.source, 'windows-cim');
    assert.equal(typeof identity.created_at, 'string');
    assert.equal(typeof identity.exe_path, 'string');
    assert.equal(typeof identity.entry_path, 'string');
    assert.equal(sameProcess(identity, identity).verdict, 'SAME');
  } finally {
    try { child.kill('SIGTERM'); } catch { /* already exited */ }
  }
});

test('sameProcess detects different identity and unknown incomplete identity', () => {
  const a = { pid: 1, available: true, created_at: '2026-10-23T12:00:00.000Z', exe_path: 'C:\\a\\node.exe', entry_path: 'C:\\a\\x.mjs' };
  assert.equal(sameProcess(a, { ...a, pid: 2 }).verdict, 'DIFFERENT');
  assert.equal(sameProcess(a, { ...a, created_at: '2026-10-23T12:00:01.000Z' }).verdict, 'DIFFERENT');
  assert.equal(sameProcess(a, { ...a, exe_path: 'C:\\b\\node.exe' }).verdict, 'DIFFERENT');
  assert.equal(sameProcess({ pid: 1, created_at: null }, { pid: 1, created_at: null }).verdict, 'UNKNOWN');
});

test('owner lock acquire/heartbeat/release is nonce and atomic', async () => {
  const { root, file } = tempFile();
  try {
    const first = await acquireOwnerLock({ file, lock: lock() });
    assert.equal(first.ok, true);
    const second = await acquireOwnerLock({ file, lock: lock({ nonce: 'nonce-2' }) });
    assert.equal(second.ok, false);
    assert.equal(second.code, 'LOCK_HELD');
    assert.equal(readOwnerLock(file).lock.nonce, 'nonce-1');
    const badHeartbeat = heartbeatOwnerLock({ file, nonce: 'nonce-2' });
    assert.equal(badHeartbeat.code, 'LOCK_NONCE_MISMATCH');
    const badRelease = releaseOwnerLock({ file, nonce: 'nonce-2' });
    assert.equal(badRelease.released, false);
    assert.equal(fs.existsSync(file), true);
    const goodHeartbeat = heartbeatOwnerLock({ file, nonce: 'nonce-1' });
    assert.equal(goodHeartbeat.ok, true);
    assert.equal(releaseOwnerLock({ file, nonce: 'nonce-1' }).released, true);
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('isOwnerAlive distinguishes healthy, stale, dead and unknown identity without TTL takeover', async () => {
  const matching = provider(1234);
  const fresh = await isOwnerAlive({ lock: lock(), provider: matching, now: Date.now() });
  assert.equal(fresh.status, 'ALIVE');
  assert.equal(fresh.same_process, 'SAME');
  assert.equal(fresh.heartbeat, 'FRESH');

  const staleLock = lock({ heartbeat_at: '2026-10-23T12:00:00.000Z', lease_expires_at: '2026-10-23T12:00:30.000Z' });
  const stale = await isOwnerAlive({ lock: staleLock, provider: matching, now: Date.parse('2026-10-23T12:01:00.000Z') });
  assert.equal(stale.status, 'UNRESPONSIVE');
  assert.equal(stale.same_process, 'SAME');

  const dead = await isOwnerAlive({ lock: lock(), provider: () => Promise.resolve({ pid: 1234, alive: false, available: false }), now: Date.now() });
  assert.equal(dead.status, 'DEAD');

  const unknown = await isOwnerAlive({ lock: lock(), provider: () => Promise.resolve({ pid: 1234 }), now: Date.now() });
  assert.equal(unknown.status, 'UNKNOWN');
  assert.equal(unknown.same_process, 'UNKNOWN');
});

test('missing/invalid lock is explicit UNKNOWN and does not delete a lock', async () => {
  const { root, file } = tempFile();
  try {
    assert.deepEqual(readOwnerLock(file), { ok: false, code: 'LOCK_MISSING' });
    fs.writeFileSync(file, '{bad json');
    assert.equal(readOwnerLock(file).code, 'LOCK_INVALID');
    const result = await isOwnerAlive({ lock: { owner_process: { pid: 1234 } } });
    assert.equal(result.status, 'UNKNOWN');
    assert.equal(fs.existsSync(file), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('relative command-line entry is unresolved, never resolved against observer cwd', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows CIM provider');
  const { spawn } = await import('node:child_process');
  const relativeEntry = path.join('tests', 'fixtures', 'relative-entry-child.mjs');
  const child = spawn(process.execPath, [relativeEntry], {
    cwd: path.resolve(import.meta.dirname, '..'),
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true,
  });
  try {
    // The child waits on stdin; this is a controlled process, not a business Hub.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const identity = await readProcessIdentity(child.pid);
    assert.equal(identity.alive, true);
    assert.equal(identity.available, false);
    assert.equal(identity.entry_path, null);
    assert.equal(identity.entry_unresolved, true);
    assert.equal(identity.unavailable_reason, 'ENTRY_PATH_UNRESOLVED');
    const guessed = { ...identity, entry_path: path.resolve(process.cwd(), relativeEntry) };
    const comparison = sameProcess(identity, guessed);
    assert.equal(comparison.verdict, 'UNKNOWN');
    assert.ok(comparison.reasons.includes('ENTRY_PATH_UNRESOLVED'));
    assert.notEqual(comparison.verdict, 'SAME');
  } finally {
    try { child.stdin.end(); } catch { /* already closed */ }
    await new Promise((resolve) => {
      if (child.exitCode !== null) { resolve(); return; }
      child.once('exit', resolve);
      setTimeout(resolve, 3_000);
    });
  }
});

test('injected relative entry is fail-closed as ENTRY_PATH_UNRESOLVED', async () => {
  const identity = await readProcessIdentity(7777, {
    provider: () => ({
      pid: 7777,
      alive: true,
      available: true,
      created_at: '2026-10-23T12:00:00.000Z',
      exe_path: 'C:\\Program Files\\nodejs\\node.exe',
      entry_path: 'hub/main.mjs',
    }),
  });
  assert.equal(identity.entry_path, null);
  assert.equal(identity.entry_unresolved, true);
  assert.equal(identity.available, false);
  assert.equal(identity.unavailable_reason, 'ENTRY_PATH_UNRESOLVED');
  const comparison = sameProcess(identity, {
    pid: 7777,
    created_at: '2026-10-23T12:00:00.000Z',
    exe_path: 'C:\\Program Files\\nodejs\\node.exe',
    entry_path: 'C:\\Dev\\private\\hub\\main.mjs',
  });
  assert.equal(comparison.verdict, 'UNKNOWN');
  assert.ok(comparison.reasons.includes('ENTRY_PATH_UNRESOLVED'));
});
test('unsupported identity provider does not promote a live PID to DEAD', async () => {
  const lock = {
    installation_id: 'install', instance_id: 'instance', mode: 'COMPANION_OWNED', owner_component: 'companion',
    owner_epoch: 1, nonce: 'nonce',
    owner_process: {
      pid: 4321,
      created_at: '2026-10-23T12:00:00.000Z',
      exe_realpath: 'C:\\Program Files\\nodejs\\node.exe',
      entry_realpath: 'C:\\Dev\\bridge\\companion\\main.mjs',
    },
    heartbeat_at: new Date().toISOString(),
    lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const health = await isOwnerAlive({
    lock,
    provider: () => Promise.resolve({ pid: 4321, alive: true, available: false, source: 'unavailable', unavailable_reason: 'PROCESS_IDENTITY_PROVIDER_UNAVAILABLE' }),
  });
  assert.equal(health.status, 'UNKNOWN');
  assert.notEqual(health.status, 'DEAD');
});
test('creation timestamp invalid/over-precision is UNKNOWN and equivalent formats are SAME', () => {
  const base = {
    pid: 1234,
    available: true,
    created_at: '2026-10-23T12:00:00.000Z',
    exe_path: 'C:\\Program Files\\nodejs\\node.exe',
    entry_path: 'C:\\Dev\\bridge\\companion.mjs',
  };
  const invalid = sameProcess(base, { ...base, created_at: 'not-a-date' });
  assert.equal(invalid.verdict, 'UNKNOWN');
  assert.equal(invalid.checks.created_at, 'UNKNOWN');
  assert.ok(invalid.reasons.includes('CREATED_AT_INVALID'));
  const overPrecise = sameProcess(base, { ...base, created_at: '2026-10-23T12:00:00.0000000001Z' });
  assert.equal(overPrecise.verdict, 'UNKNOWN');
  const equivalent = sameProcess(base, { ...base, created_at: '2026-10-23T12:00:00.0000000+00:00' });
  assert.equal(equivalent.verdict, 'SAME');
  assert.equal(equivalent.checks.created_at, 'SAME');
  const differentValid = sameProcess(base, { ...base, created_at: '2026-10-23T12:00:01.000Z' });
  assert.equal(differentValid.verdict, 'DIFFERENT');
});

test('invalid lock creation is UNKNOWN not DEAD and the lock file is retained', async () => {
  const { root, file } = tempFile();
  try {
    const invalidLock = lock({
      owner_process: {
        pid: 1234,
        created_at: 'not-a-date',
        exe_realpath: 'C:\\Program Files\\nodejs\\node.exe',
        entry_realpath: 'C:\\Dev\\bridge\\companion.mjs',
      },
    });
    fs.writeFileSync(file, JSON.stringify(invalidLock));
    const health = await isOwnerAlive({ lock: invalidLock, provider: provider(1234) });
    assert.equal(health.status, 'UNKNOWN');
    assert.notEqual(health.status, 'DEAD');
    assert.ok(health.reason_codes.includes('LOCK_CREATION_INVALID'));
    assert.equal(fs.existsSync(file), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});