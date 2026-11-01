import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolvePluginRuntime } from '../adapters/dsh/plugin.mjs';
import { writeInstallationAtomic } from '../src/installation.mjs';

test('neutral app resolves all plugin data paths from installation.runtime_root without ambient override', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-plugin-runtime-'));
  try {
    const localAppData = path.join(root, 'LocalAppData');
    const installationRoot = path.join(localAppData, 'LocalAgentBridge');
    const appRoot = path.join(installationRoot, 'app', 'v');
    const runtimeRoot = path.join(root, 'separate-live-runtime');
    fs.mkdirSync(appRoot, { recursive: true });
    fs.mkdirSync(runtimeRoot, { recursive: true });
    writeInstallationAtomic({
      root: installationRoot,
      installation: {
        v: 1, installation_id: 'plugin-runtime-install', instance_id: 'plugin-runtime-instance',
        active_version: 'v', app_root: appRoot, runtime_root: runtimeRoot,
        hub_owner_kind: 'COMPANION_OWNED', protocol_version: 1, state_schema: 1,
      },
    });
    const env = { LOCALAPPDATA: localAppData };
    const resolved = resolvePluginRuntime({ env, projectRoot: appRoot });
    assert.equal(resolved.source, 'installation');
    assert.equal(resolved.runtimeDir, path.resolve(runtimeRoot));
    assert.equal(resolved.installationRoot, installationRoot);
    assert.throws(() => resolvePluginRuntime({
      env: { ...env, LAB_BRIDGE_RUNTIME_DIR: path.join(root, 'wrong-runtime') },
      projectRoot: appRoot,
    }), (error) => error.code === 'RUNTIME_INSTANCE_CONFLICT');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});