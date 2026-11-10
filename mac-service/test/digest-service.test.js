// The digest service (digest/index.js): Stop and SessionEnd hooks heard with no I/O, one read at a
// time, the start-up catch-up scan, the persisted state and the debounced claude.digest.update.
// Transcripts are the synthetic fixtures; planted secrets are built at runtime (fixtures/digest/secrets.js).
import { test, beforeEach, afterEach, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// config.js reads the state dir once, so it is set before anything imports it.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-thing-digest-service-'));
process.env.CLAUDE_THING_STATE_DIR = path.join(TMP, 'state');
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const { createDigest, createQueue } = await import('../src/digest/index.js');
const { readRecords } = await import('../src/digest/reader.js');
const { loadDigestState } = await import('../src/digest/state.js');
const { markOwnSession } = await import('../src/own-sessions.js');
const { T, human, asst, use, result, stopSummary, jsonl } = await import('./fixtures/digest/build.js');
const { SECRETS } = await import('./fixtures/digest/secrets.js');

const NOW = Date.parse('2026-11-02T12:00:00Z');
const HOUR = 3600e3;
const projectsDir = path.join(TMP, 'projects');
const stateFile = path.join(TMP, 'state', 'digest.json');
const fx = (name) => fileURLToPath(new URL('./fixtures/digest/' + name, import.meta.url));
const file = (id) => path.join(projectsDir, 'proj', id + '.jsonl');
const text = (name) => fs.readFileSync(fx(name + '.jsonl'), 'utf8');
// turns.jsonl closes its third turn, then a compaction summary, then an open turn: the saved offset is
// just past the compaction summary (the 11th line), and the file runs on past it.
const TURNS_OFFSET = Buffer.byteLength(text('turns').split('\n').slice(0, 11).join('\n') + '\n');
const TURNS_SIZE = Buffer.byteLength(text('turns'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

markOwnSession('own');

function place(id, body, mtimeMs = NOW - HOUR) {
  fs.writeFileSync(file(id), body);
  fs.utimesSync(file(id), mtimeMs / 1000, mtimeMs / 1000);
}

let emitted = [];
let made = [];
beforeEach(() => {
  fs.rmSync(stateFile, { force: true });
  fs.rmSync(projectsDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(projectsDir, 'proj'), { recursive: true });
  for (const id of ['turns', 'tools', 'notify-only']) place(id, text(id));
  place('old', text('tools'), NOW - 30 * HOUR);
  place('own', text('turns'));
  emitted = [];
  made = [];
});

// Every record the service saved passes the loader's shape check (isSessionRecord): none is dropped.
afterEach(() => {
  for (const d of made) d.stop();
  if (!fs.existsSync(stateFile)) return;
  const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.deepEqual(Object.keys(loadDigestState().sessions).sort(), Object.keys(raw.sessions).sort(), 'a saved record failed the shape check');
});

function make(opts = {}) {
  const d = createDigest({ emit: (t, data) => emitted.push([t, data]), projectsDir, now: () => NOW,
    readDelayMs: 5, emitDebounceMs: 20, saveIntervalMs: 50, ...opts });
  made.push(d);
  return d;
}

// A read that records [basename, fromOffset] and then reads.
function spy(calls) {
  return (f, from, ...rest) => {
    calls.push([path.basename(f), from]);
    return readRecords(f, from, ...rest);
  };
}

const card = (d, id) => d.get().cards.find((c) => c.sessionId === id);
const saved = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));

function captureLog() {
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.map(String).join(' ')); };
  return { lines, restore: () => { console.log = original; } };
}

// ---- the brief's tests -------------------------------------------------------------------------

test('catch-up makes one card per session with a finished turn, newest first; skips no-human, old and own files', { timeout: 30_000 }, async () => {
  fs.utimesSync(file('tools'), (NOW - HOUR / 2) / 1000, (NOW - HOUR / 2) / 1000);   // the newest transcript
  const calls = [];
  const d = make({ read: spy(calls) }); await d.start(); await d.whenIdle();
  assert.deepEqual(d.get().cards.map((c) => c.sessionId), ['turns', 'tools']);
  assert.deepEqual(calls, [['tools.jsonl', 0], ['notify-only.jsonl', 0], ['turns.jsonl', 0]], 'newest transcript first; old and own never read');
  const { catchUpMs, ...status } = d.status();
  assert.deepEqual(status, { sessions: 3, cards: 2, skipped: 0, queued: 0, errors: 0 });
  assert.equal(typeof catchUpMs, 'number');
});

test('the digest has the protocol shape, facts-only', { timeout: 30_000 }, async () => {
  const d = make(); await d.start(); await d.whenIdle();
  const g = d.get();
  assert.deepEqual(Object.keys(g).sort(), ['cards', 'summarizer', 'totals', 'updatedTs', 'windowHours']);
  assert.deepEqual([g.updatedTs, g.windowHours, g.summarizer], [NOW, 24, { state: 'off', model: null, lastOkTs: null }]);
  assert.deepEqual(g.totals, { sessions: 2, turns: 4, commits: 2, prs: 1, testRuns: 3 });
  for (const c of g.cards) {
    assert.deepEqual(Object.keys(c).sort(), ['behindTurns', 'ended', 'facts', 'lastReply', 'lastTurnTs', 'lines', 'project', 'sessionId', 'summary', 'title']);
    assert.deepEqual([c.summary, c.behindTurns, c.ended], [null, 0, true], 'not in the live store (the default isLive) reads as ended');
  }
  assert.deepEqual([g.cards[0].title, g.cards[0].lastReply, g.cards[0].lastTurnTs], ['Digest fixture', 'The background build passed.', Date.parse(T(11))]);
  assert.deepEqual(emitted.at(-1), ['claude.digest.update', g], 'the last update carries the digest as it is now');
});

test('a Stop does no I/O on the hook path and is read after the delay', { timeout: 30_000 }, async () => {
  let reads = 0;
  const d = make({ read: (...a) => { reads++; return readRecords(...a); } }); await d.start(); await d.whenIdle(); reads = 0;
  fs.appendFileSync(file('turns'), jsonl([stopSummary(22)]));
  // every file-system call and every JSON call made while the hook runs is counted
  const touched = [];
  const restore = [];
  const watch = (obj, name, label) => {
    const original = obj[name];
    obj[name] = function (...args) { touched.push(label); return original.apply(this, args); };
    restore.push(() => { obj[name] = original; });
  };
  for (const name of ['stat', 'lstat', 'readdir', 'open', 'readFile', 'writeFile', 'realpath', 'access']) watch(fs.promises, name, 'fs.promises.' + name);
  for (const name of ['statSync', 'lstatSync', 'readdirSync', 'openSync', 'readFileSync', 'writeFileSync', 'renameSync', 'existsSync', 'realpathSync', 'readSync', 'fstatSync', 'mkdirSync']) watch(fs, name, 'fs.' + name);
  watch(JSON, 'stringify', 'JSON.stringify');
  watch(JSON, 'parse', 'JSON.parse');
  try {
    d.onHook('Stop', { session_id: 'turns', transcript_path: file('turns') });
  } finally {
    for (const undo of restore) undo();
  }
  assert.deepEqual(touched, [], 'no file system or JSON work on the hook path');
  assert.equal(reads, 0, 'nothing read before the hook returns');
  await d.whenIdle(); assert.equal(reads, 1);
  assert.equal(d.get().cards.find((c) => c.sessionId === 'turns').facts.turns, 4);
});

test('a burst of Stops makes one claude.digest.update', { timeout: 30_000 }, async () => {
  let reads = 0;
  const d = make({ read: (...a) => { reads++; return readRecords(...a); } }); await d.start(); await d.whenIdle();
  reads = 0; emitted = [];
  fs.appendFileSync(file('turns'), jsonl([stopSummary(22)]));
  for (let i = 0; i < 3; i++) d.onHook('Stop', { session_id: 'turns', transcript_path: file('turns') });
  await d.whenIdle();
  assert.equal(reads, 1, 'the three Stops are one read');
  assert.deepEqual(emitted.map(([topic]) => topic), ['claude.digest.update']);
  assert.deepEqual(emitted[0][1], d.get());
  assert.deepEqual([emitted[0][1].cards[0].sessionId, emitted[0][1].cards[0].facts.turns], ['turns', 4]);
});

test('a session that ends while it is being read is read once more and ends', { timeout: 30_000 }, async () => {   // Review Focus 1
  let readCalls = 0, active = 0, maxActive = 0, release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const inRead = new Promise((resolve) => { entered = resolve; });
  const froms = [];
  const read = async (f, from, ...rest) => {
    active++; maxActive = Math.max(maxActive, active);
    try {
      if (path.basename(f) === 'turns.jsonl') {
        readCalls++; froms.push(from); entered(); await gate;
      }
      return await readRecords(f, from, ...rest);
    } finally {
      active--;
    }
  };
  const d = make({ read, isLive: () => true });
  const started = d.start();
  await inRead;   // the catch-up read of 'turns' has begun and waits on the gate
  d.onHook('SessionEnd', { session_id: 'turns', transcript_path: file('turns') });
  assert.equal(d.status().queued, 0, 'not queued a second time while it is read');
  release();
  await started; await d.whenIdle();
  const c = card(d, 'turns');
  assert.deepEqual([c.ended, c.facts.turns, readCalls], [true, 3, 2]);
  assert.deepEqual(froms, [0, TURNS_SIZE], 'the second read starts where the first ended');
  assert.equal(maxActive, 1, 'reads never overlap');
  d.stop();
  assert.equal(saved().sessions.turns.ended, true);
});

test('a transcript that shrinks is read again from the start', { timeout: 30_000 }, async () => {   // Review Focus 3
  const calls = [];
  const d = make({ read: spy(calls) }); await d.start(); await d.whenIdle(); calls.length = 0;
  fs.writeFileSync(file('turns'), text('notify-only'));
  d.onHook('Stop', { session_id: 'turns', transcript_path: file('turns') });
  await d.whenIdle();
  assert.deepEqual(calls, [['turns.jsonl', 0]]);
  assert.deepEqual(d.get().cards.map((c) => c.sessionId), ['tools'], 'no card for it');
  d.stop();
  const f = saved().sessions.turns.facts;
  assert.deepEqual([f.totals.turns, f.offset, f.hasHumanPrompt, f.title], [1, Buffer.byteLength(text('notify-only')), false, 'proj'], 'fresh facts, not resumed ones');
});

test('a transcript cut short between the stat and the read is read again from 0 with a fresh extractor', { timeout: 30_000 }, async () => {
  const calls = [];
  let cut = false;
  const read = (f, from, ...rest) => {
    calls.push([path.basename(f), from]);
    if (cut) { cut = false; fs.writeFileSync(f, text('notify-only')); }   // replaced after the service's stat
    return readRecords(f, from, ...rest);
  };
  const d = make({ read }); await d.start(); await d.whenIdle(); calls.length = 0;
  fs.appendFileSync(file('turns'), jsonl([stopSummary(22)]));   // grown, so the stat sees no shrink
  cut = true;
  d.onHook('Stop', { session_id: 'turns', transcript_path: file('turns') });
  await d.whenIdle();
  assert.deepEqual(calls, [['turns.jsonl', TURNS_SIZE], ['turns.jsonl', 0]]);
  assert.deepEqual(d.get().cards.map((c) => c.sessionId), ['tools']);
  d.stop();
  const f = saved().sessions.turns.facts;
  assert.deepEqual([f.totals.turns, f.offset, f.title], [1, Buffer.byteLength(text('notify-only')), 'proj']);
});

test('the state file is 0600 and a restart reads only new bytes', { timeout: 30_000 }, async () => {   // Review Focus 5
  const d = make(); await d.start(); await d.whenIdle();
  d.stop(); assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
  const calls = [];
  const d2 = make({ read: spy(calls) }); await d2.start(); await d2.whenIdle();
  assert.deepEqual(calls.map(([f, from]) => [f, from > 0]), [['turns.jsonl', true]], 'only the open turn is re-read');
  assert.equal(calls[0][1], TURNS_OFFSET, 'from the end of the last closed turn');
  assert.deepEqual(d2.get().cards, d.get().cards);
  fs.appendFileSync(file('turns'), jsonl([stopSummary(22)]));
  d2.onHook('Stop', { session_id: 'turns', transcript_path: file('turns') });
  await d2.whenIdle();
  assert.deepEqual(calls.slice(1), [['turns.jsonl', TURNS_SIZE]], 'then only what was appended');
  assert.equal(card(d2, 'turns').facts.turns, 4);
});

test('a planted secret of each kind never reaches the cards, the event, the state file or the log', { timeout: 30_000 }, async () => {
  // one transcript per kind, so each secret is that session's title as well as in its prompt, reply,
  // commit -m, failing command, and subagent description and report
  SECRETS.forEach(([, secret], i) => {
    const id = 'secret-' + i;
    place(id, jsonl([{ type: 'custom-title', customTitle: 'Fix ' + secret }, human('Please fix ' + secret, 0),
      use('c1', 'Bash', { command: 'git commit -m "fix ' + secret + '"' }, 1), result('c1', { stdout: '' }, 1),
      use('f1', 'Bash', { command: 'false ' + secret }, 1), result('f1', 'Error: Exit code 1', 1, { isError: true }),
      asst('Fixed ' + secret + '. Done.', 2), stopSummary(2)]));
    const agents = path.join(projectsDir, 'proj', id, 'subagents');
    fs.mkdirSync(agents, { recursive: true });
    fs.writeFileSync(path.join(agents, 'agent-a.meta.json'), JSON.stringify({ agentType: 'x', description: 'Review ' + secret, finished: true }));
    fs.writeFileSync(path.join(agents, 'agent-a.jsonl'), JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Report ' + secret }] } }) + '\n');
  });
  const log = captureLog();
  let d;
  try {
    d = make({ maxCards: 50 }); await d.start(); await d.whenIdle(); d.stop();
  } finally {
    log.restore();
  }
  const cards = d.get().cards.filter((c) => c.sessionId.startsWith('secret-'));
  assert.equal(cards.length, SECRETS.length);
  assert.ok(cards.every((c) => c.title.startsWith('Fix ') && c.facts.agents.finished === 1));
  const state = fs.readFileSync(stateFile, 'utf8');
  assert.ok(state.includes('Please fix') && state.includes('Review '), 'the text paths carry text');
  for (const blob of [JSON.stringify(d.get()), JSON.stringify(emitted), state, log.lines.join('\n')])
    for (const [kind, secret, needle = secret] of SECRETS) assert.ok(!blob.includes(needle), kind);
  assert.ok(log.lines.length > 0 && log.lines.every((l) => !l.includes(projectsDir) && !l.includes('proj')), 'the log names no transcript path');
});

test('a hook outside the projects dir, or without a session id, is ignored', { timeout: 30_000 }, async () => {
  let reads = 0;
  const d = make({ read: (...a) => { reads++; return readRecords(...a); } }); await d.start(); await d.whenIdle(); reads = 0;
  const outside = path.join(TMP, 'elsewhere', 'x.jsonl');
  fs.mkdirSync(path.dirname(outside), { recursive: true });
  fs.writeFileSync(outside, text('tools'));
  d.onHook('Stop', { session_id: 'x', transcript_path: outside });
  d.onHook('Stop', { session_id: 'x', transcript_path: path.join(projectsDir, 'proj', '..', '..', 'elsewhere', 'x.jsonl') });
  d.onHook('Stop', { session_id: 'x', transcript_path: 'projects/proj/x.jsonl' });   // relative
  d.onHook('Stop', { session_id: 'sub', transcript_path: path.join(projectsDir, 'proj', 'turns', 'subagents', 'agent-a.jsonl') });
  d.onHook('Stop', { session_id: 'txt', transcript_path: path.join(projectsDir, 'proj', 'turns.txt') });
  fs.writeFileSync(path.join(projectsDir, 'top.jsonl'), text('tools'));
  d.onHook('Stop', { session_id: 'top', transcript_path: path.join(projectsDir, 'top.jsonl') });   // not in a project folder
  d.onHook('Stop', { session_id: 'deep', transcript_path: path.join(projectsDir, 'proj', 'turns.jsonl', 'x.jsonl') });
  d.onHook('Stop', { transcript_path: file('turns') });
  d.onHook('Stop', { session_id: '', transcript_path: file('turns') });
  d.onHook('Stop', { session_id: 42, transcript_path: file('turns') });
  d.onHook('Stop', { session_id: 'unknown' });   // no path, and none known
  d.onHook('Stop', { session_id: 'own', transcript_path: file('own') });
  d.onHook('PreToolUse', { session_id: 'turns', transcript_path: file('turns') });
  d.onHook('Stop', null); d.onHook('Stop'); d.onHook('Stop', 'turns'); d.onHook();
  assert.equal(d.status().queued, 0);
  await d.whenIdle();
  assert.equal(reads, 0);
  assert.deepEqual(d.get().cards.map((c) => c.sessionId), ['turns', 'tools']);
});

// ---- more of the service -----------------------------------------------------------------------

test('a hook without a path uses the one already known; SessionEnd ends the card and a later Stop revives it', { timeout: 30_000 }, async () => {
  const calls = [];
  const d = make({ read: spy(calls), isLive: () => true }); await d.start(); await d.whenIdle(); calls.length = 0;
  d.onHook('SessionEnd', { session_id: 'turns' });
  await d.whenIdle();
  assert.deepEqual([calls, card(d, 'turns').ended, card(d, 'tools').ended], [[['turns.jsonl', TURNS_SIZE]], true, false]);
  d.onHook('Stop', { session_id: 'turns' });   // a resumed session
  await d.whenIdle();
  assert.equal(card(d, 'turns').ended, false);
});

test('a hook before start waits for the saved state, so nothing is read twice', { timeout: 30_000 }, async () => {
  const d = make(); await d.start(); await d.whenIdle(); d.stop();
  fs.appendFileSync(file('turns'), jsonl([stopSummary(22)]));
  const calls = [];
  const d2 = make({ read: spy(calls) });
  d2.onHook('Stop', { session_id: 'turns', transcript_path: file('turns') });
  await sleep(30);
  assert.deepEqual(calls, [], 'nothing is read before start');
  await d2.start(); await d2.whenIdle();
  assert.deepEqual(calls, [['turns.jsonl', TURNS_OFFSET]]);
  assert.equal(card(d2, 'turns').facts.turns, 4);
});

test('saves are throttled, and stop() writes what is pending before it stops', { timeout: 30_000 }, async () => {
  const d = make({ saveIntervalMs: 60_000 }); await d.start(); await d.whenIdle();
  assert.deepEqual(Object.keys(saved().sessions), ['notify-only'], 'the first read saves at once, the rest wait');
  d.stop();
  assert.deepEqual(Object.keys(saved().sessions).sort(), ['notify-only', 'tools', 'turns']);
  const rec = saved().sessions.tools;
  assert.deepEqual([rec.path, rec.mtimeMs, rec.ended, rec.facts.offset, rec.agents],
    [file('tools'), NOW - HOUR, false, Buffer.byteLength(text('tools')), { finished: 0, running: 0, list: [] }]);
});

test('stop ignores later hooks and leaves no timer running; the timers never hold the process open', { timeout: 30_000 }, async () => {
  let reads = 0;
  const d = make({ read: (...a) => { reads++; return readRecords(...a); } }); await d.start(); await d.whenIdle(); reads = 0;
  const timeouts = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  const before = timeouts();
  d.onHook('Stop', { session_id: 'turns', transcript_path: file('turns') });
  assert.equal(timeouts(), before, 'the read timer is unref\'d');
  d.stop();
  d.onHook('SessionEnd', { session_id: 'turns', transcript_path: file('turns') });
  const idle = await Promise.race([d.whenIdle().then(() => 'idle'), Promise.resolve().then(() => 'waiting')]);
  assert.equal(idle, 'idle', 'nothing is left to wait for');
  await sleep(30);
  assert.deepEqual([reads, d.status().queued], [0, 0]);
});

test('a failed read, a throwing emit or isLive, and a gone transcript never stop the queue or throw', { timeout: 30_000 }, async () => {
  place('messy', text('messy'));
  let emits = 0;
  const d = make({
    read: (f, ...rest) => (path.basename(f) === 'tools.jsonl'
      ? Promise.reject(Object.assign(new Error('EIO: i/o error, read ' + f), { code: 'EIO' })) : readRecords(f, ...rest)),
    emit: () => { if (emits++ === 0) throw new Error('socket gone'); },
    isLive: () => { throw new Error('store gone'); },
  });
  const log = captureLog();
  try {
    await d.start(); await d.whenIdle();
  } finally {
    log.restore();
  }
  assert.deepEqual(d.get().cards.map((c) => c.sessionId), ['turns', 'messy']);
  const { catchUpMs, ...status } = d.status();
  assert.deepEqual(status, { sessions: 3, cards: 2, skipped: 2, queued: 0, errors: 2 }, 'the failed read and the failed emit');
  assert.ok(log.lines.some((l) => /DG read tools fa/.test(l) && /EIO/.test(l)) && !log.lines.some((l) => l.includes(projectsDir)));
  // the transcript goes away: its session is dropped at the next read
  fs.rmSync(file('turns'));
  d.onHook('Stop', { session_id: 'turns', transcript_path: file('turns') });
  await d.whenIdle();
  assert.deepEqual(d.get().cards.map((c) => c.sessionId), ['messy']);
  d.stop();
  assert.deepEqual(Object.keys(saved().sessions).sort(), ['messy', 'notify-only']);
});

test('a missing projects folder or a corrupt state file starts empty, and the log quotes none of the file', { timeout: 30_000 }, async () => {
  const none = make({ projectsDir: path.join(TMP, 'no-such-projects') });
  await none.start(); await none.whenIdle();
  assert.deepEqual(none.get().cards, []);
  none.stop();
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, '{"version":1,"sessions":{"turns":SNIPPET-of-a-prompt}}');
  const log = captureLog();
  let d;
  try {
    d = make(); await d.start(); await d.whenIdle();
  } finally {
    log.restore();
  }
  assert.deepEqual(d.get().cards.map((c) => c.sessionId), ['turns', 'tools']);
  assert.ok(log.lines.some((l) => /DG .*state.*SyntaxError/.test(l)), 'the failure is logged');
  assert.ok(!log.lines.join('\n').includes('SNIPPET'), 'without any of the file\'s text');
});

test('turns that age out of the window are let go, and numbering carries on', { timeout: 30_000 }, async () => {
  // 70 turns that ended 30 h ago, then one inside the window that is still working when first read. The
  // in-memory extractor is rebuilt without the old log only once no turn is open.
  const recs = [];
  for (let i = 0; i < 70; i++) recs.push(human('old ' + i, -1800 + i), asst('ok', -1800 + i), stopSummary(-1800 + i));
  recs.push(human('recent', 30), use('t1', 'Bash', { command: 'ls' }, 30));
  place('long', jsonl(recs));
  const d = make({ saveIntervalMs: 0 }); await d.start(); await d.whenIdle();
  const hook = () => d.onHook('Stop', { session_id: 'long', transcript_path: file('long') });
  fs.appendFileSync(file('long'), jsonl([result('t1', { stdout: '' }, 31), asst('Recent.', 31), stopSummary(31)]));
  hook(); await d.whenIdle();   // turn 71 closes, and the extractor is rebuilt
  const closed = fs.statSync(file('long')).size;
  fs.appendFileSync(file('long'), jsonl([human('again', 40), use('t2', 'Bash', { command: 'ls' }, 40)]));
  hook(); await d.whenIdle();
  assert.equal(saved().sessions.long.facts.offset, closed, 'the rebuilt extractor keeps the offset of its last closed turn');
  fs.appendFileSync(file('long'), jsonl([result('t2', { stdout: '' }, 41), asst('Again.', 41), stopSummary(41)]));
  hook(); await d.whenIdle();
  d.stop();
  const f = saved().sessions.long.facts;
  assert.deepEqual([f.totals.turns, f.turnLog.length, f.next.P], [72, 2, 73]);
  assert.deepEqual(f.turns.slice(-2).map((t) => [t.trigger, t.intent.id, t.intent.text, t.reply.id]),
    [['human', 'P71', 'recent', 'R71'], ['human', 'P72', 'again', 'R72']]);
  assert.deepEqual([card(d, 'long').facts.turns, d.get().totals.turns], [72, 6]);
});

test('a turn without a stop summary closes at its end_turn when the read ends, and is not read again', { timeout: 30_000 }, async () => {
  place('fallback', text('fallback'));
  const d = make(); await d.start(); await d.whenIdle(); d.stop();
  assert.deepEqual([card(d, 'fallback').facts.turns, card(d, 'fallback').lastTurnTs], [2, Date.parse(T(6))]);
  const calls = [];
  const d2 = make({ read: spy(calls) }); await d2.start(); await d2.whenIdle();
  assert.deepEqual(calls, [['turns.jsonl', TURNS_OFFSET]], 'the saved offset of fallback is its end');
});

test('hook work is read before queued catch-up work', { timeout: 30_000 }, async () => {
  const order = [];
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const inRead = new Promise((resolve) => { entered = resolve; });
  const read = async (f, ...rest) => {
    const id = path.basename(f, '.jsonl');
    order.push(id);
    if (id === 'notify-only') { entered(); await gate; }
    return readRecords(f, ...rest);
  };
  const d = make({ read });
  const started = d.start();
  await inRead; await started;   // notify-only is being read; tools and turns wait in the catch-up queue
  place('hooked', text('tools'));
  d.onHook('Stop', { session_id: 'hooked', transcript_path: file('hooked') });
  while (d.status().queued < 3) await sleep(2);   // the Stop's timer has fired
  release(); await d.whenIdle();
  assert.deepEqual(order, ['notify-only', 'hooked', 'tools', 'turns']);
});

test('sessions that leave the window are let go from memory and from the state file', { timeout: 30_000 }, async () => {
  let t = NOW, reads = 0;
  const d = make({ now: () => t, saveIntervalMs: 0, read: (...a) => { reads++; return readRecords(...a); } });
  await d.start(); await d.whenIdle();
  t = NOW + 30 * HOUR;
  fs.appendFileSync(file('turns'), jsonl([stopSummary(22)]));
  fs.utimesSync(file('turns'), (t - HOUR) / 1000, (t - HOUR) / 1000);   // its transcript is still in the window
  d.onHook('Stop', { session_id: 'turns', transcript_path: file('turns') });
  await d.whenIdle();
  assert.deepEqual(Object.keys(saved().sessions), ['turns']);
  assert.deepEqual(d.get().cards, [], 'its last turn ended more than a day ago');
  const { catchUpMs, ...status } = d.status();
  assert.deepEqual(status, { sessions: 1, cards: 0, skipped: 0, queued: 0, errors: 0 });
  reads = 0;
  d.onHook('SessionEnd', { session_id: 'tools' });   // no path: tools was let go, so it is not known
  await d.whenIdle();
  assert.equal(reads, 0);
});

test('a hook may name the transcript by its real path when the projects folder is a symlink', { timeout: 30_000 }, async () => {
  const link = path.join(TMP, 'projects-link');
  fs.rmSync(link, { force: true });
  fs.symlinkSync(projectsDir, link);
  const calls = [];
  const d = make({ projectsDir: link, read: spy(calls) }); await d.start(); await d.whenIdle(); calls.length = 0;
  fs.appendFileSync(file('turns'), jsonl([stopSummary(22)]));
  d.onHook('Stop', { session_id: 'turns', transcript_path: fs.realpathSync(file('turns')) });
  await d.whenIdle();
  assert.deepEqual(calls, [['turns.jsonl', TURNS_SIZE]], 'the same session, from where it stopped');
  d.stop();
  assert.equal(saved().sessions.turns.path, path.join(link, 'proj', 'turns.jsonl'));
});

test('the catch-up scan over thousands of transcripts yields between folders and batches, and reads only those in the window', { timeout: 30_000 }, async () => {
  // 200 project folders of 10 transcripts each, all from two days ago
  const old = (NOW - 48 * HOUR) / 1000;
  for (let p = 0; p < 200; p++) {
    const dir = path.join(projectsDir, 'many-' + p);
    fs.mkdirSync(dir);
    for (let i = 0; i < 10; i++) {
      const f = path.join(dir, `s${i}.jsonl`);
      fs.writeFileSync(f, '{}\n');
      fs.utimesSync(f, old, old);
    }
  }
  // the event loop's turn count, noted at each listing and stat of those folders, however they are made
  let loops = 0, spinning = true;
  const spin = () => { if (spinning) { loops++; setImmediate(spin); } };
  const at = { readdir: [], stat: [] };
  const restore = [];
  for (const [obj, name, kind] of [[fs.promises, 'readdir', 'readdir'], [fs, 'readdirSync', 'readdir'],
    [fs.promises, 'stat', 'stat'], [fs, 'statSync', 'stat'], [fs.promises, 'lstat', 'stat'], [fs, 'lstatSync', 'stat']]) {
    const original = obj[name];
    obj[name] = function (p, ...rest) {
      if (String(p).includes(path.sep + 'many-')) at[kind].push(loops);
      return original.call(this, p, ...rest);
    };
    restore.push(() => { obj[name] = original; });
  }
  const calls = [];
  const d = make({ read: spy(calls) });
  setImmediate(spin);
  try {
    await d.start();
  } finally {
    spinning = false;
    for (const undo of restore) undo();
  }
  await d.whenIdle();
  assert.deepEqual(calls.map(([f]) => f).sort(), ['notify-only.jsonl', 'tools.jsonl', 'turns.jsonl']);
  assert.deepEqual([at.readdir.length, at.stat.length], [200, 2000]);
  const turns = (list) => new Set(list).size;
  assert.ok(turns(at.readdir) >= 100, `the loop turned between folder listings: ${turns(at.readdir)} turns over 200`);
  assert.ok(turns(at.stat) >= 2000 / 64, `the loop turned between stat batches: ${turns(at.stat)} turns over 2000`);
});

test('the read queue is first in, first out, without duplicates, and linear on 300,000 ids', () => {
  const q = createQueue();
  for (const id of ['a', 'b', 'c', 'a']) q.add(id);
  q.delete('b'); q.add('b');   // deleted and added again: to the back
  assert.deepEqual([q.size, q.has('a'), q.has('z')], [3, true, false]);
  const out = [];
  for (let id = q.shift(); id !== undefined; id = q.shift()) out.push(id);
  assert.deepEqual([out, q.size], [['a', 'c', 'b'], 0]);
  q.add('x'); q.clear(); q.add('y');
  assert.deepEqual([q.shift(), q.shift()], ['y', undefined]);
  // ids that leave the queue before it drains are skipped, in order
  for (let i = 0; i < 3000; i++) q.add('s' + i);
  for (let i = 0; i < 3000; i += 2) q.delete('s' + i);
  const kept = [];
  for (let id = q.shift(); id !== undefined; id = q.shift()) kept.push(id);
  assert.deepEqual([kept.length, kept[0], kept.at(-1)], [1500, 's1', 's2999']);
  // a drain of 300,000 ids takes tens of ms; taking and deleting the first id of a Set takes seconds. CPU
  // time, not wall time, so other processes on the machine do not count.
  const n = 300_000;
  const cpu0 = process.cpuUsage();
  for (let i = 0; i < n; i++) q.add('id' + i);
  let drained = 0;
  while (q.shift() !== undefined) drained++;
  const { user, system } = process.cpuUsage(cpu0);
  const took = (user + system) / 1000;
  assert.equal(drained, n);
  assert.ok(took < 1500, `took ${took.toFixed(0)} ms of CPU`);
});

// ---- persist: false (the demo without a state folder of its own; see digestPersists in config.js) ----------

// The fs calls that name a path inside the state folder, while fn runs.
async function stateFolderCalls(fn) {
  const dir = path.dirname(stateFile);
  const spies = ['readFileSync', 'writeFileSync', 'renameSync', 'openSync', 'mkdirSync', 'chmodSync', 'unlinkSync', 'existsSync', 'statSync']
    .map((name) => mock.method(fs, name));
  try {
    await fn();
    return spies.flatMap((spy) => spy.mock.calls.map((c) => String(c.arguments[0])).filter((p) => p.startsWith(dir)));
  } finally {
    mock.restoreAll();
  }
}

test('with persist: false the state file is never read or written: a planted one is ignored and left byte for byte', { timeout: 30_000 }, async () => {
  // A well-formed saved state: were it read, turns.jsonl would resume from its saved offset under the planted title.
  const d0 = make(); await d0.start(); await d0.whenIdle(); d0.stop();
  const planted = saved();
  planted.sessions.turns.facts.title = 'PLANTED';
  planted.sessions.turns.facts.titleSource = 'custom';
  fs.writeFileSync(stateFile, JSON.stringify(planted), { mode: 0o600 });
  fs.utimesSync(stateFile, (NOW - HOUR) / 1000, (NOW - HOUR) / 1000);
  const before = { bytes: fs.readFileSync(stateFile), mtimeMs: fs.statSync(stateFile).mtimeMs };
  let d;
  const calls = await stateFolderCalls(async () => {
    d = make({ persist: false, saveIntervalMs: 0 }); await d.start(); await d.whenIdle();
    fs.appendFileSync(file('turns'), jsonl([stopSummary(22)]));
    d.onHook('Stop', { session_id: 'turns', transcript_path: file('turns') });
    await d.whenIdle();
    d.stop();
  });
  assert.deepEqual(calls, [], 'nothing in the state folder is opened, read, written or even looked at');
  assert.equal(card(d, 'turns').title, 'Digest fixture', 'the title read from the transcript, not the planted one');
  assert.equal(card(d, 'turns').facts.turns, 4, 'every turn read from the start');
  assert.ok(fs.readFileSync(stateFile).equals(before.bytes), 'the planted file is byte for byte as it was');
  assert.equal(fs.statSync(stateFile).mtimeMs, before.mtimeMs);
});

test('with persist: false no state file is made: not by the catch-up, a SessionEnd, a Stop or stop()', { timeout: 30_000 }, async () => {
  assert.equal(fs.existsSync(stateFile), false);
  const d = make({ persist: false, saveIntervalMs: 0 }); await d.start(); await d.whenIdle();
  d.onHook('SessionEnd', { session_id: 'tools', transcript_path: file('tools') });
  fs.appendFileSync(file('turns'), jsonl([stopSummary(22)]));
  d.onHook('Stop', { session_id: 'turns', transcript_path: file('turns') });
  await d.whenIdle();
  assert.deepEqual(d.get().cards.map((c) => [c.sessionId, c.ended]), [['turns', true], ['tools', true]]);
  d.stop();
  assert.equal(fs.existsSync(stateFile), false);
  const dir = path.dirname(stateFile);
  assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.startsWith('digest')) : [], []);
});

test('with persist: false a restarted digest reads a transcript rewritten at the same size again: no stale record survives', { timeout: 30_000 }, async () => {
  // What the demo does on every start: the same transcript, the same byte size, new facts and new times.
  const v1 = jsonl([human('Make the dial dimmer', 0), asst('Alpha is done.', 2), stopSummary(2)]);
  const v2 = jsonl([human('Make the dial dimmer', 40), asst('Bravo is done.', 42), stopSummary(42)]);
  assert.equal(Buffer.byteLength(v1), Buffer.byteLength(v2));
  place('same', v1);
  const d1 = make({ persist: false }); await d1.start(); await d1.whenIdle();
  assert.deepEqual([card(d1, 'same').lastReply, card(d1, 'same').lastTurnTs], ['Alpha is done.', Date.parse(T(2))]);
  d1.stop();
  place('same', v2);
  const d2 = make({ persist: false }); await d2.start(); await d2.whenIdle();
  assert.deepEqual([card(d2, 'same').lastReply, card(d2, 'same').lastTurnTs], ['Bravo is done.', Date.parse(T(42))]);
  assert.equal(fs.existsSync(stateFile), false);
});

test('with persist: false sessions that leave the window are still let go from memory', { timeout: 30_000 }, async () => {
  let t = NOW, reads = 0;
  const d = make({ persist: false, now: () => t, saveIntervalMs: 0, read: (...a) => { reads++; return readRecords(...a); } });
  await d.start(); await d.whenIdle();
  t = NOW + 30 * HOUR;
  fs.appendFileSync(file('turns'), jsonl([stopSummary(22)]));
  fs.utimesSync(file('turns'), (t - HOUR) / 1000, (t - HOUR) / 1000);   // its transcript is still in the window
  d.onHook('Stop', { session_id: 'turns', transcript_path: file('turns') });
  await d.whenIdle();
  assert.deepEqual(d.get().cards, [], 'its last turn ended more than a day ago');
  // (status() leaves out sessions outside the window by itself, so its count says nothing about memory.) A hook
  // with no path is acted on only for a session the digest still holds: tools, outside the window since the
  // read above swept it, is not read; turns, still held, is.
  reads = 0;
  d.onHook('SessionEnd', { session_id: 'tools' });
  await d.whenIdle();
  assert.equal(reads, 0, 'tools was let go from memory');
  d.onHook('SessionEnd', { session_id: 'turns' });
  await d.whenIdle();
  assert.equal(reads, 1, 'turns is still held, so a pathless hook reads it');
  assert.equal(fs.existsSync(stateFile), false);
});
