import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { planLegacyMigration } from '../installer/migration.mjs';

const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('legacy migration report is exact, read-only and preserves token/queue/window/other plugins', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-migration-'));
  try {
    const profile = path.join(root, 'profile', 'cordis.yml');
    fs.mkdirSync(path.dirname(profile), { recursive: true });
    fs.writeFileSync(profile, [
      '- id: hmr',
      '  config:',
      '    root: ["D:/tmp/synthetic-legacy-bridge"]',
      '- id: local-agent-bridge',
      '  name: dsh-local-bridge',
      '- id: unrelated-plugin',
      '  config: { keep: true }',
      '',
    ].join('\n'));
    const sourceLink = path.join(root, 'source-link');
    fs.mkdirSync(sourceLink);
    fs.writeFileSync(path.join(sourceLink, 'package.json'), '{"name":"dsh-local-bridge"}');
    const runtime = path.join(root, 'runtime');
    fs.mkdirSync(path.join(runtime, 'hub'), { recursive: true });
    fs.mkdirSync(path.join(runtime, 'codex', 'thread-a'), { recursive: true });
    fs.mkdirSync(path.join(runtime, 'memberships'), { recursive: true });
    const token = path.join(runtime, 'hub', 'token');
    const state = path.join(runtime, 'hub', 'state.json');
    const ledger = path.join(runtime, 'codex', 'thread-a', 'ledger.json');
    fs.writeFileSync(token, 'preserved-token-value\n');
    fs.writeFileSync(state, '{"v":1,"messages":{}}');
    fs.writeFileSync(ledger, '{"v":1,"entries":{}}');
    fs.writeFileSync(path.join(runtime, 'memberships', 'm.json'), '{"target":"codex:x"}');
    const before = {
      profile: hash(profile), token: hash(token), state: hash(state), ledger: hash(ledger),
    };
    const report = planLegacyMigration({
      profilePath: profile,
      sourceLinkRoot: sourceLink,
      runtimeRoot: runtime,
      installRoot: path.join(root, 'install'),
      backupRoot: path.join(root, 'backup'),
      now: 1_000,
    });
    assert.equal(report.read_only, true);
    assert.equal(report.live_cutover, false);
    assert.equal(report.bridge_lines.length, 2);
    assert.equal(report.other_plugin_line_count > 0, true);
    assert.equal(report.preserved.token.path, token);
    assert.equal(report.preserved.token.size, Buffer.byteLength('preserved-token-value\n'));
    assert.equal(report.preserved.token.content_read, false);
    assert.equal(Object.hasOwn(report.preserved.token, 'sha256'), false);
    assert.equal(JSON.stringify(report).includes(before.token), false);
    assert.equal(report.preserved.state.sha256, before.state);
    assert.equal(report.preserved.queue_ledger.some((entry) => entry.path === ledger && entry.sha256 === before.ledger), true);
    assert.equal(report.backup_plan.length, 1);
    assert.equal(report.backup_plan[0].source, profile);
    assert.equal(report.runtime_backup, 'NOT_CREATED_PRESERVE_CURRENT_RUNTIME_IN_PLACE');
    assert.equal(report.backup_plan[0].destination, path.join(root, 'backup', 'profile.before-migration'));
    assert.equal(report.rollback_steps.some((step) => /profile/.test(step)), true);
    assert.equal(report.rollback_constraints.profile_restore, 'SURGICAL_OWN_LINES_ONLY_IF_CURRENT_MATCHES_INVENTORY');
    assert.equal(report.rollback_constraints.external_profile_change, 'PAUSE_ROLLBACK_CONFLICT_NO_OVERWRITE');
    assert.equal(report.rollback_constraints.runtime_restore, 'PRESERVE_CURRENT_RUNTIME_TOKEN_QUEUE_LEDGER_ACCEPTED_UNCERTAIN');
    assert.equal(report.rollback_constraints.old_runtime_restore, 'NEVER_RESTORE_OLD_WHOLE_RUNTIME');
    assert.equal(report.rollback_constraints.schema_mismatch, 'PAUSE_SCHEMA_INCOMPATIBLE_PRESERVE_DATA');
    assert.match(JSON.stringify(report.rollback_steps), /PAUSE_ROLLBACK_CONFLICT/);
    assert.match(JSON.stringify(report.notes), /REPORT_ONLY/);
    assert.deepEqual({ profile: hash(profile), token: hash(token), state: hash(state), ledger: hash(ledger) }, before);
    assert.equal(fs.existsSync(path.join(root, 'backup')), false);
    assert.equal(fs.readFileSync(token, 'utf8'), 'preserved-token-value\n');
    assert.equal(JSON.stringify(report).includes('preserved-token-value'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
