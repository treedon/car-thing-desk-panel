// The digest's persisted state: .state/digest.json, owner-only (0600) because it holds prompt
// excerpts. loadDigestState checks the file's shape and keeps only well-formed records, since a file
// can be hand-edited, cut short by a crash, or written by an older version, and a wrong-typed field
// would otherwise make the extractor throw on every stop summary and freeze that session. Every
// function here is linear in the state's size; none reads or logs content, only counts.
import { readState, writeState } from '../persist.js';
import { log } from '../log.js';

const VERSION = 1;
const STATE_NAME = 'digest';
const empty = () => ({ version: VERSION, sessions: {} });

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// The fields the extractor's restore, the pruner and the card builder rely on. The elements of
// the arrays are not checked; the pruner skips a turn-log entry that is not one.
function isSessionRecord(rec) {
  if (!isObject(rec) || typeof rec.path !== 'string' || !Number.isFinite(rec.mtimeMs)
    || typeof rec.ended !== 'boolean' || !isObject(rec.agents)) return false;
  const f = rec.facts;
  return isObject(f)
    && Array.isArray(f.turns) && Array.isArray(f.turnLog) && Array.isArray(f.seenFiles) && Array.isArray(f.prNumbers)
    && isObject(f.totals) && isObject(f.next)
    && Number.isFinite(f.offset) && Number.isFinite(f.lastTurnTs);
}

// Missing, corrupt or another version is "nothing saved yet". Well-formed records come back as
// parsed (the same bytes that were saved); the rest are dropped. fromEntries, not assignment: a
// session id of "__proto__" must stay a plain key.
export function loadDigestState() {
  const saved = readState(STATE_NAME, null);
  if (!isObject(saved) || saved.version !== VERSION || !isObject(saved.sessions)) return empty();
  const entries = Object.entries(saved.sessions);
  const kept = entries.filter(([, rec]) => isSessionRecord(rec));
  if (kept.length < entries.length) log('DG', `dropped ${entries.length - kept.length} malformed session record(s) from the saved state`);
  return { version: VERSION, sessions: Object.fromEntries(kept) };
}

export function saveDigestState(state) {
  return writeState(STATE_NAME, state, { mode: 0o600 });
}

// A new state without the sessions whose last activity, max(last turn, transcript mtime), is older
// than the window, and with each remaining turn log cut to the window. It does not change `state`:
// the sessions and facts it keeps are new objects, but their other fields (turns, agents, ...) are
// shared with the input, so treat the result as read-only or copy it.
export function pruneDigestState(state, { now, windowMs }) {
  const cutoff = now - windowMs;
  const kept = [];
  for (const [id, rec] of Object.entries(state.sessions)) {
    if (Math.max(rec.facts.lastTurnTs, rec.mtimeMs) < cutoff) continue;
    const turnLog = rec.facts.turnLog.filter((e) => e && typeof e.endTs === 'number' && e.endTs >= cutoff);
    kept.push([id, { ...rec, facts: { ...rec.facts, turnLog } }]);
  }
  return { ...state, sessions: Object.fromEntries(kept) };
}

// Writes the state at most once every intervalMs. request(getState) saves at once when the last
// save was long enough ago; otherwise it arms one trailing timer for the rest of the interval, and
// getState is called when a save happens, so the file gets the state as it is then (the last
// request's getter wins). flush() saves what is pending now, ignoring the interval, and does nothing
// when nothing is. stop() clears the timer, drops what is pending and ignores later requests, so call
// flush() first when the state should survive. A save that returns false (or throws, or whose
// getState throws) is logged and stays pending: the next request or flush tries again. The timer is
// unref'd, so it never keeps the process alive.
export function createSaver({ save, intervalMs = 10_000, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null;
  let pending = null; // the getter of the state not yet saved
  let lastAt = -Infinity; // when the last save was tried
  let stopped = false;

  function clear() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function attempt() {
    clear();
    const getState = pending;
    if (!getState) return;
    pending = null;
    lastAt = now();
    let ok = false;
    try {
      ok = save(getState()) !== false;
    } catch (err) {
      log('DG', `digest save failed: ${err.message}`);
    }
    if (!ok && !pending) pending = getState;
  }

  return {
    request(getState) {
      if (stopped) return;
      pending = getState;
      const wait = intervalMs - (now() - lastAt);
      if (wait <= 0) attempt();
      else if (timer === null) {
        timer = setTimer(() => { timer = null; attempt(); }, Math.min(wait, intervalMs));
        if (timer && typeof timer.unref === 'function') timer.unref();
      }
    },
    flush() {
      if (!stopped) attempt();
    },
    stop() {
      stopped = true;
      clear();
      pending = null;
    },
  };
}
