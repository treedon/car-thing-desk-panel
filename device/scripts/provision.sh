#!/usr/bin/env bash
# Puts the desk panel's per-home settings on a Car Thing, from this Mac:
#   /opt/panel/panel-config.js   Mac service address + LAN token, Home Assistant, recorder
#   /opt/panel/wifi.conf         wpa_supplicant config for wlan0 (your network={…} block),
#                                only when ~/.config/claude-panel/wifi.conf exists
#   /opt/panel/authorized_keys   the owner's SSH public key (password login stays off)
#   /opt/panel/tethered          only with --tethered: boot into USB networking with the panel
# Sources: ~/.config/claude-panel/{token,ha.json,tasks.json,nucbox-sessions.json,wifi.conf}
# and ~/.ssh/id_*.pub.
# Nothing secret is printed or kept in the repo.
#
# Tethered, over the USB cable (before there is Wi-Fi). Hold Back while the
# device boots the first time; afterwards it boots tethered on its own:
#
#   device/scripts/provision.sh --tethered
#
# It goes over ADB (root over the cable, no password) and points the panel at
# the Mac's address on the USB link. Over Wi-Fi, with your key:
#
#   device/scripts/provision.sh desk-panel.local
#   device/scripts/provision.sh --dry-run <folder> [--tethered] [HOST]   (writes <folder>/opt/panel)
set -euo pipefail

DRY="" TETHERED="" HOST=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY="$2"; shift 2 ;;
    --tethered) TETHERED=1; shift ;;
    *) HOST="$1"; shift ;;
  esac
done
[ -n "$HOST$TETHERED" ] || { echo "usage: provision.sh [--dry-run DIR] (--tethered | HOST)" >&2; exit 2; }

CFG="$HOME/.config/claude-panel"
die() { echo "provision: $1" >&2; exit 1; }

[ -s "$CFG/token" ] || die "no $CFG/token — start the Mac service once to create it"
WIFI=""; [ -s "$CFG/wifi.conf" ] && WIFI=1
[ -n "$WIFI" ] || echo "provision: no $CFG/wifi.conf, so no Wi-Fi settings (fine while tethered over USB)" >&2
KEY=$(ls "$HOME"/.ssh/id_ed25519.pub "$HOME"/.ssh/id_rsa.pub 2>/dev/null | head -1 || true)
if [ -z "$KEY" ]; then
  msg="no SSH public key in ~/.ssh — create one with ssh-keygen -t ed25519"
  [ -n "$TETHERED" ] || die "$msg"
  echo "provision: $msg (needed for SSH over Wi-Fi later)" >&2
fi

# Where the Car Thing finds the Mac: on the LAN by name, or tethered at the
# Mac's address on the USB link (the device's DHCP hands out 10.42.1.x).
usb_mac_ip() { ifconfig | awk '/inet 10\.42\.1\./{print $2; exit}'; }
if [ -n "${PANEL_MAC_HOST:-}" ]; then MAC_HOST="$PANEL_MAC_HOST"
elif [ -n "$TETHERED" ]; then
  MAC_HOST=$(usb_mac_ip)
  [ -n "$MAC_HOST" ] || die "no USB link to the Car Thing — boot it holding Back, with the cable to this Mac"
else MAC_HOST="$(scutil --get LocalHostName 2>/dev/null).local"
fi

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
umask 077

HA_CONFIG_JS="$(cd "$(dirname "$0")/../.." && pwd)/mac-service/src/ha-config.js"
node --input-type=module - "$CFG" "$MAC_HOST" "$HA_CONFIG_JS" > "$STAGE/panel-config.js" <<'JS'
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const [cfgDir, macHost, haConfigJs] = process.argv.slice(2);
const token = fs.readFileSync(cfgDir + '/token', 'utf8').trim();
// ha.json as the simulator reads it: defaults filled in, bad entries dropped.
const { loadHaConfig } = await import(pathToFileURL(haConfigJs).href);
let ha = null;
try { ha = loadHaConfig(cfgDir + '/ha.json'); } catch {}
// tasks.json: the NucBox's tasks service ({url, token}), written by
// nucbox/push-tasks-secrets.sh. Without it the Tasks page says it isn't set up.
let tasks = null;
try {
  const t = JSON.parse(fs.readFileSync(cfgDir + '/tasks.json', 'utf8'));
  if (t && t.url && t.token) tasks = { url: String(t.url), token: String(t.token) };
} catch {}
// nucbox-sessions.json: the NucBox's session service ({url, token}), written
// by nucbox/push-sessions-token.sh, for the Claude sessions that run there.
let nucboxSessions = null;
try {
  const n = JSON.parse(fs.readFileSync(cfgDir + '/nucbox-sessions.json', 'utf8'));
  if (n && n.url && n.token) nucboxSessions = { url: String(n.url), token: String(n.token) };
} catch {}
const cfg = { serviceUrl: `ws://${macHost}:8790/ws`, token, ha, recorder: 'http://127.0.0.1:8095', tasks, nucboxSessions };
process.stdout.write('window.PANEL_CONFIG = ' + JSON.stringify(cfg) + ';\n');
JS
# A complete wpa_supplicant config: the image links
# /etc/wpa_supplicant/wpa_supplicant-wlan0.conf to /opt/panel/wifi.conf.
if [ -n "$WIFI" ]; then
  { printf 'ctrl_interface=/run/wpa_supplicant\nupdate_config=0\n\n'; cat "$CFG/wifi.conf"; } > "$STAGE/wifi.conf"
fi
[ -z "$KEY" ] || cp "$KEY" "$STAGE/authorized_keys"
[ -z "$TETHERED" ] || : > "$STAGE/tethered"
chmod 600 "$STAGE"/*

if [ -n "$DRY" ]; then
  mkdir -p "$DRY/opt/panel"
  cp -p "$STAGE"/* "$DRY/opt/panel/"
  echo "wrote $DRY/opt/panel ($(cd "$STAGE" && echo *))"
  exit 0
fi

# Clears the recovery notice too, so the panel shows without a reboot.
APPLY='chmod 600 /opt/panel/*; rm -f /run/panel-recovery; systemctl restart wpa_supplicant@wlan0 chromium-kiosk 2>/dev/null || true'
if [ -n "$TETHERED" ]; then
  command -v adb >/dev/null || die "adb not found — brew install --cask android-platform-tools"
  echo "copying settings to the Car Thing over ADB …"
  adb shell 'mkdir -p /opt/panel && chmod 700 /opt/panel'
  for f in "$STAGE"/*; do adb push -q "$f" /opt/panel/ >/dev/null; done
  adb shell "$APPLY"
  echo "done. The panel talks to ws://$MAC_HOST:8790/ws over the cable, and boots tethered from now on."
else
  echo "copying settings to $HOST:/opt/panel …"
  ssh "root@$HOST" 'mkdir -p /opt/panel && chmod 700 /opt/panel'
  scp -q -p "$STAGE"/* "root@$HOST:/opt/panel/"
  ssh "root@$HOST" "rm -f /opt/panel/tethered; $APPLY"
  echo "done. The panel on $HOST talks to ws://$MAC_HOST:8790/ws."
fi
