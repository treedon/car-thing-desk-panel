import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tagTurn, lastParagraph, excerptOf } from '../src/turn-tag.js';

test('a closing question is ASKING', () => {
  assert.equal(tagTurn('Done.\n\nWant me to commit this?'), 'asking');
  assert.equal(tagTurn('Should I push it?"'), 'asking');
  assert.equal(tagTurn('Ready — **merge now?**'), 'asking');
});
test('a report is UPDATE', () => {
  assert.equal(tagTurn('Tests pass. Committed as abc123.'), 'update');
  assert.equal(tagTurn('Let me know if you want changes.'), 'update');
  assert.equal(tagTurn(''), 'update');
});
test('question marks inside code do not count', () => {
  assert.equal(tagTurn('Run this:\n\n```\nls ?\n```'), 'update');
  assert.equal(tagTurn('The regex is `a?b`.'), 'update');
});
test('only the last paragraph decides', () => {
  assert.equal(tagTurn('Why did it fail?\n\nIt was the cache. Fixed and pushed.'), 'update');
  assert.equal(tagTurn('Want this?\n\n```\ncode\n```'), 'asking');
  assert.equal(tagTurn('Why?\n\n```\ncut off mid-block ?'), 'asking');
});
test('excerpt is the last paragraph, clipped, never empty', () => {
  assert.equal(lastParagraph('a\n\nb\n'), 'b');
  assert.equal(excerptOf(''), 'finished with no message');
  assert.equal(excerptOf('x'.repeat(500)).length, 401);
});
test('excerpt keeps inline code readable while the tag still ignores it', () => {
  const q = 'Should I rename `foo` to `bar`?';
  assert.equal(excerptOf(q), 'Should I rename foo to bar?');
  assert.equal(tagTurn(q), 'asking');
  assert.equal(excerptOf('The regex is `a?b`.'), 'The regex is a?b.');
});
test('excerpt drops fenced blocks and shows the closing paragraph', () => {
  assert.equal(excerptOf('Intro.\n\n```\nls ?\n```\n\nShip it with `git push`?'), 'Ship it with git push?');
  assert.equal(excerptOf('Want this?\n\n```\ncode\n```'), 'Want this?');
  assert.equal(excerptOf('Why?\n\n```\ncut off mid-block'), 'Why?');
  assert.equal(excerptOf('```\nonly code\n```'), 'finished with no message');
});
