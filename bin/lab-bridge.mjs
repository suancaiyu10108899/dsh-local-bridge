#!/usr/bin/env node
// Local Agent Bridge operator CLI.
// Usage:
//   node bin/lab-bridge.mjs init
//   node bin/lab-bridge.mjs serve
//   node bin/lab-bridge.mjs pair add <role:id> [--label TEXT] [--host TEXT] [--runtime DIR] [--installation ROOT]
//   node bin/lab-bridge.mjs pair remove <role:id> [--runtime DIR]
//   node bin/lab-bridge.mjs pair list [--runtime DIR]
//   node bin/lab-bridge.mjs send --to <role:id> --text TEXT [--origin ROLE:ID] [--msg-id ID] [--ttl-minutes N] [--runtime DIR]
//   node bin/lab-bridge.mjs status [--msg-id ID] [--to ROLE:ID] [--state STATE] [--limit N] [--runtime DIR]
//   node bin/lab-bridge.mjs targets [--runtime DIR]
//   node bin/lab-bridge.mjs consume --msg-id ID [--consumer ROLE:ID] [--note TEXT] [--runtime DIR]
//   node bin/lab-bridge.mjs install-dsh-plugin [--profile PATH] [--dry-run] [--no-watch]
//   node bin/lab-bridge.mjs uninstall-dsh-plugin [--profile PATH]
//   node bin/lab-bridge.mjs dsh-plugin-status [--profile PATH]
//   node bin/lab-bridge.mjs module-watch-status [--profile PATH]
//   node bin/lab-bridge.mjs enable-module-watch [--profile PATH]
//   node bin/lab-bridge.mjs disable-module-watch [--profile PATH]
//   node bin/lab-bridge.mjs receiver-status
//   node bin/lab-bridge.mjs service-status
//   node bin/lab-bridge.mjs check
import fs from 'node:fs';
import path from 'node:path';
import {
  CONFIG_FILE,
  HUB_DIR,
  RUNTIME_DIR,
  SERVER_INFO_FILE,
  STATE_FILE,
  TOKEN_FILE,
  ensureRuntimeDirs,
  ensureToken,
  loadConfig,
  readToken,
  runtimePaths,
} from '../src/runtime.mjs';
import { readInstallation } from '../src/installation.mjs';
import { attachDeliveryHints, readReceiverStatuses, readReceiverStatusesAsync } from '../src/receiver-status.mjs';
import { collectServiceStatus } from '../src/service-status.mjs';
import {
  OnboardingError,
  createOnboardingRequest,
  discoverOnboarding,
  getOnboardingRequest,
  listOnboardingRequests,
  recordManualOnboardingReceipt,
  resolveOnboardingRuntime,
  retryOnboardingRequest,
  revokeOnboardingRequest,
} from '../src/manual-onboarding.mjs';
import { HubClient, withHubClient } from '../src/client.mjs';
import { clientPaths, createClientGrant, loadClientGrant, revokeClientGrant, isValidClientIdentity } from '../src/client-access.mjs';
import { ensureBootstrap, statusBootstrap, stopBootstrap } from '../src/companion-bootstrap.mjs';
import { auditClientRollback, quarantineClientRollback } from '../src/client-rollback.mjs';
import { identityRole, isValidIdentity, newMessageId } from '../src/protocol.mjs';
import {
  defaultProfilePath,
  disableModuleWatch,
  enableModuleWatch,
  installPlugin,
  moduleWatchStatus,
  pluginStatus,
  uninstallPlugin,
} from '../src/dsh-install.mjs';
import { serverInfoHealth } from '../src/health.mjs';

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

function out(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(code, message, details = {}) {
  process.stderr.write(`${JSON.stringify({ ok: false, code, message, ...details }, null, 2)}\n`);
  process.exitCode = 1;
}

function explicitRuntimeDir(flags) {
  if (flags.runtime === undefined) return null;
  if (typeof flags.runtime !== 'string' || flags.runtime.trim().length === 0) {
    const error = new Error('--runtime requires an existing Hub data directory');
    error.code = 'runtime-invalid';
    throw error;
  }
  return path.resolve(flags.runtime);
}

function cliRuntimeExpected(flags, runtimeDir) {
  if (flags.installation === undefined) return null;
  if (runtimeDir === null) {
    const error = new Error('--installation requires explicit --runtime');
    error.code = 'runtime-required';
    throw error;
  }
  if (typeof flags.installation !== 'string' || flags.installation.trim().length === 0) {
    const error = new Error('--installation must be a local installation root');
    error.code = 'installation-invalid';
    throw error;
  }
  let installation;
  try {
    installation = readInstallation({ root: path.resolve(flags.installation), required: true });
  } catch (error) {
    error.code = error.code ?? 'installation-invalid';
    throw error;
  }
  if (path.resolve(installation.runtime_root) !== runtimeDir) {
    const error = new Error('selected --runtime is not the locator runtime; refusing to mix installation and Hub data roots');
    error.code = 'runtime-installation-mismatch';
    throw error;
  }
  return { installation_id: installation.installation_id, instance_id: installation.instance_id };
}

function cliRuntimeContext(flags) {
  const explicitRuntime = explicitRuntimeDir(flags);
  const runtimeDir = explicitRuntime ?? path.resolve(RUNTIME_DIR);
  const expected = cliRuntimeExpected(flags, explicitRuntime);
  let config;
  let token;
  if (explicitRuntime !== null) {
    const paths = runtimePaths(explicitRuntime);
    if (!fs.existsSync(explicitRuntime) || !fs.statSync(explicitRuntime).isDirectory()) {
      const error = new Error(`explicit runtime does not exist: ${explicitRuntime}`);
      error.code = 'runtime-not-found';
      throw error;
    }
    if (!fs.existsSync(paths.configFile)) {
      const error = new Error(`explicit runtime is not initialized: ${paths.configFile}; access must not create a new runtime/token`);
      error.code = 'runtime-not-initialized';
      throw error;
    }
    config = JSON.parse(fs.readFileSync(paths.configFile, 'utf8'));
    const host = config.host ?? '127.0.0.1';
    if (host !== '127.0.0.1') {
      const error = new Error(`refusing non-loopback Hub host in explicit runtime: ${host}`);
      error.code = 'hub-non-loopback';
      throw error;
    }
    if (!fs.existsSync(paths.tokenFile)) {
      const error = new Error(`explicit runtime token is missing: ${paths.tokenFile}; access must not create a token`);
      error.code = 'token-missing';
      throw error;
    }
    token = fs.readFileSync(paths.tokenFile, 'utf8').trim();
    if (token.length < 32) {
      const error = new Error(`explicit runtime token is unusable: ${paths.tokenFile}`);
      error.code = 'token-invalid';
      throw error;
    }
    if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
      const error = new Error(`explicit runtime config port is invalid: ${paths.configFile}`);
      error.code = 'config-invalid';
      throw error;
    }
  } else {
    config = loadConfig();
    token = readToken();
  }
  return {
    runtimeDir,
    explicit: explicitRuntime !== null,
    expected,
    options: {
      host: config.host ?? '127.0.0.1',
      port: config.port,
      token,
      role: 'cli',
      identity: 'cli:operator',
      connectTimeoutMs: 3_000,
    },
  };
}

function hubOptions(flags = {}) {
  return cliRuntimeContext(flags).options;
}

async function withCliHubClient(flags, run) {
  const context = cliRuntimeContext(flags);
  return withHubClient(context.options, async (client) => {
    if (context.expected !== null) {
      const welcome = client.welcomeInfo ?? client.welcome;
      if (welcome?.installation_id !== context.expected.installation_id
          || welcome?.instance_id !== context.expected.instance_id) {
        const error = new Error('Hub welcome installation/instance does not match the selected locator; refusing cross-instance operation');
        error.code = 'hub-instance-mismatch';
        throw error;
      }
    }
    return run(client, context);
  });
}

function publicClientGrant(grant) {
  return {
    grant_id: grant.grant_id,
    client_identity: grant.client_identity,
    targets: grant.targets,
    mailbox: grant.mailbox,
    lease_ms: grant.lease_ms,
    expires_at: grant.expires_at,
    revoked_at: grant.revoked_at,
    max_pending: grant.max_pending,
    max_requests: grant.max_requests ?? 32,
    max_submits: grant.max_submits ?? 16,
    max_text_bytes: grant.max_text_bytes,
  };
}

function readRequiredTextFile(file, label) {
  if (typeof file !== 'string' || file.length === 0) throw Object.assign(new Error(`${label} required`), { code: `${label}-required` });
  const absolute = path.resolve(file);
  let value;
  try { value = fs.readFileSync(absolute, 'utf8'); } catch (error) { throw Object.assign(new Error(`${label} unreadable`), { code: `${label}-unreadable`, cause: error }); }
  if (value.length === 0) throw Object.assign(new Error(`${label} empty`), { code: `${label}-empty` });
  return { absolute, value };
}

function clientRuntimeContext(flags) {
  const explicit = explicitRuntimeDir(flags);
  const runtimeDir = explicit ?? path.resolve(RUNTIME_DIR);
  if (explicit !== null && !fs.existsSync(runtimeDir)) {
    const error = new Error(`explicit runtime does not exist: ${runtimeDir}`);
    error.code = 'runtime-not-found';
    throw error;
  }
  const configFile = runtimePaths(runtimeDir).configFile;
  if (!fs.existsSync(configFile)) {
    const error = new Error(`runtime is not initialized: ${configFile}; client access must not create a runtime/token`);
    error.code = 'runtime-not-initialized';
    throw error;
  }
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  if ((config.host ?? '127.0.0.1') !== '127.0.0.1') {
    const error = new Error('client endpoint host is not loopback');
    error.code = 'hub-non-loopback';
    throw error;
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    const error = new Error('client endpoint port is invalid');
    error.code = 'config-invalid';
    throw error;
  }
  return { runtimeDir, options: { host: '127.0.0.1', port: config.port } };
}
async function withScopedClient(flags, { grant, credentialFile }) {
  const context = clientRuntimeContext(flags);
  if (typeof credentialFile !== 'string' || credentialFile.length === 0) {
    throw Object.assign(new Error('--credential-file is required'), { code: 'client-credential-required' });
  }
  let credential;
  try { credential = fs.readFileSync(path.resolve(credentialFile), 'utf8').trim(); } catch { throw Object.assign(new Error('client credential unreadable'), { code: 'client-credential-unreadable' }); }
  const client = new HubClient({
    host: context.options.host,
    port: context.options.port,
    token: credential,
    role: 'client',
    identity: grant.client_identity,
    grantId: grant.grant_id,
    connectTimeoutMs: 3_000,
  });
  try {
    const welcome = await client.connect();
    return { client, welcome, context };
  } catch (error) {
    await client.close();
    throw error;
  }
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0];

  switch (command) {
    case 'init': {
      const config = loadConfig();
      const token = ensureToken();
      out({
        ok: true,
        runtime_dir: path.relative(process.cwd(), HUB_DIR),
        config: CONFIG_FILE,
        state: STATE_FILE,
        token_file: TOKEN_FILE,
        token_length: token.length,
        endpoint: `${config.host}:${config.port}`,
        next: 'node hub/main.mjs',
      });
      return;
    }
    case 'serve': {
      await import('../hub/main.mjs');
      return;
    }
    case 'pair': {
      const action = positional[1];
      const identity = positional[2];
      if (action === 'list') {
        const targets = await withCliHubClient(flags, (client) => client.targets());
        out({ ok: true, targets });
        return;
      }
      if (action !== 'add' && action !== 'remove') {
        fail('usage', 'pair add <role:id> | pair remove <role:id> | pair list');
        return;
      }
      if (identity === undefined) {
        fail('usage', `pair ${action} requires <role:id>`);
        return;
      }
      const result = await withCliHubClient(flags, async (client) => {
        if (action === 'add') return client.pairAdd(identity, { label: flags.label ?? '', host: flags.host ?? '' });
        return client.pairRemove(identity);
      });
      out({ ok: true, action, identity, result });
      return;
    }
    case 'send': {
      const to = flags.to;
      const text = flags.text;
      if (typeof to !== 'string' || typeof text !== 'string') {
        fail('usage', 'send --to <role:id> --text TEXT [--origin ROLE:ID] [--msg-id ID] [--ttl-minutes N]');
        return;
      }
      const from = typeof flags.from === 'string' ? flags.from : 'cli:operator';
      if (!isValidIdentity(from) || identityRole(from) !== 'cli') {
        fail(
          'from-role-invalid',
          `cli client cannot send as "${from}": the operator connection's role is cli. Use --origin <role:id> to declare the real peer origin (metadata, not authentication).`,
        );
        return;
      }
      const origin = flags.origin;
      if (origin !== undefined && (typeof origin !== 'string' || !isValidIdentity(origin))) {
        fail('origin-invalid', '--origin must be a role:id identity such as codex:<threadId>');
        return;
      }
      const ttlMinutes = flags['ttl-minutes'] === undefined ? undefined : Number(flags['ttl-minutes']);
      if (ttlMinutes !== undefined && (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0)) {
        fail('usage', '--ttl-minutes must be a positive number');
        return;
      }
      const envelope = {
        v: 1,
        msg_id: typeof flags['msg-id'] === 'string' ? flags['msg-id'] : newMessageId(),
        from,
        to,
        kind: 'text',
        text,
        ...(ttlMinutes === undefined ? {} : { ttl_ms: Math.round(ttlMinutes * 60_000) }),
        meta: { source: 'cli', ...(origin === undefined ? {} : { origin }) },
      };
      const accepted = await withCliHubClient(flags, (client) => client.sendMessage(envelope));
      out({ ok: true, ...accepted, from, to, ...(origin === undefined ? {} : { origin }) });
      return;
    }
    case 'status': {
      let receiverRuntimeDir = path.resolve(RUNTIME_DIR);
      const messages = await withCliHubClient(flags, async (client, context) => {
        receiverRuntimeDir = context.runtimeDir;
        if (typeof flags['msg-id'] === 'string') {
          const record = await client.status(flags['msg-id']);
          return record === undefined ? [] : [record];
        }
        return client.statusList({
          to: typeof flags.to === 'string' ? flags.to : undefined,
          from: typeof flags.from === 'string' ? flags.from : undefined,
          state: typeof flags.state === 'string' ? flags.state : undefined,
          limit: flags.limit === undefined ? 50 : Number(flags.limit),
        });
      });
      const receiverStatus = readReceiverStatuses({ runtimeDir: receiverRuntimeDir });
      const hinted = attachDeliveryHints(messages, receiverStatus);
      out({ ok: true, count: hinted.length, receivers: receiverStatus.receivers, messages: hinted });
      return;
    }
    case 'onboard': {
      const action = positional[1];
      const runtimeDir = typeof flags.runtime === 'string' ? path.resolve(flags.runtime) : undefined;
      const installationRoot = typeof flags.installation === 'string' ? path.resolve(flags.installation) : undefined;
      try {
        if (action === 'discover') {
          const context = resolveOnboardingRuntime({ runtimeDir, installationRoot });
          out({ ok: true, ...await discoverOnboarding({ runtimeRoot: context.runtime_root, installation: context.installation, locatorPath: context.locator_path, resolution: context.resolution }) });
          return;
        }
        if (action === 'request') {
          const source = typeof flags.source === 'string' ? flags.source : undefined;
          const target = typeof flags.target === 'string' ? flags.target : undefined;
          const result = await createOnboardingRequest({
            runtimeDir,
            installationRoot,
            source,
            target,
            messageId: typeof flags['message-id'] === 'string' ? flags['message-id'] : undefined,
            userAuthorized: flags['user-authorized'] === true,
            requestedBy: typeof flags['requested-by'] === 'string' ? flags['requested-by'] : 'cli:operator',
            authorizedBy: typeof flags['authorized-by'] === 'string' ? flags['authorized-by'] : 'cli:operator',
            note: typeof flags.note === 'string' ? flags.note : '',
            originArtifact: typeof flags['origin-artifact'] === 'string' ? flags['origin-artifact'] : undefined,
            requestId: typeof flags['request-id'] === 'string' ? flags['request-id'] : undefined,
          });
          out({ ok: true, ...result });
          return;
        }
        if (action === 'list') {
          const result = await listOnboardingRequests({
            runtimeDir,
            installationRoot,
            state: typeof flags.state === 'string' ? flags.state : undefined,
            limit: flags.limit === undefined ? 100 : Number(flags.limit),
          });
          out({ ok: true, ...result });
          return;
        }
        const requestId = positional[2] ?? (typeof flags['request-id'] === 'string' ? flags['request-id'] : undefined);
        if (action === 'status') {
          out(await getOnboardingRequest({ runtimeDir, installationRoot, requestId }));
          return;
        }
        if (action === 'retry') {
          out(await retryOnboardingRequest({
            runtimeDir,
            installationRoot,
            requestId,
            userAuthorized: flags['user-authorized'] === true ? true : undefined,
            authorizedBy: typeof flags['authorized-by'] === 'string' ? flags['authorized-by'] : undefined,
          }));
          return;
        }
        if (action === 'receipt') {
          out(await recordManualOnboardingReceipt({
            runtimeDir,
            installationRoot,
            requestId,
            messageId: typeof flags['message-id'] === 'string' ? flags['message-id'] : undefined,
            turnId: typeof flags['turn-id'] === 'string' ? flags['turn-id'] : undefined,
          }));
          return;
        }
        if (action === 'revoke') {
          out(await revokeOnboardingRequest({
            runtimeDir,
            installationRoot,
            requestId,
            reason: typeof flags.reason === 'string' ? flags.reason : '',
          }));
          return;
        }
        fail('onboard-usage', 'onboard discover|request|list|status|retry|receipt|revoke ...', {
          message_zh: 'onboard 用法：discover / request / list / status / retry / revoke。',
          next_steps: ['node bin/lab-bridge.mjs onboard request --source dsh:... --target codex:... --user-authorized'],
        });
      } catch (error) {
        if (error instanceof OnboardingError) {
          fail(error.code, error.message, { ...error.details, ...(error.details?.message_zh === undefined ? { message_zh: '请求未完成；保留已有本地记录，不覆盖。' } : {}) });
        } else {
          fail(error?.code ?? 'onboard-failed', String(error?.message ?? error), {
            message_zh: 'onboard 操作失败；未自动配对或启用。',
          });
        }
      }
      return;
    }    case 'targets': {
      const targets = await withCliHubClient(flags, (client) => client.targets());
      out({ ok: true, targets });
      return;
    }
    case 'consume': {
      const msgId = typeof flags['msg-id'] === 'string' ? flags['msg-id'] : positional[1];
      if (typeof msgId !== 'string' || msgId.length === 0) {
        fail('usage', 'consume --msg-id <id> [--consumer role:id] [--note TEXT]');
        return;
      }
      const message = await withCliHubClient(flags, (client) => client.consume(msgId, {
        consumer: typeof flags.consumer === 'string' ? flags.consumer : 'cli:operator',
        note: typeof flags.note === 'string' ? flags.note : '',
      }));
      out({ ok: true, message });
      return;
    }
    case 'install-dsh-plugin':
    case 'uninstall-dsh-plugin':
    case 'dsh-plugin-status':
    case 'module-watch-status':
    case 'enable-module-watch':
    case 'disable-module-watch': {
      const profilePath = typeof flags.profile === 'string' ? path.resolve(flags.profile) : defaultProfilePath();
      if (command === 'dsh-plugin-status') {
        out({ ok: true, ...pluginStatus({ profilePath }), moduleWatch: moduleWatchStatus({ profilePath }) });
        return;
      }
      if (command === 'module-watch-status') {
        out({ ok: true, ...moduleWatchStatus({ profilePath }) });
        return;
      }
      if (command === 'enable-module-watch' || command === 'disable-module-watch') {
        try {
          const result = command === 'enable-module-watch'
            ? enableModuleWatch({ profilePath })
            : disableModuleWatch({ profilePath });
          out(result);
        } catch (error) {
          fail(error.code ?? 'module-watch-failed', error.message);
        }
        return;
      }
      const watchEnabled = flags['no-watch'] !== true;
      if (command === 'install-dsh-plugin' && flags['dry-run'] === true) {
        const status = pluginStatus({ profilePath });
        const watch = moduleWatchStatus({ profilePath });
        out({
          ok: true,
          dryRun: true,
          profilePath,
          wouldInstall: status.profileExists && status.pluginFileExists && !status.installed,
          wouldEnableModuleWatch: watchEnabled && !watch.watched && !watch.rowPresent,
          ...status,
          moduleWatch: watch,
        });
        return;
      }
      try {
        if (command === 'install-dsh-plugin') {
          const watch = watchEnabled ? enableModuleWatch({ profilePath }) : moduleWatchStatus({ profilePath });
          try {
            const installed = installPlugin({ profilePath });
            out({ ...installed, moduleWatch: watch });
          } catch (error) {
            if (watchEnabled && watch.alreadyPresent !== true) {
              try {
                disableModuleWatch({ profilePath });
              } catch {
                /* best effort rollback of the module-watch row */
              }
            }
            throw error;
          }
        } else {
          const removed = uninstallPlugin({ profilePath });
          const watch = moduleWatchStatus({ profilePath });
          const watchRemoved = watch.watched ? disableModuleWatch({ profilePath }) : { ok: true, alreadyRemoved: !watch.watched };
          out({ ...removed, moduleWatch: watchRemoved });
        }
      } catch (error) {
        fail(error.code ?? 'dsh-plugin-failed', error.message);
      }
      return;
    }
    case 'client': {
      const action = positional[1];
      try {
        if (action === 'grant') {
          const targetSpec = flags.targets ?? flags.target;
          const targets = typeof targetSpec === 'string' ? targetSpec.split(',').map((value) => value.trim()).filter(Boolean) : [];
          if (targets.length === 0) {
            fail('client-grant-usage', 'client grant requires --targets <role:id[,role:id]>');
            return;
          }
          const clientIdentity = typeof flags.client === 'string'
            ? flags.client
            : `client:dot-${globalThis.crypto.randomUUID()}`;
          if (!isValidClientIdentity(clientIdentity)) {
            fail('client-identity-invalid', '--client must be client:dot-<uuid>');
            return;
          }
          const leaseMinutes = flags['lease-minutes'] === undefined ? 2 : Number(flags['lease-minutes']);
          const ttlMinutes = flags['ttl-minutes'] === undefined ? 1440 : Number(flags['ttl-minutes']);
          const maxRequests = flags['max-requests'] === undefined ? 32 : Number(flags['max-requests']);
          const maxSubmits = flags['max-submits'] === undefined ? 16 : Number(flags['max-submits']);
          if (!Number.isFinite(leaseMinutes) || leaseMinutes <= 0 || !Number.isFinite(ttlMinutes) || ttlMinutes <= 0) {
            fail('client-grant-usage', '--lease-minutes/--ttl-minutes must be positive');
            return;
          }
          await withCliHubClient(flags, async (hub, context) => {
            const paired = await hub.targets();
            for (const target of targets) {
              const match = paired.find((item) => item.identity === target && item.enabled === true);
              if (match === undefined) {
                const error = new Error(`target is not an enabled paired target: ${target}`);
                error.code = 'client-target-unpaired';
                throw error;
              }
            }
            const created = createClientGrant({
              runtimeDir: context.runtimeDir, clientIdentity, targets,
              leaseMs: Math.round(leaseMinutes * 60_000), ttlMs: Math.round(ttlMinutes * 60_000),
              maxRequests, maxSubmits,
            });
            out({ ok: true, ...created });
          });
          return;
        }
        if (action === 'rollback-audit') {
          const runtimeDir = explicitRuntimeDir(flags) ?? path.resolve(RUNTIME_DIR);
          out({ ok: true, ...auditClientRollback({ runtimeDir }) });
          return;
        }
        if (action === 'rollback-quarantine') {
          const runtimeDir = explicitRuntimeDir(flags) ?? path.resolve(RUNTIME_DIR);
          out(quarantineClientRollback({ runtimeDir, confirm: flags.confirm === true, actor: 'cli:operator', reason: flags.reason ?? 'client-rollback-quarantine' }));
          return;
        }
        if (action === 'list-grants') {
          const context = clientRuntimeContext(flags);
          const dir = clientPaths(context.runtimeDir).grants;
          let entries = [];
          try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { entries = []; }
          const grants = [];
          for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
            try {
              const grant = JSON.parse(fs.readFileSync(path.join(dir, entry.name), 'utf8'));
              grants.push(publicClientGrant(grant));
            } catch { /* skip malformed grant */ }
          }
          out({ ok: true, count: grants.length, grants });
          return;
        }
        if (action === 'revoke') {
          const grantId = flags.grant;
          if (typeof grantId !== 'string') {
            fail('client-grant-usage', 'client revoke --grant <grant-id>');
            return;
          }
          const context = clientRuntimeContext(flags);
          const grant = loadClientGrant({ runtimeDir: context.runtimeDir, grantId, allowExpired: true });
          const result = revokeClientGrant({ runtimeDir: context.runtimeDir, grantId, reason: flags.reason ?? '' });
          out({ ok: true, idempotent: result.idempotent, grant: publicClientGrant(result.grant) });
          return;
        }
        if (action === 'reply') {
          const body = readRequiredTextFile(flags['body-file'], 'body-file');
          const summary = await withCliHubClient(flags, async (hub) => hub.clientReply({
            clientIdentity: flags.client,
            clientRequestId: flags['request-id'],
            targetIdentity: flags.target,
            requestMsgId: flags['request-msg-id'] ?? flags['msg-id'],
            turnId: flags['turn-id'],
            body: body.value,
            bodySha256: flags['body-sha256'],
          }));
          out({ ok: true, request_id: summary.request?.request_id, reply_msg_id: summary.reply?.reply_msg_id,
            body_sha256: summary.reply?.body_sha256, bytes: summary.reply?.bytes, turn_id: summary.reply?.turn_id });
          return;
        }
        const grantId = flags.grant;
        const credentialFile = flags['credential-file'];
        if (typeof grantId !== 'string') {
          fail('client-grant-usage', `client ${String(action)} requires --grant <grant-id> --credential-file <path>`);
          return;
        }
        const context = clientRuntimeContext(flags);
        const grant = loadClientGrant({ runtimeDir: context.runtimeDir, grantId });
        if (!isValidClientIdentity(grant.client_identity)) {
          fail('client-grant-corrupt', 'grant client identity is invalid');
          return;
        }
        const connection = await withScopedClient(flags, { grant, credentialFile });
        try {
          if (action === 'request') {
            const text = readRequiredTextFile(flags['text-file'], 'text-file');
            const requestId = typeof flags['request-id'] === 'string' ? flags['request-id'] : newMessageId();
            if (typeof flags.to !== 'string') {
              fail('client-request-usage', 'client request --to <role:id> --request-id <id> --text-file <path>');
              return;
            }
            const result = await connection.client.clientRequest({
              clientRequestId: requestId, to: flags.to, text: text.value,
              ...(flags['ttl-minutes'] === undefined ? {} : { ttlMs: Math.round(Number(flags['ttl-minutes']) * 60_000) }),
            });
            out({ ok: true, grant_id: grant.grant_id, client_identity: grant.client_identity,
              request_id: requestId, msg_id: result.msg_id, state: result.state, expires_at: result.expires_at });
            return;
          }
          if (action === 'status') {
            const request = await connection.client.clientStatus(flags['request-id']);
            out({ ok: true, request });
            return;
          }
          if (action === 'resume') {
            const result = await connection.client.clientResume(flags['request-id']);
            out({ ok: true, state: result.state, reply: result.reply });
            return;
          }
          if (action === 'cancel') {
            const request = await connection.client.clientCancel(flags['request-id']);
            out({ ok: true, request });
            return;
          }
          fail('client-usage', 'client grant|request|status|resume|cancel|revoke|list-grants|reply');
        } finally {
          await connection.client.close();
        }
        return;
      } catch (error) {
        fail(error?.code ?? 'client-failed', String(error?.message ?? error), {
          ...(error?.details ?? {}),
          ...(error?.details?.message_zh === undefined ? { message_zh: '受限 client 操作失败；未自动 pair/enable/重发。' } : {}),
        });
        return;
      }
    }
    case 'companion': {
      const action = positional[1];
      const installationRoot = typeof flags.installation === 'string' ? path.resolve(flags.installation) : undefined;
      const runtimeDir = typeof flags.runtime === 'string' ? path.resolve(flags.runtime) : undefined;
      try {
        if (action === 'start') {
          const result = await ensureBootstrap({ installationRoot, runtimeDir, explicitStart: true, reason: 'MANUAL_START', env: process.env });
          out({ ok: result.ok, ...result });
          return;
        }
        if (action === 'stop') {
          const result = await stopBootstrap({ installationRoot, runtimeDir, actor: 'cli:operator', reason: flags.reason ?? 'MANUAL_STOP', env: process.env });
          out({ ok: result.ok, ...result });
          return;
        }
        if (action === 'status') {
          const result = await statusBootstrap({ installationRoot, runtimeDir, env: process.env });
          out({ ok: true, ...result });
          return;
        }
        fail('companion-usage', 'companion start|status|stop [--installation ROOT] [--runtime DIR]');
      } catch (error) {
        fail(error?.code ?? 'companion-failed', String(error?.message ?? error), {
          ...(error?.details ?? {}),
          message_zh: 'companion 操作失败；未自动清除显式停止标记或接管未知进程。',
        });
      }
      return;
    }
    case 'receiver-status': {
      const runtimeDir = explicitRuntimeDir(flags) ?? path.resolve(RUNTIME_DIR);
      if (explicitRuntimeDir(flags) !== null && !fs.existsSync(runtimeDir)) {
        fail('runtime-not-found', `explicit runtime does not exist: ${runtimeDir}`);
        return;
      }
      const status = await readReceiverStatusesAsync({ runtimeDir });
      out({ ok: true, ...status });
      return;
    }
    case 'service-status': {
      out({ ok: true, ...collectServiceStatus({ runtimeDir: RUNTIME_DIR, installationRoot: process.env.LAB_BRIDGE_INSTALLATION_ROOT ?? null }) });
      return;
    }
    case 'check': {
      const report = { ok: false, checks: {} };
      let pairedTargets = [];
      report.checks.token = fs.existsSync(TOKEN_FILE) ? 'present' : 'missing (run init or serve once)';
      report.checks.config = fs.existsSync(CONFIG_FILE) ? 'present' : 'missing (init creates defaults)';
      const health = serverInfoHealth({ serverInfoFile: SERVER_INFO_FILE });
      report.checks.server_info = health.present ? health : 'absent';
      const warnings = [];
      if (health.stale) warnings.push('recorded hub pid is not alive (stale server.json); the hub is not running or crashed uncleanly');
      try {
        const snapshot = await withHubClient(hubOptions(), async (client) => ({
          welcome: client.welcome,
          roles: await client.roles(),
          targets: await client.targets(),
        }));
        report.ok = true;
        report.hub = 'REACHABLE';
        report.welcome = snapshot.welcome;
        report.checks.adapter_roles = snapshot.roles;
        if (!snapshot.roles.includes('dsh')) {
          warnings.push('no DSH adapter connected: inbound DSH delivery is offline (plugin not loaded in the running host, or waiting for a coordinated host restart)');
        }
        report.checks.pairing_count = snapshot.targets.length;
        report.checks.pairing_enabled = snapshot.targets.filter((target) => target.enabled === true).length;
        report.checks.pairing = snapshot.targets;
        report.checks.codex_adapter_present = snapshot.roles.includes('codex');
        pairedTargets = snapshot.targets;
      } catch (error) {
        report.hub = 'UNREACHABLE';
        report.error = { code: error.code ?? 'unknown', message: error.message };
        report.checks.pairing = 'UNKNOWN (hub unreachable)';
        report.checks.adapter_roles = 'UNKNOWN (hub unreachable)';
      }
      try {
        report.checks.dsh_plugin = pluginStatus({
          profilePath: typeof flags.profile === 'string' ? path.resolve(flags.profile) : defaultProfilePath(),
        });
        report.checks.module_watch = moduleWatchStatus({
          profilePath: typeof flags.profile === 'string' ? path.resolve(flags.profile) : defaultProfilePath(),
        });
      } catch (error) {
        report.checks.dsh_plugin = { error: String(error?.message ?? error) };
      }
      const receiverStatus = readReceiverStatuses({ runtimeDir: RUNTIME_DIR });
      report.checks.receiver_root = receiverStatus.root;
      report.checks.receivers = receiverStatus.receivers;
      const codexTargets = pairedTargets.filter((target) => String(target.identity).startsWith('codex:'));
      report.checks.codex_targets = codexTargets.map((target) => {
        const threadId = String(target.identity).slice('codex:'.length);
        const receiver = receiverStatus.receivers.find((item) => item.threadId === threadId);
        return {
          target: target.identity,
          enabled: target.enabled === true,
          receiver_present: receiver !== undefined,
          mode: receiver?.mode,
          phase: receiver?.phase,
          active: receiver?.active === true,
          expires_at: receiver?.expiresAt ?? null,
          next_eligible_at: receiver?.nextEligibleAt ?? null,
          remaining_native_submissions: receiver?.remainingNativeSubmissions ?? null,
          reason_code: receiver?.reasonCode ?? null,
        };
      });
      for (const target of codexTargets) {
        const threadId = String(target.identity).slice('codex:'.length);
        const receiver = receiverStatus.receivers.find((item) => item.threadId === threadId);
        if (receiver === undefined) {
          warnings.push(`paired Codex target ${target.identity} has no local receiver status; messages stay queued until a receiver reports status`);
        } else if (receiver.active !== true) {
          warnings.push(`receiver for ${target.identity} is ${receiver.phase}${receiver.reasonCode === undefined ? '' : ` (${receiver.reasonCode})`}; messages stay queued until it becomes active`);
        }
      }
      if (report.checks.codex_adapter_present === true) {
        warnings.push('a global codex adapter is connected; current lifecycle uses target-scoped CLI pull, so do not stop or replace the adapter silently');
      }
      if (warnings.length > 0) report.warnings = warnings;
      out(report);
      if (report.ok !== true) process.exitCode = 1;
      return;
    }
    case undefined:
    case 'help':
    case '--help': {
      out({
        ok: true,
        usage: [
          'init',
          'serve',
          'pair add <role:id> [--label TEXT] [--host TEXT] [--runtime DIR] [--installation ROOT]',
          'pair remove <role:id> [--runtime DIR]',
          'pair list [--runtime DIR]',
          'send --to <role:id> --text TEXT [--origin ROLE:ID] [--msg-id ID] [--ttl-minutes N] [--runtime DIR]',
          'status [--msg-id ID] [--to ROLE:ID] [--from ROLE:ID] [--state STATE] [--limit N] [--runtime DIR]',
          'targets [--runtime DIR]',
          'consume --msg-id <id> [--consumer role:id] [--note TEXT] [--runtime DIR]',
          'onboard discover [--runtime DIR] [--installation ROOT]',
          'onboard request --source <role:id> --target <role:id> --user-authorized [--message-id ID] [--request-id ID] [--runtime DIR] [--origin-artifact PATH]',
          'onboard list [--runtime DIR] [--state STATE] [--limit N]',
          'onboard status <request_id> [--runtime DIR]',
          'onboard retry <request_id> [--runtime DIR] [--user-authorized]',
          'onboard receipt <request_id> --message-id ID --turn-id UUID [--runtime DIR]',
          'onboard revoke <request_id> [--runtime DIR] [--reason TEXT]',
          'install-dsh-plugin [--profile PATH] [--dry-run] [--no-watch]',
          'uninstall-dsh-plugin [--profile PATH]',
          'dsh-plugin-status [--profile PATH]',
          'module-watch-status [--profile PATH]',
          'enable-module-watch [--profile PATH]',
          'disable-module-watch [--profile PATH]',
          'client grant --targets <role:id[,role:id]> [--client client:dot-UUID] [--lease-minutes N] [--ttl-minutes N] [--max-requests N] [--max-submits N] [--runtime DIR]',
          'client request --grant ID --credential-file PATH --to <role:id> --request-id ID --text-file PATH [--runtime DIR]',
          'client status|resume|cancel --grant ID --credential-file PATH --request-id ID [--runtime DIR]',
          'client revoke --grant ID [--reason TEXT]',
          'client list-grants',
          'client reply --client client:dot-UUID --request-id ID --request-msg-id ID --target ROLE:ID --turn-id UUID --body-file PATH',
          'client rollback-audit [--runtime DIR]',
          'client rollback-quarantine [--runtime DIR] [--confirm]',
          'companion start|status|stop [--installation ROOT] [--runtime DIR]',
          'receiver-status [--runtime DIR]',
          'service-status',
          'check',
        ],
      });
      return;
    }
    default: {
      fail('unknown-command', `unknown command "${command}"`, { commands: ['init', 'serve', 'pair', 'send', 'status', 'targets', 'check'] });
    }
  }
}

main().catch((error) => {
  const expected = error?.name === 'HubClientError'
    || ['auth-failed', 'connection-closed', 'not-connected', 'request-timeout', 'connect-failed', 'welcome-timeout', 'target-unpaired', 'source-unpaired', 'msg-id-conflict', 'send-rejected'].includes(error?.code);
  fail(error.code ?? 'cli-error', error.message, expected ? {} : { stack: error.stack?.split('\n').slice(0, 4) });
});
