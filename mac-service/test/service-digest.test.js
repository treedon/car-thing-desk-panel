// The real entry point, src/index.js, run as the owner's service would run it, but on a free port, on
// loopback, in mock mode and with every folder it touches inside a temp dir (its HOME, TMPDIR, Claude
// config dir, state, token, pid file and log), and with an empty PATH so it finds no `claude` or `swiftc`
// to run. It never goes near 8790. (log.js opens <LOG_DIR>/daemon.log with 'w', and in the checkout that is
// the live service's log, so the log folder is the temp one too, and a test below says so.) What this
// checks, that no unit test of createDigest can:
//   - the wiring: a Stop hook posted over HTTP reaches the digest, /status and claude.digest.get report
//     it, claude.digest.update is pushed, and the card's `ended` comes from the live store;
//   - a SIGTERM writes the state the throttled saver still holds, at mode 0600, before the process exits;
//   - CLAUDE_PANEL_DIGEST=0 makes no digest at all, and the service still answers hooks and the method.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const SERVICE = fileURLToPath(new URL('../src/index.js', import.meta.url));
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

// Polls until check() returns something other than undefined. The limit only matters when the thing
// never happens; it is not a time the thing is expected to take.
async function until(what, check, limitMs = 30_000) {
  const end = Date.now() + limitMs;
  for (;;) {
    const found = await check();
    if (found !== undefined) return found;
    if (Date.now() > end) throw new Error(`gave up waiting for ${what}`);
    await sleep(50);
  }
}

// A one-turn transcript that ended a minute ago. The fixture builder counts minutes from BASE.
function transcript(prompt, reply) {
  const m = (Date.now() - BASE) / 60_000;
  return jsonl([human(prompt, m - 3), asst(reply, m - 2), stopSummary(m - 2)]);
}

// `entry` and `limitMs` exist for the launch-failure tests below: a stand-in entry point, and a short wait.
async function launch({ digest, entry = SERVICE, limitMs }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-thing-service-'));
  const port = await freePort();
  assert.notEqual(port, 8790);
  fs.mkdirSync(path.join(tmp, 'bin'));
  const files = {
    pid: path.join(tmp, 'daemon.pid'),
    log: path.join(tmp, 'logs', 'daemon.log'),
    state: path.join(tmp, 'state', 'digest.json'),
    projects: path.join(tmp, 'claude-panel-mock', 'projects', 'proj'), // os.tmpdir() is tmp for the child
  };
  const child = spawn(process.execPath, [entry], {
    env: {
      PATH: path.join(tmp, 'bin'), HOME: tmp, TMPDIR: tmp,
      CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'),
      CLAUDE_THING_PORT: String(port), CLAUDE_PANEL_BIND: '127.0.0.1', CLAUDE_THING_MOCK: '1',
      CLAUDE_THING_PID_FILE: files.pid, CLAUDE_THING_STATE_DIR: path.dirname(files.state),
      CLAUDE_THING_LOG_DIR: path.dirname(files.log),
      CLAUDE_PANEL_CONFIG_DIR: path.join(tmp, 'config'), CLAUDE_PANEL_DIGEST: digest ? '1' : '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));

  const url = (p) => `http://127.0.0.1:${port}${p}`;
  const service = {
    port, tmp, files, child, exited,
    get output() { return output; },
    async status() {
      const res = await fetch(url('/status'));
      return JSON.parse(await res.text());
    },
    async hook(event, body) {
      const res = await fetch(url('/hook/' + event), { method: 'POST', body: JSON.stringify(body) });
      return { status: res.status, body: await res.text() };
    },
    place(id, prompt, reply) {
      fs.mkdirSync(files.projects, { recursive: true });
      const file = path.join(files.projects, id + '.jsonl');
      fs.writeFileSync(file, transcript(prompt, reply));
      return file;
    },
    savedSessions() {
      try { return Object.keys(JSON.parse(fs.readFileSync(files.state, 'utf8')).sessions).sort(); } catch { return []; }
    },
    logText() {
      try { return fs.readFileSync(files.log, 'utf8'); } catch { return ''; }
    },
    // Ends the child the way launchd or a terminal does.
    async terminate() {
      child.kill('SIGTERM');
      return exited;
    },
    cleanup() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
  try {
    await until('the service to answer /status', async () => {
      if (child.exitCode !== null) throw new Error('the service exited at start-up:\n' + output);
      try { return await service.status(); } catch { return undefined; }
    }, limitMs);
  } catch (err) {
    // No caller has the service yet, so none can clean up: a child that never answered would be left
    // running and its folder behind. Wait for the child to be gone before the folder is removed under it.
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    fs.rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
  return service;
}

// A WebSocket client of the hub, as the panel is: hello, then requests; events are kept.
async function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const events = [];
  const pending = new Map();
  let n = 0;
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString('utf8'));
    if (msg.type === 'event') return void events.push(msg);
    const waiter = pending.get(msg.id);
    if (waiter) { pending.delete(msg.id); waiter(msg); }
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const client = {
    events,
    request: (method, params = {}) => new Promise((resolve) => {
      const id = 'r' + ++n;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ type: 'request', id, method, params }));
    }),
    close: () => ws.close(),
  };
  const hello = await client.request('bridge.hello', { role: 'webpage' });
  assert.equal(hello.type, 'response');
  return client;
}

// The service's log is in its temp folder, with this run's lines, and the checkout's own
// mac-service/logs/daemon.log (the live service's, in the main checkout) never got them. The temp dir's
// name is unique to this run, so no other test file, running at the same time, can have written it there.
// (A before-and-after size and mtime of that file is not asserted: every other test file that imports
// the hub opens it with 'w' and writes to it, concurrently, in `npm test`.)
const CHECKOUT_LOG = fileURLToPath(new URL('../logs/daemon.log', import.meta.url));
function assertLogStayedInTemp(svc) {
  const text = svc.logText();
  for (const line of [`http+ws on http://127.0.0.1:${svc.port}`, 'IN POST /hook/', 'RQ webpage claude.digest.get', 'DG ']) {
    assert.ok(text.includes(line), `the temp log has "${line}"`);
  }
  if (fs.existsSync(CHECKOUT_LOG)) {
    assert.equal(fs.readFileSync(CHECKOUT_LOG, 'utf8').includes(path.basename(svc.tmp)), false,
      'the checkout\'s mac-service/logs/daemon.log holds this run\'s lines');
  }
}

// A launch that fails leaves nothing behind. The stand-in entry points write their pid and the TMPDIR launch() gave
// them (their temp folder) to a file of the test's own, then exit at once or never listen.
async function failedLaunch(body, limitMs) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-thing-launch-fail-'));
  try {
    const info = path.join(work, 'info.json'), entry = path.join(work, 'entry.cjs');
    fs.writeFileSync(entry, `require('node:fs').writeFileSync(${JSON.stringify(info)}, JSON.stringify({ pid: process.pid, tmp: process.env.TMPDIR }));\n${body}`);
    const error = await launch({ digest: false, entry, limitMs }).then(() => null, (err) => err);
    assert.ok(error, 'the launch failed');
    const { pid, tmp } = JSON.parse(fs.readFileSync(info, 'utf8'));   // the entry ran, so this exists
    assert.equal(fs.existsSync(tmp), false, 'its temp folder is removed');
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'its child is gone');
    return error;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

test('a service that exits at start-up fails the launch with its output, and its temp folder is removed', { timeout: 30_000 }, async () => {
  const error = await failedLaunch(`process.exit(3);`);
  assert.match(error.message, /^the service exited at start-up:/);
});

test('a service that never answers fails the launch after the wait, its child is killed and its temp folder removed', { timeout: 30_000 }, async () => {
  const error = await failedLaunch(`setInterval(() => {}, 1000);`, 3_000);
  assert.match(error.message, /gave up waiting for the service to answer \/status/);
});

test('a Stop hook reaches the digest, and SIGTERM writes the state the saver still holds', { timeout: 120_000 }, async () => {
  const svc = await launch({ digest: true });
  let panel;
  try {
    panel = await connect(svc.port);
    // Mock mode writes the demo's transcripts (source-mock.js) and the catch-up reads them: twelve live
    // sessions, ended-recent and notify-only (ended-old is outside the window), thirteen of them cards.
    const idle = await until('the catch-up of the demo transcripts', async () => {
      const s = await svc.status();
      return s.digest.catchUpMs !== null && s.digest.queued === 0 ? s : undefined;
    });
    assert.deepEqual(Object.keys(idle.digest), ['sessions', 'cards', 'skipped', 'queued', 'catchUpMs', 'errors']);
    assert.deepEqual([idle.digest.sessions, idle.digest.cards, idle.digest.errors], [14, 13, 0]);
    const demo = idle.digest.sessions;
    // CLAUDE_THING_PID_FILE moved the pid file: the checkout's own .daemon.pid is not this service's.
    assert.equal(await until('the pid file', () => { try { return fs.readFileSync(svc.files.pid, 'utf8'); } catch { return undefined; } }), String(svc.child.pid));

    // The first record read (a demo one) is saved at once; the next save waits out the saver's interval (10 s).
    await until('the first record to be saved', () => (svc.savedSessions().length ? true : undefined));
    assert.equal(fs.statSync(svc.files.state).mode & 0o777, 0o600);
    const first = svc.place('sess-a', 'Make the dial dimmer', 'Done. The dial now dims in 5% steps.');
    assert.deepEqual(await svc.hook('Stop', { session_id: 'sess-a', transcript_path: first }), { status: 200, body: '{}' });

    // A session the live store knows (the mock source's), so its card must not be marked ended. Its
    // transcript moves to the one the hook names, which is read from the start.
    const live = 'mock-0-claude-thing';
    const second = svc.place(live, 'Tidy the permission bridge', 'Done. The timeout now counts from the request.');
    assert.deepEqual(await svc.hook('Stop', { session_id: live, transcript_path: second }), { status: 200, body: '{}' });
    const got = await until('both sessions to be read', async () => {
      const g = await panel.request('claude.digest.get');
      const c = g.result.cards.find((x) => x.sessionId === live);
      return g.result.cards.some((x) => x.sessionId === 'sess-a') && c && c.lastReply === 'Done.' ? g : undefined;
    });
    const status = await svc.status();
    assert.deepEqual([status.digest.sessions, status.digest.cards, status.digest.skipped, status.digest.errors], [demo + 1, 14, 0, 0]);
    assert.equal(svc.savedSessions().includes('sess-a'), false, 'the new record is held back by the saver');

    // claude.digest.get answers the whole digest, with each card's ended taken from the live store.
    assert.equal(got.type, 'response');
    assert.equal(got.result.windowHours, 24);
    assert.equal(got.result.totals.sessions, 14);
    const ended = (id) => got.result.cards.find((c) => c.sessionId === id).ended;
    assert.deepEqual([ended(live), ended('sess-a')], [false, true]);

    // claude.digest.update is pushed, debounced, once the changes settle.
    const update = await until('a claude.digest.update with both cards', () =>
      panel.events.find((e) => e.topic === 'claude.digest.update' && e.data.cards.some((c) => c.sessionId === 'sess-a')
        && e.data.cards.some((c) => c.sessionId === live && c.lastReply === 'Done.')));
    assert.equal(update.data.cards.length, 14);

    // SIGTERM: the held record is written, the pid file goes, and the exit is clean.
    assert.deepEqual(await svc.terminate(), { code: 0, signal: null });
    const saved = svc.savedSessions();
    assert.ok(saved.includes(live) && saved.includes('sess-a'), `saved: ${saved}`);
    assert.equal(saved.length, demo + 1);
    assert.equal(fs.statSync(svc.files.state).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(svc.files.pid), false);
    assertLogStayedInTemp(svc);
  } catch (err) {
    console.error('--- service output ---\n' + svc.output);
    throw err;
  } finally {
    if (panel) panel.close();
    svc.cleanup();
  }
});

test('with CLAUDE_PANEL_DIGEST=0 there is no digest: no status, no files, an empty digest from the method', { timeout: 120_000 }, async () => {
  const svc = await launch({ digest: false });
  let panel;
  try {
    panel = await connect(svc.port);
    const status = await svc.status();
    assert.equal(status.digest, null);
    assert.equal(status.service, 'claude-panel');

    // Hooks are answered as before, and nothing reads the transcript: wait past the 1.5 s read delay.
    const file = svc.place('sess-a', 'Make the dial dimmer', 'Done.');
    assert.deepEqual(await svc.hook('Stop', { session_id: 'sess-a', transcript_path: file }), { status: 200, body: '{}' });
    assert.deepEqual(await svc.hook('SessionEnd', { session_id: 'sess-a', transcript_path: file }), { status: 200, body: '{}' });
    await sleep(2_500);

    const before = Date.now();
    const got = await panel.request('claude.digest.get');
    const after = Date.now();
    assert.equal(got.type, 'response');
    const { updatedTs, ...rest } = got.result;
    assert.ok(updatedTs >= before && updatedTs <= after, 'emptyDigest(Date.now())');
    assert.deepEqual(rest, {
      windowHours: 24,
      summarizer: { state: 'off', model: null, lastOkTs: null },
      totals: { sessions: 0, turns: 0, commits: 0, prs: 0, testRuns: 0 },
      cards: [],
    });
    assert.deepEqual(panel.events.filter((e) => e.topic === 'claude.digest.update'), []);
    assert.equal((await svc.status()).digest, null);

    assert.deepEqual(await svc.terminate(), { code: 0, signal: null });
    assert.equal(fs.existsSync(svc.files.state), false);
    assert.equal(fs.existsSync(svc.files.pid), false);
  } catch (err) {
    console.error('--- service output ---\n' + svc.output);
    throw err;
  } finally {
    if (panel) panel.close();
    svc.cleanup();
  }
});
