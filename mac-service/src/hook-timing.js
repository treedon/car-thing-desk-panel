// Claude Code waits on every hook request, so how long the service takes to
// handle one is worth being able to see. With CLAUDE_THING_HOOK_TIMING=1 in the
// service's environment each hook event's handling time is logged
// ("HK timing Stop 0.31ms"); with it unset the handler runs untouched, no clock
// read and no log line. The flag is read once, at start.

export const HOOK_TIMING = process.env.CLAUDE_THING_HOOK_TIMING === '1';

// Runs `run` and, when enabled, logs how long it took even if it throws. The
// clock and the log are injectable so a test needs neither real time nor a file.
export function timeHook(event, run, { enabled = HOOK_TIMING, clock = process.hrtime.bigint, write } = {}) {
  if (!enabled) return run();
  const start = clock();
  try {
    return run();
  } finally {
    const ms = Number(clock() - start) / 1e6;
    write('HK', `timing ${event} ${ms.toFixed(2)}ms`);
  }
}
