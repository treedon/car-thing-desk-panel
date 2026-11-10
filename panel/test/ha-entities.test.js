import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAvailable, lightLevel, nextLevel, volumePct, nextVolume, nowPlaying, createThrottle } from '../src/ha/entities.js';

const s = (state, attributes = {}) => ({ entity_id: 'x.y', state, attributes });

test('availability', () => {
  assert.equal(isAvailable(null), false);
  assert.equal(isAvailable(s('unavailable')), false);
  assert.equal(isAvailable(s('unknown')), false);
  assert.equal(isAvailable(s('on')), true);
});

test('light level: off is 0, on without brightness is 100, else the brightness as %', () => {
  assert.equal(lightLevel(s('off', { brightness: 200 })), 0);
  assert.equal(lightLevel(s('on')), 100);
  assert.equal(lightLevel(s('on', { brightness: 128 })), 50);
  assert.equal(lightLevel(s('unavailable')), 0);
});

test('nextLevel and nextVolume step and clamp', () => {
  assert.equal(nextLevel(50, 1), 55);
  assert.equal(nextLevel(98, 1), 100);
  assert.equal(nextLevel(3, -1), 0);
  assert.equal(nextVolume(30, 1), 32);
  assert.equal(nextVolume(1, -1), 0);
});

test('volume % or null when the speaker says nothing', () => {
  assert.equal(volumePct(s('playing', { volume_level: 0.305 })), 31);
  assert.equal(volumePct(s('playing')), null);
  assert.equal(volumePct(null), null);
});

test('now playing: title, artist, artwork from HA, and playing state', () => {
  const np = nowPlaying(s('playing', { media_title: 'Song', media_artist: 'Band', entity_picture: '/api/media_player_proxy/x?token=abc' }), 'http://ha:8123');
  assert.deepEqual(np, { title: 'Song', artist: 'Band', art: 'http://ha:8123/api/media_player_proxy/x?token=abc', playing: true });
  assert.deepEqual(nowPlaying(s('idle'), 'http://ha:8123'), { title: '', artist: '', art: null, playing: false });
  assert.equal(nowPlaying(s('playing', { entity_picture: 'https://cdn/x.jpg' }), 'http://ha:8123').art, 'https://cdn/x.jpg');
});

test('throttle: first value at once, then at most one per interval, the last value always lands', () => {
  let t = 0;
  const timers = [];
  const fakeSetTimeout = (fn, ms) => { timers.push({ at: t + ms, fn }); };
  const run = (until) => {
    timers.sort((a, b) => a.at - b.at);
    while (timers.length && timers[0].at <= until) { const x = timers.shift(); t = x.at; x.fn(); }
    t = until;
  };
  const sent = [];
  const th = createThrottle({ intervalMs: 150, now: () => t, setTimeout: fakeSetTimeout });
  // each push lands, then any send that falls due at that same instant runs
  for (let i = 0; i <= 20; i++) { t = i * 15; th.push('light.a', i, (v) => sent.push([t, v])); run(i * 15); }
  run(1000);
  assert.deepEqual(sent.map((x) => x[1]), [0, 10, 20]);
  assert.deepEqual(sent.map((x) => x[0]), [0, 150, 300]);
  const other = [];
  th.push('light.b', 'b', (v) => other.push(v));
  assert.deepEqual(other, ['b'], 'another key is not held back');
});

test('artwork with any URL scheme (data:, https:) is used as given', () => {
  assert.equal(nowPlaying(s('playing', { entity_picture: 'data:image/png;base64,AAAA' }), 'http://ha:8123').art, 'data:image/png;base64,AAAA');
});
