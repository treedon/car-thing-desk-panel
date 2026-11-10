// The panel's Home Assistant settings: where HA is, the token, and which
// entities each screen shows. Lives in ~/.config/claude-panel/ha.json (0600),
// written by the owner and by scripts/ha-discover.js; never in the repo.
import fs from 'node:fs';
import path from 'node:path';
import { TOKEN_DIR } from './config.js';

export const HA_CONFIG_PATH = process.env.CLAUDE_PANEL_HA_CONFIG || path.join(TOKEN_DIR, 'ha.json');

function invalid() { return new Error('ha-config-invalid'); }

function normaliseUrl(url) {
  const u = new URL(String(url));
  return `${u.protocol}//${u.host}`;
}

function strings(list) {
  return Array.isArray(list) ? list.filter((x) => typeof x === 'string' && x) : [];
}

// Each temperature is an entity id, or {entity, name} with a short label for
// the panel (Libre Hardware Monitor's own names run to 80 characters).
function temps(list) {
  const out = [];
  for (const t of Array.isArray(list) ? list : []) {
    if (typeof t === 'string' && t) out.push({ entity: t, name: null });
    else if (t && typeof t === 'object' && typeof t.entity === 'string' && t.entity) {
      out.push({ entity: t.entity, name: t.name ? String(t.name) : null });
    }
  }
  return out;
}

function loadNucbox(n) {
  if (n == null) return null;
  if (typeof n !== 'object' || !n.cpuLoad || !n.memory) throw invalid();
  return {
    lmstudio: n.lmstudio ? normaliseUrl(n.lmstudio) : null,
    cpuLoad: String(n.cpuLoad),
    memory: String(n.memory),
    gpuLoad: n.gpuLoad ? String(n.gpuLoad) : null,
    gpuMemory: n.gpuMemory ? String(n.gpuMemory) : null,
    // When set, gpuMemory is an amount used and the meter shows it as a share of this.
    gpuMemoryTotal: n.gpuMemoryTotal ? String(n.gpuMemoryTotal) : null,
    temps: temps(n.temps),
    busyGpuPct: Number.isFinite(Number(n.busyGpuPct)) && n.busyGpuPct !== null && n.busyGpuPct !== undefined ? Number(n.busyGpuPct) : 40,
  };
}

export function loadHaConfig(file = HA_CONFIG_PATH) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  let c;
  try { c = JSON.parse(raw); } catch { throw invalid(); }
  if (!c || typeof c !== 'object' || !c.url || !c.token) throw invalid();
  let url;
  try { url = normaliseUrl(c.url); } catch { throw invalid(); }
  return {
    url,
    token: String(c.token),
    home: strings(c.home),
    audio: strings(c.audio),
    nucbox: loadNucbox(c.nucbox),
  };
}

function nameOf(s) {
  return String((s.attributes && s.attributes.friendly_name) || s.entity_id);
}

function byName(a, b) {
  return nameOf(a).localeCompare(nameOf(b), undefined, { sensitivity: 'base' });
}

function domainOf(s) {
  return s.entity_id.split('.')[0];
}

// A first guess the owner can edit: lights then scenes for Home; HomePods (by
// name or model) for Audio, or every media player when none says HomePod.
export function suggestHaConfig(states, { url, token }) {
  const of = (d) => states.filter((s) => domainOf(s) === d).sort(byName);
  // A player that is unavailable at discovery time (a disconnected output) is
  // noise on a screen of speakers.
  const players = of('media_player').filter((s) => s.state !== 'unavailable');
  const homepods = players.filter((s) => /HomePod/i.test(nameOf(s)) || /HomePod/i.test(String((s.attributes || {}).model || '')));
  return {
    url,
    token,
    home: [...of('light'), ...of('scene')].map((s) => s.entity_id),
    audio: (homepods.length ? homepods : players).map((s) => s.entity_id),
    nucbox: null,
  };
}
