import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectServiceStatus } from '../src/service-status.mjs';

test('collectServiceStatus reads Hub health and receiver state without mutating anything', () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-service-status-'));
  const hubDir = path.join(runtime, 'hub');
  const receiverDir = path.join(runtime, 'codex', 'thread-a');
  fs.mkdirSync(hubDir, { recursive: true });
  fs.mkdirSync(receiverDir, { recursive: true });
  fs.writeFileSync(path.join(hubDir, 'server.json'), JSON.stringify({
    pid: process.pid,
    host: '127.0.0.1',
    port: 47831,
    server_id: 'server-test',
  }), 'utf8');
  fs.writeFileSync(path.join(receiverDir, 'status.json'), JSON.stringify({
    mode: 'daily',
    enabled: true,
    expires_at: null,
    status: 'ONLINE_IDLE',
    thread_id: 'thread-a',
  }), 'utf8');

  const status = collectServiceStatus({ runtimeDir: runtime, now: Date.parse('2026-10-21T12:00:00Z') });
  assert.equal(status.hub.present, true);
  assert.equal(status.hub.pidAlive, true);
  assert.equal(status.hub.pid, process.pid);
  assert.equal(status.receivers.length, 1);
  assert.equal(status.receivers[0].mode, 'daily');
  assert.equal(status.receivers[0].active, true);
  assert.equal(fs.existsSync(path.join(receiverDir, 'status.json')), true);
});
