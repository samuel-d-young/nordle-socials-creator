// The brand kit's logos and its screenshot import.
//   logoSlots   five kinds of logo (full colour, black, white, icon, wordmark). For a brand that exists, each change is saved at once; in the Add a brand
//               wizard the files wait on the server until the brand is made.
//   shotImport  drop, paste or choose a screenshot of a brand page (a Canva Brand Kit): Claude reads the colours and fonts out of it.
// Server: src/brand/logos.mjs, src/brand/screenshot.mjs (routes in src/server/routes/brand.mjs).

import { api } from './api.js';
import { h, icon } from './dom.js';
import { notify } from './studio-ui.js';

export const LOGO_KINDS = [
  { key: 'primary', label: 'Full colour', hint: 'The logo as it normally appears', bg: 'light' },
  { key: 'black', label: 'Black', hint: 'For light backgrounds and print', bg: 'light' },
  { key: 'white', label: 'White', hint: 'For dark backgrounds and photos', bg: 'dark' },
  { key: 'icon', label: 'Icon or mark', hint: 'The symbol on its own', bg: 'light' },
  { key: 'wordmark', label: 'Wordmark', hint: 'The name on its own', bg: 'light' },
];
const ACCEPT = '.png,.svg,.jpg,.jpeg,.webp,image/png,image/svg+xml,image/jpeg,image/webp';
const IMG_OK = /\.(png|svg|jpe?g|webp)$/i;
const say = (e) => e?.errors?.[0]?.message ?? e?.message ?? 'Something went wrong.';

/**
 * @param {{ project?: string, files?: Record<string,string>, session?: string, staged?: { names: Record<string,string>, previews: Record<string,string> }, onGuide?: (g:object)=>void, onChange?: ()=>void }} o
 *   with `project`: a brand that exists (`files` = its logoFiles); with `staged`: the wizard (names of staged uploads and local previews).
 */
export function logoSlots({ project, files = {}, session, staged, onGuide, onChange }) {
  const root = h('div', { class: 'logo-slots', 'data-field': 'logo-slots' });
  let busy = '';
  const current = { ...files };
  const draw = () => root.replaceChildren(...LOGO_KINDS.map((k) => slot(k)));

  async function upload(kind, file) {
    if (!file) return;
    if (!IMG_OK.test(file.name)) return notify('A logo must be a PNG, SVG, JPG or WebP picture.', { kind: 'error' });
    busy = kind.key; draw();
    try {
      if (project) {
        const r = await api.uploadTo(`/brand/logo/upload?project=${encodeURIComponent(project)}&variant=${kind.key}`, file);
        Object.keys(current).forEach((k) => delete current[k]); Object.assign(current, r.guide.logoFiles ?? {}); onGuide?.(r.guide);
      } else {
        const r = await api.uploadTo('/brand/upload', file, { 'x-upload-session': session });
        staged.names[kind.key] = r.name;
        if (staged.previews[kind.key]) URL.revokeObjectURL(staged.previews[kind.key]);
        staged.previews[kind.key] = URL.createObjectURL(file);
      }
      onChange?.();
    } catch (e) { notify(say(e), { kind: 'error' }); }
    busy = ''; draw();
  }
  async function derive(kind) {
    busy = kind.key; draw();
    try {
      const r = await api.post('/brand/logo/derive', { project, to: kind.key });
      Object.keys(current).forEach((k) => delete current[k]); Object.assign(current, r.guide.logoFiles ?? {}); onGuide?.(r.guide); onChange?.();
      notify(`The ${kind.label.toLowerCase()} logo was made from the full-colour one. Check it looks right.`, { kind: 'ok' });
    } catch (e) { notify(say(e), { kind: 'error' }); }
    busy = ''; draw();
  }
  async function remove(kind) {
    if (project) {
      try { const r = await api.post('/brand/logo/remove', { project, variant: kind.key }); Object.keys(current).forEach((k) => delete current[k]); Object.assign(current, r.guide.logoFiles ?? {}); onGuide?.(r.guide); } catch (e) { return notify(say(e), { kind: 'error' }); }
    } else { delete staged.names[kind.key]; if (staged.previews[kind.key]) URL.revokeObjectURL(staged.previews[kind.key]); delete staged.previews[kind.key]; }
    onChange?.(); draw();
  }

  function slot(kind) {
    const src = project ? (current[kind.key] ? `/p/${encodeURIComponent(project)}/${current[kind.key].split('/').map(encodeURIComponent).join('/')}?v=${busy ? '' : Date.now() % 100000}` : '') : staged.previews[kind.key] ?? '';
    const has = !!src;
    const input = h('input', { type: 'file', accept: ACCEPT, hidden: true, 'data-field': `logo-file-${kind.key}`, onchange: () => { const f = input.files[0]; input.value = ''; upload(kind, f); } });
    const canMake = project && (kind.key === 'black' || kind.key === 'white') && !has && current.primary;
    return h('div', { class: `logo-slot${has ? ' has' : ''}`, 'data-kind': kind.key },
      h('div', { class: `logo-prev ${kind.bg}`, role: 'img', 'aria-label': has ? `${kind.label} logo` : `No ${kind.label.toLowerCase()} logo yet` }, has ? h('img', { src, alt: '', draggable: 'false' }) : h('span', { class: 'muted' }, 'None yet')),
      h('div', { class: 'logo-meta' }, h('b', {}, kind.label), h('span', { class: 'muted' }, kind.hint)),
      h('div', { class: 'logo-acts' },
        h('button', { class: 'btn sm', type: 'button', disabled: busy === kind.key, 'data-act': `logo-add-${kind.key}`, onclick: () => input.click() }, busy === kind.key ? 'Working…' : has ? 'Replace' : 'Add'),
        canMake ? h('button', { class: 'btn sm', type: 'button', disabled: !!busy, 'data-act': `logo-make-${kind.key}`, title: `Makes an all-${kind.key} copy of the full-colour logo`, onclick: () => derive(kind) }, `Make ${kind.key}`) : null,
        has ? h('button', { class: 'btn sm quiet', type: 'button', 'data-act': `logo-remove-${kind.key}`, 'aria-label': `Remove the ${kind.label.toLowerCase()} logo`, onclick: () => remove(kind) }, 'Remove') : null),
      input);
  }
  draw();
  return root;
}

/**
 * @param {{ session: string, state: { names: string[], previews: string[], shot: object|null, busy: boolean, note: string }, onChange: ()=>void }} o
 */
export function shotImport({ session, state, onChange }) {
  const add = async (list) => {
    const fit = [...list].filter((f) => /^image\/(png|jpe?g|webp)$/.test(f.type) || /\.(png|jpe?g|webp)$/i.test(f.name)).slice(0, 6 - state.names.length);
    if (!fit.length) return notify('Add a PNG, JPG or WebP screenshot.', { kind: 'error' });
    state.busy = true; state.note = 'Adding…'; onChange();
    for (const [i, f] of fit.entries()) {
      try {
        const named = f.name && !/^image\.(png|jpe?g|webp)$/i.test(f.name) ? f : new File([f], `screenshot-${Date.now()}-${i}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type });
        const r = await api.uploadTo('/brand/upload', named, { 'x-upload-session': session });
        state.names.push(r.name); state.previews.push(URL.createObjectURL(f)); state.shot = null;
      } catch (e) { state.note = say(e); state.busy = false; return onChange(); }
    }
    state.busy = false; state.note = ''; onChange();
  };
  const read = async () => {
    state.busy = true; state.note = 'Claude is looking at your screenshot. This takes about half a minute.'; onChange();
    try {
      const r = await api.post('/brand/read-screenshots', { uploadSession: session, files: state.names });
      state.shot = r.shot; state.note = r.note ?? '';
    } catch (e) { state.note = say(e); }
    state.busy = false; onChange();
  };
  const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', multiple: true, hidden: true, 'data-field': 'shot-file', onchange: () => { const l = [...input.files]; input.value = ''; add(l); } });
  const drop = h('div', { class: 'shot-drop', tabindex: '0', 'data-field': 'shot-drop', 'aria-label': 'Add a screenshot: drop it here, paste it, or choose a file' },
    h('span', { class: 'muted' }, 'Drop a screenshot here, press Ctrl+V (Command+V on a Mac) to paste one, or'),
    h('button', { class: 'btn', type: 'button', 'data-act': 'shot-add', disabled: state.busy || state.names.length >= 6, onclick: () => input.click() }, 'Choose a screenshot…'), input);
  for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
  for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); });
  drop.addEventListener('drop', (e) => { if (e.dataTransfer?.files?.length) add(e.dataTransfer.files); });
  const onPaste = (e) => {
    if (!drop.isConnected) { document.removeEventListener('paste', onPaste); return; }
    if (/^(input|textarea|select)$/i.test(e.target?.tagName ?? '')) return;   // pasting text into a box is not a screenshot
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); add(files); }
  };
  document.addEventListener('paste', onPaste);
  const s = state.shot;
  return h('div', { class: 'shot', 'data-field': 'shot-import' },
    drop,
    state.names.length ? h('div', { class: 'shot-thumbs' }, state.previews.map((p, i) => h('span', { class: 'shot-th' }, h('img', { src: p, alt: `Screenshot ${i + 1}`, draggable: 'false' }),
      h('button', { class: 'btn sm quiet', type: 'button', 'aria-label': `Remove screenshot ${i + 1}`, 'data-act': 'shot-remove', onclick: () => { URL.revokeObjectURL(p); state.names.splice(i, 1); state.previews.splice(i, 1); state.shot = null; onChange(); } }, 'Remove')))) : null,
    state.names.length ? h('div', { class: 'cr-go' }, h('button', { class: 'btn primary', type: 'button', 'data-act': 'shot-read', disabled: state.busy, onclick: read }, state.busy ? 'Working…' : s ? 'Read it again' : 'Read my screenshot')) : null,
    state.note ? h('p', { class: `muted bg-hint${state.busy ? '' : ' shot-note'}`, role: 'status', 'data-state': 'shot-note' }, state.note) : null,
    s ? h('div', { class: 'shot-result', 'data-state': 'shot-read' },
      h('ul', { class: 'bg-sws' }, s.colors.map((c) => h('li', { class: 'bg-sw', title: `${c.name ?? 'Colour'}: ${c.hex}` }, h('i', { style: { background: c.hex } }), h('span', {}, c.name ?? ''), h('code', {}, c.hex)))),
      h('p', {}, [s.fonts.heading && `Headings: ${s.fonts.heading}`, s.fonts.subheading && `Subheadings: ${s.fonts.subheading}`, s.fonts.body && `Body: ${s.fonts.body}`].filter(Boolean).join(' · ') || (s.fallback ? 'The fonts could not be read.' : 'No fonts were named in the screenshot.')),
      s.tone.length ? h('p', { class: 'muted' }, `Voice: ${s.tone.join(', ')}`) : null,
      s.notes ? h('p', { class: 'muted' }, s.notes) : null) : null);
}
