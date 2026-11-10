# Display Sleep and Auto-Brightness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Car Thing's screen follows the room light, goes dark when the Mac's display is off or the Mac sleeps, and wakes only for the knob or a Claude ask.

**Architecture:**
- The Mac service watches display and sleep through a small Swift helper and pushes `claude.mac.power`.
- `panel-recorder` on the device gains two loopback endpoints, one to read the light sensor and one to set the backlight.
- The panel holds two pure modules, the sleep rules (`screen-power.js`) and the brightness curve (`brightness.js`). `main.js` wires them to input, the WebSocket and the recorder.

**Tech Stack:**
- Node 22 (`node --test`) for the Mac service and the panel.
- Plain ES5-style JS for the panel, because the kiosk runs Chrome 69.
- C for `panel-recorder` (`make test` covers its pure core).
- Swift for the macOS helper, via `swiftc` from the Command Line Tools.

**Spec:** `docs/superpowers/specs/2026-11-03-display-sleep-and-brightness-design.md`

## Global Constraints

- **Wake inputs:** only a knob turn (`dial` from the wheel) or a knob press (`select`, Enter). Presets, the top button (`m`), Back (Escape) and touch neither wake the screen nor act while it is dark.
- **The waking knob input is swallowed.** Any knob ticks within `WAKE_SWALLOW_MS = 500` after it are swallowed too.
- **Staying awake:** while the Mac's display is off or the Mac is asleep, the screen stays lit for `AWAKE_MS = 600000` (10 min) after the last knob input. After a Claude wake the 10 minutes run from when the last waiting ask resolves. It never goes dark on that timer while a non-expired ask is waiting.
- **Lost link:** the screen goes dark once the link has been down for `LINK_GRACE_MS = 120000` (2 min), even with asks showing. The knob still wakes it.
- **Mac display on:** the screen follows the Mac and no timers apply.
- **Expired asks** (`ask.expired === true` in the panel store) count as resolved.
- **Brightness:** the level runs from `DARK_LEVEL = 0.6` up to `1.0`. It's gradual and has no manual control. Every breakpoint is a named, tunable constant.
- **Sensor:** `/sys/bus/iio/devices/iio:device0/`. Set `in_intensity0_integration_time` to `0.699` at start, and read `in_intensity0_raw` and `in_intensity1_raw`. The driver's lux reading (`in_illuminance0_input`) reads 0, so don't use it.
- **Backlight:** `/sys/class/backlight/backlight/brightness`, with its maximum read from `max_brightness` (160).
- **Recorder access:** it listens on `127.0.0.1:8095` only.
- **Protocol:** new topics must start with `claude.`, because relays forward only that prefix. Document them in `protocol/claude-protocol.md`.
- **Tests:** `npm test` from the repo root must pass at the end of every task.

## Review Focus

1. **A knob turn in the dark** sends a burst of `dial` ticks. Only the screen should wake. No list should scroll, so ticks within 500 ms of the wake are swallowed (Task 3 test).
2. **The Mac sleeps with an ask pending.** The panel's store keeps the ask and the link goes silent. The screen must go dark 2 minutes after the link drops, not stay lit all night (Task 3 test).
3. **The recorder is missing or down** (the simulator, or a crashed service). Sleep still works through the black overlay, brightness stays where it was, and nothing throws or floods the console (Task 5 test with a failing fetch).
4. **The Mac service restarts while the display is off.** The panel must learn the state on reconnect, so `claude.mac.power` is sent on every client hello (Task 2 test).
5. **A sensor read fails or a reading is garbage** (empty, a non-number, saturated at 65535). The brightness keeps its last level and never drops to 0 (Task 4 test, and the Task 1 parse test).

---

### Task 1: `panel-recorder` reads the light sensor and sets the backlight

**Files:**
- Modify: `device/panel-recorder/recorder_core.h`, `device/panel-recorder/recorder_core.c` (pure helpers)
- Modify: `device/panel-recorder/main.c` (two routes, sensor setup at start; the header comment lists the new routes)
- Test: `device/panel-recorder/test/test_core.c`

**Interfaces:**
- Produces (HTTP, loopback):
  - `GET /light` returns `200 application/json {"ch0":<int>,"ch1":<int>}`, or `503` when the sensor can't be read.
  - `POST /backlight?permille=<0..1000>` returns `204`. A missing or bad value returns `400`.
- Produces (C, pure):
  - `int rc_parse_permille(const char *request_line)` returns 0..1000, or -1. It is given the request's first line, e.g. `"POST /backlight?permille=600 HTTP/1.1"`.
  - `int rc_backlight_value(int permille, int max)` returns `round(max*permille/1000)` clamped to 0..max. Any permille above 0 maps to at least 1, so "on" is never black.
  - `int rc_parse_raw(const char *text)` returns the sysfs integer, or -1 for empty, non-numeric or negative text.

- [ ] **Step 1: Write the failing tests** in `test_core.c`, in its existing style:
  - `rc_parse_permille("POST /backlight?permille=600 HTTP/1.1") == 600`
  - `rc_parse_permille("POST /backlight?permille=0 HTTP/1.1") == 0`
  - `rc_parse_permille("POST /backlight?permille=1001 HTTP/1.1") == -1`
  - `rc_parse_permille("POST /backlight HTTP/1.1") == -1`
  - `rc_parse_permille("POST /backlight?permille=abc HTTP/1.1") == -1`
  - `rc_backlight_value(1000,160) == 160`, `rc_backlight_value(600,160) == 96`, `rc_backlight_value(0,160) == 0`, `rc_backlight_value(1,160) == 1`
  - `rc_parse_raw("1927\n") == 1927`, `rc_parse_raw("") == -1`, `rc_parse_raw("x") == -1`
- [ ] **Step 2:** Run `make -s -C device/panel-recorder test`. Expected: it fails to compile, because the functions are undefined.
- [ ] **Step 3:** Implement the three functions in `recorder_core.c`.
- [ ] **Step 4:** Wire `main.c`:
  - At start, write `0.699` to the integration-time file. Log on failure and carry on.
  - The `/light` route reads both raw files and uses `rc_parse_raw`. If either read fails, it returns 503.
  - The `/backlight` route reads `max_brightness` once at start (falling back to 160), then writes `rc_backlight_value`.
  - Put the paths in `#define`s next to the existing ones. Match on `"GET /light "` and `"POST /backlight"`, before the static `GET /` branch.
- [ ] **Step 5:** Run `make -s -C device/panel-recorder test`. Expected: all ok. Then run `npm test` and expect it to exit 0.
- [ ] **Step 6:** Commit with `feat(recorder): light sensor and backlight endpoints`.

### Task 2: The Mac service reports display and sleep state

**Files:**
- Create: `mac-service/native/power-watch.swift`. It prints one line per change to stdout: `display off`, `display on`, `will sleep`, `did wake`. It uses `NSWorkspace.shared.notificationCenter` (`screensDidSleepNotification`, `screensDidWakeNotification`, `willSleepNotification`, `didWakeNotification`) and runs with `RunLoop.main.run()`. Flush after every line.
- Create: `mac-service/src/mac-power.js`
- Modify: `mac-service/src/index.js`. Create the watcher, emit on change, and add `claude.mac.power` to `onHello` next to `claude.queue.sync`.
- Modify: `protocol/claude-protocol.md`. Add the event row, and note that it is also sent on every hello.
- Test: `mac-service/test/mac-power.test.js`

**Interfaces:**
- Produces (JS):
  - `createMacPower({ onChange, spawnHelper })` returns `{ get(): {display:'on'|'off', sleeping:boolean}, feed(line:string): void, start(): void }`.
  - `spawnHelper()` returns a child-process-like object with a `stdout` stream. It defaults to compiling and running the helper.
  - `feed` is the line parser, exposed for tests. It starts at `{display:'on', sleeping:false}`.
  - `did wake` sets `sleeping:false` and leaves `display` alone.
  - Unknown lines are ignored.
  - `onChange(state)` fires only when the state actually changes.
- Produces (protocol): the event `claude.mac.power` `{display:'on'|'off', sleeping:boolean}`.
- Compiling: `ensureHelper()` runs `swiftc -O` from `mac-service/native/power-watch.swift` to `~/.cache/claude-panel/power-watch` when the binary is missing or older than the source.
- If compiling or spawning fails, log once and keep the default state. The panel's link-loss rule still covers a sleeping Mac.
- If the helper exits, respawn it after 5 s.

- [ ] **Step 1: Write the failing tests** in `mac-power.test.js`:
  - The state starts as `{display:'on', sleeping:false}`.
  - `feed('display off')` makes it `{display:'off', sleeping:false}` and calls `onChange` once.
  - Feeding `display off` again calls `onChange` no more times.
  - `feed('will sleep')` sets `sleeping:true`. Then `feed('did wake')` sets `sleeping:false`, and `display` is still `'off'` until `feed('display on')`.
  - `feed('garbage')` changes nothing.
  - With a fake `spawnHelper`, writing `"display off\nwill sl"` and then `"eep\n"` to its stdout yields two changes. Lines split across chunks must be handled.
- [ ] **Step 2:** Run `npm --prefix mac-service test`. Expected: it fails because `mac-power.js` doesn't exist.
- [ ] **Step 3:** Implement `mac-power.js` and `power-watch.swift`, and wire `index.js`. Emit `hub.emit('claude.mac.power', state)` on change and in `onHello`.
- [ ] **Step 4:** Run `npm --prefix mac-service test` and expect it to pass. Manually, run `swiftc -O mac-service/native/power-watch.swift -o /tmp/pw && /tmp/pw`, then run `pmset displaysleepnow`. Expected: it prints `display off`, and `display on` after a key press.
- [ ] **Step 5:** Run `npm test` from the root and expect exit 0. Commit with `feat(mac-service): report the Mac's display and sleep state`.

### Task 3: The panel's sleep rules (`screen-power.js`)

**Files:**
- Create: `panel/src/screen-power.js` (pure, no DOM)
- Test: `panel/test/screen-power.test.js`

**Interfaces:**
- Produces: `createScreenPower({ now, awakeMs = 600000, linkGraceMs = 120000, swallowMs = 500 })`, which returns:
  - `macPower({display, sleeping})`: the latest Mac state.
  - `linkUp()` / `linkDown()`: the link to the Mac service. `linkDown` records when the link dropped. Both are idempotent.
  - `asks(waiting: number)`: the count of non-expired asks.
    - An increase from the previous count wakes the screen.
    - A drop to 0 starts `awakeMs` from now.
  - `knob(): boolean`: call it on every knob input. It returns `true` when the input must be swallowed: the screen was dark, or it woke less than `swallowMs` ago. Either way it marks knob activity, so `awakeMs` restarts.
  - `isOn(): boolean`. Evaluate it in this order:
    1. **Link down for at least `linkGraceMs`:** on only within `awakeMs` of the last knob input. Asks are ignored.
    2. **Mac active** (link up, or down for less than the grace period, with `display === 'on'` and `!sleeping`): on.
    3. **Otherwise:** on while a non-expired ask is waiting, or within `awakeMs` of the later of the last knob input and the moment the last ask resolved.
  - **At boot**, before any `macPower` arrives, treat the Mac as active, with the link counted as down from creation. So the screen is lit for at most the grace period if the Mac never answers.

- [ ] **Step 1: Write the failing tests** with a fake clock `t`. Each case is one `test()`:
  - `mac display on, link up → on`
  - `display off → off at once when no knob within 10 min and no asks`
  - `knob while dark → knob() returns true and isOn() becomes true`
  - `knob ticks 499 ms after a wake are swallowed, at 501 ms they are not`
  - `knob wake: still on at 599999 ms, off at 600001 ms after the last knob`
  - `each knob input restarts the 10 minutes`
  - `ask arrives while display off → on; stays on 30 min later while still waiting`
  - `ask resolves (asks(0)) → off 10 min after resolution, not after arrival`
  - `display goes off within 10 min of a knob input → stays on until those 10 min pass`
  - `link down with an ask waiting → still on at 119 s, off at 121 s` (Review Focus 2)
  - `link down past grace, then knob → on for 10 min, then off`
  - `boot with no Mac state → on, off at 121 s if the link never comes up`
  - `sleeping:true with display on → treated as off`
- [ ] **Step 2:** Run `npm --prefix panel test`. Expected: it fails because the module doesn't exist.
- [ ] **Step 3:** Implement `screen-power.js` in the panel's ES5 style (`var`, no arrow functions).
- [ ] **Step 4:** Run `npm --prefix panel test` and expect it to pass. Commit with `feat(panel): screen sleep rules`.

### Task 4: The panel's brightness curve (`brightness.js`)

**Files:**
- Create: `panel/src/brightness.js` (pure)
- Test: `panel/test/brightness.test.js`

**Interfaces:**
- Produces: `createBrightness({ now, darkLevel = 0.6, darkRaw = 30, brightRaw = 1500, tauMs = 8000, stepMin = 0.03 })`, which returns:
  - `reading(ch0: number)`: one sensor sample. Ignore it unless it's a finite number from 0 to 65534. 65535 means saturated, so treat it as `brightRaw`.
  - `level(): number` is in `[darkLevel, 1]`.
    - Smooth with an exponential moving average over time, with time constant `tauMs`. `now` gives the time between readings.
    - Map the smoothed value on a log scale: at or below `darkRaw` gives `darkLevel`, at or above `brightRaw` gives `1`.
  - `next(): number | null` returns the permille to send, or `null` when it is within `stepMin` of the last value sent. This is the hysteresis. The first call always returns a value.
  - Before the first valid reading, `level()` is `1`.
- These constants are starting values. Task 6 tunes them on the device and records the final values in the constants and in the README.

- [ ] **Step 1: Write the failing tests:**
  - `no readings → level 1`
  - `steady 5000 → level 1; steady 10 → level 0.6`
  - `a single dark sample in a bright room moves the level by less than 0.05` (smoothing)
  - `after 5×tauMs of darkness the level is within 0.01 of 0.6`
  - `NaN, -1, undefined and '' readings leave the level unchanged` (Review Focus 5)
  - `65535 counts as bright`
  - `next() returns null for changes under 0.03, then a permille once the change reaches it`
  - `level never leaves [0.6, 1]`
- [ ] **Step 2:** Run `npm --prefix panel test`. Expected: it fails.
- [ ] **Step 3:** Implement `brightness.js`.
- [ ] **Step 4:** Run `npm --prefix panel test` and expect it to pass. Commit with `feat(panel): brightness from the room light`.

### Task 5: Wire sleep and brightness into the panel

**Files:**
- Create: `panel/src/display.js`. This is the glue, so `main.js` only calls it.
- Modify: `panel/src/input.js`
  - Add `setGate(fn)`. `fire(action, arg, source)` calls `gate(action, source)` first and drops the action when it returns `false`.
  - `source` is `'knob'` for wheel and Enter, `'touch'` for the drag callback and taps, and `'key'` otherwise.
  - Taps: in the existing `document` `click` listener, stop the event and return when the gate refuses `('tap','touch')`.
- Modify: `panel/src/main.js`
  - Create the display.
  - Feed it `claude.mac.power`, link up (`daemonAlive`) and link down (`ws.onClose` and the liveness timeout path), plus the non-expired ask count after every store update.
- Modify: `panel/src/styles.css`. Add `#screen-dark`: fixed, inset 0, black, top z-index, `opacity` transition 1 s, and `pointer-events: none` when hidden.
- Modify: `panel/index.html` (or wherever the shell markup lives). Add `<div id="screen-dark">`.
- Test: `panel/test/display.test.js`

**Interfaces:**
- Consumes:
  - `createScreenPower` (Task 3) and `createBrightness` (Task 4).
  - Recorder routes `GET /light` and `POST /backlight?permille=` (Task 1).
  - The event `claude.mac.power` (Task 2).
- Produces: `createDisplay({ recorder: string|null, fetchImpl, now, setTimer, overlay })`, which returns:
  - `gate(action, source): boolean`
  - `macPower(s)`, `linkUp()`, `linkDown()`, `asks(n)`
  - `tick()`, called every 1 s by `main.js`.
  - `overlay` is `{ show(): void, hide(): void }`. `main.js` passes the `#screen-dark` element's controls, and tests pass a fake.
- Behaviour:
  - `gate`: a `'knob'` source calls `power.knob()` and returns `!swallowed`. Any other source returns `power.isOn()`.
  - Lit to dark: `overlay.show()` at once (it fades for 1 s), then `POST /backlight?permille=0` after 1 s.
  - Dark to lit: `POST` the current brightness permille, then `overlay.hide()` with no fade, so waking feels instant.
  - While lit, every 2 s: `GET /light`, feed `ch0` to brightness, and `POST` `next()` when it isn't null.
  - If `recorder` is null or a fetch fails, skip the backlight and sensor. Log the first failure only; the overlay alone still darkens the screen. Retry the sensor on the next 2 s tick.

- [ ] **Step 1: Write the failing tests** with a fake fetch and clock:
  - `gate('dial','knob') while lit → true; while dark → false, and the screen is then lit`
  - `gate('preset','key') and gate('tap','touch') while dark → false and the screen stays dark`
  - `going dark shows the overlay, then posts permille=0 after 1 s`
  - `waking posts a non-zero permille before hiding the overlay`
  - `recorder null → no fetch calls; sleep still toggles the overlay`
  - `fetch rejects → no throw; console.warn at most once over 10 ticks` (Review Focus 3)
  - `light reading 10 for a long time → a POST with permille 600`
- [ ] **Step 2:** Run `npm --prefix panel test`. Expected: it fails.
- [ ] **Step 3:** Implement `display.js`, the `input.js` gate and the `main.js` wiring.
- [ ] **Step 4:** Run `npm --prefix panel test` and expect it to pass. Run `npm test` from the root and expect exit 0, which includes the simulator smoke run.
- [ ] **Step 5:** In the simulator, run `npm run sim`, then `pmset displaysleepnow` on the Mac. Expected: the faceplate fades to black. Pressing ← wakes it without moving the selection, and pressing 1 while dark does nothing.
- [ ] **Step 6:** Commit with `feat(panel): sleep with the Mac, wake on the knob or Claude, follow the room light`.

### Task 6: On the device: build, flash, tune

**Files:**
- Modify (tuning only): the constants in `panel/src/brightness.js`
- Modify: `README.md`. Add a short "Sleep and brightness" section covering what wakes it, the 10 minutes, the 2-minute link grace, and where the tuning constants live.

- [ ] **Step 1:** Run `just -f device/Justfile build`. Expected: exit 0 and a new zip in `device/build/deploy`.
- [ ] **Step 2 (owner at the device):** hold 1+4 while plugging in USB with the hub disconnected. Then run `PATH="$HOME/.cargo/bin:$PATH" just -f device/Justfile flash`. Expected: `done!`.
- [ ] **Step 3 (owner):** boot with Back held, then run `device/scripts/provision.sh --tethered`. Expected: the Mac's `/status` shows `"panel":1`.
- [ ] **Step 4:** Check the endpoints over ADB:
  - `adb shell wget -qO- http://127.0.0.1:8095/light` returns JSON with a non-zero `ch0` in a lit room.
  - `adb shell 'wget -qO- --post-data= "http://127.0.0.1:8095/backlight?permille=600"; cat /sys/class/backlight/backlight/brightness'` shows `96`.
- [ ] **Step 5:** Tune `darkRaw` and `brightRaw` with the owner:
  - Log `ch0` from `/light` with the room lights off, dim and full.
  - Set the constants so dark gives about 0.6 and the normal daytime room gives 1.
  - The rootfs is read-only squashfs, so the tuned panel needs a second `build` and flash, repeating Steps 1–3.
- [ ] **Step 6:** Run `pmset displaysleepnow` on the Mac. Expected: the Car Thing goes dark within about 2 s. A knob turn wakes it without acting.
  - Trigger a permission prompt in a Claude session while the Mac's display is off. Expected: it wakes.
  - Put the Mac to sleep with `pmset sleepnow`. Expected: it goes dark.
- [ ] **Step 7:** Run `npm test` and expect exit 0. Commit with `feat(device): tune brightness; docs: sleep and brightness`.
