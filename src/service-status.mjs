// Read-only service status shared by the DSH tools and the operator CLI.
import path from 'node:path';
import { RUNTIME_DIR } from './runtime.mjs';
import { serverInfoHealth } from './health.mjs';
import { readReceiverStatuses } from './receiver-status.mjs';

/**
 * Collect local Hub/receiver state without connecting, starting or mutating
 * anything. Callers may add live connection details on top.
 */
export function collectServiceStatus({ runtimeDir = RUNTIME_DIR, now = Date.now() } = {}) {
  const serverInfoFile = path.join(runtimeDir, 'hub', 'server.json');
  const receivers = readReceiverStatuses({ runtimeDir, now });
  return {
    runtime_dir: runtimeDir,
    hub: serverInfoHealth({ serverInfoFile }),
    receiver_root: receivers.root,
    receivers: receivers.receivers,
  };
}
