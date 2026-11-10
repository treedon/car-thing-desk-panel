'use strict';
// A read-only window onto LM Studio for the Car Thing panel. LM Studio's own
// server has no login, so it stays on localhost; this is all the LAN sees: the
// list of loaded models (id, type, state) at GET /api/v0/models, nothing else.
// No dependencies, so it runs on the NucBox with just Node.
//
//   node lm-relay.js        (RELAY_PORT=1235, RELAY_HOST=0.0.0.0, LM_UPSTREAM=http://127.0.0.1:1234)
const http = require('node:http');

const ROUTE = '/api/v0/models';

function createRelay(opts) {
  const upstream = opts.upstream.replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs || 2500;

  function send(res, status, body) {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(body));
  }

  return http.createServer(function (req, res) {
    if (req.url.split('?')[0] !== ROUTE) return send(res, 404, { error: 'not found' });
    if (req.method !== 'GET') return send(res, 405, { error: 'read only' });
    fetch(upstream + ROUTE, { signal: AbortSignal.timeout(timeoutMs) })
      .then(function (r) {
        if (!r.ok) throw new Error('bad status');
        return r.json();
      })
      .then(function (body) {
        // A body without a data array throws here and is answered as unreachable.
        const data = body.data
          .filter(function (m) { return m && m.state === 'loaded'; })
          .map(function (m) { return { id: m.id, type: m.type, state: m.state }; });
        send(res, 200, { data: data });
      })
      .catch(function (err) {
        if (err && err.name === 'TimeoutError') return send(res, 504, { error: 'LM Studio timed out' });
        send(res, 502, { error: 'LM Studio not reachable' });
      });
  });
}

module.exports = { createRelay };

if (require.main === module) {
  const port = Number(process.env.RELAY_PORT || 1235);
  const host = process.env.RELAY_HOST || '0.0.0.0';
  const upstream = process.env.LM_UPSTREAM || 'http://127.0.0.1:1234';
  createRelay({ upstream: upstream }).listen(port, host, function () {
    console.log('lm-relay: ' + host + ':' + port + ' -> ' + upstream + ROUTE);
  });
}
