# The queue as an inbox — Design

Date: 2026-11-06
**Status:** Implemented (merged as PR #19 and deployed 2026-11-06)
Branch: `feat/queue-inbox` (worktree `Spotify_car_thing-queue`)

## Intent

The owner: "the queue page on the carthing is rarely useful as it only shows questions in the format of questions from claude. i'd like this opened up to more flexible options. like the updates from my local agent that one of my other sessions is working on and updates from my claude sessions that have updates for me." And: "There are numerous updates and questions from Claude that don't appear there since they aren't structured as questions."

Today the queue holds only what *blocks* a session: tool permissions, `AskUserQuestion` dialogs and plan approvals. Most of what Claude has for the owner is not any of those. A turn that ends with "Want me to commit this?" or "Done, the tests pass, here's what changed" is just a finished turn to the panel. Its tile flashes DONE, settles to idle, and the session sits waiting on a person who was never told.

This design turns the queue into an inbox. **Every finished turn of every Claude Code session on this Mac posts a card, tagged by what kind of turn it was.** A turn that asks the owner something is as loud as a permission prompt. The owner can act on any card from the Car Thing, either by bringing its window forward on the Mac or by speaking a reply. Two related fixes come with it: a session that is waiting on a background job reads as working instead of done, and the session view stops showing tool-call lines.

## Goals

1. **Every finished turn makes a card.** A turn ends when Claude Code fires the Stop hook (or StopFailure, see Tags). Each session has at most one card, for its latest turn. A newer turn replaces the older card.
2. **Cards are tagged.** **ASKING:** the turn ended with a question for the owner. **UPDATE:** the turn ended with a report and nothing to decide. **ERROR:** the turn ended on an API error. When the NucBox digest has summarized the turn, the card shows that summary and carries a small **NUCBOX** marker (see The digest handoff).
3. **ASKING and ERROR cards are loud when they arrive:**
   - On the Car Thing, the screen wakes and jumps to the queue with the new card on top. The dial is ready on its first action, the border pulses and the count goes up.
   - On the Mac, a short chime plays once, unless the owner has turned it off. There is one on/off setting for all sessions, a row you press to flip, like the existing "Open automatically: On/Off" row in the session view.
   - **After 10 minutes the card goes quiet** (owner agreed). It keeps its place in the queue, but the border stops pulsing, the screen is free to sleep, and the panel returns to the session grid once only quiet cards are left. About 4 in 10 finished turns end with a question (see Loud), so a card that stayed loud until acted on would keep the panel lit and pulsing all night.
4. **UPDATE cards are quiet.** They bump the count. There is no chime and no jump.
5. **Two actions on every card, from the Car Thing:** **switch** (bring that session's window forward on the Mac, VS Code or Terminal) and **reply** (speak a message, read it, send it to the session).
6. **"Waiting on a run."** When a turn ends while that session still has background work in flight (a shell started in the background, a Monitor, a background subagent, a workflow), the session reads as working, not DONE or idle. Its tile says what it is waiting on, for example "waiting on npm test · 4m". No UPDATE card is posted until that work is done and Claude has finished the turn that follows.
7. **A cleaner session view.** The session view shows only the owner's prompts and what Claude said. Tool-call lines ("Bash · git status") and background-task notices go. Claude's text in the middle of a turn stays (owner: "I still want the update messages to show").

## Non-goals (this version)

- **Cloud sessions** (claude.ai/code, Remote Control sessions on other machines). The owner: "cloud is follow on later date for sure." `claude agents --json` on this Mac lists only local sessions (checked 2026-11-06 on 2.1.220), and a cloud session's hooks can't reach the Mac service on the LAN. The routes to research later are repo hooks that post to a reachable URL, such as a Home Assistant cloud webhook, and the account's session list, which has no documented interface found so far. That gets its own design.
- Subagent turns. SubagentStop is not a card, because a subagent reports to its parent, not to the owner.
- Any change to the NucBox, to LM Studio, or to the digest's own code and screens (see The digest handoff).
- Answering a prose question by picking options. A prose question has no options, so the answer is a spoken reply.
- History. The inbox holds each session's latest turn, not a log.
- Changing the resting screen. The session grid stays where the device rests (the owner likes it: "it shows lights of agents active").

## Anti-goals (would make it a failure even if it "works")

- **A card says something the session didn't.** The card text is Claude's own last message, or a digest summary of that same turn, never a summary of an older turn on a newer card.
- **An ASKING jump makes a press land on the wrong thing.** A permission hero's dial press is ALLOW. A jump must never turn a press meant for the previous screen into an ALLOW or a SWITCH.
- **The Stop hook gets slower.** `http-server.js` runs `onHookEvent` before writing the hook's response. Creating a card must stay synchronous and cheap: no transcript reads, no network and no waiting on the chime in that path.
- **Noise the owner learns to ignore.** Examples: a chime for every UPDATE, three chimes when three sessions finish together, a jump while the owner is turning the dial on another page, or a session stuck at "waiting" forever with no way to see why.
- **A reply goes nowhere silently.** A reply that can't be delivered must say so on the panel, as the session view's "Say something" already does.

## Existing environment (read 2026-11-06 at `origin/main` 3b119fb)

**Claude Code 2.1.220 is installed.** Its Stop hook input, read from the installed binary's schema (not yet seen in a live payload; see Verify first), carries:
- `last_assistant_message` (optional string): "Text content of the last assistant message before stopping."
- `background_tasks` (optional array): "In-flight background work (running/pending + backgrounded) registered in this session. Lets hooks distinguish 'session is done' from 'session is paused waiting for background work to wake it'. Empty array when nothing is in flight." Each entry is `{id, type, status, description, command?, agent_type?, server?, tool?, name?}`, where `type` is a label such as `shell`, `subagent`, `monitor` or `workflow`, and `command` is present for shell tasks. Text fields are capped at 1000 characters.
- `session_crons` (optional array): session-scoped cron tasks (CronCreate, ScheduleWakeup, /loop), each `{id, schedule, recurring, prompt}`.
- A separate **StopFailure** hook has `error`, `error_details?` and `last_assistant_message?`. It is **not** installed by `mac-service/scripts/install-hooks.js` today.

**The Mac service** (`mac-service/src/`):
- `scripts/install-hooks.js` installs http hooks to `/hook` for SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse, Stop (5 s timeout) and PermissionRequest. It also installs a second Stop hook, `scripts/rewake-hook.js`, with `asyncRewake: true` and a 3600 s timeout. That poller is how a dictated message wakes an idle session.
- `sessions/source-hooks.js` handles Stop by setting `stoppedTs`, clearing `waitingForInput`, `thinking` and `currentTool`, and closing any held question ask (`queue.onQuestionAnswered`). `sessions/store.js` `deriveState()` returns `attention`, `celebrate` (within `CELEBRATE_MS` of `stoppedTs`), `busy` or `idle`. Ended sessions are deleted from the store.
- `queue.js` holds the question and plan asks, and `permission-bridge.js` holds permissions. `claude.queue.list` returns the queue for a panel that just connected, and events are pushed through `hub.js`. `SUPERSEDING = /^claude\.(sessions?|usage)\./` events may be dropped for a backed-up socket.
- `message-bridge.js` delivers a panel message to a session: through `additionalContext` on the next PostToolUse if the session is working, or by handing it to the waiting rewake poller if it is idle. `chooseDelivery()` returns `answer`, `answer-on-panel`, `next-tool`, `wake` or `cannot-wake`. `claude.session.send` is the entry point.
- `focus.js` raises a session's window: the VS Code window for its folder, or the Terminal tab by tty. `claude.session.focus` is the entry point, and `host-tracker.js` knows which app hosts each session.
- `sessions/recent-messages.js` `readRecentMessages()` condenses a transcript tail into `{role: 'user'|'assistant'|'tool', text, ts}`. It is used by `claude.session.messages` (session view) and by `sessions/subagents.js` (the subagent feed). It treats background-task notices (`user` records with `origin.kind: "task-notification"`, per the digest spec's survey) as typed prompts.
- `persist.js` writes `.state/<name>.json` atomically, and `.state/` is git-ignored.
- `own-sessions.js` hides the service's own `claude` invocations. They must not post cards.

**The panel** (`panel/src/`):
- `screens/queue.js` draws a hero (the ask you'd answer next, with its actions) and up to two stack rows. The dial and swipe move between asks. On a permission hero, the dial press is ALLOW and preset 3 is DENY (`shell.js`).
- `main.js` `surface(ask)` pushes the ask.
  - A **held question or plan** (kind `prompt`) opens its own prompt screen on arrival from every screen except dictation (`opensOnArrival` in `prompt-answer.js`, commit 894b33a, added after the owner's live check found a question timing out behind the session screen).
  - A **permission** jumps to the queue only from the ambient clock. On other screens it re-renders, and the pulsing `.edge` border plus the topbar count carry the alert.
  - After 60 s on an empty queue the device returns to the session list.
- `screen-power.js` keeps the screen lit while any ask is waiting, and swallows a knob input that wakes a dark screen (`swallowMs` 500).
- Holding the top button (`m-hold`) is talk. On a session view it runs `sayToSession()`: dictate, review, Send, then `claude.session.send`. The status line shows the delivery result, using copy in `screens/helpers.js`.
- The session view's action rows (`screens/session-detail.js` `macRows`) are "Open in VS Code" and "Open automatically: On/Off", a per-panel pref in `prefs.js` (localStorage).
- `screens/conversation.js` draws `role: 'tool'` messages as one-line `.cv-tool` rows.
- The code style is ES5 string-built screens, with "no flex gap, no inset shorthand, no clamp()". Nothing is below 14 px, and nothing read at a glance is below 19 px.

**Other work in flight.** `feat/agent-digest` (worktree `Spotify_car_thing-digest`, session spotify-car-thing-86) is building the NucBox digest. Its design is `docs/superpowers/specs/2026-11-06-agent-digest-design.md` on that branch, with a facts-only Milestone 1 first, `claude.digest.get` / `claude.digest.update`, a Digest screen, and "no alerts" as a non-goal. It will also touch `source-hooks.js`, `index.js` and `main.js`, so expect merge conflicts there.

## Decided approach

### Where cards come from

The Stop hook (http, already installed) is the trigger. In `source-hooks.js`, on Stop, after the existing store update:

1. Skip the service's own sessions (already filtered). **Don't** skip a Stop with `stop_hook_active: true`. On this Mac the rewake poller is the only Stop hook that continues a turn (checked in `~/.claude/settings.json`), so that flag means "this turn answered a reply from the panel", and that answer is exactly the card the owner is waiting for.
2. Build the card text from `last_assistant_message` and classify it (ASKING or UPDATE).
3. If `background_tasks` is non-empty, the session is **waiting on a run** (below). An UPDATE turn posts no card, and any older card for the session stays as it is. An ASKING turn still posts (see Waiting on a run).
4. Otherwise, post the card, replacing the session's previous card.

StopFailure is added to `install-hooks.js` as an http hook. It posts an **ERROR** card whose text is `last_assistant_message` (if any) followed by the error and its details, so the error is the closing paragraph the card's excerpt shows. *My call:* an error-ended turn is a finished turn the owner needs to know about, and today it reads as idle.

**Fallback for builds without the new fields.** If `last_assistant_message` is absent, the card text comes from the transcript's last assistant text. That read happens **after** the hook response is written, never inside it. If `background_tasks` is absent, the session is treated as not waiting.

### Tags

- **ASKING.** A deterministic rule on the Mac, instant and free (*my call*):
  1. Strip fenced code blocks and inline code from the message.
  2. Take the last non-empty paragraph.
  3. Tag ASKING if it contains a sentence ending in `?`, allowing for trailing quotes, `)`, `*` or `_`.
  4. Everything else is UPDATE.

  A wrong tag only changes how loud the card is, because both tags appear. The builder samples real last messages (read-only) from recent transcripts and writes tests from them, including "Want me to…?", a question followed by a code block, a "?" inside a code span, and a closing "Let me know if…" with no question mark (UPDATE).
- **UPDATE.** Every other finished turn.
- **ERROR.** StopFailure. It is loud, like ASKING.
- **NUCBOX marker.** Not a tag: a small marker on a card whose text is a digest summary.

### What a card holds and shows

Each card is `{sessionId, sessionName, host, tag, text, intent, createdTs, stoppedTs, prevStoppedTs, loud, loudUntil, summary?}`:
- `text` is Claude's last message, clipped to about 8,000 characters like the newest reply in `recent-messages.js`.
- `intent` is the existing "you asked: …" line from `lastPrompt`.

On the queue, a card hero shows the tag, the session name, the intent line and **the last paragraph of the message** (*my call*: that's usually where the question or the result is), clipped to fit with an ellipsis. A stack row shows the tag, the session and the first line of that paragraph. A long message is read in full on the session view (below).

### Actions and gestures

All of these are *my call*. They follow the panel's existing meanings for each control.

| Control | On a card hero |
|---|---|
| Dial press | **SWITCH**: brings the session's window forward on the Mac (`claude.session.focus`). The card is cleared. |
| Hold top button | **REPLY**: the existing dictate-review-send flow (`sayToSession`), aimed at this card's session. The card clears once the reply is sent (`next-tool` or `wake`). |
| Preset 4 | **CLEAR**: removes the card with no other effect. |
| Tap the card body | **OPEN**: the session view, scrolled to the end, where the whole message is readable and "Say something" and "Open in VS Code" already exist. |
| Dial turn / swipe | Moves between items, as today. |

The chips on a card hero read SWITCH, REPLY and CLEAR. The dial walks them, the filled one is the one a press does, and a card starts on SWITCH. Turning past CLEAR moves to the next ask, and turning back before SWITCH moves to the previous one, landing on its CLEAR if it's a card. Hold top (REPLY) and preset 3 (CLEAR) stay as shortcuts. *Changed 2026-11-06 at the owner's request after the live check:* at first the press was always SWITCH, and the owner found the dial seemed dead on a card. On a permission or question hero nothing changes.

If a reply can't be delivered (`cannot-wake`: the session has been idle for over an hour, past the rewake poller's 3600 s timeout, or its hooks are missing), the card stays, and the panel shows the existing "Not sent…" copy with SWITCH as the way forward.

**Back-and-forth from the Car Thing** (*my call*: in scope, since reply, card, reply is the inbox's main loop). Today `scripts/rewake-hook.js` exits at once when `stop_hook_active` is set, so after one woken turn no new poller starts, and a second reply gets `cannot-wake` until the owner types on the Mac. That guard is removed. A poller only ever fires on a message the owner sent, so it can't loop by itself. The installed hook runs the script from the main checkout, so this takes effect when the branch merges, with no reinstall.

**A panel reply as the turn's prompt.** A woken turn fires no UserPromptSubmit. When the message bridge delivers a reply (`wake` or `next-tool`), it sets the session's `lastPrompt` to the reply text, so the next card's "you asked" line shows what the owner said on the panel, not an older typed prompt.

### How cards leave

- A newer finished turn of the same session replaces the card.
- The owner types into that session on the Mac (UserPromptSubmit) or a reply from the panel starts a new turn. The card is cleared.
- SWITCH, REPLY (once sent) or CLEAR from the card.
- **The session ends.** ASKING and ERROR cards are removed, because there is nothing left to switch to or reply to. UPDATE cards stay for 2 hours after the end (*my call*), then go. The store deletes ended sessions, so the inbox keeps the name and text on the card itself.

Cards survive a Mac service restart: they persist in `.state/inbox.json`, written with mode 0600 because it holds message text. On reload, a card whose session no longer exists follows the session-ended rule.

### Order on the queue

1. Permissions, questions and plans, exactly as today.
2. ASKING and ERROR cards, oldest first.
3. UPDATE cards, newest first.

The footer separates them, for example "2 waiting on you · 5 updates". The topbar count includes every item (*my call*: the owner asked for UPDATEs to bump the count). The empty state's copy changes from "permissions and questions land here" to say that finished turns land here too.

### Loud: the jump, the screen, the chime

**The jump (owner: "very loud… pull the screen up ready to click").** An ASKING or ERROR card, and *(my call, for consistency)* a permission, now jumps to the queue from **any screen**, not just the clock, with that item as the hero. Held questions and plans keep their existing open-on-arrival behaviour (the owner's earlier fix) and only gain the input guard below. Two exceptions:
- **The owner is mid-action:** dictating, on the prompt screen, answering in the queue, dimming a light, or having touched the dial, a button or the screen in the last 10 s (*my call*). The jump then waits until 10 s after the last input and happens only if the item is still waiting. Meanwhile the edge pulses and the count goes up, as today.
- **The input guard:** for 1 s after a jump, and after a held question or plan opens itself, dial presses and preset 3 are ignored (*my call*), so a press meant for the previous screen can't ALLOW, pick an option, SWITCH or CLEAR.

**How long loud lasts (owner agreed).** A card is loud for 10 minutes from when it was posted. A builder-check sample of 1,464 recent turn endings put about 39% at ASKING under the rule above, so loudness has to end on its own.
- **While loud,** the card counts as "an ask waiting" in `screen-power.js` (it wakes a dark screen and keeps it lit), drives the `.edge` pulse, and is eligible for the jump. A jump still waiting for 10 s of no input is dropped if the card goes quiet first.
- **When quiet,** it keeps its place in the queue's order but no longer drives the pulse, screen power or a jump. A quiet card looks the same as a loud one apart from the pulse, with no greyed-out style.
- **Who decides.** The Mac service owns the flag. A card carries `loud: true` and `loudUntil`, and when the flag flips the service re-sends the card with `loud: false`, so the panel never compares its own clock with the Mac's. A card reloaded after a restart past its `loudUntil` comes back quiet. A newer turn's card starts loud again if it's ASKING or ERROR.
- **Handing back to the grid.** The queue's existing "60 s on an empty queue, then back to the session list" becomes "60 s with no input and nothing loud on the queue (no permission, question, plan or loud card), then back to the session list". Reading quiet cards with the dial keeps resetting the minute.

An UPDATE card is never loud.

**The chime.** The Mac service plays a short system sound with `afplay`, for example `/System/Library/Sounds/Glass.aiff`, spawned detached so nothing waits on it.
- It plays for everything that jumps: ASKING, ERROR, permissions, questions and plans (*my call*). A prose question shouldn't be louder than a permission.
- At most one chime per 10 s (*my call*), so a burst of finishing sessions makes one sound.
- It plays whether or not a panel is connected. It's a Mac-side signal.
- **The setting** is stored by the Mac service in `.state/`, defaults to **On**, and is flipped from the panel. *My call:* the row sits beside "Open automatically" in the session view's action rows, matching where the owner pointed: "Chime on the Mac: On/Off", subtitle "Plays when a session needs you". It's global, not per session. The empty queue screen shows the same row, so it can be found without opening a session.

### Waiting on a run

On Stop with a non-empty `background_tasks`, the session record gets `waitingOn: [{type, label, since}]`:
- `label` is the shell `command` (first 60 characters), else the `description`, else the `agent_type` or `name`.
- `since` is the Stop time, because the payload carries no start time.

`deriveState()` returns `busy` for such a session and skips `celebrate`. *My call:* reusing `busy` keeps the grid's lights, the mascot and the screen rules unchanged, and the tile's subline says "waiting on npm test · 4m". With more than one task it says "waiting on 3 jobs · 4m". The session view shows the full list.

`waitingOn` clears on the session's next Stop (replaced by that Stop's list), on UserPromptSubmit, on a tool call (PreToolUse sets the session working anyway) and on SessionEnd.

`session_crons` (*my call*): a **one-shot** wakeup (`recurring: false`) also counts as waiting, labelled "wakes at 3:40". A **recurring** cron (a /loop) doesn't, because each loop turn is a real finished turn and posts its card.

*Known edge (accepted):* a background job that never ends, such as a dev server, keeps the tile on "waiting on npm run dev" and holds back the UPDATE card for as long as it runs. An ASKING turn is **not** held back: if Claude ends a turn asking something while work is in flight, the card posts (*my call*), because the owner is being asked even if a job is still running.

### The cleaner session view

`claude.session.messages` drops `role: 'tool'` entries and background-task notices (`user` records with `origin.kind: "task-notification"`). **Exception:** a woken panel reply is also saved as a `task-notification` record. One whose text starts with the message bridge's `MESSAGE_PREFIX` is kept, with the prefix stripped, and shown as the owner's own message. The filter goes in the session-view path, not inside the shared `readRecentMessages()`, so **the subagent feed is unchanged** (*my call*: a subagent's tool steps are most of what it does). With tool lines gone, the 40-message limit covers more conversation, which is fine. Claude's text in the middle of a turn stays.

### The digest handoff

The digest is spotify-car-thing-86's project. This branch doesn't edit its code, and it must work with no digest at all.
- **The seam:** the inbox exposes one function in the Mac service, `attachSummary(sessionId, turnEndTs, {headline, bullets})`.
- **What it does:** if that session's card is for the same turn, the card's `summary` is set and the panel shows the headline and bullets in place of the last paragraph, with the NUCBOX marker. "The same turn" means `turnEndTs` is later than the card's `prevStoppedTs` (when the session's previous turn stopped, whether or not it left a card: the inbox notes every Stop and StopFailure itself; null when none is on record) and later than `stoppedTs - 120 s`, and no more than 15 s after `stoppedTs`. The `prevStoppedTs` bound is what keeps turn N's summary off turn N+1's card when the two turns are less than two minutes apart. A summary for an older turn is ignored.
- **Who calls it:** the digest, when it has a *model-written* summary. Facts-only digests (its Milestone 1) don't replace Claude's words.

Before building the seam, this session messages spotify-car-thing-86 to agree on it. Their design says the digest adds no alerts, and this keeps to that: a summary arriving never chimes, never jumps and never re-sorts a card.

### Protocol additions (names are proposals)

| Method or event | Shape | Notes |
|---|---|---|
| `claude.queue.list` | cards ride inside `asks` (kind `card`) | a panel that just connected gets the inbox too; `claude.queue.sync` carries the same list |
| `claude.card.posted` (event) | `Card` | new or replaced card, and re-sent with `loud: false` when it goes quiet; never superseding (an ASKING card must not be dropped for a backed-up socket) |
| `claude.card.cleared` (event) | `{id, sessionId, reason}` | |
| `claude.card.clear` | `{id}` → `{ok}` | CLEAR from the panel |
| `claude.prefs.get` / `claude.prefs.set` | `{chime: boolean}` | the chime setting |

SWITCH and REPLY reuse `claude.session.focus` and `claude.session.send`, and the Mac service clears the card on success. The session record gains `waitingOn`, carried on the existing `claude.session(s).update` events.

## Verify first (before the plan relies on it)

1. **The Stop payload.** Capture one real Stop payload on this Mac and confirm `last_assistant_message` and `background_tasks` are present, including a turn that ended with a background shell running and one with a background subagent running. The schema was read from the 2.1.220 binary, and nothing has been seen live yet.
2. **StopFailure** fires as an http hook, and its payload has the fields the schema shows.
3. **A reply wakes the session.** With a card from a session idle for a few minutes, REPLY wakes it through the rewake poller. This is the existing path, but it hasn't been exercised from the queue.

If (1) fails, the fallbacks above apply and "waiting on a run" is cut from this version and comes back to the owner.

**Results:**
- **2026-11-06, check (1): passed.** One `claude -p` turn on 2.1.220 started `sleep 45` in the background and ended with a question. Its Stop payload had these keys: `background_tasks`, `cwd`, `effort`, `hook_event_name`, `last_assistant_message`, `permission_mode`, `prompt_id`, `session_crons`, `session_id`, `stop_hook_active`, `transcript_path`.
  - `background_tasks` was `[{"id":"b29zeoqgf","type":"shell","status":"running","description":"Sleep 45 seconds in background","command":"sleep 45"}]`.
  - `last_assistant_message` ended "…report back when it exits?".
  - `session_crons` was `[]` and `stop_hook_active` was `false`.
  - A background subagent case wasn't captured. The schema lists `subagent` among the task types.
- **2026-11-06, check (3): passed** on the deployed build. The owner held REPLY on an ASKING card on the Car Thing. The service logged `message delivered to <session> via wake` and cleared the card (`replied`), and the idle session woke with the words.
  - Claude Code saves the woken reply as a `user` record with `origin: {kind: "task-notification", producer: "session-task"}`, after a `queue-operation` `enqueue` record with the same content.
  - The content is `<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>\n<system-reminder>\nStop hook blocking error from command "Stop": ` + `MESSAGE_PREFIX` + the words + `\n\n</system-reminder>`.
  - The session view at first showed the closing `</system-reminder>` after the words. It now cuts them there.
- **Check (2)** (StopFailure): the hook is installed, but no failed turn has been seen live yet.

## How we will know it works

- Over a normal working day, every finished turn of every local session appears as a card. The owner judges the ASKING/UPDATE tags as right on most cards, and wrong ones are near-misses ("let me know…"), not reversals.
- An ASKING card from a session the owner isn't looking at wakes the panel, lands on the queue ready for a press, and chimes once on the Mac. One press brings the right window forward.
- Ten minutes after an ASKING card arrives, with nothing else loud, the border stops pulsing, the screen can sleep, and a queue left alone for a minute hands back to the session grid. Overnight, the panel goes dark however many quiet cards are waiting.
- A spoken reply from a card wakes an idle session, and that session's next turn replaces the card.
- A session running `npm test` in the background reads "waiting on npm test" until the job ends, then posts its card.
- The session view shows no tool lines.
- The Stop hook's response time doesn't measurably change (log timings before and after).
- Existing panel and Mac service tests pass, and new tests cover the classifier, card lifecycle, ordering, the jump rule and input guard, the `waitingOn` derivation and the message filter.

## Left to the builder

- Card markup and CSS within the existing tokens and size rules. The tag colours must not read as the permission DESTRUCTIVE red.
- How the hero clips the last paragraph, and the stack row's exact text.
- The `attachSummary` matching tolerance, once real timings are known.
- Simulator and mock-source demo cards (`sessions/source-mock.js`).
- Whether the chime skips when the session's own window is already frontmost on the Mac.
- Reinstalling hooks: `install-hooks.js` gains StopFailure, and the owner re-runs the installer, as for past hook changes.

## Calls made by Claude (owner to confirm)

- **Gestures:** turn = move between SWITCH, REPLY and CLEAR (then on to the next ask), dial press = the highlighted one, hold top = REPLY, preset 3 = CLEAR, tap = open the session view.
- **The wider jump** applies to permissions too, not just the new cards. It waits for 10 s without input and ignores presses for 1 s after. Held questions and plans keep opening their own screen, and gain the 1 s guard.
- **Back-and-forth replies** from the Car Thing work: the rewake hook's one-round guard is removed. Turns answering a panel reply post cards, and the reply becomes the card's "you asked" line.
- **The session view** keeps the owner's panel replies even though the transcript files them as task notices.
- **The chime** covers everything that jumps, is throttled to one per 10 s, and defaults to On. Its row sits in the session view's action rows and on the empty queue screen.
- **ERROR cards** from StopFailure, a new hook to install.
- **ASKING turns still post** while background work runs. Only UPDATE turns are held back.
- **A one-shot scheduled wakeup** counts as waiting, a recurring /loop doesn't.
- **"Waiting on a run" draws as `busy`** with a "waiting on …" subline, not as a new state.
- **The subagent feed** keeps its tool lines.
- **UPDATE cards** from ended sessions stay 2 hours. The topbar count includes UPDATEs.
- **The card text** shows the last paragraph, and the full message is on the session view.
