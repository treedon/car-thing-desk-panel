import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serviceWsUrl, readConfig } from '../src/config.js';

test('url without token', () => {
  assert.equal(serviceWsUrl({ serviceUrl: 'ws://localhost:8790/ws', token: '' }), 'ws://localhost:8790/ws');
});

test('url with token is encoded', () => {
  assert.equal(serviceWsUrl({ serviceUrl: 'ws://192.168.1.20:8790/ws', token: 'a b' }), 'ws://192.168.1.20:8790/ws?token=a%20b');
});

test('missing config falls back to the local Mac service', () => {
  assert.deepEqual(readConfig(undefined), { serviceUrl: 'ws://localhost:8790/ws', token: '', ha: null, recorder: null, tasks: null, nucboxSessions: null });
  assert.deepEqual(readConfig({ token: 't' }), { serviceUrl: 'ws://localhost:8790/ws', token: 't', ha: null, recorder: null, tasks: null, nucboxSessions: null });
});

test('the Home Assistant settings pass through, null when absent', () => {
  assert.equal(readConfig({}).ha, null);
  const ha = { url: 'http://h:8123', token: 't', home: [], audio: [] };
  assert.deepEqual(readConfig({ ha }).ha, ha);
});

test('parsePanelConfig reads the config script the panel was served', async () => {
  const { parsePanelConfig } = await import('../src/config.js');
  assert.deepEqual(parsePanelConfig('window.PANEL_CONFIG = {"serviceUrl":"ws://x/ws","token":"","ha":{"url":"http://h","token":"t2"}};\n').ha.token, 't2');
  assert.equal(parsePanelConfig('garbage'), null);
});

test('the device recorder address passes through', () => {
  assert.equal(readConfig({ recorder: 'http://127.0.0.1:8095' }).recorder, 'http://127.0.0.1:8095');
});
