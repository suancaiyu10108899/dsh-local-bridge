// Pure Task Scheduler / stable-launcher plan. No registration, no scheduled
// task, no registry write, no process start during planning.
import fs from 'node:fs';
import path from 'node:path';

export const SCHEDULER_PLAN_SCHEMA = 'stage-a-scheduler-plan/1';
export const TASK_NAMESPACE = 'http://schemas.microsoft.com/windows/2004/02/mit/task';
export const OUTER_BUDGET_WINDOW_MS = 10 * 60_000;
export const OUTER_BUDGET_MAX_TOTAL_STARTS = 3;

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** Quote one Windows CommandLineToArgvW argument (no shell interpolation). */
export function quoteWindowsArgument(value) {
  const text = String(value);
  if (text.length > 0 && !/[\s"&|<>^]/.test(text)) return text;
  let result = '"';
  let backslashes = 0;
  for (const char of text) {
    if (char === '\\') { backslashes += 1; continue; }
    if (char === '"') {
      result += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    result += '\\'.repeat(backslashes) + char;
    backslashes = 0;
  }
  result += '\\'.repeat(backslashes * 2) + '"';
  return result;
}

function launcherSource({ installationRoot }) {
  // Stable across app versions: read locator.app_root each run; use the SAME
  // locator.runtime_root outer budget; never reset inner counters.
  return `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const installationRoot = ${JSON.stringify(path.resolve(installationRoot))};
const locatorPath = path.join(installationRoot, 'installation.json');
const WINDOW_MS = 10 * 60_000;
const MAX_TOTAL_STARTS = 3;

function inside(root, candidate) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function writeBudget(file, attempts, now) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify({ v: 1, attempts, updated_at: new Date(now).toISOString() }, null, 2) + '\\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}
try {
  const installation = readJson(locatorPath);
  if (!installation || typeof installation.app_root !== 'string' || typeof installation.runtime_root !== 'string') process.exit(3);
  const entry = path.join(installation.app_root, 'companion', 'main.mjs');
  if (!inside(installation.app_root, entry) || !fs.existsSync(entry)) process.exit(4);
  const runtimeRoot = installation.runtime_root;
  const desiredFile = path.join(runtimeRoot, 'desired-state.json');
  if (fs.existsSync(desiredFile)) {
    const desired = readJson(desiredFile);
    if (desired === null || typeof desired !== 'object' || Array.isArray(desired)) process.exit(5);
    if (desired.desired_state === 'STOPPED') process.exit(0);
    if (desired.desired_state !== 'RUNNING') process.exit(5);
  }
  const budgetFile = path.join(runtimeRoot, 'companion', 'outer-budget.json');
  let attempts = [];
  if (fs.existsSync(budgetFile)) {
    const prior = readJson(budgetFile);
    if (!prior || prior.v !== 1 || !Array.isArray(prior.attempts) || prior.attempts.some((at) => typeof at !== 'string' || !Number.isFinite(Date.parse(at)))) process.exit(6);
    attempts = prior.attempts;
  }
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  attempts = attempts.filter((at) => Date.parse(at) > cutoff);
  if (attempts.length >= MAX_TOTAL_STARTS) process.exit(7);
  attempts.push(new Date(now).toISOString());
  writeBudget(budgetFile, attempts, now);
  const env = { ...process.env };
  delete env.CODEX_THREAD_ID;
  env.LAB_BRIDGE_INSTALLATION_ROOT = installationRoot;
  env.LAB_BRIDGE_RUNTIME_DIR = runtimeRoot;
  const allowedReasons = ['MANUAL_START', 'USER_ENABLE', 'LOGON_AUTOSTART', 'RECOVERY'];
  let reason = 'MANUAL_START';
  const reasonIndex = process.argv.indexOf('--reason');
  if (reasonIndex >= 0) {
    const candidate = process.argv[reasonIndex + 1];
    if (!allowedReasons.includes(candidate)) process.exit(10);
    reason = candidate;
  }
  const child = spawn(process.execPath, [entry, '--installation', installationRoot, '--reason', reason], {
    cwd: path.dirname(entry), env, stdio: 'ignore', windowsHide: true, detached: false,
  });
  let settled = false;
  child.once('error', () => { if (!settled) { settled = true; process.exit(8); } });
  child.once('exit', (code, signal) => {
    if (settled) return;
    settled = true;
    if (signal !== null) process.exit(1);
    const actual = Number.isInteger(code) ? code : 1;
    if (actual !== 0) process.exit(actual);
    const desiredAfter = fs.existsSync(desiredFile) ? readJson(desiredFile) : null;
    if (desiredAfter !== null && typeof desiredAfter === 'object' && !Array.isArray(desiredAfter) && desiredAfter.desired_state === 'STOPPED') {
      process.exit(0);
    }
    try {
      fs.mkdirSync(path.join(runtimeRoot, 'companion'), { recursive: true });
      fs.writeFileSync(path.join(runtimeRoot, 'companion', 'outer-recovery.json'), JSON.stringify({
        event: 'UNEXPECTED_CLEAN_EXIT', at: new Date().toISOString(), reason: 'child exited 0 without explicit STOPPED',
      }, null, 2) + '\\n', { encoding: 'utf8', mode: 0o600 });
    } catch { /* diagnostics are best effort */ }
    process.exit(20);
  });
} catch {
  process.exit(9);
}
`;
}

export function planSchedulerLaunch({
  installationRoot,
  nodeExecutable = process.execPath,
  companionEntry,
  runtimeRoot,
  installationId = null,
  instanceId = null,
  userSid = null,
  locatorPath = null,
  outerBudgetFile = null,
  logonEnabled = false,
  now = Date.now(),
} = {}) {
  if (typeof installationRoot !== 'string' || !path.isAbsolute(installationRoot)) throw new TypeError('installationRoot must be absolute');
  if (typeof nodeExecutable !== 'string' || !path.isAbsolute(nodeExecutable)) throw new TypeError('nodeExecutable must be absolute');
  if (runtimeRoot !== undefined && (typeof runtimeRoot !== 'string' || !path.isAbsolute(runtimeRoot))) throw new TypeError('runtimeRoot must be absolute');
  if (companionEntry !== undefined && (typeof companionEntry !== 'string' || !path.isAbsolute(companionEntry))) throw new TypeError('companionEntry must be absolute');
  const launchReason = logonEnabled === true ? 'LOGON_AUTOSTART' : 'MANUAL_START';
  const launcherPath = path.join(installationRoot, 'companion', 'launch-companion.mjs');
  const budgetFile = outerBudgetFile ?? path.join(runtimeRoot ?? path.join(installationRoot, 'runtime'), 'companion', 'outer-budget.json');
  const plan = {
    schema: SCHEDULER_PLAN_SCHEMA,
    read_only: true,
    task_registered: false,
    generated_at: new Date(now).toISOString(),
    task_name: installationId ? `LocalAgentBridge-Companion-${installationId}` : 'LocalAgentBridge-Companion',
    installation_root: path.resolve(installationRoot),
    installation_id: installationId,
    instance_id: instanceId,
    runtime_root: runtimeRoot ?? null,
    locator_path: locatorPath,
    user_sid: userSid,
    logon_trigger: { enabled: logonEnabled === true, opt_in_required: true, default_enabled: false },
    launcher: {
      kind: 'stable-launcher',
      path: launcherPath,
      content: launcherSource({ installationRoot }),
      fixed_installation_root: path.resolve(installationRoot),
      locator_path: locatorPath,
      resolves_entry_from: 'locator.app_root/companion/main.mjs',
      reason: launchReason,
      budget_file: budgetFile,
    },
    outer_budget_file: budgetFile,
    principal: {
      logon_type: 'InteractiveToken',
      run_level: 'LeastPrivilege',
      user_scope: 'current-user',
      user_sid: userSid,
      admin_required: false,
    },
    settings: {
      multiple_instances: 'IgnoreNew',
      execution_time_limit: 'PT0S',
      restart_on_failure: { enabled: true, count: 3, interval: 'PT1M' },
      start_when_available: true,
      disallow_start_if_on_batteries: false,
      stop_if_going_on_batteries: false,
      wake_to_run: false,
      normal_stop_policy: 'DO_NOT_RESTART',
    },
    action: {
      kind: 'launch-stable-launcher',
      executable: nodeExecutable,
      arguments: [launcherPath, '--reason', launchReason],
      arguments_quoted: [launcherPath, '--reason', launchReason].map(quoteWindowsArgument).join(' '),
      working_directory: path.dirname(launcherPath),
    },
    ownership: {
      outer_budget_file: budgetFile,
      outer_total_start_limit: OUTER_BUDGET_MAX_TOTAL_STARTS,
      outer_window_ms: OUTER_BUDGET_WINDOW_MS,
      outer_limit_wording: '3 total starts per 10 minutes, including the first launch; not 3 retries plus an initial launch',
      clears_inner_counters: false,
      hub_and_worker_recovery_separate: true,
    },
    notes: [
      'plan only; no schtasks/Register-ScheduledTask/registry call',
      'logon trigger is disabled by default; opt-in is explicit',
      'normal stop must not be resurrected by the scheduler',
      'outer budget is read/written from the SAME locator runtime_root before fork',
      'outer attempts never clear Hub/worker inner counters',
      'launcher resolves the current app_root entry each run, not a fixed old version',
      'live registration requires an explicit user window and rollback card',
    ],
  };
  plan.xml = schedulerXml(plan);
  return plan;
}

/** Materialize only the stable launcher artifact; never registers a task. */
export function writeLauncherArtifact(plan, { targetPath = plan.launcher.path, mode = 0o700 } = {}) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, plan.launcher.content, { encoding: 'utf8', mode });
  return { written: true, path: targetPath, task_registered: false };
}

/** Pure Task Scheduler XML; the caller may review it but no registration happens here. */
export function schedulerXml(plan) {
  const enabled = plan.logon_trigger?.enabled === true;
  const sidXml = plan.user_sid ? `\n      <UserId>${xmlEscape(plan.user_sid)}</UserId>` : '';
  const triggerXml = enabled
    ? `<LogonTrigger>\n      <Enabled>true</Enabled>${sidXml}\n    </LogonTrigger>`
    : '<LogonTrigger><Enabled>false</Enabled></LogonTrigger>';
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="${TASK_NAMESPACE}">
  <RegistrationInfo>
    <Description>Local Agent Bridge companion (candidate plan; not registered)</Description>
    <URI>\\${xmlEscape(plan.task_name)}</URI>
  </RegistrationInfo>
  <Triggers>
    ${triggerXml}
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>${sidXml}
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowHardTerminate>true</AllowHardTerminate>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
    <RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(plan.action.executable)}</Command>
      <Arguments>${xmlEscape(plan.action.arguments_quoted)}</Arguments>
      <WorkingDirectory>${xmlEscape(plan.action.working_directory)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>`;
}
