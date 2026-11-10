// The registry half of focusing: which window, if any, owns a session.
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// log.js empties <LOG_DIR>/daemon.log on import, and in the checkout that is the live service's log.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-thing-focus-'));
process.env.CLAUDE_THING_LOG_DIR = path.join(TMP, 'logs');

const { lookupSession, hostWindowFor, detectHost, createFocus } = await import('../src/focus.js');

// The NucBox's refusals are logged; the tests read those lines instead of printing them.
const logged = [];
mock.method(console, 'log', (line) => { logged.push(String(line)); });
after(async () => {
  mock.restoreAll();
  // Wait for log.js's stream to open its file, or the open fails with ENOENT once the folder is gone.
  const logFile = path.join(TMP, 'logs', 'daemon.log');
  for (let i = 0; i < 100 && !fs.existsSync(logFile); i++) await new Promise((r) => setTimeout(r, 10));
  fs.rmSync(TMP, { recursive: true, force: true });
});

function registry(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-'));
  for (const rec of records) {
    fs.writeFileSync(path.join(dir, `${rec.pid}.json`), JSON.stringify(rec));
  }
  return dir;
}

const JOB = {
  pid: 65545,
  sessionId: 'f036b86d-4e37-491b-9c0c-5a851afbdab4',
  kind: 'bg',
  jobId: 'f036b86d',
  name: 'configure-model-effort',
  status: 'waiting',
};
const WINDOW = { pid: 64808, sessionId: 'ddfa1280-328c', kind: 'interactive', parkedJobId: 'f036b86d' };
const OTHER = { pid: 70824, sessionId: '2d6cdd0f-d9d7', kind: 'interactive' };

test('a background job resolves to the window parked on it', () => {
  const dir = registry([JOB, WINDOW, OTHER]);
  assert.equal(hostWindowFor(lookupSession(JOB.sessionId, dir), dir).pid, WINDOW.pid);
});

test('a parkedJobId written as the full session id still matches', () => {
  const dir = registry([JOB, { ...WINDOW, parkedJobId: JOB.sessionId }]);
  assert.equal(hostWindowFor(JOB, dir).pid, WINDOW.pid);
});

test('a job nobody parked on has no window', () => {
  const dir = registry([JOB, OTHER, { ...WINDOW, pid: 1, parkedJobId: 'deadbeef' }]);
  assert.equal(hostWindowFor(JOB, dir), null);
});

test('only interactive sessions count as windows', () => {
  const dir = registry([JOB, { ...WINDOW, kind: 'bg' }]);
  assert.equal(hostWindowFor(JOB, dir), null);
});

test('unparsable and unrelated files are skipped, not fatal', () => {
  const dir = registry([JOB, WINDOW]);
  fs.writeFileSync(path.join(dir, 'junk.json'), '{not json');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
  assert.equal(hostWindowFor(JOB, dir).pid, WINDOW.pid);
  assert.equal(lookupSession('nope', dir), null);
});

// ---- which app hosts a session (plan Task 6) ---------------------------------

test('detectHost finds VS Code ancestor', async () => {
  const tree = { 10: { ppid: 9, comm: 'node' }, 9: { ppid: 8, comm: 'Code Helper (Plugin)' }, 8: { ppid: 1, comm: 'launchd' } };
  assert.equal(await detectHost(10, (p) => tree[p] || null), 'vscode');
});

test('detectHost finds a terminal ancestor', async () => {
  const tree = { 10: { ppid: 9, comm: '-zsh' }, 9: { ppid: 1, comm: '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal' } };
  assert.equal(await detectHost(10, (p) => tree[p] || null), 'terminal');
  assert.equal(await detectHost(10, (p) => ({ 10: { ppid: 9, comm: 'tmux' } })[p] || null), 'terminal');
});

test('detectHost stops at 10 levels and returns unknown', async () => {
  const seen = [];
  const readProc = (p) => { seen.push(p); return { ppid: p + 1, comm: 'node' }; };
  assert.equal(await detectHost(100, readProc), 'unknown');
  assert.equal(seen.length, 10);
  assert.equal(await detectHost(5, () => null), 'unknown');
});

test('focus on a vscode session runs open -a with cwd and never osascript keystroke', async () => {
  const calls = [];
  const run = (cmd, args, opts, cb) => { calls.push([cmd, args]); (cb || opts)(null, '', ''); };
  const focus = createFocus({ run, uriDelayMs: 0 });
  const id = '310b7027-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
  const r = await focus.focusSession(id, { host: 'vscode', cwd: '/Users/owner/Claude/personal/Mirror' });
  assert.deepEqual(calls, [
    ['open', ['-a', 'Visual Studio Code', '/Users/owner/Claude/personal/Mirror']],
    // the Claude extension's own link: opens that session's tab in the window just raised
    ['open', [`vscode://anthropic.claude-code/open?session=${id}`]],
  ]);
  assert.equal(r.focused, true);
  assert.equal(r.exact, false, 'never exact, so nothing is ever typed after it');
});

test('on Windows (the NucBox) a window is never raised, and it says why', async () => {
  const { createFocus } = await import('../src/focus.js');
  const calls = [];
  const f = createFocus({ run: (...a) => calls.push(a), platform: 'win32' });
  const r = await f.focusSession('11111111-2222-4333-8444-555555555555', { host: 'vscode', cwd: 'C:\\code\\x' });
  assert.equal(r.focused, false);
  assert.match(r.reason, /NucBox/);
  assert.equal(calls.length, 0);
});

test('openInVsCode on win32 opens nothing', async () => {
  const { calls, run } = recordingRun();
  const f = createFocus({ run, platform: 'win32', uriDelayMs: 0 });
  assert.deepEqual(await f.openInVsCode('C:\\code\\x', '11111111-2222-4333-8444-555555555555'), {
    focused: false, reason: "can't raise windows on the NucBox",
  });
  assert.deepEqual(calls, [], 'no open: the service has no desktop to open on');
});

// ---- the NucBox: only a VS Code session is raised, through the helper in the owner's desktop session ---

const WIN_SID = '11111111-2222-4333-8444-555555555555';
const WIN_CWD = 'C:\\code\\x';
const NUCBOX_REFUSAL = { focused: false, reason: "can't raise windows on the NucBox" };
// Claude Code's own registry entry (~/.claude/sessions/<pid>.json) for a session VS Code started. A `claude`
// run in a terminal is `interactive` in `claude agents --json` too; only its entrypoint tells them apart.
const VSCODE_ENTRY = { pid: 4242, sessionId: WIN_SID, kind: 'interactive', entrypoint: 'claude-vscode' };

// An opener that records what it is asked; `checks` is what check() answers, in order (the last repeats).
function fakeOpener({ checks = [null], opened = { focused: true, app: 'Code', exact: false } } = {}) {
  const calls = [];
  let n = 0;
  return {
    calls,
    check: async () => { calls.push(['check']); return checks[Math.min(n++, checks.length - 1)]; },
    open: async (...a) => { calls.push(['open', ...a]); return opened; },
  };
}

// `records` is what the registry holds; by default the session's own entry, saying VS Code started it.
function winFocus(desktopOpener, records = [VSCODE_ENTRY]) {
  const { calls, run } = recordingRun();
  const focus = createFocus({ run, platform: 'win32', uriDelayMs: 0, desktopOpener, sessionsDir: registry(records) });
  return { focus, calls };
}

const focusLines = () => logged.filter((l) => / FC /.test(l));

test('win32: an interactive session VS Code started (entrypoint claude-vscode) is raised through the helper', async () => {
  const opener = fakeOpener();
  const { focus, calls } = winFocus(opener);   // the registry holds VSCODE_ENTRY
  const r = await focus.focusSession(WIN_SID, { host: 'vscode', cwd: WIN_CWD, kind: 'interactive' });
  assert.deepEqual(r, { focused: true, app: 'Code', exact: false });
  assert.deepEqual(opener.calls, [['check'], ['open', WIN_CWD, WIN_SID]], 'checked first, and no prompt is passed');
  assert.deepEqual(calls, [], 'the service itself runs nothing');
});

test('win32: a background session is never raised, whatever its host', async () => {
  const opener = fakeOpener();
  const { focus } = winFocus(opener);
  // Every session reads host "vscode" on the NucBox, background ones included: its agent is still running,
  // and a tab on the same conversation would put two processes on it.
  assert.deepEqual(await focus.focusSession(WIN_SID, { host: 'vscode', cwd: WIN_CWD, kind: 'background' }), NUCBOX_REFUSAL);
  assert.deepEqual(opener.calls, [], 'not even asked about the desktop');
});

test('win32: an unknown kind is not raised', async () => {
  const opener = fakeOpener();
  const { focus } = winFocus(opener);
  assert.deepEqual(await focus.focusSession(WIN_SID, { host: 'vscode', cwd: WIN_CWD }), NUCBOX_REFUSAL);
  assert.deepEqual(await focus.focusSession(WIN_SID, { host: 'vscode', cwd: WIN_CWD, kind: 'bg' }), NUCBOX_REFUSAL);
  assert.deepEqual(opener.calls, []);
});

// A `claude` started in a terminal on the NucBox is `interactive` too. Its terminal process is still live, so
// a VS Code tab on the same conversation would put two processes on it.
test('win32: an interactive session that VS Code did not start is not raised, and the helper is not asked', async () => {
  for (const entrypoint of ['cli', 'sdk-cli', undefined]) {
    const opener = fakeOpener();
    const { focus, calls } = winFocus(opener, [{ ...VSCODE_ENTRY, entrypoint }]);
    logged.length = 0;
    assert.deepEqual(await focus.focusSession(WIN_SID, { host: 'vscode', cwd: WIN_CWD, kind: 'interactive' }), NUCBOX_REFUSAL);
    assert.deepEqual(opener.calls, [], `not checked, not opened: ${entrypoint}`);
    assert.deepEqual(calls, []);
    const lines = focusLines();
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.match(lines[0], new RegExp(`11111111.*entrypoint=${entrypoint === undefined ? 'none' : entrypoint}`));
  }
});

test('win32: an interactive session with no registry entry is not raised', async () => {
  const opener = fakeOpener();
  const other = { ...VSCODE_ENTRY, pid: 7, sessionId: '99999999-2222-4333-8444-555555555555' };
  for (const records of [[], [other]]) {
    const { focus } = winFocus(opener, records);
    logged.length = 0;
    assert.deepEqual(await focus.focusSession(WIN_SID, { host: 'vscode', cwd: WIN_CWD, kind: 'interactive' }), NUCBOX_REFUSAL);
    const lines = focusLines();
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.match(lines[0], /11111111.*no registry entry/);
  }
  assert.deepEqual(opener.calls, []);
});

test('win32: the registry decides only for an interactive session: a background one is refused before it, unlogged', async () => {
  const opener = fakeOpener();
  const { focus } = winFocus(opener);   // the entry says claude-vscode, but the store says background
  logged.length = 0;
  assert.deepEqual(await focus.focusSession(WIN_SID, { host: 'vscode', cwd: WIN_CWD, kind: 'background' }), NUCBOX_REFUSAL);
  assert.deepEqual(opener.calls, []);
  assert.deepEqual(focusLines(), []);
});

test('win32: an interactive session with no opener keeps the old refusal', async () => {
  const { focus, calls } = winFocus(null);
  assert.deepEqual(await focus.focusSession(WIN_SID, { host: 'vscode', cwd: WIN_CWD, kind: 'interactive' }), NUCBOX_REFUSAL);
  assert.deepEqual(calls, []);
});

test('win32: no desktop is no-desktop, nothing opened', async () => {
  const opener = fakeOpener({ checks: ['no-desktop'] });
  const { focus } = winFocus(opener);
  assert.deepEqual(await focus.focusSession(WIN_SID, { host: 'vscode', cwd: WIN_CWD, kind: 'interactive' }), {
    focused: false, reason: 'no-desktop',
  });
  assert.deepEqual(opener.calls, [['check']]);
});

test('win32: a helper that is not set up says so, and opens nothing', async () => {
  const opener = fakeOpener({ checks: ['not-set-up'] });
  const { focus } = winFocus(opener);
  const r = await focus.focusSession(WIN_SID, { host: 'vscode', cwd: WIN_CWD, kind: 'interactive' });
  assert.deepEqual(r, { focused: false, reason: 'not-set-up' });
  assert.deepEqual(opener.calls, [['check']]);
});

test('win32: what the helper says about the open comes back as it is', async () => {
  const opener = fakeOpener({ opened: { focused: false, reason: 'helper-timeout' } });
  const { focus } = winFocus(opener);
  assert.deepEqual(await focus.focusSession(WIN_SID, { host: 'vscode', cwd: WIN_CWD, kind: 'interactive' }), {
    focused: false, reason: 'helper-timeout',
  });
});

test('the Mac does not look at kind or an opener: a vscode host is still opened by `open`', async () => {
  const opener = fakeOpener();
  const { calls, run } = recordingRun();
  const focus = createFocus({ run, uriDelayMs: 0, platform: 'darwin', desktopOpener: opener });
  const r = await focus.focusSession(WIN_SID, { host: 'vscode', cwd: '/p', kind: 'background' });
  assert.equal(r.focused, true);
  assert.equal(calls[0][0], 'open');
  assert.deepEqual(opener.calls, []);
});

// ---- opening a session in VS Code, with or without a prefilled prompt ----------------------------

const SID = '310b7027-1c2d-4e5f-8a9b-0c1d2e3f4a5b';

function recordingRun() {
  const calls = [];
  const run = (cmd, args, opts, cb) => { calls.push([cmd, args]); (cb || opts)(null, '', ''); };
  return { calls, run };
}

test('openInVsCode with a prompt pre-fills it in the link', async () => {
  const { calls, run } = recordingRun();
  const focus = createFocus({ run, uriDelayMs: 0 });
  const r = await focus.openInVsCode('/p', SID, 'Continue where you left off.');
  assert.deepEqual(calls, [
    ['open', ['-a', 'Visual Studio Code', '/p']],
    ['open', [`vscode://anthropic.claude-code/open?session=${SID}&prompt=Continue%20where%20you%20left%20off.`]],
  ]);
  assert.deepEqual(r, { focused: true, app: 'Code', exact: false });
});

test('openInVsCode without a prompt is the plain link', async () => {
  const { calls, run } = recordingRun();
  const focus = createFocus({ run, uriDelayMs: 0 });
  await focus.openInVsCode('/p', SID);
  assert.deepEqual(calls[1], ['open', [`vscode://anthropic.claude-code/open?session=${SID}`]]);
});

test('a prompt is percent-encoded so it cannot add parameters to the link', async () => {
  const { calls, run } = recordingRun();
  const focus = createFocus({ run, uriDelayMs: 0 });
  await focus.openInVsCode('/p', SID, 'a&session=x b#c');
  assert.deepEqual(calls[1], ['open', [`vscode://anthropic.claude-code/open?session=${SID}&prompt=a%26session%3Dx%20b%23c`]]);
});

test('openInVsCode that cannot raise VS Code says why and opens no link', async () => {
  const calls = [];
  const run = (cmd, args, opts, cb) => { calls.push(args); (cb || opts)(new Error('unable to find application'), '', ''); };
  const focus = createFocus({ run, uriDelayMs: 0 });
  const r = await focus.openInVsCode('/p', SID, 'Continue where you left off.');
  assert.deepEqual(r, { focused: false, reason: 'unable to find application' });
  assert.equal(calls.length, 1);
});

test('focusSession for a vscode session still opens the plain link', async () => {
  const { calls, run } = recordingRun();
  const focus = createFocus({ run, uriDelayMs: 0 });
  await focus.focusSession(SID, { host: 'vscode', cwd: '/p' });
  assert.deepEqual(calls[1], ['open', [`vscode://anthropic.claude-code/open?session=${SID}`]]);
});

// ---- ruling R2: focusing never stops anything ----------------------------------------------------

test('claude.session.focus is unchanged for a windowless background session: nothing to raise, nothing stopped', async () => {
  const dir = registry([{ ...JOB, kind: 'background' }, OTHER]);
  const calls = [];
  const run = (cmd, args, opts, cb) => { calls.push([cmd, args]); (cb || opts)(null, '', ''); };
  const focus = createFocus({ run, uriDelayMs: 0, platform: 'darwin', sessionsDir: dir });
  const r = await focus.exclusive(() => focus.focusSession(JOB.sessionId, { host: undefined, cwd: '/p' }));
  assert.deepEqual(r, { focused: false, reason: 'background agent — no window to focus' });
  assert.deepEqual(calls, [], 'no claude stop, no open, no osascript');
});

test('createFocus has no way to stop an agent', () => {
  assert.deepEqual(Object.keys(createFocus()).sort(), ['exclusive', 'focusSession', 'lookupSession', 'openInVsCode']);
});
