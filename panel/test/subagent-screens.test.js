import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderList } from '../src/screens/session-list.js';
import { renderDetail } from '../src/screens/session-detail.js';
import { renderFeed } from '../src/screens/subagent-feed.js';

function state(over = {}) {
  return {
    sessions: [], details: {}, messages: {}, subagents: {}, feeds: {}, agentSel: -1,
    asks: [], daemonConnected: true, selectedIndex: 0, ...over,
  };
}
const detail = { id: 's1', name: 'Title', project: 'proj', state: 'busy', tokens: { in: 0, out: 0 },
  cacheRead: 0, context: null, model: '', cwd: '/x/proj' };
const agent = (over = {}) => ({ id: 'a1', description: 'Review Task 4', agentType: 'general-purpose',
  background: true, depth: 1, parentId: null, running: true, currentTool: 'Bash: npm test',
  startedTs: Date.now() - 65000, lastActivityTs: Date.now(), ...over });

test('tile shows the subagent badge when there is one', () => {
  const s = { id: 's1', name: 'T', project: 'p', state: 'busy', subagents: { running: 2, finished: 1 }, tokens: { in: 0, out: 0 } };
  assert.match(renderList(state({ sessions: [s] })), /2 agents running/);
  const quiet = { ...s, subagents: { running: 0, finished: 0 } };
  assert.doesNotMatch(renderList(state({ sessions: [quiet] })), /agents? (running|done)/);
});

test('detail lists subagents with state, background tag, tool and indent', () => {
  const html = renderDetail(state({
    details: { s1: detail }, messages: { s1: [] },
    subagents: { s1: [agent(), agent({ id: 'a2', depth: 2, running: false, background: false, description: 'Child' })] },
    agentSel: 1,
  }), 's1');
  assert.match(html, /Review Task 4/);
  assert.match(html, /general-purpose/);
  assert.match(html, /RUNNING/);
  assert.match(html, /DONE/);
  assert.match(html, /BACKGROUND/);
  assert.match(html, /Bash: npm test/);
  assert.match(html, /margin-left:20px/);
  assert.equal((html.match(/agrow[^"]*selected/g) || []).length, 1);
  assert.match(html, /data-action="open-agent" data-id="a2"/);
});

test('detail without subagents shows no agent section', () => {
  const html = renderDetail(state({ details: { s1: detail }, messages: { s1: [] }, subagents: { s1: [] } }), 's1');
  assert.doesNotMatch(html, /data-action="open-agent"/);
  assert.doesNotMatch(html, /aghead">Subagents/);
});

test('feed shows steps, then the report once finished', () => {
  const st = state({
    subagents: { s1: [agent({ running: false })] },
    feeds: { 'a1': { steps: [{ role: 'tool', text: 'Read: /x/a.js', ts: 1 }], report: 'All good.' } },
  });
  const html = renderFeed(st, 's1', 'a1');
  assert.match(html, /Review Task 4/);
  assert.match(html, /Read: \/x\/a.js/);
  assert.ok(html.indexOf('Read: /x/a.js') < html.indexOf('All good.'));
  assert.match(html, /agreport/);
});

test('feed before its first fetch says it is loading', () => {
  assert.match(renderFeed(state(), 's1', 'zz'), /Loading/);
});

test('the subagent cursor is held inside the action rows plus the subagents', async () => {
  const store = await import('../src/store.js');
  const { ACTION_ROWS } = await import('../src/screens/session-detail.js');
  store.update({ agentSel: 99 });
  store.applySubagents('s1', [agent(), agent({ id: 'a2' })]);
  assert.equal(store.get().agentSel, ACTION_ROWS + 2 - 1, 'the last row, not past it');
  store.update({ agentSel: 1 });
  store.applySubagents('s1', [agent(), agent({ id: 'a2' })]);
  assert.equal(store.get().agentSel, 1, 'a cursor already on a row stays');
  store.update({ agentSel: -1 });
});

test('a background session\'s extra rows lift the cursor\'s ceiling', async () => {
  const store = await import('../src/store.js');
  const { actionRowCount } = await import('../src/screens/session-detail.js');
  const detail = { id: 's1', name: 'bg', state: 'idle', background: true, handoff: 'waiting', tokens: { in: 0, out: 0 }, cacheRead: 0, waitingOn: [] };
  store.applyDetail(detail);
  assert.equal(actionRowCount(store.get().details.s1), 5);
  store.update({ agentSel: 99 });
  store.applySubagents('s1', [agent(), agent({ id: 'a2' })]);
  assert.equal(store.get().agentSel, 5 + 2 - 1, 'the last row of five action rows and two subagents');
  store.update({ agentSel: 5 });
  store.applySubagents('s1', [agent(), agent({ id: 'a2' })]);
  assert.equal(store.get().agentSel, 5, 'a subagent row past the plain three stays reachable');
  // the same session, no longer waiting: one fewer row
  store.applyDetail({ ...detail, handoff: null });
  store.update({ agentSel: 99 });
  store.applySubagents('s1', [agent(), agent({ id: 'a2' })]);
  assert.equal(store.get().agentSel, 4 + 2 - 1);
  // an interactive one keeps the plain three
  store.applyDetail({ ...detail, background: false });
  store.update({ agentSel: 99 });
  store.applySubagents('s1', [agent(), agent({ id: 'a2' })]);
  assert.equal(store.get().agentSel, 3 + 2 - 1);
  store.update({ agentSel: -1 });
});

test('the store starts with no STOP armed', async () => {
  const store = await import('../src/store.js');
  assert.strictEqual(store.get().stopArmedFor, null);
});

test('the store starts without a chime setting: the Mac has not said yet', async () => {
  const store = await import('../src/store.js');
  assert.strictEqual(store.get().chimeOn, null);
});

// ---- the dial cursor when the action rows change under it ------------------------------------------------

const WAITING = { id: 's1', name: 'bg', state: 'busy', background: true, handoff: 'waiting', tokens: { in: 0, out: 0 }, cacheRead: 0, waitingOn: [] };
const NOT_WAITING = { ...WAITING, handoff: null };
// not waiting: 0 open, 1 auto-open, 2 chime, 3 STOP.  waiting: 0 open, 1 OPEN NOW, 2 auto-open, 3 chime, 4 STOP.

test('cursorAfterRows: the cursor stays on the row it was on when OPEN NOW appears above it', async () => {
  const { cursorAfterRows } = await import('../src/screens/session-detail.js');
  assert.equal(cursorAfterRows(1, NOT_WAITING, WAITING, 0), 2, 'was "Open automatically": still is, not the new OPEN NOW');
  assert.equal(cursorAfterRows(2, NOT_WAITING, WAITING, 0), 3, 'the chime row');
  assert.equal(cursorAfterRows(3, NOT_WAITING, WAITING, 0), 4, 'STOP stays STOP');
});

test('cursorAfterRows: a cursor on OPEN NOW, which vanishes, is taken off the list', async () => {
  const { cursorAfterRows } = await import('../src/screens/session-detail.js');
  assert.equal(cursorAfterRows(1, WAITING, NOT_WAITING, 0), -1);
});

test('cursorAfterRows: the rows below OPEN NOW move up when it vanishes', async () => {
  const { cursorAfterRows } = await import('../src/screens/session-detail.js');
  assert.equal(cursorAfterRows(2, WAITING, NOT_WAITING, 0), 1, 'Open automatically');
  assert.equal(cursorAfterRows(4, WAITING, NOT_WAITING, 0), 3, 'STOP stays STOP');
});

test('cursorAfterRows: when the session ends its STOP row goes, and a cursor resting on it is taken off the list', async () => {
  const { cursorAfterRows } = await import('../src/screens/session-detail.js');
  const ENDED = { ...NOT_WAITING, ended: true };
  assert.equal(cursorAfterRows(3, NOT_WAITING, ENDED, 0), -1, 'was STOP, which is gone');
  assert.equal(cursorAfterRows(2, NOT_WAITING, ENDED, 0), 2, 'the chime row stays where it was');
  assert.equal(cursorAfterRows(4, WAITING, { ...WAITING, ended: true }, 0), -1, 'STOP, with OPEN NOW gone too');
  assert.equal(cursorAfterRows(3, WAITING, { ...WAITING, ended: true }, 0), 2, 'the chime row, one up now OPEN NOW is gone');
});

test('cursorAfterRows: row 0, no cursor and an unchanged layout never move', async () => {
  const { cursorAfterRows } = await import('../src/screens/session-detail.js');
  assert.equal(cursorAfterRows(0, NOT_WAITING, WAITING, 0), 0);
  assert.equal(cursorAfterRows(0, WAITING, NOT_WAITING, 0), 0);
  assert.equal(cursorAfterRows(-1, NOT_WAITING, WAITING, 2), -1);
  assert.equal(cursorAfterRows(3, NOT_WAITING, NOT_WAITING, 0), 3);
});

test('cursorAfterRows: a subagent row keeps its subagent, and the end of the list clamps', async () => {
  const { cursorAfterRows } = await import('../src/screens/session-detail.js');
  assert.equal(cursorAfterRows(5, NOT_WAITING, WAITING, 2), 6, 'the first subagent, once there are five action rows');
  assert.equal(cursorAfterRows(6, WAITING, NOT_WAITING, 2), 5, 'the last subagent, once there are four');
  assert.equal(cursorAfterRows(6, WAITING, NOT_WAITING, 1), 4, 'the list has shrunk too: the last row there is');
  assert.equal(cursorAfterRows(9, NOT_WAITING, NOT_WAITING, 1), 9, 'a layout that did not change is not this function\'s business (applySubagents clamps)');
});

test('cursorAfterRows: a session that stops being a background one loses its rows, and the cursor follows what is left', async () => {
  const { cursorAfterRows } = await import('../src/screens/session-detail.js');
  const plain = { ...NOT_WAITING, background: false };
  assert.equal(cursorAfterRows(2, NOT_WAITING, plain, 0), 2, 'the chime row');
  assert.equal(cursorAfterRows(3, NOT_WAITING, plain, 0), -1, 'the STOP row is gone');
  assert.equal(cursorAfterRows(1, plain, WAITING, 0), 2, 'Open automatically, with OPEN NOW above it now');
});

test('applyDetail moves the cursor of the session on screen with its rows', async () => {
  const store = await import('../src/store.js');
  globalThis.window = { location: { hash: '#/session/s1' } };
  try {
    store.applyDetail(NOT_WAITING);
    store.update({ agentSel: 1 });
    store.applyDetail(WAITING);
    assert.equal(store.get().agentSel, 2, 'still on Open automatically, which a dial press toggles');
    store.update({ agentSel: 1 });
    store.applyDetail(NOT_WAITING);
    assert.equal(store.get().agentSel, -1, 'OPEN NOW vanished under the cursor');
    store.update({ agentSel: 3 });
    store.applyDetail(WAITING);
    assert.equal(store.get().agentSel, 4, 'STOP is still STOP');
    store.update({ agentSel: 0 });
    store.applyDetail(NOT_WAITING);
    assert.equal(store.get().agentSel, 0, 'row 0 never moves');
    store.update({ agentSel: -1 });
    store.applyDetail(WAITING);
    assert.equal(store.get().agentSel, -1, 'no cursor, nothing to move');
  } finally {
    delete globalThis.window;
    store.update({ agentSel: -1 });
  }
});

test('applyDetail leaves the cursor alone for a session that is not on screen', async () => {
  const store = await import('../src/store.js');
  globalThis.window = { location: { hash: '#/session/zz' } };
  try {
    store.applyDetail(NOT_WAITING);
    store.update({ agentSel: 1 });
    store.applyDetail(WAITING);
    assert.equal(store.get().agentSel, 1);
  } finally {
    delete globalThis.window;
    store.update({ agentSel: -1 });
  }
});

test('applyDetail clamps the cursor to the subagents it knows of', async () => {
  const store = await import('../src/store.js');
  globalThis.window = { location: { hash: '#/session/s1' } };
  try {
    store.applyDetail(WAITING);
    store.applySubagents('s1', [agent()]);
    store.update({ agentSel: 6 });
    store.applyDetail(NOT_WAITING);
    assert.equal(store.get().agentSel, 4, 'four action rows and one subagent: the last row is 4');
  } finally {
    delete globalThis.window;
    store.applySubagents('s1', []);
    store.update({ agentSel: -1 });
  }
});
