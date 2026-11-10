/* Just enough of ALSA's API to syntax-check main.c on a machine without it. */
#include <sys/types.h>
typedef struct snd_pcm snd_pcm_t;
typedef long snd_pcm_sframes_t;
typedef unsigned long snd_pcm_uframes_t;
enum { SND_PCM_STREAM_CAPTURE = 1, SND_PCM_FORMAT_S32_LE = 10, SND_PCM_ACCESS_RW_INTERLEAVED = 3 };
int snd_pcm_open(snd_pcm_t **pcm, const char *name, int stream, int mode);
int snd_pcm_set_params(snd_pcm_t *pcm, int format, int access, unsigned channels, unsigned rate, int soft_resample, unsigned latency);
snd_pcm_sframes_t snd_pcm_readi(snd_pcm_t *pcm, void *buffer, snd_pcm_uframes_t size);
int snd_pcm_recover(snd_pcm_t *pcm, int err, int silent);
int snd_pcm_close(snd_pcm_t *pcm);
