// Starting a background Claude Code session from the panel: which folders it may start in, and the one
// command that starts it.
//
// The panel never names a folder of its own. It is offered the Mac's recent projects (read from the
// transcripts Claude Code keeps), and a start is accepted only for a path that list returns at that
// moment. The prompt reaches `claude` as a single argument after `--`, never through a shell, and it can
// never be read as an option. On the Mac the command runs as its own one-shot launchd job (launchd-run.js)
// rather than as this service's child, so macOS holds Claude Code, not node, responsible for what the
// session touches; elsewhere it is a plain execFile.
//
// A started session is deliberately NOT marked with markOwnSession (own-sessions.js): that set exists
// to hide the daemon's own spawns from the panel, and this is a session the owner wants to see.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultRunner } from './launchd-run.js';
import { isOwnSession } from './own-sessions.js';
import { log } from './log.js';

export const RECENT_LIMIT = 5;
export const MAX_PROMPT_CHARS = 2000;

// How much of a transcript is searched for its cwd. It is on the first records Claude Code writes, so
// this is generous; a transcript whose cwd is further in is dropped rather than read in full.
const HEAD_BYTES = 200 * 1024;
const START_TIMEOUT_MS = 30_000;
// How many started short ids the service remembers (see started() below). Same idea as own-sessions.js.
const MAX_STARTED = 40;

// Scratch folders: a project the owner opened there once is not one they will start work in again.
// macOS (/tmp, /private/tmp, /var/folders, /var/tmp) and Windows (...\AppData\Local\Temp, C:\Temp,
// C:\Windows\Temp), judged on the path alone.
export function isTempPath(p) {
  const s = String(p).replace(/\\/g, '/');
  return /^\/(private\/)?(tmp|var\/tmp|var\/folders)(\/|$)/.test(s)
    || /^[a-z]:\/(windows\/)?temp(\/|$)/i.test(s)
    || /\/appdata\/local\/temp(\/|$)/i.test(s);
}

// The first "cwd" in the head of a transcript, unescaped; null when there is none (or no such file).
// That is the folder the session started in: a session can later move into a git worktree, and the
// registry and the store then report the worktree, but the first record never changes.
export function transcriptCwd(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(buf.toString('utf8', 0, n));
    return m ? JSON.parse(`"${m[1]}"`) : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

// Each project folder's newest transcript, newest first. Transcripts of the daemon's own sessions are
// not counted: they say nothing about where the owner works.
function newestTranscripts(projectsDir, isOwn) {
  let folders;
  try { folders = fs.readdirSync(projectsDir, { withFileTypes: true }); } catch { return []; }
  const found = [];
  for (const folder of folders) {
    if (!folder.isDirectory()) continue;
    const dir = path.join(projectsDir, folder.name);
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    let best = null;
    for (const name of names) {
      if (!name.endsWith('.jsonl') || isOwn(name.slice(0, -'.jsonl'.length))) continue;
      let st;
      try { st = fs.statSync(path.join(dir, name)); } catch { continue; }
      if (st.isFile() && (!best || st.mtimeMs > best.mtimeMs)) best = { file: path.join(dir, name), mtimeMs: st.mtimeMs };
    }
    if (best) found.push(best);
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// ~/.claude.json, parsed; {} when it cannot be read. Read only: the service never writes it.
function readClaudeConfigFile() {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')) || {}; } catch { return {}; }
}

// How a project's paths are handled, by platform. A transcript's cwd, ~/.claude.json's keys and home are
// all the same kind of path on one machine, but they are not spelled alike: on the NucBox the cwd reads
// `c:\Users\owner\x`, the keys `c:/Users/owner/x` and home `C:\Users\owner`, and Windows ignores case.
// So on win32 two paths are the same folder when `trustKey` gives the same string; on the Mac a path is
// compared exactly as it is written.
function pathKit(platform) {
  if (platform === 'win32') {
    return {
      P: path.win32,
      trustKey: (p) => String(p).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, ''),
    };
  }
  return { P: path.posix, trustKey: (p) => p };
}

// A full Windows path of the kind the NucBox's helper (nucbox/open-in-vscode.ps1) accepts: a drive letter
// or a share, not "\x" or "/c/x" (path.win32.isAbsolute takes both) and not "c:x"; no character Windows
// never allows in a path; and not a drive or share root. The helper answers `bad-request` to anything
// else, and by then a move has stopped the agent, so a folder it would refuse must never be handed to it.
function isHelperPath(p) {
  if (!/^(?:[A-Za-z]:[\\/]|\\\\[^\\/])/.test(p) || /[<>"|\x00-\x1f]/.test(p)) return false;
  const bare = (s) => s.replace(/[\\/]+$/, '');
  return bare(p) !== bare(path.win32.parse(p).root);
}

// The folder to open VS Code on for a session: the one it started in, read from its transcript, because
// that is the window that hosts it. Its current folder is the wrong one once the session has moved into a
// git worktree: opening that starts a second window, and the session then reads as "open elsewhere".
// `files` is where the transcript may be (a path, or a list of them to try in turn: Claude Code moves a
// transcript into the worktree's project folder, so the path a hook reported can be gone). The first one
// to give a start folder that is a full path (on win32, one the helper takes) and still exists wins; with
// none, `fallback` is the session's current folder. `platform` says what kind of path the transcripts
// hold (see pathKit). `exists` is injected the way recentProjects takes it.
export function sessionStartFolder(files, fallback, { platform = process.platform, exists = fs.existsSync } = {}) {
  const usable = platform === 'win32' ? isHelperPath : pathKit(platform).P.isAbsolute;
  for (const file of [].concat(files || [])) {
    const start = file ? transcriptCwd(file) : null;
    if (start && usable(start) && exists(start)) return start;
  }
  return fallback;
}

// ~/.claude.json's `projects`, as a lookup from trustKey to the entry. An entry that is not an object
// does not count as one.
function entriesByKey(projects, trustKey) {
  const entries = new Map();
  for (const [key, entry] of Object.entries(projects)) {
    const k = trustKey(key);
    if (entry && typeof entry === 'object' && !entries.has(k)) entries.set(k, entry);
  }
  return entries;
}

// Whether `claude --bg` will start in this folder. A folder's own entry in ~/.claude.json decides, even
// an explicit false under a trusted parent. With no entry of its own it takes the nearest ancestor's.
// Home is never consulted for a folder below it: Claude Code does not persist trust for home itself.
// (A folder outside home has no home to stop at, so its ancestors are all consulted.)
function isTrusted(entries, folder, home, { P, trustKey }) {
  if (!entries) return false;
  const homeKey = trustKey(home);
  const own = entries.get(trustKey(folder));
  if (own) return own.hasTrustDialogAccepted === true;
  let dir = folder;
  for (;;) {
    const parent = P.dirname(dir);
    if (parent === dir || trustKey(dir) === homeKey || trustKey(parent) === homeKey) return false;
    const entry = entries.get(trustKey(parent));
    if (entry) return entry.hasTrustDialogAccepted === true;
    dir = parent;
  }
}

// The owner's most recent projects: [{ name, path, lastUsed, trusted }], newest first.
//   name      the folder's own name, for the panel's row
//   lastUsed  ms since the epoch, from the newest transcript's modified time
//   trusted   whether Claude Code will run in it in the background (see isTrusted); false whenever
//             ~/.claude.json cannot be read
// Temp folders, folders that no longer exist and the daemon's own sessions are left out, and a path
// appears once, with its newest time. `platform` says what kind of paths the transcripts and
// ~/.claude.json hold (see pathKit); a test passes it to read Windows paths on the Mac.
export function recentProjects({
  projectsDir, exists = fs.existsSync, limit = RECENT_LIMIT, isOwn = isOwnSession,
  readClaudeConfig = readClaudeConfigFile, home = os.homedir(), platform = process.platform,
}) {
  const kit = pathKit(platform);
  const seen = new Set();
  const out = [];
  for (const { file, mtimeMs } of newestTranscripts(projectsDir, isOwn)) {
    if (out.length >= limit) break;
    const cwd = transcriptCwd(file);
    // A relative cwd would be resolved against the service's own folder: not a project.
    if (!cwd || !kit.P.isAbsolute(cwd) || seen.has(cwd) || isTempPath(cwd) || !exists(cwd)) continue;
    seen.add(cwd);
    out.push({ name: kit.P.basename(cwd) || cwd, path: cwd, lastUsed: Math.round(mtimeMs) });
  }
  if (!out.length) return out;
  let projects = null;
  try {
    const cfg = readClaudeConfig();
    if (cfg && cfg.projects && typeof cfg.projects === 'object' && !Array.isArray(cfg.projects)) projects = cfg.projects;
  } catch {}
  const entries = projects && entriesByKey(projects, kit.trustKey);
  return out.map((p) => ({ ...p, trusted: isTrusted(entries, p.path, home, kit) }));
}

// `claude --bg` prints `backgrounded · <8-hex short id> · <name>` once the job is running.
export function parseBackgrounded(stdout) {
  const m = /backgrounded\s+·\s+([0-9a-f]{8})\b/.exec(String(stdout ?? ''));
  return m ? m[1] : null;
}

// Everything after `--` is the prompt, whatever it looks like. Always auto mode: never a mode that
// skips the checks.
export function startArgs(prompt) {
  return ['--bg', '--permission-mode', 'auto', '--', prompt];
}

// The prompt to send, trimmed; throws the error code the panel is told when it is unusable.
function checkedPrompt(prompt) {
  const text = typeof prompt === 'string' ? prompt.trim() : '';
  if (!text) throw new Error('empty-prompt');
  if (text.length > MAX_PROMPT_CHARS) throw new Error('prompt-too-long');
  return text;
}

// The short ids of the sessions this service started, bounded: oldest dropped first.
//
// A new session's hooks can reach the service before the poller has told the store it is a background
// job (the poller tags `kind` every few seconds), and an ask in that gap would be treated as an
// interactive window's. started() lets the bridges know it from the first moment. A session id starts
// with its job's short id.
function createStartedIds() {
  const ids = new Set();
  return {
    remember(shortId) {
      ids.delete(shortId);
      ids.add(shortId);
      while (ids.size > MAX_STARTED) ids.delete(ids.values().next().value);
    },
    has: (sessionId) => typeof sessionId === 'string' && ids.has(sessionId.slice(0, 8)),
  };
}

// `recent` is the function that lists the folders a session may start in; it is returned as it is, so
// the real starter and the demo one share a shape. `run` has execFile's signature: launchd on the Mac,
// execFile elsewhere (launchd-run.js defaultRunner); a test passes a fake.
export function createStarter({ recent, run = defaultRunner(), claudeBin = 'claude' }) {
  const startedIds = createStartedIds();

  async function start({ path: folder, prompt } = {}) {
    const text = checkedPrompt(prompt);
    let project;
    try { project = (await recent()).find((p) => p.path === folder); } catch { throw new Error('start-failed'); }
    if (!project) throw new Error('not-a-recent-project');

    const { err, stdout, stderr } = await new Promise((resolve) => {
      try {
        const child = run(claudeBin, startArgs(text), { cwd: project.path, timeout: START_TIMEOUT_MS },
          (e, out, errOut) => resolve({ err: e, stdout: out, stderr: errOut }));
        // Nothing is ever typed into it: give it end-of-input rather than a pipe that stays open.
        if (child && child.stdin) child.stdin.end();
      } catch (e) {
        resolve({ err: e }); // e.g. an argument execFile refuses outright
      }
    });

    if (err) {
      // 'start-unconfirmed' is "it may be running": the process was killed or ran out its 30 s, and the
      // daemon may already have the job. A non-zero exit that nothing killed, or a process that never
      // spawned, ran nothing: 'start-failed', which the panel may offer again.
      const unconfirmed = Boolean(err.killed || err.signal) || err.code === 'ETIMEDOUT';
      const code = `${stderr || ''}\n${err.stderr || ''}`.includes('Workspace not trusted') ? 'not-trusted'
        : unconfirmed ? 'start-unconfirmed' : 'start-failed';
      log('NS', `start failed in ${project.name}: ${code === 'not-trusted' ? code : `${code} (${err.code ?? err.signal ?? 'error'})`}`);
      throw new Error(code);
    }
    const shortId = parseBackgrounded(stdout);
    if (!shortId) {
      // Exit 0 and nothing the service can read: the job may well be running.
      log('NS', `start failed in ${project.name}: start-unconfirmed (no job in the output)`);
      throw new Error('start-unconfirmed');
    }
    startedIds.remember(shortId);
    log('NS', `started ${shortId} in ${project.name}`);
    return { shortId };
  }

  return { recent, start, started: startedIds.has };
}

// ---- demo mode (CLAUDE_THING_MOCK=1) -------------------------------------------------------------------

const DAY_MS = 24 * 3600_000;
// Five fixed projects, newest first, last used over the last few days. None has to exist.
const DEMO_PROJECTS = [
  ['Spotify_car_thing', 0.1], ['home-assistant', 0.8], ['nocturne-ui', 1.5], ['api-server', 2.6], ['docs-site', 3.9],
];

// Starts nothing: records a background session in the store, as the real one would appear.
export function createMockStarter({ store }) {
  const startedIds = createStartedIds();
  const recent = () => DEMO_PROJECTS.map(([name, daysAgo]) => ({
    name, path: `/Users/demo/Projects/${name}`, lastUsed: Date.now() - Math.round(daysAgo * DAY_MS), trusted: true,
  }));

  async function start({ path: folder, prompt } = {}) {
    const text = checkedPrompt(prompt);
    const project = recent().find((p) => p.path === folder);
    if (!project) throw new Error('not-a-recent-project');
    const shortId = randomUUID().slice(0, 8);
    const id = shortId + randomUUID().slice(8); // UUID-shaped, as the real session ids are
    store.upsert(id, { kind: 'background', jobId: shortId, cwd: project.path, lastPrompt: text, lastMessage: text, thinking: true });
    startedIds.remember(shortId);
    return { shortId };
  }

  return { recent, start, started: startedIds.has };
}
