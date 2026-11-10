// Facts-only cards and the Digest snapshot (spec, "Protocol additions"): a headline slot with the
// newest reply's first sentence, up to four fact lines, counts, and the fleet totals. Pure: no I/O.
//
// A SessionRecord comes from the saved state, which is checked only at the record level, so every
// field is read defensively: a missing or wrong-typed field is skipped, an element that is not an
// object is skipped, and nothing here throws on such a record. Text is redacted once more on its way
// out (the extractor already did, but a file can be edited), then cut. Nothing here changes its
// input and nothing in a card aliases it. Work is bounded by the limits, not by what a file holds:
// only the last six turns and six agents are looked at, and each turn's lists are cut to their limits.
import { LIMITS } from './extract.js';
import { redact } from './redact.js';
import { firstSentence } from './parse.js';

const WINDOW_HOURS = 24;
const MAX_CARDS = 20;
const TITLE_CHARS = 120;
const PROJECT_CHARS = 120;
const LINE_CHARS = 240;
const REPLY_CHARS = 80;
const PR_NUMBERS_SHOWN = 3;
const BULLETS = 4;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : '');
const count = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const arr = (v) => (Array.isArray(v) ? v : []);
const plural = (n, one, many) => (n === 1 ? one : many);
// A session total a line may show: an integer at least as large as the stored items the line names,
// else (missing, wrong type, negative, fractional, or smaller than what is stored) the stored count.
const countOf = (total, storedCount) => (Number.isInteger(total) && total >= storedCount ? total : storedCount);

function cap(text, max) {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

// Redact, then make it one line, then cut.
const oneLine = (text, max) => cap(redact(text).replace(/\s+/g, ' ').trim(), max);

// The closed turns a card reads: the last six that are objects, oldest first.
const storedTurns = (facts) => arr(facts.turns).slice(-LIMITS.turns).filter(isObject);

// AgentFacts as a card reads them. A card that has ended has no running agents: they finished with the session.
function agentView(agents, ended) {
  const a = isObject(agents) ? agents : {};
  let finished = count(a.finished);
  let running = count(a.running);
  const rows = arr(a.list).slice(-LIMITS.agents).filter(isObject)
    .map((x) => ({ description: str(x.description), finished: ended || x.finished === true }));
  if (ended) { finished += running; running = 0; }
  return { finished, running, rows };
}

// The count is the session's (totals.files); the path is the largest of the stored turns' files, which
// keep at most 8 each. A path counts as created when any stored turn created it, and the verb is Created
// only when every file counted is one of those paths and all were created.
function filesLine(turns, total) {
  const byPath = new Map();
  for (const t of turns) {
    for (const f of arr(t.files).slice(0, LIMITS.files)) {
      if (!isObject(f) || !str(f.path)) continue;
      const e = byPath.get(f.path) || { path: f.path, size: 0, created: false };
      e.size += count(f.added) + count(f.removed);
      e.created = e.created || f.created === true;
      byPath.set(f.path, e);
    }
  }
  if (byPath.size === 0) return null;
  let largest = null;
  let allCreated = true;
  for (const e of byPath.values()) {
    if (largest === null || e.size > largest.size) largest = e;
    if (!e.created) allCreated = false;
  }
  const n = countOf(total, byPath.size);
  return `${allCreated && n === byPath.size ? 'Created' : 'Edited'} ${n} ${plural(n, 'file', 'files')}: ${largest.path}${n > 1 ? `, +${n - 1}` : ''}`;
}

// The newest test run of the stored turns: the last test of the newest turn that has one.
function newestTest(turns) {
  for (let i = turns.length - 1; i >= 0; i--) {
    const tests = arr(turns[i].tests).slice(-LIMITS.tests);
    for (let j = tests.length - 1; j >= 0; j--) if (isObject(tests[j])) return tests[j];
  }
  return null;
}

function testsLine(turns) {
  const t = newestTest(turns);
  if (!t) return null;
  const o = isObject(t.outcome) ? t.outcome : {};
  if (o.status === 'counted') return `Tests: ${count(o.passed)} passed, ${count(o.failed)} failed`;
  if (o.status === 'failed') return 'Tests: failed';
  return 'Tests: ran, outcome not reported';
}

// The passed and failed counts of the newest run whose outcome was counted, else nulls.
function newestCounts(turns) {
  for (let i = turns.length - 1; i >= 0; i--) {
    const tests = arr(turns[i].tests).slice(-LIMITS.tests);
    for (let j = tests.length - 1; j >= 0; j--) {
      const o = isObject(tests[j]) && isObject(tests[j].outcome) ? tests[j].outcome : null;
      if (o && o.status === 'counted') return { passed: count(o.passed), failed: count(o.failed) };
    }
  }
  return { passed: null, failed: null };
}

// The count is the session's (totals.commits); the subject is the newest one read among the commits the
// stored turns kept (each keeps its last five).
function commitsLine(turns, total) {
  let n = 0;
  let subject = null;
  for (let i = turns.length - 1; i >= 0; i--) {
    const commits = arr(turns[i].commits).slice(-LIMITS.commits).filter(isObject);
    n += commits.length;
    for (let j = commits.length - 1; j >= 0 && subject === null; j--) if (str(commits[j].subject)) subject = commits[j].subject;
  }
  if (n === 0) return null;
  n = countOf(total, n);
  return `${n} ${plural(n, 'commit', 'commits')}: ${subject === null ? 'message not read' : subject}${n > 1 ? `, +${n - 1}` : ''}`;
}

// The newest three pull requests of the stored turns are named, oldest first; the session's total
// (totals.prs) is what the +K makes up, so the line never counts fewer than it names.
function prsLine(turns, total) {
  const numbers = [];
  for (const t of turns) {
    for (const g of arr(t.git).slice(-LIMITS.git)) {
      if (isObject(g) && g.kind === 'pr' && Number.isFinite(g.number) && !numbers.includes(g.number)) numbers.push(g.number);
    }
  }
  if (numbers.length === 0) return null;
  const named = numbers.slice(-PR_NUMBERS_SHOWN);
  const all = countOf(total, numbers.length);
  const more = all - named.length;
  return `${all === 1 ? 'PR' : 'PRs'} ${named.map((n) => '#' + n).join(', ')}${more > 0 ? `, +${more}` : ''}`;
}

function agentsLine(view) {
  if (view.finished === 0) return null;
  let description = '';
  for (let i = view.rows.length - 1; i >= 0 && !description; i--) if (view.rows[i].finished) description = view.rows[i].description;
  return `${view.finished} ${plural(view.finished, 'agent', 'agents')} finished${description ? ': ' + description : ''}`;
}

// The facts-only bullets, in this order, those with something to say, the first four. Already redacted.
export function cardLines(facts, agents) {
  const f = isObject(facts) ? facts : {};
  const turns = storedTurns(f);
  const totals = isObject(f.totals) ? f.totals : {};
  return [filesLine(turns, totals.files), testsLine(turns), commitsLine(turns, totals.commits), prsLine(turns, totals.prs), agentsLine(agentView(agents, false))]
    .filter((l) => l !== null)
    .slice(0, BULLETS)
    .map((l) => oneLine(l, LINE_CHARS));
}

// The first sentence of the newest reply, from the newest turn that has one.
function lastReply(turns) {
  for (let i = turns.length - 1; i >= 0; i--) {
    const reply = isObject(turns[i].reply) ? str(turns[i].reply.text) : '';
    if (reply.trim()) return redact(firstSentence(redact(reply), REPLY_CHARS)); // firstSentence strips markdown, which can join what redact split
  }
  return '';
}

// One DigestCard: facts only, no summary. `live` says the session is in the live snapshot; one that is not shows as ended.
export function buildCard(sessionId, rec, { live } = {}) {
  const r = isObject(rec) ? rec : {};
  const f = isObject(r.facts) ? r.facts : {};
  const totals = isObject(f.totals) ? f.totals : {};
  const ended = r.ended === true || !live;
  const turns = storedTurns(f);
  const agents = agentView(r.agents, ended);
  const runs = count(totals.testRuns);
  return {
    sessionId: typeof sessionId === 'string' ? sessionId : String(sessionId ?? ''),
    title: oneLine(str(f.title), TITLE_CHARS) || 'session',
    project: oneLine(str(f.project), PROJECT_CHARS),
    ended,
    lastTurnTs: Number.isFinite(f.lastTurnTs) ? f.lastTurnTs : 0,
    facts: {
      turns: count(totals.turns), files: count(totals.files), commits: count(totals.commits), prs: count(totals.prs),
      tests: runs === 0 ? null : { ...newestCounts(turns), runs },
      agents: { finished: agents.finished, running: agents.running },
    },
    lines: cardLines(f, { finished: agents.finished, running: agents.running, list: agents.rows }),
    lastReply: lastReply(turns),
    summary: null,
    behindTurns: 0,
  };
}

export function emptyDigest(now, windowHours = WINDOW_HOURS) {
  return {
    updatedTs: now, windowHours,
    summarizer: { state: 'off', model: null, lastOkTs: null },
    totals: { sessions: 0, turns: 0, commits: 0, prs: 0, testRuns: 0 },
    cards: [],
  };
}

// The Digest: the sessions with an owner prompt whose last turn is inside the window, newest first,
// at most maxCards cards, and totals over every session in the window (not only the cards shown).
// `sessions` is the saved state's map of session id to SessionRecord; isLive(sessionId) says whether
// the live snapshot has it, and is asked only for the cards. One pass over the sessions and over
// their turn logs, plus a sort of the kept sessions; cards are built only for the ones shown.
export function buildDigest(sessions, { now: nowOpt, windowHours = WINDOW_HOURS, maxCards = MAX_CARDS, isLive = () => true } = {}) {
  const now = Number.isFinite(nowOpt) ? nowOpt : Date.now();
  const hours = Number.isFinite(windowHours) && windowHours > 0 ? windowHours : WINDOW_HOURS;
  const shown = typeof maxCards === 'number' && maxCards >= 0 ? maxCards : MAX_CARDS;
  const cutoff = now - hours * 3600e3;
  const digest = emptyDigest(now, hours);
  const kept = [];
  for (const [id, rec] of Object.entries(isObject(sessions) ? sessions : {})) {
    if (!isObject(rec) || !isObject(rec.facts) || rec.facts.hasHumanPrompt !== true) continue;
    const ts = rec.facts.lastTurnTs;
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    kept.push({ id, rec, ts });
    digest.totals.sessions++;
    for (const e of arr(rec.facts.turnLog)) {
      if (!isObject(e) || !Number.isFinite(e.endTs) || e.endTs < cutoff) continue;
      digest.totals.turns++;
      digest.totals.commits += count(e.commits);
      digest.totals.prs += count(e.prs);
      digest.totals.testRuns += count(e.testRuns);
    }
  }
  kept.sort((a, b) => b.ts - a.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  digest.cards = kept.slice(0, shown).map(({ id, rec }) => buildCard(id, rec, { live: Boolean(isLive(id)) }));
  return digest;
}
