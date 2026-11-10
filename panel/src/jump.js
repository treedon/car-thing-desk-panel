// When a loud item may pull the screen to the queue, the second after it does
// where a press is swallowed, and when the queue hands the screen back to the
// session grid. Pure functions over what main.js already knows; the clock is
// injected so none of it needs a browser.
//
// A loud card and a permission jump to the queue from any screen (held
// questions and plans open their own screen instead). The jump is the only
// thing on this device that moves the screen under the owner's hand, so it
// leaves them alone when they are in the middle of something or have just
// touched the panel, and it swallows the next second of presses so one meant
// for the screen they were on cannot ALLOW, pick an option, SWITCH or CLEAR.

import { isCard, isLoud, loudCount, orderQueue } from './inbox.js';

export var JUMP_QUIET_MS = 10000;        // no jump within this long of any input
export var INPUT_GUARD_MS = 1000;        // presses swallowed this long after a jump
export var QUEUE_IDLE_EXIT_MS = 60000;   // the queue hands back after this long untouched

// The screens that are the owner's hands-on work: recording or reviewing a
// spoken reply, a held question/plan or a permission on its own screen, and
// choosing the machine and project of a new session.
var BUSY_ROUTES = { dictate: true, prompt: true, ask: true, new: true };

// Whether a loud item may jump to the queue right now. ctx = { routeName,
// msSinceInput, queueAnswering, homeAdjusting }. A missing msSinceInput is
// "unknown", and unknown is not "long ago".
export function jumpNow(ctx) {
  if (BUSY_ROUTES[ctx.routeName]) return false;
  if (ctx.queueAnswering || ctx.homeAdjusting) return false;
  return ctx.msSinceInput >= JUMP_QUIET_MS;
}

// The item a jump goes to: the first loud one in queue order, which is the most
// urgent. Permissions, questions and plans come first in the order they arrived,
// then ASKING and ERROR cards, oldest first. It is worked out from the list each
// time it is needed, never remembered, so an item that clears cannot orphan an
// older one that is still waiting on the owner. Null when nothing is loud.
export function firstLoud(asks) {
  var ordered = orderQueue(asks);
  for (var i = 0; i < ordered.length; i++) if (isLoud(ordered[i])) return ordered[i];
  return null;
}

// What to do with a jump that had to wait, once a second. "A jump is waiting"
// is a flag, not an item: when the owner is free it goes to whatever is the
// most urgent loud item now. ctx is jumpNow's plus { waiting, asks, heroId }
// (heroId is the id of the queue's hero). Returns { action, id }:
//   'drop'  nothing to do: no jump waiting, nothing loud is left, or the owner
//           is already on the queue looking at the most urgent item
//   'wait'  the owner is not free yet
//   'go'    jump to id
export function pendingJumpStep(ctx) {
  var target = ctx.waiting ? firstLoud(ctx.asks) : null;
  if (!target) return { action: 'drop', id: null };
  if (ctx.routeName === 'queue' && ctx.heroId === target.id) return { action: 'drop', id: null };
  return { action: jumpNow(ctx) ? 'go' : 'wait', id: target.id };
}

// Whether answering from the queue has left nothing a second press could decide:
// no permission, question or prompt, and no loud card. The owner's second press
// of a double press then lands on an empty queue, or on a quiet card they never
// meant to act on, so main.js swallows the next second of presses (the same
// guard a jump arms) rather than let it reach whatever is under the hand.
export function queueSettled(asks) {
  return loudCount(asks) === 0;
}

// The presses a jump could turn into the wrong decision: dial press (ALLOW, an
// option, SWITCH), the presets (including 4: DENY, CLEAR), deny and a tap on a
// button. Turning the dial and Back stay live so the owner can always back out.
var GUARDED = { select: true, preset: true, deny: true, tap: true };

export function createInputGuard(now) {
  var armedAt = null;
  return {
    arm: function () { armedAt = now(); },
    blocks: function (action) {
      if (armedAt === null || !GUARDED[action]) return false;
      return now() - armedAt < INPUT_GUARD_MS;
    },
  };
}

// The guard behind the screen's sleep gate. The sleep gate goes first: it is
// what wakes a dark screen and swallows the press that did it, and that press
// must stay swallowed; it also needs to see a guarded press, which still
// touched the panel. Only a press the sleep gate let through is the guard's.
export function guardGate(guard, inner) {
  return function (action, source) {
    var allowed = inner(action, source);
    if (allowed === false) return false;
    if (guard.blocks(action)) return false;
    return allowed;
  };
}

// Whether the queue should hand the screen back to the session list: it is on
// screen, nothing on it is loud (no permission, question, plan or loud card;
// quiet cards do not count), no answer is held for undo or being typed, and
// the panel has gone a minute without input. Reading quiet cards with the dial
// is input, so it keeps resetting the minute.
export function queueIdleExitDue(ctx) {
  if (ctx.routeName !== 'queue' || ctx.loud !== 0 || ctx.inflight) return false;
  return ctx.msSinceInput >= QUEUE_IDLE_EXIT_MS;
}

// Where the dial press on the resting screen goes: to the queue when something
// is loud (that is what the screen is saying), otherwise to the session list. A
// quiet card sits in the queue without calling for the owner.
export function ambientPressTarget(asks) {
  return loudCount(asks) > 0 ? '#/queue' : '#/list';
}

// Where the owner goes once a held question, plan or permission is dealt with
// off the queue. Only something left to decide counts as "next": a permission,
// question or plan that has not expired. A card never does (it is read from the
// queue, not decided), and an expired notice waits on the terminal, so with
// nothing else the owner returns to where they were. Answering from the queue
// itself stays on the queue (the hero promotes in place).
//   { hash, queueIndex }  queueIndex is the cursor to set before going, or null
export function nextAskStep(asks, returnTo) {
  if (returnTo === '#/queue') return { hash: returnTo, queueIndex: null };
  for (var i = 0; i < asks.length; i++) {
    var a = asks[i];
    if (isCard(a) || a.expired) continue;
    // a question or plan is answered on the queue, not on the permission screen
    if (a.kind === 'question' || a.kind === 'prompt') return { hash: '#/queue', queueIndex: i };
    return { hash: '#/ask/' + a.id, queueIndex: null };
  }
  return { hash: returnTo, queueIndex: null };
}

// Whether the queue's hero changed while the owner was looking at it, because
// something was posted, cleared, reconciled or aged out underneath them. A
// press meant for the old hero then lands on the new one (a CLEAR on an unseen
// ASKING card, an ALLOW where SWITCH was meant), so main.js arms the input
// guard. Off the queue nothing is under the owner's hand.
export function heroChanged(beforeId, afterId, routeName) {
  return routeName === 'queue' && beforeId !== afterId;
}

// The ids of a list of asks, as a lookup.
export function askIdSet(asks) {
  var ids = {};
  for (var i = 0; i < asks.length; i++) ids[asks[i].id] = true;
  return ids;
}

// Whether a (re)connect's sync should pull the owner from the session list to
// the queue: the daemon's list holds a loud item this panel had not seen before
// (seen = ids it held when the link went down). A loud card the owner already
// saw and backed out of is not news after the link comes back. A first
// connection has seen nothing, so work waiting lands on the queue as it should.
export function reconnectJumpDue(listed, seen, routeName) {
  if (routeName !== 'list') return false;
  for (var i = 0; i < listed.length; i++) {
    if (isLoud(listed[i]) && !seen[listed[i].id]) return true;
  }
  return false;
}
