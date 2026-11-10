// What a press on a session view's action rows does, and what each answer says.
// Pure: main.js sends the request and shows the toast these decide.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  sessionRowPlan, requestToast, rejectedToast, resolutionToast, movesToVsCode, STOP_ARM_MS, switchPlan,
} from '../src/session-actions.js';

const bg = (over = {}) => ({ id: 's1', background: true, handoff: null, ...over });

test('Open in VS Code on a background session on the Mac asks the service to move it', () => {
  const plan = sessionRowPlan(bg(), 'open-mac', null);
  assert.equal(plan.method, 'claude.session.handoff');
  assert.equal(plan.focus, false);
  assert.equal(plan.toast, null, 'the answer says what happened');
});

test('Open in VS Code on an ordinary session raises its window, as it always did', () => {
  for (const d of [{ id: 's1' }, { id: 's1', background: false, handoff: null }]) {
    const plan = sessionRowPlan(d, 'open-mac', null);
    assert.equal(plan.method, null);
    assert.equal(plan.focus, true);
    assert.equal(plan.toast, 'OPENING ON THE MAC');
  }
});

test('a NucBox background session moves to VS Code', () => {
  assert.equal(movesToVsCode(bg({ machine: 'NucBox' })), true);
});

test('its open row sends the hand-off, and the answer says what happened', () => {
  const plan = sessionRowPlan(bg({ machine: 'NucBox' }), 'open-mac', null);
  assert.equal(plan.method, 'claude.session.handoff');
  assert.equal(plan.focus, false);
  assert.equal(plan.toast, null, 'the answer says what happened');
});

test('any background session moves to VS Code; one that is not, or not loaded, does not', () => {
  assert.equal(movesToVsCode(bg()), true);
  assert.equal(movesToVsCode({ id: 's1' }), false);
  assert.equal(movesToVsCode({ id: 's1', machine: 'NucBox' }), false);
  assert.equal(movesToVsCode(undefined), false);
});

test('a NucBox VS Code session is brought forward on the NucBox', () => {
  const plan = sessionRowPlan({ id: 's1', background: false, machine: 'NucBox' }, 'open-mac', null);
  assert.equal(plan.method, null);
  assert.equal(plan.focus, true);
  assert.equal(plan.toast, 'OPENING ON THE NUCBOX');
});

test('a press while it is moving sends nothing and says so', () => {
  const plan = sessionRowPlan(bg({ handoff: 'moving' }), 'open-mac', null);
  assert.equal(plan.method, null);
  assert.equal(plan.focus, false);
  assert.equal(plan.toast, 'OPENING IN VS CODE');
});

test('a press with the session not loaded yet falls back to raising it', () => {
  const plan = sessionRowPlan(undefined, 'open-mac', null);
  assert.equal(plan.focus, true);
  assert.equal(plan.method, null);
});

test('cancel and OPEN NOW are their own requests', () => {
  assert.equal(sessionRowPlan(bg({ handoff: 'waiting' }), 'handoff-cancel', null).method, 'claude.session.handoff.cancel');
  assert.equal(sessionRowPlan(bg({ handoff: 'waiting' }), 'handoff-now', null).method, 'claude.session.handoff.now');
});

test('OPEN NOW takes the cursor back to the open row, which the row under it is about to replace', () => {
  assert.equal(sessionRowPlan(bg({ handoff: 'waiting' }), 'handoff-now', null).cursor, 0);
  assert.equal(sessionRowPlan(bg({ handoff: 'waiting' }), 'handoff-cancel', null).cursor, null);
});

test('STOP arms on the first press and sends on the second', () => {
  const first = sessionRowPlan(bg(), 'stop-session', null, null, 1000);
  assert.equal(first.method, null, 'the first press ends nothing');
  assert.equal(first.arm, 's1');
  assert.equal(first.armUntil, 1000 + STOP_ARM_MS, 'the arm runs out');
  assert.equal(first.toast, null, 'the row itself says PRESS AGAIN TO STOP');
  const second = sessionRowPlan(bg(), 'stop-session', 's1', first.armUntil, 2000);
  assert.equal(second.method, 'claude.session.stop');
  assert.equal(second.arm, null, 'one stop per arming');
  assert.equal(second.armUntil, null);
});

test('the STOP arm lasts 4 s, like the panel\'s other destructive arms', () => {
  assert.equal(STOP_ARM_MS, 4000);
});

test('the second STOP press confirms until the arm runs out, and not after', () => {
  const until = 1000 + STOP_ARM_MS;
  assert.equal(sessionRowPlan(bg(), 'stop-session', 's1', until, 1001).method, 'claude.session.stop');
  assert.equal(sessionRowPlan(bg(), 'stop-session', 's1', until, until).method, 'claude.session.stop', 'the last moment still counts');
  const late = sessionRowPlan(bg(), 'stop-session', 's1', until, until + 1);
  assert.equal(late.method, null, 'an arm from a minute ago does not stop anything');
  assert.equal(late.arm, 's1', 'the press arms afresh instead');
  assert.equal(late.armUntil, until + 1 + STOP_ARM_MS);
});

test('an arm with no expiry on record does not count', () => {
  for (const until of [null, undefined, NaN, 'soon']) {
    const plan = sessionRowPlan(bg(), 'stop-session', 's1', until, 1000);
    assert.equal(plan.method, null, String(until));
    assert.equal(plan.arm, 's1');
  }
});

test('an arm left on another session does not count', () => {
  const plan = sessionRowPlan(bg(), 'stop-session', 'other', 9999, 1000);
  assert.equal(plan.method, null);
  assert.equal(plan.arm, 's1');
  assert.equal(plan.armUntil, 1000 + STOP_ARM_MS);
});

test('any other row clears the arm', () => {
  for (const action of ['open-mac', 'handoff-cancel', 'handoff-now', 'toggle-auto-open', 'toggle-chime', 'open-agent']) {
    const plan = sessionRowPlan(bg(), action, 's1', 9999, 1000);
    assert.equal(plan.arm, null, action);
    assert.equal(plan.armUntil, null, action);
  }
});

test('main.js ages the arm out in its one-second tick and hands the plan the clock', () => {
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const tick = main.slice(main.indexOf('setInterval(function () {'), main.indexOf('if (route().name ===', main.indexOf('setInterval(function () {')));
  assert.match(tick, /st\.stopArmedFor && nowMs > st\.stopArmedUntil/);
  assert.match(tick, /stopArmedFor: null, stopArmedUntil: null/);
  assert.match(main, /sessionRowPlan\(st\.details\[sessionId\], action, st\.stopArmedFor, st\.stopArmedUntil, Date\.now\(\)\)/);
  assert.match(main, /stopArmedFor: plan\.arm, stopArmedUntil: plan\.armUntil/);
});

test('a row that does nothing new leaves the cursor alone', () => {
  for (const action of ['open-mac', 'toggle-auto-open', 'toggle-chime', 'open-agent', 'stop-session']) {
    assert.equal(sessionRowPlan(bg(), action, null).cursor, null, action);
  }
});

test('each answer has its words', () => {
  const H = 'claude.session.handoff';
  assert.equal(requestToast(H, { result: 'opened' }), 'OPENING IN VS CODE');
  assert.equal(requestToast(H, { result: 'waiting' }), 'OPENS WHEN DONE');
  assert.equal(requestToast(H, { result: 'raised' }), 'OPENING ON THE MAC');
  assert.equal(requestToast('claude.session.stop', { result: 'stopped' }), 'STOPPED');
  assert.equal(requestToast('claude.session.handoff.cancel', { result: 'cancelled' }), 'CANCELLED');
});

test('opening on OPEN NOW says the same as opening', () => {
  assert.equal(requestToast('claude.session.handoff.now', { result: 'opened' }), 'OPENING IN VS CODE');
});

test('a refusal says what could not be done', () => {
  assert.equal(requestToast('claude.session.handoff', { result: 'failed' }), "COULDN'T OPEN IT");
  assert.equal(requestToast('claude.session.handoff.now', { result: 'failed' }), "COULDN'T OPEN IT");
  assert.equal(requestToast('claude.session.stop', { result: 'failed', reason: 'stop-failed' }), "COULDN'T STOP IT");
  assert.equal(requestToast('claude.session.handoff.cancel', { result: 'failed' }), "COULDN'T CANCEL IT");
});

test('an open that failed after the agent was stopped says so: it is stopped, VS Code has to be opened by hand', () => {
  for (const m of ['claude.session.handoff', 'claude.session.handoff.now']) {
    assert.equal(requestToast(m, { result: 'failed', reason: 'open-failed' }), 'STOPPED · OPEN IT IN VS CODE', m);
  }
  // Other reasons are still a plain refusal: nothing was stopped.
  for (const reason of ['stop-failed', 'stop-timeout', 'unknown-session', 'not-background', 'not-windowless', undefined]) {
    assert.equal(requestToast('claude.session.handoff', { result: 'failed', reason: reason }), "COULDN'T OPEN IT", String(reason));
    assert.equal(requestToast('claude.session.handoff.now', { result: 'failed', reason: reason }), "COULDN'T OPEN IT", String(reason));
  }
});

test('no-desktop says log in on the NucBox first: nothing was stopped', () => {
  for (const m of ['claude.session.handoff', 'claude.session.handoff.now']) {
    assert.equal(requestToast(m, { result: 'failed', reason: 'no-desktop' }), 'LOG IN ON THE NUCBOX FIRST', m);
  }
});

test('not-set-up says not set up yet', () => {
  for (const m of ['claude.session.handoff', 'claude.session.handoff.now']) {
    assert.equal(requestToast(m, { result: 'failed', reason: 'not-set-up' }), 'NOT SET UP YET', m);
  }
});

test('those two reasons are the hand-off\'s: a stop or a cancel that failed keeps its own words', () => {
  for (const reason of ['no-desktop', 'not-set-up']) {
    assert.equal(requestToast('claude.session.stop', { result: 'failed', reason }), "COULDN'T STOP IT", reason);
    assert.equal(requestToast('claude.session.handoff.cancel', { result: 'failed', reason }), "COULDN'T CANCEL IT", reason);
  }
});

// Found live (V5, 2026-11-07), on both machines: after STOP worked the service no longer knew the
// session, and the view's later presses said COULDN'T STOP IT.
test('STOP on a session already gone says already stopped', () => {
  assert.equal(requestToast('claude.session.stop', { result: 'failed', reason: 'unknown-session' }), 'ALREADY STOPPED');
  assert.equal(requestToast('claude.session.stop', { result: 'failed', reason: 'stop-failed' }), "COULDN'T STOP IT", 'other reasons keep their words');
  assert.equal(requestToast('claude.session.handoff', { result: 'failed', reason: 'unknown-session' }), "COULDN'T OPEN IT", 'only STOP reads it as stopped');
});

test('an answer that is no answer reads as a refusal, never as success', () => {
  assert.equal(requestToast('claude.session.handoff', null), "COULDN'T OPEN IT");
  assert.equal(requestToast('claude.session.handoff', {}), "COULDN'T OPEN IT");
  assert.equal(requestToast('claude.session.handoff', { result: 'nonsense' }), "COULDN'T OPEN IT");
  assert.equal(requestToast('claude.session.stop', undefined), "COULDN'T STOP IT");
});

test('a request that was rejected says the service is not answering', () => {
  assert.equal(rejectedToast(), 'NOT ANSWERING');
});

test('a background ask nobody answered in time says Claude will ask later', () => {
  assert.equal(resolutionToast('unavailable', false), 'CLAUDE WILL ASK LATER');
  assert.equal(resolutionToast('unavailable', true), 'CLAUDE WILL ASK LATER');
});

test('an ask abandoned because its agent was stopped is cleared quietly, never with a misleading toast', () => {
  assert.equal(resolutionToast('abandoned', true), null);
  assert.equal(resolutionToast('abandoned', false), null);
});

test('only a timeout keeps an expired card on screen; an abandoned permission is cleared like any resolved one', () => {
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const onResolved = main.slice(main.indexOf('function onResolved('), main.indexOf('// The daemon\'s whole waiting list'));
  assert.match(onResolved, /resolution === 'timeout' && store\.expireAsk/);
  assert.doesNotMatch(onResolved, /abandoned/, 'no special case: not expired, not an expired notice');
});

test('other resolutions keep their old behaviour: spoken on the ask screen, silent elsewhere', () => {
  assert.equal(resolutionToast('allow', true), 'ALLOW');
  assert.equal(resolutionToast('allow', false), null);
  assert.equal(resolutionToast('answered', false), null);
});

// ---- SWITCH on a queue card -------------------------------------------------------------------------
// "Same exact experiences" (owner, 2026-11-07): a NucBox card's SWITCH brings its session forward there, as
// a Mac card's does on the Mac. The NucBox's service raises only a session VS Code started, and never a
// background one, so the panel asks for every card alike.

test('SWITCH on a Mac card brings its session forward on the Mac', () => {
  assert.deepEqual(switchPlan({ sessionId: 's1' }), { focus: true, toast: 'OPENING ON THE MAC' });
});

test('SWITCH on a NucBox card brings its session forward on the NucBox', () => {
  assert.deepEqual(switchPlan({ sessionId: 's1', machine: 'NucBox' }), { focus: true, toast: 'OPENING ON THE NUCBOX' });
  // The words come from the machine's own label.
  assert.equal(switchPlan({ sessionId: 's1', machine: 'Studio' }).toast, 'OPENING ON THE STUDIO');
});

test('main.js SWITCH follows switchPlan, and no card is only told where to go any more', () => {
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const body = main.slice(main.indexOf('function switchToCard('), main.indexOf('function pressCard('));
  assert.match(body, /switchPlan\(card\)/);
  assert.match(body, /focusSession\(card\.sessionId\)/);
  assert.doesNotMatch(main, /OPEN IT ON THE/);
});

test('session-actions.js is written the Chrome 69 way: var and function, no arrows, no optional chaining', () => {
  const code = readFileSync(new URL('../src/session-actions.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /=>/);
  assert.doesNotMatch(code, /\b(let|const)\s/);
  assert.doesNotMatch(code, /\?\./);
});

test('every row the session view draws for a background session is wired to a tap in main.js', async () => {
  const { renderDetail } = await import('../src/screens/session-detail.js');
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const d = { id: 's1', name: 'bg', state: 'busy', background: true, handoff: 'waiting', tokens: { in: 0, out: 0 }, cacheRead: 0, waitingOn: [] };
  const html = renderDetail({
    sessions: [], details: { s1: d }, messages: { s1: [] }, subagents: {}, asks: [], agentSel: -1, chimeOn: true, daemonConnected: true,
  }, 's1');
  const actions = [...html.matchAll(/class="agrow macrow[^"]*" data-action="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(actions, ['handoff-cancel', 'handoff-now', 'toggle-auto-open', 'toggle-chime', 'stop-session']);
  for (const a of actions) assert.ok(main.includes("t.action === '" + a + "'"), a + ' is not in the tap delegation');
});
