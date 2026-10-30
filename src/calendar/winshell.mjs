// Starting a program on Windows without letting cmd.exe read the arguments as commands.
//
// Claude Code installed with npm is a `claude.cmd` shim, and Node refuses to start a .cmd without a shell (and a shell reads `&`, `|`, `%`, `^`,
// `(`, `)` and quotes as commands). So, in order of preference:
//   1. not a shim (claude.exe, any program on macOS or Linux): start it directly, arguments untouched, no shell;
//   2. a shim whose real target can be read from it (npm's shim names `...\cli.js` or `...\claude.exe`): start that target directly, no shell;
//   3. anything else: one command line for cmd.exe in which the program and EVERY argument are escaped (after cross-spawn and qntm.org/cmd),
//      so a model name like `x&calc` or a folder with a space in its name is only text.
// Pure functions: nothing here starts a program, so each path is tested without one.

import { existsSync, readFileSync } from 'node:fs';
import { win32 } from 'node:path';

// cmd.exe's special characters (and the space, so a name with spaces is one word).
const META = /([()\][%!^"`<>&|;, *?])/g;

/** Is this a Windows batch file that has to be run through cmd.exe? */
export const isShim = (file) => /\.(cmd|bat)$/i.test(String(file ?? ''));

/**
 * One argument, escaped for a command line that cmd.exe reads and that then goes through a .cmd/.bat file's `%*` (so it is read twice: pass
 * `doubleEscape: false` only for a program started straight from cmd.exe).
 */
export function cmdQuote(arg, { doubleEscape = true } = {}) {
  let s = String(arg ?? '');
  s = s.replace(/(\\*)"/g, '$1$1\\"');        // backslashes before a quote are doubled, and the quote is escaped
  s = s.replace(/(\\*)$/, '$1$1');            // backslashes at the end are doubled (a closing quote follows)
  s = `"${s}"`;
  s = s.replace(META, '^$1');
  if (doubleEscape) s = s.replace(META, '^$1');
  return s;
}

/** The program itself (a path), escaped so that cmd.exe takes it as one word. */
export const cmdProgram = (file) => String(file).replace(META, '^$1');

/** A whole command line for cmd.exe: the program and every argument escaped. */
export function cmdLine(file, args = [], opts = {}) {
  return [cmdProgram(file), ...args.map((a) => cmdQuote(a, opts))].join(' ');
}

/**
 * Where an npm-style shim really goes. Reads the shim (its last line that passes `%*` on) and returns the program to start and the leading
 * arguments, or null when it does not look like a shim Nordle understands.
 * @returns {{ command: string, args: string[] } | null}
 */
export function shimTarget(shim, { exists = existsSync, read = (f) => readFileSync(f, 'utf8'), execPath = process.execPath } = {}) {
  let text;
  try { text = String(read(shim)); } catch { return null; }
  const line = text.split(/\r?\n/).filter((l) => l.includes('%*')).pop();
  if (!line) return null;
  const m = /"%(?:~dp0|dp0%)[\\/]*([^"%\r\n]+?\.(cjs|mjs|js|exe))"/i.exec(line);
  if (!m) return null;
  const target = win32.resolve(win32.dirname(win32.normalize(String(shim))), ...m[1].split(/[\\/]/));
  if (!exists(target)) return null;
  if (m[2].toLowerCase() === 'exe') return { command: target, args: [] };
  return { command: execPath, args: [target] };
}

/**
 * What to hand to spawn / spawnSync for `bin` with `args`.
 * @returns {{ command: string, args: string[], options: object, how: 'direct' | 'target' | 'cmd' }}
 *   options is merged into the spawn options ({ shell: true } only for the last-resort command line).
 */
export function launchPlan(bin, args = [], { platform = process.platform, ...deps } = {}) {
  const list = args.map((a) => String(a));
  if (platform !== 'win32' || !isShim(bin)) return { command: bin, args: list, options: {}, how: 'direct' };
  const target = shimTarget(bin, deps);
  if (target) return { command: target.command, args: [...target.args, ...list], options: {}, how: 'target' };
  // Node runs `cmd.exe /d /s /c "<command>"` with the command exactly as written; nothing is added after it
  return { command: cmdLine(bin, list), args: [], options: { shell: true }, how: 'cmd' };
}
