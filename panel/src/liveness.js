// Whether the link to the Mac service is still alive. A sleeping Mac or a
// Wi-Fi drop closes nothing on this side, so silence is the only sign: ws.js
// pings every few seconds and treats a link that has heard nothing for
// timeoutMs as gone (banner up, reconnect with backoff).
export function createLiveness(opts) {
  var timeoutMs = opts.timeoutMs;
  var now = opts.now || function () { return Date.now(); };
  var last = now();
  return {
    heard: function () { last = now(); },
    dead: function () { return now() - last > timeoutMs; },
  };
}
