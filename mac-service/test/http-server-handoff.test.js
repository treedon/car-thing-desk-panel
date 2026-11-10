// The HTTP server's hook handler and the handoff: a Stop or StopFailure reaches handoff.onHook only after
// its response has been ended, other events never do, and a handoff that throws changes nothing about the
// response. Random free port, loopback only, temp config dir; never the owner's service on 8790.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-thing-http-handoff-'));
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

function start(handoff, extra = {}) {
  return createHttpServer({
    hub: createHub({ heartbeatMs: 0 }),
    store: { count: () => 0 },
    permissionBridge: { pendingCount: () => 0 },
    sources: { onHookEvent() {}, promptHookInstalled: () => false, status: () => [], hooksInstalled: () => false },
    handoff,
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
function post(url, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: url, method: 'POST', agent: false,
      headers: { 'Content-Type': 'application/json' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.once('error', reject);
    req.end(JSON.stringify(body));
  });
}

const hook = (event, extra = {}) => ({ hook_event_name: event, session_id: 's1', ...extra });

test('Stop and StopFailure reach the handoff; other hooks do not', async () => {
  const calls = [];
  const server = await start({ onHook: (e, p) => { calls.push([e, p.session_id]); } });
  try {
    for (const e of ['PreToolUse', 'Stop', 'StopFailure', 'SessionEnd', 'UserPromptSubmit']) {
      assert.deepEqual(await post('/hook', hook(e)), { status: 200, body: '{}' });
    }
    assert.deepEqual(await post('/hook/Stop', { session_id: 's2' }), { status: 200, body: '{}' });
    await settle();
    assert.deepEqual(calls, [['Stop', 's1'], ['StopFailure', 's1'], ['Stop', 's2']]);
  } finally {
    await stop(server);
  }
});

test('the handoff hears the hook only once the response has been ended, and after the sources', async () => {
  const order = [];
  const end = http.ServerResponse.prototype.end;
  http.ServerResponse.prototype.end = function patched(...args) {
    if (this.req && this.req.url.startsWith('/hook')) order.push('response ended');
    return end.apply(this, args);
  };
  const server = await start({ onHook: (e) => { order.push('handoff ' + e); } }, {
    sources: { onHookEvent: (e) => order.push('sources ' + e), promptHookInstalled: () => false, status: () => [], hooksInstalled: () => false },
  });
  try {
    await post('/hook', hook('Stop'));
    await settle();
    assert.deepEqual(order, ['sources Stop', 'response ended', 'handoff Stop']);
  } finally {
    http.ServerResponse.prototype.end = end;
    await stop(server);
  }
});

test('held hooks never reach the handoff', async () => {
  const calls = [];
  const server = await start({ onHook: (e) => { calls.push(e); } }, {
    questionBridge: { handlePreToolUse: async () => ({ held: 'question' }), willHold: () => false },
  });
  try {
    // a hold request named Stop is still a held request
    assert.deepEqual(await post('/hook?hold=1', hook('Stop')), { status: 200, body: '{"held":"question"}' });
    await settle();
    assert.deepEqual(calls, []);
  } finally {
    await stop(server);
  }
});

test('a handoff that throws never breaks the hook response', async () => {
  let thrown = 0;
  const server = await start({ onHook: () => { thrown++; throw new Error('handoff on fire'); } });
  try {
    assert.deepEqual(await post('/hook', hook('Stop')), { status: 200, body: '{}' });
    assert.deepEqual(await post('/hook', hook('StopFailure')), { status: 200, body: '{}' });
    await settle();
    assert.equal(thrown, 2);
    assert.deepEqual(await post('/hook', hook('Stop')), { status: 200, body: '{}' });
  } finally {
    await stop(server);
  }
});

test('no handoff, no change', async () => {
  const server = await start(undefined);
  try {
    assert.deepEqual(await post('/hook', hook('Stop')), { status: 200, body: '{}' });
  } finally {
    await stop(server);
  }
});
