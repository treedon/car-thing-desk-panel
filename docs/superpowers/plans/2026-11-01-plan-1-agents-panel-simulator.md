# Plan 1: Claude Agents Panel in the Mac Simulator — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the Claude Agents panel on the owner's Mac with no hardware.

The panel is claude-thing's device app, adapted, talking straight to a Mac service over the network. It shows:
- live sessions with descriptive titles
- subagents you can drill into
- the recent conversation, at reading length
- permission, question and plan answers, all through hooks
- hold-to-talk dictation, transcribed on the Mac, sent as an answer or a message
- the waiting alert
- a "take me there" action for VS Code sessions

**Architecture:** This plan forks three parts of [rithkott/claude-thing](https://github.com/rithkott/claude-thing) (MIT) into this repo:
- `daemon/` becomes `mac-service/`
- `device-app/` becomes `panel/`
- `emulator/` becomes `simulator/`

Nocturne, Bluetooth and the phone simulation are removed. The panel connects directly to the Mac service's WebSocket (`/ws`), with a token. Later plans reuse the same panel on the Car Thing over Wi-Fi.

**Tech Stack:**
- Node 22, `ws`, `node --test`
- the panel is vanilla JS built with Vite plus `@vitejs/plugin-legacy`, targeting Chrome 69
- the simulator uses Chrome app mode, driven over CDP

**Spec:** `docs/superpowers/specs/2026-11-01-carthing-panel-design.md`

### Roadmap (separate plans, written when their turn comes)

- **Plan 1 (this one):** Agents panel, Mac service and simulator.
- **Plan 2:** Car Thing image and network proof. Fork the yocto-superbird kiosk example, add the Wi-Fi drivers, boot the panel from Plan 1 on hardware, and prove all inputs work. (Spec Milestone 0.)
- **Plan 3:** App shell and Home Assistant screens: Home, Audio (HomePods) and Bed. Presets switch screens, and the waiting alert shows on every screen.
- **Plan 4:** The stand.

## Global Constraints

- **Panel code** must run on Chrome 69 (the Car Thing kiosk):
  - Keep `@vitejs/plugin-legacy` with target `chrome69`.
  - No `crypto.randomUUID`, optional chaining or `??` in panel source.
- **Screen** is exactly 800×480.
- **Input events** are the same on device and simulator:

  | Input | Event |
  |---|---|
  | knob turn | `wheel` with `deltaX` |
  | knob press | `Enter` |
  | back | `Escape` |
  | presets | `1`–`4` |
  | top button | `m` |

- **Ports:**
  - Mac service HTTP + WS on `8790`.
  - Simulator on `8091`.
  - **Never use `8080`**: the owner's mirror service holds it.
- **Never stall a Claude session:**
  - With no panel connected, a `PermissionRequest` hook answers `ask` immediately.
  - With a panel connected, the hold is at most `20000` ms by default.
  - Questions (`AskUserQuestion`) and plans (`ExitPlanMode`) hold at most `120000` ms with a panel connected (Claude is waiting on the owner anyway), and release at once when the owner picks "Answer in VS Code". With no panel, they pass through immediately.
- **Dictation stays on the Mac.** Audio goes only to the Mac service over the token-guarded `/ws` and is transcribed locally by whisper.cpp. No cloud speech service. Audio is deleted after transcription.
- **Messages only reach Claude through documented hooks** (`PreToolUse` `updatedInput`/deny reason, `PostToolUse` `additionalContext`, `Stop` `asyncRewake`), never by typing.
- **Never type into VS Code.** "Take me there" may only raise a window.
- **The LAN can only reach `/ws`, and only with the token.** `/hook` and the control page answer loopback only.
- **Session title order:** custom title, then AI title, then registry name, then folder name.
- **License:** keep claude-thing's MIT `LICENSE` and add a `NOTICE.md` crediting it.

## Review Focus

1. **The panel disconnects while a permission is held** (simulator closed, Wi-Fi drop). Every held request must resolve `ask` within one second so the Mac's own prompt takes over. *Test in Task 2.*
2. **A transcript's last line is half-written** while Claude is mid-write. Title, subagent and feed readers must skip it and never throw. *Tests in Tasks 3 and 4.*
3. **A request reaches `/ws` from another machine without the token, or `/hook` is posted from the LAN.** Both must be rejected, while the simulator on loopback still works without a token. *Test in Task 1.*
4. **The Mac service restarts or the Mac sleeps.** The panel shows its offline banner, reconnects with backoff, and re-lists sessions without a reload. *Verified in Task 7.*
5. **The owner types in VS Code while a panel message is waiting to be delivered.** The stale panel message must be dropped (and the panel told), never delivered later on top of the owner's new prompt. *Test in Task 12.*

(Many sessions and subagents are covered by Task 8's demo mode.)

---

### Task 0: Import claude-thing as the starting point

**Files:**
- Create:
  - `mac-service/` (copy of `reference/claude-thing/daemon/`)
  - `panel/` (copy of `device-app/`)
  - `simulator/` (copy of `emulator/`)
  - `protocol/` (copy of `protocol/`)
  - `LICENSE`, copied from claude-thing
  - `NOTICE.md`
  - `.gitignore`
- Delete from the copies:
  - `simulator/src/firmware.js`, `phone-sim.js`, `methods.js`, `ws-server.js`, `claude-bridge.js`
  - `panel/src/screens/bluetooth.js`

- [ ] **Step 1:** `git init` at `/Users/owner/Claude/personal/Spotify_car_thing`.
  - `.gitignore` must contain `node_modules/`, `dist/`, `logs/`, `reference/`, `spikes/` and `simulator/.cache/`.
  - Copy the four folders without `node_modules`, `.gitnexus` or logs.
- [ ] **Step 2:** Run `npm --prefix mac-service install && npm --prefix mac-service test` and `npm --prefix panel install && npm --prefix panel test`. Both should pass as they do upstream. Record any upstream failures in `NOTICE.md` rather than fixing them here.
- [ ] **Step 3:** Delete the Nocturne-only files listed above, and remove the bluetooth screen's import and routes from `panel/src/main.js`.
  - Run `npm --prefix panel run build`. It must succeed with no reference to `bluetooth`.
- [ ] **Step 4:** Commit: `chore: import claude-thing daemon, device app, emulator (MIT) as starting point`.

### Task 1: Mac service listens on the LAN, guarded by a token

**Files:**
- Create: `mac-service/src/lan-auth.js`, `mac-service/test/lan-auth.test.js`
- Modify:
  - `mac-service/src/config.js:12` (`HOST`)
  - `mac-service/src/http-server.js:103-115` (upgrade, `/hook` and control-page guards)

**Interfaces:**
- Produces:
  - `isLoopback(remoteAddress: string) -> boolean`: true for `127.0.0.1`, `::1` and `::ffff:127.0.0.1`.
  - `authorizeUpgrade({ remoteAddress, url, token }) -> boolean`.
  - `loadOrCreateToken(dir: string) -> string`: reads `<dir>/token`, or writes 32 random bytes as hex with mode `0600` and returns them.
  - `TOKEN_DIR = ~/.config/claude-panel` in `config.js`.
  - `HOST` comes from `process.env.CLAUDE_PANEL_BIND`, defaulting to `'0.0.0.0'`.

- [ ] **Step 1: Write the failing tests**

```js
test('loopback needs no token', () => {
  assert.equal(authorizeUpgrade({ remoteAddress: '127.0.0.1', url: '/ws', token: 'abc' }), true);
  assert.equal(authorizeUpgrade({ remoteAddress: '::ffff:127.0.0.1', url: '/ws', token: 'abc' }), true);
});
test('LAN needs the exact token', () => {
  assert.equal(authorizeUpgrade({ remoteAddress: '192.168.1.40', url: '/ws', token: 'abc' }), false);
  assert.equal(authorizeUpgrade({ remoteAddress: '192.168.1.40', url: '/ws?token=nope', token: 'abc' }), false);
  assert.equal(authorizeUpgrade({ remoteAddress: '192.168.1.40', url: '/ws?token=abc', token: 'abc' }), true);
});
test('token file is created once with 0600', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tok-'));
  const a = loadOrCreateToken(dir), b = loadOrCreateToken(dir);
  assert.equal(a, b); assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(path.join(dir, 'token')).mode & 0o777, 0o600);
});
```

- [ ] **Step 2:** Run `npm --prefix mac-service test`. Expected: FAIL, because `lan-auth.js` is missing.
- [ ] **Step 3:** Implement `lan-auth.js`. Compare tokens with `crypto.timingSafeEqual`, and return false on a length mismatch.
- [ ] **Step 4:** Wire it into `http-server.js`:
  - **Upgrade:** reject an unauthorized upgrade with `HTTP/1.1 401 Unauthorized` and destroy the socket.
  - **Loopback-only routes:** any non-`/ws` request from a non-loopback address gets `403`. This covers `/hook` and the control page.
  - **Startup:** log the bind address and the token file path, never the token itself.
- [ ] **Step 5:** Run the tests: PASS. Then run `npm --prefix mac-service start` and check the guards from another device on the LAN (a phone browser works):
  - `curl -s -o /dev/null -w '%{http_code}' http://<mac-ip>:8790/status` must print `403`.
  - The same request from the Mac prints `200`.
- [ ] **Step 6:** Commit: `feat(mac-service): bind to LAN with token-guarded /ws; hooks loopback-only`.

### Task 2: Permissions never stall a session

**Files:**
- Modify:
  - `mac-service/src/config.js:34` (`PERMISSION_HOLD_MS` default becomes `20000`)
  - `mac-service/src/permission-bridge.js`
  - `mac-service/src/index.js` (pass `panelOnline`, and call `releaseAll` when the last panel leaves)
- Test: `mac-service/test/permission-bridge.test.js` (extend the existing harness)

**Interfaces:**
- Consumes: `hub.rolesOnline() -> { [role]: count }` (existing).
- Produces:
  - `createPermissionBridge({ emit, store, queue, panelOnline: () => boolean })`
  - `bridge.releaseAll(reason: string) -> number`: resolves every held request with `ask` and returns how many it released.
  - The panel identifies itself with `bridge.hello { role: 'panel' }`. The role `'emulator'` counts as a panel too, for backward compatibility.

- [ ] **Step 1: Write the failing tests** (in the existing file's style)

```js
test('no panel online: hook answers ask immediately', async () => {
  const { bridge, res } = harness({ panelOnline: () => false });
  bridge.onHookRequest(permissionPayload('Bash'), res);
  assert.equal(JSON.parse(res.body).hookSpecificOutput.decision.behavior, 'ask');
  assert.ok(res.ended && res.elapsedMs < 50);
});
test('panel online: request is held until answered', async () => { /* res not ended after 100ms; answer() ends it with allow */ });
test('releaseAll answers ask for every held request', async () => {
  // hold two, call bridge.releaseAll('panel-gone'), both res bodies have behavior 'ask', returns 2
});
test('default hold is 20000ms', () => { assert.equal(PERMISSION_HOLD_MS, 20000); });
```

- [ ] **Step 2:** Run `npm --prefix mac-service test`. Expected: the new tests FAIL.
- [ ] **Step 3:** Implement the changes:
  - `onHookRequest` checks `panelOnline()` before holding.
  - Add `releaseAll`.
  - In `index.js`, after a hub `close`, call `bridge.releaseAll('panel-gone')` if `!panelOnline()`.
  - Keep the "never auto-deny" rule.
- [ ] **Step 4:** Run the tests: PASS, including the upstream permission tests.
- [ ] **Step 5:** Commit: `feat(mac-service): never hold permissions without a panel; 20s cap; release on disconnect`.

### Task 3: Descriptive session titles

**Files:**
- Modify:
  - `mac-service/src/sessions/source-transcript.js` (`harvest`)
  - `mac-service/src/sessions/store.js` (`summary`)
  - `panel/src/screens/session-list.js` and `panel/src/screens/helpers.js`
- Test: `mac-service/test/transcript-tail.test.js`, `mac-service/test/store.test.js`, `panel/test/helpers.test.js`

**Interfaces:**
- Produces:
  - Store fields `customTitle`, `aiTitle` and `project` (the basename of `cwd`).
  - `summary(s).name` = `customTitle || aiTitle || registryName || project`, at most 60 characters.
  - `summary(s).project` is a string.
  - Panel helper `tileLabels(session) -> { title: string, subtitle: string }`. `subtitle` is `project`, or `''` when it equals the title.

- [ ] **Step 1: Confirm the custom-title record.** Rename a VS Code session tab ("Claude Code: Rename Session Tab"), then run `grep -h '"type":"custom-title"\|"customTitle"' ~/.claude/projects/*/<that-session-id>.jsonl | tail -1`. Use the exact type and key found in the test below. If no record appears, drop custom titles and note it in `NOTICE.md`.
- [ ] **Step 2: Write the failing tests**

```js
test('ai-title sets the session name', () => {
  feedLines(['{"type":"ai-title","aiTitle":"Mirror-mouse pairing plan","sessionId":"s1"}']);
  assert.equal(store.summary('s1').name, 'Mirror-mouse pairing plan');
});
test('custom title beats ai title; latest record wins', () => { /* ai-title, custom-title, ai-title again -> custom */ });
test('half-written last line is ignored', () => {
  assert.doesNotThrow(() => feedLines(['{"type":"ai-title","aiTi']));
  assert.equal(store.summary('s1').name, 'Spotify_car_thing'); // falls back to project
});
// panel/test/helpers.test.js
test('tileLabels hides a subtitle equal to the title', () => {
  assert.deepEqual(tileLabels({ name: 'mirror', project: 'mirror' }), { title: 'mirror', subtitle: '' });
  assert.deepEqual(tileLabels({ name: 'GitHub issue tracker triage', project: 'Mirror' }),
    { title: 'GitHub issue tracker triage', subtitle: 'Mirror' });
});
```

- [ ] **Step 3:** Run both test suites. Expected: FAIL.
- [ ] **Step 4:** Implement:
  - Harvest both record types into the store.
  - `summary` computes `name` and `project`.
  - The session tile renders `title` large and `subtitle` in the small line above the model and effort line, truncated with an ellipsis by CSS (no JS measuring).
- [ ] **Step 5:** Run the tests: PASS. Run `npm --prefix panel run build`: success.
- [ ] **Step 6:** Commit: `feat: show Claude Code session titles with project as subtitle`.

### Task 3b: Conversation context when you open a session

The owner found claude-thing's session view too thin ("I don't get much"). Opening a session should show the recent conversation, not just a status line.

**Files:**
- Create:
  - `mac-service/src/sessions/recent-messages.js`
  - `mac-service/test/recent-messages.test.js`
  - `panel/src/screens/conversation.js`
- Modify:
  - `mac-service/src/index.js` (register a method)
  - `panel/src/screens/session-detail.js`
  - `panel/src/main.js`
  - `protocol/claude-protocol.md`

**Interfaces:**
- Produces:
  - `readRecentMessages(jsonlPath: string, { limit = 40, maxBytes = 524288 }) -> Message[]`
  - `Message = { role: 'user' | 'assistant' | 'tool', text: string, ts: number }`, oldest first. Rules:
    - **User:** typed prompts only. Skip tool results and system or hook injections: `isMeta`, or content that is only `tool_result` blocks.
    - **Assistant:** `text` blocks joined. Skip `thinking`.
    - **Tool:** one entry per `tool_use`, with `text` as `"<name>: <salient input>"` from `tool-summary.js`. Task 4 moves `summarizeTool` there; if this task runs first, do that move here.
    - Each `text` is clipped to 2000 characters with a trailing `…`, except the newest assistant entry, which is clipped at 8000. The owner asked twice for more context, so err long; the knob scrolls.
  - WS method `claude.session.messages { id, limit } -> { messages: Message[] }`.
  - Task 4's `readSubagentFeed` reuses `readRecentMessages` for its steps.

- [ ] **Step 1: Write the failing tests** against a fixture transcript built from real line shapes: user prompt, assistant thinking + text, tool_use Bash, tool_result, an `isMeta` user line, assistant text, then a torn last line.

```js
test('returns prompt, assistant text and tool lines, oldest first', () => {
  const m = readRecentMessages(fx('convo.jsonl'), { limit: 12 });
  assert.deepEqual(m.map(x => x.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(m[2].text, 'Bash: npm test');
});
test('skips thinking, tool results and meta lines', () => {
  const text = readRecentMessages(fx('convo.jsonl'), {}).map(x => x.text).join('\n');
  assert.doesNotMatch(text, /THINKING-SENTINEL|TOOL-RESULT-SENTINEL|META-SENTINEL/);
});
test('clips older text to 2000 chars with ellipsis', () => { /* 5000-char assistant text, not newest -> length 2001, endsWith '…' */ });
test('newest assistant reply keeps up to 8000 chars', () => { /* 5000-char newest assistant text -> length 5000 */ });
test('limit keeps the newest N', () => { /* limit 2 -> last two entries */ });
test('torn last line and missing file do not throw', () => {
  assert.doesNotThrow(() => readRecentMessages(fx('convo.jsonl'), {}));
  assert.deepEqual(readRecentMessages('/nonexistent.jsonl', {}), []);
});
```

- [ ] **Step 2:** Run `npm --prefix mac-service test`: FAIL.
- [ ] **Step 3:** Implement the reader. Read only the last `maxBytes`, and drop the first partial line. Register `claude.session.messages`. The transcript path is the one `source-transcript.js` already resolves.
- [ ] **Step 4:** Run the tests: PASS.
- [ ] **Step 5:** Build the panel's conversation view. When a session is opened, the detail screen leads with it:
  - The conversation is a scrollable column, newest at the bottom, and opens scrolled to the bottom.
  - **User** prompts show in a distinct block.
  - **Assistant** text shows as plain paragraphs.
  - **Tool** lines show as single dimmed rows.
  - The knob scrolls by about 3 lines per tick, and touch drag scrolls too (use `touchmove`, since Chrome 69 kiosk has no smooth scrolling).
  - Text is set for reading, not glancing: body at 20px minimum, about 60 characters per line, so the 800×480 screen holds roughly 14 lines.
  - Assistant markdown renders minimally: paragraphs, bullet lists, inline and fenced code. No tables or images.
  - It refreshes on that session's `claude.session.update`.
  - The status, model and context strip and the subagent list (Task 5) sit below the conversation, reached by scrolling past it.
- [ ] **Step 6:** Run `npm --prefix panel test && npm --prefix panel run build`. Run `npm run sim`, open this repo's own session, and check visually that the last prompt and Claude's latest reply are readable at 800×480.
- [ ] **Step 7:** Commit: `feat: recent conversation when opening a session`.

### Task 4: Subagents in the Mac service

**Files:**
- Create:
  - `mac-service/src/sessions/subagents.js`
  - `mac-service/test/subagents.test.js`
  - fixtures under `mac-service/test/fixtures/subagents/`, built from the real shapes below
- Modify:
  - `mac-service/src/sessions/store.js` (`summary.subagents`)
  - `mac-service/src/index.js` (register methods and a 2 s refresh)
  - `protocol/claude-protocol.md`

**Interfaces:**
- Produces:
  - `readSubagents(sessionDir: string, { sessionEnded: boolean }) -> Subagent[]`
  - `Subagent = { id, description, agentType, background: boolean, depth: number, parentId: string|null, running: boolean, currentTool: string|null, startedTs: number, lastActivityTs: number }`
  - `readSubagentFeed(sessionDir: string, agentId: string, limit = 20) -> { steps: Message[], report: string|null }`, where `Message` is Task 3b's type
  - `summary(s).subagents = { running: number, finished: number }`
  - WS methods:
    - `claude.subagents.list { sessionId } -> { subagents: Subagent[] }`
    - `claude.subagent.feed { sessionId, agentId } -> feed`
- Data shapes, verified on the owner's machine:
  - Folder: `~/.claude/projects/<project>/<sessionId>/subagents/`.
  - `agent-<id>.meta.json` holds `{ agentType, description, toolUseId, spawnDepth, requestShape: "background"|…, finished: boolean }`.
  - `agent-<id>.jsonl` has `isSidechain: true` on every line.

- [ ] **Step 1: Write the failing tests** against fixtures:
  - `fixtures/subagents/basic/subagents/` holds two finished agents and one running agent with a `tool_use` of `Bash` whose `command` is `npm test`.
  - `fixtures/subagents/nested/` holds a child whose meta `toolUseId` appears as a `tool_use.id` inside its parent's jsonl.

```js
test('lists agents oldest first with running state', () => {
  const list = readSubagents(fx('basic'), { sessionEnded: false });
  assert.equal(list.length, 3);
  assert.deepEqual(list.map(a => a.running), [false, false, true]);
  assert.equal(list[2].currentTool, 'Bash: npm test');
  assert.equal(list[0].background, true);
});
test('ended session marks every agent finished', () => {
  assert.ok(readSubagents(fx('basic'), { sessionEnded: true }).every(a => !a.running));
});
test('nested agent gets parentId and depth', () => {
  const kid = readSubagents(fx('nested'), { sessionEnded: false }).find(a => a.depth === 2);
  assert.ok(kid.parentId);
});
test('feed returns last steps and final report; tolerates a torn last line', () => {
  const f = readSubagentFeed(fx('basic'), 'a-finished-1', 20);
  assert.ok(f.steps.length > 0 && f.steps.length <= 20);
  assert.match(f.report, /^.{1,400}$/s);
  assert.doesNotThrow(() => readSubagentFeed(fx('torn'), 'a-torn', 20));
});
test('missing subagents folder returns []', () => {
  assert.deepEqual(readSubagents('/nonexistent', { sessionEnded: false }), []);
});
```

- [ ] **Step 2:** Run the tests: FAIL.
- [ ] **Step 3:** Implement `subagents.js`. Its feed uses `readRecentMessages` from Task 3b, so `steps` holds the subagent's own prompt, replies and tool lines:
  - `running = meta.finished !== true && !sessionEnded`.
  - `currentTool` is the last `tool_use` in the jsonl, rendered as `"<name>: <salient input>"`. Reuse `summarizeTool` from `permission-bridge.js` by moving it to `mac-service/src/tool-summary.js`.
  - `report` is the first 400 characters of the last assistant text, only when the agent is finished.
  - Read only the last 64 KB of each jsonl.
- [ ] **Step 4:** Register the two WS methods. Every 2 s, for non-ended sessions, recompute `summary.subagents` and upsert it only when the counts change, to avoid flooding events.
- [ ] **Step 5:** Run the tests: PASS. Document both methods and the `subagents` summary field in `protocol/claude-protocol.md`.
- [ ] **Step 6:** Commit: `feat(mac-service): subagent listing and activity feed`.

### Task 5: Subagents in the panel

**Files:**
- Create: `panel/src/screens/subagent-feed.js`
- Modify:
  - `panel/src/screens/session-list.js` (badge)
  - `panel/src/screens/session-detail.js` (subagent list)
  - `panel/src/screens/helpers.js`
  - `panel/src/main.js` (routes: detail → feed, back returns)
- Test: `panel/test/helpers.test.js`

**Interfaces:**
- Consumes: `claude.subagents.list` and `claude.subagent.feed` from Task 4, and `summary.subagents`.
- Produces:
  - `subagentBadge({ running, finished }) -> string|null`
  - `subagentIndentPx(depth: number) -> number`, which is `(depth - 1) * 20`, capped at `60`.

- [ ] **Step 1: Write the failing tests**

```js
test('subagentBadge copy', () => {
  assert.equal(subagentBadge({ running: 0, finished: 0 }), null);
  assert.equal(subagentBadge({ running: 1, finished: 0 }), '1 agent running');
  assert.equal(subagentBadge({ running: 2, finished: 3 }), '2 agents running');
  assert.equal(subagentBadge({ running: 0, finished: 3 }), '3 agents done');
});
test('indent caps at 60', () => {
  assert.equal(subagentIndentPx(1), 0); assert.equal(subagentIndentPx(9), 60);
});
```

- [ ] **Step 2:** Run `npm --prefix panel test`: FAIL.
- [ ] **Step 3:** Implement the helpers.
- [ ] **Step 4:** Implement the screens:
  - **Session tile:** shows the badge when it isn't null.
  - **Session detail:** shows a scrollable subagent list fetched on open and refreshed on each `claude.sessions.update` for that session. Each row has the description, `agentType`, a running or done state, a background tag, the current tool, and elapsed time. The knob moves the selection and a press opens the feed.
  - **Feed screen:** reuses Task 3b's `conversation.js` view, newest at the bottom, with the report as the final block when finished. Back returns to the detail screen.
- [ ] **Step 5:** Run the tests: PASS. Run the build: success.
- [ ] **Step 6:** Commit: `feat(panel): subagent badge, list and activity feed`.

### Task 6: "Take me there" for VS Code sessions

**Files:**
- Modify:
  - `mac-service/src/focus.js`
  - `mac-service/src/sessions/store.js` (`summary.host`)
  - `panel/src/screens/ask.js` and `panel/src/screens/queue.js`
- Test: `mac-service/test/focus.test.js` (extend)

**Interfaces:**
- Produces:
  - `detectHost(pid: number, readProc: (pid) => { ppid: number, comm: string } | null) -> 'vscode' | 'terminal' | 'unknown'`. It walks parent processes up to 10 levels. Any ancestor `comm` containing `Code Helper` or `Visual Studio Code` means `vscode`. `Terminal`, `iTerm` or `tmux` means `terminal`.
  - `summary(s).host`.
  - `claude.session.focus { id }`: for `vscode`, run `open -a "Visual Studio Code" <cwd>` and nothing else. For `terminal`, keep the upstream behavior.
  - For `vscode` sessions, the upstream typing paths for `claude.question.answer` and plan answers return the error `'answer-in-vscode'` and never type. Task 10 replaces typing with hook answers for every host, so this error only shows when Task 10's hook didn't catch the prompt (e.g. hooks not installed).

- [ ] **Step 1: Write the failing tests**

```js
test('detectHost finds VS Code ancestor', () => {
  const tree = { 10: { ppid: 9, comm: 'node' }, 9: { ppid: 8, comm: 'Code Helper (Plugin)' }, 8: { ppid: 1, comm: 'launchd' } };
  assert.equal(detectHost(10, (p) => tree[p] || null), 'vscode');
});
test('detectHost stops at 10 levels and returns unknown', () => { /* chain of 20 'node' -> 'unknown' */ });
test('focus on a vscode session runs open -a with cwd and never osascript keystroke', async () => {
  // inject exec spy; assert one call ['open', ['-a','Visual Studio Code', '/Users/owner/Claude/personal/Mirror']]
});
test('question answer on vscode session rejects with answer-in-vscode', async () => { /* ... */ });
```

- [ ] **Step 2:** Run the tests: FAIL.
- [ ] **Step 3:** Implement:
  - The real `readProc` uses `ps -o ppid=,comm= -p <pid>`. Cache `host` per session once found.
  - Panel: when an ask's session has `host === 'vscode'`, the ask screen shows the question or plan text, then one action, **"Answer in VS Code"**, in place of the options. A knob press calls `claude.session.focus`.
- [ ] **Step 4:** Run the tests: PASS.
- [ ] **Step 5:** Manual check. From the simulator, with a VS Code session waiting on a question, a knob press raises that VS Code window, and nothing is typed.
- [ ] **Step 6:** Commit: `feat: take-me-there for VS Code sessions; never type into VS Code`.

### Task 7: Panel connects straight to the Mac service

**Files:**
- Create:
  - `panel/src/config.js`
  - `panel/public/panel-config.js`: the default `window.PANEL_CONFIG = { serviceUrl: 'ws://localhost:8790/ws', token: '' }`
- Modify:
  - `panel/src/ws.js` (URL, hello, offline banner text)
  - `panel/index.html` (load `/panel-config.js` before the app)
- Test: `panel/test/config.test.js`

**Interfaces:**
- Produces:
  - `serviceWsUrl(cfg: { serviceUrl: string, token: string }) -> string`. It appends `?token=<encodeURIComponent(token)>` when the token isn't empty.
  - On open, the panel sends `bridge.hello { role: 'panel', info: { screen: '800x480' } }` before any other request.
  - The offline banner reads exactly `Mac offline. Reconnecting…`.

- [ ] **Step 1: Write the failing tests**

```js
test('url without token', () => {
  assert.equal(serviceWsUrl({ serviceUrl: 'ws://localhost:8790/ws', token: '' }), 'ws://localhost:8790/ws');
});
test('url with token is encoded', () => {
  assert.equal(serviceWsUrl({ serviceUrl: 'ws://192.168.1.20:8790/ws', token: 'a b' }), 'ws://192.168.1.20:8790/ws?token=a%20b');
});
```

- [ ] **Step 2:** Run the tests: FAIL.
- [ ] **Step 3:** Implement:
  - `ws.js` reads `window.PANEL_CONFIG` through `config.js`.
  - Send the hello first and queue other requests until its response arrives.
  - Keep the exponential backoff, capped at 30 s.
  - On reconnect, re-run the boot fetches (`claude.queue.list`, `claude.sessions.list`, `claude.usage.get`). They already exist in `main.js:1021-1062`, so call that function again rather than duplicating it.
- [ ] **Step 4:** Run the tests: PASS. Run the build: success.
- [ ] **Step 5:** Commit: `feat(panel): connect directly to Mac service with token and hello`.

### Task 8: Simulator serves the panel directly, with a demo mode

**Files:**
- Modify:
  - `simulator/src/config.js`: `HTTP_PORT` comes from `process.env.SIM_PORT`, default `8091`. Remove `WS_PORT`, `SIM_PHONE` and `SPOTIFY_SKIPPED`.
  - `simulator/src/static-server.js`: serve `panel/dist` at `/`, the shell at `/__emulator__/`, and a generated `/panel-config.js` pointing at `ws://127.0.0.1:8790/ws` with no token.
  - `simulator/src/index.js`
  - `simulator/scripts/deploy-dev.js`, renamed to `simulator/scripts/run.js`
  - `simulator/package.json`: script `"sim": "node scripts/run.js"`
  - root `package.json`: script `"sim": "npm --prefix simulator run sim"`
- Test: `simulator/scripts/smoke.js`

**Interfaces:**
- Consumes: `mac-service`, started with `CLAUDE_THING_MOCK=1` (the upstream mock source in `mac-service/src/sessions/source-mock.js`) when `SIM_DEMO=1`.
- Produces:
  - `npm run sim` builds the panel, starts the Mac service if `:8790/status` doesn't answer, serves the simulator, and opens a Chrome app window at `http://127.0.0.1:8091/__emulator__/`.
  - `SIM_DEMO=1 npm run sim` uses mock sessions. Extend the mock to create 12 sessions, one with 22 subagents.

- [ ] **Step 1:** Write `smoke.js`. It starts the simulator server, then:
  - checks that `GET /` returns 200 and contains `<div id="app">`;
  - checks that `GET /panel-config.js` contains `8790/ws`;
  - checks that `GET /__emulator__/` returns 200;
  - exits non-zero on any failure.

  Run it: FAIL.
- [ ] **Step 2:** Implement the changes above:
  - Keep CDP throttling and the faceplate unchanged.
  - Confirm the mock source's env var name in `mac-service/src/sessions/index.js:25` and use that exact name.
- [ ] **Step 3:** Run `node simulator/scripts/smoke.js`: exit 0.
- [ ] **Step 4:** Run `SIM_DEMO=1 npm run sim`. Take a CDP screenshot (as done during scoping) and check:
  - the session grid shows titles with subtitles;
  - the 22-subagent session's list scrolls with `→`;
  - nothing overflows 800×480.
- [ ] **Step 5:** Commit: `feat(simulator): serve panel directly on :8091 with demo mode`.

### Task 9: Run against real sessions and verify the open questions

This task is mostly verification. **The owner runs the hooks step**, because Claude Code's auto mode blocks an agent from editing `~/.claude/settings.json`.

**Files:**
- Modify:
  - `mac-service/scripts/install-hooks.js`: unchanged except that the URL stays `http://127.0.0.1:8790/hook`.
  - `README.md`: setup, the token path, and how to run the simulator.
  - the spec's "Builder must verify" items, updated with the results.

- [ ] **Step 1: Owner runs** `node mac-service/scripts/install-hooks.js`, then starts a new VS Code Claude session.
- [ ] **Step 2:** Run `npm run sim` (live mode). Ask Claude in that new session to run `ls ~`. Record:
  - **(a)** whether a permission card appears on the panel;
  - **(b)** whether Allow on the panel lets the VS Code session proceed;
  - **(c)** what VS Code shows while the hook is held;
  - **(d)** whether answering in VS Code first clears the card.

  Any failure in (a) or (b) blocks the task. Write the facts into the spec under Integrations and report them to the owner.
- [ ] **Step 3:** Close the simulator window while a permission is held. Expected: within 1 s, VS Code shows its normal prompt (Review Focus 1).
- [ ] **Step 4:** Run a session that spawns two background subagents. Check that the tile badge counts them, that drill-in shows live `currentTool`, and how `finished` behaves while an agent runs. Record the result in the spec.
- [ ] **Step 5:** Add a LaunchAgent: `mac/install.sh`, adapted from upstream, with label `com.claudepanel.service` and LaunchAgent only. It does not touch hooks; that stays the owner's separate step.
- [ ] **Step 6:** Commit: `docs: setup README; record hook and subagent verification results`.

### Task 10: Answer questions and plans from the panel, through hooks

Claude Code's hooks docs (checked 2026-11-02) say a `PreToolUse` hook can answer `AskUserQuestion` by returning `permissionDecision: "allow"` with `updatedInput` = the original `questions` plus `answers: { "<question text>": "<option label>" }`. Multi-select joins labels with commas. `ExitPlanMode` is approved the same way: `"allow"` plus `updatedInput` (echo the input). A `"deny"` with `permissionDecisionReason` sends that text back to Claude, which is how plan feedback works. The CLI on this Mac is 2.1.220, but the VS Code extension bundles its own (2.1.314 during scoping); Task 9 checks it works there. This replaces upstream's AppleScript typing for every host.

**Files:**
- Create:
  - `mac-service/src/question-bridge.js`
  - `mac-service/test/question-bridge.test.js`
  - `panel/src/screens/dictate-review.js` (used by Task 11; create the stub here)
- Modify:
  - `mac-service/src/hub.js` (route `PreToolUse` hooks for `AskUserQuestion|ExitPlanMode` to the bridge)
  - `mac-service/scripts/install-hooks.js` (add a `PreToolUse` hook with matcher `AskUserQuestion|ExitPlanMode`, timeout `130` s)
  - `panel/src/screens/ask.js`
  - `protocol/claude-protocol.md`

**Interfaces:**
- Consumes: `createPermissionBridge`'s `panelOnline()` and queue from Task 2; `readRecentMessages` from Task 3b.
- Produces:
  - `createQuestionBridge({ emit, queue, panelOnline, holdMs = 120000 }) -> { handlePreToolUse(input) -> Promise<HookOutput|null>, answer(id, Answer), releaseAll(reason) }`. `null` means "no opinion", which lets Claude Code show its own dialog.
  - `Answer` is one of:
    - `{ kind: 'choice', answers: { [questionText]: string } }`: the string is an option label or free text from dictation.
    - `{ kind: 'approve' }` (plans only).
    - `{ kind: 'feedback', text }` (plans only): deny with reason `"The user reviewed the plan on their desk panel and asked for changes: <text>"`.
    - `{ kind: 'vscode' }`: release now with `null`.
  - WS method `claude.prompt.answer { id, answer: Answer }`. Event `claude.prompt.created { id, sessionId, tool, questions | plan, context: Message[] }`, where `context` is the last 6 entries from `readRecentMessages`, so the ask screen shows what led up to the question.

- [ ] **Step 1: Write the failing tests**

```js
test('no panel: returns null immediately', async () => { /* panelOnline=false -> resolves null in < 50 ms */ });
test('choice answer echoes questions and adds answers', async () => {
  // input.tool_input.questions = [{question:'Which framework?', ...}]
  // answer(id, {kind:'choice', answers:{'Which framework?':'React'}})
  // -> hookSpecificOutput: {hookEventName:'PreToolUse', permissionDecision:'allow',
  //    updatedInput:{questions:<same array>, answers:{'Which framework?':'React'}}}
});
test('plan approve returns allow with the input echoed', async () => { /* ... */ });
test('plan feedback returns deny with the reason text containing the feedback', async () => { /* ... */ });
test('hold expires at holdMs and returns null', async () => { /* holdMs: 50 */ });
test('panel disconnect releases held prompts with null within 1 s', async () => { /* releaseAll('panel-offline') */ });
test('second answer for the same id is ignored', async () => { /* first wins */ });
```

- [ ] **Step 2:** Run `npm --prefix mac-service test`: FAIL.
- [ ] **Step 3:** Implement the bridge. Wire `releaseAll` to the same panel-disconnect path Task 2 uses. Remove upstream's AppleScript answer path from `focus.js`/`queue.js` callers for questions and plans.
- [ ] **Step 4:** Run the tests: PASS.
- [ ] **Step 5:** Panel ask screen:
  - It leads with the `context` messages (dimmed, scrollable), then the question, so the owner sees why it was asked.
  - **Questions:** the knob moves between options; press picks. Multi-select toggles with press and confirms with the top button. The last two rows are always **"Say an answer"** (Task 11) and **"Answer in VS Code"**.
  - **Plans:** the plan text scrolls with the knob, then **Approve**, **Say what to change** (Task 11) and **Answer in VS Code**.
  - A thin countdown bar shows the time left in the 120 s hold. When it runs out the card reads "Moved to VS Code".
  - Multiple questions in one call are shown one at a time and sent together.
- [ ] **Step 6:** Run `npm --prefix panel test && npm --prefix panel run build`.
- [ ] **Step 7:** Commit: `feat: answer questions and plans from the panel via PreToolUse hooks`.

### Task 11: Dictation on the panel, transcribed on the Mac

The owner wants to speak a reply, especially to a question. The simulator records from the Mac's microphone. On the Car Thing, whether the built-in mics work under the mainline kernel is a Plan 2 question; a USB mic on the hub is the fallback. Either way the panel code is the same.

**Files:**
- Create:
  - `mac-service/src/dictation.js`
  - `mac-service/test/dictation.test.js`
  - `panel/src/dictation.js`
  - `panel/src/screens/dictate-review.js` (fill in the Task 10 stub)
  - `mac-service/scripts/setup-dictation.sh`
- Modify: `mac-service/src/index.js`, `simulator/scripts/run.js` (Chrome flag `--use-fake-ui-for-media-stream` so the mic prompt can't block the kiosk-like window), `protocol/claude-protocol.md`

**Interfaces:**
- Produces:
  - Mac: `transcribe(audio: Buffer, mime: string, { run = execFile }) -> Promise<string>`. It writes the audio to a temp file, runs `ffmpeg -i <in> -ar 16000 -ac 1 <out>.wav`, then `whisper-cli -m <model> -f <out>.wav -nt -np`, trims the output, and deletes both temp files in a `finally`.
  - Model path from `CLAUDE_PANEL_WHISPER_MODEL`, default `~/.config/claude-panel/ggml-base.en.bin`.
  - WS method `claude.dictation.transcribe { audioBase64, mime } -> { text }`. Reject audio over 30 s or 2 MB with error `'too-long'`. If `whisper-cli` or the model is missing, error `'dictation-not-set-up'`.
  - `setup-dictation.sh`: `brew install whisper-cpp ffmpeg` and downloads `ggml-base.en.bin` into `~/.config/claude-panel/`. **The owner runs it.**
  - Panel: `startRecording() -> Promise<void>`, `stopRecording() -> Promise<{ blob, mime }>`, built on `getUserMedia` + `MediaRecorder` (`audio/webm;codecs=opus`, available in Chrome 69).
  - Panel: `openDictateReview({ title, onSend(text), onCancel })`.

- [ ] **Step 1: Write the failing tests**

```js
test('transcribe runs ffmpeg then whisper and returns trimmed text', async () => { /* fake run records calls; whisper stdout '  Use React.\n' -> 'Use React.' */ });
test('temp files are removed even when whisper fails', async () => { /* ... */ });
test('missing whisper binary -> dictation-not-set-up', async () => { /* run rejects ENOENT */ });
test('over 2 MB -> too-long', async () => { /* ... */ });
```

- [ ] **Step 2:** Run the tests: FAIL.
- [ ] **Step 3:** Implement `dictation.js` and register the method.
- [ ] **Step 4:** Run the tests: PASS.
- [ ] **Step 5:** Panel flow, on any "Say …" row or the top button `m` held on a session's conversation view:
  - Recording starts on press and stops on release (hold to talk). A pulsing mic and elapsed seconds show while recording; it auto-stops at 30 s.
  - "Transcribing…" shows, then the review screen: the text, large, with **Send** (knob press), **Say it again** (hold `m`) and **Cancel** (back).
  - A transcription error shows its plain reason, for example "Dictation isn't set up on the Mac yet."
- [ ] **Step 6:** Owner runs `mac-service/scripts/setup-dictation.sh`. Then `npm run sim`, hold `m`, say a sentence, and check the review screen shows it.
- [ ] **Step 7:** Commit: `feat: hold-to-talk dictation, transcribed locally with whisper.cpp`.

### Task 12: Send a message to a session

A dictated message goes to a session in one of three ways, picked by the session's state:

| Session state | Delivery | What VS Code shows |
|---|---|---|
| Asking a question or plan | Task 10 answer (free text or plan feedback) | the answered question |
| Working | the next `PostToolUse` hook returns it as `additionalContext` | nothing visible; Claude sees a system reminder |
| Idle (finished its turn) | a `Stop` hook with `asyncRewake` waits; when a message arrives it exits 2 with the text, which wakes Claude | nothing visible as a chat bubble; Claude sees a system reminder and replies, and the reply shows in VS Code |

The message is prefixed `"Message from the owner via the desk panel: "` so Claude treats it as the owner's words.

**Files:**
- Create: `mac-service/src/message-bridge.js`, `mac-service/test/message-bridge.test.js`, `mac-service/scripts/rewake-hook.js`
- Modify: `mac-service/src/hub.js`, `mac-service/scripts/install-hooks.js`, `panel/src/screens/session-detail.js`, `protocol/claude-protocol.md`

**Interfaces:**
- Produces:
  - `createMessageBridge({ emit }) -> { send(sessionId, text) -> 'queued', onPostToolUse(input) -> HookOutput|null, waitForIdleMessage(sessionId, signal) -> Promise<string|null>, onUserPromptSubmit(input) }`.
  - At most one pending message per session; a new one replaces the old.
  - `onUserPromptSubmit` drops that session's pending message and emits `claude.message.dropped { sessionId, reason: 'owner-typed' }`.
  - `rewake-hook.js`: the `Stop` hook command, installed with `"asyncRewake": true` and timeout `3600`. It long-polls `GET http://127.0.0.1:8790/hook/rewake?session=<id>` (loopback only). On a message it prints the text to stderr and exits 2; on timeout or a `UserPromptSubmit` it exits 0.
  - WS method `claude.session.send { id, text } -> { delivery: 'answer' | 'next-tool' | 'wake' }` and event `claude.message.delivered { sessionId }`.
  - `install-hooks.js` adds the `PostToolUse` (all tools), `UserPromptSubmit` and `Stop` (asyncRewake) hooks.

- [ ] **Step 1: Write the failing tests**

```js
test('working session: next PostToolUse returns the message as additionalContext once', () => { /* second PostToolUse -> null */ });
test('idle session: waitForIdleMessage resolves with the text when sent', async () => { /* ... */ });
test('owner typing drops the pending message and emits dropped', () => { /* Review Focus 5 */ });
test('a newer message replaces an undelivered one', () => { /* ... */ });
test('waiter aborted by signal resolves null', async () => { /* ... */ });
```

- [ ] **Step 2:** Run the tests: FAIL.
- [ ] **Step 3:** Implement the bridge, the `/hook/rewake` long-poll (loopback-only, same guard as `/hook`) and `rewake-hook.js`.
- [ ] **Step 4:** Run the tests: PASS.
- [ ] **Step 5:** Panel: the conversation view gets a **Say something** action (hold `m`). After Send, a small "Sent" or "Delivered" line appears at the bottom of the conversation; "Dropped because you typed in VS Code" if it was dropped.
- [ ] **Step 6:** Commit: `feat: send dictated messages to working and idle sessions via hooks`.

### Task 13: Verify answering and messaging against real VS Code sessions

**The owner reruns** `node mac-service/scripts/install-hooks.js` (now with the Task 10 and 12 hooks) and restarts VS Code's Claude session.

- [ ] **Step 1:** Ask Claude in a new VS Code session to ask a multiple-choice question. Record:
  - **(e)** whether the question appears on the panel with its context;
  - **(f)** whether picking an option on the panel lets Claude continue with that answer;
  - **(g)** what VS Code shows during the 120 s hold;
  - **(h)** whether a dictated free-text answer is accepted.
- [ ] **Step 2:** In plan mode, check **(i)** Approve from the panel exits plan mode and **(j)** "Say what to change" makes Claude revise.
- [ ] **Step 3:** With the session idle, send a dictated message. Check **(k)** that Claude wakes and replies in VS Code. With a session working, check **(l)** that the message reaches Claude at its next tool call.
- [ ] **Step 4:** Start a panel message, then type in VS Code first. Check **(m)** the panel shows "Dropped" and Claude never gets the stale message.
- [ ] **Step 5:** Any failure in (f), (i) or (k) means that path falls back to "Answer in VS Code"; record it in the spec and tell the owner.
- [ ] **Step 6:** Commit: `docs: record answering and messaging verification results`.
