// The canvas: the page as it will be exported (the same renderer, in an iframe), with selection, moving, resizing, rotating,
// snapping, review pins, and the comment composer drawn on top.

import { buildPageHtml, lengthCss, ANCHORS } from '/src/render/html.mjs';
import { getAt } from '/src/shared/ops.mjs';
import { h, toast } from './dom.js';
import { state, update, subscribe, shownDoc, currentPage, currentSize } from './state.js';
import { locate, select, editLayer, addComment, deleteLayer, duplicateLayer, moveLayer, undo, redo, addLayer, uploadImages, viewVersion, restoreVersion, viewChange, decideChange, adoptTake, discardTakes } from './doc.js';

const SNAP_PX = 6;
const round2 = (n) => Math.round(n * 100) / 100;

function pageHtml(doc, size, page, showSafe) {
  return buildPageHtml({
    doc, brand: state.brand, size, page, showSafe, fontManifest: state.fontManifest,
    urls: { project: `/p/${state.project}`, fonts: '/fonts' },
  });
}

/** A layout value as a percentage of the canvas, whatever form it was written in. */
function percentOf(value, axis, size) {
  if (typeof value === 'number') return value;
  const m = /^(-?\d+(?:\.\d+)?)(%|px)$/.exec(String(value ?? ''));
  if (!m) return undefined;
  const n = Number(m[1]);
  return m[2] === '%' ? n : ((n * size.w) / 1080 / (axis === 'x' ? size.w : size.h)) * 100;
}

/** The layer as it is at this size: base layout/style with this size's overrides on top. */
function effective(layer, sizeId) {
  const o = layer.overrides?.[sizeId] ?? {};
  return { layout: { ...(layer.layout ?? {}), ...(o.layout ?? {}) }, style: { ...(layer.style ?? {}), ...(o.style ?? {}) }, hidden: o.hidden ?? layer.hidden };
}

export function mountCanvas(root) {
  let frame = null;            // the visible iframe
  let lastHtml = '';
  let loadToken = 0;
  let drag = null;
  let guides = [];

  const overlay = h('div', { class: 'overlay' });
  const stage = h('div', { class: 'stage' }, overlay);
  const viewport = h('div', { class: 'viewport' }, stage);
  const banner = h('div', { class: 'banner hidden' });
  root.append(banner, viewport);

  const geometry = () => {
    const size = currentSize();
    if (!size) return null;
    let zoom = state.zoom;
    if (zoom === 'fit') {
      const vw = viewport.clientWidth - 56, vh = viewport.clientHeight - 56;
      zoom = Math.max(0.1, Math.min(vw / size.w, vh / size.h, 1.5));
    }
    return { size, zoom };
  };

  const frameDoc = () => frame?.contentDocument ?? null;
  const toCanvas = (e) => {
    const r = overlay.getBoundingClientRect();
    const { zoom } = geometry();
    return { x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom };
  };
  const layerEl = (layerId) => frameDoc()?.querySelector(`[data-layer="${CSS.escape(layerId)}"]`);
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };

  // ---- the page itself -------------------------------------------------------------------------------------------

  function placeFrames(zoom, size) {
    stage.style.width = `${size.w * zoom}px`;
    stage.style.height = `${size.h * zoom}px`;
    for (const f of stage.querySelectorAll('iframe')) {
      f.style.width = `${size.w}px`;
      f.style.height = `${size.h}px`;
      f.style.transform = `scale(${zoom})`;
    }
  }

  function showPage(html, size, zoom) {
    if (html === lastHtml) return;
    lastHtml = html;
    const token = ++loadToken;
    const next = h('iframe', { class: 'back', sandbox: 'allow-same-origin', title: 'Page preview', tabindex: '-1' });
    next.style.width = `${size.w}px`;
    next.style.height = `${size.h}px`;
    next.style.transform = `scale(${zoom})`;
    next.addEventListener('load', async () => {
      try { await next.contentDocument.fonts.ready; } catch { /* keep going */ }
      if (token !== loadToken) { next.remove(); return; }
      next.classList.remove('back');
      const old = frame;
      frame = next;
      old?.remove();
      refreshOverlay();
    }, { once: true });
    next.srcdoc = html;
    stage.insertBefore(next, overlay);
  }

  // ---- overlay: selection, handles, pins, composer ------------------------------------------------------------------

  function handlesFor(ref, eff) {
    if (!ref || ref.layer.lock || state.versionView) return [];
    const t = ref.layer.type;
    if (t === 'group') return [];
    if ((eff.layout.rotate ?? 0) !== 0) return [];
    if (t === 'text') return ['w', 'e', 'nw', 'ne', 'sw', 'se'];
    if (t === 'image' && (eff.layout.h === undefined || eff.layout.h === 'auto')) return ['w', 'e', 'nw', 'ne', 'sw', 'se'];
    return ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  }

  const HANDLE_POS = { nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5] };
  const HANDLE_CURSOR = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };

  function refreshOverlay() {
    const geo = geometry();
    const page = currentPage();
    if (!geo || !page || !frameDoc()) return;
    const { zoom, size } = geo;
    overlay.className = `overlay${state.tool === 'comment' ? ' commenting' : ''}`;
    overlay.replaceChildren();

    // selection
    const sel = state.sel;
    if (sel && sel.pageId === page.id && !state.versionView) {
      const ref = locate(state.doc, sel.pageId, sel.layerId);
      const el = ref && layerEl(sel.layerId);
      if (el) {
        const eff = effective(ref.layer, size.id);
        const r = drag?.liveRect ?? rectOf(el);
        const box = h('div', { class: `sel${ref.layer.lock ? ' locked' : ''}`, style: { left: `${r.x * zoom}px`, top: `${r.y * zoom}px`, width: `${r.w * zoom}px`, height: `${r.h * zoom}px` } });
        for (const hd of handlesFor(ref, eff)) {
          const [fx, fy] = HANDLE_POS[hd];
          box.append(h('div', { class: 'h', dataset: { handle: hd }, style: { left: `${fx * 100}%`, top: `${fy * 100}%`, cursor: HANDLE_CURSOR[hd] } }));
        }
        if (!ref.layer.lock) box.append(h('div', { class: 'h rot', dataset: { handle: 'rot' }, style: { left: '50%', top: '-22px' } }));
        box.append(h('div', { class: 'tag' }, `${ref.layer.name ?? ref.layer.id}${ref.layer.lock ? ' (locked)' : ''} · ${Math.round(r.w)}×${Math.round(r.h)}`));
        overlay.append(box);
      }
    }

    // what Claude's pending changes touched on this page
    if (!state.versionView) {
      for (const c of state.review?.changes ?? []) {
        if (c.status !== 'pending' || c.mode !== 'applied') continue;
        for (const t of c.touched ?? []) {
          const el = t.page === page.id && t.layer ? layerEl(t.layer) : null;
          if (!el) continue;
          const r = rectOf(el);
          overlay.append(h('div', { class: 'hl', title: `Changed by Claude: ${c.note || 'a change'}`, style: { left: `${r.x * zoom - 3}px`, top: `${r.y * zoom - 3}px`, width: `${r.w * zoom + 6}px`, height: `${r.h * zoom + 6}px` } }));
        }
      }
    }

    // guides while dragging
    for (const g of guides) {
      overlay.append(h('div', { class: 'guide', style: g.axis === 'x'
        ? { left: `${g.at * zoom}px`, top: 0, width: '1px', height: '100%' }
        : { top: `${g.at * zoom}px`, left: 0, height: '1px', width: '100%' } }));
    }

    // review pins
    const comments = state.review?.comments ?? [];
    comments.forEach((c, i) => {
      if (c.page !== page.id) return;
      const dim = c.size && c.size !== size.id;
      overlay.append(h('div', {
        class: `pin${c.status === 'resolved' ? ' resolved' : ''}${dim ? ' dim' : ''}${state.focusComment === c.id ? ' on' : ''}`,
        title: c.text, dataset: { pin: c.id },
        style: { left: `${c.x * size.w * zoom}px`, top: `${c.y * size.h * zoom}px` },
        onpointerdown: (e) => { e.stopPropagation(); update({ focusComment: c.id, panel: 'review' }); },
      }, h('span', {}, String(i + 1))));
    });

    // a pin being written
    const dp = state.draftPin;
    if (dp && dp.pageId === page.id) {
      const px = dp.x * size.w * zoom, py = dp.y * size.h * zoom;
      overlay.append(h('div', { class: 'pin new', style: { left: `${px}px`, top: `${py}px` } }, h('span', {}, '+')));
      const ta = h('textarea', { class: 'field', rows: 3, placeholder: 'What should change here?', 'data-field': 'draft-comment' });
      const post = async () => { if (ta.value.trim()) await addComment({ pageId: dp.pageId, x: dp.x, y: dp.y, layerId: dp.layerId, text: ta.value }); };
      ta.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) post(); if (e.key === 'Escape') update({ draftPin: null }); });
      const flipX = px > size.w * zoom - 280;
      const pop = h('div', { class: 'composer', style: { left: `${flipX ? px - 270 : px + 18}px`, top: `${Math.max(4, Math.min(py - 20, size.h * zoom - 150))}px` }, onpointerdown: (e) => e.stopPropagation() },
        dp.layerId ? h('div', { class: 'muted' }, `On layer “${dp.layerId}”`) : null, ta,
        h('div', { class: 'row', style: { justifyContent: 'flex-end', margin: 0 } },
          h('button', { class: 'btn sm', onclick: () => update({ draftPin: null }) }, 'Cancel'),
          h('button', { class: 'btn sm primary', onclick: post }, 'Comment')));
      overlay.append(pop);
      queueMicrotask(() => ta.focus());
    }
  }

  // ---- pointer handling --------------------------------------------------------------------------------------------

  function hitLayer(pt) {
    const doc = frameDoc();
    if (!doc) return null;
    for (const el of doc.elementsFromPoint(pt.x, pt.y)) {
      const layerEl = el.closest?.('[data-layer]');
      if (!layerEl) continue;
      const ref = locate(state.doc, currentPage().id, layerEl.dataset.layer);
      if (ref && !ref.layer.lock) return ref;
    }
    return null;
  }

  function snapTargets(excludeEl, size) {
    const xs = [0, size.w / 2, size.w], ys = [0, size.h / 2, size.h];
    if (size.safe) {
      xs.push(size.w * size.safe.left, size.w * (1 - size.safe.right));
      ys.push(size.h * size.safe.top, size.h * (1 - size.safe.bottom));
    }
    for (const el of frameDoc().querySelectorAll('[data-layer]')) {
      if (el === excludeEl || el.contains(excludeEl) || excludeEl.contains(el) || el.dataset.type === 'group') continue;
      const r = rectOf(el);
      xs.push(r.x, r.x + r.w / 2, r.x + r.w);
      ys.push(r.y, r.y + r.h / 2, r.y + r.h);
    }
    return { xs, ys };
  }

  function snapAxis(starts, targets, threshold) {
    let best = null;
    for (const s of starts) for (const t of targets) {
      const d = t - s;
      if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: t };
    }
    return best;
  }

  function beginMove(ref, e, pt) {
    const parent = ref.parentPtr.endsWith('/children') ? getAt(state.doc, ref.parentPtr.slice(0, -'/children'.length)) : null;
    if (parent?.stack) {
      toast('This layer sits in a stack, so its group places it. Move the group, or change the spacing in the group.', 'info');
      return;
    }
    const geo = geometry();
    const el = layerEl(ref.layer.id);
    const eff = effective(ref.layer, geo.size.id);
    drag = {
      kind: 'move', ref, el, start: pt, rect0: rectOf(el), moved: false, shiftAxis: null,
      x0: percentOf(eff.layout.x ?? 0, 'x', geo.size) ?? 0, y0: percentOf(eff.layout.y ?? 0, 'y', geo.size) ?? 0,
      targets: snapTargets(el, geo.size), pointerId: e.pointerId,
    };
  }

  function beginResize(ref, handle, e, pt) {
    const geo = geometry();
    const el = layerEl(ref.layer.id);
    const eff = effective(ref.layer, geo.size.id);
    const isText = ref.layer.type === 'text';
    const autoH = eff.layout.h === undefined || eff.layout.h === 'auto';
    drag = {
      kind: 'resize', ref, el, handle, start: pt, rect0: rectOf(el), eff, size0: eff.style.size ?? 40, isText,
      keepRatio: isText || (ref.layer.type === 'image' && autoH), explicitH: !autoH && !isText, pointerId: e.pointerId, liveRect: null,
    };
  }

  function beginRotate(ref, e, pt) {
    const geo = geometry();
    const eff = effective(ref.layer, geo.size.id);
    const px = ((percentOf(eff.layout.x ?? 0, 'x', geo.size) ?? 0) / 100) * geo.size.w;
    const py = ((percentOf(eff.layout.y ?? 0, 'y', geo.size) ?? 0) / 100) * geo.size.h;
    drag = {
      kind: 'rotate', ref, el: layerEl(ref.layer.id), pivot: { x: px, y: py }, rot0: eff.layout.rotate ?? 0,
      a0: Math.atan2(pt.y - py, pt.x - px), pointerId: e.pointerId, anchor: eff.layout.anchor ?? 'top-left',
    };
  }

  overlay.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !frameDoc()) return;
    const pt = toCanvas(e);
    const page = currentPage();
    const geo = geometry();

    if (state.tool === 'comment') {
      const ref = hitLayer(pt);
      update({ draftPin: { pageId: page.id, x: pt.x / geo.size.w, y: pt.y / geo.size.h, layerId: ref?.layer.id ?? null } });
      return;
    }
    if (state.versionView) return;
    if (state.draftPin) update({ draftPin: null });

    const handle = e.target?.dataset?.handle;
    if (handle) {
      const ref = locate(state.doc, state.sel.pageId, state.sel.layerId);
      if (!ref || ref.layer.lock) return;
      if (handle === 'rot') beginRotate(ref, e, pt); else beginResize(ref, handle, e, pt);
      overlay.setPointerCapture(e.pointerId);
      return;
    }
    // dragging inside the current selection moves it; otherwise pick what is under the pointer
    let ref = null;
    if (state.sel) {
      const cur = locate(state.doc, state.sel.pageId, state.sel.layerId);
      const el = cur && layerEl(cur.layer.id);
      if (el && !cur.layer.lock) {
        const r = rectOf(el);
        if (pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h) ref = cur;
      }
    }
    ref ??= hitLayer(pt);
    if (!ref) { select(page.id, null); return; }
    if (!state.sel || state.sel.layerId !== ref.layer.id) select(page.id, ref.layer.id);
    beginMove(ref, e, pt);
    overlay.setPointerCapture(e.pointerId);
  });

  overlay.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const pt = toCanvas(e);
    const geo = geometry();
    const { size, zoom } = geo;
    if (drag.kind === 'move') {
      let dx = pt.x - drag.start.x, dy = pt.y - drag.start.y;
      if (!drag.moved && Math.hypot(dx, dy) * zoom < 3) return;
      drag.moved = true;
      if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      const r0 = drag.rect0;
      const sx = snapAxis([r0.x + dx, r0.x + dx + r0.w / 2, r0.x + dx + r0.w], drag.targets.xs, SNAP_PX / zoom);
      const sy = snapAxis([r0.y + dy, r0.y + dy + r0.h / 2, r0.y + dy + r0.h], drag.targets.ys, SNAP_PX / zoom);
      guides = [];
      if (sx && !e.altKey) { dx += sx.d; guides.push({ axis: 'x', at: sx.at }); }
      if (sy && !e.altKey) { dy += sy.d; guides.push({ axis: 'y', at: sy.at }); }
      drag.dx = dx; drag.dy = dy;
      drag.el.style.translate = `${dx}px ${dy}px`;
      drag.liveRect = { x: r0.x + dx, y: r0.y + dy, w: r0.w, h: r0.h };
    } else if (drag.kind === 'resize') {
      const { rect0, handle } = drag;
      const dx = pt.x - drag.start.x, dy = pt.y - drag.start.y;
      let { x, y, w, h: hh } = rect0;
      if (handle.includes('e')) w = rect0.w + dx;
      if (handle.includes('w')) { x = rect0.x + dx; w = rect0.w - dx; }
      if (handle.includes('s')) hh = rect0.h + dy;
      if (handle.includes('n')) { y = rect0.y + dy; hh = rect0.h - dy; }
      w = Math.max(12, w); hh = Math.max(12, hh);
      let scale = 1;
      if (drag.keepRatio) {
        const sx = w / rect0.w, sy = hh / rect0.h;
        const corner = handle.length === 2;
        scale = corner ? (Math.abs(sx - 1) > Math.abs(sy - 1) ? sx : sy) : sx;
        w = rect0.w * scale; hh = rect0.h * scale;
        if (handle.includes('w')) x = rect0.x + rect0.w - w;
        if (handle.includes('n')) y = rect0.y + rect0.h - hh;
        if (!corner && drag.isText) { hh = rect0.h; scale = 1; }
      }
      const anchor = ANCHORS[drag.eff.layout.anchor ?? 'top-left'];
      const lx = ((x + anchor[0] * w) / size.w) * 100, ly = ((y + anchor[1] * hh) / size.h) * 100;
      drag.result = { x: lx, y: ly, w: (w / size.w) * 100, h: (hh / size.h) * 100, scale: drag.isText && handle.length === 2 ? scale : 1 };
      const st = drag.el.style;
      st.left = lengthCss(lx, 'x'); st.top = lengthCss(ly, 'y'); st.width = lengthCss(drag.result.w, 'x');
      if (drag.explicitH) st.height = lengthCss(drag.result.h, 'y');
      if (drag.isText && handle.length === 2) st.fontSize = `calc(var(--u) * ${round2(drag.size0 * scale)})`;
      drag.moved = true;
      drag.liveRect = rectOf(drag.el);
    } else if (drag.kind === 'rotate') {
      let deg = drag.rot0 + ((Math.atan2(pt.y - drag.pivot.y, pt.x - drag.pivot.x) - drag.a0) * 180) / Math.PI;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      deg = round2(((deg + 180) % 360 + 360) % 360 - 180);
      const [ax, ay] = ANCHORS[drag.anchor];
      drag.el.style.transform = `translate(${-ax * 100}%,${-ay * 100}%) rotate(${deg}deg)`;
      drag.deg = deg; drag.moved = true;
      drag.liveRect = rectOf(drag.el);
    }
    refreshOverlay();
  });

  async function endDrag(e) {
    if (!drag || (e && e.pointerId !== drag.pointerId)) return;
    const d = drag;
    drag = null; guides = [];
    try { overlay.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    if (!d.moved) { refreshOverlay(); return; }
    const { size } = geometry();
    if (d.kind === 'move') {
      d.el.style.translate = '';
      const nx = round2(d.x0 + (d.dx / size.w) * 100), ny = round2(d.y0 + (d.dy / size.h) * 100);
      await editLayer(d.ref, [{ group: 'layout', key: 'x', value: nx }, { group: 'layout', key: 'y', value: ny }], { note: `Move ${d.ref.layer.id}` });
    } else if (d.kind === 'resize' && d.result) {
      const r = d.result;
      const changes = [{ group: 'layout', key: 'x', value: round2(r.x) }, { group: 'layout', key: 'y', value: round2(r.y) }, { group: 'layout', key: 'w', value: round2(r.w) }];
      if (d.explicitH) changes.push({ group: 'layout', key: 'h', value: round2(r.h) });
      if (d.isText && r.scale !== 1) changes.push({ group: 'style', key: 'size', value: round2(d.size0 * r.scale) });
      await editLayer(d.ref, changes, { note: `Resize ${d.ref.layer.id}` });
    } else if (d.kind === 'rotate') {
      await editLayer(d.ref, [{ group: 'layout', key: 'rotate', value: d.deg === 0 ? undefined : d.deg }], { note: `Rotate ${d.ref.layer.id}` });
    }
  }
  overlay.addEventListener('pointerup', endDrag);
  overlay.addEventListener('pointercancel', endDrag);

  overlay.addEventListener('dblclick', () => {
    if (state.sel && state.panel === 'props') document.querySelector('[data-field="text"]')?.focus();
  });

  // ---- keyboard ----------------------------------------------------------------------------------------------------

  document.addEventListener('keydown', async (e) => {
    if (state.route.name !== 'edit') return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (document.querySelector('dialog[open]')) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === 'z') { e.preventDefault(); await (e.shiftKey ? redo() : undo()); return; }
    if (mod && key === 'y') { e.preventDefault(); await redo(); return; }
    const ref = state.sel ? locate(state.doc, state.sel.pageId, state.sel.layerId) : null;
    if (mod && key === 'd' && ref) { e.preventDefault(); await duplicateLayer(ref); return; }
    if ((key === 'delete' || key === 'backspace') && ref) { e.preventDefault(); await deleteLayer(ref); return; }
    if (key === 'escape') { update({ sel: null, draftPin: null, tool: 'select' }); return; }
    if (mod) return;
    if (key === 'c') { update({ tool: state.tool === 'comment' ? 'select' : 'comment' }); return; }
    if (key === 'v') { update({ tool: 'select' }); return; }
    if (key === 't') { await addLayer('text'); return; }
    if (key === 'r') { await addLayer('rect'); return; }
    if (key === 'o') { await addLayer('ellipse'); return; }
    if (ref && (key === '[' || key === ']')) { await moveLayer(ref, ref.index + (key === ']' ? 1 : -1)); return; }
    if (ref && key.startsWith('arrow')) {
      if (ref.layer.lock) { toast('This layer is locked.', 'error'); return; }
      e.preventDefault();
      const geo = geometry();
      const step = (e.shiftKey ? 10 : 1);
      const eff = effective(ref.layer, geo.size.id);
      const x0 = percentOf(eff.layout.x ?? 0, 'x', geo.size) ?? 0, y0 = percentOf(eff.layout.y ?? 0, 'y', geo.size) ?? 0;
      const dx = key === 'arrowleft' ? -step : key === 'arrowright' ? step : 0, dy = key === 'arrowup' ? -step : key === 'arrowdown' ? step : 0;
      await editLayer(ref, [{ group: 'layout', key: 'x', value: round2(x0 + (dx / geo.size.w) * 100) }, { group: 'layout', key: 'y', value: round2(y0 + (dy / geo.size.h) * 100) }], { note: `Nudge ${ref.layer.id}` });
    }
  });

  // drop an image file onto the canvas to add it
  viewport.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
  viewport.addEventListener('drop', async (e) => {
    const files = [...(e.dataTransfer?.files ?? [])].filter((f) => /^image\//.test(f.type));
    if (!files.length) return;
    e.preventDefault();
    for (const path of await uploadImages(files)) await addLayer('image', { src: path });
  });

  new ResizeObserver(() => { if (state.zoom === 'fit') render(); }).observe(viewport);

  // ---- put it together ----------------------------------------------------------------------------------------------

  function renderAllSizes() {
    stage.classList.add('hidden');
    let grid = viewport.querySelector('.all-sizes');
    const doc = shownDoc(), page = currentPage();
    const key = `all|${JSON.stringify(page)}|${state.sizes.map((s) => s.id)}|${state.safe}|${state.versionView?.id ?? ''}`;
    if (grid && grid.dataset.key === key) return;
    grid?.remove();
    grid = h('div', { class: 'all-sizes', dataset: { key } });
    for (const size of state.sizes) {
      const zoom = Math.min(1, 420 / size.h, 340 / size.w);
      const f = h('iframe', { sandbox: 'allow-same-origin', tabindex: '-1', title: size.id });
      f.style.cssText = `position:static;width:${size.w}px;height:${size.h}px;transform:scale(${zoom});transform-origin:0 0;border:0;background:#fff;pointer-events:none`;
      f.srcdoc = pageHtml(doc, size, page, state.safe).html;
      const box = h('div', { style: { width: `${size.w * zoom}px`, height: `${size.h * zoom}px`, overflow: 'hidden', boxShadow: '0 6px 24px rgba(0,0,0,.4)' } }, f);
      grid.append(h('figure', { onclick: () => update({ sizeId: size.id, view: 'single' }) }, box, h('figcaption', {}, `${size.id}  ·  ${size.w}×${size.h}`)));
    }
    viewport.append(grid);
  }

  function renderExplore() {
    stage.classList.add('hidden');
    viewport.querySelector('.all-sizes')?.remove();
    const size = currentSize();
    const key = `explore|${state.sizeId}|${state.pageId}|${state.safe}|${JSON.stringify(state.takes)}|${JSON.stringify(state.doc.pages)}`;
    let box = viewport.querySelector('.explore');
    if (box && box.dataset.key === key) return;
    box?.remove();
    box = h('div', { class: 'explore', dataset: { key } });
    const entries = [{ id: state.docId, label: 'Original (current)', doc: state.doc, original: true }, ...state.takes];
    if (!state.takes.length) {
      box.append(h('div', { class: 'bar' }, h('strong', {}, 'Explore')), h('div', { class: 'empty' }, 'No takes yet.', h('br'), 'Ask Claude for options, then pick the one you like. For example:',
        h('div', { class: 'copybox', style: { margin: '12px auto 0', maxWidth: '520px', textAlign: 'left' } }, `Use nordle_explore to make 3 genuinely different takes of "${state.doc.title}" in project "${state.project}" (doc "${state.docId}"): different layout, hierarchy and colour balance. Look at each one before you finish.`)));
    } else {
      box.append(h('div', { class: 'bar' }, h('strong', {}, `Explore · ${state.takes.length} take${state.takes.length === 1 ? '' : 's'}`), h('span', { class: 'muted' }, `page ${state.pageId}, ${size.id}`), h('span', { style: { flex: 1 } }),
        h('button', { class: 'btn sm danger', onclick: discardTakes }, 'Discard all takes')));
      const grid = h('div', { class: 'grid' });
      for (const e of entries) {
        const page = e.doc.pages.find((p) => p.id === state.pageId) ?? e.doc.pages[0];
        const zoom = Math.min(1, 480 / size.h, 360 / size.w);
        const f = h('iframe', { sandbox: 'allow-same-origin', tabindex: '-1', title: e.label });
        f.style.cssText = `width:${size.w}px;height:${size.h}px;transform:scale(${zoom})`;
        f.srcdoc = pageHtml(e.doc, size, page, state.safe).html;
        grid.append(h('figure', { dataset: { take: e.id } },
          h('div', { class: 'frame', style: { width: `${size.w * zoom}px`, height: `${size.h * zoom}px` } }, f),
          h('figcaption', {}, h('strong', {}, e.label), e.note ? ` · ${e.note}` : ''),
          e.original ? null : h('div', { class: 'acts' },
            h('button', { class: 'btn sm primary', onclick: () => adoptTake(e.id) }, 'Use this one'),
            h('button', { class: 'btn sm', onclick: () => { location.hash = `#/p/${state.project}/${e.id}`; } }, 'Open'))));
      }
      box.append(grid);
    }
    viewport.append(box);
  }

  function render() {
    const geo = geometry();
    const page = currentPage();
    if (!geo || !page || !state.fontManifest) return;
    banner.classList.toggle('hidden', !state.versionView);
    const ch = state.versionView?.change;
    if (ch) {
      const proposed = ch.mode === 'proposed';
      banner.replaceChildren(...[
        h('span', {}, proposed ? `Previewing Claude’s suggestion${ch.note ? `: ${ch.note}` : ''}` : `Claude’s change${ch.note ? `: ${ch.note}` : ''}`),
        h('div', { class: 'seg' }, [['before', proposed ? 'Now' : 'Before'], ['after', proposed ? 'With suggestion' : 'After']].map(([w, l]) => h('button', { class: ch.which === w ? 'on' : '', onclick: () => viewChange(ch.id, w) }, l))),
        h('span', { style: { flex: 1 } }),
        h('button', { class: 'btn sm', onclick: () => viewChange(null) }, 'Close'),
        ch.status === 'pending' ? h('button', { class: 'btn sm primary', onclick: () => decideChange(ch.id, 'accept') }, 'Accept') : null,
        ch.status === 'pending' ? h('button', { class: 'btn sm danger', onclick: () => decideChange(ch.id, 'reject') }, 'Reject') : null].filter(Boolean));
    } else if (state.versionView) {
      banner.replaceChildren(h('span', {}, `Viewing ${state.versionView.name} — read only.`), h('span', { style: { flex: 1 } }),
        h('button', { class: 'btn sm', onclick: () => viewVersion(null) }, 'Back to current'),
        h('button', { class: 'btn sm primary', onclick: () => restoreVersion(state.versionView.id) }, `Restore ${state.versionView.name}`));
    }
    if (state.view === 'explore') { renderExplore(); return; }
    viewport.querySelector('.explore')?.remove();
    if (state.view === 'all') { renderAllSizes(); return; }
    viewport.querySelector('.all-sizes')?.remove();
    stage.classList.remove('hidden');
    const { size, zoom } = geo;
    placeFrames(zoom, size);
    const html = pageHtml(shownDoc(), size, page, state.safe).html;
    const changed = html !== lastHtml;
    showPage(html, size, zoom);
    if (!changed && frame) refreshOverlay();
  }

  subscribe(() => { if (state.route.name === 'edit' && state.doc) render(); });
  return { render, refreshOverlay };
}

