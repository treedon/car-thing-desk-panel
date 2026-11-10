// Removes all of the panel's hook entries from ~/.claude/settings.json.

import fs from 'node:fs';
import { CLAUDE_SETTINGS, PORT } from '../src/config.js';

const BASE = `:${PORT}/hook`;
const OURS = (h) => { const j = JSON.stringify(h); return j.includes(BASE) || j.includes('rewake-hook.js'); };
const countOurs = (list) => list.reduce((n, g) => n + (Array.isArray(g.hooks) ? g.hooks.filter(OURS).length : 0), 0);
// Our hooks leave each matcher group; the owner's in the same group stay.
function withoutOurs(list) {
  return list
    .map((g) => (Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((h) => !OURS(h)) } : g))
    .filter((g) => !Array.isArray(g.hooks) || g.hooks.length);
}

let settings;
try { settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8')); } catch {
  console.log('no settings.json — nothing to do');
  process.exit(0);
}

const backup = `${CLAUDE_SETTINGS}.claude-panel-backup-${Date.now()}`;
fs.copyFileSync(CLAUDE_SETTINGS, backup);

let removed = 0;
for (const event of Object.keys(settings.hooks || {})) {
  removed += countOurs(settings.hooks[event]);
  settings.hooks[event] = withoutOurs(settings.hooks[event]);
  if (settings.hooks[event].length === 0) delete settings.hooks[event];
}

const tmp = `${CLAUDE_SETTINGS}.claude-panel-${process.pid}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
fs.renameSync(tmp, CLAUDE_SETTINGS);
console.log(`removed ${removed} panel hook entr${removed === 1 ? 'y' : 'ies'}`);
console.log(`backup: ${backup}`);
