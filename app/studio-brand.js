// A brand's simple style guide (read it, tweak it) and the "Add a brand" steps (look for the brand's style automatically, or fill it in by hand).
// Server: GET/POST /api/brand/guide, POST /api/brand/scan, POST /api/brand/create (src/server/routes/brand.mjs). Nothing here saves until a
// button says so, and the scan only drafts: the person reviews every colour and word before the brand is made.

import { api } from './api.js';
import { h, icon } from './dom.js';
import { load } from './studio-store.js';
import { folderPicker, notify } from './studio-ui.js';
import { LOGO_KINDS, logoSlots, shotImport, trainImport } from './studio-logos.js';

const MAX_FOLDERS = 8;   // the same limit the server's scan applies (src/brand/scan.mjs)

function modal(title, { cls = 'wide' } = {}) {
  const body = h('div', { class: 'db' });
  const foot = h('div', { class: 'df' });
  const dlg = h('dialog', { class: `${cls} brand-dlg`, 'aria-label': title }, h('div', { class: 'dh' }, title), body, foot);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  return { dlg, body, foot, close: () => dlg.close(), title: (t) => { dlg.querySelector('.dh').textContent = t; dlg.setAttribute('aria-label', t); } };
}
const btn = (label, o = {}, ...kids) => h('button', { class: `btn${o.primary ? ' primary' : ''}${o.go ? ' go' : ''}${o.quiet ? ' quiet' : ''}`, type: 'button', disabled: !!o.disabled, onclick: o.onclick, 'data-act': o.act, title: o.title }, ...kids, label);
const lines = (s) => String(s ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
const commas = (s) => String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const HEX = /^#[0-9a-fA-F]{6}$/;
const INDUSTRY_IDEAS = ['Dentistry', 'Health and medical', 'Beauty and aesthetics', 'Fitness and sport', 'Food and hospitality', 'Cleaning services', 'Trades and building', 'Education and training', 'Real estate', 'Legal services', 'Finance and accounting', 'Retail and e-commerce', 'Automotive', 'Events and entertainment', 'Weddings and photography', 'Creative and marketing', 'Technology and software', 'Charity and community', 'Pets and animals', 'Travel and tourism'];
const FONT_IDEAS = ['Fraunces', 'Inter', 'Playfair Display', 'Cormorant Garamond', 'Lora', 'Merriweather', 'Montserrat', 'Poppins', 'Open Sans', 'Roboto', 'Work Sans', 'DM Sans', 'Oswald', 'Bebas Neue'];
export const ZONES = ['Australia/Melbourne', 'Australia/Sydney', 'Australia/Brisbane', 'Australia/Adelaide', 'Australia/Perth', 'Australia/Hobart', 'Australia/Darwin', 'Pacific/Auckland', 'UTC'];

/** The CSS name for a font: the two built-in fonts are registered as "... Variable". */
const cssFont = (f) => ({ Fraunces: 'Fraunces Variable', Inter: 'Inter Variable' }[f] ?? f);
const problem = (e) => e?.errors?.[0]?.message ?? e?.message ?? 'Something went wrong.';

// ---- a small preview of the guide ------------------------------------------------------------------------------------------------

/** A sample post painted with the guide's own colours and fonts, so a change can be seen at once. */
function preview() {
  const card = h('div', { class: 'bg-prev', 'aria-label': 'A sample post in this style' },
    h('p', { class: 'bg-prev-k' }, 'A SAMPLE POST'),
    h('p', { class: 'bg-prev-h' }, 'Your headline sits here'),
    h('p', { class: 'bg-prev-b' }, 'A line or two of body text, set in the text font.'),
    h('span', { class: 'bg-prev-btn' }, 'Book now'));
  return {
    el: card,
    paint({ colors, display, body }) {
      const c = (k, d) => (HEX.test(colors[k] ?? '') ? colors[k] : d);
      card.style.background = c('paper', '#FAF7F2');
      card.style.color = c('ink', '#1F2933');
      card.style.setProperty('--bg-accent', c('accent', '#C2410C'));
      card.style.setProperty('--bg-accent-dark', c('accentDark', '#9A3412'));
      card.style.setProperty('--bg-muted', c('muted', '#6B7280'));
      card.querySelector('.bg-prev-h').style.fontFamily = `'${cssFont(display || 'Fraunces')}', '${display || 'Fraunces'}', Georgia, serif`;
      card.querySelector('.bg-prev-b').style.fontFamily = `'${cssFont(body || 'Inter')}', '${body || 'Inter'}', system-ui, sans-serif`;
    },
  };
}

// ---- reading a guide -------------------------------------------------------------------------------------------------------------

const swatch = (c) => h('li', { class: 'bg-sw', title: `${c.label}: ${c.value}` }, h('i', { style: { background: HEX.test(c.value) ? c.value : 'transparent' } }), h('span', {}, c.label), h('code', {}, c.value || 'not set'));
const chips = (items, empty) => (items.length ? h('ul', { class: 'bg-chips' }, items.map((t) => h('li', {}, t))) : h('p', { class: 'muted' }, empty));
const bullets = (items, empty) => (items.length ? h('ul', { class: 'bg-list' }, items.map((t) => h('li', {}, t))) : h('p', { class: 'muted' }, empty));

function readView(g) {
  const pv = preview();
  pv.paint({ colors: Object.fromEntries([...g.colors.core, ...g.colors.more].map((c) => [c.key, c.value])), display: g.fonts.display.family, body: g.fonts.body.family });
  return h('div', { class: 'bg-read' },
    h('div', { class: 'bg-top' },
      h('div', {}, h('h3', { class: 'bg-name' }, g.name), h('p', { class: 'muted' }, [g.links.handle, g.links.website].filter(Boolean).join(' · ') || 'No handle or website added yet.')),
      pv.el),
    Object.keys(g.logoFiles ?? {}).length ? h('section', { class: 'bg-sec' }, h('h4', { class: 'lbl' }, 'Logos'), h('div', { class: 'logo-read' }, LOGO_KINDS.filter((k) => g.logoFiles[k.key]).map((k) => h('figure', { class: `logo-fig ${k.bg}` }, h('img', { src: `/p/${encodeURIComponent(g.id)}/${g.logoFiles[k.key].split('/').map(encodeURIComponent).join('/')}`, alt: `${k.label} logo` }), h('figcaption', {}, k.label))))) : null,
    h('section', { class: 'bg-sec' }, h('h4', { class: 'lbl' }, 'Colours'), h('ul', { class: 'bg-sws' }, [...g.colors.core.filter((c) => c.value), ...g.colors.more].map(swatch))),
    h('section', { class: 'bg-sec' }, h('h4', { class: 'lbl' }, 'Fonts'),
      h('p', {}, h('span', { class: 'muted' }, 'Headings: '), h('b', { style: { fontFamily: `'${cssFont(g.fonts.display.family)}', '${g.fonts.display.family}', Georgia, serif`, fontSize: '20px' } }, g.fonts.display.family || 'not set'), h('span', { class: 'muted' }, '   Text: '), h('b', { style: { fontFamily: `'${cssFont(g.fonts.body.family)}', '${g.fonts.body.family}', system-ui, sans-serif` } }, g.fonts.body.family || 'not set'))),
    h('section', { class: 'bg-sec' }, h('h4', { class: 'lbl' }, 'How it sounds'),
      g.voice.audience ? h('p', {}, h('span', { class: 'muted' }, 'Who it is for: '), g.voice.audience) : h('p', { class: 'muted' }, 'Who it is for: not written yet.'),
      h('div', { class: 'bg-cols' },
        h('div', {}, h('h5', {}, 'Tone'), chips(g.voice.tone, 'No tone words yet.')),
        h('div', {}, h('h5', {}, 'Do'), bullets(g.voice.do, 'Nothing listed.')),
        h('div', {}, h('h5', {}, 'Do not'), bullets(g.voice.dont, 'Nothing listed.')),
        h('div', {}, h('h5', {}, 'Never say'), bullets(g.voice.bannedPhrases, 'Nothing listed.')))),
    g.industry?.label ? h('section', { class: 'bg-sec' }, h('h4', { class: 'lbl' }, 'Field and rules'), h('p', {}, h('b', {}, g.industry.label), g.industry.regulated ? h('span', { class: 'muted' }, ' · advertising rules apply') : null), g.industry.rules ? h('p', { class: 'bg-note' }, g.industry.rules) : h('p', { class: 'muted' }, 'Claude checks the rules of this field where the business operates.')) : null,
    g.note ? h('section', { class: 'bg-sec' }, h('h4', { class: 'lbl' }, 'Notes'), h('p', { class: 'bg-note' }, g.note)) : null);
}

// ---- editing a guide -------------------------------------------------------------------------------------------------------------

/**
 * The editor: returns { el, read() } where read() gives the patch the server takes (or throws a plain message).
 * `g` is a guide (from the server) or a draft shaped like one.
 */
export function guideEditor(g) {
  const pv = preview();
  const field = (label, control, hint) => h('div', { class: 'bg-f' }, h('span', { class: 'lbl-i' }, label), control, hint ? h('span', { class: 'muted bg-hint' }, hint) : null);
  const name = h('input', { class: 'field', value: g.name ?? '', maxlength: 80, 'data-field': 'bg-name', 'aria-label': 'Brand name' });
  const colorRows = [];
  const colorsBox = h('div', { class: 'bg-colors' });
  const repaint = () => pv.paint({ colors: Object.fromEntries(colorRows.filter((r) => !r.removed).map((r) => [r.key, r.text.value.trim()])), display: display.value.trim(), body: body.value.trim() });
  function colorRow({ key, label, value }, { core }) {
    const text = h('input', { class: 'field bg-hex', value: value ?? '', maxlength: 7, placeholder: '#1F3A3C', 'data-field': `bg-color-${key}`, 'aria-label': `${label} colour` });
    const pick = h('input', { type: 'color', class: 'bg-pick', value: HEX.test(value ?? '') ? value : '#888888', 'aria-label': `Pick ${label}` });
    pick.addEventListener('input', () => { text.value = pick.value.toUpperCase(); repaint(); });
    text.addEventListener('input', () => { if (HEX.test(text.value.trim())) pick.value = text.value.trim(); repaint(); });
    const row = { key, core, text, removed: false };
    row.el = h('div', { class: 'bg-crow', dataset: { color: key } }, pick, h('span', { class: 'bg-clabel' }, label), text,
      core ? null : btn('Remove', { quiet: true, onclick: () => { row.removed = true; row.el.remove(); repaint(); } }));
    colorRows.push(row);
    return row.el;
  }
  for (const c of g.colors.core) colorsBox.append(colorRow(c, { core: true }));
  for (const c of g.colors.more) colorsBox.append(colorRow(c, { core: false }));
  const newName = h('input', { class: 'field', placeholder: 'A name, e.g. sky', maxlength: 30, 'data-field': 'bg-new-color-name', 'aria-label': 'Name for a new colour' });
  const newHex = h('input', { class: 'field bg-hex', placeholder: '#3A6E72', maxlength: 7, 'data-field': 'bg-new-color-hex', 'aria-label': 'Value for a new colour' });
  const addColor = () => {
    const key = newName.value.trim().replace(/[^A-Za-z0-9_-]+/g, '-');
    if (!key || !HEX.test(newHex.value.trim()) || colorRows.some((r) => !r.removed && r.key === key)) { notify('Give the colour a new name and six digits, like #3A6E72.', { kind: 'error' }); return; }
    colorsBox.append(colorRow({ key, label: key, value: newHex.value.trim().toUpperCase() }, { core: false }));
    newName.value = ''; newHex.value = ''; repaint();
  };
  const fontList = h('datalist', { id: 'bg-fonts' }, FONT_IDEAS.map((f) => h('option', { value: f })));
  const display = h('input', { class: 'field', value: g.fonts.display.family ?? '', list: 'bg-fonts', maxlength: 80, 'data-field': 'bg-font-display', 'aria-label': 'Heading font' });
  const body = h('input', { class: 'field', value: g.fonts.body.family ?? '', list: 'bg-fonts', maxlength: 80, 'data-field': 'bg-font-body', 'aria-label': 'Text font' });
  const srcSel = (cur, label) => h('select', { class: 'field', 'aria-label': label }, [['google', 'Google Fonts (or built in)'], ['system', 'Installed on this computer'], ...(cur === 'file' ? [['file', 'Its own font files']] : [])].map(([v, l]) => h('option', { value: v, selected: v === cur }, l)));
  const dSrc = srcSel(g.fonts.display.source ?? 'google', 'Where the heading font comes from');
  const bSrc = srcSel(g.fonts.body.source ?? 'google', 'Where the text font comes from');
  display.addEventListener('input', repaint); body.addEventListener('input', repaint);
  const audience = h('textarea', { class: 'field', rows: 3, maxlength: 1500, 'data-field': 'bg-audience', 'aria-label': 'Who it is for' }); audience.value = g.voice.audience ?? '';
  const tone = h('input', { class: 'field', value: (g.voice.tone ?? []).join(', '), placeholder: 'warm, calm, plain-spoken', 'data-field': 'bg-tone', 'aria-label': 'Tone words, separated by commas' });
  const area = (items, ph, fieldName) => { const t = h('textarea', { class: 'field', rows: 4, placeholder: ph, 'data-field': fieldName }); t.value = (items ?? []).join('\n'); return t; };
  const doIt = area(g.voice.do, 'One thing to do per line', 'bg-do');
  const dont = area(g.voice.dont, 'One thing to avoid per line', 'bg-dont');
  const banned = area(g.voice.bannedPhrases, 'Words or phrases never to use, one per line', 'bg-banned');
  const handle = h('input', { class: 'field', value: g.links.handle ?? '', placeholder: '@yourbrand', 'data-field': 'bg-handle', 'aria-label': 'Instagram handle' });
  const website = h('input', { class: 'field', value: g.links.website ?? '', placeholder: 'https://example.com', 'data-field': 'bg-website', 'aria-label': 'Website' });
  const note = h('textarea', { class: 'field', rows: 3, maxlength: 600, placeholder: 'Anything else worth remembering about this brand', 'data-field': 'bg-note' }); note.value = g.note ?? '';
  const ind = g.industry ?? { label: '', rules: '', regulated: null };
  const industry = h('input', { class: 'field', value: ind.label ?? '', list: 'bg-industries', maxlength: 80, placeholder: 'e.g. Dentistry, carpet cleaning, education', 'data-field': 'bg-industry', 'aria-label': 'What field the brand is in' });
  const industryList = h('datalist', { id: 'bg-industries' }, INDUSTRY_IDEAS.map((f) => h('option', { value: f })));
  const regulated = h('input', { type: 'checkbox', checked: ind.regulated === true, 'data-field': 'bg-regulated', 'aria-label': 'This field has advertising rules' });
  const rules = h('textarea', { class: 'field', rows: 3, maxlength: 1200, placeholder: 'Optional. Rules you know apply, e.g. “Australian health advertising rules: no testimonials, no before and after”, or “no medical claims”', 'data-field': 'bg-rules', 'aria-label': 'Rules that apply' }); rules.value = ind.rules ?? '';
  const alts = (g.industryAlt ?? []).filter((l) => l && l !== ind.label).slice(0, 3);
  repaint();
  const el = h('div', { class: 'bg-edit' },
    h('div', { class: 'bg-top' }, h('div', { class: 'bg-grow' }, field('Brand name', name)), pv.el),
    h('section', { class: 'bg-sec' }, h('h4', { class: 'lbl' }, 'Colours'), colorsBox,
      h('div', { class: 'bg-add' }, newName, newHex, btn('Add a colour', { quiet: true, act: 'bg-add-color', onclick: addColor }))),
    g.id ? h('section', { class: 'bg-sec' }, h('h4', { class: 'lbl' }, 'Logos'), logoSlots({ project: g.id, files: g.logoFiles ?? {} }), h('p', { class: 'muted bg-hint' }, 'Logos are saved as soon as you add them.')) : null,
    h('section', { class: 'bg-sec' }, h('h4', { class: 'lbl' }, 'Fonts'), fontList,
      h('div', { class: 'bg-grid' }, field('Headings', display), field('Where it comes from', dSrc), field('Text', body), field('Where it comes from', bSrc)),
      h('p', { class: 'muted bg-hint' }, 'Fraunces and Inter are built in. Any other Google font loads when you are online. Pick “Installed on this computer” for a font you have installed.')),
    h('section', { class: 'bg-sec' }, h('h4', { class: 'lbl' }, 'How it sounds'),
      field('Who it is for', audience), field('Tone (words, separated by commas)', tone),
      h('div', { class: 'bg-grid3' }, field('Do', doIt), field('Do not', dont), field('Never say', banned))),
    h('section', { class: 'bg-sec' }, h('h4', { class: 'lbl' }, 'Where to find it'), h('div', { class: 'bg-grid' }, field('Instagram handle', handle), field('Website', website))),
    h('section', { class: 'bg-sec' }, h('h4', { class: 'lbl' }, 'Field and rules'), industryList,
      field('What field is it in?', industry, 'Claude looks up and follows the advertising and content rules of this field where the business operates.'),
      alts.length ? h('p', { class: 'muted bg-hint' }, 'Other possibilities: ', alts.map((l) => h('button', { class: 'linklike', type: 'button', onclick: () => { industry.value = l; } }, l)).flatMap((b, i) => (i ? [', ', b] : [b]))) : null,
      h('label', { class: 'bg-f bg-check' }, regulated, h('span', {}, 'Advertising in this field has rules (health, finance, law, property…)')),
      field('Rules that apply (optional)', rules, 'Write any you know. Claude checks the rest and tells you what it is relying on.')),
    h('section', { class: 'bg-sec' }, field('Notes', note)));
  return {
    el,
    read() {
      const colors = {};
      const live = colorRows.filter((r) => !r.removed);
      for (const r of live) {
        const v = r.text.value.trim();
        if (!v && r.core) continue;                       // a core colour left empty is simply not set
        if (!HEX.test(v)) throw new Error(`${r.key}: "${v}" is not a colour. Use six digits like #1F3A3C.`);
        colors[r.key] = v;
      }
      if (Object.keys(colors).length < 2) throw new Error('A brand needs at least two colours.');
      return {
        name: name.value.trim(), colors, removeColors: colorRows.filter((r) => r.removed && !r.core).map((r) => r.key),
        fonts: { display: { family: display.value.trim(), source: dSrc.value }, body: { family: body.value.trim(), source: bSrc.value } },
        voice: { audience: audience.value.trim(), tone: commas(tone.value), do: lines(doIt.value), dont: lines(dont.value), bannedPhrases: lines(banned.value) },
        links: { handle: handle.value.trim(), website: website.value.trim() }, note: note.value.trim(),
        industry: industry.value.trim() || rules.value.trim() ? { id: industry.value.trim() === ind.label ? ind.id || undefined : undefined, label: industry.value.trim() || 'Other', regulated: regulated.checked, rules: rules.value.trim() } : null,
      };
    },
  };
}

// ---- the style guide window ----------------------------------------------------------------------------------------------------

/** Open a brand's style guide: read it, press Edit to change it. */
export async function openGuide(projectId, { brandName } = {}) {
  const m = modal(`Style guide${brandName ? ` · ${brandName}` : ''}`);
  let guide;
  try { guide = (await api.get(`/brand/guide?project=${encodeURIComponent(projectId)}`)).guide; } catch (e) { m.body.replaceChildren(h('p', { class: 'badge warn' }, problem(e))); m.foot.replaceChildren(btn('Close', { onclick: m.close })); return; }
  let editor = null;
  const show = () => {
    editor = null;
    m.body.replaceChildren(readView(guide));
    m.foot.replaceChildren(btn('Close', { onclick: m.close }), btn('Edit', { primary: true, act: 'guide-edit', onclick: edit }));
  };
  function edit() {
    editor = guideEditor(guide);
    m.body.replaceChildren(editor.el);
    m.foot.replaceChildren(btn('Cancel', { onclick: show, act: 'guide-cancel' }), btn('Save changes', { go: true, act: 'guide-save', onclick: save }));
  }
  async function save() {
    let patch;
    try { patch = editor.read(); } catch (e) { notify(e.message, { kind: 'error' }); return; }
    try {
      guide = (await api.post('/brand/guide', { project: projectId, patch })).guide;
    } catch (e) { notify(problem(e), { kind: 'error', ms: 10000 }); return; }
    notify('Style guide saved.', { kind: 'ok' });
    try { await load({ force: true }); } catch { /* the guide is saved either way */ }
    show();
  }
  show();
}

// ---- Add a brand -----------------------------------------------------------------------------------------------------------------

const emptyGuide = (name = '') => ({
  name, note: '', industry: { id: '', label: '', regulated: null, rules: '' }, industryAlt: [],
  colors: { core: [['ink', 'Main text and dark areas', '#1F2933'], ['paper', 'Background', '#FAF7F2'], ['accent', 'Accent', '#C2410C'], ['accentDark', 'Accent for text (darker)', '#9A3412'], ['muted', 'Quiet text', '#6B7280']].map(([key, label, value]) => ({ key, label, value })), more: [] },
  fonts: { display: { family: 'Fraunces', source: 'google' }, body: { family: 'Inter', source: 'google' } },
  voice: { audience: '', tone: [], do: [], dont: [], bannedPhrases: [] }, links: { handle: '', website: '' },
});
/** A scan's draft laid over the empty guide. */
function guideFromDraft(draft, name) {
  const g = emptyGuide(draft.name || name);
  const labels = { ink: 'Main text and dark areas', paper: 'Background', accent: 'Accent', accentDark: 'Accent for text (darker)', muted: 'Quiet text' };
  if (draft.colors) g.colors.core = Object.keys(labels).map((key) => ({ key, label: labels[key], value: draft.colors[key] ?? g.colors.core.find((c) => c.key === key).value }));
  if (draft.colors) g.colors.more = Object.entries(draft.colors).filter(([k]) => !(k in labels)).map(([key, value]) => ({ key, label: key, value }));   // the brand's other colours (secondary, tertiary ...) are kept
  if (draft.industry) g.industry = { id: draft.industry.id ?? '', label: draft.industry.label ?? '', regulated: draft.industry.regulated ?? null, rules: draft.industry.rules ?? '' };
  if (draft.industryAlt) g.industryAlt = draft.industryAlt;
  if (draft.fonts?.display) g.fonts.display = { family: draft.fonts.display.family, source: draft.fonts.display.source ?? 'google' };
  if (draft.fonts?.body) g.fonts.body = { family: draft.fonts.body.family, source: draft.fonts.body.source ?? 'google' };
  if (draft.voice) g.voice = { ...g.voice, ...draft.voice };
  if (draft.links) g.links = { handle: draft.links.handle ?? '', website: draft.links.website ?? '' };
  g.note = draft.note ?? '';
  return g;
}

/** Add a brand in a few steps. `onCreated(id)` runs once it exists (the Studio switches to it). */
export function openAddBrand({ onCreated, openPublishing, openStock, openLibrary } = {}) {
  const m = modal('Add a brand');
  const st = { step: 1, name: '', zone: ZONES[0], mode: 'auto', website: '', instagram: '', industry: '', logoNames: {}, logoPrev: {}, shotState: { names: [], previews: [], shot: null, busy: false, note: '' }, trainState: { names: [], previews: [], shot: null, busy: false, note: '' }, folder: '', folders: [], files: [], uploading: '', session: Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join(''), bio: '', captions: '', scan: null, scanning: false, editor: null, guide: null, creating: false, id: null };
  const STEPS = () => (st.mode === 'auto' ? ['The brand', 'Look for its style', 'Check it', 'Done'] : ['The brand', 'Its style', 'Done']);
  const stepOf = () => (st.mode === 'manual' && st.step >= 3 ? st.step - 1 : st.step);
  const bar = () => h('ol', { class: 'wz-steps', 'aria-label': 'Steps' }, STEPS().map((t, i) => h('li', { class: i + 1 === stepOf() ? 'on' : i + 1 < stepOf() ? 'done' : '' }, h('span', { class: 'wz-n' }, i + 1 < stepOf() ? icon('check', 12) : String(i + 1)), t)));
  const hasInput = () => !!(st.website.trim() || st.instagram.trim() || st.folder.trim() || st.industry.trim() || st.folders.length || st.files.length || Object.keys(st.logoNames).length || st.shotState.names.length || st.trainState.names.length || st.bio.trim() || st.captions.trim());
  const syncScan = () => { const b = m.foot.querySelector('[data-act="wz-scan"]'); if (b) b.disabled = st.scanning || !hasInput(); };   // the Look button wakes up as soon as something is filled in
  const input = (key, ph, extra = {}) => { const el = h('input', { class: 'field', value: st[key], placeholder: ph, 'data-field': `wz-${key}`, ...extra }); el.addEventListener('input', () => { st[key] = el.value; syncScan(); }); return el; };
  const field = (label, control, hint) => h('div', { class: 'bg-f' }, h('span', { class: 'lbl-i' }, label), control, hint ? h('span', { class: 'muted bg-hint' }, hint) : null);

  function step1() {
    const name = input('name', 'e.g. Little Gannet Coffee', { maxlength: 80 });
    const zone = h('select', { class: 'field', 'data-field': 'wz-zone', 'aria-label': 'Timezone', onchange: (e) => { st.zone = e.target.value; } }, ZONES.map((z) => h('option', { value: z, selected: z === st.zone }, z.replace('_', ' '))));
    const choice = (value, title, text) => h('label', { class: `wz-opt${st.mode === value ? ' on' : ''}`, dataset: { mode: value } },
      h('input', { type: 'radio', name: 'wz-mode', value, checked: st.mode === value, onchange: () => { st.mode = value; draw(); } }), h('span', {}, h('b', {}, title), h('span', { class: 'muted' }, text)));
    return [h('p', { class: 'wz-lead' }, 'A brand is one business or event you make posts for. It keeps its own colours, fonts, voice and posts.'),
      field('Brand name', name), field('Timezone (for post times)', zone),
      h('div', { class: 'wz-opts', role: 'radiogroup', 'aria-label': 'How to set up its style' },
        choice('auto', 'Fill it in for me', 'Nordle looks at a folder, the website and the social page, and drafts the colours, fonts and wording. You check it.'),
        choice('manual', 'I will set it up myself', 'Start from a plain default and choose the colours, fonts and wording yourself.'))];
  }

  const FILE_OK = /\.(png|jpe?g|webp|gif|svg|ttf|otf|woff2?|md|markdown|txt|css|html?|json|pdf|docx?|pages|key|pptx)$/i;
  const size = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  /** Send chosen or dropped files to the server one at a time (they wait there until the brand is made). */
  async function addFiles(list) {
    const all = [...list];
    const fit = all.filter((f) => FILE_OK.test(f.name) && f.size > 0 && f.size <= 20 * 1024 * 1024 && !f.name.startsWith('.'));
    const skipped = all.length - fit.length;
    let failed = '';
    for (const [i, file] of fit.entries()) {
      st.uploading = `Adding ${i + 1} of ${fit.length}: ${file.name}`; draw();
      try {
        const r = await api.uploadTo('/brand/upload', file, { 'x-upload-session': st.session });
        st.files.push({ name: r.name, size: r.size });
      } catch (e) { failed = e.message; break; }
    }
    st.uploading = '';
    if (failed) notify(failed, { kind: 'error' });
    else if (skipped) notify(`${skipped} file${skipped === 1 ? ' was' : 's were'} left out: only pictures, fonts and written style guides (up to 20 MB each) can be used.`, { kind: 'info' });
    draw();
  }
  /** Files and folders from this computer: pictures, fonts, and a written style guide. Picked with the buttons or dropped on the box. */
  function files() {
    const pick = (folder) => { const el = h('input', { type: 'file', multiple: true, hidden: true, ...(folder ? { webkitdirectory: true } : {}), 'data-field': folder ? 'wz-folder-upload' : 'wz-file-upload', onchange: () => { const list = [...el.files]; el.value = ''; addFiles(list); } }); return el; };
    const filesIn = pick(false), folderIn = pick(true);
    const drop = h('div', { class: 'pick-drop', 'data-field': 'wz-drop', tabindex: '0', 'aria-label': 'Add files: drop them here, or use the buttons' },
      h('span', { class: 'muted' }, 'Drop files here, or'),
      h('button', { class: 'btn', type: 'button', 'data-act': 'wz-add-files', disabled: !!st.uploading, onclick: () => filesIn.click() }, 'Add files…'),
      h('button', { class: 'btn', type: 'button', 'data-act': 'wz-add-folder-upload', disabled: !!st.uploading, onclick: () => folderIn.click() }, 'Add a folder…'),
      filesIn, folderIn);
    for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
    for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); });
    drop.addEventListener('drop', (e) => { if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files); });
    return h('span', { class: 'pick-folders' },
      drop,
      st.uploading ? h('span', { class: 'muted bg-hint', role: 'status' }, st.uploading) : null,
      st.files.length ? h('ul', { class: 'pick-list', 'data-field': 'wz-files', 'aria-label': 'Files added' }, st.files.map((f) => h('li', {},
        h('span', { class: 'pick-path', title: f.name }, f.name), h('span', { class: 'muted' }, size(f.size)),
        h('button', { class: 'btn quiet', type: 'button', 'data-act': 'wz-remove-file', 'aria-label': `Remove ${f.name}`, onclick: () => { st.files = st.files.filter((x) => x !== f); draw(); } }, 'Remove')))) : null);
  }

  /** The folders to look in: the ones already added (each with Remove), then a box to paste another path, Add, and Choose… (the system's folder window). */
  function folders() {
    const addFolder = (path) => {
      const p = String(path ?? '').trim();
      if (!p || st.folders.includes(p)) return false;
      if (st.folders.length >= MAX_FOLDERS) { notify(`Up to ${MAX_FOLDERS} folders. Remove one to add another.`, { kind: 'error' }); return false; }
      st.folders.push(p); st.folder = ''; draw(); return true;
    };
    const typed = input('folder', 'Paste a folder path, or press Choose');
    typed.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addFolder(typed.value); } });
    const add = h('button', { class: 'btn', type: 'button', 'data-act': 'wz-add-folder', onclick: () => addFolder(typed.value) }, 'Add');
    const row = folderPicker(typed, { title: 'Choose a folder with the brand’s logo, photos or fonts', field: 'wz-pick-folder', onPick: addFolder });
    row.querySelector('.btn').before(add);
    return h('span', { class: 'pick-folders' },
      st.folders.length ? h('ul', { class: 'pick-list', 'data-field': 'wz-folders', 'aria-label': 'Folders to look in' }, st.folders.map((f) => h('li', {},
        h('span', { class: 'pick-path', title: f }, f),
        h('button', { class: 'btn quiet', type: 'button', 'data-act': 'wz-remove-folder', 'aria-label': `Remove ${f}`, onclick: () => { st.folders = st.folders.filter((x) => x !== f); draw(); } }, 'Remove')))) : null,
      row);
  }

  function step2auto() {
    const found = st.scan;
    return [h('p', { class: 'wz-lead' }, 'Give Nordle somewhere to look. Fill in any of these: more gives a better guess.'),
      field('What field is it in? (optional)', (() => { const el = input('industry', 'e.g. Dentistry, carpet cleaning, education'); el.setAttribute('list', 'wz-industries'); return h('span', { class: 'pick-folders' }, el, h('datalist', { id: 'wz-industries' }, INDUSTRY_IDEAS.map((f) => h('option', { value: f })))); })(), 'Leave it blank and Nordle works it out from the website and captions. Claude uses it to check the rules of that field.'),
      field('Website', input('website', 'https://littlegannet.example'), 'Colours, fonts and the share picture come from the page itself.'),
      field('Instagram', input('instagram', '@yourbrand or the page address'), 'Instagram often asks for a sign-in; if it will not show, paste the bio and captions below.'),
      field('Logos', logoSlots({ session: st.session, staged: { names: st.logoNames, previews: st.logoPrev }, onChange: syncScan }), 'Add the full-colour logo and, if you have them, a black one, a white one, an icon and a wordmark. Pictures use the one that reads on their background. Colours are taken from them.'),
      field('A screenshot of your brand page (optional)', shotImport({ session: st.session, state: st.shotState, onChange: () => { syncScan(); draw(); } }), 'For example your Canva Brand Kit page. Nordle reads the colours and fonts out of the picture. Claude Code must be signed in to read the fonts.'),
      field('Train it on your own posts (optional)', trainImport({ session: st.session, state: st.trainState, onChange: () => { syncScan(); draw(); } }), 'Drop in two or three posts you have already made. Nordle sees which colour is the background, the headline and the accent, which fonts and how the posts are laid out, and makes new posts the same way.'),
      field('Files (a style guide, a logo, fonts, photos)', files(), 'A written style guide (Markdown, text, CSS or HTML) is read for colours, fonts, tone and phrases to avoid. A PDF is kept with the brand but cannot be read yet. Added files stay with the brand.'),
      field('Folders on this computer', folders(), 'Logos, photos and font files, from one folder or several. A file with “logo” in its name gives the best colours.'),
      field('Bio (optional)', (() => { const t = h('textarea', { class: 'field', rows: 2, 'data-field': 'wz-bio' }); t.value = st.bio; t.addEventListener('input', () => { st.bio = t.value; syncScan(); }); return t; })()),
      field('A few of its captions (optional)', (() => { const t = h('textarea', { class: 'field', rows: 4, placeholder: 'Paste three or four recent captions. Nordle reads the usual hashtags and style.', 'data-field': 'wz-captions' }); t.value = st.captions; t.addEventListener('input', () => { st.captions = t.value; syncScan(); }); return t; })()),
      st.scanning ? h('p', { class: 'wz-busy', role: 'status' }, h('i', { class: 'cmt-spin', 'aria-hidden': 'true' }), 'Looking… this can take about ten seconds.') : null,
      found ? h('div', { class: 'wz-found', 'data-state': 'scanned' },
        h('h4', { class: 'lbl' }, 'What Nordle found'),
        found.found.length ? h('ul', { class: 'wz-ok' }, found.found.map((t) => h('li', {}, icon('check', 13), t))) : null,
        found.problems.length ? h('ul', { class: 'wz-warn' }, found.problems.map((t) => h('li', {}, icon('alert', 13), t))) : null,
        found.palette.length ? h('p', { class: 'wz-pal' }, found.palette.slice(0, 8).map((c) => h('i', { style: { background: c }, title: c }))) : null) : null];
  }

  async function doScan() {
    st.scanning = true; draw();
    try {
      st.scan = await api.post('/brand/scan', { name: st.name, industry: st.industry, website: st.website, instagram: st.instagram, folder: st.folder, folders: st.folders, files: st.files.map((f) => f.name), uploadSession: st.session, logoFiles: st.logoNames, shot: st.shotState.shot, train: st.trainState.shot, bio: st.bio, captions: st.captions });
      st.guide = guideFromDraft({ ...st.scan.draft, industryAlt: (st.scan.industry?.alternatives ?? []).map((a) => a.label) }, st.name); st.editor = null;
    } catch (e) { st.scan = { found: [], problems: [problem(e)], palette: [], draft: {} }; st.guide = guideFromDraft({}, st.name); st.editor = null; }
    st.scanning = false; draw();
  }

  function step3() {
    st.guide ??= guideFromDraft({}, st.name);
    st.editor ??= guideEditor({ ...st.guide, name: st.guide.name || st.name });   // kept between redraws, so nothing typed is lost
    return [h('p', { class: 'wz-lead' }, st.mode === 'auto' && st.scan ? 'This is Nordle’s draft. Change anything that is not right: nothing is final, and you can edit it later from the brand’s menu.' : 'Choose its colours, fonts and wording. You can change them later from the brand’s menu.'), st.editor.el];
  }

  async function create() {
    let patch;
    try { patch = st.editor.read(); } catch (e) { notify(e.message, { kind: 'error' }); return; }
    st.creating = true; draw();
    try {
      const r = await api.post('/brand/create', { name: patch.name || st.name, timezone: st.zone, guide: { ...patch, fonts: { ...Object.fromEntries(Object.entries(st.scan?.draft?.fonts ?? {}).filter(([k]) => !['display', 'body'].includes(k))), ...patch.fonts } }, train: st.trainState.shot, files: st.files.map((f) => f.name), logoFiles: st.logoNames, uploadSession: st.session });
      st.id = r.id;
      try { await load({ force: true }); } catch { /* the Studio finds it on its next refresh */ }
      onCreated?.(r.id);
      st.step = 4; st.creating = false; draw();
    } catch (e) { st.creating = false; notify(problem(e), { kind: 'error', ms: 10000 }); draw(); }
  }

  function stepDone() {
    const item = (n, title, text, action) => h('li', { class: 'wz-next' }, h('span', { class: 'wz-n' }, String(n)), h('div', {}, h('b', {}, title), h('p', { class: 'muted' }, text)), action ?? null);
    return [h('div', { class: 'acc-banner ok', role: 'status' }, h('span', { class: 'acc-banner-i' }, icon('check', 18)), h('div', {}, h('b', {}, `${st.editor?.read().name || st.name} is ready`), h('p', {}, 'It now shows in the Brands list on the left.'))),
      h('h4', { class: 'lbl' }, 'Next'),
      h('ol', { class: 'wz-nexts' },
        item(1, 'Check its style guide', 'Open it any time from the brand’s ⋯ menu.', btn('Open style guide', { quiet: true, act: 'wz-open-guide', onclick: () => { m.close(); openGuide(st.id, { brandName: st.name }); } })),
        item(2, 'Connect where it posts', 'Choose its Buffer account and channels in Publishing.', openPublishing ? btn('Open Publishing', { quiet: true, act: 'wz-open-publishing', onclick: () => { m.close(); openPublishing(); } }) : null),
        item(3, 'Add its logo and photos', `Put them in the brand’s assets folder (projects/${st.id}/assets), and your own footage where Nordle can read it (it is never copied or moved).`),
        item(4, 'Stock: your own footage and stock, used automatically', 'Add the folders where your footage and stock live (Envato downloads, a shoot folder), and free online libraries such as Pexels, Pixabay and Freesound with a free key you type in once. After that, Claude searches them by itself whenever it builds a post: your own folders first, online libraries only for a shot your own material cannot cover. You never have to pick files. Whatever it uses is copied into this brand with its licence written down, and Nordle never buys or signs in anywhere.', openStock ? btn('Open Stock', { quiet: true, act: 'wz-open-stock', onclick: () => { m.close(); openStock(st.id); } }) : null),
        item(5, 'The Library: every brand and every post', 'The Library (in the left bar) lists each brand with all its carousels, graphics and videos as cards. Open one to edit it by hand, or press New post to start one yourself. Everything stays on this computer.', openLibrary ? btn('Open the Library', { quiet: true, act: 'wz-open-library', onclick: () => { m.close(); openLibrary(); } }) : null),
        item(6, 'Then make your first posts', 'Press Create (key n): Nordle suggests a month of ideas, and Claude builds the ones you approve.'))];
  }

  function draw() {
    m.title(st.step === 4 ? 'Brand added' : 'Add a brand');
    const body = st.step === 1 ? step1() : st.step === 2 ? (st.mode === 'auto' ? step2auto() : step3()) : st.step === 3 ? step3() : stepDone();
    m.body.replaceChildren(...[bar(), body].flat(Infinity).filter(Boolean));
    const back = () => { st.step = st.step === 3 && st.mode === 'manual' ? 1 : st.step - 1; draw(); };
    const manualStyleStep = st.mode === 'manual' && st.step === 2;
    m.foot.replaceChildren(...[
      st.step === 4 ? btn('Done', { primary: true, act: 'wz-done', onclick: m.close }) : btn('Cancel', { onclick: m.close }),
      st.step > 1 && st.step < 4 ? btn('Back', { quiet: true, act: 'wz-back', onclick: back }) : null,
      st.step === 1 ? btn('Next', { primary: true, act: 'wz-next', onclick: () => { if (!st.name.trim()) { notify('Give the brand a name first.', { kind: 'error' }); return; } st.step = 2; draw(); } }) : null,
      st.step === 2 && st.mode === 'auto' ? btn(st.scanning ? 'Looking…' : st.scan ? 'Look again' : 'Look for its style', { act: 'wz-scan', quiet: !!st.scan, primary: !st.scan, disabled: st.scanning || !hasInput(), onclick: doScan }) : null,
      st.step === 2 && st.mode === 'auto' ? btn('Skip, set it by hand', { quiet: true, act: 'wz-skip', onclick: () => { st.step = 3; draw(); } }) : null,
      st.step === 2 && st.mode === 'auto' && st.scan ? btn('Next', { primary: true, act: 'wz-next', onclick: () => { st.step = 3; draw(); } }) : null,
      st.step === 3 || manualStyleStep ? btn(st.creating ? 'Adding…' : 'Add the brand', { go: true, act: 'wz-create', disabled: st.creating, onclick: create }) : null,
    ].flat().filter(Boolean));
  }
  draw();
}
