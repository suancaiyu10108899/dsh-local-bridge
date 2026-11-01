// Original-owner-only legacy handover. Recovery never restores an old ledger
// or signals a PID; it resumes only a journal whose saved config is provable.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeJsonAtomic } from '../../src/runtime.mjs';
import { readProcessIdentity } from '../../src/process-identity.mjs';
import { membershipPath, readMembership } from '../../src/membership.mjs';
import { UUID_RE, validateReceiverConfig } from './queue-inbox.mjs';
import { ownBinding } from './daily-receiver.mjs';
import { preparationContext, receiverInstallation } from './receiver-context.mjs';
import { resolveVerifiedCli } from './installed-cli.mjs';
import { removeStartup, windowsRegistry } from './receiver-startup.mjs';

const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const fingerprint = (value) => digest(JSON.stringify(value));
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
function bytes(file) {
  if (!fs.lstatSync(file).isFile()) fail('LEGACY_PROCESS_RECORD_REVIEW_REQUIRED');
  return fs.readFileSync(file);
}
function json(file) {
  try { return JSON.parse(bytes(file).toString('utf8')); } catch { fail('LEGACY_ADOPTION_REVIEW_REQUIRED'); }
}
async function recoveryGuard(c, file, options, operation) {
  const guard = path.join(c.runtime_dir, 'legacy-adoption.recovery.lock'), nonce = crypto.randomUUID();
  if (fs.existsSync(guard)) {
    const raw = bytes(guard); let old;
    try { old = JSON.parse(raw.toString('utf8')); } catch { fail('LEGACY_ADOPTION_RECOVERY_HELD'); }
    if (old.thread_id !== c.thread_id || !same(old.config_path, file) || !UUID_RE.test(old.nonce ?? '') ||
        !Number.isSafeInteger(old.pid) || old.pid <= 0) fail('LEGACY_ADOPTION_RECOVERY_HELD');
    if (old.pid === process.pid) fail('LEGACY_ADOPTION_RECOVERY_HELD');
    const state = await readProcessIdentity(old.pid, { provider: options.identityProvider });
    if (state.alive !== false || state.source !== 'windows-cim' || state.unavailable_reason !== 'PROCESS_NOT_FOUND' ||
        !bytes(guard).equals(raw)) fail('LEGACY_ADOPTION_RECOVERY_HELD');
    fs.renameSync(guard, guard + '.stale-' + old.nonce);
  }
  try { fs.writeFileSync(guard, JSON.stringify({ nonce, pid: process.pid, thread_id: c.thread_id, config_path: path.resolve(file) }), { flag: 'wx' }); }
  catch (error) { if (error.code === 'EEXIST') fail('LEGACY_ADOPTION_RECOVERY_HELD'); throw error; }
  try { return await operation(); }
  finally { try { if (json(guard).nonce === nonce) fs.unlinkSync(guard); } catch { /* Preserve unknown ownership. */ } }
}

export async function adoptLegacyReceiver(file, options = {}) {
  const initialBytes = bytes(file), current = JSON.parse(initialBytes.toString('utf8'));
  validateReceiverConfig(current);
  if (!UUID_RE.test(current.thread_id ?? '') || process.env.CODEX_THREAD_ID !== current.thread_id) fail('OWNER_THREAD_MISMATCH');
  if (!options.installationRoot || current.mode !== 'daily') fail('LEGACY_ADOPTION_INSTALLATION_REQUIRED');
  const context = preparationContext({ thread: current.thread_id, installationRoot: options.installationRoot });
  const installation = context.installation, root = current.runtime_dir;
  if (installation.hub_owner_kind !== 'COMPANION_OWNED' || !same(context.runtime, root) ||
      !same(file, path.join(root, 'receiver-config.json'))) fail('RUNTIME_INSTANCE_CONFLICT');
  const recovering = options.resume === true || options.abort === true;
  const run = () => performAdoption(file, current, initialBytes, context, options);
  return recovering ? recoveryGuard(current, file, options, run) : run();
}

async function performAdoption(file, current, initialBytes, context, options) {
  const root = current.runtime_dir, installation = context.installation;
  const journalFile = path.join(root, 'legacy-adoption.transaction');
  const recovering = options.resume === true || options.abort === true;
  let oldJournal = null, oldJournalBytes = null, originalBytes = initialBytes, original = current;
  if (fs.existsSync(journalFile)) {
    if (!recovering) fail('LEGACY_ADOPTION_REVIEW_REQUIRED');
    oldJournalBytes = bytes(journalFile);
    try { oldJournal = JSON.parse(oldJournalBytes.toString('utf8')); } catch { fail('LEGACY_ADOPTION_REVIEW_REQUIRED'); }
    if (!UUID_RE.test(oldJournal.nonce ?? '') || oldJournal.thread_id !== current.thread_id ||
        !same(oldJournal.config_path, file) || !same(oldJournal.backup, file + '.pre-adoption-' + oldJournal.nonce) ||
        !['ADOPTING_DISABLED', 'PREPARED', 'STARTUP_REMOVED', 'CONFIG_COMMITTED'].includes(oldJournal.status) ||
        oldJournal.original_start_at_logon !== undefined && typeof oldJournal.original_start_at_logon !== 'boolean') fail('LEGACY_ADOPTION_REVIEW_REQUIRED');
    if (fs.existsSync(oldJournal.backup)) originalBytes = bytes(oldJournal.backup);
    else if (oldJournal.v === 2 && oldJournal.original_config_sha256 === digest(initialBytes)) originalBytes = initialBytes;
    else fail('LEGACY_ADOPTION_BACKUP_UNVERIFIED');
    if (oldJournal.original_config_sha256 && oldJournal.original_config_sha256 !== digest(originalBytes)) fail('LEGACY_ADOPTION_BACKUP_UNVERIFIED');
    original = JSON.parse(originalBytes.toString('utf8')); validateReceiverConfig(original);
    if (original.thread_id !== current.thread_id || !same(original.runtime_dir, root)) fail('LEGACY_ADOPTION_BACKUP_UNVERIFIED');
  } else if (recovering) {
    // A crash after completion can leave only the recovery guard. Its owner
    // proof is handled above; a known completed disabled config needs no write.
    const n = current.legacy_adoption?.transaction_nonce;
    if (options.abort !== true && UUID_RE.test(n ?? '') && fs.existsSync(journalFile + '.completed-' + n)) {
      receiverInstallation({ ...current, config_path: path.resolve(file) });
      return { status: 'ALREADY_ADOPTED', enabled: current.enabled, config_path: path.resolve(file) };
    }
    fail('LEGACY_ADOPTION_JOURNAL_MISSING');
  }
  const originalIntact = initialBytes.equals(originalBytes);
  const committed = !originalIntact && oldJournal?.v === 2 && oldJournal.prepared_fingerprint === fingerprint(current) &&
    current.legacy_adoption?.transaction_nonce === oldJournal.nonce && current.enabled === false && current.owner_opt_in === false;
  if (!originalIntact && !committed) fail('LEGACY_ADOPTION_CONFIG_CHANGED');
  if (current.installation_id || current.installation_root || current.instance_id) {
    if (!same(current.installation_root, context.installationRoot) || current.installation_id !== installation.installation_id ||
        current.instance_id !== installation.instance_id) fail('RECEIVER_INSTANCE_MISMATCH');
    receiverInstallation({ ...current, config_path: path.resolve(file) });
    if (!oldJournal) return { status: 'ALREADY_ADOPTED', enabled: current.enabled, config_path: path.resolve(file) };
    if (!committed) fail('LEGACY_ADOPTION_COMMIT_REVIEW_REQUIRED');
  }
  if (original.hub_runtime_root && !same(original.hub_runtime_root, installation.runtime_root)) fail('RUNTIME_INSTANCE_CONFLICT');
  await ownBinding(current);
  const member = readMembership(membershipPath(installation.runtime_root, 'codex:' + current.thread_id));
  if (member?.enabled || member?.desired_state === 'ENABLED') fail('LEGACY_ADOPTION_MEMBERSHIP_ACTIVE');
  const records = new Map([[path.resolve(file), initialBytes]]), pids = new Map(), locks = [];
  const take = (name, lock = false) => {
    let p = path.join(root, name), archived = false;
    if (lock && committed && !fs.existsSync(p) && oldJournal.lock_names?.includes(name)) {
      p += '.pre-adoption-' + oldJournal.nonce; archived = true;
    }
    if (!fs.existsSync(p)) {
      if (lock && committed && oldJournal.lock_names?.includes(name)) fail('LEGACY_ADOPTION_LOCK_CHANGED');
      return null;
    }
    const raw = bytes(p); records.set(p, raw);
    if (lock) {
      const expected = oldJournal?.lock_records?.find((x) => x.name === name);
      if (expected && expected.sha256 !== digest(raw)) fail('LEGACY_ADOPTION_LOCK_CHANGED');
      locks.push({ name, file: path.join(root, name), archived, sha256: digest(raw) });
    }
    return { raw, file: p, mtime: fs.statSync(p).mtimeMs };
  };
  const remember = (pid, at) => { if (!Number.isSafeInteger(pid) || pid <= 0) fail('LEGACY_PROCESS_RECORD_REVIEW_REQUIRED'); pids.set(pid, Math.max(pids.get(pid) ?? 0, at)); };
  for (const name of ['receiver.lock', 'service.lock', 'status.json', 'service-status.json']) {
    const r = take(name, name.endsWith('.lock')); if (!r) continue;
    const d = JSON.parse(r.raw.toString('utf8'));
    if (d.thread_id !== current.thread_id || name.endsWith('.lock') && !same(d.config_path, file)) fail('LEGACY_PROCESS_RECORD_REVIEW_REQUIRED');
    remember(d.pid, Math.max(r.mtime, Date.parse(d.heartbeat_at ?? d.at ?? '') || 0));
  }
  const pidRecord = take('process.pid');
  if (pidRecord) {
    if (!/^[1-9]\d*\s*$/.test(pidRecord.raw.toString('utf8'))) fail('LEGACY_PROCESS_RECORD_REVIEW_REQUIRED');
    remember(Number(pidRecord.raw.toString('utf8').trim()), pidRecord.mtime);
  }
  if (oldJournal) {
    const expected = [...(oldJournal.pids_reviewed ?? oldJournal.pids_proven_absent ?? [])].sort((a, b) => a - b);
    if (JSON.stringify(expected) !== JSON.stringify([...pids.keys()].sort((a, b) => a - b))) fail('LEGACY_ADOPTION_PROCESS_RECORD_CHANGED');
  }
  if (['receiver.lock.transaction', 'service.lock.transaction'].some((n) => fs.existsSync(path.join(root, n)))) fail('LOCK_RECOVERY_REVIEW_REQUIRED');
  let proofs = [];
  const verify = async () => {
    proofs = [];
    for (const [pid, recordedAt] of pids) {
      const state = await readProcessIdentity(pid, { provider: options.identityProvider });
      if (state.alive === false && state.source === 'windows-cim' && state.unavailable_reason === 'PROCESS_NOT_FOUND') proofs.push({ pid, status: 'ABSENT' });
      else if (options.acceptProvenReuse === true && state.source === 'windows-cim' && state.alive === true &&
          path.isAbsolute(state.exe_path ?? '') && path.basename(state.exe_path).toLowerCase() === 'conhost.exe' &&
          Number.isFinite(Date.parse(state.created_at)) && Date.parse(state.created_at) > recordedAt + 2000) {
        // A console host cannot be this v2 Node receiver. Birth after every
        // saved record corroborates PID reuse. Never signal that other process.
        proofs.push({ pid, status: 'PROVEN_REUSED_CONSOLE_HOST', exe_path: state.exe_path, created_at: state.created_at });
      } else fail('LEGACY_PROCESS_NOT_PROVEN_ABSENT');
    }
    for (const [p, raw] of records) if (!fs.existsSync(p) || !bytes(p).equals(raw)) fail('LEGACY_RECORD_CHANGED');
    if (oldJournalBytes && !bytes(journalFile).equals(oldJournalBytes)) fail('LEGACY_ADOPTION_JOURNAL_CHANGED');
  };
  await verify();
  const startup = take('startup.json');
  const startupData = startup ? JSON.parse(startup.raw.toString('utf8')) : null;
  if (startupData && (startupData.thread_id !== current.thread_id || startupData.key !== 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' ||
      startupData.name !== 'LocalAgentBridge-' + current.thread_id)) fail('STARTUP_ENTRY_CONFLICT');
  if (options.abort === true) {
    if (!originalIntact) fail('LEGACY_ADOPTION_COMMIT_REVIEW_REQUIRED');
    await verify(); fs.renameSync(journalFile, journalFile + '.aborted-' + oldJournal.nonce);
    return { status: 'ADOPTION_ABORTED', config_path: path.resolve(file), config_restored: false, ledger_preserved: true,
      previous_enabled: original.enabled, startup_registration_restored: false };
  }
  if (oldJournal && oldJournal.v !== 2 && original.start_at_logon === undefined && startupData?.enabled === false &&
      startupData.adoption_original_start_at_logon === undefined) fail('LEGACY_ADOPTION_STARTUP_CHOICE_UNVERIFIED');
  const nonce = oldJournal?.nonce ?? crypto.randomUUID(), backup = file + '.pre-adoption-' + nonce;
  let updated = current;
  if (!committed) {
    const cli = await resolveVerifiedCli(original, options.cliOptions ?? {});
    const login = oldJournal?.original_start_at_logon ?? original.start_at_logon ?? startupData?.adoption_original_start_at_logon ?? startupData?.enabled === true;
    updated = { ...original, ...cli, config_path: undefined, enabled: false, owner_opt_in: false, owner_opt_in_at: null,
      installation_root: context.installationRoot, locator_path: path.join(context.installationRoot, 'installation.json'),
      installation_id: installation.installation_id, instance_id: installation.instance_id, hub_runtime_root: installation.runtime_root,
      hub_owner_kind: installation.hub_owner_kind, runtime_mode: 'INSTALLATION', binding_epoch: oldJournal?.binding_epoch ?? crypto.randomUUID(),
      start_at_logon: login, legacy_adoption: { at: new Date().toISOString(), transaction_nonce: nonce,
        previous_enabled: original.enabled, previous_runtime_mode: original.runtime_mode ?? null,
        previous_startup_enabled: startupData?.enabled ?? null,
        grade: 'ORIGINAL_OWNER_OPT_IN_AND_CIM_PROCESS_REVIEW; not independent host authentication' } };
    validateReceiverConfig(updated); receiverInstallation(updated);
    await verify();
    const journal = { v: 2, nonce, thread_id: current.thread_id, config_path: path.resolve(file), backup, status: 'PREPARED',
      original_config_sha256: digest(originalBytes), prepared_fingerprint: fingerprint(updated), binding_epoch: updated.binding_epoch,
      original_start_at_logon: login, pids_reviewed: [...pids.keys()], process_proofs: proofs,
      lock_names: locks.map((x) => x.name), lock_records: locks.map(({ name, sha256 }) => ({ name, sha256 })) };
    if (oldJournal) {
      fs.writeFileSync(journalFile + '.recovery-audit-' + crypto.randomUUID(), oldJournalBytes, { flag: 'wx' });
      writeJsonAtomic(journalFile, journal);
    } else fs.writeFileSync(journalFile, JSON.stringify(journal), { flag: 'wx' });
    oldJournalBytes = bytes(journalFile);
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, originalBytes, { flag: 'wx' });
    else if (!bytes(backup).equals(originalBytes)) fail('LEGACY_ADOPTION_BACKUP_UNVERIFIED');
    if (startupData) {
      await removeStartup(current, options.registry);
      const removed = json(path.join(root, 'startup.json'));
      writeJsonAtomic(path.join(root, 'startup.json'), { ...removed, adoption_original_start_at_logon: login });
      records.delete(path.join(root, 'startup.json'));
    }
    await verify();
    writeJsonAtomic(file, updated);
  } else if (startupData && (startupData.enabled !== false || await (options.registry ?? windowsRegistry).get(startupData) !== null)) fail('STARTUP_ENTRY_CONFLICT');
  // All asynchronous checks finished before these exact, non-signalling moves.
  for (const lock of locks) if (!lock.archived) fs.renameSync(lock.file, lock.file + '.pre-adoption-' + nonce);
  fs.renameSync(journalFile, journalFile + '.completed-' + nonce);
  return { status: 'ADOPTED_DISABLED', action: recovering ? 'ADOPTION_RESUMED' : 'ADOPTION_PREPARED',
    config_path: path.resolve(file), enabled: false, binding_epoch: updated.binding_epoch, backup,
    startup_removed: !!startupData, ledger_preserved: true, process_proofs: proofs,
    previous_enabled: original.enabled, next_action: 'Original owner explicitly enables the same config; no automatic native submission.' };
}
