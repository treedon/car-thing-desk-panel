// How bright the panel should be for the light in the room. Pure: no DOM, no
// timers, no fetch. The caller feeds it raw sensor counts (ch0 of the
// device's GET /light) and asks what to do.
//
//   reading(ch0)  one sensor sample. Garbage is ignored: anything that is not
//                 a finite number from 0 to 65534, so a failed read can never
//                 drag the panel dark. 65535 means the sensor saturated, which
//                 is the brightest it can say, so it counts as brightRaw.
//   level()       the brightness now, from darkLevel (a dim room) up to 1 (a
//                 bright one). 1 until the first valid reading.
//   next()        the permille to send to the backlight, or null while the
//                 level is within stepMin of the last one sent. The first
//                 call always returns a value.
//
// The average is an exponential moving average over time (time constant
// tauMs, so it does not care how often the caller polls), kept in raw counts.
// Samples above brightRaw are held to brightRaw first: the curve is flat
// there, and a dazzling sample must not make the average slow to come down.
// The level is the average on a log scale, since the eye judges light by
// ratio: at or below darkRaw it is darkLevel, at or above brightRaw it is 1.
// darkRaw must be above 0.
export function createBrightness(opts) {
  opts = opts || {};
  var now = opts.now || function () { return Date.now(); };
  var darkLevel = opts.darkLevel === undefined ? 0.6 : opts.darkLevel;
  var darkRaw = opts.darkRaw === undefined ? 30 : opts.darkRaw;
  var brightRaw = opts.brightRaw === undefined ? 1500 : opts.brightRaw;
  var tauMs = opts.tauMs === undefined ? 8000 : opts.tauMs;
  var stepMin = opts.stepMin === undefined ? 0.03 : opts.stepMin;

  var SATURATED = 65535;

  var average = null; // smoothed raw counts; null until the first valid reading
  var lastAt = 0;
  var sent = null; // the level last returned by next(), as a permille / 1000

  function level() {
    if (average === null) return 1;
    if (average <= darkRaw) return darkLevel;
    if (average >= brightRaw) return 1;
    var span = Math.log(brightRaw) - Math.log(darkRaw);
    var fraction = (Math.log(average) - Math.log(darkRaw)) / span;
    return darkLevel + (1 - darkLevel) * fraction;
  }

  return {
    reading: function (ch0) {
      if (typeof ch0 !== 'number' || !isFinite(ch0)) return;
      if (ch0 < 0 || ch0 > SATURATED) return;
      var sample = ch0 >= brightRaw ? brightRaw : ch0;
      var t = now();
      if (average === null) {
        average = sample;
      } else {
        // The weight of the new sample grows with the time since the last
        // one. A clock that stands still or steps back adds no weight.
        var dt = Math.max(0, t - lastAt);
        var weight = 1 - Math.exp(-dt / tauMs);
        average += (sample - average) * weight;
      }
      lastAt = t;
    },
    level: level,
    next: function () {
      var l = level();
      if (sent !== null && Math.abs(l - sent) < stepMin) return null;
      var permille = Math.round(l * 1000);
      sent = permille / 1000;
      return permille;
    },
  };
}
