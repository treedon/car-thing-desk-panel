// The inbox: one card per session, for the latest turn it finished.
//
// A permission or a question blocks a session until it is answered; a finished
// turn does not, but it is still something the owner wants to know about. So a
// finished turn becomes a card here, tagged by turn-tag.js as ASKING (it ended
// on a question), UPDATE (anything else) or ERROR (the turn failed).
//
// Loudness is owned here, not by the panel. ASKING and ERROR cards are loud for
// ten minutes from when they were posted: loud cards wake the screen, pulse and
// jump to the queue. A card that stayed loud forever would make "loud" mean
// nothing (about four turns in ten end on a question), so tick() flips it quiet
// and re-sends the card with `loud: false`. The panel never compares its own
// clock with the Mac's. Going quiet is the one change that must not chime, so
// onLoud fires only for a freshly posted loud card.
//
// There is no timer in this module. The caller runs tick() on an interval and
// passes `now`, so a test moves a fake clock instead of waiting.
//
// Cards outlive the daemon (the caller supplies read/write, backed by
// persist.js) and carry their own name and text, because the session store
// forgets a session the moment it ends.

import { excerptOf } from './turn-tag.js';
import { log } from './log.js';

export const LOUD_MS = 10 * 60_000;
// How long a finished turn's UPDATE card is kept after its session ended.
export const ENDED_UPDATE_TTL_MS = 2 * 60 * 60_000;
// Which digest belongs to which card. A digest names the turn it summarises by
// the time that turn ended, and the card by the time it stopped; the two are
// the same moment, give or take how long the turn took to wind down. So a
// digest may end up to SUMMARY_MATCH_MS before the card's stop (a digest of a
// turn that was already winding down when the Stop fired) and up to
// SUMMARY_LATE_MS after it (clock skew between the hook and the digest; a
// summary cannot be written for a turn that has not ended). 120 s is wider than
// the gap between two quick turns of one session, though, so the window alone
// would let turn N's digest land on turn N+1's card. Each card therefore also
// carries the stop time of the session's turn before it (prevStoppedTs), and a
// digest must have ended after that. The inbox remembers each session's recent
// stop times on its own (noteStop), not through cards: a card that was cleared
// (the owner typed), or a turn that posted no card (background work held it
// back), still ended a turn that a late digest must not be taken for the next.
export const SUMMARY_MATCH_MS = 120_000;
export const SUMMARY_LATE_MS = 15_000;

const TEXT_MAX = 8000;
// How many recent stop times are kept per session. A new card needs the latest
// one before its own, so a couple are enough; the rest is slack for a turn or
// two that posted nothing.
const STOPS_KEPT = 4;
const TAGS = new Set(['asking', 'update', 'error']);

// What leaves the module is a copy, so a card already handed to a receiver is
// never changed behind its back when tick() later flips the stored one.
const view = (card) => ({ ...card });

// A card read back from disk. Anything that is not recognisably a card is
// dropped; a card whose loud window has passed comes back quiet.
function restoreCard(raw, at) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.sessionId !== 'string' || typeof raw.id !== 'string') return null;
  return { endedTs: null, summary: null, prevStoppedTs: null, ...raw, loud: raw.loud === true && raw.loudUntil > at };
}

// Where the cards live. Live cards are the owner's message text and outlive the
// daemon, so they go to disk, owner-only. Demo cards (mock mode) are made up and
// must never reach that file: mock mode shares the state dir with live mode, and
// the next live start would restore them onto the owner's real panel. So in mock
// mode the inbox gets no storage at all, and the demo cards live in memory only.
// Pure on purpose: index.js is not importable from a test.
export function inboxStorage({ mock, readState, writeState }) {
  if (mock) return {};
  return {
    read: () => readState('inbox'),
    write: (v) => writeState('inbox', v, { mode: 0o600 }),
  };
}

export function createInbox({
  emit,
  now = Date.now,
  read = () => null,
  write = () => {},
  onLoud = () => {},
}) {
  const cards = new Map();   // sessionId -> card
  // sessionId -> that session's recent stop times, ascending. Kept in memory
  // only (restored cards seed it) and let be when a session ends: it is bounded
  // by the sessions seen, a few numbers each, and a session resumed under the
  // same id still has its history.
  const stops = new Map();

  function noteStop(sessionId, stoppedTs) {
    if (!Number.isFinite(stoppedTs)) return;
    const list = stops.get(sessionId) ?? [];
    if (list.includes(stoppedTs)) return;
    list.push(stoppedTs);
    list.sort((a, b) => a - b);
    stops.set(sessionId, list.slice(-STOPS_KEPT));
  }

  // The latest stop of the session that is earlier than `stoppedTs`, or null.
  function stopBefore(sessionId, stoppedTs) {
    let found = null;
    for (const ts of stops.get(sessionId) ?? []) if (ts < stoppedTs) found = ts;
    return found;
  }

  const saved = read();
  if (Array.isArray(saved?.cards)) {
    for (const raw of saved.cards) {
      const card = restoreCard(raw, now());
      if (card) {
        cards.set(card.sessionId, card);
        noteStop(card.sessionId, card.stoppedTs);
      }
    }
  }

  const list = () => [...cards.values()].map(view);
  const persist = () => write({ cards: list() });

  // Removes and announces; the caller persists, so a batch writes once.
  function drop(card, reason) {
    cards.delete(card.sessionId);
    emit('claude.card.cleared', { id: card.id, sessionId: card.sessionId, reason });
  }

  // A session ended: nothing is left to switch to or reply to, so a card that
  // asks for something goes. An UPDATE is still worth reading, so it stays and
  // its clock starts. Returns whether anything changed.
  function end(card) {
    if (card.tag !== 'update') {
      drop(card, 'ended');
      return true;
    }
    if (Number.isFinite(card.endedTs)) return false;
    card.endedTs = now();
    return true;
  }

  function post({ sessionId, sessionName, host, tag, text, intent, stoppedTs }) {
    const at = now();
    const full = String(text ?? '');
    const kind = TAGS.has(tag) ? tag : 'update';
    const loud = kind !== 'update';
    const stopped = Number.isFinite(stoppedTs) ? stoppedTs : at;
    const card = {
      kind: 'card',
      id: `card:${sessionId}:${stopped}`,
      sessionId,
      sessionName: sessionName || 'session',
      host: host ?? null,
      tag: kind,
      text: full.length > TEXT_MAX ? `${full.slice(0, TEXT_MAX)}…` : full,
      // From the whole message: the closing paragraph is what the card shows,
      // and a long message's closing paragraph is past the clip.
      excerpt: excerptOf(full),
      intent: intent ?? '',
      createdTs: at,
      stoppedTs: stopped,
      loud,
      loudUntil: loud ? at + LOUD_MS : 0,
      endedTs: null,
      summary: null,
      // When the session's turn before this one stopped (whether or not it
      // left a card), so a digest of that earlier turn cannot land here; null
      // when the session has no earlier turn on record.
      prevStoppedTs: stopBefore(sessionId, stopped),
    };
    noteStop(sessionId, stopped);
    // Replacing announces only the new card: the panel drops the older one of
    // that session itself, and a cleared event first would move its cursor.
    cards.delete(sessionId);
    cards.set(sessionId, card);
    emit('claude.card.posted', view(card));
    if (loud) {
      try {
        onLoud(view(card));
      } catch (err) {
        log('IB', `loud hook failed for ${String(sessionId).slice(0, 8)}: ${err.message}`);
      }
    }
    persist();
    return view(card);
  }

  function clear(sessionId, reason) {
    const card = cards.get(sessionId);
    if (!card) return false;
    drop(card, reason);
    persist();
    return true;
  }

  function clearById(id, reason) {
    for (const card of cards.values()) {
      if (card.id === id) return clear(card.sessionId, reason);
    }
    return false;
  }

  function onSessionEnd(sessionId) {
    const card = cards.get(sessionId);
    if (card && end(card)) persist();
  }

  // For after a restart: a card whose session is not among the live ones will
  // not get a SessionEnd, so it is treated as ended now.
  function retireMissing(liveIds) {
    let changed = false;
    for (const card of [...cards.values()]) {
      if (!liveIds.has(card.sessionId) && end(card)) changed = true;
    }
    if (changed) persist();
  }

  // Loud runs out and ended UPDATE cards expire. A card going quiet is sent
  // again with `loud: false` and never calls onLoud.
  function tick() {
    const at = now();
    let changed = false;
    for (const card of [...cards.values()]) {
      if (Number.isFinite(card.endedTs) && at >= card.endedTs + ENDED_UPDATE_TTL_MS) {
        drop(card, 'expired');
        changed = true;
      } else if (card.loud && at >= card.loudUntil) {
        card.loud = false;
        emit('claude.card.posted', view(card));
        changed = true;
      }
    }
    if (changed) persist();
  }

  // A model-written digest of a turn. It lands only on the card for that same
  // turn (see SUMMARY_MATCH_MS for what "same" means), and it changes what the card says, nothing else: no chime, no jump,
  // no new place in the order. Returns whether it landed.
  function attachSummary(sessionId, turnEndTs, summary) {
    const card = cards.get(sessionId);
    if (!card || !Number.isFinite(turnEndTs)) return false;
    const prev = Number.isFinite(card.prevStoppedTs) ? card.prevStoppedTs : -Infinity;
    const earliest = Math.max(prev, card.stoppedTs - SUMMARY_MATCH_MS);
    if (!(turnEndTs > earliest) || turnEndTs > card.stoppedTs + SUMMARY_LATE_MS) return false;
    if (!summary || typeof summary.headline !== 'string' || !summary.headline) return false;
    card.summary = {
      headline: summary.headline,
      bullets: Array.isArray(summary.bullets) ? summary.bullets.map(String) : [],
    };
    emit('claude.card.posted', view(card));
    persist();
    return true;
  }

  return { post, noteStop, clear, clearById, onSessionEnd, retireMissing, tick, list, attachSummary };
}
