// The owner's settings for the Mac service itself, as opposed to the panel.
//
// Today there is one: whether the Mac chimes (chime.js) when something needs
// them. It defaults to on, because a chime the owner never turned on is a
// feature they never find; it is a setting so a quiet desk can silence it.
//
// The caller supplies read/write, backed by persist.js, so the setting survives
// a restart. Like the other modules with state, nothing here touches disk
// itself and a test passes plain functions.
//
// set() takes a patch and keeps only the keys this module knows, and only when
// the value is the right type: the patch arrives from the panel's WebSocket,
// where anything can be sent. What is stored is always a complete, valid
// `{ chime: boolean }`, whatever was on disk or in the patch.

const DEFAULTS = { chime: true };
const KEYS = Object.keys(DEFAULTS);

// Overlay the known boolean keys of `raw` onto `base`. Anything else is ignored.
function overlay(base, raw) {
  const out = { ...base };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const key of KEYS) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key];
  }
  return out;
}

export function createServicePrefs({ read = () => null, write = () => {} } = {}) {
  let saved = null;
  try { saved = read(); } catch { /* an unreadable file is the default setting */ }
  let prefs = overlay(DEFAULTS, saved);

  return {
    // A copy, so a caller cannot change the setting behind its back.
    get: () => ({ ...prefs }),
    set(patch) {
      prefs = overlay(prefs, patch);
      // The new setting holds for this run even if it could not be saved.
      try { write({ ...prefs }); } catch { /* disk full: the next set tries again */ }
      return { ...prefs };
    },
  };
}
