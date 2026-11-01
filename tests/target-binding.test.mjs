import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyTargetBindingEpoch,
  createTargetBindingStamper,
  resolveTargetBinding,
  TARGET_BINDING_EPOCH_META_KEY,
} from '../src/target-binding.mjs';
import { installationPaths, readInstallation, writeInstallationAtomic } from '../src/installation.mjs';
import { registerMembershipEnable, registerMembershipDisable } from '../src/membership.mjs';
import { validateEnvelope } from '../src/protocol.mjs';

const TARGET = 'codex:thread-binding-1';
const THREAD = 'thread-binding-1';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-binding-'));
  const paths = installationPaths(root);
  fs.mkdirSync(paths.runtimeRoot, { recursive: true });
  const installation = writeInstallationAtomic({
    root,
    installation: {
      v: 1,
      installation_id: 'install-binding',
      instance_id: 'instance-binding',
      active_version: '0.1.0-test',
      app_root: path.join(root, 'app'),
      runtime_root: paths.runtimeRoot,
      hub_owner_kind: 'COMPANION_OWNED',
      protocol_version: 1,
      state_schema: 1,
    },
  });
  const configDir = path.join(paths.runtimeRoot, 'codex', THREAD);
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'receiver-config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    thread_id: THREAD,
    installation_id: installation.installation_id,
    instance_id: installation.instance_id,
    binding_epoch: 'epoch-1',
    enabled: true,
    owner_opt_in: true,
    runtime_dir: configDir,
    locator: paths.locator,
  }));
  registerMembershipEnable({
    root: paths.runtimeRoot,
    installation_id: installation.installation_id,
    instance_id: installation.instance_id,
    target: TARGET,
    binding_epoch: 'epoch-1',
    config_path: configPath,
  });
  const loaded = readInstallation({ root });
  return { root, paths, installation: loaded, configPath };
}

function envelope(overrides = {}) {
  return validateEnvelope({
    v: 1,
    msg_id: 'm-binding-1',
    from: 'dsh:session-binding',
    to: TARGET,
    kind: 'text',
    text: 'binding test',
    ...overrides,
  }).envelope;
}

test('server resolves/stamps exact target epoch and rejects conflicting self-report', () => {
  const s = setup();
  try {
    const binding = resolveTargetBinding({
      runtimeRoot: s.paths.runtimeRoot,
      target: TARGET,
      installation: s.installation,
      locatorPath: s.paths.locator,
    });
    assert.equal(binding.state, 'BOUND');
    assert.equal(binding.epoch, 'epoch-1');

    const stamped = applyTargetBindingEpoch(envelope(), binding);
    assert.equal(stamped.ok, true);
    assert.equal(stamped.envelope.meta[TARGET_BINDING_EPOCH_META_KEY], 'epoch-1');

    const matching = applyTargetBindingEpoch(envelope({ meta: { [TARGET_BINDING_EPOCH_META_KEY]: 'epoch-1' } }), binding);
    assert.equal(matching.ok, true);
    assert.equal(matching.envelope.meta[TARGET_BINDING_EPOCH_META_KEY], 'epoch-1');

    const conflict = applyTargetBindingEpoch(envelope({ meta: { [TARGET_BINDING_EPOCH_META_KEY]: 'epoch-old' } }), binding);
    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, 'target-binding-epoch-conflict');
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test('legacy target without installation membership stays unstamped and rejects self-reported epoch', () => {
  const s = setup();
  try {
    const legacyTarget = 'codex:thread-legacy';
    const binding = resolveTargetBinding({
      runtimeRoot: s.paths.runtimeRoot,
      target: legacyTarget,
      installation: s.installation,
      locatorPath: s.paths.locator,
    });
    assert.equal(binding.state, 'LEGACY');
    const plain = applyTargetBindingEpoch(envelope({ to: legacyTarget }), binding);
    assert.equal(plain.ok, true);
    assert.equal(Object.hasOwn(plain.envelope.meta, TARGET_BINDING_EPOCH_META_KEY), false);
    const untrusted = applyTargetBindingEpoch(envelope({ to: legacyTarget, meta: { [TARGET_BINDING_EPOCH_META_KEY]: 'claimed' } }), binding);
    assert.equal(untrusted.ok, false);
    assert.equal(untrusted.code, 'target-binding-epoch-untrusted');
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test('disabled membership/config mismatch invalidates production binding', () => {
  const s = setup();
  try {
    registerMembershipDisable({ root: s.paths.runtimeRoot, target: TARGET });
    const binding = resolveTargetBinding({
      runtimeRoot: s.paths.runtimeRoot,
      target: TARGET,
      installation: s.installation,
      locatorPath: s.paths.locator,
    });
    assert.equal(binding.state, 'INVALID');
    assert.equal(binding.code, 'TARGET_BINDING_MEMBERSHIP_DISABLED');
    const applied = applyTargetBindingEpoch(envelope(), binding);
    assert.equal(applied.ok, false);
    assert.equal(applied.code, 'target-binding-unavailable');
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test('Hub receive hook stamps new messages and rejects sender conflicts', () => {
  const s = setup();
  try {
    let seen = null;
    const stamper = createTargetBindingStamper({
      installation: s.installation,
      runtimeRoot: s.paths.runtimeRoot,
      locatorPath: s.paths.locator,
      log: () => {},
    });
    const result = stamper(envelope({ meta: { source_kind: 'plugin' } }));
    assert.equal(result.ok, true);
    seen = result.envelope;
    assert.equal(seen.meta.source_kind, 'plugin');
    assert.equal(seen.meta[TARGET_BINDING_EPOCH_META_KEY], 'epoch-1');
    const conflict = stamper(envelope({ meta: { [TARGET_BINDING_EPOCH_META_KEY]: 'wrong' } }));
    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, 'target-binding-epoch-conflict');
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});
