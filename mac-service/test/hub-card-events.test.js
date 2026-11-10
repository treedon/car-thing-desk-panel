// A backed-up socket may skip a session snapshot (the next one supersedes it),
// but never a card: an ASKING card dropped there is an ask the owner never sees.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHub } from '../src/hub.js';

function backedUpSocket() {
  const sock = new EventEmitter();
  sock.OPEN = 1;
  sock.readyState = 1;
  sock.bufferedAmount = 10 * 1024 * 1024;
  sock.frames = [];
  sock.send = (raw) => sock.frames.push(JSON.parse(raw));
  return sock;
}

test('card events reach a backed-up socket, session snapshots do not', () => {
  const hub = createHub();
  const sock = backedUpSocket();
  hub.wss.emit('connection', sock);
  hub.emit('claude.sessions.update', { sessions: [] });
  hub.emit('claude.card.posted', { kind: 'card', id: 'card:a:1', sessionId: 'a' });
  hub.emit('claude.card.cleared', { id: 'card:a:1', sessionId: 'a', reason: 'cleared' });
  assert.deepEqual(sock.frames.map((f) => f.topic), ['claude.card.posted', 'claude.card.cleared']);
});
