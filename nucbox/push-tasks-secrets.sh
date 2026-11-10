#!/usr/bin/env bash
# Gives the NucBox's tasks service its two tokens, from this Mac, the way the
# smart mirror moves its secrets: over ssh's stdin, never printed, never in a
# command line or the repo.
#
#   nucbox/push-tasks-secrets.sh <the NucBox's LAN address>
#
# - TICKTICK_TOKEN: the mirror's own TickTick API token, read from the mirror
#   (ssh $MIRROR_SSH, ~/.config/mirror/mirror.env), or from the env file
#   MIRROR_ENV names (e.g. the smart-mirror repo's .env) when that is set.
# - PANEL_TOKEN: what the Car Thing shows the NucBox. Made once, then reused
#   from ~/.config/claude-panel/tasks.json.
#
# On the NucBox both go in C:\ProgramData\car-thing-panel\tasks.env, readable
# only by you, SYSTEM and Administrators, and the tasks service is restarted.
# On this Mac, ~/.config/claude-panel/tasks.json (mode 600) gets the
# service's address and the panel token; re-provision the Car Thing after
# (device/scripts/provision.sh) so it gets them.
#
# NUCBOX_SSH (default nucbox) and MIRROR_SSH (default mirror.local) are ssh
# host names. Run nucbox/install.ps1 on the NucBox first.
set -euo pipefail

die() { echo "push-tasks-secrets: $*" >&2; exit 1; }
[ $# -eq 1 ] || die "usage: $0 <the NucBox's LAN address, e.g. 192.168.1.22>"
ADDR="$1"
NUCBOX_SSH="${NUCBOX_SSH:-nucbox}"
MIRROR_SSH="${MIRROR_SSH:-mirror.local}"
CFG="$HOME/.config/claude-panel"
TASKS_JSON="$CFG/tasks.json"
umask 077
mkdir -p "$CFG"

if [ -n "${MIRROR_ENV:-}" ]; then
  line=$(grep -E '^TICKTICK_TOKEN=' "$MIRROR_ENV" | tail -n 1 || true)
else
  line=$(ssh "$MIRROR_SSH" "grep -E '^TICKTICK_TOKEN=' ~/.config/mirror/mirror.env | tail -n 1" || true)
fi
tt="${line#TICKTICK_TOKEN=}"
tt="${tt%\"}"; tt="${tt#\"}"
[ -n "$tt" ] || die "no TICKTICK_TOKEN found (in ${MIRROR_ENV:-$MIRROR_SSH:~/.config/mirror/mirror.env})"
unset line

panel=""
if [ -f "$TASKS_JSON" ]; then
  panel=$(node -e 'try { process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).token || "")) } catch {}' "$TASKS_JSON")
fi
[ -n "$panel" ] || panel=$(openssl rand -hex 24)

# The NucBox's shell is PowerShell. The script goes base64-encoded, so no
# quoting survives or breaks on the way; the tokens come in on stdin.
read -r -d '' PS <<'PS1' || true
$ProgressPreference = 'SilentlyContinue'   # else its progress records print as CLIXML
$t = [Console]::In.ReadToEnd()
$root = Join-Path $env:ProgramData 'car-thing-panel'
$f = Join-Path $root 'tasks.env'
New-Item -ItemType Directory -Force $root | Out-Null
Set-Content -Path $f -Value $t -NoNewline
icacls $f /inheritance:r /grant:r "${env:USERNAME}:(R,W)" 'SYSTEM:(F)' 'Administrators:(F)' | Out-Null
$task = 'Car Thing panel - Tasks'
if (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $task
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -like '*car-thing-panel\tasks-service.js*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Start-ScheduledTask -TaskName $task
  'tasks.env written; tasks service restarted.'
} else {
  'tasks.env written. Run install.ps1 on the NucBox to start the tasks service.'
}
PS1
enc=$(printf '%s' "$PS" | iconv -f UTF-8 -t UTF-16LE | base64 | tr -d '\n')
printf 'TICKTICK_TOKEN=%s\nPANEL_TOKEN=%s\n' "$tt" "$panel" | ssh "$NUCBOX_SSH" "powershell -NoProfile -NonInteractive -EncodedCommand $enc"
unset tt

node -e '
const fs = require("fs");
const [file, addr, token] = process.argv.slice(1);
let prev = {};
try { prev = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
fs.writeFileSync(file, JSON.stringify(Object.assign(prev, { url: "http://" + addr + ":8791", token }), null, 2) + "\n", { mode: 0o600 });
' "$TASKS_JSON" "$ADDR" "$panel"
chmod 600 "$TASKS_JSON"
unset panel

# The service answers with the token it was given: one check, nothing printed.
code=$(node -e '
const [file] = process.argv.slice(1);
const c = JSON.parse(require("fs").readFileSync(file, "utf8"));
setTimeout(() => fetch(c.url + "/focus", { headers: { Authorization: "Bearer " + c.token }, signal: AbortSignal.timeout(5000) })
  .then((r) => console.log(r.status), () => console.log("unreachable")), 2000);
' "$TASKS_JSON")
echo "wrote $TASKS_JSON. The tasks service at http://$ADDR:8791 answers: $code (200 is right)."
echo "Next: re-provision the Car Thing (device/scripts/provision.sh <its address>)."
