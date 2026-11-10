// Where the panel finds the Mac service. /panel-config.js sets
// window.PANEL_CONFIG before the app loads: the simulator serves one pointing
// at this Mac with no token; the Car Thing image ships one with the Mac's LAN
// address and the token from ~/.config/claude-panel/token.

var DEFAULT_URL = 'ws://localhost:8790/ws';

export function readConfig(raw) {
  var c = raw || {};
  // tasks = {url, token}: the tasks service on the NucBox (Tasks page).
  var tasks = c.tasks && c.tasks.url && c.tasks.token ? { url: String(c.tasks.url), token: String(c.tasks.token) } : null;
  // nucboxSessions = {url, token}: the NucBox's own session service, for the
  // Claude Code sessions that run there (ws.js merges them with the Mac's).
  var nb = c.nucboxSessions && c.nucboxSessions.url && c.nucboxSessions.token
    ? { url: String(c.nucboxSessions.url), token: String(c.nucboxSessions.token) } : null;
  return { serviceUrl: c.serviceUrl || DEFAULT_URL, token: c.token || '', ha: c.ha || null, recorder: c.recorder || null, tasks: tasks, nucboxSessions: nb };
}

export function serviceWsUrl(cfg) {
  return cfg.token ? cfg.serviceUrl + '?token=' + encodeURIComponent(cfg.token) : cfg.serviceUrl;
}

// The body of /panel-config.js ("window.PANEL_CONFIG = {...};"), re-read when
// the panel needs a fresh Home Assistant token without a reload.
export function parsePanelConfig(text) {
  var m = /=\s*(\{[\s\S]*\})\s*;?\s*$/.exec(String(text || ''));
  if (!m) return null;
  try { return readConfig(JSON.parse(m[1])); } catch (e) { return null; }
}
