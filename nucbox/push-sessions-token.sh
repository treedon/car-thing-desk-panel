#!/usr/bin/env bash
# Brings the NucBox's session-service token to this Mac, for the Car Thing to
# reach the Claude Code sessions on the NucBox. Read over ssh, never printed.
#
#   nucbox/push-sessions-token.sh <the NucBox's LAN address>
#
# Writes ~/.config/claude-panel/nucbox-sessions.json (mode 600):
# {"url":"ws://<address>:8790/ws","token":"…"}. Re-provision the Car Thing
# after (device/scripts/provision.sh) so it gets it. NUCBOX_SSH (default
# nucbox) is the ssh host name. Run install.ps1 -ClaudeSessions first: the
# service makes its token the first time it starts.
set -euo pipefail

die() { echo "push-sessions-token: $*" >&2; exit 1; }
[ $# -eq 1 ] || die "usage: $0 <the NucBox's LAN address, e.g. 192.168.1.22>"
ADDR="$1"
NUCBOX_SSH="${NUCBOX_SSH:-nucbox}"
CFG="$HOME/.config/claude-panel"
OUT="$CFG/nucbox-sessions.json"
umask 077
mkdir -p "$CFG"

# The NucBox's shell is PowerShell; the script goes base64-encoded.
PS='$ProgressPreference = "SilentlyContinue"; $f = Join-Path $env:USERPROFILE ".config\claude-panel\token"; if (Test-Path $f) { (Get-Content $f -Raw).Trim() }'
enc=$(printf '%s' "$PS" | iconv -f UTF-8 -t UTF-16LE | base64 | tr -d '\n')
token=$(ssh "$NUCBOX_SSH" "powershell -NoProfile -NonInteractive -EncodedCommand $enc" | tr -d '\r\n')
[ -n "$token" ] || die "no token on the NucBox yet: run install.ps1 -ClaudeSessions there, and check its task started"

printf '%s' "$token" | node -e '
const fs = require("fs");
const [file, addr] = process.argv.slice(1);
let token = "";
process.stdin.on("data", (d) => { token += d; }).on("end", () => {
  fs.writeFileSync(file, JSON.stringify({ url: "ws://" + addr + ":8790/ws", token: token.trim() }, null, 2) + "\n", { mode: 0o600 });
});
' "$OUT" "$ADDR"
chmod 600 "$OUT"
unset token
echo "wrote $OUT. Next: re-provision the Car Thing (device/scripts/provision.sh <its address>)."
