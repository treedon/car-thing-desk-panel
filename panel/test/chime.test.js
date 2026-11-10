// The Mac's chime setting, flipped from the panel. The decision lives in
// chime.js with the request, the state and the toast injected, so it runs here
// without a socket or a DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createChime } from '../src/chime.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function rig(initial, reply) {
  const log = { calls: [], toasts: [] };
  const state = { chimeOn: initial };
  let settle = null;
  const chime = createChime({
    request: (method, params) => {
      log.calls.push([method, params]);
      if (reply) return reply(method, params);
      return new Promise((resolve, reject) => { settle = { resolve, reject }; });
    },
    get: () => state.chimeOn,
    set: (v) => { state.chimeOn = v; },
    toast: (t) => log.toasts.push(t),
  });
  return { chime, state, log, settle: () => settle };
}

test('fetch stores the Mac\'s boolean and nothing else', async () => {
  let r = rig(null, () => Promise.resolve({ chime: false }));
  r.chime.fetch(); await tick();
  assert.strictEqual(r.state.chimeOn, false);
  assert.deepEqual(r.log.calls[0], ['claude.prefs.get', {}]);
  for (const bad of [{}, { chime: 'yes' }, null, undefined]) {
    r = rig(null, () => Promise.resolve(bad));
    r.chime.fetch(); await tick();
    assert.strictEqual(r.state.chimeOn, null, JSON.stringify(bad));
  }
  r = rig(null, () => Promise.reject(new Error('socket closed')));
  r.chime.fetch(); await tick();
  assert.strictEqual(r.state.chimeOn, null);
  assert.deepEqual(r.log.toasts, [], 'a failed read is not worth a toast');
});

test('toggle does nothing until the Mac has said what the chime is set to', () => {
  const r = rig(null);
  r.chime.toggle();
  assert.equal(r.log.calls.length, 0);
  assert.strictEqual(r.state.chimeOn, null);
  assert.deepEqual(r.log.toasts, []);
});

test('toggle shows the new value and says so at once, then keeps what the Mac answers', async () => {
  const r = rig(true);
  r.chime.toggle();
  assert.strictEqual(r.state.chimeOn, false, 'optimistic');
  assert.deepEqual(r.log.calls[0], ['claude.prefs.set', { chime: false }]);
  assert.deepEqual(r.log.toasts, ['CHIME OFF']);
  r.settle().resolve({ chime: false }); await tick();
  assert.strictEqual(r.state.chimeOn, false);
  assert.deepEqual(r.log.toasts, ['CHIME OFF'], 'no second toast when the Mac agrees');
  r.chime.toggle();
  assert.deepEqual(r.log.calls[1], ['claude.prefs.set', { chime: true }]);
  assert.deepEqual(r.log.toasts, ['CHIME OFF', 'CHIME ON']);
});

test('the Mac\'s answer wins, and the toast follows it when it differs', async () => {
  const r = rig(true, () => Promise.resolve({ chime: true }));
  r.chime.toggle(); await tick();
  assert.strictEqual(r.state.chimeOn, true);
  assert.deepEqual(r.log.toasts, ['CHIME OFF', 'CHIME ON']);
});

test('a reply with no boolean keeps the value the owner asked for', async () => {
  const r = rig(false, () => Promise.resolve({}));
  r.chime.toggle(); await tick();
  assert.strictEqual(r.state.chimeOn, true);
  assert.deepEqual(r.log.toasts, ['CHIME ON']);
});

test('a failed save puts the old value back and says it could not save', async () => {
  const r = rig(true, () => Promise.reject(new Error('timeout')));
  r.chime.toggle();
  assert.strictEqual(r.state.chimeOn, false);
  await tick();
  assert.strictEqual(r.state.chimeOn, true, 'reverted');
  assert.deepEqual(r.log.toasts, ['CHIME OFF', 'COULD NOT SAVE']);
  r.chime.toggle();
  assert.equal(r.log.calls.length, 2, 'it can be tried again');
});

test('a second press while a save is in flight does nothing', async () => {
  const r = rig(true);
  r.chime.toggle();
  r.chime.toggle(); r.chime.toggle();
  assert.equal(r.log.calls.length, 1);
  assert.strictEqual(r.state.chimeOn, false);
  assert.deepEqual(r.log.toasts, ['CHIME OFF']);
  r.settle().resolve({ chime: false }); await tick();
  r.chime.toggle();
  assert.equal(r.log.calls.length, 2, 'free again once the Mac has answered');
});
