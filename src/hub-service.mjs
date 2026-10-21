// Managed Hub companion.
//
// A DSH bundle should not require the user to locate a node_modules/.bin path
// just to start the Hub. The plugin owns a small child process when (and only
// when) no Hub is already running. The child shares the plugin's runtime dir.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT, RUNTIME_DIR } from './runtime.mjs';
import { serverInfoHealth } from './health.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class HubServiceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'HubServiceError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Create a Hub supervisor owned by the caller (usually the DSH plugin).
 * It never kills a Hub it did not start; existing Hub processes are reused.
 */
export function createHubService({
  runtimeDir = RUNTIME_DIR,
  hubEntry = path.join(PROJECT_ROOT, 'hub', 'main.mjs'),
  projectRoot = PROJECT_ROOT,
  nodeExecutable = process.execPath,
  log = () => {},
  startTimeoutMs = 8_000,
  stopTimeoutMs = 4_000,
  spawnProcess = spawn,
} = {}) {
  const serverInfoFile = path.join(runtimeDir, 'hub', 'server.json');
  let child = null;
  let spawnError = null;

  const health = () => serverInfoHealth({ serverInfoFile });

  function status() {
    const info = health();
    return {
      ...info,
      managed: child !== null,
      owned: child !== null && info.pid === child.pid,
      service_pid: child?.pid,
      exit_code: child?.exitCode ?? null,
    };
  }

  function cleanupOwnedServerInfo(pid) {
    try {
      const info = health();
      if (info.present && info.pid === pid) fs.rmSync(serverInfoFile, { force: true });
    } catch {
      /* best effort */
    }
  }

  function waitForExit(processHandle, timeoutMs) {
    return new Promise((resolve) => {
      if (processHandle.exitCode !== null) {
        resolve(true);
        return;
      }
      const timer = setTimeout(() => {
        processHandle.off('exit', onExit);
        resolve(false);
      }, timeoutMs);
      const onExit = () => {
        clearTimeout(timer);
        resolve(true);
      };
      processHandle.once('exit', onExit);
    });
  }

  async function ensureStarted({ timeoutMs = startTimeoutMs } = {}) {
    const existing = health();
    if (existing.present && existing.pidAlive) {
      log('hub-service/reuse', { pid: existing.pid, address: existing.address });
      return { ok: true, started: false, reused: true, ...status() };
    }

    if (child === null || child.exitCode !== null) {
      spawnError = null;
      child = spawnProcess(nodeExecutable, [hubEntry], {
        cwd: projectRoot,
        env: { ...process.env, LAB_BRIDGE_RUNTIME_DIR: runtimeDir },
        stdio: 'ignore',
        windowsHide: true,
      });
      child.once('error', (error) => {
        spawnError = error;
        log('hub-service/spawn-error', { message: String(error?.message ?? error) });
      });
      child.once('exit', (code, signal) => {
        log('hub-service/child-exit', { code, signal, pid: child?.pid });
      });
      log('hub-service/spawned', { pid: child.pid, hubEntry, runtimeDir });
    }

    const launched = child;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (spawnError !== null) {
        throw new HubServiceError('spawn-failed', String(spawnError?.message ?? spawnError), status());
      }
      if (launched.exitCode !== null) {
        throw new HubServiceError('hub-exit', `managed hub exited with code ${launched.exitCode}`, status());
      }
      const info = health();
      if (info.present && info.pidAlive && info.pid === launched.pid) {
        log('hub-service/ready', { pid: info.pid, address: info.address });
        return { ok: true, started: true, reused: false, ...status() };
      }
      await sleep(50);
    }
    await stop();
    throw new HubServiceError('hub-timeout', `managed hub was not ready within ${timeoutMs}ms`, status());
  }

  /** Stop only a Hub process started by this service instance. */
  async function stop() {
    const current = child;
    if (current === null) return { ok: true, stopped: false, reason: 'not-managed' };
    child = null;
    if (current.exitCode !== null) {
      cleanupOwnedServerInfo(current.pid);
      return { ok: true, stopped: false, reason: 'already-exited', exitCode: current.exitCode };
    }
    log('hub-service/stopping', { pid: current.pid });
    try {
      current.kill('SIGTERM');
    } catch {
      /* process already gone */
    }
    const exited = await waitForExit(current, stopTimeoutMs);
    if (!exited) {
      try {
        current.kill('SIGKILL');
      } catch {
        /* process already gone */
      }
      await waitForExit(current, 2_000);
    }
    cleanupOwnedServerInfo(current.pid);
    log('hub-service/stopped', { pid: current.pid, exitCode: current.exitCode });
    return { ok: true, stopped: true, pid: current.pid, exitCode: current.exitCode };
  }

  return { ensureStarted, stop, status };
}
