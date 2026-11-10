#!/usr/bin/env bash
# provision.sh --dry-run writes the device's /opt/panel files into a folder,
# from a fake home, and never prints a secret.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
fail=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }

home=$(mktemp -d); out=$(mktemp -d)
mkdir -p "$home/.config/claude-panel" "$home/.ssh"
echo "lan-token-123" > "$home/.config/claude-panel/token"
printf '{"url":"http://192.168.1.27:8123","token":"ha-secret-456","home":["light.desk"],"audio":[]}' > "$home/.config/claude-panel/ha.json"
printf 'network={\n  ssid="Home"\n  psk="wifi-secret-789"\n}\n' > "$home/.config/claude-panel/wifi.conf"
echo "ssh-ed25519 AAAAfake owner@mac" > "$home/.ssh/id_ed25519.pub"

log=$(HOME="$home" PANEL_MAC_HOST=my-mac.local "$here/../scripts/provision.sh" --dry-run "$out" desk-panel.local 2>&1)
code=$?
cfg="$out/opt/panel/panel-config.js"

check "exits 0" "[ $code -eq 0 ]"
check "panel-config points at the Mac service with the LAN token" "grep -q 'ws://my-mac.local:8790/ws' '$cfg' && grep -q 'lan-token-123' '$cfg'"
check "panel-config carries Home Assistant and the recorder" "grep -q 'ha-secret-456' '$cfg' && grep -q 'http://127.0.0.1:8095' '$cfg'"
check "wifi.conf is a complete wpa_supplicant config with the owner's network" "grep -q '^ctrl_interface=' '$out/opt/panel/wifi.conf' && grep -q 'wifi-secret-789' '$out/opt/panel/wifi.conf'"
check "authorized_keys holds the owner's public key" "grep -q 'AAAAfake' '$out/opt/panel/authorized_keys'"
check "every file is mode 600" "[ -z \"\$(find '$out/opt/panel' -type f ! -perm 600)\" ]"
check "no secret is printed" "! printf '%s' \"\$log\" | grep -qE 'lan-token-123|ha-secret-456|wifi-secret-789'"

# The device gets ha.json as the simulator does, normalised: a NucBox section
# without its defaults still draws (busy needs busyGpuPct; the view reads temps).
printf '{"url":"http://192.168.1.27:8123/","token":"ha-secret-456","nucbox":{"lmstudio":"http://192.168.1.22:1235","cpuLoad":"sensor.cpu","memory":"sensor.mem","temps":["sensor.cpu_temp"]}}' > "$home/.config/claude-panel/ha.json"
out4=$(mktemp -d)
HOME="$home" PANEL_MAC_HOST=my-mac.local "$here/../scripts/provision.sh" --dry-run "$out4" desk-panel.local >/dev/null 2>&1
nb=$(node -e 'global.window = {}; require(process.argv[1]); const h = window.PANEL_CONFIG.ha; console.log([h.url, h.nucbox.busyGpuPct, JSON.stringify(h.nucbox.temps)].join(" "))' "$out4/opt/panel/panel-config.js" 2>&1)
want='http://192.168.1.27:8123 40 [{"entity":"sensor.cpu_temp","name":null}]'
check "ha.json reaches the device normalised, with the NucBox defaults" '[ "$nb" = "$want" ]'

# The NucBox's tasks service reaches the device from tasks.json; without it, null.
tk=$(node -e 'global.window = {}; require(process.argv[1]); console.log(JSON.stringify(window.PANEL_CONFIG.tasks))' "$out4/opt/panel/panel-config.js" 2>&1)
check "without tasks.json the Tasks page is unset" '[ "$tk" = "null" ]'
printf '{"url":"http://192.168.1.22:8791","token":"tasks-secret-321","list":"Work"}' > "$home/.config/claude-panel/tasks.json"
out5=$(mktemp -d)
log5=$(HOME="$home" PANEL_MAC_HOST=my-mac.local "$here/../scripts/provision.sh" --dry-run "$out5" desk-panel.local 2>&1)
tk=$(node -e 'global.window = {}; require(process.argv[1]); console.log(JSON.stringify(window.PANEL_CONFIG.tasks))' "$out5/opt/panel/panel-config.js" 2>&1)
check "tasks.json reaches the device as {url, token}" '[ "$tk" = "{\"url\":\"http://192.168.1.22:8791\",\"token\":\"tasks-secret-321\"}" ]'
check "the tasks token is not printed" "! printf '%s' \"\$log5\" | grep -q tasks-secret-321"
rm -f "$home/.config/claude-panel/tasks.json"

# The NucBox's session service reaches the device from nucbox-sessions.json.
printf '{"url":"ws://192.168.1.22:8790/ws","token":"nucsess-secret-654"}' > "$home/.config/claude-panel/nucbox-sessions.json"
out6=$(mktemp -d)
log6=$(HOME="$home" PANEL_MAC_HOST=my-mac.local "$here/../scripts/provision.sh" --dry-run "$out6" desk-panel.local 2>&1)
ns=$(node -e 'global.window = {}; require(process.argv[1]); console.log(JSON.stringify(window.PANEL_CONFIG.nucboxSessions))' "$out6/opt/panel/panel-config.js" 2>&1)
check "nucbox-sessions.json reaches the device as {url, token}" '[ "$ns" = "{\"url\":\"ws://192.168.1.22:8790/ws\",\"token\":\"nucsess-secret-654\"}" ]'
check "the NucBox session token is not printed" "! printf '%s' \"\$log6\" | grep -q nucsess-secret-654"
rm -f "$home/.config/claude-panel/nucbox-sessions.json"

# Tethered over USB before the Wi-Fi adapter arrives: no wifi.conf yet.
rm -f "$home/.config/claude-panel/wifi.conf"
out2=$(mktemp -d)
HOME="$home" PANEL_MAC_HOST=10.42.1.1 "$here/../scripts/provision.sh" --dry-run "$out2" 10.42.1.2 >/dev/null 2>&1
code=$?
check "without Wi-Fi settings it still provisions the panel" "[ $code -eq 0 ] && grep -q 'ws://10.42.1.1:8790/ws' '$out2/opt/panel/panel-config.js'"
check "without Wi-Fi settings it writes no wifi.conf" "[ ! -e '$out2/opt/panel/wifi.conf' ]"

check "without Wi-Fi settings it is not tethered" "[ ! -e '$out2/opt/panel/tethered' ]"

# --tethered: the panel reaches the Mac over the cable, and no SSH key is needed yet.
rm -f "$home/.ssh/id_ed25519.pub"
out3=$(mktemp -d)
HOME="$home" PANEL_MAC_HOST=10.42.1.246 "$here/../scripts/provision.sh" --dry-run "$out3" --tethered 10.42.1.242 >/dev/null 2>&1
code=$?
check "--tethered without an SSH key still provisions" "[ $code -eq 0 ] && grep -q 'ws://10.42.1.246:8790/ws' '$out3/opt/panel/panel-config.js'"
check "--tethered writes the tethered flag and no authorized_keys" "[ -e '$out3/opt/panel/tethered' ] && [ ! -e '$out3/opt/panel/authorized_keys' ]"
HOME="$home" PANEL_MAC_HOST=my-mac.local "$here/../scripts/provision.sh" --dry-run "$(mktemp -d)" desk-panel.local >/dev/null 2>&1
check "over Wi-Fi an SSH key is still required" "[ $? -ne 0 ]"

exit $fail
