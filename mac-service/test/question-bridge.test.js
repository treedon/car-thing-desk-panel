// Questions (AskUserQuestion) and plans (ExitPlanMode) answered from the panel
// through the PreToolUse hook: allow + updatedInput answers a question or
// approves a plan; deny + reason sends plan feedback; null leaves the dialog to
// Claude Code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQuestionBridge } from '../src/question-bridge.js';
import { UNAVAILABLE_REASON } from '../src/background.js';

const QUESTIONS = [{
  question: 'Which framework?', header: 'Framework', multiSelect: false,
  options: [{ label: 'React', description: 'r' }, { label: 'Vue', description: 'v' }],
}];
const ask = (over = {}) => ({
  hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'AskUserQuestion',
  tool_input: { questions: QUESTIONS }, transcript_path: '/nonexistent.jsonl', ...over,
});
const plan = () => ask({ tool_name: 'ExitPlanMode', tool_input: { plan: '# Plan\n\n- step one' } });

function setup({ online = true, holdMs = 120000 } = {}) {
  const events = [];
  const bridge = createQuestionBridge({
    emit: (topic, data) => events.push({ topic, data }),
    panelOnline: () => online,
    holdMs,
  });
  const created = () => events.filter((e) => e.topic === 'claude.prompt.created').map((e) => e.data);
  return { bridge, events, created };
}

test('no panel: returns null immediately', async () => {
  const { bridge, created } = setup({ online: false });
  const t0 = Date.now();
  assert.equal(await bridge.handlePreToolUse(ask()), null);
  assert.ok(Date.now() - t0 < 50);
  assert.equal(created().length, 0);
});

test('other tools are not ours', async () => {
  const { bridge } = setup();
  assert.equal(await bridge.handlePreToolUse(ask({ tool_name: 'Bash', tool_input: { command: 'ls' } })), null);
});

test('a held prompt is announced with its questions and context', () => {
  const { bridge, created } = setup();
  bridge.handlePreToolUse(ask());
  const p = created()[0];
  assert.equal(p.sessionId, 's1');
  assert.equal(p.tool, 'AskUserQuestion');
  assert.deepEqual(p.questions, QUESTIONS);
  assert.deepEqual(p.context, []);
  assert.equal(p.holdMs, 120000);
  assert.equal(bridge.list().length, 1);
});

test('choice answer echoes questions and adds answers', async () => {
  const { bridge, created } = setup();
  const pending = bridge.handlePreToolUse(ask());
  assert.equal(bridge.answer(created()[0].id, { kind: 'choice', answers: { 'Which framework?': 'React' } }), true);
  assert.deepEqual(await pending, {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { questions: QUESTIONS, answers: { 'Which framework?': 'React' } },
    },
  });
  assert.equal(bridge.list().length, 0);
});

test('plan approve returns allow with the input echoed', async () => {
  const { bridge, created } = setup();
  const pending = bridge.handlePreToolUse(plan());
  const p = created()[0];
  assert.equal(p.plan, '# Plan\n\n- step one');
  bridge.answer(p.id, { kind: 'approve' });
  const out = await pending;
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  assert.deepEqual(out.hookSpecificOutput.updatedInput, { plan: '# Plan\n\n- step one' });
});

test('plan feedback returns deny with the reason text containing the feedback', async () => {
  const { bridge, created } = setup();
  const pending = bridge.handlePreToolUse(plan());
  bridge.answer(created()[0].id, { kind: 'feedback', text: 'Add a rollback step.' });
  const out = await pending;
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(out.hookSpecificOutput.permissionDecisionReason,
    'The user reviewed the plan on their desk panel and asked for changes: Add a rollback step.');
});

test('answer in VS Code releases with null', async () => {
  const { bridge, created, events } = setup();
  const pending = bridge.handlePreToolUse(ask());
  bridge.answer(created()[0].id, { kind: 'vscode' });
  assert.equal(await pending, null);
  assert.ok(events.some((e) => e.topic === 'claude.prompt.resolved' && e.data.resolution === 'vscode'));
});

test('hold expires at holdMs and returns null', async () => {
  const { bridge, events } = setup({ holdMs: 50 });
  const t0 = Date.now();
  // The bridge's timer is unref'd (a held prompt must not keep the service
  // alive), so the test keeps the event loop up itself.
  const keepAlive = setTimeout(() => {}, 1000);
  assert.equal(await bridge.handlePreToolUse(ask()), null);
  clearTimeout(keepAlive);
  assert.ok(Date.now() - t0 >= 45);
  assert.ok(events.some((e) => e.topic === 'claude.prompt.resolved' && e.data.resolution === 'timeout'));
});

test('panel disconnect releases held prompts with null within 1 s', async () => {
  const { bridge } = setup();
  const a = bridge.handlePreToolUse(ask());
  const b = bridge.handlePreToolUse(plan());
  assert.equal(bridge.releaseAll('panel-offline'), 2);
  const t0 = Date.now();
  assert.deepEqual(await Promise.all([a, b]), [null, null]);
  assert.ok(Date.now() - t0 < 1000);
});

test('second answer for the same id is ignored', async () => {
  const { bridge, created } = setup();
  const pending = bridge.handlePreToolUse(ask());
  const id = created()[0].id;
  assert.equal(bridge.answer(id, { kind: 'choice', answers: { 'Which framework?': 'Vue' } }), true);
  assert.equal(bridge.answer(id, { kind: 'choice', answers: { 'Which framework?': 'React' } }), false);
  assert.equal((await pending).hookSpecificOutput.updatedInput.answers['Which framework?'], 'Vue');
});

test('an aborted hook (Esc, Claude gave up) drops the prompt', async () => {
  const { bridge, events } = setup();
  const ac = new AbortController();
  const pending = bridge.handlePreToolUse(ask(), ac.signal);
  ac.abort();
  assert.equal(await pending, null);
  assert.equal(bridge.list().length, 0);
  assert.ok(events.some((e) => e.topic === 'claude.prompt.resolved' && e.data.resolution === 'abandoned'));
});

test('a choice with no answers or a bad shape is refused', () => {
  const { bridge, created } = setup();
  bridge.handlePreToolUse(ask());
  const id = created()[0].id;
  assert.throws(() => bridge.answer(id, { kind: 'choice', answers: {} }), /bad-answer/);
  assert.throws(() => bridge.answer(id, { kind: 'approve' }), /bad-answer/, 'approve is for plans only');
  assert.equal(bridge.list().length, 1, 'still held after a refused answer');
});

// ---- background sessions: no window to hand a dialog back to ----------------

function setupBackground({ online = false, isBackground = () => true, bgHoldMs, holdMs = 120000 } = {}) {
  const events = [];
  const bridge = createQuestionBridge({
    emit: (topic, data) => events.push({ topic, data }),
    panelOnline: () => online,
    holdMs,
    isBackground,
    bgHoldMs,
  });
  const created = () => events.filter((e) => e.topic === 'claude.prompt.created').map((e) => e.data);
  return { bridge, events, created };
}

test('willHold is true for a background session with no panel', () => {
  const { bridge } = setupBackground();
  assert.equal(bridge.willHold({ tool_name: 'AskUserQuestion', session_id: 's1' }), true);
  assert.equal(bridge.willHold({ tool_name: 'ExitPlanMode', session_id: 's1' }), true);
  assert.equal(bridge.willHold({ tool_name: 'Bash', session_id: 's1' }), false, 'only questions and plans');
});

test('an interactive session with no panel is still not held', async () => {
  const { bridge, created } = setupBackground({ isBackground: () => false });
  assert.equal(bridge.willHold({ tool_name: 'AskUserQuestion', session_id: 's1' }), false);
  assert.equal(await bridge.handlePreToolUse(ask()), null);
  assert.equal(created().length, 0);
});

test('background prompt survives releaseAll and is in list()', () => {
  const { bridge, created } = setupBackground({ online: true });
  bridge.handlePreToolUse(ask());
  assert.equal(created()[0].background, true);
  assert.equal(bridge.releaseAll('panel-gone'), 0, 'counts only what it released');
  assert.equal(bridge.list().length, 1, 'still held');
  assert.equal(bridge.list()[0].background, true);
});

test('a background prompt can still be answered after releaseAll', async () => {
  const { bridge, created } = setupBackground({ online: true });
  const pending = bridge.handlePreToolUse(ask());
  bridge.releaseAll('panel-gone');
  assert.equal(bridge.answer(created()[0].id, { kind: 'choice', answers: { 'Which framework?': 'Vue' } }), true);
  assert.equal((await pending).hookSpecificOutput.permissionDecision, 'allow');
});

test('releaseAll releases the interactive prompts and leaves the background ones', async () => {
  const { bridge } = setupBackground({ online: true, isBackground: (id) => id === 'bg-1' });
  const interactive = bridge.handlePreToolUse(ask());
  bridge.handlePreToolUse(ask({ session_id: 'bg-1' }));
  assert.equal(bridge.releaseAll('panel-gone'), 1);
  assert.equal(await interactive, null);
  assert.equal(bridge.list().length, 1);
  assert.equal(bridge.list()[0].sessionId, 'bg-1');
});

test('background prompt ends in deny with the reason', async () => {
  const { bridge, events, created } = setupBackground({ bgHoldMs: 30 });
  const keepAlive = setTimeout(() => {}, 1000);
  const pending = bridge.handlePreToolUse(plan());
  assert.equal(created()[0].holdMs, 30, 'the panel counts down the background hold');
  assert.deepEqual(await pending, {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: UNAVAILABLE_REASON,
    },
  });
  clearTimeout(keepAlive);
  assert.equal(bridge.list().length, 0);
  assert.ok(events.some((e) => e.topic === 'claude.prompt.resolved' && e.data.resolution === 'unavailable'));
});

test('an interactive prompt carries background:false and the interactive hold', async () => {
  const { bridge, created } = setupBackground({ online: true, isBackground: () => false, holdMs: 777, bgHoldMs: 30 });
  bridge.handlePreToolUse(ask());
  assert.equal(created()[0].background, false);
  assert.equal(created()[0].holdMs, 777);
  assert.equal(bridge.list()[0].background, false);
});

test('vscode answer is refused for a background prompt', () => {
  const { bridge, created } = setupBackground();
  bridge.handlePreToolUse(ask());
  assert.throws(() => bridge.answer(created()[0].id, { kind: 'vscode' }), /bad-answer/);
  assert.equal(bridge.list().length, 1, 'still held');
});

test('an aborted background hook (Claude gave up) still finishes with null', async () => {
  const { bridge, events } = setupBackground();
  const ac = new AbortController();
  const pending = bridge.handlePreToolUse(ask(), ac.signal);
  ac.abort();
  assert.equal(await pending, null);
  assert.equal(bridge.list().length, 0);
  assert.ok(events.some((e) => e.topic === 'claude.prompt.resolved' && e.data.resolution === 'abandoned'));
});
