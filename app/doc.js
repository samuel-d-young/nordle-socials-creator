// Everything that changes the open document or its review: edits go through commit(), which applies them on screen at
// once and sends them to the server in order.

import { api, clientId } from './api.js';
import { state, update, currentPage, currentSize } from './state.js';
import { applyOps, buildSetOps } from '/src/shared/ops.mjs';
import { regionOps } from '/src/shared/diff.mjs';
import { toast, confirmBox } from './dom.js';

let stopEvents = null;
let sendChain = Promise.resolve();
let takesTimer = null;

const fromServer = (d) => ({
  doc: d.doc, v: d.v, brand: d.brand, sizes: d.sizes, assets: d.assets, review: d.review, rv: d.rv, canUndo: d.canUndo, canRedo: d.canRedo, autonomy: d.autonomy ?? 'review',
});
const base = () => `/projects/${state.project}/docs/${state.docId}`;

/** Load a document and make it the open one. `then(kind)` may return more state to set in the same step (the route), so nothing ever sees a video while the picture editor is still showing. */
export async function openDoc(project, docId, then) {
  closeDoc();
  const data = await api.get(`/projects/${project}/docs/${docId}`);
  update({
    project, docId, ...fromServer(data), sizeId: data.sizes[0]?.id ?? null, pageId: data.doc.pages?.[0]?.id ?? null,
    sel: null, tool: 'select', versionView: null, checks: null, draftPin: null, focusComment: null, scope: 'all', view: 'single', pending: 0, takes: [],
    ...(then?.(data.doc.kind) ?? {}),
  });
  stopEvents = api.events(project, docId, onEvent, (online) => update({ online }));
  loadTakes();
  takesTimer = setInterval(loadTakes, 5000);
}

export function closeDoc() {
  stopEvents?.();
  stopEvents = null;
  clearInterval(takesTimer);
  takesTimer = null;
}

/** Resolves when every edit made so far has reached the server (a render, a still or a check reads the saved file). */
export const whenSaved = () => sendChain;

export async function reload() {
  const data = await api.get(base());
  const pages = data.doc.pages ?? []; // a video has a timeline, not pages
  const pageId = pages.some((p) => p.id === state.pageId) ? state.pageId : pages[0]?.id ?? null;
  const keep = state.sel && locate(data.doc, state.sel.pageId, state.sel.layerId);
  update({ ...fromServer(data), pageId, sel: keep ? state.sel : null });
}

export async function reloadReview() {
  const r = await api.get(`${base()}/review`);
  update({ review: r.review, rv: r.rv, autonomy: r.autonomy ?? state.autonomy });
}

function onEvent(e) {
  if (e.type === 'hello') {
    if (e.v !== state.v && state.pending === 0) reload().catch(() => {});
    reloadReview().catch(() => {});
  } else if (e.type === 'doc') {
    if (e.origin === clientId) return;
    if (state.pending === 0 && e.v === state.v + 1) {
      try { update({ doc: applyOps(state.doc, e.ops).doc, v: e.v, canUndo: true }); } catch { reload().catch(() => {}); }
    } else {
      reload().catch(() => {});
    }
  } else if (e.type === 'review') {
    reloadReview().catch(() => {});
  }
}

// ---- finding things -------------------------------------------------------------------------------------------------

/** Where a layer is: its JSON pointer, its place in its parent, and its siblings. */
export function locate(doc, pageId, layerId) {
  const pageIndex = doc?.pages?.findIndex((p) => p.id === pageId) ?? -1;
  if (pageIndex < 0) return null;
  const search = (layers, parentPtr, depth) => {
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      const ptr = `${parentPtr}/${i}`;
      if (layer.id === layerId) return { layer, ptr, index: i, parentPtr, siblings: layers, pageIndex, depth };
      if (layer.children) {
        const inner = search(layer.children, `${ptr}/children`, depth + 1);
        if (inner) return inner;
      }
    }
    return null;
  };
  return search(doc.pages[pageIndex].layers, `/pages/${pageIndex}/layers`, 0);
}

export const selectedLayer = () => (state.sel ? locate(state.doc, state.sel.pageId, state.sel.layerId) : null);

export function select(pageId, layerId) {
  update({ sel: layerId ? { pageId, layerId } : null, pageId: pageId ?? state.pageId });
}

// ---- committing edits -----------------------------------------------------------------------------------------------

const readOnly = () => {
  if (state.versionView) { toast(`You are looking at ${state.versionView.name}. Go back to the current version to edit.`, 'error'); return true; }
  return false;
};

export function commit(ops, note = '') {
  if (!ops.length || readOnly()) return Promise.resolve(false);
  let next;
  try { next = applyOps(state.doc, ops).doc; } catch (e) { toast(e.message, 'error'); return Promise.resolve(false); }
  update({ doc: next, pending: state.pending + 1, canUndo: true, canRedo: false, checks: null });
  const send = sendChain.then(async () => {
    try {
      const res = await api.post(`${base()}/patch`, { ops, baseVersion: state.v, note, actor: 'human' });
      update({ v: res.v, pending: state.pending - 1 });
      return true;
    } catch (e) {
      update({ pending: state.pending - 1 });
      toast(e.status === 409 ? 'This post was changed somewhere else (another tab, or Claude), so your last edit was not applied. The latest version is loaded: look again, then redo the edit.' : e.message, 'error');
      await reload().catch(() => {});
      return false;
    }
  });
  sendChain = send.catch(() => {});
  return send;
}

/**
 * Edit one layer. `changes` is a list of {group, key, value}; group is 'layout', 'style' or null for the layer itself.
 * When the scope is "this size only", layout, style, text and hidden changes are saved as overrides for the current size.
 */
export function editLayer(ref, changes, { note, scope = state.scope } = {}) {
  const sizeId = currentSize()?.id;
  const entries = changes.map(({ group, key, value }) => {
    const sizeOnly = scope === 'size' && sizeId && (group === 'layout' || group === 'style' || (!group && (key === 'text' || key === 'hidden')));
    const root = sizeOnly ? `${ref.ptr}/overrides/${sizeId}` : ref.ptr;
    return { pointer: group ? `${root}/${group}/${key}` : `${root}/${key}`, value };
  });
  return commit(buildSetOps(state.doc, entries), note ?? `Edit ${ref.layer.id}`);
}

export async function undo() {
  if (readOnly()) return;
  await sendChain;
  try { await api.post(`${base()}/undo`); await reload(); } catch (e) { toast(e.message, 'error'); }
}

export async function redo() {
  if (readOnly()) return;
  await sendChain;
  try { await api.post(`${base()}/redo`); await reload(); } catch (e) { toast(e.message, 'error'); }
}

// ---- layers and pages -----------------------------------------------------------------------------------------------

function uniqueId(taken, base) {
  const clean = String(base).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'layer';
  if (!taken.has(clean)) return clean;
  for (let i = 2; ; i++) if (!taken.has(`${clean}-${i}`)) return `${clean}-${i}`;
}

function idsOnPage(page) {
  const out = new Set();
  const visit = (layers) => { for (const l of layers) { out.add(l.id); if (l.children) visit(l.children); } };
  visit(page.layers);
  return out;
}

const firstKey = (o, prefer) => (prefer.find((k) => k in o) ?? Object.keys(o)[0]);

export function layerTemplate(type, extra = {}) {
  const fonts = state.brand.fonts, colors = state.brand.colors;
  const font = `$brand.fonts.${firstKey(fonts, ['body', 'display'])}`;
  const ink = `$brand.colors.${firstKey(colors, ['ink', 'text', 'primary'])}`;
  const accent = `$brand.colors.${firstKey(colors, ['accent', 'primary', 'ink'])}`;
  switch (type) {
    case 'text': return { type, text: 'New text', layout: { anchor: 'center', x: 50, y: 50, w: 70 }, style: { font, size: 72, weight: 600, color: ink, align: 'center' } };
    case 'rect': return { type: 'shape', shape: 'rect', layout: { anchor: 'center', x: 50, y: 50, w: 50, h: 18 }, style: { fill: accent, radius: 24 } };
    case 'ellipse': return { type: 'shape', shape: 'ellipse', layout: { anchor: 'center', x: 50, y: 50, w: 40, h: 28 }, style: { fill: accent } };
    case 'line': return { type: 'shape', shape: 'line', layout: { anchor: 'center', x: 50, y: 50, w: 40 }, style: { stroke: { color: ink, width: 4 } } };
    case 'image': return { type: 'image', fit: 'cover', alt: '', layout: { anchor: 'center', x: 50, y: 50, w: 60, h: 'auto' }, ...extra };
    default: throw new Error(`unknown layer type ${type}`);
  }
}

export async function addLayer(type, extra = {}) {
  const page = state.doc.pages.find((p) => p.id === state.pageId);
  if (!page) return;
  const tpl = layerTemplate(type, extra);
  const id = uniqueId(idsOnPage(page), tpl.shape ?? tpl.type);
  const pageIndex = state.doc.pages.indexOf(page);
  const ok = await commit([{ op: 'add', path: `/pages/${pageIndex}/layers/-`, value: { id, ...tpl } }], `Add ${tpl.shape ?? tpl.type}`);
  if (ok !== false) select(page.id, id);
}

export async function deleteLayer(ref) {
  if (ref.layer.lock) { toast('This layer is locked. Unlock it first.', 'error'); return; }
  await commit([{ op: 'remove', path: ref.ptr }], `Delete ${ref.layer.id}`);
  update({ sel: null });
}

export async function duplicateLayer(ref) {
  const page = state.doc.pages[ref.pageIndex];
  const copy = structuredClone(ref.layer);
  const ids = idsOnPage(page);
  const remap = (l) => { l.id = uniqueId(ids, l.id); ids.add(l.id); delete l.lock; (l.children ?? []).forEach(remap); };
  remap(copy);
  if (copy.layout && typeof copy.layout.x === 'number') copy.layout.x += 2;
  if (copy.layout && typeof copy.layout.y === 'number') copy.layout.y += 2;
  const ok = await commit([{ op: 'add', path: `${ref.parentPtr}/${ref.index + 1}`, value: copy }], `Duplicate ${ref.layer.id}`);
  if (ok !== false) select(page.id, copy.id);
}

/** Move a layer within its list. delta -1 = one step toward the front of the list (down the stack), +1 = toward the back. */
export function moveLayer(ref, toIndex) {
  const to = Math.max(0, Math.min(ref.siblings.length - 1, toIndex));
  if (to === ref.index) return Promise.resolve(false);
  return commit([{ op: 'move', from: ref.ptr, path: `${ref.parentPtr}/${to}` }], `Reorder ${ref.layer.id}`);
}

export async function addPage() {
  const cur = state.doc.pages.find((p) => p.id === state.pageId) ?? state.doc.pages.at(-1);
  const ids = new Set(state.doc.pages.map((p) => p.id));
  const id = uniqueId(ids, `page-${state.doc.pages.length + 1}`);
  const page = { id, title: `Page ${state.doc.pages.length + 1}`, background: structuredClone(cur?.background ?? '$brand.colors.paper'), layers: [] };
  const ok = await commit([{ op: 'add', path: '/pages/-', value: page }], 'Add page');
  if (ok !== false) update({ pageId: id, sel: null });
}

export async function duplicatePage(pageId) {
  const i = state.doc.pages.findIndex((p) => p.id === pageId);
  if (i < 0) return;
  const copy = structuredClone(state.doc.pages[i]);
  copy.id = uniqueId(new Set(state.doc.pages.map((p) => p.id)), `${copy.id}-copy`);
  copy.title = `${copy.title ?? copy.id} copy`;
  delete copy.lock;
  const ok = await commit([{ op: 'add', path: `/pages/${i + 1}`, value: copy }], 'Duplicate page');
  if (ok !== false) update({ pageId: copy.id, sel: null });
}

export async function deletePage(pageId) {
  if (state.doc.pages.length < 2) { toast('A post needs at least one page.', 'error'); return; }
  const i = state.doc.pages.findIndex((p) => p.id === pageId);
  if (state.doc.pages[i].lock) { toast('This page is locked.', 'error'); return; }
  if (state.doc.pages[i].layers.length && !(await confirmBox(`Delete "${state.doc.pages[i].title ?? pageId}" and everything on it? You can undo this.`, { ok: 'Delete page', danger: true }))) return;
  const next = state.doc.pages[i + 1] ?? state.doc.pages[i - 1];
  await commit([{ op: 'remove', path: `/pages/${i}` }], 'Delete page');
  update({ pageId: next.id, sel: null });
}

export function movePage(pageId, toIndex) {
  const from = state.doc.pages.findIndex((p) => p.id === pageId);
  const to = Math.max(0, Math.min(state.doc.pages.length - 1, toIndex));
  if (from < 0 || from === to) return Promise.resolve(false);
  return commit([{ op: 'move', from: `/pages/${from}`, path: `/pages/${to}` }], 'Reorder pages');
}

export function setPageValue(pageId, key, value) {
  const i = state.doc.pages.findIndex((p) => p.id === pageId);
  return commit(buildSetOps(state.doc, [{ pointer: `/pages/${i}/${key}`, value }]), `Edit page ${pageId}`);
}

export function setDocValue(pointer, value, note) {
  return commit(buildSetOps(state.doc, [{ pointer, value }]), note ?? 'Edit post');
}

// ---- assets ---------------------------------------------------------------------------------------------------------

export async function uploadImages(files) {
  const added = [];
  for (const file of files) {
    try {
      const r = await api.upload(state.project, file);
      added.push(r.path);
      update({ assets: r.assets });
    } catch (e) { toast(`${file.name}: ${e.message}`, 'error'); }
  }
  return added;
}

// ---- review ---------------------------------------------------------------------------------------------------------

const rid = (p) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const nowIso = () => new Date().toISOString();

async function reviewPatch(ops) {
  try {
    await api.post(`${base()}/review/patch`, { ops, actor: 'human' });
    await reloadReview();
    return true;
  } catch (e) { toast(e.message, 'error'); return false; }
}

export async function addComment({ pageId, x, y, layerId, text, time }) {
  const c = { id: rid('c'), page: pageId, x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)), text: text.trim(), author: 'human', created: nowIso(), status: 'open', docV: state.v };
  if (layerId) c.layer = layerId;
  if (Number.isFinite(time) && time >= 0) c.time = Math.round(time * 100) / 100; // a pin on a moment of a video
  if (state.sizeId) c.size = state.sizeId;
  const ok = await reviewPatch([{ op: 'add', path: '/comments/-', value: c }]);
  if (ok) update({ focusComment: c.id, panel: 'review', draftPin: null });
  return ok;
}

const commentIndex = (id) => state.review.comments.findIndex((c) => c.id === id);
export const resolveComment = (id, resolved) => reviewPatch([{ op: 'replace', path: `/comments/${commentIndex(id)}/status`, value: resolved ? 'resolved' : 'open' }, ...(resolved || !state.review.comments[commentIndex(id)].resolvedIn ? [] : [{ op: 'remove', path: `/comments/${commentIndex(id)}/resolvedIn` }])]);
export function replyToComment(id, text) {
  const i = commentIndex(id);
  const reply = { id: rid('r'), author: 'human', text: text.trim(), created: nowIso() };
  const has = Array.isArray(state.review.comments[i].replies);
  return reviewPatch([has ? { op: 'add', path: `/comments/${i}/replies/-`, value: reply } : { op: 'add', path: `/comments/${i}/replies`, value: [reply] }]);
}
export const deleteComment = (id) => reviewPatch([{ op: 'remove', path: `/comments/${commentIndex(id)}` }]);

export async function saveVersion({ name, note }) {
  try { const r = await api.post(`${base()}/review/versions`, { name, note }); await reloadReview(); toast(`Saved ${r.version.name}`, 'ok'); return r.version; } catch (e) { toast(e.message, 'error'); return null; }
}

export async function approve(note) {
  try { await api.post(`${base()}/review/approve`, { note }); await reloadReview(); toast('Approved. This version is saved.', 'ok'); } catch (e) { toast(e.message, 'error'); }
}

export async function revokeApproval() {
  try { await api.del(`${base()}/review/approve`); await reloadReview(); } catch (e) { toast(e.message, 'error'); }
}

export async function viewVersion(id) {
  if (!id) { update({ versionView: null }); return; }
  try {
    const r = await api.get(`${base()}/review/versions/${id}/doc`);
    const name = state.review.versions.find((v) => v.id === id)?.name ?? id;
    update({ versionView: { id, name, doc: r.doc }, sel: null, draftPin: null });
  } catch (e) { toast(e.message, 'error'); }
}

export async function restoreVersion(id) {
  const name = state.review.versions.find((v) => v.id === id)?.name ?? id;
  if (!(await confirmBox(`Replace the current post with ${name}? You can undo this.`, { ok: `Restore ${name}` }))) return;
  try {
    await sendChain;
    await api.post(`${base()}/review/versions/${id}/restore`);
    update({ versionView: null });
    await reload();
    toast(`Restored ${name}`, 'ok');
  } catch (e) { toast(e.message, 'error'); }
}

export async function copyForClaude() {
  try {
    const { text } = await api.get(`${base()}/review/handoff`);
    await navigator.clipboard.writeText(text);
    toast('Copied. Paste it to Claude.', 'ok');
  } catch (e) { toast(`Could not copy: ${e.message}`, 'error'); }
}

// ---- Claude: the dial, its changes, takes ----------------------------------------------------------------------------------

export async function setAutonomy(value) {
  try { await api.post(`${base()}/review/settings`, { autonomy: value }); update({ autonomy: value }); await reloadReview(); } catch (e) { toast(e.message, 'error'); }
}

async function refreshAfterDecision() {
  await reload().catch(() => {});
  await reloadReview().catch(() => {});
}

export async function decideChange(id, decision) {
  try {
    await sendChain;
    await api.post(`${base()}/review/changes/${id}/${decision}`);
    if (state.versionView?.change?.id === id) update({ versionView: null });
    await refreshAfterDecision();
    toast(decision === 'accept' ? 'Accepted.' : 'Rejected. The post is back as it was.', 'ok');
  } catch (e) {
    toast(e.message, 'error');
    await refreshAfterDecision();
  }
}

export async function decideAll(decision) {
  try {
    await sendChain;
    const r = await api.post(`${base()}/review/changes/${decision}-all`);
    if (state.versionView?.change) update({ versionView: null });
    await refreshAfterDecision();
    toast(`${decision === 'accept' ? 'Accepted' : 'Rejected'} ${r.done} change${r.done === 1 ? '' : 's'}.`, 'ok');
  } catch (e) {
    toast(e.message, 'error');
    update({ versionView: null });
    await refreshAfterDecision();
  }
}

/** Look at one of Claude's changes: the page after it (default) or before it, or what a suggestion would give. Read-only. */
export function viewChange(id, which = 'after') {
  if (!id) { update({ versionView: null }); return; }
  const change = (state.review?.changes ?? []).find((c) => c.id === id);
  if (!change) return;
  let doc;
  try {
    if (change.mode === 'proposed') doc = which === 'after' ? applyOps(state.doc, change.ops).doc : state.doc;
    else doc = which === 'after' ? state.doc : applyOps(state.doc, regionOps(state.doc, change.regions ?? [], 'before')).doc;
  } catch (e) {
    toast(e.conflict ? 'Parts of this have changed again since, so there is no clean “before” to show.' : 'That suggestion no longer fits the post.', 'error');
    return;
  }
  const first = change.touched?.[0]?.page;
  update({
    versionView: { id: `change:${id}`, name: 'Claude’s change', doc, change: { id, which, mode: change.mode, note: change.note, status: change.status } },
    sel: null, draftPin: null, ...(first && doc.pages.some((p) => p.id === first) ? { pageId: first } : {}),
  });
}

export async function loadTakes() {
  if (!state.project || !state.docId) return;
  try {
    const r = await api.get(`${base()}/explore`);
    const takes = [];
    for (const t of r.takes) takes.push({ ...t, doc: (await api.get(`/projects/${state.project}/docs/${t.id}`)).doc });
    if (JSON.stringify(takes) !== JSON.stringify(state.takes)) update({ takes });
  } catch { /* the document may have just been closed */ }
}

export async function adoptTake(takeId) {
  const take = state.takes.find((t) => t.id === takeId);
  if (!(await confirmBox(`Make this post look like “${take?.label ?? takeId}”? You can undo it.`, { ok: 'Use this one' }))) return;
  try {
    await sendChain;
    await api.post(`${base()}/explore/${takeId}/adopt`);
    update({ view: 'single' });
    await reload();
    toast(`Now using “${take?.label ?? takeId}”. Undo brings the old version back.`, 'ok');
  } catch (e) { toast(e.message, 'error'); }
}

export async function discardTakes() {
  if (!(await confirmBox('Discard all the takes? They are moved to the trash folder, not deleted.', { ok: 'Discard takes', danger: true }))) return;
  try { await api.del(`${base()}/explore`); update({ takes: [], view: 'single' }); } catch (e) { toast(e.message, 'error'); }
}

/** Start a comment on the selected layer, for Claude to act on. */
export function askClaude(ref) {
  const size = currentSize();
  const lay = { ...(ref.layer.layout ?? {}), ...(ref.layer.overrides?.[size?.id]?.layout ?? {}) };
  const frac = (v) => (typeof v === 'number' ? Math.min(1, Math.max(0, v / 100)) : 0.5);
  update({ draftPin: { pageId: state.sel.pageId, x: frac(lay.x), y: frac(lay.y), layerId: ref.layer.id }, tool: 'select' });
}

// ---- checking and exporting -----------------------------------------------------------------------------------------

export async function runCheck() {
  update({ checks: { running: true } });
  try {
    await sendChain;
    const r = await api.post(`${base()}/critique`, { sheet: false });
    update({ checks: { running: false, issues: r.issues, score: r.score, verdict: r.verdict, passScore: r.passScore, counts: r.counts, at: Date.now() } });
  } catch (e) { update({ checks: null }); toast(e.message, 'error'); }
}

export async function exportPost(options) {
  await sendChain;
  return api.post(`${base()}/export`, options);
}

export { currentPage, buildSetOps };
