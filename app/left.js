// The left column: the pages (with thumbnails) and the layers of the current page.

import { buildPageHtml } from '/src/render/html.mjs';
import { h, icon, promptBox, confirmBox } from './dom.js';
import { state, update, subscribe, shownDoc, currentPage, currentSize } from './state.js';
import { select, addLayer, addPage, duplicatePage, deletePage, movePage, setPageValue, editLayer, locate, moveLayer } from './doc.js';
import { pickImage } from './props.js';

const THUMB_W = 150;

export function mountPages(root) {
  const cache = new Map(); // pageId -> {key, el}
  let dragId = null;

  function thumb(page, size) {
    const doc = shownDoc();
    const key = `${JSON.stringify(page)}|${size.id}|${doc.colourway ?? ''}|${state.brand?.id}|${JSON.stringify(state.brand?.colors)}`;
    const hit = cache.get(page.id);
    if (hit && hit.key === key) return hit.el;
    const zoom = THUMB_W / size.w;
    const f = h('iframe', { sandbox: 'allow-same-origin', tabindex: '-1', title: '' });
    f.style.cssText = `width:${size.w}px;height:${size.h}px;transform:scale(${zoom})`;
    f.srcdoc = buildPageHtml({ doc, brand: state.brand, size, page, showSafe: false, fontManifest: state.fontManifest, urls: { project: `/p/${state.project}`, fonts: '/fonts' } }).html;
    const el = h('div', { class: 'thumb', style: { width: `${THUMB_W}px`, height: `${size.h * zoom}px` } }, f);
    cache.set(page.id, { key, el });
    return el;
  }

  function render() {
    const doc = shownDoc();
    const size = currentSize();
    if (!doc || !size) return;
    const live = new Set(doc.pages.map((p) => p.id));
    for (const id of [...cache.keys()]) if (!live.has(id)) cache.delete(id);
    const list = h('div', { class: 'pages' });
    doc.pages.forEach((page, i) => {
      const item = h('div', {
        class: `page-item${page.id === state.pageId ? ' on' : ''}`, draggable: state.versionView ? 'false' : 'true', dataset: { page: page.id },
        onclick: () => update({ pageId: page.id, sel: null, draftPin: null }),
        ondblclick: async () => { const r = await promptBox('Rename page', [{ name: 'title', label: 'Title', value: page.title ?? '' }]); if (r) setPageValue(page.id, 'title', r.title || undefined); },
        ondragstart: (e) => { dragId = page.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', page.id); },
        ondragover: (e) => { if (dragId) { e.preventDefault(); item.classList.add('drop-before'); } },
        ondragleave: () => item.classList.remove('drop-before'),
        ondrop: (e) => { e.preventDefault(); item.classList.remove('drop-before'); if (dragId && dragId !== page.id) { const from = doc.pages.findIndex((p) => p.id === dragId); movePage(dragId, from < i ? i : i); } dragId = null; },
        ondragend: () => { dragId = null; },
      },
      h('div', { class: 'n' }, String(i + 1)),
      h('div', {}, thumb(page, size),
        h('div', { class: 'lbl' }, h('span', {}, page.title ?? page.id, page.lock ? ' 🔒' : ''),
          state.versionView ? null : h('span', {},
            h('button', { class: 'btn ghost sm', title: 'Duplicate page', onclick: (e) => { e.stopPropagation(); duplicatePage(page.id); } }, icon('copy', 13)),
            h('button', { class: 'btn ghost sm', title: 'Delete page', onclick: (e) => { e.stopPropagation(); deletePage(page.id); } }, icon('trash', 13))))));
      list.append(item);
    });
    const body = root.querySelector('.body');
    const keep = body?.scrollTop ?? 0;
    root.replaceChildren(
      h('header', {}, 'Pages', state.versionView ? null : h('button', { class: 'btn ghost sm', title: 'Add page', onclick: addPage }, icon('plus'), 'Add')),
      h('div', { class: 'body' }, list));
    root.querySelector('.body').scrollTop = keep;
  }

  let lastSig = '';
  subscribe(() => {
    if (state.route.name !== 'edit' || !state.doc) return;
    const d = shownDoc();
    const sig = JSON.stringify([d.pages, state.pageId, state.sizeId, d.colourway, state.versionView?.id, state.brand?.colors]);
    if (sig === lastSig) return;
    lastSig = sig;
    render();
  });
}

const TYPE_ICON = { text: 'text', image: 'image', shape: 'square', group: 'group' };
const layerIcon = (l) => (l.type === 'shape' ? (l.shape === 'ellipse' ? 'circle' : l.shape === 'line' ? 'line' : 'square') : TYPE_ICON[l.type]);
const layerLabel = (l) => l.name ?? (l.type === 'text' ? (l.text ?? (l.runs ?? []).map((r) => r.text).join('')).replace(/\s+/g, ' ').trim().slice(0, 28) || l.id : l.id);

export function mountLayers(root) {
  let dragRef = null;

  function row(layer, ref, depth) {
    const sizeId = currentSize().id;
    const hidden = layer.overrides?.[sizeId]?.hidden ?? layer.hidden;
    const on = state.sel?.layerId === layer.id && state.sel?.pageId === ref.pageId;
    const r = locate(state.doc, ref.pageId, layer.id);
    const el = h('div', {
      class: `layer-row${on ? ' on' : ''}`, style: { paddingLeft: `${4 + depth * 14}px` }, draggable: !state.versionView && r ? 'true' : 'false',
      onclick: () => select(ref.pageId, layer.id),
      ondragstart: (e) => { dragRef = r; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', layer.id); },
      ondragover: (e) => { if (dragRef && r && dragRef.parentPtr === r.parentPtr) { e.preventDefault(); el.classList.add('drop-before'); } },
      ondragleave: () => el.classList.remove('drop-before'),
      ondrop: (e) => {
        e.preventDefault(); el.classList.remove('drop-before');
        if (dragRef && r && dragRef.parentPtr === r.parentPtr && dragRef.layer.id !== layer.id) moveLayer(dragRef, dragRef.index < r.index ? r.index : r.index + 1);
        dragRef = null;
      },
      ondragend: () => { dragRef = null; },
    },
    icon(layerIcon(layer)),
    h('span', { class: `nm${hidden ? ' dim' : ''}`, title: layer.id }, layerLabel(layer)),
    state.versionView ? null : h('button', { class: `ib${hidden ? ' sticky' : ''}`, title: hidden ? 'Show' : 'Hide', onclick: (e) => { e.stopPropagation(); if (r) editLayer(r, [{ group: null, key: 'hidden', value: hidden ? undefined : true }], { scope: 'all' }); } }, icon(hidden ? 'eyeOff' : 'eye', 14)),
    state.versionView ? null : h('button', { class: `ib${layer.lock ? ' sticky' : ''}`, title: layer.lock ? 'Unlock' : 'Lock', onclick: (e) => { e.stopPropagation(); if (r) editLayer(r, [{ group: null, key: 'lock', value: layer.lock ? undefined : true }], { scope: 'all' }); } }, icon(layer.lock ? 'lock' : 'unlock', 14)));
    return el;
  }

  function rows(layers, ref, depth, out) {
    for (let i = layers.length - 1; i >= 0; i--) {
      out.push(row(layers[i], ref, depth));
      if (layers[i].children) rows(layers[i].children, ref, depth + 1, out);
    }
    return out;
  }

  function render() {
    const page = currentPage();
    const doc = shownDoc();
    if (!page) return;
    const list = h('div', { class: 'layers' }, rows(page.layers, { pageId: page.id }, 0, []));
    if (!page.layers.length) list.append(h('div', { class: 'empty' }, 'Nothing on this page yet.', h('br'), 'Add text, an image or a shape.'));
    const add = (type) => (state.versionView ? null : () => (type === 'image' ? pickImage().then((p) => p && addLayer('image', { src: p })) : addLayer(type)));
    root.replaceChildren(...[
      h('header', {}, `Layers · ${page.title ?? page.id}`),
      state.versionView ? null : h('div', { class: 'tools' },
        h('button', { class: 'btn sm', title: 'Add text (T)', onclick: add('text') }, icon('text', 14), 'Text'),
        h('button', { class: 'btn sm', title: 'Add image', onclick: add('image') }, icon('image', 14), 'Image'),
        h('button', { class: 'btn sm', title: 'Add rectangle (R)', onclick: add('rect') }, icon('square', 14), 'Box'),
        h('button', { class: 'btn sm', title: 'Add ellipse (O)', onclick: add('ellipse') }, icon('circle', 14), 'Circle'),
        h('button', { class: 'btn sm', title: 'Add line', onclick: add('line') }, icon('line', 14), 'Line')),
      h('div', { class: 'body' }, list)].filter(Boolean));
    void doc;
  }

  let lastSig = '';
  subscribe(() => {
    if (state.route.name !== 'edit' || !state.doc) return;
    const page = currentPage();
    const sig = JSON.stringify([page?.layers?.map((l) => [l.id, l.name, l.type, l.lock, l.hidden, l.overrides?.[state.sizeId]?.hidden, l.text, l.children?.length]), page?.id, state.sel, state.sizeId, state.versionView?.id]);
    if (sig === lastSig) return;
    lastSig = sig;
    render();
  });
}
