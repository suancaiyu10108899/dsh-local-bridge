// Hub owner-mode / lease contract.
//
// The Hub process itself is not the owner: COMPANION_OWNED / DSH_PLUGIN_OWNED
// supervisors acquire this lease. This module provides atomic acquire/heartbeat/
// release and a read-only inspection result. It never takes over a live owner
// based only on an expired lease and never kills a process.
import fs from 'node:fs';
import path from 'node:path';
import { HUB_OWNER_MODES } from './installation.mjs';
import { runtimePaths } from './runtime.mjs';
import {
  acquireOwnerLock,
  heartbeatOwnerLock,
  isOwnerAlive,
  readOwnerLock,
  releaseOwnerLock,
} from './process-identity.mjs';

export const HUB_OWNER_HEARTBEAT_MS = 10_000;
export const HUB_OWNER_LEASE_MS = 30_000;

export class HubOwnerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'HubOwnerError';
    this.code = code;
    this.details = details;
  }
}

export function hubOwnerLockFile(runtimeDir) {
  return runtimePaths(runtimeDir).ownerLockFile;
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HubOwnerError('HUB_OWNER_INVALID', `${field} must be a non-empty string`, { field });
  }
  return value;
}

function requireProcessIdentity(identity, field) {
  if (identity === null || typeof identity !== 'object' || Array.isArray(identity)) {
    throw new HubOwnerError('HUB_OWNER_INVALID', `${field} is required`, { field });
  }
  if (!Number.isInteger(identity.pid) || identity.pid <= 0) throw new HubOwnerError('HUB_OWNER_INVALID', `${field}.pid is invalid`, { field });
  for (const key of ['created_at', 'exe_realpath', 'entry_realpath', 'config_path']) {
    if (typeof identity[key] !== 'string' || identity[key].length === 0) {
      throw new HubOwnerError('HUB_OWNER_INVALID', `${field}.${key} is required`, { field: `${field}.${key}` });
    }
  }
  for (const key of ['exe_realpath', 'entry_realpath', 'config_path']) {
    if (!path.isAbsolute(identity[key])) {
      throw new HubOwnerError('HUB_OWNER_INVALID', `${field}.${key} must be absolute`, { field: `${field}.${key}` });
    }
  }
  return {
    pid: identity.pid,
    created_at: identity.created_at,
    exe_realpath: identity.exe_realpath,
    entry_realpath: identity.entry_realpath,
    config_path: identity.config_path,
  };
}

export function createHubOwnerRecord({
  installation,
  mode,
  owner_component,
  owner_profile_id,
  owner_process,
  hub_process,
  owner_epoch,
  nonce,
  now = Date.now(),
  heartbeatMs = HUB_OWNER_HEARTBEAT_MS,
  leaseMs = HUB_OWNER_LEASE_MS,
}) {
  if (installation === null || typeof installation !== 'object') throw new HubOwnerError('HUB_OWNER_INVALID', 'installation is required');
  if (!HUB_OWNER_MODES.includes(mode)) throw new HubOwnerError('HUB_OWNER_MODE_UNSUPPORTED', `owner mode is not supported: ${String(mode)}`);
  if (mode !== installation.hub_owner_kind) {
    throw new HubOwnerError('HUB_OWNER_MODE_MISMATCH', 'owner mode must equal installation.hub_owner_kind');
  }
  if (!Number.isInteger(owner_epoch) || owner_epoch < 1) throw new HubOwnerError('HUB_OWNER_INVALID', 'owner_epoch must be a positive integer');
  const record = {
    v: 1,
    installation_id: requireString(installation.installation_id, 'installation.installation_id'),
    instance_id: requireString(installation.instance_id, 'installation.instance_id'),
    owner_epoch,
    mode,
    owner_component: requireString(owner_component, 'owner_component'),
    owner_profile_id: typeof owner_profile_id === 'string' ? owner_profile_id : undefined,
    owner_process: requireProcessIdentity(owner_process, 'owner_process'),
    nonce: requireString(nonce, 'nonce'),
    heartbeat_at: new Date(now).toISOString(),
    lease_expires_at: new Date(now + leaseMs).toISOString(),
    heartbeat_interval_ms: heartbeatMs,
    lease_ms: leaseMs,
  };
  if (hub_process !== undefined) record.hub_process = requireProcessIdentity(hub_process, 'hub_process');
  return record;
}

/** Atomically acquire the owner generation. A live existing owner is never replaced. */
export async function acquireHubOwner({ runtimeDir, ...options }) {
  const lock = createHubOwnerRecord(options);
  return acquireOwnerLock({
    file: hubOwnerLockFile(runtimeDir),
    lock,
    now: options.now ?? Date.now(),
    ttlMs: options.leaseMs ?? HUB_OWNER_LEASE_MS,
  });
}

export function heartbeatHubOwner({ runtimeDir, nonce, now = Date.now(), ttlMs = HUB_OWNER_LEASE_MS }) {
  return heartbeatOwnerLock({ file: hubOwnerLockFile(runtimeDir), nonce, now, ttlMs });
}

export function releaseHubOwner({ runtimeDir, nonce }) {
  return releaseOwnerLock({ file: hubOwnerLockFile(runtimeDir), nonce });
}

/**
 * Read-only owner inspection. Expired/UNRESPONSIVE/UNKNOWN never implies a
 * takeover; callers must return REVIEW or explicitly hand over.
 */
export async function inspectHubOwner({ runtimeDir, now = Date.now(), provider, ttlMs = HUB_OWNER_LEASE_MS } = {}) {
  const file = hubOwnerLockFile(runtimeDir);
  const read = readOwnerLock(file);
  if (!read.ok) return { ok: false, code: read.code, state: 'NONE', lock: null };
  const health = await isOwnerAlive({ lock: read.lock, now, provider, ttlMs });
  return {
    ok: true,
    state: health.status,
    health,
    lock: read.lock,
    file,
  };
}

export function hubOwnerRecordPresent(runtimeDir) {
  return fs.existsSync(hubOwnerLockFile(runtimeDir));
}

export function hubOwnerLockPath(runtimeDir) {
  return path.resolve(hubOwnerLockFile(runtimeDir));
}
