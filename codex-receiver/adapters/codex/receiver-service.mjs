// Supervises only our own target worker. Never restarts a shared host or Hub.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readJsonSafe, pidAlive } from '../../src/health.mjs';
import { writeJsonAtomic } from '../../src/runtime.mjs';
import { validateReceiverConfig } from './queue-inbox.mjs';

export function recoverOwnLock(file, config) {
  if (!fs.existsSync(file)) return;
  const lock = readJsonSafe(file);
  if (!lock || lock.thread_id !== config.thread_id || pidAlive(lock.pid)) throw new Error('LOCK_REVIEW_REQUIRED');
  fs.renameSync(file, `${file}.stale-${Date.now()}`);
}

export async function serveReceiver(file, firstInstance = crypto.randomUUID()) {
  const c = validateReceiverConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (c.mode !== 'daily' || !c.enabled) return;
  const serviceLock = path.join(c.runtime_dir, 'service.lock');
  const existing = readJsonSafe(serviceLock);
  if (existing?.thread_id === c.thread_id && pidAlive(existing.pid)) return;
  recoverOwnLock(serviceLock, c);
  fs.writeFileSync(serviceLock, JSON.stringify({ pid: process.pid, thread_id: c.thread_id, config_path: path.resolve(file) }), { flag: 'wx' });
  let restartCount = 0, instance = firstInstance;
  try {
    while (readJsonSafe(file)?.enabled === true && !fs.existsSync(path.join(c.runtime_dir, 'stop'))) {
      recoverOwnLock(path.join(c.runtime_dir, 'receiver.lock'), c);
      writeJsonAtomic(path.join(c.runtime_dir, 'service-status.json'), { pid: process.pid, thread_id: c.thread_id,
        status: 'SUPERVISING', at: new Date().toISOString(), restart_count: restartCount });
      const child = spawn(process.execPath, [fileURLToPath(new URL('./daily-receiver.mjs', import.meta.url)), path.resolve(file), instance],
        { windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'] });
      const result = await new Promise((resolve) => {
        child.once('error', (error) => resolve({ error: error.message }));
        child.once('exit', (code) => resolve({ exit_code: code }));
      });
      if (readJsonSafe(file)?.enabled !== true || fs.existsSync(path.join(c.runtime_dir, 'stop'))) break;
      restartCount++;
      const delay = Math.min(1000 * 2 ** Math.min(restartCount - 1, 5), 30000);
      writeJsonAtomic(path.join(c.runtime_dir, 'service-status.json'), { pid: process.pid, thread_id: c.thread_id,
        status: 'BACKOFF_WORKER', at: new Date().toISOString(), restart_count: restartCount, ...result });
      const end = Date.now() + delay;
      while (Date.now() < end && readJsonSafe(file)?.enabled === true && !fs.existsSync(path.join(c.runtime_dir, 'stop'))) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      instance = crypto.randomUUID();
    }
    writeJsonAtomic(path.join(c.runtime_dir, 'service-status.json'), { pid: process.pid, thread_id: c.thread_id,
      status: 'DISABLED', at: new Date().toISOString(), restart_count: restartCount });
  } finally { fs.unlinkSync(serviceLock); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serveReceiver(process.argv[2], process.argv[3]).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
