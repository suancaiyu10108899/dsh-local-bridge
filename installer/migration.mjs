// Read-only legacy/source-link migration candidate report.
//
// No file is written, no profile is switched, no runtime is moved. The report
// names exact preserved artifacts and gives both switch and rollback steps.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MIGRATION_PLAN_SCHEMA = 'stage-a-legacy-migration-plan/1';

function statOnly(file) {
  try {
    const stat = fs.statSync(file);
    return { path: path.resolve(file), size: stat.size, content_read: false };
  } catch {
    return null;
  }
}

function hashFile(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

function fileInfo(file) {
  try {
    const stat = fs.statSync(file);
    return { path: path.resolve(file), size: stat.size, sha256: hashFile(file) };
  } catch {
    return null;
  }
}

function listTree(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) out.push(fileInfo(file));
    }
  };
  walk(root);
  return out;
}

/** Build a read-only migration/precheck/rollback report for a legacy source-link. */
export function planLegacyMigration({
  profilePath,
  sourceLinkRoot,
  runtimeRoot,
  installRoot,
  backupRoot,
  now = Date.now(),
} = {}) {
  for (const [key, value] of Object.entries({ profilePath, sourceLinkRoot, runtimeRoot, installRoot, backupRoot })) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new TypeError(`${key} must be absolute`);
  }
  const profile = fileInfo(profilePath);
  let profileText = '';
  try { profileText = profile === null ? '' : fs.readFileSync(profilePath, 'utf8'); } catch { profileText = ''; }
  const lines = profileText.split(/\r?\n/);
  const bridgeLines = lines.map((line, index) => ({ index, line })).filter(({ line }) => /local-agent-bridge|dsh-local-bridge/.test(line));
  const otherLines = lines.filter((line) => line.trim().length > 0 && !/local-agent-bridge|dsh-local-bridge/.test(line));
  const preserved = {
    token: statOnly(path.join(runtimeRoot, 'hub', 'token')),
    state: fileInfo(path.join(runtimeRoot, 'hub', 'state.json')),
    config: fileInfo(path.join(runtimeRoot, 'hub', 'config.json')),
    receiver_configs: listTree(path.join(runtimeRoot, 'codex')),
    queue_ledger: listTree(path.join(runtimeRoot, 'codex')),
    memberships: listTree(path.join(runtimeRoot, 'memberships')),
  };
  const sourceFiles = fs.existsSync(sourceLinkRoot)
    ? fs.readdirSync(sourceLinkRoot, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => fileInfo(path.join(sourceLinkRoot, entry.name))).filter(Boolean)
    : [];
  return {
    schema: MIGRATION_PLAN_SCHEMA,
    read_only: true,
    live_cutover: false,
    generated_at: new Date(now).toISOString(),
    profile: profile,
    source_link_root: path.resolve(sourceLinkRoot),
    source_files: sourceFiles,
    runtime_root: path.resolve(runtimeRoot),
    install_root: path.resolve(installRoot),
    backup_root: path.resolve(backupRoot),
    bridge_lines: bridgeLines,
    other_plugin_line_count: otherLines.length,
    other_plugin_fingerprint: crypto.createHash('sha256').update(otherLines.join('\n')).digest('hex'),
    preserved,
    precheck: [
      'verify profile bridge lines point only to the owned bridge plugin',
      'verify runtime token presence/size only (never read, copy or hash token content); state/config hashes match the inventory',
      'verify no live Hub/worker/receiver is mid-submission',
      'verify queue/window/rolling ledger and memberships are preserved',
      'verify other plugin lines are byte-identical before and after switch',
    ],
    backup_plan: [
      { source: path.resolve(profilePath), destination: path.join(path.resolve(backupRoot), 'profile.before-migration') },
    ],
    runtime_backup: 'NOT_CREATED_PRESERVE_CURRENT_RUNTIME_IN_PLACE',
    switch_steps: [
      'stop new submissions; leave accepted ledger untouched',
      'disable owned bridge profile lines only',
      'install/point the owned entry to installRoot without changing token or queue',
      'start isolated candidate Hub/companion with the same runtime_root',
      'verify locator instance/owner lease and Hub welcome IDs',
      'run precheck read-only diff; only then enable traffic',
    ],
    rollback_steps: [
      'stop new candidate Hub/companion (normal stop, no auto-restart)',
      'record current profile bytes; if the current profile differs from the pre-switch inventory, PAUSE_ROLLBACK_CONFLICT and preserve it instead of overwriting external edits',
      'remove/restore only owned bridge profile lines, active pointer and startup footprint when the exact recorded lineage still matches; leave all other plugin lines untouched',
      'do NOT restore the old full runtime: preserve the current token, queue, ledger, accepted and uncertain entries; remove only candidate-created non-data artifacts after inventory match',
      'if the current schema is incompatible, PAUSE_SCHEMA_INCOMPATIBLE and retain all data for review',
      'restart the original owner only after its own exact profile/identity and preserved queue/ledger have been verified',
    ],
    rollback_constraints: {
      profile_restore: 'SURGICAL_OWN_LINES_ONLY_IF_CURRENT_MATCHES_INVENTORY',
      external_profile_change: 'PAUSE_ROLLBACK_CONFLICT_NO_OVERWRITE',
      runtime_restore: 'PRESERVE_CURRENT_RUNTIME_TOKEN_QUEUE_LEDGER_ACCEPTED_UNCERTAIN',
      old_runtime_restore: 'NEVER_RESTORE_OLD_WHOLE_RUNTIME',
      schema_mismatch: 'PAUSE_SCHEMA_INCOMPATIBLE_PRESERVE_DATA',
      other_plugins: 'PRESERVE_BYTE_IDENTICAL',
    },
    notes: [
      'report only; no profile/runtime/task/token modification',
      'token is stat-only presence/size; its content is never read, copied, hashed or emitted',
      'runtime messages/ledger are preserved in place; only the profile is backed up',
      'REPORT_ONLY: this is a read-only precheck/rollback report, not an executed migration or rollback simulation',
      'actual_migration_run:false; actual_rollback_run:false',
      'a real live migration requires a separate user impact card and window',
    ],
  };
}
