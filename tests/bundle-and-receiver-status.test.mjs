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

test('summarizeReceiver distinguishes online, waiting, expired and halted', () => {
  const now = Date.parse('2026-10-21T12:00:00Z');
  assert.equal(summarizeReceiver({ status: 'ONLINE_IDLE' }, { now }).phase, 'online-idle');
  assert.equal(summarizeReceiver({ status: 'WAITING_FOR_TARGET_IDLE_OR_COOLDOWN' }, { now }).phase, 'waiting');
  assert.equal(summarizeReceiver({ status: 'ONLINE_IDLE', expires_at: '2026-10-21T11:00:00Z' }, { now }).phase, 'expired');
  assert.equal(summarizeReceiver({ status: 'HALTED_REVIEW_REQUIRED' }, { now }).phase, 'halted');
  assert.equal(summarizeReceiver({ status: 'EXPIRED' }, { now }).active, false);
});

test('readReceiverStatuses is read-only and tolerates a missing runtime directory', () => {
  const root = path.join(tempRoot(), 'missing-runtime');
  assert.deepEqual(readReceiverStatuses({ runtimeDir: root }).receivers, []);
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

  const queued = {
    msg_id: 'm-1',
    to: 'codex:thread-a',
    state: 'queued',
  };
  const hinted = attachDeliveryHints([queued], read);
  assert.equal(hinted[0].delivery_hint.code, 'receiver-expired');
  assert.match(hinted[0].delivery_hint.detail, /new window/i);

  assert.equal(deliveryHint({ to: 'dsh:session-x', state: 'queued' }, read), undefined);
  assert.equal(deliveryHint({ to: 'codex:missing', state: 'queued' }, read).code, 'receiver-absent');
  assert.equal(deliveryHint({ to: 'codex:thread-a', state: 'delivered' }, read), undefined);
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
