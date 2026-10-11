// What changed between two versions of a document: a short description a person (or Claude) can read, which layers
// were touched, and "regions" that let one change be taken back exactly, as long as nothing else has touched that
// region since. Pure: runs in Node and in the browser.

import { clone, deepEqual } from './ops.mjs';

const MAX_LINES = 14;

function show(v) {
  if (v === undefined) return '(none)';
  const s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v);
  return s.length > 44 ? `${s.slice(0, 41)}…` : s;
}

/** Every leaf that differs, as [path, before, after]. */
function leafDiffs(a, b, path = '', out = []) {
  if (deepEqual(a, b)) return out;
  const aObj = a !== null && typeof a === 'object';
  const bObj = b !== null && typeof b === 'object';
  if (aObj && bObj && Array.isArray(a) === Array.isArray(b)) {
    if (Array.isArray(a)) {
      if (a.length !== b.length) { out.push([path, a, b]); return out; }
      a.forEach((x, i) => leafDiffs(x, b[i], `${path}[${i}]`, out));
      return out;
    }
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) leafDiffs(a[k], b[k], path ? `${path}.${k}` : k, out);
    return out;
  }
  out.push([path, a, b]);
  return out;
}

function flatten(layers, out = new Map(), parent = null) {
  for (const l of layers ?? []) {
    const { children, ...rest } = l;
    out.set(l.id, { layer: rest, parent, hasChildren: !!children });
    if (children) flatten(children, out, l.id);
  }
  return out;
}

const layerLabel = (l) => (l.type === 'shape' ? `shape ${l.shape}` : l.type);

/** @returns {{lines:string[], touched:{page:string, layer:string|null}[]}} */
export function describeChange(before, after) {
  const lines = [];
  const touched = [];
  const touch = (page, layer = null) => { if (!touched.some((t) => t.page === page && t.layer === layer)) touched.push({ page, layer }); };

  const bp = before.pages ?? [], ap = after.pages ?? [];
  const bIds = bp.map((p) => p.id), aIds = ap.map((p) => p.id);
  for (const id of bIds) if (!aIds.includes(id)) { lines.push(`Removed page "${id}"`); touch(id); }
  for (const id of aIds) if (!bIds.includes(id)) { lines.push(`Added page "${id}"`); touch(id); }
  const common = bIds.filter((id) => aIds.includes(id));
  if (JSON.stringify(common) !== JSON.stringify(aIds.filter((id) => bIds.includes(id)))) lines.push('Reordered the pages');

  for (const id of common) {
    const pb = bp.find((p) => p.id === id), pa = ap.find((p) => p.id === id);
    if (deepEqual(pb, pa)) continue;
    const { layers: lb, ...restB } = pb, { layers: la, ...restA } = pa;
    for (const [path, x, y] of leafDiffs(restB, restA)) { lines.push(`${id}: page ${path} ${show(x)} → ${show(y)}`); touch(id); }
    const fb = flatten(lb), fa = flatten(la);
    for (const [lid, info] of fa) {
      if (!fb.has(lid)) { lines.push(`${id}: added ${layerLabel(info.layer)} "${lid}"`); touch(id, lid); continue; }
      const diffs = leafDiffs(fb.get(lid).layer, info.layer);
      if (diffs.length) {
        const shownDiffs = diffs.slice(0, 3).map(([path, x, y]) => `${path} ${show(x)} → ${show(y)}`).join('; ');
        lines.push(`${id}/${lid}: ${shownDiffs}${diffs.length > 3 ? ` (+${diffs.length - 3} more)` : ''}`);
        touch(id, lid);
      }
    }
    for (const [lid, info] of fb) if (!fa.has(lid)) { lines.push(`${id}: removed ${layerLabel(info.layer)} "${lid}"`); touch(id, lid); }
    // order of layers (z-order) changed without any layer changing
    const ob = [...fb.keys()].filter((k) => fa.has(k)), oa = [...fa.keys()].filter((k) => fb.has(k));
    if (JSON.stringify(ob) !== JSON.stringify(oa)) { lines.push(`${id}: changed the stacking order`); touch(id); }
  }

  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  keys.delete('pages');
  for (const k of keys) {
    if (deepEqual(before[k], after[k])) continue;
    if (k === 'copy') {
      for (const [path, x, y] of leafDiffs(before.copy ?? {}, after.copy ?? {})) lines.push(`copy.${path} ${show(x)} → ${show(y)}`);
    } else if (k === 'layers' || k === 'timeline' || k === 'sources') {
      lines.push(`${k} changed`);
    } else {
      lines.push(`${k} ${show(before[k])} → ${show(after[k])}`);
    }
  }

  if (lines.length > MAX_LINES) {
    const extra = lines.length - MAX_LINES;
    lines.length = MAX_LINES;
    lines.push(`… and ${extra} more`);
  }
  return { lines, touched };
}

// ---- regions -------------------------------------------------------------------------------------------------------

/** The parts of the document a change touched, with how each looked before and after. */
export function computeRegions(before, after) {
  const regions = [];
  const bIds = (before.pages ?? []).map((p) => p.id), aIds = (after.pages ?? []).map((p) => p.id);
  if (JSON.stringify(bIds) === JSON.stringify(aIds)) {
    bIds.forEach((id, i) => {
      if (!deepEqual(before.pages[i], after.pages[i])) regions.push({ key: `page:${id}`, before: clone(before.pages[i]), after: clone(after.pages[i]) });
    });
  } else if (!deepEqual(before.pages, after.pages)) {
    regions.push({ key: 'pages', before: clone(before.pages), after: clone(after.pages) });
  }
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (k === 'pages' || deepEqual(before[k], after[k])) continue;
    const r = { key: `top:${k}` };
    if (k in before) r.before = clone(before[k]); else r.beforeAbsent = true;
    if (k in after) r.after = clone(after[k]); else r.afterAbsent = true;
    regions.push(r);
  }
  return regions;
}

const valueAt = (doc, key) => {
  if (key === 'pages') return doc.pages;
  if (key.startsWith('page:')) return (doc.pages ?? []).find((p) => p.id === key.slice(5));
  const k = key.slice(4);
  return k in doc ? doc[k] : undefined;
};

/**
 * Operations that put the regions of `doc` into their "before" (or "after") state. Throws {conflict:[keys]} when `doc` is
 * not currently in the opposite state, i.e. something else has changed that region since.
 */
export function regionOps(doc, regions, which = 'before') {
  const from = which === 'before' ? 'after' : 'before';
  const absentFrom = `${from}Absent`, absentTo = `${which}Absent`;
  const conflicts = regions.filter((r) => {
    const cur = valueAt(doc, r.key);
    return r[absentFrom] ? cur !== undefined : !deepEqual(cur, r[from]);
  }).map((r) => r.key);
  if (conflicts.length) { const e = new Error(`These parts changed again since: ${conflicts.join(', ')}`); e.conflict = conflicts; throw e; }
  const ops = [];
  for (const r of regions) {
    if (r.key === 'pages') ops.push({ op: 'replace', path: '/pages', value: clone(r[which]) });
    else if (r.key.startsWith('page:')) {
      const i = doc.pages.findIndex((p) => p.id === r.key.slice(5));
      ops.push({ op: 'replace', path: `/pages/${i}`, value: clone(r[which]) });
    } else {
      const k = r.key.slice(4);
      if (r[absentTo]) ops.push({ op: 'remove', path: `/${k}` });
      else ops.push({ op: k in doc ? 'replace' : 'add', path: `/${k}`, value: clone(r[which]) });
    }
  }
  return ops;
}
