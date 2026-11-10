// The simulator's made-up home for SIM_DEMO=1: a mock Home Assistant (lights,
// scenes, HomePods, NucBox sensors) on 8124 and a mock LM Studio on 8125. The
// NucBox's GPU load swings between idle and busy every 20 s.
import http from 'node:http';
import { startMockHa } from './mock-ha.js';

const HA_PORT = 8124;
const LM_PORT = 8125;

const light = (id, name, on, pct) => ({ entity_id: id, state: on ? 'on' : 'off',
  attributes: { friendly_name: name, ...(on && pct != null ? { brightness: Math.round(pct * 2.55) } : {}) } });
const sensor = (id, name, v, unit) => ({ entity_id: id, state: String(v), attributes: { friendly_name: name, unit_of_measurement: unit } });
const art = (hue) => 'data:image/svg+xml;utf8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="hsl(${hue},45%,40%)"/><circle cx="100" cy="100" r="54" fill="hsl(${hue},55%,62%)"/></svg>`);

const STATES = [
  light('light.desk', 'Desk lamp', true, 70), light('light.arc', 'Arc floor lamp', false),
  light('light.office_ceiling', 'Office ceiling', true, 100), light('light.hall', 'Hallway', false),
  light('light.kitchen', 'Kitchen pendants', true, 45), light('light.counter', 'Under-counter', false),
  light('light.living', 'Living room', true, 30), light('light.reading', 'Reading chair', false),
  light('light.bedroom', 'Bedroom', false), light('light.porch', 'Porch', true, 100),
  light('light.stairs', 'Stairs', false), { entity_id: 'light.garage', state: 'unavailable', attributes: { friendly_name: 'Garage' } },
  { entity_id: 'scene.focus', state: 'scening', attributes: { friendly_name: 'Focus' } },
  { entity_id: 'scene.movie', state: 'scening', attributes: { friendly_name: 'Movie night' } },
  { entity_id: 'scene.dinner', state: 'scening', attributes: { friendly_name: 'Dinner' } },
  { entity_id: 'scene.all_off', state: 'scening', attributes: { friendly_name: 'All off' } },
  { entity_id: 'media_player.office', state: 'playing', attributes: { friendly_name: 'Office HomePod', model: 'HomePod mini',
    media_title: 'Weightless', media_artist: 'Marconi Union', volume_level: 0.32, entity_picture: art(200) } },
  { entity_id: 'media_player.living', state: 'paused', attributes: { friendly_name: 'Living Room', model: 'HomePod',
    media_title: 'The Daily', media_artist: 'The New York Times', volume_level: 0.5, entity_picture: art(20) } },
  { entity_id: 'media_player.kitchen', state: 'idle', attributes: { friendly_name: 'Kitchen', model: 'HomePod mini', volume_level: 0.2 } },
  sensor('sensor.nucbox_cpu', 'NucBox CPU Total', 18, '%'), sensor('sensor.nucbox_mem', 'NucBox Memory', 58, '%'),
  sensor('sensor.nucbox_gpu', 'NucBox GPU Core', 6, '%'), sensor('sensor.nucbox_vram', 'NucBox GPU Memory', 71, '%'),
  sensor('sensor.nucbox_cpu_temp', 'CPU Package', 54, '°C'), sensor('sensor.nucbox_gpu_temp', 'GPU Core', 49, '°C'),
];

export async function startDemoHouse() {
  const ha = await startMockHa({ port: HA_PORT, token: 'demo', states: STATES });
  const lm = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ data: [
      { id: 'qwen3-30b-a3b', type: 'llm', state: 'loaded' },
      { id: 'nomic-embed-text', type: 'embeddings', state: 'loaded' },
      { id: 'gemma-3-12b', type: 'vlm', state: 'not-loaded' },
    ] }));
  });
  await new Promise((r) => lm.listen(LM_PORT, '127.0.0.1', r));
  let busy = false;
  setInterval(() => {
    busy = !busy;
    ha.setState('sensor.nucbox_gpu', sensor('sensor.nucbox_gpu', 'NucBox GPU Core', busy ? 87 : 6, '%'));
    ha.setState('sensor.nucbox_gpu_temp', sensor('sensor.nucbox_gpu_temp', 'GPU Core', busy ? 71 : 49, '°C'));
  }, 20_000).unref();
  return {
    url: ha.url, token: 'demo',
    home: STATES.filter((s) => /^(light|scene)\./.test(s.entity_id)).map((s) => s.entity_id),
    audio: ['media_player.office', 'media_player.living', 'media_player.kitchen'],
    nucbox: {
      lmstudio: `http://127.0.0.1:${LM_PORT}`, cpuLoad: 'sensor.nucbox_cpu', memory: 'sensor.nucbox_mem',
      gpuLoad: 'sensor.nucbox_gpu', gpuMemory: 'sensor.nucbox_vram',
      temps: ['sensor.nucbox_cpu_temp', 'sensor.nucbox_gpu_temp'], busyGpuPct: 40,
    },
  };
}
