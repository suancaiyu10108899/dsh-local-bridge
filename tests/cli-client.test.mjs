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
import { HubClient } from '../src/client.mjs';
import { runtimePaths, writeJsonAtomic } from '../src/runtime.mjs';

const execFileAsync = promisify(execFile);
const CLI = path.resolve(import.meta.dirname, '..', 'bin', 'lab-bridge.mjs');
const clientIdentity = 'client:dot-22222222-2222-4222-8222-222222222222';
const target = 'codex:33333333-3333-4333-8333-333333333333';
const requestId = 'm-cli-client-request-1';
const turn = '44444444-4444-4444-8444-444444444444';

async function run(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
    return { status: 0, stdout, stderr };
  } catch (error) {
    return { status: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

test('CLI client grant/request/status/reply/resume use scoped credentials without exposing secret', { timeout: 60_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-cli-client-'));
  const runtime = path.join(root, 'runtime');
  const paths = runtimePaths(runtime);
  fs.mkdirSync(path.dirname(paths.configFile), { recursive: true });
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(paths.tokenFile, `${token}\n`, 'utf8');
  const store = new HubStore({ stateFile: paths.stateFile, eventsFile: paths.eventsFile }).load();
  store.addTarget(target);
  const hub = new BridgeHub({ store, token, runtimeRoot: runtime, host: '127.0.0.1', port: 0, ackTimeoutMs: 1_000 });
  const address = await hub.start();
  writeJsonAtomic(paths.configFile, { v: 1, host: '127.0.0.1', port: address.port });
  const operator = new HubClient({ host: '127.0.0.1', port: address.port, token, role: 'cli', identity: 'cli:operator' });
  const requestFile = path.join(root, 'request.txt');
  const replyFile = path.join(root, 'reply.txt');
  fs.writeFileSync(requestFile, 'synthetic CLI client request', 'utf8');
  fs.writeFileSync(replyFile, 'synthetic CLI client reply', 'utf8');
  try {
    await operator.connect();

    const grantResult = await run(['client', 'grant', '--runtime', runtime, '--client', clientIdentity, '--targets', target,
      '--lease-minutes', '1', '--ttl-minutes', '60']);
    assert.equal(grantResult.status, 0, grantResult.stderr);
    const grant = JSON.parse(grantResult.stdout);
    assert.equal(grant.ok, true);
    assert.equal(grant.client_identity, clientIdentity);
    const secret = fs.readFileSync(grant.credential_file, 'utf8').trim();
    assert.equal(grantResult.stdout.includes(secret), false);
    assert.equal(grantResult.stderr.includes(secret), false);

    const requestResult = await run(['client', 'request', '--runtime', runtime, '--grant', grant.grant_id,
      '--credential-file', grant.credential_file, '--to', target, '--request-id', requestId, '--text-file', requestFile]);
    assert.equal(requestResult.status, 0, requestResult.stderr);
    const accepted = JSON.parse(requestResult.stdout);
    assert.equal(accepted.request_id, requestId);
    assert.equal(accepted.state, 'QUEUED');
    const claim = await operator.request({ type: 'client-claim', client_identity: clientIdentity, client_request_id: requestId, target_identity: target, request_msg_id: accepted.msg_id, owner_identity: target });
    await operator.request({ type: 'client-begin-submit', client_identity: clientIdentity, client_request_id: requestId, target_identity: target, request_msg_id: accepted.msg_id, lease_id: claim.lease.id, fencing_token: claim.lease.fencing_token });
    await operator.request({ type: 'client-outcome', client_identity: clientIdentity, client_request_id: requestId, target_identity: target, request_msg_id: accepted.msg_id, status: 'NATIVE_QUEUED', native_queue_id: 'native-cli-1', lease_id: claim.lease.id, fencing_token: claim.lease.fencing_token });

    let result = await run(['client', 'status', '--runtime', runtime, '--grant', grant.grant_id,
      '--credential-file', grant.credential_file, '--request-id', requestId]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).request.state, 'NATIVE_QUEUED');

    result = await run(['client', 'reply', '--runtime', runtime, '--client', clientIdentity, '--request-id', requestId,
      '--msg-id', accepted.msg_id, '--target', target, '--turn-id', turn, '--body-file', replyFile]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, true);

    result = await run(['client', 'resume', '--runtime', runtime, '--grant', grant.grant_id,
      '--credential-file', grant.credential_file, '--request-id', requestId]);
    assert.equal(result.status, 0, result.stderr);
    const resumed = JSON.parse(result.stdout);
    assert.equal(resumed.state, 'REPLY_READY');
    assert.equal(resumed.reply.body, 'synthetic CLI client reply');
    assert.equal(result.stdout.includes(secret), false);

    result = await run(['client', 'list-grants', '--runtime', runtime]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.includes(secret), false);
    assert.equal(result.stdout.includes('credential_sha256'), false);
  } finally {
    await operator.close();
    await hub.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});