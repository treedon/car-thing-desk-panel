// Moving a background session into VS Code, and stopping one. Everything here is injected: the store is
// a real createStore(), but focus and stopAgent are fakes, and claudeStop gets a fake execFile. Nothing
// runs claude or open.
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// log.js empties <LOG_DIR>/daemon.log on import, and in the checkout that is the live service's log.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-thing-handoff-'));
process.env.CLAUDE_THING_LOG_DIR = path.join(TMP, 'logs');

const { createHandoff, claudeStop, pidAlive, CONTINUE_PROMPT } = await import('../src/handoff.js');
const { createStore } = await import('../src/sessions/store.js');
const { createMessageBridge } = await import('../src/message-bridge.js');
const background = await import('../src/background.js');

// The service logs one line per move or stop; the tests read those lines instead of printing them.
const logged = [];
mock.method(console, 'log', (line) => { logged.push(String(line)); });
after(async () => {
  mock.restoreAll();
  // These tests may finish before log.js's stream has opened its file: wait for it, or the open fails
  // with ENOENT once the folder is gone.
  const logFile = path.join(TMP, 'logs', 'daemon.log');
  for (let i = 0; i < 100 && !fs.existsSync(logFile); i++) await new Promise((r) => setTimeout(r, 10));
  fs.rmSync(TMP, { recursive: true, force: true });
});

const settle = () => new Promise((resolve) => setImmediate(resolve));

const IDLE = { kind: 'background', jobId: 'abcd1234', cwd: '/p', stoppedTs: 1 };
const WORKING = { ...IDLE, stoppedTs: null };

// A handoff over a real store holding one session, s1. `events` records stop, open and focus in the
// order they happen; `stopAgent` and `openInVsCode` are what a test swaps in to make them fail or wait
// (they run after the call is recorded).
function setup({ raw = IDLE, isWindowless = () => true, stopAgent, openInVsCode, focusSession, onOpened, canOpen, folderFor } = {}) {
  const store = createStore();
  if (raw) store.upsert('s1', raw);
  const events = [];
  const inExclusive = [];
  let depth = 0;
  const focus = {
    exclusive: async (fn) => {
      depth++;
      try { return await fn(); } finally { depth--; }
    },
    focusSession: async (...a) => {
      inExclusive.push(['focus', depth > 0]);
      events.push(['focus', ...a]);
      return focusSession ? focusSession(...a) : { focused: true };
    },
    openInVsCode: async (...a) => {
      inExclusive.push(['open', depth > 0]);
      events.push(['open', ...a]);
      return openInVsCode ? openInVsCode(...a) : { focused: true };
    },
  };
  const stops = [];
  const opens = [];
  const handoff = createHandoff({
    store, focus, isWindowless,
    ...(canOpen ? { canOpen } : {}), // left out, the default (always able) applies
    ...(folderFor ? { folderFor } : {}), // left out, the default (the record's cwd) applies
    onOpened: (id) => { opens.push(id); if (onOpened) onOpened(id); },
    stopAgent: async (shortId) => {
      stops.push(shortId);
      events.push(['stop', shortId]);
      if (stopAgent) await stopAgent(shortId);
    },
  });
  return { store, focus, handoff, events, stops, opens, inExclusive };
}

const opened = (ctx) => ctx.events.filter((e) => e[0] === 'open');

const handoffOf = (store, id = 's1') => store.raw(id).handoff;

// ---- moving ----------------------------------------------------------------------------------------

test('idle background session moves at once: stopped first, then opened', async () => {
  const { handoff, store, events } = setup();
  assert.deepEqual(await handoff.request('s1'), { result: 'opened' });
  assert.deepEqual(events, [['stop', 'abcd1234'], ['open', '/p', 's1', undefined]]);
  assert.equal(handoffOf(store) ?? null, null);
});

test('the open goes through focus.exclusive', async () => {
  const { handoff, inExclusive } = setup();
  await handoff.request('s1');
  assert.deepEqual(inExclusive, [['open', true]]);
});

// A session that moved into a git worktree reports the worktree as its cwd, but the VS Code window that
// hosts it is the folder it started in: opening the worktree would start a second window.
const WORKTREE = '/work/pfact/.claude/worktrees/x';
const START = '/work/pfact';
const startFolderOnly = (id, raw) => (id === 's1' && raw.cwd === WORKTREE ? START : raw.cwd);

test('a move opens the folder the session started in, not its current cwd', async () => {
  const ctx = setup({ raw: { ...IDLE, cwd: WORKTREE }, folderFor: startFolderOnly });
  assert.deepEqual(await ctx.handoff.request('s1'), { result: 'opened' });
  assert.deepEqual(opened(ctx), [['open', START, 's1', undefined]]);
});

test('OPEN NOW opens the start folder too, with the continue prompt', async () => {
  const ctx = setup({ raw: { ...IDLE, cwd: WORKTREE, stoppedTs: null }, folderFor: startFolderOnly });
  assert.deepEqual(await ctx.handoff.now('s1'), { result: 'opened' });
  assert.deepEqual(opened(ctx), [['open', START, 's1', CONTINUE_PROMPT]]);
});

test('a move that was waited on and fired by the Stop hook opens the start folder', async () => {
  const ctx = setup({ raw: { ...WORKING, cwd: WORKTREE }, folderFor: startFolderOnly });
  assert.deepEqual(await ctx.handoff.request('s1'), { result: 'waiting' });
  ctx.store.upsert('s1', { stoppedTs: 2 });
  await ctx.handoff.onHook('Stop', { session_id: 's1' });
  assert.deepEqual(opened(ctx), [['open', START, 's1', undefined]]);
});

test('folderFor is asked with the session id and its record', async () => {
  const asked = [];
  const ctx = setup({ folderFor: (id, raw) => { asked.push([id, raw.jobId, raw.cwd]); return raw.cwd; } });
  await ctx.handoff.request('s1');
  assert.deepEqual(asked, [['s1', 'abcd1234', '/p']]);
});

test('the folder is worked out before the agent is stopped', async () => {
  const order = [];
  const ctx = setup({
    folderFor: (id, raw) => { order.push('folder'); return raw.cwd; },
    stopAgent: async () => { order.push('stop'); },
  });
  await ctx.handoff.request('s1');
  assert.deepEqual(order, ['folder', 'stop']);
});

test('a folderFor that throws fails the move before anything is stopped, and does not reject', async () => {
  const boom = () => { throw new Error('no folder'); };
  const press = setup({ folderFor: boom });
  assert.deepEqual(await press.handoff.request('s1'), { result: 'failed', reason: 'open-failed' });
  assert.deepEqual(press.stops, [], 'the agent is still running');
  assert.deepEqual(opened(press), []);
  assert.equal(handoffOf(press.store) ?? null, null);
  assert.ok(logged.some((l) => /not moving abcd1234: no folder to open \(no folder\)/.test(l)), logged.join('\n'));

  const now = setup({ raw: WORKING, folderFor: boom });
  assert.deepEqual(await now.handoff.now('s1'), { result: 'failed', reason: 'open-failed' });
  assert.deepEqual(now.stops, []);

  const waited = setup({ raw: WORKING, folderFor: boom });
  assert.deepEqual(await waited.handoff.request('s1'), { result: 'waiting' });
  waited.store.upsert('s1', { stoppedTs: 2 });
  assert.deepEqual(await waited.handoff.onHook('Stop', { session_id: 's1' }), { result: 'failed', reason: 'open-failed' });
  assert.deepEqual(waited.stops, []);
  assert.equal(handoffOf(waited.store) ?? null, null, 'the wait is over');
});

test('the store says moving while the move is in flight, and not after', async () => {
  const seen = [];
  const ctx = setup({
    stopAgent: async () => { seen.push(ctx.store.raw('s1').handoff, ctx.store.get('s1').handoff); },
  });
  await ctx.handoff.request('s1');
  assert.deepEqual(seen, ['moving', 'moving'], 'the detail the panel reads says so too');
  assert.equal(ctx.store.raw('s1').handoff ?? null, null);
  assert.equal(ctx.store.get('s1').handoff, null);
});

test('working session waits, then moves on Stop', async () => {
  const { handoff, store, events } = setup({ raw: WORKING });
  assert.deepEqual(await handoff.request('s1'), { result: 'waiting' });
  assert.equal(handoffOf(store), 'waiting');
  assert.equal(store.get('s1').handoff, 'waiting', 'the panel is told');
  assert.deepEqual(events, [], 'nothing is stopped while the turn runs');

  store.upsert('s1', { stoppedTs: 2 });
  assert.deepEqual(await handoff.onHook('Stop', { session_id: 's1' }), { result: 'opened' });
  assert.deepEqual(events, [['stop', 'abcd1234'], ['open', '/p', 's1', undefined]]);
  assert.equal(handoffOf(store) ?? null, null);
});

test('StopFailure ends the wait the same way', async () => {
  const { handoff, store, events } = setup({ raw: WORKING });
  await handoff.request('s1');
  store.upsert('s1', { stoppedTs: 2 });
  assert.deepEqual(await handoff.onHook('StopFailure', { session_id: 's1' }), { result: 'opened' });
  assert.equal(events.length, 2);
});

test('a Stop with background work still waited on does not fire the move', async () => {
  const { handoff, store, events } = setup({ raw: WORKING });
  await handoff.request('s1');
  store.upsert('s1', { stoppedTs: 2, waitingOn: [{ type: 'bash' }] });
  await handoff.onHook('Stop', { session_id: 's1' });
  assert.deepEqual(events, []);
  assert.equal(handoffOf(store), 'waiting', 'the wait goes on');

  // The work finishes and the session stops for good: now it moves.
  store.upsert('s1', { stoppedTs: 3, waitingOn: [] });
  assert.deepEqual(await handoff.onHook('Stop', { session_id: 's1' }), { result: 'opened' });
});

test('a Stop with a permission still pending does not fire the move', async () => {
  const { handoff, store, events } = setup({ raw: WORKING });
  await handoff.request('s1');
  store.upsert('s1', { stoppedTs: 2, pendingPermission: { tool: 'Bash' } });
  await handoff.onHook('Stop', { session_id: 's1' });
  assert.deepEqual(events, []);
  assert.equal(handoffOf(store), 'waiting');
});

test('asking again while waiting is the same wait', async () => {
  const { handoff, store, events } = setup({ raw: WORKING });
  await handoff.request('s1');
  assert.deepEqual(await handoff.request('s1'), { result: 'waiting' });
  assert.equal(handoffOf(store), 'waiting');
  assert.deepEqual(events, []);
});

test('asking while waiting moves at once if the turn has in fact ended', async () => {
  // The Stop hook was missed (a restart of the hook path, say): a press must not wait forever.
  const { handoff, store } = setup({ raw: WORKING });
  await handoff.request('s1');
  store.upsert('s1', { stoppedTs: 2 });
  assert.deepEqual(await handoff.request('s1'), { result: 'opened' });
  assert.equal(handoffOf(store) ?? null, null);
});

test('cancel clears the wait, and a later Stop does nothing', async () => {
  const { handoff, store, events } = setup({ raw: WORKING });
  await handoff.request('s1');
  assert.deepEqual(await handoff.cancel('s1'), { result: 'cancelled' });
  assert.equal(handoffOf(store) ?? null, null);
  store.upsert('s1', { stoppedTs: 2 });
  await handoff.onHook('Stop', { session_id: 's1' });
  assert.deepEqual(events, []);
});

test('cancel on a session that is not waiting is a no-op that says cancelled', async () => {
  const { handoff, store, events } = setup();
  assert.deepEqual(await handoff.cancel('s1'), { result: 'cancelled' });
  assert.deepEqual(await handoff.cancel('nope'), { result: 'cancelled' });
  assert.equal(handoffOf(store) ?? null, null);
  assert.deepEqual(events, []);
  assert.equal(store.raw('nope'), undefined, 'cancelling an unknown id makes no record');
});

test('a Stop for a session nobody is waiting on does nothing', async () => {
  const { handoff, events } = setup();
  await handoff.onHook('Stop', { session_id: 's1' });
  await handoff.onHook('Stop', { session_id: 'someone-else' });
  await handoff.onHook('Stop', {});
  await handoff.onHook('Stop', undefined);
  assert.deepEqual(events, []);
});

test('only Stop and StopFailure end a wait', async () => {
  const { handoff, store, events } = setup({ raw: WORKING });
  await handoff.request('s1');
  store.upsert('s1', { stoppedTs: 2 });
  await handoff.onHook('PreToolUse', { session_id: 's1' });
  await handoff.onHook('SessionEnd', { session_id: 's1' });
  assert.deepEqual(events, []);
  assert.equal(handoffOf(store), 'waiting');
});

test('a window that parks on the job while it is waited on cancels the wait instead of stopping it', async () => {
  let windowless = true;
  const { handoff, store, events } = setup({ raw: WORKING, isWindowless: () => windowless });
  await handoff.request('s1');
  windowless = false;
  store.upsert('s1', { stoppedTs: 2 });
  await handoff.onHook('Stop', { session_id: 's1' });
  assert.deepEqual(events, [], 'a parked window is never stopped from under its owner');
  assert.equal(handoffOf(store) ?? null, null);
});

test('now stops at once and pre-fills continue', async () => {
  const { handoff, store, events } = setup({ raw: WORKING });
  await handoff.request('s1');
  assert.deepEqual(await handoff.now('s1'), { result: 'opened' });
  assert.deepEqual(events, [['stop', 'abcd1234'], ['open', '/p', 's1', CONTINUE_PROMPT]]);
  assert.equal(CONTINUE_PROMPT, 'Continue where you left off.');
  assert.equal(handoffOf(store) ?? null, null);
});

test('a Stop arriving after now does not move it a second time', async () => {
  const { handoff, store, events } = setup({ raw: WORKING });
  await handoff.request('s1');
  await handoff.now('s1');
  store.upsert('s1', { stoppedTs: 2 });
  await handoff.onHook('Stop', { session_id: 's1' });
  assert.equal(events.filter((e) => e[0] === 'stop').length, 1);
});

test('now never touches a session with a window', async () => {
  const { handoff, events } = setup({ raw: WORKING, isWindowless: () => false });
  assert.deepEqual(await handoff.now('s1'), { result: 'failed', reason: 'not-windowless' });
  assert.deepEqual(events, []);
});

test('parked background session is raised, never stopped', async () => {
  const { handoff, events, stops } = setup({ raw: { ...IDLE, host: 'terminal' }, isWindowless: () => false });
  assert.deepEqual(await handoff.request('s1'), { result: 'raised' });
  assert.deepEqual(events, [['focus', 's1', { host: 'terminal', cwd: '/p', kind: 'background' }]]);
  assert.deepEqual(stops, []);
});

test('a raise focuses the folder the session started in, not its current cwd', async () => {
  const ctx = setup({
    raw: { kind: 'interactive', cwd: WORKTREE, host: 'vscode' }, isWindowless: () => false, folderFor: startFolderOnly,
  });
  assert.deepEqual(await ctx.handoff.request('s1'), { result: 'raised' });
  assert.deepEqual(ctx.events, [['focus', 's1', { host: 'vscode', cwd: START, kind: 'interactive' }]]);
});

test('a raise whose folderFor throws is a failed raise, not a rejection', async () => {
  const { handoff } = setup({
    raw: { kind: 'interactive', cwd: '/p', host: 'vscode' }, isWindowless: () => false, folderFor: () => { throw new Error('boom'); },
  });
  assert.deepEqual(await handoff.request('s1'), { result: 'failed', reason: 'boom' });
});

test('an interactive session is raised, never stopped, even while working', async () => {
  const { handoff, events } = setup({ raw: { kind: 'interactive', cwd: '/p', host: 'vscode', stoppedTs: null }, isWindowless: () => false });
  assert.deepEqual(await handoff.request('s1'), { result: 'raised' });
  assert.deepEqual(events.map((e) => e[0]), ['focus']);
});

test('a raise tells focus the session\'s kind, so focus never decides from the host alone', async () => {
  const { handoff, events } = setup({ raw: { kind: 'interactive', cwd: '/p', host: 'vscode' }, isWindowless: () => false });
  await handoff.request('s1');
  assert.deepEqual(events, [['focus', 's1', { host: 'vscode', cwd: '/p', kind: 'interactive' }]]);
});

test('a raise that finds no window is reported as failed, with the reason', async () => {
  const { handoff } = setup({
    isWindowless: () => false,
    focusSession: async () => ({ focused: false, reason: 'background agent — parked window is gone' }),
  });
  assert.deepEqual(await handoff.request('s1'), { result: 'failed', reason: 'background agent — parked window is gone' });
});

test('a raise goes through focus.exclusive', async () => {
  const { handoff, inExclusive } = setup({ isWindowless: () => false });
  await handoff.request('s1');
  assert.deepEqual(inExclusive, [['focus', true]]);
});

// ---- stopping --------------------------------------------------------------------------------------

test('stop ends the agent and clears any wait', async () => {
  const { handoff, store, events } = setup({ raw: WORKING });
  await handoff.request('s1');
  assert.equal(handoffOf(store), 'waiting');
  assert.deepEqual(await handoff.stop('s1'), { result: 'stopped' });
  assert.deepEqual(events, [['stop', 'abcd1234']], 'stopped, and VS Code is not opened');
  assert.equal(handoffOf(store) ?? null, null);
});

test('a Stop hook that lands while stop is still running does not start a move', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const ctx = setup({ raw: WORKING, stopAgent: () => gate });
  await ctx.handoff.request('s1');
  const stopping = ctx.handoff.stop('s1');
  await settle();
  assert.equal(handoffOf(ctx.store) ?? null, null, 'the wait is cleared before the stop is waited on');
  ctx.store.upsert('s1', { stoppedTs: 2 });
  await ctx.handoff.onHook('Stop', { session_id: 's1' });
  release();
  assert.deepEqual(await stopping, { result: 'stopped' });
  assert.deepEqual(ctx.stops, ['abcd1234'], 'stopped once');
  assert.deepEqual(opened(ctx), [], 'and never opened');
});

test('stop on a session without a job is refused', async () => {
  const { handoff, events } = setup({ raw: { kind: 'interactive', cwd: '/p' } });
  assert.deepEqual(await handoff.stop('s1'), { result: 'failed', reason: 'not-background' });
  assert.deepEqual(events, []);
});

test('stop on an unknown session is refused', async () => {
  const { handoff, events } = setup({ raw: null });
  assert.deepEqual(await handoff.stop('s1'), { result: 'failed', reason: 'unknown-session' });
  assert.deepEqual(await handoff.request('s1'), { result: 'failed', reason: 'unknown-session' });
  assert.deepEqual(await handoff.now('s1'), { result: 'failed', reason: 'unknown-session' });
  assert.deepEqual(events, []);
});

test('a failed stop leaves the session alone', async () => {
  const ctx = setup({
    stopAgent: async () => { throw new Error('claude stop failed'); },
  });
  assert.deepEqual(await ctx.handoff.request('s1'), { result: 'failed', reason: 'stop-failed' });
  assert.deepEqual(ctx.events, [['stop', 'abcd1234']], 'VS Code is never opened for a session that is still running');
  assert.equal(handoffOf(ctx.store) ?? null, null);
});

test('a stop that never finishes keeps its own reason', async () => {
  const ctx = setup({
    stopAgent: async () => { throw new Error('stop-timeout'); },
  });
  assert.deepEqual(await ctx.handoff.request('s1'), { result: 'failed', reason: 'stop-timeout' });
  assert.deepEqual(opened(ctx), []);
});

test('a stop that throws before returning a promise is a failed stop too', async () => {
  const store = createStore();
  store.upsert('s1', IDLE);
  const opens = [];
  const handoff = createHandoff({
    store, isWindowless: () => true,
    stopAgent: () => { throw new Error('spawn exploded'); },
    focus: { exclusive: (fn) => fn(), focusSession: async () => ({}), openInVsCode: async (...a) => { opens.push(a); return { focused: true }; } },
  });
  assert.deepEqual(await handoff.request('s1'), { result: 'failed', reason: 'stop-failed' });
  assert.deepEqual(opens, []);
  assert.equal(store.raw('s1').handoff ?? null, null);
});

test('a failed plain stop reports failed', async () => {
  const { handoff } = setup({ stopAgent: async () => { throw new Error('nope'); } });
  assert.deepEqual(await handoff.stop('s1'), { result: 'failed', reason: 'stop-failed' });
});

test('when VS Code will not open after the stop, it says so and clears the move', async () => {
  const { handoff, store } = setup({
    openInVsCode: async () => ({ focused: false, reason: 'open: unable to find application' }),
  });
  assert.deepEqual(await handoff.request('s1'), { result: 'failed', reason: 'open-failed' });
  assert.equal(handoffOf(store) ?? null, null);
  assert.ok(logged.some((l) => l.includes('open: unable to find application')), 'the detail is in the log');
});

test('an open that throws is a failed open', async () => {
  const { handoff, store } = setup({ openInVsCode: async () => { throw new Error('boom'); } });
  assert.deepEqual(await handoff.request('s1'), { result: 'failed', reason: 'open-failed' });
  assert.equal(handoffOf(store) ?? null, null);
});

test('a hook-driven move that fails never rejects, and clears the wait', async () => {
  const { handoff, store } = setup({
    raw: WORKING,
    stopAgent: async () => { throw new Error('nope'); },
  });
  await handoff.request('s1');
  store.upsert('s1', { stoppedTs: 2 });
  assert.deepEqual(await handoff.onHook('Stop', { session_id: 's1' }), { result: 'failed', reason: 'stop-failed' });
  assert.equal(handoffOf(store) ?? null, null);
});

// ---- a desktop to open on ---------------------------------------------------------------------------
// On the NucBox the open goes to a helper in the owner's desktop session, and there may be none (nobody
// logged in) or the helper may not be installed. The agent is only stopped once that is known to work.

const refuses = (why) => async () => why;

test('canOpen refusing: an idle windowless session is not stopped', async () => {
  const { handoff, stops, events, store } = setup({ canOpen: refuses('no-desktop') });
  assert.deepEqual(await handoff.request('s1'), { result: 'failed', reason: 'no-desktop' });
  assert.deepEqual(stops, []);
  assert.deepEqual(events, [], 'nothing stopped, nothing opened');
  assert.equal(handoffOf(store) ?? null, null);
});

test('canOpen refusing: a working one is not waited on', async () => {
  const { handoff, stops, store } = setup({ raw: WORKING, canOpen: refuses('no-desktop') });
  assert.deepEqual(await handoff.request('s1'), { result: 'failed', reason: 'no-desktop' });
  assert.equal(handoffOf(store) ?? null, null, 'no wait was set');
  assert.equal(store.get('s1').handoff ?? null, null, 'and the panel was not told of one');
  assert.deepEqual(stops, []);
});

test('canOpen refusing at turn end: the wait ends, nothing stopped', async () => {
  let why = null;
  const { handoff, store, stops, events } = setup({ raw: WORKING, canOpen: async () => why });
  assert.deepEqual(await handoff.request('s1'), { result: 'waiting' });
  why = 'no-desktop'; // the owner logged out while the turn ran
  store.upsert('s1', { stoppedTs: 2 });
  assert.deepEqual(await handoff.onHook('Stop', { session_id: 's1' }), { result: 'failed', reason: 'no-desktop' });
  assert.deepEqual(stops, []);
  assert.deepEqual(events, []);
  assert.equal(handoffOf(store) ?? null, null, 'the wait is over');
});

test('OPEN NOW: canOpen refusing is not-set-up, nothing stopped', async () => {
  const { handoff, stops, store } = setup({ raw: WORKING, canOpen: refuses('not-set-up') });
  assert.deepEqual(await handoff.now('s1'), { result: 'failed', reason: 'not-set-up' });
  assert.deepEqual(stops, []);
  assert.equal(handoffOf(store) ?? null, null, 'the moving mark is cleared');
});

test('a canOpen that rejects counts as not-set-up', async () => {
  const ctx = setup({ canOpen: async () => { throw new Error('schtasks exploded'); } });
  assert.deepEqual(await ctx.handoff.request('s1'), { result: 'failed', reason: 'not-set-up' });
  assert.deepEqual(ctx.stops, []);
  const sync = setup({ canOpen: () => { throw new Error('threw before returning a promise'); } });
  assert.deepEqual(await sync.handoff.now('s1'), { result: 'failed', reason: 'not-set-up' });
  assert.deepEqual(sync.stops, []);
});

test('STOP does not ask canOpen', async () => {
  let asked = 0;
  const { handoff, stops } = setup({ canOpen: async () => { asked++; return 'no-desktop'; } });
  assert.deepEqual(await handoff.stop('s1'), { result: 'stopped' });
  assert.deepEqual(stops, ['abcd1234']);
  assert.equal(asked, 0);
});

test('canOpen answering null lets the move through as before', async () => {
  const { handoff, events } = setup({ canOpen: async () => null });
  assert.deepEqual(await handoff.request('s1'), { result: 'opened' });
  assert.deepEqual(events, [['stop', 'abcd1234'], ['open', '/p', 's1', undefined]]);
});

test('a session that is raised, not moved, never asks canOpen', async () => {
  let asked = 0;
  const { handoff } = setup({ isWindowless: () => false, canOpen: async () => { asked++; return 'no-desktop'; } });
  assert.deepEqual(await handoff.request('s1'), { result: 'raised' });
  assert.equal(asked, 0);
});

test('a refusal is logged with the job and the reason', async () => {
  logged.length = 0;
  await setup({ canOpen: refuses('no-desktop') }).handoff.request('s1');
  const lines = logged.filter((l) => / HO /.test(l));
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /abcd1234.*no-desktop/);
});

test('two presses while the desktop is being checked are one move', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const ctx = setup({ canOpen: async () => { await gate; return null; } });
  const first = ctx.handoff.request('s1');
  const second = ctx.handoff.request('s1');
  await settle();
  release();
  assert.deepEqual(await Promise.all([first, second]), [{ result: 'opened' }, { result: 'opened' }]);
  assert.deepEqual(ctx.stops, ['abcd1234'], 'stopped once');
  assert.equal(opened(ctx).length, 1);
});

test('a turn that ends while the desktop is being checked moves, it does not wait for a Stop that has come', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const ctx = setup({ raw: WORKING, canOpen: async () => { await gate; return null; } });
  const pressed = ctx.handoff.request('s1');
  await settle();
  ctx.store.upsert('s1', { stoppedTs: 2 });
  await ctx.handoff.onHook('Stop', { session_id: 's1' }); // heard before the press set any wait
  release();
  assert.deepEqual(await pressed, { result: 'opened' });
  assert.deepEqual(ctx.stops, ['abcd1234']);
  assert.equal(handoffOf(ctx.store) ?? null, null);
});

test('a session that ends while the desktop is being checked is unknown, not waited on', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const ctx = setup({ raw: WORKING, canOpen: async () => { await gate; return null; } });
  const pressed = ctx.handoff.request('s1');
  await settle();
  ctx.store.remove('s1');
  release();
  assert.deepEqual(await pressed, { result: 'failed', reason: 'unknown-session' });
  assert.equal(ctx.store.count(), 0);
});

// A STOP or a cancel that lands while a press waits on the desktop check is the owner's later word. The press
// must not carry on afterwards as if it had not happened.
function gated() {
  let release;
  const gate = new Promise((r) => { release = r; });
  return { release, canOpen: async () => { await gate; return null; } };
}

test('a STOP that lands while an idle session\'s press waits on the desktop check wins: nothing is moved', async () => {
  const g = gated();
  const ctx = setup({ canOpen: g.canOpen });
  const pressed = ctx.handoff.request('s1');
  await settle();
  const stopped = ctx.handoff.stop('s1');
  g.release();
  assert.deepEqual(await pressed, { result: 'cancelled' });
  assert.deepEqual(await stopped, { result: 'stopped' });
  assert.deepEqual(ctx.stops, ['abcd1234'], 'stopped once, and only by STOP');
  assert.deepEqual(opened(ctx), [], 'VS Code is not opened on a session the owner just stopped');
  assert.deepEqual(ctx.opens, []);
  assert.equal(handoffOf(ctx.store) ?? null, null);
});

test('a STOP that lands while a working session\'s press waits on the desktop check leaves no wait set', async () => {
  const g = gated();
  const ctx = setup({ raw: WORKING, canOpen: g.canOpen });
  const pressed = ctx.handoff.request('s1');
  await settle();
  const stopped = ctx.handoff.stop('s1');
  g.release();
  assert.deepEqual(await pressed, { result: 'cancelled' });
  assert.deepEqual(await stopped, { result: 'stopped' });
  assert.equal(handoffOf(ctx.store) ?? null, null, 'STOP dropped the wait, and the press did not set it again');
  assert.equal(ctx.store.get('s1').handoff ?? null, null);
  // So the turn's end moves nothing.
  ctx.store.upsert('s1', { stoppedTs: 2 });
  assert.equal(await ctx.handoff.onHook('Stop', { session_id: 's1' }), undefined);
  assert.deepEqual(ctx.stops, ['abcd1234']);
  assert.deepEqual(opened(ctx), []);
});

test('a cancel that lands while a press waits on the desktop check wins: no wait, no move', async () => {
  // Waiting already (a second press is the one being checked), and idle: neither carries on.
  for (const raw of [{ ...WORKING, handoff: 'waiting' }, IDLE]) {
    const g = gated();
    const ctx = setup({ raw, canOpen: g.canOpen });
    const pressed = ctx.handoff.request('s1');
    await settle();
    assert.deepEqual(await ctx.handoff.cancel('s1'), { result: 'cancelled' });
    g.release();
    assert.deepEqual(await pressed, { result: 'cancelled' }, JSON.stringify(raw));
    assert.equal(handoffOf(ctx.store) ?? null, null, 'the cancel stands');
    assert.deepEqual(ctx.stops, []);
    assert.deepEqual(ctx.events, []);
  }
});

test('a press that was cancelled is logged once, with the job', async () => {
  const g = gated();
  const ctx = setup({ canOpen: g.canOpen });
  const pressed = ctx.handoff.request('s1');
  await settle();
  logged.length = 0;
  await ctx.handoff.cancel('s1');
  g.release();
  await pressed;
  const lines = logged.filter((l) => / HO /.test(l) && /abcd1234/.test(l));
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /not moving abcd1234/);
});

test('a STOP or cancel before the press, or after its check, does not cancel it', async () => {
  const ctx = setup({ raw: WORKING });
  await ctx.handoff.cancel('s1');
  assert.deepEqual(await ctx.handoff.request('s1'), { result: 'waiting' }, 'a cancel before the press is not this press\'s');
  await ctx.handoff.cancel('s1');
  assert.equal(handoffOf(ctx.store) ?? null, null);
  assert.deepEqual(await ctx.handoff.request('s1'), { result: 'waiting' }, 'nor one that ended an earlier wait');
  const stopped = setup();
  assert.deepEqual(await stopped.handoff.stop('s1'), { result: 'stopped' });
  assert.deepEqual(await stopped.handoff.request('s1'), { result: 'opened' }, 'a STOP before the press is not this press\'s');
});

test('a session that a window parks on while its press waits on the desktop check is raised, not stopped', async () => {
  let windowless = true;
  const g = gated();
  const ctx = setup({ isWindowless: () => windowless, canOpen: g.canOpen });
  const pressed = ctx.handoff.request('s1');
  await settle();
  windowless = false;
  g.release();
  assert.deepEqual(await pressed, { result: 'raised' });
  assert.deepEqual(ctx.stops, []);
  assert.deepEqual(ctx.events.map((e) => e[0]), ['focus']);
  assert.equal(handoffOf(ctx.store) ?? null, null);
});

// ---- onOpened: the one place a finished move is announced ------------------------------------------

test('onOpened hears a move that is waited on and fired by the Stop hook', async () => {
  const { handoff, store, opens } = setup({ raw: WORKING });
  await handoff.request('s1');
  assert.deepEqual(opens, []);
  store.upsert('s1', { stoppedTs: 2 });
  assert.deepEqual(await handoff.onHook('Stop', { session_id: 's1' }), { result: 'opened' });
  assert.deepEqual(opens, ['s1'], 'once, with the session id');
});

test('onOpened hears an idle move and an OPEN NOW, once each', async () => {
  const a = setup();
  await a.handoff.request('s1');
  assert.deepEqual(a.opens, ['s1']);
  const b = setup({ raw: WORKING });
  await b.handoff.request('s1');
  await b.handoff.now('s1');
  assert.deepEqual(b.opens, ['s1']);
});

test('onOpened is not told of a raise, a plain stop, a failed stop or a failed open', async () => {
  const raised = setup({ isWindowless: () => false });
  await raised.handoff.request('s1');
  const stopped = setup({ raw: WORKING });
  await stopped.handoff.stop('s1');
  const badStop = setup({ stopAgent: async () => { throw new Error('nope'); } });
  await badStop.handoff.request('s1');
  const badOpen = setup({ openInVsCode: async () => ({ focused: false, reason: 'no' }) });
  await badOpen.handoff.request('s1');
  assert.deepEqual([raised.opens, stopped.opens, badStop.opens, badOpen.opens], [[], [], [], []]);
});

test('a joined press does not announce the move twice', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const ctx = setup({ stopAgent: () => gate });
  const first = ctx.handoff.request('s1');
  const second = ctx.handoff.request('s1');
  await settle();
  release();
  await Promise.all([first, second]);
  assert.deepEqual(ctx.opens, ['s1']);
});

test('an onOpened that throws does not change the result or leave the move uncleared', async () => {
  const ctx = setup({ onOpened: () => { throw new Error('inbox on fire'); } });
  assert.deepEqual(await ctx.handoff.request('s1'), { result: 'opened' });
  assert.equal(ctx.store.raw('s1').handoff ?? null, null);
});

test('without an onOpened, a move still works', async () => {
  const store = createStore();
  store.upsert('s1', IDLE);
  const handoff = createHandoff({
    store, isWindowless: () => true, stopAgent: async () => {},
    focus: { exclusive: (fn) => fn(), focusSession: async () => ({}), openInVsCode: async () => ({ focused: true }) },
  });
  assert.deepEqual(await handoff.request('s1'), { result: 'opened' });
});

// ---- races -----------------------------------------------------------------------------------------

test('two presses during a move are one move', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const ctx = setup({ stopAgent: () => gate });
  const first = ctx.handoff.request('s1');
  const second = ctx.handoff.request('s1');
  const third = ctx.handoff.now('s1');
  await settle();
  release();
  assert.deepEqual(await Promise.all([first, second, third]), [
    { result: 'opened' }, { result: 'opened' }, { result: 'opened' },
  ]);
  assert.deepEqual(ctx.stops, ['abcd1234']);
  assert.equal(ctx.events.filter((e) => e[0] === 'open').length, 1);
});

test('a plain stop during a move is refused', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const ctx = setup({ stopAgent: () => gate });
  const moving = ctx.handoff.request('s1');
  await settle();
  assert.deepEqual(await ctx.handoff.stop('s1'), { result: 'failed', reason: 'moving' });
  release();
  assert.deepEqual(await moving, { result: 'opened' });
});

test('a session that ends during the move is not brought back by clearing its state', async () => {
  const ctx = setup({
    stopAgent: async () => { ctx.store.remove('s1'); },
  });
  assert.deepEqual(await ctx.handoff.request('s1'), { result: 'opened' });
  assert.equal(ctx.store.raw('s1'), undefined);
  assert.equal(ctx.store.count(), 0);
});

test('one line is logged per move and per stop', async () => {
  const lines = async (run) => {
    logged.length = 0;
    await run();
    return logged.filter((l) => / HO /.test(l));
  };
  const moved = await lines(() => setup().handoff.request('s1'));
  assert.equal(moved.length, 1, moved.join('\n'));
  assert.match(moved[0], /abcd1234.*VS Code/);
  const stopped = await lines(() => setup({ raw: WORKING }).handoff.stop('s1'));
  assert.equal(stopped.length, 1, stopped.join('\n'));
  assert.match(stopped[0], /stopped abcd1234/);
});

// ---- claudeStop ------------------------------------------------------------------------------------

// execFile's signature, answering the three things claudeStop runs, in the order it runs them:
//   1. `claude agents --json` before the stop, to read the job's pid: `before`
//   2. `claude stop <id>`: `stop` (null, or the Error it fails with)
//   3. `claude agents --json` again, only in the fallback: `listings`, one per call, the last repeating
// A listing is a string (stdout), an Error (a failed listing), or null (a good listing that has other
// sessions in it and not the job).
function fakeRun({ before = JOB_WITH_PID, stop = null, listings = [null] } = {}) {
  const calls = [];
  let listed = 0;
  const run = (cmd, args, opts, cb) => {
    calls.push({ cmd, args, opts });
    if (args[0] === 'stop') {
      setImmediate(() => cb(stop, stop ? '' : `stopped ${args[1]}\n`, ''));
      return;
    }
    const next = listed++ === 0 ? before : listings[Math.min(listed - 2, listings.length - 1)];
    const out = next === null ? OTHERS : next;
    setImmediate(() => (out instanceof Error ? cb(out, '', '') : cb(null, out, '')));
  };
  return { run, calls, agentCalls: () => calls.filter((c) => c.args[0] !== 'stop') };
}
// isAlive(pid) answering from a list, the last answer repeating; records what it was asked.
function fakeAlive(answers) {
  const asked = [];
  const isAlive = (pid) => { asked.push(pid); return answers[Math.min(asked.length - 1, answers.length - 1)]; };
  return { isAlive, asked };
}
const listing = (...entries) => JSON.stringify(entries);
const JOB_WITH_PID = listing({ pid: 4242, id: 'abcd1234', kind: 'background' }, { pid: 999, id: 'ffff0000', kind: 'background' });
const JOB_UP = listing({ id: 'abcd1234', kind: 'background' }, { id: 'ffff0000', kind: 'background' });
// Other sessions are listed, the job is not: a listing that can say the job has gone.
const OTHERS = listing({ pid: 999, id: 'ffff0000', kind: 'background' }, { id: 'ddddeeee', kind: 'interactive' });
const FAST = { pollMs: 2, deadlineMs: 400 };
const STOP_CALL = { cmd: 'claude', args: ['stop', 'abcd1234'], opts: { timeout: 15_000 } };
const LISTING_ARGS = ['--settings', '{"disableAllHooks":true}', 'agents', '--json'];

// -- the proof of exit is the process --

test('claudeStop reads the job\'s pid, stops it, then waits for that process to be gone', async () => {
  const { run, calls } = fakeRun();
  const { isAlive, asked } = fakeAlive([true, true, false]);
  await claudeStop('abcd1234', { run, isAlive, ...FAST });
  assert.deepEqual(calls.map((c) => c.args), [LISTING_ARGS, ['stop', 'abcd1234']], 'the listing comes first, and nothing is listed after');
  assert.deepEqual(calls[0].opts, { timeout: 10_000 });
  assert.deepEqual(calls[1], STOP_CALL);
  assert.deepEqual(asked, [4242, 4242, 4242], 'the job\'s own pid, until it was gone');
});

test('claudeStop is satisfied by the process going even when the registry is empty afterwards', async () => {
  // The only entry in the registry was the job: the listing after the stop is a genuine `[]`.
  const { run, calls } = fakeRun({ listings: ['[]'] });
  const { isAlive } = fakeAlive([true, false]);
  await claudeStop('abcd1234', { run, isAlive, ...FAST });
  assert.equal(calls.length, 2, 'no listing was needed to know it');
});

test('claudeStop rejects with stop-timeout when the process outlives the deadline', async () => {
  const { run } = fakeRun();
  const { isAlive, asked } = fakeAlive([true]);
  const t0 = Date.now();
  await assert.rejects(claudeStop('abcd1234', { run, isAlive, pollMs: 2, deadlineMs: 60 }), { message: 'stop-timeout' });
  assert.ok(Date.now() - t0 >= 50, 'it waited out the deadline');
  assert.ok(asked.length > 2 && asked.every((p) => p === 4242));
});

test('with a pid to watch, a registry that no longer lists the job does not end the wait while the process lives', async () => {
  const { run } = fakeRun({ listings: [null] });
  const { isAlive } = fakeAlive([true]);
  await assert.rejects(claudeStop('abcd1234', { run, isAlive, pollMs: 2, deadlineMs: 40 }), { message: 'stop-timeout' });
});

test('pidAlive: ESRCH is gone, EPERM and success are alive', () => {
  const kill = mock.method(process, 'kill', (pid, sig) => {
    if (pid === 111) { throw Object.assign(new Error('no such process'), { code: 'ESRCH' }); }
    if (pid === 222) { throw Object.assign(new Error('not permitted'), { code: 'EPERM' }); }
    return true;
  });
  try {
    assert.equal(pidAlive(111), false);
    assert.equal(pidAlive(222), true, 'a process we may not signal still exists');
    assert.equal(pidAlive(333), true);
    assert.deepEqual(kill.mock.calls.map((c) => c.arguments), [[111, 0], [222, 0], [333, 0]], 'signal 0: a check, never a kill');
  } finally {
    kill.mock.restore();
  }
});

// -- no pid to watch: the listings have to say --

test('claudeStop without a pid in the first listing still stops the job, then goes by the listings', async () => {
  for (const before of [
    listing({ id: 'abcd1234', kind: 'background' }),              // listed, no pid
    listing({ pid: 1, id: 'abcd1234', kind: 'background' }),       // not a pid we may signal
    listing({ pid: '4242', id: 'abcd1234', kind: 'background' }),  // not a number
    listing({ pid: 4242, id: 'abcd1234', kind: 'interactive' }),   // not the background job
    OTHERS,                                                         // not listed at all
    new Error('boot failed'),                                       // no listing
    'not json',
  ]) {
    const { run, calls } = fakeRun({ before, listings: [null] });
    const { isAlive, asked } = fakeAlive([true]);
    await claudeStop('abcd1234', { run, isAlive, ...FAST });
    assert.deepEqual(calls[1], STOP_CALL, 'stop ran');
    assert.equal(calls.length, 4, 'listing, stop, and two listings without the job');
    assert.deepEqual(asked, [], 'no process to check');
  }
});

test('fallback: two listings in a row without the job are enough; one is not', async () => {
  const { run, calls } = fakeRun({ before: OTHERS, listings: [JOB_UP, null, JOB_UP, null, null] });
  await claudeStop('abcd1234', { run, ...FAST });
  assert.equal(calls.length, 2 + 5, 'absent, present, absent was not enough');
});

test('fallback: a single empty listing does not count, and the job listed after it keeps us waiting', async () => {
  const { run } = fakeRun({ before: OTHERS, listings: ['[]', JOB_UP] });
  await assert.rejects(claudeStop('abcd1234', { run, pollMs: 2, deadlineMs: 60 }), { message: 'stop-timeout' });
});

test('fallback: two empty listings in a row count', async () => {
  const { run, calls } = fakeRun({ before: OTHERS, listings: ['[]', '[]'] });
  await claudeStop('abcd1234', { run, ...FAST });
  assert.equal(calls.length, 2 + 2);
});

test('fallback: an empty listing and a non-empty one do not agree, so they are not a pair', async () => {
  const { run, calls } = fakeRun({ before: OTHERS, listings: ['[]', null, '[]', '[]'] });
  await claudeStop('abcd1234', { run, ...FAST });
  assert.equal(calls.length, 2 + 4, 'empty, others, empty, empty: only the last two agree');
  const wrapped = fakeRun({ before: OTHERS, listings: [JSON.stringify({ agents: [] }), '[]'] });
  await claudeStop('abcd1234', { run: wrapped.run, ...FAST });
  assert.equal(wrapped.calls.length, 2 + 2, 'the wrapped shape is the same empty listing');
});

test('fallback: an interactive entry with the job\'s id is a listing without the job', async () => {
  const lone = listing({ id: 'abcd1234', kind: 'interactive' });
  const { run, calls } = fakeRun({ before: OTHERS, listings: [lone] });
  await claudeStop('abcd1234', { run, ...FAST });
  assert.equal(calls.length, 2 + 2);
});

test('fallback: a failed or unreadable listing breaks the run', async () => {
  const { run, calls } = fakeRun({
    before: OTHERS, listings: [null, new Error('boot failed'), null, 'not json', null, null],
  });
  await claudeStop('abcd1234', { run, ...FAST });
  assert.equal(calls.length, 2 + 6);
});

test('fallback: listings that keep failing, or keep coming back with the job, time out', async () => {
  for (const bad of [new Error('boot failed'), JOB_UP]) {
    const { run } = fakeRun({ before: OTHERS, listings: [bad] });
    await assert.rejects(claudeStop('abcd1234', { run, pollMs: 2, deadlineMs: 40 }), { message: 'stop-timeout' });
  }
});

test('fallback: each listing is capped at the time that is left', async () => {
  const slow = fakeRun({ before: OTHERS, listings: [null] });
  await claudeStop('abcd1234', { run: slow.run, pollMs: 2 }); // the default deadline
  assert.deepEqual(slow.calls[2].opts, { timeout: 10_000 }, 'plenty of time: the listing\'s own limit');

  const short = fakeRun({ before: OTHERS, listings: [null] });
  await claudeStop('abcd1234', { run: short.run, pollMs: 2, deadlineMs: 3_000 });
  const t = short.calls.slice(2).map((c) => c.opts.timeout);
  assert.ok(t.length === 2 && t.every((x) => x > 0 && x <= 3_000), t.join(','));
});

// -- the command itself --

test('claudeStop rejects with stop-failed when claude stop itself fails, and watches nothing', async () => {
  const { run, calls } = fakeRun({ stop: new Error('no such job') });
  const { isAlive, asked } = fakeAlive([false]);
  await assert.rejects(claudeStop('abcd1234', { run, isAlive, ...FAST }), { message: 'stop-failed' });
  assert.equal(calls.length, 2, 'the first listing and the failed stop');
  assert.deepEqual(asked, []);
});

test('claudeStop only ever hands a short id to claude', async () => {
  const { run, calls } = fakeRun();
  const { isAlive } = fakeAlive([false]);
  await assert.rejects(claudeStop('--all', { run, isAlive, ...FAST }), { message: 'stop-failed' });
  await assert.rejects(claudeStop('', { run, isAlive, ...FAST }), { message: 'stop-failed' });
  await assert.rejects(claudeStop(undefined, { run, isAlive, ...FAST }), { message: 'stop-failed' });
  assert.equal(calls.length, 0, 'nothing was run');
});

// ---- a session the panel's reply has woken --------------------------------------------------------------

// index.js wires the bridge to the store like this: what a delivery records (deliveredFields) goes into
// store.touch. The rewake path fires no UserPromptSubmit, so without it the woken turn still looks finished.
function wiredBridge(store) {
  return createMessageBridge({
    emit: () => {},
    onDelivered: (id, text, via) => store.touch(id, background.deliveredFields(store.raw(id), via, text)),
  });
}

test('a background session woken by a panel reply is mid-turn: the Open row waits, it does not move', async () => {
  const ctx = setup();
  const bridge = wiredBridge(ctx.store);
  assert.equal(background.turnEnded(ctx.store.raw('s1')), true, 'finished before the reply');

  const woken = bridge.waitForIdleMessage('s1');
  assert.equal(bridge.send('s1', 'also run the linter'), 'woke');
  await woken;

  assert.equal(ctx.store.raw('s1').stoppedTs, null);
  assert.equal(ctx.store.raw('s1').thinking, true);
  assert.equal(ctx.store.raw('s1').lastPrompt, 'also run the linter');
  assert.deepEqual(await ctx.handoff.request('s1'), { result: 'waiting' });
  assert.deepEqual(ctx.events, [], 'nothing was stopped under the woken turn');
  assert.equal(handoffOf(ctx.store), 'waiting');

  // Its Stop, when the woken turn ends, is what moves it.
  ctx.store.upsert('s1', { stoppedTs: 99 });
  assert.deepEqual(await ctx.handoff.onHook('Stop', { session_id: 's1' }), { result: 'opened' });
});

test('a message waiting for the poller and handed over when it arrives wakes the session too', async () => {
  const ctx = setup();
  const bridge = wiredBridge(ctx.store);
  bridge.send('s1', 'early');
  await bridge.waitForIdleMessage('s1');
  assert.deepEqual(await ctx.handoff.request('s1'), { result: 'waiting' });
});

test('a next-tool delivery changes nothing about the turn state (the session was already working)', () => {
  const ctx = setup({ raw: { ...WORKING, thinking: true } });
  const bridge = wiredBridge(ctx.store);
  bridge.send('s1', 'hi');
  bridge.onPostToolUse({ session_id: 's1' });
  assert.equal(ctx.store.raw('s1').stoppedTs, null);
  assert.equal(ctx.store.raw('s1').lastPrompt, 'hi');
});

test('an interactive session woken by a panel reply only gets its intent line, as before', () => {
  const store = createStore();
  store.upsert('w1', { kind: 'interactive', stoppedTs: 5, thinking: false });
  const bridge = wiredBridge(store);
  bridge.waitForIdleMessage('w1');
  bridge.send('w1', 'go on');
  assert.equal(store.raw('w1').stoppedTs, 5, 'the owner types in its window; its own hooks clear this');
  assert.equal(store.raw('w1').thinking, false);
  assert.equal(store.raw('w1').lastPrompt, 'go on');
});

test('deliveredFields: only a wake of a background session marks the turn running', () => {
  const { deliveredFields } = background;
  assert.deepEqual(deliveredFields({ kind: 'background' }, 'wake', 'x'), { lastPrompt: 'x', stoppedTs: null, thinking: true });
  assert.deepEqual(deliveredFields({ kind: 'background' }, 'next-tool', 'x'), { lastPrompt: 'x' });
  assert.deepEqual(deliveredFields({ kind: 'interactive' }, 'wake', 'x'), { lastPrompt: 'x' });
  assert.deepEqual(deliveredFields({}, 'wake', 'x'), { lastPrompt: 'x' });
  assert.deepEqual(deliveredFields(undefined, 'wake', 'x'), { lastPrompt: 'x' });
});
