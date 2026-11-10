'use strict';
// The Car Thing panel's Tasks page, served from the NucBox so it works with the
// Mac off. It holds the TickTick token (the panel never sees it), reads and
// writes one TickTick list (the work list), transcribes the panel's dictation
// with whisper.cpp on this machine, and keeps the focus timer, so a panel that
// reboots mid-pomodoro picks it back up. No dependencies: just Node 18+.
//
// TickTick is used the way the smart mirror uses it (smart-mirror
// service/mirrord/widgets/_ticktick.py): the Open API with a personal API
// token, subtasks as the task's checklist items, and every write to an
// existing task made after reading it fresh, so an edit made on the phone a
// moment ago survives.
//
// Every route but OPTIONS needs "Authorization: Bearer <PANEL_TOKEN>".
//
//   GET    /tasks                     the list's open tasks and the focus timer
//   POST   /tasks          {title}    a new task in the list
//   POST   /tasks/:id/items {title}   a new subtask (checklist item)
//   POST   /tasks/:id/items/:item/toggle   tick a subtask off, or back on
//   POST   /tasks/:id/complete        mark the task done
//   POST   /transcribe     (audio)    -> {text}; the body is the recording
//   GET    /focus                     -> {focus, now}
//   POST   /focus  {taskId, minutes}  start a focus timer on a task
//   DELETE /focus                     stop it, or clear a finished one
//
//   node tasks-service.js     (settings: tasks.conf and tasks.env next to it, or the environment)
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const API_URL = 'https://api.ticktick.com/open/v1';
const TICKTICK_TIMEOUT_MS = 10000;
const CACHE_MS = 15000;
const MAX_BODY = 2 * 1024 * 1024;     // a 30 s recording is under 1 MB as WAV
const MAX_SECONDS = 30;
const MAX_TITLE = 200;
const ITEM_GAP = 1048576;              // TickTick's own sortOrder step
const FREE_PLAN_ITEMS = 19;            // the free plan's limit on checklist items
const MIN_FOCUS = 1;
const MAX_FOCUS = 180;
const RUN_TIMEOUT_MS = 60000;

// ---- settings ---------------------------------------------------------------

// KEY=value lines; # comments and blank lines skipped. Values are not logged.
function parseEnv(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !/^\s*#/.test(line)) out[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
  return out;
}

function loadSettings(env, dir) {
  // tasks.conf: settings install.ps1 writes (list, ffmpeg); tasks.env: the
  // two tokens, which nucbox/push-tasks-secrets.sh writes from the Mac.
  let file = {};
  for (const f of [env.TASKS_CONF || path.join(dir, 'tasks.conf'), env.TASKS_ENV || path.join(dir, 'tasks.env')]) {
    try { Object.assign(file, parseEnv(fs.readFileSync(f, 'utf8'))); } catch {}
  }
  const get = (k, d) => (env[k] !== undefined && env[k] !== '' ? env[k] : file[k] !== undefined && file[k] !== '' ? file[k] : d);
  return {
    ticktickToken: get('TICKTICK_TOKEN', ''),
    panelToken: get('PANEL_TOKEN', ''),
    listName: get('TASKS_LIST', 'Work'),
    port: Number(get('TASKS_PORT', 8791)),
    host: get('TASKS_HOST', '0.0.0.0'),
    whisperCli: get('WHISPER_CLI', path.join(dir, 'whisper', 'whisper-cli.exe')),
    whisperModel: get('WHISPER_MODEL', path.join(dir, 'whisper', 'ggml-base.en.bin')),
    ffmpeg: get('FFMPEG', 'ffmpeg'),
    stateFile: get('TASKS_STATE', path.join(dir, 'focus.json')),
  };
}

// ---- TickTick ---------------------------------------------------------------

class HttpError extends Error {
  constructor(status, code) { super(code || 'http-' + status); this.status = status; }
}

function createTickTick(token, opts) {
  const o = opts || {};
  const base = o.baseUrl || API_URL;
  const doFetch = o.fetch || fetch;

  async function request(method, p, body) {
    const res = await doFetch(base + p, {
      method,
      headers: Object.assign({ Authorization: 'Bearer ' + token }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TICKTICK_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) throw new HttpError(502, 'ticktick-token-rejected');
    if (!res.ok) throw new HttpError(res.status, 'ticktick-' + res.status);
    const text = await res.text();
    if (!text.trim()) return null;
    try { return JSON.parse(text); } catch { throw new Error('ticktick-bad-json'); }
  }

  const q = encodeURIComponent;
  return {
    projects: () => request('GET', '/project'),
    projectData: (listId) => request('GET', '/project/' + q(listId) + '/data'),
    task: (listId, taskId) => request('GET', '/project/' + q(listId) + '/task/' + q(taskId)),
    createTask: (body) => request('POST', '/task', body),
    // Exactly id, projectId and the fields given: a field left out is left alone.
    updateTask: (listId, taskId, fields) => request('POST', '/task/' + q(taskId), Object.assign({ id: taskId, projectId: listId }, fields)),
    complete: (listId, taskId) => request('POST', '/project/' + q(listId) + '/task/' + q(taskId) + '/complete'),
  };
}

function sortOrder(item) {
  const v = item && item.sortOrder;
  return typeof v === 'number' && isFinite(v) ? v : 0;
}

function itemOpen(item) {
  return (item.status || 0) === 0;
}

// The list's tasks as the panel draws them: open ones, in TickTick's order,
// each with its checklist (subtasks) in order.
function panelTasks(tasks) {
  return (Array.isArray(tasks) ? tasks : [])
    .filter((t) => t && t.id && (t.status || 0) === 0)
    .sort((a, b) => sortOrder(a) - sortOrder(b))
    .map((t) => ({
      id: String(t.id),
      title: String(t.title || ''),
      priority: Number(t.priority) || 0,
      due: t.dueDate || null,
      allDay: !!t.isAllDay,
      items: (Array.isArray(t.items) ? t.items : [])
        .filter((i) => i && i.id)
        .sort((a, b) => sortOrder(a) - sortOrder(b))
        .map((i) => ({ id: String(i.id), title: String(i.title || ''), done: !itemOpen(i) })),
    }));
}

// `items` with `title` on it: a new last item, a ticked match unticked, or
// unchanged when an open one is already there (the mirror's with_item).
function withItem(items, title) {
  const key = title.trim().toLowerCase();
  const matches = [];
  items.forEach((it, i) => { if (String(it.title || '').trim().toLowerCase() === key) matches.push(i); });
  if (matches.some((i) => itemOpen(items[i]))) return { items, outcome: 'duplicate' };
  if (matches.length) {
    const i = matches[0];
    return { items: items.map((it, j) => (j === i ? Object.assign({}, it, { status: 0 }) : it)), outcome: 'unticked' };
  }
  const last = items.length ? Math.max(...items.map(sortOrder)) : -ITEM_GAP;
  return { items: items.concat([{ title, status: 0, sortOrder: last + ITEM_GAP }]), outcome: 'added' };
}

function cleanTitle(raw) {
  const t = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  if (!t) throw new HttpError(400, 'empty-title');
  return t.slice(0, MAX_TITLE);
}

function createTasks(tt, listName, now) {
  let listId = null;
  let cache = null;   // {at, body}

  async function list() {
    if (listId) return listId;
    const projects = await tt.projects();
    const want = listName.trim().toLowerCase();
    const found = (Array.isArray(projects) ? projects : []).find((p) => String(p.name || '').trim().toLowerCase() === want);
    if (!found) throw new HttpError(404, 'list-not-found');
    listId = String(found.id);
    return listId;
  }

  // A list that has gone (renamed, deleted) is looked up again next time.
  async function withList(fn) {
    const id = await list();
    try { return await fn(id); } catch (e) {
      if (e && e.status === 404) listId = null;
      throw e;
    }
  }

  async function fresh(id, taskId) {
    try { return await tt.task(id, taskId); } catch (e) {
      if (e && e.status === 404) throw new HttpError(404, 'task-gone');
      throw e;
    }
  }

  return {
    listName,
    async open(force) {
      if (!force && cache && now() - cache.at < CACHE_MS) return cache.body;
      const body = await withList(async (id) => {
        const data = await tt.projectData(id);
        return { list: { id, name: listName }, tasks: panelTasks(data && data.tasks) };
      });
      cache = { at: now(), body };
      return body;
    },
    async create(title) {
      const t = cleanTitle(title);
      const made = await withList((id) => tt.createTask({ title: t, projectId: id }));
      cache = null;
      return { id: made && made.id ? String(made.id) : null };
    },
    async addItem(taskId, title) {
      const t = cleanTitle(title);
      const outcome = await withList(async (id) => {
        const task = await fresh(id, taskId);
        const next = withItem(Array.isArray(task.items) ? task.items.slice() : [], t);
        if (next.outcome === 'duplicate') return next.outcome;
        try {
          await tt.updateTask(id, taskId, { items: next.items });
        } catch (e) {
          if (e && e.status >= 400 && e.status < 500 && next.items.length > FREE_PLAN_ITEMS) throw new HttpError(409, 'items-full');
          throw e;
        }
        return next.outcome;
      });
      cache = null;
      return { outcome };
    },
    async toggleItem(taskId, itemId) {
      const done = await withList(async (id) => {
        const task = await fresh(id, taskId);
        const items = Array.isArray(task.items) ? task.items : [];
        const at = items.findIndex((i) => String(i.id) === itemId);
        if (at < 0) throw new HttpError(404, 'item-gone');
        const nowDone = itemOpen(items[at]);
        const next = items.map((it, j) => (j === at ? Object.assign({}, it, { status: nowDone ? 1 : 0 }) : it));
        await tt.updateTask(id, taskId, { items: next });
        return nowDone;
      });
      cache = null;
      return { done };
    },
    // Only an open task is completed; one done elsewhere already is "moved".
    async complete(taskId) {
      const outcome = await withList(async (id) => {
        const task = await fresh(id, taskId);
        if ((task.status || 0) !== 0) return 'moved';
        await tt.complete(id, taskId);
        return 'completed';
      });
      cache = null;
      return { outcome };
    },
  };
}

// ---- transcription ------------------------------------------------------------

function execRun(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: RUN_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; reject(err); } else resolve({ stdout, stderr });
    });
  });
}

// A 16 kHz mono 16-bit PCM WAV, as the Car Thing's recorder sends: whisper
// reads it as it is, with no ffmpeg.
function isWhisperWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return false;
  return buf.readUInt16LE(20) === 1 && buf.readUInt16LE(22) === 1 && buf.readUInt32LE(24) === 16000 && buf.readUInt16LE(34) === 16;
}

function cleanText(stdout) {
  return String(stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^\[[A-Z_ ]+\]$/.test(l) && !/^\([a-z ]+\)$/i.test(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function createTranscriber(s, opts) {
  const run = (opts && opts.run) || execRun;
  const tmpDir = (opts && opts.tmpDir) || os.tmpdir();
  const exists = (opts && opts.exists) || fs.existsSync;
  return async function transcribe(audio, mime) {
    if (!audio || !audio.length) throw new HttpError(400, 'no-audio');
    if (audio.length > MAX_BODY) throw new HttpError(413, 'too-long');
    if (!exists(s.whisperCli) || !exists(s.whisperModel)) throw new HttpError(503, 'dictation-not-set-up');
    const base = path.join(tmpDir, 'panel-tasks-' + crypto.randomBytes(6).toString('hex'));
    const wav = base + '.16k.wav';
    const input = base + (/ogg/.test(mime) ? '.ogg' : /mp4|m4a|aac/.test(mime) ? '.m4a' : /wav/.test(mime) ? '.wav' : '.webm');
    try {
      if (isWhisperWav(audio)) {
        fs.writeFileSync(wav, audio);
      } else {
        fs.writeFileSync(input, audio);
        try {
          await run(s.ffmpeg, ['-y', '-loglevel', 'error', '-i', input, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
        } catch (err) {
          throw new HttpError(503, err && err.code === 'ENOENT' ? 'dictation-not-set-up' : 'transcription-failed');
        }
      }
      if ((fs.statSync(wav).size - 44) / 32000 > MAX_SECONDS) throw new HttpError(413, 'too-long');
      let out;
      try {
        out = await run(s.whisperCli, ['-m', s.whisperModel, '-f', wav, '-nt', '-np', '-l', 'en']);
      } catch (err) {
        throw new HttpError(500, 'transcription-failed');
      }
      return cleanText(out.stdout);
    } finally {
      for (const f of [input, wav]) { try { fs.unlinkSync(f); } catch {} }
    }
  };
}

// ---- the focus timer ---------------------------------------------------------

// One timer at a time, kept in a file so a restart of this service keeps it.
// The panel works out what's left from endsAt and this machine's clock (now).
function createFocus(file, now) {
  let focus = null;
  try {
    const f = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (f && f.taskId && Number.isFinite(f.endsAt)) focus = f;
  } catch {}

  function save() {
    try {
      if (focus) fs.writeFileSync(file, JSON.stringify(focus));
      else fs.rmSync(file, { force: true });
    } catch {}
  }

  return {
    get: () => focus,
    start(taskId, title, minutes) {
      const m = Math.round(Number(minutes));
      if (!taskId || !(m >= MIN_FOCUS && m <= MAX_FOCUS)) throw new HttpError(400, 'bad-focus');
      const t = now();
      focus = { taskId: String(taskId), title: String(title || '').slice(0, MAX_TITLE), minutes: m, startedAt: t, endsAt: t + m * 60000 };
      save();
      return focus;
    },
    stop() { focus = null; save(); },
  };
}

// ---- HTTP ------------------------------------------------------------------------

function tokenOk(req, token) {
  const m = /^Bearer\s+(.+)$/.exec(String(req.headers.authorization || ''));
  if (!m || !token) return false;
  const a = Buffer.from(m[1].trim());
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'too-long')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req, 64 * 1024);
  try { return buf.length ? JSON.parse(buf.toString('utf8')) : {}; } catch { throw new HttpError(400, 'bad-json'); }
}

function createService(opts) {
  const now = opts.now || Date.now;
  const tasks = opts.tasks;
  const focus = opts.focus;
  const log = opts.log || function () {};

  function send(res, status, body) {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Max-Age': '600',
      'Cache-Control': 'no-store',
    });
    res.end(body === undefined ? '' : JSON.stringify(body));
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const parts = p.split('/').filter(Boolean).map(decodeURIComponent);
    const m = req.method;

    if (p === '/tasks' && m === 'GET') {
      const body = await tasks.open(url.searchParams.get('fresh') === '1');
      return send(res, 200, Object.assign({}, body, { focus: focus.get(), now: now() }));
    }
    if (p === '/tasks' && m === 'POST') return send(res, 200, await tasks.create((await readJson(req)).title));
    if (parts[0] === 'tasks' && parts.length === 3 && parts[2] === 'items' && m === 'POST') {
      return send(res, 200, await tasks.addItem(parts[1], (await readJson(req)).title));
    }
    if (parts[0] === 'tasks' && parts.length === 5 && parts[2] === 'items' && parts[4] === 'toggle' && m === 'POST') {
      return send(res, 200, await tasks.toggleItem(parts[1], parts[3]));
    }
    if (parts[0] === 'tasks' && parts.length === 3 && parts[2] === 'complete' && m === 'POST') {
      const r = await tasks.complete(parts[1]);
      const f = focus.get();
      if (f && f.taskId === parts[1]) focus.stop();
      return send(res, 200, r);
    }
    if (p === '/transcribe' && m === 'POST') {
      const audio = await readBody(req, MAX_BODY);
      return send(res, 200, { text: await opts.transcribe(audio, String(req.headers['content-type'] || '')) });
    }
    if (p === '/focus' && m === 'GET') return send(res, 200, { focus: focus.get(), now: now() });
    if (p === '/focus' && m === 'POST') {
      const b = await readJson(req);
      return send(res, 200, { focus: focus.start(b.taskId, b.title, b.minutes), now: now() });
    }
    if (p === '/focus' && m === 'DELETE') { focus.stop(); return send(res, 200, { focus: null, now: now() }); }
    return send(res, 404, { error: 'not-found' });
  }

  return http.createServer((req, res) => {
    if (req.method === 'OPTIONS') return send(res, 204);
    if (!tokenOk(req, opts.panelToken)) return send(res, 401, { error: 'unauthorized' });
    route(req, res).catch((e) => {
      const status = e instanceof HttpError ? e.status : e && e.name === 'TimeoutError' ? 504 : 502;
      const code = e instanceof HttpError ? e.message : e && e.name === 'TimeoutError' ? 'ticktick-timeout' : 'ticktick-unreachable';
      // Codes and statuses only: never titles, tokens or what was said.
      log(req.method + ' ' + req.url.split('?')[0].replace(/\/tasks\/[^/]+/, '/tasks/:id') + ' -> ' + status + ' ' + code);
      if (!res.headersSent) send(res, status, { error: code });
    });
  });
}

module.exports = {
  createService, createTasks, createTickTick, createTranscriber, createFocus,
  panelTasks, withItem, isWhisperWav, cleanText, parseEnv, loadSettings,
};

if (require.main === module) {
  const s = loadSettings(process.env, __dirname);
  if (!s.ticktickToken || !s.panelToken) {
    console.error('tasks-service: TICKTICK_TOKEN and PANEL_TOKEN are needed (tasks.env next to this file)');
    process.exit(1);
  }
  const tasks = createTasks(createTickTick(s.ticktickToken), s.listName, Date.now);
  const server = createService({
    tasks,
    focus: createFocus(s.stateFile, Date.now),
    transcribe: createTranscriber(s),
    panelToken: s.panelToken,
    log: (line) => console.log(new Date().toISOString() + ' ' + line),
  });
  server.listen(s.port, s.host, () => console.log('tasks-service: ' + s.host + ':' + s.port + ', list "' + s.listName + '"'));
}
