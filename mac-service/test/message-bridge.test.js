// A dictated message from the panel reaches a session through documented hooks
// only: a working session gets it as PostToolUse additionalContext; an idle one
// is woken by the Stop hook's asyncRewake poller. Never typed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMessageBridge, MESSAGE_PREFIX } from '../src/message-bridge.js';

function setup() {
  const events = [];
  const bridge = createMessageBridge({ emit: (topic, data) => events.push({ topic, data }) });
  const of = (topic) => events.filter((e) => e.topic === topic).map((e) => e.data);
  return { bridge, events, of };
}

test('working session: next PostToolUse returns the message as additionalContext once', () => {
  const { bridge, of } = setup();
  assert.equal(bridge.send('s1', 'Use the staging database'), 'queued');
  assert.deepEqual(bridge.onPostToolUse({ session_id: 's1', tool_name: 'Bash' }), {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: MESSAGE_PREFIX + 'Use the staging database',
    },
  });
  assert.equal(bridge.onPostToolUse({ session_id: 's1', tool_name: 'Bash' }), null);
  assert.deepEqual(of('claude.message.delivered'), [{ sessionId: 's1', via: 'next-tool' }]);
});

test('another session\'s tool call does not take the message', () => {
  const { bridge } = setup();
  bridge.send('s1', 'hi');
  assert.equal(bridge.onPostToolUse({ session_id: 's2' }), null);
  assert.ok(bridge.onPostToolUse({ session_id: 's1' }));
});

test('idle session: waitForIdleMessage resolves with the text when sent', async () => {
  const { bridge, of } = setup();
  const waiting = bridge.waitForIdleMessage('s1');
  bridge.send('s1', 'Run the tests again');
  assert.equal(await waiting, MESSAGE_PREFIX + 'Run the tests again');
  assert.deepEqual(of('claude.message.delivered'), [{ sessionId: 's1', via: 'wake' }]);
  assert.equal(bridge.onPostToolUse({ session_id: 's1' }), null, 'delivered once only');
});

test('delivery reports the plain words', () => {
  const told = [];
  const bridge = createMessageBridge({ emit: () => {}, onDelivered: (id, text) => told.push([id, text]) });
  bridge.waitForIdleMessage('s');
  bridge.send('s', 'hello');
  assert.deepEqual(told, [['s', 'hello']], 'a wake, without the prefix');
  bridge.send('t', 'later');
  assert.equal(told.length, 1, 'queued is not delivered yet');
  bridge.onPostToolUse({ session_id: 't' });
  assert.deepEqual(told, [['s', 'hello'], ['t', 'later']], 'a next-tool delivery too');
});

test('delivery tells onDelivered how it arrived: wake or next-tool', async () => {
  const told = [];
  const bridge = createMessageBridge({ emit: () => {}, onDelivered: (id, text, via) => told.push([id, text, via]) });
  bridge.waitForIdleMessage('s');
  bridge.send('s', 'hello');
  bridge.send('t', 'later');
  bridge.onPostToolUse({ session_id: 't' });
  bridge.send('u', 'early');
  await bridge.waitForIdleMessage('u');
  assert.deepEqual(told, [['s', 'hello', 'wake'], ['t', 'later', 'next-tool'], ['u', 'early', 'wake']]);
});

test('a message handed to a poller that arrives late is reported too', async () => {
  const told = [];
  const bridge = createMessageBridge({ emit: () => {}, onDelivered: (id, text) => told.push([id, text]) });
  bridge.send('s', 'early');
  await bridge.waitForIdleMessage('s');
  assert.deepEqual(told, [['s', 'early']]);
});

test('an onDelivered that throws does not break delivery', async () => {
  const bridge = createMessageBridge({ emit: () => {}, onDelivered: () => { throw new Error('boom'); } });
  const waiting = bridge.waitForIdleMessage('s1');
  assert.equal(bridge.send('s1', 'hi'), 'woke');
  assert.equal(await waiting, MESSAGE_PREFIX + 'hi');
  bridge.send('s2', 'there');
  assert.equal(bridge.onPostToolUse({ session_id: 's2' }).hookSpecificOutput.additionalContext, MESSAGE_PREFIX + 'there');
});

test('a message sent before the idle poller arrives is handed over when it does', async () => {
  const { bridge } = setup();
  bridge.send('s1', 'early');
  assert.equal(await bridge.waitForIdleMessage('s1'), MESSAGE_PREFIX + 'early');
});

test('owner typing drops the pending message and emits dropped', async () => {
  const { bridge, of } = setup();
  bridge.send('s1', 'stale idea');
  bridge.onUserPromptSubmit({ session_id: 's1', prompt: 'something else entirely' });
  assert.deepEqual(of('claude.message.dropped'), [{ sessionId: 's1', reason: 'owner-typed' }]);
  assert.equal(bridge.onPostToolUse({ session_id: 's1' }), null, 'never delivered on top of the new prompt');
  const ac = new AbortController();
  const w = bridge.waitForIdleMessage('s1', ac.signal);
  ac.abort();
  assert.equal(await w, null);
});

test('owner typing also ends an idle poller with nothing', async () => {
  const { bridge } = setup();
  const w = bridge.waitForIdleMessage('s1');
  bridge.onUserPromptSubmit({ session_id: 's1' });
  assert.equal(await w, null);
});

test('a newer message replaces an undelivered one', () => {
  const { bridge, of } = setup();
  bridge.send('s1', 'first');
  bridge.send('s1', 'second');
  assert.equal(bridge.onPostToolUse({ session_id: 's1' }).hookSpecificOutput.additionalContext, MESSAGE_PREFIX + 'second');
  assert.deepEqual(of('claude.message.dropped'), [{ sessionId: 's1', reason: 'replaced' }]);
});

test('waiter aborted by signal resolves null', async () => {
  const { bridge } = setup();
  const ac = new AbortController();
  const w = bridge.waitForIdleMessage('s1', ac.signal);
  ac.abort();
  assert.equal(await w, null);
  bridge.send('s1', 'later');
  assert.ok(bridge.onPostToolUse({ session_id: 's1' }), 'the aborted waiter did not swallow it');
});

test('empty text is refused', () => {
  const { bridge } = setup();
  assert.throws(() => bridge.send('s1', '   '), /empty-message/);
});

test('delivery: a held question or plan is answered; a working session gets it next tool; else it wakes', async () => {
  const { chooseDelivery } = await import('../src/message-bridge.js');
  assert.equal(chooseDelivery({ promptHeld: true, working: true }), 'answer');
  assert.equal(chooseDelivery({ promptHeld: false, working: true }), 'next-tool');
  assert.equal(chooseDelivery({ promptHeld: false, working: false, pollerWaiting: true }), 'wake');
});

test('send says whether a waiting idle poller took the message', () => {
  const { bridge } = setup();
  assert.equal(bridge.send('s1', 'nobody listening'), 'queued');
  bridge.waitForIdleMessage('s2');
  assert.equal(bridge.send('s2', 'poller there'), 'woke');
});

test('an idle session with no poller cannot be woken, and says so', async () => {
  const { chooseDelivery } = await import('../src/message-bridge.js');
  assert.equal(chooseDelivery({ promptHeld: false, working: false, pollerWaiting: false }), 'cannot-wake');
  assert.equal(chooseDelivery({ promptHeld: false, working: false, pollerWaiting: true }), 'wake');
});

test('a message to an unknown session, or to a several-part question, is refused with a reason', async () => {
  const { chooseDelivery } = await import('../src/message-bridge.js');
  assert.equal(chooseDelivery({ known: false, promptHeld: false, working: true }), 'unknown-session');
  assert.equal(chooseDelivery({ known: true, promptHeld: true, promptParts: 2, working: true }), 'answer-on-panel');
  assert.equal(chooseDelivery({ known: true, promptHeld: true, promptParts: 1, working: true }), 'answer');
});
