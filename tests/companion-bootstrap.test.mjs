// Focused tests for the isolated DSH companion/bootstrap seam.
//
// Everything here runs against synthetic installation/runtime directories under
// os.tmpdir(); the process identity provider, spawn, signals and clock are all
// injected. Nothing touches a real installation, Hub, token, receiver, DSH
// profile or production runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  BOOTSTRAP_DECISIONS,
  EXPLICIT_STOP_SCHEMA,
  GUARD_SCHEMA,
  LAUNCH_SCHEMA,
  PLAN_SCHEMA,
  STATUS_SCHEMA,
  bootstrapPaths,
  ensureBootstrap,
  planBootstrap,
  statusBootstrap,
  stopBootstrap,
  resolveNodeExecutable,
} from '../src/companion-bootstrap.mjs';
import { writeInstallationAtomic } from '../src/installation.mjs';

const BASE = Date.parse('2026-11-01T12:00:00.000Z');
const HOST = {
  created_at: '2026-11-01T11:00:00.000Z',
  exe_path: 'C:\\Program Files\\nodejs\\node.exe',
  entry_path: 'C:\\Dev\\bridge\\companion\\main.mjs',
};

function tempRoot(prefix = 'bridge-bootstrap-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(value) {
  try { fs.rmSync(value.root, { recursive: true, force: true }); } catch { /* best effort */ }
}

function makeContext({ mode = 'COMPANION_OWNED', companionEntry = true } = {}) {
  const root = tempRoot();
  const runtimeRoot = path.join(root, 'runtime');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const appRoot = path.join(root, 'app', '0.1.0-dev');
  fs.mkdirSync(appRoot, { recursive: true });
  const entry = path.join(appRoot, 'companion', 'main.mjs');
  if (companionEntry) {
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, '// synthetic companion entry; never executed by these tests\n');
  }
  const installation = writeInstallationAtomic({
    root,
    installation: {
      v: 1,
      installation_id: 'install-boot',
      instance_id: 'instance-boot',
      active_version: '0.1.0-dev',
      app_root: appRoot,
      runtime_root: runtimeRoot,
      hub_owner_kind: mode,
      protocol_version: 1,
      state_schema: 1,
    },
  });
  const paths = bootstrapPaths(runtimeRoot);
  return { root, runtimeRoot, appRoot, companionEntry: entry, locatorPath: path.join(root, 'installation.json'), installation, paths };
}

function makeClock(start = BASE) {
  const state = { t: start };
  return {
    now: () => state.t,
    sleep: async (ms) => { state.t += Math.max(1, ms); },
    advance: (ms) => { state.t += ms; },
    value: () => state.t,
  };
}

function providerWith(map = new Map()) {
  return async (pid) => {
    const value = map.get(pid);
    if (value === 'DEAD') return { pid, alive: false, available: false, unavailable_reason: 'PROCESS_NOT_FOUND' };
    if (value === 'UNKNOWN') return { pid, alive: true, available: false };
    if (typeof value === 'function') return value(pid);
    if (value !== undefined) return { pid, available: true, alive: true, source: 'injected', ...HOST, ...value };
    if (pid === process.pid) return { pid, available: true, alive: true, source: 'injected', ...HOST };
    return { pid, alive: false, available: false, unavailable_reason: 'PROCESS_NOT_FOUND' };
  };
}

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.kill = () => { child.exitCode = 0; child.emit('exit', 0, 'SIGTERM'); };
  child.unref = () => {};
  return child;
}

function ensureOptions(ctx, clock, provider, extra = {}) {
  return {
    installationRoot: ctx.root,
    env: {},
    now: clock.now,
    provider,
    startTimeoutMs: 40,
    pollIntervalMs: 5,
    sleep: clock.sleep,
    ...extra,
  };
}

function stopOptions(ctx, clock, provider, extra = {}) {
  return {
    installationRoot: ctx.root,
    env: {},
    now: clock.now,
    provider,
    stopTimeoutMs: 20,
    pollIntervalMs: 5,
    sleep: clock.sleep,
    ...extra,
  };
}

function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeOwnerLock(ctx, { pid = 4321, nonce = 'owner-lock', now = BASE, installationId, instanceId, mode, component = 'companion', configPath } = {}) {
  const id = installationId ?? ctx.installation.installation_id;
  const instance = instanceId ?? ctx.installation.instance_id;
  writeJsonFile(ctx.paths.hub_owner_lock_file, {
    v: 1,
    installation_id: id,
    instance_id: instance,
    owner_epoch: 1,
    mode: mode ?? ctx.installation.hub_owner_kind,
    owner_component: component,
    owner_process: {
      pid,
      created_at: HOST.created_at,
      exe_realpath: HOST.exe_path,
      entry_realpath: HOST.entry_path,
      config_path: configPath ?? ctx.locatorPath,
    },
    nonce,
    heartbeat_at: new Date(now).toISOString(),
    lease_expires_at: new Date(now + 30_000).toISOString(),
    heartbeat_interval_ms: 10_000,
    lease_ms: 30_000,
  });
}

function writeStopMarker(ctx, overrides = {}) {
  writeJsonFile(ctx.paths.explicit_stop_file, {
    v: 1,
    schema: EXPLICIT_STOP_SCHEMA,
    explicit_stop: true,
    stopped_at: new Date(BASE).toISOString(),
    actor: 'test',
    reason: 'synthetic stop',
    installation_id: ctx.installation.installation_id,
    instance_id: ctx.installation.instance_id,
    runtime_root: ctx.runtimeRoot,
    ...overrides,
  });
}

function writeDesired(ctx, desired_state, extra = {}) {
  writeJsonFile(ctx.paths.desired_state_file, { desired_state, ...extra });
}

function writeLaunchRecord(ctx, overrides = {}) {
  writeJsonFile(ctx.paths.launch_record_file, {
    v: 1,
    schema: LAUNCH_SCHEMA,
    nonce: 'launch-record-1',
    spawned_at: new Date(BASE).toISOString(),
    runtime_root: ctx.runtimeRoot,
    installation_id: ctx.installation.installation_id,
    instance_id: ctx.installation.instance_id,
    companion_entry: ctx.companionEntry,
    spawn_pid: 9001,
    created_at: HOST.created_at,
    exe_path: HOST.exe_path,
    entry_path: HOST.entry_path,
    reason: 'MANUAL_START',
    host_pid: process.pid,
    last_result: 'STARTING',
    ...overrides,
  });
}

function writeGuard(ctx, overrides = {}) {
  writeJsonFile(ctx.paths.bootstrap_guard_file, {
    v: 1,
    schema: GUARD_SCHEMA,
    nonce: 'guard-1',
    pid: 7777,
    created_at: HOST.created_at,
    exe_path: HOST.exe_path,
    entry_path: HOST.entry_path,
    started_at: new Date(BASE).toISOString(),
    runtime_root: ctx.runtimeRoot,
    installation_id: ctx.installation.installation_id,
    instance_id: ctx.installation.instance_id,
    ...overrides,
  });
}

function writeBudget(ctx, timestamps) {
  writeJsonFile(ctx.paths.budget_file, { v: 1, attempts: timestamps, updated_at: new Date(BASE).toISOString() });
}

function snapshotTree(root) {
  const entries = [];
  const walk = (current) => {
    for (const name of fs.readdirSync(current).sort()) {
      const file = path.join(current, name);
      const stat = fs.lstatSync(file);
      if (stat.isDirectory()) {
        entries.push({ path: file, dir: true });
        walk(file);
      } else {
        entries.push({ path: file, content: fs.readFileSync(file, 'utf8'), size: stat.size });
      }
    }
  };
  walk(root);
  return entries;
}

function assertNoDir(file) {
  assert.equal(fs.existsSync(file), false, `unexpected path created: ${file}`);
}

// ---------------------------------------------------------------------------
// plan / status are read-only
// ---------------------------------------------------------------------------

test('plan and status are read-only and report NO_INSTALLATION without writing anything', async () => {
  const root = tempRoot('bridge-bootstrap-empty-');
  try {
    const before = snapshotTree(root);
    const plan = await planBootstrap({ installationRoot: root, env: {}, now: () => BASE });
    assert.equal(plan.schema, PLAN_SCHEMA);
    assert.equal(plan.read_only, true);
    assert.equal(plan.decisions.ensure.decision, 'NO_INSTALLATION');
    assert.equal(plan.decisions.ensure.ok, true);
    assert.equal(plan.decisions.ensure.paused, true);
    assert.equal(plan.decisions.stop.decision, 'STOP_REVIEW_NO_RUNTIME');
    assert.equal(plan.decisions.stop.ok, false);
    assert.ok(BOOTSTRAP_DECISIONS.includes(plan.decisions.ensure.decision));
    assert.deepEqual(snapshotTree(root), before, 'plan must not write');

    const status = await statusBootstrap({ installationRoot: root, env: {}, now: () => BASE });
    assert.equal(status.schema, STATUS_SCHEMA);
    assert.equal(status.read_only, true);
    assert.equal(status.state, 'NOT_INSTALLED');
    assert.equal(status.action_hint, 'NONE');
    assert.deepEqual(snapshotTree(root), before, 'status must not write');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a fresh installation plans START_COMPANION but the plan writes nothing (no runtime/token creation)', async () => {
  const ctx = makeContext();
  try {
    const beforeRuntime = snapshotTree(ctx.runtimeRoot);
    const locatorBefore = fs.readFileSync(ctx.locatorPath, 'utf8');
    const plan = await planBootstrap({ installationRoot: ctx.root, env: {}, now: () => BASE, provider: providerWith() });
    assert.equal(plan.decisions.ensure.decision, 'START_COMPANION');
    assert.equal(plan.decisions.ensure.will_spawn, true);
    assert.equal(plan.decisions.ensure.will_clear_explicit_stop, false);
    assert.equal(plan.context.runtime_root, ctx.runtimeRoot);
    assert.equal(plan.context.runtime_source, 'installation');
    assert.equal(plan.context.owner_mode, 'COMPANION_OWNED');
    assert.equal(plan.observed.explicit_stop.present, false);
    assert.equal(plan.observed.budget.present, false);
    assert.deepEqual(snapshotTree(ctx.runtimeRoot), beforeRuntime);
    assert.equal(fs.readFileSync(ctx.locatorPath, 'utf8'), locatorBefore);
    assertNoDir(ctx.paths.companion_dir);
    assertNoDir(ctx.paths.hub_token_file);
  } finally {
    cleanup(ctx);
  }
});

test('plan rejects invalid argument shapes with TypeError', async () => {
  const ctx = makeContext();
  try {
    await assert.rejects(planBootstrap({ installationRoot: 'relative/root' }), TypeError);
    await assert.rejects(planBootstrap({ installationRoot: ctx.root, runtimeDir: 'relative/runtime' }), TypeError);
    await assert.rejects(planBootstrap({ installationRoot: ctx.root, now: 'soon' }), TypeError);
    await assert.rejects(planBootstrap({ installationRoot: ctx.root, explicitStart: 'yes' }), TypeError);
    await assert.rejects(ensureBootstrap({ installationRoot: ctx.root, nodeExecutable: 'node.exe' }), TypeError);
    await assert.rejects(ensureBootstrap({ installationRoot: ctx.root, spawnProcess: 42 }), TypeError);
    await assert.rejects(stopBootstrap({ installationRoot: ctx.root, signalProcess: 'kill' }), TypeError);
  } finally {
    cleanup(ctx);
  }
});

// ---------------------------------------------------------------------------
// ensure: start / attach
// ---------------------------------------------------------------------------

test('ensure spawns exactly one detached companion, charges one outer-budget attempt, and verifies owner', async () => {
  const ctx = makeContext();
  const clock = makeClock();
  const childPid = 9001;
  const map = new Map([[childPid, { ...HOST }]]);
  const provider = providerWith(map);
  let spawnCall = null;
  try {
    const spawnProcess = (exe, args, options) => {
      spawnCall = { exe, args, options };
      writeOwnerLock(ctx, { pid: childPid, nonce: 'spawn-owner', now: clock.now() });
      return fakeChild(childPid);
    };
    const env = { CODEX_THREAD_ID: 'ambient-thread', OTHER: 'kept' };
    const result = await ensureBootstrap(ensureOptions(ctx, clock, provider, { spawnProcess, env }));
    assert.equal(result.ok, true);
    assert.equal(result.outcome, 'STARTED_OWNER_VERIFIED');
    assert.equal(result.decision, 'START_COMPANION');
    assert.equal(result.started, true);
    assert.equal(result.spawn_calls, 1);
    assert.equal(result.spawn_pid, childPid);
    assert.equal(result.owner_verified, true);
    assert.equal(result.explicit_stop_cleared, false);
    assert.equal(result.budget.attempts_in_window, 1);

    assert.equal(spawnCall.exe, process.execPath);
    assert.deepEqual(spawnCall.args.slice(0, 3), [ctx.companionEntry, '--installation', ctx.root]);
    assert.equal(spawnCall.args[3], '--reason');
    assert.equal(spawnCall.args[4], 'MANUAL_START');
    assert.equal(spawnCall.options.detached, true);
    assert.equal(spawnCall.options.stdio, 'ignore');
    assert.equal(spawnCall.options.cwd, path.dirname(ctx.companionEntry));
    assert.equal(spawnCall.options.env.LAB_BRIDGE_RUNTIME_DIR, ctx.runtimeRoot);
    assert.equal(spawnCall.options.env.LAB_BRIDGE_INSTALLATION_ROOT, ctx.root);
    assert.equal(spawnCall.options.env.CODEX_THREAD_ID, undefined);
    assert.equal(spawnCall.options.env.OTHER, 'kept');

    // Own single verified owner lock; no second runtime/token created.
    assert.equal(fs.existsSync(ctx.paths.hub_owner_lock_file), true);
    const lock = JSON.parse(fs.readFileSync(ctx.paths.hub_owner_lock_file, 'utf8'));
    assert.equal(lock.owner_component, 'companion');
    assert.equal(lock.owner_process.pid, childPid);
    assertNoDir(ctx.paths.hub_token_file);
    assertNoDir(ctx.paths.hub_config_file);
    assertNoDir(ctx.paths.hub_state_file);
    // Guard released; durable launch record + budget written under companion/.
    assertNoDir(ctx.paths.bootstrap_guard_file);
    const launch = JSON.parse(fs.readFileSync(ctx.paths.launch_record_file, 'utf8'));
    assert.equal(launch.spawn_pid, childPid);
    assert.equal(launch.last_result, 'OWNER_VERIFIED');
    assert.equal(launch.installation_id, ctx.installation.installation_id);
    const budget = JSON.parse(fs.readFileSync(ctx.paths.budget_file, 'utf8'));
    assert.equal(budget.attempts.length, 1);
    assert.equal(fs.existsSync(ctx.paths.desired_state_file), false, 'plain ensure must not write desired-state');
  } finally {
    cleanup(ctx);
  }
});

test('ensure attaches to a verified live owner without spawning or writing runtime state', async () => {
  const ctx = makeContext();
  const clock = makeClock();
  try {
    writeOwnerLock(ctx, { pid: 4321, now: clock.now() });
    const before = snapshotTree(ctx.runtimeRoot);
    let spawned = 0;
    const result = await ensureBootstrap(ensureOptions(ctx, clock, providerWith(new Map([[4321, { ...HOST }]])), {
      spawnProcess: () => { spawned += 1; throw new Error('must not spawn'); },
    }));
    assert.equal(result.ok, true);
    assert.equal(result.outcome, 'ATTACHED_VERIFIED_OWNER');
    assert.equal(result.reused, true);
    assert.equal(result.started, false);
    assert.equal(spawned, 0);
    assert.equal(result.owner_pid, 4321);
    assert.deepEqual(snapshotTree(ctx.runtimeRoot), before, 'attach must not write');
    assertNoDir(ctx.paths.companion_dir);
    assertNoDir(ctx.paths.budget_file);
  } finally {
    cleanup(ctx);
  }
});

test('ensure attaches to a verified pending launch record instead of spawning a duplicate', async () => {
  const ctx = makeContext();
  const clock = makeClock();
  try {
    writeLaunchRecord(ctx, { spawn_pid: 9001 });
    let spawned = 0;
    const result = await ensureBootstrap(ensureOptions(ctx, clock, providerWith(new Map([[9001, { ...HOST }]])), {
      spawnProcess: () => { spawned += 1; throw new Error('must not spawn'); },
    }));
    assert.equal(result.ok, true);
    assert.equal(result.outcome, 'ATTACHED_LAUNCH_PENDING');
    assert.equal(result.pending_owner, true);
    assert.equal(spawned, 0);
    // The launch record is read-only evidence for this decision.
    const launch = JSON.parse(fs.readFileSync(ctx.paths.launch_record_file, 'utf8'));
    assert.equal(launch.last_result, 'STARTING');
    assertNoDir(ctx.paths.budget_file);
  } finally {
    cleanup(ctx);
  }
});

// ---------------------------------------------------------------------------
// explicit stop semantics
// ---------------------------------------------------------------------------

test('ensure never auto-resumes a persisted explicit stop marker', async () => {
  const ctx = makeContext();
  const clock = makeClock();
  try {
    writeStopMarker(ctx);
    const markerBefore = fs.readFileSync(ctx.paths.explicit_stop_file, 'utf8');
    let spawned = 0;
    const result = await ensureBootstrap(ensureOptions(ctx, clock, providerWith(), {
      spawnProcess: () => { spawned += 1; throw new Error('must not spawn'); },
    }));
    assert.equal(result.ok, true);
    assert.equal(result.outcome, 'PAUSED');
    assert.equal(result.decision, 'PAUSED_EXPLICIT_STOP');
    assert.equal(result.reason_code, 'EXPLICIT_STOP_ACTIVE');
    assert.equal(result.explicit_stop_active, true);
    assert.equal(result.explicit_stop_cleared, false);
    assert.equal(result.paused, true);
    assert.equal(spawned, 0);
    assert.equal(fs.readFileSync(ctx.paths.explicit_stop_file, 'utf8'), markerBefore);
    assertNoDir(ctx.paths.budget_file);
    assertNoDir(ctx.paths.hub_owner_lock_file);

    const status = await statusBootstrap({ installationRoot: ctx.root, env: {}, now: clock.now, provider: providerWith() });
    assert.equal(status.state, 'STOPPED_EXPLICIT');
    assert.equal(status.action_hint, 'NONE');
  } finally {
    cleanup(ctx);
  }
});

test('ensure treats legacy desired-state STOPPED as an explicit stop', async () => {
  const ctx = makeContext();
  const clock = makeClock();
  try {
    writeDesired(ctx, 'STOPPED', { preserved_extra: 'kept' });
    let spawned = 0;
    const result = await ensureBootstrap(ensureOptions(ctx, clock, providerWith(), {
      spawnProcess: () => { spawned += 1; throw new Error('must not spawn'); },
    }));
    assert.equal(result.outcome, 'PAUSED');
    assert.equal(result.reason_code, 'DESIRED_STATE_STOPPED');
    assert.equal(spawned, 0);
    const desired = JSON.parse(fs.readFileSync(ctx.paths.desired_state_file, 'utf8'));
    assert.equal(desired.desired_state, 'STOPPED');
    assert.equal(desired.preserved_extra, 'kept');
  } finally {
    cleanup(ctx);
  }
});

test('explicit start clears marker + desired state and then starts exactly once', async () => {
  const ctx = makeContext();
  const clock = makeClock();
  const childPid = 9005;
  try {
    writeStopMarker(ctx);
    writeDesired(ctx, 'STOPPED');
    const spawnProcess = () => {
      writeOwnerLock(ctx, { pid: childPid, nonce: 'explicit-start-owner', now: clock.now() });
      return fakeChild(childPid);
    };
    const result = await ensureBootstrap(ensureOptions(ctx, clock, providerWith(new Map([[childPid, { ...HOST }]])), { spawnProcess, explicitStart: true }));
    assert.equal(result.ok, true);
    assert.equal(result.outcome, 'STARTED_OWNER_VERIFIED');
    assert.equal(result.explicit_stop_cleared, true);
    assert.equal(result.desired_state_resumed, true);
    assertNoDir(ctx.paths.explicit_stop_file);
    const desired = JSON.parse(fs.readFileSync(ctx.paths.desired_state_file, 'utf8'));
    assert.equal(desired.desired_state, 'RUNNING');
    assert.equal(fs.existsSync(ctx.paths.explicit_stop_file), false);
  } finally {
    cleanup(ctx);
  }
});

test('corrupt or foreign explicit-stop markers fail closed and are preserved', async () => {
  const ctx = makeContext();
  const clock = makeClock();
  try {
    fs.mkdirSync(path.dirname(ctx.paths.explicit_stop_file), { recursive: true });
    fs.writeFileSync(ctx.paths.explicit_stop_file, '{not-json', 'utf8');
    const corruptBefore = fs.readFileSync(ctx.paths.explicit_stop_file, 'utf8');
    let spawned = 0;
    const spawnProcess = () => { spawned += 1; throw new Error('must not spawn'); };
    const corrupt = await ensureBootstrap(ensureOptions(ctx, clock, providerWith(), { spawnProcess }));
    assert.equal(corrupt.ok, false);
    assert.equal(corrupt.outcome, 'REVIEW');
    assert.equal(corrupt.decision, 'REVIEW_EXPLICIT_STOP_MARKER');
    assert.equal(fs.readFileSync(ctx.paths.explicit_stop_file, 'utf8'), corruptBefore);
    assert.equal(spawned, 0);

    writeStopMarker(ctx, { runtime_root: path.join(ctx.root, 'other-runtime') });
    const foreignBefore = fs.readFileSync(ctx.paths.explicit_stop_file, 'utf8');
    const foreign = await ensureBootstrap(ensureOptions(ctx, clock, providerWith(), { spawnProcess }));
    assert.equal(foreign.decision, 'REVIEW_EXPLICIT_STOP_MARKER');
    assert.equal(fs.readFileSync(ctx.paths.explicit_stop_file, 'utf8'), foreignBefore);
    assert.equal(spawned, 0);
  } finally {
    cleanup(ctx);
  }
});

// ---------------------------------------------------------------------------
// owner identity: no pidAlive-only takeover
// ---------------------------------------------------------------------------

test('unverified or stale owner leases are review, never takeover', async () => {
  const ctx = makeContext();
  const clock = makeClock();
  try {
    writeOwnerLock(ctx, { pid: 4321, now: clock.now() });
    const lockBefore = fs.readFileSync(ctx.paths.hub_owner_lock_file, 'utf8');
    let spawned = 0;
    const spawnProcess = () => { spawned += 1; throw new Error('must not spawn'); };
    const unknownProvider = providerWith(new Map([[4321, 'UNKNOWN']]));
    const unknown = await ensureBootstrap(ensureOptions(ctx, clock, unknownProvider, { spawnProcess }));
    assert.equal(unknown.ok, false);
    assert.equal(unknown.decision, 'REVIEW_OWNER_UNVERIFIED');
    assert.equal(spawned, 0);
    assert.equal(fs.readFileSync(ctx.paths.hub_owner_lock_file, 'utf8'), lockBefore);

    // Same process identity but a stale lease: UNRESPONSIVE is still review.
    writeOwnerLock(ctx, { pid: 4321, now: clock.now() - 120_000 });
    const stale = await ensureBootstrap(ensureOptions(ctx, clock, providerWith(new Map([[4321, { ...HOST }]])), { spawnProcess }));
    assert.equal(stale.ok, false);
    assert.equal(stale.decision, 'REVIEW_OWNER_UNVERIFIED');
    assert.equal(fs.existsSync(ctx.paths.bootstrap_guard_file), false);
    assert.equal(spawned, 0);
  } finally {
    cleanup(ctx);
  }
});

test('a live pid with incomplete identity is not a verified owner (no pidAlive-only takeover)', async () => {
  const ctx = makeContext();
  const clock = makeClock();
  try {
    writeOwnerLock(ctx, { pid: 4321, now: clock.now() });
    const provider = async (pid) => {
      if (pid === 4321) return { pid, alive: true, available: false, exe_path: null, entry_path: null };
      return providerWith()(pid);
    };
    let spawned = 0;
    const result = await ensureBootstrap(ensureOptions(ctx, clock, provider, {
      spawnProcess: () => { spawned += 1; throw new Error('must not spawn'); },
    }));
    assert.equal(result.ok, false);
    assert.equal(result.decision, 'REVIEW_OWNER_UNVERIFIED');
    assert.equal(spawned, 0);
  } finally {
    cleanup(ctx);
  }
});

test('dead owner with matching lineage allows one bounded start; mismatched lineage reviews', async () => {
  const ctx = makeContext();
  const clock = makeClock();
  const newPid = 9010;
  try {
    writeOwnerLock(ctx, { pid: 4321, now: clock.now() });
    const map = new Map([[4321, 'DEAD'], [newPid, { ...HOST }]]);
    let spawned = 0;
    const spawnProcess = () => {
      spawned += 1;
      fs.rmSync(ctx.paths.hub_owner_lock_file, { force: true });
      writeOwnerLock(ctx, { pid: newPid, nonce: 'recovered-owner', now: clock.now() });
      return fakeChild(newPid);
    };
    const result = await ensureBootstrap(ensureOptions(ctx, clock, providerWith(map), { spawnProcess }));
    assert.equal(result.ok, true);
    assert.equal(result.outcome, 'STARTED_OWNER_VERIFIED');
    assert.equal(spawned, 1);
    assert.equal(result.spawn_pid, newPid);

    // Mismatched lineage: a different installation's dead lock is not ours.
    const other = makeContext();
    try {
      writeOwnerLock(other, { pid: 4321, now: clock.now(), installationId: 'install-other' });
      const lockBefore = fs.readFileSync(other.paths.hub_owner_lock_file, 'utf8');
      let spawnedOther = 0;
      const otherResult = await ensureBootstrap(ensureOptions(other, clock, providerWith(new Map([[4321, 'DEAD']])), {
        spawnProcess: () => { spawnedOther += 1; throw new Error('must not spawn'); },
      }));
      assert.equal(otherResult.ok, false);
      assert.equal(otherResult.decision, 'REVIEW_OWNER_LINEAGE');
      assert.equal(spawnedOther, 0);
      assert.equal(fs.readFileSync(other.paths.hub_owner_lock_file, 'utf8'), lockBefore);
    } finally {
      cleanup(other);
    }
  } finally {
    cleanup(ctx);
  }
});

test('an unreadable owner lock is review and is never deleted', async () => {
  const ctx = makeContext();
  const clock = makeClock();
  try {
    fs.mkdirSync(path.dirname(ctx.paths.hub_owner_lock_file), { recursive: true });
    fs.writeFileSync(ctx.paths.hub_owner_lock_file, 'garbage-lock', 'utf8');
    let spawned = 0;
    const result = await ensureBootstrap(ensureOptions(ctx, clock, providerWith(), {
      spawnProcess: () => { spawned += 1; throw new Error('must not spawn'); },
    }));
    assert.equal(result.ok, false);
    assert.equal(result.decision, 'REVIEW_OWNER_LOCK');
    assert.equal(spawned, 0);
    assert.equal(fs.readFileSync(ctx.paths.hub_owner_lock_file, 'utf8'), 'garbage-lock');
  } finally {
    cleanup(ctx);
  }
});

test('owner provider errors are UNKNOWN review, not DEAD takeover', async () => {
  const ctx = makeContext();
  const clock = makeClock();
  try {
    writeOwnerLock(ctx, { pid: 4321, now: clock.now() });
    const provider = async (pid) => {
      if (pid === 4321) throw new Error('identity provider exploded');
      return providerWith()(pid);
    };
    let spawned = 0;
    const result = await ensureBootstrap(ensureOptions(ctx, clock, provider, {
      spawnProcess: () => { spawned += 1; throw new Error('must not spawn'); },
    }));
    assert.equal(result.ok, false);
    assert.equal(result.decision, 'REVIEW_OWNER_UNVERIFIED');
    assert.equal(spawned, 0);
  } finally {
    cleanup(ctx);
  }
});

// ---------------------------------------------------------------------------
// finite budget
// ---------------------------------------------------------------------------

test('exhausted budget pauses and a corrupt budget fails closed without writing', async () => {
  const ctx = makeContext();
  const clock = makeClock();
  try {
    writeBudget(ctx, [new Date(BASE - 3_000).toISOString(), new Date(BASE - 2_000).toISOString(), new Date(BASE - 1_000).toISOString()]);
    const budgetBefore = fs.readFileSync(ctx.paths.budget_file, 'utf8');
    let spawned = 0;
    const paused = await ensureBootstrap(ensureOptions(ctx, clock, providerWith(), {
      spawnProcess: () => { spawned += 1; throw new Error('must not spawn'); },
    }));
    assert.equal(paused.ok, true);
    assert.equal(paused.outcome, 'PAUSED');
    assert.equal(paused.decision, 'PAUSED_BUDGET_HALTED');
    assert.equal(paused.paused, true);
    assert.equal(spawned, 0);
    assert.equal(fs.readFileSync(ctx.paths.budget_file, 'utf8'), budgetBefore);

    fs.writeFileSync(ctx.paths.budget_file, 'not-a-budget', 'utf8');
    const corruptBefore = fs.readFileSync(ctx.paths.budget_file, 'utf8');
    const corrupt = await ensureBootstrap(ensureOptions(ctx, clock, providerWith(), {
      spawnProcess: () => { spawned += 1; throw new Error('must not spawn'); },
    }));
    assert.equal(corrupt.ok, false);
    assert.equal(corrupt.decision, 'REVIEW_BUDGET_CORRUPT');
    assert.equal(corrupt.review_required, true);
    assert.equal(spawned, 0);
    assert.equal(fs.readFileSync(ctx.paths.budget_file, 'utf8'), corruptBefore);
  } finally {
    cleanup(ctx);
  }
});

test('finite outer budget bounds repeated spawn attempts to three per window', async () => {
  const ctx = makeContext();
  const clock = makeClock();
  const map = new Map();
  let nextPid = 9200;
  let spawnCalls = 0;
  try {
    const spawnProcess = () => {
      spawnCalls += 1;
      const pid = nextPid;
      nextPid += 1;
      map.set(pid, { ...HOST });
      return fakeChild(pid);
    };
    const outcomes = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await ensureBootstrap(ensureOptions(ctx, clock, providerWith(map), { spawnProcess, startTimeoutMs: 15, pollIntervalMs: 5 }));
      outcomes.push(result.outcome);
      assert.equal(result.outcome, 'STARTED_OWNER_UNCONFIRMED');
      assert.equal(result.ok, false);
      // The synthetic child never claims the owner lease; it exits dead.
      const pid = result.spawn_pid;
      map.set(pid, 'DEAD');
    }
    const fourth = await ensureBootstrap(ensureOptions(ctx, clock, providerWith(map), { spawnProcess, startTimeoutMs: 15, pollIntervalMs: 5 }));
    assert.equal(spawnCalls, 3);
    assert.equal(fourth.outcome, 'PAUSED');
    assert.equal(fourth.decision, 'PAUSED_BUDGET_HALTED');
    assert.equal(fourth.budget.attempts_in_window, 3);
    assert.deepEqual(outcomes, ['STARTED_OWNER_UNCONFIRMED', 'STARTED_OWNER_UNCONFIRMED', 'STARTED_OWNER_UNCONFIRMED']);
    const budget = JSON.parse(fs.readFileSync(ctx.paths.budget_file, 'utf8'));
    assert.equal(budget.attempts.length, 3);
  } finally {
    cleanup(ctx);
  }
});

// ---------------------------------------------------------------------------
// bootstrap guard (single spawn)
// ---------------------------------------------------------------------------

test('bootstrap guard: verified live holder -> IN_FLIGHT, unknown holder -> review', async () => {
  const ctx = makeContext();
  const clock = makeClock();
  try {
    writeGuard(ctx, { nonce: 'other-guard', pid: 7777 });
    let spawned = 0;
    const spawnProcess = () => { spawned += 1; throw new Error('must not spawn'); };
    const inFlight = await ensureBootstrap(ensureOptions(ctx, clock, providerWith(new Map([[7777, { ...HOST }]])), { spawnProcess }));
    assert.equal(inFlight.ok, true);
    assert.equal(inFlight.outcome, 'IN_FLIGHT');
    assert.equal(inFlight.in_flight, true);
    assert.equal(spawned, 0);
    assert.equal(fs.existsSync(ctx.paths.bootstrap_guard_file), true);

    const unknown = await ensureBootstrap(ensureOptions(ctx, clock, providerWith(new Map([[7777, 'UNKNOWN']])), { spawnProcess }));
    assert.equal(unknown.ok, false);
    assert.equal(unknown.decision, 'REVIEW_BOOTSTRAP_GUARD');
    assert.equal(spawned, 0);
    assert.equal(fs.existsSync(ctx.paths.bootstrap_guard_file), true);
  } finally {
    cleanup(ctx);
  }
});

test('a provably dead guard is archived (not deleted) before the single spawn', async () => {
  const ctx = makeContext();
  const clock = makeClock();
  const childPid = 9301;
  try {
    writeGuard(ctx, { nonce: 'stale-guard', pid: 7777 });
    const spawnProcess = () => {
      writeOwnerLock(ctx, { pid: childPid, nonce: 'guarded-owner', now: clock.now() });
      return fakeChild(childPid);
    };
    const result = await ensureBootstrap(ensureOptions(ctx, clock, providerWith(new Map([[7777, 'DEAD'], [childPid, { ...HOST }]])), { spawnProcess }));
    assert.equal(result.ok, true);
    assert.equal(result.outcome, 'STARTED_OWNER_VERIFIED');
    assertNoDir(ctx.paths.bootstrap_guard_file);
    const archived = fs.readdirSync(ctx.paths.companion_dir).filter((name) => name.startsWith('bootstrap-guard.json.stale-'));
    assert.equal(archived.length, 1);
  } finally {
    cleanup(ctx);
  }
});

test('concurrent ensure calls spawn only one companion', async () => {
  const ctx = makeContext();
  const clock = makeClock();
  const childPid = 9401;
  let spawnCalls = 0;
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  let resolveSpawned;
  const spawned = new Promise((resolve) => { resolveSpawned = resolve; });
  let ownerClaimed = false;
  const baseProvider = providerWith(new Map());
  const provider = async (pid) => {
    if (pid === childPid) {
      await gate;
      if (!ownerClaimed) {
        ownerClaimed = true;
        writeOwnerLock(ctx, { pid: childPid, nonce: 'concurrent-owner', now: clock.now() });
      }
      return { pid, available: true, alive: true, source: 'injected', ...HOST };
    }
    return baseProvider(pid);
  };
  const spawnProcess = () => {
    spawnCalls += 1;
    resolveSpawned();
    return fakeChild(childPid);
  };
  try {
    const firstPromise = ensureBootstrap(ensureOptions(ctx, clock, provider, { spawnProcess }));
    await spawned;
    assert.equal(spawnCalls, 1);
    const second = await ensureBootstrap(ensureOptions(ctx, clock, provider, { spawnProcess }));
    assert.equal(second.ok, true);
    assert.equal(second.outcome, 'IN_FLIGHT');
    assert.equal(second.in_flight, true);
    assert.equal(spawnCalls, 1);
    releaseGate();
    const first = await firstPromise;
    assert.equal(first.ok, true);
    assert.equal(first.outcome, 'STARTED_OWNER_VERIFIED');
    assert.equal(spawnCalls, 1);
  } finally {
    releaseGate();
    cleanup(ctx);
  }
});

// ---------------------------------------------------------------------------
// mode / runtime / entry guards
// ---------------------------------------------------------------------------

test('non-COMPANION_OWNED modes never spawn or write a stop marker', async () => {
  const clock = makeClock();
  for (const mode of ['DSH_PLUGIN_OWNED', 'EXTERNAL_UNMANAGED', 'MANUAL']) {
    const ctx = makeContext({ mode });
    try {
      let spawned = 0;
      const spawnProcess = () => { spawned += 1; throw new Error('must not spawn'); };
      const ensure = await ensureBootstrap(ensureOptions(ctx, clock, providerWith(), { spawnProcess }));
      assert.equal(ensure.ok, true);
      assert.equal(ensure.outcome, 'NO_ACTION');
      assert.equal(ensure.decision, 'MODE_NOT_MANAGED');
      assert.equal(spawned, 0);

      const stop = await stopBootstrap(stopOptions(ctx, clock, providerWith()));
      assert.equal(stop.ok, false);
      assert.equal(stop.decision, 'MODE_NOT_MANAGED');
      assertNoDir(ctx.paths.explicit_stop_file);
      assertNoDir(ctx.paths.desired_state_file);
    } finally {
      cleanup(ctx);
    }
  }
});

test('runtime conflicts fail closed without writes', async () => {
  const ctx = makeContext();
  const clock = makeClock();
  try {
    const before = snapshotTree(ctx.runtimeRoot);
    let spawned = 0;
    const spawnProcess = () => { spawned += 1; throw new Error('must not spawn'); };
    const envConflict = await ensureBootstrap(ensureOptions(ctx, clock, providerWith(), {
      spawnProcess,
      env: { LAB_BRIDGE_RUNTIME_DIR: path.join(ctx.root, 'other-runtime') },
    }));
    assert.equal(envConflict.ok, false);
    assert.equal(envConflict.decision, 'REVIEW_RUNTIME_CONFLICT');
    assert.equal(spawned, 0);
    assert.deepEqual(snapshotTree(ctx.runtimeRoot), before);

    const explicitConflict = await ensureBootstrap(ensureOptions(ctx, clock, providerWith(), {
      spawnProcess,
      runtimeDir: path.join(ctx.root, 'other-runtime'),
    }));
    assert.equal(explicitConflict.decision, 'REVIEW_RUNTIME_CONFLICT');
    assert.equal(spawned, 0);
    assert.deepEqual(snapshotTree(ctx.runtimeRoot), before);
  } finally {
    cleanup(ctx);
  }
});

test('a missing companion entry is review, not a spawn', async () => {
  const ctx = makeContext({ companionEntry: false });
  const clock = makeClock();
  try {
    let spawned = 0;
    const result = await ensureBootstrap(ensureOptions(ctx, clock, providerWith(), {
      spawnProcess: () => { spawned += 1; throw new Error('must not spawn'); },
    }));
    assert.equal(result.ok, false);
    assert.equal(result.decision, 'REVIEW_COMPANION_ENTRY');
    assert.equal(spawned, 0);
    assertNoDir(ctx.paths.budget_file);
  } finally {
    cleanup(ctx);
  }
});

test('explicit isolated runtime without an installation never spawns; stop is bounded to existing runtime', async () => {
  const root = tempRoot('bridge-bootstrap-dev-');
  const clock = makeClock();
  try {
    const runtimeRoot = path.join(root, 'runtime');
    fs.mkdirSync(runtimeRoot, { recursive: true });
    let spawned = 0;
    const spawnProcess = () => { spawned += 1; throw new Error('must not spawn'); };
    const plan = await planBootstrap({ installationRoot: root, runtimeDir: runtimeRoot, env: {}, now: clock.now, provider: providerWith() });
    assert.equal(plan.context.runtime_source, 'explicit-dev');
    assert.equal(plan.decisions.ensure.decision, 'NO_INSTALLATION');
    const result = await ensureBootstrap({ installationRoot: root, runtimeDir: runtimeRoot, env: {}, now: clock.now, provider: providerWith(), spawnProcess });
    assert.equal(result.ok, true);
    assert.equal(result.outcome, 'NO_ACTION');
    assert.equal(spawned, 0);
    assert.deepEqual(snapshotTree(runtimeRoot), []);

    const stop = await stopBootstrap({ installationRoot: root, runtimeDir: runtimeRoot, env: {}, now: clock.now, provider: providerWith(), sleep: clock.sleep, stopTimeoutMs: 10, pollIntervalMs: 5 });
    assert.equal(stop.ok, true);
    assert.equal(stop.decision, 'STOP_WRITE_MARKER');
    assert.equal(stop.confirmed, true);
    const marker = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'companion', 'explicit-stop.json'), 'utf8'));
    assert.equal(marker.explicit_stop, true);
    assert.equal(marker.installation_id, null);
    assert.equal(marker.runtime_root, runtimeRoot);

    // Explicit start on the dev runtime clears the marker only.
    const resume = await ensureBootstrap({ installationRoot: root, runtimeDir: runtimeRoot, env: {}, now: clock.now, provider: providerWith(), spawnProcess, explicitStart: true });
    assert.equal(resume.ok, true);
    assert.equal(resume.outcome, 'EXPLICIT_STOP_CLEARED');
    assert.equal(resume.explicit_stop_cleared, true);
    assert.equal(spawned, 0);

    const missing = path.join(root, 'missing-runtime');
    const missingStop = await stopBootstrap({ installationRoot: root, runtimeDir: missing, env: {}, now: clock.now, provider: providerWith(), sleep: clock.sleep, stopTimeoutMs: 10, pollIntervalMs: 5 });
    assert.equal(missingStop.ok, false);
    assert.equal(missingStop.decision, 'STOP_REVIEW_NO_RUNTIME');
    assert.equal(fs.existsSync(missing), false, 'stop must not initialize a runtime');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// explicit stop
// ---------------------------------------------------------------------------

test('stop persists marker + desired state, is idempotent, and preserves runtime data', async () => {
  const ctx = makeContext();
  const clock = makeClock();
  try {
    const hubDir = path.join(ctx.runtimeRoot, 'hub');
    fs.mkdirSync(hubDir, { recursive: true });
    const token = 'A'.repeat(64);
    fs.writeFileSync(ctx.paths.hub_token_file, token);
    const config = `${JSON.stringify({ v: 1, host: '127.0.0.1', port: 47831 })}\n`;
    fs.writeFileSync(ctx.paths.hub_config_file, config);
    const state = `${JSON.stringify({ v: 1, messages: [{ id: 'm-keep' }] })}\n`;
    fs.writeFileSync(ctx.paths.hub_state_file, state);

    const result = await stopBootstrap(stopOptions(ctx, clock, providerWith()));
    assert.equal(result.ok, true);
    assert.equal(result.confirmed, true);
    assert.equal(result.decision, 'STOP_WRITE_MARKER');
    assert.equal(result.explicit_stop_written, true);
    assert.equal(result.desired_state_written, true);
    assert.equal(result.signalled, false);
    assert.equal(result.review_required, false);
    const marker = JSON.parse(fs.readFileSync(ctx.paths.explicit_stop_file, 'utf8'));
    assert.equal(marker.explicit_stop, true);
    assert.equal(marker.installation_id, ctx.installation.installation_id);
    assert.equal(marker.runtime_root, ctx.runtimeRoot);
    assert.equal(JSON.parse(fs.readFileSync(ctx.paths.desired_state_file, 'utf8')).desired_state, 'STOPPED');
    // Runtime data preserved byte-for-byte.
    assert.equal(fs.readFileSync(ctx.paths.hub_token_file, 'utf8'), token);
    assert.equal(fs.readFileSync(ctx.paths.hub_config_file, 'utf8'), config);
    assert.equal(fs.readFileSync(ctx.paths.hub_state_file, 'utf8'), state);
    assert.equal(result.runtime_data.token, true);
    assert.equal(result.runtime_data.config, true);

    const markerBytes = fs.readFileSync(ctx.paths.explicit_stop_file, 'utf8');
    const second = await stopBootstrap(stopOptions(ctx, clock, providerWith()));
    assert.equal(second.ok, true);
    assert.equal(second.confirmed, true);
    assert.equal(second.already_stopped, true);
    assert.equal(second.explicit_stop_written, false);
    assert.equal(fs.readFileSync(ctx.paths.explicit_stop_file, 'utf8'), markerBytes, 'idempotent stop keeps the marker bytes');
    const status = await statusBootstrap({ installationRoot: ctx.root, env: {}, now: clock.now, provider: providerWith() });
    assert.equal(status.state, 'STOPPED_EXPLICIT');
  } finally {
    cleanup(ctx);
  }
});

test('stop signals only a reverified owner and confirms the stop without deleting a stale lock itself', async () => {
  const ctx = makeContext();
  const clock = makeClock();
  const ownerPid = 4321;
  const map = new Map([[ownerPid, { ...HOST }]]);
  const signals = [];
  try {
    writeOwnerLock(ctx, { pid: ownerPid, now: clock.now() });
    const result = await stopBootstrap(stopOptions(ctx, clock, providerWith(map), {
      signalProcess: (pid, signal) => {
        signals.push({ pid, signal });
        // Simulate the companion's own graceful shutdown: it releases its own
        // lease and exits; the bootstrap must not delete the lock itself.
        fs.rmSync(ctx.paths.hub_owner_lock_file, { force: true });
        map.set(ownerPid, 'DEAD');
      },
    }));
    assert.equal(result.signalled, true);
    assert.equal(result.signal_pid, ownerPid);
    assert.deepEqual(signals, [{ pid: ownerPid, signal: 'SIGTERM' }]);
    assert.equal(result.ok, true);
    assert.equal(result.confirmed, true);
    assert.equal(result.review_required, false);
    assert.equal(fs.existsSync(ctx.paths.explicit_stop_file), true);
    assert.equal(JSON.parse(fs.readFileSync(ctx.paths.desired_state_file, 'utf8')).desired_state, 'STOPPED');
    assertNoDir(ctx.paths.budget_file);
  } finally {
    cleanup(ctx);
  }
});

test('stop with an unknown or foreign owner persists the marker but never signals and reports review', async () => {
  const ctx = makeContext();
  const clock = makeClock();
  try {
    writeOwnerLock(ctx, { pid: 4321, now: clock.now() });
    const signals = [];
    const unknown = await stopBootstrap(stopOptions(ctx, clock, providerWith(new Map([[4321, 'UNKNOWN']])), {
      signalProcess: (pid, signal) => signals.push({ pid, signal }),
    }));
    assert.equal(unknown.signalled, false);
    assert.equal(unknown.confirmed, false);
    assert.equal(unknown.ok, false);
    assert.equal(unknown.review_required, true);
    assert.equal(unknown.decision, 'STOP_WRITE_MARKER_REVIEW_OWNER');
    assert.equal(fs.existsSync(ctx.paths.explicit_stop_file), true);
    assert.equal(signals.length, 0);
    assert.equal(fs.existsSync(ctx.paths.hub_owner_lock_file), true, 'owner lock is never deleted by bootstrap');

    const other = makeContext();
    try {
      writeOwnerLock(other, { pid: 4321, now: clock.now(), installationId: 'install-other' });
      const otherSignals = [];
      const lineage = await stopBootstrap(stopOptions(other, clock, providerWith(new Map([[4321, { ...HOST }]])), {
        signalProcess: (pid, signal) => otherSignals.push({ pid, signal }),
      }));
      assert.equal(lineage.signalled, false);
      assert.equal(lineage.decision, 'STOP_REVIEW_OWNER_LINEAGE');
      assert.equal(otherSignals.length, 0);
      assert.equal(fs.existsSync(other.paths.hub_owner_lock_file), true);
      assert.equal(fs.existsSync(other.paths.explicit_stop_file), true);
    } finally {
      cleanup(other);
    }
  } finally {
    cleanup(ctx);
  }
});

test('stop heals a corrupt explicit-stop marker by archiving it and writing a valid one', async () => {
  const ctx = makeContext();
  const clock = makeClock();
  try {
    fs.mkdirSync(path.dirname(ctx.paths.explicit_stop_file), { recursive: true });
    fs.writeFileSync(ctx.paths.explicit_stop_file, 'broken-marker', 'utf8');
    const result = await stopBootstrap(stopOptions(ctx, clock, providerWith()));
    assert.equal(result.ok, true);
    assert.equal(result.confirmed, true);
    assert.equal(result.decision, 'STOP_WRITE_MARKER_HEAL');
    assert.equal(result.marker_healed, true);
    assert.equal(result.explicit_stop_written, true);
    assert.notEqual(result.marker_archived, null);
    assert.equal(fs.readFileSync(result.marker_archived, 'utf8'), 'broken-marker');
    const marker = JSON.parse(fs.readFileSync(ctx.paths.explicit_stop_file, 'utf8'));
    assert.equal(marker.explicit_stop, true);
  } finally {
    cleanup(ctx);
  }
});

test('an ambiguous desired-state file is preserved and never overwritten by stop', async () => {
  const ctx = makeContext();
  const clock = makeClock();
  try {
    fs.writeFileSync(ctx.paths.desired_state_file, '{broken', 'utf8');
    const before = fs.readFileSync(ctx.paths.desired_state_file, 'utf8');
    const result = await stopBootstrap(stopOptions(ctx, clock, providerWith()));
    assert.equal(result.confirmed, true);
    assert.equal(result.desired_state_written, false);
    assert.equal(fs.readFileSync(ctx.paths.desired_state_file, 'utf8'), before);
    assert.equal(fs.existsSync(ctx.paths.explicit_stop_file), true);
  } finally {
    cleanup(ctx);
  }
});

// ---------------------------------------------------------------------------
// status summary
// ---------------------------------------------------------------------------

test('status reports compact ready/owned/stopped states and remains read-only', async () => {
  const ctx = makeContext();
  const clock = makeClock();
  const childPid = 9601;
  const childMap = new Map([[childPid, { ...HOST }]]);
  try {
    const ready = await statusBootstrap({ installationRoot: ctx.root, env: {}, now: clock.now, provider: providerWith() });
    assert.equal(ready.state, 'READY_TO_START');
    assert.equal(ready.action_hint, 'START');
    assert.equal(ready.owner_verified, false);
    assert.equal(ready.explicit_stop_active, false);

    const before = snapshotTree(ctx.runtimeRoot);
    const after = await statusBootstrap({ installationRoot: ctx.root, env: {}, now: clock.now, provider: providerWith() });
    assert.deepEqual(snapshotTree(ctx.runtimeRoot), before, 'status must not write');
    assert.equal(after.schema, STATUS_SCHEMA);
    assert.equal(after.plan.read_only, true);

    const spawnProcess = () => {
      writeOwnerLock(ctx, { pid: childPid, nonce: 'status-owner', now: clock.now() });
      return fakeChild(childPid);
    };
    const started = await ensureBootstrap(ensureOptions(ctx, clock, providerWith(childMap), { spawnProcess }));
    assert.equal(started.outcome, 'STARTED_OWNER_VERIFIED');
    const owned = await statusBootstrap({ installationRoot: ctx.root, env: {}, now: clock.now, provider: providerWith(childMap) });
    assert.equal(owned.state, 'OWNED_RUNNING');
    assert.equal(owned.action_hint, 'ATTACH');
    assert.equal(owned.owner_verified, true);

    const stopped = await stopBootstrap(stopOptions(ctx, clock, providerWith(childMap), {
      signalProcess: (pid) => {
        // Graceful companion shutdown: release its own lease and exit.
        fs.rmSync(ctx.paths.hub_owner_lock_file, { force: true });
        childMap.set(pid, 'DEAD');
      },
    }));
    assert.equal(stopped.confirmed, true);
    const stoppedStatus = await statusBootstrap({ installationRoot: ctx.root, env: {}, now: clock.now, provider: providerWith() });
    assert.equal(stoppedStatus.state, 'STOPPED_EXPLICIT');
    assert.equal(stoppedStatus.action_hint, 'NONE');
  } finally {
    cleanup(ctx);
  }
});

test('node executable resolution rejects Electron host binaries and accepts a verified node.exe', () => {
  const nodePath = resolveNodeExecutable({ nodeExecutable: process.execPath });
  assert.equal(path.resolve(nodePath), path.resolve(process.execPath));
  assert.equal(resolveNodeExecutable({ nodeExecutable: 'C:/Program Files/DeepSeek Harness/DeepSeek Harness.exe' }), null);
  const fromEnv = resolveNodeExecutable({ env: { LAB_BRIDGE_NODE_EXECUTABLE: process.execPath } });
  assert.equal(path.resolve(fromEnv), path.resolve(process.execPath));
});
