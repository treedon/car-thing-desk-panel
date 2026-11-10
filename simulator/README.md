# Simulator

Shows the panel inside an on-screen Car Thing on the Mac: the 800×480
screen, the four preset buttons, the top-right button, the dial (turn and
press) and Back. It serves the built panel (`panel/dist`) and points it at the
Mac service, so you can work on the panel without the device.

It started as claude-thing's emulator
([rithkott/claude-thing](https://github.com/rithkott/claude-thing), `emulator/`).
The Nocturne firmware extraction, the simulated phone and the mock nocturned
server are gone; see [NOTICE.md](../NOTICE.md).

## Usage

From the repo root:

```bash
npm run sim             # against your real Claude Code sessions
SIM_DEMO=1 npm run sim  # made-up sessions, house and task list
```

`npm run sim` builds the panel, starts the Mac service if nothing answers on
its port, and opens the faceplate in a Google Chrome window. Keys: `1`–`4`
for the presets, `M` for the top button, `Enter` to press the dial, `Escape`
for Back, `←`/`→` to turn the dial. With the mouse, click the buttons, drag
or scroll the dial to turn it, click it to press, hold to long-press.

Other commands: `npm --prefix simulator start` (the server alone, in the
foreground, serving the last build) and `npm --prefix simulator run smoke`
(checks the server).

Logs: `simulator/logs/ws.log`.

## How close it is to the device

- **Legacy JS chunks.** The served page runs the `@vitejs/plugin-legacy`
  (Chrome 69 / SystemJS) bundles, the code path the device's Chromium 69
  runs, not the modern module build.
- **Device-class speed.** Chrome's V8 heap is capped and the renderer is
  CPU-throttled over the DevTools protocol, to approximate a Cortex-A53 at
  1.8 GHz with 512 MB of shared RAM.
- **40 ms button polling.** The device's buttons go through the kernel's
  `gpio-keys-polled` driver at 40 ms, so press and release times are
  quantized and a tap shorter than one poll is dropped. The faceplate samples
  its buttons the same way. The dial is event-driven on the device and is not
  quantized here either.
- **True scale.** The 3.97" 800×480 panel is 86.4 mm wide, so 9.259 px/mm
  (`--mm` in `shell/faceplate.css`, mirrored by `FACE_W/H` in
  `src/config.js`). The 117×64 mm face becomes 1083×593 px. The ⌀36 mm dial
  sits top right and overhangs the face's right edge by about 8.5 mm, as on
  the real unit; Back (⌀10.6 mm) is below it near the corner. Clicks in the
  dial's square corners fall through to the screen.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `SIM_DEMO` | off | `1` = made-up sessions, Home Assistant, LM Studio and tasks |
| `SIM_PORT` | `8091` | the simulator's own port |
| `SIM_SERVICE_PORT` | `8790` | the Mac service's port |
| `SIM_FAKE_MIC` | off | `1` = Chrome's synthetic microphone, for dictation tests |
| `EMU_CPU_THROTTLE` | `8` | CPU throttle factor. `0` turns it off for fast iteration |
| `EMU_JS_HEAP_MB` | `200` | V8 heap cap in MB. `0` = uncapped |
| `EMU_INPUT_POLL_MS` | `40` | button polling. `0` = instant |
| `EMU_FORCE_LEGACY` | on | `0` = serve the modern module build instead |
| `EMU_CDP_PORT` | `9223` | Chrome's remote-debugging port, used for throttling |
| `EMU_CHROME_BIN` | — | another browser binary, launched with the same flags |

## Known limitations

- The JS code path matches the device, but the engine is still modern
  Chrome: a DOM or CSS feature the device lacks won't fail here. Try changes
  on the device before relying on them.
- The CPU throttle is duty-cycle based and the heap cap covers V8's old space
  only, not DOM, GPU or image memory. It's an approximation: no GPU, thermal
  or swap model.
- ProMotion Macs run `requestAnimationFrame` at up to 120 Hz; the panel runs
  at 60 Hz.
- Synthetic events carry `isTrusted: false`.
- Mouse drags on the screen are mouse events, not touch.
