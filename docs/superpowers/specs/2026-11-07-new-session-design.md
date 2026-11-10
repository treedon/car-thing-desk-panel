# New session from the Car Thing — Design

**Status:** Implemented (Mac: PR #24, #25; NucBox: PR #26, #27; owner confirmed the last live checks 2026-11-08). Approved by the owner 2026-11-07, from the desk panel.
**Date:** 2026-11-07

## Intent

The owner wants to start a new Claude Code session from the Car Thing, on the Mac or the NucBox, without sitting down at a computer and without being pulled out of what they were already doing. Today the panel can watch sessions, answer their questions and permission asks, and send a spoken reply to one, but every session has to be started at a keyboard.

The Car Thing sits at the owner's desk now. The owner may build a second dock somewhere else in the house, so starting a session must not depend on being at the Mac.

The session runs in the background on the chosen machine and shows up on the panel like any other session. When the owner is back at the Mac, "Open in VS Code" moves it into a normal VS Code tab with its full history.

## Goals

- From the sessions grid, the owner picks a machine, then a project, then says what the session should do, checks the text, and starts it. Nothing on either computer moves, opens or takes focus.
- The new session runs in **auto mode** and still asks the owner on the Car Thing whenever it needs them (owner's words: "it should be in auto mode … but it still should ask me on the car thing").
- The new session behaves like every other session on the panel: its tile, its session view, its queue cards, the digest, permission asks, questions and spoken replies.
- On the Mac, "Open in VS Code" moves a background session into an ordinary VS Code tab, same session id and name, full history.

## Non-goals

- Starting sessions from outside the home network. A second dock would be on the same Wi-Fi; anything further is a separate project.
- Choosing the model or effort on the panel. The session uses whatever the machine's Claude settings already use.
- Typing a folder path, or picking a project that isn't among the machine's five most recent.
- Cloud sessions (already a separate, later project in the queue-inbox design).
- Slash commands, compact, model or effort changes on running sessions (still deferred, see the panel design).

## Anti-goals (failures even if it works)

- Anything on either computer pops up, steals focus or changes windows when a session starts.
- A session starts before the owner has seen the transcribed text and pressed to start it.
- A session starts in a folder the owner didn't pick, or one the Car Thing named directly.
- A session runs with `bypassPermissions` or `dontAsk`.
- "Open in VS Code" leaves two live processes writing one conversation.

## What was verified before writing this (2026-11-07)

On the Mac, Claude Code CLI 2.1.220, VS Code extension 2.1.319:

- `claude --bg --name "<n>" "<prompt>"`, run in the project folder, starts a background agent and returns at once. It prints `backgrounded · <8-hex short id> · <name>`, then `claude attach|logs|stop <short id>` lines. No window opened.
- `--bg` ignores `--session-id` and warns (`--bg manages the session id`). The full id appears in `claude agents --json` as `sessionId`, with `id` = the short id, `kind: "background"`, `status`, `state`.
- The transcript is written to the normal `~/.claude/projects/<project>/<sessionId>.jsonl`. The agent's Stop hooks ran. The agent ran in manual permission mode (the default) with Remote Control on (`/rc active`), and stayed alive and idle after its turn.
- `claude stop <short id>` ended the process. Then `open "vscode://anthropic.claude-code/open?session=<full id>"` made VS Code resume it as a normal tab. `claude agents --json` then listed the same `sessionId` and name as `kind: "interactive"`, entrypoint `claude-vscode`.
- The extension's `/open` link handler also takes `prompt=`. It only **pre-fills** the input box (`setInputText`); it never sends.
- `--permission-mode` accepts `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan`.

On the NucBox: Claude Code 2.1.204 has `--bg`. VS Code is installed (`code.cmd`). Its five most recent projects by transcript activity are pfact, pf-nametagger, meshcore, testing-lights and camp-light, all last used in September and October. That's why the owner chose to pick the machine first rather than mix the two machines in one list.

Not yet verified, or only partly: see "Verify first" below.

## Decided by the owner

- **Entry:** hold the top button on the sessions grid (`#/list`). It does nothing there today. The top bar shows a small hint, `HOLD TOP · NEW`. No new tile in the grid.
- **Machine first:** a screen with two rows, MAC and NUCBOX, then the chosen machine's projects.
- **Projects:** the five most recent on that machine, chosen at the very start, before speaking. New sessions are almost always in a project the owner has already been working on (owner, at approval), so recent projects are the whole list; brand-new folders aren't offered.
- **Prompt:** spoken with the same hold-to-talk dictation used for replies, checked on screen, then started with a dial press.
- **Permission mode:** auto, with asks still coming to the Car Thing.
- **After start:** the panel opens the new session's view. The computer stays where the owner left it.
- **Open in VS Code while the session is working:** wait until Claude finishes the turn, then move it. (The owner would take "pause and resume at once" if it existed. It doesn't; see the "open now" call below.)
- **Both machines** can start sessions.
- **Asks nobody answers** (owner took Claude's recommendation): today an ask the panel doesn't answer in time is handed back to Claude Code's own dialog. That happens after 20 s for a permission, after 2 min for a question or plan, at once with no panel connected, and when the panel drops off (`releaseAll('panel-gone')`). For a windowless background agent nobody would see that dialog. So for those sessions only:
  - The service holds the ask on the Car Thing for as long as the hook allows: up to 600 s, the hook timeout limit. The builder checks the installed hook timeouts and raises them through `install-hooks.js` if they're shorter.
  - If it's still unanswered then, the service refuses it with a reason telling Claude the owner isn't available and to end its turn saying what it needs. An ask that arrives with no panel connected is held the same way, so a Car Thing that reconnects can still answer it; it is refused only at the end of the hold, 590 s (changed 2026-11-07, as built).
  - That turn end becomes an ASKING card the owner can answer by voice later.

  Every other session keeps today's behaviour and its "never auto-deny" rule.
- **Ending sessions:** a `STOP` row on a background session's view runs `claude stop <short id>`. The first press changes it to `PRESS AGAIN TO STOP` (Claude's call, so a stray dial press can't end a session). No automatic stop after idle time.

The owner saw and approved mockups of the flow (machine, project, speak, check, running). They live in the git-ignored `.superpowers/brainstorm/` folder.

## The flow on the panel

The panel is 800×480, Chrome 69, driven by the dial (turn and press), Back, the four presets and the top button (tap = ambient, hold = talk). Every new screen follows the existing look: topbar with the caps title, a hint strip at the bottom naming the controls.

0. **Pick the machine** (`NEW SESSION`, right side `WHERE?`). Two rows: `MAC` and `NUCBOX`, each with the number of sessions running there, read from what the panel already shows. The cursor starts on the machine used last (kept in the panel's prefs). A machine the panel can't reach shows `NOT ANSWERING` and can't be chosen. Turn = pick, press = choose, Back = cancel to the grid.
1. **Pick the project** (`NEW SESSION · <MACHINE>`, right side `AUTO MODE`). Up to five rows: folder name and when it was last used (`NOW`, `YESTERDAY`, `NOV 4`). Turn = pick, press = choose, Back = to the machine screen. If the machine has no recent projects, the screen says so and only Back works.
2. **Say what it should do** (`NEW SESSION · <PROJECT>`). The existing dictation screen and limits: hold the top button and speak, release to transcribe, 30 s at most. Back = cancel.
3. **Check it, then start.** The transcribed text, large, and a line `<PROJECT> · AUTO MODE · ASKS ON THE CAR THING`. Press = START, hold top = say it again, Back = cancel. Nothing runs before this press.
4. **It's running.** The panel opens the new session's view as soon as the session appears in the machine's list. It shows the spoken prompt as the first message and a working lamp. If the session doesn't appear within a short time, the panel says it started but isn't listed yet and returns to the grid. If the machine refused or failed, the panel shows why (`toast`) and stays on the check screen so nothing spoken is lost.

From then on it's an ordinary session on the panel.

**As built (2026-11-07).** The sections above are as decided; where the built flow differs, or fills in something left open, this is how it behaves:

- **Untrusted projects (R4).** A project Claude Code won't run in the background (it has no accepted trust prompt in `~/.claude.json`) is still listed, but dimmed, with `TRUST IT ON THE MAC FIRST` instead of its last-used time, and pressing it only says so. It can't be started from the panel.
- **The check line (R15).** Until the Car Thing check has shown that asks from a started session reach the panel, the check screen's line reads `<PROJECT> · AUTO MODE`, without `· ASKS ON THE CAR THING`.
- **After START (R17).** The panel goes straight back to the grid and toasts `STARTING…`; it doesn't wait on the check screen. When the new session appears in the list it toasts `STARTED`, and opens its view only if the owner is still on the grid. If they have moved on, it just says `STARTED`.
- **A start that didn't go through (R18-R20).** A start the machine refused (`not-trusted`, `start-failed` and the like: nothing ran) reopens the check screen with the same text only when the owner's hands are free: no dictation going, on the grid, the new-session screens or the ambient screen, and no input in the last second. Otherwise it toasts the reason and keeps the text for the next hold of the top button on the grid. An outcome nobody can vouch for (the request timed out, the socket closed, or the service answered `start-unconfirmed` because `claude --bg` was killed or printed no job id) reads `MAY HAVE STARTED · CHECK THE LIST`, and never reopens the check screen on its own: the session may be running already, and starting again would start a second one.

## The service side (Mac and NucBox)

Both machines run the same service (`mac-service`, copied to the NucBox), so both get the same two requests. Names are the builder's.

- **Recent projects**, for example `claude.projects.recent`. Returns up to five `{ name, path, lastUsed }`, newest first, from the `cwd` of the newest transcript in each `~/.claude/projects/*` folder. It leaves out:
  - temporary folders (`/private/tmp`, `/var/folders`, Claude scratchpads, the Windows temp folder),
  - folders that no longer exist,
  - the service's own spawned sessions (`own-sessions.js`).

  `name` is the folder's last path part.
- **Start a session**, for example `claude.session.start`. Takes `{ path, prompt }`.
  - **`path` must be one of the paths the service's own recent list returns right now;** anything else is refused. The Car Thing never names a folder directly.
  - It runs Claude in that folder as `claude --bg --permission-mode auto <prompt>`, with the prompt as a single argument, never through a shell. The prompt must not be read as a flag even if it starts with `-`.
  - *Fixed after the first live check (2026-11-07):* on the Mac the command runs as its own one-shot launchd job, not as the service's child. As a child, macOS held node responsible for what the session touched: Claude Code reaches into another app's data when it starts, and the owner got two "node" notices with no way to accept (tccd: `responsible=node`, `kTCCServiceSystemPolicyAppDataDetailed`). Launched by launchd, Claude Code is its own responsible process, has a stored decision, and macOS stays quiet. The NucBox keeps a plain child process.
  - It returns `{ shortId }` parsed from the `backgrounded · <id>` line, or an error.
  - The new session must **not** be marked as the service's own session, or the panel would hide it.
- The panel matches the new session in the machine's session list by `sessionId` starting with `shortId`, then opens its view.

Auth is the existing LAN token. With this, the token can start an agent on either machine, which is a step up from answering and messaging existing ones. That's why the path is restricted to the recent list and the mode is fixed to `auto`.

## Open in VS Code for background sessions (Mac)

The session view already has an "Open in VS Code" row (`claude.session.focus`). For a VS Code session it raises the folder's window and opens `vscode://anthropic.claude-code/open?session=<id>` (`mac-service/src/focus.js`). For a background agent it currently returns "background agent — no window to focus", unless a terminal window is parked on it, in which case it raises that window. That stays.

For a background agent with no parked window:

- **Idle** (its turn has ended, including a turn that ended with a question): run `claude stop <short id>`, wait for the process to exit, then do what a VS Code session's "Open" does already: raise VS Code on the session's folder and open the `session=` link. The panel's card is cleared as `switched`, as for any SWITCH.
- **Working:** the row changes to `OPENS IN VS CODE WHEN DONE`. When the turn ends, the service does the idle steps above. Pressing that row again cancels the wait. While waiting, a second row, `OPEN NOW`, appears under it (see the call below). Leaving the screen doesn't cancel the wait. A session waiting on an ask counts as working: the wait goes on until the turn really ends. The wait doesn't expire.
- This applies to any windowless background agent on the Mac, not only ones the panel started.
- **Only that row moves a background agent.** These never stop one:
  - "Open automatically" when a session view opens,
  - SWITCH on a queue card,
  - the "Open in VS Code" answer on a held question or plan.

  For a windowless background agent, the first two keep today's "nothing to raise" result. The held-prompt "Open in VS Code" option is hidden, because it would hand the ask to a dialog nobody can see. Otherwise step 4 of the flow would move every new session into VS Code the moment it starts, whenever "Open automatically" is on.

## Calls made by Claude (owner to check)

- **If auto mode doesn't send its asks to the panel** (verify-first 2): the session stays in auto mode anyway. The owner uses auto mode most. In auto mode a blocked action goes back to Claude, which ends its turn saying what it needs. That reaches the Car Thing as an ASKING card the owner can answer by voice. The check screen's line then reads `AUTO MODE`, without the ASKS part.
- **NucBox in phases:** the code is shared, so it's built once. Milestone 1 builds it and puts it live and verified on the Mac. Milestone 2 deploys and verifies it on the NucBox. It includes the NucBox's Open in VS Code helper. That needs the owner's approval for NucBox changes and coordination with the NucBox session's work, and it touches `nucbox/install.ps1` for the helper task, and again if `--bg` doesn't survive the S4U task. *As built (milestone 2):* until then the panel's NUCBOX row read `NOT SET UP YET`, from the service not knowing the start request. It stopped once main was deployed there (see "NucBox, milestone 2" under "Verify first"). The helper is described in "As built (milestone 2)" under "Open in VS Code for background sessions (NucBox)".
- **Open now:** while waiting, the `OPEN NOW` row stops the agent at once, then opens it in VS Code with `prompt=Continue where you left off.` pre-filled, so one Enter at the Mac picks it up. Whatever was mid-step is cut off and redone, not resumed. The owner asked for wait-until-done unless a real pause existed; this is the closest thing, offered as an option, not the default.
- **Names:** no `--name`; Claude Code names the session the way it names any session. If a session has no name yet, the tile shows the project and the start of the prompt.
- **Machine cursor:** starts on the last-used machine.
- **Unreachable machine:** shown as `NOT ANSWERING`, not hidden.
- **Recent projects:** git worktrees count as their own folders; temp folders don't count.
- **Dictation:** uses the existing transcription path, unchanged.

## Verify first (before building on them): status, 2026-11-07

Run on the Mac with Claude Code 2.1.319. Items 1 and 2 need the owner at the Car Thing and are still to run. The rest is in "Verified so far" below.

1. **Panel hooks inside a `--bg` agent** (permission ask, AskUserQuestion hold, rewake, turn-end cards): **pending: owner at the Car Thing.**
2. **What auto mode does when it would ask** (permission ask reaches the panel, or the turn ends): **pending: owner at the Car Thing.** Until then the check-screen line is undecided between `AUTO MODE` and `AUTO MODE · ASKS ON THE CAR THING`.
3. **Spawning from the services:** **verified on the Mac.** From the launchd service's environment (`env -i HOME=$HOME PATH=/Users/owner/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`, as read from `launchctl print`) `claude --bg` starts an agent and its turn runs to the end. Nothing new appeared on screen (same frontmost app, same list of running apps before and after). It needs the folder's trust (see below). Not tested: that the daemon outlives a service restart. **NucBox half: verified 2026-11-07** (see "NucBox, milestone 2" below).
4. **Pre-filled continue:** **passes, one check by eye pending.** After `claude stop`, `open -a "Visual Studio Code" <folder>` and `open "vscode://anthropic.claude-code/open?session=<full id>&prompt=Continue%20where%20you%20left%20off."` resumed the session as `kind: interactive`, entrypoint `claude-vscode`, same session id and same name, idle. The transcript got no new user message, so the text was not sent. That the input box shows `Continue where you left off.` can only be seen on screen: **pending: owner to check by eye.**
5. **Naming without `--name`:** **verified.** The name is never empty. From the first moment (about 0.1 s after start) it is the whole prompt text, in `claude agents --json` and in `~/.claude/sessions/<pid>.json`, and it stays so to the end of the turn. About 0.7 s after the Stop hook Claude Code replaces it with a generated title (for example `reply ok confirmation`), so a tile renames itself then. A title that appears mid-turn in the transcript (`ai-title`) is not used until then. The name can be long, so the tile should cut it to its first 40 characters; the "project and start of the prompt" fallback isn't needed for the name field.
6. **The NucBox helper:** **its building blocks are verified (2026-11-07)**; see "NucBox, milestone 2" below.
7. **The idle signal:** **verified: the service trusts the Stop hook.** In three runs the Stop hook reached the service 14 to 30 ms before the session file and `claude agents --json` said `idle`; the generated name follows about 0.7 s later. At turn start the status flips to `busy` about 55 ms before the UserPromptSubmit hook. Not exercised: a turn held on an ask (item 1).

### Verified so far (2026-11-07)

Hook replies, probed with a local HTTP hook server on `127.0.0.1:47999` and `claude -p --setting-sources project --permission-mode manual --settings '{"hooks":{...}}'`:

- **PermissionRequest deny text is `decision.message`.** Reply `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"PROBE-DENY-TEXT"}}}` for a Write: Claude's reply quoted `PROBE-DENY-TEXT` exactly, and no file was created. With the same reply using `reason` instead of `message`, Claude saw only the generic `Permission denied by hook`. So Tasks 3 and 4 use `message`.
- **PreToolUse deny text is `permissionDecisionReason`.** Reply `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"PROBE-REASON-TEXT"}}` on a Write matcher: Claude's reply quoted `PreToolUse:Write hook error: PROBE-REASON-TEXT`. It could not be tried on AskUserQuestion itself: in `-p` mode that tool does not exist (`No matching deferred tools found`, also with `--tools "default,AskUserQuestion"`). The AskUserQuestion case needs a real bg agent, so it is part of item 1.
- **A hook of `type: "http"` works** for both events (the server received `POST /perm` and `POST /pre` with the hook payload as JSON).

Command line:

- **`--` ends options for `claude --bg`.** `claude --bg --permission-mode auto -- "-hello: Reply with just OK. Use no tools."` started normally, and the first user message in the transcript is `-hello: Reply with just OK. Use no tools.` with the dash intact.

Folder trust:

- **`claude --bg` 2.1.319 needs the folder's trust to be saved in `~/.claude.json`.** Without it, it exits 1 and, on stderr, prints `Workspace not trusted. Run claude in <folder> once and accept the trust prompt, then retry.` Nothing is started and nothing goes to stdout. It was refused the same way from a clean environment, so the service's environment is not the cause.
- **A folder's own explicit entry beats its parent's.** The main checkout had its own `hasTrustDialogAccepted: false` and was refused even after `/Users/owner/Claude` was set to true.
- **A folder with no entry inherits a trusted parent's.** The worktree (`Spotify_car_thing-newsession`) started a session once the parent was true, and starting it wrote no new entry.
- **The owner's choice, 2026-11-07:** trust all of `~/Claude`. `/Users/owner/Claude` and the six child entries that were not true were set to true. Backups: `~/.claude.json.before-trust-claude-folder` and `~/.claude.json.before-trust-claude-children`. So any project under `~/Claude` starts; a folder elsewhere is refused until the owner runs `claude` in it once and accepts the prompt.
- **Why the morning's probes worked and later ones didn't:** the `claude` symlink moved from 2.1.220 to 2.1.319 at 09:52 that day (`~/.local/bin/claude`, `~/.local/share/claude/versions/`). The morning bg probe in the main checkout (job c41c76b4) ran under 2.1.220, which didn't check. The service runs `claude` from PATH, i.e. 2.1.319, so only 2.1.319 results count.
- **What this means for the build:** the start request must pass the trust message through to the panel (toast) instead of a generic failure, and must not assume a recent project outside `~/Claude` will start. The recent list could mark untrusted folders, reading `hasTrustDialogAccepted` and the parent entries in `~/.claude.json`; that is for the owner to decide.

### NucBox, milestone 2 (2026-11-07)

Run with the owner at the Car Thing and watching the NucBox over Remote Desktop. Before the checks, on the owner's approval (asked with AskUserQuestion that day):
- The NucBox's Claude Code was updated from 2.1.204 to 2.1.319.
- `c:/Users/owner/Claude - server)` was trusted, and so were its four child entries in `C:\Users\owner\.claude.json` (backup: `.claude.json.before-trust-claude-server`). The `c:/Users/owner/Claude/...` and `d:/personal/...` entries stay false.
- Main (dd0e87a) was deployed there with `install.ps1 -ClaudeSessions`, and `install-hooks.js` was re-run.

- **V1, start through the service:** **passes.** `claude.session.start` in "testing lights" answered `{shortId}`. `claude agents --json` listed the job as `kind: background` with a `pid`, and it went idle with the reply `OK`. `parseBackgrounded` reads Windows output as it is.
- **V2, an odd prompt:** **passes.** `-x "quoted" \back\slash\ 100% é ✓ Reply with just OK.` arrived as the first user message exactly, through `execFile` on Windows.
- **V3, asks:** **passes.** An AskUserQuestion from a NucBox background session was held, shown on the Car Thing, and answered there; the session replied with the owner's pick.
- **V4, a service restart:** **passes.** Stopping and starting the sessions task left all three background sessions running, with the same pids.
- **V5, STOP:** **passes** on the NucBox side. It also showed a panel bug on both machines: after the stop, the view kept its STOP row, and pressing it again said `COULDN'T STOP IT`. That's fixed in milestone 2.
- **V6, the helper's mechanism**, probed with two temporary tasks (removed after). From an S4U task (session 0, Limited):
  - `quser` lists owner's `rdp-tcp#0` session as Active.
  - `schtasks /run` starts an Interactive-logon task with no extra permission grant, and that task runs in the owner's session (1).
  - Its action `conhost.exe --headless powershell.exe …` showed nothing on screen (owner watching).
- **V7, the open itself:** **passes.** After `claude stop`, `Code.exe "<folder>"`, a 1.5 s wait, then `vscode://anthropic.claude-code/open?session=<id>&prompt=Continue%20where%20you%20left%20off.` gave the folder's window, the session's tab with its history, and the line typed in, unsent. That held both with VS Code running and with VS Code closed beforehand.

## Constraints

- Panel: Chrome 69 (no flex `gap`, no `inset` shorthand, no `clamp()`), 800×480, existing input mapping in `panel/src/input.js`. The top-button hold on `#/list` is new; elsewhere it keeps its current meaning.
- The NucBox's service copy and `nucbox/` belong to the NucBox session's work (see the agent-digest and NucBox notes). Coordinate before changing `nucbox/`. The NucBox's service copy is behind main and must be redeployed for any of this to work there.
- The NucBox service runs as an S4U task outside the desktop session. It can't raise windows or open VS Code on the NucBox's screen itself (`focus.js` already says so), hence the helper above.
- Shared main checkout: build on a worktree, never `git checkout -b` in the main tree.

## Open in VS Code for background sessions (NucBox)

The owner works on the NucBox mostly through Remote Desktop, sometimes at the machine itself. Either way it's the owner's one logged-in Windows session (`quser` on 2026-11-07: `owner`, `rdp-tcp#0`, active, logged on since 2026-10-15). So "Open in VS Code" for a NucBox session opens VS Code in that session, where the owner will see it whichever way they connect. Opening it on the Mac through Remote-SSH was considered and dropped.

The NucBox's service can't do this itself. It runs as an S4U task in Windows' background session, which has no desktop (`focus.js`: "can't raise windows on the NucBox"). So:

- **A helper runs inside the owner's desktop session.** It's a new NucBox task that runs only while the owner is logged on, like the existing LibreHardwareMonitor task (logon type Interactive). The service asks it, per request, to open VS Code on a folder and then open `vscode://anthropic.claude-code/open?session=<id>` (with `prompt=` for OPEN NOW). Then it exits.
- **The helper does only that:**
  - no listening port and no firewall rule;
  - it takes its request only from the service, for example a file the service writes plus `schtasks /run`. The mechanism is the builder's.
  - it refuses anything but a session id that matches the UUID format and a folder that exists.
- **Same rules as on the Mac:** wait until the turn ends, `OPEN NOW`, and only the session view's row can move a session.
- **Before stopping the agent,** the service checks that the owner has a desktop session (logged on, connected or disconnected). If not, the agent keeps running and the owner is told `LOG IN ON THE NUCBOX FIRST` (as built: a toast that answers the press, not a label the row shows; see "As built (milestone 2)" below). A disconnected Remote Desktop session still counts: VS Code opens there and is waiting when the owner reconnects.
- **It's part of the NucBox phase** (milestone 2). It's a new NucBox task, so it needs the owner's explicit approval before it's installed, goes in `nucbox/install.ps1` and `uninstall.ps1`, and is coordinated with the NucBox session's work.

**As built (milestone 2, 2026-11-07).** The sections above are as decided; where the built helper differs, or fills in something left to the builder, this is how it behaves. The live results are under "NucBox, milestone 2" in "Verify first".

- **The files.** The service writes `request.json` in `%USERPROFILE%\.config\claude-panel\open-in-vscode\`, runs `schtasks /run /tn "Car Thing panel - Open in VS Code"`, and waits up to 15 s for `result.json` in the same folder. The service's `createDesktopOpener()` (`mac-service/src/desktop-open.js`) is one half and `nucbox/open-in-vscode.ps1` is the other. Both files are UTF-8 with no BOM and are written to a temporary file and then moved into place, so neither side reads half a file. Calls take turns, one at a time.
- **The request and the nonce.** The request is `{nonce, sessionId, cwd, continue, createdTs}`. The nonce is 32 random hex digits, new for every request. The result is `{nonce, ok}` or `{nonce, ok:false, reason}`. The service ignores a result with any other nonce, so an answer left over from an earlier call is never taken for the current one. The service removes its request on every way out.
- **The 60 s limit.** The helper deletes the request as it reads it and refuses one older than 60 s (`stale`). A request left behind by a crash or a reboot can never open anything later.
- **What else the helper refuses.** All of these answer without opening anything:
  - a `sessionId` that is not a UUID, a request that is not well formed, a `cwd` that is not a full Windows path (a drive letter or `\\server`) or has characters Windows never allows in a path, and a drive root: `bad-request`;
  - a folder that does not exist: `no-folder`;
  - `Code.exe` missing or would not start: `code-failed`.

  The service adds `helper-not-run` (it could not write the request or run the task) and `helper-timeout` (no answer in 15 s). During a move every one of these reads `open-failed`, because the agent is already stopped by then.
- **`Code.exe` directly, not through cmd.** The helper starts `Code.exe` on the quoted folder, not `code.cmd`, so a folder name with `&`, `^` or `%` never goes through cmd. It waits 1500 ms, then opens `vscode://anthropic.claude-code/open?session=<id>`. 1500 ms worked with VS Code already running and started cold (V7). The helper looks for `Code.exe` only at the per-user install path, `%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe`, so a system-wide VS Code install would answer `code-failed`.
- **A flag, never text.** For OPEN NOW the request says `continue: true`. The helper adds `&prompt=Continue%20where%20you%20left%20off.` itself. A request can't carry prompt text.
- **An owner-only folder.** Requests go through the owner's own folder, not `C:\ProgramData`. The folder is in the owner's profile, which other non-admin users can't write. In ProgramData, any local user can create files.
- **The task.** `install.ps1 -ClaudeSessions` registers it and `uninstall.ps1` removes it. It has no trigger, no port and no firewall rule. It is Interactive and Limited, runs as the owner, stops after 2 minutes, and queues a second run behind the first. Its action is `conhost.exe --headless powershell.exe … -File "C:\ProgramData\car-thing-panel\open-in-vscode.ps1" -DelayMs 1500`.
- **Nothing shows on screen.** `conhost --headless` hid the PowerShell window, so the helper needed no other way to stay out of sight (V6).
- **No permission grant.** The service's S4U account could run `schtasks /run` on the task as it was, so no security descriptor was changed (V6).
- **The desktop is checked twice.** Before anything is stopped, the service checks that the helper task exists (`schtasks /query`, else `not-set-up`) and that `quser` lists the owner as `Active` or `Disc` (else `no-desktop`). It asks when the row is pressed and again just before the stop, because a wait can last a whole turn and OPEN NOW skips the check at the press. A refusal answers `failed` with the reason and the agent keeps running. If the owner logs off while a wait is pending, the wait ends at turn end and the agent keeps running. STOP never asks for a desktop: ending an agent needs none. When `schtasks /query` or `quser` fails, the service logs the first line it printed, so a refusal right after a deploy can be diagnosed.
- **Refusals are toasts, not labels.** The two open rows have their own words: `Moves it to a tab on the NucBox` for a background session, `Brings this session forward on the NucBox` for an ordinary one. A refusal is never a label on either row. It comes as a toast:
  - The move row sends `claude.session.handoff` and toasts the service's answer: `OPENING IN VS CODE` (opened), `OPENS WHEN DONE` (waiting), `LOG IN ON THE NUCBOX FIRST` (`no-desktop`) or `NOT SET UP YET` (`not-set-up`). `OPEN NOW` toasts the same words.
  - The ordinary-session row sends `claude.session.focus` and toasts `OPENING ON THE NUCBOX` at once. The panel drops the answer, so a refused raise (`no-desktop` or `not-set-up`) shows nothing there, as on the Mac.
  - A folder the NucBox hasn't trusted reads `TRUST IT ON THE NUCBOX FIRST`.
  - In a NucBox session's view the "Open automatically" row names the NucBox: `Opening a session here also opens it on the NucBox` when on, `Checking in here leaves the NucBox alone` when off.
- **Same exact experiences (owner, 2026-11-07).** The owner asked for the NucBox to behave as the Mac does. So NucBox background sessions get the move-to-VS-Code row, and an ordinary VS Code session on the NucBox is brought forward through the same helper, as the Mac brings one forward. Three things bring one forward there, each through `claude.session.focus`: SWITCH on its queue card (toast `OPENING ON THE NUCBOX`), the session view's "Open in VS Code" row, and "Open automatically" when its view opens.
  - **Only interactive sessions VS Code started.** `host` is never trusted on the NucBox: it reads `vscode` for every session there, background ones included, because nothing walks a process tree on Windows. `kind` alone can't say either: `claude agents --json` also calls a `claude` run in a terminal `interactive`. A session is an ordinary VS Code one only when it is interactive and its own registry entry (`~/.claude/sessions/<pid>.json`) says VS Code started it (`entrypoint: claude-vscode`). Any other session's process is still running somewhere, and a tab opened on it would leave two processes on one conversation. Moving a background one is the hand-off, which stops it first.
  - Any other session there still answers `can't raise windows on the NucBox`. When the registry is the reason (no entry, or another entrypoint), the service logs which.
- **The trust check reads Windows paths.** On the NucBox a transcript's folder reads `c:\Users\owner\x`, the same folder's key in `.claude.json` reads `c:/Users/owner/x`, and home reads `C:\Users\owner`. Two paths are one folder whatever their slash direction or case. Home is never consulted for a folder below it, as on the Mac.
- **A panel fix found live on both machines (V5).** An ended session no longer shows STOP or OPEN NOW, since the service has forgotten it. A STOP on a session the service no longer knows says `ALREADY STOPPED`, not `COULDN'T STOP IT`.
- **The OPEN NOW row.** The row was named STOP NOW until 2026-11-07, and was renamed OPEN NOW after the owner pressed STOP for it twice in the live check (only the label changed: `handoff-now` and `claude.session.handoff.now` are as they were).
- **Open and raise use the folder the session started in.** A session can move into a git worktree, and its registry entry and the service's record then report the worktree as its folder. Opening that started a second VS Code window beside the one hosting the session, and the session link then found the session "open elsewhere". So every open and raise (the move, the raise, SWITCH, `claude.session.focus`) uses the first `cwd` in the session's transcript, the folder it started in. Claude Code moves the transcript into the worktree's project folder, so the service tries the path a hook reported and then the one derived from the session's current folder. It falls back to the current folder when neither gives a start folder that is a full path (on the NucBox, one the helper accepts) and still exists. The folder is worked out before the agent is stopped, so a failure there leaves the agent running.
- **The helper's task ends after a cold start (found and fixed live, 2026-11-07).** With VS Code closed, the helper started it and wrote its result within about 2 s, but the scheduled task stayed Running until its 2 minute limit (LastTaskResult 267014), and the next request queued behind it and timed out. A `Code.exe` started cold attaches to the console of the process that started it, and here that is the hidden conhost the task runs the helper under, so the task lived as long as VS Code did. The helper now sets `ELECTRON_NO_ATTACH_CONSOLE=1` before it starts `Code.exe`. Verified live on the NucBox: with VS Code closed, the helper started it for a move and the task was back to Ready within about 4 s with LastTaskResult 0.

## Left to the builder

- Request and route names, the exact project-name and date formats, the "not listed yet" timeout, and how the panel's ws-mux routes the two new requests to the chosen machine.
- How the wait for "turn ended" is held in the service (and that it survives a panel reconnect).
- Tests in the style of the existing suites (mac-service and panel), and a simulator demo of the new screens.
