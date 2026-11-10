import { esc, topbar, fmtDuration } from './helpers.js';
import { now } from '../clock.js';
import { renderConversation } from './conversation.js';

export function findAgent(state, sessionId, agentId) {
  var list = (state.subagents && state.subagents[sessionId]) || [];
  for (var i = 0; i < list.length; i++) if (list[i].id === agentId) return list[i];
  return null;
}

// How long an agent has run: to now while running, to its last step once done.
export function agentElapsed(a) {
  if (!a.startedTs) return '';
  return fmtDuration((a.running ? now() : a.lastActivityTs || now()) - a.startedTs);
}

// One subagent's own conversation: its prompt, replies and tool lines, newest
// at the bottom, with its report to the caller as the final block once done.
// Scrolls in the same #dscroll column as the session view.
export function renderFeed(state, sessionId, agentId) {
  var a = findAgent(state, sessionId, agentId);
  var feed = state.feeds ? state.feeds[agentId] : null;
  var meta = [];
  if (a) {
    if (a.agentType) meta.push(a.agentType);
    meta.push(a.running ? 'running' : 'done');
    var el = agentElapsed(a);
    if (el) meta.push(el);
  }
  var report = feed && feed.report
    ? '<div class="agreport"><div class="agreportk">Report</div>' + esc(feed.report).replace(/\n/g, '<br>') + '</div>'
    : '';
  return '<div class="screen">' + topbar('AGENT', state.daemonConnected) +
    '<div class="dscroll" id="dscroll">' +
    '<div class="dtitle">' + esc(a ? a.description : 'Subagent') + '</div>' +
    '<div class="agmeta">' + esc(meta.join(' · ')) + '</div>' +
    renderConversation(feed ? feed.steps : null).replace('<div id="cvend"></div></div>', report + '<div id="cvend"></div></div>') +
    '</div></div>';
}
