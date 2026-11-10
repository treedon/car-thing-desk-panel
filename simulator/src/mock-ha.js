// A small stand-in for Home Assistant's WebSocket API, for tests and the
// simulator's demo house. It speaks auth, get_states, subscribe_events
// (state_changed), call_service and ping, and applies the obvious effect of
// the services the panel uses.
import http from 'node:http';
import { WebSocketServer } from 'ws';

function clone(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }

function applyService(states, domain, service, data, target) {
  const ids = [].concat((target && target.entity_id) || []);
  for (const id of ids) {
    const s = states.get(id);
    if (!s) continue;
    const a = s.attributes || (s.attributes = {});
    if (domain === 'light' || domain === 'switch') {
      if (service === 'toggle') s.state = s.state === 'on' ? 'off' : 'on';
      if (service === 'turn_off') s.state = 'off';
      if (service === 'turn_on') {
        s.state = 'on';
        if (data && data.brightness_pct != null) a.brightness = Math.round(data.brightness_pct * 2.55);
      }
      if (s.state === 'off') delete a.brightness;
    }
    if (domain === 'scene' && service === 'turn_on') s.state = new Date().toISOString();
    if (domain === 'media_player') {
      if (service === 'volume_set' && data) a.volume_level = data.volume_level;
      if (service === 'media_play_pause') s.state = s.state === 'playing' ? 'paused' : 'playing';
      if (service === 'media_next_track') a.media_title = 'Next track';
    }
  }
  return ids;
}

export function startMockHa({ port = 0, token = 'demo', states = [] } = {}) {
  const map = new Map(states.map((s) => [s.entity_id, clone(s)]));
  const calls = [];
  const subscribers = new Set(); // {socket, id}
  let frozen = false;
  let connections = 0;

  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ server, path: '/api/websocket' });

  function changed(id, newState) {
    for (const sub of subscribers) {
      if (sub.socket.readyState !== 1) continue;
      sub.socket.send(JSON.stringify({
        id: sub.id, type: 'event',
        event: { event_type: 'state_changed', data: { entity_id: id, new_state: clone(newState) } },
      }));
    }
  }

  wss.on('connection', (socket) => {
    connections++;
    let authed = false;
    socket.send(JSON.stringify({ type: 'auth_required', ha_version: 'mock' }));
    socket.on('message', (raw) => {
      if (frozen) return;
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (!authed) {
        if (m.type === 'auth' && m.access_token === token) {
          authed = true;
          socket.send(JSON.stringify({ type: 'auth_ok' }));
        } else {
          socket.send(JSON.stringify({ type: 'auth_invalid', message: 'Invalid access token' }));
          socket.close();
        }
        return;
      }
      const reply = (result) => socket.send(JSON.stringify({ id: m.id, type: 'result', success: true, result }));
      if (m.type === 'get_states') return reply([...map.values()].map(clone));
      if (m.type === 'subscribe_events') { subscribers.add({ socket, id: m.id }); return reply(null); }
      if (m.type === 'ping') return socket.send(JSON.stringify({ id: m.id, type: 'pong' }));
      if (m.type === 'call_service') {
        calls.push({ domain: m.domain, service: m.service, service_data: m.service_data || {}, target: m.target || {} });
        const ids = applyService(map, m.domain, m.service, m.service_data, m.target);
        reply({ context: { id: 'mock' } });
        for (const id of ids) changed(id, map.get(id));
        return;
      }
      socket.send(JSON.stringify({ id: m.id, type: 'result', success: false, error: { code: 'unknown_command' } }));
    });
    socket.on('close', () => { for (const s of subscribers) if (s.socket === socket) subscribers.delete(s); });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      resolve({
        port: actual,
        url: `http://127.0.0.1:${actual}`,
        calls,
        connections: () => connections,
        states: () => [...map.values()].map(clone),
        setState(id, state) {
          if (state === null) map.delete(id); else map.set(id, clone(state));
          changed(id, state);
        },
        freeze(on) { frozen = !!on; },
        close() {
          for (const c of wss.clients) c.terminate();
          return new Promise((r) => { wss.close(); server.close(() => r()); });
        },
      });
    });
  });
}
