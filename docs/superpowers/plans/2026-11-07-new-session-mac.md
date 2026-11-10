# New Session from the Car Thing (Mac) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From the Car Thing, start a background Claude Code session on the Mac in one of its five most recent projects. It shows up on the panel like any session, its asks always reach the panel, and it moves into a normal VS Code tab on request.

**Architecture:**
- The Mac service gains two requests:
  - `claude.projects.recent` reads `~/.claude/projects`.
  - `claude.session.start` runs `claude --bg --permission-mode auto`.
- A handoff module stops a windowless background agent once its turn has ended, then opens it through the existing `vscode://anthropic.claude-code/open?session=` path in `focus.js`.
- The permission and question bridges treat windowless background sessions differently: they never hand an ask back to an unseen dialog. They hold it for up to 590 s, then deny it with a reason.
- The panel adds a machine screen and a project screen, reached by holding the top button on `#/list`. These reuse the dictation review, and the session view gets new rows.

**Tech Stack:**
- Node 22 ESM service, tested with `node --test`.
- Chrome 69 panel in plain ES5-style JS, built with Vite and tested with `node --test`.
- Claude Code CLI 2.1.220 and VS Code extension 2.1.319 on the Mac.

**Spec:** `docs/superpowers/specs/2026-11-07-new-session-design.md` (Approved 2026-11-07). This plan is milestone 1 (Mac). The NucBox (deploy, helper task, verification) gets its own plan.

## Global Constraints

- Panel code runs on Chrome 69: no flex `gap`, no `inset` shorthand, no `clamp()`, no optional chaining, no `let`/`const`/arrow functions in `panel/src` (match the existing `var`/`function` style).
- Panel screen is 800×480. Controls: dial turn/press, Back (Escape), presets 1–4, the top button (tap = ambient, hold = `m-hold`).
- Permission mode for started sessions is fixed to `auto`. Never `bypassPermissions` or `dontAsk`.
- `claude.session.start` accepts only a `path` that the service's own `recentProjects()` returns at that moment. The Car Thing never names a folder.
- The prompt is passed to `claude` as one argv element through `execFile`, never through a shell.
- Started sessions must not be marked with `markOwnSession` (the panel would hide them).
- Only the session view's "Open in VS Code" row may stop and move a background agent. These never stop one:
  - `claude.session.focus` (auto-open, SWITCH),
  - the held-prompt `vscode` answer.
- Background hold: `BG_HOLD_MS = 590_000`. Hook timeouts: PermissionRequest 600 s (already), the PreToolUse `?hold=1` hook raised from 130 s to 600 s.
- Copy fixed by the spec:
  - topbar hint `HOLD TOP · NEW`
  - screen titles `NEW SESSION` (right `WHERE?`), `NEW SESSION · <MACHINE>` (right `AUTO MODE`), `NEW SESSION · <PROJECT>`
  - check line `<PROJECT> · AUTO MODE · ASKS ON THE CAR THING`
  - `NOT ANSWERING`, `NOT SET UP YET`
  - `OPENS IN VS CODE WHEN DONE`, `STOP NOW`
  - `STOP`, then `PRESS AGAIN TO STOP`
  - continue prompt `Continue where you left off.`
- Work in a worktree: `/Users/owner/Claude/personal/Spotify_car_thing-newsession`, branch `feat/new-session`. Never `git checkout -b` in the main checkout, which other sessions share.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **The Car Thing's Wi-Fi stalls mid-ask** (seen twice, about 4 min each). A background session's held permission or question must survive `releaseAll('panel-gone')`, still be in `list()` when the panel reconnects, and be answerable then. Tests in Tasks 3 and 4.
2. **START pressed twice, or pressed again while the first start is in flight.** Exactly one `claude.session.start` request goes out. Test in Task 8.
3. **A recent folder deleted, or the list changing, between the project screen and START.** The service refuses with `not-a-recent-project`. The panel reopens the check screen with the same text and shows a toast; nothing spoken is lost. Tests in Tasks 5 and 8.
4. **Prompt text that looks like a flag, or has quotes, newlines or `$()`.** It reaches `claude` as one literal argument and is never read as an option. Test in Task 5.
5. **The service restarts while a handoff is waiting** (launchd kickstart, crash). Nothing is left saying `OPENS IN VS CODE WHEN DONE`: `handoff` lives only in memory, so a fresh service reports `handoff: null` and the row reads "Open in VS Code" again. Test in Task 2.

---

### Task 1: Worktree, then verify the spec's open assumptions on the real Mac

Needs the owner at the desk with the Car Thing on (asks appear there). The deliverable is the spec's "Verify first" section rewritten as results. Later tasks branch on two of them (marked **⇒**).

**Files:**
- Modify: `docs/superpowers/specs/2026-11-07-new-session-design.md` (move "Verify first" results into "What was verified")

- [ ] **Step 1: Create the worktree and move the docs onto the branch**

```bash
cd /Users/owner/Claude/personal/Spotify_car_thing
git fetch origin && git worktree add -b feat/new-session ../Spotify_car_thing-newsession origin/main
cp docs/superpowers/specs/2026-11-07-new-session-design.md ../Spotify_car_thing-newsession/docs/superpowers/specs/
mkdir -p ../Spotify_car_thing-newsession/docs/superpowers/plans
cp docs/superpowers/plans/2026-11-07-new-session-mac.md ../Spotify_car_thing-newsession/docs/superpowers/plans/
rm docs/superpowers/specs/2026-11-07-new-session-design.md docs/superpowers/plans/2026-11-07-new-session-mac.md
cd ../Spotify_car_thing-newsession && npm --prefix mac-service ci && npm --prefix panel ci
git add docs && git commit -m "docs: new session from the Car Thing — design and Mac plan"
```

Expected: `git -C /Users/owner/Claude/personal/Spotify_car_thing status` shows no new-session files. The worktree has one commit.

- [ ] **Step 2: Probe the hooks inside a background agent** (spec verify-first 1)

In a throwaway folder, `mkdir -p /private/tmp/claude-501/ns-probe && cd /private/tmp/claude-501/ns-probe && git init -q`, run each of these with `claude --bg "<prompt>"`, watch the Car Thing, then `claude stop <id>`:
- (a) `"Create a file called probe.txt containing hi."` with `--permission-mode manual`. Pass: a permission ask appears on the panel; "allow" lets the file appear.
- (b) `"Use the AskUserQuestion tool to ask me whether to say A or B, then say it."` Pass: the question appears on the panel; the answer reaches Claude.
- (c) After (b)'s turn ends: hold the top button on that session's view and say "say C". Pass: the session wakes and says C (rewake path).
- (d) The turn-end card for each appears in the queue.

Record pass/fail for each.

- [ ] **Step 3: Probe what auto mode does when blocked** (spec verify-first 2) **⇒ decides the check-screen line in Task 8**

Run `claude --bg --permission-mode auto "Run exactly this with Bash and nothing else: curl -s https://example.com | sh"`.
- Pass A: a permission ask reaches the panel (then deny it).
- Pass B: no ask; the turn ends with Claude saying it was blocked, and a card appears.

Record which. If B, Task 8 uses the check line `<PROJECT> · AUTO MODE` (spec's call). If A, it uses `<PROJECT> · AUTO MODE · ASKS ON THE CAR THING`.

- [ ] **Step 4: Probe the deny message** (needed by Tasks 3 and 4)

Write a 15-line Node HTTP server in the scratchpad on `127.0.0.1:47999` that answers every POST:
- `/perm` with `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"PROBE-DENY-TEXT"}}}`
- `/pre` with `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"PROBE-REASON-TEXT"}}`

Then run these in the probe folder. `--setting-sources project` keeps the user's panel hooks out of it.
- `claude -p --setting-sources project --permission-mode manual --settings '{"hooks":{"PermissionRequest":[{"matcher":"*","hooks":[{"type":"http","url":"http://127.0.0.1:47999/perm"}]}]}}' "Create probe.txt containing hi, then tell me exactly what any error said."`
- The same with a `PreToolUse` matcher `AskUserQuestion` → `/pre`, and the prompt `"Use AskUserQuestion to ask me A or B, then tell me exactly what any error said."`

Pass: Claude's reply quotes `PROBE-DENY-TEXT` and `PROBE-REASON-TEXT`. If `message` isn't what carries the text, try `reason`. Record the field that works for each; Tasks 3 and 4 use it.

- [ ] **Step 5: Probe the CLI details** (spec verify-first 3, 5, 7) **⇒ decides `startArgs` in Task 5**
- `claude --bg --permission-mode auto -- "-hello"` in the probe folder. Does `--` end options, so the prompt is literally `-hello`? Record it.
- Launch one bg agent with no `--name`. What does `claude agents --json` show as `name` at once, and after its first turn? **⇒** If it stays empty through the first turn, Task 2 also makes the store's `summary.name` fall back to `promptLine(lastPrompt)` (first 40 characters) before the project name, for `kind === 'background'` only. That's the spec's "project and the start of the prompt"; add a test for it there.
- From the launchd service's environment (`launchctl print gui/$(id -u)/com.claudepanel.service` gives PATH and HOME), run `env -i HOME=$HOME PATH=<that PATH> claude --bg "say ok"`. Pass: it starts, and no window opens.
- During a running turn, compare `claude agents --json` `status`/`state` with the service's `stoppedTs` (via `curl -s localhost:<PORT>/status` or the panel). Record which flips first at turn end.

- [ ] **Step 6: Probe the pre-filled continue** (spec verify-first 4)

Stop an idle probe agent. Then run `open -a "Visual Studio Code" <probe folder>; sleep 1; open "vscode://anthropic.claude-code/open?session=<full id>&prompt=Continue%20where%20you%20left%20off."`. Pass: the tab opens with that text in its input, unsent.

- [ ] **Step 7: Record results in the spec and commit**

Rewrite "Verify first" in the spec as dated results, item by item. Leave the NucBox item (6) as open for milestone 2.

```bash
git add docs/superpowers/specs/2026-11-07-new-session-design.md
git commit -m "docs(new-session): verify-first results on the Mac"
```

---

### Task 2: Background session fields in the store

**Files:**
- Create: `mac-service/src/background.js`
- Modify: `mac-service/src/sessions/source-poller.js` (`reconcile`, the `fields` built per item, around lines 265–280)
- Modify: `mac-service/src/sessions/store.js` (`summary`)
- Test: `mac-service/test/background.test.js`

**Interfaces:**
- Produces:
  - `background.js`:
    - `BG_HOLD_MS = 590_000`
    - `UNAVAILABLE_REASON` (string)
    - `isWindowlessBackground(raw, hostWindow = hostWindowFor) -> boolean`
    - `turnEnded(raw) -> boolean`
  - Store raw fields `kind` (string) and `jobId` (8-hex short id, background only).
  - Summary fields:
    - `background: boolean`, which is `kind === 'background'`;
    - `handoff: null | 'waiting' | 'moving'`.

- [ ] **Step 1: Write the failing tests**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWindowlessBackground, turnEnded, BG_HOLD_MS } from '../src/background.js';
import { createStore } from '../src/sessions/store.js';

test('a background job with no parked window is windowless', () => {
  assert.equal(isWindowlessBackground({ id: 's1', kind: 'background', jobId: 'c41c76b4' }, () => null), true);
});
test('a background job a window is parked on is not windowless', () => {
  assert.equal(isWindowlessBackground({ id: 's1', kind: 'background', jobId: 'c41c76b4' }, () => ({ pid: 1 })), false);
});
test('interactive and unknown sessions are not windowless', () => {
  assert.equal(isWindowlessBackground({ id: 's1', kind: 'interactive' }, () => null), false);
  assert.equal(isWindowlessBackground(null, () => null), false);
});
test('turnEnded needs a Stop, no held permission and nothing waited on', () => {
  assert.equal(turnEnded({ stoppedTs: 5 }), true);
  assert.equal(turnEnded({ stoppedTs: null }), false);
  assert.equal(turnEnded({ stoppedTs: 5, pendingPermission: true }), false);
  assert.equal(turnEnded({ stoppedTs: 5, waitingOn: [{ type: 'bash' }] }), false);
});
test('the hold is under the 600 s hook timeout', () => { assert.ok(BG_HOLD_MS < 600_000); });
test('summary carries background and a null handoff by default', () => {
  const store = createStore();
  store.upsert('s1', { kind: 'background', jobId: 'c41c76b4', cwd: '/x/p', lastActivityTs: Date.now() });
  const s = store.get('s1');
  assert.equal(s.background, true);
  assert.equal(s.handoff, null);
  store.upsert('s2', { kind: 'interactive', cwd: '/x/q', lastActivityTs: Date.now() });
  assert.equal(store.get('s2').background, false);
});
```

Add a poller test in the same file, built the way `test/poller-orphan-job.test.js` builds its listings. A listing item `{ id: 'c41c76b4', sessionId: 's1', cwd, kind: 'background', state: 'done', status: 'idle' }` leaves `store.raw('s1').kind === 'background'` and `jobId === 'c41c76b4'`. An `interactive` item gets `kind === 'interactive'` and no `jobId`.

- [ ] **Step 2: Run them, confirm they fail**

Run: `cd mac-service && CLAUDE_THING_HOLD_MS=200 node --test test/background.test.js`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement**
- `background.js`:
  - `isWindowlessBackground` = `raw.kind === 'background' && !hostWindow({ jobId: raw.jobId, sessionId: raw.id })`.
  - `turnEnded` as the tests pin.
  - `UNAVAILABLE_REASON = "The owner wasn't at the desk panel to answer this, so it was not done. Don't retry it now. End your turn and say in your final message what you need from them."`
- Poller: set `fields.kind` from `item.kind` when present; when it is `'background'`, set `fields.jobId = pick(item, ['jobId', 'id'], null)`.
- Store `summary`: add `background: s.kind === 'background'` and `handoff: s.handoff || null`.

- [ ] **Step 4: Run the whole service suite**

Run: `cd mac-service && npm test`. Expected: all pass.

- [ ] **Step 5: Commit** — `feat(sessions): background sessions carry kind and job id`

---

### Task 3: Permission asks from background sessions are never handed to an unseen dialog

**Files:**
- Modify: `mac-service/src/permission-bridge.js`
- Modify: `mac-service/src/index.js` (pass `isBackground`)
- Test: `mac-service/test/permission-bridge.test.js`

**Interfaces:**
- Consumes: `isWindowlessBackground`, `BG_HOLD_MS`, `UNAVAILABLE_REASON` (Task 2).
- Produces: `createPermissionBridge({ emit, store, queue, panelOnline, isBackground = () => false, bgHoldMs = BG_HOLD_MS })`. Permission objects and `list()` entries gain `background: boolean`, and `timeoutMs` is `bgHoldMs` for background ones.

- [ ] **Step 1: Write the failing tests** (reuse the file's `fakeRes`)
- `background ask is held with no panel online`: `panelOnline: () => false`, `isBackground: () => true`. `res` is not ended immediately, and `list()` has one entry with `background: true`.
- `background ask survives releaseAll('panel-gone')`: after `releaseAll`, `res` is not ended and `list().length === 1`. `answer(id, 'allow')` then ends it with behavior `allow`.
- `background ask is denied with the reason at the hold's end`: `bgHoldMs: 30`; after 60 ms the body parses to `decision.behavior === 'deny'`, and the deny-text field from Task 1 step 4 equals `UNAVAILABLE_REASON`; the resolution emitted is `'unavailable'`.
- `interactive ask keeps today's behaviour`: `isBackground: () => false`, `panelOnline: () => false` → `behavior: 'ask'` at once.

- [ ] **Step 2: Run, confirm the four fail**

Run: `cd mac-service && CLAUDE_THING_HOLD_MS=200 node --test test/permission-bridge.test.js`.

- [ ] **Step 3: Implement**

Compute `bg = isBackground(sessionId)` once per request.
- When `bg`:
  - skip the `panelOnline()` short-circuit;
  - time the hold with `bgHoldMs` and finish it as `finish(id, 'unavailable', 'deny-unavailable')`;
  - `hookDecision` renders `deny-unavailable` as `{ behavior: 'deny', <deny-text field>: UNAVAILABLE_REASON }`;
  - `releaseAll` skips entries with `bg`.
- `index.js` passes `isBackground: (id) => isWindowlessBackground(store.raw(id))`.

- [ ] **Step 4: Run the service suite** — `cd mac-service && npm test`, all pass.

- [ ] **Step 5: Commit** — `feat(permissions): background sessions hold asks for the panel, then deny with a reason`

---

### Task 4: Questions and plans from background sessions, and the longer hook timeout

**Files:**
- Modify: `mac-service/src/question-bridge.js`
- Modify: `mac-service/scripts/install-hooks.js:15` (`PROMPT_HOOK_TIMEOUT_S = 600`, with its comment)
- Modify: `mac-service/src/index.js`
- Test: `mac-service/test/question-bridge.test.js`, `mac-service/test/install-hooks.test.js`

**Interfaces:**
- Consumes: Task 2's exports.
- Produces: `createQuestionBridge({ emit, panelOnline, holdMs, store, isBackground = () => false, bgHoldMs = BG_HOLD_MS })`. Held prompts gain `background: boolean`, and `holdMs` is `bgHoldMs` for them. `answer(id, { kind: 'vscode' })` throws `'bad-answer'` for a background prompt.

- [ ] **Step 1: Write the failing tests**
- `willHold is true for a background session with no panel`: `willHold({ tool_name: 'AskUserQuestion', session_id: 's1' })` with `panelOnline: () => false` and `isBackground: () => true` returns `true`.
- `background prompt survives releaseAll and is in list()`.
- `background prompt ends in deny with the reason`: `bgHoldMs: 30`; the resolved value deep-equals `{ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: UNAVAILABLE_REASON } }`; resolution `'unavailable'`.
- `vscode answer is refused for a background prompt`: `assert.throws(() => bridge.answer(id, { kind: 'vscode' }), /bad-answer/)`, and the prompt is still held.
- `install-hooks`: the hook with `?hold=1` has `timeout === 600`, and `600 * 1000 > BG_HOLD_MS`.

- [ ] **Step 2: Run, confirm they fail**

Run: `cd mac-service && CLAUDE_THING_HOLD_MS=200 node --test test/question-bridge.test.js test/install-hooks.test.js`.

- [ ] **Step 3: Implement**
- `willHold`: `PROMPT_TOOLS.includes(tool) && (panelOnline() || isBackground(input.session_id))`.
- In `handlePreToolUse`, a background prompt:
  - times out to `output('deny', { permissionDecisionReason: UNAVAILABLE_REASON })` with resolution `'unavailable'`;
  - is skipped by `releaseAll`.
- `index.js` passes the same `isBackground`.

- [ ] **Step 4: Run the service suite** — `cd mac-service && npm test`, all pass.

- [ ] **Step 5: Commit** — `feat(questions): background sessions hold questions and plans for the panel; hold hook timeout 600 s`

---

### Task 5: Recent projects and starting a session

**Files:**
- Create: `mac-service/src/new-session.js`
- Modify: `mac-service/src/index.js` (two requests)
- Test: `mac-service/test/new-session.test.js`

**Interfaces:**
- Consumes: `isOwnSession` (`own-sessions.js`), `CLAUDE_PROJECTS_DIR`, `MOCK_SESSIONS` (`config.js`).
- Produces:
  - `RECENT_LIMIT = 5`
  - `MAX_PROMPT_CHARS = 2000`
  - `isTempPath(p) -> boolean`
  - `recentProjects({ projectsDir, exists = fs.existsSync, limit = RECENT_LIMIT, isOwn = isOwnSession }) -> Array<{ name, path, lastUsed }>`
  - `parseBackgrounded(stdout) -> string | null`
  - `startArgs(prompt) -> string[]`
  - `createStarter({ recent, run = execFile, claudeBin = 'claude' }) -> { start({ path, prompt }) -> Promise<{ shortId }> }`
  - `createMockStarter({ store }) -> { recent() , start({ path, prompt }) }`
  - Requests:
    - `claude.projects.recent` → `{ projects }`
    - `claude.session.start` `{ path, prompt }` → `{ shortId }`
    - Errors are thrown as `Error(code)` with code `empty-prompt`, `prompt-too-long`, `not-a-recent-project` or `start-failed`.

- [ ] **Step 1: Write the failing tests** (fixture: a temp `projects` dir with folders each holding `.jsonl` files whose first line has `"cwd":"…"`; set mtimes with `fs.utimesSync`)
- `recentProjects returns the newest five, newest first`: seven project folders → five entries; `lastUsed` descending; `name` is `path.basename(path)`.
- `skips temp folders, missing folders and own sessions`:
  - cwds `/private/tmp/x`, `/var/folders/ab/T/y` and `C:\\Users\\owner\\AppData\\Local\\Temp\\z` are dropped;
  - a cwd for which `exists` returns false is dropped;
  - a transcript whose basename is an own session is ignored.
- `one entry per path`: two project folders resolving to the same cwd yield one entry, with the newer `lastUsed`.
- `parseBackgrounded`: `parseBackgrounded('Starting background service…\nbackgrounded · c41c76b4 · panel probe\n') === 'c41c76b4'`; garbage → `null`.
- `startArgs`, Review Focus 4. Per Task 1 step 5:
  - if `--` works: `startArgs('-rf $(x) "q"\nline2')` deep-equals `['--bg', '--permission-mode', 'auto', '--', '-rf $(x) "q"\nline2']`;
  - otherwise, the leading dashes are stripped: `startArgs('-rf x')[3] === 'rf x'`.
- `start refuses a path not in the recent list` → rejects `not-a-recent-project`, and `run` is never called.
- `start refuses empty and over-long prompts` (`'  '`, and 2001 chars).
- `start runs claude in the project folder and returns the short id`: fake `run(bin, args, opts, cb)` records `opts.cwd === path` and `bin === 'claude'`, then calls back with stdout `backgrounded · 0a1b2c3d · x`; resolves `{ shortId: '0a1b2c3d' }`.
- `start fails cleanly`: fake run errors → rejects `start-failed`.
- `mock starter`: `recent()` returns exactly five demo projects; `start` adds a `background` session to the store whose id starts with the returned `shortId`.

- [ ] **Step 2: Run, confirm they fail**

Run: `cd mac-service && node --test test/new-session.test.js`.

- [ ] **Step 3: Implement** — `new-session.js` as the interfaces say.
- `recentProjects`:
  - reads each project folder's newest `.jsonl` by mtime;
  - takes the first `"cwd":"…"` in its first 200 KB and JSON-unescapes it;
  - drops temp, missing and own entries;
  - de-duplicates by path;
  - sorts and slices.
- `createStarter.start` re-runs `recent()` and refuses any path not in it, then calls `run(claudeBin, startArgs(prompt), { cwd: path, timeout: 30_000 }, cb)`.
- `index.js` builds the starter as `MOCK_SESSIONS ? createMockStarter({ store }) : createStarter({ recent: () => recentProjects({ projectsDir: CLAUDE_PROJECTS_DIR }) })`, then adds the two requests.

- [ ] **Step 4: Run the service suite** — all pass.

- [ ] **Step 5: Commit** — `feat(sessions): recent projects and starting a background session`

---

### Task 6: Open in VS Code and STOP for background sessions

**Files:**
- Create: `mac-service/src/handoff.js`
- Modify: `mac-service/src/focus.js` (return `openInVsCode` from `createFocus`; `openVsCode` takes an optional prompt)
- Modify: `mac-service/src/http-server.js` (pass Stop/StopFailure to `handoff.onHook` after the response, like the digest)
- Modify: `mac-service/src/index.js` (create the handoff; four requests; clear the inbox card as `switched` when opened)
- Test: `mac-service/test/handoff.test.js`, `mac-service/test/focus.test.js`

**Interfaces:**
- Consumes: `turnEnded`, `isWindowlessBackground` (Task 2); `focus.exclusive`, `focus.focusSession`.
- Produces:
  - `focus.openInVsCode(cwd, sessionId, prompt?) -> Promise<{ focused, app, exact } | { focused: false, reason }>`. With a prompt, the link is `…/open?session=<id>&prompt=<encodeURIComponent(prompt)>`.
  - `CONTINUE_PROMPT = 'Continue where you left off.'`
  - `createHandoff({ store, focus, isWindowless, stopAgent = claudeStop, emit }) -> { request(id), cancel(id), now(id), stop(id), onHook(event, payload) }`, where `isWindowless` is `(id) => boolean` and `index.js` passes `(id) => isWindowlessBackground(store.raw(id))`. Each returns a Promise of `{ result: 'opened' | 'waiting' | 'raised' | 'stopped' | 'cancelled' | 'failed', reason? }`.
  - `request(id)` on a session that isn't windowless (interactive, or a background job with a parked window) just raises it through `focus.exclusive(() => focus.focusSession(id, { host, cwd }))` and returns `'raised'`. It never stops anything.
  - `claudeStop(shortId) -> Promise<void>` runs `execFile('claude', ['stop', shortId], { timeout: 15_000 })`.
  - Requests, each taking `{ id }`: `claude.session.handoff`, `claude.session.handoff.cancel`, `claude.session.handoff.now`, `claude.session.stop`.
  - `store` raw `handoff` is set to `'waiting'` or `'moving'` and cleared to `null`.

- [ ] **Step 1: Write the failing tests** (fake store from `createStore()`, fake focus `{ exclusive: (fn) => fn(), focusSession: async () => ({ focused: true }), openInVsCode: async (...a) => { calls.push(a); return { focused: true } } }`, fake `stopAgent` that records ids)
- `idle background session moves at once`: raw `{ kind: 'background', jobId: 'abcd1234', cwd: '/p', stoppedTs: 1 }`, then `request('s1')` resolves to `{ result: 'opened' }`; `stopAgent` was called with `'abcd1234'` **before** `openInVsCode('/p', 's1', undefined)`; final raw `handoff === null`.
- `working session waits, then moves on Stop`:
  - `stoppedTs: null` → `{ result: 'waiting' }` and raw `handoff === 'waiting'`;
  - nothing is stopped;
  - then set `stoppedTs: 2` and call `onHook('Stop', { session_id: 's1' })` → it is stopped and opened.
- `a Stop with background work still waited on does not fire the move` (`waitingOn: [{ type: 'bash' }]`).
- `cancel clears the wait`: after `cancel('s1')`, `onHook('Stop', …)` does nothing.
- `now stops at once and pre-fills continue`: `openInVsCode` gets `CONTINUE_PROMPT`.
- `parked background session is raised, never stopped`: `isWindowless: () => false` → `{ result: 'raised' }`; `stopAgent` is never called.
- `stop ends the agent`: `stop('s1')` → `stopAgent('abcd1234')`, `{ result: 'stopped' }`, and any wait is cleared.
- `a failed stop leaves the session alone`: `stopAgent` rejects → `{ result: 'failed' }`, `openInVsCode` never called, `handoff === null`.
- `focus.test.js`: `openInVsCode('/p', '<uuid>', 'Continue where you left off.')` passes `vscode://anthropic.claude-code/open?session=<uuid>&prompt=Continue%20where%20you%20left%20off.` to the injected `run`.
- `claude.session.focus is unchanged for a windowless background session`: it still returns `{ focused: false }` with the existing reason, and nothing is stopped (index-level test, or assert that focus never calls `stopAgent`, which isn't injected there).

- [ ] **Step 2: Run, confirm they fail** — `cd mac-service && node --test test/handoff.test.js test/focus.test.js`.

- [ ] **Step 3: Implement** — `handoff.js`, the `focus.js` change, the http-server hook pass-through (`createHttpServer({ …, handoff })`; after `sources.onHookEvent`, `if (handoff && (event === 'Stop' || event === 'StopFailure')) res.once('finish', () => { try { handoff.onHook(event, payload); } catch {} })`), and the four requests in `index.js`. On `result: 'opened'`, `index.js` calls `inbox.clear(id, 'switched')`.

- [ ] **Step 4: Run the service suite** — all pass.

- [ ] **Step 5: Commit** — `feat(sessions): open a background session in VS Code after its turn, and stop one`

---

### Task 7: The panel reaches a chosen machine

**Files:**
- Modify: `panel/src/ws-mux.js`
- Modify: `panel/src/ws.js` (export `machines`)
- Test: `panel/test/ws-mux.test.js`

**Interfaces:**
- Produces:
  - `mux.machines() -> Array<{ name, label, ready }>`, in host order (Mac first);
  - `request('claude.projects.recent' | 'claude.session.start', { host, … })` goes to `links[host]`, and rejects `Error('not-answering')` if that link isn't ready, or `Error('unknown-host')`;
  - `BY_SESSION` gains `claude.session.handoff`, `claude.session.handoff.cancel`, `claude.session.handoff.now` and `claude.session.stop`, all keyed on `'id'`.
  - `ws.js`: `export var machines = mux.machines;`

- [ ] **Step 1: Write the failing tests** (the file's fake links)
- `machines lists hosts with readiness`: Mac ready and NucBox not → `[{ name: 'mac', label: 'mac', ready: true }, { name: 'nucbox', label: 'NucBox', ready: false }]`. Use the labels as the mux stores them.
- `start goes to the named host`: `request('claude.session.start', { host: 'nucbox', path: 'p', prompt: 'x' })` is received by the nucbox fake only.
- `a host that isn't ready rejects not-answering`; `an unknown host rejects unknown-host`.
- `handoff requests follow the session's host`: a session listed by nucbox → `claude.session.stop` goes to nucbox.

- [ ] **Step 2: Run, confirm they fail** — `cd panel && node --test test/ws-mux.test.js`.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the panel suite** — `cd panel && npm test`, all pass.

- [ ] **Step 5: Commit** — `feat(panel): requests to a chosen machine, and handoff requests follow their session`

---

### Task 8: The new-session flow on the panel

**Files:**
- Create: `panel/src/screens/new-session.js`
- Modify: `panel/src/main.js`:
  - routes `#/new` and `#/new/<host>` in `render()`;
  - the `m-hold` handler (`r.name === 'list'` → `openNewSession()`);
  - dial, press and Back handling for the two routes;
  - the pending-start watcher on `claude.sessions.update`.
- Modify: `panel/src/screens/session-list.js` (topbar hint on `#/list`)
- Modify: `panel/src/screens/helpers.js` (`topbar(title, connected, count, hint)`)
- Modify: `panel/src/screens/dictate-review.js` (`opts.note`, `opts.text`)
- Modify: `panel/src/styles.css` (new screens' classes; Chrome 69 rules)
- Test: `panel/test/new-session.test.js`, `panel/test/dictation.test.js`

**Interfaces:**
- Consumes:
  - `machines()` (Task 7);
  - requests `claude.projects.recent` and `claude.session.start` (Task 5);
  - `openDictateReview`;
  - `prefs` (key `newSessionHost`).
- Produces:
  - `NEW_HINT = 'HOLD TOP · NEW'`
  - `machineRows(machines, sessions) -> Array<{ name, label, ready, running, status }>`, where `status` is one of `''`, `'NOT ANSWERING'` or `'NOT SET UP YET'`
  - `initialMachine(rows, lastHost) -> index`
  - `lastUsedLabel(ts, nowMs) -> string`
  - `renderMachines(state, view) -> html`
  - `renderProjects(state, view) -> html`
  - `startedSessionId(sessions, shortId) -> id | null`
  - `checkLine(projectName, asksReachPanel) -> string`
  - `ASKS_REACH_PANEL` (boolean, set from Task 1 step 3)
  - `pressStart(view, send) -> boolean`: false, and nothing sent, while `view.starting`
  - `startFailed(view, err, text, reopen)`
  - the view object `newView = { cursor, host, projects, loading, error, starting, notSetUp: {} }`, all in `screens/new-session.js`

- [ ] **Step 1: Write the failing tests**
- `machineRows counts running sessions per machine and marks the unreachable`: sessions are `[{ machine: undefined, ended: false }, { machine: 'NucBox', ended: false }, { ended: true }]`, and the NucBox isn't ready → Mac `running: 1`, NucBox `running: 1` and `status: 'NOT ANSWERING'`.
- `initialMachine prefers the last used machine if it is ready, else the first ready one`.
- `lastUsedLabel`:
  - under 60 min → `'NOW'`;
  - same day → `'TODAY'`;
  - the day before → `'YESTERDAY'`;
  - older → `'NOV 6'` style (uppercase three-letter month, day);
  - pass local-time timestamps built with `new Date(2026, 10, 7, 12)`.
- `renderMachines`:
  - title `NEW SESSION`, right `WHERE?`;
  - one row per machine;
  - the selected row has the `selected` class;
  - a `NOT ANSWERING` row has a `disabled` class.
- `renderProjects`:
  - title `NEW SESSION · MAC`, right `AUTO MODE`;
  - up to five rows with name and `lastUsedLabel`;
  - empty list → the text `NO RECENT PROJECTS ON THIS MACHINE`.
- `startedSessionId`: finds the session whose `id` starts with the short id; otherwise `null`.
- `checkLine('Mirror', true) === 'MIRROR · AUTO MODE · ASKS ON THE CAR THING'`; `checkLine('Mirror', false) === 'MIRROR · AUTO MODE'`.
- `session list topbar shows the hint`: `renderList(state)` contains `HOLD TOP · NEW`.
- `dictation review shows the note and can open on a given text` (in `dictation.test.js`): `openDictateReview({ title: 't', note: 'MIRROR · AUTO MODE', text: 'fix it', onSend() {}, onCancel() {} })` → `getDictation().phase === 'review'`, and `renderDictate` contains both strings.
- `START is sent once` (Review Focus 2): drive the exported `pressStart(view, send)` helper twice with a `send` that never resolves → `send` called once.
- `a refused start reopens the check screen with the same text` (Review Focus 3): exported `startFailed(view, err, text, reopen)` calls `reopen` with `text` and leaves `view.starting === false`.

- [ ] **Step 2: Run, confirm they fail** — `cd panel && node --test test/new-session.test.js test/dictation.test.js`.

- [ ] **Step 3: Implement**

The flow, matching the spec's screens 0–4:
- `m-hold` on `#/list` → `#/new`.
- On `#/new`:
  - turn = move the cursor (skipping disabled rows);
  - press = choose, which saves `newSessionHost` and goes to `#/new/<host>`;
  - Back = `#/list`.
- `#/new/<host>` loads `claude.projects.recent` (`{ host }`). If that rejects with `Unknown method`, set `notSetUp[host] = true` (the machine row then reads `NOT SET UP YET`) and go back to `#/new`. Press on a project → `openDictateReview`:

  ```js
  { title: 'NEW SESSION · ' + name.toUpperCase(), sendLabel: 'Start', note: checkLine(name, ASKS_REACH_PANEL),
    onSend: <pressStart>, onCancel: <nav to #/new/host> }
  ```

  `ASKS_REACH_PANEL` comes from Task 1 step 3.
- `pressStart`:
  - sends `claude.session.start` `{ host, path, prompt }`, navigates to `#/list` and toasts `STARTING…`;
  - on `{ shortId }`, watches session updates for `startedSessionId(...)`, then `openSession(id)`;
  - after 20 s, toasts `STARTED · NOT LISTED YET`;
  - on error, calls `startFailed`, which toasts the error code in uppercase and reopens the review with the text.

- [ ] **Step 4: Run the panel suite** — all pass. Then `npm --prefix simulator run smoke` from the repo root: pass.

- [ ] **Step 5: Commit** — `feat(panel): start a new session from the sessions grid`

---

### Task 9: Session view rows for background sessions

**Files:**
- Modify: `panel/src/screens/session-detail.js` (`macRows`; export `actionRowCount(detail)`; keep `ACTION_ROWS` exported as the base `3`)
- Modify: `panel/src/store.js:133-135` (clamp with `actionRowCount(state.details[id])`)
- Modify: `panel/src/main.js`:
  - `sessionRowAction`: `open-mac` → `claude.session.handoff` when `d.background && !d.machine`, otherwise `focusSession` as today;
  - new actions `handoff-cancel`, `handoff-now` and `stop-session`, with an arm-then-confirm `stopArmedFor` kept in the store (`store.update({ stopArmedFor: id })`), which any dial turn or other action clears;
  - toasts `OPENING IN VS CODE`, `OPENS WHEN DONE`, `STOPPED`;
  - the click delegation list at `main.js:707`.
- Modify: `panel/src/prompt-answer.js` (`promptRows` omits `{ kind: 'vscode' }` when `p.background`)
- Test: `panel/test/screens.test.js`, `panel/test/prompt.test.js`

**Interfaces:**
- Consumes: summary fields `background` and `handoff` (Task 2); the handoff requests (Task 6, routed by Task 7).
- Produces: `actionRowCount(d)`, which is `3`, plus `1` for a STOP row when `d.background`, plus `1` for a STOP NOW row when `d.background && d.handoff === 'waiting'`.

- [ ] **Step 1: Write the failing tests**

Background session, `handoff: null`, no machine:
- the open row reads `Open in VS Code` with the sub-line `Moves it to a tab on the Mac`;
- a `data-action="stop-session"` row reads `STOP`;
- `actionRowCount === 4`.

`handoff: 'waiting'`:
- the open row reads `OPENS IN VS CODE WHEN DONE` with the sub-line `Press to cancel`, and its `data-action="handoff-cancel"`;
- a `data-action="handoff-now"` row reads `STOP NOW`;
- `actionRowCount === 5`.

Armed stop: `renderDetail` with `state.stopArmedFor === id` → the STOP row reads `PRESS AGAIN TO STOP`.

Unchanged cases:
- an interactive session renders exactly today's three rows;
- a NucBox background session (`machine: 'NucBox'`) has STOP but its open row is today's.

Other tests:
- `applySubagents` clamps `agentSel` to `subagents + actionRowCount`.
- `promptRows` for `{ …question, background: true }` has no `vscode` row, and the plan variant is `[{ kind: 'approve' }, { kind: 'say' }]`.

- [ ] **Step 2: Run, confirm they fail** — `cd panel && node --test test/screens.test.js test/prompt.test.js`.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the panel suite and the simulator smoke** — all pass.

- [ ] **Step 5: Commit** — `feat(panel): open-in-VS-Code, stop-now and stop rows for background sessions`

---

### Task 10: Whole-repo check and PR

- [ ] **Step 1:** From the worktree root run `npm test`. Expected: exit 0. A device test that needs hardware or tools this Mac lacks must fail the same way on `origin/main`; check that before calling it unrelated.
- [ ] **Step 2:** Run the simulator (`npm run sim`). In demo mode:
  - hold the top button on the grid (key `m` held 600 ms);
  - walk machine → project → speak (or type into the review in the sim, if the sim supports it) → start;
  - the demo session appears and opens.

  Screenshot each screen into the PR.
- [ ] **Step 3:** Push and open the PR:

  ```bash
  git push -u origin feat/new-session
  gh pr create --title "New session from the Car Thing (Mac)" --body "<summary, the verify-first results, screenshots, the deploy steps of Task 11>\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)"
  ```

  Merging is the owner's call.

---

### Task 11: Deploy on the Mac and check it live (after the owner merges)

Needs the owner's go-ahead and the owner at the desk.

- [ ] **Step 1:** Fast-forward the main checkout, leaving any other session's uncommitted files alone:

  ```bash
  git -C /Users/owner/Claude/personal/Spotify_car_thing fetch origin
  git -C /Users/owner/Claude/personal/Spotify_car_thing merge --ff-only origin/main
  ```

- [ ] **Step 2:** Reinstall the hooks, because the hold hook's timeout changed:

  ```bash
  ~/.local/node-v22/bin/node /Users/owner/Claude/personal/Spotify_car_thing/mac-service/scripts/install-hooks.js
  ```

  Confirm `~/.claude/settings.json` has the `?hold=1` hook at `timeout: 600` and the owner's own hooks unchanged.
- [ ] **Step 3:** `launchctl kickstart -k gui/$(id -u)/com.claudepanel.service`; the log shows a clean start.
- [ ] **Step 4:** Build and flash the panel the usual way (`just swu` then `just ota 192.168.1.55`). Record the new slot and build id.
- [ ] **Step 5: Live checks**, each recorded:
  - (a) Hold top on the grid → `MAC` and `NUCBOX`. NucBox reads `NOT SET UP YET` after choosing it, since its service isn't updated.
  - (b) Mac → five recent projects that match `claude.projects.recent`.
  - (c) Speak a prompt → the check screen shows the text and the check line → START → the session view opens; nothing on the Mac takes focus.
  - (d) A permission or question from it is answered on the panel.
  - (e) While it works, "Open in VS Code" reads `OPENS IN VS CODE WHEN DONE`; at turn end it opens as a VS Code tab with full history.
  - (f) STOP NOW on a second one opens it with `Continue where you left off.` pre-filled.
  - (g) STOP on a third ends it (gone from `claude agents --json`).
- [ ] **Step 6:** Update the spec with an as-built note (deploy date, build id, live-check results). Leave `**Status:**` as Approved until the NucBox milestone ships. Commit doc-only on main per the owner's docs rule, or on a docs branch if main refuses the push.
