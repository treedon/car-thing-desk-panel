// Starting a background session from the panel: the recent-projects list the panel offers, and the one
// way a session gets started (`claude --bg`, run in a folder from that list, the prompt as a single
// argument). Everything here is injected: the projects folder is a temp fixture, `run` is a fake, and
// the trust config is a function. Nothing reads the real ~/.claude/projects or ~/.claude.json, and
// nothing runs claude.
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// log.js empties <LOG_DIR>/daemon.log on import, and in the checkout that is the live service's log.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-thing-new-session-'));
process.env.CLAUDE_THING_LOG_DIR = path.join(TMP, 'logs');

const {
  RECENT_LIMIT, MAX_PROMPT_CHARS, isTempPath, recentProjects, parseBackgrounded, startArgs,
  createStarter, createMockStarter, transcriptCwd, sessionStartFolder,
} = await import('../src/new-session.js');
const { createStore } = await import('../src/sessions/store.js');
const { isOwnSession } = await import('../src/own-sessions.js');

// The service logs one line per start; the tests read those lines instead of printing them.
const logged = [];
mock.method(console, 'log', (line) => { logged.push(String(line)); });
after(async () => {
  mock.restoreAll();
  // These tests never yield to the event loop's I/O, so log.js's stream may not have opened its file yet:
  // wait for it to appear, or the open fails with ENOENT once the folder is gone.
  const logFile = path.join(TMP, 'logs', 'daemon.log');
  for (let i = 0; i < 100 && !fs.existsSync(logFile); i++) await new Promise((r) => setTimeout(r, 10));
  fs.rmSync(TMP, { recursive: true, force: true });
});

let fixtureCount = 0;

// A projects folder as Claude Code keeps it: one folder per project, each holding transcripts whose
// records carry the cwd. `spec` is [{ folder, cwd, mtime (epoch seconds), file = '<folder>.jsonl' }].
function projectsDir(spec) {
  const root = path.join(TMP, `projects-${++fixtureCount}`);
  fs.mkdirSync(root, { recursive: true });
  for (const { folder, cwd, mtime, file = `${folder}.jsonl`, body } of spec) {
    const dir = path.join(root, folder);
    fs.mkdirSync(dir, { recursive: true });
    const lines = [JSON.stringify({ type: 'permission-mode', permissionMode: 'default' })];
    if (cwd !== undefined) lines.push(JSON.stringify({ type: 'user', cwd, sessionId: file }));
    fs.writeFileSync(path.join(dir, file), body !== undefined ? body : lines.join('\n') + '\n');
    fs.utimesSync(path.join(dir, file), mtime, mtime);
  }
  return root;
}

const yes = () => true;
const noConfig = () => ({});
const HOME = '/Users/owner';

const BASE = 1_800_000_000; // epoch seconds, well past any real mtime

test('recentProjects returns the newest five, newest first', () => {
  const dir = projectsDir(Array.from({ length: 7 }, (_, i) => ({
    folder: `p${i}`, cwd: `/work/proj${i}`, mtime: BASE + i * 100,
  })));
  const got = recentProjects({ projectsDir: dir, exists: yes, readClaudeConfig: noConfig, home: HOME });
  assert.equal(RECENT_LIMIT, 5);
  assert.equal(got.length, 5);
  assert.deepEqual(got.map((p) => p.path), ['/work/proj6', '/work/proj5', '/work/proj4', '/work/proj3', '/work/proj2']);
  assert.deepEqual(got.map((p) => p.lastUsed), [6, 5, 4, 3, 2].map((i) => (BASE + i * 100) * 1000));
  for (const p of got) assert.equal(p.name, path.basename(p.path));
});

test('the limit is a parameter', () => {
  const dir = projectsDir([0, 1, 2].map((i) => ({ folder: `p${i}`, cwd: `/work/p${i}`, mtime: BASE + i })));
  const got = recentProjects({ projectsDir: dir, exists: yes, limit: 2, readClaudeConfig: noConfig, home: HOME });
  assert.deepEqual(got.map((p) => p.path), ['/work/p2', '/work/p1']);
});

test('skips temp folders, missing folders and own sessions', () => {
  const dir = projectsDir([
    { folder: 'a', cwd: '/private/tmp/x', mtime: BASE + 1 },
    { folder: 'b', cwd: '/var/folders/ab/T/y', mtime: BASE + 2 },
    { folder: 'c', cwd: 'C:\\Users\\owner\\AppData\\Local\\Temp\\z', mtime: BASE + 3 },
    { folder: 'gone', cwd: '/work/deleted', mtime: BASE + 4 },
    { folder: 'own', cwd: '/work/only-own', mtime: BASE + 5, file: 'own-session.jsonl' },
    { folder: 'good', cwd: '/work/good', mtime: BASE + 6 },
  ]);
  const got = recentProjects({
    projectsDir: dir,
    exists: (p) => p !== '/work/deleted',
    isOwn: (id) => id === 'own-session',
    readClaudeConfig: noConfig,
    home: HOME,
  });
  assert.deepEqual(got.map((p) => p.path), ['/work/good']);
});

test('an own session\'s transcript is ignored, an older one in the same folder still counts', () => {
  const dir = projectsDir([
    { folder: 'mixed', cwd: '/work/from-own', mtime: BASE + 9, file: 'own-session.jsonl' },
    { folder: 'mixed', cwd: '/work/from-real', mtime: BASE + 1, file: 'real-session.jsonl' },
  ]);
  const got = recentProjects({
    projectsDir: dir, exists: yes, isOwn: (id) => id === 'own-session', readClaudeConfig: noConfig, home: HOME,
  });
  assert.deepEqual(got.map((p) => [p.path, p.lastUsed]), [['/work/from-real', (BASE + 1) * 1000]]);
});

test('one entry per path, with the newer lastUsed', () => {
  const dir = projectsDir([
    { folder: 'old', cwd: '/work/same', mtime: BASE + 1 },
    { folder: 'new', cwd: '/work/same', mtime: BASE + 50 },
    { folder: 'other', cwd: '/work/other', mtime: BASE + 20 },
  ]);
  const got = recentProjects({ projectsDir: dir, exists: yes, readClaudeConfig: noConfig, home: HOME });
  assert.deepEqual(got.map((p) => [p.path, p.lastUsed]), [['/work/same', (BASE + 50) * 1000], ['/work/other', (BASE + 20) * 1000]]);
});

test('a folder\'s newest transcript says where it is, whatever the folder is called', () => {
  const dir = projectsDir([
    { folder: '-Users-owner-old-name', cwd: '/work/stale', mtime: BASE + 1, file: 'a.jsonl' },
    { folder: '-Users-owner-old-name', cwd: '/work/fresh', mtime: BASE + 2, file: 'b.jsonl' },
  ]);
  const got = recentProjects({ projectsDir: dir, exists: yes, readClaudeConfig: noConfig, home: HOME });
  assert.deepEqual(got.map((p) => p.path), ['/work/fresh']);
});

test('the cwd is JSON-unescaped', () => {
  const cwd = '/work/My "quoted" caf\u00e9 \\ dir';
  const dir = projectsDir([{ folder: 'q', cwd, mtime: BASE }]);
  const got = recentProjects({ projectsDir: dir, exists: yes, readClaudeConfig: noConfig, home: HOME });
  assert.deepEqual(got.map((p) => p.path), [cwd]);
  assert.equal(got[0].name, 'My "quoted" caf\u00e9 \\ dir');
});

test('only the first 200 KB of a transcript is searched for the cwd', () => {
  const pad = JSON.stringify({ type: 'x', text: 'y'.repeat(250 * 1024) });
  const late = projectsDir([{ folder: 'late', mtime: BASE, body: `${pad}\n${JSON.stringify({ cwd: '/work/late' })}\n` }]);
  assert.deepEqual(recentProjects({ projectsDir: late, exists: yes, readClaudeConfig: noConfig, home: HOME }), []);
});

// ---- the folder a session started in ---------------------------------------------------------------------

// A transcript whose records carry the given cwds, in order, as Claude Code writes them.
function transcriptWith(...cwds) {
  const dir = path.join(TMP, `transcripts-${++fixtureCount}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'abcd1234-0000-4000-8000-000000000000.jsonl');
  const lines = [JSON.stringify({ type: 'permission-mode', permissionMode: 'default' })];
  for (const cwd of cwds) lines.push(JSON.stringify({ type: 'user', cwd }));
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

test('transcriptCwd is the first cwd in the transcript, not a later one', () => {
  const file = transcriptWith('/work/pfact', '/work/pfact/.claude/worktrees/remove-akaunting-docs');
  assert.equal(transcriptCwd(file), '/work/pfact');
});

test('transcriptCwd unescapes a Windows path', () => {
  assert.equal(transcriptCwd(transcriptWith('c:\\Users\\owner\\pfact')), 'c:\\Users\\owner\\pfact');
});

test('transcriptCwd is null for a missing file and for a file with no cwd', () => {
  assert.equal(transcriptCwd(path.join(TMP, 'nope.jsonl')), null);
  assert.equal(transcriptCwd(transcriptWith()), null);
  assert.equal(transcriptCwd(undefined), null);
});

// What these tests pass as `{ platform, exists }`: every folder exists unless a test says otherwise.
const MAC = { platform: 'darwin', exists: yes };
const WIN = { platform: 'win32', exists: yes };

test('sessionStartFolder is the folder the transcript starts in, whatever the session reports now', () => {
  const file = transcriptWith('/work/pfact', '/work/pfact/.claude/worktrees/x');
  assert.equal(sessionStartFolder(file, '/work/pfact/.claude/worktrees/x', MAC), '/work/pfact');
});

test('sessionStartFolder falls back when there is no transcript, no cwd in it, or a relative one', () => {
  const fallback = '/work/now';
  assert.equal(sessionStartFolder(null, fallback, MAC), fallback);
  assert.equal(sessionStartFolder([], fallback, MAC), fallback);
  assert.equal(sessionStartFolder(path.join(TMP, 'nope.jsonl'), fallback, MAC), fallback);
  assert.equal(sessionStartFolder(transcriptWith(), fallback, MAC), fallback);
  assert.equal(sessionStartFolder(transcriptWith('relative/dir'), fallback, MAC), fallback);
});

test('sessionStartFolder reads a Windows start folder as absolute on win32, and not on the Mac', () => {
  const file = transcriptWith('c:\\Users\\owner\\pfact');
  const fallback = 'c:\\Users\\owner\\pfact\\.claude\\worktrees\\x';
  assert.equal(sessionStartFolder(file, fallback, WIN), 'c:\\Users\\owner\\pfact');
  assert.equal(sessionStartFolder(file, fallback, MAC), fallback);
});

// The NucBox's helper refuses anything but a drive letter or a share (nucbox/open-in-vscode.ps1), and by
// then the agent is stopped, so the service must not hand it a path that path.win32.isAbsolute alone accepts.
test('win32: only a drive path or a share is a start folder, so the helper will take it', () => {
  const fallback = 'c:\\Users\\owner\\pfact\\.claude\\worktrees\\x';
  const kept = ['c:\\Users\\owner\\pfact', 'C:/Users/owner/pfact', '\\\\server\\share\\pfact'];
  for (const cwd of kept) assert.equal(sessionStartFolder(transcriptWith(cwd), fallback, WIN), cwd, cwd);
  const refused = [
    '/c/Users/owner/pfact',            // Git Bash style
    '\\Users\\owner\\pfact',           // rooted, no drive
    'c:pfact',                         // drive-relative
    'pfact\\sub',                      // relative
    'c:\\',                            // a drive root
    '\\\\server\\share',               // a share root
    'c:\\Users\\"quoted"\\pfact',      // a character Windows never allows in a path
  ];
  for (const cwd of refused) assert.equal(sessionStartFolder(transcriptWith(cwd), fallback, WIN), fallback, cwd);
});

test('sessionStartFolder falls back when the start folder is gone', () => {
  const file = transcriptWith('/work/gone');
  const seen = [];
  const exists = (p) => { seen.push(p); return p !== '/work/gone'; };
  assert.equal(sessionStartFolder(file, '/work/now', { platform: 'darwin', exists }), '/work/now');
  assert.deepEqual(seen, ['/work/gone']);
  assert.equal(sessionStartFolder(transcriptWith('/work/here'), '/work/now', { platform: 'darwin', exists }), '/work/here');
});

test('sessionStartFolder tries each transcript in turn: a missing first one does not hide the second', () => {
  const stale = path.join(TMP, 'moved-away.jsonl');
  const moved = transcriptWith('/work/pfact', '/work/pfact/.claude/worktrees/x');
  const noCwd = transcriptWith();
  assert.equal(sessionStartFolder([stale, moved], '/work/now', MAC), '/work/pfact');
  assert.equal(sessionStartFolder([noCwd, moved], '/work/now', MAC), '/work/pfact');
  assert.equal(sessionStartFolder([moved, stale], '/work/now', MAC), '/work/pfact');
  assert.equal(sessionStartFolder([stale, noCwd], '/work/now', MAC), '/work/now');
  assert.equal(sessionStartFolder([undefined, moved], '/work/now', MAC), '/work/pfact');
});

test('sessionStartFolder with a start folder that is gone in the first transcript still tries the next', () => {
  const a = transcriptWith('/work/gone');
  const b = transcriptWith('/work/here');
  const exists = (p) => p === '/work/here';
  assert.equal(sessionStartFolder([a, b], '/work/now', { platform: 'darwin', exists }), '/work/here');
});

test('a relative cwd and a transcript with no cwd are dropped', () => {
  const dir = projectsDir([
    { folder: 'rel', cwd: 'relative/dir', mtime: BASE + 1 },
    { folder: 'none', mtime: BASE + 2 },
    { folder: 'empty', mtime: BASE + 3, body: '' },
  ]);
  assert.deepEqual(recentProjects({ projectsDir: dir, exists: yes, readClaudeConfig: noConfig, home: HOME }), []);
});

test('no projects folder, an empty one, or stray files give an empty list', () => {
  assert.deepEqual(recentProjects({ projectsDir: path.join(TMP, 'nope'), exists: yes, readClaudeConfig: noConfig, home: HOME }), []);
  const dir = projectsDir([{ folder: 'f', cwd: '/work/f', mtime: BASE, file: 'notes.txt' }]);
  fs.writeFileSync(path.join(dir, 'stray.jsonl'), '{}\n');
  assert.deepEqual(recentProjects({ projectsDir: dir, exists: yes, readClaudeConfig: noConfig, home: HOME }), []);
});

test('isTempPath', () => {
  for (const p of ['/tmp/x', '/private/tmp/claude-501/ns-probe', '/var/folders/ab/T/y', '/private/var/folders/ab/T/y',
    '/var/tmp/x', 'C:\\Users\\owner\\AppData\\Local\\Temp\\z', 'c:\\users\\owner\\appdata\\local\\temp', 'C:\\Windows\\Temp\\x']) {
    assert.equal(isTempPath(p), true, p);
  }
  for (const p of ['/Users/owner/Claude/personal/Spotify_car_thing', '/work/tmpfiles', '/Users/owner/tmp-notes',
    '/Users/owner/var/folders/x', 'C:\\Users\\owner\\code\\temp-app']) {
    assert.equal(isTempPath(p), false, p);
  }
});

// ---- trust (read only, never written) ----------------------------------------------------------------

function trustOf(projects, p, { home = HOME, config, platform } = {}) {
  const dir = projectsDir([{ folder: 'f', cwd: p, mtime: BASE }]);
  const got = recentProjects({
    projectsDir: dir, exists: yes, home, platform,
    readClaudeConfig: config || (() => ({ projects })),
  });
  assert.equal(got.length, 1);
  return got[0].trusted;
}

test('trusted: the folder\'s own entry accepted the trust dialog', () => {
  assert.equal(trustOf({ [`${HOME}/code/app`]: { hasTrustDialogAccepted: true } }, `${HOME}/code/app`), true);
});
test('trusted: an own entry that says false wins over a trusted parent', () => {
  assert.equal(trustOf({
    [`${HOME}/code`]: { hasTrustDialogAccepted: true },
    [`${HOME}/code/app`]: { hasTrustDialogAccepted: false },
  }, `${HOME}/code/app`), false);
});
test('trusted: no entry of its own inherits from the nearest ancestor that has one', () => {
  assert.equal(trustOf({ [`${HOME}/code`]: { hasTrustDialogAccepted: true } }, `${HOME}/code/app`), true);
  assert.equal(trustOf({
    [`${HOME}/code`]: { hasTrustDialogAccepted: true },
    [`${HOME}/code/group`]: { hasTrustDialogAccepted: false },
  }, `${HOME}/code/group/app`), false);
});
test('trusted: no entries, or an entry without the flag, is not trusted', () => {
  assert.equal(trustOf({}, `${HOME}/code/app`), false);
  assert.equal(trustOf({ [`${HOME}/code/app`]: { allowedTools: [] } }, `${HOME}/code/app`), false);
  assert.equal(trustOf({ [`${HOME}/code/app`]: { hasTrustDialogAccepted: 'yes' } }, `${HOME}/code/app`), false);
});
test('trusted: home itself is never an inherited source', () => {
  assert.equal(trustOf({ [HOME]: { hasTrustDialogAccepted: true } }, `${HOME}/code/app`), false);
});
test('trusted: a folder outside home inherits from its nearest ancestor too', () => {
  assert.equal(trustOf({ '/Volumes/work': { hasTrustDialogAccepted: true } }, '/Volumes/work/app'), true);
});
test('trusted: an unreadable or odd config gives false everywhere and does not throw', () => {
  const dir = projectsDir([
    { folder: 'a', cwd: '/work/a', mtime: BASE + 1 },
    { folder: 'b', cwd: '/work/b', mtime: BASE + 2 },
  ]);
  for (const config of [
    () => { throw new Error('EACCES'); },
    () => null,
    () => ({ projects: null }),
    () => ({ projects: 'nope' }),
    () => ({ projects: ['/work/a'] }),
  ]) {
    const got = recentProjects({ projectsDir: dir, exists: yes, home: HOME, readClaudeConfig: config });
    assert.deepEqual(got.map((p) => [p.path, p.trusted]), [['/work/b', false], ['/work/a', false]]);
  }
});

// ---- trust on Windows (the NucBox) -------------------------------------------------------------------
// There the transcripts give `cwd` as `c:\Users\owner\...`, ~/.claude.json keys read `c:/Users/owner/...`
// and os.homedir() is `C:\Users\owner`. The tests run on the Mac, so the platform is passed in.

const WIN_HOME = 'C:\\Users\\owner';
const WIN_CWD = 'c:\\Users\\owner\\Claude - server)\\personal\\pfact';
const WIN_KEY = 'c:/Users/owner/Claude - server)/personal/pfact';
const TRUSTED = { hasTrustDialogAccepted: true };
const REFUSED = { hasTrustDialogAccepted: false };

function winProjects(cwd, projects, { home = WIN_HOME } = {}) {
  const dir = projectsDir([{ folder: 'f', cwd, mtime: BASE }]);
  return recentProjects({
    projectsDir: dir, exists: yes, home, platform: 'win32', readClaudeConfig: () => ({ projects }),
  });
}
function winTrustOf(projects, cwd = WIN_CWD, opts) {
  const got = winProjects(cwd, projects, opts);
  assert.equal(got.length, 1);
  return got[0].trusted;
}

test('win32: a project trusted under its own forward-slash key is trusted', () => {
  const got = winProjects(WIN_CWD, { [WIN_KEY]: TRUSTED });
  assert.deepEqual(got, [{ name: 'pfact', path: WIN_CWD, lastUsed: BASE * 1000, trusted: true }]);
});
test('win32: a trusted parent folder trusts the project', () => {
  assert.equal(winTrustOf({ 'c:/Users/owner/Claude - server)': TRUSTED }), true);
});
test('win32: the nearest ancestor with an entry decides', () => {
  assert.equal(winTrustOf({
    'c:/Users/owner/Claude - server)': TRUSTED,
    'c:/Users/owner/Claude - server)/personal': REFUSED,
  }), false);
});
test('win32: the project\'s own false beats a trusted parent', () => {
  assert.equal(winTrustOf({ 'c:/Users/owner/Claude - server)': TRUSTED, [WIN_KEY]: REFUSED }), false);
});
test('win32: drive letter and case do not matter', () => {
  assert.equal(winTrustOf({ 'C:/USERS/owner/claude - server)/personal/pfact': TRUSTED }), true);
  assert.equal(winTrustOf({ [WIN_KEY]: TRUSTED }, WIN_CWD.toUpperCase()), true);
});
test('win32: a trailing slash on a key or on the folder does not matter', () => {
  assert.equal(winTrustOf({ [`${WIN_KEY}/`]: TRUSTED }), true);
  assert.equal(winTrustOf({ [WIN_KEY]: TRUSTED }, `${WIN_CWD}\\`), true);
});
test('win32: home is never consulted, whatever its case', () => {
  for (const home of [WIN_HOME, 'c:\\users\\OWNER', 'c:/Users/owner', 'C:\\Users\\owner\\']) {
    assert.equal(winTrustOf({ 'c:/Users/owner': TRUSTED }, WIN_CWD, { home }), false, home);
  }
});
test('win32: a sibling\'s entry and a longer or shorter name do not match', () => {
  assert.equal(winTrustOf({ [`${WIN_KEY}2`]: TRUSTED }), false);
  assert.equal(winTrustOf({ [WIN_KEY.slice(0, -1)]: TRUSTED }), false);
});
test('win32: a folder on another drive inherits too, up to the drive root', () => {
  assert.equal(winTrustOf({ 'd:/work': TRUSTED }, 'D:\\work\\app'), true);
  assert.equal(winTrustOf({}, 'D:\\work\\app'), false); // the walk ends at the root, it does not loop
});
test('win32: a relative cwd is not a project', () => {
  assert.deepEqual(winProjects('personal\\pfact', { [WIN_KEY]: TRUSTED }), []);
});
test('win32: the name is the folder\'s own, whatever the separators', () => {
  assert.deepEqual(winProjects('C:\\work\\app\\', {}).map((p) => p.name), ['app']);
});
test('win32: an unreadable or odd config gives false and does not throw', () => {
  const dir = projectsDir([{ folder: 'f', cwd: WIN_CWD, mtime: BASE }]);
  for (const config of [() => { throw new Error('EACCES'); }, () => null, () => ({ projects: 'nope' }), () => ({ projects: [WIN_KEY] })]) {
    const got = recentProjects({ projectsDir: dir, exists: yes, home: WIN_HOME, platform: 'win32', readClaudeConfig: config });
    assert.deepEqual(got.map((p) => p.trusted), [false]);
  }
});
test('posix: paths are still compared exactly, so the Mac check is unchanged', () => {
  const opts = { platform: 'darwin' };
  assert.equal(trustOf({ [`${HOME}/Code/app`]: TRUSTED }, `${HOME}/code/app`, opts), false); // case matters
  assert.equal(trustOf({ [`${HOME}/code/app/`]: TRUSTED }, `${HOME}/code/app`, opts), false); // so does a trailing slash
  assert.equal(trustOf({ '/work/a/b': TRUSTED }, '/work/a\\b', opts), false); // a backslash is just a character
  assert.equal(trustOf({ [`${HOME}/code/app`]: TRUSTED }, `${HOME}/code/app`, opts), true);
});

// ---- parseBackgrounded / startArgs -------------------------------------------------------------------

test('parseBackgrounded finds the short id', () => {
  assert.equal(parseBackgrounded('Starting background service…\nbackgrounded · c41c76b4 · panel probe\n'), 'c41c76b4');
});
test('parseBackgrounded gives null for anything else', () => {
  for (const out of ['', 'garbage', null, undefined, 'backgrounded · nothex!! · x', 'backgrounded · c41c76b · short', 'Starting background service…\n']) {
    assert.equal(parseBackgrounded(out), null, String(out));
  }
});

test('startArgs ends options before the prompt, so the prompt can never be read as a flag', () => {
  assert.deepEqual(startArgs('-rf $(x) "q"\nline2'), ['--bg', '--permission-mode', 'auto', '--', '-rf $(x) "q"\nline2']);
});
test('startArgs is always auto mode', () => {
  const args = startArgs('hello');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'auto');
  assert.ok(!args.some((a) => /bypass|dontAsk/i.test(a)));
});

// ---- the real starter --------------------------------------------------------------------------------

const PROJECT = { name: 'app', path: '/work/app', lastUsed: 1, trusted: true };
const ok = (shortId = '0a1b2c3d') => (bin, args, opts, cb) => cb(null, `Starting background service…\nbackgrounded · ${shortId} · x\n`, '');

function recorder(reply = ok()) {
  const calls = [];
  const run = (bin, args, opts, cb) => { calls.push({ bin, args, opts }); return reply(bin, args, opts, cb); };
  return { run, calls };
}

test('start refuses a path not in the recent list, and never runs claude', async () => {
  const { run, calls } = recorder();
  const starter = createStarter({ recent: () => [PROJECT], run });
  for (const p of ['/work/elsewhere', '/work/app/', '/work/app/sub', '', undefined, null, 42, { toString: () => '/work/app' }]) {
    await assert.rejects(starter.start({ path: p, prompt: 'hi' }), { message: 'not-a-recent-project' }, String(p));
  }
  assert.equal(calls.length, 0);
});

test('start asks for the recent list again each time', async () => {
  let list = [PROJECT];
  const { run, calls } = recorder();
  const starter = createStarter({ recent: () => list, run });
  await starter.start({ path: '/work/app', prompt: 'one' });
  list = []; // the folder was deleted between the project screen and START
  await assert.rejects(starter.start({ path: '/work/app', prompt: 'two' }), { message: 'not-a-recent-project' });
  assert.equal(calls.length, 1);
});

test('start accepts a recent list that comes back as a promise', async () => {
  const { run } = recorder();
  const starter = createStarter({ recent: async () => [PROJECT], run });
  assert.deepEqual(await starter.start({ path: '/work/app', prompt: 'hi' }), { shortId: '0a1b2c3d' });
});

test('start refuses empty and over-long prompts', async () => {
  const { run, calls } = recorder();
  const starter = createStarter({ recent: () => [PROJECT], run });
  for (const prompt of ['  ', '', '\n\t', undefined, null, 5]) {
    await assert.rejects(starter.start({ path: '/work/app', prompt }), { message: 'empty-prompt' }, String(prompt));
  }
  assert.equal(MAX_PROMPT_CHARS, 2000);
  await assert.rejects(starter.start({ path: '/work/app', prompt: 'x'.repeat(2001) }), { message: 'prompt-too-long' });
  assert.deepEqual(await starter.start({ path: '/work/app', prompt: 'x'.repeat(2000) }), { shortId: '0a1b2c3d' });
  assert.equal(calls.length, 1);
});

test('start runs claude in the project folder and returns the short id', async () => {
  const { run, calls } = recorder();
  const starter = createStarter({ recent: () => [PROJECT], run });
  const prompt = '-rf $(x) "q"\nline2';
  assert.deepEqual(await starter.start({ path: '/work/app', prompt }), { shortId: '0a1b2c3d' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, 'claude');
  assert.deepEqual(calls[0].args, startArgs(prompt));
  assert.equal(calls[0].opts.cwd, '/work/app');
  assert.equal(calls[0].opts.timeout, 30_000);
  assert.equal(calls[0].opts.shell, undefined, 'never through a shell');
});

test('start passes the prompt trimmed, as one argument', async () => {
  const { run, calls } = recorder();
  const starter = createStarter({ recent: () => [PROJECT], run });
  await starter.start({ path: '/work/app', prompt: '  fix the bug  \n' });
  assert.equal(calls[0].args.length, 5);
  assert.equal(calls[0].args[4], 'fix the bug');
});

test('start gives claude end-of-input rather than a pipe that stays open', async () => {
  let ended = 0;
  const run = (bin, args, opts, cb) => { cb(null, 'backgrounded · 0a1b2c3d · x\n', ''); return { stdin: { end() { ended++; } } }; };
  const starter = createStarter({ recent: () => [PROJECT], run });
  await starter.start({ path: '/work/app', prompt: 'hi' });
  assert.equal(ended, 1);
});

test('start uses the claude binary it was given', async () => {
  const { run, calls } = recorder();
  const starter = createStarter({ recent: () => [PROJECT], run, claudeBin: '/opt/bin/claude' });
  await starter.start({ path: '/work/app', prompt: 'hi' });
  assert.equal(calls[0].bin, '/opt/bin/claude');
});

test('start fails cleanly', async () => {
  const starter = createStarter({ recent: () => [PROJECT], run: (b, a, o, cb) => cb(new Error('boom'), '', '') });
  await assert.rejects(starter.start({ path: '/work/app', prompt: 'hi' }), { message: 'start-failed' });
});

test('start fails cleanly when run throws at once', async () => {
  const throws = createStarter({ recent: () => [PROJECT], run: () => { throw new TypeError('ERR_INVALID_ARG_VALUE'); } });
  await assert.rejects(throws.start({ path: '/work/app', prompt: 'hi' }), { message: 'start-failed' });
});

test('start-unconfirmed: claude exited 0 but printed no job the service can read (it may have started)', async () => {
  const quiet = createStarter({ recent: () => [PROJECT], run: (b, a, o, cb) => cb(null, 'Starting background service…\n', '') });
  await assert.rejects(quiet.start({ path: '/work/app', prompt: 'hi' }), { message: 'start-unconfirmed' });
  const empty = createStarter({ recent: () => [PROJECT], run: (b, a, o, cb) => cb(null, '', '') });
  await assert.rejects(empty.start({ path: '/work/app', prompt: 'hi' }), { message: 'start-unconfirmed' });
});

test('start-unconfirmed: claude was killed or timed out, after it may have handed the job to the daemon', async () => {
  const killed = Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM', code: null });
  const signalled = Object.assign(new Error('Command failed'), { signal: 'SIGKILL', code: null });
  const timedOut = Object.assign(new Error('spawnSync claude ETIMEDOUT'), { code: 'ETIMEDOUT' });
  for (const e of [killed, signalled, timedOut]) {
    const starter = createStarter({ recent: () => [PROJECT], run: (b, a, o, cb) => cb(e, 'Starting background service…\n', '') });
    await assert.rejects(starter.start({ path: '/work/app', prompt: 'hi' }), { message: 'start-unconfirmed' }, e.signal || e.code);
  }
});

test('start-unconfirmed is not remembered as a started job', async () => {
  const killed = Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' });
  const starter = createStarter({ recent: () => [PROJECT], run: (b, a, o, cb) => cb(killed, 'backgrounded · 0a1b2c3d · x', '') });
  await assert.rejects(starter.start({ path: '/work/app', prompt: 'hi' }), { message: 'start-unconfirmed' });
  assert.equal(starter.started('0a1b2c3d-1111-2222-3333-444455556666'), false);
});

test('start-failed stays for a non-zero exit that was not a kill or a timeout, and for a spawn error', async () => {
  for (const e of [Object.assign(new Error('Command failed'), { code: 1 }), Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })]) {
    const starter = createStarter({ recent: () => [PROJECT], run: (b, a, o, cb) => cb(e, '', '') });
    await assert.rejects(starter.start({ path: '/work/app', prompt: 'hi' }), { message: 'start-failed' }, String(e.code));
  }
});

test('a trust refusal stays not-trusted even when the process was killed afterwards', async () => {
  const e = Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' });
  const starter = createStarter({ recent: () => [PROJECT], run: (b, a, o, cb) => cb(e, '', 'Workspace not trusted.\n') });
  await assert.rejects(starter.start({ path: '/work/app', prompt: 'hi' }), { message: 'not-trusted' });
});

test('start fails with start-failed when the recent list itself cannot be read', async () => {
  const { run, calls } = recorder();
  const starter = createStarter({ recent: () => { throw new Error('EIO'); }, run });
  await assert.rejects(starter.start({ path: '/work/app', prompt: 'hi' }), { message: 'start-failed' });
  assert.equal(calls.length, 0);
});

test('a folder Claude Code does not trust is not-trusted, from stderr in either form', async () => {
  const stderr = 'Workspace not trusted. Run `claude` in /work/app once and accept the trust prompt, then retry.\n';
  const viaCallback = createStarter({ recent: () => [PROJECT], run: (b, a, o, cb) => cb(Object.assign(new Error('Command failed'), { code: 1 }), '', stderr) });
  await assert.rejects(viaCallback.start({ path: '/work/app', prompt: 'hi' }), { message: 'not-trusted' });
  const viaError = createStarter({ recent: () => [PROJECT], run: (b, a, o, cb) => cb(Object.assign(new Error('Command failed'), { code: 1, stderr }), '', '') });
  await assert.rejects(viaError.start({ path: '/work/app', prompt: 'hi' }), { message: 'not-trusted' });
});

test('an untrusted recent path is still attempted: the panel decides what to show', async () => {
  const { run, calls } = recorder();
  const starter = createStarter({ recent: () => [{ ...PROJECT, trusted: false }], run });
  assert.deepEqual(await starter.start({ path: '/work/app', prompt: 'hi' }), { shortId: '0a1b2c3d' });
  assert.equal(calls.length, 1);
});

test('any other failure stays start-failed', async () => {
  const starter = createStarter({
    recent: () => [PROJECT],
    run: (b, a, o, cb) => cb(Object.assign(new Error('Command failed'), { code: 1 }), '', 'something else went wrong\n'),
  });
  await assert.rejects(starter.start({ path: '/work/app', prompt: 'hi' }), { message: 'start-failed' });
});

test('recent is the injected function, so both starters share one shape', async () => {
  const recent = () => [PROJECT];
  const starter = createStarter({ recent, run: recorder().run });
  assert.equal(starter.recent, recent);
  assert.equal(typeof starter.start, 'function');
  assert.equal(typeof starter.started, 'function');
});

test('started() remembers the short ids it started, by the first eight characters of a session id', async () => {
  const starter = createStarter({ recent: () => [PROJECT], run: recorder(ok('0a1b2c3d')).run });
  assert.equal(starter.started('0a1b2c3d-1111-2222-3333-444455556666'), false, 'nothing started yet');
  await starter.start({ path: '/work/app', prompt: 'hi' });
  assert.equal(starter.started('0a1b2c3d-1111-2222-3333-444455556666'), true);
  assert.equal(starter.started('0a1b2c3d'), true);
  assert.equal(starter.started('ffffffff-1111-2222-3333-444455556666'), false);
  assert.equal(starter.started(undefined), false);
  assert.equal(starter.started(''), false);
});

test('a start that failed is not remembered', async () => {
  const starter = createStarter({ recent: () => [PROJECT], run: (b, a, o, cb) => cb(new Error('boom'), 'backgrounded · 0a1b2c3d · x', '') });
  await assert.rejects(starter.start({ path: '/work/app', prompt: 'hi' }));
  assert.equal(starter.started('0a1b2c3d-1111-2222-3333-444455556666'), false);
});

test('started() is bounded at 40, dropping the oldest first', async () => {
  let n = 0;
  const hex = (i) => i.toString(16).padStart(8, '0');
  const starter = createStarter({
    recent: () => [PROJECT],
    run: (b, a, o, cb) => cb(null, `backgrounded · ${hex(++n)} · x\n`, ''),
  });
  for (let i = 0; i < 45; i++) await starter.start({ path: '/work/app', prompt: 'hi' });
  assert.equal(starter.started(`${hex(45)}-aaaa`), true);
  assert.equal(starter.started(`${hex(6)}-aaaa`), true, 'the 40th newest is still there');
  assert.equal(starter.started(`${hex(5)}-aaaa`), false, 'older ones are dropped');
  assert.equal(starter.started(`${hex(1)}-aaaa`), false);
});

test('a started session is never marked as the daemon\'s own, or the panel would hide it', async () => {
  const starter = createStarter({ recent: () => [PROJECT], run: recorder(ok('5e5e5e5e')).run });
  await starter.start({ path: '/work/app', prompt: 'hi' });
  assert.equal(isOwnSession('5e5e5e5e'), false);
});

test('each start logs one line: the job and the folder, never the prompt', async () => {
  logged.length = 0;
  const starter = createStarter({ recent: () => [PROJECT], run: recorder(ok('0a1b2c3d')).run });
  await starter.start({ path: '/work/app', prompt: 'a very private prompt' });
  assert.equal(logged.length, 1);
  assert.match(logged[0], /0a1b2c3d/);
  assert.match(logged[0], /app/);
  assert.doesNotMatch(logged[0], /private prompt/);
});

test('a failed start logs one line without the prompt either', async () => {
  logged.length = 0;
  const starter = createStarter({ recent: () => [PROJECT], run: (b, a, o, cb) => cb(new Error('boom'), '', 'Workspace not trusted. Run `claude`') });
  await assert.rejects(starter.start({ path: '/work/app', prompt: 'a very private prompt' }));
  assert.equal(logged.length, 1);
  assert.match(logged[0], /not-trusted/);
  assert.doesNotMatch(logged[0], /private prompt/);
});

// ---- the demo starter (MOCK_SESSIONS) ----------------------------------------------------------------

test('mock starter: recent() returns exactly five fixed demo projects, all trusted', () => {
  const mockStarter = createMockStarter({ store: createStore() });
  const first = mockStarter.recent();
  assert.equal(first.length, 5);
  for (const p of first) {
    assert.equal(p.trusted, true);
    assert.equal(p.name, path.basename(p.path));
    assert.ok(path.isAbsolute(p.path));
    const age = Date.now() - p.lastUsed;
    assert.ok(age >= 0 && age < 7 * 24 * 3600_000, `${p.name} was used within the last few days`);
  }
  assert.deepEqual(first.map((p) => p.lastUsed), [...first.map((p) => p.lastUsed)].sort((a, b) => b - a), 'newest first');
  assert.deepEqual(mockStarter.recent().map((p) => p.path), first.map((p) => p.path), 'the same five each time');
});

test('mock starter: start adds a background session whose id starts with the short id', async () => {
  const store = createStore();
  const mockStarter = createMockStarter({ store });
  const [project] = mockStarter.recent();
  const { shortId } = await mockStarter.start({ path: project.path, prompt: 'tidy the readme' });
  assert.match(shortId, /^[0-9a-f]{8}$/);
  const entries = store.entries().filter(([id]) => id.startsWith(shortId));
  assert.equal(entries.length, 1);
  const [id, raw] = entries[0];
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(raw.kind, 'background');
  assert.equal(raw.jobId, shortId);
  assert.equal(raw.cwd, project.path);
  assert.equal(raw.lastPrompt, 'tidy the readme');
  assert.equal(raw.lastMessage, 'tidy the readme');
  assert.equal(raw.thinking, true);
  assert.equal(store.get(id).background, true);
  assert.equal(isOwnSession(id), false);
});

test('mock starter: two starts make two sessions', async () => {
  const store = createStore();
  const mockStarter = createMockStarter({ store });
  const [project] = mockStarter.recent();
  const a = await mockStarter.start({ path: project.path, prompt: 'one' });
  const b = await mockStarter.start({ path: project.path, prompt: 'two' });
  assert.notEqual(a.shortId, b.shortId);
  assert.equal(store.count(), 2);
});

test('mock starter: the same checks as the real one', async () => {
  const store = createStore();
  const mockStarter = createMockStarter({ store });
  const [project] = mockStarter.recent();
  await assert.rejects(mockStarter.start({ path: project.path, prompt: '  ' }), { message: 'empty-prompt' });
  await assert.rejects(mockStarter.start({ path: project.path, prompt: 'x'.repeat(2001) }), { message: 'prompt-too-long' });
  await assert.rejects(mockStarter.start({ path: '/not/a/recent/one', prompt: 'hi' }), { message: 'not-a-recent-project' });
  assert.equal(store.count(), 0);
});

test('mock starter: started() remembers what it starts', async () => {
  const mockStarter = createMockStarter({ store: createStore() });
  const [project] = mockStarter.recent();
  assert.equal(mockStarter.started('0a1b2c3d-1111-2222-3333-444455556666'), false);
  const { shortId } = await mockStarter.start({ path: project.path, prompt: 'hi' });
  assert.equal(mockStarter.started(`${shortId}-1111-2222-3333-444455556666`), true);
  assert.equal(mockStarter.started('ffffffff-1111-2222-3333-444455556666'), false);
});
