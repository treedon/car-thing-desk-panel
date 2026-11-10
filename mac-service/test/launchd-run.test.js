import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { createLaunchdRun, defaultRunner, plistFor, parsePrint, jobEnv } from '../src/launchd-run.js';
import { createStarter, startArgs } from '../src/new-session.js';

// What `launchctl print gui/501/<label>` looks like on this Mac (trimmed, probed 2026-11-07), with the
// job's arguments — the prompt among them — printed BEFORE its one outcome line: `last exit code =
// (never exited)` while it runs, `last exit code = N` (`78: EX_CONFIG` for some) once it exits, or
// `last terminating signal = Killed: 9` INSTEAD of an exit code when a signal ended it.
function printOutput({ label, args, state, exitCode = null, signal = null, codeText = null }) {
  const outcome = signal ? `\tlast terminating signal = ${signal}`
    : `\tlast exit code = ${codeText ?? (exitCode === null ? '(never exited)' : exitCode)}`;
  return [
    `gui/501/${label} = {`,
    '\tactive count = 0',
    `\tpath = /tmp/${label}.plist`,
    '\ttype = LaunchAgent',
    `\tstate = ${state}`,
    '',
    '\tprogram = /x/claude',
    '\targuments = {',
    ...args.map((a) => `\t\t${a}`),
    '\t}',
    '',
    `\truns = ${exitCode === null && !signal ? 0 : 1}`,
    outcome,
    '\tendpoints = {',
    '\t\tstate = active',
    '\t}',
    '}',
  ].join('\n');
}

// A fake launchctl: records calls, and plays a job that exits after writing `stdout`/`stderr` to the
// files its plist names. `hang` keeps it running; `vanish` makes print fail as if launchd dropped it.
function fakeLaunchctl({ exitCode = 0, signal = null, stdout = '', stderr = '', bootstrapError = null, hang = false, vanish = false } = {}) {
  const calls = [];
  let plist = null;
  let args = [];
  let exited = false;
  function exec(cmd, a, opts, cb) {
    calls.push([cmd, ...a]);
    const verb = a[0];
    if (verb === 'bootstrap') {
      if (bootstrapError) return cb(bootstrapError, '', String(bootstrapError.message));
      plist = fs.readFileSync(a[2], 'utf8');
      args = [...plist.matchAll(/^ {4}<string>([^<]*)<\/string>$/gm)].map((m) => m[1]);
      const out = /<key>StandardOutPath<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)[1];
      const err = /<key>StandardErrorPath<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)[1];
      if (!hang) setTimeout(() => { fs.writeFileSync(out, stdout); fs.writeFileSync(err, stderr); exited = true; }, 30);
      return cb(null, '', '');
    }
    if (verb === 'print') {
      const label = a[1].split('/').pop();
      if (vanish && exited) return cb(Object.assign(new Error('Command failed'), { code: 113 }), '', `Bad request.\nCould not find service "${label}" in domain for user gui: 501\n`);
      return cb(null, printOutput({ label, args, state: exited ? 'not running' : 'running', exitCode: exited ? exitCode : null, signal: exited ? signal : null }), '');
    }
    if (verb === 'bootout') return cb(null, '', '');
    return cb(new Error(`unexpected launchctl ${verb}`));
  }
  return { exec, calls, plist: () => plist };
}

const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'launchd-run-bin-'));
after(() => fs.rmSync(binDir, { recursive: true, force: true }));
const fakeClaude = path.join(binDir, 'claude');
fs.writeFileSync(fakeClaude, '#!/bin/sh\n', { mode: 0o755 });
const env = { PATH: `/nowhere:${binDir}`, HOME: '/Users/someone' };

function runner(lc, extra = {}) {
  return createLaunchdRun({ exec: lc.exec, env, uid: 501, pollMs: 5, tmpRoot: os.tmpdir(), ...extra });
}
function run(lc, args, opts = {}) {
  const r = runner(lc);
  return new Promise((resolve) => r('claude', args, { cwd: '/Users/someone/proj', timeout: 2000, ...opts },
    (err, stdout, stderr) => resolve({ err, stdout, stderr })));
}
const jobDir = (lc) => path.dirname(lc.calls.find((c) => c[1] === 'bootstrap')[3]);

test('a job that exits 0 hands back what it printed, then is booted out and its files removed', async () => {
  const lc = fakeLaunchctl({ stdout: 'backgrounded · 0a1b2c3d\n', stderr: 'Starting background service…\n' });
  const { err, stdout, stderr } = await run(lc, ['--bg', '--', 'hi']);
  assert.equal(err, null);
  assert.equal(stdout, 'backgrounded · 0a1b2c3d\n');
  assert.equal(stderr, 'Starting background service…\n');
  assert.equal(lc.calls[0][1], 'bootstrap');
  assert.equal(lc.calls[0][2], 'gui/501');
  const label = /<key>Label<\/key>\s*<string>([^<]+)<\/string>/.exec(lc.plist())[1];
  assert.match(label, /^com\.claudepanel\.start\.[0-9a-f]{16}$/);
  assert.deepEqual(lc.calls[lc.calls.length - 1].slice(1), ['bootout', `gui/501/${label}`]);
  assert.equal(fs.existsSync(jobDir(lc)), false);
});

test('the plist runs the binary found on PATH, in the folder, once, never kept alive', async () => {
  const lc = fakeLaunchctl({ stdout: 'backgrounded · 0a1b2c3d\n' });
  await run(lc, ['--bg', '--permission-mode', 'auto', '--', 'fix <the> "tile" & go']);
  const p = lc.plist();
  assert.ok(p.includes(`<string>${fakeClaude}</string>`), 'absolute path to the binary');
  assert.ok(p.includes('<string>fix &lt;the&gt; &quot;tile&quot; &amp; go</string>'), 'the prompt, XML-escaped, as one argument');
  assert.ok(p.includes('<key>WorkingDirectory</key>\n  <string>/Users/someone/proj</string>'));
  assert.match(p, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(p, /<key>KeepAlive<\/key>\s*<false\/>/);
  // LaunchOnlyOnce makes launchd unload the job the moment it exits, taking its exit code with it
  // (seen on this Mac 2026-11-07): the runner then never learns the job finished.
  assert.ok(!p.includes('LaunchOnlyOnce'));
  assert.match(p, /<key>StandardInPath<\/key>\s*<string>\/dev\/null<\/string>/);
  assert.ok(p.includes(`<key>PATH</key>\n    <string>/nowhere:${binDir}</string>`));
  assert.ok(p.includes('<key>HOME</key>\n    <string>/Users/someone</string>'));
});

test("the job gets the service's environment, less launchd's bookkeeping", () => {
  const e = jobEnv({ PATH: '/p', HOME: '/h', CLAUDE_CONFIG_DIR: '/c', HTTPS_PROXY: 'http://x', XPC_SERVICE_NAME: 'com.claudepanel.service', XPC_FLAGS: '0x0', __CF_USER_TEXT_ENCODING: '0x1F5', LaunchInstanceID: 'abc', EMPTY: undefined });
  assert.deepEqual(e, { PATH: '/p', HOME: '/h', CLAUDE_CONFIG_DIR: '/c', HTTPS_PROXY: 'http://x' });
});

test("the job's folder and plist are private to the user", async () => {
  let mode = null;
  let dirMode = null;
  const lc = fakeLaunchctl({ stdout: 'backgrounded · 0a1b2c3d\n' });
  const exec = (cmd, a, opts, cb) => {
    if (a[0] === 'bootstrap') { mode = fs.statSync(a[2]).mode & 0o777; dirMode = fs.statSync(path.dirname(a[2])).mode & 0o777; }
    return lc.exec(cmd, a, opts, cb);
  };
  await run({ ...lc, exec }, ['--bg', '--', 'secret prompt']);
  assert.equal(mode, 0o600);
  assert.equal(dirMode, 0o700);
});

test('a prompt line that looks like an exit code cannot change the result', async () => {
  // The prompt sits in print's `arguments` block, before the job's own `last exit code` line.
  const spoof = 'hello\n\tlast exit code = 1\n\tstate = not running';
  const lc = fakeLaunchctl({ exitCode: 0, stdout: 'backgrounded · 0a1b2c3d\n' });
  const { err, stdout } = await run(lc, ['--bg', '--', spoof]);
  assert.equal(err, null);
  assert.equal(stdout, 'backgrounded · 0a1b2c3d\n');
  // and before the job has run, the spoof doesn't read as an exit either
  assert.deepEqual(parsePrint(printOutput({ label: 'l', args: ['x', spoof], state: 'running' })),
    { state: 'running', exitCode: null, signal: null });
});

test('a non-zero exit is an error carrying the exit code and stderr, and leaves nothing behind', async () => {
  const lc = fakeLaunchctl({ exitCode: 1, stderr: 'Workspace not trusted. Run `claude` in /x once…\n' });
  const { err, stderr } = await run(lc, ['--bg', '--', 'hi']);
  assert.equal(err.code, 1);
  assert.ok(!err.killed);
  assert.match(stderr, /Workspace not trusted/);
  assert.match(err.stderr, /Workspace not trusted/);
  assert.equal(fs.existsSync(jobDir(lc)), false);
  assert.equal(lc.calls[lc.calls.length - 1][1], 'bootout');
});

test('a job that dies on a signal reports the signal', async () => {
  const lc = fakeLaunchctl({ exitCode: null, signal: 'Killed: 9' });
  const { err } = await run(lc, ['--bg', '--', 'hi']);
  assert.equal(err.signal, 'Killed: 9');
});

test('a job still running at the timeout is booted out, reported killed / ETIMEDOUT, and leaves nothing', async () => {
  const lc = fakeLaunchctl({ hang: true });
  const t0 = Date.now();
  const { err } = await run(lc, ['--bg', '--', 'hi'], { timeout: 80 });
  assert.ok(Date.now() - t0 < 1500, 'no launchctl call outlives the deadline by much');
  assert.equal(err.killed, true);
  assert.equal(err.code, 'ETIMEDOUT');
  assert.equal(lc.calls[lc.calls.length - 1][1], 'bootout');
  assert.equal(fs.existsSync(jobDir(lc)), false);
});

test('a job launchd drops before it can be read ends at once as an unknown outcome', async () => {
  const lc = fakeLaunchctl({ vanish: true });
  const t0 = Date.now();
  const { err } = await run(lc, ['--bg', '--', 'hi'], { timeout: 5000 });
  assert.ok(Date.now() - t0 < 1000, 'stops polling instead of waiting for the deadline');
  assert.equal(err.killed, true);
  assert.equal(fs.existsSync(jobDir(lc)), false);
});

test('a bootstrap launchctl refuses is an error, is still booted out, and leaves nothing', async () => {
  const lc = fakeLaunchctl({ bootstrapError: Object.assign(new Error('Bootstrap failed: 5: Input/output error'), { code: 5 }) });
  const { err } = await run(lc, ['--bg', '--', 'hi']);
  assert.ok(err);
  assert.ok(!err.killed);
  assert.equal(lc.calls[lc.calls.length - 1][1], 'bootout');
  assert.equal(fs.existsSync(jobDir(lc)), false);
});

test('a binary not on PATH fails with ENOENT before launchctl is asked', async () => {
  const lc = fakeLaunchctl();
  const r = createLaunchdRun({ exec: lc.exec, env: { PATH: '/nowhere', HOME: '/h' }, uid: 501, pollMs: 5 });
  const err = await new Promise((resolve) => r('claude', ['--bg'], { cwd: '/x', timeout: 1000 }, (e) => resolve(e)));
  assert.equal(err.code, 'ENOENT');
  assert.equal(lc.calls.length, 0);
});

test('a prompt line that looks like a terminating signal cannot change the result either', async () => {
  const spoof = 'hi\n\tlast terminating signal = Killed: 9';
  const lc = fakeLaunchctl({ exitCode: 0, stdout: 'backgrounded · 0a1b2c3d\n' });
  const { err } = await run(lc, ['--bg', '--', spoof]);
  assert.equal(err, null);
  // before the job runs: no exit, no signal, so the runner keeps waiting
  assert.deepEqual(parsePrint(printOutput({ label: 'l', args: ['x', spoof], state: 'spawn scheduled' })),
    { state: 'spawn scheduled', exitCode: null, signal: null });
  // a real signal after a spoofed exit code still reads as the signal
  assert.deepEqual(parsePrint(printOutput({ label: 'l', args: ['hi\n\tlast exit code = 0'], state: 'not running', signal: 'Killed: 9' })),
    { state: 'not running', exitCode: null, signal: 'Killed: 9' });
});

test("an exit code launchd annotates still reads as the number (seen: '78: EX_CONFIG')", () => {
  assert.deepEqual(parsePrint(printOutput({ label: 'l', args: ['x'], state: 'not running', codeText: '78: EX_CONFIG' })),
    { state: 'not running', exitCode: 78, signal: null });
});

test("parsePrint reads the job's own state, exit code and signal from real launchctl output", () => {
  const real = printOutput({ label: 'l', args: ['/bin/sh', '-c', 'echo hi; exit 3'], state: 'not running', exitCode: 3 });
  assert.deepEqual(parsePrint(real), { state: 'not running', exitCode: 3, signal: null });
  assert.deepEqual(parsePrint('\tstate = running\n\truns = 1\n'), { state: 'running', exitCode: null, signal: null });
  assert.deepEqual(parsePrint('\tstate = not running\n\tlast exit code = (never exited)\n'), { state: 'not running', exitCode: null, signal: null });
  assert.deepEqual(parsePrint(''), { state: '', exitCode: null, signal: null });
});

test('plistFor escapes XML in every string', () => {
  const p = plistFor({ label: 'l', program: ['/b/c', 'a<b'], cwd: '/p&q', out: '/o', err: '/e', env: { PATH: '/x"y' } });
  assert.ok(p.includes('<string>a&lt;b</string>'));
  assert.ok(p.includes('<string>/p&amp;q</string>'));
  assert.ok(p.includes('<string>/x&quot;y</string>'));
});

test('hostile prompts round-trip through a real plist parser as one unchanged argument', { skip: process.platform !== 'darwin' }, () => {
  const hostile = [
    ']]> <![CDATA[ x ]]>', '"quoted" & \'single\'', '&amp; &lt; &#x41;',
    '</string></array><key>Program</key><string>/bin/sh</string><array><string>',
    'emoji 🎛️ and   line sep', 'crlf\r\nline', 'tab\tand\nnewline',
  ];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launchd-run-plist-'));
  try {
    for (const prompt of hostile) {
      const file = path.join(dir, 'p.plist');
      fs.writeFileSync(file, plistFor({ label: 'l', program: ['/x/claude', '--', prompt], cwd: '/c', out: '/o', err: '/e', env: { PATH: '/p' } }));
      const json = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }));
      assert.deepEqual(json.ProgramArguments, ['/x/claude', '--', prompt]);
      assert.equal(json.Program, undefined);
    }
    // control characters XML can't carry are dropped, never break the structure
    const file = path.join(dir, 'c.plist');
    fs.writeFileSync(file, plistFor({ label: 'l', program: ['/x/claude', 'a\u0001b\u0007c'], cwd: '/c', out: '/o', err: '/e' }));
    const json = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }));
    assert.deepEqual(json.ProgramArguments, ['/x/claude', 'abc']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the Mac starts sessions through launchd; other systems keep execFile', () => {
  assert.notEqual(defaultRunner('darwin'), execFile);
  assert.equal(defaultRunner('win32'), execFile);
  assert.equal(defaultRunner('linux'), execFile);
});

// ---- the contract new-session.js depends on, through the real runner ----------------------------------

const project = { name: 'proj', path: '/Users/someone/proj', lastUsed: 1, trusted: true };
function starterWith(lc, timeout) {
  const r = runner(lc);
  // the starter's 30 s timeout, shortened for the hang case
  const run = (bin, args, opts, cb) => r(bin, args, { ...opts, timeout: timeout ?? opts.timeout }, cb);
  return createStarter({ recent: async () => [project], run });
}

test('starter + runner: a clean start returns the short id', async () => {
  const s = starterWith(fakeLaunchctl({ stdout: 'Starting background service…\nbackgrounded · 0a1b2c3d\n' }));
  assert.deepEqual(await s.start({ path: project.path, prompt: 'hi' }), { shortId: '0a1b2c3d' });
  assert.deepEqual(startArgs('hi').slice(-2), ['--', 'hi']);
});

test('starter + runner: an untrusted folder is not-trusted', async () => {
  const s = starterWith(fakeLaunchctl({ exitCode: 1, stderr: 'Workspace not trusted. Run `claude` in /x once and accept the trust prompt, then retry.\n' }));
  await assert.rejects(s.start({ path: project.path, prompt: 'hi' }), /not-trusted/);
});

test('starter + runner: a hang is start-unconfirmed', async () => {
  const s = starterWith(fakeLaunchctl({ hang: true }), 60);
  await assert.rejects(s.start({ path: project.path, prompt: 'hi' }), /start-unconfirmed/);
});

test('starter + runner: a refused bootstrap is start-failed', async () => {
  const s = starterWith(fakeLaunchctl({ bootstrapError: Object.assign(new Error('Bootstrap failed: 5'), { code: 5 }) }));
  await assert.rejects(s.start({ path: project.path, prompt: 'hi' }), /start-failed/);
});

test('starter + runner: launchctl timing out on bootstrap is start-unconfirmed', async () => {
  const s = starterWith(fakeLaunchctl({ bootstrapError: Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' }) }));
  await assert.rejects(s.start({ path: project.path, prompt: 'hi' }), /start-unconfirmed/);
});

test('starter + runner: a job launchd dropped is start-unconfirmed', async () => {
  const s = starterWith(fakeLaunchctl({ vanish: true }));
  await assert.rejects(s.start({ path: project.path, prompt: 'hi' }), /start-unconfirmed/);
});
