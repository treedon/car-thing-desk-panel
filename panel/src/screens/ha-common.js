import { esc } from './helpers.js';

// Shared by the Home Assistant screens: the plain status lines, and the value
// the knob just set, shown at once while HA catches up.

export var OPTIMISTIC_MS = 1500;

export function haProblem(ha) {
  if (!ha || !ha.configured) return "Home Assistant isn't set up. Run mac-service/scripts/ha-discover.js on the Mac.";
  if (ha.status === 'unauthorized') return 'Home Assistant token rejected. Make a new one.';
  if (ha.status !== 'online') return 'Home Assistant offline. Reconnecting…';
  return '';
}

export function problemLine(ha) {
  var p = haProblem(ha);
  return p ? '<div class="haline">' + esc(p) + '</div>' : '';
}

// Stamped and checked on the panel's own clock (Date.now()), never the
// Mac-corrected one: a corrected clock can be hours off the stamp.
export function optimistic(ha, id) {
  var o = ha && ha.optimistic && ha.optimistic[id];
  return o && Date.now() - o.ts < OPTIMISTIC_MS ? o.level : null;
}

export function nameOf(state, id) {
  return (state && state.attributes && state.attributes.friendly_name) || id;
}
