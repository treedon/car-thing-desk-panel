// The minor findings from the Plan 3 review, each pinned before its fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderAudio } from '../src/screens/audio.js';
import { nucboxStatus } from '../src/nucbox.js';
import { haServiceFor, relevantEntity, nextVolumeFrom } from '../src/ha/entities.js';

test('a Home tile is pressed with its own domain\'s service', () => {
  assert.deepEqual(haServiceFor('light.desk'), ['light', 'toggle']);
  assert.deepEqual(haServiceFor('switch.fan'), ['switch', 'toggle']);
  assert.deepEqual(haServiceFor('scene.evening'), ['scene', 'turn_on']);
  assert.deepEqual(haServiceFor('input_boolean.guest'), ['input_boolean', 'toggle']);
  assert.deepEqual(haServiceFor('script.goodnight'), ['script', 'turn_on']);
});

test('only entities on a screen wake the panel', () => {
  const ha = { home: ['light.desk'], audio: ['media_player.office'], nucbox: { cpuLoad: 'sensor.cpu', memory: 'sensor.mem', gpuLoad: 'sensor.gpu', gpuMemory: null, temps: ['sensor.t'] } };
  assert.equal(relevantEntity(ha, 'light.desk'), true);
  assert.equal(relevantEntity(ha, 'media_player.office'), true);
  assert.equal(relevantEntity(ha, 'sensor.t'), true);
  assert.equal(relevantEntity(ha, 'sensor.kitchen_power'), false);
});

test('a HomePod with no known volume ignores the knob instead of jumping to 2%', () => {
  assert.equal(nextVolumeFrom(null, 1), null);
  assert.equal(nextVolumeFrom(30, 1), 32);
});

test('Audio with no speakers chosen draws no nameless card, even while HA is offline', () => {
  const html = renderAudio({ daemonConnected: true, ha: { configured: true, status: 'offline', audio: [], states: {}, optimistic: {} } }, { cursor: 0 });
  assert.doesNotMatch(html, /ahero/);
  assert.match(html, /Home Assistant offline/);
});

test('a GPU-only outage is named on the NucBox view', () => {
  const cfg = { lmstudio: 'http://n:1234', cpuLoad: 'sensor.cpu', memory: 'sensor.mem', gpuLoad: 'sensor.gpu', gpuMemory: null, temps: [], busyGpuPct: 40 };
  const ok = (v) => ({ state: String(v), attributes: {} });
  const s = nucboxStatus({ lm: { status: 'ok', models: ['m'] }, states: { 'sensor.cpu': ok(10), 'sensor.mem': ok(20), 'sensor.gpu': { state: 'unavailable', attributes: {} } }, cfg, haStatus: 'online' });
  assert.ok(s.missing.includes('GPU reading unavailable'));
});
