// Starts the simulator server on a spare port and checks it serves the panel,
// its config and the faceplate. Exits non-zero on any failure.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = 18091 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A running simulator's PID file must survive the smoke run untouched.
const pidFile = path.join(here, '..', '.cache', 'simulator.pid');
let pidBefore = null;
try { pidBefore = fs.readFileSync(pidFile, 'utf8'); } catch {}

// A throwaway Home Assistant config, so the smoke run never reads the owner's.
const haDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-ha-'));
const haFile = path.join(haDir, 'ha.json');
fs.writeFileSync(haFile, JSON.stringify({ url: 'http://ha.example:8123', token: 'smoke-secret', home: ['light.a'], audio: [] }));

const child = spawn(process.execPath, [path.join(here, '..', 'src', 'index.js')], {
  env: { ...process.env, SIM_PORT: String(port), SIM_NO_CDP: '1', SIM_NO_PIDFILE: '1', SIM_DEMO: '', CLAUDE_PANEL_HA_CONFIG: haFile, CLAUDE_PANEL_TASKS_CONFIG: path.join(haDir, 'none.json'), CLAUDE_PANEL_NUCBOX_SESSIONS_CONFIG: path.join(haDir, 'none.json') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });

async function get(p, headers = {}) {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(base + p, { headers });
      return { status: r.status, body: await r.text() };
    } catch { await sleep(100); }
  }
  return { status: 0, body: '' };
}

const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what); };

try {
  const root = await get('/');
  check(root.status === 200 && root.body.includes('<div id="app">'), 'GET / serves the panel');
  const cfg = await get('/panel-config.js');
  check(cfg.status === 200 && cfg.body.includes('8790/ws'), 'GET /panel-config.js points at the Mac service');
  const own = await get('/panel-config.js', { 'Sec-Fetch-Site': 'same-origin' });
  check(own.body.includes('http://ha.example:8123') && own.body.includes('smoke-secret'), 'the panel itself gets the Home Assistant config');
  const cross = await get('/panel-config.js', { 'Sec-Fetch-Site': 'cross-site' });
  check(!cross.body.includes('smoke-secret') && cross.body.includes('"ha":null'), 'a cross-site script never gets the Home Assistant token');
  // fetch() drops a custom Host header, so this one goes out as a raw request.
  const rebound = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/panel-config.js',
      headers: { Host: 'evil.example:' + port, 'Sec-Fetch-Site': 'same-origin' } }, (r) => {
      let body = '';
      r.on('data', (c) => { body += c; });
      r.on('end', () => resolve({ body }));
    }).on('error', () => resolve({ body: '' }));
  });
  check(!rebound.body.includes('smoke-secret'), 'a rebound hostname never gets the Home Assistant token');
  const shell = await get('/__emulator__/');
  check(shell.status === 200 && shell.body.includes('id="screen"'), 'GET /__emulator__/ serves the faceplate');
} finally {
  child.kill('SIGTERM');
}
await sleep(300);
let pidAfter = null;
try { pidAfter = fs.readFileSync(pidFile, 'utf8'); } catch {}
check(pidAfter === pidBefore, 'the smoke server leaves the simulator PID file alone');
if (failures.length) {
  console.log('--- server output ---\n' + out.slice(-2000));
  process.exit(1);
}
