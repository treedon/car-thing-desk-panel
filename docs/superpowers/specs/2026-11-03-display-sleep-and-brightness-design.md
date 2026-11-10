# Display sleep and auto-brightness: design

Date: 2026-11-03
Status: draft for review

## Intent

At the moment the Car Thing's screen is on at full brightness all the time.
The owner wants two things:

1. **Brightness follows the room**, using the Car Thing's ambient light sensor.
2. **The screen sleeps when the Mac does**, but the Car Thing can wake up
   **on its own**, independently of the Mac's screen: when the owner reaches for
   the knob, or when Claude needs an answer.

"When the Mac sleeps" covers both cases (owner: "both"):
- the Mac's **display** turns off while the Mac stays awake;
- the **whole Mac** sleeps.

While the Mac's display is off the Mac still runs, so Claude can still ask for
things, and that is when Claude waking the panel matters. While the whole Mac
sleeps Claude Code is paused too, so only the knob can wake the panel.

## Behaviour

### Brightness

- The backlight follows the room light read from the TMD2772 sensor
  (`/sys/bus/iio/devices/iio:device0/`, see Constraints for which readings work).
- **Changes are gradual** (smoothed over several seconds, with hysteresis), so
  a passing shadow or a lamp switched on briefly does not make it flicker.
- **The range is narrow** (owner: "likely just slight"): in a dark room it is
  only a little dimmer than full. *Builder's call, tunable:* full brightness in a
  bright room, about 60% of full in the dark, with the dark level and the lux
  breakpoints as named constants that the owner can tune on the device.
- No manual brightness control.

### Sleep (backlight off)

The panel goes dark when any of these happens:
- the Mac reports its display turned off;
- the Mac reports it is going to sleep;
- the panel loses the Mac service (the existing liveness check in `ws.js`
  already declares the link dead after a silence) **and the link stays down
  for 2 minutes**. This covers a Mac that slept without a warning, was shut
  down, or a pulled cable or dropped Wi-Fi. *Builder's call:* the 2-minute
  grace keeps a short Wi-Fi or USB blip on an awake Mac from blanking the
  panel under a question. After the grace the panel goes dark **even if an
  ask still shows as waiting**, because no answer can reach the Mac without
  the link, and the panel's store keeps asks across a lost link (so a Mac that
  slept mid-ask would otherwise keep it lit all night). The knob still wakes it.

Asks the Mac service keeps on screen after they time out (`expired` in
`mac-service/src/queue.js`) count as resolved, not waiting. *Builder's call.*

Going dark means **backlight off**. The panel keeps running underneath: the
WebSocket, its state and the queue all stay live, so it can wake instantly.
When the screen is dark it should not paint anything it doesn't have to, but
that is an optimisation, not a requirement.

### Wake

Only these wake the panel (owner: "knob or something from claude", and
nothing else):
- **knob turn or knob press**;
- **from Claude: a permission request, a multiple-choice question, or a plan
  waiting for approval** (`claude.permission.request`, `claude.question.request`,
  and the plan asks that arrive the same way; that is, anything that adds to
  the queue of asks waiting on a human).

Rules:
- **The knob input that wakes the screen is swallowed.** It wakes the screen
  and does nothing else, so a press in the dark can never answer or approve
  anything.
- **Other inputs while dark are ignored entirely**: the preset buttons, the
  top button, Back and the touchscreen. They don't wake it and don't act, so
  nothing is done blind. *Builder's call:* swallow them rather than let them
  through.
- **Claude can only wake it while the Mac is awake** (display off). While the
  Mac sleeps no asks can arrive, and nothing special is needed for that.
- After a Claude wake, the panel shows the ask the way it already does (the
  queue/prompt UI is unchanged).

### Staying awake, and going dark again

- **If the Mac's display is on**, the panel's screen is on. It simply follows
  the Mac, and none of the timers below apply.
- **If the panel woke while the Mac's display is off or the Mac is asleep**,
  it stays lit until **10 minutes** pass with no knob input and no new Claude
  activity (owner: "10 minutes if nothing happens or the mac remains asleep").
  Every knob input and every new ask restarts the 10 minutes.
- **After a Claude wake, the 10 minutes run from when the ask is resolved**
  (answered on the panel, answered elsewhere, or timed out), not from when it
  arrived, so the panel never goes dark under a waiting question. *Builder's
  call, from the conversation:* while any ask is still waiting, the panel does
  not go dark on the timer.
- If the Mac's display comes back on, the panel just follows the Mac (stays
  on). If the Mac's display goes off again while the panel is on, the panel
  goes dark at once, unless a wake rule above is keeping it on (a knob input
  in the last 10 minutes, or a waiting ask). *Builder's call.*

## Goals

- Brightness tracks the room without the owner noticing it change.
- The screen is dark whenever the Mac is asleep or its display is off, unless
  the owner or Claude woke it.
- A waiting Claude ask is never missed because the panel was dark, as long as
  the Mac is awake.
- Waking never acts on input the owner couldn't see.

## Non-goals

- Waking from proximity, the preset buttons, the top button, Back, touch, or
  Home Assistant events (owner: only knob or Claude).
- A manual brightness control or a brightness setting on the panel.
- Waking the Mac from the Car Thing.
- Changing how asks are shown once the panel is awake.

## Anti-goals

- The screen flickers or visibly steps as the room light changes.
- A knob press in the dark answers or approves something.
- The panel goes dark while a Claude ask is still waiting.
- The panel stays lit all night because a Mac state was missed (for example, a
  Mac sleep that the service never reported). The liveness fallback exists for
  this.

## Constraints

- **Panel:** runs in the kiosk's Chrome 69 at 800×480 (see `panel/`). It has no
  direct access to sysfs.
- **On-device helper:** `panel-recorder` (C, `device/panel-recorder/`) runs as
  root, listens on `127.0.0.1:8095` only, and already serves the panel and its
  config. The backlight is `/sys/class/backlight/backlight/brightness`
  (`max_brightness` 160), writable by root.
- **Protocol:** events and requests between the Mac service and the panel are
  documented in `protocol/claude-protocol.md`. Relays forward only
  `claude.`-prefixed topics, so new ones must use that prefix.
- **Sensor (checked 2026-11-03):** at boot the TMD2772's integration time is
  2.73 ms and every channel reads 0. Set to the longest time
  (`in_intensity0_integration_time` = 0.699), the raw channels respond
  (`in_intensity0_raw` about 1400–1900 in a lit room, `in_intensity1_raw` about
  300–400, both falling as the light drops). `in_illuminance0_input` (the
  driver's lux) still reads 0, so the curve is built on the raw channels (or
  the builder fixes the driver's lux via its `lux_table`/`calibrate`
  attributes). Whatever reads the sensor sets the integration time itself at
  start, since it resets on boot. No kernel or image work is expected for the
  sensor.
- **The Mac can't announce every sleep.** Clamshell, forced sleep and power loss
  may not give the service a chance to send anything, hence the liveness
  fallback.
- **Tethered and Wi-Fi both:** the Mac link may be the USB cable (see the
  tethered mode in the README) or Wi-Fi. Nothing here may depend on which.
- Tests run with `npm test` (Mac service, panel, simulator smoke, device
  scripts and the recorder's C tests). New logic comes with tests there.
- The simulator (`npm run sim`) has no light sensor or backlight. It should
  still run. *Builder's call:* how it shows "dark" (dim the faceplate, or a log
  line).

## Decided approach

These are the builder's calls unless marked as the owner's.

- **Where the rules live: the panel.** The panel already sees knob input, the
  ask queue and the Mac link. A small, pure state machine in `panel/src/`
  (inputs: Mac display/sleep state, link alive/dead, knob input, asks
  waiting/resolved, time; output: screen on/off) keeps the rules testable
  without the device.
- **Mac state: the Mac service.** It watches the Mac's display power and
  system sleep (for example through IOKit power notifications via a small
  helper, or by polling `pmset` / `ioreg`; the builder picks), pushes a new
  `claude.`-prefixed event when either changes, and returns the current state
  on request so a reconnecting panel learns it at once. It also tries to send
  "going to sleep" before the Mac sleeps.
- **Device side: `panel-recorder`.** It gets two small loopback endpoints: one
  to set the backlight (on/off and a level) and one to read the room light.
  *Builder's call:* whether the smoothing and the lux-to-level curve run in the
  recorder or in the panel. Keeping the curve in the panel keeps it next to the
  sleep rules and in JavaScript tests; keeping it in the recorder means the
  screen still adjusts if the panel hangs.
- **Fades** between dark and lit: a short fade rather than a hard cut,
  *builder's call*, as long as waking feels instant (well under half a
  second to visible).

## Left to the builder

- How the Mac service detects display-off and sleep, and the exact event names
  and shapes (documented in `protocol/claude-protocol.md`).
- The smoothing method, hysteresis and light-level breakpoints (named, tunable constants).
- Where the brightness curve runs (panel or recorder; see above).
- How dark the panel draws when the backlight is off, and the simulator's
  stand-in for the backlight and sensor.
