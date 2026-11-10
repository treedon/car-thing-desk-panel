import './styles.css';
import * as ws from './ws.js';
import * as store from './store.js';
import { onAction, setGate } from './input.js';
import { createDisplay } from './display.js';
import { renderList, listDial, cardRoute, leaveList } from './screens/session-list.js';
import { renderDetail } from './screens/session-detail.js';
import { renderFeed } from './screens/subagent-feed.js';
import { renderPrompt } from './screens/prompt.js';
import { startPrompt, promptRows, pressRow, confirmPicks, answerWithText, backQuestion, opensOnArrival } from './prompt-answer.js';
import { createPrefs } from './prefs.js';
import { createChime } from './chime.js';
import {
  openDictateReview, setDictateHost, getDictation, renderDictate, beginTalk, endTalk,
  sendDictation, cancelDictation,
} from './screens/dictate-review.js';
import { startRecording, stopRecording, abortRecording, blobToBase64 } from './dictation.js';
import { createDeviceRecorder } from './device-recorder.js';
import { renderQueue } from './screens/queue.js';
import { renderAsk, setQueueContext } from './screens/ask.js';
import { renderUsage } from './screens/usage.js';
import { renderDigest, pressTarget } from './screens/digest.js';
import {
  newView, ASKS_REACH_PANEL, MAX_PROJECTS, machineRows, initialMachine, stepMachine, stepProject,
  projectPress, renderMachines, renderProjects, checkLine, pressStart, startFailed, createStartWatch,
  takePending, dropPending, msSinceInputAfter,
} from './screens/new-session.js';
import { renderAmbient } from './screens/ambient.js';
import * as mascot from './mascot.js';
import { isDestructive, watchTarget, askHost, setSection, messageStatusText } from './screens/helpers.js';
import { presetTarget, sectionOf, cardOnScreen } from './shell.js';
import { renderHome, homeEntities } from './screens/home.js';
import { renderAudio, audioEntities, volumeOf } from './screens/audio.js';
import { renderNucbox } from './screens/nucbox.js';
import { createLmPoller, nucboxStatus } from './nucbox.js';
import { createHaClient } from './ha/client.js';
import { renderTasks, renderTask, renderFocusSetup, renderFocus, focusChip, DONE_ROW_COUNT } from './screens/tasks.js';
import {
  createTasksClient, stepMinutes, focusPhase, findTask, taskRows, withItemToggled, tasksErrorText, FOCUS_DEFAULT,
} from './tasks.js';
import { readConfig, parsePanelConfig } from './config.js';
import { isAvailable, lightLevel, nextLevel, nextVolumeFrom, createThrottle, haServiceFor, relevantEntity } from './ha/entities.js';
import {
  questionsOf, currentQuestion, rowCount, startWalk, pressOptionAt, pressReviewAt, backStepAt,
} from './answering.js';
import { inflight } from './inflight.js';
import { isLoud, loudCount, isCard, replySent, blockingCount, CARD_CHIPS, cardChipOf, queueDialStep } from './inbox.js';
import {
  INPUT_GUARD_MS, jumpNow, firstLoud, createInputGuard, guardGate, pendingJumpStep, queueIdleExitDue, queueSettled,
  ambientPressTarget, nextAskStep, heroChanged, askIdSet, reconnectJumpDue,
} from './jump.js';
import { withDigest, digestDial, digestPress, digestTap } from './digest-input.js';
import { createDigestSeen, tickWithSeen } from './digest-seen.js';
import { now } from './clock.js';
import { sessionRowPlan, requestToast, rejectedToast, resolutionToast, switchPlan } from './session-actions.js';

var app = document.getElementById('app');
var banner = document.getElementById('banner');
var toastEl = document.getElementById('toast');
var edgeEl = document.getElementById('edge');
var pendingEl = document.getElementById('pending');

// The device arms a destructive allow for ARM_MS, and holds every queue answer
// UNDO_MS before it is actually sent so back can take it back.
var ARM_MS = 4000;
var UNDO_MS = 6000;

// ---- routing (hash-based; ServeDir fallback makes path routing impossible) --

function route() {
  var h = window.location.hash || '#/list';
  var parts = h.slice(2).split('/');
  return { name: parts[0] || 'list', arg: parts[1] || null, arg2: parts[2] || null };
}

function nav(hash) {
  if (window.location.hash !== hash) window.location.hash = hash;
  else render();
}

var returnTo = '#/list';   // where to go after an ask resolves
var askChoice = 0;         // cursor within the current ask

// The jump's bookkeeping (jump.js decides, this only remembers). lastInputTs is
// the last input of any kind, including one the screen's sleep gate or the
// guard swallowed; 0 until the first, which reads as "long ago". jumpWaiting
// says a jump is waiting for the owner to be free. It is a flag and not an id:
// the target is the most urgent loud item at the moment the jump goes (firstLoud),
// so a later arrival cannot overwrite an older item and a cleared one cannot
// orphan it.
var lastInputTs = 0;
var jumpWaiting = false;
var inputGuard = createInputGuard(Date.now);

var lastHtml = '';
// The Tasks page's cursors and minutes dial (see the tasks section below).
var taskView = { cursor: 0, row: 0, minutes: FOCUS_DEFAULT, stopArmed: 0, doneRow: 0 };
// When the Digest list was last looked at, for its NEW tags (digest-seen.js),
// in the Mac's time; the 1 s tick under "screen sleep" feeds it.
var digestSeen = createDigestSeen({ storage: window.localStorage, now: now });

function render() {
  var state = store.get();
  var r = route();
  setSection(sectionOf(r.name));
  var html;
  var isList = false;

  if (r.name === 'ambient') {
    html = renderAmbient(state);
    if (state.mascotOn) mascot.show();
  } else if (r.name === 'tasks') {
    html = renderTasks(state, taskView);
  } else if (r.name === 'task' && r.arg) {
    html = renderTask(state, taskView, r.arg);
  } else if (r.name === 'focusset' && r.arg) {
    html = renderFocusSetup(state, taskView, r.arg);
  } else if (r.name === 'focus') {
    html = renderFocus(state, taskView, Date.now());
  } else if (r.name === 'session' && r.arg) {
    html = renderDetail(state, r.arg);
  } else if (r.name === 'agent' && r.arg && r.arg2) {
    html = renderFeed(state, r.arg, r.arg2);
  } else if (r.name === 'home') {
    html = renderHome(state, homeView);
  } else if (r.name === 'audio') {
    html = renderAudio(state, audioView);
  } else if (r.name === 'nucbox') {
    var nb = state.ha.nucbox;
    html = renderNucbox(nb ? nucboxStatus({ lm: state.nucboxLm, states: state.ha.states, cfg: nb, haStatus: state.ha.status }) : null, nb, state.daemonConnected);
  } else if (r.name === 'dictate') {
    var dict = getDictation();
    if (!dict) return nav('#/list');
    html = renderDictate(state, dict);
  } else if (r.name === 'prompt' && r.arg) {
    var held = store.getAsk(r.arg);
    if (!held) return nav('#/queue');
    if (promptUi.id !== held.id) resetPromptUi(held.id);
    html = renderPrompt(state, held, promptUi.ui, promptUi.cursor);
  } else if (r.name === 'queue') {
    html = renderQueue(state);
  } else if (r.name === 'usage') {
    html = renderUsage(state);
  } else if (r.name === 'digest') {
    html = renderDigest(state, digestSeen.seenTs());
  } else if (r.name === 'new') {
    newView.machines = ws.machines();
    // The projects are loaded by choosing a machine; a page opened on one has none.
    if (r.arg && newView.host !== r.arg) return nav('#/new');
    html = r.arg ? renderProjects(state, newView) : renderMachines(state, newView);
  } else if (r.name === 'ask' && r.arg) {
    var ask = store.getAsk(r.arg);
    if (!ask) return nav(returnTo);
    // The prompt screen answers permissions. A question is walked in the queue
    // hero — it can hold several questions and a review step, and that walk
    // lives in one place rather than two. A card is never a permission: it is
    // read and acted on from the queue, so no path may leave one on ALLOW/DENY.
    if (ask.kind === 'question' || isCard(ask)) {
      store.update({ queueIndex: indexOfAsk(r.arg) });
      return nav('#/queue');
    }
    if (ask.kind === 'prompt') return nav('#/prompt/' + ask.id);
    // "N / M" is a position among the permissions, questions and plans: cards
    // sit behind them in the queue and are not part of the count.
    setQueueContext(indexOfAsk(r.arg), blockingCount(state.asks));
    html = renderQueue(state) + renderAsk(state, ask, askChoice);
  } else {
    html = renderList(state);
    isList = true;
  }
  if (r.name !== 'ambient' || !state.mascotOn) mascot.hide();

  // Only touch the DOM when the markup actually changed. On this CPU an
  // innerHTML swap costs milliseconds of parse + relayout and restarts every
  // CSS animation on screen (sprites, lamps, marquees) — so a no-op rebuild
  // landing on each daemon event is exactly the stutter it looks like.
  if (html !== lastHtml) {
    lastHtml = html;
    app.innerHTML = html;
    if (isList) marquee();
    if (r.name === 'session') restoreDetailScroll(r.arg);
    else if (r.name === 'agent') restoreDetailScroll('agent:' + r.arg2);
    else if (r.name === 'prompt') restoreDetailScroll('prompt:' + r.arg);
  }
  paintPending(state);
  // The Tasks page and its dictation don't use the Mac: no banner there.
  var dictNow = r.name === 'dictate' ? getDictation() : null;
  var offMac = isTasksRoute(r.name) || !!(dictNow && dictNow.transcribe);
  banner.className = state.daemonConnected || offMac ? 'banner' : 'banner show';
  // A blocked session is visible from every screen: the panel edge pulses warn
  // whenever anything loud waits (a quiet card sits in the queue without
  // pulsing). Suppressed on the queue and the prompt, where you are already
  // looking at it.
  var blocked = loudCount(state.asks) > 0 && r.name !== 'queue' && r.name !== 'ask';
  edgeEl.className = blocked ? 'edge show' : 'edge';
}

// Store writes arrive in bursts — one daemon event can land several updates,
// and several sessions can update inside one frame. Painting more than once
// per frame is wasted work the panel can't even show, so renders triggered by
// data coalesce on requestAnimationFrame. Input handlers still call render()
// directly for same-tick feedback.
var renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(function () {
    renderQueued = false;
    render();
  });
}

// Session names are measured against their tile after paint, so only the ones
// that genuinely overflow scroll. Guessing from character count would either
// animate names that fit or leave long ones clipped, and at 39px the line
// between the two moves with every name.
function marquee() {
  var names = app.querySelectorAll('[data-marquee]');
  // All reads, then all writes: interleaving them forces a full relayout per
  // tile (write invalidates, next read re-measures), which on this CPU turns
  // one render into a dozen synchronous layouts.
  var overflows = [];
  for (var i = 0; i < names.length; i++) {
    overflows.push(names[i].scrollWidth - names[i].parentNode.clientWidth);
  }
  for (var k = 0; k < names.length; k++) {
    var over = overflows[k];
    if (over <= 2) continue;
    var el = names[k];
    // Long names get proportionally longer to read, with a dwell at each end.
    var ms = 7000 + Math.round(over * 26);
    el.style.animation = 'marquee' + ' ' + ms + 'ms linear infinite';
    el.style.setProperty('--shift', '-' + over + 'px');
    // Compositor layers are scarce on this GPU, so only names that actually
    // scroll get promoted (the CSS deliberately has no blanket will-change).
    el.style.willChange = 'transform';
  }
}

function indexOfAsk(id) {
  var asks = store.get().asks;
  for (var i = 0; i < asks.length; i++) if (asks[i].id === id) return i;
  return 0;
}

window.addEventListener('hashchange', function () {
  askChoice = 0;
  // an armed STOP belongs to the session view it was pressed in
  var armed = store.get().stopArmedFor;
  if (armed && !(route().name === 'session' && route().arg === armed)) store.update({ stopArmedFor: null, stopArmedUntil: null });
  // leaving the queue abandons a half-walked answer — nothing was sent
  if (route().name !== 'queue' && store.get().queueAnswering) {
    store.update(store.closedAnswer());
  }
  // leaving the sessions screen on the digest's card: back on a tile next time
  var left = leaveList(route().name, store.get());
  if (left) store.update(left);
  render();
  scheduleWatch();
});
store.subscribe(scheduleRender);

// ---- watched-session details ------------------------------------------------
// The daemon broadcasts every session's detail stream; this screen reads one —
// the open detail page's, or the grid cursor's. Telling the daemon which
// (claude.session.watch) lets it keep the rest off the Bluetooth link. Trailing
// debounce: the dial sweeps several tiles a second and each watch is a relay
// round trip, so the target is read once the cursor settles. On a daemon too
// old to know the method, one failed call latches the whole feature off.
var WATCH_DEBOUNCE_MS = 250;
var watchTimer = null;
var sentWatch;              // last id sent; undefined = never sent
var watchSupported = true;

function scheduleWatch(force) {
  if (!watchSupported) return;
  if (force === true) sentWatch = undefined;
  if (watchTimer) return;
  watchTimer = setTimeout(function () {
    watchTimer = null;
    var r = route();
    var target = watchTarget(r.name, r.arg, store.get());
    if (target === sentWatch) return;
    sentWatch = target;
    ws.request('claude.session.watch', { id: target }).catch(function (e) {
      if (/Unknown method/i.test(String(e && e.message))) watchSupported = false;
      sentWatch = undefined;   // otherwise transient — retry on the next trigger
    });
    // The filter means this session's detail may not have flowed while it was
    // unwatched; fetch once so the subline is fresh when the cursor lands.
    if (target) {
      ws.request('claude.session.get', { id: target }).then(function (d) {
        store.applyDetail(d);
      }).catch(function () {});
    }
  }, WATCH_DEBOUNCE_MS);
}

store.subscribe(function () { scheduleWatch(); });
var EXPIRED_ASK_TTL_MS = 5 * 60 * 1000;
setInterval(function () {
  guardHeroChange(function () { store.sweepExpired(EXPIRED_ASK_TTL_MS); });
  var r = route();
  // clock ticks, queue wait ages, the digest's ages and the session view's
  // (its digest strip and card, and its waiting rows)
  if (r.name === 'ambient' || r.name === 'list' || r.name === 'queue' || r.name === 'digest' ||
      r.name === 'session') render();
}, 15000);

// ---- the device stays put ---------------------------------------------------
// It sits in peripheral vision, but the screen you left it on is the screen you
// come back to: no page drifts on its own timer. Two exceptions, both about the
// queue and nothing else. surface() below jumps to the queue when something loud
// needs a person and they are free, and a queue with nothing loud on it hands
// the screen back to the session list after a minute untouched. jump.js owns
// both rules; this only feeds it and acts on the answer.

function msSinceInput() {
  return Date.now() - lastInputTs;
}

function jumpContext() {
  var st = store.get();
  return {
    routeName: route().name,
    msSinceInput: msSinceInput(),
    queueAnswering: st.queueAnswering,
    homeAdjusting: homeView.adjusting,
  };
}

// The hero of the queue as it is now, or null.
function queueHero(st) {
  return st.asks.length ? st.asks[Math.min(st.queueIndex, st.asks.length - 1)] : null;
}

// Run a store change that is not the owner's own and could move the hero under
// them: a card posted or cleared, a sync, an ask the daemon resolved, a notice
// ageing out. When the hero is a different one afterwards and they are looking
// at the queue, the next second of presses is swallowed, like after a jump: a
// CLEAR or SWITCH meant for the old hero must not land on whatever slid in.
function guardHeroChange(change) {
  var before = queueHero(store.get());
  change();
  var after = queueHero(store.get());
  if (heroChanged(before ? before.id : null, after ? after.id : null, route().name)) inputGuard.arm();
}

// Bring a loud item to the queue as the hero, then swallow the next second of
// presses: whatever the owner's hand was about to do belonged to the screen
// they were on, and the hero is very often a permission whose dial press is ALLOW.
function doJump(id) {
  jumpWaiting = false;
  var onQueue = route().name === 'queue';
  if (!onQueue) {
    var here = window.location.hash || '#/list';
    // Ambient is a resting screen, not somewhere to return to once it is dealt with.
    returnTo = here === '#/ambient' ? '#/list' : here;
  }
  store.update(withCursorOn(id));
  if (!onQueue) nav('#/queue');
  toast('NEEDS YOU');
  inputGuard.arm();
}

// Jump now if the owner is free, otherwise wait for them: the edge keeps
// pulsing and the topbar count has already gone up, and the interval below
// tries again each second. Either way the target is the most urgent loud item,
// not necessarily the one that just arrived.
function requestJump() {
  var first = firstLoud(store.get().asks);
  if (!first) return;
  if (jumpNow(jumpContext())) return doJump(first.id);
  jumpWaiting = true;
  render();
}

// Once a second: the prompt screen acts against a live deadline, so its
// countdown ticks on its own clock (it used to ride the daemon's event stream,
// which goes quiet when nothing changes, exactly when a lone pending ask would
// sit frozen at "45s left" until the 30s heartbeat). The same tick ages out an
// armed destructive allow, retries a jump that had to wait, and hands the screen
// back from a queue with nothing loud on it.
setInterval(function () {
  var nowMs = Date.now();
  var st = store.get();
  if (st.armed && nowMs > st.armed.expires) store.update({ armed: null });
  // The STOP row's "press again" runs out the same way.
  if (st.stopArmedFor && nowMs > st.stopArmedUntil) store.update({ stopArmedFor: null, stopArmedUntil: null });
  if (route().name === 'ask') render();

  if (jumpWaiting) {
    var ctx = jumpContext();
    var hero = queueHero(st);
    ctx.waiting = true;
    ctx.asks = st.asks;
    ctx.heroId = hero ? hero.id : null;
    var step = pendingJumpStep(ctx);
    if (step.action === 'drop') jumpWaiting = false;
    else if (step.action === 'go') doJump(step.id);
  }

  // An answer still held for undo, or still being typed on the Mac, has an
  // indicator running on this screen — that is not a queue that is done with you.
  if (queueIdleExitDue({
    routeName: route().name,
    loud: loudCount(st.asks),
    msSinceInput: msSinceInput(),
    inflight: inflight(st, UNDO_MS),
  })) {
    returnTo = '#/list';
    nav('#/list');
  }
}, 1000);

// ---- mascot toggle ---------------------------------------------------------
// The sprite is decoration, and some people want a clock to be a clock. A tap
// anywhere on the ambient screen flips him on or off, and the choice survives
// a reboot. localStorage failures (private mode, a full disk) cost only the
// persistence, never the toggle.

var MASCOT_KEY = 'mascotOff';
try {
  if (window.localStorage.getItem(MASCOT_KEY)) store.update({ mascotOn: false });
} catch (e) {}

function toggleMascot() {
  var on = !store.get().mascotOn;
  store.update({ mascotOn: on });
  try {
    if (on) window.localStorage.removeItem(MASCOT_KEY);
    else window.localStorage.setItem(MASCOT_KEY, '1');
  } catch (e) {}
  toast(on ? 'SPRITE ON' : 'SPRITE OFF');
}

// ---- the answer in flight --------------------------------------------------
//
// From the press to the keystrokes landing is seconds — the undo window, then
// the daemon focusing the terminal and typing the sequence out. The indicator
// stands for that whole wait, so a screen that has already dropped the card
// still says the answer is on its way rather than looking finished.
//
// Written only when the phase actually changes: the drain ring is a CSS
// animation, and rewriting the class on every daemon event would restart it.

var lastPending = '';
function paintPending(state) {
  var v = inflight(state, UNDO_MS);
  var key = v ? v.phase + '|' + v.label : '';
  if (key === lastPending) return;
  lastPending = key;
  if (!v) {
    pendingEl.className = 'pending';
    return;
  }
  pendingEl.querySelector('.pendlabel').textContent = v.label;
  // The undo ring is a countdown, so it runs for exactly as long as the window
  // it is counting down — one number, kept in one place.
  if (v.ms) pendingEl.querySelector('.pendarc').style.animationDuration = v.ms + 'ms';
  pendingEl.className = 'pending show ' + v.phase;
}

// ---- toast ---------------------------------------------------------------

var toastTimer = null;
function toast(text, ms) {
  toastEl.textContent = text;
  toastEl.className = 'toast show';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { toastEl.className = 'toast'; }, ms || 2500);
}

// ---- input ----------------------------------------------------------------

// The prompt screen is permissions only now — allow, deny, skip.
function askOptionCount() {
  return 3;
}

registerTasksInput();

onAction('dial', function (dir) {
  var state = store.get();
  var r = route();
  // A half-pressed STOP means "press again", not "press again after turning the
  // knob": any turn takes it back.
  if (state.stopArmedFor) store.update({ stopArmedFor: null, stopArmedUntil: null });
  if (r.name === 'home') {
    dialHome(dir);
  } else if (r.name === 'audio') {
    dialAudio(dir);
  } else if (r.name === 'session') {
    dialDetail(r.arg, dir);
  } else if (r.name === 'agent') {
    scrollDetail('agent:' + r.arg2, dir);
  } else if (r.name === 'prompt') {
    dialPrompt(r.arg, dir);
  } else if (r.name === 'ask') {
    var ask = store.getAsk(r.arg);
    if (!ask) return;
    var max = askOptionCount() - 1;
    askChoice = Math.max(0, Math.min(max, askChoice + dir));
    render();
  } else if (r.name === 'queue') {
    var n = state.asks.length;
    if (!n) return;
    if (state.queueAnswering) {
      // A step of the walk is open: the dial moves within its rows, not the
      // queue. The row count comes from the same model the screen drew from,
      // so the cursor can never run past what is on screen.
      var hero = state.asks[Math.min(state.queueIndex, n - 1)];
      var omax = rowCount(hero, state) - 1;
      store.update({ queueChoice: Math.max(0, Math.min(omax, state.queueChoice + dir)) });
    } else {
      // On a card the dial walks its buttons first (inbox.js queueDialStep).
      var step = queueDialStep(state.asks, state.queueIndex, state.queueCardSel, dir);
      store.update({ queueIndex: step.queueIndex, queueCardSel: step.sel });
    }
  } else if (r.name === 'new') {
    dialNew(r.arg, dir);
  } else if (r.name === 'list') {
    var lf = listDial(state, dir);   // the sessions, and the digest's card before them
    if (lf) store.update(lf);
  } else if (r.name === 'digest') {
    // Steps through digestCards(state), the cards the screen draws, never
    // state.digest.cards: the selection helpers index that filtered list.
    store.update(digestDial(state, dir));
  } else if (r.name === 'ambient') {
    nav('#/list');
  }
});

onAction('select', function () {
  var state = store.get();
  var r = route();
  if (r.name === 'ask') {
    answerAsk(r.arg, askChoice);
  } else if (r.name === 'queue') {
    // Triage without leaving the queue: a permission is allowed in place
    // because allow/deny is the whole decision, and a question opens its
    // option list inside the hero — first press opens, second answers.
    var a = state.asks[Math.min(state.queueIndex, state.asks.length - 1)];
    if (!a) return;
    // A finished turn is not a decision: the press does the button the dial is
    // on, SWITCH unless it was turned.
    if (isCard(a)) return pressCard(a, CARD_CHIPS[cardChipOf(state.queueCardSel, a)]);
    if (a.kind === 'permission') {
      if (a.expired) openAsk(a.id);
      else allowHero(a);
    }
    else if (a.kind === 'prompt') openPrompt(a.id);
    else if (a.kind === 'question') focusSession(a.sessionId);
    else if (!state.queueAnswering) openAnswering(a);
    else if (state.queueReview) pressReview(a, state.queueChoice);
    else pressOption(a, state.queueChoice);
  } else if (r.name === 'home') {
    pressHome();
  } else if (r.name === 'audio') {
    var sp = audioSelected();
    if (sp && isAvailable(sp.state)) callHa('media_player', 'media_play_pause', {}, sp.id);
  } else if (r.name === 'dictate') {
    sendDictation();
  } else if (r.name === 'prompt') {
    pressPromptRow(r.arg, promptUi.cursor);
  } else if (r.name === 'session') {
    var selRow = state.agentSel >= 0 ? app.querySelectorAll('.agrow')[state.agentSel] : null;
    if (selRow) sessionRowAction(r.arg, selRow.getAttribute('data-action'), selRow.getAttribute('data-id'));
  } else if (r.name === 'new') {
    if (r.arg) chooseProject(newView.cursor); else chooseMachine(newView.cursor);
  } else if (r.name === 'list' && cardRoute(state)) {
    nav(cardRoute(state));   // the digest's card: the Digest list
  } else if (r.name === 'list') {
    var s = state.sessions[state.selectedIndex];
    if (s) openSession(s.id);
  } else if (r.name === 'digest') {
    // The open card of digestCards(state), not of state.digest.cards.
    var dsel = digestPress(state);
    if (dsel) pressDigest(dsel);
  } else if (r.name === 'ambient') {
    // When something is loud the press goes where the work is; a quiet card
    // does not call for the owner, and the session list is the manual route.
    nav(ambientPressTarget(state.asks));
  }
});

onAction('back', function () {
  var r = route();
  // Back inside the undo window takes the answer back: the ask returns to its
  // place in the queue and nothing was ever sent.
  if (restoreUndo()) return;
  // Home and Audio are top-level: Back only leaves dim mode. NucBox sits in
  // the Agents section, so Back returns to its session list like Usage does.
  if (isTasksRoute(r.name)) return;   // the Tasks page's own handler
  if (r.name === 'home' || r.name === 'audio') {
    if (homeView.adjusting) { homeView.adjusting = false; render(); }
    return;
  }
  if (r.name === 'ask') skipAsk(r.arg);
  else if (r.name === 'session') nav('#/list');
  else if (r.name === 'agent') nav('#/session/' + r.arg);
  else if (r.name === 'dictate') cancelDictation();
  // From a machine's projects to the machines; from the machines, the default below: the sessions.
  else if (r.name === 'new' && r.arg) showMachines(newView.host);
  else if (r.name === 'prompt') {
    var bp = store.getAsk(r.arg);
    var prev = bp && backQuestion(bp, promptUi.ui);
    if (prev) { promptUi.ui = prev; promptUi.cursor = 0; render(); }
    else nav('#/queue');
  }
  // Back walks the open ask backwards — review to the last question, question
  // to the one before it, answers intact. From the first question it closes
  // the list and returns to queue browsing; a second back leaves for sessions.
  else if (r.name === 'queue' && store.get().queueAnswering) {
    var st = store.get();
    var open = st.asks[Math.min(st.queueIndex, st.asks.length - 1)];
    if (!backStep(open)) store.update(store.closedAnswer());
  }
  else if (r.name === 'queue' || r.name === 'usage') nav('#/list');
  else if (r.name === 'list') nav('#/ambient');
  else nav('#/list');
});

onAction('preset', function (key) {
  var r = route();
  var st = store.get();
  var hero = st.asks[Math.min(st.queueIndex, st.asks.length - 1)];
  var ask = r.name === 'ask' ? store.getAsk(r.arg) : null;
  var target = presetTarget(key, r.name, cardOnScreen(r.name, hero, ask));
  if (target === 'deny') return denyPressed();
  if (target) nav(target);
});

// Preset 3 is the context action for whatever is in front of you — deny on the
// prompt screen's ask or a queue permission, CLEAR on a queue card.
function denyPressed() {
  var r = route();
  if (r.name === 'ask') {
    var ask = store.getAsk(r.arg);
    if (ask && ask.kind === 'permission') answerAsk(r.arg, 1);   // 1 = deny
    return;
  }
  if (r.name === 'queue') {
    var state = store.get();
    var hero = state.asks[Math.min(state.queueIndex, state.asks.length - 1)];
    if (!hero) return;
    // On a card, preset 3 is CLEAR — never a decision sent for a card's id.
    if (isCard(hero)) return clearCard(hero);
    // On a multiSelect question the dial press toggles, so nothing under the
    // cursor ever moves you on — the DONE row does, and hunting for it is how
    // the walk felt stuck. Preset 3 is the device's one context action and is
    // otherwise idle during a question, so here it means "done picking".
    if (state.queueAnswering && !state.queueReview && hero.kind === 'question') {
      var q = currentQuestion(hero, state);
      if (q && q.multiSelect) return pressOption(hero, q.options.length);
      return;
    }
    // An expired ask was answered in the terminal; deny is how the dead slot
    // is dismissed without pretending an answer went anywhere.
    if (hero.expired) {
      store.resolveAsk(hero.id);
      toast('DISMISSED');
      return;
    }
    if (hero.kind === 'permission') answerFromQueue(hero, 1);
  }
}
onAction('deny', denyPressed);

onAction('ambient', function () {
  // On a question the top button confirms a multi-select instead; on the
  // dictation screen a tap means nothing (hold to talk).
  if (route().name === 'prompt') return confirmPromptPicks(route().arg);
  if (route().name === 'dictate') return;
  if (route().name === 'audio') {
    var nx = audioSelected();
    if (nx && isAvailable(nx.state)) { callHa('media_player', 'media_next_track', {}, nx.id); toast('NEXT TRACK'); }
    return;
  }
  nav(route().name === 'ambient' ? '#/list' : '#/ambient');
});

onAction('tap', function (t) {
  var state = store.get();
  // Anything tapped but the armed STOP row takes the arm back.
  if (state.stopArmedFor && t.action !== 'stop-session') store.update({ stopArmedFor: null, stopArmedUntil: null });
  var hero = state.asks[Math.min(state.queueIndex, state.asks.length - 1)];
  // A card is never decided: a tap meant for the permission or question that
  // was the hero a moment ago must not land on the card that replaced it.
  var decidable = hero && !isCard(hero);
  var cardHero = hero && isCard(hero) ? hero : null;
  if (t.action === 'open' && t.id) openSession(t.id);
  else if (t.action === 'open-ask' && t.id) openAsk(t.id);
  else if (t.action === 'ask-choice') answerAsk(route().arg, Number(t.id));
  else if (t.action === 'ask-skip') skipAsk(route().arg);
  else if (t.action === 'queue-allow' && decidable) allowHero(hero);
  else if (t.action === 'queue-deny' && decidable) answerFromQueue(hero, 1);
  // a question opens its option list inside the hero, not the prompt screen
  else if (t.action === 'queue-answer' && decidable) {
    if (hero.kind === 'prompt') openPrompt(hero.id);
    else if (hero.kind === 'question') focusSession(hero.sessionId);
    else openAsk(hero.id);
  }
  else if (t.action === 'queue-choice' && decidable) pressOption(hero, Number(t.id));
  else if (t.action === 'queue-review' && decidable) pressReview(hero, Number(t.id));
  // stack rows promote to hero rather than opening the prompt
  else if (t.action === 'queue-promote' && t.id) {
    var promoted = store.closedAnswer();
    promoted.queueIndex = indexOfAsk(t.id);
    store.update(promoted);
  }
  else if (t.action === 'mascot-toggle') toggleMascot();
  else if (t.action === 'queue-vscode' && hero) focusSession(hero.sessionId);
  // the card hero: its body opens the session; the chips are its three actions
  else if (t.action === 'queue-open' && t.id) openSession(t.id);
  else if (t.action === 'queue-switch' && cardHero) switchToCard(cardHero);
  else if (t.action === 'queue-reply' && cardHero) replyToCard(cardHero, false);
  else if (t.action === 'queue-clear' && cardHero) clearCard(cardHero);
  else if (t.action === 'prompt-row' && route().name === 'prompt') pressPromptRow(route().arg, Number(t.id));
  else if (t.action === 'ha-tile' && t.id && route().name === 'home') {
    var at = homeEntities(store.get().ha).indexOf(t.id);
    if (at >= 0) { homeView.cursor = at; pressHome(); }
  }
  else if (t.action === 'ha-speaker' && t.id && route().name === 'audio') {
    var ai = audioEntities(store.get().ha).indexOf(t.id);
    if (ai >= 0) { audioView.cursor = ai; render(); }
  }
  else if (t.action === 'ns-machine' && route().name === 'new') {
    newView.cursor = Number(t.id);
    render();
    chooseMachine(newView.cursor);
  }
  else if (t.action === 'ns-project' && route().name === 'new') {
    newView.cursor = Number(t.id);
    render();
    chooseProject(newView.cursor);
  }
  else if (t.action === 'dict-send') sendDictation();
  else if (t.action === 'dict-cancel') cancelDictation();
  else if (t.action === 'dict-again') {
    var dg = getDictation();
    if (dg && dg.phase === 'recording') endTalk(); else beginTalk();
  }
  else if ((t.action === 'open-agent' || t.action === 'open-mac' || t.action === 'toggle-auto-open' ||
      t.action === 'toggle-chime' || t.action === 'handoff-cancel' || t.action === 'handoff-now' ||
      t.action === 'stop-session') && route().name === 'session') {
    sessionRowAction(route().arg, t.action, t.id);
  }
  // Another row becomes the selection; the open card is pressed.
  else if (t.action === 'digest-row' && route().name === 'digest') {
    var dt = digestTap(state, t.id);
    if (dt && dt.press) pressDigest(dt.press);
    else if (dt) store.update({ digestSel: dt.select });
  }
  // The sessions screen's digest card: where a press on it goes.
  else if (route().name === 'list' && cardRoute(state, t)) nav(cardRoute(state, t));
  // the empty queue's chime row: tap only, never a dial press
  else if (t.action === 'toggle-chime' && route().name === 'queue') chime.toggle();
});

// ---- actions ---------------------------------------------------------------

// ---- conversation scrolling -------------------------------------------------
// The session view is one column: conversation, then status. It opens with the
// newest message at the bottom of the screen and stays pinned there as new
// messages land, until the knob (or a finger, via the same dial ticks) moves it.
// A re-render replaces the column, so its position is kept here.

var SCROLL_STEP_PX = 92;   // about three 22px lines per knob tick
var detailScroll = { id: null, top: 0, stick: true };

// Where a column opens: a question or plan (#panchor) at the top of the
// screen with its context above; a conversation with its newest message at
// the bottom.
function pinnedTop(el) {
  var anchor = document.getElementById('panchor');
  if (anchor) return Math.max(0, Math.min(anchor.offsetTop - 4, el.scrollHeight - el.clientHeight));
  var end = document.getElementById('cvend');
  return end ? Math.max(0, end.offsetTop - el.clientHeight) : 0;
}

function restoreDetailScroll(id) {
  var el = document.getElementById('dscroll');
  if (!el) return;
  if (detailScroll.id !== id) detailScroll = { id: id, top: 0, stick: true };
  el.scrollTop = detailScroll.stick ? pinnedTop(el) : detailScroll.top;
}

function scrollDetail(id, dir) {
  var el = document.getElementById('dscroll');
  if (!el) return;
  el.scrollTop = el.scrollTop + dir * SCROLL_STEP_PX;
  var pin = pinnedTop(el);
  detailScroll = { id: id, top: el.scrollTop, stick: Math.abs(el.scrollTop - pin) < 4 };
}

// ---- subagent rows in the session view --------------------------------------
// The knob scrolls the column until the subagent list is on screen; then ticks
// walk its rows (a press opens one) and, past either end, go back to
// scrolling. agentExit stops a tick that just left the list from re-entering
// it while the end row is still visible.

var agentExit = 0;

function rowVisible(el, row) {
  return row.offsetTop >= el.scrollTop && row.offsetTop + row.offsetHeight <= el.scrollTop + el.clientHeight;
}

function showRow(el, row, id) {
  if (row.offsetTop < el.scrollTop) el.scrollTop = row.offsetTop - 12;
  else if (row.offsetTop + row.offsetHeight > el.scrollTop + el.clientHeight) {
    el.scrollTop = row.offsetTop + row.offsetHeight - el.clientHeight + 12;
  }
  detailScroll = { id: id, top: el.scrollTop, stick: false };
}

function dialDetail(id, dir) {
  var el = document.getElementById('dscroll');
  var rows = app.querySelectorAll('.agrow');
  var sel = store.get().agentSel;
  if (!el || !rows.length) return scrollDetail(id, dir);
  if (sel >= 0) {
    var next = sel + dir;
    if (next < 0 || next >= rows.length) {
      agentExit = dir;
      store.update({ agentSel: -1 });
      return scrollDetail(id, dir);
    }
    store.update({ agentSel: next });
    return showRow(el, rows[next], id);
  }
  var entry = dir > 0 ? 0 : rows.length - 1;
  if (agentExit === dir && rowVisible(el, rows[entry])) return scrollDetail(id, dir);
  agentExit = 0;
  if (rowVisible(el, rows[entry])) {
    store.update({ agentSel: entry });
    return showRow(el, rows[entry], id);
  }
  scrollDetail(id, dir);
}

// One fetch on open, then at most one per MESSAGES_REFRESH_MS while that
// session's updates keep arriving (a busy transcript writes several per second).
var MESSAGES_REFRESH_MS = 1500;
var messagesTimer = null;

function fetchSubagents(id) {
  ws.request('claude.subagents.list', { sessionId: id }).then(function (res) {
    store.applySubagents(id, (res && res.subagents) || []);
  }).catch(function () {});
}

function fetchFeed(sessionId, agentId) {
  ws.request('claude.subagent.feed', { sessionId: sessionId, agentId: agentId }).then(function (res) {
    store.applyFeed(agentId, res || { steps: [], report: null });
  }).catch(function () {});
}

function openAgent(sessionId, agentId) {
  detailScroll = { id: 'agent:' + agentId, top: 0, stick: true };
  nav('#/agent/' + sessionId + '/' + agentId);
  fetchFeed(sessionId, agentId);
}

function fetchMessages(id) {
  ws.request('claude.session.messages', { id: id, limit: 40 }).then(function (res) {
    store.applyMessages(id, (res && res.messages) || []);
  }).catch(function () {});
}

function refreshMessagesSoon(id) {
  if (messagesTimer) return;
  messagesTimer = setTimeout(function () {
    messagesTimer = null;
    var r = route();
    if (r.name === 'session' && r.arg === id) { fetchMessages(id); fetchSubagents(id); }
    if (r.name === 'agent' && r.arg === id) fetchFeed(id, r.arg2);
  }, MESSAGES_REFRESH_MS);
}

// Raise the session's window on its own machine (the request follows the
// session). For VS Code that is all it does; nothing is ever typed there.
function focusSession(id) {
  if (!id) return;
  ws.request('claude.session.focus', { id: id }).catch(function () {});
}

var prefs = createPrefs(typeof window !== 'undefined' ? window.localStorage : null);
store.update({ autoOpenOnMac: prefs.get('autoOpenOnMac'), machineCount: ws.machines().length });

// The handoff and stop requests can outlast the usual ten seconds: the service
// stops the job, waits for its process to be gone, then opens VS Code.
var SESSION_REQUEST_WAIT_MS = 40000;
var sessionRequestsOut = {};

function sendSessionRequest(method, sessionId) {
  var key = method + ' ' + sessionId;
  if (sessionRequestsOut[key]) return;   // the same press, twice, before the service has answered
  sessionRequestsOut[key] = true;
  ws.request(method, { id: sessionId }, SESSION_REQUEST_WAIT_MS).then(function (res) {
    delete sessionRequestsOut[key];
    toast(requestToast(method, res));
  }).catch(function () {
    delete sessionRequestsOut[key];
    toast(rejectedToast());
  });
}

function sessionRowAction(sessionId, action, id) {
  var st = store.get();
  var plan = sessionRowPlan(st.details[sessionId], action, st.stopArmedFor, st.stopArmedUntil, Date.now());
  if (st.stopArmedFor !== plan.arm || st.stopArmedUntil !== plan.armUntil) {
    store.update({ stopArmedFor: plan.arm, stopArmedUntil: plan.armUntil });
  }
  if (plan.cursor !== null && st.agentSel >= 0) store.update({ agentSel: plan.cursor });   // only a dial cursor moves; a tap leaves none
  if (plan.focus) focusSession(sessionId);
  if (plan.method) sendSessionRequest(plan.method, sessionId);
  if (plan.toast) toast(plan.toast);
  if (action === 'toggle-auto-open') {
    var on = !prefs.get('autoOpenOnMac');
    prefs.set('autoOpenOnMac', on);
    store.update({ autoOpenOnMac: on });
  } else if (action === 'toggle-chime') {
    chime.toggle();
  } else if (action === 'open-agent' && id) {
    openAgent(sessionId, id);
  }
}

// ---- the Mac's chime --------------------------------------------------------
// The setting lives on the Mac; chime.js holds the decision (optimistic flip,
// toast, revert on failure, one save at a time) and this wires it to the socket,
// the store and the toast.

var chime = createChime({
  request: function (method, params) { return ws.request(method, params); },
  get: function () { return store.get().chimeOn; },
  set: function (on) { store.update({ chimeOn: on }); },
  toast: toast,
});

function openSession(id) {
  nav('#/session/' + id);
  detailScroll = { id: id, top: 0, stick: true };
  agentExit = 0;
  store.update({ agentSel: -1 });
  fetchMessages(id);
  fetchSubagents(id);
  ws.request('claude.session.get', { id: id }).then(function (d) {
    store.applyDetail(d);
  }).catch(function () {});
  // Bring it forward on the Mac too, only if the owner asked for that: checking
  // in from the desk shouldn't wake the Mac's screen.
  if (prefs.get('autoOpenOnMac')) focusSession(id);
}

// A press on a digest card: a live session opens, an ended one only says so.
function pressDigest(id) {
  var t = pressTarget(store.get(), id);
  if (t.open) openSession(t.open);
  else toast(t.toast);
}

// ---- held questions and plans (claude.prompt.*) ----------------------------

var promptUi = { id: null, ui: startPrompt(), cursor: 0 };

function resetPromptUi(id) {
  promptUi = { id: id, ui: startPrompt(), cursor: 0 };
  agentExit = 0;
  detailScroll = { id: 'prompt:' + id, top: 0, stick: true };
}

function openPrompt(id) {
  resetPromptUi(id);
  nav('#/prompt/' + id);
}

// render() replaces the column synchronously, so the scroll element and rows
// must be looked up again afterwards; the old ones are detached and read 0.
function showPromptRow(id, index) {
  render();
  var el = document.getElementById('dscroll');
  var row = app.querySelectorAll('.prow')[index];
  if (el && row) showRow(el, row, 'prompt:' + id);
}

// The knob walks the rows; past the first one it scrolls up into what led to
// the question, and back down re-enters at the first row.
function dialPrompt(id, dir) {
  var el = document.getElementById('dscroll');
  var rows = app.querySelectorAll('.prow');
  if (!el || !rows.length) return scrollDetail('prompt:' + id, dir);
  var sel = promptUi.cursor;
  if (sel >= 0) {
    var next = sel + dir;
    if (next < 0 || next >= rows.length) {
      agentExit = dir;
      promptUi.cursor = -1;
      render();
      return scrollDetail('prompt:' + id, dir);
    }
    promptUi.cursor = next;
    return showPromptRow(id, next);
  }
  var entry = dir > 0 ? 0 : rows.length - 1;
  if (agentExit === dir && rowVisible(el, rows[entry])) return scrollDetail('prompt:' + id, dir);
  agentExit = 0;
  if (rowVisible(el, rows[entry])) {
    promptUi.cursor = entry;
    return showPromptRow(id, entry);
  }
  scrollDetail('prompt:' + id, dir);
}

function applyPromptStep(p, step) {
  if (step.error) toast(step.error.toUpperCase());
  promptUi.ui = step.ui;
  if (step.send) return sendPromptAnswer(p, step.send);
  if (step.dictate) return dictatePrompt(p);
  if (step.ui.q !== (promptUi.lastQ || 0)) {
    promptUi.cursor = 0;
    detailScroll = { id: 'prompt:' + p.id, top: 0, stick: true };
  }
  promptUi.lastQ = step.ui.q;
  render();
}

function pressPromptRow(id, row) {
  var p = store.getAsk(id);
  if (!p || p.expired || row < 0) return;
  promptUi.cursor = row;
  applyPromptStep(p, pressRow(p, promptUi.ui, row));
}

function confirmPromptPicks(id) {
  var p = store.getAsk(id);
  if (!p || p.expired) return;
  applyPromptStep(p, confirmPicks(p, promptUi.ui));
}

// "Say an answer" / "Say what to change": the dictated text, once the owner
// has read it and pressed Send, answers the question or becomes plan feedback.
function dictatePrompt(p, startNow) {
  var plan = p.tool === 'ExitPlanMode';
  openDictateReview({
    title: plan ? 'What should change in the plan?' : 'Your answer',
    onSend: function (text) {
      var held = store.getAsk(p.id);
      if (!held || held.expired) return toast('MOVED TO VS CODE');
      nav('#/prompt/' + p.id);
      applyPromptStep(held, answerWithText(held, promptUi.ui, text));
    },
    onCancel: function () { nav('#/prompt/' + p.id); },
  }, startNow);
}

// ---- Home Assistant -----------------------------------------------------------
// The panel's own connection to HA, so lights and HomePods work while the Mac
// sleeps. Configured from PANEL_CONFIG.ha; absent, the HA screens say so.

var haCfg = typeof window !== 'undefined' ? readConfig(window.PANEL_CONFIG).ha : null;
var ha = null;
var haThrottle = createThrottle({ intervalMs: 150 });

if (haCfg && haCfg.url && haCfg.token) {
  ha = createHaClient({ url: haCfg.url, token: haCfg.token });
  store.update({ ha: {
    configured: true, status: 'connecting', url: haCfg.url,
    home: haCfg.home || [], audio: haCfg.audio || [], nucbox: haCfg.nucbox || null,
    states: ha.states(), optimistic: {},
  } });
  ha.on('status', function (s) {
    if (s === 'unauthorized') watchForNewToken();
    var cur = store.get().ha;
    cur.status = s;
    cur.states = ha.states();
    store.update({});
  });
  ha.on('state', function (id) {
    var cur = store.get().ha;
    cur.states = ha.states();
    if (relevantEntity(cur, id)) store.update({});
  });
  ha.start();
}

// LM Studio's loaded model, polled straight from the NucBox: every 5 s while
// the NucBox view is showing, every 30 s otherwise. Quiet: it never alerts.
var lmPoller = null;
store.update({ nucboxLm: { status: 'unreachable', models: [] } });
if (haCfg && haCfg.nucbox && haCfg.nucbox.lmstudio) {
  lmPoller = createLmPoller({
    url: haCfg.nucbox.lmstudio,
    onChange: function (lm) { store.update({ nucboxLm: lm }); },
  });
  lmPoller.start();
}
function onRouteForHa() {
  if (lmPoller) lmPoller.setFast(route().name === 'nucbox');
  // Dim mode belongs to the visit; coming back to Home starts on the grid.
  if (route().name !== 'home') homeView.adjusting = false;
}
window.addEventListener('hashchange', onRouteForHa);

// A rejected token: re-read /panel-config.js once a minute (the simulator
// serves ha.json fresh each time; on the device, re-provisioning rewrites it)
// and reconnect as soon as the token changes. No reload needed.
var TOKEN_RECHECK_MS = 60000;
var tokenTimer = null;
function watchForNewToken() {
  if (tokenTimer) return;
  tokenTimer = setInterval(function () {
    fetch('panel-config.js', { cache: 'no-store' }).then(function (r) { return r.text(); }).then(function (text) {
      var cfg = parsePanelConfig(text);
      var next = cfg && cfg.ha && cfg.ha.token;
      if (!next || next === haCfg.token) return;
      haCfg.token = next;
      clearInterval(tokenTimer);
      tokenTimer = null;
      ha.setToken(next);
      ha.start();
    }).catch(function () {});
  }, TOKEN_RECHECK_MS);
}

function callHa(domain, service, data, entityId) {
  if (!ha) return;
  ha.callService(domain, service, data, { entity_id: entityId }).catch(function () {
    toast('HOME ASSISTANT DIDN\'T TAKE THAT');
  });
}

var homeView = { cursor: 0, adjusting: false };

function homeSelected() {
  var cur = store.get().ha;
  var id = homeEntities(cur)[homeView.cursor];
  return id ? { id: id, state: cur.states[id] } : null;
}

function dialHome(dir) {
  var ids = homeEntities(store.get().ha);
  if (!ids.length) return;
  if (!homeView.adjusting) {
    homeView.cursor = Math.max(0, Math.min(ids.length - 1, homeView.cursor + dir));
    return render();
  }
  var sel = homeSelected();
  if (!sel || !isAvailable(sel.state)) return;
  var cur = store.get().ha;
  var o = cur.optimistic[sel.id];
  var base = o && Date.now() - o.ts < 1500 ? o.level : lightLevel(sel.state);
  var level = nextLevel(base, dir);
  cur.optimistic[sel.id] = { level: level, ts: Date.now() };
  render();
  haThrottle.push(sel.id, level, function (v) {
    if (v > 0) callHa('light', 'turn_on', { brightness_pct: v }, sel.id);
    else callHa('light', 'turn_off', {}, sel.id);
  });
}

function pressHome() {
  if (homeView.adjusting) { homeView.adjusting = false; return render(); }
  var sel = homeSelected();
  if (!sel || !isAvailable(sel.state)) return;
  var svc = haServiceFor(sel.id);
  callHa(svc[0], svc[1], {}, sel.id);
  if (svc[1] === 'turn_on') toast(svc[0] === 'scene' ? 'SCENE ON' : 'RUNNING');
}

var audioView = { cursor: 0 };

function audioSelected() {
  var cur = store.get().ha;
  var id = audioEntities(cur)[audioView.cursor];
  return id ? { id: id, state: cur.states[id] } : null;
}

// Knob = volume of the selected HomePod, shown at once and sent at most every
// 150 ms (the last value always lands).
function dialAudio(dir) {
  var sp = audioSelected();
  if (!sp || !isAvailable(sp.state)) return;
  var cur = store.get().ha;
  var v = nextVolumeFrom(volumeOf(cur, sp.id), dir);
  if (v == null) return;
  cur.optimistic[sp.id] = { level: v, ts: Date.now() };
  render();
  haThrottle.push(sp.id, v, function (x) {
    callHa('media_player', 'volume_set', { volume_level: x / 100 }, sp.id);
  });
}

function startDimming() {
  var sel = homeSelected();
  if (!sel || sel.id.indexOf('light.') !== 0 || !isAvailable(sel.state)) return;
  homeView.adjusting = true;
  render();
}

// ---- dictation ---------------------------------------------------------------
// Hold the top button to talk (m-hold after 600 ms), let go to transcribe.

setDictateHost({
  show: function () { nav('#/dictate'); },
  update: function () { if (route().name === 'dictate') render(); },
  // On the Car Thing a native recorder owns the microphones; in the simulator
  // the browser records.
  record: (function () {
    var rec = typeof window !== 'undefined' ? readConfig(window.PANEL_CONFIG).recorder : null;
    if (!rec) return { start: startRecording, stop: stopRecording, abort: abortRecording };
    var d = createDeviceRecorder(rec);
    return { start: d.start, stop: d.stop, abort: d.abort };
  })(),
  // On the NucBox when it serves the Tasks page (one whisper for everything,
  // and the Mac needs none); on the Mac when it doesn't, or when the NucBox
  // can't (off, or dictation not set up there).
  transcribe: function (blob, mime) {
    function onMac() {
      return blobToBase64(blob).then(function (b64) {
        return ws.request('claude.dictation.transcribe', { audioBase64: b64, mime: mime }, 60000);
      }).then(function (res) { return (res && res.text) || ''; });
    }
    var nucbox = readConfig(window.PANEL_CONFIG).tasks;
    if (!nucbox) return onMac();
    return createTasksClient(nucbox).transcribe(blob, mime).then(function (res) {
      return (res && res.text) || '';
    }, function (e) {
      if (e && (e.message === 'too-long')) throw e;
      return onMac();
    });
  },
});

// "Say something" on a session: dictate, read it, Send. The service picks the
// way in (answer, next tool call, or waking an idle session) and says which.
function sayToSession(id, startNow) {
  openDictateReview({
    title: 'Message to Claude',
    onSend: function (text) {
      nav('#/session/' + id);
      detailScroll = { id: id, top: 0, stick: true };
      store.setMessageStatus(id, { status: 'sending', text: text });
      ws.request('claude.session.send', { id: id, text: text }).then(function (res) {
        var delivery = (res && res.delivery) || 'next-tool';
        store.setMessageStatus(id, { status: delivery, text: text });
        // A several-part question is answered part by part on its own screen.
        if (delivery === 'answer-on-panel') {
          var asks = store.get().asks;
          for (var i = 0; i < asks.length; i++) {
            if (asks[i].kind === 'prompt' && asks[i].sessionId === id) return openPrompt(asks[i].id);
          }
        }
      }).catch(function (e) {
        store.setMessageStatus(id, { status: 'failed', text: text, error: (e && e.message) || 'failed' });
      });
    },
    onCancel: function () { nav('#/session/' + id); },
  }, startNow);
}

// ---- new session ---------------------------------------------------------------
// Hold the top button on the sessions grid: pick a machine (#/new), pick one of
// its five recent projects (#/new/<machine>), say what it should do (the
// dictation screen), check it and START. screens/new-session.js holds the rules;
// this wires them to the dial, the socket and the toast. Every request names its
// machine (host): a request without one is refused.

// The Mac gives `claude --bg` 30 s; this waits a little longer, so its own
// answer arrives first and a start is never reported lost while it is running.
var START_WAIT_MS = 45000;

function newRows() {
  newView.machines = ws.machines();
  return machineRows(newView.machines, store.get().sessions, newView.notSetUp);
}

// The machine screen, the cursor on lastHost (the machine used last, or the one
// just left) if it can be chosen, else on the first that can.
function showMachines(lastHost) {
  newView.cursor = initialMachine(newRows(), lastHost);
  nav('#/new');
}

function openNewSession() {
  // A start that failed while the owner was elsewhere (or whose outcome is
  // unknown) left its check screen waiting: this hold opens it, once.
  var pending = takePending(newView);
  if (pending) return sayNewSession(pending.host, pending.project, pending.text);
  // A machine that wasn't set up may be by now: ask again each visit.
  newView.notSetUp = {};
  showMachines(prefs.get('newSessionHost'));
}

function dialNew(host, dir) {
  if (host) newView.cursor = stepProject(newView.projects.length, newView.cursor, dir);
  else newView.cursor = stepMachine(newRows(), newView.cursor, dir);
  render();
}

var projectsAsked = 0;   // only the latest load may fill the screen

function loadProjects(host) {
  var asked = ++projectsAsked;
  newView.host = host;
  newView.projects = [];
  newView.cursor = 0;
  newView.error = null;
  newView.loading = true;
  ws.request('claude.projects.recent', { host: host }).then(function (res) {
    if (asked !== projectsAsked) return;
    newView.projects = (res && res.projects) || [];
    newView.loading = false;
    if (route().name === 'new') render();
  }, function (e) {
    if (asked !== projectsAsked) return;
    newView.loading = false;
    if (e && e.message === 'Unknown method') {
      // That machine's service predates new sessions: its row says so.
      newView.notSetUp[host] = true;
      var r = route();
      if (r.name === 'new' && r.arg === host) showMachines(host);
      else if (r.name === 'new') render();
      return;
    }
    newView.error = (e && e.message) || 'failed';
    if (route().name === 'new') render();
  });
}

function chooseMachine(index) {
  var row = newRows()[index];
  if (!row) return;
  if (row.status) return toast(row.status);   // not answering, not set up yet
  prefs.set('newSessionHost', row.name);
  loadProjects(row.name);
  nav('#/new/' + row.name);
}

function chooseProject(index) {
  var press = index < MAX_PROJECTS ? projectPress(newView.projects[index], newView.host) : null;
  if (!press) return;
  if (press.toast) return toast(press.toast);
  sayNewSession(newView.host, press.open, '');
}

// The dictation screen for a project; with `text` it opens on the check (a start
// that was refused comes back here with what was said).
function sayNewSession(host, project, text) {
  openDictateReview({
    title: 'NEW SESSION · ' + String(project.name).toUpperCase(),
    sendLabel: 'Start',
    note: checkLine(project.name, ASKS_REACH_PANEL),
    text: text,
    onSend: function (said) { startNewSession(host, project, said); },
    onCancel: function () { dropPending(newView); nav('#/new/' + host); },
  });
}

function startNewSession(host, project, text) {
  dropPending(newView);   // a new start replaces a check that was waiting
  var sentAt = 0;
  var sent = pressStart(newView, function () {
    sentAt = Date.now();
    nav('#/list');
    toast('STARTING…', 8000);
    // The press that sent START may be followed by another, a beat later, meant for the screen it
    // left: on the grid it would open the tile under the dial. Swallow the next second of presses.
    inputGuard.arm();
    ws.request('claude.session.start', { host: host, path: project.path, prompt: text }, START_WAIT_MS).then(function (res) {
      newView.starting = false;
      startWatch.start(res && res.shortId, store.get().sessions);
    }, function (e) {
      // This answer can come 30 s or more after START, with the owner anywhere.
      // The check screen comes back by itself only if nothing is in their hands
      // (new-session.js canReopenCheck); else the text waits for the next hold of
      // the top button on the grid. The press that sent it is not a hand on the
      // panel: only input since then counts toward the guard.
      var where = {
        host: host, project: project, dictating: !!getDictation(), routeName: route().name,
        msSinceInput: msSinceInputAfter(lastInputTs, sentAt, Date.now()), guardMs: INPUT_GUARD_MS,
      };
      toast(startFailed(newView, e, text, function (again) { sayNewSession(host, project, again); }, where), 5000);
    });
  });
  // The last start is still on the wire: keep what was said on the check screen.
  if (!sent) {
    toast('STILL STARTING THE LAST ONE', 4000);
    sayNewSession(host, project, text);
  }
}

// The new session appears in the merged list on its own (claude.sessions.update);
// it opens from the grid it was started from, and nowhere else: a session view
// should not open under a hand that has moved on.
var startWatch = createStartWatch({
  onListed: function (id) {
    toast('STARTED', 1500);
    if (route().name === 'list') openSession(id);
  },
  onTimeout: function () { toast('STARTED · NOT LISTED YET', 4000); },
});

// ---- card actions --------------------------------------------------------------
// A card is a session's finished turn. Its three actions never decide anything;
// the Mac service clears the card itself once a switch or a reply has landed.

// SWITCH: raise the card's session on its own machine, the Mac or the NucBox
// (switchPlan in session-actions.js).
function switchToCard(card) {
  var plan = switchPlan(card);
  if (plan.focus) focusSession(card.sessionId);
  toast(plan.toast);
}

// The dial press on a card: the button it is on, the same as tapping it.
function pressCard(card, button) {
  if (button === 'reply') return replyToCard(card, false);
  if (button === 'clear') return clearCard(card);
  switchToCard(card);
}

// CLEAR: the card goes, with no other effect.
function clearCard(card) {
  store.resolveAsk(card.id);
  // Clearing the last item leaves the empty queue, whose chime row is a control
  // a repeated tap on the CLEAR chip could land on. (Only when it is empty:
  // clearing a stack of quiet cards must stay quick.)
  if (!store.get().asks.length) inputGuard.arm();
  ws.request('claude.card.clear', { id: card.id }).catch(function () { toast('CLEAR FAILED'); });
  toast('CLEARED');
}

// REPLY: dictate, read it, Send. Aimed at the session, captured now, so a card
// replaced or cleared while the owner is talking does not block the reply.
function replyToCard(card, startNow) {
  var sessionId = card.sessionId;
  openDictateReview({
    title: 'Reply to ' + (card.sessionName || 'session'),
    onSend: function (text) {
      nav('#/queue');
      ws.request('claude.session.send', { id: sessionId, text: text }).then(function (res) {
        var delivery = (res && res.delivery) || 'next-tool';
        if (replySent(delivery)) return toast('SENT');
        toast(messageStatusText({ status: delivery }) || 'NOT SENT', 6000);
      }).catch(function (e) {
        toast(messageStatusText({ status: 'failed', error: (e && e.message) || 'failed' }), 6000);
      });
    },
    onCancel: function () { nav('#/queue'); },
  }, startNow);
}

ws.on('claude.message.delivered', function (d) {
  var cur = d && store.get().messageStatus[d.sessionId];
  if (cur && cur.status !== 'answer') store.setMessageStatus(d.sessionId, { status: 'delivered', text: cur.text });
});
ws.on('claude.message.dropped', function (d) {
  // 'replaced' is the panel's own newer message taking its place: nothing to say.
  var cur = d && store.get().messageStatus[d.sessionId];
  if (cur && d.reason === 'owner-typed') store.setMessageStatus(d.sessionId, { status: 'dropped', text: cur.text });
});

onAction('m-hold', function () {
  var r = route();
  if (r.name === 'dictate') return beginTalk();
  if (r.name === 'home') return startDimming();
  if (r.name === 'audio') {
    var n = audioEntities(store.get().ha).length;
    if (n > 1) { audioView.cursor = (audioView.cursor + 1) % n; render(); }
    return;
  }
  if (r.name === 'session' && r.arg) return sayToSession(r.arg, true);
  if (r.name === 'list') return openNewSession();
  if (r.name === 'queue') {
    // Talk to the session a card came from. On any other hero, as before,
    // holding the top button on the queue does nothing.
    var qs = store.get();
    var qh = qs.asks[Math.min(qs.queueIndex, qs.asks.length - 1)];
    if (qh && isCard(qh)) replyToCard(qh, true);
    return;
  }
  if (r.name === 'prompt') {
    var p = store.getAsk(r.arg);
    if (p && !p.expired) dictatePrompt(p, true);
  }
});

onAction('m-release', function () {
  if (route().name === 'dictate') endTalk();
});

function sendPromptAnswer(p, answer) {
  ws.request('claude.prompt.answer', { id: p.id, answer: answer }).then(function (res) {
    if (!res || !res.accepted) { toast('ALREADY ANSWERED'); return; }
    if (answer.kind === 'vscode') focusSession(p.sessionId);
    store.resolveAsk(p.id);
    toast(answer.kind === 'vscode' ? 'OPEN IN VS CODE' : answer.kind === 'feedback' ? 'SENT TO CLAUDE' : 'ANSWERED');
    if (route().name === 'prompt' && route().arg === p.id) nextAskOrBack();
  }).catch(function (e) {
    toast(String((e && e.message) || 'FAILED').toUpperCase());
  });
}

function openAsk(id) {
  // Only a permission has a screen of its own here. A card opens as the queue's
  // hero, never as the ALLOW/DENY screen.
  if (isCard(store.getAsk(id))) {
    store.update(withCursorOn(id));
    return nav('#/queue');
  }
  returnTo = '#/queue';
  askChoice = 0;
  nav('#/ask/' + id);
}

// The queue cursor moved to an ask, with anything half-answered wound back: its
// indices mean the previous hero's options.
function withCursorOn(id) {
  var fields = store.closedAnswer();
  fields.queueIndex = indexOfAsk(id);
  return fields;
}

// The wire send, taking the ask itself: by the time a held queue answer goes
// out, the card is already off the local list, so a lookup by id would fail.
function sendAnswer(ask, choice) {
  if (ask.kind === 'question') {
    // choice is number[][] — one entry per question of the ask, each the option
    // indices picked for it. The daemon turns the whole set into one keystroke
    // sequence, ending with the Return that presses "Submit answers".
    var answers = choice;
    if (!answers || !answers.length) return;
    markSending(ask);
    ws.request('claude.question.answer', { id: ask.id, answers: answers })
      .then(function (res) {
        clearSending(ask.id);
        toast(questionToast(ask, res, answers));
        // The daemon has no such ask — answered elsewhere, or restarted out
        // from under this card. Either way it is not ours to press again.
        // Only tidy up if the card is still showing (prompt-screen path).
        if (/already resolved/i.test(String(res.reason || '')) && store.getAsk(ask.id)) {
          store.resolveAsk(ask.id);
          nextAskOrBack();
        }
      })
      .catch(function () { clearSending(ask.id); toast('SEND FAILED'); });
    return;
  }
  var decision = choice === 0 ? 'allow' : 'deny';
  markSending(ask);
  ws.request('claude.permission.answer', { requestId: ask.id, decision: decision })
    .then(function (res) {
      clearSending(ask.id);
      if (!res.accepted) toast('ALREADY ANSWERED');
    })
    .catch(function () { clearSending(ask.id); toast('SEND FAILED'); });
}

function markSending(ask) {
  store.update({ sending: { id: ask.id, kind: ask.kind } });
}

// By id: an answer flushed early to make way for a newer one can land after
// that newer one went out, and clearing blind would drop the indicator while
// somebody's keystrokes are still being typed.
function clearSending(id) {
  var s = store.get().sending;
  if (s && s.id === id) store.update({ sending: null });
}

// Prompt-screen answer: immediate send. The destructive two-press contract
// still applies — the first press on ALLOW only arms it.
function answerAsk(id, choice) {
  var ask = store.getAsk(id);
  if (!ask) return;
  // Questions are walked in the queue hero; the render redirects them there,
  // so this screen only ever decides permissions.
  if (ask.kind === 'question') return nav('#/queue');
  // An expired permission is unrecoverable — the hook already answered "ask"
  // and closed, so a decision now has nowhere to go.
  if (ask.expired) return skipAsk(id);

  if (choice === 2) return skipAsk(id);
  if (choice === 0 && isDestructive(ask)) {
    var st = store.get();
    if (!(st.armed && st.armed.id === ask.id)) {
      return store.update({ armed: { id: ask.id, expires: Date.now() + ARM_MS } });
    }
    store.update({ armed: null });
  }
  sendAnswer(ask, choice);
}

// Allow from the queue hero. A destructive command arms on the first press —
// the chip fills danger and asks again — and only fires on the second.
function allowHero(hero) {
  var st = store.get();
  if (isDestructive(hero) && !(st.armed && st.armed.id === hero.id)) {
    store.update({ armed: { id: hero.id, expires: Date.now() + ARM_MS } });
    return;
  }
  answerFromQueue(hero, 0);
}

// ---- walking a question ask -------------------------------------------------
//
// A question ask is one terminal dialog and may hold several questions. They
// are walked here, on the device, and nothing goes to the Mac until SUBMIT —
// which is what makes every answer editable right up to the last press, and
// what lets the dialog's own "Submit answers" step be pressed at all.

// The transitions themselves are pure and live in answering.js; this applies
// their result — the fields to store, and the answers to send once the walk is
// over.
function applyStep(ask, step) {
  if (!step) return false;
  if (step.fields) store.update(step.fields);
  if (step.incomplete) toast('ANSWER THIS ONE FIRST');
  if (step.submit) answerFromQueue(ask, step.submit);
  return true;
}

function openAnswering(ask) { applyStep(ask, startWalk(ask)); }
function pressOption(ask, row) { applyStep(ask, pressOptionAt(ask, store.get(), row)); }
function pressReview(ask, row) { applyStep(ask, pressReviewAt(ask, store.get(), row)); }
function backStep(ask) { return applyStep(ask, backStepAt(ask, store.get())); }

// Answering from the queue must leave you on the queue with the next ask
// promoted into the hero — not fling you into the next item's prompt screen.
// returnTo is what nextAskOrBack() checks to suppress that jump.
//
// The answer itself is held for UNDO_MS before it is sent, so back can take
// it back: the card leaves the list at once (the next ask promotes), the
// toast says the answer is undoable, and only when the window closes does the
// decision actually go to the daemon.
var undoTimer = null;

// choice is the whole decision: number[][] for a question (every question of
// the ask), 0/1 for a permission. It is held intact so undo restores the whole
// set, not a half-walked one.
function answerFromQueue(ask, choice) {
  returnTo = '#/queue';
  flushUndo();   // at most one answer in flight; an older one goes out now
  var index = indexOfAsk(ask.id);
  store.resolveAsk(ask.id);
  undoTimer = setTimeout(flushUndo, UNDO_MS);
  var fields = store.closedAnswer();
  fields.undo = { ask: ask, index: index, choice: choice, expires: Date.now() + UNDO_MS };
  fields.armed = null;
  store.update(fields);
  // If that was the last thing to decide, a second press of a double press has
  // nothing left to land on but an empty queue (whose chime row is a control)
  // or a quiet card: swallow the next second of presses, as a jump does.
  if (queueSettled(store.get().asks)) inputGuard.arm();
  // No toast here: the in-flight indicator says the same thing and keeps saying
  // it for the whole wait, where a toast would have faded after 2.5s and left
  // the last four seconds of the undo window unannounced.
}

function clearUndo() {
  if (undoTimer) { clearTimeout(undoTimer); undoTimer = null; }
  var u = store.get().undo;
  if (u) store.update({ undo: null });
  return u;
}

function flushUndo() {
  var u = clearUndo();
  if (u) sendAnswer(u.ask, u.choice);
}

// The daemon resolved the held ask itself — answered in the terminal, or the
// hook timed out. Nothing to send, nothing on screen to update.
function cancelUndo(id) {
  var u = store.get().undo;
  if (!u || u.ask.id !== id) return false;
  clearUndo();
  return true;
}

function restoreUndo() {
  var u = store.get().undo;
  if (!u) return false;
  clearUndo();
  var asks = store.get().asks.slice();
  var at = Math.min(u.index, asks.length);
  asks.splice(at, 0, u.ask);
  var fields = store.closedAnswer();
  fields.asks = asks;
  fields.undo = null;
  fields.queueIndex = at;
  store.update(fields);
  toast('RESTORED');
  nav('#/queue');
  return true;
}

// A question can only be answered by typing into its terminal, so say exactly
// how far we got: typed it, focused the window for you, or neither and why.
function questionToast(ask, res, answers) {
  if (res.viaKeyboard) return 'ANSWERED ON MAC';
  var why = String(res.reason || '');
  if (res.focused) {
    // Naming the key only helps when there is exactly one to press. A group,
    // or a multiSelect, is a sequence — telling someone to press "1" for it
    // would be telling them to answer it wrong.
    var q = questionsOf(ask);
    var single = q.length === 1 && !q[0].multiSelect;
    return single ? 'FOCUSED — PRESS ' + (answers[0][0] + 1) + ' ON MAC'
      : 'FOCUSED — ANSWER ON MAC';
  }
  // The card outlived the daemon's copy of the ask — answered on the Mac, or
  // the daemon restarted under it. Not a failure to answer, and not something
  // pressing again fixes: the terminal owns it now.
  if (/already resolved/i.test(why)) return 'GONE — ANSWER IN TERMINAL';
  if (/denied/i.test(why)) return 'ALLOW AUTOMATION IN MAC SETTINGS';
  if (/background agent/i.test(why)) return 'BACKGROUND AGENT — NO WINDOW';
  if (/registry|tty|no session|unknown session/i.test(why)) return 'NO TERMINAL WINDOW FOUND';
  return 'COULD NOT ANSWER';
}

function skipAsk(id) {
  store.resolveAsk(id);
  toast('LEFT FOR THE TERMINAL');
  nextAskOrBack();
}

function nextAskOrBack() {
  // Only something left to decide is "next" (nextAskStep): a card or an expired
  // notice left over must not drag the owner onto the queue.
  var step = nextAskStep(store.get().asks, returnTo);
  if (step.hash !== returnTo) askChoice = 0;
  if (step.queueIndex !== null) store.update({ queueIndex: step.queueIndex });
  nav(step.hash);
}

// ---- screen sleep -----------------------------------------------------------
// display.js decides when the screen is dark (the Mac's display, the link to
// it, the asks waiting, the knob) and drives the black overlay and, on the Car
// Thing, the backlight and the light sensor through the recorder. The
// simulator has no recorder: the overlay alone darkens it.

var screenDarkEl = document.getElementById('screen-dark');
var display = createDisplay({
  recorder: readConfig(window.PANEL_CONFIG).recorder,
  overlay: {
    show: function () { screenDarkEl.className = 'on'; },
    // 'instant' drops the transition with the opacity, so waking has no fade.
    hide: function () { screenDarkEl.className = 'instant'; },
  },
});
// The sleep gate first (it wakes a dark screen and swallows the press that did),
// then the jump's input guard behind it. Every input stamps the clock before
// either, because the jump waits 10 s after the last input and the queue hands
// back after a minute, and a swallowed press is still the owner's hand on it.
var gatedInput = guardGate(inputGuard, display.gate);
setGate(function (action, source) {
  lastInputTs = Date.now();
  return gatedInput(action, source);
});
// The display's own tick, then the Digest list's visit clock (digest-seen.js).
setInterval(tickWithSeen(display, digestSeen, function () { return route().name === 'digest'; }), 1000);

// Expired asks count as resolved: they wait on the terminal, not on the panel.
// So do quiet cards: they keep their place in the queue but no longer hold the
// screen lit. loudCount is both rules.
store.subscribe(function (st) {
  display.asks(loudCount(st.asks));
});

// Sent on change and on every hello, right after claude.queue.sync. It is
// also what tells display.js the link is back with fresh state (see there).
ws.on('claude.mac.power', function (s) {
  daemonAlive();
  display.macPower(s);
});

// ---- daemon events ----------------------------------------------------------

// Any claude.* frame the daemon pushed is proof the daemon is there. This
// matters because on hardware nothing else says so: the device's socket is to
// nocturned on the panel itself and never drops when the Mac link comes and
// goes, claude.daemon.status is synthesized only by the emulator's bridge, and
// so the boot handshake was the one and only thing that ever set this flag. A
// connector that had not finished linking when the app booted therefore left
// DAEMON OFFLINE on screen for the rest of the session while every session,
// prompt and usage figure behind it updated fine.
function daemonAlive() {
  display.linkUp();
  if (store.get().daemonConnected) return;
  store.update({ daemonConnected: true });
  // Same reasoning as claude.daemon.status: the queue on the other side may be
  // a different one than the cards on screen came from, and a daemon we were
  // not talking to holds no watch state of ours.
  syncQueue(false);
  scheduleWatch(true);
}

// Only the Mac's own frames say the Mac is there; the NucBox's sessions
// arrive on their own link (ws.js).
function fromMac(f) { return !f || !f.host || f.host === 'mac'; }

ws.on('claude.sessions.update', function (snap, f) {
  if (fromMac(f)) daemonAlive();
  store.applySnapshot(snap);
  startWatch.check(store.get().sessions);
  // Subagent counts ride the snapshot; an open session or feed follows them.
  var r = route();
  if ((r.name === 'session' || r.name === 'agent') && r.arg) refreshMessagesSoon(r.arg);
});
ws.on('claude.session.update', function (d, f) {
  if (fromMac(f)) daemonAlive();
  store.applyDetail(d);
  var r = route();
  if (d && (r.name === 'session' || r.name === 'agent') && r.arg === d.id) refreshMessagesSoon(d.id);
});
ws.on('claude.usage.update', function (u) { daemonAlive(); store.update({ usage: u }); });
// The Mac's digest (ws-mux.js drops any other machine's). It is only stored:
// a digest update never toasts, wakes the screen or moves it.
ws.on('claude.digest.update', function (d) { store.update(withDigest(store.get(), d)); });

// Every ask surfaces on the queue — the screen where everything is answerable
// in place. A held question or plan opens its own screen on arrival, as it
// always did. Anything else loud (a permission, a question, an ASKING or ERROR
// card) jumps to the queue from any screen unless the owner is mid-action or
// has just touched the panel, in which case the jump waits (requestJump): the
// pulsing edge and the topbar count carry the alert meanwhile. A quiet item
// only lands in the list. Both ways in, the input guard swallows the next
// second of presses.
function surface(ask) {
  guardHeroChange(function () { store.pushAsk(ask); });
  var r = route();
  if (ask.kind === 'prompt' && opensOnArrival(r.name, r.name === 'prompt' ? store.getAsk(r.arg) : null)) {
    returnTo = window.location.hash || '#/list';
    toast(ask.tool === 'ExitPlanMode' ? 'PLAN TO APPROVE' : 'CLAUDE HAS A QUESTION');
    openPrompt(ask.id);
    inputGuard.arm();
    return;
  }
  if (!isLoud(ask)) return render();
  requestJump();
}

ws.on('claude.permission.request', function (p) {
  surface({
    kind: 'permission',
    id: p.requestId,
    sessionId: p.sessionId,
    tool: p.tool,
    summary: p.summary,
    intent: p.intent || '',
    createdTs: p.createdTs,
    timeoutMs: p.timeoutMs,
    destructive: p.destructive,
  });
});

ws.on('claude.question.request', function (q) {
  surface({
    kind: 'question',
    id: q.id,
    sessionId: q.sessionId,
    // One ask is one terminal dialog; questions holds every question in it.
    // The top-level fields mirror questions[0] and are what the card's summary
    // line reads — questionsOf() rebuilds the list from them if a daemon that
    // predates grouping is on the other end.
    questions: q.questions || null,
    header: q.header,
    question: q.question,
    intent: q.intent || '',
    options: q.options || [],
    multiSelect: !!q.multiSelect,
    createdTs: q.createdTs,
  });
});

function onResolved(id, resolution) {
  // An answer held in its undo window: the daemon beat us to it, so there is
  // nothing to send and nothing on screen to update.
  if (cancelUndo(id)) return;
  var r = route();
  var wasCurrent = r.name === 'ask' && r.arg === id;
  // A timeout is the one resolution nobody chose: the hook gave up and the
  // question is now sitting in a terminal. Keep it on screen saying so instead
  // of clearing it like an answered prompt.
  if (resolution === 'timeout' && store.expireAsk(id)) {
    if (wasCurrent) {
      toast('HOOK TIMED OUT — ANSWER IN TERMINAL');
      render();
    }
    return;
  }
  guardHeroChange(function () { store.resolveAsk(id); });
  var said = resolutionToast(resolution, wasCurrent);
  if (said) toast(said);
  if (wasCurrent) nextAskOrBack();
}

// The daemon's whole waiting list, pushed when any client connects. This is
// what clears cards left behind by a daemon that restarted: on hardware the
// device's own socket is to the connector and never dropped, so nothing else
// tells this screen the queue it is showing belongs to a dead process.
ws.on('claude.queue.sync', function (d) {
  guardHeroChange(function () { store.reconcileAsks((d && d.asks) || []); });
  // queue.sync fires on every client hello — on hardware, the one reliable
  // sign the daemon restarted (the device's own socket is to the connector and
  // never drops). A fresh daemon has no watch state; re-assert ours.
  scheduleWatch(true);
});

// A session's latest finished turn, as a card in the queue. A newer turn's card
// arrives with no clear for the old one (upsertCard drops it), and an ASKING or
// ERROR card is re-sent under the same id when it goes quiet or a summary
// attaches — only a card the panel has not seen, and loud, is news.
ws.on('claude.card.posted', function (card) {
  var isNew = !store.getAsk(card.id);
  guardHeroChange(function () { store.upsertCard(card); });
  if (isNew && card.loud) surface(card);
  else scheduleRender();
});
ws.on('claude.card.cleared', function (d) { guardHeroChange(function () { store.resolveAsk(d.id); }); });

ws.on('claude.prompt.created', function (p) { surface(p); });
ws.on('claude.prompt.resolved', function (p) {
  var r = route();
  var onIt = r.name === 'prompt' && r.arg === p.id;
  // Nobody here chose these: the hold ran out or the panel was gone. Claude
  // Code now shows its own dialog, so the card stays to say where it went.
  if ((p.resolution === 'timeout' || p.resolution === 'panel-gone') && store.expireAsk(p.id)) {
    if (onIt) render();
    return;
  }
  guardHeroChange(function () { store.resolveAsk(p.id); });
  var said = resolutionToast(p.resolution, false);
  if (said) toast(said);
  if (onIt) nextAskOrBack();
});
ws.on('claude.permission.resolved', function (p) { onResolved(p.requestId, p.resolution); });
ws.on('claude.question.resolved', function (q) { onResolved(q.id, q.resolution); });

ws.on('claude.daemon.status', function (s) {
  var was = store.get().daemonConnected;
  store.update({ daemonConnected: !!s.connected });
  // The socket to the connector survives a daemon restart, so this is the only
  // signal that the queue on the other side is a new one. Re-sync, or the asks
  // from before the restart stay on screen with nothing able to resolve them.
  if (!was && s.connected) syncQueue(false);
});

// ---- boot -------------------------------------------------------------------

// The ids the store held when the link last went down. A reconnect's sync
// compares the daemon's list against them, so work the owner has already seen
// does not jump them back to the queue; before the first drop it is empty, and
// work waiting on a fresh connection lands on the queue.
var seenAtClose = {};

// Take the daemon's word for what is still waiting. Called on connect and every
// time the daemon comes back, because a daemon that restarted has forgotten
// every ask it ever sent while this screen kept showing them.
function syncQueue(jumpIfIdle) {
  ws.request('claude.queue.list', {}).then(function (res) {
    var asks = res.asks || [];
    // Worked out before the list lands in the store, against what this panel
    // held when the link went down.
    var jump = jumpIfIdle && reconnectJumpDue(asks, seenAtClose, route().name);
    guardHeroChange(function () { store.reconcileAsks(asks); });
    // The queue is where everything is answerable in place, so that is where
    // a fresh connection with work waiting lands. "Work waiting" is what is
    // loud: quiet cards and UPDATE cards sit in the list too, and a reconnect
    // must not pull the screen over for those, nor must a loud card the owner
    // already saw and backed out of: only an item this panel had not seen before
    // the link dropped is news (reconnectJumpDue). requestJump goes to the most
    // urgent loud item, or nowhere, and follows the same rule as any other
    // jump (not under the owner's hand).
    if (jump) requestJump();
  }).catch(function () {});
}

// The first list after (re)connecting. A slow answer on a good socket used to
// leave the banner up until the next reconnect; it now retries while the
// socket stays open.
var BOOT_RETRY_MS = 3000;
function bootSessions() {
  ws.request('claude.sessions.list', {}).then(function (snap) {
    store.update({ daemonConnected: true });
    store.applySnapshot(snap);
  }).catch(function (e) {
    store.update({ daemonConnected: false });
    if (!e || e.message !== 'socket closed') setTimeout(bootSessions, BOOT_RETRY_MS);
  });
}

ws.onOpen(function () {
  bootSessions();

  syncQueue(true);
  scheduleWatch(true);
  chime.fetch();

  ws.request('claude.usage.get', { slim: 1 }).then(function (u) {
    store.update({ usage: u });
  }).catch(function () {});

  // The Mac's only. A service older than the digest answers Unknown method,
  // and the digest stays as it was (null on a first connect).
  ws.request('claude.digest.get', {}).then(function (d) {
    store.update(withDigest(store.get(), d));
  }).catch(function () {});
});

// The service went away (restart, Mac asleep, Wi-Fi drop): show the banner at
// once. ws.js reconnects with backoff, and the onOpen above re-runs the boot
// fetches on the new socket, so nothing needs a reload.
ws.onClose(function () {
  seenAtClose = askIdSet(store.get().asks);
  display.linkDown();
  store.update({ daemonConnected: false });
});

// ---- tasks (preset 1) ---------------------------------------------------------
// The TickTick work list, served by the NucBox (nucbox/tasks-service.js): it
// holds the TickTick token, transcribes what's said here and keeps the focus
// timer. Nothing on this page goes through the Mac, so it works with the Mac
// asleep or away.
//
//   #/tasks          the list. Knob moves, press opens a task, a tap on START
//                    goes straight to the minutes dial. Hold the top button to
//                    say a new task.
//   #/task/<id>      one task: Start focus, its subtasks (press ticks one off),
//                    Mark task done. Hold the top button to say a subtask.
//   #/focusset/<id>  the minutes dial: turn to set, press to start.
//   #/focus          the running timer (press twice to stop), then Time's up.

var tasksCfg = readConfig(window.PANEL_CONFIG).tasks;
var tasksApi = tasksCfg ? createTasksClient(tasksCfg) : null;
var TASKS_REFRESH_MS = 60000;
var FOCUS_MINUTES_KEY = 'focusMinutes';
var STOP_ARM_MS = 4000;
try {
  var savedMinutes = Number(window.localStorage.getItem(FOCUS_MINUTES_KEY));
  if (savedMinutes) taskView.minutes = stepMinutes(savedMinutes, 0);
} catch (e) {}

store.update({
  tasks: { configured: !!tasksApi, status: 'idle', error: null, list: '', items: [] },
  focus: { focus: null, offset: 0 },
});

function isTasksRoute(name) {
  return name === 'tasks' || name === 'task' || name === 'focusset' || name === 'focus';
}

function setTasks(fields) {
  var cur = store.get().tasks;
  var next = {};
  for (var k in cur) next[k] = cur[k];
  for (var f in fields) next[f] = fields[f];
  store.update({ tasks: next });
}

// Each reply carries the NucBox's clock, so the countdown runs on its time.
function applyFocus(body) {
  if (!body || !('focus' in body)) return;
  var offset = typeof body.now === 'number' ? body.now - Date.now() : store.get().focus.offset;
  store.update({ focus: { focus: body.focus || null, offset: offset } });
  focusTick();
}

// A read that fails is tried again soon, backing off to the minute-long
// refresh: at boot the page loads before the Car Thing's Wi-Fi is up, and the
// first read always fails.
var TASKS_RETRY_MS = [3000, 6000, 12000, 24000, 48000];
var tasksRetries = 0;
var tasksRetryTimer = null;

var tasksLoading = false;
function loadTasks(fresh) {
  if (!tasksApi || tasksLoading) return;
  tasksLoading = true;
  if (store.get().tasks.status === 'idle') setTasks({ status: 'loading' });
  tasksApi.list(fresh).then(function (body) {
    tasksLoading = false;
    tasksRetries = 0;
    setTasks({ status: 'ok', error: null, list: (body.list && body.list.name) || '', items: body.tasks || [] });
    applyFocus(body);
  }, function (e) {
    tasksLoading = false;
    setTasks({ status: 'error', error: e.message });
    if (tasksRetryTimer || tasksRetries >= TASKS_RETRY_MS.length) return;
    tasksRetryTimer = setTimeout(function () {
      tasksRetryTimer = null;
      loadTasks(true);
    }, TASKS_RETRY_MS[tasksRetries++]);
  });
}

function tasksFailed(e) {
  toast(e && e.message === 'items-full' ? 'CHECKLIST FULL' : e && e.message === 'task-gone' ? 'TASK GONE' : 'NUCBOX FAILED');
  loadTasks(true);
}

setInterval(function () {
  if (isTasksRoute(route().name)) loadTasks(false);
}, TASKS_REFRESH_MS);
window.addEventListener('hashchange', function () {
  if (isTasksRoute(route().name)) loadTasks(false);
});

// Dictation for this page goes to the NucBox.
function sayTask(opts, startNow) {
  openDictateReview({
    title: opts.title,
    sendLabel: 'Add',
    transcribe: function (blob, mime) {
      return tasksApi.transcribe(blob, mime).then(function (res) { return (res && res.text) || ''; });
    },
    errorText: tasksErrorText,
    onSend: function (text) {
      nav(opts.back);
      opts.send(text).then(function (res) {
        toast(res && res.outcome === 'duplicate' ? 'ALREADY THERE' : 'ADDED');
        loadTasks(true);
      }, tasksFailed);
    },
    onCancel: function () { nav(opts.back); },
  }, startNow);
}

function sayNewTask(startNow) {
  sayTask({ title: 'New task on ' + (store.get().tasks.list || 'the list'), back: '#/tasks',
    send: function (text) { return tasksApi.create(text); } }, startNow);
}

function saySubtask(task, startNow) {
  sayTask({ title: 'New subtask of ' + task.title, back: '#/task/' + task.id,
    send: function (text) { return tasksApi.addItem(task.id, text); } }, startNow);
}

function openTask(id) {
  taskView.row = 0;
  nav('#/task/' + id);
}

function openFocusSetup(id) {
  var f = store.get().focus.focus;
  // A timer already on this task: show it rather than starting over.
  if (f && f.taskId === id && focusPhase(f, Date.now(), store.get().focus.offset).phase === 'running') return nav('#/focus');
  nav('#/focusset/' + id);
}

function startFocus(id) {
  var task = findTask(store.get().tasks, id);
  if (!task) return nav('#/tasks');
  var minutes = taskView.minutes;
  try { window.localStorage.setItem(FOCUS_MINUTES_KEY, String(minutes)); } catch (e) {}
  taskView.stopArmed = 0;
  taskView.doneRow = 0;
  // Shown at once; the NucBox's reply sets the true start.
  store.update({ focus: { focus: { taskId: id, title: task.title, minutes: minutes, startedAt: Date.now(), endsAt: Date.now() + minutes * 60000 }, offset: 0 } });
  nav('#/focus');
  tasksApi.startFocus(id, task.title, minutes).then(applyFocus, function (e) {
    store.update({ focus: { focus: null, offset: 0 } });
    toast('COULDN\'T START');

  });
}

function stopFocus() {
  store.update({ focus: { focus: null, offset: store.get().focus.offset } });
  focusTick();
  tasksApi.stopFocus().then(applyFocus, function () { toast('NUCBOX FAILED'); });
}

function completeTask(id) {
  if (!tasksApi) return;
  var cur = store.get().tasks;
  var left = [];
  for (var i = 0; i < cur.items.length; i++) if (cur.items[i].id !== id) left.push(cur.items[i]);
  setTasks({ items: left });
  var f = store.get().focus.focus;
  if (f && f.taskId === id) store.update({ focus: { focus: null, offset: store.get().focus.offset } });
  tasksApi.complete(id).then(function (res) {
    toast(res && res.outcome === 'moved' ? 'ALREADY DONE' : 'DONE');
    loadTasks(true);
  }, tasksFailed);
}

function pressTaskRow(id, index) {
  var task = findTask(store.get().tasks, id);
  if (!task) return nav('#/tasks');
  var row = taskRows(task)[index];
  if (!row) return;
  taskView.row = index;
  if (row.kind === 'start') return openFocusSetup(id);
  if (row.kind === 'complete') return completeTask(id);
  setTasks(withItemToggled(store.get().tasks, id, row.id));
  tasksApi.toggleItem(id, row.id).then(function () { loadTasks(true); }, tasksFailed);
}

function pressFocusDone(index) {
  var f = store.get().focus.focus;
  if (!f) return nav('#/tasks');
  if (index === 0) { completeTask(f.taskId); stopFocus(); return nav('#/tasks'); }
  if (index === 1) return startFocus(f.taskId);
  stopFocus();
  nav('#/task/' + f.taskId);
}

// Once a second: the countdown on the focus screen and on the chip shown on
// every other screen, the screen kept lit while it runs, and, as it ends, the
// focus screen brought up unless a question for Claude is on screen.
var focusChipEl = document.getElementById('focus-chip');
var lastFocusPhase = 'none';
var lastChip = '';
function focusTick() {
  var st = store.get();
  var p = focusPhase(st.focus.focus, Date.now(), st.focus.offset);
  display.focus(p.phase === 'none' ? null : p.phase);
  var r = route();
  if (p.phase === 'done' && lastFocusPhase === 'running') {
    taskView.doneRow = 0;
    if (r.name !== 'queue' && r.name !== 'ask' && r.name !== 'prompt' && r.name !== 'dictate') nav('#/focus');
  }
  lastFocusPhase = p.phase;
  if (taskView.stopArmed && Date.now() > taskView.stopArmed) taskView.stopArmed = 0;
  if (r.name === 'focus') render();
  var chip = r.name === 'focus' ? null : focusChip(st.focus, Date.now());
  var key = chip ? chip.text + (chip.done ? '!' : '') : '';
  if (key === lastChip || !focusChipEl) return;
  lastChip = key;
  focusChipEl.textContent = chip ? chip.text : '';
  focusChipEl.className = chip ? 'focus-chip show' + (chip.done ? ' done' : '') : 'focus-chip';
}
setInterval(focusTick, 1000);
if (focusChipEl) focusChipEl.addEventListener('click', function () { nav('#/focus'); });

function dialTasks(r, dir) {
  var st = store.get();
  if (r.name === 'tasks') {
    var n = st.tasks.items.length;
    if (n) taskView.cursor = Math.max(0, Math.min(n - 1, taskView.cursor + dir));
  } else if (r.name === 'task') {
    var rows = taskRows(findTask(st.tasks, r.arg));
    if (rows.length) taskView.row = Math.max(0, Math.min(rows.length - 1, taskView.row + dir));
  } else if (r.name === 'focusset') {
    taskView.minutes = stepMinutes(taskView.minutes, dir);
  } else if (r.name === 'focus') {
    if (focusPhase(st.focus.focus, Date.now(), st.focus.offset).phase !== 'done') return;
    taskView.doneRow = Math.max(0, Math.min(DONE_ROW_COUNT - 1, taskView.doneRow + dir));
  }
  render();
}

function selectTasks(r) {
  var st = store.get();
  if (r.name === 'tasks') {
    var t = st.tasks.items[Math.min(taskView.cursor, st.tasks.items.length - 1)];
    if (t) openTask(t.id);
  } else if (r.name === 'task') {
    pressTaskRow(r.arg, taskView.row);
  } else if (r.name === 'focusset') {
    startFocus(r.arg);
  } else if (r.name === 'focus') {
    var phase = focusPhase(st.focus.focus, Date.now(), st.focus.offset).phase;
    if (phase === 'done') return pressFocusDone(taskView.doneRow);
    if (phase !== 'running') return nav('#/tasks');
    if (taskView.stopArmed) { taskView.stopArmed = 0; stopFocus(); toast('STOPPED'); return nav('#/tasks'); }
    taskView.stopArmed = Date.now() + STOP_ARM_MS;
    render();
  }
}

function backTasks(r) {
  if (r.name === 'task') return nav('#/tasks');
  if (r.name === 'focusset') return nav('#/task/' + r.arg);
  if (r.name === 'focus') {
    var st = store.get();
    var f = st.focus.focus;
    // Back on Time's up clears it; on a running timer it only leaves.
    if (f && focusPhase(f, Date.now(), st.focus.offset).phase === 'done') { stopFocus(); return nav('#/task/' + f.taskId); }
    taskView.stopArmed = 0;
    return nav('#/tasks');
  }
  // The list is top-level, like Home: back does nothing there.
}

// Registered before the other screens' handlers (see registerTasksInput's
// call): each sees the route the input arrived on, so a press that sends a
// dictation and lands back on a task is not also a press on that task.
function registerTasksInput() {
  onAction('dial', function (dir) { var r = route(); if (isTasksRoute(r.name)) dialTasks(r, dir); });
  onAction('select', function () { var r = route(); if (isTasksRoute(r.name)) selectTasks(r); });
  onAction('back', function () { var r = route(); if (isTasksRoute(r.name)) backTasks(r); });
  onAction('m-hold', function () {
    var r = route();
    if (!tasksApi) return;
    if (r.name === 'tasks') return sayNewTask(true);
    if (r.name === 'task') {
      var task = findTask(store.get().tasks, r.arg);
      if (task) saySubtask(task, true);
    }
  });
  onAction('tap', function (t) {
    var r = route();
    if (t.action === 'task-open' && t.id) {
      var items = store.get().tasks.items;
      for (var i = 0; i < items.length; i++) if (items[i].id === t.id) taskView.cursor = i;
      openTask(t.id);
    } else if (t.action === 'task-start' && t.id) {
      openFocusSetup(t.id);
    } else if (t.action === 'task-row' && r.name === 'task') {
      pressTaskRow(r.arg, Number(t.id));
    } else if (t.action === 'focus-done' && r.name === 'focus') {
      pressFocusDone(Number(t.id));
    }
  });
}

if (tasksApi) {
  loadTasks(false);
  tasksApi.focus().then(applyFocus, function () {});
}

// Boot onto Tasks when the NucBox serves them, else Home when Home Assistant
// is set up, else the session list.
if (!window.location.hash) {
  var bootCfg = window.PANEL_CONFIG || {};
  window.location.hash = tasksApi ? '#/tasks' : bootCfg.ha ? '#/home' : '#/list';
}
onRouteForHa();
render();
