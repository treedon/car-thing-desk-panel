// Synthetic transcript records for the digest extractor tests, and the script that writes the
// fixture transcripts beside it: `node mac-service/test/fixtures/digest/build.js`. Times are
// minutes after BASE; nothing here comes from a real session.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASE = Date.parse('2026-11-02T10:00:00.000Z');
export const CWD = '/Users/dev/proj';
export const MODEL = 'claude-test-1';

export const T = (min) => new Date(BASE + min * 60000).toISOString();
const at = (min) => ({ timestamp: T(min), cwd: CWD });

export const human = (text, min) => ({ type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: text }, ...at(min) });
export const notice = (text, min) => ({ type: 'user', origin: { kind: 'task-notification' }, message: { role: 'user', content: text }, ...at(min) });
export const asst = (text, min, stop = 'end_turn') => ({ type: 'assistant',
  message: { model: MODEL, role: 'assistant', stop_reason: stop, content: [{ type: 'text', text }] }, ...at(min) });
export const use = (id, name, input, min) => ({ type: 'assistant',
  message: { model: MODEL, role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] }, ...at(min) });
export const result = (id, toolUseResult, min, { isError = false, content = '' } = {}) => ({ type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }] }, toolUseResult, ...at(min) });
export const stopSummary = (min) => ({ type: 'system', subtype: 'stop_hook_summary', ...at(min) });

// One record per line; a string is written as it is (a torn line).
export const jsonl = (records) => records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';

const user = (fields, min) => ({ type: 'user', ...fields, ...at(min) });
const failed = (id, min) => result(id, 'Error: Exit code 1', min, { isError: true });
const prLink = (number, min) => ({ type: 'pr-link', prNumber: number, timestamp: T(min) });

// tools.jsonl: one turn with every kind of tool fact. The *-SENTINEL strings are contents, output, thinking,
// attachments and api records that must never reach the facts.
const TOOLS = [
  human('Ship the digest', 0),
  { type: 'attachment', attachment: { type: 'file', content: 'ATTACHMENT-SENTINEL' }, ...at(0) },
  { type: 'assistant', message: { model: MODEL, role: 'assistant', stop_reason: null, content: [{ type: 'thinking', thinking: 'THINKING-SENTINEL' }] }, ...at(1) },
  { type: 'api-request', request: { body: 'API-SENTINEL' }, ...at(1) },
  use('t1', 'Edit', { file_path: CWD + '/src/a.js', old_string: 'OLD-SENTINEL', new_string: 'NEW-SENTINEL' }, 1),
  result('t1', { oldString: 'OLD-SENTINEL', newString: 'NEW-SENTINEL', originalFile: 'OLD-SENTINEL\n', structuredPatch: [{ lines: [' x', '-y', '+z', '+w'] }] }, 1),
  use('t2', 'Edit', { file_path: CWD + '/src/a.js', old_string: 'OLD-SENTINEL', new_string: 'NEW-SENTINEL' }, 1),
  result('t2', { structuredPatch: [{ lines: ['+q'] }] }, 1),
  use('t3', 'Write', { file_path: 'src/new.js', content: 'CONTENT-SENTINEL' }, 1),
  result('t3', { type: 'create', content: 'CONTENT-SENTINEL', structuredPatch: [] }, 1),
  use('t4', 'Bash', { command: 'npm --prefix mac-service test' }, 2),
  result('t4', { stdout: 'ℹ pass 41\nℹ fail 0\nOUTPUT-SENTINEL', stderr: '' }, 2),
  use('t5', 'Bash', { command: 'go test ./...' }, 2), result('t5', { stdout: 'ok pkg 0.1s', stderr: '' }, 2),
  use('t6', 'Bash', { command: 'pytest -q' }, 2), failed('t6', 2),
  use('t7', 'Bash', { command: 'git add -A && git commit -m "feat(digest): facts only"' }, 3),
  result('t7', { stdout: '', gitOperation: { commit: { sha: '0123456789abcdef0123456789abcdef01234567', kind: 'commit', branch: 'main' } } }, 3),
  use('t8', 'Bash', { command: 'git commit -F /tmp/msg.txt' }, 3), result('t8', { stdout: '' }, 3),
  use('t9', 'Bash', { command: 'git commit -m "broken"' }, 3), failed('t9', 3),
  use('t10', 'Bash', { command: 'ls /nope' }, 3), failed('t10', 3),
  use('t11', 'Bash', { command: 'git push -u origin feat/x' }, 3), result('t11', { gitOperation: { push: { branch: 'feat/x' } } }, 3),
  use('t12', 'Bash', { command: 'gh pr create' }, 3), result('t12', { gitOperation: { pr: { number: 14, action: 'created' } } }, 3),
  prLink(14, 3), prLink(14, 3),
  use('t13', 'AskUserQuestion', { questions: [{ question: 'Which window?' }] }, 4),
  use('t14', 'ExitPlanMode', { plan: '# Ship the digest\nStep one' }, 4),
  use('t15', 'Agent', { description: 'Review Task 4', prompt: 'PROMPT-SENTINEL' }, 4),
  use('t16', 'Read', { file_path: CWD + '/src/a.js' }, 4),
  { ...result('t16', 'User rejected tool use', 4, { isError: true }), toolDenialKind: 'user' },
  asst('All done. Tests pass.', 5), stopSummary(5),
];

export const FIXTURES = {
  'turns.jsonl': [
    { type: 'custom-title', customTitle: 'Digest fixture' }, { type: 'ai-title', aiTitle: 'ignored' },
    human('Make the dial dimmer', 0), asst('Done. The dial now dims in 5% steps. Next: tests.', 2), stopSummary(2),
    asst('I also tidied the helper.', 3), stopSummary(3),
    notice('<task-notification>Background build finished</task-notification>', 10), asst('The background build passed.', 11), stopSummary(11),
    user({ isCompactSummary: true, message: { role: 'user', content: 'This session is being continued from a previous conversation.' } }, 12),
    human('Now add the tests', 20), use('t1', 'Bash', { command: 'npm test' }, 21),
  ],
  'messy.jsonl': [
    human('Tidy the config loader', 0), { type: 'brand-new-record' }, '{"type":"assistant","message":{"content":[{"ty',
    { ...asst('Sidechain work.', 0), isSidechain: true },
    user({ isMeta: true, message: { role: 'user', content: 'META-SENTINEL' } }, 0),
    user({ message: { role: 'user', content: '[Request interrupted by user]' } }, 0),
    asst('Fine.', 1), stopSummary(1),
  ],
  'fallback.jsonl': [human('First', 0), asst('One.', 1), human('Second', 5), asst('Two.', 6)],
  'notify-only.jsonl': [notice('<task-notification>Build finished</task-notification>', 0), asst('Built.', 1), stopSummary(1)],
  'tools.jsonl': TOOLS,
};

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(self)) {
  for (const [name, records] of Object.entries(FIXTURES)) fs.writeFileSync(path.join(path.dirname(self), name), jsonl(records));
}
