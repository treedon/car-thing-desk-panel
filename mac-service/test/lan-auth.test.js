import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { authorizeUpgrade, isLoopback, loadOrCreateToken } from '../src/lan-auth.js';

test('isLoopback knows the three loopback spellings', () => {
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopback(a), true, a);
  assert.equal(isLoopback('192.168.1.40'), false);
  assert.equal(isLoopback(undefined), false);
});

test('loopback needs no token', () => {
  assert.equal(authorizeUpgrade({ remoteAddress: '127.0.0.1', url: '/ws', token: 'abc' }), true);
  assert.equal(authorizeUpgrade({ remoteAddress: '::ffff:127.0.0.1', url: '/ws', token: 'abc' }), true);
});

test('LAN needs the exact token', () => {
  assert.equal(authorizeUpgrade({ remoteAddress: '192.168.1.40', url: '/ws', token: 'abc' }), false);
  assert.equal(authorizeUpgrade({ remoteAddress: '192.168.1.40', url: '/ws?token=nope', token: 'abc' }), false);
  assert.equal(authorizeUpgrade({ remoteAddress: '192.168.1.40', url: '/ws?token=abc', token: 'abc' }), true);
});

test('only /ws upgrades, even with the token', () => {
  assert.equal(authorizeUpgrade({ remoteAddress: '192.168.1.40', url: '/other?token=abc', token: 'abc' }), false);
});

test('token file is created once with 0600', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tok-'));
  const a = loadOrCreateToken(dir), b = loadOrCreateToken(dir);
  assert.equal(a, b); assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(path.join(dir, 'token')).mode & 0o777, 0o600);
});

// ---- browsers and DNS rebinding (final review C1, I5) ------------------------
import { authorizeHttp } from '../src/lan-auth.js';

const SIM = ['http://127.0.0.1:8091', 'http://localhost:8091'];

test('a web page in the owner\'s browser cannot open the loopback socket', () => {
  const base = { remoteAddress: '127.0.0.1', url: '/ws', token: 'abc', port: 8790, allowedOrigins: SIM, host: '127.0.0.1:8790' };
  assert.equal(authorizeUpgrade({ ...base, origin: 'https://evil.example' }), false);
  assert.equal(authorizeUpgrade({ ...base, origin: 'http://127.0.0.1:8091' }), true, 'the simulator');
  assert.equal(authorizeUpgrade({ ...base, origin: undefined }), true, 'non-browser clients on this Mac');
});

test('a rebound hostname cannot reach the loopback socket', () => {
  const base = { remoteAddress: '127.0.0.1', url: '/ws', token: 'abc', port: 8790, allowedOrigins: SIM };
  assert.equal(authorizeUpgrade({ ...base, host: 'evil.example:8790' }), false);
  assert.equal(authorizeUpgrade({ ...base, host: 'localhost:8790' }), true);
});

test('the LAN still needs only the token, whatever the origin', () => {
  const base = { remoteAddress: '192.168.1.40', token: 'abc', port: 8790, allowedOrigins: SIM, host: '192.168.1.20:8790', origin: 'http://localhost:3000' };
  assert.equal(authorizeUpgrade({ ...base, url: '/ws?token=abc' }), true);
  assert.equal(authorizeUpgrade({ ...base, url: '/ws' }), false);
});

test('plain HTTP routes: loopback, a loopback Host, and no foreign Origin', () => {
  const ok = { remoteAddress: '127.0.0.1', host: '127.0.0.1:8790', port: 8790 };
  assert.equal(authorizeHttp(ok), true, 'a hook (no Origin)');
  assert.equal(authorizeHttp({ ...ok, origin: 'https://evil.example' }), false, 'cross-site form post');
  assert.equal(authorizeHttp({ ...ok, host: 'evil.example:8790' }), false, 'DNS rebinding');
  assert.equal(authorizeHttp({ ...ok, remoteAddress: '192.168.1.40' }), false, 'the LAN');
  assert.equal(authorizeHttp({ ...ok, origin: 'http://127.0.0.1:8790' }), true, 'its own page');
});
