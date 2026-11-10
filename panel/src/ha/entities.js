// Reading Home Assistant states for the panel's screens, and the throttle that
// keeps a spun knob from flooding HA. Pure; no DOM, no socket.

export function isAvailable(state) {
  return !!state && state.state !== 'unavailable' && state.state !== 'unknown';
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

export function lightLevel(state) {
  if (!isAvailable(state) || state.state !== 'on') return 0;
  var b = state.attributes && state.attributes.brightness;
  return typeof b === 'number' ? Math.round(b / 255 * 100) : 100;
}

export function nextLevel(level, dir, step) {
  return clamp(level + dir * (step || 5), 0, 100);
}

export function volumePct(state) {
  var v = state && state.attributes && state.attributes.volume_level;
  return typeof v === 'number' ? Math.round(v * 100) : null;
}

export function nextVolume(pct, dir, step) {
  return clamp(pct + dir * (step || 2), 0, 100);
}

// entity_picture is usually a path on HA (with its own short-lived token in
// the query), sometimes a full URL from the source app.
export function nowPlaying(state, haUrl) {
  var a = (state && state.attributes) || {};
  var pic = a.entity_picture || null;
  return {
    title: a.media_title || '',
    artist: a.media_artist || a.media_album_artist || '',
    art: pic ? (/^[a-z][a-z0-9+.-]*:/i.test(pic) ? pic : haUrl + pic) : null,
    playing: !!state && state.state === 'playing',
  };
}

// One send per key at most every intervalMs: the first goes at once, later
// ones wait for the window and only the newest is sent, so a knob spun hard
// lands on its final value without a call per tick.
export function createThrottle(opts) {
  var intervalMs = opts.intervalMs || 150;
  var now = opts.now || function () { return Date.now(); };
  var later = opts.setTimeout || setTimeout;
  var keys = {};   // key -> {last, timer, value, send}

  function flush(key) {
    var k = keys[key];
    k.timer = false;
    if (!k.dirty) return;
    k.dirty = false;
    k.last = now();
    k.send(k.value);
    k.timer = true;
    later(function () { flush(key); }, intervalMs);
  }

  return {
    push: function (key, value, send) {
      var k = keys[key] || (keys[key] = { last: -Infinity, timer: false, dirty: false });
      k.value = value;
      k.send = send;
      k.dirty = true;
      if (k.timer) return;
      var wait = k.last + intervalMs - now();
      if (wait <= 0) return flush(key);
      k.timer = true;
      later(function () { flush(key); }, wait);
    },
  };
}

// What a press on a Home tile calls: scenes and scripts run; anything else
// toggles in its own domain (lights, switches, fans, input_booleans…).
export function haServiceFor(entityId) {
  var domain = String(entityId).split('.')[0];
  if (domain === 'scene' || domain === 'script') return [domain, 'turn_on'];
  return [domain, 'toggle'];
}

// Whether a state change concerns anything the panel shows. A house full of
// power sensors changes many times a second; only these need a repaint.
export function relevantEntity(ha, id) {
  if (!ha) return false;
  if ((ha.home || []).indexOf(id) >= 0 || (ha.audio || []).indexOf(id) >= 0) return true;
  var n = ha.nucbox;
  if (!n) return false;
  return id === n.cpuLoad || id === n.memory || id === n.gpuLoad || id === n.gpuMemory || (n.temps || []).indexOf(id) >= 0;
}

// A speaker that doesn't report its volume can't be stepped from it.
export function nextVolumeFrom(pct, dir) {
  return pct == null ? null : nextVolume(pct, dir);
}
