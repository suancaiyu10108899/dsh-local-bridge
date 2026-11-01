import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HubStore } from '../src/store.mjs';
import { runtimePaths } from '../src/runtime.mjs';
import { createClientGrant, authenticateClientGrant, beginClientRequest, markClientRequestQueued } from '../src/client-access.mjs';
import { auditClientRollback, quarantineClientRollback } from '../src/client-rollback.mjs';

const clientIdentity = 'client:dot-22222222-2222-4222-8222-222222222222';
const target = 'codex:33333333-3333-4333-8333-333333333333';

test('rollback audit is read-only and quarantine preserves evidence without reading the token', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-client-rollback-'));
  try {
    const paths = runtimePaths(root);
    fs.mkdirSync(path.dirname(paths.tokenFile), { recursive: true });
    fs.writeFileSync(paths.tokenFile, 'synthetic-not-used-token\n', 'utf8');
    const store = new HubStore({ stateFile: paths.stateFile, eventsFile: paths.eventsFile }).load();
    store.addTarget(target);
    store.enqueue({
      v: 1, msg_id: 'm-rollback-client-1', from: clientIdentity, to: target,
      kind: 'text', text: 'synthetic rollback body', ttl_ms: 60_000,
      meta: { client_request_id: 'rollback-request-1', client_identity: clientIdentity, reply_to: clientIdentity },
    });
    const created = createClientGrant({ runtimeDir: root, clientIdentity, targets: [target] });
    const grant = authenticateClientGrant({ runtimeDir: root, grantId: created.grant_id, clientIdentity, credential: fs.readFileSync(created.credential_file, 'utf8').trim() });
    beginClientRequest({ runtimeDir: root, grant, clientIdentity, requestId: 'rollback-request-1', target, text: 'synthetic rollback body' });
    markClientRequestQueued({ runtimeDir: root, clientIdentity, requestId: 'rollback-request-1', msgId: 'm-rollback-client-1' });

    const audit = auditClientRollback({ runtimeDir: root });
    assert.equal(audit.token_touched, false);
    assert.equal(audit.messages.active, 1);
    assert.equal(audit.requests.active, 1);
    assert.equal(fs.readFileSync(paths.tokenFile, 'utf8'), 'synthetic-not-used-token\n');

    const dry = quarantineClientRollback({ runtimeDir: root });
    assert.equal(dry.dry_run, true);
    assert.equal(dry.messages.active, 1);

    const result = quarantineClientRollback({ runtimeDir: root, confirm: true, actor: 'test', reason: 'test-rollback' });
    assert.equal(result.dry_run, false);
    assert.equal(result.token_touched, false);
    assert.equal(result.old_state_snapshot_restored, false);
    assert.equal(fs.readFileSync(paths.tokenFile, 'utf8'), 'synthetic-not-used-token\n');
    const reloaded = new HubStore({ stateFile: paths.stateFile, eventsFile: paths.eventsFile }).load();
    assert.equal(reloaded.getMessage('m-rollback-client-1').state, 'failed');
    const requestFile = fs.readdirSync(path.join(root, 'clients', 'requests')).find((name) => name.endsWith('.json'));
    const request = JSON.parse(fs.readFileSync(path.join(root, 'clients', 'requests', requestFile), 'utf8'));
    assert.equal(request.state, 'ROLLBACK_QUARANTINED');
    assert.equal(request.rollback_previous_state, 'QUEUED');
    assert.equal(fs.existsSync(result.audit_file), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});