// What a Stop payload says is still running: background tasks (shells,
// subagents) and one-shot scheduled wakeups. A recurring cron is a schedule,
// not a run in flight, so it never counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitingOnFrom } from '../src/sessions/waiting-on.js';

test('each background task becomes a labelled entry', () => {
  const w = waitingOnFrom({ background_tasks: [
    { id: '1', type: 'shell', status: 'running', description: 'tests', command: 'npm test -- --watch=false' },
    { id: '2', type: 'subagent', status: 'running', description: 'Review diff', agent_type: 'general-purpose' },
  ] }, 5000);
  assert.deepEqual(w.map((e) => e.label), ['npm test -- --watch=false', 'Review diff']);
  assert.deepEqual(w.map((e) => e.type), ['shell', 'subagent']);
  assert.ok(w.every((e) => e.since === 5000));
});

test('a task with no command or description falls back to its agent type, name, then type', () => {
  const w = waitingOnFrom({ background_tasks: [
    { id: '1', type: 'subagent', agent_type: 'general-purpose' },
    { id: '2', type: 'monitor', name: 'deploy watch' },
    { id: '3', type: 'shell' },
  ] }, 0);
  assert.deepEqual(w.map((e) => e.label), ['general-purpose', 'deploy watch', 'shell']);
});

test('labels are capped at 60 chars', () => {
  const w = waitingOnFrom({ background_tasks: [{ id: '1', type: 'shell', command: 'x'.repeat(90) }] }, 0);
  assert.equal(w[0].label.length, 60);
});

test('a one-shot wakeup waits; a recurring cron does not', () => {
  const w = waitingOnFrom({ session_crons: [{ id: 'c', schedule: '40 15 6 11 *', recurring: false, prompt: 'p' }] }, 7);
  assert.equal(w[0].label, 'wakes at 15:40');
  assert.equal(w[0].type, 'cron');
  assert.equal(w[0].since, 7);
  assert.deepEqual(waitingOnFrom({ session_crons: [{ id: 'c', schedule: '*/20 * * * *', recurring: true, prompt: 'p' }] }, 0), []);
});

test('the wakeup time pads minutes but not the hour', () => {
  const w = waitingOnFrom({ session_crons: [{ id: 'c', schedule: '5 9 6 11 *', recurring: false }] }, 0);
  assert.equal(w[0].label, 'wakes at 9:05');
});

test('a one-shot whose time cannot be read is still a scheduled wakeup', () => {
  const w = waitingOnFrom({ session_crons: [{ id: 'c', schedule: '*/5 * * * *', recurring: false }] }, 0);
  assert.equal(w[0].label, 'scheduled wakeup');
  assert.equal(waitingOnFrom({ session_crons: [{ id: 'c', recurring: false }] }, 0)[0].label, 'scheduled wakeup');
});

test('tasks come before wakeups', () => {
  const w = waitingOnFrom({
    session_crons: [{ id: 'c', schedule: '0 8 6 11 *', recurring: false }],
    background_tasks: [{ id: '1', type: 'shell', command: 'make' }],
  }, 0);
  assert.deepEqual(w.map((e) => e.label), ['make', 'wakes at 8:00']);
});

test('missing fields mean nothing in flight', () => {
  assert.deepEqual(waitingOnFrom({}, 0), []);
  assert.deepEqual(waitingOnFrom(undefined, 0), []);
  assert.deepEqual(waitingOnFrom({ background_tasks: null, session_crons: 'nope' }, 0), []);
});

test('junk entries are skipped, and a task with nothing to name it still shows', () => {
  const w = waitingOnFrom({ background_tasks: [null, 3, 'x', {}], session_crons: [null] }, 0);
  assert.deepEqual(w.map((e) => e.label), ['background task']);
});
