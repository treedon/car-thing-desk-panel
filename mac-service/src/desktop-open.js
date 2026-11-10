// Opening a session in VS Code on the NucBox, whose service has no desktop to open it on.
//
// The service runs as a scheduled task in session 0 (S4U): it can start processes, but a window it
// opens appears on no screen. So the opening is done by a helper task, `Car Thing panel - Open in VS
// Code`, that runs in the owner's own desktop session (written in PowerShell, see the install script).
// The two talk through a folder:
//
//   1. the service writes request.json (the session, the folder, whether to continue the turn),
//   2. runs `schtasks /run /tn <task>`, which starts the helper in the owner's session,
//   3. the helper opens VS Code and writes result.json with the request's nonce,
//   4. the service reads it back and answers like the Mac's focus does.
//
// The nonce ties an answer to its request: a result.json left from an earlier call, or a different one
// the helper is still finishing, is ignored. Both files are UTF-8 without a BOM, written to a .tmp file
// and renamed into place so a reader never sees half of one.
//
// check() says, before anything is stopped, whether this can work at all: the helper task exists and the
// owner has a desktop session to run it in. It runs from the same account as the service, which can
// ask `quser` and `schtasks` both (measured on the NucBox 2026-11-07).
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONTINUE_PROMPT } from './handoff.js';
import { log } from './log.js';

export const OPEN_TASK = 'Car Thing panel - Open in VS Code';
// The helper ignores a request older than this, so a request left behind never opens anything later.
// Exported so the helper's test and this module name one number.
export const REQUEST_MAX_AGE_MS = 60_000;

const CALL_TIMEOUT_MS = 10_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rm = (file) => { try { fs.rmSync(file, { force: true }); } catch {} };

// `quser` → is `user` logged in on a desktop? Seen on the NucBox:
//   " USERNAME              SESSIONNAME        ID  STATE   IDLE TIME  LOGON TIME"
//   " owner                 rdp-tcp#0           1  Active          .  10/15/2026 9:04 AM"
// A Remote Desktop window that was closed leaves the session up as `Disc`, with a blank SESSIONNAME
// (so the columns shift left); the helper still runs in it. The session quser is asked from carries a
// leading `>`. With nobody logged in quser prints "No User exists for *" and exits 1.
export function parseQuser(text, user) {
  const want = String(user || '').toLowerCase();
  if (!want) return false;
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
  const rows = /^\s*USERNAME\b/i.test(lines[0] || '') ? lines.slice(1) : lines;
  return rows.some((line) => {
    const [name, ...rest] = line.replace(/^\s*>?\s*/, '').split(/\s+/);
    return name.toLowerCase() === want && rest.some((t) => /^(active|disc)$/i.test(t));
  });
}

// Runs a command through `run` (execFile's signature). Resolves, never rejects: { err, stdout, stderr }.
function call(run, file, args) {
  return new Promise((resolve) => {
    try {
      run(file, args, { timeout: CALL_TIMEOUT_MS }, (err, stdout, stderr) => resolve({
        err, stdout: String(stdout || ''), stderr: String(stderr || ''),
      }));
    } catch (err) {
      resolve({ err, stdout: '', stderr: '' }); // e.g. an argument execFile refuses outright
    }
  });
}

// Why a call failed, in one line: the first line it wrote to stderr, else the first line of the error
// (execFile's own message starts "Command failed: <command>", which says less).
function firstFailureLine({ err, stderr }) {
  const said = stderr.trim() || String((err && err.message) || err || 'failed').trim();
  return said.split(/\r?\n/)[0].trim();
}

export function createDesktopOpener({
  run = execFile,
  dir = path.join(os.homedir(), '.config', 'claude-panel', 'open-in-vscode'),
  user = os.userInfo().username,
  pollMs = 200,
  timeoutMs = 15_000,
  now = Date.now,
} = {}) {
  const requestFile = path.join(dir, 'request.json');
  const resultFile = path.join(dir, 'result.json');

  function writeRequest(request) {
    const tmp = `${requestFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(request), 'utf8'); // Node writes no BOM
    fs.renameSync(tmp, requestFile);
  }

  // The helper's answer to this nonce, or null: nothing yet, half a file, someone else's answer. The
  // BOM is skipped in case the helper's PowerShell wrote one (5.1's UTF8 does).
  function readResult(nonce) {
    try {
      const r = JSON.parse(fs.readFileSync(resultFile, 'utf8').replace(/^\uFEFF/, ''));
      return r && typeof r === 'object' && r.nonce === nonce ? r : null;
    } catch {
      return null;
    }
  }

  // The deadline uses the real clock: `now` only stamps the request, and a test's frozen one must not
  // hold the wait up.
  async function waitForResult(nonce) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = readResult(nonce);
      if (r) return r;
      const left = deadline - Date.now();
      if (left <= 0) return null;
      await sleep(Math.min(pollMs, left));
    }
  }

  async function openNow(cwd, sessionId, prompt) {
    const nonce = crypto.randomBytes(16).toString('hex');
    try {
      try {
        fs.mkdirSync(dir, { recursive: true });
        // Another nonce's answer would be ignored anyway; removing it just keeps the folder honest.
        rm(resultFile);
        writeRequest({ nonce, sessionId, cwd, continue: prompt === CONTINUE_PROMPT, createdTs: now() });
      } catch {
        return { focused: false, reason: 'helper-not-run' };
      }
      const started = await call(run, 'schtasks', ['/run', '/tn', OPEN_TASK]);
      if (started.err) return { focused: false, reason: 'helper-not-run' };
      const result = await waitForResult(nonce);
      if (!result) return { focused: false, reason: 'helper-timeout' };
      if (result.ok === true) return { focused: true, app: 'Code', exact: false };
      return { focused: false, reason: String(result.reason || 'helper-failed') };
    } finally {
      // On every way out: a request left in the folder is one the helper could still act on.
      rm(requestFile);
      rm(`${requestFile}.tmp`);
    }
  }

  // The two share one request.json and one result.json, so calls take turns: a second request written
  // over the first would strand the first's answer, and its cleanup would remove the second's request.
  let turn = Promise.resolve();

  return {
    // null when opening can work, else why not: 'not-set-up' (no helper task) or 'no-desktop' (the
    // owner is not logged in, so there is no session to open a window in). Never rejects. A call that
    // failed is logged, one line each time, so a refusal right after a deploy (the service's account not
    // allowed to query the task, say) can be told from the plain case.
    async check() {
      const task = await call(run, 'schtasks', ['/query', '/tn', OPEN_TASK]);
      if (task.err) {
        log('DO', `not-set-up: schtasks /query failed: ${firstFailureLine(task)}`);
        return 'not-set-up';
      }
      const who = await call(run, 'quser', []);
      if (who.err) {
        log('DO', `no-desktop: quser failed: ${firstFailureLine(who)}`);
        return 'no-desktop';
      }
      return parseQuser(who.stdout, user) ? null : 'no-desktop';
    },

    // → { focused: true, app: 'Code', exact: false } | { focused: false, reason }. Never rejects. VS Code
    // opens the folder, not the one session, so `exact` is false, as on the Mac.
    open(cwd, sessionId, prompt) {
      if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)
        || typeof cwd !== 'string' || !path.win32.isAbsolute(cwd)) {
        return Promise.resolve({ focused: false, reason: 'bad-request' });
      }
      const result = turn.then(() => openNow(cwd, sessionId, prompt))
        .catch(() => ({ focused: false, reason: 'helper-failed' }));
      turn = result;
      return result;
    },
  };
}
