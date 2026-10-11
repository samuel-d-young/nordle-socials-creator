// Edit a post from the review page. The full editor opens in a large window over the page (the same editor as "Open in editor", with every
// tool: drag, resize, nudge, change words), so a picture can be moved without asking the designer. Edits save as they are made. When the
// window closes after a change, the pictures the review page shows are drawn again from the edited post, and the sign-off no longer
// counts (the post changed), so it comes back for a decision.

import { api } from './api.js';
import { h, icon } from './dom.js';
import { load, update } from './studio-store.js';
import { bumpPictures, notify } from './studio-ui.js';
import { forgetDetail } from './studio-detail.js';

const base = (post) => `/projects/${encodeURIComponent(post.project)}/docs/${encodeURIComponent(post.docId)}`;

/** Can this post be edited here? Pictures and carousels can; a reel's cuts live in its spec, and a post made outside Nordle has no document. */
export const canEditHere = (post) => !!post.docId && post.kind !== 'video' && post.format !== 'reel' && !post.external;

let open = false;

/** Open the editor over the page. Resolves true when something was changed (and the pictures were redrawn). */
export async function editHere(post) {
  if (open || !canEditHere(post)) return false;
  open = true;
  let v0 = null;
  try { v0 = (await api.get(base(post))).v; } catch (e) { open = false; notify(e.message, { kind: 'error' }); return false; }
  const frame = h('iframe', { class: 'eh-frame', title: `Editor: ${post.title}`, src: `/#/p/${encodeURIComponent(post.project)}/${encodeURIComponent(post.docId)}` });
  const body = h('div', { class: 'eh-body' }, frame);
  const state = h('span', { class: 'eh-state muted' }, 'Changes save as you make them.');
  let finishing = false;
  const dlg = h('dialog', { class: 'edit-here', 'aria-label': `Edit ${post.title}` },
    h('header', { class: 'eh-bar' }, h('b', {}, post.title), state, h('span', { class: 'sp' }),
      h('button', { class: 'btn go', type: 'button', 'data-act': 'edit-done', onclick: () => finish() }, icon('check', 15), 'Done')),
    body);

  const closed = new Promise((resolve) => {
    dlg.addEventListener('close', async () => {
      const changed = await redraw();
      dlg.remove();
      open = false;
      resolve(changed);
    });
  });

  /** After the window closes: if the post changed, draw its pictures again and tell the page. */
  async function redraw() {
    let changed = false;
    try {
      const v1 = (await api.get(base(post))).v;
      changed = v1 !== v0;
      if (changed) {
        notify('Drawing the pictures again…', { kind: 'info' });
        await api.post(`${base(post)}/export`, {});
      }
    } catch (e) { notify(`The pictures could not be redrawn: ${e.message}`, { kind: 'error' }); }
    if (changed) bumpPictures();                      // the browser would otherwise show the old pictures for up to a minute
    forgetDetail(post.uid);
    await load({ force: true });
    update({});
    if (changed) notify(`“${post.title}” was edited. Its pictures are up to date; look at it again before signing off.`, { kind: 'ok' });
    return changed;
  }

  function finish() {
    if (finishing) return;
    finishing = true;
    state.textContent = 'Saving and drawing the pictures again…';
    dlg.close();
  }

  document.body.append(dlg);
  dlg.showModal();
  return closed;
}
