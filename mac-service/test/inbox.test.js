import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createInbox, inboxStorage, LOUD_MS, ENDED_UPDATE_TTL_MS, SUMMARY_MATCH_MS, SUMMARY_LATE_MS,
} from '../src/inbox.js';
import { excerptOf } from '../src/turn-tag.js';

// A fake clock the tests move by hand: the module owns no timers, so nothing
// here waits on real time.
let t;
let events;
let writes;
let loudCalls;
const now = () => t;

beforeEach(() => {
  t = 1_000_000;
  events = [];
  writes = [];
  loudCalls = [];
});

function make(extra = {}) {
  return createInbox({
    emit: (method, payload) => events.push([method, payload]),
    now,
    write: (v) => writes.push(v),
    onLoud: (card) => loudCalls.push(card),
    ...extra,
  });
}

function turn(sessionId, tag, extra = {}) {
  return {
    sessionId,
    sessionName: `name-${sessionId}`,
    host: 'Terminal',
    tag,
    text: `closing words for ${sessionId}`,
    intent: 'fix the thing',
    stoppedTs: t,
    ...extra,
  };
}

const methods = () => events.map(([m]) => m);

const cardFixture = {
  kind: 'card',
  id: 'card:s9:900000',
  sessionId: 's9',
  sessionName: 'old one',
  host: 'Terminal',
  tag: 'asking',
  text: 'Ship it?',
  excerpt: 'Ship it?',
  intent: 'ship',
  createdTs: 900_000,
  stoppedTs: 900_000,
  loud: false,
  loudUntil: 0,
  endedTs: null,
  summary: null,
};

test('the constants are the agreed ones', () => {
  assert.equal(LOUD_MS, 600_000);
  assert.equal(ENDED_UPDATE_TTL_MS, 7_200_000);
  assert.equal(SUMMARY_MATCH_MS, 120_000);
  assert.equal(SUMMARY_LATE_MS, 15_000);
});

test('a posted card has the whole shape and is announced', () => {
  const ib = make();
  const card = ib.post(turn('s1', 'asking', { text: 'Done.\n\nShip `it`?' }));
  assert.deepEqual(card, {
    kind: 'card',
    id: `card:s1:${t}`,
    sessionId: 's1',
    sessionName: 'name-s1',
    host: 'Terminal',
    tag: 'asking',
    text: 'Done.\n\nShip `it`?',
    excerpt: 'Ship it?',
    intent: 'fix the thing',
    createdTs: t,
    stoppedTs: t,
    loud: true,
    loudUntil: t + LOUD_MS,
    endedTs: null,
    summary: null,
    prevStoppedTs: null,
  });
  assert.deepEqual(events, [['claude.card.posted', card]]);
  assert.deepEqual(ib.list(), [card]);
});

test('one card per session; a newer turn replaces it', () => {
  const ib = make();
  ib.post(turn('s1', 'update', { text: 'first' }));
  t += 5000;
  const second = ib.post(turn('s1', 'update', { text: 'second', stoppedTs: t }));
  assert.equal(ib.list().length, 1);
  assert.equal(ib.list()[0].text, 'second');
  assert.equal(ib.list()[0].id, second.id);
  // The panel drops the older card by sessionId itself; a cleared event in
  // between would break its cursor-following, so replacing only posts.
  assert.deepEqual(methods(), ['claude.card.posted', 'claude.card.posted']);
});

test('cards of different sessions sit side by side', () => {
  const ib = make();
  ib.post(turn('s1', 'update'));
  ib.post(turn('s2', 'asking'));
  assert.deepEqual(ib.list().map((c) => c.sessionId).sort(), ['s1', 's2']);
});

test('asking and error are loud for 10 minutes, update never', () => {
  const ib = make();
  const a = ib.post(turn('s1', 'asking'));
  assert.equal(a.loud, true);
  assert.equal(a.loudUntil, t + 600000);
  const e = ib.post(turn('s3', 'error'));
  assert.equal(e.loud, true);
  const u = ib.post(turn('s2', 'update'));
  assert.equal(u.loud, false);
  assert.equal(u.loudUntil, 0);
  assert.deepEqual(loudCalls.map((c) => c.sessionId), ['s1', 's3'], 'onLoud only for loud posts');

  t += 600001;
  ib.tick();
  for (const c of ib.list()) assert.equal(c.loud, false, `${c.sessionId} went quiet`);
  assert.equal(loudCalls.length, 2, 'going quiet never calls onLoud');
});

test('going quiet re-sends the card once, with loud false', () => {
  const ib = make();
  ib.post(turn('s1', 'asking'));
  events.length = 0;

  t += 599_999;
  ib.tick();
  assert.deepEqual(events, [], 'still loud one millisecond before the end');

  t += 1;
  ib.tick();
  assert.equal(events.length, 1);
  assert.equal(events[0][0], 'claude.card.posted');
  assert.equal(events[0][1].loud, false);
  assert.equal(events[0][1].sessionId, 's1');

  ib.tick();
  assert.equal(events.length, 1, 'a quiet card is not re-sent on every tick');
});

test('a card already announced is not changed behind the receiver\'s back', () => {
  const ib = make();
  const posted = ib.post(turn('s1', 'asking'));
  t += LOUD_MS + 1;
  ib.tick();
  assert.equal(posted.loud, true, 'the earlier snapshot is untouched');
  assert.equal(ib.list()[0].loud, false);
});

test('a card of the same session lets loud start over', () => {
  const ib = make();
  ib.post(turn('s1', 'asking'));
  t += LOUD_MS + 1;
  ib.tick();
  const again = ib.post(turn('s1', 'asking', { stoppedTs: t }));
  assert.equal(again.loud, true);
  assert.equal(again.loudUntil, t + LOUD_MS);
  assert.equal(loudCalls.length, 2);
});

test('clear and clearById say why, and report whether anything was there', () => {
  const ib = make();
  const a = ib.post(turn('s1', 'asking'));
  const b = ib.post(turn('s2', 'update'));
  events.length = 0;

  assert.equal(ib.clear('s1', 'typed'), true);
  assert.deepEqual(events, [['claude.card.cleared', { id: a.id, sessionId: 's1', reason: 'typed' }]]);
  assert.deepEqual(ib.list().map((c) => c.sessionId), ['s2']);

  assert.equal(ib.clear('s1', 'typed'), false, 'already gone');
  assert.equal(ib.clearById('card:nope:1', 'x'), false);
  assert.equal(events.length, 1, 'nothing announced for a card that was not there');

  assert.equal(ib.clearById(b.id, 'panel'), true);
  assert.deepEqual(events[1], ['claude.card.cleared', { id: b.id, sessionId: 's2', reason: 'panel' }]);
  assert.deepEqual(ib.list(), []);
});

test('session end: asking goes at once, update stays 2 hours', () => {
  const ib = make();
  const asking = ib.post(turn('s1', 'asking'));
  const update = ib.post(turn('s2', 'update'));
  events.length = 0;

  ib.onSessionEnd('s1');
  assert.deepEqual(events, [['claude.card.cleared', { id: asking.id, sessionId: 's1', reason: 'ended' }]]);
  assert.deepEqual(ib.list().map((c) => c.sessionId), ['s2']);

  ib.onSessionEnd('s2');
  assert.equal(ib.list()[0].endedTs, t);
  assert.equal(events.length, 1, 'an update card stays put');

  t += ENDED_UPDATE_TTL_MS - 1;
  ib.tick();
  assert.equal(ib.list().length, 1, 'still there just before two hours');

  t += 2;
  ib.tick();
  assert.deepEqual(ib.list(), []);
  assert.deepEqual(events[1], ['claude.card.cleared', { id: update.id, sessionId: 's2', reason: 'expired' }]);
});

test('session end clears an error card too, and ignores a session with no card', () => {
  const ib = make();
  ib.post(turn('s1', 'error'));
  events.length = 0;
  ib.onSessionEnd('nobody');
  assert.deepEqual(events, []);
  ib.onSessionEnd('s1');
  assert.equal(events[0][1].reason, 'ended');
  assert.deepEqual(ib.list(), []);
});

test('an update card with no session end never expires', () => {
  const ib = make();
  ib.post(turn('s1', 'update'));
  t += 10 * ENDED_UPDATE_TTL_MS;
  ib.tick();
  assert.equal(ib.list().length, 1);
});

test('hearing a session ended twice keeps the first end time', () => {
  const ib = make();
  ib.post(turn('s1', 'update'));
  ib.onSessionEnd('s1');
  const first = ib.list()[0].endedTs;
  t += 60_000;
  ib.onSessionEnd('s1');
  assert.equal(ib.list()[0].endedTs, first);
});

test('a new turn after an ended session starts a fresh card', () => {
  const ib = make();
  ib.post(turn('s1', 'update'));
  ib.onSessionEnd('s1');
  t += 1000;
  const next = ib.post(turn('s1', 'update', { stoppedTs: t }));
  assert.equal(next.endedTs, null);
  t += ENDED_UPDATE_TTL_MS + 1;
  ib.tick();
  assert.equal(ib.list().length, 1, 'the revived session is not expired');
});

test('retireMissing ends cards whose sessions never came back', () => {
  const ib = make();
  const s1 = ib.post(turn('s1', 'asking'));
  ib.post(turn('s2', 'asking'));
  ib.post(turn('s3', 'update'));
  events.length = 0;

  ib.retireMissing(new Set(['s2']));
  assert.deepEqual(events, [['claude.card.cleared', { id: s1.id, sessionId: 's1', reason: 'ended' }]]);
  assert.deepEqual(ib.list().map((c) => c.sessionId).sort(), ['s2', 's3']);
  assert.equal(ib.list().find((c) => c.sessionId === 's3').endedTs, t, 'the update card is stamped ended');
  assert.equal(ib.list().find((c) => c.sessionId === 's2').endedTs, null);
});

test('restore: quiet past loudUntil, corrupt state reads empty', () => {
  const saved = { cards: [{ ...cardFixture, loud: true, loudUntil: t - 1 }] };
  assert.equal(createInbox({ emit() {}, now, read: () => saved }).list()[0].loud, false);
  assert.deepEqual(createInbox({ emit() {}, now, read: () => 'garbage' }).list(), []);
  assert.deepEqual(createInbox({ emit() {}, now, read: () => null }).list(), []);
  assert.deepEqual(createInbox({ emit() {}, now, read: () => ({ cards: 'nope' }) }).list(), []);
  assert.deepEqual(createInbox({ emit() {}, now, read: () => ({ cards: [null, 7, 'x', {}] }) }).list(), []);
});

test('restore: a card still inside its loud window stays loud, then tick quietens it', () => {
  const saved = { cards: [{ ...cardFixture, loud: true, loudUntil: t + 1000 }] };
  const ib = make({ read: () => saved });
  assert.equal(ib.list()[0].loud, true);
  assert.deepEqual(events, [], 'restoring announces nothing; the panel asks for the list');
  assert.equal(loudCalls.length, 0, 'a restart never re-chimes');
  t += 1001;
  ib.tick();
  assert.equal(ib.list()[0].loud, false);
  assert.equal(events[0][1].loud, false);
});

test('restore: an update card whose end passed expires on the first tick', () => {
  const saved = { cards: [{ ...cardFixture, tag: 'update', endedTs: t - ENDED_UPDATE_TTL_MS - 1 }] };
  const ib = make({ read: () => saved });
  ib.tick();
  assert.deepEqual(ib.list(), []);
  assert.equal(events[0][1].reason, 'expired');
});

test('persistence: every change is written as { cards }', () => {
  const ib = make();
  const steps = [
    ['post', () => ib.post(turn('s1', 'asking'))],
    ['post another', () => ib.post(turn('s2', 'update'))],
    ['summary', () => ib.attachSummary('s2', t, { headline: 'h', bullets: [] })],
    ['session end', () => ib.onSessionEnd('s2')],
    ['clear', () => ib.clear('s1', 'x')],
    ['post again', () => { t += LOUD_MS + 1; ib.post(turn('s3', 'asking', { stoppedTs: t })); }],
    ['going quiet', () => { t += LOUD_MS + 1; ib.tick(); }],
    ['expiry', () => { t += ENDED_UPDATE_TTL_MS; ib.tick(); }],
  ];
  steps.forEach(([what, run], i) => {
    run();
    assert.equal(writes.length, i + 1, `${what} wrote once`);
    assert.deepEqual(writes.at(-1), { cards: ib.list() }, `${what} wrote the current cards`);
  });
});

test('persistence: nothing changed, nothing written', () => {
  const ib = make();
  ib.tick();
  ib.clear('nobody', 'x');
  ib.clearById('card:nobody:1', 'x');
  ib.onSessionEnd('nobody');
  ib.retireMissing(new Set());
  ib.attachSummary('nobody', t, { headline: 'h', bullets: [] });
  assert.deepEqual(writes, []);
});

test('persistence: what one inbox wrote, the next one restores', () => {
  let disk = null;
  const first = make({ write: (v) => { disk = JSON.parse(JSON.stringify(v)); } });
  first.post(turn('s1', 'asking'));
  first.post(turn('s2', 'update'));
  const second = make({ read: () => disk });
  assert.deepEqual(second.list(), first.list());
});

test('attachSummary only lands on the same turn', () => {
  const ib = make();
  ib.post(turn('s1', 'asking'));
  events.length = 0;
  loudCalls.length = 0;

  assert.equal(ib.attachSummary('s1', t - 300000, { headline: 'old', bullets: ['x'] }), false);
  assert.equal(ib.list()[0].summary, null);
  assert.deepEqual(events, []);

  assert.equal(ib.attachSummary('s1', t + 5000, { headline: 'h', bullets: ['b'] }), true);
  assert.deepEqual(ib.list()[0].summary, { headline: 'h', bullets: ['b'] });
  assert.deepEqual(methods(), ['claude.card.posted']);
  assert.deepEqual(events[0][1].summary, { headline: 'h', bullets: ['b'] });
  assert.equal(events[0][1].loud, true, 'a summary arriving leaves the loudness as it was');
  assert.equal(loudCalls.length, 0, 'a summary never chimes');
});

test('attachSummary: a first card matches a summary up to 120 s before its stop and 15 s after', () => {
  const ib = make();
  ib.post(turn('s1', 'update'));
  const s = { headline: 'h', bullets: [] };
  assert.equal(ib.attachSummary('s1', t + SUMMARY_LATE_MS, s), true);
  assert.equal(ib.attachSummary('s1', t - SUMMARY_MATCH_MS + 1, s), true);
  assert.equal(ib.attachSummary('s1', t + SUMMARY_LATE_MS + 1, s), false, 'a summary cannot be written for a turn that has not ended yet');
  assert.equal(ib.attachSummary('s1', t - SUMMARY_MATCH_MS, s), false);
  assert.equal(ib.attachSummary('s1', t - SUMMARY_MATCH_MS - 1, s), false);
});

test('attachSummary: a summary for the card\'s own turn lands; one 20 s after its stop does not', () => {
  const ib = make();
  ib.post(turn('s1', 'asking'));
  const s = { headline: 'h', bullets: ['b'] };
  assert.equal(ib.attachSummary('s1', t + 20_000, s), false);
  assert.equal(ib.list()[0].summary, null);
  assert.equal(ib.attachSummary('s1', t - 2000, s), true);
  assert.deepEqual(ib.list()[0].summary, { headline: 'h', bullets: ['b'] });
});

test('attachSummary: the previous turn\'s summary never lands on the newer card', () => {
  const ib = make();
  const first = t;
  ib.post(turn('s1', 'update', { stoppedTs: first, text: 'turn N' }));
  t += 60_000;
  const next = ib.post(turn('s1', 'asking', { stoppedTs: t, text: 'Ship it?' }));
  assert.equal(next.prevStoppedTs, first, 'the new card remembers when the one it replaced stopped');
  events.length = 0;
  const stale = { headline: 'turn N digest', bullets: ['x'] };
  // within 120 s of the new card's stop, but it is turn N's: it ended at `first`
  assert.equal(ib.attachSummary('s1', first, stale), false);
  assert.equal(ib.attachSummary('s1', first - 5000, stale), false);
  assert.equal(ib.list()[0].summary, null, 'the question is still what the card shows');
  assert.deepEqual(events, []);
  // the new turn's own digest does land
  assert.equal(ib.attachSummary('s1', t - 2000, { headline: 'turn N+1 digest', bullets: [] }), true);
  assert.equal(ib.list()[0].summary.headline, 'turn N+1 digest');
});

test('attachSummary: the window opens after the previous stop even when the stops are close', () => {
  const ib = make();
  const first = t;
  ib.post(turn('s1', 'update', { stoppedTs: first }));
  t += 30_000;
  ib.post(turn('s1', 'update', { stoppedTs: t }));
  const s = { headline: 'h', bullets: [] };
  assert.equal(ib.attachSummary('s1', first, s), false, 'exactly the previous stop is the previous turn');
  assert.equal(ib.attachSummary('s1', first + 1, s), true);
});

test('attachSummary: after the owner typed (card cleared), turn N\'s digest still cannot land on turn N+1\'s card', () => {
  const ib = make();
  const first = t;
  ib.post(turn('s1', 'update', { stoppedTs: first }));
  ib.clear('s1', 'typed');
  t += 60_000;
  const next = ib.post(turn('s1', 'asking', { stoppedTs: t, text: 'Ship it?' }));
  assert.equal(next.prevStoppedTs, first, 'the cleared card\'s turn is remembered without the card');
  events.length = 0;
  assert.equal(ib.attachSummary('s1', first, { headline: 'turn N digest', bullets: [] }), false);
  assert.equal(ib.attachSummary('s1', first - 3000, { headline: 'turn N digest', bullets: [] }), false);
  assert.equal(ib.list()[0].summary, null, 'the question is still what the card shows');
  assert.deepEqual(events, []);
});

test('attachSummary: a turn held back by background work (noteStop, no post) is still an earlier turn', () => {
  const ib = make();
  const heldBack = t;
  ib.noteStop('s1', heldBack);              // an UPDATE turn that posted no card
  assert.deepEqual(ib.list(), []);
  t += 45_000;
  const asking = ib.post(turn('s1', 'asking', { stoppedTs: t, text: 'Ship it?' }));
  assert.equal(asking.prevStoppedTs, heldBack);
  assert.equal(ib.attachSummary('s1', heldBack, { headline: 'held-back digest', bullets: [] }), false);
  assert.equal(ib.attachSummary('s1', heldBack + 1000, { headline: 'held-back digest', bullets: [] }), true,
    'a digest that ended after the held-back turn belongs to this one');
});

test('attachSummary: the card\'s own turn still matches after a clear and after a held-back turn', () => {
  const ib = make();
  const first = t;
  ib.post(turn('s1', 'update', { stoppedTs: first }));
  ib.clear('s1', 'typed');
  t += 30_000;
  ib.noteStop('s1', t);                      // held back
  t += 30_000;
  ib.post(turn('s1', 'asking', { stoppedTs: t }));
  const own = { headline: 'this turn', bullets: ['b'] };
  assert.equal(ib.attachSummary('s1', t - 2000, own), true);
  assert.equal(ib.list()[0].summary.headline, 'this turn');
});

test('noteStop: the stop before the card is what counts, not the card\'s own', () => {
  const ib = make();
  const a = t;
  ib.noteStop('s1', a);
  t += 20_000;
  const b = t;
  ib.noteStop('s1', b);
  t += 20_000;
  const c = ib.post(turn('s1', 'update', { stoppedTs: t }));
  assert.equal(c.prevStoppedTs, b, 'the latest earlier stop');
  // noting the same stop again, or a non-time, changes nothing
  ib.noteStop('s1', t);
  ib.noteStop('s1', undefined);
  ib.noteStop('s1', 'soon');
  t += 20_000;
  assert.equal(ib.post(turn('s1', 'update', { stoppedTs: t })).prevStoppedTs, c.stoppedTs);
  assert.equal(ib.post(turn('s2', 'update', { stoppedTs: t })).prevStoppedTs, null, 'sessions do not share stops');
  // a stop that is not earlier than the card's own is not "before" it
  ib.noteStop('s3', t + 5000);
  assert.equal(ib.post(turn('s3', 'update', { stoppedTs: t })).prevStoppedTs, null);
});

test('noteStop: a restored card seeds the memory, so the first post after a restart knows the turn before', () => {
  const saved = { cards: [{ ...cardFixture, id: 'card:s9:900000', stoppedTs: 900_000 }] };
  const ib = make({ read: () => saved });
  ib.clear('s9', 'typed');
  const next = ib.post(turn('s9', 'asking', { stoppedTs: 960_000 }));
  assert.equal(next.prevStoppedTs, 900_000);
  assert.equal(ib.attachSummary('s9', 900_000, { headline: 'old', bullets: [] }), false);
});

test('noteStop writes nothing and announces nothing', () => {
  const ib = make();
  ib.noteStop('s1', t);
  assert.deepEqual(events, []);
  assert.deepEqual(writes, []);
});

test('post: prevStoppedTs is the replaced card\'s stop, and null for a session\'s first card', () => {
  const ib = make();
  assert.equal(ib.post(turn('s1', 'update')).prevStoppedTs, null);
  assert.equal(ib.post(turn('s2', 'update')).prevStoppedTs, null, 'another session has its own history');
  const first = t;
  t += 10_000;
  assert.equal(ib.post(turn('s1', 'update', { stoppedTs: t })).prevStoppedTs, first);
  const second = t;
  t += 10_000;
  assert.equal(ib.post(turn('s1', 'update', { stoppedTs: t })).prevStoppedTs, second, 'only the card just replaced');
});

test('persistence: prevStoppedTs is kept with the card, and a card saved without it still restores', () => {
  let disk = null;
  const first = make({ write: (v) => { disk = JSON.parse(JSON.stringify(v)); } });
  first.post(turn('s1', 'update'));
  t += 60_000;
  first.post(turn('s1', 'asking', { stoppedTs: t }));
  const restored = make({ read: () => disk });
  assert.equal(restored.list()[0].prevStoppedTs, first.list()[0].prevStoppedTs);
  assert.equal(restored.attachSummary('s1', 1_000_000, { headline: 'old', bullets: [] }), false, 'the previous turn is still refused after a restart');

  const { prevStoppedTs, ...legacy } = disk.cards[0];
  const old = make({ read: () => ({ cards: [legacy] }) });
  assert.equal(old.list()[0].prevStoppedTs, null);
  assert.equal(old.attachSummary('s1', t - 2000, { headline: 'h', bullets: [] }), true);
});

test('attachSummary: no card, no turn time, or no headline means no summary', () => {
  const ib = make();
  assert.equal(ib.attachSummary('s1', t, { headline: 'h', bullets: [] }), false, 'no card');
  ib.post(turn('s1', 'update'));
  assert.equal(ib.attachSummary('s1', undefined, { headline: 'h', bullets: [] }), false);
  assert.equal(ib.attachSummary('s1', 'soon', { headline: 'h', bullets: [] }), false);
  assert.equal(ib.attachSummary('s1', t, { headline: '', bullets: [] }), false);
  assert.equal(ib.attachSummary('s1', t, null), false);
  assert.equal(ib.list()[0].summary, null);
});

test('attachSummary: a newer turn replaces the card and its summary with it', () => {
  const ib = make();
  ib.post(turn('s1', 'update'));
  ib.attachSummary('s1', t, { headline: 'h', bullets: ['b'] });
  t += 60_000;
  ib.post(turn('s1', 'update', { stoppedTs: t }));
  assert.equal(ib.list()[0].summary, null);
});

test('text is clipped to 8000 and the excerpt is computed', () => {
  const ib = make();
  const long = `${'x'.repeat(9000)}\n\nWant me to ship \`it\`?`;
  const card = ib.post(turn('s1', 'asking', { text: long }));
  assert.equal(card.text.length, 8001);
  assert.ok(card.text.endsWith('…'));
  // The closing paragraph is past the clip, so the excerpt reads the full text.
  assert.equal(card.excerpt, excerptOf(long));
  assert.equal(card.excerpt, 'Want me to ship it?');
});

test('a turn with no message still gets a card with a plain excerpt', () => {
  const ib = make();
  const card = ib.post(turn('s1', 'update', { text: undefined }));
  assert.equal(card.text, '');
  assert.equal(card.excerpt, 'finished with no message');
});

test('a post with no stoppedTs is stamped now; an odd tag is just an update', () => {
  const ib = make();
  const card = ib.post(turn('s1', 'whatever', { stoppedTs: undefined }));
  assert.equal(card.stoppedTs, t);
  assert.equal(card.id, `card:s1:${t}`);
  assert.equal(card.tag, 'update');
  assert.equal(card.loud, false);
});

test('a throwing onLoud does not lose the card or its write', () => {
  const ib = make({ onLoud() { throw new Error('afplay missing'); } });
  const card = ib.post(turn('s1', 'asking'));
  assert.equal(card.sessionId, 's1');
  assert.equal(writes.length, 1);
});

test('storage: in mock mode the inbox gets none, so demo cards never reach the live file', () => {
  const calls = [];
  const storage = inboxStorage({
    mock: true,
    readState: (name) => { calls.push(['read', name]); return { cards: [] }; },
    writeState: (...args) => { calls.push(['write', ...args]); },
  });
  assert.deepEqual(Object.keys(storage), [], 'no read, no write');
  // Wired into a real inbox the way index.js does, posting persists nothing.
  const inbox = createInbox({ emit: () => {}, now, ...storage });
  inbox.post({ sessionId: 'demo', sessionName: 'demo', tag: 'asking', text: 'Which one?' });
  assert.equal(inbox.list().length, 1, 'the card is held in memory');
  assert.deepEqual(calls, [], 'nothing was read from or written to the state dir');
});

test('storage: live mode reads and writes the inbox file, owner-only', () => {
  const calls = [];
  const storage = inboxStorage({
    mock: false,
    readState: (name) => { calls.push(['read', name]); return { cards: [] }; },
    writeState: (...args) => { calls.push(['write', ...args]); },
  });
  const inbox = createInbox({ emit: () => {}, now, ...storage });
  inbox.post({ sessionId: 's1', sessionName: 'one', tag: 'update', text: 'Done.' });
  assert.deepEqual(calls[0], ['read', 'inbox']);
  const [, name, value, opts] = calls.find((c) => c[0] === 'write');
  assert.equal(name, 'inbox');
  assert.equal(value.cards.length, 1);
  assert.deepEqual(opts, { mode: 0o600 });
});
