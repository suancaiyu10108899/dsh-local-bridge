import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI = path.resolve(import.meta.dirname, '..', 'bin', 'lab-bridge.mjs');

test('companion CLI status/start are read-only and fail closed without an installation locator', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-cli-companion-'));
  const runtime = path.join(root, 'runtime');
  const installation = path.join(root, 'installation');
  fs.mkdirSync(runtime, { recursive: true });
  const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', windowsHide: true });
  try {
    let result = run(['companion', 'status', '--runtime', runtime, '--installation', installation]);
    assert.equal(result.status, 0, result.stderr);
    const status = JSON.parse(result.stdout);
    assert.equal(status.ok, true);
    assert.equal(status.state, 'NOT_INSTALLED');
    assert.equal(status.action_hint, 'NONE');
    assert.equal(fs.existsSync(runtime), true);

    result = run(['companion', 'start', '--runtime', runtime, '--installation', installation]);
    assert.equal(result.status, 0, result.stderr);
    const started = JSON.parse(result.stdout);
    assert.equal(started.outcome, 'NO_ACTION');
    assert.equal(started.decision, 'NO_INSTALLATION');
    assert.equal(fs.existsSync(path.join(runtime, 'hub', 'token')), false);
    assert.equal(fs.existsSync(path.join(runtime, 'companion', 'explicit-stop.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});