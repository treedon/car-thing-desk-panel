// npm run sim: build the panel -> make sure the Mac service is up (starting it
// if nothing answers) -> (re)start the simulator server -> open a Chrome app
// window on the faceplate. SIM_DEMO=1 runs the service on mock sessions.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  HOST, HTTP_PORT, PID_FILE, LOG_DIR, CHROME_PROFILE_DIR, EMULATOR_URL, CACHE_DIR,
  PROJECT_ROOT, MAC_SERVICE_DIR, SERVICE_PORT, WINDOW_W, WINDOW_H, CDP_PORT,
  JS_HEAP_MB, CPU_THROTTLE_RATE,
} from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(__dirname, '..', 'src', 'index.js');
const serverLog = path.join(LOG_DIR, 'server.log');
const PANEL_DIR = path.join(PROJECT_ROOT, 'panel');
const DEMO = process.env.SIM_DEMO === '1';
const STATUS_URL = `http://127.0.0.1:${SERVICE_PORT}/status`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function portInUse(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: HOST, port, timeout: 500 });
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
  });
}

function buildPanel() {
  console.log('building panel…');
  if (!fs.existsSync(path.join(PANEL_DIR, 'node_modules'))) {
    execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: PANEL_DIR, stdio: 'pipe' });
  }
  execFileSync('npm', ['run', 'build'], { cwd: PANEL_DIR, stdio: 'pipe' });
}

async function serviceStatus() {
  try {
    const r = await fetch(STATUS_URL);
    return r.ok ? await r.json() : { foreign: true };
  } catch {
    return null;
  }
}

// Reuse a running Mac service only if it is this project's, in the mode asked
// for; anything else on the port is reported, never killed.
async function ensureService() {
  const s = await serviceStatus();
  if (s) {
    if (s.service !== 'claude-panel') {
      throw new Error(`port ${SERVICE_PORT} answers but is not the claude-panel Mac service ` +
        `(an old claude-thing daemon?). Stop it, or run with SIM_SERVICE_PORT=<other port>.`);
    }
    if (!!s.mock !== DEMO) {
      throw new Error(`the Mac service on ${SERVICE_PORT} is running ${s.mock ? 'demo' : 'live'} sessions; ` +
        `stop it to switch to ${DEMO ? 'SIM_DEMO=1' : 'live mode'}.`);
    }
    console.log(`Mac service already up on ${SERVICE_PORT} (${s.mock ? 'demo' : 'live'})`);
    return;
  }
  if (!fs.existsSync(path.join(MAC_SERVICE_DIR, 'node_modules'))) {
    execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: MAC_SERVICE_DIR, stdio: 'pipe' });
  }
  fs.mkdirSync(path.join(MAC_SERVICE_DIR, 'logs'), { recursive: true });
  const logFd = fs.openSync(path.join(MAC_SERVICE_DIR, 'logs', 'boot.log'), 'w');
  const env = { ...process.env, CLAUDE_THING_PORT: String(SERVICE_PORT) };
  if (DEMO) env.CLAUDE_THING_MOCK = '1';
  spawn(process.execPath, [path.join(MAC_SERVICE_DIR, 'src', 'index.js')], {
    detached: true, stdio: ['ignore', logFd, logFd], env, cwd: MAC_SERVICE_DIR,
  }).unref();
  fs.closeSync(logFd);
  for (let i = 0; i < 50; i++) {
    const up = await serviceStatus();
    if (up) { console.log(`Mac service started on ${SERVICE_PORT} (${DEMO ? 'demo' : 'live'})`); return; }
    await sleep(100);
  }
  console.log('warning: Mac service did not report ready — check mac-service/logs/');
}

async function stopPreviousSimulator() {
  let pid = null;
  try { pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10); } catch {}
  if (pid && pidAlive(pid)) {
    process.kill(pid, 'SIGTERM');
    for (let i = 0; i < 20 && pidAlive(pid); i++) await sleep(100);
    if (pidAlive(pid)) process.kill(pid, 'SIGKILL');
    console.log(`stopped previous simulator (pid ${pid})`);
  }
  try { fs.unlinkSync(PID_FILE); } catch {}
  if (await portInUse(HTTP_PORT)) {
    throw new Error(`port ${HTTP_PORT} is held by another process. Check: lsof -nP -iTCP:${HTTP_PORT} -sTCP:LISTEN`);
  }
}

async function waitReady(timeoutMs = 15000) {
  const url = `http://${HOST}:${HTTP_PORT}/__emulator__/config.json`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await sleep(100);
  }
  let tail = '';
  try { tail = fs.readFileSync(serverLog, 'utf8').split('\n').slice(-15).join('\n'); } catch {}
  throw new Error(`simulator server did not become ready in ${timeoutMs / 1000}s.\n--- server.log tail ---\n${tail}`);
}

// --- main ---

buildPanel();
await ensureService();
await stopPreviousSimulator();

fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(CACHE_DIR, { recursive: true });
const logFd = fs.openSync(serverLog, 'w');
spawn(process.execPath, [serverEntry], { detached: true, stdio: ['ignore', logFd, logFd] }).unref();
fs.closeSync(logFd);
await waitReady();
console.log(`simulator up: http://${HOST}:${HTTP_PORT}/`);

// Chrome applies --force-device-scale-factor / --window-size only at process
// start, so close a window still running on the simulator's own profile first
// (never touches the user's normal Chrome).
try {
  execFileSync('pkill', ['-f', CHROME_PROFILE_DIR], { stdio: 'ignore' });
  await sleep(600);
} catch {}

const chromeArgs = [
  `--app=${EMULATOR_URL}`,
  // 1 CSS pixel = 1 physical pixel: the 800×480 panel at its true resolution.
  '--force-device-scale-factor=1',
  `--window-size=${WINDOW_W},${WINDOW_H}`,
  `--user-data-dir=${CHROME_PROFILE_DIR}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-pinch',
  '--disable-smooth-scrolling',
  '--force-color-profile=srgb',
  // Dictation records from the Mac's microphone; a permission prompt would
  // block the kiosk-like window, so grant it up front.
  '--use-fake-ui-for-media-stream',
  // The Car Thing's kiosk is always in front; a simulator window behind others
  // must not have its timers and rendering throttled (the panel's liveness
  // ping and offline banner depend on both).
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  `--remote-debugging-port=${CDP_PORT}`,
];
if (JS_HEAP_MB > 0) chromeArgs.push(`--js-flags=--max-old-space-size=${JS_HEAP_MB}`);
// SIM_FAKE_MIC=1: Chrome's synthetic audio device instead of the Mac's
// microphone, for testing dictation without speaking (or a macOS mic prompt).
if (process.env.SIM_FAKE_MIC === '1') chromeArgs.push('--use-fake-device-for-media-stream');

try {
  if (process.env.EMU_CHROME_BIN) {
    spawn(process.env.EMU_CHROME_BIN, chromeArgs, { detached: true, stdio: 'ignore' }).unref();
  } else {
    execFileSync('open', ['-na', 'Google Chrome', '--args', ...chromeArgs]);
  }
  console.log(`simulator window opened: ${EMULATOR_URL}`);
  console.log(`fidelity: cpu ${CPU_THROTTLE_RATE}x throttle, V8 heap ${JS_HEAP_MB || 'uncapped'}MB (EMU_CPU_THROTTLE=0 / EMU_JS_HEAP_MB=0 to disable)`);
} catch (err) {
  console.log(`could not launch Chrome (${err.message}); open ${EMULATOR_URL} manually`);
}
