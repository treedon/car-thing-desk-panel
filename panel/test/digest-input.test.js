// The Digest list's input and its selection, decided outside main.js: what the dial, a press and a
// tap do on #/digest, and what a digest that just arrived does to the selection. The selection is a
// session id; every index is into digestCards(state), the filtered list the screen draws.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withDigest, digestDial, digestPress, digestTap } from '../src/digest-input.js';

const card = (id) => ({ sessionId: id, title: 'T ' + id, lastTurnTs: 1 });
const dg = (...ids) => ({ windowHours: 24, cards: ids.map(card) });
const st = (digest, sel) => ({ sessions: [], details: {}, digest, digestSel: sel === undefined ? null : sel });
// A digest whose raw list holds junk around the usable cards a, a (again) and b: digestCards draws
// [a, b], so an index into the raw list points somewhere else.
const junky = () => ({ windowHours: 24, cards: [null, 'junk', { title: 'no id' }, card('a'), card('a'), card('b')] });

test('a new digest keeps the selection on its session while that card is still drawn', () => {
  const next = dg('c', 'b');
  assert.deepEqual(withDigest(st(dg('a', 'b', 'c'), 'b'), next), { digest: next, digestSel: 'b' });
});

test('a selection that left the digest falls back to the first card, and to null with none', () => {
  const next = dg('c', 'a');
  assert.deepEqual(withDigest(st(dg('a', 'b'), 'b'), next), { digest: next, digestSel: 'c' });
  const empty = dg();
  assert.deepEqual(withDigest(st(dg('a'), 'a'), empty), { digest: empty, digestSel: null });
  assert.deepEqual(withDigest(st(null, null), dg('x', 'y')).digestSel, 'x', 'nothing selected yet: the first card');
});

test('the selection is checked against the drawn cards, not the raw list', () => {
  const d = junky();
  assert.equal(withDigest(st(null, 'b'), d).digestSel, 'b');
  const long = 'x'.repeat(201);
  const withLong = { cards: [{ sessionId: long }, card('a')] };
  assert.equal(withDigest(st(null, long), withLong).digestSel, 'a', 'an id the screen does not draw is not kept');
});

test('a missing, null or wrong-typed digest is stored as null and never throws', () => {
  for (const d of [null, undefined, 'junk', 42, true]) {
    assert.deepEqual(withDigest(st(dg('a'), 'a'), d), { digest: null, digestSel: null }, String(d));
  }
  const noCards = { windowHours: 24, cards: null };
  assert.deepEqual(withDigest(st(dg('a'), 'a'), noCards), { digest: noCards, digestSel: null });
  for (const s of [null, undefined, {}, { digestSel: 42 }, 'junk']) {
    const d = dg('a', 'b');
    assert.deepEqual(withDigest(s, d), { digest: d, digestSel: 'a' }, String(JSON.stringify(s)));
  }
});

test('the dial moves one card at a time and stops at either end', () => {
  const s = (sel) => st(dg('a', 'b', 'c'), sel);
  assert.deepEqual(digestDial(s('a'), 1), { digestSel: 'b' });
  assert.deepEqual(digestDial(s('b'), -1), { digestSel: 'a' });
  assert.deepEqual(digestDial(s('c'), 1), { digestSel: 'c' });
  assert.deepEqual(digestDial(s('a'), -1), { digestSel: 'a' });
  assert.deepEqual(digestDial(s(null), 1), { digestSel: 'b' }, 'nothing selected is the first card');
  assert.deepEqual(digestDial(s('gone'), 1), { digestSel: 'b' }, 'a vanished id is the first card');
});

test('the dial walks the drawn cards: junk and a repeated session are not stops', () => {
  assert.deepEqual(digestDial(st(junky(), 'a'), 1), { digestSel: 'b' });
  assert.deepEqual(digestDial(st(junky(), 'b'), -1), { digestSel: 'a' });
});

test('the dial with no digest, no cards or an empty state selects nothing and never throws', () => {
  for (const s of [st(null), st(dg()), st({ cards: null }), null, undefined, {}]) {
    assert.deepEqual(digestDial(s, 1), { digestSel: null });
  }
});

test('a press is on the selected card; nothing selected, or a vanished id, is the first card', () => {
  assert.equal(digestPress(st(dg('a', 'b', 'c'), 'b')), 'b');
  assert.equal(digestPress(st(dg('a', 'b'), null)), 'a');
  assert.equal(digestPress(st(dg('a', 'b'), 'gone')), 'a');
  assert.equal(digestPress(st(junky(), null)), 'a', 'the first drawn card, not the raw list\'s null');
  assert.equal(digestPress(st(junky(), 'b')), 'b');
});

test('a press with nothing to press is null', () => {
  for (const s of [st(null), st(dg()), st({ cards: 'x' }), null, undefined, {}]) assert.equal(digestPress(s), null);
});

test('a tap on another row selects it; a tap on the selected card presses it', () => {
  const s = st(dg('a', 'b', 'c'), 'b');
  assert.deepEqual(digestTap(s, 'c'), { select: 'c' });
  assert.deepEqual(digestTap(s, 'b'), { press: 'b' });
  assert.deepEqual(digestTap(st(dg('a', 'b'), null), 'a'), { press: 'a' }, 'nothing selected: the first card is the open one');
  assert.deepEqual(digestTap(st(dg('a', 'b'), 'gone'), 'b'), { select: 'b' });
  assert.deepEqual(digestTap(st(junky(), null), 'b'), { select: 'b' });
  assert.deepEqual(digestTap(st(junky(), null), 'a'), { press: 'a' });
});

test('a tap on a card the digest no longer has, or with no id, does nothing', () => {
  assert.equal(digestTap(st(dg('a', 'b'), 'a'), 'z'), null);
  assert.equal(digestTap(st(dg('a', 'b'), 'a'), null), null);
  assert.equal(digestTap(st(dg('a', 'b'), 'a'), 42), null);
  for (const s of [st(null), st(dg()), null, undefined, {}]) assert.equal(digestTap(s, 'a'), null);
});
