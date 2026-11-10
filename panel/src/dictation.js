// Hold-to-talk recording on the panel: getUserMedia + MediaRecorder (both in
// Chrome 69). The recording goes to the Mac service, which transcribes it
// locally; nothing here keeps audio after it is sent.

import { recordingMime } from './screens/dictate-review.js';

var stream = null;
var recorder = null;
var chunks = [];
var mime = '';
var stopWaiter = null;

function isSupported(m) {
  return typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m);
}

export function startRecording() {
  if (recorder) return Promise.resolve();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return Promise.reject(new Error('no-microphone'));
  }
  return navigator.mediaDevices.getUserMedia({ audio: true }).then(function (s) {
    stream = s;
    mime = recordingMime(isSupported);
    chunks = [];
    recorder = mime ? new MediaRecorder(s, { mimeType: mime }) : new MediaRecorder(s);
    mime = recorder.mimeType || mime || 'audio/webm';
    recorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = function () {
      var blob = new Blob(chunks, { type: mime });
      release();
      if (stopWaiter) { var w = stopWaiter; stopWaiter = null; w({ blob: blob, mime: mime }); }
    };
    recorder.start();
  }, function () {
    throw new Error('no-microphone');
  });
}

function release() {
  if (stream) {
    var tracks = stream.getTracks();
    for (var i = 0; i < tracks.length; i++) tracks[i].stop();
  }
  stream = null;
  recorder = null;
  chunks = [];
}

export function stopRecording() {
  return new Promise(function (resolve, reject) {
    if (!recorder) return reject(new Error('not-recording'));
    stopWaiter = resolve;
    recorder.stop();
  });
}

// Drop a recording without sending it.
export function abortRecording() {
  stopWaiter = null;
  if (recorder && recorder.state !== 'inactive') {
    recorder.onstop = function () { release(); };
    recorder.stop();
  } else {
    release();
  }
}

export function blobToBase64(blob) {
  return new Promise(function (resolve, reject) {
    var r = new FileReader();
    r.onload = function () { resolve(String(r.result).split(',')[1] || ''); };
    r.onerror = function () { reject(new Error('read-failed')); };
    r.readAsDataURL(blob);
  });
}
