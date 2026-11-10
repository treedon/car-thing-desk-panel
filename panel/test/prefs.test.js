import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrefs } from '../src/prefs.js';
import { renderDetail } from '../src/screens/session-detail.js';

function memoryStorage() {
  const m = {};
  return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); } };
}

test('opening a session leaves the Mac alone unless the owner turns it on', () => {
  const store = memoryStorage();
  const prefs = createPrefs(store);
  assert.equal(prefs.get('autoOpenOnMac'), false);
  prefs.set('autoOpenOnMac', true);
  assert.equal(createPrefs(store).get('autoOpenOnMac'), true, 'remembered');
});

test('a storage that throws (private mode) falls back to defaults', () => {
  const prefs = createPrefs({ getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } });
  assert.equal(prefs.get('autoOpenOnMac'), false);
  assert.doesNotThrow(() => prefs.set('autoOpenOnMac', true));
  assert.equal(prefs.get('autoOpenOnMac'), true, 'kept for this run');
});

test('the session screen offers Open in VS Code and the auto-open setting, before subagents', () => {
  const detail = { id: 's1', name: 'T', project: 'p', state: 'idle', tokens: { in: 0, out: 0 }, cacheRead: 0, context: null, model: '', cwd: '/x/p' };
  const state = { details: { s1: detail }, messages: { s1: [] }, messageStatus: {}, agentSel: 1, daemonConnected: true,
    subagents: { s1: [{ id: 'a1', description: 'Agent one', agentType: 'Explore', depth: 1, running: false }] },
    autoOpenOnMac: false };
  const html = renderDetail(state, 's1');
  assert.match(html, /data-action="open-mac"[^>]*>.*Open in VS Code/);
  assert.match(html, /data-action="toggle-auto-open"[^>]*>.*Open automatically: Off/);
  assert.ok(html.indexOf('open-mac') < html.indexOf('Agent one'));
  assert.equal((html.match(/agrow[^"]*selected/g) || []).length, 1);
  assert.match(html, /toggle-auto-open[^>]*selected|selected[^>]*toggle-auto-open/, 'row index 1 is the setting');
  assert.match(renderDetail({ ...state, autoOpenOnMac: true }, 's1'), /Open automatically: On/);
});

test('the last machine a session was started on is remembered', () => {
  const store = memoryStorage();
  const prefs = createPrefs(store);
  assert.equal(prefs.get('newSessionHost'), '');
  prefs.set('newSessionHost', 'nucbox');
  assert.equal(createPrefs(store).get('newSessionHost'), 'nucbox');
});
