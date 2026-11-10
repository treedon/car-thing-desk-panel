// The panel's Home Assistant connection, against a mock HA speaking the same
// WebSocket protocol (auth, get_states, subscribe_events, call_service, ping).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createHaClient } from '../src/ha/client.js';
import { startMockHa } from '../../simulator/src/mock-ha.js';

const STATES = [
  { entity_id: 'light.desk', state: 'on', attributes: { friendly_name: 'Desk', brightness: 128 } },
  { entity_id: 'media_player.office', state: 'playing', attributes: { friendly_name: 'Office', volume_level: 0.3 } },
];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await wait(10); }
  return false;
}

function client(mock, over = {}) {
  const statuses = [];
  const changes = [];
  const c = createHaClient({ url: mock.url, token: over.token || 'good', WebSocketImpl: WebSocket, backoffBaseMs: 30, ...over });
  c.on('status', (s) => statuses.push(s));
  c.on('state', (id, s) => changes.push([id, s]));
  return { c, statuses, changes };
}

test('auth ok: online, with every state loaded', async () => {
  const mock = await startMockHa({ token: 'good', states: STATES });
  const { c, statuses } = client(mock);
  c.start();
  try {
    assert.ok(await until(() => statuses.includes('online')));
    assert.equal(statuses[0], 'connecting');
    assert.equal(c.states()['light.desk'].attributes.brightness, 128);
  } finally { c.stop(); await mock.close(); }
});

test('a wrong token is unauthorized and is not retried', async () => {
  const mock = await startMockHa({ token: 'good', states: STATES });
  const { c, statuses } = client(mock, { token: 'bad' });
  c.start();
  try {
    assert.ok(await until(() => statuses.includes('unauthorized')));
    const connectsBefore = mock.connections();
    await wait(300);
    assert.equal(mock.connections(), connectsBefore, 'no reconnect attempts');
  } finally { c.stop(); await mock.close(); }
});

test('a state change reaches on(state); a removed entity arrives as null', async () => {
  const mock = await startMockHa({ token: 'good', states: STATES });
  const { c, statuses, changes } = client(mock);
  c.start();
  try {
    await until(() => statuses.includes('online'));
    await wait(50);
    mock.setState('light.desk', { entity_id: 'light.desk', state: 'off', attributes: { friendly_name: 'Desk' } });
    assert.ok(await until(() => changes.some(([id, s]) => id === 'light.desk' && s && s.state === 'off')));
    mock.setState('light.desk', null);
    assert.ok(await until(() => changes.some(([id, s]) => id === 'light.desk' && s === null)));
    assert.equal(c.states()['light.desk'], undefined);
  } finally { c.stop(); await mock.close(); }
});

test('callService resolves and the mock records it', async () => {
  const mock = await startMockHa({ token: 'good', states: STATES });
  const { c, statuses } = client(mock);
  c.start();
  try {
    await until(() => statuses.includes('online'));
    await c.callService('light', 'turn_on', { brightness_pct: 40 }, { entity_id: 'light.desk' });
    assert.deepEqual(mock.calls.at(-1), { domain: 'light', service: 'turn_on', service_data: { brightness_pct: 40 }, target: { entity_id: 'light.desk' } });
    assert.ok(await until(() => c.states()['light.desk'].attributes.brightness === 102), 'the mock applied it');
  } finally { c.stop(); await mock.close(); }
});

test('the server going away is offline, then online again on its own', async () => {
  const mock = await startMockHa({ token: 'good', states: STATES });
  const port = mock.port;
  const { c, statuses } = client(mock);
  c.start();
  let again;
  try {
    await until(() => statuses.includes('online'));
    await mock.close();
    assert.ok(await until(() => statuses.at(-1) === 'offline' || statuses.at(-1) === 'connecting'));
    again = await startMockHa({ token: 'good', states: STATES, port });
    assert.ok(await until(() => statuses.at(-1) === 'online', 4000));
    assert.ok(statuses.includes('offline'));
  } finally { c.stop(); if (again) await again.close(); }
});

test('a silent connection is dropped and reconnected', async () => {
  const mock = await startMockHa({ token: 'good', states: STATES });
  const { c, statuses } = client(mock, { pingMs: 40, silenceMs: 120 });
  c.start();
  try {
    await until(() => statuses.includes('online'));
    mock.freeze(true);
    assert.ok(await until(() => statuses.includes('offline'), 1500));
    mock.freeze(false);
    assert.ok(await until(() => statuses.at(-1) === 'online', 3000));
  } finally { c.stop(); await mock.close(); }
});

test('after a rejected token, a new token and start() reconnect', async () => {
  const mock = await startMockHa({ token: 'good', states: STATES });
  const { c, statuses } = client(mock, { token: 'old' });
  c.start();
  try {
    assert.ok(await until(() => statuses.includes('unauthorized')));
    c.setToken('good');
    c.start();
    assert.ok(await until(() => statuses.at(-1) === 'online'));
  } finally { c.stop(); await mock.close(); }
});

test('after an HA restart: changes made while it was down are loaded, and live updates resume', async () => {
  const mock = await startMockHa({ token: 'good', states: STATES });
  const port = mock.port;
  const { c, statuses, changes } = client(mock);
  c.start();
  let again;
  try {
    await until(() => statuses.includes('online'));
    await mock.close();
    await until(() => statuses.at(-1) !== 'online');
    // While HA was down, the desk light was switched off elsewhere.
    const restarted = [{ ...STATES[0], state: 'off', attributes: { friendly_name: 'Desk' } }, STATES[1]];
    again = await startMockHa({ token: 'good', states: restarted, port });
    assert.ok(await until(() => statuses.at(-1) === 'online', 4000));
    assert.ok(await until(() => c.states()['light.desk'] && c.states()['light.desk'].state === 'off'), 'states reloaded');
    assert.ok(changes.some(([id, s]) => id === 'light.desk' && s && s.state === 'off'), 'the screen hears the reloaded state');
    await wait(50);
    again.setState('media_player.office', { ...STATES[1], state: 'paused' });
    assert.ok(await until(() => changes.some(([id, s]) => id === 'media_player.office' && s && s.state === 'paused')), 'subscribed again');
  } finally { c.stop(); if (again) await again.close(); }
});
