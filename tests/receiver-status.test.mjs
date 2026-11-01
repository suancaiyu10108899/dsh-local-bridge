import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  attachDeliveryHints,
  deliveryHint,
  readReceiverStatuses,
  readReceiverStatusesAsync,
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
  assert.equal(daily.active, false);
  assert.equal(daily.ready, false);
  assert.equal(daily.reportedActive, true);
  assert.equal(daily.reportedReady, true);
  assert.equal(daily.health, 'UNVERIFIED');
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
  assert.equal(rate.active, false);
  assert.equal(rate.reportedActive, true);
  assert.equal(rate.remainingNativeSubmissions, 0);

  const backoff = summarizeReceiver({ mode: 'daily', enabled: true, expires_at: null, status: 'BACKOFF' }, { now });
  assert.equal(backoff.phase, 'backoff');
  assert.equal(backoff.active, false);
  assert.equal(backoff.reportedActive, true);

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
      { threadId: 'daily', mode: 'daily', phase: 'online-idle', status: 'ONLINE_IDLE', active: true, effectiveActive: true, ready: true, health: 'IDENTITY_VERIFIED', heartbeatFresh: true, reportedActive: true, expiresAt: null },
      { threadId: 'rate', mode: 'daily', phase: 'rate-limited', status: 'RATE_LIMITED', active: true, effectiveActive: true, health: 'IDENTITY_VERIFIED', heartbeatFresh: true, reportedActive: true, nextEligibleAt: '2026-10-21T12:05:00Z', remainingNativeSubmissions: 0 },
      { threadId: 'backoff', mode: 'daily', phase: 'backoff', status: 'BACKOFF', active: true, effectiveActive: true, health: 'IDENTITY_VERIFIED', heartbeatFresh: true, reportedActive: true, expiresAt: null },
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
  assert.equal(dailyReceiver.active, false);
  assert.equal(dailyReceiver.reportedActive, true);
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
test('v3 receiver status verifies process identity instead of trusting pidAlive', async () => {
  const runtime = tempRoot();
  const dir = path.join(runtime, 'codex', 'thread-v3');
  fs.mkdirSync(dir, { recursive: true });
  const identity = {
    pid: 4321,
    alive: true,
    available: true,
    source: 'injected',
    created_at: '2026-10-23T12:00:00.000Z',
    exe_path: 'C:\\Program Files\\nodejs\\node.exe',
    entry_path: 'C:\\Dev\\bridge\\codex-receiver\\adapters\\codex\\daily-receiver.mjs',
  };
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({
    schema_version: 3,
    mode: 'daily',
    expires_at: null,
    enabled: true,
    status: 'ONLINE_IDLE',
    installation_id: 'install-1',
    instance_id: 'instance-1',
    thread_id: 'thread-v3',
    worker_nonce: 'worker-nonce',
    heartbeat_at: '2026-10-23T12:00:55.000Z',
    owner_process: {
      pid: 4321,
      created_at: identity.created_at,
      exe_realpath: identity.exe_path,
      entry_realpath: identity.entry_path,
      config_path: 'C:\\Dev\\bridge\\config.json',
      nonce: 'worker-nonce',
      thread_id: 'thread-v3',
    },
  }));
  const result = await readReceiverStatusesAsync({
    runtimeDir: runtime,
    processProvider: () => Promise.resolve(identity),
    now: Date.parse('2026-10-23T12:01:00Z'),
  });
  assert.equal(result.receivers.length, 1);
  assert.equal(result.receivers[0].schemaVersion, 3);
  assert.equal(result.receivers[0].instanceId, 'instance-1');
  assert.equal(result.receivers[0].workerNonce, 'worker-nonce');
  assert.equal(result.receivers[0].identityVerdict, 'SAME');
  assert.equal(result.receivers[0].health, 'IDENTITY_VERIFIED');
  assert.equal(result.receivers[0].identityComplete, true);
});

test('v3 receiver status without identity is UNVERIFIED, not healthy', async () => {
  const runtime = tempRoot();
  const dir = path.join(runtime, 'codex', 'thread-v3-missing');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({
    schema_version: 3,
    mode: 'daily',
    expires_at: null,
    enabled: true,
    status: 'ONLINE_IDLE',
    installation_id: 'install-1',
    instance_id: 'instance-1',
    thread_id: 'thread-v3-missing',
    pid: 4321,
  }));
  const result = await readReceiverStatusesAsync({ runtimeDir: runtime, processProvider: () => Promise.resolve({ pid: 4321, alive: true, available: false }) });
  assert.equal(result.receivers[0].identityVerdict, 'UNKNOWN');
  assert.equal(result.receivers[0].health, 'UNVERIFIED');
});
function writeV3Status(runtime, name, { heartbeatAt, identity = {} }) {
  const dir = path.join(runtime, 'codex', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({
    schema_version: 3,
    mode: 'daily',
    expires_at: null,
    enabled: true,
    status: 'ONLINE_IDLE',
    thread_id: name,
    installation_id: 'install-1',
    instance_id: 'instance-1',
    worker_nonce: 'nonce-1',
    heartbeat_at: heartbeatAt,
    owner_process: {
      pid: 4321,
      created_at: '2026-10-23T12:00:00.000Z',
      exe_realpath: 'C:\\Program Files\\nodejs\\node.exe',
      entry_realpath: 'C:\\Dev\\bridge\\daily-receiver.mjs',
      config_path: 'C:\\Dev\\bridge\\config.json',
      nonce: 'nonce-1',
      thread_id: name,
      ...identity,
    },
  }));
}

const baseIdentity = {
  pid: 4321,
  alive: true,
  available: true,
  source: 'injected',
  created_at: '2026-10-23T12:00:00.000Z',
  exe_path: 'C:\\Program Files\\nodejs\\node.exe',
  entry_path: 'C:\\Dev\\bridge\\daily-receiver.mjs',
};

test('identity mismatch / stale / future / v2 unknown never report current reachability', async () => {
  const now = Date.parse('2026-10-23T12:01:00Z');
  const runtime = tempRoot();
  writeV3Status(runtime, 'mismatch', { heartbeatAt: '2026-10-23T12:00:55.000Z' });
  const mismatch = await readReceiverStatusesAsync({
    runtimeDir: runtime,
    now,
    processProvider: () => Promise.resolve({ ...baseIdentity, exe_path: 'C:\\Other\\evil.exe' }),
  });
  assert.equal(mismatch.receivers[0].identityVerdict, 'DIFFERENT');
  assert.equal(mismatch.receivers[0].health, 'IDENTITY_MISMATCH');
  assert.equal(mismatch.receivers[0].active, false);
  assert.equal(mismatch.receivers[0].ready, false);
  assert.equal(deliveryHint({ to: 'codex:mismatch', state: 'queued' }, mismatch).code, 'receiver-mismatch');

  const staleRuntime = tempRoot();
  writeV3Status(staleRuntime, 'stale', { heartbeatAt: '2026-10-23T11:00:00.000Z' });
  const stale = await readReceiverStatusesAsync({ runtimeDir: staleRuntime, now, processProvider: () => Promise.resolve(baseIdentity) });
  assert.equal(stale.receivers[0].health, 'STALE_HEARTBEAT');
  assert.equal(stale.receivers[0].active, false);
  assert.equal(stale.receivers[0].ready, false);
  assert.equal(deliveryHint({ to: 'codex:stale', state: 'queued' }, stale).code, 'receiver-stale');

  const futureRuntime = tempRoot();
  writeV3Status(futureRuntime, 'future', { heartbeatAt: '2026-10-23T12:02:00.000Z' });
  const future = await readReceiverStatusesAsync({ runtimeDir: futureRuntime, now, processProvider: () => Promise.resolve(baseIdentity) });
  assert.equal(future.receivers[0].health, 'FUTURE_HEARTBEAT');
  assert.equal(future.receivers[0].ready, false);
  assert.equal(deliveryHint({ to: 'codex:future', state: 'queued' }, future).code, 'receiver-heartbeat-future');

  const v2Runtime = tempRoot();
  const v2Dir = path.join(v2Runtime, 'codex', 'v2');
  fs.mkdirSync(v2Dir, { recursive: true });
  fs.writeFileSync(path.join(v2Dir, 'status.json'), JSON.stringify({
    mode: 'daily', expires_at: null, enabled: true, status: 'ONLINE_IDLE', thread_id: 'v2', heartbeat_at: '2026-10-23T12:00:55.000Z', pid: 4321,
  }));
  const v2 = await readReceiverStatusesAsync({ runtimeDir: v2Runtime, now });
  assert.equal(v2.receivers[0].identityVerdict, 'UNKNOWN');
  assert.equal(v2.receivers[0].active, false);
  assert.equal(v2.receivers[0].ready, false);
  assert.equal(v2.receivers[0].status, 'ONLINE_IDLE');
  assert.equal(v2.receivers[0].reportedReady, true);
  assert.equal(deliveryHint({ to: 'codex:v2', state: 'queued' }, v2).code, 'receiver-unverified');
});