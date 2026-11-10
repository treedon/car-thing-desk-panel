// The sessions screen's states for Task 14's guard (list-before.json) and for digest-list.test.js.
//
// list-before.json is what renderList drew for these states BEFORE Task 14 put the digest's first card on
// the sessions screen: it was written by running the renderer of commit 84042d5 (the commit before Task 14)
// on them, and is never rewritten from the current code. Every state here has no digest card, and with no
// card the screen must still be exactly that, for the merged list too (session e is the NucBox's, tagged
// machine: 'NucBox' as ws-mux.js tags it). renderList keeps the scroll position between calls, so a case is
// a sequence of states drawn in order from a reset (an empty list), and the fixture holds every step.
//
// The clock in the top bar is the one thing that changes from run to run, so both sides blank its text (and see
// noClock for the grid's hint).
// Nothing here imports the panel's code, so the file works next to any copy of it (the recipe below).
//
// Regenerating (after a merge brings in a renderer that changes the tiles, as main's waiting line may):
// make the fixture again from a renderList that has the merge's tile changes and NOT Task 14's card, i.e.
// from the other side of the merge (main), never from the merged code. From the repository root, with
// <commit> that renderer's commit (for the merge with main: main's tip):
//
//   SRC=$(mktemp -d) && git archive <commit> panel/src panel/package.json | tar -x -C "$SRC" && \
//   node --input-type=module -e "import fs from 'node:fs'; \
//     const { renderList } = await import('$SRC/panel/src/screens/session-list.js'); \
//     const { guardOutputs } = await import('./panel/test/fixtures/list-state.js'); \
//     fs.writeFileSync('panel/test/fixtures/list-before.json', JSON.stringify(guardOutputs(renderList), null, 1) + '\n')"
//
// then check `git diff panel/test/fixtures/list-before.json` shows only the tiles' own change, and say so in
// the merge's commit. (At the merge of main 68037e6 main's renderList drew these states byte for byte as
// 84042d5's did: its waiting line shows only for a session with waitingOn, which no state here has.)

const sess = (id, state, over = {}) => ({
  id, name: 'Session ' + id, state, model: 'claude-opus-5', effort: 'high', context: 0.42, ...over,
});

// Sessions a–e (busy, idle, attention, idle, busy; e on the NucBox), the cursor on `selectedIndex`.
export function listState(selectedIndex) {
  return {
    sessions: [sess('a', 'busy'), sess('b', 'idle'), sess('c', 'attention'), sess('d', 'idle'), sess('e', 'busy', { machine: 'NucBox' })],
    details: {}, asks: [], daemonConnected: true, selectedIndex,
  };
}

// Nine sessions, the last three on the NucBox: five columns, so the track scrolls and marks tiles off at both ends.
function nine(selectedIndex) {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
  const states = ['busy', 'idle', 'attention', 'idle', 'busy', 'idle', 'busy', 'attention', 'idle'];
  return {
    ...listState(selectedIndex),
    sessions: ids.map((id, i) => sess(id, states[i], i >= 6 ? { machine: 'NucBox' } : {})),
  };
}

// The sessions grid's HOLD TOP · NEW hint (the new-session flow) is the other deliberate addition to the top bar,
// made after list-before.json was written, so it is dropped on the current side as the clock is blanked: the guard
// still proves the tiles, the card and the empty screen are untouched, and new-session.test.js asserts the hint.
export const noClock = (html) => html.replace(/(<span class="clock">)[^<]*(<\/span>)/, '$1$2').replace(/<span class="thint">[^<]*<\/span>/, '');

// name -> the states drawn in order, from a reset.
export function guardCases() {
  const only = (from, to, sel) => ({ ...listState(sel), sessions: listState(0).sessions.slice(from, to) });
  return {
    'five, the first selected': [listState(0)],
    'five, the NucBox one selected': [listState(4)],
    'five, walked right and back': [0, 1, 2, 3, 4, 3, 2, 1, 0].map(listState),
    'nine, walked right and back': [0, 2, 4, 6, 8, 7, 5, 3, 1, 0].map(nine),
    'one session': [only(0, 1, 0)],
    'only the NucBox': [only(4, 5, 0)],
    'three, the third selected': [only(0, 3, 2)],
    'the Mac down': [{ ...listState(2), daemonConnected: false }],
    'a cursor past the end': [listState(7)],
    'no sessions': [{ ...listState(0), sessions: [] }],
    'no sessions, the Mac down': [{ ...listState(0), sessions: [], daemonConnected: false }],
    'sessions leave and come back': [listState(4), { ...listState(0), sessions: [] }, listState(4), listState(1)],
  };
}

// What `renderList` draws for every case, `over` laid onto every state (a digest, say), clocks blanked:
// { sel0, sel4, cases: { name: [html, ...] } }. sel0 and sel4 are the brief's two: five sessions, drawn
// from a reset with the cursor on the first and on the last.
export function guardOutputs(renderList, over = {}) {
  const reset = () => renderList({ ...listState(0), sessions: [] });
  const at = (i) => { reset(); return noClock(renderList({ ...listState(i), ...over })); };
  const cases = {};
  for (const [name, steps] of Object.entries(guardCases())) {
    reset();
    cases[name] = steps.map((s) => noClock(renderList({ ...s, ...over })));
  }
  return { sel0: at(0), sel4: at(4), cases };
}
