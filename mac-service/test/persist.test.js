import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point the state dir at a scratch directory before anything reads config.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-thing-state-'));
process.env.CLAUDE_THING_STATE_DIR = DIR;

const { readState, writeState } = await import('../src/persist.js');
const { createUsage } = await import('../src/usage.js');

test('state survives a write and read', () => {
  writeState('round-trip', { limits: [{ key: 'session', used: 0.42 }] });
  assert.deepEqual(readState('round-trip'), { limits: [{ key: 'session', used: 0.42 }] });
  // and no temp files are left behind
  assert.deepEqual(fs.readdirSync(DIR).filter((f) => f.endsWith('.tmp')), []);
});

test('writeState honours a file mode', () => {
  assert.equal(writeState('m', { a: 1 }, { mode: 0o600 }), true);
  assert.equal(fs.statSync(path.join(DIR, 'm.json')).mode & 0o777, 0o600);
  assert.deepEqual(readState('m'), { a: 1 });
  // an existing, looser file is tightened too — the rename replaces it
  fs.chmodSync(path.join(DIR, 'm.json'), 0o644);
  writeState('m', { a: 2 }, { mode: 0o600 });
  assert.equal(fs.statSync(path.join(DIR, 'm.json')).mode & 0o777, 0o600);
});

test('nothing saved yet reads as the fallback, not a throw', () => {
  assert.equal(readState('never-written'), null);
  assert.deepEqual(readState('never-written', { limits: [] }), { limits: [] });
});

test('a half-written file reads as the fallback', () => {
  fs.writeFileSync(path.join(DIR, 'corrupt.json'), '{"limits": [');
  assert.equal(readState('corrupt'), null);
});

test('the daemon boots with the last reading, flagged stale', () => {
  writeState('usage', {
    updatedTs: Date.parse('2026-07-31T21:12:00'),
    updatedLabel: 'updated 21:12 · from claude /usage',
    limits: [{ key: 'session', label: 'SESSION', used: 0.86, detail: 'resets Aug 1 at 2am' }],
  });
  const u = createUsage({ emit: () => {} }).get();
  assert.equal(u.limits[0].used, 0.86, 'the screen shows real figures immediately');
  assert.equal(u.stale, true);
  assert.match(u.updatedLabel, /^last reading 21:12/);
});

test('an empty saved reading is not worth restoring', () => {
  writeState('usage', { limits: [] });
  assert.deepEqual(createUsage({ emit: () => {} }).get(), { limits: [], error: 'usage not read yet' });
});

// writeState with a mode: the digest state holds prompt excerpts, so it must be private to the owner.
const tmpFiles = () => fs.readdirSync(DIR).filter((f) => f.endsWith('.tmp'));

test('writeState with a mode writes that mode, even over an existing 0644 file', () => {
  fs.writeFileSync(path.join(DIR, 'secret.json'), '{}', { mode: 0o644 });
  assert.equal(writeState('secret', { a: 1 }, { mode: 0o600 }), true);
  assert.equal(fs.statSync(path.join(DIR, 'secret.json')).mode & 0o777, 0o600);
  assert.deepEqual(readState('secret'), { a: 1 });
  assert.deepEqual(tmpFiles(), []);
});

test('writeState without a mode keeps the process default', () => {
  assert.equal(writeState('plain', { a: 1 }), true);
  assert.equal(fs.statSync(path.join(DIR, 'plain.json')).mode & 0o777, 0o666 & ~process.umask());
});

test('a write that cannot serialize returns false, leaves the old file intact and no temp file', () => {
  assert.equal(writeState('keep', { v: 1 }, { mode: 0o600 }), true);
  const cyclic = {}; cyclic.self = cyclic;
  assert.equal(writeState('keep', cyclic, { mode: 0o600 }), false);
  assert.equal(writeState('keep', { big: 10n }, { mode: 0o600 }), false);
  assert.deepEqual(readState('keep'), { v: 1 });
  assert.equal(fs.statSync(path.join(DIR, 'keep.json')).mode & 0o777, 0o600);
  assert.deepEqual(tmpFiles(), []);
});

test('a write whose rename fails returns false and removes its temp file', () => {
  fs.mkdirSync(path.join(DIR, 'blocked.json'));   // the target is a directory, so the rename cannot replace it
  assert.equal(writeState('blocked', { a: 1 }, { mode: 0o600 }), false);
  assert.equal(fs.statSync(path.join(DIR, 'blocked.json')).isDirectory(), true);
  assert.deepEqual(tmpFiles(), []);
});

test('writeState with a mode chmods a temp file that was already there with a looser mode', () => {
  const stale = path.join(DIR, `stale.json.${process.pid}.tmp`);
  fs.writeFileSync(stale, 'left by a crash', { mode: 0o644 });   // create modes do not apply to an existing file
  assert.equal(writeState('stale', { a: 1 }, { mode: 0o600 }), true);
  assert.equal(fs.statSync(path.join(DIR, 'stale.json')).mode & 0o777, 0o600);
  assert.deepEqual(readState('stale'), { a: 1 });
  assert.deepEqual(tmpFiles(), []);
});
