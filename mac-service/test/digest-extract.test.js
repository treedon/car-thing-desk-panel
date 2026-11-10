// The transcript extractor: a session's records in, its closed turns and their facts out.
// Transcripts are synthetic (fixtures/digest/build.js); each line is pushed with the byte offset
// just past it, as the reader does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createExtractor } from '../src/digest/extract.js';
import { T, CWD, human, notice, asst, use, result, stopSummary, jsonl } from './fixtures/digest/build.js';
import { SECRETS } from './fixtures/digest/secrets.js';

const fx = (name) => fileURLToPath(new URL('./fixtures/digest/' + name, import.meta.url));

// Pushes each newline-terminated line ending after `after`, with its cumulative byte endOffset;
// a line that will not parse is pushed as null.
function pushLines(ex, text, after = 0) {
  let end = 0;
  for (const line of text.split('\n').slice(0, -1)) {
    end += Buffer.byteLength(line) + 1;
    if (end <= after || !line) continue;
    let record = null;
    try { record = JSON.parse(line); } catch {}
    ex.push(record, end);
  }
  return ex;
}
const feedText = (text, opts = {}) => pushLines(createExtractor({ sessionId: 'sess-1', ...opts }), text);
const feed = (records, opts) => feedText(jsonl(records), opts);
const run = (file, opts) => feedText(fs.readFileSync(fx(file), 'utf8'), opts);
const resume = (text, saved) => pushLines(createExtractor({ sessionId: saved.sessionId, saved }), text, saved.offset);

const turns = () => run('turns.jsonl').snapshot();
test('a turn is whatever ends at a stop_hook_summary, and records its trigger', () => {
  const f = turns(); assert.deepEqual(f.turns.map((t) => t.trigger), ['human', 'none', 'task-notification']);
  assert.deepEqual([f.totals.turns, f.title, f.project], [3, 'Digest fixture', 'proj']);
});
test('a task notification is not an owner prompt', () => {
  const f = turns(); assert.deepEqual([f.turns[2].intent.text, f.lastHumanPrompt.text], ['Make the dial dimmer', 'Make the dial dimmer']);
});
test('a turn with no human prompt is a continuation and borrows the last human prompt as its intent', () => {
  const [a, b] = turns().turns; assert.deepEqual([b.trigger, b.intent, a.intent.id], ['none', a.intent, 'P1']);
});
test('the final reply is the text of the turn\'s last assistant record with text', () => {
  assert.deepEqual(turns().turns[0].reply, { id: 'R1', text: 'Done. The dial now dims in 5% steps. Next: tests.' });
});
test('compaction summaries, meta lines and interrupt markers are never prompts; unknown and torn records are counted', () => {
  const f = run('messy.jsonl').snapshot(); assert.deepEqual([f.turns.length, f.skipped], [1, 2]); assert.ok(!JSON.stringify(f).includes('META-SENTINEL'));
});
test('the open turn is not in the snapshot, and the offset stops before it', () => {
  const lines = fs.readFileSync(fx('turns.jsonl'), 'utf8').split('\n');
  assert.equal(turns().offset, Buffer.byteLength(lines.slice(0, 11).join('\n') + '\n'));   // through the compact summary
});
test('prompts cap at 500 chars and replies at 1,200, redacted before the cap', () => {
  const [t] = feed([human('x'.repeat(495) + ' ' + SECRETS[0][1], 0), asst('y'.repeat(1500), 1), stopSummary(1)]).snapshot().turns;
  assert.ok(t.intent.text.length <= 500 && !t.intent.text.includes('sk-' + 'ant')); assert.equal(t.reply.text.length, 1200);
});
test('only the last six turns are kept; totals count every turn', () => {
  const recs = []; for (let i = 0; i < 8; i++) recs.push(human('p' + i, i * 2), asst('r' + i, i * 2 + 1), stopSummary(i * 2 + 1));
  const f = feed(recs).snapshot(); assert.deepEqual([f.turns.length, f.totals.turns, f.turns[0].intent.id], [6, 8, 'P3']);
});
test('without stop summaries a turn ends at the next owner prompt after end_turn, and closeOpenTurn closes the last', () => {
  const ex = run('fallback.jsonl'); assert.equal(ex.snapshot().turns.length, 1); ex.closeOpenTurn(); const f = ex.snapshot();
  assert.deepEqual([f.turns.length, f.lastTurnTs, f.offset], [2, Date.parse(T(6)), fs.statSync(fx('fallback.jsonl')).size]);
});
test('a session of task notifications only has turns but no human prompt', () => {
  const f = run('notify-only.jsonl').snapshot(); assert.deepEqual([f.hasHumanPrompt, f.turns[0].intent], [false, null]);
});
test('missing timestamps carry, future ones clamp, and a turn never ends before it starts', () => {   // Review Focus 4
  const now = Date.parse(T(30)); const noTs = asst('a', 0, 'tool_use'); delete noTs.timestamp;
  const f = feed([human('p', 10), noTs, asst('b', 99999), stopSummary(5)], { now: () => now }).snapshot();
  assert.equal(f.turns[0].startTs, Date.parse(T(10)));
  assert.ok(f.turns[0].endTs >= f.turns[0].startTs && f.lastTurnTs <= now);
});
test('a restart mid-turn reproduces ids and totals', () => {   // Review Focus 5
  const text = jsonl([human('p1', 0), asst('r1', 1), stopSummary(1), human('p2', 2), asst('w', 3, 'tool_use'), asst('r2', 4), stopSummary(4)]);
  const half = feedText(text.split('\n').slice(0, 5).join('\n') + '\n').snapshot();   // stops inside turn 2
  const resumed = resume(text, half);
  assert.deepEqual(resumed.snapshot(), feedText(text).snapshot());
  assert.deepEqual(resumed.snapshot().turns.map((t) => [t.intent.id, t.reply.id]), [['P1', 'R1'], ['P2', 'R2']]);
});

const row = (t) => [t.trigger, t.intent && t.intent.id, t.intent && t.intent.text, t.reply && t.reply.text];

test('a restart after a turn the next prompt closed reproduces the turns, ids and skipped count', () => {
  for (const gap of [[notice('Build finished', 2)], [notice('Build finished', 2), '{"type":"assis']]) {   // with and without a torn line
    const closed = jsonl([human('First', 0), asst('One.', 1), ...gap]);
    const head = closed + jsonl([human('Second', 3), asst('Two.', 4, 'tool_use')]), text = head + jsonl([stopSummary(5)]);
    const half = feedText(head).snapshot();
    assert.deepEqual([half.offset, half.skipped, half.turns.map(row)], [Buffer.byteLength(closed), gap.length - 1, [['human', 'P1', 'First', 'One.']]]);
    const f = resume(text, half).snapshot();
    assert.deepEqual(f, feedText(text).snapshot());
    assert.deepEqual([f.offset, f.skipped, f.turns.map(row)],
      [Buffer.byteLength(text), gap.length - 1, [['human', 'P1', 'First', 'One.'], ['human', 'P2', 'Second', 'Two.']]]);
  }
  const ex = feedText(jsonl([human('First', 0), asst('One.', 1), notice('Build finished', 2)])); ex.closeOpenTurn();
  assert.equal(ex.snapshot().offset, Buffer.byteLength(jsonl([human('First', 0), asst('One.', 1), notice('Build finished', 2)])));
});

// Claude Code writes no stop summary and no end_turn when the owner interrupts.
const marker = (min) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] },
  timestamp: T(min), cwd: CWD });
test('an interrupt ends the turn, so the next prompt starts a new one; the marker is never a prompt', () => {
  const interrupted = [human('Delete the old builds', 0), use('t1', 'Bash', { command: 'rm -rf build' }, 1), marker(2)];
  const text = jsonl([...interrupted, human('Actually just list them', 3), asst('Here are the builds.', 4), stopSummary(4)]);
  const one = feedText(text).snapshot();
  assert.deepEqual(one.turns.map(row), [['human', 'P1', 'Delete the old builds', null], ['human', 'P2', 'Actually just list them', 'Here are the builds.']]);
  const half = feedText(jsonl([...interrupted, human('Actually just list them', 3)])).snapshot();
  assert.deepEqual([half.offset, half.skipped, half.lastHumanPrompt], [Buffer.byteLength(jsonl(interrupted)), 0, { id: 'P1', text: 'Delete the old builds', ts: Date.parse(T(0)) }]);
  const f = resume(text, half).snapshot();
  assert.deepEqual(f, one);
  assert.deepEqual([f.offset, f.skipped, f.lastHumanPrompt.id, f.lastHumanPrompt.text], [Buffer.byteLength(text), 0, 'P2', 'Actually just list them']);
  // the interrupted turn keeps the reply it had so far; with no turn open the marker does nothing
  const kept = feed([human('Delete the old builds', 0), asst('Deleting them now.', 1, 'tool_use'), marker(2), human('Stop', 3)]).snapshot();
  assert.deepEqual(kept.turns.map(row), [['human', 'P1', 'Delete the old builds', 'Deleting them now.']]);
  const alone = feed([marker(0)]).snapshot();
  assert.deepEqual([alone.turns.length, alone.lastHumanPrompt, alone.skipped, alone.offset], [0, null, 0, Buffer.byteLength(jsonl([marker(0)]))]);
});

// Timing bounds below take the fastest of up to three runs, each on a fresh extractor, not one run: a busy machine
// (a root `npm test` runs suites in parallel) can stall any single run for 100+ ms, but a superlinear scan is slow on
// every run. The bounds are 40x or more over the normal time (2-6 ms), and a quadratic scan of these records takes seconds.
function fastest(bound, run) {
  let ms = Infinity, ex;
  for (let attempt = 0; attempt < 3 && ms >= bound; attempt++) {
    ex = createExtractor({ sessionId: 'sess-1' });
    const t0 = performance.now();
    run(ex);
    ms = Math.min(ms, performance.now() - t0);
  }
  return { ms, ex };
}

// push() runs in the process that answers Claude Code's hooks, on records of hundreds of KB: each
// record is handled in about one pass. The bound is generous so it is never flaky.
test('a 200 KB prompt and a 200 KB reply are handled well within 200 ms', () => {
  const N = 200 * 1024;
  const prompt = human('x'.repeat(N), 0), reply = asst('The dial dims. '.repeat(N / 15), 1);
  const { ms, ex } = fastest(200, (e) => { e.push(prompt, 1); e.push(reply, 2); e.push(stopSummary(1), 3); });
  assert.ok(ms < 200, `took ${ms.toFixed(0)} ms at best of 3`);
  const [t] = ex.snapshot().turns; assert.deepEqual([t.intent.text.length, t.reply.text.length], [500, 1200]);
});

test('a snapshot is plain JSON and shares nothing with the extractor or the saved facts', () => {
  const ex = feed([human('p1', 0), asst('r1', 1), stopSummary(1)]); const a = ex.snapshot();
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a);
  a.turns[0].intent.text = 'changed'; a.turns.push(null); a.next.P = 99; a.totals.turns = 99; a.lastHumanPrompt.text = 'changed';
  assert.deepEqual(ex.snapshot(), feed([human('p1', 0), asst('r1', 1), stopSummary(1)]).snapshot());
  const saved = ex.snapshot(), resumed = createExtractor({ sessionId: 'sess-1', saved }); saved.turns.length = 0; saved.next.R = 99;
  assert.deepEqual(resumed.snapshot(), ex.snapshot());
});

// Tool facts: tools.jsonl is one turn with every kind (fixtures/digest/build.js).
const tools = () => run('tools.jsonl').snapshot(); const strip = ({ id, ...rest }) => rest; const t0 = () => tools().turns[0];
test('files are relative, created is marked, lines come from the patch', () => {
  assert.deepEqual(t0().files.map(strip), [{ path: 'src/a.js', created: false, added: 3, removed: 1 }, { path: 'src/new.js', created: true, added: 0, removed: 0 }]);
});
test('a quiet commit without [branch sha] still counts; an errored one does not; shas keep 12 chars', () => {
  assert.deepEqual(t0().commits.map(strip), [{ subject: 'feat(digest): facts only', sha: '0123456789ab' }, { subject: null, sha: null }]);
});
test('a test run without a count reads "outcome not reported"; is_error without one reads failed', () => {
  assert.deepEqual(t0().tests.map((t) => t.outcome), [{ status: 'counted', passed: 41, failed: 0 }, { status: 'not-reported' }, { status: 'failed' }]);
});
test('failing commands are the errored Bash calls that are neither tests nor commits', () => {
  assert.deepEqual(t0().failures.map((x) => x.command), ['ls /nope']);
});
test('pushes and PRs come from gitOperation, and pr-link records dedupe by number', () => {
  const f = tools(); assert.deepEqual(f.prNumbers, [14]);
  assert.deepEqual(f.turns[0].git.map(strip), [{ kind: 'push', branch: 'feat/x' }, { kind: 'pr', number: 14, action: 'created' }]);
});
test('questions, plans, spawned agents and denials are counted', () => {
  const t = t0(); assert.deepEqual([t.questions.count, t.questions.last.tool, t.questions.last.text, t.agentsSpawned, t.denied], [2, 'ExitPlanMode', 'Ship the digest', 1, 1]);
});
test('totals and stable ids', () => {
  const f = tools(); assert.deepEqual(f.totals, { turns: 1, files: 2, commits: 2, prs: 1, testRuns: 3 });
  assert.deepEqual(f.turns[0].tests.map((t) => t.id), ['T1', 'T2', 'T3']);
});
test('file contents, tool output, thinking, attachments and api records never reach the facts', () => {
  const json = JSON.stringify(tools());
  for (const s of ['OLD', 'NEW', 'CONTENT', 'OUTPUT', 'THINKING', 'ATTACHMENT', 'API', 'PROMPT']) assert.ok(!json.includes(s + '-SENTINEL'), s);
});
test('per-turn caps: top 8 files by size, last 3 tests', () => {
  const recs = [human('go', 0)];
  for (let i = 0; i < 10; i++) recs.push(use('e' + i, 'Edit', { file_path: CWD + '/f' + i }, 1), result('e' + i, { structuredPatch: [{ lines: Array(i + 1).fill('+x') }] }, 1));
  for (let i = 0; i < 5; i++) recs.push(use('b' + i, 'Bash', { command: 'npm test' }, 2), result('b' + i, { stdout: 'ℹ pass ' + i, stderr: '' }, 2));
  const [t] = feed([...recs, asst('ok', 3), stopSummary(3)]).snapshot().turns;
  assert.deepEqual([t.files.length, t.files[0].path], [8, 'f9']);
  assert.deepEqual(t.tests.map((x) => x.outcome.passed), [2, 3, 4]);
});

// Review Focus 5 for tool facts. tools.jsonl twice is two turns; the second repeats the first's files and PR, so
// anything folded into the session before its turn closed would be counted twice or deduped away on a restart.
test('a restart anywhere inside a turn with tool facts reproduces every fact, id and total', () => {
  const one = fs.readFileSync(fx('tools.jsonl'), 'utf8'), text = one + one;
  const lines = text.split('\n').slice(0, -1), n1 = one.split('\n').length - 1;
  const whole = feedText(text).snapshot(), first = feedText(one).snapshot(), none = feedText('').snapshot();
  assert.deepEqual([whole.totals, whole.prNumbers, whole.seenFiles], [{ turns: 2, files: 2, commits: 4, prs: 1, testRuns: 6 }, [14], ['src/a.js', 'src/new.js']]);
  assert.deepEqual(whole.turnLog.map(({ endTs, ...counts }) => counts), [{ commits: 2, prs: 1, testRuns: 3 }, { commits: 2, prs: 0, testRuns: 3 }]);
  const again = whole.turns[1];   // PR #14 is known by now; the ids carry on from the first turn's
  assert.deepEqual([again.git.map(strip), again.files.map((x) => x.id), again.commits.map((x) => x.id), again.tests.map((x) => x.id),
    again.failures.map((x) => x.id), again.questions.last.id], [[{ kind: 'push', branch: 'feat/x' }], ['F3', 'F4'], ['C3', 'C4'], ['T4', 'T5', 'T6'], ['X2'], 'Q2']);
  const closed = (f) => [f.turns, f.totals, f.turnLog, f.seenFiles, f.prNumbers, f.next];
  for (let k = 1; k < lines.length; k++) {
    const half = feedText(lines.slice(0, k).join('\n') + '\n').snapshot();
    assert.deepEqual(closed(half), closed(k < n1 ? none : first), 'the snapshot after line ' + k + ' holds closed turns only');
    assert.deepEqual(resume(text, half).snapshot(), whole, 'resumed after line ' + k);
  }
});

// The worst a tool record can be. A command is read to its first 64 KB (a runner named later is not seen) and a
// test output to its last 256 KB (a count printed earlier is not read), so each record stays one pass over a
// bounded text. The bound is generous so it is never flaky.
test('a 4 MB test output, a 200 KB command and a 200 KB patch are handled well within 200 ms', () => {
  const K = 1024, big = 'w'.repeat(200 * K);
  const lines = Array.from({ length: 200 * K }, (_, i) => (i % 2 ? '+x' : '-y'));
  // ten-digit runs before "passed" are not counts, and each costs the count pattern a few tries
  const output = 'ℹ pass 1000\n' + ('1234567890 '.repeat(9) + 'passed\n').repeat(Math.ceil(4 * K * K / 106)) + 'ℹ pass 7\nℹ fail 0\n';
  const recs = [human('go', 0),
    use('b1', 'Bash', { command: 'npm test && git commit -m "' + big + '"' }, 1), result('b1', { stdout: output, stderr: '' }, 1),
    use('b2', 'Bash', { command: 'ls ' + big }, 1), result('b2', 'Error: Exit code 1\n' + output, 1, { isError: true }),
    use('b3', 'Bash', { command: 'echo ' + big + ' && npm test' }, 1), result('b3', { stdout: 'ℹ pass 5', stderr: '' }, 1),
    use('e1', 'Edit', { file_path: CWD + '/big.js' }, 1), result('e1', { structuredPatch: [{ lines }] }, 1),
    asst('ok', 2), stopSummary(2)];
  const { ms, ex } = fastest(200, (e) => recs.forEach((r, i) => e.push(r, i + 1)));
  assert.ok(ms < 200, `took ${ms.toFixed(0)} ms at best of 3`);
  const [t] = ex.snapshot().turns;
  // the commit message runs into the 64 KB cut, so it is not read
  assert.deepEqual([t.tests.map((x) => x.outcome), t.tests[0].command.length, t.commits[0].subject, t.failures[0].command.length],
    [[{ status: 'counted', passed: 7, failed: 0 }], 160, null, 160]);
  assert.deepEqual(t.files.map(strip), [{ path: 'big.js', created: false, added: 100 * K, removed: 100 * K }]);
});

// A secret that starts 9 characters before a cap: capped first and redacted after, 'sk-ant-A1' would show.
const KEY = SECRETS[0][1];
const straddle = (cap, head = '') => head + 'w'.repeat(cap - 10 - head.length) + ' ' + KEY + ' tail';
const cutAt = (cap, head = '') => head + 'w'.repeat(cap - 10 - head.length) + ' [redacted';
test('paths, commands, commit subjects, branches and plan lines are redacted, then capped', () => {
  const f = feed([human('go', 0),
    use('e1', 'Edit', { file_path: CWD + '/' + straddle(200) }, 1), result('e1', { structuredPatch: [] }, 1),
    use('b1', 'Bash', { command: straddle(160, 'npm test ') }, 1), result('b1', { stdout: '', stderr: '' }, 1),
    use('b2', 'Bash', { command: 'git commit -m "' + straddle(160) + '"' }, 1), result('b2', { stdout: '' }, 1),
    use('b3', 'Bash', { command: straddle(160, 'false ') }, 1), result('b3', 'Error: Exit code 1', 1, { isError: true }),
    use('b4', 'Bash', { command: 'git push' }, 1), result('b4', { gitOperation: { push: { branch: straddle(100) } } }, 1),
    use('q1', 'AskUserQuestion', { questions: [{ question: straddle(160) }] }, 1),
    use('q2', 'ExitPlanMode', { plan: '\n## ' + straddle(160) + '\nStep two' }, 1),
    asst('ok', 2), stopSummary(2)]).snapshot();
  const [t] = f.turns;
  assert.deepEqual([t.files[0].path, t.tests[0].command, t.commits[0].subject, t.failures[0].command, t.git[0].branch, t.questions.last.text],
    [cutAt(200), cutAt(160, 'npm test '), cutAt(160), cutAt(160, 'false '), cutAt(100), cutAt(160)]);
  assert.ok(!JSON.stringify(f).includes('sk-' + 'ant'));
});

test('a denied call is only counted, and an edit that errored is not a file', () => {
  const denied = (id, min) => ({ ...result(id, 'User rejected tool use', min, { isError: true }), toolDenialKind: 'user' });
  const f = feed([human('go', 0),
    use('b1', 'Bash', { command: 'rm -rf build' }, 1), denied('b1', 1),
    use('b2', 'Bash', { command: 'npm test' }, 1), denied('b2', 1),
    use('e1', 'Edit', { file_path: CWD + '/a.js' }, 1), result('e1', 'String to replace not found in file.', 1, { isError: true }),
    use('e2', 'Write', { file_path: CWD + '/b.js' }, 1), denied('e2', 1),
    asst('ok', 2), stopSummary(2)]).snapshot();
  const [t] = f.turns;
  assert.deepEqual([t.denied, t.failures, t.tests, t.files, f.totals.testRuns, f.seenFiles], [3, [], [], [], 0, []]);
});

test('MultiEdit and NotebookEdit count by path; a record with two results reads each block, not toolUseResult', () => {
  const two = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b1', content: 'ℹ pass 1' },
    { type: 'tool_result', tool_use_id: 'b2', content: [{ type: 'text', text: '2 passed' }] }] }, toolUseResult: { stdout: 'ℹ pass 9', stderr: '' }, timestamp: T(1), cwd: CWD };
  const [t] = feed([human('go', 0),
    use('m1', 'MultiEdit', { file_path: CWD + '/m.js', edits: [] }, 1), result('m1', { structuredPatch: [{ lines: ['+a', '+b'] }] }, 1),
    use('n1', 'NotebookEdit', { notebook_path: CWD + '/n.ipynb', new_source: 'x' }, 1), result('n1', { new_source: 'x' }, 1),
    use('b1', 'Bash', { command: 'npm test' }, 1), use('b2', 'Bash', { command: 'pytest' }, 1), two,
    asst('ok', 2), stopSummary(2)]).snapshot().turns;
  assert.deepEqual(t.files.map(strip), [{ path: 'm.js', created: false, added: 2, removed: 0 }, { path: 'n.ipynb', created: false, added: 0, removed: 0 }]);
  assert.deepEqual(t.tests.map((x) => x.outcome.passed), [1, 2]);
});

test('a pr-link between turns only joins prNumbers; inside a turn a new number is a PR fact', () => {
  const link = (prNumber, min) => ({ type: 'pr-link', prNumber, timestamp: T(min) });
  const recs = [human('go', 0), asst('ok', 1), stopSummary(1), link(7, 2),
    human('again', 3), use('b1', 'Bash', { command: 'gh pr create' }, 4), result('b1', { gitOperation: { pr: { number: 7, action: 'created' } } }, 4),
    link(8, 4), asst('ok', 5), stopSummary(5)];
  const f = feed(recs).snapshot(), half = feed(recs.slice(0, 4)).snapshot();
  assert.deepEqual([half.prNumbers, half.totals.prs, half.offset], [[7], 1, Buffer.byteLength(jsonl(recs.slice(0, 4)))]);
  assert.deepEqual([f.prNumbers, f.totals.prs, f.turns[0].git, f.turns[1].git.map(strip), f.turnLog.map((x) => x.prs)],
    [[7, 8], 2, [], [{ kind: 'pr', number: 8, action: null }], [0, 1]]);
});

// One turn may name any number of PRs. Past the prNumbers cap (2,000) a PR is neither a fact nor counted, so a
// turn's PR count and the PR total stop together. Sized so the quadratic form (a per-turn array searched with
// includes) is far over the bound: it took 110 ms at 40,000 numbers, which a 200 ms bound never saw, and takes
// 2.7 s at 200,000; the linear code takes 2-6 ms.
test('a turn of 200,000 new PR numbers is handled well within 500 ms, and its PR count stops at the cap with the total', () => {
  const link = (prNumber, min) => ({ type: 'pr-link', prNumber, timestamp: T(min) });
  const recs = [human('go', 0), ...Array.from({ length: 200000 }, (_, i) => link(i + 1, 1)), asst('ok', 2), stopSummary(2)];
  const { ms, ex } = fastest(500, (e) => recs.forEach((r, i) => e.push(r, i + 1)));
  assert.ok(ms < 500, `took ${ms.toFixed(0)} ms at best of 3`);
  const f = ex.snapshot();
  assert.deepEqual([f.totals.prs, f.prNumbers.length, f.turnLog.map((x) => x.prs), f.turns[0].git.map((g) => g.number)], [2000, 2000, [2000], [1998, 1999, 2000]]);
  // near the cap: 1,990 PRs, then a turn naming 30 more, of which 10 fit; a restart inside it changes nothing
  const near = [human('a', 0), ...Array.from({ length: 1990 }, (_, i) => link(i + 1, 0)), asst('ok', 1), stopSummary(1),
    human('b', 2), ...Array.from({ length: 30 }, (_, i) => link(5000 + i, 3)), asst('ok', 4), stopSummary(4)];
  const text = jsonl(near), lines = text.split('\n').slice(0, -1), whole = feedText(text).snapshot();
  assert.deepEqual([whole.totals.prs, whole.turnLog.map((x) => x.prs), whole.turns[1].git.map((g) => g.number), whole.prNumbers.at(-1)],
    [2000, [1990, 10], [5007, 5008, 5009], 5009]);
  for (let k = 1993; k < lines.length; k++) {
    assert.deepEqual(resume(text, feedText(lines.slice(0, k).join('\n') + '\n').snapshot()).snapshot(), whole, 'resumed after line ' + k);
  }
});

// A command is kept to its first 64 KB. A commit message the cut runs into is not read ("message not read"): its
// start may be a secret that redaction no longer recognises once cut. A message whole before the cut is read.
test('a commit message cut by the 64 KB command cap is not read, and no secret prefix survives; a whole one is read', () => {
  const MAX = 64 * 1024;
  const commit = (command) => {
    const ex = createExtractor({ sessionId: 'sess-1' });
    [human('go', 0), use('b1', 'Bash', { command }, 1), result('b1', { stdout: '' }, 1), asst('ok', 2), stopSummary(2)].forEach((r, i) => ex.push(r, i + 1));
    return ex.snapshot();
  };
  // a secret with a double quote in it would close the message's own quote before the cut
  for (const [name, secret] of SECRETS.filter(([, text]) => !/["\\]/.test(text))) {
    for (let d = 1; d <= 20; d++) {   // the message's opening quote is d chars before the cut
      const head = 'git commit ' + 'w'.repeat(MAX - d - 15) + ' -m "';
      const f = commit(head + secret + '" ' + 'z'.repeat(100));
      assert.equal(f.turns[0].commits[0].subject, null, name + ', quote ' + d + ' before the cut');
      assert.ok(!JSON.stringify(f).includes(secret.slice(0, 7)), name + ', quote ' + d + ' before the cut');
    }
  }
  // cut after a space, or just after an escape, a message would read as its first word with a stray quote
  for (const message of ["'fix the dial dimmer", '"say \\']) {
    const head = 'git commit ' + 'w'.repeat(MAX - 15 - message.length) + ' -m ' + message;
    assert.equal(commit(head + 'more words\'" ' + 'z'.repeat(100)).turns[0].commits[0].subject, null, message);
  }
  for (const len of [MAX - 1, MAX]) {
    const end = ' -m "feat: fine"';
    assert.equal(commit('git commit ' + 'w'.repeat(len - 11 - end.length) + end).turns[0].commits[0].subject, 'feat: fine', len + ' chars');
  }
  assert.equal(commit('git commit -m "feat: early" -- ' + 'z'.repeat(MAX)).turns[0].commits[0].subject, 'feat: early');
});
