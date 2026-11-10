import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTasksClient, stepMinutes, focusPhase, fmtLeft, taskRows, withItemToggled, findTask, openCount, tasksErrorText,
} from '../src/tasks.js';
import { renderTasks, renderTask, renderFocusSetup, renderFocus, focusChip } from '../src/screens/tasks.js';
import { readConfig } from '../src/config.js';
import { createScreenPower } from '../src/screen-power.js';

const TASKS = {
  configured: true, status: 'ok', error: null, list: 'Work',
  items: [
    { id: 'a', title: 'Email Sam', priority: 0, items: [] },
    { id: 'b', title: 'Write <report>', priority: 5, items: [
      { id: 'i1', title: 'Outline', done: true }, { id: 'i2', title: 'Draft', done: false },
    ] },
  ],
};

function fakeFetch(reply) {
  const calls = [];
  const fn = (url, init) => {
    calls.push({ url, init });
    const r = typeof reply === 'function' ? reply(url, init) : reply;
    return Promise.resolve({ ok: r.status < 400, status: r.status, text: () => Promise.resolve(r.body === undefined ? '' : JSON.stringify(r.body)) });
  };
  return { fn, calls };
}

test('the client sends the panel token and JSON, and names the service\'s error', async () => {
  const f = fakeFetch({ status: 200, body: { outcome: 'added' } });
  const c = createTasksClient({ url: 'http://nuc:8791/', token: 'tok' }, { fetch: f.fn });
  assert.deepEqual(await c.addItem('t/1', 'Proofread'), { outcome: 'added' });
  assert.equal(f.calls[0].url, 'http://nuc:8791/tasks/t%2F1/items');
  assert.equal(f.calls[0].init.headers.Authorization, 'Bearer tok');
  assert.equal(f.calls[0].init.body, JSON.stringify({ title: 'Proofread' }));
  const bad = createTasksClient({ url: 'http://nuc:8791', token: 'tok' }, { fetch: fakeFetch({ status: 409, body: { error: 'items-full' } }).fn });
  await assert.rejects(bad.addItem('x', 'y'), /items-full/);
  const down = createTasksClient({ url: 'http://nuc:8791', token: 'tok' }, { fetch: () => Promise.reject(new TypeError('Failed to fetch')) });
  await assert.rejects(down.list(), /tasks-unreachable/);
});

test('a recording goes up as its own body with its type', async () => {
  const f = fakeFetch({ status: 200, body: { text: 'hi' } });
  const c = createTasksClient({ url: 'http://nuc:8791', token: 'tok' }, { fetch: f.fn });
  const blob = { size: 3 };
  await c.transcribe(blob, 'audio/wav');
  assert.equal(f.calls[0].init.body, blob);
  assert.equal(f.calls[0].init.headers['Content-Type'], 'audio/wav');
});

test('the tasks setting needs both a url and a token', () => {
  assert.equal(readConfig({ tasks: { url: 'http://n:8791' } }).tasks, null);
  assert.deepEqual(readConfig({ tasks: { url: 'http://n:8791', token: 't' } }).tasks, { url: 'http://n:8791', token: 't' });
});

test('the minutes dial steps by 5 between 5 and 120', () => {
  assert.equal(stepMinutes(25, 1), 30);
  assert.equal(stepMinutes(25, -1), 20);
  assert.equal(stepMinutes(5, -1), 5);
  assert.equal(stepMinutes(120, 1), 120);
  assert.equal(stepMinutes(23, 0), 25);
});

test('focus phase runs on the NucBox\'s clock', () => {
  const f = { startedAt: 1000, endsAt: 1000 + 25 * 60000 };
  assert.equal(focusPhase(null, 0, 0).phase, 'none');
  const mid = focusPhase(f, 1000 + 60000 - 5000, 5000);
  assert.equal(mid.phase, 'running');
  assert.equal(mid.leftMs, 24 * 60000);
  assert.equal(focusPhase(f, f.endsAt, 0).phase, 'done');
  assert.equal(fmtLeft(24 * 60000), '24:00');
  assert.equal(fmtLeft(61500), '1:02');
  assert.equal(fmtLeft(3600000 + 5000), '1:00:05');
});

test('a task\'s rows are Start, its subtasks, then Done; a tick shows at once', () => {
  const b = findTask(TASKS, 'b');
  assert.deepEqual(taskRows(b).map((r) => r.kind), ['start', 'item', 'item', 'complete']);
  assert.equal(openCount(b), 1);
  const next = withItemToggled(TASKS, 'b', 'i2');
  assert.equal(findTask(next, 'b').items[1].done, true);
  assert.equal(findTask(TASKS, 'b').items[1].done, false, 'the old state is untouched');
});

test('the list shows each task with a START button, escaped', () => {
  const html = renderTasks({ tasks: TASKS, focus: { focus: { taskId: 'a' } } }, { cursor: 1 });
  assert.match(html, /WORK/);
  assert.match(html, /Write &lt;report&gt;/);
  assert.equal((html.match(/data-action="task-start"/g) || []).length, 2);
  assert.match(html, /tkrow selected high/);
  assert.match(html, /1\/2/);
  assert.match(html, /FOCUS/, 'the task with the timer is marked');
});

test('unset, failing and empty lists each say so', () => {
  assert.match(renderTasks({ tasks: { configured: false, items: [] } }, {}), /aren't set up/);
  assert.match(renderTasks({ tasks: { configured: true, status: 'error', error: 'tasks-unreachable', items: [] } }, {}), /Can't reach the NucBox/);
  assert.match(renderTasks({ tasks: { configured: true, status: 'ok', items: [] } }, {}), /Nothing on the list/);
  assert.match(tasksErrorText('weird'), /weird/);
});

test('a task page, the minutes dial and the timer', () => {
  const page = renderTask({ tasks: TASKS, focus: {} }, { row: 0, minutes: 30 }, 'b');
  assert.match(page, /Start focus/);
  assert.match(page, /30 min/);
  assert.match(page, /tkitem ticked/);
  assert.match(page, /Mark task done/);
  assert.match(renderFocusSetup({ tasks: TASKS }, { minutes: 45 }, 'b'), /45<span>min/);
  const focus = { focus: { taskId: 'b', title: 'Write', minutes: 25, startedAt: 0, endsAt: 25 * 60000 }, offset: 0 };
  assert.match(renderFocus({ tasks: TASKS, focus }, {}, 60000), /24:00/);
  assert.match(renderFocus({ tasks: TASKS, focus }, { stopArmed: 1 }, 60000), /Press again to stop/);
  assert.match(renderFocus({ tasks: TASKS, focus }, { doneRow: 1 }, 26 * 60000), /Time's up/);
  assert.deepEqual(focusChip(focus, 60000), { text: '24:00', done: false });
  assert.deepEqual(focusChip(focus, 26 * 60000), { text: 'FOCUS DONE', done: true });
  assert.equal(focusChip({ focus: null }, 0), null);
});

test('a running focus timer keeps the screen lit with the Mac gone; a finished one for the awake period', () => {
  let t = 0;
  const p = createScreenPower({ now: () => t, awakeMs: 1000, linkGraceMs: 100 });
  t = 500;
  assert.equal(p.isOn(), false, 'no Mac, no knob: dark');
  p.focus('running');
  assert.equal(p.isOn(), true);
  p.focus('done');
  t = 1200;
  assert.equal(p.isOn(), true);
  t = 1600;
  assert.equal(p.isOn(), false);
  p.focus(null);
  assert.equal(p.isOn(), false);
});
