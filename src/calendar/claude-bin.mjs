// Where is Claude Code on this computer? Nordle starts it ("claude -p") to build posts, write ideas and read screenshots, and the Studio's own process often has a
// shorter PATH than your terminal (a Mac app launched from Finder, an editor, a service), or Claude Code is only the copy inside the Claude desktop app. So this looks, in order:
//   1. NORDLE_CLAUDE_BIN (you said exactly where)
//   2. the PATH
//   3. the places the installers put it (~/.local/bin, ~/.claude/local, Homebrew, /usr/local/bin, npm's global folder, Volta, nvm)
//   4. the copy bundled with the Claude desktop app (the newest version folder)
// It never runs anything to find it; it only looks at files.

import { accessSync, constants, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { launchPlan } from './winshell.mjs';

const WIN = (platform) => platform === 'win32';
// paths are written the way the TARGET computer writes them (so the Windows and Mac cases can both be tested anywhere)
let join = path.join;
let delimiter = path.delimiter;
const writeLike = (platform) => { const P = platform === 'win32' ? path.win32 : path.posix; join = P.join; delimiter = P.delimiter; };
const names = (platform) => (WIN(platform) ? ['claude.exe', 'claude.cmd', 'claude.bat'] : ['claude']);

function isRunnable(file, platform, fs) {
  try {
    if (!fs.exists(file) || !fs.isFile(file)) return false;
    if (!WIN(platform)) fs.access(file, constants.X_OK);
    return true;
  } catch { return false; }
}
const realFs = { exists: existsSync, isFile: (f) => statSync(f).isFile(), access: (f, m) => accessSync(f, m), readdir: (d) => readdirSync(d, { withFileTypes: true }) };

const cmpVersion = (a, b) => {
  const pa = String(a).split(/[.-]/).map((x) => parseInt(x, 10) || 0), pb = String(b).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

/** The Claude desktop app keeps its own copy: <app data>/Claude/claude-code/<version>/<something>/claude (or inside a claude.app). Newest version first. */
function bundled(platform, home, env, fs) {
  writeLike(platform);
  const roots = WIN(platform)
    ? [join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Claude', 'claude-code')]
    : platform === 'darwin' ? [join(home, 'Library', 'Application Support', 'Claude', 'claude-code')] : [join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'Claude', 'claude-code')];
  const found = [];
  const look = (dir, depth) => {
    if (depth > 4) return null;
    let entries; try { entries = fs.readdir(dir); } catch { return null; }
    for (const e of entries) if (!e.isDirectory() && names(platform).includes(e.name) && isRunnable(join(dir, e.name), platform, fs)) return join(dir, e.name);
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const hit = look(join(dir, e.name), depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  for (const root of roots) {
    let versions; try { versions = fs.readdir(root).filter((e) => e.isDirectory()).map((e) => e.name).sort(cmpVersion).reverse(); } catch { continue; }
    for (const v of versions) { const hit = look(join(root, v), 0); if (hit) found.push(hit); }
  }
  return found;
}

/**
 * @returns {{ path: string|null, how: string, tried: string[] }}
 */
export function findClaude({ env = process.env, platform = process.platform, home = os.homedir(), fs = realFs } = {}) {
  writeLike(platform);
  const tried = [];
  const test = (file, how) => { tried.push(file); return isRunnable(file, platform, fs) ? { path: file, how, tried } : null; };
  if (env.NORDLE_CLAUDE_BIN) {
    tried.push(env.NORDLE_CLAUDE_BIN);
    // a bare name ("claude") is looked up on the PATH like any other
    if (/[\\/]/.test(env.NORDLE_CLAUDE_BIN)) return { path: env.NORDLE_CLAUDE_BIN, how: 'NORDLE_CLAUDE_BIN', tried };
  }
  const bare = env.NORDLE_CLAUDE_BIN && !/[\\/]/.test(env.NORDLE_CLAUDE_BIN) ? [env.NORDLE_CLAUDE_BIN] : names(platform);
  for (const dir of String(env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) for (const n of bare) { const hit = test(join(dir, n), 'the PATH'); if (hit) return hit; }
  const places = [
    join(home, '.local', 'bin'), join(home, '.claude', 'local'), join(home, '.claude', 'bin'), join(home, '.volta', 'bin'), join(home, '.npm-global', 'bin'), join(home, 'bin'),
    ...(WIN(platform) ? [join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'npm'), join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Programs', 'claude'), join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Microsoft', 'WinGet', 'Links')]
      : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/snap/bin']),
  ];
  try { const nvm = join(home, '.nvm', 'versions', 'node'); for (const v of fs.readdir(nvm).filter((e) => e.isDirectory()).map((e) => e.name).sort(cmpVersion).reverse()) places.push(join(nvm, v, 'bin')); } catch { /* no nvm */ }
  for (const dir of places) for (const n of names(platform)) { const hit = test(join(dir, n), 'where the installer puts it'); if (hit) return hit; }
  for (const file of bundled(platform, home, env, fs)) { tried.push(file); return { path: file, how: 'the copy inside the Claude desktop app', tried }; }
  return { path: null, how: '', tried };
}

let cached = null;
/** The program to start: where Claude Code was found, or plain "claude" so the error says what to do. Looked for once. */
export function claudeProgram() {
  if (!cached || cached.env !== process.env.NORDLE_CLAUDE_BIN) cached = { env: process.env.NORDLE_CLAUDE_BIN, found: findClaude() };
  return cached.found.path ?? 'claude';
}
export const claudeFound = () => { claudeProgram(); return cached.found; };
export const forgetClaude = () => { cached = null; };

/** The words for "could not start it": what to do, in order. */
export function missingClaudeMessage(bin, platform = process.platform) {
  const install = platform === 'win32' ? 'irm https://claude.ai/install.ps1 | iex   (in PowerShell)' : 'curl -fsSL https://claude.ai/install.sh | bash   (in a terminal)';
  return `Could not start Claude Code ("${bin}"). Nordle looked on the PATH, in the usual install folders and in the Claude desktop app, and did not find it. `
    + `If it is installed, set NORDLE_CLAUDE_BIN to its full path (open a terminal and run "which claude", or "where claude" on Windows, to see it) and restart Nordle. `
    + `If it is not, install it: ${install}. Then sign in once with: claude auth login.`;
}


/**
 * Is this copy of Claude Code signed in? Asks the program itself (`claude auth status`), which only reads its own saved login and costs nothing.
 * @returns {{ found: boolean, path: string|null, signedIn: boolean|null, how?: string, account?: string, error?: string }}
 */
export function claudeStatus({ run = spawnSync, found = claudeFound() } = {}) {
  if (!found.path) return { found: false, path: null, signedIn: null, message: missingClaudeMessage('claude') };
  const plan = launchPlan(found.path, ['auth', 'status']);
  const r = run(plan.command, plan.args, { encoding: 'utf8', windowsHide: true, timeout: 20000, ...plan.options });
  if (r.error) return { found: true, path: found.path, how: found.how, signedIn: null, error: r.error.message };
  let j = null;
  try { j = JSON.parse(String(r.stdout ?? '').trim()); } catch { /* not JSON */ }
  const signedIn = j ? j.loggedIn === true : /logged in|signed in/i.test(String(r.stdout)) && !/not logged in|not signed in/i.test(String(r.stdout));
  return { found: true, path: found.path, how: found.how, signedIn, ...(j?.email ? { account: j.email } : {}), ...(!signedIn ? { message: `Claude Code is found at ${found.path} but is not signed in. In a terminal run: "${found.path}" auth login` } : {}) };
}
