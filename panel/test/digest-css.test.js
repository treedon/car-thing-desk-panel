// The Digest's styles are checked as text: sizes, the rules the type floor and the no-alert-noise
// rules depend on, and that every class the renderers emit has a rule. Whether it looks right is
// still a job for the emulator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderDigest, renderFleetCard, sessionStrip, sessionCard, ambientLine } from '../src/screens/digest.js';
import { renderList } from '../src/screens/session-list.js';
import { listState } from './fixtures/list-state.js';
import { now } from '../src/clock.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const css = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8');

// Every flat rule of the sheet, comments gone: [{ selectors: ['.a', '.b .c'], body: 'prop: v; ...' }].
// (An @keyframes step or an @font-face block comes out as a rule too; none has a digest selector.)
function rulesOf(text) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  const bare = text.replace(/\/\*[\s\S]*?\*\//g, '');
  for (let m = re.exec(bare); m; m = re.exec(bare)) out.push({ selectors: m[1].split(',').map((s) => s.trim()), body: m[2] });
  return out;
}
// The digest's own classes: .dg* (the list and the first card), .dstrip .dstext .dsage (the session strip), .dcard .dchead (the
// session card), .adigest (the clock's line) and .digest (the list's screen). Not .dctx*, the context meter's.
const isDigestSelector = (sel) => /\.(dg|dstrip|dstext|dsage|dcard|dchead|adigest|digest\b)/.test(sel);
const digestRuleList = (text) => rulesOf(text).filter((r) => r.selectors.some(isDigestSelector));

// The text of every rule whose selector names one of the digest's classes (see isDigestSelector).
function digestRules(text) { return digestRuleList(text).map((r) => r.selectors.join(', ') + ' {' + r.body + '}').join('\n'); }

// [selector, px] for each font-size in those rules.
function digestFontSizes(text) {
  const out = [];
  for (const r of digestRuleList(text)) for (const m of r.body.matchAll(/font-size:\s*([\d.]+)px/g)) out.push([r.selectors.join(', '), Number(m[1])]);
  return out;
}

// The last value `prop` is given for exactly `sel` (a rule's selector list holds it), else undefined.
function declOf(text, sel, prop) {
  let value;
  for (const r of rulesOf(text)) {
    if (!r.selectors.includes(sel)) continue;
    for (const m of r.body.matchAll(/([a-z-]+)\s*:\s*([^;]+)/g)) if (m[1] === prop) value = m[2].trim();
  }
  return value;
}
// Everything declared for exactly `sel`, as { prop: value } (several rules for it are merged, the last wins).
function declsOf(text, sel) {
  const out = {};
  for (const r of rulesOf(text)) if (r.selectors.includes(sel)) Object.assign(out, parseDecls(r.body));
  return out;
}
function parseDecls(body) {
  const out = {};
  for (const m of body.matchAll(/([a-z-]+)\s*:\s*([^;]+)/g)) out[m[1]] = m[2].trim();
  return out;
}
const fontSizeOf = (text, sel) => { const v = declOf(text, sel, 'font-size'); return v === undefined ? undefined : parseFloat(v); };
const px = (v) => parseFloat(v);

// '.dgrow .dgtitle' is what names a session in a closed row, so it is glance text like the open card's title.
// '.dstext' is the session strip's reply and '.adigest' the clock's line; the session card's reply and fact lines are '.dgreply' and '.dgline'.
// '.dgnote' is the sessions screen's NO SESSIONS words beside the card standing alone.
const GLANCE = ['.dgtitle', '.dgrow .dgtitle', '.dgreply', '.dgline', '.dgsub', '.dgftitle', '.dgftext', '.dstext', '.adigest', '.dgnote'];
const MONO = /JetBrains Mono/;

test('the digest section is there, after the lamps it quiets', () => {
  assert.ok(css.includes('/* ---- digest ---- */'));
  assert.ok(css.indexOf('/* ---- digest ---- */') > css.indexOf('.lamp.attention'));
  assert.ok(digestRuleList(css).length >= 30, 'the section has its rules');
});

test('digest type is never under 14px, and glance text never under 19px', () => {
  for (const [sel, size] of digestFontSizes(css)) assert.ok(size >= 14, sel + ' is ' + size);
  for (const sel of GLANCE) assert.ok(fontSizeOf(css, sel) >= 19, sel + ' is ' + fontSizeOf(css, sel));
  // Every size in a digest rule is in px, so the floor above sees all of them.
  for (const m of digestRules(css).matchAll(/font-size:\s*([^;}]+)/g)) assert.match(m[1].trim(), /^[\d.]+px$/, m[0]);
});

test('the sizes are the design\'s, and a lowered one fails here', () => {
  const sizes = {
    '.dgstrip': 16, '.dgstate': 17, '.dgtitle': 22, '.dgtag': 14, '.dgage': 16, '.dghint': 16, '.dgreply': 22, '.dgline': 20,
    '.dgrow .dgstate': 15, '.dgrow .dgtitle': 19, '.dgsub': 19,
    '.dgfhead': 17, '.dgffleet': 16, '.dgftitle': 19, '.dgfage': 16, '.dgftext': 19,
    '.dstext': 20, '.dsage': 16, '.dchead': 16, '.adigest': 20,
    '.dgnote': 22,
  };
  for (const sel of Object.keys(sizes)) assert.equal(fontSizeOf(css, sel), sizes[sel], sel);
  assert.deepEqual([declOf(css, '.dgstate', 'font-weight'), declOf(css, '.dgtitle', 'font-weight'), declOf(css, '.dgreply', 'font-weight'),
    declOf(css, '.dgline', 'font-weight'), declOf(css, '.dgfhead', 'font-weight'), declOf(css, '.dgftitle', 'font-weight'), declOf(css, '.dgftext', 'font-weight')],
  ['700', '700', '700', '500', '700', '700', '500']);
  assert.deepEqual([declOf(css, '.dstext', 'font-weight'), declOf(css, '.dchead', 'font-weight'), declOf(css, '.adigest', 'font-weight')], ['500', '700', '500']);
});

test('the list: strip, lamps, rows, the open card', () => {
  assert.equal(declOf(css, '.dgstrip', 'height'), '34px');
  assert.equal(declOf(css, '.dgstrip', 'color'), 'var(--muted)');
  assert.match(declOf(css, '.dgstrip', 'font-family'), MONO);
  assert.equal(declOf(css, '.dgfleet', 'flex'), '1');
  assert.deepEqual([declOf(css, '.dgcard .lamp', 'width'), declOf(css, '.dgcard .lamp', 'height')], ['18px', '18px']);
  assert.deepEqual([declOf(css, '.dgrow .lamp', 'width'), declOf(css, '.dgrow .lamp', 'height')], ['14px', '14px']);
  assert.equal(declOf(css, '.dgrow', 'height'), '58px');
  assert.equal(declOf(css, '.dgcard', 'background'), 'var(--panel-hi)');
  assert.equal(declOf(css, '.dgstate', 'color'), 'var(--text-2)');
  assert.equal(declOf(css, '.dgtitle', 'color'), 'var(--text-2)');
  assert.equal(declOf(css, '.dgrow .dgtitle', 'color'), 'var(--text-2)');
  assert.equal(declOf(css, '.dgcard.idle .dgtitle', 'color'), 'var(--muted)');
  assert.equal(declOf(css, '.dgreply', 'color'), 'var(--text-2)');
  assert.equal(declOf(css, '.dgline', 'color'), 'var(--text-3)');
  assert.equal(declOf(css, '.dgsub', 'color'), 'var(--text-2)');
  assert.equal(declOf(css, '.dgtag', 'border'), '1px solid var(--rule)');
  assert.equal(declOf(css, '.dgtag', 'color'), 'var(--text-2)');
  for (const sel of ['.dgage', '.dghint']) {
    assert.match(declOf(css, sel, 'font-family'), MONO, sel);
    assert.equal(declOf(css, sel, 'color'), 'var(--muted)', sel);
  }
});

// What lays the list out and clips it. Each of these, taken out, leaves the other tests green and the screen wrong:
// the column spilling past the bezel, a row growing past its 58px, a head that stacks, a title that does not give way,
// the open card with no marker, a tag with no padding.
test('the list: what clips the column, lines up a head, and marks the open card', () => {
  const is = (sel, want) => assert.deepEqual(Object.fromEntries(Object.keys(want).map((k) => [k, declOf(css, sel, k)])), want, sel);
  is('.dgstrip', { display: 'flex', 'align-items': 'center', padding: '0 16px', 'flex-shrink': '0', 'border-bottom': '1px solid var(--rule)' });
  is('.dgfleet', { flex: '1', 'min-width': '0', 'white-space': 'nowrap', overflow: 'hidden', 'text-overflow': 'ellipsis' });
  is('.dgsrc', { 'flex-shrink': '0', 'margin-left': '12px', 'letter-spacing': '0.14em' });
  is('.dgcol', { flex: '1', 'min-height': '0', overflow: 'hidden' });
  is('.dgrow', { height: '58px', padding: '6px 16px 0 16px', overflow: 'hidden', 'border-bottom': '1px solid var(--rule)' });
  is('.dgcard', { padding: '6px 16px 6px 16px', 'border-bottom': '1px solid var(--rule)', background: 'var(--panel-hi)', 'box-shadow': 'inset 4px 0 0 var(--accent)' });
  is('.dghead', { display: 'flex', 'align-items': 'center' });
  is('.dgcard .dghead', { height: '28px' });
  is('.dgrow .dghead', { height: '24px' });
  is('.dgcard .lamp', { width: '18px', height: '18px', 'margin-right': '12px' });
  is('.dgrow .lamp', { width: '14px', height: '14px', 'margin-right': '10px' });
  is('.dgstate', { 'flex-shrink': '0', 'margin-right': '14px', 'letter-spacing': '0.16em' });
  is('.dgtitle', { flex: '1', 'min-width': '0', overflow: 'hidden', 'white-space': 'nowrap', 'text-overflow': 'ellipsis' });
  is('.dgtag', { 'flex-shrink': '0', 'margin-left': '10px', padding: '0 6px', border: '1px solid var(--rule)', 'border-radius': '4px', 'line-height': '18px', 'letter-spacing': '0.14em', 'text-transform': 'uppercase' });
  is('.dgage', { 'flex-shrink': '0', 'margin-left': '12px' });
  is('.dgcard .dghint', { 'margin-top': '2px', 'line-height': '20px', 'text-align': 'right' });
  is('.dgreply', { 'margin-top': '2px', 'line-height': '26px' });
  is('.dgline', { 'margin-top': '2px', 'line-height': '24px' });
  is('.dgsub', { 'margin-top': '3px', 'line-height': '24px' });
  // The label is 14px on a line of 26px (reply) or 24px (row): at line-height 1 it cannot make that line taller.
  is('.dgrlabel', { 'margin-right': '4px', 'font-weight': '700', 'line-height': '1', 'letter-spacing': '0.14em', color: 'var(--muted)' });
});

test('the reply keeps to two lines, a fact line and a row line keep to one', () => {
  assert.equal(declOf(css, '.dgreply', '-webkit-line-clamp'), '2');
  assert.equal(declOf(css, '.dgreply', 'display'), '-webkit-box');
  assert.equal(declOf(css, '.dgreply', '-webkit-box-orient'), 'vertical');
  assert.equal(declOf(css, '.dgreply', 'overflow'), 'hidden');
  for (const sel of ['.dgline', '.dgsub', '.dgftitle', '.dgtitle']) {
    assert.equal(declOf(css, sel, 'white-space'), 'nowrap', sel);
    assert.equal(declOf(css, sel, 'text-overflow'), 'ellipsis', sel);
    assert.equal(declOf(css, sel, 'overflow'), 'hidden', sel);
  }
});

test('the first card is drawn as a tile and has no size of its own', () => {
  assert.deepEqual([declOf(css, '.dgfirst', 'display'), declOf(css, '.dgfirst', 'flex-direction')], ['flex', 'column']);
  assert.equal(declOf(css, '.dgfirst', 'padding'), '15px 18px 14px 18px');
  assert.equal(declOf(css, '.dgfirst', 'border-radius'), '10px');
  assert.equal(declOf(css, '.dgfirst', 'background'), 'var(--panel)');
  assert.equal(declOf(css, '.dgfirst', 'line-height'), '1.25');
  for (const prop of ['width', 'height', 'min-width', 'min-height', 'max-width', 'max-height', 'flex']) assert.equal(declOf(css, '.dgfirst', prop), undefined, prop);
  assert.equal(declOf(css, '.dgfirst.selected', 'background'), 'var(--panel-hi)');
  assert.equal(declOf(css, '.dgfirst.selected', 'box-shadow'), '0 0 0 2px var(--accent)');
  assert.equal(declOf(css, '.dgfhead', 'color'), 'var(--text-2)');
  assert.match(declOf(css, '.dgffleet', 'font-family'), MONO);
  assert.equal(declOf(css, '.dgffleet', 'color'), 'var(--muted)');
  assert.equal(declOf(css, '.dgffleet', 'margin-top'), '6px');
  assert.equal(declOf(css, '.dgfrow', 'margin-top'), '14px');
  assert.equal(declOf(css, '.dgfrtop', 'display'), 'flex');
  assert.deepEqual([declOf(css, '.dgfirst .lamp', 'width'), declOf(css, '.dgfirst .lamp', 'height'), declOf(css, '.dgfirst .lamp', 'margin-right')], ['14px', '14px', '10px']);
  assert.equal(declOf(css, '.dgftitle', 'flex'), '1');
  assert.equal(declOf(css, '.dgftitle', 'color'), 'var(--text-2)');
  assert.equal(declOf(css, '.dgfage', 'margin-left'), '10px');
  assert.match(declOf(css, '.dgfage', 'font-family'), MONO);
  assert.equal(declOf(css, '.dgfage', 'color'), 'var(--muted)');
  assert.equal(declOf(css, '.dgftext', 'margin-top'), '4px');
  assert.equal(declOf(css, '.dgftext', 'color'), 'var(--text-3)');
  assert.equal(declOf(css, '.dgftext', '-webkit-line-clamp'), '2');
  assert.equal(declOf(css, '.dgftext', 'display'), '-webkit-box');
  assert.equal(declOf(css, '.dgftext', '-webkit-box-orient'), 'vertical');
  assert.equal(declOf(css, '.dgfirst .dghint', 'margin-top'), 'auto');
  assert.equal(declOf(css, '.dgfirst .dghint', 'text-align'), 'right');
  // What clips the tile and lines up its rows.
  assert.equal(declOf(css, '.dgfirst', 'overflow'), 'hidden');
  assert.equal(declOf(css, '.dgfrtop', 'align-items'), 'center');
  assert.deepEqual([declOf(css, '.dgftitle', 'min-width'), declOf(css, '.dgftitle', 'overflow'), declOf(css, '.dgftitle', 'white-space'), declOf(css, '.dgftitle', 'text-overflow')], ['0', 'hidden', 'nowrap', 'ellipsis']);
  assert.equal(declOf(css, '.dgfage', 'flex-shrink'), '0');
  assert.equal(declOf(css, '.dgftext', 'overflow'), 'hidden');
  assert.deepEqual([declOf(css, '.dgfhead', 'letter-spacing'), declOf(css, '.dgfhead', 'text-transform')], ['0.16em', 'uppercase']);
});

test('the open card and three rows above it fit the column; the first card fits its tile', () => {
  const column = 480 - px(declOf(css, '.topbar', 'height')) - px(declOf(css, '.dgstrip', 'height'));
  // The height of the line a label sits on: the taller of the line and the label's own box (a unitless line-height is times its font).
  const labelBox = (() => { const v = declOf(css, '.dgrlabel', 'line-height'); return /px$/.test(v) ? px(v) : px(v) * fontSizeOf(css, '.dgrlabel'); })();
  assert.ok(isFinite(labelBox), '.dgrlabel needs a line-height of its own: inherited, a 14px label grows the line it sits on');
  const lineWith = (sel) => Math.max(px(declOf(css, sel, 'line-height')), labelBox);
  const pad = declOf(css, '.dgcard', 'padding').split(/\s+/).map(px);
  // The worst case: a two-line reply (the label is on its first line), four fact lines, the hint.
  const card = pad[0] + pad[2] + px(declOf(css, '.dgcard', 'border-bottom').split(/\s+/)[0]) +
    px(declOf(css, '.dgcard .dghead', 'height')) +
    px(declOf(css, '.dgreply', 'margin-top')) + lineWith('.dgreply') + px(declOf(css, '.dgreply', 'line-height')) +
    4 * (px(declOf(css, '.dgline', 'margin-top')) + px(declOf(css, '.dgline', 'line-height'))) +
    px(declOf(css, '.dgcard .dghint', 'margin-top')) + px(declOf(css, '.dgcard .dghint', 'line-height'));
  const rowH = px(declOf(css, '.dgrow', 'height'));
  const headroom = column - (3 * rowH + card);
  assert.ok(headroom >= 0, 'three rows (' + 3 * rowH + 'px) and a full card (' + card + 'px) are ' + (3 * rowH + card) + 'px of ' + column + 'px');
  // The label must not make a reply line taller than the reply's own line-height: that is the whole reason for its line-height.
  assert.equal(lineWith('.dgreply'), px(declOf(css, '.dgreply', 'line-height')));
  // A row: padding, head, the sub line (with its label) and the border must fit in its 58px, which is fixed.
  const rowContent = px(declOf(css, '.dgrow', 'padding').split(/\s+/)[0]) + px(declOf(css, '.dgrow .dghead', 'height')) +
    px(declOf(css, '.dgsub', 'margin-top')) + lineWith('.dgsub') + px(declOf(css, '.dgrow', 'border-bottom').split(/\s+/)[0]);
  assert.ok(rowContent <= rowH, 'a row needs ' + rowContent + 'px of its ' + rowH + 'px');
  assert.equal(lineWith('.dgsub'), px(declOf(css, '.dgsub', 'line-height')));
  // And the 19px title fits the head it sits in (a line of 1.25 is 23.75px).
  assert.ok(fontSizeOf(css, '.dgrow .dgtitle') * 1.25 <= px(declOf(css, '.dgrow .dghead', 'height')));

  // At line-height 1.25: padding, head, the fleet line (wrapped to two), three rows, the hint.
  const lh = 1.25;
  const p = declOf(css, '.dgfirst', 'padding').split(/\s+/).map(px);
  const first = p[0] + p[2] + fontSizeOf(css, '.dgfhead') * lh +
    px(declOf(css, '.dgffleet', 'margin-top')) + 2 * fontSizeOf(css, '.dgffleet') * lh +
    3 * (px(declOf(css, '.dgfrow', 'margin-top')) + fontSizeOf(css, '.dgftitle') * lh + px(declOf(css, '.dgftext', 'margin-top')) + 2 * fontSizeOf(css, '.dgftext') * lh) +
    fontSizeOf(css, '.dghint') * lh;
  assert.ok(first <= 414, 'the first card stacks to ' + first + 'px of 414');
});

// Every declaration of every rule this task adds, exactly. The explicit tests above say why each matters; this one is
// the net under them, so that no declaration can be taken out or changed without a test failing. (Later tasks add their
// own selectors next to these; only the selectors named here are held to this table.)
const LOCK = {
  '.dgstrip': 'height: 34px; flex-shrink: 0; display: flex; align-items: center; padding: 0 16px; border-bottom: 1px solid var(--rule); font-family: "JetBrains Mono", Menlo, monospace; font-size: 16px; color: var(--muted)',
  '.dgfleet': 'flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis',
  '.dgsrc': 'flex-shrink: 0; margin-left: 12px; letter-spacing: 0.14em',
  '.dgcol': 'flex: 1; min-height: 0; overflow: hidden',
  '.dgrow': 'height: 58px; padding: 6px 16px 0 16px; overflow: hidden; border-bottom: 1px solid var(--rule)',
  '.dgcard': 'padding: 6px 16px 6px 16px; border-bottom: 1px solid var(--rule); background: var(--panel-hi); box-shadow: inset 4px 0 0 var(--accent)',
  '.dghead': 'display: flex; align-items: center',
  '.dgcard .dghead': 'height: 28px',
  '.dgrow .dghead': 'height: 24px',
  '.dgcard .lamp': 'width: 18px; height: 18px; margin-right: 12px',
  '.dgrow .lamp': 'width: 14px; height: 14px; margin-right: 10px',
  '.dgstate': 'flex-shrink: 0; margin-right: 14px; font-weight: 700; font-size: 17px; letter-spacing: 0.16em; color: var(--text-2)',
  '.dgrow .dgstate': 'font-size: 15px',
  '.dgtitle': 'flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-weight: 700; font-size: 22px; color: var(--text-2)',
  '.dgrow .dgtitle': 'font-size: 19px; color: var(--text-2)',
  '.dgcard.idle .dgtitle': 'color: var(--muted)',
  '.dgtag': 'flex-shrink: 0; margin-left: 10px; padding: 0 6px; border: 1px solid var(--rule); border-radius: 4px; font-weight: 700; font-size: 14px; line-height: 18px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--text-2)',
  '.dgage': 'flex-shrink: 0; margin-left: 12px; font-family: "JetBrains Mono", Menlo, monospace; font-size: 16px; color: var(--muted)',
  '.dghint': 'font-family: "JetBrains Mono", Menlo, monospace; font-size: 16px; color: var(--muted)',
  '.dgcard .dghint': 'margin-top: 2px; line-height: 20px; text-align: right',
  '.dgreply': 'margin-top: 2px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; font-weight: 700; font-size: 22px; line-height: 26px; color: var(--text-2)',
  '.dgrlabel': 'margin-right: 4px; font-weight: 700; font-size: 14px; line-height: 1; letter-spacing: 0.14em; color: var(--muted)',
  '.dgline': 'margin-top: 2px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-weight: 500; font-size: 20px; line-height: 24px; color: var(--text-3)',
  '.dgsub': 'margin-top: 3px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-weight: 500; font-size: 19px; line-height: 24px; color: var(--text-2)',
  '.dgfirst': 'display: flex; flex-direction: column; padding: 15px 18px 14px 18px; border-radius: 10px; overflow: hidden; line-height: 1.25; background: var(--panel)',
  '.dgfirst.selected': 'background: var(--panel-hi); box-shadow: 0 0 0 2px var(--accent)',
  '.dgfhead': 'font-weight: 700; font-size: 17px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--text-2)',
  '.dgffleet': 'margin-top: 6px; font-family: "JetBrains Mono", Menlo, monospace; font-size: 16px; color: var(--muted)',
  '.dgfrow': 'margin-top: 14px',
  '.dgfrtop': 'display: flex; align-items: center',
  '.dgfirst .lamp': 'width: 14px; height: 14px; margin-right: 10px; animation: none; box-shadow: none',
  '.dgftitle': 'flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-weight: 700; font-size: 19px; color: var(--text-2)',
  '.dgfage': 'flex-shrink: 0; margin-left: 10px; font-family: "JetBrains Mono", Menlo, monospace; font-size: 16px; color: var(--muted)',
  '.dgftext': 'margin-top: 4px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; font-weight: 500; font-size: 19px; color: var(--text-3)',
  '.dgfirst .dghint': 'margin-top: auto; text-align: right',
  '.digest .lamp': 'animation: none; box-shadow: none',
  '.dstrip .lamp': 'width: 14px; height: 14px; margin-right: 12px; animation: none; box-shadow: none',
  // Task 13: the session strip, the session card, the clock's line.
  '.dstrip': 'height: 40px; flex-shrink: 0; display: flex; align-items: center; padding: 0 24px; border-bottom: 1px solid var(--rule)',
  '.dstext': 'flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-weight: 500; font-size: 20px; line-height: 24px; color: var(--bone)',
  '.dsage': 'flex-shrink: 0; margin-left: 12px; font-family: "JetBrains Mono", Menlo, monospace; font-size: 16px; color: var(--muted)',
  '.dcard': 'margin: 0 24px 14px 24px; padding: 10px 14px; border-left: 4px solid var(--idle); border-radius: 4px; background: var(--panel)',
  '.dchead': 'font-weight: 700; font-size: 16px; line-height: 20px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--text-2)',
  '.adigest': 'margin-top: 20px; max-width: 528px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-weight: 500; font-size: 20px; line-height: 24px; color: var(--text-3)',
  // Task 14: the first card's place in the sessions grid, and the words beside it when it stands alone.
  '.gridtrack .dgfirst': 'grid-row: 1 / 3',
  '.dgnote': 'grid-row: 1 / 3; display: flex; align-items: center; justify-content: center; text-align: center; padding: 0 24px; font-weight: 700; font-size: 22px; letter-spacing: 0.16em; line-height: 1.4; color: var(--dim)',
};

test('every declaration of every rule of the digest section is pinned, so none can be removed or changed unseen', () => {
  for (const sel of Object.keys(LOCK)) assert.deepEqual(declsOf(css, sel), parseDecls(LOCK[sel]), sel);
});

test('digest rules use no gap, inset or clamp, and no warn or danger colour', () => {
  assert.doesNotMatch(digestRules(css), /(^|[;{\s])(gap|inset)\s*:|clamp\(|--warn|--danger/);
  assert.doesNotMatch(digestRules(css), /(grid|column|row)-gap/);
});

test('digest lamps are static, on the list and on the first card', () => {
  for (const re of [/\.digest \.lamp[^{]*\{[^}]*animation:\s*none/, /\.dstrip \.lamp[^{]*\{[^}]*animation:\s*none/, /\.dgfirst \.lamp[^{]*\{[^}]*animation:\s*none/]) assert.match(css, re);
});

test('nothing in the digest animates, glows or fades', () => {
  const rules = digestRules(css);
  for (const m of rules.matchAll(/animation[a-z-]*:\s*([^;}]+)/g)) assert.equal(m[1].trim(), 'none', m[0]);
  assert.doesNotMatch(rules, /transition|@keyframes|opacity/);
  for (const sel of ['.digest .lamp', '.dstrip .lamp', '.dgfirst .lamp']) {
    assert.equal(declOf(css, sel, 'animation'), 'none', sel);
    assert.equal(declOf(css, sel, 'box-shadow'), 'none', sel);
  }
  // Same specificity as .lamp.busy and .lamp.attention, so it has to come after them to win.
  const quiet = css.indexOf('.digest .lamp');
  for (const lamp of ['.lamp.busy', '.lamp.attention', '.lamp.celebrate']) assert.ok(css.indexOf(lamp + ' {') < quiet, lamp);
});

test('every digest class the renderers draw has a rule', () => {
  const card = (id) => ({ sessionId: id, title: 'T', ended: false, lastTurnTs: now() - 60e3, lines: ['l'], lastReply: 'r', summary: null });
  const digest = { windowHours: 24, totals: { sessions: 2, turns: 2, commits: 1, prs: 1 }, cards: [card('a'), card('b')] };
  const state = { sessions: [{ id: 'a', state: 'busy', ended: false }], details: {}, digest, digestSel: 'a', daemonConnected: true };
  const html = renderDigest(state, 0) + renderFleetCard(state, true) + renderFleetCard(state, false);
  const used = new Set();
  for (const m of html.matchAll(/class="([^"]*)"/g)) for (const c of m[1].split(' ')) if (/^(dg|digest)/.test(c)) used.add(c);
  assert.ok(used.size >= 25, 'found ' + used.size + ' digest classes');
  const declared = digestRules(css);
  for (const c of used) assert.ok(new RegExp('\\.' + c + '(?![\\w-])').test(declared), '.' + c + ' has no rule');
});

// ---- Task 13: the session strip, the session card, the clock's line ---------------------------------------

test('the strip, the card and the clock line: what lays them out, clips them and colours them', () => {
  const is = (sel, want) => assert.deepEqual(Object.fromEntries(Object.keys(want).map((k) => [k, declOf(css, sel, k)])), want, sel);
  // The strip is a fixed bar: it does not give way when the column is tall, and it keeps its line to one row.
  is('.dstrip', { height: '40px', 'flex-shrink': '0', display: 'flex', 'align-items': 'center', padding: '0 24px', 'border-bottom': '1px solid var(--rule)' });
  is('.dstrip .lamp', { width: '14px', height: '14px', 'margin-right': '12px', animation: 'none', 'box-shadow': 'none' });
  // The text gives way to the age, which keeps its width; its one line is cut with an ellipsis.
  is('.dstext', { flex: '1', 'min-width': '0', overflow: 'hidden', 'white-space': 'nowrap', 'text-overflow': 'ellipsis', 'font-weight': '500', 'font-size': '20px', color: 'var(--bone)' });
  is('.dsage', { 'flex-shrink': '0', 'margin-left': '12px', 'font-size': '16px', color: 'var(--muted)' });
  assert.match(declOf(css, '.dsage', 'font-family'), MONO);
  // The card lines up with the conversation's 24px, is set apart by its own background, and its heading is meta.
  is('.dcard', { margin: '0 24px 14px 24px', padding: '10px 14px', background: 'var(--panel)', 'border-radius': '4px', 'border-left': '4px solid var(--idle)' });
  is('.dchead', { 'font-weight': '700', 'font-size': '16px', 'line-height': '20px', 'letter-spacing': '0.16em', 'text-transform': 'uppercase', color: 'var(--text-2)' });
  // The clock's line: one row, quieter than the status above it, at most 528px wide (centred on x 400, the widest line
  // that clears the mascot's side passes, which leave x 136 to 690 free); a line wider than that is cut by the CSS
  // ellipsis before its own 64-character cut.
  is('.adigest', { 'margin-top': '20px', 'max-width': '528px', overflow: 'hidden', 'white-space': 'nowrap', 'text-overflow': 'ellipsis', 'font-weight': '500', 'font-size': '20px', 'line-height': '24px', color: 'var(--text-3)' });
  // Chakra Petch is the page's face, so the line (no face of its own) is set in it.
  assert.equal(declOf(css, '.adigest', 'font-family'), undefined);
  assert.match(declOf(css, 'body', 'font-family'), /^"Chakra Petch"/);
  // Not tappable, not animated: nothing on these says so, and nothing on them can be pressed.
  for (const sel of ['.dstrip', '.dstext', '.dsage', '.dcard', '.dchead', '.adigest']) {
    for (const prop of ['cursor', 'animation', 'transition', 'opacity', 'position', 'z-index']) assert.equal(declOf(css, sel, prop), undefined, sel + ' ' + prop);
  }
  // The strip's lamp is the digest's static one: the rule that holds it still sits after .lamp.busy and .lamp.attention.
  assert.ok(css.search(/\.dstrip \.lamp \{[^}]*width/) > css.indexOf('.lamp.attention {'));
  assert.ok(css.indexOf('.digest .lamp, .dstrip .lamp, .dgfirst .lamp') > css.indexOf('.lamp.attention {'));
});

test('the strip is 40px of the column, the card fits what is left, and the clock screen keeps room for its new line', () => {
  const box = declOf(css, '*', 'box-sizing');
  assert.equal(box, 'border-box', 'a height includes its border');
  // The screen is 480px; the session view is a column of the top bar, the strip, and the scrolling column that takes the rest.
  assert.equal(px(declOf(css, '.screen', 'height')), 480);
  assert.equal(declOf(css, '.screen', 'flex-direction'), 'column');
  assert.deepEqual([declOf(css, '.dscroll', 'flex'), declOf(css, '.dscroll', 'min-height')], ['1', '0']);
  const topbar = px(declOf(css, '.topbar', 'height'));
  const strip = px(declOf(css, '.dstrip', 'height'));
  const column = 480 - topbar - strip;
  assert.equal(strip, 40, 'the strip costs 40 of the 434px under the top bar');
  assert.equal(column, 394, 'the scrolling column is 394px with the strip');
  assert.equal(declOf(css, '.dstrip', 'flex-shrink'), '0', 'the column gives way, not the strip');
  // What is in the strip fits the 39px under its border: the lamp, the 20px text on its 24px line, the 16px age (a line of 1.4 at most).
  const inside = strip - px(declOf(css, '.dstrip', 'border-bottom').split(/\s+/)[0]);
  assert.ok(px(declOf(css, '.dstrip .lamp', 'height')) <= inside);
  assert.ok(px(declOf(css, '.dstext', 'line-height')) <= inside && fontSizeOf(css, '.dstext') <= px(declOf(css, '.dstext', 'line-height')));
  assert.ok(fontSizeOf(css, '.dsage') * 1.4 <= inside);

  // The card at its worst: a two-line reply (its label is on a 14px line, so it cannot make that line taller) and four fact lines.
  const labelBox = px(declOf(css, '.dgrlabel', 'line-height')) * fontSizeOf(css, '.dgrlabel');
  assert.ok(labelBox <= px(declOf(css, '.dgreply', 'line-height')));
  // A box shorthand as [top, right, bottom, left]: one, two or four values.
  const sides = (v) => { const a = v.split(/\s+/).map(px); return a.length === 1 ? [a[0], a[0], a[0], a[0]] : a.length === 2 ? [a[0], a[1], a[0], a[1]] : a; };
  const pad = sides(declOf(css, '.dcard', 'padding'));
  const margin = sides(declOf(css, '.dcard', 'margin'));
  const card = margin[0] + margin[2] + pad[0] + pad[2] +
    px(declOf(css, '.dchead', 'line-height')) +
    px(declOf(css, '.dgreply', 'margin-top')) + 2 * px(declOf(css, '.dgreply', 'line-height')) +
    4 * (px(declOf(css, '.dgline', 'margin-top')) + px(declOf(css, '.dgline', 'line-height')));
  assert.ok(card <= column, 'a full card is ' + card + 'px of the ' + column + 'px column, so it can be shown whole');
  assert.ok(fontSizeOf(css, '.dchead') <= px(declOf(css, '.dchead', 'line-height')));
  // And as wide as the column's reading width: 24px in on both sides, as the conversation is.
  assert.deepEqual([margin[1], margin[3]], [24, 24]);

  // The clock screen: the stack of lines is centred in 480px, and the hint is pinned to the bottom. A line of `normal` is counted
  // at 1.4 times its font (the worst of the faces used). With the clock's line the stack is the largest it gets; the alarm
  // (44px instead of 34) is when the line is not drawn.
  const NORMAL = 1.4;
  const lineBox = (sel, lh) => (lh === undefined ? NORMAL * fontSizeOf(css, sel) : px(lh));
  const clock = fontSizeOf(css, '.ambient .bigclock') * px(declOf(css, '.ambient .bigclock', 'line-height'));
  const ahead = (sel) => px(declOf(css, '.ambient .ahead', 'margin-top')) + fontSizeOf(css, sel) * px(declOf(css, '.ambient .ahead', 'line-height'));
  const caption = px(declOf(css, '.ambient .caption', 'margin-top')) + lineBox('.ambient .caption', declOf(css, '.ambient .caption', 'line-height'));
  const fleet = px(declOf(css, '.ambient .fleet', 'margin-top')) + px(declOf(css, '.ambient .fleet .lamp', 'height'));
  const line = px(declOf(css, '.adigest', 'margin-top')) + px(declOf(css, '.adigest', 'line-height'));
  const tokens = px(declOf(css, '.ambient .tokens', 'margin-top')) + lineBox('.ambient .tokens', declOf(css, '.ambient .tokens', 'line-height'));
  const withLine = clock + ahead('.ambient .ahead') + caption + fleet + line + tokens;
  const alarmed = clock + ahead('.ambient .ahead.blocked') + caption + fleet + tokens;
  const hintZone = px(declOf(css, '.ambient .hint', 'bottom')) + fontSizeOf(css, '.ambient .hint') * NORMAL;
  const room = 2 * (480 / 2 - hintZone);   // the stack is centred, so its half-height must clear the hint on the bottom
  assert.ok(Math.max(withLine, alarmed) <= room, 'the clock screen stacks to ' + Math.max(withLine, alarmed) + 'px of ' + room + 'px');
  assert.ok(withLine + 40 <= room, 'and keeps at least 40px of headroom at the worst case: ' + withLine + ' of ' + room);
  // Inside the screen's side gutters (and pinned at 528px above, which is narrower than 64 characters at 20px: the
  // CSS ellipsis cuts a long line, so its own … from the 64-character cut is then not drawn).
  assert.ok(px(declOf(css, '.adigest', 'max-width')) <= 800 - 2 * 16);
  assert.equal(declOf(css, '.ambient', 'align-items'), 'center');
});

test('every class the strip, the card and the clock line draw has a rule, and no more are drawn', () => {
  const c = { sessionId: 'a', title: 'Panel brightness tuning', ended: false, lastTurnTs: now() - 12 * 60e3, lines: ['1 commit: fix: x', 'Tests: 14 passed'], lastReply: 'Done.', summary: null };
  const state = { sessions: [{ id: 'a', state: 'busy', ended: false }], details: { a: { id: 'a', state: 'busy' } }, asks: [], digest: { cards: [c] } };
  const html = sessionStrip(state, 'a') + sessionCard(state, 'a') + ambientLine(state);
  const used = new Set();
  for (const m of html.matchAll(/class="([^"]*)"/g)) for (const name of m[1].split(' ')) used.add(name);
  assert.deepEqual([...used].sort(), ['adigest', 'busy', 'dcard', 'dchead', 'dgline', 'dgreply', 'dgrlabel', 'dsage', 'dstext', 'dstrip', 'lamp']);
  for (const name of used) assert.ok(new RegExp('\\.' + name + '(?![\\w-])').test(css), '.' + name + ' has no rule');
  assert.doesNotMatch(html, /style=/);
});

// ---- Task 14: the first card on the sessions screen ------------------------------------------------

test('the first card spans both grid rows and takes the grid\'s own 372 px column', () => {
  const rule = /\.gridtrack \.dgfirst\s*\{([^}]*)\}/.exec(css)[1];
  assert.match(rule, /grid-row:\s*1 \/ 3/); assert.doesNotMatch(rule, /(^|[;\s])(width|height)\s*:/);
});

// A box shorthand as [top, right, bottom, left]: one, two or four values.
const sidesOf = (v) => { const a = v.split(/\s+/).map(px); return a.length === 1 ? [a[0], a[0], a[0], a[0]] : a.length === 2 ? [a[0], a[1], a[0], a[1]] : a; };
const cardState = (over = {}) => ({ ...listState(0), digest: { windowHours: 24, totals: { sessions: 1, turns: 1 }, cards: [{ sessionId: 'a', title: 'T', lastTurnTs: now() - 60e3, lines: ['l'], lastReply: 'r' }] }, ...over });

test('the first card\'s cell is 372 x 414 at (12, 54), its stack fits with 30px to spare, and the track steps one column', () => {
  // The cell, from the sheet: the 480px screen, the top bar, .gridwrap's padding, then .gridtrack's two rows and the gap between them.
  assert.equal(px(declOf(css, '.screen', 'height')), 480);
  assert.deepEqual([declOf(css, '.gridwrap', 'flex'), declOf(css, '.gridwrap', 'min-height'), declOf(css, '.gridtrack', 'height')], ['1', '0', '100%']);
  assert.deepEqual([declOf(css, '.gridtrack', 'grid-auto-flow'), declOf(css, '.gridtrack', 'grid-template-rows')], ['column', 'repeat(2, 1fr)']);
  const topbar = px(declOf(css, '.topbar', 'height'));
  const pad = sidesOf(declOf(css, '.gridwrap', 'padding'));
  const colW = px(declOf(css, '.gridtrack', 'grid-auto-columns'));
  const gap = px(declOf(css, '.gridtrack', 'grid-gap'));
  const row = (480 - topbar - pad[0] - pad[2] - gap) / 2;
  const cell = { x: pad[3], y: topbar + pad[0], w: colW, h: row + gap + row };
  assert.deepEqual(cell, { x: 12, y: 54, w: 372, h: 414 }, 'grid-row 1 / 3: both 203px rows and the 8px gap');
  // The card's stack at its own line-height: padding, the head, the fleet line on two lines, three rows (a one-line
  // title, two lines of text), the hint.
  const lh = px(declOf(css, '.dgfirst', 'line-height'));
  const p = sidesOf(declOf(css, '.dgfirst', 'padding'));
  const stack = p[0] + p[2] + fontSizeOf(css, '.dgfhead') * lh +
    px(declOf(css, '.dgffleet', 'margin-top')) + 2 * fontSizeOf(css, '.dgffleet') * lh +
    3 * (px(declOf(css, '.dgfrow', 'margin-top')) + fontSizeOf(css, '.dgftitle') * lh + px(declOf(css, '.dgftext', 'margin-top')) + 2 * fontSizeOf(css, '.dgftext') * lh) +
    fontSizeOf(css, '.dghint') * lh;
  assert.equal(stack, 384);
  assert.equal(cell.h - stack, 30, 'the stack is ' + stack + 'px of the ' + cell.h + 'px cell');
  // renderList moves the track one column and one gap per column: the card scrolls out whole.
  renderList({ ...listState(0), sessions: [] });
  assert.match(renderList(cardState({ selectedIndex: 2 })), new RegExp('translateX\\(-' + (colW + gap) + 'px\\)'));
  assert.equal(colW + gap, 380);
});

test('the words beside the card standing alone fit its column at their worst', () => {
  renderList({ ...listState(0), sessions: [] });
  const text = /<div class="dgnote">([^<]*)<\/div>/.exec(renderList(cardState({ sessions: [] })))[1];
  assert.equal(text, 'NO SESSIONS — START CLAUDE ON YOUR MAC OR NUCBOX');
  const size = fontSizeOf(css, '.dgnote');
  const width = 372 - 2 * sidesOf(declOf(css, '.dgnote', 'padding'))[1];
  // Worst case: every character a full em plus the letter-spacing, the words wrapped greedily.
  const advance = size * (1 + parseFloat(declOf(css, '.dgnote', 'letter-spacing')));
  let lines = 1, used = 0;
  for (const w of text.split(' ')) {
    const need = (used ? 1 : 0) + w.length;
    if (used && (used + need) * advance > width) { lines++; used = w.length; } else used += need;
  }
  const height = lines * size * px(declOf(css, '.dgnote', 'line-height'));
  assert.equal(lines, 5);
  assert.ok(height <= 414, 'five lines are ' + height + 'px of 414');
  // Centred both ways in a column of both rows, as the empty screen's words are on the whole screen.
  assert.deepEqual([declOf(css, '.dgnote', 'grid-row'), declOf(css, '.dgnote', 'align-items'), declOf(css, '.dgnote', 'justify-content'), declOf(css, '.dgnote', 'text-align')], ['1 / 3', 'center', 'center', 'center']);
  assert.deepEqual([declOf(css, '.dgnote', 'color'), declOf(css, '.empty', 'color')], ['var(--dim)', 'var(--dim)']);
});

test('every class the sessions screen draws for the card has a rule, and the digest checks read the new rules', () => {
  renderList({ ...listState(0), sessions: [] });
  const html = renderList(cardState()) + renderList(cardState({ onDigestCard: true })) + renderList(cardState({ sessions: [] }));
  const used = new Set();
  for (const m of html.matchAll(/class="([^"]*)"/g)) for (const c of m[1].split(' ')) if (/^dg/.test(c)) used.add(c);
  assert.deepEqual([...used].sort(), ['dgfage', 'dgffleet', 'dgfhead', 'dgfirst', 'dgfrow', 'dgfrtop', 'dgftext', 'dgftitle', 'dghint', 'dgnote']);
  const declared = digestRules(css);
  for (const c of used) assert.ok(new RegExp('\\.' + c + '(?![\\w-])').test(declared), '.' + c + ' has no rule');
  // Both new selectors name a .dg class, so the type floor, the glance list, the no-gap/inset/clamp/alarm-colour and the
  // no-animation checks above all read them; the sheet's own .gridtrack (its transition) is not pulled in with them.
  for (const sel of ['.gridtrack .dgfirst', '.dgnote']) assert.ok(digestRuleList(css).some((r) => r.selectors.includes(sel)), sel);
  assert.ok(!digestRuleList(css).some((r) => r.selectors.includes('.gridtrack')));
  // They sit in the digest section, before the rule that holds the lamps still (which must stay last).
  const section = css.indexOf('/* ---- digest ---- */');
  for (const sel of ['.gridtrack .dgfirst {', '.dgnote {']) assert.ok(css.indexOf(sel) > section && css.indexOf(sel) < css.indexOf('.digest .lamp, .dstrip .lamp, .dgfirst .lamp'), sel);
});
