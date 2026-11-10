// Background sessions (`claude --bg`) are told apart from windows in the store:
// the poller copies the registry's kind and job id across, and the summary
// turns them into the flags the rest of the service branches on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { isWindowlessBackground, isBackgroundSession, turnEnded, BG_HOLD_MS } from '../src/background.js';
import { createStore } from '../src/sessions/store.js';
import { createReconciler } from '../src/sessions/source-poller.js';
import { transcriptPathFor, stopTail } from '../src/sessions/tails.js';

test('a background job with no parked window is windowless', () => {
  assert.equal(isWindowlessBackground({ id: 's1', kind: 'background', jobId: 'c41c76b4' }, () => null), true);
});
test('a background job a window is parked on is not windowless', () => {
  assert.equal(isWindowlessBackground({ id: 's1', kind: 'background', jobId: 'c41c76b4' }, () => ({ pid: 1 })), false);
});
test('interactive and unknown sessions are not windowless', () => {
  assert.equal(isWindowlessBackground({ id: 's1', kind: 'interactive' }, () => null), false);
  assert.equal(isWindowlessBackground(null, () => null), false);
});
test('the window lookup is asked about the job id and the session id', () => {
  let asked = null;
  isWindowlessBackground({ id: 's1', kind: 'background', jobId: 'c41c76b4' }, (rec) => { asked = rec; return null; });
  assert.deepEqual(asked, { jobId: 'c41c76b4', sessionId: 's1' });
});
test('turnEnded needs a Stop, no held permission and nothing waited on', () => {
  assert.equal(turnEnded({ stoppedTs: 5 }), true);
  assert.equal(turnEnded({ stoppedTs: null }), false);
  assert.equal(turnEnded({ stoppedTs: 5, pendingPermission: true }), false);
  assert.equal(turnEnded({ stoppedTs: 5, waitingOn: [{ type: 'bash' }] }), false);
});
test('the hold is under the 600 s hook timeout', () => { assert.ok(BG_HOLD_MS < 600_000); });

test('summary carries background and a null handoff by default', () => {
  const store = createStore();
  store.upsert('s1', { kind: 'background', jobId: 'c41c76b4', cwd: '/x/p', lastActivityTs: Date.now() });
  const s = store.get('s1');
  assert.equal(s.background, true);
  assert.equal(s.handoff, null);
  store.upsert('s2', { kind: 'interactive', cwd: '/x/q', lastActivityTs: Date.now() });
  assert.equal(store.get('s2').background, false);
});

test('summary carries a handoff once one is set', () => {
  const store = createStore();
  store.upsert('s1', { kind: 'background', handoff: 'waiting', cwd: '/x/p', lastActivityTs: Date.now() });
  assert.equal(store.get('s1').handoff, 'waiting');
});

// --- naming ---------------------------------------------------------------------
//
// A background job is registered under its folder name until Claude Code titles
// it, and several jobs in one folder would all read the same. What the owner
// asked it is the better label.

test('an untitled background job named for its folder reads as what it was asked', () => {
  const store = createStore();
  store.upsert('s1', { kind: 'background', name: 'p', cwd: '/x/p', lastPrompt: 'fix the weather tile', lastActivityTs: Date.now() });
  assert.equal(store.get('s1').name, 'fix the weather tile');
});
test('a background job with no name at all reads as what it was asked', () => {
  const store = createStore();
  store.upsert('s1', { kind: 'background', cwd: '/x/p', lastPrompt: 'fix the weather tile', lastActivityTs: Date.now() });
  assert.equal(store.get('s1').name, 'fix the weather tile');
});
test('an interactive session in the same state keeps its folder name', () => {
  const store = createStore();
  store.upsert('s1', { kind: 'interactive', name: 'p', cwd: '/x/p', lastPrompt: 'fix the weather tile', lastActivityTs: Date.now() });
  assert.equal(store.get('s1').name, 'p');
});
test('a background job with a title keeps it, whatever it was asked', () => {
  const store = createStore();
  store.upsert('s1', { kind: 'background', name: 'p', cwd: '/x/p', aiTitle: 'Weather tile fix', lastPrompt: 'fix the weather tile', lastActivityTs: Date.now() });
  assert.equal(store.get('s1').name, 'Weather tile fix');
  store.upsert('s2', { kind: 'background', name: 'p', cwd: '/x/p', customTitle: 'Mine', lastPrompt: 'fix the weather tile', lastActivityTs: Date.now() });
  assert.equal(store.get('s2').name, 'Mine');
});
test('a background job the registry named keeps that name', () => {
  const store = createStore();
  store.upsert('s1', { kind: 'background', name: 'weather work', cwd: '/x/p', lastPrompt: 'fix the weather tile', lastActivityTs: Date.now() });
  assert.equal(store.get('s1').name, 'weather work');
});
test('a background job not yet asked anything keeps its folder name', () => {
  const store = createStore();
  store.upsert('s1', { kind: 'background', name: 'p', cwd: '/x/p', lastActivityTs: Date.now() });
  assert.equal(store.get('s1').name, 'p');
});

// --- the poller -----------------------------------------------------------------

const CWD = '/Users/nobody/Projects/demo';
const NONE = new Set();

test('a background listing leaves its kind and short job id on the record', () => {
  const store = createStore();
  const { reconcile } = createReconciler({ store });
  reconcile([{ id: 'c41c76b4', sessionId: 's1', cwd: CWD, kind: 'background', state: 'done', status: 'idle' }], NONE, new Map(), new Map());
  assert.equal(store.raw('s1').kind, 'background');
  assert.equal(store.raw('s1').jobId, 'c41c76b4');
  assert.equal(store.get('s1').background, true);
});

test('an interactive listing is kind interactive and has no job id', () => {
  // An interactive entry only counts as a session once it owns a transcript.
  const id = `background-test-${process.pid}`;
  const file = transcriptPathFor(id, CWD);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"type":"user"}\n');
  try {
    const store = createStore();
    const { reconcile } = createReconciler({ store });
    reconcile([{ sessionId: id, cwd: CWD, kind: 'interactive', status: 'idle' }], NONE, new Map(), new Map());
    assert.ok(store.raw(id), 'the window is a session');
    assert.equal(store.raw(id).kind, 'interactive');
    assert.equal('jobId' in store.raw(id), false);
    assert.equal(store.get(id).background, false);
  } finally {
    stopTail(id);
    fs.unlinkSync(file);
  }
});

test('a later listing without a kind keeps the kind and job id an earlier one gave', () => {
  const store = createStore();
  const { reconcile } = createReconciler({ store });
  reconcile([{ id: 'c41c76b4', sessionId: 's1', cwd: CWD, kind: 'background' }], NONE, new Map(), new Map());
  // A later listing without a kind must not blank what an earlier one said.
  reconcile([{ sessionId: 's1', cwd: CWD }], NONE, new Map(), new Map());
  assert.equal(store.raw('s1').kind, 'background');
  assert.equal(store.raw('s1').jobId, 'c41c76b4');
});

// What the permission and question bridges ask: is this id a background session's? A session the
// service started counts only until the poller has tagged a kind (it does so every few seconds).
const startedOnly = (...ids) => (id) => ids.includes(id);
const nobody = () => false;
const noWindow = () => null;

test('a started id the store does not know yet is background', () => {
  assert.equal(isBackgroundSession(undefined, startedOnly('s1'), 's1', noWindow), true);
  assert.equal(isBackgroundSession(null, startedOnly('s1'), 's1', noWindow), true);
});
test('a started id with a record but no kind yet is still background', () => {
  assert.equal(isBackgroundSession({ id: 's1' }, startedOnly('s1'), 's1', noWindow), true);
});
test('a started id the registry says is interactive is not background (a handoff into VS Code, say)', () => {
  assert.equal(isBackgroundSession({ id: 's1', kind: 'interactive' }, startedOnly('s1'), 's1', noWindow), false);
});
test('a started id whose job a window has parked on is not background either', () => {
  assert.equal(isBackgroundSession({ id: 's1', kind: 'background', jobId: 'c41c76b4' }, startedOnly('s1'), 's1', () => ({ pid: 1 })), false);
});
test('a background record with no parked window is background, started here or not', () => {
  const raw = { id: 's1', kind: 'background', jobId: 'c41c76b4' };
  assert.equal(isBackgroundSession(raw, nobody, 's1', noWindow), true);
  assert.equal(isBackgroundSession(raw, startedOnly('s1'), 's1', noWindow), true);
});
test('an unknown id nobody started is not background', () => {
  assert.equal(isBackgroundSession(undefined, nobody, 's1', noWindow), false);
  assert.equal(isBackgroundSession({ id: 's1' }, startedOnly('other'), 's1', noWindow), false);
});
test('the started check is asked about the id it was given', () => {
  let asked = null;
  isBackgroundSession(undefined, (id) => { asked = id; return false; }, 's9', noWindow);
  assert.equal(asked, 's9');
});
