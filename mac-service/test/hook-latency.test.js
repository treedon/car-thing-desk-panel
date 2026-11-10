// scripts/hook-latency.js: the check that the digest does not slow Claude Code's hooks. The pure parts
// (percentiles, the two verdict rules and how they combine, the default transcript lookup, the options, the
// synthetic transcript and the service's environment) are tested here exactly. The script's runs are tested
// end to end two ways: against real services on a small synthetic transcript, with the verdicts forced by
// --margin and --burst-margin so that no timing decides a test, and against a stand-in service (a script
// below) that stalls, dies or reports what the test wants, so the burst rule, the FAIL that outranks an
// INCONCLUSIVE, a service dying mid-run and the clean-up are all exact.
//
// Nothing here reads ~/.claude or ~/.config: every transcript is synthetic (or a sentinel line written
// below), the script under test is given a temp HOME, TMPDIR and CLAUDE_CONFIG_DIR and an empty PATH, and
// the services it starts (real src/index.js, on a free loopback port) keep every file inside its temp dir.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/hook-latency.js', import.meta.url));
const { summarize, verdict, burstVerdict, whyInconclusive, finalVerdict, exitCodeFor, largestTranscript, parseArgs, serviceEnv, main } =
  await import('../scripts/hook-latency.js');
const { writeSyntheticTranscript } = await import('../scripts/synthetic-transcript.js');

const NOW = Date.parse('2026-11-02T12:00:00Z');
const MB = 1024 * 1024;

let TMP;
before(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-thing-hook-latency-test-')); });
after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

// ---- the pure exports --------------------------------------------------------------------------------

test('summarize gives nearest-rank percentiles', () => {
  const ms = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.deepEqual(summarize(ms), { p50: 50, p99: 99, max: 100, n: 100 });
});

test('summarize: unsorted input is left alone, one sample is every percentile, no samples is n 0 and null', () => {
  const ms = [9, 1, 5];
  assert.deepEqual(summarize(ms), { p50: 5, p99: 9, max: 9, n: 3 });
  assert.deepEqual(ms, [9, 1, 5]);
  assert.deepEqual(summarize([7]), { p50: 7, p99: 7, max: 7, n: 1 });
  assert.deepEqual(summarize([]), { p50: null, p99: null, max: null, n: 0 });
  // 250 samples: the 99th percentile is the 248th smallest (ceil(0.99 * 250) = 248)
  const many = Array.from({ length: 250 }, (_, i) => i + 1);
  assert.equal(summarize(many).p99, 248);
  assert.equal(summarize(many).p50, 125);
  // read out to hundredths of a millisecond
  assert.deepEqual(summarize([1.23456, 2.34567]), { p50: 1.23, p99: 2.35, max: 2.35, n: 2 });
});

test('the verdict allows 10 ms over the digest-off p99, no more', () => {
  assert.equal(verdict({ p99: 4 }, { p99: 14 }), 'PASS');
  assert.equal(verdict({ p99: 4 }, { p99: 14.5 }), 'FAIL');
});

test('the verdict: a faster digest-on run passes, the margin is a parameter, and a run with no p99 cannot pass', () => {
  assert.equal(verdict({ p99: 4 }, { p99: 2 }), 'PASS');
  assert.equal(verdict({ p99: 4 }, { p99: 6 }, 2), 'PASS');
  assert.equal(verdict({ p99: 4 }, { p99: 6.1 }, 2), 'FAIL');
  assert.equal(verdict({ p99: 4 }, { p99: 4.5 }, -1), 'FAIL');
  assert.equal(verdict({ p99: null }, { p99: 1 }), 'FAIL');
  assert.equal(verdict({ p99: 1 }, { p99: null }), 'FAIL');
  assert.equal(verdict({ p99: 1 }, { p99: NaN }), 'FAIL');
  assert.equal(verdict(summarize([]), summarize([]), 1000), 'FAIL');
});

// The burst rule: hooks sent back to back from the moment the service accepts connections, each run's
// slowest answer kept, the best of the digest-on runs against the best of the digest-off runs. A regression
// (one that holds the loop at start-up) stalls the first hook of EVERY digest-on run, so the minimum keeps
// it and drops a noisy run.
test('burstVerdict: the best digest-on max may be 35 ms over the best digest-off max, no more', () => {
  assert.equal(burstVerdict([2, 4, 3], [30, 40, 35]), 'PASS'); // 30 <= 2 + 35
  assert.equal(burstVerdict([2, 4, 3], [37, 40, 50]), 'PASS'); // exactly on the limit
  assert.equal(burstVerdict([2, 4, 3], [37.5, 40, 50]), 'FAIL');
  assert.equal(burstVerdict([2, 4, 3], [89, 99, 95]), 'FAIL'); // a stall at start-up in every run
  // one noisy digest-on run does not fail it, one noisy digest-off run does not excuse a stall
  assert.equal(burstVerdict([2, 4, 3], [90, 3, 100]), 'PASS');
  assert.equal(burstVerdict([2, 40, 60], [89, 99, 95]), 'FAIL');
  // the limit is the best off max plus the margin
  assert.equal(burstVerdict([20, 30, 40], [50, 60, 70]), 'PASS'); // 50 <= 20 + 35
  assert.equal(burstVerdict([2, 30, 40], [50, 60, 70]), 'FAIL'); // 50 > 2 + 35
  // faster with the digest on is fine
  assert.equal(burstVerdict([10, 10, 10], [1, 1, 1]), 'PASS');
});

test('burstVerdict: the margin is a parameter, single runs work, and the inputs are left alone', () => {
  assert.equal(burstVerdict([5], [40]), 'PASS');
  assert.equal(burstVerdict([5], [40.5]), 'FAIL');
  assert.equal(burstVerdict([2], [12], 10), 'PASS');
  assert.equal(burstVerdict([2], [12.5], 10), 'FAIL');
  assert.equal(burstVerdict([2], [1.5], -1), 'FAIL');
  assert.equal(burstVerdict([2], [0.5], -1), 'PASS');
  const off = [9, 1, 5];
  const on = [20, 8, 30];
  burstVerdict(off, on);
  assert.deepEqual([off, on], [[9, 1, 5], [20, 8, 30]]);
  // no spread of a long array (which fails past about 120 000 elements)
  const long = Array.from({ length: 200_000 }, (_, i) => 100 + i);
  assert.equal(burstVerdict(long, long), 'PASS');
});

test('burstVerdict: a side with nothing to compare, or a value that is not a finite number, is a FAIL, never a PASS', () => {
  assert.equal(burstVerdict([], [1]), 'FAIL');
  assert.equal(burstVerdict([1], []), 'FAIL');
  assert.equal(burstVerdict([], []), 'FAIL');
  assert.equal(burstVerdict([], [], 1e9), 'FAIL');
  for (const bad of [NaN, Infinity, -Infinity, null, undefined, '3', {}]) {
    assert.equal(burstVerdict([bad], [1]), 'FAIL', `off ${String(bad)}`);
    assert.equal(burstVerdict([1], [bad]), 'FAIL', `on ${String(bad)}`);
    assert.equal(burstVerdict([1, bad, 3], [1, 2, 3]), 'FAIL', `a ${String(bad)} among off`);
    assert.equal(burstVerdict([1, 2, 3], [1, bad, 3]), 'FAIL', `a ${String(bad)} among on`);
  }
  for (const notAnArray of [undefined, null, 5, 'abc', {}]) {
    assert.equal(burstVerdict(notAnArray, [1]), 'FAIL');
    assert.equal(burstVerdict([1], notAnArray), 'FAIL');
  }
});

const GOOD_ON = { digest: { sessions: 1, errors: 0 }, catchUpMs: 90, duringCatchUp: 20 };

test('whyInconclusive: empty when every digest-on run caught up and had 20 burst hooks inside it, else why not', () => {
  assert.equal(whyInconclusive([GOOD_ON, GOOD_ON, GOOD_ON]), '');
  assert.equal(whyInconclusive([{ ...GOOD_ON, duringCatchUp: 500 }]), '');
  assert.match(whyInconclusive([GOOD_ON, { ...GOOD_ON, duringCatchUp: 19 }, GOOD_ON]), /only 19 hooks .* at least 20/);
  assert.match(whyInconclusive([{ ...GOOD_ON, duringCatchUp: 0 }]), /only 0 hooks/);
  assert.equal(whyInconclusive([{ ...GOOD_ON, duringCatchUp: 5 }], 5), '', 'the threshold is a parameter');
  assert.match(whyInconclusive([{ ...GOOD_ON, duringCatchUp: 4 }], 5), /only 4 hooks/);
  assert.match(whyInconclusive([]), /no digest-on run/);
  assert.match(whyInconclusive(undefined), /no digest-on run/);
  assert.match(whyInconclusive([GOOD_ON, { ...GOOD_ON, catchUpMs: null }]), /not finished catching up/);
  assert.match(whyInconclusive([{ ...GOOD_ON, catchUpMs: 'soon' }]), /not finished catching up/);
  assert.match(whyInconclusive([{ ...GOOD_ON, catchUpMs: 0 }]), /0 ms/);
  assert.match(whyInconclusive([{ ...GOOD_ON, digest: null }]), /not running/);
  assert.match(whyInconclusive([{ ...GOOD_ON, digest: { sessions: 0, errors: 0 } }]), /not read/);
  assert.match(whyInconclusive([{ ...GOOD_ON, digest: { sessions: 1, errors: 2 } }]), /not read/);
});

test('finalVerdict: FAIL if either rule or anything else failed, else INCONCLUSIVE if the burst was, else PASS; exit codes 1, 2, 0', () => {
  const v = (p99, burst, problems) => finalVerdict({ p99, burst }, problems);
  assert.equal(v('PASS', 'PASS'), 'PASS');
  assert.equal(v('FAIL', 'PASS'), 'FAIL');
  assert.equal(v('PASS', 'FAIL'), 'FAIL');
  assert.equal(v('FAIL', 'FAIL'), 'FAIL');
  assert.equal(v('PASS', 'INCONCLUSIVE'), 'INCONCLUSIVE');
  assert.equal(v('FAIL', 'INCONCLUSIVE'), 'FAIL');
  assert.equal(v('PASS', 'PASS', []), 'PASS');
  assert.equal(v('PASS', 'PASS', ['a hook failed']), 'FAIL');
  assert.equal(v('PASS', 'INCONCLUSIVE', ['the service died']), 'FAIL');
  assert.equal(exitCodeFor('PASS'), 0);
  assert.equal(exitCodeFor('FAIL'), 1);
  assert.equal(exitCodeFor('INCONCLUSIVE'), 2);
});

// ---- the default transcript --------------------------------------------------------------------------

test('largestTranscript is the biggest <projects>/<project>/<name>.jsonl, and null when there is none', () => {
  const dir = path.join(TMP, 'projects');
  const put = (rel, size) => {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, Buffer.alloc(size));
    return f;
  };
  assert.equal(largestTranscript(dir), null, 'no folder');
  fs.mkdirSync(dir);
  assert.equal(largestTranscript(dir), null, 'an empty folder');

  put('a/small.jsonl', 10);
  const big = put('b/big.jsonl', 5000);
  put('b/notes.txt', 90_000); // not a transcript
  put('c/d/deep.jsonl', 90_000); // a subagent's transcript, deeper than the digest reads
  put('top.jsonl', 90_000); // not inside a project folder
  fs.mkdirSync(path.join(dir, 'a', 'folder.jsonl')); // a folder, not a file
  assert.equal(largestTranscript(dir), big);

  // equal sizes: the first path in name order, so the answer does not depend on the directory's order
  put('a/tie.jsonl', 5000);
  assert.equal(largestTranscript(dir), path.join(dir, 'a', 'tie.jsonl'));
  assert.equal(largestTranscript(path.join(dir, 'a', 'small.jsonl')), null, 'a file where a folder was expected');
});

// ---- the options -------------------------------------------------------------------------------------

test('parseArgs: the defaults, each option, and a usage error for anything else', () => {
  assert.deepEqual(parseArgs([]), { transcript: null, syntheticMb: null, seconds: 30, rate: 20, margin: 10, burstMs: 1000, burstMargin: 35, help: false });
  assert.deepEqual(parseArgs(['--transcript', '/some/file.jsonl', '--seconds', '5', '--rate', '12.5', '--margin', '3', '--burst-ms', '250', '--burst-margin', '-2']),
    { transcript: '/some/file.jsonl', syntheticMb: null, seconds: 5, rate: 12.5, margin: 3, burstMs: 250, burstMargin: -2, help: false });
  assert.deepEqual(parseArgs(['--synthetic-mb', '50']).syntheticMb, 50);
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
  assert.equal(parseArgs(['--margin', '-5']).margin, -5);

  const bad = (args, pattern) => assert.throws(() => parseArgs(args), pattern, args.join(' '));
  bad(['--nope'], /unknown option/);
  bad(['stray'], /unknown option/);
  bad(['--seconds'], /needs a value/);
  bad(['--seconds', '0'], /--seconds/);
  bad(['--seconds', 'abc'], /--seconds/);
  bad(['--seconds', '99999'], /--seconds/);
  bad(['--rate', '-1'], /--rate/);
  bad(['--rate', '5000'], /--rate/);
  bad(['--margin', 'x'], /--margin/);
  bad(['--burst-ms', '0'], /--burst-ms/);
  bad(['--burst-ms', '70000'], /--burst-ms/);
  bad(['--burst-ms', 'long'], /--burst-ms/);
  bad(['--burst-margin', 'x'], /--burst-margin/);
  bad(['--burst-margin'], /needs a value/);
  bad(['--synthetic-mb', '0'], /--synthetic-mb/);
  bad(['--synthetic-mb', '501'], /--synthetic-mb/);
  bad(['--transcript'], /needs a value/);
  bad(['--transcript', '/x', '--synthetic-mb', '5'], /not both/);
});

// ---- the synthetic transcript ------------------------------------------------------------------------

test('the synthetic transcript is shaped like a real one, in the size asked for, the same every time', () => {
  const file = path.join(TMP, 'synthetic.jsonl');
  const info = writeSyntheticTranscript(file, 9, { nowMs: NOW });
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(fs.statSync(file).size, info.bytes);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(info.bytes >= 9 * MB && info.bytes < 9 * MB + 3 * MB, `${info.bytes} bytes`);
  assert.ok(text.endsWith('}\n'));

  const lines = text.slice(0, -1).split('\n');
  const records = lines.map((l) => JSON.parse(l)); // every line is a JSON object
  assert.equal(records.length, info.lines);
  assert.ok(records.every((r) => r && typeof r === 'object' && !Array.isArray(r)));

  const prompts = records.filter((r) => r.type === 'user' && r.origin && r.origin.kind === 'human');
  const replies = records.filter((r) => r.type === 'assistant' && r.message.stop_reason === 'end_turn');
  const stops = records.filter((r) => r.type === 'system' && r.subtype === 'stop_hook_summary');
  assert.ok(prompts.length >= 2, 'a few turns');
  assert.ok(lines.length / prompts.length < 45, 'a prompt about every 40th line');
  assert.deepEqual([replies.length, stops.length], [prompts.length, prompts.length]);
  assert.equal(info.turns, prompts.length);
  assert.deepEqual(records.at(-1), stops.at(-1), 'ends on a closed turn');
  assert.equal(typeof prompts[0].message.content, 'string');

  const results = records.filter((r) => r.toolUseResult && typeof r.toolUseResult.stdout === 'string');
  assert.ok(results.length > 20);
  for (const r of results) {
    const n = r.toolUseResult.stdout.length;
    assert.ok(n >= 20_000 && n <= 200_000, `stdout of ${n} characters`);
  }
  const uses = records.filter((r) => r.type === 'assistant' && r.message.content[0].type === 'tool_use');
  assert.equal(uses.length, results.length);
  assert.ok(uses.every((r) => r.message.content[0].name === 'Bash'));
  assert.ok(uses.some((r) => r.message.content[0].input.command === 'npm test'), 'some test runs');

  // one 2 MB attachment per 8 MB asked for, three at the most
  const attachments = records.filter((r) => r.type === 'attachment');
  assert.equal(attachments.length, 1);
  assert.equal(info.attachments, 1);
  assert.equal(attachments[0].attachment.content.length, 2 * MB);

  // timestamps never go back, and sit inside the last day
  const times = records.map((r) => Date.parse(r.timestamp));
  assert.ok(times.every((t, i) => Number.isFinite(t) && t <= NOW && t >= NOW - 24 * 3600e3 && (i === 0 || t >= times[i - 1])));

  // the same bytes every time, and an existing file is never written over
  const again = path.join(TMP, 'synthetic-again.jsonl');
  writeSyntheticTranscript(again, 9, { nowMs: NOW });
  const sum = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  assert.equal(sum(again), sum(file));
  assert.throws(() => writeSyntheticTranscript(file, 1, { nowMs: NOW }), { code: 'EEXIST' });
  assert.equal(sum(file), sum(again));
});

test('the synthetic transcript: three attachments from 24 MB up, none under 8 MB, and a size that cannot be made is refused', () => {
  const f = path.join(TMP, 'syn-small.jsonl');
  const small = writeSyntheticTranscript(f, 1, { nowMs: NOW });
  assert.equal(small.attachments, 0);
  assert.ok(small.bytes >= 1 * MB);
  for (const [mb, attachments] of [[7.9, 0], [8, 1], [16, 2], [24, 3]]) {
    const sized = writeSyntheticTranscript(path.join(TMP, `syn-${mb}.jsonl`), mb, { nowMs: NOW });
    assert.equal(sized.attachments, attachments, `${mb} MB`);
    assert.ok(sized.bytes >= mb * MB, `${mb} MB`);
  }
  for (const bad of [0, -1, NaN, Infinity, 'x']) {
    assert.throws(() => writeSyntheticTranscript(path.join(TMP, 'never.jsonl'), bad, { nowMs: NOW }), /megabytes/);
  }
  assert.equal(fs.existsSync(path.join(TMP, 'never.jsonl')), false);
});

// ---- the service's environment -----------------------------------------------------------------------

test('serviceEnv: everything the service touches is inside its temp dir, on loopback, on a port that is not the owner\'s', () => {
  const dir = path.join(TMP, 'env');
  const env = serviceEnv({ dir, port: 51234, digest: true });
  assert.deepEqual(Object.keys(env).sort(), [
    'CLAUDE_CONFIG_DIR', 'CLAUDE_PANEL_BIND', 'CLAUDE_PANEL_CONFIG_DIR', 'CLAUDE_PANEL_DIGEST', 'CLAUDE_THING_LOG_DIR',
    'CLAUDE_THING_PID_FILE', 'CLAUDE_THING_PORT', 'CLAUDE_THING_STATE_DIR', 'HOME', 'PATH', 'TMPDIR',
  ]);
  assert.equal(env.CLAUDE_PANEL_BIND, '127.0.0.1');
  assert.equal(env.CLAUDE_THING_PORT, '51234');
  assert.equal(env.CLAUDE_PANEL_DIGEST, '1');
  assert.equal(serviceEnv({ dir, port: 51234, digest: false }).CLAUDE_PANEL_DIGEST, '0');
  for (const key of ['HOME', 'TMPDIR', 'PATH', 'CLAUDE_CONFIG_DIR', 'CLAUDE_PANEL_CONFIG_DIR', 'CLAUDE_THING_PID_FILE',
    'CLAUDE_THING_STATE_DIR', 'CLAUDE_THING_LOG_DIR']) {
    assert.ok(env[key].startsWith(dir + path.sep), `${key} is ${env[key]}`);
  }
  assert.equal(env.PATH, path.join(dir, 'bin'), 'a PATH with nothing on it: no claude, ps, swiftc or osascript to run');
  for (const port of [8790, 8091, 0, -3, 70000, 1.5, '80', NaN]) {
    assert.throws(() => serviceEnv({ dir, port, digest: true }), /port/, String(port));
  }
});

// ---- the script, end to end --------------------------------------------------------------------------

// Starts the script with its own temp area, and a HOME, TMPDIR and CLAUDE_CONFIG_DIR that are empty folders
// inside it, so a mistake in the script could not reach the owner's files. `result` resolves
// { code, signal, stdout, stderr } when it exits; tmp is what the script found as the OS temp dir.
function startScript(args, { detached = false } = {}) {
  const area = fs.mkdtempSync(path.join(TMP, 'run-'));
  const tmp = path.join(area, 'tmp');
  const home = path.join(area, 'home');
  fs.mkdirSync(tmp);
  fs.mkdirSync(home);
  const child = spawn(process.execPath, [SCRIPT, ...args], {
    env: { PATH: '', HOME: home, TMPDIR: tmp, CLAUDE_CONFIG_DIR: path.join(home, 'claude') },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached, // its own process group, so a signal to the group (a closed terminal's) reaches nothing of ours
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });
  const result = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, result, tmp, home };
}

const runScript = async (args) => {
  const run = startScript(args);
  return { ...(await run.result), tmp: run.tmp, home: run.home };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Polls until check() returns something other than undefined. The limit only matters when the thing never happens.
async function until(what, check, limitMs = 30_000) {
  const end = Date.now() + limitMs;
  for (;;) {
    const found = await check();
    if (found !== undefined) return found;
    if (Date.now() > end) throw new Error(`gave up waiting for ${what}`);
    await sleep(25);
  }
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

test('--help prints the usage and starts nothing', async () => {
  const r = await runScript(['--help']);
  assert.equal(r.code, 0);
  for (const word of ['--transcript', '--seconds', '--rate', '--synthetic-mb', '--margin', '--burst-ms', '--burst-margin', 'PASS', 'FAIL', 'INCONCLUSIVE']) {
    assert.ok(r.stdout.includes(word), `the usage names ${word}`);
  }
  assert.deepEqual(fs.readdirSync(r.tmp), []);
});

test('a usage error exits 2 with a message and starts nothing', async () => {
  for (const args of [['--bogus'], ['--seconds', '0'], ['--transcript', path.join(TMP, 'no-such-file.jsonl')],
    ['--transcript', TMP], ['--transcript', 'x', '--synthetic-mb', '3']]) {
    const r = await runScript(args);
    assert.equal(r.code, 2, args.join(' '));
    assert.equal(r.stdout, '');
    assert.ok(r.stderr.includes('hook-latency'), r.stderr);
    assert.deepEqual(fs.readdirSync(r.tmp), [], 'no temp dir left behind');
  }
});

// A transcript that is three lines long: the digest catches up on it in a millisecond or two, so far fewer
// than 20 hooks of a burst can fall inside the catch-up.
const SENTINEL = 'SENTINEL-' + 'prompt-text-that-must-stay-private';
function writeTinyTranscript(name) {
  const file = path.join(TMP, name);
  const stamp = new Date(Date.now() - 120_000).toISOString();
  fs.writeFileSync(file, [
    { type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: SENTINEL }, timestamp: stamp, cwd: '/Users/dev/proj' },
    { type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: SENTINEL }] }, timestamp: stamp },
    { type: 'system', subtype: 'stop_hook_summary', timestamp: stamp },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
  return file;
}

const JSON_KEYS = ['off', 'on', 'burst', 'verdicts', 'verdict', 'transcriptBytes'];

test('six real runs of the service, off and on alternating: one JSON line, a PASS, the digest caught up, nothing left behind', { timeout: 180_000 }, async () => {
  // --margin and --burst-margin make both verdicts independent of how busy this machine is; what is tested is
  // the plumbing. 30 MB is a catch-up long enough for a burst of hooks to overlap it by 20 hooks.
  const r = await runScript(['--synthetic-mb', '30', '--seconds', '3', '--rate', '10', '--burst-ms', '400',
    '--margin', '100000', '--burst-margin', '100000']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.split('\n').filter(Boolean).length, 1, 'one line');
  assert.ok(r.stdout.endsWith('\n'));
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out), JSON_KEYS);
  assert.equal(out.verdict, 'PASS');
  assert.deepEqual(out.verdicts, { p99: 'PASS', burst: 'PASS' });
  assert.deepEqual(Object.keys(out.off), ['p50', 'p99', 'max', 'n', 'failed']);
  assert.deepEqual(Object.keys(out.on), ['p50', 'p99', 'max', 'n', 'failed', 'catchUpMs']);
  for (const side of [out.off, out.on]) {
    assert.equal(side.failed, 0);
    assert.equal(side.n, 30, '3 s at 10 a second, over the side\'s three runs');
    assert.ok(side.p50 > 0 && side.p50 <= side.p99 && side.p99 <= side.max);
  }
  assert.ok(out.on.catchUpMs > 0, `catchUpMs ${out.on.catchUpMs}`);
  assert.deepEqual(Object.keys(out.burst), ['off', 'on', 'duringCatchUp']);
  for (const key of ['off', 'on', 'duringCatchUp']) assert.equal(out.burst[key].length, 3, `three ${key} runs`);
  for (const m of [...out.burst.off, ...out.burst.on]) assert.ok(Number.isFinite(m) && m > 0, `a burst max of ${m}`);
  for (const n of out.burst.duringCatchUp) assert.ok(Number.isInteger(n) && n >= 20, `${n} burst hooks inside the catch-up`);
  assert.ok(out.transcriptBytes >= 30 * MB);
  assert.deepEqual(fs.readdirSync(r.tmp), [], 'the temp dir the script made is gone');
  assert.deepEqual(fs.readdirSync(r.home), [], 'nothing was written to HOME');
});

test('a FAIL exits 1 with the same one line, and no transcript text is ever printed', { timeout: 120_000 }, async () => {
  const file = writeTinyTranscript('sentinel-fail.jsonl');
  // a margin below zero cannot be met: the digest-on p99 would have to beat the digest-off one by 100 s
  const r = await runScript(['--transcript', file, '--seconds', '1.5', '--rate', '10', '--burst-ms', '200', '--margin', '-100000',
    '--burst-margin', '100000']);
  assert.equal(r.code, 1, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out), JSON_KEYS);
  assert.equal(out.verdict, 'FAIL');
  assert.equal(out.verdicts.p99, 'FAIL');
  assert.equal((r.stdout + r.stderr).includes(SENTINEL), false);
  assert.equal((r.stdout + r.stderr).includes('SENTINEL'), false);
  assert.deepEqual(fs.readdirSync(r.tmp), []);
  assert.ok(fs.existsSync(file), 'the transcript given is only copied, never moved or removed');
  assert.equal(fs.readFileSync(file, 'utf8').includes(SENTINEL), true);
});

test('a catch-up too short for 20 burst hooks to overlap it is INCONCLUSIVE: the JSON line, exit 2, and why', { timeout: 120_000 }, async () => {
  const file = writeTinyTranscript('sentinel-inconclusive.jsonl');
  const r = await runScript(['--transcript', file, '--seconds', '1.5', '--rate', '10', '--burst-ms', '200', '--margin', '100000',
    '--burst-margin', '100000']);
  assert.equal(r.code, 2, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out), JSON_KEYS);
  assert.equal(out.verdict, 'INCONCLUSIVE');
  assert.deepEqual(out.verdicts, { p99: 'PASS', burst: 'INCONCLUSIVE' });
  assert.equal(out.burst.duringCatchUp.length, 3);
  assert.ok(out.burst.duringCatchUp.every((n) => n < 20), JSON.stringify(out.burst.duringCatchUp));
  assert.match(r.stderr, /INCONCLUSIVE: only \d+ hooks of the burst fell inside the catch-up/);
  assert.equal((r.stdout + r.stderr).includes('SENTINEL'), false);
  assert.deepEqual(fs.readdirSync(r.tmp), []);
});

// ---- clean-up when the run goes wrong ----------------------------------------------------------------

// main() in this process, with a service that is a script of ours, and the OS temp dir (which the script
// makes its folder in) an empty folder of ours. Resolves { code, out, err, left } where left is what is in
// that folder afterwards.
async function mainWith(serviceSource, args, options = {}) {
  const area = fs.mkdtempSync(path.join(TMP, 'main-'));
  const service = path.join(area, 'fake-service.js');
  fs.writeFileSync(service, serviceSource);
  const tmp = path.join(area, 'tmp');
  fs.mkdirSync(tmp);
  const before = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  let out = '';
  let err = '';
  try {
    const code = await main(args, { service, out: { write: (c) => { out += c; } }, err: { write: (c) => { err += c; } }, ...options });
    return { code, out, err, left: fs.readdirSync(tmp) };
  } finally {
    if (before === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = before;
  }
}

test('a service that exits at start-up: the message says so, exit 2, no JSON, nothing left behind', async () => {
  const r = await mainWith("console.log('this is the fake service speaking'); process.exit(3);", ['--synthetic-mb', '1', '--seconds', '1']);
  assert.equal(r.code, 2);
  assert.equal(r.out, '');
  assert.match(r.err, /the service exited at start-up/);
  assert.match(r.err, /this is the fake service speaking/);
  assert.deepEqual(r.left, []);
});

test('a service that never listens: it is killed, the message says so, nothing left behind', async () => {
  const r = await mainWith("console.log('pid ' + process.pid); setInterval(() => {}, 1000);", ['--synthetic-mb', '1', '--seconds', '1'],
    { startLimitMs: 400 });
  assert.equal(r.code, 2);
  assert.equal(r.out, '');
  assert.match(r.err, /the service did not listen/);
  const pid = Number(/pid (\d+)/.exec(r.err)[1]);
  assert.ok(pid > 0 && pid !== process.pid);
  await until('the fake service to be gone', () => (alive(pid) ? undefined : true), 10_000);
  assert.deepEqual(r.left, []);
});

// Interrupted in the middle of a run: whatever ends the script, the service goes and the temp folder (which
// holds copies of the transcript) goes. SIGHUP is what a closed terminal sends, to the whole process group,
// the service included, which dies of it by default: the script's own clean-up still has to run.
for (const [signal, toGroup, code] of [['SIGINT', false, 130], ['SIGTERM', false, 143], ['SIGHUP', true, 129]]) {
  test(`${signal}${toGroup ? ' to the whole process group' : ''} in the middle of a run: the service is killed, the temp dir removed, exit ${code}`, { timeout: 120_000 }, async () => {
    const run = startScript(['--synthetic-mb', '2', '--seconds', '60', '--rate', '10'], { detached: toGroup });
    try {
      // the first digest-off service writes its pid file (in the script's temp dir) once it is up
      const pid = await until('the first service to be up', () => {
        const [root] = fs.readdirSync(run.tmp).filter((n) => n.startsWith('claude-thing-latency-'));
        if (!root) return undefined;
        try { return Number(fs.readFileSync(path.join(run.tmp, root, 'off-1', 'daemon.pid'), 'utf8')); } catch { return undefined; }
      });
      assert.ok(pid > 0 && alive(pid));
      if (toGroup) process.kill(-run.child.pid, signal); else run.child.kill(signal);
      const r = await run.result;
      assert.deepEqual([r.code, r.signal], [code, null]);
      assert.equal(r.stdout, '');
      await until('the service to be gone', () => (alive(pid) ? undefined : true), 10_000);
      assert.deepEqual(fs.readdirSync(run.tmp), []);
    } finally {
      if (run.child.exitCode === null && run.child.signalCode === null) {
        if (toGroup) { try { process.kill(-run.child.pid, 'SIGKILL'); } catch { /* gone */ } } else run.child.kill('SIGKILL');
      }
    }
  });
}

// ---- the burst rule and what follows a run, against a stand-in service ---------------------------------------

// A stand-in for the service: answers /hook and /status on CLAUDE_THING_PORT, as the real one's /status does.
//   stallMs: with the digest on, holds its loop that long as soon as the first connection reaches it (the
//     script's probe, which the script then follows with its first hook), as a reader that parses a whole
//     transcript in one go would right after the service starts listening; the hook waits it out;
//   catchUpMs: what /status reports; dieAfter: with the digest on, exits after that many hooks;
//   hangAfter: with the digest on, stops answering hooks (its /status still answers) after that many;
//   hookDelayMs: answers each hook that much later (without holding its loop), so a burst of hooks back to back
//   cannot fit 20 of them inside a short catch-up however fast the machine is.
function fakeService({ stallMs = 0, catchUpMs = 300, dieAfter = 0, hangAfter = 0, hookDelayMs = 0 } = {}) {
  return `
const http = require('node:http');
const digestOn = process.env.CLAUDE_PANEL_DIGEST === '1';
let hooks = 0;
const server = http.createServer((req, res) => {
  if (req.url === '/status') {
    res.end(JSON.stringify({ digest: digestOn ? { sessions: 1, cards: 1, skipped: 0, queued: 0, catchUpMs: ${catchUpMs}, errors: 0 } : null }));
    return;
  }
  req.resume();
  req.on('end', () => {
    hooks++;
    if (digestOn && ${dieAfter} && hooks > ${dieAfter}) { console.log('the fake service is dying now'); process.exit(7); }
    if (digestOn && ${hangAfter} && hooks > ${hangAfter}) { console.log('the fake service has stopped answering'); return; }
    if (${hookDelayMs}) setTimeout(() => res.end('{}'), ${hookDelayMs}); else res.end('{}');
  });
});
server.once('connection', () => {
  if (digestOn && ${stallMs}) { const end = Date.now() + ${stallMs}; while (Date.now() < end); }
});
server.listen(Number(process.env.CLAUDE_THING_PORT), '127.0.0.1');
`;
}

const FAKE_ARGS = ['--synthetic-mb', '1', '--seconds', '1.5', '--rate', '10', '--burst-ms', '600'];

test('a service that holds its loop at start-up fails the burst rule, though too few hooks overlapped the catch-up to be sure', { timeout: 120_000 }, async () => {
  // every digest-on run stalls its first hook for 600 ms; every digest-off run does not. The default margins.
  // The service reports a 1 ms catch-up, as the real stalled one reports about as long as the stall but with only
  // a few hooks in it: here the one hook that waited, whatever the machine is doing.
  const r = await mainWith(fakeService({ stallMs: 600, catchUpMs: 1 }), FAKE_ARGS);
  assert.equal(r.code, 1, r.err);
  const out = JSON.parse(r.out);
  assert.equal(out.verdict, 'FAIL');
  assert.equal(out.verdicts.burst, 'FAIL', 'the burst rule');
  assert.equal(out.burst.off.length, 3);
  assert.equal(out.burst.on.length, 3);
  for (const m of out.burst.on) assert.ok(m >= 250, `a digest-on burst max of ${m} ms`); // 600 ms held, less the lead the first hook took to be sent
  assert.ok(Math.min(...out.burst.off) < 200, `a digest-off burst max of ${Math.min(...out.burst.off)} ms`);
  // the stall is one hook held up, so almost none fell inside the catch-up window: INCONCLUSIVE on its own, but a FAIL outranks it
  assert.ok(out.burst.duringCatchUp.every((n) => n < 20), JSON.stringify(out.burst.duringCatchUp));
  assert.match(r.err, /FAIL: .*burst/);
  assert.deepEqual(r.left, []);
});

test('a service that does not hold its loop passes both rules with 20 or more burst hooks inside the catch-up', { timeout: 120_000 }, async () => {
  const r = await mainWith(fakeService({ catchUpMs: 300 }), [...FAKE_ARGS, '--margin', '100000', '--burst-margin', '100000']);
  assert.equal(r.code, 0, r.err);
  const out = JSON.parse(r.out);
  assert.deepEqual(out.verdicts, { p99: 'PASS', burst: 'PASS' });
  assert.equal(out.verdict, 'PASS');
  assert.ok(out.burst.duringCatchUp.every((n) => n >= 20), JSON.stringify(out.burst.duringCatchUp));
  assert.equal(out.on.catchUpMs, 300);
  assert.equal(r.err, '');
  assert.deepEqual(r.left, []);
});

test('a catch-up the digest reports as 2 ms is INCONCLUSIVE, and one that never finishes is too', { timeout: 120_000 }, async () => {
  // each hook is answered 3 ms after it is sent, so at most one can fall inside a catch-up of 2 ms
  const quick = await mainWith(fakeService({ catchUpMs: 2, hookDelayMs: 3 }), [...FAKE_ARGS, '--margin', '100000', '--burst-margin', '100000']);
  assert.equal(quick.code, 2, quick.err);
  assert.equal(JSON.parse(quick.out).verdict, 'INCONCLUSIVE');
  assert.match(quick.err, /only \d+ hooks of the burst fell inside the catch-up \(2 ms\)/);

  const never = await mainWith(fakeService({ catchUpMs: null }), [...FAKE_ARGS, '--margin', '100000', '--burst-margin', '100000'],
    { settleMs: 300 });
  assert.equal(never.code, 2, never.err);
  assert.equal(JSON.parse(never.out).verdict, 'INCONCLUSIVE');
  assert.equal(JSON.parse(never.out).on.catchUpMs, null);
  assert.match(never.err, /not finished catching up/);
  assert.deepEqual([quick.left, never.left], [[], []]);
});

test('a digest-on service that dies mid-run is a FAIL with the JSON line and the tail of its output, not an unmakeable run', { timeout: 120_000 }, async () => {
  const r = await mainWith(fakeService({ catchUpMs: 300, dieAfter: 25 }), [...FAKE_ARGS, '--margin', '100000', '--burst-margin', '100000']);
  assert.equal(r.code, 1, r.err);
  const out = JSON.parse(r.out);
  assert.equal(out.verdict, 'FAIL');
  assert.ok(out.on.failed >= 1, `on.failed ${out.on.failed}`);
  assert.equal(out.off.failed, 0);
  // the run stopped there: one digest-off run and the digest-on run that died
  assert.deepEqual([out.burst.off.length, out.burst.on.length], [1, 1]);
  assert.match(r.err, /died/);
  assert.match(r.err, /the fake service is dying now/);
  assert.deepEqual(r.left, []);
});

test('a digest-on service that stops answering mid-run is a FAIL too, with the tail of its output', { timeout: 120_000 }, async () => {
  const r = await mainWith(fakeService({ catchUpMs: 300, hangAfter: 25 }), [...FAKE_ARGS, '--margin', '100000', '--burst-margin', '100000'],
    { hookTimeoutMs: 300 });
  assert.equal(r.code, 1, r.err);
  const out = JSON.parse(r.out);
  assert.equal(out.verdict, 'FAIL');
  assert.ok(out.on.failed >= 1, `on.failed ${out.on.failed}`);
  assert.ok(out.burst.on[0] >= 250, `the hook that got no answer took ${out.burst.on[0]} ms`);
  assert.deepEqual([out.burst.off.length, out.burst.on.length], [1, 1]);
  assert.match(r.err, /hook\(s\) failed or got no answer in 0\.3 s in the on-1 run/);
  assert.match(r.err, /the fake service has stopped answering/);
  assert.doesNotMatch(r.err, /died/);
  assert.deepEqual(r.left, []);
});
