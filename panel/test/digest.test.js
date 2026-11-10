// The Digest list and the first card's parts are string builders, so they are rendered and read
// back here without a browser. The fixtures are plain object literals in the SHAPE of what
// mac-service/src/digest/card.js builds (a Digest of DigestCards); nothing here imports the Mac side.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  digestCards, findCard, liveOf, selectedIndex, moveSelection, pressTarget, renderDigest,
  digestFleetLine, hasFleetCard, fleetCardRows, renderFleetCard, sessionStrip, sessionCard, ambientLine,
} from '../src/screens/digest.js';
import { renderDetail } from '../src/screens/session-detail.js';
import { renderAmbient } from '../src/screens/ambient.js';
import { now } from '../src/clock.js';

function baseState(over = {}) {
  return {
    sessions: [], stats: { active: 0, attention: 0 }, details: {}, asks: [],
    usage: null, daemonConnected: true, selectedIndex: 0, queueIndex: 0,
    digest: null, digestSel: null,
    ...over,
  };
}
// A DigestCard as buildCard makes it in the facts-only milestone: no summary, no turns behind.
const card = (over = {}) => ({
  sessionId: 'a', title: 'Recorder reopen', project: 'car-thing', ended: false,
  lastTurnTs: now() - 12 * 60e3,
  facts: { turns: 3, files: 1, commits: 1, prs: 1, tests: { passed: 14, failed: 0, runs: 1 }, agents: { finished: 0, running: 0 } },
  lines: [], lastReply: '', summary: null, behindTurns: 0,
  ...over,
});
const digest = (over = {}) => ({
  updatedTs: now(), windowHours: 24,
  summarizer: { state: 'off', model: null, lastOkTs: null },
  totals: { sessions: 1, turns: 3, commits: 1, prs: 1, testRuns: 1 },
  cards: [card()],
  ...over,
});
const st = (digestOver = {}, stateOver = {}) => baseState({ digest: digest(digestOver), ...stateOver });
const macSession = (id, state = 'idle', over = {}) => ({ id, state, ended: false, ...over });
const many = (n) => Array.from({ length: n }, (_, i) => card({ sessionId: 'c' + i, title: 'T' + i, lastReply: 'Reply ' + i }));
const count = (html, re) => (html.match(re) || []).length;
const INJECT = '<img src=x onerror=alert(1)>';

// ---- the brief's tests --------------------------------------------------------------------------

test('a facts-only card: LAST REPLY, fact lines, FACTS tag, no NEW once seen', () => {
  const html = renderDigest(st({ cards: [card({ lastReply: 'The recorder now reopens.', lines: ['Tests: 14 passed, 0 failed'] })] }), Infinity);
  for (const re of [/LAST REPLY<\/span> &quot;The recorder now reopens\.&quot;/, /Tests: 14 passed, 0 failed/, /class="dgtag">FACTS</]) assert.match(html, re);
  assert.doesNotMatch(html, />NEW</);
});

test('the strip counts the window and says FACTS ONLY', () => {
  assert.match(renderDigest(st({ totals: { sessions: 6, turns: 19, commits: 7, prs: 1, testRuns: 3 } }), 0),
    /LAST 24H · 6 SESSIONS · 19 TURNS · 7 COMMITS · 1 PR<\/span><span class="dgsrc">FACTS ONLY/);
});

test('nothing in the window, and a digest not yet read', () => {
  assert.match(renderDigest(st({ cards: [] }), 0), /class="empty">NOTHING DONE IN THE LAST 24H/);
  assert.match(renderDigest(baseState({ digest: null }), 0), /READING DIGEST/);
});

test('offline: the last digest stays with its ages', () => {
  const html = renderDigest(st({}, { daemonConnected: false }), 0);
  assert.match(html, /class="conn"[\s\S]*class="dgage">12m</);
});

test('lamp and label come from the Mac\'s live session; a missing one is ENDED', () => {
  const live = renderDigest(st({}, { sessions: [macSession('a', 'busy')] }), Infinity);
  assert.match(live, /<span class="lamp busy"><\/span><span class="dgstate">WORKING<\/span>/);
  assert.match(live, /class="dghint">PRESS TO OPEN</);
  const nucbox = macSession('a', 'busy', { machine: 'NucBox' });
  for (const sessions of [[], [nucbox]]) {
    const html = renderDigest(st({}, { sessions }), Infinity);
    assert.match(html, /<span class="lamp idle"><\/span><span class="dgstate">ENDED<\/span>/);
    assert.doesNotMatch(html, /WORKING|PRESS TO OPEN/);
  }
});

test('NEW marks cards that changed after the screen was last seen', () => {
  const s = st({ cards: [card({ lastTurnTs: 100 })] });
  assert.match(renderDigest(s, 50), /<span class="dgtag">NEW<\/span><span class="dgtag">FACTS<\/span>/);
  assert.doesNotMatch(renderDigest(s, 200), />NEW</);
  assert.doesNotMatch(renderDigest(s, 100), />NEW</);
});

test('selection follows the session id across a re-sort, and the knob clamps', () => {
  const [a, b, c] = ['a', 'b', 'c'].map((id) => card({ sessionId: id }));
  assert.equal(selectedIndex([c, a, b], 'b'), 2);
  assert.equal(moveSelection([a, b, c], 'c', 1), 'c');
  assert.equal(moveSelection([a, b, c], null, 1), 'b');
});

test('press opens a live session; an ended one says SESSION ENDED', () => {
  assert.deepEqual(pressTarget(st({}, { sessions: [{ id: 'a', state: 'idle', ended: false }] }), 'a'), { open: 'a' });
  assert.deepEqual(pressTarget(st({}), 'gone'), { toast: 'SESSION ENDED' });
  assert.deepEqual(pressTarget(st({}, { sessions: [{ id: 'a', state: 'idle', ended: false, machine: 'NucBox' }] }), 'a'), { toast: 'SESSION ENDED' });
  assert.equal(findCard(st({}, { details: { a: { machine: 'NucBox' } } }), 'a'), null);   // card() defaults to sessionId 'a'
});

test('the column keeps the selected card on screen', () => {
  renderDigest(st({ cards: many(10) }, { digestSel: 'c0' }), Infinity);   // the column starts at the top
  const html = renderDigest(st({ cards: many(10) }, { digestSel: 'c8' }), Infinity);
  for (let i = 0; i < 5; i++) assert.ok(!html.includes('data-id="c' + i + '"'), 'c' + i + ' is above the column');
  for (let i = 5; i < 10; i++) assert.ok(html.includes('data-id="c' + i + '"'), 'c' + i + ' is in the column');
  assert.match(html, /class="dgcard[^"]*" data-action="digest-row" data-id="c8"/);
  assert.equal(count(html, /class="dgcard/g), 1);
  // Turning back up keeps the rows it already shows until the knob leaves the top of the column.
  const up = renderDigest(st({ cards: many(10) }, { digestSel: 'c6' }), Infinity);
  assert.ok(up.includes('data-id="c5"') && !up.includes('data-id="c4"'));
  assert.match(up, /class="dgcard[^"]*" data-action="digest-row" data-id="c6"/);
  const top = renderDigest(st({ cards: many(10) }, { digestSel: 'c2' }), Infinity);
  assert.ok(!top.includes('data-id="c1"') && top.includes('data-id="c2"'));
});

test('card text is escaped and nothing alerts', () => {
  const s = st({ cards: [card({ title: '<img src=x>' })] }); const html = renderDigest(s, 0) + renderFleetCard(s, false);
  assert.ok(!html.includes('<img')); assert.doesNotMatch(html, /blocked|edge|breathe/);
});

test('the fleet line counts the window and leaves out zero commits and PRs', () => {
  assert.equal(digestFleetLine({ windowHours: 24, totals: { sessions: 6, turns: 19, commits: 7, prs: 1, testRuns: 3 } }), 'LAST 24H · 6 SESSIONS · 19 TURNS · 7 COMMITS · 1 PR');
  assert.equal(digestFleetLine({ windowHours: 24, totals: { sessions: 1, turns: 1, commits: 0, prs: 0, testRuns: 0 } }), 'LAST 24H · 1 SESSION · 1 TURN');
});

test('first-card rows: the newest three, the live lamp, the reply quoted, else the first fact line', () => {
  const rows = fleetCardRows(st({ cards: ['a', 'b', 'c', 'd'].map((id) => card({ sessionId: id, title: 'T ' + id, lastReply: id === 'b' ? '' : 'Done.', lines: ['PR #14'] })) }, { sessions: [{ id: 'a', state: 'busy', ended: false }] }));
  assert.deepEqual(rows.map((r) => r.id), ['a', 'b', 'c']); assert.deepEqual([rows[1].lamp, rows[1].text], ['idle', 'PR #14']);
  assert.deepEqual(rows[0], { id: 'a', lamp: 'busy', title: 'T a', text: '"Done."', age: '12m' });
});

test('the first card: fleet line, rows, PRESS TO OPEN, one tap target; nothing without cards', () => {
  const html = renderFleetCard(st({ cards: [card({ lastReply: 'Done.' })] }), true);
  assert.match(html, /^<div class="dgfirst selected" data-action="digest-card"><div class="dgfhead">DIGEST<\/div><div class="dgffleet">LAST 24H · /);
  assert.match(html, /class="dgftext">&quot;Done\.&quot;<[\s\S]*class="dghint">PRESS TO OPEN</);
  assert.equal(count(html, /data-action=/g), 1); assert.doesNotMatch(html, />NEW</);
  assert.equal(renderFleetCard(st({ cards: [] }), false), ''); assert.equal(renderFleetCard(baseState({ digest: null }), false), '');
});

// ---- the rest of the list ----------------------------------------------------------------------

test('the selected card is the only full card; the others are one-line rows', () => {
  const cards = [
    card({ sessionId: 'a', title: 'Alpha', lastReply: 'A done.', lines: ['l1', 'l2', 'l3', 'l4', 'l5', 'l6'] }),
    card({ sessionId: 'b', title: 'Beta', lastReply: 'B done.', lines: ['b1'] }),
    card({ sessionId: 'c', title: 'Gamma', lastReply: '', lines: ['Tests: 14 passed, 0 failed', 'second'] }),
    card({ sessionId: 'd', title: 'Delta', lastReply: '', lines: [] }),
  ];
  const html = renderDigest(st({ cards }, { digestSel: 'a' }), Infinity);
  assert.equal(count(html, /class="dgcard/g), 1);
  assert.equal(count(html, /class="dgrow/g), 3);
  assert.equal(count(html, /data-action="digest-row"/g), 4);
  assert.equal(count(html, /class="dgline"/g), 4, 'a card shows at most four fact lines');
  assert.ok(html.includes('>l4<') && !html.includes('l5'));
  assert.match(html, /<div class="dgsub"><span class="dgrlabel">LAST REPLY<\/span> &quot;B done\.&quot;<\/div>/);
  assert.match(html, /<div class="dgsub">Tests: 14 passed, 0 failed<\/div>/);
  assert.ok(!html.includes('second'), 'a row shows only the first fact line');
  assert.match(html, /<div class="dgsub"><\/div>/, 'a row with no reply and no facts has an empty line');
  assert.equal(count(html, /class="dgreply"/g), 1, 'only the selected card has the LAST REPLY block');
});

test('the topbar counts the cards, and the empty states carry no count', () => {
  assert.match(renderDigest(st({ cards: many(3) }), Infinity), /<span class="title">DIGEST<\/span><span class="tcount">3<\/span>/);
  for (const html of [renderDigest(st({ cards: [] }), 0), renderDigest(baseState(), 0)]) {
    assert.match(html, /<span class="title">DIGEST<\/span>/);
    assert.doesNotMatch(html, /tcount/);
  }
});

test('an ended session (or one the Mac lost) has no PRESS TO OPEN and presses to the toast', () => {
  const sessions = [macSession('a', 'idle', { ended: true })];
  const html = renderDigest(st({}, { sessions }), Infinity);
  assert.match(html, /class="dgstate">ENDED</);
  assert.doesNotMatch(html, /PRESS TO OPEN/);
  assert.deepEqual(pressTarget(st({}, { sessions }), 'a'), { toast: 'SESSION ENDED' });
});

test('the digest is the Mac\'s: a NucBox session with the same id never lights a card', () => {
  const nuc = macSession('a', 'busy', { machine: 'NucBox' });
  const mac = macSession('a', 'attention');
  assert.deepEqual(liveOf(st({}, { sessions: [nuc, mac] }), card()), { state: 'attention', ended: false });
  assert.deepEqual(liveOf(st({}, { sessions: [mac, nuc] }), card()), { state: 'attention', ended: false });
  assert.deepEqual(liveOf(st({}, { sessions: [nuc] }), card()), { state: 'idle', ended: true });
  assert.deepEqual(liveOf(st({}), card()), { state: 'idle', ended: true });
  assert.deepEqual(pressTarget(st({}, { sessions: [nuc, mac] }), 'a'), { open: 'a' });
  // The first card reads the same join.
  assert.equal(fleetCardRows(st({}, { sessions: [nuc] }))[0].lamp, 'idle');
  assert.equal(fleetCardRows(st({}, { sessions: [nuc, mac] }))[0].lamp, 'attention');
});

test('a NucBox session\'s view gets no digest card; the Mac\'s own does', () => {
  const s = st({ cards: [card({ sessionId: 'a' }), card({ sessionId: 'b' })] }, { details: { a: { machine: 'NucBox' }, b: { currentTool: 'Bash' } } });
  assert.equal(findCard(s, 'a'), null);
  assert.equal(findCard(s, 'b'), s.digest.cards[1]);
  assert.equal(findCard(s, 'nope'), null);
  assert.equal(findCard(s, undefined), null);
  assert.equal(findCard(baseState({ digest: null }), 'a'), null);
  const bare = st({}, { details: undefined });
  assert.equal(findCard(bare, 'a'), bare.digest.cards[0], 'a state with no details is nobody\'s NucBox view');
});

test('the lamp is a whitelisted class, whatever the session snapshot says', () => {
  const sessions = [macSession('a', 'busy"><img src=x>')];
  const html = renderDigest(st({}, { sessions }), Infinity) + renderFleetCard(st({}, { sessions }), false);
  assert.ok(!html.includes('<img'));
  assert.match(html, /class="lamp idle"/);
  assert.deepEqual(fleetCardRows(st({}, { sessions }))[0].lamp, 'idle');
  for (const state of ['idle', 'busy', 'attention', 'celebrate']) assert.equal(liveOf(st({}, { sessions: [macSession('a', state)] }), card()).state, state);
});

test('selection helpers: absent ids, empty lists, odd directions', () => {
  const [a, b, c] = ['a', 'b', 'c'].map((id) => card({ sessionId: id }));
  assert.equal(selectedIndex([a, b, c], 'zzz'), 0);
  assert.equal(selectedIndex([a, b, c], null), 0);
  assert.equal(selectedIndex([a, b, c], 'a'), 0);
  assert.equal(selectedIndex([], 'a'), 0);
  assert.equal(selectedIndex(null, 'a'), 0);
  assert.equal(moveSelection([a, b, c], 'a', -1), 'a');
  assert.equal(moveSelection([a, b, c], 'b', -1), 'a');
  assert.equal(moveSelection([a, b, c], 'a', 1), 'b');
  assert.equal(moveSelection([a, b, c], 'a', 99), 'c');
  assert.equal(moveSelection([a, b, c], 'c', -99), 'a');
  assert.equal(moveSelection([a, b, c], 'zzz', 1), 'b', 'an id that left the digest starts from the top');
  assert.equal(moveSelection([a, b, c], 'b', 0), 'b');
  assert.equal(moveSelection([a, b, c], 'b', 'x'), 'b');
  assert.equal(moveSelection([a, b, c], 'b', NaN), 'b');
  assert.equal(moveSelection([], 'a', 1), null);
  assert.equal(moveSelection(null, 'a', 1), null);
});

test('a selection that left the digest falls back to the first card', () => {
  const html = renderDigest(st({ cards: many(4) }, { digestSel: 'gone' }), Infinity);
  assert.match(html, /class="dgcard[^"]*" data-action="digest-row" data-id="c0"/);
  assert.equal(count(html, /class="dgcard/g), 1);
});

test('digestCards: the digest\'s own cards in its order, and only usable ones', () => {
  const a = card({ sessionId: 'a' });
  const b = card({ sessionId: 'b' });
  assert.deepEqual(digestCards(st({ cards: [b, a] })), [b, a]);
  assert.deepEqual(digestCards(baseState()), []);
  assert.deepEqual(digestCards(st({ cards: [null, 1, 'x', [], {}, { sessionId: '' }, { sessionId: 7 }, a] })), [a]);
  assert.deepEqual(digestCards(st({ cards: [a, { ...a, title: 'again' }, b] })), [a, b], 'one card per session, the first');
  assert.equal(hasFleetCard(st({ cards: [null] })), false);
  assert.equal(hasFleetCard(st({ cards: [a] })), true);
  assert.equal(hasFleetCard(st({ cards: [] })), false);
  assert.equal(hasFleetCard(baseState()), false);
});

test('the tags: NEW before FACTS, FACTS only while there is no summary', () => {
  const html = renderDigest(st({ cards: [card({ lastTurnTs: 100, summary: { headline: 'h' } })] }), 50);
  assert.match(html, /<span class="dgtag">NEW<\/span><span class="dgage">/);
  assert.doesNotMatch(html, />FACTS</);
  const rows = renderDigest(st({ cards: [card({ sessionId: 'a', lastTurnTs: 10 }), card({ sessionId: 'b', lastTurnTs: 100 })] }, { digestSel: 'a' }), 50);
  assert.equal(count(rows, />NEW</g), 1, 'the row carries the tag too');
  assert.equal(count(rows, />FACTS</g), 2);
  // No seenTs at all is "nothing is new", not "everything is".
  assert.doesNotMatch(renderDigest(st({ cards: [card({ lastTurnTs: 100 })] })), />NEW</);
});

test('FACTS ONLY for every summarizer state, known or not', () => {
  for (const summarizer of [{ state: 'off' }, { state: 'ok' }, { state: 'offline' }, { state: 'model-not-loaded' }, { state: 'error' }, { state: 'from-the-future' }, null, 'x', {}]) {
    assert.match(renderDigest(st({ summarizer }), 0), /<span class="dgsrc">FACTS ONLY<\/span>/, JSON.stringify(summarizer));
  }
});

test('the fleet line: singular and plural, zero sessions, the window', () => {
  const t = (over) => ({ sessions: 2, turns: 2, commits: 0, prs: 0, testRuns: 0, ...over });
  assert.equal(digestFleetLine({ windowHours: 24, totals: t({ commits: 1, prs: 2 }) }), 'LAST 24H · 2 SESSIONS · 2 TURNS · 1 COMMIT · 2 PRS');
  assert.equal(digestFleetLine({ windowHours: 24, totals: t({ prs: 1 }) }), 'LAST 24H · 2 SESSIONS · 2 TURNS · 1 PR');
  assert.equal(digestFleetLine({ windowHours: 6, totals: t({ sessions: 0, turns: 0 }) }), 'LAST 6H · 0 SESSIONS · 0 TURNS');
  assert.equal(digestFleetLine({ windowHours: 1.5, totals: t() }), 'LAST 1.5H · 2 SESSIONS · 2 TURNS');
});

test('the first card shows the newest three rows, the same quoting and ages as the list', () => {
  const html = renderFleetCard(st({ cards: ['a', 'b', 'c', 'd'].map((id) => card({ sessionId: id, title: 'T ' + id, lastReply: 'R ' + id })) }), false);
  assert.match(html, /^<div class="dgfirst" data-action="digest-card">/);
  assert.equal(count(html, /class="dgfrow"/g), 3);
  assert.ok(html.includes('T a') && html.includes('T c') && !html.includes('T d'));
  assert.match(html, /<div class="dgfrtop"><span class="lamp idle"><\/span><span class="dgftitle">T a<\/span><span class="dgfage">12m<\/span><\/div><div class="dgftext">&quot;R a&quot;<\/div>/);
  assert.equal(count(html, /class="dghint"/g), 1);
});

test('the first card with no reply and no facts has an empty text, not undefined', () => {
  const rows = fleetCardRows(st({ cards: [card({ lastReply: '', lines: [] })] }));
  assert.equal(rows[0].text, '');
  assert.doesNotMatch(renderFleetCard(st({ cards: [card({ lastReply: '', lines: [] })] }), false), /undefined|null|NaN/);
});

// ---- untrusted text -----------------------------------------------------------------------------

test('a title, a fact line and a reply from a transcript come out escaped, everywhere', () => {
  const cards = [
    card({ sessionId: 'a', title: INJECT, lastReply: INJECT, lines: [INJECT] }),
    card({ sessionId: 'b', title: INJECT, lastReply: INJECT, lines: [INJECT] }),
    card({ sessionId: 'c', title: INJECT, lastReply: '', lines: [INJECT] }),
  ];
  for (const sel of ['a', 'b']) {
    const s = st({ cards }, { digestSel: sel });
    for (const html of [renderDigest(s, 0), renderFleetCard(s, true)]) {
      assert.ok(!html.includes('<img'), 'no tag survives');
      assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
    }
  }
  // A reply is quoted by the renderer, so a quote inside it cannot end the attribute or the text early.
  const quoted = renderDigest(st({ cards: [card({ lastReply: 'say "hi" <b>' })] }), 0);
  assert.match(quoted, /&quot;say &quot;hi&quot; &lt;b&gt;&quot;/);
  assert.ok(!quoted.includes('<b>'));
});

test('a session id with markup in it cannot break out of data-id', () => {
  const s = st({ cards: [card({ sessionId: '"><b onmouseover=x>' }), card({ sessionId: 'plain' })] });
  const html = renderDigest(s, 0);
  assert.ok(!html.includes('<b '));
  assert.match(html, /data-id="&quot;&gt;&lt;b onmouseover=x&gt;"/);
});

// ---- hostile and half-formed input ---------------------------------------------------------------

const ALL = [
  (s) => renderDigest(s, 0), (s) => renderDigest(s, undefined), (s) => renderDigest(s, 'x'),
  (s) => renderFleetCard(s, true), (s) => renderFleetCard(s, false),
  (s) => JSON.stringify(fleetCardRows(s)), (s) => JSON.stringify(digestCards(s)), (s) => String(hasFleetCard(s)),
  (s) => digestFleetLine(s && s.digest), (s) => JSON.stringify(pressTarget(s, 'a')), (s) => JSON.stringify(findCard(s, 'a')),
  (s) => JSON.stringify(liveOf(s, card())),
];
function neverThrows(state) { for (const f of ALL) assert.equal(typeof f(state), 'string'); }

test('a null, missing or wrong-typed digest never throws and draws a screen', () => {
  for (const d of [undefined, null, 0, 1, true, 'x', [], {}, { cards: null }, { cards: 'x' }, { cards: 5 }, { cards: {} },
    { cards: [null, 1, 'x', [], {}, { sessionId: 5 }] }, { cards: [], totals: null, summarizer: null, windowHours: 'x' },
    { cards: [], totals: 'x', windowHours: -3 }, { cards: [], windowHours: NaN }, { cards: [], windowHours: Infinity }]) {
    neverThrows(baseState({ digest: d }));
    const html = renderDigest(baseState({ digest: d }), 0);
    assert.match(html, /^<div class="screen digest">/);
    assert.match(html, /class="empty">(READING DIGEST|NOTHING DONE IN THE LAST \d+H)/, JSON.stringify(d));
    assert.equal(renderFleetCard(baseState({ digest: d }), false), '');
  }
  assert.match(renderDigest(baseState({ digest: {} }), 0), /NOTHING DONE IN THE LAST 24H/);
  assert.match(renderDigest(baseState({ digest: { cards: [], windowHours: 6 } }), 0), /NOTHING DONE IN THE LAST 6H/);
  assert.match(renderDigest(baseState({ digest: { cards: [], windowHours: 'x' } }), 0), /NOTHING DONE IN THE LAST 24H/);
  assert.match(renderDigest(baseState({ digest: 'x' }), 0), /READING DIGEST/);
});

test('a state with no sessions, details or selection fields never throws', () => {
  for (const over of [{ sessions: undefined }, { sessions: null }, { sessions: 'x' }, { sessions: [null, 1, 'x', {}] }, { details: undefined }, { details: null }, { details: 'x' },
    { digestSel: undefined }, { digestSel: 42 }, { digestSel: {} }, { daemonConnected: undefined }]) {
    neverThrows(st({}, over));
    const html = renderDigest(st({}, over), 0);
    assert.match(html, /data-id="a"/, JSON.stringify(over));
    assert.match(html, /class="dgstate">ENDED</);
  }
});

test('a card with missing or wrong-typed fields draws a sensible card', () => {
  const junk = { sessionId: 'a', title: 5, project: {}, ended: 'yes', lastTurnTs: '123', facts: 'x', lines: 'x', lastReply: 7, summary: undefined, behindTurns: 'many' };
  const s = baseState({ digest: digest({ cards: [junk, { sessionId: 'b' }] }), digestSel: 'a' });
  neverThrows(s);
  const html = renderDigest(s, 0) + renderFleetCard(s, false);
  assert.doesNotMatch(html, /undefined|NaN|null|\[object/);
  assert.match(html, /<span class="dgtitle">session<\/span>/, 'a title that is not text reads as "session"');
  assert.equal(count(html, /class="dgline"/g), 0, 'lines that are not a list draw no lines');
  assert.equal(count(html, /class="dgreply"/g), 0, 'a reply that is not text draws no reply');
  assert.match(html, /<span class="dgage"><\/span>/, 'a timestamp that is not a number draws no age');
  assert.deepEqual(fleetCardRows(s)[1], { id: 'b', lamp: 'idle', title: 'session', text: '', age: '' });
});

test('fact lines: only text, only four, a list that is not one is nothing', () => {
  const s = st({ cards: [card({ lines: ['one', 5, null, {}, ['x'], 'two', 'three', 'four', 'five'] })] });
  const html = renderDigest(s, 0);
  assert.equal(count(html, /class="dgline"/g), 4);
  for (const t of ['one', 'two', 'three', 'four']) assert.ok(html.includes('>' + t + '<'), t);
  assert.ok(!html.includes('five'));
  for (const lines of ['x', 5, null, undefined, {}, { 0: 'x', length: 1 }]) {
    assert.equal(count(renderDigest(st({ cards: [card({ lines })] }), 0), /class="dgline"/g), 0, JSON.stringify(lines));
  }
  assert.equal(fleetCardRows(st({ cards: [card({ lines: [5, 'first'] })] }))[0].text, 'first');
});

test('counts that are strings, negative or not finite read as zero, never as NaN', () => {
  const totals = { sessions: '6', turns: -4, commits: NaN, prs: Infinity, testRuns: {} };
  assert.equal(digestFleetLine({ windowHours: 24, totals }), 'LAST 24H · 0 SESSIONS · 0 TURNS');
  assert.equal(digestFleetLine({ windowHours: 24, totals: { sessions: 2.9, turns: 3.2, commits: 1e21 } }), 'LAST 24H · 2 SESSIONS · 3 TURNS · 99999 COMMITS');
  assert.equal(digestFleetLine(undefined), 'LAST 24H · 0 SESSIONS · 0 TURNS');
  assert.equal(digestFleetLine('x'), 'LAST 24H · 0 SESSIONS · 0 TURNS');
  assert.equal(digestFleetLine({ windowHours: 1e21, totals: {} }), 'LAST 9999H · 0 SESSIONS · 0 TURNS');
});

test('ages: a clock ahead of the card, an absent timestamp, an old card', () => {
  const rows = fleetCardRows(st({ cards: [
    card({ sessionId: 'a', lastTurnTs: now() + 3600e3 }), card({ sessionId: 'b', lastTurnTs: 0 }),
    card({ sessionId: 'c', lastTurnTs: now() - 3 * 24 * 3600e3 }),
  ] }));
  assert.deepEqual(rows.map((r) => r.age), ['now', '', '3d']);
});

test('huge strings are cut before they reach the markup', () => {
  const big = 'x'.repeat(100 * 1024);
  const cards = [card({ sessionId: 'a', title: big, lastReply: big, lines: [big, big, big, big] }),
    card({ sessionId: 'b', title: big, lastReply: big, lines: [big] }), card({ sessionId: 'c', title: big, lastReply: '', lines: [big] })];
  const s = st({ cards }, { digestSel: 'a' });
  const list = renderDigest(s, 0);
  const first = renderFleetCard(s, false);
  assert.ok(list.length < 20000, 'the list is ' + list.length + ' bytes');
  assert.ok(first.length < 6000, 'the first card is ' + first.length + ' bytes');
  assert.ok(fleetCardRows(s).every((r) => r.title.length <= 120 && r.text.length <= 242));
  assert.ok(renderDigest(st({ cards }, { digestSel: 'b' }), 0).length < 20000);
  const bigId = card({ sessionId: 'i'.repeat(100 * 1024) });
  assert.ok(renderDigest(st({ cards: [bigId] }), 0).length < 20000, 'a huge session id is bounded too');
});

test('a card list of hundreds draws a column of a dozen rows and stays correct', () => {
  const cards = many(500);
  const s = (sel) => st({ cards }, { digestSel: sel, sessions: [macSession('c250', 'busy')] });
  const top = renderDigest(s('c0'), Infinity);
  assert.equal(count(top, /data-action="digest-row"/g), 8, 'the top: the card and seven rows after it');
  assert.match(top, /<span class="tcount">500<\/span>/);
  const mid = renderDigest(s('c250'), Infinity);
  assert.equal(count(mid, /data-action="digest-row"/g), 11, 'three rows above, the card, seven below');
  assert.match(mid, /class="dgcard[^"]*" data-action="digest-row" data-id="c250"/);
  assert.ok(mid.includes('data-id="c247"') && !mid.includes('data-id="c246"') && mid.includes('data-id="c257"') && !mid.includes('data-id="c258"'));
  assert.match(mid, /class="dgstate">WORKING</);
  const end = renderDigest(s('c499'), Infinity);
  assert.equal(count(end, /data-action="digest-row"/g), 4);
  assert.equal(count(renderFleetCard(s('c0'), false), /class="dgfrow"/g), 3);
  assert.equal(selectedIndex(cards, 'c499'), 499);
  assert.equal(moveSelection(cards, 'c498', 1), 'c499');
  assert.equal(moveSelection(cards, 'c499', 1), 'c499');
  assert.equal(digestCards(s('c0')).length, 500);
  assert.deepEqual(pressTarget(s('c0'), 'c250'), { open: 'c250' });
});

test('the same screen from the same input, run after run', () => {
  const s = st({ cards: many(6) }, { digestSel: 'c4', sessions: [macSession('c4', 'celebrate')] });
  const a = renderDigest(s, 0);
  assert.equal(renderDigest(s, 0), a);
  assert.equal(renderFleetCard(s, true), renderFleetCard(s, true));
});

test('rendering changes nothing it was given', () => {
  const frozen = (v) => { if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); Object.values(v).forEach(frozen); } return v; };
  const s = frozen(st({ cards: many(5) }, { digestSel: 'c2', sessions: [macSession('c2', 'busy')] }));
  renderDigest(s, 0); renderFleetCard(s, true); fleetCardRows(s); digestCards(s); findCard(s, 'c2'); pressTarget(s, 'c2');
  moveSelection(s.digest.cards, 'c2', 1);
});

// ---- Task 13: the session strip, the session card and the ambient line --------------------------------

// A state whose digest holds one 12-minute-old card for session 'a', live (busy) in the Mac's sessions.
const withCard = (over = {}, stateOver = {}) => st({ cards: [card({ lastReply: 'Done.', ...over })] }, { sessions: [macSession('a', 'busy')], ...stateOver });
// The same with the session's own detail, as renderDetail has it.
const detailState = (over = {}, stateOver = {}) => withCard(over, {
  details: { a: { id: 'a', name: 'Recorder reopen', state: 'busy', tokens: { in: 1, out: 2 }, cacheRead: 0, context: null, model: '', cwd: '/x/p' } },
  messages: { a: [{ role: 'user', text: 'hello', ts: 1 }] }, ...stateOver,
});
// Ambient's base state: one card titled "Panel brightness tuning", ageMs old (12 minutes unless said).
const ambientState = ({ ageMs = 12 * 60e3, asks = [], ...over } = {}) =>
  baseState({ asks, digest: digest({ cards: [card({ title: 'Panel brightness tuning', lastReply: 'The dial now dims in 5% steps.', lastTurnTs: now() - ageMs, ...over })] }) });
const plain = (html) => html.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"');

test('the session strip shows the last reply and age, and is absent without one', () => {
  assert.match(sessionStrip(withCard({ lastReply: 'Done.' }), 'a'), /class="dstrip".*&quot;Done\.&quot;.*12m/s);
  assert.equal(sessionStrip(withCard({ lastReply: '' }), 'a'), '');
  assert.equal(sessionStrip(baseState({ digest: null }), 'a'), '');
});

test('the session card follows the newest message, before Open in VS Code', () => {
  const html = renderDetail(detailState({ lastReply: 'Done.', lines: ['1 commit: fix: x'] }), 'a'); const at = (s) => html.indexOf(s);
  assert.ok(at('id="cvend"') < at('class="dcard"') && at('class="dcard"') < at('Open in VS Code')); assert.match(html, /FACTS · 12m/);
});

test('the ambient line shows the newest card, and hides while anything waits or when nothing finished in 12 h', () => {
  assert.match(renderAmbient(ambientState()), /class="adigest">12m · Panel brightness tuning — &quot;/);
  assert.doesNotMatch(renderAmbient(ambientState({ asks: [{ id: 'k' }] })), /adigest/);
  assert.doesNotMatch(renderAmbient(ambientState({ ageMs: 13 * 3600e3 })), /adigest/);
  const text = ambientLine(ambientState({ lastReply: 'x'.repeat(200) })).replace(/<[^>]+>/g, '').replace(/&quot;/g, '"');
  assert.ok(text.length <= 65);
});

test('the strip is one lamp, the quoted reply and the age, in that order', () => {
  assert.equal(sessionStrip(detailState({ lastReply: 'Done.' }), 'a'),
    '<div class="dstrip"><span class="lamp busy"></span><span class="dstext">&quot;Done.&quot;</span><span class="dsage">12m</span></div>');
  // A card with no time has no age to show, and no empty age span.
  assert.equal(sessionStrip(withCard({ lastReply: 'Done.', lastTurnTs: undefined }), 'a'),
    '<div class="dstrip"><span class="lamp busy"></span><span class="dstext">&quot;Done.&quot;</span></div>');
  // Not tappable: nothing in it asks for a press or a tap.
  assert.doesNotMatch(sessionStrip(withCard(), 'a'), /data-action|<a |<button/);
});

test('the strip needs a card for this session: a blank reply, another session, or a NucBox session has none', () => {
  assert.equal(sessionStrip(withCard({ lastReply: '   ' }), 'a'), '');
  assert.equal(sessionStrip(withCard({ lastReply: 7 }), 'a'), '');
  assert.equal(sessionStrip(withCard(), 'other'), '');
  assert.equal(sessionStrip(st({ cards: [] }), 'a'), '');
  // The NucBox's session with the same id: its detail carries machine, and the digest is the Mac's.
  assert.equal(sessionStrip(withCard({}, { details: { a: { id: 'a', state: 'busy', machine: 'NucBox' } } }), 'a'), '');
});

test('the strip lamp is the detail\'s state, else the Mac\'s live session, and only a known state', () => {
  const lamp = (html) => (html.match(/class="lamp ([^"]*)"/) || [])[1];
  assert.equal(lamp(sessionStrip(detailState({}, { details: { a: { state: 'celebrate' } }, sessions: [macSession('a', 'busy')] }), 'a')), 'celebrate');
  assert.equal(lamp(sessionStrip(withCard({}, { sessions: [macSession('a', 'attention')] }), 'a')), 'attention', 'no detail yet: the live session');
  assert.equal(lamp(sessionStrip(withCard({}, { sessions: [] }), 'a')), 'idle', 'a session the Mac lost is over');
  assert.equal(lamp(sessionStrip(detailState({}, { details: { a: { state: 'busy', ended: true } } }), 'a')), 'idle', 'an ended detail is idle whatever it last said');
  for (const state of ['"><b>', 'x y', '', null, 5, {}, '__proto__', 'constructor']) {
    const html = sessionStrip(detailState({}, { details: { a: { state } }, sessions: [macSession('a', 'idle')] }), 'a');
    assert.equal(lamp(html), 'idle', String(state));
  }
});

test('the strip text is escaped, and a long reply is cut to what the Mac keeps', () => {
  const html = sessionStrip(withCard({ lastReply: INJECT }), 'a');
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&quot;&lt;img src=x onerror=alert(1)&gt;&quot;'));
  assert.ok(sessionStrip(withCard({ lastReply: 'say "hi" & <b>' }), 'a').includes('&quot;say &quot;hi&quot; &amp; &lt;b&gt;&quot;'));
  const big = sessionStrip(withCard({ lastReply: 'x'.repeat(100 * 1024) }), 'a');
  assert.ok(big.length < 500, 'the strip is ' + big.length + ' bytes');
  assert.equal(big.match(/x{10,}/)[0].length, 120);
});

test('the session card is headed FACTS and the age, then the reply and the fact lines as the digest card has them', () => {
  const html = sessionCard(detailState({ lastReply: 'Done.', lines: ['1 commit: fix: x', 'Tests: 14 passed, 0 failed'] }), 'a');
  assert.equal(html,
    '<div class="dcard"><div class="dchead">FACTS · 12m</div>' +
    '<div class="dgreply"><span class="dgrlabel">LAST REPLY</span> &quot;Done.&quot;</div>' +
    '<div class="dgline">1 commit: fix: x</div><div class="dgline">Tests: 14 passed, 0 failed</div></div>');
  // Facts without a reply, a reply without facts.
  assert.equal(sessionCard(withCard({ lastReply: '', lines: ['1 commit: fix: x'] }), 'a'),
    '<div class="dcard"><div class="dchead">FACTS · 12m</div><div class="dgline">1 commit: fix: x</div></div>');
  assert.equal(sessionCard(withCard({ lastReply: 'Done.', lines: [] }), 'a'),
    '<div class="dcard"><div class="dchead">FACTS · 12m</div><div class="dgreply"><span class="dgrlabel">LAST REPLY</span> &quot;Done.&quot;</div></div>');
  // A card with no time reads FACTS alone.
  assert.match(sessionCard(withCard({ lastTurnTs: null, lines: ['l'] }), 'a'), /^<div class="dcard"><div class="dchead">FACTS<\/div>/);
  // The same four fact lines the digest's open card keeps; not tappable.
  assert.equal(count(sessionCard(withCard({ lines: ['1', '2', '3', '4', '5', '6'] }), 'a'), /class="dgline"/g), 4);
  assert.doesNotMatch(html, /data-action|<a |<button/);
});

test('the session card is nothing without a card, for a NucBox session, or with nothing to say', () => {
  assert.equal(sessionCard(baseState({ digest: null }), 'a'), '');
  assert.equal(sessionCard(withCard(), 'other'), '');
  assert.equal(sessionCard(withCard({ lines: ['l'] }, { details: { a: { machine: 'NucBox' } } }), 'a'), '');
  assert.equal(sessionCard(withCard({ lastReply: '', lines: [] }), 'a'), '', 'a header over nothing is noise');
  assert.equal(sessionCard(withCard({ lastReply: '  ', lines: ['', '  ', 5, null] }), 'a'), '');
});

test('the session card text is escaped and cut', () => {
  const html = sessionCard(withCard({ lastReply: INJECT, lines: [INJECT] }), 'a');
  assert.ok(!html.includes('<img'));
  assert.equal(count(html, /&lt;img src=x onerror=alert\(1\)&gt;/g), 2);
  const big = sessionCard(withCard({ lastReply: 'x'.repeat(100 * 1024), lines: ['y'.repeat(100 * 1024), 'z'.repeat(100 * 1024)] }), 'a');
  assert.ok(big.length < 1500, 'the card is ' + big.length + ' bytes');
});

test('the ambient line is the newest card: age, title, and the last reply quoted', () => {
  assert.equal(ambientLine(ambientState()), '<div class="adigest">12m · Panel brightness tuning — &quot;The dial now dims in 5% steps.&quot;</div>');
  // No reply: the age and the title say it.
  assert.equal(ambientLine(ambientState({ lastReply: '' })), '<div class="adigest">12m · Panel brightness tuning</div>');
  // A blank title reads "session", as in the list.
  assert.equal(ambientLine(ambientState({ title: '  ', lastReply: '' })), '<div class="adigest">12m · session</div>');
  // Not tappable.
  assert.doesNotMatch(ambientLine(ambientState()), /data-action|<a |<button/);
});

test('the ambient line hides while anything waits, with no cards, and when the newest card is 12 hours old or more', () => {
  assert.equal(ambientLine(ambientState({ asks: [{ id: 'k' }] })), '');
  assert.equal(ambientLine(ambientState({ asks: [{ id: 'k' }, { id: 'l' }] })), '');
  assert.equal(ambientLine(baseState({ digest: null })), '');
  assert.equal(ambientLine(baseState({ digest: digest({ cards: [] }) })), '');
  assert.equal(ambientLine(ambientState({ ageMs: 13 * 3600e3 })), '');
  assert.equal(ambientLine(ambientState({ ageMs: 12 * 3600e3 })), '', '12 hours is too old');
  assert.match(ambientLine(ambientState({ ageMs: 12 * 3600e3 - 5000 })), /class="adigest">11h · /);
  assert.match(ambientLine(ambientState({ ageMs: 30e3 })), /class="adigest">now · /);
  assert.match(ambientLine(ambientState({ ageMs: -5 * 60e3 })), /class="adigest">now · /, 'a clock behind the Mac still reads as now');
});

test('the ambient line waits on what the clock counts as waiting: an UPDATE card or an expired notice is no wait', () => {
  const update = { kind: 'card', id: 'card:u:1', sessionId: 'u', tag: 'update', loud: false };
  const quietAsking = { kind: 'card', id: 'card:q:1', sessionId: 'q', tag: 'asking', loud: false };
  const expired = { kind: 'permission', id: 'p', expired: true };
  assert.match(ambientLine(ambientState({ asks: [update] })), /class="adigest">12m · /, 'a lone UPDATE card');
  assert.match(ambientLine(ambientState({ asks: [update, expired] })), /class="adigest">12m · /, 'and an expired notice');
  for (const asks of [[quietAsking], [{ ...quietAsking, loud: true }], [update, { id: 'k' }]]) {
    assert.equal(ambientLine(ambientState({ asks })), '', JSON.stringify(asks));
  }
  // On the clock screen: the calm head and the line, or the count and no line.
  const calm = renderAmbient(ambientState({ asks: [update] }));
  assert.match(calm, /NOTHING BLOCKED/); assert.match(calm, /class="adigest"/);
  const waiting = renderAmbient(ambientState({ asks: [quietAsking] }));
  assert.match(waiting, /1 WAITING/); assert.doesNotMatch(waiting, /adigest/);
});

test('the ambient line comes from the digest\'s first usable card, and a card with no time is not a recent one', () => {
  const s = baseState({ digest: digest({ cards: [
    { sessionId: 7, title: 'unusable', lastTurnTs: now() }, null, card({ sessionId: 'b', title: 'Newest', lastReply: 'r', lastTurnTs: now() - 5 * 60e3 }),
    card({ sessionId: 'c', title: 'Older', lastReply: 'o', lastTurnTs: now() - 50 * 60e3 }),
  ] }) });
  assert.equal(ambientLine(s), '<div class="adigest">5m · Newest — &quot;r&quot;</div>');
  for (const ts of [undefined, null, 0, -1, NaN, Infinity, 'x', {}]) assert.equal(ambientLine(ambientState({ lastTurnTs: ts })), '', String(ts));
});

test('the ambient line is cut to 64 characters and an ellipsis, on whole characters', () => {
  const long = ambientLine(ambientState({ lastReply: 'x'.repeat(200) }));
  const text = plain(long);
  assert.ok(text.length <= 65);
  assert.equal(text, '12m · Panel brightness tuning — "' + 'x'.repeat(64 - '12m · Panel brightness tuning — "'.length) + '…');
  assert.equal(text.length, 65);
  // Under the cut, nothing is added.
  assert.equal(plain(ambientLine(ambientState({ lastReply: 'short' }))), '12m · Panel brightness tuning — "short"');
  // Exactly 64 stays whole; 65 is cut.
  const head = '12m · Panel brightness tuning — "';
  assert.equal(plain(ambientLine(ambientState({ lastReply: 'x'.repeat(64 - head.length - 1) }))).length, 64);
  assert.equal(plain(ambientLine(ambientState({ lastReply: 'x'.repeat(64 - head.length) }))).slice(-1), '…');
  // The cut never splits a surrogate pair: the 64th character here is the first half of an emoji.
  const emoji = plain(ambientLine(ambientState({ lastReply: 'y'.repeat(64 - head.length - 1) + '\u{1F600}' + 'z'.repeat(50) })));
  assert.doesNotMatch(emoji, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  assert.ok(emoji.endsWith('…') && emoji.length <= 65);
});

test('the ambient line is escaped, and cut before it is escaped', () => {
  const html = ambientLine(ambientState({ title: INJECT, lastReply: INJECT }));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  // The cut is on the text, so an entity is never cut in half: 30 ampersands are 30 characters, then the rest.
  const amp = ambientLine(ambientState({ title: '&'.repeat(120), lastReply: '' }));
  assert.doesNotMatch(amp, /&(?!amp;)/);
  assert.equal(count(amp, /&amp;/g), 64 - '12m · '.length);
  const quote = ambientLine(ambientState({ lastReply: '"><script>x</script>' }));
  assert.ok(!quote.includes('<script'));
  const big = ambientLine(ambientState({ title: 'x'.repeat(100 * 1024), lastReply: 'y'.repeat(100 * 1024) }));
  assert.ok(big.length < 200, 'the line is ' + big.length + ' bytes');
});

test('the strip, the card and the ambient line never throw on hostile input, and say something sensible', () => {
  const hostile = [undefined, null, 0, 1, true, 'x', [], {}, () => 1,
    { digest: null }, { digest: 'x' }, { digest: [] }, { digest: { cards: null } }, { digest: { cards: 'x' } }, { digest: { cards: {} } },
    { digest: { cards: [null, 1, 'x', [], {}, { sessionId: 5 }, { sessionId: 'a' }] } },
    { digest: { cards: [{ sessionId: 'a', title: {}, lastReply: [], lines: 'x', lastTurnTs: 'x' }] }, asks: 'x', details: 'x', sessions: 'x' },
    { digest: { cards: [{ sessionId: 'a', title: 5, lastReply: 5, lines: [5, {}, null], lastTurnTs: {} }] }, asks: null, details: null, sessions: null },
    { digest: { cards: [{ sessionId: 'a', title: 'T', lastReply: 'r', lastTurnTs: now() }] }, asks: undefined, details: [], sessions: [null, 1, 'x', {}] },
    { digest: { cards: [{ sessionId: 'a', title: 'T', lastReply: 'r', lastTurnTs: now() }] }, details: { a: null }, asks: {} },
    { digest: { cards: [{ sessionId: 'a', title: 'T', lastReply: 'r', lastTurnTs: now() }] }, details: { a: 'x' }, asks: { length: 0 } },
    withCard({ title: 'x'.repeat(100 * 1024), lastReply: 'y'.repeat(100 * 1024), lines: ['z'.repeat(100 * 1024)] }),
    withCard({ title: INJECT, lastReply: INJECT, lines: [INJECT] }),
  ];
  for (const s of hostile) {
    for (const id of ['a', undefined, null, 5, {}, '__proto__', 'x'.repeat(1000)]) {
      assert.equal(typeof sessionStrip(s, id), 'string');
      assert.equal(typeof sessionCard(s, id), 'string');
    }
    const line = ambientLine(s);
    assert.equal(typeof line, 'string');
    assert.ok(line === '' || /^<div class="adigest">[^<>]*<\/div>$/.test(line), 'one div of escaped text: ' + line.slice(0, 80));
  }
  // asks that is not a list still counts as something waiting when it has a length; missing, it is not.
  assert.equal(ambientLine({ digest: digest({}), asks: 'x' }), '');
  assert.match(ambientLine({ digest: digest({}) }), /class="adigest"/);
});

test('the strip, the card and the ambient line change nothing they are given, and repeat', () => {
  const frozen = (v) => { if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); Object.values(v).forEach(frozen); } return v; };
  const s = frozen(detailState({ lines: ['l'] }));
  const a = frozen(ambientState());
  assert.equal(sessionStrip(s, 'a'), sessionStrip(s, 'a'));
  assert.equal(sessionCard(s, 'a'), sessionCard(s, 'a'));
  assert.equal(ambientLine(a), ambientLine(a));
});
