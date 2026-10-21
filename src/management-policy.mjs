// T5/A management safety and idempotency policy — isolated, not wired live.
//
// Safety requirements encoded here:
//   - a local approval file (human/host-owned) defines a bounded scope; a model
//     cannot mint authority by writing a flag, and declared origin/peer fields
//     never grant authority;
//   - project-directory allowlist with canonical realpath + junction/symlink
//     escape rejection;
//   - own-created or explicitly adopted IDs only (no arbitrary archives);
//   - persistent operation-ID ledger with replay idempotency and mismatch refusal
//     (management create idempotency, not native prompt requestId dedupe);
//   - conservative per-operation bounds: one workspace / up to three blank
//     sessions per explicit operation;
//   - creation remains separate from execution: this module never prompts.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_MAX_WORKSPACES_PER_OPERATION = 1;
export const DEFAULT_MAX_SESSIONS_PER_OPERATION = 3;
export const ALLOWED_MANAGEMENT_METHODS = Object.freeze(['create', 'list', 'delete', 'archiveSession', 'rename']);

export class ManagementPolicyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ManagementPolicyError';
    this.code = code;
    this.details = details;
  }
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) throw new ManagementPolicyError('policy-invalid-argument', `${field} must be a non-empty string`);
  return value;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function stableRequest(request) {
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    }
    return value;
  };
  return JSON.stringify(canonical(request ?? null));
}

/** Reject symlink/junction components in the lexical path below an allowlist root. */
function assertNoSymlinkComponents(absolutePath, root) {
  const relative = path.relative(root, absolutePath);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return;
  let current = root;
  for (const part of relative.split(path.sep)) {
    if (part.length === 0) continue;
    current = path.join(current, part);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      break; // leaf may not exist yet; existing ancestors were checked
    }
    if (stat.isSymbolicLink()) {
      throw new ManagementPolicyError('policy-unsafe-path', `symlink or junction component is not allowed: ${current}`);
    }
  }
}

function realpathSafe(target, { allowMissingLeaf = false } = {}) {
  try {
    return fs.realpathSync.native(target);
  } catch (error) {
    if (!allowMissingLeaf) throw error;
    const parent = fs.realpathSync.native(path.dirname(target));
    return path.join(parent, path.basename(target));
  }
}

/**
 * Resolve a target path inside the approval allowlist. Rejects relative paths,
 * traversal, junction/symlink components (including the leaf) and prefix escapes.
 * @returns {string} canonical absolute path
 */
export function resolveSafeTarget(candidatePath, { allowRoots } = {}) {
  const candidate = requireString(candidatePath, 'path');
  if (!Array.isArray(allowRoots) || allowRoots.length === 0) throw new ManagementPolicyError('policy-invalid-scope', 'allowRoots must be a non-empty array');
  if (candidate.includes('\u0000')) throw new ManagementPolicyError('policy-unsafe-path', 'path contains a null byte');
  if (!path.isAbsolute(candidate)) throw new ManagementPolicyError('policy-unsafe-path', 'path must be absolute');
  const roots = allowRoots.map((root) => realpathSafe(requireString(root, 'allowRoot')));
  const lexical = path.resolve(candidate);
  for (const root of roots) assertNoSymlinkComponents(lexical, root);
  const resolved = realpathSafe(candidate, { allowMissingLeaf: true });
  const inside = roots.some((root) => {
    const relative = path.relative(root, resolved);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
  if (!inside) throw new ManagementPolicyError('policy-path-outside-allowlist', 'path is outside the approved management allowlist', { resolved });

  // Walk resolved components too, so a link introduced between the lexical check
  // and realpath still cannot hide beneath the allowlist.
  for (const root of roots) {
    const relative = path.relative(root, resolved);
    if (relative === '') continue;
    let current = root;
    for (const part of relative.split(path.sep)) {
      if (part.length === 0) continue;
      current = path.join(current, part);
      let stat;
      try {
        stat = fs.lstatSync(current);
      } catch {
        break;
      }
      if (stat.isSymbolicLink()) {
        throw new ManagementPolicyError('policy-unsafe-path', `symlink or junction component is not allowed: ${current}`);
      }
    }
  }
  return resolved;
}

/** Load and validate a human/host-owned bounded approval scope. */
export function loadApproval(approvalFile, { now = Date.now } = {}) {
  const nowMs = typeof now === 'function' ? now() : Number(now);
  requireString(approvalFile, 'approvalFile');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(approvalFile, 'utf8'));
  } catch (error) {
    throw new ManagementPolicyError('policy-approval-missing', `approval file is missing or unreadable: ${approvalFile}`);
  }
  if (raw === null || typeof raw !== 'object') throw new ManagementPolicyError('policy-approval-invalid', 'approval file must be an object');
  if (raw.allowExecution !== false) {
    throw new ManagementPolicyError('policy-approval-invalid', 'approval must not enable autonomous execution; creation is separate from execution');
  }
  const approvalId = requireString(raw.approvalId, 'approvalId');
  const approvedBy = requireString(raw.approvedBy, 'approvedBy');
  const expiresAt = Number(raw.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) {
    throw new ManagementPolicyError('policy-approval-expired', 'approval scope is expired');
  }
  if (!Array.isArray(raw.allowRoots) || raw.allowRoots.length === 0) {
    throw new ManagementPolicyError('policy-approval-invalid', 'approval.allowRoots must be a non-empty array');
  }
  const maxWorkspacesPerOperation = Number(raw.maxWorkspacesPerOperation ?? DEFAULT_MAX_WORKSPACES_PER_OPERATION);
  const maxSessionsPerOperation = Number(raw.maxSessionsPerOperation ?? DEFAULT_MAX_SESSIONS_PER_OPERATION);
  if (!Number.isSafeInteger(maxWorkspacesPerOperation) || maxWorkspacesPerOperation < 1) {
    throw new ManagementPolicyError('policy-approval-invalid', 'maxWorkspacesPerOperation must be a positive integer');
  }
  if (!Number.isSafeInteger(maxSessionsPerOperation) || maxSessionsPerOperation < 1) {
    throw new ManagementPolicyError('policy-approval-invalid', 'maxSessionsPerOperation must be a positive integer');
  }
  return {
    approvalId,
    approvedBy,
    expiresAt,
    allowRoots: raw.allowRoots.map((root) => realpathSafe(requireString(root, 'allowRoots[]'))),
    maxWorkspacesPerOperation,
    maxSessionsPerOperation,
    allowExecution: false,
    // Declared provenance is recorded but never grants authority.
    declaredOrigin: typeof raw.declaredOrigin === 'string' ? raw.declaredOrigin : undefined,
    raw,
  };
}

/** Durable operation ledger: replay idempotency + mismatch refusal + ownership. */
export class OperationLedger {
  #file;
  #now;
  #state;

  constructor({ file, now = Date.now } = {}) {
    this.#file = requireString(file, 'file');
    this.#now = now;
    this.#state = this.#load();
  }

  #load() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.#file, 'utf8'));
    } catch {
      return { v: 1, operations: {}, createdWorkspaces: [], createdSessions: [], adopted: [] };
    }
    if (raw === null || typeof raw !== 'object' || raw.v !== 1) throw new ManagementPolicyError('policy-ledger-corrupt', 'unsupported or malformed operation ledger');
    return {
      v: 1,
      operations: raw.operations ?? {},
      createdWorkspaces: Array.isArray(raw.createdWorkspaces) ? raw.createdWorkspaces : [],
      createdSessions: Array.isArray(raw.createdSessions) ? raw.createdSessions : [],
      adopted: Array.isArray(raw.adopted) ? raw.adopted : [],
    };
  }

  #persist() {
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.#state, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, this.#file);
  }

  /** Begin an operation; replaying the same id+request returns the stored record. */
  begin({ operationId, kind, request, scopeId = 'default' } = {}) {
    const id = requireString(operationId, 'operationId');
    const opKind = requireString(kind, 'kind');
    if (!ALLOWED_MANAGEMENT_METHODS.includes(opKind)) {
      throw new ManagementPolicyError('policy-operation-not-allowed', `operation kind "${opKind}" is not a management create/list/delete/archive/rename kind`);
    }
    const requestHash = sha256(stableRequest({ kind: opKind, request, scopeId }));
    const existing = this.#state.operations[id];
    if (existing !== undefined) {
      if (existing.requestHash !== requestHash) {
        throw new ManagementPolicyError('policy-operation-mismatch', `operation "${id}" was already used with a different request`);
      }
      if (existing.status === 'pending') throw new ManagementPolicyError('policy-operation-in-progress', `operation "${id}" is still pending`);
      return { replay: true, record: existing };
    }
    const record = { operationId: id, kind: opKind, scopeId, requestHash, status: 'pending', createdAt: this.#now(), counts: { workspaces: 0, sessions: 0 } };
    this.#state.operations[id] = record;
    this.#persist();
    return { replay: false, record };
  }

  /**
   * Record a created ID against an operation and enforce per-operation creation
   * bounds (defaults: 1 workspace / 3 blank sessions).
   */
  noteCreated({ operationId, kind, id, scope } = {}) {
    const record = this.#record(operationId);
    const value = requireString(id, 'id');
    if (kind !== 'workspace' && kind !== 'session') throw new ManagementPolicyError('policy-invalid-argument', "kind must be 'workspace' or 'session'");
    record.counts = record.counts ?? { workspaces: 0, sessions: 0 };
    const key = kind === 'workspace' ? 'workspaces' : 'sessions';
    const nextCount = record.counts[key] + 1;
    this.assertCreateLimits({
      workspaces: kind === 'workspace' ? nextCount : record.counts.workspaces,
      sessions: kind === 'session' ? nextCount : record.counts.sessions,
      scope,
    });
    record.counts[key] = nextCount;
    if (kind === 'workspace') {
      if (!this.#state.createdWorkspaces.includes(value)) this.#state.createdWorkspaces.push(value);
    } else if (!this.#state.createdSessions.includes(value)) {
      this.#state.createdSessions.push(value);
    }
    this.#persist();
    return { operationId, kind, id: value, counts: { ...record.counts } };
  }

  complete({ operationId, result } = {}) {
    const record = this.#record(operationId);
    record.status = 'completed';
    record.completedAt = this.#now();
    record.result = result ?? null;
    this.#persist();
    return { ...record };
  }

  fail({ operationId, code = 'failed', message = '' } = {}) {
    const record = this.#record(operationId);
    record.status = 'failed';
    record.completedAt = this.#now();
    record.error = { code, message };
    this.#persist();
    return { ...record };
  }

  /** Record a workspace/session this policy created (ownership for later archive/delete). */
  recordCreated({ kind, id } = {}) {
    const value = requireString(id, 'id');
    if (kind === 'workspace') {
      if (!this.#state.createdWorkspaces.includes(value)) this.#state.createdWorkspaces.push(value);
    } else if (kind === 'session') {
      if (!this.#state.createdSessions.includes(value)) this.#state.createdSessions.push(value);
    } else {
      throw new ManagementPolicyError('policy-invalid-argument', "kind must be 'workspace' or 'session'");
    }
    this.#persist();
    return { kind, id: value };
  }

  /** Explicit adoption of an existing ID, requiring an approving identity. */
  adopt({ kind, id, approvedBy } = {}) {
    const value = requireString(id, 'id');
    const by = requireString(approvedBy, 'approvedBy');
    if (kind !== 'workspace' && kind !== 'session') throw new ManagementPolicyError('policy-invalid-argument', "kind must be 'workspace' or 'session'");
    this.#state.adopted.push({ kind, id: value, approvedBy: by, adoptedAt: this.#now() });
    this.#persist();
    return { kind, id: value, approvedBy: by };
  }

  assertOwned({ kind, id } = {}) {
    const value = requireString(id, 'id');
    if (kind === 'workspace' && this.#state.createdWorkspaces.includes(value)) return { kind, id: value, owned: true };
    if (kind === 'session' && this.#state.createdSessions.includes(value)) return { kind, id: value, owned: true };
    if (this.#state.adopted.some((entry) => entry.kind === kind && entry.id === value)) return { kind, id: value, owned: true, adopted: true };
    throw new ManagementPolicyError('policy-id-not-owned', `${kind} "${value}" was not created by this policy and was not explicitly adopted`);
  }

  /** Enforce the conservative per-operation creation bounds. */
  assertCreateLimits({ workspaces = 0, sessions = 0, scope } = {}) {
    const maxWorkspaces = Number(scope?.maxWorkspacesPerOperation ?? DEFAULT_MAX_WORKSPACES_PER_OPERATION);
    const maxSessions = Number(scope?.maxSessionsPerOperation ?? DEFAULT_MAX_SESSIONS_PER_OPERATION);
    if (!Number.isSafeInteger(workspaces) || workspaces < 0) throw new ManagementPolicyError('policy-invalid-argument', 'workspaces must be a non-negative integer');
    if (!Number.isSafeInteger(sessions) || sessions < 0) throw new ManagementPolicyError('policy-invalid-argument', 'sessions must be a non-negative integer');
    if (workspaces > maxWorkspaces) throw new ManagementPolicyError('policy-count-limit', `operation would create ${workspaces} workspaces (max ${maxWorkspaces})`);
    if (sessions > maxSessions) throw new ManagementPolicyError('policy-count-limit', `operation would create ${sessions} sessions (max ${maxSessions})`);
    return { workspaces, sessions, maxWorkspaces, maxSessions };
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.#state));
  }

  #record(operationId) {
    const id = requireString(operationId, 'operationId');
    const record = this.#state.operations[id];
    if (record === undefined) throw new ManagementPolicyError('policy-unknown-operation', `unknown operation "${id}"`);
    return record;
  }
}

/** Declared provenance is descriptive only; it never authorizes an operation. */
export function describeDeclaredOrigin(origin) {
  return Object.freeze({ declaredOrigin: typeof origin === 'string' ? origin : undefined, grantsAuthority: false });
}

/**
 * Assert that a management API surface only exposes non-executing methods.
 * Creation must never be coupled to prompt/execution here.
 */
export function assertNonExecutingApi(api) {
  if (api === null || typeof api !== 'object') throw new ManagementPolicyError('policy-invalid-api', 'management api must be an object');
  const forbidden = ['prompt', 'createUserMessage', 'followup', 'execute', 'run'];
  for (const name of forbidden) {
    if (typeof api[name] === 'function') throw new ManagementPolicyError('policy-execution-not-allowed', `management api exposes forbidden execution method "${name}"`);
  }
  const allowed = ALLOWED_MANAGEMENT_METHODS.filter((name) => typeof api[name] === 'function');
  if (allowed.length === 0) throw new ManagementPolicyError('policy-invalid-api', 'management api exposes no allowed methods');
  return { allowed };
}

