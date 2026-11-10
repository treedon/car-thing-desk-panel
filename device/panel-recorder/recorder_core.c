#include "recorder_core.h"

void rc_mix4(const int32_t *in, size_t frames, int32_t *mono) {
  for (size_t i = 0; i < frames; i++) {
    int64_t sum = (int64_t)in[4 * i] + in[4 * i + 1] + in[4 * i + 2] + in[4 * i + 3];
    mono[i] = (int32_t)(sum / 4);
  }
}

void rc_to_s16(const int32_t *mono, size_t n, int16_t *out) {
  int64_t peak = 0;
  for (size_t i = 0; i < n; i++) {
    int64_t a = mono[i] < 0 ? -(int64_t)mono[i] : mono[i];
    if (a > peak) peak = a;
  }
  const double target = 0.9 * 2147483648.0;
  double gain = peak ? target / (double)peak : 1.0;
  if (gain > 256.0) gain = 256.0;
  for (size_t i = 0; i < n; i++) {
    double v = (double)mono[i] * gain / 65536.0;
    if (v > 29491.0) v = 29491.0;
    if (v < -29491.0) v = -29491.0;
    out[i] = (int16_t)(v < 0 ? v - 0.5 : v + 0.5);
  }
}

static void le32(uint8_t *p, uint32_t v) { p[0] = v; p[1] = v >> 8; p[2] = v >> 16; p[3] = v >> 24; }
static void le16(uint8_t *p, uint16_t v) { p[0] = v; p[1] = v >> 8; }

void rc_wav_header(uint8_t h[44], uint32_t samples, uint32_t rate) {
  uint32_t data = samples * 2;
  __builtin_memcpy(h, "RIFF", 4); le32(h + 4, 36 + data);
  __builtin_memcpy(h + 8, "WAVE", 4);
  __builtin_memcpy(h + 12, "fmt ", 4); le32(h + 16, 16);
  le16(h + 20, 1); le16(h + 22, 1); le32(h + 24, rate); le32(h + 28, rate * 2);
  le16(h + 32, 2); le16(h + 34, 16);
  __builtin_memcpy(h + 36, "data", 4); le32(h + 40, data);
}

void rc_init(rc_state *s) { s->phase = RC_IDLE; s->frames = 0; }

int rc_start(rc_state *s) {
  if (s->phase != RC_IDLE) return 409;
  s->phase = RC_RECORDING;
  s->frames = 0;
  return 204;
}

int rc_add_frames(rc_state *s, uint32_t n) {
  if (s->phase != RC_RECORDING) return 0;
  if (s->frames + n >= RC_MAX_FRAMES) {
    s->frames = RC_MAX_FRAMES;
    s->phase = RC_DONE;
    return 1;
  }
  s->frames += n;
  return 0;
}

int rc_stop(rc_state *s) {
  if (s->phase == RC_IDLE) return 409;
  s->phase = RC_IDLE;
  return 200;
}

int rc_safe_path(const char *url, char *out, size_t outlen) {
  if (!url || url[0] != '/') return -1;
  size_t n = 0;
  const char *p = url + 1;
  while (*p && *p != '?' && *p != '#') {
    if (*p == '%') return -1;                       /* no escapes: nothing legitimate needs them */
    if (p[0] == '.' && p[1] == '.') return -1;
    if (n + 1 >= outlen) return -1;
    out[n++] = *p++;
  }
  if (n == 0) {
    const char *idx = "index.html";
    if (outlen < 11) return -1;
    for (n = 0; idx[n]; n++) out[n] = idx[n];
  }
  out[n] = 0;
  return 0;
}

const char *rc_page_for(const char *rel, int recovery) {
  const char *idx = "index.html";
  size_t i = 0;
  while (rel[i] && rel[i] == idx[i]) i++;
  if (recovery && rel[i] == 0 && idx[i] == 0) return "recovery.html";
  return rel;
}

static int ends_with(const char *s, const char *suffix) {
  size_t a = 0, b = 0;
  while (s[a]) a++;
  while (suffix[b]) b++;
  if (b > a) return 0;
  for (size_t i = 0; i < b; i++) if (s[a - b + i] != suffix[i]) return 0;
  return 1;
}

const char *rc_mime(const char *path) {
  if (ends_with(path, ".html")) return "text/html; charset=utf-8";
  if (ends_with(path, ".js")) return "application/javascript";
  if (ends_with(path, ".css")) return "text/css";
  if (ends_with(path, ".svg")) return "image/svg+xml";
  if (ends_with(path, ".png")) return "image/png";
  if (ends_with(path, ".woff2")) return "font/woff2";
  if (ends_with(path, ".json")) return "application/json";
  return "application/octet-stream";
}

static int line_end(char c) { return c == 0 || c == ' ' || c == '\r' || c == '\n'; }

int rc_parse_permille(const char *line) {
  if (!line) return -1;
  const char *p = line;
  while (!line_end(*p)) p++;                  /* the method */
  while (*p == ' ') p++;
  while (!line_end(*p) && *p != '?') p++;     /* the path */
  if (*p != '?') return -1;
  for (p++; !line_end(*p); ) {                /* the query, one parameter at a time */
    const char *key = "permille=";
    size_t k = 0;
    while (key[k] && p[k] == key[k]) k++;
    if (!key[k]) {
      p += k;
      if (*p < '0' || *p > '9') return -1;
      int v = 0;
      while (*p >= '0' && *p <= '9') {
        v = v * 10 + (*p++ - '0');
        if (v > 1000) return -1;
      }
      return line_end(*p) || *p == '&' ? v : -1;
    }
    while (!line_end(*p) && *p != '&') p++;
    if (*p == '&') p++;
  }
  return -1;
}

int rc_backlight_value(int permille, int max) {
  if (max <= 0 || permille <= 0) return 0;
  if (permille >= 1000) return max;
  int v = (int)(((int64_t)max * permille + 500) / 1000);
  return v < 1 ? 1 : v;
}

int rc_parse_raw(const char *text) {
  if (!text || *text < '0' || *text > '9') return -1;
  int64_t v = 0;
  while (*text >= '0' && *text <= '9') {
    v = v * 10 + (*text++ - '0');
    if (v > INT32_MAX) return -1;
  }
  while (*text == ' ' || *text == '\t' || *text == '\r' || *text == '\n') text++;
  return *text == 0 ? (int)v : -1;
}
