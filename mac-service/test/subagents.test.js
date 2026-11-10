import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import { readSubagents, readSubagentFeed, listSubagentMetas, readSubagentReport } from '../src/sessions/subagents.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (name) => path.join(here, 'fixtures', 'subagents', name);

test('lists agents oldest first with running state', () => {
  const list = readSubagents(fx('basic'), { sessionEnded: false });
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((a) => a.running), [false, false, true]);
  assert.equal(list[2].currentTool, 'Bash: npm test');
  assert.equal(list[0].background, true);
  assert.equal(list[1].background, false);
  assert.equal(list[0].id, 'a-finished-1');
  assert.equal(list[0].description, 'Review Task 4');
  assert.equal(list[0].agentType, 'general-purpose');
  assert.equal(list[0].startedTs, Date.parse('2026-11-02T10:00:00.000Z'));
  assert.equal(list[0].lastActivityTs, Date.parse('2026-11-02T10:00:09.000Z'));
});

test('ended session marks every agent finished', () => {
  assert.ok(readSubagents(fx('basic'), { sessionEnded: true }).every((a) => !a.running));
});

test('nested agent gets parentId and depth', () => {
  const list = readSubagents(fx('nested'), { sessionEnded: false });
  const kid = list.find((a) => a.depth === 2);
  assert.equal(kid.parentId, 'a-parent');
  assert.equal(list.find((a) => a.depth === 1).parentId, null);
});

test('feed returns last steps and final report; tolerates a torn last line', () => {
  const f = readSubagentFeed(fx('basic'), 'a-finished-1', 20);
  assert.ok(f.steps.length > 0 && f.steps.length <= 20);
  assert.match(f.report, /^.{1,400}$/s);
  assert.match(f.report, /^Approved: /);
  assert.equal(readSubagentFeed(fx('basic'), 'a-running', 20).report, null, 'no report while running');
  assert.equal(readSubagentFeed(fx('basic'), 'a-finished-2', 20).report, 'It is in src/hub.js.');
  assert.doesNotThrow(() => readSubagentFeed(fx('torn'), 'a-torn', 20));
});

test('missing subagents folder returns []', () => {
  assert.deepEqual(readSubagents('/nonexistent', { sessionEnded: false }), []);
});

test('a cancelled agent is not running', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-'));
  fs.mkdirSync(path.join(dir, 'subagents'));
  fs.writeFileSync(path.join(dir, 'subagents', 'agent-x.meta.json'),
    JSON.stringify({ agentType: 'a', description: 'd', spawnDepth: 1, stoppedByUser: true }));
  assert.equal(readSubagents(dir, { sessionEnded: false })[0].running, false);
});

test('subagentCounts splits running from finished', async () => {
  const { subagentCounts } = await import('../src/sessions/subagents.js');
  assert.deepEqual(subagentCounts(readSubagents(fx('basic'), { sessionEnded: false })), { running: 1, finished: 2 });
  assert.deepEqual(subagentCounts([]), { running: 0, finished: 0 });
});

test('a long first prompt still gives the start time', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-'));
  fs.mkdirSync(path.join(dir, 'subagents'));
  fs.writeFileSync(path.join(dir, 'subagents', 'agent-long.meta.json'), JSON.stringify({ agentType: 'a', description: 'd', spawnDepth: 1, finished: true }));
  fs.writeFileSync(path.join(dir, 'subagents', 'agent-long.jsonl'),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(20000) }, timestamp: '2026-11-02T09:00:00.000Z' }) + '\n' +
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, timestamp: '2026-11-02T09:05:00.000Z' }) + '\n');
  assert.equal(readSubagents(dir, { sessionEnded: false })[0].startedTs, Date.parse('2026-11-02T09:00:00.000Z'));
});

// listSubagentMetas and readSubagentReport: the digest's cheap reads (metas only, one tail for a finished agent's report).
function tmpSession(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-'));
  fs.mkdirSync(path.join(dir, 'subagents'));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, 'subagents', name), text);
  return dir;
}
const asstText = (text) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n';

test('metas list oldest first; a report only once finished, cut to the asked length', () => {
  assert.deepEqual(listSubagentMetas(fx('basic')).map((m) => m.finished).sort(), [false, true, true]);
  assert.equal(readSubagentReport(fx('basic'), 'a-running', 300), null);
  assert.ok(readSubagentReport(fx('basic'), 'a-finished-1', 10).length <= 10);
});

test('a meta carries its id, description, type, flags and mtime, and the list is ordered by mtime then id', () => {
  const dir = tmpSession({
    'agent-b.meta.json': JSON.stringify({ agentType: 'Explore', description: 'Second', finished: true }),
    'agent-a.meta.json': JSON.stringify({ agentType: 'general-purpose', description: 'First', stoppedByUser: true }),
    'agent-c.meta.json': JSON.stringify({ agentType: 'x', description: 'Tie' }),
    'agent-d.meta.json': JSON.stringify({ agentType: 'x', description: 'Oldest' }),
  });
  const set = (id, sec) => fs.utimesSync(path.join(dir, 'subagents', `agent-${id}.meta.json`), sec, sec);
  set('d', 1000); set('a', 2000); set('b', 3000); set('c', 3000);
  assert.deepEqual(listSubagentMetas(dir), [
    { id: 'd', description: 'Oldest', agentType: 'x', finished: false, stoppedByUser: false, mtimeMs: 1000000 },
    { id: 'a', description: 'First', agentType: 'general-purpose', finished: false, stoppedByUser: true, mtimeMs: 2000000 },
    { id: 'b', description: 'Second', agentType: 'Explore', finished: true, stoppedByUser: false, mtimeMs: 3000000 },
    { id: 'c', description: 'Tie', agentType: 'x', finished: false, stoppedByUser: false, mtimeMs: 3000000 },
  ]);
});

test('listSubagentMetas tolerates a missing folder, a meta that is not JSON or not an object, and odd field types', () => {
  assert.deepEqual(listSubagentMetas('/nonexistent'), []);
  const dir = tmpSession({
    'agent-bad.meta.json': '{"description": "torn',
    'agent-empty.meta.json': '',
    'agent-list.meta.json': '[1, 2]',
    'agent-null.meta.json': 'null',
    'agent-num.meta.json': '7',
    'agent-odd.meta.json': JSON.stringify({ description: { x: 1 }, agentType: 5, finished: 'yes', stoppedByUser: 0 }),
    'agent-ok.meta.json': JSON.stringify({ description: 'fine', agentType: 'a', finished: true }),
    'notes.txt': 'not an agent', 'agent-x.jsonl': '{}\n', 'agent-.meta.json': '{}',
  });
  const metas = listSubagentMetas(dir);
  assert.deepEqual(metas.map((m) => m.id).sort(), ['odd', 'ok']);
  assert.deepEqual(metas.find((m) => m.id === 'odd'), { id: 'odd', description: '', agentType: '', finished: false, stoppedByUser: false, mtimeMs: metas.find((m) => m.id === 'odd').mtimeMs });
  assert.equal(listSubagentMetas(dir).find((m) => m.id === 'ok').finished, true);
});

test('a folder of thousands of agents lists from the metas alone, quickly, and a huge meta file is skipped', () => {
  const files = {};
  for (let i = 0; i < 3000; i++) files[`agent-n${i}.meta.json`] = JSON.stringify({ agentType: 'a', description: 'd' + i, finished: i % 2 === 0 });
  files['agent-huge.meta.json'] = JSON.stringify({ description: 'x'.repeat(200 * 1024) });
  const dir = tmpSession(files);   // no .jsonl at all: nothing here may need one
  const t0 = performance.now();
  const metas = listSubagentMetas(dir);
  const ms = performance.now() - t0;
  assert.equal(metas.length, 3000);
  assert.equal(metas.filter((m) => m.finished).length, 1500);
  assert.ok(ms < 1500, `listing 3000 metas took ${ms.toFixed(0)} ms`);
});

test('a report comes from the tail only, a handback wins over plain text in its record, is cut to the asked length and needs finished: true', () => {
  const big = asstText('old report') + (JSON.stringify({ type: 'user', message: { role: 'user', content: 'y'.repeat(900 * 1024) } }) + '\n')
    + asstText('The real report. It has two sentences.');
  const dir = tmpSession({
    'agent-big.meta.json': JSON.stringify({ finished: true }), 'agent-big.jsonl': big,
    'agent-hb.meta.json': JSON.stringify({ finished: true }),
    'agent-hb.jsonl': JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'plain words' },
      { type: 'tool_use', id: 't', name: 'SubagentHandback', input: { message: 'Handback text' } }] } }) + '\n',
    'agent-run.meta.json': JSON.stringify({ finished: false }), 'agent-run.jsonl': asstText('still going'),
    'agent-nojsonl.meta.json': JSON.stringify({ finished: true }),
    'agent-nometa.jsonl': asstText('no meta'),
    'agent-torn.meta.json': JSON.stringify({ finished: true }), 'agent-torn.jsonl': asstText('Before the tear') + '{"type":"assistant","message":{"cont',
  });
  const t0 = performance.now();
  assert.equal(readSubagentReport(dir, 'big', 300), 'The real report. It has two sentences.');
  assert.ok(performance.now() - t0 < 200, 'a 900 KB transcript is read from its tail');
  assert.equal(readSubagentReport(dir, 'big', 9), 'The real ');
  assert.equal(readSubagentReport(dir, 'big', 0), '');
  assert.equal(readSubagentReport(dir, 'torn', 300), 'Before the tear');
  assert.equal(readSubagentReport(dir, 'run', 300), null);
  assert.equal(readSubagentReport(dir, 'nojsonl', 300), null);
  assert.equal(readSubagentReport(dir, 'nometa', 300), null);
  assert.equal(readSubagentReport(dir, 'missing', 300), null);
  assert.equal(readSubagentReport('/nonexistent', 'x', 300), null);
  assert.equal(readSubagentReport(dir, 'hb', 300), 'Handback text');
});

test('readSubagentReport refuses an id that is a path', () => {
  const dir = tmpSession({ 'agent-ok.meta.json': JSON.stringify({ finished: true }), 'agent-ok.jsonl': asstText('fine') });
  fs.mkdirSync(path.join(dir, 'other'));
  assert.equal(readSubagentReport(dir, 'ok', 300), 'fine');
  for (const id of ['../other/agent-ok', 'a/b', 'a\\b', '', null, undefined, 5, {}]) assert.equal(readSubagentReport(dir, id, 300), null, String(id));
});
