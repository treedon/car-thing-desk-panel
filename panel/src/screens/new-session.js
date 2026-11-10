import { esc, topbar } from './helpers.js';
import { now, tzOffset } from '../clock.js';

// Starting a Claude Code session from the Car Thing: hold the top button on the
// sessions grid, pick a machine, pick one of its five recent projects, say what
// it should do (the dictation screen), check it, START. This module is the
// logic and the two pick screens; main.js wires them to the dial, the routes and
// the socket. Written for Chrome 69, like the rest of src/.
//
// Always auto mode. Which machine runs it is the host the panel names on every
// request (ws.machines(): { name, label, ready }, the Mac first).

export var NEW_HINT = 'HOLD TOP · NEW';

// Whether a permission ask from a background session reaches the panel. It does
// not yet (verify-first 2 is still open), so the check line promises auto mode
// and no more. Flip this, and only this, if it turns out they do.
export var ASKS_REACH_PANEL = false;

export var TRUST_FIRST = 'TRUST IT ON THE MAC FIRST';
var TRUST_FIRST_NUCBOX = 'TRUST IT ON THE NUCBOX FIRST';
export var NO_PROJECTS = 'NO RECENT PROJECTS ON THIS MACHINE';
export var NOT_ANSWERING = 'NOT ANSWERING';
export var NOT_SET_UP = 'NOT SET UP YET';
// A start whose request timed out or whose socket closed: the machine may have
// run it, so START is not offered again straight away.
export var MAY_HAVE_STARTED = 'MAY HAVE STARTED · CHECK THE LIST';
export var MAX_PROJECTS = 5;
// How long to wait for the new session to show up in the list before saying so.
export var LISTED_WAIT_MS = 20000;

var MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
var DAY_MS = 86400000;

// ---- the view -------------------------------------------------------------
// cursor: the row the dial is on, on whichever of the two screens is showing
// host: the machine whose projects are loaded (a ws.machines() name)
// machines: ws.machines(), refreshed by main.js before each draw
// notSetUp: host -> true, for a machine that rejected the request as unknown
// starting: a START is on the wire
// pending: { host, project, text } of a check screen that could not be put back
//   after a failed start (the owner had moved on, or the outcome is unknown); the
//   next hold of the top button on the grid opens it. null when none.

export function createNewView() {
  return { cursor: 0, host: null, machines: [], projects: [], loading: false, error: null, starting: false, notSetUp: {}, pending: null };
}

export var newView = createNewView();

// ---- the sessions grid's hint ------------------------------------------------

// Shown while at least one machine is configured: always, in practice, as the
// Mac is. store's machineCount is unset until main.js has asked.
export function hintFor(state) {
  return state && state.machineCount === 0 ? '' : NEW_HINT;
}

// ---- machines -----------------------------------------------------------------

function isChoosable(row) {
  return !!row && !!row.ready && !row.status;
}

// One row per machine ws.machines() returned, with how many sessions run there
// (the Mac's carry no machine tag; the others carry their label) and, when it
// can't be chosen, why: it doesn't answer, or it said it doesn't know the request.
export function machineRows(machines, sessions, notSetUp) {
  var list = machines || [];
  var all = sessions || [];
  var rows = [];
  for (var i = 0; i < list.length; i++) {
    var m = list[i];
    var running = 0;
    for (var j = 0; j < all.length; j++) {
      var s = all[j];
      if (!s || s.ended) continue;
      if (s.machine ? s.machine === m.label : m.name === list[0].name) running++;
    }
    var status = '';
    if (!m.ready) status = NOT_ANSWERING;
    else if (notSetUp && notSetUp[m.name]) status = NOT_SET_UP;
    rows.push({ name: m.name, label: m.label, ready: !!m.ready, running: running, status: status });
  }
  return rows;
}

// Where the cursor starts: on the machine used last if it can be chosen, else on
// the first that can. With none to choose it sits on row 0, and a press says why not.
export function initialMachine(rows, lastHost) {
  var list = rows || [];
  var first = -1;
  for (var i = 0; i < list.length; i++) {
    if (!isChoosable(list[i])) continue;
    if (lastHost && list[i].name === lastHost) return i;
    if (first < 0) first = i;
  }
  return first < 0 ? 0 : first;
}

// A turn of the dial on the machine screen: the next row that can be chosen in
// that direction; the cursor stays put at the end.
export function stepMachine(rows, cursor, dir) {
  var list = rows || [];
  var step = dir < 0 ? -1 : 1;
  for (var i = cursor + step; i >= 0 && i < list.length; i += step) {
    if (isChoosable(list[i])) return i;
  }
  return cursor;
}

function labelOf(view, host) {
  var list = (view && view.machines) || [];
  for (var i = 0; i < list.length; i++) if (list[i].name === host) return list[i].label;
  return host || '';
}

function upper(s) { return String(s == null ? '' : s).toUpperCase(); }

export function renderMachines(state, view) {
  var rows = machineRows(view.machines, state.sessions, view.notSetUp);
  var cursor = view.cursor;
  var html = '';
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    html += '<div class="nsrow' + (i === cursor ? ' selected' : '') + (isChoosable(r) ? '' : ' disabled') +
      '" data-action="ns-machine" data-id="' + i + '">' +
      '<span class="nsname">' + esc(upper(r.label)) + '</span>' +
      '<span class="nssub">' + esc(r.status || r.running + ' RUNNING') + '</span></div>';
  }
  return '<div class="screen">' + topbar('NEW SESSION', state.daemonConnected, '', 'WHERE?') +
    '<div class="nslist">' + html + '</div>' +
    '<div class="tkfoot">Turn to pick · press to choose · back to the sessions</div></div>';
}

// ---- projects -------------------------------------------------------------------

// The day a time falls on, as a day number, in the Mac's zone when given its UTC
// offset (the device itself runs UTC), else in the clock's own.
function dayNumber(ms, offsetMin) {
  if (typeof offsetMin === 'number') return Math.floor((ms - offsetMin * 60000) / DAY_MS);
  var d = new Date(ms);
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
}

function monthDay(ms, offsetMin) {
  if (typeof offsetMin === 'number') {
    var u = new Date(ms - offsetMin * 60000);
    return MONTHS[u.getUTCMonth()] + ' ' + u.getUTCDate();
  }
  var d = new Date(ms);
  return MONTHS[d.getMonth()] + ' ' + d.getDate();
}

// When a project was last used: NOW inside the hour, TODAY, YESTERDAY, then NOV 6.
// Days are calendar days (a project from 23:50 is YESTERDAY at 00:30 the next
// morning, and NOW inside the hour before that). offsetMin is the Mac's offset as
// clock.js keeps it; without one the days are the clock's own.
export function lastUsedLabel(ts, nowMs, offsetMin) {
  if (typeof ts !== 'number' || !isFinite(ts)) return '';
  if (nowMs - ts < 3600000) return 'NOW';
  var ago = dayNumber(nowMs, offsetMin) - dayNumber(ts, offsetMin);
  if (ago <= 0) return 'TODAY';
  if (ago === 1) return 'YESTERDAY';
  return monthDay(ts, offsetMin);
}

// Where to trust a folder first, in the words of the machine `host` names (a
// ws.machines() name). The Mac's, unless it is the NucBox: a missing host reads
// as the Mac.
export function trustFirst(host) {
  return host === 'nucbox' ? TRUST_FIRST_NUCBOX : TRUST_FIRST;
}

// What each drawn project row says. A folder the machine hasn't trusted can't
// run a background session, so its row is dimmed and says so where the date
// would be. `host` is the machine the projects are from.
export function projectRows(projects, nowMs, offsetMin, host) {
  var list = projects || [];
  var rows = [];
  for (var i = 0; i < list.length && i < MAX_PROJECTS; i++) {
    var p = list[i];
    var untrusted = p.trusted === false;
    rows.push({
      name: p.name, path: p.path, disabled: untrusted,
      sub: untrusted ? trustFirst(host) : lastUsedLabel(p.lastUsed, nowMs, offsetMin),
    });
  }
  return rows;
}

// A turn of the dial on the project screen: every drawn row, the dimmed ones
// included. The cursor stops at the ends.
export function stepProject(count, cursor, dir) {
  var n = Math.min(count || 0, MAX_PROJECTS);
  if (n <= 0) return 0;
  return Math.max(0, Math.min(n - 1, cursor + (dir < 0 ? -1 : 1)));
}

// What pressing a project does: { open: project } to go and dictate, or
// { toast } for one that can't be started. Null when there is no such row.
export function projectPress(project, host) {
  if (!project) return null;
  if (project.trusted === false) return { toast: trustFirst(host) };
  return { open: project };
}

export function renderProjects(state, view) {
  var title = 'NEW SESSION · ' + upper(labelOf(view, view.host));
  var body;
  if (view.loading) {
    body = '<div class="empty">LOADING…</div>';
  } else if (view.error) {
    body = '<div class="empty">' + esc(errorLabel(view.error, view.host)) + '</div>';
  } else {
    var rows = projectRows(view.projects, now(), tzOffset(), view.host);
    if (!rows.length) {
      body = '<div class="empty">' + NO_PROJECTS + '</div>';
    } else {
      var html = '';
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        html += '<div class="nsrow' + (i === view.cursor ? ' selected' : '') + (r.disabled ? ' disabled' : '') +
          '" data-action="ns-project" data-id="' + i + '">' +
          '<span class="nsname">' + esc(r.name) + '</span>' +
          '<span class="nssub">' + esc(r.sub) + '</span></div>';
      }
      body = '<div class="nslist">' + html + '</div>';
    }
  }
  return '<div class="screen">' + topbar(title, state.daemonConnected, '', 'AUTO MODE') + body +
    '<div class="tkfoot">Turn to pick · press to choose · back to the machines</div></div>';
}

// ---- starting -------------------------------------------------------------------------

// The check screen's line under what was said.
export function checkLine(projectName, asksReachPanel) {
  return upper(projectName) + ' · AUTO MODE' + (asksReachPanel ? ' · ASKS ON THE CAR THING' : '');
}

// The codes a service or the mux answers with when it refused a request: nothing
// was started. 'Unknown method' is a service that does not know the request at all.
var REFUSALS = {
  'not-answering': true, 'unknown-host': true, 'empty-prompt': true, 'prompt-too-long': true,
  'not-a-recent-project': true, 'not-trusted': true, 'start-failed': true, 'Unknown method': true,
};

function codeOf(err) {
  return err && err.message !== undefined ? String(err.message) : String(err == null ? '' : err);
}

// What a failed start tells: 'refused' (the machine said no, so nothing runs and
// the same text may be sent again) or 'unknown' (the request's own timeout, a
// closed socket, anything else: the session may be running already).
export function startOutcome(err) {
  return Object.prototype.hasOwnProperty.call(REFUSALS, codeOf(err)) ? 'refused' : 'unknown';
}

// An error as the words for a toast (or for the project screen, when the machine
// didn't answer): the trust refusal in its own words, a service that doesn't know
// the request as NOT SET UP YET, another known code its text upper-cased with
// dashes as spaces. Everything else (a timeout, a closed socket) is a machine that
// didn't answer: never a method name. `host` is the machine that refused, for
// the trust words.
export function errorLabel(err, host) {
  var code = codeOf(err);
  if (code === 'not-trusted') return trustFirst(host);
  if (code === 'Unknown method') return NOT_SET_UP;
  if (Object.prototype.hasOwnProperty.call(REFUSALS, code)) return upper(code).replace(/-/g, ' ');
  return NOT_ANSWERING;
}

// The session whose id starts with the short id `claude --bg` printed, or null.
export function startedSessionId(sessions, shortId) {
  if (typeof shortId !== 'string' || !shortId) return null;
  var list = sessions || [];
  for (var i = 0; i < list.length; i++) {
    var id = list[i] && list[i].id;
    if (typeof id === 'string' && id.indexOf(shortId) === 0) return id;
  }
  return null;
}

// START: sent once. While one is on the wire a second press does nothing and
// returns false. `send` starts the request; the code that sees the answer sets
// view.starting back to false (startFailed does it for a refusal).
export function pressStart(view, send) {
  if (view.starting) return false;
  view.starting = true;
  send();
  return true;
}

// The screens a failed start may put the check screen back on: the ones the owner
// reaches the flow from and walks it on, or leaves resting.
var REOPEN_ROUTES = { list: true, 'new': true, ambient: true };

// Whether a start that failed some time after START may bring the check screen
// back on its own. It takes the whole screen, so only when nothing else is in the
// owner's hands: no dictation in progress (it would replace it, and the
// microphone would keep going), one of REOPEN_ROUTES (never a permission or a
// question), and no input in the last guardMs (jump.js's INPUT_GUARD_MS: a press
// meant for what was on screen must not land on this). ctx = { dictating,
// routeName, msSinceInput, guardMs }; a missing number is not "long ago".
export function canReopenCheck(ctx) {
  if (!ctx || ctx.dictating) return false;
  if (!REOPEN_ROUTES[ctx.routeName]) return false;
  return ctx.msSinceInput >= ctx.guardMs;
}

// How long ago the last input was, counting only input after sinceTs (all in
// ms): Infinity if there was none. A start's own press is what sent the request,
// so it is no hand on the panel when a fast refusal comes back within the guard.
export function msSinceInputAfter(lastInputTs, sinceTs, nowMs) {
  return lastInputTs > sinceTs ? nowMs - lastInputTs : Infinity;
}

// The pending check, handed over once; null when none.
export function takePending(view) {
  var p = view.pending;
  view.pending = null;
  return p;
}

export function dropPending(view) {
  view.pending = null;
}

// A start that failed: START works again, and the words for the toast are
// returned. A refusal with the owner free (canReopenCheck(ctx)) brings the check
// screen back with the same text (nothing spoken is lost). In every other case
// nothing is opened and the text is kept as the pending check for the next hold
// of the top button on the grid: the owner has moved on, or the outcome is
// unknown (the toast says to look at the list first). ctx = canReopenCheck's
// plus { host, project }, what the check screen needs (the host also picks the
// machine's words for a trust refusal).
export function startFailed(view, err, text, reopen, ctx) {
  view.starting = false;
  var unknown = startOutcome(err) === 'unknown';
  if (!unknown && canReopenCheck(ctx)) {
    view.pending = null;
    reopen(text);
  } else {
    view.pending = ctx && ctx.project ? { host: ctx.host, project: ctx.project, text: text } : null;
  }
  return unknown ? MAY_HAVE_STARTED : errorLabel(err, ctx && ctx.host);
}

// Waits for a started session to appear in the sessions list. start(shortId,
// sessions) looks now and then on every check(sessions), calling onListed(id)
// once; after waitMs without a match it calls onTimeout() once. Either way it
// is cleared, so a late listing is not followed. A new start replaces an old one.
export function createStartWatch(opts) {
  var waitMs = opts.waitMs || LISTED_WAIT_MS;
  var setTimer = opts.setTimer || function (fn, ms) { return setTimeout(fn, ms); };
  var clearTimer = opts.clearTimer || function (t) { clearTimeout(t); };
  var wanted = null;
  var timer = null;

  function stop() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    wanted = null;
  }

  function check(sessions) {
    if (wanted === null) return;
    var id = startedSessionId(sessions, wanted);
    if (id === null) return;
    stop();
    opts.onListed(id);
  }

  return {
    start: function (shortId, sessions) {
      stop();
      if (typeof shortId !== 'string' || !shortId) return opts.onTimeout();
      wanted = shortId;
      check(sessions);
      if (wanted === null) return;
      timer = setTimer(function () {
        timer = null;
        stop();
        opts.onTimeout();
      }, waitMs);
    },
    check: check,
    stop: stop,
    active: function () { return wanted !== null; },
  };
}
