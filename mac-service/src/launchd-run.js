// Runs a command as its own one-shot launchd job instead of as this service's child, with the same
// call shape as execFile(bin, args, { cwd, timeout }, cb) so the starter doesn't care which it gets.
//
// Why: macOS holds a process's "responsible" app accountable for what it touches. A background
// Claude session started as the service's child is node's responsibility, and Claude Code reaches into
// another app's data when it starts — so the owner got a "node … data from other apps" notice with
// nothing to accept (seen 2026-11-07 in tccd: responsible=node, kTCCServiceSystemPolicyAppDataDetailed).
// Started by launchd, the job is its own responsible process: Claude Code, which has a stored decision,
// so macOS stays quiet. The session behaves the same either way, and outlives the job's bootout.
//
// The job is written to a private folder (0700, plist 0600: it holds the prompt), bootstrapped into
// the user's GUI domain, polled until it has exited, then booted out and the folder removed — on every
// path, so no job or prompt is left behind.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// launchd's own bookkeeping for the service's job; everything else in the environment goes through,
// as it did when the command was a child (CLAUDE_CONFIG_DIR, a proxy, certificates…).
const ENV_DROP = /^(XPC_SERVICE_NAME|XPC_FLAGS|LaunchInstanceID|__CF.*)$/;
const LAUNCHCTL_TIMEOUT_MS = 10_000;

// XML text: the five escapes, and what XML 1.0 can't carry dropped (C0 controls but tab/LF/CR,
// U+FFFE, U+FFFF).
function xml(s) {
  return String(s)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function plistFor({ label, program, cwd, out, err, env = {} }) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>', `  <string>${xml(label)}</string>`,
    '  <key>ProgramArguments</key>', '  <array>',
    ...program.map((a) => `    <string>${xml(a)}</string>`),
    '  </array>',
    '  <key>WorkingDirectory</key>', `  <string>${xml(cwd)}</string>`,
    '  <key>EnvironmentVariables</key>', '  <dict>',
    ...Object.entries(env).flatMap(([k, v]) => [`    <key>${xml(k)}</key>`, `    <string>${xml(v)}</string>`]),
    '  </dict>',
    '  <key>RunAtLoad</key>', '  <true/>',
    // Runs once: RunAtLoad starts it, KeepAlive false never restarts it. Not LaunchOnlyOnce, which
    // unloads the job as soon as it exits and takes its exit code with it.
    '  <key>KeepAlive</key>', '  <false/>',
    '  <key>StandardInPath</key>', '  <string>/dev/null</string>',
    '  <key>StandardOutPath</key>', `  <string>${xml(out)}</string>`,
    '  <key>StandardErrorPath</key>', `  <string>${xml(err)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ];
  return lines.join('\n');
}

// The environment the job gets: the service's own, less launchd's bookkeeping.
export function jobEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) if (v !== undefined && !ENV_DROP.test(k)) out[k] = String(v);
  return out;
}

// The binary launchd should run, as an absolute path found on `pathVar`, or null.
function resolveBin(bin, pathVar) {
  const ok = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } };
  if (path.isAbsolute(bin)) return ok(bin) ? bin : null;
  for (const dir of String(pathVar || '').split(':')) {
    if (!dir) continue;
    const p = path.join(dir, bin);
    if (ok(p)) return p;
  }
  return null;
}

// `launchctl print` → { state, exitCode, signal }. Seen on this Mac (2026-11-07): the job's own keys
// sit one tab in, sub-sections (endpoints and the like) deeper; `state` is the first such line, before
// the `arguments` block. The job's outcome is ONE line, after the arguments: `last exit code =
// (never exited)` while it runs, `last exit code = 3` (or `78: EX_CONFIG`) once it has exited, or
// `last terminating signal = Killed: 9` in place of the exit code when a signal ended it. An argument —
// the prompt — can contain lines that look like any of these, but they print before the real one, so
// the LAST outcome line of either kind is the job's.
export function parsePrint(text) {
  const t = String(text || '');
  const state = (/^\tstate = (.+)$/m.exec(t) || [])[1] || '';
  const re = /^\t(last exit code|last terminating signal) = (.*)$/gm;
  let m; let kind = null; let value = '';
  while ((m = re.exec(t))) { kind = m[1]; value = m[2].trim(); }
  const code = kind === 'last exit code' ? /^(-?\d+)\b/.exec(value) : null;
  return {
    state: state.trim(),
    exitCode: code ? Number(code[1]) : null,
    signal: kind === 'last terminating signal' ? value : null,
  };
}

function readOr(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

export function createLaunchdRun({
  exec = execFile, env = process.env, uid = typeof process.getuid === 'function' ? process.getuid() : 0,
  pollMs = 200, tmpRoot = os.tmpdir(),
} = {}) {
  const launchctl = (args, timeoutMs) => new Promise((resolve) => {
    exec('launchctl', args, { timeout: Math.max(1, Math.min(LAUNCHCTL_TIMEOUT_MS, timeoutMs)) },
      (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });

  return function run(bin, args, opts, cb) {
    const o = opts || {};
    let called = false;
    const done = (...a) => { if (called) return; called = true; cb(...a); };

    const absBin = resolveBin(bin, env.PATH);
    if (!absBin) {
      setImmediate(() => done(Object.assign(new Error(`${bin}: not found on PATH`), { code: 'ENOENT' }), '', ''));
      return null;
    }
    const label = `com.claudepanel.start.${crypto.randomBytes(8).toString('hex')}`;
    const target = `gui/${uid}/${label}`;
    let dir = null;
    const cleanup = () => { if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
    let plistPath; let out; let errFile;
    try {
      dir = fs.mkdtempSync(path.join(tmpRoot, 'claude-panel-start-')); // created 0700
      out = path.join(dir, 'out');
      errFile = path.join(dir, 'err');
      plistPath = path.join(dir, `${label}.plist`);
      fs.writeFileSync(plistPath, plistFor({ label, program: [absBin, ...args], cwd: o.cwd, out, err: errFile, env: jobEnv(env) }), { mode: 0o600 });
    } catch (e) {
      cleanup();
      setImmediate(() => done(e, '', ''));
      return null;
    }

    const deadline = Date.now() + (Number(o.timeout) || 30_000);
    const left = () => deadline - Date.now();
    // Booted out on every way out: a job still loaded would be left in the user's domain.
    const finish = async (err, stdout, stderr) => {
      await launchctl(['bootout', target], Math.max(left(), 2_000));
      cleanup();
      done(err, stdout, stderr);
    };

    (async () => {
      const boot = await launchctl(['bootstrap', `gui/${uid}`, plistPath], left());
      if (boot.err) {
        // A launchctl that ran out of time may still have loaded the job: the outcome is unknown.
        const e = Object.assign(boot.err, { stderr: boot.stderr || boot.err.message });
        return finish(e, '', boot.stderr);
      }
      for (;;) {
        const p = await launchctl(['print', target], left());
        // launchctl's own error text only: stdout of a cut-off print can hold the prompt.
        if (p.err && /could not find service/i.test(`${p.stderr}\n${p.err.message}`)) {
          // Gone before it could be read: whether it ran is unknown.
          return finish(Object.assign(new Error(`${bin}: job unloaded before it could be read`), { killed: true, stderr: readOr(errFile) }),
            readOr(out), readOr(errFile));
        }
        const { exitCode, state, signal } = parsePrint(p.stdout);
        if (state && state !== 'running' && (exitCode !== null || signal)) {
          const stdout = readOr(out);
          const stderr = readOr(errFile);
          if (exitCode === 0 && !signal) return finish(null, stdout, stderr);
          return finish(Object.assign(new Error(`${bin} exited ${signal ? `on ${signal}` : exitCode}`),
            { code: exitCode, signal: signal || undefined, stderr }), stdout, stderr);
        }
        if (left() <= 0) {
          const stderr = readOr(errFile);
          return finish(Object.assign(new Error(`${bin} timed out`), { killed: true, signal: 'SIGTERM', code: 'ETIMEDOUT', stderr }),
            readOr(out), stderr); // the bootout also ends a job still running
        }
        await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(1, left()))));
      }
    })().catch(async (e) => {
      // Something threw past the paths above: still try to unload the job before giving up on it.
      try { await launchctl(['bootout', target], 2_000); } catch {}
      cleanup();
      done(Object.assign(e, { killed: true }), '', ''); // whether it ran is unknown
    });
    return null; // no child: nothing to type into, nothing to end
  };
}

// The Mac starts background sessions through launchd; elsewhere (the NucBox) a plain child is fine.
export function defaultRunner(platform = process.platform) {
  return platform === 'darwin' ? createLaunchdRun() : execFile;
}
