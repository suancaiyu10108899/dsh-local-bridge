import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { serveReceiver } from '../adapters/codex/receiver-service.mjs';
import { binaryHash } from '../adapters/codex/daily-receiver.mjs';

const provider = async (pid) => ({ pid, available: true, alive: true, created_at: '2026-01-01T00:00:00.000Z',
  exe_path: process.execPath, entry_path: fileURLToPath(import.meta.url), source: 'injected-test' });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-service-policy-'));
  t.after(() => {
    const absolute = path.resolve(dir);
    assert.ok(absolute.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(absolute).startsWith('lab-service-policy-'));
    fs.rmSync(absolute, { recursive: true, force: true });
  });
  const cli = path.join(dir, 'OpenAI', 'Codex', 'bin', 'aaaaaaaaaaaaaaaa', 'codex.exe');
  fs.mkdirSync(path.dirname(cli), { recursive: true }); fs.writeFileSync(cli, 'inert fixture');
  const c = { v: 2, mode: 'daily', transport: 'target-pull', enabled: true, thread_id: crypto.randomUUID(),
    allowed_senders: ['dsh:session-11111111-1111-4111-8111-111111111111'], cli, cli_sha256: binaryHash(cli),
    cli_version: 'codex-cli 0.163.0-alpha.11.2', workspace: dir, rollout_path: path.join(dir, 'rollout.jsonl'),
    state_db: path.join(dir, 'state.sqlite'), runtime_dir: path.join(dir, 'runtime'),
    activated_at: new Date(Date.now() - 1000).toISOString(), expires_at: null, window_id: crypto.randomUUID(),
    rate_limit: { max_submissions: 6, window_ms: 3600000 }, min_interval_ms: 30000, idle_settle_ms: 3000,
    poll_interval_ms: 500, max_text_bytes: 12000, accept_backlog: true };
  fs.mkdirSync(c.runtime_dir); const file = path.join(dir, 'config.json'); fs.writeFileSync(file, JSON.stringify(c));
  return { c, file, policy: path.join(c.runtime_dir, 'service-restart.json') };
}
function failingChild() {
  const child = new EventEmitter(); child.pid = 99999; child.exitCode = null;
  setImmediate(() => { child.exitCode = 1; child.emit('exit', 1, null); });
  return child;
}

test('manual supervisor persists its circuit breaker and cannot reset it by restarting itself', async (t) => {
  const f = fixture(t); let calls = 0;
  const options = { identityProvider: provider, spawnWorker: () => { calls++; return failingChild(); },
    restartOptions: { delaysMs: [0], maxAttempts: 3 } };
  await serveReceiver(f.file, crypto.randomUUID(), options); assert.equal(calls, 3);
  const state = JSON.parse(fs.readFileSync(f.policy)); assert.equal(state.policy.halted, true); assert.equal(state.policy.attempts, 3);
  await serveReceiver(f.file, crypto.randomUUID(), options); assert.equal(calls, 3);
  assert.equal(JSON.parse(fs.readFileSync(f.policy)).policy.halted, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.c.runtime_dir, 'service-status.json'))).status, 'HALTED');
  assert.equal(fs.existsSync(path.join(f.c.runtime_dir, 'service.lock')), false);
});

test('damaged persisted restart state halts without spawning or resetting the file', async (t) => {
  for (const policy of [[], { attempts: 'bad', failures: 1, halted: false, failure_times: [] },
    { attempts: 2, failures: 2, halted: false }]) {
    const f = fixture(t), raw = JSON.stringify({ v: 1, scope: 'worker:' + f.c.thread_id, policy });
    fs.writeFileSync(f.policy, raw); let calls = 0;
    await assert.rejects(serveReceiver(f.file, crypto.randomUUID(), { identityProvider: provider,
      spawnWorker: () => { calls++; return failingChild(); } }), /RESTART_STATE_REVIEW_REQUIRED/);
    assert.equal(calls, 0); assert.equal(fs.readFileSync(f.policy, 'utf8'), raw);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.c.runtime_dir, 'service-status.json'))).reason_code, 'RESTART_STATE_REVIEW_REQUIRED');
    assert.equal(fs.existsSync(path.join(f.c.runtime_dir, 'service.lock')), false);
  }
});
