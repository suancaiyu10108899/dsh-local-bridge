import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createServiceState,
  readServiceState,
  updateServiceState,
  validateServiceState,
  writeServiceStateAtomic,
} from '../src/service-state.mjs';

function tempFile() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-service-state-'));
  return { root, file: path.join(root, 'status.json') };
}

const state = (overrides = {}) => createServiceState({
  installation_id: 'install-1',
  instance_id: 'instance-1',
  owner_mode: 'COMPANION_OWNED',
  component: 'hub',
  target: null,
  pid: 1234,
  process_created_at: '2026-10-23T12:00:00.000Z',
  nonce: 'nonce-1',
  state: 'READY',
  reason_code: null,
  ...overrides,
});

test('service state validates schema and required fields', () => {
  const value = state();
  assert.equal(value.schema_version, 1);
  assert.equal(validateServiceState(value).component, 'hub');
  assert.throws(() => validateServiceState({ ...value, component: 'bad' }), /unsupported component/);
  assert.throws(() => validateServiceState({ ...value, state: 'NOPE' }), /unsupported service state/);
  assert.throws(() => validateServiceState({ ...value, installation_id: '' }), /installation_id/);
});

test('service state write/read/update is atomic and status-only', () => {
  const { root, file } = tempFile();
  try {
    assert.equal(readServiceState(file), null);
    writeServiceStateAtomic(file, state());
    const read = readServiceState(file);
    assert.equal(read.state, 'READY');
    assert.equal(read.pid, 1234);
    const updated = updateServiceState(file, { state: 'BACKOFF', reason_code: 'HUB_UNREACHABLE' });
    assert.equal(updated.state, 'BACKOFF');
    assert.equal(updated.reason_code, 'HUB_UNREACHABLE');
    const raw = fs.readFileSync(file, 'utf8');
    assert.equal(raw.includes('token'), false);
    assert.equal(raw.includes('message text'), false);
    const signaled = updateServiceState(file, { state: 'HALTED', last_exit: { code: null, signal: 'SIGTERM', at: '2026-10-23T12:00:00.000Z', reason: 'SIGNAL_EXIT' } });
    assert.equal(signaled.last_exit.code, null);
    assert.equal(signaled.last_exit.signal, 'SIGTERM');
    assert.equal(signaled.last_exit.reason, 'SIGNAL_EXIT');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

