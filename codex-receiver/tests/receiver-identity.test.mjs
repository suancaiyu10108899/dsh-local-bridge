import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { claimReceiverProcess, inspectReceiverProcess, recoverReceiverLock } from '../adapters/codex/receiver-identity.mjs';
import { receiverStatus } from '../adapters/codex/receiver-control.mjs';

const entry = fileURLToPath(import.meta.url), created = '2026-01-01T00:00:00.000Z';
const provider = async (pid) => ({ pid, alive: true, available: true, source: 'injected-test', created_at: created, exe_path: process.execPath, entry_path: entry });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-receiver-id-'));
  t.after(() => {
    const absolute = path.resolve(dir);
    assert.ok(absolute.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(absolute).startsWith('lab-receiver-id-'));
    fs.rmSync(absolute, { recursive: true, force: true });
  });
  const c = { v: 2, mode: 'daily', enabled: true, thread_id: crypto.randomUUID(), window_id: crypto.randomUUID(),
    runtime_dir: dir, expires_at: null, rate_limit: { max_submissions: 6, window_ms: 3600000 } };
  const file = path.join(dir, 'receiver-config.json'); fs.writeFileSync(file, JSON.stringify(c));
  return { dir, c, file };
}
function publish(f, lease, at = Date.now()) {
  fs.writeFileSync(path.join(f.dir, 'status.json'), JSON.stringify({ ...lease.statusFields, thread_id: f.c.thread_id,
    status: 'ONLINE_IDLE', mode: 'daily', enabled: true, heartbeat_at: new Date(at).toISOString(), expires_at: null }));
}

test('v3 health requires matching process identity, nonce and fresh heartbeat', async (t) => {
  const f = fixture(t), lease = await claimReceiverProcess(f.c, f.file, 'worker', { provider }); publish(f, lease);
  const status = await receiverStatus(f.file, Date.now(), { identityProvider: provider });
  assert.equal(status.healthy, true); assert.equal(status.schema_version, 3); assert.equal(status.worker_nonce, lease.lock.nonce);
  assert.equal(status.instance_id, f.c.window_id); assert.notEqual(status.instance_id, status.worker_nonce);
  lease.release();
});

test('a reused PID is not healthy and only its exact dead lock is archived', async (t) => {
  const f = fixture(t), lease = await claimReceiverProcess(f.c, f.file, 'worker', { provider }); publish(f, lease);
  const reused = async (pid) => ({ ...await provider(pid), created_at: '2026-01-02T00:00:00.000Z' });
  const status = await receiverStatus(f.file, Date.now(), { identityProvider: reused });
  assert.equal(status.running, false); assert.equal(status.healthy, false); assert.equal(status.process_identity_status, 'DEAD');
  await recoverReceiverLock(f.c, f.file, 'worker', { provider: reused });
  assert.equal(fs.existsSync(lease.file), false); assert.equal(fs.readdirSync(f.dir).filter((name) => name.startsWith('receiver.lock.stale-')).length, 1);
});

test('incomplete identity is UNKNOWN and is never reclaimed from a live PID', async (t) => {
  const f = fixture(t), lease = await claimReceiverProcess(f.c, f.file, 'worker', { provider }); publish(f, lease);
  const before = fs.readFileSync(lease.file, 'utf8');
  const incomplete = async (pid) => ({ ...await provider(pid), entry_path: null });
  const status = await receiverStatus(f.file, Date.now(), { identityProvider: incomplete });
  assert.equal(status.running, null); assert.equal(status.healthy, false); assert.equal(status.status, 'IDENTITY_REVIEW_REQUIRED');
  await assert.rejects(recoverReceiverLock(f.c, f.file, 'worker', { provider: incomplete }), /LOCK_REVIEW_REQUIRED/);
  assert.equal(fs.readFileSync(lease.file, 'utf8'), before); lease.release();
});

test('stale heartbeat never permits takeover of a still-matching live owner', async (t) => {
  const f = fixture(t), old = Date.now() - 60000;
  const lease = await claimReceiverProcess(f.c, f.file, 'worker', { provider, now: old }); publish(f, lease, old);
  const status = await receiverStatus(f.file, Date.now(), { identityProvider: provider });
  assert.equal(status.running, true); assert.equal(status.healthy, false); assert.equal(status.status, 'UNRESPONSIVE');
  await assert.rejects(recoverReceiverLock(f.c, f.file, 'worker', { provider }), /LOCK_HELD_OR_UNRESPONSIVE/);
  lease.release();
});

test('an old finally cannot remove a successor nonce', async (t) => {
  const f = fixture(t), lease = await claimReceiverProcess(f.c, f.file, 'worker', { provider });
  const next = JSON.stringify({ ...lease.lock, nonce: crypto.randomUUID() }); fs.writeFileSync(lease.file, next);
  assert.equal(lease.release().released, false); assert.equal(fs.readFileSync(lease.file, 'utf8'), next);
});

test('legacy locks without identity remain for review even if their PID exists', async (t) => {
  const f = fixture(t), file = path.join(f.dir, 'receiver.lock'), before = JSON.stringify({ pid: process.pid, thread_id: f.c.thread_id });
  fs.writeFileSync(file, before);
  const result = await inspectReceiverProcess(f.c, f.file, 'worker', { provider }); assert.equal(result.status, 'UNKNOWN');
  await assert.rejects(claimReceiverProcess(f.c, f.file, 'worker', { provider }), /LOCK_REVIEW_REQUIRED/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('corrupt quota ledger cannot appear as a fresh six-slot budget', async (t) => {
  const f = fixture(t); fs.writeFileSync(path.join(f.dir, 'ledger.json'), '{broken');
  const status = await receiverStatus(f.file);
  assert.equal(status.ledger_valid, false); assert.equal(status.remaining_native_submissions, null); assert.equal(status.last_error, 'LEDGER_INVALID');
});

test('concurrent recovery and claim are serialized across identity lookup and exclusive create', async (t) => {
  const f = fixture(t); let resume, entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { resume = resolve; });
  const first = claimReceiverProcess(f.c, f.file, 'worker', { provider: async (pid) => { entered(); await gate; return provider(pid); } });
  await started;
  await assert.rejects(claimReceiverProcess(f.c, f.file, 'worker', { provider }), /LOCK_RECOVERY_REVIEW_REQUIRED/);
  resume(); const lease = await first;
  assert.equal(JSON.parse(fs.readFileSync(lease.file)).nonce, lease.lock.nonce);
  assert.equal(fs.existsSync(lease.file + '.transaction'), false); lease.release();
});

test('an interrupted lock transaction pauses for review instead of reclaiming by PID alone', async (t) => {
  const f = fixture(t), transaction = path.join(f.dir, 'receiver.lock.transaction'), raw = JSON.stringify({ pid: process.pid, nonce: 'uncertain-transaction' });
  fs.writeFileSync(transaction, raw);
  await assert.rejects(claimReceiverProcess(f.c, f.file, 'worker', { provider }), /LOCK_RECOVERY_REVIEW_REQUIRED/);
  assert.equal(fs.readFileSync(transaction, 'utf8'), raw); assert.equal(fs.existsSync(path.join(f.dir, 'receiver.lock')), false);
  const status = await receiverStatus(f.file);
  assert.equal(status.status, 'LOCK_RECOVERY_REVIEW_REQUIRED'); assert.equal(status.recovery_transaction_present, true);
});

test('matching process identity does not hide a stale running code version', async (t) => {
  const f = fixture(t), lease = await claimReceiverProcess(f.c, f.file, 'worker', { provider }); publish(f, lease);
  const file = path.join(f.dir, 'status.json'), status = JSON.parse(fs.readFileSync(file));
  fs.writeFileSync(file, JSON.stringify({ ...status, code_identity: { readable: true, code_sha256: '0'.repeat(64), package_version: 'old-fixture' } }));
  const result = await receiverStatus(f.file, Date.now(), { identityProvider: provider });
  assert.equal(result.process_healthy, true); assert.equal(result.healthy, false); assert.equal(result.version_state, 'PENDING_RELOAD');
  assert.equal(result.status, 'PENDING_RELOAD'); assert.equal(result.last_error, 'RECEIVER_CODE_CHANGED_RELOAD_REQUIRED'); lease.release();
});
