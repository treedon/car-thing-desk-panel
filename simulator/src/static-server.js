import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  HOST, HTTP_PORT, SHELL_DIR, PANEL_DIST, SERVICE_WS_URL, DIAL_TICK_DELTA, DIAL_MIN_TICK_MS,
  DIAL_DEG_PER_TICK, DIAL_SCROLL_PER_TICK, FORCE_LEGACY,
  CPU_THROTTLE_RATE, JS_HEAP_MB, INPUT_POLL_MS,
} from './config.js';
import { logInfo } from './log.js';
import { loadHaConfig } from '../../mac-service/src/ha-config.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

function send(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function serveFile(res, filePath, transform) {
  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  let body = fs.readFileSync(filePath);
  if (transform) body = transform(body.toString('utf8'));
  send(res, 200, body, type);
}

// Resolve a URL path inside rootDir; null if traversal or miss.
function resolveIn(rootDir, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const resolved = path.resolve(rootDir, '.' + decoded);
  if (resolved !== rootDir && !resolved.startsWith(rootDir + path.sep)) return null;
  let st;
  try { st = fs.statSync(resolved); } catch { return null; }
  if (st.isDirectory()) {
    const idx = path.join(resolved, 'index.html');
    return fs.existsSync(idx) ? idx : null;
  }
  return resolved;
}

// Rewrite Vite's module/nomodule split so the legacy (chrome69) chunks run —
// the exact code path the device's Chromium 69 takes. Modern module scripts
// (entries, the __vite_is_modern_browser detector, the SystemJS dynamic
// fallback) are stripped and the nomodule scripts promoted to always-run:
// vite-legacy-polyfill loads SystemJS synchronously, then the inline
// vite-legacy-entry System.import() fires, same as on the device.
function stripModernChunks(html) {
  return html
    .replace(/<script type="module"[^>]*>[\s\S]*?<\/script>\s*/g, '')
    .replace(/<link rel="modulepreload"[^>]*>\s*/g, '')
    .replace(/<script nomodule/g, '<script');
}

// The panel, built (panel/dist), at /; the faceplate shell at /__emulator__/.
// /panel-config.js is generated so the panel on this Mac talks to the local
// service with no token (loopback needs none).
// A cross-site page could load /panel-config.js with a <script> tag and read
// the Home Assistant token, so only the panel itself (same origin, or a
// direct load) gets it. Browsers send Sec-Fetch-Site; tools send none.
function crossSite(req) {
  const site = req.headers['sec-fetch-site'];
  return !!site && !['same-origin', 'same-site', 'none'].includes(site);
}

// DNS rebinding makes a hostile page "same-origin" under its own hostname;
// the panel always loads from 127.0.0.1 or localhost.
function loopbackHost(req) {
  const host = String(req.headers.host || '').replace(/:\d+$/, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
}

function haFor(req, demoHa) {
  if (crossSite(req) || !loopbackHost(req)) return null;
  if (demoHa) return demoHa;
  try { return loadHaConfig(); } catch { return null; }
}

// ~/.config/claude-panel/tasks.json ({url, token}): the NucBox's tasks
// service, gated like the Home Assistant token.
export function loadTasksConfig(file = process.env.CLAUDE_PANEL_TASKS_CONFIG || path.join(os.homedir(), '.config', 'claude-panel', 'tasks.json')) {
  try {
    const t = JSON.parse(fs.readFileSync(file, 'utf8'));
    return t && t.url && t.token ? { url: String(t.url), token: String(t.token) } : null;
  } catch { return null; }
}

// ~/.config/claude-panel/nucbox-sessions.json ({url, token}): the NucBox's
// session service, gated the same way.
function nucboxSessionsFor(req) {
  if (crossSite(req) || !loopbackHost(req)) return null;
  const file = process.env.CLAUDE_PANEL_NUCBOX_SESSIONS_CONFIG || path.join(os.homedir(), '.config', 'claude-panel', 'nucbox-sessions.json');
  try {
    const n = JSON.parse(fs.readFileSync(file, 'utf8'));
    return n && n.url && n.token ? { url: String(n.url), token: String(n.token) } : null;
  } catch { return null; }
}

function tasksFor(req, demoTasks) {
  if (crossSite(req) || !loopbackHost(req)) return null;
  return demoTasks || loadTasksConfig();
}

export function startHttpServer({ demoHa = null, demoTasks = null } = {}) {
  const shellRoot = path.resolve(SHELL_DIR);
  const uiRoot = path.resolve(PANEL_DIST);
  if (!fs.existsSync(path.join(uiRoot, 'index.html'))) {
    logInfo(`panel not built: ${uiRoot} missing (npm --prefix panel run build)`);
  }
  logInfo(`legacy chunks: ${FORCE_LEGACY ? 'forced (device chrome69 code path)' : 'OFF — modern modules'}`);

  const uiTransform = (file) => (file.endsWith('.html') && FORCE_LEGACY ? stripModernChunks : undefined);

  const configJson = JSON.stringify({
    service: SERVICE_WS_URL,
    dial: {
      tickDelta: DIAL_TICK_DELTA,
      minTickMs: DIAL_MIN_TICK_MS,
      degPerTick: DIAL_DEG_PER_TICK,
      scrollPerTick: DIAL_SCROLL_PER_TICK,
    },
    fidelity: {
      cpuThrottle: CPU_THROTTLE_RATE,
      jsHeapMb: JS_HEAP_MB,
      inputPollMs: INPUT_POLL_MS,
      forceLegacy: FORCE_LEGACY,
    },
  });

  const server = http.createServer((req, res) => {
    const urlPath = (req.url || '/').split('?')[0];

    if (urlPath.startsWith('/__emulator__')) {
      const sub = urlPath.slice('/__emulator__'.length) || '/';
      if (sub === '/config.json') return send(res, 200, configJson, MIME['.json']);
      const file = resolveIn(shellRoot, sub);
      if (file) return serveFile(res, file);
      return send(res, 404, 'not found');
    }

    if (urlPath === '/panel-config.js') {
      const cfg = { serviceUrl: SERVICE_WS_URL, token: '', ha: haFor(req, demoHa), tasks: tasksFor(req, demoTasks), nucboxSessions: nucboxSessionsFor(req) };
      return send(res, 200, 'window.PANEL_CONFIG = ' + JSON.stringify(cfg) + ';\n', MIME['.js']);
    }

    const file = resolveIn(uiRoot, urlPath);
    if (file) return serveFile(res, file, uiTransform(file));

    // SPA fallback: the panel routes by hash, so any page path is the app.
    const hasExt = path.extname(urlPath) !== '';
    const wantsHtml = (req.headers.accept || '').includes('text/html');
    const idx = path.join(uiRoot, 'index.html');
    if ((!hasExt || wantsHtml) && fs.existsSync(idx)) return serveFile(res, idx, uiTransform(idx));
    return send(res, 404, 'not found');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(HTTP_PORT, HOST, () => resolve(server));
  });
}
