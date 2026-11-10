# Car Thing Home Panel — Design

Date: 2026-11-01
Status: draft for review

## Intent

Turn a Spotify Car Thing into a dedicated control panel mounted on the owner's desk, in a custom stand. **It lives on the home network by itself.** No computer or phone is plugged into it or needed for it to work. (The owner: "mostly i want it to exist on the network without a directly attached companion pc.")

It runs the owner's own apps:
- smart home controls
- HomePod control
- a monitor for Claude Code sessions running on the owner's Mac, including answering those sessions' questions from the panel
- a quiet monitor for local AI models on the owner's NucBox (added 2026-11-02)

Full use of the hardware inputs is a requirement, not a nice-to-have: rotary knob, knob press, four preset buttons, the extra top button, back button, and touchscreen.

## Goals

- The Car Thing boots straight into the owner's apps and joins home Wi-Fi on its own.
- Small background services elsewhere on the LAN are fine, such as one on the Mac for the agent monitor. Nothing is attached to the Car Thing except power.
- Smart home and HomePod control go through the owner's existing Home Assistant.
- **Agent monitor:**
  - see active Claude Code sessions on the Mac
  - **answer permission requests, multiple-choice questions and plan approvals on the display**, through Claude Code hooks (see Integrations)
  - **speak a reply** (owner's request, 2026-11-02): hold to talk, transcribed on the Mac, then sent as a question answer, plan feedback, or a message to the session
  - when a prompt is waiting, **make it visually obvious** on every app screen
- **NucBox monitor** (owner's request, 2026-11-02): at a glance, which model LM Studio has loaded (or none), whether it's busy, and the NucBox's CPU, memory, GPU and temperatures. Quiet: it never alerts.
- The knob does real work on every screen, not just volume.

## Non-goals (for this version)

- **Bed control (removed 2026-11-02).** The owner controls the Eight Sleep from several other devices; the panel doesn't need it.
- **CarPlay (deferred).** It was explored in depth (see Future: CarPlay). The owner wants the standalone network panel first.
- Running Apple Music or Podcasts on the Car Thing. Podcasts is Apple-platform-only, and Apple Music's web player needs DRM this hardware can't do.
- Choosing what to play on HomePods from the panel. Controlling what's already playing is in scope; starting new content is a stretch goal.
- A speaker or audio output in the stand.
- Running on the stock Spotify firmware.

## Anti-goals (would make it a failure even if it "works")

- The panel needs a computer or phone attached, or nearby, to boot or be useful.
- A waiting agent prompt goes unnoticed while an app screen is showing.
- An agent prompt stalls a Claude session because the panel is off or slow.

## Existing environment

- **Home Assistant** on a Raspberry Pi on the LAN, already in use.
- **Eight Sleep pod running opensleep** ([LiamSnow/opensleep](https://github.com/LiamSnow/opensleep), MQTT-based). Already installed and connected to Home Assistant, and to the owner's separate "mirror" project.
- **HomePods** are the usual audio destination.
- **Mac** runs the owner's Claude Code sessions.
- **NucBox**, the owner's Windows 11 PC on the LAN. It runs local models in **LM Studio**, which the NucBox monitor watches.
- Nothing has been built yet, and this folder isn't a git repo yet.

## Decided approach

### Platform: yocto-superbird kiosk

- **Base:** [JoeyEamigh/yocto-superbird](https://github.com/JoeyEamigh/yocto-superbird) (MIT), forking its `meta-superbird-kiosk-example` layer.
  - Mainline kernel and mainline u-boot.
  - Yocto/KAS build, which runs on macOS via Docker.
  - Flashed with [flashthing-cli](https://github.com/JoeyEamigh/flashthing) or [terbium.app](https://terbium.app).
  - A/B OTA updates and SSH in the dev image.
  - The kiosk is Chromium on Weston, loading a local web page, with a minimal daemon.
  - Actively maintained.
- **Why this base:**
  - It needs no phone, no companion, and no Spotify.
  - All inputs are already mapped.
  - It's the same base [Prelude](https://github.com/usenocturne/prelude) builds on, so CarPlay can be added later without starting over.
- **Rejected alternatives:**
  - Mira and Nocturne are Spotify products that expect a phone or a Pi bridge.
  - bridgething assumes a phone over Bluetooth.
  - PlayThing replaces Linux with Android 9.
  - Thing Labs is tooling only.
  - MacThing and claude-thing tether the Car Thing to a Mac.
- **Inputs as delivered (verified in yocto-superbird's DTS and udev rules):**

  | Input | Arrives as |
  |---|---|
  | Four preset buttons | `KEY_1`–`KEY_4` |
  | Extra top button | `KEY_M` |
  | Back | `KEY_ESC` |
  | Knob press | `KEY_ENTER` |
  | Knob turn | `REL_HWHEEL`, routed through libinput so Chromium sees horizontal `wheel` events |
  | Touch | standard touch events |

  A native daemon can also read `/dev/input/event*` directly.

### Networking: USB Wi-Fi adapter, Car Thing as a normal Wi-Fi client

- **Wiring:** the Car Thing's only USB-C port runs in **host mode**, powered through a small **powered USB-2 OTG (charge-through) hub** in the stand (not a USB-C PD dock; see Plan 2 research findings), with a **USB Wi-Fi adapter** on the hub.
  - Prelude and PlayThing both run this arrangement on real hardware.
  - yocto-superbird ships a `superbird-usb-role` helper for switching to host mode.
- **Behavior:** the Car Thing joins home Wi-Fi with wpa_supplicant (or similar) and gets an address from the home router like any other device.
- **Builder must add:** the Wi-Fi driver and firmware to the image. yocto-superbird's base doesn't enable USB Wi-Fi drivers. Prelude's `image/meta-prelude/recipes-kernel/linux/linux-superbird/prelude-wireless.cfg` and its `linux-firmware` bbappend show exactly which options and firmware packages are needed.
- **Adapter:** the owner is considering the **TP-Link Archer TX10UB Nano** (AX900 + BT 5.3).
  - Believed, but not verified, to be Realtek RTL8851BU (mainline `rtw89_8851bu`).
  - Its Bluetooth half must be disabled or ignored so it doesn't compete with the Car Thing's own Bluetooth.
  - A MediaTek (mt76) adapter is the safer Linux choice.
  - Client mode is all this version needs. **If CarPlay may come back, prefer an adapter that can also run an access point.**
  - Final pick is the builder's, confirmed in Milestone 0.
- **The ESP32 is dropped.** It's still a technically viable route, but more custom than a Linux-supported adapter: ESP32-S3 running ESP-IDF's `tusb_ncm` example, with the Car Thing in host mode, at roughly a few Mbit/s, unproven ([err4o4 notes](https://github.com/err4o4/spotify-car-thing-reverse-engineering/blob/main/esp32-wifi-ncm/ESP32_WiFi.md)). The builder may revisit it only if the hub-plus-adapter route fails.
- **Recovery:**
  - The dev image keeps SSH over Wi-Fi.
  - USB burn mode (hold presets 1 + 4 while powering on) is the last resort for reflashing.
  - When the hub is attached the USB port is in host mode, so there is no USB gadget networking for debugging. The builder should keep a way to boot into gadget mode, as Prelude does with "hold Back at power-on".

### The owner's apps

- A single web app shown full-screen by the kiosk at 800×480.
- **Initial screens:**
  - **Home:** Home Assistant lights, scenes, and other entities.
  - **Audio:** HomePods, showing what's playing (title, artwork) with play/pause, skip, and per-HomePod volume.
  - **Agents:** Claude Code sessions, Claude usage, and the NucBox view. Preset 3 cycles through the three.
- Presets jump between screens. Per-screen knob and button mappings are left to the builder, but the knob should do real work on every screen: dimming, HomePod volume, and moving through agent prompt options.
- Browser target: whatever Chromium version the yocto-superbird kiosk ships. Don't assume a modern browser.

### Integrations

- **Home Assistant (on the Pi):**
  - WebSocket API (`subscribe_entities`, `call_service`) with a long-lived token. One connection covers everything below.
  - Lights and scenes come from their normal entities.
  - HomePods come through HA's Apple TV integration, which uses pyatv. Now-playing metadata can be patchy depending on what's sending audio to the HomePod.
  - The builder decides whether the Car Thing talks to HA directly (needs CORS config, and the token lives on the device) or through a small proxy. Either is acceptable on the LAN.
- **Agent monitor:** a small background service on the **Mac**, modeled on [rithkott/claude-thing](https://github.com/rithkott/claude-thing).
  - **What claude-thing provides:**
    - a macOS-only Node daemon
    - installs Claude Code hooks
    - holds `PermissionRequest` open until it's answered
    - lists sessions
    - a clean JSON protocol of requests, responses and events, in `protocol/claude-protocol.md`
  - **Changes for this project:**
    - The transport becomes a WebSocket over the home LAN, instead of Bluetooth via Nocturne.app.
    - The service binds beyond loopback and requires a shared token.
    - It covers **plan-mode approvals and multiple-choice questions**, not only tool permissions.
  - **The experience follows claude-thing's device app (owner's decision, 2026-11-01).**
    - The owner ran it in claude-thing's emulator against their live sessions and liked it: a session card grid, working/idle status, context bars, and the warm terminal look.
    - The owner rejected a from-scratch mockup.
    - Start from claude-thing's `device-app/` (MIT) and adapt it, rather than redesigning.
  - **Descriptive session names (owner's request).** claude-thing shows the folder plus a short ID ("mirror-1d"), because that's all `claude agents --json` returns. Instead, show the session's title:
    - Use the user's own title if one is set. A `custom-title` entry is assumed but not verified.
    - Otherwise use Claude Code's generated title: the latest `{"type":"ai-title","aiTitle":…}` line in the session transcript at `~/.claude/projects/<project>/<sessionId>.jsonl`.
    - Fall back to the folder name.
    - Verified example: "Spotify Car Thing ESP32 WiFi scoping", "Mirror-mouse pairing plan".
    - The project/folder name can sit as a secondary line.
  - **Conversation context (owner's request).** claude-thing's session view felt too thin. Opening a session (or a subagent) shows its recent conversation from the transcript:
    - the last ~40 entries, scrollable with the knob or touch (the owner asked twice for more context, so err long; the newest reply is shown nearly in full)
    - text sized for reading, not glancing
    - the question screen leads with the last few messages, so the owner sees why Claude is asking
    - the owner's prompts
    - Claude's replies, with thinking hidden
    - one-line tool steps
  - **Subagents (owner's request; the owner uses them heavily).**
    - **On a session's card:** show that it has subagents running, as a count of running and finished.
    - **Tap or press into a session:** list its subagents, each showing:
      - description
      - agent type
      - running or finished
      - foreground or background
      - what it's doing now (its latest tool call)
      - elapsed time
    - **Tap into a subagent:** a read-only activity feed of its recent tool calls and, when finished, the start of its final report.
    - Nested subagents (`spawnDepth` > 1) are indented under their parent.
    - **Data source (verified on this machine):** `~/.claude/projects/<project>/<sessionId>/subagents/`.
      - `agent-<id>.meta.json` holds `description`, `agentType`, `requestShape` (background or foreground), `spawnDepth` and `finished`.
      - `agent-<id>.jsonl` is the subagent's transcript, with `isSidechain: true` on every line.
    - claude-thing has no subagent support, so this is new. It's file reading only, with no fragile control path.
    - **Builder to verify:**
      - how `finished` behaves while an agent is still running;
      - whether `SubagentStart`/`SubagentStop` hooks give faster updates than watching files;
      - how multi-agent workflows (if used) appear.
  - **The owner's sessions run in the Claude Code VS Code extension, not a terminal (owner, 2026-11-01).** Checked against the extension (v2.1.314) and the CLI:
    - VS Code sessions **do** appear in `claude agents --json`; this session was listed.
    - The extension exposes **no** VS Code command to send a prompt, run a slash command, change model or effort, or answer a plan or question. Its commands only open, focus, rename and accept or reject diffs.
    - The CLI can't inject input into a running session. `--model` and `--effort` apply only at start. `--resume` on a live session starts a second, diverging process.
    - Keystroke injection into the extension's webview is too fragile to build on.

    **Therefore, for VS Code sessions, v1 offers:**
    - monitoring;
    - descriptive names;
    - permission answers through hooks. *Builder must verify that `PermissionRequest` hooks fire and are honored in the extension.*
    - the waiting alert for plans and questions;
    - a **"take me there"** action that raises the right VS Code window. The mechanism, such as `code <folder>` or AppleScript window raise, is left to the builder, and it must never type.
    - **answering questions and plans through hooks (found 2026-11-02 in the Claude Code hooks docs).** A `PreToolUse` hook can answer `AskUserQuestion` by returning `"allow"` with `updatedInput` holding the original questions plus an `answers` map, and can approve `ExitPlanMode` the same way. A `"deny"` reason sends plan feedback back to Claude. This works regardless of host, with no typing. *Verified 2026-11-02 in the VS Code extension: a knob answer, a spoken answer (as plan feedback), plan feedback and plan approval all reached Claude from the panel. VS Code shows nothing during the hold. A held question must open the panel screen by itself, or it times out unseen; fixed after the first live try.* Questions and plans hold up to 2 minutes on the panel, then fall back to VS Code.
    - **dictated messages to a session through hooks.** Working sessions get the message at their next tool call (`PostToolUse` `additionalContext`). Idle sessions are woken by a `Stop` hook running with `asyncRewake`, which exits 2 with the message. Either way Claude sees it as a system reminder, not a chat bubble in VS Code. If the owner types in VS Code first, the pending panel message is dropped. *Verified 2026-11-02 in the VS Code extension: an idle session was woken by a dictated panel message (it arrives as Stop-hook feedback), and a working session got two messages at its next tool call. Dropping on typing is covered by tests and a live-service run, but not checked by hand. A session idle for over an hour, or started before the hooks were installed, can't be woken; the panel says so and doesn't send.*
    - **dictation:** hold to talk on the panel; the audio goes to the Mac service and is transcribed locally with whisper.cpp; the owner reviews the text before sending. On hardware, the Car Thing's built-in mics under the mainline kernel are unverified (Plan 2); a USB mic on the hub is the fallback.

    **The session commands below stay deferred.** They only have a sturdy path for sessions the panel launches itself (CLI flags at start, or a headless `--input-format stream-json` / Agent SDK session) or terminal sessions inside tmux (`tmux send-keys`). Revisit if the owner's workflow changes.
  - **Session commands (owner's request, deferred for VS Code sessions; see above).** From a session's card, the owner could send common Claude Code commands without going to the Mac:
    - **Compact** (`/compact`). The card's context bar shows when this is needed.
    - **Change model** (`/model`): pick from a short list with the knob.
    - **Change effort**: pick a level with the knob (low → max).
    - **Interrupt** (Esc) is Claude's addition; the owner can drop it.

    Notes:
    - claude-thing has none of this.
    - The likely mechanism is the one claude-thing already uses to answer questions: focus the session's terminal window and type the command through macOS Automation.
    - **Builder must verify:**
      - the exact command or keystroke for changing effort in the current Claude Code version;
      - what happens if a command is typed while the session is busy (queued, rejected, or garbled into the user's input);
      - that typing never lands in the wrong window.
    - Until that's known, only enable commands while the session is idle, and show the result (the new model and effort on the card) once the session reports it.
  - When the Mac is asleep or away, the Agents screen shows "offline" and nothing else breaks.
  - [srcurran/MacThing](https://github.com/srcurran/MacThing) is a reference for a Claude usage view.
- **NucBox monitor (owner's request, 2026-11-02):**
  - **What it shows:** the model LM Studio has loaded, or "No model loaded"; busy or idle; CPU load; memory use; GPU load and GPU memory; temperatures.
  - **Quiet.** It never alerts, pulses or takes over. The owner sees it when they choose to look. GPU memory and GPU load are Claude's additions: local models mostly run on the GPU.
  - **Where:** the third view under preset 3 (sessions → usage → NucBox → sessions). All four presets are already taken.
  - **Hardware numbers:** [LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor) on the NucBox, read through Home Assistant's official [Libre Hardware Monitor integration](https://home-assistant.io/integrations/libre_hardware_monitor). The panel already holds an HA connection, so these arrive as ordinary HA entities.
    - LibreHardwareMonitor needs administrator rights to read CPU temperatures, so it runs as administrator and starts with Windows.
    - Turn on its remote web server (port 8085 by default) and open that port in the Windows firewall.
    - Give the NucBox a fixed IP address in the router, as HA recommends.
  - **Loaded model:** LM Studio's local REST API (`GET /api/v0/models`, each model has a `state`). LM Studio's server must be set to serve on the local network. Whether the panel polls LM Studio directly or HA polls it as a REST sensor is the builder's call.
  - **Busy is inferred.** LM Studio's API reports what's loaded but not whether it's generating (checked 2026-11-02). The view shows **busy** when a model is loaded and GPU load is above a threshold. The builder tunes the threshold against real runs. A relay that every LM Studio request passes through would be exact, but it means re-pointing every client, so it was rejected.
  - **Offline:** when the NucBox, LibreHardwareMonitor or LM Studio is unreachable, the view says which, plainly. Nothing else on the panel is affected.
- **Waiting-prompt alert:** when any session is waiting on the owner, it must be obvious on every app screen. The exact look is left to the design phase; the owner wants to see options. The panel sits on the owner's desk, so the alert can be bright and immediate.

## Calls made by Claude (owner to confirm)

- **The panel never holds agent prompts hostage.** The Mac's own prompt stays answerable and the first answer wins. If the panel is offline, Claude Code behaves exactly as it does today, with no stalls or timeouts.
- **The VS Code extension is the primary surface** (owner's actual workflow). Terminal sessions are monitored the same way. Tmux-based control is a later add-on.
- **If the HomePods aren't in Home Assistant yet,** adding the Apple TV integration is part of Milestone 2.
- **The ESP32 is replaced by a USB Wi-Fi adapter on a hub.** The owner dropped the ESP32 earlier while CarPlay was in scope. With CarPlay deferred the ESP32 would technically work again, but the adapter is less custom and better supported.

### Mac simulator (owner's request)

The owner wants a functional mockup they can run on their Mac. It is part of the project, not a throwaway:
- The same web app that runs on the Car Thing, opened in a desktop browser window at exactly 800×480.
- It uses an on-screen bezel that mimics the device: the knob, four presets, the extra top button, and back.
- **Input stand-ins:**

  | Car Thing input | Mac stand-in |
  |---|---|
  | Knob turn | mouse wheel or trackpad scroll, and ← / → |
  | Knob press | Enter |
  | Presets | 1–4 |
  | Extra top button | M |
  | Back | Esc |
  | Touch | click |

  These match the key codes the device sends, so the app's input code is the same in both places.
- It connects to the **real** Home Assistant and the **real** Mac agent service, and can switch to a **demo mode** with simulated data so the experience can be shown without live sessions.
- It's the main development loop for Milestones 1–3, and the way the owner reviews screens before they're flashed to hardware.
- **Starting point:** claude-thing's `emulator/`. It already provides:
  - a to-scale faceplate
  - device-accurate input events
  - CPU and heap throttling to device class

  **Adaptations needed:**
  - It assumes Nocturne firmware and a simulated phone. On Nocturne v4.0.7 its fake pairing gets stuck on the PIN screen, and loading `/claude/` directly bypasses it. This project drops Nocturne, so the emulator should serve our web app instead.
  - It hard-codes port 8080, which the owner's mirror service already uses. Make the port configurable.

## Milestones (suggested order)

0. **Standalone network proof:**
   - Build and flash the yocto-superbird kiosk example with Wi-Fi drivers added.
   - Car Thing plus powered hub plus adapter: boots, joins home Wi-Fi, is reachable over SSH, and shows a test page.
   - Every input reaches the page.
   - Survives repeated cold boots and Wi-Fi drops.
1. **App shell plus Mac simulator:** the owner's web app with screen switching and input handling, running in the Mac simulator first and then on the device. This can start in parallel with Milestone 0.
2. **Home Assistant screens:** Home, Audio.
3. **Agent monitor:** the Mac service plus the Agents screen, answering prompts, and the waiting-prompt alert across screens.
   - The NucBox view ships with the Home Assistant screens in Plan 3, since its hardware numbers come through HA.
4. **Stand:** an enclosure for the Car Thing, hub and adapter, with a single power input.

## Stretch goals

- Start Apple Music or Podcasts content on HomePods from the panel, through the Mac's Music and Podcasts apps (AppleScript; they can AirPlay to HomePods). Only works when the Mac is on.
- Ambient screens (clock, weather, calendar), as in MacThing.

## Future: CarPlay (deferred, research kept)

The owner likes Apple Music and Podcasts on CarPlay and may want it back later. What was learned:
- [Prelude](https://github.com/usenocturne/prelude) (GPL-3.0) does wireless CarPlay on the same yocto-superbird base.
- Its **Phone audio** setting keeps audio on the iPhone, which the owner requires.
- Wireless CarPlay puts the iPhone on the Car Thing's own access point, which takes it off home Wi-Fi and likely breaks AirPlay to HomePods. The owner wants the phone to stay on home Wi-Fi.
- Two ideas to try, in this order:
  - (B) give the iPhone the home network's details during the CarPlay handshake;
  - (A) make the Car Thing a router between its access point and home Wi-Fi, relaying mDNS.
- Ethernet at the desk would make (A) a simple bridge.
- **If CarPlay comes back,** the owner's apps should already be independent of it. The adapter choice above should then favor access-point support.

## Left to the builder

- Web app framework, within the kiosk's Chromium version.
- Per-screen input mappings, following the "knob does real work" principle.
- Talking to HA directly or through a proxy.
- The final Wi-Fi adapter, confirmed in Milestone 0.
- The recovery and gadget-mode boot mechanism.

## Open questions

- Whether the owner's "mirror" project has code or UI patterns to reuse or match (asked, not yet answered).
- Whether the Mac is a desktop or a laptop. This affects how often the Agents screen is offline, but doesn't change the design.

## Plan 2 research findings (2026-11-02)

Read from yocto-superbird `a3b941e` and Prelude `710a407`. These correct earlier assumptions.

- **Browser:** the kiosk runs **cast_shell from Chromium 147** (the Chromecast embedder), not Chrome 69. The panel's Chrome 69 legacy build still runs, but it is no longer required. cast_shell has no HTTP disk cache.
- **The panel is served from the device** (from `file://` or a localhost server), not from the Mac. It then boots while the Mac is off, and doesn't refetch everything on every boot. The device reaches the Mac service over the LAN with the token, and Home Assistant directly.
- **Microphones work on the device, but not through the browser.** The 4-mic PDM array works on mainline Linux (`dmic-codec`, ALSA card "Superbird"). cast_shell blocks `getUserMedia`, and the kiosk runs with `--disable-audio-output` (a fake audio stack). So dictation on the device uses a **small native recorder service** that reads ALSA and hands WAV audio to the page over a localhost WebSocket. The Mac still transcribes. The simulator keeps using the browser microphone.
- **Hub:** use a **plain USB-2 powered OTG (charge-through) adapter or hub, not a USB-C PD dock.** The Car Thing has no USB-C power-delivery controller, and Prelude saw a PD dock enumerate nothing.
- **Wi-Fi:** the kiosk image disables `CONFIG_WLAN`/`CFG80211` and strips `wpa-supplicant` and `wireless-regdb`. Our layer re-enables them and adds only the chosen adapter's driver and firmware.
  - The device runs **Linux 7.0.2**.
  - **TP-Link Archer TX10UB Nano** (RTL8851BU, `rtw89_8851bu`, USB ID `3625:010b`) is supported. The driver is young, so it needs drop testing.
  - Safer mt76 alternatives: **MT7921AU** (e.g. Brostrend AX9L) or **MT7610U** (e.g. Panda PAU0A).
- **Development access:** the dev image runs SSH over USB networking (`superbird-kiosk.local`) with an empty root password. Host mode has no USB networking, so after switching use Wi-Fi SSH, or optionally a USB Ethernet adapter (AX88179) on the hub. **Set a root key before it joins the home LAN.**
- **Recovery:** hold presets 1 and 4 while plugging in USB (hub disconnected) for mask-ROM reflash with `flashthing-cli` or Terbium. A/B slots fall back after 3 failed boots. `superbird-usb-role to-host` reverts after 300 s unless confirmed.
- **Cactus models:**
  - Whistle (16.9 MB, speech recognition) and Needle 3 (35 MB, function calling) are **Apache-2.0**, and ship a `linux-arm64` runner.
  - They are worth a trial on the device for offline voice control of the home screens (Plan 3 or later).
  - Memory use is unpublished; the panel has about 426 MB to share with Chromium.

## Key risks

1. **Host mode plus powered hub on yocto-superbird.** It's proven in Prelude, but Prelude's own README notes that USB voltage and backfeed limits and hotplug need checking per hub.
2. **Wi-Fi adapter driver maturity,** especially for the young rtw89 USB driver if the TP-Link is chosen.
3. **Answering plans and questions through hooks is documented but unverified here.** claude-thing's `daemon/src/queue.js` (tested against Claude Code 2.1.220) says hooks can't answer them, and it types the answer through macOS Automation instead. That note covered the `PermissionRequest` hook. The current hooks docs describe answering both through `PreToolUse` with `updatedInput`. The extension bundles a newer Claude Code (2.1.314 during scoping), so this is likely fine, but Plan 1's Task 13 checks it. If it fails, the panel falls back to "Answer in VS Code". The same applies to waking an idle session with `asyncRewake`.

   Note also that claude-thing holds each permission for up to about 10 minutes by default (`CLAUDE_THING_HOLD_MS`, 595 s). That conflicts with the "never stall" call above, so the hold must be short or skipped when no panel is connected.
