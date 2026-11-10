// The demo's digest state, through the real entry point (index.js passes persist: digestPersists(…)): a
// mock-mode service with no CLAUDE_THING_STATE_DIR keeps its digest in memory, and one with a state folder
// of its own writes digest.json there. Without CLAUDE_THING_STATE_DIR the service's state folder is
// <DAEMON_ROOT>/.state, and DAEMON_ROOT is the folder above config.js, so the service runs from a copy of
// src/ (and package.json) inside a temp folder: its .state is the copy's, never the checkout's. Every other
// path it touches (HOME, TMPDIR and so the demo's transcripts, the Claude config, the token, the pid file,
// the log) is in the temp folder too, PATH is an empty folder (no `claude`, no `swiftc`), and the port is a
// free one, never 8790. The checkout's own mac-service/.state is listed before and after and must not change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAC_SERVICE = fileURLToPath(new URL('..', import.meta.url));
const CHECKOUT_STATE = path.join(MAC_SERVICE, '.state');
const { BASE, human, asst, stopSummary, jsonl } = await import('./fixtures/digest/build.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// Polls until check() returns something other than undefined.
async function until(what, check, limitMs = 30_000) {
  const end = Date.now() + limitMs;
  for (;;) {
    const found = await check();
    if (found !== undefined) return found;
    if (Date.now() > end) throw new Error(`gave up waiting for ${what}`);
    await sleep(50);
  }
}

// What is in a folder, recursively, with sizes and mtimes; [] when it does not exist.
function listing(dir) {
  const out = [];
  const walk = (d) => {
    let names;
    try { names = fs.readdirSync(d); } catch { return; }
    for (const name of names.sort()) {
      const p = path.join(d, name);
      const st = fs.lstatSync(p);
      if (st.isDirectory()) walk(p);
      else out.push(`${path.relative(dir, p)} ${st.size} ${st.mtimeMs}`);
    }
  };
  walk(dir);
  return out;
}

// The files called digest.json anywhere under a folder (node_modules is a link to the checkout's: not followed).
function digestFiles(dir) {
  const found = [];
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name === 'digest.json') found.push(path.relative(dir, p));
    }
  };
  walk(dir);
  return found;
}

// Runs the copied service in mock mode, posts one Stop for a transcript in the demo's projects folder, waits
// until the digest has read it, and ends it with SIGTERM. Returns what it left behind; the temp folder is
// removed whatever happens.
async function runDemo({ stateDir }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-thing-demo-state-'));
  let child = null;
  let output = '';
  try {
    const copy = path.join(tmp, 'mac-service');
    fs.mkdirSync(copy);
    fs.cpSync(path.join(MAC_SERVICE, 'src'), path.join(copy, 'src'), { recursive: true });
    fs.copyFileSync(path.join(MAC_SERVICE, 'package.json'), path.join(copy, 'package.json'));
    fs.symlinkSync(path.join(MAC_SERVICE, 'node_modules'), path.join(copy, 'node_modules'), 'dir');
    fs.mkdirSync(path.join(tmp, 'bin'));
    const port = await freePort();
    assert.notEqual(port, 8790);
    const files = { log: path.join(tmp, 'logs', 'daemon.log'), pid: path.join(tmp, 'daemon.pid') };
    const env = {
      PATH: path.join(tmp, 'bin'), HOME: tmp, TMPDIR: tmp,
      CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'), CLAUDE_PANEL_CONFIG_DIR: path.join(tmp, 'config'),
      CLAUDE_THING_PORT: String(port), CLAUDE_PANEL_BIND: '127.0.0.1', CLAUDE_THING_MOCK: '1',
      CLAUDE_THING_PID_FILE: files.pid, CLAUDE_THING_LOG_DIR: path.dirname(files.log),
      ...(stateDir ? { CLAUDE_THING_STATE_DIR: path.join(tmp, stateDir) } : {}),
    };
    child = spawn(process.execPath, [path.join(copy, 'src', 'index.js')], { env, cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (c) => { output += c; });
    child.stderr.on('data', (c) => { output += c; });
    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    const url = (p) => `http://127.0.0.1:${port}${p}`;
    const status = async () => JSON.parse(await (await fetch(url('/status'))).text());
    const idle = await until('the service and its catch-up', async () => {
      if (child.exitCode !== null) throw new Error('the service exited at start-up:\n' + output);
      try {
        const s = await status();
        return s.digest && s.digest.catchUpMs !== null && s.digest.queued === 0 ? s : undefined;
      } catch { return undefined; }
    });
    // One more session for the digest to keep: a transcript in the demo's projects folder (MOCK_DIR is in TMPDIR).
    const m = (Date.now() - BASE) / 60_000;
    const transcript = path.join(tmp, 'claude-panel-mock', 'projects', 'proj', 'sess-demo.jsonl');
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, jsonl([human('Keep this demo in memory', m - 3), asst('Done. Nothing is written.', m - 2), stopSummary(m - 2)]));
    const hook = await fetch(url('/hook/Stop'), { method: 'POST', body: JSON.stringify({ session_id: 'sess-demo', transcript_path: transcript }) });
    assert.equal(hook.status, 200);
    await until('the Stop to be read', async () => ((await status()).digest.sessions === idle.digest.sessions + 1 ? true : undefined));
    child.kill('SIGTERM');
    const exit = await exited;
    const log = fs.existsSync(files.log) ? fs.readFileSync(files.log, 'utf8') : '';
    const stateFile = stateDir ? path.join(tmp, stateDir, 'digest.json') : path.join(copy, '.state', 'digest.json');
    return {
      exit, log, demoSessions: idle.digest.sessions,
      digestFiles: digestFiles(tmp),
      stateMode: fs.existsSync(stateFile) ? fs.statSync(stateFile).mode & 0o777 : null,
      saved: fs.existsSync(stateFile) ? Object.keys(JSON.parse(fs.readFileSync(stateFile, 'utf8')).sessions).length : 0,
      copyStateFolder: path.relative(tmp, path.join(copy, '.state')),
    };
  } catch (err) {
    console.error('--- service output ---\n' + output);
    throw err;
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('the demo with no CLAUDE_THING_STATE_DIR keeps its digest in memory: no digest.json anywhere, the checkout\'s .state untouched', { timeout: 120_000 }, async () => {
  const before = listing(CHECKOUT_STATE);
  const run = await runDemo({ stateDir: null });
  assert.deepEqual(run.exit, { code: 0, signal: null });
  assert.match(run.log, /DG state kept in memory only/);
  assert.deepEqual(run.digestFiles, [], `no digest.json under the temp folder, ${run.copyStateFolder} included`);
  assert.equal(run.stateMode, null);
  assert.ok(run.demoSessions > 0, 'the demo gave the digest sessions to save');
  assert.deepEqual(listing(CHECKOUT_STATE), before, 'the checkout\'s mac-service/.state is as it was');
});

// The same harness with a state folder of its own: digest.json is written there at 0600 on SIGTERM, which is
// what shows the absence above is the service choosing not to write, not a harness that cannot see a write.
test('the demo with CLAUDE_THING_STATE_DIR writes digest.json there at 0600, and only there', { timeout: 120_000 }, async () => {
  const before = listing(CHECKOUT_STATE);
  const run = await runDemo({ stateDir: 'state' });
  assert.deepEqual(run.exit, { code: 0, signal: null });
  assert.doesNotMatch(run.log, /state kept in memory only/);
  assert.deepEqual(run.digestFiles, [path.join('state', 'digest.json')]);
  assert.equal(run.stateMode, 0o600);
  assert.equal(run.saved, run.demoSessions + 1, 'the demo\'s sessions and the one the Stop named');
  assert.deepEqual(listing(CHECKOUT_STATE), before);
});
