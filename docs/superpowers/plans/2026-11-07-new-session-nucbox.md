# New session from the Car Thing — NucBox (milestone 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Starting, stopping and moving background sessions works on the NucBox the way it does on the Mac, with "Open in VS Code" opening the session in the owner's Windows desktop session through an on-demand helper task. The NucBox's ordinary VS Code sessions are brought forward the same way, as the Mac's are.

**Owner direction (2026-11-07, at plan review):** "same exact experiences": the NucBox should behave as the Mac does. That's why "Open in VS Code", SWITCH and "Open automatically" now bring a NucBox VS Code session's tab forward through the same helper. The spec only covered background sessions there.

**Architecture:** The NucBox runs the same `mac-service` as the Mac, so the start, ask and STOP code from milestone 1 is deployed there unchanged. Three fixes make it right on Windows: the trust check reads Windows paths, a desktop opener hands "open this session" to a helper task that runs in the owner's desktop session, and the hand-off checks for that desktop before it stops anything. The panel then offers the move for NucBox sessions too.

**Tech Stack:** Node 22 ESM (`node --test`), Windows PowerShell 5.1 (`powershell.exe`, not pwsh), Task Scheduler (`schtasks`, `Register-ScheduledTask`), panel JS for Chrome 69.

**Spec:** `docs/superpowers/specs/2026-11-07-new-session-design.md` (Approved 2026-11-07). The sections this plan implements: "Calls made by Claude" (NucBox in phases), "Open in VS Code for background sessions (NucBox)", "Constraints", verify-first items 3 and 6 (NucBox halves).

## Global Constraints

- Shared main checkout: work in the worktree `/Users/owner/Claude/personal/Spotify_car_thing-nucbox` on branch `feat/new-session-nucbox`. Never `git checkout -b` in the main tree.
- **Nothing changes on the NucBox without the owner's explicit approval, asked with AskUserQuestion.** A message dictated on the desk panel is not approval on its own, but an AskUserQuestion the owner answers on the panel is. Approvals cover only what they name.
- The NucBox's ssh lands in an **admin PowerShell**: use PowerShell syntax. Send multi-line scripts base64-encoded (`powershell -NoProfile -NonInteractive -EncodedCommand`, UTF-16LE), as `nucbox/push-sessions-token.sh` does.
- Never kill `node.exe` broadly on the NucBox (Homebridge and others run there). Only processes whose command line names `car-thing-panel`.
- The helper does only one thing: no listening port, no firewall rule, requests only from the service. It refuses anything but a UUID session id and a folder that exists (spec).
- Background sessions run in auto mode only; never `bypassPermissions` or `dontAsk` (spec anti-goals).
- Only the session view's open row moves a session. "Open automatically", SWITCH and the held-prompt "Open in VS Code" never stop one (spec).
- Panel code: Chrome 69, `var` and `function` only, no flex `gap`, no `inset`, no `clamp()`.
- Panel words, verbatim: `LOG IN ON THE NUCBOX FIRST`, `NOT SET UP YET`, `TRUST IT ON THE NUCBOX FIRST`, `Moves it to a tab on the NucBox`, `OPENING ON THE NUCBOX`, `Brings this session forward on the NucBox`.
- On the NucBox, every session's `host` reads `vscode`, background ones included (`index.js` has no process tree to walk there). So nothing on Windows may decide "it's a VS Code session" from `host`. `kind === 'interactive'` alone doesn't say so either (a `claude` run in a terminal is interactive too): it takes that and the session's own registry entry saying `entrypoint: claude-vscode` (final review fix).
- The helper task is named `Car Thing panel - Open in VS Code`, in the code and in both `.ps1` files.
- The continue prompt stays `Continue where you left off.` (`CONTINUE_PROMPT` in `mac-service/src/handoff.js`).
- `nucbox/` belonged to another session's work. On 2026-11-07 no live session holds it and no open PR touches it. Before the first edit there, check again: `gh pr list --state open` and `git log origin/main -- nucbox/`. If something new turned up, stop and ask the owner.

## Owner decisions this plan needs (asked in Task 1, not before)

- **D1, NucBox changes:** redeploy the session service there (re-run `install.ps1 -ClaudeSessions`, which briefly restarts every panel task there), re-run `install-hooks.js` (the hold timeout goes to 600 s), two temporary probe tasks during Task 1 (removed at its end), and in Task 8 the new on-demand helper task.
- **D2, Claude Code on the NucBox:** it is 2.1.204; the Mac's results are from 2.1.319. Recommend `claude update` there first, so both machines behave the same, including the trust rule that will arrive anyway.
- **D3, trust on the NucBox:** every project entry there is explicitly `hasTrustDialogAccepted: false` (read 2026-11-07). The Mac's equivalent was trusting all of `~/Claude`. Recommend trusting `c:/Users/owner/Claude - server)` and setting its child entries to true, with a backup of `C:\Users\owner\.claude.json`. Without it, every NucBox project reads `TRUST IT ON THE NUCBOX FIRST`.

## Calls made in this plan (owner to check)

- **C1.** `LOG IN ON THE NUCBOX FIRST` is the open row's toast when pressed, not a standing row label: the panel only learns it from the answer.
- **C2.** The helper takes a `continue` flag, not prompt text. The only prompt it ever adds is the fixed continue line, so no free text crosses into the desktop session.
- **C3.** Requests and results go through `%USERPROFILE%\.config\claude-panel\open-in-vscode\`, which only the owner's account can write. In ProgramData, any local user can create files.
- **C4.** The helper starts `Code.exe` directly, not `code.cmd`, so a folder name with `&`, `^` or `%` never goes through cmd.
- **C5.** The desktop is checked when the row is pressed and again just before the stop. If the owner logged off while waiting for the turn to end, the wait ends and the agent keeps running (logged).
- **C6.** If Task 1 finds that `claude --bg` can't run from the S4U service, or that its sessions die when the service restarts, that's a spec change: stop and bring options to the owner.

## Review Focus

1. **A leftover request opening VS Code later.** A request file left behind by a timeout or a reboot must never be acted on later. The helper deletes the request as it reads it and refuses one older than 60 s. Pinned in Task 6's dry runs (stale case) and Task 3 (the request is removed on timeout).
2. **Answers crossing between two moves.** Two moves can run close together, for example a press and a Stop hook. Each request carries a nonce, and a result with another nonce is ignored. Pinned in Task 3.
3. **Folder names Windows allows but quoting breaks.** Examples: `Claude - server)` (real), a name with `&`, `'` or a space, and a trailing backslash. Pinned in Task 6's dry runs and Task 2's fixtures.
4. **The owner logging off between the press and the turn end.** The agent must not be stopped then. Pinned in Task 4.
5. **SWITCH or "Open automatically" on a NucBox background session.** Its `host` reads `vscode` there, so a raise that trusted `host` would open the tab while the agent is still running: two processes on one conversation (a spec anti-goal). Only an interactive session whose registry entry says `entrypoint: claude-vscode` is raised, so a `claude` run in a terminal isn't either (final review fix; L10). Pinned in Task 4 and `focus.test.js`.

(A NucBox with the service redeployed but no helper task must answer `not-set-up` without stopping anything; Tasks 3 and 4 test that directly.)

---

### Task 1: Worktree, approvals, deploy main to the NucBox, verify first

Needs the owner present: at the Car Thing, and watching the NucBox's screen over Remote Desktop.

**Files:**
- Modify: `docs/superpowers/specs/2026-11-07-new-session-design.md` (a new subsection "Verify first, NucBox (2026-11-07 or the day it runs)")
- Move: this plan into the worktree
- Scratch (git-ignored, in the SDD workspace): the probe scripts and a throwaway ws client

**Interfaces:**
- Produces, for Tasks 3 and 6, rulings recorded in the ledger: **R-A** (does `schtasks /run` work from the S4U service, or does it need the security-descriptor grant?), **R-B** (`quser`, or the `tasklist` fallback?), **R-C** (`conhost.exe --headless`, or `-WindowStyle Hidden`?), **R-D** (the URI delay in ms), **R-E** (`parseBackgrounded` as is, or loosened?).

- [ ] **Step 1: Make the worktree and move the plan in**

```bash
cd /Users/owner/Claude/personal/Spotify_car_thing
git fetch origin
git worktree add -b feat/new-session-nucbox ../Spotify_car_thing-nucbox origin/main
mv docs/superpowers/plans/2026-11-07-new-session-nucbox.md ../Spotify_car_thing-nucbox/docs/superpowers/plans/
```

Expected: the worktree exists and `git -C ../Spotify_car_thing-nucbox status` shows only the plan as untracked.

- [ ] **Step 2: Ask D1, D2 and D3 with one AskUserQuestion** (wording from "Owner decisions" above, recommendation first). Record the answers in the ledger. Without D1 nothing below runs. Without D3, steps 5 and 6 use a project the owner names and trusts themselves.

- [ ] **Step 3: Apply D2 and D3 as approved.** D2: `& "$env:USERPROFILE\.local\bin\claude.exe" update`, then `--version`. D3: copy `C:\Users\owner\.claude.json` to `C:\Users\owner\.claude.json.before-trust-claude-server`, then set `hasTrustDialogAccepted = $true` on `projects."c:/Users/owner/Claude - server)"` (adding it if missing) and on every existing child entry under it. Write it back with UTF-8 and no BOM (`[IO.File]::WriteAllText`). Leave the `d:/personal/...` entries alone unless the owner said otherwise.

- [ ] **Step 4: Deploy main's service to the NucBox**

```bash
Z=<sdd workspace>/m2-main.zip
git -C ../Spotify_car_thing-nucbox archive --format=zip -o "$Z" HEAD nucbox mac-service
scp "$Z" nucbox:car-thing-panel-m2.zip
```

Then on the NucBox, base64-encoded: back up `C:\Users\owner\car-thing-panel` to `car-thing-panel.before-m2`, then `Expand-Archive -Force car-thing-panel-m2.zip C:\Users\owner\car-thing-panel`. Then, from `C:\Users\owner\car-thing-panel\nucbox`: `powershell -ExecutionPolicy Bypass -File install.ps1 -HomeAssistant 192.168.1.27 -ClaudeSessions`. Then `node C:\ProgramData\car-thing-panel\sessions\scripts\install-hooks.js`.
Expected: install.ps1 prints `Installed. …Claude sessions on :8790…`. The sessions task is Running. `C:\ProgramData\car-thing-panel\sessions\src\new-session.js` exists. The service log shows the panel's `client hello`. The Car Thing's machine screen no longer shows NUCBOX as `NOT SET UP YET`.

- [ ] **Step 5: V1 to V5, sessions through the real service**

Write a throwaway ws client in the SDD workspace that sends one request and prints the answer. Frames follow `protocol/claude-protocol.md`: `bridge.hello` first, then `{"type":"request",…}`. Build the URL and token as `serviceWsUrl` in `panel/src/ws.js` does, from `~/.config/claude-panel/nucbox-sessions.json`. Use a project from `claude.projects.recent` that D3 made trusted. Until Task 2 lands, that list says `trusted: false` for every NucBox project: that's the path bug Task 2 fixes. The service doesn't refuse a start on it (only the panel does), so the client can still start one.

| Check | How | Passes when |
|---|---|---|
| V1 start | `claude.session.start` `{path, prompt: "Reply with just OK. Use no tools."}` | answers `{shortId}`; within 60 s `claude agents --json` on the NucBox lists it `kind: background` with a `pid`, and it goes idle; the transcript's last assistant text is `OK` |
| V2 odd prompt | the same with prompt `-x "quoted" \back\slash\ 100% é ✓ Reply with just OK.` | the transcript's first user message equals that string exactly |
| V3 asks | prompt `Use AskUserQuestion to ask me red or blue, then reply with my pick.` | the question shows on the Car Thing tagged NucBox; the owner's answer is the reply |
| V4 restart | with V3's session idle: `Stop-ScheduledTask` then `Start-ScheduledTask` on `Car Thing panel - Claude sessions` | after 10 s `claude agents --json` still lists the job |
| V5 STOP | the STOP row on the Car Thing, pressed twice | the job is gone from `claude agents --json` |

If V1 answers `start-unconfirmed` with the job actually running, capture the raw stdout bytes (`Format-Hex`) and loosen `parseBackgrounded` in Task 2 to match: that's **R-E**. If V1 fails any other way, or V4 kills the session: **C6**, stop and bring it to the owner.

- [ ] **Step 6: V6 and V7, the helper's building blocks, with two temporary tasks**

In `C:\ProgramData\car-thing-panel\probe-m2\`:
- `interactive.ps1` writes `whoami`, its own `SessionId` and the time to `interactive.out`. With `-Open <folder> -Session <uuid>`, it also starts `Code.exe` on the folder, sleeps `-DelayMs`, then starts `vscode://anthropic.claude-code/open?session=<uuid>&prompt=Continue%20where%20you%20left%20off.`.
- `s4u.ps1` runs `quser` and then `schtasks /run /tn "Car Thing panel - probe (delete me)"`. It writes both outputs and both exit codes to `s4u.out`.

Register `Car Thing panel - probe (delete me)` (principal owner, LogonType Interactive, RunLevel Limited, no trigger). Its action is `conhost.exe --headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <interactive.ps1>`. Register `Car Thing panel - probe S4U (delete me)` (owner, S4U, Limited, no trigger) running `s4u.ps1`. Start the S4U one from ssh.

| Check | Passes when | If not |
|---|---|---|
| V6a quser from S4U | `s4u.out` has owner's row as `Active` or `Disc`, exit 0 | **R-B**: use `tasklist /fo csv /nh /fi "IMAGENAME eq explorer.exe" /fi "USERNAME eq <user>"`; a row with a session number other than 0 means a desktop |
| V6b schtasks from S4U | exit 0, and `interactive.out` appears within 10 s with the owner's session id (1 on 2026-11-07, not 0) | **R-A**: grant owner read and run on the task (snippet below), run again; if it still fails, stop and ask |
| V6c no window | the owner saw nothing flash on the NucBox's screen | **R-C**: use `powershell.exe -WindowStyle Hidden …` instead, and tell the owner a brief flash remains |
| V7 open | start a session (V1 style), wait for idle, `claude stop <shortId>`, then run the probe with `-Open`/`-Session` and `-DelayMs 1500`. Repeat with VS Code closed first | the owner sees that folder's window with the session's tab, its history, and the input pre-filled with the continue line, in both cases | **R-D**: raise the delay (3000, then 5000) until the cold case lands in the right window; record the value |

The R-A grant, which Task 6 repeats in `install.ps1` if needed:

```powershell
$svc = New-Object -ComObject Schedule.Service; $svc.Connect()
$task = $svc.GetFolder('\').GetTask($name)
$sid = (New-Object Security.Principal.NTAccount($User)).Translate([Security.Principal.SecurityIdentifier]).Value
$task.SetSecurityDescriptor($task.GetSecurityDescriptor(4) + "(A;;GRGX;;;$sid)", 0)
```

- [ ] **Step 7: Clean up the probes.** Unregister both probe tasks and remove `probe-m2`. Check that `Get-ScheduledTask -TaskName '*delete me*'` returns nothing.

- [ ] **Step 8: Record and commit.** In the spec, add a subsection under "Verify first" with V1 to V7, what was run, what was seen, and the D1 to D3 answers. Mark item 3's NucBox half and item 6 with their status. Put R-A to R-E in the ledger.

```bash
git add docs/superpowers/plans/2026-11-07-new-session-nucbox.md docs/superpowers/specs/2026-11-07-new-session-design.md
git commit -m "docs(new-session): NucBox verify-first results and the milestone 2 plan"
```

### Task 2: The trust check reads Windows paths

On the NucBox, transcripts give `cwd` as `c:\Users\owner\…` while `~/.claude.json` keys read `c:/Users/owner/…`, and `os.homedir()` is `C:\Users\owner`. Today no key ever matches, so every NucBox project reads untrusted.

**Files:**
- Modify: `mac-service/src/new-session.js` (`recentProjects`, `isTrusted`, `projectEntry`; and `parseBackgrounded` only if R-E says so)
- Test: `mac-service/test/new-session.test.js`

**Interfaces:**
- Produces: `recentProjects({ projectsDir, exists, limit, isOwn, readClaudeConfig, home, platform = process.platform })`. The return shape doesn't change.

- [ ] **Step 1: Write the failing tests.** These are fixtures with a Windows `cwd` (written as JSON in a temp `projectsDir`), `exists: () => true`, `platform: 'win32'` and `home: 'C:\\Users\\owner'`:

```js
test('win32: a project trusted under its own forward-slash key is trusted', ...)
  // cwd 'c:\\Users\\owner\\Claude - server)\\personal\\pfact'
  // projects { 'c:/Users/owner/Claude - server)/personal/pfact': { hasTrustDialogAccepted: true } }
  // → [{ name: 'pfact', path: 'c:\\Users\\owner\\Claude - server)\\personal\\pfact', trusted: true, … }]
test('win32: a trusted parent folder trusts the project', ...)        // key 'c:/Users/owner/Claude - server)'
test('win32: the project\'s own false beats a trusted parent', ...)    // parent true, own false → false
test('win32: drive letter and case do not matter', ...)               // key 'C:/USERS/owner/claude - server)/personal/pfact' → true
test('win32: home is never consulted, whatever its case', ...)        // key 'c:/Users/owner' true only → false
test('win32: a relative cwd is not a project', ...)                   // cwd 'personal\\pfact' → not listed
```

- [ ] **Step 2: Run them.** `cd mac-service && node --test test/new-session.test.js`. Expected: the win32 trust tests FAIL (`trusted: false`). The relative-cwd one may already pass.

- [ ] **Step 3: Implement.** Pick `const P = platform === 'win32' ? path.win32 : path.posix` and use it for `isAbsolute`, `basename` and `dirname` on project paths. Leave `path` on local file reads. On win32, compare folder, keys and home through one `trustKey(p)`: backslashes become `/`, the result is lower-cased, and trailing slashes are dropped. Build a lookup from normalized key to entry once per call. Posix behaviour doesn't change.

- [ ] **Step 4: Run the suite.** `cd mac-service && npm test`. Expected: all pass, the existing Mac trust tests included.

- [ ] **Step 5: Commit.** `git commit -m "fix(new-session): the trust check reads the NucBox's Windows paths"`

### Task 3: The desktop opener (service, Windows)

**Files:**
- Create: `mac-service/src/desktop-open.js`
- Test: `mac-service/test/desktop-open.test.js`

**Interfaces:**
- Consumes: `CONTINUE_PROMPT` from `mac-service/src/handoff.js`.
- Produces:
  - `OPEN_TASK = 'Car Thing panel - Open in VS Code'`
  - `REQUEST_MAX_AGE_MS = 60_000` (the helper's limit; Task 6 uses the same number)
  - `parseQuser(text: string, user: string) -> boolean`
  - `createDesktopOpener({ run = execFile, dir = <homedir>/.config/claude-panel/open-in-vscode, user = os.userInfo().username, pollMs = 200, timeoutMs = 15_000, now = Date.now }) -> { check(): Promise<null | 'not-set-up' | 'no-desktop'>, open(cwd, sessionId, prompt?): Promise<{ focused: true, app: 'Code', exact: false } | { focused: false, reason: string }> }`
  - The request file `request.json` holds `{ nonce: <32 hex>, sessionId, cwd, continue: boolean, createdTs: ms }`. The result file `result.json` holds `{ nonce, ok: true }` or `{ nonce, ok: false, reason }`. Both are UTF-8 with no BOM.

- [ ] **Step 1: Write the failing tests** (a fake `run` that records calls; a temp `dir`; a fake helper that writes `result.json` when `schtasks /run` is called):

```js
test('parseQuser: an Active row of the user is a desktop', ...)          // ' owner  rdp-tcp#0  1  Active  3:48  10/15/2026 9:04 AM'
test('parseQuser: a disconnected row (no session name) is a desktop', ...) // ' owner  2  Disc  1+02:00  10/15/2026 9:04 AM'
test('parseQuser: the > marker and case do not matter', ...)             // '>OWNER  console  1  Active …', user 'owner'
test('parseQuser: another user only, or "No User exists", is not', ...)
test('check: no helper task is not-set-up', ...)                         // run('schtasks', ['/query','/tn',OPEN_TASK]) errors
test('check: quser failing or not listing the user is no-desktop', ...)
test('check: helper present and user Disc is null', ...)
test('open: writes the request, runs the task, resolves on its result', ...)
  // request.json parsed has continue:false, sessionId, cwd, nonce /^[0-9a-f]{32}$/, createdTs = now()
  // run called with ('schtasks', ['/run','/tn',OPEN_TASK]); no request.json.tmp left
  // → { focused: true, app: 'Code', exact: false }
test('open: the continue prompt sets continue:true', ...)                // open(cwd, id, CONTINUE_PROMPT)
test('open: a result with another nonce is ignored, then helper-timeout', ...) // request.json removed after
test('open: the helper\'s refusal is the reason', ...)                   // { ok:false, reason:'no-folder' } → reason 'no-folder'
test('open: schtasks failing is helper-not-run, request removed', ...)
test('open: a non-UUID session id is bad-request and runs nothing', ...)
test('open: an old result.json is removed before the request is written', ...)
```

- [ ] **Step 2: Run them.** `cd mac-service && node --test test/desktop-open.test.js`. Expected: FAIL (the module doesn't exist).

- [ ] **Step 3: Implement `desktop-open.js`.** `parseQuser`: skip the header line. The user is the first token with any leading `>` stripped, compared case-insensitively. The row counts if any later token is `Active` or `Disc`. `check()`: `schtasks /query /tn OPEN_TASK` (an error means `not-set-up`), then `quser` (an error or a false parse means `no-desktop`). Each call has a 10 s timeout, and `check()` never rejects. `open()`:
  1. Validate the UUID and that `cwd` is absolute (`path.win32`).
  2. Make `dir`, remove any `result.json`, and write `request.json` through `.tmp` plus a rename.
  3. `schtasks /run`.
  4. Poll `result.json` every `pollMs` for the same nonce until `timeoutMs`.
  5. On timeout or a run error, remove `request.json` if it's still there.

  `open()` never rejects. If R-B chose `tasklist`, `check()` uses that instead, and `parseQuser` becomes `parseTasklist(csv) -> boolean` (a row whose session number isn't 0).

- [ ] **Step 4: Run the suite.** `cd mac-service && npm test`. Expected: all pass.

- [ ] **Step 5: Commit.** `git commit -m "feat(service): hand Open in VS Code to a helper in the NucBox's desktop session"`

### Task 4: The hand-off checks for a desktop first; Windows wiring

**Files:**
- Modify: `mac-service/src/handoff.js` (`createHandoff`), `mac-service/src/index.js` (the `handoff` and `focus` construction, near the `// Moving a background session into VS Code` comment, and `claude.session.focus`), `mac-service/src/focus.js` (the `openVsCode` guard and the win32 `focusSession` branch)
- Test: `mac-service/test/handoff.test.js`, `mac-service/test/focus.test.js`

**Interfaces:**
- Consumes: `createDesktopOpener` (Task 3).
- Produces:
  - `createHandoff({ store, focus, isWindowless, stopAgent, onOpened, canOpen = async () => null })`. `canOpen()` resolves to `null` or a reason. A rejection counts as `'not-set-up'`. New failure reasons from `request` and `now`: `'no-desktop'` and `'not-set-up'`. In both, nothing has been stopped.
  - `createFocus({ …, desktopOpener = null })`. On win32, `focusSession(id, { host, cwd, kind })` checks the desktop and opens through `desktopOpener` when `kind === 'interactive'`. Any other kind keeps the old refusal (`"can't raise windows on the NucBox"`), and so does no opener.
  - `claude.session.focus` in `index.js` passes the store's `kind` along.

- [ ] **Step 1: Write the failing tests** (in the style of `handoff.test.js`, with a fake store and a fake `stopAgent` that counts calls):

```js
test('canOpen refusing: an idle windowless session is not stopped', ...)  // request → {result:'failed', reason:'no-desktop'}, stops 0
test('canOpen refusing: a working one is not waited on', ...)              // request → failed 'no-desktop'; raw.handoff stays null
test('canOpen refusing at turn end: the wait ends, nothing stopped', ...)  // waiting, canOpen flips to 'no-desktop', onHook('Stop') → stops 0, handoff null
test('STOP NOW: canOpen refusing is not-set-up, nothing stopped', ...)    // now → failed 'not-set-up'
test('a canOpen that rejects counts as not-set-up', ...)
test('STOP does not ask canOpen', ...)                                     // stop → 'stopped' with canOpen refusing
// focus.test.js
test('openInVsCode on win32 opens nothing', ...)                           // createFocus({platform:'win32', run}) → {focused:false, reason:"can't raise windows on the NucBox"}, run not called
test('win32: a VS Code session is raised through the helper', ...)          // desktopOpener fake: check→null, open→{focused:true,…}; focusSession(id,{host:'vscode',cwd,kind:'interactive'}) → open(cwd,id) called, focused true
test('win32: a background session is never raised, whatever its host', ...) // kind 'background', host 'vscode' → refusal, open not called
test('win32: an unknown kind is not raised', ...)                           // kind undefined → refusal, open not called
test('win32: no desktop is no-desktop, nothing opened', ...)                // check→'no-desktop' → {focused:false, reason:'no-desktop'}
```

- [ ] **Step 2: Run them.** `cd mac-service && node --test test/handoff.test.js test/focus.test.js`. Expected: FAIL.

- [ ] **Step 3: Implement.** In `handoff.js`, ask `canOpen()` in `request()` after the `jobId` check, before both the idle move and setting the wait. Ask it again in `move()` just before `stopAgent`, which covers STOP NOW and the Stop-hook path. Log each refusal (`HO`). In `focus.js`, `openVsCode` returns the guard result on `win32` before running anything. In `index.js`:

```js
const opener = ON_WINDOWS && !MOCK_SESSIONS ? createDesktopOpener() : null; // made before createFocus
// createFocus({ desktopOpener: opener })
// handoff's focus: opener ? { ...focus, openInVsCode: opener.open } : focus
// canOpen: opener ? opener.check : undefined
// isWindowless: (id) => !MOCK_SESSIONS && isWindowlessBackground(store.raw(id))
// claude.session.focus: focusSession(id, { host: raw.host, cwd: raw.cwd, kind: raw.kind })
```

In `focus.js`, the win32 branch of `focusSession` comes before the `host === 'vscode'` line and never falls through to it.

Rewrite the comment above `createHandoff` in `index.js`, which still says only the Mac's sessions are stopped.

- [ ] **Step 4: Run the suite.** `cd mac-service && npm test`. Expected: all pass, the existing hand-off tests unchanged.

- [ ] **Step 5: Commit.** `git commit -m "feat(handoff): check the NucBox desktop before stopping, and wire the helper in"`

### Task 5: Panel: NucBox sessions move to VS Code, words per machine

**Files:**
- Modify: `panel/src/session-actions.js` (`movesToVsCode`, `requestToast`, header comment), `panel/src/screens/session-detail.js` (`openRow`), `panel/src/screens/new-session.js` (`TRUST_FIRST` users: `projectRows`, `projectPress`, `errorLabel`), `panel/src/main.js` (callers pass the host)
- Test: `panel/test/session-actions.test.js`, `panel/test/new-session.test.js`, and `panel/test/screens.test.js` for the row label

**Interfaces:**
- Produces:
  - `movesToVsCode(d)`: true for any `d.background`, on either machine.
  - `trustFirst(host) -> string`: `'TRUST IT ON THE NUCBOX FIRST'` for `'nucbox'`, else the Mac's text.
  - `projectRows(projects, nowMs, offsetMin, host)`, `projectPress(project, host)` and `errorLabel(err, host)` gain `host` as their last parameter. A missing host reads as the Mac.

- [ ] **Step 1: Write the failing tests.**

```js
test('a NucBox background session moves to VS Code', ...)       // movesToVsCode({background:true, machine:'NucBox'}) === true
test('its open row sends the hand-off', ...)                      // sessionRowPlan(d,'open-mac',…).method === 'claude.session.handoff'
test('no-desktop says log in on the NucBox first', ...)           // requestToast('claude.session.handoff', {result:'failed', reason:'no-desktop'}) === 'LOG IN ON THE NUCBOX FIRST'; same for 'claude.session.handoff.now'
test('not-set-up says not set up yet', ...)                       // === 'NOT SET UP YET'
test('the NucBox open row says where it moves', ...)              // openRow sub === 'Moves it to a tab on the NucBox'
test('a NucBox VS Code session is brought forward on the NucBox', ...) // d {background:false, machine:'NucBox'}: sessionRowPlan(d,'open-mac',…) → focus true, toast 'OPENING ON THE NUCBOX'; openRow sub 'Brings this session forward on the NucBox'
test('an untrusted NucBox project says trust it on the NucBox', ...) // projectRows([...{trusted:false}], now, 0, 'nucbox')[0].sub; projectPress(p,'nucbox').toast; errorLabel('not-trusted','nucbox')
test('the Mac keeps its words', ...)                              // host 'mac' and undefined → 'TRUST IT ON THE MAC FIRST'
// Found live in Task 1 (V5, 2026-11-07), both machines: after STOP worked, the view kept its STOP row and later presses said COULDN'T STOP IT
test('an ended session shows no STOP or STOP NOW row', ...)       // d {background:true, ended:true}: rendered rows have no 'stop-session' / 'handoff-now' action
test('STOP on a session already gone says already stopped', ...) // requestToast('claude.session.stop', {result:'failed', reason:'unknown-session'}) === 'ALREADY STOPPED'
```

- [ ] **Step 2: Run them.** `cd panel && npm test`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement.** `requestToast` maps the reasons `no-desktop` and `not-set-up` (for the two hand-off methods) before its generic failure text. `openRow`'s sub-labels read `Moves it to a tab on the NucBox` and `Brings this session forward on the NucBox` when `d.machine`. The raise toast reads `OPENING ON THE NUCBOX` when `d.machine`. In `macRows` (`session-detail.js`), a session with `d.ended` gets neither STOP nor STOP NOW. `requestToast` maps a stop that failed with `unknown-session` to `ALREADY STOPPED`. In `main.js`, the project screen and the start-error toast pass the view's `host`. Update the header comment of `session-actions.js`, which says moving comes later.

- [ ] **Step 4: Run the suite.** `cd panel && npm test`. Expected: all pass.

- [ ] **Step 5: Commit.** `git commit -m "feat(panel): NucBox background sessions open in VS Code there"`

### Task 6: The helper script and its task

**Files:**
- Create: `nucbox/open-in-vscode.ps1`, `nucbox/test/open-helper.test.js`
- Modify: `nucbox/install.ps1` (inside the `-ClaudeSessions` block), `nucbox/uninstall.ps1` (the task name list)

**Interfaces:**
- Consumes: `OPEN_TASK` and `REQUEST_MAX_AGE_MS` (Task 3), `CONTINUE_PROMPT`, and the R-A, R-C and R-D rulings (Task 1).
- Produces: `open-in-vscode.ps1 [-Dir <folder>] [-DelayMs <R-D>] [-DryRun]`, which handles one request and writes one result per run.

- [ ] **Step 1: Write the failing consistency test** (`nucbox/test/open-helper.test.js`, run on the Mac; it reads the files as text):

```js
test('install.ps1 and uninstall.ps1 name the helper task as the service does', ...) // both contain `'${OPEN_TASK}'`
test('the helper adds the continue prompt the service means', ...)  // ps1 contains encodeURIComponent(CONTINUE_PROMPT)
test('the helper refuses requests older than the service allows', ...) // ps1 contains String(REQUEST_MAX_AGE_MS)
test('the helper reads where the service writes', ...)             // ps1 contains '.config\\claude-panel\\open-in-vscode'
test('no firewall rule for the helper', ...)                        // no Allow-Inbound line in install.ps1 mentions the helper
```

- [ ] **Step 2: Run it.** `node --test nucbox/test/open-helper.test.js`. Expected: FAIL (no files).

- [ ] **Step 3: Write `open-in-vscode.ps1`** (PowerShell 5.1: no `??`, no ternary). The default `-Dir` is `$env:USERPROFILE\.config\claude-panel\open-in-vscode`. In order:
  1. If there's no `request.json`, exit 0.
  2. Read it with `-Raw -Encoding UTF8`, then delete it at once.
  3. Validate:
     - `nonce` matches `^[0-9a-f]{32}$`;
     - `sessionId` matches the UUID format;
     - `continue` is a boolean;
     - `createdTs` is within `60000` ms of now, else `stale`;
     - `cwd` is rooted and isn't a drive root, else `bad-request`. Trim its trailing `\`;
     - `Test-Path -LiteralPath $cwd -PathType Container`, else `no-folder`.
  4. Find `Code.exe` at `$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe`; if it's missing, `code-failed`.
  5. With `-DryRun`, write `{nonce, ok:true, dryRun:true, folderArg, uri}` and stop.
  6. Otherwise:
     - run `Start-Process -FilePath $code -ArgumentList ('"' + $cwd + '"')`;
     - sleep `-DelayMs`;
     - run `Start-Process $uri`, where `$uri` is `vscode://anthropic.claude-code/open?session=<id>`, plus `&prompt=Continue%20where%20you%20left%20off.` when `continue`;
     - an exception means `code-failed`.
  7. Write the result through `result.json.tmp` and `Move-Item -Force`, using `[IO.File]::WriteAllText` with UTF-8 and no BOM.

- [ ] **Step 4: Register the task in `install.ps1`.** Inside `if ($ClaudeSessions)`: copy `open-in-vscode.ps1` to `$root`. Register `Car Thing panel - Open in VS Code` with:
  - no trigger;
  - principal `$User`, LogonType Interactive, RunLevel Limited;
  - settings: ExecutionTimeLimit 2 minutes, MultipleInstances Queue, AllowStartIfOnBatteries, DontStopIfGoingOnBatteries;
  - action: `conhost.exe --headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "<root>\open-in-vscode.ps1" -DelayMs <R-D>`, or the R-C fallback.

  Apply the R-A grant if Task 1 needed it. Don't start it, and add no firewall rule. Add the name to `uninstall.ps1`'s list, and say both in the header comments.

- [ ] **Step 5: Run the consistency test and the root suite.** `node --test nucbox/test/open-helper.test.js`, then `npm test` at the root. Expected: all pass.

- [ ] **Step 6: Dry runs on the NucBox** (covered by D1). Copy the script to a temp folder there and run it over ssh with `-DryRun -Dir <temp>`, once per hand-written `request.json`:

| Request | Result expected |
|---|---|
| valid, `cwd` `c:\Users\owner\Claude - server)\personal\pfact` | `ok:true`, `folderArg` `"c:\Users\owner\Claude - server)\personal\pfact"`, `uri` without `prompt` |
| valid with `continue:true` | `uri` ends `&prompt=Continue%20where%20you%20left%20off.` |
| a made folder `…\Temp\m2 & it's (x)\` (trailing `\`) | `ok:true`, `folderArg` `"…\Temp\m2 & it's (x)"` |
| `sessionId` `../../x` | `ok:false`, `bad-request` |
| `createdTs` 2 minutes old | `ok:false`, `stale` |
| `cwd` that doesn't exist | `ok:false`, `no-folder` |

After each run, `request.json` must be gone. Then remove the temp folder and the made folder.

- [ ] **Step 7: Commit.** `git commit -m "feat(nucbox): the Open in VS Code helper task, on demand only"`

### Task 7: Protocol and spec

**Files:**
- Modify: `protocol/claude-protocol.md` (the `claude.session.handoff` and `.now` rows), `docs/superpowers/specs/2026-11-07-new-session-design.md` (an as-built note in the NucBox section)

- [ ] **Step 1: Protocol.** In the hand-off rows, add the reasons `no-desktop` (the NucBox has no logged-on desktop session; nothing stopped) and `not-set-up` (no helper task; nothing stopped). Say that on the NucBox the move goes through the helper task.
- [ ] **Step 2: Spec.** Add an "As built (milestone 2)" note under "Open in VS Code for background sessions (NucBox)": the request and result files and their folder, the nonce, the 60 s limit, `Code.exe` directly, `conhost --headless` (or the R-C fallback), the R-A grant if used, C1 and C5. Also record the owner's "same exact experiences" (2026-11-07): NucBox VS Code sessions are brought forward through the helper, and only `kind: interactive` ones. Keep `**Status:** Approved`: Task 8 decides.
- [ ] **Step 3: Commit.** `git commit -m "docs(new-session): the NucBox hand-off as built"`

Then use superpowers:finishing-a-development-branch. The owner chooses PR or merge. Task 8 runs once what they chose has landed on main.

### Task 8: Deploy and live checks (after the merge)

Needs the owner at the Car Thing, with Remote Desktop on the NucBox.

- [ ] **Step 1: The Mac.** In `/Users/owner/Claude/personal/Spotify_car_thing`: `git fetch origin && git merge --ff-only origin/main`, then `launchctl kickstart -k gui/$(id -u)/com.claudepanel.service`. Expected: a new pid, and the panel's `client hello` in `mac-service/logs/daemon.log`.
- [ ] **Step 2: The NucBox** (D1 covers it). Repeat Task 1 step 4 from main. Expected: `Car Thing panel - Open in VS Code` exists (`Get-ScheduledTask`), it's Ready (not Running), and it has no trigger.
  - Confirm it again after its first run (L3): it is Ready, it still has no trigger, and it went back to Ready within seconds of the run (`Get-ScheduledTask` and `Get-ScheduledTaskInfo`: `State`, `Triggers`, `LastRunTime`, `LastTaskResult`).
- [ ] **Step 3: The Car Thing.** `just swu`, then `just ota 192.168.1.55` (it goes to the other slot). Check the new build over DevTools (:9223).
- [ ] **Step 4: Live checks with the owner.** Record each in the spec.

| | Owner does | Passes when |
|---|---|---|
| L1 | hold top → NUCBOX → a project → speak → START | the tile appears tagged NucBox; nothing appeared on the NucBox's screen |
| L2 | answers the session's question on the Car Thing | the session goes on with the answer |
| L3 | Open in VS Code on the idle session | VS Code on the NucBox shows that folder with the session's tab and its history; the card is cleared |
| L4 | Open while it works | the row reads `OPENS IN VS CODE WHEN DONE`, and it moves when the turn ends |
| L5 | STOP NOW while waiting | it opens with `Continue where you left off.` in the input box, unsent |
| L6 | STOP twice on another NucBox session | `STOPPED`, and the job is gone from `claude agents --json` |
| L7 | Open in VS Code on one of the NucBox's ordinary VS Code sessions, then SWITCH on that session's card | its tab comes forward on the NucBox both times, and SWITCH toasts `OPENING ON THE NUCBOX`; nothing is stopped |
| L8 | SWITCH on a NucBox background session's card | nothing opens; the agent keeps running |
| L9 | disconnects Remote Desktop (no log-off), presses Open on an idle NucBox background session, then reconnects | VS Code is waiting there with the session's tab; the press did not answer `open-failed` or time out |
| L10 | starts `claude` in a terminal on the NucBox, then presses "Open in VS Code" on it, and opens its view with "Open automatically" on | no VS Code tab opens for it either way; the service log on the NucBox (`C:\ProgramData\car-thing-panel\sessions\logs\daemon.log`) shows `FC not raising <id> on the NucBox: entrypoint=…` (or `no registry entry`) |
| L11 | the first press after the deploy (L3's) | it does not answer `NOT SET UP YET`: `schtasks /query` works from the service's account (a `DO not-set-up: …` line in the log says why if it does) |

**L9 is not optional.** `check()` accepts `Disc`, and the spec promises that VS Code is waiting there on reconnect. If `schtasks /run` doesn't start an Interactive task in a disconnected session, every move in that state stops the agent and then times out. L9 must pass before the spec's status is set to Implemented. If it fails, change `parseQuser` (`mac-service/src/desktop-open.js`) to count only `Active` until it is solved, so a disconnected session answers `no-desktop` and nothing is stopped.

- [ ] **Step 5: Close out.** If L1 to L11 pass (L9 included) and the Mac's remaining live checks (milestone 1's Task 11 list) are done too, set the spec to `**Status:** Implemented`. That ticks its TickTick task. Otherwise leave it Approved and list what's left in the spec. Commit the spec on main (doc-only), and update the project memory.
