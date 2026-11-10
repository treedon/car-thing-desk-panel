// The device screens are string builders, so they can be rendered and asserted
// on without a browser. These cover the formatting and the state→sprite mapping
// that the emulator screenshots can only show one case of at a time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { esc, fmtTokens, fmtDuration, stateLabel, modeLabel, effortLabel, isDestructive, watchTarget } from '../src/screens/helpers.js';
import { fmtClock, setTzOffset, setServerNow, now, resetClock } from '../src/clock.js';
import { renderList } from '../src/screens/session-list.js';
import { renderQueue } from '../src/screens/queue.js';
import { renderUsage } from '../src/screens/usage.js';
import { renderAmbient } from '../src/screens/ambient.js';
import { renderDetail, ACTION_ROWS, actionRowCount } from '../src/screens/session-detail.js';
import { renderAsk, setQueueContext } from '../src/screens/ask.js';
import { sessionStrip, sessionCard, ambientLine } from '../src/screens/digest.js';
import { detailCases, ambientCases, blankClock } from './fixtures/digest-guard-cases.js';

function baseState(over = {}) {
  return {
    sessions: [], stats: { active: 0, attention: 0 }, details: {}, asks: [],
    usage: null, daemonConnected: true, selectedIndex: 0, queueIndex: 0,
    queueAnswering: false, queueChoice: 0,
    queueQIndex: 0, queueAnswers: [], queueReview: false, queueFromReview: false,
    ...over,
  };
}
const session = (over = {}) => ({
  id: 'a', name: 'proj', state: 'busy', lastActivityTs: Date.now(),
  tokens: { in: 1000, out: 2000 }, pendingPermission: false, ...over,
});

test('escaping stops session text from breaking out into markup', () => {
  const html = renderList(baseState({ sessions: [session({ name: '<img src=x onerror=alert(1)>' })] }));
  assert.ok(!html.includes('<img'), 'tag must be escaped');
  assert.ok(html.includes('&lt;img'));
  assert.equal(esc('a & b'), 'a &amp; b');
});

test('token counts are humanised', () => {
  assert.equal(fmtTokens(0), '0');
  assert.equal(fmtTokens(999), '999');
  assert.equal(fmtTokens(1500), '2k');
  assert.equal(fmtTokens(2_400_000), '2.4M');
});

test('clock renders daemon-local time from the snapshot offset, UTC-clock proof', () => {
  const t = new Date(Date.UTC(2026, 6, 31, 18, 5));   // 18:05 UTC
  setTzOffset(240);                                    // EDT: UTC-4
  assert.equal(fmtClock(t), '2:05 PM');
  setTzOffset(-330);                                   // IST: UTC+5:30
  assert.equal(fmtClock(t), '11:35 PM');
  setTzOffset(undefined);                              // old daemon: fall back to local
  const local = new Date(2026, 6, 31, 9, 7);
  assert.equal(fmtClock(local), '9:07 AM');
  resetClock();
});

// The device has no RTC battery and never sees NTP, so its epoch is junk. Every
// timestamp it renders against — createdTs, startedTs — came from the Mac, so
// without this correction the wall clock is wrong and every duration with it.
test('the daemon epoch corrects a device clock that is hours off', () => {
  const deviceDrift = 3 * 60 * 60_000 + 47_000;        // device believes it is 3h47s ago
  setServerNow(Date.now() + deviceDrift);
  assert.ok(Math.abs(now() - (Date.now() + deviceDrift)) < 1000, 'now() runs on Mac time');

  // Rendered through a fixed offset the clock is then absolute, not relative to
  // whatever the device booted with.
  setTzOffset(240);
  const wall = new Date(Date.UTC(2026, 6, 31, 18, 5));
  assert.equal(fmtClock(wall), '2:05 PM');

  // Relay jitter must not walk the clock; a real correction still lands.
  const before = now();
  setServerNow(Date.now() + deviceDrift + 300);
  assert.ok(Math.abs(now() - before) < 1000, 'sub-second noise is ignored');
  setServerNow(Date.now());
  assert.ok(Math.abs(now() - Date.now()) < 1000, 'a real resync applies');

  resetClock();
  assert.ok(Math.abs(now() - Date.now()) < 1000, 'unsynced falls back to the device clock');
});

test('durations read as h/m', () => {
  assert.equal(fmtDuration(45_000), '0m');
  assert.equal(fmtDuration(30 * 60_000), '30m');
  assert.equal(fmtDuration(95 * 60_000), '1h 35m');
});

test('idle reads IDLE when quiet and ENDED only when actually over', () => {
  assert.equal(stateLabel('busy'), 'WORKING');
  assert.equal(stateLabel('attention'), 'ATTENTION');
  assert.equal(stateLabel('celebrate'), 'DONE');
  assert.equal(stateLabel('idle', false), 'IDLE');
  assert.equal(stateLabel('idle', true), 'ENDED');
});

test('grid marks the selected tile and only that one', () => {
  const html = renderList(baseState({
    sessions: [session({ id: 'a' }), session({ id: 'b' }), session({ id: 'c' })],
    selectedIndex: 1,
  }));
  assert.equal((html.match(/tile[^"]*selected/g) || []).length, 1);
});

test('grid scrolls sideways only once the selection leaves the visible columns', () => {
  const many = Array.from({ length: 12 }, (_, i) => session({ id: `s${i}` }));
  const near = renderList(baseState({ sessions: many, selectedIndex: 3 }));
  assert.match(near, /translateX\(-0px\)/, 'still at the start');

  const far = renderList(baseState({ sessions: many, selectedIndex: 11 }));
  const offset = Number(/translateX\(-(\d+)px\)/.exec(far)[1]);
  assert.ok(offset > 0, 'track slid to keep the selection on screen');
});

test('no scroll rail — the next column peeking past the bezel is the affordance', () => {
  const many = renderList(baseState({ sessions: Array.from({ length: 12 }, (_, i) => session({ id: `s${i}` })) }));
  assert.doesNotMatch(many, /grail|gthumb/, 'no rail eating vertical space');
  // Every session is in the track, so the column after the visible two is laid
  // out just off the right edge and shows as a sliver.
  assert.equal((many.match(/data-action="open"/g) || []).length, 12);
});

test('grid explains itself when there are no sessions', () => {
  assert.match(renderList(baseState()), /NO SESSIONS/);
});

test('a pending permission is flagged on its tile', () => {
  const html = renderList(baseState({ sessions: [session({ pendingPermission: true })] }));
  assert.match(html, /class="badge"/);
  assert.match(html, /needs your answer/);
});

test('each tile says which permission mode its window is in', () => {
  const modes = {
    plan: 'PLAN', bypassPermissions: 'BYPASS', acceptEdits: 'EDITS',
    auto: 'AUTO', default: 'MANUAL',
  };
  for (const [mode, label] of Object.entries(modes)) {
    assert.equal(modeLabel(mode), label);
    const html = renderList(baseState({ sessions: [session({ permissionMode: mode })] }));
    assert.ok(html.includes('>' + label + '<'), `${mode} tile must read ${label}`);
    assert.ok(html.includes('m-' + label.toLowerCase()), `${mode} tile needs its own class`);
  }
});

test('an unreported or unrecognised mode draws no badge rather than a guess', () => {
  assert.equal(modeLabel(undefined), null);
  assert.equal(modeLabel('someFutureMode'), null);
  const html = renderList(baseState({ sessions: [session({ permissionMode: 'someFutureMode' })] }));
  assert.ok(!html.includes('class="mode'), 'no badge for a mode we cannot name');
  assert.ok(!html.includes('someFutureMode'), 'and nothing unvetted reaches the markup');
});

test('mode and permission badges share a tile without fighting for the corner', () => {
  const html = renderList(baseState({
    sessions: [session({ permissionMode: 'plan', pendingPermission: true })],
  }));
  assert.ok(html.indexOf('class="mode') < html.indexOf('class="badge"'),
    'the mode badge comes first so the CSS sibling rule spaces the alert');
});

test('queue lists both kinds with their own accent and wait label', () => {
  const html = renderQueue(baseState({
    asks: [
      { kind: 'permission', id: 'p1', sessionName: 'proj', tool: 'Bash', summary: 'rm -rf x', createdTs: Date.now(), timeoutMs: 55_000 },
      { kind: 'question', id: 'q1', sessionName: 'proj', header: 'PICK', question: 'Which?', options: [{ label: 'a' }, { label: 'b' }], createdTs: Date.now() - 5000 },
    ],
  }));
  // Hero + stack, not a list of equals: the first owns the page and carries
  // its own actions, the rest preview underneath.
  assert.match(html, /PERMISSION REQUEST/, 'the hero names its kind in full');
  assert.match(html, /class="qhero/);
  assert.match(html, /qrow question/, 'the stacked question keeps its own accent');
  assert.match(html, /ALLOW/, 'a permission is answerable from the queue itself');
  assert.match(html, /DENY/);
  assert.doesNotMatch(html, /left/, 'no countdown — a deadline you can lose is worse than none');
  assert.match(html, /waiting \d+s/, 'asks show how long they have waited');
  assert.match(html, /2 waiting on you/);
});

test('empty queue says so plainly', () => {
  assert.match(renderQueue(baseState()), /NOTHING WAITING ON YOU/);
});

// Questions are not rendered here any more — an ask can hold several of them
// plus a review step, and that walk lives in the queue hero (see the hero
// tests below). main.js sends any question route back to the queue.
test('permission ask keeps allow / deny / skip with their hardware hints', () => {
  setQueueContext(0, 1);
  const ask = { kind: 'permission', id: 'p', sessionName: 'proj', tool: 'Bash', summary: 'ls', createdTs: Date.now() };
  const html = renderAsk(baseState(), ask, 0);
  assert.match(html, /ALLOW/);
  assert.match(html, /press dial/);
  assert.match(html, /DENY/);
  assert.match(html, /preset 3/);
  assert.match(html, /SKIP/);
});

test('usage shows each limit as a bar with its reset time', () => {
  const html = renderUsage(baseState({
    usage: {
      updatedLabel: 'updated 01:46 · from claude /usage',
      limits: [
        { key: 'session', label: 'SESSION', used: 0.11, detail: 'resets Jul 30 at 5:19am' },
        { key: 'week', label: 'WEEK · ALL MODELS', used: 0.21, detail: 'resets Aug 4 at 5pm' },
      ],
      windows: [{
        window: 'Last 24h', requests: 579, sessions: 8, notes: ['95% subagent-heavy'],
        skills: [{ name: '/deploy-to-dev', pct: '1%' }],
        subagents: [{ name: 'Explore', pct: '7%' }],
      }],
    },
  }));
  assert.match(html, /SESSION/);
  assert.match(html, /11%/);
  assert.match(html, /resets Jul 30 at 5:19am/);
  assert.match(html, /width:11\.0%/);
  assert.match(html, /Last 24h · 579 requests · 8 sessions/);
  assert.match(html, /SKILLS/);
  assert.match(html, /\/deploy-to-dev/);
  assert.match(html, /SUBAGENTS/);
  assert.match(html, /Explore/);
});

test('each bar carries its own mood, so one full limit does not condemn the rest', () => {
  const at = (used) => renderUsage(baseState({ usage: { limits: [{ label: 'X', used, detail: '' }], windows: [] } }));
  // Under 80% clear, 80-99% sweating, 100% fainted — fill and sprite always agree.
  assert.match(at(0.1), /ufill mood-clear/);
  assert.match(at(0.1), /usprite mood-clear/);
  assert.match(at(0.5), /ALL CLEAR/);
  assert.match(at(0.85), /ufill mood-low/);
  assert.match(at(0.85), /RUNNING OUT/);
  assert.match(at(1), /ufill mood-out/);
  assert.match(at(1), /OUT OF USAGE/);

  const mixed = renderUsage(baseState({
    usage: { limits: [{ label: 'A', used: 1, detail: '' }, { label: 'B', used: 0.1, detail: '' }], windows: [] },
  }));
  assert.match(mixed, /mood-out/);
  assert.match(mixed, /mood-clear/, 'a maxed weekly limit says nothing about the session limit');
});

test('usage says what is wrong instead of rendering empty bars', () => {
  assert.match(renderUsage(baseState({ usage: { limits: [], error: 'claude /usage failed' } })), /claude \/usage failed/);
  assert.match(renderUsage(baseState()), /READING USAGE/);
});

test('ambient shows a lamp per session and reads as a desk clock', () => {
  const html = renderAmbient(baseState({
    sessions: [session({ state: 'busy' }), session({ id: 'b', state: 'idle' })],
    stats: { active: 1, attention: 2 },
    asks: [{ id: 'k1' }, { id: 'k2' }],
  }));
  assert.equal((html.match(/class="lamp /g) || []).length, 2);
  assert.match(html, /1 WORKING · 1 RESTING/);
  // blocked is counted from the queue, not the attention stat, and breathes
  assert.match(html, /class="ahead blocked">2 NEED YOU/);
  assert.match(html, /press dial to answer/);

  const calm = renderAmbient(baseState({
    sessions: [session({ state: 'busy' })], stats: { active: 1, attention: 0 },
  }));
  assert.match(calm, /class="ahead">NOTHING BLOCKED/);
  assert.match(calm, /press dial for sessions/);

  // the whole screen is the sprite's switch — a tap anywhere toggles him
  assert.match(html, /data-action="mascot-toggle"/);
});

test('ambient: quiet cards never read as an alarm', () => {
  const quiet = (over) => ({ kind: 'card', id: 'c' + Math.random(), sessionId: 's', tag: 'update', loud: false, createdTs: 1, ...over });
  const sessions = [session({ state: 'idle' })];

  // one UPDATE card: nothing is waiting on the owner
  const update = renderAmbient(baseState({ sessions, asks: [quiet()] }));
  assert.match(update, /class="ahead">NOTHING BLOCKED/);
  assert.ok(!/NEEDS? YOU|blocked/.test(update), 'no alarm');
  assert.match(update, /press dial for sessions/);

  // a quiet ASKING card still waits, but calmly: a count, no amber, no breathing
  const asking = renderAmbient(baseState({ sessions, asks: [quiet({ tag: 'asking' })] }));
  assert.match(asking, /class="ahead">1 WAITING/);
  assert.ok(!/NEEDS? YOU|ahead blocked/.test(asking));
  assert.match(asking, /press dial for sessions/);

  // a loud card is the alarm; the number is everything waiting
  const loud = renderAmbient(baseState({ sessions, asks: [quiet({ tag: 'asking', loud: true }), quiet({ tag: 'asking' })] }));
  assert.match(loud, /class="ahead blocked">2 NEED YOU/);
  assert.match(loud, /press dial to answer/);

  // an expired notice waits on the terminal
  const expired = renderAmbient(baseState({ sessions, asks: [{ kind: 'permission', id: 'p', expired: true }] }));
  assert.match(expired, /class="ahead">NOTHING BLOCKED/);
});

test('detail shows tokens, cache and state, and waits politely before loading', () => {
  const loading = renderDetail(baseState(), 'a');
  assert.match(loading, /LOADING/);

  const html = renderDetail(baseState({
    details: { a: {
      id: 'a', name: 'proj', state: 'busy', tokens: { in: 266_000, out: 54_000 },
      cacheRead: 16_500_000, cwd: '/tmp/proj', model: 'claude-fable-5',
      startedTs: Date.now() - 90 * 60_000, currentTool: 'Bash', lastMessage: 'working', permission: null,
    } },
  }), 'a');
  assert.match(html, /54k/);
  assert.match(html, /266k/);
  assert.match(html, /16\.5M/);
  assert.match(html, /cache read/);
  assert.match(html, /1h 30m/);
  assert.match(html, /fable-5/, 'model prefix trimmed');
});

test('the connection dot reflects the daemon link on every screen', () => {
  for (const render of [renderList, renderQueue]) {
    assert.match(render(baseState({ daemonConnected: true })), /class="conn ok"/);
    assert.match(render(baseState({ daemonConnected: false })), /class="conn"/);
  }
});

test('a timed-out permission says where the decision went', () => {
  setQueueContext(0, 1);
  const ask = {
    kind: 'permission', id: 'p', sessionName: 'proj', tool: 'Bash', summary: 'ls',
    createdTs: Date.now() - 600_000, expired: true, expiredTs: Date.now(),
  };
  const html = renderAsk(baseState(), ask, 0);
  assert.match(html, /HOOK TIMED OUT — ANSWER IN TERMINAL/);
  // Allow/deny would write to a hook response that is already closed.
  assert.doesNotMatch(html, /ALLOW/, 'no allow button once the hook has gone');
  assert.doesNotMatch(html, /DENY/, 'no deny button either');
  assert.match(html, /DISMISS/, 'the only thing left to do is clear it');
});

test('the queue marks an expired permission as living in the terminal', () => {
  const html = renderQueue(baseState({
    asks: [{
      kind: 'permission', id: 'p1', sessionName: 'proj', tool: 'Bash', summary: 'ls',
      createdTs: Date.now() - 600_000, expired: true, expiredTs: Date.now(),
    }],
  }));
  assert.match(html, /IN TERMINAL/);
});

// --- v2 redesign ------------------------------------------------------------

test('a tile shows its context meter, neutral until it is nearly full', () => {
  const calm = renderList(baseState({
    sessions: [{ id: 'a', name: 'proj', state: 'busy', tokens: { in: 1, out: 2 }, context: 0.34 }],
  }));
  assert.match(calm, /34%/);
  assert.match(calm, /class="ctx"/, 'a filling window is normal, not an alarm');
  assert.match(calm, /width:34\.0%/);

  const hot = renderList(baseState({
    sessions: [{ id: 'a', name: 'proj', state: 'busy', tokens: { in: 1, out: 2 }, context: 0.88 }],
  }));
  assert.match(hot, /class="ctx hot"/, 'red only once it is close to compacting');
});

test('no context reading means no meter, never a meter against a guess', () => {
  const html = renderList(baseState({
    sessions: [{ id: 'a', name: 'proj', state: 'busy', tokens: { in: 1, out: 2 }, context: null }],
  }));
  assert.doesNotMatch(html, /ctxtrack/);
});

test('the track label is drawn twice, the dark copy clipped inside the fill', () => {
  const html = renderList(baseState({
    sessions: [{ id: 'a', name: 'proj', state: 'busy', tokens: { in: 1, out: 2 }, context: 0.34 }],
  }));
  const light = html.match(/<span class="ctxtext"><span class="ctxword">CONTEXT<\/span><span class="ctxnum">34%<\/span><\/span>/g);
  assert.equal(light && light.length, 1, 'one light copy on the bare track');
  assert.match(html,
    /<span class="ctxfill" style="width:34\.0%"><span class="ctxtext dark"><span class="ctxword">CONTEXT<\/span><span class="ctxnum">34%<\/span><\/span><\/span>/,
    'dark copy lives inside the fill so its edge clips it');
  assert.match(html, /class="ctxtext">[\s\S]*class="ctxfill"/,
    'fill paints over the light copy, never under it');
  assert.doesNotMatch(html, /ctxrow/, 'no line above the track spent on a number');
});

test('the tile names its model, even on an ended session with no meter', () => {
  const live = renderList(baseState({
    sessions: [{ id: 'a', name: 'proj', state: 'busy', tokens: { in: 1, out: 2 },
      context: 0.34, model: 'claude-fable-5' }],
  }));
  assert.match(live, /<div class="tspec">fable-5<\/div>/, 'model prefix trimmed');

  const ended = renderList(baseState({
    sessions: [{ id: 'a', name: 'proj', state: 'idle', ended: true,
      tokens: { in: 1, out: 2 }, context: null, model: 'claude-fable-5' }],
  }));
  assert.match(ended, /<div class="tspec">fable-5<\/div>/, 'spec line survives the meter');
  assert.doesNotMatch(ended, /ctxtrack/);

  const unnamed = renderList(baseState({
    sessions: [{ id: 'a', name: 'proj', state: 'busy', tokens: { in: 1, out: 2 }, context: null }],
  }));
  assert.doesNotMatch(unnamed, /tspec/, 'no model named, no line drawn');
});

test('the top bar counts what it is listing', () => {
  const html = renderList(baseState({
    sessions: [
      { id: 'a', name: 'one', state: 'busy', tokens: { in: 1, out: 2 } },
      { id: 'b', name: 'two', state: 'idle', tokens: { in: 1, out: 2 } },
    ],
  }));
  assert.match(html, /class="tcount">2</);
});

// --- effort mascot ----------------------------------------------------------

test('the working mascot runs at the session effort, named on the spec line', () => {
  const levels = {
    low: 'LOW', medium: 'MEDIUM', high: 'HIGH', xhigh: 'XHIGH', max: 'MAX',
    ultrathink: 'ULTRA',
  };
  for (const [effort, label] of Object.entries(levels)) {
    assert.equal(effortLabel(effort), label);
    const html = renderList(baseState({ sessions: [session({ effort })] }));
    assert.ok(html.includes(' e-' + label.toLowerCase()), `${effort} tile needs its gait class`);
    assert.ok(html.includes('class="tspec">' + label + '<'), `${effort} tile must read ${label}`);
  }
});

test('model and effort share one spec line, dot-separated', () => {
  const html = renderList(baseState({
    sessions: [session({ effort: 'max', model: 'claude-fable-5', context: 0.5 })],
  }));
  assert.match(html, /class="tspec">fable-5  ·  MAX</);
});

test('ultrathink is abbreviated — the full word broke the 14px type floor', () => {
  assert.equal(effortLabel('ultrathink'), 'ULTRA');
});

test('no reported effort means no label and the plain working sprite', () => {
  assert.equal(effortLabel(undefined), null);
  assert.equal(effortLabel('someFutureEffort'), null);
  const html = renderList(baseState({ sessions: [session({ effort: 'someFutureEffort' })] }));
  assert.ok(!html.includes('class="tspec"'), 'no label for an effort we cannot name');
  assert.ok(!html.includes('someFutureEffort'), 'and nothing unvetted reaches the markup');
  assert.ok(!html.includes(' e-'), 'no gait class either — working.svg stands');
});

test('only a working tile runs: effort on an idle session draws nothing', () => {
  const html = renderList(baseState({ sessions: [session({ state: 'idle', effort: 'max' })] }));
  assert.ok(!html.includes('MAX'));
  assert.ok(!html.includes(' e-max'));
});

// --- questions answered inside the queue hero --------------------------------

const questionAsk = (over = {}) => ({
  kind: 'question', id: 'q1', sessionName: 'proj', question: 'Which?',
  options: [
    { label: 'One', description: 'first' },
    { label: 'Two' },
    { label: 'Three', description: 'third' },
    { label: 'Four' },
  ],
  createdTs: Date.now(),
  ...over,
});

test('an answering hero shows every option in place, one selected', () => {
  const html = renderQueue(baseState({
    asks: [questionAsk()], queueAnswering: true, queueChoice: 2,
  }));
  assert.match(html, /qhero question answering/, 'the hero funds the list by shrinking');
  assert.equal((html.match(/data-action="queue-choice"/g) || []).length, 4,
    'all options at once — no 3-wide window, no paging');
  assert.equal((html.match(/qopt selected/g) || []).length, 1);
  assert.ok(html.indexOf('Three') > 0 && /qopt selected"[^>]*data-id="2"/.test(html),
    'the selection is where the cursor is');
  assert.doesNotMatch(html, /qchip/, 'the action chip gave way to the list');
});

test('the selected option expands: label stacks over description, both in full', () => {
  const html = renderQueue(baseState({
    asks: [questionAsk()], queueAnswering: true, queueChoice: 0,
  }));
  // Only the row under the cursor gets the stacked qtext wrapper; the CSS
  // wraps its text instead of clipping it.
  assert.equal((html.match(/class="qtext"/g) || []).length, 1,
    'exactly one row is expanded');
  assert.match(html, /qopt selected"[^>]*data-id="0"[^>]*>.*?class="qtext"/,
    'and it is the selected one');
  const collapsed = /qopt" data-action="queue-choice" data-id="1"><span class="qnum">2<\/span><span class="qlabel">/;
  assert.match(html, collapsed, 'unselected rows keep the flat one-line shape');
});

test('while the list is open the stack hides but the queue context survives', () => {
  const html = renderQueue(baseState({
    asks: [questionAsk(), questionAsk({ id: 'q2' }), questionAsk({ id: 'q3' })],
    queueAnswering: true,
  }));
  assert.doesNotMatch(html, /class="qrow/, 'stack rows give the list their room');
  assert.match(html, /2 more waiting/);
  assert.match(html, /dial moves · press answers · back closes/);
});

test('answering state only applies to a live question hero', () => {
  const perm = renderQueue(baseState({
    asks: [{ kind: 'permission', id: 'p1', sessionName: 'proj', tool: 'Bash', summary: 'ls', createdTs: Date.now() }],
    queueAnswering: true,
  }));
  assert.doesNotMatch(perm, /answering/, 'a permission has no list to open');
  assert.match(perm, /ALLOW/);
});

// A timed-out question is not a spent one: the dialog is still up in the
// terminal and the daemon can still type into it. So the card says where it
// went and stays answerable, unlike a timed-out permission whose hook response
// is gone.
test('a timed-out question keeps its options and says it is still in the terminal', () => {
  const idle = renderQueue(baseState({
    asks: [questionAsk({ expired: true, expiredTs: Date.now() })],
  }));
  assert.match(idle, /STILL OPEN IN TERMINAL/);
  assert.match(idle, /qchip vscode/, 'and its window can still be raised');
});

// One AskUserQuestion call is one dialog and one card, however many questions
// it holds. The card walks them, then shows a review step whose SUBMIT is what
// finally sends — which is the only way the dialog's own "Submit answers" step
// ever gets pressed, and the only way an earlier answer stays changeable.
const groupAsk = (over = {}) => ({
  kind: 'question', id: 'g1', sessionName: 'proj', createdTs: Date.now(),
  questions: [
    { header: 'AUTH', question: 'How should callers authenticate?', multiSelect: false,
      options: [{ label: 'OAuth' }, { label: 'API keys' }] },
    { header: 'ENVS', question: 'Which environments?', multiSelect: true,
      options: [{ label: 'Dev' }, { label: 'Staging' }, { label: 'Production' }] },
    { header: 'ROLLOUT', question: 'How fast?', multiSelect: false,
      options: [{ label: 'All at once' }, { label: 'Canary' }] },
  ],
  header: 'AUTH', question: 'How should callers authenticate?', options: [{ label: 'OAuth' }, { label: 'API keys' }],
  ...over,
});

test('a group card says how many questions it holds before it is opened', () => {
  const html = renderQueue(baseState({ asks: [groupAsk()] }));
  assert.match(html, /QUESTION · 3 PARTS/);
  assert.match(html, /ANSWER ON YOUR MAC/, 'nothing types any more: the card raises the window');
});

test('an opened group shows which question it is on, and only that one', () => {
  const html = renderQueue(baseState({
    asks: [groupAsk()], queueAnswering: true, queueQIndex: 1, queueAnswers: [[0], [], []],
  }));
  assert.match(html, /QUESTION · 2 OF 3/);
  assert.match(html, /Which environments\?/, 'the summary follows the walk');
  assert.doesNotMatch(html, /OAuth/, 'the answered question is not still on screen');
  assert.match(html, /Staging/);
});

test('a multiSelect question shows its picks and a DONE row to move on', () => {
  const html = renderQueue(baseState({
    asks: [groupAsk()], queueAnswering: true, queueQIndex: 1,
    queueAnswers: [[0], [0, 2], []], queueChoice: 0,
  }));
  assert.match(html, /qopt selected picked"[^>]*data-id="0"/, 'a picked row says so');
  assert.match(html, /qnum on">✓/, 'the number is a tick once it is picked');
  assert.match(html, /qopt qstep next[^>]*data-id="3"/, 'DONE sits after the three options');
  assert.match(html, /2 selected · preset 3/);
  // A press on an option only toggles it, so both the row and the hint have to
  // name what actually moves the walk on.
  assert.match(html, /press picks · preset 3 when done/);
});

test('a single-select question has no DONE row — its press is the commit', () => {
  const html = renderQueue(baseState({
    asks: [groupAsk()], queueAnswering: true, queueQIndex: 0, queueAnswers: [[], [], []],
  }));
  assert.doesNotMatch(html, /qstep/);
  assert.match(html, /press answers/);
});

test('the review step lists every answer and offers SUBMIT', () => {
  const html = renderQueue(baseState({
    asks: [groupAsk()], queueAnswering: true, queueReview: true, queueChoice: 3,
    queueAnswers: [[1], [0, 2], [1]],
  }));
  assert.match(html, /QUESTION · REVIEW/);
  assert.match(html, /AUTH/);
  assert.match(html, /API keys/);
  assert.match(html, /Dev · Production/, 'a multiSelect answer reads as all of its picks');
  assert.match(html, /Canary/);
  assert.equal((html.match(/data-action="queue-review"/g) || []).length, 4,
    'three questions to go back into, plus SUBMIT');
  assert.match(html, /qstep submit selected/, 'the cursor is on SUBMIT');
  assert.match(html, /sends all 3 answers/);
});

// Two different things, and the review step must not conflate them: a
// multiSelect with nothing ticked is an answer, an untouched single-select is
// a gap.
test('review tells "none" apart from not-answered-yet', () => {
  const html = renderQueue(baseState({
    asks: [groupAsk()], queueAnswering: true, queueReview: true,
    queueAnswers: [[], [], [1]],
  }));
  assert.match(html, /AUTH<\/span><span class="qdesc">—<\/span>/, 'single-select: a gap');
  assert.match(html, /ENVS<\/span><span class="qdesc">none<\/span>/, 'multiSelect: an answer');
});

test('a lone question renders exactly as it did — no part count, no review', () => {
  const html = renderQueue(baseState({ asks: [questionAsk()] }));
  assert.match(html, /class="qkind">QUESTION</, 'no "N PARTS" for a single question');
  assert.match(html, /ANSWER ON YOUR MAC/);
});

test('a question hero opens its list on tap; stack rows promote to hero', () => {
  const html = renderQueue(baseState({
    asks: [questionAsk(), questionAsk({ id: 'q2' })],
  }));
  assert.match(html, /qhero question[^>]*data-action="queue-answer"/,
    'the hero tap opens options in place, not the prompt screen');
  assert.match(html, /class="qrow question"[^>]*data-action="queue-promote"/,
    'a stack tap promotes rather than opening the prompt');
});

test('the queue hero offers a question its options rather than allow/deny', () => {
  const html = renderQueue(baseState({
    asks: [{
      kind: 'question', id: 'q1', sessionName: 'proj', question: 'Which?',
      options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }], createdTs: Date.now(),
    }],
  }));
  assert.match(html, /ANSWER ON YOUR MAC/);
  assert.doesNotMatch(html, /ALLOW/, 'a question cannot be answered by allow/deny');
});

test('an expired hero drops its actions and says where the decision went', () => {
  const html = renderQueue(baseState({
    asks: [{
      kind: 'permission', id: 'p1', sessionName: 'proj', tool: 'Bash', summary: 'ls',
      createdTs: Date.now() - 600_000, expired: true, expiredTs: Date.now(),
    }],
  }));
  assert.match(html, /HOOK TIMED OUT — ANSWER IN TERMINAL/);
  assert.doesNotMatch(html, /qchip/, 'nothing left to press once the hook is gone');
});

test('the empty queue is a state, not a blank screen', () => {
  const html = renderQueue(baseState());
  assert.match(html, /NOTHING WAITING ON YOU/);
  assert.match(html, /permissions, questions and finished turns land here/);
  assert.match(html, /qemptysprite/);
});

test('the prompt keeps its countdown — here you act against a live deadline', () => {
  setQueueContext(0, 1);
  const ask = {
    kind: 'permission', id: 'p', sessionName: 'proj', tool: 'Bash', summary: 'ls',
    createdTs: Date.now(), timeoutMs: 600_000,
  };
  const html = renderAsk(baseState(), ask, 0);
  assert.match(html, /cdtrack/);
  assert.match(html, /left/);
});

test('a countdown with no deadline left to run is not drawn', () => {
  setQueueContext(0, 1);
  const ask = {
    kind: 'permission', id: 'p', sessionName: 'proj', tool: 'Bash', summary: 'ls',
    createdTs: Date.now(), timeoutMs: 600_000, expired: true,
  };
  assert.doesNotMatch(renderAsk(baseState(), ask, 0), /cdtrack/);
});

// --- 2.0 hardware: intent, destructive arming, dismissal ---------------------

const permAsk = (over = {}) => ({
  kind: 'permission', id: 'p1', sessionName: 'proj', tool: 'Bash',
  summary: 'npm test', createdTs: Date.now(), ...over,
});

test('the hero says what you asked for, and the layout pays for the line', () => {
  const html = renderQueue(baseState({
    asks: [
      permAsk({ intent: 'you asked: reinstall the deps' }),
      permAsk({ id: 'p2' }), permAsk({ id: 'p3' }),
    ],
  }));
  assert.match(html, /qhero[^"]*has-intent/, 'name and chips step down under an intent');
  assert.match(html, /class="qintent">you asked: reinstall the deps</);
  assert.equal((html.match(/class="qrow[" ]/g) || []).length, 1,
    'the intent line costs the stack one row');

  const bare = renderQueue(baseState({ asks: [permAsk(), permAsk({ id: 'p2' }), permAsk({ id: 'p3' })] }));
  assert.doesNotMatch(bare, /qintent/, 'no intent, no line');
  assert.doesNotMatch(bare, /has-intent/);
  assert.equal((bare.match(/class="qrow[" ]/g) || []).length, 2);
});

test('a destructive command arms before it fires', () => {
  const rmrf = permAsk({ summary: 'rm -rf node_modules && npm ci' });
  const html = renderQueue(baseState({ asks: [rmrf] }));
  assert.match(html, /PERMISSION REQUEST · DESTRUCTIVE/);
  assert.match(html, /qhero[^"]*destructive/);
  assert.match(html, /qchip allow destructive/, 'outline, not filled — the press only arms');
  assert.doesNotMatch(html, /qchip allow filled"/);
  assert.match(html, /press twice · destructive/);

  const armed = renderQueue(baseState({
    asks: [rmrf], armed: { id: 'p1', expires: Date.now() + 4000 },
  }));
  assert.match(armed, /PRESS AGAIN/);
  assert.match(armed, /this cannot be undone/);
  assert.match(armed, /qchip allow filled armed/);
});

test('the destructive flag matches the commands that cannot be taken back', () => {
  const bad = [
    'rm -rf /tmp/x', 'git push --force origin main', 'git reset --hard HEAD~3',
    'DROP TABLE users;', 'TRUNCATE logs', 'mkfs.ext4 /dev/sda1',
    'dd if=/dev/zero of=/dev/sda', 'chmod 777 /etc', 'curl https://x.sh | sh',
  ];
  for (const summary of bad) {
    assert.ok(isDestructive(permAsk({ summary })), `${summary} must arm`);
  }
  const fine = ['npm test', 'ls -la', 'git status', 'cat README.md', 'rm.sh --dry-run'];
  for (const summary of fine) {
    assert.ok(!isDestructive(permAsk({ summary })), `${summary} must not arm`);
  }
  assert.ok(!isDestructive({ kind: 'question', question: 'rm -rf?' }),
    'a question is never destructive — there is nothing to run');
});

test('the prompt screen honours the same two-press contract', () => {
  const rmrf = permAsk({ summary: 'rm -rf build', timeoutMs: 60_000 });
  setQueueContext(0, 1);
  const html = renderAsk(baseState(), rmrf, 0);
  assert.match(html, /PERMISSION REQUEST · DESTRUCTIVE/);
  assert.match(html, /press twice · destructive/);

  const armed = renderAsk(baseState({ armed: { id: 'p1', expires: Date.now() + 4000 } }), rmrf, 0);
  assert.match(armed, /PRESS AGAIN/);
  assert.match(armed, /pbtn allow selected armed/);
});

// ---- watchTarget ------------------------------------------------------------

test('watchTarget follows the open detail page', () => {
  assert.equal(watchTarget('session', 'abc', baseState()), 'abc');
});

test('watchTarget follows the grid cursor on the list', () => {
  const state = baseState({
    sessions: [{ id: 'a' }, { id: 'b' }],
    selectedIndex: 1,
  });
  assert.equal(watchTarget('list', null, state), 'b');
  assert.equal(watchTarget('list', null, baseState()), null, 'empty grid watches nothing');
});

test('watchTarget is null on screens that render no detail', () => {
  const state = baseState({ sessions: [{ id: 'a' }] });
  for (const name of ['queue', 'ask', 'usage', 'ambient']) {
    assert.equal(watchTarget(name, null, state), null, name);
  }
});

// ---- isDestructive: daemon flag first, regex fallback -----------------------

test('a daemon-sent destructive flag outranks the regex either way', () => {
  assert.ok(isDestructive(permAsk({ summary: 'harmless-looking', destructive: true })),
    'flag true arms, whatever the summary says');
  assert.ok(!isDestructive(permAsk({ summary: 'rm -rf /', destructive: false })),
    'flag false disarms even a scary summary — the daemon saw the whole command');
});

test('no flag falls back to the regex over the summary', () => {
  assert.ok(isDestructive(permAsk({ summary: 'git reset --hard HEAD~1' })));
  assert.ok(!isDestructive(permAsk({ summary: 'git status' })));
});

// ---- VS Code sessions are answered in VS Code (plan Task 6) ------------------

test('a question from a VS Code session offers only Answer in VS Code', () => {
  const html = renderQueue(baseState({
    sessions: [{ id: 'sv', name: 'proj', host: 'vscode' }],
    asks: [{ kind: 'question', id: 'q1', sessionId: 'sv', sessionName: 'proj', header: 'PICK',
      question: 'Which?', options: [{ label: 'a' }, { label: 'b' }], createdTs: Date.now() }],
  }));
  assert.match(html, /Which\?/, 'the question text still shows');
  assert.match(html, /ANSWER IN VS CODE/);
  assert.match(html, /data-action="queue-vscode"/);
  assert.doesNotMatch(html, /2 options · press dial/);
});

// ---- cards on the queue (finished turns, ASKING / UPDATE / ERROR) -------------

const cardAsk = (over = {}) => ({
  kind: 'card', id: 'card:s1:1', sessionId: 's1', sessionName: 'proj', host: 'mac',
  tag: 'asking', text: 'full text', excerpt: 'Push it?', intent: '',
  createdTs: Date.now() - 240_000, stoppedTs: Date.now() - 240_000,
  loud: true, loudUntil: Date.now() + 360_000, endedTs: null, summary: null, ...over,
});
const permItem = (over = {}) => ({
  kind: 'permission', id: 'p1', sessionId: 'sp', sessionName: 'proj', tool: 'Bash',
  summary: 'ls', createdTs: Date.now(), timeoutMs: 55_000, ...over,
});

test('an asking card hero shows the tag, session, intent, excerpt and three actions', () => {
  const html = renderQueue(baseState({
    asks: [cardAsk({ tag: 'asking', excerpt: 'Push it?', intent: 'you asked: fix', sessionName: 'proj' })],
  }));
  for (const s of ['CLAUDE IS ASKING', 'proj', 'you asked: fix', 'Push it?', 'SWITCH', 'press dial',
    'REPLY', 'hold top', 'CLEAR', 'preset 3']) {
    assert.ok(html.includes(s), s);
  }
});

// Its press brings the session forward there (switchPlan, session-actions.test.js); the chip names where.
test('a card from the NucBox names the NucBox on its switch chip', () => {
  const html = renderQueue(baseState({ asks: [cardAsk({ machine: 'NucBox' })] }));
  assert.match(html, /ON THE NUCBOX/);
  assert.match(html, /data-action="queue-switch"/);
  assert.doesNotMatch(html, /SWITCH/);
});

test('the button the dial is on is the filled one, and says press dial', () => {
  const a = cardAsk();
  const onReply = renderQueue(baseState({ asks: [a], queueCardSel: { id: a.id, chip: 1 } }));
  assert.match(onReply, /qchip reply filled"[^>]*>.*?press dial/);
  assert.match(onReply, /qchip switch"/, 'SWITCH is no longer filled');
  assert.match(onReply, /qchip clear"[^>]*>.*?preset 3/, 'CLEAR keeps its shortcut hint');
  const fresh = renderQueue(baseState({ asks: [a] }));
  assert.match(fresh, /qchip switch filled"/, 'a card no one has turned to starts on SWITCH');
  assert.match(fresh, /qchip reply"[^>]*>.*?hold top/);
});

test('a card hero opens its session on tap, and its chips carry their own actions', () => {
  const html = renderQueue(baseState({ asks: [cardAsk({ sessionId: 'sess-9' })] }));
  assert.match(html, /class="qhero card asking[^"]*" data-action="queue-open" data-id="sess-9"/);
  for (const a of ['queue-switch', 'queue-reply', 'queue-clear']) {
    assert.equal((html.match(new RegExp('data-action="' + a + '"', 'g')) || []).length, 1, a);
  }
  assert.doesNotMatch(html, /queue-allow|queue-deny|queue-answer|open-ask/,
    'a card is never answered like a permission');
  assert.doesNotMatch(html, /PERMISSION/, 'and is never called one');
});

test('update and error cards say so', () => {
  const upd = renderQueue(baseState({ asks: [cardAsk({ tag: 'update', loud: false })] }));
  assert.ok(upd.includes('UPDATE'));
  assert.ok(!upd.includes('CLAUDE IS ASKING'));
  assert.match(upd, /class="qhero card update/);
  const err = renderQueue(baseState({ asks: [cardAsk({ tag: 'error', excerpt: 'API Error: 529' })] }));
  assert.ok(err.includes('STOPPED ON AN ERROR'));
  assert.ok(err.includes('API Error: 529'));
  assert.match(err, /class="qhero card error/);
});

test('a card says how long it has waited while loud and how long ago it finished after', () => {
  const loud = renderQueue(baseState({ asks: [cardAsk({ loud: true })] }));
  assert.match(loud, /waiting 4m/);
  assert.doesNotMatch(loud, /finished 4m ago/);
  const quiet = renderQueue(baseState({ asks: [cardAsk({ loud: false })] }));
  assert.match(quiet, /finished 4m ago/);
  assert.doesNotMatch(quiet, /waiting \d/);
});

test('a NucBox summary replaces the excerpt and is marked', () => {
  const html = renderQueue(baseState({
    asks: [cardAsk({ excerpt: 'the plain excerpt', summary: { headline: 'H', bullets: ['b1'] } })],
  }));
  assert.ok(html.includes('H'));
  assert.ok(html.includes('b1'));
  assert.ok(html.includes('NUCBOX'));
  assert.ok(!html.includes('the plain excerpt'));
  const plain = renderQueue(baseState({ asks: [cardAsk({ excerpt: 'the plain excerpt' })] }));
  assert.ok(!plain.includes('NUCBOX'), 'the marker is for summaries only');
});

test('a summary shows its headline and at most three bullets', () => {
  const html = renderQueue(baseState({
    asks: [cardAsk({ summary: { headline: 'HEAD', bullets: ['b1', 'b2', 'b3', 'b4'] } })],
  }));
  for (const s of ['HEAD', 'b1', 'b2', 'b3']) assert.ok(html.includes(s), s);
  assert.ok(!html.includes('b4'));
});

test('card text is escaped', () => {
  const html = renderQueue(baseState({
    asks: [cardAsk({
      excerpt: '<img src=x>', intent: 'you asked: <b>', sessionName: '<script>',
      summary: null,
    })],
  }));
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<script'));
  assert.ok(!html.includes('<b>'));
  assert.ok(html.includes('&lt;img src=x&gt;'));
  const summed = renderQueue(baseState({
    asks: [cardAsk({ summary: { headline: '<i>h</i>', bullets: ['<u>b</u>'] } })],
  }));
  assert.ok(!summed.includes('<i>') && !summed.includes('<u>'));
});

test('footer separates waiting from updates', () => {
  const html = renderQueue(baseState({
    asks: [permItem(), cardAsk({ id: 'card:a:1' }),
      cardAsk({ id: 'card:u1:1', sessionId: 'u1', tag: 'update', loud: false }),
      cardAsk({ id: 'card:u2:1', sessionId: 'u2', tag: 'update', loud: false })],
  }));
  assert.ok(html.includes('2 waiting on you · 2 updates'));
});

test('the footer leaves out whichever count is zero', () => {
  const onlyUpdates = renderQueue(baseState({
    asks: [cardAsk({ id: 'card:u1:1', sessionId: 'u1', tag: 'update', loud: false }),
      cardAsk({ id: 'card:u2:1', sessionId: 'u2', tag: 'update', loud: false })],
  }));
  assert.ok(onlyUpdates.includes('2 updates'));
  assert.doesNotMatch(onlyUpdates, /0 waiting|waiting on you/);
  const onlyWaiting = renderQueue(baseState({ asks: [permItem(), cardAsk()] }));
  assert.ok(onlyWaiting.includes('2 waiting on you'));
  assert.doesNotMatch(onlyWaiting, /update/i);
  const one = renderQueue(baseState({
    asks: [cardAsk({ tag: 'update', loud: false })],
  }));
  assert.ok(one.includes('1 update'));
  assert.doesNotMatch(one, /1 updates/);
});

test('an expired notice is not counted as waiting on you', () => {
  const html = renderQueue(baseState({
    asks: [permItem({ id: 'p1', expired: true, expiredTs: Date.now() }), permItem({ id: 'p2' })],
  }));
  assert.ok(html.includes('1 waiting on you'));
  assert.doesNotMatch(html, /2 waiting on you/);
});

test('a queue holding only an expired notice has nothing waiting on you', () => {
  const html = renderQueue(baseState({
    asks: [permItem({ expired: true, expiredTs: Date.now() })],
  }));
  assert.ok(html.includes('nothing waiting on you'));
  assert.doesNotMatch(html, /0 waiting/);
});

test('empty queue names finished turns and shows the chime row', () => {
  const html = renderQueue(baseState({ asks: [], chimeOn: true }));
  assert.ok(html.includes('permissions, questions and finished turns land here'));
  assert.ok(html.includes('Chime on the Mac: On'));
  assert.ok(html.includes('Plays when a session needs you'));
  assert.match(html, /data-action="toggle-chime"/);
});

test('the chime row says Off and that the Mac stays quiet', () => {
  const html = renderQueue(baseState({ asks: [], chimeOn: false }));
  assert.ok(html.includes('Chime on the Mac: Off'));
  assert.ok(html.includes('The Mac stays quiet'));
});

test('no chime row until the Mac has said what the chime is set to', () => {
  for (const state of [baseState({ asks: [] }), baseState({ asks: [], chimeOn: null })]) {
    const html = renderQueue(state);
    assert.ok(!html.includes('Chime'));
    assert.doesNotMatch(html, /toggle-chime/);
    assert.ok(html.includes('NOTHING WAITING ON YOU'));
  }
});

test('a card stack row says ASKING, UPDATE or ERROR beside the first line of its excerpt', () => {
  const html = renderQueue(baseState({
    asks: [permItem(),
      cardAsk({ id: 'card:a:1', sessionName: 'alpha', tag: 'asking', excerpt: 'Ship it?\nsecond line' }),
      cardAsk({ id: 'card:u:1', sessionName: 'beta', tag: 'update', loud: false, excerpt: 'All green.' })],
  }));
  assert.match(html, /class="qrow card asking" data-action="queue-promote" data-id="card:a:1"/);
  assert.match(html, /class="qrow card update" data-action="queue-promote" data-id="card:u:1"/);
  assert.match(html, /<span class="qrowkind">ASKING<\/span>/);
  assert.match(html, /<span class="qrowkind">UPDATE<\/span>/);
  assert.ok(html.includes('Ship it?'));
  assert.ok(!html.includes('second line'), 'a row shows one line');
  assert.match(html, /finished 4m ago/, 'a quiet row says so');
  const err = renderQueue(baseState({
    asks: [permItem(), cardAsk({ tag: 'error', excerpt: 'boom' })],
  }));
  assert.match(err, /<span class="qrowkind">ERROR<\/span>/);
});

test('a stack row shows the NucBox headline in place of the excerpt', () => {
  const html = renderQueue(baseState({
    asks: [permItem(), cardAsk({ excerpt: 'plain words', summary: { headline: 'Short version', bullets: ['x'] } })],
  }));
  assert.ok(html.includes('Short version'));
  assert.ok(!html.includes('plain words'));
});

test('a card hero with an intent line gives its stack one row back', () => {
  const rows = (h) => (h.match(/class="qrow[ "]/g) || []).length;
  const three = [cardAsk({ id: 'card:a:1' }), permItem({ id: 'p2' }), permItem({ id: 'p3' }), permItem({ id: 'p4' })];
  assert.equal(rows(renderQueue(baseState({ asks: three }))), 2);
  const withIntent = [cardAsk({ id: 'card:a:1', intent: 'you asked: x' }), ...three.slice(1)];
  assert.equal(rows(renderQueue(baseState({ asks: withIntent }))), 1);
});

test('a card hero carrying a summary gives its stack one row back too', () => {
  const rows = (h) => (h.match(/class="qrow[ "]/g) || []).length;
  const others = [permItem({ id: 'p2' }), permItem({ id: 'p3' }), permItem({ id: 'p4' })];
  const plain = renderQueue(baseState({ asks: [cardAsk({ id: 'card:a:1' }), ...others] }));
  const summed = renderQueue(baseState({
    asks: [cardAsk({ id: 'card:a:1', summary: { headline: 'H', bullets: ['b1', 'b2', 'b3'] } }), ...others],
  }));
  assert.equal(rows(plain), 2);
  assert.equal(rows(summed), 1);
});

test('the footer says "showing" for the rows actually drawn', () => {
  const others = [permItem({ id: 'p2' }), permItem({ id: 'p3' }), permItem({ id: 'p4' })];
  const plain = renderQueue(baseState({ asks: [cardAsk({ id: 'card:a:1' }), ...others] }));
  assert.ok(plain.includes('4 waiting on you · showing 3'));
  const intent = renderQueue(baseState({ asks: [cardAsk({ id: 'card:a:1', intent: 'you asked: x' }), ...others] }));
  assert.ok(intent.includes('4 waiting on you · showing 2'));
  const fits = renderQueue(baseState({ asks: [permItem(), cardAsk()] }));
  assert.ok(!fits.includes('showing'));
});

test('permissions, questions and plans keep their own rendering when a card is stacked under them', () => {
  const html = renderQueue(baseState({ asks: [permItem(), cardAsk()] }));
  assert.match(html, /PERMISSION REQUEST/);
  assert.match(html, /class="qhero[^"]*" data-action="open-ask" data-id="p1"/);
  assert.match(html, /ALLOW/);
  assert.match(html, /qrow card asking/);
});

// ---- waiting on a run, and the chime row in the session view ---------------

// The text of the tile's subline, whatever spans it is split into.
const tsubText = (html) => {
  const m = html.match(/<div class="tsub[^"]*">(.*?)<\/div>/);
  return m ? m[1].replace(/<[^>]*>/g, '') : null;
};

const waitDetail = (over = {}) => ({
  id: 'w', name: 'Build', project: 'p', state: 'busy', tokens: { in: 0, out: 0 }, cacheRead: 0,
  context: null, model: '', cwd: '/x/p', currentTool: null, lastMessage: '', waitingOn: [], ...over,
});
const detailState = (d, over = {}) => baseState({ details: { [d.id]: d }, messages: { [d.id]: [] }, subagents: {}, agentSel: -1, ...over });

test('a waiting tile says what it waits on, and for how long', () => {
  resetClock();
  const s = session({ state: 'busy', waitingOn: [{ type: 'shell', label: 'npm test', since: Date.now() - 4 * 60000 }] });
  const html = renderList(baseState({ sessions: [s] }));
  assert.equal(tsubText(html), 'waiting on npm test \u00b7 4m');
});

test('a waiting tile counts several jobs', () => {
  resetClock();
  const jobs = [
    { type: 'shell', label: 'npm test', since: Date.now() - 4 * 60000 },
    { type: 'subagent', label: 'review', since: Date.now() - 2 * 60000 },
  ];
  const html = renderList(baseState({ sessions: [session({ waitingOn: jobs })] }));
  assert.equal(tsubText(html), 'waiting on 2 jobs \u00b7 4m');
});

test('the waiting line is timed on the Mac clock, not the device clock', () => {
  setServerNow(Date.now() + 3 * 60 * 60_000);   // the device is three hours behind the Mac
  const s = session({ waitingOn: [{ type: 'shell', label: 'npm test', since: now() - 4 * 60000 }] });
  assert.equal(tsubText(renderList(baseState({ sessions: [s] }))), 'waiting on npm test \u00b7 4m');
  resetClock();
});

test('a waiting tile escapes the job label', () => {
  const s = session({ waitingOn: [{ type: 'shell', label: '<b>x</b> & y', since: Date.now() }] });
  const html = renderList(baseState({ sessions: [s] }));
  assert.ok(!html.includes('<b>x'));
  assert.ok(html.includes('waiting on &lt;b&gt;x&lt;/b&gt; &amp; y'));
});

// The label is the part that gives way: a long command must not push the age off
// the tile, because how long it has been is the half worth knowing.
test('a long job label is clipped by the tile, never the wait time', () => {
  resetClock();
  const label = 'npm run test:integration -- --watch --coverage';
  assert.ok(label.length >= 40);
  const s = session({ waitingOn: [{ type: 'shell', label, since: Date.now() - 4 * 60000 }] });
  const html = renderList(baseState({ sessions: [s] }));
  assert.equal(tsubText(html), 'waiting on ' + label + ' \u00b7 4m');
  assert.ok(html.includes('\u00b7 4m'), 'the age is in the tile');
  const label_ = html.match(/<span class="tsubl">([^<]*)<\/span>/);
  const age = html.match(/<span class="tsubr">([^<]*)<\/span>/);
  assert.ok(label_ && label_[1].includes(label), 'the label has its own span, the one that gets the ellipsis');
  assert.ok(age && age[1] === ' \u00b7 4m' && !age[1].includes(label), 'the age is a separate span that holds no label');
  assert.ok(html.indexOf('tsubl') < html.indexOf('tsubr'));
});

test('the tile CSS lets the label shrink and the age not', () => {
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  const rule = (sel) => (css.match(new RegExp(sel.replace(/\./g, '\\.') + '\\s*\\{([^}]*)\\}')) || [])[1] || '';
  assert.match(rule('.tile .tsubl'), /text-overflow:\s*ellipsis/);
  assert.match(rule('.tile .tsubl'), /min-width:\s*0/);
  // The age follows the label: a label that grew to fill the row (flex: 1)
  // pushed "· 4m" to the tile's right edge for a short label.
  assert.match(rule('.tile .tsubl'), /flex:\s*0\s+1\s+auto/);
  assert.doesNotMatch(rule('.tile .tsubl'), /flex:\s*1\s*;/);
  assert.match(rule('.tile .tsubr'), /flex-shrink:\s*0/);
  assert.match(rule('.tile .tsub.tsub-wait'), /display:\s*flex/);
});

test('a tile that needs your answer says so before it says it is waiting', () => {
  const s = session({ pendingPermission: true, waitingOn: [{ type: 'shell', label: 'npm test', since: Date.now() }] });
  const html = renderList(baseState({ sessions: [s] }));
  assert.match(html, /needs your answer/);
  assert.doesNotMatch(html, /waiting on npm test/);
});

test('a session waiting on nothing keeps its old subline', () => {
  const html = renderList(baseState({ sessions: [session({ state: 'busy', waitingOn: [] })] }));
  assert.match(html, /<div class="tsub">working…<\/div>/);
  assert.doesNotMatch(html, /waiting on/);
});

test('the session view lists each thing it is waiting on', () => {
  resetClock();
  const d = waitDetail({ waitingOn: [
    { type: 'shell', label: 'npm test', since: Date.now() - 4 * 60000 },
    { type: 'subagent', label: 'Review Task 4', since: Date.now() - 2 * 60000 },
  ] });
  const html = renderDetail(detailState(d), 'w');
  assert.match(html, /<div class="activity">waiting on 2 jobs · 4m<\/div>/);
  assert.doesNotMatch(html, /no active tool/);
  assert.equal((html.match(/class="waitrow"/g) || []).length, 2, 'one row per job');
  assert.match(html, /npm test/);
  assert.match(html, /Review Task 4/);
});

test('the session view says nothing about waiting when nothing is in flight', () => {
  const html = renderDetail(detailState(waitDetail({ state: 'idle' })), 'w');
  assert.match(html, /no active tool/);
  assert.doesNotMatch(html, /waiting on|waitrow/);
});

test('the session view escapes the job label', () => {
  const d = waitDetail({ waitingOn: [{ type: 'shell', label: '<i>x</i>', since: Date.now() }] });
  const html = renderDetail(detailState(d), 'w');
  assert.ok(!html.includes('<i>x'));
  assert.ok(html.includes('&lt;i&gt;x&lt;/i&gt;'));
});

test('the session view has the chime row after the two Mac rows', () => {
  const html = renderDetail(detailState(waitDetail({ state: 'idle' }), { chimeOn: false }), 'w');
  assert.ok(html.includes('Chime on the Mac: Off'));
  assert.ok(html.includes('The Mac stays quiet'));
  assert.match(html, /data-action="toggle-chime"/);
  assert.ok(html.indexOf('open-mac') < html.indexOf('toggle-auto-open'));
  assert.ok(html.indexOf('toggle-auto-open') < html.indexOf('toggle-chime'));
  const on = renderDetail(detailState(waitDetail({ state: 'idle' }), { chimeOn: true }), 'w');
  assert.ok(on.includes('Chime on the Mac: On'));
  assert.ok(on.includes('Plays when a session needs you'));
});

test('the chime row is still a row before the Mac has said, but claims nothing', () => {
  for (const over of [{}, { chimeOn: null }]) {
    const html = renderDetail(detailState(waitDetail({ state: 'idle' }), over), 'w');
    assert.match(html, /data-action="toggle-chime"/);
    assert.ok(!html.includes('Chime on the Mac: On'));
    assert.ok(!html.includes('Chime on the Mac: Off'));
  }
});

test('three action rows lead the list: subagent rows count after them', () => {
  assert.equal(ACTION_ROWS, 3);
  const agent = { id: 'a1', description: 'Agent one', agentType: 'Explore', depth: 1, running: false };
  const d = waitDetail({ state: 'idle' });
  const rowAt = (agentSel) => {
    const html = renderDetail(detailState(d, { agentSel, chimeOn: true, subagents: { w: [agent] } }), 'w');
    const selected = html.match(/<div class="agrow[^"]*selected"[^>]*data-action="([^"]+)"/);
    return { n: (html.match(/agrow[^"]*selected/g) || []).length, action: selected && selected[1] };
  };
  assert.deepEqual(rowAt(0), { n: 1, action: 'open-mac' });
  assert.deepEqual(rowAt(1), { n: 1, action: 'toggle-auto-open' });
  assert.deepEqual(rowAt(2), { n: 1, action: 'toggle-chime' });
  assert.deepEqual(rowAt(3), { n: 1, action: 'open-agent' });
  assert.deepEqual(rowAt(4), { n: 0, action: null });
});

// ---- background sessions: their own rows in the session view --------------------------------------------

// The action rows as drawn: [{ action, label, sub }] in page order.
function actionRows(html) {
  const out = [];
  const re = /<div class="agrow macrow[^"]*" data-action="([^"]+)"[^>]*><div class="agtop"><span class="agdesc">([^<]*)<\/span><\/div>(?:<div class="agsub">([^<]*)<\/div>)?<\/div>/g;
  let m;
  while ((m = re.exec(html))) out.push({ action: m[1], label: m[2], sub: m[3] === undefined ? null : m[3] });
  return out;
}
const bgDetail = (over = {}) => waitDetail({ state: 'idle', background: true, handoff: null, ...over });
const AUTO_AND_CHIME = [
  { action: 'toggle-auto-open', label: 'Open automatically: Off', sub: 'Checking in here leaves the Mac alone' },
  { action: 'toggle-chime', label: 'Chime on the Mac: On', sub: 'Plays when a session needs you' },
];
// A NucBox session's view: "Open automatically" brings it forward on the NucBox, so its row says so.
// (The chime stays the Mac's.)
const NUCBOX_AUTO_AND_CHIME = [
  { action: 'toggle-auto-open', label: 'Open automatically: Off', sub: 'Checking in here leaves the NucBox alone' },
  AUTO_AND_CHIME[1],
];
const bgState = (d, over = {}) => detailState(d, { chimeOn: true, ...over });

test('the Open automatically row names the session\'s own machine, on and off', () => {
  const autoRow = (d, autoOpenOnMac) => actionRows(renderDetail(bgState(d, { autoOpenOnMac }), 'w'))
    .find((r) => r.action === 'toggle-auto-open');
  for (const d of [waitDetail({ state: 'idle', machine: 'NucBox' }), bgDetail({ machine: 'NucBox' })]) {
    assert.deepEqual(autoRow(d, true),
      { action: 'toggle-auto-open', label: 'Open automatically: On', sub: 'Opening a session here also opens it on the NucBox' });
    assert.deepEqual(autoRow(d, false), NUCBOX_AUTO_AND_CHIME[0]);
  }
  for (const d of [waitDetail({ state: 'idle' }), bgDetail()]) {
    assert.deepEqual(autoRow(d, true),
      { action: 'toggle-auto-open', label: 'Open automatically: On', sub: 'Opening a session here also opens it on the Mac' });
    assert.deepEqual(autoRow(d, false), AUTO_AND_CHIME[0]);
  }
});
const OPEN_TODAY = { action: 'open-mac', label: 'Open in VS Code', sub: 'Brings this session forward on the Mac' };

test('an interactive session renders exactly its three rows', () => {
  for (const d of [waitDetail({ state: 'idle' }), waitDetail({ state: 'idle', background: false, handoff: null })]) {
    assert.deepEqual(actionRows(renderDetail(bgState(d), 'w')), [OPEN_TODAY, ...AUTO_AND_CHIME]);
    assert.equal(actionRowCount(d), 3);
  }
  assert.doesNotMatch(renderDetail(bgState(waitDetail({ state: 'idle' })), 'w'), /stop-session|handoff-/);
});

test('a background session on the Mac offers to move to a tab, and has a STOP row last', () => {
  const d = bgDetail();
  assert.deepEqual(actionRows(renderDetail(bgState(d), 'w')), [
    { action: 'open-mac', label: 'Open in VS Code', sub: 'Moves it to a tab on the Mac' },
    ...AUTO_AND_CHIME,
    { action: 'stop-session', label: 'STOP', sub: 'Ends this background session' },
  ]);
  assert.equal(actionRowCount(d), 4);
});

test('while it waits for the turn to end the open row says so and cancels, and OPEN NOW sits under it', () => {
  const d = bgDetail({ state: 'busy', handoff: 'waiting' });
  assert.deepEqual(actionRows(renderDetail(bgState(d), 'w')), [
    { action: 'handoff-cancel', label: 'OPENS IN VS CODE WHEN DONE', sub: 'Press to cancel' },
    { action: 'handoff-now', label: 'OPEN NOW', sub: 'Cuts the turn off and opens it now' },
    ...AUTO_AND_CHIME,
    { action: 'stop-session', label: 'STOP', sub: 'Ends this background session' },
  ]);
  assert.equal(actionRowCount(d), 5);
});

test('while it moves the open row says so, offers nothing, and there is no OPEN NOW', () => {
  const d = bgDetail({ handoff: 'moving' });
  const rows = actionRows(renderDetail(bgState(d), 'w'));
  assert.deepEqual(rows[0], { action: 'open-mac', label: 'OPENING IN VS CODE…', sub: null });
  assert.deepEqual(rows.map((r) => r.action), ['open-mac', 'toggle-auto-open', 'toggle-chime', 'stop-session']);
  assert.equal(actionRowCount(d), 4);
});

test('an armed STOP row says to press again; another session\'s arm does not', () => {
  const d = bgDetail();
  const armed = actionRows(renderDetail(bgState(d, { stopArmedFor: 'w' }), 'w')).pop();
  assert.equal(armed.action, 'stop-session');
  assert.equal(armed.label, 'PRESS AGAIN TO STOP');
  assert.match(renderDetail(bgState(d, { stopArmedFor: 'w' }), 'w'), /class="agrow macrow stoprow armed"/);
  const other = actionRows(renderDetail(bgState(d, { stopArmedFor: 'zz' }), 'w')).pop();
  assert.equal(other.label, 'STOP');
  assert.doesNotMatch(renderDetail(bgState(d, { stopArmedFor: 'zz' }), 'w'), /armed/);
});

test('a NucBox background session offers to move to a tab there, and has STOP last', () => {
  const d = bgDetail({ machine: 'NucBox' });
  assert.deepEqual(actionRows(renderDetail(bgState(d), 'w')), [
    { action: 'open-mac', label: 'Open in VS Code', sub: 'Moves it to a tab on the NucBox' },
    ...NUCBOX_AUTO_AND_CHIME,
    { action: 'stop-session', label: 'STOP', sub: 'Ends this background session' },
  ]);
  assert.equal(actionRowCount(d), 4);
});

test('the NucBox open row follows the move like the Mac\'s: waiting cancels, moving says so', () => {
  const waiting = actionRows(renderDetail(bgState(bgDetail({ machine: 'NucBox', state: 'busy', handoff: 'waiting' })), 'w'));
  assert.deepEqual(waiting.map((r) => r.action), ['handoff-cancel', 'handoff-now', 'toggle-auto-open', 'toggle-chime', 'stop-session']);
  const moving = actionRows(renderDetail(bgState(bgDetail({ machine: 'NucBox', handoff: 'moving' })), 'w'));
  assert.deepEqual(moving[0], { action: 'open-mac', label: 'OPENING IN VS CODE…', sub: null });
});

test('a NucBox VS Code session is brought forward on the NucBox', () => {
  const d = waitDetail({ state: 'idle', background: false, handoff: null, machine: 'NucBox' });
  const rows = actionRows(renderDetail(bgState(d), 'w'));
  assert.deepEqual(rows[0], { action: 'open-mac', label: 'Open in VS Code', sub: 'Brings this session forward on the NucBox' });
  assert.deepEqual(rows.map((r) => r.action), ['open-mac', 'toggle-auto-open', 'toggle-chime']);
  assert.equal(actionRowCount(d), 3);
});

// Found live (V5, 2026-11-07), on both machines: after STOP worked the view kept its STOP row.
test('an ended session shows no STOP or OPEN NOW row', () => {
  for (const over of [{}, { machine: 'NucBox' }, { handoff: 'waiting' }]) {
    const d = bgDetail({ ended: true, ...over });
    const html = renderDetail(bgState(d), 'w');
    const actions = actionRows(html).map((r) => r.action);
    assert.ok(!actions.includes('stop-session'), JSON.stringify(over));
    assert.ok(!actions.includes('handoff-now'), JSON.stringify(over));
    assert.doesNotMatch(html, /stoprow/, JSON.stringify(over));
    assert.equal(actionRowCount(d), actions.length, 'the knob walks the rows drawn: ' + JSON.stringify(over));
  }
});

test('an ended session keeps its other rows, and a live one still has STOP', () => {
  const ended = actionRows(renderDetail(bgState(bgDetail({ ended: true })), 'w')).map((r) => r.action);
  assert.deepEqual(ended, ['open-mac', 'toggle-auto-open', 'toggle-chime']);
  const live = actionRows(renderDetail(bgState(bgDetail({ ended: false })), 'w')).map((r) => r.action);
  assert.deepEqual(live, ['open-mac', 'toggle-auto-open', 'toggle-chime', 'stop-session']);
});

test('the rows the knob lands on follow the rows drawn, for a background session that is waiting', () => {
  const agent = { id: 'a1', description: 'Agent one', agentType: 'Explore', depth: 1, running: false };
  const d = bgDetail({ state: 'busy', handoff: 'waiting' });
  const rowAt = (agentSel) => {
    const html = renderDetail(detailState(d, { agentSel, chimeOn: true, subagents: { w: [agent] } }), 'w');
    const selected = html.match(/<div class="agrow[^"]*selected"[^>]*data-action="([^"]+)"/);
    return { n: (html.match(/agrow[^"]*selected/g) || []).length, action: selected && selected[1] };
  };
  const walk = [0, 1, 2, 3, 4, 5, 6].map((i) => rowAt(i).action);
  assert.deepEqual(walk, ['handoff-cancel', 'handoff-now', 'toggle-auto-open', 'toggle-chime', 'stop-session', 'open-agent', null]);
  assert.equal(rowAt(6).n, 0);
});

test('the subagent rows count after the three, four or five action rows', () => {
  const agent = { id: 'a1', description: 'Agent one', agentType: 'Explore', depth: 1, running: false };
  for (const [d, first] of [[waitDetail({ state: 'idle' }), 3], [bgDetail(), 4], [bgDetail({ handoff: 'waiting' }), 5]]) {
    const html = renderDetail(detailState(d, { agentSel: first, chimeOn: true, subagents: { w: [agent] } }), 'w');
    assert.match(html, /<div class="agrow[^"]*selected"[^>]*data-action="open-agent"/, 'row ' + first);
  }
});

test('actionRowCount counts what the page draws, and copes with no detail yet', () => {
  assert.equal(actionRowCount(undefined), 3);
  assert.equal(actionRowCount(null), 3);
  assert.equal(actionRowCount({ background: true, handoff: 'waiting' }), 5);
  assert.equal(actionRowCount({ background: false, handoff: 'waiting' }), 3);
});

test('a question from the NucBox says to answer it there, and offers no window to raise', () => {
  const html = renderQueue(baseState({ asks: [groupAsk({ machine: 'NucBox' })] }));
  assert.match(html, /ANSWER ON THE NUCBOX/);
  assert.doesNotMatch(html, /raises the window/);
});

test('session tiles from the NucBox say so', async () => {
  const { tileLabels } = await import('../src/screens/helpers.js');
  assert.deepEqual(tileLabels({ name: 'Fix bridge', project: 'bridge', machine: 'NucBox' }), { title: 'Fix bridge', subtitle: 'NucBox · bridge' });
  assert.deepEqual(tileLabels({ name: 'Fix bridge', project: 'bridge' }), { title: 'Fix bridge', subtitle: 'bridge' });
});

// ---- Task 13: the digest's strip and card in the session view, its line on the clock ----------------------

// A state for session 'a' with one 12-minute-old digest card, live in sessions, with its detail and messages.
function digestDetailState(cardOver = {}, over = {}) {
  const t = now() - 12 * 60_000;
  return baseState({
    sessions: [session({ id: 'a', state: 'busy' })],
    details: { a: { id: 'a', name: 'Recorder reopen', state: 'busy', tokens: { in: 1000, out: 2000 }, cacheRead: 0, context: null, model: 'claude-fable-5', cwd: '/tmp/proj', currentTool: null, lastMessage: 'ok' } },
    messages: { a: [{ role: 'user', text: 'hello', ts: 1 }, { role: 'assistant', text: 'Done.', ts: 2 }] },
    subagents: {}, messageStatus: {}, agentSel: -1, autoOpenOnMac: false,
    digest: { updatedTs: t, windowHours: 24, totals: { sessions: 1, turns: 1, commits: 0, prs: 0 }, cards: [{
      sessionId: 'a', title: 'Recorder reopen', ended: false, lastTurnTs: t, lines: [], lastReply: 'Done.', summary: null, ...cardOver,
    }] },
    ...over,
  });
}
function digestAmbientState({ ageMs = 12 * 60_000, ...cardOver } = {}, over = {}) {
  return baseState({
    sessions: [session({ id: 'a', state: 'busy' }), session({ id: 'b', state: 'idle' })], stats: { active: 1, attention: 0 },
    digest: { updatedTs: now(), windowHours: 24, totals: {}, cards: [{
      sessionId: 'a', title: 'Panel brightness tuning', ended: false, lastTurnTs: now() - ageMs, lines: [], lastReply: 'The dial now dims in 5% steps.', summary: null, ...cardOver,
    }] },
    ...over,
  });
}

test('the session strip sits between the top bar and the scrolling column, and is not part of it', () => {
  const html = renderDetail(digestDetailState(), 'a');
  const at = (s) => html.indexOf(s);
  assert.ok(at('class="topbar"') < at('class="dstrip"') && at('class="dstrip"') < at('id="dscroll"'));
  assert.equal(html.split('class="dstrip"').length, 2, 'once');
  assert.ok(html.slice(at('id="dscroll"')).indexOf('dstrip') === -1, 'not inside the column, where it would scroll away');
  assert.match(html, /<span class="clock">[^<]*<\/span><span class="conn ok"><\/span><\/div><div class="dstrip"><span class="lamp busy"><\/span><span class="dstext">&quot;Done\.&quot;<\/span><span class="dsage">12m<\/span><\/div><div class="dscroll" id="dscroll">/);
});

test('the session card follows the newest message, before Open in VS Code', () => {
  const html = renderDetail(digestDetailState({ lastReply: 'Done.', lines: ['1 commit: fix: x'] }), 'a');
  const at = (s) => html.indexOf(s);
  assert.ok(at('id="cvend"') < at('class="dcard"') && at('class="dcard"') < at('Open in VS Code'));
  assert.ok(at('Hold the top button') < at('id="cvend"'), 'the hint is still under the newest message');
  assert.match(html, /FACTS · 12m/);
  assert.equal(html.split('class="dcard"').length, 2, 'once');
  // Right after the conversation's closing tag, right before the Open in VS Code rows.
  assert.match(html, /<div id="cvend"><\/div><\/div><div class="dcard">.*<\/div><div class="aglist macrows">/);
  // One column: the card is inside it, so the knob reaches it.
  assert.ok(at('id="dscroll"') < at('class="dcard"'));
});

test('no strip and no card without a reply, a card, or a Mac session: the view is what it was', () => {
  const noReply = renderDetail(digestDetailState({ lastReply: '', lines: [] }), 'a');
  assert.doesNotMatch(noReply, /dstrip|dcard/);
  // Facts but no reply: the card, not the strip.
  const factsOnly = renderDetail(digestDetailState({ lastReply: '', lines: ['1 commit: fix: x'] }), 'a');
  assert.doesNotMatch(factsOnly, /dstrip/);
  assert.match(factsOnly, /class="dcard"/);
  // A NucBox session: its detail carries machine, so the Mac's digest is not its card.
  const nucbox = digestDetailState({ lines: ['l'] });
  nucbox.details.a.machine = 'NucBox';
  assert.doesNotMatch(renderDetail(nucbox, 'a'), /dstrip|dcard/);
  // The strip and the card read the same state the view does.
  const html = renderDetail(digestDetailState({ lines: ['l'] }), 'a');
  assert.ok(html.includes(sessionStrip(digestDetailState({ lines: ['l'] }), 'a')));
  assert.ok(html.includes(sessionCard(digestDetailState({ lines: ['l'] }), 'a')));
});

// What the view draws without the digest's strip and card, written from renderers that have none (the commit before
// Task 13, then main's at the merge of 68037e6; test/fixtures/digest-guard.json; the states and the recipe are in
// test/fixtures/digest-guard-cases.js). Every state with
// nothing for the digest to add must still draw exactly that.
const GUARD = JSON.parse(readFileSync(new URL('./fixtures/digest-guard.json', import.meta.url), 'utf8'));

test('the session view is byte-for-byte what it was when the digest has nothing to add', () => {
  const cases = detailCases();
  assert.deepEqual(Object.keys(cases), Object.keys(GUARD.detail), 'every state has its fixture');
  assert.ok(Object.keys(cases).length >= 6);
  for (const [name, state] of Object.entries(cases)) assert.equal(blankClock(renderDetail(state, 'a')), GUARD.detail[name], name);
});

test('the strip and the card are the only difference a digest card makes to the session view', () => {
  // The same state with and without the card: take the strip and the card out of the first and nothing else is left.
  const withIt = digestDetailState({ lines: ['1 commit: fix: x'] });
  const without = { ...withIt, digest: null };
  const html = renderDetail(withIt, 'a');
  const stripped = html.replace(sessionStrip(withIt, 'a'), '').replace(sessionCard(withIt, 'a'), '');
  assert.notEqual(stripped, html);
  assert.equal(blankClock(stripped), blankClock(renderDetail(without, 'a')));
});

test('the ambient line sits under the fleet lamps, above the token count, and is not tappable', () => {
  const html = renderAmbient(digestAmbientState());
  const at = (s) => html.indexOf(s);
  assert.match(html, /class="adigest">12m · Panel brightness tuning — &quot;/);
  assert.ok(at('class="fleet"') < at('class="adigest"') && at('class="adigest"') < at('class="tokens"'));
  assert.match(html, /<\/div><div class="adigest">[^<]*<\/div><div class="tokens">/);
  assert.equal(html.split('data-action=').length, 2, 'the one tap target is still the mascot switch');
  assert.match(html, /^<div class="screen ambient" data-action="mascot-toggle">/);
  assert.ok(html.includes(ambientLine(digestAmbientState())));
  // Without lamps the line still goes where the lamps would end: after the status line.
  const bare = renderAmbient(digestAmbientState({}, { sessions: [], stats: { active: 0, attention: 0 } }));
  assert.ok(bare.indexOf('RESTING') < bare.indexOf('class="adigest"') && bare.indexOf('class="adigest"') < bare.indexOf('class="tokens"'));
});

test('the ambient line shows the newest card, and hides while anything waits or when nothing finished in 12 h', () => {
  assert.match(renderAmbient(digestAmbientState()), /class="adigest">12m · Panel brightness tuning — &quot;/);
  assert.doesNotMatch(renderAmbient(digestAmbientState({}, { asks: [{ id: 'k' }] })), /adigest/);
  assert.doesNotMatch(renderAmbient(digestAmbientState({ ageMs: 13 * 3600e3 })), /adigest/);
  const text = ambientLine(digestAmbientState({ lastReply: 'x'.repeat(200) })).replace(/<[^>]+>/g, '').replace(/&quot;/g, '"');
  assert.ok(text.length <= 65);
  // The alarm is untouched while something waits: the same words, and no line.
  const waiting = renderAmbient(digestAmbientState({}, { asks: [{ id: 'k1' }, { id: 'k2' }] }));
  assert.match(waiting, /class="ahead blocked">2 NEED YOU/);
  assert.match(waiting, /press dial to answer/);
});

test('the clock screen is byte-for-byte what it was when the digest has nothing to say', () => {
  const cases = ambientCases();
  assert.deepEqual(Object.keys(cases), Object.keys(GUARD.ambient), 'every state has its fixture');
  assert.ok(Object.keys(cases).length >= 6);
  for (const [name, state] of Object.entries(cases)) assert.equal(blankClock(renderAmbient(state)), GUARD.ambient[name], name);
});

test('the ambient line is the only difference a fresh card makes to the clock screen', () => {
  const withIt = digestAmbientState();
  const html = renderAmbient(withIt);
  const stripped = html.replace(ambientLine(withIt), '');
  assert.notEqual(stripped, html);
  assert.equal(blankClock(stripped), blankClock(renderAmbient({ ...withIt, digest: null })));
});

test('hostile digests never break the session view or the clock screen', () => {
  const hostile = [undefined, null, 0, 'x', [], {}, { cards: null }, { cards: 'x' }, { cards: [null, 1, {}, { sessionId: 'a', title: {}, lastReply: [], lines: 'x', lastTurnTs: 'x' }] },
    { cards: [{ sessionId: 'a', title: '<img src=x onerror=alert(1)>', lastReply: '<img src=x onerror=alert(1)>', lines: ['<img src=x onerror=alert(1)>'], lastTurnTs: now() - 60_000 }] },
    { cards: [{ sessionId: 'a', title: 'x'.repeat(100 * 1024), lastReply: 'y'.repeat(100 * 1024), lines: ['z'.repeat(100 * 1024)], lastTurnTs: now() - 60_000 }] }];
  for (const d of hostile) {
    const detailHtml = renderDetail(digestDetailState({}, { digest: d }), 'a');
    const ambientHtml = renderAmbient(digestAmbientState({}, { digest: d }));
    assert.ok(!detailHtml.includes('<img') && !ambientHtml.includes('<img'), 'no injected tag');
    assert.ok(detailHtml.length < 20_000 && ambientHtml.length < 5_000, 'bounded');
    assert.match(detailHtml, /id="cvend"/);
    assert.match(ambientHtml, /class="tokens"/);
  }
});
