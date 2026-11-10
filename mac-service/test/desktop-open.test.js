import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-open-'));
// log.js empties <LOG_DIR>/daemon.log on import, and in the checkout that is the live service's log.
process.env.CLAUDE_THING_LOG_DIR = path.join(root, 'logs');

const { CONTINUE_PROMPT } = await import('../src/handoff.js');
const { OPEN_TASK, REQUEST_MAX_AGE_MS, parseQuser, createDesktopOpener } = await import('../src/desktop-open.js');

// What check() logs when a call fails; the tests read those lines instead of printing them.
const logged = [];
mock.method(console, 'log', (line) => { logged.push(String(line)); });
after(async () => {
  mock.restoreAll();
  // Wait for log.js's stream to open its file, or the open fails with ENOENT once the folder is gone.
  const logFile = path.join(root, 'logs', 'daemon.log');
  for (let i = 0; i < 100 && !fs.existsSync(logFile); i++) await new Promise((r) => setTimeout(r, 10));
  fs.rmSync(root, { recursive: true, force: true });
});
let n = 0;
// A folder of its own per test, a level below the root so the opener has to make it.
const freshDir = () => path.join(root, `t${n += 1}`, 'open-in-vscode');

const SID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const SID2 = '1b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e';
const CWD = 'C:\\Users\\owner\\Claude\\proj';

// What `quser` printed for the owner over Remote Desktop, from the NucBox's S4U service account
// (measured 2026-11-07, exit 0).
const QUSER_ACTIVE = [
  ' USERNAME              SESSIONNAME        ID  STATE   IDLE TIME  LOGON TIME',
  ' owner                 rdp-tcp#0           1  Active          .  10/15/2026 9:04 AM',
  '',
].join('\r\n');
// The same session after the Remote Desktop window was closed: no session name, so the columns shift left.
const QUSER_DISC = [
  ' USERNAME              SESSIONNAME        ID  STATE   IDLE TIME  LOGON TIME',
  ' owner                                     2  Disc      1+02:00  10/15/2026 9:04 AM',
  '',
].join('\r\n');

// ---- parseQuser ------------------------------------------------------------------------------------

test('parseQuser: an Active row of the user is a desktop', () => {
  assert.equal(parseQuser(QUSER_ACTIVE, 'owner'), true);
  assert.equal(parseQuser(' owner  rdp-tcp#0  1  Active  3:48  10/15/2026 9:04 AM', 'owner'), true);
});

test('parseQuser: a disconnected row (no session name) is a desktop', () => {
  assert.equal(parseQuser(QUSER_DISC, 'owner'), true);
  assert.equal(parseQuser(' owner  2  Disc  1+02:00  10/15/2026 9:04 AM', 'owner'), true);
});

test('parseQuser: the > marker and case do not matter', () => {
  assert.equal(parseQuser('>OWNER  console  1  Active  .  10/15/2026 9:04 AM', 'owner'), true);
  assert.equal(parseQuser(' owner  console  1  active  .  10/15/2026 9:04 AM', 'OWNER'), true);
  assert.equal(parseQuser('> owner  console  1  Active  .  10/15/2026 9:04 AM', 'owner'), true);
});

test('parseQuser: another user only, or "No User exists", is not', () => {
  const other = QUSER_ACTIVE.replace(' owner ', ' guest ');
  assert.equal(parseQuser(other, 'owner'), false);
  assert.equal(parseQuser('No User exists for *', 'owner'), false);
  assert.equal(parseQuser('', 'owner'), false);
  assert.equal(parseQuser(undefined, 'owner'), false);
  // a name that merely starts with the user's is someone else
  assert.equal(parseQuser(' owner2  rdp-tcp#1  3  Active  .  10/15/2026 9:04 AM', 'owner'), false);
  // the header is not a row, even for a user called username
  assert.equal(parseQuser(' USERNAME  SESSIONNAME  ID  STATE  IDLE TIME  LOGON TIME', 'username'), false);
});

test('parseQuser: the user in any other state is not a desktop, and a later row of the user still counts', () => {
  assert.equal(parseQuser(' owner  rdp-tcp#0  1  Down  .  10/15/2026 9:04 AM', 'owner'), false);
  const two = [QUSER_ACTIVE.split('\r\n')[0], ' guest  rdp-tcp#1  3  Active  .  x', ' owner  rdp-tcp#0  1  Active  .  x'].join('\n');
  assert.equal(parseQuser(two, 'owner'), true);
});

// ---- a fake run and a fake helper ------------------------------------------------------------------------

const fail = (message, extra = {}) => Object.assign(new Error(message), extra);

// execFile's signature. Records every call; answers like schtasks/quser; and plays the helper when
// `schtasks /run` is called: `helper(dir)` runs then (it may write result.json), or not at all.
function fakeRun({ dir, queryErr = null, quser = QUSER_ACTIVE, quserErr = null, runErr = null, helper = null, helperDelayMs = 5 } = {}) {
  const calls = [];
  const run = (file, args, opts, cb) => {
    calls.push({ file, args, opts });
    const answer = (err, stdout = '', stderr = '') => setImmediate(() => cb(err, stdout, stderr));
    if (file === 'schtasks' && args[0] === '/query') return answer(queryErr, queryErr ? '' : 'TaskName  Next Run Time  Status\n');
    if (file === 'quser') return answer(quserErr, quserErr ? '' : quser);
    if (file === 'schtasks' && args[0] === '/run') {
      if (runErr) return answer(runErr, '', 'ERROR: The system cannot find the file specified.');
      if (helper) setTimeout(() => helper(dir), helperDelayMs);
      return answer(null, 'SUCCESS: Attempted to run the scheduled task.\n');
    }
    return answer(fail(`unexpected ${file}`));
  };
  return { run, calls };
}

const readRequest = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'request.json'), 'utf8'));
// The helper's way of answering: a .tmp file, then a rename.
function writeResult(dir, result) {
  const file = path.join(dir, 'result.json');
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(result));
  fs.renameSync(`${file}.tmp`, file);
}
// A helper that answers the request it finds, as the real one would.
const answering = (make = () => ({ ok: true })) => (dir) => {
  const req = readRequest(dir);
  writeResult(dir, { nonce: req.nonce, ...make(req) });
};

function opener(extra = {}) {
  const dir = extra.dir || freshDir();
  const fake = fakeRun({ dir, ...(extra.fake || {}) });
  const o = createDesktopOpener({ run: fake.run, dir, user: 'owner', pollMs: 5, timeoutMs: 1000, ...extra.opts });
  return { o, dir, calls: fake.calls };
}

const names = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

// ---- check -----------------------------------------------------------------------------------------------

test('check: no helper task is not-set-up', async () => {
  const { o, calls } = opener({ fake: { queryErr: fail('ERROR: The system cannot find the file specified.', { code: 1 }) } });
  assert.equal(await o.check(), 'not-set-up');
  assert.deepEqual(calls.map((c) => [c.file, ...c.args]), [['schtasks', '/query', '/tn', OPEN_TASK]]);
});

test('check: quser failing or not listing the user is no-desktop', async () => {
  assert.equal(await opener({ fake: { quserErr: fail('No User exists for *', { code: 1 }) } }).o.check(), 'no-desktop');
  assert.equal(await opener({ fake: { quser: QUSER_ACTIVE.replace(' owner ', ' guest ') } }).o.check(), 'no-desktop');
  assert.equal(await opener({ fake: { quser: '' } }).o.check(), 'no-desktop');
});

test('check: helper present and the user logged in, connected or not, is null', async () => {
  const active = opener();
  assert.equal(await active.o.check(), null);
  assert.deepEqual(active.calls.map((c) => c.file), ['schtasks', 'quser']);
  assert.equal(await opener({ fake: { quser: QUSER_DISC } }).o.check(), null);
});

test('check: every call has a 10 s timeout', async () => {
  const { o, calls } = opener();
  await o.check();
  assert.equal(calls.length, 2);
  for (const c of calls) assert.equal(c.opts.timeout, 10_000);
});

test('check: never rejects, whatever run does', async () => {
  const dir = freshDir();
  const throws = createDesktopOpener({ run: () => { throw new Error('boom'); }, dir, user: 'owner' });
  assert.equal(await throws.check(), 'not-set-up');
  // the helper is there, but quser throws
  const half = createDesktopOpener({
    run: (file, args, opts, cb) => { if (file === 'quser') throw new Error('boom'); setImmediate(() => cb(null, '', '')); },
    dir, user: 'owner',
  });
  assert.equal(await half.check(), 'no-desktop');
});

// A failed call is logged, one line, so a not-set-up or no-desktop after a deploy says why. The answer is the same.
const checkLines = () => logged.filter((l) => / DO /.test(l));

test('check: a failed schtasks /query is logged once, with the first line of what it said, and is still not-set-up', async () => {
  // execFile's own error message starts "Command failed: …"; what schtasks wrote to stderr says more.
  const err = fail('Command failed: schtasks /query /tn x\nERROR: The system cannot find the file specified.\r\n', { code: 1 });
  const run = (file, args, opts, cb) => setImmediate(() => cb(err, '', 'ERROR: The system cannot find the file specified.\r\nsecond line\r\n'));
  logged.length = 0;
  assert.equal(await createDesktopOpener({ run, dir: freshDir(), user: 'owner' }).check(), 'not-set-up');
  const lines = checkLines();
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /not-set-up.*ERROR: The system cannot find the file specified\.$/);
});

test('check: a failed quser is logged once, and is still no-desktop', async () => {
  logged.length = 0;
  const run = (file, args, opts, cb) => setImmediate(() => (file === 'quser'
    ? cb(fail('Command failed: quser', { code: 1 }), '', 'No User exists for *\r\n')
    : cb(null, 'TaskName\n', '')));
  assert.equal(await createDesktopOpener({ run, dir: freshDir(), user: 'owner' }).check(), 'no-desktop');
  const lines = checkLines();
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /no-desktop.*No User exists for \*$/);
});

test('check: with nothing on stderr the error\'s own first line is logged, and a thrown run is logged too', async () => {
  logged.length = 0;
  const timedOut = (file, args, opts, cb) => setImmediate(() => cb(fail('Command failed: schtasks /query\nmore'), '', ''));
  assert.equal(await createDesktopOpener({ run: timedOut, dir: freshDir(), user: 'owner' }).check(), 'not-set-up');
  assert.match(checkLines()[0], /Command failed: schtasks \/query$/);
  logged.length = 0;
  const throws = () => { throw new Error('spawn EINVAL'); };
  assert.equal(await createDesktopOpener({ run: throws, dir: freshDir(), user: 'owner' }).check(), 'not-set-up');
  assert.match(checkLines()[0], /spawn EINVAL/);
});

test('check: a check that works, or a quser that just does not list the owner, logs nothing', async () => {
  logged.length = 0;
  assert.equal(await opener().o.check(), null);
  assert.equal(await opener({ fake: { quser: QUSER_ACTIVE.replace(' owner ', ' guest ') } }).o.check(), 'no-desktop');
  assert.deepEqual(checkLines(), []);
});

// ---- open ------------------------------------------------------------------------------------------------

test('open: writes the request, runs the task, resolves on its result', async () => {
  const t0 = 1_700_000_000_000;
  const seen = []; // the request as the helper finds it
  const { o, dir, calls } = opener({
    fake: { helper: (d) => { seen.push(readRequest(d)); answering()(d); } },
    opts: { now: () => t0 },
  });
  const r = await o.open(CWD, SID);
  assert.deepEqual(r, { focused: true, app: 'Code', exact: false });
  assert.deepEqual(calls.map((c) => [c.file, ...c.args]), [['schtasks', '/run', '/tn', OPEN_TASK]]);
  assert.equal(calls[0].opts.timeout, 10_000);
  assert.equal(seen.length, 1);
  assert.deepEqual(Object.keys(seen[0]).sort(), ['continue', 'createdTs', 'cwd', 'nonce', 'sessionId']);
  assert.match(seen[0].nonce, /^[0-9a-f]{32}$/);
  assert.equal(seen[0].sessionId, SID);
  assert.equal(seen[0].cwd, CWD);
  assert.equal(seen[0].continue, false);
  assert.equal(seen[0].createdTs, t0);
  // no .tmp left behind, and the request is gone with the answer
  assert.ok(!names(dir).includes('request.json.tmp'));
  assert.ok(!names(dir).includes('request.json'));
});

test('open: the request is UTF-8 with no BOM, and each call has a nonce of its own', async () => {
  const cwd = 'C:\\Users\\owner\\Café ✓\\proj';
  const bytes = [];
  const reqs = [];
  const { o } = opener({
    fake: {
      helper: (d) => {
        bytes.push(fs.readFileSync(path.join(d, 'request.json')));
        reqs.push(readRequest(d));
        answering()(d);
      },
    },
  });
  await o.open(cwd, SID);
  await o.open(cwd, SID);
  assert.notDeepEqual([...bytes[0].subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(reqs[0].cwd, cwd);
  assert.notEqual(reqs[0].nonce, reqs[1].nonce);
});

test('open: the continue prompt sets continue:true', async () => {
  const seen = [];
  const { o } = opener({ fake: { helper: (d) => { seen.push(readRequest(d)); answering()(d); } } });
  await o.open(CWD, SID, CONTINUE_PROMPT);
  await o.open(CWD, SID, 'some other prompt');
  await o.open(CWD, SID, undefined);
  assert.deepEqual(seen.map((r) => r.continue), [true, false, false]);
});

test('open: a result with another nonce is ignored, then helper-timeout', async () => {
  const { o, dir } = opener({
    fake: { helper: (d) => writeResult(d, { nonce: 'f'.repeat(32), ok: true }) },
    opts: { timeoutMs: 80, now: () => 1 }, // a clock that stands still does not hold the wait up
  });
  const t0 = Date.now();
  assert.deepEqual(await o.open(CWD, SID), { focused: false, reason: 'helper-timeout' });
  assert.ok(Date.now() - t0 < 1500, 'gave up at the timeout');
  assert.ok(!names(dir).includes('request.json'), 'request removed');
  assert.ok(!names(dir).includes('request.json.tmp'));
});

test('open: a result that cannot be read yet is ignored, and the answer after it is taken', async () => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const { o } = opener({
    fake: {
      helper: (d) => {
        // a half-written file, then the whole thing — with the BOM PowerShell 5.1's UTF8 adds
        const file = path.join(d, 'result.json');
        const { nonce } = readRequest(d);
        fs.writeFileSync(file, '{"nonce":"' + nonce.slice(0, 10));
        setTimeout(() => fs.writeFileSync(file, Buffer.concat([bom, Buffer.from(JSON.stringify({ nonce, ok: true }))])), 40);
      },
    },
  });
  assert.deepEqual(await o.open(CWD, SID), { focused: true, app: 'Code', exact: false });
});

test("open: the helper's refusal is the reason", async () => {
  const { o, dir } = opener({ fake: { helper: answering(() => ({ ok: false, reason: 'no-folder' })) } });
  assert.deepEqual(await o.open(CWD, SID), { focused: false, reason: 'no-folder' });
  assert.ok(!names(dir).includes('request.json'));
  // a refusal that names nothing is still a refusal
  const bare = opener({ fake: { helper: answering(() => ({ ok: false })) } });
  const r = await bare.o.open(CWD, SID);
  assert.equal(r.focused, false);
  assert.equal(typeof r.reason, 'string');
  assert.ok(r.reason);
});

test('open: schtasks failing is helper-not-run, request removed', async () => {
  const { o, dir } = opener({ fake: { runErr: fail('ERROR: The system cannot find the file specified.', { code: 1 }) } });
  assert.deepEqual(await o.open(CWD, SID), { focused: false, reason: 'helper-not-run' });
  assert.ok(!names(dir).includes('request.json'));
  assert.ok(!names(dir).includes('request.json.tmp'));
});

test('open: a non-UUID session id, or a relative folder, is bad-request and runs nothing', async () => {
  const { o, dir, calls } = opener({ fake: { helper: answering() } });
  const bad = { focused: false, reason: 'bad-request' };
  assert.deepEqual(await o.open(CWD, 'not-a-uuid'), bad);
  assert.deepEqual(await o.open(CWD, `${SID}; calc`), bad);
  assert.deepEqual(await o.open(CWD, undefined), bad);
  assert.deepEqual(await o.open('proj\\sub', SID), bad);
  assert.deepEqual(await o.open('', SID), bad);
  assert.deepEqual(await o.open(undefined, SID), bad);
  assert.deepEqual(calls, []);
  assert.ok(!fs.existsSync(path.join(dir, 'request.json')));
  // "relative to the current folder of drive C" is not a place either
  assert.deepEqual(await o.open('C:proj', SID), bad);
  // a UUID in any case is fine
  assert.equal((await o.open(CWD, SID.toUpperCase())).focused, true);
});

test('open: an old result.json is removed before the request is written', async () => {
  const dir = freshDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ nonce: 'a'.repeat(32), ok: true }));
  let atRun = null;
  const calls = [];
  const run = (file, args, opts, cb) => {
    calls.push([file, ...args]);
    atRun = { result: fs.existsSync(path.join(dir, 'result.json')), request: fs.existsSync(path.join(dir, 'request.json')) };
    setImmediate(() => cb(null, '', ''));
  };
  const o = createDesktopOpener({ run, dir, user: 'owner', pollMs: 5, timeoutMs: 60 });
  assert.deepEqual(await o.open(CWD, SID), { focused: false, reason: 'helper-timeout' });
  assert.deepEqual(atRun, { result: false, request: true });
  assert.deepEqual(calls, [['schtasks', '/run', '/tn', OPEN_TASK]]);
});

test('open: a folder that cannot be made is helper-not-run, and nothing is run', async () => {
  const blocker = path.join(root, 'a-file');
  fs.writeFileSync(blocker, 'x');
  const { o, calls } = opener({ dir: path.join(blocker, 'open-in-vscode') });
  assert.deepEqual(await o.open(CWD, SID), { focused: false, reason: 'helper-not-run' });
  assert.deepEqual(calls, []);
});

test('open: never rejects, even when run throws', async () => {
  const dir = freshDir();
  const o = createDesktopOpener({ run: () => { throw new Error('boom'); }, dir, user: 'owner', pollMs: 5, timeoutMs: 50 });
  assert.deepEqual(await o.open(CWD, SID), { focused: false, reason: 'helper-not-run' });
  assert.ok(!names(dir).includes('request.json'));
});

test('open: calls are one at a time, so one never takes the other\'s request or answer', async () => {
  const { o, dir, calls } = opener({
    fake: { helper: answering((req) => (req.sessionId === SID ? { ok: true } : { ok: false, reason: 'no-folder' })), helperDelayMs: 20 },
  });
  const [a, b] = await Promise.all([o.open(CWD, SID), o.open(CWD, SID2)]);
  assert.equal(a.focused, true);
  assert.deepEqual(b, { focused: false, reason: 'no-folder' });
  assert.equal(calls.length, 2);
  assert.ok(!names(dir).includes('request.json'));
});

test('the numbers the helper and the service share', () => {
  assert.equal(OPEN_TASK, 'Car Thing panel - Open in VS Code');
  assert.equal(REQUEST_MAX_AGE_MS, 60_000);
});
