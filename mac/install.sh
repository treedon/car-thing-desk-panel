#!/usr/bin/env bash
# Starts the Mac service at login and restarts it if it dies (a LaunchAgent).
# Does NOT touch Claude Code's hooks: install those yourself with
#   node mac-service/scripts/install-hooks.js
#
#   ./mac/install.sh
#
# Undo with ./mac/uninstall.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

LABEL="com.claudepanel.service"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

say()  { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }

say "Checking prerequisites"
command -v node >/dev/null || die "node not found — install Node 22 or newer"
ok "node $(node -v)"
command -v claude >/dev/null || die "the 'claude' CLI is not on PATH — install Claude Code first"
ok "claude $(claude --version 2>/dev/null | head -1)"

say "Installing dependencies"
npm --prefix mac-service install --no-audit --no-fund >/dev/null
ok "mac-service"

if curl -sf http://127.0.0.1:8790/status | grep -q '"service":"claude-panel"'; then
  :
elif curl -sf http://127.0.0.1:8790/status >/dev/null; then
  die "something else answers on port 8790 (an old claude-thing daemon?) — stop it first"
fi

say "LaunchAgent"
mkdir -p "$HOME/Library/LaunchAgents" mac-service/logs
# A LaunchAgent inherits almost no PATH, so bake in where node and claude live.
AGENT_PATH="$(dirname "$(command -v node)"):$(dirname "$(command -v claude)"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
sed -e "s|__NODE__|$(command -v node)|g" \
    -e "s|__ROOT__|$ROOT|g" \
    -e "s|__PATH__|$AGENT_PATH|g" \
    mac/com.claudepanel.service.plist.template > "$PLIST"
ok "wrote $PLIST"

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
ok "loaded — the service now starts at login"

for _ in $(seq 1 40); do
  curl -sf http://127.0.0.1:8790/status >/dev/null && break
  sleep 0.25
done
if curl -sf http://127.0.0.1:8790/status >/dev/null; then
  ok "service answering on http://127.0.0.1:8790"
else
  warn "service did not answer yet — check mac-service/logs/launchd.err.log"
fi

say "Done"
cat <<MSG
  Hooks (once, by you):  node mac-service/scripts/install-hooks.js
  Simulator:             npm run sim
  LAN token for the Car Thing: ~/.config/claude-panel/token
MSG
