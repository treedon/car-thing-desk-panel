// The Mac's chime setting, flipped from the panel. The setting lives on the Mac
// (claude.prefs.get / claude.prefs.set); the panel holds a copy in state.chimeOn,
// null until the Mac has said. The request, the state and the toast are handed
// in, so none of this needs a socket or a browser to test.
//
// A press shows the new value at once and says it in a toast, then the Mac's
// answer replaces it; a failed save puts the old value back and says so. The
// flip is a lasting setting that silences the next alert, so it is never silent.
// One save at a time: a press while one is in flight does nothing, so the panel
// and the Mac can't disagree about which press won and a failure can't revert
// over a newer one.
//
// deps = { request(method, params) -> Promise, get() -> boolean|null,
//          set(boolean), toast(text) }

function words(on) {
  return on ? 'CHIME ON' : 'CHIME OFF';
}

export function createChime(deps) {
  var saving = false;

  return {
    // The Mac's current setting, on every (re)connect. A reply that is not a
    // boolean, or no reply, leaves what is known alone.
    fetch: function () {
      deps.request('claude.prefs.get', {}).then(function (res) {
        if (res && typeof res.chime === 'boolean') deps.set(res.chime);
      }).catch(function () {});
    },

    // Does nothing until the Mac has said which way it is set.
    toggle: function () {
      var current = deps.get();
      if (typeof current !== 'boolean' || saving) return;
      var next = !current;
      saving = true;
      deps.set(next);
      deps.toast(words(next));
      deps.request('claude.prefs.set', { chime: next }).then(function (res) {
        saving = false;
        var actual = res && typeof res.chime === 'boolean' ? res.chime : next;
        deps.set(actual);
        if (actual !== next) deps.toast(words(actual));
      }).catch(function () {
        saving = false;
        deps.set(current);
        deps.toast('COULD NOT SAVE');
      });
    },
  };
}
