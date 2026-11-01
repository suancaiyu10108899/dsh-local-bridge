// DSH companion/bootstrap seam (isolated, side-effect-free planning).
//
// Contract source: private seam contract / v2 receiver integration. This module
// is the single place a DSH host/plugin startup (or an explicit CLI command)
// asks: "should the bridge companion be running for this existing installation,
// and if so, what exactly must happen?". It is wired into DSH plugin startup
// (`reason=DSH_START`) and the `companion start|status|stop` CLI; all writes are
// limited to bootstrap bookkeeping and it never creates a Hub token/runtime.
//
// Safety invariants (all enforced here, all covered by tests):
//
// 1. Existing installation/locator/runtime only. The runtime root comes from the
//    existing installation locator, or from an explicit isolated runtime for
//    dev/legacy runs. This module never creates a Hub token, Hub config, Hub
//    state, a pairing record or a second installation. It writes only small
//    bootstrap bookkeeping files under `<runtime_root>/companion/` (and the
//    existing `desired-state.json` stop/start signal returned by the A runtime).
// 2. Explicit stop wins. A persisted `explicit-stop.json` marker (and the
//    legacy `desired-state.json {desired_state:"STOPPED"}` signal) blocks
//    automatic startup. A DSH startup ensure NEVER clears it; only an explicit
//    start call (`ensureBootstrap({explicitStart:true})`, i.e. a CLI start) may
//    clear it.
// 3. One verified owner. A live/lease-unexpired/identity-placeholder owner is
//    attached and reused; it is never replaced or killed. UNKNOWN/UNRESPONSIVE
//    owner state, unreadable locks, ambiguous launch records and unverifiable
//    guards fail closed (review), never "pidAlive-only takeover".
// 4. One spawn per bootstrap. A short-lived exclusive guard file serializes
//    concurrent ensure calls in this runtime; a durable launch record lets later
//    startups attach to a verified companion that has not yet claimed the owner
//    lease instead of racing a duplicate spawn.
// 5. Finite budget. Spawn attempts are charged to the SAME persistent outer
//    budget the installer/launcher uses (`<runtime>/companion/outer-budget.json`,
//    3 starts / 10 minutes). A corrupt budget pauses; it is never reset here.
// 6. Data preservation. Stop only writes the explicit-stop marker and the
//    existing preferred desired state; it never deletes messages, ledgers,
//    tokens, configs or a stale owner lock (the companion's own recovery code
//    owns stale-lock archival).
// 7. DSH close must not stop the companion. `ensureBootstrap` spawns one
//    detached, stdio-ignored child and keeps no timer/hook that would act on
//    host exit.
//
// Public API (all async, all injected-probe friendly for tests):
//
//   planBootstrap(options)   -> read-only plan/facts (never writes)
//   ensureBootstrap(options) -> idempotent ensure; may spawn at most one child
//   stopBootstrap(options)   -> explicit stop: persist marker, verify stop
//   statusBootstrap(options) -> read-only plan + compact state/action summary
//   bootstrapPaths(runtimeRoot) -> all state file paths derived here
//
// Common options:
//   installationRoot    absolute locator root (default: defaultInstallationRoot)
//   runtimeDir          absolute explicit isolated runtime (dev/legacy only;
//                       conflicts with a bound installation runtime -> review)
//   env                 default process.env (a LAB_BRIDGE_RUNTIME_DIR that
//                       differs from the installation runtime is a conflict)
//   now                 clock injection, default Date.now
//   provider            process-identity provider, default Windows CIM reader
//   probeHub            optional async read-only Hub probe (state: SAME |
//                       ABSENT | UNREACHABLE | FOREIGN); FOREIGN -> review,
//                       SAME without an owner -> attach-only, never spawn
//   companionEntry      absolute companion entry override; default
//                       <installation.app_root>/companion/main.mjs
//   selfGuardNonce      internal: identifies the guard this ensure itself holds
//
// ensureBootstrap only adds:
//   explicitStart       default false; true is the explicit start (CLI) path
//   reason              companion --reason value, default MANUAL_START
//   nodeExecutable      absolute node path, default process.execPath
//   spawnProcess        injected spawn, default child_process.spawn
//   startTimeoutMs      finite owner-claim verification deadline (12s)
//   pollIntervalMs      verification poll interval (100ms)
//   sleep               injected sleep, default real setTimeout
//   leaseMs             owner-lease freshness window (30s)
//
// stopBootstrap only adds:
//   signalProcess       injected signal function, default process.kill
//   actor / reason      recorded in the explicit-stop marker
//   stopTimeoutMs       finite stop-verification deadline (10s)
//   pollIntervalMs / sleep
//
// Result shapes are documented next to the exports. Stable decision codes are
// exported in BOOTSTRAP_DECISIONS; callers should switch on `decision` /
// `outcome`, not on prose.
//
// Integration assumptions for the future wiring step (not done here):
//   - DSH plugin startup calls `ensureBootstrap()` once, fire-and-forget, and
//     treats `ok:false` as a logged/review state rather than failing host boot.
//   - An installed bundle contains `companion/main.mjs` under
//     `<installation.app_root>/companion/` (same layout the scheduler launcher
//     plan assumes); `nodeExecutable` is the host node binary.
//   - Explicit CLI start calls `ensureBootstrap({explicitStart:true})`; explicit
//     CLI stop calls `stopBootstrap()`. A plain ensure never resumes a stop.
//   - The companion itself still starts the Hub and only explicitly enabled
//     receivers; this module does not duplicate that logic.
//   - The outer budget file is deliberately shared with the installer/launcher;
//     changing its shape would break that shared accounting.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  defaultInstallationRoot,
  installationPaths,
  readInstallation,
  resolveRuntime,
} from './installation.mjs';
import { runtimePaths, writeJsonAtomic } from './runtime.mjs';
import { HUB_OWNER_LEASE_MS, inspectHubOwner } from './hub-owner.mjs';
import { readOwnerLock, readProcessIdentity, sameProcess } from './process-identity.mjs';
import {
  OUTER_BUDGET_MAX_ATTEMPTS,
  OUTER_BUDGET_WINDOW_MS,
  readOuterBudget,
  recordOuterAttempt,
} from './outer-budget.mjs';

export const BOOTSTRAP_SCHEMA_VERSION = 1;
export const PLAN_SCHEMA = 'companion-bootstrap-plan/1';
export const ENSURE_SCHEMA = 'companion-bootstrap-ensure/1';
export const STOP_SCHEMA = 'companion-bootstrap-stop/1';
export const STATUS_SCHEMA = 'companion-bootstrap-status/1';
export const EXPLICIT_STOP_SCHEMA = 'companion-bootstrap-explicit-stop/1';
export const GUARD_SCHEMA = 'companion-bootstrap-guard/1';
export const LAUNCH_SCHEMA = 'companion-bootstrap-launch/1';

export const COMPANION_OWNER_COMPONENT = 'companion';
export const DEFAULT_COMPANION_REASON = 'MANUAL_START';
export const DEFAULT_START_TIMEOUT_MS = 12_000;
export const DEFAULT_STOP_TIMEOUT_MS = 10_000;
export const DEFAULT_POLL_INTERVAL_MS = 100;

/** Stable plan decision codes. Callers may switch on these. */
export const BOOTSTRAP_DECISIONS = Object.freeze([
  // context
  'NO_INSTALLATION',
  'REVIEW_LOCATOR_INVALID',
  'REVIEW_RUNTIME_CONFLICT',
  'MODE_NOT_MANAGED',
  // explicit stop / desired state
  'PAUSED_EXPLICIT_STOP',
  'REVIEW_EXPLICIT_STOP_MARKER',
  'REVIEW_DESIRED_STATE',
  'CLEAR_EXPLICIT_STOP_ONLY',
  // reuse / in flight
  'ATTACH_VERIFIED_OWNER',
  'ATTACH_LAUNCH_PENDING',
  'ATTACH_EXISTING_HUB',
  'BOOTSTRAP_IN_FLIGHT',
  // owner/lock/launch review
  'REVIEW_OWNER_LOCK',
  'REVIEW_OWNER_LINEAGE',
  'REVIEW_OWNER_UNVERIFIED',
  'REVIEW_LAUNCH_RECORD',
  'REVIEW_BOOTSTRAP_GUARD',
  'REVIEW_HUB_INSTANCE_MISMATCH',
  'REVIEW_HUB_PROBE',
  // budget / entry / start
  'REVIEW_BUDGET_CORRUPT',
  'PAUSED_BUDGET_HALTED',
  'REVIEW_COMPANION_ENTRY',
  'START_COMPANION',
  // explicit stop execution
  'STOP_ALREADY_STOPPED',
  'STOP_WRITE_MARKER',
  'STOP_WRITE_MARKER_HEAL',
  'STOP_WRITE_MARKER_REVIEW_OWNER',
  'STOP_SIGNAL_VERIFIED_OWNER',
  'STOP_SIGNAL_VERIFIED_LAUNCH',
  'STOP_REVIEW_OWNER_LINEAGE',
  'STOP_REVIEW_MARKER_FOREIGN',
  'STOP_REVIEW_NO_RUNTIME',
]);

/** Stable status states returned by statusBootstrap(). */
export const BOOTSTRAP_STATUS_STATES = Object.freeze([
  'NOT_INSTALLED',
  'NOT_MANAGED',
  'STOPPED_EXPLICIT',
  'STOPPED_LEGACY',
  'OWNED_RUNNING',
  'START_PENDING',
  'HUB_EXTERNAL_RUNNING',
  'BUDGET_HALTED',
  'READY_TO_START',
  'NEEDS_REVIEW',
  'UNKNOWN',
]);

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function isNodeExecutable(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return false;
  const base = path.basename(file).toLowerCase();
  if (base !== 'node.exe' && base !== 'node') return false;
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

/** Resolve a verified Node.js executable, never an Electron host binary. */
export function resolveNodeExecutable({ env = process.env, nodeExecutable } = {}) {
  if (nodeExecutable !== undefined && nodeExecutable !== null) {
    return isNodeExecutable(nodeExecutable) ? path.resolve(nodeExecutable) : null;
  }
  const candidates = [
    env.LAB_BRIDGE_NODE_EXECUTABLE,
    process.execPath,
    'C:/Program Files/nodejs/node.exe',
    'C:/Program Files (x86)/nodejs/node.exe',
  ];
  for (const candidate of candidates) {
    if (isNodeExecutable(candidate)) return path.resolve(candidate);
  }
  return null;
}
function requireAbsolutePath(value, field) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${field} must be a non-empty string`);
  if (!path.isAbsolute(value)) throw new TypeError(`${field} must be an absolute path`);
  return path.resolve(value);
}

function normalizeComparePath(value) {
  let resolved;
  try {
    resolved = fs.realpathSync.native !== undefined ? fs.realpathSync.native(value) : fs.realpathSync(value);
  } catch {
    resolved = path.resolve(value);
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function sameFsPath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  if (!path.isAbsolute(left) || !path.isAbsolute(right)) return false;
  return normalizeComparePath(left) === normalizeComparePath(right);
}

function isPathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function iso(ms) {
  return new Date(ms).toISOString();
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function safeReadJson(file) {
  if (!fs.existsSync(file)) return { exists: false, ok: false, value: undefined };
  try {
    return { exists: true, ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (error) {
    return { exists: true, ok: false, value: undefined, error: String(error?.message ?? error) };
  }
}

/**
 * readProcessIdentity that never throws: a provider error means UNKNOWN, not
 * DEAD, and never a reason to take over or signal anything.
 */
async function safeReadIdentity(pid, provider) {
  try {
    return await readProcessIdentity(pid, { provider });
  } catch (error) {
    return {
      pid,
      alive: null,
      available: false,
      source: 'error',
      created_at: null,
      exe_path: null,
      entry_path: null,
      unavailable_reason: 'PROCESS_IDENTITY_PROVIDER_ERROR',
      error: String(error?.message ?? error),
    };
  }
}

function identityExpected(record) {
  return {
    pid: Number.isInteger(record.pid) ? record.pid : record.spawn_pid,
    created_at: record.created_at ?? null,
    exe_path: record.exe_path ?? null,
    entry_path: record.entry_path ?? null,
  };
}

function archiveFile(file, label, nowMs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const target = `${file}.${label}-${nowMs}-${crypto.randomBytes(4).toString('hex')}`;
  fs.renameSync(file, target);
  return target;
}

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

/**
 * All bootstrap state file paths for one explicit runtime root. Pure path
 * derivation; does not touch the filesystem.
 */
export function bootstrapPaths(runtimeRoot) {
  const resolved = requireAbsolutePath(runtimeRoot, 'runtimeRoot');
  const runtime = runtimePaths(resolved);
  const companionDir = path.join(resolved, 'companion');
  return {
    runtime_root: resolved,
    companion_dir: companionDir,
    explicit_stop_file: path.join(companionDir, 'explicit-stop.json'),
    bootstrap_guard_file: path.join(companionDir, 'bootstrap-guard.json'),
    launch_record_file: path.join(companionDir, 'bootstrap-launch.json'),
    budget_file: path.join(companionDir, 'outer-budget.json'),
    desired_state_file: path.join(resolved, 'desired-state.json'),
    hub_service_state_file: path.join(companionDir, 'hub-service-state.json'),
    hub_owner_lock_file: runtime.ownerLockFile,
    hub_token_file: runtime.tokenFile,
    hub_config_file: runtime.configFile,
    hub_state_file: runtime.stateFile,
    hub_events_file: runtime.eventsFile,
  };
}

/** Default installed companion entry for an installation record. */
export function defaultCompanionEntry(installation) {
  if (installation === null || typeof installation !== 'object') throw new TypeError('installation is required');
  return path.join(installation.app_root, 'companion', 'main.mjs');
}

// ---------------------------------------------------------------------------
// context resolution (installation / locator / runtime only)
// ---------------------------------------------------------------------------

function resolveBootstrapContext({ installationRoot, runtimeDir, env }) {
  const root = installationRoot === undefined || installationRoot === null
    ? path.resolve(defaultInstallationRoot({ env }))
    : requireAbsolutePath(installationRoot, 'installationRoot');
  const paths = installationPaths(root);
  const explicitRuntime = runtimeDir === undefined || runtimeDir === null
    ? null
    : requireAbsolutePath(runtimeDir, 'runtimeDir');
  const envOverride = typeof env?.LAB_BRIDGE_RUNTIME_DIR === 'string' && env.LAB_BRIDGE_RUNTIME_DIR.length > 0
    ? path.resolve(env.LAB_BRIDGE_RUNTIME_DIR)
    : null;

  let installation = null;
  try {
    installation = readInstallation({ root, env });
  } catch (error) {
    return {
      ok: false,
      error_code: 'REVIEW_LOCATOR_INVALID',
      error_message: `installation locator is invalid: ${String(error?.message ?? error)}`,
      installation_root: root,
      locator_path: paths.locator,
      runtime_root: explicitRuntime,
      runtime_source: explicitRuntime === null ? null : 'explicit-dev',
      installation: null,
      app_root: null,
      owner_mode: null,
      installation_id: null,
      instance_id: null,
      runtime_exists: explicitRuntime !== null && fs.existsSync(explicitRuntime),
      env_override: envOverride,
    };
  }

  if (installation === null) {
    if (explicitRuntime === null) {
      return {
        ok: false,
        error_code: 'NO_INSTALLATION',
        error_message: `no installation locator: ${paths.locator}`,
        installation_root: root,
        locator_path: paths.locator,
        runtime_root: null,
        runtime_source: null,
        installation: null,
        app_root: null,
        owner_mode: null,
        installation_id: null,
        instance_id: null,
        runtime_exists: false,
        env_override: envOverride,
      };
    }
    const explicit = resolveRuntime({ installation: null, explicit: explicitRuntime });
    return {
      ok: true,
      error_code: null,
      error_message: null,
      installation_root: root,
      locator_path: null,
      runtime_root: explicit.runtimeRoot,
      runtime_source: 'explicit-dev',
      installation: null,
      app_root: null,
      owner_mode: null,
      installation_id: null,
      instance_id: null,
      runtime_exists: fs.existsSync(explicit.runtimeRoot),
      env_override: envOverride,
    };
  }

  const runtimeRoot = path.resolve(installation.runtime_root);
  if (explicitRuntime !== null && path.resolve(explicitRuntime) !== runtimeRoot) {
    return {
      ok: false,
      error_code: 'REVIEW_RUNTIME_CONFLICT',
      error_message: 'explicit runtime conflicts with the bound installation instance',
      installation_root: root,
      locator_path: paths.locator,
      runtime_root: runtimeRoot,
      runtime_source: 'installation',
      installation,
      app_root: installation.app_root,
      owner_mode: installation.hub_owner_kind,
      installation_id: installation.installation_id,
      instance_id: installation.instance_id,
      runtime_exists: fs.existsSync(runtimeRoot),
      env_override: envOverride,
    };
  }
  if (envOverride !== null && envOverride !== runtimeRoot) {
    return {
      ok: false,
      error_code: 'REVIEW_RUNTIME_CONFLICT',
      error_message: 'LAB_BRIDGE_RUNTIME_DIR conflicts with the bound installation runtime',
      installation_root: root,
      locator_path: paths.locator,
      runtime_root: runtimeRoot,
      runtime_source: 'installation',
      installation,
      app_root: installation.app_root,
      owner_mode: installation.hub_owner_kind,
      installation_id: installation.installation_id,
      instance_id: installation.instance_id,
      runtime_exists: fs.existsSync(runtimeRoot),
      env_override: envOverride,
      env_override_matches: true,
    };
  }
  return {
    ok: true,
    error_code: null,
    error_message: null,
    installation_root: root,
    locator_path: paths.locator,
    runtime_root: runtimeRoot,
    runtime_source: 'installation',
    installation,
    app_root: installation.app_root,
    owner_mode: installation.hub_owner_kind,
    installation_id: installation.installation_id,
    instance_id: installation.instance_id,
    runtime_exists: fs.existsSync(runtimeRoot),
    env_override: envOverride,
    env_override_matches: envOverride !== null,
  };
}

// ---------------------------------------------------------------------------
// observed facts (read-only)
// ---------------------------------------------------------------------------

function readExplicitStop({ file, context }) {
  const read = safeReadJson(file);
  if (read.exists !== true) {
    return { present: false, valid: false, code: null, file, stopped_at: null, reason: null, actor: null };
  }
  const base = { present: true, valid: false, code: null, file, stopped_at: null, reason: null, actor: null };
  if (read.ok !== true) return { ...base, code: 'EXPLICIT_STOP_MARKER_CORRUPT', error: read.error };
  const value = read.value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ...base, code: 'EXPLICIT_STOP_MARKER_CORRUPT' };
  if (value.v !== BOOTSTRAP_SCHEMA_VERSION || value.explicit_stop !== true) return { ...base, code: 'EXPLICIT_STOP_MARKER_CORRUPT' };
  if (typeof value.stopped_at !== 'string' || !Number.isFinite(Date.parse(value.stopped_at))) return { ...base, code: 'EXPLICIT_STOP_MARKER_CORRUPT' };
  if (value.schema !== undefined && value.schema !== EXPLICIT_STOP_SCHEMA) return { ...base, code: 'EXPLICIT_STOP_MARKER_CORRUPT' };
  if (typeof value.runtime_root !== 'string' || !path.isAbsolute(value.runtime_root) || !sameFsPath(value.runtime_root, context.runtime_root)) {
    return { ...base, code: 'EXPLICIT_STOP_MARKER_FOREIGN' };
  }
  if (context.installation !== null) {
    if (typeof value.installation_id !== 'string' || value.installation_id.length === 0) {
      return { ...base, code: 'EXPLICIT_STOP_MARKER_AMBIGUOUS' };
    }
    if (value.installation_id !== context.installation.installation_id) return { ...base, code: 'EXPLICIT_STOP_MARKER_FOREIGN' };
    if (typeof value.instance_id === 'string' && value.instance_id !== context.installation.instance_id) {
      return { ...base, code: 'EXPLICIT_STOP_MARKER_FOREIGN' };
    }
  }
  return {
    present: true,
    valid: true,
    code: null,
    file,
    stopped_at: value.stopped_at,
    reason: typeof value.reason === 'string' ? value.reason : null,
    actor: typeof value.actor === 'string' ? value.actor : null,
    installation_id: typeof value.installation_id === 'string' ? value.installation_id : null,
    instance_id: typeof value.instance_id === 'string' ? value.instance_id : null,
  };
}

function readDesiredState(file) {
  const read = safeReadJson(file);
  if (read.exists !== true) return { present: false, state: 'MISSING', file };
  if (read.ok !== true) return { present: true, state: 'INVALID', file };
  const value = read.value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { present: true, state: 'INVALID', file };
  if (value.desired_state === 'STOPPED') return { present: true, state: 'STOPPED', file };
  if (value.desired_state === 'RUNNING' || value.desired_state === undefined) return { present: true, state: 'RUNNING', file };
  return { present: true, state: 'INVALID', file };
}

function ownerLineage(lock, context) {
  const ownerComponent = lock?.owner_component ?? null;
  const componentMatches = ownerComponent === COMPANION_OWNER_COMPONENT;
  const configPath = lock?.owner_process?.config_path ?? null;
  if (context.installation === null) {
    // Explicit isolated/dev runtime: only the component name is knowable.
    return {
      applicable: false,
      ok: componentMatches,
      component_matches: componentMatches,
      owner_component: ownerComponent,
    };
  }
  const installationMatches = lock?.installation_id === context.installation.installation_id;
  const instanceMatches = lock?.instance_id === context.installation.instance_id;
  const modeMatches = lock?.mode === context.owner_mode;
  const configMatches = typeof configPath === 'string' && path.isAbsolute(configPath) && context.locator_path !== null &&
    sameFsPath(configPath, context.locator_path);
  return {
    applicable: true,
    ok: componentMatches && installationMatches && instanceMatches && modeMatches && configMatches,
    component_matches: componentMatches,
    installation_matches: installationMatches,
    instance_matches: instanceMatches,
    mode_matches: modeMatches,
    config_matches: configMatches,
    owner_component: ownerComponent,
    mode: lock?.mode ?? null,
  };
}

async function observeOwner({ paths, context, provider, now, leaseMs }) {
  const file = paths.hub_owner_lock_file;
  const read = readOwnerLock(file);
  const empty = {
    present: false,
    valid: false,
    state: 'NONE',
    code: 'OWNER_LOCK_MISSING',
    file,
    owner_component: null,
    owner_pid: null,
    owner_epoch: null,
    heartbeat: null,
    same_process: 'UNKNOWN',
    lineage: null,
    lineage_ok: false,
    health_reasons: [],
  };
  if (read.ok !== true) {
    if (read.code === 'LOCK_INVALID') return { ...empty, present: true, valid: false, state: 'INVALID', code: 'OWNER_LOCK_INVALID' };
    return empty;
  }
  const lock = read.lock;
  let inspection;
  try {
    inspection = await inspectHubOwner({ runtimeDir: context.runtime_root, now, provider, ttlMs: leaseMs });
  } catch (error) {
    const lineage = ownerLineage(lock, context);
    return {
      present: true,
      valid: true,
      state: 'UNKNOWN',
      code: 'OWNER_PROVIDER_ERROR',
      file,
      owner_component: lock.owner_component ?? null,
      owner_pid: Number.isInteger(lock.owner_process?.pid) ? lock.owner_process.pid : null,
      owner_epoch: Number.isInteger(lock.owner_epoch) ? lock.owner_epoch : null,
      heartbeat: null,
      same_process: 'UNKNOWN',
      lineage,
      lineage_ok: lineage.ok === true,
      health_reasons: ['PROCESS_IDENTITY_PROVIDER_ERROR'],
      error: String(error?.message ?? error),
    };
  }
  const lineage = ownerLineage(lock, context);
  const state = inspection.ok === true ? inspection.state : 'UNKNOWN';
  return {
    present: true,
    valid: true,
    state,
    code: state === 'ALIVE' ? 'OWNER_ALIVE' : state === 'DEAD' ? 'OWNER_DEAD' : `OWNER_${state}`,
    file,
    owner_component: lock.owner_component ?? null,
    owner_pid: Number.isInteger(lock.owner_process?.pid) ? lock.owner_process.pid : null,
    owner_epoch: Number.isInteger(lock.owner_epoch) ? lock.owner_epoch : null,
    heartbeat: inspection.ok === true ? inspection.health?.heartbeat ?? null : null,
    same_process: inspection.ok === true ? inspection.health?.same_process ?? 'UNKNOWN' : 'UNKNOWN',
    lineage,
    lineage_ok: lineage.ok === true,
    health_reasons: inspection.ok === true ? [...(inspection.health?.reason_codes ?? [])] : [inspection.code ?? 'OWNER_LOCK_UNKNOWN'],
  };
}

function readLaunchRecord({ file, context }) {
  const read = safeReadJson(file);
  const base = { present: read.exists === true, valid: false, code: null, file, spawn_pid: null, spawned_at: null, last_result: null, alive_state: 'NONE' };
  if (read.exists !== true) return base;
  if (read.ok !== true) return { ...base, code: 'LAUNCH_RECORD_CORRUPT' };
  const value = read.value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ...base, code: 'LAUNCH_RECORD_CORRUPT' };
  if (value.v !== BOOTSTRAP_SCHEMA_VERSION) return { ...base, code: 'LAUNCH_RECORD_CORRUPT' };
  if (value.schema !== undefined && value.schema !== LAUNCH_SCHEMA) return { ...base, code: 'LAUNCH_RECORD_CORRUPT' };
  if (!Number.isInteger(value.spawn_pid) || value.spawn_pid <= 0) return { ...base, code: 'LAUNCH_RECORD_CORRUPT' };
  if (typeof value.runtime_root !== 'string' || !path.isAbsolute(value.runtime_root) || !sameFsPath(value.runtime_root, context.runtime_root)) {
    return { ...base, code: 'LAUNCH_RECORD_FOREIGN' };
  }
  if (context.installation !== null && value.installation_id !== context.installation.installation_id) {
    return { ...base, code: 'LAUNCH_RECORD_FOREIGN' };
  }
  return {
    present: true,
    valid: true,
    code: null,
    file,
    spawn_pid: value.spawn_pid,
    spawned_at: typeof value.spawned_at === 'string' ? value.spawned_at : null,
    last_result: typeof value.last_result === 'string' ? value.last_result : null,
    nonce: typeof value.nonce === 'string' ? value.nonce : null,
    installation_id: typeof value.installation_id === 'string' ? value.installation_id : null,
    instance_id: typeof value.instance_id === 'string' ? value.instance_id : null,
    created_at: typeof value.created_at === 'string' ? value.created_at : null,
    exe_path: typeof value.exe_path === 'string' ? value.exe_path : null,
    entry_path: typeof value.entry_path === 'string' ? value.entry_path : null,
    companion_entry: typeof value.companion_entry === 'string' ? value.companion_entry : null,
    reason: typeof value.reason === 'string' ? value.reason : null,
    alive_state: 'UNKNOWN',
  };
}

async function launchAliveState(record, provider) {
  if (record.present !== true || record.valid !== true) return 'NONE';
  const identity = await safeReadIdentity(record.spawn_pid, provider);
  if (identity.alive === false && identity.unavailable_reason === 'PROCESS_NOT_FOUND') return 'DEAD';
  if (identity.alive === true && identity.available === true) {
    const comparison = sameProcess(identity, identityExpected(record));
    if (comparison.verdict === 'SAME') return 'ALIVE';
    if (comparison.verdict === 'DIFFERENT') return 'DEAD'; // pid was reused; old child is gone
  }
  return 'UNKNOWN';
}

function readGuardRecord({ file, context }) {
  const read = safeReadJson(file);
  const base = { present: read.exists === true, valid: false, code: null, file, nonce: null, pid: null, holder_alive: 'NONE' };
  if (read.exists !== true) return base;
  if (read.ok !== true) return { ...base, code: 'BOOTSTRAP_GUARD_CORRUPT' };
  const value = read.value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ...base, code: 'BOOTSTRAP_GUARD_CORRUPT' };
  if (value.v !== BOOTSTRAP_SCHEMA_VERSION) return { ...base, code: 'BOOTSTRAP_GUARD_CORRUPT' };
  if (value.schema !== undefined && value.schema !== GUARD_SCHEMA) return { ...base, code: 'BOOTSTRAP_GUARD_CORRUPT' };
  if (typeof value.nonce !== 'string' || value.nonce.length === 0) return { ...base, code: 'BOOTSTRAP_GUARD_CORRUPT' };
  if (!Number.isInteger(value.pid) || value.pid <= 0) return { ...base, code: 'BOOTSTRAP_GUARD_CORRUPT' };
  if (typeof value.runtime_root === 'string' && path.isAbsolute(value.runtime_root) && !sameFsPath(value.runtime_root, context.runtime_root)) {
    return { ...base, code: 'BOOTSTRAP_GUARD_FOREIGN' };
  }
  return {
    present: true,
    valid: true,
    code: null,
    file,
    nonce: value.nonce,
    pid: value.pid,
    started_at: typeof value.started_at === 'string' ? value.started_at : null,
    runtime_root: typeof value.runtime_root === 'string' ? value.runtime_root : null,
    installation_id: typeof value.installation_id === 'string' ? value.installation_id : null,
    instance_id: typeof value.instance_id === 'string' ? value.instance_id : null,
    created_at: typeof value.created_at === 'string' ? value.created_at : null,
    exe_path: typeof value.exe_path === 'string' ? value.exe_path : null,
    entry_path: typeof value.entry_path === 'string' ? value.entry_path : null,
    holder_alive: 'UNKNOWN',
  };
}

async function guardHolderState(record, provider, ownPid = process.pid) {
  if (record.valid !== true) return 'UNKNOWN';
  // A guard owned by the current process is a concurrent bootstrap in this
  // same host, not a stale file: never archive or duplicate it.
  if (record.pid === ownPid) return 'ALIVE';
  const identity = await safeReadIdentity(record.pid, provider);
  if (identity.alive === false && identity.unavailable_reason === 'PROCESS_NOT_FOUND') return 'DEAD';
  if (identity.alive === true && identity.available === true) {
    const comparison = sameProcess(identity, identityExpected(record));
    if (comparison.verdict === 'SAME') return 'ALIVE';
    if (comparison.verdict === 'DIFFERENT') return 'DEAD'; // bootstrap pid was reused; file is stale
  }
  return 'UNKNOWN';
}

function readBudgetFacts({ file, now }) {
  const empty = {
    present: false,
    corrupt: false,
    halted: false,
    attempts_total: 0,
    attempts_in_window: 0,
    max_attempts: OUTER_BUDGET_MAX_ATTEMPTS,
    window_ms: OUTER_BUDGET_WINDOW_MS,
    file,
  };
  if (!fs.existsSync(file)) return empty;
  try {
    const value = readOuterBudget(file);
    const cutoff = now - OUTER_BUDGET_WINDOW_MS;
    const recent = value.attempts.filter((stamp) => Date.parse(stamp) > cutoff);
    return {
      present: true,
      corrupt: false,
      halted: recent.length >= OUTER_BUDGET_MAX_ATTEMPTS,
      attempts_total: value.attempts.length,
      attempts_in_window: recent.length,
      max_attempts: OUTER_BUDGET_MAX_ATTEMPTS,
      window_ms: OUTER_BUDGET_WINDOW_MS,
      file,
    };
  } catch (error) {
    return {
      ...empty,
      present: true,
      corrupt: true,
      code: error?.code ?? 'OUTER_BUDGET_CORRUPT',
      error: String(error?.message ?? error),
    };
  }
}

function readServiceFacts(file) {
  const read = safeReadJson(file);
  if (read.exists !== true) return { present: false, valid: false, file, state: null };
  if (read.ok !== true || read.value === null || typeof read.value !== 'object' || Array.isArray(read.value)) {
    return { present: true, valid: false, code: 'SERVICE_STATE_CORRUPT', file, state: null };
  }
  const value = read.value;
  return {
    present: true,
    valid: true,
    file,
    component: typeof value.component === 'string' ? value.component : null,
    state: typeof value.state === 'string' ? value.state : null,
    pid: Number.isInteger(value.pid) ? value.pid : null,
    reason_code: typeof value.reason_code === 'string' ? value.reason_code : null,
    last_heartbeat_at: typeof value.last_heartbeat_at === 'string' ? value.last_heartbeat_at : null,
  };
}

function runtimeFilePresence({ paths }) {
  const exists = (file) => {
    try { return fs.existsSync(file); } catch { return false; }
  };
  return {
    token: exists(paths.hub_token_file),
    config: exists(paths.hub_config_file),
    state: exists(paths.hub_state_file),
    events: exists(paths.hub_events_file),
    memberships_dir: exists(path.join(paths.runtime_root, 'memberships')),
  };
}

function companionEntryFacts({ companionEntry, context }) {
  let file = companionEntry;
  if (file === undefined || file === null) {
    if (context.installation === null) return { ok: false, code: 'COMPANION_ENTRY_UNRESOLVED', file: null };
    file = defaultCompanionEntry(context.installation);
  }
  file = requireAbsolutePath(file, 'companionEntry');
  if (context.installation !== null && !isPathInside(context.app_root, file)) {
    return { ok: false, code: 'COMPANION_ENTRY_OUTSIDE_INSTALLATION', file };
  }
  if (!fs.existsSync(file)) return { ok: false, code: 'COMPANION_ENTRY_MISSING', file };
  let isFile = false;
  try { isFile = fs.statSync(file).isFile(); } catch { isFile = false; }
  if (!isFile) return { ok: false, code: 'COMPANION_ENTRY_NOT_FILE', file };
  try { fs.accessSync(file, fs.constants.R_OK); } catch { return { ok: false, code: 'COMPANION_ENTRY_NOT_READABLE', file }; }
  return { ok: true, code: null, file };
}

async function probeHubFacts({ probeHub, context, env }) {
  if (typeof probeHub !== 'function') return null;
  try {
    const result = await probeHub({ runtimeDir: context.runtime_root, installation: context.installation, env });
    const state = typeof result?.state === 'string' ? result.state : 'UNKNOWN';
    return { state, code: typeof result?.code === 'string' ? result.code : null };
  } catch (error) {
    return { state: 'PROBE_ERROR', code: error?.code ?? 'HUB_PROBE_FAILED', error: String(error?.message ?? error) };
  }
}

// ---------------------------------------------------------------------------
// plan options and decisions
// ---------------------------------------------------------------------------

function normalizePlanOptions(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('options must be an object');
  const env = options.env === undefined ? process.env : options.env;
  if (env === null || typeof env !== 'object') throw new TypeError('env must be an object');
  if (options.now !== undefined && typeof options.now !== 'function') throw new TypeError('now must be a function');
  if (options.provider !== undefined && typeof options.provider !== 'function') throw new TypeError('provider must be a function');
  if (options.probeHub !== undefined && typeof options.probeHub !== 'function') throw new TypeError('probeHub must be a function');
  if (options.explicitStart !== undefined && typeof options.explicitStart !== 'boolean') throw new TypeError('explicitStart must be a boolean');
  if (options.leaseMs !== undefined && (!Number.isFinite(options.leaseMs) || options.leaseMs <= 0)) throw new TypeError('leaseMs must be a positive number');
  return {
    installationRoot: options.installationRoot,
    runtimeDir: options.runtimeDir,
    env,
    now: options.now ?? Date.now,
    provider: options.provider,
    probeHub: options.probeHub,
    companionEntry: options.companionEntry,
    explicitStart: options.explicitStart === true,
    selfGuardNonce: typeof options.selfGuardNonce === 'string' && options.selfGuardNonce.length > 0 ? options.selfGuardNonce : null,
    leaseMs: options.leaseMs ?? HUB_OWNER_LEASE_MS,
  };
}

function ensureDecision({ decision, reason_code = decision, explanation, ok = false, review_required = false, paused = false, in_flight = false, will_spawn = false, will_attach = false, will_clear_explicit_stop = false }) {
  return {
    decision,
    reason_code,
    explanation,
    ok: ok === true,
    review_required: review_required === true,
    paused: paused === true,
    in_flight: in_flight === true,
    will_spawn: will_spawn === true,
    will_attach: will_attach === true,
    will_clear_explicit_stop: will_clear_explicit_stop === true,
  };
}

function stopDecision({ decision, reason_code = decision, explanation, ok = false, review_required = false, already_stopped = false, will_write_explicit_stop = false, will_heal_stop_marker = false, will_write_desired_state = false, will_signal = false, signal_pid = null }) {
  return {
    decision,
    reason_code,
    explanation,
    ok: ok === true,
    review_required: review_required === true,
    already_stopped: already_stopped === true,
    will_write_explicit_stop: will_write_explicit_stop === true,
    will_heal_stop_marker: will_heal_stop_marker === true,
    will_write_desired_state: will_write_desired_state === true,
    will_signal: will_signal === true,
    signal_pid: Number.isInteger(signal_pid) ? signal_pid : null,
  };
}

function computeEnsureDecision({ context, observed, explicitStart }) {
  if (context.ok !== true) {
    if (context.error_code === 'NO_INSTALLATION') {
      return ensureDecision({ decision: 'NO_INSTALLATION', ok: true, paused: true, reason_code: 'NO_INSTALLATION', explanation: 'no installation locator and no explicit isolated runtime; nothing to start' });
    }
    return ensureDecision({ decision: context.error_code, review_required: true, reason_code: context.error_code, explanation: context.error_message });
  }
  const marker = observed.explicit_stop;
  if (marker.present === true && marker.valid !== true) {
    return ensureDecision({ decision: 'REVIEW_EXPLICIT_STOP_MARKER', review_required: true, reason_code: marker.code, explanation: `explicit-stop marker is not usable (${marker.code}); explicit operator review required` });
  }
  const markerActive = marker.present === true && marker.valid === true;
  const desired = observed.desired_state;
  if (desired.state === 'INVALID') {
    return ensureDecision({ decision: 'REVIEW_DESIRED_STATE', review_required: true, reason_code: 'DESIRED_STATE_INVALID', explanation: 'desired-state.json is ambiguous/corrupt; refusing to guess RUNNING vs STOPPED' });
  }
  if (markerActive === true && explicitStart !== true) {
    return ensureDecision({ decision: 'PAUSED_EXPLICIT_STOP', ok: true, paused: true, reason_code: 'EXPLICIT_STOP_ACTIVE', explanation: 'an explicit stop is persisted; DSH startup must not auto-resume it (explicit start required)' });
  }
  if (desired.state === 'STOPPED' && explicitStart !== true) {
    return ensureDecision({ decision: 'PAUSED_EXPLICIT_STOP', ok: true, paused: true, reason_code: 'DESIRED_STATE_STOPPED', explanation: 'preferred desired state is STOPPED; DSH startup must not auto-resume it (explicit start required)' });
  }

  const owner = observed.owner;
  const ownerAlive = owner.present === true && owner.valid === true && owner.state === 'ALIVE' && owner.lineage_ok === true;
  if (context.installation !== null && context.owner_mode !== 'COMPANION_OWNED') {
    if (ownerAlive) {
      return ensureDecision({ decision: 'ATTACH_VERIFIED_OWNER', ok: true, will_attach: true, reason_code: 'OWNER_ALIVE', explanation: 'a verified companion owner already exists; attach/reuse it without spawning' });
    }
    return ensureDecision({ decision: 'MODE_NOT_MANAGED', ok: true, paused: true, reason_code: `HUB_OWNER_KIND_${context.owner_mode}`, explanation: `owner mode ${context.owner_mode} does not grant the companion bootstrap spawning rights` });
  }

  if (owner.present === true && owner.valid !== true) {
    return ensureDecision({ decision: 'REVIEW_OWNER_LOCK', review_required: true, reason_code: owner.code, explanation: 'owner lock file exists but is unreadable; refusing pidAlive-only takeover' });
  }
  if (owner.present === true) {
    if (owner.lineage_ok !== true) {
      return ensureDecision({ decision: 'REVIEW_OWNER_LINEAGE', review_required: true, reason_code: 'OWNER_LINEAGE_MISMATCH', explanation: 'owner lock belongs to a different installation/instance/mode; no takeover' });
    }
    if (owner.state === 'ALIVE') {
      return ensureDecision({ decision: 'ATTACH_VERIFIED_OWNER', ok: true, will_attach: true, reason_code: 'OWNER_ALIVE', explanation: 'verified companion owner is alive; attach/reuse without spawning' });
    }
    if (owner.state === 'UNRESPONSIVE' || owner.state === 'UNKNOWN') {
      return ensureDecision({ decision: 'REVIEW_OWNER_UNVERIFIED', review_required: true, reason_code: owner.code, explanation: 'owner identity/heartbeat is UNRESPONSIVE/UNKNOWN; never take over or spawn a duplicate from this state' });
    }
    // DEAD (provably) may fall through to a bounded start; the stale lock is
    // archived by the companion's own recovery path, not by this module.
  } else {
    const launch = observed.launch_record;
    if (launch.present === true && launch.valid !== true) {
      return ensureDecision({ decision: 'REVIEW_LAUNCH_RECORD', review_required: true, reason_code: launch.code, explanation: 'launch record is unreadable/foreign; refusing to guess whether a companion is starting' });
    }
    if (launch.present === true && launch.alive_state === 'ALIVE') {
      return ensureDecision({ decision: 'ATTACH_LAUNCH_PENDING', ok: true, will_attach: true, reason_code: 'LAUNCH_PENDING', explanation: 'a previously bootstrapped companion is verified alive but has not claimed the owner lease yet; attach instead of spawning' });
    }
    if (launch.present === true && launch.alive_state === 'UNKNOWN') {
      return ensureDecision({ decision: 'REVIEW_LAUNCH_RECORD', review_required: true, reason_code: 'LAUNCH_IDENTITY_UNVERIFIED', explanation: 'launch record process identity is UNKNOWN; refusing pidAlive-only duplicate decision' });
    }
  }

  const guard = observed.guard;
  if (guard.present === true) {
    if (guard.valid !== true) {
      return ensureDecision({ decision: 'REVIEW_BOOTSTRAP_GUARD', review_required: true, reason_code: guard.code, explanation: 'bootstrap guard is unreadable/foreign; refusing to archive or duplicate' });
    }
    if (guard.holder_alive === 'ALIVE') {
      return ensureDecision({ decision: 'BOOTSTRAP_IN_FLIGHT', ok: true, in_flight: true, reason_code: 'BOOTSTRAP_IN_FLIGHT', explanation: 'another bootstrap call holds a verified live guard; do not spawn a second companion' });
    }
    if (guard.holder_alive === 'UNKNOWN') {
      return ensureDecision({ decision: 'REVIEW_BOOTSTRAP_GUARD', review_required: true, reason_code: 'BOOTSTRAP_GUARD_HOLDER_UNVERIFIED', explanation: 'bootstrap guard holder identity is UNKNOWN; refusing to archive or spawn' });
    }
    // DEAD / SELF may proceed; ensure() archives a dead guard before spawning.
  }

  const probe = observed.hub_probe;
  if (probe !== null) {
    if (probe.state === 'FOREIGN') {
      return ensureDecision({ decision: 'REVIEW_HUB_INSTANCE_MISMATCH', review_required: true, reason_code: 'HUB_INSTANCE_MISMATCH', explanation: 'Hub at the runtime endpoint is a different installation/instance; no spawn' });
    }
    if (probe.state === 'PROBE_ERROR') {
      return ensureDecision({ decision: 'REVIEW_HUB_PROBE', review_required: true, reason_code: probe.code, explanation: 'Hub probe failed; ambiguous Hub state pauses startup' });
    }
    if (probe.state === 'SAME' && owner.present !== true) {
      return ensureDecision({ decision: 'ATTACH_EXISTING_HUB', ok: true, will_attach: true, reason_code: 'HUB_ALREADY_RUNNING', explanation: 'same-instance Hub is already serving this runtime; attach without spawning a companion' });
    }
  }

  if (context.installation === null) {
    if (explicitStart === true && markerActive === true) {
      return ensureDecision({ decision: 'CLEAR_EXPLICIT_STOP_ONLY', ok: true, will_clear_explicit_stop: true, reason_code: 'EXPLICIT_START_DEV_RUNTIME', explanation: 'explicit isolated runtime has no installation; only clear the explicit-stop marker/desired state, never spawn' });
    }
    return ensureDecision({ decision: 'NO_INSTALLATION', ok: true, paused: true, reason_code: 'NO_INSTALLATION', explanation: 'explicit isolated runtime without an installation locator; bootstrap never spawns here' });
  }

  const budget = observed.budget;
  if (budget.corrupt === true) {
    return ensureDecision({ decision: 'REVIEW_BUDGET_CORRUPT', review_required: true, reason_code: budget.code ?? 'OUTER_BUDGET_CORRUPT', explanation: 'persistent outer start budget is corrupt; fail closed (explicit reset required)' });
  }
  if (budget.halted === true) {
    return ensureDecision({ decision: 'PAUSED_BUDGET_HALTED', ok: true, paused: true, reason_code: 'OUTER_BUDGET_HALTED', explanation: 'finite outer start budget is exhausted for this window; no spawn until the window passes or an explicit reset' });
  }
  if (observed.companion_entry.ok !== true) {
    return ensureDecision({ decision: 'REVIEW_COMPANION_ENTRY', review_required: true, reason_code: observed.companion_entry.code, explanation: 'companion entry is missing/outside the installation/unreadable' });
  }
  return ensureDecision({
    decision: 'START_COMPANION',
    ok: true,
    will_spawn: true,
    will_clear_explicit_stop: (markerActive === true && explicitStart === true) || desired.state === 'STOPPED',
    reason_code: 'NO_VERIFIED_OWNER',
    explanation: 'no verified owner/launch/guard/hub; one bounded companion spawn is permitted',
  });
}

function computeStopDecision({ context, observed }) {
  if (context.ok !== true) {
    if (context.error_code === 'NO_INSTALLATION') {
      return stopDecision({ decision: 'STOP_REVIEW_NO_RUNTIME', review_required: true, reason_code: 'NO_INSTALLATION', explanation: 'no installation locator and no explicit runtime to stop' });
    }
    return stopDecision({ decision: context.error_code, review_required: true, reason_code: context.error_code, explanation: context.error_message });
  }
  if (context.runtime_source === 'explicit-dev' && context.runtime_exists !== true) {
    return stopDecision({ decision: 'STOP_REVIEW_NO_RUNTIME', review_required: true, reason_code: 'RUNTIME_MISSING', explanation: 'explicit isolated runtime does not exist; refusing to initialize one' });
  }
  if (context.installation !== null && context.owner_mode !== 'COMPANION_OWNED') {
    return stopDecision({ decision: 'MODE_NOT_MANAGED', reason_code: `HUB_OWNER_KIND_${context.owner_mode}`, explanation: `owner mode ${context.owner_mode} is not managed by the companion bootstrap; stop does nothing` });
  }

  const marker = observed.explicit_stop;
  if (marker.present === true && marker.valid !== true && marker.code === 'EXPLICIT_STOP_MARKER_FOREIGN') {
    return stopDecision({ decision: 'STOP_REVIEW_MARKER_FOREIGN', review_required: true, reason_code: marker.code, explanation: 'explicit-stop marker belongs to another runtime/installation; refusing to overwrite it or signal a process' });
  }
  const markerValid = marker.present === true && marker.valid === true;
  const healMarker = marker.present === true && marker.valid !== true;
  const willWriteMarker = markerValid !== true;
  const desired = observed.desired_state;
  const willWriteDesired = desired.state === 'MISSING' || desired.state === 'RUNNING';

  const owner = observed.owner;
  const launch = observed.launch_record;
  const ownerLive = owner.present === true && owner.valid === true && owner.lineage_ok === true && owner.state === 'ALIVE';
  const ownerUnreadable = owner.present === true && owner.valid !== true;
  const ownerLineageMismatch = owner.present === true && owner.valid === true && owner.lineage_ok !== true;
  const ownerAmbiguous = owner.present === true && owner.valid === true && owner.lineage_ok === true &&
    (owner.state === 'UNRESPONSIVE' || owner.state === 'UNKNOWN');
  const launchLive = launch.present === true && launch.valid === true && launch.alive_state === 'ALIVE';
  const launchAmbiguous = launch.present === true && (launch.valid !== true || launch.alive_state === 'UNKNOWN');

  if (ownerUnreadable === true) {
    return stopDecision({
      decision: 'STOP_WRITE_MARKER_REVIEW_OWNER',
      ok: true,
      review_required: true,
      will_write_explicit_stop: willWriteMarker,
      will_heal_stop_marker: healMarker,
      will_write_desired_state: willWriteDesired,
      reason_code: owner.code ?? 'OWNER_LOCK_INVALID',
      explanation: 'owner lock is unreadable; persist stop intent but never pidAlive-only signal or takeover',
    });
  }
  if (ownerLive === true) {
    return stopDecision({
      decision: 'STOP_SIGNAL_VERIFIED_OWNER',
      ok: true,
      will_write_explicit_stop: willWriteMarker,
      will_heal_stop_marker: healMarker,
      will_write_desired_state: willWriteDesired,
      will_signal: true,
      signal_pid: owner.owner_pid,
      reason_code: 'VERIFIED_OWNER_ALIVE',
      explanation: 'verified companion owner is alive; persist explicit stop and signal only after re-verifying identity',
    });
  }
  if (ownerLineageMismatch === true) {
    return stopDecision({
      decision: 'STOP_REVIEW_OWNER_LINEAGE',
      ok: true,
      review_required: true,
      will_write_explicit_stop: willWriteMarker,
      will_heal_stop_marker: healMarker,
      will_write_desired_state: willWriteDesired,
      reason_code: 'OWNER_LINEAGE_MISMATCH',
      explanation: 'owner lock lineage does not match this installation; persist stop intent but never signal that process',
    });
  }
  if (ownerAmbiguous === true) {
    return stopDecision({
      decision: 'STOP_WRITE_MARKER_REVIEW_OWNER',
      ok: true,
      review_required: true,
      will_write_explicit_stop: willWriteMarker,
      will_heal_stop_marker: healMarker,
      will_write_desired_state: willWriteDesired,
      reason_code: owner.code,
      explanation: 'owner state is UNRESPONSIVE/UNKNOWN; persist stop intent but never pidAlive-only signal',
    });
  }
  if (launchLive === true) {
    return stopDecision({
      decision: 'STOP_SIGNAL_VERIFIED_LAUNCH',
      ok: true,
      will_write_explicit_stop: willWriteMarker,
      will_heal_stop_marker: healMarker,
      will_write_desired_state: willWriteDesired,
      will_signal: true,
      signal_pid: launch.spawn_pid,
      reason_code: 'VERIFIED_LAUNCH_ALIVE',
      explanation: 'a verified bootstrapped companion launch is alive; persist explicit stop and signal that verified pid',
    });
  }
  if (launchAmbiguous === true) {
    return stopDecision({
      decision: 'STOP_WRITE_MARKER_REVIEW_OWNER',
      ok: true,
      review_required: true,
      will_write_explicit_stop: willWriteMarker,
      will_heal_stop_marker: healMarker,
      will_write_desired_state: willWriteDesired,
      reason_code: launch.code ?? 'LAUNCH_IDENTITY_UNVERIFIED',
      explanation: 'launch record identity is UNKNOWN; persist stop intent but do not signal',
    });
  }
  if (healMarker === true) {
    return stopDecision({
      decision: 'STOP_WRITE_MARKER_HEAL',
      ok: true,
      will_write_explicit_stop: true,
      will_heal_stop_marker: true,
      will_write_desired_state: willWriteDesired,
      reason_code: 'EXPLICIT_STOP_MARKER_CORRUPT',
      explanation: 'archive the corrupt explicit-stop marker, then persist a valid one; nothing verified alive to signal',
    });
  }
  if (willWriteMarker === true) {
    return stopDecision({
      decision: 'STOP_WRITE_MARKER',
      ok: true,
      will_write_explicit_stop: true,
      will_write_desired_state: willWriteDesired,
      reason_code: 'NOTHING_VERIFIED_ALIVE',
      explanation: 'no verified live companion/launch; persist explicit stop so future DSH startup cannot auto-resume',
    });
  }
  return stopDecision({
    decision: 'STOP_ALREADY_STOPPED',
    ok: true,
    already_stopped: true,
    reason_code: 'EXPLICIT_STOP_ALREADY_PERSISTED',
    explanation: 'explicit stop is already persisted and nothing verified is alive; idempotent no-op',
  });
}

// ---------------------------------------------------------------------------
// planBootstrap
// ---------------------------------------------------------------------------

/**
 * Build a deterministic, read-only plan. Never writes, never spawns, never
 * signals, never clears a marker. All fields are plain JSON-able facts.
 *
 * @returns {Promise<{schema: string, read_only: true, generated_at: string,
 *   context: object, observed: object, decisions: {ensure: object, stop: object},
 *   companion_entry: object, notes: string[]}>}
 */
export async function planBootstrap(options = {}) {
  const opts = normalizePlanOptions(options);
  const context = resolveBootstrapContext(opts);
  const now = opts.now();

  if (context.ok !== true) {
    const basePaths = context.runtime_root === null ? null : bootstrapPaths(context.runtime_root);
    const emptyObserved = {
      explicit_stop: { present: false, valid: false, code: null, file: null },
      desired_state: { present: false, state: 'MISSING', file: null },
      owner: { present: false, valid: false, state: 'NONE', code: null, lineage_ok: false },
      launch_record: { present: false, valid: false, code: null, alive_state: 'NONE' },
      guard: { present: false, valid: false, code: null, holder_alive: 'NONE' },
      budget: { present: false, corrupt: false, halted: false, attempts_in_window: 0, max_attempts: OUTER_BUDGET_MAX_ATTEMPTS, window_ms: OUTER_BUDGET_WINDOW_MS },
      service_state: { present: false, valid: false, state: null },
      hub_probe: null,
      runtime_files: basePaths === null ? { token: false, config: false, state: false, events: false, memberships_dir: false } : runtimeFilePresence({ paths: basePaths }),
    };
    const observed = { ...emptyObserved, companion_entry: { ok: false, code: context.error_code, file: null } };
    return {
      schema: PLAN_SCHEMA,
      read_only: true,
      generated_at: iso(now),
      context: { ...context, runtime_paths: basePaths },
      observed,
      companion_entry: observed.companion_entry,
      decisions: {
        ensure: computeEnsureDecision({ context, observed, explicitStart: opts.explicitStart }),
        stop: computeStopDecision({ context, observed }),
      },
      notes: ['context could not be resolved; no read/write of the runtime was attempted beyond locator resolution'],
    };
  }

  const paths = bootstrapPaths(context.runtime_root);
  const observed = {
    explicit_stop: readExplicitStop({ file: paths.explicit_stop_file, context }),
    desired_state: readDesiredState(paths.desired_state_file),
    owner: await observeOwner({ paths, context, provider: opts.provider, now, leaseMs: opts.leaseMs }),
    launch_record: readLaunchRecord({ file: paths.launch_record_file, context }),
    guard: readGuardRecord({ file: paths.bootstrap_guard_file, context }),
    budget: readBudgetFacts({ file: paths.budget_file, now }),
    service_state: readServiceFacts(paths.hub_service_state_file),
    hub_probe: await probeHubFacts({ probeHub: opts.probeHub, context, env: opts.env }),
    runtime_files: runtimeFilePresence({ paths }),
  };
  observed.launch_record.alive_state = await launchAliveState(observed.launch_record, opts.provider);
  if (observed.guard.present === true) {
    if (opts.selfGuardNonce !== null && observed.guard.valid === true && observed.guard.nonce === opts.selfGuardNonce) {
      observed.guard.holder_alive = 'SELF';
    } else if (observed.guard.valid === true) {
      observed.guard.holder_alive = await guardHolderState(observed.guard, opts.provider);
    } else {
      observed.guard.holder_alive = 'UNKNOWN';
    }
  }
  const entry = companionEntryFacts({ companionEntry: opts.companionEntry, context });
  observed.companion_entry = entry;

  const decisions = {
    ensure: computeEnsureDecision({ context, observed, explicitStart: opts.explicitStart }),
    stop: computeStopDecision({ context, observed }),
  };
  const notes = [];
  if (context.installation !== null && context.runtime_exists !== true) {
    notes.push('installation runtime_root does not exist yet; a start creates only the canonical runtime directory (never a second runtime/token)');
  }
  if (context.runtime_source === 'explicit-dev') {
    notes.push('explicit isolated runtime (no installation locator): attach/stop only; this module never spawns here');
  }
  if (observed.owner.present === true && observed.owner.state === 'DEAD') {
    notes.push('a provably dead owner lock is present; the companion recovery path owns stale-lock archival, not the bootstrap');
  }
  if (observed.launch_record.present === true) notes.push('a durable launch record exists; it prevents racing a duplicate spawn before the owner lease is claimed');
  if (observed.guard.present === true) notes.push('a bootstrap guard is present; concurrent ensures never spawn a second companion');
  return {
    schema: PLAN_SCHEMA,
    read_only: true,
    generated_at: iso(now),
    context,
    observed,
    companion_entry: entry,
    decisions,
    notes,
  };
}

// ---------------------------------------------------------------------------
// ensure helpers
// ---------------------------------------------------------------------------

function buildExplicitStopMarker({ context, nowMs, actor, reason }) {
  return {
    v: BOOTSTRAP_SCHEMA_VERSION,
    schema: EXPLICIT_STOP_SCHEMA,
    explicit_stop: true,
    stopped_at: iso(nowMs),
    actor: typeof actor === 'string' && actor.length > 0 ? actor : 'cli',
    reason: typeof reason === 'string' ? reason : null,
    installation_id: context.installation === null ? null : context.installation.installation_id,
    instance_id: context.installation === null ? null : context.installation.instance_id,
    runtime_root: context.runtime_root,
  };
}

function buildGuardRecord({ context, nonce, nowMs, identity }) {
  return {
    v: BOOTSTRAP_SCHEMA_VERSION,
    schema: GUARD_SCHEMA,
    nonce,
    pid: process.pid,
    created_at: identity?.created_at ?? null,
    exe_path: identity?.exe_path ?? null,
    entry_path: identity?.entry_path ?? null,
    started_at: iso(nowMs),
    runtime_root: context.runtime_root,
    installation_id: context.installation === null ? null : context.installation.installation_id,
    instance_id: context.installation === null ? null : context.installation.instance_id,
  };
}

async function acquireBootstrapGuard({ paths, context, provider, nowMs }) {
  const nonce = crypto.randomUUID();
  const identity = await safeReadIdentity(process.pid, provider);
  const record = buildGuardRecord({ context, nonce, nowMs, identity });
  fs.mkdirSync(path.dirname(paths.bootstrap_guard_file), { recursive: true });
  const write = () => {
    const handle = fs.openSync(paths.bootstrap_guard_file, 'wx', 0o600);
    try {
      fs.writeFileSync(handle, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      fs.fsyncSync(handle);
    } finally {
      try { fs.closeSync(handle); } catch { /* best effort */ }
    }
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      write();
      return { ok: true, nonce, record };
    } catch (error) {
      if (error?.code !== 'EEXIST') return { ok: false, code: 'BOOTSTRAP_GUARD_WRITE_FAILED', error: String(error?.message ?? error) };
      const existing = readGuardRecord({ file: paths.bootstrap_guard_file, context });
      if (existing.valid !== true) return { ok: false, code: 'REVIEW_BOOTSTRAP_GUARD', detail: existing.code };
      if (existing.nonce === nonce) return { ok: true, nonce, record, reused: true };
      const holder = await guardHolderState(existing, provider);
      if (holder === 'ALIVE') return { ok: false, code: 'BOOTSTRAP_IN_FLIGHT' };
      if (holder === 'DEAD') {
        try {
          archiveFile(paths.bootstrap_guard_file, 'stale', nowMs);
        } catch (archiveError) {
          return { ok: false, code: 'REVIEW_BOOTSTRAP_GUARD', detail: String(archiveError?.message ?? archiveError) };
        }
        continue;
      }
      return { ok: false, code: 'REVIEW_BOOTSTRAP_GUARD', detail: 'BOOTSTRAP_GUARD_HOLDER_UNVERIFIED' };
    }
  }
  return { ok: false, code: 'REVIEW_BOOTSTRAP_GUARD', detail: 'BOOTSTRAP_GUARD_RETRY_EXHAUSTED' };
}

function releaseBootstrapGuard({ paths, nonce }) {
  try {
    const read = safeReadJson(paths.bootstrap_guard_file);
    if (read.ok === true && read.value?.nonce === nonce) fs.rmSync(paths.bootstrap_guard_file, { force: true });
  } catch { /* best effort */ }
}

function writeDesiredStateFile({ file, desired, nowMs }) {
  const read = safeReadJson(file);
  if (read.exists === true) {
    if (read.ok !== true || read.value === null || typeof read.value !== 'object' || Array.isArray(read.value)) {
      return { written: false, code: 'DESIRED_STATE_CORRUPT' };
    }
    if (read.value.desired_state === desired) return { written: false, already: true };
    writeJsonAtomic(file, { ...read.value, desired_state: desired });
    return { written: true };
  }
  writeJsonAtomic(file, { desired_state: desired, updated_at: iso(nowMs) });
  return { written: true };
}

function ensureResultFromPlan(plan, overrides = {}) {
  const ensure = plan.decisions.ensure;
  const observed = plan.observed;
  const outcomeMap = {
    ATTACH_VERIFIED_OWNER: 'ATTACHED_VERIFIED_OWNER',
    ATTACH_LAUNCH_PENDING: 'ATTACHED_LAUNCH_PENDING',
    ATTACH_EXISTING_HUB: 'ATTACHED_EXISTING_HUB',
    BOOTSTRAP_IN_FLIGHT: 'IN_FLIGHT',
    PAUSED_EXPLICIT_STOP: 'PAUSED',
    PAUSED_BUDGET_HALTED: 'PAUSED',
    MODE_NOT_MANAGED: 'NO_ACTION',
    NO_INSTALLATION: 'NO_ACTION',
    CLEAR_EXPLICIT_STOP_ONLY: 'EXPLICIT_STOP_CLEARED',
  };
  const budget = observed.budget ?? {};
  return {
    schema: ENSURE_SCHEMA,
    ok: ensure.ok === true && ensure.review_required !== true,
    outcome: ensure.review_required === true ? 'REVIEW' : (outcomeMap[ensure.decision] ?? 'NO_ACTION'),
    decision: ensure.decision,
    reason_code: ensure.reason_code,
    explanation: ensure.explanation,
    started: false,
    reused: ensure.will_attach === true,
    attached: ensure.will_attach === true,
    pending_owner: ensure.decision === 'ATTACH_LAUNCH_PENDING',
    in_flight: ensure.decision === 'BOOTSTRAP_IN_FLIGHT',
    paused: ensure.paused === true,
    review_required: ensure.review_required === true,
    spawn_pid: null,
    spawn_verified: false,
    owner_verified: false,
    owner_pid: observed.owner?.owner_pid ?? null,
    explicit_stop_active: observed.explicit_stop?.present === true && observed.explicit_stop?.valid === true,
    explicit_stop_cleared: false,
    desired_state_resumed: false,
    spawn_calls: 0,
    budget: {
      file: budget.file ?? null,
      present: budget.present === true,
      corrupt: budget.corrupt === true,
      halted: budget.halted === true,
      attempts_in_window: budget.attempts_in_window ?? 0,
      max_attempts: budget.max_attempts ?? OUTER_BUDGET_MAX_ATTEMPTS,
      window_ms: budget.window_ms ?? OUTER_BUDGET_WINDOW_MS,
    },
    runtime: {
      runtime_root: plan.context.runtime_root ?? null,
      runtime_source: plan.context.runtime_source ?? null,
      installation_id: plan.context.installation_id ?? null,
      instance_id: plan.context.instance_id ?? null,
      owner_mode: plan.context.owner_mode ?? null,
    },
    error: null,
    plan,
    ...overrides,
  };
}

function normalizeEnsureOptions(options = {}) {
  const base = normalizePlanOptions(options);
  if (options.nodeExecutable !== undefined && options.nodeExecutable !== null) requireAbsolutePath(options.nodeExecutable, 'nodeExecutable');
  if (options.spawnProcess !== undefined && typeof options.spawnProcess !== 'function') throw new TypeError('spawnProcess must be a function');
  if (options.sleep !== undefined && typeof options.sleep !== 'function') throw new TypeError('sleep must be a function');
  for (const [field, value] of [['startTimeoutMs', options.startTimeoutMs], ['pollIntervalMs', options.pollIntervalMs]]) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new TypeError(`${field} must be a positive number`);
  }
  if (options.reason !== undefined && (typeof options.reason !== 'string' || options.reason.length === 0)) {
    throw new TypeError('reason must be a non-empty string');
  }
  return {
    ...base,
    nodeExecutable: resolveNodeExecutable({ env: options.env ?? process.env, nodeExecutable: options.nodeExecutable }),
    spawnProcess: options.spawnProcess ?? spawn,
    reason: options.reason ?? DEFAULT_COMPANION_REASON,
    startTimeoutMs: options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    sleep: options.sleep ?? defaultSleep,
  };
}

function planOptionsFromEnsure(options) {
  return {
    installationRoot: options.installationRoot,
    runtimeDir: options.runtimeDir,
    env: options.env,
    now: options.now,
    provider: options.provider,
    probeHub: options.probeHub,
    companionEntry: options.companionEntry,
    explicitStart: options.explicitStart,
    selfGuardNonce: options.selfGuardNonce,
    leaseMs: options.leaseMs,
  };
}

// ---------------------------------------------------------------------------
// ensureBootstrap
// ---------------------------------------------------------------------------

/**
 * Idempotent startup ensure. May write bootstrap bookkeeping and spawn at most
 * one detached companion. Never clears an explicit stop unless
 * `explicitStart:true`, and never takes over an unverified owner.
 *
 * Outcomes (result.outcome): ATTACHED_VERIFIED_OWNER | ATTACHED_LAUNCH_PENDING |
 * ATTACHED_EXISTING_HUB | IN_FLIGHT | STARTED_OWNER_VERIFIED |
 * STARTED_OWNER_UNCONFIRMED | START_FAILED | PAUSED | REVIEW | NO_ACTION |
 * EXPLICIT_STOP_CLEARED.
 */
export async function ensureBootstrap(options = {}) {
  const opts = normalizeEnsureOptions(options);
  if (opts.nodeExecutable === null) {
    return {
      schema: ENSURE_SCHEMA, ok: false, outcome: 'REVIEW', decision: 'REVIEW_NODE_EXECUTABLE',
      reason_code: 'NODE_EXECUTABLE_UNRESOLVED',
      explanation: 'no verified node executable; set LAB_BRIDGE_NODE_EXECUTABLE or install a supported Node.js',
      started: false, review_required: true, spawn_calls: 0, node_executable: null,
    };
  }
  const planOptions = planOptionsFromEnsure(opts);
  let plan = await planBootstrap(planOptions);
  if (plan.decisions.ensure.decision !== 'START_COMPANION') {
    const result = ensureResultFromPlan(plan);
    if (plan.decisions.ensure.decision === 'CLEAR_EXPLICIT_STOP_ONLY' && plan.decisions.ensure.will_clear_explicit_stop === true) {
      return ensureClearExplicitStopOnly({ context: plan.context, observed: plan.observed, plan, result, nowMs: opts.now() });
    }
    return result;
  }

  const paths = bootstrapPaths(plan.context.runtime_root);
  const guard = await acquireBootstrapGuard({ paths, context: plan.context, provider: opts.provider, nowMs: opts.now() });
  if (guard.ok !== true) {
    if (guard.code === 'BOOTSTRAP_IN_FLIGHT') {
      return ensureResultFromPlan(plan, { outcome: 'IN_FLIGHT', in_flight: true, ok: true });
    }
    return ensureResultFromPlan(plan, { ok: false, outcome: 'REVIEW', decision: 'REVIEW_BOOTSTRAP_GUARD', reason_code: guard.code, review_required: true, error: { code: guard.code, message: guard.detail ?? null } });
  }

  try {
    plan = await planBootstrap({ ...planOptions, selfGuardNonce: guard.nonce });
    const decision = plan.decisions.ensure;
    if (decision.decision !== 'START_COMPANION') {
      // Someone appeared while we were acquiring the guard; reuse/attach.
      return ensureResultFromPlan(plan, { guard_acquired: true });
    }
    // Charge the finite outer budget before any spawn attempt.
    let budgetRecord;
    try {
      budgetRecord = recordOuterAttempt({
        file: paths.budget_file,
        now: opts.now(),
        windowMs: OUTER_BUDGET_WINDOW_MS,
        maxAttempts: OUTER_BUDGET_MAX_ATTEMPTS,
      });
    } catch (error) {
      return ensureResultFromPlan(plan, {
        ok: false, outcome: 'REVIEW', decision: 'REVIEW_BUDGET_CORRUPT', reason_code: 'OUTER_BUDGET_WRITE_FAILED', review_required: true, guard_acquired: true,
        error: { code: 'OUTER_BUDGET_WRITE_FAILED', message: String(error?.message ?? error) },
      });
    }
    if (budgetRecord.ok !== true) {
      const code = budgetRecord.code ?? 'OUTER_BUDGET_HALTED';
      return ensureResultFromPlan(plan, {
        ok: true,
        outcome: 'PAUSED',
        decision: code === 'OUTER_BUDGET_CORRUPT' ? 'REVIEW_BUDGET_CORRUPT' : 'PAUSED_BUDGET_HALTED',
        reason_code: code,
        paused: code !== 'OUTER_BUDGET_CORRUPT',
        review_required: code === 'OUTER_BUDGET_CORRUPT',
        guard_acquired: true,
        budget: { ...plan.observed.budget, attempts_in_window: budgetRecord.attempts ?? 0, halted: budgetRecord.halted === true },
      });
    }

    // Explicit-start only: clear the persisted stop before starting.
    let explicitStopCleared = false;
    let desiredStateResumed = false;
    if (decision.will_clear_explicit_stop === true) {
      if (plan.observed.explicit_stop.valid === true) {
        try {
          fs.rmSync(paths.explicit_stop_file, { force: true });
          explicitStopCleared = true;
        } catch (error) {
          return ensureResultFromPlan(plan, {
            ok: false, outcome: 'REVIEW', decision: 'REVIEW_EXPLICIT_STOP_MARKER', reason_code: 'EXPLICIT_STOP_MARKER_CLEAR_FAILED', review_required: true, guard_acquired: true,
            error: { code: 'EXPLICIT_STOP_MARKER_CLEAR_FAILED', message: String(error?.message ?? error) },
          });
        }
      }
      if (plan.observed.desired_state.state === 'STOPPED') {
        const resumed = writeDesiredStateFile({ file: paths.desired_state_file, desired: 'RUNNING', nowMs: opts.now() });
        if (resumed.code === 'DESIRED_STATE_CORRUPT') {
          return ensureResultFromPlan(plan, {
            ok: false, outcome: 'REVIEW', decision: 'REVIEW_DESIRED_STATE', reason_code: 'DESIRED_STATE_CORRUPT', review_required: true, guard_acquired: true,
          });
        }
        desiredStateResumed = resumed.written === true;
      }
    }

    // Exactly one spawn attempt, charged to the budget above.
    const spawnEnv = { ...opts.env, LAB_BRIDGE_INSTALLATION_ROOT: plan.context.installation_root, LAB_BRIDGE_RUNTIME_DIR: plan.context.runtime_root };
    delete spawnEnv.CODEX_THREAD_ID;
    const args = [plan.companion_entry.file, '--installation', plan.context.installation_root, '--reason', opts.reason];
    let child;
    let spawnCalls = 0;
    try {
      spawnCalls = 1;
      child = opts.spawnProcess(opts.nodeExecutable, args, {
        cwd: path.dirname(plan.companion_entry.file),
        env: spawnEnv,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (error) {
      return ensureResultFromPlan(plan, {
        ok: false, outcome: 'START_FAILED', decision: 'REVIEW_COMPANION_ENTRY', reason_code: 'COMPANION_SPAWN_FAILED', review_required: false, guard_acquired: true, spawn_calls: spawnCalls,
        error: { code: 'COMPANION_SPAWN_FAILED', message: String(error?.message ?? error) },
      });
    }
    if (child === null || typeof child !== 'object' || !Number.isInteger(child.pid) || child.pid <= 0) {
      return ensureResultFromPlan(plan, {
        ok: false, outcome: 'START_FAILED', reason_code: 'COMPANION_SPAWN_FAILED', guard_acquired: true, spawn_calls: spawnCalls,
        error: { code: 'COMPANION_SPAWN_FAILED', message: 'spawn did not return a child pid' },
      });
    }
    const exitInfo = { code: null, signal: null, at: null };
    try {
      if (typeof child.once === 'function') {
        child.once('exit', (code, signal) => {
          exitInfo.code = code ?? null;
          exitInfo.signal = signal ?? null;
          exitInfo.at = iso(opts.now());
        });
      }
    } catch { /* listener is best effort */ }
    try { if (typeof child.unref === 'function') child.unref(); } catch { /* detached is best effort */ }

    // Verify the spawned process identity before recording/trusting it.
    const launched = await safeReadIdentity(child.pid, opts.provider);
    if (launched.alive === false && launched.unavailable_reason === 'PROCESS_NOT_FOUND') {
      return ensureResultFromPlan(plan, {
        ok: false, outcome: 'START_FAILED', reason_code: 'COMPANION_CHILD_EXITED', guard_acquired: true, spawn_calls: spawnCalls, spawn_pid: child.pid,
        error: { code: 'COMPANION_CHILD_EXITED', message: null },
      });
    }
    const launchedVerified = launched.alive === true && launched.available === true;
    const launchRecord = {
      v: BOOTSTRAP_SCHEMA_VERSION,
      schema: LAUNCH_SCHEMA,
      nonce: crypto.randomUUID(),
      spawned_at: iso(opts.now()),
      runtime_root: plan.context.runtime_root,
      installation_id: plan.context.installation_id,
      instance_id: plan.context.instance_id,
      companion_entry: plan.companion_entry.file,
      spawn_pid: child.pid,
      created_at: launchedVerified === true ? launched.created_at : null,
      exe_path: launchedVerified === true ? launched.exe_path : null,
      entry_path: launchedVerified === true ? launched.entry_path : null,
      reason: opts.reason,
      host_pid: process.pid,
      last_result: launchedVerified === true ? 'STARTING' : 'START_UNVERIFIED',
    };
    let launchRecordWritten = false;
    try {
      writeJsonAtomic(paths.launch_record_file, launchRecord);
      launchRecordWritten = true;
    } catch (error) {
      return ensureResultFromPlan(plan, {
        ok: false, outcome: 'REVIEW', decision: 'REVIEW_LAUNCH_RECORD', reason_code: 'LAUNCH_RECORD_WRITE_FAILED', review_required: true, guard_acquired: true, spawn_calls: spawnCalls, spawn_pid: child.pid,
        error: { code: 'LAUNCH_RECORD_WRITE_FAILED', message: String(error?.message ?? error) },
      });
    }
    if (launchedVerified !== true) {
      return ensureResultFromPlan(plan, {
        ok: false, outcome: 'STARTED_OWNER_UNCONFIRMED', reason_code: 'SPAWN_IDENTITY_UNVERIFIED', review_required: true, guard_acquired: true, spawn_calls: spawnCalls, spawn_pid: child.pid,
        started: true, launch_record_written: launchRecordWritten,
      });
    }

    // Bounded owner-claim verification (finite loop even with a static clock).
    const maxPolls = Math.max(1, Math.ceil(opts.startTimeoutMs / opts.pollIntervalMs));
    let lastOwner = plan.observed.owner;
    for (let attempt = 0; attempt < maxPolls; attempt += 1) {
      const owner = await observeOwner({ paths, context: plan.context, provider: opts.provider, now: opts.now(), leaseMs: opts.leaseMs });
      lastOwner = owner;
      if (owner.present === true && owner.valid === true && owner.lineage_ok === true && owner.state === 'ALIVE') {
        try {
          writeJsonAtomic(paths.launch_record_file, { ...launchRecord, last_result: 'OWNER_VERIFIED', owner_pid: owner.owner_pid });
        } catch { /* the verified owner is the source of truth */ }
        return ensureResultFromPlan(plan, {
          ok: true, outcome: 'STARTED_OWNER_VERIFIED', reason_code: 'OWNER_VERIFIED', guard_acquired: true, launch_record_written: true,
          started: true, spawn_calls: spawnCalls, spawn_pid: child.pid, spawn_verified: true, owner_verified: true, owner_pid: owner.owner_pid,
          explicit_stop_cleared: explicitStopCleared, desired_state_resumed: desiredStateResumed,
          budget: { ...plan.observed.budget, attempts_in_window: budgetRecord.attempts },
        });
      }
      const current = await safeReadIdentity(child.pid, opts.provider);
      if (current.alive === false && current.unavailable_reason === 'PROCESS_NOT_FOUND') {
        try { writeJsonAtomic(paths.launch_record_file, { ...launchRecord, last_result: 'CHILD_EXITED' }); } catch { /* best effort */ }
        return ensureResultFromPlan(plan, {
          ok: false, outcome: 'START_FAILED', reason_code: 'COMPANION_CHILD_EXITED', guard_acquired: true, launch_record_written: true,
          started: true, spawn_calls: spawnCalls, spawn_pid: child.pid, explicit_stop_cleared: explicitStopCleared, desired_state_resumed: desiredStateResumed,
          budget: { ...plan.observed.budget, attempts_in_window: budgetRecord.attempts },
          error: { code: 'COMPANION_CHILD_EXITED', message: exitInfo.at === null ? null : `child exited (${exitInfo.code ?? exitInfo.signal})` },
        });
      }
      if (current.available === true && current.alive === true && sameProcess(current, identityExpected(launchRecord)).verdict === 'DIFFERENT') {
        return ensureResultFromPlan(plan, {
          ok: false, outcome: 'REVIEW', reason_code: 'SPAWN_IDENTITY_CHANGED', review_required: true, guard_acquired: true, launch_record_written: true,
          started: true, spawn_calls: spawnCalls, spawn_pid: child.pid,
          error: { code: 'SPAWN_IDENTITY_CHANGED', message: 'spawned pid identity changed while waiting for owner verification' },
        });
      }
      if (attempt < maxPolls - 1) await opts.sleep(opts.pollIntervalMs);
    }
    try { writeJsonAtomic(paths.launch_record_file, { ...launchRecord, last_result: 'OWNER_UNCONFIRMED' }); } catch { /* best effort */ }
    return ensureResultFromPlan(plan, {
      ok: false, outcome: 'STARTED_OWNER_UNCONFIRMED', reason_code: 'OWNER_UNCONFIRMED', review_required: true, guard_acquired: true, launch_record_written: true,
      started: true, spawn_calls: spawnCalls, spawn_pid: child.pid, spawn_verified: true,
      explicit_stop_cleared: explicitStopCleared, desired_state_resumed: desiredStateResumed,
      owner_pid: lastOwner?.owner_pid ?? null,
      budget: { ...plan.observed.budget, attempts_in_window: budgetRecord.attempts },
    });
  } catch (error) {
    return ensureResultFromPlan(plan, {
      ok: false, outcome: 'REVIEW', reason_code: 'BOOTSTRAP_INTERNAL_ERROR', review_required: true, guard_acquired: true,
      error: { code: 'BOOTSTRAP_INTERNAL_ERROR', message: String(error?.message ?? error) },
    });
  } finally {
    releaseBootstrapGuard({ paths, nonce: guard.nonce });
  }
}

async function ensureClearExplicitStopOnly({ context, observed, plan, result, nowMs }) {
  // Explicit isolated-dev start: clear marker/desired only, never spawn.
  const paths = bootstrapPaths(context.runtime_root);
  const out = { ...result, ok: true, outcome: 'EXPLICIT_STOP_CLEARED', decision: 'CLEAR_EXPLICIT_STOP_ONLY', review_required: false, explicit_stop_cleared: false, desired_state_resumed: false };
  try {
    if (observed.explicit_stop.valid === true) {
      fs.rmSync(paths.explicit_stop_file, { force: true });
      out.explicit_stop_cleared = true;
    }
    if (observed.desired_state.state === 'STOPPED') {
      const resumed = writeDesiredStateFile({ file: paths.desired_state_file, desired: 'RUNNING', nowMs });
      out.desired_state_resumed = resumed.written === true;
    }
    return out;
  } catch (error) {
    return { ...out, ok: false, outcome: 'REVIEW', review_required: true, error: { code: 'EXPLICIT_STOP_CLEAR_FAILED', message: String(error?.message ?? error) } };
  }
}

// ---------------------------------------------------------------------------
// stopBootstrap
// ---------------------------------------------------------------------------

async function stopTargetNow({ paths, context, provider, now, leaseMs }) {
  const owner = await observeOwner({ paths, context, provider, now, leaseMs });
  if (owner.present === true && owner.valid === true && owner.lineage_ok === true && owner.state === 'ALIVE' && Number.isInteger(owner.owner_pid)) {
    return { kind: 'owner', pid: owner.owner_pid, owner };
  }
  const launch = readLaunchRecord({ file: paths.launch_record_file, context });
  const alive = await launchAliveState(launch, provider);
  if (alive === 'ALIVE' && Number.isInteger(launch.spawn_pid)) return { kind: 'launch', pid: launch.spawn_pid, launch };
  return { kind: null, pid: null, owner, launch };
}

async function verifyStopped({ paths, context, provider, now, sleep, timeoutMs, pollIntervalMs, leaseMs }) {
  const maxPolls = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs));
  let last = null;
  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    const owner = await observeOwner({ paths, context, provider, now: typeof now === 'function' ? now() : now, leaseMs });
    const launch = readLaunchRecord({ file: paths.launch_record_file, context });
    const launchState = await launchAliveState(launch, provider);
    const ownerOurs = owner.present === true && owner.valid === true && owner.lineage_ok === true;
    const ownerLive = ownerOurs === true && owner.state === 'ALIVE';
    const ownerAmbiguous = (owner.present === true && ownerOurs !== true) || (ownerOurs === true && (owner.state === 'UNRESPONSIVE' || owner.state === 'UNKNOWN'));
    const launchAmbiguous = launch.present === true && (launch.valid !== true || launchState === 'UNKNOWN');
    last = { owner_state: owner.present === true ? owner.state : 'NONE', owner_lineage_ok: owner.lineage_ok === true, launch_state: launchState };
    if (ownerLive !== true && launchState !== 'ALIVE' && ownerAmbiguous !== true && launchAmbiguous !== true) {
      return { stopped: true, attempts: attempt + 1, last };
    }
    if (ownerLive === true) last.owner_state = owner.state;
    if (attempt < maxPolls - 1) await sleep(pollIntervalMs);
  }
  return { stopped: false, attempts: maxPolls, last };
}

function normalizeStopOptions(options = {}) {
  const base = normalizePlanOptions(options);
  if (options.signalProcess !== undefined && typeof options.signalProcess !== 'function') throw new TypeError('signalProcess must be a function');
  if (options.sleep !== undefined && typeof options.sleep !== 'function') throw new TypeError('sleep must be a function');
  for (const [field, value] of [['stopTimeoutMs', options.stopTimeoutMs], ['pollIntervalMs', options.pollIntervalMs]]) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new TypeError(`${field} must be a positive number`);
  }
  return {
    ...base,
    signalProcess: options.signalProcess ?? ((pid, signal) => process.kill(pid, signal)),
    stopTimeoutMs: options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    sleep: options.sleep ?? defaultSleep,
    actor: typeof options.actor === 'string' && options.actor.length > 0 ? options.actor : 'cli',
    reason: typeof options.reason === 'string' ? options.reason : null,
  };
}

/**
 * Explicit stop. Persists the explicit-stop marker first (so a later DSH
 * startup cannot auto-resume), then the existing preferred desired state, then
 * verifies/signals only an identity-verified companion. Never deletes runtime
 * data, never archives a stale owner lock, never resets the budget.
 *
 * result.confirmed === true only when no verified live owner/launch remains and
 * no owner/launch state is ambiguous.
 */
export async function stopBootstrap(options = {}) {
  const opts = normalizeStopOptions(options);
  const plan = await planBootstrap(planOptionsFromEnsure(opts));
  const decision = plan.decisions.stop;
  const context = plan.context;
  const base = {
    schema: STOP_SCHEMA,
    ok: false,
    confirmed: false,
    decision: decision.decision,
    reason_code: decision.reason_code,
    explanation: decision.explanation,
    review_required: decision.review_required === true,
    already_stopped: false,
    explicit_stop_written: false,
    explicit_stop_file: null,
    marker_healed: false,
    marker_archived: null,
    desired_state_written: false,
    desired_state_previous: plan.observed.desired_state?.state ?? 'UNKNOWN',
    signalled: false,
    signal_pid: null,
    signal_error: null,
    signal_skipped: null,
    owner_before: plan.observed.owner ?? null,
    owner_after: null,
    verification: null,
    runtime_data: plan.observed.runtime_files ?? null,
    plan,
    error: null,
  };
  if (decision.ok !== true) {
    return { ...base, ok: false, review_required: decision.review_required === true, error: { code: decision.reason_code, message: decision.explanation } };
  }
  const paths = bootstrapPaths(context.runtime_root);
  base.explicit_stop_file = paths.explicit_stop_file;

  // 1) Persist the explicit-stop marker first (fail closed if this fails).
  try {
    if (plan.observed.explicit_stop.valid === true) {
      // Idempotent: keep the existing valid marker and its stopped_at.
    } else if (decision.will_heal_stop_marker === true) {
      if (fs.existsSync(paths.explicit_stop_file)) {
        base.marker_archived = archiveFile(paths.explicit_stop_file, 'corrupt', opts.now());
      }
      writeJsonAtomic(paths.explicit_stop_file, buildExplicitStopMarker({ context, nowMs: opts.now(), actor: opts.actor, reason: opts.reason }));
      base.explicit_stop_written = true;
      base.marker_healed = true;
    } else {
      fs.mkdirSync(path.dirname(paths.explicit_stop_file), { recursive: true });
      writeJsonAtomic(paths.explicit_stop_file, buildExplicitStopMarker({ context, nowMs: opts.now(), actor: opts.actor, reason: opts.reason }));
      base.explicit_stop_written = true;
    }
  } catch (error) {
    return { ...base, ok: false, error: { code: 'EXPLICIT_STOP_MARKER_WRITE_FAILED', message: String(error?.message ?? error) } };
  }

  // 2) Existing A preferred desired-state signal (only when unambiguous).
  if (decision.will_write_desired_state === true) {
    try {
      const written = writeDesiredStateFile({ file: paths.desired_state_file, desired: 'STOPPED', nowMs: opts.now() });
      base.desired_state_written = written.written === true;
      if (written.code === 'DESIRED_STATE_CORRUPT') base.desired_state_error = 'DESIRED_STATE_CORRUPT';
    } catch (error) {
      base.desired_state_error = String(error?.message ?? error);
    }
  }

  // 2b) Give a running companion a short chance to observe desired STOPPED and
  // stop its Hub child gracefully before falling back to a process signal. A
  // Windows SIGTERM may terminate the companion without running shutdown hooks
  // and can leave the Hub child orphaned.
  let gracefulStopObserved = false;
  if (decision.will_signal === true && base.desired_state_written === true) {
    for (let attempt = 0; attempt < 25; attempt += 1) {
      await opts.sleep(100);
      let observedOwner = null;
      try {
        observedOwner = await observeOwner({ paths, context, provider: opts.provider, now: opts.now(), leaseMs: opts.leaseMs });
      } catch { observedOwner = null; }
      if (observedOwner === null || observedOwner.state !== 'ALIVE' || observedOwner.valid !== true) {
        gracefulStopObserved = true;
        break;
      }
    }
  }

  // 3) Re-verify and signal only an exact identity-verified target.
  let target = null;
  if (decision.will_signal === true && gracefulStopObserved === false) {
    target = await stopTargetNow({ paths, context, provider: opts.provider, now: opts.now(), leaseMs: opts.leaseMs });
    if (target.pid === null) {
      base.signal_error = 'SIGNAL_TARGET_NOT_REVERIFIED';
    } else {
      try {
        opts.signalProcess(target.pid, 'SIGTERM');
        base.signalled = true;
        base.signal_pid = target.pid;
        base.signal_target_kind = target.kind;
      } catch (error) {
        base.signal_error = String(error?.code ?? error?.message ?? error);
      }
    }
  } else if (decision.will_signal === true && gracefulStopObserved === true) {
    base.signal_skipped = 'DESIRED_STOP_GRACEFUL';
  }

  // 4) Bounded stop verification.
  const nowFn = () => opts.now();
  const verification = await verifyStopped({ paths, context, provider: opts.provider, now: nowFn, sleep: opts.sleep, timeoutMs: opts.stopTimeoutMs, pollIntervalMs: opts.pollIntervalMs, leaseMs: opts.leaseMs });
  let ownerAfter = null;
  try {
    ownerAfter = await observeOwner({ paths, context, provider: opts.provider, now: opts.now(), leaseMs: opts.leaseMs });
  } catch { ownerAfter = null; }
  const alreadyStopped = decision.already_stopped === true && base.explicit_stop_written !== true;
  const confirmed = verification.stopped === true;
  const reviewRequired = confirmed !== true || decision.review_required === true;
  return {
    ...base,
    ok: confirmed === true && reviewRequired !== true,
    confirmed,
    already_stopped: alreadyStopped,
    review_required: reviewRequired,
    owner_after: ownerAfter,
    verification,
    runtime_data: runtimeFilePresence({ paths }),
    error: confirmed === true ? (reviewRequired === true ? { code: 'STOP_REVIEW_REQUIRED', message: decision.explanation } : null) : { code: 'STOP_UNCONFIRMED', message: `stop not verified within ${opts.stopTimeoutMs}ms` },
  };
}

// ---------------------------------------------------------------------------
// statusBootstrap
// ---------------------------------------------------------------------------

/**
 * Read-only status: the same facts as planBootstrap plus one compact state and
 * action hint for CLI/doctor output. Never writes, spawns or signals.
 */
export async function statusBootstrap(options = {}) {
  const plan = await planBootstrap(options);
  const ensure = plan.decisions.ensure;
  const observed = plan.observed;
  const markerActive = observed.explicit_stop?.present === true && observed.explicit_stop?.valid === true;
  const ownerVerified = observed.owner?.present === true && observed.owner?.valid === true && observed.owner?.lineage_ok === true && observed.owner?.state === 'ALIVE';
  let state = 'UNKNOWN';
  let actionHint = 'REVIEW';
  switch (ensure.decision) {
    case 'ATTACH_VERIFIED_OWNER':
      state = 'OWNED_RUNNING';
      actionHint = 'ATTACH';
      break;
    case 'ATTACH_LAUNCH_PENDING':
    case 'BOOTSTRAP_IN_FLIGHT':
      state = 'START_PENDING';
      actionHint = 'ATTACH';
      break;
    case 'ATTACH_EXISTING_HUB':
      state = 'HUB_EXTERNAL_RUNNING';
      actionHint = 'ATTACH';
      break;
    case 'PAUSED_EXPLICIT_STOP':
      state = ensure.reason_code === 'DESIRED_STATE_STOPPED' ? 'STOPPED_LEGACY' : 'STOPPED_EXPLICIT';
      actionHint = 'NONE';
      break;
    case 'PAUSED_BUDGET_HALTED':
      state = 'BUDGET_HALTED';
      actionHint = 'NONE';
      break;
    case 'MODE_NOT_MANAGED':
      state = 'NOT_MANAGED';
      actionHint = 'NONE';
      break;
    case 'NO_INSTALLATION':
      state = 'NOT_INSTALLED';
      actionHint = 'NONE';
      break;
    case 'START_COMPANION':
      state = 'READY_TO_START';
      actionHint = 'START';
      break;
    default:
      state = ensure.review_required === true ? 'NEEDS_REVIEW' : 'UNKNOWN';
      actionHint = 'REVIEW';
      break;
  }
  return {
    schema: STATUS_SCHEMA,
    read_only: true,
    generated_at: plan.generated_at,
    state,
    action_hint: actionHint,
    owner_verified: ownerVerified,
    explicit_stop_active: markerActive,
    explicit_stop_valid: observed.explicit_stop?.valid === true,
    desired_state: observed.desired_state?.state ?? null,
    budget_halted: observed.budget?.halted === true,
    budget_corrupt: observed.budget?.corrupt === true,
    owner_state: observed.owner?.present === true ? observed.owner.state : 'NONE',
    owner_lineage_ok: observed.owner?.lineage_ok === true,
    launch_state: observed.launch_record?.alive_state ?? 'NONE',
    guard_present: observed.guard?.present === true,
    hub_probe_state: observed.hub_probe?.state ?? null,
    node_executable: resolveNodeExecutable({ env: options.env ?? process.env }),
    runtime: {
      runtime_root: plan.context.runtime_root ?? null,
      runtime_source: plan.context.runtime_source ?? null,
      installation_id: plan.context.installation_id ?? null,
      instance_id: plan.context.instance_id ?? null,
      owner_mode: plan.context.owner_mode ?? null,
      runtime_exists: plan.context.runtime_exists === true,
    },
    runtime_files: observed.runtime_files ?? null,
    next_commands: {
      start: 'explicit CLI start -> ensureBootstrap({ explicitStart: true })',
      stop: 'explicit CLI stop -> stopBootstrap()',
      review: 'inspect plan.observed for the review reason before acting',
    },
    plan,
  };
}
