// "Sign in with Buffer" in the Publishing window. The button asks the server to start a sign-in (POST /publish/oauth/buffer/start), opens the Buffer address in
// a new tab, and waits for app/oauth-callback.html (the tab Buffer ends up on, on this same computer) to hand over {code, state, error}: over a BroadcastChannel,
// or, where that is blocked, a short-lived localStorage key. This tab is the one that holds the owner's token, so it makes the call that finishes the sign-in
// (POST /publish/oauth/buffer/finish): the API stays closed to the callback page. The state must be the one this tab started; the server checks it again.
// Nothing here ever sees a token: the server keeps them. State lives in this module (not in the window) so a sign-in finishes even if the window is closed.

import { api } from './api.js';
import { h } from './dom.js';

const CHANNEL = 'nordle-buffer-oauth';
const KEY = 'nordle-buffer-oauth';
const REPLY_KEY = 'nordle-buffer-oauth-reply';
export const WAIT_MS = 10 * 60 * 1000;   // the server drops a sign-in that was not finished in 10 minutes

export const NO_CLIENT_ID_TEXT = 'This copy of Nordle has no Buffer app client id yet, so signing in with Buffer is not available here. Pasting a Buffer API key works instead.';

/** phase: idle | starting | waiting | finishing | done | refused | expired | blocked | error | unconfigured */
export const signIn = { phase: 'idle', text: '', url: '', status: null, state: null };
const BUSY = new Set(['starting', 'waiting', 'finishing']);
export const signInBusy = () => BUSY.has(signIn.phase);

const watchers = new Set();
/** Run fn whenever the sign-in changes (the window redraws). Returns the function that stops it. */
export function onSignInChange(fn) { watchers.add(fn); return () => watchers.delete(fn); }
const set = (phase, text = '') => { signIn.phase = phase; signIn.text = text; for (const fn of [...watchers]) { try { fn(); } catch { /* a closed window */ } } };

let sink = null;   // what to do with a finished sign-in's answer: the open window redraws itself; with none, studio-publish.js's default tells the person
export function setSignInSink(fn) { sink = fn; }

/** Ask the server whether this copy of Nordle can sign in at all (it needs a Buffer app client id), and which accounts signed in that way. */
export async function loadSignInStatus() {
  try { signIn.status = await api.get('/publish/oauth/buffer/status'); } catch { signIn.status = null; }
  set(signIn.phase, signIn.text);   // redraw
  return signIn.status;
}

// ---- waiting for the callback tab ------------------------------------------------------------------------------------------------------------

let channel = null, timer = null;
const seen = new Set();   // states already handed over (the channel and the storage key both deliver)

function reply(state, kind, message) {
  const d = { reply: kind, state, ...(message ? { message } : {}) };
  try { channel?.postMessage(d); } catch { /* the storage key below still tells it */ }
  try { localStorage.setItem(REPLY_KEY, JSON.stringify({ ...d, at: Date.now() })); setTimeout(() => { try { localStorage.removeItem(REPLY_KEY); } catch { /* blocked */ } }, 5000); } catch { /* blocked */ }
}

function stopListening() {
  clearTimeout(timer); timer = null;
  window.removeEventListener('storage', onStorage);
  if (channel) { try { channel.close(); } catch { /* closed */ } channel = null; }
}
function onStorage(e) {
  if (e.key !== KEY || !e.newValue) return;
  try { const d = JSON.parse(e.newValue); if (Date.now() - Number(d.at) < WAIT_MS) receive(d); } catch { /* not ours */ }
}

function listen(state) {
  stopListening();
  signIn.state = state;
  try { localStorage.removeItem(KEY); localStorage.removeItem(REPLY_KEY); } catch { /* blocked */ }
  try { channel = new BroadcastChannel(CHANNEL); channel.onmessage = (e) => receive(e.data); } catch { channel = null; }
  window.addEventListener('storage', onStorage);
  timer = setTimeout(() => {
    if (signIn.state !== state || !['waiting', 'blocked'].includes(signIn.phase)) return;
    stopListening();
    set('expired', 'That sign-in took more than 10 minutes, so it was dropped. Press the button to start again.');
  }, WAIT_MS);
}

/** What the callback page sent: {code, state, error}. Anything that is not the sign-in this tab started is ignored. */
function receive(d) {
  if (!d || typeof d !== 'object' || 'reply' in d || typeof d.state !== 'string') return;
  if (d.state !== signIn.state || !['waiting', 'blocked'].includes(signIn.phase) || seen.has(d.state)) return;
  seen.add(d.state);
  finish(d);
}

async function finish(d) {
  set('finishing', 'Buffer said yes. Finishing the sign-in…');
  reply(d.state, 'received');
  let r = null, failure = null;
  try {
    r = await api.post('/publish/oauth/buffer/finish', { ...(typeof d.code === 'string' ? { code: d.code } : {}), state: d.state, ...(typeof d.error === 'string' && d.error ? { error: d.error } : {}) });
  } catch (e) { failure = e; }
  stopListening();
  signIn.url = '';
  if (failure) {
    const refused = d.error === 'access_denied';
    set(refused ? 'refused' : failure.status === 410 ? 'expired' : 'error', refused ? 'Buffer sign-in was refused, so nothing was connected. You can press the button to try again.' : failure.message);
    reply(d.state, 'failed', failure.message);
    return;
  }
  set(r.ok ? 'done' : 'error', r.ok ? 'Signed in with Buffer.' : r.message || 'Signed in, but Nordle could not reach Buffer with it.');
  reply(d.state, r.ok ? 'done' : 'failed', r.ok ? undefined : r.message);
  try { await sink?.(r); } catch { /* the window or the notice failed; the sign-in itself is saved */ }
}

/** Start a sign-in. `account` (an account id) signs that account in again; `label` names a new one. */
export async function startSignIn({ account, label } = {}) {
  if (signInBusy()) return;
  if (signIn.status && !signIn.status.configured) { set('unconfigured', signIn.status.problem || NO_CLIENT_ID_TEXT); return; }
  // Buffer's redirect always comes back to 127.0.0.1; a Studio opened as "localhost" is another address to the browser, and the two tabs could not talk
  if (location.hostname !== '127.0.0.1') { set('error', `Open Nordle at http://127.0.0.1:${location.port || 80}/ (not "${location.hostname}") to sign in with Buffer: the sign-in comes back to that address, and this tab has to be on it to receive it.`); return; }
  set('starting', 'Getting the Buffer address ready…');
  let r;
  try { r = await api.post('/publish/oauth/buffer/start', { ...(account ? { account } : {}), ...(label ? { label } : {}) }); }
  catch (e) { set(e.status === 409 && /client id/i.test(e.message) ? 'unconfigured' : 'error', e.message); return; }
  listen(r.state);
  signIn.url = r.url;
  const w = window.open(r.url, '_blank');
  if (w) { try { w.opener = null; } catch { /* already cut off */ } set('waiting', 'A Buffer tab is open. Approve Nordle there and this window finishes the sign-in by itself.'); }
  else set('blocked', 'Your browser did not open the Buffer tab (a pop-up blocker, most likely). Open it with the link below, or allow pop-ups for Nordle and press the button again.');   // still listening: the link is a way in
}

/** A window that opens starts clean: last time's "Signed in" or error line is not shown again (a sign-in still in progress is). */
export function resetSignIn() { if (!signInBusy() && signIn.phase !== 'blocked') { signIn.phase = 'idle'; signIn.text = ''; } }

/** Stop waiting (the Buffer tab, if it is still open, can be closed). The server forgets the sign-in by itself after 10 minutes. */
export function cancelSignIn() {
  stopListening();
  signIn.state = null; signIn.url = '';
  set('idle', '');
}

// ---- drawing -----------------------------------------------------------------------------------------------------------------------------------

/** "Signed in with Buffer. Renews itself; this access runs out at 3:42 pm." in words. `a` is an account as GET /publish/adapters shows it. */
export function signInCardText(a) {
  if (!a?.configured) return 'Signed in with Buffer, but the sign-in is no longer valid. Sign in again.';
  const when = a.expiresAt ? new Date(a.expiresAt) : null;
  const clock = when && !Number.isNaN(when.getTime()) ? when.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' }) : '';
  if (a.renews === false) return `Signed in with Buffer${clock ? `. It runs out at ${clock} and cannot renew itself: sign in again then` : ''}.`;
  return `Signed in with Buffer${clock ? `. This hour's access runs out at ${clock}` : ''}; Nordle renews it by itself.`;
}

/**
 * The sign-in box: the button, one line saying plainly what is happening, and (if the browser blocked the tab) a link.
 * `args()` gives { account?, label? } when the button is pressed (a new account's name, or an existing account to sign in again).
 */
export function signInBox({ args = () => ({}) } = {}) {
  const busy = signInBusy();
  const st = signIn.status;
  const say = signIn.phase !== 'idle' ? signIn.text : st && !st.configured ? (st.problem || NO_CLIENT_ID_TEXT) : '';
  const tone = signIn.phase === 'done' ? 'ok' : ['refused', 'expired', 'error', 'blocked', 'unconfigured'].includes(signIn.phase) || (signIn.phase === 'idle' && st && !st.configured) ? 'bad' : '';
  return h('div', { class: 'bsi', dataset: { phase: signIn.phase, configured: st ? String(!!st.configured) : 'unknown' } },
    h('h4', {}, 'Sign in with Buffer'),
    h('p', { class: 'sch-help' }, 'Opens Buffer in a new tab. You approve Nordle there and nothing is pasted or typed. Nordle keeps the sign-in on this computer and renews it by itself. If you use several Buffer logins, type a name for this one in the box below first.'),
    h('div', { class: 'bsi-row' },
      h('button', { class: 'btn primary', type: 'button', 'data-act': 'buffer-signin', disabled: busy, onclick: () => startSignIn(args()) }, 'Sign in with Buffer'),
      signIn.phase === 'waiting' || signIn.phase === 'blocked' ? h('button', { class: 'btn quiet', type: 'button', 'data-act': 'buffer-signin-cancel', onclick: cancelSignIn }, 'Cancel') : null),
    say ? h('p', { class: `bsi-say${tone ? ` ${tone}` : ''}`, role: 'status', 'data-field': 'buffer-signin-say' }, say) : null,
    signIn.phase === 'blocked' && signIn.url ? h('p', { class: 'bsi-say' }, h('a', { href: signIn.url, target: '_blank', rel: 'noopener noreferrer', 'data-act': 'buffer-signin-link' }, 'Open the Buffer page myself')) : null);
}
