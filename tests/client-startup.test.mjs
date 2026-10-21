import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const clientUrl = new URL('../src/client.mjs', import.meta.url).href;
const pluginUrl = new URL('../adapters/dsh/plugin.mjs', import.meta.url).href;
const prelude = `
  import net from 'node:net';
  import assert from 'node:assert/strict';
  import { HubClient } from ${JSON.stringify(clientUrl)};
  import { startHubLoop } from ${JSON.stringify(pluginUrl)};
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const stop = server => new Promise(resolve => server.close(resolve));
  const options = port => ({ host: '127.0.0.1', port, token: 'startup-test-token', role: 'dsh', identity: 'dsh:startup-test' });
  async function closedPort() {
    const server = net.createServer();
    await listen(server);
    const port = server.address().port;
    await stop(server);
    return port;
  }
`;

function assertSurvives(body) {
  const child = spawnSync(process.execPath, [
    '--unhandled-rejections=strict', '--input-type=module', '-e', prelude + body,
  ], { encoding: 'utf8', timeout: 8_000, windowsHide: true });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.equal(child.signal, null);
}

test('refused hub connection rejects connect without an orphan welcome rejection', () => {
  assertSurvives(`
    const client = new HubClient(options(await closedPort()));
    await assert.rejects(client.connect({ timeoutMs: 200 }), error =>
      ['connect-failed', 'connection-error'].includes(error.code));
    await client.close();
    await sleep(40);
  `);
});

test('real adapter retry loop survives repeated offline-hub failures', () => {
  assertSurvives(`
    const port = await closedPort();
    let failures = 0;
    const dispose = startHubLoop({
      clientFactory: () => new HubClient(options(port)),
      onDelivery: () => assert.fail('offline hub must not deliver'),
      log: event => { if (event === 'dsh-plugin/hub-connect-failed') failures++; },
      delayMs: 10,
    });
    await sleep(180);
    await dispose();
    await sleep(40);
    assert.ok(failures >= 2, 'must exercise retry, not just one connection');
  `);
});

test('peer closes before welcome without crashing the adapter process', () => {
  assertSurvives(`
    const server = net.createServer(socket => { socket.resume(); socket.end(); });
    await listen(server);
    const client = new HubClient(options(server.address().port));
    try {
      await assert.rejects(client.connect({ timeoutMs: 200 }), error =>
        ['connection-closed', 'connection-error', 'connect-failed'].includes(error.code));
    } finally { await client.close(); await stop(server); }
    await sleep(40);
  `);
});

test('welcome timeout remains observable without an unhandled rejection', () => {
  assertSurvives(`
    const server = net.createServer(socket => socket.resume());
    await listen(server);
    const client = new HubClient(options(server.address().port));
    try {
      await assert.rejects(client.connect({ timeoutMs: 40 }), error => error.code === 'welcome-timeout');
    } finally { await client.close(); await stop(server); }
    await sleep(40);
  `);
});
