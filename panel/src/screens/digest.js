import { esc, topbar, stateLabel, fmtAge } from './helpers.js';
import { now } from '../clock.js';
import { ambientQueue } from '../inbox.js';

// The Digest list (#/digest), the parts of the sessions screen's first card, and the three small pieces
// other screens draw (the session view's strip and card, the clock's line; see the last section).
// Everything here is pure and reads state.digest (the Mac's digest: a Digest of DigestCards) and
// state.digestSel.
//
// The digest arrives over a socket and from persisted state, and its text comes from transcripts, so
// nothing here trusts it: every field is checked for its type before it is read, text is cut to the
// length the Mac keeps it to (a card the Mac built is never changed by that), a card that cannot be
// told apart from the others (no id) is not shown, and every interpolation goes through esc().
// Work is bounded by what is drawn, never by how many cards came.

var ROWS_ABOVE = 3;        // rows kept above the open card, as session-list.js keeps scrollCol
var ROWS_BELOW = 7;        // rows drawn under it: the column is 400px high and clips what is left
var FIRST_ROWS = 3;        // sessions on the sessions screen's first card
var FACT_LINES = 4;        // fact lines on the open card
var TITLE_MAX = 120;       // the Mac cuts a title to 120, a reply to 80 and a fact line to 240
var REPLY_MAX = 120;
var LINE_MAX = 240;
var ID_MAX = 200;          // Claude Code's session ids are UUIDs
var COUNT_MAX = 99999;
var HOURS_MAX = 9999;
var DEFAULT_HOURS = 24;

// The lamp is a class name, so only a state the lamp styles exist for gets through.
var LAMPS = { idle: true, busy: true, attention: true, celebrate: true };

// The first card shown in the column, kept so the open card is never more than ROWS_ABOVE rows
// down it: the dial moves one card at a time and the column follows only when it has to.
var firstRow = 0;

function isObject(v) { return v !== null && typeof v === 'object'; }

// A text field, cut to `max`; anything that is not text is nothing.
function text(v, max) {
  if (typeof v !== 'string') return '';
  return v.length > max ? v.slice(0, max) : v;
}

function count(v) {
  return typeof v === 'number' && isFinite(v) && v > 0 ? Math.min(COUNT_MAX, Math.floor(v)) : 0;
}

function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

function windowHours(digest) {
  var h = isObject(digest) ? digest.windowHours : null;
  if (typeof h !== 'number' || !isFinite(h)) return DEFAULT_HOURS;
  var r = Math.round(h * 10) / 10;
  return r > 0 ? Math.min(HOURS_MAX, r) : DEFAULT_HOURS;
}

// ---- cards ----------------------------------------------------------------------------------------

// The digest's cards in the order it sent them (newest first), the usable ones: an object with a
// text session id of a sane length, one card per session (the first). `limit` stops the walk early.
function collect(state, limit) {
  var digest = isObject(state) ? state.digest : null;
  var list = isObject(digest) && Array.isArray(digest.cards) ? digest.cards : [];
  var seen = Object.create(null);
  var out = [];
  for (var i = 0; i < list.length && out.length < limit; i++) {
    var c = list[i];
    if (!isObject(c)) continue;
    var id = c.sessionId;
    if (typeof id !== 'string' || !id || id.length > ID_MAX || seen['$' + id]) continue;
    seen['$' + id] = true;
    out.push(c);
  }
  return out;
}

export function digestCards(state) { return collect(state, Infinity); }

// A NucBox session's view gets no card: the digest is the Mac's, and the NucBox's ids are not
// namespaced (a demo id can repeat on both machines).
export function findCard(state, sessionId) {
  var details = isObject(state) && isObject(state.details) ? state.details : null;
  var detail = details ? details[sessionId] : null;
  if (isObject(detail) && detail.machine) return null;
  var cards = digestCards(state);
  for (var i = 0; i < cards.length; i++) if (cards[i].sessionId === sessionId) return cards[i];
  return null;
}

// The Mac's own session with this id: the one in the merged list that carries no machine tag.
function macSession(state, id) {
  var list = isObject(state) && Array.isArray(state.sessions) ? state.sessions : [];
  if (typeof id !== 'string') return null;
  for (var i = 0; i < list.length; i++) {
    var s = list[i];
    if (isObject(s) && s.id === id && !s.machine) return s;
  }
  return null;
}

// What a card's lamp and label say. A session the Mac does not have (or only the NucBox does) is
// over as far as the digest can tell; an ended one reads ENDED whatever state it last had.
export function liveOf(state, card) {
  var s = isObject(card) ? macSession(state, card.sessionId) : null;
  if (!s || s.ended === true) return { state: 'idle', ended: true };
  return { state: LAMPS[s.state] === true ? s.state : 'idle', ended: false };
}

export function selectedIndex(cards, selId) {
  if (!Array.isArray(cards) || typeof selId !== 'string') return 0;
  for (var i = 0; i < cards.length; i++) if (isObject(cards[i]) && cards[i].sessionId === selId) return i;
  return 0;
}

// The id the dial lands on: one card per step, stopping at either end, and from the first card
// when the selected id is no longer in the digest.
export function moveSelection(cards, selId, dir) {
  if (!Array.isArray(cards) || !cards.length) return null;
  var step = typeof dir === 'number' && isFinite(dir) ? Math.round(dir) : 0;
  var i = Math.max(0, Math.min(cards.length - 1, selectedIndex(cards, selId) + step));
  return isObject(cards[i]) && typeof cards[i].sessionId === 'string' ? cards[i].sessionId : null;
}

// Press on a card: a live session opens, an ended one only says so.
export function pressTarget(state, sessionId) {
  return liveOf(state, { sessionId: sessionId }).ended ? { toast: 'SESSION ENDED' } : { open: sessionId };
}

function titleOf(card) {
  var t = text(card.title, TITLE_MAX);
  return t.trim() ? t : 'session';
}

function replyOf(card) {
  var t = text(card.lastReply, REPLY_MAX);
  return t.trim() ? t : '';
}

// The card's fact lines: the text ones, at most `max` of them.
function linesOf(card, max) {
  var out = [];
  var l = card.lines;
  if (!Array.isArray(l)) return out;
  for (var i = 0; i < l.length && out.length < max; i++) {
    if (typeof l[i] === 'string' && l[i].trim()) out.push(text(l[i], LINE_MAX));
  }
  return out;
}

// A card whose time is missing or not a number has no age to show.
function ageOf(card) {
  var ts = card.lastTurnTs;
  return typeof ts === 'number' && isFinite(ts) && ts > 0 ? fmtAge(now() - ts) : '';
}

// ---- the first card -------------------------------------------------------------------------------

export function digestFleetLine(digest) {
  var t = isObject(digest) && isObject(digest.totals) ? digest.totals : {};
  var line = 'LAST ' + windowHours(digest) + 'H · ' + plural(count(t.sessions), 'SESSION', 'SESSIONS') +
    ' · ' + plural(count(t.turns), 'TURN', 'TURNS');
  var commits = count(t.commits);
  var prs = count(t.prs);
  if (commits) line += ' · ' + plural(commits, 'COMMIT', 'COMMITS');
  if (prs) line += ' · ' + plural(prs, 'PR', 'PRS');
  return line;
}

export function hasFleetCard(state) { return collect(state, 1).length > 0; }

// The newest sessions, as the sessions screen's first card lists them. `text` is the last reply
// quoted, else the first fact line (a model headline in later plans), else nothing.
export function fleetCardRows(state) {
  var cards = collect(state, FIRST_ROWS);
  var rows = [];
  for (var i = 0; i < cards.length; i++) {
    var c = cards[i];
    var reply = replyOf(c);
    rows.push({
      id: c.sessionId,
      lamp: liveOf(state, c).state,
      title: titleOf(c),
      text: reply ? '"' + reply + '"' : (linesOf(c, 1)[0] || ''),
      age: ageOf(c),
    });
  }
  return rows;
}

// One tap target: the whole card opens the list. No NEW tags, and showing it is not a visit.
export function renderFleetCard(state, selected) {
  if (!hasFleetCard(state)) return '';
  var rows = fleetCardRows(state);
  var html = '<div class="dgfirst' + (selected ? ' selected' : '') + '" data-action="digest-card">' +
    '<div class="dgfhead">DIGEST</div>' +
    '<div class="dgffleet">' + esc(digestFleetLine(state.digest)) + '</div>';
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    html += '<div class="dgfrow"><div class="dgfrtop"><span class="lamp ' + esc(r.lamp) + '"></span>' +
      '<span class="dgftitle">' + esc(r.title) + '</span>' +
      '<span class="dgfage">' + esc(r.age) + '</span></div>' +
      '<div class="dgftext">' + esc(r.text) + '</div></div>';
  }
  return html + '<div class="dghint">PRESS TO OPEN</div></div>';
}

// ---- the list -------------------------------------------------------------------------------------

function tags(card, seen) {
  var out = '';
  if (typeof card.lastTurnTs === 'number' && card.lastTurnTs > seen) out += '<span class="dgtag">NEW</span>';
  if (card.summary == null) out += '<span class="dgtag">FACTS</span>';
  return out;
}

function head(card, live, seen) {
  return '<div class="dghead"><span class="lamp ' + esc(live.state) + '"></span>' +
    '<span class="dgstate">' + stateLabel(live.state, live.ended) + '</span>' +
    '<span class="dgtitle">' + esc(titleOf(card)) + '</span>' + tags(card, seen) +
    '<span class="dgage">' + esc(ageOf(card)) + '</span></div>';
}

function quoted(reply) {
  return '<span class="dgrlabel">LAST REPLY</span> &quot;' + esc(reply) + '&quot;';
}

function openCard(card, live, seen) {
  var reply = replyOf(card);
  var lines = linesOf(card, FACT_LINES);
  var html = '<div class="dgcard' + (live.state === 'idle' ? ' idle' : '') +
    '" data-action="digest-row" data-id="' + esc(card.sessionId) + '">' + head(card, live, seen);
  if (reply) html += '<div class="dgreply">' + quoted(reply) + '</div>';
  for (var i = 0; i < lines.length; i++) html += '<div class="dgline">' + esc(lines[i]) + '</div>';
  if (!live.ended) html += '<div class="dghint">PRESS TO OPEN</div>';
  return html + '</div>';
}

function row(card, live, seen) {
  var reply = replyOf(card);
  return '<div class="dgrow" data-action="digest-row" data-id="' + esc(card.sessionId) + '">' +
    head(card, live, seen) +
    '<div class="dgsub">' + (reply ? quoted(reply) : esc(linesOf(card, 1)[0] || '')) + '</div></div>';
}

// seenTs is when the owner last looked at this screen (Task 12's digestSeen): a card is NEW when its
// last turn is later. A fresh panel has seenTs 0 (digest-seen.test.js pins it), so every card is NEW until the
// first 5 s visit; only a caller that passes no number at all gets no NEW tags.
export function renderDigest(state, seenTs) {
  var connected = isObject(state) ? state.daemonConnected : false;
  var digest = isObject(state) && isObject(state.digest) ? state.digest : null;
  if (!digest) {
    firstRow = 0;
    return '<div class="screen digest">' + topbar('DIGEST', connected) +
      '<div class="empty">READING DIGEST…</div></div>';
  }

  var cards = digestCards(state);
  if (!cards.length) {
    firstRow = 0;
    return '<div class="screen digest">' + topbar('DIGEST', connected) +
      '<div class="empty">NOTHING DONE IN THE LAST ' + esc(windowHours(digest)) + 'H</div></div>';
  }

  var selected = selectedIndex(cards, state.digestSel);
  if (selected < firstRow) firstRow = selected;
  if (selected - firstRow > ROWS_ABOVE) firstRow = selected - ROWS_ABOVE;
  var seen = typeof seenTs === 'number' && seenTs === seenTs ? seenTs : Infinity;
  var last = Math.min(cards.length, selected + 1 + ROWS_BELOW);

  var column = '';
  for (var i = firstRow; i < last; i++) {
    var live = liveOf(state, cards[i]);
    column += i === selected ? openCard(cards[i], live, seen) : row(cards[i], live, seen);
  }

  // Facts only for now; later plans say OK, OFFLINE and the rest here.
  return '<div class="screen digest">' +
    topbar('DIGEST', connected, String(cards.length)) +
    '<div class="dgstrip"><span class="dgfleet">' + esc(digestFleetLine(digest)) + '</span>' +
    '<span class="dgsrc">FACTS ONLY</span></div>' +
    '<div class="dgcol">' + column + '</div></div>';
}

// ---- the session view and the clock ---------------------------------------------------------------
// Three quiet pieces of the same facts, drawn by other screens: a one-line strip under the session
// view's top bar, a fuller card after its newest message, and one line on the resting clock. None is
// tappable, none moves, and each is '' (nothing drawn, nothing shifted) when there is nothing to say.
// All three are the Mac's: findCard gives a NucBox session's view no card, so it gets none of them.

var AMBIENT_MAX = 64;                 // characters of the clock's line, then an ellipsis
var AMBIENT_FRESH_MS = 12 * 3600e3;   // the clock says nothing when the newest card is this old

// The strip's lamp: the view's own detail when it knows (an ended one is idle whatever it last said),
// else the Mac's live session, as the list shows it. Only a state the lamp styles exist for gets through.
function stripLamp(state, id, card) {
  var d = isObject(state) && isObject(state.details) ? state.details[id] : null;
  if (isObject(d)) {
    if (d.ended === true) return 'idle';
    if (LAMPS[d.state] === true) return d.state;
  }
  return liveOf(state, card).state;
}

// The last reply, quoted, with its age. Without a reply there is nothing to put in it (a summary's
// headline joins it in later plans), so no strip.
export function sessionStrip(state, id) {
  var card = findCard(state, id);
  if (!card) return '';
  var reply = replyOf(card);
  if (!reply) return '';
  var age = ageOf(card);
  return '<div class="dstrip"><span class="lamp ' + esc(stripLamp(state, id, card)) + '"></span>' +
    '<span class="dstext">&quot;' + esc(reply) + '&quot;</span>' +
    (age ? '<span class="dsage">' + esc(age) + '</span>' : '') + '</div>';
}

// The facts the digest's open card shows (the reply line, then up to FACT_LINES fact lines) under a
// FACTS heading with the age. A card with neither has nothing to put under the heading, so no card.
export function sessionCard(state, id) {
  var card = findCard(state, id);
  if (!card) return '';
  var reply = replyOf(card);
  var lines = linesOf(card, FACT_LINES);
  if (!reply && !lines.length) return '';
  var age = ageOf(card);
  var html = '<div class="dcard"><div class="dchead">FACTS' + (age ? ' · ' + esc(age) : '') + '</div>';
  if (reply) html += '<div class="dgreply">' + quoted(reply) + '</div>';
  for (var i = 0; i < lines.length; i++) html += '<div class="dgline">' + esc(lines[i]) + '</div>';
  return html + '</div>';
}

// The first `max` characters of a line, and an ellipsis when anything was cut; a surrogate pair is
// never split.
function cutLine(s, max) {
  if (s.length <= max) return s;
  var n = max;
  var c = s.charCodeAt(n - 1);
  if (c >= 0xD800 && c <= 0xDBFF) n--;
  return s.slice(0, n) + '…';
}

// <age> · <title> — "<last reply>" for the newest card, cut to AMBIENT_MAX characters before it is
// escaped. Nothing while anything waits (the clock screen gives "N NEED YOU" or "N WAITING" the room),
// with no card, or when the card is old or has no time (an age that cannot be told is not a recent one).
// "Waiting" is what the clock's own head counts (inbox.js ambientQueue): a lone UPDATE card or an
// expired notice is no wait, so the line stays beside them; the queue keeps an UPDATE card per session
// until it is cleared, so counting those would hide the line almost always. Anything else with a
// length still counts as something waiting.
export function ambientLine(state) {
  var asks = isObject(state) ? state.asks : null;
  if (asks && asks.length && (!Array.isArray(asks) || ambientQueue(asks.filter(isObject)).count)) return '';
  var card = collect(state, 1)[0];
  if (!card) return '';
  var age = ageOf(card);
  if (!age || now() - card.lastTurnTs >= AMBIENT_FRESH_MS) return '';
  var line = age + ' · ' + titleOf(card);
  var reply = replyOf(card);
  if (reply) line += ' — "' + reply + '"';
  return '<div class="adigest">' + esc(cutLine(line, AMBIENT_MAX)) + '</div>';
}
