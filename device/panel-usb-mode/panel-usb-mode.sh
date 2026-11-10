#!/bin/sh
# Runs once at boot, before the kiosk, and picks the USB port's role.
# Back held at power-on: stay a USB gadget (USB networking, ADB and SSH)
# and flag the recovery boot, so the recorder serves the recovery notice.
# Provisioned tethered (provision.sh --tethered): USB networking with the panel,
# which reaches the Mac service over the cable.
# Otherwise: host, which powers the hub and the Wi-Fi adapter.
# Mask-ROM (1+4 at power-on) is below all of this and always still works.
set -u
INPUT_DIR="${PANEL_INPUT_DIR:-/dev/input}"
FLAG="${PANEL_RECOVERY_FLAG:-/run/panel-recovery}"
TETHERED="${PANEL_TETHERED_FLAG:-/opt/panel/tethered}"
WAIT="${PANEL_INPUT_WAIT:-3}"

# The buttons' input devices may appear a moment after udev starts.
i=0
while [ "$i" -lt "$WAIT" ] && ! ls "$INPUT_DIR"/event* >/dev/null 2>&1; do
  sleep 1; i=$((i + 1))
done

back_held() {
  for dev in "$INPUT_DIR"/event*; do
    [ -e "$dev" ] || continue
    # evtest exits 10 when the key is down, 0 when up.
    evtest --query "$dev" EV_KEY KEY_ESC >/dev/null 2>&1
    [ $? -eq 10 ] && return 0
  done
  return 1
}

if back_held; then
  echo "panel-usb-mode: Back held, recovery: USB networking"
  touch "$FLAG"
  superbird-usb-role to-device
elif [ -e "$TETHERED" ]; then
  echo "panel-usb-mode: tethered: USB networking with the panel"
  rm -f "$FLAG"
  superbird-usb-role to-device
else
  rm -f "$FLAG"
  superbird-usb-role to-host --no-revert
fi
exit 0
