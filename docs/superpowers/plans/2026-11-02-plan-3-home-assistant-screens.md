# Plan 3: Home Assistant Screens (Home, Audio, NucBox) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two screens to the panel, working in the Mac simulator today and on the Car Thing in Plan 2:
- **Home:** lights and scenes. Press toggles; the knob dims.
- **Audio:** HomePods, with what's playing. The knob sets the volume; press is play/pause.
- **NucBox** (added 2026-11-02): a quiet view of the NucBox's loaded LM Studio model, busy or idle, CPU, memory, GPU and temperatures. It never alerts.

Bed control was dropped from the spec on 2026-11-02. The presets are 1 Home, 2 Audio, 3 Agents (sessions, then usage, then NucBox) and 4 Queue. The waiting alert from Plan 1 shows on every screen.

**Architecture:**
- **Connection:** the panel talks to Home Assistant directly over HA's WebSocket API (`/api/websocket`) with a long-lived token. There is no proxy, so the home screens keep working while the Mac sleeps.
- **Code layout:** the client is a small module with an injectable `WebSocket`. The entity logic is pure and testable.
- **Config:** which entities appear on each screen comes from a config the owner can edit (`~/.config/claude-panel/ha.json`), seeded by a discovery script.
- **NucBox:** hardware numbers are HA entities from the Libre Hardware Monitor integration, so they ride the same HA connection. The loaded model comes from the panel polling LM Studio's REST API directly (`GET <lmstudio>/api/v0/models`). This is Claude's pick of the spec's two options: it needs no HA YAML, and the REST-sensor route stays a fallback if CORS fails on the device.
- **Simulator:** it injects the HA URL and token into `/panel-config.js`. Demo mode runs a mock HA server, so everything works without a real Home Assistant.

**Tech Stack:** As Plan 1: Node 22, `ws`, `node --test`, and a vanilla JS panel built with Vite and `@vitejs/plugin-legacy` for Chrome 69.

**Spec:** `docs/superpowers/specs/2026-11-01-carthing-panel-design.md` (sections "The owner's apps", "Integrations → Home Assistant", Milestone 2).

## Global Constraints

- **Chrome 69 panel rules from Plan 1 apply:** no `?.`, no `??`, no `crypto.randomUUID`.
- **The knob does real work on every screen:** dimming on Home, HomePod volume on Audio.
- **The HA token never enters the repo or a log.** It lives only in `~/.config/claude-panel/ha.json` (mode `0600`) and, at runtime, in `/panel-config.js`.
  - The simulator serves `/panel-config.js` with the token only to requests that aren't cross-site. `Sec-Fetch-Site` must be `same-origin`, `same-site` or `none`, or absent. A cross-site `<script>` gets the config without HA (`ha: null`).
- **Rate-limit knob-driven service calls.** Send at most one `call_service` per entity every `150` ms, and always send the final value.
- **HA connection:**
  - Use only documented messages: `auth`, `get_states`, `subscribe_events` (`state_changed`), `call_service` and `ping`.
  - Reconnect with backoff capped at 30 s.
  - Ping every 10 s; treat 25 s of silence as dead.
- **HA being down or unauthorised never affects the Agents screens**, and vice versa. Each connection has its own offline line; the Plan 1 "Mac offline" banner stays Mac-only.
- **The NucBox view never alerts.** No edge pulse, sound, takeover or badge, whatever its state.
- **LM Studio polling:** every 5 s while the NucBox view is showing and every 30 s otherwise, with a 3 s timeout. A failed poll never touches the HA or Mac connections.
- **Ports:** never use `8080`. The mock HA server in demo mode uses `8124`.

## Review Focus

1. **HA is unreachable, or the token is wrong or revoked.** The HA screens say so plainly ("Home Assistant offline. Reconnecting…" / "Home Assistant token rejected. Make a new one."), the Agents screens are untouched, and it recovers without a reload. *Tests in Task 2.*
2. **An entity is `unavailable` or `unknown`, or disappears from HA.** Its row shows "Unavailable", ignores the knob and press, and nothing throws. *Tests in Tasks 3, 5 and 6.*
3. **The knob spins fast on volume or brightness.** HA gets at most one call per 150 ms per entity, the final value always lands, and the screen shows the knob's value at once instead of jumping back while HA catches up. *Test in Task 3.*
4. **A HomePod has no now-playing data or artwork** (pyatv is patchy). It shows the speaker name and "Nothing playing" or "Playing" with a plain placeholder, and no broken image. *Test in Task 6.*
5. **Part of the NucBox is unreachable.** LM Studio is off but LibreHardwareMonitor is up, or the reverse, or the whole NucBox is off. The view shows what it can and names what's missing ("LM Studio not reachable", "NucBox sensors unavailable"). Busy is never shown when either half is unknown. *Tests in Task 7.*
6. **There are many entities** (30 lights, 10 scenes). The lists scroll with the knob and by touch, and nothing overflows 800×480. *Verified in Task 8's demo.*

---

### Task 1: HA config, discovery script and owner token

**Files:**
- Create:
  - `mac-service/src/ha-config.js`
  - `mac-service/test/ha-config.test.js`
  - `mac-service/scripts/ha-discover.js`
- Modify: `README.md` (an "Home Assistant" section)

**Interfaces:**
- Produces:
  - `HA_CONFIG_PATH = ~/.config/claude-panel/ha.json` (overridable with `CLAUDE_PANEL_HA_CONFIG`).
  - `HaConfig = { url: string, token: string, home: string[], audio: string[], nucbox: NucboxConfig | null }`.
  - `NucboxConfig = { lmstudio: string | null, cpuLoad: string, memory: string, gpuLoad: string | null, gpuMemory: string | null, temps: string[], busyGpuPct: number }`. The strings are HA entity ids except `lmstudio`, a base URL like `http://nucbox:1234`. `busyGpuPct` defaults to `40` and is tuned in Task 9.
  - `loadHaConfig(path) -> HaConfig | null`:
    - null when the file is missing;
    - throws `'ha-config-invalid'` when it doesn't parse or lacks `url`/`token`, or when `nucbox` is present without `cpuLoad` and `memory`;
    - `url` is normalised to `http(s)://host:port` with no trailing slash.
  - `suggestHaConfig(states: HaState[], {url, token}) -> HaConfig`, which picks entities by domain:
    - `home`: every `light.*` then every `scene.*`, sorted by friendly name;
    - `audio`: `media_player.*` whose friendly name or `attributes.model` contains `HomePod`, or else every `media_player.*`;
  - `ha-discover.js`:
    - reads the URL and token from `ha.json` (the owner creates the file with just those two keys);
    - connects, runs `get_states`, prints what it found grouped by screen, and writes the merged suggestion back with mode `0600`;
    - never prints the token;
    - with `--nucbox <name>`, prints every `sensor.*` whose friendly name contains `<name>` and whose unit is `%`, `°C` or `GB`, so the owner can fill in `nucbox`. It doesn't guess the mapping, because Libre Hardware Monitor's sensor names vary by hardware.

- [ ] **Step 1:** Write the failing tests:
  - load returns null for a missing file and throws `ha-config-invalid` for `{}`;
  - the URL is normalised (`http://ha.local:8123/` becomes `http://ha.local:8123`);
  - `nucbox` missing loads as `null`; `nucbox` without `busyGpuPct` loads with `40`;
  - `suggestHaConfig` on a fixture of 9 states (3 lights, 2 scenes, 2 HomePods, 1 Apple TV, 1 unrelated sensor) returns the expected arrays.
- [ ] **Step 2:** Run `npm --prefix mac-service test`. Expected: FAIL.
- [ ] **Step 3:** Implement `ha-config.js` and `ha-discover.js`. The discovery script uses `ws` and the auth handshake from Task 2's protocol notes.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5 (owner):** Create a long-lived token in HA (Profile › Security), then save `{"url":"http://<ha>:8123","token":"…"}` to `~/.config/claude-panel/ha.json` with mode `0600`. Run `node mac-service/scripts/ha-discover.js` and edit the lists if needed.
- [ ] **Step 5b (owner, NucBox):**
  - Install LibreHardwareMonitor on the NucBox. Set it to run as administrator at Windows startup, turn on its remote web server (port 8085), and open that port in the Windows firewall.
  - Give the NucBox a fixed IP in the router, then add the Libre Hardware Monitor integration in HA.
  - In LM Studio's server settings, turn on serving on the local network and CORS.
  - Run `node mac-service/scripts/ha-discover.js --nucbox <name>` and fill in `nucbox` in `ha.json` from what it prints.
- [ ] **Step 6:** Commit: `feat: Home Assistant config and entity discovery`.

### Task 2: HA WebSocket client in the panel

**Files:**
- Create:
  - `panel/src/ha/client.js`
  - `panel/test/ha-client.test.js`
  - `simulator/src/mock-ha.js` (also used by tests)

**Interfaces:**
- Produces:
  - `createHaClient({ url, token, WebSocketImpl = WebSocket, now }) -> client`, with:
    - `start()`
    - `stop()`
    - `on('state', fn(entityId, state|null))`
    - `on('status', fn('connecting'|'online'|'offline'|'unauthorized'))`
    - `states() -> {[id]: HaState}`
    - `callService(domain, service, data, target) -> Promise`
  - Protocol:
    1. Wait for `auth_required`, then send `{type:'auth', access_token}`.
    2. On `auth_ok`, send `get_states` (load all into `states()` and emit each), then `subscribe_events {event_type:'state_changed'}`.
    3. A `state_changed` with `new_state: null` means the entity was removed.
    4. `auth_invalid` → status `unauthorized`. Don't retry until `start()` is called again, which happens when the config changes.
  - `ws` URL: `url.replace(/^http/, 'ws') + '/api/websocket'`.
  - `startMockHa({ port, token, states }) -> { url, server, setState(id, state), calls: [] }`. It implements `auth`, `get_states`, `subscribe_events`, `call_service` and `ping`. Each call goes into `calls` and applies an obvious effect:
    - `light.turn_on`/`turn_off`/`toggle`
    - `media_player.volume_set`/`media_play_pause`

- [ ] **Step 1:** Write the failing tests against `startMockHa`, passing `ws`'s `WebSocket` as `WebSocketImpl`:
  - **auth ok:** `status` goes `connecting` → `online`, and `states()` holds the fixture;
  - **wrong token:** `unauthorized`, with no reconnect attempts after 1 s;
  - **state change:** a mock `setState` reaches `on('state')`;
  - **service call:** `callService('light','turn_on',{brightness_pct:40},{entity_id:'light.desk'})` resolves and the mock recorded it;
  - **server killed:** `offline`, then `online` again after the mock restarts, with no new `start()`;
  - **silence:** no frame for the dead-silence timeout (inject `now` and a short timeout) → `offline` and a reconnect.
- [ ] **Step 2:** Run `npm --prefix panel test`. Expected: FAIL.
- [ ] **Step 3:** Implement `client.js` (ES5 style like `panel/src/ws.js`) and `mock-ha.js`.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(panel): Home Assistant WebSocket client and mock HA server`.

### Task 3: Entity helpers and the knob throttle

**Files:**
- Create: `panel/src/ha/entities.js`, `panel/test/ha-entities.test.js`

**Interfaces:**
- Produces (all pure):
  - `isAvailable(state) -> boolean` (false for missing, `unavailable` or `unknown`).
  - `lightLevel(state) -> 0..100`: `0` when off, else `round(brightness/255*100)`, and `100` for an on light with no brightness.
  - `nextLevel(level, dir, step = 5) -> 0..100`.
  - `volumePct(state) -> 0..100 | null`.
  - `nextVolume(pct, dir, step = 2)`.
  - `nowPlaying(state, haUrl) -> { title: string, artist: string, art: string|null, playing: boolean }`: `art` = `haUrl + attributes.entity_picture` when present.
  - `createThrottle({ intervalMs = 150, now, setTimeout }) -> { push(key, value, send) }`: sends the first value at once, then at most one per interval per key, always ending with the latest value.

- [ ] **Step 1:** Write the failing tests:
  - each helper on representative states, including `unavailable` and missing attributes;
  - the throttle, with a fake clock: 20 pushes within 300 ms send exactly 3 times (t = 0, 150, 300), and the last send carries the last value; two keys don't throttle each other.
- [ ] **Step 2:** Run `npm --prefix panel test`: FAIL.
- [ ] **Step 3:** Implement `entities.js`.
- [ ] **Step 4:** Run the tests: PASS. Commit: `feat(panel): HA entity helpers and knob throttle`.

### Task 4: App shell: presets switch screens

**Files:**
- Modify:
  - `panel/src/input.js` (KEYMAP)
  - `panel/src/main.js` (routes, preset actions, HA status line)
  - `panel/src/screens/helpers.js` (`topbar` gains a screen-dots row)
- Create: `panel/src/shell.js`, `panel/test/shell.test.js`

**Interfaces:**
- Produces:
  - Presets:
    - `1` → `#/home`, `2` → `#/audio`.
    - `3` → Agents (`#/list`); pressed again it cycles `#/list` → `#/usage` → `#/nucbox` → `#/list`. From any other screen it goes to `#/list`.
    - `4` → `#/queue`. On the queue, with a permission as the hero card, `4` keeps its Plan 1 meaning, Deny, so there's no context rule elsewhere.
  - `presetTarget(key, routeName) -> hash | 'deny'`.
  - The boot route is `#/home` when HA is configured, else `#/list`.
  - The waiting alert (edge pulse plus count) and the prompt takeover from Plan 1 apply on every screen, including the new ones.

- [ ] **Step 1:** Write the failing tests for `presetTarget`, covering each key from each screen kind, the 3 cycle through sessions, usage and NucBox, and 4 = deny only on the queue.
- [ ] **Step 2:** Run: FAIL. Implement `shell.js`, wire `KEYMAP` and the presets in `main.js`, and add the screen dots to the top bar (four dots: Home, Audio, Agents, Queue; current one lit).
- [ ] **Step 3:** Run the tests: PASS. Update the Plan 1 screens tests that pinned the old preset meanings, with a ledger ruling. Commit: `feat(panel): presets switch between Home, Audio, Agents and Queue`.

### Task 5: Home screen (lights and scenes)

**Files:**
- Create: `panel/src/screens/home.js`, `panel/test/home.test.js`
- Modify: `panel/src/main.js`, `panel/src/styles.css`

**Interfaces:**
- Consumes: Task 2 client, Task 3 helpers, `HaConfig.home`.
- Produces:
  - `renderHome(state, view) -> html`, where `view = { cursor, adjusting: boolean }`.
  - **Grid:** a 2-row grid of tiles that scrolls sideways (same pattern as the session grid).
    - **Light tile:** name, on/off lamp, level bar.
    - **Scene tile:** name and a "Scene" tag.
  - **Knob, browsing:** moves the cursor.
  - **Press on a light:** toggles it (`light.toggle`).
  - **Hold the top button on a light** (`m-hold`) enters dim mode. The tile enlarges with a big %, the knob runs `nextLevel` through the throttle into `light.turn_on {brightness_pct}` (`turn_off` at 0), and press or back leaves dim mode.
  - **Press on a scene:** `scene.turn_on`, with a toast.
  - Touch taps act like press.
  - **States:**
    - an unavailable entity shows "Unavailable" and ignores input;
    - with no HA config: "Home Assistant isn't set up. Run mac-service/scripts/ha-discover.js on the Mac.";
    - when offline or unauthorized: the plain lines from Review Focus 1.

- [ ] **Step 1:** Write the failing tests:
  - tiles in config order;
  - light level text;
  - exactly one selected tile;
  - the unavailable tile;
  - the three empty or offline states;
  - dim-mode markup shows the % large.
- [ ] **Step 2:** Run: FAIL. Implement and wire it, with the optimistic level shown at once (Review Focus 3).
- [ ] **Step 3:** Run the tests: PASS. Run `npm --prefix panel run build`. Commit: `feat(panel): Home screen for lights and scenes`.

### Task 6: Audio screen (HomePods)

**Files:**
- Create: `panel/src/screens/audio.js`, `panel/test/audio.test.js`
- Modify: `panel/src/main.js`, `panel/src/styles.css`

**Interfaces:**
- Produces:
  - `renderAudio(state, view) -> html`, with `view = { cursor }`.
  - **Layout:** the selected HomePod large on top: artwork (or a plain placeholder), title, artist, play state and a big volume %. Below it is a row of the other HomePods (name and volume).
  - **Knob:** volume of the selected HomePod (`nextVolume` through the throttle, then `media_player.volume_set {volume_level: pct/100}`).
  - **Press:** `media_player.media_play_pause`.
  - **Top-button tap:** `media_next_track`.
  - **Swipe or touch tap on the row:** selects another HomePod.
  - The artwork `<img>` hides itself on error (Review Focus 4).

- [ ] **Step 1:** Write the failing tests:
  - title and artist from attributes;
  - a missing `entity_picture` shows the placeholder, not an `<img>`;
  - "Nothing playing" for `idle`/`off`/`standby`;
  - the volume % text;
  - the unavailable HomePod.
- [ ] **Step 2:** Run: FAIL. Implement and wire it.
- [ ] **Step 3:** Run: PASS. Build. Commit: `feat(panel): Audio screen for HomePods`.

### Task 7: NucBox view

**Files:**
- Create:
  - `panel/src/nucbox.js` (LM Studio poller and pure helpers)
  - `panel/src/screens/nucbox.js`
  - `panel/test/nucbox.test.js`
- Modify: `panel/src/main.js`, `panel/src/styles.css`

**Interfaces:**
- Consumes: Task 2 client, Task 3 `isAvailable`, `HaConfig.nucbox`.
- Produces:
  - `loadedModels(body) -> string[]`: ids of entries in the `/api/v0/models` response whose `state` is `loaded`, excluding `type: "embeddings"`.
  - `createLmPoller({ url, fetch, setTimeout, onChange })`: polls on the Global Constraints schedule; `onChange({ status: 'ok' | 'unreachable', models: string[] })`. `setFast(boolean)` switches between the 5 s and 30 s rates.
  - `nucboxStatus({ lm, states, cfg }) -> { model: string | null, extra: number, busy: 'busy' | 'idle' | 'unknown', cpu, mem, gpu, gpuMem, temps: [{ name, c }], missing: string[] }`:
    - `model` is the first loaded model and `extra` counts the rest;
    - `busy` is `'busy'` when a model is loaded and the GPU load entity reads at or above `cfg.busyGpuPct`, `'idle'` when no model is loaded or the GPU is below it, and `'unknown'` when LM Studio or the GPU entity is unavailable (Review Focus 5);
    - `missing` names what's unreachable, for the plain lines.
  - `renderNucbox(status) -> html`: the model name large at the top, with a quiet "busy" or "idle" tag next to it. Below are four meters (CPU, memory, GPU, GPU memory) and a temperature row. Meters with no entity configured are left out.
  - **Knob:** scrolls the temperature row when it overflows; otherwise does nothing. **Press:** nothing. The view is for looking.
  - With `nucbox: null`: "NucBox isn't set up. See Plan 3 Task 1 Step 5b."

- [ ] **Step 1:** Write the failing tests:
  - `loadedModels` on a fixture with one loaded LLM, one loaded embedding model and two not-loaded models returns the one LLM;
  - `nucboxStatus` for busy (model loaded, GPU 80 %), idle (model loaded, GPU 5 %), idle (no model, GPU 80 %), and unknown (LM Studio unreachable; GPU entity `unavailable`);
  - the poller, with a fake clock and fetch: 5 s and 30 s rates, a timeout reports `unreachable`, and recovery reports `ok`;
  - the render: the model name, "No model loaded", each `missing` line, meters left out when unconfigured;
  - the render contains none of the waiting-alert classes from Plan 1.
- [ ] **Step 2:** Run `npm --prefix panel test`: FAIL. Implement and wire `#/nucbox`. The poller goes fast only while the route is showing.
- [ ] **Step 3:** Run: PASS. Build. Commit: `feat(panel): quiet NucBox view for LM Studio and hardware`.

### Task 8: Simulator: HA config, demo HA, verification

**Files:**
- Modify:
  - `simulator/src/static-server.js`: `/panel-config.js` adds `ha: {url, token, home, audio}` from `HA_CONFIG_PATH`, only for non-cross-site requests (Global Constraints).
  - `simulator/scripts/run.js`: with `SIM_DEMO=1`, start `startMockHa` on `8124` with a demo house (12 lights, 4 scenes, 3 HomePods with artwork data URLs, and NucBox sensors whose GPU load swings between idle and busy every 20 s) and point the config at it. Also serve a mock `/api/v0/models` (one loaded model) on `8125` as the demo `lmstudio` URL.
  - `panel/src/config.js`: `readConfig` passes `ha` through.
- Test: `simulator/scripts/smoke.js`

- [ ] **Step 1:** Add the failing smoke checks:
  - `GET /panel-config.js` with `Sec-Fetch-Site: cross-site` contains no `token` for HA;
  - with `same-origin` and a temp `CLAUDE_PANEL_HA_CONFIG`, it contains the HA URL.
- [ ] **Step 2:** Implement. Run the smoke test: PASS.
- [ ] **Step 3:** Run `SIM_DEMO=1 npm run sim` and take CDP screenshots of Home, dim mode, Audio, and the NucBox view while busy and idle. Check:
  - knob dimming moves the % at once and the mock records at most one call per 150 ms;
  - the presets switch screens, and 3 cycles sessions → usage → NucBox;
  - the NucBox going busy changes nothing on the other screens;
  - a held question from Plan 1 still takes over from the Home screen;
  - nothing overflows.
- [ ] **Step 4:** Commit: `feat(simulator): Home Assistant config and demo house`.

### Task 9: Live check with the owner's Home Assistant

- [ ] **Step 1:** With the owner's `ha.json` in place, run `npm run sim`. Check:
  - **(a)** the owner's lights toggle and dim from the panel;
  - **(b)** the HomePods show what's playing and the knob changes their volume;
  - **(c)** after an HA restart, the panel shows its offline line, then recovers on its own;
  - **(d)** with a model loaded in LM Studio, the NucBox view names it, shows busy during a long generation and idle after, and shows "LM Studio not reachable" when LM Studio's server is stopped. Tune `busyGpuPct` from what the GPU reads at idle and while generating.
- [ ] **Step 2:** Record the results, plus any entity fix-ups made to `ha.json` and the tuned `busyGpuPct`, in the spec under Integrations. Commit: `docs: record Home Assistant verification`.
