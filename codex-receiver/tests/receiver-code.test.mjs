import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readReceiverCodeIdentity } from '../adapters/codex/receiver-code.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-receiver-code-'));
  t.after(() => {
    const absolute = path.resolve(root);
    assert.ok(absolute.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(absolute).startsWith('lab-receiver-code-'));
    fs.rmSync(absolute, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, 'adapters', 'codex'), { recursive: true }); fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.1.0-test' }));
  fs.writeFileSync(path.join(root, 'adapters', 'codex', 'daily-receiver.mjs'), 'export const version = 1;');
  fs.writeFileSync(path.join(root, 'src', 'core.mjs'), 'export const protocol = 1;');
  return root;
}

test('code identity observes actual helper changes without changing declared package version', (t) => {
  const root = fixture(t), before = readReceiverCodeIdentity(root);
  fs.writeFileSync(path.join(root, 'src', 'core.mjs'), 'export const protocol = 2;');
  const after = readReceiverCodeIdentity(root);
  assert.equal(before.readable, true); assert.equal(after.package_version, before.package_version);
  assert.notEqual(after.code_sha256, before.code_sha256);
});

test('runtime tokens, messages and logs are excluded from code identity', (t) => {
  const root = fixture(t), before = readReceiverCodeIdentity(root);
  fs.mkdirSync(path.join(root, 'runtime')); fs.writeFileSync(path.join(root, 'runtime', 'token'), 'synthetic fixture only');
  fs.writeFileSync(path.join(root, 'runtime', 'messages.json'), '{"fixture":"private data"}');
  assert.equal(readReceiverCodeIdentity(root).code_sha256, before.code_sha256);
});

test('unreadable manifests and unexpected source entries report UNKNOWN rather than a verified version', (t) => {
  const root = fixture(t); fs.writeFileSync(path.join(root, 'package.json'), '{broken');
  assert.equal(readReceiverCodeIdentity(root).readable, false);
  fs.writeFileSync(path.join(root, 'package.json'), '{"version":"0.1.0-test"}');
  fs.mkdirSync(path.join(root, 'src', 'unexpected.mjs'));
  assert.equal(readReceiverCodeIdentity(root).readable, false);
});
