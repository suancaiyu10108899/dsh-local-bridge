// Bounded restart policy used by Hub, worker and companion supervisors.
//
// This module is deliberately pure: it never spawns, kills or writes files.
// Persistence and process identity live in the caller/service layer. Each
// component/target must use its own policy instance so an outer retry cannot
// clear an inner circuit breaker.
export const DEFAULT_RESTART_DELAYS_MS = Object.freeze([1_000, 2_000, 5_000, 10_000, 30_000]);
export const DEFAULT_MAX_ATTEMPTS = 10;
export const DEFAULT_STABLE_MS = 5 * 60_000;
export const DEFAULT_FAILURE_WINDOW_MS = 10 * 60_000;

function normalizeNumber(value, fallback, { min = 0 } = {}) {
  return Number.isFinite(value) && value >= min ? Math.trunc(value) : fallback;
}

function normalizeState(value) {
  const state = value !== null && typeof value === 'object' ? value : {};
  return {
    attempts: normalizeNumber(state.attempts, 0),
    failures: normalizeNumber(state.failures, 0),
    halted: state.halted === true,
    stable_since: typeof state.stable_since === 'string' ? state.stable_since : null,
    last_failure_at: typeof state.last_failure_at === 'string' ? state.last_failure_at : null,
    next_retry_at: typeof state.next_retry_at === 'string' ? state.next_retry_at : null,
    last_reason_code: typeof state.last_reason_code === 'string' ? state.last_reason_code : null,
    failure_times: Array.isArray(state.failure_times)
      ? state.failure_times.filter((value) => typeof value === 'string' && Number.isFinite(Date.parse(value)))
      : [],
  };
}

function iso(ms) {
  return new Date(ms).toISOString();
}

/** Restore a persisted policy snapshot without resetting counters. */
export function createRestartPolicy({
  delaysMs = DEFAULT_RESTART_DELAYS_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  stableMs = DEFAULT_STABLE_MS,
  failureWindowMs = DEFAULT_FAILURE_WINDOW_MS,
  now = Date.now,
  snapshot = null,
} = {}) {
  if (!Array.isArray(delaysMs) || delaysMs.length === 0 || delaysMs.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new TypeError('delaysMs must be a non-empty array of non-negative numbers');
  }
  const delays = delaysMs.map((value) => Math.trunc(value));
  const limit = normalizeNumber(maxAttempts, DEFAULT_MAX_ATTEMPTS, { min: 1 });
  const stableWindow = normalizeNumber(stableMs, DEFAULT_STABLE_MS, { min: 0 });
  const failureWindow = normalizeNumber(failureWindowMs, DEFAULT_FAILURE_WINDOW_MS, { min: 1 });
  let state = normalizeState(snapshot);

  const clone = () => ({ ...state });

  function delayForAttempt(attempts) {
    return delays[Math.min(Math.max(attempts - 1, 0), delays.length - 1)];
  }

  function nextDelay() {
    return delayForAttempt(state.attempts);
  }

  function recordFailure({ at = now(), code = null } = {}) {
    if (state.halted) return clone();
    const cutoff = at - failureWindow;
    const failureTimes = [...state.failure_times, iso(at)]
      .filter((value) => {
        const stamp = Date.parse(value);
        return Number.isFinite(stamp) && stamp >= cutoff;
      });
    state = {
      ...state,
      attempts: failureTimes.length,
      failures: state.failures + 1,
      stable_since: null,
      last_failure_at: iso(at),
      last_reason_code: typeof code === 'string' ? code : null,
      failure_times: failureTimes,
    };
    if (state.attempts >= limit) {
      state.halted = true;
      state.next_retry_at = null;
    } else {
      state.next_retry_at = iso(at + delayForAttempt(state.attempts));
    }
    return clone();
  }

  function recordHealthy({ at = now() } = {}) {
    if (state.stable_since === null) state.stable_since = iso(at);
    return clone();
  }

  /** Clear consecutive failures only after the full stable window. */
  function recordStable({ at = now() } = {}) {
    if (state.halted || state.stable_since === null) return clone();
    const start = Date.parse(state.stable_since);
    if (!Number.isFinite(start) || at - start < stableWindow) return clone();
    state = {
      ...state,
      attempts: 0,
      failures: 0,
      stable_since: iso(at),
      last_failure_at: null,
      next_retry_at: null,
      last_reason_code: null,
      failure_times: [],
    };
    return clone();
  }

  /** Health loss while waiting for the stable window; keeps failure counters. */
  function recordUnhealthy() {
    state = { ...state, stable_since: null };
    return clone();
  }

  /** Explicit operator reset; never called automatically by a failed outer layer. */
  function reset({ at = now() } = {}) {
    state = {
      attempts: 0,
      failures: 0,
      halted: false,
      stable_since: iso(at),
      last_failure_at: null,
      next_retry_at: null,
      last_reason_code: null,
      failure_times: [],
    };
    return clone();
  }

  return {
    snapshot: clone,
    recordFailure,
    recordHealthy,
    recordUnhealthy,
    recordStable,
    reset,
    nextDelay,
    get configured() {
      return { delaysMs: [...delays], maxAttempts: limit, stableMs: stableWindow, failureWindowMs: failureWindow };
    },
  };
}

/** Validate/normalize a persisted policy state for status/log output. */
export function normalizeRestartState(snapshot) {
  return normalizeState(snapshot);
}
