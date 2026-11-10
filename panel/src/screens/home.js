import { esc, topbar } from './helpers.js';
import { isAvailable, lightLevel } from '../ha/entities.js';
import { problemLine, optimistic, nameOf } from './ha-common.js';

// Lights and scenes from Home Assistant: a two-row grid that scrolls sideways
// like the session grid. Press toggles a light or turns a scene on; holding
// the top button on a light opens dim mode, where the knob sets its level.

var ROWS = 2;
var COLS_VISIBLE = 3;
var COL_STEP = 258;   // 250px tile + 8px gap
var scrollCol = 0;

export function homeEntities(ha) {
  return (ha && ha.home) || [];
}

function levelOf(ha, id, state) {
  var o = optimistic(ha, id);
  return o != null ? o : lightLevel(state);
}

function tile(ha, id, selected, off) {
  var s = ha.states ? ha.states[id] : null;
  var isScene = id.indexOf('scene.') === 0;
  var avail = isAvailable(s);
  var cls = 'htile' + (selected ? ' selected' : '') + (avail ? '' : ' unavailable') +
    (isScene ? ' scene' : (levelOf(ha, id, s) > 0 ? ' lit' : '')) + (off ? ' off' : '');
  var body;
  if (!avail) body = '<div class="hsub">Unavailable</div>';
  else if (isScene) body = '<div class="hsub">Scene</div>';
  else {
    var lvl = levelOf(ha, id, s);
    body = '<div class="hsub">' + (lvl > 0 ? lvl + '%' : 'Off') + '</div>' +
      '<div class="hbar"><span style="width:' + lvl + '%"></span></div>';
  }
  return '<div class="' + cls + '" data-action="ha-tile" data-id="' + esc(id) + '">' +
    '<div class="hname">' + esc(nameOf(s, id)) + '</div>' + body + '</div>';
}

function dimView(ha, id) {
  var s = ha.states ? ha.states[id] : null;
  var lvl = levelOf(ha, id, s);
  return '<div class="hdim"><div class="hdimname">' + esc(nameOf(s, id)) + '</div>' +
    '<div class="hdimpct">' + lvl + '%</div>' +
    '<div class="hdimbar"><span style="width:' + lvl + '%"></span></div>' +
    '<div class="hdimhint">Turn the knob to dim · press to finish</div></div>';
}

export function renderHome(state, view) {
  var ha = state.ha || {};
  var ids = homeEntities(ha);
  var head = '<div class="screen">' + topbar('HOME', state.daemonConnected);
  if (!ha.configured || (!ids.length && ha.status === 'online')) {
    return head + (ha.configured ? '<div class="haline">No lights or scenes chosen. Run mac-service/scripts/ha-discover.js on the Mac.</div>'
      : problemLine(ha)) + '</div>';
  }
  var cursor = Math.max(0, Math.min(ids.length - 1, view.cursor || 0));
  if (view.adjusting && ids[cursor]) return head + problemLine(ha) + dimView(ha, ids[cursor]) + '</div>';

  var selCol = Math.floor(cursor / ROWS);
  var totalCols = Math.ceil(ids.length / ROWS);
  if (selCol < scrollCol) scrollCol = selCol;
  if (selCol > scrollCol + COLS_VISIBLE - 1) scrollCol = selCol - COLS_VISIBLE + 1;
  scrollCol = Math.max(0, Math.min(scrollCol, Math.max(0, totalCols - COLS_VISIBLE)));

  var tiles = '';
  for (var i = 0; i < ids.length; i++) {
    var col = Math.floor(i / ROWS);
    tiles += tile(ha, ids[i], i === cursor, col < scrollCol || col > scrollCol + COLS_VISIBLE);
  }
  return head + problemLine(ha) +
    '<div class="hgrid"><div class="htrack" style="transform:translateX(-' + (scrollCol * COL_STEP) + 'px)">' +
    tiles + '</div></div></div>';
}
