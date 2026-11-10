# claude.* protocol

Single source of truth for the Claude Mode RPC surface. Envelope everywhere is
the nocturned JSON envelope:

```json
{"type":"request","id":"<uuid>","method":"claude.sessions.list","params":{}}
{"type":"response","id":"<uuid>","result":{}}
{"type":"error","id":"<uuid>","error":"<string>"}
{"type":"event","topic":"claude.sessions.update","data":{},"server_timestamp_ms":0}
```

Transport chain: device app ⇄ nocturned :5000 ⇄ (emulator claude-bridge | BT →
Swift Nocturne relay) ⇄ daemon `ws://127.0.0.1:8790/ws`. The Swift relay
converts MsgPack↔JSON at the BT boundary; frames are otherwise passed through
with ids preserved.

## Bridge handshake (daemon-internal, relays + webpage only)

First frame from any client of the daemon hub:

```json
{"type":"request","id":"…","method":"bridge.hello","params":{"role":"emulator|connector|webpage","info":{}}}
```

→ `{"result":{"ok":true,"daemonVersion":"…"}}`.

Connector role additionally pushes status (every 10s and on change):

```json
{"type":"request","id":"…","method":"bridge.status","params":{"bt":{"connected":true,"device":"Car Thing","address":"…","serial":"…","firmware":"…"}}}
```

Hub semantics (deliberate deviation from nocturned, daemon-internal only):
responses go **only to the requesting socket**; events broadcast to all
connected clients.

## Requests (device → daemon)

| Method | Params | Result |
|---|---|---|
| `claude.ping` | `{}` | `{daemonVersion, sessions:<n>}` |
| `claude.sessions.list` | `{limit?}` | `{sessions:[SessionSummary], stats:Stats, serverNowMs, tzOffsetMin, intProbe}` — unbounded unless `limit` given, except for `connector`/`emulator` roles, which are capped at 4 (`BT_SAFE_SESSION_LIMIT`) even without `limit`: their synchronous responses must fit one Bluetooth chunk. When the cap trims the list, the daemon follows up with a full `claude.sessions.update` push, which chunks fine. `stats` always counts every session, not the returned slice |
| `claude.session.get` | `{id}` | `SessionDetail` (error `"unknown session"` if gone) |
| `claude.session.messages` | `{id, limit?}` | `{messages: Message[]}`, the recent conversation, oldest first (default 40; `[]` if the transcript can't be found). This is the session view: only what was said. Tool lines (`role:'tool'`) and background-task notices (the transcript's `task-notification` records, which would otherwise read as typed prompts) are dropped. The one notice kept is a reply the owner sent from the panel, which wakes an idle session and is saved as a notice: it comes back as a `user` message with the words after the `"Message from the owner via the desk panel: "` prefix and `fromPanel: true` |
| `claude.prompt.answer` | `{id, answer}` | `{accepted}`. `answer` is `{kind:'choice', answers:{[questionText]: label or free text}}` (multi-select labels joined with `", "`), `{kind:'approve'}` or `{kind:'feedback', text}` for a plan, or `{kind:'vscode'}` to release it to Claude Code's own dialog (not for a background session's prompt, which has no dialog to go back to: `bad-answer`, and the prompt stays held). `false` if already answered; error `bad-answer` if the answer doesn't fit |
| `claude.dictation.transcribe` | `{audioBase64, mime}` | `{text}`, transcribed on the Mac by whisper.cpp (audio deleted afterwards). Errors: `too-long` (over 30 s or 2 MB), `dictation-not-set-up` (run `mac-service/scripts/setup-dictation.sh`), `transcription-failed` |
| `claude.session.send` | `{id, text}` | `{delivery: 'answer' \| 'next-tool' \| 'wake' \| 'cannot-wake'}`. A message from the owner, prefixed `"Message from the owner via the desk panel: "`. `answer`: the session's held question (every question gets the text) or plan (as feedback). `next-tool`: returned as `additionalContext` by the next `PostToolUse` hook. `wake`: handed to the `Stop` hook's asyncRewake poller (`scripts/rewake-hook.js`, `GET /hook/rewake?session=`, loopback only), which exits 2 to wake Claude. `cannot-wake`: idle with no poller listening (idle over an hour, or hooks not installed); nothing is sent. A delivery of `answer`, `next-tool` or `wake` clears that session's card (`claude.card.cleared`, reason `replied`); `cannot-wake` leaves it. The delivered text also becomes the session's intent line (`you asked: …`), so the next card shows what the owner said on the panel. A `wake` of a background session also marks its turn as running again (no UserPromptSubmit fires for a rewake), so the session view's open row waits for that turn to end instead of moving the session mid-turn. Events: `claude.message.delivered {sessionId, via}`, `claude.message.dropped {sessionId, reason: 'owner-typed' \| 'replaced'}` |
| `claude.subagents.list` | `{sessionId}` | `{subagents: Subagent[]}`, oldest first (`[]` if none) |
| `claude.subagent.feed` | `{sessionId, agentId}` | `{steps: Message[], report: string\|null}`: the agent's last 20 steps; `report` (≤400 chars) only once it has finished |
| `claude.session.watch` | `{id: string\|null}` | `{ok:true}` — this socket now receives `claude.session.update` only for that session (`null` = none). Opt-in per socket: a client that never sends it gets every detail, as before. Handled inside the hub (it is per-socket state, which registered methods can't see) — `claude.`-prefixed anyway, because the relays forward only that prefix. Watch dies with the socket; a restarted daemon reverts to broadcast-all until the client re-asserts (the device re-sends on `claude.queue.sync`, which fires on every client hello). Known limit: the connector multiplexes all paired devices onto one socket, so the last watch wins |
| `claude.permission.answer` | `{requestId, decision:"allow"\|"deny"}` | `{accepted:bool}` — idempotent; `false` when already resolved |
| `claude.queue.list` | `{}` | `{asks:[Ask]}` — everything waiting on a human, oldest first. `asks` also carries the inbox's cards (kind `card`, see `Card`), so a panel that just connected gets them too. `claude.queue.sync` (sent on every client hello) carries the same list |
| `claude.card.clear` | `{id}` | `{ok}` — removes that card with no other effect (CLEAR on the panel); emits `claude.card.cleared` with reason `cleared`. `ok:false` when no such card is left (already replaced or cleared) |
| `claude.prefs.get` | `{}` | `{chime}` — the Mac service's own settings, kept in `.state/prefs.json` |
| `claude.prefs.set` | `{chime}` | `{chime}` — the setting as stored. `chime` (default `true`) is whether the Mac plays its chime (see the Chime note below); only a boolean is accepted, anything else in the patch is ignored |
| `claude.question.answer` | `{id, answers}` — `answers` is `number[][]`, one entry per question of the ask, each the option indices picked for it (`optionIndex` still accepted for a lone single-select question) | `{accepted, viaKeyboard, option, keys?, focused?, reason?}` (see below) |
| `claude.session.focus` | `{id}` | `{focused, app?, exact?, reason?}` — raises that session's terminal window. With `focused:true` that session's card is cleared (`claude.card.cleared`, reason `switched`). On the NucBox, whose service has no desktop, it opens an `interactive` session whose own registry entry says VS Code started it (`entrypoint: claude-vscode`) in VS Code, through the helper task and the desktop check described under "Background sessions"; any other session there answers `{focused:false, reason:"can't raise windows on the NucBox"}` |
| `claude.projects.recent` | `{}` (the panel adds `host`; see "New-session requests") | `{projects:[{name, path, lastUsed, trusted}]}`: the five most recent projects on this machine, newest first (`[]` if none). Built from the transcripts Claude Code keeps (`~/.claude/projects/<folder>/*.jsonl`): each folder's newest transcript gives the project's `path` (the `cwd` on its first records) and `lastUsed` (the transcript's modified time, epoch ms), and `name` is the folder's own name. Temp folders (`/tmp`, `/private/tmp`, `/var/folders`, Windows temp), folders that no longer exist and the service's own sessions are left out, and a path appears once, with its newest time. `trusted` is whether `claude --bg` will start there, read from `~/.claude.json` (never written): the folder's own `projects` entry decides (`hasTrustDialogAccepted === true`, so an explicit `false` beats a trusted parent); with no entry of its own, the nearest ancestor's entry below the home folder does; `false` whenever the file can't be read. On the NucBox the transcripts hold paths like `c:\Users\owner\x` and the file's keys read `c:/Users/owner/x`, so two paths are one folder whatever their slash direction or case. Demo mode (`CLAUDE_THING_MOCK=1`): five fixed projects under `/Users/demo/Projects`, all trusted |
| `claude.session.start` | `{path, prompt}` (the panel adds `host`) | `{shortId}`: starts a background session in `path` and answers once `claude --bg` has printed `backgrounded · <shortId>` (8 hex digits). The command is always `claude --bg --permission-mode auto -- <prompt>`, run in `path` with no input and a 30 s limit, never through a shell, so the prompt is one argument and can never read as an option. On the Mac it runs as its own one-shot launchd job (a private plist in a 0700 temp folder, `launchctl bootstrap`, polled until it exits, then booted out and removed), not as the service's child: macOS then holds Claude Code, not node, responsible for what the session touches, so the owner gets no "node … data from other apps" notices. The job gets the service's environment. Elsewhere (the NucBox) it is a plain `execFile`. A session's id starts with its `shortId`, so the panel finds the new session in the next `claude.sessions.update`. The service remembers the short ids it started (the last 40), so an ask from the new session in the seconds before the poller tags it `background` is held like any background ask (see "Background sessions"). The session is not marked as the service's own: it appears on the panel like any other. Errors, as the message: `empty-prompt` (nothing left after trimming), `prompt-too-long` (over 2000 characters), `not-a-recent-project` (`path` is not in what `claude.projects.recent` returns now: the panel never names a folder of its own), `not-trusted` (Claude Code refused with `Workspace not trusted`: the owner has to run `claude` in that folder once and accept the prompt), `start-failed` (nothing started: the command exited non-zero without being killed, or could not be run at all; the panel may offer the same text again), `start-unconfirmed` (it may have started: the command exited 0 with no job id in its output, or was killed or timed out, so the daemon may already hold the job; the panel reads it as `MAY HAVE STARTED · CHECK THE LIST` and never offers the text again on its own). Demo mode starts no process: it records a `background` session in the store and answers `{shortId}` |
| `claude.session.handoff` | `{id}` | `{result:'opened'\|'waiting'\|'raised'\|'cancelled'\|'failed', reason?}`: the session view's open row. For a windowless background job (see "Background sessions") it moves the session into an ordinary VS Code tab: `claude stop <short id>`, wait until the process is really gone (10 s at most), then open VS Code on the folder the session started in and follow `vscode://anthropic.claude-code/open?session=<id>`. That folder is the first `cwd` in the session's transcript, which is the window that hosts it; a session can later move into a git worktree and report the worktree as its `cwd`, and opening that would start a second window. The transcript is the path a hook reported or, if that is gone (Claude Code moves a transcript into the worktree's project folder when a session enters a worktree), the one derived from the session's current folder. If neither gives a start folder that is a full path and still exists, the session's current `cwd` is used; on the NucBox a full path is one the helper takes (a drive letter or a share, not a drive or share root). The folder is worked out before anything is stopped. A raise (below, and `claude.session.focus`) uses the same folder. On the Mac the open is `open -a "Visual Studio Code" <folder>` and `open` on the link. On the NucBox the service has no desktop to open a window on, so the move goes through the helper task `Car Thing panel - Open in VS Code`, which runs in the owner's logged-on session (details under "Background sessions"). If its turn is over (it has stopped, holds no permission and waits on nothing in `waitingOn`) it moves at once: `opened`. Mid-turn it is not cut off: the answer is `waiting`, the session's `handoff` becomes `'waiting'`, and the move starts from the `Stop` or `StopFailure` hook that ends the turn for good; asking again while waiting answers `waiting` again. On the NucBox the desktop is checked when the row is pressed and again just before the stop; if the owner has logged off by the time the hook starts the move, nothing is stopped and the wait simply ends (`handoff` back to `null`). The wait lives in memory only: a restarted service forgets it and `handoff` reads `null`. A `claude.session.stop` or a `claude.session.handoff.cancel` for the session that arrives while the press is still at its desktop check wins: the press answers `{result:'cancelled'}` and neither moves the session nor sets a wait. If a window has parked on the job by the end of the check, the session is raised instead (`raised`). While the move runs `handoff` is `'moving'`, and a request for a session already moving joins the move and returns its result. A move that opens VS Code clears the session's card (`claude.card.cleared`, reason `switched`), whichever way it started. Any other session (an interactive one, a background job an interactive window has parked on, or any session in demo mode) is only raised, as `claude.session.focus` does: `{result:'raised'}` and its card cleared, or `failed` with the reason the window could not be raised. Reasons: `unknown-session`, `not-background` (a windowless job with no job id), `no-desktop` (the NucBox only: the owner is not logged on there, so there is no session to open VS Code in; nothing was stopped), `not-set-up` (the NucBox only: the helper task is not installed; nothing was stopped), `stop-failed` (`claude stop` failed), `stop-timeout` (the process was not confirmed gone 10 s after the stop), `open-failed` (the agent is stopped but VS Code did not open, which on the NucBox includes the helper failing or not answering in time; the conversation is on disk and VS Code can still resume it. If the folder to open could not be worked out, nothing was stopped), or the window's reason (on the NucBox a raise can also answer `no-desktop` or `not-set-up`) |
| `claude.session.handoff.cancel` | `{id}` | `{result:'cancelled'}`, always, even for an unknown session: ends a wait (`handoff` back to `null`), and a `claude.session.handoff` still at its desktop check answers `cancelled` instead of going on. Nothing else happens: a move already under way carries on |
| `claude.session.handoff.now` | `{id}` | `{result:'opened'\|'failed', reason?}`: OPEN NOW, the same move without waiting for the turn to end. `Continue where you left off.` is put in the session's input box and not sent (`&prompt=` on the VS Code link): the turn it cut off is redone, not resumed. Joins a move already under way. It skips the check made when the row is pressed, so on the NucBox the desktop is checked just before the stop. Reasons: `unknown-session`, `not-windowless` (not a windowless background job on this service, so nothing is stopped), `not-background`, `no-desktop` and `not-set-up` (the NucBox only, as for `claude.session.handoff`; nothing was stopped), `stop-failed`, `stop-timeout`, `open-failed` |
| `claude.session.stop` | `{id}` | `{result:'stopped'\|'failed', reason?}`: the STOP row. `claude stop <short id>`, answered once the process is gone; the agent is left ended. Any wait is dropped first, so a `Stop` hook landing meanwhile can't start a move the owner has just refused, and a `claude.session.handoff` still at its desktop check answers `cancelled` instead of going on. Reasons: `unknown-session`, `not-background` (no job id), `moving` (a handoff is under way), `stop-failed`, `stop-timeout`. Demo mode: nothing is stopped, the answer is `stopped`. This and the handoffs are the only stops the service ever does for the owner; `claude.session.focus`, a card's SWITCH and the held-prompt `vscode` answer never stop anything |
| `claude.usage.get` | `{slim?}` | `Usage` — full reading by default; `{slim: 1}` returns the device-rendered subset (see the Usage shape), which also keeps this synchronous response inside one Bluetooth chunk |
| `claude.digest.get` | `{}` | `Digest` — the whole digest, for a panel that just connected |

### New-session requests

The panel may talk to more than one machine (the Mac, and the NucBox's own copy of this service). Everything about one session or one ask goes to the machine that owns it; `claude.projects.recent` and `claude.session.start` go to the machine the owner picked, which the panel names in `params.host` (`mac`, or the other machine's name). The panel's own multiplexer (`panel/src/ws-mux.js`) routes on `host` and removes it before forwarding, so a service never sees it. A request with no known `host` fails there with `unknown-host`, and one for a machine whose link is down with `not-answering`; neither reaches a service. A service that predates these requests answers `Unknown method`, which the panel shows as `NOT SET UP YET` on that machine's row. The four handoff and stop requests take `{id}` and follow their session like `claude.session.focus`.

## Events (daemon → everyone)

| Topic | Data | Notes |
|---|---|---|
| `claude.sessions.update` | `{sessions:[SessionSummary], stats:Stats, serverNowMs, tzOffsetMin, intProbe}` | full idempotent snapshot of ALL sessions, debounced 500 ms. The device's clock is wrong in both axes — no RTC battery, no NTP, no timezone data — so it takes both from here: `serverNowMs` = the Mac's `Date.now()`, the epoch every device-side duration and countdown is measured against; `tzOffsetMin` = the Mac's `Date.getTimezoneOffset()`, which renders it as local time. Not the frame's `server_timestamp_ms` — nocturned re-stamps relayed frames with the device clock |
| `claude.session.update` | `SessionDetail` | pushed on change for any live session — unless the receiving socket narrowed itself with `claude.session.watch`, in which case only the watched session's details arrive. The only topic watch ever filters |
| `claude.permission.request` | `{requestId, sessionId, tool, summary, intent, createdTs, timeoutMs, destructive, background}` | `timeoutMs` is how long the service holds the ask: 20000 for an interactive session (`PERMISSION_HOLD_MS`; `CLAUDE_THING_HOLD_MS` overrides it), 590000 for a background one, which has `background:true` (see "Background sessions"); `intent` = "you asked: …" from the session's last prompt, "" when unknown; `destructive` = classified daemon-side against the full command (the device's own regex only ever saw the 200-char summary) — clients fall back to their regex when the field is absent |
| `claude.permission.resolved` | `{requestId, resolution:"allow"\|"deny"\|"timeout"\|"unavailable"\|"abandoned"\|"interrupted"\|"panel-gone"}` | closes prompt everywhere; terminal-answered too. `timeout`: an interactive hold ran out and Claude Code's own prompt took over (or the hook gave up on its side first). `abandoned`: the hook's socket closed while a background ask was held (the agent was stopped): there is no terminal to answer in, so the panel clears the ask without a notice. `unavailable`: a background ask ran out its hold unanswered and Claude was refused with a reason (see "Background sessions"); the panel says `CLAUDE WILL ASK LATER`. `interrupted`: the session was interrupted with Esc. `panel-gone`: the last panel left and an interactive hold went back to Claude Code's prompt |
| `claude.question.request` | `Ask` (kind `question`) | a multiple-choice question is on screen in some session |
| `claude.question.resolved` | `{id, resolution:"answered"\|"timeout"}` | the question is gone, however it was answered |
| `claude.card.posted` | `Card` | a new or replaced card (one per session: a newer finished turn replaces the older), and the same card re-sent with `loud:false` when it goes quiet 10 minutes after it was posted. Also re-sent when a digest summary lands on it. Never superseding: unlike `claude.session(s).update`, it is not dropped for a backed-up socket, since an ASKING card must not be lost. A replaced card gets no `claude.card.cleared`; the panel drops the older one of that session itself |
| `claude.card.cleared` | `{id, sessionId, reason}` | the card is gone. `reason`: `typed` (the owner typed into that session on the Mac), `replied` (a reply from the panel was delivered), `switched` (`claude.session.focus` raised the session), `cleared` (`claude.card.clear`), `ended` (the session ended; ASKING and ERROR cards only), `expired` (an UPDATE card 2 hours after its session ended) |
| `claude.usage.update` | `Usage` (slim) | pushed once a minute, carrying only the device-rendered subset: no `subscription`, no `notes`, no `mcp`, first window only, top lists capped at 3. `claude.usage.get` returns the full reading |
| `claude.digest.update` | `Digest` | full idempotent snapshot pushed on change, debounced 2 s; superseding: dropped for a backed-up socket, like sessions and usage |
| `claude.mac.power` | `{display:'on'\|'off', sleeping:boolean}` | the Mac's display and sleep state, pushed on every change and also sent on every client hello (beside `claude.queue.sync`), so a panel that reconnects after a Mac service restart learns it at once. Read from a small Swift helper (`mac-service/native/power-watch.swift`, compiled on first use to `~/.cache/claude-panel/power-watch`) listening for `screensDidSleep`/`screensDidWake`/`willSleep`/`didWake`. `display` follows the screen alone; `sleeping` follows system sleep alone, so a wake leaves `display` as it was until the screen lights. Starts as `{display:'on', sleeping:false}`. The helper reports the current display state once when it starts (and each (re)start resets `sleeping` to false, since a running helper means the Mac is awake), so a restart can't leave a stale state. If the helper can't compile or run the state stays at that default, so a client must not read it as proof the Mac is awake. The panel treats `display:'off'` or `sleeping:true` as "Mac not active" |
| `claude.daemon.status` | `{connected:bool}` | synthesized by relays on daemon link up/down — never sent by the daemon itself |

## The chime

The Mac plays a short system sound (`afplay /System/Library/Sounds/Glass.aiff`, detached, so nothing waits on it) when something needs the owner, at the moment the service announces it. Loud cards (`asking` and `error`) and upstream questions (`claude.question.request`) chime whether or not a panel is connected. For an interactive session, permission requests and held questions or plans (`claude.permission.request`, `claude.prompt.created`) chime only while a panel is connected, because they are only held and announced then; with no panel the service answers the hook at once and Claude Code's own terminal dialog takes the interaction, so there is nothing to chime for. A background session's asks are held and announced with or without a panel (see "Background sessions"), so they chime whether or not one is connected. At most one chime per 10 s, so a burst of finishing sessions makes one sound. A card going quiet, and a digest summary landing on a card, never chime. It is on by default and switched with `claude.prefs.set {chime}`; the setting is read on every ring, so it takes effect at once.

## Questions and plans answered through hooks

A `PreToolUse` hook on `AskUserQuestion|ExitPlanMode` posts to `/hook?hold=1` (timeout 600 s, so it outlasts the longest hold; an installation that predates this has 130 s, and `npm run install-hooks` in `mac-service` brings it up to date). With a panel connected the service holds it for up to 120 s and emits:

- `claude.prompt.created` `{kind:'prompt', id, sessionId, sessionName, intent, tool, questions | plan, context: Message[] (last 6), holdMs, background, createdTs}`, where `holdMs` is 120000, or 590000 with `background:true` for a background session
- `claude.prompt.resolved` `{id, sessionId, resolution}`, where resolution is `answered | approved | feedback | vscode | timeout | unavailable | panel-gone | abandoned`

The hook answers with `permissionDecision:"allow"` plus `updatedInput` (questions + `answers`, or the plan echoed), `"deny"` plus a `permissionDecisionReason` carrying plan feedback, or `{}` (no opinion: Claude Code shows its own dialog). For an interactive session with no panel connected it answers `{}` at once, and at the end of a hold, or when the last panel leaves, it answers `{}` too (`timeout`, `panel-gone`): an interactive prompt is never refused. A background session has no dialog to go back to, so its prompt is held for the full 590 s with or without a panel, survives the panel leaving, and at the end of the hold is refused: `"deny"` plus a `permissionDecisionReason` that tells Claude the owner wasn't there (resolution `unavailable`; see "Background sessions"). Held prompts are listed in `claude.queue.list`. Nothing is ever typed: an upstream `claude.question.answer` only raises the session's window and returns `reason:'answer-on-mac'` (or errors `answer-in-vscode` for VS Code sessions).

## Background sessions

A background session is a `claude --bg` job: it runs under Claude Code's daemon rather than in a terminal, so it often has no window to raise and no owner at a keyboard to answer an ask. The registry marks it `kind:'background'` (`SessionSummary.background`). The panel starts them (`claude.session.start`) and moves them into VS Code (`claude.session.handoff`), and the service treats their asks differently from an interactive session's:

- **Which sessions.** For asks, a session counts as background when it is a `background` job that no interactive window has parked on (`parkedJobId` in the registry: that window is its UI now), or when this service started it itself and the poller has not yet said what kind it is (the poller tags `kind` every few seconds, and an ask in that gap would otherwise read as an interactive window's). Once the registry names a kind, the registry decides: a job opened in VS Code is interactive from then on.
- **Held for the panel, not handed back.** A permission, question or plan from such a session is held for 590 s (`BG_HOLD_MS`) with or without a panel connected, so a Car Thing that reconnects within the hold can still answer. The last panel leaving does not release it. Its events carry `background:true`, `timeoutMs` and `holdMs` are 590000, and `claude.queue.list` includes it with `timeoutMs` 590000. A background prompt cannot be answered with `{kind:'vscode'}`.
- **Refused at the end.** An ask nobody answered is refused, not handed to a dialog: a permission gets `behavior:"deny"` with the reason above (resolution `unavailable`); a question or plan gets `permissionDecision:"deny"` with the same text as `permissionDecisionReason` (resolution `unavailable`). The agent then ends its turn saying what it needs, which becomes an `asking` card the owner can answer by voice later.
- **Hook timeouts.** Both held hooks must outlast the hold: `PermissionRequest` is installed with 600 s and the `PreToolUse` `?hold=1` hook with 600 s. Re-run `npm run install-hooks` in `mac-service` after pulling; an installed 130 s question hook would give up first.
- **Every other session keeps its rules**: held only with a panel, 20 s for a permission and 120 s for a question or plan, then handed back to Claude Code's own dialog, never auto-denied.
- **Opening VS Code on the NucBox.** The NucBox's service runs as a scheduled task with no desktop, so a window it opened would appear on no screen. It asks the helper task `Car Thing panel - Open in VS Code` (`nucbox/open-in-vscode.ps1`), which runs as the owner in the owner's own session, never starts by itself, and has no port. The two talk through the folder `%USERPROFILE%\.config\claude-panel\open-in-vscode\`: the service writes `request.json` `{nonce, sessionId, cwd, continue, createdTs}`, runs `schtasks /run /tn "Car Thing panel - Open in VS Code"`, and waits up to 15 s for `result.json` `{nonce, ok}` or `{nonce, ok:false, reason}` with the same `nonce` (any other is ignored). Both are UTF-8 without a BOM. The helper deletes the request as it reads it, then refuses one older than 60 s (`stale`), a `sessionId` that is not a UUID or a `cwd` that is not a full Windows path (`bad-request`), a drive root (`bad-request`) and a folder that does not exist (`no-folder`). Otherwise it sets `ELECTRON_NO_ATTACH_CONSOLE=1` (so a `Code.exe` started cold does not hold the task's hidden console, and the task ends once the request is answered), starts `Code.exe` on the folder, waits 1.5 s and opens `vscode://anthropic.claude-code/open?session=<id>`; `continue:true` (OPEN NOW) adds `&prompt=Continue%20where%20you%20left%20off.`. The request carries that flag, never prompt text. `code-failed` means `Code.exe` was missing or would not start, and the service adds `helper-not-run` and `helper-timeout`. Calls take turns, one at a time.
- **The desktop check (NucBox).** Before it stops anything, the service asks `check()`: the helper task exists (`schtasks /query`), else `not-set-up`; and `quser` lists the owner as `Active` or `Disc` (a closed Remote Desktop window still counts), else `no-desktop`. The check runs when the row is pressed, and again just before the stop, because a wait can last a whole turn and OPEN NOW skips the check at the press. A refusal answers `{result:'failed', reason}` with the agent still running. When `schtasks /query` or `quser` fails, the service logs the first line it printed (`DO`), so a refusal right after a deploy can be diagnosed. `claude.session.stop` never asks: ending an agent needs no desktop.
- **Which NucBox sessions are raised.** `claude.session.focus`, and the raise inside `claude.session.handoff`, go through the same check and helper, but only for an `interactive` session whose own registry entry (`~/.claude/sessions/<pid>.json`) says VS Code started it (`entrypoint: claude-vscode`). `host` is no guide there: it reads `vscode` for every NucBox session, background ones included, because nothing walks a process tree on Windows. `kind` alone is not enough either: `claude agents --json` also calls a `claude` run in a terminal `interactive`. Any other session still has its process running somewhere, and a tab opened on it would put two processes on one conversation. When the registry is why a session is refused (no entry, or another entrypoint), the service logs it (`FC`). Moving one is `claude.session.handoff`, which stops it first.

## Turn-end hooks and the inbox

Every finished turn becomes a card, from one of two http hooks (both POST to `/hook`, with the event in the payload's `hook_event_name`):

- `Stop` (5 s timeout) posts an `asking` or `update` card from the payload's `last_assistant_message`. A turn that left background work running posts no `update` card until that work is done; an `asking` card still posts.
- `StopFailure` (5 s timeout) posts an `error` card for a turn that died on an API error. Its text is Claude's partial message (`last_assistant_message`, if any) followed by the error and its details as one closing paragraph, so the card's `excerpt`, which is the closing paragraph, is the error. `scripts/install-hooks.js` installs it with the others; re-run the installer after pulling.

The service answers a hook only after `sources.onHookEvent` returns, so Claude Code waits on it. To see how long that takes, start the service with `CLAUDE_THING_HOOK_TIMING=1`: each hook event then logs one line, `HK timing <event> <ms>ms`, to the console and `mac-service/logs/daemon.log`. Unset (the default) nothing is measured or logged.

The inbox remembers each session's recent stop times itself (`noteStop`, called on every `Stop` and `StopFailure` before anything is posted, and seeded from restored cards), so a turn that posted no card still bounds the next card's window. The memory is in-process only. A digest (`attachSummary(sessionId, turnEndTs, {headline, bullets})` in `mac-service/src/inbox.js`) lands on a card only when `turnEndTs` is after both the card's `prevStoppedTs` and `stoppedTs - 120 s`, and no more than 15 s after `stoppedTs`.

## Shapes

`Message = {role: 'user'|'assistant'|'tool', text, ts, fromPanel?}`. `user` is a typed prompt only (no tool results or injected meta lines); `assistant` joins the text blocks (no thinking); `tool` is `"<name>: <salient input>"`. Text is clipped to 2000 characters with `…`, except the newest assistant reply, which keeps up to 8000. `tool` messages appear only where the full transcript is wanted (a held prompt's `context`); `claude.session.messages` never returns them, nor task notices. `fromPanel: true` marks a `user` message that is a reply the owner sent from the panel (see `claude.session.messages`); it is absent otherwise.

`SessionSummary.name` is the Claude Code title (custom rename, then AI title), then the registry name, then the folder; at most 60 characters. `SessionSummary.project` is the folder name (`''` if unknown).

`SessionSummary.subagents = {running, finished}`, refreshed every 2 s for live sessions.

`SessionSummary.background` is `true` for a `claude --bg` job (the registry's `kind` is `background`), whether or not a window has since taken it over; `false` otherwise. `SessionSummary.handoff` is `null`, `'waiting'` or `'moving'`: a request to open this background job in VS Code (`claude.session.handoff`) waiting for its turn to end, or under way. It lives in memory only, so a restarted service reports `null`. A background job is registered under its folder's name until Claude Code titles it, so for one a registry name that is empty or equal to `project` doesn't count: with no title either, `name` is its prompt, whitespace collapsed, so several jobs in one folder can be told apart.

`SessionSummary.waitingOn = [{type, label, since}]`: what a finished turn left in flight, from the Stop payload's `background_tasks` and one-shot `session_crons`. `type` is the task's type (`'cron'` for a scheduled wakeup), `label` at most 60 characters (a shell's command, else its description or agent type; `"wakes at 3:40"` for a cron), `since` the Stop time in epoch ms. `[]` when nothing is in flight. A session with a non-empty list reads `busy`, not `celebrate`. It clears on the session's next Stop (replaced by that Stop's list), a prompt, a tool call, or the end of the session.

`Subagent = {id, description, agentType, background, depth, parentId, running, currentTool, startedTs, lastActivityTs}`. `running` is false once the meta says `finished` or `stoppedByUser`, or the session has ended. `parentId` comes from the meta's `parentAgentId`, else from the agent whose transcript issued the spawning tool call. `currentTool` is the last tool call as `"<name>: <salient input>"`.

```ts
SessionSummary = {
  id: string,            // session id
  name: string,          // project dir basename, ≤32 chars
  state: "busy"|"attention"|"celebrate"|"idle",
  lastActivityTs: number,      // epoch ms
  tokens: { in: number, out: number },
  pendingPermission: boolean,
  ended: boolean,       // idle-and-over vs idle-and-quiet
  context: number|null, // 0..1 of the model's context window; null when the
                        // model is unknown, so the device draws no meter
                        // rather than a meter against a guess
  permissionMode: string|null, // "plan"|"bypassPermissions"|"acceptEdits"|
                        // "auto"|"default"; null until a hook or transcript
                        // record says — the device draws no badge for null
                        // or anything it can't name
  effort: string|null,  // reasoning effort of the newest turn, off the
                        // transcript's assistant records ("low"…"max",
                        // "ultrathink"); null until one says — the device
                        // then draws no effort label and keeps the plain
                        // working sprite
}
// ~290 B each measured (~330 worst case), unbounded count — the device grid
// scrolls sideways through them. Over Bluetooth an async event snapshot spans
// multiple chunks, which the chunking layer handles; a *synchronous* response
// cannot, so a constrained client should pass `limit` on claude.sessions.list
// and rely on the event stream for the full set. The daemon also enforces this
// for relay roles that forget: see claude.sessions.list above.
//
// intProbe is wire hygiene, not data: the daemon always sends the integer 1,
// and clients must ignore its value except as a transport check. The Mac
// connector's MsgPack packer historically coerced NSNumber 0/1 to booleans; a
// client that receives intProbe === true knows the link still coerces and
// should repair numeric fields (the device's unbool walk), one that receives
// 1 knows the link is clean and can skip the repair.

SessionDetail = SessionSummary & {
  contextTokens: number, // what the newest turn sent — the raw numerator
  cwd: string,
  model: string,
  startedTs: number,
  currentTool: string|null,
  lastMessage: string,   // ≤200 chars
  permission: { requestId, tool, summary, intent, createdTs, timeoutMs, destructive, background } | null,
}

Stats = { active: number, attention: number }

Ask =
  | { kind:"permission", id, sessionId, sessionName, tool, summary, intent, createdTs, timeoutMs, destructive?, background? }
  | { kind:"question", id, sessionId, sessionName, intent, createdTs,
      questions: [{ header, question, options:[{label, description}], multiSelect }],
      // mirrors of questions[0] — the card's summary line, and what a client
      // that predates grouping reads
      header, question, options, multiSelect }
// One AskUserQuestion call is ONE dialog and one ask, however many questions it
// carries: the terminal walks them in order and ends on a "Submit answers"
// step. Splitting it per question leaves that step with no card and no
// keypress, and the session blocked on a dialog every question of which was
// answered.
// intent: "you asked: " + the session's last user prompt (≤120 chars,
// whitespace-collapsed), or "" when no prompt has been seen — the device
// omits the hero's intent line rather than inventing one

Card = {
  kind: "card",
  id: string,            // "card:<sessionId>:<stoppedTs>"
  sessionId, sessionName,
  host: string|null,
  tag: "asking"|"update"|"error",  // ASKING: the turn's closing paragraph asks a question; ERROR: the turn failed (StopFailure); UPDATE: anything else
  text: string,          // the session's last message, ≤8000 chars with a trailing …
  excerpt: string,       // the closing paragraph of the whole message (past the clip too), for the hero and the stack row
  intent: string,        // "you asked: …" as for an ask, "" when unknown
  createdTs: number,     // when the card was posted
  stoppedTs: number,     // when the turn stopped
  loud: boolean,         // true for 10 minutes from posting, for asking and error cards only; never for update
  loudUntil: number,     // epoch ms; 0 for an update card
  endedTs: number|null,  // when the session ended, set only on an update card (which then lives 2 hours)
  summary: { headline: string, bullets: string[] } | null,
                         // a digest's model-written summary of this turn, shown in place of the excerpt
  prevStoppedTs: number|null,
                         // when the session's previous turn stopped, whether or not that turn left a card
                         // (it may have been cleared, or held back by background work); null when the service
                         // has none on record. A digest must have ended after it, so turn N's summary can't
                         // land on turn N+1's card
}
// One card per session. `loud` is owned by the daemon: when it flips to false
// the card is re-sent, so a client never compares its own clock with the Mac's.
// Cards persist across a daemon restart in .state/inbox.json (mode 0600: it
// holds message text); one reloaded past its loudUntil comes back quiet; one saved
// before prevStoppedTs existed comes back with it null.

Usage = {
  updatedTs, updatedLabel, subscription?, stale?, error?,
  limits: [{ key, label, used /* 0..1 */, detail /* "resets Jul 30 at 5:19am" */ }],
  windows: [{
    window /* "Last 24h" */, requests, sessions,
    notes: [string],                        // every bullet, verbatim
    // "Top skills: /x 4%, /y 1%" is a table wearing a sentence; split so the
    // device renders rows. Empty when that bullet is absent.
    skills:    [{ name, pct }],
    subagents: [{ name, pct }],
    mcp:       [{ name, pct }],
  }],
}
```

```ts
Digest = {
  updatedTs: number, windowHours: number,
  summarizer: { state: 'ok'|'off'|'offline'|'model-not-loaded'|'error', model: string|null, lastOkTs: number|null },
  totals: { sessions, turns, commits, prs, testRuns },     // the fleet strip; deterministic
  cards: [DigestCard],                                     // newest finished turn first, at most 20
}
DigestCard = {
  sessionId, title, project, ended: boolean, lastTurnTs,
  facts: { turns, files, commits, prs, tests: {passed, failed, runs}|null, agents: {finished, running} },
  lines: [string],          // the facts-only bullets, already redacted
  lastReply: string,        // first sentence of the newest final reply, ≤80 chars
  summary: { headline, bullets: [string], outcome, model, generatedTs } | null,
  behindTurns: number,      // finished turns since the summary's position
}
```

Milestone 1: `summarizer.state` is `'off'`, `summary` is `null`, `behindTurns` is `0`; `lines` and `lastReply` are redacted. A card's live state comes from `claude.sessions.update` by `sessionId`; a session missing from it is ended.

## Answering questions is not symmetric with permissions

A permission is answered by the daemon: it holds the `PermissionRequest` hook's
HTTP response and replies with the decision. **A multiple-choice question cannot
be.** No Claude Code hook can supply a tool result — `PreToolUse` on
`AskUserQuestion` can only allow, deny, or rewrite the question, and
`PostToolUse` runs after the human has already answered. So the device learns
about questions from the `PreToolUse` hook and answers them the only way
available: focus that session's terminal window and type the keys.

### The keys

This is the one part of the system that cannot be derived from any code here —
it is the terminal UI's contract, read out of the Claude Code CLI itself
(2.1.220). It lives in `keySequence()` in `daemon/src/queue.js`, and the whole
set is typed in **one** osascript call so focus cannot move mid-sequence:

| Step | Keys |
|---|---|
| single-select question | the option's digit — its `onAnswer` defaults `shouldAdvance` to true, so the digit both picks and advances |
| multiSelect question | a digit per pick (each **toggles**), then **Tab** |
| end of a multi-question dialog | Return, for the "Submit answers" confirm |
| a one-question dialog | no trailing Return — it hides the Submit tab, and a stray Return would answer whatever came next |

### One answer at a time

There is one keyboard and one frontmost window, so `claude.question.answer`
serializes: focus and typing run together inside a single lock in
`daemon/src/focus.js`, and `claude.session.focus` takes the same lock. Nothing
else enforces it — the hub handles every socket frame in its own task, so two
answers arriving together would otherwise interleave their keystrokes into
whichever window was in front, which across sessions means digits landing in
the wrong terminal. A raise slipping between an answer's focus and its
keystrokes is the same bug, hence the shared lock.

Answers do arrive in bursts. The device holds each answer for its undo window,
but starting a new one flushes the previous immediately — so answering three
cards quickly sends three answers back to back, and only the last waits.

An answer that is resolved while queued behind another — the terminal answered
it, or Esc killed it — is dropped rather than typed: the dialog it was meant
for is gone, and its keys would answer whatever replaced it.

**Return does not commit a multiSelect.** Inside the list it activates the row
under the cursor, so a Return there toggles option 1 again — which is exactly
what a device answer used to do, twice, instead of submitting. The list's own
move-on control is a button below the options labelled "Next" (or "Submit" on
the last question), reachable only by walking the cursor past every option and
the "Other" row. Tab does not depend on where the cursor is: a multi-question
dialog draws a tab strip ending in a `✓ Submit` tab and hints "Tab/Arrow keys
to navigate", and that Submit tab is the "Review your answers" screen the
trailing Return confirms.

The device holds every answer locally and sends the whole set at once, so a
dialog is never left part-answered by a walk the user abandoned — and so any
answer stays editable until the last press. The daemon validates the set
(one pick per single-select question, in-range indices, no repeats) before
touching the keyboard, for the same reason.

`claude.question.answer` reports how far it got:

| Result | Meaning |
|---|---|
| `accepted:true, viaKeyboard:true` | the whole sequence was typed into the terminal; `keys` is what was sent |
| `accepted:true, viaKeyboard:false` | window focused, but macOS would not let us type — the user answers it |
| `accepted:false` | no window to focus (background agent, or no registry entry), or the answer set did not match the ask; `reason` says which |

Focus uses Claude Code's own session registry: `~/.claude/sessions/<pid>.json`
maps `sessionId → pid`, `ps` maps pid → tty, and Terminal.app's AppleScript
dictionary maps tty → tab. Other emulators can only be raised as an app.
Typing additionally needs Automation → System Events; when macOS denies it we
say so rather than looking for another way in.

## Usage comes from Claude Code itself

`claude -p "/usage"` runs the slash command locally and prints the real plan
figures — session and weekly percentages, reset times, and the "what's
contributing" breakdown. It performs no inference (zero model tokens) and with
`CLAUDE_CODE_SKIP_PROMPT_HISTORY=1` writes no transcript, so the daemon polls it
once a minute and parses the text. Nothing is estimated and no denominator is
invented.

State machine (daemon-side): `busy` while tool/response activity within 10 s;
`attention` when pending permission or waiting for user input; `celebrate` for
20 s after a Stop with no pending input, then `idle`; `idle` otherwise.

## Permission flow

1. Claude Code `PermissionRequest` hook POSTs to daemon `/hook` (installed with
   a 600 s hook timeout, which outlasts every hold). The daemon holds it, but
   for how long depends on the session:
   - an interactive session (a window, or a terminal, to fall back to): up to
     20 s (`PERMISSION_HOLD_MS`), and only while a panel is connected. With no
     panel it answers `behavior:"ask"` at once, with no event;
   - a background session (see "Background sessions"): up to 590 s
     (`BG_HOLD_MS`, just under the hook timeout), whether or not a panel is
     connected.
2. Daemon emits `claude.permission.request` (`timeoutMs` is the hold,
   `background` says which kind); device auto-surfaces the screen.
3. Device sends `claude.permission.answer`; daemon responds to the held hook
   request with `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"|"deny"}}}`
   and emits `claude.permission.resolved`.
4. With no answer at the end of the hold:
   - interactive: daemon responds `behavior:"ask"` (falls back to the
     terminal prompt: an interactive session's ask is never auto-denied) and
     emits `resolved{timeout}`. The same happens at once, with
     `resolved{panel-gone}`, when the last panel disconnects;
   - background: there is no prompt to fall back to (it would sit on a dialog
     nobody can see), so the daemon responds `behavior:"deny"` with a reason
     in `decision.message` and emits `resolved{unavailable}`. The reason is
     "The owner wasn't at the desk panel to answer this, so it was not done.
     Don't retry it now. End your turn and say in your final message what you
     need from them." Claude Code quotes `decision.message` to the agent (a
     `reason` field there is ignored; checked on 2.1.319). A background ask
     also stays held when the last panel disconnects, and is answered by one
     that reconnects within the hold.

## Hardware note

nocturned only forwards allow-listed methods to the phone. `claude.*` requests
on real hardware require the one-arm patch in
`patches/nocturned-claude-forward.patch`. Phone→UI **events** need no nocturned
change (verbatim passthrough).
