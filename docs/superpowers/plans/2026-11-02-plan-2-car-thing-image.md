# Plan 2: Car Thing Image and Network Proof — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The panel from Plans 1 and 3 runs on the real Car Thing. The Car Thing:
- boots into the kiosk;
- joins home Wi-Fi through a USB adapter on a powered OTG hub;
- shows the panel served from its own storage;
- reaches the Mac service and Home Assistant over the LAN;
- takes every hardware input;
- dictates through its own microphones;
- survives cold boots and Wi-Fi drops (spec Milestone 0).

**Architecture:**
- **Build:** our own kas project in `device/` builds a yocto-superbird image, pinned to commit `a3b941e`. A `meta-panel` layer, started from yocto-superbird's MIT kiosk example, adds:
  - Wi-Fi: only the chosen adapter's driver, firmware, `wpa_supplicant` and DHCP;
  - a recipe that installs `panel/dist`;
  - a provisioned `/opt/panel/` holding the device's secrets and config;
  - host mode with a hold-Back-at-boot recovery;
  - a small native recorder that reads the ALSA mics for dictation.
- **Panel:** it runs from `file://` in the kiosk (cast_shell, Chromium 147).

**Tech Stack:** Yocto via kas in Docker on macOS (`just`, `flashthing-cli`), Linux 7.0.2, systemd-networkd, wpa_supplicant, and ALSA. The panel and Mac service are as in Plans 1 and 3.

**Spec:** `docs/superpowers/specs/2026-11-01-carthing-panel-design.md`. The section "Plan 2 research findings (2026-11-02)" overrides earlier notes on the browser, hub and mics.

## Global Constraints

- **No secrets in the repo:** no Wi-Fi password, LAN token, HA token or SSH key.
  - They live on the device under `/opt/panel/` (mode `0600`, root).
  - They are written there by `device/scripts/provision.sh` from the Mac's `~/.config/claude-panel/` and a Wi-Fi file the owner keeps there.
- **The image never joins the home LAN with an empty root password.** Provisioning installs the owner's SSH public key and locks password login before Wi-Fi is configured.
- **Recovery always remains:**
  - mask-ROM reflash (presets 1+4 at plug-in, hub unplugged);
  - holding Back at power-on keeps USB in device mode (USB networking SSH);
  - `superbird-usb-role to-host` is confirmed only after SSH over Wi-Fi works.
- **Licences:**
  - yocto-superbird is MIT.
  - Prelude is GPL-3.0, which is compatible with this repo's GPL-3.0, so copying from it is allowed. Credit it in `NOTICE.md`.
- **Wi-Fi drivers:** only the chosen adapter's driver goes in, as a `.cfg` fragment that re-enables `WLAN`/`CFG80211`. The default fragment covers `RTW89_8851BU` (TP-Link TX10UB Nano) and `MT7921U` (the fallback adapter).
- **Ports:** never use `8080`. The device recorder listens on `127.0.0.1:8095` only.

## Review Focus

1. **The router reboots or Wi-Fi drops.** The device rejoins without a reboot. The panel shows its offline lines, then recovers, and the Mac service releases any held prompts (Plan 1's heartbeat). *Verified in Task 7.*
2. **The device cold-boots while the Mac is off or asleep.** The panel still boots to Home (HA works) and Agents shows "Mac offline. Reconnecting…". *Verified in Task 7.*
3. **A bad image or bad host-mode setting is flashed.** The owner can always recover by holding Back at boot (USB SSH) or through mask-ROM. *Verified in Task 3.*
4. **Twenty cold boots in a row.** Each one reaches the kiosk on Wi-Fi with no manual step. *Verified in Task 7.*
5. **The recorder is asked to record twice, or never told to stop.** It refuses the second request and auto-stops at 30 s; the microphone is never left open. *Tests in Task 6.*

---

### Task 0 (owner): Hardware and Mac tooling

- [ ] **Buy:**
  - **Adapter:** the TP-Link Archer TX10UB Nano, or the safer MT7921AU-based Brostrend AX9L.
  - **Hub:** a **powered USB-2 OTG charge-through adapter or hub** with USB-C to the Car Thing (not a USB-C PD dock).
  - **Optional:** an AX88179 USB Ethernet adapter for development SSH in host mode.
- [ ] **Install the Mac tools:** Docker Desktop, then `pipx install kas`, `brew install just` and `cargo install flashthing-cli`.
- [ ] **Wi-Fi details:** put them in `~/.config/claude-panel/wifi.conf` (wpa_supplicant `network={…}` block, mode `0600`).

### Task 1: Our build project and a first image

**Files:**
- Create:
  - `device/kas/panel.yml`, which includes yocto-superbird `kas/superbird.yml` at `a3b941e` and uses `kas/macos-lowmem.yml` on macOS
  - `device/meta-panel/`, copied from `examples/meta-superbird-kiosk-example` and renamed; MIT notice kept
  - `device/justfile`
  - `device/README.md`
- Modify: `NOTICE.md`, `.gitignore` (build output)

**Interfaces:**
- Produces:
  - `SUPERBIRD_HOSTNAME = "desk-panel"`.
  - `CHROMIUM_KIOSK_URL = "file:///usr/share/desk-panel/index.html"`.
  - `just -f device/justfile build`, `flash` and `ssh`.

- [ ] **Step 1:** Run `just macos-setup` (it creates the case-sensitive Docker volume), then `just -f device/justfile build`.
  - Expected: a `…-dev-image-superbird-flashthing.zip`. Record the build time and disk use in `device/README.md`.
- [ ] **Step 2 (owner at the device):** hold 1+4 while plugging in USB with the hub disconnected, then run `just -f device/justfile flash`.
  - Expected: the kiosk shows the default page.
- [ ] **Step 3:** Run `ssh root@desk-panel.local` over USB networking.
  - Expected: login, and `uname -r` prints `7.0.2`.
- [ ] **Step 4:** Commit: `feat(device): yocto-superbird build project for the desk panel`.

### Task 2: Wi-Fi

**Files:**
- Create:
  - `device/meta-panel/recipes-kernel/linux/linux-superbird_%.bbappend` and `files/panel-wifi.cfg`. The `.cfg` sets:
    - core: `CONFIG_WIRELESS=y`, `CONFIG_CFG80211=m`, `CONFIG_MAC80211=m`, `CONFIG_WLAN=y`;
    - Realtek: `CONFIG_WLAN_VENDOR_REALTEK=y`, `CONFIG_RTW89=m`, `CONFIG_RTW89_8851BU=m`;
    - MediaTek: `CONFIG_WLAN_VENDOR_MEDIATEK=y`, `CONFIG_MT7921U=m`.
  - `device/meta-panel/recipes-connectivity/panel-wifi/` holding a systemd-networkd `wlan0.network` (DHCP) and a `wpa_supplicant@wlan0` drop-in that reads `/opt/panel/wifi.conf`.
- Modify: the image recipe's `IMAGE_INSTALL`, which adds:
  - `wpa-supplicant`, `iw` and `wireless-regdb-static`;
  - `linux-firmware-rtl8851` and the mt7921 firmware (split the same way Prelude does);
  - `kernel-module-rtw89-8851bu` and `kernel-module-mt7921u`;
  - `kernel-module-aes`, `-ccm`, `-ctr`, `-gcm` and `-ghash-generic`.

- [ ] **Step 1:** Build and flash. Over USB SSH, put the adapter on the hub and check that `ip link` shows `wlan0`.
  - In device mode the hub isn't powered from the host, so for this step use `superbird-usb-role to-host`, which reverts in 300 s, and the optional USB Ethernet adapter. If neither is available, go straight to provisioning (Task 4) and judge from the screen.
- [ ] **Step 2:** Provision `wifi.conf` (Task 4's script, Wi-Fi only).
  - Expected: `iw dev wlan0 link` shows the SSID, `ping` works, and `desk-panel.local` resolves from the Mac.
- [ ] **Step 3:** Commit: `feat(device): Wi-Fi for TX10UB (rtw89) and MT7921AU`.

### Task 3: Host mode, SSH key, recovery

**Files:**
- Create: `device/meta-panel/recipes-bsp/panel-usb-mode/`. A boot unit runs before the kiosk:
  - **Back held at boot (`KEY_ESC` reads as down):** stay in device mode and show "Recovery: USB networking" on the screen.
  - **Otherwise:** `superbird-usb-role host`.
  - Use Prelude's approach (GPL-3.0, credited).
- Modify: the image, to drop `debug-tweaks`/`empty-root-password` for the owner's build and to install `authorized_keys` from `/opt/panel/authorized_keys` through an sshd drop-in.

- [ ] **Step 1:** Build, flash and provision a key.
  - Expected:
    - password login over SSH fails;
    - key login works over Wi-Fi;
    - after a reboot, the USB port powers the hub and the adapter.
- [ ] **Step 2:** Hold Back at power-on.
  - Expected: USB networking SSH works and the screen says so.
  - Then confirm mask-ROM still enumerates (`1b8e:c003`) with 1+4 held.
- [ ] **Step 3:** Commit: `feat(device): host mode at boot with hold-Back recovery; key-only SSH`.

### Task 4: Panel on the device, and provisioning

**Files:**
- Create:
  - `device/meta-panel/recipes-panel/desk-panel/desk-panel.bb`. It installs `panel/dist` into `/usr/share/desk-panel/` and symlinks `/usr/share/desk-panel/panel-config.js` to `/opt/panel/panel-config.js`.
  - `device/scripts/provision.sh HOST` writes, over SSH, and never echoes a secret:
    - `/opt/panel/panel-config.js` containing:
      - `serviceUrl: ws://<Mac's .local name>:8790/ws`;
      - `token` from `~/.config/claude-panel/token`;
      - `ha` from `ha.json`;
      - `recorder: 'http://127.0.0.1:8095'`;
    - `/opt/panel/wifi.conf`;
    - `/opt/panel/authorized_keys`.
  - `device/test/provision.test.sh` (bats-style plain shell), which runs `provision.sh` with `--dry-run` into a temp dir and checks file contents and modes `0600`.
- Modify: `panel/src/config.js` (`readConfig` passes `recorder` through), plus a test.

- [ ] **Step 1:** Write the failing provision dry-run test and the `readConfig` recorder test. Run both: FAIL.
- [ ] **Step 2:** Implement. Run both: PASS.
- [ ] **Step 3:** Build, flash and provision. Expected:
  - the panel boots to Home;
  - the Agents screens list the Mac's sessions (LAN token path);
  - HA entities load (direct HA WebSocket from a `file://` page; **check HA accepts the `null` origin**, otherwise add a localhost server recipe and record a ruling);
  - the macOS firewall prompt for `node` is allowed by the owner.
- [ ] **Step 4:** Commit: `feat(device): panel served from the device, provisioned from the Mac`.

### Task 5: Every input on the device

- [ ] **Step 1:** On the device, check each input against the panel:
  - **Presets 1–4:** switch screens.
  - **Top button:** tap works, and holding it gives `m-hold`.
  - **Back:** works.
  - **Knob:** turns and presses.
  - **Touch:** taps and drags.

  Fix any mapping difference in `panel/src/input.js` with a test.
- [ ] **Step 2:** Commit any fixes: `fix(panel): input mapping on hardware`.

### Task 6: Dictation through the built-in mics

**Files:**
- Create: `device/meta-panel/recipes-panel/panel-recorder/`, built in the same language and setup as yocto-superbird's `examples/meta-superbird-mic-debug` (read it first; MIT). It runs as a systemd service on `127.0.0.1:8095`:
  - `POST /start` → `204`; `409` if already recording.
  - `POST /stop` → `200 audio/wav` (16 kHz mono s16, mixed from the 4-channel PDM capture).
  - Auto-stops at 30 s and keeps the WAV for one `/stop`.
  - `GET /health`.
  - CORS `Access-Control-Allow-Origin: null`, since the page is `file://`.
  - Unit tests for the WAV header and the 4ch s32 → mono s16 mix, run on the build host.
- Modify: `panel/src/dictation.js`. When `PANEL_CONFIG.recorder` is set, `startRecording`/`stopRecording` call the recorder instead of `getUserMedia`, with mime `audio/wav`. Add a panel test with a fake `fetch`.

- [ ] **Step 1:** Write the failing tests: the recorder's mix and header, and its double-start and auto-stop behaviour (Review Focus 5); the panel backend picks the recorder when it's configured.
- [ ] **Step 2:** Implement. Tests: PASS.
- [ ] **Step 3:** On the device, hold the top button on a question, speak, and release. Expected: the review screen shows the text and Send answers Claude.
- [ ] **Step 4:** Commit: `feat(device): dictation through the built-in microphones`.

### Task 7: Milestone 0 exit checks

- [ ] **Step 1:** Power-cycle 20 times in a row. Each boot must reach the panel on Wi-Fi (Review Focus 4). Record boot-to-panel time.
- [ ] **Step 2:** Reboot the router. The device rejoins and the panel recovers with no touch (Review Focus 1).
- [ ] **Step 3:** Cold-boot with the Mac asleep. Home works, and Agents shows "Mac offline. Reconnecting…" and then recovers when the Mac wakes (Review Focus 2).
- [ ] **Step 4:** Record the results in the spec. Commit: `docs: record Car Thing Milestone 0 results`.

### Task 8 (spike, optional): Cactus models on the device

Throwaway; no tests. Copy the `linux-arm64` `needle` runner plus `whistle.cact` and `needle3.cact` to `/opt/panel/cactus/`. Then:
- transcribe a 5 s WAV from the recorder;
- turn "dim the office lights to 30 percent" into a tool call against a `tools.json` built from the Home screen's entities.

Record RAM peak, latency and accuracy in the spec. Decide with the owner whether offline voice control belongs in a later plan.
