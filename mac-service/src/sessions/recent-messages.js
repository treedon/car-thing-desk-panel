// The recent conversation of one transcript, for the panel's session view:
// what the owner typed, what Claude said, and (unless conversationOnly) one line
// per tool call. Read from the tail of the file only; a transcript can run to
// many megabytes.
import fs from 'node:fs';
import { toolLine } from '../tool-summary.js';
import { MESSAGE_PREFIX } from '../message-bridge.js';

const CLIP = 2000;
const CLIP_NEWEST_REPLY = 8000;

function clip(text, max) {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

export function readTail(file, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    // Starting mid-file almost always lands inside a line; that fragment is not
    // a record.
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return text;
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function tsOf(obj) {
  const ts = Date.parse(obj.timestamp || (obj.message && obj.message.timestamp) || '');
  return Number.isNaN(ts) ? 0 : ts;
}

// Typed prompts only: tool results, hook/system injections (isMeta) and
// compaction summaries are not the owner talking.
function userText(obj) {
  if (obj.isMeta || obj.isCompactSummary) return '';
  const content = obj.message && obj.message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c && c.type === 'text' && c.text).map((c) => c.text).join('\n');
}

// The text blocks of an assistant record, joined; '' when it carries none (a
// record that is only a tool call or thinking).
function assistantText(obj) {
  const content = obj.message && obj.message.content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c && c.type === 'text' && c.text).map((c) => c.text).join('\n').trim();
}

// conversationOnly is the session view: only what was said. No tool lines, and
// no background-task notices passed off as typed prompts. The one notice kept is
// a reply the owner sent from the panel, which wakes an idle session and is
// saved as a notice too; its words follow MESSAGE_PREFIX (matched anywhere in
// the text). Claude Code 2.1.220 saves it as "Stop hook feedback" inside a
// <system-reminder>, so the words end where that tag closes.
function entriesOf(obj, conversationOnly) {
  const ts = tsOf(obj);
  if (obj.type === 'user') {
    const text = userText(obj).trim();
    if (conversationOnly && obj.origin && obj.origin.kind === 'task-notification') {
      const at = text.indexOf(MESSAGE_PREFIX);
      if (at < 0) return [];
      const rest = text.slice(at + MESSAGE_PREFIX.length);
      const end = rest.indexOf('</system-reminder>');
      const said = (end < 0 ? rest : rest.slice(0, end)).trim();
      return said ? [{ role: 'user', text: said, ts, fromPanel: true }] : [];
    }
    return text ? [{ role: 'user', text, ts }] : [];
  }
  if (obj.type !== 'assistant') return [];
  const content = (obj.message && obj.message.content) || [];
  if (!Array.isArray(content)) return [];
  const out = [];
  const text = assistantText(obj);
  if (text) out.push({ role: 'assistant', text, ts });
  if (conversationOnly) return out;
  for (const c of content) {
    if (c && c.type === 'tool_use') out.push({ role: 'tool', text: toolLine(c.name || 'tool', c.input), ts });
  }
  return out;
}

// Whole records from the last maxBytes of a transcript; a torn line (Claude
// mid-write) or a cut first line is skipped, never thrown.
export function readTailRecords(jsonlPath, maxBytes) {
  const out = [];
  for (const line of readTail(jsonlPath, maxBytes).split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

export function readRecentMessages(jsonlPath, { limit = 40, maxBytes = 524288, conversationOnly = false } = {}) {
  const all = [];
  for (const obj of readTailRecords(jsonlPath, maxBytes)) {
    for (const e of entriesOf(obj, conversationOnly)) all.push(e);
  }
  const recent = all.slice(-limit);
  let newestReply = -1;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].role === 'assistant') { newestReply = i; break; }
  }
  return recent.map((m, i) => ({ ...m, text: clip(m.text, i === newestReply ? CLIP_NEWEST_REPLY : CLIP) }));
}

// The words Claude closed its newest turn with, unclipped: the text of the last
// assistant record that has any. For a Stop hook payload that did not carry
// last_assistant_message. '' when there is none, the file is missing, or the
// path is not a path.
export function lastAssistantText(jsonlPath, { maxBytes = 524288 } = {}) {
  const records = readTailRecords(jsonlPath, maxBytes);
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].type !== 'assistant') continue;
    const text = assistantText(records[i]);
    if (text) return text;
  }
  return '';
}
