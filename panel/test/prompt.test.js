import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startPrompt, promptRows, pressRow, confirmPicks, answerWithText } from '../src/prompt-answer.js';
import { renderPrompt } from '../src/screens/prompt.js';

const Q1 = { question: 'Which framework?', header: 'Framework', multiSelect: false,
  options: [{ label: 'React', description: 'r' }, { label: 'Vue', description: 'v' }] };
const Q2 = { question: 'Which envs?', header: 'Envs', multiSelect: true,
  options: [{ label: 'Dev' }, { label: 'Staging' }, { label: 'Prod' }] };
const question = (qs) => ({ kind: 'prompt', id: 'p1', sessionId: 's1', sessionName: 'proj', tool: 'AskUserQuestion',
  questions: qs || [Q1], context: [{ role: 'user', text: 'set up the app', ts: 1 }], holdMs: 120000, createdTs: Date.now() });
const plan = () => ({ kind: 'prompt', id: 'p2', sessionId: 's1', sessionName: 'proj', tool: 'ExitPlanMode',
  plan: '# Plan\n\n- add the route\n- test it', context: [], holdMs: 120000, createdTs: Date.now() });

test('question rows: every option, then Say an answer and Answer in VS Code', () => {
  const rows = promptRows(question(), startPrompt());
  assert.deepEqual(rows.map((r) => r.kind), ['option', 'option', 'say', 'vscode']);
  assert.equal(rows[1].label, 'Vue');
});

test('plan rows: Approve, Say what to change, Answer in VS Code', () => {
  assert.deepEqual(promptRows(plan(), startPrompt()).map((r) => r.kind), ['approve', 'say', 'vscode']);
});

test('a background session\'s question has no Answer in VS Code row: nothing there could take it', () => {
  const rows = promptRows({ ...question(), background: true }, startPrompt());
  assert.deepEqual(rows.map((r) => r.kind), ['option', 'option', 'say']);
  assert.equal(rows[1].label, 'Vue');
});

test('a background session\'s plan has Approve and Say what to change, and no VS Code row', () => {
  assert.deepEqual(promptRows({ ...plan(), background: true }, startPrompt()), [{ kind: 'approve' }, { kind: 'say' }]);
});

test('a row past the end of a background prompt does nothing', () => {
  const p = { ...plan(), background: true };
  assert.deepEqual(pressRow(p, startPrompt(), 2), { ui: startPrompt(), send: null });
});

test('a prompt with background false keeps its VS Code row', () => {
  assert.deepEqual(promptRows({ ...plan(), background: false }, startPrompt()).map((r) => r.kind), ['approve', 'say', 'vscode']);
});

test('one single-select question: a press sends the choice', () => {
  const r = pressRow(question(), startPrompt(), 1);
  assert.deepEqual(r.send, { kind: 'choice', answers: { 'Which framework?': 'Vue' } });
});

test('several questions are answered one at a time and sent together', () => {
  const p = question([Q1, Q2]);
  let r = pressRow(p, startPrompt(), 0);
  assert.equal(r.send, null);
  assert.equal(r.ui.q, 1);
  r = pressRow(p, r.ui, 0);          // toggle Dev
  r = pressRow(p, r.ui, 2);          // toggle Prod
  r = pressRow(p, r.ui, 0);          // untoggle Dev
  r = pressRow(p, r.ui, 0);          // toggle Dev again
  assert.equal(r.send, null, 'toggling never sends');
  r = confirmPicks(p, r.ui);
  assert.deepEqual(r.send, { kind: 'choice', answers: { 'Which framework?': 'React', 'Which envs?': 'Prod, Dev' } });
});

test('confirming a multi-select with nothing picked does nothing', () => {
  const p = question([Q2]);
  const r = confirmPicks(p, startPrompt());
  assert.equal(r.send, null);
  assert.equal(r.error, 'Pick at least one');
});

test('Say rows ask for dictation; the text becomes the answer or the plan feedback', () => {
  assert.equal(pressRow(question(), startPrompt(), 2).dictate, true);
  assert.deepEqual(answerWithText(question(), startPrompt(), 'Svelte, actually').send,
    { kind: 'choice', answers: { 'Which framework?': 'Svelte, actually' } });
  assert.equal(pressRow(plan(), startPrompt(), 1).dictate, true);
  assert.deepEqual(answerWithText(plan(), startPrompt(), 'Add a rollback step').send,
    { kind: 'feedback', text: 'Add a rollback step' });
});

test('Approve and Answer in VS Code send their kinds', () => {
  assert.deepEqual(pressRow(plan(), startPrompt(), 0).send, { kind: 'approve' });
  assert.deepEqual(pressRow(plan(), startPrompt(), 2).send, { kind: 'vscode' });
  assert.deepEqual(pressRow(question(), startPrompt(), 3).send, { kind: 'vscode' });
});

test('the prompt screen leads with context, then the question, then the rows', () => {
  const html = renderPrompt({ daemonConnected: true }, question(), startPrompt(), 1);
  const c = html.indexOf('set up the app'), q = html.indexOf('Which framework?'), o = html.indexOf('React');
  assert.ok(c >= 0 && c < q && q < o);
  assert.match(html, /Say an answer/);
  assert.match(html, /Answer in VS Code/);
  assert.equal((html.match(/prow[^"]*selected/g) || []).length, 1);
  assert.match(html, /pcount/, 'a countdown bar');
  assert.match(html, /<div class="pkicker" id="panchor">/, 'the view opens anchored on the question, context above it');
});

test('a plan shows its text and the plan rows', () => {
  const html = renderPrompt({ daemonConnected: true }, plan(), startPrompt(), 0);
  assert.match(html, /add the route/);
  assert.match(html, /Approve/);
  assert.match(html, /Say what to change/);
});

test('an expired prompt reads Moved to VS Code and offers nothing to press', () => {
  const html = renderPrompt({ daemonConnected: true }, { ...question(), expired: true }, startPrompt(), 0);
  assert.match(html, /Moved to VS Code/);
  assert.doesNotMatch(html, /class="prow/);
});

test('multi-question prompts say where you are', () => {
  const html = renderPrompt({ daemonConnected: true }, question([Q1, Q2]), { q: 1, answers: { 'Which framework?': 'React' }, picks: ['Dev'] }, 0);
  assert.match(html, /2 of 2/);
  assert.match(html, /Which envs\?/);
  assert.match(html, /prow option picked/);
});

test('the queue shows a held question or plan with one Answer chip', async () => {
  const { renderQueue } = await import('../src/screens/queue.js');
  const base = { sessions: [], details: {}, asks: [], daemonConnected: true, queueIndex: 0, queueAnswering: false,
    queueChoice: 0, queueQIndex: 0, queueAnswers: [], queueReview: false, usage: null, stats: { active: 0, attention: 0 } };
  const html = renderQueue({ ...base, asks: [question(), plan()] });
  assert.match(html, /Which framework\?/);
  assert.match(html, /data-action="queue-answer"/);
  assert.match(html, /QUESTION/);
  assert.match(html, /PLAN/, 'the plan in the stack names itself');
  assert.match(html, /qrow[^"]*question/);
});

test('a new question or plan takes over the screen unless the owner is mid-answer', async () => {
  const { opensOnArrival } = await import('../src/prompt-answer.js');
  for (const r of ['list', 'session', 'agent', 'queue', 'usage', 'ambient', 'ask']) {
    assert.equal(opensOnArrival(r), true, r);
  }
  assert.equal(opensOnArrival('prompt', { expired: false }), false, 'already answering one');
  assert.equal(opensOnArrival('dictate'), false, 'mid-dictation');
});

test('an expired or answered question on screen does not block a new one', async () => {
  const { opensOnArrival } = await import('../src/prompt-answer.js');
  assert.equal(opensOnArrival('prompt', { expired: true }), true, 'Moved to VS Code card');
  assert.equal(opensOnArrival('prompt', null), true, 'already answered and gone');
  assert.equal(opensOnArrival('prompt', { expired: false }), false, 'a live one being answered');
});

test('a question prompt with no questions ignores dictated text instead of throwing', () => {
  const empty = { ...question([]), questions: [] };
  assert.deepEqual(answerWithText(empty, startPrompt(), 'hello').send, null);
});
