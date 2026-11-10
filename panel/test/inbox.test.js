// Cards live in state.asks beside permissions and questions, ordered by how
// much they need the owner. The Mac service sends a card per session and, when
// a newer turn replaces it, only the new card — the panel drops the old one.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as store from '../src/store.js';
import {
  isCard, isLoud, loudCount, orderQueue, queueCounts, replySent, ambientQueue, blockingCount,
  CARD_CHIPS, cardChipOf, queueDialStep,
} from '../src/inbox.js';
import { heroChanged } from '../src/jump.js';

function perm(id, over = {}) {
  return { kind: 'permission', id, sessionId: 'sp', tool: 'Bash', summary: 'ls', createdTs: 1, ...over };
}

function question(id, over = {}) {
  return { kind: 'question', id, sessionId: 'sq', header: 'Q', question: 'q', options: [], createdTs: 1, ...over };
}

function card(sessionId, stoppedTs, over = {}) {
  return {
    kind: 'card', id: 'card:' + sessionId + ':' + stoppedTs, sessionId, sessionName: sessionId,
    host: 'mac', tag: 'asking', text: 'text', excerpt: 'excerpt', intent: '',
    createdTs: stoppedTs, stoppedTs, loud: true, loudUntil: stoppedTs + 600000,
    endedTs: null, summary: null, ...over,
  };
}

function seed(asks, queueIndex = 0) {
  store.update({
    asks: asks.slice(), queueIndex, queueAnswering: false, queueChoice: 0,
    queueQIndex: 0, queueAnswers: [], queueReview: false, queueFromReview: false,
    undo: null, armed: null,
  });
}

const ids = () => store.get().asks.map((a) => a.id);
const hero = () => store.get().asks[store.get().queueIndex];

test('isCard and isLoud', () => {
  assert.equal(isCard(card('s1', 5)), true);
  assert.equal(isCard(perm('p')), false);
  assert.equal(isLoud(perm('p')), true, 'a permission is always loud');
  assert.equal(isLoud(question('q')), true);
  assert.equal(isLoud(card('s1', 5)), true);
  assert.equal(isLoud(card('s1', 5, { loud: false })), false, 'a quiet card is not');
  assert.equal(isLoud(perm('p', { expired: true })), false, 'an expired ask waits on the terminal');
});

test('order: blocking asks, then asking/error oldest first, then updates newest first', () => {
  const p1 = perm('p1', { createdTs: 50 });
  const q1 = question('q1', { createdTs: 10 });
  const askNew = card('a', 300, { tag: 'asking' });
  const errOld = card('e', 100, { tag: 'error' });
  const askMid = card('b', 200, { tag: 'asking', loud: false });
  const upOld = card('u1', 120, { tag: 'update', loud: false });
  const upNew = card('u2', 400, { tag: 'update', loud: false });
  const input = [upOld, askNew, p1, upNew, errOld, q1, askMid];
  const before = input.slice();

  const out = orderQueue(input);

  assert.deepEqual(out.map((a) => a.id), [
    'p1', 'q1',                                    // non-cards, in their existing relative order
    errOld.id, askMid.id, askNew.id,               // asking and error, oldest createdTs first
    upNew.id, upOld.id,                            // updates, newest first
  ]);
  assert.notEqual(out, input, 'a new array');
  assert.deepEqual(input, before, 'the input is left alone');
});

test('order is stable past the sizes where an unstable sort would shuffle ties', () => {
  const perms = [];
  const asking = [];
  const updates = [];
  for (let i = 0; i < 14; i++) {
    perms.push(perm('p' + i));
    asking.push(card('a' + i, 100, { id: 'ca' + i }));       // all the same createdTs
    updates.push(card('u' + i, 100, { id: 'cu' + i, tag: 'update', loud: false }));
  }
  const out = orderQueue(updates.concat(asking, perms));
  assert.deepEqual(out.map((a) => a.id), perms.concat(asking, updates).map((a) => a.id));
});

test('loudCount ignores quiet cards and expired asks', () => {
  const asks = [
    perm('p1'),
    perm('p2', { expired: true }),
    question('q1'),
    card('a', 100),
    card('b', 200, { loud: false }),
    card('c', 300, { tag: 'update', loud: false }),
  ];
  assert.equal(loudCount(asks), 3);
  assert.equal(loudCount([]), 0);
});

test('queueCounts: what is waiting on you, and how many updates', () => {
  const asks = [
    perm('p1'),
    card('a', 100),
    card('b', 200, { tag: 'error', loud: false }),
    card('u1', 300, { tag: 'update', loud: false }),
    card('u2', 400, { tag: 'update', loud: false }),
    card('u3', 500, { tag: 'update', loud: false }),
  ];
  assert.deepEqual(queueCounts(asks), { waiting: 3, updates: 3 });
  assert.deepEqual(queueCounts([]), { waiting: 0, updates: 0 });
});

test('queueCounts: an expired ask waits on the terminal, not on you', () => {
  const asks = [
    perm('p1', { expired: true }),
    perm('p2'),
    question('q1', { expired: true }),
    card('a', 100),
    card('u1', 300, { tag: 'update', loud: false }),
  ];
  assert.deepEqual(queueCounts(asks), { waiting: 2, updates: 1 });
  assert.deepEqual(queueCounts([perm('p1', { expired: true })]), { waiting: 0, updates: 0 });
});

test('upsertCard inserts a new card in its place in the order', () => {
  seed([perm('p1'), card('a', 100)]);
  store.upsertCard(card('b', 50));
  store.upsertCard(card('u', 900, { tag: 'update', loud: false }));
  assert.deepEqual(ids(), ['p1', 'card:b:50', 'card:a:100', 'card:u:900']);
});

test('upsertCard names a card that arrives without a session name', () => {
  seed([]);
  store.upsertCard(card('s9', 100, { sessionName: '' }));
  assert.equal(typeof store.get().asks[0].sessionName, 'string');
  assert.ok(store.get().asks[0].sessionName.length > 0);
});

test('a newer turn drops the same session\'s old card, which was never cleared', () => {
  seed([perm('p1'), card('s1', 100), card('s2', 200)], 0);
  store.upsertCard(card('s1', 300));
  assert.deepEqual(ids(), ['p1', 'card:s2:200', 'card:s1:300'], 'one card per session');
});

test('a replaced hero card keeps the cursor on its session', () => {
  seed([perm('p1'), card('s1', 100), card('s2', 200)], 1);
  assert.equal(hero().sessionId, 's1');
  store.upsertCard(card('s1', 300));   // sorts after s2 now
  assert.equal(hero().sessionId, 's1');
  assert.equal(hero().id, 'card:s1:300');
  assert.equal(store.get().queueIndex, 2);
});

test('a card that replaces the hero closes anything half-answered', () => {
  seed([card('s1', 100)], 0);
  store.update({ queueAnswering: true, queueChoice: 2, queueAnswers: [[1]] });
  store.upsertCard(card('s1', 300));
  assert.equal(store.get().queueAnswering, false);
  assert.deepEqual(store.get().queueAnswers, []);
});

test('a card landing before the hero does not move the cursor off the hero', () => {
  const q = question('q1');
  seed([q, card('s1', 100)], 0);
  store.update({ queueAnswering: true, queueChoice: 1 });
  store.upsertCard(card('s2', 50));
  assert.equal(hero(), q, 'the hero is still the question');
  store.upsertCard(card('s3', 40, { tag: 'update', loud: false }));
  assert.equal(hero(), q);
  assert.equal(store.get().queueAnswering, true, 'the open option list is not closed for a card');
  assert.equal(store.get().queueChoice, 1);
});

test('a card landing ahead of a hero card moves the cursor with it', () => {
  seed([card('s1', 100), card('s2', 200)], 1);
  assert.equal(hero().sessionId, 's2');
  store.upsertCard(card('s3', 50));    // oldest asking → first
  assert.deepEqual(ids(), ['card:s3:50', 'card:s1:100', 'card:s2:200']);
  assert.equal(hero().sessionId, 's2');
  assert.equal(store.get().queueIndex, 2);
});

test('a card re-sent quiet updates in place without moving the cursor', () => {
  seed([perm('p1'), card('s1', 100), card('s2', 200)], 1);
  store.upsertCard(card('s1', 100, { loud: false }));
  assert.equal(store.get().queueIndex, 1);
  assert.equal(hero().id, 'card:s1:100');
  assert.equal(hero().loud, false);
  assert.equal(store.get().asks.length, 3);
});

test('a summary attaching re-sends the same id and replaces the card in place', () => {
  seed([card('s1', 100)], 0);
  store.upsertCard(card('s1', 100, { summary: { headline: 'did it', bullets: ['a'] } }));
  assert.equal(store.get().asks.length, 1);
  assert.equal(hero().summary.headline, 'did it');
});

test('a card cleared with no replacement is just resolved', () => {
  seed([perm('p1'), card('s1', 100)], 1);
  store.resolveAsk('card:s1:100');
  assert.deepEqual(ids(), ['p1']);
  assert.equal(store.get().queueIndex, 0);
});

test('pushAsk keeps the cards behind a permission that arrives later, and the hero by id', () => {
  const c = card('s1', 100);
  seed([perm('p1'), c], 1);
  store.pushAsk(perm('p2', { createdTs: 500 }));
  assert.deepEqual(ids(), ['p1', 'p2', 'card:s1:100']);
  assert.equal(hero(), c, 'the cursor stayed on the card it was on');
});

test('pushAsk of a known id changes nothing', () => {
  const c = card('s1', 100);
  seed([c], 0);
  store.pushAsk(card('s1', 100, { loud: false }));
  assert.equal(store.get().asks[0], c);
  assert.equal(store.get().asks.length, 1);
});

test('queue.sync with cards does not duplicate them', () => {
  seed([], 0);
  const c = card('s1', 100);
  store.reconcileAsks([c]);
  store.reconcileAsks([card('s1', 100)]);
  assert.deepEqual(ids(), ['card:s1:100']);
});

test('queue.sync orders cards among the rest and keeps the hero by id', () => {
  const q = question('q1', { createdTs: 10 });
  seed([q], 0);
  store.reconcileAsks([
    card('u', 400, { tag: 'update', loud: false }),
    card('a', 200),
    q,
    perm('p1', { createdTs: 20 }),
    card('b', 100),
  ]);
  assert.deepEqual(ids(), ['q1', 'p1', 'card:b:100', 'card:a:200', 'card:u:400']);
  assert.equal(hero(), q);
});

test('queue.sync keeps the cursor on a card that moves', () => {
  seed([card('s1', 200)], 0);
  store.reconcileAsks([card('s0', 100), card('s1', 200)]);
  assert.deepEqual(ids(), ['card:s0:100', 'card:s1:200']);
  assert.equal(hero().id, 'card:s1:200');
});

test('queue.sync drops a card the service replaced while the panel was away', () => {
  seed([perm('p1'), card('s1', 100)], 1);
  store.reconcileAsks([perm('p1'), card('s1', 300)]);
  assert.deepEqual(ids(), ['p1', 'card:s1:300']);
  assert.equal(hero().id, 'card:s1:300');
});

test('queue.sync moves the cursor to the new card of a hero session replaced while away', () => {
  // The new s1 card sorts after s2, so the old numeric position (1) would land
  // on a different session's card.
  seed([perm('p1'), card('s1', 100), card('s2', 200)], 1);
  assert.equal(hero().sessionId, 's1');
  store.update({ queueAnswering: true, queueChoice: 1 });
  store.reconcileAsks([perm('p1'), card('s2', 200), card('s1', 300)]);
  assert.deepEqual(ids(), ['p1', 'card:s2:200', 'card:s1:300']);
  assert.equal(hero().sessionId, 's1');
  assert.equal(hero().id, 'card:s1:300');
  assert.equal(store.get().queueIndex, 2);
  assert.equal(store.get().queueAnswering, false, 'the hero changed, so nothing half-answered carries over');
});

test('queue.sync with the hero card gone and no replacement falls to the old position', () => {
  seed([card('s1', 100), card('s2', 200), card('s3', 300)], 1);
  store.reconcileAsks([card('s1', 100), card('s3', 300)]);
  assert.deepEqual(ids(), ['card:s1:100', 'card:s3:300']);
  assert.equal(hero().id, 'card:s3:300', 'the next one slides in');
});

test('queue.sync carries a card going quiet that the panel missed', () => {
  seed([card('s1', 100)], 0);
  store.reconcileAsks([card('s1', 100, { loud: false })]);
  assert.equal(store.get().asks.length, 1);
  assert.equal(store.get().asks[0].loud, false);
  assert.equal(loudCount(store.get().asks), 0);
});

test('queue.sync with the same cards leaves the queue as it was', () => {
  const c = card('s1', 100);
  seed([c], 0);
  store.update({ queueAnswering: true, queueChoice: 1 });
  store.reconcileAsks([card('s1', 100)]);
  assert.equal(store.get().asks[0], c, 'same object, not a replaced copy');
  assert.equal(store.get().queueAnswering, true);
});

test('a clear ahead of the hero leaves the hero where it is', () => {
  seed([card('A', 100), card('B', 200), card('C', 300)], 1);
  assert.equal(hero().sessionId, 'B');
  store.resolveAsk('card:A:100');
  assert.deepEqual(ids(), ['card:B:200', 'card:C:300']);
  assert.equal(hero().sessionId, 'B', 'a background clear must not change what the owner is looking at');
  assert.equal(store.get().queueIndex, 0);
});

test('a clear behind the hero leaves the hero where it is', () => {
  seed([card('A', 100), card('B', 200), card('C', 300)], 1);
  store.resolveAsk('card:C:300');
  assert.equal(hero().sessionId, 'B');
  assert.equal(store.get().queueIndex, 1);
});

test('clearing the hero itself slides the next one in', () => {
  seed([card('A', 100), card('B', 200), card('C', 300)], 1);
  store.resolveAsk('card:B:200');
  assert.deepEqual(ids(), ['card:A:100', 'card:C:300']);
  assert.equal(hero().sessionId, 'C');
  assert.equal(store.get().queueIndex, 1);
});

test('clearing the last item as hero lands on the one before it', () => {
  seed([card('A', 100), card('B', 200)], 1);
  store.resolveAsk('card:B:200');
  assert.equal(hero().sessionId, 'A');
  assert.equal(store.get().queueIndex, 0);
});

test('a clear ahead of the hero keeps a question being answered open; clearing the hero closes it', () => {
  const q = question('q1');
  seed([perm('p1'), q], 1);
  store.update({ queueAnswering: true, queueChoice: 1, queueAnswers: [[0]] });
  store.resolveAsk('p1');
  assert.equal(hero(), q);
  assert.equal(store.get().queueAnswering, true, 'someone else\'s ask clearing is not this question\'s business');
  assert.equal(store.get().queueChoice, 1);
  store.resolveAsk('q1');
  assert.equal(store.get().queueAnswering, false);
  assert.deepEqual(store.get().queueAnswers, []);
});

test('resolving the armed ask disarms it', () => {
  seed([perm('p1'), perm('p2')], 0);
  store.update({ armed: { id: 'p1', expires: Date.now() + 5000 } });
  store.resolveAsk('p2');
  assert.ok(store.get().armed, 'another ask clearing leaves the arm alone');
  store.resolveAsk('p1');
  assert.equal(store.get().armed, null);
});

test('an expired notice ageing out ahead of the hero leaves the hero where it is', () => {
  const stale = perm('stale', { expired: true, expiredTs: 1 });
  seed([stale, card('A', 100), card('B', 200), card('C', 300)], 2);
  assert.equal(hero().sessionId, 'B');
  store.sweepExpired(1000);   // expiredTs 1 is long past any cutoff
  assert.deepEqual(ids(), ['card:A:100', 'card:B:200', 'card:C:300']);
  assert.equal(hero().sessionId, 'B');
  assert.equal(store.get().queueIndex, 1);
});

test('an expired hero ageing out slides the next one in', () => {
  const stale = perm('stale', { expired: true, expiredTs: 1 });
  seed([stale, card('s1', 100), card('s2', 200)], 0);
  store.sweepExpired(1000);
  assert.deepEqual(ids(), ['card:s1:100', 'card:s2:200']);
  assert.equal(hero().sessionId, 's1');
});

test('replySent: a reply counts as sent only when the Mac took it (the card clears on exactly these)', () => {
  for (const d of ['wake', 'next-tool', 'answer']) assert.equal(replySent(d), true, d);
  for (const d of ['cannot-wake', 'unknown-session', 'answer-on-panel', 'delivered', 'failed', '', null, undefined]) {
    assert.equal(replySent(d), false, String(d));
  }
});

// ---- the ambient screen and the permission screen count what needs the owner --

test('ambientQueue: the number is what waits, the alarm is only what is loud', () => {
  assert.deepEqual(ambientQueue([]), { count: 0, alarmed: false });
  // A lone UPDATE card is a note, not a wait.
  assert.deepEqual(ambientQueue([card('u', 5, { tag: 'update', loud: false })]), { count: 0, alarmed: false });
  // A quiet ASKING card waits on the owner but no longer rings.
  assert.deepEqual(ambientQueue([card('a', 5, { loud: false })]), { count: 1, alarmed: false });
  // A loud one rings; the number is everything waiting, quiet ASKING cards included.
  assert.deepEqual(
    ambientQueue([perm('p'), card('a', 5, { loud: false }), card('b', 6, { tag: 'update', loud: false })]),
    { count: 2, alarmed: true },
  );
  assert.deepEqual(ambientQueue([card('e', 5, { tag: 'error' })]), { count: 1, alarmed: true });
});

test('ambientQueue: an expired notice waits on the terminal, not on the owner', () => {
  assert.deepEqual(ambientQueue([perm('p', { expired: true })]), { count: 0, alarmed: false });
});

test('blockingCount counts the permissions, questions and plans, never a card', () => {
  assert.equal(blockingCount([]), 0);
  assert.equal(blockingCount([perm('p'), question('q'), card('a', 5), card('b', 6, { tag: 'update', loud: false })]), 2);
  assert.equal(blockingCount([card('a', 5)]), 0);
});

// ---- the hero changing under the owner (the input guard's trigger) ---------------

const heroIdNow = () => { const h = hero(); return h ? h.id : null; };

test('a replaced hero card hands the cursor to its successor: the hero changed', () => {
  const old = card('s1', 5);
  seed([old, card('s2', 6)]);
  const before = heroIdNow();
  store.upsertCard(card('s1', 99));
  assert.equal(hero().id, 'card:s1:99', 'the cursor followed the replacement');
  assert.equal(heroChanged(before, heroIdNow(), 'queue'), true, 'a CLEAR meant for the old card must be guarded');
});

test('a hero card clearing in the background drops the cursor on a permission: the hero changed', () => {
  const p = perm('p');
  const c = card('s1', 5);
  seed([p, c], 1);
  const before = heroIdNow();
  store.resolveAsk(c.id);
  assert.equal(heroIdNow(), 'p');
  assert.equal(heroChanged(before, heroIdNow(), 'queue'), true, 'a SWITCH press must not become ALLOW');
});

test('a card landing or clearing elsewhere in the queue leaves the hero, and the guard, alone', () => {
  seed([perm('p'), card('s1', 5)], 0);
  let before = heroIdNow();
  store.upsertCard(card('s2', 9));
  assert.equal(heroChanged(before, heroIdNow(), 'queue'), false);
  before = heroIdNow();
  store.resolveAsk('card:s2:9');
  assert.equal(heroChanged(before, heroIdNow(), 'queue'), false);
});

// ---- the dial on a card: its buttons, then the neighbouring asks ----------------

test("a card's buttons are SWITCH, REPLY, CLEAR, and a card no one has turned to shows SWITCH", () => {
  const a = card('s1', 1);
  assert.deepEqual(CARD_CHIPS, ['switch', 'reply', 'clear']);
  assert.equal(cardChipOf(null, a), 0);
  assert.equal(cardChipOf({ id: a.id, chip: 2 }, a), 2);
  assert.equal(cardChipOf({ id: 'card:other:9', chip: 2 }, a), 0, 'a pick on another card never carries over');
});

test('turning on a lone card walks SWITCH, REPLY, CLEAR and stops at each end', () => {
  const a = card('s1', 1);
  let at = { queueIndex: 0, sel: null };
  const turn = (dir) => { at = queueDialStep([a], at.queueIndex, at.sel, dir); return cardChipOf(at.sel, a); };
  assert.equal(turn(1), 1);
  assert.equal(turn(1), 2);
  assert.equal(turn(1), 2, 'past CLEAR with nothing after it stays on CLEAR');
  assert.equal(turn(-1), 1);
  assert.equal(turn(-1), 0);
  assert.equal(turn(-1), 0, 'before SWITCH with nothing ahead stays on SWITCH');
  assert.equal(at.queueIndex, 0);
});

test("turning past CLEAR goes to the next ask, on SWITCH if it's a card", () => {
  const a = card('s1', 1);
  const b = card('s2', 2);
  const step = queueDialStep([a, b], 0, { id: a.id, chip: 2 }, 1);
  assert.equal(step.queueIndex, 1);
  assert.equal(cardChipOf(step.sel, b), 0);
});

test("turning back past SWITCH goes to the ask before, on its CLEAR if it's a card", () => {
  const a = card('s1', 1);
  const b = card('s2', 2);
  const step = queueDialStep([a, b], 1, { id: b.id, chip: 0 }, -1);
  assert.equal(step.queueIndex, 0);
  assert.equal(cardChipOf(step.sel, a), 2);
});

test('on a permission the dial moves between asks as before', () => {
  const p = perm('p1');
  const a = card('s1', 1);
  assert.deepEqual(queueDialStep([p, a], 0, null, 1).queueIndex, 1);
  const back = queueDialStep([p, a], 1, { id: a.id, chip: 0 }, -1);
  assert.equal(back.queueIndex, 0);
  assert.equal(back.sel, null, 'a permission has no buttons to pick');
});
