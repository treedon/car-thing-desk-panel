// Small per-panel settings, remembered in the browser's storage. A storage
// that refuses (private mode, kiosk without storage) still works for the run.

var DEFAULTS = {
  // Opening a session on the panel also brings it forward on the Mac. Off by
  // default: checking in should not wake the Mac's screen.
  autoOpenOnMac: false,
  // The machine a new session was last started on (ws.machines() name), so the
  // machine screen opens with the cursor there. '' = none yet.
  newSessionHost: '',
};
var KEY = 'panel-prefs';

export function createPrefs(storage) {
  var values = {};
  for (var k in DEFAULTS) values[k] = DEFAULTS[k];
  try {
    var saved = JSON.parse((storage && storage.getItem(KEY)) || '{}');
    for (var s in saved) if (s in DEFAULTS) values[s] = saved[s];
  } catch (e) {}
  return {
    get: function (name) { return values[name]; },
    set: function (name, value) {
      values[name] = value;
      try { storage.setItem(KEY, JSON.stringify(values)); } catch (e) {}
    },
  };
}
