// Managed Hub companion.
//
// A DSH bundle should not require the user to locate a node_modules/.bin path
// just to start the Hub. The plugin owns a small child process when (and only
// when) no Hub is already running. The child shares the plugin's runtime dir.
//
// The companion supervises only its own child: an externally started Hub is
// reused and never killed. Unexpected child exits are retried with bounded
// backoff so a transient Hub crash self-heals while the DSH host stays up.
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
  autoRestart = true,
  maxRestartAttempts = 10,
  restartDelaysMs = [1_000, 2_000, 5_000, 10_000, 30_000],
  spawnProcess = spawn,
} = {}) {
  const serverInfoFile = path.join(runtimeDir, 'hub', 'server.json');
  let child = null;
  let spawnError = null;
  let stopping = false;
  let restartTimer = null;
  let restartAttempts = 0;
  let restartCount = 0;
  let lastExit = null;
  let nextRestartAt = null;
  let lastRestartError = null;
  let autoRestartHalted = false;

  const health = () => serverInfoHealth({ serverInfoFile });

  function status() {
    const info = health();
    return {
      ...info,
      managed: child !== null,
      owned: child !== null && info.pid === child.pid,
      service_pid: child?.pid,
      exit_code: child?.exitCode ?? null,
      auto_restart: autoRestart && !stopping,
      auto_restart_halted: autoRestartHalted,
      restart_count: restartCount,
      restart_attempts: restartAttempts,
      next_restart_at: nextRestartAt,
      last_exit: lastExit,
      last_restart_error: lastRestartError,
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

  function clearRestartTimer() {
    if (restartTimer !== null) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    nextRestartAt = null;
  }

  function scheduleRestart(reason) {
    if (!autoRestart || stopping || autoRestartHalted || restartTimer !== null) return;
    if (restartAttempts >= maxRestartAttempts) {
      autoRestartHalted = true;
      log('hub-service/restart-halted', { attempts: restartAttempts, reason });
      return;
    }
    const delay = restartDelaysMs[Math.min(restartAttempts, restartDelaysMs.length - 1)] ?? 1_000;
    restartAttempts += 1;
    nextRestartAt = new Date(Date.now() + delay).toISOString();
    log('hub-service/restart-scheduled', { delay, attempt: restartAttempts, reason });
    const timer = setTimeout(async () => {
      restartTimer = null;
      nextRestartAt = null;
      if (stopping) return;
      try {
        const result = await ensureStarted({ timeoutMs: startTimeoutMs });
        restartCount += 1;
        restartAttempts = 0;
        lastRestartError = null;
        log('hub-service/restarted', { pid: result.pid, restart_count: restartCount });
      } catch (error) {
        lastRestartError = {
          code: error?.code ?? 'restart-failed',
          message: String(error?.message ?? error),
          at: new Date().toISOString(),
        };
        log('hub-service/restart-failed', {
          code: lastRestartError.code,
          message: lastRestartError.message,
          attempt: restartAttempts,
        });
        if (restartAttempts >= maxRestartAttempts) {
          autoRestartHalted = true;
          log('hub-service/restart-halted', { attempts: restartAttempts, reason: 'restart-failed' });
        } else {
          scheduleRestart('restart-failed');
        }
      }
    }, delay);
    timer.unref?.();
    restartTimer = timer;
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
    // A manual ensure overrides a pending backoff timer; the companion will
    // try immediately instead of waiting out the previous delay.
    if (restartTimer !== null) clearRestartTimer();

    const existing = health();
    if (existing.present && existing.pidAlive) {
      log('hub-service/reuse', { pid: existing.pid, address: existing.address });
      return { ok: true, started: false, reused: true, ...status() };
    }

    if (child === null || child.exitCode !== null) {
      spawnError = null;
      const handle = spawnProcess(nodeExecutable, [hubEntry], {
        cwd: projectRoot,
        env: { ...process.env, LAB_BRIDGE_RUNTIME_DIR: runtimeDir },
        stdio: 'ignore',
        windowsHide: true,
      });
      child = handle;
      handle.once('error', (error) => {
        spawnError = error;
        log('hub-service/spawn-error', { message: String(error?.message ?? error) });
      });
      handle.once('exit', (code, signal) => {
        lastExit = { code, signal, pid: handle.pid, at: new Date().toISOString() };
        if (child === handle) child = null;
        log('hub-service/child-exit', { code, signal, pid: handle.pid });
        scheduleRestart('child-exit');
      });
      log('hub-service/spawned', { pid: handle.pid, hubEntry, runtimeDir });
    }

    const launched = child;
    if (launched === null) throw new HubServiceError('spawn-failed', 'managed hub process was not created', status());
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (spawnError !== null) {
        scheduleRestart('spawn-error');
        throw new HubServiceError('spawn-failed', String(spawnError?.message ?? spawnError), status());
      }
      if (launched.exitCode !== null) {
        throw new HubServiceError('hub-exit', `managed hub exited with code ${launched.exitCode}`, status());
      }
      const info = health();
      if (info.present && info.pidAlive && info.pid === launched.pid) {
        autoRestartHalted = false;
        restartAttempts = 0;
        log('hub-service/ready', { pid: info.pid, address: info.address });
        return { ok: true, started: true, reused: false, ...status() };
      }
      await sleep(50);
    }
    await stop();
    scheduleRestart('start-timeout');
    throw new HubServiceError('hub-timeout', `managed hub was not ready within ${timeoutMs}ms`, status());
  }

  /** Stop only a Hub process started by this service instance. */
  async function stop() {
    clearRestartTimer();
    stopping = true;
    const current = child;
    if (current === null) {
      stopping = false;
      return { ok: true, stopped: false, reason: 'not-managed' };
    }
    child = null;
    if (current.exitCode !== null) {
      cleanupOwnedServerInfo(current.pid);
      stopping = false;
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
    stopping = false;
    log('hub-service/stopped', { pid: current.pid, exitCode: current.exitCode });
    return { ok: true, stopped: true, pid: current.pid, exitCode: current.exitCode };
  }

  return { ensureStarted, stop, status };
}
