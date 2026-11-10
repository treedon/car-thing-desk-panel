// Redaction is the digest's first gate: every text fact passes through redact()
// before it is stored, persisted or sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, REDACTED, MAX_INPUT } from '../src/digest/redact.js';
import { SECRETS } from './fixtures/digest/secrets.js';

test('one planted secret of each category never survives', () => {
  for (const [kind, text, needle = text] of SECRETS) {
    const out = redact(`before ${text} after`);
    assert.ok(!out.includes(needle) && out.includes(REDACTED) && out.startsWith('before '), kind);
  }
  assert.equal(redact('API_TOKEN=' + 'hunter2hunter2'), 'API_TOKEN=[redacted]');
});
test('short git shas, paths and ordinary prose pass untouched', () => {
  for (const s of ['fix(panel): 1a2b3c4d5e6f lands', 'mac-service/src/sessions/source-transcript.js',
    'Spotify_car_thing-digest/docs/superpowers/plans', 'the task-notification path', 'ask for tokens in the README'])
    assert.equal(redact(s), s);
});
test('non-strings read as empty', () => { assert.equal(redact(undefined), ''); assert.equal(redact(42), ''); });

test('key/value secrets redact whole in their JSON, spaced and punctuated forms', () => {
  assert.equal(redact('{"password": "' + 'hunter2hunter2' + '"}'), '{"password": [redacted]}');
  assert.equal(redact('password=' + 'p@ss;word123' + ' next'), 'password=[redacted] next');
  assert.equal(redact('PASSWORD="' + 'correct horse battery staple' + '" ok'), 'PASSWORD=[redacted] ok');
  assert.equal(redact('{"title": "digest card", "sessions": 3}'), '{"title": "digest card", "sessions": 3}');
});
// The fastest of three runs, not one: a busy machine (a root `npm test` runs suites in parallel) can stall any
// single run for 100+ ms, but a quadratic rule is slow on every run. A run takes 3-6 ms; the quadratic form of
// rule 5 (unbounded \w* either side of the keyword) took 2.5-4.2 s per keyword, so 250 ms is 40x over normal
// and 10x under the regression.
test('a degenerate run of keywords cannot hold the event loop', () => {
  for (const word of ['key', 'token', 'secret', 'password']) {
    const text = word.repeat(50000);
    let best = Infinity;
    for (let attempt = 0; attempt < 3 && best >= 250; attempt++) {
      const t0 = performance.now();
      redact(text);
      best = Math.min(best, performance.now() - t0);
    }
    assert.ok(best < 250, `${word} x50000 took ${best.toFixed(1)} ms at best of 3`);
  }
});
test('input past the cap is dropped, not scanned: the front is redacted, the tail is gone', () => {
  const early = 'API_TOKEN=' + 'hunter2hunter2', late = 'sk-' + 'ant-' + 'Q7w8'.repeat(6);
  const t0 = performance.now();
  const out = redact(early + ' ' + 'key '.repeat(MAX_INPUT / 4) + ' ' + late);
  const ms = performance.now() - t0;
  assert.ok(ms < 500, `over-cap input took ${ms.toFixed(1)} ms`);
  assert.ok(out.startsWith('API_TOKEN=' + REDACTED) && !out.includes('hunter2hunter2'));
  assert.ok(!out.includes(late) && !out.includes('Q7w8') && out.length <= MAX_INPUT);
});
test('a long identifier ahead of the keyword does not hide its value', () => {
  assert.equal(redact('x'.repeat(60) + '_api_key=' + 'abcd1234efgh'), 'x'.repeat(60) + '_api_key=[redacted]');
});
