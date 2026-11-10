// What a press on one of the session view's action rows does, and what each
// answer from the service says. Pure: main.js sends the request and shows the
// toast these decide, so none of it needs a socket or a browser to test.
//
// A background session (a `claude --bg` job) gets two more rows than any other,
// on the Mac and on the NucBox alike (the NucBox's sessions carry machine):
//   - the open row moves it into a VS Code tab on its own machine
//     (claude.session.handoff) instead of just raising a window, and while it
//     waits for the turn to end it reads "OPENS IN VS CODE WHEN DONE" and a
//     press cancels;
//   - OPEN NOW (only while waiting) cuts the turn short and opens it at once;
//   - STOP ends the session, on a second press within STOP_ARM_MS of the first
//     (stopArmedFor and stopArmedUntil in the store).
// Only the words differ by machine: where a session opens, and what to do when
// the NucBox has no desktop to open it on.

// The open row hands a session off, rather than raising a window, when it is a
// background session, on either machine.
export function movesToVsCode(d) {
  return !!(d && d.background);
}

var REQUEST = {
  'open-mac': 'claude.session.handoff',
  'handoff-cancel': 'claude.session.handoff.cancel',
  'handoff-now': 'claude.session.handoff.now',
  'stop-session': 'claude.session.stop',
};

// How long a first press on STOP stays armed: the panel's other destructive
// arms last the same (ARM_MS and STOP_ARM_MS in main.js).
export var STOP_ARM_MS = 4000;

// A press on row `action` of session `d` (its detail, or undefined before it
// has loaded), with `armedFor` the id STOP was last pressed on, `armedUntil` the
// time (ms) that arm runs out, and `nowMs` the time of this press.
//   method   — the request to send with { id }, or null
//   focus    — raise the session's window the old way
//   toast    — what to say now (an answer to a request says its own, later)
//   arm      — the new stopArmedFor: only a press on STOP that did not stop sets it
//   armUntil — the new stopArmedUntil: when that arm runs out, null with no arm
//   cursor   — a row index to move the dial to, or null to leave it
export function sessionRowPlan(d, action, armedFor, armedUntil, nowMs) {
  var plan = { method: null, focus: false, toast: null, arm: null, armUntil: null, cursor: null };
  var id = d && d.id;
  if (action === 'open-mac') {
    if (!movesToVsCode(d)) {
      plan.focus = true;
      plan.toast = d && d.machine ? 'OPENING ON THE NUCBOX' : 'OPENING ON THE MAC';
    } else if (d.handoff === 'moving') {
      // Already on its way; a second request would only race the first.
      plan.toast = 'OPENING IN VS CODE';
    } else {
      plan.method = REQUEST[action];
    }
  } else if (action === 'handoff-cancel') {
    plan.method = REQUEST[action];
  } else if (action === 'handoff-now') {
    plan.method = REQUEST[action];
    // The OPEN NOW row goes as soon as the move starts, and the row that takes
    // its place isn't the one it was pressed for. The open row is the one that
    // says what is happening.
    plan.cursor = 0;
  } else if (action === 'stop-session') {
    // Only an arm that is still standing confirms. One that ran out (the tick
    // clears it, but a press can land first) is no more than a first press.
    var standing = typeof armedUntil === 'number' && nowMs <= armedUntil;
    if (id && armedFor === id && standing) {
      plan.method = REQUEST[action];
    } else if (id) {
      plan.arm = id;
      plan.armUntil = nowMs + STOP_ARM_MS;
    }
  }
  return plan;
}

// SWITCH on a queue card: bring the card's session forward on its own machine,
// a NucBox card's on the NucBox as a Mac card's on the Mac (claude.session.focus
// follows the session there). The NucBox's service decides what it may raise:
// only a session VS Code started, never a background one.
//   focus — raise the card's session
//   toast — what to say now; the answer is not waited for
export function switchPlan(card) {
  var machine = card && card.machine;
  return { focus: true, toast: 'OPENING ON THE ' + (machine ? String(machine).toUpperCase() : 'MAC') };
}

var OK = {
  opened: 'OPENING IN VS CODE',
  waiting: 'OPENS WHEN DONE',
  raised: 'OPENING ON THE MAC',
  stopped: 'STOPPED',
  cancelled: 'CANCELLED',
};

var FAILED = {
  'claude.session.stop': "COULDN'T STOP IT",
  'claude.session.handoff.cancel': "COULDN'T CANCEL IT",
};

// The two requests that move a session into VS Code.
function isHandoff(method) {
  return method === 'claude.session.handoff' || method === 'claude.session.handoff.now';
}

// The words for a request's answer ({ result, reason? }). A missing or
// unrecognised result is a failure: nothing says it worked. An open that failed
// with 'open-failed' is the one failure that did something: the agent was
// stopped first, and only VS Code would not open. 'no-desktop' and 'not-set-up'
// are the NucBox's refusals before it stops anything: nobody is logged on there
// to open VS Code, or its helper task is missing. A STOP on a session the
// service no longer knows is a session that is already gone.
export function requestToast(method, res) {
  var result = res && res.result;
  if (typeof result === 'string' && OK.hasOwnProperty(result)) return OK[result];
  var reason = res && res.reason;
  if (isHandoff(method)) {
    if (reason === 'open-failed') return 'STOPPED · OPEN IT IN VS CODE';
    if (reason === 'no-desktop') return 'LOG IN ON THE NUCBOX FIRST';
    if (reason === 'not-set-up') return 'NOT SET UP YET';
  }
  if (method === 'claude.session.stop' && reason === 'unknown-session') return 'ALREADY STOPPED';
  return FAILED[method] || "COULDN'T OPEN IT";
}

// The request itself was rejected: the socket is down or the machine is gone.
export function rejectedToast() {
  return 'NOT ANSWERING';
}

// What a held ask's resolution says. 'unavailable' is a background ask the
// owner didn't answer in time: Claude was told no, with a reason, and will ask
// again later — said wherever the owner is, since the card has just gone from
// the queue. Any other resolution is said only on the ask's own screen (what
// onResolved always did) and not at all elsewhere.
export function resolutionToast(resolution, onIt) {
  if (resolution === 'unavailable') return 'CLAUDE WILL ASK LATER';
  // A background ask whose agent was stopped while it was held: it is simply gone, and nothing is
  // waiting in a terminal, so there is nothing to say.
  if (resolution === 'abandoned') return null;
  return onIt ? String(resolution).toUpperCase() : null;
}
