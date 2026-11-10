import { esc, topbar } from './helpers.js';

// The NucBox at a glance: the loaded model, a quiet busy/idle tag, four
// meters and the temperatures. It is for looking only and never alerts.

function meter(label, value) {
  var v = value == null ? null : Math.round(value);
  return '<div class="nmeter"><div class="nmlabel">' + label + '</div>' +
    '<div class="nmval">' + (v == null ? '—' : v + '%') + '</div>' +
    '<div class="nmbar"><span style="width:' + (v == null ? 0 : Math.max(0, Math.min(100, v))) + '%"></span></div></div>';
}

export function renderNucbox(status, cfg, connected) {
  var head = '<div class="screen">' + topbar('NUCBOX', connected !== false);
  if (!status || !cfg) {
    return head + '<div class="nquiet">NucBox isn\'t set up. See Plan 3 Task 1 Step 5b.</div></div>';
  }
  var model = status.model
    ? '<div class="nmodel">' + esc(status.model) + '</div>' +
      (status.extra ? '<div class="nextra">+' + status.extra + ' more loaded</div>' : '')
    : '<div class="nmodel none">No model loaded</div>';
  var meters = meter('CPU', status.cpu) + meter('Memory', status.mem) +
    (cfg.gpuLoad ? meter('GPU', status.gpu) : '') +
    (cfg.gpuMemory ? meter('GPU memory', status.gpuMem) : '');
  var temps = '';
  for (var i = 0; i < status.temps.length; i++) {
    temps += '<span class="ntemp"><span class="ntname">' + esc(status.temps[i].name) + '</span>' + status.temps[i].c + '°</span>';
  }
  var missing = '';
  for (var j = 0; j < status.missing.length; j++) missing += '<div class="nmissing">' + esc(status.missing[j]) + '</div>';
  return head + '<div class="nucbox">' +
    '<div class="nhead">' + model + '<span class="ntag ' + status.busy + '">' + status.busy + '</span></div>' +
    missing +
    '<div class="nmeters">' + meters + '</div>' +
    (temps ? '<div class="ntemps">' + temps + '</div>' : '') +
    '</div></div>';
}
