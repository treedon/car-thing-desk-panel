// What is waiting on the owner, and in what order. state.asks holds everything:
// permissions, questions and plans (kinds permission/question/prompt) and the
// inbox's cards (kind card, one per session — its latest finished turn).
//
// Pure functions over a list of asks; store.js owns where the list lives.

export function isCard(a) {
  return !!a && a.kind === 'card';
}

// Whether an item should pull the owner: drive the edge pulse, wake and hold
// the screen, count as "an ask waiting". Cards go quiet on their own; the Mac
// service owns that flag, so the panel never compares its clock with the Mac's.
// An expired ask is a notice about a prompt that moved to the terminal.
export function isLoud(a) {
  return !a.expired && (a.kind !== 'card' || !!a.loud);
}

export function loudCount(asks) {
  var n = 0;
  for (var i = 0; i < asks.length; i++) if (isLoud(asks[i])) n++;
  return n;
}

function isUpdate(a) {
  return isCard(a) && a.tag === 'update';
}

// Chrome 69's sort is not stable above ten elements, and ties here (two cards
// stopped in the same millisecond, a long run of permissions) must keep the
// order they arrived in. So the sort is decorated with the position.
function stableSorted(list, before) {
  var tagged = [];
  for (var i = 0; i < list.length; i++) tagged.push({ a: list[i], i: i });
  tagged.sort(function (x, y) {
    if (before(x.a, y.a)) return -1;
    if (before(y.a, x.a)) return 1;
    return x.i - y.i;
  });
  var out = [];
  for (var j = 0; j < tagged.length; j++) out.push(tagged[j].a);
  return out;
}

// A new array. Blocking items first, exactly as they were (permissions,
// questions, plans keep their relative order); then ASKING and ERROR cards,
// oldest first, because the longest-waiting one has waited longest; then
// UPDATE cards, newest first, because the freshest is the one worth a look.
export function orderQueue(asks) {
  var blocking = [];
  var needy = [];
  var updates = [];
  for (var i = 0; i < asks.length; i++) {
    var a = asks[i];
    if (!isCard(a)) blocking.push(a);
    else if (isUpdate(a)) updates.push(a);
    else needy.push(a);
  }
  needy = stableSorted(needy, function (x, y) { return x.createdTs < y.createdTs; });
  updates = stableSorted(updates, function (x, y) { return x.createdTs > y.createdTs; });
  return blocking.concat(needy, updates);
}

// The footer's two numbers: what is waiting on the owner (everything but the
// updates) and how many updates sit behind it. An expired ask is a notice that
// the prompt moved to the terminal — it waits on the terminal, not on the
// owner, which is also why isLoud leaves it out.
export function queueCounts(asks) {
  var waiting = 0;
  var updates = 0;
  for (var i = 0; i < asks.length; i++) {
    if (isUpdate(asks[i])) updates++;
    else if (!asks[i].expired) waiting++;
  }
  return { waiting: waiting, updates: updates };
}

// What the resting screen says. The number is what waits on the owner
// (queueCounts' waiting: everything but UPDATE cards and expired notices); the
// alarm is only for what is loud. A quiet ASKING card is still waiting, so it
// is counted, but it must not light the clock up amber and breathing: that
// treatment is for something that needs the owner now.
export function ambientQueue(asks) {
  return { count: queueCounts(asks).waiting, alarmed: loudCount(asks) > 0 };
}

// The permissions, questions and plans among the asks: the ones the permission
// screen's "N / M" is a position in. Cards sit behind them in the queue and are
// not part of that count.
export function blockingCount(asks) {
  var n = 0;
  for (var i = 0; i < asks.length; i++) if (!isCard(asks[i])) n++;
  return n;
}

// Whether a reply sent from a card reached its session. These are the three
// deliveries after which the Mac service clears the card itself; any other
// (cannot-wake, unknown-session, answer-on-panel) went nowhere, so the card
// stays and the owner is told why rather than "SENT".
export function replySent(delivery) {
  return delivery === 'wake' || delivery === 'next-tool' || delivery === 'answer';
}

// ---- the dial on a card ---------------------------------------------------------
// A card's buttons, in the order the dial walks them. The dial press does the
// highlighted one; hold top (REPLY) and preset 3 (CLEAR) stay as shortcuts.
export var CARD_CHIPS = ['switch', 'reply', 'clear'];

// The highlighted button of a card hero. The pick is kept as {id, chip}, so it
// belongs to one card: any other card, however the cursor got there, starts on
// SWITCH.
export function cardChipOf(sel, card) {
  return sel && card && sel.id === card.id ? sel.chip : 0;
}

// A dial turn on the queue (not inside a question's options): on a card it
// walks the card's buttons, and past the last (or before the first) it moves to
// the next (or previous) ask, landing on a card's first button going forward
// and its last going back, so the queue reads as one list. Anything else moves
// between asks as before. At either end of the list it stays put.
export function queueDialStep(asks, queueIndex, sel, dir) {
  var n = asks.length;
  if (!n) return { queueIndex: 0, sel: null };
  var i = Math.max(0, Math.min(n - 1, queueIndex));
  var hero = asks[i];
  if (isCard(hero)) {
    var next = cardChipOf(sel, hero) + dir;
    if (next >= 0 && next < CARD_CHIPS.length) return { queueIndex: i, sel: { id: hero.id, chip: next } };
  }
  var j = Math.max(0, Math.min(n - 1, i + dir));
  if (j === i) return { queueIndex: i, sel: sel };
  var to = asks[j];
  if (!isCard(to)) return { queueIndex: j, sel: null };
  return { queueIndex: j, sel: { id: to.id, chip: dir < 0 ? CARD_CHIPS.length - 1 : 0 } };
}
