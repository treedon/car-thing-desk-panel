import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRecentMessages, lastAssistantText } from '../src/sessions/recent-messages.js';
import { MESSAGE_PREFIX } from '../src/message-bridge.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (name) => path.join(here, 'fixtures', name);

function tmpTranscript(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recent-'));
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}
const said = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const asked = (text) => ({ type: 'user', message: { role: 'user', content: text } });

test('returns prompt, assistant text and tool lines, oldest first', () => {
  const m = readRecentMessages(fx('convo.jsonl'), { limit: 12 });
  assert.deepEqual(m.map((x) => x.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(m[0].text, 'Run the tests please');
  assert.equal(m[2].text, 'Bash: npm test');
  assert.equal(m[3].text, 'All 208 tests pass.');
  assert.equal(m[0].ts, Date.parse('2026-11-02T10:00:00.000Z'));
});

test('skips thinking, tool results and meta lines', () => {
  const text = readRecentMessages(fx('convo.jsonl'), {}).map((x) => x.text).join('\n');
  assert.doesNotMatch(text, /THINKING-SENTINEL|TOOL-RESULT-SENTINEL|META-SENTINEL/);
});

test('clips older text to 2000 chars with ellipsis', () => {
  const m = readRecentMessages(tmpTranscript([said('a'.repeat(5000)), asked('next'), said('short')]), {});
  assert.equal(m[0].text.length, 2001);
  assert.ok(m[0].text.endsWith('…'));
});

test('newest assistant reply keeps up to 8000 chars', () => {
  const m = readRecentMessages(tmpTranscript([asked('go'), said('b'.repeat(5000))]), {});
  assert.equal(m[1].text.length, 5000);
  const big = readRecentMessages(tmpTranscript([asked('go'), said('c'.repeat(9000))]), {});
  assert.equal(big[1].text.length, 8001);
});

test('limit keeps the newest N', () => {
  const m = readRecentMessages(fx('convo.jsonl'), { limit: 2 });
  assert.deepEqual(m.map((x) => x.role), ['tool', 'assistant']);
});

test('only the last maxBytes are read, and the cut first line is dropped', () => {
  const file = tmpTranscript([asked('x'.repeat(3000)), said('kept')]);
  const m = readRecentMessages(file, { maxBytes: 200 });
  assert.deepEqual(m.map((x) => x.text), ['kept']);
});

test('torn last line and missing file do not throw', () => {
  assert.doesNotThrow(() => readRecentMessages(fx('convo.jsonl'), {}));
  assert.deepEqual(readRecentMessages('/nonexistent.jsonl', {}), []);
});

test('typed prompts given as text blocks are kept', () => {
  const m = readRecentMessages(tmpTranscript([
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'block prompt' }] } },
  ]), {});
  assert.deepEqual(m.map((x) => [x.role, x.text]), [['user', 'block prompt']]);
});

test('lastAssistantText returns the newest assistant text', () => {
  const file = tmpTranscript([asked('go'), said('first reply'), asked('more'), said('second reply')]);
  assert.equal(lastAssistantText(file), 'second reply');
});

test('lastAssistantText skips newer assistant records that carry no text', () => {
  const toolOnly = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } };
  const file = tmpTranscript([said('the closing words'), toolOnly]);
  assert.equal(lastAssistantText(file), 'the closing words');
});

test('lastAssistantText is unclipped and empty when there is nothing to read', () => {
  assert.equal(lastAssistantText(tmpTranscript([asked('go'), said('d'.repeat(9000))])).length, 9000);
  assert.equal(lastAssistantText(tmpTranscript([asked('go')])), '');
  assert.equal(lastAssistantText('/nonexistent.jsonl'), '');
  assert.equal(lastAssistantText(undefined), '');
});

// ---- conversationOnly: the session view (what was said), not the subagent feed

const noticed = (text) => ({ type: 'user', origin: { kind: 'task-notification' }, message: { role: 'user', content: text } });
const usedTool = (text) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] },
});
const toolOnly = () => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } });
const sessionFixture = () => tmpTranscript([
  asked('Run the tests'),
  usedTool('Running them.'),
  noticed('Background command done'),
  noticed(MESSAGE_PREFIX + 'ship it'),
]);

test('conversation only: no tool lines, no task notices, panel replies kept', () => {
  const m = readRecentMessages(sessionFixture(), { conversationOnly: true });
  assert.deepEqual(m.map((x) => x.role), ['user', 'assistant', 'user']);
  assert.equal(m[1].text, 'Running them.');
  assert.equal(m[2].text, 'ship it');
  assert.equal(m[2].fromPanel, true);
  assert.equal(m[0].fromPanel, undefined);
});

// Exactly as Claude Code 2.1.220 saved a woken reply on 2026-11-06: the
// rewake hook's stderr becomes "Stop hook feedback", inside a system-reminder.
test('conversation only: a woken reply loses the system-reminder that closes it', () => {
  const woken = noticed('<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>\n' +
    '<system-reminder>\nStop hook blocking error from command "Stop": ' + MESSAGE_PREFIX +
    "I'm testing it for you.\n\n</system-reminder>");
  const m = readRecentMessages(tmpTranscript([woken]), { conversationOnly: true });
  assert.deepEqual(m.map((x) => [x.text, x.fromPanel]), [["I'm testing it for you.", true]]);
});

test('conversation only: the panel reply is found inside a wrapper and trimmed', () => {
  const wrapped = noticed('<task-notification>\n' + MESSAGE_PREFIX + '  ship it  \n');
  const m = readRecentMessages(tmpTranscript([asked('go'), wrapped]), { conversationOnly: true });
  assert.deepEqual(m.map((x) => [x.role, x.text, x.fromPanel]), [['user', 'go', undefined], ['user', 'ship it', true]]);
});

test('conversation only: a prefix in an ordinary typed prompt is left alone', () => {
  const m = readRecentMessages(tmpTranscript([asked(MESSAGE_PREFIX + 'typed by hand')]), { conversationOnly: true });
  assert.deepEqual(m.map((x) => [x.text, x.fromPanel]), [[MESSAGE_PREFIX + 'typed by hand', undefined]]);
});

test('the default still lists tool lines for the subagent feed', () => {
  const m = readRecentMessages(sessionFixture(), {});
  assert.deepEqual(m.map((x) => x.role), ['user', 'assistant', 'tool', 'user', 'user']);
  assert.equal(m[2].text, 'Bash: npm test');
  assert.equal(m[3].text, 'Background command done');
  assert.equal(m[4].fromPanel, undefined);
});

test('limit counts conversation messages, not dropped tool lines', () => {
  const records = [said('one'), asked('two'), said('three')];
  for (let i = 0; i < 50; i++) records.push(toolOnly());
  const file = tmpTranscript(records);
  assert.deepEqual(readRecentMessages(file, { limit: 3, conversationOnly: true }).map((x) => x.text), ['one', 'two', 'three']);
  assert.deepEqual(readRecentMessages(file, { limit: 3 }).map((x) => x.role), ['tool', 'tool', 'tool']);
});
