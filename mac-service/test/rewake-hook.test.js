// The Stop hook (asyncRewake): long-polls the service for a panel message.
// Exit 2 with the text on stderr wakes Claude; exit 0 means nothing to say.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'rewake-hook.js');

function stub(handler) {
  return new Promise((resolve) => {
    const seen = [];
    const server = http.createServer((req, res) => { seen.push(req.url); handler(req, res); });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen }));
  });
}

function runHook(port, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { env: { ...process.env, CLAUDE_PANEL_PORT: String(port) } });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('exit', (code) => resolve({ code, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

test('a message wakes Claude: exit 2, the text on stderr', async () => {
  const s = await stub((req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('Message from the owner via the desk panel: hi'); });
  const r = await runHook(s.port, { hook_event_name: 'Stop', session_id: 'abc-123' });
  s.server.close();
  assert.equal(r.code, 2);
  assert.equal(r.stderr.trim(), 'Message from the owner via the desk panel: hi');
  assert.equal(s.seen[0], '/hook/rewake?session=abc-123');
});

test('nothing to say (204) exits 0 quietly', async () => {
  const s = await stub((req, res) => { res.writeHead(204); res.end(); });
  const r = await runHook(s.port, { session_id: 'abc' });
  s.server.close();
  assert.equal(r.code, 0);
  assert.equal(r.stderr, '');
});

test('service not running exits 0', async () => {
  const s = await stub(() => {});
  const port = s.port;
  await new Promise((r) => s.server.close(r));
  assert.equal((await runHook(port, { session_id: 'abc' })).code, 0);
});

// The turn that answers a woken reply ends with stop_hook_active: true. A poller
// only fires on a message the owner sent, so polling again can't loop.
test('a Stop after a woken turn polls again, so a second reply can land', async () => {
  const s = await stub((req, res) => { res.writeHead(200); res.end('again'); });
  const r = await runHook(s.port, { session_id: 'abc', stop_hook_active: true });
  s.server.close();
  assert.equal(r.code, 2);
});

test('no session does not poll', async () => {
  const s = await stub((req, res) => { res.writeHead(200); res.end('x'); });
  const r = await runHook(s.port, {});
  s.server.close();
  assert.equal(r.code, 0);
  assert.equal(s.seen.length, 0);
});

test('the port can come as the first argument, as the installer writes it', async () => {
  const s = await stub((req, res) => { res.writeHead(200); res.end('via argv'); });
  const r = await new Promise((resolve) => {
    const child = spawn(process.execPath, [script, String(s.port)], { env: { ...process.env, CLAUDE_PANEL_PORT: '' } });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('exit', (code) => resolve({ code, stderr }));
    child.stdin.end(JSON.stringify({ session_id: 'abc' }));
  });
  s.server.close();
  assert.equal(r.code, 2);
  assert.equal(r.stderr.trim(), 'via argv');
});
