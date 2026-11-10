import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServicePrefs } from '../src/service-prefs.js';

test('prefs default chime on and ignore unknown keys', () => {
  const writes = [];
  const prefs = createServicePrefs({ write: (v) => writes.push(v) });
  assert.deepEqual(prefs.get(), { chime: true });
  assert.deepEqual(prefs.set({ chime: false, x: 1 }), { chime: false });
  assert.deepEqual(writes, [{ chime: false }]);
  assert.deepEqual(prefs.get(), { chime: false });
});

test('a saved setting is read back at start', () => {
  const prefs = createServicePrefs({ read: () => ({ chime: false }) });
  assert.deepEqual(prefs.get(), { chime: false });
});

test('anything unrecognisable on disk falls back to the default', () => {
  for (const saved of [null, undefined, 'x', 7, [], { chime: 'no' }, { chime: 0 }, { other: 1 }]) {
    const prefs = createServicePrefs({ read: () => saved });
    assert.deepEqual(prefs.get(), { chime: true }, JSON.stringify(saved));
  }
});

test('a read that throws falls back to the default', () => {
  const prefs = createServicePrefs({ read: () => { throw new Error('disk'); } });
  assert.deepEqual(prefs.get(), { chime: true });
});

test('set keeps only boolean values for known keys', () => {
  const writes = [];
  const prefs = createServicePrefs({ write: (v) => writes.push(v) });
  assert.deepEqual(prefs.set({ chime: 'off' }), { chime: true });
  assert.deepEqual(prefs.set(null), { chime: true });
  assert.deepEqual(prefs.set(undefined), { chime: true });
  assert.deepEqual(prefs.set({ chime: false }), { chime: false });
  assert.deepEqual(prefs.set({}), { chime: false });   // a patch with nothing in it changes nothing
  assert.deepEqual(prefs.get(), { chime: false });
});

test('set persists the whole setting each time', () => {
  const writes = [];
  const prefs = createServicePrefs({ write: (v) => writes.push(v) });
  prefs.set({ chime: false });
  prefs.set({ chime: true });
  assert.deepEqual(writes, [{ chime: false }, { chime: true }]);
});

test('get returns a copy, so a caller cannot change the setting behind its back', () => {
  const prefs = createServicePrefs({});
  const a = prefs.get();
  a.chime = false;
  assert.deepEqual(prefs.get(), { chime: true });
  const b = prefs.set({ chime: false });
  b.chime = true;
  assert.deepEqual(prefs.get(), { chime: false });
});

test('a write that throws does not lose the new setting or throw', () => {
  const prefs = createServicePrefs({ write: () => { throw new Error('disk full'); } });
  assert.deepEqual(prefs.set({ chime: false }), { chime: false });
  assert.deepEqual(prefs.get(), { chime: false });
});
