import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderDictate, dictationErrorText, recordingMime } from '../src/screens/dictate-review.js';

const base = { daemonConnected: true };

test('ready: says how to talk', () => {
  const html = renderDictate(base, { title: 'Your answer', phase: 'ready' });
  assert.match(html, /Your answer/);
  assert.match(html, /Hold the top button and speak/);
});

test('recording: a live mic and the seconds so far', () => {
  const html = renderDictate(base, { title: 'Your answer', phase: 'recording', seconds: 7 });
  assert.match(html, /dmic live/);
  assert.match(html, /0:07/);
  assert.match(html, /stops at 0:30/);
});

test('transcribing says so', () => {
  assert.match(renderDictate(base, { title: 't', phase: 'transcribing' }), /Transcribing…/);
});

test('review: the text large, then Send, Say it again, Cancel', () => {
  const html = renderDictate(base, { title: 't', phase: 'review', text: 'Use <b>React</b>.' });
  assert.match(html, /dtext">Use &lt;b&gt;React&lt;\/b&gt;\./);
  const send = html.indexOf('Send'), again = html.indexOf('Say it again'), cancel = html.indexOf('Cancel');
  assert.ok(send > 0 && send < again && again < cancel);
});

test('an empty transcription asks to try again instead of offering Send', () => {
  const html = renderDictate(base, { title: 't', phase: 'review', text: '' });
  assert.match(html, /Didn't catch that/);
  assert.doesNotMatch(html, />Send</);
});

test('errors read as plain reasons', () => {
  assert.equal(dictationErrorText('dictation-not-set-up'), "Dictation isn't set up on the Mac yet. Run mac-service/scripts/setup-dictation.sh.");
  assert.equal(dictationErrorText('too-long'), 'That was over 30 seconds. Try a shorter answer.');
  assert.equal(dictationErrorText('no-microphone'), 'No microphone was found.');
  assert.match(dictationErrorText('anything-else'), /couldn't transcribe/i);
  const html = renderDictate(base, { title: 't', phase: 'error', error: 'too-long' });
  assert.match(html, /over 30 seconds/);
});

test('recordingMime prefers webm/opus and falls back', () => {
  assert.equal(recordingMime((m) => m === 'audio/webm;codecs=opus'), 'audio/webm;codecs=opus');
  assert.equal(recordingMime((m) => m === 'audio/webm'), 'audio/webm');
  assert.equal(recordingMime(() => false), '');
});

// ---- the flow, with a fake host ----------------------------------------------

import * as flow from '../src/screens/dictate-review.js';

function fakeHost(over = {}) {
  const h = {
    shown: 0, updates: 0, aborted: 0,
    show() { h.shown++; }, update() { h.updates++; },
    record: {
      start: over.start || (() => Promise.resolve()),
      stop: () => Promise.resolve({ blob: 'b', mime: 'audio/webm' }),
      abort: () => { h.aborted++; },
    },
    transcribe: over.transcribe || (() => Promise.resolve('Use React.')),
    micTimeoutMs: over.micTimeoutMs,
  };
  flow.setDictateHost(h);
  return h;
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test('a microphone that never answers ends in an error, not endless listening', async () => {
  const h = fakeHost({ start: () => new Promise(() => {}), micTimeoutMs: 30 });
  flow.openDictateReview({ title: 't', onSend() {}, onCancel() {} }, true);
  assert.equal(flow.getDictation().phase, 'recording');
  await tick(60);
  assert.equal(flow.getDictation().phase, 'error');
  assert.equal(flow.getDictation().error, 'mic-timeout');
  assert.match(flow.dictationErrorText('mic-timeout'), /microphone/i);
  flow.cancelDictation();
  assert.ok(h.aborted >= 0);
});

test('hold, release, review, send: the text reaches onSend once', async () => {
  fakeHost();
  let sent = null;
  flow.openDictateReview({ title: 't', onSend(t) { sent = t; }, onCancel() {} }, true);
  await tick(5);
  // Released before a second passed: still transcribed.
  flow.endTalk();
  await tick(5);
  assert.equal(flow.getDictation().phase, 'review');
  assert.equal(flow.getDictation().text, 'Use React.');
  flow.sendDictation();
  assert.equal(sent, 'Use React.');
  assert.equal(flow.getDictation(), null);
});

// ---- a note under the text, and opening on a text already said ------------------------

test('dictation review shows the note and can open on a given text', () => {
  fakeHost();
  flow.openDictateReview({ title: 't', note: 'MIRROR · AUTO MODE', text: 'fix it', onSend() {}, onCancel() {} });
  assert.equal(flow.getDictation().phase, 'review');
  assert.equal(flow.getDictation().text, 'fix it');
  const html = renderDictate(base, flow.getDictation());
  assert.match(html, /fix it/);
  assert.match(html, /MIRROR · AUTO MODE/);
  assert.match(html, /data-action="dict-send"/, 'Send is offered');
  flow.cancelDictation();
});

test('the note is escaped, and absent when none was given', () => {
  assert.doesNotMatch(renderDictate(base, { title: 't', phase: 'review', text: 'hi' }), /dnote/);
  const html = renderDictate(base, { title: 't', phase: 'review', text: 'hi', note: '<b>X</b>' });
  assert.ok(!html.includes('<b>X'));
  assert.match(html, /&lt;b&gt;X/);
});

test('the note belongs to the check, not to the listening or the error screens', () => {
  for (const phase of ['ready', 'recording', 'transcribing', 'error']) {
    assert.doesNotMatch(renderDictate(base, { title: 't', phase, note: 'MIRROR · AUTO MODE', error: 'x' }), /MIRROR · AUTO MODE/, phase);
  }
});

test('a dictation opened on a text sends that text, and saying it again replaces it', async () => {
  fakeHost();
  let sent = null;
  flow.openDictateReview({ title: 't', text: 'fix it', onSend(t) { sent = t; }, onCancel() {} });
  flow.sendDictation();
  assert.equal(sent, 'fix it');
  assert.equal(flow.getDictation(), null);

  flow.openDictateReview({ title: 't', text: 'fix it', onSend(t) { sent = t; }, onCancel() {} });
  flow.beginTalk();
  await tick(5);
  flow.endTalk();
  await tick(5);
  assert.equal(flow.getDictation().text, 'Use React.');
  flow.sendDictation();
  assert.equal(sent, 'Use React.');
});

test('an empty given text opens on the listening screen as before', () => {
  fakeHost();
  flow.openDictateReview({ title: 't', text: '   ', onSend() {}, onCancel() {} });
  assert.equal(flow.getDictation().phase, 'ready');
  assert.equal(flow.getDictation().text, '');
  flow.cancelDictation();
});
