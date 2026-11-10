// The digest service: hears Claude Code's Stop and SessionEnd hooks, reads each changed transcript from
// where it stopped into that session's fact extractor, keeps and persists the facts, catches up on the
// last day's transcripts at start-up, and pushes a debounced claude.digest.update. It runs in the
// process that answers the hooks, so:
//   - onHook does no I/O and no JSON: it checks the payload, sets flags and arms an unref'd timer.
//     Stat, read, agent facts, save and emit all happen later, from timers and async code;
//   - one transcript is read at a time, hook work before catch-up work, in the reader's yielding
//     chunks. A hook for the session being read marks it, and it is read once more when that read ends;
//   - every timer callback and async step is contained: a bad transcript, a vanished file or folder, or
//     a throwing reader, emit or isLive is counted and logged by its error code, and the queue moves on;
//   - only the digest's own work is done per read: no full-state JSON (the saver throttles), no digest
//     built unless get() or the debounced emit asks for one, agent facts only for the session read.
// Everything it emits, saves or returns is redacted text (the extractor, agents.js and card.js redact).
// The log carries sizes, timings, states and an 8-character session-id prefix, never a path or text.
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { STATE_DIR, DIGEST_WINDOW_HOURS, DIGEST_MAX_CARDS, DIGEST_EMIT_DEBOUNCE_MS, DIGEST_SAVE_INTERVAL_MS,
  DIGEST_READ_DELAY_MS } from '../config.js';
import { log } from '../log.js';
import { isOwnSession } from '../own-sessions.js';
import { createExtractor } from './extract.js';
import { readRecords } from './reader.js';
import { loadDigestState, saveDigestState, pruneDigestState, createSaver } from './state.js';
import { readAgentFacts } from './agents.js';
import { buildDigest, emptyDigest } from './card.js';

// The file state.js saves as 'digest' (persist.js names it <STATE_DIR>/<name>.json).
const STATE_FILE = path.join(STATE_DIR, 'digest.json');
const STATE_VERSION = 1;
const EXT = '.jsonl';
const SCAN_BATCH = 32; // transcripts stat'ed at once by the catch-up scan, which yields between batches
// Turn-log entries from before the window an extractor may hold before it is rebuilt without them; the
// log grows by one per turn for as long as a session runs.
const COMPACT_AFTER = 64;
const MAX_ID = 200;
const MAX_PATH = 4096;
const KEEPALIVE_MS = 2 ** 30;

const noAgents = () => ({ finished: 0, running: 0, list: [] });
const isOffset = (n) => Number.isSafeInteger(n) && n >= 0;
const short = (id) => String(id).slice(0, 8);
// An error as a short code (EIO, ENOENT, SyntaxError): never its message, which can quote a path or text.
const why = (err) => String((err && (typeof err.code === 'string' ? err.code : err.name)) || 'error').replace(/[^\w-]/g, '').slice(0, 40);
const ms = (v, fallback) => (Number.isFinite(v) && v >= 0 ? v : fallback);

function unref(timer) {
  if (timer && typeof timer.unref === 'function') timer.unref();
}

function note(message) {
  try {
    log('DG', message);
  } catch {
    // the log is best effort
  }
}

// A FIFO of ids without duplicates, each operation O(1) amortized. (Taking the first id of a Set and
// deleting it is not: V8 leaves the deleted slots in place, so draining n ids that way is quadratic.)
// An id deleted and added again goes to the back. Exported for its test.
export function createQueue() {
  const live = new Map(); // id -> the number of its entry in `order`
  let order = []; // [id, number]; an entry whose number is not live's is stale and skipped
  let head = 0;
  let count = 0;
  return {
    get size() { return live.size; },
    has: (id) => live.has(id),
    add(id) {
      if (live.has(id)) return;
      live.set(id, ++count);
      order.push([id, count]);
    },
    delete(id) {
      live.delete(id);
      if (live.size === 0) { order = []; head = 0; }
    },
    clear() {
      live.clear();
      order = [];
      head = 0;
    },
    shift() {
      while (head < order.length) {
        const [id, n] = order[head++];
        if (live.get(id) !== n) continue;
        live.delete(id);
        if (head > 1024 && head * 2 > order.length) { order = order.slice(head); head = 0; }
        return id;
      }
      order = [];
      head = 0;
      return undefined;
    },
  };
}

// persist: false keeps the state in memory only (the demo without a state folder of its own: digestPersists in
// config.js). Then no saved state is read at start-up and nothing is ever written. The saver still runs, on the same
// interval, with a save that writes nothing: building the state to save is what lets sessions that left the window go
// from memory (stateNow's sweep), and that stays as it is.
export function createDigest({ emit, projectsDir, now = Date.now, isLive = () => false, read = readRecords,
  windowHours = DIGEST_WINDOW_HOURS, maxCards = DIGEST_MAX_CARDS, readDelayMs = DIGEST_READ_DELAY_MS,
  emitDebounceMs = DIGEST_EMIT_DEBOUNCE_MS, saveIntervalMs = DIGEST_SAVE_INTERVAL_MS, persist = true } = {}) {
  const keep = persist !== false;
  const hours = Number.isFinite(windowHours) && windowHours > 0 ? windowHours : DIGEST_WINDOW_HOURS;
  const windowMs = hours * 3600e3;
  const shown = Number.isInteger(maxCards) && maxCards >= 0 ? maxCards : DIGEST_MAX_CARDS;
  const readDelay = ms(readDelayMs, DIGEST_READ_DELAY_MS);
  const emitDelay = ms(emitDebounceMs, DIGEST_EMIT_DEBOUNCE_MS);
  const readFile = typeof read === 'function' ? read : readRecords;
  const root = typeof projectsDir === 'string' && projectsDir ? path.resolve(projectsDir) : null;
  let realRoot = null; // root with its symlinks resolved, once start() has looked: a hook may name either

  // id -> { id, path, readOffset, extractor, fresh, record, agents, ended, mtimeMs, timer, timerDelay, again, reading }
  //   extractor: the live one, or null until the next read builds it: from 0 when `fresh` or there is no
  //     record, else resumed from record.facts. readOffset is where the next read starts, either way.
  //   record: the SessionRecord last built, never changed once built (the saver may be writing it).
  //   again: null, or the delay of a hook heard while the session was being read.
  const sessions = new Map();
  const high = createQueue(); // ids queued by hooks
  const low = createQueue(); // ids queued by the catch-up scan, newest transcript first
  const timed = new Set(); // sessions with a read timer armed
  let pumping = false;
  let scanning = false;
  let loaded = false; // the saved state is in: until then queued reads wait
  let scanned = false;
  let stopped = false;
  let startPromise = null;
  let startedAt = 0;
  let catchUpMs = null;
  let errors = 0;
  let emitTimer = null;
  let waiters = [];
  let keepalive = null;

  const saver = createSaver({ save: keep ? saveDigestState : () => true, intervalMs: ms(saveIntervalMs, DIGEST_SAVE_INTERVAL_MS) });

  function fail(what, err) {
    errors++;
    note(`${what} failed: ${why(err)}`);
  }

  function live(id) {
    try {
      return Boolean(isLive(id));
    } catch {
      return false;
    }
  }

  // ---- sessions --------------------------------------------------------------------------------

  function newSession(id, file) {
    return { id, path: file, readOffset: 0, extractor: null, fresh: false, record: null, agents: null, ended: false,
      mtimeMs: 0, timer: null, timerDelay: 0, again: null, reading: false };
  }

  // The next read starts at 0 with a fresh extractor; the card stays until that read replaces it.
  function resetFresh(s) {
    s.extractor = null;
    s.fresh = true;
    s.readOffset = 0;
  }

  // After a failed read the live extractor may hold records it never committed: go back to the last record.
  function rollback(s) {
    s.extractor = null;
    s.readOffset = !s.fresh && s.record ? s.record.facts.offset : 0;
  }

  function extractorFor(s, fallbackTs) {
    if (!s.extractor) {
      s.extractor = createExtractor({ sessionId: s.id, saved: !s.fresh && s.record ? s.record.facts : undefined, now, fallbackTs });
    }
    return s.extractor;
  }

  // A top-level transcript, <root>/<project>/<name>.jsonl, under root or its real path, named by root;
  // null for anything else. String work only: it runs on the hook path.
  function transcriptFile(p) {
    if (root === null || typeof p !== 'string' || p.length > MAX_PATH || !path.isAbsolute(p)) return null;
    const abs = path.normalize(p);
    for (const base of realRoot && realRoot !== root ? [root, realRoot] : [root]) {
      const parts = path.relative(base, abs).split(path.sep);
      if (parts.length === 2 && parts[0] && parts[0] !== '..' && parts[1].length > EXT.length && parts[1].endsWith(EXT)) {
        return path.join(root, parts[0], parts[1]);
      }
    }
    return null;
  }

  function drop(s, reason) {
    sessions.delete(s.id);
    high.delete(s.id);
    low.delete(s.id);
    clearTimer(s);
    note(`dropped ${short(s.id)}: transcript ${reason}`);
    if (s.record) changed();
  }

  // Sessions whose last activity left the window, and that nothing is about to read, are let go.
  function sweep(cutoff) {
    for (const [id, s] of sessions) {
      if (s.reading || s.timer !== null || s.again !== null || high.has(id) || low.has(id)) continue;
      const last = s.record ? Math.max(s.record.facts.lastTurnTs, s.record.mtimeMs) : -Infinity;
      if (!(last >= cutoff)) sessions.delete(id);
    }
  }

  // The DigestState to save, built when the saver writes (at most once per interval), pruned to the window.
  function stateNow() {
    const t = now();
    sweep(t - windowMs);
    const entries = [];
    for (const s of sessions.values()) if (s.record) entries.push([s.id, s.record]);
    return pruneDigestState({ version: STATE_VERSION, sessions: Object.fromEntries(entries) }, { now: t, windowMs });
  }

  // ---- timers and the queue --------------------------------------------------------------------

  function clearTimer(s) {
    if (s.timer !== null) clearTimeout(s.timer);
    s.timer = null;
    timed.delete(s);
  }

  // A Stop re-arms the session's timer, so a burst is one read; a SessionEnd's read (delay 0) is not put off.
  function arm(s, delay) {
    if (s.timer !== null && s.timerDelay === 0) return;
    clearTimer(s);
    s.timerDelay = delay;
    s.timer = setTimeout(fire, delay, s);
    unref(s.timer);
    timed.add(s);
  }

  function fire(s) {
    s.timer = null;
    timed.delete(s);
    try {
      if (stopped || sessions.get(s.id) !== s) return;
      enqueue(s, high);
      pump();
    } catch (err) {
      fail('timer', err);
    } finally {
      checkIdle();
    }
  }

  function enqueue(s, queue) {
    if (s.reading) {
      s.again = 0;
    } else if (queue === high) {
      low.delete(s.id);
      high.add(s.id);
    } else if (!high.has(s.id)) {
      low.add(s.id);
    }
  }

  function next() {
    for (const queue of [high, low]) {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        const s = sessions.get(id);
        if (s && !s.reading) return s;
      }
    }
    return null;
  }

  // One read at a time; resolves when both queues are empty. Never rejects.
  async function pump() {
    if (pumping || !loaded || stopped) return;
    pumping = true;
    try {
      for (let s = next(); s && !stopped; s = next()) await readOne(s);
    } catch (err) {
      fail('queue', err);
    } finally {
      pumping = false;
    }
    if (scanned && catchUpMs === null && !stopped && high.size === 0 && low.size === 0) {
      catchUpMs = Math.round(performance.now() - startedAt);
      note(`caught up in ${catchUpMs}ms`);
    }
    checkIdle();
  }

  async function readOne(s) {
    s.reading = true;
    try {
      await readSession(s);
    } catch (err) {
      errors++;
      note(`read ${short(s.id)} failed: ${why(err)}`);
      rollback(s);
    } finally {
      s.reading = false;
    }
    const again = s.again;
    s.again = null;
    if (again === null || stopped || sessions.get(s.id) !== s) return;
    if (again <= 0) enqueue(s, high);
    else arm(s, again);
  }

  // ---- reading a session -----------------------------------------------------------------------

  async function readSession(s) {
    const t0 = performance.now();
    let st;
    try {
      st = await fs.promises.stat(s.path);
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return drop(s, 'gone');
      throw err;
    }
    if (!st.isFile()) return drop(s, 'not a file');
    let restarted = st.size < s.readOffset;
    if (restarted) resetFresh(s); // shrunk since the last read: its offset is stale
    let ex = extractorFor(s, st.mtimeMs);
    let from = s.readOffset;
    let res = await readFile(s.path, from, (rec, end) => ex.push(rec, end));
    if (res && res.shrunk) {
      // cut short or replaced while it was read: what was pushed may be the old file's, so start over
      restarted = true;
      resetFresh(s);
      ex = extractorFor(s, st.mtimeMs);
      from = 0;
      res = await readFile(s.path, 0, (rec, end) => ex.push(rec, end));
      if (res && res.shrunk) throw Object.assign(new Error('transcript keeps shrinking'), { code: 'ESHRUNK' });
    }
    if (!res || !isOffset(res.offset) || res.offset < from) throw Object.assign(new Error('bad read result'), { code: 'EBADREAD' });
    if (stopped) return rollback(s);
    s.readOffset = res.offset;
    ex.closeOpenTurn();
    const snap = ex.snapshot();
    const cutoff = now() - windowMs;
    const turnLog = snap.turnLog.filter((e) => e && Number.isFinite(e.endTs) && e.endTs >= cutoff);
    const facts = turnLog.length === snap.turnLog.length ? snap : { ...snap, turnLog };
    if (snap.turnLog.length - turnLog.length >= COMPACT_AFTER && snap.offset === s.readOffset) {
      // No turn is open, so these facts are all the extractor holds that matters: the same rebuild a restart does.
      s.extractor = createExtractor({ sessionId: s.id, saved: facts, now });
    }
    s.fresh = false;
    s.mtimeMs = st.mtimeMs;
    s.agents = agentFacts(s);
    s.record = { path: s.path, mtimeMs: s.mtimeMs, ended: s.ended === true, facts, agents: s.agents };
    changed();
    note(`read ${short(s.id)} ${s.readOffset - from}B ${Math.round(performance.now() - t0)}ms${restarted ? ' from 0 (shrunk)' : ''}`);
  }

  // Read again with each read: a running agent finishes, and the A<n> ids can change between passes.
  function agentFacts(s) {
    try {
      const agents = readAgentFacts(s.path.slice(0, -EXT.length), { ended: s.ended === true });
      if (agents && typeof agents === 'object' && !Array.isArray(agents)) return agents;
    } catch (err) {
      fail(`agents ${short(s.id)}`, err);
    }
    return s.agents && typeof s.agents === 'object' ? s.agents : noAgents();
  }

  function changed() {
    try {
      saver.request(stateNow);
    } catch (err) {
      fail('save', err);
    }
    scheduleEmit();
  }

  // The first change after an update starts the timer; the update it sends is the digest as it is then.
  function scheduleEmit() {
    if (emitTimer !== null || stopped) return;
    emitTimer = setTimeout(() => {
      emitTimer = null;
      try {
        if (!stopped && typeof emit === 'function') emit('claude.digest.update', get());
      } catch (err) {
        fail('update', err);
      } finally {
        checkIdle();
      }
    }, emitDelay);
    unref(emitTimer);
  }

  // ---- start-up --------------------------------------------------------------------------------

  // persist.js logs a parse error's message, which quotes the file around the bad token: a corrupt file
  // is caught here first and logged by name only. (This reads the file twice at start-up.)
  function savedStateReadable() {
    let text;
    try {
      text = fs.readFileSync(STATE_FILE, 'utf8');
    } catch (err) {
      if (!err || err.code !== 'ENOENT') note(`saved state unreadable (${why(err)}), starting empty`);
      return false;
    }
    try {
      JSON.parse(text);
      return true;
    } catch (err) {
      note(`saved state unreadable (${why(err)}), starting empty`);
      return false;
    }
  }

  function load() {
    if (!savedStateReadable()) return;
    const state = pruneDigestState(loadDigestState(), { now: now(), windowMs });
    let left = 0;
    for (const [id, rec] of Object.entries(state.sessions)) {
      const file = transcriptFile(rec.path);
      if (file === null || !isOffset(rec.facts.offset) || id.length > MAX_ID || isOwnSession(id)) { left++; continue; }
      const s = sessions.get(id);
      if (!s) {
        sessions.set(id, { ...newSession(id, file), readOffset: rec.facts.offset, record: rec, agents: rec.agents,
          ended: rec.ended, mtimeMs: rec.mtimeMs });
      } else if (s.record === null && s.extractor === null && !s.fresh && s.path === file) {
        // heard from a hook before start: its ended flag is newer, the saved facts still stand
        s.record = rec;
        s.readOffset = rec.facts.offset;
        s.agents = rec.agents;
        s.mtimeMs = rec.mtimeMs;
      }
    }
    if (left) note(`${left} saved session(s) left out: not under the transcripts folder, or malformed`);
  }

  // projectsDir/*/*.jsonl modified inside the window, not our own sessions, that grew or shrank since
  // their saved offset: queued at low priority, newest first. stat follows symlinks.
  async function scan() {
    if (root === null) return;
    const t0 = performance.now();
    const cutoff = now() - windowMs;
    let projects;
    try {
      projects = await fs.promises.readdir(root);
    } catch (err) {
      note(`catch-up: no transcripts folder (${why(err)})`);
      return;
    }
    const files = [];
    for (const dir of projects) {
      if (stopped) return;
      let names;
      try {
        names = await fs.promises.readdir(path.join(root, dir));
      } catch {
        continue; // a file, or unreadable
      }
      for (const name of names) if (name.length > EXT.length && name.endsWith(EXT)) files.push(path.join(root, dir, name));
    }
    const found = new Map();
    for (let i = 0; i < files.length; i += SCAN_BATCH) {
      if (stopped) return;
      const batch = files.slice(i, i + SCAN_BATCH);
      const stats = await Promise.all(batch.map((f) => fs.promises.stat(f).catch(() => null)));
      batch.forEach((file, j) => {
        const st = stats[j];
        if (!st || !st.isFile() || !(st.mtimeMs >= cutoff)) return;
        const id = path.basename(file, EXT);
        if (id.length > MAX_ID || isOwnSession(id)) return;
        const seen = found.get(id);
        if (!seen || st.mtimeMs > seen.mtimeMs) found.set(id, { id, file, mtimeMs: st.mtimeMs, size: st.size });
      });
    }
    const queued = [];
    for (const c of found.values()) {
      let s = sessions.get(c.id);
      if (s && (s.reading || s.timer !== null || high.has(c.id))) continue; // a hook has it
      if (s && s.path !== c.file) {
        s.path = c.file;
        resetFresh(s);
      } else if (c.size === (s ? s.readOffset : 0)) {
        continue;
      }
      if (!s) {
        s = newSession(c.id, c.file);
        sessions.set(c.id, s);
      }
      queued.push(c);
    }
    queued.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const c of queued) enqueue(sessions.get(c.id), low);
    note(`catch-up: ${queued.length} of ${files.length} transcripts to read (${Math.round(performance.now() - t0)}ms)`);
  }

  async function begin() {
    startedAt = performance.now();
    scanning = true;
    try {
      if (root !== null) realRoot = await fs.promises.realpath(root).then((p) => path.normalize(p), () => null);
      if (!keep) note('state kept in memory only');
      else if (!stopped) load();
    } catch (err) {
      fail('loading the saved state', err);
    }
    loaded = true;
    pump();
    try {
      if (!stopped) await scan();
    } catch (err) {
      fail('catch-up scan', err);
    }
    scanning = false;
    scanned = true;
    pump();
    checkIdle();
  }

  // ---- idle --------------------------------------------------------------------------------------

  function isIdle() {
    return !pumping && !scanning && timed.size === 0 && emitTimer === null
      && (!loaded || stopped || (high.size === 0 && low.size === 0));
  }

  function checkIdle() {
    if (waiters.length === 0 || !isIdle()) return;
    if (keepalive !== null) clearInterval(keepalive);
    keepalive = null;
    const done = waiters;
    waiters = [];
    for (const resolve of done) resolve();
  }

  // ---- the API ---------------------------------------------------------------------------------

  function get() {
    try {
      const entries = [];
      for (const s of sessions.values()) if (s.record) entries.push([s.id, s.record]);
      return buildDigest(Object.fromEntries(entries), { now: now(), windowHours: hours, maxCards: shown, isLive: live });
    } catch (err) {
      fail('digest', err);
      return emptyDigest(Date.now(), hours);
    }
  }

  return {
    // Stop and SessionEnd only, called after the hook's response is sent. No I/O: flags and a timer.
    onHook(event, payload) {
      try {
        if (stopped || (event !== 'Stop' && event !== 'SessionEnd')) return;
        if (!payload || typeof payload !== 'object') return;
        const id = payload.session_id;
        if (typeof id !== 'string' || !id || id.length > MAX_ID || isOwnSession(id)) return;
        let s = sessions.get(id);
        const given = payload.transcript_path;
        if (typeof given === 'string' && given) {
          const file = transcriptFile(given);
          if (file === null) return;
          if (!s) {
            s = newSession(id, file);
            sessions.set(id, s);
          } else if (s.path !== file && !s.reading) {
            s.path = file;
            resetFresh(s);
          }
        } else if (!s) {
          return; // no path given and none known
        }
        // a Stop after a SessionEnd is a resumed session
        s.ended = event === 'SessionEnd';
        const delay = event === 'SessionEnd' ? 0 : readDelay;
        if (s.reading) {
          s.again = s.again === null ? delay : Math.min(s.again, delay);
        } else {
          low.delete(id);
          arm(s, delay);
        }
      } catch {
        errors++; // never into the caller, and no logging on the hook path
      }
    },

    // Loads and prunes the saved state, then scans for transcripts to catch up on; resolves once they are
    // queued (the reads go on in the background). Never rejects.
    start() {
      if (!startPromise) startPromise = begin();
      return startPromise;
    },

    // Writes what is pending, then stops: later hooks are ignored and no timer is left.
    stop() {
      if (stopped) return;
      stopped = true;
      for (const s of timed) {
        clearTimeout(s.timer);
        s.timer = null;
      }
      timed.clear();
      high.clear();
      low.clear();
      if (emitTimer !== null) clearTimeout(emitTimer);
      emitTimer = null;
      try {
        saver.flush();
      } catch (err) {
        fail('save', err);
      }
      saver.stop();
      checkIdle();
    },

    get,

    status() {
      try {
        const cutoff = now() - windowMs;
        let count = 0, cards = 0, skipped = 0;
        for (const s of sessions.values()) {
          if (!s.record) continue;
          const f = s.record.facts;
          if (!(Math.max(f.lastTurnTs, s.record.mtimeMs) >= cutoff)) continue;
          count++;
          if (Number.isFinite(f.skipped)) skipped += f.skipped;
          if (f.hasHumanPrompt === true && f.lastTurnTs >= cutoff) cards++;
        }
        return { sessions: count, cards: Math.min(cards, shown), skipped, queued: high.size + low.size, catchUpMs, errors };
      } catch {
        return { sessions: 0, cards: 0, skipped: 0, queued: high.size + low.size, catchUpMs, errors };
      }
    },

    // Resolves when no read timer, queued session, read, scan or pending update remains. It does not wait
    // for the throttled save (stop() writes that). While anyone waits, a ref'd timer keeps the process up.
    whenIdle() {
      if (isIdle()) return Promise.resolve();
      return new Promise((resolve) => {
        waiters.push(resolve);
        if (keepalive === null) keepalive = setInterval(() => {}, KEEPALIVE_MS);
      });
    },
  };
}
