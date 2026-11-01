import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createCompanionHub } from '../src/companion-hub.mjs';
import { acquireHubOwner, hubOwnerLockFile } from '../src/hub-owner.mjs';
import { installationPaths } from '../src/installation.mjs';
import { runtimePaths, writeJsonAtomic } from '../src/runtime.mjs';
import { writeRestartSnapshotAtomic } from '../src/restart-state.mjs';

const processIdentity = {
  alive: true,
  available: true,
  source: 'injected',
  created_at: '2026-10-23T12:00:00.000Z',
  exe_path: path.join('C:', 'Program Files', 'nodejs', 'node.exe'),
  entry_path: path.join('C:', 'Dev', 'bridge', 'companion', 'main.mjs'),
};
const provider = (pid) => Promise.resolve({ pid, ...processIdentity });

function tempInstallation(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-companion-hub-'));
  const paths = installationPaths(root);
  fs.mkdirSync(paths.runtimeRoot, { recursive: true });
  return {
    root,
    paths,
    runtimeRoot: paths.runtimeRoot,
    installation: {
      installation_id: 'install-hub',
      instance_id: 'instance-hub',
      protocol_version: 1,
      hub_owner_kind: 'COMPANION_OWNED',
      runtime_root: paths.runtimeRoot,
      ...overrides,
    },
  };
}

function baseOptions(ctx, overrides = {}) {
  return {
    installation: ctx.installation,
    runtimeRoot: ctx.runtimeRoot,
    locatorPath: path.join(ctx.root, 'installation.json'),
    hubEntry: path.join(ctx.root, 'hub-main.mjs'),
    processProvider: provider,
    probeHub: async () => ({ state: 'ABSENT' }),
    spawnProcess: () => { throw new Error('must not spawn'); },
    now: () => Date.parse('2026-10-23T12:00:00Z'),
    ...overrides,
  };
}

function fakeChild(pid = 5000) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.kill = () => { child.exitCode = 0; child.emit('exit', 0, 'SIGTERM'); };
  return child;
}

test('non-COMPANION modes never acquire a lease or spawn a Hub', async () => {
  for (const mode of ['DSH_PLUGIN_OWNED', 'EXTERNAL_UNMANAGED', 'MANUAL']) {
    const ctx = tempInstallation({ hub_owner_kind: mode });
    try {
      const manager = createCompanionHub(baseOptions(ctx));
      const status = await manager.start();
      assert.equal(status.lifecycle, 'NOT_HUB_OWNER');
      assert.equal(fs.existsSync(hubOwnerLockFile(ctx.runtimeRoot)), false);
      await manager.stop();
    } finally {
      fs.rmSync(ctx.root, { recursive: true, force: true });
    }
  }
});

test('desired STOPPED wins over COMPANION_OWNED and leaves no lease', async () => {
  const ctx = tempInstallation();
  try {
    writeJsonAtomic(path.join(ctx.runtimeRoot, 'desired-state.json'), { desired_state: 'STOPPED' });
    const manager = createCompanionHub(baseOptions(ctx));
    const status = await manager.start();
    assert.equal(status.lifecycle, 'STOPPED_DESIRED');
    assert.equal(fs.existsSync(hubOwnerLockFile(ctx.runtimeRoot)), false);
    await manager.stop();
  } finally {
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
});

test('live/expired owner lease is REVIEW, not takeover or spawn', async () => {
  const ctx = tempInstallation();
  try {
    const lock = await acquireHubOwner({
      runtimeDir: ctx.runtimeRoot,
      installation: ctx.installation,
      mode: 'COMPANION_OWNED',
      owner_component: 'old-companion',
      owner_process: {
        pid: process.pid,
        created_at: processIdentity.created_at,
        exe_realpath: processIdentity.exe_path,
        entry_realpath: processIdentity.entry_path,
        config_path: path.join(ctx.root, 'installation.json'),
      },
      owner_epoch: 3,
      nonce: 'old-owner',
      now: 1_000,
      leaseMs: 1_000,
    });
    assert.equal(lock.ok, true);
    const manager = createCompanionHub(baseOptions(ctx, {
      now: () => 1_000_000,
      probeHub: async () => { throw new Error('must not probe before owner review'); },
    }));
    const status = await manager.start();
    assert.equal(status.lifecycle, 'OWNER_REVIEW_REQUIRED');
    assert.equal(fs.existsSync(hubOwnerLockFile(ctx.runtimeRoot)), true);
    await manager.stop();
  } finally {
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
});

test('same-instance external Hub is reused without spawn, then own lease is released', async () => {
  const ctx = tempInstallation();
  let spawned = 0;
  try {
    const manager = createCompanionHub(baseOptions(ctx, {
      probeHub: async () => ({ state: 'SAME', info: { installation_id: 'install-hub', instance_id: 'instance-hub', protocol_version: 1 } }),
      spawnProcess: () => { spawned += 1; throw new Error('must not spawn external Hub'); },
    }));
    const status = await manager.start();
    if (status.lifecycle !== 'READY') console.error('DEBUG', JSON.stringify(manager.status()));
    assert.equal(status.lifecycle, 'READY');
    assert.equal(status.reused_external, true);
    assert.equal(spawned, 0);
    assert.equal(fs.existsSync(hubOwnerLockFile(ctx.runtimeRoot)), true);
    await manager.stop();
    assert.equal(fs.existsSync(hubOwnerLockFile(ctx.runtimeRoot)), false);
  } finally {
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
});

test('COMPANION_OWNED starts only its own child, writes service state, and releases lease', async () => {
  const ctx = tempInstallation();
  let spawned = 0;
  let child = null;
  try {
    const manager = createCompanionHub(baseOptions(ctx, {
      probeHub: async () => (child === null ? { state: 'ABSENT' } : { state: 'SAME', info: { installation_id: 'install-hub', instance_id: 'instance-hub', protocol_version: 1 } }),
      spawnProcess: () => {
        spawned += 1;
        child = fakeChild();
        return child;
      },
    }));
    const status = await manager.start();
    assert.equal(status.lifecycle, 'READY');
    assert.equal(spawned, 1);
    assert.equal(status.child_pid, 5000);
    const serviceFile = path.join(ctx.runtimeRoot, 'companion', 'hub-service-state.json');
    assert.equal(fs.existsSync(serviceFile), true);
    const service = JSON.parse(fs.readFileSync(serviceFile, 'utf8'));
    assert.equal(service.component, 'hub');
    assert.equal(service.pid, 5000);
    assert.equal(service.state, 'READY');
    await manager.stop();
    assert.equal(fs.existsSync(hubOwnerLockFile(ctx.runtimeRoot)), false);
  } finally {
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
});
test('a second manager cannot take over an active owner lease or spawn a duplicate Hub', async () => {
  const ctx = tempInstallation();
  let spawned = 0;
  try {
    const options = baseOptions(ctx, {
      probeHub: async () => ({ state: 'SAME', info: { installation_id: 'install-hub', instance_id: 'instance-hub', protocol_version: 1 } }),
      spawnProcess: () => { spawned += 1; throw new Error('must not spawn'); },
    });
    const first = createCompanionHub(options);
    assert.equal((await first.start()).lifecycle, 'READY');
    const second = createCompanionHub(options);
    const secondStatus = await second.start();
    assert.equal(secondStatus.lifecycle, 'OWNER_REVIEW_REQUIRED');
    assert.equal(spawned, 0);
    await second.stop();
    await first.stop();
    assert.equal(fs.existsSync(hubOwnerLockFile(ctx.runtimeRoot)), false);
  } finally {
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
});
test('unreachable server-info with no verified owner is ORPHAN_REVIEW, not kill/spawn', async () => {
  const ctx = tempInstallation();
  try {
    const runtime = runtimePaths(ctx.runtimeRoot);
    fs.mkdirSync(runtime.hubDir, { recursive: true });
    writeJsonAtomic(runtime.serverInfoFile, { pid: 999999, host: '127.0.0.1', port: 1, server_id: 'orphan' });
    const manager = createCompanionHub(baseOptions(ctx, {
      probeHub: async () => ({ state: 'UNREACHABLE', code: 'ECONNREFUSED' }),
      spawnProcess: () => { throw new Error('must not spawn over an orphan'); },
    }));
    const status = await manager.start();
    assert.equal(status.lifecycle, 'ORPHAN_REVIEW');
    const service = JSON.parse(fs.readFileSync(path.join(ctx.runtimeRoot, 'companion', 'hub-service-state.json'), 'utf8'));
    assert.equal(service.reason_code, 'ORPHAN_REVIEW_REQUIRED');
    await manager.stop();
  } finally {
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
});
test('persisted Hub restart budget and corrupt state fail closed', async () => {
  const ctx = tempInstallation();
  let spawned = 0;
  try {
    const policyFile = path.join(ctx.runtimeRoot, 'companion', 'hub-restart-state.json');
    writeRestartSnapshotAtomic(policyFile, {
      attempts: 2,
      failures: 2,
      halted: true,
      stable_since: null,
      last_failure_at: null,
      next_retry_at: null,
      last_reason_code: 'HUB_RESTART_LIMIT',
      failure_times: [],
    });
    const manager = createCompanionHub(baseOptions(ctx, {
      probeHub: async () => ({ state: 'SAME', info: { installation_id: 'install-hub', instance_id: 'instance-hub', protocol_version: 1 } }),
      spawnProcess: () => { spawned += 1; return fakeChild(); },
    }));
    assert.equal((await manager.start()).lifecycle, 'HALTED');
    assert.equal(spawned, 0);
    await manager.stop();
  } finally {
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }

  const corrupt = tempInstallation();
  try {
    const companionDir = path.join(corrupt.runtimeRoot, 'companion');
    fs.mkdirSync(companionDir, { recursive: true });
    fs.writeFileSync(path.join(companionDir, 'hub-restart-state.json'), '{not-json');
    const manager = createCompanionHub(baseOptions(corrupt, {
      probeHub: async () => ({ state: 'SAME' }),
      spawnProcess: () => { spawned += 1; return fakeChild(); },
    }));
    assert.equal((await manager.start()).lifecycle, 'HALTED');
    assert.equal(spawned, 0);
    await manager.stop();
  } finally {
    fs.rmSync(corrupt.root, { recursive: true, force: true });
  }
});

test('stop with fresh reused identity only marks STOP_UNCONFIRMED and keeps the lease', async () => {
  const ctx = tempInstallation();
  let child = null;
  let phase = 'original';
  try {
    const options = baseOptions(ctx, {
      probeHub: async () => (child === null ? { state: 'ABSENT' } : { state: 'SAME', info: { installation_id: 'install-hub', instance_id: 'instance-hub', protocol_version: 1 } }),
      processProvider: (pid) => Promise.resolve({
        pid,
        alive: true,
        available: true,
        source: 'injected',
        created_at: phase === 'original' ? processIdentity.created_at : '2026-10-23T12:00:05.000Z',
        exe_path: processIdentity.exe_path,
        entry_path: processIdentity.entry_path,
      }),
      spawnProcess: () => { child = fakeChild(); return child; },
    });
    const manager = createCompanionHub(options);
    assert.equal((await manager.start()).lifecycle, 'READY');
    phase = 'reused';
    let killed = false;
    child.kill = () => { killed = true; };
    await manager.stop();
    assert.equal(manager.status().lifecycle, 'STOP_UNCONFIRMED');
    assert.equal(killed, false);
    assert.equal(fs.existsSync(hubOwnerLockFile(ctx.runtimeRoot)), true);
  } finally {
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
});

test('desired STOPPED observed at runtime stops, and dead-owner recovery archives only own dead lease', async () => {
  const ctx = tempInstallation();
  let child = null;
  try {
    const options = baseOptions(ctx, {
      probeHub: async () => (child === null ? { state: 'ABSENT' } : { state: 'SAME', info: { installation_id: 'install-hub', instance_id: 'instance-hub', protocol_version: 1 } }),
      spawnProcess: () => { child = fakeChild(); return child; },
      heartbeatMs: 10,
      processProvider: (pid) => Promise.resolve({
        pid,
        alive: pid !== 4321,
        available: pid !== 4321,
        source: 'injected',
        created_at: processIdentity.created_at,
        exe_path: processIdentity.exe_path,
        entry_path: processIdentity.entry_path,
      }),
    });
    const manager = createCompanionHub(options);
    assert.equal((await manager.start()).lifecycle, 'READY');
    writeJsonAtomic(path.join(ctx.runtimeRoot, 'desired-state.json'), { desired_state: 'STOPPED' });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(manager.status().desired_state, 'STOPPED');
    assert.notEqual(manager.status().owner_epoch, 0);
    await manager.stop();
    const second = createCompanionHub(options);
    assert.equal((await second.start()).lifecycle, 'STOPPED_DESIRED');
    await second.stop();
  } finally {
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }

  const dead = tempInstallation();
  try {
    const locatorPath = path.join(dead.root, 'installation.json');
    const owner = await acquireHubOwner({
      runtimeDir: dead.runtimeRoot,
      installation: dead.installation,
      mode: 'COMPANION_OWNED',
      owner_component: 'companion',
      owner_process: {
        pid: 4321,
        created_at: processIdentity.created_at,
        exe_realpath: processIdentity.exe_path,
        entry_realpath: processIdentity.entry_path,
        config_path: locatorPath,
      },
      owner_epoch: 1,
      nonce: 'dead-owner',
      now: 1_000,
      leaseMs: 1_000,
    });
    assert.equal(owner.ok, true);
    const manager = createCompanionHub(baseOptions(dead, {
      probeHub: async () => ({ state: 'SAME' }),
      processProvider: (pid) => Promise.resolve({
        pid,
        alive: pid !== 4321,
        available: pid !== 4321,
        source: 'injected',
        created_at: processIdentity.created_at,
        exe_path: processIdentity.exe_path,
        entry_path: processIdentity.entry_path,
      }),
      spawnProcess: () => { throw new Error('must reuse'); },
    }));
    const status = await manager.start();
    assert.equal(status.lifecycle, 'READY');
    assert.ok(status.owner_epoch >= 2);
    await manager.stop();
  } finally {
    fs.rmSync(dead.root, { recursive: true, force: true });
  }
});
test('corrupt desired-state file is HALTED/UNKNOWN, not RUNNING, and does not acquire a lease', async () => {
  const ctx = tempInstallation();
  let spawned = 0;
  try {
    writeJsonAtomic(path.join(ctx.runtimeRoot, 'desired-state.json'), { desired_state: 'MAYBE' });
    const manager = createCompanionHub(baseOptions(ctx, {
      probeHub: async () => ({ state: 'SAME' }),
      spawnProcess: () => { spawned += 1; return fakeChild(); },
    }));
    const status = await manager.start();
    assert.equal(status.lifecycle, 'HALTED');
    assert.notEqual(status.lifecycle, 'READY');
    assert.equal(spawned, 0);
    assert.equal(fs.existsSync(hubOwnerLockFile(ctx.runtimeRoot)), false);
    await manager.stop();
  } finally {
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
});
test('spawn error and fast child exit are bounded diagnostics, not unhandled crashes', async () => {
  const spawnErrorCtx = tempInstallation();
  try {
    let spawned = 0;
    const manager = createCompanionHub(baseOptions(spawnErrorCtx, {
      probeHub: async () => ({ state: 'ABSENT' }),
      autoRestart: false,
      spawnProcess: () => {
        spawned += 1;
        const child = new EventEmitter();
        child.pid = 6001;
        child.exitCode = null;
        child.kill = () => {};
        process.nextTick(() => child.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' })));
        return child;
      },
    }));
    await manager.start();
    assert.equal(spawned, 1);
    assert.notEqual(manager.status().lifecycle, 'READY');
    assert.equal(typeof manager.status().last_error, 'string');
    await manager.stop();
  } finally {
    fs.rmSync(spawnErrorCtx.root, { recursive: true, force: true });
  }

  const fastExitCtx = tempInstallation();
  try {
    let spawned = 0;
    const manager = createCompanionHub(baseOptions(fastExitCtx, {
      probeHub: async () => ({ state: 'ABSENT' }),
      autoRestart: false,
      spawnProcess: () => {
        spawned += 1;
        const child = new EventEmitter();
        child.pid = 6002;
        child.exitCode = null;
        child.kill = () => {};
        process.nextTick(() => { child.exitCode = 1; child.emit('exit', 1, null); });
        return child;
      },
    }));
    await manager.start();
    assert.equal(spawned, 1);
    assert.notEqual(manager.status().lifecycle, 'READY');
    await manager.stop();
  } finally {
    fs.rmSync(fastExitCtx.root, { recursive: true, force: true });
  }
});
test('policy write failure during ready is HALTED, not overwritten to READY', async () => {
  const ctx = tempInstallation();
  let spawned = 0;
  try {
    let childStarted = false;
    const manager = createCompanionHub(baseOptions(ctx, {
      probeHub: async () => childStarted ? ({ state: 'SAME', info: { installation_id: 'install-hub', instance_id: 'instance-hub', protocol_version: 1 } }) : ({ state: 'ABSENT' }),
      spawnProcess: () => { spawned += 1; childStarted = true; return fakeChild(); },
      policyWriter: () => { throw new Error('injected policy write failure'); },
    }));
    const status = await manager.start();
    assert.equal(status.lifecycle, 'HALTED');
    assert.equal(status.policy_corrupt, true);
    assert.equal(status.last_error, 'HUB_RESTART_STATE_WRITE_FAILED');
    assert.notEqual(status.lifecycle, 'READY');
    assert.equal(spawned, 1);
    await manager.start();
    assert.equal(spawned, 1);
  } finally {
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
});

test('heartbeat probes fresh health, cancels stable window and never clears prior failures on loss', async () => {
  const ctx = tempInstallation();
  let online = true;
  let probes = 0;
  let child = null;
  let killCalls = 0;
  try {
    const policyFile = path.join(ctx.runtimeRoot, 'companion', 'hub-restart-state.json');
    writeRestartSnapshotAtomic(policyFile, {
      attempts: 2,
      failures: 2,
      halted: false,
      stable_since: null,
      last_failure_at: null,
      next_retry_at: null,
      last_reason_code: 'prior-failure',
      failure_times: [new Date().toISOString(), new Date().toISOString()],
    });
    const manager = createCompanionHub(baseOptions(ctx, {
      probeHub: async () => {
        probes += 1;
        return online && child !== null
          ? { state: 'SAME', info: { installation_id: 'install-hub', instance_id: 'instance-hub', protocol_version: 1 } }
          : online ? { state: 'ABSENT' } : { state: 'UNREACHABLE', code: 'HUB_PROBE_TIMEOUT' };
      },
      spawnProcess: () => { child = fakeChild(); const originalKill = child.kill; child.kill = () => { killCalls += 1; originalKill(); }; return child; },
      heartbeatMs: 15,
      stableMs: 60,
    }));
    assert.equal((await manager.start()).lifecycle, 'READY');
    const initialProbes = probes;
    online = false;
    await new Promise((resolve) => setTimeout(resolve, 120));
    const status = manager.status();
    assert.ok(status.health_probe_count > initialProbes);
    assert.notEqual(status.lifecycle, 'READY');
    assert.ok(['HUB_UNRESPONSIVE', 'EXTERNAL_OFFLINE'].includes(status.lifecycle));
    assert.equal(status.restart_policy.stable_since, null);
    assert.equal(status.restart_policy.failures, 2);
    assert.equal(status.restart_policy.attempts, 2);
    assert.equal(killCalls, 0);
    await manager.stop();
  } finally {
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
});

test('external Hub loss is reported offline without takeover or lease release', async () => {
  const ctx = tempInstallation();
  let online = true;
  let spawned = 0;
  try {
    const manager = createCompanionHub(baseOptions(ctx, {
      probeHub: async () => online
        ? { state: 'SAME', info: { installation_id: 'install-hub', instance_id: 'instance-hub', protocol_version: 1 } }
        : { state: 'UNREACHABLE', code: 'HUB_PROBE_TIMEOUT' },
      spawnProcess: () => { spawned += 1; throw new Error('must not spawn'); },
      heartbeatMs: 15,
    }));
    assert.equal((await manager.start()).lifecycle, 'READY');
    online = false;
    await new Promise((resolve) => setTimeout(resolve, 80));
    const status = manager.status();
    assert.equal(status.lifecycle, 'EXTERNAL_OFFLINE');
    assert.equal(status.health, 'OFFLINE');
    assert.equal(status.reused_external, true);
    assert.equal(spawned, 0);
    assert.equal(fs.existsSync(hubOwnerLockFile(ctx.runtimeRoot)), true);
    await manager.stop();
  } finally {
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
});
test('provider exception on adopted Hub stop is UNKNOWN, not dead: no server delete or lease release', async () => {
  const ctx = tempInstallation();
  const hubPid = 4321;
  let phase = 'live';
  try {
    const runtime = (await import('../src/runtime.mjs')).runtimePaths(ctx.runtimeRoot);
    fs.mkdirSync(path.dirname(runtime.serverInfoFile), { recursive: true });
    fs.mkdirSync(path.join(ctx.runtimeRoot, 'companion'), { recursive: true });
    const child = {
      pid: hubPid,
      created_at: '2026-10-23T12:00:00.000Z',
      exe_path: 'C:\\Program Files\\nodejs\\node.exe',
      entry_path: path.join(ctx.root, 'hub-main.mjs'),
    };
    writeJsonAtomic(runtime.serverInfoFile, { pid: hubPid, host: '127.0.0.1', port: 1, installation_id: 'install-hub', instance_id: 'instance-hub' });
    fs.writeFileSync(path.join(ctx.runtimeRoot, 'companion', 'hub-generation.json'), JSON.stringify({
      v: 1, installation_id: 'install-hub', instance_id: 'instance-hub',
      owner_mode: 'COMPANION_OWNED', owner_epoch: 1, owner_nonce: 'old', generation: 1,
      child, server_pid: hubPid, started_at: '2026-10-23T12:00:00.000Z', last_exit: null,
    }));
    const manager = createCompanionHub(baseOptions(ctx, {
      probeHub: async () => ({ state: 'SAME', info: { installation_id: 'install-hub', instance_id: 'instance-hub', protocol_version: 1 } }),
      processProvider: (pid) => {
        if (phase === 'throw' && pid === hubPid) return Promise.reject(new Error('provider exception'));
        if (pid === hubPid) return Promise.resolve({ pid, alive: true, available: true, source: 'injected', ...child });
        return provider(pid);
      },
    }));
    const status = await manager.start();
    assert.equal(status.adopted_own_hub, true);
    phase = 'throw';
    await manager.stop();
    assert.equal(manager.status().lifecycle, 'STOP_UNCONFIRMED');
    assert.equal(fs.existsSync(runtime.serverInfoFile), true);
    assert.equal(fs.existsSync(hubOwnerLockFile(ctx.runtimeRoot)), true);
  } finally {
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
});