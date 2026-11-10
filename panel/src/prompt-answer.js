// Answering a question or plan the Mac service is holding (claude.prompt.*).
// Pure: the screen keeps `ui` and calls these, then sends `send` when set.
//
// ui = { q: index of the question on screen, answers: {questionText: string},
//        picks: labels toggled on for the current multi-select question }
// Answer shapes match the service: {kind:'choice', answers} | {kind:'approve'}
// | {kind:'feedback', text} | {kind:'vscode'}.

export function startPrompt() {
  return { q: 0, answers: {}, picks: [] };
}

export function isPlan(p) {
  return p.tool === 'ExitPlanMode';
}

export function currentQuestion(p, ui) {
  var qs = p.questions || [];
  return qs[Math.min(ui.q, qs.length - 1)] || null;
}

// A background session has no window to hand the ask to — the service refuses
// the answer — so its rows leave out Answer in VS Code (p.background).
export function promptRows(p, ui) {
  if (isPlan(p)) {
    return p.background ? [{ kind: 'approve' }, { kind: 'say' }] : [{ kind: 'approve' }, { kind: 'say' }, { kind: 'vscode' }];
  }
  var q = currentQuestion(p, ui);
  var rows = [];
  var opts = (q && q.options) || [];
  for (var i = 0; i < opts.length; i++) {
    rows.push({
      kind: 'option', index: i, label: opts[i].label, description: opts[i].description || '',
      picked: ui.picks.indexOf(opts[i].label) >= 0,
    });
  }
  rows.push({ kind: 'say' });
  if (!p.background) rows.push({ kind: 'vscode' });
  return rows;
}

function copy(ui) {
  var answers = {};
  for (var k in ui.answers) answers[k] = ui.answers[k];
  return { q: ui.q, answers: answers, picks: ui.picks.slice() };
}

// Record the current question's answer, then move on or send the whole set.
function answerCurrent(p, ui, text) {
  if (!currentQuestion(p, ui)) return { ui: ui, send: null };
  var next = copy(ui);
  next.answers[currentQuestion(p, ui).question] = text;
  next.picks = [];
  if (next.q < p.questions.length - 1) {
    next.q++;
    return { ui: next, send: null };
  }
  return { ui: next, send: { kind: 'choice', answers: next.answers } };
}

export function pressRow(p, ui, rowIndex) {
  var row = promptRows(p, ui)[rowIndex];
  if (!row) return { ui: ui, send: null };
  if (row.kind === 'vscode') return { ui: ui, send: { kind: 'vscode' } };
  if (row.kind === 'approve') return { ui: ui, send: { kind: 'approve' } };
  if (row.kind === 'say') return { ui: ui, send: null, dictate: true };
  var q = currentQuestion(p, ui);
  if (!q.multiSelect) return answerCurrent(p, ui, row.label);
  var next = copy(ui);
  var at = next.picks.indexOf(row.label);
  if (at >= 0) next.picks.splice(at, 1);
  else next.picks.push(row.label);
  return { ui: next, send: null };
}

// The top button confirms a multi-select question. Labels are joined with ", "
// in the order they were picked, as Claude Code's own dialog does.
export function confirmPicks(p, ui) {
  var q = currentQuestion(p, ui);
  if (!q || !q.multiSelect) return { ui: ui, send: null };
  if (!ui.picks.length) return { ui: ui, send: null, error: 'Pick at least one' };
  return answerCurrent(p, ui, ui.picks.join(', '));
}

// Dictated text: the current question's answer, or the plan's feedback.
export function answerWithText(p, ui, text) {
  var t = String(text || '').trim();
  if (!t) return { ui: ui, send: null };
  if (isPlan(p)) return { ui: ui, send: { kind: 'feedback', text: t } };
  return answerCurrent(p, ui, t);
}

// Back inside a multi-question prompt steps to the previous question.
export function backQuestion(p, ui) {
  if (isPlan(p) || ui.q === 0) return null;
  var next = copy(ui);
  next.q--;
  next.picks = [];
  delete next.answers[currentQuestion(p, next).question];
  return next;
}

// Claude is blocked until it is answered, and the hold lasts two minutes, so a
// new question or plan opens itself — except over another one being answered
// or a dictation in progress, where it waits its turn in the queue.
// onScreen: the prompt currently shown, when routeName is 'prompt' (null if it
// is already gone). A card that has moved to VS Code is not being answered.
export function opensOnArrival(routeName, onScreen) {
  if (routeName === 'dictate') return false;
  if (routeName === 'prompt') return !onScreen || !!onScreen.expired;
  return true;
}
