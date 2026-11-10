/* panel-recorder: records the Car Thing's 4-mic array for the desk panel's
 * dictation, because the kiosk browser can't open the microphones itself.
 *
 *   POST /start  -> 204 (409 if already recording or holding a recording)
 *   POST /stop   -> 200 audio/wav, 16 kHz mono s16 (409 if nothing to give)
 *   GET  /health -> 200
 *   GET  /light  -> 200 {"ch0":N,"ch1":N}, the light sensor's raw channels
 *                   (503 if it can't be read)
 *   POST /backlight?permille=0..1000 -> 204, sets the screen's backlight
 *                   (400 for a missing or bad value)
 *   GET  /...    -> the panel itself, from /usr/share/desk-panel, and
 *                   /panel-config.js from the provisioned /opt/panel
 *
 * It serves the panel too, so the kiosk loads it from http://127.0.0.1:8095/:
 * Chromium won't run module scripts from file://, and localhost is a secure
 * origin. Listens on 127.0.0.1:8095 only. Recording stops by itself at 30 s; the
 * audio lives in memory until /stop hands it over, then it is gone. */
#include <alsa/asoundlib.h>
#include <arpa/inet.h>
#include <netinet/in.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>
#include "recorder_core.h"

#define PORT 8095
#define DEVICE "hw:0,0"
#define CHUNK 320 /* 20 ms */
#define DOCROOT "/usr/share/desk-panel"
#define CONFIG_JS "/opt/panel/panel-config.js"
#define RECOVERY_FLAG "/run/panel-recovery"   /* written by panel-usb-mode */
#define MAX_FILE (8 * 1024 * 1024)
/* The light sensor. Its lux reading (in_illuminance0_input) reads 0 on this
 * driver, so the raw channels are read and the panel works out the level. */
#define LIGHT_DIR "/sys/bus/iio/devices/iio:device0/"
#define LIGHT_INTEGRATION LIGHT_DIR "in_intensity0_integration_time"
#define LIGHT_CH0 LIGHT_DIR "in_intensity0_raw"
#define LIGHT_CH1 LIGHT_DIR "in_intensity1_raw"
#define LIGHT_INTEGRATION_S "0.699"
#define BACKLIGHT_DIR "/sys/class/backlight/backlight/"
#define BACKLIGHT_BRIGHTNESS BACKLIGHT_DIR "brightness"
#define BACKLIGHT_MAX_FILE BACKLIGHT_DIR "max_brightness"
#define BACKLIGHT_MAX_DEFAULT 160

static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static rc_state state;
static int32_t *mono;          /* RC_MAX_FRAMES samples */
static int backlight_max = BACKLIGHT_MAX_DEFAULT;

/* snd_pcm_set_params leaves start_threshold at the whole buffer (1600 frames),
 * and the kernel only auto-starts a capture stream on a read at least that
 * big. Our CHUNK-frame reads never are, so the stream would sit PREPARED, the
 * read would time out with EIO, and nothing would ever be recorded. A
 * threshold of 1 starts it on the first read, and again after an overrun. */
static int start_on_first_read(snd_pcm_t *pcm) {
  snd_pcm_sw_params_t *sw;
  snd_pcm_sw_params_alloca(&sw);
  if (snd_pcm_sw_params_current(pcm, sw) < 0 ||
      snd_pcm_sw_params_set_start_threshold(pcm, sw, 1) < 0 ||
      snd_pcm_sw_params(pcm, sw) < 0) return -1;
  return 0;
}

static void *capture(void *arg) {
  (void)arg;
  int32_t buf[CHUNK * RC_CHANNELS];
  int32_t mixed[CHUNK];
  for (;;) {
    snd_pcm_t *pcm = NULL;
    if (snd_pcm_open(&pcm, DEVICE, SND_PCM_STREAM_CAPTURE, 0) < 0 ||
        snd_pcm_set_params(pcm, SND_PCM_FORMAT_S32_LE, SND_PCM_ACCESS_RW_INTERLEAVED,
                           RC_CHANNELS, RC_RATE, 0, 100000) < 0 ||
        start_on_first_read(pcm) < 0) {
      fprintf(stderr, "panel-recorder: can't open %s, retrying\n", DEVICE);
      if (pcm) snd_pcm_close(pcm);
      sleep(2);
      continue;
    }
    for (;;) {
      snd_pcm_sframes_t n = snd_pcm_readi(pcm, buf, CHUNK);
      if (n < 0) { if (snd_pcm_recover(pcm, (int)n, 1) < 0) break; continue; }
      rc_mix4(buf, (size_t)n, mixed);
      pthread_mutex_lock(&lock);
      if (state.phase == RC_RECORDING) {
        uint32_t room = RC_MAX_FRAMES - state.frames;
        uint32_t take = (uint32_t)n < room ? (uint32_t)n : room;
        memcpy(mono + state.frames, mixed, take * sizeof(int32_t));
        rc_add_frames(&state, (uint32_t)n);
      }
      pthread_mutex_unlock(&lock);
    }
    snd_pcm_close(pcm);
  }
  return NULL;
}

static void reply(int fd, const char *status, const char *type, const void *body, size_t len) {
  char head[256];
  int h = snprintf(head, sizeof head,
                   "HTTP/1.1 %s\r\nCache-Control: no-store\r\nContent-Type: %s\r\n"
                   "Content-Length: %zu\r\nConnection: close\r\n\r\n", status, type, len);
  if (write(fd, head, (size_t)h) < 0) return;
  if (len && write(fd, body, len) < 0) return;
}

/* A sysfs integer; -1 if the file can't be read or isn't one. */
static int read_raw(const char *path) {
  char buf[32];
  FILE *f = fopen(path, "r");
  if (!f) return -1;
  size_t n = fread(buf, 1, sizeof buf - 1, f);
  int bad = ferror(f);
  fclose(f);
  if (bad) return -1;
  buf[n] = 0;
  return rc_parse_raw(buf);
}

/* Writing a sysfs file only fails for sure when it is closed. */
static int write_text(const char *path, const char *text) {
  FILE *f = fopen(path, "w");
  if (!f) return -1;
  int bad = fputs(text, f) < 0;
  return fclose(f) != 0 || bad ? -1 : 0;
}

static void handle(int fd) {
  char req[1024];
  ssize_t r = read(fd, req, sizeof req - 1);
  if (r <= 0) return;
  req[r] = 0;
  if (!strncmp(req, "GET /health ", 12)) return reply(fd, "200 OK", "text/plain", "ok", 2);
  if (!strncmp(req, "POST /start ", 12)) {
    pthread_mutex_lock(&lock);
    int code = rc_start(&state);
    pthread_mutex_unlock(&lock);
    return code == 204 ? reply(fd, "204 No Content", "text/plain", "", 0)
                       : reply(fd, "409 Conflict", "text/plain", "busy", 4);
  }
  if (!strncmp(req, "POST /stop ", 11)) {
    pthread_mutex_lock(&lock);
    uint32_t frames = state.frames;
    int code = rc_stop(&state);
    size_t len = 44 + (size_t)frames * 2;
    uint8_t *wav = code == 200 ? malloc(len) : NULL;
    if (wav) {
      rc_wav_header(wav, frames, RC_RATE);
      rc_to_s16(mono, frames, (int16_t *)(wav + 44));
    }
    state.frames = 0;
    pthread_mutex_unlock(&lock);
    if (!wav) return reply(fd, "409 Conflict", "text/plain", "nothing recorded", 16);
    reply(fd, "200 OK", "audio/wav", wav, len);
    free(wav);
    return;
  }
  if (!strncmp(req, "GET /light ", 11)) {
    int ch0 = read_raw(LIGHT_CH0), ch1 = read_raw(LIGHT_CH1);
    if (ch0 < 0 || ch1 < 0) return reply(fd, "503 Service Unavailable", "text/plain", "no light reading", 16);
    char json[64];
    int n = snprintf(json, sizeof json, "{\"ch0\":%d,\"ch1\":%d}", ch0, ch1);
    return reply(fd, "200 OK", "application/json", json, (size_t)n);
  }
  if (!strncmp(req, "POST /backlight", 15)) {
    int permille = rc_parse_permille(req);
    if (permille < 0) return reply(fd, "400 Bad Request", "text/plain", "permille=0..1000", 16);
    char value[16];
    snprintf(value, sizeof value, "%d\n", rc_backlight_value(permille, backlight_max));
    if (write_text(BACKLIGHT_BRIGHTNESS, value) < 0) {
      return reply(fd, "500 Internal Server Error", "text/plain", "backlight write failed", 22);
    }
    return reply(fd, "204 No Content", "text/plain", "", 0);
  }
  if (!strncmp(req, "GET /", 5)) {
    char url[512], rel[400], full[512];
    if (sscanf(req, "GET %511s ", url) != 1 || rc_safe_path(url, rel, sizeof rel) != 0) {
      return reply(fd, "404 Not Found", "text/plain", "", 0);
    }
    if (!strcmp(rel, "panel-config.js")) snprintf(full, sizeof full, "%s", CONFIG_JS);
    else snprintf(full, sizeof full, "%s/%s", DOCROOT, rc_page_for(rel, access(RECOVERY_FLAG, F_OK) == 0));
    FILE *f = fopen(full, "rb");
    if (!f) return reply(fd, "404 Not Found", "text/plain", "", 0);
    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    fseek(f, 0, SEEK_SET);
    char *body = size >= 0 && size <= MAX_FILE ? malloc((size_t)size + 1) : NULL;
    size_t got = body ? fread(body, 1, (size_t)size, f) : 0;
    fclose(f);
    if (!body) return reply(fd, "500 Internal Server Error", "text/plain", "", 0);
    reply(fd, "200 OK", rc_mime(rel), body, got);
    free(body);
    return;
  }
  reply(fd, "404 Not Found", "text/plain", "", 0);
}

int main(void) {
  mono = calloc(RC_MAX_FRAMES, sizeof(int32_t));
  if (!mono) return 1;
  rc_init(&state);
  /* The sensor is read with a 0.699 s integration time. If it won't set, the
   * driver's default stays and /light still answers, so carry on. */
  if (write_text(LIGHT_INTEGRATION, LIGHT_INTEGRATION_S "\n") < 0) {
    fprintf(stderr, "panel-recorder: can't set the light sensor's integration time\n");
  }
  int max = read_raw(BACKLIGHT_MAX_FILE);
  if (max > 0) backlight_max = max;
  else fprintf(stderr, "panel-recorder: can't read the backlight's maximum, using %d\n", BACKLIGHT_MAX_DEFAULT);
  pthread_t t;
  pthread_create(&t, NULL, capture, NULL);

  int s = socket(AF_INET, SOCK_STREAM, 0);
  int one = 1;
  setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
  struct sockaddr_in a = { .sin_family = AF_INET, .sin_port = htons(PORT) };
  a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (bind(s, (struct sockaddr *)&a, sizeof a) < 0 || listen(s, 4) < 0) { perror("panel-recorder"); return 1; }
  for (;;) {
    int c = accept(s, NULL, NULL);
    if (c < 0) continue;
    handle(c);
    close(c);
  }
}
