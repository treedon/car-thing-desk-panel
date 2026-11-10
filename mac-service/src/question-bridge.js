// Answers Claude Code's questions (AskUserQuestion) and plans (ExitPlanMode)
// from the panel, through the PreToolUse hook, as the hooks docs describe:
//   • a question: permissionDecision "allow" + updatedInput {questions, answers}
//   • a plan approved: "allow" + updatedInput (the input echoed)
//   • plan feedback: "deny" + permissionDecisionReason, which Claude reads
//   • null: no opinion, so Claude Code shows its own dialog as usual
// A prompt is held only while a panel is connected, and never past holdMs; at
// the end of the hold, or when the panel leaves, it goes back to Claude Code's
// own dialog (null). A windowless background session has no dialog to go back
// to, so its prompt is held for bgHoldMs with or without a panel, survives the
// panel leaving, and ends in a deny that tells the agent why.
import crypto from 'node:crypto';
import { BG_HOLD_MS, UNAVAILABLE_REASON } from './background.js';
import { readRecentMessages } from './sessions/recent-messages.js';
import { log } from './log.js';

export const PROMPT_TOOLS = ['AskUserQuestion', 'ExitPlanMode'];
export const QUESTION_HOLD_MS = 120_000;
const CONTEXT_MESSAGES = 6;
const FEEDBACK_PREFIX = 'The user reviewed the plan on their desk panel and asked for changes: ';

function output(decision, extra) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, ...extra } };
}

// store (optional) names the session and supplies the intent line.
// isBackground(sessionId): whether the session is a windowless background one.
export function createQuestionBridge({
  emit, panelOnline, holdMs = QUESTION_HOLD_MS, store = null, isBackground = () => false, bgHoldMs = BG_HOLD_MS,
}) {
  const held = new Map(); // id -> {prompt, input, resolve, timer}

  function willHold(input) {
    return !!input && PROMPT_TOOLS.includes(input.tool_name)
      && (panelOnline() || !!isBackground(input.session_id || null));
  }

  function finish(id, result, resolution) {
    const h = held.get(id);
    if (!h) return false;
    held.delete(id);
    clearTimeout(h.timer);
    h.resolve(result);
    emit('claude.prompt.resolved', { id, sessionId: h.prompt.sessionId, resolution });
    log('QB', `prompt ${id.slice(0, 8)} -> ${resolution}`);
    return true;
  }

  function handlePreToolUse(input, signal) {
    if (!willHold(input)) return Promise.resolve(null);
    const id = crypto.randomUUID();
    const sessionId = input.session_id || null;
    const toolInput = input.tool_input || {};
    const bg = !!isBackground(sessionId);
    const raw = store && sessionId ? store.raw(sessionId) : null;
    const detail = store && sessionId ? store.get(sessionId) : null;
    const prompt = {
      kind: 'prompt',
      id,
      sessionId,
      sessionName: detail ? detail.name : 'session',
      intent: raw && raw.lastPrompt ? `you asked: ${raw.lastPrompt}` : '',
      tool: input.tool_name,
      context: input.transcript_path ? readRecentMessages(input.transcript_path, { limit: CONTEXT_MESSAGES }) : [],
      holdMs: bg ? bgHoldMs : holdMs,
      background: bg,
      createdTs: Date.now(),
    };
    if (input.tool_name === 'AskUserQuestion') prompt.questions = Array.isArray(toolInput.questions) ? toolInput.questions : [];
    else prompt.plan = String(toolInput.plan || '');

    return new Promise((resolve) => {
      // The hold's end: an interactive prompt goes back to the visible dialog; a
      // background one has none, so it is denied with the reason instead.
      const [onTimeout, timeoutResult] = bg
        ? ['unavailable', output('deny', { permissionDecisionReason: UNAVAILABLE_REASON })]
        : ['timeout', null];
      const timer = setTimeout(() => finish(id, timeoutResult, onTimeout), prompt.holdMs);
      timer.unref();
      held.set(id, { prompt, input: toolInput, resolve, timer });
      if (signal) {
        if (signal.aborted) return finish(id, null, 'abandoned');
        signal.addEventListener('abort', () => finish(id, null, 'abandoned'), { once: true });
      }
      emit('claude.prompt.created', prompt);
      log('QB', `holding ${input.tool_name} ${id.slice(0, 8)} for ${sessionId ? sessionId.slice(0, 8) : '?'}`);
    });
  }

  // Throws 'bad-answer' for an answer that does not fit the prompt (the prompt
  // stays held); returns false when the prompt is already gone.
  function answer(id, a) {
    const h = held.get(id);
    if (!h) return false;
    const isPlan = h.prompt.tool === 'ExitPlanMode';
    const kind = a && a.kind;
    // "Open in VS Code" hands the dialog back to Claude Code; a background
    // session has no window to show it in.
    if (kind === 'vscode') {
      if (h.prompt.background) throw new Error('bad-answer');
      return finish(id, null, 'vscode');
    }
    if (kind === 'choice' && !isPlan) {
      const answers = a.answers && typeof a.answers === 'object' ? a.answers : {};
      const keys = Object.keys(answers).filter((k) => typeof answers[k] === 'string' && answers[k].trim());
      if (!keys.length) throw new Error('bad-answer');
      const clean = {};
      for (const k of keys) clean[k] = answers[k].trim();
      return finish(id, output('allow', { updatedInput: { questions: h.input.questions, answers: clean } }), 'answered');
    }
    if (kind === 'approve' && isPlan) return finish(id, output('allow', { updatedInput: h.input }), 'approved');
    if (kind === 'feedback' && isPlan && a.text && String(a.text).trim()) {
      return finish(id, output('deny', { permissionDecisionReason: FEEDBACK_PREFIX + String(a.text).trim() }), 'feedback');
    }
    throw new Error('bad-answer');
  }

  // The last panel left: interactive prompts go back to Claude Code's dialog
  // now. A background prompt stays held — its dialog is invisible, so handing it
  // back would strand the agent; it waits out its hold for the panel to return.
  function releaseAll(reason) {
    let n = 0;
    for (const [id, h] of [...held]) if (!h.prompt.background && finish(id, null, reason)) n++;
    return n;
  }

  function list() {
    return [...held.values()].map((h) => h.prompt).sort((a, b) => a.createdTs - b.createdTs);
  }

  return { willHold, handlePreToolUse, answer, releaseAll, list };
}
