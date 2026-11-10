// Moving a background session into an ordinary VS Code tab, and stopping one.
//
// A background session is a `claude --bg` process under the daemon. VS Code can resume its conversation
// as a normal tab, but not while that process is still writing to it, so the move is always: stop the
// process, wait until it is really gone, and only then open VS Code on it (focus.openInVsCode). A move
// that cannot stop the process opens nothing.
//
// The reverse matters just as much: a stop that VS Code cannot follow strands the session, stopped with
// nothing opened. On the NucBox the open goes to a helper in the owner's desktop session, and there may
// be no such session (nobody logged in) or no helper installed. So `canOpen` is asked before anything is
// stopped, and a refusal ('no-desktop', 'not-set-up') ends the move with the agent still running.
//
// This is the only path that stops a session on the owner's behalf. claude.session.focus, a queue
// card's SWITCH and the held-prompt "Open in VS Code" answer never do (see focus.js).
//
// A session that is mid-turn is not cut off: the request waits (`handoff: 'waiting'` on its store
// record) and the move starts from the Stop hook. The wait lives in memory only, so a restarted service
// forgets it, and the row goes back to offering "Open in VS Code".

import { execFile } from 'node:child_process';
import { turnEnded } from './background.js';
import { parseListing } from './sessions/source-poller.js';
import { log } from './log.js';

// Put in the session's input box, unsent, by OPEN NOW: the turn it cut off is redone, not resumed.
export const CONTINUE_PROMPT = 'Continue where you left off.';

const STOP_TIMEOUT_MS = 15_000;
const LISTING_TIMEOUT_MS = 10_000;
const GONE_POLL_MS = 300;
const GONE_DEADLINE_MS = 10_000;
// What `claude agents` calls a background job's id: the first 8 hex digits of its session id.
const SHORT_ID_RE = /^[0-9a-f]{8}$/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// `claude agents --json`, parsed: an array, or null when it failed or did not parse. The same
// invocation as the poller's, hooks off for the same reason (see source-poller.js).
function readListing(run, timeout) {
  return new Promise((resolve) => {
    run('claude', ['--settings', '{"disableAllHooks":true}', 'agents', '--json'], { timeout }, (err, stdout) => {
      resolve(err ? null : parseListing(stdout));
    });
  });
}

const isJob = (shortId) => (a) => !!a && a.kind === 'background' && String(a.id) === shortId;

// Whether a process still exists. Signal 0 only checks: ESRCH is "no such process"; EPERM means it
// exists but is not ours to signal, which is still alive. (Anything else is treated as alive too: a
// wait that is too long is safe, a wait that ends early is not.)
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return !(err && err.code === 'ESRCH');
  }
}

// `claude stop <short id>`, resolving only once the job's process is gone: a command that returned is
// not proof that the process has exited, and VS Code must not resume a conversation a live process is
// still writing.
//
// The proof is the process itself. The job's pid is read from `claude agents --json` before the stop
// (the listing carries it), and afterwards `isAlive(pid)` is polled until it says no.
//
// With no pid to watch (the job isn't in that listing, has no usable pid, or the listing failed) the
// listings have to say, and one is not enough: a single read can be torn (config.js; the poller needs
// two misses for the same reason). Gone then means two listings in a row that agree the job is not
// there: both readable and naming other sessions, or both empty. A lone `[]` can't say, and a failed
// or unreadable listing, or the job being listed, starts the count again.
//
// Rejects with Error('stop-failed') if the command fails (or the id is not a short id),
// Error('stop-timeout') if the job is still not confirmed gone after GONE_DEADLINE_MS. In the
// fallback no listing runs longer than the time left. `run` is execFile's signature and `isAlive`
// takes a pid, both for tests.
export async function claudeStop(shortId, {
  run = execFile, isAlive = pidAlive, pollMs = GONE_POLL_MS, deadlineMs = GONE_DEADLINE_MS,
} = {}) {
  // The id becomes an argument of `claude`; anything but a short id could be read as an option.
  if (typeof shortId !== 'string' || !SHORT_ID_RE.test(shortId)) throw new Error('stop-failed');

  const before = await readListing(run, LISTING_TIMEOUT_MS);
  const entry = before && before.find(isJob(shortId));
  // pid 0 and 1 are never a job (kill(0) would signal our own process group).
  const pid = entry && Number.isInteger(entry.pid) && entry.pid > 1 ? entry.pid : null;

  const err = await new Promise((resolve) => {
    run('claude', ['stop', shortId], { timeout: STOP_TIMEOUT_MS }, (e) => resolve(e || null));
  });
  if (err) throw new Error('stop-failed');

  const deadline = Date.now() + deadlineMs;
  if (pid) {
    while (await isAlive(pid)) {
      if (Date.now() >= deadline) throw new Error('stop-timeout');
      await sleep(pollMs);
    }
    return;
  }

  let agreeing = 0;
  let last = null; // what the last listing said: 'others', 'empty', or null (it can't be used)
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('stop-timeout');
    const list = await readListing(run, Math.min(LISTING_TIMEOUT_MS, remaining));
    const said = !list ? null : !list.length ? 'empty' : list.some(isJob(shortId)) ? null : 'others';
    agreeing = said && said === last ? agreeing + 1 : (said ? 1 : 0);
    last = said;
    if (agreeing >= 2) return;
    await sleep(pollMs);
  }
}

const failed = (reason) => ({ result: 'failed', reason });
const firstLine = (e) => String((e && (e.message || e.reason)) || e || 'error').split('\n')[0];
// The reason the panel is told for a stop that did not happen: claudeStop's own codes, else a generic one.
const stopReason = (err) => (err && /^stop-(failed|timeout)$/.test(err.message) ? err.message : 'stop-failed');

// `isWindowless(id)` is whether the session is a background job with no window parked on it; only such
// a session is ever stopped. `canOpen()` resolves to null when VS Code can be opened, else the reason it
// cannot (the default is always able, as on the Mac); a rejection counts as 'not-set-up'. STOP does not
// ask it: ending an agent needs no desktop. `onOpened(id)` hears every move that ended with VS Code open,
// whichever way it started (a press, OPEN NOW, the Stop hook): that is where the session's queue card is
// cleared. `folderFor(id, raw)` is the folder VS Code is opened on, for a move and a raise alike: the one
// the session started in (index.js passes the real one, read from its transcript), because that is the
// window that hosts it; the default is the record's cwd, which a session that moved into a git worktree
// no longer shares with its window. Every method resolves to { result, reason? } and none rejects: a
// failure is a result, so a caller that cannot await (the Stop hook) never leaves a rejection behind.
export function createHandoff({
  store, focus, isWindowless, stopAgent = claudeStop, onOpened = () => {}, canOpen = async () => null,
  folderFor = (id, raw) => raw.cwd,
}) {
  const moves = new Map(); // id -> the move in flight, so a second press joins it instead of racing it
  // id -> how many STOPs and cancels it has had. A press reads it before the desktop check and again after:
  // if it moved, the owner said no while the press was waiting, and the press goes no further.
  const generations = new Map();
  const generation = (id) => generations.get(id) || 0;
  const bump = (id) => generations.set(id, generation(id) + 1);

  // Why VS Code cannot be opened right now, or null. Logged here, once per refusal, with the job it
  // kept from being stopped.
  async function desktopRefusal(jobId) {
    let why;
    try {
      why = await canOpen();
    } catch (err) {
      log('HO', `desktop check failed: ${firstLine(err)}`);
      why = 'not-set-up';
    }
    if (why) log('HO', `not moving ${jobId}: ${why}`);
    return why || null;
  }

  // The record only exists while the session is live: clearing a wait on a session that has gone must
  // not make a record for it (upsert would).
  function setHandoff(id, value) {
    if (store.raw(id)) store.upsert(id, { handoff: value });
  }

  async function move(id, prompt) {
    const raw = store.raw(id);
    const { jobId } = raw;
    // Asked again here, not only at the press: a wait can last a whole turn, and OPEN NOW skips the press.
    const refusal = await desktopRefusal(jobId);
    if (refusal) return failed(refusal);
    // Worked out before the stop: a folder that cannot be found must leave the agent running, not stopped
    // with nowhere to open it.
    let folder;
    try {
      folder = folderFor(id, raw);
    } catch (err) {
      log('HO', `not moving ${jobId}: no folder to open (${firstLine(err)})`);
      return failed('open-failed');
    }
    try {
      await stopAgent(jobId);
    } catch (err) {
      log('HO', `stop failed for ${jobId}: ${firstLine(err)}`);
      return failed(stopReason(err));
    }
    let opened;
    try {
      opened = await focus.exclusive(() => focus.openInVsCode(folder, id, prompt));
    } catch (err) {
      opened = { focused: false, reason: firstLine(err) };
    }
    if (!opened || !opened.focused) {
      // The agent is stopped by now; its conversation is on disk and VS Code can still resume it.
      log('HO', `stopped ${jobId}, but VS Code did not open: ${(opened && opened.reason) || 'no reason'}`);
      return failed('open-failed');
    }
    log('HO', `opened ${jobId} in VS Code${prompt ? ' with the continue prompt' : ''}`);
    try { onOpened(id); } catch (err) { log('HO', `onOpened failed: ${firstLine(err)}`); }
    return { result: 'opened' };
  }

  function startMove(id, prompt) {
    setHandoff(id, 'moving');
    const run = move(id, prompt).finally(() => {
      moves.delete(id);
      setHandoff(id, null);
    });
    moves.set(id, run);
    return run;
  }

  async function raise(id, raw) {
    let r;
    try {
      r = await focus.exclusive(() => focus.focusSession(id, { host: raw.host, cwd: folderFor(id, raw), kind: raw.kind }));
    } catch (err) {
      r = { focused: false, reason: firstLine(err) };
    }
    return r && r.focused ? { result: 'raised' } : failed((r && r.reason) || 'not-raised');
  }

  // The session view's row. A session that is not a windowless background job is only raised, as it
  // always was. One that is: moved now if its turn is over, else waited on until the Stop hook.
  async function request(id) {
    const raw = store.raw(id);
    if (!raw) return failed('unknown-session');
    if (moves.has(id)) return moves.get(id);
    if (!isWindowless(id)) return raise(id, raw);
    if (!raw.jobId) return failed('not-background');
    const asked = generation(id);
    const refusal = await desktopRefusal(raw.jobId);
    // The check took a moment, and nothing held still for it. A STOP or a cancel that landed meanwhile is
    // the owner's later word: this press neither moves the session nor sets a wait STOP has just dropped.
    if (generation(id) !== asked) {
      log('HO', `not moving ${raw.jobId}: stopped or cancelled while the desktop was checked`);
      return { result: 'cancelled' };
    }
    if (refusal) return failed(refusal);
    // A second press may have started the move, the turn may have ended (its Stop hook found no wait to act
    // on), the session may have gone, or a window may have parked on the job (it is that window's now).
    if (moves.has(id)) return moves.get(id);
    const fresh = store.raw(id);
    if (!fresh) return failed('unknown-session');
    if (!isWindowless(id)) return raise(id, fresh);
    if (turnEnded(fresh)) return startMove(id, undefined);
    if (fresh.handoff !== 'waiting') {
      setHandoff(id, 'waiting');
      log('HO', `waiting for ${fresh.jobId} to finish its turn`);
    }
    return { result: 'waiting' };
  }

  // The row pressed again while waiting: the wait ends, nothing else happens. A press still at its desktop
  // check gives up too (request).
  async function cancel(id) {
    bump(id);
    const raw = store.raw(id);
    if (raw && raw.handoff === 'waiting') {
      setHandoff(id, null);
      log('HO', `no longer waiting for ${raw.jobId}`);
    }
    return { result: 'cancelled' };
  }

  // OPEN NOW: stop and open without waiting for the turn to end, with the continue prompt filled in.
  async function now(id) {
    const raw = store.raw(id);
    if (!raw) return failed('unknown-session');
    if (moves.has(id)) return moves.get(id);
    if (!isWindowless(id)) return failed('not-windowless');
    if (!raw.jobId) return failed('not-background');
    return startMove(id, CONTINUE_PROMPT);
  }

  // The STOP row: end the agent and leave it ended. Any wait is dropped first, so a Stop hook landing
  // while the stop is still running cannot start a move the owner has just said no to, and a press still
  // at its desktop check gives up (request).
  async function stop(id) {
    const raw = store.raw(id);
    if (!raw) return failed('unknown-session');
    if (!raw.jobId) return failed('not-background');
    if (moves.has(id)) return failed('moving');
    bump(id);
    setHandoff(id, null);
    try {
      await stopAgent(raw.jobId);
    } catch (err) {
      log('HO', `stop failed for ${raw.jobId}: ${firstLine(err)}`);
      return failed(stopReason(err));
    }
    log('HO', `stopped ${raw.jobId}`);
    return { result: 'stopped' };
  }

  // Called after a Stop or StopFailure hook has been answered and the store has heard it. Moves a
  // session that is being waited on, if its turn has ended for good (a Stop with a background task
  // still running, or a permission still pending, is not the end). Never rejects.
  async function onHook(event, payload) {
    try {
      if (event !== 'Stop' && event !== 'StopFailure') return undefined;
      const id = payload && payload.session_id;
      const raw = id && store.raw(id);
      if (!raw || raw.handoff !== 'waiting' || moves.has(id) || !turnEnded(raw)) return undefined;
      // A window that parked on the job since the wait began is its UI now: it is not ours to stop.
      if (!isWindowless(id) || !raw.jobId) {
        setHandoff(id, null);
        log('HO', `not moving ${raw.jobId}: a window has it now`);
        return undefined;
      }
      return await startMove(id, undefined);
    } catch (err) {
      log('HO', `hook handling failed: ${firstLine(err)}`);
      return undefined;
    }
  }

  return { request, cancel, now, stop, onHook };
}
