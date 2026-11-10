import { test } from 'node:test';
import assert from 'node:assert/strict';
import { presetTarget, sectionOf } from '../src/shell.js';

test('1 opens Tasks from anywhere', () => {
  for (const r of ['home', 'audio', 'list', 'session', 'queue', 'nucbox', 'tasks', 'task', 'focus']) {
    assert.equal(presetTarget('1', r, false), '#/tasks');
  }
});

test('2 opens Agents, and pressed again cycles sessions, usage, NucBox', () => {
  assert.equal(presetTarget('2', 'home', false), '#/list');
  assert.equal(presetTarget('2', 'session', false), '#/list');
  assert.equal(presetTarget('2', 'list', false), '#/usage');
  assert.equal(presetTarget('2', 'usage', false), '#/nucbox');
  assert.equal(presetTarget('2', 'nucbox', false), '#/list');
});

test('2 still cycles sessions, usage, NucBox with no digest stop, and goes to the list from anywhere else', () => {
  assert.deepEqual(['list', 'usage', 'nucbox'].map((r) => presetTarget('2', r, false)), ['#/usage', '#/nucbox', '#/list']);
  for (const r of ['home', 'session', 'digest', 'queue', 'tasks']) assert.equal(presetTarget('2', r, false), '#/list', r);
});

test('3 opens the queue; on the queue (or a permission prompt) it is the card\'s own action', () => {
  assert.equal(presetTarget('3', 'home', false), '#/queue');
  assert.equal(presetTarget('3', 'queue', false), '#/queue', 'an empty queue has nothing to act on');
  assert.equal(presetTarget('3', 'queue', true), 'deny', 'deny a permission, dismiss an expired card, finish a multi-select');
  assert.equal(presetTarget('3', 'ask', true), 'deny');
  assert.equal(presetTarget('3', 'list', true), '#/queue', 'a card elsewhere is not on screen');
});

test('4 opens Home, and pressed again walks Home and Audio', () => {
  assert.equal(presetTarget('4', 'tasks', false), '#/home');
  assert.equal(presetTarget('4', 'queue', true), '#/home', 'deny moved to 3');
  assert.equal(presetTarget('4', 'home', false), '#/audio');
  assert.equal(presetTarget('4', 'audio', false), '#/home');
});

test('the top bar dots know which section a screen belongs to', () => {
  for (const r of ['tasks', 'task', 'focusset', 'focus']) assert.equal(sectionOf(r), 0, r);
  for (const r of ['list', 'session', 'agent', 'digest', 'usage', 'nucbox']) assert.equal(sectionOf(r), 1, r);
  for (const r of ['queue', 'ask', 'prompt']) assert.equal(sectionOf(r), 2, r);
  assert.equal(sectionOf('home'), 3);
  assert.equal(sectionOf('audio'), 3);
  assert.equal(sectionOf('dictate'), -1);
  assert.equal(sectionOf('new'), 1, 'new session is part of the sessions section');
});

test('the top bar shows four dots with the current section lit', async () => {
  const { topbar, setSection } = await import('../src/screens/helpers.js');
  setSection(1);
  const html = topbar('AUDIO', true);
  assert.equal((html.match(/class="sdot[ "]/g) || []).length, 4);
  assert.equal((html.match(/sdot on/g) || []).length, 1);
  assert.ok(html.indexOf('sdot on') > html.indexOf('sdot'), 'the second dot');
  setSection(-1);
  assert.equal((topbar('DICTATION', true).match(/sdot on/g) || []).length, 0);
});

test('cardOnScreen: any queue hero counts (expired prompt, question, permission); on the prompt screen only a permission', async () => {
  const { cardOnScreen } = await import('../src/shell.js');
  assert.equal(cardOnScreen('queue', { kind: 'prompt', expired: true }, null), true);
  assert.equal(cardOnScreen('queue', { kind: 'question' }, null), true);
  assert.equal(cardOnScreen('queue', null, null), false);
  assert.equal(cardOnScreen('ask', null, { kind: 'permission' }), true);
  assert.equal(cardOnScreen('home', { kind: 'permission' }, null), false);
});

test('preset 3 on a card hero is the context action (CLEAR), not navigation', async () => {
  const { cardOnScreen } = await import('../src/shell.js');
  assert.equal(cardOnScreen('queue', { kind: 'card' }, null), true);
  assert.equal(presetTarget('3', 'queue', cardOnScreen('queue', { kind: 'card' }, null)), 'deny');
  assert.equal(presetTarget('3', 'queue', cardOnScreen('queue', null, null)), '#/queue', 'an empty queue has no hero to clear');
  assert.equal(presetTarget('3', 'home', cardOnScreen('home', { kind: 'card' }, null)), '#/queue', 'a card on another screen is not on screen');
});
