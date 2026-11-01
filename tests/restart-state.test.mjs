import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readRestartSnapshot, restartSnapshotPath, writeRestartSnapshotAtomic } from '../src/restart-state.mjs';

function tempFile() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-restart-state-'));
  return { root, file: path.join(root, 'targets', 'state.json') };
}

const valid = {
  attempts: 2,
  failures: 3,
  halted: false,
  stable_since: null,
  last_failure_at: '2026-10-23T12:00:00.000Z',
  next_retry_at: '2026-10-23T12:00:05.000Z',
  last_reason_code: 'exit:1',
  failure_times: ['2026-10-23T12:00:00.000Z'],
};

test('restart snapshot round-trips and keeps failure counters', () => {
  const { root, file } = tempFile();
  try {
    const written = writeRestartSnapshotAtomic(file, valid);
    assert.equal(written.attempts, 2);
    const read = readRestartSnapshot(file);
    assert.equal(read.attempts, 2);
    assert.equal(read.failures, 3);
    assert.deepEqual(read.failure_times, valid.failure_times);
    assert.equal(restartSnapshotPath(root, 'abc'), path.join(root, 'targets', 'abc.json'));
    assert.equal(readRestartSnapshot(path.join(root, 'missing.json')), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('partial or corrupt restart snapshots fail closed instead of-zeroing', () => {
  const { root, file } = tempFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ attempts: 2 }));
    assert.throws(() => readRestartSnapshot(file), (error) => error.code === 'RESTART_STATE_CORRUPT' && /missing/.test(error.message));
    fs.writeFileSync(file, '{not-json');
    assert.throws(() => readRestartSnapshot(file), (error) => error.code === 'RESTART_STATE_CORRUPT');
    fs.writeFileSync(file, JSON.stringify({ ...valid, attempts: -1 }));
    assert.throws(() => readRestartSnapshot(file), (error) => error.code === 'RESTART_STATE_CORRUPT');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('restart snapshot write failure is surfaced, not swallowed', () => {
  const { root, file } = tempFile();
  try {
    fs.mkdirSync(file, { recursive: true });
    assert.throws(() => writeRestartSnapshotAtomic(file, valid));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});