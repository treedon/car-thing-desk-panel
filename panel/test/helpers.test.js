import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tileLabels, subagentBadge, subagentIndentPx, fmtAge, waitingLabel, fmtDuration } from '../src/screens/helpers.js';

test('tileLabels hides a subtitle equal to the title', () => {
  assert.deepEqual(tileLabels({ name: 'mirror', project: 'mirror' }), { title: 'mirror', subtitle: '' });
  assert.deepEqual(tileLabels({ name: 'GitHub issue tracker triage', project: 'Mirror' }),
    { title: 'GitHub issue tracker triage', subtitle: 'Mirror' });
});

test('tileLabels survives a summary with no project', () => {
  assert.deepEqual(tileLabels({ name: 'x' }), { title: 'x', subtitle: '' });
});

test('subagentBadge copy', () => {
  assert.equal(subagentBadge({ running: 0, finished: 0 }), null);
  assert.equal(subagentBadge({ running: 1, finished: 0 }), '1 agent running');
  assert.equal(subagentBadge({ running: 2, finished: 3 }), '2 agents running');
  assert.equal(subagentBadge({ running: 0, finished: 1 }), '1 agent done');
  assert.equal(subagentBadge({ running: 0, finished: 3 }), '3 agents done');
  assert.equal(subagentBadge(undefined), null);
});

test('indent caps at 60', () => {
  assert.equal(subagentIndentPx(1), 0);
  assert.equal(subagentIndentPx(2), 20);
  assert.equal(subagentIndentPx(9), 60);
});

test('the agent feed keeps watching its parent session', async () => {
  const { watchTarget } = await import('../src/screens/helpers.js');
  assert.equal(watchTarget('agent', 's1', { sessions: [] }), 's1');
});

test('fmtAge: now under a minute, minutes under an hour, hours under 48 h, then days', () => {
  assert.deepEqual([30e3, 12 * 60e3, 2 * 3600e3, 50 * 3600e3].map(fmtAge), ['now', '12m', '2h', '2d']);
});

test('fmtAge changes at its edges, one millisecond either side', () => {
  const H = 3600e3;
  assert.deepEqual([0, 59999, 60e3, H - 1, H, 48 * H - 1, 48 * H, 49 * H + 1].map(fmtAge),
    ['now', 'now', '1m', '59m', '1h', '47h', '2d', '2d']);
});

test('fmtAge reads a clock that is ahead, or a number that is not one, as now', () => {
  assert.deepEqual([-5000, NaN, Infinity, -Infinity, undefined, null, 'x', {}].map(fmtAge), ['now', 'now', 'now', 'now', 'now', 'now', 'now', 'now']);
});

test('waitingLabel names one job or counts several', () => {
  assert.equal(waitingLabel([{ label: 'npm test', since: 0 }], 4 * 60000), 'waiting on npm test \u00b7 ' + fmtDuration(4 * 60000));
  assert.equal(waitingLabel([{ label: 'npm test', since: 0 }], 4 * 60000), 'waiting on npm test \u00b7 4m');
  assert.ok(waitingLabel([{ label: 'a', since: 0 }, { label: 'b', since: 1 }], 60000).startsWith('waiting on 2 jobs'));
});

test('waitingLabel times several jobs from the oldest one', () => {
  const jobs = [{ label: 'a', since: 3 * 60000 }, { label: 'b', since: 60000 }, { label: 'c', since: 2 * 60000 }];
  assert.equal(waitingLabel(jobs, 5 * 60000), 'waiting on 3 jobs \u00b7 4m');
});

test('waitingLabel is empty when nothing is in flight, and survives a missing list', () => {
  assert.equal(waitingLabel([], 1000), '');
  assert.equal(waitingLabel(undefined, 1000), '');
  assert.equal(waitingLabel(null, 1000), '');
});

test('waitingLabel never prints a negative time when the Mac clock runs ahead', () => {
  assert.equal(waitingLabel([{ label: 'npm test', since: 90000 }], 60000), 'waiting on npm test \u00b7 0m');
});
