import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planInstallation } from '../installer/plan.mjs';
import { installationPaths, writeInstallationAtomic } from '../src/installation.mjs';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-installer-plan-'));
}

test('read-only installer plan performs no writes and reports preconditions', () => {
  const root = tempRoot();
  try {
    const plan = planInstallation({ installationRoot: root, now: 1_000 });
    assert.equal(plan.read_only, true);
    assert.equal(plan.live_cutover, false);
    assert.equal(plan.actions.includes('CREATE_LOCATOR_AFTER_APPROVAL'), true);
    assert.equal(fs.existsSync(installationPaths(root).locator), false);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('installer plan reads a locator/runtime without mutating token/state/membership', () => {
  const root = tempRoot();
  try {
    const paths = installationPaths(root);
    fs.mkdirSync(path.join(paths.runtimeRoot, 'hub'), { recursive: true });
    fs.mkdirSync(path.join(paths.runtimeRoot, 'memberships'), { recursive: true });
    const tokenFile = path.join(paths.runtimeRoot, 'hub', 'token');
    fs.writeFileSync(tokenFile, 'secret-token-value-that-must-not-be-returned\n', 'utf8');
    writeInstallationAtomic({
      root,
      installation: {
        v: 1,
        installation_id: 'install-plan',
        instance_id: 'instance-plan',
        active_version: '0.1.0-test',
        app_root: path.join(root, 'app'),
        runtime_root: paths.runtimeRoot,
        hub_owner_kind: 'COMPANION_OWNED',
        protocol_version: 1,
        state_schema: 1,
      },
    });
    const before = fs.readdirSync(paths.runtimeRoot, { recursive: true }).sort();
    const plan = planInstallation({ installationRoot: root, now: 1_000 });
    const after = fs.readdirSync(paths.runtimeRoot, { recursive: true }).sort();
    assert.deepEqual(after, before);
    assert.equal(plan.installation_id, 'install-plan');
    assert.equal(plan.instance_id, 'instance-plan');
    assert.equal(plan.runtime_root, paths.runtimeRoot);
    assert.equal(plan.observed.memberships, true);
    assert.equal(plan.actions.includes('ACQUIRE_HUB_OWNER_LEASE_THEN_START_OR_REUSE_HUB'), true);
    assert.equal(JSON.stringify(plan).includes('secret-token-value'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
