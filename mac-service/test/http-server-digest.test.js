// The HTTP server's hook handler and the digest: a non-held Stop or SessionEnd reaches the digest only
// after its response has been ended, a digest that throws changes nothing about the response, and
// /status carries the digest's counters. Hook responses must be byte-for-byte what they were without a
// digest. Random free port, loopback only, temp config dir; never the owner's service on 8790.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

// config.js reads these once, so they are set before anything imports it.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-thing-http-digest-'));
const PORT = await freePort();
process.env.CLAUDE_THING_PORT = String(PORT);
process.env.CLAUDE_PANEL_BIND = '127.0.0.1';
process.env.CLAUDE_PANEL_CONFIG_DIR = path.join(TMP, 'config');
// log.js opens <LOG_DIR>/daemon.log with 'w' as soon as anything imports it, which in the checkout is the
// live service's log: keep this file's lines, and the emptying, out of it.
process.env.CLAUDE_THING_LOG_DIR = path.join(TMP, 'logs');

const { createHttpServer } = await import('../src/http-server.js');
const { createHub } = await import('../src/hub.js');

const settle = () => new Promise((resolve) => setImmediate(resolve));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

async function start(digest, extra = {}) {
  return createHttpServer({
    hub: createHub({ heartbeatMs: 0 }),
    store: { count: () => 0 },
    permissionBridge: {
      pendingCount: () => 0,
      onHookRequest: (_payload, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"held":true}'); },
    },
    sources: { onHookEvent() {}, promptHookInstalled: () => false, status: () => [], hooksInstalled: () => false },
    digest,
    ...extra,
  });
}

function stop(server) {
  return new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
}

// node:http, with no Origin header and no kept-alive socket.
function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: url, method, agent: false,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.once('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const post = (url, body) => request('POST', url, body);

// Everything the server sends for one POST, as text, with the Date header taken out.
function rawPost(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const socket = net.connect(PORT, '127.0.0.1');
    const chunks = [];
    socket.on('data', (c) => chunks.push(c));
    socket.once('error', reject);
    socket.once('close', () => resolve(Buffer.concat(chunks).toString('utf8').replace(/^Date: .*\r\n/m, '')));
    socket.write(`POST ${url} HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nConnection: close\r\n`
      + `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`);
  });
}

const hook = (event, extra = {}) => ({ hook_event_name: event, session_id: 's1', transcript_path: '/x', ...extra });

test('Stop and SessionEnd reach the digest after the response; other hooks do not', async () => {
  const calls = [];
  const server = await start({ onHook: (e, p) => calls.push([e, p.session_id]), status: () => ({}) });
  try {
    for (const e of ['PreToolUse', 'Stop', 'SessionEnd']) {
      assert.deepEqual(await post('/hook', hook(e)), { status: 200, body: '{}' });
    }
    await settle();
    assert.deepEqual(calls, [['Stop', 's1'], ['SessionEnd', 's1']]);
  } finally {
    await stop(server);
  }
});

test('the digest hears the hook only once the response has been ended', async () => {
  const order = [];
  const end = http.ServerResponse.prototype.end;
  http.ServerResponse.prototype.end = function patched(...args) {
    if (this.req && this.req.url.startsWith('/hook')) order.push('response ended');
    return end.apply(this, args);
  };
  const server = await start({ onHook: (e) => order.push('digest ' + e), status: () => ({}) });
  try {
    await post('/hook', hook('Stop'));
    await post('/hook', hook('SessionEnd'));
    await settle();
    assert.deepEqual(order, ['response ended', 'digest Stop', 'response ended', 'digest SessionEnd']);
  } finally {
    http.ServerResponse.prototype.end = end;
    await stop(server);
  }
});

test('the event may come from the path, as the command hooks send it', async () => {
  const calls = [];
  const server = await start({ onHook: (e, p) => calls.push([e, p.session_id, p.transcript_path]), status: () => ({}) });
  try {
    assert.deepEqual(await post('/hook/Stop', { session_id: 's2', transcript_path: '/y' }), { status: 200, body: '{}' });
    assert.deepEqual(await post('/hook/SessionEnd', { session_id: 's3' }), { status: 200, body: '{}' });
    assert.deepEqual(await post('/hook/PostToolUse', { session_id: 's4' }), { status: 200, body: '{}' });
    await settle();
    assert.deepEqual(calls, [['Stop', 's2', '/y'], ['SessionEnd', 's3', undefined]]);
  } finally {
    await stop(server);
  }
});

test('held hooks and the rewake poller never reach the digest', async () => {
  const calls = [];
  const server = await start({ onHook: (e) => calls.push(e), status: () => ({}) }, {
    questionBridge: { handlePreToolUse: async () => ({ held: 'question' }), willHold: () => false },
    messageBridge: {
      onUserPromptSubmit() {}, onPostToolUse: () => null, waitForIdleMessage: async () => null,
    },
  });
  try {
    assert.deepEqual(await post('/hook', hook('PermissionRequest')), { status: 200, body: '{"held":true}' });
    assert.deepEqual(await post('/hook?hold=1', hook('PreToolUse')), { status: 200, body: '{"held":"question"}' });
    // a hold request named Stop is still a held request
    assert.deepEqual(await post('/hook?hold=1', hook('Stop')), { status: 200, body: '{"held":"question"}' });
    assert.deepEqual(await post('/hook/UserPromptSubmit', hook('UserPromptSubmit')), { status: 200, body: '{}' });
    assert.deepEqual(await post('/hook/Notification', hook('Notification')), { status: 200, body: '{}' });
    assert.deepEqual(await post('/hook', { session_id: 's1' }), { status: 200, body: '{}' });
    assert.deepEqual(await request('GET', '/hook/rewake?session=s1'), { status: 204, body: '' });
    await settle();
    assert.deepEqual(calls, []);
  } finally {
    await stop(server);
  }
});

test('a digest that throws never breaks the hook response', async () => {
  let thrown = 0;
  const server = await start({ onHook: () => { thrown++; throw new Error('digest on fire'); }, status: () => ({}) });
  try {
    assert.deepEqual(await post('/hook', hook('Stop')), { status: 200, body: '{}' });
    assert.deepEqual(await post('/hook', hook('SessionEnd')), { status: 200, body: '{}' });
    await settle();
    assert.equal(thrown, 2, 'both notifications reached the digest');
    // and the server still answers
    assert.deepEqual(await post('/hook', hook('Stop')), { status: 200, body: '{}' });
    assert.equal((await request('GET', '/status')).status, 200);
  } finally {
    await stop(server);
  }
});

test('a hook response is byte-for-byte what it is without a digest', async () => {
  const withDigest = await start({ onHook() { throw new Error('boom'); }, status: () => ({}) });
  const seen = {};
  try {
    for (const e of ['Stop', 'SessionEnd', 'PreToolUse']) seen[e] = await rawPost('/hook', hook(e));
  } finally {
    await stop(withDigest);
  }
  const without = await start(undefined);
  try {
    for (const e of ['Stop', 'SessionEnd', 'PreToolUse']) {
      const bare = await rawPost('/hook', hook(e));
      assert.match(bare, /^HTTP\/1\.1 200 OK\r\n/);
      assert.match(bare, /\r\n\r\n2\r\n\{\}\r\n0\r\n\r\n$/); // chunked, the body {}
      assert.equal(seen[e], bare, `${e}: the response differs`);
    }
  } finally {
    await stop(without);
  }
});

test('/status reports the digest', async () => {
  const counters = { sessions: 4, cards: 3, skipped: 2, queued: 1, catchUpMs: 87, errors: 0 };
  const server = await start({ onHook() {}, status: () => counters });
  try {
    const res = await request('GET', '/status');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(body.digest, counters);
    assert.equal(body.service, 'claude-panel');
  } finally {
    await stop(server);
  }
});

test('/status keeps its fields and adds digest last; no digest is null', async () => {
  const server = await start(null);
  try {
    const body = JSON.parse((await request('GET', '/status')).body);
    assert.deepEqual(Object.keys(body), [
      'service', 'mock', 'daemonVersion', 'sessions', 'pendingPermissions', 'clients', 'connector', 'sources', 'hooks', 'digest',
    ]);
    assert.equal(body.digest, null);
  } finally {
    await stop(server);
  }
});

test('/status still answers when the digest cannot report', async () => {
  const server = await start({ onHook() {}, status: () => { throw new Error('no status'); } });
  try {
    const res = await request('GET', '/status');
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).digest, null);
  } finally {
    await stop(server);
  }
});

test('the log goes to CLAUDE_THING_LOG_DIR; the checkout\'s own log never sees this run', async () => {
  const { LOG_DIR } = await import('../src/config.js');
  assert.equal(LOG_DIR, path.join(TMP, 'logs'));
  const server = await start({ onHook() {}, status: () => ({}) });
  try {
    await post('/hook', hook('PreToolUse'));
  } finally {
    await stop(server);
  }
  // the stream writes asynchronously: wait for this run's two lines (the listen line names TMP)
  const mine = path.join(LOG_DIR, 'daemon.log');
  let text = '';
  for (let i = 0; i < 500 && !(text.includes('POST /hook') && text.includes(TMP)); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    try { text = fs.readFileSync(mine, 'utf8'); } catch { text = ''; }
  }
  assert.match(text, /IN POST \/hook/);
  assert.ok(text.includes(TMP), 'the listen line, which names this run\'s config dir');
  // TMP is unique to this run, so no other test file can have put it in the checkout's log
  const checkoutLog = fileURLToPath(new URL('../logs/daemon.log', import.meta.url));
  if (fs.existsSync(checkoutLog)) {
    assert.equal(fs.readFileSync(checkoutLog, 'utf8').includes(path.basename(TMP)), false);
  }
});
