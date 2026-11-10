// Which app hosts a session, found without blocking the service: ps runs
// asynchronously, a session is looked at by one lookup at a time, and one
// that stays unknown is given up on after a few tries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/sessions/store.js';
import { createHostTracker } from '../src/host-tracker.js';
import { detectHost } from '../src/focus.js';

test('detectHost works with an async readProc', async () => {
  const tree = { 10: { ppid: 9, comm: 'node' }, 9: { ppid: 1, comm: 'Code Helper (Plugin)' } };
  assert.equal(await detectHost(10, async (p) => tree[p] || null), 'vscode');
});

test('a found host is stored once and not looked up again', async () => {
  const store = createStore();
  store.upsert('s1', { name: 'x' });
  let detects = 0;
  const t = createHostTracker({ store, lookup: () => ({ pid: 10 }), detect: async () => { detects++; return 'vscode'; }, retryMs: 0 });
  await t.refresh('s1');
  await t.refresh('s1');
  assert.equal(store.get('s1').host, 'vscode');
  assert.equal(detects, 1);
});

test('an unknown host is retried at most maxTries times', async () => {
  const store = createStore();
  store.upsert('s1', { name: 'x' });
  let detects = 0;
  const t = createHostTracker({ store, lookup: () => ({ pid: 10 }), detect: async () => { detects++; return 'unknown'; }, retryMs: 0, maxTries: 3 });
  for (let i = 0; i < 6; i++) await t.refresh('s1');
  assert.equal(detects, 3);
});

test('one lookup per session at a time', async () => {
  const store = createStore();
  store.upsert('s1', { name: 'x' });
  let detects = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const t = createHostTracker({ store, lookup: () => ({ pid: 10 }), detect: async () => { detects++; await gate; return 'terminal'; }, retryMs: 0 });
  const a = t.refresh('s1');
  const b = t.refresh('s1');
  release();
  await Promise.all([a, b]);
  assert.equal(detects, 1);
});
