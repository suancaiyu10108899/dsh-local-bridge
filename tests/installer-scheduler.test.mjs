import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planSchedulerLaunch } from '../installer/scheduler.mjs';
import { OUTER_BUDGET_MAX_ATTEMPTS, readOuterBudget, recordOuterAttempt, resetOuterBudget } from '../src/outer-budget.mjs';

test('scheduler/launcher plan is exact, read-only and never registers a task', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-scheduler-'));
  try {
    const companion = path.join(root, 'companion', 'main.mjs');
    const plan = planSchedulerLaunch({
      installationRoot: root,
      nodeExecutable: process.execPath,
      companionEntry: companion,
      now: 1_000,
    });
    assert.equal(plan.read_only, true);
    assert.equal(plan.task_registered, false);
    assert.equal(plan.principal.logon_type, 'InteractiveToken');
    assert.equal(plan.principal.run_level, 'LeastPrivilege');
    assert.equal(plan.principal.admin_required, false);
    assert.equal(plan.settings.multiple_instances, 'IgnoreNew');
    assert.equal(plan.settings.execution_time_limit, 'PT0S');
    assert.deepEqual(plan.settings.restart_on_failure, { enabled: true, count: 3, interval: 'PT1M' });
    assert.equal(plan.settings.normal_stop_policy, 'DO_NOT_RESTART');
    assert.equal(plan.ownership.clears_inner_counters, false);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('outer budget is persistent, bounded to 3/10min, separate from inner counters, and explicit-reset only', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-outer-budget-'));
  try {
    const file = path.join(root, 'companion', 'outer-budget.json');
    const inner = path.join(root, 'companion', 'hub-restart-state.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(inner, 'inner-sentinel');
    assert.equal(recordOuterAttempt({ file, now: 1_000 }).attempts, 1);
    assert.equal(recordOuterAttempt({ file, now: 2_000 }).attempts, 2);
    assert.equal(recordOuterAttempt({ file, now: 3_000 }).attempts, OUTER_BUDGET_MAX_ATTEMPTS);
    const blocked = recordOuterAttempt({ file, now: 4_000 });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.halted, true);
    assert.equal(blocked.code, 'OUTER_BUDGET_HALTED');
    assert.equal(fs.readFileSync(inner, 'utf8'), 'inner-sentinel', 'outer budget must not clear inner counters');
    assert.equal(readOuterBudget(file).attempts.length, OUTER_BUDGET_MAX_ATTEMPTS);
    assert.equal(recordOuterAttempt({ file, now: 10 * 60_000 + 5_000 }).ok, true);
    resetOuterBudget(file, { now: 20_000 });
    assert.equal(readOuterBudget(file).attempts.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});