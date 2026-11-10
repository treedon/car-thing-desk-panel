import { esc } from './helpers.js';

// The recent conversation, set for reading at arm's length: what the owner
// typed (a reply sent from the panel is labelled as such), what Claude said
// (minimal markdown), and one dim line per tool call where the feed has them.
// Used by the session view and the subagent feed.

function inline(text) {
  // Code spans first, so nothing inside them is touched; bold/italic markers
  // are dropped rather than rendered, since weight changes read poorly at 22px.
  var parts = text.split('`');
  var out = '';
  for (var i = 0; i < parts.length; i++) {
    if (i % 2 === 1 && i < parts.length - 1) out += '<code>' + esc(parts[i]) + '</code>';
    else {
      var plain = parts[i].replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1');
      out += esc(i % 2 === 1 ? '`' + plain : plain);
    }
  }
  return out;
}

var BULLET = /^\s*[-*]\s+/;

export function renderMarkdown(text) {
  var lines = String(text || '').split('\n');
  var html = '';
  var para = [];
  var list = [];

  function flush() {
    if (para.length) { html += '<p>' + para.join('<br>') + '</p>'; para = []; }
    if (list.length) { html += '<ul><li>' + list.join('</li><li>') + '</li></ul>'; list = []; }
  }

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      var code = [];
      for (i = i + 1; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
      html += '<pre>' + esc(code.join('\n')) + '</pre>';
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    if (BULLET.test(line)) {
      if (para.length) flush();
      list.push(inline(line.replace(BULLET, '')));
      continue;
    }
    if (list.length) flush();
    para.push(inline(line.replace(/^#+\s+/, '')));
  }
  flush();
  return html;
}

function entry(m) {
  if (m.role === 'user') {
    var from = m.fromPanel ? '<div class="cv-from">from the panel</div>' : '';
    return '<div class="cv cv-user">' + from + esc(m.text).replace(/\n/g, '<br>') + '</div>';
  }
  if (m.role === 'tool') return '<div class="cv cv-tool">' + esc(m.text.split('\n')[0]) + '</div>';
  return '<div class="cv cv-asst">' + renderMarkdown(m.text) + '</div>';
}

// messages: Message[] (oldest first), or null while the first fetch is out.
// The #cvend marker is where the view opens scrolled to.
// tail: extra markup after the last message (a status line), still above the
// end marker the view opens on.
export function renderConversation(messages, tail) {
  var body;
  if (!messages) body = '<div class="cv cv-note">Loading conversation…</div>';
  else if (!messages.length) body = '<div class="cv cv-note">No messages yet.</div>';
  else {
    body = '';
    for (var i = 0; i < messages.length; i++) body += entry(messages[i]);
  }
  return '<div class="convo">' + body + (tail || '') + '<div id="cvend"></div></div>';
}
