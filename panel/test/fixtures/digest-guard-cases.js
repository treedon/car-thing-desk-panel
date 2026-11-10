// The states behind digest-guard.json: what renderDetail and renderAmbient drew BEFORE Task 13 added the digest's
// strip, card and line, for every state in which they must still draw exactly that (no digest, no card for the
// session, a NucBox session, nothing waiting to be said, an ambient screen that must stay quiet). digest-guard.json was
// written by running the renderers of the commit before Task 13 on these states, and is never rewritten from the
// current code: if a case here changes, the fixture for it has to be made again from a renderer that predates the change.
//
// At the merge of main 68037e6 it was made again from main's renderers (no digest; main added the session view's
// chime row), the same way list-state.js's recipe makes list-before.json: `git archive <commit> panel/src
// panel/package.json` into a temp folder, import renderDetail and renderAmbient from there and the cases from here,
// and write { detail: { name: blankClock(renderDetail(state, 'a')) }, ambient: { name: blankClock(renderAmbient(state)) } }
// as JSON.stringify(..., null, 2) + '\n'. Run on the commit before Task 13 (445b647) that recipe gives the earlier
// file byte for byte.
//
// Two later edits by hand, not from a renderer, both to 'a NucBox session with the same id as a card' and nothing to
// do with the digest. The open row of a NucBox session that is not a background one used to say "Brings this session
// forward on the Mac" and now says "...on the NucBox" (new-session-nucbox Task 5). The "Open automatically" row's
// sub-label (Off) used to say "Checking in here leaves the Mac alone" and now says "...leaves the NucBox alone"
// (new-session-nucbox final fixes). Each time that one string was changed to match.
//
// The clock (the top bar's, the ambient screen's big one) is the one thing that changes from run to run, so both
// sides blank it (see blankClock).
import { now } from '../../src/clock.js';

export const blankClock = (html) => html.replace(/(<span class="clock">)[^<]*(<\/span>)/, '$1$2').replace(/(<div class="bigclock">)[^<]*(<\/div>)/, '$1$2');

const detail = (over = {}) => ({
  id: 'a', name: 'Recorder reopen', project: 'car-thing', state: 'busy', ended: false,
  tokens: { in: 266000, out: 54000 }, cacheRead: 16500000, context: 0.42, model: 'claude-fable-5', cwd: '/tmp/proj',
  currentTool: 'Bash', lastMessage: 'Working on the recorder.', permission: null,
  ...over,
});
const messages = [
  { role: 'user', text: 'Make the recorder reopen after resume', ts: 1 },
  { role: 'assistant', text: 'Done. **The recorder** now reopens.\n\n- one\n- two', ts: 2 },
  { role: 'tool', text: 'Bash: npm test', ts: 3 },
];
const subagents = [{ id: 'g1', description: 'Check the tests', agentType: 'Explore', depth: 1, running: false, startedTs: 1000, lastActivityTs: 61000 }];
const card = (over = {}) => ({
  sessionId: 'a', title: 'Recorder reopen', project: 'car-thing', ended: false, lastTurnTs: now() - 12 * 60e3,
  facts: { turns: 3, files: 1, commits: 1, prs: 1, tests: { passed: 14, failed: 0, runs: 1 }, agents: { finished: 0, running: 0 } },
  lines: ['1 commit: fix: x'], lastReply: 'Done.', summary: null, behindTurns: 0,
  ...over,
});
const digest = (cards) => ({ updatedTs: now(), windowHours: 24, summarizer: { state: 'off', model: null, lastOkTs: null }, totals: { sessions: 1, turns: 3, commits: 1, prs: 1, testRuns: 1 }, cards });

const detailBase = (over = {}) => ({
  sessions: [{ id: 'a', state: 'busy', ended: false, name: 'Recorder reopen', tokens: { in: 1, out: 2 } }], stats: { active: 1, attention: 0 },
  details: { a: detail() }, messages: { a: messages }, subagents: { a: subagents }, messageStatus: {}, agentSel: -1, autoOpenOnMac: false,
  asks: [], daemonConnected: true, ...over,
});

// renderDetail(state, 'a')
export function detailCases() {
  return {
    'no digest field': detailBase(),
    'digest null': detailBase({ digest: null }),
    'digest of other sessions only': detailBase({ digest: digest([card({ sessionId: 'z' }), card({ sessionId: 'y', lastReply: 'x' })]) }),
    'a card with nothing to say': detailBase({ digest: digest([card({ lastReply: '', lines: [] })]) }),
    'a NucBox session with the same id as a card': detailBase({
      sessions: [{ id: 'a', state: 'busy', ended: false, machine: 'NucBox', name: 'Recorder reopen', tokens: { in: 1, out: 2 } }],
      details: { a: detail({ machine: 'NucBox' }) }, digest: digest([card()]),
    }),
    'loading, no detail yet': detailBase({ details: {}, digest: digest([card()]) }),
  };
}

const ambientBase = (over = {}) => ({
  sessions: [{ id: 'a', state: 'busy', tokens: { in: 1, out: 2000 } }, { id: 'b', state: 'idle', tokens: { in: 1, out: 500 } }],
  stats: { active: 1, attention: 0 }, details: {}, asks: [], daemonConnected: true, ...over,
});

// renderAmbient(state)
export function ambientCases() {
  return {
    'no digest field': ambientBase(),
    'digest null': ambientBase({ digest: null }),
    'digest with no cards': ambientBase({ digest: digest([]) }),
    'something waiting, a fresh card': ambientBase({ asks: [{ id: 'k' }], digest: digest([card()]) }),
    'only a card 13 hours old': ambientBase({ digest: digest([card({ lastTurnTs: now() - 13 * 3600e3 })]) }),
    'no sessions at all': ambientBase({ sessions: [], stats: { active: 0, attention: 0 }, digest: digest([card({ lastTurnTs: now() - 20 * 3600e3 })]) }),
  };
}
