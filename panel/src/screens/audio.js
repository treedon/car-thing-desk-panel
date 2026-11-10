import { esc, topbar } from './helpers.js';
import { isAvailable, volumePct, nowPlaying } from '../ha/entities.js';
import { problemLine, optimistic, nameOf } from './ha-common.js';

// HomePods through Home Assistant's Apple TV integration. The selected one is
// large: artwork, what's playing, volume. The rest sit in a row underneath.
// Knob = volume, press = play/pause, top button tap = next track.

export function audioEntities(ha) {
  return (ha && ha.audio) || [];
}

export function volumeOf(ha, id) {
  var o = optimistic(ha, id);
  return o != null ? o : volumePct(ha.states ? ha.states[id] : null);
}

function hero(ha, id) {
  var s = ha.states ? ha.states[id] : null;
  if (!isAvailable(s)) {
    return '<div class="ahero unavailable"><div class="aart placeholder"></div><div class="ainfo">' +
      '<div class="aname">' + esc(nameOf(s, id)) + '</div><div class="atitle">Unavailable</div></div></div>';
  }
  var np = nowPlaying(s, ha.url);
  var art = np.art
    ? '<img class="aart" src="' + esc(np.art) + '" onerror="this.style.visibility=&quot;hidden&quot;">'
    : '<div class="aart placeholder"></div>';
  var line = np.title || (np.playing ? 'Playing' : 'Nothing playing');
  var vol = volumeOf(ha, id);
  return '<div class="ahero' + (np.playing ? ' playing' : '') + '">' + art + '<div class="ainfo">' +
    '<div class="aname">' + esc(nameOf(s, id)) + (np.playing ? '<span class="aplay">▶</span>' : '') + '</div>' +
    '<div class="atitle">' + esc(line) + '</div>' +
    (np.artist ? '<div class="aartist">' + esc(np.artist) + '</div>' : '') +
    '<div class="avolrow"><span class="avol">' + (vol == null ? '—' : vol + '%') + '</span>' +
    '<span class="avolbar"><span style="width:' + (vol || 0) + '%"></span></span></div>' +
    '<div class="ahint">Knob: volume · Press: play/pause · Top button: next track · Hold it: next HomePod</div>' +
    '</div></div>';
}

export function renderAudio(state, view) {
  var ha = state.ha || {};
  var ids = audioEntities(ha);
  var head = '<div class="screen">' + topbar('AUDIO', state.daemonConnected);
  if (!ha.configured || (!ids.length && ha.status === 'online')) {
    return head + (ha.configured ? '<div class="haline">No HomePods chosen. Run mac-service/scripts/ha-discover.js on the Mac.</div>'
      : problemLine(ha)) + '</div>';
  }
  if (!ids.length) return head + problemLine(ha) + '</div>';
  var cursor = Math.max(0, Math.min(ids.length - 1, view.cursor || 0));
  var others = '';
  for (var i = 0; i < ids.length; i++) {
    var s = ha.states ? ha.states[ids[i]] : null;
    var v = volumeOf(ha, ids[i]);
    others += '<div class="apod' + (i === cursor ? ' selected' : '') + (isAvailable(s) ? '' : ' unavailable') +
      '" data-action="ha-speaker" data-id="' + esc(ids[i]) + '">' +
      '<span class="apodname">' + esc(nameOf(s, ids[i])) + '</span>' +
      '<span class="apodvol">' + (isAvailable(s) ? (v == null ? '—' : v + '%') : 'Unavailable') + '</span></div>';
  }
  return head + problemLine(ha) + hero(ha, ids[cursor]) + '<div class="apods">' + others + '</div></div>';
}
