// The transcript tail is the only source that knows a session's permission
// mode — `claude agents --json` carries no such field — so the record shape it
// reads is worth pinning down.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStore } from '../src/sessions/store.js';
import { startTranscriptTail } from '../src/sessions/source-transcript.js';

const settle = () => new Promise((r) => setTimeout(r, 120));

function tmpTranscript(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-thing-tail-'));
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

test('a permission-mode record lands on the session, later ones replace it', async () => {
  const store = createStore();
  const transcriptPath = tmpTranscript([
    { type: 'permission-mode', permissionMode: 'plan', sessionId: 'a' },
  ]);
  const tail = startTranscriptTail({ store, sessionId: 'a', transcriptPath });
  await settle();
  assert.equal(store.get('a').permissionMode, 'plan');

  fs.appendFileSync(transcriptPath,
    JSON.stringify({ type: 'permission-mode', permissionMode: 'bypassPermissions', sessionId: 'a' }) + '\n');
  await settle();
  assert.equal(store.get('a').permissionMode, 'bypassPermissions');
  tail.stop();
});

test('an assistant record\'s effort lands on the session, later ones replace it', async () => {
  const store = createStore();
  const transcriptPath = tmpTranscript([
    { type: 'assistant', effort: 'high', message: { model: 'claude-fable-5' } },
  ]);
  const tail = startTranscriptTail({ store, sessionId: 'a', transcriptPath });
  await settle();
  assert.equal(store.get('a').effort, 'high');

  fs.appendFileSync(transcriptPath,
    JSON.stringify({ type: 'assistant', effort: 'ultrathink', message: {} }) + '\n');
  await settle();
  assert.equal(store.get('a').effort, 'ultrathink');
  tail.stop();
});

test('an interrupt marker reports the interrupt with the line\'s own timestamp', async () => {
  const store = createStore();
  const interrupts = [];
  const transcriptPath = tmpTranscript([
    { type: 'user', timestamp: '2026-08-01T10:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
  ]);
  const tail = startTranscriptTail({
    store, sessionId: 'a', transcriptPath, onInterrupt: (ts) => interrupts.push(ts),
  });
  await settle();
  assert.equal(interrupts.length, 1);
  assert.equal(interrupts[0], Date.parse('2026-08-01T10:00:00.000Z'), 'ts from the line, not the read time');

  fs.appendFileSync(transcriptPath, JSON.stringify({
    type: 'user', timestamp: '2026-08-01T10:05:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] },
  }) + '\n');
  await settle();
  assert.equal(interrupts.length, 2, 'the tool-use flavour of the marker counts too');
  tail.stop();
});

test('ordinary messages never fire the interrupt callback', async () => {
  const store = createStore();
  const interrupts = [];
  const transcriptPath = tmpTranscript([
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Reading queue.js now' }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'please continue' }] } },
  ]);
  const tail = startTranscriptTail({
    store, sessionId: 'a', transcriptPath, onInterrupt: (ts) => interrupts.push(ts),
  });
  await settle();
  assert.equal(interrupts.length, 0);
  tail.stop();
});

test('a mode record is not mistaken for a message and harvested for usage', async () => {
  const store = createStore();
  const transcriptPath = tmpTranscript([
    { type: 'assistant', message: { model: 'claude-opus-5', usage: { input_tokens: 100, output_tokens: 20 } } },
    { type: 'permission-mode', permissionMode: 'auto', sessionId: 'a' },
  ]);
  const tail = startTranscriptTail({ store, sessionId: 'a', transcriptPath });
  await settle();
  const d = store.get('a');
  assert.equal(d.permissionMode, 'auto');
  assert.equal(d.model, 'claude-opus-5', 'the mode record must not blank the model');
  assert.equal(d.tokens.in, 100, 'nor disturb the token counters');
  tail.stop();
});

// ---- titles (plan Task 3) ----------------------------------------------------
// Shapes confirmed against the VS Code extension 2.1.314 bundle:
// {type:"ai-title", aiTitle, sessionId} and {type:"custom-title", customTitle, sessionId}.

function titleTail(lines) {
  const store = createStore();
  store.upsert('s1', { cwd: '/Users/owner/Claude/personal/Spotify_car_thing' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-thing-title-'));
  const transcriptPath = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcriptPath, lines.join('\n') + '\n');
  const tail = startTranscriptTail({ store, sessionId: 's1', transcriptPath });
  return { store, tail };
}

test('ai-title sets the session name', async () => {
  const { store, tail } = titleTail(['{"type":"ai-title","aiTitle":"Mirror-mouse pairing plan","sessionId":"s1"}']);
  try {
    await settle();
    assert.equal(store.get('s1').name, 'Mirror-mouse pairing plan');
  } finally { tail.stop(); }
});

test('custom title beats ai title; latest record wins', async () => {
  const { store, tail } = titleTail([
    '{"type":"ai-title","aiTitle":"First guess","sessionId":"s1"}',
    '{"type":"custom-title","customTitle":"My rename","sessionId":"s1"}',
    '{"type":"ai-title","aiTitle":"Later guess","sessionId":"s1"}',
  ]);
  try {
    await settle();
    assert.equal(store.get('s1').name, 'My rename');
  } finally { tail.stop(); }
});

test('half-written last line is ignored', async () => {
  let r;
  assert.doesNotThrow(() => { r = titleTail(['{"type":"ai-title","aiTi']); });
  try {
    await settle();
    assert.equal(r.store.get('s1').name, 'Spotify_car_thing'); // falls back to project
  } finally { r.tail.stop(); }
});

// ---- which file a session's conversation lives in (plan Task 3b) -------------

test('transcriptFileFor prefers the hook-reported path, else derives from cwd', async () => {
  const { transcriptFileFor } = await import('../src/sessions/tails.js');
  assert.equal(transcriptFileFor('s1', { transcriptPath: '/a/b.jsonl', cwd: '/x' }), '/a/b.jsonl');
  assert.match(transcriptFileFor('s1', { cwd: '/Users/t/My proj' }), /-Users-t-My-proj\/s1\.jsonl$/);
  assert.equal(transcriptFileFor('s1', null), null);
});

test('transcriptCandidates lists the hook-reported path, then the one derived from the cwd', async () => {
  const { transcriptCandidates, transcriptPathFor } = await import('../src/sessions/tails.js');
  // Claude Code moves a transcript into the worktree's project folder when a session enters a worktree,
  // so the path a hook reported can be gone while the one derived from the current cwd is right.
  assert.deepEqual(
    transcriptCandidates('s1', { transcriptPath: '/old/s1.jsonl', cwd: '/Users/t/My proj' }),
    ['/old/s1.jsonl', transcriptPathFor('s1', '/Users/t/My proj')],
  );
  assert.deepEqual(transcriptCandidates('s1', { cwd: '/Users/t/My proj' }), [transcriptPathFor('s1', '/Users/t/My proj')]);
  assert.deepEqual(transcriptCandidates('s1', { transcriptPath: '/old/s1.jsonl' }), ['/old/s1.jsonl']);
  assert.deepEqual(transcriptCandidates('s1', {}), []);
  assert.deepEqual(transcriptCandidates('s1', null), []);
});

// ---- a line caught half-written is read once it is complete (final review I4)

test('a title written in two halves lands once the line is complete', async () => {
  const store = createStore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-thing-torn-'));
  const transcriptPath = path.join(dir, 't.jsonl');
  const line = JSON.stringify({ type: 'ai-title', aiTitle: 'Café menu ✨ redesign', sessionId: 's1' });
  const cut = Buffer.from(line).indexOf(Buffer.from('é')) + 1;   // inside the two-byte é
  fs.writeFileSync(transcriptPath, Buffer.from(line).subarray(0, cut));
  const tail = startTranscriptTail({ store, sessionId: 's1', transcriptPath });
  try {
    await settle();
    fs.appendFileSync(transcriptPath, Buffer.concat([Buffer.from(line).subarray(cut), Buffer.from('\n')]));
    await new Promise((r) => setTimeout(r, 3300));   // the tail's own poll
    assert.equal(store.get('s1').name, 'Café menu ✨ redesign');
  } finally { tail.stop(); }
});
