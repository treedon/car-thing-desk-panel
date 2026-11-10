#!/usr/bin/env bash
# panel-usb-mode picks the USB port's role at boot: Back held -> recovery
# (USB networking, the recovery notice); provisioned tethered -> USB networking
# with the panel; otherwise host for the Wi-Fi adapter.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
fail=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }

# Fakes on PATH: evtest reports KEY_ESC down (exit 10) on the devices listed in
# $HELD; superbird-usb-role records what it was asked to do.
run() {
  t=$(mktemp -d); mkdir -p "$t/bin" "$t/input"
  for d in $1; do touch "$t/input/$d"; done
  cat > "$t/bin/evtest" <<'F'
#!/bin/sh
for h in $HELD; do [ "$2" = "$PANEL_INPUT_DIR/$h" ] && [ "$4" = KEY_ESC ] && exit 10; done
exit 0
F
  printf '#!/bin/sh\necho "$*" >> "%s/role"\n' "$t" > "$t/bin/superbird-usb-role"
  chmod +x "$t/bin/"*
  [ -n "${3:-}" ] && touch "$t/flag"
  [ -n "${4:-}" ] && touch "$t/tethered"
  HELD="$2" PATH="$t/bin:$PATH" PANEL_INPUT_DIR="$t/input" PANEL_RECOVERY_FLAG="$t/flag" \
    PANEL_TETHERED_FLAG="$t/tethered" PANEL_INPUT_WAIT=0 \
    sh "$here/../panel-usb-mode/panel-usb-mode.sh" >/dev/null 2>&1
  code=$?
}

run "event0 event1" ""
check "no button held: the port becomes a host, with no revert" "[ \"\$(cat $t/role)\" = 'to-host --no-revert' ]"
check "no button held: no recovery flag" "[ ! -e $t/flag ]"
check "exits 0" "[ $code -eq 0 ]"

run "event0 event1" "event1"
check "Back held on any input device: the port stays a USB gadget" "[ \"\$(cat $t/role)\" = 'to-device' ]"
check "Back held: the recovery flag is set for the recorder" "[ -e $t/flag ]"

run "event0" "" stale
check "a normal boot clears a stale recovery flag" "[ ! -e $t/flag ]"

run "" ""
check "no input devices at all: host mode (the default)" "[ \"\$(cat $t/role)\" = 'to-host --no-revert' ]"

run "event0" "" stale tethered
check "tethered: the port stays a USB gadget" "[ \"\$(cat $t/role)\" = 'to-device' ]"
check "tethered: no recovery flag, so the panel shows" "[ ! -e $t/flag ]"

run "event0" "event0" "" tethered
check "tethered with Back held: still recovery" "[ \"\$(cat $t/role)\" = 'to-device' ] && [ -e $t/flag ]"

exit $fail
