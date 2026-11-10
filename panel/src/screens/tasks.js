import { esc, topbar } from './helpers.js';
import { findTask, taskRows, openCount, focusPhase, fmtLeft, tasksErrorText } from '../tasks.js';

// The Tasks page (preset 1): the TickTick work list, one task's page with its
// subtasks, the focus timer's minutes dial, and the timer itself. All of it
// comes from the NucBox, so none of it needs the Mac.
//
// view = {cursor, row, minutes, stopArmed, doneRow}; tasks = store.tasks;
// focus = {focus, offset}.

var ROW_H = 62;
var VISIBLE = 6;

function head(state, title, count) {
  var t = state.tasks || {};
  return '<div class="screen">' + topbar(title, t.status === 'ok', count);
}

function problem(t) {
  if (!t || !t.configured) {
    return '<div class="tkquiet">Tasks aren\'t set up. See "Tasks" in the README: the NucBox serves them.</div>';
  }
  if (t.error) return '<div class="tkerror">' + esc(tasksErrorText(t.error)) + '</div>';
  return '';
}

function focusBadge(task, focus) {
  return focus && focus.taskId === task.id ? '<span class="tkfocus">FOCUS</span>' : '';
}

// Keeps the cursor's row on screen; returns the first row shown.
function windowStart(cursor, n) {
  var start = Math.max(0, cursor - Math.floor(VISIBLE / 2));
  return Math.max(0, Math.min(start, n - VISIBLE));
}

export function renderTasks(state, view) {
  var t = state.tasks || {};
  var items = t.items || [];
  var name = t.list ? t.list.toUpperCase() : 'TASKS';
  var out = head(state, name, items.length ? String(items.length) : '');
  var p = problem(t);
  if (!t.configured) return out + p + '</div>';
  if (!items.length) {
    return out + p + '<div class="tkempty">' + (t.status === 'ok' ? 'Nothing on the list.' : t.error ? '' : 'Loading…') +
      '</div><div class="tkfoot">Hold the top button to add a task</div></div>';
  }
  var cursor = Math.max(0, Math.min(items.length - 1, view.cursor || 0));
  var start = windowStart(cursor, items.length);
  var rows = '';
  for (var i = 0; i < items.length; i++) {
    var task = items[i];
    var subs = task.items.length ? '<span class="tksubs">' + (task.items.length - openCount(task)) + '/' + task.items.length + '</span>' : '';
    rows += '<div class="tkrow' + (i === cursor ? ' selected' : '') + (task.priority >= 5 ? ' high' : task.priority >= 3 ? ' mid' : '') +
      '" data-action="task-open" data-id="' + esc(task.id) + '">' +
      '<span class="tkdot"></span><span class="tktitle">' + esc(task.title) + '</span>' + focusBadge(task, state.focus && state.focus.focus) + subs +
      '<span class="tkstart" data-action="task-start" data-id="' + esc(task.id) + '">START</span></div>';
  }
  return out + p +
    '<div class="tklist"><div class="tktrack" style="transform:translateY(-' + (start * ROW_H) + 'px)">' + rows + '</div></div>' +
    '<div class="tkfoot">Press to open · hold the top button to add a task</div></div>';
}

export function renderTask(state, view, id) {
  var t = state.tasks || {};
  var task = findTask(t, id);
  var out = head(state, 'TASK');
  if (!task) return out + problem(t) + '<div class="tkempty">That task is no longer on the list.</div></div>';
  var rows = taskRows(task);
  var cur = Math.max(0, Math.min(rows.length - 1, view.row || 0));
  var start = windowStart(cur, rows.length + 1);
  var html = '';
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var sel = i === cur ? ' selected' : '';
    if (r.kind === 'start') {
      html += '<div class="tkrow tkgo' + sel + '" data-action="task-row" data-id="' + i + '"><span class="tkplay"></span>' +
        '<span class="tktitle">Start focus</span><span class="tksubs">' + (view.minutes || 25) + ' min</span></div>';
    } else if (r.kind === 'complete') {
      html += '<div class="tkrow tkdone' + sel + '" data-action="task-row" data-id="' + i + '"><span class="tkcheck"></span>' +
        '<span class="tktitle">Mark task done</span></div>';
    } else {
      var it = null;
      for (var j = 0; j < task.items.length; j++) if (task.items[j].id === r.id) it = task.items[j];
      html += '<div class="tkrow tkitem' + sel + (it.done ? ' ticked' : '') + '" data-action="task-row" data-id="' + i + '">' +
        '<span class="tkbox"></span><span class="tktitle">' + esc(it.title) + '</span></div>';
    }
  }
  return out + problem(t) +
    '<div class="tkname">' + esc(task.title) + focusBadge(task, state.focus && state.focus.focus) + '</div>' +
    '<div class="tklist short"><div class="tktrack" style="transform:translateY(-' + (start * ROW_H) + 'px)">' + html + '</div></div>' +
    '<div class="tkfoot">Hold the top button to add a subtask · back to the list</div></div>';
}

// The minutes dial: turn to set, press to start.
export function renderFocusSetup(state, view, id) {
  var task = findTask(state.tasks, id);
  var m = view.minutes || 25;
  var frac = m / 120;
  return head(state, 'FOCUS') +
    '<div class="fset">' +
    '<div class="ftask">' + esc(task ? task.title : '') + '</div>' +
    '<div class="fmin">' + m + '<span>min</span></div>' +
    '<div class="fbar"><span style="width:' + (frac * 100).toFixed(1) + '%"></span></div>' +
    '<div class="fhint">Turn the knob to set · press to start · back to cancel</div>' +
    '</div></div>';
}

var DONE_ROWS = ['Mark task done', 'Again', 'Dismiss'];
export var DONE_ROW_COUNT = DONE_ROWS.length;

export function renderFocus(state, view, nowMs) {
  var f = state.focus || {};
  var p = focusPhase(f.focus, nowMs, f.offset);
  if (p.phase === 'none') {
    return head(state, 'FOCUS') + '<div class="tkempty">No focus timer running.</div>' +
      '<div class="tkfoot">Open a task and press Start focus</div></div>';
  }
  var title = '<div class="ftask">' + esc(f.focus.title) + '</div>';
  if (p.phase === 'done') {
    var rows = '';
    for (var i = 0; i < DONE_ROWS.length; i++) {
      rows += '<div class="drow' + (i === (view.doneRow || 0) ? ' send' : '') + '" data-action="focus-done" data-id="' + i + '">' + DONE_ROWS[i] + '</div>';
    }
    return head(state, 'FOCUS') + '<div class="fset done">' + title +
      '<div class="ftime">Time\'s up</div><div class="fsub">' + f.focus.minutes + ' minutes of focus</div>' +
      '<div class="drows">' + rows + '</div></div></div>';
  }
  return head(state, 'FOCUS') + '<div class="fset">' + title +
    '<div class="ftime">' + fmtLeft(p.leftMs) + '</div>' +
    '<div class="fbar run"><span style="width:' + (p.frac * 100).toFixed(1) + '%"></span></div>' +
    '<div class="fhint' + (view.stopArmed ? ' armed' : '') + '">' +
    (view.stopArmed ? 'Press again to stop the timer' : 'Press to stop · back to the list (it keeps running)') + '</div>' +
    '</div></div>';
}

// The small timer shown on every other screen while one runs.
export function focusChip(focus, nowMs) {
  var f = focus || {};
  var p = focusPhase(f.focus, nowMs, f.offset);
  if (p.phase === 'none') return null;
  return { text: p.phase === 'done' ? 'FOCUS DONE' : fmtLeft(p.leftMs), done: p.phase === 'done' };
}
