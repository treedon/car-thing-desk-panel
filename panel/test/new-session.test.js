// The new-session flow's screens and rules (screens/new-session.js): pick a
// machine, pick one of its five recent projects, check what was said, START.
// All pure, so the whole flow's logic is asserted here; main.js only wires it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  NEW_HINT, ASKS_REACH_PANEL, TRUST_FIRST, NO_PROJECTS, LISTED_WAIT_MS,
  machineRows, initialMachine, stepMachine, stepProject, lastUsedLabel, projectRows, projectPress, trustFirst,
  renderMachines, renderProjects, startedSessionId, checkLine, errorLabel,
  pressStart, startFailed, createStartWatch, createNewView, newView, hintFor,
  startOutcome, canReopenCheck, takePending, dropPending, MAY_HAVE_STARTED, msSinceInputAfter,
} from '../src/screens/new-session.js';
import { renderList } from '../src/screens/session-list.js';
import { topbar } from '../src/screens/helpers.js';

const MIN = 60e3;
const DAY = 86400e3;
const at = (...parts) => new Date(...parts).getTime();   // local time, like the panel's own

const MAC = { name: 'mac', label: 'mac', ready: true };
const NUCBOX = { name: 'nucbox', label: 'NucBox', ready: true };
const NUCBOX_DOWN = { ...NUCBOX, ready: false };

// ---- the machine screen -------------------------------------------------------

test('machineRows counts running sessions per machine and marks the unreachable', () => {
  const sessions = [{ machine: undefined, ended: false }, { machine: 'NucBox', ended: false }, { ended: true }];
  const rows = machineRows([MAC, NUCBOX_DOWN], sessions);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { name: 'mac', label: 'mac', ready: true, running: 1, status: '' });
  assert.equal(rows[1].name, 'nucbox');
  assert.equal(rows[1].running, 1);
  assert.equal(rows[1].status, 'NOT ANSWERING');
});

test('machineRows: a machine that rejected the request as unknown reads NOT SET UP YET, unless it is not answering', () => {
  const rows = machineRows([MAC, NUCBOX], [], { nucbox: true });
  assert.equal(rows[0].status, '');
  assert.equal(rows[1].status, 'NOT SET UP YET');
  assert.equal(machineRows([MAC, NUCBOX_DOWN], [], { nucbox: true })[1].status, 'NOT ANSWERING');
});

test('machineRows lists only the machines it is given: no NucBox configured, just the Mac', () => {
  const rows = machineRows([MAC], [{ machine: 'NucBox', ended: false }]);
  assert.deepEqual(rows.map((r) => r.name), ['mac']);
  assert.equal(rows[0].running, 0);
  assert.deepEqual(machineRows([], []), []);
});

test('initialMachine prefers the last used machine if it is ready, else the first ready one', () => {
  const both = machineRows([MAC, NUCBOX], []);
  assert.equal(initialMachine(both, 'nucbox'), 1);
  assert.equal(initialMachine(both, 'mac'), 0);
  assert.equal(initialMachine(both, undefined), 0);
  assert.equal(initialMachine(both, 'gone'), 0);
  const down = machineRows([MAC, NUCBOX_DOWN], []);
  assert.equal(initialMachine(down, 'nucbox'), 0, 'not answering: not chosen');
  const macDown = machineRows([{ ...MAC, ready: false }, NUCBOX], []);
  assert.equal(initialMachine(macDown, 'mac'), 1, 'the first ready one');
  const notSetUp = machineRows([MAC, NUCBOX], [], { mac: true });
  assert.equal(initialMachine(notSetUp, 'mac'), 1, 'not set up: not chosen');
  assert.equal(initialMachine(machineRows([{ ...MAC, ready: false }], []), 'mac'), 0, 'nothing ready: row 0, which a press refuses');
  assert.equal(initialMachine([], 'mac'), 0);
});

test('stepMachine turns past the rows that cannot be chosen, and stops at the ends', () => {
  const rows = machineRows([MAC, NUCBOX_DOWN, { name: 'z', label: 'Z', ready: true }], []);
  assert.equal(stepMachine(rows, 0, 1), 2, 'skips the one not answering');
  assert.equal(stepMachine(rows, 2, -1), 0);
  assert.equal(stepMachine(rows, 2, 1), 2, 'the end');
  assert.equal(stepMachine(rows, 0, -1), 0);
  assert.equal(stepMachine(machineRows([MAC, NUCBOX_DOWN], []), 0, 1), 0, 'nothing further to choose');
  assert.equal(stepMachine([], 0, 1), 0);
});

test('renderMachines: NEW SESSION, WHERE?, one row per machine, the cursor row selected', () => {
  const view = { ...createNewView(), machines: [MAC, NUCBOX], cursor: 1 };
  const html = renderMachines({ daemonConnected: true, sessions: [{ ended: false }, { machine: 'NucBox', ended: false }, { machine: 'NucBox', ended: false }] }, view);
  assert.match(html, /NEW SESSION/);
  assert.match(html, /WHERE\?/);
  assert.equal((html.match(/data-action="ns-machine"/g) || []).length, 2);
  assert.equal((html.match(/nsrow[^"]*selected/g) || []).length, 1);
  assert.match(html, /MAC/);
  assert.match(html, /NUCBOX/);
  assert.doesNotMatch(html, /NucBox/, 'labels show upper-cased');
  assert.match(html, /1 RUNNING/);
  assert.match(html, /2 RUNNING/);
  const selectedAt = html.indexOf('selected');
  assert.ok(selectedAt > html.indexOf('MAC') && html.indexOf('NUCBOX') > selectedAt, 'the second row is the selected one');
  assert.doesNotMatch(html, /disabled/);
});

test('renderMachines: a machine that is not answering is dimmed and says so', () => {
  const view = { ...createNewView(), machines: [MAC, NUCBOX_DOWN], cursor: 0 };
  const html = renderMachines({ daemonConnected: true, sessions: [] }, view);
  const rows = html.split('data-action="ns-machine"').slice(1);
  assert.doesNotMatch(html, /nsrow[^"]*disabled[^"]*" data-action="ns-machine" data-id="0"/);
  assert.match(html, /nsrow[^"]*disabled[^"]*" data-action="ns-machine" data-id="1"/);
  assert.match(rows[1], /NOT ANSWERING/);
  assert.doesNotMatch(rows[1], /RUNNING/);
  assert.match(renderMachines({ daemonConnected: true, sessions: [] },
    { ...createNewView(), machines: [MAC, NUCBOX], notSetUp: { nucbox: true } }), /NOT SET UP YET/);
});

test('renderMachines escapes what a machine is called', () => {
  const html = renderMachines({ daemonConnected: true, sessions: [] },
    { ...createNewView(), machines: [{ name: 'x', label: '<b>x</b>', ready: true }] });
  assert.ok(!html.includes('<b>'));
});

// ---- when a project was last used ----------------------------------------------

test('lastUsedLabel: NOW under an hour, TODAY, YESTERDAY, then a date', () => {
  const now = at(2026, 10, 7, 12);
  assert.equal(lastUsedLabel(now - 59 * MIN, now), 'NOW');
  assert.equal(lastUsedLabel(now, now), 'NOW');
  assert.equal(lastUsedLabel(now + 5 * MIN, now), 'NOW', 'a clock a little ahead is not a negative age');
  assert.equal(lastUsedLabel(now - 61 * MIN, now), 'TODAY');
  assert.equal(lastUsedLabel(at(2026, 10, 7, 0, 5), now), 'TODAY');
  assert.equal(lastUsedLabel(at(2026, 10, 6, 23, 59), now), 'YESTERDAY');
  assert.equal(lastUsedLabel(at(2026, 10, 6, 0, 5), now), 'YESTERDAY');
  assert.equal(lastUsedLabel(at(2026, 10, 5, 23, 59), now), 'NOV 5');
  assert.equal(lastUsedLabel(at(2026, 10, 1, 9), now), 'NOV 1');
  assert.equal(lastUsedLabel(at(2026, 9, 30, 9), now), 'OCT 30');
});

test('lastUsedLabel changes at midnight, not 24 hours after', () => {
  const justAfterMidnight = at(2026, 10, 7, 0, 30);
  assert.equal(lastUsedLabel(at(2026, 10, 6, 23, 50), justAfterMidnight), 'NOW');
  assert.equal(lastUsedLabel(at(2026, 10, 6, 22, 0), justAfterMidnight), 'YESTERDAY');
  assert.equal(lastUsedLabel(at(2026, 10, 5, 22, 0), justAfterMidnight), 'NOV 5');
});

test('lastUsedLabel reads the days in the Mac\'s time when it is given the offset (the device itself runs UTC)', () => {
  // 03:00 UTC on Nov 7 is 23:00 on Nov 6 in New York (UTC-4: offset +240).
  const now = Date.UTC(2026, 10, 7, 3, 0);
  const lastUsed = Date.UTC(2026, 10, 6, 20, 0);   // 16:00 on Nov 6 there
  assert.equal(lastUsedLabel(lastUsed, now, 240), 'TODAY');
  assert.equal(lastUsedLabel(Date.UTC(2026, 10, 6, 1, 0), now, 240), 'YESTERDAY');   // 21:00 on Nov 5 there
});

test('lastUsedLabel without a usable time is blank', () => {
  assert.equal(lastUsedLabel(undefined, Date.now()), '');
  assert.equal(lastUsedLabel(NaN, Date.now()), '');
  assert.equal(lastUsedLabel('x', Date.now()), '');
});

// ---- the project screen ---------------------------------------------------------

const project = (name, lastUsed, over = {}) => ({ name, path: '/Users/owner/' + name, lastUsed, trusted: true, ...over });

test('projectRows: at most five, newest first as given, with the date label', () => {
  const now = at(2026, 10, 7, 12);
  const list = ['a', 'b', 'c', 'd', 'e', 'f'].map((n, i) => project(n, now - i * 3 * DAY));
  const rows = projectRows(list, now);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map((r) => r.name), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(rows[0].sub, 'NOW');
  assert.equal(rows[1].sub, 'NOV 4');
  assert.ok(rows.every((r) => r.disabled === false));
  assert.deepEqual(projectRows(null, now), []);
});

test('projectRows: a folder that is not trusted is dimmed, and says to trust it first in place of the date', () => {
  const now = at(2026, 10, 7, 12);
  const rows = projectRows([project('Mirror', now - 5 * MIN), project('Fresh', now - 5 * MIN, { trusted: false })], now);
  assert.equal(rows[0].disabled, false);
  assert.equal(rows[1].disabled, true);
  assert.equal(rows[1].sub, 'TRUST IT ON THE MAC FIRST');
  assert.equal(rows[1].sub, TRUST_FIRST);
});

test('projectPress: a trusted project opens dictation; one not trusted only says why', () => {
  const ok = project('Mirror', 1);
  assert.deepEqual(projectPress(ok), { open: ok });
  assert.deepEqual(projectPress(project('Fresh', 1, { trusted: false })), { toast: 'TRUST IT ON THE MAC FIRST' });
  assert.equal(projectPress(undefined), null);
});

test('an untrusted NucBox project says trust it on the NucBox', () => {
  const now = at(2026, 10, 7, 12);
  const fresh = project('Fresh', now - 5 * MIN, { trusted: false });
  assert.equal(projectRows([fresh], now, 0, 'nucbox')[0].sub, 'TRUST IT ON THE NUCBOX FIRST');
  assert.deepEqual(projectPress(fresh, 'nucbox'), { toast: 'TRUST IT ON THE NUCBOX FIRST' });
  assert.equal(errorLabel('not-trusted', 'nucbox'), 'TRUST IT ON THE NUCBOX FIRST');
  assert.equal(errorLabel(new Error('not-trusted'), 'nucbox'), 'TRUST IT ON THE NUCBOX FIRST');
  assert.equal(trustFirst('nucbox'), 'TRUST IT ON THE NUCBOX FIRST');
});

test('the Mac keeps its words', () => {
  const now = at(2026, 10, 7, 12);
  const fresh = project('Fresh', now - 5 * MIN, { trusted: false });
  for (const host of ['mac', undefined, null, '', 'other']) {
    assert.equal(projectRows([fresh], now, 0, host)[0].sub, 'TRUST IT ON THE MAC FIRST', String(host));
    assert.deepEqual(projectPress(fresh, host), { toast: 'TRUST IT ON THE MAC FIRST' }, String(host));
    assert.equal(errorLabel('not-trusted', host), 'TRUST IT ON THE MAC FIRST', String(host));
    assert.equal(trustFirst(host), 'TRUST IT ON THE MAC FIRST', String(host));
  }
  assert.equal(trustFirst(), TRUST_FIRST);
});

test('a trusted NucBox project, and the other errors, read the same on either machine', () => {
  const now = at(2026, 10, 7, 12);
  const ok = project('Mirror', now - 5 * MIN);
  assert.equal(projectRows([ok], now, 0, 'nucbox')[0].sub, 'NOW');
  assert.deepEqual(projectPress(ok, 'nucbox'), { open: ok });
  for (const host of ['mac', 'nucbox']) {
    assert.equal(errorLabel(new Error('Unknown method'), host), 'NOT SET UP YET');
    assert.equal(errorLabel(new Error('start-failed'), host), 'START FAILED');
    assert.equal(errorLabel(new Error('socket closed'), host), 'NOT ANSWERING');
  }
});

test('renderProjects says trust it on the NucBox for the NucBox\'s untrusted folders, and on the Mac for the Mac\'s', () => {
  const view = (host, over = {}) => ({ ...createNewView(), machines: [MAC, NUCBOX], host, loading: false,
    projects: [project('Fresh', Date.now() - 5 * MIN, { trusted: false })], ...over });
  assert.match(renderProjects({ daemonConnected: true }, view('nucbox')), /TRUST IT ON THE NUCBOX FIRST/);
  assert.match(renderProjects({ daemonConnected: true }, view('mac')), /TRUST IT ON THE MAC FIRST/);
  assert.match(renderProjects({ daemonConnected: true }, view('nucbox', { projects: [], error: 'not-trusted' })), /TRUST IT ON THE NUCBOX FIRST/);
});

test('main.js passes the view\'s host to the project press and the screens read it for the rows and the error', () => {
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(main, /projectPress\(newView\.projects\[index\], newView\.host\)/);
  const src = readFileSync(new URL('../src/screens/new-session.js', import.meta.url), 'utf8');
  assert.match(src, /projectRows\(view\.projects, now\(\), tzOffset\(\), view\.host\)/);
  assert.match(src, /errorLabel\(view\.error, view\.host\)/);
});

test('renderProjects: NEW SESSION · MAC, AUTO MODE, up to five rows with name and when', () => {
  const view = { ...createNewView(), machines: [MAC, NUCBOX], host: 'mac', cursor: 0, loading: false,
    projects: ['Mirror', 'Notes', 'Site', 'Dots', 'Garden', 'Extra'].map((n, i) => project(n, Date.now() - (i === 0 ? 5 * MIN : (i + 3) * DAY))) };
  const html = renderProjects({ daemonConnected: true }, view);
  assert.match(html, /NEW SESSION · MAC/);
  assert.match(html, /AUTO MODE/);
  assert.equal((html.match(/data-action="ns-project"/g) || []).length, 5);
  assert.match(html, /Mirror/);
  assert.match(html, /Garden/);
  assert.doesNotMatch(html, /Extra/);
  assert.match(html, /NOW/);
  assert.match(html, /[A-Z]{3} \d{1,2}/);
  assert.equal((html.match(/nsrow[^"]*selected/g) || []).length, 1);
  assert.doesNotMatch(html, /disabled/);
});

test('renderProjects names the other machine in upper case', () => {
  const view = { ...createNewView(), machines: [MAC, NUCBOX], host: 'nucbox', projects: [project('x', Date.now())] };
  assert.match(renderProjects({ daemonConnected: true }, view), /NEW SESSION · NUCBOX/);
});

test('renderProjects: no projects says so, and offers no rows', () => {
  const view = { ...createNewView(), machines: [MAC], host: 'mac', projects: [] };
  const html = renderProjects({ daemonConnected: true }, view);
  assert.match(html, /NO RECENT PROJECTS ON THIS MACHINE/);
  assert.equal(NO_PROJECTS, 'NO RECENT PROJECTS ON THIS MACHINE');
  assert.doesNotMatch(html, /ns-project/);
});

test('renderProjects: loading, and a machine that did not answer, are said in words', () => {
  const base = { ...createNewView(), machines: [MAC], host: 'mac' };
  assert.match(renderProjects({ daemonConnected: true }, { ...base, loading: true }), /LOADING/);
  assert.doesNotMatch(renderProjects({ daemonConnected: true }, { ...base, loading: true }), /NO RECENT PROJECTS/);
  const html = renderProjects({ daemonConnected: true }, { ...base, error: 'not-answering' });
  assert.match(html, /NOT ANSWERING/);
  assert.doesNotMatch(html, /NO RECENT PROJECTS/);
});

test('renderProjects: a request that timed out or lost its socket says NOT ANSWERING, never the method', () => {
  const base = { ...createNewView(), machines: [MAC], host: 'mac' };
  for (const error of ['timeout: claude.projects.recent', 'socket closed']) {
    const html = renderProjects({ daemonConnected: true }, { ...base, error });
    assert.match(html, /NOT ANSWERING/);
    assert.doesNotMatch(html, /claude\./);
  }
});

test('renderProjects: a project not trusted is drawn dimmed with the trust line in place of the date', () => {
  const view = { ...createNewView(), machines: [MAC], host: 'mac', cursor: 0,
    projects: [project('Mirror', Date.now() - 5 * MIN), project('Fresh', Date.now() - 5 * MIN, { trusted: false })] };
  const html = renderProjects({ daemonConnected: true }, view);
  const rows = html.split('data-action="ns-project"').slice(1);
  assert.equal(rows.length, 2);
  assert.match(html, /nsrow[^"]*disabled[^"]*" data-action="ns-project" data-id="1"/);
  assert.doesNotMatch(html.split('data-action="ns-project"')[0], /disabled/);
  assert.match(rows[1], /TRUST IT ON THE MAC FIRST/);
  assert.doesNotMatch(rows[1], /NOW/, 'the date is replaced, not added to');
  assert.match(rows[0], /NOW/);
  assert.doesNotMatch(rows[0], /TRUST/);
  // the dial walks onto it, and it still shows as the cursor row
  const onIt = renderProjects({ daemonConnected: true }, { ...view, cursor: 1 });
  assert.match(onIt, /nsrow[^"]*selected[^"]*" data-action="ns-project" data-id="1"/);
  assert.match(onIt, /nsrow[^"]*disabled[^"]*" data-action="ns-project" data-id="1"/);
});

test('renderProjects escapes folder names', () => {
  const view = { ...createNewView(), machines: [MAC], host: 'mac', projects: [project('<img src=x>', Date.now())] };
  const html = renderProjects({ daemonConnected: true }, view);
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img'));
});

test('stepProject: the dial walks every row, including the ones not trusted, and stops at the ends', () => {
  assert.equal(stepProject(3, 0, 1), 1);
  assert.equal(stepProject(3, 2, 1), 2);
  assert.equal(stepProject(3, 0, -1), 0);
  assert.equal(stepProject(7, 4, 1), 4, 'only five are drawn');
  assert.equal(stepProject(0, 0, 1), 0);
});

// ---- after the session is started -------------------------------------------------

test('startedSessionId finds the session whose id starts with the short id', () => {
  const sessions = [{ id: '11111111-aaaa' }, { id: 'abcd1234-5678-9abc' }, { id: 'cd1234ab-0000' }];
  assert.equal(startedSessionId(sessions, 'abcd1234'), 'abcd1234-5678-9abc');
  assert.equal(startedSessionId(sessions, 'ffffffff'), null);
  assert.equal(startedSessionId([], 'abcd1234'), null);
  assert.equal(startedSessionId(undefined, 'abcd1234'), null);
});

test('startedSessionId matches nothing for an empty or missing short id', () => {
  const sessions = [{ id: 'abcd1234-5678' }, { id: undefined }];
  assert.equal(startedSessionId(sessions, ''), null);
  assert.equal(startedSessionId(sessions, undefined), null);
  assert.equal(startedSessionId(sessions, 12), null);
});

test('checkLine says what auto mode does with asks', () => {
  assert.equal(checkLine('Mirror', true), 'MIRROR · AUTO MODE · ASKS ON THE CAR THING');
  assert.equal(checkLine('Mirror', false), 'MIRROR · AUTO MODE');
});

test('asks do not reach the panel yet, so the check line promises only auto mode (R15)', () => {
  assert.equal(ASKS_REACH_PANEL, false);
  assert.equal(checkLine('Mirror', ASKS_REACH_PANEL), 'MIRROR · AUTO MODE');
});

test('errorLabel: the trust refusal has its own words, every known code is its text upper-cased', () => {
  assert.equal(errorLabel(new Error('not-trusted')), 'TRUST IT ON THE MAC FIRST');
  assert.equal(errorLabel(new Error('not-a-recent-project')), 'NOT A RECENT PROJECT');
  assert.equal(errorLabel(new Error('start-failed')), 'START FAILED');
  assert.equal(errorLabel(new Error('empty-prompt')), 'EMPTY PROMPT');
  assert.equal(errorLabel(new Error('prompt-too-long')), 'PROMPT TOO LONG');
  assert.equal(errorLabel(new Error('not-answering')), 'NOT ANSWERING');
  assert.equal(errorLabel(new Error('unknown-host')), 'UNKNOWN HOST');
  assert.equal(errorLabel('not-trusted'), 'TRUST IT ON THE MAC FIRST');
  assert.equal(errorLabel(new Error('Unknown method')), 'NOT SET UP YET');
});

test('errorLabel never shows a raw method name: a timeout or a closed socket is NOT ANSWERING', () => {
  for (const m of ['timeout: claude.session.start', 'timeout: claude.projects.recent', 'socket closed', 'socket not open', 'failed', '', undefined]) {
    const label = errorLabel(m === undefined ? undefined : new Error(m));
    assert.equal(label, 'NOT ANSWERING', String(m));
    assert.ok(!/claude\./i.test(label));
  }
  assert.equal(errorLabel('timeout: claude.session.start'), 'NOT ANSWERING');
  assert.equal(errorLabel(undefined), 'NOT ANSWERING');
});

test('startOutcome: the service\'s own refusals are known not to have started anything; anything else is unknown', () => {
  for (const code of ['not-answering', 'unknown-host', 'empty-prompt', 'prompt-too-long', 'not-a-recent-project', 'not-trusted', 'start-failed']) {
    assert.equal(startOutcome(new Error(code)), 'refused', code);
    assert.equal(startOutcome(code), 'refused', code + ' as a string');
  }
  assert.equal(startOutcome(new Error('Unknown method')), 'refused', 'a service that does not know the request ran nothing');
  for (const m of ['timeout: claude.session.start', 'socket closed', 'socket not open', 'something new', '']) {
    assert.equal(startOutcome(new Error(m)), 'unknown', m);
  }
  assert.equal(startOutcome(undefined), 'unknown');
  assert.equal(startOutcome(null), 'unknown');
});

test('start-unconfirmed (the service ran claude and cannot say it did not start) is an unknown outcome, never a refusal', () => {
  assert.equal(startOutcome(new Error('start-unconfirmed')), 'unknown');
  assert.equal(startOutcome('start-unconfirmed'), 'unknown');
  const view = createNewView();
  pressStart(view, () => {});
  const reopened = [];
  const label = startFailed(view, new Error('start-unconfirmed'), 'fix the build', (t) => reopened.push(t), FREE);
  assert.deepEqual(reopened, [], 'never reopens on its own, even with the owner free');
  assert.equal(label, 'MAY HAVE STARTED · CHECK THE LIST');
  assert.equal(view.starting, false);
  assert.deepEqual(view.pending, { host: 'mac', project: FREE.project, text: 'fix the build' }, 'the text waits for the next hold on the grid');
});

test('START is sent once', () => {
  const view = createNewView();
  let sent = 0;
  const send = () => { sent++; return new Promise(() => {}); };
  assert.equal(pressStart(view, send), true);
  assert.equal(view.starting, true);
  assert.equal(pressStart(view, send), false);
  assert.equal(pressStart(view, send), false);
  assert.equal(sent, 1);
});

// Where the owner is when a start fails: free (on the grid, nothing in their hand), the default here.
const FREE = { host: 'mac', project: { name: 'Mirror', path: '/m' }, dictating: false, routeName: 'list', msSinceInput: 5000, guardMs: 1000 };

test('a refused start reopens the check screen with the same text', () => {
  const view = createNewView();
  pressStart(view, () => {});
  assert.equal(view.starting, true);
  const reopened = [];
  const label = startFailed(view, new Error('not-trusted'), 'fix the build', (t) => reopened.push(t), FREE);
  assert.deepEqual(reopened, ['fix the build']);
  assert.equal(view.starting, false);
  assert.equal(view.pending, null, 'nothing is left pending: it is on screen');
  assert.equal(label, 'TRUST IT ON THE MAC FIRST', 'the words for the toast');
  let sent = 0;
  assert.equal(pressStart(view, () => { sent++; }), true, 'START works again');
  assert.equal(sent, 1);
});

test('a refused start toasts the trust words of the machine it was for', () => {
  const view = createNewView();
  assert.equal(startFailed(view, new Error('not-trusted'), 't', () => {}, { ...FREE, host: 'nucbox' }), 'TRUST IT ON THE NUCBOX FIRST');
  assert.equal(startFailed(view, new Error('not-trusted'), 't', () => {}, FREE), 'TRUST IT ON THE MAC FIRST');
});

test('a start that failed any other known way toasts its code', () => {
  const view = createNewView();
  assert.equal(startFailed(view, new Error('not-a-recent-project'), 't', () => {}, FREE), 'NOT A RECENT PROJECT');
  assert.equal(startFailed(view, new Error('start-failed'), 't', () => {}, FREE), 'START FAILED');
});

test('canReopenCheck: from the grid, the machines or the resting screen, with nothing being said and no hand on the panel', () => {
  const ok = { dictating: false, msSinceInput: 5000, guardMs: 1000 };
  for (const routeName of ['list', 'new', 'ambient']) assert.equal(canReopenCheck({ ...ok, routeName }), true, routeName);
  assert.equal(canReopenCheck({ ...ok, routeName: 'list', msSinceInput: 1000 }), true, 'exactly the guard');
});

test('canReopenCheck: never over a dictation, another screen, or a hand that just touched the panel', () => {
  const ok = { dictating: false, routeName: 'list', msSinceInput: 5000, guardMs: 1000 };
  assert.equal(canReopenCheck({ ...ok, dictating: true }), false, 'a dictation in progress');
  assert.equal(canReopenCheck({ ...ok, dictating: true, routeName: 'dictate' }), false);
  for (const routeName of ['dictate', 'prompt', 'ask', 'session', 'agent', 'queue', 'home', 'audio', 'tasks', 'digest', 'usage']) {
    assert.equal(canReopenCheck({ ...ok, routeName }), false, routeName);
  }
  assert.equal(canReopenCheck({ ...ok, msSinceInput: 999 }), false, 'inside the guard window');
  assert.equal(canReopenCheck({ ...ok, msSinceInput: 0 }), false);
  assert.equal(canReopenCheck({ ...ok, msSinceInput: undefined }), false, 'unknown is not long ago');
  assert.equal(canReopenCheck({ ...ok, msSinceInput: NaN }), false);
  assert.equal(canReopenCheck({ ...ok, guardMs: undefined }), false);
  assert.equal(canReopenCheck(undefined), false);
});

test('msSinceInputAfter: the press that started it does not count as a hand on the panel, only input after it', () => {
  assert.equal(msSinceInputAfter(1000, 1005, 1300), Infinity, 'the START press itself came before the request went');
  assert.equal(msSinceInputAfter(1005, 1005, 1300), Infinity);
  assert.equal(msSinceInputAfter(1100, 1005, 1300), 200, 'a dial turn after it does');
  assert.equal(msSinceInputAfter(0, 1005, 1300), Infinity, 'no input at all');
  assert.equal(canReopenCheck({ dictating: false, routeName: 'list', msSinceInput: msSinceInputAfter(1000, 1005, 1300), guardMs: 1000 }), true);
  assert.equal(canReopenCheck({ dictating: false, routeName: 'list', msSinceInput: msSinceInputAfter(1100, 1005, 1300), guardMs: 1000 }), false);
});

test('a refused start while the owner is elsewhere toasts why, reopens nothing, and keeps the text as a pending check', () => {
  const where = [
    { ...FREE, dictating: true, routeName: 'dictate' },
    { ...FREE, routeName: 'prompt' },
    { ...FREE, routeName: 'ask' },
    { ...FREE, routeName: 'session' },
    { ...FREE, msSinceInput: 300 },
  ];
  for (const ctx of where) {
    const view = createNewView();
    pressStart(view, () => {});
    const reopened = [];
    const label = startFailed(view, new Error('not-trusted'), 'fix the build', (t) => reopened.push(t), ctx);
    assert.deepEqual(reopened, [], JSON.stringify(ctx));
    assert.equal(label, 'TRUST IT ON THE MAC FIRST');
    assert.equal(view.starting, false, 'START works again');
    assert.deepEqual(view.pending, { host: 'mac', project: ctx.project, text: 'fix the build' });
  }
});

test('a start whose outcome is unknown (a timeout, a closed socket) is never offered again straight away', () => {
  for (const m of ['timeout: claude.session.start', 'socket closed']) {
    const view = createNewView();
    pressStart(view, () => {});
    const reopened = [];
    const label = startFailed(view, new Error(m), 'fix the build', (t) => reopened.push(t), FREE);
    assert.deepEqual(reopened, [], m + ': even with the owner free');
    assert.equal(label, 'MAY HAVE STARTED · CHECK THE LIST');
    assert.equal(MAY_HAVE_STARTED, 'MAY HAVE STARTED · CHECK THE LIST');
    assert.ok(!/claude\./.test(label));
    assert.equal(view.starting, false);
    assert.deepEqual(view.pending, { host: 'mac', project: FREE.project, text: 'fix the build' });
  }
});

test('a pending check is consumed by taking it, dropped by dropPending, and replaced by the next failure', () => {
  const view = createNewView();
  assert.equal(view.pending, null);
  assert.equal(takePending(view), null);
  startFailed(view, new Error('socket closed'), 'one', () => {}, FREE);
  startFailed(view, new Error('socket closed'), 'two', () => {}, { ...FREE, host: 'nucbox' });
  assert.deepEqual(view.pending, { host: 'nucbox', project: FREE.project, text: 'two' }, 'the latest replaces the earlier');
  assert.deepEqual(takePending(view), { host: 'nucbox', project: FREE.project, text: 'two' });
  assert.equal(view.pending, null, 'taken once');
  assert.equal(takePending(view), null);
  startFailed(view, new Error('socket closed'), 'three', () => {}, FREE);
  dropPending(view);
  assert.equal(view.pending, null);
  assert.equal(takePending(view), null);
  dropPending(view);   // nothing to drop is fine
});

test('a failure without a place to put the text back reopens nothing and keeps nothing pending', () => {
  const view = createNewView();
  const reopened = [];
  const label = startFailed(view, new Error('not-trusted'), 't', (x) => reopened.push(x));
  assert.deepEqual(reopened, []);
  assert.equal(view.pending, null);
  assert.equal(label, 'TRUST IT ON THE MAC FIRST');
});

// ---- watching for the new session in the list -------------------------------------

function fakeTimers() {
  const t = { next: 1, pending: {} };
  t.set = (fn, ms) => { const id = t.next++; t.pending[id] = { fn, ms }; return id; };
  t.clear = (id) => { delete t.pending[id]; };
  t.fire = () => { const ids = Object.keys(t.pending); ids.forEach((id) => { const p = t.pending[id]; delete t.pending[id]; p.fn(); }); };
  return t;
}

function watcher(over = {}) {
  const t = fakeTimers();
  const calls = { listed: [], timedOut: 0 };
  const w = createStartWatch({
    setTimer: t.set, clearTimer: t.clear,
    onListed: (id) => calls.listed.push(id), onTimeout: () => { calls.timedOut++; }, ...over,
  });
  return { w, t, calls };
}

test('the wait for the new session is 20 seconds', () => {
  assert.equal(LISTED_WAIT_MS, 20000);
  const { w, t } = watcher();
  w.start('abcd1234', []);
  assert.equal(Object.values(t.pending)[0].ms, 20000);
});

test('the watch opens the session when a later update lists it, and clears its timer', () => {
  const { w, t, calls } = watcher();
  w.start('abcd1234', [{ id: 'other' }]);
  assert.equal(w.active(), true);
  w.check([{ id: 'other' }]);
  assert.deepEqual(calls.listed, []);
  w.check([{ id: 'other' }, { id: 'abcd1234-ffff' }]);
  assert.deepEqual(calls.listed, ['abcd1234-ffff']);
  assert.equal(w.active(), false);
  assert.deepEqual(t.pending, {}, 'timer cleared');
  w.check([{ id: 'abcd1234-ffff' }]);
  assert.equal(calls.listed.length, 1, 'opened once');
  t.fire();
  assert.equal(calls.timedOut, 0);
});

test('the watch finds a session that is already listed when the start answers', () => {
  const { w, t, calls } = watcher();
  w.start('abcd1234', [{ id: 'abcd1234-ffff' }]);
  assert.deepEqual(calls.listed, ['abcd1234-ffff']);
  assert.equal(w.active(), false);
  assert.deepEqual(t.pending, {});
});

test('after 20 seconds with no match the watch says NOT LISTED YET, once, and is cleared', () => {
  const { w, t, calls } = watcher();
  w.start('abcd1234', []);
  t.fire();
  assert.equal(calls.timedOut, 1);
  assert.deepEqual(calls.listed, []);
  assert.equal(w.active(), false);
  w.check([{ id: 'abcd1234-ffff' }]);
  assert.deepEqual(calls.listed, [], 'a late listing is not followed');
});

test('a second start replaces the first watch; stop cancels it', () => {
  const { w, t, calls } = watcher();
  w.start('aaaaaaaa', []);
  w.start('bbbbbbbb', []);
  assert.equal(Object.keys(t.pending).length, 1);
  w.check([{ id: 'aaaaaaaa-1' }]);
  assert.deepEqual(calls.listed, [], 'the first one is no longer wanted');
  w.check([{ id: 'bbbbbbbb-1' }]);
  assert.deepEqual(calls.listed, ['bbbbbbbb-1']);
  w.start('cccccccc', []);
  w.stop();
  assert.deepEqual(t.pending, {});
  t.fire();
  assert.equal(calls.timedOut, 0);
  assert.equal(w.active(), false);
});

test('a start that answers with no short id is reported as not listed yet at once', () => {
  const { w, t, calls } = watcher();
  w.start(undefined, [{ id: 'x' }]);
  assert.equal(calls.timedOut, 1);
  assert.deepEqual(t.pending, {});
});

// ---- the sessions grid hint and the topbar ---------------------------------------------

const gridState = (over = {}) => ({
  sessions: [{ id: 'a', name: 'proj', state: 'idle', tokens: { in: 0, out: 0 }, lastActivityTs: Date.now() }],
  stats: { active: 0, attention: 0 }, details: {}, asks: [], usage: null, daemonConnected: true, selectedIndex: 0, ...over,
});

test('session list topbar shows the hint', () => {
  assert.equal(NEW_HINT, 'HOLD TOP · NEW');
  assert.match(renderList(gridState()), /HOLD TOP · NEW/);
  assert.match(renderList(gridState({ sessions: [] })), /HOLD TOP · NEW/, 'on the empty screen too');
  assert.match(renderList(gridState({ machineCount: 2 })), /HOLD TOP · NEW/);
});

test('the hint shows only while at least one machine is configured', () => {
  assert.equal(hintFor({ machineCount: 1 }), NEW_HINT);
  assert.equal(hintFor({}), NEW_HINT, 'unknown: the Mac is always there');
  assert.equal(hintFor({ machineCount: 0 }), '');
  assert.doesNotMatch(renderList(gridState({ machineCount: 0 })), /HOLD TOP/);
});

test('topbar: the optional hint sits on the right, and without one the output is what it always was', () => {
  const plain = topbar('SESSIONS', true, '3');
  assert.doesNotMatch(plain, /thint/);
  assert.equal(topbar('SESSIONS', true, '3', ''), plain);
  assert.equal(topbar('SESSIONS', true, '3', undefined), plain);
  const hinted = topbar('SESSIONS', true, '3', 'WHERE?');
  assert.match(hinted, /<span class="thint">WHERE\?<\/span>/);
  assert.ok(hinted.indexOf('spacer') < hinted.indexOf('thint') && hinted.indexOf('thint') < hinted.indexOf('sdots'));
  assert.equal(hinted.replace(/<span class="thint">WHERE\?<\/span>/, ''), plain);
  assert.ok(!topbar('X', true, '', '<b>').includes('<b>'), 'escaped');
});

// ---- the view -----------------------------------------------------------------------------

test('a new view starts empty, and views do not share their notSetUp marks', () => {
  const a = createNewView();
  assert.deepEqual(a, { cursor: 0, host: null, machines: [], projects: [], loading: false, error: null, starting: false, notSetUp: {}, pending: null });
  a.notSetUp.nucbox = true;
  assert.deepEqual(createNewView().notSetUp, {});
  assert.equal(typeof newView.cursor, 'number');
});

// ---- the CSS and the source are what the Car Thing's Chrome 69 can run ----------------------

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const source = readFileSync(new URL('../src/screens/new-session.js', import.meta.url), 'utf8');

test('the new screens have styles, including the dimmed row and the topbar hint', () => {
  for (const sel of ['.nslist', '.nsrow', '.nsrow.selected', '.nsrow.disabled', '.nsname', '.nssub', '.topbar .thint', '.dnote']) {
    assert.ok(css.includes(sel), sel + ' is styled');
  }
});

test('the new screens\' CSS avoids what Chrome 69 lacks (flex gap, inset:, clamp)', () => {
  const start = css.indexOf('/* ---- new session');
  assert.ok(start > 0, 'its own section');
  const block = css.slice(start).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(block, /(^|[\s;{])gap\s*:/m);
  assert.doesNotMatch(block, /(^|[\s;{])inset\s*:/m);
  assert.doesNotMatch(block, /clamp\(/);
});

test('new-session.js is written the Chrome 69 way: var and function, no arrows, no optional chaining', () => {
  const code = source.replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /=>/);
  assert.doesNotMatch(code, /\b(let|const)\s/);
  assert.doesNotMatch(code, /\?\./);
});

// ---- the press that starts is not followed by another that lands on the grid ------------------------------

test('START arms the input guard: the grid it lands on swallows the next second of presses', () => {
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const fn = main.slice(main.indexOf('function startNewSession('), main.indexOf('// The new session appears in the merged list'));
  const send = fn.slice(fn.indexOf('pressStart(newView, function () {'), fn.indexOf('ws.request('));
  assert.match(send, /nav\('#\/list'\)/, 'the callback is the one that goes to the grid');
  assert.match(send, /inputGuard\.arm\(\)/, 'a fast second press must not open the tile under the dial');
  assert.ok(send.indexOf("nav('#/list')") < send.indexOf('inputGuard.arm()'), 'armed once the grid is the screen');
});
