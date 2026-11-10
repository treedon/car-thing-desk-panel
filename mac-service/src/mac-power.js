// Whether the Mac is in use, for the panel: is its display lit, is it asleep.
//
// The OS only says so through notifications that need a GUI session, so a small
// Swift helper (native/power-watch.swift) listens for them and prints one line
// per change. This module compiles that helper on first use, keeps it running,
// and turns its lines into a {display, sleeping} state.
//
// Wholly best-effort. With no swiftc, or a helper that won't run, the state
// stays at "display on, awake" and the panel falls back on its link-loss rule,
// which already darkens the screen when a sleeping Mac stops answering.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFile, spawn } from 'node:child_process';
import { DAEMON_ROOT } from './config.js';
import { log } from './log.js';

const SOURCE = path.join(DAEMON_ROOT, 'native', 'power-watch.swift');
const BINARY = path.join(os.homedir(), '.cache', 'claude-panel', 'power-watch');
const COMPILE_TIMEOUT_MS = 120_000;
const RESPAWN_MS = 5_000;

function swiftc(source, out) {
  return new Promise((resolve, reject) => {
    execFile('swiftc', ['-O', source, '-o', out], { timeout: COMPILE_TIMEOUT_MS }, (err, _stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim().slice(0, 300)));
      else resolve();
    });
  });
}

// Compile the helper when its binary is missing or older than the source, and
// say where it is. Built beside the final path and renamed into place: a
// half-written binary would otherwise look newer than the source and never be
// rebuilt. A failed compile leaves any earlier binary where it was.
export async function ensureHelper({ source = SOURCE, binary = BINARY, compile = swiftc } = {}) {
  let current = false;
  try { current = fs.statSync(binary).mtimeMs >= fs.statSync(source).mtimeMs; } catch { /* missing */ }
  if (current) return binary;
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  const building = `${binary}.building`;
  try {
    await compile(source, building);
    fs.renameSync(building, binary);
  } finally {
    fs.rmSync(building, { force: true });
  }
  return binary;
}

async function spawnWatcher() {
  const binary = await ensureHelper();
  return spawn(binary, [], { stdio: ['ignore', 'pipe', 'ignore'] });
}

// spawnHelper() returns (or resolves to) a child-process-like object with a
// stdout stream, and an 'exit' event if it has one. Tests pass a fake.
export function createMacPower({ onChange = () => {}, spawnHelper = spawnWatcher, respawnMs = RESPAWN_MS } = {}) {
  let state = { display: 'on', sleeping: false };
  let child = null;
  let timer = null;
  let stopped = false;
  let warned = false;

  // Once only: a helper that keeps dying must not fill the log every 5 s.
  function warn(message) {
    if (warned) return;
    warned = true;
    log('PW', `Mac power watcher ${message}`);
  }

  function feed(line) {
    const next = { ...state };
    switch (String(line).trim()) {
      case 'display off': next.display = 'off'; break;
      case 'display on': next.display = 'on'; break;
      case 'will sleep': next.sleeping = true; break;
      // The display is left alone: a Mac can wake with its screen still dark,
      // and "display on" arrives on its own when the screen lights.
      case 'did wake': next.sleeping = false; break;
      default: return;
    }
    if (next.display === state.display && next.sleeping === state.sleeping) return;
    state = next;
    onChange({ ...state });
  }

  async function launch() {
    let proc;
    try {
      proc = await spawnHelper();
    } catch (err) {
      // Most likely no swiftc, or a source that won't compile. Neither fixes
      // itself, so don't re-run the compiler every few seconds.
      warn(`could not start (${err && err.message ? err.message : err}); the Mac's display and sleep state will not be reported`);
      return;
    }
    if (stopped) { if (proc && proc.kill) proc.kill(); return; }
    child = proc;
    // A helper that has just started is running on a Mac that is awake, so a
    // "sleeping" left over from one that died before reporting "did wake"
    // must not outlive it. The helper reports the display itself at start.
    feed('did wake');
    readline.createInterface({ input: proc.stdout }).on('line', feed);
    if (!proc.on) return;
    proc.on('error', (err) => warn(`failed (${err.message}); the Mac's display and sleep state may not be reported`));
    proc.on('exit', (code, signal) => {
      if (child !== proc) return;
      child = null;
      if (stopped) return;
      warn(`exited (code ${code}, signal ${signal}); restarting it every ${respawnMs / 1000} s`);
      timer = setTimeout(launch, respawnMs);
      timer.unref();
    });
  }

  return {
    get: () => ({ ...state }),
    feed,
    start() { stopped = false; launch(); },
    stop() {
      stopped = true;
      clearTimeout(timer);
      if (child && child.kill) child.kill();
      child = null;
    },
  };
}
