import { esc, topbar } from './helpers.js';
import { now } from '../clock.js';
import { renderConversation, renderMarkdown } from './conversation.js';
import { promptRows, currentQuestion, isPlan } from '../prompt-answer.js';

// A question or plan Claude Code is waiting on, held by the Mac service until
// it is answered here, the owner picks "Answer in VS Code", or the hold runs
// out. One scrolling column: what led up to it (dimmed), the question or the
// plan, then the rows. A thin bar under the top bar counts the hold down.

function rowHtml(row, selected, index, machine) {
  var cls = 'prow ' + row.kind + (row.picked ? ' picked' : '') + (selected ? ' selected' : '');
  var label;
  if (row.kind === 'option') {
    label = '<span class="plabel">' + esc(row.label) + '</span>' +
      (row.description ? '<span class="pdesc">' + esc(row.description) + '</span>' : '');
  } else if (row.kind === 'approve') label = '<span class="plabel">Approve</span>';
  else if (row.kind === 'say') label = '<span class="plabel">' + (row.plan ? 'Say what to change' : 'Say an answer') + '</span><span class="pdesc">hold the top button to talk</span>';
  else label = '<span class="plabel">Answer in VS Code</span><span class="pdesc">' +
    (machine ? 'on the ' + esc(machine) : 'raises the window on your Mac') + '</span>';
  return '<div class="' + cls + '" data-action="prompt-row" data-id="' + index + '">' + label + '</div>';
}

function countdown(p) {
  // Whole seconds only, so the markup (and the DOM) changes at most once a
  // second; the CSS animation runs the bar down smoothly in between.
  var elapsed = Math.floor(Math.max(0, now() - p.createdTs) / 1000) * 1000;
  var left = Math.max(0, p.holdMs - elapsed);
  return '<div class="pcount"><span class="pcountfill" style="width:' +
    (left / p.holdMs * 100).toFixed(1) + '%;animation-duration:' + left + 'ms"></span></div>';
}

export function renderPrompt(state, p, ui, cursor) {
  var plan = isPlan(p);
  var head = '';
  if (plan) {
    head = '<div class="pkicker" id="panchor">Plan for your approval</div><div class="pplan">' + renderMarkdown(p.plan) + '</div>';
  } else {
    var q = currentQuestion(p, ui);
    var total = (p.questions || []).length;
    head = '<div class="pkicker" id="panchor">' + esc(q ? q.header || 'Question' : 'Question') +
      (total > 1 ? '  ·  ' + (ui.q + 1) + ' of ' + total : '') +
      (q && q.multiSelect ? '  ·  pick any, then press the top button' : '') + '</div>' +
      '<div class="pquestion">' + esc(q ? q.question : '') + '</div>';
  }
  var body;
  if (p.expired) {
    body = '<div class="pmoved">Moved to VS Code. Answer it there.</div>';
  } else {
    var rows = promptRows(p, ui);
    body = '<div class="prows">';
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].kind === 'say') rows[i].plan = plan;
      body += rowHtml(rows[i], i === cursor, i, p.machine);
    }
    body += '</div>';
  }
  var context = p.context && p.context.length
    ? '<div class="pcontext">' + renderConversation(p.context).replace('<div id="cvend"></div>', '') + '</div>' : '';
  return '<div class="screen">' + topbar(plan ? 'PLAN' : 'QUESTION', state.daemonConnected) +
    (p.expired ? '' : countdown(p)) +
    '<div class="dscroll" id="dscroll">' +
    '<div class="psession">' + esc(p.sessionName || 'session') + '</div>' +
    context + head + body + '<div id="cvend"></div>' +
    '</div></div>';
}
