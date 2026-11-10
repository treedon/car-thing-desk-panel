import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderHome } from '../src/screens/home.js';

const light = (id, name, state = 'on', brightness) => ({ entity_id: id, state, attributes: { friendly_name: name, ...(brightness != null ? { brightness } : {}) } });
function st(over = {}) {
  const states = {
    'light.desk': light('light.desk', 'Desk lamp', 'on', 128),
    'light.arc': light('light.arc', 'Arc floor', 'off'),
    'light.hall': light('light.hall', 'Hall', 'unavailable'),
    'scene.movie': { entity_id: 'scene.movie', state: '2026-11-02T10:00:00', attributes: { friendly_name: 'Movie night' } },
  };
  return {
    daemonConnected: true,
    ha: { configured: true, status: 'online', url: 'http://ha:8123', home: ['light.desk', 'light.arc', 'light.hall', 'scene.movie'], states, optimistic: {} },
    ...over,
  };
}

test('tiles follow the config order, with names and levels', () => {
  const html = renderHome(st(), { cursor: 0, adjusting: false });
  const order = ['Desk lamp', 'Arc floor', 'Hall', 'Movie night'].map((n) => html.indexOf(n));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(html, /50%/);
  assert.match(html, /Off/);
  assert.match(html, /Scene/);
});

test('exactly one tile is selected', () => {
  const html = renderHome(st(), { cursor: 1, adjusting: false });
  assert.equal((html.match(/htile[^"]*selected/g) || []).length, 1);
});

test('an unavailable light says so', () => {
  assert.match(renderHome(st(), { cursor: 0 }), /htile[^"]*unavailable[^>]*>[\s\S]*?Unavailable/);
});

test('not set up, offline and token rejected read as plain lines', () => {
  assert.match(renderHome(st({ ha: { configured: false } }), { cursor: 0 }), /Home Assistant isn't set up\. Run mac-service\/scripts\/ha-discover\.js on the Mac\./);
  assert.match(renderHome(st({ ha: { ...st().ha, status: 'offline' } }), { cursor: 0 }), /Home Assistant offline\. Reconnecting…/);
  assert.match(renderHome(st({ ha: { ...st().ha, status: 'unauthorized' } }), { cursor: 0 }), /Home Assistant token rejected\. Make a new one\./);
});

test('dim mode shows the selected light large, at its optimistic level', () => {
  const s = st();
  s.ha.optimistic = { 'light.desk': { level: 35, ts: Date.now() } };
  const html = renderHome(s, { cursor: 0, adjusting: true });
  assert.match(html, /hdim/);
  assert.match(html, /hdimpct">35%/);
  assert.match(html, /Desk lamp/);
});

test('a stale optimistic level gives way to Home Assistant\'s', () => {
  const s = st();
  s.ha.optimistic = { 'light.desk': { level: 35, ts: Date.now() - 5000 } };
  assert.match(renderHome(s, { cursor: 0, adjusting: true }), /hdimpct">50%/);
});

test('the knob\'s level shows at once even when the device clock is corrected far from the Mac\'s', async () => {
  const { setServerNow, resetClock } = await import('../src/clock.js');
  for (const skew of [3600_000, -3600_000]) {
    setServerNow(Date.now() + skew);
    const s = st();
    s.ha.optimistic = { 'light.desk': { level: 35, ts: Date.now() } };
    assert.match(renderHome(s, { cursor: 0, adjusting: true }), /hdimpct">35%/, `skew ${skew}`);
    s.ha.optimistic = { 'light.desk': { level: 35, ts: Date.now() - 5000 } };
    assert.match(renderHome(s, { cursor: 0, adjusting: true }), /hdimpct">50%/, `stale gives way, skew ${skew}`);
  }
  resetClock();
});
