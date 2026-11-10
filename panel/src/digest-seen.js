// When the owner last looked at the Digest list (#/digest), so a card whose last turn came later
// says NEW (renderDigest's seenTs).
//
// main.js ticks it once a second with whether #/digest is on screen and whether the screen is lit. A
// visit is a run of ticks with both; when a visit of at least SEEN_MIN_MS ends (the screen left the
// digest or went dark), seenTs becomes the time it ended. It holds still during a visit, so the NEW
// tags stay readable while the screen is up, and a glance shorter than that is not a look.
//
// The time is the Mac's (clock.js now()), as the cards' are. seenTs survives a reload in storage
// (localStorage, under 'digestSeenTs'); a storage that is missing or throws keeps it in memory only.

export var SEEN_MIN_MS = 5000;
var KEY = 'digestSeenTs';

export function createDigestSeen(opts) {
  var storage = (opts && opts.storage) || null;
  var now = opts.now;
  var seen = read();
  var start = null;     // when the visit under way began, null when there is none

  // A stored value that is not a time is nothing seen, so no card is hidden for ever.
  function read() {
    var v;
    try { v = storage ? Number(storage.getItem(KEY)) : 0; } catch (e) { return 0; }
    return typeof v === 'number' && isFinite(v) && v > 0 ? v : 0;
  }

  function write(v) {
    try { if (storage) storage.setItem(KEY, String(v)); } catch (e) {}
  }

  return {
    tick: function (onScreen, lit) {
      var t = now();
      if (onScreen && lit) {
        if (start === null) start = t;
        return;
      }
      if (start === null) return;
      var began = start;
      start = null;
      if (t - began >= SEEN_MIN_MS) {
        seen = t;
        write(t);
      }
    },
    seenTs: function () { return seen; },
  };
}

// main.js's 1 s tick: the display's own tick first, called as setInterval called it, then the
// visit clock, told whether #/digest is on screen (onDigest()) and whether the screen is lit as the
// display's tick left it.
export function tickWithSeen(display, digestSeen, onDigest) {
  return function () {
    display.tick.apply(this, arguments);
    digestSeen.tick(onDigest(), display.isLit());
  };
}
