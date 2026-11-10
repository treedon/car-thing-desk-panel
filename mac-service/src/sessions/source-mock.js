// Mock session source: fake sessions with evolving state + a scripted
// permission request cycle. Lets device-app development run with zero real
// Claude Code integration. Enabled with CLAUDE_THING_MOCK=1.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log } from '../log.js';

// Deliberately more sessions than fit on one screen so the grid's sideways
// scrolling gets exercised in dev. Each has a project folder and a Claude Code
// style title, so tiles show both lines.
const NAMES = [
  'claude-thing', 'nocturne-ui', 'credit_card_picker', 'api-server',
  'design-system', 'infra-terraform', 'docs-site', 'ml-pipeline', 'mobile-app',
  'Mirror', 'home-assistant', 'Spotify_car_thing',
];
const TITLES = [
  'Permission bridge timeout fix', 'Dial scrolling on the queue', 'Card rewards comparison',
  'Rate limiter for public endpoints', 'Button tokens audit', 'Move state to S3 backend',
  'Docs search ranking', 'Nightly retrain pipeline', 'Push notification opt-in flow',
  'Mirror-mouse pairing plan', 'HomePod volume automations', 'Desk panel subagent view',
];
// The one session with a crowd of subagents, to exercise the list's scrolling.
const BUSY_AGENTS_INDEX = 11;
const BUSY_AGENTS = 22;

const ts = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const MODEL = 'claude-fable-5';
const MIN = 60_000;

const jsonl = (records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

function writeJsonl(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, jsonl(records));
}

// ---- demo transcripts -----------------------------------------------------
// Turns in the record shapes Claude Code writes (and the digest reads): an owner prompt
// (origin.kind 'human') or a task notification starts one, assistant records carry the model and
// stop_reason, a tool's result comes back as a user record with toolUseResult, and every turn ends
// with an end_turn reply and a stop_hook_summary. Times are minutes before now; nothing here is a
// real session.

// A transcript built turn by turn, oldest record first.
function transcript(cwd) {
  const records = [];
  let n = 0;
  const at = (min) => ({ timestamp: ts(min * MIN), cwd });
  const assistant = (content, stop, min) => ({ type: 'assistant',
    message: { model: MODEL, role: 'assistant', stop_reason: stop, content }, ...at(min) });
  const t = {
    records,
    title(text) { records.push({ type: 'ai-title', aiTitle: text }); return t; },
    human(text, min) { records.push({ type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: text }, ...at(min) }); return t; },
    notice(text, min) { records.push({ type: 'user', origin: { kind: 'task-notification' }, message: { role: 'user', content: text }, ...at(min) }); return t; },
    // Text on the way, before more tool calls.
    note(text, min) { records.push(assistant([{ type: 'text', text }], null, min)); return t; },
    tool(name, input, result, min, isError = false) {
      const id = `toolu_mock${String(++n).padStart(3, '0')}`;
      records.push(assistant([{ type: 'tool_use', id, name, input }], 'tool_use', min));
      records.push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError,
        content: typeof result === 'string' ? result : (result && result.stdout) || '' }] }, toolUseResult: result, ...at(min) });
      return t;
    },
    bash(command, result, min, isError = false) { return t.tool('Bash', { command }, result, min, isError); },
    edit(file, added, removed, min) {
      const lines = [...Array(added).fill('+ added line'), ...Array(removed).fill('- removed line')];
      return t.tool('Edit', { file_path: `${cwd}/${file}`, old_string: 'before', new_string: 'after' },
        { filePath: `${cwd}/${file}`, structuredPatch: [{ lines }] }, min);
    },
    create(file, lines, min) {
      return t.tool('Write', { file_path: `${cwd}/${file}`, content: 'demo' },
        { type: 'create', filePath: `${cwd}/${file}`, structuredPatch: [{ lines: Array(lines).fill('+ new line') }] }, min);
    },
    reply(text, min) { records.push(assistant([{ type: 'text', text }], 'end_turn', min)); return t; },
    stop(min) { records.push({ type: 'system', subtype: 'stop_hook_summary', ...at(min) }); return t; },
    raw(record, min) { records.push({ ...record, ...at(min) }); return t; },
  };
  return t;
}

const out = (stdout) => ({ stdout, stderr: '' });
const committed = (sha, subject) => ({ stdout: `[main ${sha.slice(0, 7)}] ${subject}`, stderr: '',
  gitOperation: { commit: { sha, kind: 'commit', branch: 'main' } } });
const FAILED = 'Error: Exit code 1';

// When each live session's last turn ended, newest first: from 3 minutes to 5 hours ago.
const LAST_TURN_MIN = [3, 9, 18, 30, 45, 60, 80, 105, 135, 170, 230, 300];

// What each live session did, so the digest has a card in every facts-only state: counted, failed
// and unreported tests, a commit with its subject and one whose message is not read, a pull
// request, created and edited files, a continuation turn, a turn a task notification started, a
// question, a plan, a card with no fact lines, and the crowd of subagents.
const DEMO_TURNS = [
  // 0: edits, counted tests and a commit, then a continuation turn with no prompt of its own.
  (t, L) => t.human('Fix the permission bridge timeout: a held request should fall back to the terminal after 20 s.', L + 14)
    .note('I\'ll read the bridge first, then add a test for the fallback.', L + 13)
    .edit('src/permission-bridge.js', 18, 6, L + 11)
    .edit('test/permission-bridge.test.js', 42, 0, L + 10)
    .bash('npm --prefix mac-service test', out('ℹ tests 41\nℹ suites 0\nℹ pass 41\nℹ fail 0'), L + 8)
    .bash('git add -A && git commit -m "fix(bridge): a held permission falls back after 20 s"',
      committed('3f2a9c1e5b7d4a60c8e1f2a3b4c5d6e7f8091a2b', 'fix(bridge): a held permission falls back after 20 s'), L + 7)
    .reply('Fixed. A held permission now falls back to the terminal after 20 s, and the new test covers it.', L + 6).stop(L + 6)
    .reply('I also tidied the bridge\'s log lines so each names its request.', L).stop(L),
  // 1: a test run that failed before it printed a count, and a failing ls.
  (t, L) => t.human('Why does the dial skip rows on the queue? Run the tests and find out.', L + 12)
    .bash('npm test', FAILED, L + 10, true)
    .bash('ls build/', 'ls: build/: No such file or directory', L + 9, true)
    .edit('src/queue.js', 5, 2, L + 4)
    .reply('The suite stops before it prints counts because build/ is missing. I fixed the off-by-one in src/queue.js; run the build before the tests.', L).stop(L),
  // 2: tests that ran without a count, a commit whose message is in a file, and a pull request.
  (t, L) => t.human('Add the rewards comparison and open a PR.', L + 20)
    .create('src/compare.js', 64, L + 16)
    .bash('npm test', out('> credit_card_picker@1.0.0 test\n> node scripts/check.js\n\nall checks done'), L + 12)
    .bash('git add src/compare.js && git commit -F .git/COMMIT_MSG', out('[main 9b1d2e4] (message from file)'), L + 10)
    .bash('git push -u origin feat/rewards', { stdout: '', stderr: '', gitOperation: { push: { branch: 'feat/rewards' } } }, L + 8)
    .bash('gh pr create --fill', { stdout: 'https://github.com/dev/credit_card_picker/pull/14', stderr: '',
      gitOperation: { pr: { number: 14, action: 'created' } } }, L + 6)
    .raw({ type: 'pr-link', prNumber: 14 }, L + 6)
    .reply('Opened PR #14 with the rewards comparison. The checks ran but print no counts, so I cannot say how many passed.', L).stop(L),
  // 3: a human turn with a heredoc commit, then a turn a task notification started.
  (t, L) => t.human('Add a rate limiter to the public endpoints and commit it.', L + 40)
    .edit('src/limiter.js', 51, 3, L + 34)
    .bash('git add src/limiter.js && git commit -m "$(cat <<\'EOF\'\nfeat(api): rate-limit the public endpoints\n\nA token bucket of 60 requests a minute per key.\nEOF\n)"',
      committed('a41c07d29e3b5f6a7c8d9e0f1a2b3c4d5e6f7a8b', 'feat(api): rate-limit the public endpoints'), L + 30)
    .reply('Committed the limiter: a token bucket of 60 requests a minute per key. A load test is running in the background.', L + 28).stop(L + 28)
    .notice('<task-notification>\n<status>completed</status>\n<summary>Background load test finished</summary>\n</task-notification>', L + 2)
    .reply('The background load test finished: the limiter held at 60 a minute with no errors.', L).stop(L),
  // 4: an edit, a created file, vitest's counts.
  (t, L) => t.human('Audit the button tokens against the spec.', L + 25)
    .edit('tokens/button.json', 12, 9, L + 18)
    .create('docs/button-audit.md', 30, L + 12)
    .bash('npx vitest run', out(' Test Files  4 passed (4)\n      Tests  27 passed (27)'), L + 6)
    .reply('Three button tokens had drifted from the spec; I fixed them and wrote the audit up in docs/button-audit.md.', L).stop(L),
  // 5: an edit, a commit and a push.
  (t, L) => t.human('Move the Terraform state to the S3 backend.', L + 30)
    .edit('backend.tf', 14, 2, L + 24)
    .bash('terraform plan', out('No changes. Your infrastructure matches the configuration.'), L + 18)
    .bash('git commit -am "chore(infra): keep state in S3"', committed('c0ffee12a3b4c5d6e7f8091a2b3c4d5e6f708192', 'chore(infra): keep state in S3'), L + 12)
    .bash('git push', { stdout: '', stderr: '', gitOperation: { push: { branch: 'main' } } }, L + 10)
    .reply('State now lives in S3 with DynamoDB locking, and the plan shows no changes to resources.', L).stop(L),
  // 6: jest's counts with a failure.
  (t, L) => t.human('Search ranks old pages first. Fix the ranking.', L + 22)
    .edit('src/search/rank.ts', 30, 11, L + 15)
    .bash('npm test', out('Tests:       1 failed, 63 passed, 64 total'), L + 6)
    .reply('Ranking now weighs recency. One snapshot test still fails because its fixture predates the change.', L).stop(L),
  // 7: a created file, pytest's counts.
  (t, L) => t.human('Schedule the nightly retrain.', L + 18)
    .create('pipelines/nightly.yaml', 22, L + 12)
    .bash('pytest -q', out('............ \n12 passed in 3.41s'), L + 5)
    .reply('The nightly retrain is scheduled for 02:00 and the pipeline tests pass.', L).stop(L),
  // 8: a question asked on the way.
  (t, L) => t.human('Build the push notification opt-in screen.', L + 26)
    .create('src/screens/OptIn.tsx', 88, L + 20)
    .edit('src/App.tsx', 4, 0, L + 16)
    .tool('AskUserQuestion', { questions: [{ question: 'Ask on first launch, or after the first order?' }] }, 'After the first order', L + 12)
    .reply('The opt-in screen is in, and it asks after the first order, as you chose.', L).stop(L),
  // 9: a plan and nothing else: a card with no fact lines.
  (t, L) => t.human('Plan the mirror-mouse pairing.', L + 15)
    .tool('ExitPlanMode', { plan: '# Mirror-mouse pairing\n1. BLE scan\n2. Bond\n3. Remember the last host' }, 'Approved', L + 8)
    .reply('The plan is approved; pairing starts with a BLE scan.', L).stop(L),
  // 10: an edit, a commit refused by its hook, a failing check.
  (t, L) => t.human('Add evening volume automations for the HomePods.', L + 20)
    .edit('automations.yaml', 22, 3, L + 14)
    .bash('ha core check', 'Invalid config for [automation]', L + 9, true)
    .bash('git commit -am "feat(ha): evening volume automations"', FAILED, L + 6, true)
    .reply('The automations are written, but the commit failed: the pre-commit hook rejects the YAML indentation.', L).stop(L),
  // 11: one edit, node's test counts and the subagents (written beside the transcript).
  (t, L) => t.human('Review every task against the spec, one subagent per task.', L + 50)
    .tool('Agent', { description: 'Review task 1', prompt: 'Review task 1 against the spec.' }, 'Task 1 meets the spec.', L + 45)
    .edit('src/screens/agents.js', 9, 4, L + 10)
    .reply('Nineteen reviews are back and three are still running; I fixed the one naming nit they agreed on.', L).stop(L),
];

// Transcript-only sessions: no live session in the store. ended-recent is a card that reads ENDED;
// ended-old is outside the 24 h window and notify-only was never prompted by the owner, so the digest
// shows neither.
const TRANSCRIPT_ONLY = [
  { id: 'mock-ended-recent', project: 'e-ink-prototype', lastMin: 120, build: (t, L) => t
    .title('Prototype the e-ink layout')
    .human('Try an e-ink layout for the panel.', L + 30)
    .edit('src/eink.css', 40, 12, L + 20)
    .bash('npm test', out('ℹ pass 8\nℹ fail 0'), L + 10)
    .bash('git commit -am "feat: e-ink layout"', committed('e1e1e1e1aa22bb33cc44dd55ee66ff7700112233', 'feat: e-ink layout'), L + 5)
    .reply('The e-ink layout works at a 1 Hz refresh. Committed; this session is done.', L).stop(L) },
  { id: 'mock-ended-old', project: 'old-experiments', lastMin: 30 * 60, build: (t, L) => t
    .title('Yesterday\'s experiment')
    .human('Try the old renderer once more.', L + 10)
    .reply('It still flickers; I left it as it was.', L).stop(L) },
  { id: 'mock-notify-only', project: 'claude-thing', lastMin: 40, build: (t, L) => t
    .notice('<task-notification>\n<status>completed</status>\n<summary>Nightly lint finished</summary>\n</task-notification>', L + 1)
    .reply('The nightly lint finished with no findings.', L).stop(L) },
];

// The churn's stop: one more owner turn, closed by its stop summary, appended to the transcript.
function stopTurn(cwd, n, tool) {
  return transcript(cwd)
    .human(`Run the ${tool} step again (mock turn #${n}).`, 0.5)
    .reply(`Ran the ${tool} step again for mock turn #${n}; nothing else changed.`, 0)
    .stop(0).records;
}

function writeSubagents(sessionDir, count) {
  const dir = path.join(sessionDir, 'subagents');
  for (let k = 0; k < count; k++) {
    const id = `mock${String(k).padStart(2, '0')}`;
    const running = k >= count - 3;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `agent-${id}.meta.json`), JSON.stringify({
      agentType: k % 3 === 0 ? 'Explore' : 'general-purpose',
      description: `Review task ${k + 1}`,
      toolUseId: `tu-${id}`,
      spawnDepth: k % 5 === 4 ? 2 : 1,
      parentAgentId: k % 5 === 4 ? `mock${String(k - 1).padStart(2, '0')}` : undefined,
      requestShape: k % 2 ? 'background' : 'foreground',
      ...(running ? {} : { finished: true }),
    }));
    writeJsonl(path.join(dir, `agent-${id}.jsonl`), [
      { isSidechain: true, type: 'user', message: { role: 'user', content: `Review task ${k + 1} against the spec.` }, timestamp: ts(400_000 - k * 1000) },
      { isSidechain: true, type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `r${k}`, name: 'Read', input: { file_path: `src/task-${k + 1}.js` } }] }, timestamp: ts(390_000 - k * 1000) },
      ...(running ? [] : [{ isSidechain: true, type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `h${k}`, name: 'SubagentHandback', input: { message: `Task ${k + 1} meets the spec. One minor naming nit in the helper.` } }] }, timestamp: ts(380_000 - k * 1000) }]),
    ]);
  }
}
const TOOLS = [
  ['Bash', { command: 'npm test' }],
  ['Edit', { file_path: 'src/index.js' }],
  ['Write', { file_path: 'README.md' }],
];

// Finished turns for the inbox, so the queue's screens show something in the
// simulator: a question that needs an answer (the hero, with its chips), and
// two progress notes (stack rows, and the UPDATE hero once the question is
// answered). `index` picks the seeded session, `agoMs` is how long ago its turn
// ended. One note carries the owner's own words as its "you asked" line, the
// other has none, so both shapes of a card are visible.
const DEMO_CARDS = [
  {
    index: 3, tag: 'asking', agoMs: 2 * 60_000, host: 'vscode',
    intent: 'you asked: add a rate limiter to the public endpoints',
    text:
      'I added a token-bucket limiter in front of the public routes and covered the burst and refill cases in the tests. ' +
      'The suite passes.\n\n' +
      'One decision before I wire it in: should the limit be per API key or per client IP? ' +
      'Per key is fairer to shared offices, but anonymous callers would all share one bucket.',
  },
  {
    index: 4, tag: 'update', agoMs: 7 * 60_000, host: 'terminal',
    intent: 'you asked: audit the button tokens',
    text:
      'I compared every button variant against the token file and found three that still use hard-coded colours.\n\n' +
      'All three now read from the tokens, and the visual snapshots match. Nothing else changed.',
  },
  {
    index: 8, tag: 'update', agoMs: 18 * 60_000, host: 'vscode',
    intent: '',
    text:
      'The opt-in flow is done: the prompt now appears after the second launch, and declining it is remembered for thirty days. ' +
      'The two flaky tests were a race in the fake clock, which I fixed.',
  },
];
// The session that finished a turn with a build still running: it reads busy
// and its tile says what it is waiting on until the work posts its own card.
const WAITING_INDEX = 6;
const WAITING_ON = { type: 'shell', label: 'npm run build:docs', agoMs: 4 * 60_000 };

// The demo's scratch folder, and the transcripts folder inside it that the digest reads in mock mode.
export const MOCK_DIR = path.join(os.tmpdir(), 'claude-panel-mock');
export const MOCK_PROJECTS_DIR = path.join(MOCK_DIR, 'projects');

// onStop(id, transcriptPath) is called after the churn appends a finished turn to a session's
// transcript, as the Stop hook would be heard for a real one (index.js passes it to the digest).
export function startMockSource({ store, permissionBridge, queue, inbox, dir = MOCK_DIR, onStop }) {
  let n = 0;
  // The demo's own scratch folder, rewritten from scratch on every start.
  fs.rmSync(dir, { recursive: true, force: true });
  // Laid out as Claude Code lays out ~/.claude/projects: <projects>/<project>/<session id>.jsonl,
  // the session's subagents in the folder beside it.
  const projectsDir = path.join(dir, 'projects');

  // seed sessions
  const ids = NAMES.map((name, i) => {
    const id = `mock-${i}-${name}`;
    const cwd = `/Users/dev/${name}`;
    const transcriptPath = path.join(projectsDir, name, `${id}.jsonl`);
    writeJsonl(transcriptPath, DEMO_TURNS[i](transcript(cwd).title(TITLES[i]), LAST_TURN_MIN[i]).records);
    writeSubagents(transcriptPath.replace(/\.jsonl$/, ''), i === BUSY_AGENTS_INDEX ? BUSY_AGENTS : i % 4 === 1 ? 2 : 0);
    store.upsert(id, {
      name,
      aiTitle: TITLES[i],
      transcriptPath,
      cwd,
      model: 'claude-fable-5',
      tokensIn: 1200 * (i + 1),
      tokensOut: 800 * (i + 1),
      // A spread of context fills, including one past the 80% mark, so the
      // meter's neutral-until-it-matters behaviour is visible in mock mode.
      contextTokens: Math.round([0.34, 0.62, 0.41, 0.88, 0.22, 0.55, 0.13, 0.71, 0.09][i % 9] * 1_000_000),
      lastMessage: 'Initialized mock session.',
      lastActivityTs: Date.now() - i * 60_000,
      // Every mode the badge knows, plus one session with none, so dev sees
      // the whole set — including the tile that draws no badge at all.
      permissionMode: ['plan', 'bypassPermissions', 'auto', 'default', 'acceptEdits', null][i % 6],
      // Every effort gait too, including the absent one that falls back to
      // the plain working sprite.
      effort: ['low', 'medium', 'high', 'xhigh', 'max', 'ultrathink', null][i % 7],
      // Feeds the ask's intent line in mock mode; one session without, so the
      // hero that omits the line is visible in dev too.
      lastPrompt: i === 2 ? null : `tidy up the ${name} build`,
      // The states the digest's lamps show, from the start: session 1 waits on the owner (the mock
      // questions are its), session 2 has just finished. Session 0 is working (its last activity is
      // now) and the churn moves the rest.
      ...(i === 1 ? { waitingForInput: true } : {}),
      ...(i === 2 ? { stoppedTs: Date.now() } : {}),
    });
    return id;
  });

  for (const s of TRANSCRIPT_ONLY) {
    const file = path.join(projectsDir, s.project, `${s.id}.jsonl`);
    writeJsonl(file, s.build(transcript(`/Users/dev/${s.project}`), s.lastMin).records);
    const when = new Date(Date.now() - s.lastMin * MIN);
    fs.utimesSync(file, when, when);
  }

  // A session waiting on background work isn't running tools, so the churn
  // below leaves it alone and its tile keeps reading "waiting on …".
  const waitingId = ids[WAITING_INDEX];
  store.upsert(waitingId, {
    currentTool: null,
    stoppedTs: Date.now() - WAITING_ON.agoMs,
    waitingOn: [{ type: WAITING_ON.type, label: WAITING_ON.label, since: Date.now() - WAITING_ON.agoMs }],
  });

  // Finished turns, posted as the hooks source would post them.
  if (inbox) {
    for (const demo of DEMO_CARDS) {
      const id = ids[demo.index];
      inbox.post({
        sessionId: id,
        sessionName: store.get(id).name,
        host: demo.host,
        tag: demo.tag,
        text: demo.text,
        intent: demo.intent,
        stoppedTs: Date.now() - demo.agoMs,
      });
    }
  }

  // activity churn: one session "works" at a time
  const churn = setInterval(() => {
    n++;
    const id = ids[n % ids.length];
    if (id === waitingId) return;
    const [tool] = TOOLS[n % TOOLS.length];
    store.touch(id, {
      currentTool: tool,
      tokensIn: (store.raw(id).tokensIn || 0) + 300,
      tokensOut: (store.raw(id).tokensOut || 0) + 150,
      contextTokens: Math.min(1_000_000, (store.raw(id).contextTokens || 0) + 9_000),
      lastMessage: `Running ${tool} (mock activity #${n})`,
      stoppedTs: null,
    });
    if (n % 7 === 0) {
      store.upsert(id, { stoppedTs: Date.now(), currentTool: null, lastMessage: 'Done (mock).' });
      // The turn that just stopped, as Claude Code would have written it, then the Stop.
      const file = store.raw(id).transcriptPath;
      try {
        fs.appendFileSync(file, jsonl(stopTurn(store.raw(id).cwd, n, tool)));
        if (onStop) onStop(id, file);
      } catch (err) {
        log('MK', `mock stop not written: ${(err && err.code) || 'error'}`);
      }
    }
  }, 8_000);

  // scripted permission request every 60s against a fake held response;
  // every other one is destructive, so the two-press arming chip gets
  // exercised in dev alongside the plain allow.
  let permN = 0;
  const perm = setInterval(() => {
    if (!permissionBridge) return;
    const id = ids[0];
    let [tool, input] = TOOLS[n % TOOLS.length];
    if (permN++ % 2 === 1) {
      tool = 'Bash';
      input = { command: 'rm -rf node_modules && npm ci' };
    }
    const fakeRes = {
      writeHead: () => {},
      end: (body) => log('MK', `mock hook answered: ${String(body).slice(0, 80)}`),
      on: () => {},
    };
    permissionBridge.onHookRequest(
      { session_id: id, tool_name: tool, tool_input: input, cwd: `/Users/dev/${NAMES[0]}` },
      fakeRes
    );
  }, 60_000);

  // Scripted questions so the queue can be exercised in dev. It alternates
  // between the two shapes that behave differently end to end: one question
  // answered by a single press, and a multi-question dialog with a multiSelect
  // in it — the one that needs the stepper, the review step and a Submit.
  const QUESTIONS = [
    [{
      header: 'Deploy target',
      question: 'Where should this build go?',
      multiSelect: false,
      options: [
        { label: 'Staging', description: 'Safe. Runs the smoke suite first.' },
        { label: 'Production', description: 'Ships to users immediately.' },
        { label: 'Skip deploy', description: 'Build only, keep the artifact.' },
        { label: 'Preview branch', description: 'Ephemeral URL for review.' },
      ],
    }],
    [
      {
        header: 'Auth method',
        question: 'How should the API authenticate callers?',
        multiSelect: false,
        options: [
          { label: 'OAuth', description: 'Delegated, no passwords stored here.' },
          { label: 'API keys', description: 'Simplest. Rotation is on you.' },
          { label: 'mTLS', description: 'Strongest, painful to operate.' },
        ],
      },
      {
        header: 'Environments',
        question: 'Which environments get the new pipeline?',
        multiSelect: true,
        options: [
          { label: 'Dev', description: 'Rebuilt on every push.' },
          { label: 'Staging', description: 'Mirrors production data shape.' },
          { label: 'Production', description: 'Customer traffic.' },
        ],
      },
      {
        header: 'Rollout',
        question: 'How fast should it go out?',
        multiSelect: false,
        options: [
          { label: 'All at once', description: 'One deploy, one blast radius.' },
          { label: 'Canary 10%', description: 'Watch an hour, then widen.' },
        ],
      },
    ],
  ];
  let questionTurn = 0;
  const quest = setInterval(() => {
    if (!queue) return;
    queue.onQuestion({
      session_id: ids[1],
      tool_name: 'AskUserQuestion',
      tool_input: { questions: QUESTIONS[questionTurn++ % QUESTIONS.length] },
    });
  }, 90_000);

  log('MK', `mock source: ${ids.length} sessions, ${inbox ? DEMO_CARDS.length : 0} cards, permission every 60s, question every 90s`);
  return {
    stop: () => { clearInterval(churn); clearInterval(perm); clearInterval(quest); },
  };
}
