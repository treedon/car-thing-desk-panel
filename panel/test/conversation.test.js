import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, renderConversation } from '../src/screens/conversation.js';
import { renderDetail } from '../src/screens/session-detail.js';
import { applyMessages, get as getState } from '../src/store.js';

test('markdown: paragraphs split on blank lines', () => {
  assert.equal(renderMarkdown('one\ntwo\n\nthree'), '<p>one<br>two</p><p>three</p>');
});

test('markdown: bullet lists', () => {
  assert.equal(renderMarkdown('- a\n- b\n* c'), '<ul><li>a</li><li>b</li><li>c</li></ul>');
});

test('markdown: inline and fenced code, escaped', () => {
  assert.equal(renderMarkdown('run `npm test` now'), '<p>run <code>npm test</code> now</p>');
  assert.equal(renderMarkdown('```js\nif (a < b) x();\n```'), '<pre>if (a &lt; b) x();</pre>');
});

test('markdown: html in text is escaped, bold markers are dropped', () => {
  assert.equal(renderMarkdown('<b>hi</b> **there**'), '<p>&lt;b&gt;hi&lt;/b&gt; there</p>');
});

test('markdown: an unclosed fence still renders as code', () => {
  assert.equal(renderMarkdown('```\nhalf'), '<pre>half</pre>');
});

test('conversation renders each role distinctly, oldest first', () => {
  const html = renderConversation([
    { role: 'user', text: 'Run the tests', ts: 1 },
    { role: 'assistant', text: 'Running.', ts: 2 },
    { role: 'tool', text: 'Bash: npm test', ts: 3 },
  ]);
  const u = html.indexOf('cv-user'), a = html.indexOf('cv-asst'), t = html.indexOf('cv-tool');
  assert.ok(u >= 0 && u < a && a < t);
  assert.match(html, /id="cvend"/);
});

test('conversation with no messages says so', () => {
  assert.match(renderConversation([]), /No messages yet/);
  assert.match(renderConversation(null), /Loading conversation/);
});

test('detail leads with the conversation, status below it', () => {
  applyMessages('s1', [{ role: 'user', text: 'hello', ts: 1 }]);
  const state = getState();
  state.details.s1 = {
    id: 's1', name: 'Title', project: 'proj', state: 'idle', tokens: { in: 0, out: 0 },
    cacheRead: 0, context: null, model: '', cwd: '/x/proj',
  };
  const html = renderDetail(state, 's1');
  assert.ok(html.indexOf('cv-user') < html.indexOf('statsrow'));
  assert.match(html, /id="dscroll"/);
});

test('a reply sent from the panel is labelled', () => {
  const html = renderConversation([
    { role: 'user', text: 'Run the tests', ts: 1 },
    { role: 'user', text: 'ship it', ts: 2, fromPanel: true },
  ]);
  assert.equal(html.split('from the panel').length - 1, 1);
  assert.ok(html.indexOf('from the panel') < html.indexOf('ship it'));
  assert.ok(html.indexOf('Run the tests') < html.indexOf('from the panel'));
});
