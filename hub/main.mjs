// Hub process entry point: `node hub/main.mjs`.
import fs from 'node:fs';
import {
  EVENTS_FILE,
  SERVER_INFO_FILE,
  STATE_FILE,
  ensureRuntimeDirs,
  ensureToken,
  loadConfig,
  writeJsonAtomic,
} from '../src/runtime.mjs';
import { HubStore } from '../src/store.mjs';
import { BridgeHub } from '../src/hub.mjs';

const config = loadConfig();
ensureRuntimeDirs();
const token = ensureToken();

const logger = (event, detail) => {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...detail });
  process.stdout.write(`${line}\n`);
};

const store = new HubStore({
  stateFile: STATE_FILE,
  eventsFile: EVENTS_FILE,
  maxTerminalRecords: config.max_terminal_records,
  maxMessages: config.max_messages,
}).load();

const hub = new BridgeHub({
  store,
  token,
  host: config.host,
  port: config.port,
  ackTimeoutMs: config.ack_timeout_ms,
  maxAttempts: config.max_delivery_attempts,
  logger,
});

let address;
try {
  address = await hub.start();
} catch (error) {
  if (error?.code === 'EADDRINUSE') {
    logger('hub/port-in-use', { host: config.host, port: config.port, hint: 'another hub may already be running; run `node bin/lab-bridge.mjs check`' });
    process.exitCode = 1;
  } else {
    logger('hub/start-failed', { message: String(error?.stack ?? error) });
    process.exitCode = 1;
  }
  address = undefined;
}

if (address !== undefined) {
  writeJsonAtomic(SERVER_INFO_FILE, {
    pid: process.pid,
    host: config.host,
    port: address.port,
    address: address.address,
    server_id: store.serverId,
    started_at: hub.startedAt,
    node: process.version,
    state_file: STATE_FILE,
  });
  logger('hub/ready', { address: address.address, server_id: store.serverId, pid: process.pid });

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    logger('hub/stopping', { signal });
    try {
      await hub.stop();
    } finally {
      try {
        fs.rmSync(SERVER_INFO_FILE, { force: true });
      } catch {
        /* best effort */
      }
      logger('hub/stopped', {});
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
