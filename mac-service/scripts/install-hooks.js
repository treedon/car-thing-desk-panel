// Merges the panel's hooks into ~/.claude/settings.json (backup written).
// Uses Claude Code's native type:"http" hooks POSTing to the daemon's bare
// /hook endpoint (event identified by hook_event_name in the payload).
// Failures are non-blocking for Claude Code, and the PermissionRequest flow
// answers "ask" whenever the daemon is absent or silent, so the terminal
// prompt always remains the fallback.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLAUDE_SETTINGS, PORT, HOOK_TIMEOUT_S } from '../src/config.js';

// Questions and plans are held while the panel answers them (question-bridge.js):
// up to 120 s for an interactive session, up to BG_HOLD_MS (590 s) for a
// windowless background one. The hook's own timeout must outlast the longer hold.
const PROMPT_HOOK_TIMEOUT_S = 600;

// Wakes an idle session with a message dictated on the panel (asyncRewake: a
// background Stop hook; exit 2 wakes Claude). Its own timeout ends the wait.
const REWAKE_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'rewake-hook.js');
const REWAKE_TIMEOUT_S = 3600;
const rewakeHook = {
  matcher: '*',
  hooks: [{ type: 'command', command: `"${process.execPath}" "${REWAKE_SCRIPT}" ${PORT}`, asyncRewake: true, timeout: REWAKE_TIMEOUT_S }],
};
const OURS = (h) => { const j = JSON.stringify(h); return j.includes(`:${PORT}/hook`) || j.includes('rewake-hook.js'); };
// Removes our hooks from each matcher group, keeping any of the owner's that
// share a group with them; a group left empty goes.
function withoutOurs(list) {
  return (list || [])
    .map((g) => (Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((h) => !OURS(h)) } : g))
    .filter((g) => !Array.isArray(g.hooks) || g.hooks.length);
}

const HOOK_URL = `http://127.0.0.1:${PORT}/hook`;

function httpHook(timeout) {
  return { matcher: '*', hooks: [{ type: 'http', url: HOOK_URL, timeout }] };
}

const EVENTS = {
  PermissionRequest: httpHook(HOOK_TIMEOUT_S),   // held up to 20 s (interactive) or 590 s (background sessions)
  SessionStart: httpHook(5),
  SessionEnd: httpHook(3),
  UserPromptSubmit: httpHook(5),
  PreToolUse: [
    httpHook(5),
    { matcher: 'AskUserQuestion|ExitPlanMode', hooks: [{ type: 'http', url: `${HOOK_URL}?hold=1`, timeout: PROMPT_HOOK_TIMEOUT_S }] },
  ],
  PostToolUse: httpHook(5),
  Stop: [httpHook(5), rewakeHook],
  // A turn that ends in an API error fires this instead of Stop.
  StopFailure: httpHook(5),
};

// A settings file that exists but does not parse (hand-edited, mid-write) is
// never replaced: writing hooks-only settings would lose everything else in it.
let settings = {};
if (fs.existsSync(CLAUDE_SETTINGS)) {
  try {
    settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8'));
  } catch (err) {
    console.error(`could not read ${CLAUDE_SETTINGS} as JSON (${err.message}); nothing was changed. Fix the file and run this again.`);
    process.exit(1);
  }
}

const backup = `${CLAUDE_SETTINGS}.claude-panel-backup-${Date.now()}`;
if (fs.existsSync(CLAUDE_SETTINGS)) fs.copyFileSync(CLAUDE_SETTINGS, backup);

settings.hooks = settings.hooks || {};
for (const [event, entry] of Object.entries(EVENTS)) {
  const list = settings.hooks[event] = settings.hooks[event] || [];
  // remove any previous entry of ours (old curl or http form), then add
  settings.hooks[event] = withoutOurs(list);
  for (const e of [].concat(entry)) settings.hooks[event].push(e);
}
// sweep stale claude-thing entries from events we no longer register
for (const event of Object.keys(settings.hooks)) {
  if (!EVENTS[event]) {
    settings.hooks[event] = withoutOurs(settings.hooks[event]);
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
}

// Written whole and renamed into place, so Claude Code never reads half a file.
const tmp = `${CLAUDE_SETTINGS}.claude-panel-${process.pid}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
fs.renameSync(tmp, CLAUDE_SETTINGS);
console.log(`hooks installed into ${CLAUDE_SETTINGS}`);
console.log(`backup: ${backup}`);
console.log('note: hooks apply to Claude Code sessions started from now on.');
