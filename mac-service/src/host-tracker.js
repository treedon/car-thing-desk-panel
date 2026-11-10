// Finds which app hosts each session ('vscode' | 'terminal') from its process
// ancestry, without ever blocking the service: detect() is async, a session has
// at most one lookup in flight, a found host is kept, and a session that stays
// unknown (no registry pid, an exotic host) is given up on after maxTries.
export function createHostTracker({ store, lookup, detect, retryMs = 30_000, maxTries = 5, now = Date.now }) {
  const tries = new Map();     // session id -> {count, last}
  const inFlight = new Set();

  async function refresh(id) {
    const raw = store.raw(id);
    if (!raw || (raw.host && raw.host !== 'unknown') || inFlight.has(id)) return;
    const t = tries.get(id) || { count: 0, last: -Infinity };
    if (t.count >= maxTries || now() - t.last < retryMs) return;
    tries.set(id, { count: t.count + 1, last: now() });
    const rec = lookup(id);
    if (!rec || !rec.pid) return;
    inFlight.add(id);
    try {
      const host = await detect(rec.pid);
      if (host !== 'unknown' && store.raw(id)) store.upsert(id, { host });
    } catch {} finally {
      inFlight.delete(id);
    }
  }

  return { refresh, forget: (id) => tries.delete(id) };
}
