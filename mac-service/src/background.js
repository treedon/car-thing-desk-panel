// Background sessions: the jobs `claude --bg` starts. They run under the
// daemon rather than a terminal, so there is often no window to raise and no
// owner at a keyboard to answer an ask — the two things this module tells the
// rest of the service about.

import { hostWindowFor } from './focus.js';

// How long a held hook waits for the owner before giving up. Claude Code's own
// hook timeout is 600 s; answering just under it lets us return a deliberate
// "not answered" instead of being cut off mid-reply.
export const BG_HOLD_MS = 590_000;

// What a background session is told when its ask times out unanswered.
export const UNAVAILABLE_REASON = "The owner wasn't at the desk panel to answer this, so it was not done. Don't retry it now. End your turn and say in your final message what you need from them.";

// A background job nothing is parked on has no window to show: "Open in VS
// Code" has nowhere to go. A job an interactive window has taken over (its
// `parkedJobId`) is not windowless — that window is its UI.
export function isWindowlessBackground(raw, hostWindow = hostWindowFor) {
  if (!raw || raw.kind !== 'background') return false;
  return !hostWindow({ jobId: raw.jobId, sessionId: raw.id });
}

// Whether an ask from this session id is a background session's: held for the panel rather than
// handed back to a window. `started(id)` is whether this service itself just started the session (see
// new-session.js). The poller tags a new session's `kind` only every few seconds, and an ask in that
// gap would otherwise read as an interactive window's, so a started session counts as background
// until a kind is known. Once the registry has said which it is (interactive, say, after a handoff
// into VS Code), the registry decides.
export function isBackgroundSession(raw, started, id, hostWindow = hostWindowFor) {
  return isWindowlessBackground(raw, hostWindow) || (!(raw && raw.kind) && !!started(id));
}

// What the store records when a message from the panel is delivered. `line` is the owner's words as the
// next turn's intent line. A wake (the Stop hook's asyncRewake poller exiting 2) starts a turn without a
// UserPromptSubmit, and nothing else clears the stop of the turn before, so for a background session the
// woken turn would still read as over until its first tool call, and the Open row would stop it mid-turn
// (see turnEnded). A wake marks it running here. Interactive sessions are unchanged: the owner is at the
// window, and its own hooks follow.
export function deliveredFields(raw, via, line) {
  const fields = { lastPrompt: line };
  if (via === 'wake' && raw && raw.kind === 'background') {
    fields.stoppedTs = null;
    fields.thinking = true;
  }
  return fields;
}

// The session's turn is over for good: it stopped, nothing is held on a
// permission, and nothing it started is still running (a stopped turn with a
// background task or a scheduled wakeup resumes by itself).
export function turnEnded(raw) {
  if (!raw || !raw.stoppedTs) return false;
  if (raw.pendingPermission) return false;
  return !(raw.waitingOn && raw.waitingOn.length);
}
