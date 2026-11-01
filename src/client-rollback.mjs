// Offline, auditable rollback helper for the restricted client lane.
//
// It never reads or copies the Hub token, never restores an old Hub state
// snapshot, and never deletes client request/reply evidence. It is intended to
// be run only after the new Hub/companion has been explicitly stopped and
// before an older Hub is started.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HubStore } from './store.mjs';
import { runtimePaths } from './runtime.mjs';
import { clientPaths } from './client-access.mjs';

export const CLIENT_ROLLBACK_SCHEMA = 'client-rollback-audit/1';
const ACTIVE_REQUEST_STATES = new Set([
  'SUBMITTING', 'QUEUED', 'DELIVERED', 'CLAIMED', 'NATIVE_QUEUED', 'UNCERTAIN',
]);
const ACTIVE_MESSAGE_STATES = new Set(['queued', 'delivering', 'delivery_unknown']);

function sha256File(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
  catch { return null; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

function requestRows(runtimeDir, now) {
  const dir = clientPaths(runtimeDir).requests;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { entries = []; }
  const rows = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(dir, entry.name);
    const record = readJson(file);
    if (record === null || typeof record !== 'object') {
      rows.push({ file, corrupt: true, request_id: null, state: 'CORRUPT', active: true });
      continue;
    }
    const active = ACTIVE_REQUEST_STATES.has(record.state);
    rows.push({
      file, request_id: record.request_id ?? null, client_identity: record.client_identity ?? null,
      target_identity: record.target_identity ?? null, request_msg_id: record.msg_id ?? null,
      state: record.state ?? null, active, file_sha256: sha256File(file),
      created_at: record.created_at ?? null,
    });
  }
  rows.sort((a, b) => String(a.file).localeCompare(String(b.file)));
  return rows;
}

function messageRows(store) {
  return store.listMessages({ limit: 10_000 }).filter((message) => message.from_role === 'client' || String(message.from ?? '').startsWith('client:'));
}

/** Read-only inventory. Never writes and never reads the Hub token. */
export function auditClientRollback({ runtimeDir, now = Date.now() } = {}) {
  if (typeof runtimeDir !== 'string' || !path.isAbsolute(runtimeDir)) throw new TypeError('runtimeDir must be absolute');
  const paths = runtimePaths(runtimeDir);
  if (!fs.existsSync(paths.stateFile)) {
    const error = new Error(`runtime state is missing: ${paths.stateFile}`);
    error.code = 'runtime-state-missing';
    throw error;
  }
  const store = new HubStore({ stateFile: paths.stateFile, eventsFile: paths.eventsFile }).load();
  const messages = messageRows(store).map((message) => ({
    msg_id: message.msg_id, from: message.from, from_role: message.from_role,
    to: message.to, state: message.state, attempts: message.attempts,
    active: ACTIVE_MESSAGE_STATES.has(message.state),
    next_attempt_at: message.next_attempt_at ?? null,
    last_error: message.last_error ?? null,
  }));
  const requests = requestRows(runtimeDir, now);
  return {
    schema: CLIENT_ROLLBACK_SCHEMA,
    runtime_root: runtimeDir,
    generated_at: new Date(now).toISOString(),
    token_touched: false,
    old_state_snapshot_restored: false,
    messages: {
      total: messages.length,
      active: messages.filter((message) => message.active).length,
      rows: messages,
    },
    requests: {
      total: requests.length,
      active: requests.filter((request) => request.active).length,
      rows: requests,
    },
  };
}

function writeAtomic(file, value) {
  const temp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  fs.renameSync(temp, file);
}

/**
 * Quarantine non-terminal client records offline. `confirm:true` is required;
 * without it this is a plan only. Does not read/copy the token or restore a
 * previous state snapshot. Preserves every request/reply file and records the
 * previous state.
 */
export function quarantineClientRollback({ runtimeDir, confirm = false, actor = 'cli:operator', reason = 'client-rollback-quarantine', now = Date.now() } = {}) {
  const audit = auditClientRollback({ runtimeDir, now });
  if (confirm !== true) {
    return { ok: true, dry_run: true, ...audit };
  }
  const paths = runtimePaths(runtimeDir);
  const store = new HubStore({ stateFile: paths.stateFile, eventsFile: paths.eventsFile }).load();
  const messages = [];
  for (const message of messageRows(store)) {
    if (!ACTIVE_MESSAGE_STATES.has(message.state)) continue;
    try {
      const updated = store.transition(message.msg_id, 'failed', {
        last_error: reason,
        rollback_quarantined_at: new Date(now).toISOString(),
        rollback_previous_state: message.state,
        rollback_actor: actor,
      });
      messages.push({ msg_id: message.msg_id, previous_state: message.state, state: updated.state });
    } catch (error) {
      messages.push({ msg_id: message.msg_id, previous_state: message.state, error: error?.code ?? String(error) });
    }
  }
  const requests = [];
  for (const row of requestRows(runtimeDir, now)) {
    if (!row.active || row.corrupt === true) {
      requests.push({ file: row.file, state: row.state, changed: false, corrupt: row.corrupt === true });
      continue;
    }
    const record = readJson(row.file);
    if (record === null) { requests.push({ file: row.file, state: row.state, changed: false, corrupt: true }); continue; }
    const next = {
      ...record,
      state: 'ROLLBACK_QUARANTINED',
      rollback_previous_state: record.state,
      rollback_quarantined_at: new Date(now).toISOString(),
      rollback_actor: actor,
      rollback_reason: reason,
    };
    writeAtomic(row.file, next);
    requests.push({ file: row.file, request_id: record.request_id, previous_state: record.state, state: next.state, changed: true });
  }
  const auditFile = path.join(clientPaths(runtimeDir).root, `rollback-audit-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(auditFile), { recursive: true });
  const result = {
    schema: CLIENT_ROLLBACK_SCHEMA,
    ok: true,
    dry_run: false,
    generated_at: new Date(now).toISOString(),
    runtime_root: runtimeDir,
    token_touched: false,
    old_state_snapshot_restored: false,
    actor,
    reason,
    messages,
    requests,
    audit_file: auditFile,
  };
  writeAtomic(auditFile, result);
  return result;
}