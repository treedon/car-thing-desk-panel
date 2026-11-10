# Agent Digest, Plan 1 of 3: Facts-Only Digest — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Milestone 1 of the agent digest. The Mac service extracts redacted facts from Claude Code transcripts after each turn. The panel shows them as a digest card first on the sessions screen, which opens the facts-only cards on a new `#/digest` list, as a strip and a card in the session view, and as one line on the ambient clock. No model is involved.

**Architecture:**
- `mac-service/src/digest/` is a pipeline: a chunked offset reader feeds records to a per-session extractor (turns, then facts, every text redacted), and a pure card builder makes the spec's `Digest` / `DigestCard`.
- A service object owns the Stop/SessionEnd triggers (heard after the hook response is sent), the start-up catch-up scan, `.state/digest.json` (0600), and the debounced `claude.digest.update`.
- On the panel, `screens/digest.js` renders the `#/digest` list, the sessions screen's first card, the session strip and card, and the ambient line. `session-list.js` puts the first card in column 0 of the grid; `main.js` wires routes and input; `ws-mux.js` keeps the digest the Mac's alone (the panel also links to the NucBox's session service).

**Tech Stack:** Node 22 ESM with `node --test` (dependencies stay `ws` only); the Chrome 69 ES5-style panel built with Vite and `@vitejs/plugin-legacy`; the simulator, checked over CDP on a Chrome of its own (port 19223).

**Spec:** `docs/superpowers/specs/2026-11-06-agent-digest-design.md` (the version on this branch). This plan covers its Milestone 1: "The fact extractor"; "Triggers, caching, persistence and rate" (triggers and persistence); the model-free rows of "Failure and offline behavior"; "Protocol additions"; "Network and secrets → Redaction"; "On the panel"; and, from "How we will know it works", Hooks are unaffected, Unit tests, Extractor fixtures and Panel.

## Global Constraints

Every task also includes **Shared types** below.

- **Mac service:** ESM, `node:test` with `node:assert/strict` in the style of `mac-service/test/*.test.js`; no new dependencies.
- **Hook path:** no I/O. The digest hears `Stop` / `SessionEnd` only after the hook response finishes (`res.once('finish')`), and then sets only a flag and a timer.
- **Reading:** chunks of at most 256 KB with `setImmediate` between them. If the latency check fails, parsing moves to a `node:worker_threads` worker.
- **Redaction:** every text fact goes through `redact()` before it is stored, persisted or sent: prompts, replies, titles, paths, commit subjects, commands, question text, subagent descriptions and reports. Redact first, then cap.
- **Never in a fact:** file contents (`Write.content`, `Edit` strings), tool output beyond parsed counts, thinking, attachments, `api-request*` records, anything from another session.
- **State:** `mac-service/.state/digest.json`, atomic, mode `0600`, at most once every 10 s, pruned to the window. Logs (`log('DG', …)`) carry sizes, timings and states, never content.
- **Panel code:** ES5 (`var`, string-built `render*(state) -> html`, `esc()` on every interpolation); no flex `gap`, `inset` or `clamp()`; no `?.`, `??` or `crypto.randomUUID`; existing tokens only.
- **Type:** "Nothing is below 14px, and nothing you must read at a glance is below 19px."
- **No alert noise:** every digest lamp is static; a digest update never toasts, wakes the display or navigates; digest CSS never names `--warn` or `--danger` (lamps keep their `.lamp.<state>` colours).
- **Defaults the owner may change:** a 24 h window, at most 20 cards, subagents rolled into their parent, the digest as the first card on the sessions screen with the newest three sessions (the owner's choice on 2026-11-06; the Agents preset 2's cycle is unchanged), summaries (later plans) after each turn with the debounce.
- **Tests:** never read `~/.claude`; transcripts are synthetic; planted secrets are built by string concatenation at runtime, so no scanner flags the repo.
- **Commands:** `npm --prefix mac-service test`, `npm --prefix panel test`, `npm --prefix panel run build`, root `npm test`. One file: `node --test <path>` from the repo root.

## Review Focus

1. **A session ends while its transcript is being read.** The SessionEnd is neither lost nor a second overlapping read; the card ends `ended`, each turn counted once. *Task 8: `a session that ends while it is being read is read once more and ends`.*
2. **A 50 MB transcript on first read.** Hook responses don't slow down. *Task 10: `catching up a 30 MB transcript never holds the event loop`, and the `hook-latency` script.*
3. **A torn last line (Claude mid-write at Stop), or a transcript that shrinks.** The torn line is read once, on the next pass; a shrunk file is re-read from 0 with fresh facts. *Task 5: `a torn last line is left for the next read`; Task 8: `a transcript that shrinks is read again from the start`.*
4. **Missing or skewed timestamps.** A missing one carries the previous record's, a future one clamps to now, a turn never ends before it starts. *Task 3: `missing timestamps carry, future ones clamp, and a turn never ends before it starts`.*
5. **A restart in the middle of a turn.** The saved offset stops at the last closed turn; re-reading from it gives the same ids and totals as one pass. *Task 3: `a restart mid-turn reproduces ids and totals`; Task 8: `the state file is 0600 and a restart reads only new bytes`.*

## Shared types

Defined in Tasks 2–7; later tasks use these names.

```ts
TestOutcome = { status: 'counted', passed, failed } | { status: 'failed' } | { status: 'not-reported' }
Turn = { trigger: 'human' | 'task-notification' | 'none',
  intent: { id /* P3 */, text } | null,           // own prompt, or the borrowed last human prompt
  startTs, endTs, reply: { id /* R3 */, text } | null,
  files: [{ id /* F7 */, path, created, added, removed }],   // top 8 by added+removed
  commits: [{ id /* C2 */, subject: string | null, sha: string | null /* ≤12 chars */ }],      // last 5
  git: [{ id /* G1 */, kind: 'push' | 'pr', branch?, number?, action? }],                      // last 3
  tests: [{ id /* T1 */, command, outcome: TestOutcome }], failures: [{ id /* X1 */, command /* ≤160 */ }],  // last 3 each
  questions: { count, last: { id /* Q1 */, tool, text /* ≤160 */ } | null }, agentsSpawned, denied }
SessionFacts = {                    // createExtractor().snapshot(): closed turns only, JSON-safe
  sessionId, offset,                // byte offset just past the record that closed the last turn
  title, project, model, startedTs, turns: Turn[] /* oldest first, ≤6 */,
  totals: { turns, files, commits, prs, testRuns },   // whole session; a sheet numbers them S1–S5 in this order
  turnLog: [{ endTs, commits, prs, testRuns }],       // one per closed turn; the service prunes it to the window
  seenFiles: string[], prNumbers: number[], lastHumanPrompt: { id, text, ts } | null, hasHumanPrompt,
  lastTurnTs /* 0 until a turn closes */, next: { P, R, F, C, G, T, X, Q } /* next id number per kind */, skipped }
AgentFacts = { finished, running, list: [{ id /* A1 */, description, agentType, finished, report: string | null }] }  // last 6
SessionRecord = { path, mtimeMs, ended, facts: SessionFacts, agents: AgentFacts }
DigestState = { version: 1, sessions: { [sessionId]: SessionRecord } }
```

`Digest` and `DigestCard` are exactly the spec's "Protocol additions" shapes. In this plan `summarizer` is always `{ state: 'off', model: null, lastOkTs: null }`, `summary` is `null` and `behindTurns` is `0`.

---

### Task 1: Redaction

**Files:** Create `mac-service/src/digest/redact.js`; Test `mac-service/test/digest-redact.test.js`.

**Interfaces:**
- Consumes: nothing.
- Produces: `REDACTED = '[redacted]'`; `redact(text: unknown) -> string` (a non-string gives `''`).

- [ ] **Step 1: Write the failing test**

```js
export const SECRETS = [   // [category, text, needle that must not survive (default: text)]; reused by Task 8
  ['anthropic', 'sk-' + 'ant-' + 'A1b2'.repeat(6)], ['github', 'gh' + 'p_' + 'Z9y8'.repeat(9)],
  ['github pat', 'github_' + 'pat_' + '11AB'.repeat(6) + '_cd34'], ['slack', 'xo' + 'xb-' + '1234567890-abcdefABCDEF'],
  ['aws', 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP'], ['jwt', 'ey' + 'JhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwYW5lbCJ9.c2lnbmF0dXJlX2Zha2U'],
  ['pem', '-----BEGIN ' + 'RSA PRIVATE KEY-----\nMIIEow' + 'x'.repeat(60) + '\n-----END RSA PRIVATE KEY-----', 'MIIEow'],
  ['bearer', 'Authorization: Bearer ' + 'q'.repeat(12) + '.Rt5', 'q'.repeat(12)],
  ['assignment', 'API_TOKEN=' + 'hunter2hunter2', 'hunter2hunter2'], ['password', 'password: "' + 'correct-horse' + '"', 'correct-horse'],
  ['hex', '0123456789abcdef'.repeat(2) + 'ff'], ['base64', 'QWxhZGRpbjpvcGVuIHNlc2FtZQ' + 'Zm9vYmFyYmF6cXV4MTIz'],
];
test('one planted secret of each category never survives', () => {
  for (const [kind, text, needle = text] of SECRETS) {
    const out = redact(`before ${text} after`);
    assert.ok(!out.includes(needle) && out.includes(REDACTED) && out.startsWith('before '), kind);
  }
  assert.equal(redact('API_TOKEN=' + 'hunter2hunter2'), 'API_TOKEN=[redacted]');
});
test('short git shas, paths and ordinary prose pass untouched', () => {
  for (const s of ['fix(panel): 1a2b3c4d5e6f lands', 'mac-service/src/sessions/source-transcript.js',
    'Spotify_car_thing-digest/docs/superpowers/plans', 'the task-notification path', 'ask for tokens in the README'])
    assert.equal(redact(s), s);
});
test('non-strings read as empty', () => { assert.equal(redact(undefined), ''); assert.equal(redact(42), ''); });
```

Put `SECRETS` in `mac-service/test/fixtures/digest/secrets.js` and import it here.

- [ ] **Step 2: Run to verify it fails.** `node --test mac-service/test/digest-redact.test.js` → FAIL, `ERR_MODULE_NOT_FOUND`.
- [ ] **Step 3: Implement `redact`.** Apply in this order (the spec's categories; thresholds are the builder's):

```js
[/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED],
[/\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abeprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})/g, REDACTED],
[/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
[/\b(Bearer)\s+[A-Za-z0-9._~+\/=-]{8,}/gi, '$1 ' + REDACTED],
[/\b(\w*(?:key|token|secret|passw(?:or)?d)\w*)(\s*[=:]\s*)(["']?)[^\s"'`,;&]{4,}\3/gi, '$1$2' + REDACTED],
[/\b[0-9a-fA-F]{32,}\b/g, REDACTED],   // long hex; shas are stored at ≤12 chars (Task 4)
// 40+ base64/base64url chars are a secret when some '/'-separated piece of 24+ chars mixes a digit,
// a lower- and an upper-case letter; path pieces are short and plain
[/[A-Za-z0-9+\/_=-]{40,}/g, (m) => m.split('/').some((p) => p.length >= 24 && /\d/.test(p) && /[a-z]/.test(p) && /[A-Z]/.test(p)) ? REDACTED : m],
```

- [ ] **Step 4: Run to verify it passes.** Same command → PASS, 3 tests.
- [ ] **Step 5: Commit.** `git add mac-service/src/digest/redact.js mac-service/test/digest-redact.test.js mac-service/test/fixtures/digest/secrets.js && git commit -m "feat(digest): redact secrets from every text fact"`

### Task 2: Command and output parsers

**Files:** Create `mac-service/src/digest/parse.js`; Test `mac-service/test/digest-parse.test.js`.

**Interfaces:**
- Consumes: nothing.
- Produces (pure):
  - `TEST_RUNNERS: RegExp[]`, `isTestCommand(cmd) -> boolean`, `parseTestOutcome(output, isError) -> TestOutcome`
  - `isCommitCommand(cmd) -> boolean`, `commitSubject(cmd) -> string | null`
  - `resultText(toolUseResult, block) -> string`: `stdout + '\n' + stderr` for an object; the string itself for a string (Claude Code stores Bash errors that way); else the `tool_result` block's `content` string or its text blocks joined.
  - `firstSentence(text, max = 80) -> string`
  - `relPath(filePath, cwd) -> string`: relative inside `cwd`, `~/…` under `$HOME`, else unchanged.

- [ ] **Step 1: Write the failing test**

```js
test('test runners are recognised, other commands are not', () => {
  for (const c of ['npm test', 'npm run test', 'npm --prefix mac-service test', 'node --test "test/*.test.js"', 'pytest -q',
    'npx jest', 'npx vitest run', 'go test ./...', 'cargo test', 'cd panel && npm test 2>&1 | tail -5']) assert.ok(isTestCommand(c), c);
  for (const c of ['npm install test-utils', 'git commit -m "test: add"', 'ls test/', 'cat jest.config.js']) assert.ok(!isTestCommand(c), c);
});
test('a parsed count is the outcome, summed across suites', () => {
  const c = (passed, failed) => ({ status: 'counted', passed, failed });
  for (const [out, isError, want] of [['ℹ tests 41\nℹ pass 41\nℹ fail 0\n', false, c(41, 0)], ['# pass 12\n# fail 2\n', true, c(12, 2)],
    ['==== 3 failed, 10 passed in 0.52s ====', true, c(10, 3)], ['ℹ pass 200\nℹ fail 0\nℹ pass 12\nℹ fail 1\n', true, c(212, 1)],
    ['Test Suites: 1 failed, 4 passed, 5 total\nTests:       2 failed, 40 passed, 42 total', true, c(40, 2)],
    [' Test Files  2 passed (2)\n      Tests  10 passed (10)', false, c(10, 0)]]) assert.deepEqual(parseTestOutcome(out, isError), want, out);
});
test('without a count, is_error means failed and anything else is not reported', () => {
  assert.deepEqual(parseTestOutcome('ok  \tpkg/x\t0.01s', false), { status: 'not-reported' });
  assert.deepEqual(parseTestOutcome('Error: Exit code 1', true), { status: 'failed' });
});
test('git commit counts anywhere in a command; commit-tree and log do not', () => {
  for (const c of ['git commit -m "x"', 'git add -A && git commit -m "x"', 'git -C mac-service commit -am "x"', 'git commit --amend --no-edit'])
    assert.ok(isCommitCommand(c), c);
  for (const c of ['git commit-tree abc', 'git log --grep commit']) assert.ok(!isCommitCommand(c), c);
});
test('the subject comes from -m or a heredoc first line, else null', () => {
  assert.deepEqual(['git commit -m "feat(panel): digest screen"', "git -C x commit -am 'fix: x' -m 'body'",
    `git commit -m "$(cat <<'EOF'\nfeat(digest): facts only\n\nBody\nEOF\n)"`, 'git commit -F /tmp/msg.txt', 'git commit --amend --no-edit'].map(commitSubject),
    ['feat(panel): digest screen', 'fix: x', 'feat(digest): facts only', null, null]);
});
test('resultText reads an object, a string or the block; paths are relative to the cwd', () => {
  assert.deepEqual([resultText({ stdout: 'a', stderr: 'b' }, {}), resultText('Error: Exit code 1', {}),
    resultText(undefined, { content: [{ type: 'text', text: 'c' }] })], ['a\nb', 'Error: Exit code 1', 'c']);
  assert.deepEqual([relPath('/Users/dev/p/src/a.js', '/Users/dev/p'), relPath('/etc/hosts', '/Users/dev/p')], ['src/a.js', '/etc/hosts']);
});
test('first sentence, without markdown, cut to 80 at a word', () => {
  assert.deepEqual(['The recorder now reopens the audio device after resume. Next…', 'Version 1.2 is out. Then more.', '## Done\n\n- Fixed it', '']
    .map((t) => firstSentence(t)), ['The recorder now reopens the audio device after resume.', 'Version 1.2 is out.', 'Done', '']);
  const cut = firstSentence('word '.repeat(40)); assert.ok(cut.length <= 80 && cut.endsWith('…'));
});
```

- [ ] **Step 2: Run to verify it fails.** `node --test mac-service/test/digest-parse.test.js` → FAIL, `ERR_MODULE_NOT_FOUND`.
- [ ] **Step 3: Implement `parse.js`** with these pinned rules:

```js
export const TEST_RUNNERS = [
  /\bnpm\s+(?:--prefix\s+\S+\s+)?(?:run\s+)?test\b(?![-\w.])/, /\bnode\s+(?:[^|;&]*\s)?--test\b/,
  /(?:^|[\s;&|(])(?:python3?\s+-m\s+)?pytest\b(?![-\w.])/, /(?:^|[\s;&|(])(?:npx\s+|yarn\s+|pnpm\s+)?(?:jest|vitest)(?:\s|$)/,
  /\bgo\s+test\b/, /\bcargo\s+test\b/,
];
// Counts: sum every match of both; skip lines matching /^\s*Test (?:Suites|Files)\b/ (jest/vitest file tallies).
const NODE_TAP = /^\s*(?:ℹ|#)\s*(pass|fail)\s+(\d+)\s*$/gm;
const WORDS = /(\d+)\s+(passed|failed)\b/g;
// No match: isError ? {status:'failed'} : {status:'not-reported'}. Only "passed" seen: failed is 0.
const COMMIT = /\bgit(?:\s+(?:-C\s+\S+|-c\s+\S+|--[\w-]+(?:=\S+)?))*\s+commit(?![-\w])/;
// Subject: a heredoc /<<-?\s*['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\s*\1\b/ gives group 2's first non-empty line; else
// /(?:\s-[a-zA-Z]*m|\s--message)(?:=|\s+)(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))/ gives its value's first line, trimmed.
// A value starting "$(" with no heredoc gives null.
```

`firstSentence`: take the first non-empty line; strip a leading `#`, `-`, `*`, `>` or `1.` marker, backticks and `**`; collapse whitespace; cut after the first `[.!?]` followed by a space or the end; if still over `max`, cut at the last space before `max` and append `…`.

- [ ] **Step 4: Run to verify it passes.** Same command → PASS, 7 tests.
- [ ] **Step 5: Commit.** `git add mac-service/src/digest/parse.js mac-service/test/digest-parse.test.js && git commit -m "feat(digest): parse test outcomes, commit subjects and first sentences"`

### Task 3: Extractor I — turns, prompts, replies

**Files:**
- Create: `mac-service/src/digest/extract.js`; `mac-service/test/fixtures/digest/build.js`; the fixtures `turns.jsonl`, `messy.jsonl`, `fallback.jsonl`, `notify-only.jsonl` in the same folder, written by running `build.js`.
- Test: `mac-service/test/digest-extract.test.js`

**Interfaces:**
- Consumes: `redact` (Task 1).
- Produces:
  - `LIMITS = { turns: 6, promptChars: 500, replyChars: 1200, files: 8, commits: 5, git: 3, tests: 3, failures: 3, commandChars: 160, questionChars: 160, agents: 6, reportChars: 300 }`
  - `createExtractor({ sessionId, saved?: SessionFacts, now?: () => number, fallbackTs?: number }) -> { push(record: object | null, endOffset: number): void, closeOpenTurn(): void, snapshot(): SessionFacts }`
  - In `build.js`, for tests (minutes after `2026-11-02T10:00:00.000Z`, `CWD = '/Users/dev/proj'`): `T(min)`, `human(text, min)`, `notice(text, min)`, `asst(text, min, stop = 'end_turn')`, `use(id, name, input, min)`, `result(id, toolUseResult, min, { isError, content })`, `stopSummary(min)`, `jsonl(records) -> string`.

Record shapes (spec, "The data"). `user` and `assistant` records also carry `timestamp` and `cwd`:

```jsonc
{"type":"custom-title","customTitle":"…"}   {"type":"ai-title","aiTitle":"…"}   {"type":"system","subtype":"stop_hook_summary"}
{"type":"user","origin":{"kind":"human"},"message":{"role":"user","content":"…"}}          // also kind "task-notification"
{"type":"user","isCompactSummary":true,"message":{"role":"user","content":"…"}}
{"type":"assistant","message":{"model":"claude-test-1","stop_reason":"end_turn","content":[{"type":"text","text":"…"}]}}
{"type":"assistant","message":{"stop_reason":"tool_use","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"…"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","is_error":false,"content":"…"}]},"toolUseResult":{…} or "Error: …"}
```

Fixtures (record order; `@n` is minutes):
- `turns.jsonl` (13 records): custom-title "Digest fixture", ai-title "ignored", human "Make the dial dimmer" @0, asst "Done. The dial now dims in 5% steps. Next: tests." @2, stop @2, asst "I also tidied the helper." @3, stop @3, notice @10, asst "The background build passed." @11, stop @11, compact-summary user @12, human "Now add the tests" @20, `use('t1','Bash',{command:'npm test'})` @21 (left open).
- `messy.jsonl`: human @0, `{"type":"brand-new-record"}`, the torn line `{"type":"assistant","message":{"content":[{"ty`, an `isSidechain:true` assistant, an `isMeta:true` user "META-SENTINEL", a no-origin user "[Request interrupted by user]", asst "Fine." @1, stop @1.
- `fallback.jsonl` (no stop summaries): human "First" @0, asst "One." @1, human "Second" @5, asst "Two." @6.
- `notify-only.jsonl`: notice @0, asst "Built." @1, stop @1.

- [ ] **Step 1: Write the failing test.** Helpers: `feedText(text, opts)` pushes each line with its cumulative byte `endOffset` (a line that won't parse is pushed as `null`) and returns the extractor; `feed(records, opts)` is `feedText(jsonl(records), opts)`; `run(file, opts)` feeds a fixture file; `resume(text, saved)` creates an extractor from `saved` and pushes only the lines ending after `saved.offset`.

```js
const turns = () => run('turns.jsonl').snapshot();
test('a turn is whatever ends at a stop_hook_summary, and records its trigger', () => {
  const f = turns(); assert.deepEqual(f.turns.map((t) => t.trigger), ['human', 'none', 'task-notification']);
  assert.deepEqual([f.totals.turns, f.title, f.project], [3, 'Digest fixture', 'proj']);
});
test('a task notification is not an owner prompt', () => {
  const f = turns(); assert.deepEqual([f.turns[2].intent.text, f.lastHumanPrompt.text], ['Make the dial dimmer', 'Make the dial dimmer']);
});
test('a turn with no human prompt is a continuation and borrows the last human prompt as its intent', () => {
  const [a, b] = turns().turns; assert.deepEqual([b.trigger, b.intent, a.intent.id], ['none', a.intent, 'P1']);
});
test('the final reply is the text of the turn\'s last assistant record with text', () => {
  assert.deepEqual(turns().turns[0].reply, { id: 'R1', text: 'Done. The dial now dims in 5% steps. Next: tests.' });
});
test('compaction summaries, meta lines and interrupt markers are never prompts; unknown and torn records are counted', () => {
  const f = run('messy.jsonl').snapshot(); assert.deepEqual([f.turns.length, f.skipped], [1, 2]); assert.ok(!JSON.stringify(f).includes('META-SENTINEL'));
});
test('the open turn is not in the snapshot, and the offset stops before it', () => {
  const lines = fs.readFileSync(fx('turns.jsonl'), 'utf8').split('\n');
  assert.equal(turns().offset, Buffer.byteLength(lines.slice(0, 11).join('\n') + '\n'));   // through the compact summary
});
test('prompts cap at 500 chars and replies at 1,200, redacted before the cap', () => {
  const [t] = feed([human('x'.repeat(495) + ' ' + SECRETS[0][1], 0), asst('y'.repeat(1500), 1), stopSummary(1)]).snapshot().turns;
  assert.ok(t.intent.text.length <= 500 && !t.intent.text.includes('sk-' + 'ant')); assert.equal(t.reply.text.length, 1200);
});
test('only the last six turns are kept; totals count every turn', () => {
  const recs = []; for (let i = 0; i < 8; i++) recs.push(human('p' + i, i * 2), asst('r' + i, i * 2 + 1), stopSummary(i * 2 + 1));
  const f = feed(recs).snapshot(); assert.deepEqual([f.turns.length, f.totals.turns, f.turns[0].intent.id], [6, 8, 'P3']);
});
test('without stop summaries a turn ends at the next owner prompt after end_turn, and closeOpenTurn closes the last', () => {
  const ex = run('fallback.jsonl'); assert.equal(ex.snapshot().turns.length, 1); ex.closeOpenTurn(); const f = ex.snapshot();
  assert.deepEqual([f.turns.length, f.lastTurnTs, f.offset], [2, Date.parse(T(6)), fs.statSync(fx('fallback.jsonl')).size]);
});
test('a session of task notifications only has turns but no human prompt', () => {
  const f = run('notify-only.jsonl').snapshot(); assert.deepEqual([f.hasHumanPrompt, f.turns[0].intent], [false, null]);
});
test('missing timestamps carry, future ones clamp, and a turn never ends before it starts', () => {   // Review Focus 4
  const now = Date.parse(T(30)); const noTs = asst('a', 0, 'tool_use'); delete noTs.timestamp;
  const f = feed([human('p', 10), noTs, asst('b', 99999), stopSummary(5)], { now: () => now }).snapshot();
  assert.equal(f.turns[0].startTs, Date.parse(T(10)));
  assert.ok(f.turns[0].endTs >= f.turns[0].startTs && f.lastTurnTs <= now);
});
test('a restart mid-turn reproduces ids and totals', () => {   // Review Focus 5
  const text = jsonl([human('p1', 0), asst('r1', 1), stopSummary(1), human('p2', 2), asst('w', 3, 'tool_use'), asst('r2', 4), stopSummary(4)]);
  const half = feedText(text.split('\n').slice(0, 5).join('\n') + '\n').snapshot();   // stops inside turn 2
  const resumed = resume(text, half);
  assert.deepEqual(resumed.snapshot(), feedText(text).snapshot());
  assert.deepEqual(resumed.snapshot().turns.map((t) => [t.intent.id, t.reply.id]), [['P1', 'R1'], ['P2', 'R2']]);
});
```

- [ ] **Step 2: Run to verify it fails.** `node mac-service/test/fixtures/digest/build.js && node --test mac-service/test/digest-extract.test.js` → FAIL, `ERR_MODULE_NOT_FOUND` for `extract.js`.
- [ ] **Step 3: Implement `createExtractor`.** The algorithm (tool records only open turns here; Task 4 reads them):

```
ts(r) = min(now(), Date.parse(r.timestamp) || prevTs || fallbackTs); prevTs = ts(r)
ignore silently: isSidechain records; `system` records other than stop_hook_summary; bookkeeping types attachment,
  file-history-snapshot, file-history-delta, queue-operation, last-prompt, api-request, api-request-shape, api-request-blob,
  cost-state, mode, permission-mode, bridge-session, atis-latch, frame-link, artifact-*, summary (Task 4 adds pr-link)
skipped++: record null, no `type`, an unknown type, or any throw while handling a record
owner prompt = user && (r.origin ? r.origin.kind === 'human' : userText(r) !== '') && !r.isMeta && !r.isCompactSummary
               && !text.startsWith('[Request interrupted')            // userText: recent-messages.js's rule
notice       = user && r.origin && r.origin.kind === 'task-notification'
work         = assistant, or a user record with tool_result blocks; any other origin.kind (e.g. 'peer') counts as work

custom-title / ai-title: last wins; title = redact(customTitle || aiTitle || project || 'session').slice(0, 60)
stop_hook_summary: if open → close(open, ts, endOffset)
owner prompt: if open && open.endTurnAt → close(open, open.endTurnAt.ts, open.endTurnAt.offset)   // fallback end
              prompt = { id: 'P' + next.P++, text: redact(text).slice(0, 500), ts }
              if !open → open = turn('human', intent = prompt, startTs = ts); else if !open.intent → open.intent = prompt
              open.lastPrompt = prompt
notice: if !open → open = turn('task-notification', intent = lastHumanPrompt)
work:   if !open → open = turn('none', intent = lastHumanPrompt)
        assistant with text blocks → open.replyText = them joined
        assistant → open.endTurnAt = stop_reason === 'end_turn' ? { ts, offset: endOffset } : null
after any record, if no turn is open → offset = endOffset
closeOpenTurn(): if open && open.endTurnAt → close at it
close(t, end, off): endTs = max(t.startTs, end); reply = t.replyText ? { id: 'R' + next.R++, text: redact(t.replyText).slice(0, 1200) } : null;
  keep the last 6 turns; totals.turns++; turnLog.push; lastTurnTs = endTs; offset = off; fold t's counters and lastPrompt into the closed state
```

**Superseded after review (ledger rulings, Task 3 fix round 1; the code in `mac-service/src/digest/extract.js` is the authority, not the pseudocode above).** (a) A turn closed by the next owner prompt, or by `closeOpenTurn()`, closes at `lastEnd`, the end offset of the record pushed just before, not at the `end_turn` record's offset, so a restart never re-reads records already folded into that turn. (b) `endTurnAt` is `{ ts }` only. (c) A user record whose text starts `[Request interrupted`, with a turn open, ends that turn (it keeps the reply so far); the marker is never a prompt, notice or work. (d) `SessionFacts` also carries `titleSource` (`'custom' | 'ai' | null`).

Keep the open turn's id counters and latest prompt on the open turn until it closes, so `snapshot()` holds only closed state. Also track `model` (newest `message.model`), `startedTs` (first record's ts) and `project` (`path.basename` of the first `cwd`).

- [ ] **Step 4: Run to verify it passes.** `node --test mac-service/test/digest-extract.test.js` → PASS, 12 tests.
- [ ] **Step 5: Commit.** `git add mac-service/src/digest/extract.js mac-service/test/fixtures/digest mac-service/test/digest-extract.test.js && git commit -m "feat(digest): split transcripts into turns with their trigger and intent"`

### Task 4: Extractor II — tool facts and totals

**Files:** Modify `mac-service/src/digest/extract.js` and `mac-service/test/fixtures/digest/build.js` (adds `tools.jsonl`); Test `mac-service/test/digest-extract.test.js` (append).

**Interfaces:**
- Consumes: `isTestCommand`, `parseTestOutcome`, `isCommitCommand`, `commitSubject`, `resultText`, `relPath` (Task 2); `redact` (Task 1).
- Produces: the `Turn` fields `files`, `commits`, `git`, `tests`, `failures`, `questions`, `agentsSpawned`, `denied`, and `totals`, `seenFiles`, `prNumbers` (Shared types).

`tools.jsonl`: one turn, human "Ship the digest" @0, tool records @1–@4, then asst "All done. Tests pass." @5 and stop @5.

| id | call | result |
|---|---|---|
| t1 | `Edit` `/Users/dev/proj/src/a.js`, old/new strings "OLD-SENTINEL"/"NEW-SENTINEL" | `{structuredPatch:[{lines:[' x','-y','+z','+w']}]}` |
| t2 | `Edit` same file | `{structuredPatch:[{lines:['+q']}]}` |
| t3 | `Write` `src/new.js`, content "CONTENT-SENTINEL" | `{type:'create', structuredPatch:[]}` |
| t4 | `Bash` `npm --prefix mac-service test` | `{stdout:'ℹ pass 41\nℹ fail 0\nOUTPUT-SENTINEL', stderr:''}` |
| t5 | `Bash` `go test ./...` | `{stdout:'ok pkg 0.1s', stderr:''}` |
| t6 | `Bash` `pytest -q` | `is_error`, `toolUseResult: "Error: Exit code 1"` |
| t7 | `Bash` `git add -A && git commit -m "feat(digest): facts only"` | `{stdout:'', gitOperation:{commit:{sha:'0123456789abcdef0123456789abcdef01234567', kind:'commit', branch:'main'}}}` |
| t8 | `Bash` `git commit -F /tmp/msg.txt` | `{stdout:''}` |
| t9 | `Bash` `git commit -m "broken"` | `is_error` |
| t10 | `Bash` `ls /nope` | `is_error` |
| t11 | `Bash` `git push -u origin feat/x` | `{gitOperation:{push:{branch:'feat/x'}}}` |
| t12 | `Bash` `gh pr create` | `{gitOperation:{pr:{number:14, action:'created'}}}`, then two `pr-link` records `{prNumber:14}` |
| t13 | `AskUserQuestion` `{questions:[{question:'Which window?'}]}` | — |
| t14 | `ExitPlanMode` `{plan:'# Ship the digest\nStep one'}` | — |
| t15 | `Agent` `{description:'Review Task 4', prompt:'PROMPT-SENTINEL'}` | — |
| t16 | `Read` | a user record with `toolDenialKind:'user'`, `is_error` |

It also holds an `attachment` record with "ATTACHMENT-SENTINEL", an assistant `thinking` block "THINKING-SENTINEL" and an `api-request` record with "API-SENTINEL".

- [ ] **Step 1: Write the failing test**

```js
const tools = () => run('tools.jsonl').snapshot(); const strip = ({ id, ...rest }) => rest; const t0 = () => tools().turns[0];
test('files are relative, created is marked, lines come from the patch', () => {
  assert.deepEqual(t0().files.map(strip), [{ path: 'src/a.js', created: false, added: 3, removed: 1 }, { path: 'src/new.js', created: true, added: 0, removed: 0 }]);
});
test('a quiet commit without [branch sha] still counts; an errored one does not; shas keep 12 chars', () => {
  assert.deepEqual(t0().commits.map(strip), [{ subject: 'feat(digest): facts only', sha: '0123456789ab' }, { subject: null, sha: null }]);
});
test('a test run without a count reads "outcome not reported"; is_error without one reads failed', () => {
  assert.deepEqual(t0().tests.map((t) => t.outcome), [{ status: 'counted', passed: 41, failed: 0 }, { status: 'not-reported' }, { status: 'failed' }]);
});
test('failing commands are the errored Bash calls that are neither tests nor commits', () => {
  assert.deepEqual(t0().failures.map((x) => x.command), ['ls /nope']);
});
test('pushes and PRs come from gitOperation, and pr-link records dedupe by number', () => {
  const f = tools(); assert.deepEqual(f.prNumbers, [14]);
  assert.deepEqual(f.turns[0].git.map(strip), [{ kind: 'push', branch: 'feat/x' }, { kind: 'pr', number: 14, action: 'created' }]);
});
test('questions, plans, spawned agents and denials are counted', () => {
  const t = t0(); assert.deepEqual([t.questions.count, t.questions.last.tool, t.questions.last.text, t.agentsSpawned, t.denied], [2, 'ExitPlanMode', 'Ship the digest', 1, 1]);
});
test('totals and stable ids', () => {
  const f = tools(); assert.deepEqual(f.totals, { turns: 1, files: 2, commits: 2, prs: 1, testRuns: 3 });
  assert.deepEqual(f.turns[0].tests.map((t) => t.id), ['T1', 'T2', 'T3']);
});
test('file contents, tool output, thinking, attachments and api records never reach the facts', () => {
  const json = JSON.stringify(tools());
  for (const s of ['OLD', 'NEW', 'CONTENT', 'OUTPUT', 'THINKING', 'ATTACHMENT', 'API', 'PROMPT']) assert.ok(!json.includes(s + '-SENTINEL'), s);
});
test('per-turn caps: top 8 files by size, last 3 tests', () => {
  const recs = [human('go', 0)];
  for (let i = 0; i < 10; i++) recs.push(use('e' + i, 'Edit', { file_path: CWD + '/f' + i }, 1), result('e' + i, { structuredPatch: [{ lines: Array(i + 1).fill('+x') }] }, 1));
  for (let i = 0; i < 5; i++) recs.push(use('b' + i, 'Bash', { command: 'npm test' }, 2), result('b' + i, { stdout: 'ℹ pass ' + i, stderr: '' }, 2));
  const [t] = feed([...recs, asst('ok', 3), stopSummary(3)]).snapshot().turns;
  assert.deepEqual([t.files.length, t.files[0].path], [8, 'f9']);
  assert.deepEqual(t.tests.map((x) => x.outcome.passed), [2, 3, 4]);
});
```

- [ ] **Step 2: Run to verify it fails.** `node mac-service/test/fixtures/digest/build.js && node --test mac-service/test/digest-extract.test.js` → the new tests FAIL (`files` is undefined); the sentinel test may already pass and stays as a guard.
- [ ] **Step 3: Implement the tool facts.**
  - **Pairing:** keep `pending: Map<tool_use_id, { name, path?, command? }>` on the open turn, storing only `file_path` / `notebook_path` and `command`. Use `toolUseResult` only when the record has exactly one `tool_result` block.
  - **Files:** `Edit`, `Write`, `MultiEdit`, `NotebookEdit` add to one entry per path per turn, path `redact(relPath(path, record.cwd))`. `+` / `-` lines of `structuredPatch[].lines` add to `added` / `removed`; `type === 'create'` sets `created`. Keep the 8 largest by `added + removed`, ties to the newest.
  - **Bash:** a test command → T fact, `outcome = parseTestOutcome(resultText(r, block), block.is_error === true)`. A commit command whose result isn't an error → C fact, subject `redact(commitSubject(cmd))`, sha `gitOperation.commit.sha.slice(0, 12)` or null. An errored call that is neither → X fact, `redact(cmd).slice(0, 160)`. On an object result, `gitOperation.push` → push G fact; `gitOperation.pr` → pr G fact unless its number is already in `prNumbers`.
  - **`pr-link`:** inside a turn, a new number → pr G fact; outside, it only joins `prNumbers`.
  - **Questions:** `AskUserQuestion` text `questions[0].question`; `ExitPlanMode` the first non-empty `plan` line without `#`; both redacted, ≤160, updating `count` and `last`.
  - **Counts:** `Agent` → `agentsSpawned++`; a user record with `toolDenialKind` → `denied++`.
  - **On close:** `totals.files` counts distinct paths via `seenFiles` (at most 2,000); `commits` and `testRuns` add the turn's; `totals.prs = prNumbers.length`; the `turnLog` entry has the turn's commits, new PRs and test runs.
- [ ] **Step 4: Run to verify it passes.** `node --test mac-service/test/digest-extract.test.js` → PASS, 21 tests.
- [ ] **Step 5: Commit.** `git add mac-service/src/digest/extract.js mac-service/test/fixtures/digest mac-service/test/digest-extract.test.js && git commit -m "feat(digest): files, commits, PRs, tests, failures, questions and totals per turn"`

### Task 5: Chunked offset reader

**Files:** Create `mac-service/src/digest/reader.js`; Test `mac-service/test/digest-reader.test.js`.

**Interfaces:**
- Consumes: nothing.
- Produces: `CHUNK_BYTES = 256 * 1024`; `MAX_LINE_BYTES = 4 * 1024 * 1024`; `readRecords(file, fromOffset, onRecord: (record | null, endOffset) => void, opts?: { chunkBytes, maxLineBytes }) -> Promise<{ offset, size, shrunk }>`. It reads whole lines from `fromOffset` up to the size at the start of the read; reports `null` for a line that won't parse or exceeds `maxLineBytes` (never buffering it whole); awaits `setImmediate` after every chunk; `offset` is the end of the last whole line; when `size < fromOffset` it reads nothing and returns `shrunk: true`.

- [ ] **Step 1: Write the failing test**

```js
test('reads whole lines from an offset and returns the new offset', async () => { /* 3 records; from line 1's end → 2 records, offset === size */ });
test('a torn last line is left for the next read', async () => {   // Review Focus 3
  fs.writeFileSync(f, line(a) + '{"type":"assis'); const seen = [];
  const r1 = await readRecords(f, 0, (r) => seen.push(r));
  assert.deepEqual([seen.length, r1.offset], [1, Buffer.byteLength(line(a))]);
  fs.appendFileSync(f, 'tant"}\n'); await readRecords(f, r1.offset, (r) => seen.push(r));
  assert.deepEqual(seen.map((r) => r.type), ['user', 'assistant']);
});
test('a malformed or oversize line reports null and reading continues', async () => { /* ok, '{bad', 'x'.repeat(5000) at maxLineBytes 1000, ok → [obj, null, null, obj] */ });
test('a character split across chunks decodes whole', async () => { /* text 'é—✓' with chunkBytes: 7 → same text */ });
test('a file smaller than the offset is reported as shrunk', async () => { assert.equal((await readRecords(f, 10_000, () => {})).shrunk, true); });
test('it yields between chunks', async () => {
  let ticks = 0; const iv = setInterval(() => ticks++, 0);
  await readRecords(fourMbFile, 0, () => {}, { chunkBytes: 64 * 1024 }); clearInterval(iv);
  assert.ok(ticks >= 10, `timers ran ${ticks} times during the read`);
});
```

- [ ] **Step 2: Run to verify it fails.** `node --test mac-service/test/digest-reader.test.js` → FAIL, `ERR_MODULE_NOT_FOUND`.
- [ ] **Step 3: Implement `readRecords`.** `fs.promises.open` and `handle.read` into one reused buffer; carry the bytes after the last `\n` as a `Buffer` and decode only whole lines (multi-byte characters survive chunk edges); once the carry passes `maxLineBytes`, drop bytes to the next newline and report `null`; close the handle in `finally`.
- [ ] **Step 4: Run to verify it passes.** Same command → PASS, 6 tests.
- [ ] **Step 5: Commit.** `git add mac-service/src/digest/reader.js mac-service/test/digest-reader.test.js && git commit -m "feat(digest): read transcripts by offset in yielding chunks"`

### Task 6: Persistence at mode 0600

**Files:** Modify `mac-service/src/persist.js`; Create `mac-service/src/digest/state.js`; Test `mac-service/test/persist.test.js` (append), `mac-service/test/digest-state.test.js`.

**Interfaces:**
- Consumes: `readState`, `writeState` (`persist.js`).
- Produces:
  - `writeState(name, value, opts?: { mode? }) -> boolean`: with `mode`, the temp file is written and `chmod`ed to it before the rename; the default is unchanged.
  - `loadDigestState() -> DigestState` (missing, corrupt or another `version` → `{ version: 1, sessions: {} }`); `saveDigestState(state) -> boolean` (`writeState('digest', state, { mode: 0o600 })`).
  - `pruneDigestState(state, { now, windowMs }) -> DigestState`: drops sessions with `max(facts.lastTurnTs, mtimeMs) < now - windowMs`; trims each `facts.turnLog` to `endTs >= now - windowMs`.
  - `createSaver({ save, intervalMs = 10_000, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) -> { request(getState), flush(), stop() }`: the first request saves at once; later ones within `intervalMs` arm one trailing timer.

- [ ] **Step 1: Write the failing tests** (set `CLAUDE_THING_STATE_DIR` to a temp dir before importing, as `persist.test.js` does)

```js
test('writeState with a mode writes that mode, even over an existing 0644 file', () => {
  fs.writeFileSync(path.join(DIR, 'secret.json'), '{}', { mode: 0o644 }); writeState('secret', { a: 1 }, { mode: 0o600 });
  assert.equal(fs.statSync(path.join(DIR, 'secret.json')).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(DIR).filter((f) => f.endsWith('.tmp')), []);
});
test('the digest state round-trips at 0600', () => { /* saveDigestState(s); loadDigestState() deepEquals s; mode & 0o777 === 0o600 */ });
test('a missing, corrupt or other-version file loads as empty', () => { /* each → { version: 1, sessions: {} } */ });
test('pruning drops sessions outside the window and trims their turn log', () => {
  /* now NOW, windowMs 24 h: a session last active NOW-25h is dropped, one at NOW-1h kept, its turnLog entry at NOW-30h removed */
});
test('the saver writes at most once every 10 s and flush writes what is pending', () => {
  /* fake clock: request at 0 → 1 save; at 1 s and 2 s → none; the timer at 10 s → 2; request then flush → 3 */
});
```

- [ ] **Step 2: Run to verify they fail.** `node --test mac-service/test/persist.test.js mac-service/test/digest-state.test.js` → FAIL (mode `0o644`; `digest/state.js` missing).
- [ ] **Step 3: Implement.** `fs.writeFileSync(tmp, json, { mode })` then `fs.chmodSync(tmp, mode)` when a mode is given.
- [ ] **Step 4: Run to verify they pass.** Same command → PASS.
- [ ] **Step 5: Commit.** `git add mac-service/src/persist.js mac-service/src/digest/state.js mac-service/test/persist.test.js mac-service/test/digest-state.test.js && git commit -m "feat(digest): persist digest state at 0600, throttled and pruned"`

### Task 7: Subagent facts and the card builder

**Files:** Modify `mac-service/src/sessions/subagents.js`; Create `mac-service/src/digest/agents.js`, `mac-service/src/digest/card.js`; Test `mac-service/test/subagents.test.js` (append), `mac-service/test/digest-card.test.js`.

**Interfaces:**
- Consumes: `SessionFacts`, `LIMITS` (Tasks 3–4); `firstSentence` (Task 2); `redact` (Task 1); `readJson`, `agentIds`, `readTailRecords`, `reportOf` inside `subagents.js`.
- Produces:
  - `listSubagentMetas(sessionDir) -> [{ id, description, agentType, finished, stoppedByUser, mtimeMs }]`, oldest meta file first (metas only: `readSubagents` reads a 64 KB tail per agent, too heavy here).
  - `readSubagentReport(sessionDir, agentId, maxChars) -> string | null`: null unless the meta says `finished: true`; the `reportOf` rule.
  - `readAgentFacts(sessionDir, { ended }) -> AgentFacts`: `running` = not finished, not stopped by the user, not ended; `list` = the last 6 with ids `A<n>` by meta order; descriptions and reports redacted, reports ≤300.
  - `emptyDigest(now) -> Digest`; `cardLines(facts, agents) -> string[]`; `buildCard(sessionId, rec, { live }) -> DigestCard`; `buildDigest(sessions, { now, windowHours, maxCards, isLive }) -> Digest`.

- [ ] **Step 1: Write the failing tests.** `toolsFacts` is `tools.jsonl` run through the extractor; `rec(facts, agents)` wraps a `SessionRecord` around them; `oneTurn(fields)` is a `SessionFacts` with one closed turn holding only `fields`.

```js
test('metas list oldest first; a report only once finished, cut to the asked length', () => {   // subagents.test.js
  assert.deepEqual(listSubagentMetas(fx('basic')).map((m) => m.finished).sort(), [false, true, true]);
  assert.equal(readSubagentReport(fx('basic'), 'a-running', 300), null);
  assert.ok(readSubagentReport(fx('basic'), 'a-finished-1', 10).length <= 10);
});
const AGENTS = { finished: 2, running: 1, list: [{ id: 'A1', description: 'Review Task 4', finished: true },
  { id: 'A2', description: 'Review Task 5', finished: true }, { id: 'A3', description: 'Explore', finished: false }] };
test('facts-only lines: files, tests, commits, PRs, agents, at most four', () => {
  assert.deepEqual(cardLines(toolsFacts, AGENTS), ['Edited 2 files: src/a.js, +1', 'Tests: failed', '2 commits: feat(digest): facts only, +1', 'PR #14']);
  assert.deepEqual(cardLines(oneTurn({ tests: [{ id: 'T1', command: 'go test', outcome: { status: 'not-reported' } }] }), AGENTS),
    ['Tests: ran, outcome not reported', '2 agents finished: Review Task 5']);
});
test('a card has exactly the protocol fields, facts-only', () => {
  const card = buildCard('s1', rec(toolsFacts, AGENTS), { live: true });
  assert.deepEqual(Object.keys(card).sort(), ['behindTurns', 'ended', 'facts', 'lastReply', 'lastTurnTs', 'lines', 'project', 'sessionId', 'summary', 'title']);
  assert.deepEqual([card.summary, card.behindTurns, card.lastReply], [null, 0, 'All done.']);
  assert.deepEqual(card.facts, { turns: 1, files: 2, commits: 2, prs: 1, tests: { passed: 41, failed: 0, runs: 3 }, agents: { finished: 2, running: 1 } });
  assert.equal(buildCard('s1', rec(toolsFacts, AGENTS), { live: false }).ended, true);
});
test('the digest: window, newest first, at most 20 cards, fleet totals over the window, summarizer off', () => {
  const d = buildDigest(sessions /* 25 in the window, 1 outside, 1 with no human prompt */, { now: NOW, windowHours: 24, maxCards: 20, isLive: () => true });
  assert.deepEqual(d.summarizer, { state: 'off', model: null, lastOkTs: null });
  assert.deepEqual([d.windowHours, d.cards.length, d.totals.sessions], [24, 20, 25]);
  assert.ok(d.cards.every((c, i) => i === 0 || d.cards[i - 1].lastTurnTs >= c.lastTurnTs));
});
```

- [ ] **Step 2: Run to verify they fail.** `node --test mac-service/test/subagents.test.js mac-service/test/digest-card.test.js` → FAIL (`listSubagentMetas` not exported; `card.js` missing).
- [ ] **Step 3: Implement.** `cardLines` reads the six stored turns, in this order, drops lines with nothing to say and keeps the first 4:
  1. `Edited N file(s): <largest path>[, +K]` (`Created` when every file was created);
  2. the newest test run: `Tests: P passed, F failed` | `Tests: failed` | `Tests: ran, outcome not reported`;
  3. `N commit(s): <newest subject read, else "message not read">[, +K]`;
  4. `PR #n` | `PRs #a, #b`;
  5. `N agent(s) finished: <newest finished description>`.

  `buildCard`: `ended = rec.ended || !live`; `lastReply` = `firstSentence` of the newest reply, else `''`; `facts.tests` = null without runs, else `runs = totals.testRuns` and `passed` / `failed` from the newest counted outcome (null when none). `buildDigest` keeps sessions with `hasHumanPrompt` and `lastTurnTs >= now - windowHours·3600e3`, sorts by `lastTurnTs` descending, slices `maxCards`; `totals.sessions` counts every kept session and the other totals sum their in-window `turnLog` entries.
- [ ] **Step 4: Run to verify they pass.** Same command → PASS.
- [ ] **Step 5: Commit.** `git add mac-service/src/sessions/subagents.js mac-service/src/digest/agents.js mac-service/src/digest/card.js mac-service/test/subagents.test.js mac-service/test/digest-card.test.js && git commit -m "feat(digest): facts-only cards and the Digest snapshot"`

### Task 8: The digest service

**Files:** Modify `mac-service/src/config.js`; Create `mac-service/src/digest/index.js`; Test `mac-service/test/digest-service.test.js`.

**Interfaces:**
- Consumes: `createExtractor` (Tasks 3–4); `readRecords` (Task 5); `loadDigestState`, `saveDigestState`, `pruneDigestState`, `createSaver` (Task 6); `readAgentFacts`, `buildDigest` (Task 7); `isOwnSession`; `log`.
- Produces, in `config.js`: `DIGEST_WINDOW_HOURS = 24`, `DIGEST_MAX_CARDS = 20`, `DIGEST_EMIT_DEBOUNCE_MS = 2_000`, `DIGEST_SAVE_INTERVAL_MS = 10_000`, `DIGEST_READ_DELAY_MS = 1_500` (lets `stop_hook_summary` land first), `DIGEST_ENABLED = process.env.CLAUDE_PANEL_DIGEST !== '0'`.
- Produces `createDigest({ emit, projectsDir, now = Date.now, isLive = () => false, read = readRecords, windowHours, maxCards, readDelayMs, emitDebounceMs, saveIntervalMs })` (the last five default to the constants) returning `{ onHook(event, payload), start(): Promise<void>, stop(), get(): Digest, status(): { sessions, cards, skipped, queued, catchUpMs }, whenIdle(): Promise<void> }`.
- Behaviour:
  - **`onHook`** acts on `Stop` and `SessionEnd` only and does no I/O. It ignores a missing `session_id`, own sessions, and a `transcript_path` outside `projectsDir` (a hook without one uses the path already known). Otherwise it marks the session dirty and arms its timer: `readDelayMs` for Stop, `0` for SessionEnd, which also sets `ended`.
  - **Reads** run one session at a time, hook work before catch-up work. A hook for the session being read sets `again`; it is queued once more when the read ends.
  - **Reading a session:** `fs.promises.stat` (gone → drop it); shrunk → fresh extractor from offset 0; `await read(path, readOffset, (rec, end) => ex.push(rec, end))`; `ex.closeOpenTurn()`; `agents = readAgentFacts(path without '.jsonl', { ended })`; request a save; schedule the emit; `log('DG', \`read ${id.slice(0, 8)} ${bytes}B ${ms}ms\`)`.
  - **Emit:** the first change after an emit starts an `emitDebounceMs` timer that sends one `emit('claude.digest.update', get())`.
  - **`start()`:** load and prune the state; list `projectsDir/*/*.jsonl` with `fs.promises.readdir` and `stat` (stat follows symlinks); keep files modified inside the window, not own sessions, whose size differs from the stored offset; queue them newest first at low priority; set `catchUpMs` when the queue first drains.
  - **`whenIdle()`** resolves when no timer, queued session or read remains.

- [ ] **Step 1: Write the failing test.** Set `CLAUDE_THING_STATE_DIR` to a temp dir before importing (`config.js` reads it once, so a `beforeEach` deletes `digest.json` and rebuilds the projects dir); copy fixtures to `tmp/projects/proj/<id>.jsonl` and `utimes` them to `NOW - 1h`, with `NOW = Date.parse('2026-11-02T12:00:00Z')`; `make(opts)` is `createDigest({ emit: (t, d) => emitted.push([t, d]), projectsDir, now: () => NOW, readDelayMs: 5, emitDebounceMs: 20, saveIntervalMs: 50, ...opts })`.

```js
test('catch-up makes one card per session with a finished turn, newest first; skips no-human, old and own files', async () => {
  // turns, tools, notify-only, old (mtime NOW-30h), own (an id passed to markOwnSession)
  const d = make(); await d.start(); await d.whenIdle();
  assert.deepEqual(d.get().cards.map((c) => c.sessionId), ['turns', 'tools']);
});
test('the digest has the protocol shape, facts-only', async () => { /* summarizer off, windowHours 24, every card summary null and behindTurns 0 */ });
test('a Stop does no I/O on the hook path and is read after the delay', async () => {
  let reads = 0; const d = make({ read: (...a) => { reads++; return readRecords(...a); } }); await d.start(); await d.whenIdle(); reads = 0;
  fs.appendFileSync(file('turns'), jsonl([stopSummary(22)]));
  d.onHook('Stop', { session_id: 'turns', transcript_path: file('turns') });
  assert.equal(reads, 0, 'nothing read before the hook returns');
  await d.whenIdle(); assert.equal(reads, 1);
  assert.equal(d.get().cards.find((c) => c.sessionId === 'turns').facts.turns, 4);
});
test('a burst of Stops makes one claude.digest.update', async () => { /* 3 Stops within 5 ms → one emitted frame, topic 'claude.digest.update' */ });
test('a session that ends while it is being read is read once more and ends', async () => {   // Review Focus 1
  /* read() waits on a gate; SessionEnd arrives mid-read; open the gate */
  assert.deepEqual([card.ended, card.facts.turns, readCalls], [true, 3, 2]);
});
test('a transcript that shrinks is read again from the start', async () => { /* rewrite 'turns' as notify-only's text; Stop → no card for it */ });
test('the state file is 0600 and a restart reads only new bytes', async () => {   // Review Focus 5
  d.stop(); assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
  const d2 = make({ read: spy }); await d2.start(); await d2.whenIdle();
  assert.deepEqual(spy.calls.map(([f, from]) => [path.basename(f), from > 0]), [['turns.jsonl', true]], 'only the open turn is re-read');
  assert.deepEqual(d2.get().cards, d.get().cards);
});
test('a planted secret of each kind never reaches the cards, the event or the state file', async () => {
  // one transcript whose title, prompt, reply, commit -m and failing command carry every SECRETS text (Task 1)
  for (const blob of [JSON.stringify(d.get()), JSON.stringify(emitted), fs.readFileSync(stateFile, 'utf8')])
    for (const [kind, text, needle = text] of SECRETS) assert.ok(!blob.includes(needle), kind);
});
test('a hook outside the projects dir, or without a session id, is ignored', async () => { /* no read */ });
```

- [ ] **Step 2: Run to verify it fails.** `node --test mac-service/test/digest-service.test.js` → FAIL, `ERR_MODULE_NOT_FOUND`.
- [ ] **Step 3: Implement `createDigest`.** In memory each session is `{ path, readOffset, extractor, agents, ended, mtimeMs, timer, again }`, built from its `SessionRecord` on load (`readOffset = facts.offset`); the saved record is `{ path, mtimeMs, ended, facts: extractor.snapshot(), agents }`.
- [ ] **Step 4: Run to verify it passes.** `node --test mac-service/test/digest-service.test.js`, then `npm --prefix mac-service test` → PASS, existing suites included.
- [ ] **Step 5: Commit.** `git add mac-service/src/config.js mac-service/src/digest/index.js mac-service/test/digest-service.test.js && git commit -m "feat(digest): Stop/SessionEnd triggers, catch-up scan, persistence and debounced updates"`

### Task 9: Protocol and hub wiring

**Files:** Modify `mac-service/src/hub.js:34`, `mac-service/src/http-server.js:33,104-106,124-137`, `mac-service/src/index.js`, `mac-service/src/config.js:29` (`PID_FILE`), `mac-service/src/sessions/source-mock.js` (exports), `protocol/claude-protocol.md`; Test `mac-service/test/hub-watch.test.js` (append), `mac-service/test/http-server-digest.test.js`.

**Interfaces:**
- Consumes: `createDigest`, `DIGEST_ENABLED` (Task 8); `emptyDigest` (Task 7).
- Produces:
  - `SUPERSEDING = /^claude\.(sessions?|usage|digest)\./`.
  - `createHttpServer({ …existing, digest })`: after the response to a non-held `Stop` or `SessionEnd` finishes, `res.once('finish', () => { try { digest.onHook(event, payload); } catch {} })`; `/status` gains `digest: digest ? digest.status() : null` (the skipped-record count the spec's Key risk 2 asks for).
  - Hub method `'claude.digest.get': async () => (digest ? digest.get() : emptyDigest(Date.now()))`.
  - `source-mock.js`: `export const MOCK_DIR = path.join(os.tmpdir(), 'claude-panel-mock')` (the default `dir`) and `export const MOCK_PROJECTS_DIR = path.join(MOCK_DIR, 'projects')`.
  - `PID_FILE = process.env.CLAUDE_THING_PID_FILE || path.join(DAEMON_ROOT, '.daemon.pid')`, so the latency script leaves the real PID file alone.

- [ ] **Step 1: Write the failing tests**

```js
test('digest updates are dropped for a backed-up socket; asks are not', () => {   // hub-watch.test.js
  const hub = createHub({ heartbeatMs: 0 }); const sock = connect(hub, 'panel'); sock.bufferedAmount = 128 * 1024;
  hub.emit('claude.digest.update', { cards: [] }); hub.emit('claude.permission.request', { requestId: 'r' });
  assert.deepEqual([eventsOf(sock, 'claude.digest.update').length, eventsOf(sock, 'claude.permission.request').length], [0, 1]);
});
// http-server-digest.test.js: before importing, set CLAUDE_THING_PORT (a random free port), CLAUDE_PANEL_BIND=127.0.0.1
// and CLAUDE_PANEL_CONFIG_DIR (a temp dir); POST with node:http so no Origin header is sent. start(digest) calls
// createHttpServer with createHub({ heartbeatMs: 0 }), a stub store ({ count: () => 0 }), permissionBridge
// ({ pendingCount: () => 0 }) and sources ({ onHookEvent() {}, promptHookInstalled: () => false, status: () => [], hooksInstalled: () => false }).
test('Stop and SessionEnd reach the digest after the response; other hooks do not', async () => {
  const calls = []; const server = await start({ onHook: (e, p) => calls.push([e, p.session_id]), status: () => ({}) });
  for (const e of ['PreToolUse', 'Stop', 'SessionEnd'])
    assert.deepEqual(await post('/hook', { hook_event_name: e, session_id: 's1', transcript_path: '/x' }), { status: 200, body: '{}' });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, [['Stop', 's1'], ['SessionEnd', 's1']]); server.close();
});
test('a digest that throws never breaks the hook response', async () => { /* onHook throws → 200 '{}' twice in a row */ });
test('/status reports the digest', async () => { /* body.digest deepEquals what status() returned */ });
```

- [ ] **Step 2: Run to verify they fail.** `node --test mac-service/test/hub-watch.test.js mac-service/test/http-server-digest.test.js` → FAIL (the digest frame is delivered; `calls` is empty).
- [ ] **Step 3: Implement.** In `index.js`, before `createSources`: `const digest = DIGEST_ENABLED ? createDigest({ emit: hub.emit, projectsDir: MOCK_SESSIONS ? MOCK_PROJECTS_DIR : CLAUDE_PROJECTS_DIR, isLive: (id) => !!store.raw(id) }) : null;`. Pass it to `createHttpServer`, register `claude.digest.get`, call `digest.start()` beside `usage.start()` and `digest.stop()` in `shutdown()`. In `protocol/claude-protocol.md`, add the spec's two rows (Requests and Events, the event noted "superseding: dropped for a backed-up socket, like sessions and usage") and the `Digest` / `DigestCard` block under Shapes, with: "Milestone 1: `summarizer.state` is `'off'`, `summary` is `null`, `behindTurns` is `0`; `lines` and `lastReply` are redacted. A card's live state comes from `claude.sessions.update` by `sessionId`; a session missing from it is ended."
- [ ] **Step 4: Run to verify they pass.** `npm --prefix mac-service test` → PASS. Then `CLAUDE_THING_PORT=18790 CLAUDE_THING_MOCK=1 CLAUDE_THING_PID_FILE="$TMPDIR/dg.pid" node mac-service/src/index.js & sleep 2; curl -s 127.0.0.1:18790/status | grep -o '"digest":{[^}]*}'; kill %1` prints one `"digest":{…}` object.
- [ ] **Step 5: Commit.** `git add mac-service/src/hub.js mac-service/src/http-server.js mac-service/src/index.js mac-service/src/config.js mac-service/src/sessions/source-mock.js protocol/claude-protocol.md mac-service/test/hub-watch.test.js mac-service/test/http-server-digest.test.js && git commit -m "feat(digest): claude.digest.get, superseding claude.digest.update, hooks notify after responding"`

### Task 10: Hooks are unaffected

**Superseded after review (ledger rulings, Task 10 fix round 1; the code in `mac-service/scripts/hook-latency.js` is the authority, not the text below).** The p99 rule alone printed PASS against a reader that blocked the loop for ~90 ms, because a 50 MB catch-up overlaps only ~2 hooks. The script now has two rules: the pinned `verdict(off, on, marginMs = 10)` / `summarize(ms)` (unchanged) as the steady per-hook check, plus `burstVerdict(offMaxes, onMaxes, marginMs = 35)`: six runs alternating off, on, off, on, off, on, each with a closed-loop burst (one hook in flight, `--burst-ms`, default 1000) from TCP accept, FAIL when the smallest digest-on max exceeds the smallest digest-off max by more than 35 ms. `finalVerdict`: FAIL if either rule fails; INCONCLUSIVE (exit 2, JSON printed) when fewer than 20 burst hooks overlap the catch-up or it did not finish; a service that dies mid-run is a FAIL (exit 1); SIGHUP, SIGINT and SIGTERM clean up (exit 129/130/143). `--seconds` is each side's total split over its three runs (default command ~66 s). Also: the digest only reads transcripts whose real path is inside its projects directory but the scan follows symlinks; the script copies the transcript anyway (the copy's mtime must be now).

**Files:** Create `mac-service/scripts/hook-latency.js`, `mac-service/test/hook-latency.test.js`, `mac-service/test/digest-latency.test.js`; Modify `mac-service/package.json` (script `"hook-latency": "node scripts/hook-latency.js"`), `README.md` (Tests section).

**Interfaces:**
- Consumes: `createDigest` (Task 8); `/status.digest.catchUpMs` (Task 9); the env switches `CLAUDE_PANEL_DIGEST`, `CLAUDE_THING_PID_FILE`, `CLAUDE_THING_STATE_DIR`, `CLAUDE_CONFIG_DIR`, `CLAUDE_PANEL_CONFIG_DIR`, `CLAUDE_THING_PORT`, `CLAUDE_PANEL_BIND`.
- Produces: `summarize(ms: number[]) -> { p50, p99, max, n }` and `verdict(off, on, marginMs = 10) -> 'PASS' | 'FAIL'` exported from the script (it runs `main()` only when invoked directly); `node mac-service/scripts/hook-latency.js [--transcript <file>] [--seconds 30] [--rate 20]` prints one JSON line `{ off, on: { …, catchUpMs }, verdict }` and exits 1 on FAIL.

- [ ] **Step 1: Write the failing tests**

```js
test('summarize gives nearest-rank percentiles', () => {   // hook-latency.test.js
  const ms = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.deepEqual(summarize(ms), { p50: 50, p99: 99, max: 100, n: 100 });
});
test('the verdict allows 10 ms over the digest-off p99, no more', () => {
  assert.equal(verdict({ p99: 4 }, { p99: 14 }), 'PASS'); assert.equal(verdict({ p99: 4 }, { p99: 14.5 }), 'FAIL');
});
test('catching up a 30 MB transcript never holds the event loop', async () => {   // digest-latency.test.js; Review Focus 2
  // built at runtime: every 40th line a human prompt, an end_turn reply and a stop; most lines Bash results with
  // 20–200 KB of stdout; three 2 MB attachment lines
  const h = monitorEventLoopDelay({ resolution: 1 }); h.enable();
  const d = createDigest({ emit() {}, projectsDir, now: () => NOW, readDelayMs: 0 }); await d.start(); await d.whenIdle(); h.disable();
  assert.ok(h.percentile(99) / 1e6 < 20, `p99 loop delay ${(h.percentile(99) / 1e6).toFixed(1)} ms`);
  assert.ok(h.max / 1e6 < 100, `max loop delay ${(h.max / 1e6).toFixed(1)} ms`);
  assert.equal(d.get().cards.length, 1);
});
```

- [ ] **Step 2: Run to verify they fail.** `node --test mac-service/test/hook-latency.test.js mac-service/test/digest-latency.test.js` → the script tests FAIL with `ERR_MODULE_NOT_FOUND`. The loop-delay test should already pass on Tasks 5 and 8; if it fails, fix the reader before going on, and put its measured p99 and max in the commit message.
- [ ] **Step 3: Implement `hook-latency.js`.** `--transcript` defaults to the largest `CLAUDE_PROJECTS_DIR/*/*.jsonl`, whose content is never printed. For each of `off`, then `on`: symlink the transcript as `<tmp>/claude/projects/latency/<uuid>.jsonl`; spawn `node src/index.js` with a free `CLAUDE_THING_PORT`, `CLAUDE_PANEL_BIND=127.0.0.1`, `CLAUDE_CONFIG_DIR`, `CLAUDE_THING_STATE_DIR`, `CLAUDE_PANEL_CONFIG_DIR` and `CLAUDE_THING_PID_FILE` inside `<tmp>`, and `CLAUDE_PANEL_DIGEST` `0` or `1`; wait for `/status`; for `--seconds`, POST `/hook` every `1000 / rate` ms with `{ hook_event_name: PreToolUse | PostToolUse (alternating), session_id: 'latency-probe', tool_name: 'Read', tool_input: { file_path: '/tmp/x' }, cwd: <tmp> }`, timing each response; read `catchUpMs` from `/status`; kill the child. In `README.md`'s Tests section add `npm --prefix mac-service run hook-latency` and one sentence on what PASS means.
- [ ] **Step 4: Run to verify they pass.** The test command → PASS. Then `npm --prefix mac-service run hook-latency -- --seconds 20` prints `"verdict":"PASS"` with `on.catchUpMs > 0`. On FAIL, move `JSON.parse` in `readRecords` into a `worker_threads` worker and rerun both.
- [ ] **Step 5: Commit.** `git add mac-service/scripts/hook-latency.js mac-service/test/hook-latency.test.js mac-service/test/digest-latency.test.js mac-service/package.json README.md && git commit -m "test(digest): hook latency script and an event-loop bound on a 30 MB catch-up"`

### Task 11: Panel Digest list and the first card's parts

**Files:** Create `panel/src/screens/digest.js`, `panel/test/digest.test.js`, `panel/test/digest-css.test.js`; Modify `panel/src/screens/helpers.js` (`fmtAge`), `panel/src/styles.css` (a `/* ---- digest ---- */` section), `panel/test/helpers.test.js`.

**Interfaces:**
- Consumes: `state.digest: Digest | null` and `state.digestSel: string | null` (store fields from Task 12; tests pass them in); `state.sessions`, merged by `ws-mux.js` (the Mac's untagged, then the NucBox's tagged `machine: 'NucBox'`); `state.details`; `esc`, `topbar`, `stateLabel` (`helpers.js`); `now` (`clock.js`).
- Produces:
  - `fmtAge(ms) -> string`: `'now'` under a minute, `'<m>m'` under an hour, `'<h>h'` under 48 h, else `'<d>d'`.
  - `digestCards(state) -> DigestCard[]`; `findCard(state, sessionId) -> DigestCard | null` (also null when `state.details[sessionId].machine` is set: a NucBox session's view).
  - `liveOf(state, card) -> { state, ended }`: from the Mac's session with that id, the one in `state.sessions` without `machine`; missing → `{ state: 'idle', ended: true }`.
  - `selectedIndex(cards, selId) -> number` (0 when absent); `moveSelection(cards, selId, dir) -> string | null` (clamped).
  - `pressTarget(state, sessionId) -> { open: id } | { toast: 'SESSION ENDED' }`.
  - `renderDigest(state, seenTs) -> string`.
  - For the sessions screen's first card (Task 14 places it):
    - `digestFleetLine(digest) -> string`: `LAST <windowHours>H · N SESSION(S) · N TURN(S)[ · N COMMIT(S)][ · N PR(S)]`, zero commits or PRs left out; the strip and the card both print it. `hasFleetCard(state) -> boolean`: `state.digest` is non-null and has at least one card.
    - `fleetCardRows(state) -> [{ id, lamp, title, text, age }]`: the first three of `digestCards(state)` (newest first). `lamp` is `liveOf(state, card).state`, a `.lamp` class; `text` is `'"' + lastReply + '"'`, else `lines[0]`, else `''` (a model headline in later plans); `age` is `fmtAge(now() - card.lastTurnTs)`.
    - `renderFleetCard(state, selected) -> string`: `''` unless `hasFleetCard(state)`; else `<div class="dgfirst[ selected]" data-action="digest-card">`, then `.dgfhead` `DIGEST`, `.dgffleet` (the fleet line), one `.dgfrow` per row (`.dgfrtop` with the lamp, `.dgftitle` and `.dgfage`, then `.dgftext`), and `.dghint` `PRESS TO OPEN`. It is one tap target, has no NEW tags, and is not a visit for Task 12's `digestSeen`.

| Condition | Markup and copy |
|---|---|
| `state.digest` null | topbar `DIGEST`; `.empty` `READING DIGEST…` |
| no cards | topbar `DIGEST`; `.empty` `NOTHING DONE IN THE LAST <windowHours>H` |
| strip | `<div class="dgstrip"><span class="dgfleet">` + `digestFleetLine(digest)` + `</span><span class="dgsrc">FACTS ONLY</span></div>`; `FACTS ONLY` for any `summarizer.state` (later plans add the rest) |
| selected card | `.dgcard`: `.dghead` (lamp, `.dgstate`, `.dgtitle`, tags, `.dgage`); `<div class="dgreply"><span class="dgrlabel">LAST REPLY</span> &quot;…&quot;</div>`; up to 4 `.dgline`; `.dghint` `PRESS TO OPEN` when live |
| other cards | `.dgrow`: `.dghead` and one `.dgsub` line, `LAST REPLY "…"` or `lines[0]` when there is no reply |
| tags | `<span class="dgtag">NEW</span>` when `lastTurnTs > seenTs`, then `FACTS` while `summary` is null |
| offline | the same cards and ages with `daemonConnected: false`; the conn dot is off and `main.js` shows the banner |

This list is the drill-down from the first card (Task 14), not a preset stop; Back returns to `#/list` (Task 12). Topbar: `topbar('DIGEST', connected, String(cards.length))`. Rows and cards carry `data-action="digest-row" data-id="<sessionId>"`. The column renders from a module-level `firstRow` kept so `selected - firstRow <= 3`, as `session-list.js` keeps `scrollCol`. Lamp label: `stateLabel(live.state, live.ended)`; age: `fmtAge(now() - card.lastTurnTs)`.

**Merged sessions.** Ids are not namespaced. Real ones are Claude Code's UUIDs, unique across machines (the mux's `sessionHost` map already relies on that), but the demo ids `mock-<i>-<name>` repeat when both machines run `CLAUDE_THING_MOCK=1`. The digest is the Mac's (Task 12), so the join is Mac-only: a NucBox session never lights, labels or opens a card, and its view never shows one. A card whose session is not among the Mac's sessions reads ENDED with an idle lamp and presses to the `SESSION ENDED` toast; a live one presses to `main.js`'s `openSession(id)`, which goes to `#/session/<id>` and whose requests the mux sends to the Mac by `sessionHost`.

CSS, margins only (★ is glance text, ≥19 px): `.dgstrip` 34 px high, mono 16 `--muted`, `.dgfleet { flex: 1 }`; `.dgcard .lamp` 18; `.dgstate` 700 17 `--text-2`; `.dgtitle` 700 22 `--text-2` ★; `.dgtag` 14 caps, 1 px `--rule` outline, `--text-2`; `.dgage` and `.dghint` mono 16 `--muted`; `.dgreply` 700 22 `--text-2` ★, at most 2 lines (`-webkit-line-clamp`); `.dgline` 500 20 `--text-3` ★, one line with ellipsis; `.dgrow` 58 px high, lamp 14, `.dgstate` 15, `.dgtitle` 15 `--dim`; `.dgsub` 19 `--text-2` ★, one line; the selected card on `--panel-hi`; idle and ended titles `--muted`; `.digest .lamp, .dstrip .lamp, .dgfirst .lamp { animation: none; box-shadow: none; }`.

The first card's CSS, also margins only: `.dgfirst` is drawn as a tile (a flex column, padding 15 18 14 18, radius 10, `--panel`, `line-height: 1.25`; `.dgfirst.selected` on `--panel-hi` with `box-shadow: 0 0 0 2px var(--accent)`, as `.tile.selected`), with no width or height of its own; `.dgfhead` 700 17 caps `--text-2`; `.dgffleet` mono 16 `--muted`, margin-top 6 (it may wrap to two lines); `.dgfrow` margin-top 14; `.dgfrtop` a flex row, its lamp 14 with margin-right 10; `.dgftitle` 700 19 `--text-2` ★, `flex: 1`, one line with ellipsis; `.dgfage` mono 16 `--muted`, margin-left 10; `.dgftext` 500 19 `--text-3` ★, margin-top 4, at most 2 lines (`-webkit-line-clamp`); `.dgfirst .dghint` margin-top auto, right-aligned. At 1.25 that stacks to about 384 px (29 padding, 21 head, 46 fleet, 3 × 89 rows, 20 hint) of the card's 414.

- [ ] **Step 1: Write the failing tests** (`baseState()` and a `card(over)` factory in the `screens.test.js` style; a card defaults to `lastTurnTs = now() - 12 * 60e3`; `st(digestOver, stateOver)` wraps them)

```js
test('a facts-only card: LAST REPLY, fact lines, FACTS tag, no NEW once seen', () => {
  const html = renderDigest(st({ cards: [card({ lastReply: 'The recorder now reopens.', lines: ['Tests: 14 passed, 0 failed'] })] }), Infinity);
  for (const re of [/LAST REPLY<\/span> &quot;The recorder now reopens\.&quot;/, /Tests: 14 passed, 0 failed/, /class="dgtag">FACTS</]) assert.match(html, re);
  assert.doesNotMatch(html, />NEW</);
});
test('the strip counts the window and says FACTS ONLY', () => {
  assert.match(renderDigest(st({ totals: { sessions: 6, turns: 19, commits: 7, prs: 1, testRuns: 3 } }), 0),
    /LAST 24H · 6 SESSIONS · 19 TURNS · 7 COMMITS · 1 PR<\/span><span class="dgsrc">FACTS ONLY/);
});
test('nothing in the window, and a digest not yet read', () => {
  assert.match(renderDigest(st({ cards: [] }), 0), /class="empty">NOTHING DONE IN THE LAST 24H/); assert.match(renderDigest(baseState({ digest: null }), 0), /READING DIGEST/);
});
test('offline: the last digest stays with its ages', () => { const html = renderDigest(st({}, { daemonConnected: false }), 0); assert.match(html, /class="conn"[\s\S]*class="dgage">12m</); });
test('lamp and label come from the Mac\'s live session; a missing one is ENDED', () => { /* busy → lamp busy, WORKING; missing, or only a machine: 'NucBox' session with that id → lamp idle, ENDED */ });
test('NEW marks cards that changed after the screen was last seen', () => { /* lastTurnTs 100: seenTs 50 → NEW; seenTs 200 → none */ });
test('selection follows the session id across a re-sort, and the knob clamps', () => {
  const [a, b, c] = ['a', 'b', 'c'].map((id) => card({ sessionId: id }));
  assert.equal(selectedIndex([c, a, b], 'b'), 2); assert.equal(moveSelection([a, b, c], 'c', 1), 'c'); assert.equal(moveSelection([a, b, c], null, 1), 'b');
});
test('press opens a live session; an ended one says SESSION ENDED', () => {
  assert.deepEqual(pressTarget(st({}, { sessions: [{ id: 'a', state: 'idle', ended: false }] }), 'a'), { open: 'a' });
  assert.deepEqual(pressTarget(st({}), 'gone'), { toast: 'SESSION ENDED' });
  assert.deepEqual(pressTarget(st({}, { sessions: [{ id: 'a', state: 'idle', ended: false, machine: 'NucBox' }] }), 'a'), { toast: 'SESSION ENDED' });
  assert.equal(findCard(st({}, { details: { a: { machine: 'NucBox' } } }), 'a'), null);   // card() defaults to sessionId 'a'
});
test('the column keeps the selected card on screen', () => { /* 10 cards, digestSel = id 8 → no ids 0–4 in the markup; id 8 is the .dgcard */ });
test('card text is escaped and nothing alerts', () => {
  const s = st({ cards: [card({ title: '<img src=x>' })] }); const html = renderDigest(s, 0) + renderFleetCard(s, false);
  assert.ok(!html.includes('<img')); assert.doesNotMatch(html, /blocked|edge|breathe/);
});
test('the fleet line counts the window and leaves out zero commits and PRs', () => {
  assert.equal(digestFleetLine({ windowHours: 24, totals: { sessions: 6, turns: 19, commits: 7, prs: 1, testRuns: 3 } }), 'LAST 24H · 6 SESSIONS · 19 TURNS · 7 COMMITS · 1 PR');
  assert.equal(digestFleetLine({ windowHours: 24, totals: { sessions: 1, turns: 1, commits: 0, prs: 0, testRuns: 0 } }), 'LAST 24H · 1 SESSION · 1 TURN');
});
test('first-card rows: the newest three, the live lamp, the reply quoted, else the first fact line', () => {
  const rows = fleetCardRows(st({ cards: ['a', 'b', 'c', 'd'].map((id) => card({ sessionId: id, title: 'T ' + id, lastReply: id === 'b' ? '' : 'Done.', lines: ['PR #14'] })) }, { sessions: [{ id: 'a', state: 'busy', ended: false }] }));
  assert.deepEqual(rows.map((r) => r.id), ['a', 'b', 'c']); assert.deepEqual([rows[1].lamp, rows[1].text], ['idle', 'PR #14']);
  assert.deepEqual(rows[0], { id: 'a', lamp: 'busy', title: 'T a', text: '"Done."', age: '12m' });
});
test('the first card: fleet line, rows, PRESS TO OPEN, one tap target; nothing without cards', () => {
  const html = renderFleetCard(st({ cards: [card({ lastReply: 'Done.' })] }), true);
  assert.match(html, /^<div class="dgfirst selected" data-action="digest-card"><div class="dgfhead">DIGEST<\/div><div class="dgffleet">LAST 24H · /);
  assert.match(html, /class="dgftext">&quot;Done\.&quot;<[\s\S]*class="dghint">PRESS TO OPEN</);
  assert.equal((html.match(/data-action=/g) || []).length, 1); assert.doesNotMatch(html, />NEW</);
  assert.equal(renderFleetCard(st({ cards: [] }), false), ''); assert.equal(renderFleetCard(baseState({ digest: null }), false), '');
});
// digest-css.test.js reads src/styles.css. digestRules(css): the text of every rule whose selector has .dg, .dstrip, .dcard
// or .adigest; digestFontSizes(css): [selector, px] for each font-size in those rules; fontSizeOf(css, sel): the px in sel's rule.
const GLANCE = ['.dgtitle', '.dgreply', '.dgline', '.dgsub', '.dgftitle', '.dgftext'];   // Task 13 adds '.dstext' and '.adigest'
test('digest type is never under 14px, and glance text never under 19px', () => {
  for (const [sel, px] of digestFontSizes(css)) assert.ok(px >= 14, sel);
  for (const sel of GLANCE) assert.ok(fontSizeOf(css, sel) >= 19, sel);
});
test('digest rules use no gap, inset or clamp, and no warn or danger colour', () => {
  assert.doesNotMatch(digestRules(css), /(^|[;{\s])(gap|inset)\s*:|clamp\(|--warn|--danger/);
});
test('digest lamps are static, on the list and on the first card', () => { for (const re of [/\.digest \.lamp[^{]*\{[^}]*animation:\s*none/, /\.dgfirst \.lamp[^{]*\{[^}]*animation:\s*none/]) assert.match(css, re); });
test('fmtAge', () => { assert.deepEqual([30e3, 12 * 60e3, 2 * 3600e3, 50 * 3600e3].map(fmtAge), ['now', '12m', '2h', '2d']); });   // helpers.test.js
```

- [ ] **Step 2: Run to verify they fail.** `node --test panel/test/digest.test.js panel/test/digest-css.test.js panel/test/helpers.test.js` → FAIL (`ERR_MODULE_NOT_FOUND`; `fmtAge` is not a function).
- [ ] **Step 3: Implement `screens/digest.js`, `fmtAge` and the CSS section.**
- [ ] **Step 4: Run to verify they pass.** `npm --prefix panel test` → PASS.
- [ ] **Step 5: Commit.** `git add panel/src/screens/digest.js panel/src/screens/helpers.js panel/src/styles.css panel/test/digest.test.js panel/test/digest-css.test.js panel/test/helpers.test.js && git commit -m "feat(panel): the Digest list with facts-only cards, and the first card's parts"`

### Task 12: Panel wiring — NEW, top-bar section, store, socket, input

**Files:** Create `panel/src/digest-seen.js`, `panel/test/digest-seen.test.js`; Modify `panel/src/display.js`, `panel/src/shell.js`, `panel/src/store.js`, `panel/src/ws-mux.js`, `panel/src/ws.js` (header comment), `panel/src/main.js`, `README.md`; Test `panel/test/display.test.js`, `panel/test/shell.test.js`, `panel/test/ws-mux.test.js`. `main.js` has no unit tests; its wiring is checked by the build and Task 15's simulator run.

**Interfaces:**
- Consumes: `renderDigest`, `digestCards`, `selectedIndex`, `moveSelection`, `pressTarget` (Task 11); `claude.digest.get`, `claude.digest.update` (Task 9); `now` (`clock.js`, Mac time); `PRIMARY_ONLY` and `createMux`'s routing (`ws-mux.js`).
- Produces: `digest: 1` in `SECTIONS`, the Agents section (on `main`: Tasks 0, Agents 1, queue 2, house 3); `AGENTS_CYCLE` stays `{ list: '#/usage', usage: '#/nucbox', nucbox: '#/list' }` for preset 2, since the digest is reached from the sessions screen's first card (Task 14); `'claude.digest.update': 1` in `PRIMARY_ONLY`; store fields `digest: null`, `digestSel: null`; `display.isLit() -> boolean` (new: `display.js` keeps `lit` private); `SEEN_MIN_MS = 5000` and `createDigestSeen({ storage, now }) -> { tick(onScreen, lit), seenTs() }`, storage key `'digestSeenTs'` (a throwing storage keeps the value in memory).
- NEW rule: a visit is a run of ticks with `onScreen && lit`; when a visit of at least `SEEN_MIN_MS` ends, `seenTs` becomes the end time. It holds still during a visit, so NEW tags stay readable while the screen is up.
- **The digest is the Mac's.** `ws.js` links to the Mac's service and, with `PANEL_CONFIG.nucboxSessions`, to the NucBox's copy of the same service; `ws-mux.js` merges them. `mux.request` sends any method that is not a list, a watch, or in `BY_SESSION` / `BY_ASK` to `links[primary]`, so `claude.digest.get` reaches the Mac alone and fails `socket not open` while it is away; the NucBox is never asked (today's NucBox code would answer `Unknown method`). Events pass from every host unless `PRIMARY_ONLY` names them, so `claude.digest.update` joins `claude.usage.update` there: a NucBox running this branch's service would otherwise replace the Mac's digest with its own. `onOpen` / `onClose` follow the Mac's link only, so the digest is fetched on every Mac (re)connect and never for the NucBox.

- [ ] **Step 1: Write the failing tests.** In `digest-seen.test.js`, `make()` builds `createDigestSeen` on a fake clock and an in-memory storage and returns `{ seen, clock, visit(ms) }`; `visit(ms)` ticks `(true, true)` once a second for `ms`, advancing the clock, then ticks `(false, true)` once.

```js
test('2 still cycles sessions, usage, NucBox with no digest stop, and goes to the list from anywhere else', () => {   // shell.test.js
  assert.deepEqual(['list', 'usage', 'nucbox'].map((r) => presetTarget('2', r, false)), ['#/usage', '#/nucbox', '#/list']);
  for (const r of ['home', 'session', 'digest', 'queue', 'tasks']) assert.equal(presetTarget('2', r, false), '#/list', r);
});
// and in 'the top bar dots…': for (const r of ['list', 'session', 'agent', 'digest', 'usage', 'nucbox']) assert.equal(sectionOf(r), 1, r);
test('the digest is the Mac\'s: the request goes to the Mac and a NucBox digest event is dropped', async () => {   // ws-mux.test.js
  const { mux, links } = setup({ mac: { ...MAC, 'claude.digest.get': { cards: [{ sessionId: 'm1' }] } }, nucbox: NUC });
  const from = []; mux.on('claude.digest.update', (d, f) => from.push(f.host));
  links.mac.open(); links.nucbox.open(); await tick();
  assert.deepEqual((await mux.request('claude.digest.get', {})).cards, [{ sessionId: 'm1' }]);
  links.nucbox.event('claude.digest.update', { cards: [] }); links.mac.event('claude.digest.update', { cards: [] });
  assert.deepEqual(from, ['mac']); assert.ok(!links.nucbox.asked.some((a) => /digest/.test(a.method)));
});
test('with only the NucBox up the digest request fails and the NucBox is not asked', async () => {
  const { mux, links } = setup({ mac: MAC, nucbox: NUC }); links.nucbox.open(); await tick();
  await assert.rejects(mux.request('claude.digest.get', {}), /socket not open/);
  assert.ok(!links.nucbox.asked.some((a) => /digest/.test(a.method)));
});
test('isLit follows the screen', async () => {   // display.test.js, with its lit() and dark() helpers
  assert.equal((await lit({}, ON)).d.isLit(), true); assert.equal((await dark({})).d.isLit(), false);
});
test('nothing seen yet is 0, so every card starts NEW', () => { assert.equal(make().seen.seenTs(), 0); });   // digest-seen.test.js
test('a visit of 5 s or more marks the moment it ended; a shorter one does not', () => {
  const h = make(); h.visit(4000); assert.equal(h.seen.seenTs(), 0); h.visit(6000); assert.equal(h.seen.seenTs(), h.clock.t);
});
test('a dark screen is not a visit', () => { /* tick(true, false) for 10 s, then leave → still 0 */ });
test('seenTs survives a reload through storage, and a throwing storage still works', () => {
  /* after a 6 s visit, a second createDigestSeen on the same storage reads the same seenTs; with getItem/setItem throwing, tick and seenTs still work */
});
```

- [ ] **Step 2: Run to verify they fail.** `node --test panel/test/shell.test.js panel/test/display.test.js panel/test/digest-seen.test.js panel/test/ws-mux.test.js` → FAIL (`sectionOf('digest')` is -1; `isLit` is not a function; module missing; the NucBox's digest frame is delivered). The cycle test and the NucBox-only test pass already and pin today's routing; `ws-mux.test.js`'s existing 'only the Mac speaks for the Mac' pins `onOpen` / `onClose` to the Mac's link.
- [ ] **Step 3: Implement.** Add `isLit: function () { return lit; }` to `createDisplay`'s returned object; write `digest-seen.js`. In `shell.js`, only `digest: 1` in `SECTIONS`, beside `list`, `session`, `agent`, `usage` and `nucbox`; the cycle and its header comment stay. In `main.js` (import `now` from `./clock.js`; `main.js` imports nothing from it yet):
  - **render:** `r.name === 'digest'` → `renderDigest(state, digestSeen.seenTs())`; add `'digest'` to the 15 s re-render routes.
  - **dial:** `store.update({ digestSel: moveSelection(digestCards(state), state.digestSel, dir) })`. **select:** with cards, `pressDigest(cards[selectedIndex(cards, state.digestSel)].sessionId)`. **tap `digest-row`:** an unselected row becomes the selection; the selected card is pressed. **back:** `digest` → `#/list`, named beside `usage` (the final `else` already goes there).
  - **`pressDigest(id)`:** `var t = pressTarget(store.get(), id); if (t.open) openSession(t.open); else toast(t.toast);`.
  - **socket:** in `ws-mux.js`, `'claude.digest.update': 1` in `PRIMARY_ONLY`; in `ws.js`'s header, the digest beside usage in both lists (requests that go to the Mac; the Mac's own events). In `main.js`, `ws.on('claude.digest.update', function (d) { daemonAlive(); store.update({ digest: d }); })` (only Mac frames reach it, so `daemonAlive` is right, as for usage); in the `ws.onOpen` handler, beside `claude.usage.get`: `ws.request('claude.digest.get', {}).then(function (d) { store.update({ digest: d }); }).catch(function () {});`. A Mac service without the digest answers `Unknown method` and `digest` stays null, so the list is today's. `ws.onClose` leaves `digest` alone: offline, the card and the list keep the last digest and its ages under the banner. With only the NucBox connected nothing asks, so `digest` stays null (no first card) or keeps the last Mac digest.
  - **seen:** `var digestSeen = createDigestSeen({ storage: window.localStorage, now: now })`; `setInterval(display.tick, 1000)` becomes `setInterval(function () { display.tick(); digestSeen.tick(route().name === 'digest', display.isLit()); }, 1000)`.
  - Leave `surface()`, the edge logic and the `display.asks` subscription untouched.

  In `README.md`, the controls row's `2 Agents (again: usage, NucBox)` reads `2 Agents (again: usage, NucBox; the digest is the first card on the sessions screen)`, and a short "The digest" section says what it shows (the Mac's sessions only), that pressing the first card opens the full list, that it is facts-only until the NucBox summarizer (later plans), the 24 h window and 20 cards, that `.state/digest.json` is written at 0600, and that `CLAUDE_PANEL_DIGEST=0` turns it off.
- [ ] **Step 4: Run to verify they pass.** `npm --prefix panel test && npm --prefix panel run build` → PASS, and the build succeeds.
- [ ] **Step 5: Commit.** `git add panel/src/digest-seen.js panel/src/display.js panel/src/shell.js panel/src/store.js panel/src/ws-mux.js panel/src/ws.js panel/src/main.js panel/test/digest-seen.test.js panel/test/display.test.js panel/test/shell.test.js panel/test/ws-mux.test.js README.md && git commit -m "feat(panel): #/digest fed by the Mac's claude.digest.*, in the Agents section, with NEW kept on the panel"`

### Task 13: Session strip, session card and the ambient line

**Files:** Modify `panel/src/screens/digest.js`, `panel/src/screens/session-detail.js`, `panel/src/screens/ambient.js`, `panel/src/styles.css`; Test `panel/test/digest.test.js`, `panel/test/screens.test.js` (append).

**Interfaces:**
- Consumes: `findCard`, `liveOf`, `fmtAge` (Task 11).
- Produces:
  - `sessionStrip(state, id) -> string`: `''` unless the card has a summary or a `lastReply`; else `.dstrip` (40 px): a static 14 px lamp in the detail's state, `.dstext` (20 px `--bone`, one line) with `"<lastReply>"`, `.dsage` (mono 16 `--muted`).
  - `sessionCard(state, id) -> string`: `''` without a card; else `.dcard` with `.dchead` `FACTS · <age>` (16 caps `--text-2`), then the reply line and the fact lines as on the digest card.
  - `ambientLine(state) -> string`: `''` while `state.asks.length`, with no cards, or when the newest card is 12 h old or more; else `<div class="adigest">` with `<age> · <title> — "<lastReply>"` cut to 64 characters plus `…`, Chakra Petch 500 20 px `--text-3`, one line.
- Placement (both read `findCard`, so a NucBox session's view, whose detail carries `machine`, gets neither): `renderDetail` puts `sessionStrip` between the topbar and `#dscroll`, and `sessionCard` right after `renderConversation(…)`, so after `#cvend` and before the "Open in VS Code" rows, one knob tick past the newest message. `renderAmbient` puts `ambientLine` after the `.fleet` lamps; it isn't tappable, since the whole ambient surface stays the mascot toggle.

- [ ] **Step 1: Write the failing tests.** Helpers: `withCard(over)` is a state whose digest holds one 12-minute-old card for session `a`, live in `sessions`; `detailState(over)` adds `details.a` and `messages.a` for `renderDetail`; `ambientState(over)` is ambient's base state with one card titled "Panel brightness tuning", `ageMs` 12 minutes by default. In `digest-css.test.js`, add `'.dstext'` and `'.adigest'` to `GLANCE`.

```js
test('the session strip shows the last reply and age, and is absent without one', () => {
  assert.match(sessionStrip(withCard({ lastReply: 'Done.' }), 'a'), /class="dstrip".*&quot;Done\.&quot;.*12m/s);
  assert.equal(sessionStrip(withCard({ lastReply: '' }), 'a'), ''); assert.equal(sessionStrip(baseState({ digest: null }), 'a'), '');
});
test('the session card follows the newest message, before Open in VS Code', () => {
  const html = renderDetail(detailState({ lastReply: 'Done.', lines: ['1 commit: fix: x'] }), 'a'); const at = (s) => html.indexOf(s);
  assert.ok(at('id="cvend"') < at('class="dcard"') && at('class="dcard"') < at('Open in VS Code')); assert.match(html, /FACTS · 12m/);
});
test('the ambient line shows the newest card, and hides while anything waits or when nothing finished in 12 h', () => {
  assert.match(renderAmbient(ambientState()), /class="adigest">12m · Panel brightness tuning — &quot;/);
  assert.doesNotMatch(renderAmbient(ambientState({ asks: [{ id: 'k' }] })), /adigest/);
  assert.doesNotMatch(renderAmbient(ambientState({ ageMs: 13 * 3600e3 })), /adigest/);
  const text = ambientLine(ambientState({ lastReply: 'x'.repeat(200) })).replace(/<[^>]+>/g, '').replace(/&quot;/g, '"');
  assert.ok(text.length <= 65);
});
```

- [ ] **Step 2: Run to verify they fail.** `node --test panel/test/digest.test.js panel/test/screens.test.js` → FAIL (`sessionStrip` is not exported).
- [ ] **Step 3: Implement** the three functions, the two insertions and the `.dstrip`, `.dcard`, `.adigest` CSS within Task 11's rules.
- [ ] **Step 4: Run to verify they pass.** `npm --prefix panel test && npm --prefix panel run build` → PASS, Task 11's CSS tests now covering the new classes.
- [ ] **Step 5: Commit.** `git add panel/src/screens/digest.js panel/src/screens/session-detail.js panel/src/screens/ambient.js panel/src/styles.css panel/test/digest.test.js panel/test/screens.test.js && git commit -m "feat(panel): digest strip and card in the session view, one line on the clock"`

### Task 14: The digest as the first card on the sessions screen

**Files:** Modify `panel/src/screens/session-list.js`, `panel/src/store.js`, `panel/src/main.js`, `panel/src/styles.css` (in the digest section); Create `panel/test/digest-list.test.js`, `panel/test/fixtures/list-state.js`, `panel/test/fixtures/list-before.json`; Test `panel/test/digest-css.test.js` (append).

**Interfaces:**
- Consumes: `hasFleetCard`, `renderFleetCard` (Task 11); the store's `digest` and Task 12's two socket writes; in `session-list.js` `renderList`, the module-level `scrollCol`, `ROWS` 2, `COLS_VISIBLE` 2, `COL_STEP` 380 and the empty text `NO SESSIONS — START CLAUDE ON YOUR MAC OR NUCBOX`; in `main.js` the `dial`, `select` and `tap` handlers, the first `hashchange` listener (the one that calls `render()`; the Home Assistant and Tasks ones stay as they are), `nav` and `openSession`.
- Produces: the store field `onDigestCard: false` (the grid cursor is on the digest card); in `session-list.js`, `cardSelected(state) -> boolean` = `hasFleetCard(state) && (state.onDigestCard === true || !state.sessions.length)`; `listDial(state, dir) -> fields | null`, what the dial writes; `withDigest(state, digest) -> fields`, what a digest snapshot writes; `renderList(state)`, same signature.

**Selection model.** `selectedIndex` keeps today's meaning, always a session index; the flag `onDigestCard` puts the cursor on the card instead. A negative `selectedIndex` was rejected. `applySnapshot` re-finds the cursor through `state.sessions[state.selectedIndex].id` and clamps it, `watchTarget` and the select handler index `sessions` with it, and the dial clamps it at 0. Each would treat `-1` as "no session" only by accident, and a `-1` left behind after the card went away would be a cursor that selects nothing. With the flag those readers stay as they are; only the new code reads it (`renderList`, `listDial`, select, `withDigest` and the `hashchange` listener). `watchTarget` is unchanged: on the card it keeps watching `sessions[selectedIndex]`, one detail stream, as on any tile. The merged list (the Mac's sessions, then the NucBox's, from `ws-mux.js`) changes none of this: `selectedIndex` indexes `state.sessions` whichever machine a tile is on, and "no sessions" means none on either.

| When | Then |
|---|---|
| boot, and every arrival on `#/list` | `onDigestCard` is false (leaving clears it, below): the cursor is on a session tile, as today |
| the dial (`listDial`) | −1 on session 0 with a card → `{ onDigestCard: true }`; +1 on the card → `{ onDigestCard: false, selectedIndex: 0 }`, the first session now, whatever `applySnapshot` did meanwhile; −1 on the card, or no sessions → `null`; anything else → today's `{ selectedIndex: <clamped> }` |
| press on the card; a tap on `data-action="digest-card"` | `nav('#/digest')` |
| leaving `#/list` while on the card | the `hashchange` listener writes `{ onDigestCard: false, selectedIndex: 0 }`, so Back from `#/digest` lands on the first session |
| sessions come or go while on the card (either machine; the NucBox's link coming or going re-sends the merged list) | the card stays selected; `applySnapshot` is unchanged |
| no live sessions, a card | the card alone, selected (derived, nothing stored), with `.dgnote` holding the empty screen's text in column 1; with no card, today's empty screen |
| a snapshot with no cards, or null, while on the card | `withDigest` adds `{ onDigestCard: false, selectedIndex: 0 }`; otherwise it returns `{ digest }` |
| the first digest arrives while on a tile | the tiles move one column right; the same tile stays selected and on screen |

Column maths in `renderList`; with no card `lead` is 0 and every line is today's. The card scrolls out when the cursor reaches the third column (session 2) and comes back when it returns to sessions 0–1 or the card. It is one 372 px grid column, and `.gridtrack .dgfirst { grid-row: 1 / 3 }` gives it both rows: under the 46 px topbar and `.gridwrap`'s padding it measures 372 × 414 at (12, 54).

```
lead = hasFleetCard(state) ? 1 : 0;   onCard = cardSelected(state)
totalCols = lead + ceil(n / ROWS);    selCol = onCard ? 0 : lead + floor(selectedIndex / ROWS)
if (lead && selCol <= 1) scrollCol = 0      // the card is in view on it and beside the first sessions column
then today's clamps: selCol < scrollCol; selCol > scrollCol + COLS_VISIBLE - 1; <= totalCols - COLS_VISIBLE; >= 0
tile i: column lead + floor(i / ROWS); selected when !onCard && i === selectedIndex; `off` as today, by that column
track: renderFleetCard(state, onCard) + tiles, translateX(-scrollCol * COL_STEP)
```

- [ ] **Step 1: Capture today's markup, then write the failing tests.** `fixtures/list-state.js` exports `listState(selectedIndex)` and `noClock(html)`. `listState` gives sessions `a`–`e` in states busy, idle, attention, idle and busy, each with `model: 'claude-opus-5'`, `effort: 'high'` and `context: 0.42`, `e` also with `machine: 'NucBox'` as the mux tags it, plus `details: {}`, `asks: []` and `daemonConnected: true`. `noClock` drops the topbar's `<span class="clock">…</span>`. In the test, `card(over)` is a copy of `digest.test.js`'s factory; `digestOf(cards)` wraps cards in a facts-only `Digest`; `withCard(over)` is `{ ...listState(0), digest: digestOf([card()]), ...over }`; and `reset()` renders an empty list, which sets `scrollCol` back to 0. Before touching `session-list.js`, run from the repo root:

```
node --input-type=module -e "import fs from 'node:fs'; import { renderList } from './panel/src/screens/session-list.js'; import { listState, noClock } from './panel/test/fixtures/list-state.js'; const at = (i) => { renderList({ ...listState(0), sessions: [] }); return noClock(renderList(listState(i))); }; fs.writeFileSync('panel/test/fixtures/list-before.json', JSON.stringify({ sel0: at(0), sel4: at(4) }))"
```

```js
test('with no digest card the grid is byte-identical to before', () => {
  const before = JSON.parse(fs.readFileSync(new URL('./fixtures/list-before.json', import.meta.url), 'utf8'));
  for (const digest of [undefined, null, digestOf([])]) for (const [key, i] of [['sel0', 0], ['sel4', 4]]) {
    reset(); assert.equal(noClock(renderList({ ...listState(i), digest })), before[key], key);
  }
});
test('the card comes first and the cursor starts on the first session; on the card, no tile is selected', () => {
  reset(); const html = renderList(withCard()), on = renderList(withCard({ onDigestCard: true }));
  assert.ok(html.indexOf('<div class="dgfirst" data-action="digest-card">') < html.indexOf('<div class="tile '));
  assert.match(html, /class="tile [^"]*selected[^"]*" data-action="open" data-id="a"/); assert.match(html, /translateX\(-0px\)/);
  assert.match(on, /class="dgfirst selected" data-action="digest-card"/); assert.doesNotMatch(on, /class="tile [^"]*selected/);
});
test('the dial: back from the first session to the card, forward to the first session, nowhere past the card', () => {
  const on = withCard({ onDigestCard: true, selectedIndex: 3 });
  assert.deepEqual([listDial(withCard(), -1), listDial(on, 1), listDial(on, -1)], [{ onDigestCard: true }, { onDigestCard: false, selectedIndex: 0 }, null]);
  assert.deepEqual([listDial(withCard({ selectedIndex: 1 }), -1), listDial(withCard({ selectedIndex: 4 }), 1)], [{ selectedIndex: 0 }, { selectedIndex: 4 }]);
  assert.deepEqual(listDial(listState(0), -1), { selectedIndex: 0 }, 'no card: as today'); assert.equal(listDial(withCard({ sessions: [] }), 1), null);
});
test('sessions start in column 1; the card scrolls out to the right and back beside the first column', () => {
  const at = (i) => Number(/translateX\(-(\d+)px\)/.exec(renderList(withCard({ selectedIndex: i })))[1]);
  reset(); assert.deepEqual([0, 1, 2, 3, 4, 2, 1].map(at), [0, 0, 380, 380, 760, 760, 0]);
  reset(); renderList(withCard({ selectedIndex: 4 })); assert.match(renderList(withCard({ onDigestCard: true })), /translateX\(-0px\)/);
  reset(); assert.match(renderList(withCard({ selectedIndex: 4 })), / off" data-action="open" data-id="a"/);
});
test('sessions coming and going leave the card selected; with none it stands alone beside the empty text', () => {
  for (const n of [5, 1, 0]) assert.equal(cardSelected(withCard({ onDigestCard: true, sessions: listState(0).sessions.slice(0, n) })), true, String(n));
  assert.match(renderList(withCard({ sessions: [] })), /class="dgfirst selected"[\s\S]*class="dgnote">NO SESSIONS — START CLAUDE/);
  assert.match(renderList({ ...listState(0), sessions: [], digest: null }), /class="empty">NO SESSIONS/);
});
test('a digest that loses its cards moves the cursor off the card; one that keeps them does not', () => {
  const on = withCard({ onDigestCard: true, selectedIndex: 3 }), empty = digestOf([]), full = digestOf([card()]);
  assert.deepEqual([withDigest(on, empty), withDigest(on, null), withDigest(on, full)],
    [{ digest: empty, onDigestCard: false, selectedIndex: 0 }, { digest: null, onDigestCard: false, selectedIndex: 0 }, { digest: full }]); assert.deepEqual(withDigest(listState(2), null), { digest: null });
});
test('the first card spans both grid rows and takes the grid\'s own 372 px column', () => {   // digest-css.test.js
  const rule = /\.gridtrack \.dgfirst\s*\{([^}]*)\}/.exec(css)[1];
  assert.match(rule, /grid-row:\s*1 \/ 3/); assert.doesNotMatch(rule, /(^|[;\s])(width|height)\s*:/);
});
```

- [ ] **Step 2: Run to verify they fail.** `node --test panel/test/digest-list.test.js panel/test/digest-css.test.js` → FAIL (`listDial` is not exported; no `.gridtrack .dgfirst` rule). The byte-identical test passes already and stays as the guard.
- [ ] **Step 3: Implement.**
  - `session-list.js`: import `hasFleetCard` and `renderFleetCard` from `./digest.js`; one `NO_SESSIONS` string, today's text, for both empty paths; the column maths above. With no sessions: `scrollCol = 0`; without a card, return today's empty screen; with one, the topbar without a count and `.gridwrap` > `.gridtrack` (`translateX(-0px)`) holding `renderFleetCard(state, true)` and `<div class="dgnote">` + `NO_SESSIONS` + `</div>`.
  - `store.js`: `onDigestCard: false` beside `selectedIndex`.
  - `main.js`: **dial** on `list`: `var lf = listDial(state, dir); if (lf) store.update(lf);`. **select** on `list`: `if (cardSelected(state)) nav('#/digest');`, else today's `openSession`. **tap**: `else if (t.action === 'digest-card') nav('#/digest');`. In the **`hashchange`** listener, before `render()`: `if (route().name !== 'list' && store.get().onDigestCard) store.update({ onDigestCard: false, selectedIndex: 0 });`. Task 12's two `store.update({ digest: d })` become `store.update(withDigest(store.get(), d))`. **Back** is unchanged: from the list, on the card or not, it goes to ambient. The card's ages refresh with the list's existing 15 s re-render.
  - `styles.css`: `.gridtrack .dgfirst { grid-row: 1 / 3; }`; `.dgnote { grid-row: 1 / 3; display: flex; align-items: center; justify-content: center; text-align: center; padding: 0 24px; font-weight: 700; font-size: 22px; letter-spacing: 0.16em; line-height: 1.4; color: var(--dim); }`. Task 11's CSS tests cover both, since their selectors hold `.dg`.
- [ ] **Step 4: Run to verify they pass.** `npm --prefix panel test && npm --prefix panel run build` → PASS, `screens.test.js`'s grid tests included.
- [ ] **Step 5: Commit.** `git add panel/src/screens/session-list.js panel/src/store.js panel/src/main.js panel/src/styles.css panel/test/digest-list.test.js panel/test/digest-css.test.js panel/test/fixtures/list-state.js panel/test/fixtures/list-before.json && git commit -m "feat(panel): the digest is the first card on the sessions screen"`

### Task 15: Demo data and the simulator check

**Files:** Modify `mac-service/src/sessions/source-mock.js`, `mac-service/src/sessions/index.js`, `mac-service/src/index.js`; Test `mac-service/test/source-mock.test.js` (append).

**Interfaces:**
- Consumes: `MOCK_DIR`, `MOCK_PROJECTS_DIR` (Task 9); `createDigest` (Task 8).
- Produces: `startMockSource({ store, permissionBridge, queue, dir = MOCK_DIR, onStop })`; `createSources({ store, permissionBridge, queue, onMockStop })`; in `index.js`, `onMockStop: (id, file) => digest && digest.onHook('Stop', { session_id: id, transcript_path: file })`.
- Behaviour: `SIM_DEMO=1` already sets `CLAUDE_THING_MOCK=1` (`simulator/scripts/run.js`). Transcripts move to `<dir>/projects/<name>/<id>.jsonl` (subagent folders follow). `conversation()` is replaced by demo turns in the spec's record shapes, each ending `end_turn` plus a stop summary, with `lastTurnTs` spread from 3 minutes to 5 hours ago. The churn's every-7th stop appends one human turn and a stop summary, then calls `onStop`. Real hooks reaching a demo service are ignored by the digest, since their transcripts are outside `MOCK_PROJECTS_DIR`.

| Session | Shows |
|---|---|
| 0 (churns, WORKING) | edits, `Tests: 41 passed, 0 failed`, a commit with its subject, then a `none` continuation turn |
| 1 (mock questions go here, ATTENTION) | `Tests: failed` (is_error, no count) and a failing `ls` |
| 2 (DONE) | `Tests: ran, outcome not reported`, a heredoc commit, a `-F` commit (`message not read`), `PR #14` |
| 3 | a human turn, then a turn started by a task notification |
| 11 (22 subagents) | `N agents finished: …` |
| transcript-only `ended-recent` (2 h ago) | ENDED lamp; `SESSION ENDED` on press |
| transcript-only `ended-old` (30 h ago), `notify-only` | never shown |

- [ ] **Step 1: Write the failing test**

```js
test('demo transcripts make facts-only cards in every state the panel can show without a model', async () => {
  const store = createStore(); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-'));
  const src = startMockSource({ store, permissionBridge: null, queue: null, dir });
  const d = createDigest({ emit() {}, projectsDir: path.join(dir, 'projects'), isLive: (id) => !!store.raw(id), readDelayMs: 0 });
  await d.start(); await d.whenIdle(); src.stop();
  const cards = d.get().cards; const lines = cards.flatMap((c) => c.lines).join('\n');
  assert.equal(cards.length, 13, '12 live sessions and ended-recent');
  assert.ok(cards.some((c) => c.ended) && !cards.some((c) => /ended-old|notify-only/.test(c.sessionId)));
  for (const re of [/Tests: 41 passed, 0 failed/, /Tests: failed/, /outcome not reported/, /message not read/, /PR #14/, /agents finished/]) assert.match(lines, re);
});
```

- [ ] **Step 2: Run to verify it fails.** `node --test mac-service/test/source-mock.test.js` → FAIL (`cards.length` is 0).
- [ ] **Step 3: Implement** the demo turns and the `onStop` plumbing.
- [ ] **Step 4: Verify.** Root `npm test` → every suite passes. Then run a demo copy on other ports beside whatever the owner runs. Never stop the owner's service (8790) or simulator (8091), and never use `npm run sim` (`simulator/scripts/run.js`): it runs `pkill -f` on the shared profile `~/.cache/claude-panel-simulator-chrome`, closing the owner's simulator window, and reuses or starts a service on 8790. `SIM_DEMO=1` also starts the demo house on 8124 and 8125 and the demo tasks service on 8126; if any is taken, ask the owner rather than stop anything. The demo service must admit the page's origin (`lan-auth.js` lets a tokenless loopback page in only from `SIM_PORT`'s origin, 8091 unless set, or `CLAUDE_PANEL_ORIGINS`), and the simulator must not hand the panel the owner's NucBox session service (`/panel-config.js` reads `~/.config/claude-panel/nucbox-sessions.json` unless `CLAUDE_PANEL_NUCBOX_SESSIONS_CONFIG` points elsewhere, as `smoke.js` does), so the mux links to the Mac mock alone. From the worktree root, with `$SCRATCH` the scratch directory:

```
npm --prefix panel run build
CLAUDE_THING_PORT=18790 CLAUDE_THING_MOCK=1 CLAUDE_PANEL_BIND=127.0.0.1 CLAUDE_PANEL_ORIGINS=http://127.0.0.1:18091 CLAUDE_THING_PID_FILE="$TMPDIR/dg-sim.pid" node mac-service/src/index.js &
SIM_DEMO=1 SIM_PORT=18091 SIM_SERVICE_PORT=18790 EMU_CDP_PORT=19223 SIM_NO_PIDFILE=1 CLAUDE_PANEL_NUCBOX_SESSIONS_CONFIG="$SCRATCH/none.json" node simulator/src/index.js &
open -na "Google Chrome" --args --app=http://127.0.0.1:18091/__emulator__/ --user-data-dir="$SCRATCH/sim-chrome" --remote-debugging-port=19223 --force-device-scale-factor=1 --window-size=1210,711
```

  Drive the faceplate over CDP on `127.0.0.1:19223` (the page whose URL starts with `http://127.0.0.1:18091/__emulator__/`) with the simulator's keys (← → dial, Enter press, Esc Back, 2 the Agents preset). The demo tasks make the panel boot on `#/tasks`; press 2 for the sessions screen. Set hashes on `document.getElementById('screen').contentWindow`, save `Page.captureScreenshot` PNGs to the scratch directory, and on each screen evaluate this, expecting `[]`:

```js
(() => { const d = document.getElementById('screen').contentDocument, bad = [];
  for (const el of d.querySelectorAll('.dgfirst *, .digest *, .dstrip *, .dcard *, .adigest'))
    if ([...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && parseFloat(getComputedStyle(el).fontSize) < 14) bad.push(el.className);
  return bad; })()
```

  Then check. **The first card:** **(a)** on `#/list` it is at the left, `.dgfirst`'s `getBoundingClientRect()` is `{ left: 12, top: 54, width: 372, height: 414 }` with `scrollHeight <= clientHeight`, it shows `LAST 24H · …`, three rows and `PRESS TO OPEN`, and the first session's tile is the selected one; **(b)** one tick back selects the card (`.dgfirst.selected`, no `.tile.selected`) and one forward returns to the first session, and walking right scrolls the card out while coming back to the first column brings it in; **(c)** press on the card, and a tap on it, open `#/digest`, and Back returns to `#/list` with the first session selected; **(d)** preset 2 goes list → usage → NucBox → list with no digest stop, and from `#/digest` to the list; on `#/digest` the top bar's second dot (Agents) is the lit one.
  **The list and the rest:** **(e)** on `#/digest` the strip reads `LAST 24H · … · FACTS ONLY`, one card is expanded and the rest collapsed, nothing overflows 800×480, the knob walks the cards, a churn stop moves a card to the top within about 15 s with the cursor staying on its session, and NEW tags show on the first visit and clear after 5 s on screen and leaving; **(f)** press opens a live session with the strip under the topbar, one knob tick past the newest message shows the `FACTS · …` card, and `ended-recent` toasts `SESSION ENDED`; **(g)** the top button goes to ambient, which shows the one-liner; when the mock question arrives, the edge pulses over the sessions screen and the digest and neither page moves, and on ambient the line disappears while it waits; **(h)** no digest lamp moves, on the card or the list; **(i)** stopping the demo service shows the offline banner with the card, the list and the ages still there.
  Screenshot the sessions screen with the card, the digest, the session view and ambient. Then stop only what this step started: the service in `$TMPDIR/dg-sim.pid`, the simulator server, and the Chrome on `$SCRATCH/sim-chrome`.
- [ ] **Step 5: Commit.** `git add mac-service/src/sessions/source-mock.js mac-service/src/sessions/index.js mac-service/src/index.js mac-service/test/source-mock.test.js && git commit -m "feat(simulator): demo digest cards in every facts-only state"`

---

## Later plans

None of these change the protocol.

- **Plan 2 (Milestone 2):** the LM Studio client and the `digest-v1` prompt; the sheet text (a line per fact, the 12,000-char cap, oldest turns dropped first); the validator, reusing `redact()` on the model's output; the golden set (`.state/digest-golden/`, 0600) and its harness.
- **Plan 3 (Milestone 3):** the queue, the 60 s / 10 min debounce, rate caps, backoff and the sheet-hash cache; `summary` and `behindTurns` filled in, with `+N TURNS` on the panel; the strip states `SUMMARIES · NUCBOX`, `NUCBOX OFFLINE · FACTS ONLY` and `MODEL NOT LOADED · FACTS ONLY`; `~/.config/claude-panel/digest.json` and its permission warning; the permission and question timing check during a summary request; `scripts/digest-review.js`. The first card's rows then show the headline (`fleetCardRows`). A candidate, not decided: an idle or finished session tile's subline shows its headline in place of the last message (this plan leaves tiles alone, since the subline holds about 26 characters and facts-only text would repeat the last message). The `feat/queue-inbox` branch's `inbox.attachSummary(sessionId, turnEndTs, { headline, bullets })` (`mac-service/src/inbox.js`) is where the same model summaries attach to queue cards, landing only on the card for that turn.
- **Milestone 0** (beside this plan): `scripts/lmstudio-probe.js`, and under (b) `nucbox/digest-relay.js` with its own install and uninstall names, built on this branch, now rebased onto `main` with the NucBox work (the NucBox session declined it), each NucBox change approved by the owner first.
- **Seams left here:** `Digest.summarizer`, `DigestCard.summary` and `behindTurns` exist now; `SessionFacts` keeps stable ids P/R/F/C/G/T/X/Q (with `A` in `AgentFacts` and totals in S1–S5 order), so a sheet prints from stored facts; `Turn.trigger` and `intent` carry the continuation flag; `createDigest` is where a `summarizer` option plugs in; the panel's strip takes any `summarizer.state`; capping `claude.digest.get` for Bluetooth relay roles waits until a relay asks.
