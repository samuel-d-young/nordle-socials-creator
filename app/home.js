// The home screen: projects and their posts.

import { h, icon, promptBox, toast } from './dom.js';
import { api } from './api.js';
import { state, update } from './state.js';
import { removeBrand } from './studio-actions.js';
import { S as studioState } from './studio-store.js';

export async function loadProjects() {
  const r = await api.get('/projects');
  update({ projects: r.projects });
}

async function newPost(project) {
  const info = await api.get(`/projects/${project.id}`);
  const presets = info.platforms.filter((p) => p.kinds.includes('carousel') || p.kinds.includes('graphic'));
  const boxes = new Map();
  let titleInput;
  let kindSel;
  const { dialog } = await import('./dom.js');
  const r = await dialog({
    title: `New post in ${project.name}`,
    build: (body) => {
      titleInput = h('input', { class: 'field', placeholder: 'e.g. Spring menu', 'data-field': 'new-title' });
      kindSel = h('select', { class: 'field' }, h('option', { value: 'carousel' }, 'Carousel (several pages)'), h('option', { value: 'graphic' }, 'Single graphic'));
      body.append(
        h('div', { class: 'row' }, h('label', {}, 'Title'), h('div', { class: 'grow' }, titleInput)),
        h('div', { class: 'row' }, h('label', {}, 'Type'), h('div', { class: 'grow' }, kindSel)),
        h('div', { class: 'group' }, h('h3', {}, 'Sizes'), presets.map((p) => {
          const cb = h('input', { type: 'checkbox', checked: p.id === 'ig-feed-4x5' });
          boxes.set(p.id, cb);
          return h('label', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '4px' } }, cb, `${p.name} · ${p.w}×${p.h}`);
        })));
    },
    onOpen: () => titleInput.focus(),
    actions: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'Create', primary: true }],
  });
  if (r !== 'ok') return;
  const sizes = [...boxes].filter(([, cb]) => cb.checked).map(([id]) => id);
  if (!titleInput.value.trim()) { toast('Give the post a title.', 'error'); return; }
  if (!sizes.length) { toast('Choose at least one size.', 'error'); return; }
  try {
    const created = await api.post(`/projects/${project.id}/docs`, { title: titleInput.value.trim(), kind: kindSel.value, sizes });
    location.hash = `#/p/${project.id}/${created.id}`;
  } catch (e) { toast(e.message, 'error'); }
}

async function newProject() {
  const r = await promptBox('New project', [{ name: 'name', label: 'Brand or client', placeholder: 'e.g. Little Gannet Coffee' }], { ok: 'Create' });
  if (!r?.name.trim()) return;
  try { await api.post('/projects', { name: r.name.trim() }); await loadProjects(); } catch (e) { toast(e.message, 'error'); }
}

export function renderHome(root) {
  const list = state.projects;
  root.replaceChildren(h('div', { class: 'home' },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
      h('div', { style: { flex: 1 } }, h('h1', {}, h('a', { class: 'wordmark', href: '#/', title: 'Back to the Studio' }, 'Nordle', h('i', {}, '.'))), h('div', { class: 'muted' }, 'All posts: every brand and its posts, to edit by hand. Everything stays on this computer.')),
      h('a', { class: 'btn', href: '#/', title: 'Back to the Studio' }, icon('month'), 'Studio'),
      h('button', { class: 'btn primary', onclick: newProject }, icon('plus'), 'New project')),
    list.length ? list.map((p) => h('section', { class: 'proj' },
      h('header', {}, h('h2', {}, p.name), h('span', { class: 'swatch-row' }, Object.values(p.colors).slice(0, 6).map((c) => h('i', { style: { background: c } }))), h('span', { class: 'muted' }, p.id), h('button', { class: 'btn quiet sm', type: 'button', title: 'Move this brand to the trash (you can restore it)', onclick: () => removeBrand({ id: p.id, name: p.name }, { afterChange: async () => { await loadProjects(); renderHome(root); } }) }, 'Remove brand…')),
      h('div', { class: 'cards' },
        p.docs.filter((d) => !d.explore).map((d) => {
          const takes = p.docs.filter((t) => t.explore?.of === d.id).length;
          return h('a', { class: 'card', href: `#/p/${p.id}/${d.id}` }, h('strong', {}, d.title), h('div', { class: 'k' }, `${d.kind}${d.kind === 'carousel' ? ` · ${d.pages} page${d.pages === 1 ? '' : 's'}` : ''} · ${d.sizes.length} size${d.sizes.length === 1 ? '' : 's'}`), takes ? h('div', { class: 'k' }, `${takes} alternative take${takes === 1 ? '' : 's'} in Explore`) : null);
        }),
        h('a', { class: 'card new', href: '#', onclick: (e) => { e.preventDefault(); newPost(p); } }, icon('plus'), ' New post'))))
      : h('div', { class: 'empty' }, 'No projects yet. Create one to begin.')));
}
