// The service binds to the LAN so the Car Thing can reach it over Wi-Fi. Only
// /ws is reachable from the LAN, and only with the token; hooks and the control
// page stay loopback-only. The simulator runs on this Mac, so loopback needs no
// token.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLoopback(remoteAddress) {
  return LOOPBACK.has(remoteAddress);
}

function sameToken(given, token) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(token));
  if (a.length !== b.length || b.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];

// A browser page can reach 127.0.0.1 too: through a cross-site WebSocket or
// form post (it sends an Origin), or by DNS-rebinding its own hostname to
// 127.0.0.1 (the Host is then its name). Loopback trust is for this Mac's own
// programs: no foreign Origin, and a loopback Host.
function loopbackHost(host, port) {
  if (!host) return true;   // HTTP/1.0 clients; browsers always send Host
  return LOOPBACK_HOSTS.some((h) => host === h || host === `${h}:${port}`);
}

function sameMachineOrigin(origin, port) {
  return LOOPBACK_HOSTS.some((h) => origin === `http://${h}:${port}`);
}

// Plain HTTP routes (hooks, /status, the control page): this Mac only.
export function authorizeHttp({ remoteAddress, host, origin, port }) {
  if (!isLoopback(remoteAddress)) return false;
  if (!loopbackHost(host, port)) return false;
  return !origin || sameMachineOrigin(origin, port);
}

// allowedOrigins: browser origins that may use the loopback socket without a
// token (the simulator). From the LAN, the token is what counts.
export function authorizeUpgrade({ remoteAddress, url, token, host, origin, port, allowedOrigins = [] }) {
  const u = new URL(url || '/', 'http://x');
  if (u.pathname !== '/ws') return false;
  if (isLoopback(remoteAddress)) {
    if (port && !loopbackHost(host, port)) return false;
    return !origin || allowedOrigins.includes(origin) || sameMachineOrigin(origin, port);
  }
  const given = u.searchParams.get('token');
  return given !== null && sameToken(given, token);
}

export function loadOrCreateToken(dir) {
  const file = path.join(dir, 'token');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch {}
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, token + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return token;
}
