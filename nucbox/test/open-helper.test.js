'use strict';
// The Open in VS Code helper is PowerShell, which the Mac can't run. What it shares with the session
// service (the task's name, the folder they trade files in, the prompt it types in, the age past which
// a request is dead) is checked here by reading the scripts as text, against the service's own
// constants, so one side can't change without the other. How the helper behaves is checked by hand on
// the NucBox with -DryRun.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const nucbox = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(nucbox, name), 'utf8');
// mac-service is an ES module package; this file is not.
const service = (file) => import(pathToFileURL(path.join(nucbox, '..', 'mac-service', 'src', file)).href);
// A file's code without its comments, which can say anything (the header names the number 60000, for
// one) and so must never satisfy a check on what the code does. No `#` sits inside a string in these
// scripts, so everything from one to the end of the line is a comment.
const codeLines = (text) => text.split(/\r?\n/).map((l) => l.replace(/(^|\s)#.*$/, '$1')).filter((l) => l.trim());
const code = (name) => codeLines(read(name)).join('\n');

test('install.ps1 and uninstall.ps1 name the helper task as the service does', async () => {
  const { OPEN_TASK } = await service('desktop-open.js');
  assert.ok(code('install.ps1').includes(`'${OPEN_TASK}'`), 'install.ps1');
  assert.ok(code('uninstall.ps1').includes(`'${OPEN_TASK}'`), 'uninstall.ps1');
});

test('the helper adds the continue prompt the service means', async () => {
  const { CONTINUE_PROMPT } = await service('handoff.js');
  assert.ok(code('open-in-vscode.ps1').includes(`&prompt=${encodeURIComponent(CONTINUE_PROMPT)}`));
});

test('the helper refuses requests older than the service allows', async () => {
  const { REQUEST_MAX_AGE_MS } = await service('desktop-open.js');
  // The comparison itself, on the line that answers `stale`: the number also sits in the header comment.
  const check = codeLines(read('open-in-vscode.ps1')).filter((l) => new RegExp(`-gt ${REQUEST_MAX_AGE_MS}\\b`).test(l));
  assert.equal(check.length, 1, `one age check at ${REQUEST_MAX_AGE_MS}`);
  assert.match(check[0], /'stale'/);
});

test('the helper reads where the service writes', () => {
  assert.ok(code('open-in-vscode.ps1').includes('.config\\claude-panel\\open-in-vscode'));
});

test('the helper opens the link the Mac opens', () => {
  // focus.js builds `vscode://anthropic.claude-code/open?session=${sessionId}`.
  assert.ok(code('open-in-vscode.ps1').includes('vscode://anthropic.claude-code/open?session='));
});

test('no firewall rule for the helper', () => {
  const rules = read('install.ps1').split(/\r?\n/).filter((l) => /Allow-Inbound/.test(l));
  assert.ok(rules.length > 0, 'the other tasks still have theirs');
  for (const line of rules) assert.doesNotMatch(line, /open-in-vscode|Open in VS Code|\$openTask/i);
});

test('the task runs the helper without a window, with the wait the helper defaults to', () => {
  const install = code('install.ps1');
  assert.match(install, /conhost\.exe/);
  assert.match(install, /--headless powershell\.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File/);
  const wait = /-DelayMs (\d+)/.exec(install);
  assert.ok(wait, 'install.ps1 passes -DelayMs');
  assert.match(code('open-in-vscode.ps1'), new RegExp(`\\[int\\]\\$DelayMs = ${wait[1]}\\b`));
});

test('the task starts only when asked, as the owner, in their own session', () => {
  const block = read('install.ps1').split(/\r?\n/).filter((l) => /\$open/.test(l)).join('\n');
  assert.match(block, /LogonType Interactive/);
  assert.match(block, /RunLevel Limited/);
  assert.doesNotMatch(block, /New-ScheduledTaskTrigger/, 'no trigger');
  assert.doesNotMatch(block, /Start-ScheduledTask/, 'registering must not run it');
});

test('the helper keeps a cold-started Code.exe off the task\'s console, before it starts it', () => {
  // The task's action is conhost --headless powershell. A Code.exe started cold attaches to its parent's
  // console, which keeps that conhost (the task's action) alive for as long as VS Code runs: the task
  // stays Running to its time limit, and the next request queues behind it and times out. Electron's
  // switch for it is this variable; the comment in the script says so, so only the code is read here.
  const lines = codeLines(read('open-in-vscode.ps1'));
  const set = lines.findIndex((l) => /^\s*\$env:ELECTRON_NO_ATTACH_CONSOLE\s*=\s*'1'\s*$/.test(l));
  assert.ok(set >= 0, 'sets $env:ELECTRON_NO_ATTACH_CONSOLE = \'1\'');
  const starts = lines.map((l, i) => (/Start-Process\s+-FilePath\s+\$code\b/.test(l) ? i : -1)).filter((i) => i >= 0);
  assert.equal(starts.length, 1, 'one Start-Process of Code.exe');
  assert.ok(set < starts[0], 'the variable is set before Code.exe is started');
  // Only the real open sets it: the dry run opens nothing.
  const dry = lines.findIndex((l) => /^\s*if \(\$DryRun\)/.test(l));
  assert.ok(dry >= 0 && dry < set, 'set after the -DryRun return');
});

test('the helper reads UTF-8 and writes it without a BOM', () => {
  const code = codeLines(read('open-in-vscode.ps1')).join('\n');
  assert.match(code, /Get-Content[^\n]*-Raw[^\n]*-Encoding UTF8/);
  assert.match(code, /UTF8Encoding\s*\(?\s*\$false/);
  assert.doesNotMatch(code, /Set-Content|Out-File|Add-Content/);
});

test('the helper uses only what Windows PowerShell 5.1 has', () => {
  for (const line of codeLines(read('open-in-vscode.ps1'))) {
    assert.doesNotMatch(line, /\?\?|&&|\|\||\?\./, line.trim());
  }
});
