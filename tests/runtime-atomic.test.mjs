import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renameAtomicWithRetry, writeJsonAtomic } from '../src/runtime.mjs';

function errno(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

test('Windows transient rename retries the same temp/destination without touching destination', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-bridge-atomic-'));
  try {
    const destination = path.join(root, 'config.json');
    const temp = path.join(root, 'config.json.tmp-fixed');
    fs.writeFileSync(destination, 'old');
    fs.writeFileSync(temp, 'new');
    let failures = 2;
    const attemptsSeen = [];
    const rename = (from, to) => {
      attemptsSeen.push({ from, to });
      assert.equal(from, temp);
      assert.equal(to, destination);
      assert.equal(fs.readFileSync(destination, 'utf8'), 'old');
      if (failures > 0) {
        failures -= 1;
        throw errno('EPERM');
      }
      fs.renameSync(from, to);
    };
    const result = renameAtomicWithRetry(temp, destination, {
      rename, sleep: () => {}, platform: 'win32', delays: [1, 2],
    });
    assert.equal(result.attempts, 3);
    assert.equal(attemptsSeen.length, 3);
    assert.equal(fs.readFileSync(destination, 'utf8'), 'new');
    assert.equal(fs.existsSync(temp), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('exhausted Windows rename retry preserves old destination and temp for diagnosis', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-bridge-atomic-'));
  try {
    const destination = path.join(root, 'config.json');
    const temp = path.join(root, 'config.json.tmp-fixed');
    fs.writeFileSync(destination, 'old');
    fs.writeFileSync(temp, 'new');
    assert.throws(
      () => renameAtomicWithRetry(temp, destination, {
        rename: () => { throw errno('EACCES'); },
        sleep: () => {}, platform: 'win32', delays: [1],
      }),
      (error) => error.code === 'EACCES',
    );
    assert.equal(fs.readFileSync(destination, 'utf8'), 'old');
    assert.equal(fs.readFileSync(temp, 'utf8'), 'new');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('non-Windows EPERM is not retried and writeJsonAtomic keeps destination unchanged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-bridge-atomic-'));
  try {
    const file = path.join(root, 'state.json');
    fs.writeFileSync(file, 'old');
    let attempts = 0;
    assert.throws(
      () => writeJsonAtomic(file, { state: 'new' }, {
        rename: () => { attempts += 1; throw errno('EPERM'); },
        sleep: () => {}, platform: 'linux',
      }),
      (error) => error.code === 'EPERM',
    );
    assert.equal(attempts, 1);
    assert.equal(fs.readFileSync(file, 'utf8'), 'old');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});