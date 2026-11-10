import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadHaConfig, suggestHaConfig } from '../src/ha-config.js';

function tmpFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-'));
  const p = path.join(dir, 'ha.json');
  if (content !== undefined) fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
  return p;
}
const st = (entity_id, friendly_name, extra = {}, state = 'on') => ({ entity_id, state, attributes: { friendly_name, ...extra } });

test('a missing file is null; one without url and token is invalid', () => {
  assert.equal(loadHaConfig(tmpFile()), null);
  assert.throws(() => loadHaConfig(tmpFile({})), /ha-config-invalid/);
  assert.throws(() => loadHaConfig(tmpFile('{not json')), /ha-config-invalid/);
});

test('the url is normalised and lists default to empty', () => {
  const c = loadHaConfig(tmpFile({ url: 'http://ha.local:8123/', token: 't' }));
  assert.equal(c.url, 'http://ha.local:8123');
  assert.deepEqual([c.home, c.audio, c.nucbox], [[], [], null]);
});

test('nucbox: missing is null, busyGpuPct defaults to 40, cpuLoad and memory are required', () => {
  const c = loadHaConfig(tmpFile({ url: 'http://h:8123', token: 't', nucbox: { lmstudio: 'http://nucbox:1234', cpuLoad: 'sensor.cpu', memory: 'sensor.mem', temps: [] } }));
  assert.equal(c.nucbox.busyGpuPct, 40);
  assert.equal(c.nucbox.gpuLoad, null);
  assert.throws(() => loadHaConfig(tmpFile({ url: 'http://h:8123', token: 't', nucbox: { cpuLoad: 'sensor.cpu' } })), /ha-config-invalid/);
});

test('nucbox: GPU memory can be read as used of a total, and is not by default', () => {
  // Catches: a used-MB sensor drawn as a percentage ("665%") because the total was dropped.
  const base = { url: 'http://h:8123', token: 't' };
  const nb = { cpuLoad: 'sensor.cpu', memory: 'sensor.mem', gpuMemory: 'sensor.vram_used' };
  assert.equal(loadHaConfig(tmpFile({ ...base, nucbox: { ...nb, gpuMemoryTotal: 'sensor.vram_total' } })).nucbox.gpuMemoryTotal, 'sensor.vram_total');
  assert.equal(loadHaConfig(tmpFile({ ...base, nucbox: nb })).nucbox.gpuMemoryTotal, null);
});

test('nucbox: a temperature can carry a short label, and entries without an entity are dropped', () => {
  // Catches: labelled temperatures thrown away (the long HA name shows) or a bad entry reaching the panel.
  const c = loadHaConfig(tmpFile({ url: 'http://h:8123', token: 't', nucbox: {
    cpuLoad: 'sensor.cpu', memory: 'sensor.mem',
    temps: ['sensor.ssd_temp', { entity: 'sensor.cpu_temp', name: 'CPU' }, { name: 'no entity' }, 5, ''],
  } }));
  assert.deepEqual(c.nucbox.temps, [
    { entity: 'sensor.ssd_temp', name: null },
    { entity: 'sensor.cpu_temp', name: 'CPU' },
  ]);
});

test('suggestHaConfig picks lights then scenes, and HomePods for audio', () => {
  const states = [
    st('light.desk', 'Desk lamp'), st('light.arc', 'Arc floor'), st('light.zz', 'Zebra light'),
    st('scene.movie', 'Movie'), st('scene.bright', 'Bright'),
    st('media_player.office_homepod', 'Office HomePod', { model: 'HomePod mini' }),
    st('media_player.living', 'Living Room', { model: 'HomePod' }),
    st('media_player.apple_tv', 'Apple TV', { model: 'Apple TV 4K' }),
    st('sensor.temp', 'Temperature'),
  ];
  const c = suggestHaConfig(states, { url: 'http://h:8123', token: 't' });
  assert.deepEqual(c.home, ['light.arc', 'light.desk', 'light.zz', 'scene.bright', 'scene.movie']);
  assert.deepEqual(c.audio, ['media_player.living', 'media_player.office_homepod']);
  assert.equal(c.url, 'http://h:8123');
});

test('with no HomePod by name or model, every media player is offered', () => {
  const c = suggestHaConfig([st('media_player.kitchen', 'Kitchen'), st('media_player.den', 'Den')], { url: 'http://h:8123', token: 't' });
  assert.deepEqual(c.audio, ['media_player.den', 'media_player.kitchen']);
});

test('unavailable media players are not suggested for Audio', () => {
  const c = suggestHaConfig([
    { entity_id: 'media_player.bedroom', state: 'idle', attributes: { friendly_name: 'Bedroom' } },
    { entity_id: 'media_player.owntone_output_mirror', state: 'unavailable', attributes: { friendly_name: 'OwnTone output (Mirror)' } },
  ], { url: 'http://h:8123', token: 't' });
  assert.deepEqual(c.audio, ['media_player.bedroom']);
});
