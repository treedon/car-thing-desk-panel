// Whether the digest runs at all (config.js, digestEnabled): on by default on the Mac, off with
// CLAUDE_PANEL_DIGEST=0, and never on Windows (the NucBox's service) in this milestone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestEnabled, DIGEST_ENABLED, digestPersists } from '../src/config.js';

test('the digest is on by default on darwin and linux', () => {
  assert.equal(digestEnabled({}, 'darwin'), true);
  assert.equal(digestEnabled({}, 'linux'), true);
});

test('the digest is off on win32', () => {
  assert.equal(digestEnabled({}, 'win32'), false);
});

test('CLAUDE_PANEL_DIGEST=0 turns the digest off on every platform', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    assert.equal(digestEnabled({ CLAUDE_PANEL_DIGEST: '0' }, platform), false, platform);
  }
});

test('CLAUDE_PANEL_DIGEST=1 on win32 stays off: that is deliberate, nothing consumes a NucBox digest', () => {
  assert.equal(digestEnabled({ CLAUDE_PANEL_DIGEST: '1' }, 'win32'), false);
});

test('CLAUDE_PANEL_DIGEST=1 changes nothing on darwin and linux, and only the exact string 0 turns it off', () => {
  for (const platform of ['darwin', 'linux']) {
    assert.equal(digestEnabled({ CLAUDE_PANEL_DIGEST: '1' }, platform), true, platform);
    assert.equal(digestEnabled({ CLAUDE_PANEL_DIGEST: '' }, platform), true, platform);
    assert.equal(digestEnabled({ CLAUDE_PANEL_DIGEST: 'false' }, platform), true, platform);
  }
});

test('the defaults are this process: its environment and its platform', () => {
  assert.equal(digestEnabled(), digestEnabled(process.env, process.platform));
  assert.equal(DIGEST_ENABLED, digestEnabled(process.env, process.platform));
});

// Whether the digest keeps its state in STATE_DIR (config.js, digestPersists): the live service always does; the demo
// (mock sessions) only when CLAUDE_THING_STATE_DIR names a folder, since STATE_DIR is otherwise the checkout's .state/,
// the live service's.
test('digestPersists: the live service keeps its state; the demo only with a state folder set', () => {
  assert.equal(digestPersists({}, false), true, 'live, no state dir');
  assert.equal(digestPersists({}, true), false, 'mock, no state dir');
  assert.equal(digestPersists({ CLAUDE_THING_STATE_DIR: '/tmp/demo-state' }, true), true, 'mock with a state dir');
  assert.equal(digestPersists({ CLAUDE_THING_STATE_DIR: '' }, true), false, 'mock with an empty state dir');
  for (const env of [{}, { CLAUDE_THING_STATE_DIR: '' }, { CLAUDE_THING_STATE_DIR: '/tmp/x' }, { CLAUDE_THING_MOCK: '1' }]) {
    assert.equal(digestPersists(env, false), true, 'live with ' + JSON.stringify(env));
  }
});

// With no arguments it reads the process it runs in: CLAUDE_THING_MOCK (through MOCK_SESSIONS) and
// CLAUDE_THING_STATE_DIR. A child process imports config.js under each environment and prints digestPersists().
// (config.js only computes paths and reads its package.json: the child touches nothing else.)
test('digestPersists defaults to this process: its environment and its mock mode', () => {
  const config = new URL('../src/config.js', import.meta.url).href;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-thing-digest-config-'));
  const persists = (env) => execFileSync(process.execPath,
    ['--input-type=module', '-e', `import { digestPersists } from ${JSON.stringify(config)}; process.stdout.write(String(digestPersists()));`],
    { env, encoding: 'utf8', cwd: path.dirname(fileURLToPath(config)) });
  try {
    assert.equal(persists({ CLAUDE_THING_MOCK: '1' }), 'false', 'the demo with no state folder');
    assert.equal(persists({ CLAUDE_THING_MOCK: '1', CLAUDE_THING_STATE_DIR: tmp }), 'true', 'the demo with a state folder');
    assert.equal(persists({ CLAUDE_THING_MOCK: '1', CLAUDE_THING_STATE_DIR: '' }), 'false', 'the demo with an empty one');
    assert.equal(persists({}), 'true', 'the live service');
    assert.equal(persists({ CLAUDE_THING_STATE_DIR: tmp }), 'true', 'the live service with a state folder');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
