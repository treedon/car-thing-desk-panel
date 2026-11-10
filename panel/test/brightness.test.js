import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBrightness } from '../src/brightness.js';

// Task 5 polls the sensor every 2 s while the screen is lit.
const POLL = 2000;

// A brightness curve on a fake clock. feed(ch0, n) takes n readings of ch0,
// one every POLL ms, and leaves the clock one interval after the last.
function make(opts) {
  const clock = { t: 1000000 };
  const b = createBrightness(Object.assign({ now: () => clock.t }, opts));
  function feed(ch0, n) {
    for (let i = 0; i < n; i++) {
      b.reading(ch0);
      clock.t += POLL;
    }
  }
  return { b, clock, feed };
}

test('no readings → level 1', () => {
  const { b } = make();
  assert.equal(b.level(), 1);
});

test('steady 5000 → level 1; steady 10 → level 0.6', () => {
  const bright = make();
  bright.feed(5000, 20);
  assert.equal(bright.b.level(), 1);

  const dark = make();
  dark.feed(10, 20);
  assert.equal(dark.b.level(), 0.6);
});

test('the first reading seeds the average', () => {
  const { b, feed } = make();
  feed(10, 1);
  assert.equal(b.level(), 0.6, 'one dark reading is enough, no ramp from 1');
});

test('the level is on a log scale between darkRaw and brightRaw', () => {
  // The geometric mean of 30 and 1500 is the halfway point of the log scale.
  const { b, feed } = make();
  feed(Math.sqrt(30 * 1500), 10);
  assert.ok(Math.abs(b.level() - 0.8) < 1e-6, 'halfway between 0.6 and 1: ' + b.level());

  const edge = make();
  edge.feed(30, 10);
  assert.equal(edge.b.level(), 0.6, 'darkRaw is the bottom');
  const top = make();
  top.feed(1500, 10);
  assert.equal(top.b.level(), 1, 'brightRaw is the top');
});

test('a single dark sample in a bright room moves the level by less than 0.05', () => {
  for (const dark of [10, 0]) {
    const { b, feed } = make();
    feed(1500, 30);
    const before = b.level();
    feed(dark, 1);
    const after = b.level();
    assert.ok(after < before, 'it does move: ' + before + ' → ' + after);
    assert.ok(before - after < 0.05, 'a shadow over the sensor: ' + (before - after));
  }
});

test('after 5×tauMs of darkness the level is within 0.01 of 0.6', () => {
  const { b, feed } = make();
  feed(1500, 30);
  assert.equal(b.level(), 1);
  feed(10, 4); // one time constant in: well on the way down, not there yet
  assert.ok(b.level() > 0.8 && b.level() < 0.95, 'gradual: ' + b.level());
  feed(10, 16); // 20 readings × 2 s = 40 s = 5 × 8000 ms since the last bright one
  assert.ok(Math.abs(b.level() - 0.6) < 0.01, 'settled: ' + b.level());
});

test('a bright room after darkness brings the level back up', () => {
  const { b, feed } = make();
  feed(10, 30);
  assert.equal(b.level(), 0.6);
  feed(1500, 3);
  assert.ok(b.level() > 0.6, 'rising: ' + b.level());
  feed(1500, 17);
  assert.ok(1 - b.level() < 0.01, 'back up: ' + b.level());
});

test('NaN, -1, undefined and \'\' readings leave the level unchanged', () => {
  const fresh = make();
  for (const junk of [NaN, -1, undefined, '']) fresh.b.reading(junk);
  assert.equal(fresh.b.level(), 1, 'no valid reading yet: still the default');

  const { b, clock, feed } = make();
  feed(300, 20);
  const level = b.level();
  assert.ok(level > 0.6 && level < 1);
  const junk = [NaN, -1, undefined, '', null, '500', '0', Infinity, -Infinity, 65536, 1e9, {}, [], true];
  for (const x of junk) {
    b.reading(x);
    clock.t += POLL;
    assert.equal(b.level(), level, 'ignored: ' + String(x));
  }
  // A junk reading does not count as a sample for the average either.
  feed(300, 5);
  assert.equal(b.level(), level);
});

test('65535 counts as bright', () => {
  const sat = make();
  sat.feed(65535, 20);
  assert.equal(sat.b.level(), 1);

  // From the dark, a saturated reading pulls the level up exactly as a
  // reading of brightRaw does.
  const a = make();
  a.feed(10, 20);
  a.feed(65535, 3);
  const b = make();
  b.feed(10, 20);
  b.feed(1500, 3);
  assert.ok(a.b.level() > 0.6);
  assert.equal(a.b.level(), b.b.level());
});

test('next() returns null for changes under 0.03, then a permille once the change reaches it', () => {
  const { b, feed } = make();
  feed(1500, 20);
  assert.equal(b.next(), 1000, 'the first call always returns a value');
  assert.equal(b.next(), null, 'nothing has changed');

  // Ease down from 1.0. Each step is small: the level stays within 0.03 of
  // what was sent for a while, then reaches it.
  let sent = null;
  let steps = 0;
  let last = b.level();
  while (sent === null && steps < 100) {
    feed(1000, 1);
    steps++;
    const lvl = b.level();
    const n = b.next();
    if (n === null) {
      assert.ok(1 - lvl < 0.03, 'null while the change is under 0.03: ' + lvl);
      last = lvl;
    } else {
      sent = n;
      assert.ok(1 - lvl >= 0.03, 'sent once the change reaches 0.03: ' + lvl);
      assert.equal(n, Math.round(lvl * 1000));
    }
  }
  assert.ok(steps > 1, 'it took more than one reading to get there');
  assert.ok(last < 1, 'the level did move before the permille went out');
  assert.ok(sent !== null && sent < 1000 && sent >= 600, 'sent ' + sent);
  assert.equal(Number.isInteger(sent), true, 'a whole permille');

  // The new value is the reference now.
  assert.equal(b.next(), null);

  // And back up: the same rule applies upward.
  let up = null;
  for (let i = 0; i < 100 && up === null; i++) {
    feed(1500, 1);
    up = b.next();
  }
  assert.ok(up !== null && up > sent, 'sent ' + up + ' after ' + sent);
  assert.ok((up - sent) / 1000 >= 0.03);
});

test('level never leaves [0.6, 1]', () => {
  const { b, clock } = make();
  const wild = [0, 1, 29, 30, 31, 100, 1499, 1500, 1501, 5000, 65534, 65535, 65536, -5, NaN, undefined, ''];
  let seed = 12345;
  function rand() {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  }
  for (let i = 0; i < 2000; i++) {
    const r = rand();
    b.reading(r < 0.5 ? wild[Math.floor(rand() * wild.length)] : Math.floor(rand() * 4000));
    // Mostly 2 s apart, sometimes at the same instant, sometimes a long gap,
    // and sometimes the clock steps backwards.
    const gap = [POLL, POLL, POLL, 0, 600000, -3000][Math.floor(rand() * 6)];
    clock.t += gap;
    const lvl = b.level();
    assert.ok(lvl >= 0.6 && lvl <= 1, 'level ' + lvl + ' at step ' + i);
    const n = b.next();
    assert.ok(n === null || (n >= 600 && n <= 1000), 'permille ' + n + ' at step ' + i);
  }
});

test('a long gap between readings forgets the old room', () => {
  // The screen was dark for a while, so nothing was read. The first reading
  // after it is the room as it is now, not an average with the room before.
  const { b, clock, feed } = make();
  feed(1500, 30);
  clock.t += 10 * 60000;
  feed(10, 1);
  assert.equal(b.level(), 0.6);
});

test('options override the constants', () => {
  const clock = { t: 0 };
  const b = createBrightness({
    now: () => clock.t, darkLevel: 0.3, darkRaw: 100, brightRaw: 10000, tauMs: 1000, stepMin: 0.2,
  });
  b.reading(50);
  assert.equal(b.level(), 0.3, 'below the new darkRaw');
  assert.equal(b.next(), 300);
  clock.t += 1000;
  b.reading(10000);
  // One time constant: the average is 63% of the way from 50 to 10000.
  assert.ok(b.level() > 0.3 && b.level() < 1, String(b.level()));
  clock.t += 20000;
  b.reading(10000);
  assert.ok(1 - b.level() < 1e-6, String(b.level()));
  assert.equal(b.next(), 1000, 'a change of 0.7 is over the new stepMin');
});

test('without an injected clock it uses Date.now', () => {
  const b = createBrightness();
  b.reading(10);
  assert.equal(b.level(), 0.6);
});
