import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timeHook, HOOK_TIMING } from '../src/hook-timing.js';

function fakeClock(...ticks) {
  const q = ticks.map(BigInt);
  let calls = 0;
  const clock = () => { calls++; return q.shift(); };
  clock.calls = () => calls;
  return clock;
}

test('with the flag on, the event name and elapsed milliseconds are logged', () => {
  const lines = [];
  const clock = fakeClock(1_000_000, 1_420_000);   // 0.42 ms in nanoseconds
  const out = timeHook('Stop', () => 'result', { enabled: true, clock, write: (...a) => lines.push(a) });
  assert.equal(out, 'result', 'the handler\'s return value passes through');
  assert.deepEqual(lines, [['HK', 'timing Stop 0.42ms']]);
});

test('a handler that throws is still timed, and the error is not swallowed', () => {
  const lines = [];
  const clock = fakeClock(0, 2_000_000);
  assert.throws(
    () => timeHook('PostToolUse', () => { throw new Error('boom'); }, { enabled: true, clock, write: (...a) => lines.push(a) }),
    /boom/,
  );
  assert.deepEqual(lines, [['HK', 'timing PostToolUse 2.00ms']]);
});

test('with the flag off it costs nothing: no clock read, no log', () => {
  const clock = fakeClock();
  let wrote = false;
  assert.equal(timeHook('Stop', () => 7, { enabled: false, clock, write: () => { wrote = true; } }), 7);
  assert.equal(clock.calls(), 0);
  assert.equal(wrote, false);
});

test('the flag is off unless CLAUDE_THING_HOOK_TIMING is exactly 1', () => {
  assert.equal(HOOK_TIMING, process.env.CLAUDE_THING_HOOK_TIMING === '1');
});
