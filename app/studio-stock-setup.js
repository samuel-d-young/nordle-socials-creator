// Add your footage and stock folder while setting up a brand: the same folder library the Stock window makes, in a short form on the "Brand added" page. Once added,
// Claude searches it by itself whenever it builds a post for this brand (see docs/STOCK.md). Online libraries (Pexels, Pixabay, Freesound) need a key typed in once,
// and that is done in the Stock window, which the page links to.

import { api } from './api.js';
import { h, icon } from './dom.js';
import { folderPicker } from './studio-ui.js';

const KINDS = [['video', 'Video'], ['photo', 'Photos'], ['music', 'Music'], ['sfx', 'Sound effects']];
const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36).replace(/-+$/g, '');
const say = (e) => e?.errors?.[0]?.message ?? e?.message ?? String(e);

/**
 * @param {{ brandId: string, brandName: string }} o
 * @returns {HTMLElement}
 */
export function stockSetup({ brandId, brandName }) {
  const added = [];
  const path = h('input', { class: 'field', autocomplete: 'off', spellcheck: 'false', placeholder: 'Choose a folder, or type its full path, e.g. D:/Footage', 'data-field': 'wz-stock-path', 'aria-label': 'Folder' });
  const name = h('input', { class: 'field', autocomplete: 'off', maxlength: 60, placeholder: 'A name (optional), e.g. My footage', 'data-field': 'wz-stock-name', 'aria-label': 'Name' });
  const licence = h('input', { class: 'field', autocomplete: 'off', maxlength: 300, placeholder: 'Licence, one sentence (optional), e.g. My own footage', 'data-field': 'wz-stock-licence', 'aria-label': 'Licence' });
  const kinds = Object.fromEntries(KINDS.map(([k]) => [k, h('input', { type: 'checkbox', checked: k === 'video' || k === 'photo', 'data-field': `wz-stock-kind-${k}` })]));
  const everyBrand = h('input', { type: 'checkbox', 'data-field': 'wz-stock-all' });
  const note = h('p', { class: 'muted', role: 'status', 'data-state': 'wz-stock-note' });
  const list = h('ul', { class: 'wz-stock-list', 'aria-label': 'Folders added' });
  const add = h('button', { class: 'btn primary', type: 'button', 'data-act': 'wz-stock-add' }, 'Add this folder');
  let busy = false;

  const draw = () => list.replaceChildren(...added.map((a) => h('li', { class: a.ok ? '' : 'bad' }, icon(a.ok ? 'check' : 'alert', 13), ' ', h('b', {}, a.name), ' ', h('span', { class: 'muted' }, a.text))));

  add.addEventListener('click', async () => {
    if (busy) return;
    const p = path.value.trim();
    const picked = KINDS.map(([k]) => k).filter((k) => kinds[k].checked);
    if (!/^([A-Za-z]:[\\/]|\/)/.test(p)) { note.textContent = 'Choose the folder first (or type its full path, such as D:/Footage).'; path.focus(); return; }
    if (!picked.length) { note.textContent = 'Tick what is in the folder: video, photos, music or sound effects.'; return; }
    busy = true; add.disabled = true; add.textContent = 'Adding…'; note.textContent = '';
    const label = name.value.trim() || p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'folder';
    try {
      let taken = new Set();
      try { taken = new Set(((await api.get('/stock/libraries')).libraries ?? []).map((l) => l.id)); } catch { /* the server says if the name is taken */ }
      let id = slug(label) || 'folder';
      for (let n = 2; taken.has(id); n++) id = `${(slug(label) || 'folder').slice(0, 33)}-${n}`;
      await api.post('/stock/settings', { library: id, path: p, kinds: picked, ...(everyBrand.checked ? {} : { brands: [brandId] }), ...(name.value.trim() ? { name: name.value.trim() } : {}), ...(licence.value.trim() ? { license: licence.value.trim() } : {}) });
      let r;
      try { r = await api.post('/stock/test', { library: id }); } catch (e) { r = { ok: false, message: say(e) }; }
      added.push({ ok: !!r.ok, name: label, text: r.ok ? `added for ${everyBrand.checked ? 'all your brands' : brandName}. Claude will search it itself when it builds.` : `added, but it cannot be read yet: ${r.message}` });
      path.value = ''; name.value = ''; licence.value = ''; path.dispatchEvent(new Event('input'));
      draw();
    } catch (e) { note.textContent = `The folder was not added: ${say(e)}`; }
    busy = false; add.disabled = false; add.textContent = 'Add another folder';
  });

  return h('div', { class: 'wz-stock', 'data-field': 'wz-stock' },
    list,
    h('div', { class: 'stk-add-grid' },
      h('label', {}, h('span', { class: 'lbl-i' }, 'Folder'), folderPicker(path, { title: 'Choose the folder with your footage or stock', field: 'wz-stock-pick-folder' })),
      h('label', {}, h('span', { class: 'lbl-i' }, 'Name'), name),
      h('fieldset', { class: 'stk-kinds' }, h('legend', { class: 'lbl-i' }, 'What is in it'), KINDS.map(([k, l]) => h('label', { class: 'acc-strip' }, kinds[k], l))),
      h('label', {}, h('span', { class: 'lbl-i' }, 'Licence'), licence),
      h('label', { class: 'acc-strip' }, everyBrand, 'Also use it for my other brands')),
    h('div', { class: 'row' }, add),
    note,
    h('p', { class: 'muted bg-hint' }, 'Nordle only reads inside this folder and copies a file into the brand when it uses it. It never moves or changes your originals.'));
}
