// Facts-only cards and the Digest snapshot (agents.js, card.js). Transcripts and sessions are
// synthetic; planted secrets are built by concatenation (fixtures/digest/secrets.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createExtractor } from '../src/digest/extract.js';
import { readAgentFacts } from '../src/digest/agents.js';
import { cardLines, buildCard, buildDigest, emptyDigest } from '../src/digest/card.js';
import { SECRETS } from './fixtures/digest/secrets.js';

const fx = (name) => fileURLToPath(new URL('./fixtures/digest/' + name, import.meta.url));
const NOW = Date.parse('2026-11-06T12:00:00.000Z');
const HOUR = 3600e3;

function factsOf(file) {
  const ex = createExtractor({ sessionId: 'sess-1' });
  let end = 0;
  for (const line of fs.readFileSync(fx(file), 'utf8').split('\n').slice(0, -1)) {
    end += Buffer.byteLength(line) + 1;
    let record = null;
    try { record = JSON.parse(line); } catch {}
    ex.push(record, end);
  }
  return ex.snapshot();
}
const toolsFacts = factsOf('tools.jsonl');
const rec = (facts, agents) => ({ path: '/p/s1.jsonl', mtimeMs: NOW, ended: false, facts, agents });
const oneTurn = (fields) => ({ ...structuredClone(toolsFacts), turns: [{ ...fields }] });
const NO_AGENTS = { finished: 0, running: 0, list: [] };
const AGENTS = { finished: 2, running: 1, list: [{ id: 'A1', description: 'Review Task 4', finished: true },
  { id: 'A2', description: 'Review Task 5', finished: true }, { id: 'A3', description: 'Explore', finished: false }] };
const file = (p, created, added, removed) => ({ id: 'F1', path: p, created, added, removed });
// The session totals a transcript would have if the stored turns were all of it.
const stored = (facts) => {
  const turns = facts.turns.filter((t) => t && typeof t === 'object');
  const paths = new Set(turns.flatMap((t) => (t.files || []).map((f) => f.path)));
  const prs = new Set(turns.flatMap((t) => (t.git || []).filter((g) => g.kind === 'pr').map((g) => g.number)));
  const commits = turns.reduce((n, t) => n + (t.commits || []).length, 0);
  return { ...facts, totals: { ...facts.totals, files: paths.size, commits, prs: prs.size } };
};
const deepFreeze = (v) => { if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); Object.values(v).forEach(deepFreeze); } return v; };

// ---- the brief's tests -------------------------------------------------------------------------

test('facts-only lines: files, tests, commits, PRs, agents, at most four', () => {
  assert.deepEqual(cardLines(toolsFacts, AGENTS), ['Edited 2 files: src/a.js, +1', 'Tests: failed', '2 commits: feat(digest): facts only, +1', 'PR #14']);
  assert.deepEqual(cardLines(oneTurn({ tests: [{ id: 'T1', command: 'go test', outcome: { status: 'not-reported' } }] }), AGENTS),
    ['Tests: ran, outcome not reported', '2 agents finished: Review Task 5']);
});

test('a card has exactly the protocol fields, facts-only', () => {
  const card = buildCard('s1', rec(toolsFacts, AGENTS), { live: true });
  assert.deepEqual(Object.keys(card).sort(), ['behindTurns', 'ended', 'facts', 'lastReply', 'lastTurnTs', 'lines', 'project', 'sessionId', 'summary', 'title']);
  assert.deepEqual([card.summary, card.behindTurns, card.lastReply], [null, 0, 'All done.']);
  assert.deepEqual(card.facts, { turns: 1, files: 2, commits: 2, prs: 1, tests: { passed: 41, failed: 0, runs: 3 }, agents: { finished: 2, running: 1 } });
  assert.equal(buildCard('s1', rec(toolsFacts, AGENTS), { live: false }).ended, true);
});

// 25 sessions in the window, one outside it, one with no human prompt
const session = (i, over = {}) => rec({ ...toolsFacts, hasHumanPrompt: true, lastTurnTs: NOW - i * 60e3, title: 't' + i,
  turnLog: [{ endTs: NOW - i * 60e3, commits: 2, prs: 1, testRuns: 3 }, { endTs: NOW - i * 60e3 - 1000, commits: 1, prs: 0, testRuns: 0 }], ...over }, AGENTS);
function fleet() {
  const sessions = {};
  for (let i = 24; i >= 0; i--) sessions['in' + String(i).padStart(2, '0')] = session(i);
  sessions.old = session(0, { lastTurnTs: NOW - 25 * HOUR, turnLog: [{ endTs: NOW - 25 * HOUR, commits: 9, prs: 9, testRuns: 9 }] });
  sessions.noprompt = session(0, { hasHumanPrompt: false });
  return sessions;
}

test('the digest: window, newest first, at most 20 cards, fleet totals over the window, summarizer off', () => {
  const d = buildDigest(fleet(), { now: NOW, windowHours: 24, maxCards: 20, isLive: () => true });
  assert.deepEqual(d.summarizer, { state: 'off', model: null, lastOkTs: null });
  assert.deepEqual([d.windowHours, d.cards.length, d.totals.sessions], [24, 20, 25]);
  assert.ok(d.cards.every((c, i) => i === 0 || d.cards[i - 1].lastTurnTs >= c.lastTurnTs));
  assert.deepEqual(d.cards.map((c) => c.sessionId).slice(0, 3), ['in00', 'in01', 'in02']);
  assert.deepEqual(d.cards.map((c) => c.title).slice(-1), ['t19']);
  assert.equal(d.updatedTs, NOW);
});

// ---- the digest, in detail ---------------------------------------------------------------------

test('fleet totals sum the in-window turn-log entries of every kept session, not only the cards shown', () => {
  const d = buildDigest(fleet(), { now: NOW, windowHours: 24, maxCards: 3, isLive: () => true });
  assert.deepEqual(d.totals, { sessions: 25, turns: 50, commits: 75, prs: 25, testRuns: 75 });
  assert.equal(d.cards.length, 3);
});

test('the window is inclusive at its edge, and a turn-log entry outside it is not counted', () => {
  const cutoff = NOW - 24 * HOUR;
  const sessions = {
    edge: session(0, { lastTurnTs: cutoff, turnLog: [{ endTs: cutoff, commits: 1, prs: 0, testRuns: 0 }, { endTs: cutoff - 1, commits: 100, prs: 100, testRuns: 100 }] }),
    before: session(0, { lastTurnTs: cutoff - 1 }),
  };
  const d = buildDigest(sessions, { now: NOW, windowHours: 24, maxCards: 20, isLive: () => true });
  assert.deepEqual(d.cards.map((c) => c.sessionId), ['edge']);
  assert.deepEqual(d.totals, { sessions: 1, turns: 1, commits: 1, prs: 0, testRuns: 0 });
  assert.deepEqual(buildDigest(sessions, { now: NOW, windowHours: 1, maxCards: 20, isLive: () => true }).cards, []);
});

test('isLive decides ended, and is asked only for the cards shown', () => {
  const asked = [];
  const sessions = { a: session(1), b: session(2), c: session(3, { }) };
  sessions.c.ended = true;
  const d = buildDigest(sessions, { now: NOW, windowHours: 24, maxCards: 2, isLive: (id) => { asked.push(id); return id === 'a'; } });
  assert.deepEqual(asked, ['a', 'b']);
  assert.deepEqual(d.cards.map((c) => [c.sessionId, c.ended]), [['a', false], ['b', true]]);
  assert.equal(buildDigest({ c: sessions.c }, { now: NOW, windowHours: 24, maxCards: 2, isLive: () => true }).cards[0].ended, true, 'a session that sent SessionEnd is ended however live it looks');
});

test('an empty or garbage session map gives an empty digest, and so does emptyDigest', () => {
  const empty = { updatedTs: NOW, windowHours: 24, summarizer: { state: 'off', model: null, lastOkTs: null }, totals: { sessions: 0, turns: 0, commits: 0, prs: 0, testRuns: 0 }, cards: [] };
  assert.deepEqual(emptyDigest(NOW), empty);
  assert.deepEqual(buildDigest({}, { now: NOW, windowHours: 24, maxCards: 20, isLive: () => true }), empty);
  assert.deepEqual(buildDigest(null, { now: NOW, windowHours: 24, maxCards: 20, isLive: () => true }), empty);
  assert.deepEqual(buildDigest({ n: null, s: 'x', f: { facts: 3 }, g: { facts: {} } }, { now: NOW, windowHours: 24, maxCards: 20, isLive: () => true }), empty);
  assert.notEqual(emptyDigest(NOW).summarizer, emptyDigest(NOW).summarizer, 'each digest gets its own summarizer object');
  assert.deepEqual(emptyDigest(NOW, 48).windowHours, 48);
  const odd = buildDigest({ a: session(0, { lastTurnTs: Date.now() }) }, { now: NaN, windowHours: -1, maxCards: 'many', isLive: () => true });
  assert.deepEqual([odd.windowHours, odd.cards.length, Number.isFinite(odd.updatedTs)], [24, 1, true], 'bad options fall back to the defaults');
});

test('a malformed turn-log entry is skipped and does not stop the totals', () => {
  const sessions = { a: session(1, { turnLog: [null, 'x', 5, { endTs: 'soon', commits: 4 }, { endTs: NOW, commits: 'many', prs: -3, testRuns: 2.9 }, { endTs: NOW, commits: 1 }] }) };
  assert.deepEqual(buildDigest(sessions, { now: NOW, windowHours: 24, maxCards: 20, isLive: () => true }).totals, { sessions: 1, turns: 2, commits: 1, prs: 0, testRuns: 2 });
});

test('buildDigest does not change its input, whose parts may be shared with the saved state', () => {
  const sessions = fleet();
  const before = structuredClone(sessions);
  deepFreeze(sessions);   // a write anywhere (a sort in place, a push) would throw in these strict modules
  const d = buildDigest(sessions, { now: NOW, windowHours: 24, maxCards: 20, isLive: () => true });
  assert.deepEqual(sessions, before);
  const card = d.cards[0];
  assert.notEqual(card.facts, sessions.in00.facts);
  assert.notEqual(card.facts.agents, sessions.in00.agents);
  assert.notEqual(card.lines, sessions.in00.facts.turns);
  assert.ok(Object.isFrozen(sessions.in00) && !Object.isFrozen(card) && !Object.isFrozen(card.facts) && !Object.isFrozen(card.lines), 'a card is a fresh, writable object');
});

test('5,000 sessions build in well under 500 ms', () => {
  const sessions = {};
  for (let i = 0; i < 5000; i++) sessions['s' + i] = session(i % 1400);
  const t0 = performance.now();
  const d = buildDigest(sessions, { now: NOW, windowHours: 24, maxCards: 20, isLive: () => true });
  const ms = performance.now() - t0;
  assert.deepEqual([d.totals.sessions, d.cards.length, d.totals.turns], [5000, 20, 10000]);
  assert.ok(ms < 500, `5,000 sessions took ${ms.toFixed(0)} ms`);
});

// ---- the lines ---------------------------------------------------------------------------------

test('lines: counts and plurals, the largest file across the stored turns, Created when every file was created', () => {
  const lines = (fields, agents = NO_AGENTS) => cardLines(stored(oneTurn(fields)), agents);
  assert.deepEqual(lines({ files: [file('a.js', true, 5, 0)] }), ['Created 1 file: a.js']);
  assert.deepEqual(lines({ files: [file('a.js', true, 5, 0), file('b.js', true, 9, 0)] }), ['Created 2 files: b.js, +1']);
  assert.deepEqual(lines({ files: [file('a.js', true, 5, 0), file('b.js', false, 1, 1)] }), ['Edited 2 files: a.js, +1']);
  assert.deepEqual(lines({ files: [file('a.js', false, 1, 1)] }), ['Edited 1 file: a.js']);
  assert.deepEqual(lines({ commits: [{ id: 'C1', subject: 'fix: one', sha: null }] }), ['1 commit: fix: one']);
  assert.deepEqual(lines({ commits: [{ id: 'C1', subject: null, sha: null }] }), ['1 commit: message not read']);
  assert.deepEqual(lines({ commits: [{ id: 'C1', subject: 'old', sha: null }, { id: 'C2', subject: 'new', sha: null }, { id: 'C3', subject: null, sha: null }] }), ['3 commits: new, +2']);
  assert.deepEqual(lines({ git: [{ id: 'G1', kind: 'pr', number: 14, action: 'created' }] }), ['PR #14']);
  assert.deepEqual(lines({ git: [{ id: 'G1', kind: 'push', branch: 'x' }, { id: 'G2', kind: 'pr', number: 14 }, { id: 'G3', kind: 'pr', number: 15 }] }), ['PRs #14, #15']);
  assert.deepEqual(lines({ git: [{ id: 'G1', kind: 'push', branch: 'x' }] }), []);
  assert.deepEqual(lines({}, { finished: 1, running: 0, list: [{ id: 'A1', description: 'Only one', finished: true }] }), ['1 agent finished: Only one']);
  assert.deepEqual(lines({}, { finished: 0, running: 2, list: [{ id: 'A1', description: 'x', finished: false }] }), []);
  assert.deepEqual(lines({ tests: [{ id: 'T1', command: 'npm test', outcome: { status: 'counted', passed: 7, failed: 2 } }] }), ['Tests: 7 passed, 2 failed']);
});

test('lines read the newest test run, the newest commit subject read, and merge a file touched in several turns', () => {
  const t = (fields) => ({ ...fields });
  const facts = { ...structuredClone(toolsFacts), turns: [
    t({ files: [file('a.js', false, 10, 0), file('b.js', false, 1, 0)], tests: [{ id: 'T1', command: 'x', outcome: { status: 'failed' } }],
      commits: [{ id: 'C1', subject: 'first', sha: null }], git: [{ id: 'G1', kind: 'pr', number: 3 }] }),
    t({ files: [file('b.js', false, 20, 0)], tests: [{ id: 'T2', command: 'x', outcome: { status: 'counted', passed: 5, failed: 0 } }, { id: 'T3', command: 'x', outcome: { status: 'counted', passed: 6, failed: 1 } }],
      commits: [{ id: 'C2', subject: 'second', sha: null }], git: [{ id: 'G2', kind: 'pr', number: 4 }] }),
    t({ reply: { id: 'R3', text: 'Nothing else.' } }),
  ] };
  assert.deepEqual(cardLines(stored(facts), NO_AGENTS), ['Edited 2 files: b.js, +1', 'Tests: 6 passed, 1 failed', '2 commits: second, +1', 'PRs #3, #4']);
  assert.deepEqual(cardLines(stored(facts), NO_AGENTS), cardLines(facts, NO_AGENTS), 'with the totals the stored turns give, the lines are the same');
});

test('PR numbers show the newest three of the stored turns; the rest count as +K', () => {
  const prs = (...numbers) => ({ git: numbers.map((n) => ({ id: 'G' + n, kind: 'pr', number: n })) });
  const facts = stored({ ...structuredClone(toolsFacts), turns: [prs(1, 2), prs(3, 4, 5)] });
  assert.deepEqual(cardLines(facts, NO_AGENTS), ['PRs #3, #4, #5, +2']);
});

test('a card with nothing in its stored turns has no lines and an empty last reply', () => {
  const card = buildCard('s1', rec({ ...structuredClone(toolsFacts), turns: [] }, NO_AGENTS), { live: true });
  assert.deepEqual([card.lines, card.lastReply], [[], '']);
});

test('lastReply is the first sentence of the newest reply, cut to 80 chars, from the newest turn that has one', () => {
  const long = 'This sentence has no end and just keeps on going past the eighty character limit of the card ok';
  const facts = { ...structuredClone(toolsFacts), turns: [{ reply: { id: 'R1', text: 'Old news. More.' } }, { reply: { id: 'R2', text: long } }, { reply: null }, {}] };
  const card = buildCard('s1', rec(facts, NO_AGENTS), { live: true });
  assert.ok(card.lastReply.length <= 80 && card.lastReply.endsWith('…') && long.startsWith(card.lastReply.slice(0, -1)));
  assert.equal(buildCard('s1', rec({ ...facts, turns: facts.turns.slice(0, 1) }, NO_AGENTS), { live: true }).lastReply, 'Old news.');
});

test('facts.tests: null without runs; counts come from the newest counted outcome; null counts when none was counted', () => {
  const t = (outcome) => ({ tests: [{ id: 'T1', command: 'x', outcome }] });
  const card = (turns, runs) => buildCard('s', rec({ ...structuredClone(toolsFacts), turns, totals: { ...toolsFacts.totals, testRuns: runs } }, NO_AGENTS), { live: true }).facts.tests;
  assert.equal(card([t({ status: 'counted', passed: 1, failed: 0 })], 0), null);
  assert.deepEqual(card([t({ status: 'counted', passed: 1, failed: 0 }), t({ status: 'counted', passed: 8, failed: 3 }), t({ status: 'failed' })], 9), { passed: 8, failed: 3, runs: 9 });
  assert.deepEqual(card([t({ status: 'failed' }), t({ status: 'not-reported' })], 2), { passed: null, failed: null, runs: 2 });
});

test('an ended card shows no running agents: they finished with the session', () => {
  const live = buildCard('s1', rec(toolsFacts, AGENTS), { live: true });
  const ended = buildCard('s1', rec(toolsFacts, AGENTS), { live: false });
  assert.deepEqual([live.facts.agents, ended.facts.agents], [{ finished: 2, running: 1 }, { finished: 3, running: 0 }]);
  assert.deepEqual(AGENTS.list[2], { id: 'A3', description: 'Explore', finished: false }, 'the stored agents are not changed');
});

// ---- counts in the lines are the session's; names and subjects are the stored turns' --------------

const named = () => ({ ...structuredClone(toolsFacts), turns: [{
  files: Array.from({ length: 8 }, (_, i) => file('f' + i, false, i === 3 ? 90 : 1 + i, 0)),
  commits: Array.from({ length: 5 }, (_, i) => ({ id: 'C' + i, subject: 'c' + i, sha: null })),
  git: [11, 12, 13].map((n) => ({ id: 'G' + n, kind: 'pr', number: n })),
}] });
const withTotals = (facts, totals) => ({ ...facts, totals });
const T = (files, commits, prs) => ({ turns: 1, files, commits, prs, testRuns: 0 });

test('lines count what the session did, from its totals, and name what the stored turns show', () => {
  const facts = withTotals(named(), T(20, 9, 5));
  assert.deepEqual(cardLines(facts, NO_AGENTS), ['Edited 20 files: f3, +19', '9 commits: c4, +8', 'PRs #11, #12, #13, +2']);
  const card = buildCard('s1', rec(facts, NO_AGENTS), { live: true });
  assert.deepEqual(card.lines, ['Edited 20 files: f3, +19', '9 commits: c4, +8', 'PRs #11, #12, #13, +2']);
  assert.deepEqual([card.facts.files, card.facts.commits, card.facts.prs], [20, 9, 5], 'the same counts as the facts row');
  assert.deepEqual(cardLines(withTotals(named(), T(8, 5, 3)), NO_AGENTS), ['Edited 8 files: f3, +7', '5 commits: c4, +4', 'PRs #11, #12, #13']);
});

test('a total that is missing, not an integer, negative or below what the stored turns show falls back to the stored count', () => {
  const stored8 = ['Edited 8 files: f3, +7', '5 commits: c4, +4', 'PRs #11, #12, #13'];
  for (const v of [undefined, null, '20', '9', NaN, Infinity, -Infinity, 20.5, -20, 0, 2, {}, [], true]) {
    assert.deepEqual(cardLines(withTotals(named(), T(v, v, v)), NO_AGENTS), stored8, String(v));
  }
});

test('each total is checked on its own: below the stored count, only that line falls back', () => {
  assert.deepEqual(cardLines(withTotals(named(), T(3, 12, 1)), NO_AGENTS), ['Edited 8 files: f3, +7', '12 commits: c4, +11', 'PRs #11, #12, #13']);
  assert.deepEqual(cardLines(withTotals(named(), T(30, 2, 3)), NO_AGENTS), ['Edited 30 files: f3, +29', '5 commits: c4, +4', 'PRs #11, #12, #13']);
});

test('totals that are not an object, or have no counts, fall back to the stored turns', () => {
  const stored8 = ['Edited 8 files: f3, +7', '5 commits: c4, +4', 'PRs #11, #12, #13'];
  for (const totals of [undefined, null, 3, 'x', [], {}]) assert.deepEqual(cardLines(withTotals(named(), totals), NO_AGENTS), stored8, JSON.stringify(totals));
  assert.equal(buildCard('s1', rec(withTotals(named(), 3), NO_AGENTS), { live: true }).lines[0], 'Edited 8 files: f3, +7');
});

test('Created needs every counted file to be known created: totals above the stored files say Edited', () => {
  const made = (totals) => ({ ...structuredClone(toolsFacts), turns: [{ files: [file('new/a.js', true, 5, 0), file('new/b.js', true, 9, 0)] }], totals });
  assert.deepEqual(cardLines(made(T(2, 0, 0)), NO_AGENTS), ['Created 2 files: new/b.js, +1']);
  assert.deepEqual(cardLines(made(T(5, 0, 0)), NO_AGENTS), ['Edited 5 files: new/b.js, +4']);
  assert.deepEqual(cardLines(made(T(1, 0, 0)), NO_AGENTS), ['Created 2 files: new/b.js, +1'], 'a total below the stored count falls back to it');
  assert.deepEqual(cardLines(made(undefined), NO_AGENTS), ['Created 2 files: new/b.js, +1']);
  const mixed = { ...structuredClone(toolsFacts), turns: [{ files: [file('new/a.js', true, 5, 0), file('old/b.js', false, 9, 0)] }], totals: T(2, 0, 0) };
  assert.deepEqual(cardLines(mixed, NO_AGENTS), ['Edited 2 files: old/b.js, +1']);
});

test('the PR line says PRs when the session has several, even if only one is named, and names at most three', () => {
  const one = (totals) => ({ ...structuredClone(toolsFacts), turns: [{ git: [{ id: 'G1', kind: 'pr', number: 14 }] }], totals });
  assert.deepEqual(cardLines(one(T(0, 0, 1)), NO_AGENTS), ['PR #14']);
  assert.deepEqual(cardLines(one(T(0, 0, 4)), NO_AGENTS), ['PRs #14, +3']);
  assert.deepEqual(cardLines(one(T(0, 0, 0)), NO_AGENTS), ['PR #14']);
  const many = { ...structuredClone(toolsFacts), turns: [{ git: [1, 2, 3].map((n) => ({ id: 'G' + n, kind: 'pr', number: n })) }, { git: [{ id: 'G4', kind: 'pr', number: 4 }] }], totals: T(0, 0, 9) };
  assert.deepEqual(cardLines(many, NO_AGENTS), ['PRs #2, #3, #4, +6']);
});

test('a total with nothing stored to name gives no line', () => {
  assert.deepEqual(cardLines(withTotals(oneTurn({}), T(20, 9, 5)), NO_AGENTS), []);
});

test('the counts with consistent totals read as before', () => {
  assert.deepEqual(cardLines(toolsFacts, NO_AGENTS), ['Edited 2 files: src/a.js, +1', 'Tests: failed', '2 commits: feat(digest): facts only, +1', 'PR #14']);
});

// ---- persisted state is only shape-checked at the record level ---------------------------------

test('a record with title: null, a non-string project, or no totals still makes a sensible card', () => {
  const facts = { ...structuredClone(toolsFacts), title: null, project: 5, totals: { turns: 'x', files: null, commits: -4, prs: NaN, testRuns: {} }, lastTurnTs: 7 };
  const card = buildCard('s1', rec(facts, NO_AGENTS), { live: true });
  assert.deepEqual([card.title, card.project, card.lastTurnTs], ['session', '', 7]);
  assert.deepEqual(card.facts, { turns: 0, files: 0, commits: 0, prs: 0, tests: null, agents: { finished: 0, running: 0 } });
  const blank = buildCard('s1', rec({ ...facts, title: '  ', project: undefined }, NO_AGENTS), { live: true });
  assert.deepEqual([blank.title, blank.project], ['session', '']);
});

test('a turn missing most of its fields, or not an object, is read as far as it goes and never throws', () => {
  const bad = [null, 'x', 7, [], {}, { files: 'no', commits: 5, git: {}, tests: 'x', reply: 3 }, { files: [null, 4, { path: 7 }, { path: '' }, file('keep.js', false, 2, 0)],
    commits: [null, { subject: 5 }], git: [null, { kind: 'pr' }, { kind: 'pr', number: 'x' }], tests: [null, { outcome: 'x' }, { id: 'T', outcome: null }], reply: { text: 5 } }];
  const facts = { ...structuredClone(toolsFacts), turns: bad, totals: { ...toolsFacts.totals, files: 1, commits: 1, prs: 0 } };
  assert.doesNotThrow(() => cardLines(facts, undefined));
  assert.deepEqual(cardLines(facts, undefined), ['Edited 1 file: keep.js', 'Tests: ran, outcome not reported', '1 commit: message not read']);
  const card = buildCard('s1', rec(facts, null), { live: true });
  assert.deepEqual([card.lastReply, card.facts.agents], ['', { finished: 0, running: 0 }]);
  assert.doesNotThrow(() => buildCard('s1', rec({ ...facts, turns: 'nope', totals: 3 }, 'x'), { live: true }));
  assert.doesNotThrow(() => buildCard('s1', null, { live: true }));
  assert.doesNotThrow(() => buildCard('s1', {}, undefined));
  assert.deepEqual(buildCard('s1', {}, undefined).lines, []);
});

test('agents.list with a non-object, or fields of the wrong type, is skipped', () => {
  const agents = { finished: 2, running: 'x', list: [null, 5, 'x', [], { id: 'A1', description: 7, finished: true }, { id: 'A2', description: 'Real one', finished: true }, { description: 'Later, running', finished: false }] };
  assert.deepEqual(cardLines(oneTurn({}), agents), ['2 agents finished: Real one']);
  const card = buildCard('s1', rec(toolsFacts, agents), { live: true });
  assert.deepEqual(card.facts.agents, { finished: 2, running: 0 });
  assert.doesNotThrow(() => cardLines(oneTurn({}), { finished: 3, list: 'nope' }));
  assert.deepEqual(cardLines(oneTurn({}), { finished: 3, list: 'nope' }), ['3 agents finished']);
});

test('hand-edited state with huge arrays and long strings is read in bounded work', () => {
  const huge = 'q'.repeat(300 * 1024);
  const turn = { files: Array.from({ length: 50000 }, (_, i) => file('f' + i, false, 1, 0)), commits: Array.from({ length: 50000 }, () => ({ subject: 's', sha: null })), reply: { text: huge } };
  const facts = { ...structuredClone(toolsFacts), title: huge, project: huge, turns: Array.from({ length: 5000 }, () => turn) };
  const agents = { finished: 1, running: 0, list: Array.from({ length: 50000 }, () => ({ description: huge, finished: true })) };
  const t0 = performance.now();
  const card = buildCard('s1', rec(facts, agents), { live: true });
  const ms = performance.now() - t0;
  assert.ok(ms < 300, `took ${ms.toFixed(0)} ms`);
  assert.ok(card.title.length <= 120 && card.project.length <= 120 && card.lastReply.length <= 80 && card.lines.every((l) => l.length <= 240), 'text is capped');
});

// ---- redaction, once more at the card ---------------------------------------------------------

const JOINED = 'sk-' + 'ant-' + 'A1b2'.repeat(6);
test('a secret in a persisted title, project, path, subject, reply or agent description never reaches the card', () => {
  for (const [category, text, needle = text] of SECRETS) {
    const facts = { ...structuredClone(toolsFacts), title: 'T ' + text, project: 'P ' + text, turns: [{
      files: [file('src/' + text + '.js', false, 1, 1)], commits: [{ id: 'C1', subject: 'fix ' + text, sha: null }],
      tests: [], git: [], reply: { id: 'R1', text: 'Done ' + text + '. More.' } }] };
    const agents = { finished: 1, running: 0, list: [{ id: 'A1', description: 'Review ' + text, finished: true }] };
    const out = JSON.stringify(buildCard('s1', rec(facts, agents), { live: true }));
    assert.ok(!out.includes(needle), `${category} survived in the card`);
    const digest = JSON.stringify(buildDigest({ s1: { ...rec({ ...facts, hasHumanPrompt: true, lastTurnTs: NOW }, agents) } }, { now: NOW, windowHours: 24, maxCards: 20, isLive: () => true }));
    assert.ok(!digest.includes(needle), `${category} survived in the digest`);
  }
});

test('markdown that firstSentence strips cannot reassemble a secret in lastReply', () => {
  const split = 'sk-`' + 'ant-' + 'A1b2'.repeat(6) + '`';
  const card = buildCard('s1', rec({ ...structuredClone(toolsFacts), turns: [{ reply: { id: 'R1', text: 'Key is ' + split + ' ok' } }] }, NO_AGENTS), { live: true });
  assert.ok(!card.lastReply.includes(JOINED), card.lastReply);
});

// ---- readAgentFacts ----------------------------------------------------------------------------

function agentDir(specs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-'));
  fs.mkdirSync(path.join(dir, 'subagents'));
  specs.forEach(({ id, meta, text }, i) => {
    const metaFile = path.join(dir, 'subagents', `agent-${id}.meta.json`);
    fs.writeFileSync(metaFile, JSON.stringify(meta));
    fs.utimesSync(metaFile, 1000 + i, 1000 + i);   // oldest first, in the order given
    if (text !== undefined) fs.writeFileSync(path.join(dir, 'subagents', `agent-${id}.jsonl`),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n');
  });
  return dir;
}

test('agent facts: the last six by meta order with ids A<n>, finished and running counts, reports only for finished agents', () => {
  const specs = [];
  for (let i = 1; i <= 8; i++) specs.push({ id: 'x' + i, meta: { agentType: 'Explore', description: 'Task ' + i, finished: i !== 8 && i !== 5, stoppedByUser: i === 5 }, text: 'Report ' + i + '. Detail.' });
  const dir = agentDir(specs);
  const live = readAgentFacts(dir, { ended: false });
  assert.deepEqual([live.finished, live.running], [7, 1]);
  assert.deepEqual(live.list.map((a) => [a.id, a.description, a.agentType, a.finished, a.report]), [
    ['A3', 'Task 3', 'Explore', true, 'Report 3. Detail.'], ['A4', 'Task 4', 'Explore', true, 'Report 4. Detail.'],
    ['A5', 'Task 5', 'Explore', true, null],   // stopped by the owner: not running, and never finished, so no report
    ['A6', 'Task 6', 'Explore', true, 'Report 6. Detail.'], ['A7', 'Task 7', 'Explore', true, 'Report 7. Detail.'],
    ['A8', 'Task 8', 'Explore', false, null]]);
  const ended = readAgentFacts(dir, { ended: true });
  assert.deepEqual([ended.finished, ended.running, ended.list[5].finished, ended.list[5].report], [8, 0, true, null]);
});

test('agent facts: a missing folder is none, and a finished agent without a transcript has no report', () => {
  assert.deepEqual(readAgentFacts('/nonexistent', { ended: false }), { finished: 0, running: 0, list: [] });
  const dir = agentDir([{ id: 'a', meta: { agentType: 'x', description: 'No transcript', finished: true } }]);
  assert.deepEqual(readAgentFacts(dir, { ended: false }).list, [{ id: 'A1', description: 'No transcript', agentType: 'x', finished: true, report: null }]);
});

test('agent facts: descriptions and reports are redacted and then cut; the description falls back to the type', () => {
  const secret = SECRETS[0][1];
  const dir = agentDir([
    { id: 'a', meta: { agentType: 'general-purpose', description: 'Review ' + secret + ' now\nplease', finished: true }, text: 'Found ' + secret + ' in the file. ' + 'z'.repeat(1000) },
    { id: 'b', meta: { agentType: 'Explore', finished: true }, text: 'x' },
    { id: 'c', meta: { finished: true }, text: 'y' },
    { id: 'd', meta: { agentType: 'x', description: 'p'.repeat(500), finished: true }, text: 'q'.repeat(2000) },
    { id: 'e', meta: { agentType: 'x', description: 'w '.repeat(58) + secret + ' tail', finished: true }, text: 'w '.repeat(148) + secret + ' tail' },   // the secret straddles the cut
  ]);
  const { list } = readAgentFacts(dir, { ended: false });
  assert.equal(list[0].description, 'Review [redacted] now please');
  assert.ok(list[0].report.startsWith('Found [redacted] in the file. zzz') && list[0].report.length === 300 && list[0].report.endsWith('…'));
  assert.deepEqual([list[1].description, list[2].description], ['Explore', 'agent']);
  assert.deepEqual([list[3].description.length, list[3].report.length], [120, 300]);
  assert.deepEqual([list[4].description.length, list[4].report.length], [120, 300]);
  assert.ok(list[4].report.endsWith('[re…'), 'cut after the redaction, so the secret was already one [redacted]');
  assert.ok(!JSON.stringify(list).includes(secret.slice(0, 11)), 'no part of a secret straddling a cut survives');
});

test('a secret in a subagent description or report never reaches the card or the digest', () => {
  for (const [category, text, needle = text] of SECRETS) {
    const dir = agentDir([{ id: 'a', meta: { agentType: 'x', description: 'Review ' + text, finished: true }, text: 'Report ' + text }]);
    const agents = readAgentFacts(dir, { ended: false });
    const facts = { ...structuredClone(toolsFacts), hasHumanPrompt: true, lastTurnTs: NOW };
    const out = JSON.stringify([agents, buildCard('s1', rec(facts, agents), { live: true }),
      buildDigest({ s1: rec(facts, agents) }, { now: NOW, windowHours: 24, maxCards: 20, isLive: () => true })]);
    assert.ok(!out.includes(needle), `${category} survived`);
    assert.ok(out.includes('Review'), 'the description is still there');
  }
});

test('reading the agent facts of a 3,000-agent session is quick and bounded', () => {
  const specs = [];
  for (let i = 0; i < 3000; i++) specs.push({ id: 'n' + i, meta: { agentType: 'a', description: 'd' + i, finished: i < 2990 }, text: i < 2990 ? 'r' + i : undefined });
  const dir = agentDir(specs);
  const t0 = performance.now();
  const facts = readAgentFacts(dir, { ended: false });
  const ms = performance.now() - t0;
  assert.deepEqual([facts.finished, facts.running, facts.list.length, facts.list[0].id, facts.list[5].id], [2990, 10, 6, 'A2995', 'A3000']);
  assert.ok(ms < 1500, `took ${ms.toFixed(0)} ms`);
});
