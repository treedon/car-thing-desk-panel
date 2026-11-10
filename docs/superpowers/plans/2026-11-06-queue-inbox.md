# Queue Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every finished turn of every local Claude Code session becomes a tagged card on the Car Thing's queue (ASKING / UPDATE / ERROR). ASKING and ERROR are loud for 10 minutes. Each card can be switched to or replied to from the dial. Sessions waiting on background work read as busy, and the session view drops tool lines.

**Architecture:**
- **Mac service:** a new `inbox` module owns cards. It holds one per session, persists them, tracks loud expiry and emits `claude.card.*` events. The Stop and StopFailure hooks feed it through `source-hooks.js`. A pure classifier tags each turn, and a pure function derives "waiting on" from the Stop payload's `background_tasks`. A chime module plays a throttled system sound for loud events.
- **Panel:** cards travel as items of kind `card` inside the existing `state.asks` list, so the hero, stack, dial and sync code carry them. Pure helpers decide ordering, loudness, the jump and the input guard.

**Tech Stack:** Node ≥18 ESM with `node:test` (mac-service). ES5-style browser JS for Chrome 69, string-built screens and `node:test` (panel).

**Spec:** `docs/superpowers/specs/2026-11-06-queue-inbox-design.md`. Read it before any task, because tasks cite its sections by name.

## Global Constraints

- Work only in the worktree `/Users/owner/Claude/personal/Spotify_car_thing-queue` on branch `feat/queue-inbox`. Never `git checkout -b` in the main tree, where other sessions are working.
- Don't edit `nucbox/` or anything on `feat/agent-digest`.
- **Panel code style:** ES5 (`var`, `function`, no arrow functions, no template literals) and string-built screens with `esc()` on every interpolated string. CSS: "no flex gap, no inset shorthand, no clamp()". Nothing below 14 px, and nothing read at a glance below 19 px. Use only the existing tokens in `styles.css`.
- Card tag colours must not read as the permission DESTRUCTIVE red.
- **Exact values:**

  | What | Value |
  |---|---|
  | Loud period | `LOUD_MS = 600000` (10 min) |
  | Chime throttle | `CHIME_THROTTLE_MS = 10000` |
  | Jump quiet window | `JUMP_QUIET_MS = 10000` |
  | Input guard | `INPUT_GUARD_MS = 1000` |
  | Ended UPDATE kept | `ENDED_UPDATE_TTL_MS = 7200000` (2 h) |
  | Queue idle exit | `QUEUE_IDLE_EXIT_MS = 60000` |
  | Card text clip | 8000 chars |
  | Excerpt clip | 400 chars |
  | Chime sound | `/System/Library/Sounds/Glass.aiff` via `afplay` |
  | Chime default | **On** |
  | Inbox state file | `.state/inbox.json`, mode `0o600` |

- Nothing new may run inside the hook response path except synchronous, cheap work: no transcript reads and no waiting on child processes.
- Commit after every task with a `feat(queue): …` / `fix(queue): …` / `test(queue): …` message ending in `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Test commands: mac-service `cd mac-service && CLAUDE_THING_HOLD_MS=200 node --test test/<file>.test.js`; panel `cd panel && node --test test/<file>.test.js`; everything `npm test` at the worktree root.

## Review Focus

1. **A burst of finished turns** (three sessions stop within 2 s): one chime, a stable order, and the hero isn't pulled away from a card the owner touched in the last 10 s. The test lives in Task 12.
2. **A card replaced or cleared while it is the hero or being replied to:** the cursor follows that session's new card, and a reply sent after its card vanished still goes to the session. Tests in Tasks 9 and 11.
3. **Odd message text** (empty, only a code block, very long, containing HTML): it's tagged UPDATE and shown escaped and clipped, with a "finished with no message" excerpt when empty. Tests in Tasks 1 and 10.
4. **A Mac service restart with saved cards:**
   - A card past `loudUntil` comes back quiet.
   - A corrupt `inbox.json` reads as empty.
   - Cards whose sessions never reappear follow the session-ended rule.

   Tests in Task 3.
5. **Panel reconnect (`claude.queue.sync`):** cards reconcile with no duplicates and no re-jump. A card re-sent with `loud: false` never jumps or chimes. Tests in Tasks 9 and 5.

---

### Task 0: Confirm the Stop payload on this Mac

The spec's "Verify first" section. There's no code, and the results decide whether Task 2 ships.

**Files:**
- Modify: `docs/superpowers/specs/2026-11-06-queue-inbox-design.md` (append results under "Verify first")

- [ ] **Step 1: Capture a Stop payload with a background shell running**

```bash
S=/private/tmp/claude-501/-Users-owner-Claude-personal-Spotify-car-thing/f47b1825-f7e2-434d-829a-cd067f36dcf0/scratchpad/stopcheck
mkdir -p "$S" && cd "$S"
claude -p --settings "{\"hooks\":{\"Stop\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"cat >> $S/stop.jsonl; echo >> $S/stop.jsonl\"}]}]}}" \
  "Start \`sleep 45\` as a background shell (run_in_background), then end your turn with one yes/no question to me."
```

This briefly adds a session to the panel's grid and costs one short turn of plan usage.

- [ ] **Step 2: Read the field names and values**

Run: `python3 -I -c "import json,sys; [print(sorted(json.loads(l).keys()), json.loads(l).get('background_tasks'), repr(json.loads(l).get('last_assistant_message',''))[:120]) for l in open('$S/stop.jsonl') if l.strip()]"`

Expected: keys include `last_assistant_message` and `background_tasks`, the first Stop lists one `shell` task whose `command` contains `sleep 45`, and the message ends in `?`.

- [ ] **Step 3: Record the result in the spec under "Verify first"**

Add one dated line per check, with what was seen. **If `last_assistant_message` or `background_tasks` is missing, stop here and report to the owner.** Per the spec, "waiting on a run" is then cut, and Task 2 waits for their answer.

- [ ] **Step 4: Commit** — `docs(queue): Stop payload checked on 2.1.220`

---

### Task 1: Turn classifier

**Files:**
- Create: `mac-service/src/turn-tag.js`
- Test: `mac-service/test/turn-tag.test.js`

**Interfaces:**
- Produces:
  - `stripCode(text: string): string`: fenced blocks and inline code removed.
  - `lastParagraph(text: string): string`: the last non-empty blank-line-separated paragraph of `stripCode(text)`, trimmed. `''` if none.
  - `tagTurn(text: string): 'asking' | 'update'`
  - `excerptOf(text: string): string`: `lastParagraph(text)` clipped to 400 chars with `…`, or `'finished with no message'` when empty.

- [ ] **Step 1: Write the failing tests**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tagTurn, lastParagraph, excerptOf } from '../src/turn-tag.js';

test('a closing question is ASKING', () => {
  assert.equal(tagTurn('Done.\n\nWant me to commit this?'), 'asking');
  assert.equal(tagTurn('Should I push it?"'), 'asking');
  assert.equal(tagTurn('Ready — **merge now?**'), 'asking');
});
test('a report is UPDATE', () => {
  assert.equal(tagTurn('Tests pass. Committed as abc123.'), 'update');
  assert.equal(tagTurn('Let me know if you want changes.'), 'update');
  assert.equal(tagTurn(''), 'update');
});
test('question marks inside code do not count', () => {
  assert.equal(tagTurn('Run this:\n\n```\nls ?\n```'), 'update');
  assert.equal(tagTurn('The regex is `a?b`.'), 'update');
});
test('only the last paragraph decides', () => {
  assert.equal(tagTurn('Why did it fail?\n\nIt was the cache. Fixed and pushed.'), 'update');
  assert.equal(tagTurn('Want this?\n\n```\ncode\n```'), 'asking');
});
test('excerpt is the last paragraph, clipped, never empty', () => {
  assert.equal(lastParagraph('a\n\nb\n'), 'b');
  assert.equal(excerptOf(''), 'finished with no message');
  assert.equal(excerptOf('x'.repeat(500)).length, 401);
});
```

- [ ] **Step 2: Run to verify it fails** — `node --test test/turn-tag.test.js`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement `mac-service/src/turn-tag.js`**

ASKING when the last paragraph matches `/\?["'”’)\]*_]*(?=\s|$)/`. A code-only last paragraph is skipped, because `stripCode` removes it before the paragraphs are split.

- [ ] **Step 4: Run to verify it passes** — Expected: PASS.

- [ ] **Step 5: Commit** — `feat(queue): tag a finished turn as asking or update`

---

### Task 2: Waiting on a run

**Files:**
- Create: `mac-service/src/sessions/waiting-on.js`
- Modify: `mac-service/src/sessions/store.js` (`deriveState`, `summary`)
- Modify: `mac-service/src/sessions/source-hooks.js` (Stop, UserPromptSubmit, PreToolUse)
- Test: `mac-service/test/waiting-on.test.js`, `mac-service/test/store.test.js`, `mac-service/test/source-hooks.test.js`

**Interfaces:**
- Produces:
  - `waitingOnFrom(payload: object, nowMs: number): Array<{type: string, label: string, since: number}>`
  - Session summary/detail gains `waitingOn: Array<{type, label, since}>` (`[]` when none).

- [ ] **Step 1: Write the failing tests**

```js
// waiting-on.test.js
test('each background task becomes a labelled entry', () => {
  const w = waitingOnFrom({ background_tasks: [
    { id: '1', type: 'shell', status: 'running', description: 'tests', command: 'npm test -- --watch=false' },
    { id: '2', type: 'subagent', status: 'running', description: 'Review diff', agent_type: 'general-purpose' },
  ] }, 5000);
  assert.deepEqual(w.map((e) => e.label), ['npm test -- --watch=false', 'Review diff']);
  assert.ok(w.every((e) => e.since === 5000));
});
test('labels are capped at 60 chars', () => {
  const w = waitingOnFrom({ background_tasks: [{ id: '1', type: 'shell', command: 'x'.repeat(90) }] }, 0);
  assert.equal(w[0].label.length, 60);
});
test('a one-shot wakeup waits; a recurring cron does not', () => {
  assert.equal(waitingOnFrom({ session_crons: [{ id: 'c', schedule: '40 15 6 11 *', recurring: false, prompt: 'p' }] }, 0)[0].label, 'wakes at 15:40');
  assert.deepEqual(waitingOnFrom({ session_crons: [{ id: 'c', schedule: '*/20 * * * *', recurring: true, prompt: 'p' }] }, 0), []);
});
test('missing fields mean nothing in flight', () => {
  assert.deepEqual(waitingOnFrom({}, 0), []);
});
// source-hooks.test.js
test('a turn ending with background work reads busy, not celebrate, until the next prompt', () => {
  const store = createStore();
  const { onHookEvent } = startHooksSource({ store });
  onHookEvent('SessionStart', { session_id: 'w-1', cwd: '/p' });
  onHookEvent('Stop', { session_id: 'w-1', cwd: '/p', background_tasks: [{ id: '1', type: 'shell', command: 'npm test' }] });
  assert.equal(store.get('w-1').state, 'busy');
  assert.equal(store.get('w-1').waitingOn[0].label, 'npm test');
  onHookEvent('UserPromptSubmit', { session_id: 'w-1', cwd: '/p', prompt: 'next' });
  assert.deepEqual(store.get('w-1').waitingOn, []);
});
test('a later Stop with nothing in flight celebrates', () => { /* Stop with tasks, then Stop with background_tasks: [] → state 'celebrate' */ });
```

- [ ] **Step 2: Run to verify they fail** — Expected: FAIL.

- [ ] **Step 3: Implement**
  - **`waitingOnFrom`:**
    - A task's label is the first of `command`, `description`, `agent_type`, `name`, `type`, sliced to 60 characters.
    - A cron with `recurring === false` whose first two schedule fields are integers is labelled `wakes at H:MM`. Other one-shots are labelled `scheduled wakeup`.
  - **`store.js`:**
    - `deriveState` returns `'busy'` when `s.waitingOn && s.waitingOn.length`. This check goes after the attention check and before celebrate.
    - `summary()` adds `waitingOn: s.waitingOn || []`.
  - **`source-hooks.js`:**
    - Stop writes `waitingOn: waitingOnFrom(payload, Date.now())` in its existing `store.touch`.
    - UserPromptSubmit and PreToolUse write `waitingOn: []`.

- [ ] **Step 4: Run** `node --test test/waiting-on.test.js test/store.test.js test/source-hooks.test.js`. Expected: PASS, with the existing tests still passing.

- [ ] **Step 5: Commit** — `feat(queue): a session waiting on background work reads busy`

---

### Task 3: The inbox

**Files:**
- Create: `mac-service/src/inbox.js`
- Modify: `mac-service/src/persist.js` (`writeState(name, value, { mode } = {})`)
- Test: `mac-service/test/inbox.test.js`, `mac-service/test/persist.test.js`

**Interfaces:**
- Consumes: `excerptOf` (Task 1).
- Produces:
  - **`createInbox({ emit, now = Date.now, read = () => null, write = () => {}, onLoud = () => {} })`** returns an object with:
    - `post({ sessionId, sessionName, host, tag, text, intent, stoppedTs }): Card`. It replaces any card of that session, emits `claude.card.posted`, calls `onLoud(card)` when `card.loud`, then writes.
    - `clear(sessionId, reason): boolean` and `clearById(id, reason): boolean`. Each emits `claude.card.cleared` `{ id, sessionId, reason }`.
    - `onSessionEnd(sessionId): void`. It clears ASKING and ERROR cards (reason `'ended'`), and stamps UPDATE cards `endedTs = now()`.
    - `retireMissing(liveIds: Set<string>): void`. It applies `onSessionEnd` to every card whose session isn't in `liveIds`.
    - `tick(): void`. Cards past `loudUntil` flip to `loud: false` and are re-emitted on `claude.card.posted` without calling `onLoud`. UPDATE cards past `endedTs + ENDED_UPDATE_TTL_MS` are cleared (reason `'expired'`).
    - `list(): Card[]`
    - `attachSummary(sessionId, turnEndTs, { headline, bullets }): boolean`. It sets `card.summary` only when `|card.stoppedTs - turnEndTs| <= SUMMARY_MATCH_MS`, then re-emits without `onLoud`.
  - **The `Card` shape:** `{ kind: 'card', id: 'card:<sessionId>:<stoppedTs>', sessionId, sessionName, host, tag: 'asking'|'update'|'error', text (≤8000), excerpt, intent, createdTs, stoppedTs, loud, loudUntil, endedTs: null|number, summary: null|{headline, bullets} }`.
    - `loud` is true for `asking` and `error`.
    - `loudUntil = createdTs + LOUD_MS`, or `0` when not loud.
  - **Exported constants:** `LOUD_MS = 600000`, `ENDED_UPDATE_TTL_MS = 7200000`, `SUMMARY_MATCH_MS = 120000`.
  - **Persistence:** `write({ cards })` after every change. On create, `read()` restores the cards; a restored card past `loudUntil` comes back `loud: false`, and a non-array read is treated as empty.

- [ ] **Step 1: Message the digest session about the seam (non-blocking)**

Use SendMessage to `spotify-car-thing-86` with: the `attachSummary(sessionId, turnEndTs, {headline, bullets})` signature, the rule that it's called only for model-written summaries, the 120 s match tolerance, and the fact that it never chimes, jumps or re-sorts. Ask them to reply if it conflicts with their design. Build as specified. If they reply with a conflict, bring it to the owner before changing anything.

- [ ] **Step 2: Write the failing tests** (fake clock `let t = 1_000_000; const now = () => t;`)

```js
test('one card per session; a newer turn replaces it', () => { /* post twice for s1 → list().length 1, second text; events: posted, cleared(reason 'replaced'), posted */ });
test('asking and error are loud for 10 minutes, update never', () => {
  const ib = make(); const a = ib.post(turn('s1', 'asking'));
  assert.equal(a.loud, true); assert.equal(a.loudUntil, t + 600000);
  assert.equal(ib.post(turn('s2', 'update')).loud, false);
  t += 600001; ib.tick();
  assert.equal(ib.list().find((c) => c.sessionId === 's1').loud, false);
  assert.equal(loudCalls, 1, 'going quiet never calls onLoud');
});
test('session end: asking goes at once, update stays 2 hours', () => { /* onSessionEnd; asking cleared 'ended'; update has endedTs; t += 7200001; tick → cleared 'expired' */ });
test('restore: quiet past loudUntil, corrupt state reads empty', () => {
  const saved = { cards: [{ ...cardFixture, loud: true, loudUntil: t - 1 }] };
  assert.equal(createInbox({ emit() {}, now, read: () => saved }).list()[0].loud, false);
  assert.deepEqual(createInbox({ emit() {}, now, read: () => 'garbage' }).list(), []);
});
test('retireMissing ends cards whose sessions never came back', () => { /* posted for s1,s2; retireMissing(new Set(['s2'])) → s1 asking cleared */ });
test('attachSummary only lands on the same turn', () => {
  /* card stoppedTs = t; attachSummary(s1, t - 300000, …) → false, summary null;
     attachSummary(s1, t + 5000, {headline:'h', bullets:['b']}) → true; no onLoud */
});
test('text is clipped to 8000 and the excerpt is computed', () => { /* post 9000-char text → text.length 8001 (with …), excerpt from excerptOf */ });
// persist.test.js
test('writeState honours a file mode', () => { /* writeState('m', {a:1}, {mode: 0o600}) → (stat.mode & 0o777) === 0o600 */ });
```

- [ ] **Step 3: Run to verify they fail** — Expected: FAIL.

- [ ] **Step 4: Implement `inbox.js` and the `persist.js` mode option** (`fs.writeFileSync(tmp, json, { mode })`)

- [ ] **Step 5: Run** `node --test test/inbox.test.js test/persist.test.js`. Expected: PASS.

- [ ] **Step 6: Commit** — `feat(queue): an inbox of one card per session, loud for ten minutes`

---

### Task 4: Hooks feed the inbox

**Files:**
- Modify: `mac-service/src/sessions/source-hooks.js`
- Modify: `mac-service/src/sessions/index.js` (`createSources({ store, permissionBridge, queue, inbox })` passes `inbox` to `startHooksSource`)
- Modify: `mac-service/src/sessions/recent-messages.js` (add `lastAssistantText`)
- Modify: `mac-service/scripts/install-hooks.js` (`StopFailure: httpHook(5)`)
- Test: `mac-service/test/source-hooks.test.js`, `mac-service/test/recent-messages.test.js`, `mac-service/test/install-hooks.test.js`

**Interfaces:**
- Consumes: `tagTurn` (Task 1), `waitingOnFrom` (Task 2), and `inbox.post/clear/onSessionEnd` (Task 3).
- Produces:
  - `startHooksSource({ store, queue, inbox, readLastText = lastAssistantText, defer = setImmediate })`
  - `lastAssistantText(jsonlPath: string): string`: the text of the last `assistant` record that has text, or `''`.
  - `promptLine(text: string): string`, exported from `source-hooks.js`: whitespace collapsed, trimmed, sliced to 120. UserPromptSubmit now uses it for `lastPrompt`.

- [ ] **Step 1: Write the failing tests** (a stub inbox records calls)

```js
test('Stop posts the turn with its tag, name and intent', () => {
  /* SessionStart; UserPromptSubmit prompt 'fix it'; Stop last_assistant_message 'Done. Push it?'
     → inbox.post called once: tag 'asking', text 'Done. Push it?', intent 'you asked: fix it' */
});
test('a Stop continued by a hook (panel reply) still posts', () => { /* stop_hook_active: true → post called */ });
test('an UPDATE turn with background work posts nothing; an ASKING one still posts', () => { /* … */ });
test('a Stop without last_assistant_message reads the transcript after the response', () => {
  /* defer collects fns; post not called synchronously; run deferred → post with readLastText's value */
});
test('StopFailure posts an error card', () => { /* error 'rate_limit' + last_assistant_message 'partial' → tag 'error', text contains both */ });
test('typing in the session clears its card; ending it calls onSessionEnd', () => { /* … */ });
test("the daemon's own sessions never post", () => { /* markOwnSession; Stop → no post */ });
// recent-messages.test.js
test('lastAssistantText returns the newest assistant text', () => { /* fixture jsonl with two assistant records → second text */ });
// install-hooks.test.js
test('installs a StopFailure http hook', () => { /* s.hooks.StopFailure includes ':8790/hook' */ });
```

- [ ] **Step 2: Run to verify they fail** — Expected: FAIL.

- [ ] **Step 3: Implement**
  - **Stop:**
    - Build `{ sessionId, sessionName: store.get(id).name, host: store.raw(id).host, tag, text, intent, stoppedTs }`.
    - `intent` is `'you asked: ' + lastPrompt`, or `''` when there's no `lastPrompt`.
    - When `typeof payload.last_assistant_message !== 'string'`, call `defer(() => post with readLastText(payload.transcript_path))` instead.
    - Skip the post when `waitingOn.length && tag === 'update'`.
  - **StopFailure:**
    - Touch the store the way Stop does, with no `waitingOn`.
    - Post `tag: 'error'`. The text is the error's string form (a string as-is; an object's `.message || .type`), then `error_details`, then `last_assistant_message`, joined by blank lines.
  - **UserPromptSubmit:** `inbox.clear(id, 'typed')`.
  - **SessionEnd:** `inbox.onSessionEnd(id)`.

- [ ] **Step 4: Run** `node --test test/source-hooks.test.js test/recent-messages.test.js test/install-hooks.test.js`. Expected: PASS.

- [ ] **Step 5: Commit** — `feat(queue): every finished turn posts a card`

---

### Task 5: Chime and service prefs

**Files:**
- Create: `mac-service/src/chime.js`, `mac-service/src/service-prefs.js`
- Test: `mac-service/test/chime.test.js`, `mac-service/test/service-prefs.test.js`

**Interfaces:**
- Produces:
  - `CHIME_SOUND = '/System/Library/Sounds/Glass.aiff'`, `CHIME_THROTTLE_MS = 10000`, `LOUD_TOPICS = ['claude.permission.request', 'claude.prompt.created', 'claude.question.request']`
  - `createChime({ spawn = child_process.spawn, now = Date.now, enabled = () => true }) → { ring(): boolean }`. It spawns `afplay [CHIME_SOUND]` with `{ detached: true, stdio: 'ignore' }`, calls `.unref()`, and returns whether it played.
  - `createServicePrefs({ read = () => null, write = () => {} }) → { get(): { chime: boolean }, set(patch): { chime: boolean } }`. The default is `{ chime: true }`. `set` keeps only known boolean keys and writes.

- [ ] **Step 1: Write the failing tests**

```js
test('one chime per 10 s however many ask', () => { /* ring ×3 at t, t+2000, t+9999 → spawn called once; t+10000 → twice */ });
test('off means silent', () => { /* enabled: () => false → ring() false, no spawn */ });
test('spawn failure never throws', () => { /* spawn throws → ring() returns false */ });
test('prefs default chime on and ignore unknown keys', () => { /* get().chime true; set({chime:false, x:1}) → {chime:false}; write called with {chime:false} */ });
```

- [ ] **Step 2: Run to verify they fail**, then **Step 3: Implement**, then **Step 4: Run to verify they pass**. Expected: PASS.

- [ ] **Step 5: Commit** — `feat(queue): a throttled Mac chime and its setting`

---

### Task 6: Back-and-forth replies

**Files:**
- Modify: `mac-service/scripts/rewake-hook.js` (drop the `input.stop_hook_active` exit)
- Modify: `mac-service/src/message-bridge.js` (`createMessageBridge({ emit, onDelivered = () => {} })`)
- Test: `mac-service/test/rewake-hook.test.js`, `mac-service/test/message-bridge.test.js`

**Interfaces:**
- Produces: `onDelivered(sessionId: string, text: string)`, called on every delivery (`wake` and `next-tool`) with the owner's words, minus `MESSAGE_PREFIX`.

- [ ] **Step 1: Update and add the tests**

```js
// rewake-hook.test.js — replaces 'a re-entered Stop (stop_hook_active) or no session does not poll'
test('a Stop after a woken turn polls again, so a second reply can land', async () => {
  const s = await stub((req, res) => { res.writeHead(200); res.end('again'); });
  assert.equal((await runHook(s.port, { session_id: 'abc', stop_hook_active: true })).code, 2);
  s.server.close();
});
test('no session does not poll', async () => { /* {} → code 0, nothing seen */ });
// message-bridge.test.js
test('delivery reports the plain words', () => {
  /* send to a waiting session → onDelivered('s', 'hello'); send to a working one then onPostToolUse → onDelivered again */
});
```

- [ ] **Step 2: Run to verify they fail**, then **Step 3: Implement**, then **Step 4: Run to verify they pass**.

- [ ] **Step 5: Commit** — `feat(queue): replies from the panel can go back and forth`

---

### Task 7: Wire it into the service

**Files:**
- Modify: `mac-service/src/index.js`

**Interfaces:**
- Consumes: Tasks 3–6 (`createInbox`, `createChime`, `LOUD_TOPICS`, `createServicePrefs`, `promptLine`, `onDelivered`).
- Produces:
  - **New methods:**
    - `claude.card.clear({ id }) → { ok }`
    - `claude.prefs.get() → { chime }`
    - `claude.prefs.set({ chime }) → { chime }`
  - **`claude.queue.list` and `claude.queue.sync`:** both carry the cards inside `asks`.
  - **Events:** `claude.card.posted` (Card) and `claude.card.cleared` (`{ id, sessionId, reason }`).

- [ ] **Step 1: Implement the wiring**
  - **Creating the modules:**
    - `servicePrefs = createServicePrefs({ read: () => readState('prefs'), write: (v) => writeState('prefs', v) })`
    - `chime = createChime({ enabled: () => servicePrefs.get().chime })`
    - `inbox = createInbox({ emit: hub.emit, read: () => readState('inbox'), write: (v) => writeState('inbox', v, { mode: 0o600 }), onLoud: () => chime.ring() })`
  - **Chiming for the existing asks:** `const emit = (topic, data) => { hub.emit(topic, data); if (LOUD_TOPICS.includes(topic)) chime.ring(); }`. Pass this `emit` to `createQueue`, `createPermissionBridge` and `createQuestionBridge`.
  - **Replies set the intent line:** `createMessageBridge({ emit: hub.emit, onDelivered: (id, text) => store.touch(id, { lastPrompt: promptLine(text) }) })`
  - **Sources:** `createSources({ store, permissionBridge, queue, inbox })`.
  - **Snapshot:** `queueSnapshot()` appends `...inbox.list()` to `asks`.
  - **Timers:** `setInterval(inbox.tick, 15000).unref()` and `setTimeout(() => inbox.retireMissing(new Set([...store.entries()].map(([id]) => id))), 60000).unref()`. `store.entries()` is iterable, as the subagent refresh loop already uses it.
  - **Clearing on action:**
    - `claude.session.focus` calls `inbox.clear(id, 'switched')` when the result has `focused: true`.
    - `claude.session.send` calls `inbox.clear(id, 'replied')` when the delivery is `wake`, `next-tool` or `answer`.
  - **Shutdown:** nothing to stop (the timers are `unref`'d).

- [ ] **Step 2: Run the whole service suite** `cd mac-service && npm test`. Expected: all PASS.

- [ ] **Step 3: Smoke-run with mock sessions on spare ports**

Run: `cd mac-service && CLAUDE_THING_PORT=8799 CLAUDE_THING_MOCK=1 CLAUDE_THING_STATE_DIR=$(mktemp -d) timeout 8 node src/index.js`, then, in parallel, `curl -s -XPOST localhost:8799/hook -d '{"hook_event_name":"Stop","session_id":"x","last_assistant_message":"Ok?"}'`.

Expected: the log shows the daemon starting, with no crash. In mock mode the hook is ignored, so this only proves the wiring loads. Live posting is checked in Task 14.

- [ ] **Step 4: Commit** — `feat(queue): the service serves cards, chimes and the chime setting`

---

### Task 8: The cleaner session view

**Files:**
- Modify: `mac-service/src/sessions/recent-messages.js` (`readRecentMessages(path, { limit, maxBytes, conversationOnly = false })`)
- Modify: `mac-service/src/index.js` (`claude.session.messages` passes `conversationOnly: true`)
- Modify: `panel/src/screens/conversation.js` (a user message with `fromPanel` gets a small "from the panel" label)
- Test: `mac-service/test/recent-messages.test.js`, `panel/test/conversation.test.js`

**Interfaces:**
- Produces: with `conversationOnly`, messages are `{ role: 'user'|'assistant', text, ts, fromPanel?: true }`.
  - There are no `tool` entries.
  - A `user` record with `origin.kind === 'task-notification'` is dropped, unless its text contains `MESSAGE_PREFIX`. In that case it's kept as `{ role: 'user', text: <text after the prefix>, fromPanel: true }`.
  - The filter runs **before** the `limit` slice. The subagent feed's call is unchanged.

- [ ] **Step 1: Write the failing tests**

```js
test('conversation only: no tool lines, no task notices, panel replies kept', () => {
  /* fixture: user prompt, assistant text + tool_use, user task-notification 'Background command done',
     user task-notification containing MESSAGE_PREFIX + 'ship it' →
     roles ['user','assistant','user'], last.text 'ship it', last.fromPanel true */
});
test('the default still lists tool lines for the subagent feed', () => { /* same fixture without option → includes role 'tool' */ });
test('limit counts conversation messages, not dropped tool lines', () => { /* 50 tool records + 3 texts, limit 3 → 3 texts */ });
// panel conversation.test.js
test('a reply sent from the panel is labelled', () => { /* renderConversation([{role:'user', text:'ship it', fromPanel:true}]) includes 'from the panel' */ });
```

- [ ] **Step 2: Run to verify they fail**, then **Step 3: Implement**, then **Step 4: Run to verify they pass**.

- [ ] **Step 5: Commit** — `feat(queue): the session view shows only what was said`

---

### Task 9: Panel inbox model

**Files:**
- Create: `panel/src/inbox.js`
- Modify: `panel/src/store.js` (`upsertCard`; `pushAsk` and `reconcileAsks` keep the queue ordered and the hero by id)
- Modify: `panel/src/main.js` (`ws.on('claude.card.posted')`, `ws.on('claude.card.cleared')`, edge and `display.asks` use `loudCount`)
- Test: `panel/test/inbox.test.js`

**Interfaces:**
- Consumes: `Card` from Task 3 and the events from Task 7.
- Produces (`panel/src/inbox.js`):
  - `isCard(a): boolean`
  - `isLoud(a): boolean`, meaning `!a.expired && (a.kind !== 'card' || !!a.loud)`
  - `loudCount(asks): number`
  - `orderQueue(asks): asks`, a new array:
    - non-cards first, in their existing relative order;
    - then ASKING and ERROR cards, oldest `createdTs` first;
    - then UPDATE cards, newest first.
  - `queueCounts(asks): { waiting: number, updates: number }`
- Produces (`store.js`): `upsertCard(card)`. It drops any other card with the same `sessionId`, replaces a same-`id` card in place, and otherwise inserts. It re-orders, and keeps `queueIndex` on the same hero `id`. If the hero was this session's old card, the cursor moves to the new card.

- [ ] **Step 1: Write the failing tests**

```js
test('order: blocking asks, then asking/error oldest first, then updates newest first', () => { /* … */ });
test('loudCount ignores quiet cards and expired asks', () => { /* … */ });
test('a replaced hero card keeps the cursor on its session', () => {
  /* asks [perm, card s1 (hero, index 1), card s2]; upsertCard(new card for s1) → hero.sessionId 's1', new id */
});
test('a card re-sent quiet updates in place without moving the cursor', () => { /* same id, loud false → same index, loud false */ });
test('queue.sync with cards does not duplicate them', () => { /* reconcileAsks([card]) twice → one card */ });
```

- [ ] **Step 2: Run to verify they fail**, then **Step 3: Implement**.
  - **`claude.card.posted`:** `var isNew = !store.getAsk(card.id); store.upsertCard(card); if (isNew && card.loud) surface(card) else scheduleRender()`.
  - **`claude.card.cleared`:** `store.resolveAsk(d.id)`.
  - **The edge and screen power:** the edge's `blocked` and `display.asks(n)` both use `loudCount(st.asks)`.

- [ ] **Step 4: Run** `node --test test/inbox.test.js test/queue-sync.test.js`. Expected: PASS.

- [ ] **Step 5: Commit** — `feat(queue): the panel keeps cards in the queue, ordered by how much they need you`

---

### Task 10: Card on the queue screen

**Files:**
- Modify: `panel/src/screens/queue.js` (card hero, card stack row, footer, empty state)
- Modify: `panel/src/styles.css` (`.qhero.card`, `.qhero.card.asking|update|error`, `.qnucbox`)
- Test: `panel/test/screens.test.js`

**Interfaces:**
- Consumes: `queueCounts`, `isCard` (Task 9) and `state.chimeOn` (Task 13; render `''` for the row while it is `null`).
- Produces:
  - **The card hero:** `data-action="queue-open" data-id="<sessionId>"`, with chips `data-action="queue-switch" | "queue-reply" | "queue-clear"`.
  - **The empty-state row:** `data-action="toggle-chime"`.

- [ ] **Step 1: Write the failing tests** (exact copy is pinned here)

```js
test('an asking card hero shows the tag, session, intent, excerpt and three actions', () => {
  const html = renderQueue(baseState({ asks: [card({ tag: 'asking', excerpt: 'Push it?', intent: 'you asked: fix', sessionName: 'proj' })] }));
  for (const s of ['CLAUDE IS ASKING', 'proj', 'you asked: fix', 'Push it?', 'SWITCH', 'press dial', 'REPLY', 'hold top', 'CLEAR', 'preset 4']) assert.ok(html.includes(s), s);
});
test('update and error cards say so', () => { /* 'UPDATE', 'STOPPED ON AN ERROR' */ });
test('a NucBox summary replaces the excerpt and is marked', () => { /* summary {headline:'H', bullets:['b1']} → 'H', 'b1', 'NUCBOX', not excerpt */ });
test('card text is escaped', () => { /* excerpt '<img src=x>' → no '<img' */ });
test('footer separates waiting from updates', () => { /* 1 perm + 1 asking + 2 updates → '2 waiting on you · 2 updates' */ });
test('empty queue names finished turns and shows the chime row', () => {
  const html = renderQueue(baseState({ asks: [], chimeOn: true }));
  assert.ok(html.includes('permissions, questions and finished turns land here'));
  assert.ok(html.includes('Chime on the Mac: On'));
});
test('a card stack row says ASKING or UPDATE', () => { /* … */ });
```

- [ ] **Step 2: Run to verify they fail**, then **Step 3: Implement**.
  - **The kind line:** `CLAUDE IS ASKING` / `UPDATE` / `STOPPED ON AN ERROR`.
  - **The wait label:** `waiting 4m` for loud cards, `finished 4m ago` for the rest.
  - **The summary:** the headline plus up to 3 bullets, replacing the excerpt.
  - **The chime row's subtitle:** `Plays when a session needs you` (On) or `The Mac stays quiet` (Off).
  - **The footer:** omit a zero part of `N waiting on you · M updates`.

- [ ] **Step 4: Run** `node --test test/screens.test.js`. Expected: PASS.

- [ ] **Step 5: Commit** — `feat(queue): cards on the queue screen`

---

### Task 11: Card actions

**Files:**
- Modify: `panel/src/main.js` (`select`, `m-hold`, `deny`/preset 4, and `tap` for `queue-open|queue-switch|queue-reply|queue-clear` on a card hero)
- Modify: `panel/src/shell.js` (no change in routing is expected: `cardOnScreen` already returns true for any queue hero; confirm with a test)
- Test: `panel/test/shell.test.js`, `panel/test/message.test.js` (or a new `panel/test/card-actions.test.js` if `message.test.js` doesn't fit)

**Interfaces:**
- Consumes:
  - `claude.session.focus`, `claude.session.send` and `claude.card.clear` (Task 7)
  - `openDictateReview`, `messageStatusText`
- Produces: `replyToCard(card)` in `main.js`. It's the dictate-review flow titled `'Reply to ' + sessionName`. On Send it returns to `#/queue` and sends to `card.sessionId` **by session**, so a card replaced or cleared mid-dictation doesn't block the reply. A `delivery` of `wake`, `next-tool` or `answer` toasts `SENT`. Anything else toasts the matching `messageStatusText` copy.

- [ ] **Step 1: Write the failing tests** for what is testable without the DOM

```js
test('preset 4 on a card hero is the context action, not navigation', () => {
  assert.equal(presetTarget('4', 'queue', cardOnScreen('queue', { kind: 'card' }, null)), 'deny');
});
```

Keep anything in `main.js` that holds a decision, such as which delivery counts as sent, in a small exported pure function (`replySent(delivery): boolean` in `panel/src/inbox.js`) and test it there.

- [ ] **Step 2: Run to verify it fails**, then **Step 3: Implement**:
  - **select on a card hero:** `focusSession(sessionId)` and toast `OPENING ON THE MAC`.
  - **m-hold on the queue with a card hero:** `replyToCard(hero)`.
  - **deny on a card hero:** `store.resolveAsk(id)`, `ws.request('claude.card.clear', { id })`, toast `CLEARED`.
  - **The `queue-open` tap:** `openSession(sessionId)`.

- [ ] **Step 4: Run** `npm --prefix panel test`. Expected: PASS.

- [ ] **Step 5: Commit** — `feat(queue): switch, reply to and clear a card from the dial`

---

### Task 12: The jump, the input guard and handing back to the grid

**Files:**
- Create: `panel/src/jump.js`
- Modify: `panel/src/main.js` (`surface`, the input gate wrapper, the 1 s interval, and removal of the `armQueueIdleExit` timer in favour of `queueIdleExitDue`)
- Test: `panel/test/jump.test.js`

**Interfaces:**
- Produces (`panel/src/jump.js`):
  - `JUMP_QUIET_MS = 10000`, `INPUT_GUARD_MS = 1000`, `QUEUE_IDLE_EXIT_MS = 60000`
  - `jumpNow({ routeName, msSinceInput, queueAnswering, homeAdjusting }): boolean`. It's false on `dictate`, `prompt` and `ask`, while answering or dimming, or within `JUMP_QUIET_MS` of input. Otherwise it's true.
  - `createInputGuard(now) → { arm(): void, blocks(action: string): boolean }`. For `INPUT_GUARD_MS` after `arm()`, it blocks `select`, `preset`, `deny` and `tap`.
  - `queueIdleExitDue({ routeName, loud, msSinceInput, inflight }): boolean`. It's true when on `queue`, `loud === 0`, nothing is in flight, and `msSinceInput >= QUEUE_IDLE_EXIT_MS`.

- [ ] **Step 1: Write the failing tests**

```js
test('no jump mid-action or within 10 s of input', () => {
  assert.equal(jumpNow({ routeName: 'home', msSinceInput: 3000 }), false);
  assert.equal(jumpNow({ routeName: 'home', msSinceInput: 10000 }), true);
  assert.equal(jumpNow({ routeName: 'dictate', msSinceInput: 1e9 }), false);
  assert.equal(jumpNow({ routeName: 'queue', msSinceInput: 1e9, queueAnswering: true }), false);
});
test('the guard swallows presses for one second after a jump', () => {
  let t = 0; const g = createInputGuard(() => t); g.arm();
  assert.equal(g.blocks('select'), true); assert.equal(g.blocks('dial'), false);
  t = 1000; assert.equal(g.blocks('select'), false);
});
test('the queue hands back only when nothing is loud and a minute passed without input', () => {
  assert.equal(queueIdleExitDue({ routeName: 'queue', loud: 0, msSinceInput: 60000 }), true);
  assert.equal(queueIdleExitDue({ routeName: 'queue', loud: 1, msSinceInput: 1e9 }), false);
  assert.equal(queueIdleExitDue({ routeName: 'queue', loud: 0, msSinceInput: 59999 }), false);
});
test('a burst of loud arrivals with recent input never moves the cursor', () => {
  /* three loud cards within 2 s while routeName 'queue', msSinceInput 4000 → jumpNow false for each */
});
```

- [ ] **Step 2: Run to verify they fail**, then **Step 3: Implement in `main.js`**
  - **The input gate:** wrap it with `setGate(function (a, s) { lastInputTs = Date.now(); if (guard.blocks(a)) return false; return display.gate(a, s); })`. If the existing gate must run first to wake a dark screen, put the guard after it, so a wake-swallowed press is still swallowed.
  - **`surface(item)`:**
    - The held-prompt branch is unchanged, plus `guard.arm()` after `openPrompt`.
    - If `!isLoud(item)`, render and stop.
    - If `jumpNow(...)`, call `doJump(item.id)`. Otherwise set `pendingJump = item.id` and render.
  - **`doJump(id)`:**
    - On `queue`, set `queueIndex` to `indexOfAsk(id)`.
    - Elsewhere, set `returnTo = location.hash || '#/list'`, `nav('#/queue')` and set the index.
    - Then toast `NEEDS YOU` and call `guard.arm()`.
  - **The 1 s interval:** it re-checks `pendingJump`, dropping it when the item is gone or no longer loud. It also navigates to `#/list` when `queueIdleExitDue` is true. Delete `armQueueIdleExit` and its timer.

- [ ] **Step 4: Run** `npm --prefix panel test`. Expected: PASS.

- [ ] **Step 5: Commit** — `feat(queue): loud items jump to the queue when you are not mid-action`

---

### Task 13: Waiting lines and the chime row

**Files:**
- Modify: `panel/src/screens/helpers.js` (`waitingLabel`)
- Modify: `panel/src/screens/session-list.js` (`subline`)
- Modify: `panel/src/screens/session-detail.js`:
  - `macRows` gets a third row and `ACTION_ROWS = 3`.
  - The activity line shows `waitingLabel` when waiting, with one row per `waitingOn` entry.
- Modify: `panel/src/store.js` (`chimeOn: null` in state)
- Modify: `panel/src/main.js`:
  - `claude.prefs.get` in `ws.onOpen`
  - `toggle-chime` in `sessionRowAction`, in the tap routing at the `open-mac|toggle-auto-open` line, and as a dial press on the empty queue
- Test: `panel/test/helpers.test.js`, `panel/test/screens.test.js`

**Interfaces:**
- Consumes: `waitingOn` on the session summary (Task 2), and `claude.prefs.get/set` (Task 7).
- Produces: `waitingLabel(waitingOn, nowMs): string`.
  - With one entry: `'waiting on ' + label + ' · ' + fmtDuration(nowMs - since)`.
  - With several: `'waiting on ' + n + ' jobs · ' + fmtDuration(nowMs - oldestSince)`.
  - With none: `''`.

- [ ] **Step 1: Write the failing tests**

```js
test('waitingLabel names one job or counts several', () => {
  assert.equal(waitingLabel([{ label: 'npm test', since: 0 }], 4 * 60000), 'waiting on npm test · ' + fmtDuration(4 * 60000));
  assert.ok(waitingLabel([{ label: 'a', since: 0 }, { label: 'b', since: 1 }], 60000).startsWith('waiting on 2 jobs'));
});
test('a waiting tile says what it waits on', () => { /* renderList with session waitingOn → includes 'waiting on npm test' */ });
test('the session view has the chime row after the two Mac rows', () => {
  /* renderDetail(state with chimeOn false) → includes 'Chime on the Mac: Off' and 'data-action="toggle-chime"' */
});
```

- [ ] **Step 2: Run to verify they fail**, then **Step 3: Implement**, then **Step 4: Run** `npm --prefix panel test`. Expected: PASS.

- [ ] **Step 5: Commit** — `feat(queue): waiting lines on tiles and a chime switch on the panel`

---

### Task 14: Demo data, full suite and the live check

**Files:**
- Modify: `mac-service/src/sessions/source-mock.js` (`startMockSource({ store, permissionBridge, queue, inbox, … })`). It posts one ASKING and one UPDATE card for two mock sessions on start, and one session gets a `waitingOn` entry.
- Modify: `mac-service/src/sessions/index.js` (pass `inbox` to the mock source)
- Test: `mac-service/test/source-mock.test.js`

- [ ] **Step 1: Write the failing test.** `startMockSource` with a stub inbox posts at least one `asking` and one `update`.

- [ ] **Step 2: Run to verify it fails**, then **Step 3: Implement**, then **Step 4: Run** `node --test test/source-mock.test.js`. Expected: PASS.

- [ ] **Step 5: Run everything** — `npm test` at the worktree root. Expected: every suite passes, including the simulator smoke test.

- [ ] **Step 6: Look at it in the simulator** — Use the `run` skill (or `npm run sim`) and check the queue screen:
  - an ASKING hero with three chips
  - an UPDATE row
  - the footer counts
  - the empty state with the chime row
  - a "waiting on …" tile
  - the session view with no tool lines

  Save screenshots to the scratchpad.

- [ ] **Step 7: Commit** — `feat(queue): demo cards in the mock source`

- [ ] **Step 8: Live check — ask the owner first.** It needs four things:
  1. Running this branch's Mac service in place of the main checkout's.
  2. Re-running `npm --prefix mac-service run install-hooks`, which adds StopFailure.
  3. Building and provisioning the panel to the Car Thing (see `car-thing-usb-link` memory and `device/scripts/provision.sh`).
  4. Restoring main afterwards if the owner wants.

  With approval, walk the spec's "How we will know it works":
  - An ASKING card jumps and chimes once.
  - It goes quiet after 10 minutes.
  - A reply wakes the session, a second reply also lands, and the replying turn's card shows the spoken words in its "you asked" line.
  - SWITCH raises the right window.
  - A background `sleep 60` reads "waiting on sleep 60" and then posts.
  - The session view shows no tool lines.

  Also check how a woken reply is saved in the transcript, and record it in the spec's "Verify first". Report results to the owner, including anything that failed.
