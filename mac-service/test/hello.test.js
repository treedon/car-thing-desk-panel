// A client hello must carry the Mac's power state as well as the waiting list,
// so a panel that reconnects after a Mac service restart (display still off)
// learns it at once instead of waiting for the next change.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { helloEvents } from '../src/hello.js';
import { createMacPower } from '../src/mac-power.js';

test('a hello emits the queue sync and the current Mac power state', () => {
  const macPower = createMacPower({});
  macPower.feed('display off');
  const snapshot = { asks: [{ id: 'a1' }] };
  const emitted = [];
  for (const [topic, data] of helloEvents({ queueSnapshot: () => snapshot, macPower })) {
    emitted.push({ topic, data });
  }
  assert.deepEqual(emitted, [
    { topic: 'claude.queue.sync', data: snapshot },
    { topic: 'claude.mac.power', data: { display: 'off', sleeping: false } },
  ]);
});

test('a hello with nothing reported yet sends the default state', () => {
  const macPower = createMacPower({});
  const events = helloEvents({ queueSnapshot: () => ({ asks: [] }), macPower });
  assert.deepEqual(events.map(([topic]) => topic), ['claude.queue.sync', 'claude.mac.power']);
  assert.deepEqual(events[1][1], { display: 'on', sleeping: false });
});
