// The digest runs in the process that answers Claude Code's hooks (PreToolUse fires on every tool call, with
// a 5 s hook timeout), so what it must never do is hold the event loop: a hook that arrives while it is
// catching up on a big transcript has to be answered about as fast as one that arrives while it is idle.
// This catches up on a 30 MB synthetic transcript in this process and asks the question two ways.
// scripts/hook-latency.js asks it over HTTP of a real service.
//
// 1. How much the digest parses between two turns of the event loop. No clock, so it cannot flake: a
//    setImmediate ticker counts the loop's turns, the reader's callback sums the bytes of the lines it is
//    handed within one turn, and no turn may hold more than 8 MB (a 256 KB chunk, finished by the longest
//    line the reader will parse, 4 MB, is the most a correct reader holds, about 4.3 MB; the bound is a
//    literal here, not the reader's own constants, which a regression could change with it). The synthetic
//    file's own widest turn is about 2.3 MB. A reader that parses the file in one go (all 30 MB) or in huge
//    chunks fails it on any machine.
// 2. How long the loop was actually held, as the brief asks: a 1 ms event-loop-delay histogram runs through
//    the catch-up, and its p99 and max are held to limits. A wall-clock bound on a busy CI box has to allow
//    for the OS taking the CPU away for tens of milliseconds, which has nothing to do with the digest, so:
//    - the limits are relative to a control: the same kind of histogram in a worker thread, running over
//      the same window. A worker's loop is not held by what this thread does, and the OS delays both threads
//      alike, so a busy box raises the control and the limits with it. A quiet one reads about 1 to 2 ms,
//      and the limits are then 10 ms (p99) and 40 ms (max) above twice that, 13 and 44 ms. (Tighter than the
//      brief's 20 and 100: measured here, a catch-up holds the loop for at most about 6 ms, while parsing the
//      whole 30 MB file on the loop holds it for 70 to 110 ms, so a max bound of 100 ms passes that half the
//      time);
//    - up to five attempts, each a fresh digest on the same file, a moment apart. Scheduler noise comes and
//      goes (measured here: with eight copies of this test running at once, about two attempts in three
//      are over their limits, and the next one is inside them); the thing this is for does not: parsing the
//      file in one go stalls the loop for as long as that takes on every attempt. It passes on the first
//      attempt inside the limits and fails, printing each, only when none is.
//    Both tests also assert, whatever the clock said, what is exact: the whole file was read, line for line,
//    without an error, and the digest is right. A reader that gave up early would be fast too.
// The last test shows the instrument hears a 150 ms stall, so a pass is not a monitor that cannot hear.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';

// config.js reads these once, when something first imports it: the saved state and the log both go to
// the temp dir (log.js opens <LOG_DIR>/daemon.log with 'w', which in the checkout is the live service's log).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-thing-digest-latency-'));
// removed however this process ends, an import that fails below included
process.once('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
process.env.CLAUDE_THING_STATE_DIR = path.join(TMP, 'state');
process.env.CLAUDE_THING_LOG_DIR = path.join(TMP, 'logs');

const { createDigest } = await import('../src/digest/index.js');
const { readRecords } = await import('../src/digest/reader.js');
const { writeSyntheticTranscript } = await import('../scripts/synthetic-transcript.js');

const NOW = Date.parse('2026-11-02T12:00:00Z');
const HOUR = 3600e3;
const MB = 1024 * 1024;
const projectsDir = path.join(TMP, 'projects');
const stateFile = path.join(TMP, 'state', 'digest.json');
const transcript = path.join(projectsDir, 'proj', 'synthetic.jsonl');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let info;
before(() => {
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  info = writeSyntheticTranscript(transcript, 30, { nowMs: NOW });
  fs.utimesSync(transcript, (NOW - HOUR) / 1000, (NOW - HOUR) / 1000);
});

// A digest catching up on the synthetic transcript, from no saved state, with its reader watched: what it
// was asked to read, how far it got, and every line handed over (onLine(end, from) as it is). `around`
// wraps the wait for the digest to be idle (and its result is `measured`). The caller stops the digest.
async function catchUp({ onLine = () => {}, around = (run) => run() } = {}) {
  fs.rmSync(stateFile, { force: true });
  const reads = [];
  let records = 0;
  const read = async (file, from, onRecord, opts) => {
    const res = await readRecords(file, from, (rec, end) => { records++; onLine(end, from); onRecord(rec, end); }, opts);
    reads.push([from, res]);
    return res;
  };
  // a short debounce, so the digest is idle soon after its last chunk
  const d = createDigest({ emit() {}, projectsDir, now: () => NOW, readDelayMs: 0, emitDebounceMs: 5, read });
  const measured = await around(async () => { await d.start(); await d.whenIdle(); });
  return { d, reads, records, measured };
}

// What is exact about a finished catch-up, whatever the clock said.
function assertCaughtUp({ d, reads, records }) {
  assert.deepEqual(reads, [[0, { offset: info.bytes, size: info.bytes, shrunk: false }]], 'one read, the whole file');
  assert.equal(records, info.lines, 'every line was handed over');
  const status = d.status();
  assert.deepEqual([status.sessions, status.cards, status.skipped, status.queued, status.errors], [1, 1, 0, 0, 0]);
  assert.equal(typeof status.catchUpMs, 'number');
  assert.equal(d.get().cards.length, 1);
  assert.equal(d.get().totals.turns, info.turns);
}

test('the synthetic transcript is what the tests below say it is', () => {
  assert.ok(info.bytes >= 30 * MB, `a ${info.bytes} byte transcript`);
  assert.equal(info.attachments, 3);
  assert.ok(info.turns >= 3);
});

test('catching up a 30 MB transcript parses at most 8 MB between two turns of the event loop', async (t) => {
  let turns = 0;
  let ticking = true;
  const tick = () => { turns++; if (ticking) setImmediate(tick); };
  setImmediate(tick);

  let sliceTurn = -1; // the turn the lines being summed were handed over in
  let sliceBytes = 0;
  let previousEnd = null;
  let widest = 0;
  const onLine = (end, from) => {
    if (previousEnd === null) previousEnd = from;
    if (turns !== sliceTurn) { sliceTurn = turns; sliceBytes = 0; }
    sliceBytes += end - previousEnd; // this line, newline included
    previousEnd = end;
    widest = Math.max(widest, sliceBytes);
  };
  let run;
  try {
    run = await catchUp({ onLine });
    ticking = false;
    assertCaughtUp(run);
    t.diagnostic(`the most parsed between two turns of the loop: ${widest} bytes, over ${turns} turns`);
    assert.ok(turns > 10, 'the loop kept turning');
    assert.ok(widest <= 8 * MB, `${widest} bytes parsed in one turn of the loop`);
  } finally {
    ticking = false;
    if (run) run.d.stop();
  }
});

// A second thread's event-loop-delay histogram, the control: it is not held by what this thread does, and
// the OS delays it as it delays this one. start() begins a window, stop() ends it and reads { p99, max }.
function controlMonitor() {
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    const { monitorEventLoopDelay } = require('node:perf_hooks');
    const h = monitorEventLoopDelay({ resolution: 1 });
    parentPort.on('message', (m) => {
      if (m === 'start') { h.reset(); h.enable(); setTimeout(() => parentPort.postMessage('started'), 10); }
      else { h.disable(); parentPort.postMessage({ p99: h.percentile(99) / 1e6, max: h.max / 1e6 }); }
    });
  `, { eval: true });
  const next = () => new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
  return {
    async start() { worker.postMessage('start'); await next(); },
    async stop() { worker.postMessage('stop'); return next(); },
    end: () => worker.terminate(),
  };
}

// This thread's loop delay in milliseconds while fn runs, and a moment after, so a stall that ended just as
// fn did is counted: the histogram hears of a stall at the next tick of its timer, and only ticks after
// its first, so it is let tick once before fn starts. ms is fn's own time.
async function measure(fn) {
  const h = monitorEventLoopDelay({ resolution: 1 });
  h.enable();
  await sleep(10);
  const t0 = performance.now();
  let ms;
  try {
    await fn();
    ms = performance.now() - t0;
    await sleep(10);
  } finally {
    h.disable();
  }
  return { p99: h.percentile(99) / 1e6, max: h.max / 1e6, ticks: h.count, ms };
}

const ATTEMPTS = 5;
const round = (v) => Math.round(v * 10) / 10;
const show = (a) => `catch-up p99 ${round(a.run.p99)} ms (limit ${round(a.limit.p99)}), max ${round(a.run.max)} ms (limit ${round(a.limit.max)}); `
  + `control p99 ${round(a.control.p99)} ms, max ${round(a.control.max)} ms; ${Math.round(a.run.ms)} ms over ${a.run.ticks} ticks`;

test('catching up a 30 MB transcript never holds the event loop', { timeout: 180_000 }, async (t) => {
  const control = controlMonitor();
  const attempts = [];
  try {
    for (let i = 0; i < ATTEMPTS; i++) {
      if (i > 0) await sleep(200); // let whatever else is running move on
      await control.start();
      const run = await catchUp({ around: measure });
      const watched = await control.stop();
      try {
        assertCaughtUp(run);
        const limit = { p99: 10 + 2 * watched.p99, max: 40 + 2 * watched.max };
        attempts.push({ run: run.measured, control: watched, limit });
        const ok = run.measured.p99 < limit.p99 && run.measured.max < limit.max;
        t.diagnostic(`attempt ${i + 1}${ok ? ' ok' : ' over'}: ${show(attempts.at(-1))}`);
        if (ok) return;
      } finally {
        run.d.stop();
      }
    }
  } finally {
    await control.end();
  }
  assert.fail('the event loop was held on every attempt:\n  ' + attempts.map(show).join('\n  '));
});

test('the monitor hears a stall: a 150 ms busy loop shows as a loop delay of about that', async () => {
  const stall = await measure(async () => {
    const end = performance.now() + 150;
    while (performance.now() < end);
  });
  assert.ok(stall.max >= 140, `max ${round(stall.max)} ms`);
});
