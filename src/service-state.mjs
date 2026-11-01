// Shared service/target status schema.
//
// Status is intentionally small and read-only for doctor/UI callers. It never
// contains tokens, message text, full stderr or chat content.
import fs from 'node:fs';
import path from 'node:path';

export const SERVICE_STATE_SCHEMA_VERSION = 1;
export const SERVICE_COMPONENTS = Object.freeze(['hub', 'worker', 'companion']);
export const SERVICE_STATES = Object.freeze([
  'STARTING',
  'READY',
  'WAITING',
  'BACKOFF',
  'HALTED',
  'STOPPED',
  'UNKNOWN',
]);

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${field} must be a non-empty string`);
  return value;
}

export function createServiceState({
  installation_id,
  instance_id,
  owner_mode,
  component,
  target = null,
  pid = null,
  process_created_at = null,
  nonce,
  state = 'STARTING',
  reason_code = null,
  last_heartbeat_at = new Date().toISOString(),
  last_exit = null,
  next_retry_at = null,
} = {}) {
  return validateServiceState({
    schema_version: SERVICE_STATE_SCHEMA_VERSION,
    installation_id,
    instance_id,
    owner_mode,
    component,
    target,
    pid,
    process_created_at,
    nonce,
    state,
    reason_code,
    last_heartbeat_at,
    last_exit,
    next_retry_at,
  });
}

export function validateServiceState(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('service state must be an object');
  }
  if (value.schema_version !== SERVICE_STATE_SCHEMA_VERSION) {
    throw new TypeError(`unsupported service state schema: ${String(value.schema_version)}`);
  }
  if (!SERVICE_COMPONENTS.includes(value.component)) throw new TypeError(`unsupported component: ${String(value.component)}`);
  if (!SERVICE_STATES.includes(value.state)) throw new TypeError(`unsupported service state: ${String(value.state)}`);
  if (value.pid !== null && value.pid !== undefined && (!Number.isInteger(value.pid) || value.pid <= 0)) {
    throw new TypeError('pid must be a positive integer or null');
  }
  if (value.target !== null && value.target !== undefined && typeof value.target !== 'string') {
    throw new TypeError('target must be a string or null');
  }
  if (value.last_exit !== null && value.last_exit !== undefined) {
    if (typeof value.last_exit !== 'object' || Array.isArray(value.last_exit)) {
      throw new TypeError('last_exit must be an object or null');
    }
    if (value.last_exit.code !== null && !Number.isInteger(value.last_exit.code)) {
      throw new TypeError('last_exit.code must be an integer or null');
    }
    if (value.last_exit.signal !== null && typeof value.last_exit.signal !== 'string') {
      throw new TypeError('last_exit.signal must be a string or null');
    }
  }
  return {
    schema_version: SERVICE_STATE_SCHEMA_VERSION,
    installation_id: requireString(value.installation_id, 'installation_id'),
    instance_id: requireString(value.instance_id, 'instance_id'),
    owner_mode: requireString(value.owner_mode, 'owner_mode'),
    component: value.component,
    target: value.target ?? null,
    pid: value.pid ?? null,
    process_created_at: typeof value.process_created_at === 'string' ? value.process_created_at : null,
    nonce: requireString(value.nonce, 'nonce'),
    state: value.state,
    reason_code: typeof value.reason_code === 'string' ? value.reason_code : null,
    last_heartbeat_at: typeof value.last_heartbeat_at === 'string'
      ? value.last_heartbeat_at
      : new Date().toISOString(),
    last_exit: value.last_exit === null || value.last_exit === undefined ? null : {
      code: value.last_exit.code ?? null,
      signal: typeof value.last_exit.signal === 'string' || value.last_exit.signal === null ? value.last_exit.signal : null,
      at: typeof value.last_exit.at === 'string' ? value.last_exit.at : null,
      reason: typeof value.last_exit.reason === 'string' ? value.last_exit.reason : null,
    },
    next_retry_at: typeof value.next_retry_at === 'string' ? value.next_retry_at : null,
  };
}

export function readServiceState(file) {
  if (!fs.existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot parse service state ${file}: ${String(error?.message ?? error)}`);
  }
  return validateServiceState(parsed);
}

export function writeServiceStateAtomic(file, state) {
  const normalized = validateServiceState(state);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch { /* best effort */ }
  }
  return { ...normalized };
}

export function updateServiceState(file, patch) {
  const current = readServiceState(file);
  if (current === null) throw new Error(`service state missing: ${file}`);
  return writeServiceStateAtomic(file, { ...current, ...patch });
}
