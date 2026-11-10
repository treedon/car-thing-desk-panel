/* panel-recorder's pure core: mixing, levels, the WAV header and the
 * start/stop rules. No ALSA, no sockets, so it is tested on any machine. */
#ifndef RECORDER_CORE_H
#define RECORDER_CORE_H
#include <stddef.h>
#include <stdint.h>

#define RC_RATE 16000
#define RC_CHANNELS 4
#define RC_MAX_FRAMES (RC_RATE * 30)

/* 4 interleaved s32 mics -> their average, frames long. */
void rc_mix4(const int32_t *in, size_t frames, int32_t *mono);
/* s32 mono -> s16, lifted so the peak sits near 90% of full scale (at most
 * 256x, since PDM mics record speech far below full scale); never clips. */
void rc_to_s16(const int32_t *mono, size_t n, int16_t *out);
/* A 44-byte PCM WAV header for `samples` mono s16 samples at `rate`. */
void rc_wav_header(uint8_t h[44], uint32_t samples, uint32_t rate);

enum rc_phase { RC_IDLE, RC_RECORDING, RC_DONE };
typedef struct { enum rc_phase phase; uint32_t frames; } rc_state;
void rc_init(rc_state *s);
/* HTTP-ish results: 204 started, 409 already recording or holding one. */
int rc_start(rc_state *s);
/* Counts captured frames; returns 1 when the 30 s cap stopped it. */
int rc_add_frames(rc_state *s, uint32_t n);
/* 200: hand over the recording (once); 409: nothing to hand over. */
int rc_stop(rc_state *s);
/* The panel's static files. Maps a URL path to a relative path under the web
 * root ("/" -> "index.html"); drops the query; refuses "..", "%" escapes and
 * paths that don't fit. 0 on success. */
int rc_safe_path(const char *url_path, char *out, size_t outlen);

/* The page to serve for a safe path: on a recovery boot (Back held at power-on)
 * the panel's index.html is replaced by the recovery notice. */
const char *rc_page_for(const char *rel, int recovery);
const char *rc_mime(const char *path);

/* The backlight and the light sensor. */
/* The `permille=N` of a request's first line ("POST /backlight?permille=600
 * HTTP/1.1"): N in 0..1000, or -1 if it is missing, not a plain number or out
 * of range. */
int rc_parse_permille(const char *request_line);
/* permille (0..1000) of `max`, rounded and clamped to 0..max. Anything above 0
 * is at least 1, so "on" is never black. */
int rc_backlight_value(int permille, int max);
/* A sysfs integer ("1927\n"): its value, or -1 for empty, non-numeric or
 * negative text. */
int rc_parse_raw(const char *text);
#endif
