// Durable restart-policy snapshots. One file per component/target scope.
//
// A persisted snapshot is security-relevant state: a partial/corrupt file must
// fail closed (review/halt), never silently reset the failure budget.
import fs from 'node:fs';
import path from 'node:path';
import { normalizeRestartState } from './restart-policy.mjs';

export class RestartStateError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RestartStateError';
    this.code = code;
    this.details = details;
  }
}

const REQUIRED_KEYS = [
  'attempts',
  'failures',
  'halted',
  'stable_since',
  'last_failure_at',
  'next_retry_at',
  'last_reason_code',
  'failure_times',
];

function validateSnapshot(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RestartStateError('RESTART_STATE_CORRUPT', 'restart snapshot must be an object');
  }
  for (const key of REQUIRED_KEYS) {
    if (!Object.hasOwn(value, key)) {
      throw new RestartStateError('RESTART_STATE_CORRUPT', `restart snapshot is missing ${key}`, { field: key });
    }
  }
  if (!Number.isInteger(value.attempts) || value.attempts < 0) {
    throw new RestartStateError('RESTART_STATE_CORRUPT', 'attempts must be a non-negative integer', { field: 'attempts' });
  }
  if (!Number.isInteger(value.failures) || value.failures < 0) {
    throw new RestartStateError('RESTART_STATE_CORRUPT', 'failures must be a non-negative integer', { field: 'failures' });
  }
  if (typeof value.halted !== 'boolean') {
    throw new RestartStateError('RESTART_STATE_CORRUPT', 'halted must be boolean', { field: 'halted' });
  }
  if (!Array.isArray(value.failure_times) || value.failure_times.some((item) => typeof item !== 'string' || !Number.isFinite(Date.parse(item)))) {
    throw new RestartStateError('RESTART_STATE_CORRUPT', 'failure_times must contain ISO timestamps', { field: 'failure_times' });
  }
  return normalizeRestartState(value);
}

export function readRestartSnapshot(file) {
  if (!fs.existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new RestartStateError('RESTART_STATE_CORRUPT', `cannot parse restart snapshot ${file}: ${String(error?.message ?? error)}`);
  }
  return validateSnapshot(parsed);
}

export function writeRestartSnapshotAtomic(file, snapshot) {
  const normalized = normalizeRestartState(snapshot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch { /* best effort */ }
  }
  return normalized;
}

export function restartSnapshotPath(stateRoot, targetKey) {
  return path.join(path.resolve(stateRoot), 'targets', `${targetKey}.json`);
}
