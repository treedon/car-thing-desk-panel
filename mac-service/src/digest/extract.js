// The transcript fact extractor (spec, "The fact extractor"): one Claude Code session transcript,
// record by record, in; the facts a digest card shows out. Pure: no I/O. The reader pushes each
// whole JSONL line with the byte offset just past it; a line that does not parse is pushed as null.
//
// The unit is a turn: everything up to a stop_hook_summary record or, without one, up to the next
// owner prompt after an end_turn or an interrupt. snapshot() holds closed turns only, and its
// offset stops just past the last record of the last one: the stop summary, or the record before
// the prompt that closed it. The open turn keeps its own copy of the id counters, its latest prompt,
// its skipped count, its tool facts and its counts for the session totals until it closes, so a
// restart that re-reads it from that offset numbers and counts its facts exactly as one pass would.
// A turn's fact ids are given when it closes, in the order the turn lists its facts.
//
// push() runs once per record in the process that answers Claude Code's hooks, on records of
// hundreds of KB, so each record is handled in about one pass over its text. A reply is redacted
// once, when its turn closes, not once per assistant record. A Bash command is read to its first
// 64 KB and a test run's output to its last 256 KB, so one record's cost stays bounded.
import path from 'node:path';
import { redact } from './redact.js';
import { isTestCommand, parseTestOutcome, isCommitCommand, commitSubject, resultText, relPath } from './parse.js';

export const LIMITS = Object.freeze({ turns: 6, promptChars: 500, replyChars: 1200, files: 8, commits: 5, git: 3, tests: 3, failures: 3,
  commandChars: 160, questionChars: 160, agents: 6, reportChars: 300 });

const TITLE_CHARS = 60;
const MODEL_CHARS = 80;
const PATH_CHARS = 200;
const SUBJECT_CHARS = 160;
const BRANCH_CHARS = 100;
const ACTION_CHARS = 40;

const MAX_SEEN = 2000; // seenFiles and prNumbers hold at most this many; so does one turn's set of paths
const MAX_PENDING = 64; // tool calls of one turn awaiting their result
const MAX_COMMAND = 64 * 1024; // a Bash command is kept to this many chars
const MAX_PATH = 4096;
const MAX_OUTPUT = 256 * 1024; // a test run prints its counts last: only this much of the output's end is parsed

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHA = /^[0-9a-f]{7,64}$/i;
// Appended to a cut command, it changes any commit message read up to the cut: it closes a quote left open there
// and lengthens a bare value or a heredoc terminator that ends there. A message read whole before the cut is unchanged.
const PROBE = 'x"\'';

// Carry nothing a card shows: ignored without counting as skipped. So are sidechain records, and
// system records other than stop_hook_summary.
const BOOKKEEPING = new Set(['attachment', 'file-history-snapshot', 'file-history-delta', 'queue-operation', 'last-prompt', 'api-request',
  'api-request-shape', 'api-request-blob', 'cost-state', 'mode', 'permission-mode', 'bridge-session', 'atis-latch', 'frame-link', 'summary']);

function emptyFacts(sessionId) {
  return {
    sessionId: sessionId ?? null, offset: 0,
    title: 'session', titleSource: null, project: null, model: null, startedTs: 0, turns: [],
    totals: { turns: 0, files: 0, commits: 0, prs: 0, testRuns: 0 }, turnLog: [], seenFiles: [], prNumbers: [],
    lastHumanPrompt: null, hasHumanPrompt: false, lastTurnTs: 0, next: { P: 1, R: 1, F: 1, C: 1, G: 1, T: 1, X: 1, Q: 1 }, skipped: 0,
  };
}

// Known fields only, copied, so the caller's object is never shared.
function restore(sessionId, saved) {
  const facts = emptyFacts(sessionId);
  if (!saved || typeof saved !== 'object') return facts;
  const s = JSON.parse(JSON.stringify(saved));
  for (const k of Object.keys(facts)) if (k !== 'sessionId' && s[k] !== undefined) facts[k] = s[k];
  facts.sessionId = sessionId ?? s.sessionId ?? null;
  facts.totals = { ...emptyFacts().totals, ...s.totals };
  facts.next = { ...emptyFacts().next, ...s.next };
  for (const k of ['turns', 'turnLog', 'seenFiles', 'prNumbers']) if (!Array.isArray(facts[k])) facts[k] = [];
  return facts;
}

const head = (s, n) => (s.length > n ? s.slice(0, n) : s);

// A short text fact from a field that may be anything: redacted, then capped; null when absent.
const label = (v, cap) => (typeof v === 'string' && v ? redact(v).slice(0, cap) : null);

// A PR number: a positive integer, or the digits of one.
function prNumber(v) {
  const n = typeof v === 'string' && /^\d{1,9}$/.test(v) ? Number(v) : v;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// Appends, keeping the last cap items.
function keep(list, item, cap) {
  list.push(item);
  if (list.length > cap) list.shift();
}

// The end of a test run's output, from a line start: a count cut through would read as a smaller one.
function tail(text) {
  if (text.length <= MAX_OUTPUT) return text;
  const from = text.length - MAX_OUTPUT;
  const cut = text.slice(from);
  if (text.charCodeAt(from - 1) === 10) return cut;
  const nl = cut.indexOf('\n');
  return nl < 0 ? cut : cut.slice(nl + 1);
}

// The first line of a plan that has text once its heading marks are gone. Walks the lines.
function planLine(plan) {
  if (typeof plan !== 'string') return '';
  for (let from = 0; from < plan.length;) {
    let nl = plan.indexOf('\n', from);
    if (nl < 0) nl = plan.length;
    const line = plan.slice(from, nl).replace(/^\s*#+/, '').trim();
    if (line) return line;
    from = nl + 1;
  }
  return '';
}

// The added and removed lines of an edit result's structuredPatch.
function countLines(patch, file) {
  if (!Array.isArray(patch)) return;
  for (const hunk of patch) {
    if (!hunk || !Array.isArray(hunk.lines)) continue;
    for (const line of hunk.lines) {
      if (typeof line !== 'string') continue;
      const c = line.charCodeAt(0);
      if (c === 43) file.added++; // +
      else if (c === 45) file.removed++; // -
    }
  }
}

// The non-empty text blocks of a message's content, joined: one pass over the blocks.
function textOf(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const c of content) if (c && c.type === 'text' && typeof c.text === 'string' && c.text) parts.push(c.text);
  return parts.join('\n');
}

// What the owner typed, by recent-messages.js's userText rule, trimmed: string content or the text
// blocks; tool results, isMeta injections and compaction summaries give ''.
function userText(r) {
  if (r.isMeta || r.isCompactSummary) return '';
  const content = r.message && r.message.content;
  return (typeof content === 'string' ? content : textOf(content)).trim();
}

// The tool_result blocks of a user record: one pass over its content.
function toolResults(r) {
  const content = r.message && r.message.content;
  const out = [];
  if (Array.isArray(content)) for (const c of content) if (c && c.type === 'tool_result') out.push(c);
  return out;
}

export function createExtractor({ sessionId, saved, now = Date.now, fallbackTs } = {}) {
  const facts = restore(sessionId, saved);
  let customTitle = facts.titleSource === 'custom' ? facts.title : '';
  let aiTitle = facts.titleSource === 'ai' ? facts.title : '';
  let prevTs = saved ? facts.lastTurnTs || facts.startedTs : 0;
  let open = null; // the turn in progress; never in a snapshot
  let lastEnd = facts.offset; // the offset just past the record pushed before this one
  const knownPrs = new Set(facts.prNumbers); // facts.prNumbers, for lookups in constant time

  function refreshTitle() {
    facts.titleSource = customTitle ? 'custom' : aiTitle ? 'ai' : null;
    facts.title = customTitle || aiTitle || (facts.project || '').slice(0, TITLE_CHARS) || 'session';
  }
  refreshTitle();

  // A missing timestamp carries the previous record's (fallbackTs, else now, before any); a future
  // one clamps to now.
  function stamp(r) {
    const t = now();
    const ts = Math.min(t, Date.parse(r.timestamp) || prevTs || fallbackTs || t);
    prevTs = ts;
    if (!facts.startedTs) facts.startedTs = ts;
    if (!facts.project && typeof r.cwd === 'string' && path.basename(r.cwd)) {
      facts.project = redact(path.basename(r.cwd));
      refreshTitle();
    }
    return ts;
  }

  // The open turn. `turn` is the Turn it becomes; its fact lists are staged beside it, without ids,
  // and so are its counts for the session totals: files by path, test runs, commits and new PR numbers.
  function newTurn(trigger, intent, startTs) {
    return {
      turn: { trigger, intent: intent ? { id: intent.id, text: intent.text } : null, startTs, endTs: startTs, reply: null,
        files: [], commits: [], git: [], tests: [], failures: [], questions: { count: 0, last: null }, agentsSpawned: 0, denied: 0 },
      replyText: '', endTurnAt: null, lastPrompt: null, next: { ...facts.next }, skipped: 0,
      pending: new Map(), files: new Map(), touches: 0, commits: [], git: [], tests: [], failures: [], question: null,
      commitCount: 0, testRuns: 0, prs: new Set(),
    };
  }

  function close(t, end, offset) {
    const turn = t.turn, next = t.next;
    turn.endTs = Math.max(turn.startTs, end);
    turn.reply = t.replyText ? { id: 'R' + next.R++, text: redact(t.replyText).slice(0, LIMITS.replyChars) } : null;
    // the largest files first, ties to the one touched last
    const files = [...t.files.values()].sort((a, b) => b.added + b.removed - (a.added + a.removed) || b.touched - a.touched);
    turn.files = files.slice(0, LIMITS.files).map((f) => ({ id: 'F' + next.F++, path: f.path, created: f.created, added: f.added, removed: f.removed }));
    turn.commits = t.commits.map((c) => ({ id: 'C' + next.C++, ...c }));
    turn.git = t.git.map((g) => ({ id: 'G' + next.G++, ...g }));
    turn.tests = t.tests.map((x) => ({ id: 'T' + next.T++, ...x }));
    turn.failures = t.failures.map((x) => ({ id: 'X' + next.X++, ...x }));
    if (t.question) turn.questions.last = { id: 'Q' + next.Q++, ...t.question };
    facts.turns.push(turn);
    if (facts.turns.length > LIMITS.turns) facts.turns.shift();
    const seen = t.files.size ? new Set(facts.seenFiles) : null;
    for (const p of t.files.keys()) {
      if (seen.has(p) || facts.seenFiles.length >= MAX_SEEN) continue;
      seen.add(p);
      facts.seenFiles.push(p);
      facts.totals.files++;
    }
    const prsBefore = facts.prNumbers.length;
    for (const n of t.prs) {
      if (facts.prNumbers.length >= MAX_SEEN || knownPrs.has(n)) continue;
      knownPrs.add(n);
      facts.prNumbers.push(n);
    }
    facts.totals.turns++;
    facts.totals.commits += t.commitCount;
    facts.totals.prs = facts.prNumbers.length;
    facts.totals.testRuns += t.testRuns;
    facts.turnLog.push({ endTs: turn.endTs, commits: t.commitCount, prs: facts.prNumbers.length - prsBefore, testRuns: t.testRuns });
    facts.lastTurnTs = turn.endTs;
    facts.offset = offset;
    facts.next = next;
    facts.skipped += t.skipped;
    if (t.lastPrompt) {
      facts.lastHumanPrompt = t.lastPrompt;
      facts.hasHumanPrompt = true;
    }
    open = null;
  }

  // Assistant output and tool results open a continuation turn when none is open.
  function work(ts) {
    if (!open) open = newTurn('none', facts.lastHumanPrompt, ts);
    return open;
  }

  function onPrompt(text, ts) {
    // No stop summary: the prompt ends a turn that reached end_turn or was interrupted. The records
    // since then (notices, tool results, torn lines) were folded into it, so the offset moves past
    // them too, and a restart does not read them again.
    if (open && open.endTurnAt) close(open, open.endTurnAt.ts, lastEnd);
    if (!open) open = newTurn('human', null, ts);
    const prompt = { id: 'P' + open.next.P++, text: redact(text).slice(0, LIMITS.promptChars), ts };
    if (!open.turn.intent) open.turn.intent = { id: prompt.id, text: prompt.text };
    open.lastPrompt = prompt;
  }

  // A PR not yet known, from gitOperation.pr or a pr-link record: a G fact, and staged for prNumbers. Past
  // the prNumbers cap a PR is neither, so the turn's PR count and totals.prs stop together.
  function onPr(t, number, action) {
    if (number === null || knownPrs.has(number) || t.prs.has(number) || facts.prNumbers.length + t.prs.size >= MAX_SEEN) return;
    t.prs.add(number);
    keep(t.git, { kind: 'pr', number, action }, LIMITS.git);
  }

  // A call whose result gives its facts waits for it with only what those need: a path or a command.
  function onToolUse(t, c) {
    const name = c.name;
    const input = c.input && typeof c.input === 'object' ? c.input : {};
    if (name === 'Bash' || FILE_TOOLS.has(name)) {
      const id = c.id;
      const v = name === 'Bash' ? input.command : typeof input.file_path === 'string' ? input.file_path : input.notebook_path;
      if (typeof id !== 'string' || !id || typeof v !== 'string' || !v) return;
      if (!t.pending.has(id) && t.pending.size >= MAX_PENDING) t.pending.delete(t.pending.keys().next().value);
      t.pending.set(id, name === 'Bash' ? { name, command: head(v, MAX_COMMAND), cut: v.length > MAX_COMMAND } : { name, path: head(v, MAX_PATH) });
    } else if (name === 'AskUserQuestion' || name === 'ExitPlanMode') {
      const q = Array.isArray(input.questions) ? input.questions[0] : null;
      const text = name === 'ExitPlanMode' ? planLine(input.plan) : q && typeof q.question === 'string' ? q.question : '';
      t.turn.questions.count++;
      t.question = { tool: name, text: redact(text).slice(0, LIMITS.questionChars) };
    } else if (name === 'Agent') {
      t.turn.agentsSpawned++;
    }
  }

  function onBash(t, call, result, block, isError) {
    const command = call.command;
    const test = isTestCommand(command), commit = isCommitCommand(command);
    const op = result && typeof result === 'object' && result.gitOperation && typeof result.gitOperation === 'object' ? result.gitOperation : null;
    if (test) {
      t.testRuns++;
      const outcome = parseTestOutcome(tail(resultText(result, block)), isError);
      keep(t.tests, { command: redact(command).slice(0, LIMITS.commandChars), outcome }, LIMITS.tests);
    }
    if (commit && !isError) {
      t.commitCount++;
      let subject = commitSubject(command);
      // A message read up to the cut of a long command may end in the start of a secret that redaction no
      // longer recognises: it is "not read", like one no parse finds.
      if (subject !== null && call.cut && commitSubject(command + PROBE) !== subject) subject = null;
      const sha = op && op.commit && typeof op.commit.sha === 'string' && SHA.test(op.commit.sha) ? op.commit.sha.slice(0, 12) : null;
      keep(t.commits, { subject: subject === null ? null : redact(subject).slice(0, SUBJECT_CHARS), sha }, LIMITS.commits);
    }
    if (isError && !test && !commit) keep(t.failures, { command: redact(command).slice(0, LIMITS.commandChars) }, LIMITS.failures);
    if (!op) return;
    if (op.push && typeof op.push === 'object') keep(t.git, { kind: 'push', branch: label(op.push.branch, BRANCH_CHARS) }, LIMITS.git);
    if (op.pr && typeof op.pr === 'object') onPr(t, prNumber(op.pr.number), label(op.pr.action, ACTION_CHARS));
  }

  // One entry per path per turn; an edit that errored changed nothing.
  function onFile(t, filePath, result, cwd) {
    const p = redact(relPath(filePath, cwd)).slice(0, PATH_CHARS);
    if (!p) return;
    let file = t.files.get(p);
    if (!file) {
      if (t.files.size >= MAX_SEEN) return;
      file = { path: p, created: false, added: 0, removed: 0, touched: 0 };
      t.files.set(p, file);
    }
    file.touched = ++t.touches;
    if (!result || typeof result !== 'object') return;
    if (result.type === 'create') file.created = true;
    countLines(result.structuredPatch, file);
  }

  // toolUseResult belongs to a record's only tool_result; with several, each block's own content is read.
  // A denied call never ran: it is counted as denied and nothing else.
  function onResults(t, r, blocks) {
    const result = blocks.length === 1 ? r.toolUseResult : undefined;
    for (const block of blocks) {
      const call = t.pending.get(block.tool_use_id);
      if (!call) continue;
      t.pending.delete(block.tool_use_id);
      if (r.toolDenialKind) continue;
      const isError = block.is_error === true;
      if (call.name === 'Bash') onBash(t, call, result, block, isError);
      else if (!isError) onFile(t, call.path, result, r.cwd);
    }
  }

  function onPrLink(r) {
    const number = prNumber(r.prNumber);
    if (open) onPr(open, number, null);
    else if (number !== null && !knownPrs.has(number) && facts.prNumbers.length < MAX_SEEN) {
      // between turns the offset moves past this record at once, so a restart never reads it again
      knownPrs.add(number);
      facts.prNumbers.push(number);
      facts.totals.prs = facts.prNumbers.length;
    }
  }

  function onUser(r, ts) {
    const origin = r.origin;
    const kind = origin ? origin.kind : undefined;
    const text = userText(r);
    const blocks = toolResults(r);
    if (text.startsWith('[Request interrupted')) {
      // Claude Code writes no stop summary and no end_turn when the owner interrupts: the marker ends
      // the turn (keeping the reply it had so far), and the next prompt closes it. The marker itself
      // is never a prompt, a notice or work.
      if (open) open.endTurnAt = { ts };
    } else if ((origin ? kind === 'human' : text !== '') && !r.isMeta && !r.isCompactSummary) {
      onPrompt(text, ts);
    } else if (origin && kind === 'task-notification') {
      if (!open) open = newTurn('task-notification', facts.lastHumanPrompt, ts);
    } else if ((origin && kind !== 'human') || blocks.length) {
      work(ts);
    }
    if (r.toolDenialKind) work(ts).turn.denied++;
    if (open && blocks.length) onResults(open, r, blocks);
  }

  function onAssistant(r, ts) {
    const t = work(ts);
    const msg = r.message || {};
    const text = textOf(msg.content).trim();
    if (text) t.replyText = text;
    t.endTurnAt = msg.stop_reason === 'end_turn' ? { ts } : null;
    // '<synthetic>' marks messages Claude Code writes itself (errors, interruptions), not a model.
    if (typeof msg.model === 'string' && msg.model && msg.model !== '<synthetic>') facts.model = redact(msg.model).slice(0, MODEL_CHARS);
    if (Array.isArray(msg.content)) for (const c of msg.content) if (c && c.type === 'tool_use') onToolUse(t, c);
  }

  function onTitle(r) {
    const custom = r.type === 'custom-title';
    const raw = custom ? r.customTitle : r.aiTitle;
    const text = typeof raw === 'string' ? redact(raw).slice(0, TITLE_CHARS) : '';
    if (custom) customTitle = text; else aiTitle = text;
    refreshTitle();
  }

  function skip() {
    (open || facts).skipped++;
  }

  function handle(r, endOffset) {
    if (!r || typeof r !== 'object') return skip();
    if (r.isSidechain) return;
    const type = r.type;
    if (typeof type !== 'string' || !type) return skip();
    if (type === 'pr-link') return onPrLink(r);
    if (BOOKKEEPING.has(type) || type.startsWith('artifact-')) return;
    if (type === 'custom-title' || type === 'ai-title') return onTitle(r);
    if (type === 'system') {
      if (r.subtype !== 'stop_hook_summary') return;
      const ts = stamp(r);
      if (open) close(open, ts, endOffset);
      return;
    }
    if (type === 'user') return onUser(r, stamp(r));
    if (type === 'assistant') return onAssistant(r, stamp(r));
    skip();
  }

  return {
    push(record, endOffset) {
      try {
        handle(record, endOffset);
      } catch {
        skip();
      }
      if (!open) facts.offset = endOffset;
      lastEnd = endOffset;
    },
    // At session end: a turn that reached end_turn or was interrupted closes, after the last record
    // pushed; one still working stays open.
    closeOpenTurn() {
      if (open && open.endTurnAt) close(open, open.endTurnAt.ts, lastEnd);
    },
    snapshot() {
      return JSON.parse(JSON.stringify(facts));
    },
  };
}
