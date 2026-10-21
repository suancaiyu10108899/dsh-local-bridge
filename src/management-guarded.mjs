// Guarded management composition (T5/A, isolated).
//
// Ties src/management-policy.mjs to an abstract, non-executing management API:
//   api = { createWorkspace({path}), createSession({workspaceId}),
//           archiveSession({sessionId, stopActivity}), deleteWorkspace({workspaceId}) }
// The adapter in a live integration would bind these to src/management.mjs with a
// real host ctx; this module is deliberately not imported by the running plugin.
//
// Guarantees:
//   - approval scope (human/host-owned) is re-read per operation and must be unexpired;
//   - every path is canonicalized and must stay inside the approved allowlist
//     (realpath + junction/symlink component rejection in the policy layer);
//   - per-operation bounds: 1 workspace / 3 blank sessions (approval may tighten);
//   - durable operation-ID ledger gives replay idempotency and mismatch refusal;
//   - archive/delete only for IDs this policy created (or explicitly adopted);
//   - no prompt/execute/followup method may appear on the api surface;
//   - creation is separate from execution.
import {
  ManagementPolicyError,
  OperationLedger,
  loadApproval,
  resolveSafeTarget,
} from './management-policy.mjs';

const REQUIRED_API = Object.freeze(['createWorkspace', 'createSession', 'archiveSession', 'deleteWorkspace']);
const FORBIDDEN_API = Object.freeze(['prompt', 'execute', 'followup', 'run', 'createUserMessage', 'sendMessageToThread']);

export function assertGuardedApi(api) {
  if (api === null || typeof api !== 'object') throw new ManagementPolicyError('policy-invalid-api', 'management api must be an object');
  for (const name of FORBIDDEN_API) {
    if (typeof api[name] === 'function') {
      throw new ManagementPolicyError('policy-execution-not-allowed', `management api exposes forbidden execution method "${name}"`);
    }
  }
  for (const name of REQUIRED_API) {
    if (typeof api[name] !== 'function') {
      throw new ManagementPolicyError('policy-invalid-api', `management api is missing "${name}"`);
    }
  }
  return { ok: true, methods: [...REQUIRED_API] };
}

/**
 * @param {{api: object, approvalFile: string, ledgerFile: string, now?: () => number}} options
 */
export function createGuardedManagement({ api, approvalFile, ledgerFile, now = Date.now } = {}) {
  assertGuardedApi(api);
  if (typeof approvalFile !== 'string' || approvalFile.length === 0) throw new ManagementPolicyError('policy-invalid-argument', 'approvalFile is required');
  if (typeof ledgerFile !== 'string' || ledgerFile.length === 0) throw new ManagementPolicyError('policy-invalid-argument', 'ledgerFile is required');
  const ledger = new OperationLedger({ file: ledgerFile, now });

  const scope = () => loadApproval(approvalFile, { now });

  async function run({ operationId, kind, request, body }) {
    const approval = scope();
    const began = ledger.begin({ operationId, kind, request, scopeId: approval.approvalId });
    if (began.replay) return { ...began.record.result, replayed: true };
    try {
      const result = await body(approval, began.record);
      ledger.complete({ operationId, result });
      return result;
    } catch (error) {
      ledger.fail({ operationId, code: error.code ?? 'management-operation-failed', message: String(error.message ?? error) });
      throw error;
    }
  }

  return {
    /** Create one workspace inside the approved allowlist. */
    createWorkspace({ operationId, path: requestedPath } = {}) {
      return run({
        operationId,
        kind: 'create',
        request: { op: 'createWorkspace', path: requestedPath },
        body: async (approval, record) => {
          ledger.assertCreateLimits({ workspaces: record.counts.workspaces + 1, sessions: record.counts.sessions, scope: approval });
          const canonicalPath = resolveSafeTarget(requestedPath, { allowRoots: approval.allowRoots });
          const created = await api.createWorkspace({ path: canonicalPath });
          ledger.noteCreated({ operationId, kind: 'workspace', id: created.workspaceId, scope: approval });
          return { workspaceId: created.workspaceId, created: created.created === true, path: canonicalPath };
        },
      });
    },

    /** Create up to three blank sessions in one explicitly bounded operation. */
    createBlankSessions({ operationId, workspaceId, count = 1 } = {}) {
      if (typeof workspaceId !== 'string' || workspaceId.length === 0) throw new ManagementPolicyError('policy-invalid-argument', 'workspaceId is required');
      if (!Number.isSafeInteger(count) || count < 1) throw new ManagementPolicyError('policy-invalid-argument', 'count must be a positive integer');
      return run({
        operationId,
        kind: 'create',
        request: { op: 'createBlankSessions', workspaceId, count },
        body: async (approval, record) => {
          ledger.assertOwned({ kind: 'workspace', id: workspaceId });
          ledger.assertCreateLimits({ workspaces: record.counts.workspaces, sessions: record.counts.sessions + count, scope: approval });
          const sessions = [];
          for (let index = 0; index < count; index += 1) {
            const created = await api.createSession({ workspaceId });
            ledger.noteCreated({ operationId, kind: 'session', id: created.sessionId, scope: approval });
            sessions.push({ sessionId: created.sessionId, ...(created.agentPreset === undefined ? {} : { agentPreset: created.agentPreset }) });
          }
          return { workspaceId, sessions };
        },
      });
    },

    /** Archive only a session created by this policy (or explicitly adopted). */
    archiveOwnedSession({ operationId, sessionId } = {}) {
      return run({
        operationId,
        kind: 'archiveSession',
        request: { op: 'archiveOwnedSession', sessionId },
        body: async () => {
          ledger.assertOwned({ kind: 'session', id: sessionId });
          const result = await api.archiveSession({ sessionId, stopActivity: false });
          return { sessionId, archived: result.archived === true, stopActivity: false };
        },
      });
    },

    /** Delete only a workspace created by this policy (or explicitly adopted). */
    deleteOwnedWorkspace({ operationId, workspaceId } = {}) {
      return run({
        operationId,
        kind: 'delete',
        request: { op: 'deleteOwnedWorkspace', workspaceId },
        body: async () => {
          ledger.assertOwned({ kind: 'workspace', id: workspaceId });
          const result = await api.deleteWorkspace({ workspaceId });
          return { workspaceId, deleted: result.deleted === true };
        },
      });
    },

    status() {
      const ledgerState = ledger.snapshot();
      try {
        const approval = scope();
        return { approvalValid: true, approvalId: approval.approvalId, approvedBy: approval.approvedBy, expiresAt: approval.expiresAt, operations: Object.keys(ledgerState.operations).length, createdWorkspaces: ledgerState.createdWorkspaces.length, createdSessions: ledgerState.createdSessions.length };
      } catch (error) {
        return { approvalValid: false, code: error.code ?? 'policy-approval-invalid', operations: Object.keys(ledgerState.operations).length };
      }
    },
  };
}
