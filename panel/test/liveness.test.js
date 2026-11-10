import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveness } from '../src/liveness.js';

test('a link that has heard nothing for the timeout is dead', () => {
  let t = 1000;
  const l = createLiveness({ timeoutMs: 15000, now: () => t });
  l.heard();
  t += 14000;
  assert.equal(l.dead(), false);
  t += 2000;
  assert.equal(l.dead(), true);
  l.heard();
  assert.equal(l.dead(), false, 'any frame revives it');
});
