// Run with CLAUDE_THING_HOLD_MS small so the timeout path is testable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPermissionBridge } from '../src/permission-bridge.js';
import { createStore } from '../src/sessions/store.js';
import { DEFAULT_PERMISSION_HOLD_MS } from '../src/config.js';
import { UNAVAILABLE_REASON } from '../src/background.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Stands in for the held HTTP response of a PermissionRequest hook.
function fakeRes() {
  const res = {
    body: null,
    status: null,
    closed: false,
    handlers: {},
    writeHead(code) { this.status = code; },
    end(body) { this.body = body; },
    on(event, fn) { this.handlers[event] = fn; },
  };
  return res;
}

function decisionOf(res) {
  return JSON.parse(res.body).hookSpecificOutput.decision.behavior;
}

function setup(queue) {
  const events = [];
  const store = createStore();
  const bridge = createPermissionBridge({
    emit: (topic, data) => events.push({ topic, data }),
    store,
    queue,
  });
  return { bridge, store, events };
}

const HOOK = {
  session_id: 'sess-1',
  tool_name: 'Bash',
  tool_input: { command: 'rm -rf node_modules' },
  cwd: '/tmp/proj',
};

test('a held request emits a request event and marks the session', () => {
  const { bridge, store, events } = setup();
  bridge.onHookRequest(HOOK, fakeRes());

  const req = events.find((e) => e.topic === 'claude.permission.request');
  assert.ok(req, 'emitted claude.permission.request');
  assert.equal(req.data.tool, 'Bash');
  assert.equal(req.data.summary, 'rm -rf node_modules', 'summary is the argument, not tool-prefixed');
  assert.ok(req.data.requestId);
  assert.equal(store.get('sess-1').pendingPermission, true);
});

test('allow answers the hook with allow and clears the session', () => {
  const { bridge, store, events } = setup();
  const res = fakeRes();
  bridge.onHookRequest(HOOK, res);
  const { requestId } = events.find((e) => e.topic === 'claude.permission.request').data;

  assert.equal(bridge.answer(requestId, 'allow'), true);
  assert.equal(decisionOf(res), 'allow');
  assert.equal(res.status, 200);
  assert.equal(store.get('sess-1').pendingPermission, false);

  const resolved = events.find((e) => e.topic === 'claude.permission.resolved');
  assert.equal(resolved.data.resolution, 'allow');
});

test('deny answers the hook with deny', () => {
  const { bridge, events } = setup();
  const res = fakeRes();
  bridge.onHookRequest(HOOK, res);
  const { requestId } = events.find((e) => e.topic === 'claude.permission.request').data;
  bridge.answer(requestId, 'deny');
  assert.equal(decisionOf(res), 'deny');
});

test('answering twice is idempotent — the second is refused', () => {
  const { bridge, events } = setup();
  bridge.onHookRequest(HOOK, fakeRes());
  const { requestId } = events.find((e) => e.topic === 'claude.permission.request').data;
  assert.equal(bridge.answer(requestId, 'allow'), true);
  assert.equal(bridge.answer(requestId, 'deny'), false);
});

test('an unknown requestId is refused, not thrown', () => {
  const { bridge } = setup();
  assert.equal(bridge.answer('nope', 'allow'), false);
});

test('a bad decision is rejected', () => {
  const { bridge, events } = setup();
  bridge.onHookRequest(HOOK, fakeRes());
  const { requestId } = events.find((e) => e.topic === 'claude.permission.request').data;
  assert.throws(() => bridge.answer(requestId, 'maybe'), /allow\|deny/);
});

test('timing out answers "ask" so the terminal decides — it never auto-denies', async () => {
  const { bridge, store, events } = setup();
  const res = fakeRes();
  bridge.onHookRequest(HOOK, res);

  await sleep(Number(process.env.CLAUDE_THING_HOLD_MS) + 60);

  assert.equal(decisionOf(res), 'ask', 'must hand back to the terminal');
  const resolved = events.find((e) => e.topic === 'claude.permission.resolved');
  assert.equal(resolved.data.resolution, 'timeout');
  assert.equal(store.get('sess-1').pendingPermission, false);
});

test('pending requests are listable for clients that connect late', () => {
  const { bridge, store } = setup();
  store.touch('sess-1', { name: 'proj' });
  bridge.onHookRequest(HOOK, fakeRes());

  const [ask] = bridge.list();
  assert.equal(ask.kind, 'permission');
  assert.equal(ask.sessionName, 'proj');
  assert.equal(ask.tool, 'Bash');
  assert.ok(ask.timeoutMs > 0);
  assert.equal(bridge.pendingCount(), 1);
});

test('the hook giving up (socket close) clears our state too', () => {
  const { bridge, store, events } = setup();
  const res = fakeRes();
  bridge.onHookRequest(HOOK, res);
  res.handlers.close();

  assert.equal(store.get('sess-1').pendingPermission, false);
  assert.equal(bridge.pendingCount(), 0);
  assert.ok(events.some((e) => e.topic === 'claude.permission.resolved'));
});

test('an interactive ask whose hook gives up is resolved as a timeout', () => {
  const { bridge, events } = setup();
  const res = fakeRes();
  bridge.onHookRequest(HOOK, res);
  res.handlers.close();
  const resolved = events.filter((e) => e.topic === 'claude.permission.resolved');
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].data.resolution, 'timeout');
});

test('an Esc interrupt releases a held permission with "ask" and clears the tile', () => {
  const { bridge, store, events } = setup();
  const res = fakeRes();
  bridge.onHookRequest(HOOK, res);
  assert.equal(bridge.pendingCount(), 1);

  bridge.cancelSession('sess-1', Date.now() + 1);
  assert.equal(bridge.pendingCount(), 0);
  assert.equal(decisionOf(res), 'ask', 'never decides for a turn that is already dead');
  assert.equal(store.get('sess-1').pendingPermission, false);
  const resolved = events.find((e) => e.topic === 'claude.permission.resolved');
  assert.equal(resolved.data.resolution, 'interrupted');
});

test('a replayed interrupt marker older than the permission leaves it held', () => {
  const { bridge } = setup();
  bridge.onHookRequest(HOOK, fakeRes());
  bridge.cancelSession('sess-1', Date.now() - 60_000);
  assert.equal(bridge.pendingCount(), 1);
});

test('ExitPlanMode is never held — hook gets "ask" back, plan goes to the queue', () => {
  const planCalls = [];
  const { bridge, events } = setup({ onPlanApproval: (p) => planCalls.push(p) });
  const res = fakeRes();
  bridge.onHookRequest({
    session_id: 'sess-1',
    tool_name: 'ExitPlanMode',
    tool_input: { plan: '# Big plan' },
  }, res);

  assert.equal(decisionOf(res), 'ask', 'terminal dialog stays authoritative');
  assert.equal(res.status, 200);
  assert.equal(bridge.pendingCount(), 0, 'nothing held — the hook decision cannot approve a plan');
  assert.equal(planCalls.length, 1, 'routed to the queue as a question');
  assert.equal(planCalls[0].tool_input.plan, '# Big plan');
  assert.ok(!events.some((e) => e.topic === 'claude.permission.request'), 'no permission tile');
});

test('AskUserQuestion is never held — PreToolUse already queued the real card', () => {
  const planCalls = [];
  const { bridge, store, events } = setup({ onPlanApproval: (p) => planCalls.push(p) });
  const res = fakeRes();
  bridge.onHookRequest({
    session_id: 'sess-1',
    tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ header: 'Task', question: 'Which?', options: [{ label: 'A' }] }] },
  }, res);

  assert.equal(decisionOf(res), 'ask', 'terminal keeps the gate');
  assert.equal(bridge.pendingCount(), 0, 'nothing held');
  assert.equal(planCalls.length, 0, 'not a plan');
  assert.ok(!events.some((e) => e.topic === 'claude.permission.request'), 'no second card');
  assert.ok(!store.get('sess-1'), 'no permission state on the session');
});

test('a tool with no salient key summarises readably, never as raw JSON', () => {
  const { bridge, events } = setup();
  bridge.onHookRequest({ ...HOOK, tool_name: 'Task', tool_input: { prompt: 'go find it' } }, fakeRes());
  bridge.onHookRequest({ ...HOOK, tool_name: 'Weird', tool_input: { questions: [{ a: 1 }], n: 2 } }, fakeRes());
  const summaries = events.filter((e) => e.topic === 'claude.permission.request').map((e) => e.data.summary);
  assert.deepEqual(summaries, ['go find it', 'questions, n']);
  assert.ok(!summaries.some((s) => s.includes('{')), 'no JSON reaches the device');
});

test('file and url tools summarise their salient argument', () => {
  const { bridge, events } = setup();
  bridge.onHookRequest({ ...HOOK, tool_name: 'Edit', tool_input: { file_path: '/tmp/a.js' } }, fakeRes());
  bridge.onHookRequest({ ...HOOK, tool_name: 'WebFetch', tool_input: { url: 'https://example.com' } }, fakeRes());
  const summaries = events.filter((e) => e.topic === 'claude.permission.request').map((e) => e.data.summary);
  assert.deepEqual(summaries, ['/tmp/a.js', 'https://example.com']);
});

test('the ask carries what the user asked for, when a prompt has been seen', () => {
  const { bridge, store, events } = setup();
  store.upsert('sess-1', { lastPrompt: 'reinstall the device-app deps' });
  bridge.onHookRequest(HOOK, fakeRes());

  const req = events.find((e) => e.topic === 'claude.permission.request');
  assert.equal(req.data.intent, 'you asked: reinstall the device-app deps');
  assert.equal(bridge.list()[0].intent, 'you asked: reinstall the device-app deps',
    'late clients get the same line from the queue list');
});

test('no prompt seen means an empty intent, never an invented one', () => {
  const { bridge, events } = setup();
  bridge.onHookRequest(HOOK, fakeRes());
  const req = events.find((e) => e.topic === 'claude.permission.request');
  assert.equal(req.data.intent, '');
  assert.equal(bridge.list()[0].intent, '');
});

// ---- destructive classification --------------------------------------------

test('a destructive command is flagged on the event and in list()', () => {
  const { bridge, events } = setup();
  bridge.onHookRequest(HOOK, fakeRes());   // rm -rf …

  const req = events.find((e) => e.topic === 'claude.permission.request');
  assert.equal(req.data.destructive, true);
  assert.equal(bridge.list()[0].destructive, true);
});

test('a benign command is explicitly not destructive', () => {
  const { bridge, events } = setup();
  bridge.onHookRequest({
    ...HOOK, tool_input: { command: 'ls -la' },
  }, fakeRes());

  const req = events.find((e) => e.topic === 'claude.permission.request');
  assert.equal(req.data.destructive, false);
  assert.equal(bridge.list()[0].destructive, false);
});

test('a --force past the 200-char summary truncation still arms', () => {
  // The device only ever sees summary.slice(0, 200); the daemon classifies
  // against the whole command, so the tail is not a blind spot.
  const command = 'git push origin ' + 'a-very-long-branch-name-'.repeat(9) + ' --force';
  assert.ok(command.length > 200, 'premise: the flag sits past the truncation');
  const { bridge, events } = setup();
  bridge.onHookRequest({ ...HOOK, tool_input: { command } }, fakeRes());

  const req = events.find((e) => e.topic === 'claude.permission.request');
  assert.equal(req.data.destructive, true);
  assert.ok(req.data.summary.length <= 200, 'summary itself stays truncated');
});

test('non-command tools classify against the summary', () => {
  const { bridge, events } = setup();
  bridge.onHookRequest({
    ...HOOK, tool_name: 'Write', tool_input: { file_path: '/tmp/x.txt' },
  }, fakeRes());

  const req = events.find((e) => e.topic === 'claude.permission.request');
  assert.equal(req.data.destructive, false);
});

// ---- panel presence: never stall a session (plan Task 2) --------------------

function setupPanel(panelOnline) {
  const events = [];
  const store = createStore();
  const bridge = createPermissionBridge({
    emit: (topic, data) => events.push({ topic, data }), store, panelOnline,
  });
  return { bridge, events };
}

test('no panel online: hook answers ask immediately', () => {
  const { bridge, events } = setupPanel(() => false);
  const res = fakeRes();
  const t0 = Date.now();
  bridge.onHookRequest(HOOK, res);
  assert.equal(decisionOf(res), 'ask');
  assert.ok(Date.now() - t0 < 50);
  assert.equal(bridge.pendingCount(), 0);
  assert.ok(!events.some((e) => e.topic === 'claude.permission.request'), 'nothing to show, nothing emitted');
});

test('panel online: request is held until answered', async () => {
  const { bridge, events } = setupPanel(() => true);
  const res = fakeRes();
  bridge.onHookRequest(HOOK, res);
  await sleep(100);
  assert.equal(res.body, null, 'still held');
  const { requestId } = events.find((e) => e.topic === 'claude.permission.request').data;
  bridge.answer(requestId, 'allow');
  assert.equal(decisionOf(res), 'allow');
});

test('releaseAll answers ask for every held request', () => {
  const { bridge } = setupPanel(() => true);
  const a = fakeRes(), b = fakeRes();
  bridge.onHookRequest(HOOK, a);
  bridge.onHookRequest({ ...HOOK, session_id: 'sess-2' }, b);
  assert.equal(bridge.releaseAll('panel-gone'), 2);
  assert.equal(decisionOf(a), 'ask');
  assert.equal(decisionOf(b), 'ask');
  assert.equal(bridge.pendingCount(), 0);
  assert.equal(bridge.releaseAll('panel-gone'), 0);
});

test('default hold is 20000ms', () => {
  assert.equal(DEFAULT_PERMISSION_HOLD_MS, 20000);
});

// ---- background sessions: no window to hand an ask back to ------------------

function setupBackground({ panelOnline = () => true, isBackground = () => true, bgHoldMs } = {}) {
  const events = [];
  const store = createStore();
  const bridge = createPermissionBridge({
    emit: (topic, data) => events.push({ topic, data }), store, panelOnline, isBackground, bgHoldMs,
  });
  return { bridge, store, events };
}

test('background ask is held with no panel online', () => {
  const { bridge } = setupBackground({ panelOnline: () => false });
  const res = fakeRes();
  bridge.onHookRequest(HOOK, res);
  assert.equal(res.body, null, 'not handed to a dialog nobody can see');
  const asks = bridge.list();
  assert.equal(asks.length, 1);
  assert.equal(asks[0].background, true);
});

test('background ask survives releaseAll("panel-gone") and can still be answered', () => {
  const { bridge, events } = setupBackground();
  const res = fakeRes();
  bridge.onHookRequest(HOOK, res);
  const { requestId } = events.find((e) => e.topic === 'claude.permission.request').data;

  bridge.releaseAll('panel-gone');
  assert.equal(res.body, null, 'still held');
  assert.equal(bridge.list().length, 1);

  assert.equal(bridge.answer(requestId, 'allow'), true);
  assert.equal(decisionOf(res), 'allow');
});

test('background ask is denied with the reason at the hold\'s end', async () => {
  const { bridge, store, events } = setupBackground({ bgHoldMs: 30 });
  const res = fakeRes();
  bridge.onHookRequest(HOOK, res);
  assert.equal(bridge.list()[0].timeoutMs, 30, 'the panel counts down the background hold');

  await sleep(80);

  const { decision } = JSON.parse(res.body).hookSpecificOutput;
  assert.equal(decision.behavior, 'deny');
  assert.equal(decision.message, UNAVAILABLE_REASON, 'the agent is told why, and not to retry');
  const resolved = events.find((e) => e.topic === 'claude.permission.resolved');
  assert.equal(resolved.data.resolution, 'unavailable');
  assert.equal(store.get('sess-1').pendingPermission, false);
  assert.equal(bridge.pendingCount(), 0);
});

test('a background ask whose hook socket closes (the agent was stopped) is abandoned, not timed out', () => {
  const { bridge, store, events } = setupBackground();
  const res = fakeRes();
  bridge.onHookRequest(HOOK, res);
  assert.equal(bridge.pendingCount(), 1);
  res.handlers.close();

  const resolved = events.filter((e) => e.topic === 'claude.permission.resolved');
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].data.resolution, 'abandoned', 'there is no terminal to say "answer in terminal" about');
  assert.equal(store.get('sess-1').pendingPermission, false);
  assert.equal(bridge.pendingCount(), 0);
  assert.equal(bridge.list().length, 0);
});

test('a background ask answered before its socket closes resolves once, as answered', () => {
  const { bridge, events } = setupBackground();
  const res = fakeRes();
  bridge.onHookRequest(HOOK, res);
  const { requestId } = events.find((e) => e.topic === 'claude.permission.request').data;
  bridge.answer(requestId, 'allow');
  res.handlers.close();
  const resolved = events.filter((e) => e.topic === 'claude.permission.resolved');
  assert.deepEqual(resolved.map((e) => e.data.resolution), ['allow']);
});

test('an interactive ask under setupBackground keeps its close as a timeout', () => {
  const { bridge, events } = setupBackground({ isBackground: () => false, panelOnline: () => true });
  const res = fakeRes();
  bridge.onHookRequest(HOOK, res);
  res.handlers.close();
  assert.equal(events.find((e) => e.topic === 'claude.permission.resolved').data.resolution, 'timeout');
});

test('interactive ask keeps today\'s behaviour', () => {
  const { bridge } = setupBackground({ panelOnline: () => false, isBackground: () => false });
  const res = fakeRes();
  bridge.onHookRequest(HOOK, res);
  assert.equal(decisionOf(res), 'ask', 'handed to the visible dialog at once');
  assert.equal(bridge.pendingCount(), 0);
});

test('an interactive ask carries background:false and the interactive hold', () => {
  const { bridge, events } = setupBackground({ isBackground: () => false, bgHoldMs: 30 });
  bridge.onHookRequest(HOOK, fakeRes());
  const req = events.find((e) => e.topic === 'claude.permission.request');
  assert.equal(req.data.background, false);
  assert.equal(bridge.list()[0].background, false);
  assert.equal(bridge.list()[0].timeoutMs, Number(process.env.CLAUDE_THING_HOLD_MS));
});

test('an interrupt still releases a background ask with "ask" — the turn is dead', () => {
  const { bridge } = setupBackground();
  const res = fakeRes();
  bridge.onHookRequest(HOOK, res);
  bridge.cancelSession('sess-1', Date.now() + 1);
  assert.equal(decisionOf(res), 'ask');
  assert.equal(bridge.pendingCount(), 0);
});

test('releaseAll releases the interactive asks and leaves the background ones', () => {
  const { bridge } = setupBackground({ isBackground: (id) => id === 'bg-1' });
  const interactive = fakeRes(), background = fakeRes();
  bridge.onHookRequest(HOOK, interactive);
  bridge.onHookRequest({ ...HOOK, session_id: 'bg-1' }, background);
  assert.equal(bridge.releaseAll('panel-gone'), 1, 'counts only what it released');
  assert.equal(decisionOf(interactive), 'ask');
  assert.equal(background.body, null);
  assert.equal(bridge.pendingCount(), 1);
});
