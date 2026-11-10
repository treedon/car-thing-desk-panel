/* The recorder's pure core: run with `make test` on any machine with cc. */
#include <stdio.h>
#include <string.h>
#include "../recorder_core.h"

static int failed = 0;
#define CHECK(name, cond) do { if (cond) printf("ok   %s\n", name); else { printf("FAIL %s\n", name); failed = 1; } } while (0)

int main(void) {
  /* 4 channels interleaved -> their average */
  int32_t in[8] = { 400, 800, 1200, 1600,  -4, -4, -4, -4 };
  int32_t mono[2];
  rc_mix4(in, 2, mono);
  CHECK("mix averages the four mics", mono[0] == 1000 && mono[1] == -4);

  /* quiet PDM audio is lifted toward full scale (at most 256x); never clips */
  int32_t quiet[3] = { 1 << 16, -(1 << 16), 0 };
  int16_t out[3];
  rc_to_s16(quiet, 3, out);
  CHECK("quiet audio is boosted, at most 256x", out[0] == 256 && out[1] == -256 && out[2] == 0);
  int32_t loud[2] = { INT32_MAX, INT32_MIN + 1 };
  rc_to_s16(loud, 2, out);
  CHECK("loud audio is not clipped past full scale", out[0] <= 29491 && out[0] > 29000 && out[1] >= -29491 && out[1] < -29000);
  int32_t mid[1] = { 1 << 24 };
  rc_to_s16(mid, 1, out);
  CHECK("normal speech is scaled to about 90% peak", out[0] > 29000 && out[0] <= 29491);

  /* a 44-byte PCM WAV header for 16 kHz mono s16 */
  uint8_t h[44];
  rc_wav_header(h, 16000, 16000);
  CHECK("RIFF/WAVE/fmt/data tags", !memcmp(h, "RIFF", 4) && !memcmp(h + 8, "WAVE", 4) && !memcmp(h + 12, "fmt ", 4) && !memcmp(h + 36, "data", 4));
  CHECK("data size is samples*2", h[40] == 0x00 && h[41] == 0x7d && h[42] == 0 && h[43] == 0);
  CHECK("rate 16000, mono, 16-bit", h[24] == 0x80 && h[25] == 0x3e && h[22] == 1 && h[34] == 16);
  CHECK("RIFF size is 36 + data", h[4] == 0x24 && h[5] == 0x7d);

  /* start / stop / auto-stop rules */
  rc_state s; rc_init(&s);
  CHECK("start from idle is accepted", rc_start(&s) == 204);
  CHECK("a second start is refused", rc_start(&s) == 409);
  CHECK("30 s of frames stops it", rc_add_frames(&s, 16000 * 29) == 0 && rc_add_frames(&s, 16000 * 2) == 1 && s.phase == RC_DONE);
  CHECK("frames past 30 s are not kept", s.frames == 16000 * 30);
  CHECK("stop after auto-stop hands over the recording once", rc_stop(&s) == 200 && rc_stop(&s) == 409);
  CHECK("stop with nothing recorded is refused", rc_stop(&s) == 409);
  /* static files for the panel: safe paths under the web root only */
  char path[256];
  CHECK("/ is the panel's index.html", rc_safe_path("/", path, sizeof path) == 0 && !strcmp(path, "index.html"));
  CHECK("an asset path maps under the root", rc_safe_path("/assets/index-legacy-AB12.js?v=1", path, sizeof path) == 0 && !strcmp(path, "assets/index-legacy-AB12.js"));
  CHECK("climbing out of the root is refused", rc_safe_path("/../etc/shadow", path, sizeof path) != 0 && rc_safe_path("/assets/%2e%2e/x", path, sizeof path) != 0);
  CHECK("a path too long is refused", rc_safe_path("/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", path, 8) != 0);
  CHECK("content types for the panel's files", !strcmp(rc_mime("index.html"), "text/html; charset=utf-8") &&
        !strcmp(rc_mime("a/b.js"), "application/javascript") && !strcmp(rc_mime("x.css"), "text/css") &&
        !strcmp(rc_mime("s.svg"), "image/svg+xml") && !strcmp(rc_mime("blob"), "application/octet-stream"));
  /* recovery boot (Back held): the kiosk's page is the recovery notice */
  CHECK("in recovery, / is recovery.html", !strcmp(rc_page_for("index.html", 1), "recovery.html"));
  CHECK("in recovery, other files are unchanged", !strcmp(rc_page_for("assets/a.js", 1), "assets/a.js"));
  CHECK("normally, / stays the panel", !strcmp(rc_page_for("index.html", 0), "index.html"));
  /* the backlight's level arrives as /backlight?permille=N; N is 0..1000 or the request is bad */
  CHECK("permille parses from the request line", rc_parse_permille("POST /backlight?permille=600 HTTP/1.1") == 600);
  CHECK("permille 0 is dark, not an error", rc_parse_permille("POST /backlight?permille=0 HTTP/1.1") == 0);
  CHECK("permille 1000 is the top", rc_parse_permille("POST /backlight?permille=1000 HTTP/1.1") == 1000);
  CHECK("permille past 1000 is refused", rc_parse_permille("POST /backlight?permille=1001 HTTP/1.1") == -1);
  CHECK("a missing permille is refused", rc_parse_permille("POST /backlight HTTP/1.1") == -1);
  CHECK("a non-number permille is refused", rc_parse_permille("POST /backlight?permille=abc HTTP/1.1") == -1);
  CHECK("an empty, negative or half-number permille is refused",
        rc_parse_permille("POST /backlight?permille= HTTP/1.1") == -1 &&
        rc_parse_permille("POST /backlight?permille=-5 HTTP/1.1") == -1 &&
        rc_parse_permille("POST /backlight?permille=60x HTTP/1.1") == -1);
  CHECK("a huge permille does not overflow into range", rc_parse_permille("POST /backlight?permille=99999999999999999999 HTTP/1.1") == -1);
  CHECK("permille is read from the first line only", rc_parse_permille("POST /backlight HTTP/1.1\r\nX: ?permille=5 HTTP/1.1") == -1);
  CHECK("permille may follow other query parameters", rc_parse_permille("POST /backlight?x=1&permille=250 HTTP/1.1") == 250);
  /* permille -> the sysfs brightness value (0..max); anything on is at least 1 */
  CHECK("full permille is the full backlight", rc_backlight_value(1000, 160) == 160);
  CHECK("600 permille of 160 is 96", rc_backlight_value(600, 160) == 96);
  CHECK("0 permille is off", rc_backlight_value(0, 160) == 0);
  CHECK("the faintest request is still lit", rc_backlight_value(1, 160) == 1);
  CHECK("a value past the top is clamped", rc_backlight_value(5000, 160) == 160 && rc_backlight_value(-3, 160) == 0);
  /* sysfs integers: "1927\n" -> 1927; anything else is -1 */
  CHECK("a sysfs integer parses", rc_parse_raw("1927\n") == 1927 && rc_parse_raw("65535\n") == 65535 && rc_parse_raw("0") == 0);
  CHECK("empty text is refused", rc_parse_raw("") == -1 && rc_parse_raw("\n") == -1);
  CHECK("non-numeric or negative text is refused", rc_parse_raw("x") == -1 && rc_parse_raw("12x") == -1 && rc_parse_raw("-4\n") == -1);
  return failed;
}
