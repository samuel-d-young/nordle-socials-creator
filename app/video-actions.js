// Everything that changes a video. Each action asks src/shared/cutlist.mjs for JSON Patch operations and sends them through
// commit(), so undo, redo, history, locks, Claude's diffs and review all see the same edits as for a picture.
// A CutError says what is wrong in plain English; it is shown as a message and nothing changes.

import { commit } from './doc.js';
import { toast } from './dom.js';
import { state } from './state.js';
import { applyOps, buildSetOps, hasAt } from '/src/shared/ops.mjs';
import { splitClip, trimClip, moveClip, deleteClip, findClip, totalDuration } from '/src/shared/cutlist.mjs';
import { V, clipsOf, doc, fpsOf, layerIndex, lengthOf, sceneIndex, seek, select, selectedClip, selectedClipIds, snapFrame, sourceOf, trackIndex, durationOf, clock } from './video-state.js';
import { waveOf } from './video-data.js';

const r9 = (v) => Math.round(v * 1e9) / 1e9;

function viewingOld() {
  if (!state.versionView) return false;
  toast(`You are looking at ${state.versionView.name}. Go back to the current version to edit.`, 'error');
  return true;
}

/** Build operations from the live document and send them. `build(doc)` returns operations or throws a message. */
export async function apply(build, note) {
  if (viewingOld()) return false;
  let ops;
  try { ops = build(state.doc); } catch (e) { toast(e.message || String(e), 'error'); return false; }
  if (!ops?.length) return false;
  return commit(ops, note);
}

/** Run several builders one after another, each on the document the earlier ones produced. */
export function chain(d, builders) {
  let cur = d;
  const all = [];
  for (const b of builders) {
    const ops = b(cur);
    if (!ops.length) continue;
    cur = applyOps(cur, ops).doc;
    all.push(...ops);
  }
  return all;
}

// ---- the playhead -----------------------------------------------------------------------------------------------------------

export const stepFrames = (n) => seek(V.playhead + n / fpsOf(), { exact: false });
export const stepSeconds = (s) => seek(V.playhead + s);

// ---- clips ------------------------------------------------------------------------------------------------------------------

/** How long the footage of a clip's source is, if the document or the waveform knows (a photo has no limit). */
export function footageLength(d, clipId) {
  const ref = findClip(d, clipId);
  const s = ref && sourceOf(d, ref.clip.source);
  if (!s || s.type === 'image') return undefined;
  return s.duration ?? waveOf(s.id)?.data?.duration ?? undefined;
}

export function splitSelected() {
  const ids = selectedClipIds();
  if (!ids.length) { toast('Click a clip first. Then press S (or the Split button) to cut it at the playhead.', 'error'); return Promise.resolve(false); }
  const t = V.playhead;
  const inside = (d, id) => { const r = findClip(d, id); return r && t > r.clip.at + 1e-6 && t < r.clip.at + durationOf(r.clip, d) - 1e-6; };
  if (!ids.some((id) => inside(state.doc, id))) {
    toast(`The playhead (${clock(t)}) is not inside ${ids.length > 1 ? 'the selected clips' : `clip "${ids[0]}"`}. Move it onto the clip, then split.`, 'error');
    return Promise.resolve(false);
  }
  return apply((d) => chain(d, ids.filter((id) => inside(d, id)).map((id) => (dd) => splitClip(dd, id, t))), `Split at ${clock(t)}`);
}

export function deleteSelected({ ripple = V.ripple } = {}) {
  const ids = V.sel.ids.slice();
  if (!ids.length) { toast('Nothing is selected. Click a clip, a title or a scene first.', 'error'); return Promise.resolve(false); }
  if (V.sel.kind === 'clip') {
    return apply((d) => chain(d, ids.map((id) => (dd) => deleteClip(dd, id, { ripple }))), `Delete ${ids.length > 1 ? `${ids.length} clips` : ids[0]}`).then((ok) => { if (ok) select(null, []); return ok; });
  }
  if (V.sel.kind === 'layer') {
    return apply((d) => {
      const locked = ids.find((id) => d.layers?.[layerIndex(d, id)]?.lock);
      if (locked) throw new Error(`"${locked}" is locked. Unlock it first.`);
      return ids.map((id) => layerIndex(d, id)).filter((i) => i >= 0).sort((a, b) => b - a).map((i) => ({ op: 'remove', path: `/layers/${i}` }));
    }, `Delete ${ids.join(', ')}`).then((ok) => { if (ok) select(null, []); return ok; });
  }
  if (V.sel.kind === 'scene') {
    return apply((d) => ids.map((id) => sceneIndex(d, id)).filter((i) => i >= 0).sort((a, b) => b - a).map((i) => ({ op: 'remove', path: `/timeline/scenes/${i}` })), `Delete scene ${ids.join(', ')}`).then((ok) => { if (ok) select(null, []); return ok; });
  }
  toast('A track cannot be deleted here. Delete its clips instead.', 'error');
  return Promise.resolve(false);
}

export const moveClipTo = (id, at, { ripple = false } = {}) => apply((d) => moveClip(d, id, at, { ripple }), `Move ${id}`);
export const trimClipTo = (id, to, { ripple = false } = {}) => apply((d) => trimClip(d, id, to, { ripple, sourceDuration: footageLength(d, id) }), `Trim ${id}`);

export function nudgeSelected(frames) {
  const ids = selectedClipIds();
  if (!ids.length) { toast('Click a clip first, then nudge it.', 'error'); return Promise.resolve(false); }
  return apply((d) => chain(d, ids.map((id) => (dd) => moveClip(dd, id, findClip(dd, id).clip.at + frames / fpsOf(dd), { ripple: false }))), `Nudge ${ids.length > 1 ? `${ids.length} clips` : ids[0]}`);
}

/** I and O outside the source monitor: start (or end) the selected clip at the playhead. */
export function trimToPlayhead(edge, { ripple = false } = {}) {
  const ref = selectedClip(state.doc);
  if (!ref) { toast('Click a clip first. I and O cut its start and end at the playhead.', 'error'); return Promise.resolve(false); }
  const c = ref.clip;
  const t = V.playhead;
  if (!(t > c.at + 1e-6 && t < c.at + durationOf(c, state.doc) - 1e-6)) { toast(`Move the playhead onto "${c.id}" first: it is at ${clock(t)}, the clip runs ${clock(c.at)} to ${clock(c.at + durationOf(c, state.doc))}.`, 'error'); return Promise.resolve(false); }
  const speed = sourceOf(state.doc, c.source)?.type === 'image' ? 1 : c.speed ?? 1;
  const src = r9(c.in + (t - c.at) * speed);
  return trimClipTo(c.id, edge === 'in' ? { in: src } : { out: src }, { ripple });
}

/** I and O in the source monitor: the clip plays from (or to) this moment of its source. */
export function setClipSourcePoint(clipId, edge, sourceTime) {
  return trimClipTo(clipId, edge === 'in' ? { in: sourceTime } : { out: sourceTime });
}

/** Pick the previous or next clip on the same track (or the first clip, when nothing is selected). */
export function selectNeighbour(dir) {
  const d = doc();
  const cur = selectedClip(d);
  if (!cur) {
    const all = clipsOf(d).sort((a, b) => a.clip.at - b.clip.at);
    const first = all.find((c) => c.clip.at + durationOf(c.clip, d) > V.playhead - 1e-6) ?? all[0];
    if (first) select('clip', [first.clip.id]);
    return;
  }
  const list = cur.track.clips.slice().sort((a, b) => a.at - b.at);
  const i = list.findIndex((c) => c.id === cur.clip.id);
  const next = list[i + dir];
  if (next) { select('clip', [next.id]); seek(next.at); }
}

// ---- tracks, layers, scenes --------------------------------------------------------------------------------------------------

export function toggleTrack(trackId, key) {
  return apply((d) => {
    const i = trackIndex(d, trackId);
    return buildSetOps(d, [{ pointer: `/timeline/tracks/${i}/${key}`, value: d.timeline.tracks[i][key] ? undefined : true }]);
  }, `${key[0].toUpperCase()}${key.slice(1)} track ${trackId}`);
}

export function setTrackName(trackId, name) {
  return apply((d) => buildSetOps(d, [{ pointer: `/timeline/tracks/${trackIndex(d, trackId)}/name`, value: name.trim() || undefined }]), `Rename track ${trackId}`);
}

export function setLayerTime(id, { start, end }) {
  return apply((d) => {
    const i = layerIndex(d, id);
    const l = d.layers[i];
    if (l.lock) throw new Error(`"${id}" is locked. Unlock it first.`);
    const fps = fpsOf(d);
    const s = Math.max(0, snapFrame(start, fps));
    const e = snapFrame(end, fps);
    if (e - s < 1 / fps - 1e-9) throw new Error(`"${id}" would be shorter than one frame.`);
    if (s === l.time.start && e === l.time.end) return [];
    return [{ op: 'replace', path: `/layers/${i}/time`, value: { start: s, end: e } }];
  }, `Move ${id}`);
}

export function setSceneEdges(id, { start, end, neighbour }) {
  return apply((d) => {
    const scenes = d.timeline.scenes ?? [];
    const i = sceneIndex(d, id);
    const fps = fpsOf(d);
    const ops = [];
    const sc = scenes[i];
    const s = snapFrame(start ?? sc.start, fps), e = snapFrame(end ?? sc.end, fps);
    if (e - s < 1 / fps - 1e-9) throw new Error('A scene must be at least one frame long.');
    if (s < 0) throw new Error('A scene cannot start before the beginning.');
    if (s !== sc.start) ops.push({ op: 'replace', path: `/timeline/scenes/${i}/start`, value: s });
    if (e !== sc.end) ops.push({ op: 'replace', path: `/timeline/scenes/${i}/end`, value: e });
    if (neighbour) {
      const j = sceneIndex(d, neighbour.id);
      const n = scenes[j];
      const ns = neighbour.edge === 'start' ? e : n.start;
      const ne = neighbour.edge === 'end' ? s : n.end;
      if (ne - ns < 1 / fps - 1e-9) throw new Error(`Scene "${n.title ?? n.id}" would be shorter than one frame.`);
      if (neighbour.edge === 'start' && ns !== n.start) ops.push({ op: 'replace', path: `/timeline/scenes/${j}/start`, value: ns });
      if (neighbour.edge === 'end' && ne !== n.end) ops.push({ op: 'replace', path: `/timeline/scenes/${j}/end`, value: ne });
    }
    return ops;
  }, `Change scene ${id}`);
}

/** The "+" in the scenes lane: split the scene under the playhead, or add a scene from the playhead to the next scene (or the end). */
export function addScene() {
  return apply((d) => {
    const scenes = d.timeline.scenes ?? [];
    const t = V.playhead;
    const fps = fpsOf(d);
    const ids = new Set(scenes.map((s) => s.id));
    const fresh = (base) => { for (let n = 2; ; n++) { const id = `${base}-${n}`; if (!ids.has(id)) return id; } };
    const at = scenes.findIndex((s) => t > s.start + 1 / fps - 1e-9 && t < s.end - 1 / fps + 1e-9);
    const ops = [];
    if (at >= 0) {
      const sc = scenes[at];
      ops.push({ op: 'replace', path: `/timeline/scenes/${at}/end`, value: t });
      ops.push({ op: 'add', path: `/timeline/scenes/${at + 1}`, value: { id: fresh(sc.id), title: `${sc.title ?? sc.id} 2`, start: t, end: sc.end } });
      return ops;
    }
    const next = scenes.filter((s) => s.start > t).sort((a, b) => a.start - b.start)[0];
    const end = Math.min(next ? next.start : lengthOf(d), t + 3);
    if (end - t < 1 / fps) throw new Error('There is no room for a scene here. Move the playhead earlier.');
    const sorted = scenes.filter((s) => s.start < t).length;
    return [{ op: 'add', path: scenes.length ? `/timeline/scenes/${sorted}` : '/timeline/scenes', value: scenes.length ? { id: fresh('scene'), title: 'New scene', start: t, end } : [{ id: 'scene-1', title: 'New scene', start: t, end }] }];
  }, 'Add scene');
}

export function renameScene(id, title) {
  return apply((d) => buildSetOps(d, [{ pointer: `/timeline/scenes/${sceneIndex(d, id)}/title`, value: title.trim() || undefined }]), `Rename scene ${id}`);
}

// ---- fields of a clip or a layer, from the inspector ---------------------------------------------------------------------------

/**
 * Set (or with undefined, remove) a value inside a clip: path like ['zoom', 'from']. When the last value of an object
 * (zoom, pan, fade, transition ...) is removed the empty object goes too, because the schema does not allow it empty.
 */
export function setIn(base, d, parts, value) {
  const ptr = `${base}/${parts.join('/')}`;
  if (value === undefined && parts.length > 1 && hasAt(d, ptr)) {
    const parentPtr = `${base}/${parts.slice(0, -1).join('/')}`;
    const parent = parts.slice(0, -1).reduce((o, k) => o?.[k], base.split('/').slice(1).reduce((o, k) => o?.[k], d));
    if (parent && Object.keys(parent).filter((k) => k !== parts.at(-1)).length === 0) return [{ op: 'remove', path: parentPtr }];
  }
  return buildSetOps(d, [{ pointer: ptr, value }]);
}

const clipBase = (d, id) => { const r = findClip(d, id); return `/timeline/tracks/${r.trackIndex}/clips/${r.clipIndex}`; };

/** The first clip on this track (other than `id`) that would overlap [start, end), or null. */
function overlapping(d, trackIdx, id, start, end) {
  return d.timeline.tracks[trackIdx].clips.find((o) => o.id !== id && o.at < end - 1e-6 && o.at + durationOf(o, d) > start + 1e-6) ?? null;
}

export function setClipField(id, parts, value, note) {
  return apply((d) => {
    const r = findClip(d, id);
    if (r.track.lock) throw new Error(`Track "${r.track.id}" is locked. Unlock it first.`);
    if (parts.length === 1 && parts[0] === 'speed') {
      const speed = value ?? 1;
      const end = r.clip.at + (r.clip.out - r.clip.in) / speed;
      const hit = overlapping(d, r.trackIndex, id, r.clip.at, end);
      if (hit) throw new Error(`At ${speed}x "${id}" would last until ${clock(end)} and run into "${hit.id}", which starts at ${clock(hit.at)}. Make room first, or trim the clip.`);
    }
    return setIn(clipBase(d, id), d, parts, value);
  }, note ?? `Change ${id}`);
}

export function setClipFields(id, entries, note) {
  return apply((d) => {
    const r = findClip(d, id);
    if (r.track.lock) throw new Error(`Track "${r.track.id}" is locked. Unlock it first.`);
    return chain(d, entries.map(([parts, value]) => (dd) => setIn(clipBase(dd, id), dd, parts, value)));
  }, note ?? `Change ${id}`);
}

export function setLayerField(id, parts, value, note) {
  return apply((d) => {
    const i = layerIndex(d, id);
    if (d.layers[i].lock && !(parts.length === 1 && parts[0] === 'lock')) throw new Error(`"${id}" is locked. Unlock it first.`);
    return setIn(`/layers/${i}`, d, parts, value);
  }, note ?? `Change ${id}`);
}

export function setDocField(pointer, value, note) {
  return apply((d) => buildSetOps(d, [{ pointer, value }]), note ?? 'Change the video');
}

export { totalDuration };
