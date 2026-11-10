// When the screen should be lit. Pure: no DOM and no timers. The caller feeds
// it what it sees (the Mac's display state, the link to the Mac service, the
// count of asks waiting, knob input) and reads isOn() on a tick.
//
// The rules, in the order isOn() applies them:
//   0. A focus timer running: lit, Mac or no Mac (it is a timer on the desk).
//      One that has just finished stays lit for awakeMs, until dismissed.
//   1. Link down for linkGraceMs or more: lit only within awakeMs of the last
//      knob input. Asks are ignored, since no answer can reach a Mac we can't
//      hear, and the store keeps asks across a lost link.
//   2. Mac active (display on, not sleeping, link up or down for less than the
//      grace period): lit. The screen just follows the Mac.
//   3. Otherwise: lit while an ask is waiting, or within awakeMs of the later
//      of the last knob input and the moment the last ask resolved. An ask
//      counts as resolved here only if it resolved while the link was up (or
//      down less than the grace) and the Mac was dark or asleep, and a Mac
//      that wakes forgets earlier resolutions.
//
// At boot nothing is known: the Mac counts as active and the link as down from
// creation, so a Mac that never answers leaves the screen lit for at most the
// grace period.
export function createScreenPower(opts) {
  opts = opts || {};
  var now = opts.now || function () { return Date.now(); };
  var awakeMs = opts.awakeMs === undefined ? 600000 : opts.awakeMs;
  var linkGraceMs = opts.linkGraceMs === undefined ? 120000 : opts.linkGraceMs;
  var swallowMs = opts.swallowMs === undefined ? 500 : opts.swallowMs;

  var macDisplayOn = true;
  var macSleeping = false;
  var linkDownSince = now(); // null while the link is up
  var waiting = 0;
  var lastKnob = -Infinity;
  var lastResolved = -Infinity;
  var knobWokeAt = -Infinity; // when a knob input last found the screen dark
  var focusRunning = false;
  var focusDoneAt = null;     // when a finished focus timer was first seen

  function linkLost(t) {
    return linkDownSince !== null && t - linkDownSince >= linkGraceMs;
  }

  // The Mac is awake and its display is on, as far as we can tell: the screen
  // just follows it. A lost link or a dark or sleeping Mac is not active.
  function macActive(t) {
    return !linkLost(t) && macDisplayOn && !macSleeping;
  }

  function isOn() {
    var t = now();
    if (focusRunning) return true;
    if (focusDoneAt !== null && t - focusDoneAt < awakeMs) return true;
    if (linkLost(t)) return t - lastKnob < awakeMs;
    if (macActive(t)) return true;
    if (waiting > 0) return true;
    return t - Math.max(lastKnob, lastResolved) < awakeMs;
  }

  return {
    macPower: function (state) {
      if (!state) return;
      macDisplayOn = state.display === 'on';
      macSleeping = !!state.sleeping;
      // The Mac is awake with its display on: the screen follows it, and a
      // resolution recorded while it was dark must not hold the screen lit
      // after the display goes off again.
      if (macDisplayOn && !macSleeping) lastResolved = -Infinity;
    },
    // 'running', 'done' or null (none, or dismissed).
    focus: function (phase) {
      focusRunning = phase === 'running';
      if (phase === 'done') { if (focusDoneAt === null) focusDoneAt = now(); }
      else focusDoneAt = null;
    },
    linkUp: function () { linkDownSince = null; },
    linkDown: function () { if (linkDownSince === null) linkDownSince = now(); },
    asks: function (count) {
      var n = count > 0 ? count : 0;
      // The awake period after a resolution is recorded only when the link is
      // up (or lost for less than the grace) and the Mac is dark or asleep.
      // Not when the Mac display is on, or the screen would stay lit after
      // the display turns off. Not when the link is lost past grace either: a
      // stale ask dropped on reconnect (claude.queue.sync) is not a wake.
      var t = now();
      if (n === 0 && waiting > 0 && !linkLost(t) && !macActive(t)) lastResolved = t;
      waiting = n;
    },
    // True when the input must be swallowed: it found the screen dark, or it
    // came within swallowMs of a knob wake (the rest of the same turn). A
    // screen lit by an ask or by the Mac was already visible, so a knob input
    // on it is real. Every knob input restarts the awake period.
    knob: function () {
      var t = now();
      var swallow;
      if (!isOn()) {
        knobWokeAt = t;
        swallow = true;
      } else {
        swallow = t - knobWokeAt < swallowMs;
      }
      lastKnob = t;
      return swallow;
    },
    isOn: isOn,
  };
}
