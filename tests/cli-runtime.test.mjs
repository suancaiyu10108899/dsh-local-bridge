import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BridgeHub } from '../src/hub.mjs';
import { HubStore } from '../src/store.mjs';
import { runtimePaths, writeJsonAtomic } from '../src/runtime.mjs';
import { writeInstallationAtomic } from '../src/installation.mjs';

const CLI = path.resolve(import.meta.dirname, '..', 'bin', 'lab-bridge.mjs');
const execFileAsync = promisify(execFile);
const SOURCE = 'dsh:session-11111111-1111-4111-8111-111111111111';
const TARGET = 'dsh:session-22222222-2222-4222-8222-222222222222';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lab-bridge-cli-runtime-'));
}

async function run(args, env = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      encoding: 'utf8', timeout: 15_000, windowsHide: true,
      env: { ...process.env, ...env },
    });
    return { status: 0, stdout, stderr };
  } catch (error) {
    return { status: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

function startHub(root, target) {
  const paths = runtimePaths(root);
  const store = new HubStore({ stateFile: paths.stateFile, eventsFile: paths.eventsFile }).load();
  if (target !== undefined) store.addTarget(target);
  const token = crypto.randomBytes(32).toString('hex');
  const hub = new BridgeHub({ store, token, host: '127.0.0.1', port: 0 });
  return { paths, store, token, hub };
}

test('network CLI --runtime selects that Hub root and does not mix two Hubs', async () => {
  const root = tempDir();
  const runtimeA = path.join(root, 'runtime-a');
  const runtimeB = path.join(root, 'runtime-b');
  fs.mkdirSync(runtimeA, { recursive: true });
  fs.mkdirSync(runtimeB, { recursive: true });
  const a = startHub(runtimeA);
  const b = startHub(runtimeB);
  try {
    const addressA = await a.hub.start();
    const addressB = await b.hub.start();
    fs.writeFileSync(a.paths.tokenFile, `${a.token}\n`, 'utf8');
    fs.writeFileSync(b.paths.tokenFile, `${b.token}\n`, 'utf8');
    writeJsonAtomic(a.paths.configFile, { v: 1, host: '127.0.0.1', port: addressA.port });
    writeJsonAtomic(b.paths.configFile, { v: 1, host: '127.0.0.1', port: addressB.port });

    let result = await run(['pair', 'add', SOURCE, '--runtime', runtimeA, '--label', 'A']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, true);
    assert.equal(a.store.listTargets().some((target) => target.identity === SOURCE), true);
    assert.equal(b.store.listTargets().some((target) => target.identity === SOURCE), false);

    result = await run(['pair', 'add', TARGET, '--runtime', runtimeB, '--label', 'B']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(b.store.listTargets().some((target) => target.identity === TARGET), true);
    assert.equal(a.store.listTargets().some((target) => target.identity === TARGET), false);

    result = await run(['targets', '--runtime', runtimeA]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).targets.map((target) => target.identity), [SOURCE]);

    result = await run(['send', '--runtime', runtimeA, '--to', SOURCE, '--text', 'same-root fixture']);
    assert.equal(result.status, 0, result.stderr);
    const sent = JSON.parse(result.stdout);
    assert.equal(sent.ok, true);
    result = await run(['status', '--runtime', runtimeA, '--msg-id', sent.msg_id]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).messages[0].to, SOURCE);
    result = await run(['consume', '--runtime', runtimeA, '--msg-id', sent.msg_id]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).message.consumed_by, 'cli:operator');
    result = await run(['status', '--runtime', runtimeB]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).messages.length, 0);
  } finally {
    await a.hub.stop();
    await b.hub.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('--installation expects the selected locator instance and rejects a different Hub welcome', async () => {
  const root = tempDir();
  const runtime = path.join(root, 'runtime');
  const installRoot = path.join(root, 'installation');
  fs.mkdirSync(runtime, { recursive: true });
  const a = startHub(runtime, undefined, { installation_id: 'install-b', instance_id: 'instance-b', protocol_version: 1 });
  try {
    const address = await a.hub.start();
    fs.writeFileSync(a.paths.tokenFile, `${a.token}\n`, 'utf8');
    writeJsonAtomic(a.paths.configFile, { v: 1, host: '127.0.0.1', port: address.port });
    writeInstallationAtomic({
      root: installRoot,
      installation: {
        v: 1, installation_id: 'install-a', instance_id: 'instance-a', active_version: '0.1.0-test',
        app_root: path.join(installRoot, 'app'), runtime_root: runtime, hub_owner_kind: 'MANUAL',
        protocol_version: 1, state_schema: 1,
      },
    });
    const result = await run(['pair', 'list', '--runtime', runtime, '--installation', installRoot]);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).code, 'hub-instance-mismatch');
  } finally {
    await a.hub.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('explicit --runtime never initializes a missing runtime/token and rejects non-loopback', async () => {
  const root = tempDir();
  const emptyRuntime = path.join(root, 'empty-runtime');
  const nonLoopback = path.join(root, 'non-loopback');
  fs.mkdirSync(emptyRuntime, { recursive: true });
  fs.mkdirSync(nonLoopback, { recursive: true });
  try {
    let result = await run(['pair', 'list', '--runtime', emptyRuntime]);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).code, 'runtime-not-initialized');
    assert.equal(fs.existsSync(path.join(emptyRuntime, 'hub')), false);

    const paths = runtimePaths(nonLoopback);
    fs.mkdirSync(path.dirname(paths.configFile), { recursive: true });
    writeJsonAtomic(paths.configFile, { v: 1, host: '192.0.2.44', port: 47831 });
    fs.writeFileSync(paths.tokenFile, `${'f'.repeat(64)}\n`, 'utf8');
    result = await run(['pair', 'list', '--runtime', nonLoopback]);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).code, 'hub-non-loopback');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI onboard receipt happy path validates native owner and never consumes or resends', async () => {
  const root = tempDir();
  const runtime = path.join(root, 'runtime');
  fs.mkdirSync(runtime, { recursive: true });
  const source = 'dsh:session-aaaa1111-1111-4111-8111-111111111111';
  const target = 'codex:bbbb2222-2222-4222-8222-222222222222';
  const thread = target.slice('codex:'.length);
  const messageId = 'm-cli-manual-receipt-happy';
  const turnId = '123e4567-e89b-42d3-a456-426614174000';
  const fixture = startHub(runtime);
  fixture.store.addTarget(source);
  fixture.store.addTarget(target);
  try {
    const address = await fixture.hub.start();
    fs.writeFileSync(fixture.paths.tokenFile, `${fixture.token}\n`, 'utf8');
    writeJsonAtomic(fixture.paths.configFile, { v: 1, host: '127.0.0.1', port: address.port });
    fixture.store.enqueue({ v: 1, msg_id: messageId, from: source, to: target, kind: 'text', text: 'fixture', ttl_ms: 86_400_000 });

    let result = await run([
      'onboard', 'request', '--runtime', runtime, '--source', source, '--target', target,
      '--message-id', messageId, '--user-authorized', '--request-id', 'onb-cli-receipt-happy',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const requestId = JSON.parse(result.stdout).request.request_id;

    result = await run([
      'onboard', 'receipt', requestId, '--runtime', runtime,
      '--message-id', messageId, '--turn-id', turnId,
    ], { CODEX_THREAD_ID: thread });
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.request.manual_receipt.route, 'MANUAL_ACTIVE_TURN');
    assert.equal(receipt.request.manual_receipt.model_status, 'MODEL_REPORTED_MANUAL');
    assert.equal(receipt.request.manual_receipt.native_accepted, 'UNKNOWN');
    assert.equal(receipt.request.manual_receipt.idle_wake, 'NOT_CLAIMED');
    assert.equal(receipt.request.manual_receipt.received_confirmed, false);
    const beforeWrong = fixture.store.getMessage(messageId);
    assert.equal(beforeWrong.state, 'queued');
    assert.equal(beforeWrong.consumed_by ?? null, null);

    result = await run([
      'onboard', 'receipt', requestId, '--runtime', runtime,
      '--message-id', messageId, '--turn-id', turnId,
    ], { CODEX_THREAD_ID: '00000000-0000-4000-8000-000000000000' });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).code, 'ONBOARD_RECEIPT_OWNER_THREAD_MISMATCH');
    const after = fixture.store.getMessage(messageId);
    assert.equal(after.state, 'queued');
    assert.equal(after.consumed_by ?? null, null);
    assert.equal(fixture.store.listMessages({ limit: 10 }).length, 1);
    const requestFile = path.join(runtime, 'onboarding', 'requests', `${requestId}.json`);
    assert.equal(JSON.parse(fs.readFileSync(requestFile, 'utf8')).manual_receipt.model_status, 'MODEL_REPORTED_MANUAL');
  } finally {
    await fixture.hub.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});