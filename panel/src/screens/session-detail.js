import { esc, topbar, fmtTokens, fmtDuration, stateLabel, subagentIndentPx, messageStatusText, waitingLabel } from './helpers.js';
import { agentElapsed } from './subagent-feed.js';
import { now } from '../clock.js';
import { renderConversation } from './conversation.js';
import { sessionStrip, sessionCard } from './digest.js';
import { movesToVsCode } from '../session-actions.js';

// Same reading as the tile, with room for the number to breathe. Absent when
// the daemon can't work the fraction out — no meter beats a made-up one.
function contextMeter(fraction) {
  if (fraction == null) return '';
  var pct = Math.max(0, Math.min(1, fraction));
  return '<div class="dctx' + (pct >= 0.8 ? ' hot' : '') + '">' +
    '<div class="dctxrow"><span class="dctxpct">' + Math.round(pct * 100) + '%</span>' +
    '<span class="dctxlabel">context used</span></div>' +
    '<div class="dctxtrack"><span class="dctxfill" style="width:' + (pct * 100).toFixed(1) + '%"></span></div>' +
    '</div>';
}

// The session's subagents, oldest first, nested ones stepped right. The knob
// walks the rows once the list is on screen (main.js); a press opens one.
// Three action rows lead the selectable list: bringing this session forward on
// the Mac, whether opening a session does that by itself, and whether the Mac
// chimes when something needs the owner. A background session that is still
// running has more: a STOP row, and while its move to VS Code waits for the turn
// to end, OPEN NOW. They share the subagent rows' knob walk, so row indices
// count them first. main.js walks the rows it finds in the page; store.js
// (applySubagents) is the other place that needs this count, through
// actionRowCount.
export var ACTION_ROWS = 3;

// How many action rows lead the list for this session (its detail, which may
// not have loaded yet). Must match what macRows draws.
export function actionRowCount(d) {
  return actionRowIds(d).length;
}

// A background session still running: the only kind STOP and OPEN NOW mean
// anything for. Once it has ended the service no longer knows it, so a press
// could only say it is already gone.
function stoppable(d) {
  return !!(d && d.background && !d.ended);
}

// The action rows in the order macRows draws them, each named for what it is:
// open, OPEN NOW (a background session's wait), the two settings, STOP.
function actionRowIds(d) {
  var ids = ['open'];
  if (stoppable(d) && d.handoff === 'waiting') ids.push('stopnow');
  ids.push('autoopen', 'chime');
  if (stoppable(d)) ids.push('stop');
  return ids;
}

// Where the dial cursor `sel` lands when the session's action rows change under
// it (a new detail, `prev` to `next`), with `subagents` rows after them. It stays
// on the same logical row: a row that appears above it pushes it down, one that
// goes below it pulls it up, and if its own row went (OPEN NOW, finished) it is
// taken off the list, -1. Row 0 never moves. Without this, OPEN NOW appearing at
// index 1 under a cursor resting on "Open automatically" would sit selected
// there, one dial press from cutting the turn off.
export function cursorAfterRows(sel, prev, next, subagents) {
  if (sel <= 0) return sel;
  var was = actionRowIds(prev);
  var now = actionRowIds(next);
  if (was.join() === now.join()) return sel;
  var at;
  if (sel < was.length) {
    at = now.indexOf(was[sel]);
    if (at < 0) return -1;
  } else {
    at = sel - was.length + now.length;   // a subagent row keeps its subagent
  }
  return Math.min(at, subagents + now.length - 1);
}

function row(sel, at, action, label, sub, extra) {
  return '<div class="agrow macrow' + (extra || '') + (sel === at ? ' selected' : '') + '" data-action="' + action + '">' +
    '<div class="agtop"><span class="agdesc">' + esc(label) + '</span></div>' +
    (sub ? '<div class="agsub">' + esc(sub) + '</div>' : '') + '</div>';
}

// The chime lives on the Mac and the panel only flips it, so until the Mac has
// said which way it is set the row names the setting and claims no value. It
// stays a row either way, so the rows after it keep their indices.
function chimeRow(sel, at, chimeOn) {
  var known = typeof chimeOn === 'boolean';
  return row(sel, at, 'toggle-chime', 'Chime on the Mac' + (known ? ': ' + (chimeOn ? 'On' : 'Off') : ''),
    !known ? 'Not heard from the Mac yet' : chimeOn ? 'Plays when a session needs you' : 'The Mac stays quiet');
}

// The open row: a background session moves into a VS Code tab on its machine
// (at once if idle, when its turn ends if working, and mid-move says so);
// anything else raises its window. Its sub-label names the machine.
function openRow(sel, d) {
  var where = d && d.machine ? 'the NucBox' : 'the Mac';
  if (!movesToVsCode(d)) {
    return row(sel, 0, 'open-mac', 'Open in VS Code', 'Brings this session forward on ' + where);
  }
  if (d.handoff === 'waiting') {
    return row(sel, 0, 'handoff-cancel', 'OPENS IN VS CODE WHEN DONE', 'Press to cancel');
  }
  if (d.handoff === 'moving') return row(sel, 0, 'open-mac', 'OPENING IN VS CODE\u2026', '');
  return row(sel, 0, 'open-mac', 'Open in VS Code', 'Moves it to a tab on ' + where);
}

// STOP ends a background session, on the second press: the first arms it, and
// anything else the owner does disarms it (main.js).
function stopRow(sel, at, armed) {
  return row(sel, at, 'stop-session', armed ? 'PRESS AGAIN TO STOP' : 'STOP',
    armed ? 'Anything else cancels' : 'Ends this background session', ' stoprow' + (armed ? ' armed' : ''));
}

// Rows in the order the knob walks them: open, OPEN NOW (under it, while the
// move waits), the two Mac settings, STOP last.
function macRows(sel, autoOpen, chimeOn, d, stopArmed) {
  var live = stoppable(d);
  var at = 1;
  var html = openRow(sel, d);
  if (live && d.handoff === 'waiting') {
    html += row(sel, at++, 'handoff-now', 'OPEN NOW', 'Cuts the turn off and opens it now');
  }
  // The setting is the panel's, but what it opens is this session, on its own machine.
  var where = d && d.machine ? 'the NucBox' : 'the Mac';
  html += row(sel, at++, 'toggle-auto-open', 'Open automatically: ' + (autoOpen ? 'On' : 'Off'),
    autoOpen ? 'Opening a session here also opens it on ' + where : 'Checking in here leaves ' + where + ' alone');
  html += chimeRow(sel, at++, chimeOn);
  if (live) html += stopRow(sel, at++, stopArmed);
  return '<div class="aglist macrows">' + html + '</div>';
}

// One row per thing the session is waiting on, so a pile of jobs behind "waiting
// on 3 jobs" can be told apart. `since` is the Mac's clock, as is now().
function waitRows(waitingOn, nowMs) {
  if (!waitingOn || !waitingOn.length) return '';
  var rows = '';
  for (var i = 0; i < waitingOn.length; i++) {
    var w = waitingOn[i];
    rows += '<div class="waitrow"><span class="waitlabel">' + esc(w.label) + '</span>' +
      '<span class="waitage">' + esc(fmtDuration(Math.max(0, nowMs - w.since))) + '</span></div>';
  }
  return '<div class="waitlist">' + rows + '</div>';
}

function agentList(list, sel, lead) {
  if (!list || !list.length) return '';
  var rows = '';
  for (var i = 0; i < list.length; i++) {
    var a = list[i];
    rows += '<div class="agrow' + (a.running ? ' running' : '') + (i + lead === sel ? ' selected' : '') +
      '" data-action="open-agent" data-id="' + esc(a.id) + '" style="margin-left:' + subagentIndentPx(a.depth) + 'px">' +
      '<div class="agtop"><span class="lamp ' + (a.running ? 'busy' : 'idle') + '"></span>' +
      '<span class="agdesc">' + esc(a.description) + '</span>' +
      '<span class="agstate">' + (a.running ? 'RUNNING' : 'DONE') + '</span></div>' +
      '<div class="agsub">' + esc([a.agentType, a.background ? 'BACKGROUND' : '', agentElapsed(a)].filter(Boolean).join('  ·  ')) + '</div>' +
      (a.currentTool && a.running ? '<div class="agtool">' + esc(a.currentTool) + '</div>' : '') +
      '</div>';
  }
  return '<div class="aglist"><div class="aghead">Subagents</div>' + rows + '</div>';
}

// Under the newest message: how the last dictated message went, then how to
// send one.
function messageTail(status) {
  var text = messageStatusText(status);
  return (text ? '<div class="cv cv-msgstatus ' + esc(status.status) + '">' + esc(text) + '</div>' : '') +
    '<div class="cv cv-hint">Hold the top button to send Claude a message.</div>';
}

export function renderDetail(state, id) {
  var d = state.details[id];
  if (!d) {
    return '<div class="screen">' + topbar('SESSION', state.daemonConnected) +
      '<div class="empty">LOADING…</div></div>';
  }
  var meta = [
    d.cwd ? d.cwd.split('/').pop() : null,
    d.model ? d.model.replace(/^claude-/, '') : null,
    d.startedTs ? fmtDuration(now() - d.startedTs) : null,
  ];
  var metaStr = [];
  for (var i = 0; i < meta.length; i++) if (meta[i]) metaStr.push(meta[i]);

  // One scrolling column: the conversation first (the view opens with its end
  // at the bottom of the screen), then the status block, reached by scrolling
  // past the newest message.
  var messages = state.messages ? state.messages[id] : null;
  var agents = state.subagents ? state.subagents[id] : null;
  // A stopped turn with background work still going: say so where "no active
  // tool" would otherwise read as nothing happening. An ended session is
  // waiting on nothing, whatever it was waiting on when it died.
  var waitingOn = d.ended ? [] : d.waitingOn;
  var waiting = waitingLabel(waitingOn, now());
  return '<div class="screen">' + topbar('SESSION', state.daemonConnected) +
    sessionStrip(state, id) +
    '<div class="dscroll" id="dscroll">' +
    '<div class="dtitle">' + esc(d.name) + '</div>' +
    renderConversation(messages || null, messageTail(state.messageStatus ? state.messageStatus[id] : null)) +
    sessionCard(state, id) +
    macRows(state.agentSel, !!state.autoOpenOnMac, state.chimeOn, d, state.stopArmedFor === id) +
    agentList(agents, state.agentSel, actionRowCount(d)) +
    '<div class="detail state-' + d.state + '">' +
    '<div class="meta">' + esc(metaStr.join(' · ')) + '</div>' +
    '<div class="activity">' + esc(waiting || (d.currentTool ? d.currentTool + ' — working' : 'no active tool')) + '</div>' +
    waitRows(waitingOn, now()) +
    '<div class="lasttext">' + esc(d.lastMessage || '') + '</div>' +
    contextMeter(d.context) +
    '<div class="statsrow">' +
    '<div class="stat"><div class="v">' + fmtTokens(d.tokens.out) + '</div><div class="k">tokens out</div></div>' +
    '<div class="stat"><div class="v">' + fmtTokens(d.tokens.in) + '</div><div class="k">tokens in</div></div>' +
    '<div class="stat"><div class="v">' + fmtTokens(d.cacheRead) + '</div><div class="k">cache read</div></div>' +
    '<div class="stat"><div class="v">' + stateLabel(d.state, d.ended) + '</div><div class="k">state</div></div>' +
    '</div></div></div></div>';
}
