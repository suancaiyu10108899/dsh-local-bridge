#!/usr/bin/env node
// Local Agent Bridge operator CLI.
// Usage:
//   node bin/lab-bridge.mjs init
//   node bin/lab-bridge.mjs serve
//   node bin/lab-bridge.mjs pair add <role:id> [--label TEXT] [--host TEXT]
//   node bin/lab-bridge.mjs pair remove <role:id>
//   node bin/lab-bridge.mjs pair list
//   node bin/lab-bridge.mjs send --to <role:id> --text TEXT [--origin ROLE:ID] [--msg-id ID] [--ttl-minutes N]
//   node bin/lab-bridge.mjs status [--msg-id ID] [--to ROLE:ID] [--state STATE] [--limit N]
//   node bin/lab-bridge.mjs targets
//   node bin/lab-bridge.mjs consume --msg-id ID [--consumer ROLE:ID] [--note TEXT]
//   node bin/lab-bridge.mjs install-dsh-plugin [--profile PATH] [--dry-run] [--no-watch]
//   node bin/lab-bridge.mjs uninstall-dsh-plugin [--profile PATH]
//   node bin/lab-bridge.mjs dsh-plugin-status [--profile PATH]
//   node bin/lab-bridge.mjs module-watch-status [--profile PATH]
//   node bin/lab-bridge.mjs enable-module-watch [--profile PATH]
//   node bin/lab-bridge.mjs disable-module-watch [--profile PATH]
//   node bin/lab-bridge.mjs check
import fs from 'node:fs';
import path from 'node:path';
import {
  CONFIG_FILE,
  HUB_DIR,
  SERVER_INFO_FILE,
  STATE_FILE,
  TOKEN_FILE,
  ensureRuntimeDirs,
  ensureToken,
  loadConfig,
  readToken,
} from '../src/runtime.mjs';
import { withHubClient } from '../src/client.mjs';
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

function hubOptions(overrides = {}) {
  const config = loadConfig();
  return {
    host: config.host,
    port: config.port,
    token: readToken(),
    role: 'cli',
    identity: 'cli:operator',
    connectTimeoutMs: 3_000,
    ...overrides,
  };
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
        const targets = await withHubClient(hubOptions(), (client) => client.targets());
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
      const result = await withHubClient(hubOptions(), async (client) => {
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
      const accepted = await withHubClient(hubOptions(), (client) => client.sendMessage(envelope));
      out({ ok: true, ...accepted, from, to, ...(origin === undefined ? {} : { origin }) });
      return;
    }
    case 'status': {
      const messages = await withHubClient(hubOptions(), async (client) => {
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
      out({ ok: true, count: messages.length, messages });
      return;
    }
    case 'targets': {
      const targets = await withHubClient(hubOptions(), (client) => client.targets());
      out({ ok: true, targets });
      return;
    }
    case 'consume': {
      const msgId = typeof flags['msg-id'] === 'string' ? flags['msg-id'] : positional[1];
      if (typeof msgId !== 'string' || msgId.length === 0) {
        fail('usage', 'consume --msg-id <id> [--consumer role:id] [--note TEXT]');
        return;
      }
      const message = await withHubClient(hubOptions(), (client) => client.consume(msgId, {
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
    case 'check': {
      const report = { ok: false, checks: {} };
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
          'pair add <role:id> [--label TEXT] [--host TEXT]',
          'pair remove <role:id>',
          'pair list',
          'send --to <role:id> --text TEXT [--origin ROLE:ID] [--msg-id ID] [--ttl-minutes N]',
          'status [--msg-id ID] [--to ROLE:ID] [--from ROLE:ID] [--state STATE] [--limit N]',
          'targets',
          'consume --msg-id <id> [--consumer role:id] [--note TEXT]',
          'install-dsh-plugin [--profile PATH] [--dry-run] [--no-watch]',
          'uninstall-dsh-plugin [--profile PATH]',
          'dsh-plugin-status [--profile PATH]',
          'module-watch-status [--profile PATH]',
          'enable-module-watch [--profile PATH]',
          'disable-module-watch [--profile PATH]',
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
