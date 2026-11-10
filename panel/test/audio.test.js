import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderAudio } from '../src/screens/audio.js';

const hp = (id, name, state, attrs = {}) => ({ entity_id: id, state, attributes: { friendly_name: name, ...attrs } });
function st(states, over = {}) {
  return { daemonConnected: true, ha: { configured: true, status: 'online', url: 'http://ha:8123',
    audio: Object.keys(states), states, optimistic: {}, ...over } };
}

test('the selected HomePod shows title, artist, artwork and volume', () => {
  const html = renderAudio(st({
    'media_player.office': hp('media_player.office', 'Office', 'playing', { media_title: 'Song', media_artist: 'Band', volume_level: 0.3, entity_picture: '/api/media_player_proxy/office?token=x' }),
    'media_player.living': hp('media_player.living', 'Living Room', 'idle', { volume_level: 0.5 }),
  }), { cursor: 0 });
  assert.match(html, /Song/);
  assert.match(html, /Band/);
  assert.match(html, /<img[^>]+src="http:\/\/ha:8123\/api\/media_player_proxy\/office\?token=x"/);
  assert.match(html, /onerror=/, 'a broken artwork hides itself');
  assert.match(html, /avol">30%/);
  assert.match(html, /Living Room/);
  assert.match(html, /50%/);
});

test('no artwork means a placeholder, never an empty img', () => {
  const html = renderAudio(st({ 'media_player.office': hp('media_player.office', 'Office', 'playing', { media_title: 'Song', volume_level: 0.3 }) }), { cursor: 0 });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /aart placeholder/);
});

test('idle, off and standby say Nothing playing', () => {
  for (const s of ['idle', 'off', 'standby']) {
    assert.match(renderAudio(st({ 'media_player.o': hp('media_player.o', 'Office', s, { volume_level: 0.2 }) }), { cursor: 0 }), /Nothing playing/, s);
  }
  assert.match(renderAudio(st({ 'media_player.o': hp('media_player.o', 'Office', 'playing', {}) }), { cursor: 0 }), /Playing/,
    'playing with no metadata still says it is playing');
});

test('an unavailable HomePod says so', () => {
  assert.match(renderAudio(st({ 'media_player.o': hp('media_player.o', 'Office', 'unavailable') }), { cursor: 0 }), /Unavailable/);
});

test('the knob\'s volume shows at once', () => {
  const html = renderAudio(st({ 'media_player.o': hp('media_player.o', 'Office', 'playing', { volume_level: 0.3 }) },
    { optimistic: { 'media_player.o': { level: 44, ts: Date.now() } } }), { cursor: 0 });
  assert.match(html, /avol">44%/);
});
