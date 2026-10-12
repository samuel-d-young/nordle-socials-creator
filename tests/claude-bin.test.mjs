// Finding Claude Code: on the PATH, where the installers put it, or inside the Claude desktop app. A fake file system stands in for each computer; nothing is started.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findClaude, missingClaudeMessage } from '../src/calendar/claude-bin.mjs';

/** A pretend disk: the list of files that exist. Directories exist when a file is below them. */
function disk(files) {
  const norm = (p) => String(p).replace(/\\/g, '/');
  const all = files.map(norm);
  return {
    exists: (p) => all.includes(norm(p)) || all.some((f) => f.startsWith(`${norm(p)}/`)),
    isFile: (p) => all.includes(norm(p)),
    access: (p) => { if (!all.includes(norm(p))) throw new Error('no'); },
    readdir: (d) => {
      const base = `${norm(d)}/`;
      const seen = new Map();
      for (const f of all) if (f.startsWith(base)) { const rest = f.slice(base.length); const [first, ...more] = rest.split('/'); seen.set(first, more.length > 0); }
      if (!seen.size) throw new Error('ENOENT');
      return [...seen].map(([name, isDir]) => ({ name, isDirectory: () => isDir }));
    },
  };
}
const mac = (files, env = {}) => findClaude({ platform: 'darwin', home: '/Users/me', env: { PATH: '/usr/bin:/bin', ...env }, fs: disk(files) });

test('on the PATH: the first one found wins', () => {
  const r = mac(['/opt/homebrew/bin/claude'], { PATH: '/usr/bin:/opt/homebrew/bin' });
  assert.deepEqual([r.path, r.how], ['/opt/homebrew/bin/claude', 'the PATH']);
});

test('not on the PATH (a Mac app launched from Finder has a short one): the installer\'s own folders are tried', () => {
  assert.equal(mac(['/Users/me/.local/bin/claude']).path, '/Users/me/.local/bin/claude');
  assert.equal(mac(['/Users/me/.claude/local/claude']).path, '/Users/me/.claude/local/claude');
  assert.equal(mac(['/opt/homebrew/bin/claude']).path, '/opt/homebrew/bin/claude');
  assert.equal(mac(['/Users/me/.nvm/versions/node/v22.1.0/bin/claude', '/Users/me/.nvm/versions/node/v20.0.0/bin/claude']).path, '/Users/me/.nvm/versions/node/v22.1.0/bin/claude', 'the newest node version');
  assert.match(mac(['/Users/me/.local/bin/claude']).how, /installer/);
});

test('only inside the Claude desktop app: the newest version\'s copy is used, however deep it sits', () => {
  const base = '/Users/me/Library/Application Support/Claude/claude-code';
  const r = mac([`${base}/2.1.9/aaa/claude`, `${base}/2.1.295/bbb/claude`, `${base}/2.1.293/ccc/claude`]);
  assert.equal(r.path, `${base}/2.1.295/bbb/claude`, '2.1.295 is newer than 2.1.9 (compared as numbers, not text)');
  assert.equal(r.how, 'the copy inside the Claude desktop app');
  const app = mac([`${base}/2.1.300/ddd/claude.app/Contents/MacOS/claude`]);
  assert.equal(app.path, `${base}/2.1.300/ddd/claude.app/Contents/MacOS/claude`);
});

test('Windows: claude.exe, claude.cmd from npm, and the desktop app\'s copy under AppData', () => {
  const win = (files, env = {}) => findClaude({ platform: 'win32', home: 'C:/Users/me', env: { PATH: 'C:/Windows', APPDATA: 'C:/Users/me/AppData/Roaming', ...env }, fs: disk(files), });
  assert.equal(win(['C:/Users/me/AppData/Roaming/npm/claude.cmd']).path.replace(/\\/g, '/'), 'C:/Users/me/AppData/Roaming/npm/claude.cmd');
  assert.equal(win(['C:/Users/me/.local/bin/claude.exe']).path.replace(/\\/g, '/'), 'C:/Users/me/.local/bin/claude.exe');
  assert.match(win(['C:/Users/me/AppData/Roaming/Claude/claude-code/2.1.295/abc123/claude.exe']).path.replace(/\\/g, '/'), /Claude\/claude-code\/2\.1\.295\/abc123\/claude\.exe$/);
});

test('NORDLE_CLAUDE_BIN says exactly where, even when the file cannot be checked from here', () => {
  const r = mac([], { NORDLE_CLAUDE_BIN: '/somewhere/odd/claude' });
  assert.deepEqual([r.path, r.how], ['/somewhere/odd/claude', 'NORDLE_CLAUDE_BIN']);
});

test('nowhere: no path, the places tried are listed, and the message says what to do (find it, set it, or install it, then sign in)', () => {
  const r = mac([]);
  assert.equal(r.path, null);
  assert.ok(r.tried.length > 8);
  const m = missingClaudeMessage('claude', 'darwin');
  assert.match(m, /Could not start Claude Code \("claude"\)/);
  assert.match(m, /NORDLE_CLAUDE_BIN/);
  assert.match(m, /which claude/);
  assert.match(m, /claude\.ai\/install\.sh/);
  assert.match(m, /claude auth login/);
  assert.match(missingClaudeMessage('claude', 'win32'), /install\.ps1/);
});

test('the runner starts a .cmd through a shell on Windows, and says the new message when the program is missing', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'src', 'calendar', 'run.mjs'), 'utf8');
  assert.match(src, /\(cmd\|bat\)\$\/i\.test\(String\(bin\)\) \? \{ shell: true \}/);
  assert.match(src, /missingClaudeMessage\(bin\)/);
});
