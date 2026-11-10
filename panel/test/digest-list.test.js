// The digest as the first card on the sessions screen (Task 14): where it sits in the grid, how the
// cursor reaches it and leaves it, and that with no card the screen is exactly what it was. The cursor
// is selectedIndex (always a session index, as before) plus the flag onDigestCard; only the functions
// here read the flag, so applySnapshot, watchTarget and the other readers of selectedIndex are unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { renderList, cardSelected, listDial, cardRoute, leaveList } from '../src/screens/session-list.js';
import { withDigest } from '../src/digest-input.js';
import { watchTarget } from '../src/screens/helpers.js';
import * as store from '../src/store.js';
import { now } from '../src/clock.js';
import { listState, noClock, guardCases, guardOutputs } from './fixtures/list-state.js';

// A copy of digest.test.js's DigestCard factory: the facts-only milestone's card, no summary.
const card = (over = {}) => ({
  sessionId: 'a', title: 'Recorder reopen', project: 'car-thing', ended: false,
  lastTurnTs: now() - 12 * 60e3,
  facts: { turns: 3, files: 1, commits: 1, prs: 1, tests: { passed: 14, failed: 0, runs: 1 }, agents: { finished: 0, running: 0 } },
  lines: [], lastReply: '', summary: null, behindTurns: 0,
  ...over,
});
// A facts-only Digest holding `cards`.
const digestOf = (cards) => ({
  updatedTs: now(), windowHours: 24,
  summarizer: { state: 'off', model: null, lastOkTs: null },
  totals: { sessions: 1, turns: 3, commits: 1, prs: 1, testRuns: 1 },
  cards,
});
const withCard = (over = {}) => ({ ...listState(0), digest: digestOf([card()]), ...over });
// renderList keeps the scroll position between calls; an empty list puts it back to 0.
const reset = () => renderList({ ...listState(0), sessions: [] });

const shift = (html) => Number(/translateX\(-(\d+)px\)/.exec(html)[1]);
const selectedTile = (html) => { const m = /class="tile [^"]*selected[^"]*" data-action="open" data-id="(\w)"/.exec(html); return m ? m[1] : null; };
const offTiles = (html) => [...html.matchAll(/class="tile ([^"]*)" data-action="open" data-id="(\w)"/g)].filter((m) => m[1].split(' ').includes('off')).map((m) => m[2]).join('');
const NO_SESSIONS = 'NO SESSIONS — START CLAUDE ON YOUR MAC OR NUCBOX';

const before = JSON.parse(fs.readFileSync(new URL('./fixtures/list-before.json', import.meta.url), 'utf8'));

// ---- the brief's tests --------------------------------------------------------------------------

test('with no digest card the grid is byte-identical to before', () => {
  for (const digest of [undefined, null, digestOf([])]) for (const [key, i] of [['sel0', 0], ['sel4', 4]]) {
    reset(); assert.equal(noClock(renderList({ ...listState(i), digest })), before[key], key);
  }
});

test('the card comes first and the cursor starts on the first session; on the card, no tile is selected', () => {
  reset(); const html = renderList(withCard()), on = renderList(withCard({ onDigestCard: true }));
  assert.ok(html.indexOf('<div class="dgfirst" data-action="digest-card">') < html.indexOf('<div class="tile '));
  assert.match(html, /class="tile [^"]*selected[^"]*" data-action="open" data-id="a"/); assert.match(html, /translateX\(-0px\)/);
  assert.match(on, /class="dgfirst selected" data-action="digest-card"/); assert.doesNotMatch(on, /class="tile [^"]*selected/);
});

test('the dial: back from the first session to the card, forward to the first session, nowhere past the card', () => {
  const on = withCard({ onDigestCard: true, selectedIndex: 3 });
  assert.deepEqual([listDial(withCard(), -1), listDial(on, 1), listDial(on, -1)], [{ onDigestCard: true }, { onDigestCard: false, selectedIndex: 0 }, null]);
  assert.deepEqual([listDial(withCard({ selectedIndex: 1 }), -1), listDial(withCard({ selectedIndex: 4 }), 1)], [{ selectedIndex: 0 }, { selectedIndex: 4 }]);
  assert.deepEqual(listDial(listState(0), -1), { selectedIndex: 0 }, 'no card: as today'); assert.equal(listDial(withCard({ sessions: [] }), 1), null);
});

test('sessions start in column 1; the card scrolls out to the right and back beside the first column', () => {
  const at = (i) => shift(renderList(withCard({ selectedIndex: i })));
  reset(); assert.deepEqual([0, 1, 2, 3, 4, 2, 1].map(at), [0, 0, 380, 380, 760, 760, 0]);
  reset(); renderList(withCard({ selectedIndex: 4 })); assert.match(renderList(withCard({ onDigestCard: true })), /translateX\(-0px\)/);
  reset(); assert.match(renderList(withCard({ selectedIndex: 4 })), / off" data-action="open" data-id="a"/);
});

test('sessions coming and going leave the card selected; with none it stands alone beside the empty text', () => {
  for (const n of [5, 1, 0]) assert.equal(cardSelected(withCard({ onDigestCard: true, sessions: listState(0).sessions.slice(0, n) })), true, String(n));
  assert.match(renderList(withCard({ sessions: [] })), /class="dgfirst selected"[\s\S]*class="dgnote">NO SESSIONS — START CLAUDE/);
  assert.match(renderList({ ...listState(0), sessions: [], digest: null }), /class="empty">NO SESSIONS/);
});

// withDigest is Task 12's (digest-input.js): it also keeps the Digest list's selection (digestSel), so
// every result here carries that too.
test('a digest that loses its cards moves the cursor off the card; one that keeps them does not', () => {
  const on = withCard({ onDigestCard: true, selectedIndex: 3 }), empty = digestOf([]), full = digestOf([card()]);
  assert.deepEqual([withDigest(on, empty), withDigest(on, null), withDigest(on, full)],
    [{ digest: empty, digestSel: null, onDigestCard: false, selectedIndex: 0 }, { digest: null, digestSel: null, onDigestCard: false, selectedIndex: 0 }, { digest: full, digestSel: 'a' }]);
  assert.deepEqual(withDigest(listState(2), null), { digest: null, digestSel: null });
});

// ---- the byte-identical guard, every case ---------------------------------------------------------

test('with no card the sessions screen is byte-for-byte what it was, in every case and for every no-card digest', () => {
  assert.deepEqual(Object.keys(before.cases), Object.keys(guardCases()), 'every case has its fixture');
  assert.ok(Object.keys(before.cases).length >= 12);
  const noCard = {
    'no digest field': {}, 'digest undefined': { digest: undefined }, 'digest null': { digest: null },
    'no cards': { digest: digestOf([]) }, 'cards null': { digest: { ...digestOf([]), cards: null } },
    'only cards with no usable id': { digest: digestOf([null, 'junk', { title: 'no id' }, card({ sessionId: '' }), card({ sessionId: 7 })]) },
    'not a digest': { digest: 'junk' },
    // A flag left on with no card selects nothing: the screen still draws the session cursor.
    'the flag left on with no card': { digest: null, onDigestCard: true },
  };
  for (const [name, over] of Object.entries(noCard)) assert.deepEqual(guardOutputs(renderList, over), before, name);
});

// ---- the cursor -----------------------------------------------------------------------------------

test('the cursor starts on the first session: the store boots off the card, at session 0', () => {
  assert.equal(store.get().onDigestCard, false);
  assert.equal(store.get().selectedIndex, 0);
  const boot = withCard({ onDigestCard: store.get().onDigestCard, selectedIndex: store.get().selectedIndex });
  assert.equal(cardSelected(boot), false);
  reset(); assert.equal(selectedTile(renderList(boot)), 'a');
  assert.equal(cardRoute(boot), null, 'a press opens the first session, as today');
});

test('the dial walks card, then every session, and stops at both ends', () => {
  // From the card, turning forward one step at a time, then back: the cursor after each step.
  const walk = (state, dirs) => dirs.map((dir) => {
    const f = listDial(state, dir);
    if (f) state = { ...state, ...f };
    return cardSelected(state) ? 'card' : state.selectedIndex;
  });
  const start = withCard({ onDigestCard: true, selectedIndex: 2 });
  assert.deepEqual(walk(start, [-1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1, -1, -1]),
    ['card', 0, 1, 2, 3, 4, 4, 3, 2, 1, 0, 'card', 'card', 'card']);
  // The same walk with no card is today's: it stops at session 0.
  assert.deepEqual(walk(listState(0), [-1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1]), [0, 1, 2, 3, 4, 4, 3, 2, 1, 0, 0]);
});

test('with no card the dial is today\'s for every cursor and step, NucBox tiles included', () => {
  const today = (state, dir) => { const m = state.sessions.length; return m ? { selectedIndex: Math.max(0, Math.min(m - 1, state.selectedIndex + dir)) } : null; };
  for (const digest of [undefined, null, digestOf([]), { cards: null }, 'junk']) {
    for (const n of [0, 1, 2, 5]) for (let i = 0; i < Math.max(1, n); i++) for (const dir of [-1, 1]) {
      const state = { ...listState(i), sessions: listState(0).sessions.slice(0, n), digest };
      assert.deepEqual(listDial(state, dir), today(state, dir), [String(digest), n, i, dir].join(' '));
      // A flag left on with no card changes nothing.
      assert.deepEqual(listDial({ ...state, onDigestCard: true }, dir), today(state, dir));
    }
  }
});

test('the dial with a card: exact values at both edges and with the card alone', () => {
  assert.deepEqual(listDial(withCard({ selectedIndex: 0 }), -1), { onDigestCard: true }, 'back from the first session');
  assert.deepEqual(listDial(withCard({ selectedIndex: 0 }), 1), { selectedIndex: 1 });
  assert.deepEqual(listDial(withCard({ selectedIndex: 4 }), 1), { selectedIndex: 4 }, 'forward on the last: as today');
  assert.deepEqual(listDial(withCard({ selectedIndex: 4 }), -1), { selectedIndex: 3 });
  assert.equal(listDial(withCard({ onDigestCard: true }), -1), null, 'back on the card does nothing');
  assert.deepEqual(listDial(withCard({ onDigestCard: true, selectedIndex: 4 }), 1), { onDigestCard: false, selectedIndex: 0 }, 'forward from the card: the first session, whatever selectedIndex held');
  // A NucBox session first in the list is still "the first session".
  const nucFirst = withCard({ sessions: listState(0).sessions.slice(4) });
  assert.deepEqual(listDial(nucFirst, -1), { onDigestCard: true });
  assert.deepEqual(listDial({ ...nucFirst, onDigestCard: true }, 1), { onDigestCard: false, selectedIndex: 0 });
  // The card alone (no sessions on either machine): selected without the flag, and the dial goes nowhere.
  for (const flag of [false, true]) for (const dir of [-1, 1]) {
    const alone = withCard({ sessions: [], onDigestCard: flag });
    assert.equal(cardSelected(alone), true);
    assert.equal(listDial(alone, dir), null, flag + ' ' + dir);
  }
});

test('nothing in the cursor helpers throws on a hostile state', () => {
  const hostile = [
    withCard({ digest: { cards: [card(), null] }, selectedIndex: NaN }),
    withCard({ digest: { cards: 'junk' } }),
    withCard({ sessions: null }),
    { sessions: [], digest: digestOf([card()]) },
    { sessions: listState(0).sessions },
    {},
  ];
  for (const s of hostile) for (const dir of [-1, 1]) {
    listDial(s, dir); cardSelected(s); cardRoute(s); cardRoute(s, { action: 'digest-card' }); leaveList('digest', s);
  }
  assert.equal(cardSelected(null), false);
  assert.equal(listDial(null, 1), null);
  assert.equal(cardRoute(null), null);
  assert.equal(leaveList('digest', null), null);
  assert.equal(cardSelected(withCard({ sessions: null })), true, 'no session list: the card stands alone');
  assert.equal(listDial(withCard({ sessions: null }), -1), null);
  // Something with a length that is not a list of sessions is no sessions either.
  for (const sessions of ['abc', { length: 3 }]) {
    assert.equal(cardSelected(withCard({ sessions })), true, String(sessions));
    assert.equal(listDial(withCard({ sessions, onDigestCard: true }), 1), null, String(sessions));
  }
});

// ---- press, tap, leaving --------------------------------------------------------------------------

test('a press on the card and a tap on it go to the same place; anything else is today\'s', () => {
  const on = withCard({ onDigestCard: true, selectedIndex: 2 });
  assert.equal(cardRoute(on), '#/digest', 'a press on the card');
  assert.equal(cardRoute(withCard({ sessions: [] })), '#/digest', 'a press on the card standing alone');
  assert.equal(cardRoute(withCard({ selectedIndex: 2 })), null, 'a press on a tile opens the session, as today');
  assert.equal(cardRoute(listState(0)), null);
  assert.equal(cardRoute({ ...listState(0), onDigestCard: true }), null, 'no card: the press is today\'s');
  // A tap passes the tap (input.js: { action, id }, read off the tapped element). The card's data-action is the renderer's own.
  const tapped = /class="dgfirst[^"]*" data-action="([^"]+)"/.exec(renderList(withCard()))[1];
  assert.equal(tapped, 'digest-card');
  for (const s of [withCard(), on, withCard({ sessions: [] })]) assert.equal(cardRoute(s, { action: tapped, id: null }), cardRoute(on), 'a tap on the card, wherever the cursor is');
  // A tile's tap is not the card's, even with the cursor on the card: main.js opens its session as today.
  for (const action of ['open', 'open-ask', 'digest-row', '', null]) assert.equal(cardRoute(on, { action, id: 'a' }), null, String(action));
  // Only a missing argument is a press: anything passed is a tap, and only a tap on the card goes anywhere.
  for (const t of [null, 'digest-card', 0, {}]) assert.equal(cardRoute(on, t), null, String(t));
});

test('leaving the sessions screen on the card puts the cursor on the first session, so Back from the Digest list lands there', () => {
  const on = withCard({ onDigestCard: true, selectedIndex: 3 });
  for (const name of ['digest', 'ambient', 'queue', 'session', 'home', 'audio', 'tasks', 'usage', 'nucbox']) {
    assert.deepEqual(leaveList(name, on), { onDigestCard: false, selectedIndex: 0 }, name);
  }
  assert.equal(leaveList('list', on), null, 'still on the list');
  assert.equal(leaveList('digest', withCard({ selectedIndex: 3 })), null, 'on a tile: the cursor stays');
  assert.equal(leaveList('digest', withCard({ sessions: [] })), null, 'the card alone is selected without the flag');
  // Press on the card, leave for #/digest, Back to #/list: the first session, the card unselected beside it.
  const back = { ...on, ...leaveList(cardRoute(on).slice(2), on) };
  assert.equal(cardSelected(back), false);
  reset(); const html = renderList(back);
  assert.equal(selectedTile(html), 'a');
  assert.match(html, /<div class="dgfirst" data-action="digest-card">/);
  assert.equal(shift(html), 0);
});

// ---- the digest arriving and leaving --------------------------------------------------------------

test('the first digest moves the tiles one column right; the same tile stays selected and on screen', () => {
  // [translateX, the tiles marked off] for each cursor: drawn without the card, then the digest arrives, then it goes.
  const rows = [0, 1, 2, 3, 4].map((i) => {
    reset();
    const a = renderList(listState(i)), b = renderList(withCard({ selectedIndex: i })), c = renderList({ ...listState(i), digest: null });
    for (const h of [a, b, c]) {
      assert.equal(selectedTile(h), 'abcde'[i], 'tile ' + i + ' stays selected');
      assert.ok(!offTiles(h).includes('abcde'[i]), 'and on screen');
    }
    return [[shift(a), offTiles(a)], [shift(b), offTiles(b)], [shift(c), offTiles(c)]];
  });
  assert.deepEqual(rows, [
    [[0, ''], [0, 'e'], [0, '']],
    [[0, ''], [0, 'e'], [0, '']],
    [[0, ''], [380, ''], [380, 'ab']],
    [[0, ''], [380, ''], [380, 'ab']],
    [[380, 'ab'], [760, 'ab'], [380, 'ab']],
  ]);
});

test('a digest that changes leaves the cursor alone unless the card goes with the cursor on it', () => {
  const full = digestOf([card(), card({ sessionId: 'b' })]);
  // On a tile, the card coming or going changes nothing but the digest and its list's selection.
  for (const d of [null, digestOf([]), full, 'junk']) {
    const r = withDigest(withCard({ selectedIndex: 3 }), d);
    assert.deepEqual(Object.keys(r).sort(), ['digest', 'digestSel'], String(d));
  }
  // On the card, a digest that still has a card keeps it selected.
  assert.deepEqual(withDigest(withCard({ onDigestCard: true, selectedIndex: 3 }), full), { digest: full, digestSel: 'a' });
  // On the card, anything without a usable card moves the cursor to the first session.
  for (const d of [undefined, 'junk', { cards: null }, digestOf([null, { title: 'no id' }])]) {
    const r = withDigest(withCard({ onDigestCard: true, selectedIndex: 3 }), d);
    assert.deepEqual([r.onDigestCard, r.selectedIndex], [false, 0], String(d));
  }
  // The card standing alone (no sessions, no flag) needs nothing: the cursor is already 0.
  assert.deepEqual(withDigest(withCard({ sessions: [] }), null), { digest: null, digestSel: null });
  // Applied: the first session is selected and the screen is today's.
  const after = { ...withCard({ onDigestCard: true, selectedIndex: 3 }), ...withDigest(withCard({ onDigestCard: true, selectedIndex: 3 }), null) };
  reset(); assert.equal(noClock(renderList(after)), before.sel0);
});

test('sessions coming and going on either machine leave the card selected; applySnapshot is untouched by it', () => {
  const snap = (ids) => ({ sessions: listState(0).sessions.filter((s) => ids.includes(s.id)), stats: { active: 0, attention: 0 } });
  store.update({ ...withCard({ onDigestCard: true, selectedIndex: 2 }) });
  const seen = [];
  for (const ids of [['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'd', 'e'], ['b', 'e'], [], ['e'], ['a', 'b', 'c', 'd', 'e']]) {
    store.applySnapshot(snap(ids));
    const st = store.get();
    seen.push([st.onDigestCard, cardSelected(st), st.selectedIndex]);
    reset(); const html = renderList(st);
    assert.match(html, /class="dgfirst selected"/, ids.join(''));
    assert.equal(selectedTile(html), null);
    // watchTarget is unchanged: on the card it watches the session under selectedIndex, as on any tile.
    const under = st.sessions[st.selectedIndex];
    assert.equal(watchTarget('list', null, st), under ? under.id : null);
  }
  // applySnapshot re-finds the session under the cursor by id, else clamps, exactly as before (c at 2, c at 2,
  // c gone: 1, none: 0, e: 0, e found again at 4); the flag rides along untouched.
  assert.deepEqual(seen, [[true, true, 2], [true, true, 2], [true, true, 1], [true, true, 0], [true, true, 0], [true, true, 4]]);
  // Forward from the card is the first session whatever applySnapshot did.
  assert.deepEqual(listDial(store.get(), 1), { onDigestCard: false, selectedIndex: 0 });
  store.update({ digest: null, onDigestCard: false, selectedIndex: 0, sessions: [] });
});

test('with no sessions the card stands alone, selected, the empty screen\'s words beside it', () => {
  reset(); renderList(withCard({ selectedIndex: 4 }));
  const html = renderList(withCard({ sessions: [] }));
  assert.match(html, /^<div class="screen"><div class="topbar">/);
  assert.match(html, /<span class="title">SESSIONS<\/span><span class="spacer">/, 'no count in the top bar');
  assert.ok(html.endsWith('<div class="dgnote">' + NO_SESSIONS + '</div></div></div></div>'));
  assert.match(html, /<div class="gridwrap"><div class="gridtrack" style="transform:translateX\(-0px\)"><div class="dgfirst selected" data-action="digest-card">/);
  assert.doesNotMatch(html, /class="empty"|class="tile /);
  // Without the card, today's empty screen, word for word.
  assert.equal(noClock(renderList({ ...listState(0), sessions: [] })), before.cases['no sessions'][0]);
  // The note's text is the empty screen's.
  assert.ok(before.cases['no sessions'][0].includes('<div class="empty">' + NO_SESSIONS + '</div>'));
  // The Mac down: the top bar says so, the card is still there.
  assert.match(renderList(withCard({ sessions: [], daemonConnected: false })), /<span class="conn"><\/span>[\s\S]*class="dgfirst selected"/);
});

test('the card is the Mac\'s: its rows escape what they say, and NucBox tiles beside it are drawn as before', () => {
  const evil = '<img src=x onerror=alert(1)>';
  reset(); const html = renderList(withCard({ digest: digestOf([card({ title: evil, lastReply: evil })]) }));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  // The tiles after the card are byte-for-byte the tiles without it (the card is the only addition).
  reset(); const plain = renderList(listState(0));
  reset(); const withIt = renderList(withCard());
  const tilesOf = (h) => h.slice(h.indexOf('<div class="tile '));
  assert.equal(tilesOf(withIt).replace(' off"', '"'), tilesOf(plain));
  assert.match(withIt, /data-id="e"/);
});
