// The Car Thing's microphones, through the small native recorder service on
// the device (the kiosk browser can't open them itself). Same shape as the
// browser recorder in dictation.js: start(), stop() -> {blob, mime}, abort().

export function createDeviceRecorder(base, fetchImpl) {
  var doFetch = fetchImpl || fetch;

  function post(path) {
    return doFetch(base + path, { method: 'POST' });
  }

  return {
    start: function () {
      return post('/start').then(function (r) {
        if (!r.ok) throw new Error('no-microphone');
      }, function () {
        throw new Error('no-microphone');
      });
    },
    stop: function () {
      return post('/stop').then(function (r) {
        if (!r.ok) throw new Error('transcription-failed');
        return r.blob();
      }).then(function (blob) {
        return { blob: blob, mime: 'audio/wav' };
      });
    },
    abort: function () {
      post('/stop').catch(function () {});
    },
  };
}
