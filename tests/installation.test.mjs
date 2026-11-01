import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  InstallationError,
  createInstallation,
  defaultInstallationRoot,
  installationPaths,
  readInstallation,
  resolveRuntime,
  validateInstallation,
  writeInstallationAtomic,
} from '../src/installation.mjs';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-installation-'));
}

test('default root and derived paths are deterministic', () => {
  const root = defaultInstallationRoot({ env: { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }, homedir: 'C:\\Users\\x' });
  assert.equal(root, path.join('C:\\Users\\x\\AppData\\Local', 'LocalAgentBridge'));
  const paths = installationPaths(root);
  assert.equal(paths.locator, path.join(root, 'installation.json'));
  assert.equal(paths.runtimeRoot, path.join(root, 'data', 'runtime'));
});

test('installation validation rejects bad schema/mode/paths', () => {
  assert.throws(() => validateInstallation(null), (error) => error instanceof InstallationError && error.code === 'INSTALLATION_INVALID');
  assert.throws(() => validateInstallation({
    v: 99, installation_id: 'i', instance_id: 'n', active_version: 'v', app_root: 'a', runtime_root: 'r',
    hub_owner_kind: 'MANUAL', protocol_version: 1, state_schema: 1,
  }), (error) => error.code === 'INSTALLATION_SCHEMA_UNSUPPORTED');
  assert.throws(() => validateInstallation({
    v: 1, installation_id: 'i', instance_id: 'n', active_version: 'v', app_root: 'a', runtime_root: 'r',
    hub_owner_kind: 'BOGUS', protocol_version: 1, state_schema: 1,
  }), (error) => error.code === 'INSTALLATION_INVALID');
  assert.throws(() => validateInstallation({
    v: 1, installation_id: 'i', instance_id: 'n', active_version: 'v', app_root: 'a', runtime_root: 'relative',
    hub_owner_kind: 'MANUAL', protocol_version: 1, state_schema: 1,
  }), (error) => error.code === 'INSTALLATION_INVALID');
});

test('write/read installation is atomic and excludes token fields', () => {
  const root = tempRoot();
  try {
    const value = {
      v: 1,
      installation_id: 'install-1',
      instance_id: 'instance-1',
      active_version: '0.1.0-dev',
      app_root: path.join(root, 'app', '0.1.0-dev'),
      runtime_root: path.join(root, 'run'),
      hub_owner_kind: 'COMPANION_OWNED',
      protocol_version: 1,
      state_schema: 1,
      component_versions: { core: '0.1.0-dev' },
      profiles: ['desktop'],
    };
    const written = writeInstallationAtomic({ root, installation: value });
    assert.equal(written.installation_id, 'install-1');
    const read = readInstallation({ root });
    assert.equal(read.instance_id, 'instance-1');
    assert.equal(read.hub_owner_kind, 'COMPANION_OWNED');
    assert.equal(fs.readFileSync(installationPaths(root).locator, 'utf8').includes('token'), false);
    assert.throws(() => writeInstallationAtomic({ root, installation: { ...value, token: 'secret' } }), (error) => error.code === 'INSTALLATION_FORBIDDEN_FIELD');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('missing installation returns null or explicit required error', () => {
  const root = tempRoot();
  try {
    assert.equal(readInstallation({ root }), null);
    assert.throws(() => readInstallation({ root, required: true }), (error) => error.code === 'INSTALLATION_MISSING');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runtime resolution never silently selects another instance', () => {
  const installation = {
    v: 1, installation_id: 'i', instance_id: 'n', active_version: 'v',
    app_root: path.resolve('app'), runtime_root: path.resolve('run'),
    hub_owner_kind: 'COMPANION_OWNED', protocol_version: 1, state_schema: 1,
  };
  assert.equal(resolveRuntime({ installation }).runtimeRoot, installation.runtime_root);
  assert.throws(
    () => resolveRuntime({ installation, explicit: path.resolve('other') }),
    (error) => error.code === 'RUNTIME_INSTANCE_CONFLICT',
  );
  assert.equal(
    resolveRuntime({ installation, explicit: path.resolve('other'), allowIsolatedOverride: true }).source,
    'explicit-isolated',
  );
  assert.throws(() => resolveRuntime({ installation: null }), (error) => error.code === 'INSTALLATION_MISSING');
  assert.equal(resolveRuntime({ installation: null, explicit: path.resolve('isolated') }).source, 'explicit-dev');
});

test('createInstallation writes a valid locator', () => {
  const root = tempRoot();
  try {
    const created = createInstallation({ root, activeVersion: '0.1.0-dev', hubOwnerKind: 'MANUAL' });
    assert.equal(created.hub_owner_kind, 'MANUAL');
    assert.equal(readInstallation({ root }).installation_id, created.installation_id);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
