// The hook installer, run against a throwaway Claude config dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hasPromptHook } from '../src/sessions/index.js';
import { BG_HOLD_MS } from '../src/background.js';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'install-hooks.js');

function install(existing) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  if (existing) fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(existing));
  execFileSync(process.execPath, [script], { env: { ...process.env, CLAUDE_CONFIG_DIR: dir }, stdio: 'pipe' });
  return JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
}

test('installs a 600 s PreToolUse hold hook for questions and plans', () => {
  const s = install({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine' }] }] } });
  const hold = s.hooks.PreToolUse.find((e) => e.matcher === 'AskUserQuestion|ExitPlanMode');
  assert.ok(hold);
  assert.equal(hold.hooks[0].timeout, 600);
  assert.ok(hold.hooks[0].timeout * 1000 > BG_HOLD_MS, 'the hook outlasts a background hold, so the deny gets back to Claude');
  assert.match(hold.hooks[0].url, /^http:\/\/127\.0\.0\.1:8790\/hook\?hold=1$/);
  assert.ok(s.hooks.PreToolUse.some((e) => e.matcher === '*'), 'the store-updating hook stays');
  assert.ok(s.hooks.PreToolUse.some((e) => JSON.stringify(e).includes('"mine"')), 'the owner\'s own hooks are kept');
  assert.ok(hasPromptHook(s));
});

test('running it twice does not duplicate hooks', () => {
  const once = install(null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(once));
  execFileSync(process.execPath, [script], { env: { ...process.env, CLAUDE_CONFIG_DIR: dir }, stdio: 'pipe' });
  const twice = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.equal(twice.hooks.PreToolUse.length, once.hooks.PreToolUse.length);
});

test('hasPromptHook is false without the hold hook', () => {
  assert.equal(hasPromptHook({}), false);
  assert.equal(hasPromptHook({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'http', url: 'http://127.0.0.1:8790/hook' }] }] } }), false);
});

test('installs the Stop asyncRewake command hook for waking idle sessions, once', () => {
  const s = install(null);
  const rewake = s.hooks.Stop.filter((e) => JSON.stringify(e).includes('rewake-hook.js'));
  assert.equal(rewake.length, 1);
  const h = rewake[0].hooks[0];
  assert.equal(h.type, 'command');
  assert.equal(h.asyncRewake, true);
  assert.equal(h.timeout, 3600);
  assert.match(h.command, /node.* ".*scripts\/rewake-hook\.js" 8790$/, 'the port travels with the command');
  assert.ok(s.hooks.Stop.some((e) => JSON.stringify(e).includes(':8790/hook')), 'the http Stop hook stays');
});

test('uninstall removes every hook of ours, including the rewake command, and keeps the owner\'s', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'mine' }] }] } }));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: dir };
  execFileSync(process.execPath, [script], { env, stdio: 'pipe' });
  execFileSync(process.execPath, [script.replace('install-hooks', 'uninstall-hooks')], { env, stdio: 'pipe' });
  const s = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  const flat = JSON.stringify(s);
  assert.doesNotMatch(flat, /rewake-hook|:8790\/hook/);
  assert.match(flat, /"mine"/);
});

test('settings that do not parse are left exactly as they are', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  const file = path.join(dir, 'settings.json');
  const original = '{ "model": "opus", "permissions": { "allow": ["Bash(ls)"] }, }';   // trailing comma
  fs.writeFileSync(file, original);
  let failed = false;
  try {
    execFileSync(process.execPath, [script], { env: { ...process.env, CLAUDE_CONFIG_DIR: dir }, stdio: 'pipe' });
  } catch (e) {
    failed = true;
    assert.match(String(e.stderr), /could not read/i);
  }
  assert.ok(failed, 'the installer refuses instead of writing hooks-only settings');
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('an owner hook sharing a matcher group with ours survives install and uninstall', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ hooks: { Stop: [{ matcher: '*', hooks: [
    { type: 'http', url: 'http://127.0.0.1:8790/hook', timeout: 5 },
    { type: 'command', command: 'say done' },
  ] }] } }));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: dir };
  execFileSync(process.execPath, [script], { env, stdio: 'pipe' });
  assert.match(fs.readFileSync(file, 'utf8'), /say done/, 'kept by install');
  execFileSync(process.execPath, [script.replace('install-hooks', 'uninstall-hooks')], { env, stdio: 'pipe' });
  const flat = fs.readFileSync(file, 'utf8');
  assert.match(flat, /say done/, 'kept by uninstall');
  assert.doesNotMatch(flat, /:8790\/hook|rewake-hook/);
});

test('installs a StopFailure http hook, and uninstall takes it out again', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  const file = path.join(dir, 'settings.json');
  const env = { ...process.env, CLAUDE_CONFIG_DIR: dir };
  execFileSync(process.execPath, [script], { env, stdio: 'pipe' });
  const installed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(installed.hooks.StopFailure, 'a failed turn reaches the daemon');
  assert.ok(JSON.stringify(installed.hooks.StopFailure).includes(':8790/hook'));
  assert.equal(installed.hooks.StopFailure[0].hooks[0].type, 'http');
  execFileSync(process.execPath, [script.replace('install-hooks', 'uninstall-hooks')], { env, stdio: 'pipe' });
  const removed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal((removed.hooks || {}).StopFailure, undefined);
});
