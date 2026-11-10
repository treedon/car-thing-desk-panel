// claude.session.watch narrows one socket's claude.session.update stream to a
// single session. Everything else — snapshots, asks, other sockets — must be
// untouched by it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHub } from '../src/hub.js';

function fakeSocket() {
  const sock = new EventEmitter();
  sock.OPEN = 1;
  sock.readyState = 1;
  sock.bufferedAmount = 0;
  sock.frames = [];
  sock.send = (raw) => sock.frames.push(JSON.parse(raw));
  return sock;
}

function connect(hub, role) {
  const sock = fakeSocket();
  hub.wss.emit('connection', sock);
  sock.emit('message', Buffer.from(JSON.stringify({
    type: 'request', id: 'hello', method: 'bridge.hello', params: { role },
  })));
  sock.frames.length = 0; // drop the hello response + bridge.clients noise
  return sock;
}

function watch(sock, id) {
  sock.emit('message', Buffer.from(JSON.stringify({
    type: 'request', id: 'w', method: 'claude.session.watch', params: { id },
  })));
}

function eventsOf(sock, topic) {
  return sock.frames.filter((f) => f.type === 'event' && f.topic === topic);
}

test('a socket that never watches receives every detail', () => {
  const hub = createHub();
  const sock = connect(hub, 'webpage');
  hub.emit('claude.session.update', { id: 'a' });
  hub.emit('claude.session.update', { id: 'b' });
  assert.equal(eventsOf(sock, 'claude.session.update').length, 2);
});

test('a watching socket receives only its session, and the ack', () => {
  const hub = createHub();
  const sock = connect(hub, 'emulator');
  watch(sock, 'a');
  const ack = sock.frames.find((f) => f.type === 'response' && f.id === 'w');
  assert.deepEqual(ack.result, { ok: true });
  hub.emit('claude.session.update', { id: 'a' });
  hub.emit('claude.session.update', { id: 'b' });
  const got = eventsOf(sock, 'claude.session.update');
  assert.equal(got.length, 1);
  assert.equal(got[0].data.id, 'a');
});

test('watching null suppresses every detail', () => {
  const hub = createHub();
  const sock = connect(hub, 'emulator');
  watch(sock, null);
  hub.emit('claude.session.update', { id: 'a' });
  assert.equal(eventsOf(sock, 'claude.session.update').length, 0);
});

test('watch never filters snapshots or asks', () => {
  const hub = createHub();
  const sock = connect(hub, 'emulator');
  watch(sock, 'a');
  hub.emit('claude.sessions.update', { sessions: [{ id: 'b' }] });
  hub.emit('claude.permission.request', { requestId: 'r', sessionId: 'b' });
  assert.equal(eventsOf(sock, 'claude.sessions.update').length, 1);
  assert.equal(eventsOf(sock, 'claude.permission.request').length, 1);
});

test('one socket watching leaves another unfiltered', () => {
  const hub = createHub();
  const watcher = connect(hub, 'emulator');
  const bystander = connect(hub, 'webpage');
  watch(watcher, 'a');
  hub.emit('claude.session.update', { id: 'b' });
  assert.equal(eventsOf(watcher, 'claude.session.update').length, 0);
  assert.equal(eventsOf(bystander, 'claude.session.update').length, 1);
});

test('a re-watch moves the filter; a reconnect clears it', () => {
  const hub = createHub();
  let sock = connect(hub, 'emulator');
  watch(sock, 'a');
  watch(sock, 'b');
  hub.emit('claude.session.update', { id: 'a' });
  hub.emit('claude.session.update', { id: 'b' });
  let got = eventsOf(sock, 'claude.session.update');
  assert.equal(got.length, 1);
  assert.equal(got[0].data.id, 'b');

  // A new connection is a new socket: no watch until it says so.
  sock.emit('close');
  sock = connect(hub, 'emulator');
  hub.emit('claude.session.update', { id: 'a' });
  assert.equal(eventsOf(sock, 'claude.session.update').length, 1);
});

test('onClose fires after a socket leaves, with the remaining roles', () => {
  const seen = [];
  const hub = createHub({ onClose: (roles) => seen.push(roles) });
  const a = connect(hub, 'panel');
  connect(hub, 'webpage');
  a.emit('close');
  assert.deepEqual(seen, [{ webpage: 1 }]);
});

test('panelOnline counts panel and the legacy emulator role', () => {
  const hub = createHub();
  assert.equal(hub.panelOnline(), false);
  connect(hub, 'webpage');
  assert.equal(hub.panelOnline(), false);
  const e = connect(hub, 'emulator');
  assert.equal(hub.panelOnline(), true);
  e.emit('close');
  connect(hub, 'panel');
  assert.equal(hub.panelOnline(), true);
});

// ---- heartbeat (final review C2): a client gone without a FIN ---------------

test('a socket that stops answering pings is dropped, and onClose fires', () => {
  const closed = [];
  const hub = createHub({ onClose: (roles) => closed.push(roles), heartbeatMs: 0 });
  const sock = connect(hub, 'panel');
  let pings = 0, terminated = 0;
  sock.ping = () => { pings++; };
  sock.terminate = () => { terminated++; sock.emit('close'); };
  hub.sweep();                      // ping 1
  sock.emit('pong');                // answered
  hub.sweep();                      // ping 2
  hub.sweep();                      // missed one
  assert.equal(terminated, 0, 'one missed pong is tolerated');
  hub.sweep();                      // missed two
  assert.equal(terminated, 1);
  assert.equal(hub.panelOnline(), false);
  assert.deepEqual(closed, [{}]);
  assert.ok(pings >= 3);
});

// ---- superseding frames for a backed-up socket ------------------------------

test('digest updates are dropped for a backed-up socket; asks are not', () => {
  const hub = createHub({ heartbeatMs: 0 });
  const sock = connect(hub, 'panel');
  sock.bufferedAmount = 128 * 1024;
  hub.emit('claude.digest.update', { cards: [] });
  hub.emit('claude.permission.request', { requestId: 'r' });
  assert.deepEqual(
    [eventsOf(sock, 'claude.digest.update').length, eventsOf(sock, 'claude.permission.request').length],
    [0, 1],
  );
});

test('a socket that is keeping up receives digest updates', () => {
  const hub = createHub({ heartbeatMs: 0 });
  const sock = connect(hub, 'panel');
  hub.emit('claude.digest.update', { cards: [] });
  assert.equal(eventsOf(sock, 'claude.digest.update').length, 1);
});
