// Starting Claude Code (or npm) from a .cmd launcher on Windows without cmd.exe reading the arguments as commands.
// Pure functions are tested directly; one test (Windows only) round-trips awkward arguments through a real cmd.exe and a stand-in .cmd that just prints what it
// received. The real Claude is never started.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { cmdLine, cmdProgram, cmdQuote, isShim, launchPlan, shimTarget } from '../src/calendar/winshell.mjs';
import { runClaude } from '../src/calendar/run.mjs';

const HOSTILE = [
  '--model', 'x&echo INJECTED', 'x | calc', 'a b', '100%', '%PATH%', '^caret', '"quoted"', 'trailing\\', 'back\\\\"slash', 'redir>y', 'semi;colon', 'bang!', 'tick`', '',
  '(paren)', 'a,b', 'wild*card?', 'C:\\Users\\Some One\\x.txt', 'Bash(node "C:/tools/nordle/nordle.mjs" reel:*)', 'Read(./.nordle/**)',
];

// npm's shim for a package that ships a JavaScript file (as npm writes it), and for one that ships a program
const npmJsShim = (target) => [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
  `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`, '',
].join('\r\n');
const NPM_JS_SHIM = npmJsShim('node_modules\\@anthropic-ai\\claude-code\\cli.js');
const NPM_EXE_SHIM = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n';

const fakeDisk = (files) => ({ exists: (p) => Object.hasOwn(files, String(p).replace(/\\/g, '/')), read: (p) => { const t = files[String(p).replace(/\\/g, '/')]; if (t === undefined) throw new Error('ENOENT'); return t; } });

test('isShim: only .cmd and .bat need cmd.exe', () => {
  assert.deepEqual(['claude.cmd', 'C:/x/CLAUDE.BAT', 'claude.exe', 'claude', '/usr/bin/claude', ''].map(isShim), [true, true, false, false, false, false]);
});

test('cmdQuote: every character cmd.exe treats as a command is escaped, twice for a .cmd file', () => {
  assert.equal(cmdQuote('plain', { doubleEscape: false }), '^"plain^"');
  assert.equal(cmdQuote('x&calc', { doubleEscape: false }), '^"x^&calc^"');
  assert.equal(cmdQuote('x&calc'), '^^^"x^^^&calc^^^"');
  assert.equal(cmdQuote('100%', { doubleEscape: false }), '^"100^%^"');
  assert.equal(cmdQuote('a b', { doubleEscape: false }), '^"a^ b^"');
  assert.equal(cmdQuote('say "hi"', { doubleEscape: false }), '^"say^ \\^"hi\\^"^"');
  assert.equal(cmdQuote('dir\\', { doubleEscape: false }), '^"dir\\\\^"', 'a backslash before the closing quote is doubled');
  assert.equal(cmdQuote('', { doubleEscape: false }), '^"^"');
  assert.equal(cmdProgram('C:\\Program Files\\nodejs\\npm.cmd'), 'C:\\Program^ Files\\nodejs\\npm.cmd');
});

test('cmdLine: whatever the arguments hold, nothing is left that cmd.exe could run', () => {
  const line = cmdLine('C:\\Users\\Some One\\AppData\\Roaming\\npm\\claude.cmd', HOSTILE);
  // take away every caret-escaped character: what is left must hold no command character, only the plain separators between words
  const left = line.replace(/\^./g, '');
  assert.doesNotMatch(left, /[&|<>()%!"`;,*?\[\]]/, left);
  assert.ok(line.startsWith('C:\\Users\\Some^ One\\'), 'the program is one word');
  assert.ok(!line.includes('x&echo'), 'the ampersand is escaped');
});

test('shimTarget: finds the real program behind npm\'s shim, and says nothing for a shim it does not understand', () => {
  const dir = 'C:/Users/me/AppData/Roaming/npm';
  const js = shimTarget(`${dir}/claude.cmd`, { ...fakeDisk({ [`${dir}/claude.cmd`]: NPM_JS_SHIM, [`${dir}/node_modules/@anthropic-ai/claude-code/cli.js`]: '' }), execPath: 'C:/node/node.exe' });
  assert.equal(js.command, 'C:/node/node.exe');
  assert.equal(js.args.length, 1);
  assert.equal(js.args[0].replace(/\\/g, '/'), `${dir}/node_modules/@anthropic-ai/claude-code/cli.js`);
  const exe = shimTarget(`${dir}/claude.cmd`, fakeDisk({ [`${dir}/claude.cmd`]: NPM_EXE_SHIM, [`${dir}/node_modules/@anthropic-ai/claude-code/bin/claude.exe`]: '' }));
  assert.equal(exe.command.replace(/\\/g, '/'), `${dir}/node_modules/@anthropic-ai/claude-code/bin/claude.exe`);
  assert.deepEqual(exe.args, []);
  assert.equal(shimTarget(`${dir}/claude.cmd`, fakeDisk({ [`${dir}/claude.cmd`]: NPM_JS_SHIM })), null, 'the target must exist');
  assert.equal(shimTarget(`${dir}/claude.cmd`, fakeDisk({ [`${dir}/claude.cmd`]: '@echo off\r\ncall something.bat %*\r\n' })), null);
  assert.equal(shimTarget(`${dir}/claude.cmd`, fakeDisk({})), null, 'a shim that cannot be read');
});

test('launchPlan: no shell unless there is no other way, and then every argument is escaped', () => {
  const dir = 'C:/Users/me/AppData/Roaming/npm';
  // a program that is not a shim, or any program off Windows: started as it is
  assert.deepEqual(launchPlan('C:/x/claude.exe', ['--model', 'x&calc'], { platform: 'win32' }), { command: 'C:/x/claude.exe', args: ['--model', 'x&calc'], options: {}, how: 'direct' });
  assert.deepEqual(launchPlan('/usr/bin/claude', ['a b'], { platform: 'linux' }), { command: '/usr/bin/claude', args: ['a b'], options: {}, how: 'direct' });
  assert.equal(launchPlan('/odd/claude.cmd', ['a'], { platform: 'darwin' }).how, 'direct');
  // a shim whose target can be read: the target is started, no shell
  const viaJs = launchPlan(`${dir}/claude.cmd`, ['--model', 'x&calc'], { platform: 'win32', ...fakeDisk({ [`${dir}/claude.cmd`]: NPM_JS_SHIM, [`${dir}/node_modules/@anthropic-ai/claude-code/cli.js`]: '' }), execPath: 'C:/node/node.exe' });
  assert.equal(viaJs.how, 'target');
  assert.deepEqual(viaJs.options, {});
  assert.equal(viaJs.command, 'C:/node/node.exe');
  assert.deepEqual(viaJs.args.slice(1), ['--model', 'x&calc'], 'the arguments pass untouched');
  const viaExe = launchPlan(`${dir}/claude.cmd`, ['a b'], { platform: 'win32', ...fakeDisk({ [`${dir}/claude.cmd`]: NPM_EXE_SHIM, [`${dir}/node_modules/@anthropic-ai/claude-code/bin/claude.exe`]: '' }) });
  assert.deepEqual([viaExe.how, viaExe.options, viaExe.args], ['target', {}, ['a b']]);
  // last resort: cmd.exe, with the program and every argument escaped, as one command line
  const last = launchPlan('C:/Users/Some One/npm/claude.cmd', HOSTILE, { platform: 'win32', ...fakeDisk({}) });
  assert.equal(last.how, 'cmd');
  assert.deepEqual([last.options, last.args], [{ shell: true }, []]);
  assert.doesNotMatch(last.command.replace(/\^./g, ''), /[&|<>()%!"`;,*?\[\]]/);
  assert.ok(last.command.startsWith('C:/Users/Some^ One/npm/claude.cmd '));
});

test('runClaude: a .cmd launcher is never started with the arguments in the clear', async () => {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin = { on() {}, end() {} };
    setImmediate(() => child.emit('close', 0, null));
    return child;
  };
  const dir = mkdtempSync(join(tmpdir(), 'nordle-shim-'));
  try {
    const bin = join(dir, 'with space', 'claude.cmd');
    await runClaude({ spawn, exec: async () => ({ code: 0 }), bin, args: ['-p', '--model', 'x&echo INJECTED', 'Bash(node "a b":*)'], cwd: dir, env: {}, prompt: 'p', timeoutMs: 5000 });
    assert.equal(calls.length, 1);
    if (process.platform === 'win32') {
      assert.equal(calls[0].opts.shell, true);
      assert.deepEqual(calls[0].args, [], 'the whole command line is one escaped string');
      assert.doesNotMatch(calls[0].cmd.replace(/\^./g, ''), /[&|<>()%!"`;,*?\[\]]/);
      assert.equal(calls[0].opts.windowsHide, true);
    } else {
      assert.equal(calls[0].cmd, bin);
      assert.deepEqual(calls[0].args, ['-p', '--model', 'x&echo INJECTED', 'Bash(node "a b":*)']);
      assert.equal(calls[0].opts.shell, undefined);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Windows: awkward arguments reach a program intact through a real cmd.exe and a .cmd launcher in a folder with a space', { skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'nordle-cmd-'));
  try {
    const home = join(dir, 'with space', 'npm');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'print-args.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
    // a launcher the shim reader cannot follow (the program is named by a full path), so the cmd.exe command line is what is tested; and an npm-style one
    writeFileSync(join(home, 'odd.cmd'), `@echo off\r\n"${process.execPath}" "${join(home, 'print-args.js')}" %*\r\n`);
    writeFileSync(join(home, 'claude.cmd'), npmJsShim('print-args.js'));
    for (const [name, how] of [['odd.cmd', 'cmd'], ['claude.cmd', 'target']]) {
      const plan = launchPlan(join(home, name), HOSTILE);
      assert.equal(plan.how, how, name);
      const r = spawnSync(plan.command, plan.args, { encoding: 'utf8', windowsHide: true, ...plan.options });
      assert.equal(r.error, undefined);
      assert.ok(!r.stdout.includes('INJECTED') || r.stdout.startsWith('['), 'nothing was run as a command');
      assert.deepEqual(JSON.parse(r.stdout), HOSTILE, name);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
