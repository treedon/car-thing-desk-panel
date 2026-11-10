// The daemon shells out to `claude` to poll the registry, and those short-lived
// processes fire SessionEnd hooks carrying the daemon's own cwd. Nothing here is
// about display logic — it is about never inventing a session from that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/sessions/store.js';
import { startHooksSource, promptLine } from '../src/sessions/source-hooks.js';
import { markOwnSession } from '../src/own-sessions.js';
import { excerptOf } from '../src/turn-tag.js';

const DAEMON_CWD = '/Users/dev/claude-thing/daemon';

test('a SessionEnd for a session we never saw creates nothing', () => {
  const store = createStore();
  const { onHookEvent } = startHooksSource({ store });
  onHookEvent('SessionEnd', { session_id: 'ghost-1', cwd: DAEMON_CWD });
  assert.equal(store.count(), 0, 'no phantom named after the daemon directory');
  assert.equal(store.snapshot().sessions.length, 0);
});

test('a SessionEnd for a live session still retires it', () => {
  const store = createStore();
  const { onHookEvent } = startHooksSource({ store });
  onHookEvent('SessionStart', { session_id: 'real-1', cwd: '/Users/dev/proj' });
  assert.equal(store.count(), 1);
  onHookEvent('SessionEnd', { session_id: 'real-1', cwd: '/Users/dev/proj' });
  assert.equal(store.count(), 0, 'gone the moment it ends');
});

test('a finished turn celebrates instead of asking for attention', () => {
  const store = createStore();
  const { onHookEvent } = startHooksSource({ store });
  onHookEvent('SessionStart', { session_id: 'turn-1', cwd: '/Users/dev/proj' });
  onHookEvent('UserPromptSubmit', { session_id: 'turn-1', cwd: '/Users/dev/proj', prompt: 'go' });
  onHookEvent('Stop', { session_id: 'turn-1', cwd: '/Users/dev/proj' });
  assert.equal(store.get('turn-1').state, 'celebrate');
});

test('a permission notification asks for attention, and the next Stop clears it', () => {
  const store = createStore();
  const { onHookEvent } = startHooksSource({ store });
  onHookEvent('SessionStart', { session_id: 'block-1', cwd: '/Users/dev/proj' });
  onHookEvent('Notification', {
    session_id: 'block-1', cwd: '/Users/dev/proj',
    message: 'Claude needs your permission to use Bash',
  });
  assert.equal(store.get('block-1').state, 'attention');
  onHookEvent('Stop', { session_id: 'block-1', cwd: '/Users/dev/proj' });
  assert.equal(store.get('block-1').state, 'celebrate', 'a stale block does not outlive the turn');
});

test('the idle nudge after a finished turn is not a block', () => {
  const store = createStore();
  const { onHookEvent } = startHooksSource({ store });
  onHookEvent('SessionStart', { session_id: 'nudge-1', cwd: '/Users/dev/proj' });
  onHookEvent('Stop', { session_id: 'nudge-1', cwd: '/Users/dev/proj' });
  onHookEvent('Notification', {
    session_id: 'nudge-1', cwd: '/Users/dev/proj',
    message: 'Claude is waiting for your input',
  });
  assert.notEqual(store.get('nudge-1').state, 'attention');
});

test("the daemon's own usage runs are ignored whatever hook they fire", () => {
  const store = createStore();
  const { onHookEvent } = startHooksSource({ store });
  markOwnSession('ours-1');
  onHookEvent('SessionStart', { session_id: 'ours-1', cwd: '/tmp' });
  onHookEvent('UserPromptSubmit', { session_id: 'ours-1', cwd: '/tmp', prompt: '/usage' });
  assert.equal(store.count(), 0);
});

test('a prompt is kept as lastPrompt, collapsed and capped, for ask intent lines', () => {
  const store = createStore();
  const { onHookEvent } = startHooksSource({ store });
  onHookEvent('SessionStart', { session_id: 'p-1', cwd: '/Users/dev/proj' });
  onHookEvent('UserPromptSubmit', {
    session_id: 'p-1', cwd: '/Users/dev/proj',
    prompt: '  reinstall\n   the deps  ' + 'x'.repeat(300),
  });
  const kept = store.raw('p-1').lastPrompt;
  assert.ok(kept.startsWith('reinstall the deps'), 'whitespace collapsed');
  assert.equal(kept.length, 120, 'capped for a single 800px line');
});

test('a question the panel bridge is holding is not queued a second time', () => {
  const store = createStore();
  const queued = [];
  const queue = { onQuestion: (p) => queued.push(p), onQuestionAnswered() {} };
  const { onHookEvent } = startHooksSource({ store, queue });
  const q = { session_id: 'q-1', cwd: '/Users/dev/proj', tool_name: 'AskUserQuestion', tool_input: { questions: [] } };
  onHookEvent('PreToolUse', { ...q, heldByPanel: true });
  assert.equal(queued.length, 0);
  assert.equal(store.get('q-1').state, 'attention', 'still waiting on the owner');
  onHookEvent('PreToolUse', q);
  assert.equal(queued.length, 1, 'without the bridge, the upstream card still appears');
});

test('a turn ending with background work reads busy, not celebrate, until the next prompt', () => {
  const store = createStore();
  const { onHookEvent } = startHooksSource({ store });
  onHookEvent('SessionStart', { session_id: 'w-1', cwd: '/p' });
  onHookEvent('Stop', { session_id: 'w-1', cwd: '/p', background_tasks: [{ id: '1', type: 'shell', command: 'npm test' }] });
  assert.equal(store.get('w-1').state, 'busy');
  assert.equal(store.get('w-1').waitingOn[0].label, 'npm test');
  onHookEvent('UserPromptSubmit', { session_id: 'w-1', cwd: '/p', prompt: 'next' });
  assert.deepEqual(store.get('w-1').waitingOn, []);
});

test('a later Stop with nothing in flight celebrates', () => {
  const store = createStore();
  const { onHookEvent } = startHooksSource({ store });
  onHookEvent('SessionStart', { session_id: 'w-2', cwd: '/p' });
  onHookEvent('Stop', { session_id: 'w-2', cwd: '/p', background_tasks: [{ id: '1', type: 'shell', command: 'npm test' }] });
  assert.equal(store.get('w-2').state, 'busy');
  onHookEvent('Stop', { session_id: 'w-2', cwd: '/p', background_tasks: [] });
  assert.equal(store.get('w-2').state, 'celebrate');
  assert.deepEqual(store.get('w-2').waitingOn, []);
});

test('a one-shot wakeup keeps a stopped session busy; a recurring cron does not', () => {
  const store = createStore();
  const { onHookEvent } = startHooksSource({ store });
  onHookEvent('Stop', { session_id: 'w-3', cwd: '/p', session_crons: [{ id: 'c', schedule: '40 15 6 11 *', recurring: false, prompt: 'p' }] });
  assert.equal(store.get('w-3').state, 'busy');
  assert.equal(store.get('w-3').waitingOn[0].label, 'wakes at 15:40');
  onHookEvent('Stop', { session_id: 'w-4', cwd: '/p', session_crons: [{ id: 'c', schedule: '*/20 * * * *', recurring: true, prompt: 'p' }] });
  assert.equal(store.get('w-4').state, 'celebrate');
});

test('a tool call clears what a stopped session was waiting on', () => {
  const store = createStore();
  const { onHookEvent } = startHooksSource({ store });
  onHookEvent('Stop', { session_id: 'w-5', cwd: '/p', background_tasks: [{ id: '1', type: 'shell', command: 'make' }] });
  assert.equal(store.get('w-5').waitingOn.length, 1);
  onHookEvent('PreToolUse', { session_id: 'w-5', cwd: '/p', tool_name: 'Bash' });
  assert.deepEqual(store.get('w-5').waitingOn, []);
});

test('a permission ask outranks waiting on background work', () => {
  const store = createStore();
  const { onHookEvent } = startHooksSource({ store });
  onHookEvent('Stop', { session_id: 'w-6', cwd: '/p', background_tasks: [{ id: '1', type: 'shell', command: 'make' }] });
  onHookEvent('Notification', { session_id: 'w-6', cwd: '/p', message: 'Claude needs your permission to use Bash' });
  assert.equal(store.get('w-6').state, 'attention');
});

test('an ended session stops waiting: its last detail event is idle with nothing in flight', () => {
  const store = createStore();
  const seen = [];
  store.onDetail = (d) => seen.push(d);
  const { onHookEvent } = startHooksSource({ store });
  onHookEvent('SessionStart', { session_id: 'w-7', cwd: '/p' });
  onHookEvent('Stop', { session_id: 'w-7', cwd: '/p', background_tasks: [{ id: '1', type: 'shell', command: 'npm test' }] });
  onHookEvent('SessionEnd', { session_id: 'w-7', cwd: '/p' });
  const last = seen[seen.length - 1];
  assert.equal(last.ended, true);
  assert.equal(last.state, 'idle', 'a dead session is not busy because it was waiting when it died');
  assert.deepEqual(last.waitingOn, []);
});

test("a subagent's own tool calls do not clear what the session is waiting on", () => {
  const store = createStore();
  const { onHookEvent } = startHooksSource({ store });
  onHookEvent('Stop', { session_id: 'w-8', cwd: '/p', background_tasks: [{ id: '1', type: 'subagent', description: 'Review diff' }] });
  // Hooks fired from inside a subagent carry the parent's session_id plus an
  // agent_id; the subagent working is exactly what the parent is waiting on.
  onHookEvent('PreToolUse', { session_id: 'w-8', cwd: '/p', tool_name: 'Read', agent_id: 'x' });
  assert.equal(store.get('w-8').waitingOn[0].label, 'Review diff');
  assert.equal(store.get('w-8').state, 'busy');
  onHookEvent('PreToolUse', { session_id: 'w-8', cwd: '/p', tool_name: 'Bash' });
  assert.deepEqual(store.get('w-8').waitingOn, []);
});

// --- the inbox: every finished turn posts a card ---------------------------

function stubInbox() {
  const calls = { post: [], clear: [], end: [], stop: [], order: [] };
  return {
    calls,
    noteStop: (id, ts) => { calls.stop.push([id, ts]); calls.order.push('noteStop'); },
    post: (card) => { calls.post.push(card); calls.order.push('post'); },
    clear: (id, reason) => calls.clear.push([id, reason]),
    onSessionEnd: (id) => calls.end.push(id),
  };
}

test('Stop posts the turn with its tag, name and intent', () => {
  const store = createStore();
  const inbox = stubInbox();
  const { onHookEvent } = startHooksSource({ store, inbox });
  onHookEvent('SessionStart', { session_id: 'ib-1', cwd: '/Users/dev/proj' });
  onHookEvent('UserPromptSubmit', { session_id: 'ib-1', cwd: '/Users/dev/proj', prompt: 'fix it' });
  onHookEvent('Stop', { session_id: 'ib-1', cwd: '/Users/dev/proj', last_assistant_message: 'Done. Push it?' });
  assert.equal(inbox.calls.post.length, 1);
  const card = inbox.calls.post[0];
  assert.equal(card.sessionId, 'ib-1');
  assert.equal(card.sessionName, 'proj');
  assert.equal(card.tag, 'asking');
  assert.equal(card.text, 'Done. Push it?');
  assert.equal(card.intent, 'you asked: fix it');
  assert.equal(card.stoppedTs, store.raw('ib-1').stoppedTs, 'the card is stamped with the same stop the tile shows');
});

test('a Stop with an update message posts an update; with no prompt the intent is empty', () => {
  const store = createStore();
  const inbox = stubInbox();
  const { onHookEvent } = startHooksSource({ store, inbox });
  onHookEvent('Stop', { session_id: 'ib-2', cwd: '/p', last_assistant_message: 'All 208 tests pass.' });
  assert.equal(inbox.calls.post[0].tag, 'update');
  assert.equal(inbox.calls.post[0].intent, '');
});

test('the card carries the session host', () => {
  const store = createStore();
  const inbox = stubInbox();
  const { onHookEvent } = startHooksSource({ store, inbox });
  store.upsert('ib-3', { host: 'vscode', cwd: '/p' });
  onHookEvent('Stop', { session_id: 'ib-3', cwd: '/p', last_assistant_message: 'ok' });
  assert.equal(inbox.calls.post[0].host, 'vscode');
});

test('a Stop continued by a hook (panel reply) still posts', () => {
  const store = createStore();
  const inbox = stubInbox();
  const { onHookEvent } = startHooksSource({ store, inbox });
  onHookEvent('Stop', { session_id: 'ib-4', cwd: '/p', stop_hook_active: true, last_assistant_message: 'Replied.' });
  assert.equal(inbox.calls.post.length, 1);
});

test('an UPDATE turn with background work posts nothing; an ASKING one still posts', () => {
  const store = createStore();
  const inbox = stubInbox();
  const { onHookEvent } = startHooksSource({ store, inbox });
  const running = [{ id: '1', type: 'shell', command: 'npm test' }];
  onHookEvent('Stop', { session_id: 'ib-5', cwd: '/p', background_tasks: running, last_assistant_message: 'Started the build.' });
  assert.equal(inbox.calls.post.length, 0, 'the session will resume on its own; nothing to read yet');
  assert.equal(store.get('ib-5').state, 'busy');
  onHookEvent('Stop', { session_id: 'ib-5', cwd: '/p', background_tasks: running, last_assistant_message: 'Should I let it run?' });
  assert.equal(inbox.calls.post.length, 1);
  assert.equal(inbox.calls.post[0].tag, 'asking');
});

test('a Stop without last_assistant_message reads the transcript after the response', () => {
  const store = createStore();
  const inbox = stubInbox();
  const deferred = [];
  const read = [];
  const { onHookEvent } = startHooksSource({
    store, inbox,
    defer: (fn) => deferred.push(fn),
    readLastText: (file) => { read.push(file); return 'From the transcript. Ship it?'; },
  });
  onHookEvent('Stop', { session_id: 'ib-6', cwd: '/p', transcript_path: '/t/ib-6.jsonl' });
  assert.equal(inbox.calls.post.length, 0, 'no file read before the hook has answered');
  assert.deepEqual(read, []);
  assert.equal(deferred.length, 1);
  deferred[0]();
  assert.deepEqual(read, ['/t/ib-6.jsonl']);
  assert.equal(inbox.calls.post.length, 1);
  assert.equal(inbox.calls.post[0].text, 'From the transcript. Ship it?');
  assert.equal(inbox.calls.post[0].tag, 'asking', 'tagged from the text that was read');
});

test('a deferred transcript read does not post once the session has moved on', () => {
  const store = createStore();
  const inbox = stubInbox();
  const deferred = [];
  const { onHookEvent } = startHooksSource({ store, inbox, defer: (fn) => deferred.push(fn), readLastText: () => 'late' });
  onHookEvent('Stop', { session_id: 'ib-7', cwd: '/p' });
  onHookEvent('UserPromptSubmit', { session_id: 'ib-7', cwd: '/p', prompt: 'next' });
  deferred[0]();
  assert.equal(inbox.calls.post.length, 0, 'a new prompt already cleared the old turn');
});

test('a throwing transcript read never escapes the deferred callback', () => {
  const store = createStore();
  const inbox = stubInbox();
  const deferred = [];
  const { onHookEvent } = startHooksSource({
    store, inbox, defer: (fn) => deferred.push(fn), readLastText: () => { throw new Error('disk gone'); },
  });
  onHookEvent('Stop', { session_id: 'ib-8', cwd: '/p' });
  assert.doesNotThrow(() => deferred[0]());
  assert.equal(inbox.calls.post.length, 0);
});

test('an inbox that throws does not break the hook', () => {
  const store = createStore();
  const inbox = { ...stubInbox(), post() { throw new Error('write failed'); } };
  const { onHookEvent } = startHooksSource({ store, inbox });
  assert.doesNotThrow(() => onHookEvent('Stop', { session_id: 'ib-9', cwd: '/p', last_assistant_message: 'x' }));
  assert.equal(store.get('ib-9').state, 'celebrate');
});

test('every Stop and StopFailure notes the stop before it posts, even when no card is posted', () => {
  const store = createStore();
  const inbox = stubInbox();
  const deferred = [];
  const { onHookEvent } = startHooksSource({ store, inbox, defer: (fn) => deferred.push(fn), readLastText: () => 'Done.' });
  onHookEvent('UserPromptSubmit', { session_id: 'ns-1', cwd: '/p', prompt: 'go' });
  // posts a card
  onHookEvent('Stop', { session_id: 'ns-1', cwd: '/p', last_assistant_message: 'Push it?' });
  assert.deepEqual(inbox.calls.order, ['noteStop', 'post']);
  assert.deepEqual(inbox.calls.stop, [['ns-1', store.raw('ns-1').stoppedTs]]);
  // an UPDATE turn held back by background work posts nothing, but is still noted
  inbox.calls.order.length = 0;
  onHookEvent('Stop', {
    session_id: 'ns-1', cwd: '/p', last_assistant_message: 'Working on it.',
    background_tasks: [{ id: 'b', type: 'shell', status: 'running', description: 'npm test', command: 'npm test' }],
  });
  assert.deepEqual(inbox.calls.order, ['noteStop'], 'noted, not posted');
  assert.equal(inbox.calls.stop.length, 2);
  assert.equal(inbox.calls.stop[1][1], store.raw('ns-1').stoppedTs);
  // a Stop whose message is read later still notes the stop at once
  inbox.calls.order.length = 0;
  onHookEvent('Stop', { session_id: 'ns-1', cwd: '/p' });
  assert.deepEqual(inbox.calls.order, ['noteStop']);
  deferred[0]();
  assert.deepEqual(inbox.calls.order, ['noteStop', 'post']);
  // StopFailure
  inbox.calls.order.length = 0;
  onHookEvent('StopFailure', { session_id: 'ns-1', cwd: '/p', error: 'rate_limit' });
  assert.deepEqual(inbox.calls.order, ['noteStop', 'post']);
  assert.equal(inbox.calls.stop.length, 4);
});

test('an inbox that cannot note a stop does not break the hook', () => {
  const store = createStore();
  const inbox = { ...stubInbox(), noteStop() { throw new Error('boom'); } };
  const { onHookEvent } = startHooksSource({ store, inbox });
  assert.doesNotThrow(() => onHookEvent('Stop', { session_id: 'ns-2', cwd: '/p', last_assistant_message: 'x?' }));
  assert.doesNotThrow(() => onHookEvent('StopFailure', { session_id: 'ns-2', cwd: '/p', error: 'x' }));
  assert.equal(store.get('ns-2').state, 'celebrate');
});

test('StopFailure posts an error card', () => {
  const store = createStore();
  const inbox = stubInbox();
  const { onHookEvent } = startHooksSource({ store, inbox });
  onHookEvent('UserPromptSubmit', { session_id: 'ib-10', cwd: '/Users/dev/proj', prompt: 'go' });
  onHookEvent('StopFailure', {
    session_id: 'ib-10', cwd: '/Users/dev/proj',
    error: 'rate_limit', error_details: '429 Too Many Requests', last_assistant_message: 'partial',
  });
  assert.equal(inbox.calls.post.length, 1);
  const card = inbox.calls.post[0];
  assert.equal(card.tag, 'error');
  assert.equal(card.sessionName, 'proj');
  assert.equal(card.intent, 'you asked: go');
  // The card's excerpt is the closing paragraph, and the owner needs to read
  // the error, not Claude's partial message: the error closes the text.
  assert.equal(card.text, 'partial\n\nrate_limit\n429 Too Many Requests');
  assert.equal(excerptOf(card.text), 'rate_limit\n429 Too Many Requests');
  assert.equal(store.get('ib-10').state, 'celebrate', 'the failed turn is over for the tile too');
});

test('an error card\'s excerpt is the error even when Claude\'s partial message is long', () => {
  const store = createStore();
  const inbox = stubInbox();
  const { onHookEvent } = startHooksSource({ store, inbox });
  onHookEvent('StopFailure', {
    session_id: 'ib-10b', cwd: '/p', error: 'overloaded', last_assistant_message: 'Step one done.\n\nNow wiring the second part',
  });
  assert.equal(excerptOf(inbox.calls.post[0].text), 'overloaded');
  // without a partial message or details there is just the error
  onHookEvent('StopFailure', { session_id: 'ib-10c', cwd: '/p', error: 'rate_limit', error_details: '429' });
  assert.equal(inbox.calls.post[1].text, 'rate_limit\n429');
  // blank lines inside the error must not split it off from its first line
  onHookEvent('StopFailure', { session_id: 'ib-10e', cwd: '/p', error: 'bad', error_details: 'line one\n\nline two', last_assistant_message: 'partial' });
  assert.equal(excerptOf(inbox.calls.post[2].text), 'bad\nline one\nline two');
  onHookEvent('StopFailure', { session_id: 'ib-10d', cwd: '/p' });
  assert.equal(inbox.calls.post[3].text, 'The turn failed.');
});

test('StopFailure reads an error given as an object, and survives a missing one', () => {
  const store = createStore();
  const inbox = stubInbox();
  const { onHookEvent } = startHooksSource({ store, inbox });
  onHookEvent('StopFailure', { session_id: 'ib-11', cwd: '/p', error: { message: 'Overloaded', type: 'overloaded_error' } });
  onHookEvent('StopFailure', { session_id: 'ib-11', cwd: '/p', error: { type: 'overloaded_error' } });
  assert.doesNotThrow(() => onHookEvent('StopFailure', { session_id: 'ib-11', cwd: '/p' }));
  assert.doesNotThrow(() => onHookEvent('StopFailure', { session_id: 'ib-11', cwd: '/p', error: 42, error_details: null }));
  assert.deepEqual(inbox.calls.post.map((c) => c.text.split('\n')[0]).slice(0, 2), ['Overloaded', 'overloaded_error']);
  assert.ok(inbox.calls.post.every((c) => c.tag === 'error' && c.text.length > 0), 'an error card is never blank');
});

test('typing in the session clears its card; ending it calls onSessionEnd', () => {
  const store = createStore();
  const inbox = stubInbox();
  const { onHookEvent } = startHooksSource({ store, inbox });
  onHookEvent('SessionStart', { session_id: 'ib-12', cwd: '/p' });
  onHookEvent('UserPromptSubmit', { session_id: 'ib-12', cwd: '/p', prompt: 'again' });
  assert.deepEqual(inbox.calls.clear, [['ib-12', 'typed']]);
  onHookEvent('SessionEnd', { session_id: 'ib-12', cwd: '/p' });
  assert.deepEqual(inbox.calls.end, ['ib-12']);
});

test("the daemon's own sessions never post", () => {
  const store = createStore();
  const inbox = stubInbox();
  const { onHookEvent } = startHooksSource({ store, inbox });
  markOwnSession('ib-own');
  onHookEvent('Stop', { session_id: 'ib-own', cwd: '/tmp', last_assistant_message: 'Done?' });
  onHookEvent('StopFailure', { session_id: 'ib-own', cwd: '/tmp', error: 'x' });
  onHookEvent('UserPromptSubmit', { session_id: 'ib-own', cwd: '/tmp', prompt: 'p' });
  onHookEvent('SessionEnd', { session_id: 'ib-own', cwd: '/tmp' });
  assert.deepEqual(inbox.calls, { post: [], clear: [], end: [], stop: [], order: [] }, 'not even a stop is noted');
});

test('without an inbox every hook still works', () => {
  const store = createStore();
  const { onHookEvent } = startHooksSource({ store });
  onHookEvent('UserPromptSubmit', { session_id: 'ib-13', cwd: '/p', prompt: 'go' });
  onHookEvent('Stop', { session_id: 'ib-13', cwd: '/p', last_assistant_message: 'Done?' });
  onHookEvent('StopFailure', { session_id: 'ib-13', cwd: '/p', error: 'rate_limit' });
  onHookEvent('SessionEnd', { session_id: 'ib-13', cwd: '/p' });
  assert.equal(store.count(), 0);
});

test('promptLine collapses whitespace, trims and caps at 120', () => {
  assert.equal(promptLine('  reinstall\n   the deps  '), 'reinstall the deps');
  assert.equal(promptLine('x'.repeat(300)).length, 120);
  assert.equal(promptLine(undefined), '');
});

test('a failed turn stops waiting: StopFailure after a background-work Stop does not leave the tile busy', () => {
  const store = createStore();
  const { onHookEvent } = startHooksSource({ store });
  onHookEvent('Stop', { session_id: 'sf-1', cwd: '/p', background_tasks: [{ id: '1', type: 'shell', command: 'npm test' }] });
  assert.equal(store.get('sf-1').state, 'busy');
  // The job finishes, the session wakes on its own and the turn dies: no
  // UserPromptSubmit and no tool call came in between to clear the list.
  onHookEvent('StopFailure', { session_id: 'sf-1', cwd: '/p', error: 'rate_limit' });
  assert.deepEqual(store.get('sf-1').waitingOn, []);
  assert.notEqual(store.get('sf-1').state, 'busy');
});
