import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { queryStartupRegistryValue, removeStartup } from '../adapters/codex/receiver-startup.mjs';

const plan = { key: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', name: 'LocalAgentBridge-' + crypto.randomUUID() };
test('structured registry absence never depends on localized reg.exe error bytes', async () => {
  const value = await queryStartupRegistryValue(plan, async (exe, args, options) => {
    assert.equal(exe, 'powershell.exe'); assert.equal(options.encoding, 'utf8');
    assert.ok(args.at(-1).includes('OpenSubKey')); assert.ok(args.at(-1).includes('$false'));
    return { stdout: '{"state":"ABSENT"}', stderr: '\ufffd\ufffd\ufffd CP936 diagnostic is irrelevant' };
  });
  assert.equal(value, null);
  const command = 'powershell.exe 原路径保持不变';
  assert.equal(await queryStartupRegistryValue(plan, async () => ({ stdout: JSON.stringify({ state: 'PRESENT', kind: 'String', value: command }) })), command);
});
test('registry access failures, malformed JSON and foreign value kinds fail closed with stable codes', async () => {
  for (const stdout of ['{"state":"ERROR"}', 'not-json']) await assert.rejects(queryStartupRegistryValue(plan, async () => ({ stdout })), /STARTUP_REGISTRY_READ_FAILED/);
  await assert.rejects(queryStartupRegistryValue(plan, async () => { throw Object.assign(new Error('private raw diagnostic'), { code: 1 }); }), /STARTUP_REGISTRY_READ_FAILED/);
  await assert.rejects(queryStartupRegistryValue(plan, async () => ({ stdout: '{"state":"PRESENT","kind":"ExpandString","value":"foreign"}' })), /STARTUP_ENTRY_CONFLICT/);
});
test('real Windows read-only query can establish absence for a fresh unregistered owned value name', { skip: process.platform !== 'win32' }, async () => {
  assert.equal(await queryStartupRegistryValue(plan), null);
});
test('startup metadata edited during a registry query is never overwritten or deleted', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-registry-record-'));
  t.after(() => { const absolute = path.resolve(dir); assert.ok(absolute.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(absolute).startsWith('lab-registry-record-')); fs.rmSync(absolute, { recursive: true, force: true }); });
  const thread = plan.name.slice('LocalAgentBridge-'.length), file = path.join(dir, 'startup.json');
  fs.writeFileSync(file, JSON.stringify({ ...plan, thread_id: thread, command: 'old-owned', enabled: true }));
  const changed = JSON.stringify({ ...plan, thread_id: thread, command: 'new-owner-choice', enabled: false });
  await assert.rejects(removeStartup({ runtime_dir: dir, thread_id: thread }, {
    get: async () => { fs.writeFileSync(file, changed); return 'old-owned'; }, remove: async () => assert.fail('do not delete after a concurrent edit'),
  }), /STARTUP_ENTRY_CHANGED/);
  assert.equal(fs.readFileSync(file, 'utf8'), changed);
});
