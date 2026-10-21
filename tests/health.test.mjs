import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pidAlive, readJsonSafe, serverInfoHealth } from '../src/health.mjs';

function tempFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-health-'));
  const file = path.join(dir, name);
  if (content !== undefined) fs.writeFileSync(file, content, 'utf8');
  return file;
}

test('pidAlive recognises the current process and rejects dead/invalid pids', () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive(-1), false);
  assert.equal(pidAlive(2 ** 31 - 1), false);
});

test('readJsonSafe returns undefined for missing and malformed files', () => {
  assert.equal(readJsonSafe(tempFile('missing.json')), undefined);
  assert.equal(readJsonSafe(tempFile('broken.json', '{not json')), undefined);
  assert.deepEqual(readJsonSafe(tempFile('ok.json', '{"a":1}')), { a: 1 });
});

test('serverInfoHealth reports absent, live and stale states', () => {
  const absent = serverInfoHealth({ serverInfoFile: tempFile('none.json') });
  assert.deepEqual(absent, { present: false, stale: false });

  const live = serverInfoHealth({
    serverInfoFile: tempFile('live.json', JSON.stringify({ pid: process.pid, port: 47831, started_at: 'x' })),
  });
  assert.equal(live.present, true);
  assert.equal(live.pidAlive, true);
  assert.equal(live.stale, false);

  const stale = serverInfoHealth({
    serverInfoFile: tempFile('stale.json', JSON.stringify({ pid: 2 ** 31 - 1, port: 47831, started_at: 'x' })),
  });
  assert.equal(stale.present, true);
  assert.equal(stale.pidAlive, false);
  assert.equal(stale.stale, true);
});
