// The digest's persisted state: loaded with its shape checked, saved private (0600), pruned to the
// window, and written at most once every 10 s.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point the state dir at a scratch directory before anything reads config.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-thing-digest-state-'));
process.env.CLAUDE_THING_STATE_DIR = DIR;

const { loadDigestState, saveDigestState, pruneDigestState, createSaver } = await import('../src/digest/state.js');
const { createExtractor } = await import('../src/digest/extract.js');
const { BASE, human, asst, stopSummary } = await import('./fixtures/digest/build.js');

const FILE = path.join(DIR, 'digest.json');
const EMPTY = { version: 1, sessions: {} };
const HOUR = 3600000;
const NOW = BASE + 48 * HOUR;
const reset = () => fs.rmSync(FILE, { force: true });
const clone = (v) => JSON.parse(JSON.stringify(v));

// A real snapshot: one human turn closed by a stop summary, minutes after BASE.
function facts(sessionId = 'sess-1') {
  const ex = createExtractor({ sessionId });
  [human('Dim the dial', 0), asst('Done.', 1), stopSummary(1)].forEach((r, i) => ex.push(r, (i + 1) * 100));
  return ex.snapshot();
}
const agents = () => ({ finished: 1, running: 0, list: [{ id: 'A1', description: 'Review', agentType: 'reviewer', finished: true, report: 'Fine.' }] });
const record = (over = {}) => ({ path: '/p/sess-1.jsonl', mtimeMs: BASE + 60000, ended: false, facts: facts(), agents: agents(), ...over });
const writeRaw = (state) => fs.writeFileSync(FILE, JSON.stringify(state));

test('the digest state round-trips at 0600, unchanged byte for byte', () => {
  reset();
  const state = { version: 1, sessions: { 'sess-1': record(), 'sess-2': record({ ended: true, path: '/p/sess-2.jsonl' }) } };
  assert.equal(saveDigestState(state), true);
  assert.equal(fs.statSync(FILE).mode & 0o777, 0o600);
  const back = loadDigestState();
  assert.deepEqual(back, state);
  assert.equal(JSON.stringify(back), JSON.stringify(state));
  assert.deepEqual(fs.readdirSync(DIR).filter((f) => f.endsWith('.tmp')), []);
});

test('saving over a 0644 file leaves 0600', () => {
  fs.writeFileSync(FILE, '{}', { mode: 0o644 });
  assert.equal(saveDigestState(EMPTY), true);
  assert.equal(fs.statSync(FILE).mode & 0o777, 0o600);
});

test('a missing, corrupt or other-version file loads as empty', () => {
  reset(); assert.deepEqual(loadDigestState(), EMPTY);
  fs.writeFileSync(FILE, '{"version":1,"sessions":{"a":'); assert.deepEqual(loadDigestState(), EMPTY);
  writeRaw({ version: 2 }); assert.deepEqual(loadDigestState(), EMPTY);
  writeRaw({ version: 2, sessions: { 'sess-1': record() } }); assert.deepEqual(loadDigestState(), EMPTY);
  writeRaw({ sessions: { 'sess-1': record() } }); assert.deepEqual(loadDigestState(), EMPTY);
  writeRaw({ version: 1 }); assert.deepEqual(loadDigestState(), EMPTY);
  writeRaw({ version: 1, sessions: [record()] }); assert.deepEqual(loadDigestState(), EMPTY);
  writeRaw({ version: 1, sessions: null }); assert.deepEqual(loadDigestState(), EMPTY);
  writeRaw([1, 2]); assert.deepEqual(loadDigestState(), EMPTY);
  writeRaw(null); assert.deepEqual(loadDigestState(), EMPTY);
  fs.writeFileSync(FILE, '"text"'); assert.deepEqual(loadDigestState(), EMPTY);
});

test('a record that is not well formed is dropped on load and the rest are kept', () => {
  const good = record();
  const wrongTurns = record(); wrongTurns.facts.turns = 'six';
  const noFacts = record(); delete noFacts.facts;
  const badPath = record({ path: 42 });
  writeRaw({ version: 1, sessions: { good, 'wrong-turns': wrongTurns, 'no-facts': noFacts, 'bad-path': badPath } });
  const back = loadDigestState();
  assert.deepEqual(Object.keys(back.sessions), ['good']);
  assert.equal(JSON.stringify(back.sessions.good), JSON.stringify(good));
  assert.equal(back.version, 1);
});

test('each field the extractor and the card builder rely on is checked', () => {
  const bad = {
    'record is null': null,
    'record is an array': [],
    'record is a string': 'sess',
    'path missing': (r) => { delete r.path; },
    'mtimeMs is a string': (r) => { r.mtimeMs = '1'; },
    'mtimeMs is null (a NaN saved as null)': (r) => { r.mtimeMs = null; },
    'ended is a string': (r) => { r.ended = 'false'; },
    'agents missing': (r) => { delete r.agents; },
    'agents is an array': (r) => { r.agents = []; },
    'facts is an array': (r) => { r.facts = []; },
    'facts.turns is an object': (r) => { r.facts.turns = {}; },
    'facts.turnLog is null': (r) => { r.facts.turnLog = null; },
    'facts.seenFiles is a string': (r) => { r.facts.seenFiles = 'a.js'; },
    'facts.prNumbers is missing': (r) => { delete r.facts.prNumbers; },
    'facts.totals is a number': (r) => { r.facts.totals = 3; },
    'facts.next is missing': (r) => { delete r.facts.next; },
    'facts.offset is a string': (r) => { r.facts.offset = '300'; },
    'facts.offset is null': (r) => { r.facts.offset = null; },
    'facts.lastTurnTs is missing': (r) => { delete r.facts.lastTurnTs; },
    'facts.lastTurnTs is null': (r) => { r.facts.lastTurnTs = null; },
  };
  const sessions = { good: record() };
  for (const [name, mutate] of Object.entries(bad)) {
    if (typeof mutate === 'function') { const r = record(); mutate(r); sessions[name] = r; } else sessions[name] = mutate;
  }
  writeRaw({ version: 1, sessions });
  assert.deepEqual(Object.keys(loadDigestState().sessions), ['good']);
});

test('a session id named __proto__ stays a plain key', () => {
  fs.writeFileSync(FILE, '{"version":1,"sessions":{"__proto__":' + JSON.stringify(record()) + '}}');
  const back = loadDigestState();
  assert.deepEqual(Object.keys(back.sessions), ['__proto__']);
  assert.equal(Object.getPrototypeOf(back.sessions), Object.prototype);
});

function pruneState() {
  const old = record({ mtimeMs: NOW - 25 * HOUR }); old.facts.lastTurnTs = NOW - 26 * HOUR;
  const recent = record({ mtimeMs: NOW - 1 * HOUR });
  recent.facts.lastTurnTs = NOW - 2 * HOUR;
  recent.facts.turnLog = [
    { endTs: NOW - 30 * HOUR, commits: 1, prs: 0, testRuns: 0 },
    { endTs: NOW - 24 * HOUR, commits: 0, prs: 1, testRuns: 0 },   // exactly on the window edge: kept
    { endTs: NOW - 2 * HOUR, commits: 0, prs: 0, testRuns: 2 },
  ];
  return { version: 1, sessions: { old, recent } };
}

test('pruning drops sessions outside the window and trims their turn log', () => {
  const pruned = pruneDigestState(pruneState(), { now: NOW, windowMs: 24 * HOUR });
  assert.equal(pruned.version, 1);
  assert.deepEqual(Object.keys(pruned.sessions), ['recent']);
  assert.deepEqual(pruned.sessions.recent.facts.turnLog, [
    { endTs: NOW - 24 * HOUR, commits: 0, prs: 1, testRuns: 0 },
    { endTs: NOW - 2 * HOUR, commits: 0, prs: 0, testRuns: 2 },
  ]);
});

test('a session stays when either its last turn or its transcript is inside the window', () => {
  const state = { version: 1, sessions: {
    'turn-only': record({ mtimeMs: NOW - 40 * HOUR }),     // transcript old, last turn recent
    'mtime-only': record({ mtimeMs: NOW - 1 * HOUR }),     // never closed a turn (lastTurnTs 0), file touched recently
    'neither': record({ mtimeMs: NOW - 24 * HOUR - 1 }),
    'edge': record({ mtimeMs: NOW - 24 * HOUR }),
  } };
  state.sessions['turn-only'].facts.lastTurnTs = NOW - 3 * HOUR;
  state.sessions['mtime-only'].facts.lastTurnTs = 0;
  state.sessions.neither.facts.lastTurnTs = NOW - 24 * HOUR - 1;
  state.sessions.edge.facts.lastTurnTs = 0;
  const pruned = pruneDigestState(state, { now: NOW, windowMs: 24 * HOUR });
  assert.deepEqual(Object.keys(pruned.sessions), ['turn-only', 'mtime-only', 'edge']);
});

test('pruning does not change the state it was given', () => {
  const state = pruneState(), before = JSON.stringify(state);
  const pruned = pruneDigestState(state, { now: NOW, windowMs: 24 * HOUR });
  assert.equal(JSON.stringify(state), before);
  assert.notEqual(pruned, state);
  assert.notEqual(pruned.sessions.recent, state.sessions.recent);
  assert.notEqual(pruned.sessions.recent.facts.turnLog, state.sessions.recent.facts.turnLog);
  assert.equal(state.sessions.recent.facts.turnLog.length, 3);
  pruned.sessions.recent.facts.turnLog.length = 0;   // writing to the result never reaches the input
  assert.equal(state.sessions.recent.facts.turnLog.length, 3);
});

test('pruning drops turn-log entries that are not entries, and keeps the rest of a record as it was', () => {
  const state = { version: 1, sessions: { a: record() } };
  state.sessions.a.facts.turnLog = [null, 7, { endTs: 'x' }, { endTs: NOW, commits: 1, prs: 0, testRuns: 0 }];
  state.sessions.a.facts.lastTurnTs = NOW;
  const pruned = pruneDigestState(state, { now: NOW, windowMs: 24 * HOUR });
  const want = clone(state.sessions.a); want.facts.turnLog = [{ endTs: NOW, commits: 1, prs: 0, testRuns: 0 }];
  assert.deepEqual(pruned.sessions.a, want);
  assert.deepEqual(pruneDigestState({ version: 1, sessions: {} }, { now: NOW, windowMs: 24 * HOUR }), EMPTY);
});

test('a pruned state still loads and saves', () => {
  const pruned = pruneDigestState(pruneState(), { now: NOW, windowMs: 24 * HOUR });
  assert.equal(saveDigestState(pruned), true);
  assert.deepEqual(loadDigestState(), pruned);
});

// A fake clock: timers run when the clock reaches them.
function clock() {
  let t = 0, seq = 0; const timers = new Map(), cleared = [], unrefs = [];
  return {
    now: () => t,
    setTimer: (fn, ms) => { const h = { id: ++seq, unref() { unrefs.push(this.id); return this; } }; timers.set(h.id, { at: t + ms, fn, ms }); return h; },
    clearTimer: (h) => { cleared.push(h.id); timers.delete(h.id); },
    delays: () => [...timers.values()].map((x) => x.ms),
    pending: () => timers.size,
    cleared, unrefs,
    advance(to) {
      for (;;) {
        const due = [...timers.entries()].filter(([, x]) => x.at <= to).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); t = Math.max(t, due[1].at); due[1].fn();
      }
      t = to;
    },
  };
}
const saverWith = (c, extra = {}) => {
  const saved = [];
  const saver = createSaver({ save: (s) => { saved.push(s); return true; }, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, ...extra });
  return { saver, saved };
};

test('the saver writes at most once every 10 s and flush writes what is pending', () => {
  const c = clock(), { saver, saved } = saverWith(c);
  let n = 0; const get = () => ++n;
  saver.request(get); assert.deepEqual(saved, [1], 'the first request saves at once');
  c.advance(1000); saver.request(get);
  c.advance(2000); saver.request(get);
  assert.deepEqual(saved, [1], 'nothing more inside the interval');
  assert.deepEqual(c.delays(), [9000], 'one trailing timer, for the rest of the interval');
  c.advance(9999); assert.deepEqual(saved, [1]);
  c.advance(10000); assert.deepEqual(saved, [1, 2], 'the timer saves once, with the state as it is then');
  assert.equal(c.pending(), 0);
  c.advance(10500); saver.request(get); assert.deepEqual(saved, [1, 2]);
  saver.flush(); assert.deepEqual(saved, [1, 2, 3]);
  assert.equal(c.pending(), 0, 'flush clears the timer');
  c.advance(30000); assert.deepEqual(saved, [1, 2, 3], 'and the cleared timer never writes again');
});

test('a request after the interval has passed saves at once', () => {
  const c = clock(), { saver, saved } = saverWith(c);
  saver.request(() => 'a'); c.advance(10000); saver.request(() => 'b'); c.advance(25000); saver.request(() => 'c');
  assert.deepEqual(saved, ['a', 'b', 'c']);
  assert.equal(c.pending(), 0);
});

test('the saver reads the state when it saves, so the last request wins', () => {
  const c = clock(), { saver, saved } = saverWith(c);
  saver.request(() => 'first'); c.advance(1000);
  saver.request(() => 'second'); saver.request(() => 'third');
  assert.equal(c.pending(), 1);
  c.advance(10000);
  assert.deepEqual(saved, ['first', 'third']);
});

test('flush with nothing pending writes nothing', () => {
  const c = clock(), { saver, saved } = saverWith(c);
  saver.flush(); assert.deepEqual(saved, []);
  saver.request(() => 1); saver.flush(); assert.deepEqual(saved, [1]);
});

test('a custom interval sets both the spacing and the timer delay', () => {
  const c = clock(), { saver, saved } = saverWith(c, { intervalMs: 500 });
  saver.request(() => 1); c.advance(100); saver.request(() => 2);
  assert.deepEqual(c.delays(), [400]);
  c.advance(500); assert.deepEqual(saved, [1, 2]);
});

test('a clock that steps back never arms a timer longer than the interval', () => {
  const c = clock(), { saver, saved } = saverWith(c);
  c.advance(5000); saver.request(() => 1);
  c.advance(1000); saver.request(() => 2);
  assert.deepEqual(c.delays(), [10000]);
  c.advance(11000); assert.deepEqual(saved, [1, 2]);
});

test('stop clears the timer, drops what is pending and ignores later requests', () => {
  const c = clock(), { saver, saved } = saverWith(c);
  saver.request(() => 1); c.advance(1000); saver.request(() => 2);
  assert.equal(c.pending(), 1);
  saver.stop();
  assert.deepEqual(c.cleared, [1]);
  assert.equal(c.pending(), 0);
  c.advance(60000); saver.request(() => 3); saver.flush();
  assert.deepEqual(saved, [1]);
  assert.equal(c.pending(), 0);
  saver.stop();   // twice is fine
});

test('the saver never keeps the process alive: its timer is unref\'d', () => {
  const c = clock(), { saver } = saverWith(c);
  saver.request(() => 1); c.advance(1000); saver.request(() => 2);
  assert.deepEqual(c.unrefs, [1]);
  saver.stop();
});

test('the saver\'s real timer is unref\'d and stop clears it', () => {
  const idle = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  const base = idle(), saved = [];
  const saver = createSaver({ save: (s) => { saved.push(s); return true; }, intervalMs: 60000 });
  saver.request(() => 1); saver.request(() => 2);
  assert.equal(idle(), base, 'an unref\'d timer is not an active resource');
  saver.stop();
  assert.deepEqual(saved, [1]);
});

test('a save that fails stays pending: flush tries again', () => {
  const c = clock(); const results = [false, true]; const attempts = [];
  const saver = createSaver({ save: (s) => { attempts.push(s); return results.shift(); }, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
  saver.request(() => 'x'); assert.deepEqual(attempts, ['x']);
  saver.flush(); assert.deepEqual(attempts, ['x', 'x']);
  saver.flush(); assert.deepEqual(attempts, ['x', 'x'], 'saved now, so nothing is pending');
});

test('a throwing getState or save is contained and the saver keeps working', () => {
  const c = clock(); const saved = []; let boom = true;
  const saver = createSaver({ save: (s) => { if (boom) throw new Error('disk gone'); saved.push(s); return true; },
    now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
  assert.doesNotThrow(() => saver.request(() => 1));
  assert.doesNotThrow(() => saver.request(() => { throw new Error('bad state'); }));
  boom = false; c.advance(10000); assert.deepEqual(saved, [], 'the failing getState left nothing to save');
  c.advance(20000); saver.request(() => 2); assert.deepEqual(saved, [2]);
});
