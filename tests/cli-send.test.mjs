import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HubStore } from '../src/store.mjs';
import { BridgeHub } from '../src/hub.mjs';

const run = promisify(execFile);
const TOKEN = 'cli-send-test-token-'.padEnd(64, 'x');

function tempRuntime(port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-cli-send-'));
  const hubDir = path.join(dir, 'hub');
  fs.mkdirSync(hubDir, { recursive: true });
  fs.writeFileSync(path.join(hubDir, 'config.json'), JSON.stringify({ v: 1, host: '127.0.0.1', port }), 'utf8');
  fs.writeFileSync(path.join(hubDir, 'token'), `${TOKEN}\n`, 'utf8');
  return dir;
}

async function startHub(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-cli-hub-'));
  const store = new HubStore({ stateFile: path.join(dataDir, 'state.json'), eventsFile: path.join(dataDir, 'events.jsonl') }).load();
  const hub = new BridgeHub({ store, token: TOKEN, host: '127.0.0.1', port: 0 });
  const address = await hub.start();
  t.after(async () => {
    await hub.stop();
  });
  return { hub, store, port: address.port };
}

async function runCli(runtimeDir, args) {
  const cli = path.join(process.cwd(), 'bin', 'lab-bridge.mjs');
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args], {
      encoding: 'utf8',
      env: { ...process.env, LAB_BRIDGE_RUNTIME_DIR: runtimeDir },
      timeout: 15_000,
      windowsHide: true,
    });
    return { status: 0, stdout, stderr, json: stdout.trim().length > 0 ? JSON.parse(stdout) : undefined };
  } catch (error) {
    const stdout = error.stdout ?? '';
    const stderr = error.stderr ?? '';
    const payload = stdout.trim().length > 0 ? stdout : stderr;
    return {
      status: typeof error.code === 'number' ? error.code : 1,
      stdout,
      stderr,
      json: payload.trim().length > 0 ? JSON.parse(payload) : undefined,
    };
  }
}

test('cli send rejects a non-cli --from instead of spoofing the peer role', async (t) => {
  const { port } = await startHub(t);
  const runtimeDir = tempRuntime(port);
  const result = await runCli(runtimeDir, ['send', '--to', 'dsh:session-x', '--text', 'hi', '--from', 'codex:thread-1']);
  assert.equal(result.status, 1);
  assert.equal(result.json.code, 'from-role-invalid');
  assert.match(result.json.message, /--origin/);
});

test('cli send accepts --origin as declarative metadata and keeps cli:operator as sender', async (t) => {
  const { port } = await startHub(t);
  const runtimeDir = tempRuntime(port);
  const pair = await runCli(runtimeDir, ['pair', 'add', 'dsh:session-target']);
  assert.equal(pair.status, 0, pair.stderr);

  const sent = await runCli(runtimeDir, [
    'send', '--to', 'dsh:session-target', '--text', 'hello from the codex side',
    '--origin', 'codex:thread-1', '--msg-id', 'm-cli-origin-1',
  ]);
  assert.equal(sent.status, 0, sent.stderr);
  assert.equal(sent.json.ok, true);
  assert.equal(sent.json.from, 'cli:operator');
  assert.equal(sent.json.origin, 'codex:thread-1');

  const status = await runCli(runtimeDir, ['status', '--msg-id', 'm-cli-origin-1']);
  assert.equal(status.status, 0, status.stderr);
  const record = status.json.messages[0];
  assert.equal(record.from, 'cli:operator');
  assert.equal(record.meta.origin, 'codex:thread-1');
  assert.equal(record.meta.source, 'cli');
});

test('cli send rejects a malformed --origin', async (t) => {
  const { port } = await startHub(t);
  const runtimeDir = tempRuntime(port);
  const result = await runCli(runtimeDir, ['send', '--to', 'dsh:session-x', '--text', 'hi', '--origin', 'not-an-identity']);
  assert.equal(result.status, 1);
  assert.equal(result.json.code, 'origin-invalid');
});
