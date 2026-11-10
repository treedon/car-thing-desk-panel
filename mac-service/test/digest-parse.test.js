// Pure parsers the transcript extractor uses: is a Bash command a test run or a git commit,
// what a test run's output says, a commit subject, a first sentence, a relative path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTestCommand, parseTestOutcome, isCommitCommand, commitSubject, resultText, firstSentence, relPath } from '../src/digest/parse.js';

test('test runners are recognised, other commands are not', () => {
  for (const c of ['npm test', 'npm run test', 'npm --prefix mac-service test', 'node --test "test/*.test.js"', 'pytest -q',
    'npx jest', 'npx vitest run', 'go test ./...', 'cargo test', 'cd panel && npm test 2>&1 | tail -5']) assert.ok(isTestCommand(c), c);
  for (const c of ['npm install test-utils', 'git commit -m "test: add"', 'ls test/', 'cat jest.config.js']) assert.ok(!isTestCommand(c), c);
});
test('a parsed count is the outcome, summed across suites', () => {
  const c = (passed, failed) => ({ status: 'counted', passed, failed });
  for (const [out, isError, want] of [['ℹ tests 41\nℹ pass 41\nℹ fail 0\n', false, c(41, 0)], ['# pass 12\n# fail 2\n', true, c(12, 2)],
    ['==== 3 failed, 10 passed in 0.52s ====', true, c(10, 3)], ['ℹ pass 200\nℹ fail 0\nℹ pass 12\nℹ fail 1\n', true, c(212, 1)],
    ['Test Suites: 1 failed, 4 passed, 5 total\nTests:       2 failed, 40 passed, 42 total', true, c(40, 2)],
    [' Test Files  2 passed (2)\n      Tests  10 passed (10)', false, c(10, 0)]]) assert.deepEqual(parseTestOutcome(out, isError), want, out);
});
test('without a count, is_error means failed and anything else is not reported', () => {
  assert.deepEqual(parseTestOutcome('ok  \tpkg/x\t0.01s', false), { status: 'not-reported' });
  assert.deepEqual(parseTestOutcome('Error: Exit code 1', true), { status: 'failed' });
});
test('git commit counts anywhere in a command; commit-tree and log do not', () => {
  for (const c of ['git commit -m "x"', 'git add -A && git commit -m "x"', 'git -C mac-service commit -am "x"', 'git commit --amend --no-edit'])
    assert.ok(isCommitCommand(c), c);
  for (const c of ['git commit-tree abc', 'git log --grep commit']) assert.ok(!isCommitCommand(c), c);
});
test('the subject comes from -m or a heredoc first line, else null', () => {
  assert.deepEqual(['git commit -m "feat(panel): digest screen"', "git -C x commit -am 'fix: x' -m 'body'",
    `git commit -m "$(cat <<'EOF'\nfeat(digest): facts only\n\nBody\nEOF\n)"`, 'git commit -F /tmp/msg.txt', 'git commit --amend --no-edit'].map(commitSubject),
    ['feat(panel): digest screen', 'fix: x', 'feat(digest): facts only', null, null]);
});
test('resultText reads an object, a string or the block; paths are relative to the cwd', () => {
  assert.deepEqual([resultText({ stdout: 'a', stderr: 'b' }, {}), resultText('Error: Exit code 1', {}),
    resultText(undefined, { content: [{ type: 'text', text: 'c' }] })], ['a\nb', 'Error: Exit code 1', 'c']);
  assert.deepEqual([relPath('/Users/dev/p/src/a.js', '/Users/dev/p'), relPath('/etc/hosts', '/Users/dev/p')], ['src/a.js', '/etc/hosts']);
});
test('first sentence, without markdown, cut to 80 at a word', () => {
  assert.deepEqual(['The recorder now reopens the audio device after resume. Next…', 'Version 1.2 is out. Then more.', '## Done\n\n- Fixed it', '']
    .map((t) => firstSentence(t)), ['The recorder now reopens the audio device after resume.', 'Version 1.2 is out.', 'Done', '']);
  const cut = firstSentence('word '.repeat(40)); assert.ok(cut.length <= 80 && cut.endsWith('…'));
});

test('the subject is read only from what follows git commit', () => {
  assert.deepEqual(["cat > notes.md <<'EOF'\n# Notes\nEOF\ngit add . && git commit -m \"docs: notes\"", 'git tag -a v1 -m "release" && git commit -m "feat: x"',
    "git commit -F - <<'EOF'\nfix: from stdin\nEOF", 'git commit -m "$(date)"', 'ls -m', 'git commit -m ""'].map(commitSubject),
    ['docs: notes', 'feat: x', 'fix: from stdin', null, null, null]);
});
test('a path under $HOME shows as ~/, the cwd wins, and a sibling directory is not inside', () => {
  const home = process.env.HOME;
  process.env.HOME = '/Users/dev';
  try {
    assert.deepEqual([relPath('/Users/dev/.config/x', '/Users/dev/p'), relPath('/Users/dev/p2/a.js', '/Users/dev/p'), relPath('/Users/dev/p/a.js', '/Users/dev/p/'),
      relPath('/Users/dev/p', '/Users/dev/p'), relPath('/Users/dev', '/Users/dev/p'), relPath('rel/a.js', '/Users/dev/p'), relPath(undefined, '/x')],
    ['~/.config/x', '~/p2/a.js', 'a.js', '.', '~', 'rel/a.js', '']);
  } finally { if (home === undefined) delete process.env.HOME; else process.env.HOME = home; }
});
test('odd inputs read as empty, not as errors', () => {
  assert.deepEqual([isTestCommand(undefined), isCommitCommand(null), commitSubject(7), parseTestOutcome(undefined, false), parseTestOutcome(null, true),
    resultText(null, null), resultText({ type: 'image' }, { content: [{ type: 'image' }, null] }), firstSentence(undefined), firstSentence('   \n \n')],
  [false, false, null, { status: 'not-reported' }, { status: 'failed' }, '', '', '', '']);
  assert.deepEqual(parseTestOutcome('99999999999 passed', true), { status: 'failed' });
  assert.equal(firstSentence('x'.repeat(200)), 'x'.repeat(79) + '…');
});

// These run in the process that answers Claude Code's hooks, on text that can be hundreds of KB:
// no parser may be superlinear on degenerate input. The bound is generous so it is never flaky;
// the pinned regexes were measured at a few ms.
test('degenerate 200 KB inputs cannot hold the event loop', () => {
  const N = 200 * 1024, rep = (s) => s.repeat(Math.ceil(N / s.length)).slice(0, N);
  const inputs = {
    'git -c x': rep('git -c x '), 'git -C': rep('git -C '), 'git --a': rep('git --a=b '), 'npm': rep('npm '), 'npm --prefix': rep('npm --prefix '),
    'node --': rep('node --x '), 'node --test': rep('node --test '), '--test': rep('--test '), 'node a|': rep('node a|'),
    'spaces': ' '.repeat(N), 'spaces then git': ' '.repeat(N) + 'git', 'spaces then npm': ' '.repeat(N) + 'npm',
    'word chars': 'a'.repeat(N), 'word chars then test': 'a'.repeat(N) + ' test', 'digits': '1'.repeat(N),
    'pytest': rep('pytest-'), 'python -m': rep('python -m '), 'npx': rep('npx '), 'jest': rep('jest'), 'go': rep('go '), 'cargo': rep('cargo '),
    'commit': rep('commit '), 'git commit': rep('git commit-'), 'quote': '"'.repeat(N), 'backslash': '\\'.repeat(N),
    'one line, no newline': rep('x y '), 'heredoc open': rep('<<EOF '), 'heredoc open, one line': '<<' + 'E'.repeat(N), 'heredoc \\n': rep('<<-"A"\n'),
    'dash m': rep(' -m '), 'dash m quote': rep(' -m "'), '--message': rep(' --message='), '-m open': ' -m "' + 'a'.repeat(N),
    'pass 1': rep('pass 1 '), 'ℹ pass 1': rep('ℹ pass 1\n'), '# fail': rep('# fail 1\n'), '1 passed': rep('1 passed, '), '1 failed': rep('1 failed '),
    'digits then space': rep('1 '), 'Test Suites': rep('Test Suites: 1 passed\n'), 'newlines': '\n'.repeat(N),
    'markers': '#'.repeat(N) + ' x', 'dashes': '- '.repeat(N / 2), 'ticks': '`'.repeat(N), 'stars': '*'.repeat(N), 'ordered': '1. '.repeat(N / 3),
    'sentence ends': rep('a. '), 'dots': '.'.repeat(N), 'bangs': '!? '.repeat(N / 3), 'long word': 'w'.repeat(N), 'blank lines then text': '\n \n'.repeat(N / 3) + 'x',
    'tabs': '\t'.repeat(N), 'unicode': rep('ℹ '), 'slashes': '/'.repeat(N),
  };
  const fns = {
    isTestCommand: (s) => isTestCommand(s), isCommitCommand: (s) => isCommitCommand(s), commitSubject: (s) => commitSubject(s),
    parseTestOutcome: (s) => parseTestOutcome(s, false), parseTestOutcomeErr: (s) => parseTestOutcome(s, true),
    resultText: (s) => resultText(s, {}), resultTextObj: (s) => resultText({ stdout: s, stderr: s }, {}),
    resultTextBlocks: (s) => resultText(undefined, { content: [{ type: 'text', text: s }, { type: 'text', text: s }] }),
    firstSentence: (s) => firstSentence(s), relPath: (s) => relPath(s, '/Users/dev/p'),
  };
  for (const [fname, fn] of Object.entries(fns)) for (const [iname, input] of Object.entries(inputs)) {
    const t0 = performance.now();
    fn(input);
    const ms = performance.now() - t0;
    assert.ok(ms < 200, `${fname}(${iname}) took ${ms.toFixed(0)} ms`); // fails at the first slow call, not after all of them
  }
});
