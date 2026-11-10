import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { HOST, PORT, WEBPAGE_DIST, DAEMON_VERSION, DAEMON_ROOT, TOKEN_DIR, MOCK_SESSIONS, ALLOWED_ORIGINS } from './config.js';
import { authorizeUpgrade, authorizeHttp, loadOrCreateToken } from './lan-auth.js';
import { log } from './log.js';
import { timeHook } from './hook-timing.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// How long an idle session's rewake poller is held before it is told there is
// nothing (204); just under the hook's own 3600 s timeout.
const REWAKE_MAX_MS = 3_500_000;

// The digest's /status counters. A digest that cannot report must not take the handler down with it:
// this runs inside an async request handler, where a throw would be an unhandled rejection.
function digestStatus(digest) {
  if (!digest) return null;
  try { return digest.status(); } catch { return null; }
}

export function createHttpServer({ hub, store, permissionBridge, sources, questionBridge, messageBridge, digest, handoff }) {
  const token = loadOrCreateToken(TOKEN_DIR);
  const server = http.createServer(async (req, res) => {
    const url = (req.url || '/').split('?')[0];
    // The LAN reaches /ws only (an upgrade, handled below). Hooks, /status and
    // the control page answer this Mac alone.
    if (!authorizeHttp({ remoteAddress: req.socket.remoteAddress, host: req.headers.host, origin: req.headers.origin, port: PORT })) {
      res.writeHead(403);
      return res.end();
    }
    if (req.method === 'POST') log('IN', `${req.method} ${req.url}`);

    // The Stop hook's asyncRewake poller (scripts/rewake-hook.js): held until a
    // panel message arrives for the session (200, the text), the owner types,
    // or the hold ends (204).
    if (req.method === 'GET' && url === '/hook/rewake' && messageBridge) {
      const session = new URL(req.url, 'http://x').searchParams.get('session');
      if (!session) { res.writeHead(400); return res.end(); }
      const ac = new AbortController();
      let done = false;
      res.on('close', () => { if (!done) ac.abort(); });
      const cap = setTimeout(() => ac.abort(), REWAKE_MAX_MS);
      cap.unref();
      const text = await messageBridge.waitForIdleMessage(session, ac.signal);
      done = true;
      clearTimeout(cap);
      if (text) {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(text);
      }
      res.writeHead(204);
      return res.end();
    }

    // Hook ingestion: PermissionRequest is held; everything else is
    // acknowledged immediately and forwarded to session sources.
    // Accepts /hook/<event> (command hooks) and bare /hook (type:"http"
    // hooks — event read from the payload's hook_event_name).
    if (req.method === 'POST' && (url === '/hook' || url.startsWith('/hook/'))) {
      let payload = {};
      try { payload = JSON.parse(await readBody(req) || '{}'); } catch {}
      const event = url === '/hook'
        ? (payload.hook_event_name || 'unknown')
        : url.slice('/hook/'.length);

      if (event === 'PermissionRequest') {
        return permissionBridge.onHookRequest(payload, res);
      }

      // The question/plan hold hook (?hold=1, PreToolUse on AskUserQuestion |
      // ExitPlanMode): held until the panel answers, the hold ends, or Claude
      // Code gives up on the request. An empty object is "no opinion".
      if (new URL(req.url, 'http://x').searchParams.get('hold') === '1') {
        const ac = new AbortController();
        let done = false;
        res.on('close', () => { if (!done) ac.abort(); });
        const out = questionBridge ? await questionBridge.handlePreToolUse(payload, ac.signal) : null;
        done = true;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(out || {}));
      }
      // The ordinary PreToolUse hook for the same call: the bridge carries the
      // question itself, so the upstream card is not queued as well.
      if (event === 'PreToolUse' && questionBridge && sources.promptHookInstalled() && questionBridge.willHold(payload)) {
        payload.heldByPanel = true;
      }
      // A panel message waits for the session's next tool call; typing in
      // Claude Code drops it instead.
      let out = null;
      if (messageBridge && event === 'UserPromptSubmit') messageBridge.onUserPromptSubmit(payload);
      if (messageBridge && event === 'PostToolUse') out = messageBridge.onPostToolUse(payload);
      // CLAUDE_THING_HOOK_TIMING=1 logs how long Claude Code waited on this.
      timeHook(event, () => sources.onHookEvent(event, payload), { write: log });
      // The digest hears a finished turn or session only after this response has gone out, so it can
      // never delay it (and it only sets a flag and a timer). A throw there changes nothing.
      if (digest && (event === 'Stop' || event === 'SessionEnd')) {
        res.once('finish', () => {
          try { digest.onHook(event, payload); } catch {}
        });
      }
      // A session waited on for a move into VS Code hears its turn has ended the same way. onHook never
      // rejects; the catch is for a throw before it returns its promise.
      if (handoff && (event === 'Stop' || event === 'StopFailure')) {
        res.once('finish', () => {
          try { handoff.onHook(event, payload); } catch {}
        });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(out || {}));
    }

    // Hook install/uninstall from the webpage's Settings page
    if (req.method === 'POST' && (url === '/api/hooks/install' || url === '/api/hooks/uninstall')) {
      const script = url.endsWith('install') ? 'install-hooks.js' : 'uninstall-hooks.js';
      try {
        const output = execFileSync(process.execPath, [path.join(DAEMON_ROOT, 'scripts', script)], {
          encoding: 'utf8',
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, output: output.trim() }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, output: String(err.stderr || err.message) }));
      }
    }

    if (url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        // Lets the simulator tell this service from anything else on the port.
        service: 'claude-panel',
        mock: MOCK_SESSIONS,
        daemonVersion: DAEMON_VERSION,
        sessions: store.count(),
        pendingPermissions: permissionBridge.pendingCount(),
        clients: hub.rolesOnline(),
        connector: hub.connectorStatus(),
        sources: sources.status(),
        hooks: sources.hooksInstalled(),
        // null when the digest is off (CLAUDE_PANEL_DIGEST=0).
        digest: digestStatus(digest),
      }));
    }

    // Webpage static (built) with SPA fallback
    const root = path.resolve(WEBPAGE_DIST);
    let file = path.resolve(root, '.' + (url === '/' ? '/index.html' : decodeURIComponent(url)));
    if (file === root || file.startsWith(root + path.sep)) {
      try {
        if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
        const body = fs.readFileSync(file);
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
        return res.end(body);
      } catch {}
      try {
        const body = fs.readFileSync(path.join(root, 'index.html'));
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
        return res.end(body);
      } catch {}
    }
    res.writeHead(404);
    res.end('claude-thing daemon: webpage not built (webpage/dist missing)');
  });

  server.on('upgrade', (req, socket, head) => {
    if (authorizeUpgrade({
      remoteAddress: req.socket.remoteAddress, url: req.url, token, port: PORT,
      host: req.headers.host, origin: req.headers.origin, allowedOrigins: ALLOWED_ORIGINS,
    })) {
      hub.wss.handleUpgrade(req, socket, head, (ws) => {
        hub.wss.emit('connection', ws, req);
      });
    } else {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n', () => socket.destroy());
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, () => {
      log('--', `http+ws on http://${HOST}:${PORT}  (ws path /ws; LAN needs the token in ${TOKEN_DIR}/token)`);
      resolve(server);
    });
  });
}
