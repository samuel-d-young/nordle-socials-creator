// The Trash page: removed posts and brands, each with Restore. Nothing is ever deleted outright.

import { api } from './api.js';
import { h, icon } from './dom.js';
import { S, dateFmt, load } from './studio-store.js';
import { emptyState, FORMAT_LABEL, glyph, plural, brandName } from './studio-ui.js';
import * as act from './studio-actions.js';

export async function renderTrash(root, ctx) {
  root.replaceChildren(h('div', { class: 'trash' }, h('p', { class: 'muted tr-load' }, 'Looking in the trash…')));
  let data;
  try { data = await api.get('/studio/trash'); } catch (e) {
    return root.replaceChildren(emptyState({ tone: 'bad', title: 'The trash would not open', body: e.message }));
  }
  const again = () => renderTrash(root, ctx);
  if (!data.posts.length && !data.brands.length) {
    return root.replaceChildren(h('div', { class: 'trash' }, emptyState({ title: 'The trash is empty', body: 'Posts and brands you remove wait here, with all their files, until you restore them. Nothing is ever deleted.' })));
  }
  const post = (p) => h('li', { class: 'tr-row', dataset: { id: p.id } },
    glyph(p.format ?? 'post', 14),
    h('div', { class: 'tr-main' }, h('span', { class: 'tr-title' }, p.title), h('span', { class: 'tr-meta' }, `${brandName(p.project)}${p.date ? ` · was on ${dateFmt.day(p.date)}` : ''} · removed ${dateFmt.ago(p.removedAt)} · ${FORMAT_LABEL[p.format] ?? p.format}`)),
    h('button', { class: 'btn sm', type: 'button', onclick: async (e) => { e.currentTarget.disabled = true; if (await act.restoreFromTrash(p.id, p.title)) again(); else e.currentTarget.disabled = false; } }, icon('undoArrow', 14), 'Restore'));
  const brand = (b) => h('li', { class: 'tr-row', dataset: { id: b.id } },
    h('i', { class: 'tick lg', style: { '--lane': 'var(--ink-3)' } }),
    h('div', { class: 'tr-main' }, h('span', { class: 'tr-title' }, b.name), h('span', { class: 'tr-meta' }, `Brand · removed ${dateFmt.ago(b.removedAt)}`)),
    h('button', { class: 'btn sm', type: 'button', onclick: async (e) => {
      e.currentTarget.disabled = true;
      try { await api.post('/studio/restore-brand', { id: b.id }); await load({ force: true }); (await import('./studio-ui.js')).notify(`${b.name} is back.`, { kind: 'ok' }); again(); } catch (err) { (await import('./studio-ui.js')).notify(err.message, { kind: 'error' }); e.currentTarget.disabled = false; }
    } }, icon('undoArrow', 14), 'Restore'));
  root.replaceChildren(h('div', { class: 'trash' },
    data.brands.length ? h('section', {}, h('h2', { class: 'lbl' }, `Brands (${data.brands.length})`), h('ul', { class: 'tr-list' }, data.brands.map(brand))) : null,
    data.posts.length ? h('section', {}, h('h2', { class: 'lbl' }, `Posts (${data.posts.length})`), h('ul', { class: 'tr-list' }, data.posts.map(post))) : null,
    h('p', { class: 'muted tr-note' }, `${plural(data.posts.length + data.brands.length, 'thing')} in the trash. Posts are kept in each project's trash folder, brands in a hidden .trash folder beside your projects.`)));
}
