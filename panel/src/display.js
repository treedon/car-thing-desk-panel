// The glue between the sleep rules (screen-power.js), the room-light curve
// (brightness.js) and the device: the black #screen-dark overlay and the
// panel-recorder's loopback routes (GET /light, POST /backlight?permille=).
// main.js only feeds it what it hears and calls tick() every second.
//
//   gate(action, source)  input.js asks before every action. A knob input
//                         ('knob') may wake the screen and is swallowed when
//                         it does; anything else acts only while lit.
//   macPower(s)           a claude.mac.power event.
//   linkUp(), linkDown()  the Mac service link came back, or went away.
//   asks(n)               the number of non-expired asks waiting.
//   focus(phase)          the focus timer: 'running', 'done' or null.
//   tick()                once a second.
//   isLit()               whether the screen is lit now (digest-seen.js asks).
//
// Lit to dark: the overlay fades in over FADE_MS, then the backlight goes to 0.
// Dark to lit: one quick fresh light reading (at most WAKE_READ_MS), the
// backlight on at the brightness for the room now, then the overlay off with
// no fade, so waking feels instant. While lit the sensor is read every
// POLL_MS and the backlight follows it.
//
// Without a recorder (the simulator) or with one that fails, the backlight and
// sensor are skipped: the overlay alone darkens the screen. The first failure
// is logged, never more, and the sensor is retried on the next poll.
//
// Stale state across a lost link. After linkDown() the Mac's last display
// state and the store's ask count are both out of date, and the panel must
// not light the screen from either. So a link up alone (any frame arriving)
// is not passed on to the sleep rules: the link counts as back only when a
// fresh claude.mac.power arrives. The service sends claude.queue.sync and
// then claude.mac.power on every hello, so by then the queue has been
// reconciled, and the rules see the stale asks dropped while the link is
// still lost (not a resolution, so no 10-minute wake). A short blip within
// the grace period keeps the last Mac state, so it doesn't blank a lit
// screen; a lost Mac that never says hello again leaves the screen dark once
// the grace runs out.

import { createScreenPower } from './screen-power.js';
import { createBrightness } from './brightness.js';

var FADE_MS = 1000;      // matches the #screen-dark opacity transition
var WAKE_READ_MS = 300;  // the longest a wake waits for a fresh light reading
var POLL_MS = 2000;      // sensor reads while lit
var POLL_STUCK_MS = 10000; // a read hung this long no longer blocks the next

export function createDisplay(opts) {
  opts = opts || {};
  var recorder = opts.recorder || null;
  var doFetch = opts.fetchImpl || function (url, init) { return fetch(url, init); };
  var now = opts.now || function () { return Date.now(); };
  var setTimer = opts.setTimer || function (fn, ms) { return setTimeout(fn, ms); };
  var overlay = opts.overlay;

  var power = createScreenPower({ now: now });
  var brightness = createBrightness({ now: now });

  var lit = true;          // what the screen shows now; it boots lit
  var gen = 0;             // bumped on every transition, so late timers and replies can tell
  var fresh = false;       // a claude.mac.power arrived since the last link loss
  var lastPoll = -Infinity;
  var pollingSince = null; // when the read in flight started
  var warned = false;

  function fail(err) {
    if (warned) return;
    warned = true;
    console.warn('display: recorder unavailable, dimming with the overlay only', (err && err.message) || err);
  }

  function post(permille) {
    doFetch(recorder + '/backlight?permille=' + permille, { method: 'POST' }).then(function (r) {
      if (!r || !r.ok) fail(new Error('backlight ' + (r && r.status)));
    }).catch(fail);
  }

  // One GET /light, fed to the brightness. Resolves either way.
  function readLight() {
    return doFetch(recorder + '/light').then(function (r) {
      if (!r || !r.ok) throw new Error('light ' + (r && r.status));
      return r.json();
    }).then(function (body) {
      brightness.reading(body && body.ch0);
    }).catch(fail);
  }

  function goDark() {
    lit = false;
    var g = ++gen;
    overlay.show();
    if (!recorder) return;
    setTimer(function () { if (g === gen) post(0); }, FADE_MS);
  }

  function wake() {
    lit = true;
    var g = ++gen;
    lastPoll = now();
    if (!recorder) { overlay.hide(); return; }
    var done = false;
    function finish() {
      if (done) return;
      done = true;
      if (g !== gen) return;
      post(Math.round(brightness.level() * 1000));
      overlay.hide();
    }
    readLight().then(finish);
    setTimer(finish, WAKE_READ_MS);
  }

  function update() {
    var on = power.isOn();
    if (on && !lit) wake();
    else if (!on && lit) goDark();
  }

  function poll() {
    var t = now();
    if (pollingSince !== null && t - pollingSince < POLL_STUCK_MS) return;
    pollingSince = t;
    var g = gen;
    readLight().then(function () {
      if (pollingSince === t) pollingSince = null;
      if (g !== gen || !lit) return;
      var permille = brightness.next();
      if (permille !== null) post(permille);
    });
  }

  return {
    gate: function (action, source) {
      if (source === 'knob') {
        var swallowed = power.knob();
        update();
        return !swallowed;
      }
      return power.isOn();
    },
    macPower: function (s) {
      power.macPower(s);
      // It came over the link, so the link is up and the state is fresh.
      fresh = true;
      power.linkUp();
      update();
    },
    linkUp: function () {
      if (fresh) power.linkUp();
      update();
    },
    linkDown: function () {
      fresh = false;
      power.linkDown();
      update();
    },
    asks: function (n) {
      power.asks(n);
      update();
    },
    // The focus timer's phase: 'running', 'done' or null. Keeps the screen lit.
    focus: function (phase) {
      power.focus(phase);
      update();
    },
    tick: function () {
      update();
      if (!lit || !recorder) return;
      if (now() - lastPoll < POLL_MS) return;
      lastPoll = now();
      poll();
    },
    isLit: function () { return lit; },
  };
}
