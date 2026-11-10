#!/usr/bin/env node
// Do the agent digest's transcript reads slow down Claude Code's hooks? The digest runs in the same Node
// process that answers every hook (PreToolUse fires on each tool call, and a hook times out after 5 s), and
// at start-up it catches up on the last day's transcripts, tens of MB of them. This starts the real service
// (src/index.js) six times, three with the digest off (CLAUDE_PANEL_DIGEST=0) and three with it on and
// catching up on a big transcript, alternating off, on, off, on, off, on (each a fresh start, which is what
// starts a catch-up), and asks two questions of the hook response times.
//
//   node scripts/hook-latency.js [--transcript <file>] [--seconds 30] [--rate 20] [--burst-ms 1000]
//   npm --prefix mac-service run hook-latency -- --seconds 20
//
// 1. The burst rule, which can see a stall. From the moment a run's service accepts connections, hooks are
//    sent back to back, one in flight at a time, over one reused connection (a connection per hook is thousands
//    a second, and a few copies of this running at once use up every ephemeral port), for --burst-ms (1000).
//    The catch-up begins as the service starts listening, so the burst is what overlaps it, and a catch-up that
//    holds the event loop (parses a whole transcript in one go) holds one of those hooks for as long as it
//    runs. The run's burst max is its slowest hook. Rule: the best of the three digest-on maxes may be at most
//    --burst-margin (35) ms above the best of the three digest-off maxes. A regression stalls every digest-on
//    run, as the catch-up always happens at start, so the best of three keeps it and drops a noisy run. The p99
//    of a burst is no use here (0.2 ms either way, or a stall hidden among thousands of hooks), so the max is
//    judged.
// 2. The realistic-rate p99 rule, the check as first specified. After its burst each run sends hooks on a fixed
//    schedule, --rate (20) a second, new connection each, as a hook command makes them; --seconds (30) is
//    each side's total, a third per run. Rule: the digest-on p99 over those hooks may be at most --margin
//    (10) ms above the digest-off p99. This only sees a slowdown that lasts: a stall of a few hundred ms is
//    a handful of hooks, which the p99 of hundreds ignores, which is why the burst rule exists.
// Times are milliseconds from sending a hook to reading its whole response. p50/p99 are nearest-rank percentiles.
//
// Prints ONE line of JSON:
//   { off: {p50,p99,max,n,failed}, on: {p50,p99,max,n,failed,catchUpMs},
//     burst: {off: [max per run], on: [max per run], duringCatchUp: [hooks inside the catch-up, per on run]},
//     verdicts: {p99, burst}, verdict, transcriptBytes }
// off and on are the p99 rule's hooks pooled over a side's runs; on.catchUpMs is the service's own number from
// /status, the median of the three runs; duringCatchUp counts burst hooks sent less than catchUpMs after the
// service first accepted a connection. And exits:
//   0 PASS         both rules pass and every digest-on run overlapped the catch-up with 20 or more hooks;
//   1 FAIL         either rule fails, or a hook failed or took 5 s, or a service died or stopped answering
//                  after it had started (the tail of its output, service log lines, goes to stderr). A FAIL
//                  outranks an INCONCLUSIVE: a stall can leave fewer than 20 hooks inside the catch-up;
//   2 INCONCLUSIVE the JSON line is printed, but fewer than 20 burst hooks fell inside some digest-on run's
//                  catch-up, or the catch-up did not finish (within 60 s of the last hook), or the digest read
//                  no session or had errors: the run cannot show the digest did not slow the hooks. It also
//                  exits 2, with no JSON line, for a usage error or a run that could not be made at all (the
//                  service never started).
// The reason for anything but a PASS is on stderr.
//
// The real run against a big transcript is the owner's manual check, and the synthetic ones prove only the
// plumbing: with no --transcript the largest <CLAUDE_CONFIG_DIR or ~/.claude>/projects/<project>/<name>.jsonl
// is used (a 54.8 MB one is the case this was sized for). A catch-up of that size takes the digest on the
// order of 100 to 300 ms, long enough for 20 or more hooks of a burst. Its text is never printed, by this
// script or the service it runs. Nothing else of yours is touched either: the transcript is COPIED (never
// linked, since the copy's modified time is set to now so the digest's catch-up, which reads the last 24 h,
// takes it) into a temp folder.
//
// The service is isolated the way test/service-digest.test.js isolates it: a free port on 127.0.0.1 (never
// 8790, which is the real service's, nor 8091), its own HOME, TMPDIR, CLAUDE_CONFIG_DIR, state, token, pid
// file and log inside a temp folder (mode 0700, removed when the script ends, however it is interrupted:
// Ctrl-C, kill, a closed terminal) and a PATH with nothing on it, so it finds no `claude`, `ps`, `swiftc` or
// `osascript` to run. One difference, and why: it runs with the real session sources, not mock mode, because
// mock mode empties <TMPDIR>/claude-panel-mock (the folder the digest reads there) each time it starts, so no
// transcript could be waiting for the catch-up; with the real sources the digest reads
// <CLAUDE_CONFIG_DIR>/projects, which the script fills. Those sources have nothing to find in an empty HOME
// and an empty PATH, and the hooks posted to them take the path real hooks take.
//
// Run it on a quiet machine: the digest-off runs are the noise floor (their burst max is mostly the first,
// cold hook of a new process, up to about 15 ms here, which is why the burst margin is 35 and not 10).
// test/digest-latency.test.js is the in-process check of the same property.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { writeSyntheticTranscript } from './synthetic-transcript.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVICE = path.resolve(HERE, '..', 'src', 'index.js');
const START_LIMIT_MS = 30_000; // for a service that never listens
// The real service's port and the simulator's: the one thing a stray service here must never take.
const OWNERS_PORTS = [8790, 8091];
const HOOK_TIMEOUT_MS = 5_000; // Claude Code's hook timeout
const SETTLE_LIMIT_MS = 60_000; // how long after the last hook the digest may take to finish its catch-up
const OUTPUT_KEPT = 64 * 1024;
const OUTPUT_SHOWN = 2 * 1024; // of a dead service's output, on stderr
const RUNS_PER_SIDE = 3;
const MIN_OVERLAP = 20; // burst hooks that must fall inside a catch-up for a run to say anything about it
const SIGNAL_CODES = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }; // 128 plus the signal's number

const USAGE = `Usage: node scripts/hook-latency.js [options]

Starts the Mac service six times on a free loopback port, alternating the agent digest off and on (the on
runs catching up on a big transcript), sends hooks to each, and prints one JSON line:
  { "off": {...}, "on": {..., catchUpMs}, "burst": {off, on, duringCatchUp}, "verdicts": {p99, burst}, "verdict", "transcriptBytes" }

Two rules. Burst: from the moment a service accepts connections, hooks go back to back for --burst-ms; the
best digest-on run's slowest hook may be at most --burst-margin ms above the best digest-off run's. p99: at
--rate hooks a second, the digest-on p99 may be at most --margin ms above the digest-off p99.

Exit codes:
  0  PASS          both rules pass, and 20 or more burst hooks overlapped every digest-on catch-up
  1  FAIL          either rule fails, a hook failed, or a service died mid-run (reason on stderr)
  2  INCONCLUSIVE  the JSON line is printed, but the catch-up was too short for 20 burst hooks to overlap it,
                   or did not finish. Also 2, with no JSON line: a usage error, or a service that never started.
The transcript's text is never printed. A real run against your own largest transcript is the check.

Options:
  --transcript <file>    the transcript to catch up on; copied, never changed. Default: the largest
                         <CLAUDE_CONFIG_DIR or ~/.claude>/projects/<project>/<name>.jsonl
  --synthetic-mb <n>     build a synthetic transcript of about n MB (up to 500) and use it instead
  --seconds <n>          how long to send hooks at --rate to each side in all, a third per run (default 30)
  --rate <n>             hooks per second for the p99 rule (default 20, up to 1000)
  --margin <ms>          how far above the digest-off p99 the digest-on p99 may be (default 10)
  --burst-ms <n>         how long each run's burst lasts (default 1000, up to 60000)
  --burst-margin <ms>    how far above the best digest-off burst max the best digest-on one may be (default 35)
  -h, --help             this text
`;

// ---- the pure parts ----------------------------------------------------------------------------------

const hundredths = (v) => Math.round(v * 100) / 100;

// Nearest-rank percentiles of milliseconds: the p-th is the sorted value at rank ceil(p/100 * n).
export function summarize(ms) {
  const n = ms.length;
  if (n === 0) return { p50: null, p99: null, max: null, n: 0 };
  const sorted = Float64Array.from(ms).sort();
  const at = (p) => hundredths(sorted[Math.min(n, Math.max(1, Math.ceil((p * n) / 100))) - 1]);
  return { p50: at(50), p99: at(99), max: hundredths(sorted[n - 1]), n };
}

// The digest-on p99 may be at most marginMs above the digest-off p99. A p99 that is not a number (a run
// that got no answers) is not a pass.
export function verdict(off, on, marginMs = 10) {
  const a = off && off.p99;
  const b = on && on.p99;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 'FAIL';
  return b <= a + marginMs ? 'PASS' : 'FAIL';
}

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const everyFinite = (values) => Array.isArray(values) && values.length > 0 && values.every(isFiniteNumber);
// Loops, not Math.min(...values): a spread of a long array overflows the stack.
const smallest = (values) => {
  let least = Infinity;
  for (const v of values) if (v < least) least = v;
  return least;
};
const largest = (values) => {
  let most = -Infinity;
  for (const v of values) if (v > most) most = v;
  return most;
};

// The burst rule: the best (smallest) digest-on burst max may be at most marginMs above the best digest-off
// one. The minimum, not the mean or the median: a regression that holds the event loop does it in every
// digest-on run (the catch-up always happens at start), so the best run still shows it, and one run's noise
// does not fail the check. A side with no runs, or any value that is not a finite number (NaN, Infinity, null,
// a string), cannot show anything, so the answer is FAIL: nothing here may turn missing data into a PASS.
export function burstVerdict(offMaxes, onMaxes, marginMs = 35) {
  if (!everyFinite(offMaxes) || !everyFinite(onMaxes) || !isFiniteNumber(marginMs)) return 'FAIL';
  return smallest(onMaxes) <= smallest(offMaxes) + marginMs ? 'PASS' : 'FAIL';
}

// Why the digest-on runs (each { digest: its /status digest or null, catchUpMs, duringCatchUp }) cannot show
// the digest left the hooks alone, or '' when they can: every one had the digest running, finished catching
// up, read a session without an error, and had at least minOverlap burst hooks inside the catch-up.
export function whyInconclusive(onRuns, minOverlap = MIN_OVERLAP) {
  if (!Array.isArray(onRuns) || onRuns.length === 0) return 'no digest-on run finished';
  for (const run of onRuns) {
    if (!run.digest) return 'the digest was not running in a digest-on run (is this Windows?)';
    if (!isFiniteNumber(run.catchUpMs)) return 'the digest had not finished catching up after the last hook';
    if (!(run.catchUpMs > 0)) return 'the digest caught up in 0 ms: the transcript was not read';
    if (!(run.digest.sessions >= 1) || run.digest.errors !== 0) {
      return `the digest read ${run.digest.sessions} session(s) with ${run.digest.errors} error(s): the transcript was not read cleanly`;
    }
    if (!(run.duringCatchUp >= minOverlap)) {
      return `only ${run.duringCatchUp} hooks of the burst fell inside the catch-up (${run.catchUpMs} ms); at least ${minOverlap} are needed`;
    }
  }
  return '';
}

// The two rules' verdicts ({ p99: 'PASS'|'FAIL', burst: 'PASS'|'FAIL'|'INCONCLUSIVE' }) and the problems
// found otherwise (a hook failed, a service died: strings) -> the final verdict. FAIL outranks INCONCLUSIVE.
export function finalVerdict({ p99, burst }, problems = []) {
  if (problems.length > 0 || p99 === 'FAIL' || burst === 'FAIL') return 'FAIL';
  return burst === 'INCONCLUSIVE' ? 'INCONCLUSIVE' : 'PASS';
}

export const exitCodeFor = (finalVerdictName) => (finalVerdictName === 'PASS' ? 0 : finalVerdictName === 'FAIL' ? 1 : 2);

// The biggest <projectsDir>/<project>/<name>.jsonl by size (what the digest reads: not a subagent's, deeper
// down), the first in name order among equals, or null when there is none. It only stats; it never reads one.
export function largestTranscript(projectsDir) {
  let projects;
  try {
    projects = fs.readdirSync(projectsDir).sort();
  } catch {
    return null;
  }
  let best = null;
  for (const project of projects) {
    let names;
    try {
      names = fs.readdirSync(path.join(projectsDir, project)).sort();
    } catch {
      continue; // a file, or unreadable
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl') || name.length <= '.jsonl'.length) continue;
      const file = path.join(projectsDir, project, name);
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (st.isFile() && (best === null || st.size > best.size)) best = { file, size: st.size };
    }
  }
  return best && best.file;
}

class UsageError extends Error {}

const NUMBER_OPTIONS = {
  '--seconds': { key: 'seconds', ok: (v) => v > 0 && v <= 3600, needs: 'above 0 and at most 3600' },
  '--rate': { key: 'rate', ok: (v) => v > 0 && v <= 1000, needs: 'above 0 and at most 1000' },
  '--margin': { key: 'margin', ok: () => true, needs: 'a number' },
  '--burst-ms': { key: 'burstMs', ok: (v) => v > 0 && v <= 60_000, needs: 'above 0 and at most 60000' },
  '--burst-margin': { key: 'burstMargin', ok: () => true, needs: 'a number' },
  '--synthetic-mb': { key: 'syntheticMb', ok: (v) => v > 0 && v <= 500, needs: 'above 0 and at most 500' },
};

// argv without the node and script paths -> { transcript, syntheticMb, seconds, rate, margin, burstMs,
// burstMargin, help }.
// Throws UsageError for anything it does not understand.
export function parseArgs(argv) {
  const opts = { transcript: null, syntheticMb: null, seconds: 30, rate: 20, margin: 10, burstMs: 1000, burstMargin: 35, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
      continue;
    }
    if (arg !== '--transcript' && !NUMBER_OPTIONS[arg]) throw new UsageError(`unknown option ${arg}`);
    const raw = argv[i + 1];
    if (raw === undefined || raw.startsWith('--')) throw new UsageError(`${arg} needs a value`);
    i++;
    if (arg === '--transcript') {
      opts.transcript = raw;
      continue;
    }
    const { key, ok, needs } = NUMBER_OPTIONS[arg];
    const value = raw.trim() === '' ? NaN : Number(raw);
    if (!Number.isFinite(value) || !ok(value)) throw new UsageError(`${arg} must be ${needs}, not "${raw}"`);
    opts[key] = value;
  }
  if (opts.transcript !== null && opts.syntheticMb !== null) throw new UsageError('give --transcript or --synthetic-mb, not both');
  return opts;
}

// The whole environment of a service started in `dir`: nothing is inherited from the owner's. Throws for a
// port that is the real service's, the simulator's, or not a usable one.
export function serviceEnv({ dir, port, digest }) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || OWNERS_PORTS.includes(port)) {
    throw new RangeError(`${port} is not a port this check may use`);
  }
  return {
    // nothing on it: the service finds no claude, ps, swiftc, osascript or whisper to run
    PATH: path.join(dir, 'bin'),
    HOME: path.join(dir, 'home'),
    TMPDIR: path.join(dir, 'tmp'),
    CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
    CLAUDE_THING_PORT: String(port),
    CLAUDE_PANEL_BIND: '127.0.0.1',
    CLAUDE_THING_PID_FILE: path.join(dir, 'daemon.pid'),
    CLAUDE_THING_STATE_DIR: path.join(dir, 'state'),
    CLAUDE_THING_LOG_DIR: path.join(dir, 'logs'),
    CLAUDE_PANEL_CONFIG_DIR: path.join(dir, 'config'),
    CLAUDE_PANEL_DIGEST: digest ? '1' : '0',
  };
}

// ---- running the service -----------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function pickPort() {
  for (let tries = 0; tries < 20; tries++) {
    const port = await freePort();
    if (!OWNERS_PORTS.includes(port)) return port;
  }
  throw new Error('no free port');
}

// Whether something accepts a TCP connection on the port (it need not be answering: a busy process still
// accepts them).
function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

// GET path -> the parsed JSON body. Rejects when the service does not answer.
function getJson(port, route) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: route, agent: false, timeout: 10_000 }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.once('end', () => {
        try { resolve(JSON.parse(text)); } catch (err) { reject(err); }
      });
      res.once('error', reject);
    });
    req.once('timeout', () => req.destroy(new Error('timeout')));
    req.once('error', reject);
  });
}

// POST one hook -> { ms, ok }: ms from sending it to reading all of the response, ok when that was a 200
// inside the timeout. Over a new connection, as a hook command makes it, unless an agent is given.
function postHook(port, payload, timeoutMs = HOOK_TIMEOUT_MS, agent = false) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const t0 = performance.now();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      resolve({ ms: performance.now() - t0, ok });
    };
    const req = http.request({
      host: '127.0.0.1', port, path: '/hook', method: 'POST', agent, timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      res.resume();
      res.once('end', () => finish(res.statusCode === 200));
      res.once('error', () => finish(false));
      res.once('close', () => finish(false));
    });
    req.once('timeout', () => req.destroy(new Error('timeout')));
    req.once('error', () => finish(false));
    req.end(body);
  });
}

// What to clean up if the script is interrupted: children to kill and folders to remove.
const active = { children: new Set(), roots: new Set() };

function cleanupNow() {
  for (const child of active.children) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
  for (const root of active.roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

const exited = (child) => child.exitCode !== null || child.signalCode !== null;

// SIGTERM, which lets the service write its state and pid file (inside its temp folder), then SIGKILL.
async function stopChild(child) {
  if (exited(child)) return;
  const gone = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  let limit;
  await Promise.race([gone, new Promise((resolve) => { limit = setTimeout(resolve, 5_000); })]);
  clearTimeout(limit); // or the process would wait it out before exiting
  if (!exited(child)) {
    child.kill('SIGKILL');
    await gone;
  }
}

// The copy the digest catches up on. Copied, not linked: a hard link shares the owner's file (setting its
// modified time would change theirs) and the digest only takes transcripts modified in the last 24 h.
function placeTranscript(source, dest) {
  fs.copyFileSync(source, dest, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(dest, 0o600);
  const now = new Date();
  fs.utimesSync(dest, now, now);
}

const hook = (dir, i) => ({
  hook_event_name: i % 2 === 0 ? 'PreToolUse' : 'PostToolUse',
  session_id: 'latency-probe', tool_name: 'Read', tool_input: { file_path: '/tmp/x' }, cwd: dir,
});

const tail = (text) => text.slice(-OUTPUT_SHOWN);

// One run: the service started in <root>/<label> with the digest on or off, a burst of hooks back to back from
// the moment it accepts connections, then hooks at `rate` a second for `seconds`. Resolves
//   { label, digest, burst: [response times], burstMax, paced: [response times], failed, catchUpMs,
//     duringCatchUp, status: its last /status digest or null, died, exit, output: the tail of its output }.
// It rejects only when the service never started: after that, a service that dies or stops answering is a
// result (failed hooks, died), not an error.
async function runOnce({ root, label, digest, transcript, seconds, rate, burstMs, service, startLimitMs, settleMs, hookTimeoutMs }) {
  const dir = path.join(root, label);
  for (const sub of ['bin', 'home', 'tmp', path.join('claude', 'projects', 'latency')]) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  placeTranscript(transcript, path.join(dir, 'claude', 'projects', 'latency', crypto.randomUUID() + '.jsonl'));

  const port = await pickPort();
  const child = spawn(process.execPath, [service], { env: serviceEnv({ dir, port, digest }), cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  active.children.add(child);
  const gone = new Promise((resolve) => child.once('exit', resolve));
  let output = '';
  const keep = (c) => { output = (output + c).slice(-OUTPUT_KEPT); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  try {
    // Wait until the service accepts connections, and no longer: not until it answers anything, so that a
    // stall right at start-up is in the hooks' times. The limit is only for a service that never listens.
    const giveUp = performance.now() + startLimitMs;
    while (!(await canConnect(port))) {
      if (exited(child)) throw new Error(`the service exited at start-up:\n${tail(output)}`);
      if (performance.now() > giveUp) throw new Error(`the service did not listen:\n${tail(output)}`);
      await sleep(5);
    }
    const ready = performance.now();

    // The burst: one hook in flight at a time, back to back, over one reused connection (a connection per hook
    // is thousands a second, and with a few copies of this running at once they use up every ephemeral port:
    // EADDRNOTAVAIL, seen with eight at once). A request waits in the connection while the service is held up,
    // as it would in a new one. Stops at the first hook that fails (the service is gone, or did not answer in
    // 5 s): nothing more can be learned from it.
    const burst = [];
    const burstAt = [];
    let failed = 0;
    const burstAgent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      for (let i = 0; performance.now() - ready < burstMs; i++) {
        burstAt.push(performance.now() - ready);
        const r = await postHook(port, hook(dir, i), hookTimeoutMs, burstAgent);
        burst.push(r.ms);
        if (!r.ok) { failed++; break; }
      }
    } finally {
      burstAgent.destroy();
    }

    // Then a fixed schedule, so that a slow answer does not hold the next hook back.
    const paced = [];
    if (failed === 0) {
      const interval = 1000 / rate;
      const count = Math.max(1, Math.round(seconds * rate));
      const pending = [];
      const start = performance.now();
      for (let i = 0; i < count && !exited(child); i++) {
        const wait = start + i * interval - performance.now();
        if (wait > 0) await sleep(wait);
        pending.push(postHook(port, hook(dir, i), hookTimeoutMs).then((r) => { paced.push(r.ms); if (!r.ok) failed++; }));
      }
      await Promise.all(pending);
    }

    // A service that has just died may not have been seen to exit yet.
    if (failed > 0 && !exited(child)) await Promise.race([gone, sleep(300)]);
    const died = exited(child);

    // The service's own account of the catch-up, which may outlast the hooks. Only a digest-on run needs it.
    let status = null;
    if (digest && !died) {
      try {
        status = await getJson(port, '/status');
        const limit = performance.now() + settleMs;
        while (status.digest && status.digest.catchUpMs === null && performance.now() < limit) {
          await sleep(100);
          status = await getJson(port, '/status');
        }
      } catch {
        failed++; // it stopped answering
        status = null;
      }
    }
    const catchUpMs = status && status.digest ? status.digest.catchUpMs : null;
    return {
      label, digest, burst, burstMax: burst.length ? largest(burst) : null, paced, failed, catchUpMs,
      duringCatchUp: isFiniteNumber(catchUpMs) ? burstAt.filter((at) => at < catchUpMs).length : 0,
      status: status && status.digest ? status.digest : null,
      died, exit: child.exitCode !== null ? `exit code ${child.exitCode}` : child.signalCode ? `signal ${child.signalCode}` : 'still running',
      output: tail(output),
    };
  } finally {
    await stopChild(child);
    active.children.delete(child);
  }
}

// ---- main --------------------------------------------------------------------------------------------

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
};
const sum = (values) => values.reduce((a, b) => a + b, 0);

// `service`, `startLimitMs`, `settleMs` and `hookTimeoutMs` are for the tests (a stand-in service, a short wait
// for one that never listens, for a catch-up that never finishes, for a hook that is never answered); `out` and
// `err` are where the JSON line and the messages go. Resolves the exit code.
export async function main(argv = process.argv.slice(2), { service = SERVICE, startLimitMs = START_LIMIT_MS,
  settleMs = SETTLE_LIMIT_MS, hookTimeoutMs = HOOK_TIMEOUT_MS, out = process.stdout, err: errStream = process.stderr } = {}) {
  const say = (text) => errStream.write(`hook-latency: ${text}\n`);
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    say(`${err.message} (see --help)`);
    return 2;
  }
  if (opts.help) {
    out.write(USAGE);
    return 0;
  }

  let source = opts.transcript;
  if (opts.syntheticMb === null) {
    if (source === null) {
      // the owner's own run: the largest transcript Claude Code has kept. Only its size is looked at here.
      const { CLAUDE_PROJECTS_DIR } = await import('../src/config.js');
      source = largestTranscript(CLAUDE_PROJECTS_DIR);
      if (source === null) {
        say(`no transcript under ${CLAUDE_PROJECTS_DIR}; give --transcript <file> or --synthetic-mb <n>`);
        return 2;
      }
    }
    let st;
    try {
      st = fs.statSync(source);
    } catch (err) {
      say(`--transcript: cannot read ${source} (${err.code || 'error'})`);
      return 2;
    }
    if (!st.isFile()) {
      say(`--transcript: ${source} is not a file`);
      return 2;
    }
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-thing-latency-'));
  fs.chmodSync(root, 0o700);
  active.roots.add(root);
  // Ctrl-C, kill, and a closed terminal (SIGHUP, to the whole process group, the service included): the
  // service goes and so does the folder, which holds copies of the transcript.
  const handlers = Object.entries(SIGNAL_CODES).map(([signal, code]) => {
    const handler = () => {
      cleanupNow();
      process.exit(code);
    };
    process.once(signal, handler);
    return [signal, handler];
  });
  try {
    if (opts.syntheticMb !== null) {
      source = path.join(root, 'synthetic.jsonl');
      writeSyntheticTranscript(source, opts.syntheticMb);
    }
    const transcriptBytes = fs.statSync(source).size;
    const base = { root, transcript: source, seconds: opts.seconds / RUNS_PER_SIDE, rate: opts.rate, burstMs: opts.burstMs,
      service, startLimitMs, settleMs, hookTimeoutMs };

    // off, on, off, on, off, on: neither side always runs first. A run that failed ends the series: whatever
    // else follows, the verdict is a FAIL.
    const runs = [];
    for (let i = 0; i < 2 * RUNS_PER_SIDE; i++) {
      const digest = i % 2 === 1;
      const run = await runOnce({ ...base, label: `${digest ? 'on' : 'off'}-${Math.floor(i / 2) + 1}`, digest });
      runs.push(run);
      if (run.failed > 0 || run.died) break;
    }
    const offRuns = runs.filter((r) => !r.digest);
    const onRuns = runs.filter((r) => r.digest);

    const catchUps = onRuns.map((r) => r.catchUpMs);
    const result = {
      off: { ...summarize(offRuns.flatMap((r) => r.paced)), failed: sum(offRuns.map((r) => r.failed)) },
      on: { ...summarize(onRuns.flatMap((r) => r.paced)), failed: sum(onRuns.map((r) => r.failed)),
        catchUpMs: catchUps.length > 0 && catchUps.every(isFiniteNumber) ? median(catchUps) : null },
      burst: {
        off: offRuns.map((r) => (r.burstMax === null ? null : hundredths(r.burstMax))),
        on: onRuns.map((r) => (r.burstMax === null ? null : hundredths(r.burstMax))),
        duringCatchUp: onRuns.map((r) => r.duringCatchUp),
      },
    };

    const problems = [];
    for (const r of runs) {
      if (r.died) problems.push(`the ${r.label} service died mid-run (${r.exit})`);
      else if (r.failed > 0) problems.push(`${r.failed} hook(s) failed or got no answer in ${hookTimeoutMs / 1000} s in the ${r.label} run`);
    }
    const inconclusive = whyInconclusive(onRuns.map((r) => ({ digest: r.status, catchUpMs: r.catchUpMs, duringCatchUp: r.duringCatchUp })));
    const burstRule = burstVerdict(result.burst.off, result.burst.on, opts.burstMargin);
    const verdicts = {
      p99: verdict(result.off, result.on, opts.margin),
      burst: burstRule === 'FAIL' ? 'FAIL' : inconclusive ? 'INCONCLUSIVE' : 'PASS',
    };
    result.verdicts = verdicts;
    result.verdict = finalVerdict(verdicts, problems);
    result.transcriptBytes = transcriptBytes;
    out.write(JSON.stringify(result) + '\n');

    const reasons = [...problems];
    if (verdicts.burst === 'FAIL') {
      reasons.push(`the burst rule: the best digest-on burst max (${smallestOf(result.burst.on)} ms) is more than ${opts.burstMargin} ms above the best digest-off one (${smallestOf(result.burst.off)} ms)`);
    }
    if (verdicts.p99 === 'FAIL') {
      reasons.push(`the p99 rule: the digest-on p99 (${result.on.p99} ms) is more than ${opts.margin} ms above the digest-off p99 (${result.off.p99} ms)`);
    }
    if (result.verdict === 'FAIL') say(`FAIL: ${reasons.join('; ')}`);
    else if (result.verdict === 'INCONCLUSIVE') say(`INCONCLUSIVE: ${inconclusive}`);
    for (const r of runs) {
      // a service that died, or a run in which hooks failed or went unanswered: the tail of the service's own
      // output (log lines: states, sizes and timings, never a transcript's text)
      if (r.died || r.failed > 0) say(`the last output of the ${r.label} service:\n${r.output}`);
    }
    return exitCodeFor(result.verdict);
  } catch (err) {
    say(err && err.message ? err.message : String(err));
    return 2;
  } finally {
    // the children are already stopped (runOnce's finally); the folder goes whatever happened
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    active.roots.delete(root);
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  }
}

// The smallest number in a list that may hold nulls, for a message.
const smallestOf = (values) => {
  const numbers = values.filter(isFiniteNumber);
  return numbers.length ? smallest(numbers) : 'none';
};

const invoked = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (invoked) {
  main().then((code) => { process.exitCode = code; });
}
