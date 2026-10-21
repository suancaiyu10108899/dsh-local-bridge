// Opt-in management tools and one-shot self-test for T5 (host conversation/workspace
// creation). Everything here is registered only when a local flag file exists, so
// the validated bridge plugin keeps its default surface unchanged:
//   <RUNTIME_DIR>/dsh-plugin/management-enabled
// A one-shot self-test request file drives a live create -> list -> archive -> delete
// cycle and writes a machine-readable result for evidence:
//   <RUNTIME_DIR>/dsh-plugin/management-selftest.json   (request, flips to done)
//   <RUNTIME_DIR>/dsh-plugin/management-selftest-result.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNTIME_DIR } from '../../src/runtime.mjs';
import {
  archiveSession,
  createSession,
  createWorkspace,
  deleteWorkspace,
  listSessions,
  resolveHostService,
} from '../../src/management.mjs';

export const MANAGEMENT_FLAG_FILE = path.join(RUNTIME_DIR, 'dsh-plugin', 'management-enabled');
export const MANAGEMENT_SELFTEST_FILE = path.join(RUNTIME_DIR, 'dsh-plugin', 'management-selftest.json');
export const MANAGEMENT_RESULT_FILE = path.join(RUNTIME_DIR, 'dsh-plugin', 'management-selftest-result.json');
export const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

export function isManagementEnabled() {
  return fs.existsSync(MANAGEMENT_FLAG_FILE);
}

function sessionSummary(item) {
  if (item === null || typeof item !== 'object') return item;
  return {
    sessionId: item.sessionId,
    ...(typeof item.title === 'string' ? { title: item.title } : {}),
    ...(typeof item.blank === 'boolean' ? { blank: item.blank } : {}),
    ...(typeof item.updatedAt === 'number' ? { updatedAt: item.updatedAt } : {}),
  };
}

/** Register the opt-in model-facing management tools on ctx.tools. */
export function registerManagementTools({ ctx, defineTool }) {
  const buildTool = (spec) => (defineTool !== undefined ? defineTool(spec) : fallbackTool(spec));
  const registered = [];
  const register = (spec) => {
    ctx.tools.register(buildTool(spec));
    registered.push(spec.name);
  };

  register({
    name: 'bridge_management_status',
    description: 'Report whether bridge host-management tools are enabled and which host services are composed.',
    parameters: {},
    output: { schema: { type: 'json' } },
    async execute() {
      const services = {};
      for (const name of ['sessionController', 'workspaceController']) {
        try {
          resolveHostService(ctx, name);
          services[name] = true;
        } catch {
          services[name] = false;
        }
      }
      return { ok: true, enabled: true, services, flagFile: MANAGEMENT_FLAG_FILE };
    },
  });

  register({
    name: 'bridge_workspace_create',
    description: 'Create a DSH project/workspace row for an absolute path (does not delete the directory on removal).',
    parameters: { path: { type: 'string', required: true, description: 'Absolute workspace directory path.' } },
    output: { schema: { type: 'json' } },
    async execute(args) {
      try {
        return { ok: true, ...(await createWorkspace(ctx, { path: args.path })) };
      } catch (error) {
        return { ok: false, code: error.code ?? 'workspace-create-failed', message: error.message };
      }
    },
  });

  register({
    name: 'bridge_workspace_delete',
    description: 'Delete a DSH workspace row by workspaceId (the directory content is untouched).',
    parameters: { workspaceId: { type: 'string', required: true } },
    output: { schema: { type: 'json' } },
    async execute(args) {
      try {
        return { ok: true, ...(await deleteWorkspace(ctx, { workspaceId: args.workspaceId })) };
      } catch (error) {
        return { ok: false, code: error.code ?? 'workspace-delete-failed', message: error.message };
      }
    },
  });

  register({
    name: 'bridge_session_create',
    description: 'Create a blank DSH conversation (no prompt, no turn) via the host session controller; returns the real session id.',
    parameters: {
      workspaceId: { type: 'string', description: 'Target workspace id (optional).' },
      cwd: { type: 'string', description: 'Working directory for the new conversation (optional).' },
      sessionId: { type: 'string', description: 'Named session id to reuse while blank (optional).' },
      agentPreset: { type: 'string', description: 'Agent preset (optional).' },
    },
    output: { schema: { type: 'json' } },
    async execute(args) {
      try {
        return { ok: true, ...(await createSession(ctx, args ?? {})) };
      } catch (error) {
        return { ok: false, code: error.code ?? 'session-create-failed', message: error.message };
      }
    },
  });

  register({
    name: 'bridge_session_list',
    description: 'List persisted DSH conversation summaries (id/title/blank/updatedAt) without activating any agent.',
    parameters: { cursor: { type: 'string', description: 'Optional pagination cursor.' }, limit: { type: 'number' } },
    output: { schema: { type: 'json' } },
    async execute(args = {}) {
      try {
        const result = await listSessions(ctx, { cursor: args.cursor });
        const limit = Number.isSafeInteger(args.limit) ? Math.min(Math.max(args.limit, 1), 100) : 20;
        return { ok: true, count: result.count, items: result.items.slice(0, limit).map(sessionSummary) };
      } catch (error) {
        return { ok: false, code: error.code ?? 'session-list-failed', message: error.message };
      }
    },
  });

  register({
    name: 'bridge_session_archive',
    description: 'Archive a DSH conversation (optionally stopping its running activity first).',
    parameters: {
      sessionId: { type: 'string', required: true },
      stopActivity: { type: 'boolean', description: 'Stop running turns/jobs before archiving (default false).' },
    },
    output: { schema: { type: 'json' } },
    async execute(args) {
      try {
        return { ok: true, ...(await archiveSession(ctx, { sessionId: args.sessionId, stopActivity: args.stopActivity === true })) };
      } catch (error) {
        return { ok: false, code: error.code ?? 'session-archive-failed', message: error.message };
      }
    },
  });

  return registered;
}

/** Minimal definition builder matching ctx.tools.register's contract. */
function fallbackTool(spec) {
  const properties = {};
  const required = [];
  for (const [name, item] of Object.entries(spec.parameters ?? {})) {
    properties[name] = { type: item.type };
    if (typeof item.description === 'string') properties[name].description = item.description;
    if (item.required === true) required.push(name);
  }
  const schema = { type: 'object', properties };
  if (required.length > 0) schema.required = required;
  return {
    name: spec.name,
    description: spec.description,
    parameters: schema,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    },
    async execute(args, exec) {
      return spec.execute(args, exec);
    },
  };
}

/**
 * One-shot live self-test: create workspace -> create blank session -> list it ->
 * archive session -> delete workspace. Never prompts the created conversation.
 * Marks the request done so an HMR reload cannot repeat it.
 */
export async function runManagementSelftest({ ctx, log = () => {} }) {
  const request = readJson(MANAGEMENT_SELFTEST_FILE);
  if (request === undefined || request.pending !== true || request.done === true || request.status === 'running') return undefined;
  writeJson(MANAGEMENT_SELFTEST_FILE, { ...request, status: 'running', startedAt: new Date().toISOString() });
  const startedAt = new Date().toISOString();
  const result = { at: startedAt, ok: false, requestId: request.requestId, steps: {} };
  try {
    if (Array.isArray(request.cleanupSessionIds) && request.cleanupSessionIds.length > 0) {
      result.steps.cleanupSessions = [];
      for (const sessionId of request.cleanupSessionIds) {
        try {
          result.steps.cleanupSessions.push({ sessionId, ...(await archiveSession(ctx, { sessionId, stopActivity: false })) });
        } catch (error) {
          result.steps.cleanupSessions.push({ sessionId, ok: false, code: error.code ?? 'cleanup-failed', message: error.message });
        }
      }
    }
    if (Array.isArray(request.cleanupWorkspaceIds) && request.cleanupWorkspaceIds.length > 0) {
      result.steps.cleanup = [];
      for (const workspaceId of request.cleanupWorkspaceIds) {
        try {
          result.steps.cleanup.push({ workspaceId, ...(await deleteWorkspace(ctx, { workspaceId })) });
        } catch (error) {
          result.steps.cleanup.push({ workspaceId, ok: false, code: error.code ?? 'cleanup-failed', message: error.message });
        }
      }
    }
    const workspace = await createWorkspace(ctx, { path: request.workspacePath });
    result.steps.workspace = workspace;
    // The host rejects passing both workspaceId and cwd; the workspace owns the directory.
    const session = await createSession(ctx, { workspaceId: workspace.workspaceId });
    result.steps.session = session;
    const listed = await listSessions(ctx, {});
    result.steps.list = { count: listed.count, found: listed.items.some((item) => item.sessionId === session.sessionId) };
    result.steps.archive = await archiveSession(ctx, { sessionId: session.sessionId, stopActivity: false });
    result.steps.delete = await deleteWorkspace(ctx, { workspaceId: workspace.workspaceId });
    result.ok = result.steps.list.found === true && result.steps.archive.archived === true && result.steps.delete.deleted === true;
    result.finishedAt = new Date().toISOString();
  } catch (error) {
    result.error = { code: error.code ?? 'management-selftest-failed', message: String(error?.message ?? error), details: error.details };
    result.finishedAt = new Date().toISOString();
  }
  writeJson(MANAGEMENT_RESULT_FILE, result);
  writeJson(MANAGEMENT_SELFTEST_FILE, { ...request, pending: false, status: 'done', done: true, finishedAt: result.finishedAt });
  log('dsh-plugin/management-selftest', {
    ok: result.ok,
    workspaceId: result.steps.workspace?.workspaceId,
    sessionId: result.steps.session?.sessionId,
    found: result.steps.list?.found,
    archived: result.steps.archive?.archived,
    deleted: result.steps.delete?.deleted,
    error: result.error?.code,
  });
  return result;
}
