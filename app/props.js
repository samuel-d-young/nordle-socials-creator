// The Properties tab: everything about the selected layer (or the page, when nothing is selected).

import { h, icon, preserveFocus, debounce, dialog } from './dom.js';
import { state, update, subscribe, shownDoc, currentPage, currentSize } from './state.js';
import { selectedLayer, editLayer, deleteLayer, duplicateLayer, moveLayer, setPageValue, uploadImages, askClaude } from './doc.js';
import { resolveToken } from '/src/shared/tokens.mjs';

const ANCHORS = ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'];
const WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900];

/** Pick an image from the project's assets, or upload one. Resolves with a path or null. */
export async function pickImage() {
  let chosen = null;
  await dialog({
    title: 'Choose an image',
    build: (body, finish) => {
      const grid = h('div', { class: 'export-grid' });
      const draw = () => {
        grid.replaceChildren(...state.assets.map((a) => h('a', { href: '#', onclick: (e) => { e.preventDefault(); chosen = a.path; finish('ok'); } },
          h('img', { src: `/p/${state.project}/${a.path}`, alt: '' }), a.path.replace('assets/', ''))));
        if (!state.assets.length) grid.replaceChildren(h('p', { class: 'muted' }, 'No images yet. Upload one.'));
      };
      draw();
      const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml', multiple: true, class: 'hidden',
        onchange: async () => { const p = await uploadImages([...input.files]); if (p.length) { chosen = p[0]; finish('ok'); } } });
      body.append(h('button', { class: 'btn', onclick: () => input.click() }, icon('plus'), 'Upload from this computer'), input, grid);
    },
    actions: [{ id: 'cancel', label: 'Cancel' }],
  });
  return chosen;
}

const brandColours = () => {
  const brand = state.brand;
  return Object.keys(brand.colors).map((name) => ({ name, token: `$brand.colors.${name}`, hex: resolveToken(`$brand.colors.${name}`, brand, shownDoc().colourway) }));
};

function swatches(value, onPick, { allowNone = false } = {}) {
  const cols = brandColours();
  const wrap = h('div', { class: 'swatches' });
  if (allowNone) wrap.append(h('button', { class: `sw${value === undefined ? ' on' : ''}`, title: 'None', style: { background: 'repeating-conic-gradient(#888 0 25%, #ccc 0 50%) 50% / 10px 10px' }, onclick: () => onPick(undefined) }));
  for (const c of cols) wrap.append(h('button', { class: `sw${value === c.token ? ' on' : ''}`, title: `${c.name} ${c.hex}`, style: { background: c.hex }, onclick: () => onPick(c.token) }));
  const isCustom = typeof value === 'string' && !value.startsWith('$brand.') && value !== undefined;
  const picker = h('input', { type: 'color', class: 'hidden', value: isCustom && /^#[0-9a-f]{6}$/i.test(value) ? value : '#888888', onchange: () => onPick(picker.value) });
  wrap.append(h('button', { class: `sw custom${isCustom ? ' on' : ''}`, title: 'Any colour', onclick: () => picker.click() }), picker);
  return wrap;
}

export function mountProps(root) {
  let lastSig = '';

  function field(label, control, extra) {
    return h('div', { class: 'row' }, h('label', {}, label, extra ?? null), h('div', { class: 'grow' }, control));
  }

  function build() {
    root.replaceChildren();
    const ref = selectedLayer();
    if (state.versionView) { root.append(h('div', { class: 'empty' }, `Viewing ${state.versionView.name}. Go back to the current version to edit.`)); return; }
    if (!ref) { buildPage(); return; }
    buildLayer(ref);
  }

  // ---- page ----------------------------------------------------------------------------------------------------------
  function buildPage() {
    const page = currentPage();
    if (!page) return;
    root.append(
      h('div', { class: 'group' }, h('h3', {}, 'Page'),
        field('Title', h('input', { class: 'field', value: page.title ?? '', 'data-field': 'page-title', onchange: (e) => setPageValue(page.id, 'title', e.target.value || undefined) })),
        field('Background', swatches(typeof page.background === 'string' ? page.background : undefined, (v) => v && setPageValue(page.id, 'background', v))),
        field('Lock', h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center' } }, h('input', { type: 'checkbox', checked: !!page.lock, onchange: (e) => setPageValue(page.id, 'lock', e.target.checked ? true : undefined) }), 'Claude cannot change this page')),
        field('Notes', h('textarea', { class: 'field', rows: 3, 'data-field': 'page-notes', value: page.notes ?? '', onchange: (e) => setPageValue(page.id, 'notes', e.target.value || undefined) }))),
      h('div', { class: 'empty' }, 'Click a layer on the page to edit it.', h('br'), h('span', { class: 'muted' }, 'Add text, images and shapes from the Layers list on the left.')));
  }

  // ---- layer ---------------------------------------------------------------------------------------------------------
  function buildLayer(ref) {
    const layer = ref.layer;
    const size = currentSize();
    const sizeId = size.id;
    const ov = layer.overrides?.[sizeId] ?? {};
    const value = (group, key) => {
      const o = group ? ov[group]?.[key] : ov[key];
      const b = group ? layer[group]?.[key] : layer[key];
      return { v: o !== undefined ? o : b, overridden: o !== undefined };
    };
    const set = (group, key, v) => editLayer(ref, [{ group, key, value: v }]);
    const resetBtn = (group, key) => h('button', { class: 'btn ghost sm', title: `Use the shared value (remove the ${sizeId} override)`, onclick: () => editLayer(ref, [{ group, key, value: undefined }], { scope: 'size' }) }, 'reset');
    const dot = (group, key) => (value(group, key).overridden ? h('span', { class: 'ovr', title: `Different at ${sizeId}` }) : null);

    const num = (group, key, { step = 1, min, label, auto = false } = {}) => {
      const { v } = value(group, key);
      const input = h('input', { class: 'num', type: auto && v === 'auto' ? 'text' : 'number', step, min, value: v === undefined ? '' : typeof v === 'number' ? Math.round(v * 100) / 100 : v, 'data-field': `${group}-${key}`, placeholder: auto ? 'auto' : '' });
      input.addEventListener('change', () => {
        const raw = input.value.trim();
        if (raw === '') return set(group, key, undefined);
        if (auto && raw.toLowerCase() === 'auto') return set(group, key, 'auto');
        const n = Number(raw);
        if (Number.isFinite(n)) set(group, key, n);
      });
      return h('div', { class: 'cell' }, h('label', {}, label ?? key), input);
    };

    // header actions
    root.append(h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } },
      h('strong', { class: 'grow', style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, layer.name ?? layer.id),
      h('button', { class: 'btn icon', title: 'Ask Claude to change this layer', dataset: { action: 'ask-claude' }, onclick: () => askClaude(ref) }, icon('sparkle')),
      h('button', { class: 'btn icon', title: 'Duplicate (Ctrl+D)', onclick: () => duplicateLayer(ref) }, icon('copy')),
      h('button', { class: 'btn icon', title: 'Move forward ( ] )', onclick: () => moveLayer(ref, ref.index + 1) }, icon('up')),
      h('button', { class: 'btn icon', title: 'Move back ( [ )', onclick: () => moveLayer(ref, ref.index - 1) }, icon('down')),
      h('button', { class: 'btn icon danger', title: 'Delete', onclick: () => deleteLayer(ref) }, icon('trash'))));

    if (state.sizes.length > 1) {
      root.append(h('div', { class: 'scope' },
        h('div', { class: 'seg' },
          h('button', { class: state.scope === 'all' ? 'on' : '', onclick: () => update({ scope: 'all' }) }, 'All sizes'),
          h('button', { class: state.scope === 'size' ? 'on' : '', onclick: () => update({ scope: 'size' }) }, `Only ${sizeId}`)),
        h('span', { class: 'muted', style: { fontSize: '11px' } }, state.scope === 'size' ? 'Layout, style and text changes apply to this size only.' : '')));
    }

    const general = h('div', { class: 'group' }, h('h3', {}, 'Layer'),
      field('Name', h('input', { class: 'field', value: layer.name ?? '', placeholder: layer.id, 'data-field': 'name', onchange: (e) => set(null, 'name', e.target.value || undefined) })),
      field('', h('div', { style: { display: 'flex', gap: '14px' } },
        h('label', { style: { display: 'flex', gap: '5px', alignItems: 'center' } }, h('input', { type: 'checkbox', checked: !!layer.lock, onchange: (e) => set(null, 'lock', e.target.checked ? true : undefined) }), icon('lock'), 'Locked'),
        h('label', { style: { display: 'flex', gap: '5px', alignItems: 'center' } }, h('input', { type: 'checkbox', checked: !!value(null, 'hidden').v, onchange: (e) => set(null, 'hidden', e.target.checked ? true : undefined) }), icon('eyeOff'), 'Hidden', dot(null, 'hidden')))));
    root.append(general);

    // position and size
    const lay = value('layout', 'anchor').v ?? 'top-left';
    root.append(h('div', { class: 'group' }, h('h3', {}, 'Position', value('layout', 'x').overridden || value('layout', 'y').overridden || value('layout', 'w').overridden ? h('button', { class: 'btn ghost sm', onclick: () => editLayer(ref, ['x', 'y', 'w', 'h', 'rotate', 'anchor'].map((k) => ({ group: 'layout', key: k, value: undefined })), { scope: 'size' }) }, `reset ${sizeId}`) : null),
      h('div', { class: 'grid2' }, num('layout', 'x', { step: 0.5, label: 'X' }), num('layout', 'y', { step: 0.5, label: 'Y' }), num('layout', 'w', { step: 0.5, label: 'W', auto: true }), num('layout', 'h', { step: 0.5, label: 'H', auto: true }),
        num('layout', 'rotate', { step: 1, label: '°' }), num('layout', 'z', { step: 1, label: 'Z' })),
      h('div', { class: 'row', style: { marginTop: '8px' } }, h('label', {}, 'Anchor', dot('layout', 'anchor')),
        h('div', { class: 'anchor' }, ANCHORS.map((a) => h('button', { class: a === lay ? 'on' : '', title: a, onclick: () => set('layout', 'anchor', a) }))),
        h('span', { class: 'muted', style: { fontSize: '11px' } }, 'x and y are the position of this point, as a % of the page'))));

    if (layer.type === 'text') buildText(ref, value, set, dot, num);
    if (layer.type === 'image') buildImage(ref, value, set, num);
    if (layer.type === 'shape') buildShape(ref, value, set, num);
    if (layer.type === 'group') root.append(h('div', { class: 'group' }, h('h3', {}, 'Group'), h('p', { class: 'muted' }, `${layer.children.length} layers inside. Select them in the Layers list.`)));

    if (layer.animate?.length) {
      root.append(h('div', { class: 'group' }, h('h3', {}, 'Animation'),
        h('div', { class: 'chips' }, layer.animate.map((a) => h('span', { class: 'chip' }, a.preset ?? 'keyframes', a.duration ? ` ${a.duration}s` : ''))),
        h('p', { class: 'muted', style: { fontSize: '11px', marginTop: '6px' } }, 'Animations play in videos. Pictures show the finished frame.')));
    }
  }

  function buildText(ref, value, set, dot, num) {
    const layer = ref.layer;
    const fonts = Object.keys(state.brand.fonts);
    const fontVal = value('style', 'font').v;
    const textBlock = h('div', { class: 'group' }, h('h3', {}, 'Text'));
    if (layer.runs) {
      layer.runs.forEach((run, i) => {
        const row = h('div', { class: 'row' },
          h('input', { class: 'field', value: run.text, 'data-field': `run-${i}`, onchange: (e) => editLayer(ref, [{ group: null, key: 'runs', value: layer.runs.map((r, j) => (j === i ? { ...r, text: e.target.value } : r)) }], { scope: 'all' }) }),
          h('button', { class: `btn icon${run.style?.italic ? ' on' : ''}`, title: 'Italic', style: { fontStyle: 'italic', fontWeight: 700 }, onclick: () => editLayer(ref, [{ group: null, key: 'runs', value: layer.runs.map((r, j) => (j === i ? { ...r, style: { ...r.style, italic: !r.style?.italic } } : r)) }], { scope: 'all' }) }, 'I'),
          h('select', { class: 'field', style: { width: '90px' }, title: 'Colour', onchange: (e) => editLayer(ref, [{ group: null, key: 'runs', value: layer.runs.map((r, j) => { if (j !== i) return r; const s = { ...r.style }; if (e.target.value) s.color = e.target.value; else delete s.color; return { ...r, ...(Object.keys(s).length ? { style: s } : { style: undefined }) }; }) }], { scope: 'all' }) },
            h('option', { value: '' }, 'same'), Object.keys(state.brand.colors).map((c) => h('option', { value: `$brand.colors.${c}`, selected: run.style?.color === `$brand.colors.${c}` }, c))));
        textBlock.append(row);
      });
      textBlock.append(h('div', { class: 'row' },
        h('button', { class: 'btn sm', onclick: () => editLayer(ref, [{ group: null, key: 'runs', value: undefined }, { group: null, key: 'text', value: layer.runs.map((r) => r.text).join('') }], { scope: 'all' }) }, 'Make it plain text'),
        h('span', { class: 'muted', style: { fontSize: '11px' } }, 'Parts of one headline can differ in style.')));
    } else {
      const eff = value(null, 'text');
      const ta = h('textarea', { class: 'field', rows: 3, 'data-field': 'text', value: eff.v ?? '' });
      const save = debounce(() => { if (ta.value !== (eff.v ?? '')) editLayer(ref, [{ group: null, key: 'text', value: ta.value }]); }, 350);
      ta.addEventListener('input', save);
      ta.addEventListener('blur', () => save.flush());
      textBlock.append(h('div', { class: 'row' }, h('div', { class: 'grow' }, ta)), dot(null, 'text') ? h('div', { class: 'muted' }, `Different at ${currentSize().id}`) : null,
        h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: () => editLayer(ref, [{ group: null, key: 'text', value: undefined }, { group: null, key: 'runs', value: [{ text: ta.value || 'Text' }] }], { scope: 'all' }) }, 'Style words separately')));
    }
    root.append(textBlock);

    const align = value('style', 'align').v ?? 'left';
    root.append(h('div', { class: 'group' }, h('h3', {}, 'Type'),
      field('Font', h('select', { class: 'field', onchange: (e) => set('style', 'font', e.target.value) }, fonts.map((f) => h('option', { value: `$brand.fonts.${f}`, selected: fontVal === `$brand.fonts.${f}` }, `${f} · ${state.brand.fonts[f].family}`)), (fontVal && !String(fontVal).startsWith('$brand.')) ? h('option', { value: fontVal, selected: true }, fontVal) : null), dot('style', 'font')),
      h('div', { class: 'grid2' }, num('style', 'size', { step: 2, min: 8, label: 'Size' }), num('style', 'lineHeight', { step: 0.05, label: 'Line' }), num('style', 'letterSpacing', { step: 0.02, label: 'Track' }), num('style', 'opacity', { step: 0.1, min: 0, label: 'Alpha' })),
      h('div', { class: 'row', style: { marginTop: '8px' } }, h('label', {}, 'Weight', dot('style', 'weight')),
        h('select', { class: 'field', onchange: (e) => set('style', 'weight', Number(e.target.value)) }, WEIGHTS.map((w) => h('option', { value: w, selected: (value('style', 'weight').v ?? 400) === w }, w)))),
      h('div', { class: 'row' }, h('label', {}, 'Style'),
        h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
          h('button', { class: `btn icon${value('style', 'italic').v ? ' on' : ''}`, title: 'Italic', style: { fontStyle: 'italic' }, onclick: () => set('style', 'italic', value('style', 'italic').v ? undefined : true) }, 'I'),
          h('button', { class: `btn icon${value('style', 'uppercase').v ? ' on' : ''}`, title: 'Capitals', onclick: () => set('style', 'uppercase', value('style', 'uppercase').v ? undefined : true) }, 'AA'),
          h('button', { class: `btn icon${value('style', 'balance').v ? ' on' : ''}`, title: 'Balance lines', onclick: () => set('style', 'balance', value('style', 'balance').v ? undefined : true) }, 'Bal'))),
      h('div', { class: 'row' }, h('label', {}, 'Align', dot('style', 'align')),
        h('div', { class: 'seg' }, [['left', 'alignLeft'], ['center', 'alignCenter'], ['right', 'alignRight'], ['justify', 'alignJustify']].map(([a, ic]) => h('button', { class: align === a ? 'on' : '', title: a, onclick: () => set('style', 'align', a) }, icon(ic))))),
      h('div', { class: 'row' }, h('label', {}, 'Colour', dot('style', 'color')), swatches(value('style', 'color').v, (v) => set('style', 'color', v)))));
  }

  function buildImage(ref, value, set, num) {
    const layer = ref.layer;
    const src = layer.src;
    const focal = layer.focal ?? { x: 0.5, y: 0.5 };
    const preview = h('div', { style: { position: 'relative', width: '100%', cursor: 'crosshair' } },
      h('img', { src: `/p/${state.project}/${src}`, alt: '', style: { width: '100%', display: 'block', borderRadius: '6px', border: '1px solid var(--line)' } }),
      h('div', { style: { position: 'absolute', left: `${focal.x * 100}%`, top: `${focal.y * 100}%`, width: '14px', height: '14px', margin: '-7px 0 0 -7px', borderRadius: '50%', border: '2px solid #fff', background: 'var(--accent)', boxShadow: '0 0 0 1px #000', pointerEvents: 'none' } }));
    preview.addEventListener('click', (e) => {
      const r = preview.getBoundingClientRect();
      editLayer(ref, [{ group: null, key: 'focal', value: { x: Math.round(((e.clientX - r.left) / r.width) * 100) / 100, y: Math.round(((e.clientY - r.top) / r.height) * 100) / 100 } }], { scope: 'all' });
    });
    root.append(h('div', { class: 'group' }, h('h3', {}, 'Image'),
      preview,
      h('div', { class: 'row', style: { marginTop: '8px' } }, h('label', {}, 'File'), h('button', { class: 'btn grow', onclick: async () => { const p = await pickImage(); if (p) editLayer(ref, [{ group: null, key: 'src', value: p }], { scope: 'all' }); } }, icon('image'), src.replace('assets/', ''))),
      field('Alt text', h('input', { class: 'field', value: layer.alt ?? '', 'data-field': 'alt', placeholder: 'Describe it, or leave empty if decorative', onchange: (e) => editLayer(ref, [{ group: null, key: 'alt', value: e.target.value }], { scope: 'all' }) })),
      field('Fit', h('select', { class: 'field', onchange: (e) => editLayer(ref, [{ group: null, key: 'fit', value: e.target.value }], { scope: 'all' }) }, ['cover', 'contain', 'fill'].map((f) => h('option', { value: f, selected: (layer.fit ?? 'cover') === f }, f)))),
      h('div', { class: 'grid2' }, num('style', 'radius', { step: 2, min: 0, label: 'Round' }), num('style', 'opacity', { step: 0.1, min: 0, label: 'Alpha' })),
      h('p', { class: 'muted', style: { fontSize: '11px' } }, 'Click the picture to choose which part stays in view when it is cropped.')));
  }

  function buildShape(ref, value, set, num) {
    const layer = ref.layer;
    const fill = value('style', 'fill').v;
    root.append(h('div', { class: 'group' }, h('h3', {}, layer.shape === 'line' ? 'Line' : 'Shape'),
      layer.shape === 'line'
        ? field('Colour', swatches(value('style', 'stroke').v?.color, (v) => v && set('style', 'stroke', { ...(value('style', 'stroke').v ?? { width: 4 }), color: v })))
        : field('Fill', swatches(typeof fill === 'string' ? fill : undefined, (v) => set('style', 'fill', v), { allowNone: true })),
      h('div', { class: 'grid2' }, num('style', 'radius', { step: 2, min: 0, label: 'Round' }), num('style', 'opacity', { step: 0.1, min: 0, label: 'Alpha' })),
      layer.shape !== 'line' ? h('div', { class: 'row', style: { marginTop: '8px' } }, h('label', {}, 'Outline'), swatches(value('style', 'stroke').v?.color, (v) => set('style', 'stroke', v ? { color: v, width: value('style', 'stroke').v?.width ?? 4 } : undefined), { allowNone: true })) : null,
      value('style', 'stroke').v ? h('div', { class: 'row' }, h('label', {}, 'Width'), h('input', { class: 'num', type: 'number', min: 0, step: 1, value: value('style', 'stroke').v.width, onchange: (e) => set('style', 'stroke', { ...value('style', 'stroke').v, width: Number(e.target.value) }) })) : null));
  }

  const rebuild = () => {
    const ref = selectedLayer();
    const sig = JSON.stringify([state.sel, ref?.layer, ref ? null : currentPage() && { t: currentPage().title, b: currentPage().background, l: currentPage().lock, n: currentPage().notes }, currentSize()?.id, state.scope, state.assets.length, state.brand?.id, shownDoc()?.colourway, state.versionView?.id, state.sizes.length]);
    if (sig === lastSig) return;
    lastSig = sig;
    preserveFocus(root, build);
  };
  subscribe(() => { if (state.route.name === 'edit' && state.doc && state.panel === 'props') rebuild(); });
  return { rebuild: () => { lastSig = ''; rebuild(); } };
}
