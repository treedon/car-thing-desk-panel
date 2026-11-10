import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadedModels, nucboxStatus, createLmPoller } from '../src/nucbox.js';
import { renderNucbox } from '../src/screens/nucbox.js';

const MODELS = { data: [
  { id: 'qwen3-30b-a3b', type: 'llm', state: 'loaded' },
  { id: 'nomic-embed', type: 'embeddings', state: 'loaded' },
  { id: 'gemma-3-12b', type: 'vlm', state: 'not-loaded' },
  { id: 'llama-3.2-3b', type: 'llm', state: 'not-loaded' },
] };
const cfg = { lmstudio: 'http://nucbox:1234', cpuLoad: 'sensor.cpu', memory: 'sensor.mem', gpuLoad: 'sensor.gpu', gpuMemory: null, temps: ['sensor.cpu_temp', 'sensor.gpu_temp'], busyGpuPct: 40 };
const sensor = (id, name, v, unit) => ({ entity_id: id, state: String(v), attributes: { friendly_name: name, unit_of_measurement: unit } });
function states(gpu) {
  return {
    'sensor.cpu': sensor('sensor.cpu', 'CPU Total', 22, '%'),
    'sensor.mem': sensor('sensor.mem', 'Memory', 61, '%'),
    'sensor.gpu': gpu === 'unavailable' ? { entity_id: 'sensor.gpu', state: 'unavailable', attributes: {} } : sensor('sensor.gpu', 'GPU Core', gpu, '%'),
    'sensor.cpu_temp': sensor('sensor.cpu_temp', 'CPU Package', 58, '°C'),
    'sensor.gpu_temp': sensor('sensor.gpu_temp', 'GPU Core', 64, '°C'),
  };
}

test('loadedModels lists loaded language models only', () => {
  assert.deepEqual(loadedModels(MODELS), ['qwen3-30b-a3b']);
  assert.deepEqual(loadedModels({}), []);
});

test('busy needs a loaded model and the GPU at or over the line', () => {
  const lm = { status: 'ok', models: ['qwen3-30b-a3b'] };
  assert.equal(nucboxStatus({ lm, states: states(80), cfg }).busy, 'busy');
  assert.equal(nucboxStatus({ lm, states: states(5), cfg }).busy, 'idle');
  assert.equal(nucboxStatus({ lm: { status: 'ok', models: [] }, states: states(80), cfg }).busy, 'idle');
  assert.equal(nucboxStatus({ lm: { status: 'unreachable', models: [] }, states: states(80), cfg }).busy, 'unknown');
  assert.equal(nucboxStatus({ lm, states: states('unavailable'), cfg }).busy, 'unknown');
});

test('status carries the numbers and names what is missing', () => {
  const s = nucboxStatus({ lm: { status: 'unreachable', models: [] }, states: states(10), cfg });
  assert.equal(s.cpu, 22);
  assert.equal(s.mem, 61);
  assert.deepEqual(s.temps, [{ name: 'CPU Package', c: 58 }, { name: 'GPU Core', c: 64 }]);
  assert.deepEqual(s.missing, ['LM Studio not reachable']);
  const noSensors = nucboxStatus({ lm: { status: 'ok', models: ['m', 'n'] }, states: {}, cfg });
  assert.deepEqual(noSensors.missing, ['NucBox sensors unavailable']);
  assert.equal(noSensors.model, 'm');
  assert.equal(noSensors.extra, 1);
});

test('GPU memory used is shown as a share of the total when a total is configured', () => {
  // Catches: Libre Hardware Monitor's MB reading drawn as a percentage ("665%"), or a divide by nothing.
  const lm = { status: 'ok', models: [] };
  const vram = (used, total) => Object.assign(states(10), {
    'sensor.vram_used': sensor('sensor.vram_used', 'GPU Memory Used', used, 'MB'),
    'sensor.vram_total': total === 'unavailable'
      ? { entity_id: 'sensor.vram_total', state: 'unavailable', attributes: {} }
      : sensor('sensor.vram_total', 'GPU Memory Total', total, 'MB'),
  });
  const withTotal = Object.assign({}, cfg, { gpuMemory: 'sensor.vram_used', gpuMemoryTotal: 'sensor.vram_total' });
  assert.equal(nucboxStatus({ lm, states: vram(1536, 6144), cfg: withTotal }).gpuMem, 25);
  assert.equal(nucboxStatus({ lm, states: vram(1536, 'unavailable'), cfg: withTotal }).gpuMem, null);
  assert.equal(nucboxStatus({ lm, states: vram(1536, 0), cfg: withTotal }).gpuMem, null);
  const pct = Object.assign({}, cfg, { gpuMemory: 'sensor.vram_used' });
  assert.equal(nucboxStatus({ lm, states: vram(71, 6144), cfg: pct }).gpuMem, 71, 'without a total the reading is already a percentage');
});

test('a temperature shows its configured label, else its Home Assistant name', () => {
  // Catches: the 80-character Libre Hardware Monitor name shown when a short label was given.
  const labelled = Object.assign({}, cfg, { temps: [{ entity: 'sensor.cpu_temp', name: 'CPU' }, { entity: 'sensor.gpu_temp', name: null }] });
  const s = nucboxStatus({ lm: { status: 'ok', models: [] }, states: states(10), cfg: labelled });
  assert.deepEqual(s.temps, [{ name: 'CPU', c: 58 }, { name: 'GPU Core', c: 64 }]);
});

test('the poller: fast while showing, slow otherwise; a timeout is unreachable; recovery is ok', async () => {
  let t = 0;
  const timers = [];
  const setT = (fn, ms) => { const h = { at: t + ms, fn }; timers.push(h); return h; };
  const clearT = (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); };
  const advance = async (to) => {
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      if (!timers.length || timers[0].at > to) break;
      const x = timers.shift(); t = x.at; x.fn();
      await new Promise((r) => setImmediate(r));
    }
    t = to;
    await new Promise((r) => setImmediate(r));
  };
  const fetches = [];
  let mode = 'ok';
  const fakeFetch = (url) => { fetches.push(t); return mode === 'ok' ? Promise.resolve({ ok: true, json: () => Promise.resolve(MODELS) }) : new Promise(() => {}); };
  const seen = [];
  const p = createLmPoller({ url: 'http://nucbox:1234', fetch: fakeFetch, setTimeout: setT, clearTimeout: clearT, onChange: (x) => seen.push(x) });
  p.start();
  await advance(0);
  assert.deepEqual(seen.at(-1), { status: 'ok', models: ['qwen3-30b-a3b'] });
  await advance(60000);
  assert.deepEqual(fetches.slice(0, 3), [0, 30000, 60000], 'every 30 s in the background');
  p.setFast(true);
  await advance(70000);
  assert.ok(fetches.includes(65000) && fetches.includes(70000), 'every 5 s while showing');
  mode = 'hang';
  await advance(80000);
  assert.equal(seen.at(-1).status, 'unreachable', 'a 3 s timeout');
  mode = 'ok';
  await advance(90000);
  assert.equal(seen.at(-1).status, 'ok');
  p.stop();
});

test('the view: model large, meters, temperatures, plain missing lines, never an alert', () => {
  const html = renderNucbox(nucboxStatus({ lm: { status: 'ok', models: ['qwen3-30b-a3b'] }, states: states(80), cfg }), cfg);
  assert.match(html, /nmodel">qwen3-30b-a3b/);
  assert.match(html, /ntag busy">busy/);
  assert.match(html, /CPU/);
  assert.match(html, /GPU/);
  assert.doesNotMatch(html, /GPU memory/, 'unconfigured meters are left out');
  assert.match(html, /58°/);
  assert.doesNotMatch(html, /attention|edge|badge|haline/);
  assert.match(renderNucbox(nucboxStatus({ lm: { status: 'ok', models: [] }, states: states(5), cfg }), cfg), /No model loaded/);
  assert.match(renderNucbox(nucboxStatus({ lm: { status: 'unreachable', models: [] }, states: states(5), cfg }), cfg), /LM Studio not reachable/);
  assert.match(renderNucbox(null, null), /NucBox isn't set up/);
});

test('with Home Assistant offline, the old hardware numbers are not shown as live and busy is unknown', () => {
  const lm = { status: 'ok', models: ['qwen3-30b-a3b'] };
  const s = nucboxStatus({ lm, states: states(87), cfg, haStatus: 'offline' });
  assert.equal(s.busy, 'unknown');
  assert.equal(s.gpu, null);
  assert.equal(s.cpu, null);
  assert.deepEqual(s.temps, []);
  assert.ok(s.missing.includes('Home Assistant offline'));
  assert.equal(s.model, 'qwen3-30b-a3b', 'LM Studio still answers for itself');
  assert.ok(nucboxStatus({ lm, states: states(87), cfg, haStatus: 'unauthorized' }).missing.includes('Home Assistant token rejected'));
  assert.equal(nucboxStatus({ lm, states: states(87), cfg, haStatus: 'online' }).busy, 'busy');
});
