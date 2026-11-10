// Holds Claude Code PermissionRequest hook HTTP responses until a device
// answers or PERMISSION_HOLD_MS elapses. An interactive session's timeout
// answers behavior:"ask" so the normal terminal prompt takes over — it is never
// auto-denied. A windowless background session has no prompt to take over (its
// dialog is invisible, so the agent would just sit there): its ask is held for
// BG_HOLD_MS, survives the panel dropping off, and ends in a deliberate deny
// that tells the agent why.

import crypto from 'node:crypto';
import { PERMISSION_HOLD_MS } from './config.js';
import { BG_HOLD_MS, UNAVAILABLE_REASON } from './background.js';
import { log } from './log.js';
import { summarizeTool } from './tool-summary.js';

// A command you cannot take back must not cost the same gesture as "read a
// file" — the device asks for a second press on anything flagged here. Kept
// verbatim in sync with device-app/src/screens/helpers.js, which still runs it
// as the fallback against old daemons. Classified HERE, against the full
// command, because the device only ever sees the first 200 characters — a
// --force past the truncation was invisible to its regex.
const DESTRUCTIVE_RE = /\brm\s+-|--force\b|--hard\b|\bDROP\s|\bTRUNCATE\b|\bmkfs|\bdd\s+if=|\bchmod\s+777\b|curl[^|]*\|\s*(ba|z)?sh/i;

// panelOnline: whether a screen is connected that could answer. Without one,
// holding only stalls the session, so the hook answers "ask" at once.
// isBackground(sessionId): whether the session is a windowless background one —
// there "ask" would land on a dialog nobody can see, so it is held for bgHoldMs
// instead (with or without a panel) and finishes as a deny with a reason.
export function createPermissionBridge({
  emit, store, queue, panelOnline = () => true, isBackground = () => false, bgHoldMs = BG_HOLD_MS,
}) {
  const pending = new Map(); // requestId -> {res, timer, sessionId, ..., background}

  // 'deny-unavailable' is a deny that carries UNAVAILABLE_REASON. The text goes
  // in decision.message — verified on Claude Code 2.1.319, which quotes it to
  // the agent; a `reason` field there is ignored.
  function hookDecision(behavior) {
    const decision = behavior === 'deny-unavailable'
      ? { behavior: 'deny', message: UNAVAILABLE_REASON }
      : { behavior };
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision,
      },
    });
  }

  // What the user asked for, for the ask's intent line — the difference
  // between a confident yes and a walk to the laptop. Empty when no prompt has
  // been seen for the session; the device then simply omits the line.
  function intentFor(sessionId) {
    const s = sessionId && store.raw(sessionId);
    return s && s.lastPrompt ? `you asked: ${s.lastPrompt}` : '';
  }

  function finish(requestId, resolution, behavior) {
    const p = pending.get(requestId);
    if (!p) return false;
    pending.delete(requestId);
    clearTimeout(p.timer);
    try {
      p.res.writeHead(200, { 'Content-Type': 'application/json' });
      p.res.end(behavior ? hookDecision(behavior) : hookDecision('ask'));
    } catch {}
    if (p.sessionId) {
      store.upsert(p.sessionId, { pendingPermission: false, permission: null });
    }
    emit('claude.permission.resolved', { requestId, resolution });
    log('PB', `permission ${requestId} -> ${resolution}`);
    return true;
  }

  // Called by http-server with the parsed hook payload + held response object.
  function onHookRequest(payload, res) {
    // Two tools are dialogs, not permissions, and both already reach the
    // device through the question queue:
    //   • ExitPlanMode — Claude Code ignores the decision for it and keeps its
    //     dialog up (verified v2.1.220), so holding only makes the tile lie.
    //     The plan is surfaced here, since no other hook carries it.
    //   • AskUserQuestion — the PreToolUse hook already queued the real
    //     multiple-choice card (sessions/source-hooks.js). Holding a
    //     permission for the same call put a second card on the device whose
    //     body was the stringified questions array, and denying it killed the
    //     question before the user could answer the card that mattered.
    // Both answer "ask" at once and leave the interaction to the question path.
    if (queue && (payload.tool_name === 'ExitPlanMode' || payload.tool_name === 'AskUserQuestion')) {
      try {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(hookDecision('ask'));
      } catch {}
      // Only the plan needs queueing — re-queueing the question here would
      // duplicate the PreToolUse ask under a second id.
      if (payload.tool_name === 'ExitPlanMode') queue.onPlanApproval(payload);
      return;
    }

    const sessionId = payload.session_id || null;
    const bg = !!isBackground(sessionId);

    // A background session is held even with no panel: the panel may reconnect
    // within the hold, and "ask" here would strand the agent on a hidden dialog.
    if (!bg && !panelOnline()) {
      try {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(hookDecision('ask'));
      } catch {}
      return;
    }

    const requestId = crypto.randomUUID();
    const tool = payload.tool_name || 'unknown';
    const summary = summarizeTool(tool, payload.tool_input);
    const intent = intentFor(sessionId);
    const createdTs = Date.now();
    // Against the untruncated command when there is one, else the summary.
    const salient = (payload.tool_input && payload.tool_input.command) || summary;
    const destructive = DESTRUCTIVE_RE.test(String(salient || ''));

    const holdMs = bg ? bgHoldMs : PERMISSION_HOLD_MS;
    // The hold's end: an interactive ask goes back to the visible dialog; a
    // background one has none, so it is denied with the reason instead.
    const [onTimeout, timeoutBehavior] = bg ? ['unavailable', 'deny-unavailable'] : ['timeout', 'ask'];
    const timer = setTimeout(() => finish(requestId, onTimeout, timeoutBehavior), holdMs);
    timer.unref();
    pending.set(requestId, { res, timer, sessionId, tool, summary, intent, createdTs, destructive, background: bg });
    res.on('close', () => {
      // hook side gave up (Claude Code timeout / session killed). An interactive ask is then on the
      // terminal's own dialog ('timeout': the panel says to answer there). A background session has no
      // terminal: it was stopped while the ask was held, so the ask is simply gone ('abandoned').
      if (pending.has(requestId)) {
        pending.delete(requestId);
        clearTimeout(timer);
        if (sessionId) store.upsert(sessionId, { pendingPermission: false, permission: null });
        emit('claude.permission.resolved', { requestId, resolution: bg ? 'abandoned' : 'timeout' });
      }
    });

    const permission = { requestId, tool, summary, intent, createdTs, timeoutMs: holdMs, destructive, background: bg };
    if (sessionId) {
      store.touch(sessionId, {
        pendingPermission: true,
        permission,
        cwd: payload.cwd || undefined,
        currentTool: tool,
      });
    }
    emit('claude.permission.request', { ...permission, sessionId });
    log('PB', `permission held: ${summary} (${requestId})`);
  }

  function answer(requestId, decision) {
    if (decision !== 'allow' && decision !== 'deny') {
      throw new Error('decision must be allow|deny');
    }
    return finish(requestId, decision, decision);
  }

  // Esc during a held permission usually closes the hook's socket and the
  // res 'close' handler cleans up — but not always by the time the transcript
  // marker lands. Releasing with "ask" is safe either way: the turn is dead,
  // so nobody is left to show a prompt. The createdTs guard keeps replayed
  // markers from touching a permission raised after the interrupt.
  function cancelSession(sessionId, ts) {
    for (const [id, p] of pending) {
      if (p.sessionId === sessionId && p.createdTs <= ts) finish(id, 'interrupted', 'ask');
    }
  }

  // The last panel left: nobody can answer, so hand every held request back
  // to Claude Code's own prompt now rather than at the hold's end. A background
  // session's ask stays held — its prompt is invisible, so handing it back would
  // strand the agent; it waits out its hold for the panel to return.
  function releaseAll(reason) {
    let n = 0;
    for (const [id, p] of [...pending]) if (!p.background && finish(id, reason, 'ask')) n++;
    return n;
  }

  // Pending permissions as queue entries, for clients that connect late.
  function list() {
    return [...pending.entries()].map(([id, p]) => ({
      kind: 'permission',
      id,
      sessionId: p.sessionId,
      sessionName: p.sessionId && store.get(p.sessionId) ? store.get(p.sessionId).name : 'session',
      tool: p.tool,
      summary: p.summary,
      intent: p.intent || '',
      createdTs: p.createdTs,
      timeoutMs: p.background ? bgHoldMs : PERMISSION_HOLD_MS,
      destructive: !!p.destructive,
      background: !!p.background,
    })).sort((a, b) => a.createdTs - b.createdTs);
  }

  return { onHookRequest, answer, cancelSession, releaseAll, list, pendingCount: () => pending.size };
}
