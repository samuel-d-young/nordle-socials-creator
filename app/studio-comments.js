// The comments block at the top of the right panel: write a note (always there), turn on the pin tool to put it on a spot, and see
// every comment with resolve, reply and delete. Clicking one takes the picture to it (the page, or the second in a reel).

import { api } from './api.js';
import { h, icon } from './dom.js';
import { load } from './studio-store.js';
import { askText, kbd, notify } from './studio-ui.js';
import { clock } from './studio-media.js';
import { fetchDetail, forgetDetail } from './studio-detail.js';

const when = (iso) => (iso ? new Date(iso).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '');
const pageLabel = (c) => (typeof c.time === 'number' ? clock(c.time) : c.general ? 'Whole post' : c.page === 'video' ? 'Video' : c.page.replace(/^slide-/, 'Slide '));

/**
 * @param {{d:object, post:object, viewer:object}} o
 * @returns {{el:HTMLElement, highlight:(id:string)=>void, draft:(d:object|null)=>void, mode:(on:boolean)=>void, update:(d:object)=>void}}
 */
export function commentsPanel({ d, post, viewer }) {
  let comments = d.comments ?? [];
  let draft = null;
  let busy = false;
  const hasPicture = viewer.kind !== 'none';
  const area = h('textarea', { class: 'field cm-area', rows: 2, placeholder: 'Add a comment…', 'aria-label': 'Add a comment', 'data-field': 'cm-area', maxlength: 4000 });
  const chip = h('span', { class: 'cm-chip hidden' });
  const pinBtn = hasPicture ? h('button', { class: 'btn quiet cm-pin', type: 'button', 'aria-pressed': 'false', title: 'Drop a pin on the picture (C)', onclick: () => viewer.setPinMode(!viewer.pinMode()) }, icon('message', 14), 'Pin on the picture', kbd('C')) : null;
  const addBtn = h('button', { class: 'btn primary sm cm-add', type: 'button', onclick: add }, 'Add');
  const list = h('ul', { class: 'cmts' });
  const count = h('span', { class: 'count' });
  const form = h('div', { class: 'cm-form' }, area, h('div', { class: 'cm-row' }, pinBtn, chip, h('span', { class: 'sp' }), h('span', { class: 'cm-hint' }, 'Ctrl+Enter'), addBtn));
  // once there is a comment to act on, sending it back is one click away, right under the comments
  const canSendBack = post.needsReview || post.status === 'changes' || (post.status === 'signed-off' && !post.staleSignoff);
  const sendBack = h('button', { class: 'btn ask cm-sendback hidden', type: 'button', 'data-act': 'comments-request-changes', onclick: () => { const scope = el.closest('.d-scroll, .q-side') ?? document; (scope.querySelector('[data-act="changes"]') ?? document.querySelector('[data-act="changes"]'))?.click(); } }, 'Request changes', kbd('X'));
  const el = h('section', { class: 'blk cm-top', id: 'comments' }, h('header', { class: 'blk-h' }, h('h3', { class: 'lbl' }, 'Comments'), count), form, list, canSendBack ? h('div', { class: 'cm-send' }, sendBack, h('span', { class: 'muted cm-send-note' })) : null);
  area.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); add(); } e.stopPropagation(); });
  area.addEventListener('keyup', (e) => e.stopPropagation());

  async function send(body) {
    if (busy) return false;
    busy = true;
    try {
      await api.post('/studio/comment', { uid: post.uid, ...body });
      forgetDetail(post.uid);
      const nd = await fetchDetail(post);
      update(nd);
      load({ force: true });
      return true;
    } catch (e) { notify(e.message, { kind: 'error' }); return false; } finally { busy = false; }
  }

  async function add() {
    const text = area.value.trim();
    if (!text) { area.focus(); return; }
    const spot = draft;
    const body = spot ? { text, ...spot } : { text, general: true, page: viewer.where().page };
    if (await send({ action: 'add', ...body })) {
      area.value = '';
      draft = null;
      viewer.clearDraft();
      viewer.setPinMode(false);
      paintChip();
    }
  }

  function paintChip() {
    chip.classList.toggle('hidden', !draft);
    if (!draft) return;
    chip.replaceChildren(h('span', {}, typeof draft.time === 'number' ? `Pinned at ${clock(draft.time)}` : `Pinned on ${draft.page.replace(/^slide-/, 'slide ')}`), h('button', { type: 'button', 'aria-label': 'Remove the pin', onclick: () => { draft = null; viewer.clearDraft(); paintChip(); } }, icon('x', 12)));
  }

  function item(c, n) {
    const open = c.status === 'open';
    // red: written, not sent yet. Orange and greyed: sent to the designer, who is looking at it. Green: done.
    const sent = open && (post.status === 'changes' || !!post.revising);
    const li = h('li', { class: `cmt ${c.status}${sent ? ' sent' : ''}`, dataset: { comment: c.id }, onclick: (e) => { if (!e.target.closest('button')) { if (hasPicture && !c.general) viewer.focusComment(c); li.classList.add('on'); } } },
      h('div', { class: 'cmt-h' }, h('span', { class: 'cmt-n' }, String(n)), h('b', {}, c.author === 'claude' ? 'Designer' : 'You'), h('span', { class: `cmt-where${typeof c.time === 'number' ? ' time' : ''}` }, pageLabel(c)), h('span', { class: 'muted cmt-when' }, when(c.created)), !open ? h('span', { class: 'cmt-done' }, 'resolved') : null),
      h('p', { class: 'cmt-text' }, c.text),
      sent ? h('p', { class: 'cmt-state', 'data-state': 'reviewing', role: 'status' }, post.revising ? h('i', { class: 'cmt-spin', 'aria-hidden': 'true' }) : null, post.revising ? 'Being reviewed by the designer…' : 'Sent to the designer. Waiting for them.') : null,
      open ? null : h('p', { class: 'cmt-done', 'data-state': 'updated' }, icon('check', 13), 'Done: updated'),
      (c.replies ?? []).map((r) => h('p', { class: 'cmt-reply' }, h('b', {}, r.author === 'claude' ? 'Designer' : 'You'), `: ${r.text}`)),
      h('div', { class: 'cmt-acts' },
        h('button', { class: 'btn quiet sm', type: 'button', onclick: () => send({ action: open ? 'resolve' : 'reopen', id: c.id }) }, icon('check', 13), open ? 'Resolve' : 'Reopen'),
        h('button', { class: 'btn quiet sm', type: 'button', onclick: async () => { const text = await askText({ title: 'Reply', label: 'Reply', ok: 'Reply' }); if (text) send({ action: 'reply', id: c.id, text }); } }, 'Reply'),
        h('button', { class: 'btn quiet sm nope', type: 'button', 'aria-label': 'Delete this comment', onclick: () => send({ action: 'delete', id: c.id }) }, icon('trash', 13))));
    return li;
  }

  function paintList() {
    const all = comments.map((c, i) => [c, i + 1]);
    const open = all.filter(([c]) => c.status === 'open');
    const done = all.filter(([c]) => c.status !== 'open');
    count.textContent = comments.length ? `${open.length} open · ${comments.length} in all` : '';
    count.classList.toggle('over', open.length > 0);
    sendBack.classList.toggle('hidden', open.length === 0);
    const note = el.querySelector('.cm-send-note');
    if (note) note.textContent = open.length ? `Sends ${open.length === 1 ? 'this comment' : `these ${open.length} comments`} to the designer.` : '';
    // a resolved comment leaves the picture and the open list at once; it stays here, folded away, in case it needs reopening
    const rows = open.map(([c, n]) => item(c, n));
    const none = !comments.length ? (hasPicture ? 'No comments yet. Write one above, or press C and click the spot you mean.' : 'No comments yet.') : 'Nothing open. Everything has been resolved.';
    const folded = done.length ? h('li', { class: 'cmt-folded' }, h('details', { class: 'cmt-resolved', open: !!post.revised }, h('summary', {}, post.revised ? `Updated (${done.length})` : `Resolved (${done.length})`), h('ul', { class: 'cmts' }, done.map(([c, n]) => item(c, n))))) : null;
    list.replaceChildren(...(rows.length ? rows : [h('li', { class: 'cmt-none' }, none)]), ...(folded ? [folded] : []));
  }

  function update(nd) {
    comments = nd.comments ?? [];
    paintList();
    viewer.setComments(comments);
  }
  paintList();
  viewer.setComments(comments);

  return {
    el,
    update,
    highlight(id) {
      const li = list.querySelector(`[data-comment="${CSS.escape(id)}"]`);
      for (const n of list.querySelectorAll('.cmt.on')) n.classList.remove('on');
      li?.classList.add('on');
      li?.scrollIntoView({ block: 'nearest' });
    },
    draft(dr) { draft = dr; paintChip(); if (dr) area.focus({ preventScroll: true }); },
    mode(on) { pinBtn?.setAttribute('aria-pressed', String(on)); pinBtn?.classList.toggle('on', on); },
  };
}
