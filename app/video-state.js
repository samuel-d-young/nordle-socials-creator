// The video editor's own state: where the playhead is, what is selected, how far the timeline is zoomed. It lives apart from
// the shared editor state (app/state.js) because the playhead moves sixty times a second while a video plays, and nothing
// else in the app should wake up for that. Parts of the editor listen to the topic they care about.

import { state, shownDoc } from './state.js';
import { totalDuration } from '/src/shared/cutlist.mjs';

export const V = {
  playhead: 0,              // seconds on the timeline (a whole frame when paused)
  playing: false,
  sel: { kind: null, ids: [] }, // kind: 'clip' | 'layer' | 'scene' | 'track'
  fit: true,                // zoom to fit the window
  pps: 80,                  // pixels per second when not fitting
  ripple: true,             // delete closes the gap
  snap: true,
  mode: 'frame',            // monitor: 'frame' | 'cut' | 'source'
  sizeId: null,             // which size the monitor and the preview show
};

const subs = new Map();
const TOPIC = { playhead: 'playhead', playing: 'play', sel: 'sel', fit: 'zoom', pps: 'zoom', ripple: 'flags', snap: 'flags', mode: 'mode', sizeId: 'size' };

export function onV(topic, fn) {
  let set = subs.get(topic);
  if (!set) subs.set(topic, (set = new Set()));
  set.add(fn);
  return () => set.delete(fn);
}
export function emitV(topic) { for (const fn of [...(subs.get(topic) ?? [])]) fn(); }

export function setV(patch) {
  const topics = new Set();
  for (const [k, v] of Object.entries(patch)) {
    if (V[k] === v && k !== 'sel') continue;
    V[k] = v;
    topics.add(TOPIC[k] ?? 'misc');
  }
  for (const t of topics) emitV(t);
}

// ---- time ------------------------------------------------------------------------------------------------------------------

export const doc = () => shownDoc();
export const fpsOf = (d = doc()) => d?.timeline?.fps ?? 30;
const r9 = (v) => Math.round(v * 1e9) / 1e9;
export const toFrames = (t, fps = fpsOf()) => Math.round(t * fps + 1e-9);
export const snapFrame = (t, fps = fpsOf()) => r9(toFrames(t, fps) / fps);
/** How long the video is: the timeline's duration, or the end of the last clip if that is longer. */
export const lengthOf = (d = doc()) => (d?.timeline ? Math.max(d.timeline.duration ?? 0, totalDuration(d)) : 0);

/** 0:03.20 */
export function clock(t) {
  const v = Math.max(0, Number(t) || 0);
  const m = Math.floor(v / 60);
  return `${m}:${(v - m * 60).toFixed(2).padStart(5, '0')}`;
}
export const secs = (t) => `${Number(Number(t).toFixed(2))} s`;

/** Move the playhead (to a whole frame unless `exact`), inside the video. */
export function seek(t, { exact = false } = {}) {
  const d = doc();
  const end = Math.max(0, lengthOf(d) - 1 / fpsOf(d));
  const v = Math.min(Math.max(0, Number(t) || 0), end);
  setV({ playhead: exact ? v : snapFrame(v, fpsOf(d)) });
}

// ---- finding things in the document ---------------------------------------------------------------------------------------

export function clipsOf(d = doc()) {
  const out = [];
  (d?.timeline?.tracks ?? []).forEach((track, ti) => track.clips.forEach((clip, ci) => out.push({ clip, track, ti, ci })));
  return out;
}
export const sourceOf = (d, id) => (d?.sources ?? []).find((s) => s.id === id) ?? null;
export const trackIndex = (d, id) => (d?.timeline?.tracks ?? []).findIndex((t) => t.id === id);
export const layerIndex = (d, id) => (d?.layers ?? []).findIndex((l) => l.id === id);
export const sceneIndex = (d, id) => (d?.timeline?.scenes ?? []).findIndex((s) => s.id === id);

/** What a clip lasts on the timeline. */
export function durationOf(clip, d = doc()) {
  const image = sourceOf(d, clip.source)?.type === 'image';
  return (clip.out - clip.in) / (image ? 1 : clip.speed ?? 1);
}

// ---- selection --------------------------------------------------------------------------------------------------------------

export const selectedClipIds = () => (V.sel.kind === 'clip' ? V.sel.ids : []);
export function select(kind, ids, { add = false } = {}) {
  const list = Array.isArray(ids) ? ids : ids ? [ids] : [];
  if (add && kind === V.sel.kind && kind === 'clip') {
    const cur = new Set(V.sel.ids);
    for (const id of list) { if (cur.has(id)) cur.delete(id); else cur.add(id); }
    setV({ sel: { kind: cur.size ? kind : null, ids: [...cur] } });
    return;
  }
  setV({ sel: { kind: list.length ? kind : null, ids: list } });
}
export const clearSelection = () => select(null, []);

/** The first selected clip (as {clip, track, ti, ci}), or null. */
export function selectedClip(d = doc()) {
  if (V.sel.kind !== 'clip') return null;
  const id = V.sel.ids.at(-1);
  return clipsOf(d).find((c) => c.clip.id === id) ?? null;
}

/** Drop selected things that no longer exist (after an undo, or a cut that removed them). */
export function pruneSelection(d = doc()) {
  if (!V.sel.kind) return;
  const live = new Set(V.sel.kind === 'clip' ? clipsOf(d).map((c) => c.clip.id)
    : V.sel.kind === 'layer' ? (d.layers ?? []).map((l) => l.id)
      : V.sel.kind === 'scene' ? (d.timeline.scenes ?? []).map((s) => s.id)
        : d.timeline.tracks.map((t) => t.id));
  const keep = V.sel.ids.filter((id) => live.has(id));
  if (keep.length !== V.sel.ids.length) select(keep.length ? V.sel.kind : null, keep);
}

// ---- small things the panels share ----------------------------------------------------------------------------------------

export const projectBase = () => `/projects/${state.project}`;
export const videoApi = (path) => `${projectBase()}/video/${path}`;
export const fileUrl = (path) => `/p/${encodeURIComponent(state.project)}/${path.split('/').map(encodeURIComponent).join('/')}`;

/** The sizes a video can be drawn at (a size meant only for pictures is left out). */
export const videoSizes = () => { const all = state.sizes; const v = all.filter((s) => !s.preset || s.preset.kinds?.includes('video')); return v.length ? v : all; };

/** The size (name, shape) the monitor shows: the one chosen, else the first the render would pick. */
export function currentSize() {
  return videoSizes().find((s) => s.id === V.sizeId) ?? videoSizes()[0] ?? { id: 'default', w: 1080, h: 1920 };
}

/** What to send as "size": only when the person chose one (otherwise the server picks the same default). */
export const sizeParam = () => (V.sizeId && videoSizes().some((s) => s.id === V.sizeId) ? V.sizeId : undefined);

export function labelOfClip(clip) { return clip.note ?? clip.id; }

/** Is the user typing in a field? Then the editor's own keys stay out of the way. */
export function typing(target) {
  const t = target;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}
