// The Claude account window: who Claude Code is signed in as on this computer, and how to sign out or switch to another account. Nordle has no accounts of its own;
// this is the account Claude uses to plan and build posts. Nothing is deleted at Anthropic: signing out only removes this computer's saved login.

import { api } from './api.js';
import { dialog, h, icon } from './dom.js';
import { claudeSignIn, notify } from './studio-ui.js';

/** Tell the rest of the Studio (the banner at the top) that the account changed. */
const changed = () => window.dispatchEvent(new CustomEvent('nordle:claude'));

export async function openClaudeAccount() {
  const view = h('div', { class: 'claude-acct', 'data-field': 'claude-account' });
  let busy = false;

  const paint = (c, { switching = false } = {}) => {
    if (!c) { view.replaceChildren(h('p', { class: 'muted' }, 'Looking…')); return; }
    if (!c.found) {
      view.replaceChildren(h('p', { 'data-state': 'claude-missing' }, icon('alert', 15), ' Claude Code is not installed on this computer. Nordle uses it to plan, write and build posts. ', h('span', { class: 'muted' }, c.message ?? '')));
      return;
    }
    if (c.signedIn) {
      view.replaceChildren(
        h('p', { 'data-state': 'claude-signed-in' }, icon('check', 15), ' ', h('b', {}, 'Signed in'), c.account ? h('span', {}, ' as ', h('b', { 'data-field': 'claude-email' }, c.account)) : null, '.'),
        h('p', { class: 'muted' }, 'This is the account Claude uses when Nordle plans, writes and builds posts, so it is the one whose usage is counted. To use a different account, switch: Nordle signs this one out, then opens the browser so you can sign in with another.'),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', type: 'button', 'data-act': 'claude-switch', onclick: () => signOut({ thenSignIn: true }) }, 'Switch account'),
          h('button', { class: 'btn', type: 'button', 'data-act': 'claude-signout', onclick: () => signOut({ thenSignIn: false }) }, 'Sign out')));
      return;
    }
    view.replaceChildren(
      h('p', { 'data-state': 'claude-signed-out' }, icon('alert', 15), ' ', h('b', {}, switching ? 'Signed out. Now sign in with the other account.' : 'Not signed in.')),
      h('p', { class: 'muted' }, 'Press the button and approve in the browser window that opens. If the browser is already signed in to the wrong account, sign out of it on claude.ai first, or use a private window and the link it shows.'),
      claudeSignIn({ label: switching ? 'Sign in with another account' : 'Sign in to Claude', onReady: async () => { notify('Signed in. Nordle can use Claude now.', { kind: 'ok' }); changed(); paint(await load()); } }));
  };

  const load = async () => { try { return await api.get('/claude'); } catch (e) { return { found: false, message: e.message }; } };

  async function signOut({ thenSignIn }) {
    if (busy) return;
    busy = true;
    view.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      const r = await api.post('/claude/logout', {});
      changed();
      notify(thenSignIn ? 'Signed out. Sign in with the other account.' : 'Signed out of Claude on this computer.', { kind: 'ok' });
      paint(r, { switching: thenSignIn });
    } catch (e) {
      notify(e.message, { kind: 'error' });
      paint(await load());
    }
    busy = false;
  }

  paint(null);
  const opened = dialog({
    title: 'Claude account',
    build: (body) => body.append(view),
    actions: [{ id: 'close', label: 'Close', primary: true }],
  });
  paint(await load());
  await opened;
  changed();
}
