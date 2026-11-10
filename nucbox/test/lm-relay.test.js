'use strict';
// The relay is the only thing the NucBox shows the LAN of LM Studio, so these
// tests run the real relay against a real stand-in LM Studio over HTTP.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createRelay } = require('../lm-relay.js');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function shut(server) {
  return new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
}

// A stand-in LM Studio that records every request it receives.
async function fakeLmStudio(handler) {
  const seen = [];
  const server = http.createServer((req, res) => { seen.push(req.method + ' ' + req.url); handler(req, res); });
  const port = await listen(server);
  return { port, seen, close: () => shut(server) };
}

async function withRelay(upstreamPort, opts, fn) {
  const relay = createRelay(Object.assign({ upstream: 'http://127.0.0.1:' + upstreamPort }, opts));
  const port = await listen(relay);
  try { return await fn('http://127.0.0.1:' + port); } finally { await shut(relay); }
}

// Shaped like the real GET /api/v0/models, every field LM Studio sends.
function model(id, type, state) {
  return {
    id, object: 'model', type, publisher: 'someone', arch: 'qwen35', compatibility_type: 'gguf',
    quantization: 'Q4_K_M', state, max_context_length: 262144, capabilities: ['tool_use'],
  };
}

function lmStudioWith(models) {
  return fakeLmStudio((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: models, object: 'list' }));
  });
}

test('reports only the loaded models, and only their id, type and state', async () => {
  // Catches: leaking models that aren't loaded, or LM Studio's other fields, to the LAN.
  const lm = await lmStudioWith([
    model('google/gemma-4-12b-qat', 'vlm', 'loaded'),
    model('nvidia/nemotron-3-nano-4b', 'llm', 'not-loaded'),
    model('text-embedding-nomic-embed-text-v1.5', 'embeddings', 'loaded'),
  ]);
  try {
    await withRelay(lm.port, {}, async (base) => {
      const res = await fetch(base + '/api/v0/models');
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        data: [
          { id: 'google/gemma-4-12b-qat', type: 'vlm', state: 'loaded' },
          { id: 'text-embedding-nomic-embed-text-v1.5', type: 'embeddings', state: 'loaded' },
        ],
      });
    });
  } finally { await lm.close(); }
});

test('lets a page on another origin read the answer', async () => {
  // Catches: the panel's browser blocking the response, so the view always says unreachable.
  const lm = await lmStudioWith([]);
  try {
    await withRelay(lm.port, {}, async (base) => {
      const res = await fetch(base + '/api/v0/models', { headers: { Origin: 'http://localhost' } });
      assert.equal(res.headers.get('access-control-allow-origin'), '*');
    });
  } finally { await lm.close(); }
});

test('refuses everything but GET /api/v0/models, and never forwards it', async () => {
  // Catches: the relay turning into an open proxy to LM Studio (chat, model loading, model details).
  const lm = await lmStudioWith([]);
  try {
    await withRelay(lm.port, {}, async (base) => {
      const refused = [
        ['GET', '/v1/models'],
        ['GET', '/api/v0/models/google/gemma-4-12b-qat'],
        ['GET', '/api/v0/chat/completions'],
        ['GET', '/'],
        ['POST', '/api/v0/models'],
        ['POST', '/v1/chat/completions'],
        ['DELETE', '/api/v0/models'],
      ];
      for (const [method, path] of refused) {
        const res = await fetch(base + path, { method, body: method === 'POST' ? '{}' : undefined });
        assert.ok(res.status === 404 || res.status === 405, method + ' ' + path + ' answered ' + res.status);
      }
      assert.deepEqual(lm.seen, []);
    });
  } finally { await lm.close(); }
});

test('answers 502 when LM Studio is not running', async () => {
  // Catches: a crash or a hung request when LM Studio is off, instead of a plain "unreachable".
  const lm = await lmStudioWith([]);
  const deadPort = lm.port;
  await lm.close();
  await withRelay(deadPort, {}, async (base) => {
    const res = await fetch(base + '/api/v0/models');
    assert.equal(res.status, 502);
  });
});

test('answers 504 when LM Studio takes longer than the timeout', async () => {
  // Catches: requests piling up behind a stuck LM Studio, past the panel's own 3 s patience.
  const lm = await fakeLmStudio(() => { /* never answers */ });
  try {
    await withRelay(lm.port, { timeoutMs: 150 }, async (base) => {
      // Our own deadline, so a relay with no timeout fails here instead of hanging the run.
      const res = await fetch(base + '/api/v0/models', { signal: AbortSignal.timeout(2000) });
      assert.equal(res.status, 504);
    });
  } finally { await lm.close(); }
});

test('answers 502 when LM Studio replies with an error or something that is not JSON', async () => {
  // Catches: passing a half-understood LM Studio answer on as if it were "no models loaded".
  const broken = [
    [500, '{"error":"boom"}'],
    [500, '{"data":[]}'],
    [200, '<html>not json</html>'],
    [200, '{"unexpected":true}'],
  ];
  for (const [status, body] of broken) {
    const lm = await fakeLmStudio((req, res) => { res.writeHead(status); res.end(body); });
    try {
      await withRelay(lm.port, {}, async (base) => {
        const res = await fetch(base + '/api/v0/models');
        assert.equal(res.status, 502, 'upstream ' + status + ' ' + body);
      });
    } finally { await lm.close(); }
  }
});
