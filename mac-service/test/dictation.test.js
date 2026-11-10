// Dictation stays on the Mac: ffmpeg converts the panel's recording to 16 kHz
// mono WAV, whisper.cpp transcribes it, and both temp files are deleted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { transcribe } from '../src/dictation.js';

function setup({ whisperOut = '  Use React.\n', whisperErr = null, wavBytes = 32000 * 3 } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dict-'));
  const model = path.join(tmpDir, 'ggml-base.en.bin');
  fs.writeFileSync(model, 'model');
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'ffmpeg') {
      fs.writeFileSync(args[args.length - 1], Buffer.alloc(wavBytes));
      return { stdout: '' };
    }
    if (whisperErr) throw whisperErr;
    return { stdout: whisperOut };
  };
  const leftovers = () => fs.readdirSync(tmpDir).filter((f) => f !== 'ggml-base.en.bin');
  return { tmpDir, model, calls, run, leftovers };
}

test('transcribe runs ffmpeg then whisper and returns trimmed text', async () => {
  const s = setup();
  const text = await transcribe(Buffer.from('webm'), 'audio/webm;codecs=opus', { run: s.run, model: s.model, tmpDir: s.tmpDir });
  assert.equal(text, 'Use React.');
  assert.equal(s.calls[0][0], 'ffmpeg');
  assert.deepEqual(s.calls[0][1].slice(-5, -1), ['-ar', '16000', '-ac', '1']);
  assert.equal(s.calls[1][0], 'whisper-cli');
  const w = s.calls[1][1];
  assert.equal(w[w.indexOf('-m') + 1], s.model);
  assert.equal(w[w.indexOf('-f') + 1], s.calls[0][1][s.calls[0][1].length - 1], 'whisper reads the WAV ffmpeg wrote');
  assert.ok(w.includes('-nt') && w.includes('-np'));
  assert.deepEqual(s.leftovers(), [], 'audio is deleted after transcription');
});

test('a WAV recording (the Car Thing recorder) is not converted onto itself', async () => {
  const s = setup();
  await transcribe(Buffer.from('RIFF'), 'audio/wav', { run: s.run, model: s.model, tmpDir: s.tmpDir });
  const a = s.calls[0][1];
  assert.notEqual(a[a.indexOf('-i') + 1], a[a.length - 1], 'ffmpeg refuses to write its own input');
  assert.deepEqual(s.leftovers(), []);
});

test('multi-line output joins into one line; a blank-audio marker is no text', async () => {
  const s = setup({ whisperOut: ' First part,\n second part.\n' });
  assert.equal(await transcribe(Buffer.from('x'), 'audio/webm', { run: s.run, model: s.model, tmpDir: s.tmpDir }), 'First part, second part.');
  const b = setup({ whisperOut: ' [BLANK_AUDIO]\n' });
  assert.equal(await transcribe(Buffer.from('x'), 'audio/webm', { run: b.run, model: b.model, tmpDir: b.tmpDir }), '');
});

test('temp files are removed even when whisper fails', async () => {
  const s = setup({ whisperErr: Object.assign(new Error('boom'), { code: 1 }) });
  await assert.rejects(transcribe(Buffer.from('x'), 'audio/webm', { run: s.run, model: s.model, tmpDir: s.tmpDir }), /transcription-failed/);
  assert.deepEqual(s.leftovers(), []);
});

test('missing whisper binary -> dictation-not-set-up', async () => {
  const s = setup({ whisperErr: Object.assign(new Error('spawn whisper-cli ENOENT'), { code: 'ENOENT' }) });
  await assert.rejects(transcribe(Buffer.from('x'), 'audio/webm', { run: s.run, model: s.model, tmpDir: s.tmpDir }), /dictation-not-set-up/);
});

test('missing model -> dictation-not-set-up, before anything runs', async () => {
  const s = setup();
  await assert.rejects(transcribe(Buffer.from('x'), 'audio/webm', { run: s.run, model: '/nope/model.bin', tmpDir: s.tmpDir }), /dictation-not-set-up/);
  assert.equal(s.calls.length, 0);
});

test('over 2 MB -> too-long', async () => {
  const s = setup();
  await assert.rejects(transcribe(Buffer.alloc(2 * 1024 * 1024 + 1), 'audio/webm', { run: s.run, model: s.model, tmpDir: s.tmpDir }), /too-long/);
  assert.equal(s.calls.length, 0);
});

test('over 30 seconds of audio -> too-long, and nothing is left behind', async () => {
  const s = setup({ wavBytes: 32000 * 31 + 44 });
  await assert.rejects(transcribe(Buffer.from('x'), 'audio/webm', { run: s.run, model: s.model, tmpDir: s.tmpDir }), /too-long/);
  assert.equal(s.calls.length, 1, 'whisper never runs');
  assert.deepEqual(s.leftovers(), []);
});
