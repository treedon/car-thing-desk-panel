import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderDetail } from '../src/screens/session-detail.js';
import { messageStatusText } from '../src/screens/helpers.js';
import { replySent } from '../src/inbox.js';

const detail = { id: 's1', name: 'Title', project: 'proj', state: 'idle', tokens: { in: 0, out: 0 },
  cacheRead: 0, context: null, model: '', cwd: '/x/proj' };
const state = (over = {}) => ({ details: { s1: detail }, messages: { s1: [] }, subagents: {}, agentSel: -1,
  messageStatus: {}, daemonConnected: true, ...over });

test('status copy for every way a message can go', () => {
  assert.equal(messageStatusText({ status: 'next-tool' }), 'Sent. Claude gets it at its next step.');
  assert.equal(messageStatusText({ status: 'wake' }), 'Sent. Waking Claude…');
  assert.equal(messageStatusText({ status: 'cannot-wake' }), "Not sent. This session can't be woken from the panel (idle over an hour, or hooks not installed). Say it in VS Code.");
  assert.equal(messageStatusText({ status: 'answer' }), 'Sent as your answer.');
  assert.equal(messageStatusText({ status: 'delivered' }), 'Delivered.');
  assert.equal(messageStatusText({ status: 'dropped' }), 'Dropped because you typed in VS Code.');
  assert.equal(messageStatusText({ status: 'failed', error: 'x' }), "Couldn't send: x");
  assert.equal(messageStatusText(null), '');
});

test('the conversation ends with the message status, and says how to send one', () => {
  const html = renderDetail(state({ messageStatus: { s1: { status: 'dropped', text: 'hi' } } }), 's1');
  assert.match(html, /cv-msgstatus[^>]*>Dropped because you typed in VS Code\./);
  assert.ok(html.indexOf('cv-msgstatus') < html.indexOf('id="cvend"'), 'inside the conversation, above its end marker');
  assert.match(html, /Hold the top button to send Claude a message/);
});

test('status copy for refused messages', () => {
  assert.equal(messageStatusText({ status: 'unknown-session' }), "Not sent. The Mac doesn't know this session any more.");
  assert.equal(messageStatusText({ status: 'answer-on-panel' }), 'Not sent. This question has several parts; answer it on the question screen.');
});

test('a reply from a card never toasts nothing: every delivery the Mac can return has copy, and only the sent ones say SENT', () => {
  for (const d of ['wake', 'next-tool', 'answer']) assert.equal(replySent(d), true, d);
  for (const d of ['cannot-wake', 'unknown-session', 'answer-on-panel']) {
    assert.equal(replySent(d), false, d);
    assert.match(messageStatusText({ status: d }), /^Not sent\./, d);
  }
});
