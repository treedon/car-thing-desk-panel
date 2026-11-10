#!/usr/bin/env node
// Finds what the panel's Home Assistant screens can show and writes a first
// guess into ~/.config/claude-panel/ha.json. Lists the owner already edited are
// kept. The token is read from that file and never printed.
//
//   node mac-service/scripts/ha-discover.js
//   node mac-service/scripts/ha-discover.js --nucbox <name>   (sensors to map by hand)
import fs from 'node:fs';
import WebSocket from 'ws';
import { HA_CONFIG_PATH, loadHaConfig, suggestHaConfig } from '../src/ha-config.js';

const nucboxIdx = process.argv.indexOf('--nucbox');
const nucboxName = nucboxIdx > 0 ? String(process.argv[nucboxIdx + 1] || '').toLowerCase() : null;

let cfg;
try { cfg = loadHaConfig(HA_CONFIG_PATH); } catch {
  console.error(`${HA_CONFIG_PATH} isn't valid JSON with "url" and "token".`);
  process.exit(1);
}
if (!cfg) {
  console.error(`No ${HA_CONFIG_PATH}. Create it with {"url":"http://<ha>:8123","token":"<long-lived token>"} (mode 600).`);
  process.exit(1);
}

function getStates() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(cfg.url.replace(/^http/, 'ws') + '/api/websocket');
    const timer = setTimeout(() => { ws.terminate(); reject(new Error(`no answer from ${cfg.url}`)); }, 10_000);
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: cfg.token }));
      else if (m.type === 'auth_invalid') { clearTimeout(timer); ws.close(); reject(new Error('Home Assistant rejected the token')); }
      else if (m.type === 'auth_ok') ws.send(JSON.stringify({ id: 1, type: 'get_states' }));
      else if (m.type === 'result' && m.id === 1) { clearTimeout(timer); ws.close(); resolve(m.result || []); }
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

const name = (s) => (s.attributes && s.attributes.friendly_name) || s.entity_id;

try {
  const states = await getStates();
  const byId = new Map(states.map((s) => [s.entity_id, s]));
  if (nucboxName !== null) {
    const hits = states.filter((s) => s.entity_id.startsWith('sensor.') &&
      String(name(s)).toLowerCase().includes(nucboxName) &&
      ['%', '°C', 'GB'].includes((s.attributes || {}).unit_of_measurement));
    console.log(`Sensors matching "${nucboxName}" (fill "nucbox" in ${HA_CONFIG_PATH} by hand):`);
    for (const s of hits) console.log(`  ${s.entity_id}  ${name(s)}  = ${s.state} ${(s.attributes || {}).unit_of_measurement}`);
    if (!hits.length) console.log('  none — is the Libre Hardware Monitor integration added in Home Assistant?');
    process.exit(0);
  }
  const suggestion = suggestHaConfig(states, { url: cfg.url, token: cfg.token });
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(HA_CONFIG_PATH, 'utf8')); } catch {}
  const merged = {
    ...existing,
    home: existing.home && existing.home.length ? existing.home : suggestion.home,
    audio: existing.audio && existing.audio.length ? existing.audio : suggestion.audio,
  };
  for (const [screen, ids] of [['Home', merged.home], ['Audio', merged.audio]]) {
    console.log(`${screen} (${ids.length}):`);
    for (const id of ids) console.log(`  ${id}  ${byId.has(id) ? name(byId.get(id)) : '(not in Home Assistant)'}`);
  }
  const tmp = `${HA_CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, HA_CONFIG_PATH);
  fs.chmodSync(HA_CONFIG_PATH, 0o600);
  console.log(`Saved to ${HA_CONFIG_PATH}. Edit the lists there to change what each screen shows.`);
} catch (e) {
  console.error(`Couldn't read Home Assistant: ${e.message}`);
  process.exit(1);
}
