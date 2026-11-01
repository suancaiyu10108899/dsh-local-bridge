// Target membership records for the companion-owned worker model.
//
// One exact target has one file under <membershipsDir>/<target-key>.json.
// The companion discovers memberships from disk; owner CLI enable/disable only
// writes desired state and never starts a second supervisor.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MEMBERSHIP_SCHEMA_VERSION = 1;
export const DESIRED_STATES = Object.freeze(['ENABLED', 'DISABLED']);
export const RECEIVER_KINDS = Object.freeze(['daily', 'legacy']);

export class MembershipError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MembershipError';
    this.code = code;
    this.details = details;
  }
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MembershipError('MEMBERSHIP_INVALID', `${field} must be a non-empty string`, { field });
  }
  return value;
}

function requireAbsolutePath(value, field) {
  requireString(value, field);
  if (!path.isAbsolute(value)) throw new MembershipError('MEMBERSHIP_INVALID', `${field} must be an absolute path`, { field });
  return path.resolve(value);
}

function requireTarget(value) {
  requireString(value, 'target');
  const [role, ...rest] = value.split(':');
  if (!['codex', 'dsh'].includes(role) || rest.join(':').length === 0) {
    throw new MembershipError('MEMBERSHIP_INVALID', 'target must be an exact codex:<id> or dsh:<id> identity', { field: 'target' });
  }
  return value;
}

/** Stable file key; never use a human-friendly label or title. */
export function targetKey(target) {
  return crypto.createHash('sha256').update(requireTarget(target)).digest('hex');
}

export function membershipPath(root, target) {
  return path.join(path.resolve(root), 'memberships', `${targetKey(target)}.json`);
}

export function validateMembership(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new MembershipError('MEMBERSHIP_INVALID', 'membership must be an object');
  }
  if ((value.v ?? MEMBERSHIP_SCHEMA_VERSION) !== MEMBERSHIP_SCHEMA_VERSION) {
    throw new MembershipError('MEMBERSHIP_SCHEMA_UNSUPPORTED', `unsupported membership schema: ${String(value.v)}`);
  }
  if (!DESIRED_STATES.includes(value.desired_state)) {
    throw new MembershipError('MEMBERSHIP_INVALID', 'desired_state must be ENABLED or DISABLED', { field: 'desired_state' });
  }
  if (!RECEIVER_KINDS.includes(value.receiver_kind)) {
    throw new MembershipError('MEMBERSHIP_INVALID', 'receiver_kind must be daily or legacy', { field: 'receiver_kind' });
  }
  if (typeof value.enabled !== 'boolean' || typeof value.owner_opt_in !== 'boolean' || typeof value.start_at_logon !== 'boolean') {
    throw new MembershipError('MEMBERSHIP_INVALID', 'enabled/owner_opt_in/start_at_logon must be booleans');
  }
  return {
    v: MEMBERSHIP_SCHEMA_VERSION,
    installation_id: requireString(value.installation_id, 'installation_id'),
    instance_id: requireString(value.instance_id, 'instance_id'),
    target: requireTarget(value.target),
    platform: value.platform === 'dsh' ? 'dsh' : 'codex',
    binding_epoch: requireString(value.binding_epoch, 'binding_epoch'),
    config_path: requireAbsolutePath(value.config_path, 'config_path'),
    receiver_kind: value.receiver_kind,
    desired_state: value.desired_state,
    enabled: value.enabled,
    owner_opt_in: value.owner_opt_in,
    owner_opt_in_at: requireString(value.owner_opt_in_at, 'owner_opt_in_at'),
    start_at_logon: value.start_at_logon,
    updated_at: requireString(value.updated_at, 'updated_at'),
    registration_nonce: requireString(value.registration_nonce, 'registration_nonce'),
  };
}

export function readMembership(file) {
  if (!fs.existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new MembershipError('MEMBERSHIP_INVALID', `cannot parse membership ${file}: ${String(error?.message ?? error)}`);
  }
  return validateMembership(parsed);
}

export function writeMembershipAtomic(root, membership) {
  const normalized = validateMembership(membership);
  const file = membershipPath(root, normalized.target);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch { /* best effort */ }
  }
  return { ...normalized, file };
}

export function createMembership({
  installation_id,
  instance_id,
  target,
  binding_epoch,
  config_path,
  receiver_kind = 'daily',
  desired_state = 'DISABLED',
  enabled = false,
  owner_opt_in = false,
  owner_opt_in_at = new Date().toISOString(),
  start_at_logon = false,
  registration_nonce = crypto.randomUUID(),
  now = new Date().toISOString(),
} = {}) {
  const platform = String(target).startsWith('dsh:') ? 'dsh' : 'codex';
  return validateMembership({
    v: MEMBERSHIP_SCHEMA_VERSION,
    installation_id,
    instance_id,
    target,
    platform,
    binding_epoch,
    config_path,
    receiver_kind,
    desired_state,
    enabled,
    owner_opt_in,
    owner_opt_in_at,
    start_at_logon,
    updated_at: now,
    registration_nonce,
  });
}

/** List all valid memberships. Invalid files are reported, never silently treated as enabled. */
export function listMemberships(root) {
  const dir = path.join(path.resolve(root), 'memberships');
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { memberships: [], invalid: [] };
  }
  const memberships = [];
  const invalid = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(dir, entry.name);
    try {
      memberships.push({ ...readMembership(file), file });
    } catch (error) {
      invalid.push({ file, code: error?.code ?? 'MEMBERSHIP_INVALID', message: String(error?.message ?? error) });
    }
  }
  memberships.sort((a, b) => a.target.localeCompare(b.target));
  return { memberships, invalid };
}

/**
 * Owner CLI enable writes desired state only. It does not spawn a worker or
 * second supervisor; the companion discovers this record and starts the worker.
 */
export function registerMembershipEnable({
  root,
  installation_id,
  instance_id,
  target,
  binding_epoch,
  config_path,
  owner_opt_in_at = new Date().toISOString(),
  start_at_logon = false,
  receiver_kind = 'daily',
  now = new Date().toISOString(),
}) {
  return writeMembershipAtomic(root, createMembership({
    installation_id,
    instance_id,
    target,
    binding_epoch,
    config_path,
    receiver_kind,
    desired_state: 'ENABLED',
    enabled: true,
    owner_opt_in: true,
    owner_opt_in_at,
    start_at_logon,
    now,
  }));
}

export function registerMembershipDisable({ root, target, now = new Date().toISOString() }) {
  const file = membershipPath(root, target);
  const current = readMembership(file);
  if (current === null) throw new MembershipError('MEMBERSHIP_MISSING', `membership missing for target: ${target}`);
  return writeMembershipAtomic(root, {
    ...current,
    desired_state: 'DISABLED',
    enabled: false,
    updated_at: now,
    registration_nonce: crypto.randomUUID(),
  });
}
