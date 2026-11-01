import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRestartPolicy,
  normalizeRestartState,
} from '../src/restart-policy.mjs';

test('restart policy uses bounded delays and halts after the configured attempts', () => {
  const policy = createRestartPolicy({ delaysMs: [100, 200], maxAttempts: 3, stableMs: 5_000, now: () => 1_000 });
  let state = policy.recordFailure({ at: 1_000, code: 'A' });
  assert.equal(state.attempts, 1);
  assert.equal(Date.parse(state.next_retry_at) - 1_000, 100);
  state = policy.recordFailure({ at: 2_000, code: 'B' });
  assert.equal(Date.parse(state.next_retry_at) - 2_000, 200);
  state = policy.recordFailure({ at: 3_000, code: 'C' });
  assert.equal(state.halted, true);
  assert.equal(state.next_retry_at, null);
  assert.equal(policy.recordFailure({ at: 4_000 }).attempts, 3);
});

test('stable window is required before consecutive failures clear', () => {
  let now = 10_000;
  const policy = createRestartPolicy({ delaysMs: [100], maxAttempts: 5, stableMs: 5_000, now: () => now });
  policy.recordFailure({ at: now, code: 'POP' });
  policy.recordHealthy({ at: now });
  now = 14_999;
  assert.equal(policy.recordStable({ at: now }).attempts, 1);
  now = 15_000;
  const cleared = policy.recordStable({ at: now });
  assert.equal(cleared.attempts, 0);
  assert.equal(cleared.failures, 0);
  assert.equal(cleared.halted, false);
});

test('halted policy requires explicit reset; restore preserves counters', () => {
  const policy = createRestartPolicy({ delaysMs: [10], maxAttempts: 1, stableMs: 0 });
  const halted = policy.recordFailure({ at: 1_000, code: 'X' });
  assert.equal(halted.halted, true);
  const restored = createRestartPolicy({ delaysMs: [10], maxAttempts: 1, stableMs: 0, snapshot: halted });
  assert.equal(restored.snapshot().halted, true);
  assert.equal(restored.recordFailure({ at: 2_000 }).attempts, 1);
  const reset = restored.reset({ at: 3_000 });
  assert.equal(reset.halted, false);
  assert.equal(reset.attempts, 0);
});

test('snapshot normalization is stable and does not mutate input', () => {
  const input = { attempts: 2, failures: 3, halted: false, stable_since: null, extra: 'ignored' };
  const normalized = normalizeRestartState(input);
  assert.deepEqual(normalized, {
    attempts: 2,
    failures: 3,
    halted: false,
    stable_since: null,
    last_failure_at: null,
    next_retry_at: null,
    last_reason_code: null,
    failure_times: [],
  });
  assert.equal(input.extra, 'ignored');
});
test('failure window prunes old failures before the attempt cap', () => {
  const policy = createRestartPolicy({ delaysMs: [10], maxAttempts: 3, stableMs: 60_000, failureWindowMs: 1_000 });
  assert.equal(policy.recordFailure({ at: 0 }).halted, false);
  assert.equal(policy.recordFailure({ at: 900 }).halted, false);
  const third = policy.recordFailure({ at: 1_300 });
  assert.equal(third.attempts, 2);
  assert.equal(third.halted, false);
  const fourth = policy.recordFailure({ at: 1_800 });
  assert.equal(fourth.attempts, 3);
  assert.equal(fourth.halted, true);
});

