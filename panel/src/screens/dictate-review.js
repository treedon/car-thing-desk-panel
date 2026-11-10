import { esc, topbar } from './helpers.js';

// Dictation, start to finish: hold the top button and speak; release to have
// the Mac transcribe it; read the text; press the knob to Send, hold the top
// button to say it again, or press back to cancel. The text is never sent
// before the owner has seen it.
//
// main.js supplies the host: show() opens the screen, update() re-renders it,
// record = {start, stop, abort}, and transcribe(blob, mime) -> Promise<text>.

export var MAX_SECONDS = 30;
// A microphone permission waiting on a dialog nobody can see would otherwise
// leave the screen listening forever.
var MIC_TIMEOUT_MS = 8000;

var host = null;
var current = null;   // {title, phase, seconds, text, error, onSend, onCancel}
var timer = null;

export function setDictateHost(h) { host = h; }
export function getDictation() { return current; }

export function recordingMime(isSupported) {
  var options = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  for (var i = 0; i < options.length; i++) if (isSupported(options[i])) return options[i];
  return '';
}

var ERRORS = {
  'dictation-not-set-up': "Dictation isn't set up on the Mac yet. Run mac-service/scripts/setup-dictation.sh.",
  'too-long': 'That was over 30 seconds. Try a shorter answer.',
  'no-microphone': 'No microphone was found.',
  'mic-timeout': "The microphone didn't start. On the Mac, check that the browser may use the microphone.",
};

export function dictationErrorText(code) {
  return ERRORS[code] || "The Mac couldn't transcribe that. Try again.";
}

function clock(s) {
  return Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60);
}

export function renderDictate(state, d) {
  var body;
  if (d.phase === 'recording') {
    body = '<div class="dmic live"></div><div class="dstatus">Listening… ' + clock(d.seconds || 0) +
      '</div><div class="dhint">Let go of the top button when you are done · stops at ' + clock(MAX_SECONDS) + '</div>';
  } else if (d.phase === 'transcribing') {
    body = '<div class="dmic"></div><div class="dstatus">Transcribing…</div>';
  } else if (d.phase === 'review' && d.text) {
    body = '<div class="dtext">' + esc(d.text) + '</div>' +
      (d.note ? '<div class="dnote">' + esc(d.note) + '</div>' : '') +
      '<div class="drows">' +
      '<div class="drow send selected" data-action="dict-send">' + esc(d.sendLabel || 'Send') + '<span class="dkey">press the knob</span></div>' +
      '<div class="drow" data-action="dict-again">Say it again<span class="dkey">hold the top button</span></div>' +
      '<div class="drow" data-action="dict-cancel">Cancel<span class="dkey">back</span></div>' +
      '</div>';
  } else if (d.phase === 'review') {
    body = '<div class="dmic"></div><div class="dstatus">Didn\'t catch that.</div>' +
      '<div class="dhint">Hold the top button and try again, or press back to cancel.</div>';
  } else if (d.phase === 'error') {
    body = '<div class="derror">' + esc((d.errorText || dictationErrorText)(d.error)) + '</div>' +
      '<div class="dhint">Hold the top button to try again, or press back to cancel.</div>';
  } else {
    body = '<div class="dmic"></div><div class="dstatus">Hold the top button and speak</div>' +
      '<div class="dhint">Let go when you are done. Press back to cancel.</div>';
  }
  return '<div class="screen">' + topbar('DICTATION', state.daemonConnected) +
    '<div class="dictate"><div class="dtitle2">' + esc(d.title) + '</div>' + body + '</div></div>';
}

function set(fields) {
  if (!current) return;
  for (var k in fields) current[k] = fields[k];
  if (host) host.update();
}

function stopTimer() {
  if (timer) { clearInterval(timer); timer = null; }
}

// opts: {title, onSend(text), onCancel(), and optionally sendLabel, and
// transcribe(blob, mime) and errorText(code) in place of the host's (the
// Tasks page transcribes on the NucBox, not the Mac), note (a line under the
// text on the check screen: what the text will start), and text (open on the
// check screen with this already said: a send that was refused, brought back
// so nothing spoken is lost)}; startNow begins recording at once (the top
// button is already held).
export function openDictateReview(opts, startNow) {
  stopTimer();
  var given = String(opts.text || '').trim();
  current = { title: opts.title || 'Dictation', phase: given ? 'review' : 'ready', seconds: 0, text: given, error: null,
    onSend: opts.onSend, onCancel: opts.onCancel, sendLabel: opts.sendLabel || 'Send', note: opts.note || '',
    transcribe: opts.transcribe || null, errorText: opts.errorText || null };
  if (host) host.show();
  if (startNow) beginTalk();
}

export function beginTalk() {
  if (!current || !host || current.phase === 'recording' || current.phase === 'transcribing') return;
  set({ phase: 'recording', seconds: 0, text: '', error: null, stopAsked: false });
  var settled = false;
  var waitMic = setTimeout(function () {
    if (settled || !current || current.phase !== 'recording') return;
    settled = true;
    host.record.abort();
    set({ phase: 'error', error: 'mic-timeout' });
  }, host.micTimeoutMs || MIC_TIMEOUT_MS);
  host.record.start().then(function () {
    if (settled) return host.record.abort();
    settled = true;
    clearTimeout(waitMic);
    if (!current || current.phase !== 'recording') return host.record.abort();
    if (current.stopAsked) return endTalk();
    timer = setInterval(function () {
      if (!current) return stopTimer();
      set({ seconds: current.seconds + 1 });
      if (current.seconds >= MAX_SECONDS) endTalk();
    }, 1000);
  }, function () {
    if (settled) return;
    settled = true;
    clearTimeout(waitMic);
    set({ phase: 'error', error: 'no-microphone' });
  });
}

export function endTalk() {
  if (!current || current.phase !== 'recording') return;
  if (!timer) { current.stopAsked = true; return; }   // still waiting on the microphone
  stopTimer();
  set({ phase: 'transcribing' });
  host.record.stop().then(function (rec) {
    return (current && current.transcribe ? current.transcribe : host.transcribe)(rec.blob, rec.mime);
  }).then(function (text) {
    set({ phase: 'review', text: String(text || '').trim() });
  }, function (e) {
    set({ phase: 'error', error: (e && e.message) || 'transcription-failed' });
  });
}

export function sendDictation() {
  if (!current || current.phase !== 'review' || !current.text) return;
  var d = current;
  current = null;
  d.onSend(d.text);
}

export function cancelDictation() {
  if (!current) return;
  stopTimer();
  if (current.phase === 'recording' && host) host.record.abort();
  var d = current;
  current = null;
  if (d.onCancel) d.onCancel();
}
