// Read-only health inspection for hub runtime artifacts.
import fs from 'node:fs';

export function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Cross-platform process existence probe (signal 0). */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * Inspect the hub's server.json without connecting.
 * A non-alive recorded PID means the file is stale (crash or unclean stop).
 */
export function serverInfoHealth({ serverInfoFile }) {
  const info = readJsonSafe(serverInfoFile);
  if (info === undefined) return { present: false, stale: false };
  const alive = pidAlive(info.pid);
  return {
    present: true,
    pid: info.pid,
    port: info.port,
    address: info.address,
    started_at: info.started_at,
    server_id: info.server_id,
    pidAlive: alive,
    stale: !alive,
  };
}
