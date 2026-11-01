// Process identity and owner-lock primitives.
//
// Safety rule: a live PID is never sufficient proof of ownership. If creation
// time/executable/entry cannot be compared, callers must surface UNKNOWN and
// must not kill, signal or delete another process's lock.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pidAlive } from './health.mjs';

const execute = promisify(execFile);

export const PROCESS_IDENTITY_SCHEMA_VERSION = 1;
export const DEFAULT_LEASE_MS = 30_000;

export class ProcessIdentityError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ProcessIdentityError';
    this.code = code;
    this.details = details;
  }
}

function normalizePath(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  // A relative path cannot be compared without the target process's real cwd.
  // Never resolve it against the observer's cwd; that would guess identity.
  if (!path.isAbsolute(value)) return null;
  let resolved;
  try {
    resolved = fs.realpathSync.native ? fs.realpathSync.native(value) : fs.realpathSync(value);
  } catch {
    resolved = path.resolve(value);
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

const CREATION_RE = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|z|[+-]\d{2}:\d{2})$/;

/**
 * Parse an RFC3339 creation timestamp into a comparable instant. Invalid or
 * over-precise values return null; callers must report UNKNOWN, never DEAD.
 */
export function parseCreationInstant(value) {
  if (typeof value !== 'string') return null;
  const match = CREATION_RE.exec(value);
  if (match === null) return null;
  const [, year, month, day, hour, minute, second, fraction = '', zone] = match;
  if (fraction.length > 9) return null;
  const base = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}${zone.toUpperCase()}`);
  if (!Number.isFinite(base)) return null;
  const nanos = Number((fraction + '000000000').slice(0, 9));
  return { epochMs: base, nanos };
}

function sameCreation(a, b) {
  const left = parseCreationInstant(a);
  const right = parseCreationInstant(b);
  if (left === null || right === null) return null;
  return left.epochMs === right.epochMs && left.nanos === right.nanos;
}

function parseEntryFromCommandLine(commandLine) {
  if (typeof commandLine !== 'string' || commandLine.length === 0) return null;
  const tokens = commandLine.match(/"([^"]*)"|'([^']*)'|([^\s]+)/g);
  if (tokens === null) return null;
  const args = tokens.map((token) => token.replace(/^["']|["']$/g, ''));
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('-') || arg.startsWith('/')) continue;
    if (/\.(?:mjs|cjs|js)$/i.test(arg) || (path.isAbsolute(arg) && fs.existsSync(arg))) return arg;
  }
  return null;
}

/** Windows-only read-only identity provider using CIM. */
async function windowsProcessIdentityProvider(pid) {
  if (process.platform !== 'win32') {
    // No supported identity provider on this platform: a live PID is not a
    // reason to report DEAD, and no identity fields are invented.
    return {
      pid,
      alive: pidAlive(pid),
      available: false,
      source: 'unavailable',
      unavailable_reason: 'PROCESS_IDENTITY_PROVIDER_UNAVAILABLE',
    };
  }
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue`,
    'if ($null -eq $p) { [pscustomobject]@{ pid = 0; found = $false } | ConvertTo-Json -Compress } else {',
    '  $created = $null',
    '  if ($p.CreationDate) { $created = $p.CreationDate.ToUniversalTime().ToString("o") }',
    '  [pscustomobject]@{ pid = [int]$p.ProcessId; found = $true; created_at = $created; exe_path = $p.ExecutablePath; command_line = $p.CommandLine } | ConvertTo-Json -Compress',
    '}',
  ].join('\n');
  try {
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    const parsed = JSON.parse(stdout.trim());
    if (!parsed?.found) return { pid, alive: false, available: false, source: 'windows-cim', unavailable_reason: 'PROCESS_NOT_FOUND' };
    const parsedEntry = parseEntryFromCommandLine(parsed.command_line);
    const entryResolved = typeof parsedEntry === 'string' && path.isAbsolute(parsedEntry);
    return {
      pid: parsed.pid,
      alive: true,
      available: true,
      source: 'windows-cim',
      created_at: typeof parsed.created_at === 'string' ? parsed.created_at : null,
      exe_path: typeof parsed.exe_path === 'string' ? parsed.exe_path : null,
      entry_path: entryResolved ? parsedEntry : null,
      entry_unresolved: parsedEntry !== null && entryResolved === false,
      unavailable_reason: parsedEntry !== null && entryResolved === false ? 'ENTRY_PATH_UNRESOLVED' : null,
    };
  } catch (error) {
    return { pid, alive: pidAlive(pid), available: false, source: 'windows-cim', unavailable_reason: String(error?.code ?? 'PROCESS_IDENTITY_PROVIDER_UNAVAILABLE') };
  }
}

function normalizeIdentity(pid, providerResult) {
  const source = providerResult !== null && typeof providerResult === 'object' ? providerResult : {};
  const resultPid = Number.isInteger(source.pid) ? source.pid : pid;
  const created = parseCreationInstant(source.created_at) !== null ? source.created_at : null;
  let exe = typeof source.exe_path === 'string' && source.exe_path.length > 0 ? source.exe_path : null;
  let entry = typeof source.entry_path === 'string' && source.entry_path.length > 0 ? source.entry_path : null;
  let exeUnresolved = source.exe_unresolved === true || (exe !== null && !path.isAbsolute(exe));
  let entryUnresolved = source.entry_unresolved === true || (entry !== null && !path.isAbsolute(entry));
  if (exeUnresolved) exe = null;
  if (entryUnresolved) entry = null;
  const alive = typeof source.alive === 'boolean' ? source.alive : true;
  let unavailableReason = typeof source.unavailable_reason === 'string' ? source.unavailable_reason : null;
  if (unavailableReason === null && entryUnresolved) unavailableReason = 'ENTRY_PATH_UNRESOLVED';
  if (unavailableReason === null && exeUnresolved) unavailableReason = 'EXE_PATH_UNRESOLVED';
  const available = source.available !== false && created !== null && exe !== null && entry !== null;
  return {
    pid: resultPid,
    alive,
    available,
    source: typeof source.source === 'string' ? source.source : 'injected',
    created_at: created,
    exe_path: exe,
    entry_path: entry,
    exe_unresolved: exeUnresolved,
    entry_unresolved: entryUnresolved,
    unavailable_reason: available ? null : (unavailableReason ?? 'PROCESS_IDENTITY_INCOMPLETE'),
  };
}

/**
 * Read process identity. The default provider uses read-only Windows CIM to
 * obtain creation time/executable/entry; if it cannot, caller gets UNKNOWN.
 */
export async function readProcessIdentity(pid, { provider } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return {
      pid,
      alive: false,
      available: false,
      source: 'unavailable',
      created_at: null,
      exe_path: null,
      entry_path: null,
      unavailable_reason: 'INVALID_PID',
    };
  }
  if (typeof provider === 'function') {
    return normalizeIdentity(pid, await provider(pid));
  }
  return normalizeIdentity(pid, await windowsProcessIdentityProvider(pid));
}

/** Compare process identity records. Never infer SAME from pid+creation alone. */
export function sameProcess(a, b) {
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return { verdict: 'UNKNOWN', checks: { pid: 'UNKNOWN', created_at: 'UNKNOWN', exe: 'UNKNOWN', entry: 'UNKNOWN' }, reasons: ['MISSING_IDENTITY'] };
  }
  const checks = { pid: 'UNKNOWN', created_at: 'UNKNOWN', exe: 'UNKNOWN', entry: 'UNKNOWN' };
  const reasons = [];
  const missing = [];
  if (a.entry_unresolved === true || b.entry_unresolved === true) missing.push('ENTRY_PATH_UNRESOLVED');
  if (a.exe_unresolved === true || b.exe_unresolved === true) missing.push('EXE_PATH_UNRESOLVED');
  if (!Number.isInteger(a.pid) || !Number.isInteger(b.pid)) missing.push('PID_UNAVAILABLE');
  else if (a.pid !== b.pid) {
    checks.pid = 'DIFFERENT';
    return { verdict: 'DIFFERENT', checks, reasons: ['PID_DIFFERENT'] };
  } else checks.pid = 'SAME';

  const compareRequired = (left, right, key, label) => {
    if (typeof left !== 'string' || typeof right !== 'string') {
      missing.push(`${label}_UNAVAILABLE`);
      return;
    }
    if (key === 'created_at') {
      const same = sameCreation(left, right);
      if (same === null) {
        checks[key] = 'UNKNOWN';
        missing.push('CREATED_AT_INVALID');
        return;
      }
      checks[key] = same ? 'SAME' : 'DIFFERENT';
      if (!same) reasons.push(`${label}_DIFFERENT`);
      return;
    }
    const leftPath = normalizePath(left);
    const rightPath = normalizePath(right);
    if (leftPath === null || rightPath === null) {
      checks[key] = 'UNKNOWN';
      missing.push(label === 'ENTRY' ? 'ENTRY_PATH_UNRESOLVED' : 'EXE_PATH_UNRESOLVED');
      return;
    }
    const same = leftPath === rightPath;
    checks[key] = same ? 'SAME' : 'DIFFERENT';
    if (!same) reasons.push(`${label}_DIFFERENT`);
  };
  compareRequired(a.created_at, b.created_at, 'created_at', 'CREATED_AT');
  compareRequired(a.exe_path, b.exe_path, 'exe', 'EXE');
  compareRequired(a.entry_path, b.entry_path, 'entry', 'ENTRY');

  for (const reason of reasons) {
    if (reason.endsWith('_DIFFERENT')) return { verdict: 'DIFFERENT', checks, reasons: [...reasons, ...missing] };
  }
  if (missing.length > 0) return { verdict: 'UNKNOWN', checks, reasons: [...reasons, ...missing] };
  return { verdict: 'SAME', checks, reasons };
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch { /* best effort */ }
  }
}

export function readOwnerLock(file) {
  if (!fs.existsSync(file)) return { ok: false, code: 'LOCK_MISSING' };
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { ok: false, code: 'LOCK_INVALID' };
  }
  if (value === null || typeof value !== 'object' || typeof value.nonce !== 'string') {
    return { ok: false, code: 'LOCK_INVALID' };
  }
  return { ok: true, lock: value };
}

export function validateOwnerLock(lock) {
  const required = ['installation_id', 'instance_id', 'mode', 'owner_component', 'nonce'];
  for (const field of required) {
    if (typeof lock?.[field] !== 'string' || lock[field].length === 0) {
      throw new ProcessIdentityError('LOCK_INVALID', `owner lock field missing: ${field}`, { field });
    }
  }
  if (!Number.isInteger(lock.owner_epoch) || lock.owner_epoch < 1) {
    throw new ProcessIdentityError('LOCK_INVALID', 'owner_epoch must be a positive integer', { field: 'owner_epoch' });
  }
  if (lock.owner_process === null || typeof lock.owner_process !== 'object' || !Number.isInteger(lock.owner_process.pid)) {
    throw new ProcessIdentityError('LOCK_INVALID', 'owner_process.pid is required', { field: 'owner_process' });
  }
  return lock;
}

/** Acquire a new owner lock with exclusive create. Never modifies an existing lock. */
export async function acquireOwnerLock({ file, lock, now = Date.now(), ttlMs = DEFAULT_LEASE_MS }) {
  validateOwnerLock(lock);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const record = {
    ...lock,
    v: lock.v ?? 1,
    heartbeat_at: new Date(now).toISOString(),
    lease_expires_at: new Date(now + ttlMs).toISOString(),
  };
  let handle;
  try {
    handle = fs.openSync(file, 'wx', 0o600);
    fs.writeFileSync(handle, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    fs.fsyncSync(handle);
    return { ok: true, lock: record };
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const existing = readOwnerLock(file);
      return { ok: false, code: 'LOCK_HELD', existing: existing.ok ? existing.lock : undefined };
    }
    return { ok: false, code: 'LOCK_IO_ERROR', detail: String(error?.message ?? error) };
  } finally {
    if (handle !== undefined) {
      try { fs.closeSync(handle); } catch { /* best effort */ }
    }
  }
}

/** Refresh only the lock owned by this nonce. */
export function heartbeatOwnerLock({ file, nonce, now = Date.now(), ttlMs = DEFAULT_LEASE_MS }) {
  const existing = readOwnerLock(file);
  if (!existing.ok) return { ok: false, code: existing.code };
  if (existing.lock.nonce !== nonce) return { ok: false, code: 'LOCK_NONCE_MISMATCH' };
  const lock = {
    ...existing.lock,
    heartbeat_at: new Date(now).toISOString(),
    lease_expires_at: new Date(now + ttlMs).toISOString(),
  };
  atomicWrite(file, lock);
  return { ok: true, lock };
}

/** Remove only the lock owned by this nonce; stale finally blocks cannot delete a newer lock. */
export function releaseOwnerLock({ file, nonce }) {
  const existing = readOwnerLock(file);
  if (!existing.ok) return { ok: false, code: existing.code, released: false };
  if (existing.lock.nonce !== nonce) return { ok: false, code: 'LOCK_NONCE_MISMATCH', released: false };
  fs.rmSync(file, { force: true });
  return { ok: true, released: true };
}

/**
 * Determine owner health from identity and heartbeat. A stale lease is never
 * reason to take over or kill a still-matching live process.
 */
export async function isOwnerAlive({ lock, now = Date.now(), provider, ttlMs = DEFAULT_LEASE_MS } = {}) {
  if (lock === null || typeof lock !== 'object' || lock.owner_process === null || typeof lock.owner_process !== 'object' || !Number.isInteger(lock.owner_process.pid)) {
    return { status: 'UNKNOWN', same_process: 'UNKNOWN', heartbeat: 'UNKNOWN', identity: null, reason_codes: ['LOCK_INVALID'] };
  }
  const heartbeatMs = Date.parse(lock.heartbeat_at);
  const heartbeat = Number.isFinite(heartbeatMs)
    ? (now - heartbeatMs <= ttlMs ? 'FRESH' : 'STALE')
    : 'UNKNOWN';
  const expected = {
    ...lock.owner_process,
    exe_path: lock.owner_process.exe_path ?? lock.owner_process.exe_realpath,
    entry_path: lock.owner_process.entry_path ?? lock.owner_process.entry_realpath,
  };
  const hasCreationField = typeof expected.created_at === 'string' && expected.created_at.length > 0;
  const hasIdentity = hasCreationField && parseCreationInstant(expected.created_at) !== null;
  if (!hasIdentity) {
    return {
      status: 'UNKNOWN',
      same_process: 'UNKNOWN',
      heartbeat,
      identity: null,
      reason_codes: [hasCreationField ? 'LOCK_CREATION_INVALID' : 'LOCK_IDENTITY_MISSING'],
    };
  }
  const identity = await readProcessIdentity(lock.owner_process.pid, { provider });
  const comparison = sameProcess(identity, expected);
  const reasonCodes = [...comparison.reasons];
  if (heartbeat === 'STALE') reasonCodes.push('HEARTBEAT_STALE');
  if (heartbeat === 'UNKNOWN') reasonCodes.push('HEARTBEAT_UNKNOWN');

  if (identity.alive === false) {
    return { status: 'DEAD', same_process: comparison.verdict, heartbeat, identity, reason_codes: [...reasonCodes, 'PROCESS_NOT_FOUND'] };
  }
  if (comparison.verdict === 'DIFFERENT') {
    return { status: 'DEAD', same_process: 'DIFFERENT', heartbeat, identity, reason_codes: [...reasonCodes, 'PROCESS_IDENTITY_MISMATCH'] };
  }
  if (comparison.verdict !== 'SAME') {
    return { status: 'UNKNOWN', same_process: comparison.verdict, heartbeat, identity, reason_codes: [...reasonCodes, 'PROCESS_IDENTITY_UNKNOWN'] };
  }
  return {
    status: heartbeat === 'FRESH' ? 'ALIVE' : 'UNRESPONSIVE',
    same_process: 'SAME',
    heartbeat,
    identity,
    reason_codes: reasonCodes,
  };
}
