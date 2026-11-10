// The NucBox view's data: which model LM Studio has loaded (polled straight
// from its REST API), and the NucBox's hardware numbers (Home Assistant
// entities from the Libre Hardware Monitor integration). Pure apart from the
// poller, which takes its fetch and timers as arguments.

import { isAvailable } from './ha/entities.js';

var FAST_MS = 5000;
var SLOW_MS = 30000;
var TIMEOUT_MS = 3000;

// Loaded language models from GET /api/v0/models; embedding models don't count.
export function loadedModels(body) {
  var list = (body && body.data) || [];
  var out = [];
  for (var i = 0; i < list.length; i++) {
    if (list[i].state === 'loaded' && list[i].type !== 'embeddings') out.push(list[i].id);
  }
  return out;
}

// Polls every 5 s while the view is showing, every 30 s otherwise. A poll that
// takes over 3 s counts as unreachable. Never touches the HA or Mac links.
export function createLmPoller(opts) {
  var later = opts.setTimeout || setTimeout;
  var cancel = opts.clearTimeout || clearTimeout;
  var doFetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  var fast = false;
  var next = null;
  var seq = 0;
  var last = null;
  var running = false;

  function report(r) {
    var key = r.status + '|' + r.models.join(',');
    if (key === last) return;
    last = key;
    opts.onChange(r);
  }

  function schedule() {
    if (next) cancel(next);
    next = running ? later(poll, fast ? FAST_MS : SLOW_MS) : null;
  }

  function poll() {
    next = null;
    var mine = ++seq;
    schedule();
    var timer = later(function () {
      if (mine === seq) report({ status: 'unreachable', models: [] });
    }, TIMEOUT_MS);
    Promise.resolve().then(function () {
      return doFetch(opts.url + '/api/v0/models');
    }).then(function (res) {
      if (!res || !res.ok) throw new Error('bad status');
      return res.json();
    }).then(function (body) {
      cancel(timer);
      if (mine === seq) report({ status: 'ok', models: loadedModels(body) });
    }, function () {
      cancel(timer);
      if (mine === seq) report({ status: 'unreachable', models: [] });
    });
  }

  return {
    start: function () { if (running) return; running = true; poll(); },
    stop: function () { running = false; if (next) cancel(next); next = null; },
    setFast: function (on) {
      if (fast === !!on) return;
      fast = !!on;
      if (running) schedule();
    },
  };
}

function num(state) {
  if (!isAvailable(state)) return null;
  var n = parseFloat(state.state);
  return isNaN(n) ? null : n;
}

// A percentage sensor as it is, or an amount used as a share of gpuMemoryTotal.
function gpuMemory(cfg, states) {
  if (!cfg.gpuMemory) return null;
  var used = num(states[cfg.gpuMemory]);
  if (!cfg.gpuMemoryTotal) return used;
  var total = num(states[cfg.gpuMemoryTotal]);
  if (used == null || total == null || total <= 0) return null;
  return used / total * 100;
}

export function nucboxStatus(input) {
  var lm = input.lm || { status: 'unreachable', models: [] };
  var cfg = input.cfg;
  // States kept from before HA dropped are history, not readings.
  var haDown = input.haStatus && input.haStatus !== 'online';
  var states = haDown ? {} : (input.states || {});
  var models = lm.status === 'ok' ? lm.models : [];
  var gpu = cfg.gpuLoad ? num(states[cfg.gpuLoad]) : null;
  var busy;
  if (lm.status !== 'ok') busy = 'unknown';
  else if (!models.length) busy = 'idle';
  else if (gpu == null) busy = 'unknown';
  else busy = gpu >= cfg.busyGpuPct ? 'busy' : 'idle';
  // Each entry is an entity id, or {entity, name} with a short label.
  var temps = [];
  for (var i = 0; i < cfg.temps.length; i++) {
    var entry = cfg.temps[i];
    var id = typeof entry === 'string' ? entry : entry.entity;
    var t = states[id];
    var c = num(t);
    var label = (entry && entry.name) || (t && t.attributes && t.attributes.friendly_name) || id;
    if (c != null) temps.push({ name: label, c: Math.round(c) });
  }
  var cpu = num(states[cfg.cpuLoad]);
  var mem = num(states[cfg.memory]);
  var missing = [];
  if (cfg.lmstudio && lm.status !== 'ok') missing.push('LM Studio not reachable');
  if (!cfg.lmstudio) missing.push('LM Studio not set up');
  if (haDown) missing.push(input.haStatus === 'unauthorized' ? 'Home Assistant token rejected' : 'Home Assistant offline');
  else if (cpu == null && mem == null) missing.push('NucBox sensors unavailable');
  else if (cfg.gpuLoad && gpu == null) missing.push('GPU reading unavailable');
  return {
    model: models[0] || null,
    extra: Math.max(0, models.length - 1),
    busy: busy,
    cpu: cpu, mem: mem, gpu: gpu,
    gpuMem: gpuMemory(cfg, states),
    temps: temps,
    missing: missing,
  };
}
