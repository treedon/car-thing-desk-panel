# Agent digest on the Car Thing — Design

Date: 2026-11-06
Status: draft for review

## Intent

The owner: "the nucbox windows machine hosts LMstudio and a local ai model. i'd like to use this model for summarizing what has been done with my claude code agents on the mac. displaying those summaries in a digestable attractive manner on the carthing. im interested in other potential functionality but this is the first i'd like to explore."

The panel already shows *what is happening* in each session: its state, its current tool and its last 40 messages. It doesn't say *what got done*. This design adds a short summary for each session, written by the NucBox's model from facts the Mac service extracts. The summary appears on a digest card that comes first on the sessions screen and opens a new Digest list, at the top of each session view, and as one line on the resting clock.

**Why the NucBox, not Claude.** Cost is the main reason. Summarizing with Claude would spend the owner's plan usage, which the owner already watches on the Usage screen. A `claude -p` summarizer would also create phantom sessions, which `mac-service/src/own-sessions.js` exists to hide. A NucBox call costs nothing per request. Privacy is only partly a reason. The conversations already went to Anthropic while they ran, and a local summarizer doesn't change that. What it avoids is sending a second copy of prompts, paths and commands anywhere new: the text stays on the LAN. It also uses hardware the owner already runs.

## Goals

- After a turn ends, the digest shows a short, faithful summary of what that session did, within a few minutes rather than seconds.
- A **digest card**, first on the sessions screen, shows the fleet line and the newest three sessions. Pressing it opens the **Digest list**, which lists every session with a finished turn in the window (proposal: the last 24 hours), including ended sessions. Each entry shows the state, a headline, up to three bullets, and a row of hard facts: files, commits, tests and subagents.
- **It is useful with no model at all.** The facts alone make a card; the model only turns facts into readable sentences.
- The summary also appears at the top of the session view, and as one line on the ambient clock.
- The model is chosen by a measured method that the owner judges, not by name.

## Non-goals (for this version)

- Alerts, sounds or notifications of any kind. The digest is read when the owner looks, like the NucBox view.
- Any action from a summary: no approvals, no messages to sessions, no "fix it" buttons.
- A cloud fallback. When the NucBox is unavailable the digest is facts-only, never Claude.
- Separate subagent cards (see Open questions), cross-session search, history beyond the window, a model-written summary across sessions (the fleet line is plain counts), or summaries on the grid tiles (see Calls made by Claude).

## Anti-goals (would make it a failure even if it "works")

- A summary states something the transcript doesn't support: tests "passed" that never ran, a commit or file that doesn't exist, or a task "done" that was only attempted.
- The digest adds alert noise: motion, colour or toasts that look like the "needs you" alert, waking the screen, or moving the page by itself.
- Anything in the digest path slows a hook response, stalls a Claude session, delays a permission or question hold, or degrades an existing panel screen.
- A transcript secret reaches the NucBox, the Car Thing or a world-readable file, or the Car Thing receives an inference address or token.
- The digest loads, swaps or evicts NucBox models the owner didn't ask for.

## Existing environment

**The NucBox side was built in another session. It is merged into `main` (PR #14, `3b119fb`) and, per that session's commit message, installed and run on the NucBox. The Car Thing was reflashed with `main`'s panel.** That work owns the NucBox status view, its hardware sensors and reachability; this design depends on it and doesn't duplicate it. It has:
- **The relay.** `nucbox/lm-relay.js` (with `nucbox/test/lm-relay.test.js`) is a read-only relay on port 1235. It answers only `GET /api/v0/models`, with each loaded model's id, type and state. It sends `Access-Control-Allow-Origin: *` and has no auth. Its header says LM Studio's server "has no login, so it stays on localhost; this is all the LAN sees", and its test asserts that `POST /v1/chat/completions` is refused and never forwarded.
- **The installers.** `nucbox/install.ps1` and `uninstall.ps1` install the relay (a task at boot) and LibreHardwareMonitor (port 8085, at logon). The firewall rules are Private-profile, scoped to the local subnet (relay) or to Home Assistant's address (LibreHardwareMonitor).
- **Other commits:** `mac-service/src/ha-config.js` (`gpuMemoryTotal`, named temperatures), `panel/src/nucbox.js`, `device/scripts/provision.sh`, `package.json`, and a "The NucBox" section in `README.md`.
- **Checked from the Mac on 2026-11-06, after that commit (verified).** A LAN host answers `GET :1235/api/v0/models` with `{"data":[]}`, so no model was loaded at that moment. `POST /v1/chat/completions` to the relay gets 404. Port 1234 is closed from the Mac, so LM Studio is on localhost by design. The NucBox answers on two LAN addresses. Per the NucBox session both are wired ("Ethernet 4" and "Ethernet 5"), both DHCP and not confirmed reserved; everything there uses the first, `192.168.1.22`, and the owner has been advised to reserve it. The Mac is `192.168.1.41` on `en0`; whether that is reserved is unknown.
- **Hardware and model (from the NucBox session; I haven't re-measured them).** The GPU is an integrated Radeon 760M with a 6 GB VRAM carve-out. With `nemotron-3-nano-4b` loaded it used about 3 GB of VRAM and ran at about 20 tokens/s, with GPU core load 0 when idle and 60-97% while generating, and system RAM was about 83% used. The owner says they will likely use a different model, and later on 2026-11-06 they loaded `google/gemma-4-12b-qat`, type `vlm` (read from the relay; I have not seen its size on disk, its context length or its speed). That is above the 7B line, but a 12B model on a 6 GB carve-out with RAM already tight is the case most likely to be slow or to spill into shared memory (my inference, unmeasured). So hardware is known, but speed for this job is still to be measured, not assumed. Home Assistant sensors and the `ha.json` `nucbox` block are that work's to finish.
- **LM Studio's installed state (read from the NucBox by the NucBox session).** Version 0.4.20.0. `http-server-config.json` has `networkInterface` 127.0.0.1, `cors` false, `justInTimeModelLoading` true and no auth, token or apiKey keys, and an unauthenticated GET to `127.0.0.1:1234/api/v0/models` succeeds. So no authentication is configured. Whether 0.4.20.0 offers Require Authentication was not checked. The relay sends no `Authorization` header upstream, so enabling auth would make it answer 502 and the NucBox view show "LM Studio not reachable".
- **A pre-existing Windows firewall rule undoes port-scoped rules for Node (reported by the NucBox session; I haven't seen it).** An inbound rule named "Homebridge" allows the program `C:\Program Files\nodejs\node.exe` on any protocol, port, remote address and profile, Public included. So anything `node.exe` listens on is reachable from anywhere on the network, whatever port-scoped rules say. That affects the existing relay too (read-only, so low risk), and it means a "Mac only" firewall rule on a Node relay restricts nothing. LibreHardwareMonitor's port is served by http.sys, not Node, so its Home Assistant-only rule holds.
- **The gap this design must close:** that work exposes no inference, but the digest needs the Mac to call `POST /v1/chat/completions` on the NucBox. How it gets there is a decision for the owner. The NucBox session declined to build the inference path: it is outside what its owner asked for, and its approval to open NucBox ports and add startup tasks covered only the read-only relay and LibreHardwareMonitor (see Network and secrets). Until then nothing that needs the model can be tested from the Mac. Milestone 1 doesn't need it.

**LM Studio, from its docs (fetched 2026-11-06; nothing tried on the NucBox):**
- **Server settings** include Serve on Local Network, Just-in-Time (JIT) loading, and auto-unload and auto-evict for JIT models. The default port and bind address aren't stated; 1234 is the convention the relay assumes.
- **Require Authentication** makes clients send "a valid API token via the `Authorization` header". The docs don't state which endpoints it covers or which version added it. The NucBox session's "no login" comment turned out to mean that no authentication is configured (see below), not that the option is missing. Whether the installed 0.4.20.0 offers it is unchecked.
- **Structured output** is documented for the OpenAI-compatible `POST /v1/chat/completions` with `response_format: {type: "json_schema", json_schema: {name, strict, schema}}`; the reply is a JSON string in `choices[0].message.content`. GGUF models use llama.cpp grammar sampling (MLX runs only on Apple silicon, so the Windows NucBox runs GGUF). Not every model supports it, "particularly models below 7B". The docs' example sends `"strict": "true"` as a string. Streaming with it isn't documented, and the native `/api/v1/chat` page doesn't mention it.
- **TTL and eviction.** JIT-loaded models have a 60-minute idle TTL. Auto-evict keeps one JIT model. Explicitly loaded models have no TTL and aren't auto-evicted.

**The Mac service** (`mac-service/`):
- **Hooks.** `scripts/install-hooks.js` installs http hooks for SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse, Stop and PermissionRequest; SubagentStop isn't installed. For every hook that isn't held, `src/http-server.js` runs `sources.onHookEvent()` *before* writing the response. Anything synchronous added there delays Claude Code, and PreToolUse fires on every tool call with a 5 s hook timeout.
- **Sessions.** `src/sessions/store.js` deletes a session the moment it ends. `claude.session.messages` finds the transcript through that record, so for an ended session it returns `[]`.
- **Transcripts.** `src/sessions/source-transcript.js` tails transcripts by byte offset, reading from the start on catch-up. `src/sessions/recent-messages.js` condenses the last 512 KB into `{role, text, ts}`. `src/sessions/subagents.js` reads `<transcript>/subagents/agent-<id>.meta.json` and the final report.
- **State.** `src/persist.js` writes `mac-service/.state/<name>.json` atomically, with the default file mode; `usage.json` is 0644 on this Mac, and `.state/` is git-ignored. `src/usage.js` is the pattern for a background job that persists a reading and pushes an event.
- **The hub.** `src/hub.js` drops events matching `SUPERSEDING = /^claude\.(sessions?|usage)\./` for a backed-up socket. Its comments say relays forward only `claude.`-prefixed methods.
- **`ha.json` is not Mac-only.** `device/scripts/provision.sh` puts its contents, HA token and `nucbox` block included, into `/opt/panel/panel-config.js` on the Car Thing. On `main` it copies the file whole; the NucBox branch's commit (`dfe5309`) passes it through `loadHaConfig` first, which still keeps the token.

**The panel** (`panel/src/`):
- **Code style.** ES5-style string-built screens (`render*(state) -> html`, `esc()`), with "no flex gap, no inset shorthand, no clamp()" per the `styles.css` header.
- **Tokens and fonts.** `--bg #0c0906`, `--panel #16110a`, `--panel-hi #211809`, `--rule #2a2114`, `--bone #efe7d6`, `--text-2 #c2b299`, `--text-3 #b7a68c`, `--muted #978971`, `--dim #8a7c66`, `--accent #e8825a`, `--ok #3fd0a4`, `--warn #ffb020`, `--done #8ae27a`, `--idle #453a2c`; Chakra Petch 500/700 and JetBrains Mono 400. The CSS rule: "Nothing is below 14px, and nothing you must read at a glance is below 19px."
- **Navigation.** All four presets are taken: 1 Tasks (the TickTick list, served by the NucBox), 2 Agents, 3 the queue, 4 Home → Audio. Preset 2 cycles `list → usage → nucbox → list` (`AGENTS_CYCLE` in `shell.js`), and those screens light the top bar's second dot (section 1); Back from usage or nucbox returns to the list. The ambient clock's whole surface is the mascot toggle.
- **Two session services.** `ws.js` links to the Mac's service and, when `PANEL_CONFIG.nucboxSessions` is set, to the NucBox's copy of the same `mac-service` code. `ws-mux.js` merges their session lists and queues (NucBox entries tagged `machine: 'NucBox'`; ids are not namespaced), sends a request about a session or an ask to the machine that owns it and anything else to the Mac, and passes the Mac's power, usage and daemon-status events from the Mac only (`PRIMARY_ONLY`). `onOpen` / `onClose`, the boot fetches and the offline banner follow the Mac's link.
- **Alerts.** `surface()` in `main.js` moves the page only from ambient, to the queue. Elsewhere the pulsing `.edge` border and the topbar count carry the alert; otherwise "no page drifts on its own timer".
- **Rendering.** The DOM changes only when the markup does, and a 15 s timer re-renders ambient, list and queue. The NucBox view polls `<lmstudio>/api/v0/models` from the panel itself, with a 3 s timeout.

**The data (measured 2026-11-06).** There are 192 top-level transcripts in 19 projects. The 15 changed in the last 24 hours total 123.8 MB but hold about 0.88 MB of prompts and assistant text; the rest is tool output, attachments and bookkeeping. I surveyed only the record shapes of those 15, read-only, without reading out any content. Findings:
- **Prompts.** Typed prompts are `user` records with `origin.kind: "human"` (392). Background-task notices are `user` records with `origin.kind: "task-notification"` and no `isMeta` (43). `recent-messages.js` treats those notices as typed prompts; the extractor must not.
- **Turn ends.** Each Stop leaves a `system` record with `subtype: "stop_hook_summary"` (561).
- **Edits.** `Edit` input is `{file_path, old_string, new_string, replace_all}`. Its result's `structuredPatch` hunks have `lines` starting with ` `, `+` or `-`. `Write` input is `{file_path, content}`, and its result `type` is `create` or `update`. **No `MultiEdit` or `NotebookEdit` calls appeared.**
- **Shell commands.** `Bash` input is `{command, description, timeout?, run_in_background?}`. The result has `stdout`, `stderr`, `interrupted` and sometimes `gitOperation`, but **no exit code**. `is_error` was true on 38 of 1,756 results.
- **Commits.** 72 commands matched `git … commit`; **none of the 70 with output printed git's usual `[branch sha] subject` line**. `gitOperation.commit {sha, kind, branch}` appeared once, `.pr {number, url?, action}` 25 times, and `.push {branch}` 5 times. `pr-link` records (`prNumber`, `prUrl`, `prRepository`) repeat many times per PR.
- **Tests.** Of 49 test-runner commands, one had `is_error: true`, and fewer than 30 printed a pass/fail count in a recognizable form.
- **Subagents.** They are spawned by the tool named `Agent` (`{description, subagent_type, model, prompt}`). All 116 results say `status: "async_launched"`, so completion comes from the subagent's meta (`finished`).
- **Line counts.** `cost-state` records carry `totalLinesAdded` and `totalLinesRemoved`; I didn't check what they total.

## Decided approach

### Data flow

```
 Mac                                                      NucBox (LAN)
 +---------------------------------------------------+    +-------------------------------------+
 | Claude Code sessions (VS Code, terminal)           |    | inference relay :1236 (proposed)    |
 |   ~/.claude/projects/<p>/<id>.jsonl (+ subagents/) |    |   POST /v1/chat/completions only    |
 |   hooks: Stop, SessionEnd --POST /hook--+          |    |   token + Mac-only address check    |
 |                                         v          |    |            | localhost              |
 | mac-service                                        |    |            v                        |
 |   digest: extractor -> fact sheet -> queue --------+--->| LM Studio  127.0.0.1:1234           |
 |            |                          ^  |         |    |            ^ localhost              |
 |            v                          |  v         |    | lm-relay :1235 (installed)          |
 |   .state/digest.json (0600)    validator <- reply  |<---|   GET /api/v0/models, read-only     |
 |            |                                       |    +-------------------------------------+
 |   hub: claude.digest.get / claude.digest.update ---+--> /ws (LAN token) --> Car Thing:
 +---------------------------------------------------+     digest first card, #/digest list, session strip, ambient line
```

**Everything new runs in `mac-service`.** Summaries reach the panel only through its `/ws`, so the Car Thing never gets an inference address or token. The digest calls the NucBox over HTTP, so it spawns no `claude` process and adds no phantom sessions. It reuses the NucBox work's relay to learn which models are loaded; the panel's NucBox view is otherwise untouched.

### The fact extractor

**Two layers: facts first, prose second.** A deterministic extractor turns transcript records into a fact sheet. The model only sees the sheet, never the raw transcript or any tool output. The same facts make the card when the model is absent.

**Reading.** The extractor keeps a byte offset per transcript, as `source-transcript.js` does, and reads only new bytes. The first read of a large transcript happens once and is persisted. It must never hold the event loop long enough to delay a hook response: it reads in chunks and yields between them, or runs in a worker thread. That is the builder's choice, held to the latency check below. Field access is defensive: an unknown record is skipped and counted, never thrown.

**Turns.** The unit is a *turn*: everything up to a `stop_hook_summary` record. Failing that, a turn ends at the next owner prompt or at the last `assistant` record with `stop_reason: "end_turn"`. An owner prompt is a `user` record with `origin.kind === "human"`; records without an `origin` fall back to the existing `userText()` rule, and compaction summaries never count as prompts.

**Not every turn starts with an owner prompt.** In one recent transcript I checked (read-only), 71 turns ended in a `stop_hook_summary`: 37 began with a human prompt, 4 with a background-task notice, and **30 (42%) began with no user record at all**. Claude simply kept working after a Stop. The cause isn't established; the panel's own rewake hook, queued messages and background tasks are candidates. So a turn records its *trigger* (`human`, `task-notification` or `none`). A turn with no human prompt takes the most recent human prompt as its intent, and its fact row says it was a continuation. The sheet's "last six turns" counts turns, not prompts. *Added by the orchestrator after review; the writer's draft assumed every turn starts with an owner prompt.*

**What goes into a fact sheet:** the last six turns, plus whole-session totals (proposal). Each fact has a stable id the model must cite.

| Fact | Id | Source | Kept (proposal) |
|---|---|---|---|
| Session header | — | title (`custom-title`, then `ai-title`), project folder, model, start time | — |
| Owner's prompt | P*n* | owner prompt text | 500 chars each |
| Claude's final reply | R*n* | text blocks of the turn's last `assistant` record | 1,200 chars each |
| Turn time | — | prompt timestamp to `stop_hook_summary` timestamp | — |
| Files | F*n* | `Edit` / `Write` `file_path`, relative to the cwd. `Write` result `type: create` means created. Line counts come from `structuredPatch[].lines`. `MultiEdit` / `NotebookEdit`, if they ever appear, count as edits by `file_path`. | top 8 |
| Commits | C*n* | a `Bash` command matching `git … commit` whose result has no `is_error`. The subject comes from `-m` or a heredoc's first line when parseable, else "message not read". The sha comes from `gitOperation.commit` when present. | last 5 |
| Pushes, PRs | G*n* | `gitOperation.push` / `.pr`; `pr-link` records, deduplicated by number | last 3 |
| Test runs | T*n* | a `Bash` command matching a test runner (`npm test`, `node --test`, `pytest`, `jest`, `vitest`, `go test`, `cargo test`; extendable). The outcome is a parsed count (`ℹ pass N`, `# pass N`, `N passed`, `N failed`). Without a count, `is_error: true` means failed; otherwise it is **"ran, outcome not reported"**. | last 3 |
| Failing commands | X*n* | other `Bash` results with `is_error: true`; the command only, 160 chars | last 3 |
| Subagents | A*n* | meta `description`, `agentType` and `finished`; the first 300 chars of the report (`subagents.js`'s `reportOf` rule) | last 6 |
| Questions, plans | Q*n* | `AskUserQuestion` / `ExitPlanMode` tool calls | count + last |
| Denied tool calls | — | `user` records with `toolDenialKind` | count |
| Totals | S*n* | turns, files, commits, PRs, test runs and subagents for the whole session | — |

**Never in a fact sheet:** file contents (`Write.content`, `Edit` strings), tool output beyond the parsed counts, thinking, attachments, `api-request*` records, or anything from another session.

**Size and format.** A sheet is capped at 12,000 characters (proposal). That is roughly 3k tokens at 4 chars per token, to be measured with the chosen model's tokenizer. Over the cap, the oldest turns go first, then replies are shortened. The model gets one compact line per fact, such as `T2 test: npm test -> 212 passed, 0 failed`. The structured version is what is stored and sent to the panel.

### The summarization call

**Request.**
- `POST <inference>/v1/chat/completions`, not streamed, with the token in the `Authorization` header. `<inference>` is whichever path the owner picks (see Network and secrets); the body is LM Studio's OpenAI-compatible format either way.
- `model` is the configured key. Proposals: `temperature: 0.2` (low, because the job is restating) and `max_tokens: 350`. Evaluation and production use the same settings. For a reasoning model such as `gemma-4-12b-qat`, also `reasoning_effort: "none"`; without it the reasoning uses the whole token budget (see "Measured on the NucBox").
- A fixed, versioned system prompt (`digest-v1`) comes before the sheet. It says to write for a glance from a metre away, use only the facts and cite their ids, say "tried" rather than "did" when a fact only shows an attempt, and give no advice or guesses about intent.

**Structured output** (`response_format.json_schema`, `name: "session_digest"`):

```json
{"type":"object","additionalProperties":false,
 "required":["headline","headline_facts","bullets","outcome"],
 "properties":{
   "headline":{"type":"string","maxLength":80},
   "headline_facts":{"type":"array","items":{"type":"string"},"minItems":1,"maxItems":4},
   "bullets":{"type":"array","minItems":1,"maxItems":3,"items":{"type":"object","additionalProperties":false,
     "required":["text","facts"],"properties":{"text":{"type":"string","maxLength":72},
     "facts":{"type":"array","items":{"type":"string"},"minItems":1,"maxItems":4}}}},
   "outcome":{"type":"string","enum":["finished","asked_owner","stopped_partway","unclear"]}}}
```

`outcome` is the one judgement the store can't make: whether a turn ended by asking the owner something. The length limits are proposals, sized for the layouts below. *Builder must verify on the real install* whether `strict` is accepted as a boolean or only as the documented string, and whether the grammar honours `maxLength`. The validator enforces the limits either way.

**The validator** runs before anything is stored or shown:
1. The reply must parse and fit the schema. Over-long text is cut at a word boundary.
2. Every cited id must exist. A bullet without one is dropped; a headline without one rejects the whole summary.
3. Every number in a headline or bullet must appear in a fact it cites.
4. Every path-like token must appear in a fact it cites.
5. The output is redacted again.
6. If no bullet survives, the card stays facts-only.

It can't catch a paraphrase that flips the meaning ("fixed" for "tried to fix"). The owner's review covers that.

**Timeouts** (proposals; Milestone 0 replaces them with about twice the measured p95): 3 s for the model-list probe (as the panel's poller uses), 3 s to connect, 90 s for the whole request.

**The digest never causes a model load.** The owner keeps the chosen model loaded; per the docs, an explicitly loaded model has no TTL and isn't auto-evicted. Before a batch, the digest reads the loaded models from the relay's `GET /api/v0/models` (cached for 60 s). When checked, nothing was loaded, so until the owner loads a model every card is facts-only. If the configured model isn't there, it sends nothing and reports `model-not-loaded`. The proposed inference relay checks again, so a digest request never JIT-loads a model beside, or instead of, what the owner runs.

### Triggers, caching, persistence and rate

**Triggers.**
- **Stop** marks the session dirty: a flag and a timer, set after the response is written, with no I/O on the hook path. A dirty session is summarized after 60 s without another Stop, or 10 minutes after it first became dirty (proposal), so a burst of turns makes one request.
- **SessionEnd** summarizes a dirty session at once.
- **Start-up.** The service scans `~/.claude/projects/*/*.jsonl` changed inside the window and catches up at low priority, newest first. It reads top-level files only, and skips its own sessions and those with no owner prompt.

**Queue and rate** (proposals; Milestone 3 logs the real rate). One request in flight, newest finished turn first. At most one request per session per 2 minutes, and 30 per hour overall. After a failed connection or a timeout, back off 1, 2, 5, then 10 minutes, then every 15, probing with the 3 s model-list call. A sheet rejected three times isn't retried.

**Cache.** Summaries are keyed by a hash of the sheet text, the prompt version and the model id, so an unchanged sheet is never sent again, even after a restart. Each summary covers a transcript position. The card counts finished turns after that position as "+N TURNS".

**Persistence.** The state lives in `mac-service/.state/digest.json`, written atomically as `persist.js` does but at **mode 0600**, because it holds prompt excerpts. It is written at most once every 10 s. For each session it keeps the transcript path and offset, six turns of facts, the totals, and the summary with its key. Sessions outside the window are pruned. The digest logs sizes, timings and states, never content.

### Failure and offline behavior

The NucBox is optional at every step. If a summary is missing or fails, the card keeps its facts and the last good summary, if there is one.

| State | Digest screen | Card |
|---|---|---|
| Fresh | strip, right side: `SUMMARIES · NUCBOX` | model summary, no tag |
| Behind | — | last summary with `+N TURNS` |
| Facts only (no summary yet, or rejected) | — | extractive card with `FACTS` |
| NucBox offline, backing off | `NUCBOX OFFLINE · FACTS ONLY` in `--muted`, never red | last summaries, tagged as above |
| Model not loaded | `MODEL NOT LOADED · FACTS ONLY` | as above |
| Not set up (no `digest.json`) | `FACTS ONLY` | facts-only cards |
| Nothing in the window | existing `.empty` style: `NOTHING DONE IN THE LAST 24H` | — |
| Mac service unreachable | existing offline banner; last digest stays with its ages | — |

**The extractive card.** The headline slot shows `LAST REPLY` and the first sentence of the newest final reply, quoted and cut to 80 chars. These are Claude's own words, so they can't be unfaithful. The bullets are fact lines: files edited (by name), commits (with subjects when read), the test outcome as reported, subagents finished, and PR numbers.

### Protocol additions

In `protocol/claude-protocol.md`, in the existing style:

| Method / topic | Params / data | Notes |
|---|---|---|
| `claude.digest.get` | `{}` → `Digest` | the whole digest, for a panel that just connected |
| `claude.digest.update` (event) | `Digest` | full idempotent snapshot pushed on change, debounced 2 s (proposal); superseding |

```ts
Digest = {
  updatedTs: number, windowHours: number,
  summarizer: { state: 'ok'|'off'|'offline'|'model-not-loaded'|'error', model: string|null, lastOkTs: number|null },
  totals: { sessions, turns, commits, prs, testRuns },     // the fleet strip; deterministic
  cards: [DigestCard],                                     // newest finished turn first, at most 20 (proposal)
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

A card's live state comes from the existing `claude.sessions.update` snapshot by `sessionId`. A session missing from the snapshot shows as ended.

**Existing code that must change:**
- **`mac-service/src/hub.js`:** `SUPERSEDING = /^claude\.(sessions?|usage|digest)\./`.
- **`mac-service/src/index.js`:** create the digest beside `createUsage`, register `claude.digest.get` in `hub.setMethods`, and start and stop it with the service.
- **`mac-service/src/http-server.js` (or the hooks source):** after the response to `Stop` or `SessionEnd`, notify the digest with the session id and `transcript_path`.
- **`mac-service/src/sessions/source-mock.js`:** demo cards in every state, for `SIM_DEMO=1 npm run sim`.
- **`panel/src/shell.js`:** `digest: 1` in `SECTIONS`, the Agents section. `AGENTS_CYCLE` is unchanged.
- **`panel/src/ws-mux.js`:** `claude.digest.update` joins `PRIMARY_ONLY`, so only the Mac's digest reaches the panel. `claude.digest.get` needs no change: an unlisted method already goes to the Mac's link only.
- **`panel/src/screens/session-list.js`:** the digest card in column 0 of the grid, before the sessions.
- **`panel/src/main.js`:** a `digest` render branch; dial, select and back handlers (Back goes to `#/list`, as from usage); on the sessions screen, the dial, press and tap for the first card; `digest` in the 15 s re-render list; `ws.on('claude.digest.update')`; and `claude.digest.get` in `ws.onOpen` (the Mac's link) next to `claude.usage.get`.
- **Elsewhere in the panel:** `store.js` gets `digest: null` and a flag for the cursor being on the first card. Add a new `screens/digest.js`, change `screens/session-detail.js` and `screens/ambient.js`, and add new classes in `styles.css` (no existing class starts `.dg`, `.dstrip`, `.dcard` or `.adigest`). In `README.md`, the controls line becomes "2 Agents (again: usage, NucBox; the digest is the first card on the sessions screen)".
- **Tests** go next to each change: `panel/test/shell.test.js` for the unchanged cycle and the section, `panel/test/ws-mux.test.js` for the Mac-only digest, screen tests for every state (the sessions grid with no digest byte-identical to before), and mac-service tests for the extractor, validator, redaction and queue.

### Network and secrets

**How the Mac reaches inference is the owner's decision. Every NucBox change it needs (exposing inference, a new startup task, a firewall rule) needs the owner's own approval first; the NucBox session's earlier approval covered only its read-only relay and LibreHardwareMonitor and doesn't carry over.** That work keeps LM Studio on localhost and exposes only the read-only model list. The digest also needs the Mac to call `POST /v1/chat/completions`. There are three ways to allow that:

- **(a) LM Studio on the LAN.** Turn on Serve on Local Network and Require Authentication, and add a Windows firewall rule that admits LM Studio's port from the Mac's address only.
  - *For:* no new code in the inference path.
  - *Against:* it reverses that work's "stays on localhost" design. It puts LM Studio's whole API (chat, model load, unload, download) on the LAN interface, behind only that rule and the token. It depends on Require Authentication existing on the installed version, which is the unresolved discrepancy above. Windows may already hold a broad inbound rule for LM Studio from its first launch; allow rules add up, and the Homebridge rule above shows this machine already has one. Turning auth on would also break the existing relay, which sends no `Authorization` header upstream.
- **(b) A second small relay on the NucBox, for inference only.** LM Studio stays on localhost.
  - *For:* it holds whether or not the installed LM Studio has auth. It exposes one call, behind a token check and an in-process check of the caller's address, both written and tested by this project. The NucBox itself refuses to load models. And it follows that work's patterns: a dependency-free Node relay, a test against a fake LM Studio and a startup task. Because LM Studio's JIT loading is on, the 409 for an unloaded model matters.
  - *Against:* one more small program and port on the NucBox, and a token stored there too. Because of the Homebridge rule it can't lean on the Windows firewall to restrict callers; see below.
- **(c) Extend the existing relay.** Rejected. That relay is deliberately read-only, sends `Access-Control-Allow-Origin: *`, has no auth, and answers the whole local subnet, the Car Thing included. Adding inference would put it within the Car Thing's reach, with authenticated and open routes on one port.

**Claude's recommendation: (b).** It is the only option that doesn't hinge on the auth discrepancy, and it leaves the NucBox work's design intact. (a) is the simpler fallback if the owner wants no new code *and* the installed LM Studio is confirmed to have Require Authentication. Either way the Car Thing can't use inference: it never holds the token, and the relay refuses any caller that isn't the Mac. The Windows firewall can't be the reason, because of the Homebridge rule.

**What the digest needs from (b).** This branch builds it, in `nucbox/` beside `lm-relay.js` (already in `main`); the NucBox session declined to. It uses its own filename (`digest-relay.js`), its own scheduled-task and firewall-rule names, and its own command-line match in `install.ps1`'s `Stop-Ours`, which today kills only Node processes whose command line contains `car-thing-panel\lm-relay.js`. `uninstall.ps1` removes tasks and rules from an exact name list, so the new names are added there. The owner approves each NucBox change before it is made.
- **Route.** `POST /v1/chat/completions` only. Every other path and method gets 404 or 405 and is never forwarded. No CORS headers, since no browser calls it. Proposed port: 1236.
- **Auth and caller.** `Authorization: Bearer <token>`, compared in constant time; anything else gets 401. The relay also refuses (403) any connection whose remote address isn't the configured Mac address, whatever the Windows firewall allows, so the Mac needs a fixed address (a router reservation). A port-scoped firewall rule is an extra layer only if it can be made to apply: the relay could run from its own copy of `node.exe`, whose path the Homebridge rule doesn't match (unverified), or the owner could narrow the Homebridge rule, which is theirs to change. The address check is defense in depth, not authentication; the token is the real gate.
- **Forwarding.** The body goes unchanged to `http://127.0.0.1:1234/v1/chat/completions`, with any `ttl` stripped, and only if its `model` is loaded. Otherwise the relay answers 409 `model not loaded`.
- **Limits** (proposals): a 64 KB body cap and one request at a time (429 when busy). It returns 502 when LM Studio is unreachable, as `lm-relay.js` does, and 504 at its own timeout. That timeout is set longer than the Mac's 90 s, so the Mac decides.
- **The token on the NucBox** lives under `%ProgramData%\car-thing-panel\`, the folder `install.ps1` already uses, readable only by the task's account. On the LAN it travels in plain HTTP, as the panel's own `/ws` token does.

**The Mac's secret** lives in **`~/.config/claude-panel/digest.json`** (mode 600, never in the repo): `{"inference": "http://<nucbox>:1236", "token": "…", "model": "<model key>"}`.
- The loaded-model check reads the relay URL already configured for the NucBox view: `ha.json`'s `nucbox.lmstudio`, presumably the relay on 1235.
- The token is **not** in `ha.json`, because `provision.sh` copies `ha.json` to the Car Thing.
- The service warns if the file is readable by others. With no file, the digest is facts-only.

**Redaction** runs on every text fact before it enters a sheet, and on the model's output. Required categories: provider key prefixes (`sk-`, `ghp_`, `github_pat_`, `xox?-`, `AKIA`); PEM private-key blocks; JWTs (the HA token is one); `Bearer …`; `key=`, `token=`, `secret=` and `password=` assignments; and long base64 or hex runs, except short git shas. Only paths are kept, never contents, so a `.env` file appears by name alone. Tests plant one secret of each kind.

### Model selection and evaluation

**Requirements (fail any and the model is out).** The model must be instruction-tuned. It must return schema-valid JSON for every golden sheet, its loaded context must hold the largest sheet plus the reply, and it must fit in memory beside what the owner normally keeps loaded.

**Size is a risk to measure, not a rule.** LM Studio's docs warn that structured output is unreliable "particularly" below 7B. The model the NucBox work used for tuning is a 4B (`nemotron-3-nano-4b`), and the GPU is integrated (a Radeon 760M, from that commit message), so a 7B-14B model will be slower and share memory with everything else. The NucBox session measured the 4B at about 3 GB of VRAM (of a 6 GB carve-out) and about 20 tokens/s, with system RAM about 83% used. A 350-token reply is then roughly 18 s of generation before prompt processing (arithmetic from that rate, not measured for this job), and a larger model has little headroom. The owner says they will likely use a different model. The design can tolerate a small model better than most uses could: the schema is enforced by grammar, the validator drops unsupported claims, and the facts-only card is the fallback. So the candidates are the owner's currently loaded 4B plus one or two larger downloaded models, and the golden set decides. For any candidate under 7B, schema validity on all 20 sheets is checked first. Pick candidates once the owner says which downloaded models they would keep loaded for this.

**Golden set.** About 20 real sessions from this Mac, run through the extractor. The set covers a short Q&A, a long build with many subagents, failing tests, a commit and a PR, a turn that ends by asking the owner something, a compacted session, and a session where nothing changed. The sheets stay in `mac-service/.state/digest-golden/` (git-ignored, mode 600) and are never committed. A harness script in the repo runs each candidate with the production settings. It records validity, what the validator dropped, and the time with the model loaded.

**Pass/fail (proposals; the owner sets the bar).** The owner reads each summary beside its sheet and its facts-only card.
- **Faithfulness:** no unsupported claim in any headline, and at most one unsupported bullet across all 20.
- **Usefulness:** better than the facts-only card on at least 12 of 20.
- **Speed:** p95 under 60 s with the model loaded.

If no candidate passes, the digest ships facts-only. That is a legitimate result.

**Measured on the NucBox, 2026-11-06 (a smoke test, not the golden set).** `google/gemma-4-12b-qat`, loaded with a 20,480-token context, driven over `ssh nucbox` against LM Studio's localhost API with synthetic fact sheets in the format above: three sheets of 440, 2,297 and 7,384 characters, six replies with thinking off. The model was already loaded; nothing was loaded or unloaded.
- **It is a reasoning model.** By default every request spent all of `max_tokens` on hidden reasoning (`reasoning_content`) and returned no JSON, at 350 and at 450 tokens. `reasoning_effort: "none"` on `/v1/chat/completions` turns it off, so **the request in "The summarization call" must send it**. `reasoning_effort: "low"` and `chat_template_kwargs.enable_thinking: false` did nothing. LM Studio's native `/api/v1/chat` also has an off switch (`reasoning: "off"`) but no schema enforcement. `reasoning_effort` isn't in the docs I read, so the builder pins LM Studio's version and re-tests after an update.
- **Speed.** About 7.6-7.9 tokens/s generating (the owner saw 9). With thinking off a reply is about 195-215 tokens: 25-27 s for a 305-token prompt, 34 s for 743 tokens and 30-40 s for 1,819. The first run of a sheet took about 9 s longer than its repeat, which suggests prefill of about 200 tokens/s on a cold prompt (inferred). A full 12,000-character sheet (about 3,000 tokens) should then take roughly 40-55 s, inside the proposed 90 s timeout and 60 s p95 with little margin. GPU load during these calls wasn't measured.
- **Structured output works.** All six replies were valid JSON and fit the schema, with `strict` as a boolean (the string form was also accepted). `maxLength` is enforced as a hard cut: bullets stopped at exactly 72 characters, once mid-marker (`[F1`). The model doesn't plan for the limit, so ask for about 60 characters and let the validator cut at a word boundary.
- **Citations.** The model writes `[F1]`-style markers inside the text as well as in `facts`, and their digits trip the validator's number rule: of the five validator problems in the four larger-sheet runs, four were this artifact and one was a real mis-citation (a file name cited to the owner's prompt instead of Claude's reply), which the validator caught. The prompt should say not to write ids in the text, and the validator strips `[A-Z]\d+` markers before it checks. With markers stripped, three of those four runs pass. On the smallest sheet the model cited the invalid id `1` everywhere.
- **The traps held.** On the tricky sheet (tests that never ran, a failed build, a commit with no message, an open question) both runs said "tried", reported the build failure, claimed nothing passed or was fixed, and set `outcome: asked_owner`.
- **Coverage is the weak spot.** On the six-turn sheet both runs summarized turns 1-2 and left out the commit, the push, PR #14 and the review subagent, so the headline described the first turn, not the last. The card's facts row would still show the commit and PR. The prompt should ask for the most recent turns first.
- **Memory.** `lms ps` reports 7.15 GB for the model. Free system RAM was 5.7 GB at the first look and 1.1 GB later the same day, with a download in progress (cause not established).

**Second round (same model, improved prompt, per-sheet id schema).** Three changes, all kept for the real call: the prompt says ids go only in the `facts` arrays, never in the text, and to describe the latest turns first; it asks for at most 60 characters (the schema's 80 and 72 stay as the hard limits); and the schema is built per sheet with an `enum` of that sheet's real fact ids for `headline_facts` and every `facts` array, so the grammar can only cite ids that exist. Results over five replies on the three sheets: all five valid JSON and schema-valid; no invalid ids (before, the model cited turn numbers like `1` or `3` on the small and tricky sheets); the 6-turn sheet's summaries now mention the commit or PR in both runs (before, in neither); no false claims and `outcome: asked_owner` on both tricky runs; 16-24 s per summary (shorter output); three of five clean under the validator. The failures that remain are real mis-citations, a number attributed to a fact that doesn't contain it (for example "5 second timeout" cited to the totals fact instead of the reply that says it). The validator is doing its job, but its yield is a tuning choice: either accept it, or let the validator repair a citation by adding the fact that does contain the number.

The tested system prompt (this is `digest-v1`):

```
You write a glanceable summary of one Claude Code session for a small desk display read from a metre away.
You are given numbered facts extracted from the session transcript. Use only these facts.
Put the ids of the supporting facts in the facts arrays. Never write ids, brackets or fact numbers inside the headline or bullet text.
Describe the latest state first: what the most recent turns did, including any commit, push or pull request, then earlier work.
Say 'tried' instead of 'did' when a fact only shows an attempt, and say 'ran' when a test run reports no outcome.
Do not give advice and do not guess the owner's intent. Write short plain sentences.
headline: what the session accomplished or is stuck on, at most 60 characters.
bullets: up to three, each at most 60 characters.
outcome: finished, asked_owner, stopped_partway, or unclear.
```

**Other models, same prompt, schema and sheets, one loaded at a time.**
- `nvidia/nemotron-3-nano-4b`: about 7 s per summary at about 21 tokens/s, and 5 of 5 clean under the validator. But it said "Recorder crash fixed" on both tricky runs when the sheet says the fix could not be confirmed, set `outcome: stopped_partway` instead of `asked_owner`, and never mentioned the commit or PR. A clean validator does not mean a faithful summary: the validator checks grounding, not meaning.
- `prism-ml/bonsai-27b` (1-bit): about 43 s at about 6 tokens/s. Both tricky headlines began "Fixed", it wrote that the owner asked a question the assistant had asked, and it put a stray Chinese word into a bullet in both large-sheet runs.
- **Not tested.** `google/gemma-4-26b-a4b-qat`, `qwen3-coder-30b-a3b-instruct` and the newly downloaded `qwen/qwen3.8-27b` (17.7 GB) were skipped by a memory guard. LM Studio's own estimates for the first two are 14.56 and 13.58 GiB against about 11.2 GB of RAM available with nothing loaded. From the loads that did run, available RAM drops by roughly 2 GB less than the file size, so both would still be 0.5-1.5 GB short unless the owner frees memory. `qwen3.8-27b` is a dense 27B: at the machine's observed effective bandwidth (8.1 tokens/s × 7.15 GB and 21 tokens/s × 2.84 GB both come to about 58-60 GB/s, an inference) it would run at about 3 tokens/s, over a minute per summary before prompt processing, so it would not fit the 90 s timeout even with the memory.

**Verdict.** `google/gemma-4-12b-qat` is the best of the three models tested and the only one that passed the faithfulness traps. It is viable as a background summarizer with the changes above: about 16-40 s per summary and one request at a time. That is a handful of replies on three synthetic sheets, so it does not establish the faithfulness bar above, and the two untested mixture-of-experts models (about 4B and 3B parameters active per token) remain the candidates most likely to beat it on speed if the owner can free 2-4 GB of RAM.

### On the panel

**Where it lives (the owner's decision, 2026-11-06).** The owner said the digest "should be on top generally", and chose the first card on the sessions screen. The digest is a full-height card in column 0 of the sessions grid, before the sessions. It shows the fleet line and the newest three sessions, each with its live lamp, its one-line summary (the headline; until a model writes one, the last reply, else the first fact line) and its age, and it says `PRESS TO OPEN`. Pressing or tapping it opens `#/digest`, the full list below, as a drill-down. The dial still starts on the first session, so a press still opens a session; the card is one tick back. With no digest yet, or no cards in the window, the grid is exactly as before. With cards but no live sessions, the card stands alone beside the usual "no sessions" text, so the day's work stays reachable after every session has ended. Preset 2's (Agents) cycle is unchanged (sessions → usage → NucBox). The session view gets a one-line strip, and ambient gets one line.

**The digest is the Mac's.** The grid also shows the NucBox's sessions, but the digest covers the Mac's only: `claude.digest.get` goes to the Mac's link, `claude.digest.update` passes from the Mac only, and a card's live state is the Mac's session with that id in the merged list (one without `machine`). A NucBox session never lights, labels or opens a card, and its session view shows no strip or card. The NucBox runs the same service code, so it may compute a digest of its own; the panel ignores it. The grid tiles are unchanged: their subline is a single 21px mono line of about 26 characters (336 px), which would cut every headline.

**Sessions screen with the digest card** (example text, 800×480, sizes in px). The card scrolls out to the left when the cursor reaches the second column of sessions, and comes back when it returns to the first column or to the card:

```
+--------------------------------------------------------------------------------+
| # SESSIONS  5                                        . o . .   14:32   o       |  topbar, existing (46)
+--------------------------------------------------------------------------------+
| +------------------------------------+ +------------------------------------+ ||  card: column 0, 372 x 414, both rows
| | DIGEST                             | | [#] WORKING                  AUTO  | ||  DIGEST 700 17 --text-2
| | LAST 24H · 6 SESSIONS · 19 TURNS · | | Panel brightness tuning            | ||  fleet line mono 16 --muted
| | 7 COMMITS · 1 PR                   | | Edit · smoothing the sensor…       | ||
| |                                    | | opus-5 · HIGH        CONTEXT 42%   | ||  tiles: column 1 on, as today;
| | [#] Panel brightness tuning    12m | +------------------------------------+ ||    the first session is selected
| |   "Brightness now follows the      | +------------------------------------+ ||  rows, newest three: lamp 14 static,
| |   room light."                     | | [#] WORKING                        | ||    title 700 19 --text-2, age mono 16,
| | [#] Mount stiffness check       3m | | Mount stiffness check              | ||    reply (else first fact line)
| |   "The stiffness check passes."    | | Bash · npm test                    | ||    500 19 --text-3, <=2 lines
| | [ ] Recorder crash on wake      2h | |                                    | ||
| |   Tests: 14 passed, 0 failed       | |                                    | ||
| |                      PRESS TO OPEN | |                                    | ||  hint mono 16 --muted
| +------------------------------------+ +------------------------------------+ ||  column 2 peeks at the bezel
+--------------------------------------------------------------------------------+
```

**Digest list** (`#/digest`, example text, 800×480, sizes in px):

```
+--------------------------------------------------------------------------------+
| # DIGEST  6                                          . o . .   14:32   o       |  topbar, existing (46)
+--------------------------------------------------------------------------------+
| LAST 24H · 6 SESSIONS · 19 TURNS · 7 COMMITS · 1 PR       SUMMARIES · NUCBOX   |  strip (34): mono 16 --muted
|--------------------------------------------------------------------------------|
| [#] DONE   Panel brightness tuning                         NEW            12m  |  lamp 18 static, state 700 17,
|  Brightness now follows the room light; the dark level is a named constant     |   title 700 22 --text-2, tag 14, age mono 16
|  - Smoothed sensor readings so a passing shadow doesn't flicker the backlight  |  headline 700 24 --bone, <=2 lines
|  - Added tests for the dark and bright breakpoints                             |  bullets 500 20 --text-3, 1 line, <=3
|  - Asked whether to tune the breakpoints on the device             ASKED YOU   |  outcome chip 14 caps, --text-2 outline
|  3 FILES · 2 COMMITS · TESTS 41 PASS · 1 AGENT                PRESS TO OPEN    |  facts mono 16 --muted
|--------------------------------------------------------------------------------|
| [#] WORKING  Mount stiffness check                         +2 TURNS        3m  |  collapsed (58): lamp 14, state 15,
|  Thickened the hidden part of the rod; the stiffness check now passes          |   title 15 --dim; headline 19 --text-2, 1 line
|--------------------------------------------------------------------------------|
| [ ] ENDED    Recorder crash on wake                        FACTS           2h  |
|  LAST REPLY "The recorder now reopens the audio device after resume."          |
+--------------------------------------------------------------------------------+
```

The selected session is an expanded card; the others are two-line rows above and below it, and the column scrolls to keep the selected card on screen. `NEW` marks a card whose content changed since the owner last had this screen up for at least 5 s with the display lit. That time is kept on the panel, like the mascot setting. Spacing uses margins, never flex `gap`.

**A session card** has three looks. *Fresh* is as above. *Behind* is the same card with `+N TURNS` and the age of its summary. *Facts only* replaces the bullets with fact lines and drops the facts row:

```
| [ ] IDLE   Recorder crash on wake                          FACTS          41m  |
|  LAST REPLY  "The recorder now reopens the audio device after resume."         |  700 22 --text-2, quoted
|  - Edited 2 files: device/panel-recorder/main.c, +1                            |  20 --text-3
|  - Tests: 14 passed, 0 failed                                                  |
|  - 1 commit: fix(recorder): reopen after resume                                |
```

**Session-detail header.** The view opens pinned to the newest message, so a block at the top of the column would be off screen. Instead, a fixed strip sits between the topbar and the column. It is shown only when a summary or last reply exists, and costs 40 of the 434 px. The full card follows the newest message, before the "Open in VS Code" rows, one knob tick past the end.

```
+--------------------------------------------------------------------------------+
| # SESSION                                            . o . .   14:32   o       |  topbar (46)
+--------------------------------------------------------------------------------+
| [#] Brightness now follows the room light; the dark level is a named...   12m  |  strip (40): lamp 14, 20 --bone, 1 line, age mono 16
+--------------------------------------------------------------------------------+
|   ...the conversation, unchanged...                                            |
|   Hold the top button to send Claude a message.                                |
|   SUMMARY · <model> · 12m                       (16 caps --text-2)             |  <- one knob tick past the end
|   headline, bullets and facts row as on the digest card                        |
|   Open in VS Code / Open automatically / Subagents ...                         |
```

**Ambient one-liner.** One new line goes under the fleet lamps: the newest card's age, title and headline (or last reply), in 20px Chakra Petch 500, `--text-3`, ellipsized near 64 characters. **It disappears whenever the clock's own head is counting something waiting** (`ambientQueue(asks).count` from the queue inbox: a permission, a question or an ASKING card, loud or quiet), so "N NEED YOU" has the screen to itself. It is not keyed to `state.asks.length`, because the inbox keeps an UPDATE card per session in `state.asks` until it is cleared, and that test would hide the line almost all the time. It also disappears when nothing has finished in the last 12 hours (proposal). It isn't tappable, because the whole ambient screen is the mascot switch.

```
|                                    14:32                                        |  104
|                               NOTHING BLOCKED                                   |  34
|                            2 WORKING · 4 RESTING                                |  20
|                               [#][#][ ][ ][ ][ ]                                |  lamps
|          12m · Panel brightness tuning — Brightness now follows the room        |  new: 20 --text-3
|                               1.2M tokens out                                   |  18
|                           PRESS DIAL FOR SESSIONS                               |  15
```

**States.** Lamp colours and labels follow the grid tiles: WORKING `--ok`, ATTENTION `--warn`, DONE `--done`, IDLE and ENDED `--idle`, with idle and ended titles in `--muted`. **Every lamp on the digest is static**, so when something waits, the existing `.edge` pulse is the only motion on screen. Stale, facts-only and offline appear only as the quiet tags and strip text above. Nothing uses `--warn` or `--danger`.

**Input.**
- **Sessions screen:** the dial starts on the first session at boot, as today. After that the cursor stays on the session it is on when the list re-sorts (`store.applySnapshot` keeps `selectedIndex` on the same session id), so it is not always the first one, and the digest changes none of that. One tick back from the first session selects the digest card, and one tick forward from the card returns to the first session. A press on the card, or a tap anywhere on it, opens `#/digest`. Leaving the sessions screen puts the cursor back on the first session, so the dial-press habit never lands on the card by surprise. If the digest loses its last card while the card is selected, the cursor moves to the first session.
- **Knob (digest list):** moves one session per tick. The selection follows the session id, so a re-sort never moves the cursor to another session.
- **Press (digest list):** opens `#/session/<id>` for a live session. For an ended one it shows a `SESSION ENDED` toast, because the store has dropped it.
- **Back, preset 2, top button:** Back from `#/digest` goes to `#/list`, with the cursor on the first session. Preset 2 (Agents) cycles sessions → usage → NucBox as before, with no digest stop; from `#/digest` it goes to the sessions screen. A top-button tap goes to ambient, as everywhere.
- **Touch:** on the list, a tap selects a row, and a tap on the selected card presses it. Drags are dial ticks, as `input.js` already treats them.

**When something needs the owner.** The digest changes nothing in `surface()`. On the digest screen an ask lights the edge and the topbar count, as on usage, and the queue inbox's jump is unchanged: a loud item (a permission, an ASKING or ERROR card) pulls the panel to the queue from any screen except dictate, prompt and ask, ten seconds after the last input (`jump.js`: `JUMP_QUIET_MS` and `BUSY_ROUTES`), so from ambient and from `#/digest` alike; a held question or plan opens its own screen instead. A digest update never toasts, never wakes the display (`main.js` tells `display.js` about asks only) and never navigates.

## Milestones (suggested order)

0. **An inference path and real numbers** (can run beside Milestone 1). The NucBox work's relay is already installed, so this doesn't repeat that setup. The owner also loads the candidate model(s) in LM Studio.
   - The owner picks (a) or (b). Under (b), the inference relay and its tests are built on this branch in `nucbox/`, with its own install steps (see Network and secrets). The owner approves each NucBox change first.
   - The Mac and the NucBox each get a fixed address (a router reservation), and the Mac gets `digest.json`. The owner decides what to do about the Homebridge firewall rule.
   - A probe script, `mac-service/scripts/lmstudio-probe.js`, reads the loaded models through the relay and sends one toy `json_schema` request. It reports connect and total times, plus `usage` token counts if LM Studio returns them.
   - *Proves:* the Mac reaches inference with the token and the Car Thing doesn't; structured output works on at least one model; real numbers exist for the timeouts.
1. **Facts-only digest, no model.** The extractor, records, persistence and triggers; `claude.digest.*` and the hub change; the Digest screen, session strip and ambient line with facts-only cards; simulator demo data. *Proves:* the extractor is right on real transcripts, the owner can judge the layout on the simulator and the device, and hooks aren't slowed. It is useful on its own if inference never arrives.
2. **Golden set and model choice.** The client, validator, redaction and harness; about 20 condensed sessions; the owner's ratings. *Proves:* a named model meets the bar, or none does and the digest stays facts-only.
3. **Live summaries.** The queue, debounce, cache, backoff and model-not-loaded handling; every state on the panel; the request rate logged. *Proves:* summaries follow real work within minutes, losing the NucBox changes nothing else, and a restart re-spends nothing.
4. **Polish after a week of use:** tune the limits, layout and window to what the owner actually reads; update the protocol doc and README.

## How we will know it works

- **The NucBox goes away mid-request** (LM Studio stopped, or the box off). Within one probe, the strip reads `NUCBOX OFFLINE · FACTS ONLY`. Cards keep their summaries and gain `+N TURNS` as work continues. The log gets one line per state change, not one per retry, and nothing else on the panel changes. When the NucBox returns, the backlog drains one request at a time.
- **Hooks are unaffected.** A script POSTs PreToolUse and PostToolUse payloads to `/hook` at a realistic rate, once with the digest catching up from nothing on the largest transcript (54.8 MB when measured) and once with the digest off. p99 response time stays within 10 ms of the baseline (proposal). **Found in review: that p99 rule alone cannot see the regression.** A 50 MB catch-up lasts about 90 ms and overlaps only about two hooks at a realistic rate, so a run-wide p99 ignores it (a reader that parsed the whole file synchronously still printed PASS). So the check has two rules. The p99 rule stays as the steady per-hook cost check. A second rule sends hooks back to back (one in flight) for about a second from the moment the service accepts connections, three times with the digest off and three with it on, alternating, and compares the best (smallest) of the slowest responses: it fails when the digest-on best is more than 35 ms above the digest-off best. With a blocking reader that rule failed every time (digest-on 82-137 ms against 2-3 ms off); with the real reader it passed every time (3.6-6.8 ms). A run in which fewer than 20 hooks overlapped the catch-up is inconclusive, not a pass, and a service that dies mid-run is a failure. A permission and a question raised during a summary request surface with unchanged timing (this applies from the summary milestone on; there are no summary requests in the facts-only milestone).
- **No re-spend.** After a restart, no request goes out for a session whose sheet hasn't changed, as the logged request count shows.
- **No model loads.** With the model unloaded, the digest sends nothing. A hand-made request to the inference relay gets 409, LM Studio shows no new load, and the strip reads `MODEL NOT LOADED`.
- **Inference is the Mac's alone.** From the Car Thing and from another LAN host, the inference port is refused (403 from the relay's address check, or no connection), even with the right token. From the Mac, a wrong or missing token gets 401, and any other path gets 404 or 405. The relay's tests assert the same against a fake LM Studio, with the remote address faked, as `lm-relay.test.js` does.
- **Faithful summaries.** Over several days of normal use, the owner reviews at least 20 live summaries beside their sheets, using `mac-service/scripts/digest-review.js`, which reads the state file. They meet the Milestone 2 bar.
- **Unit tests.**
  - An unknown id, or a number missing from the cited facts, drops the bullet.
  - Malformed JSON gives a facts-only card.
  - A planted secret of each kind never reaches a sheet, the state file or the event.
- **Extractor fixtures.**
  - A task notification is not an owner prompt.
  - A quiet commit without `[branch sha]` still counts as a commit.
  - A test run without a count reads "outcome not reported".
  - A turn with no human prompt is a continuation and borrows the last human prompt as its intent.
- **Panel.** Every state renders at 800×480 in the simulator with demo data, with glance text at least 19px and nothing under 14px. Knob, press, Back, presets and touch behave as specified. The edge pulse shows over the digest when an ask arrives, and the ambient line disappears while anything waits.

## Other uses of the NucBox model

Ranked by value to the owner. Each reuses the Milestone 2 client and validator. None is designed here.

1. **Plan and question digest on the prompt screen.** Three bullets on what Claude is asking and why, beside the plan, never instead of it. *Needs:* a reply well inside the 120 s hold. *Fails:* late, or by misstating a plan the owner then approves. That is the worst failure on this list, so this waits for a faithfulness record. *Cost:* one request per plan.
2. **Dictation clean-up.** Tidy whisper.cpp text (punctuation, filler words) before the owner reviews it. *Needs:* tiny inputs and outputs. *Fails:* safe, since the raw text is sent as today. *Cost:* one small request per message.
3. **Stuck or looping session.** Flag a card when the same failing command repeats. *Needs:* no model, because the extractor's failing-command facts already show it; a model would only word it. *Fails:* as a false flag. *Cost:* none.
4. **Morning or end-of-day digest per project, on ambient.** *Needs:* one request a day over stored summaries. *Fails:* by being missing. *Cost:* small.
5. **Handoff note when the context is nearly full.** A resume summary the owner can paste, never injected. *Needs:* a larger sheet. *Fails:* as a weak note.
6. **Permission explainer,** beside the existing `destructive` flag. *Needs:* an answer well inside the 20 s hold (`DEFAULT_PERMISSION_HOLD_MS`). *Fails:* dangerously, by calling a destructive command harmless. Advisory only, if ever built.
7. **Natural-language Home Assistant commands.** *Needs:* structured output, and a confirm step for anything physical. *Fails:* as a wrong action. Available only while the NucBox is up.

**Explore next:** dictation clean-up first, because it is small, fails safe, the owner reviews every result, and it proves the client on a second job. Then the plan digest, the biggest win for answering from the dial, once the agent digest has a faithfulness record. The stuck-session flag needs no model and can come straight from Milestone 1's facts.

## Calls made by Claude (owner to confirm)

- **It runs in `mac-service`.** The Car Thing never receives an inference address or token.
- **Facts first, prose second.** Summaries cite fact ids and pass a mechanical validator. The model never sees raw transcripts or tool output.
- **No rolling prose.** Each summary is written fresh from the last six turns and the totals, so an early mistake can't carry forward.
- **The OpenAI-compatible endpoint with `json_schema`**, the documented structured-output path, not the native `/api/v1/chat`.
- **Inference path (b), recommended:** a separate relay for the one chat call, with a token check and an in-process check that the caller is the Mac (the firewall can't be relied on, see Network and secrets). The existing relay stays read-only and LM Studio stays on localhost. The owner decides and approves each NucBox change; this branch builds it after the NucBox work merges. The Mac's secret goes in `digest.json`, not `ha.json`.
- **The digest never causes a model load.** The owner keeps the model loaded, and both the Mac and the relay check first.
- **Triggered by Stop,** with a 60 s / 10 min debounce: one request at a time, rate-capped, and cached by sheet hash.
- **A deterministic fleet line;** no model-written cross-session prose in this version.
- **Placement (decided by the owner on 2026-11-06, closing the open "Cycle order" question):** the digest is the first card on the sessions screen and opens the `#/digest` list; preset 2's (Agents) cycle is unchanged. A strip on the session view, and an ambient line that hides whenever anything waits. Grid tiles are unchanged, and lamps on the digest are static.
- **The digest is the Mac's only.** The panel also shows the NucBox's sessions, but this version's digest covers the Mac's: it is fetched from and pushed by the Mac's link alone, and NucBox sessions never match a card. A digest of the NucBox's own sessions is a later question.
- **Scope:** subagents roll into their parent; the window is the last 24 hours, with at most 20 cards.
- **Facts-only first** (Milestone 1), so the owner can judge the screen before inference exists.
- **Owner prompts are identified by `origin.kind: "human"`** in the extractor. Whether the conversation view should drop task notifications the same way is a separate question.
- **A turn is whatever ends at a Stop, and it records what triggered it.** Many turns have no owner prompt, and they borrow the last human prompt as their intent (see the extractor).
- **The working model is `google/gemma-4-12b-qat`, with thinking off,** the per-sheet id `enum` and the tested prompt above. It is the owner's loaded model and the best of those tested. The two untested mixture-of-experts models are a follow-up if the owner frees memory.
- **A small model is allowed to compete.** The loaded 4B is a candidate despite LM Studio's under-7B warning, because the grammar, the validator and the facts-only fallback contain its failures; the golden set decides.

## Left to the builder

- Module layout and names, and chunked reading or a worker thread, as long as the hook latency check passes.
- The exact system prompt, the redaction patterns within the required categories, and the sheet's line format.
- The state file's shape, and whether to read commit subjects from git when a sha is known.
- Under (a), whether the model check uses LM Studio's `/api/v0` or `/api/v1` listing; the v1 fields aren't verified.
- How to cap `claude.digest.get` if a Bluetooth relay role ever asks for it, as `claude.sessions.list` is capped.
- CSS details within the tokens and size rules, whether tapping the session strip jumps to the full card, and the simulator demo data.

## Open questions

*The NucBox's address, sensors, hardware and reachability are handled in the NucBox work and not asked here.*

- **Inference path:** (b), as recommended, or (a)? Either needs the owner's approval for each NucBox change.
- **Router reservations:** reserve the NucBox (`192.168.1.22`, as the NucBox session advised) and the Mac (`192.168.1.41`; reservation unknown)?
- **The Homebridge firewall rule:** narrow it, or accept in-process enforcement alone? It is the owner's Homebridge.
- **Auth on LM Studio:** none is configured on 0.4.20.0. Does the owner want it on (it breaks the existing relay unless that gets a token too), and does this version offer Require Authentication at all? That decides whether (a) is available.
- **Model:** which downloaded model would the owner keep loaded for the digest, alongside whatever else the NucBox runs? The digest won't load one itself.
- **Sleep:** does the NucBox sleep or switch off? That sets how often cards are facts-only. It may already be answered in the NucBox work.
- **Sessions:** every session, or only those active in the window (default: the last 24 hours)?
- **Freshness:** after each turn (the default, with the debounce), every few minutes, or only while the Digest screen is up?
- **History:** how much should the device keep: today, or a week?
- **Subagents:** rolled into the parent (the default), or shown separately?

## Key risks

1. **A small local model states things the facts don't support.** Cited ids, the validator, the owner's review and the facts-only fallback reduce this. A paraphrase that flips the meaning can still get through.
2. **The transcript format is Claude Code-internal and changing.** `origin.kind`, `gitOperation`, `stop_hook_summary` and the tool set all look recent. The extractor needs fallbacks, fixture tests and a skipped-record count in `/status`, so a format change shows up instead of silently thinning the facts.
3. **Commits and tests are hard to read.** Real commit output carries no sha, and most test runs print no parseable count. Facts will often say "committed" without a subject, or "ran, outcome not reported", and summaries will be vaguer for it.
4. **LM Studio details are unverified on the real install:** whether the installed 0.4.20.0 offers Require Authentication and which endpoints it covers; the v1 model fields; and behaviour while another client is generating.
5. **Two work streams share one NucBox.** The digest depends on the relay, its install scripts and the `ha.json` `nucbox` block, which are now in `main` and owned by the NucBox session, and changes there can break the model check or install steps. The inference relay is built on this branch (rebased onto `main`), because that session declined to build it, with its own names so neither work's install and uninstall steps touch the other's.
6. **NucBox contention.** The digest competes with whatever the owner runs there. If the model isn't kept loaded, cards are simply facts-only.
7. **Mac CPU.** If the reading budget slips, the first read of a 50 MB transcript could delay hook responses.
8. **The NucBox firewall can't be trusted for Node.** A pre-existing Homebridge rule makes any `node.exe` listener reachable from anywhere, so the relay's own address and token checks are the protection. A mistake in them exposes the model to every device on the network.
9. **Exposure at the desk.** Summaries of ended sessions sit on screen and on disk. It is the same kind of content the session view already shows, but more of it, kept longer.
