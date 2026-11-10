// Subagents of one session, from Claude Code's own files:
//   <sessionDir>/subagents/agent-<id>.meta.json  {agentType, description, toolUseId,
//       spawnDepth, parentAgentId?, requestShape, finished?, stoppedByUser?}
//   <sessionDir>/subagents/agent-<id>.jsonl      the agent's transcript (isSidechain)
// where <sessionDir> is the session's transcript path without ".jsonl".
import fs from 'node:fs';
import path from 'node:path';
import { toolLine } from '../tool-summary.js';
import { readRecentMessages, readTailRecords } from './recent-messages.js';

const TAIL_BYTES = 64 * 1024;
// Enough for a first line holding a long prompt; the start time is on it.
const HEAD_BYTES = 256 * 1024;
const REPORT_CHARS = 400;
// A meta is a few hundred bytes; one past this is not one, and is skipped rather than read whole.
const META_MAX_BYTES = 64 * 1024;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function tsOf(obj) {
  const ts = Date.parse((obj && obj.timestamp) || '');
  return Number.isNaN(ts) ? 0 : ts;
}

// The start time is on the first record; read up to its newline in small
// pieces (a first prompt can run to many KB), never the whole file.
function firstTs(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const chunks = [];
    let pos = 0;
    while (pos < HEAD_BYTES) {
      const buf = Buffer.alloc(16 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (!n) break;
      const nl = buf.subarray(0, n).indexOf(0x0a);
      chunks.push(buf.subarray(0, nl >= 0 ? nl : n));
      pos += n;
      if (nl >= 0) break;
    }
    try { return tsOf(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { return 0; }
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function toolUses(records) {
  const out = [];
  for (const r of records) {
    const content = r.type === 'assistant' && r.message && r.message.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) if (c && c.type === 'tool_use') out.push(c);
  }
  return out;
}

function agentIds(dir) {
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.startsWith('agent-') && f.endsWith('.meta.json'))
      .map((f) => f.slice('agent-'.length, -'.meta.json'.length));
  } catch {
    return [];
  }
}

export function readSubagents(sessionDir, { sessionEnded }) {
  const dir = path.join(sessionDir, 'subagents');
  const agents = [];
  const toolUseOwner = new Map(); // tool_use id -> agent id that issued it
  for (const id of agentIds(dir)) {
    const meta = readJson(path.join(dir, `agent-${id}.meta.json`));
    if (!meta) continue;
    const jsonl = path.join(dir, `agent-${id}.jsonl`);
    const records = readTailRecords(jsonl, TAIL_BYTES);
    const uses = toolUses(records);
    for (const u of uses) if (u.id) toolUseOwner.set(u.id, id);
    const last = uses[uses.length - 1];
    let lastActivityTs = 0;
    for (const r of records) lastActivityTs = Math.max(lastActivityTs, tsOf(r));
    const startedTs = firstTs(jsonl) || lastActivityTs;
    agents.push({
      id,
      description: String(meta.description || meta.agentType || 'agent'),
      agentType: String(meta.agentType || ''),
      background: meta.requestShape === 'background',
      depth: Number(meta.spawnDepth) || 1,
      parentId: meta.parentAgentId || null,
      running: meta.finished !== true && !meta.stoppedByUser && !sessionEnded,
      currentTool: last ? toolLine(last.name || 'tool', last.input) : null,
      startedTs,
      lastActivityTs: lastActivityTs || startedTs,
      toolUseId: meta.toolUseId || null,
    });
  }
  // Older metas carry no parentAgentId; a nested agent is then found by its
  // spawning tool call inside another agent's transcript.
  for (const a of agents) {
    if (!a.parentId && a.depth > 1 && a.toolUseId) a.parentId = toolUseOwner.get(a.toolUseId) || null;
  }
  agents.sort((x, y) => x.startedTs - y.startedTs);
  return agents.map(({ toolUseId, ...a }) => a);
}

// The handback is the agent's report to its caller; a plain final reply is the
// report for agents that end without one.
function reportOf(records) {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    const content = r.type === 'assistant' && r.message && r.message.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c && c.type === 'tool_use' && c.name === 'SubagentHandback' && c.input && c.input.message) {
        return String(c.input.message);
      }
    }
    const text = content.filter((c) => c && c.type === 'text' && c.text).map((c) => c.text).join('\n').trim();
    if (text) return text;
  }
  return null;
}

// One meta file and its mtime, from one open file: null when it is missing, too big, not JSON or not an object.
function readMeta(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > META_MAX_BYTES) return null;
    const buf = Buffer.alloc(st.size);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const meta = JSON.parse(buf.toString('utf8', 0, n));
    return meta && typeof meta === 'object' && !Array.isArray(meta) ? { meta, mtimeMs: st.mtimeMs } : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// The digest's light read of a session's subagents: the meta files only, never a transcript
// (readSubagents reads a 64 KB tail of every one). Oldest meta file first, ties by id; a meta is
// rewritten when its agent finishes, so this is the order agents last changed state. Text fields are
// returned as the meta holds them, '' when not a string; the caller redacts and caps them.
export function listSubagentMetas(sessionDir) {
  const dir = path.join(sessionDir, 'subagents');
  const metas = [];
  for (const id of agentIds(dir)) {
    if (!id) continue;
    const read = readMeta(path.join(dir, `agent-${id}.meta.json`));
    if (!read) continue;
    const { meta, mtimeMs } = read;
    metas.push({
      id,
      description: typeof meta.description === 'string' ? meta.description : '',
      agentType: typeof meta.agentType === 'string' ? meta.agentType : '',
      finished: meta.finished === true,
      stoppedByUser: Boolean(meta.stoppedByUser),
      mtimeMs,
    });
  }
  return metas.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// A finished agent's report (reportOf's rule) cut to maxChars, read from the tail of its transcript;
// null while it runs, when its meta does not say finished: true, or when it has no report.
export function readSubagentReport(sessionDir, agentId, maxChars = REPORT_CHARS) {
  if (typeof agentId !== 'string' || !agentId || /[\\/\0]/.test(agentId)) return null;
  const dir = path.join(sessionDir, 'subagents');
  const meta = readJson(path.join(dir, `agent-${agentId}.meta.json`));
  if (!meta || meta.finished !== true) return null;
  const report = reportOf(readTailRecords(path.join(dir, `agent-${agentId}.jsonl`), TAIL_BYTES));
  return report ? report.slice(0, typeof maxChars === 'number' && maxChars >= 0 ? maxChars : REPORT_CHARS) : null;
}

export function readSubagentFeed(sessionDir, agentId, limit = 20) {
  const dir = path.join(sessionDir, 'subagents');
  const jsonl = path.join(dir, `agent-${agentId}.jsonl`);
  const meta = readJson(path.join(dir, `agent-${agentId}.meta.json`)) || {};
  const steps = readRecentMessages(jsonl, { limit });
  let report = null;
  if (meta.finished === true) {
    const r = reportOf(readTailRecords(jsonl, TAIL_BYTES));
    report = r ? r.slice(0, REPORT_CHARS) : null;
  }
  return { steps, report };
}

export function subagentCounts(list) {
  let running = 0;
  for (const a of list) if (a.running) running++;
  return { running, finished: list.length - running };
}
