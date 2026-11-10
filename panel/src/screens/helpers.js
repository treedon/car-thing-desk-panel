import { fmtClock } from '../clock.js';

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function fmtTokens(n) {
  n = n || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(n);
}

export function fmtDuration(ms) {
  var mins = Math.floor(ms / 60000);
  if (mins < 60) return mins + 'm';
  return Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm';
}

// How long ago, in the one unit that matters: now under a minute, minutes under an hour, hours under
// 48 h, then days. A clock that is ahead of the thing it times, or a value that is not a number,
// reads as now rather than as a negative or NaN age.
export function fmtAge(ms) {
  if (!(ms >= 60e3 && ms < Infinity)) return 'now';
  if (ms < 3600e3) return Math.floor(ms / 60e3) + 'm';
  if (ms < 48 * 3600e3) return Math.floor(ms / 3600e3) + 'h';
  return Math.floor(ms / 86400e3) + 'd';
}

// What a session that has stopped is still waiting on, as the line under its
// tile's name: "waiting on npm test · 4m", or a count once there are several.
// waitingOn is the Mac's [{type, label, since}] with `since` in the Mac's epoch
// ms, so nowMs must be the panel's server-corrected clock (clock.js now()), not
// the device's. Null when nothing is in flight. A Mac clock a little ahead of
// the panel's would make the time negative, so it stops at zero.
//
// Two parts rather than one string so the tile can clip the first and never the
// second: how long it has been is the half worth knowing.
export function waitingParts(waitingOn, nowMs) {
  if (!waitingOn || !waitingOn.length) return null;
  var oldest = waitingOn[0].since;
  for (var i = 1; i < waitingOn.length; i++) {
    if (waitingOn[i].since < oldest) oldest = waitingOn[i].since;
  }
  var what = waitingOn.length === 1 ? waitingOn[0].label : waitingOn.length + ' jobs';
  return { what: 'waiting on ' + what, age: fmtDuration(Math.max(0, nowMs - oldest)) };
}

// The same, as one line; '' when nothing is in flight.
export function waitingLabel(waitingOn, nowMs) {
  var w = waitingParts(waitingOn, nowMs);
  return w ? w.what + ' · ' + w.age : '';
}

export function stateLabel(state, ended) {
  if (state === 'idle') return ended ? 'ENDED' : 'IDLE';
  return { busy: 'WORKING', attention: 'ATTENTION', celebrate: 'DONE' }[state] || 'IDLE';
}

// Permission mode, as the daemon reports it, shortened to something that fits
// a tile header. `auto` and `acceptEdits` stay distinct: they are two different
// modes, and the newer name replacing the older one is not a reason to draw
// them the same. Anything unrecognized — including a session no source has
// reported a mode for — returns null and the tile draws no badge.
var MODE_LABELS = {
  plan: 'PLAN',
  bypassPermissions: 'BYPASS',
  acceptEdits: 'EDITS',
  auto: 'AUTO',
  default: 'MANUAL',
};

export function modeLabel(mode) {
  return MODE_LABELS[mode] || null;
}

// Reasoning effort, as the daemon reports it. Whitelisted like the modes: the
// label doubles as a class name, and an unknown level draws neither label nor
// gait — the tile falls back to the plain working sprite. `ultrathink` renders
// as ULTRA: the full word was the only thing forcing the label under the 14px
// type floor; abbreviated, every label clears the meter and the tile edge.
var EFFORT_LABELS = {
  low: 'LOW',
  medium: 'MEDIUM',
  high: 'HIGH',
  xhigh: 'XHIGH',
  max: 'MAX',
  ultrathink: 'ULTRA',
};

export function effortLabel(effort) {
  return EFFORT_LABELS[effort] || null;
}

// A command you cannot take back must not cost the same gesture as "read a
// file". Anything flagged destructive costs a second press on the allow chip,
// on the queue hero and the prompt screen alike. The daemon now classifies at
// the source — against the full command, where a --force past the 200-char
// summary truncation is still visible — and sends the verdict on the ask. The
// regex stays as the fallback for daemons too old to send one, kept verbatim
// in sync with daemon/src/permission-bridge.js.
var DESTRUCTIVE_RE = /\brm\s+-|--force\b|--hard\b|\bDROP\s|\bTRUNCATE\b|\bmkfs|\bdd\s+if=|\bchmod\s+777\b|curl[^|]*\|\s*(ba|z)?sh/i;

export function isDestructive(ask) {
  if (ask.kind !== 'permission') return false;
  if (typeof ask.destructive === 'boolean') return ask.destructive;
  return DESTRUCTIVE_RE.test(String(ask.summary || ''));
}

// Which session's detail stream this screen actually reads: the open detail
// page's session, or the grid cursor's. Every other screen renders no detail,
// so the daemon can keep the rest of the stream to itself (null = none).
export function watchTarget(routeName, routeArg, state) {
  if (routeName === 'session' || routeName === 'agent') return routeArg || null;
  if (routeName === 'list') {
    var s = state.sessions[state.selectedIndex];
    return s ? s.id : null;
  }
  return null;
}

// Which of the four sections (Home, Audio, Agents, Queue) the screen being
// drawn belongs to; main.js sets it before each render. -1 lights none.
var section = -1;
export function setSection(n) { section = n; }

function sectionDots() {
  var html = '<span class="sdots">';
  for (var i = 0; i < 4; i++) html += '<span class="sdot' + (i === section ? ' on' : '') + '"></span>';
  return html + '</span>';
}

// hint: optional small text on the right, before the section dots (the sessions
// grid's HOLD TOP · NEW, the new-session screens' WHERE? and AUTO MODE).
export function topbar(title, connected, count, hint) {
  return '<div class="topbar"><span class="mark"></span>' +
    '<span class="title">' + esc(title) + '</span>' +
    (count ? '<span class="tcount">' + esc(count) + '</span>' : '') +
    '<span class="spacer"></span>' +
    (hint ? '<span class="thint">' + esc(hint) + '</span>' : '') + sectionDots() +
    '<span class="clock">' + fmtClock() + '</span>' +
    '<span class="conn' + (connected ? ' ok' : '') + '"></span></div>';
}

// A tile's two names: what the session is about (its Claude Code title), and
// where it runs. The project line is dropped when it would only repeat the title.
export function tileLabels(session) {
  var title = session.name || '';
  var project = session.project || '';
  var sub = project && project !== title ? project : '';
  // Sessions on the NucBox carry machine: 'NucBox' (ws.js).
  if (session.machine) sub = session.machine + (sub ? ' · ' + sub : '');
  return { title: title, subtitle: sub };
}

// The tile's subagent line: running agents matter more than finished ones, so
// they win the line whenever there are any.
export function subagentBadge(counts) {
  if (!counts) return null;
  var r = counts.running || 0;
  var f = counts.finished || 0;
  if (r) return r + (r === 1 ? ' agent' : ' agents') + ' running';
  if (f) return f + (f === 1 ? ' agent' : ' agents') + ' done';
  return null;
}

// Nested agents step right by 20px per level, capped so a deep chain still
// leaves room for its description.
export function subagentIndentPx(depth) {
  return Math.min(60, Math.max(0, ((depth || 1) - 1) * 20));
}

// The host app of the session an ask came from ('vscode' | 'terminal' | 'unknown').
export function askHost(ask, state) {
  var sessions = (state && state.sessions) || [];
  for (var i = 0; i < sessions.length; i++) {
    if (sessions[i].id === ask.sessionId) return sessions[i].host || 'unknown';
  }
  return 'unknown';
}

// The line under the conversation after the owner sends a dictated message.
var MESSAGE_STATUS = {
  'next-tool': 'Sent. Claude gets it at its next step.',
  wake: 'Sent. Waking Claude…',
  'cannot-wake': "Not sent. This session can't be woken from the panel (idle over an hour, or hooks not installed). Say it in VS Code.",
  answer: 'Sent as your answer.',
  delivered: 'Delivered.',
  dropped: 'Dropped because you typed in VS Code.',
  'unknown-session': "Not sent. The Mac doesn't know this session any more.",
  'answer-on-panel': 'Not sent. This question has several parts; answer it on the question screen.',
  sending: 'Sending…',
};

export function messageStatusText(m) {
  if (!m) return '';
  if (m.status === 'failed') return "Couldn't send: " + (m.error || 'unknown error');
  return MESSAGE_STATUS[m.status] || '';
}
