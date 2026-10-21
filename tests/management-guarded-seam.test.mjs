import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGuardedManagement } from '../src/management-guarded.mjs';
import { archiveSession, createSession, createWorkspace, deleteWorkspace } from '../src/management.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lab-guarded-seam-'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function mockHostContext({ calls }) {
  const services = {
    sessionController: {
      async create(request) {
        calls.push(['sessionController.create', request]);
        return { sessionId: `session-seam-${calls.length}`, agentPreset: 'standard' };
      },
      async list() {
        calls.push(['sessionController.list']);
        return { items: [] };
      },
    },
    workspaceController: {
      async create(request) {
        calls.push(['workspaceController.create', request]);
        return { workspace: { workspaceId: 'ws-seam-1', path: request.path }, created: true };
      },
      async delete(request) {
        calls.push(['workspaceController.delete', request]);
        return { deleted: true };
      },
      async archiveSession(request) {
        calls.push(['workspaceController.archiveSession', request]);
        return { archivedSessionIds: [request.sessionId] };
      },
    },
  };
  return {
    reflect: {
      get(name) {
        return services[name];
      },
    },
  };
}

test('guarded composition seam: policy -> real management module -> mock host services', async () => {
  const base = tempDir();
  const allowRoot = path.join(base, 'managed');
  fs.mkdirSync(allowRoot);
  const approvalFile = path.join(base, 'approval.json');
  writeJson(approvalFile, {
    approvalId: 'seam-approval',
    approvedBy: 'human-local',
    allowExecution: false,
    expiresAt: Date.now() + 60_000,
    allowRoots: [allowRoot],
    maxWorkspacesPerOperation: 1,
    maxSessionsPerOperation: 3,
  });
  const calls = [];
  const ctx = mockHostContext({ calls });
  const api = {
    createWorkspace: (request) => createWorkspace(ctx, request),
    createSession: (request) => createSession(ctx, request),
    archiveSession: (request) => archiveSession(ctx, request),
    deleteWorkspace: (request) => deleteWorkspace(ctx, request),
  };
  const guard = createGuardedManagement({ api, approvalFile, ledgerFile: path.join(base, 'ledger.json') });

  const workspace = await guard.createWorkspace({ operationId: 'seam-ws', path: path.join(allowRoot, 'project') });
  assert.equal(workspace.workspaceId, 'ws-seam-1');
  const created = await guard.createBlankSessions({ operationId: 'seam-sessions', workspaceId: workspace.workspaceId, count: 2 });
  assert.equal(created.sessions.length, 2);
  const sessionId = created.sessions[0].sessionId;
  const archived = await guard.archiveOwnedSession({ operationId: 'seam-archive', sessionId });
  assert.equal(archived.archived, true);
  const deleted = await guard.deleteOwnedWorkspace({ operationId: 'seam-delete', workspaceId: workspace.workspaceId });
  assert.equal(deleted.deleted, true);

  assert.deepEqual(calls.map((call) => call[0]), [
    'workspaceController.create',
    'sessionController.create',
    'sessionController.create',
    'workspaceController.archiveSession',
    'workspaceController.delete',
  ]);
  assert.deepEqual(calls[3][1], { sessionId });
  assert.equal(calls.some((call) => call[0].includes('prompt')), false, 'no prompt/execution may reach the host');
  const status = guard.status();
  assert.equal(status.createdWorkspaces, 1);
  assert.equal(status.createdSessions, 2);
});

test('guarded seam fails closed when the host service is missing', async () => {
  const base = tempDir();
  const allowRoot = path.join(base, 'managed');
  fs.mkdirSync(allowRoot);
  const approvalFile = path.join(base, 'approval.json');
  writeJson(approvalFile, {
    approvalId: 'seam-approval-2',
    approvedBy: 'human-local',
    allowExecution: false,
    expiresAt: Date.now() + 60_000,
    allowRoots: [allowRoot],
  });
  const emptyCtx = { reflect: { get: () => undefined } };
  const api = {
    createWorkspace: (request) => createWorkspace(emptyCtx, request),
    createSession: (request) => createSession(emptyCtx, request),
    archiveSession: (request) => archiveSession(emptyCtx, request),
    deleteWorkspace: (request) => deleteWorkspace(emptyCtx, request),
  };
  const ledgerFile = path.join(base, 'ledger.json');
  const guard = createGuardedManagement({ api, approvalFile, ledgerFile });
  await assert.rejects(
    guard.createWorkspace({ operationId: 'seam-missing', path: path.join(allowRoot, 'project') }),
    (error) => error.code === 'management-service-missing',
  );
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  assert.equal(ledger.operations['seam-missing'].status, 'failed');
});
