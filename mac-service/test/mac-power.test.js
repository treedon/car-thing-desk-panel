// The Mac's display and sleep state, as the panel needs it: the line parser,
// the helper's stdout framing, the respawn rule, and when the helper gets
// compiled. Nothing here compiles or runs Swift.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createMacPower, ensureHelper } from '../src/mac-power.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

function setup(opts = {}) {
  const changes = [];
  const macPower = createMacPower({ onChange: (s) => changes.push(s), ...opts });
  return { macPower, changes };
}

test('the state starts as display on, awake', () => {
  const { macPower, changes } = setup();
  assert.deepEqual(macPower.get(), { display: 'on', sleeping: false });
  assert.equal(changes.length, 0);
});

test('display off changes the state once, and a repeat changes nothing', () => {
  const { macPower, changes } = setup();
  macPower.feed('display off');
  assert.deepEqual(macPower.get(), { display: 'off', sleeping: false });
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0], { display: 'off', sleeping: false });
  macPower.feed('display off');
  assert.equal(changes.length, 1);
});

test('did wake clears sleeping but leaves the display alone', () => {
  const { macPower, changes } = setup();
  macPower.feed('display off');
  macPower.feed('will sleep');
  assert.deepEqual(macPower.get(), { display: 'off', sleeping: true });
  macPower.feed('did wake');
  assert.deepEqual(macPower.get(), { display: 'off', sleeping: false });
  macPower.feed('display on');
  assert.deepEqual(macPower.get(), { display: 'on', sleeping: false });
  assert.equal(changes.length, 4);
});

test('unknown lines are ignored', () => {
  const { macPower, changes } = setup();
  macPower.feed('garbage');
  macPower.feed('');
  assert.deepEqual(macPower.get(), { display: 'on', sleeping: false });
  assert.equal(changes.length, 0);
});

test('get() hands out a copy, so a caller cannot rewrite the state', () => {
  const { macPower } = setup();
  macPower.get().display = 'off';
  assert.equal(macPower.get().display, 'on');
});

test('lines split across stdout chunks are reassembled', async () => {
  const child = fakeChild();
  const { macPower, changes } = setup({ spawnHelper: () => child });
  macPower.start();
  await tick();
  child.stdout.write('display off\nwill sl');
  await tick();
  assert.equal(changes.length, 1);
  child.stdout.write('eep\n');
  await tick();
  assert.equal(changes.length, 2);
  assert.deepEqual(macPower.get(), { display: 'off', sleeping: true });
  macPower.stop();
});

test('a freshly started helper reports the current display state as its first line', async () => {
  const child = fakeChild();
  const { macPower, changes } = setup({ spawnHelper: () => child });
  macPower.start();
  await tick();
  child.stdout.write('display off\n');
  await tick();
  assert.deepEqual(macPower.get(), { display: 'off', sleeping: false });
  assert.equal(changes.length, 1);
  macPower.stop();
});

test('a (re)launched helper means the system is awake, so a stuck sleeping:true is cleared', async () => {
  const children = [];
  const { macPower, changes } = setup({
    respawnMs: 5,
    spawnHelper: () => { const c = fakeChild(); children.push(c); return c; },
  });
  macPower.start();
  await tick();
  // The helper reports "will sleep", then dies before it can report "did wake".
  children[0].stdout.write('will sleep\n');
  await tick();
  assert.deepEqual(macPower.get(), { display: 'on', sleeping: true });
  children[0].emit('exit', 1, null);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(children.length, 2);
  assert.deepEqual(macPower.get(), { display: 'on', sleeping: false });
  assert.deepEqual(changes, [
    { display: 'on', sleeping: true },
    { display: 'on', sleeping: false },
  ]);
  macPower.stop();
});

test('the first launch fires no change: it starts awake already', async () => {
  const { macPower, changes } = setup({ spawnHelper: () => fakeChild() });
  macPower.start();
  await tick();
  assert.equal(changes.length, 0);
  macPower.stop();
});

test('a spawn that fails keeps the default state, throws nothing, and is not retried', async () => {
  let spawns = 0;
  const { macPower, changes } = setup({
    respawnMs: 5,
    spawnHelper: () => { spawns++; throw new Error('swiftc: command not found'); },
  });
  macPower.start();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(spawns, 1);
  assert.deepEqual(macPower.get(), { display: 'on', sleeping: false });
  assert.equal(changes.length, 0);
});

test('a rejected (async) spawn is handled the same way', async () => {
  let spawns = 0;
  const { macPower } = setup({
    respawnMs: 5,
    spawnHelper: async () => { spawns++; throw new Error('compile failed'); },
  });
  macPower.start();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(spawns, 1);
  assert.deepEqual(macPower.get(), { display: 'on', sleeping: false });
});

test('a helper that exits is respawned, and the new one is listened to', async () => {
  const children = [];
  const { macPower, changes } = setup({
    respawnMs: 5,
    spawnHelper: () => { const c = fakeChild(); children.push(c); return c; },
  });
  macPower.start();
  await tick();
  assert.equal(children.length, 1);
  children[0].emit('exit', 1, null);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(children.length, 2);
  children[1].stdout.write('display off\n');
  await tick();
  assert.equal(changes.length, 1);
  macPower.stop();
});

test('stop() kills the helper and does not respawn it', async () => {
  const children = [];
  const { macPower } = setup({
    respawnMs: 5,
    spawnHelper: () => { const c = fakeChild(); children.push(c); return c; },
  });
  macPower.start();
  await tick();
  macPower.stop();
  assert.equal(children[0].killed, true);
  children[0].emit('exit', null, 'SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(children.length, 1);
});

// ---- ensureHelper: when the binary gets (re)compiled --------------------

function helperDirs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-power-'));
  const source = path.join(dir, 'power-watch.swift');
  const binary = path.join(dir, 'cache', 'power-watch');
  fs.writeFileSync(source, '// swift\n');
  return { dir, source, binary };
}

function fakeCompile(calls) {
  return async (source, out) => { calls.push({ source, out }); fs.writeFileSync(out, 'binary'); };
}

test('ensureHelper compiles when the binary is missing', async () => {
  const { dir, source, binary } = helperDirs();
  const calls = [];
  const got = await ensureHelper({ source, binary, compile: fakeCompile(calls) });
  assert.equal(got, binary);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].source, source);
  assert.ok(fs.existsSync(binary));
  // built beside the final path and renamed in, so a half-written file never counts as current
  assert.notEqual(calls[0].out, binary);
  fs.rmSync(dir, { recursive: true });
});

test('ensureHelper leaves a binary that is newer than the source alone', async () => {
  const { dir, source, binary } = helperDirs();
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, 'binary');
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(source, past, past);
  const calls = [];
  await ensureHelper({ source, binary, compile: fakeCompile(calls) });
  assert.equal(calls.length, 0);
  fs.rmSync(dir, { recursive: true });
});

test('ensureHelper recompiles a binary that is older than the source', async () => {
  const { dir, source, binary } = helperDirs();
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, 'old binary');
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(binary, past, past);
  const calls = [];
  await ensureHelper({ source, binary, compile: fakeCompile(calls) });
  assert.equal(calls.length, 1);
  assert.equal(fs.readFileSync(binary, 'utf8'), 'binary');
  fs.rmSync(dir, { recursive: true });
});

test('ensureHelper leaves the old binary in place when the compile fails', async () => {
  const { dir, source, binary } = helperDirs();
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, 'old binary');
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(binary, past, past);
  await assert.rejects(ensureHelper({
    source, binary, compile: async () => { throw new Error('swiftc failed'); },
  }), /swiftc failed/);
  assert.equal(fs.readFileSync(binary, 'utf8'), 'old binary');
  fs.rmSync(dir, { recursive: true });
});
