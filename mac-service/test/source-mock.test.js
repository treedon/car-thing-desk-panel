// The demo mode behind SIM_DEMO=1: enough sessions and subagents to exercise
// the panel's scrolling, written as real-shaped files so every reader runs.
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// config.js reads these once, so they are set before anything imports it: the digest's state file
// and the service log go to a temp folder, never the checkout's .state/ and logs/. Mock mode is on for
// createSources, and its default demo folder (MOCK_DIR, under os.tmpdir()) is inside the temp folder too.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-thing-source-mock-'));
process.env.CLAUDE_THING_STATE_DIR = path.join(TMP, 'state');
process.env.CLAUDE_THING_LOG_DIR = path.join(TMP, 'logs');
process.env.CLAUDE_THING_MOCK = '1';
process.env.TMPDIR = TMP;

const { createStore } = await import('../src/sessions/store.js');
const { startMockSource, MOCK_DIR, MOCK_PROJECTS_DIR } = await import('../src/sessions/source-mock.js');
const { createSources } = await import('../src/sessions/index.js');
const { readSubagents } = await import('../src/sessions/subagents.js');
const { readRecentMessages } = await import('../src/sessions/recent-messages.js');
const { createDigest } = await import('../src/digest/index.js');
const { createInbox } = await import('../src/inbox.js');

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('mock seeds 12 sessions, one with 22 subagents, each with a conversation', () => {
  const store = createStore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-'));
  const src = startMockSource({ store, permissionBridge: null, queue: null, dir });
  try {
    const all = store.entries();
    assert.equal(all.length, 12);
    const counts = all.map(([, raw]) => readSubagents(raw.transcriptPath.replace(/\.jsonl$/, ''), { sessionEnded: false }).length);
    assert.ok(counts.includes(22), `one session has 22 subagents (got ${counts})`);
    for (const [, raw] of all) {
      assert.ok(readRecentMessages(raw.transcriptPath, {}).length >= 3, 'every session has a conversation');
      assert.ok(raw.aiTitle, 'every session has a title');
    }
  } finally {
    src.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('demo transcripts make facts-only cards in every state the panel can show without a model', async () => {
  const store = createStore(); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-'));
  const src = startMockSource({ store, permissionBridge: null, queue: null, dir });
  const d = createDigest({ emit() {}, projectsDir: path.join(dir, 'projects'), isLive: (id) => !!store.raw(id), readDelayMs: 0, persist: false });
  try {
    await d.start(); await d.whenIdle(); src.stop();
    const cards = d.get().cards; const lines = cards.flatMap((c) => c.lines).join('\n');
    assert.equal(cards.length, 13, '12 live sessions and ended-recent');
    assert.ok(cards.some((c) => c.ended) && !cards.some((c) => /ended-old|notify-only/.test(c.sessionId)));
    for (const re of [/Tests: 41 passed, 0 failed/, /Tests: failed/, /outcome not reported/, /message not read/, /PR #14/, /agents finished/]) assert.match(lines, re);
    // The turns the table names: session 0's human turn then its continuation, session 3's human turn
    // then the one a task notification started. Each is closed by its own stop summary, so neither
    // folds into the turn before it.
    const card = (prefix) => cards.find((c) => c.sessionId.startsWith(prefix));
    assert.equal(card('mock-0-').facts.turns, 2, 'session 0: a human turn and a continuation turn');
    assert.equal(card('mock-3-').facts.turns, 2, 'session 3: a human turn and a task-notification turn');
    // The last turns are spread from 3 minutes to 5 hours ago, newest first in the digest.
    const ages = cards.filter((c) => !c.ended).map((c) => Date.now() - c.lastTurnTs);
    assert.ok(Math.min(...ages) >= 2 * 60e3 && Math.max(...ages) <= 5 * 3600e3 + 60e3, `ages ${ages}`);
  } finally {
    src.stop();
    d.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a churn stop appends a closed human turn inside the projects folder and calls onStop, and the digest puts that card first', async () => {
  // Only setInterval is mocked (the churn's clock); the digest's own timers stay real, and a real
  // timer keeps the event loop up while the test waits on them.
  const hold = setTimeout(() => {}, 120_000);
  mock.timers.enable({ apis: ['setInterval'] });
  const store = createStore(); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-'));
  const projectsDir = path.join(dir, 'projects');
  const stops = [];
  let d = null;
  const src = startMockSource({ store, permissionBridge: null, queue: null, dir, onStop: (id, file) => {
    stops.push([id, file, fs.readFileSync(file, 'utf8')]);
    d.onHook('Stop', { session_id: id, transcript_path: file });
  } });
  d = createDigest({ emit() {}, projectsDir, isLive: (id) => !!store.raw(id), readDelayMs: 0, emitDebounceMs: 0, persist: false });
  try {
    await d.start(); await d.whenIdle();
    const before = new Map(d.get().cards.map((c) => [c.sessionId, c]));
    mock.timers.tick(8_000 * 6);
    assert.equal(stops.length, 0, 'no stop before the 7th churn tick');
    mock.timers.tick(8_000);
    assert.equal(stops.length, 1, 'the 7th churn tick stops a session');
    const [id, file, text] = stops[0];
    assert.equal(file, store.raw(id).transcriptPath);
    assert.equal(path.relative(projectsDir, file).split(path.sep).length, 2, 'the transcript is <projects>/<project>/<id>.jsonl');
    const records = text.trim().split('\n').map((l) => JSON.parse(l));
    const tail = records.slice(-3);
    assert.equal(tail[0].type, 'user', 'the appended turn starts with what the owner typed');
    assert.equal(tail[0].origin && tail[0].origin.kind, 'human');
    assert.equal(tail[1].message.stop_reason, 'end_turn');
    assert.equal(tail[2].subtype, 'stop_hook_summary', 'and is closed by a stop summary, written before onStop');
    await d.whenIdle();
    const cards = d.get().cards;
    assert.equal(cards[0].sessionId, id, 'the stopped session is the newest card');
    assert.equal(cards[0].facts.turns, before.get(id).facts.turns + 1, 'one more turn');
    assert.ok(Date.now() - cards[0].lastTurnTs < 60e3);
  } finally {
    src.stop();
    d.stop();
    mock.timers.reset();
    clearTimeout(hold);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('in mock mode createSources hands the churn\'s stops to onMockStop, with transcripts in MOCK_PROJECTS_DIR', () => {
  assert.ok(MOCK_DIR.startsWith(TMP + path.sep), 'the demo folder is the test\'s own');
  mock.timers.enable({ apis: ['setInterval'] });
  const store = createStore();
  const stops = [];
  const sources = createSources({ store, permissionBridge: null, queue: null, onMockStop: (id, file) => stops.push([id, file]) });
  try {
    assert.deepEqual(sources.status(), ['mock']);
    mock.timers.tick(8_000 * 7);
    assert.equal(stops.length, 1);
    const [id, file] = stops[0];
    assert.equal(file, store.raw(id).transcriptPath);
    assert.equal(path.dirname(path.dirname(file)), MOCK_PROJECTS_DIR);
  } finally {
    sources.stop();
    mock.timers.reset();
    fs.rmSync(MOCK_DIR, { recursive: true, force: true });
  }
});

// The demo cards: what the simulator needs to show the queue's new screens
// (an ASKING hero, an UPDATE row, a tile reading "waiting on …") without a
// real Claude Code session finishing a turn.
test('mock posts an ASKING and an UPDATE card, and one session waits on background work', () => {
  const store = createStore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-'));
  const posted = [];
  const inbox = { post: (card) => { posted.push(card); return card; } };
  const src = startMockSource({ store, permissionBridge: null, queue: null, inbox, dir });
  try {
    const tags = posted.map((c) => c.tag);
    assert.ok(tags.includes('asking'), `an asking card is posted (got ${tags})`);
    assert.ok(tags.includes('update'), `an update card is posted (got ${tags})`);
    for (const card of posted) {
      assert.ok(store.raw(card.sessionId), `card ${card.tag} belongs to a seeded session`);
      assert.ok(card.text && card.sessionName, 'a card carries its text and session name');
    }
    assert.equal(new Set(posted.map((c) => c.sessionId)).size, posted.length, 'one card per session');

    const waiting = store.entries().filter(([, raw]) => raw.waitingOn && raw.waitingOn.length);
    assert.ok(waiting.length >= 1, 'a session is waiting on something');
    const [id, raw] = waiting[0];
    assert.ok(raw.waitingOn[0].label && Number.isFinite(raw.waitingOn[0].since), 'the wait has a label and a start time');
    assert.equal(store.get(id).state, 'busy', 'a session with something running reads busy');
    assert.ok(!posted.some((c) => c.sessionId === id), 'a waiting session has no card yet; it posts when the work finishes');
  } finally {
    src.stop();
  }
});

test('mock without an inbox still starts', () => {
  const store = createStore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-'));
  const src = startMockSource({ store, permissionBridge: null, queue: null, dir });
  try {
    assert.equal(store.entries().length, 12);
  } finally {
    src.stop();
  }
});

test('the demo cards go through a real inbox: the question is loud, the notes are not', () => {
  const store = createStore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-'));
  const loud = [];
  const inbox = createInbox({ emit: () => {}, onLoud: (card) => loud.push(card.tag) });
  const src = startMockSource({ store, permissionBridge: null, queue: null, inbox, dir });
  try {
    const cards = inbox.list();
    assert.deepEqual(cards.map((c) => c.tag).sort(), ['asking', 'update', 'update']);
    assert.deepEqual(loud, ['asking'], 'only the question chimes');
    const asking = cards.find((c) => c.tag === 'asking');
    assert.match(asking.excerpt, /per API key or per client IP\?/, 'the hero shows the closing question');
    assert.ok(cards.some((c) => c.intent === ''), 'one note has no "you asked" line');
  } finally {
    src.stop();
  }
});
