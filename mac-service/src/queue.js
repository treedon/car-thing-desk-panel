// Everything waiting on a human, in one list: tool permissions (held by the
// permission bridge) and multiple-choice questions (AskUserQuestion).
//
// Important asymmetry, verified against Claude Code:
//   • Permissions CAN be answered programmatically — the PermissionRequest
//     hook's response carries the decision.
//   • Questions CANNOT. No hook can supply a tool result, so answering one
//     from the device means focusing that terminal and typing the choice.
//     If macOS denies Automation, we focus the window and tell the user to
//     press the key themselves.
//   • Plan approval (ExitPlanMode) fires a PermissionRequest hook but IGNORES
//     the hook's decision — the terminal dialog stays up after behavior:"allow"
//     and the session stays blocked. So plans go through the question path:
//     surface on the device, answer by focus + keypress.
//
// One AskUserQuestion tool call carries a LIST of questions and is ONE dialog:
// the terminal walks its questions in order and ends on a "Submit answers"
// step. So it is one ask here too. Splitting it per question — which this
// used to do — left that submit step with no card, no keypress, and the
// session blocked forever on a dialog every question of which was answered.

import crypto from 'node:crypto';
import { log } from './log.js';

// Overridable so tests can watch an ask time out without waiting ten minutes.
const QUESTION_TTL_MS = Number(process.env.CLAUDE_THING_QUESTION_TTL_MS ?? 10 * 60_000);
const MAX_EXPIRED = 32;

// Questions and plans are answered from the panel through the PreToolUse hook
// (question-bridge.js). An ask that reaches this queue instead (asked before a
// panel connected) is never typed into: answering it raises the window on the
// Mac, and the owner answers there.

// Answers arrive as number[][] — one entry per question, each the option
// indices chosen for it. A pre-group client sending a bare optionIndex still
// works, as long as the ask really is one single-select question.
function normalizeAnswers(raw, questions) {
  const list = Array.isArray(raw) ? raw : [[raw]];
  if (list.length !== questions.length) return null;
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const picks = Array.isArray(list[i]) ? list[i] : [list[i]];
    const q = questions[i];
    // A single-select question is exactly one option. A multiSelect may be
    // none — "none of these" is an answer, and refusing it left the device
    // with a set it could never submit.
    if (!q.multiSelect && picks.length !== 1) return null;
    for (const p of picks) {
      if (!Number.isInteger(p) || p < 0 || p >= q.options.length) return null;
    }
    // A repeated index would toggle an option off again; the device never
    // sends one, and honouring it would type a key that undoes itself.
    if (new Set(picks).size !== picks.length) return null;
    out.push(picks);
  }
  return out;
}

function shapeQuestion(q) {
  const options = (q.options || []).slice(0, 8).map((o) => ({
    label: String(o.label || '').slice(0, 60),
    description: String(o.description || '').slice(0, 120),
  }));
  return {
    header: (q.header || 'QUESTION').toUpperCase(),
    question: String(q.question || '').slice(0, 300),
    options,
    multiSelect: !!q.multiSelect,
  };
}

// `folderFor(id, raw)` is the folder a window is raised for: the one the session started in (index.js
// passes the real one, see sessionStartFolder in new-session.js); by default the record's own cwd.
export function createQueue({ emit, store, focus, folderFor = (id, raw) => raw && raw.cwd }) {
  const questions = new Map();   // id -> ask
  const expired = new Map();     // id -> ask, timed out but still on screen

  function sessionName(sessionId) {
    const d = store.get(sessionId);
    return d ? d.name : 'session';
  }

  // What the user asked for, carried on every ask as its intent line. Empty
  // when no prompt has been seen; the device then omits the line.
  function intentFor(sessionId) {
    const s = sessionId && store.raw(sessionId);
    return s && s.lastPrompt ? `you asked: ${s.lastPrompt}` : '';
  }

  // One ask per dialog: every question the tool call carries rides on the same
  // card, and the device answers them all before anything is typed. A question
  // with no options can't be answered by a keypress, so it is dropped — and if
  // that leaves nothing, so is the whole ask.
  //
  // The top-level header/question/options/multiSelect mirror questions[0]. They
  // are what a client that predates grouping reads, and they keep the card's
  // summary line derivable without unwrapping the list.
  function onQuestion(payload) {
    const input = payload.tool_input || {};
    const list = (Array.isArray(input.questions) ? input.questions : [])
      .map(shapeQuestion)
      .filter((q) => q.options.length);
    if (!list.length) return;

    const id = crypto.randomUUID();
    const ask = {
      kind: 'question',
      id,
      sessionId: payload.session_id || null,
      sessionName: sessionName(payload.session_id),
      intent: intentFor(payload.session_id),
      questions: list,
      header: list[0].header,
      question: list[0].question,
      options: list[0].options,
      multiSelect: list[0].multiSelect,
      createdTs: Date.now(),
    };
    questions.set(id, ask);
    // unref: a pending question must never be the reason the process stays up
    setTimeout(() => expire(id), QUESTION_TTL_MS).unref();
    emit('claude.question.request', ask);
    log('QQ', `question queued: ${ask.header} (${list.length} question${list.length === 1 ? '' : 's'})`);
  }

  // Called from the PermissionRequest hook when Claude presents a plan. The
  // dialog's approve choices are always the first two entries, and picking
  // either is a single digit keypress — exactly a question. The decline paths
  // need typed feedback, so they stay on the keyboard.
  function onPlanApproval(payload) {
    const plan = String((payload.tool_input || {}).plan || '');
    const heading = plan.split('\n').find((l) => l.trim());
    const id = crypto.randomUUID();
    const ask = {
      kind: 'question',
      id,
      sessionId: payload.session_id || null,
      sessionName: sessionName(payload.session_id),
      intent: intentFor(payload.session_id),
      questions: [shapeQuestion({
        header: 'PLAN',
        question: (heading || 'Ready to code?').replace(/^#+\s*/, ''),
        options: [
          { label: 'Yes, bypass permissions', description: 'approve the plan and run without permission prompts' },
          { label: 'Yes, manually approve', description: 'approve the plan and confirm each edit' },
        ],
      })],
      createdTs: Date.now(),
    };
    // A plan is one question, so the mirrors are the whole card — and being one
    // question is what keeps it a single digit with no trailing Return.
    ask.header = ask.questions[0].header;
    ask.question = ask.questions[0].question;
    ask.options = ask.questions[0].options;
    ask.multiSelect = false;
    questions.set(id, ask);
    setTimeout(() => expire(id), QUESTION_TTL_MS).unref();
    if (ask.sessionId) store.touch(ask.sessionId, { waitingForInput: true });
    emit('claude.question.request', ask);
    log('QQ', `plan queued: ${ask.question.slice(0, 60)}`);
  }

  // The terminal prompt is gone once the tool returns, so drop ours too.
  function onQuestionAnswered(payload) {
    const sessionId = payload.session_id;
    for (const [id, ask] of questions) {
      if (ask.sessionId === sessionId) {
        questions.delete(id);
        emit('claude.question.resolved', { id, resolution: 'answered' });
      }
    }
    // A timed-out ask the terminal has now answered is finished for good; it
    // must not linger as something the device can still raise a window for.
    for (const [id, ask] of expired) {
      if (ask.sessionId === sessionId) {
        expired.delete(id);
        emit('claude.question.resolved', { id, resolution: 'answered' });
      }
    }
  }

  // Esc kills the terminal dialog without firing any hook — no PostToolUse, no
  // Stop — so the transcript tail's interrupt marker lands here. Unlike a
  // timeout, an interrupted ask is dead everywhere: the dialog is gone from the
  // terminal, so it leaves the expired map too — nothing to raise a window for.
  // Only asks older than the marker die: the tail replays the whole transcript
  // on catch-up, and a stale marker must not kill a fresh ask.
  function onInterrupted(sessionId, ts) {
    for (const map of [questions, expired]) {
      for (const [id, ask] of map) {
        if (ask.sessionId === sessionId && ask.createdTs <= ts) {
          map.delete(id);
          emit('claude.question.resolved', { id, resolution: 'interrupted' });
          log('QQ', `question interrupted: ${ask.header}`);
        }
      }
    }
  }

  // A timed-out question leaves the queue but stays on the device on purpose —
  // it is still up in the terminal, and the card is how you get back to it. So
  // keep the ask itself around: pressing an expired card must still raise that
  // window rather than report a generic failure. Bounded, and only until the
  // ask is twice as old as the TTL that retired it.
  function expire(id) {
    const ask = questions.get(id);
    if (!ask) return;
    questions.delete(id);
    expired.set(id, ask);
    while (expired.size > MAX_EXPIRED) expired.delete(expired.keys().next().value);
    setTimeout(() => expired.delete(id), QUESTION_TTL_MS).unref();
    emit('claude.question.resolved', { id, resolution: 'timeout' });
  }

  async function answerQuestion(id, rawAnswers) {
    const ask = questions.get(id) || expired.get(id);
    if (!ask) {
      log('QQ', `answer refused: ${id.slice(0, 8)} already resolved`);
      return { accepted: false, reason: 'already resolved' };
    }
    // Nothing is ever typed into VS Code. Questions there are answered through
    // the PreToolUse hook (question-bridge.js); reaching this path means the
    // hook did not catch it, and the owner answers in VS Code itself.
    const raw = ask.sessionId && store.raw(ask.sessionId);
    if (raw && raw.host === 'vscode') throw new Error('answer-in-vscode');
    // A malformed answer is refused before anything on the Mac moves.
    const answers = normalizeAnswers(rawAnswers, ask.questions);
    if (!answers) return { accepted: false, reason: 'bad answer shape' };
    const chosen = ask.questions
      .map((q, i) => answers[i].map((p) => q.options[p].label).join(' + ') || 'none')
      .join(' · ');

    // One window raise at a time: two arriving together must not leave the
    // wrong window in front.
    return focus.exclusive(async () => {
      if (!questions.has(id) && !expired.has(id)) {
        log('QQ', `answer dropped: ${id.slice(0, 8)} resolved while queued`);
        return { accepted: false, reason: 'already resolved' };
      }
      const timedOut = !questions.has(id);
      const f = ask.sessionId
        ? await focus.focusSession(ask.sessionId, { host: raw && raw.host, cwd: folderFor(ask.sessionId, raw) })
        : { focused: false, reason: 'unknown session' };
      log('QQ', `answer-on-mac ${f.focused ? 'raised' : 'failed'}: ${ask.header} → ${chosen}`);
      return {
        accepted: false,
        viaKeyboard: false,
        option: chosen,
        focused: f.focused,
        timedOut,
        reason: f.focused ? 'answer-on-mac' : f.reason,
      };
    });
  }

  function list() {
    return [...questions.values()].sort((a, b) => a.createdTs - b.createdTs);
  }

  return { onQuestion, onPlanApproval, onQuestionAnswered, onInterrupted, answerQuestion, list, size: () => questions.size };
}
