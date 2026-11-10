#!/usr/bin/env bash
# Removes the LaunchAgent mac/install.sh added. Hooks are yours to remove:
#   node mac-service/scripts/uninstall-hooks.js
set -uo pipefail
cd "$(dirname "$0")/.."

PLIST="$HOME/Library/LaunchAgents/com.claudepanel.service.plist"
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }

if [ -f "$PLIST" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  ok "LaunchAgent removed; the service is stopped"
else
  ok "no LaunchAgent installed"
fi
