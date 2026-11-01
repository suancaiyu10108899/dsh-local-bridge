// Persistent outer launch budget. The outer launcher is allowed at most three
// attempts in ten minutes; this file is separate from Hub/worker inner policy
// snapshots and never clears them.
import fs from 'node:fs';
import path from 'node:path';

export const OUTER_BUDGET_WINDOW_MS = 10 * 60_000;
export const OUTER_BUDGET_MAX_ATTEMPTS = 3;
export const OUTER_BUDGET_SCHEMA_VERSION = 1;

export class OuterBudgetError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'OuterBudgetError';
    this.code = code;
    this.details = details;
  }
}

function emptyState(now) {
  return { v: OUTER_BUDGET_SCHEMA_VERSION, attempts: [], updated_at: new Date(now).toISOString() };
}

export function readOuterBudget(file) {
  if (!fs.existsSync(file)) return emptyState(Date.now());
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new OuterBudgetError('OUTER_BUDGET_CORRUPT', `outer budget is unreadable: ${file}`);
  }
  if (value?.v !== OUTER_BUDGET_SCHEMA_VERSION || !Array.isArray(value.attempts) ||
      value.attempts.some((item) => typeof item !== 'string' || !Number.isFinite(Date.parse(item)))) {
    throw new OuterBudgetError('OUTER_BUDGET_CORRUPT', `outer budget has an invalid shape: ${file}`);
  }
  return value;
}

export function recordOuterAttempt({ file, now = Date.now(), windowMs = OUTER_BUDGET_WINDOW_MS, maxAttempts = OUTER_BUDGET_MAX_ATTEMPTS }) {
  let state;
  try { state = readOuterBudget(file); }
  catch (error) { return { ok: false, code: error.code ?? 'OUTER_BUDGET_CORRUPT', halted: true, attempts: maxAttempts }; }
  const cutoff = now - windowMs;
  const attempts = state.attempts.filter((item) => Date.parse(item) > cutoff);
  if (attempts.length >= maxAttempts) {
    return { ok: false, code: 'OUTER_BUDGET_HALTED', halted: true, attempts: attempts.length, window_ms: windowMs };
  }
  attempts.push(new Date(now).toISOString());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify({ v: OUTER_BUDGET_SCHEMA_VERSION, attempts, updated_at: new Date(now).toISOString() }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch { /* best effort */ }
  }
  return { ok: true, halted: false, attempts: attempts.length, window_ms: windowMs };
}

/** Explicit operator/upgrade reset only; never called by inner Hub/worker failure. */
export function resetOuterBudget(file, { now = Date.now() } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(emptyState(now), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch { /* best effort */ }
  }
  return { ok: true, attempts: [], reset_at: new Date(now).toISOString() };
}
