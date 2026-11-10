'use strict';
// The tasks service runs here against a stand-in TickTick over real HTTP, the
// same client code the NucBox runs against api.ticktick.com.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const svc = require('../tasks-service.js');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function shut(server) {
  return new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
}

// A TickTick with one "Work" list and a "Home" list, recording every request.
async function fakeTickTick(opts) {
  const o = opts || {};
  const seen = [];
  const tasks = {
    t1: { id: 't1', projectId: 'w', title: 'Write report', status: 0, sortOrder: 2, items: [
      { id: 'i1', title: 'Outline', status: 0, sortOrder: 0 },
      { id: 'i2', title: 'Draft', status: 1, sortOrder: 1048576 },
    ] },
    t0: { id: 't0', projectId: 'w', title: 'Email Sam', status: 0, sortOrder: 1 },
    tdone: { id: 'tdone', projectId: 'w', title: 'Old', status: 2, sortOrder: 0 },
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : null;
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: parsed });
      const reply = (status, b) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(b === undefined ? '' : JSON.stringify(b)); };
      if (o.reject) return reply(401, {});
      const u = req.url.replace(/^\/open\/v1/, '');
      let m;
      if (u === '/project' && req.method === 'GET') return reply(200, [{ id: 'h', name: 'Home' }, { id: 'w', name: 'work' }]);
      if (u === '/project/w/data') return reply(200, { project: { id: 'w' }, tasks: Object.values(tasks) });
      if ((m = /^\/project\/w\/task\/(\w+)$/.exec(u)) && req.method === 'GET') {
        return tasks[m[1]] ? reply(200, tasks[m[1]]) : reply(404, {});
      }
      if ((m = /^\/project\/w\/task\/(\w+)\/complete$/.exec(u))) { tasks[m[1]].status = 2; return reply(200); }
      if (u === '/task' && req.method === 'POST') { const t = Object.assign({ id: 'new1', status: 0 }, parsed); tasks[t.id] = t; return reply(200, t); }
      if ((m = /^\/task\/(\w+)$/.exec(u)) && req.method === 'POST') {
        if (o.itemsFull && parsed.items && parsed.items.length > 19) return reply(400, {});
        Object.assign(tasks[m[1]], parsed);
        return reply(200, tasks[m[1]]);
      }
      reply(404, {});
    });
  });
  const port = await listen(server);
  return { port, seen, tasks, close: () => shut(server) };
}

async function withService(tt, extra, fn) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-test-')), 'focus.json');
  let clock = 1_000_000;
  const now = () => clock;
  const client = svc.createTickTick('tt-secret', { baseUrl: 'http://127.0.0.1:' + tt.port + '/open/v1' });
  const server = svc.createService(Object.assign({
    tasks: svc.createTasks(client, 'Work', now),
    focus: svc.createFocus(file, now),
    transcribe: async () => 'hello',
    panelToken: 'panel-secret',
    now,
  }, extra));
  const port = await listen(server);
  const call = async (method, p, body, headers) => {
    const res = await fetch('http://127.0.0.1:' + port + p, {
      method,
      headers: Object.assign({ Authorization: 'Bearer panel-secret' }, body !== undefined ? { 'Content-Type': 'application/json' } : {}, headers),
      body: body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  };
  try { return await fn(call, { file, tick: (ms) => { clock += ms; } }); } finally { await shut(server); }
}

test('every route needs the panel token; a CORS preflight does not', async () => {
  const tt = await fakeTickTick();
  await withService(tt, {}, async (call) => {
    assert.equal((await call('GET', '/tasks', undefined, { Authorization: 'Bearer nope' })).status, 401);
    assert.equal((await call('GET', '/tasks', undefined, { Authorization: '' })).status, 401);
    const pre = await call('OPTIONS', '/tasks', undefined, { Authorization: '' });
    assert.equal(pre.status, 204);
    assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/);
    assert.equal(tt.seen.length, 0, 'nothing reached TickTick');
  });
  await tt.close();
});

test('lists the work list\'s open tasks in order, with subtasks, and never sends the panel token on', async () => {
  const tt = await fakeTickTick();
  await withService(tt, {}, async (call) => {
    const r = await call('GET', '/tasks');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.list, { id: 'w', name: 'Work' }, 'matched without case');
    assert.deepEqual(r.body.tasks.map((t) => t.title), ['Email Sam', 'Write report']);
    assert.deepEqual(r.body.tasks[1].items, [
      { id: 'i1', title: 'Outline', done: false }, { id: 'i2', title: 'Draft', done: true },
    ]);
    assert.equal(r.body.focus, null);
    assert.ok(tt.seen.every((s) => s.auth === 'Bearer tt-secret'));
    await call('GET', '/tasks');
    assert.equal(tt.seen.filter((s) => /data$/.test(s.url)).length, 1, 'a second read within 15 s is cached');
    await call('GET', '/tasks?fresh=1');
    assert.equal(tt.seen.filter((s) => /data$/.test(s.url)).length, 2);
  });
  await tt.close();
});

test('a new task goes to the work list with only a title', async () => {
  const tt = await fakeTickTick();
  await withService(tt, {}, async (call) => {
    const r = await call('POST', '/tasks', { title: '  Call   the bank ' });
    assert.equal(r.status, 200);
    const post = tt.seen.find((s) => s.method === 'POST' && /\/task$/.test(s.url));
    assert.deepEqual(post.body, { title: 'Call the bank', projectId: 'w' });
    assert.equal((await call('POST', '/tasks', { title: '   ' })).status, 400);
  });
  await tt.close();
});

test('a subtask is added after a fresh read, keeping items added elsewhere', async () => {
  const tt = await fakeTickTick();
  await withService(tt, {}, async (call) => {
    tt.tasks.t1.items.push({ id: 'i3', title: 'From the phone', status: 0, sortOrder: 2 * 1048576 });
    const r = await call('POST', '/tasks/t1/items', { title: 'Proofread' });
    assert.deepEqual(r.body, { outcome: 'added' });
    const write = tt.seen.find((s) => s.method === 'POST' && s.url.endsWith('/task/t1'));
    assert.deepEqual(Object.keys(write.body).sort(), ['id', 'items', 'projectId']);
    assert.deepEqual(write.body.items.map((i) => i.title), ['Outline', 'Draft', 'From the phone', 'Proofread']);
    assert.equal(write.body.items[3].sortOrder, 3 * 1048576);
    assert.deepEqual((await call('POST', '/tasks/t1/items', { title: 'outline' })).body, { outcome: 'duplicate' });
    assert.deepEqual((await call('POST', '/tasks/t1/items', { title: 'Draft' })).body, { outcome: 'unticked' });
    assert.equal((await call('POST', '/tasks/missing/items', { title: 'x' })).body.error, 'task-gone');
  });
  await tt.close();
});

test('a full checklist on the free plan says so', async () => {
  const tt = await fakeTickTick({ itemsFull: true });
  for (let i = 0; i < 18; i++) tt.tasks.t1.items.push({ id: 'x' + i, title: 'Item ' + i, status: 0, sortOrder: i + 10 });
  await withService(tt, {}, async (call) => {
    const r = await call('POST', '/tasks/t1/items', { title: 'One too many' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'items-full');
  });
  await tt.close();
});

test('a subtask ticks off and back on; a task completes once', async () => {
  const tt = await fakeTickTick();
  await withService(tt, {}, async (call) => {
    assert.deepEqual((await call('POST', '/tasks/t1/items/i1/toggle')).body, { done: true });
    assert.equal(tt.tasks.t1.items[0].status, 1);
    assert.deepEqual((await call('POST', '/tasks/t1/items/i1/toggle')).body, { done: false });
    assert.deepEqual((await call('POST', '/tasks/t0/complete')).body, { outcome: 'completed' });
    assert.deepEqual((await call('POST', '/tasks/t0/complete')).body, { outcome: 'moved' });
  });
  await tt.close();
});

test('a refused TickTick token is not mistaken for a refused panel token', async () => {
  const tt = await fakeTickTick({ reject: true });
  await withService(tt, {}, async (call) => {
    const r = await call('GET', '/tasks');
    assert.equal(r.status, 502);
    assert.equal(r.body.error, 'ticktick-token-rejected');
  });
  await tt.close();
});

test('a list that is not there is named as such', async () => {
  const tt = await fakeTickTick();
  const client = svc.createTickTick('tt-secret', { baseUrl: 'http://127.0.0.1:' + tt.port + '/open/v1' });
  await withService(tt, { tasks: svc.createTasks(client, 'Errands', Date.now) }, async (call) => {
    assert.equal((await call('GET', '/tasks')).body.error, 'list-not-found');
  });
  await tt.close();
});

test('the focus timer starts, survives a restart, stops, and goes when its task is completed', async () => {
  const tt = await fakeTickTick();
  await withService(tt, {}, async (call, ctl) => {
    assert.equal((await call('POST', '/focus', { taskId: 't1', title: 'Write report', minutes: 0 })).status, 400);
    assert.equal((await call('POST', '/focus', { taskId: 't1', minutes: 500 })).status, 400);
    const r = await call('POST', '/focus', { taskId: 't1', title: 'Write report', minutes: 25 });
    assert.equal(r.body.focus.endsAt - r.body.focus.startedAt, 25 * 60000);
    assert.equal(r.body.now, r.body.focus.startedAt);
    const again = svc.createFocus(ctl.file, () => 0);
    assert.equal(again.get().taskId, 't1', 'read back from its file');
    assert.equal((await call('GET', '/tasks')).body.focus.minutes, 25);
    assert.equal((await call('DELETE', '/focus')).body.focus, null);
    assert.equal(fs.existsSync(ctl.file), false);
    await call('POST', '/focus', { taskId: 't0', minutes: 5 });
    await call('POST', '/tasks/t0/complete');
    assert.equal((await call('GET', '/focus')).body.focus, null);
  });
  await tt.close();
});

test('the recording is handed to the transcriber with its type', async () => {
  const tt = await fakeTickTick();
  let got = null;
  await withService(tt, { transcribe: async (audio, mime) => { got = { n: audio.length, mime }; return 'buy milk'; } }, async (call) => {
    const r = await call('POST', '/transcribe', Buffer.alloc(100), { 'Content-Type': 'audio/wav' });
    assert.deepEqual(r.body, { text: 'buy milk' });
    assert.deepEqual(got, { n: 100, mime: 'audio/wav' });
  });
  await tt.close();
});

function wav(rate, channels, seconds) {
  const samples = Math.round(rate * seconds) * channels;
  const b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(channels, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * channels * 2, 28); b.writeUInt16LE(channels * 2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(samples * 2, 40);
  return b;
}

test('the Car Thing\'s 16 kHz mono WAV goes straight to whisper; anything else through ffmpeg', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-whisper-'));
  const runs = [];
  const run = async (cmd, args) => {
    runs.push(cmd);
    if (cmd === 'ffmpeg') fs.writeFileSync(args[args.length - 1], wav(16000, 1, 1));
    return { stdout: '[BLANK_AUDIO]\n Buy oat milk.\n (wind blowing)\n' };
  };
  const s = { whisperCli: 'whisper-cli', whisperModel: 'model.bin', ffmpeg: 'ffmpeg' };
  const t = svc.createTranscriber(s, { run, tmpDir: dir, exists: () => true });
  assert.equal(svc.isWhisperWav(wav(16000, 1, 1)), true);
  assert.equal(svc.isWhisperWav(wav(44100, 1, 1)), false);
  assert.equal(await t(wav(16000, 1, 2), 'audio/wav'), 'Buy oat milk.');
  assert.deepEqual(runs, ['whisper-cli']);
  runs.length = 0;
  assert.equal(await t(Buffer.from('webm bytes'), 'audio/webm;codecs=opus'), 'Buy oat milk.');
  assert.deepEqual(runs, ['ffmpeg', 'whisper-cli']);
  await assert.rejects(t(wav(16000, 1, 31), 'audio/wav'), /too-long/);
  assert.deepEqual(fs.readdirSync(dir), [], 'no recording is left behind');
  const unset = svc.createTranscriber(s, { run, tmpDir: dir, exists: () => false });
  await assert.rejects(unset(wav(16000, 1, 1), 'audio/wav'), /dictation-not-set-up/);
});

test('settings come from tasks.env, the environment winning', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-env-'));
  fs.writeFileSync(path.join(dir, 'tasks.env'), '# secrets\nTICKTICK_TOKEN=abc\r\nPANEL_TOKEN="p q"\nTASKS_LIST=Work\n');
  const s = svc.loadSettings({ TASKS_LIST: 'Office' }, dir);
  assert.equal(s.ticktickToken, 'abc');
  assert.equal(s.panelToken, 'p q');
  assert.equal(s.listName, 'Office');
  assert.equal(s.port, 8791);
});
