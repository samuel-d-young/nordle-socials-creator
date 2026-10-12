// Stock libraries in the Studio: one window with two tabs.
//   Libraries  the owner adds a library and pastes its API key (sent once to Nordle on this computer, kept in a private file, never shown
//              again), tests it, forgets or removes it, and adds a folder of their own stock (the route for Envato Elements).
//   Search     looks through the libraries that are ready and brings the file you choose into a project, with its licence written down.
// Nothing here buys anything or signs in to a site. Pictures in the results come through Nordle (/api/stock/thumb), never straight from a
// library's server: the page's content-security policy keeps pictures same-origin, and a direct load would tell the library who is looking.
// The server (src/server/routes/stock.mjs, src/stock/*) is what enforces who may do what; this window only makes it easy and plain.

import { api } from './api.js';
import { h, icon, preserveFocus } from './dom.js';
import { S } from './studio-store.js';
import { askConfirm, folderPicker, plural } from './studio-ui.js';
import { STOCK_GUIDES, STOCK_NO_KEY, guideBlock } from './platform-guides.js';

const token = document.querySelector('meta[name="nordle-token"]')?.content ?? '';
const KIND_ORDER = ['photo', 'video', 'music', 'sfx'];
const KIND_ONE = { photo: 'photo', video: 'video', music: 'music', sfx: 'sound effect' };
const KIND_MANY = { photo: 'Photos', video: 'Video', music: 'Music', sfx: 'Sound effects' };
const PER_PAGE = 12;
const EXAMPLE_PATH = 'D:/Stock/Videos';

/** What was chosen last, kept while this page stays open, so the window comes back as it was left. */
const mem = { library: '', kind: '', q: '', project: '' };

// ---- small pieces ----------------------------------------------------------------------------------------------------------------------

function modal(title) {
  const body = h('div', { class: 'db stk' });
  const toasts = h('div', { class: 'stk-toasts' });     // notes sit in the footer, beside Close: over the results they would hide the buttons they are about
  const foot = h('div', { class: 'df stk-foot' }, toasts);
  const dlg = h('dialog', { class: 'wide stk-dialog', 'aria-label': title }, h('div', { class: 'dh' }, title), body, foot);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  return { dlg, body, foot, toasts, close: () => dlg.close() };
}

const btn = (label, o = {}, ...kids) => h('button', {
  class: `btn${o.primary ? ' primary' : ''}${o.go ? ' go' : ''}${o.quiet ? ' quiet' : ''}`, type: 'button', disabled: !!o.disabled, onclick: o.onclick,
  'data-act': o.act, 'data-field': o.field, title: o.title, 'aria-label': o.label,
}, ...kids, label);

const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36).replace(/-+$/g, '');
const clock = (s) => { const t = Math.round(s); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
const enc = encodeURIComponent;
/** The address as written, when it is an https address (the server remembers pictures by their exact text, so it is never rewritten). */
const httpsOnly = (u) => { try { return typeof u === 'string' && new URL(u).protocol === 'https:' ? u : null; } catch { return null; } };

/** A title for a card: Pexels videos are titled by their page address, so say the words in it instead. */
function niceTitle(it) {
  const t = String(it.title ?? '').trim();
  if (/^https?:\/\//i.test(t)) {
    try {
      const last = new URL(t).pathname.split('/').filter(Boolean).pop() ?? '';
      const words = decodeURIComponent(last).replace(/[-_]+/g, ' ').trim();
      if (words) return words;
    } catch { /* not an address after all */ }
  }
  return t || `${KIND_ONE[it.kind] ?? 'item'} ${it.id}`;
}

/** An error, in plain words: the sentence to show, and whether it is about the key (then the Libraries tab is the way on). */
function problem(e) {
  if (!e || e.status === undefined) return { text: 'Nordle did not answer. Is it still running? Nothing was lost.', key: false };
  const code = e.errors?.[0]?.code;
  const key = code === 'key-refused' || /refused the key|needs an API key|has not been added/i.test(String(e.message));
  return { text: String(e.message || 'That did not work.'), key };
}

function banner(b, onClose) {
  return h('div', { class: `acc-banner ${b.ok ? 'ok' : 'bad'}`, role: 'status', dataset: { state: b.ok ? 'ok' : 'bad' } },
    h('span', { class: 'acc-banner-i' }, icon(b.ok ? 'check' : 'alert', 18)),
    h('div', {}, h('b', {}, b.title), b.text ? h('p', {}, b.text) : null),
    h('button', { class: 'notice-x', type: 'button', 'aria-label': 'Dismiss', onclick: onClose }, icon('x', 12)));
}

// ---- the window ------------------------------------------------------------------------------------------------------------------------

/**
 * Open the Stock window. `project` is the brand the Studio is filtered to (the default for "Use in…"); `tab` is 'libs' or 'search'.
 * Resolves when the window is closed.
 */
export async function openStock({ project = '', tab = '' } = {}) {
  const m = modal('Stock libraries');
  const st = {
    libs: null, loadError: '', tab: 'libs',
    banners: new Map(),          // library id -> { ok, title, text }, the note under its name
    replacing: new Set(),        // libraries whose key box is open although a key is already saved
    opened: new Set(),           // libraries added without a key stay on one slim line until "Set up" opens them
    brandEdit: new Set(),        // folders whose brands list is open for changing
    picked: new Set(),           // libraries chosen from the list (not added yet): their steps and Add button are showing
    noKey: '',                   // a site with no personal key, chosen from the list: its explanation is showing
    busy: new Set(),             // 'pexels:test' ... while a request is out
    folderBanner: null,
    project: project || mem.project,
    search: { library: mem.library, kind: mem.kind, status: 'idle', page: 1, result: null, problem: null, seq: 0 },
    used: new Map(),             // 'library|kind|id' -> { project, path } for what was brought in during this visit
  };
  const keyFields = new Map();   // library id -> its password box (kept across redraws; emptied the moment the key is saved)
  let folderForm = null;

  const el = {};
  el.live = h('p', { class: 'sr', role: 'status', 'aria-live': 'polite' });
  const announce = (text) => { el.live.textContent = text; };

  // ---- tabs ----
  const tabs = [['libs', 'Libraries'], ['search', 'Search']];
  el.tabs = h('div', { class: 'stk-tabs', role: 'tablist', 'aria-label': 'Stock' }, tabs.map(([id, label]) => h('button', {
    class: 'stk-tab', type: 'button', role: 'tab', id: `stk-tab-${id}`, 'aria-controls': `stk-panel-${id}`, 'aria-selected': 'false', tabindex: '-1', 'data-tab': id,
    onclick: () => show(id),
    onkeydown: (e) => {
      const i = tabs.findIndex(([x]) => x === id);
      const to = e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i + tabs.length - 1) % tabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
      if (to < 0) return;
      e.preventDefault();
      show(tabs[to][0], { focus: true });
    },
  }, label)));
  el.libsPanel = h('section', { class: 'stk-panel', id: 'stk-panel-libs', role: 'tabpanel', 'aria-labelledby': 'stk-tab-libs', hidden: true });
  el.searchPanel = h('section', { class: 'stk-panel', id: 'stk-panel-search', role: 'tabpanel', 'aria-labelledby': 'stk-tab-search', hidden: true });
  el.boot = h('div', {});            // "Loading the libraries…" (or why it could not): the tabs only appear once the answer is in, so none is chosen and then changed
  el.tabs.hidden = true;
  m.body.append(el.live, el.boot, el.tabs, el.libsPanel, el.searchPanel);
  m.foot.append(btn('Close', { onclick: m.close, act: 'stock-close' }));

  function show(id, { focus = false } = {}) {
    st.tab = id;
    for (const b of el.tabs.children) { const on = b.dataset.tab === id; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; }
    el.libsPanel.hidden = id !== 'libs';
    el.searchPanel.hidden = id !== 'search';
    if (id === 'libs') drawLibs(); else drawSearch();
    if (focus) el.tabs.querySelector(`[data-tab="${id}"]`)?.focus();
  }

  // ---- the toast (inside this window: a page-level toast would sit behind a modal dialog) ----
  function toast(kids, kind = 'ok', ms = 12000) {
    const t = h('div', { class: `stk-toast ${kind}`, role: kind === 'error' ? 'alert' : 'status', dataset: { kind } },
      h('span', { class: 'stk-toast-i' }, icon(kind === 'ok' ? 'check' : 'alert', 16)),
      h('div', { class: 'stk-toast-t' }, ...kids),
      h('button', { class: 'notice-x', type: 'button', 'aria-label': 'Dismiss', onclick: () => t.remove() }, icon('x', 12)));
    m.toasts.append(t);
    while (m.toasts.children.length > 2) m.toasts.firstChild.remove();
    setTimeout(() => t.remove(), kind === 'error' ? Math.max(ms, 16000) : ms);
    announce(t.querySelector('.stk-toast-t').textContent);
  }

  // ---- what the server says ----
  async function loadLibs() {
    try { st.libs = (await api.get('/stock/libraries')).libraries; st.loadError = ''; } catch (e) { st.loadError = problem(e).text; }
  }
  const libOf = (id) => st.libs?.find((l) => l.id === id);
  /** A library is for the chosen brand when no brands are saved on it (all brands) or the brand is among them. */
  const forBrand = (l, brand) => !l.brands?.length || !brand || l.brands.includes(brand);
  const brandsText = (l) => (l.brands?.length ? l.brands.map((id) => S.projects.find((p) => p.id === id)?.name ?? id).join(', ') : 'All brands');
  const readyLibs = () => (st.libs ?? []).filter((l) => l.added && l.configured && forBrand(l, st.project));
  const redrawLibs = () => preserveFocus(el.libsPanel, drawLibs);

  // ======================================================================================================================================
  // Libraries tab
  // ======================================================================================================================================

  const keyField = (id) => {
    if (!keyFields.has(id)) {
      const input = h('input', { class: 'field', type: 'password', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', 'aria-label': `API key for ${libOf(id)?.name ?? id}`, 'data-field': `stock-key-${id}`, placeholder: 'Paste the key here' });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveKey(id); } });
      keyFields.set(id, input);
    }
    return keyFields.get(id);
  };

  async function saveKey(id) {
    const input = keyField(id);
    const key = input.value.trim();
    const l = libOf(id);
    if (!key) { st.banners.set(id, { ok: false, title: 'Paste the key first', text: 'The box is empty.' }); redrawLibs(); input.focus(); return; }
    st.busy.add(`${id}:key`); redrawLibs();
    try {
      await api.post('/stock/settings', { library: id, key });
    } catch (e) {
      st.busy.delete(`${id}:key`);
      st.banners.set(id, { ok: false, title: 'The key was not saved', text: problem(e).text });
      redrawLibs();
      return;
    }
    input.value = '';                          // the key has been sent once; it is not kept in this page
    keyFields.delete(id);
    st.replacing.delete(id);
    st.busy.delete(`${id}:key`);
    await loadLibs();
    await runTest(id, { saved: true });
  }

  async function runTest(id, { saved = false } = {}) {
    const name = libOf(id)?.name ?? id;
    st.busy.add(`${id}:test`); redrawLibs();
    let r;
    try { r = await api.post('/stock/test', { library: id }); } catch (e) { r = { ok: false, message: problem(e).text }; }
    st.busy.delete(`${id}:test`);
    st.banners.set(id, r.ok
      ? { ok: true, title: saved ? `Key saved. ${name} works` : `${name} works`, text: r.message }
      : { ok: false, title: saved ? `Key saved, but ${name} did not accept it` : `${name} did not work`, text: r.message });
    redrawLibs();
    announce(`${st.banners.get(id).title}. ${r.message ?? ''}`);
    el.libsPanel.querySelector(`[data-library="${CSS.escape(id)}"] .acc-banner`)?.scrollIntoView({ block: 'nearest' });
    // back to this card's Test button, unless the person has since moved on to another library's box
    const a = document.activeElement;
    if (!a?.closest?.('.stk-lib') || a.closest(`[data-library="${CSS.escape(id)}"]`)) el.libsPanel.querySelector(`[data-field="stock-test-${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
  }

  async function addPreset(l) {
    st.busy.add(`${l.id}:add`); redrawLibs();
    try {
      st.libs = (await api.post('/stock/settings', { library: l.id, preset: l.id })).libraries;
      st.banners.set(l.id, { ok: true, title: `${l.name} added`, text: l.takesKey ? 'Paste its API key below and press Save key.' : 'It is ready to search.' });
    } catch (e) { st.banners.set(l.id, { ok: false, title: `${l.name} was not added`, text: problem(e).text }); }
    st.busy.delete(`${l.id}:add`);
    redrawLibs();
    el.libsPanel.querySelector(`[data-field="stock-key-${CSS.escape(l.id)}"]`)?.focus();
  }

  async function forgetKey(l) {
    if (!(await askConfirm({ title: `Forget the key for ${l.name}?`, body: `${l.name} stops working here until a key is saved again. The library itself is not changed.`, ok: 'Forget key', danger: true }))) return;
    try {
      st.libs = (await api.post('/stock/settings', { library: l.id, key: null })).libraries;
      st.opened.add(l.id);   // it was open a moment ago: it stays open for the new key
      st.banners.set(l.id, { ok: true, title: 'Key forgotten', text: `${l.name} needs a key again before it can be searched.` });
    } catch (e) { st.banners.set(l.id, { ok: false, title: 'The key was not forgotten', text: problem(e).text }); }
    redrawLibs();
  }

  async function removeLib(l) {
    const what = l.type === 'folder' ? `The files in the folder are not touched, and files already in a project stay.` : `Its key is forgotten, and it can be added again later. Files already in a project stay.`;
    if (!(await askConfirm({ title: `Remove ${l.name}?`, body: what, ok: 'Remove', danger: true }))) return;
    try {
      st.libs = (await api.post('/stock/settings', { library: l.id, remove: true })).libraries;
      keyFields.delete(l.id); st.banners.delete(l.id); st.replacing.delete(l.id);
      if (st.search.library === l.id) { st.search.library = ''; st.search.kind = ''; st.search.status = 'idle'; st.search.result = null; }
      announce(`${l.name} removed.`);
    } catch (e) {
      (l.type === 'folder' ? (st.folderBanner = { ok: false, title: `${l.name} was not removed`, text: problem(e).text }) : st.banners.set(l.id, { ok: false, title: `${l.name} was not removed`, text: problem(e).text }));
    }
    redrawLibs();
  }

  function keyArea(l) {
    if (!l.added || !l.takesKey) return null;
    const open = !l.hasKey || st.replacing.has(l.id);
    if (!open) {
      return h('div', { class: 'stk-key saved' },
        h('span', { class: 'stk-key-ok' }, icon('check', 14), 'A key is saved'),
        btn('Replace', { quiet: true, act: 'stock-replace', field: `stock-replace-${l.id}`, label: `Replace key for ${l.name}`, onclick: () => { st.replacing.add(l.id); redrawLibs(); keyField(l.id).focus(); } }),
        btn('Forget key', { quiet: true, act: 'stock-forget', field: `stock-forget-${l.id}`, label: `Forget key for ${l.name}`, onclick: () => forgetKey(l) }));
    }
    const busy = st.busy.has(`${l.id}:key`);
    return h('div', { class: 'stk-key' },
      h('label', { class: 'stk-key-l' }, h('span', { class: 'lbl-i' }, l.hasKey ? 'New API key' : 'API key'), keyField(l.id)),
      h('div', { class: 'stk-key-acts' },
        btn(busy ? 'Saving…' : 'Save key', { primary: true, act: 'stock-save-key', field: `stock-save-${l.id}`, label: `Save key for ${l.name}`, disabled: busy, onclick: () => saveKey(l.id) }),
        l.hasKey ? btn('Cancel', { quiet: true, act: 'stock-replace-cancel', onclick: () => { keyField(l.id).value = ''; keyFields.delete(l.id); st.replacing.delete(l.id); redrawLibs(); } }) : null),
      h('p', { class: 'sch-help' }, 'Paste it here once. It is sent to Nordle on this computer, kept in a private file, and never shown again. Saving tests it straight away.'));
  }

  // ---- which brands use a library (empty = every brand) ----
  async function saveBrands(l, brands) {
    try {
      st.libs = (await api.post('/stock/settings', { library: l.id, brands })).libraries;
      st.brandEdit.delete(l.id);
      announce(`${l.name} is now for ${brands.length ? brands.length === 1 ? '1 brand' : `${brands.length} brands` : 'every brand'}.`);
    } catch (e) { toast([h('span', { class: 'stk-toast-t' }, problem(e).text)], 'error'); }
    redrawLibs();
  }
  function brandsRow(l) {
    if (!S.projects.length) return null;
    if (!st.brandEdit.has(l.id)) {
      return h('div', { class: 'stk-brands', dataset: { library: l.id, brands: (l.brands ?? []).join(',') } }, h('span', { class: 'lbl-i' }, 'Used for'), h('b', {}, brandsText(l)),
        btn('Change', { quiet: true, act: 'stock-brands', field: `stock-brands-${l.id}`, label: `Choose which brands use ${l.name}`, onclick: () => { st.brandEdit.add(l.id); redrawLibs(); } }));
    }
    const boxes = S.projects.map((p) => h('label', { class: 'acc-strip' }, h('input', { type: 'checkbox', checked: (l.brands ?? []).includes(p.id), 'data-brand': p.id, 'aria-label': `${l.name} is for ${p.name}` }), p.name));
    const row = h('div', { class: 'stk-brands editing', dataset: { library: l.id } }, h('span', { class: 'lbl-i' }, 'Used for'),
      h('div', { class: 'stk-brand-boxes' }, boxes), h('p', { class: 'muted bg-hint' }, 'Tick the brands that may use it. Leave every box empty for all brands.'),
      h('div', { class: 'stk-acts' },
        btn('Save', { primary: true, act: 'stock-brands-save', field: `stock-brands-save-${l.id}`, onclick: () => saveBrands(l, [...row.querySelectorAll('input[data-brand]')].filter((i) => i.checked).map((i) => i.dataset.brand)) }),
        btn('Cancel', { quiet: true, onclick: () => { st.brandEdit.delete(l.id); redrawLibs(); } })));
    return row;
  }

  function libCard(l) {
    // added without a key: one slim line until it is opened (or chosen from the list): nothing to read or fill in until then
    if (l.added && l.takesKey && !l.hasKey && !st.opened.has(l.id) && !st.picked.has(l.id)) {
      return h('article', { class: 'stk-lib stk-min', dataset: { library: l.id, state: 'needs-key', minimised: 'true' } },
        h('h3', { class: 'stk-name', id: `stk-h-${l.id}` }, l.name),
        h('ul', { class: 'stk-chips', 'aria-label': 'Offers' }, l.kinds.map((k) => h('li', { class: 'stk-chip' }, KIND_ONE[k] ?? k))),
        h('span', { class: 'stk-state warn' }, icon('alert', 14), 'Needs an API key'),
        btn('Set up', { quiet: true, act: 'stock-open', field: `stock-open-${l.id}`, label: `Set up ${l.name}`, onclick: () => { st.opened.add(l.id); redrawLibs(); } }));
    }
    const ready = l.added && l.configured;
    const state = !l.added ? { text: 'Not added', tone: 'none', mark: h('i', { class: 'stk-ring', 'aria-hidden': 'true' }) }
      : ready ? { text: 'Ready', tone: 'ok', mark: icon('check', 14) }
        : { text: `Needs ${l.needs.join(' and ') || 'setup'}`, tone: 'warn', mark: icon('alert', 14) };
    const b = st.banners.get(l.id);
    const searchOnly = !l.canDownload && l.type !== 'folder';
    return h('article', { class: 'stk-lib', 'aria-labelledby': `stk-h-${l.id}`, dataset: { library: l.id, state: !l.added ? 'not-added' : ready ? 'ready' : 'needs-key' } },
      h('div', { class: 'stk-lib-head' },
        h('h3', { class: 'stk-name', id: `stk-h-${l.id}` }, l.name),
        h('ul', { class: 'stk-chips', 'aria-label': 'Offers' }, [...l.kinds.map((k) => h('li', { class: 'stk-chip', dataset: { kind: k } }, KIND_ONE[k] ?? k)),
          searchOnly ? h('li', { class: 'stk-chip only', title: `Results link to the item on ${l.name}. Nordle never buys: a file you buy there is added through a folder library.` }, 'search only') : null]),
        h('span', { class: `stk-state ${state.tone}` }, state.mark, state.text)),
      l.note ? h('p', { class: 'stk-note' }, l.note) : null,
      l.added ? brandsRow(l) : null,
      STOCK_GUIDES[l.id] && !(l.added && l.hasKey) ? h('details', { class: 'stk-how', open: !l.added }, h('summary', {}, 'How to get a key'), guideBlock(STOCK_GUIDES[l.id])) : null,
      h('p', { class: 'stk-lic' }, h('span', { class: 'lbl-i' }, 'Licence'), l.license || 'Not stated: check the library’s own page.'),
      l.verified === false ? h('p', { class: 'stk-caution' }, icon('alert', 14), h('span', {}, h('b', {}, 'Definition not yet tried with a live key. '), 'It was written from the library’s public documentation. If a search comes back wrong, press Test and read what it says.')) : null,
      b ? banner(b, () => { st.banners.delete(l.id); redrawLibs(); }) : null,
      keyArea(l),
      h('div', { class: 'stk-acts' },
        !l.added ? btn(st.busy.has(`${l.id}:add`) ? 'Adding…' : 'Add', { primary: true, act: 'stock-add', field: `stock-add-${l.id}`, label: `Add ${l.name}`, disabled: st.busy.has(`${l.id}:add`), onclick: () => addPreset(l) }) : null,
        l.added ? btn(st.busy.has(`${l.id}:test`) ? 'Testing…' : 'Test', { act: 'stock-test', field: `stock-test-${l.id}`, label: `Test ${l.name}`, title: l.configured ? 'One small search, to see whether it answers' : 'Save the key first', disabled: !l.configured || st.busy.has(`${l.id}:test`), onclick: () => runTest(l.id) }) : null,
        l.added && l.type !== 'code' ? btn('Remove', { quiet: true, act: 'stock-remove', field: `stock-remove-${l.id}`, label: `Remove ${l.name}`, onclick: () => removeLib(l) }) : null));
  }

  // ---- a folder of your own stock ----
  function folderFields() {
    folderForm ??= {
      name: h('input', { class: 'field', autocomplete: 'off', maxlength: 60, placeholder: 'A name, e.g. Envato Elements downloads', 'data-field': 'stock-folder-name' }),
      path: h('input', { class: 'field', autocomplete: 'off', spellcheck: 'false', placeholder: EXAMPLE_PATH, 'data-field': 'stock-folder-path' }),
      license: h('input', { class: 'field', autocomplete: 'off', maxlength: 300, placeholder: 'e.g. Envato Elements licence: register each download to a project in Envato’s own tool', 'data-field': 'stock-folder-license' }),
      kinds: Object.fromEntries(KIND_ORDER.map((k) => [k, h('input', { type: 'checkbox', checked: k === 'video', 'data-field': `stock-folder-kind-${k}` })])),
      brands: Object.fromEntries(S.projects.map((p) => [p.id, h('input', { type: 'checkbox', 'data-field': `stock-folder-brand-${p.id}`, 'aria-label': `For ${p.name}` })])),
    };
    return folderForm;
  }

  async function addFolder() {
    const f = folderFields();
    const name = f.name.value.trim();
    const path = f.path.value.trim();
    const kinds = KIND_ORDER.filter((k) => f.kinds[k].checked);
    const license = f.license.value.trim();
    const brands = S.projects.filter((p) => f.brands[p.id]?.checked).map((p) => p.id);
    const fail = (text, focus) => { st.folderBanner = { ok: false, title: 'The folder was not added', text }; redrawLibs(); (focus ?? f.path).focus(); };
    if (!/^([A-Za-z]:[\\/]|\/)/.test(path)) return fail(`Give the full path of the folder, such as ${EXAMPLE_PATH}.`);
    if (!kinds.length) return fail('Tick what the folder holds: photos, video, music or sound effects.', f.kinds.video);
    const base = name || path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'folder';
    const taken = new Set((st.libs ?? []).map((x) => x.id));
    let id = slug(base) || 'folder';
    for (let n = 2; taken.has(id); n++) id = `${slug(base).slice(0, 36) || 'folder'}-${n}`;
    st.busy.add('folder:add'); redrawLibs();
    try {
      st.libs = (await api.post('/stock/settings', { library: id, path, kinds, ...(brands.length ? { brands } : {}), ...(name ? { name } : {}), ...(license ? { license } : {}) })).libraries;
    } catch (e) { st.busy.delete('folder:add'); return fail(problem(e).text); }
    f.name.value = ''; f.path.value = ''; f.license.value = '';
    for (const box of Object.values(f.brands)) box.checked = false;
    st.busy.delete('folder:add');
    let r;
    try { r = await api.post('/stock/test', { library: id }); } catch (e) { r = { ok: false, message: problem(e).text }; }
    const label = libOf(id)?.name ?? name ?? id;
    st.folderBanner = r.ok ? { ok: true, title: `${label} added`, text: 'The folder is there. Find its files on the Search tab.' } : { ok: false, title: `${label} added, but it cannot be read yet`, text: r.message };
    redrawLibs();
    announce(`${st.folderBanner.title}. ${st.folderBanner.text}`);
  }

  function folderRow(l) {
    return h('li', { class: 'stk-frow', dataset: { library: l.id } },
      h('div', { class: 'stk-frow-main' },
        h('b', {}, l.name),
        h('ul', { class: 'stk-chips', 'aria-label': 'Holds' }, l.kinds.map((k) => h('li', { class: 'stk-chip' }, KIND_ONE[k] ?? k))),
        h('span', { class: 'stk-path' }, l.path ?? ''),
        h('span', { class: 'muted stk-flic' }, l.license ? `Licence: ${l.license}` : 'Licence: whatever you bought or were given with each file.'),
        brandsRow(l)),
      h('div', { class: 'stk-acts' },
        btn(st.busy.has(`${l.id}:test`) ? 'Checking…' : 'Test', { quiet: true, act: 'stock-folder-test', field: `stock-test-${l.id}`, label: `Test folder ${l.name}`, disabled: st.busy.has(`${l.id}:test`), onclick: () => testFolder(l) }),
        btn('Remove', { quiet: true, act: 'stock-folder-remove', field: `stock-remove-${l.id}`, label: `Remove folder ${l.name}`, onclick: () => removeLib(l) })));
  }

  async function testFolder(l) {
    st.busy.add(`${l.id}:test`); redrawLibs();
    let r;
    try { r = await api.post('/stock/test', { library: l.id }); } catch (e) { r = { ok: false, message: problem(e).text }; }
    st.busy.delete(`${l.id}:test`);
    st.folderBanner = r.ok ? { ok: true, title: `${l.name} is readable`, text: r.message } : { ok: false, title: `${l.name} cannot be read`, text: r.message };
    redrawLibs();
  }

  function folderSection() {
    const f = folderFields();
    const folders = (st.libs ?? []).filter((l) => l.type === 'folder');
    const busy = st.busy.has('folder:add');
    return h('section', { class: 'stk-folders', 'data-section': 'stock-folders', 'aria-labelledby': 'stk-folders-h' },
      h('h3', { class: 'lbl stk-sec', id: 'stk-folders-h' }, 'A folder of your own stock'),
      h('p', { class: 'sch-help stk-why' },
        'Envato Elements cannot be searched from another app, so download what you want in your browser into a folder, add that folder here, and Nordle searches it by file and folder name and copies the file you pick into a post’s project. ',
        'Envato Market can be searched on the Search tab but only to look: Nordle never buys anything, so buy the item on Envato first and put the file in a folder like this.'),
      st.folderBanner ? banner(st.folderBanner, () => { st.folderBanner = null; redrawLibs(); }) : null,
      folders.length ? h('ul', { class: 'stk-flist', 'aria-label': 'Folders added' }, folders.map(folderRow)) : h('p', { class: 'muted stk-none' }, 'No folder added yet.'),
      h('div', { class: 'stk-add' },
        h('h4', {}, 'Add a folder'),
        h('div', { class: 'stk-add-grid' },
          h('label', {}, h('span', { class: 'lbl-i' }, 'Folder (the full path)'), folderPicker(f.path, { title: 'Choose the folder of stock files', field: 'stock-pick-folder' })),
          h('label', {}, h('span', { class: 'lbl-i' }, 'Name'), f.name),
          h('fieldset', { class: 'stk-kinds' }, h('legend', { class: 'lbl-i' }, 'What is in it'),
            KIND_ORDER.map((k) => h('label', { class: 'acc-strip' }, f.kinds[k], KIND_MANY[k]))),
          S.projects.length ? h('fieldset', { class: 'stk-kinds' }, h('legend', { class: 'lbl-i' }, 'Which brands use it'), S.projects.map((p) => h('label', { class: 'acc-strip' }, f.brands[p.id] ?? h('i'), p.name)), h('p', { class: 'muted bg-hint' }, 'Leave every box empty to let all brands use it.')) : null,
          h('label', {}, h('span', { class: 'lbl-i' }, 'Licence (one sentence)'), f.license)),
        h('div', { class: 'stk-acts' }, btn(busy ? 'Adding…' : 'Add folder', { primary: true, act: 'stock-folder-add', field: 'stock-folder-add', disabled: busy, onclick: addFolder })),
        h('p', { class: 'sch-help' }, 'Nordle only reads inside this folder, and copies a file into the project (it never moves or changes the original). The licence you write is recorded with every file you bring in.')));
  }

  function drawLibs() {
    if (st.libs === null) return;
    const online = st.libs.filter((l) => l.type !== 'folder');
    // only the libraries that were added (or chosen from the list just now) are shown; the rest are one click away in the list
    const shown = online.filter((l) => l.added || st.picked.has(l.id));
    const choices = [...online.filter((l) => !shown.includes(l)).map((l) => [l.id, l.name]), ...Object.entries(STOCK_NO_KEY).map(([id, g]) => [`nokey:${id}`, `${g.name} (no key available)`])];
    const picker = h('label', { class: 'stk-pick' }, h('span', { class: 'lbl-i' }, 'Add a stock site'),
      h('select', { class: 'field', 'data-field': 'stock-pick', 'aria-label': 'Choose a stock site to set up', onchange: (e) => { const v = e.target.value; if (v.startsWith('nokey:')) { st.noKey = v.slice(6); } else if (v) { st.picked.add(v); st.noKey = ''; } e.target.value = ''; redrawLibs(); el.libsPanel.querySelector(v.startsWith('nokey:') ? '.stk-nokey' : `[data-library="${CSS.escape(v)}"]`)?.scrollIntoView({ block: 'nearest' }); } },
        h('option', { value: '' }, 'Choose a site…'), choices.map(([id, name]) => h('option', { value: id }, name))));
    const noKey = STOCK_NO_KEY[st.noKey];
    el.libsPanel.replaceChildren(...[
      h('p', { class: 'sch-help stk-intro' }, 'Each library is searched with your own key, kept on this computer. Nordle never buys anything and never signs in to a site for you; every file it brings in has its licence written down.'),
      picker,
      noKey ? h('section', { class: 'stk-nokey', 'data-section': 'stock-nokey' }, guideBlock(noKey, h('div', { class: 'stk-acts' }, btn('Add a folder instead', { primary: true, act: 'stock-nokey-folder', onclick: () => { st.noKey = ''; redrawLibs(); el.libsPanel.querySelector('[data-field="stock-folder-path"]')?.focus(); } }), btn('Close', { quiet: true, onclick: () => { st.noKey = ''; redrawLibs(); } })))) : null,
      h('div', { class: 'stk-libs', role: 'list', 'aria-label': 'Libraries' }, shown.map((l) => h('div', { role: 'listitem' }, libCard(l)))),
      folderSection(),
    ].filter(Boolean));
  }

  // ======================================================================================================================================
  // Search tab
  // ======================================================================================================================================

  el.lib = h('select', { class: 'field', 'aria-label': 'Library', 'data-field': 'stock-library', onchange: () => { st.search.library = el.lib.value; mem.library = st.search.library; st.search.kind = ''; fillSelects(); resetResults(); drawResults(); } });
  el.kind = h('select', { class: 'field', 'data-field': 'stock-kind', onchange: () => { st.search.kind = el.kind.value; mem.kind = st.search.kind; resetResults(); drawResults(); } });
  el.q = h('input', { class: 'field', type: 'search', autocomplete: 'off', spellcheck: 'false', maxlength: 200, value: mem.q, placeholder: 'e.g. calm waiting room', 'data-field': 'stock-q' });
  el.q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch(1); } });
  el.q.addEventListener('input', () => { mem.q = el.q.value; });
  el.project = h('select', { class: 'field', 'data-field': 'stock-project', onchange: () => { st.project = el.project.value; mem.project = st.project; const before = st.search.library; fillSelects(); if (st.search.library !== before) { resetResults(); drawResults(); } } });   // results stay unless the brand has changed which libraries are on offer
  el.note = h('p', { class: 'stk-only stk-note-dl' });
  el.results = h('div', { class: 'stk-results', 'aria-busy': 'false', 'data-field': 'stock-results' });
  const labelled = (text, control, cls = '') => h('label', { class: cls }, h('span', { class: 'lbl-i' }, text), control);

  const currentLib = () => readyLibs().find((l) => l.id === st.search.library) ?? null;
  function resetResults() { st.search.seq++; Object.assign(st.search, { status: 'idle', result: null, problem: null, page: 1 }); }

  function fillSelects() {
    const ready = readyLibs();
    if (!ready.some((l) => l.id === st.search.library)) st.search.library = ready[0]?.id ?? '';
    const lib = currentLib();
    el.lib.replaceChildren(...ready.map((l) => h('option', { value: l.id, selected: l.id === st.search.library }, l.name)));
    el.lib.value = st.search.library;
    const kinds = lib?.kinds ?? [];
    if (!kinds.includes(st.search.kind)) st.search.kind = kinds[0] ?? '';
    el.kind.replaceChildren(...kinds.map((k) => h('option', { value: k, selected: k === st.search.kind }, KIND_MANY[k] ?? k)));
    el.kind.value = st.search.kind;
    if (!S.projects.some((p) => p.id === st.project)) st.project = (S.brand !== 'all' && S.projects.some((p) => p.id === S.brand) ? S.brand : S.projects[0]?.id) ?? '';
    el.project.replaceChildren(...S.projects.map((p) => h('option', { value: p.id, selected: p.id === st.project }, p.name)));
    el.project.value = st.project;
    const canDl = !!lib && lib.downloadKinds.includes(st.search.kind);
    el.note.hidden = !lib || canDl;
    el.note.replaceChildren(...(lib && !canDl ? [icon('info', 14), `You can look here but not download: buy it on ${lib.name}, then add the file through a folder library (Libraries tab).`] : []));
  }

  let cardCount = 0;

  function drawSearch() {
    if (st.libs === null) return;
    const ready = readyLibs();
    if (!ready.length) {
      el.searchPanel.replaceChildren(h('div', { class: 'stk-empty' },
        h('h3', {}, 'No library is ready to search yet'),
        h('p', {}, 'Add a library and save its API key on the Libraries tab, or add a folder of your own stock.'),
        btn('Go to Libraries', { primary: true, act: 'stock-go-libs', onclick: () => show('libs', { focus: true }) })));
      return;
    }
    fillSelects();
    el.searchPanel.replaceChildren(
      h('div', { class: 'stk-bar', role: 'search', 'aria-label': 'Search a stock library' },
        labelled('Library', el.lib), labelled('Looking for', el.kind), labelled('What to look for', el.q, 'stk-q'),
        btn('Search', { primary: true, act: 'stock-search', field: 'stock-search', onclick: () => runSearch(1) }, icon('search', 14))),
      h('div', { class: 'stk-use' }, h('label', { class: 'stk-use-l' }, h('span', { class: 'lbl-i' }, 'Use in'), el.project), h('span', { class: 'muted' }, 'The project a file is brought into. It is saved under assets/stock/, with its licence written down.')),
      el.note,
      el.results);
    drawResults();
  }

  async function runSearch(page = 1, { top = false } = {}) {
    const lib = currentLib();
    if (!lib) return;
    const q = el.q.value.trim();
    mem.q = el.q.value;
    st.search.library = lib.id; st.search.kind = el.kind.value;
    if (!q) { Object.assign(st.search, { status: 'error', problem: { text: 'Say what to look for.', key: false, plain: true } }); drawResults(); el.q.focus(); return; }
    const seq = ++st.search.seq;
    Object.assign(st.search, { status: 'loading', page, problem: null });
    drawResults();
    announce(`Searching ${lib.name}…`);
    try {
      const r = await api.get(`/stock/search?library=${enc(lib.id)}&q=${enc(q)}&kind=${enc(st.search.kind)}&page=${page}&perPage=${PER_PAGE}${st.project ? `&project=${enc(st.project)}` : ''}`);
      if (seq !== st.search.seq) return;
      Object.assign(st.search, { status: 'done', result: r });
    } catch (e) {
      if (seq !== st.search.seq) return;
      Object.assign(st.search, { status: 'error', problem: problem(e), result: null });
    }
    drawResults();
    const sum = el.results.querySelector('.stk-sum');
    if (sum) announce(sum.textContent);
    else if (st.search.problem) announce(st.search.problem.text);
    (sum ?? el.results.querySelector('.stk-problem'))?.focus({ preventScroll: true });
    if (top) m.body.scrollTop = 0;             // another page: back to the top of the window, where the new results start
  }

  function summaryText(r) {
    const n = r.items.length;
    if (!n) return `Nothing found for “${r.query}” in ${r.name}.`;
    const of = r.total !== null && r.total > n ? ` of about ${r.total.toLocaleString('en-AU')}` : '';
    return `${plural(n, 'result')}${of} for “${r.query}” in ${r.name} (${KIND_MANY[r.kind]?.toLowerCase() ?? r.kind}), page ${r.page}.`;
  }

  function drawResults() {
    const s = st.search;
    const lib = currentLib();
    el.results.setAttribute('aria-busy', String(s.status === 'loading'));
    let kids = [];
    if (!lib) kids = [];
    else if (s.status === 'idle') {
      kids = [h('p', { class: 'stk-hint muted' }, lib.type === 'folder' ? 'Type a word from a file or folder name and press Search.' : `Type what you are looking for and press Search. Each search uses one of your ${lib.name} requests, so specific words work best.`)];
    } else if (s.status === 'loading') {
      kids = [h('div', { class: 'stk-loading', role: 'status' }, h('span', { class: 'stk-spin', 'aria-hidden': 'true' }), h('span', {}, `Searching ${lib.name}…`))];
    } else if (s.status === 'error') {
      const p = s.problem;
      kids = [h('div', { class: 'sch-note bad stk-problem', role: 'alert', tabindex: '-1' },
        h('p', {}, p.text),
        h('div', { class: 'sch-note-acts' },
          p.key ? btn('Open the Libraries tab', { primary: true, act: 'stock-go-libs', onclick: () => show('libs', { focus: true }) }) : null,
          !p.key && !p.plain ? btn('Try again', { act: 'stock-retry', onclick: () => runSearch(st.search.page) }) : null))];
    } else {
      const r = s.result;
      const hasNext = r.items.length >= PER_PAGE && (r.total === null || r.page * PER_PAGE < r.total);
      kids = [
        h('p', { class: 'stk-sum', tabindex: '-1' }, summaryText(r)),
        r.items.length ? h('div', { class: 'stk-grid', role: 'list', 'aria-label': 'Results' }, r.items.map((it) => h('div', { role: 'listitem', class: 'stk-cell' }, itemCard(it, lib)))) : h('p', { class: 'stk-none muted' },
          lib.type === 'folder' ? 'Folder libraries are searched by file and folder names, so try a word that is in the name.' : 'Try other words, or a different kind of file.'),
        r.page > 1 || hasNext ? h('nav', { class: 'stk-pager', 'aria-label': 'Pages' },
          btn('Previous', { quiet: true, act: 'stock-prev', disabled: r.page <= 1, onclick: () => runSearch(r.page - 1, { top: true }) }, icon('chevL', 14)),
          h('span', { class: 'stk-page' }, r.total !== null && r.total > 0 ? `Page ${r.page} of about ${Math.max(1, Math.ceil(r.total / PER_PAGE))}` : `Page ${r.page}`),
          btn('Next', { quiet: true, act: 'stock-next', disabled: !hasNext, onclick: () => runSearch(r.page + 1, { top: true }) }, icon('chevR', 14))) : null,
      ];
    }
    el.results.replaceChildren(...kids.filter(Boolean));
  }

  function itemCard(it, lib) {
    const can = lib.downloadKinds.includes(it.kind);
    const page = httpsOnly(it.page);
    const title = niceTitle(it);
    const picture = httpsOnly(it.thumb) ?? (it.kind === 'photo' || it.kind === 'video' ? httpsOnly(it.preview) : null);
    const meta = [it.author ? `by ${it.author}` : '', it.width && it.height ? `${it.width} × ${it.height}` : ''].filter(Boolean).join(' · ');   // (the length is on the picture)
    const licence = it.license || lib.license || '';
    const key = `${lib.id}|${it.kind}|${it.id}`;
    const done = h('p', { class: 'stk-done', role: 'status', hidden: !st.used.has(key) });
    const showDone = () => {
      const u = st.used.get(key);
      done.hidden = !u;
      done.replaceChildren(...(u ? [icon('check', 13), `In ${u.project}: `, h('code', {}, u.path)] : []));
    };
    showDone();
    const pic = h('div', { class: 'stk-pic' });
    const placeholder = () => h('span', { class: 'stk-ph' }, icon(it.kind === 'photo' ? 'image' : it.kind === 'video' ? 'film' : 'playOutline', 22), h('span', {}, KIND_ONE[it.kind] ?? it.kind));
    if (picture) {
      const img = h('img', { src: `/api/stock/thumb?url=${enc(picture)}&t=${enc(token)}`, alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' });
      img.addEventListener('error', () => { img.remove(); pic.prepend(placeholder()); });
      pic.append(img);
    } else pic.append(placeholder());
    if (Number.isFinite(it.duration) && it.duration > 0) pic.append(h('span', { class: 'stk-dur' }, clock(it.duration)));
    const titleId = `stk-t-${++cardCount}`;
    const useBtn = can ? btn('Use in…', { primary: true, act: 'stock-use', onclick: () => useItem(it, lib, useBtn, key, showDone) }) : null;
    useBtn?.setAttribute('aria-describedby', titleId);          // read out as "Use in…, <the picture's title>"; the project is the "Use in" box above
    return h('article', { class: 'stk-item', dataset: { id: it.id, kind: it.kind, library: lib.id }, 'aria-labelledby': titleId },
      pic,
      h('h4', { class: 'stk-title', id: titleId, title }, title),
      meta ? h('p', { class: 'stk-meta' }, meta) : null,
      licence ? h('p', { class: 'stk-ilic', title: licence }, `Licence: ${licence}`) : null,
      h('div', { class: 'stk-acts' },
        useBtn,
        page ? h('a', { class: 'btn quiet', href: page, target: '_blank', rel: 'noopener noreferrer', 'data-act': 'stock-view', title: `Opens the page on ${lib.name} in a new tab` }, `View on ${lib.name}`, icon('external', 13)) : null),
      done);
  }

  async function useItem(it, lib, button, key, showDone) {
    const project = el.project.value || st.project;
    if (!project) { toast(['Choose a project first: it is the one the file is saved into.'], 'error'); return; }
    const proj = S.projects.find((p) => p.id === project)?.name ?? project;
    const label = button.textContent;
    button.disabled = true; button.textContent = 'Bringing in…';
    try {
      const r = await api.post('/stock/get', { library: lib.id, id: it.id, kind: it.kind, project });
      st.used.set(key, { project: proj, path: r.path });
      showDone();
      const licence = r.license ? `Licence: ${r.license}` : `Licence: not stated, so check ${lib.name}’s own page.`;
      toast(r.already
        ? [h('b', {}, `Already in ${proj}`), ': ', h('code', {}, r.path), `. Nothing was fetched again. ${licence}`]
        : [h('b', {}, `Saved to ${proj}`), ': ', h('code', {}, r.path), `. ${licence} It is catalogued as “not looked at yet”: look at it and describe it before you use it.`]);
    } catch (e) {
      const p = problem(e);
      toast([h('b', {}, `${niceTitle(it)} was not brought in. `), p.text], 'error');
    }
    button.disabled = false; button.textContent = label;
  }

  // ---- go ----
  async function boot() {
    el.boot.replaceChildren(h('div', { class: 'stk-loading', role: 'status' }, h('span', { class: 'stk-spin', 'aria-hidden': 'true' }), h('span', {}, 'Loading the libraries…')));
    await loadLibs();
    if (st.libs === null) {
      el.boot.replaceChildren(h('div', { class: 'sch-note bad', role: 'alert' }, h('p', {}, st.loadError), btn('Try again', { act: 'stock-reload', onclick: boot })));
      return;
    }
    el.boot.replaceChildren();
    el.tabs.hidden = false;
    show(tab || (readyLibs().length ? 'search' : 'libs'));
  }
  const closed = new Promise((resolve) => m.dlg.addEventListener('close', resolve, { once: true }));
  await boot();
  await closed;
}
