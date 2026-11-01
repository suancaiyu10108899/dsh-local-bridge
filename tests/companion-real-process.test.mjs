import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { writeInstallationAtomic } from '../src/installation.mjs';
import { ensureBootstrap, statusBootstrap, stopBootstrap } from '../src/companion-bootstrap.mjs';

const execFileAsync = promisify(execFile);
const BASE = path.resolve(import.meta.dirname, '..');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForState(installationRoot, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await statusBootstrap({ installationRoot });
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`companion state timeout: ${JSON.stringify({ state: last?.state, owner: last?.owner_state, probe: last?.hub_probe_state })}`);
}

test('detached companion survives DSH-like client exit, reattaches once, and explicit stop stays stopped', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-companion-real-test-'));
  const installationRoot = path.join(root, 'installation');
  const runtimeRoot = path.join(root, 'runtime');
  fs.mkdirSync(path.join(runtimeRoot, 'hub'), { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, 'hub', 'config.json'), JSON.stringify({
    v: 1, host: '127.0.0.1', port: await freePort(),
  }), 'utf8');
  writeInstallationAtomic({
    root: installationRoot,
    installation: {
      v: 1, installation_id: 'install-real-process', instance_id: 'instance-real-process',
      active_version: '0.0.0-test', app_root: BASE, runtime_root: runtimeRoot,
      hub_owner_kind: 'COMPANION_OWNED', protocol_version: 1, state_schema: 1,
    },
  });
  const ensureUrl = pathToFileURL(path.join(BASE, 'src', 'companion-bootstrap.mjs')).href;
  const childCode = [
    `import { ensureBootstrap } from ${JSON.stringify(ensureUrl)};`,
    `const r = await ensureBootstrap({ installationRoot: ${JSON.stringify(installationRoot)}, explicitStart: true, reason: 'DSH_CLOSE_TEST', startTimeoutMs: 20000 });`,
    `console.log(JSON.stringify({ ok: r.ok, outcome: r.outcome, decision: r.decision, spawn_pid: r.spawn_pid }));`,
  ].join('\n');
  try {
    const child = await execFileAsync(process.execPath, ['--input-type=module', '-e', childCode], {
      encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });
    const childResult = JSON.parse(child.stdout.trim());
    assert.equal(childResult.ok, true, child.stderr);
    assert.equal(childResult.outcome, 'STARTED_OWNER_VERIFIED');

    const running = await waitForState(installationRoot, (s) => s.state === 'OWNED_RUNNING' && s.owner_verified === true);
    assert.equal(running.explicit_stop_active, false);
    assert.equal(fs.existsSync(path.join(runtimeRoot, 'hub', 'token')), true);
    assert.equal(fs.existsSync(path.join(runtimeRoot, 'hub', 'config.json')), true);

    const reused = await ensureBootstrap({ installationRoot, reason: 'DSH_REOPEN_TEST', startTimeoutMs: 20_000 });
    assert.equal(reused.ok, true);
    assert.ok(['ATTACHED_VERIFIED_OWNER', 'ATTACHED_LAUNCH_PENDING', 'IN_FLIGHT'].includes(reused.outcome), JSON.stringify(reused));
    assert.equal(reused.spawn_calls ?? 0, 0);

    const stopped = await stopBootstrap({ installationRoot, actor: 'test', reason: 'TEST_STOP', stopTimeoutMs: 20_000 });
    assert.equal(stopped.ok, true);
    assert.equal(stopped.confirmed, true);
    assert.equal(fs.existsSync(path.join(runtimeRoot, 'hub', 'token')), true);
    assert.equal(fs.existsSync(path.join(runtimeRoot, 'hub', 'config.json')), true);
    const stoppedState = await waitForState(installationRoot, (s) => s.state === 'STOPPED_EXPLICIT');
    assert.equal(stoppedState.explicit_stop_active, true);

    const afterStop = await ensureBootstrap({ installationRoot, reason: 'DSH_REOPEN_AFTER_STOP', startTimeoutMs: 5_000 });
    assert.equal(afterStop.ok, true);
    assert.equal(afterStop.started, false);
    assert.equal(afterStop.outcome, 'PAUSED');
    assert.equal((await statusBootstrap({ installationRoot })).explicit_stop_active, true);
  } finally {
    try { await stopBootstrap({ installationRoot, actor: 'test', reason: 'TEST_CLEANUP', stopTimeoutMs: 10_000 }); } catch { /* best effort */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
});