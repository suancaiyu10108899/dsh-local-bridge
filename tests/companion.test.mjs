import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createMembership,
  registerMembershipDisable,
  registerMembershipEnable,
  targetKey,
  writeMembershipAtomic,
} from '../src/membership.mjs';
import { createCompanion, sanitizeWorkerEnv } from '../src/companion.mjs';
import { restartSnapshotPath } from '../src/restart-state.mjs';

const fakeWorker = path.resolve(import.meta.dirname, 'fixtures', 'fake-worker.mjs');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-companion-'));
}

async function waitFor(fn, { timeoutMs = 3_000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitFor timeout');
}

function setup(overrides = {}) {
  const root = tempRoot();
  const installation = {
    installation_id: 'install-1',
    instance_id: 'instance-1',
    app_root: path.join(root, 'app'),
    runtime_root: path.join(root, 'runtime'),
    hub_owner_kind: 'COMPANION_OWNED',
  };
  fs.mkdirSync(installation.app_root, { recursive: true });
  fs.mkdirSync(installation.runtime_root, { recursive: true });
  const runtimeRoot = installation.runtime_root;
  const configDir = path.join(runtimeRoot, 'codex', '01a99999-9999-4999-8999-999999999999');
  fs.mkdirSync(configDir, { recursive: true });
  const locatorPath = path.join(root, 'installation.json');
  fs.writeFileSync(locatorPath, '{}');
  const configPath = path.join(configDir, 'receiver-config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    thread_id: '01a99999-9999-4999-8999-999999999999',
    installation_id: installation.installation_id,
    instance_id: installation.instance_id,
    binding_epoch: 'epoch-1',
    enabled: true,
    owner_opt_in: true,
    runtime_dir: configDir,
    locator: locatorPath,
  }));
  const outputPath = path.join(root, 'worker-output.json');
  const statusPath = path.join(configDir, 'status.json');
  const fakeExe = path.join('C:', 'Program Files', 'nodejs', 'node.exe');
  const identity = {
    created_at: '2026-10-23T12:00:00.000Z',
    exe_path: fakeExe,
    entry_path: path.join(root, 'tests', 'fixtures', 'fake-worker.mjs'),
    thread_id: '01a99999-9999-4999-8999-999999999999',
  };
  const companion = createCompanion({
    installation,
    runtimeRoot,
    locatorPath,
    workerEntry: fakeWorker,
    workerCwd: root,
    env: {
      ...process.env,
      CODEX_THREAD_ID: 'ambient-conversation',
      FAKE_WORKER_OUT: outputPath,
      FAKE_WORKER_EXIT_MS: overrides.exitMs ?? '0',
      FAKE_WORKER_STATUS: statusPath,
      FAKE_WORKER_INSTALLATION_ID: installation.installation_id,
      FAKE_WORKER_INSTANCE_ID: installation.instance_id,
      FAKE_WORKER_THREAD_ID: identity.thread_id,
      FAKE_WORKER_BINDING_EPOCH: overrides.workerBindingEpoch ?? 'epoch-1',
      FAKE_WORKER_HEARTBEAT_OFFSET_MS: overrides.heartbeatOffsetMs ?? '0',
      FAKE_WORKER_CREATED_AT: identity.created_at,
      FAKE_WORKER_EXE: identity.exe_path,
      FAKE_WORKER_ENTRY: identity.entry_path,
      FAKE_WORKER_STATUS_STATE: overrides.workerStatusState ?? 'ONLINE_IDLE',
    },
    processProvider: overrides.processProvider ?? ((pid) => Promise.resolve({
      pid,
      alive: true,
      available: true,
      source: 'injected',
      created_at: identity.created_at,
      exe_path: identity.exe_path,
      entry_path: identity.entry_path,
    })),
    healthPollMs: 20,
    policyWriter: overrides.policyWriter,
    restartDelaysMs: overrides.restartDelaysMs ?? [25],
    maxRestartAttempts: overrides.maxRestartAttempts ?? 2,
    stableMs: overrides.stableMs ?? 60_000,
  });
  return { root, installation, runtimeRoot, membershipsRoot: runtimeRoot, configPath, locatorPath, outputPath, statusPath, identity, companion };
}

async function cleanup(setupValue) {
  await setupValue.companion.stop();
  fs.rmSync(setupValue.root, { recursive: true, force: true });
}

test('COMPANION_OWNED starts one direct worker with sanitized ambient env and recovers once', async () => {
  const s = setup({ exitMs: '0', restartDelaysMs: [20], maxRestartAttempts: 2 });
  try {
    writeMembershipAtomic(s.membershipsRoot, createMembership({
      installation_id: s.installation.installation_id,
      instance_id: s.installation.instance_id,
      target: 'codex:01a99999-9999-4999-8999-999999999999',
      binding_epoch: 'epoch-1',
      config_path: s.configPath,
      desired_state: 'ENABLED',
      enabled: true,
      owner_opt_in: true,
      owner_opt_in_at: '2026-10-23T12:00:00.000Z',
      start_at_logon: false,
    }));
    const status = s.companion.start({ reason: 'USER_ENABLE' });
    assert.equal(status.targets['codex:01a99999-9999-4999-8999-999999999999'].start_reason, 'USER_ENABLE');
    await waitFor(() => fs.existsSync(s.outputPath));
    const output = JSON.parse(fs.readFileSync(s.outputPath, 'utf8'));
    assert.equal(output.thread, null);
    assert.equal(output.args.length, 2);
    assert.equal(output.args[0], s.configPath);
    assert.equal(s.companion.status().targets['codex:01a99999-9999-4999-8999-999999999999'].lifecycle, 'RUNNING');

    registerMembershipDisable({ root: s.membershipsRoot, target: 'codex:01a99999-9999-4999-8999-999999999999' });
    await s.companion.syncOnce();
    await waitFor(() => {
      const lifecycle = s.companion.status().targets['codex:01a99999-9999-4999-8999-999999999999'].lifecycle;
      return lifecycle === 'STOPPED' || lifecycle === 'DISABLED';
    });
  } finally {
    await cleanup(s);
  }
});

test('companion halts its own worker after bounded restarts and does not use receiver-service', async () => {
  const s = setup({ exitMs: '40', restartDelaysMs: [20], maxRestartAttempts: 2 });
  try {
    registerMembershipEnable({
      root: s.membershipsRoot,
      installation_id: s.installation.installation_id,
      instance_id: s.installation.instance_id,
      target: 'codex:01a99999-9999-4999-8999-999999999999',
      binding_epoch: 'epoch-1',
      config_path: s.configPath,
    });
    s.companion.start({ reason: 'USER_ENABLE' });
    await waitFor(() => s.companion.status().targets['codex:01a99999-9999-4999-8999-999999999999'].lifecycle === 'HALTED', { timeoutMs: 4_000 });
    const state = s.companion.status().targets['codex:01a99999-9999-4999-8999-999999999999'];
    assert.equal(state.restart_count >= 2, true);
    assert.equal(state.lifecycle, 'HALTED');
  } finally {
    await cleanup(s);
  }
});

test('legacy membership is not spawned by the companion and ambient thread is stripped', async () => {
  const s = setup();
  try {
    writeMembershipAtomic(s.membershipsRoot, createMembership({
      installation_id: s.installation.installation_id,
      instance_id: s.installation.instance_id,
      target: 'codex:01a99999-9999-4999-8999-999999999999',
      binding_epoch: 'epoch-1',
      config_path: s.configPath,
      receiver_kind: 'legacy',
      desired_state: 'ENABLED',
      enabled: true,
      owner_opt_in: true,
      owner_opt_in_at: '2026-10-23T12:00:00.000Z',
      start_at_logon: false,
    }));
    s.companion.syncOnce();
    assert.equal(s.companion.status().targets['codex:01a99999-9999-4999-8999-999999999999'].lifecycle, 'LEGACY_MANUAL');
    assert.equal(sanitizeWorkerEnv({ CODEX_THREAD_ID: 'ambient', KEEP: 'x' }).CODEX_THREAD_ID, undefined);
    assert.equal(sanitizeWorkerEnv({ CODEX_THREAD_ID: 'ambient', KEEP: 'x' }).KEEP, 'x');
    const sanitized = sanitizeWorkerEnv({
      KEEP: 'x', LAB_BRIDGE_RUNTIME_DIR: 'D:\\wrong-runtime', LAB_BRIDGE_INSTALLATION_ROOT: 'D:\\wrong-install',
    });
    assert.equal(sanitized.LAB_BRIDGE_RUNTIME_DIR, undefined);
    assert.equal(sanitized.LAB_BRIDGE_INSTALLATION_ROOT, undefined);
  } finally {
    await cleanup(s);
  }
});
test('mode other than COMPANION_OWNED refuses to manage workers', () => {
  const root = tempRoot();
  try {
    assert.throws(() => createCompanion({
      installation: { installation_id: 'i', instance_id: 'n', app_root: root, runtime_root: root, hub_owner_kind: 'MANUAL' },
      runtimeRoot: root,
      workerEntry: fakeWorker,
      workerCwd: root,
    }), (error) => error.code === 'COMPANION_MODE_REQUIRED');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('LOGON_AUTOSTART does not start a target whose start_at_logon is false', async () => {
  const s = setup();
  try {
    registerMembershipEnable({
      root: s.membershipsRoot,
      installation_id: s.installation.installation_id,
      instance_id: s.installation.instance_id,
      target: 'codex:01a99999-9999-4999-8999-999999999999',
      binding_epoch: 'epoch-1',
      config_path: s.configPath,
      start_at_logon: false,
    });
    s.companion.start({ reason: 'LOGON_AUTOSTART' });
    assert.equal(s.companion.status().targets['codex:01a99999-9999-4999-8999-999999999999'].lifecycle, 'PAUSED_LOGON_OPT_OUT');
    assert.equal(fs.existsSync(s.outputPath), false);
    s.companion.syncOnce({ reason: 'USER_ENABLE' });
    await waitFor(() => fs.existsSync(s.outputPath));
  } finally {
    await cleanup(s);
  }
});

test('config target mismatch pauses instead of starting', async () => {
  const s = setup();
  try {
    fs.writeFileSync(s.configPath, JSON.stringify({ thread_id: 'different-thread' }));
    registerMembershipEnable({
      root: s.membershipsRoot,
      installation_id: s.installation.installation_id,
      instance_id: s.installation.instance_id,
      target: 'codex:01a99999-9999-4999-8999-999999999999',
      binding_epoch: 'epoch-1',
      config_path: s.configPath,
    });
    s.companion.start({ reason: 'USER_ENABLE' });
    const state = s.companion.status().targets['codex:01a99999-9999-4999-8999-999999999999'];
    assert.equal(state.lifecycle, 'TARGET_PAUSED');
    assert.equal(state.last_error, 'CONFIG_TARGET_MISMATCH');
    assert.equal(fs.existsSync(s.outputPath), false);
  } finally {
    await cleanup(s);
  }
});

test('halted policy persists across companion restart and requires explicit reset', async () => {
  const s = setup({ exitMs: '40', restartDelaysMs: [20], maxRestartAttempts: 2 });
  let second;
  try {
    registerMembershipEnable({
      root: s.membershipsRoot,
      installation_id: s.installation.installation_id,
      instance_id: s.installation.instance_id,
      target: 'codex:01a99999-9999-4999-8999-999999999999',
      binding_epoch: 'epoch-1',
      config_path: s.configPath,
    });
    s.companion.start({ reason: 'USER_ENABLE' });
    const target = 'codex:01a99999-9999-4999-8999-999999999999';
    await waitFor(() => s.companion.status().targets[target].lifecycle === 'HALTED', { timeoutMs: 4_000 });
    const halted = s.companion.status().targets[target];
    await s.companion.stop();
    second = createCompanion({
      installation: s.installation,
      runtimeRoot: s.runtimeRoot,
      locatorPath: s.locatorPath,
      workerEntry: fakeWorker,
      workerCwd: s.root,
      env: { ...process.env, CODEX_THREAD_ID: 'ambient-conversation', FAKE_WORKER_OUT: s.outputPath, FAKE_WORKER_EXIT_MS: '40' },
      restartDelaysMs: [20],
      maxRestartAttempts: 2,
      stableMs: 60_000,
    });
    second.start({ reason: 'USER_ENABLE' });
    assert.equal(second.status().targets[target].halted, true);
    assert.equal(second.status().targets[target].lifecycle, 'HALTED');
    second.syncOnce({ reason: 'USER_ENABLE' });
    assert.equal(second.status().targets[target].lifecycle, 'HALTED');
    second.resetTarget(target);
    const reset = second.status().targets[target];
    assert.equal(reset.halted, false);
    assert.equal(reset.restart_attempts, 0);
    assert.ok(halted.restart_count >= 2);
  } finally {
    await second?.stop();
    await cleanup(s);
  }
});
test('spawn error enters bounded retry, never a stuck RUNNING worker', async () => {
  const s = setup();
  const broken = createCompanion({
    installation: s.installation,
    runtimeRoot: s.runtimeRoot,
    locatorPath: s.locatorPath,
    workerEntry: fakeWorker,
    workerCwd: s.root,
    nodeExecutable: path.join(s.root, 'missing-node.exe'),
    env: { ...process.env, FAKE_WORKER_OUT: s.outputPath },
    restartDelaysMs: [20],
    maxRestartAttempts: 1,
    stableMs: 60_000,
  });
  try {
    await s.companion.stop();
    registerMembershipEnable({
      root: s.membershipsRoot,
      installation_id: s.installation.installation_id,
      instance_id: s.installation.instance_id,
      target: 'codex:01a99999-9999-4999-8999-999999999999',
      binding_epoch: 'epoch-1',
      config_path: s.configPath,
    });
    broken.start({ reason: 'USER_ENABLE' });
    const target = 'codex:01a99999-9999-4999-8999-999999999999';
    await waitFor(() => broken.status().targets[target].lifecycle === 'HALTED', { timeoutMs: 3_000 });
    assert.equal(broken.status().targets[target].lifecycle, 'HALTED');
    assert.equal(broken.status().targets[target].pid, null);
  } finally {
    await broken.stop();
    await cleanup(s);
  }
});
test('LOGON_AUTOSTART opt-out stays off through repeated recovery syncs', async () => {
  const s = setup();
  try {
    registerMembershipEnable({
      root: s.membershipsRoot,
      installation_id: s.installation.installation_id,
      instance_id: s.installation.instance_id,
      target: 'codex:01a99999-9999-4999-8999-999999999999',
      binding_epoch: 'epoch-1',
      config_path: s.configPath,
      start_at_logon: false,
    });
    const target = 'codex:01a99999-9999-4999-8999-999999999999';
    s.companion.start({ reason: 'LOGON_AUTOSTART' });
    assert.equal(s.companion.status().targets[target].lifecycle, 'PAUSED_LOGON_OPT_OUT');
    for (let i = 0; i < 4; i += 1) s.companion.syncOnce({ reason: 'RECOVERY' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(s.companion.status().targets[target].lifecycle, 'PAUSED_LOGON_OPT_OUT');
    assert.equal(fs.existsSync(s.outputPath), false);
  } finally {
    await cleanup(s);
  }
});
test('partial persisted restart state halts for review instead of resetting budget', async () => {
  const s = setup();
  try {
    const target = 'codex:01a99999-9999-4999-8999-999999999999';
    const file = restartSnapshotPath(path.join(s.runtimeRoot, 'companion'), targetKey(target));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ attempts: 2 }));
    registerMembershipEnable({
      root: s.membershipsRoot,
      installation_id: s.installation.installation_id,
      instance_id: s.installation.instance_id,
      target,
      binding_epoch: 'epoch-1',
      config_path: s.configPath,
    });
    s.companion.start({ reason: 'USER_ENABLE' });
    const state = s.companion.status().targets[target];
    assert.equal(state.policy_corrupt, true);
    assert.equal(state.halted, true);
    assert.equal(state.lifecycle, 'HALTED');
    assert.equal(fs.existsSync(s.outputPath), false);
  } finally {
    await cleanup(s);
  }
});
test('stable window requires repeated v3 identity/health proof, not spawn alone', async () => {
  const s = setup({ stableMs: 150 });
  try {
    const target = 'codex:01a99999-9999-4999-8999-999999999999';
    registerMembershipEnable({
      root: s.membershipsRoot,
      installation_id: s.installation.installation_id,
      instance_id: s.installation.instance_id,
      target,
      binding_epoch: 'epoch-1',
      config_path: s.configPath,
    });
    s.companion.start({ reason: 'USER_ENABLE' });
    await waitFor(() => s.companion.status().targets[target].health_verified === true);
    await waitFor(() => s.companion.status().targets[target].stable === true, { timeoutMs: 2_000 });
    assert.equal(s.companion.status().targets[target].stable, true);
  } finally {
    await cleanup(s);
  }
});

test('PAUSED worker status is never promoted to health/stable and unverified stop is cooperative', async () => {
  const s = setup({ workerStatusState: 'PAUSED_UNCERTAIN' });
  const target = 'codex:01a99999-9999-4999-8999-999999999999';
  try {
    registerMembershipEnable({
      root: s.membershipsRoot,
      installation_id: s.installation.installation_id,
      instance_id: s.installation.instance_id,
      target,
      binding_epoch: 'epoch-1',
      config_path: s.configPath,
    });
    s.companion.start({ reason: 'USER_ENABLE' });
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(s.companion.status().targets[target].health_verified, false);
    assert.equal(s.companion.status().targets[target].stable, false);
    const stopped = await s.companion.stop();
    assert.equal(stopped.targets[target].lifecycle, 'STOP_UNCONFIRMED');
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 150));
    cleanup(s);
  }
});
test('legacy config missing production fields cannot start under companion', async () => {
  const s = setup();
  try {
    fs.writeFileSync(s.configPath, JSON.stringify({
      thread_id: '01a99999-9999-4999-8999-999999999999',
      installation_id: s.installation.installation_id,
      instance_id: s.installation.instance_id,
      binding_epoch: 'epoch-1',
    }));
    registerMembershipEnable({
      root: s.membershipsRoot,
      installation_id: s.installation.installation_id,
      instance_id: s.installation.instance_id,
      target: 'codex:01a99999-9999-4999-8999-999999999999',
      binding_epoch: 'epoch-1',
      config_path: s.configPath,
    });
    s.companion.start({ reason: 'USER_ENABLE' });
    const state = s.companion.status().targets['codex:01a99999-9999-4999-8999-999999999999'];
    assert.equal(state.lifecycle, 'TARGET_PAUSED');
    assert.equal(state.last_error, 'CONFIG_DISABLED');
    assert.equal(fs.existsSync(s.outputPath), false);
  } finally {
    await cleanup(s);
  }
});

test('config runtime outside installation root is rejected', async () => {
  const s = setup();
  try {
    fs.writeFileSync(s.configPath, JSON.stringify({
      thread_id: '01a99999-9999-4999-8999-999999999999',
      installation_id: s.installation.installation_id,
      instance_id: s.installation.instance_id,
      binding_epoch: 'epoch-1',
      enabled: true,
      owner_opt_in: true,
      runtime_dir: path.join(process.env.TEMP ?? os.tmpdir(), 'outside-runtime'),
      locator: s.locatorPath,
    }));
    registerMembershipEnable({
      root: s.membershipsRoot,
      installation_id: s.installation.installation_id,
      instance_id: s.installation.instance_id,
      target: 'codex:01a99999-9999-4999-8999-999999999999',
      binding_epoch: 'epoch-1',
      config_path: s.configPath,
    });
    s.companion.start({ reason: 'USER_ENABLE' });
    const state = s.companion.status().targets['codex:01a99999-9999-4999-8999-999999999999'];
    assert.equal(state.lifecycle, 'TARGET_PAUSED');
    assert.equal(state.last_error, 'CONFIG_RUNTIME_OUTSIDE_INSTALL');
    assert.equal(fs.existsSync(s.outputPath), false);
  } finally {
    await cleanup(s);
  }
});
test('a new registration nonce is a real owner enable and overrides logon opt-out', async () => {
  const s = setup();
  const target = 'codex:01a99999-9999-4999-8999-999999999999';
  try {
    registerMembershipEnable({
      root: s.membershipsRoot,
      installation_id: s.installation.installation_id,
      instance_id: s.installation.instance_id,
      target,
      binding_epoch: 'epoch-1',
      config_path: s.configPath,
      start_at_logon: false,
    });
    s.companion.start({ reason: 'LOGON_AUTOSTART' });
    assert.equal(s.companion.status().targets[target].lifecycle, 'PAUSED_LOGON_OPT_OUT');
    registerMembershipEnable({
      root: s.membershipsRoot,
      installation_id: s.installation.installation_id,
      instance_id: s.installation.instance_id,
      target,
      binding_epoch: 'epoch-1',
      config_path: s.configPath,
      start_at_logon: false,
    });
    s.companion.syncOnce({ reason: 'RECOVERY' });
    await waitFor(() => fs.existsSync(s.outputPath));
    await waitFor(() => s.companion.status().targets[target].health_verified === true);
  } finally {
    await cleanup(s);
  }
});
test('stop rechecks fresh identity and a reused PID is not killed', async () => {
  let reuseIdentity = false;
  const s = setup({
    processProvider: (pid) => Promise.resolve(reuseIdentity
      ? {
          pid,
          alive: true,
          available: true,
          source: 'injected',
          created_at: '2026-10-23T12:00:05.000Z',
          exe_path: path.join('C:', 'Program Files', 'nodejs', 'node.exe'),
          entry_path: path.join(s.root, 'tests', 'fixtures', 'fake-worker.mjs'),
        }
      : {
          pid,
          alive: true,
          available: true,
          source: 'injected',
          created_at: '2026-10-23T12:00:00.000Z',
          exe_path: path.join('C:', 'Program Files', 'nodejs', 'node.exe'),
          entry_path: path.join(s.root, 'tests', 'fixtures', 'fake-worker.mjs'),
        }),
  });
  const target = 'codex:01a99999-9999-4999-8999-999999999999';
  try {
    registerMembershipEnable({
      root: s.membershipsRoot,
      installation_id: s.installation.installation_id,
      instance_id: s.installation.instance_id,
      target,
      binding_epoch: 'epoch-1',
      config_path: s.configPath,
    });
    s.companion.start({ reason: 'USER_ENABLE' });
    await waitFor(() => s.companion.status().targets[target].health_verified === true);
    reuseIdentity = true;
    registerMembershipDisable({ root: s.membershipsRoot, target });
    s.companion.syncOnce();
    await waitFor(() => s.companion.status().targets[target].stop_unconfirmed === true);
    const state = s.companion.status().targets[target];
    assert.equal(state.stop_unconfirmed, true);
    assert.equal(state.stop_verified, false);
    assert.equal(state.lifecycle, 'STOP_UNCONFIRMED');
  } finally {
    await cleanup(s);
  }
});
test('worker status with wrong binding epoch or future heartbeat is not healthy', async () => {
  const wrongEpoch = setup({ workerBindingEpoch: 'epoch-other' });
  try {
    const target = 'codex:01a99999-9999-4999-8999-999999999999';
    registerMembershipEnable({
      root: wrongEpoch.membershipsRoot,
      installation_id: wrongEpoch.installation.installation_id,
      instance_id: wrongEpoch.installation.instance_id,
      target,
      binding_epoch: 'epoch-1',
      config_path: wrongEpoch.configPath,
    });
    wrongEpoch.companion.start({ reason: 'USER_ENABLE' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(wrongEpoch.companion.status().targets[target].health_verified, false);
  } finally {
    await cleanup(wrongEpoch);
  }

  const future = setup({ heartbeatOffsetMs: '60000' });
  try {
    const target = 'codex:01a99999-9999-4999-8999-999999999999';
    registerMembershipEnable({
      root: future.membershipsRoot,
      installation_id: future.installation.installation_id,
      instance_id: future.installation.instance_id,
      target,
      binding_epoch: 'epoch-1',
      config_path: future.configPath,
    });
    future.companion.start({ reason: 'USER_ENABLE' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(future.companion.status().targets[target].health_verified, false);
  } finally {
    await cleanup(future);
  }
});
test('worker policy persistence failure halts and prevents further automatic forks', async () => {
  const s = setup({ exitMs: '60000', policyWriter: () => { throw new Error('injected policy write failure'); } });
  try {
    registerMembershipEnable({
      root: s.membershipsRoot,
      installation_id: s.installation.installation_id,
      instance_id: s.installation.instance_id,
      target: 'codex:01a99999-9999-4999-8999-999999999999',
      binding_epoch: 'epoch-1',
      config_path: s.configPath,
      registration_nonce: 'reg-policy-write-failure',
    });
    s.companion.start({ reason: 'USER_ENABLE' });
    const state = await waitFor(() => {
      const target = s.companion.status().targets['codex:01a99999-9999-4999-8999-999999999999'];
      return target?.policy_persist_failed === true ? target : null;
    }, { timeoutMs: 3_000 });
    assert.equal(state.policy_persist_failed, true);
    assert.equal(state.lifecycle, 'HALTED');
    assert.match(String(state.last_error), /RESTART_STATE_WRITE_FAILED/);
    const before = s.companion.status().targets['codex:01a99999-9999-4999-8999-999999999999'];
    await new Promise((resolve) => setTimeout(resolve, 150));
    const after = s.companion.status().targets['codex:01a99999-9999-4999-8999-999999999999'];
    assert.equal(after.pid, before.pid);
    assert.equal(after.lifecycle, 'HALTED');
    assert.equal(after.policy_persist_failed, true);
  } finally {
    await s.companion.stop();
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});
test('DSH_START resumes an explicitly enabled receiver despite logon opt-out, without adding a login task', async () => {
  const s = setup();
  const target = 'codex:01a99999-9999-4999-8999-999999999999';
  try {
    registerMembershipEnable({
      root: s.membershipsRoot,
      installation_id: s.installation.installation_id,
      instance_id: s.installation.instance_id,
      target,
      binding_epoch: 'epoch-1',
      config_path: s.configPath,
      start_at_logon: false,
    });
    s.companion.start({ reason: 'LOGON_AUTOSTART' });
    assert.equal(s.companion.status().targets[target].lifecycle, 'PAUSED_LOGON_OPT_OUT');
    assert.equal(fs.existsSync(s.outputPath), false);
    s.companion.syncOnce({ reason: 'DSH_START' });
    await waitFor(() => fs.existsSync(s.outputPath));
    assert.notEqual(s.companion.status().targets[target].lifecycle, 'PAUSED_LOGON_OPT_OUT');
  } finally {
    await cleanup(s);
  }
});