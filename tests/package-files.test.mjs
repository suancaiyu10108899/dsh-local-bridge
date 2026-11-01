import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('package files include the companion entry and the receiver worker dependency closure', () => {
  assert.ok(pkg.files.includes('companion'));
  assert.ok(pkg.files.includes('codex-receiver/adapters'));
  assert.ok(pkg.files.includes('codex-receiver/package.json'));
  assert.ok(pkg.files.includes('codex-receiver/src'));
  assert.equal(fs.existsSync(path.join(root, 'codex-receiver', 'package.json')), true);
  assert.equal(fs.existsSync(path.join(root, 'companion', 'main.mjs')), true);
  assert.equal(fs.existsSync(path.join(root, 'codex-receiver', 'adapters', 'codex', 'daily-receiver.mjs')), true);
  assert.equal(fs.existsSync(path.join(root, 'codex-receiver', 'src', 'client.mjs')), true);
});