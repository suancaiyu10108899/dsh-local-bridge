import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHubService } from '../src/hub-service.mjs';
import { serverInfoHealth } from '../src/health.mjs';

function tempRuntime() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-hub-service-'));
  fs.mkdirSync(path.join(root, 'hub'), { recursive: true });
  return root;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

test('managed hub starts on demand, is reused by a second service, and stops only its own child', async () => {
  const runtimeDir = tempRuntime();
  const port = await freePort();
  fs.writeFileSync(path.join(runtimeDir, 'hub', 'config.json'), JSON.stringify({ v: 1, host: '127.0.0.1', port }), 'utf8');
  fs.writeFileSync(path.join(runtimeDir, 'hub', 'token'), `${'a'.repeat(64)}\n`, 'utf8');
  const projectRoot = path.resolve(import.meta.dirname, '..');
  const service = createHubService({ runtimeDir, projectRoot });
  let second;
  try {
    const first = await service.ensureStarted({ timeoutMs: 10_000 });
    assert.equal(first.ok, true);
    assert.equal(first.started, true);
    assert.equal(first.reused, false);
    assert.equal(first.owned, true);
    assert.equal(service.status().pidAlive, true);
    assert.equal(service.status().pid, first.pid);

    second = createHubService({ runtimeDir, projectRoot });
    const reused = await second.ensureStarted({ timeoutMs: 2_000 });
    assert.equal(reused.ok, true);
    assert.equal(reused.reused, true);
    assert.equal(reused.started, false);
    assert.equal(second.status().owned, false);
    assert.deepEqual(await second.stop(), { ok: true, stopped: false, reason: 'not-managed' });
    assert.equal(serverInfoHealth({ serverInfoFile: path.join(runtimeDir, 'hub', 'server.json') }).pidAlive, true);

    const stopped = await service.stop();
    assert.equal(stopped.ok, true);
    assert.equal(stopped.stopped, true);
    assert.equal(serverInfoHealth({ serverInfoFile: path.join(runtimeDir, 'hub', 'server.json') }).present, false);
  } finally {
    await second?.stop();
    await service.stop();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});
