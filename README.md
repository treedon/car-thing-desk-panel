# Car Thing desk panel

A Spotify Car Thing turned into a standalone desk control panel, on its own
Linux image over Wi‑Fi, with the knob and buttons as the controls:

- **Agents:** live Claude Code sessions on the Mac (and a Windows PC), with
  their titles, the recent conversation and subagents. Answer permissions,
  questions and plans with the knob, dictate a reply, start a new session,
  and read a digest of the last 24 hours.
- **Queue:** every finished Claude turn, and everything waiting on you, as a
  card.
- **Tasks:** a TickTick list with a focus timer, and new tasks by voice.
- **Home and Audio:** Home Assistant lights, scenes and HomePods.
- **NucBox:** the model LM Studio has loaded on a mini PC, and its CPU, GPU
  and temperatures.

It began as a fork of [claude-thing](https://github.com/rithkott/claude-thing),
which puts Claude Code on the Car Thing through
[Nocturne](https://github.com/usenocturne/nocturne). This one drops Nocturne
and the phone, and runs the panel on
[yocto-superbird](https://github.com/JoeyEamigh/yocto-superbird) instead. See
[Credits](#credits) and [NOTICE.md](NOTICE.md).

**This is one person's desk, shared as is.** It assumes a Mac running Claude
Code. The Home, Audio, Tasks and NucBox screens assume Home Assistant, a
TickTick list and a Windows mini PC (called the NucBox throughout). Leave out
what you don't have. Addresses and tokens live in config files outside the
repo (`~/.config/claude-panel/` on the Mac), never in it.

| Folder | What it is |
|---|---|
| `mac-service/` | Runs on the Mac. Reads Claude Code's sessions and hooks, and serves the panel's WebSocket on port 8790. |
| `panel/` | The screen: a web app for the Car Thing's Chromium 69 at 800×480. |
| `simulator/` | The panel in an on-screen Car Thing on the Mac, with a working knob and buttons. |
| `protocol/` | Every request and event between the panel and the services. |
| `device/` | The Car Thing image: a Yocto layer, provisioning and over-the-air updates. |
| `nucbox/` | The Windows mini PC's services: tasks, LM Studio relay, Claude sessions. |
| `mac/` | Starts the Mac service at login (launchd). |
| `hardware/` | A 3D-printed monitor mount (OpenSCAD), with STL and STEP files. |
| `docs/hardware/` | A pogo-pin dock through a USB-C breakout. |
| `docs/superpowers/` | The spec and plan behind each feature, as written while building it. |

## Setup

Requires Node 22, Google Chrome and Claude Code.

1. Start the Mac service at login:

   ```bash
   ./mac/install.sh
   ```

   Or run it by hand: `npm --prefix mac-service start`.

2. Install the Claude Code hooks. This edits `~/.claude/settings.json` (a backup
   is written next to it), so you run it yourself:

   ```bash
   node mac-service/scripts/install-hooks.js
   ```

   Hooks apply to sessions started afterwards. Without them the panel still
   lists sessions, but permissions and questions are not shown.

3. Optional, for dictation: `./mac-service/scripts/setup-dictation.sh`.

## Run the simulator

```bash
npm run sim             # against your real Claude Code sessions
SIM_DEMO=1 npm run sim  # made-up sessions (one with 22 subagents), a demo house and a demo work list
```

The faceplate opens in a Chrome window. Controls:

| Panel | Keyboard | Mouse |
|---|---|---|
| Knob turn | ← / → | drag or scroll the knob |
| Knob press | Enter | click the knob |
| Back | Esc | the round button |
| Presets | 1 Tasks · 2 Agents (again: usage, NucBox; the digest is the first card on the sessions screen) · 3 Queue (Deny on a permission) · 4 Home (again: Audio) | the top buttons |
| Top button | M: tap = context action, hold = talk / dim / next HomePod | the top-right button |

The simulator uses port 8091. `npm run sim` starts the Mac service if nothing
answers on 8790, and refuses to use anything else it finds there. To point it
at a service on another port, set `SIM_SERVICE_PORT`.

## Home Assistant

The Home and Audio screens talk to Home Assistant directly. Settings live in
`~/.config/claude-panel/ha.json` (mode 600, never in the repo):

```bash
# once: {"url":"http://<ha>:8123","token":"<long-lived token>"} in that file, then
node mac-service/scripts/ha-discover.js          # fills the Home and Audio lists
node mac-service/scripts/ha-discover.js --nucbox <name>   # sensors for the NucBox view
```

Edit `home` and `audio` in the file to choose what each screen shows.

## Tasks

Preset 1 is the TickTick work list. It is served by the NucBox, not the Mac,
so it works with the Mac asleep or away. `nucbox/tasks-service.js` (port
8791) holds a [TickTick Open API](https://developer.ticktick.com/docs#/openapi)
token, reads and writes one list, transcribes what you say with whisper.cpp
on the NucBox, and keeps the focus timer, so a reboot of either end doesn't
lose it.

| On | Knob turn | Knob press | Hold the top button | Back |
|---|---|---|---|---|
| The list | move | open the task (or tap START) | say a new task | — |
| A task | move | Start focus · tick a subtask · Mark task done | say a subtask | the list |
| Start focus | minutes, 5 to 120 in 5s | start | — | the task |
| The timer | — | press twice to stop | — | the list (it keeps running) |
| Time's up | choose | Mark task done · Again · Dismiss | — | dismiss |

- Subtasks are the task's checklist items. Each write reads
  the task fresh first, so a subtask added on the phone a moment ago survives.
  TickTick's free plan allows 19.
- What you say is shown before it's added: press the knob to add it, hold the
  top button to say it again, Back to cancel.
- A running timer shows on every screen, top centre, and keeps the screen lit.
  When it ends the panel opens Time's up (unless a Claude question is on
  screen). The Car Thing has no speaker, so there's no chime.
- Claude dictation (messages, answers) is transcribed on the NucBox too when
  it's set up, and on the Mac only if the NucBox can't.

Set it up once:

1. On the NucBox, run `install.ps1` as under The NucBox below (add
   `-TasksList "<name>"` if the list isn't called Work). It also downloads
   whisper.cpp with its base.en model, and ffmpeg with winget.
2. On the Mac, give it its tokens. This reads your TickTick token from a file
   with a `TICKTICK_TOKEN=…` line, makes the panel's own token, sends both to
   the NucBox over ssh's stdin, and writes `~/.config/claude-panel/tasks.json`:

   ```bash
   MIRROR_ENV=~/path/to/ticktick.env nucbox/push-tasks-secrets.sh <the NucBox's address>
   ```

   Without `MIRROR_ENV` it reads that line over ssh from another machine
   (`MIRROR_SSH`, default `mirror.local`, file `~/.config/mirror/mirror.env`),
   which is where the author's token already lived.

3. Re-provision the Car Thing so it gets `tasks.json`. It then boots onto Tasks.

The simulator reads the same `tasks.json`.

## Claude sessions on the NucBox

Claude Code also runs in VS Code on the NucBox. The same session service runs
there (port 8790), and the panel connects to both: Agents lists the sessions
from both machines (NucBox ones say "NucBox" under their title), and the
queue holds both machines' permissions, questions and plans, each answered on
the machine it came from. With the Mac away, the NucBox's sessions still show.

What's different on the NucBox:

- **No "take me there."** The service runs in the background as you, outside
  the desktop, so it can't raise a VS Code window there. A question only
  VS Code can answer says "Answer on the NucBox".
- **Usage and screen sleep come from the Mac only.** The NucBox's service
  reads neither.
- **Sessions are found through hooks.** Without the `claude` command on the
  NucBox, a session shows once it fires a hook (its next prompt or tool call),
  not before. Installing the Claude Code CLI there lets the service list
  sessions too.

Set it up once:

1. Copy the whole repo to the NucBox (it needs `mac-service/` next to
   `nucbox/`), and run the installer with `-ClaudeSessions`, in an
   administrator PowerShell in `nucbox\`:

   ```powershell
   powershell -ExecutionPolicy Bypass -File install.ps1 -HomeAssistant <HA's address> -ClaudeSessions
   ```

2. Install the hooks as yourself (a normal PowerShell). This edits
   `%USERPROFILE%\.claude\settings.json`, with a backup beside it:

   ```powershell
   node C:\ProgramData\car-thing-panel\sessions\scripts\install-hooks.js
   ```

   They apply to sessions started afterwards. Waking an idle session with a
   dictated message uses a command hook, which Claude Code on Windows runs
   through its Git Bash; that part hasn't been tried on the NucBox yet.

3. On the Mac, fetch the NucBox service's token, then re-provision the Car
   Thing:

   ```bash
   nucbox/push-sessions-token.sh <the NucBox's address>
   ```

The simulator reads the same `~/.config/claude-panel/nucbox-sessions.json`.

## The digest

The digest is what Claude Code did on the Mac in the last 24 hours: a card per
session, newest first and at most 20, with its title, its last reply and what
it did (turns, files, commits, PRs, test runs). It is the first card on the
sessions screen; pressing it opens the full list, where the knob moves between
cards, a press opens that session (an ended one only says so) and Back
returns to the sessions. A card says NEW when its session has done something
since you last spent five seconds on the list.

- **The Mac's sessions only.** The digest runs in the Mac service, not on
  Windows, so the NucBox's service has none, and the panel takes it from the
  Mac alone.
- **Facts only for now.** The cards are counts and quotes read from the
  transcripts. Written summaries wait for the NucBox summarizer (later plans).
- **Kept across restarts** in `mac-service/.state/digest.json`, written at
  mode 0600: it holds excerpts of your prompts and Claude's replies.
- **Off:** start the Mac service with `CLAUDE_PANEL_DIGEST=0`.

## The NucBox

The NucBox view (preset 3, the third press) shows the model LM Studio has loaded
and the NucBox's CPU, memory, GPU and temperatures. It reads two things on the
NucBox:

- `nucbox/lm-relay.js` on port 1235: the list of loaded models, read-only.
  LM Studio's own server has no login, so it stays on localhost.
- LibreHardwareMonitor on port 8085, through Home Assistant's Libre Hardware
  Monitor integration. Its web server can also set fan controls and the
  integration can't log in, so the port answers Home Assistant only.

On the NucBox (Node and LM Studio installed), copy `nucbox/` over and, in an
administrator PowerShell in that folder:

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -HomeAssistant <HA's address>
```

It unpacks LibreHardwareMonitor, sets up the tasks service (see Tasks), starts them at boot or logon, and opens their
ports on Private networks. `uninstall.ps1` undoes it. Those rules are per
port, and Windows allows a connection if any rule does: a rule that already
lets `node.exe` in from anywhere (Homebridge adds one) also opens the relay to
anywhere. LibreHardwareMonitor isn't Node, so 8085 stays Home Assistant only. Then add the Libre
Hardware Monitor integration in Home Assistant (the NucBox's address, port
8085), list its sensors with
`node mac-service/scripts/ha-discover.js --nucbox <name>`, and add a `nucbox`
section to `ha.json`:

```json
"nucbox": {
  "lmstudio": "http://<nucbox>:1235",
  "cpuLoad": "sensor.<…>_cpu_total_load",
  "memory": "sensor.<…>_total_memory_memory_load",
  "gpuLoad": "sensor.<…>_gpu_core_load",
  "gpuMemory": "sensor.<…>_gpu_memory_used_data",
  "gpuMemoryTotal": "sensor.<…>_gpu_memory_total_data",
  "temps": [{ "entity": "sensor.<…>_core_tctl_tdie_temperature", "name": "CPU" }],
  "busyGpuPct": 25
}
```

- `gpuMemoryTotal` is for a GPU that reports memory in MB. Leave it out when
  `gpuMemory` is already a percentage. `--nucbox` lists only %, °C and GB
  sensors, so find the MB ones in Home Assistant.
- `name` is a short label for a temperature. Without it the view shows Home
  Assistant's name.
- Busy means a model is loaded and GPU load is at or above `busyGpuPct`. On
  the 760M, GPU core load sat at 0 with a model loaded and idle, and at 60–97%
  while generating.

Re-provision the Car Thing afterwards so it gets the new `ha.json`.

## The Car Thing image

`device/` builds the image for the Car Thing (yocto-superbird's kiosk image plus
the panel, its recorder, Wi‑Fi for a USB adapter, and key-only SSH). It needs
Colima or Docker, `kas`, `just` and `flashthing-cli` (`cargo install flashthing-cli`;
put `~/.cargo/bin` on your PATH):

```bash
just -f device/Justfile build   # builds the panel too; the zip lands in device/build/deploy
just -f device/Justfile flash   # with 1+4 held while plugging in USB
```

**Updating over Wi‑Fi.** Once the Car Thing is on Wi‑Fi, a new panel or
image doesn't need the cable or the buttons:

```bash
just -f device/Justfile swu                  # the same image as an update bundle
just -f device/Justfile ota 192.168.1.55     # the Car Thing's address
```

The bundle goes to the slot that isn't running (the device has two, A and B),
then the device reboots into it. `/opt/panel` (Wi‑Fi, key, settings) is kept,
so there's nothing to provision again. If the new slot doesn't come up
healthy, the device goes back to the old one by itself.

At boot the USB port powers the hub and the Wi‑Fi adapter. Hold Back while it
boots for USB networking instead: the Mac gets an address on the link and the
Car Thing shows a recovery notice. Its address there is `10.42.1.<n·8+2>`, with n
taken from its serial (the DHCP server in `ipconfig getpacket <if>`), and both
`adb shell` and `ssh root@<it>` with no password get in as root. Settings live
in `/opt/panel`, kept on the bandaid partition across reboots.

**Tethered (no Wi‑Fi yet).** With Back held at boot and the cable to the Mac,
run `device/scripts/provision.sh --tethered` (needs `adb`:
`brew install --cask android-platform-tools`). It points the panel at the Mac
over the cable, and from then on the Car Thing boots tethered without Back.
If a static route on the Mac sends `10.42.1.x` elsewhere (`route -n get <it>`
shows `en0`), the panel still works, but plain `ssh`/`ping` need it removed.

**Wi‑Fi.** Put your `network={…}` block in `~/.config/claude-panel/wifi.conf`,
then `device/scripts/provision.sh <address>` over SSH. That also ends tethered
boots, so the port powers the hub again. After that, SSH over Wi‑Fi takes only
your key.

## The network and the token

The Mac service listens on the LAN so the Car Thing can reach it over Wi‑Fi.
From another machine only `/ws` answers, and only with the token from
`~/.config/claude-panel/token` (`ws://<mac>:8790/ws?token=…`). Hooks, `/status`
and the control page answer this Mac only. `CLAUDE_PANEL_BIND=127.0.0.1` keeps
the service off the LAN entirely.

## Tests

```bash
npm test
npm --prefix mac-service run hook-latency
```

The second starts the Mac service six times on a free loopback port, alternating the agent digest off and on (the on runs catching up on your largest Claude Code transcript), and sends hooks to each back to back for a second and then at 20 a second: it exits 0 with `"verdict":"PASS"` when the digest never held a hook more than 35 ms longer than the digest-off best and its p99 stayed within 10 ms of the digest-off one, 1 with `FAIL` when either rule fails, and 2 with `INCONCLUSIVE` when the catch-up was too short for 20 hooks to overlap it, and a run against your own real transcript (a 54.8 MB one is the case it was sized for) is the check that counts.

## Credits

This stands on other people's work. Thank you to all of them.

**Where it started**

- [rithkott/claude-thing](https://github.com/rithkott/claude-thing): the Car
  Thing as a Claude Code HUD, and the starting point for this project. The
  Mac service, panel, simulator, protocol and the pixel mascot sprites began
  as copies of its daemon, device app, emulator and protocol.
- [Nocturne](https://github.com/usenocturne/nocturne) by
  [usenocturne](https://github.com/usenocturne): the custom Car Thing
  firmware claude-thing extends, and much of what the community knows about
  the device. [Prelude](https://github.com/usenocturne/prelude) shows what
  else the same base can do.
- [srcurran/MacThing](https://github.com/srcurran/MacThing): the reference
  for the Claude usage view.

**On the Car Thing**

- [JoeyEamigh/yocto-superbird](https://github.com/JoeyEamigh/yocto-superbird):
  the Yocto BSP and kiosk image this image is built on.
  [bridgething](https://github.com/JoeyEamigh/bridgething), by the same
  author, was a useful reference.
- [flashthing](https://github.com/JoeyEamigh/flashthing) (`flashthing-cli`)
  to flash it, or [Terbium](https://terbium.app) from a browser.
- The [Yocto Project](https://www.yoctoproject.org) and
  [OpenEmbedded](https://www.openembedded.org), with
  [meta-meson](https://github.com/superna9999/meta-meson),
  [meta-browser](https://github.com/OSSystems/meta-browser) (Chromium) and
  [meta-swupdate](https://github.com/sbabic/meta-swupdate)
  ([SWUpdate](https://github.com/sbabic/swupdate), for A/B updates over
  Wi‑Fi), all pulled in through yocto-superbird.
- [kas](https://github.com/siemens/kas), [just](https://github.com/casey/just)
  and [Colima](https://github.com/abiosoft/colima) to build it on a Mac.
- [usb_modeswitch](https://www.draisberghof.de/usb_modeswitch/) to wake the
  Wi‑Fi adapter.
- [err4o4/spotify-car-thing-reverse-engineering](https://github.com/err4o4/spotify-car-thing-reverse-engineering)
  for its notes on getting the Car Thing onto Wi‑Fi.

**On the Mac and the NucBox**

- [Claude Code](https://claude.com/claude-code): what the panel watches.
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp) and
  [FFmpeg](https://ffmpeg.org) for dictation.
- [Home Assistant](https://www.home-assistant.io) for the Home and Audio
  screens, and its
  [Libre Hardware Monitor integration](https://www.home-assistant.io/integrations/libre_hardware_monitor)
  with [LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor)
  for the NucBox's sensors.
- [LM Studio](https://lmstudio.ai) for the local models the NucBox view
  shows.
- The [TickTick Open API](https://developer.ticktick.com/docs#/openapi) for
  Tasks.
- [ws](https://github.com/websockets/ws), [Vite](https://github.com/vitejs/vite)
  and its legacy plugin, and [terser](https://github.com/terser/terser).

**The mount:** [OpenSCAD](https://openscad.org) to model it and
[FreeCAD](https://www.freecad.org) to export STEP files.

**How it was built:** with [Claude Code](https://claude.com/claude-code) and
the [Superpowers](https://github.com/obra/superpowers) skills. Each feature
went through a written spec and plan before any code; they're in
[docs/superpowers/](docs/superpowers/).

## License

GPL-3.0, the same as claude-thing; see [LICENSE](LICENSE) and
[NOTICE.md](NOTICE.md).

Not affiliated with or endorsed by Spotify or Anthropic. Car Thing is a
Spotify product; Claude and Claude Code are Anthropic's. The pixel mascot is
fan art of the Claude Code mascot, carried over from claude-thing.
