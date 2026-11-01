// Legacy/manual supervisor only. The installed companion launches workers directly.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readJsonSafe } from '../../src/health.mjs';
import { writeJsonAtomic } from '../../src/runtime.mjs';
import { createRestartPolicy } from '../../src/restart-policy.mjs';
import { validateReceiverConfig } from './queue-inbox.mjs';
import { receiverInstallation } from './receiver-context.mjs';
import { claimReceiverProcess, recoverReceiverLock } from './receiver-identity.mjs';
import { refreshInstalledCli } from './installed-cli.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function serveReceiver(file, firstInstance = crypto.randomUUID(), { identityProvider, now = Date.now, spawnWorker = spawn, restartOptions = {} } = {}) {
  const c = validateReceiverConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (c.mode !== 'daily' || !c.enabled) return;
  if (receiverInstallation(c)) throw new Error('COMPANION_OWNS_INSTALLED_WORKERS');
  await refreshInstalledCli(c, file, { verifyCapabilities: false });
  const lease = await claimReceiverProcess(c, file, 'service', { provider: identityProvider, now: now() });
  const policyFile = path.join(c.runtime_dir, 'service-restart.json');
  const saved = readJsonSafe(policyFile);
  const validPolicy = (value) => value && typeof value === 'object' && !Array.isArray(value) &&
    Number.isSafeInteger(value.attempts) && value.attempts >= 0 && Number.isSafeInteger(value.failures) && value.failures >= 0 &&
    typeof value.halted === 'boolean' && Array.isArray(value.failure_times) && value.failure_times.every((at) => Number.isFinite(Date.parse(at)));
  if (fs.existsSync(policyFile) && (!saved || saved.scope !== 'worker:' + c.thread_id || !validPolicy(saved.policy))) {
    writeJsonAtomic(path.join(c.runtime_dir, 'service-status.json'), { ...lease.statusFields, status: 'HALTED', reason_code: 'RESTART_STATE_REVIEW_REQUIRED' });
    lease.release(); throw new Error('RESTART_STATE_REVIEW_REQUIRED');
  }
  const policy = createRestartPolicy({ ...restartOptions, now, snapshot: saved?.policy });
  let instance = firstInstance, restartCount = saved?.restart_count ?? 0;
  let lastExit = saved?.last_exit ?? null, stopRequested = false;
  const enabled = () => !stopRequested && readJsonSafe(file)?.enabled === true && !fs.existsSync(path.join(c.runtime_dir, 'stop'));
  const persist = () => writeJsonAtomic(policyFile, { v: 1, scope: 'worker:' + c.thread_id,
    restart_count: restartCount, last_exit: lastExit, policy: policy.snapshot() });
  const publish = (status, reason = null) => {
    lease.heartbeat(now());
    writeJsonAtomic(path.join(c.runtime_dir, 'service-status.json'), { ...lease.statusFields, thread_id: c.thread_id,
      status, reason_code: reason, at: new Date(now()).toISOString(), heartbeat_at: new Date(now()).toISOString(),
      restart_count: restartCount, restart_policy: policy.snapshot(), last_exit: lastExit, cli_version: c.cli_version });
    persist();
  };
  const stop = () => { stopRequested = true; fs.writeFileSync(path.join(c.runtime_dir, 'stop'), new Date(now()).toISOString()); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  try {
    while (enabled()) {
      if (policy.snapshot().halted) { publish('HALTED', 'WORKER_RESTART_LIMIT'); return; }
      const due = Date.parse(policy.snapshot().next_retry_at);
      if (Number.isFinite(due) && now() < due) {
        publish('BACKOFF_WORKER'); await wait(Math.min(1000, due - now())); continue;
      }
      await recoverReceiverLock(c, file, 'worker', { provider: identityProvider, now: now() });
      const child = spawnWorker(process.execPath, [fileURLToPath(new URL('./daily-receiver.mjs', import.meta.url)), path.resolve(file), instance],
        { windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'] });
      publish('SUPERVISING');
      let timer;
      const result = await new Promise((resolve) => {
        let settled = false;
        const finish = (value) => { if (settled) return; settled = true; clearInterval(timer); resolve(value); };
        child.once('error', (error) => finish({ code: null, signal: null, reason: error.code ?? error.message }));
        child.once('exit', (code, signal) => finish({ code, signal: signal ?? null, reason: code === 0 ? 'WORKER_EXITED' : 'WORKER_FAILED' }));
        timer = setInterval(() => {
          try {
            const worker = readJsonSafe(path.join(c.runtime_dir, 'status.json'));
            if (worker?.worker_nonce === instance && worker.pid === child.pid && Date.parse(worker.heartbeat_at) > now() - 30000 &&
                ['ONLINE_IDLE', 'WAITING_FOR_TARGET_IDLE', 'RATE_LIMITED', 'WAITING_COOLDOWN'].includes(worker.status)) {
              policy.recordHealthy({ at: now() }); policy.recordStable({ at: now() });
            }
            publish('SUPERVISING');
          } catch (error) { finish({ code: null, signal: null, reason: error.code ?? error.message }); }
        }, 1000);
      });
      clearInterval(timer);
      lastExit = { ...result, at: new Date(now()).toISOString() };
      if (!enabled()) break;
      restartCount++;
      policy.recordFailure({ at: now(), code: result.reason });
      publish(policy.snapshot().halted ? 'HALTED' : 'BACKOFF_WORKER', result.reason);
      instance = crypto.randomUUID();
    }
    publish('DISABLED', 'DISABLED_BY_OWNER');
  } finally {
    process.off('SIGTERM', stop); process.off('SIGINT', stop);
    lease.release();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serveReceiver(process.argv[2], process.argv[3]).catch((error) => { console.error(error.code ?? error.message); process.exitCode = 1; });
}
