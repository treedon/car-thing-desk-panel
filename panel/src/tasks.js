// The Tasks page's data: the work list from TickTick, through the tasks
// service on the NucBox (nucbox/tasks-service.js), which holds the TickTick
// token, transcribes dictation and keeps the focus timer. Nothing here goes
// through the Mac. Pure apart from the client, which takes its fetch and
// timers as arguments.

var TIMEOUT_MS = 12000;
var TRANSCRIBE_TIMEOUT_MS = 60000;

export var FOCUS_DEFAULT = 25;
export var FOCUS_MIN = 5;
export var FOCUS_MAX = 120;
export var FOCUS_STEP = 5;

// The client. cfg = {url, token}. Every call resolves with the parsed body or
// rejects with an Error whose message is the service's error code.
export function createTasksClient(cfg, opts) {
  var o = opts || {};
  var doFetch = o.fetch || function (u, init) { return fetch(u, init); };
  var later = o.setTimeout || setTimeout;
  var base = String(cfg.url || '').replace(/\/+$/, '');

  function call(method, path, body, ms, contentType) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var t = later(function () { if (!done) { done = true; reject(new Error('tasks-timeout')); } }, ms || TIMEOUT_MS);
      var headers = { Authorization: 'Bearer ' + cfg.token };
      var payload;
      if (body !== undefined) {
        headers['Content-Type'] = contentType || 'application/json';
        payload = contentType ? body : JSON.stringify(body);
      }
      Promise.resolve().then(function () {
        return doFetch(base + path, { method: method, headers: headers, body: payload });
      }).then(function (res) {
        return res.text().then(function (text) {
          var parsed = null;
          try { parsed = text ? JSON.parse(text) : null; } catch (e) {}
          if (!res.ok) throw new Error((parsed && parsed.error) || (res.status === 401 ? 'unauthorized' : 'tasks-' + res.status));
          return parsed;
        });
      }).then(function (v) {
        if (done) return;
        done = true;
        resolve(v);
      }, function (e) {
        if (done) return;
        done = true;
        reject(e && /^[a-z-0-9]+$/.test(e.message) ? e : new Error('tasks-unreachable'));
      });
    });
  }

  var q = encodeURIComponent;
  return {
    list: function (fresh) { return call('GET', '/tasks' + (fresh ? '?fresh=1' : '')); },
    create: function (title) { return call('POST', '/tasks', { title: title }); },
    addItem: function (taskId, title) { return call('POST', '/tasks/' + q(taskId) + '/items', { title: title }); },
    toggleItem: function (taskId, itemId) { return call('POST', '/tasks/' + q(taskId) + '/items/' + q(itemId) + '/toggle', {}); },
    complete: function (taskId) { return call('POST', '/tasks/' + q(taskId) + '/complete', {}); },
    focus: function () { return call('GET', '/focus'); },
    startFocus: function (taskId, title, minutes) { return call('POST', '/focus', { taskId: taskId, title: title, minutes: minutes }); },
    stopFocus: function () { return call('DELETE', '/focus'); },
    transcribe: function (blob, mime) { return call('POST', '/transcribe', blob, TRANSCRIBE_TIMEOUT_MS, mime || 'audio/wav'); },
  };
}

// The minutes dial: FOCUS_STEP at a time between FOCUS_MIN and FOCUS_MAX.
export function stepMinutes(minutes, dir) {
  var m = Math.round((Number(minutes) || FOCUS_DEFAULT) / FOCUS_STEP) * FOCUS_STEP + dir * FOCUS_STEP;
  return Math.max(FOCUS_MIN, Math.min(FOCUS_MAX, m));
}

// Where a focus timer stands, by the NucBox's clock: offsetMs is its clock
// minus ours, measured on the last reply.
export function focusPhase(focus, nowMs, offsetMs) {
  if (!focus) return { phase: 'none', leftMs: 0, frac: 0 };
  var t = nowMs + (offsetMs || 0);
  var total = Math.max(1, focus.endsAt - focus.startedAt);
  var left = Math.max(0, focus.endsAt - t);
  return { phase: left > 0 ? 'running' : 'done', leftMs: left, frac: Math.min(1, Math.max(0, 1 - left / total)) };
}

export function fmtLeft(ms) {
  var s = Math.ceil(ms / 1000);
  var h = Math.floor(s / 3600);
  var m = Math.floor((s % 3600) / 60);
  var sec = s % 60;
  var mm = (h && m < 10 ? '0' : '') + m;
  return (h ? h + ':' : '') + mm + ':' + (sec < 10 ? '0' : '') + sec;
}

export function findTask(tasks, id) {
  var list = (tasks && tasks.items) || [];
  for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}

// The rows of one task's page, top to bottom: Start, its subtasks, then Done.
export function taskRows(task) {
  if (!task) return [];
  var rows = [{ kind: 'start' }];
  for (var i = 0; i < task.items.length; i++) rows.push({ kind: 'item', id: task.items[i].id });
  rows.push({ kind: 'complete' });
  return rows;
}

// A subtask ticked on the panel shows ticked at once; the next read from the
// NucBox has the last word.
export function withItemToggled(tasks, taskId, itemId) {
  var items = (tasks && tasks.items) || [];
  var out = [];
  for (var i = 0; i < items.length; i++) {
    var t = items[i];
    if (t.id !== taskId) { out.push(t); continue; }
    var sub = [];
    for (var j = 0; j < t.items.length; j++) {
      var it = t.items[j];
      sub.push(it.id === itemId ? { id: it.id, title: it.title, done: !it.done } : it);
    }
    out.push({ id: t.id, title: t.title, priority: t.priority, due: t.due, allDay: t.allDay, items: sub });
  }
  var copy = {};
  for (var k in tasks) copy[k] = tasks[k];
  copy.items = out;
  return copy;
}

export function openCount(task) {
  var n = 0;
  for (var i = 0; i < task.items.length; i++) if (!task.items[i].done) n++;
  return n;
}

var ERRORS = {
  'list-not-found': "TickTick has no list by that name. Check TASKS_LIST on the NucBox.",
  'ticktick-token-rejected': 'TickTick refused the token. Run nucbox/push-tasks-secrets.sh again with a fresh one.',
  'ticktick-timeout': "TickTick didn't answer. Trying again shortly.",
  'ticktick-unreachable': "The NucBox can't reach TickTick. Trying again shortly.",
  'unauthorized': "The NucBox refused the panel's token. Re-provision the Car Thing.",
  'tasks-timeout': "The NucBox didn't answer. Is it on?",
  'tasks-unreachable': "Can't reach the NucBox. Is it on?",
  'items-full': "That task's checklist is full (TickTick's free plan allows 19).",
  'task-gone': 'That task is gone from TickTick.',
  'dictation-not-set-up': "Dictation isn't set up on the NucBox yet. Run nucbox/install.ps1 again.",
};

export function tasksErrorText(code) {
  return ERRORS[code] || 'Something went wrong (' + code + ').';
}
