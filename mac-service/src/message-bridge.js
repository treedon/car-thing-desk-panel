// A message from the owner, dictated on the panel, delivered to a session only
// through documented hooks — never typed:
//   • working: the next PostToolUse hook returns it as additionalContext
//   • idle: the Stop hook's asyncRewake poller (scripts/rewake-hook.js) waits on
//     GET /hook/rewake; handed the text, it exits 2 and Claude wakes with it
// At most one message waits per session; a newer one replaces it. If the owner
// types in Claude Code first, the waiting message is dropped, never delivered
// late on top of the new prompt. Every delivery also tells onDelivered the
// owner's plain words and how it arrived ('wake' or 'next-tool'), so the service
// can record what the next turn answers.
import { log } from './log.js';

export const MESSAGE_PREFIX = 'Message from the owner via the desk panel: ';

export function createMessageBridge({ emit, onDelivered = () => {} }) {
  const pending = new Map(); // sessionId -> text (prefixed)
  const waiters = new Map(); // sessionId -> Set<resolve>

  function delivered(sessionId, via, message) {
    emit('claude.message.delivered', { sessionId, via });
    log('MB', `message delivered to ${String(sessionId).slice(0, 8)} via ${via}`);
    // A listener's failure must not undo a delivery that already happened.
    try { onDelivered(sessionId, message.slice(MESSAGE_PREFIX.length), via); } catch (e) {
      log('MB', `onDelivered failed: ${e && e.message}`);
    }
  }

  function takeWaiter(sessionId) {
    const set = waiters.get(sessionId);
    if (!set || !set.size) return null;
    const resolve = set.values().next().value;
    set.delete(resolve);
    return resolve;
  }

  function send(sessionId, text) {
    const body = String(text || '').trim();
    if (!sessionId || !body) throw new Error('empty-message');
    const message = MESSAGE_PREFIX + body;
    const waiter = takeWaiter(sessionId);
    if (waiter) {
      waiter(message);
      delivered(sessionId, 'wake', message);
      return 'woke';
    }
    if (pending.has(sessionId)) emit('claude.message.dropped', { sessionId, reason: 'replaced' });
    pending.set(sessionId, message);
    return 'queued';
  }

  function onPostToolUse(input) {
    const id = input && input.session_id;
    if (!id || !pending.has(id)) return null;
    const message = pending.get(id);
    pending.delete(id);
    delivered(id, 'next-tool', message);
    return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: message } };
  }

  function waitForIdleMessage(sessionId, signal) {
    if (pending.has(sessionId)) {
      const message = pending.get(sessionId);
      pending.delete(sessionId);
      delivered(sessionId, 'wake', message);
      return Promise.resolve(message);
    }
    return new Promise((resolve) => {
      let set = waiters.get(sessionId);
      if (!set) waiters.set(sessionId, (set = new Set()));
      const done = (v) => { set.delete(done); resolve(v); };
      set.add(done);
      if (signal) {
        if (signal.aborted) return done(null);
        signal.addEventListener('abort', () => done(null), { once: true });
      }
    });
  }

  // The owner typed a prompt: their own words win. Drop what was waiting and
  // let an idle poller exit quietly (the session is working again).
  function onUserPromptSubmit(input) {
    const id = input && input.session_id;
    if (!id) return;
    if (pending.delete(id)) emit('claude.message.dropped', { sessionId: id, reason: 'owner-typed' });
    const set = waiters.get(id);
    if (set) for (const w of [...set]) w(null);
  }

  function hasWaiter(sessionId) {
    const set = waiters.get(sessionId);
    return !!(set && set.size);
  }

  return { send, onPostToolUse, waitForIdleMessage, onUserPromptSubmit, hasWaiter, hasPending: (id) => pending.has(id) };
}

// How a message reaches a session, from what the session is doing now. An idle
// session can only be woken while its Stop hook's poller is listening (up to an
// hour after the turn ended, and only with the hooks installed). Otherwise it
// is not sent at all: the next turn starts with the owner typing, which would
// drop it anyway, so the panel says plainly that it went nowhere.
// A session the service doesn't know can't receive anything; a question with
// several parts is answered part by part on the panel's question screen.
export function chooseDelivery({ known = true, promptHeld, promptParts = 1, working, pollerWaiting }) {
  if (!known) return 'unknown-session';
  if (promptHeld) return promptParts > 1 ? 'answer-on-panel' : 'answer';
  if (working) return 'next-tool';
  return pollerWaiting ? 'wake' : 'cannot-wake';
}
