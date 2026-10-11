// The editing logic of a video timeline: split, trim, move, delete, and "cut by words" (take a part of the recording out, bring it
// back). Pure and browser-safe: no imports, nothing is written, the document you pass in is never changed. Every function returns
// JSON Patch operations (RFC 6902, paths like /timeline/tracks/0/clips/3) that src/shared/ops.mjs applies, with exact inverses.
//
// Times are seconds. Every new cut lands on the document's frame grid (timeline.fps, default 30): the `in` / `out` a cut creates and
// the `at` of a clip you move, split or trim are whole frames, and no clip ever gets a length of zero or less. Clips are moved by
// exact amounts (never re-rounded), so a document whose clips already sit between frames (times typed in milliseconds) stays
// consistent: neighbours still meet exactly, which is what the validator checks. A document made on the grid stays on the grid.
// With a speed other than 1 the `in` / `out` follow the frame-aligned timeline position, so they can fall between frames of the footage.
//
// Model
//   - A "kept range" of a source is a stretch of footage that some clip on a track plays. Cutting words takes a range out of
//     the clips that play it (the clip is shortened, split in two, or removed); bringing it back puts a clip with that range back
//     where it belongs in source order. `coverage` says which parts of a source a track plays.
//   - ripple: later clips on that track close up (or move out of the way). Scenes and overlay layers that sat after the change move
//     by the same amount, so titles stay attached to the speech they belonged to.
//   - Picture and sound that play the same source (another track holding clips of that source) are cut the same way, so they
//     stay in step. Clips of other sources on other tracks are not touched.
//
// Errors are CutError (code + a plain-English message).

export class CutError extends Error {
  /** new CutError({ code, message }) or new CutError(message, code) */
  constructor(arg, code) {
    const o = arg !== null && typeof arg === 'object' ? arg : { message: String(arg), code };
    super(o.message);
    this.name = 'CutError';
    this.code = o.code ?? 'cut';
  }
}

const DEFAULT_FPS = 30;
// Times are kept to nine decimals: clips that meet on a frame then still meet when the validator and the render add them up
// (six decimals can leave a clip a millionth of a second over its neighbour, which the validator calls an overlap).
const r9 = (v) => Math.round(v * 1e9) / 1e9;
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const EPS = 1e-6; // the validator's tolerance when it compares times
const clone = (v) => (v === undefined ? undefined : structuredClone(v));
const fmt = (t) => `${Number(Number(t).toFixed(2))}s`;

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
}

const fpsOf = (doc) => { const f = doc?.timeline?.fps; return Number.isFinite(f) && f > 0 ? f : DEFAULT_FPS; };
/** seconds -> whole frames */
const toF = (t, fps) => Math.round(t * fps + 1e-9);
/** whole frames -> seconds (clean decimals) */
const toS = (f, fps) => r9(f / fps);
const snapT = (t, fps) => toS(toF(t, fps), fps);
const num = (v, what) => { if (!Number.isFinite(Number(v)) || v === null || v === '') throw new CutError({ code: 'bad-time', message: `${what} must be a number of seconds.` }); return Number(v); };

// ---- reading a timeline ------------------------------------------------------------------------------------------------------

const tracksOf = (doc) => doc?.timeline?.tracks ?? [];
const sourceById = (doc, id) => (doc.sources ?? []).find((s) => s.id === id);
const isImage = (doc, clip) => sourceById(doc, clip.source)?.type === 'image';
const speedOf = (doc, clip) => (isImage(doc, clip) ? 1 : clip.speed ?? 1);

function needTimeline(doc) {
  if (!doc?.timeline) throw new CutError({ code: 'no-timeline', message: 'This document has no timeline.' });
}

/** How long a clip lasts on the timeline: (out - in) / speed; a photo ignores speed. Pass the document (or true) for a photo. */
export function clipDuration(clip, docOrIsImage) {
  const image = typeof docOrIsImage === 'boolean' ? docOrIsImage : !!docOrIsImage && isImage(docOrIsImage, clip);
  return (clip.out - clip.in) / (image ? 1 : clip.speed ?? 1);
}

/** The clip's place on the timeline in whole frames, counted the way the render plan counts them. */
function spanF(doc, clip, fps) {
  const startF = toF(clip.at, fps);
  const endF = Math.max(startF + 1, toF(clip.at + clipDuration(clip, doc), fps));
  return { startF, endF, lenF: endF - startF };
}

/** Where a clip sits on the timeline in seconds, exactly as the document says. */
const spanS = (doc, clip) => ({ start: clip.at, end: clip.at + clipDuration(clip, doc) });

/** @returns {{trackIndex:number, clipIndex:number, track:object, clip:object}|null} */
export function findClip(doc, clipId) {
  const tracks = tracksOf(doc);
  for (let trackIndex = 0; trackIndex < tracks.length; trackIndex++) {
    const clipIndex = tracks[trackIndex].clips.findIndex((c) => c.id === clipId);
    if (clipIndex >= 0) return { trackIndex, clipIndex, track: tracks[trackIndex], clip: tracks[trackIndex].clips[clipIndex] };
  }
  return null;
}

function mustFindClip(doc, clipId) {
  needTimeline(doc);
  const ref = findClip(doc, clipId);
  if (!ref) throw new CutError({ code: 'no-clip', message: `There is no clip "${clipId}". Clips: ${tracksOf(doc).flatMap((t) => t.clips.map((c) => c.id)).join(', ') || '(none)'}.` });
  return ref;
}

function trackIndexOf(doc, track) {
  needTimeline(doc);
  const tracks = tracksOf(doc);
  const i = typeof track === 'number' ? track : tracks.findIndex((t) => t.id === track);
  if (!tracks[i]) throw new CutError({ code: 'no-track', message: `There is no track "${track}". Tracks: ${tracks.map((t) => t.id).join(', ')}.` });
  return i;
}

function assertUnlocked(track) {
  if (track.lock) throw new CutError({ code: 'locked', message: `Track "${track.id}" is locked. Unlock it before cutting.` });
}

const clipIds = (doc) => new Set(tracksOf(doc).flatMap((t) => t.clips.map((c) => c.id)));

/** A new clip id next to `base`: base-b, base-c ... base-z, then base-b2 ... Unique in the document, and remembered in `taken`. */
function nextId(taken, base) {
  const letters = 'bcdefghijklmnopqrstuvwxyz';
  for (let n = 1; ; n++) {
    for (const l of letters) {
      const id = `${base}-${l}${n > 1 ? n : ''}`;
      if (!taken.has(id)) { taken.add(id); return id; }
    }
  }
}

/** Seconds the timeline runs: the end of the last clip on any track, rounded up to a whole frame (0 when there are no clips). */
export function totalDuration(doc) {
  const fps = fpsOf(doc);
  let end = 0;
  for (const t of tracksOf(doc)) for (const c of t.clips) end = Math.max(end, c.at + clipDuration(c, doc));
  if (end <= 0) return 0;
  // the stored numbers have nine decimals, so a clip's end can sit a hair past its frame: allow for that, but never end before a clip does
  const frames = Math.ceil(end * fps - 1e-4);
  return end > toS(frames, fps) + EPS ? toS(frames + 1, fps) : toS(frames, fps);
}

const trackEnd = (doc, ti) => {
  let end = 0;
  for (const c of tracksOf(doc)[ti].clips) end = Math.max(end, c.at + clipDuration(c, doc));
  return end;
};

/** The sound/picture source a document is about: the captions' source, else the first source with a transcript that a clip plays. */
export function speechSource(doc) {
  const used = new Set(tracksOf(doc).flatMap((t) => t.clips.map((c) => c.source)));
  const cap = doc?.timeline?.captions?.source;
  if (cap && (doc.sources ?? []).some((s) => s.id === cap && s.transcript)) return cap;
  return (doc.sources ?? []).find((s) => s.transcript && used.has(s.id))?.id ?? null;
}

/** The track that carries a source: the first video track with clips of it, else the first track with clips of it (its id), or null. */
export function defaultTrack(doc, source) {
  const has = (t) => t.clips.some((c) => c.source === source);
  return (tracksOf(doc).find((t) => t.type === 'video' && has(t)) ?? tracksOf(doc).find(has))?.id ?? null;
}

/** How long the footage of a source is, as far as the document knows: its `duration`, or the furthest any clip plays. */
export function sourceEnd(doc, source) {
  let end = sourceById(doc, source)?.duration ?? 0;
  for (const t of tracksOf(doc)) for (const c of t.clips) if (c.source === source) end = Math.max(end, c.out);
  return end;
}

// ---- turning a changed copy into JSON Patch ----------------------------------------------------------------------------------

const esc = (k) => String(k).replace(/~/g, '~0').replace(/\//g, '~1');

function objectOps(path, before, after) {
  const ops = [];
  for (const k of Object.keys(after)) {
    if (!(k in before)) ops.push({ op: 'add', path: `${path}/${esc(k)}`, value: clone(after[k]) });
    else if (!deepEqual(before[k], after[k])) ops.push({ op: 'replace', path: `${path}/${esc(k)}`, value: clone(after[k]) });
  }
  for (const k of Object.keys(before)) if (!(k in after)) ops.push({ op: 'remove', path: `${path}/${esc(k)}` });
  return ops;
}

/** Operations that turn the list `before` into `after`, matching items by id (so a clip that only moved is one `replace`). */
function listOps(path, before, after) {
  const bk = before.map((x) => x.id), ak = after.map((x) => x.id);
  const bSet = new Set(bk), aSet = new Set(ak);
  const sameOrder = bk.filter((k) => aSet.has(k)).join('\u0000') === ak.filter((k) => bSet.has(k)).join('\u0000');
  if (bSet.size !== bk.length || aSet.size !== ak.length || !sameOrder) return [{ op: 'replace', path, value: clone(after) }];
  const ops = [];
  for (let i = before.length - 1; i >= 0; i--) if (!aSet.has(bk[i])) ops.push({ op: 'remove', path: `${path}/${i}` });
  const byId = new Map(before.map((x) => [x.id, x]));
  after.forEach((item, k) => {
    const old = byId.get(item.id);
    if (!old) ops.push({ op: 'add', path: `${path}/${k}`, value: clone(item) });
    else ops.push(...objectOps(`${path}/${k}`, old, item));
  });
  return ops;
}

/** What changed between the document and the working copy, as operations. */
function docOps(doc, work) {
  const ops = [];
  const bt = doc.timeline, wt = work.timeline;
  bt.tracks.forEach((t, i) => {
    if (!deepEqual(t.clips, wt.tracks[i].clips)) ops.push(...listOps(`/timeline/tracks/${i}/clips`, t.clips, wt.tracks[i].clips));
  });
  for (const k of ['duration', 'cover']) {
    if (deepEqual(bt[k], wt[k])) continue;
    if (wt[k] === undefined) ops.push({ op: 'remove', path: `/timeline/${k}` });
    else ops.push({ op: k in bt ? 'replace' : 'add', path: `/timeline/${k}`, value: wt[k] });
  }
  if (!deepEqual(bt.scenes, wt.scenes)) ops.push(...listOps('/timeline/scenes', bt.scenes ?? [], wt.scenes ?? []));
  if (!deepEqual(doc.layers, work.layers)) ops.push(...listOps('/layers', doc.layers ?? [], work.layers ?? []));
  return ops;
}

// ---- keeping the rest of the timeline attached -------------------------------------------------------------------------------

/**
 * How far a time moves because of the edits. cut: {at, len} seconds taken out; insert: {at, len} seconds put in (old times).
 * Something that sits exactly where time is put in follows the speech: a scene's end and a title's start move; a scene start moves
 * only when another scene ends there (the new part joins the earlier scene), a title's end does not (it does not grow).
 */
function shiftOf(t, edits, role) {
  let s = 0;
  for (const e of edits) {
    if (e.kind === 'cut') { s -= r9(Math.min(Math.max(t - e.at, 0), e.len)); continue; }
    const tie = Math.abs(t - e.at) <= 1e-7;
    const after = t > e.at + 1e-7;
    const moves = role === 'scene-end' ? after || tie
      : role === 'scene-start' ? after || (tie && e.joinsEarlier)
        : role === 'layer-end' ? after
          : after || tie; // layer-start, point
    if (moves) s += e.len;
  }
  return r9(s);
}

/**
 * After the clips have been changed in `work`: set the timeline duration, and move scenes, the cover time and overlay layers by
 * the same amount as the edits moved the picture. Duration follows the clips when it matched their end before; if something
 * (such as a music track) still runs longer it stays that long, and a note says so.
 */
function finishTimeline(doc, work, fps, { edits = [], endShift = 0, notes, targetTrack, warnEnd = false }) {
  const wt = work.timeline;
  const d0 = doc.timeline.duration;
  const oldEnd = totalDuration(doc), newEnd = totalDuration(work);
  if (Number.isFinite(d0)) {
    const followsClips = Math.abs(d0 - oldEnd) <= 0.5 / fps + 1e-9;
    let d = followsClips ? newEnd : Math.max(newEnd, r9(d0 + endShift));
    d = Math.max(d, toS(1, fps));
    if (Math.abs(d - d0) > 1e-7) wt.duration = d;
    if (warnEnd && targetTrack !== undefined) {
      const own = trackEnd(work, targetTrack);
      if (wt.duration > own + 0.25) {
        for (const t of work.timeline.tracks.filter((_, i) => i !== targetTrack)) {
          const holder = t.clips.find((c) => c.at + clipDuration(c, work) >= wt.duration - 1 / fps);
          if (holder) { notes.push(`"${holder.id}" on track "${t.id}" runs to ${fmt(wt.duration)}, so the video is still ${fmt(wt.duration)} long. Trim it to close up the end.`); break; }
        }
      }
    }
  }
  const dEnd = wt.duration;
  const moves = edits.length > 0;
  const shrunk = dEnd < d0 - 1e-7;
  for (const e of edits) if (e.kind === 'insert') e.joinsEarlier = (doc.timeline.scenes ?? []).some((sc) => Math.abs(sc.end - e.at) <= 1e-7);
  const move = (t, role) => {
    const v = Math.max(0, t + shiftOf(t, edits, role));
    const f = Math.round(v * fps);
    return Math.abs(v - f / fps) < 1e-7 ? toS(f, fps) : r9(v); // a time that was on a frame stays exactly on it
  };
  if (moves && Number.isFinite(wt.cover)) wt.cover = move(wt.cover, 'point');
  if (wt.scenes && (moves || shrunk)) {
    wt.scenes = wt.scenes.flatMap((sc) => {
      const start = moves ? move(sc.start, 'scene-start') : sc.start;
      let end = moves ? move(sc.end, 'scene-end') : sc.end;
      if (end > dEnd) end = dEnd;
      if (end - start < EPS) return [];
      return start === sc.start && end === sc.end ? [sc] : [{ ...sc, start, end }];
    });
  }
  if (work.layers && (moves || shrunk)) {
    work.layers = work.layers.flatMap((l) => {
      if (!l.time) return [l];
      const start = moves ? move(l.time.start, 'layer-start') : l.time.start;
      let end = moves ? move(l.time.end, 'layer-end') : l.time.end;
      if (end > dEnd) end = dEnd;
      if (end - start < EPS) { notes.push(`The title or shape "${l.id}" sat inside the part that was cut, so it was taken out. (Undo brings it back.)`); return []; }
      return start === l.time.start && end === l.time.end ? [l] : [{ ...l, time: { start, end } }];
    });
  }
}

// ---- motion (zoom and pan) across a split ------------------------------------------------------------------------------------

const EASE = {
  linear: (p) => p,
  in: (p) => p * p,
  out: (p) => 1 - (1 - p) * (1 - p),
  'in-out': (p) => (p < 0.5 ? 4 * p * p * p : 1 - ((2 - 2 * p) ** 3) / 2),
};
const easeAt = (kind, p) => (EASE[kind] ?? EASE.linear)(Math.min(1, Math.max(0, p)));
const zoomEnds = (z) => { const from = z.from ?? 1; return { from, to: z.to ?? (z.from !== undefined ? 1 : from) }; };
const panEnds = (pan, focal) => { const a = pan.from ?? focal ?? { x: 0.5, y: 0.5 }; return { from: a, to: pan.to ?? a }; };

/**
 * A clip cut in two at fraction f of its length: the zoom and pan are divided so the picture does not jump where the two parts
 * meet (the left part ends where the right part begins). A clip with no motion is left alone.
 */
function splitMotion(left, right, f) {
  if (left.zoom) {
    const { from, to } = zoomEnds(left.zoom);
    if (Math.abs(to - from) > 1e-6) {
      const mid = r4(from + (to - from) * easeAt(left.zoom.ease, f));
      right.zoom = { ...left.zoom, from: mid, to };
      left.zoom = { ...left.zoom, from, to: mid };
    }
  }
  if (left.pan) {
    const { from, to } = panEnds(left.pan, left.focal);
    if (Math.abs(to.x - from.x) > 1e-6 || Math.abs(to.y - from.y) > 1e-6) {
      const e = easeAt(left.pan.ease, f);
      const mid = { x: r4(from.x + (to.x - from.x) * e), y: r4(from.y + (to.y - from.y) * e) };
      right.pan = { ...left.pan, from: mid, to };
      left.pan = { ...left.pan, from, to: mid };
    }
  }
}

/** The parts of a clip that belong to its start (how it comes in) are dropped from a piece that does not begin the run. */
function dropHead(c) {
  delete c.transition;
  delete c.note;
  if (c.fade) { delete c.fade.in; if (!Object.keys(c.fade).length) delete c.fade; }
}
function dropTail(c) {
  if (c.fade) { delete c.fade.out; if (!Object.keys(c.fade).length) delete c.fade; }
}

// ---- splitting, trimming, moving, deleting -----------------------------------------------------------------------------------

/**
 * Split a clip at timeline time t (strictly inside it). The original keeps its id and its first part; the new clip is `<id>-b`
 * (then -c ...). Zoom and pan are divided so the motion carries on across the split; a fade in and a transition stay on the first
 * part, a fade out on the last.
 */
export function splitClip(doc, clipId, t) {
  const ref = mustFindClip(doc, clipId);
  assertUnlocked(ref.track);
  const fps = fpsOf(doc);
  const c = ref.clip;
  const { startF, endF } = spanF(doc, c, fps);
  const tF = toF(num(t, 'The split time'), fps);
  if (!(tF > startF && tF < endF)) {
    throw new CutError({ code: 'edge', message: `${fmt(t)} is not inside clip "${c.id}", which runs from ${fmt(startF / fps)} to ${fmt(endF / fps)}. Pick a time strictly between them.` });
  }
  const work = clone(doc);
  const wc = work.timeline.tracks[ref.trackIndex].clips[ref.clipIndex];
  const s = speedOf(doc, c);
  const tS = toS(tF, fps);
  const sp = r9(c.in + (tS - c.at) * s);
  const right = clone(wc);
  right.id = nextId(clipIds(work), c.id);
  right.in = sp;
  right.at = tS; // the first part ends exactly here, so the two meet exactly
  wc.out = sp;
  splitMotion(wc, right, (tS - c.at) / (spanS(doc, c).end - c.at));
  dropHead(right);
  dropTail(wc);
  work.timeline.tracks[ref.trackIndex].clips.splice(ref.clipIndex + 1, 0, right);
  return docOps(doc, work);
}

/** The first of these clips that a clip placed at [start, end) would run into, or null. */
function firstOverlap(doc, others, start, end) {
  for (const o of others) {
    const sp = spanS(doc, o);
    if (sp.start < end - EPS && sp.end > start + EPS) return { clip: o, ...sp };
  }
  return null;
}

const overlapMessage = (c, o, track, start, end) =>
  `"${c.id}" would run from ${fmt(start)} to ${fmt(end)} on track "${track.id}", where "${o.clip.id}" already plays (${fmt(o.start)} to ${fmt(o.end)}). Move it somewhere free, or use ripple so the later clips make room.`;

/**
 * Change which part of the footage a clip plays (`in`, `out`, seconds in the source) and where it starts (`at`). Trimming the head
 * keeps the tail where it was, unless ripple (the clip keeps its start and the later clips on the track shift by the change in
 * length). `sourceDuration` makes it refuse to run past the end of the footage.
 */
export function trimClip(doc, clipId, to = {}, opts = {}) {
  const ref = mustFindClip(doc, clipId);
  assertUnlocked(ref.track);
  const { ripple = false, sourceDuration } = opts;
  const fps = fpsOf(doc);
  const c = ref.clip;
  const image = isImage(doc, c);
  const s = speedOf(doc, c);
  const newIn = to.in !== undefined ? snapT(num(to.in, '"in"'), fps) : c.in;
  const newOut = to.out !== undefined ? snapT(num(to.out, '"out"'), fps) : c.out;
  if (newIn < 0) throw new CutError({ code: 'before-footage', message: `"${c.id}" cannot start before the beginning of the footage (in ${fmt(newIn)}).` });
  if (!(newOut > newIn)) throw new CutError({ code: 'empty', message: `"${c.id}" would be empty: out (${fmt(newOut)}) must be after in (${fmt(newIn)}).` });
  const newDur = (newOut - newIn) / s;
  if (toF(newDur, fps) < 1) throw new CutError({ code: 'too-short', message: `"${c.id}" would be shorter than one frame.` });
  if (sourceDuration !== undefined && !image && newOut > sourceDuration + 0.5 / fps) {
    throw new CutError({ code: 'past-footage', message: `"${c.id}" cannot run to ${fmt(newOut)}: the footage is only ${fmt(sourceDuration)} long.` });
  }
  const { start: start0, end: end0 } = spanS(doc, c);
  const inChanged = newIn !== c.in, outChanged = newOut !== c.out;
  let newStart = start0;
  if (to.at !== undefined) newStart = snapT(num(to.at, '"at"'), fps);
  else if (inChanged && !ripple) newStart = r9(outChanged ? start0 + (newIn - c.in) / s : end0 - newDur); // the tail stays put
  const newEnd = r9(newStart + newDur);
  if (newStart < -EPS) throw new CutError({ code: 'before-start', message: `"${c.id}" would start before the beginning of the timeline. Trim less, or move the clips after it first.` });
  if (Math.abs(newStart - start0) < 1e-7 && Math.abs(newEnd - end0) < 1e-7 && !inChanged && !outChanged) return [];

  const others = ref.track.clips.filter((o) => o !== c);
  const later = ripple ? others.filter((o) => o.at >= end0 - EPS) : [];
  const hit = firstOverlap(doc, others.filter((o) => !later.includes(o)), newStart, newEnd);
  if (hit) throw new CutError({ code: 'overlap', message: overlapMessage(c, hit, ref.track, newStart, newEnd) });

  const work = clone(doc);
  const wTrack = work.timeline.tracks[ref.trackIndex];
  const wc = wTrack.clips[ref.clipIndex];
  wc.in = newIn; wc.out = newOut; wc.at = newStart;
  const delta = r9(newEnd - end0);
  const edits = [];
  if (ripple && Math.abs(delta) > 1e-9) {
    for (const o of later) { const w = wTrack.clips.find((x) => x.id === o.id); w.at = r9(o.at + delta); }
    edits.push(delta < 0 ? { kind: 'cut', at: newEnd, len: -delta } : { kind: 'insert', at: end0, len: delta });
  }
  finishTimeline(doc, work, fps, { edits, endShift: ripple ? delta : 0, notes: [] });
  return docOps(doc, work);
}

/**
 * Move a clip to timeline time `at`. Without ripple it must land in free space (otherwise a CutError, code "overlap"). With
 * ripple the clips that start at or after the new place are pushed later to make room.
 */
export function moveClip(doc, clipId, at, opts = {}) {
  const ref = mustFindClip(doc, clipId);
  assertUnlocked(ref.track);
  const { ripple = false } = opts;
  const fps = fpsOf(doc);
  const c = ref.clip;
  const { start: start0, end: end0 } = spanS(doc, c);
  const dur = end0 - start0;
  const newStart = snapT(num(at, 'The new time'), fps);
  if (newStart < -EPS) throw new CutError({ code: 'before-start', message: `"${c.id}" cannot start before the beginning of the timeline.` });
  if (Math.abs(newStart - start0) < 1e-7) return [];
  const newEnd = r9(newStart + dur);
  const others = ref.track.clips.filter((o) => o !== c);
  let push = 0;
  let pushed = [];
  if (!ripple) {
    const hit = firstOverlap(doc, others, newStart, newEnd);
    if (hit) throw new CutError({ code: 'overlap', message: overlapMessage(c, hit, ref.track, newStart, newEnd) });
  } else {
    const blocking = others.map((o) => ({ clip: o, ...spanS(doc, o) })).find((o) => o.start < newStart - EPS && o.end > newStart + EPS);
    if (blocking) throw new CutError({ code: 'overlap', message: `"${c.id}" cannot start at ${fmt(newStart)}: "${blocking.clip.id}" is playing there (${fmt(blocking.start)} to ${fmt(blocking.end)}) and starts earlier, so it cannot be pushed out of the way.` });
    pushed = others.filter((o) => o.at >= newStart - EPS);
    if (pushed.length) push = Math.max(0, r9(newEnd - Math.min(...pushed.map((o) => o.at))));
  }
  const work = clone(doc);
  const wTrack = work.timeline.tracks[ref.trackIndex];
  wTrack.clips[ref.clipIndex].at = newStart;
  const edits = [];
  if (push > 1e-9) {
    for (const o of pushed) wTrack.clips.find((x) => x.id === o.id).at = r9(o.at + push);
    edits.push({ kind: 'insert', at: Math.min(...pushed.map((o) => o.at)), len: push });
  }
  finishTimeline(doc, work, fps, { edits, endShift: push, notes: [] });
  return docOps(doc, work);
}

/** Remove a clip. With ripple (the default) the later clips on that track move earlier by its length, closing the gap. */
export function deleteClip(doc, clipId, opts = {}) {
  const ref = mustFindClip(doc, clipId);
  assertUnlocked(ref.track);
  const { ripple = true } = opts;
  const fps = fpsOf(doc);
  const { start, end } = spanS(doc, ref.clip);
  const len = r9(end - start);
  const work = clone(doc);
  const wTrack = work.timeline.tracks[ref.trackIndex];
  wTrack.clips.splice(ref.clipIndex, 1);
  const edits = [];
  if (ripple) {
    for (const o of ref.track.clips) {
      if (o !== ref.clip && o.at >= end - EPS) wTrack.clips.find((x) => x.id === o.id).at = r9(o.at - len);
    }
    edits.push({ kind: 'cut', at: start, len });
  }
  finishTimeline(doc, work, fps, { edits, endShift: ripple ? -len : 0, notes: [] });
  return docOps(doc, work);
}

// ---- what a track plays ------------------------------------------------------------------------------------------------------

/** Detailed coverage: one entry per clip piece, sorted by source time, merged where adjacent and continuous (both in source and timeline). */
function coverageDetail(doc, track, source) {
  const fps = fpsOf(doc);
  const ti = trackIndexOf(doc, track);
  const eps = 0.5 / fps;
  const parts = tracksOf(doc)[ti].clips
    .filter((c) => c.source === source && !isImage(doc, c))
    .map((c) => ({ from: c.in, to: c.out, clipId: c.id, at: c.at, speed: speedOf(doc, c), ...spanF(doc, c, fps) }))
    .sort((a, b) => a.from - b.from || a.at - b.at);
  const merged = [];
  for (const p of parts) {
    const last = merged.at(-1);
    if (last && Math.abs(p.from - last.to) <= eps && p.startF === last.endF && p.speed === last.speed) {
      last.to = p.to; last.endF = p.endF; last.clipIds.push(p.clipId);
    } else merged.push({ ...p, clipIds: [p.clipId] });
  }
  return merged;
}

/**
 * Which parts of a SOURCE (source seconds) the track plays, sorted, merged where adjacent and continuous in both source and timeline.
 * @returns {{from:number, to:number, clipId:string, at:number}[]} clipId and `at` (timeline seconds) are those of the first clip of the stretch
 */
export function coverage(doc, { track, source }) {
  needTimeline(doc);
  return coverageDetail(doc, track ?? defaultTrack(doc, source), source).map((e) => ({ from: e.from, to: e.to, clipId: e.clipId, at: e.at }));
}

/** The source ranges a track plays, as one sorted list with overlaps and touching ends merged (timeline position ignored). */
function playedUnion(doc, ti, source, fps) {
  const eps = 0.5 / fps;
  const spans = tracksOf(doc)[ti].clips.filter((c) => c.source === source && !isImage(doc, c)).map((c) => [c.in, c.out]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [f, t] of spans) {
    const last = out.at(-1);
    if (last && f <= last[1] + eps) last[1] = Math.max(last[1], t); else out.push([f, t]);
  }
  return out;
}

// ---- cutting a range of a source out of a track -----------------------------------------------------------------------------

/** The tracks other than `ti` that play the same source: their clips are cut the same way so they stay in step. */
const linkedTracks = (doc, ti, source) => tracksOf(doc).map((t, i) => (i !== ti && t.clips.some((c) => c.source === source) ? i : -1)).filter((i) => i >= 0);

function removeFromTrack(ctx, ti, a, b) {
  const { doc, work, fps, ripple, taken, source } = ctx;
  const orig = doc.timeline.tracks[ti].clips;
  const track = work.timeline.tracks[ti];
  const plans = orig.map((c) => {
    if (c.source !== source || isImage(doc, c)) return null;
    const s = c.speed ?? 1;
    let lo = Math.max(a, c.in), hi = Math.min(b, c.out);
    if (!(hi > lo) || toF((hi - lo) / s, fps) < 1) return null; // nothing of this clip is in the range (or less than half a frame)
    const hasL = toF((lo - c.in) / s, fps) >= 1, hasR = toF((c.out - hi) / s, fps) >= 1;
    if (!hasL) lo = c.in; // a sliver of less than half a frame before the cut goes with it
    if (!hasR) hi = c.out;
    return { s, lo, hi, hasL, hasR, atCut: c.at + (lo - c.in) / s, len: (hi - lo) / s };
  });
  const cuts = plans.filter(Boolean).map((p) => ({ at: p.atCut, len: p.len })).sort((x, y) => x.at - y.at);
  if (!cuts.length) return { cuts, removed: 0 };
  const shiftBefore = (p) => (ripple ? cuts.reduce((acc, e) => acc + Math.min(Math.max(p - e.at, 0), e.len), 0) : 0);
  const next = [];
  track.clips.forEach((c, idx) => {
    const pl = plans[idx];
    const at0 = orig[idx].at;
    if (!pl) {
      const sh = shiftBefore(at0);
      if (sh > 1e-9) c.at = r9(at0 - sh);
      next.push(c);
      return;
    }
    if (!pl.hasL && !pl.hasR) return; // the whole clip was inside the range
    const right = pl.hasL && pl.hasR ? clone(c) : null;
    const rightAt = at0 + (pl.hi - orig[idx].in) / pl.s; // where the part after the cut starts if nothing closes up
    if (pl.hasL) { c.out = r9(pl.lo); const sh = shiftBefore(at0); if (sh > 1e-9) c.at = r9(at0 - sh); }
    if (right) {
      right.id = nextId(taken, c.id);
      right.in = r9(pl.hi);
      right.at = r9(rightAt - shiftBefore(rightAt));
      splitMotion(c, right, (pl.lo - orig[idx].in) / ((pl.lo - orig[idx].in) + (orig[idx].out - pl.hi)));
      dropHead(right);
      dropTail(c);
      next.push(c, right);
    } else if (pl.hasR) {
      c.in = r9(pl.hi);
      c.at = r9(rightAt - shiftBefore(rightAt));
      next.push(c);
    } else next.push(c);
  });
  track.clips = next;
  return { cuts, removed: r9(cuts.reduce((acc, e) => acc + e.len, 0)) };
}

/**
 * Take a range of a source (source seconds from..to) out of the clips of one track that play it, and out of the clips of any other
 * track that plays the same source (so picture and sound stay together). Clips are shortened, split in two or removed. With ripple
 * (the default) the track closes up; scenes and layers after the cut move earlier by the same amount.
 * @returns {{ops:object[], removed:number, notes:string[]}} removed = seconds taken off the track
 */
export function removeSourceRangeInfo(doc, { track, source, from, to }, opts = {}) {
  const { ripple = true } = opts;
  needTimeline(doc);
  const fps = fpsOf(doc);
  const ti = trackIndexOf(doc, track ?? defaultTrack(doc, source));
  const a = snapT(num(from, '"from"'), fps), b = snapT(num(to, '"to"'), fps);
  if (b < a) throw new CutError({ code: 'bad-range', message: `The range ${fmt(from)} to ${fmt(to)} runs backwards.` });
  const tr = tracksOf(doc)[ti];
  if (!tr.clips.some((c) => c.source === source)) throw new CutError({ code: 'no-source', message: `Track "${tr.id}" has no clips of source "${source}". Its sources: ${[...new Set(tr.clips.map((c) => c.source))].join(', ') || '(none)'}.` });
  if (b === a) return { ops: [], removed: 0, notes: [] };
  const linked = linkedTracks(doc, ti, source);
  for (const i of [ti, ...linked]) assertUnlocked(tracksOf(doc)[i]);
  const work = clone(doc);
  const ctx = { doc, work, fps, ripple, taken: clipIds(work), source };
  const main = removeFromTrack(ctx, ti, a, b);
  if (main.cuts.length && !work.timeline.tracks[ti].clips.some((c) => c.source === source)) {
    // an empty track cannot be brought back from: nothing is left to copy the look of, or to say where the pieces go
    throw new CutError({ code: 'everything', message: `That would cut out everything of "${source}" on track "${tr.id}" (${fmt(from)} to ${fmt(to)}). Keep at least some of it, or delete the clips if you want the track empty.` });
  }
  const others = linked.map((i) => removeFromTrack(ctx, i, a, b));
  if (!main.cuts.length && !others.some((o) => o.cuts.length)) return { ops: [], removed: 0, notes: [] };
  const removed = main.removed || Math.max(0, ...others.map((o) => o.removed));
  const notes = [];
  finishTimeline(doc, work, fps, {
    edits: ripple ? main.cuts.map((e) => ({ kind: 'cut', ...e })) : [], endShift: ripple ? -main.removed : 0, notes, targetTrack: ti, warnEnd: true,
  });
  return { ops: docOps(doc, work), removed, notes };
}

export function removeSourceRange(doc, range, opts) { return removeSourceRangeInfo(doc, range, opts).ops; }

// ---- bringing a range back ---------------------------------------------------------------------------------------------------

/** zoom and pan that hold the framing of the neighbouring clip at the place where the restored clip joins it. */
function heldFraming(template, atEnd) {
  const out = {};
  if (template.zoom) {
    const { from, to } = zoomEnds(template.zoom);
    const v = atEnd ? to : from;
    if (Math.abs(v - 1) > 1e-6) out.zoom = { from: v, to: v };
  }
  if (template.pan) {
    const { from, to } = panEnds(template.pan, template.focal);
    const v = clone(atEnd ? to : from);
    out.pan = { from: v, to: clone(v) };
  }
  return out;
}

function restoreOnTrack(ctx, ti, a, b) {
  const { doc, work, fps, ripple, taken, source } = ctx;
  const orig = doc.timeline.tracks[ti].clips;
  const track = work.timeline.tracks[ti];
  const played = playedUnion(doc, ti, source, fps);
  // the parts of a..b this track does not play
  const gaps = [];
  let cur = a;
  for (const [f, t] of played) {
    if (t <= cur + 1e-7) continue;
    if (f >= b - 1e-7) break;
    if (f > cur + 1e-7) gaps.push([cur, f]);
    cur = Math.max(cur, t);
  }
  if (cur < b - 1e-7) gaps.push([cur, b]);
  const mine = orig.filter((c) => c.source === source && !isImage(doc, c)).map((c) => ({ clip: c, ...spanS(doc, c) }));
  const trackEndS = Math.max(0, ...orig.map((c) => c.at + clipDuration(c, doc)));
  const inserts = [];
  for (const [ga, gb] of gaps) {
    const prev = mine.filter((e) => e.clip.out <= ga + 1e-7).sort((x, y) => y.clip.out - x.clip.out || y.start - x.start)[0];
    const nextC = mine.filter((e) => e.clip.in >= gb - 1e-7).sort((x, y) => x.clip.in - y.clip.in || x.start - y.start)[0];
    const template = (prev ?? nextC)?.clip ?? null; // every clip of the source lies wholly before or after an uncovered gap, so one exists
    const s = template ? speedOf(doc, template) : 1;
    const len = r9((gb - ga) / s);
    if (toF(len, fps) < 1) continue;
    let p;
    if (ripple) p = prev ? prev.end : nextC ? nextC.start : trackEndS;
    else if (prev) p = prev.clip.at + (ga - prev.clip.in) / s;
    else if (nextC) p = nextC.clip.at - (nextC.clip.in - ga) / s;
    else p = trackEndS;
    p = r9(p);
    if (p < -EPS) throw new CutError({ code: 'before-start', message: `There is no room before the start of the timeline to bring back ${fmt(ga)} to ${fmt(gb)} of "${source}" without ripple.` });
    const clip = { id: '', source, in: r9(ga), out: r9(gb), at: 0 };
    if (template) {
      for (const k of ['speed', 'fit', 'focal', 'grade', 'denoise', 'cleanAudio', 'gainDb', 'mute', 'duck']) if (template[k] !== undefined) clip[k] = clone(template[k]);
      Object.assign(clip, heldFraming(template, !!prev));
    }
    inserts.push({ p, len, ga, clip, baseId: template?.id ?? source });
  }
  if (!inserts.length) return { inserts, added: 0 };
  inserts.sort((x, y) => x.p - y.p || x.ga - y.ga);
  let before = 0;
  for (const ins of inserts) {
    ins.newStart = r9(ripple ? ins.p + before : ins.p);
    before = r9(before + ins.len);
    ins.clip.id = nextId(taken, ins.baseId);
    ins.clip.at = ins.newStart;
  }
  if (ripple) {
    track.clips.forEach((c, idx) => {
      const at0 = orig[idx].at;
      const sh = inserts.reduce((acc, e) => acc + (e.p <= at0 + 1e-7 ? e.len : 0), 0);
      if (sh) c.at = r9(at0 + sh);
    });
  } else {
    const all = [...orig.map((c) => ({ id: c.id, ...spanS(doc, c) })), ...inserts.map((e) => ({ id: e.clip.id, start: e.newStart, end: e.newStart + e.len }))];
    for (const ins of inserts) {
      const hit = all.find((o) => o.id !== ins.clip.id && o.start < ins.newStart + ins.len - EPS && o.end > ins.newStart + EPS);
      if (hit) {
        throw new CutError({ code: 'overlap', message: `There is no room to bring back ${fmt(ins.ga)} to ${fmt(ins.clip.out)} of "${source}" on track "${doc.timeline.tracks[ti].id}": it would run from ${fmt(ins.newStart)} into "${hit.id}". Use ripple so the later clips move out of the way.` });
      }
    }
  }
  for (const ins of inserts) {
    // placed right after the last clip that starts before it (on the new timeline)
    let idx = 0;
    track.clips.forEach((c, i) => { if (c.at < ins.newStart - EPS) idx = i + 1; });
    track.clips.splice(idx, 0, ins.clip);
  }
  return { inserts, added: r9(inserts.reduce((acc, e) => acc + e.len, 0)) };
}

/**
 * "Bring back": put a range of a source (source seconds from..to) back onto a track where it belongs in source order, as new clips
 * that copy the neighbouring clip's settings (the zoom and pan hold where the neighbour left off, so the motion does not restart).
 * With ripple (the default) the later clips move later. Restoring a range that is already kept changes nothing. Other tracks that
 * play the same source get the same range back.
 * @returns {{ops:object[], restored:number, notes:string[]}} restored = seconds put back on the track
 */
export function restoreSourceRangeInfo(doc, { track, source, from, to }, opts = {}) {
  const { ripple = true } = opts;
  needTimeline(doc);
  const fps = fpsOf(doc);
  const ti = trackIndexOf(doc, track ?? defaultTrack(doc, source));
  const a = snapT(num(from, '"from"'), fps);
  let b = snapT(num(to, '"to"'), fps);
  if (b < a) throw new CutError({ code: 'bad-range', message: `The range ${fmt(from)} to ${fmt(to)} runs backwards.` });
  const footage = sourceById(doc, source)?.duration;
  if (footage && b > footage) b = footage; // never further than the footage goes (its last frame may not be on the grid)
  const tr = tracksOf(doc)[ti];
  if (!tr.clips.some((c) => c.source === source)) throw new CutError({ code: 'no-source', message: `Track "${tr.id}" has no clips of source "${source}", so there is nothing to copy the look of. Add a clip of it first.` });
  if (b <= a) return { ops: [], restored: 0, notes: [] };
  const linked = linkedTracks(doc, ti, source);
  for (const i of [ti, ...linked]) assertUnlocked(tracksOf(doc)[i]);
  const work = clone(doc);
  const ctx = { doc, work, fps, ripple, taken: clipIds(work), source };
  const main = restoreOnTrack(ctx, ti, a, b);
  const others = linked.map((i) => restoreOnTrack(ctx, i, a, b));
  if (!main.inserts.length && !others.some((o) => o.inserts.length)) return { ops: [], restored: 0, notes: [] };
  const notes = [];
  finishTimeline(doc, work, fps, {
    edits: ripple ? main.inserts.map((e) => ({ kind: 'insert', at: e.p, len: e.len })) : [], endShift: ripple ? main.added : 0, notes,
  });
  return { ops: docOps(doc, work), restored: main.added || Math.max(0, ...others.map((o) => o.added)), notes };
}

export function restoreSourceRange(doc, range, opts) { return restoreSourceRangeInfo(doc, range, opts).ops; }

// ---- words -------------------------------------------------------------------------------------------------------------------

/**
 * Every word with whether the track still plays it (the whole word inside what is played) and where on the timeline.
 * @param {{text:string,start:number,end:number}[]} words in the format src/video/words.mjs loads
 * @returns {{i:number, text:string, start:number, end:number, kept:boolean, at:number|null}[]}
 */
export function wordStates(doc, { track, source }, words) {
  needTimeline(doc);
  const fps = fpsOf(doc);
  const cov = coverageDetail(doc, track ?? defaultTrack(doc, source), source);
  const eps = 0.5 / fps + 1e-6;
  return words.map((w, i) => {
    const e = cov.find((x) => x.from - eps <= w.start && w.end <= x.to + eps);
    return { i, text: w.text, start: w.start, end: w.end, kept: !!e, at: e ? r9(e.at + (Math.max(w.start, e.from) - e.from) / e.speed) : null };
  });
}

// (times have six decimals in a transcript, so a value a hair past a frame is that frame: the 1e-4 of a frame allows for it)
const ceilFrame = (t, fps) => toS(Math.ceil(t * fps - 1e-4), fps);

/** A time inside the silence [lo, hi], as close to `target` as a whole frame allows (the middle if no whole frame fits). */
function frameInside(target, lo, hi, fps) {
  const first = Math.ceil(lo * fps - 1e-4), last = Math.floor(hi * fps + 1e-4);
  if (first <= last) return toS(Math.min(last, Math.max(first, Math.round(target * fps))), fps);
  return toS(Math.round(((lo + hi) / 2) * fps), fps);
}

function snapRange(words, i, j, { fps, maxPad, start = 0, end }) {
  const first = words[i], last = words[j], prev = words[i - 1], next = words[j + 1];
  let from = start;
  let to;
  if (prev) {
    const gap = Math.max(0, first.start - prev.end);
    from = frameInside(prev.end + Math.min(maxPad, gap / 2), prev.end, first.start, fps);
  }
  if (next) {
    const gap = Math.max(0, next.start - last.end);
    to = frameInside(next.start - Math.min(maxPad, gap / 2), last.end, next.start, fps);
  } else to = ceilFrame(end !== undefined ? Math.max(end, last.end) : last.end + maxPad, fps);
  return { from, to };
}

/**
 * Turn a selection of words (from = the start of the first word, to = the end of the last) into cut points that never cut a word:
 * the cut starts in the silence AFTER the previous word (at most maxPad after it ends, else the middle of the gap) and ends in the
 * silence BEFORE the next word, both on whole frames. At the very start of the recording the cut begins at `start` (default 0); at
 * the very end it runs to `end` (the length of the footage) when you pass it, else maxPad past the last word.
 * @returns {{from:number, to:number}} seconds in the source
 */
export function snapCut(words, from, to, opts = {}) {
  const { fps = DEFAULT_FPS, maxPad = 0.12, start = 0, end } = opts;
  if (!words?.length) throw new CutError({ code: 'no-words', message: 'There are no words to cut.' });
  const eps = 1e-6;
  const hit = (w) => (w.start < to - eps && w.end > from + eps) || (w.start >= from - eps && w.end <= to + eps);
  let i = words.findIndex(hit);
  let j = -1;
  for (let k = words.length - 1; k >= 0; k--) if (hit(words[k])) { j = k; break; }
  if (i < 0) {
    // the selection holds no word: it is already silence, so just put it between the neighbours
    i = words.findIndex((w) => w.start >= to - eps);
    if (i < 0) return { from: frameInside(from, words.at(-1).end, Math.max(to, words.at(-1).end), fps), to: ceilFrame(end ?? Math.max(to, words.at(-1).end + maxPad), fps) };
    const prev = words[i - 1];
    const lo = prev ? prev.end : start;
    return { from: frameInside(from, lo, words[i].start, fps), to: frameInside(to, lo, words[i].start, fps) };
  }
  return snapRange(words, i, j, { fps, maxPad, start, end });
}

function wordRange(doc, words, i, j, opts) {
  if (!Number.isInteger(i) || !Number.isInteger(j) || i < 0 || j < i || j >= words.length) {
    throw new CutError({ code: 'bad-range', message: `Words ${i} to ${j} are not in this transcript. It has ${words.length} words, numbered 0 to ${words.length - 1}.` });
  }
  return snapRange(words, i, j, { fps: opts.fps ?? fpsOf(doc), maxPad: opts.maxPad ?? 0.12, start: 0, end: opts.end });
}

/** Cut words i..j (inclusive) out of the track: the cut points never touch a word. Also tells which source range was cut. */
export function removeWordsInfo(doc, { track, source }, words, i, j, opts = {}) {
  const { from, to } = wordRange(doc, words, i, j, { ...opts, end: opts.end ?? (sourceEnd(doc, source) || undefined) });
  const r = removeSourceRangeInfo(doc, { track, source, from, to }, opts);
  return { ...r, from, to };
}
export function removeWords(doc, ref, words, i, j, opts) { return removeWordsInfo(doc, ref, words, i, j, opts).ops; }

/**
 * Bring words i..j (inclusive) back, with the quiet around them. (Cutting the last words takes the quiet to the end of the footage
 * with them; bringing them back restores only a short quiet after the last word, not all of that.)
 */
export function restoreWordsInfo(doc, { track, source }, words, i, j, opts = {}) {
  const { from, to } = wordRange(doc, words, i, j, opts);
  const r = restoreSourceRangeInfo(doc, { track, source, from, to }, opts);
  return { ...r, from, to };
}
export function restoreWords(doc, ref, words, i, j, opts) { return restoreWordsInfo(doc, ref, words, i, j, opts).ops; }

/**
 * The transcript as readable lines: a line ends at a full stop or a pause. kept is "all", "some" or "none".
 * @returns {{i:number, j:number, text:string, start:number, end:number, kept:'all'|'some'|'none', at:number|null}[]}
 */
export function transcriptLines(states, { gap = 0.7 } = {}) {
  const lines = [];
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    const kept = cur.filter((w) => w.kept).length;
    lines.push({
      i: cur[0].i, j: cur.at(-1).i, text: cur.map((w) => w.text).join(' '), start: cur[0].start, end: cur.at(-1).end,
      kept: kept === cur.length ? 'all' : kept === 0 ? 'none' : 'some', at: cur.find((w) => w.kept)?.at ?? null,
    });
    cur = [];
  };
  states.forEach((w, k) => {
    cur.push(w);
    const ends = /[.!?…]["')\]]*$/.test(w.text.trim());
    const pause = states[k + 1] && states[k + 1].start - w.end > gap;
    if (ends || pause) flush();
  });
  flush();
  return lines;
}
