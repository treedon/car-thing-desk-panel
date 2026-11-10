import { esc, topbar, isDestructive, askHost } from './helpers.js';
import { now } from '../clock.js';
import { isCard, queueCounts, cardChipOf } from '../inbox.js';
import {
  questionsOf, currentQuestion, picksAt, isPicked, hasDoneRow, answeredLabels,
} from '../answering.js';

// Triage, not a list of equals: the ask you would answer next owns the page and
// carries its own actions, so a permission can be allowed without ever leaving
// this screen. Everything else stacks underneath as a preview of what's coming.
var STACK_MAX = 2;

export function renderQueue(state) {
  var bar = topbar('QUEUE', state.daemonConnected, state.asks.length ? String(state.asks.length) : '');

  if (!state.asks.length) {
    return '<div class="screen">' + bar +
      '<div class="qempty"><span class="qemptysprite"></span>' +
      '<div class="qemptytitle">NOTHING WAITING ON YOU</div>' +
      '<div class="qemptysub">permissions, questions and finished turns land here</div>' +
      chimeRow(state.chimeOn) + '</div></div>';
  }

  var index = Math.min(state.queueIndex, state.asks.length - 1);
  var heroAsk = state.asks[index];
  // A question is answered in place: its option list opens inside the hero
  // rather than routing to a whole-screen prompt for one press. A timed-out
  // question opens too — it is still up in the terminal and the daemon can
  // still type into it, and a multi-question ask has nowhere else to be walked.
  var answering = !!state.queueAnswering && heroAsk.kind === 'question';

  // While the list is open the stack rows give it their room; the footer keeps
  // the queue context alive so closing the list isn't a leap of faith.
  // An intent line costs the hero ~27px, and a card's summary (a headline and
  // up to three bullets) costs more than the excerpt it replaces, so the stack
  // gives one row back for either.
  var rows = '';
  var rest = [];
  if (!answering) {
    var stackMax = heroCostsARow(heroAsk) ? STACK_MAX - 1 : STACK_MAX;
    for (var i = 0; i < state.asks.length && rest.length < stackMax; i++) {
      if (state.asks[i].id !== heroAsk.id) rest.push(state.asks[i]);
    }
    for (var j = 0; j < rest.length; j++) rows += stackRow(rest[j]);
  }

  var foot, hint;
  if (answering) {
    var others = state.asks.length - 1;
    foot = others > 0 ? others + ' more waiting' : 'last one';
    // On a multiSelect the press toggles and pressing again just untoggles, so
    // the hint has to name what actually moves you on rather than imply the
    // press does.
    if (state.queueReview) hint = 'dial moves · press edits or submits · back returns';
    else if (hasDoneRow(currentQuestion(heroAsk, state))) hint = 'press picks · preset 3 when done';
    else hint = 'dial moves · press answers · back closes';
  } else {
    var shown = 1 + rest.length;
    foot = footCounts(state.asks) +
      (state.asks.length > shown ? ' · showing ' + shown : '');
    hint = 'turn dial or swipe for the next one';
  }

  return '<div class="screen">' + bar +
    '<div class="qwrap">' + hero(heroAsk, answering, state) + rows +
    '<div class="qfoot"><span>' + esc(foot) + '</span>' +
    '<span class="qfoothint">' + esc(hint) + '</span></div>' +
    '</div></div>';
}

function heroCostsARow(a) {
  return !!a.intent || (isCard(a) && !!cardSummary(a));
}

// What is waiting on the owner and what has merely finished are different
// numbers, and the zero one is left out rather than printed. A queue holding
// nothing but expired notices is waiting on the terminal, not on the owner.
function footCounts(asks) {
  var c = queueCounts(asks);
  var parts = [];
  if (c.waiting) parts.push(c.waiting + ' waiting on you');
  if (c.updates) parts.push(c.updates + (c.updates === 1 ? ' update' : ' updates'));
  return parts.length ? parts.join(' · ') : 'nothing waiting on you';
}

// The chime lives on the Mac; the panel only flips it. Until the Mac has said
// which way it is set there is nothing honest to show, so no row at all.
function chimeRow(on) {
  if (typeof on !== 'boolean') return '';
  return '<div class="qchime" data-action="toggle-chime">' +
    '<span class="qchimetitle">Chime on the Mac: ' + (on ? 'On' : 'Off') + '</span>' +
    '<span class="qchimesub">' + (on ? 'Plays when a session needs you' : 'The Mac stays quiet') + '</span>' +
    '</div>';
}

// A question or plan held by the Mac service's hook (kind 'prompt'): answered
// on its own screen, so the hero carries one chip that opens it.
function promptKind(a) {
  if (a.tool === 'ExitPlanMode') return 'PLAN';
  var n = (a.questions || []).length;
  return n > 1 ? 'QUESTION · ' + n + ' PARTS' : 'QUESTION';
}

function promptSummary(a) {
  if (a.tool === 'ExitPlanMode') {
    var heading = String(a.plan || '').split('\n').filter(function (l) { return l.trim(); })[0] || 'Ready to code?';
    return heading.replace(/^#+\s*/, '');
  }
  return (a.questions && a.questions[0] && a.questions[0].question) || 'Claude has a question';
}

function hero(a, answering, state) {
  if (isCard(a)) return cardHero(a, cardChipOf(state.queueCardSel, a));
  var isQuestion = a.kind === 'question' || a.kind === 'prompt';
  var kindClass = isQuestion ? ' question' : '';
  var nasty = !isQuestion && !a.expired && isDestructive(a);
  // A question hero opens its options in place, timed out or not; only a
  // permission still routes to the prompt screen on tap.
  var action = isQuestion ? 'queue-answer' : 'open-ask';
  var kind = a.kind === 'prompt' ? promptKind(a) : isQuestion ? questionKind(a, state, answering)
    : nasty ? 'PERMISSION REQUEST · DESTRUCTIVE' : 'PERMISSION REQUEST';
  // A command without intent is an approval made blind: what you asked for
  // sits right under the session name, and the layout pays for the line — the
  // name steps down and the stack loses a row (see renderQueue).
  var intent = a.intent
    ? '<div class="qintent">' + esc(a.intent) + '</div>' : '';
  return '<div class="qhero' + kindClass + (a.expired ? ' expired' : '') +
    (answering ? ' answering' : '') +
    (a.intent ? ' has-intent' : '') +
    (nasty ? ' destructive' : '') +
    '" data-action="' + action + '" data-id="' + esc(a.id) + '">' +
    '<span class="qhazard"></span>' +
    '<div class="qherobody">' +
    '<div class="qheroline"><span class="qkind">' + kind + '</span>' +
    '<span class="qwait">' + esc(waitLabel(a)) + '</span></div>' +
    '<div class="qherosession">' + esc(a.sessionName || 'session') + '</div>' +
    intent +
    '<div class="qherosummary">' + esc(summarize(a, state, answering)) + '</div>' +
    (a.kind === 'prompt'
      ? '<div class="qactions">' + (a.expired ? '<div class="qexpired">MOVED TO VS CODE</div>'
        : chip('answer', 'ANSWER', 'press dial', true)) + '</div>'
      : answering ? heroAnswering(a, state) : heroActions(a, isQuestion, nasty, state.armed, askHost(a, state))) +
    '</div></div>';
}

// The kind line carries where you are in the dialog, because a multi-question
// ask is several decisions deep and a card that just says QUESTION gives no
// way to tell the second from the third.
function questionKind(a, state, answering) {
  var total = questionsOf(a).length;
  if (answering && state.queueReview) return 'QUESTION · REVIEW';
  if (total < 2) return 'QUESTION';
  var at = Math.min(state.queueQIndex, total - 1) + 1;
  return answering ? 'QUESTION · ' + at + ' OF ' + total
    : 'QUESTION · ' + total + ' PARTS';
}

function heroAnswering(a, state) {
  return state.queueReview ? heroReview(a, state) : heroOptions(a, state);
}

// A timed-out permission has nothing left to press: the hook response is spent,
// so the chips are replaced by where the decision actually went.
function heroActions(a, isQuestion, nasty, armed, host) {
  // A timed-out QUESTION is not spent: the dialog is still up in the terminal
  // and the daemon can still type into it. So it says where it went and keeps
  // its chip. A timed-out permission has nothing left to press.
  if (a.expired && !isQuestion) {
    return '<div class="qactions"><div class="qexpired">HOOK TIMED OUT — ANSWER IN TERMINAL</div></div>';
  }
  // Nothing is ever typed into VS Code: a question the hooks did not take
  // over is answered there, and the one action raises its window.
  // An upstream card (asked before a panel was connected, so no hook is
  // holding it) can only be answered on the Mac; the chip raises the window.
  if (isQuestion) {
    return '<div class="qactions">' +
      (a.expired ? '<div class="qexpired">TIMED OUT — STILL OPEN IN TERMINAL</div>' : '') +
      (a.machine
        // The NucBox's service can't raise a window there: the card only says where.
        ? chip('vscode', 'ANSWER ON THE ' + String(a.machine).toUpperCase(), 'in VS Code there', true)
        : chip('vscode', host === 'vscode' ? 'ANSWER IN VS CODE' : 'ANSWER ON YOUR MAC', 'press dial · raises the window', true)) + '</div>';
  }
  if (isQuestion) {
    var qs = questionsOf(a);
    var hint = qs.length > 1
      ? qs.length + ' questions · press dial'
      : qs[0].options.length + ' option' + (qs[0].options.length === 1 ? '' : 's') + ' · press dial';
    return '<div class="qactions">' +
      (a.expired ? '<div class="qexpired">TIMED OUT — STILL OPEN IN TERMINAL</div>' : '') +
      chip('answer', 'ANSWER', hint, true) +
      '</div>';
  }
  // A destructive command must not cost the same gesture as "read that file":
  // the chip starts as an outline that says so, and the first press only arms
  // it — filled danger, PRESS AGAIN — for a 4s window.
  var isArmed = !!(armed && armed.id === a.id);
  var allow;
  if (isArmed) {
    allow = chip('allow', 'PRESS AGAIN', 'this cannot be undone', true, ' armed');
  } else if (nasty) {
    allow = chip('allow', 'ALLOW', 'press twice · destructive', false, ' destructive');
  } else {
    allow = chip('allow', 'ALLOW', 'press dial', true);
  }
  return '<div class="qactions">' + allow +
    chip('deny', 'DENY', 'preset 3', false) +
    '</div>';
}

// All options at once, no 3-wide window: the rows flex to share whatever
// height the (shrunken) name and question leave, so the whole decision is on
// screen before the first dial turn.
//
// Unselected rows stay one clipped line each; the row under the cursor grows
// and stacks its label over its description with both wrapping, so the text
// you are about to commit to is read in full, not guessed from an ellipsis.
// Every dial turn re-renders the list, so the markup can differ per row.
function heroOptions(a, state) {
  var q = currentQuestion(a, state);
  var opts = (q && q.options) || [];
  var choice = state.queueChoice;
  var multi = hasDoneRow(q);
  var qi = Math.min(state.queueQIndex, questionsOf(a).length - 1);
  var html = '<div class="qopts">';
  for (var i = 0; i < opts.length; i++) {
    // On a multiSelect question the number is a toggle, not a commit, so the
    // row has to show its own state — otherwise picking three options looks
    // identical to picking none.
    var on = multi && isPicked(state, qi, i);
    var num = '<span class="qnum' + (on ? ' on' : '') + '">' +
      (on ? '✓' : (i + 1)) + '</span>';
    var desc = opts[i].description
      ? '<span class="qdesc">' + esc(opts[i].description) + '</span>' : '';
    var cls = 'qopt' + (i === choice ? ' selected' : '') + (on ? ' picked' : '');
    if (i === choice) {
      html += '<div class="' + cls + '" data-action="queue-choice" data-id="' + i + '">' +
        num + '<div class="qtext"><span class="qlabel">' + esc(opts[i].label) + '</span>' +
        desc + '</div></div>';
    } else {
      html += '<div class="' + cls + '" data-action="queue-choice" data-id="' + i + '">' +
        num + '<span class="qlabel">' + esc(opts[i].label) + '</span>' + desc +
        '</div>';
    }
  }
  if (multi) {
    // The only row that moves you on, so it has to read as an action rather
    // than a fourth thing to tick — and it names the hardware button that does
    // the same job, because a press on an option only ever toggles it.
    var n = picksAt(state, qi).length;
    html += '<div class="qopt qstep next' + (choice === opts.length ? ' selected' : '') +
      '" data-action="queue-choice" data-id="' + opts.length + '">' +
      '<span class="qnum">›</span><span class="qlabel">DONE</span>' +
      '<span class="qdesc">' + n + ' selected · preset 3</span></div>';
  }
  return html + '</div>';
}

// The review step: every question with what it is currently answered as, and a
// SUBMIT row. This is the whole point of holding the answers locally — nothing
// has been typed into the terminal yet, so any row here is still changeable.
function heroReview(a, state) {
  var qs = questionsOf(a);
  var choice = state.queueChoice;
  var html = '<div class="qopts qreview">';
  for (var i = 0; i < qs.length; i++) {
    // "none" and "—" are different things: one is a multiSelect answered with
    // nothing ticked, the other is a question not yet reached.
    var chosen = answeredLabels(a, state, i) ||
      (qs[i].multiSelect ? 'none' : '—');
    html += '<div class="qopt' + (i === choice ? ' selected' : '') +
      '" data-action="queue-review" data-id="' + i + '">' +
      '<span class="qnum">' + (i + 1) + '</span>' +
      '<div class="qtext"><span class="qlabel">' + esc(qs[i].header) + '</span>' +
      '<span class="qdesc">' + esc(chosen) + '</span></div></div>';
  }
  html += '<div class="qopt qstep submit' + (choice === qs.length ? ' selected' : '') +
    '" data-action="queue-review" data-id="' + qs.length + '">' +
    '<span class="qnum">✓</span><span class="qlabel">SUBMIT</span>' +
    '<span class="qdesc">sends all ' + qs.length + ' answers</span></div>';
  return html + '</div>';
}

function chip(action, label, hint, filled, extra) {
  return '<div class="qchip ' + action + (filled ? ' filled' : '') + (extra || '') +
    '" data-action="queue-' + action + '">' +
    '<span class="qchiplabel">' + label + '</span>' +
    '<span class="qchiphint">' + esc(hint) + '</span></div>';
}

// Tapping a stack row promotes it to hero rather than opening the prompt: the
// hero is where every ask is now answerable, so that is where a tap should
// land it.
function stackRow(a) {
  if (isCard(a)) return cardRow(a);
  var isQuestion = a.kind === 'question' || a.kind === 'prompt';
  return '<div class="qrow' + (isQuestion ? ' question' : '') +
    '" data-action="queue-promote" data-id="' + esc(a.id) + '">' +
    '<span class="qrail"></span>' +
    '<span class="qrowkind">' + (a.kind === 'prompt' ? promptKind(a).split(' ')[0] : isQuestion ? 'QUESTION' : 'PERMISSION') + '</span>' +
    '<span class="qrowsession">' + esc(a.sessionName || 'session') + '</span>' +
    '<span class="qrowsummary">' + esc(summarize(a)) + '</span>' +
    '<span class="qrowwait">' + esc(waitLabel(a)) + '</span>' +
    '</div>';
}

// A finished turn is not a decision: the hero offers three ways to go and none
// of them answers anything on this screen. Tapping the body opens the session
// (the chips are the innermost [data-action], so they win their own taps).
var CARD_KINDS = {
  asking: 'CLAUDE IS ASKING',
  update: 'UPDATE',
  error: 'STOPPED ON AN ERROR',
};
var CARD_ROW_KINDS = { asking: 'ASKING', update: 'UPDATE', error: 'ERROR' };
var SUMMARY_BULLETS = 3;

function cardTag(a) {
  return CARD_KINDS[a.tag] ? a.tag : 'update';
}

// The digest's summary stands in for the excerpt when it has anything to say.
function cardSummary(a) {
  var s = a.summary;
  if (!s || typeof s !== 'object') return null;
  var headline = String(s.headline == null ? '' : s.headline);
  var bullets = [];
  var src = s.bullets instanceof Array ? s.bullets : [];
  for (var i = 0; i < src.length && bullets.length < SUMMARY_BULLETS; i++) {
    if (src[i] != null && String(src[i]).trim()) bullets.push(String(src[i]));
  }
  return headline.trim() || bullets.length ? { headline: headline, bullets: bullets } : null;
}

function cardHero(a, picked) {
  var tag = cardTag(a);
  var sum = cardSummary(a);
  var body;
  if (sum) {
    body = '<div class="qcardsum">' +
      (sum.headline ? '<div class="qsumhead">' + esc(sum.headline) + '</div>' : '');
    for (var i = 0; i < sum.bullets.length; i++) {
      body += '<div class="qsumbullet">' + esc(sum.bullets[i]) + '</div>';
    }
    body += '</div>';
  } else {
    body = '<div class="qcardtext">' + esc(a.excerpt) + '</div>';
  }
  var intent = a.intent ? '<div class="qintent">' + esc(a.intent) + '</div>' : '';
  return '<div class="qhero card ' + tag + (a.intent ? ' has-intent' : '') +
    '" data-action="queue-open" data-id="' + esc(a.sessionId) + '">' +
    '<span class="qhazard"></span>' +
    '<div class="qherobody">' +
    '<div class="qheroline"><span class="qkind">' + CARD_KINDS[tag] + '</span>' +
    (sum ? '<span class="qnucbox">NUCBOX</span>' : '') +
    '<span class="qwait">' + esc(cardWaitLabel(a)) + '</span></div>' +
    '<div class="qherosession">' + esc(a.sessionName || 'session') + '</div>' +
    intent + body +
    '<div class="qactions">' +
    // The dial walks these three and the press does the filled one; the
    // others show their own shortcut.
    (a.machine
      // A NucBox card's SWITCH brings its session forward there (switchPlan); the chip names where.
      ? chip('switch', 'ON THE ' + String(a.machine).toUpperCase(), picked === 0 ? 'press dial' : 'in VS Code there', picked === 0)
      : chip('switch', 'SWITCH', picked === 0 ? 'press dial' : 'turn to pick', picked === 0)) +
    chip('reply', 'REPLY', picked === 1 ? 'press dial' : 'hold top', picked === 1) +
    chip('clear', 'CLEAR', picked === 2 ? 'press dial' : 'preset 3', picked === 2) +
    '</div></div></div>';
}

// One line of the card, whichever of the summary or the excerpt it has.
function cardRow(a) {
  var tag = cardTag(a);
  var sum = cardSummary(a);
  var line = sum && sum.headline.trim() ? sum.headline : sum ? sum.bullets[0] : firstLine(a.excerpt);
  return '<div class="qrow card ' + tag +
    '" data-action="queue-promote" data-id="' + esc(a.id) + '">' +
    '<span class="qrail"></span>' +
    '<span class="qrowkind">' + CARD_ROW_KINDS[tag] + '</span>' +
    '<span class="qrowsession">' + esc(a.sessionName || 'session') + '</span>' +
    '<span class="qrowsummary">' + esc(line) + '</span>' +
    '<span class="qrowwait">' + esc(cardWaitLabel(a)) + '</span>' +
    '</div>';
}

function firstLine(text) {
  var lines = String(text == null ? '' : text).split('\n');
  for (var i = 0; i < lines.length; i++) if (lines[i].trim()) return lines[i].trim();
  return '';
}

// A loud card is waiting on you and says how long; a quiet one has gone quiet
// but is still here, and says when it finished, which keeps counting for hours.
function cardWaitLabel(a) {
  var secs = Math.max(0, Math.round((now() - a.createdTs) / 1000));
  var age = secs < 60 ? secs + 's' : secs < 3600 ? Math.round(secs / 60) + 'm'
    : secs < 86400 ? Math.floor(secs / 3600) + 'h' : Math.floor(secs / 86400) + 'd';
  return a.loud ? 'waiting ' + age : 'finished ' + age + ' ago';
}

// While a group is being walked the summary is the question actually on
// screen, not the first one — the header line says which of them it is.
function summarize(a, state, answering) {
  if (a.kind === 'prompt') return promptSummary(a);
  if (a.kind !== 'question') return a.tool + '  ·  ' + a.summary;
  if (!answering) return a.question;
  if (state.queueReview) return 'check your answers before they go';
  var q = currentQuestion(a, state);
  return q ? q.question : a.question;
}

// How long it has been waiting, never how long is left. A countdown turns a
// prompt into a deadline you can lose; the prompt screen is where a live
// deadline belongs, because that is where you are acting against it.
function waitLabel(a) {
  if (a.expired) return 'in terminal';
  var secs = Math.max(0, Math.round((now() - a.createdTs) / 1000));
  return 'waiting ' + (secs < 60 ? secs + 's' : Math.round(secs / 60) + 'm');
}
