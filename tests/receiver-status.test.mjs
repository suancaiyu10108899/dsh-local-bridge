import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  attachDeliveryHints,
  deliveryHint,
  readReceiverStatuses,
  summarizeReceiver,
} from '../src/receiver-status.mjs';
import { runtimeDirFor } from '../src/runtime.mjs';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-receiver-status-'));
}

test('runtimeDirFor keeps source checkouts inside the project', () => {
  const dir = runtimeDirFor({ projectRoot: path.join('D:', 'repo', 'project'), env: {}, homedir: 'C:\\Users\\x' });
  assert.equal(dir, path.join('D:', 'repo', 'project', '.local', 'runtime'));
});

test('runtimeDirFor uses DSH_HOME for installed bundles', () => {
  const root = path.join('D:', 'dsh-home', 'profiles', 'web', 'node_modules', 'dsh-local-bridge');
  const dir = runtimeDirFor({ projectRoot: root, env: { DSH_HOME: 'D:\\dsh-home' }, homedir: 'C:\\Users\\x' });
  assert.equal(dir, path.join('D:\\dsh-home', 'local-agent-bridge', 'runtime'));
});

test('runtimeDirFor honors an explicit override', () => {
  const dir = runtimeDirFor({ projectRoot: 'D:\\repo', env: { LAB_BRIDGE_RUNTIME_DIR: 'D:\\custom' } });
  assert.equal(dir, path.resolve('D:\\custom'));
});

test('summarizeReceiver distinguishes legacy bounded states', () => {
  const now = Date.parse('2026-10-21T12:00:00Z');
  assert.equal(summarizeReceiver({ status: 'ONLINE_IDLE', expires_at: '2026-10-21T13:00:00Z' }, { now }).phase, 'online-idle');
  assert.equal(summarizeReceiver({ status: 'WAITING_FOR_TARGET_IDLE_OR_COOLDOWN' }, { now }).phase, 'waiting');
  assert.equal(summarizeReceiver({ status: 'ONLINE_IDLE', expires_at: '2026-10-21T11:00:00Z' }, { now }).phase, 'expired');
  assert.equal(summarizeReceiver({ status: 'HALTED_REVIEW_REQUIRED' }, { now }).phase, 'halted');
  assert.equal(summarizeReceiver({ status: 'EXPIRED' }, { now }).active, false);
});

test('daily receiver with null expiry is not expired and exposes rolling counters', () => {
  const now = Date.parse('2026-10-21T12:00:00Z');
  const daily = summarizeReceiver({
    mode: 'daily',
    status: 'ONLINE_IDLE',
    enabled: true,
    expires_at: null,
    heartbeat_at: '2026-10-21T11:59:55Z',
    pid: 1234,
    max_native_submissions: 6,
    used_native_submissions: 2,
    remaining_native_submissions: 4,
    next_eligible_at: '2026-10-21T12:10:00Z',
    reason_code: 'READY',
  }, { now });
  assert.equal(daily.mode, 'daily');
  assert.equal(daily.expired, undefined);
  assert.equal(daily.phase, 'online-idle');
  assert.equal(daily.active, true);
  assert.equal(daily.ready, true);
  assert.equal(daily.expiresAt, null);
  assert.equal(daily.expiresInFuture, undefined);
  assert.equal(daily.remainingNativeSubmissions, 4);
  assert.equal(daily.nextEligibleAt, '2026-10-21T12:10:00Z');
  assert.equal(daily.reasonCode, 'READY');
  assert.equal(daily.heartbeatAgeMs, 5000);
});

test('daily rolling limit, backoff and paused-uncertain are visible but not misclassified as expiry', () => {
  const now = Date.parse('2026-10-21T12:00:00Z');
  const rate = summarizeReceiver({
    mode: 'daily',
    enabled: true,
    expires_at: null,
    status: 'RATE_LIMITED',
    max_native_submissions: 6,
    used_native_submissions: 6,
    next_eligible_at: '2026-10-21T12:05:00Z',
  }, { now });
  assert.equal(rate.phase, 'rate-limited');
  assert.equal(rate.active, true);
  assert.equal(rate.remainingNativeSubmissions, 0);

  const backoff = summarizeReceiver({ mode: 'daily', enabled: true, expires_at: null, status: 'BACKOFF' }, { now });
  assert.equal(backoff.phase, 'backoff');
  assert.equal(backoff.active, true);

  const paused = summarizeReceiver({ mode: 'daily', enabled: true, expires_at: null, status: 'PAUSED_UNCERTAIN' }, { now });
  assert.equal(paused.phase, 'paused-uncertain');
  assert.equal(paused.active, false);

  const disabled = summarizeReceiver({ mode: 'daily', enabled: false, expires_at: null, status: 'ONLINE_IDLE' }, { now });
  assert.equal(disabled.phase, 'disabled');
  assert.equal(disabled.active, false);
});

test('readReceiverStatuses is read-only and tolerates a missing runtime directory', () => {
  const root = path.join(tempRoot(), 'missing-runtime');
  assert.deepEqual(readReceiverStatuses({ runtimeDir: root }).receivers, []);
});

test('delivery hints cover legacy, daily, rate-limited, backoff and paused states', () => {
  const statuses = {
    receivers: [
      { threadId: 'legacy', mode: 'bounded', phase: 'expired', status: 'EXPIRED', active: false, expiresAt: '2026-10-21T10:00:00Z' },
      { threadId: 'daily', mode: 'daily', phase: 'online-idle', status: 'ONLINE_IDLE', active: true, expiresAt: null },
      { threadId: 'rate', mode: 'daily', phase: 'rate-limited', status: 'RATE_LIMITED', active: true, nextEligibleAt: '2026-10-21T12:05:00Z', remainingNativeSubmissions: 0 },
      { threadId: 'backoff', mode: 'daily', phase: 'backoff', status: 'BACKOFF', active: true, expiresAt: null },
      { threadId: 'paused', mode: 'daily', phase: 'paused-uncertain', status: 'PAUSED_UNCERTAIN', active: false },
    ],
  };
  const hint = (thread) => deliveryHint({ to: `codex:${thread}`, state: 'queued' }, statuses);
  assert.equal(hint('legacy').code, 'receiver-expired');
  assert.match(hint('daily').detail, /daily receiver/i);
  assert.equal(hint('rate').code, 'receiver-rate-limited');
  assert.match(hint('rate').detail, /delayed/i);
  assert.equal(hint('backoff').code, 'receiver-backoff');
  assert.equal(hint('paused').code, 'receiver-paused-uncertain');
  assert.equal(deliveryHint({ to: 'dsh:session-x', state: 'queued' }, statuses), undefined);
  assert.equal(deliveryHint({ to: 'codex:missing', state: 'queued' }, statuses).code, 'receiver-absent');
  assert.equal(deliveryHint({ to: 'codex:daily', state: 'delivered' }, statuses), undefined);
});

test('readReceiverStatuses summarizes receiver files and hints queued Codex messages', () => {
  const runtime = tempRoot();
  const receiverDir = path.join(runtime, 'codex', 'thread-a');
  fs.mkdirSync(receiverDir, { recursive: true });
  fs.writeFileSync(path.join(receiverDir, 'status.json'), JSON.stringify({
    at: '2026-10-21T11:00:00Z',
    pid: 1234,
    status: 'EXPIRED',
    thread_id: 'thread-a',
    window_id: 'w1',
    expires_at: '2026-10-21T10:00:00Z',
  }));
  const read = readReceiverStatuses({ runtimeDir: runtime, now: Date.parse('2026-10-21T12:00:00Z') });
  assert.equal(read.receivers.length, 1);
  assert.equal(read.receivers[0].phase, 'expired');
  assert.equal(read.receivers[0].active, false);

  const queued = { msg_id: 'm-1', to: 'codex:thread-a', state: 'queued' };
  const hinted = attachDeliveryHints([queued], read);
  assert.equal(hinted[0].delivery_hint.code, 'receiver-expired');

  const dailyDir = path.join(runtime, 'codex', 'thread-daily');
  fs.mkdirSync(dailyDir, { recursive: true });
  fs.writeFileSync(path.join(dailyDir, 'status.json'), JSON.stringify({
    mode: 'daily',
    enabled: true,
    expires_at: null,
    status: 'ONLINE_IDLE',
    thread_id: 'thread-daily',
  }));
  const daily = readReceiverStatuses({ runtimeDir: runtime, now: Date.parse('2026-10-21T12:00:00Z') });
  const dailyReceiver = daily.receivers.find((receiver) => receiver.threadId === 'thread-daily');
  assert.equal(dailyReceiver.mode, 'daily');
  assert.equal(dailyReceiver.active, true);
  assert.equal(dailyReceiver.expiresAt, null);
});

test('bundle metadata declares a DSH bundle patch and plugin entry', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.main, './adapters/dsh/plugin.mjs');
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.match(pkg.engines?.dsh, /0\.2\.1-rc\.2/);
  assert.ok(pkg.files.includes('cordis.patch.yml'));
  const patch = fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /insert:/);
  assert.match(patch, /name:\s*dsh-local-bridge/);
});
