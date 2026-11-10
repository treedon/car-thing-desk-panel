import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createChime, CHIME_SOUND, CHIME_THROTTLE_MS, LOUD_TOPICS } from '../src/chime.js';

// Nothing here spawns the real afplay: every test injects a fake spawn, and a
// fake clock the test moves by hand.
let t;
let spawned;
let unrefs;
const now = () => t;

beforeEach(() => {
  t = 1_000_000;
  spawned = [];
  unrefs = 0;
});

function fakeSpawn(cmd, args, opts) {
  spawned.push({ cmd, args, opts });
  return { unref: () => { unrefs += 1; }, on: () => {} };
}

test('the chime is the system Glass sound, the throttle ten seconds, and three topics are loud', () => {
  assert.equal(CHIME_SOUND, '/System/Library/Sounds/Glass.aiff');
  assert.equal(CHIME_THROTTLE_MS, 10_000);
  assert.deepEqual(LOUD_TOPICS, [
    'claude.permission.request',
    'claude.prompt.created',
    'claude.question.request',
  ]);
});

test('ring plays afplay detached with its output ignored, and does not wait on it', () => {
  const chime = createChime({ spawn: fakeSpawn, now });
  assert.equal(chime.ring(), true);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].cmd, 'afplay');
  assert.deepEqual(spawned[0].args, [CHIME_SOUND]);
  assert.deepEqual(spawned[0].opts, { detached: true, stdio: 'ignore' });
  assert.equal(unrefs, 1);
});

test('one chime per 10 s however many ask', () => {
  const chime = createChime({ spawn: fakeSpawn, now });
  assert.equal(chime.ring(), true);
  t += 2000;
  assert.equal(chime.ring(), false);
  t += 7999;                       // t0 + 9999
  assert.equal(chime.ring(), false);
  assert.equal(spawned.length, 1);
  t += 1;                          // t0 + 10000
  assert.equal(chime.ring(), true);
  assert.equal(spawned.length, 2);
});

test('the throttle runs from the last sound that played, not the last ask', () => {
  const chime = createChime({ spawn: fakeSpawn, now });
  chime.ring();                    // plays at t0
  t += 9000;
  chime.ring();                    // throttled
  t += 1000;                       // t0 + 10000: ten seconds since the sound
  assert.equal(chime.ring(), true);
});

test('off means silent', () => {
  const chime = createChime({ spawn: fakeSpawn, now, enabled: () => false });
  assert.equal(chime.ring(), false);
  assert.equal(spawned.length, 0);
});

test('the setting is read at every ring, and an off ring does not start the throttle', () => {
  let on = false;
  const chime = createChime({ spawn: fakeSpawn, now, enabled: () => on });
  assert.equal(chime.ring(), false);
  on = true;
  t += 1;
  assert.equal(chime.ring(), true);   // turned on right after a silent ring: plays
  on = false;
  t += CHIME_THROTTLE_MS;
  assert.equal(chime.ring(), false);
  assert.equal(spawned.length, 1);
});

test('spawn failure never throws', () => {
  const chime = createChime({
    spawn: () => { throw new Error('spawn afplay ENOENT'); },
    now,
  });
  assert.equal(chime.ring(), false);
});

test('a failed spawn does not start the throttle, so the next ring still tries', () => {
  let fail = true;
  const chime = createChime({
    spawn: (...a) => { if (fail) throw new Error('boom'); return fakeSpawn(...a); },
    now,
  });
  assert.equal(chime.ring(), false);
  fail = false;
  t += 1;
  assert.equal(chime.ring(), true);
});

test('a child that errors later (no afplay) is swallowed instead of crashing the daemon', () => {
  const handlers = {};
  const chime = createChime({
    spawn: () => ({ unref() {}, on: (ev, fn) => { handlers[ev] = fn; } }),
    now,
  });
  assert.equal(chime.ring(), true);
  assert.equal(typeof handlers.error, 'function');
  assert.doesNotThrow(() => handlers.error(new Error('spawn afplay ENOENT')));
});

test('a throwing enabled() or clock never throws out of ring', () => {
  const a = createChime({ spawn: fakeSpawn, now, enabled: () => { throw new Error('x'); } });
  assert.equal(a.ring(), false);
  const b = createChime({ spawn: fakeSpawn, now: () => { throw new Error('x'); } });
  assert.equal(b.ring(), false);
});

test('a spawn that returns nothing still counts as played', () => {
  const chime = createChime({ spawn: () => undefined, now });
  assert.equal(chime.ring(), true);
});
