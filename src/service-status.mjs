// Read-only service status shared by the DSH tools and the operator CLI.
import path from 'node:path';
import { RUNTIME_DIR } from './runtime.mjs';
import { defaultInstallationRoot, readInstallation } from './installation.mjs';
import { compareCodeIdentities, computeCodeIdentity, readComponentIdentity } from './code-identity.mjs';
import { serverInfoHealth } from './health.mjs';
import { readReceiverStatuses } from './receiver-status.mjs';

function readInstalledIdentity(locator, now) {
  if (locator === null || typeof locator.app_root !== 'string') return null;
  try {
    return computeCodeIdentity({
      rootDir: locator.app_root,
      component: 'hub',
      entry: path.join(locator.app_root, 'hub', 'main.mjs'),
      now,
    });
  } catch {
    return null;
  }
}

/**
 * Collect local Hub/receiver state without connecting, starting or mutating
 * anything. The identity layers are deliberately separate: locator declaration,
 * current installed program, and the identity the running Hub loaded at startup.
 */
export function collectServiceStatus({ runtimeDir = RUNTIME_DIR, installationRoot = null, now = Date.now() } = {}) {
  const serverInfoFile = path.join(runtimeDir, 'hub', 'server.json');
  const receivers = readReceiverStatuses({ runtimeDir, now });
  const root = installationRoot ?? defaultInstallationRoot();
  let locator = null;
  try {
    locator = readInstallation({ root });
  } catch {
    locator = null;
  }
  const hub = serverInfoHealth({ serverInfoFile });
  const declared = locator === null ? null : {
    package_version: locator.active_version,
    source_sha256: locator.code_identity?.source_sha256 ?? null,
    entry: locator.code_identity?.entry ?? null,
    loaded_at: locator.code_identity?.loaded_at ?? null,
    release_channel: null,
  };
  const installed = readInstalledIdentity(locator, now);
  const running = hub.code_identity ?? null;
  const dshPluginIdentity = readComponentIdentity({ runtimeDir, component: 'dsh-plugin' });
  return {
    runtime_dir: runtimeDir,
    hub,
    receiver_root: receivers.root,
    receivers: receivers.receivers,
    identity: {
      hub: compareCodeIdentities({ declared, installed, running }),
      dsh_plugin: dshPluginIdentity === null ? { status: 'UNVERIFIED' } : {
        status: 'OBSERVED',
        source_sha256: dshPluginIdentity.source_sha256 ?? null,
        package_version: dshPluginIdentity.package_version ?? null,
        entry: dshPluginIdentity.entry ?? null,
        loaded_at: dshPluginIdentity.loaded_at ?? null,
        release_channel: dshPluginIdentity.release_channel ?? null,
        released: dshPluginIdentity.released === true,
      },
      read_only: true,
    },
  };
}
