// The Digest list's input (#/digest) and its selection, decided here so main.js only applies them
// (the sessions screen's first card has its own, in screens/session-list.js).
// Pure: each takes the store's state and returns what to do; none of them throws on a missing,
// null or wrong-typed digest or selection.
//
// The selection (state.digestSel) is a session id, or null for the first card. Every index here is
// into digestCards(state), the usable, de-duplicated cards the screen draws, never into
// state.digest.cards: selectedIndex and moveSelection (screens/digest.js) count in that list.

import { digestCards, selectedIndex, moveSelection } from './screens/digest.js';

function isObject(v) { return v !== null && typeof v === 'object'; }

function selOf(state) {
  return isObject(state) && typeof state.digestSel === 'string' ? state.digestSel : null;
}

// The store fields for a digest that just arrived: the digest (null for anything that is not one),
// and the selection kept on its session while that card is still drawn, else the first card's
// (null with no cards). On the sessions screen (session-list.js) a digest with no cards takes the
// first card away, so a cursor on it (onDigestCard) moves to the first session.
export function withDigest(state, digest) {
  var d = isObject(digest) ? digest : null;
  var cards = digestCards({ digest: d });
  var sel = selOf(state);
  var out = { digest: d, digestSel: cards.length ? cards[0].sessionId : null };
  for (var i = 0; i < cards.length; i++) {
    if (cards[i].sessionId === sel) out.digestSel = sel;
  }
  if (!cards.length && isObject(state) && state.onDigestCard === true) {
    out.onDigestCard = false;
    out.selectedIndex = 0;
  }
  return out;
}

// The knob: one card per step, stopping at either end.
export function digestDial(state, dir) {
  return { digestSel: moveSelection(digestCards(state), selOf(state), dir) };
}

// The press: the open card's session id, or null with no cards.
export function digestPress(state) {
  var cards = digestCards(state);
  if (!cards.length) return null;
  return cards[selectedIndex(cards, selOf(state))].sessionId;
}

// A tap on a row (data-action="digest-row"): another row becomes the selection, the open card is
// pressed, and a card the digest no longer has does nothing.
export function digestTap(state, id) {
  if (typeof id !== 'string') return null;
  var cards = digestCards(state);
  for (var i = 0; i < cards.length; i++) {
    if (cards[i].sessionId !== id) continue;
    return i === selectedIndex(cards, selOf(state)) ? { press: id } : { select: id };
  }
  return null;
}
