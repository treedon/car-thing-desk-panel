// Pure parsers for the digest extractor: is a Bash command a test run or a git commit, what a
// test run's output says, a commit subject, a first sentence, a relative path. No I/O.
//
// These run in the process that answers Claude Code's hooks, on command and output text that can
// be hundreds of KB, so none of them may be superlinear on degenerate input ("nothing in the digest
// path slows a hook response"). The patterns below are the specified ones with these changes, each
// with its reason:
//   - a gap of unbounded `[^|;&]*` (node ... --test) and an unbounded flag chain (git ... commit)
//     are bounded: every `node ` / `git ` in a long command otherwise rescans the rest of it;
//   - `\s*` at the start of a line (m flag) is `[ \t]*`: `\s*` runs across blank lines, so a long
//     run of newlines is rescanned from every line start;
//   - a count is `(?<!\d)\d{1,9}`: an unanchored `\d+` rescans a long digit run from every digit,
//     and a count of ten or more digits is not a test count;
//   - the heredoc is found by an opener pattern and a per-tag terminator search, not by one lazy
//     pattern with a backreference, which rescans the rest of the command from every `<<`.
// On ordinary commands and outputs each change matches exactly what the specified pattern did.

import os from 'node:os';

export const TEST_RUNNERS = [
  /\bnpm\s+(?:--prefix\s+\S+\s+)?(?:run\s+)?test\b(?![-\w.])/, /\bnode\s+(?:[^|;&]{0,200}\s)?--test\b/,
  /(?:^|[\s;&|(])(?:python3?\s+-m\s+)?pytest\b(?![-\w.])/, /(?:^|[\s;&|(])(?:npx\s+|yarn\s+|pnpm\s+)?(?:jest|vitest)(?:\s|$)/,
  /\bgo\s+test\b/, /\bcargo\s+test\b/,
];

export function isTestCommand(cmd) {
  return typeof cmd === 'string' && TEST_RUNNERS.some((re) => re.test(cmd));
}

// Counts: every match of both is summed; jest/vitest file tallies are skipped.
const SUMMARY_LINE = /^[ \t]*Test (?:Suites|Files)\b.*$/gm;
const NODE_TAP = /^[ \t]*(?:ℹ|#)[ \t]*(pass|fail)[ \t]+(\d{1,9})[ \t]*$/gm;
const WORDS = /(?<!\d)(\d{1,9})\s+(passed|failed)\b/g;

// TestOutcome: a parsed count wins; else a failed run (is_error) is 'failed'; else nothing was reported.
export function parseTestOutcome(output, isError) {
  const text = typeof output === 'string' ? output.replace(SUMMARY_LINE, '') : '';
  let passed = 0, failed = 0, seen = false;
  const add = (kind, n) => { seen = true; if (kind === 'pass' || kind === 'passed') passed += Number(n); else failed += Number(n); };
  for (const m of text.matchAll(NODE_TAP)) add(m[1], m[2]);
  for (const m of text.matchAll(WORDS)) add(m[2], m[1]);
  if (seen) return { status: 'counted', passed, failed };
  return isError ? { status: 'failed' } : { status: 'not-reported' };
}

// `git`, then up to eight global options (-C dir, -c k=v, --flag[=v]), then `commit` as a whole word.
const COMMIT = /\bgit(?:\s+(?:-C\s+\S+|-c\s+\S+|--[\w-]+(?:=\S+)?)){0,8}\s+commit(?![-\w])/;

export function isCommitCommand(cmd) {
  return typeof cmd === 'string' && COMMIT.test(cmd);
}

const HEREDOC_OPEN = /(?<!<)<<-?[ \t]*['"]?(\w{1,40})['"]?[ \t\r]*\n/g;
const MESSAGE = /(?:\s-[a-zA-Z]*m|\s--message)(?:=|\s+)(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))/;
const MAX_HEREDOCS = 5; // each unterminated one costs a scan of the rest; a commit has one or two

// The first non-empty line of s, trimmed, or null. Walks the lines, never splits the whole text.
function firstLine(s) {
  for (let from = 0; from < s.length;) {
    let nl = s.indexOf('\n', from);
    if (nl < 0) nl = s.length;
    const line = s.slice(from, nl).trim();
    if (line) return line;
    from = nl + 1;
  }
  return null;
}

// The subject of a `git commit`: the first line of a heredoc message, else of the -m / --message value,
// else null (-F, --amend --no-edit, or a message built by a command substitution). Only what follows
// `git commit` is read, so a file written by an earlier heredoc or an earlier `git tag -m` is not the subject.
export function commitSubject(cmd) {
  if (typeof cmd !== 'string') return null;
  const at = COMMIT.exec(cmd);
  if (!at) return null;
  const tail = cmd.slice(at.index);
  HEREDOC_OPEN.lastIndex = 0;
  for (let n = 0, open; n < MAX_HEREDOCS && (open = HEREDOC_OPEN.exec(tail)); n++) {
    const rest = tail.slice(HEREDOC_OPEN.lastIndex);
    const end = new RegExp('\\n[ \\t]*' + open[1] + '\\b').exec(rest);
    if (!end) continue;
    const line = firstLine(rest.slice(0, end.index));
    if (line) return line;
  }
  const m = MESSAGE.exec(tail);
  if (!m) return null;
  const value = m[1] ?? m[2] ?? m[3];
  if (value.startsWith('$(')) return null;
  return firstLine(value);
}

// The text of a Bash result. Claude Code stores a finished command as {stdout, stderr}, a failed one as a
// string; the tool_result block's own content (a string or text blocks) is the fallback.
export function resultText(toolUseResult, block) {
  if (typeof toolUseResult === 'string') return toolUseResult;
  if (toolUseResult && typeof toolUseResult === 'object' && (typeof toolUseResult.stdout === 'string' || typeof toolUseResult.stderr === 'string'))
    return (toolUseResult.stdout || '') + '\n' + (toolUseResult.stderr || '');
  const content = block && block.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  return '';
}

// One line, markdown stripped, up to its first sentence end and at most max chars (ending in … when cut).
export function firstSentence(text, max = 80) {
  if (typeof text !== 'string') return '';
  let line = '';
  for (let from = 0; from < text.length;) {
    let nl = text.indexOf('\n', from);
    if (nl < 0) nl = text.length;
    const raw = text.slice(from, nl);
    from = nl + 1;
    if (!raw.trim()) continue; // the first non-empty line, and only that one
    line = raw.replace(/^\s*(?:#{1,6}\s+|[-*>]\s+|\d{1,3}\.\s+)/, '').replace(/`/g, '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
    break;
  }
  const end = /[.!?](?: |$)/.exec(line);
  if (end) line = line.slice(0, end.index + 1);
  if (line.length <= max) return line;
  const space = line.lastIndexOf(' ', max - 1);
  return line.slice(0, space > 0 ? space : max - 1) + '…';
}

// A path as the digest shows it: relative inside cwd, ~/… under $HOME, else unchanged.
export function relPath(filePath, cwd) {
  if (typeof filePath !== 'string') return '';
  // what follows dir in filePath ('' when it is dir itself), or null when filePath is not inside dir
  const below = (dir) => {
    const d = typeof dir === 'string' ? dir.replace(/\/+$/, '') : '';
    if (!d) return null;
    if (filePath === d) return '';
    return filePath.startsWith(d + '/') ? filePath.slice(d.length + 1) : null;
  };
  const inCwd = below(cwd);
  if (inCwd !== null) return inCwd || '.';
  const inHome = below(process.env.HOME || os.homedir());
  if (inHome !== null) return inHome ? '~/' + inHome : '~';
  return filePath;
}
