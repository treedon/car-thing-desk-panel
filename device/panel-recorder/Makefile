# panel-recorder: the Car Thing's microphones for the desk panel's dictation.
# `make test` runs the pure core's tests anywhere; the binary needs Linux + ALSA.
CFLAGS ?= -O2 -Wall -Wextra
LDLIBS_DEVICE = -lasound -lpthread

panel-recorder: main.c recorder_core.c recorder_core.h
	$(CC) $(CFLAGS) -o $@ main.c recorder_core.c $(LDFLAGS) $(LDLIBS_DEVICE)

test: test/test_core.c recorder_core.c recorder_core.h
	$(CC) $(CFLAGS) -o test/run test/test_core.c recorder_core.c && ./test/run

clean:
	rm -f panel-recorder test/run

.PHONY: test clean
