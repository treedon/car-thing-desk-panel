// Bring a session's terminal window to the front, as if the user clicked it.
//
// Chain: session_id → ~/.claude/sessions/<pid>.json → pid → tty → Terminal.app
// tab. Terminal.app is the only mainstream emulator that exposes `tty` on its
// tabs, so other emulators fall back to raising the app.
//
// Permissions: raising Terminal needs Automation → Terminal. Nothing here ever
// types: questions and plans are answered through hooks (question-bridge.js).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { CLAUDE_DIR } from './config.js';
import { log } from './log.js';

const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');

function osa(script, timeout = 5000) {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], { timeout }, (err, stdout, stderr) => {
      const text = String(stderr || '');
      if (err) {
        const denied = text.includes('-1743') || text.includes('Not authorized');
        resolve({ ok: false, denied, error: text.trim().split('\n')[0] || err.message });
      } else {
        resolve({ ok: true, out: String(stdout).trim() });
      }
    });
  });
}

function ps(args) {
  return new Promise((resolve) => {
    execFile('ps', args, { timeout: 4000 }, (err, stdout) => {
      resolve(err ? '' : String(stdout).trim());
    });
  });
}

function readRegistry(dir = SESSIONS_DIR) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
    } catch {}
  }
  return out;
}

// session_id -> {pid, cwd, kind, name} from Claude Code's own registry
export function lookupSession(sessionId, dir = SESSIONS_DIR) {
  for (const rec of readRegistry(dir)) {
    if (rec.sessionId === sessionId) return rec;
  }
  return null;
}

// A background job is not always windowless. When an interactive session hands
// its turn to one it writes `parkedJobId` into its own registry file, and while
// parked that window *is* the job's UI — the question the device is answering is
// on screen there. So before declaring a background agent unfocusable, look for
// the window parked on it and raise that instead.
//
// The job id is the short form of the background session's id, carried as
// `jobId`; older records only have the sessionId, hence the prefix match.
export function hostWindowFor(rec, dir = SESSIONS_DIR) {
  if (!rec) return null;
  const jobId = String(rec.jobId || '');
  const sid = String(rec.sessionId || '');
  if (!jobId && !sid) return null;
  for (const other of readRegistry(dir)) {
    if (other.kind !== 'interactive' || !other.parkedJobId) continue;
    const parked = String(other.parkedJobId);
    if (parked === jobId || parked === sid || (parked && sid.startsWith(parked))) return other;
  }
  return null;
}

async function ttyFor(pid) {
  const out = await ps(['-o', 'tty=', '-p', String(pid)]);
  const t = out.trim();
  if (!t || t === '??') return null;
  return t.startsWith('/dev/') ? t : `/dev/${t}`;
}

// walk up the process tree to whichever app owns the terminal
async function ownerApp(pid) {
  let current = pid;
  for (let i = 0; i < 8; i++) {
    const out = await ps(['-o', 'ppid=,comm=', '-p', String(current)]);
    if (!out) return null;
    const [ppidStr, ...commParts] = out.trim().split(/\s+/);
    const comm = commParts.join(' ');
    if (/Terminal\.app/.test(comm)) return 'Terminal';
    if (/iTerm/.test(comm)) return 'iTerm2';
    if (/Ghostty/.test(comm)) return 'Ghostty';
    if (/WezTerm/.test(comm)) return 'WezTerm';
    if (/Code Helper|Visual Studio Code/.test(comm)) return 'Code';
    const ppid = Number(ppidStr);
    if (!ppid || ppid <= 1) return null;
    current = ppid;
  }
  return null;
}

const TERMINAL_RAISE = (tty) => `
tell application "Terminal"
  set matched to false
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is "${tty}" then
        set selected of t to true
        set frontmost of w to true
        set matched to true
      end if
    end repeat
  end repeat
  if matched then activate
  return matched
end tell`;

// Which app a session runs in, from its process ancestry. readProc(pid) gives
// {ppid, comm} or null (or a promise of one); injected so the walk is testable
// without a process tree. Async so the real ps never blocks the service.
const MAX_HOST_DEPTH = 10;
export async function detectHost(pid, readProc) {
  let current = pid;
  for (let i = 0; i < MAX_HOST_DEPTH; i++) {
    const p = await readProc(current);
    if (!p) return 'unknown';
    if (/Code Helper|Visual Studio Code/.test(p.comm)) return 'vscode';
    if (/Terminal|iTerm|tmux|Ghostty|WezTerm/.test(p.comm)) return 'terminal';
    if (!p.ppid || p.ppid <= 1) return 'unknown';
    current = p.ppid;
  }
  return 'unknown';
}

export function readProc(pid) {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }, (err, stdout) => {
      const out = err ? '' : String(stdout).trim();
      const m = out.match(/^(\d+)\s+(.*)$/);
      resolve(m ? { ppid: Number(m[1]), comm: m[2] } : null);
    });
  });
}

// The Claude extension's link handler (/open?session=<uuid>) opens that
// session's tab in whichever VS Code window has focus — so the folder's
// window is raised first, and the link follows once it is in front.
const VSCODE_URI_DELAY_MS = 400;
const NO_RAISE_ON_NUCBOX = Object.freeze({ focused: false, reason: "can't raise windows on the NucBox" });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// `desktopOpener` (desktop-open.js) is the NucBox's only way to open anything: its service has no desktop
// of its own, so it asks a helper in the owner's session. Without one, the NucBox opens nothing.
export function createFocus({
  run = execFile, uriDelayMs = VSCODE_URI_DELAY_MS, platform = process.platform, sessionsDir = SESSIONS_DIR,
  desktopOpener = null,
} = {}) {
  let automationDenied = false;   // sticky: a denied TCC row never re-prompts

  // There is one frontmost window, so window raises run one at a time: two
  // arriving together must not leave the wrong window in front.
  let chain = Promise.resolve();
  function exclusive(fn) {
    const run = chain.then(() => fn());
    // The chain must survive a failed turn, so it tracks completion, not result.
    chain = run.then(() => {}, () => {});
    return run;
  }

  // VS Code: raise the window for the session's folder and nothing else. The
  // panel never types into VS Code, so the result is never `exact`.
  function openArgs(args) {
    return new Promise((resolve) => {
      run('open', args, { timeout: 5000 }, (err) => resolve(err ? String(err.message || err) : null));
    });
  }

  // `prompt`, when given, is put in the session's input box and not sent.
  async function openVsCode(cwd, sessionId, prompt) {
    // `open` is the Mac's. The NucBox's hand-off swaps in the desktop opener's own open (index.js).
    if (platform === 'win32') return NO_RAISE_ON_NUCBOX;
    const err = await openArgs(cwd ? ['-a', 'Visual Studio Code', cwd] : ['-a', 'Visual Studio Code']);
    if (err) return { focused: false, reason: err };
    if (sessionId && UUID_RE.test(sessionId)) {
      if (uriDelayMs) await new Promise((r) => setTimeout(r, uriDelayMs));
      const link = `vscode://anthropic.claude-code/open?session=${sessionId}`;
      await openArgs([prompt ? `${link}&prompt=${encodeURIComponent(prompt)}` : link]);
    }
    return { focused: true, app: 'Code', exact: false };
  }

  async function focusSession(sessionId, { host, cwd, kind } = {}) {
    // On the NucBox the service runs in the background, outside the desktop session, so it can't bring
    // a window forward itself. It can ask the helper to open a VS Code session, and only that. `host`
    // can't say which sessions those are: it reads 'vscode' for every session there, background ones
    // included, because nothing walks a process tree. `kind` alone can't either: `claude agents` says
    // 'interactive' for a `claude` run in a terminal too. So it takes an interactive session whose own
    // registry entry says VS Code started it (entrypoint 'claude-vscode'), and nothing else. Any other
    // session's process is still running somewhere, and a tab opened on it would put two processes on
    // one conversation; moving a background one is handoff.js, which stops it first.
    if (platform === 'win32') {
      if (kind !== 'interactive' || !desktopOpener) return NO_RAISE_ON_NUCBOX;
      const rec = lookupSession(sessionId, sessionsDir);
      if (!rec || rec.entrypoint !== 'claude-vscode') {
        // Logged, so a raise that does nothing after a deploy can be told apart from one that failed.
        const why = rec ? `entrypoint=${rec.entrypoint ?? 'none'}` : 'no registry entry';
        log('FC', `not raising ${String(sessionId).slice(0, 8)} on the NucBox: ${why}`);
        return NO_RAISE_ON_NUCBOX;
      }
      const why = await desktopOpener.check();
      if (why) return { focused: false, reason: why };
      return desktopOpener.open(cwd, sessionId);
    }
    if (host === 'vscode') return openVsCode(cwd, sessionId);
    const rec = lookupSession(sessionId, sessionsDir);
    if (!rec) return { focused: false, reason: 'no session registry entry' };

    // A background job borrows the window that parked on it, if one did.
    let target = rec;
    let viaHost = false;
    if (rec.kind && rec.kind !== 'interactive') {
      const host = hostWindowFor(rec, sessionsDir);
      if (!host) return { focused: false, reason: 'background agent — no window to focus' };
      target = host;
      viaHost = true;
    }

    const tty = await ttyFor(target.pid);
    if (!tty) {
      return {
        focused: false,
        reason: viaHost ? 'background agent — parked window is gone' : 'session has no tty',
      };
    }

    const app = await ownerApp(target.pid);
    if (app && app !== 'Terminal') {
      // Only Terminal.app exposes tty per tab; raise the app and say so.
      const r = await osa(`tell application "${app}" to activate`);
      return r.ok
        ? { focused: true, app, exact: false, reason: `${app} raised (tab targeting unsupported)` }
        : { focused: false, reason: r.denied ? `automation denied for ${app}` : r.error };
    }

    const r = await osa(TERMINAL_RAISE(tty));
    if (!r.ok) {
      if (r.denied) {
        automationDenied = true;
        return {
          focused: false,
          reason: 'macOS denied Automation for Terminal — allow it in System Settings › Privacy & Security › Automation',
        };
      }
      return { focused: false, reason: r.error };
    }
    if (r.out !== 'true') return { focused: false, reason: 'no Terminal tab owns that tty' };
    log('FC', `focused ${target.name || sessionId.slice(0, 8)} (${tty})${viaHost ? ' [parked host]' : ''}`);
    // A parked window is the job's window: whatever the job is asking is what
    // is on screen there, so the keypress belongs to it exactly as much as it
    // belongs to a session's own tab. Anything less means walking to the Mac,
    // which is the one thing the device exists to avoid.
    return { focused: true, app: 'Terminal', exact: true, tty, viaHost };
  }

  // Neither focusSession nor openInVsCode takes the lock itself; callers wrap them in exclusive().
  // Nothing here ever stops a session: moving a background one into VS Code is handoff.js, which stops
  // it first and only then calls openInVsCode.
  return { exclusive, focusSession, openInVsCode: openVsCode, lookupSession };
}
