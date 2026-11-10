#!/usr/bin/env bash
# Updates a Car Thing over Wi-Fi from an update bundle (.swu), with no USB
# cable and no button holding. Build the bundle with `just -f device/Justfile swu`.
#
#   device/scripts/ota.sh <the Car Thing's address> <file.swu>
#
# swupdate writes the bundle to the inactive A/B slot (the running slot and
# /opt/panel, with its Wi-Fi, keys and panel-config.js, are untouched) and
# makes it the active one; the reboot lands in it. u-boot counts boot
# attempts, and superbird-slot-ok marks the slot healthy about a minute after
# a good boot; a slot that never gets there is left for the old one after
# three tries.
set -euo pipefail

die() { echo "ota: $*" >&2; exit 1; }
[ $# -eq 2 ] || die "usage: $0 <the Car Thing's address> <file.swu>"
HOST="$1"
SWU="$2"
[ -f "$SWU" ] || die "no such file: $SWU (build it with: just -f device/Justfile swu)"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10 "root@$HOST")

active=$("${SSH[@]}" 'fw_printenv -n slot_active')
case "$active" in
  a) target=b ;;
  b) target=a ;;
  *) die "unexpected active slot: '$active'" ;;
esac
echo "ota: $HOST runs slot $active; writing slot $target"

echo "ota: copying $(du -h "$SWU" | cut -f1) …"
scp -q "$SWU" "root@$HOST:/var/tmp/panel.swu"
want=$(shasum -a 256 "$SWU" | cut -d' ' -f1)
got=$("${SSH[@]}" 'sha256sum /var/tmp/panel.swu' | cut -d' ' -f1)
[ "$want" = "$got" ] || { "${SSH[@]}" 'rm -f /var/tmp/panel.swu'; die "the copy doesn't match; nothing was installed"; }

# The swupdate daemon is stopped so the one-shot install has the device to
# itself; the reboot (or the failure path) brings it back.
if ! "${SSH[@]}" "systemctl stop swupdate.socket swupdate.service 2>/dev/null; swupdate -e stable,slot_$target -i /var/tmp/panel.swu >/var/tmp/ota.log 2>&1"; then
  "${SSH[@]}" 'rm -f /var/tmp/panel.swu; tail -5 /var/tmp/ota.log; systemctl start swupdate.socket 2>/dev/null' >&2 || true
  die "swupdate failed; slot $active is still active"
fi
now=$("${SSH[@]}" 'rm -f /var/tmp/panel.swu; sync; fw_printenv -n slot_active')
[ "$now" = "$target" ] || die "swupdate finished but slot_active is '$now', not $target; not rebooting"

echo "ota: installed; rebooting into slot $target …"
"${SSH[@]}" '(sleep 1; reboot) >/dev/null 2>&1 &'
sleep 10
for _ in $(seq 1 60); do
  "${SSH[@]}" true 2>/dev/null && break
  sleep 3
done
booted=$("${SSH[@]}" 'grep -o "superbird.slot=." /proc/cmdline | cut -d= -f2; grep -o "\"imageBuildId\"[^,]*" /etc/superbird | cut -d\" -f4') \
  || die "$HOST didn't come back over SSH; if slot $target can't boot, it goes back to slot $active by itself"
slot=$(printf '%s\n' "$booted" | sed -n 1p)
build=$(printf '%s\n' "$booted" | sed -n 2p)
[ "$slot" = "$target" ] || die "$HOST booted slot $slot, not $target: the new slot didn't come up"
echo "ota: $HOST is on slot $target, build $build. superbird-slot-ok marks it healthy about a minute after boot."
