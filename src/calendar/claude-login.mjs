// Signing in to Claude Code without a terminal. Claude Code keeps its own login (separate from the Claude desktop app's), and signing in means approving in a browser.
// Nordle cannot approve for you, but it can do everything else: start `claude auth login` itself, let the browser open, show the link in case it does not, and notice
// the moment you are signed in. One click in the Studio; nothing to type. Only one sign-in runs at a time, and it gives up after ten minutes.

import { spawn as nodeSpawn } from 'node:child_process';
import { claudeFound, claudeStatus } from './claude-bin.mjs';

const TEN_MINUTES = 10 * 60 * 1000;
const URL_RE = /https?:\/\/[^\s"'<>]+/i;

let current = null;   // { state, url, startedAt, child, timer }
let last = { state: 'idle' };

export const loginState = () => (current ? { state: current.state, url: current.url ?? null, startedAt: current.startedAt } : { ...last });

/**
 * Start the sign-in. Resolves with the state at once (the browser then does its part).
 * @param {{ spawn?: Function, found?: object, status?: Function, timeoutMs?: number }} [o]
 */
export function startLogin({ spawn = nodeSpawn, found = claudeFound(), status = claudeStatus, timeoutMs = TEN_MINUTES } = {}) {
  if (current) return loginState();
  if (!found.path) return { state: 'failed', error: 'Claude Code is not installed on this computer, so there is nothing to sign in to. Install it first (see the message above).' };
  const now = status({ found });
  if (now.signedIn === true) { last = { state: 'done' }; return { state: 'done', already: true }; }
  const cur = { state: 'waiting', url: null, startedAt: new Date().toISOString(), child: null, timer: null };
  current = cur;
  const finish = (state, extra = {}) => {
    if (current !== cur) return;
    clearTimeout(cur.timer);
    last = { state, ...extra };
    current = null;
  };
  try {
    cur.child = spawn(found.path, ['auth', 'login', '--claudeai'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...(/\.(cmd|bat)$/i.test(found.path) ? { shell: true } : {}) });
  } catch (e) { finish('failed', { error: e.message }); return { state: 'failed', error: e.message }; }
  const seen = (d) => { const m = URL_RE.exec(String(d)); if (m && !cur.url) cur.url = m[0].replace(/[.,)]+$/, ''); };
  cur.child.stdout?.on('data', seen);
  cur.child.stderr?.on('data', seen);
  cur.child.on('error', (e) => finish('failed', { error: e.message }));
  cur.child.on('close', (code) => {
    // success is Claude Code saying so, not only a clean exit
    const after = status({ found });
    if (after.signedIn === true) finish('done');
    else finish('failed', { error: code === 0 ? 'The sign-in finished but Claude Code still says it is not signed in. Try again.' : 'The sign-in was not completed. Try again.' });
  });
  cur.timer = setTimeout(() => { try { cur.child.kill(); } catch { /* gone */ } finish('failed', { error: 'The sign-in was not finished in ten minutes, so it was stopped. Try again.' }); }, timeoutMs);
  return loginState();
}

export function cancelLogin() {
  if (!current) return { state: 'idle' };
  const cur = current;
  try { cur.child?.kill(); } catch { /* gone */ }
  clearTimeout(cur.timer);
  last = { state: 'cancelled' };
  current = null;
  return { state: 'cancelled' };
}

/** Forget everything (tests). */
export function resetLogin() { if (current) { try { current.child?.kill(); } catch { /* gone */ } clearTimeout(current.timer); } current = null; last = { state: 'idle' }; }
