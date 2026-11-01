import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { createCompanionHub } from '../src/companion-hub.mjs';
import { HubClient } from '../src/client.mjs';
import { installationPaths, writeInstallationAtomic } from '../src/installation.mjs';
import { readProcessIdentity } from '../src/process-identity.mjs';
import { DEFAULT_CONFIG, runtimePaths, writeJsonAtomic } from '../src/runtime.mjs';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(predicate, { timeoutMs = 20_000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitFor timeout');
}

const ownerIdentity = {
  alive: true,
  available: true,
  source: 'injected',
  created_at: '2026-10-23T12:00:00.000Z',
  exe_path: path.join('C:', 'Program Files', 'nodejs', 'node.exe'),
  entry_path: path.join(PROJECT_ROOT, 'companion', 'main.mjs'),
};

test('owned Hub crash preserves token/queue and recovers in the same runtime', { timeout: 40_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-hub-crash-'));
  try {
    const paths = installationPaths(root);
    const installation = writeInstallationAtomic({
      root,
      installation: {
        v: 1,
        installation_id: 'install-crash',
        instance_id: 'instance-crash',
        active_version: '0.1.0-test',
        app_root: path.join(root, 'app'),
        runtime_root: paths.runtimeRoot,
        hub_owner_kind: 'COMPANION_OWNED',
        protocol_version: 1,
        state_schema: 1,
      },
    });
    const runtime = runtimePaths(paths.runtimeRoot);
    fs.mkdirSync(runtime.hubDir, { recursive: true });
    writeJsonAtomic(runtime.configFile, { ...DEFAULT_CONFIG, port: await freePort() });
    const processProvider = async (pid) => {
      if (pid === process.pid) return { pid, ...ownerIdentity };
      return readProcessIdentity(pid);
    };
    const manager = createCompanionHub({
      installation,
      runtimeRoot: installation.runtime_root,
      locatorPath: paths.locator,
      hubEntry: path.join(PROJECT_ROOT, 'hub', 'main.mjs'),
      processProvider,
      startTimeoutMs: 15_000,
      restartDelaysMs: [200],
    });
    try {
      const first = await manager.start();
      assert.equal(first.lifecycle, 'READY');
      const oldPid = first.child_pid;
      assert.equal(Number.isInteger(oldPid), true);
      const token = fs.readFileSync(runtime.tokenFile, 'utf8').trim();
      const config = JSON.parse(fs.readFileSync(runtime.configFile, 'utf8'));
      const dshIdentity = `dsh:session-${crypto.randomUUID()}`;
      const targetIdentity = `codex:${crypto.randomUUID()}`;
      const cli = new HubClient({ host: config.host, port: config.port, token, role: 'cli', identity: 'cli:operator' });
      const dsh = new HubClient({ host: config.host, port: config.port, token, role: 'dsh', identity: dshIdentity });
      try {
        await cli.connect();
        await dsh.connect();
        await cli.pairAdd(dshIdentity);
        await cli.pairAdd(targetIdentity);
        const msgId = `m-crash-${crypto.randomUUID()}`;
        const accepted = await dsh.sendMessage({
          v: 1, msg_id: msgId, from: dshIdentity, to: targetIdentity, kind: 'text', text: 'queued before crash',
        });
        assert.equal(accepted.type, 'accepted');
        assert.equal((await cli.status(msgId)).state, 'queued');
        process.kill(oldPid, 'SIGKILL');
        const recovered = await waitFor(async () => {
          const status = manager.status();
          return status.lifecycle === 'READY' && Number.isInteger(status.child_pid) && status.child_pid !== oldPid ? status : null;
        }, { timeoutMs: 20_000 });
        assert.notEqual(recovered.child_pid, oldPid);
        assert.equal(fs.readFileSync(runtime.tokenFile, 'utf8').trim(), token);
        const cli2 = new HubClient({ host: config.host, port: config.port, token, role: 'cli', identity: 'cli:operator' });
        try {
          await cli2.connect();
          const record = await cli2.status(msgId);
          assert.equal(record.state, 'queued');
          assert.equal(record.text, 'queued before crash');
        } finally {
          await cli2.close();
        }
      } finally {
        await cli.close();
        await dsh.close();
      }
    } finally {
      await manager.stop();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
