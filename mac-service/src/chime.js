// The chime: a short system sound on the Mac when something needs the owner.
//
// The panel is a glance device; the owner is often looking at another screen.
// A permission prompt, a held question or plan, or a loud inbox card should
// make a sound they hear from across the desk. macOS ships the sound, and
// `afplay` plays it, so there is nothing to bundle and nothing to install.
//
// Two things keep it from becoming noise. It is throttled: a burst of sessions
// finishing together asks for several chimes within a moment, and one sound
// says it as well as five. And it is a setting: the owner can turn it off, and
// `enabled` is read on every ring so the change takes effect at once.
//
// ring() is called from the hub's emit path, so it must never throw and never
// wait. afplay runs detached with its output ignored and is unref'd, so the
// daemon neither blocks on it nor keeps it as a child. A failure to start it
// (no afplay, no such file) is just a chime that did not play: ring() says
// false and the daemon carries on.
//
// spawn, now and enabled are injected so a test plays no sound and moves a
// fake clock instead of waiting.

import { spawn as nodeSpawn } from 'node:child_process';

export const CHIME_SOUND = '/System/Library/Sounds/Glass.aiff';
// At most one chime in this long, however many things ask.
export const CHIME_THROTTLE_MS = 10_000;
// The hub topics that need the owner. The caller rings the chime when one is
// emitted; the hub itself knows nothing about sound.
export const LOUD_TOPICS = [
  'claude.permission.request',
  'claude.prompt.created',
  'claude.question.request',
];

export function createChime({
  spawn = nodeSpawn,
  now = Date.now,
  enabled = () => true,
} = {}) {
  let lastAt = null;   // when the last sound started; null until one has

  // true if a sound was started, false if it was off, throttled or failed.
  function ring() {
    try {
      if (!enabled()) return false;
      const at = now();
      // A negative gap means the clock stepped back; a stale lastAt must not
      // silence the chime until the clock catches up.
      const gap = lastAt === null ? Infinity : at - lastAt;
      if (gap >= 0 && gap < CHIME_THROTTLE_MS) return false;

      const child = spawn('afplay', [CHIME_SOUND], { detached: true, stdio: 'ignore' });
      // A missing afplay is reported as an 'error' event after spawn returns,
      // and an unhandled 'error' event would take the whole daemon down.
      child?.on?.('error', () => {});
      child?.unref?.();
      lastAt = at;
      return true;
    } catch {
      return false;
    }
  }

  return { ring };
}
