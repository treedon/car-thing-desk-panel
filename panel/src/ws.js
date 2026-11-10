// The panel's links to the session services: the Mac's, and the NucBox's when
// PANEL_CONFIG.nucboxSessions is set (Claude Code sessions run on both). Each
// link is a WebSocket to a service's /ws: id-correlated requests, backoff
// reconnect (capped at 30 s), and bridge.hello {role:'panel'} first on every
// connection, with anything requested before its answer held until then.
//
// The app sees one service. This module merges the two:
//   - sessions and the waiting list come from both, each session and ask
//     tagged with the machine it runs on (machine: 'NucBox' off the Mac);
//   - a request about a session or an ask goes to the machine that owns it;
//     a list goes to both and is merged; anything else (usage, the digest,
//     dictation, ping) goes to the Mac. Starting a session and listing recent
//     projects go to the machine the request names (params.host), and fail
//     with not-answering or unknown-host; machines() lists them for the picker;
//   - onOpen/onClose and the Mac's own events (power, usage, the digest,
//     daemon status) follow the Mac's link only: the screen's sleep rules,
//     the "Mac offline" banner and the digest are about the Mac. The NucBox's
//     link coming or going refreshes the merged lists instead.
// Event handlers get (data, frame); frame.host says which machine sent it.

import { unbool, observeProbe, shouldUnbool } from './numbers.js';
import { readConfig, serviceWsUrl } from './config.js';
import { createLiveness } from './liveness.js';
import { createMux } from './ws-mux.js';

var PING_MS = 5000;
var SILENCE_MS = 15000;

function uuid() {
  // no crypto.randomUUID on Chrome 69
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    var r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// One service. onFrame(frame) gets every event; onOpen/onClose its link's
// comings and goings.
function createLink(url, hooks) {
  var liveness = createLiveness({ timeoutMs: SILENCE_MS });
  var pinger = null;
  var socket = null;
  var pending = {};
  var attempts = 0;
  var ready = false;
  var waiting = [];

  function send(frame) {
    if (ready) socket.send(frame);
    else waiting.push(frame);
  }

  function lost() {
    ready = false;
    if (pinger) { clearInterval(pinger); pinger = null; }
    for (var id in pending) {
      var p = pending[id];
      delete pending[id];
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error('socket closed'));
    }
    hooks.onClose();
    attempts++;
    var delay = Math.min(1000 * Math.pow(2, attempts - 1), 30000);
    setTimeout(connect, delay);
  }

  function request(method, params, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return reject(new Error('socket not open'));
      }
      var id = uuid();
      var timer = setTimeout(function () {
        delete pending[id];
        reject(new Error('timeout: ' + method));
      }, timeoutMs || 10000);
      pending[id] = { resolve: resolve, reject: reject, timer: timer };
      send(JSON.stringify({ type: 'request', id: id, method: method, params: params || {} }));
    });
  }

  function connect() {
    ready = false;
    waiting = [];
    socket = new WebSocket(url);

    socket.onopen = function () {
      attempts = 0;
      liveness.heard();
      if (pinger) clearInterval(pinger);
      pinger = setInterval(function () {
        if (liveness.dead()) {
          clearInterval(pinger);
          pinger = null;
          // close() on a dead link can wait minutes for the TCP teardown; drop
          // it from here and reconnect now.
          var dead = socket;
          dead.onclose = null;
          try { dead.close(); } catch (e) {}
          lost();
          return;
        }
        if (ready) request('claude.ping', {}, PING_MS).catch(function () {});
      }, PING_MS);
      var id = uuid();
      pending[id] = {
        resolve: function () {
          ready = true;
          var held = waiting;
          waiting = [];
          for (var j = 0; j < held.length; j++) socket.send(held[j]);
          hooks.onOpen();
        },
        reject: function () { try { socket.close(); } catch (e) {} },
        timer: null,
      };
      socket.send(JSON.stringify({
        type: 'request', id: id, method: 'bridge.hello',
        params: { role: 'panel', info: { screen: '800x480' } },
      }));
    };

    socket.onmessage = function (m) {
      liveness.heard();
      var f;
      try { f = JSON.parse(m.data); } catch (e) { return; }
      // Walk every frame only while the link is known (or suspected) to coerce
      // ints — snapshots carry an intProbe that says either way. See numbers.js.
      var body = f.type === 'response' ? f.result : f.data;
      if (body && body.intProbe !== undefined) observeProbe(body.intProbe);
      if (shouldUnbool()) unbool(body);
      if (f.type === 'event' && f.topic) return hooks.onFrame(f);
      if ((f.type === 'response' || f.type === 'error') && pending[f.id]) {
        var p = pending[f.id];
        delete pending[f.id];
        clearTimeout(p.timer);
        if (f.type === 'response') p.resolve(f.result);
        else p.reject(new Error(f.error || 'request failed'));
      }
    };

    socket.onclose = lost;
    socket.onerror = function () {
      try { socket.close(); } catch (e) {}
    };
  }

  return { connect: connect, request: request, isReady: function () { return ready; } };
}

var cfg = readConfig(window.PANEL_CONFIG);
var hostDefs = [{ name: 'mac', url: serviceWsUrl(cfg) }];
if (cfg.nucboxSessions) {
  hostDefs.push({ name: 'nucbox', label: 'NucBox', url: serviceWsUrl({ serviceUrl: cfg.nucboxSessions.url, token: cfg.nucboxSessions.token }) });
}

var mux = createMux({ hosts: hostDefs, primary: 'mac', createLink: createLink });

export var request = mux.request;
export var on = mux.on;
export var onOpen = mux.onOpen;
export var onClose = mux.onClose;
export var primaryReady = mux.primaryReady;
export var machines = mux.machines;

mux.start();
