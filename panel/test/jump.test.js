// When a loud item may pull the screen to the queue, the one second after it
// does where a press meant for the previous screen is swallowed, and when the
// queue hands the screen back to the grid. Pure: the clock is injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  JUMP_QUIET_MS, INPUT_GUARD_MS, QUEUE_IDLE_EXIT_MS,
  jumpNow, firstLoud, createInputGuard, guardGate, pendingJumpStep, queueIdleExitDue, queueSettled,
  ambientPressTarget, nextAskStep, heroChanged, askIdSet, reconnectJumpDue,
} from '../src/jump.js';

function perm(id, over = {}) {
  return { kind: 'permission', id, sessionId: 's', tool: 'Bash', summary: 'ls', createdTs: 1, ...over };
}

function card(id, over = {}) {
  return { kind: 'card', id, sessionId: 's', tag: 'asking', loud: true, createdTs: 1, ...over };
}

test('the constants are the design numbers', () => {
  assert.equal(JUMP_QUIET_MS, 10000);
  assert.equal(INPUT_GUARD_MS, 1000);
  assert.equal(QUEUE_IDLE_EXIT_MS, 60000);
});

// ---- jumpNow ----------------------------------------------------------------

test('no jump mid-action or within 10 s of input', () => {
  assert.equal(jumpNow({ routeName: 'home', msSinceInput: 3000 }), false);
  assert.equal(jumpNow({ routeName: 'home', msSinceInput: 10000 }), true);
  assert.equal(jumpNow({ routeName: 'dictate', msSinceInput: 1e9 }), false);
  assert.equal(jumpNow({ routeName: 'queue', msSinceInput: 1e9, queueAnswering: true }), false);
});

test('the new-session screens are the owner\'s hands-on work too: no jump over them', () => {
  for (const routeName of ['new', 'dictate', 'prompt', 'ask']) {
    assert.equal(jumpNow({ routeName, msSinceInput: 1e9 }), false, routeName);
  }
});

test('a jump needs a quiet panel from any resting screen', () => {
  for (const routeName of ['ambient', 'list', 'home', 'audio', 'session', 'agent', 'usage', 'nucbox', 'queue']) {
    assert.equal(jumpNow({ routeName, msSinceInput: 9999 }), false, routeName + ' just touched');
    assert.equal(jumpNow({ routeName, msSinceInput: 10000 }), true, routeName + ' left alone');
  }
});

test('the prompt, ask and dictate screens never jump, however long the quiet', () => {
  for (const routeName of ['dictate', 'prompt', 'ask']) {
    assert.equal(jumpNow({ routeName, msSinceInput: 1e9 }), false, routeName);
  }
});

test('dimming a light is mid-action', () => {
  assert.equal(jumpNow({ routeName: 'home', msSinceInput: 1e9, homeAdjusting: true }), false);
  assert.equal(jumpNow({ routeName: 'home', msSinceInput: 1e9, homeAdjusting: false }), true);
});

test('a missing input time means nothing is known, which is not a jump', () => {
  // A caller that forgot the clock must not be read as "never touched".
  assert.equal(jumpNow({ routeName: 'home' }), false);
});

test('a burst of loud arrivals with recent input never moves the cursor', () => {
  // Three loud cards within 2 s while the owner is turning the dial on the queue.
  const arrivals = [card('a'), card('b'), card('c')];
  for (let i = 0; i < arrivals.length; i++) {
    assert.equal(jumpNow({ routeName: 'queue', msSinceInput: 4000 + i * 700 }), false, arrivals[i].id);
  }
});

// ---- the input guard --------------------------------------------------------

test('the guard swallows presses for one second after a jump', () => {
  let t = 0; const g = createInputGuard(() => t); g.arm();
  assert.equal(g.blocks('select'), true); assert.equal(g.blocks('dial'), false);
  t = 1000; assert.equal(g.blocks('select'), false);
});

test('the guard blocks select, preset, deny and tap and nothing else', () => {
  const g = createInputGuard(() => 5); g.arm();
  for (const a of ['select', 'preset', 'deny', 'tap']) assert.equal(g.blocks(a), true, a);
  for (const a of ['dial', 'back', 'ambient', 'm-hold', 'm-release']) assert.equal(g.blocks(a), false, a);
});

test('a guard that was never armed blocks nothing', () => {
  const g = createInputGuard(() => 0);
  assert.equal(g.blocks('select'), false);
});

test('the guard is open up to the last millisecond and shut after', () => {
  let t = 5000; const g = createInputGuard(() => t); g.arm();
  t = 5999; assert.equal(g.blocks('tap'), true);
  t = 6000; assert.equal(g.blocks('tap'), false);
});

test('a second jump re-arms the guard from then on', () => {
  let t = 0; const g = createInputGuard(() => t);
  g.arm();
  t = 800; g.arm();
  t = 1500; assert.equal(g.blocks('select'), true, '700 ms after the second jump');
  t = 1800; assert.equal(g.blocks('select'), false);
});

// ---- the guard behind the screen's sleep gate -------------------------------

test('a press that only woke the dark screen stays swallowed, guarded or not', () => {
  let t = 0; const g = createInputGuard(() => t);
  let wakes = 0;
  const gate = guardGate(g, function () { wakes++; return false; });   // wakes the screen and swallows
  assert.equal(gate('select', 'knob'), false);
  g.arm();
  assert.equal(gate('select', 'knob'), false);
  assert.equal(wakes, 2, 'the sleep gate still sees every press, so the screen wakes');
});

test('the sleep gate runs first, so a guarded press still counts as touching the panel', () => {
  let t = 0; const g = createInputGuard(() => t); g.arm();
  const seen = [];
  const gate = guardGate(g, function (a, s) { seen.push(a + ':' + s); return true; });
  assert.equal(gate('select', 'knob'), false, 'guarded');
  assert.equal(gate('dial', 'knob'), true, 'a dial turn is not guarded');
  assert.deepEqual(seen, ['select:knob', 'dial:knob']);
  t = 1000;
  assert.equal(gate('select', 'knob'), true, 'guard over');
});

test('a gate that says nothing leaves the answer to the guard', () => {
  let t = 0; const g = createInputGuard(() => t);
  const gate = guardGate(g, function () { return undefined; });
  assert.notEqual(gate('select', 'key'), false);
  g.arm();
  assert.equal(gate('preset', 'key'), false);
});

// ---- the most urgent loud item ----------------------------------------------

test('the first loud item in queue order is the one a jump goes to', () => {
  const asks = [card('c-new', { createdTs: 5 }), card('c-old', { createdTs: 2 }), perm('p1'), perm('p2')];
  assert.equal(firstLoud(asks).id, 'p1', 'a permission outranks cards, in the order they arrived');
  assert.equal(firstLoud([card('c-new', { createdTs: 5 }), card('c-old', { createdTs: 2 })]).id, 'c-old', 'oldest loud card first');
});

test('quiet cards, UPDATE cards and expired asks are never the target', () => {
  const asks = [
    card('quiet', { loud: false, createdTs: 1 }),
    card('upd', { tag: 'update', loud: false, createdTs: 2 }),
    perm('gone', { expired: true }),
    card('loud', { createdTs: 9 }),
  ];
  assert.equal(firstLoud(asks).id, 'loud');
  assert.equal(firstLoud(asks.slice(0, 3)), null);
  assert.equal(firstLoud([]), null);
});

// ---- a waiting jump ---------------------------------------------------------

const free = { routeName: 'home', msSinceInput: 12000, waiting: true };

test('a waiting jump goes once the panel has been quiet for 10 s', () => {
  const asks = [perm('p')];
  assert.deepEqual(pendingJumpStep({ ...free, asks, msSinceInput: 4000 }), { action: 'wait', id: 'p' });
  assert.deepEqual(pendingJumpStep({ ...free, asks }), { action: 'go', id: 'p' });
});

test('P waiting, then C arrives: the jump goes to P, not the newest', () => {
  // Dictating when P (a permission, blocking a hook) arrives; 20 s later another
  // session's loud card C arrives. The owner finishes: P is the one that goes.
  const busy = { ...free, routeName: 'dictate', msSinceInput: 1e9 };
  assert.deepEqual(pendingJumpStep({ ...busy, asks: [perm('P')] }), { action: 'wait', id: 'P' });
  assert.deepEqual(pendingJumpStep({ ...busy, asks: [perm('P'), card('C', { createdTs: 20 })] }), { action: 'wait', id: 'P' });
  assert.deepEqual(pendingJumpStep({ ...free, asks: [perm('P'), card('C', { createdTs: 20 })] }), { action: 'go', id: 'P' });
});

test('P waiting, C cleared first: the jump still goes to P', () => {
  assert.deepEqual(pendingJumpStep({ ...free, asks: [perm('P')] }), { action: 'go', id: 'P' });
  // and when P is the one that went, an older loud card behind it is next
  assert.deepEqual(pendingJumpStep({ ...free, asks: [card('C', { createdTs: 20 })] }), { action: 'go', id: 'C' });
});

test('a waiting jump is dropped when nothing loud is left', () => {
  assert.deepEqual(pendingJumpStep({ ...free, asks: [] }), { action: 'drop', id: null });
  assert.deepEqual(pendingJumpStep({ ...free, asks: [card('c', { loud: false }), perm('p', { expired: true })] }),
    { action: 'drop', id: null }, 'went quiet or moved to the terminal');
  assert.deepEqual(pendingJumpStep({ ...free, msSinceInput: 1, asks: [] }), { action: 'drop', id: null }, 'even under recent input');
});

test('no jump is waiting, so there is nothing to do', () => {
  assert.deepEqual(pendingJumpStep({ ...free, waiting: false, asks: [perm('p')] }), { action: 'drop', id: null });
});

test('a waiting jump keeps waiting while the owner is mid-action', () => {
  const asks = [perm('p')];
  assert.equal(pendingJumpStep({ ...free, asks, routeName: 'dictate', msSinceInput: 1e9 }).action, 'wait');
  assert.equal(pendingJumpStep({ ...free, asks, msSinceInput: 1e9, homeAdjusting: true }).action, 'wait');
  assert.equal(pendingJumpStep({ ...free, asks, routeName: 'queue', msSinceInput: 1e9, queueAnswering: true }).action, 'wait');
});

test('a waiting jump is dropped once the most urgent item is the hero the owner is looking at', () => {
  const asks = [perm('p'), card('c')];
  assert.deepEqual(pendingJumpStep({ ...free, asks, routeName: 'queue', heroId: 'p' }), { action: 'drop', id: null });
  assert.deepEqual(pendingJumpStep({ ...free, asks, routeName: 'queue', heroId: 'c' }), { action: 'go', id: 'p' },
    'looking at a lesser item, the most urgent one still comes first');
  // being on another screen with it as the queue's cursor is not looking at it
  assert.deepEqual(pendingJumpStep({ ...free, asks, heroId: 'p' }), { action: 'go', id: 'p' });
});

// ---- handing back to the grid -----------------------------------------------

test('the queue hands back only when nothing is loud and a minute passed without input', () => {
  assert.equal(queueIdleExitDue({ routeName: 'queue', loud: 0, msSinceInput: 60000 }), true);
  assert.equal(queueIdleExitDue({ routeName: 'queue', loud: 1, msSinceInput: 1e9 }), false);
  assert.equal(queueIdleExitDue({ routeName: 'queue', loud: 0, msSinceInput: 59999 }), false);
});

test('only the queue hands back, and not with an answer in flight', () => {
  for (const routeName of ['home', 'list', 'ambient', 'prompt', 'ask', 'dictate', 'session', 'usage']) {
    assert.equal(queueIdleExitDue({ routeName, loud: 0, msSinceInput: 1e9 }), false, routeName);
  }
  assert.equal(queueIdleExitDue({ routeName: 'queue', loud: 0, msSinceInput: 1e9, inflight: { phase: 'undo' } }), false);
  assert.equal(queueIdleExitDue({ routeName: 'queue', loud: 0, msSinceInput: 1e9, inflight: null }), true);
});

test('reading quiet cards with the dial keeps the minute from running out', () => {
  // The caller feeds msSinceInput from the last input of any kind, so a dial
  // turn 30 s ago leaves 30 s to go however long the queue has been open.
  assert.equal(queueIdleExitDue({ routeName: 'queue', loud: 0, msSinceInput: 30000 }), false);
});

test('a missing input time never hands back', () => {
  assert.equal(queueIdleExitDue({ routeName: 'queue', loud: 0 }), false);
});

// ---- queueSettled -----------------------------------------------------------
// After an answer from the queue: nothing left that a second press could decide.

test('the queue is settled when no permission, question, prompt or loud card is left', () => {
  assert.equal(queueSettled([]), true);
  assert.equal(queueSettled([card('c', { loud: false, tag: 'update' })]), true, 'a quiet card is not a decision');
  assert.equal(queueSettled([perm('p', { expired: true })]), true, 'an expired ask waits on the terminal');
  assert.equal(queueSettled([perm('p')]), false);
  assert.equal(queueSettled([{ kind: 'question', id: 'q', sessionId: 's', questions: [] }]), false);
  assert.equal(queueSettled([{ kind: 'prompt', id: 'x', sessionId: 's', tool: 'AskUserQuestion' }]), false);
  assert.equal(queueSettled([card('c'), card('d', { loud: false })]), false, 'a loud card still pulls');
});

// ---- the ambient dial press --------------------------------------------------

test('the ambient dial press goes to the queue only when something is loud', () => {
  assert.equal(ambientPressTarget([]), '#/list');
  assert.equal(ambientPressTarget([card('u', { tag: 'update', loud: false })]), '#/list', 'a quiet UPDATE card');
  assert.equal(ambientPressTarget([card('a', { loud: false })]), '#/list', 'a quiet ASKING card');
  assert.equal(ambientPressTarget([perm('p', { expired: true })]), '#/list', 'a notice about the terminal');
  assert.equal(ambientPressTarget([card('u', { tag: 'update', loud: false }), card('a')]), '#/queue');
  assert.equal(ambientPressTarget([perm('p')]), '#/queue');
});

// ---- where answering a held question or plan leaves the owner -----------------

function held(id, kind, over = {}) {
  return { kind, id, sessionId: 's', createdTs: 1, ...over };
}

test('nothing left to decide, or the owner answered from the queue: back to where they were', () => {
  assert.deepEqual(nextAskStep([], '#/list'), { hash: '#/list', queueIndex: null });
  assert.deepEqual(nextAskStep([perm('p')], '#/queue'), { hash: '#/queue', queueIndex: null });
});

test('a leftover card is not "the next ask": the owner goes back to returnTo', () => {
  const asks = [card('c'), card('u', { tag: 'update', loud: false })];
  assert.deepEqual(nextAskStep(asks, '#/session/s1'), { hash: '#/session/s1', queueIndex: null });
  assert.deepEqual(nextAskStep(asks, '#/list'), { hash: '#/list', queueIndex: null });
});

test('an expired notice is not the next ask either', () => {
  assert.deepEqual(nextAskStep([perm('p', { expired: true })], '#/home'), { hash: '#/home', queueIndex: null });
});

test('the next permission opens on its own screen, the next question or plan on the queue', () => {
  assert.deepEqual(nextAskStep([perm('p'), card('c')], '#/list'), { hash: '#/ask/p', queueIndex: null });
  assert.deepEqual(nextAskStep([held('q', 'question'), card('c')], '#/list'), { hash: '#/queue', queueIndex: 0 });
  assert.deepEqual(nextAskStep([held('pr', 'prompt')], '#/list'), { hash: '#/queue', queueIndex: 0 });
});

test('the next ask skips an expired notice ahead of it and the cursor lands on the ask itself', () => {
  const asks = [perm('old', { expired: true }), held('q', 'question'), card('c')];
  assert.deepEqual(nextAskStep(asks, '#/list'), { hash: '#/queue', queueIndex: 1 });
  assert.deepEqual(nextAskStep([perm('old', { expired: true }), perm('p')], '#/list'), { hash: '#/ask/p', queueIndex: null });
});

// ---- the hero changing under the owner's hand --------------------------------

test('heroChanged: only a different hero on the queue arms the guard', () => {
  assert.equal(heroChanged('p', 'c', 'queue'), true);
  assert.equal(heroChanged('p', 'p', 'queue'), false);
  assert.equal(heroChanged('p', 'c', 'list'), false, 'off the queue nothing is under the hand');
  assert.equal(heroChanged('p', 'c', 'ask'), false);
  assert.equal(heroChanged(null, 'p', 'queue'), true, 'an empty queue gaining an item');
  assert.equal(heroChanged('p', null, 'queue'), true, 'the last item going');
  assert.equal(heroChanged(null, null, 'queue'), false);
});

// ---- a reconnect's sync -------------------------------------------------------

test('askIdSet is the ids of a list', () => {
  assert.deepEqual(askIdSet([perm('p'), card('c')]), { p: true, c: true });
  assert.deepEqual(askIdSet([]), {});
});

test('a reconnect jumps from the list only for a loud item the panel had not seen', () => {
  const listed = [card('seen'), card('fresh')];
  assert.equal(reconnectJumpDue(listed, { seen: true }, 'list'), true);
  assert.equal(reconnectJumpDue(listed, { seen: true, fresh: true }, 'list'), false, 'both already seen');
});

test('a loud card the owner saw and backed out of does not pull them back after a reconnect', () => {
  assert.equal(reconnectJumpDue([card('c')], askIdSet([card('c')]), 'list'), false);
});

test('a reconnect never jumps for a quiet card, an UPDATE card or off the list', () => {
  assert.equal(reconnectJumpDue([card('q', { loud: false })], {}, 'list'), false);
  assert.equal(reconnectJumpDue([card('u', { tag: 'update', loud: false })], {}, 'list'), false);
  assert.equal(reconnectJumpDue([card('c')], {}, 'home'), false);
  assert.equal(reconnectJumpDue([card('c')], {}, 'queue'), false);
  assert.equal(reconnectJumpDue([], {}, 'list'), false);
});

test('a first connection has seen nothing, so work waiting lands on the queue', () => {
  assert.equal(reconnectJumpDue([perm('p')], {}, 'list'), true);
});
