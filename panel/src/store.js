// App state: session snapshot, detail cache, permission queue, daemon link.

import { setTzOffset, setServerNow, now } from './clock.js';
import { isCard, orderQueue } from './inbox.js';
import { actionRowCount, cursorAfterRows } from './screens/session-detail.js';

var state = {
  sessions: [],
  stats: { active: 0, attention: 0 },
  details: {},          // id -> SessionDetail
  messages: {},         // id -> Message[] (recent conversation, oldest first)
  subagents: {},        // session id -> Subagent[]
  feeds: {},            // agent id -> {steps: Message[], report}
  agentSel: -1,         // selected action/subagent row in the session view, -1 = none
  stopArmedFor: null,   // session id whose STOP row was pressed once and now reads PRESS AGAIN TO STOP
  stopArmedUntil: null, // ms time that arm runs out (main.js's one-second tick clears both)
  chimeOn: null,        // the Mac's chime setting; null until the Mac has said
  messageStatus: {},    // session id -> {status, text, error} of the last panel message
  // Home Assistant: configured from PANEL_CONFIG.ha; states is the client's
  // live map; optimistic holds what the knob just set, per entity.
  ha: { configured: false, status: 'idle', url: '', home: [], audio: [], nucbox: null, states: {}, optimistic: {} },
  // Everything waiting on a human, in inbox.js's orderQueue order: permissions,
  // questions and plans first (oldest first), then ASKING/ERROR cards (oldest
  // first), then UPDATE cards (newest first). Three kinds:
  //   permission — {kind:'permission', id, sessionId, tool, summary, intent,
  //                 createdTs, timeoutMs}
  //   question   — {kind:'question', id, sessionId, intent, createdTs,
  //                 questions:[{header, question, options:[{label,
  //                 description}], multiSelect}]}
  //   card       — {kind:'card', id, sessionId, sessionName, host, tag, text,
  //                 excerpt, intent, createdTs, stoppedTs, loud, loudUntil,
  //                 endedTs, summary} — one per session, its latest finished
  //                 turn; upsertCard keeps it that way
  // One question ask is one terminal dialog, however many questions it holds;
  // header/question/options/multiSelect are carried alongside as mirrors of
  // questions[0] for the card's summary line.
  asks: [],
  usage: null,          // latest claude.usage.update payload
  digest: null,         // the Mac's Digest (claude.digest.get / .update), null until one arrives
  digestSel: null,      // session id of the open card on #/digest, null for the first
  daemonConnected: true,
  selectedIndex: 0,     // session grid cursor
  onDigestCard: false,  // the grid cursor is on the digest's first card (session-list.js)
  queueIndex: 0,        // queue list cursor
  queueCardSel: null,   // {id, chip}: the button the dial is on, on that card (inbox.js)
  queueAnswering: false, // question hero's option list is open in place
  queueChoice: 0,        // cursor within that list
  // A question ask can hold several questions — one terminal dialog, walked
  // here one question at a time. Nothing is sent until the review step's
  // SUBMIT, so every answer stays editable until then.
  queueQIndex: 0,        // which question of the ask is open
  queueAnswers: [],      // number[][] — option indices picked, per question
  queueReview: false,    // the review + SUBMIT step is showing
  queueFromReview: false, // this question was opened from review — an edit, so
                          // answering it returns there rather than walking on
  armed: null,          // {id, expires} — destructive ask half-pressed
  undo: null,           // {ask, index, choice, expires} — answer held, undoable
  sending: null,        // {id, kind} — answer on the wire, daemon typing it
  mascotOn: true,       // clock-screen sprite; tap the clock to toggle
};

var subs = [];

// The in-progress answer, wound back to nothing. Every path that changes which
// ask the hero is showing goes through this: a half-walked set of answers must
// never survive onto a different ask, where its indices mean other options.
export function closedAnswer() {
  return {
    queueAnswering: false, queueChoice: 0, queueQIndex: 0, queueAnswers: [],
    queueReview: false, queueFromReview: false,
  };
}

function withClosedAnswer(fields) {
  var out = closedAnswer();
  for (var k in fields) out[k] = fields[k];
  return out;
}

export function get() { return state; }

export function subscribe(fn) { subs.push(fn); }

export function update(fields) {
  for (var k in fields) state[k] = fields[k];
  for (var i = 0; i < subs.length; i++) subs[i](state);
}

export function applySnapshot(snap) {
  setServerNow(snap.serverNowMs);
  setTzOffset(snap.tzOffsetMin);
  var sel = state.sessions[state.selectedIndex];
  var fields = { sessions: snap.sessions || [], stats: snap.stats || state.stats };
  // Details for sessions the daemon no longer lists would pile up forever on a
  // device that never reboots. A pruned detail costs one refetch (openSession
  // asks the daemon anyway); an unpruned map costs memory for every session
  // since boot.
  var keep = {};
  for (var j = 0; j < fields.sessions.length; j++) {
    var id = fields.sessions[j].id;
    if (state.details[id]) keep[id] = state.details[id];
  }
  // The one screen that reads a detail after its session leaves the snapshot:
  // a session that ends while you are looking at it. Its farewell detail says
  // "ended" — pruning it would blank the screen to LOADING….
  var h = (typeof window !== 'undefined' && window.location.hash) || '';
  if (h.indexOf('#/session/') === 0) {
    var open = h.slice('#/session/'.length);
    if (state.details[open]) keep[open] = state.details[open];
  }
  fields.details = keep;
  if (sel) {
    for (var i = 0; i < fields.sessions.length; i++) {
      if (fields.sessions[i].id === sel.id) { fields.selectedIndex = i; break; }
    }
  }
  if (fields.selectedIndex === undefined) {
    fields.selectedIndex = Math.min(state.selectedIndex, Math.max(0, fields.sessions.length - 1));
  }
  update(fields);
}

// The session whose view (or one of its subagent feeds) is on screen, or null.
// The dial cursor, agentSel, belongs to it.
function sessionOnScreen() {
  var h = (typeof window !== 'undefined' && window.location && window.location.hash) || '';
  var m = /^#\/(?:session|agent)\/([^\/]+)/.exec(h);
  return m ? m[1] : null;
}

export function applyDetail(detail) {
  var prev = state.details[detail.id];
  state.details[detail.id] = detail;
  // A change in the action rows (OPEN NOW arriving or going) must not slide a row
  // under a cursor that is resting on another one.
  if (prev && state.agentSel > 0 && sessionOnScreen() === detail.id) {
    var subs = state.subagents[detail.id];
    state.agentSel = cursorAfterRows(state.agentSel, prev, detail, subs ? subs.length : 0);
  }
  update({});
}

export function applyMessages(id, list) {
  state.messages[id] = list || [];
  update({});
}

export function applySubagents(id, list) {
  state.subagents[id] = list || [];
  // The action rows lead the list (session-detail.js actionRowCount), and a
  // background session has more of them.
  var rows = state.subagents[id].length + actionRowCount(state.details[id]);
  if (state.agentSel >= rows) state.agentSel = rows - 1;
  update({});
}

export function setMessageStatus(id, status) {
  state.messageStatus[id] = status;
  update({});
}

export function applyFeed(agentId, feed) {
  state.feeds[agentId] = feed;
  update({});
}

// The ask under the queue cursor, or null.
function heroAsk() {
  if (!state.asks.length) return null;
  return state.asks[Math.min(state.queueIndex, state.asks.length - 1)];
}

// Order a changed list and find the cursor in it. The cursor is a position, and
// a position stops meaning anything the moment an item lands ahead of it, so it
// follows the hero by id. When the hero is gone the heir (a card that replaced
// it) takes the cursor; failing that the old position, clamped. `kept` says the
// hero is still the hero, which is the only case an in-progress answer
// survives — its indices mean that ask's options.
function seat(list, heroId, heirId) {
  var next = orderQueue(list);
  var at = -1;
  var kept = false;
  for (var i = 0; i < next.length; i++) {
    if (heroId && next[i].id === heroId) { at = i; kept = true; break; }
  }
  if (at < 0 && heirId) {
    for (var j = 0; j < next.length; j++) if (next[j].id === heirId) { at = j; break; }
  }
  if (at < 0) at = Math.min(state.queueIndex, Math.max(0, next.length - 1));
  return { asks: next, queueIndex: at, kept: kept };
}

function seatedFields(seated) {
  var fields = { asks: seated.asks, queueIndex: seated.queueIndex };
  return seated.kept ? fields : withClosedAnswer(fields);
}

// A card's session name, with the machine when it isn't the Mac.
function nameAsk(ask) {
  if (!ask.sessionName) ask.sessionName = sessionName(ask.sessionId);
  var tagText = ask.machine ? ' · ' + ask.machine : '';
  if (tagText && ask.sessionName.slice(-tagText.length) !== tagText) ask.sessionName += tagText;
}

export function pushAsk(ask) {
  for (var i = 0; i < state.asks.length; i++) {
    if (state.asks[i].id === ask.id) return;
  }
  nameAsk(ask);
  var hero = heroAsk();
  var seated = seat(state.asks.concat([ask]), hero && hero.id, null);
  // A new ask never takes the cursor and never closes an answer in progress;
  // surface() decides whether it becomes the hero.
  update({ asks: seated.asks, queueIndex: seated.queueIndex });
}

// One card per session: its latest finished turn. When a newer turn replaces
// the card the service sends only the new card, never a clear for the old one,
// so the old one goes here. A card re-sent under the same id (it went quiet, or
// a summary attached) replaces itself where it stands. The cursor stays on the
// hero by id, and moves to the new card if the hero was the one it replaced.
export function upsertCard(card) {
  nameAsk(card);
  var hero = heroAsk();
  var next = [];
  var placed = false;
  for (var i = 0; i < state.asks.length; i++) {
    var a = state.asks[i];
    if (a.id === card.id) {
      next.push(card);
      placed = true;
    } else if (!(isCard(a) && a.sessionId === card.sessionId)) {
      next.push(a);
    }
  }
  if (!placed) next.push(card);
  update(seatedFields(seat(next, hero && hero.id, card.id)));
}

// The id of the card a session has in a list, or null.
function sessionCardId(list, sessionId) {
  for (var i = 0; i < list.length; i++) {
    if (isCard(list[i]) && list[i].sessionId === sessionId) return list[i].id;
  }
  return null;
}

// A card the service re-sent differs from the one held: it went quiet while
// this screen was away, or a summary attached.
function cardChanged(held, sent) {
  var keys = Object.keys(sent).concat(Object.keys(held));
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (JSON.stringify(held[k]) !== JSON.stringify(sent[k])) return true;
  }
  return false;
}

// The daemon's list of what is still waiting, made authoritative. Adding alone
// was not enough: an ask the daemon forgot — because it restarted, or resolved
// one while this screen was disconnected — had nothing left that could ever
// resolve it, so the card sat in the queue forever and answering it could only
// ever fail. Anything the daemon no longer vouches for goes.
//
// Locally expired cards are the exception: they are notices about prompts that
// moved to the terminal, the daemon never lists them, and sweepExpired ages
// them out on its own schedule.
export function reconcileAsks(list) {
  var live = {};
  for (var i = 0; i < list.length; i++) live[list[i].id] = list[i];
  var next = [];
  for (var j = 0; j < state.asks.length; j++) {
    var a = state.asks[j];
    if (!live[a.id] && !a.expired) continue;
    // A card keeps its place but takes the service's word for what it says now:
    // the quiet re-send is the only thing that ends its loudness, and a panel
    // that was away when it came would otherwise pulse forever.
    if (isCard(a) && live[a.id]) {
      var sent = live[a.id];
      if (!sent.sessionName) sent.sessionName = a.sessionName || sessionName(sent.sessionId);
      if (cardChanged(a, sent)) a = sent;
    }
    next.push(a);
  }
  var known = {};
  for (var k = 0; k < next.length; k++) known[next[k].id] = true;
  for (var n = 0; n < list.length; n++) {
    if (known[list[n].id]) continue;
    // An answer held in its undo window is off the list on purpose; the daemon
    // still vouches for it because the decision hasn't been sent yet, and
    // re-adding it here would put the card back while its answer is in flight.
    if (state.undo && state.undo.ask.id === list[n].id) continue;
    var ask = list[n];
    nameAsk(ask);
    next.push(ask);
  }
  var hero = heroAsk();
  // A hero card the service replaced while this screen was away is gone from
  // the list, and its session's new card is where the cursor belongs.
  var seated = seat(next, hero && hero.id, hero && isCard(hero) ? sessionCardId(next, hero.sessionId) : null);
  if (seated.asks.length === state.asks.length) {
    var same = true;
    for (var s = 0; s < seated.asks.length; s++) if (seated.asks[s] !== state.asks[s]) same = false;
    if (same) return seated.asks.length;
  }
  update(seatedFields(seated));
  return seated.asks.length;
}

// A timed-out permission is not answered — it has moved to the terminal. It
// stays on the device saying so, because silently vanishing looks identical to
// somebody else having answered it.
export function expireAsk(id) {
  for (var i = 0; i < state.asks.length; i++) {
    if (state.asks[i].id === id) {
      state.asks[i].expired = true;
      state.asks[i].expiredTs = now();
      update({});
      return true;
    }
  }
  return false;
}

// Expired entries are notices, not work, so they age out on their own.
export function sweepExpired(ttlMs) {
  var cutoff = now() - ttlMs;
  var next = [];
  for (var i = 0; i < state.asks.length; i++) {
    var a = state.asks[i];
    if (a.expired && a.expiredTs < cutoff) continue;
    next.push(a);
  }
  if (next.length !== state.asks.length) {
    // The cursor follows the hero by id, so a notice ageing out ahead of it does
    // not change what it points at. If the hero itself aged out, the next one
    // slides in and an open option list is closed rather than left pointing at
    // a different ask.
    var hero = heroAsk();
    update(seatedFields(seat(next, hero && hero.id, null)));
  }
}

export function resolveAsk(id) {
  var next = [];
  for (var i = 0; i < state.asks.length; i++) {
    if (state.asks[i].id !== id) next.push(state.asks[i]);
  }
  // Cards clear on the Mac's schedule, not the owner's, so what resolves is
  // often not the hero: the cursor follows the hero by id. When the hero itself
  // resolves, the old position (clamped) is the next one sliding in.
  var hero = heroAsk();
  var fields = seatedFields(seat(next, hero && hero.id, null));
  if (state.armed && state.armed.id === id) fields.armed = null;
  update(fields);
}

export function getAsk(id) {
  for (var i = 0; i < state.asks.length; i++) {
    if (state.asks[i].id === id) return state.asks[i];
  }
  return null;
}

export function sessionName(id) {
  for (var i = 0; i < state.sessions.length; i++) {
    var s = state.sessions[i];
    // A session on the NucBox says so wherever its name stands alone (cards).
    if (s.id === id) return s.machine ? s.name + ' · ' + s.machine : s.name;
  }
  var d = state.details[id];
  return d ? d.name : 'session';
}
