// Ingests Claude Code hook events POSTed to /hook and keeps the store current.
// Transcript tailing is shared with the poller through the tails registry.

import path from 'node:path';
import { ensureTail, stopTail, stopAllTails, transcriptPathFor } from './tails.js';
import { isOwnSession } from '../own-sessions.js';
import { lookupSession } from '../focus.js';
import { log } from '../log.js';
import { waitingOnFrom } from './waiting-on.js';
import { lastAssistantText } from './recent-messages.js';
import { tagTurn } from '../turn-tag.js';

// What the owner typed, as one line: the intent of every ask and card raised
// during the turn it began.
export function promptLine(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

// A StopFailure's `error` is a string on some builds and an object on others,
// and its exact shape is not pinned down. Either way it becomes one line of
// text, and anything else becomes nothing rather than a throw.
function errorText(v) {
  if (typeof v === 'string') return v.trim();
  if (v && typeof v === 'object') return String(v.message || v.type || '').trim();
  return '';
}

export function startHooksSource({ store, queue, inbox, readLastText = lastAssistantText, defer = setImmediate }) {
  // A finished turn becomes a card. This runs inside the hook request, which
  // Claude Code waits on, so nothing here may be slow and nothing here may
  // throw: the card is a courtesy, the hook's answer is not.
  function postCard(id, card, text) {
    try {
      inbox.post({ ...card, text });
    } catch (err) {
      log('IB', `post failed for ${id.slice(0, 8)}: ${err.message}`);
    }
  }

  // Tell the inbox a turn of this session stopped, before anything is posted: a
  // turn that posts no card (background work held it back) or whose card is
  // cleared still ended, and a late digest for it must not be taken for the
  // next turn's. Never throws, like postCard.
  function noteStop(id, stoppedTs) {
    try {
      inbox.noteStop(id, stoppedTs);
    } catch (err) {
      log('IB', `noteStop failed for ${id.slice(0, 8)}: ${err.message}`);
    }
  }

  // Everything about the card but its tag and text, read now: by the time a
  // deferred post runs the session may have been renamed or have a new prompt.
  function cardFor(id, stoppedTs) {
    const raw = store.raw(id);
    return {
      sessionId: id,
      sessionName: store.get(id).name,
      host: raw.host,
      intent: raw.lastPrompt ? `you asked: ${raw.lastPrompt}` : '',
      stoppedTs,
    };
  }

  function postFinishedTurn(id, payload, stoppedTs, waitingOn) {
    const card = cardFor(id, stoppedTs);
    const post = (text) => {
      const tag = tagTurn(text);
      // A turn that left work running will resume without the owner, so its
      // progress note is not yet news. A question still is: it needs an answer
      // whatever else is running.
      if (waitingOn.length && tag === 'update') return;
      postCard(id, { ...card, tag }, text);
    };
    if (typeof payload.last_assistant_message === 'string') {
      post(payload.last_assistant_message);
      return;
    }
    // Builds that leave the closing message off the payload leave it in the
    // transcript, and reading a file is not something Claude Code should wait
    // for. By then a new prompt or the end of the session may have come in; the
    // stop is no longer the session's latest word, so there is nothing to post.
    defer(() => {
      try {
        const now = store.raw(id);
        if (!now || now.stoppedTs !== stoppedTs) return;
        post(readLastText(payload.transcript_path || transcriptPathFor(id, payload.cwd || '')));
      } catch (err) {
        log('IB', `deferred card failed for ${id.slice(0, 8)}: ${err.message}`);
      }
    });
  }

  function onHookEvent(event, payload) {
    const id = payload.session_id;
    if (!id || isOwnSession(id)) return;
    const known = store.raw(id);
    // A session whose very first hook is SessionEnd was never on the grid, and
    // creating it now only adds a tile that is already dead. Short-lived
    // `claude` invocations — the daemon's own registry polls among them — end
    // this way, so this is the difference between a clean grid and a phantom
    // appearing every few seconds.
    if (!known && event === 'SessionEnd') return;
    const cwd = payload.cwd || '';
    // A hook's cwd is wherever the session currently is, which moves as the
    // agent cds around — so it must never overwrite a real name. The poller and
    // the session registry both carry the session's actual task name; the
    // directory basename is only a fallback for a session we have never named.
    const registryName = known && known.name ? null : (lookupSession(id) || {}).name;
    const base = { cwd: cwd || undefined };
    // The hook names the transcript's real path; remember it so the poller can
    // recognize this session as a real conversation even when the cwd-derived
    // path guess misses.
    if (payload.transcript_path) base.transcriptPath = payload.transcript_path;
    // Builds that put the current mode on the hook payload beat the transcript
    // record to it; ones that don't leave this undefined and the tail supplies
    // the mode a moment later.
    if (payload.permission_mode) base.permissionMode = String(payload.permission_mode);
    if (!known || !known.name) {
      base.name = registryName || (cwd ? path.basename(cwd) : undefined);
    }
    // Any hook but SessionEnd is proof of life. Ended sessions are deleted, not
    // flagged, so a session the poller dropped comes back as a fresh record —
    // this only has to make sure the flag never sticks on the way in.
    if (event !== 'SessionEnd') base.ended = false;
    ensureTail(store, id, payload.transcript_path || transcriptPathFor(id, cwd));

    switch (event) {
      case 'SessionStart':
        store.touch(id, { ...base, ended: false, startedTs: Date.now(), stoppedTs: null });
        break;
      case 'UserPromptSubmit':
        // The turn has begun and stays begun until Stop. Without this the
        // session reads idle through every pause for thought, because thinking
        // writes nothing and fires no hook.
        //
        // The prompt is also kept as lastPrompt: every ask raised during this
        // turn carries it as its intent line — a command without what you
        // asked for is an approval made blind. lastMessage gets overwritten by
        // the transcript tail as the turn progresses; this field does not.
        store.touch(id, {
          ...base, waitingForInput: false, stoppedTs: null, thinking: true,
          lastMessage: String(payload.prompt || '').slice(0, 200),
          lastPrompt: promptLine(payload.prompt),
          // A new prompt ends whatever the last turn was waiting on.
          waitingOn: [],
        });
        // A new prompt means no dialog is up. A declined plan or an Esc'd
        // question fires no PostToolUse, so this is where those asks die.
        if (queue) queue.onQuestionAnswered(payload);
        // Typing in the session means whatever its card said has been seen.
        if (inbox) inbox.clear(id, 'typed');
        break;
      case 'PreToolUse':
        store.touch(id, { ...base, currentTool: payload.tool_name || null, stoppedTs: null, waitingForInput: false, thinking: true });
        // The session resuming ends what its last turn was waiting on — but a
        // tool call from inside a subagent (agent_id present) is that very
        // subagent working, which is the thing being waited on, not the
        // session resuming. Only the main thread's tool calls clear the list.
        if (!payload.agent_id) store.touch(id, { waitingOn: [] });
        // A multiple-choice question is a tool call, so this is where the
        // device learns about it — no hook can answer one, only surface it.
        // When the panel's question bridge is holding the call, it carries
        // the question itself; queueing it here too would show it twice.
        if (payload.tool_name === 'AskUserQuestion' || (payload.heldByPanel && payload.tool_name === 'ExitPlanMode')) {
          store.touch(id, { waitingForInput: true });
          if (queue && !payload.heldByPanel && payload.tool_name === 'AskUserQuestion') queue.onQuestion(payload);
        }
        break;
      case 'PostToolUse':
        store.touch(id, { ...base, currentTool: null });
        // ExitPlanMode completing means the plan dialog was answered — the
        // plan ask came in through the permission bridge, but resolves here.
        if (queue && (payload.tool_name === 'AskUserQuestion' || payload.tool_name === 'ExitPlanMode')) {
          store.touch(id, { waitingForInput: false });
          queue.onQuestionAnswered(payload);
        }
        break;
      case 'Stop': {
        // A finished turn is not a block. Flagging waitingForInput here made
        // attention win the state machine's first test, so every completed turn
        // rendered ATTENTION forever instead of DONE decaying to IDLE. Reserve
        // waitingForInput for real blocks: permission asks and AskUserQuestion.
        //
        // A turn can end with work still running: a background shell, a
        // subagent, a one-shot wakeup. The Stop payload lists them, and while
        // any remain the session is waiting rather than done. The next prompt
        // or tool call — the session resuming — clears the list.
        const stoppedTs = Date.now();
        const waitingOn = waitingOnFrom(payload, stoppedTs);
        store.touch(id, {
          ...base, stoppedTs, currentTool: null, waitingForInput: false, thinking: false, waitingOn,
        });
        // The turn ending also ends any dialog we still hold an ask for.
        if (queue) queue.onQuestionAnswered(payload);
        if (inbox) {
          noteStop(id, stoppedTs);
          postFinishedTurn(id, payload, stoppedTs, waitingOn);
        }
        break;
      }
      case 'StopFailure': {
        // A turn that died on an API error. As far as the tile goes it is over
        // like any other. The payload says nothing about background work, and
        // a session woken by a finished job fires no UserPromptSubmit to clear
        // the list, so what the last Stop was waiting on is dropped here:
        // left in place it would keep the tile busy until the next prompt.
        // Anything still running that resumes the session sets it again.
        const stoppedTs = Date.now();
        store.touch(id, {
          ...base, stoppedTs, currentTool: null, waitingForInput: false, thinking: false, waitingOn: [],
        });
        if (queue) queue.onQuestionAnswered(payload);
        if (inbox) {
          noteStop(id, stoppedTs);
          // The card's excerpt is the text's closing paragraph, and what the
          // owner has to see is the error, not how far Claude got. So the
          // partial message comes first and the error and its details close
          // the text as one paragraph (blank lines inside it would split it).
          const failure = [errorText(payload.error), errorText(payload.error_details)].filter(Boolean).join('\n').replace(/\n\s*\n/g, '\n');
          const partial = errorText(payload.last_assistant_message);
          // Never blank: an error card with no words would read "finished with
          // no message", which is the opposite of what happened.
          const text = [partial, failure].filter(Boolean).join('\n\n') || 'The turn failed.';
          postCard(id, { ...cardFor(id, stoppedTs), tag: 'error' }, text);
        }
        break;
      }
      case 'Notification': {
        // Claude Code fires Notification for two unrelated things: a permission
        // ask, and a "still waiting for your input" nudge a minute after a turn
        // ends. The nudge is not a block — reading it as one flipped every
        // finished session back to ATTENTION once the DONE window had passed,
        // and nothing but the next prompt cleared it. Only the permission
        // flavour blocks, and this is the fallback for it: the connector's
        // permission bridge carries the real ask when it is installed.
        const asking = /permission|approve|allow|confirm/i.test(String(payload.message || ''));
        store.touch(id, asking ? { ...base, waitingForInput: true } : base);
        break;
      }
      case 'SessionEnd':
        // The farewell detail event is derived from this record, so it must say
        // idle: nothing in flight and no DONE minute left to celebrate, however
        // recently the last turn stopped or what it was waiting on when it died.
        store.upsert(id, { ...base, ended: true, currentTool: null, waitingForInput: false, waitingOn: [], stoppedTs: null });
        stopTail(id);
        if (inbox) inbox.onSessionEnd(id);
        break;
      default:
        store.touch(id, base);
    }
    log('HK', `${event} ${id.slice(0, 8)}`);
  }

  return { onHookEvent, stop: stopAllTails };
}
