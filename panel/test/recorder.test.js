// On the Car Thing the browser can't reach the microphones, so a small native
// recorder on the device does: POST /start, POST /stop -> audio/wav.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceRecorder } from '../src/device-recorder.js';

function fakeFetch(routes) {
  const calls = [];
  const fn = (url, opts) => {
    calls.push([opts && opts.method, url]);
    const r = routes[url];
    if (!r) return Promise.reject(new Error('down'));
    return Promise.resolve({ ok: r.status < 300, status: r.status, blob: () => Promise.resolve({ type: 'audio/wav', size: 4 }) });
  };
  fn.calls = calls;
  return fn;
}

test('start then stop returns the device WAV', async () => {
  const f = fakeFetch({ 'http://127.0.0.1:8095/start': { status: 204 }, 'http://127.0.0.1:8095/stop': { status: 200 } });
  const rec = createDeviceRecorder('http://127.0.0.1:8095', f);
  await rec.start();
  const out = await rec.stop();
  assert.equal(out.mime, 'audio/wav');
  assert.deepEqual(f.calls, [['POST', 'http://127.0.0.1:8095/start'], ['POST', 'http://127.0.0.1:8095/stop']]);
});

test('a recorder that is already busy, or not running, reads as no microphone', async () => {
  const busy = createDeviceRecorder('http://127.0.0.1:8095', fakeFetch({ 'http://127.0.0.1:8095/start': { status: 409 } }));
  await assert.rejects(busy.start(), /no-microphone/);
  const down = createDeviceRecorder('http://127.0.0.1:8095', fakeFetch({}));
  await assert.rejects(down.start(), /no-microphone/);
});

test('abort stops the recording and ignores the result', async () => {
  const f = fakeFetch({ 'http://127.0.0.1:8095/start': { status: 204 }, 'http://127.0.0.1:8095/stop': { status: 200 } });
  const rec = createDeviceRecorder('http://127.0.0.1:8095', f);
  await rec.start();
  rec.abort();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(f.calls.at(-1), ['POST', 'http://127.0.0.1:8095/stop']);
});
