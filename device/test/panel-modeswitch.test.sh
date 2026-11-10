#!/usr/bin/env bash
# The TP-Link TX10UB Nano starts as a fake USB disk (0bda:1a2b) and only becomes
# a Wi-Fi adapter (3625:010b, the ID the rtw89 8851BU driver matches) after a
# standard eject. The image must do that on every boot: a udev rule for exactly
# that ID, a usb_modeswitch config pointing at the real target, and the recipe
# and image lines that ship both. (The switch itself was checked by hand: see
# the commit message.)
set -u
here="$(cd "$(dirname "$0")" && pwd)"
dev="$here/.."
recipe_dir="$dev/meta-panel/recipes-connectivity/panel-modeswitch"
rules="$recipe_dir/files/40-panel-modeswitch.rules"
conf="$recipe_dir/files/modeswitch-0bda-1a2b.conf"
recipe="$recipe_dir/panel-modeswitch.bb"
image="$dev/meta-panel/recipes-core/images/superbird-kiosk-dev-image.bbappend"
fail=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }

# --- the udev rule
check "rule file exists" "[ -f '$rules' ]"
check "rule matches the disk-mode ID, vendor and product" \
  "grep -E 'ATTR\{idVendor\}==\"0bda\".*ATTR\{idProduct\}==\"1a2b\"' '$rules' >/dev/null 2>&1"
check "rule runs usb_modeswitch with the device's kernel name" \
  "grep -E 'RUN\+=\"usb_modeswitch .*%k' '$rules' >/dev/null 2>&1"
check "rule acts only on add, so a replug is handled but not every change event" \
  "grep -E 'ACTION==\"add\"' '$rules' >/dev/null 2>&1"
check "rule names no other vendor (it is for this one dongle)" \
  "[ \"\$(grep -c 'idVendor' '$rules' 2>/dev/null)\" = 1 ]"

# --- the usb_modeswitch config
check "config exists" "[ -f '$conf' ]"
check "config targets the Wi-Fi ID the driver matches (3625:010b)" \
  "grep -qx 'TargetVendor=0x3625' '$conf' 2>/dev/null && grep -qx 'TargetProduct=0x010b' '$conf' 2>/dev/null"
check "config uses the standard SCSI eject" "grep -qx 'StandardEject=1' '$conf' 2>/dev/null"

# --- the recipe
check "recipe exists" "[ -f '$recipe' ]"
check "recipe installs the rule into udev's rules.d" \
  "grep -E 'rules\.d' '$recipe' >/dev/null 2>&1 && grep -E '40-panel-modeswitch\.rules' '$recipe' >/dev/null 2>&1"
check "recipe installs the config as /etc/usb_modeswitch.d/0bda:1a2b (read before the data package's D-Link entry)" \
  "grep -E 'sysconfdir\}/usb_modeswitch\.d' '$recipe' >/dev/null 2>&1 && grep -F '0bda:1a2b' '$recipe' >/dev/null 2>&1"
check "recipe depends on usb-modeswitch" "grep -E 'RDEPENDS.*usb-modeswitch' '$recipe' >/dev/null 2>&1"

# --- the image
check "image installs panel-modeswitch" "grep -E 'panel-modeswitch' '$image' >/dev/null 2>&1"
check "image does not pull in the thousand-rule data package by recommendation" \
  "grep -E 'BAD_RECOMMENDATIONS.*usb-modeswitch-data' '$image' >/dev/null 2>&1"

exit $fail
