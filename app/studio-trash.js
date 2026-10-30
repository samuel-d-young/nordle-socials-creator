// The Trash page: removed posts and brands, each with Restore, and a way to delete them for good (one at a time, or the whole trash).
// Removing never deletes: things wait here until you restore them or delete them here, after being asked.

import { api } from './api.js';
import { h, icon } from './dom.js';
import { S, dateFmt, load } from './studio-store.js';
import { askConfirm, emptyState, FORMAT_LABEL, glyph, notify, plural, brandName } from './studio-ui.js';
import * as act from './studio-actions.js';

const short = (s, n = 60) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Delete from the trash for good, after asking. Returns whether anything was deleted. */
async function deleteForGood(ids, { title, body, ok }) {
  if (!(await askConfirm({ title, body, ok, danger: true }))) return false;
  try {
    const r = await api.post('/studio/trash-delete', ids === 'all' ? { all: true } : { ids });
    await load({ force: true });
    if (r.failed?.length) notify(`${plural(r.deleted.length, 'thing')} deleted. Not deleted: ${r.failed.map((f) => f.reason).join(' ')}`, { kind: 'error', ms: 12000 });
    else notify(r.deleted.length === 1 ? `“${short(r.deleted[0].title ?? 'It')}” is deleted.` : `${plural(r.deleted.length, 'thing')} deleted.`, { kind: 'ok' });
    return r.deleted.length > 0;
  } catch (e) { notify(e.message, { kind: 'error' }); return false; }
}

export async function renderTrash(root, ctx) {
  root.replaceChildren(h('div', { class: 'trash' }, h('p', { class: 'muted tr-load' }, 'Looking in the trash…')));
  let data;
  try { data = await api.get('/studio/trash'); } catch (e) {
    return root.replaceChildren(emptyState({ tone: 'bad', title: 'The trash would not open', body: e.message }));
  }
  const again = () => renderTrash(root, ctx);
  if (!data.posts.length && !data.brands.length) {
    return root.replaceChildren(h('div', { class: 'trash' }, emptyState({ title: 'The trash is empty', body: 'Posts and brands you remove wait here, with all their files, until you restore them or delete them for good.' })));
  }
  const del = (item, name, body) => h('button', { class: 'btn sm quiet tr-del', type: 'button', 'data-act': 'trash-delete', title: 'Delete it for good: its files are removed from this computer',
    onclick: async (e) => {
      const btn = e.currentTarget; btn.disabled = true;
      if (await deleteForGood([item.id], { title: `Delete “${short(name)}” for good?`, body, ok: 'Delete forever' })) again(); else btn.disabled = false;
    } }, icon('trash', 14), 'Delete');
  const post = (p) => h('li', { class: 'tr-row', dataset: { id: p.id } },
    glyph(p.format ?? 'post', 14),
    h('div', { class: 'tr-main' }, h('span', { class: 'tr-title' }, p.title), h('span', { class: 'tr-meta' }, `${brandName(p.project)}${p.date ? ` · was on ${dateFmt.day(p.date)}` : ''} · removed ${dateFmt.ago(p.removedAt)} · ${FORMAT_LABEL[p.format] ?? p.format}`)),
    h('span', { class: 'tr-acts' },
      h('button', { class: 'btn sm', type: 'button', onclick: async (e) => { e.currentTarget.disabled = true; if (await act.restoreFromTrash(p.id, p.title)) again(); else e.currentTarget.disabled = false; } }, icon('undoArrow', 14), 'Restore'),
      del(p, p.title, 'Its pictures, video, captions and notes are removed from this computer. This cannot be undone.')));
  const brand = (b) => h('li', { class: 'tr-row', dataset: { id: b.id } },
    h('i', { class: 'tick lg', style: { '--lane': 'var(--ink-3)' } }),
    h('div', { class: 'tr-main' }, h('span', { class: 'tr-title' }, b.name), h('span', { class: 'tr-meta' }, `Brand · removed ${dateFmt.ago(b.removedAt)}`)),
    h('span', { class: 'tr-acts' },
      h('button', { class: 'btn sm', type: 'button', onclick: async (e) => {
        e.currentTarget.disabled = true;
        try { await api.post('/studio/restore-brand', { id: b.id }); await load({ force: true }); notify(`${b.name} is back.`, { kind: 'ok' }); again(); } catch (err) { notify(err.message, { kind: 'error' }); e.currentTarget.disabled = false; }
      } }, icon('undoArrow', 14), 'Restore'),
      del(b, b.name, 'This is the whole brand: every post, picture, video and setting in its folder is removed from this computer. This cannot be undone.')));
  const total = data.posts.length + data.brands.length;
  root.replaceChildren(h('div', { class: 'trash' },
    h('div', { class: 'tr-top' },
      h('p', { class: 'muted tr-note' }, `${plural(total, 'thing')} in the trash. Posts are kept in each project's trash folder, brands in a hidden .trash folder beside your projects.`),
      h('button', { class: 'btn tr-empty', type: 'button', 'data-act': 'trash-empty', title: 'Delete everything in the trash for good',
        onclick: async (e) => {
          const btn = e.currentTarget; btn.disabled = true;
          const names = [...data.brands.map((b) => `${b.name} (a whole brand)`), ...data.posts.map((p) => p.title)];
          const list = h('ul', { class: 'tr-list-names' }, names.slice(0, 8).map((n) => h('li', {}, short(n))), names.length > 8 ? h('li', { class: 'muted' }, `and ${names.length - 8} more`) : null);
          const r = await askConfirm({ title: `Empty the trash: delete ${plural(total, 'thing')} for good?`, body: 'Everything in the trash is removed from this computer. This cannot be undone.', ok: 'Empty the trash', danger: true, details: list });
          if (!r) { btn.disabled = false; return; }
          try {
            const out = await api.post('/studio/trash-delete', { all: true });
            await load({ force: true });
            if (out.failed?.length) notify(`${plural(out.deleted.length, 'thing')} deleted. Not deleted: ${out.failed.map((f) => f.reason).join(' ')}`, { kind: 'error', ms: 12000 });
            else notify(`The trash is empty: ${plural(out.deleted.length, 'thing')} deleted.`, { kind: 'ok' });
          } catch (err) { notify(err.message, { kind: 'error' }); }
          again();
        } }, icon('trash', 14), 'Empty the trash')),
    data.brands.length ? h('section', {}, h('h2', { class: 'lbl' }, `Brands (${data.brands.length})`), h('ul', { class: 'tr-list' }, data.brands.map(brand))) : null,
    data.posts.length ? h('section', {}, h('h2', { class: 'lbl' }, `Posts (${data.posts.length})`), h('ul', { class: 'tr-list' }, data.posts.map(post))) : null));
}
