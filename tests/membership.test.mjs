import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createMembership,
  listMemberships,
  membershipPath,
  readMembership,
  registerMembershipDisable,
  registerMembershipEnable,
  targetKey,
  validateMembership,
  writeMembershipAtomic,
} from '../src/membership.mjs';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-membership-'));
}

const base = (root, target = 'codex:01a99999-9999-4999-8999-999999999999') => ({
  installation_id: 'install-1',
  instance_id: 'instance-1',
  target,
  binding_epoch: 'epoch-1',
  config_path: path.join(root, 'receiver-config.json'),
  receiver_kind: 'daily',
  desired_state: 'DISABLED',
  enabled: false,
  owner_opt_in: false,
  owner_opt_in_at: '2026-10-23T12:00:00.000Z',
  start_at_logon: false,
  now: '2026-10-23T12:00:00.000Z',
});

test('target key/path are derived from exact target and validate boundaries', () => {
  const root = tempRoot();
  try {
    assert.equal(targetKey('codex:abc'), targetKey('codex:abc'));
    assert.notEqual(targetKey('codex:abc'), targetKey('codex:def'));
    assert.equal(membershipPath(root, 'codex:abc'), path.join(root, 'memberships', `${targetKey('codex:abc')}.json`));
    assert.throws(() => targetKey('not-a-target'), /exact codex/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('membership validation and atomic list/read', () => {
  const root = tempRoot();
  try {
    const value = createMembership(base(root));
    assert.equal(validateMembership(value).desired_state, 'DISABLED');
    assert.throws(() => validateMembership({ ...value, desired_state: 'NOPE' }), /desired_state/);
    const written = writeMembershipAtomic(root, value);
    assert.equal(written.target, value.target);
    assert.equal(readMembership(membershipPath(root, value.target)).binding_epoch, 'epoch-1');
    const listing = listMemberships(root);
    assert.equal(listing.memberships.length, 1);
    assert.equal(listing.invalid.length, 0);
    fs.writeFileSync(path.join(root, 'memberships', 'bad.json'), '{bad');
    assert.equal(listMemberships(root).invalid.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('enable registers desired state only; disable flips state without spawning', () => {
  const root = tempRoot();
  try {
    const registered = registerMembershipEnable({
      root,
      installation_id: 'install-1',
      instance_id: 'instance-1',
      target: 'codex:01a99999-9999-4999-8999-999999999999',
      binding_epoch: 'epoch-1',
      config_path: path.join(root, 'receiver-config.json'),
      owner_opt_in_at: '2026-10-23T12:00:00.000Z',
      start_at_logon: false,
    });
    assert.equal(registered.desired_state, 'ENABLED');
    assert.equal(registered.enabled, true);
    assert.equal(registered.owner_opt_in, true);
    assert.equal(registered.start_at_logon, false);
    const disabled = registerMembershipDisable({ root, target: registered.target });
    assert.equal(disabled.desired_state, 'DISABLED');
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.binding_epoch, 'epoch-1');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
