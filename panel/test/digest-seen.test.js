// When the Digest list was last looked at, so its cards can say NEW. A visit is a run of 1 s ticks
// with the screen on #/digest and lit; one of SEEN_MIN_MS or more, when it ends, marks the moment it
// ended. Driven here on a fake clock and an in-memory storage, as main.js's 1 s tick drives it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDigestSeen, tickWithSeen, SEEN_MIN_MS } from '../src/digest-seen.js';
import { createDisplay } from '../src/display.js';

function memoryStorage() {
  const m = {};
  return {
    m,
    getItem(k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
    setItem(k, v) { m[k] = String(v); },
  };
}

const throwing = {
  getItem() { throw new Error('SecurityError'); },
  setItem() { throw new Error('QuotaExceededError'); },
};

// A digestSeen on a fake clock. visit(ms) is the screen on #/digest and lit for ms (a tick a
// second), then one tick off it.
function make(storage, startMs) {
  const clock = { t: startMs === undefined ? 1800000000000 : startMs };
  const store = storage === undefined ? memoryStorage() : storage;
  const seen = createDigestSeen({ storage: store, now: () => clock.t });
  function visit(ms) {
    for (let i = 0; i < ms; i += 1000) { seen.tick(true, true); clock.t += 1000; }
    seen.tick(false, true);
  }
  // ms of ticks with the given flags, a tick a second.
  function run(ms, onScreen, lit) {
    for (let i = 0; i < ms; i += 1000) { seen.tick(onScreen, lit); clock.t += 1000; }
  }
  return { seen, clock, visit, run, storage: store };
}

test('nothing seen yet is 0, so every card starts NEW', () => { assert.equal(make().seen.seenTs(), 0); });

test('a visit is 5 s', () => { assert.equal(SEEN_MIN_MS, 5000); });

test('a visit of 5 s or more marks the moment it ended; a shorter one does not', () => {
  const h = make(); h.visit(4000); assert.equal(h.seen.seenTs(), 0); h.visit(6000); assert.equal(h.seen.seenTs(), h.clock.t);
});

test('exactly 5 s is a visit', () => {
  const h = make(); h.visit(5000); assert.equal(h.seen.seenTs(), h.clock.t);
});

test('a dark screen is not a visit', () => {
  const h = make();
  h.run(10000, true, false);
  h.seen.tick(false, true);
  assert.equal(h.seen.seenTs(), 0);
});

test('two short visits do not add up to one', () => {
  const h = make();
  h.visit(3000); h.visit(3000);
  assert.equal(h.seen.seenTs(), 0);
  h.run(3000, true, true); h.run(1000, true, false); h.run(3000, true, true); h.seen.tick(false, true);
  assert.equal(h.seen.seenTs(), 0, 'the screen going dark in between ends the first');
});

test('the screen going dark ends a visit, as leaving does', () => {
  const h = make();
  h.run(6000, true, true);
  h.seen.tick(true, false);
  assert.equal(h.seen.seenTs(), h.clock.t);
});

test('seenTs holds still during a visit, so NEW tags stay while the screen is up', () => {
  const h = make();
  h.visit(6000);
  const first = h.seen.seenTs();
  assert.equal(first, h.clock.t);
  for (let i = 0; i < 30; i++) { h.seen.tick(true, true); h.clock.t += 1000; assert.equal(h.seen.seenTs(), first, 'tick ' + i); }
  h.seen.tick(false, true);
  assert.equal(h.seen.seenTs(), h.clock.t, 'and moves to the end of the second visit');
  assert.ok(h.seen.seenTs() > first);
});

test('seenTs survives a reload through storage, and a throwing storage still works', () => {
  const h = make();
  h.visit(6000);
  assert.equal(h.storage.m.digestSeenTs, String(h.clock.t), 'kept under digestSeenTs');
  const again = createDigestSeen({ storage: h.storage, now: () => h.clock.t });
  assert.equal(again.seenTs(), h.clock.t);

  const t = make(throwing);
  assert.equal(t.seen.seenTs(), 0);
  t.visit(6000);
  assert.equal(t.seen.seenTs(), t.clock.t, 'kept in memory');
});

test('no storage at all, or a stored value that is not a time, reads as nothing seen', () => {
  const none = make(null);
  assert.equal(none.seen.seenTs(), 0);
  none.visit(6000);
  assert.equal(none.seen.seenTs(), none.clock.t);
  for (const v of ['banana', '', '-5', 'Infinity', 'NaN', '1e400']) {
    const s = memoryStorage(); s.m.digestSeenTs = v;
    assert.equal(make(s).seen.seenTs(), 0, JSON.stringify(v));
  }
  const s = memoryStorage(); s.m.digestSeenTs = '1700000000000';
  assert.equal(make(s).seen.seenTs(), 1700000000000);
});

// ---- main.js's 1 s tick -------------------------------------------------------------------------

test('the 1 s tick runs the display\'s own tick first, as it was called, then the visit clock', () => {
  const calls = [];
  let lit = true;
  const display = {
    tick(...args) { calls.push(['display', this, args]); lit = false; },
    isLit() { return lit; },
  };
  const seen = { tick(onScreen, l) { calls.push(['seen', onScreen, l]); } };
  let onDigest = true;
  const tick = tickWithSeen(display, seen, () => onDigest);
  const self = {};
  tick.call(self, 'late');
  assert.deepEqual(calls, [['display', self, ['late']], ['seen', true, false]], 'the screen as the display tick left it');
  onDigest = false; lit = true; calls.length = 0;
  tick();
  assert.deepEqual(calls.map((c) => c[0]), ['display', 'seen']);
  assert.deepEqual(calls[1], ['seen', false, false]);
});

test('wired to a real display: a lit visit counts, a dark one does not', () => {
  const clock = { t: 1800000000000 };
  const d = createDisplay({ recorder: null, now: () => clock.t, overlay: { show() {}, hide() {} } });
  d.linkUp(); d.macPower({ display: 'on', sleeping: false });
  const seen = createDigestSeen({ storage: null, now: () => clock.t });
  let route = 'digest';
  const tick = tickWithSeen(d, seen, () => route === 'digest');
  for (let i = 0; i < 6; i++) { tick(); clock.t += 1000; }
  route = 'list'; tick();
  assert.equal(seen.seenTs(), clock.t);
  const first = seen.seenTs();
  d.macPower({ display: 'off', sleeping: false });   // the Mac's display off, nothing waiting: dark
  assert.equal(d.isLit(), false, 'precondition: the screen is dark');
  route = 'digest';
  for (let i = 0; i < 10; i++) { clock.t += 1000; tick(); }
  route = 'list'; clock.t += 1000; tick();
  assert.equal(seen.seenTs(), first);
});
