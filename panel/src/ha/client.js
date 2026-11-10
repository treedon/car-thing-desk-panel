// The panel's own connection to Home Assistant's WebSocket API, so the home
// screens work whether or not the Mac is awake. Documented messages only:
// auth, get_states, subscribe_events (state_changed), call_service, ping.
// Reconnects with backoff (capped at 30 s); a link silent for silenceMs is
// treated as dead. A rejected token stops it until start() is called again.

export function createHaClient(opts) {
  var url = opts.url;
  var token = opts.token;
  var WS = opts.WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);
  var now = opts.now || function () { return Date.now(); };
  var pingMs = opts.pingMs || 10000;
  var silenceMs = opts.silenceMs || 25000;
  var backoffBaseMs = opts.backoffBaseMs || 1000;
  var backoffMaxMs = 30000;

  var listeners = { state: [], status: [] };
  var states = {};
  var socket = null;
  var nextId = 1;
  var pending = {};          // id -> {resolve, reject}
  var statesId = 0;
  var status = 'idle';
  var stopped = true;
  var attempts = 0;
  var lastHeard = 0;
  var pinger = null;
  var retry = null;

  function emit(kind) {
    var args = Array.prototype.slice.call(arguments, 1);
    var fns = listeners[kind] || [];
    for (var i = 0; i < fns.length; i++) fns[i].apply(null, args);
  }

  function setStatus(s) {
    if (s === status) return;
    status = s;
    emit('status', s);
  }

  function send(msg) {
    msg.id = nextId++;
    try { socket.send(JSON.stringify(msg)); } catch (e) {}
    return msg.id;
  }

  function failPending(why) {
    for (var id in pending) { pending[id].reject(new Error(why)); delete pending[id]; }
  }

  function dropSocket() {
    if (pinger) { clearInterval(pinger); pinger = null; }
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      try { socket.close(); } catch (e) {}
      socket = null;
    }
    failPending('home-assistant-offline');
  }

  function scheduleRetry() {
    if (stopped || status === 'unauthorized') return;
    setStatus('offline');
    attempts++;
    var delay = Math.min(backoffBaseMs * Math.pow(2, attempts - 1), backoffMaxMs);
    retry = setTimeout(connect, delay);
  }

  function onMessage(raw) {
    lastHeard = now();
    var m;
    try { m = JSON.parse(typeof raw === 'string' ? raw : String(raw)); } catch (e) { return; }
    if (m.type === 'auth_required') {
      socket.send(JSON.stringify({ type: 'auth', access_token: token }));
    } else if (m.type === 'auth_ok') {
      attempts = 0;
      setStatus('online');
      statesId = send({ type: 'get_states' });
      send({ type: 'subscribe_events', event_type: 'state_changed' });
    } else if (m.type === 'auth_invalid') {
      // Stopped until start() is called again (with setToken() first).
      stopped = true;
      setStatus('unauthorized');
      dropSocket();
    } else if (m.type === 'result') {
      if (m.id === statesId && m.success) {
        states = {};
        var list = m.result || [];
        for (var i = 0; i < list.length; i++) states[list[i].entity_id] = list[i];
        for (var j = 0; j < list.length; j++) emit('state', list[j].entity_id, list[j]);
      }
      var p = pending[m.id];
      if (p) {
        delete pending[m.id];
        if (m.success) p.resolve(m.result);
        else p.reject(new Error((m.error && (m.error.message || m.error.code)) || 'service-failed'));
      }
    } else if (m.type === 'event' && m.event && m.event.event_type === 'state_changed') {
      var d = m.event.data || {};
      if (d.new_state) states[d.entity_id] = d.new_state;
      else delete states[d.entity_id];
      emit('state', d.entity_id, d.new_state || null);
    }
  }

  function connect() {
    retry = null;
    if (stopped) return;
    setStatus('connecting');
    try {
      socket = new WS(url.replace(/^http/, 'ws') + '/api/websocket');
    } catch (e) {
      return scheduleRetry();
    }
    lastHeard = now();
    socket.onmessage = function (e) { onMessage(e.data); };
    socket.onclose = function () { dropSocket(); scheduleRetry(); };
    socket.onerror = function () {};
    pinger = setInterval(function () {
      if (now() - lastHeard > silenceMs) {
        dropSocket();
        return scheduleRetry();
      }
      if (status === 'online') send({ type: 'ping' });
    }, pingMs);
  }

  return {
    start: function () {
      if (!stopped) return;
      stopped = false;
      attempts = 0;
      status = 'idle';
      connect();
    },
    stop: function () {
      stopped = true;
      if (retry) { clearTimeout(retry); retry = null; }
      dropSocket();
    },
    setToken: function (t) { token = t; },
    on: function (kind, fn) { (listeners[kind] = listeners[kind] || []).push(fn); },
    states: function () { return states; },
    status: function () { return status; },
    callService: function (domain, service, data, target) {
      return new Promise(function (resolve, reject) {
        if (status !== 'online' || !socket) return reject(new Error('home-assistant-offline'));
        var id = send({ type: 'call_service', domain: domain, service: service, service_data: data || {}, target: target || {} });
        pending[id] = { resolve: resolve, reject: reject };
      });
    },
  };
}
