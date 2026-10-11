// The cut list: split, trim, move, delete, cutting a range of a source out and bringing it back, cutting by words, snapping cuts to
// silence. Pure logic, no ffmpeg: every result is applied with the editor's own JSON Patch and checked for the things that must
// always hold (whole frames, no overlaps, no empty clips, unique ids, scenes and titles inside the video, a document the validator accepts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ROOT, readJson, validateDocData } from '../tools/validate.mjs';
import { applyOps } from '../src/shared/ops.mjs';
import {
  CutError, clipDuration, coverage, defaultTrack, deleteClip, findClip, moveClip, removeSourceRange, removeSourceRangeInfo, removeWords, removeWordsInfo,
  restoreSourceRange, restoreSourceRangeInfo, restoreWords, snapCut, speechSource, splitClip, totalDuration, transcriptLines, trimClip, wordStates,
} from '../src/shared/cutlist.mjs';

const SAMPLE = join(ROOT, 'samples', 'little-gannet');
const brand = readJson(join(SAMPLE, 'brand.json'));
const platforms = readJson(join(ROOT, 'data', 'platforms.json'));

const SOURCES = [
  { id: 'talk', type: 'video', path: 'mount:footage/talk.mp4', duration: 60 },
  { id: 'broll', type: 'video', path: 'mount:footage/broll.mp4', duration: 20 },
  { id: 'mic', type: 'audio', path: 'mount:footage/mic.wav', duration: 60 },
  { id: 'music', type: 'audio', path: 'mount:footage/music.wav', duration: 120 },
  { id: 'photo', type: 'image', path: 'assets/photo.jpg' },
];
const TITLE = { id: 'title', type: 'text', text: 'Hello', time: { start: 7, end: 9 }, layout: { anchor: 'top-left', x: 8, y: 20, w: 70 }, style: { font: '$brand.fonts.display', size: 90, color: '$brand.colors.paper' } };

const base = (timeline, extra = {}) => ({ schema: 'nordle.doc/0.1', id: 'cutdoc', title: 'Cut test', kind: 'video', brand: 'little-gannet', sizes: ['ig-reel-9x16'], sources: structuredClone(SOURCES), timeline, ...extra });

/** Two spoken clips with a stretch of the recording already cut out between them, a picture-only copy on a third track, a cutaway, scenes and a title. */
function talking({ bed = false } = {}) {
  const tracks = [
    { id: 'v1', type: 'video', clips: [
      { id: 'a', source: 'talk', in: 0, out: 6, at: 0, zoom: { from: 1, to: 1.2 }, focal: { x: 0.4, y: 0.5 }, grade: 'warm', fade: { in: 0.2 } },
      { id: 'b', source: 'talk', in: 8, out: 14, at: 6, transition: { type: 'fade', duration: 0.3 }, fade: { out: 0.4 } },
    ] },
    { id: 'v2', type: 'video', clips: [{ id: 'cut1', source: 'broll', in: 0, out: 2, at: 3, mute: true }] },
    { id: 'v3', type: 'video', clips: [
      { id: 'a3', source: 'talk', in: 0, out: 6, at: 0, mute: true },
      { id: 'b3', source: 'talk', in: 8, out: 14, at: 6, mute: true },
    ] },
  ];
  if (bed) tracks.push({ id: 'bed', type: 'audio', clips: [{ id: 'bed', source: 'music', in: 0, out: 12, at: 0, gainDb: -10 }] });
  return base({ fps: 30, duration: 12, tracks, scenes: [{ id: 'hook', title: 'Hook', start: 0, end: 4 }, { id: 'rest', title: 'Rest', start: 4, end: 12 }] }, { layers: [structuredClone(TITLE)] });
}

const apply = (doc, ops) => applyOps(doc, ops).doc;
const near = (a, b, tol = 1e-5, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} expected ${b}, got ${a}`);
const clipsOf = (doc, trackId) => doc.timeline.tracks.find((t) => t.id === trackId).clips;
const cov = (doc, track, source = 'talk') => coverage(doc, { track, source }).map((e) => ({ from: e.from, to: e.to, at: e.at }));
const COVER = (doc, track, source) => cov(doc, track, source);

/** What must hold for any timeline this module produces. */
function check(doc, label = '') {
  const fps = doc.timeline.fps;
  const grid = (x, what) => assert.ok(Math.abs(x * fps - Math.round(x * fps)) < 1e-4, `${label}: ${what} ${x} is not on a frame`);
  const ids = new Set();
  const dur = doc.timeline.duration;
  for (const track of doc.timeline.tracks) {
    const spans = [];
    for (const c of track.clips) {
      assert.ok(!ids.has(c.id), `${label}: duplicate clip id ${c.id}`);
      ids.add(c.id);
      assert.ok(c.out > c.in, `${label}: ${c.id} is empty`);
      grid(c.at, `${c.id}.at`);
      if ((c.speed ?? 1) === 1) { grid(c.in, `${c.id}.in`); grid(c.out, `${c.id}.out`); }
      const startF = Math.round(c.at * fps);
      const endF = Math.max(startF + 1, Math.round((c.at + clipDuration(c, doc)) * fps));
      assert.ok(endF - startF >= 1, `${label}: ${c.id} is shorter than a frame`);
      assert.ok(c.at + clipDuration(c, doc) <= dur + 1e-6, `${label}: ${c.id} runs past the end (${c.at + clipDuration(c, doc)} > ${dur})`);
      spans.push({ id: c.id, startF, endF });
    }
    spans.sort((x, y) => x.startF - y.startF);
    for (let k = 1; k < spans.length; k++) assert.ok(spans[k].startF >= spans[k - 1].endF, `${label}: ${spans[k - 1].id} and ${spans[k].id} overlap on ${track.id}`);
  }
  for (const s of doc.timeline.scenes ?? []) assert.ok(s.start >= 0 && s.end > s.start && s.end <= dur + 1e-6, `${label}: scene ${s.id} ${s.start}-${s.end} (video ${dur})`);
  for (const l of doc.layers ?? []) if (l.time) assert.ok(l.time.start >= 0 && l.time.end > l.time.start && l.time.end <= dur + 1e-6, `${label}: layer ${l.id} ${l.time.start}-${l.time.end}`);
  const errors = validateDocData(doc, { brand, projectDir: SAMPLE, platforms, assets: false }).filter((i) => i.level === 'error');
  assert.deepEqual(errors, [], `${label}: the validator rejects it`);
}

/** Run a change: the input is never modified, the result is a valid document. */
function run(doc, ops, label) {
  const frozen = structuredClone(doc);
  const out = apply(doc, ops);
  assert.deepEqual(doc, frozen, 'the original document must not be changed');
  check(out, label);
  return out;
}
const mustThrow = (fn, code, pattern) => assert.throws(fn, (e) => e instanceof CutError && e.code === code && (!pattern || pattern.test(e.message)), `expected CutError ${code}`);

// ---------------------------------------------------------------------------------------------------------------------------------
// reading

test('clipDuration: speed divides, a photo ignores speed; findClip finds a clip on any track', () => {
  assert.equal(clipDuration({ in: 2, out: 8 }), 6);
  assert.equal(clipDuration({ in: 2, out: 8, speed: 2 }), 3);
  assert.equal(clipDuration({ source: 'photo', in: 0, out: 3, speed: 2 }, base({ fps: 30, duration: 3, tracks: [] })), 3);
  assert.equal(clipDuration({ in: 0, out: 3, speed: 2 }, true), 3);
  const doc = talking();
  const f = findClip(doc, 'b3');
  assert.equal(f.trackIndex, 2); assert.equal(f.clipIndex, 1); assert.equal(f.track.id, 'v3'); assert.equal(f.clip.id, 'b3');
  assert.equal(findClip(doc, 'nope'), null);
  assert.equal(totalDuration(doc), 12);
  assert.equal(defaultTrack(doc, 'talk'), 'v1');
  assert.equal(defaultTrack(doc, 'music'), null);
  check(doc, 'fixture');
});

test('CutError carries a code and a plain message', () => {
  const e = new CutError({ code: 'overlap', message: 'Clip a would run into b.' });
  assert.equal(e.name, 'CutError'); assert.equal(e.code, 'overlap'); assert.equal(e.message, 'Clip a would run into b.');
  assert.equal(new CutError('x', 'y').code, 'y');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// split

test('splitClip: two clips that meet exactly, the new id, the motion carried on, fades on the right parts', () => {
  const doc = talking();
  const ops = splitClip(doc, 'a', 2.5);
  assert.ok(ops.every((o) => /^\/timeline\/tracks\/0\/clips\//.test(o.path)), 'only the clip list of its track is touched');
  const out = run(doc, ops, 'split a');
  const [a, a2, b] = clipsOf(out, 'v1');
  assert.deepEqual([a.id, a.in, a.out, a.at], ['a', 0, 2.5, 0]);
  assert.deepEqual([a2.id, a2.in, a2.out, a2.at], ['a-b', 2.5, 6, 2.5]);
  assert.equal(b.id, 'b');
  // zoom 1 -> 1.2 over 6 s, split after 2.5 s: the picture does not jump where the two parts meet
  near(a.zoom.from, 1); near(a.zoom.to, 1 + 0.2 * (2.5 / 6), 1e-3); near(a2.zoom.from, a.zoom.to, 1e-9); near(a2.zoom.to, 1.2);
  assert.deepEqual(a.fade, { in: 0.2 }); assert.equal(a2.fade, undefined, 'the fade in stays on the first part');
  assert.deepEqual([a2.focal, a2.grade], [a.focal, a.grade], 'the look is copied');
  // the end of the first part is the start of the second, to the frame
  near(a.at + clipDuration(a), a2.at, 1e-9);
  // a transition and a fade out: transition stays on the first part, the fade out on the last
  const sb = run(doc, splitClip(doc, 'b', 9), 'split b');
  const [, b1, b2] = clipsOf(sb, 'v1');
  assert.deepEqual([b1.transition, b1.fade], [{ type: 'fade', duration: 0.3 }, undefined]);
  assert.deepEqual([b2.transition, b2.fade], [undefined, { out: 0.4 }]);
  assert.deepEqual([b2.id, b2.in, b2.at], ['b-b', 11, 9]);
});

test('splitClip: ids are unique in the whole document, times snap to frames, edges and other tracks are handled', () => {
  let doc = talking();
  doc = run(doc, splitClip(doc, 'a', 2), 's1');
  doc = run(doc, splitClip(doc, 'a', 1), 's2'); // "a-b" is taken, so this one is "a-c"
  assert.deepEqual(clipsOf(doc, 'v1').map((c) => c.id), ['a', 'a-c', 'a-b', 'b']);
  doc = run(doc, splitClip(doc, 'a-b', 4), 's3');
  assert.deepEqual(clipsOf(doc, 'v1').map((c) => c.id), ['a', 'a-c', 'a-b', 'a-b-b', 'b']);
  // snapping: 2.52 s is frame 76 (2.5333 s)
  const snapped = run(talking(), splitClip(talking(), 'a', 2.52), 'snap');
  near(clipsOf(snapped, 'v1')[1].at, 76 / 30, 1e-6);
  near(clipsOf(snapped, 'v1')[1].in, 76 / 30, 1e-6);
  // not inside the clip, or on an edge
  for (const t of [0, 6, 7, -1, 0.001]) mustThrow(() => splitClip(talking(), 'a', t), 'edge', /not inside clip "a"/);
  mustThrow(() => splitClip(talking(), 'nope', 1), 'no-clip', /There is no clip "nope"/);
  mustThrow(() => splitClip(talking(), 'a', 'x'), 'bad-time');
  // a clip on an audio track
  const withBed = talking({ bed: true });
  const bed = run(withBed, splitClip(withBed, 'bed', 5), 'bed');
  assert.deepEqual(clipsOf(bed, 'bed').map((c) => [c.id, c.in, c.out, c.at]), [['bed', 0, 5, 0], ['bed-b', 5, 12, 5]]);
});

test('splitClip: a sped-up clip is cut where the timeline says, and the two halves still add up', () => {
  const doc = talking();
  doc.timeline.tracks[1].clips.push({ id: 'fast', source: 'broll', in: 4, out: 10, at: 8, speed: 2, mute: true }); // 3 s on the timeline: 8 to 11
  const out = run(doc, splitClip(doc, 'fast', 9.5), 'speed');
  const [, f1, f2] = clipsOf(out, 'v2');
  assert.deepEqual([f1.in, f1.out, f1.at], [4, 7, 8]);
  assert.deepEqual([f2.in, f2.out, f2.at], [7, 10, 9.5]);
  near(f1.at + clipDuration(f1), f2.at, 1e-9);
  // a photo: its length is out - in
  const photo = base({ fps: 30, duration: 4, tracks: [{ id: 'v1', type: 'video', clips: [{ id: 'p', source: 'photo', in: 0, out: 4, at: 0, zoom: { from: 1, to: 1.4 } }] }] });
  const sp = run(photo, splitClip(photo, 'p', 1), 'photo');
  assert.deepEqual(clipsOf(sp, 'v1').map((c) => [c.id, c.in, c.out, c.at]), [['p', 0, 1, 0], ['p-b', 1, 4, 1]]);
  near(clipsOf(sp, 'v1')[0].zoom.to, 1.1, 1e-3);
});

test('splitClip: eased motion is continuous in value across the split', () => {
  const doc = talking();
  doc.timeline.tracks[0].clips[0].zoom = { from: 1, to: 1.4, ease: 'in' };
  doc.timeline.tracks[0].clips[0].pan = { from: { x: 0.2, y: 0.5 }, to: { x: 0.8, y: 0.5 }, ease: 'out' };
  const out = run(doc, splitClip(doc, 'a', 3), 'ease');
  const [a, a2] = clipsOf(out, 'v1');
  near(a.zoom.to, 1 + 0.4 * 0.25, 1e-3); near(a2.zoom.from, a.zoom.to, 1e-9);
  near(a.pan.to.x, 0.2 + 0.6 * 0.75, 1e-3); near(a2.pan.from.x, a.pan.to.x, 1e-9); near(a2.pan.to.x, 0.8);
  assert.equal(a2.zoom.ease, 'in');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// trim

/** The talking fixture with only the speaker's track, so the video is exactly as long as that track. */
const solo = () => { const d = talking(); d.timeline.tracks = d.timeline.tracks.filter((t) => t.id === 'v1'); return d; };

test('trimClip: the head keeps the tail where it was; with ripple the clip keeps its start and later clips shift', () => {
  const doc = solo();
  const head = run(doc, trimClip(doc, 'a', { in: 1 }), 'head');
  assert.deepEqual(clipsOf(head, 'v1').map((c) => [c.id, c.in, c.out, c.at]), [['a', 1, 6, 1], ['b', 8, 14, 6]]);
  const rip = run(doc, trimClip(doc, 'a', { in: 1 }, { ripple: true }), 'head ripple');
  assert.deepEqual(clipsOf(rip, 'v1').map((c) => [c.id, c.in, c.out, c.at]), [['a', 1, 6, 0], ['b', 8, 14, 5]]);
  assert.equal(rip.timeline.duration, 11);
  assert.deepEqual(rip.timeline.scenes.map((s) => [s.id, s.start, s.end]), [['hook', 0, 4], ['rest', 4, 11]]);
  assert.deepEqual(rip.layers[0].time, { start: 6, end: 8 });
  const wide = talking();
  const keepsOthers = run(wide, trimClip(wide, 'a', { in: 1 }, { ripple: true }), 'head ripple, three tracks');
  assert.deepEqual(clipsOf(keepsOthers, 'v3').map((c) => c.at), [0, 6], 'other tracks stay where they are');
  assert.equal(keepsOthers.timeline.duration, 12, 'and the one that still runs to 12 s keeps the video that long');
  const tail = run(doc, trimClip(doc, 'a', { out: 5 }), 'tail');
  assert.deepEqual(clipsOf(tail, 'v1').map((c) => [c.in, c.out, c.at]), [[0, 5, 0], [8, 14, 6]]);
  assert.equal(tail.timeline.duration, 12);
  const long = run(doc, trimClip(doc, 'a', { out: 7 }, { ripple: true }), 'longer ripple');
  assert.deepEqual(clipsOf(long, 'v1').map((c) => [c.out, c.at]), [[7, 0], [14, 7]]);
  assert.equal(long.timeline.duration, 13);
  assert.deepEqual(long.timeline.scenes.map((s) => s.end), [4, 13]);
  assert.deepEqual(long.layers[0].time, { start: 8, end: 10 });
  // both at once, and a snapped value
  const both = run(doc, trimClip(doc, 'b', { in: 9.01, out: 13 }), 'both');
  const bb = clipsOf(both, 'v1')[1];
  assert.deepEqual([bb.in, bb.out, bb.at], [9, 13, 7], 'in snapped to a frame; the head moved, so the clip starts later');
  // an explicit start
  const at = run(doc, trimClip(doc, 'b', { at: 7 }), 'at');
  assert.equal(at.timeline.duration, 13);
  assert.deepEqual(trimClip(doc, 'a', { in: 0, out: 6 }), [], 'nothing to do');
});

test('trimClip: refuses what cannot be (overlap, empty, before the start, past the footage) in plain words', () => {
  const doc = talking();
  mustThrow(() => trimClip(doc, 'a', { out: 7 }), 'overlap', /"a" would run from 0s to 7s on track "v1", where "b" already plays \(6s to 12s\)/);
  mustThrow(() => trimClip(doc, 'a', { in: 6 }), 'empty', /would be empty/);
  mustThrow(() => trimClip(doc, 'a', { in: 7 }), 'empty');
  mustThrow(() => trimClip(doc, 'a', { in: -1 }), 'before-footage');
  mustThrow(() => trimClip(doc, 'a', { in: 0, at: -1 }), 'before-start');
  const fast = talking();
  fast.timeline.tracks[1].clips.push({ id: 'fast', source: 'broll', in: 4, out: 10, at: 8, speed: 4, mute: true });
  mustThrow(() => trimClip(fast, 'fast', { out: 4 + 1 / 30 }), 'too-short', /shorter than one frame/);
  mustThrow(() => trimClip(doc, 'b', { out: 70 }, { sourceDuration: 60 }), 'past-footage', /footage is only 60s long/);
  assert.doesNotThrow(() => trimClip(doc, 'b', { out: 59 }, { sourceDuration: 60 }));
  assert.doesNotThrow(() => trimClip(doc, 'b', { out: 20 }), 'unchecked without sourceDuration');
  // extending the head of the first clip would put it before the start
  const late = talking();
  late.timeline.tracks[0].clips[0].in = 2; late.timeline.tracks[0].clips[0].out = 6; late.timeline.tracks[0].clips[0].at = 1;
  late.timeline.tracks[0].clips[1].at = 5;
  mustThrow(() => trimClip(late, 'a', { in: 0 }), 'before-start');
  assert.ok(trimClip(late, 'a', { in: 0 }, { ripple: true }).length > 0, 'with ripple the clip keeps its start, so it is fine');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// move and delete

test('moveClip: lands on a frame, refuses to cover another clip, ripple pushes the following clips', () => {
  const doc = talking();
  const free = run(doc, moveClip(doc, 'cut1', 9.01), 'free');
  near(clipsOf(free, 'v2')[0].at, 9, 1e-6);
  assert.equal(free.timeline.duration, 12);
  assert.deepEqual(moveClip(doc, 'cut1', 3), [], 'same place');
  mustThrow(() => moveClip(doc, 'a', 3), 'overlap', /"a" would run from 3s to 9s on track "v1", where "b" already plays \(6s to 12s\)\. Move it somewhere free, or use ripple/);
  mustThrow(() => moveClip(doc, 'a', -1), 'before-start');
  const later = run(doc, moveClip(doc, 'b', 20), 'later');
  assert.equal(later.timeline.duration, 26);
  const pushed = run(doc, moveClip(doc, 'a', 4, { ripple: true }), 'push');
  assert.deepEqual(clipsOf(pushed, 'v1').map((c) => [c.id, c.at]), [['a', 4], ['b', 10]]);
  assert.equal(pushed.timeline.duration, 16);
  assert.deepEqual(pushed.timeline.scenes.map((s) => [s.start, s.end]), [[0, 4], [4, 16]]);
  assert.deepEqual(pushed.layers[0].time, { start: 11, end: 13 });
});

test('moveClip: ripple cannot push a clip that started earlier', () => {
  const doc = talking();
  doc.timeline.tracks[1].clips.push({ id: 'cut2', source: 'broll', in: 5, out: 8, at: 4, mute: true });
  doc.timeline.tracks[1].clips[0].at = 0.5; // cut1: 0.5 to 2.5
  const out = run(doc, moveClip(doc, 'cut1', 3.5, { ripple: true }), 'push cut2');
  const [c1, c2] = clipsOf(out, 'v2');
  assert.equal(c1.at, 3.5);
  near(c2.at, 5.5, 1e-9);
  mustThrow(() => moveClip(doc, 'cut1', 5, { ripple: true }), 'overlap', /cannot start at 5s: "cut2" is playing there/);
});

test('deleteClip: ripple closes the gap on that track only; scenes, titles and the end move with it', () => {
  const doc = talking();
  const out = run(doc, deleteClip(doc, 'a'), 'delete a');
  assert.deepEqual(clipsOf(out, 'v1').map((c) => [c.id, c.at]), [['b', 0]]);
  assert.deepEqual(clipsOf(out, 'v3').map((c) => c.id), ['a3', 'b3'], 'other tracks are left alone');
  assert.deepEqual(clipsOf(out, 'v2').map((c) => c.at), [3]);
  // everything else still ends at 12 (the copy on v3), so the video does not shrink; a note would say so when words are cut
  assert.equal(out.timeline.duration, 12);
  const single = talking();
  single.timeline.tracks = single.timeline.tracks.filter((t) => t.id === 'v1');
  const s = run(single, deleteClip(single, 'a'), 'delete a, one track');
  assert.equal(s.timeline.duration, 6);
  assert.deepEqual(s.timeline.scenes.map((x) => [x.id, x.start, x.end]), [['rest', 0, 6]], 'the scene that sat inside the cut is gone, the other moved up');
  assert.deepEqual(s.layers[0].time, { start: 1, end: 3 });
  const gap = run(single, deleteClip(single, 'a', { ripple: false }), 'no ripple');
  assert.deepEqual(clipsOf(gap, 'v1').map((c) => [c.id, c.at]), [['b', 6]]);
  assert.equal(gap.timeline.duration, 12);
  const last = run(single, deleteClip(single, 'b'), 'delete the last');
  assert.equal(last.timeline.duration, 6);
  assert.deepEqual(last.timeline.scenes.map((x) => [x.id, x.start, x.end]), [['hook', 0, 4], ['rest', 4, 6]]);
  assert.deepEqual(last.layers, [], 'a title that sat on the deleted clip is taken out');
});

test('locked tracks are not edited, and a missing track or source is explained', () => {
  const doc = talking();
  doc.timeline.tracks[0].lock = true;
  mustThrow(() => splitClip(doc, 'a', 2), 'locked', /Track "v1" is locked/);
  mustThrow(() => deleteClip(doc, 'a'), 'locked');
  mustThrow(() => removeSourceRange(doc, { track: 'v1', source: 'talk', from: 1, to: 2 }), 'locked');
  const linked = talking();
  linked.timeline.tracks[2].lock = true; // the copy is locked: cutting v1 would leave it out of step, so it is refused
  mustThrow(() => removeSourceRange(linked, { track: 'v1', source: 'talk', from: 1, to: 2 }), 'locked', /Track "v3"/);
  mustThrow(() => removeSourceRange(talking(), { track: 'zz', source: 'talk', from: 1, to: 2 }), 'no-track', /There is no track "zz"\. Tracks: v1, v2, v3/);
  mustThrow(() => removeSourceRange(talking(), { track: 'v2', source: 'talk', from: 1, to: 2 }), 'no-source', /Track "v2" has no clips of source "talk"/);
  mustThrow(() => removeSourceRange(talking(), { track: 'v1', source: 'talk', from: 3, to: 2 }), 'bad-range');
  assert.deepEqual(removeSourceRange(talking(), { track: 'v1', source: 'talk', from: 3, to: 3 }), []);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// coverage

test('coverage: what the track plays, sorted, merged where source and timeline are both continuous', () => {
  const doc = talking();
  assert.deepEqual(COVER(doc, 'v1'), [{ from: 0, to: 6, at: 0 }, { from: 8, to: 14, at: 6 }]);
  assert.deepEqual(coverage(doc, { track: 'v1', source: 'talk' })[1], { from: 8, to: 14, clipId: 'b', at: 6 });
  assert.deepEqual(coverage(doc, { track: 'v2', source: 'talk' }), []);
  // a clip split in two is still one stretch
  const split = run(doc, splitClip(doc, 'a', 2), 'split');
  assert.deepEqual(COVER(split, 'v1'), [{ from: 0, to: 6, at: 0 }, { from: 8, to: 14, at: 6 }]);
  assert.equal(coverage(split, { track: 'v1', source: 'talk' })[0].clipId, 'a');
  // source-adjacent but not continuous on the timeline: two stretches
  const apart = structuredClone(doc);
  apart.timeline.tracks[0].clips[1] = { id: 'b', source: 'talk', in: 6, out: 12, at: 7 };
  assert.deepEqual(COVER(apart, 'v1').length, 2);
  // listed out of order: sorted by source time
  const shuffled = structuredClone(doc);
  shuffled.timeline.tracks[0].clips.reverse();
  assert.deepEqual(COVER(shuffled, 'v1').map((e) => e.from), [0, 8]);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// removing a range of the source

const shape = (doc, id) => clipsOf(doc, id).map((c) => [c.id, c.in, c.out, c.at]);

test('removeSourceRange: the middle of a clip splits it, closes up, and keeps the motion and the rest attached', () => {
  const doc = talking();
  const r = removeSourceRangeInfo(doc, { track: 'v1', source: 'talk', from: 2, to: 3 });
  assert.equal(r.removed, 1);
  const out = run(doc, r.ops, 'middle');
  assert.deepEqual(shape(out, 'v1'), [['a', 0, 2, 0], ['a-b', 3, 6, 2], ['b', 8, 14, 5]]);
  assert.deepEqual(shape(out, 'v3'), [['a3', 0, 2, 0], ['a3-b', 3, 6, 2], ['b3', 8, 14, 5]], 'the picture-only copy is cut the same way, so it stays in step');
  assert.deepEqual(shape(out, 'v2'), [['cut1', 0, 2, 3]], 'a clip of another source is not touched');
  assert.equal(out.timeline.duration, 11);
  assert.deepEqual(out.timeline.scenes.map((s) => [s.id, s.start, s.end]), [['hook', 0, 3], ['rest', 3, 11]]);
  assert.deepEqual(out.layers[0].time, { start: 6, end: 8 }, 'the title stays on the words it was over');
  const [a, a2] = clipsOf(out, 'v1');
  near(a.zoom.to, 1 + 0.2 * (2 / 5), 1e-3); near(a2.zoom.from, a.zoom.to, 1e-9);
  assert.deepEqual([a.fade, a2.fade, a2.grade], [{ in: 0.2 }, undefined, 'warm']);
  assert.equal(r.notes.length, 0);
  // the second clip keeps its transition and fade out (it is still the same clip)
  assert.deepEqual([clipsOf(out, 'v1')[2].transition, clipsOf(out, 'v1')[2].fade], [{ type: 'fade', duration: 0.3 }, { out: 0.4 }]);
});

test('removeSourceRange: head, tail, spanning two clips, across a gap, a whole clip, and a range that is already cut', () => {
  const doc = talking();
  const cut = (from, to, opts) => run(doc, removeSourceRange(doc, { track: 'v1', source: 'talk', from, to }, opts), `${from}-${to}`);
  const head = cut(0, 2);
  assert.deepEqual(shape(head, 'v1'), [['a', 2, 6, 0], ['b', 8, 14, 4]]);
  assert.equal(head.timeline.duration, 10);
  assert.ok(head.timeline.tracks[0].clips[0].fade, 'a clip that loses its head keeps the fade that belonged to the clip');
  const tail = cut(12, 14);
  assert.deepEqual(shape(tail, 'v1'), [['a', 0, 6, 0], ['b', 8, 12, 6]]);
  assert.equal(tail.timeline.duration, 10);
  assert.deepEqual(tail.timeline.scenes.map((s) => s.end), [4, 10]);
  assert.deepEqual(tail.layers[0].time, { start: 7, end: 9 });
  const span = cut(4, 10);
  assert.deepEqual(shape(span, 'v1'), [['a', 0, 4, 0], ['b', 10, 14, 4]]);
  assert.equal(span.timeline.duration, 8);
  assert.equal(removeSourceRangeInfo(doc, { track: 'v1', source: 'talk', from: 4, to: 10 }).removed, 4);
  const across = cut(5, 9);
  assert.deepEqual(shape(across, 'v1'), [['a', 0, 5, 0], ['b', 9, 14, 5]]);
  assert.equal(across.timeline.duration, 10);
  assert.deepEqual(removeSourceRangeInfo(doc, { track: 'v1', source: 'talk', from: 6.2, to: 7.5 }), { ops: [], removed: 0, notes: [] }, 'that part is already cut');
  assert.deepEqual(removeSourceRange(doc, { track: 'v1', source: 'talk', from: 30, to: 40 }), [], 'a part of the recording no clip plays');
  const whole = cut(7, 15);
  assert.deepEqual(shape(whole, 'v1'), [['a', 0, 6, 0]]);
  assert.equal(whole.timeline.duration, 6);
  assert.deepEqual(whole.timeline.scenes.map((s) => [s.id, s.start, s.end]), [['hook', 0, 4], ['rest', 4, 6]]);
  assert.deepEqual(whole.layers, [], 'the title sat inside the part that went');
  assert.match(removeSourceRangeInfo(doc, { track: 'v1', source: 'talk', from: 7, to: 15 }).notes[0], /"title" sat inside the part that was cut/);
  // cutting it all would leave a track that cannot be brought back from: refused, and the way out is explained
  mustThrow(() => removeSourceRange(doc, { track: 'v1', source: 'talk', from: 0, to: 20 }), 'everything', /cut out everything of "talk" on track "v1".*delete the clips/);
  assert.doesNotThrow(() => removeSourceRange(doc, { track: 'v1', source: 'talk', from: 0, to: 13.9 }), 'a little left is enough');
});

test('removeSourceRange without ripple leaves a gap and moves nothing', () => {
  const doc = talking();
  const out = run(doc, removeSourceRange(doc, { track: 'v1', source: 'talk', from: 2, to: 3 }, { ripple: false }), 'no ripple');
  assert.deepEqual(shape(out, 'v1'), [['a', 0, 2, 0], ['a-b', 3, 6, 3], ['b', 8, 14, 6]]);
  assert.equal(out.timeline.duration, 12);
  assert.deepEqual(out.timeline.scenes.map((s) => [s.start, s.end]), [[0, 4], [4, 12]]);
  assert.deepEqual(out.layers[0].time, { start: 7, end: 9 });
  const tailOnly = run(doc, removeSourceRange(doc, { track: 'v1', source: 'talk', from: 12, to: 14 }, { ripple: false }), 'tail, no ripple');
  assert.equal(tailOnly.timeline.duration, 10);
});

test('removeSourceRange: cut from the picture-only track and the main track follows; two audio tracks of one microphone stay in step', () => {
  const doc = talking();
  const viaCopy = run(doc, removeSourceRange(doc, { track: 'v3', source: 'talk', from: 2, to: 3 }), 'via v3');
  assert.deepEqual(shape(viaCopy, 'v1').map((c) => c.slice(1)), [[0, 2, 0], [3, 6, 2], [8, 14, 5]]);
  const mics = base({ fps: 30, duration: 10, tracks: [
    { id: 'a1', type: 'audio', clips: [{ id: 'm1', source: 'mic', in: 1, out: 11, at: 0, gainDb: -3 }] },
    { id: 'a2', type: 'audio', clips: [{ id: 'm2', source: 'mic', in: 1, out: 11, at: 0, gainDb: -9, mute: true }] },
  ] });
  const out = run(mics, removeSourceRange(mics, { track: 'a1', source: 'mic', from: 4, to: 6.5 }), 'mics');
  assert.deepEqual(cov(out, 'a1', 'mic'), cov(out, 'a2', 'mic'));
  assert.deepEqual(cov(out, 'a1', 'mic'), [{ from: 1, to: 4, at: 0 }, { from: 6.5, to: 11, at: 3 }]);
  assert.equal(out.timeline.duration, 7.5);
  assert.deepEqual(clipsOf(out, 'a1').map((c) => c.gainDb), [-3, -3]);
  assert.deepEqual(clipsOf(out, 'a2').map((c) => c.gainDb), [-9, -9]);
});

test('removeSourceRange: something else that still runs to the end keeps the video that long, and says so', () => {
  const doc = talking({ bed: true });
  doc.timeline.tracks = doc.timeline.tracks.filter((t) => t.id !== 'v3');
  const r = removeSourceRangeInfo(doc, { track: 'v1', source: 'talk', from: 2, to: 5 });
  const out = run(doc, r.ops, 'bed');
  assert.equal(out.timeline.duration, 12);
  assert.match(r.notes.join(' '), /"bed" on track "bed" runs to 12s, so the video is still 12s long\. Trim it/);
  // trimming the bed closes the end
  const trimmed = run(out, trimClip(out, 'bed', { out: 9 }), 'trim bed');
  assert.equal(trimmed.timeline.duration, 9);
});

test('scenes and titles that sat after the cut move by the same amount; what falls inside collapses or goes', () => {
  const doc = talking();
  doc.timeline.tracks = doc.timeline.tracks.filter((t) => t.id === 'v1');
  doc.timeline.scenes = [{ id: 's1', start: 0, end: 2.2 }, { id: 's2', start: 2.2, end: 2.8 }, { id: 's3', start: 2.8, end: 7 }, { id: 's4', start: 7, end: 12 }];
  doc.layers = [
    { ...TITLE, id: 'before', time: { start: 0.5, end: 1.5 } },
    { ...TITLE, id: 'inside', time: { start: 2.1, end: 2.9 } },
    { ...TITLE, id: 'straddle', time: { start: 1.5, end: 4 } },
    { ...TITLE, id: 'after', time: { start: 4, end: 11 } },
  ];
  doc.timeline.cover = 5;
  const out = run(doc, removeSourceRange(doc, { track: 'v1', source: 'talk', from: 2, to: 3 }), 'scenes');
  assert.deepEqual(out.timeline.scenes.map((s) => [s.id, s.start, s.end]), [['s1', 0, 2], ['s3', 2, 6], ['s4', 6, 11]], 'the scene that sat inside is gone, the one that straddled the cut shrank');
  assert.deepEqual(out.layers.map((l) => [l.id, l.time.start, l.time.end]), [['before', 0.5, 1.5], ['straddle', 1.5, 3], ['after', 3, 10]]);
  assert.equal(out.timeline.cover, 4);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// bringing a range back

// ranges inside what is kept; the first three sit inside one scene and clear of the title, so scenes and title also come back exactly
const ROUND_TRIPS = [[2, 3, true], [0, 2, true], [12, 14, true], [4, 6, false], [8, 10, false], [3, 5, false], [9, 13, false]];

test('restoreSourceRange: remove then restore gives back the same coverage and length (and, away from scene edges, the same scenes and title)', () => {
  for (const [from, to, exact] of ROUND_TRIPS) {
    const doc = talking();
    const cut = run(doc, removeSourceRange(doc, { track: 'v1', source: 'talk', from, to }), `remove ${from}-${to}`);
    assert.ok(totalDuration(cut) < totalDuration(doc) || cut.timeline.duration === 12);
    const back = run(cut, restoreSourceRange(cut, { track: 'v1', source: 'talk', from, to }), `restore ${from}-${to}`);
    assert.deepEqual(COVER(back, 'v1'), COVER(doc, 'v1'), `coverage ${from}-${to}`);
    assert.deepEqual(COVER(back, 'v3'), COVER(doc, 'v3'), `the copy ${from}-${to}`);
    assert.equal(totalDuration(back), totalDuration(doc), `length ${from}-${to}`);
    assert.equal(back.timeline.duration, 12);
    assert.deepEqual(clipsOf(back, 'v2'), clipsOf(doc, 'v2'));
    if (exact) {
      assert.deepEqual(back.timeline.scenes, doc.timeline.scenes, `scenes ${from}-${to}`);
      assert.deepEqual(back.layers[0].time, doc.layers[0].time, `title ${from}-${to}`);
    }
  }
  // a range that takes in the stretch that was already cut brings that back too
  const doc = talking();
  const cut = run(doc, removeSourceRange(doc, { track: 'v1', source: 'talk', from: 5, to: 9 }), 'across');
  const back = run(cut, restoreSourceRange(cut, { track: 'v1', source: 'talk', from: 5, to: 9 }), 'back across');
  assert.deepEqual(COVER(back, 'v1'), [{ from: 0, to: 14, at: 0 }]);
  assert.equal(totalDuration(back), 14);
});

test('restoreSourceRange: already kept is nothing to do; partial restores keep source order; the look is copied and the motion holds', () => {
  const doc = talking();
  assert.deepEqual(restoreSourceRange(doc, { track: 'v1', source: 'talk', from: 0, to: 6 }), []);
  assert.deepEqual(restoreSourceRange(doc, { track: 'v1', source: 'talk', from: 9, to: 12 }), []);
  assert.deepEqual(restoreSourceRangeInfo(doc, { track: 'v1', source: 'talk', from: 1, to: 1 }), { ops: [], restored: 0, notes: [] });
  const cut = run(doc, removeSourceRange(doc, { track: 'v1', source: 'talk', from: 2, to: 4 }), 'cut');
  // bring back the second half of the gap first, then the first half
  const half = run(cut, restoreSourceRange(cut, { track: 'v1', source: 'talk', from: 3, to: 4 }), 'half');
  assert.deepEqual(COVER(half, 'v1'), [{ from: 0, to: 2, at: 0 }, { from: 3, to: 6, at: 2 }, { from: 8, to: 14, at: 5 }]);
  assert.equal(half.timeline.duration, 11);
  const whole = run(half, restoreSourceRange(half, { track: 'v1', source: 'talk', from: 2, to: 3 }), 'other half');
  assert.deepEqual(COVER(whole, 'v1'), COVER(doc, 'v1'));
  // the restored clip has the neighbour's look; its zoom holds where the neighbour left off, so nothing restarts
  const back = run(cut, restoreSourceRange(cut, { track: 'v1', source: 'talk', from: 2, to: 4 }), 'back');
  const [a, mid, a2] = clipsOf(back, 'v1');
  assert.deepEqual([a.id, mid.id, a2.id], ['a', 'a-c', 'a-b']);
  assert.deepEqual([mid.in, mid.out, mid.at], [2, 4, 2]);
  assert.deepEqual([mid.grade, mid.focal], ['warm', { x: 0.4, y: 0.5 }]);
  assert.deepEqual(mid.zoom, { from: a.zoom.to, to: a.zoom.to });
  assert.equal(mid.fade, undefined); assert.equal(mid.transition, undefined);
  // restoring before the first kept stretch uses the clip after it
  const headCut = run(doc, removeSourceRange(doc, { track: 'v1', source: 'talk', from: 0, to: 2 }), 'head cut');
  const headBack = run(headCut, restoreSourceRange(headCut, { track: 'v1', source: 'talk', from: 0, to: 2 }), 'head back');
  assert.deepEqual(clipsOf(headBack, 'v1').map((c) => [c.in, c.out, c.at]), [[0, 2, 0], [2, 6, 2], [8, 14, 6]]);
  assert.equal(clipsOf(headBack, 'v1')[0].zoom, undefined, 'the next clip starts at no zoom, so the restored part holds no zoom either');
});

test('restoreSourceRange: without ripple it goes back into the hole, or says there is no room', () => {
  const doc = talking();
  const hole = run(doc, removeSourceRange(doc, { track: 'v1', source: 'talk', from: 2, to: 3 }, { ripple: false }), 'hole');
  const back = run(hole, restoreSourceRange(hole, { track: 'v1', source: 'talk', from: 2, to: 3 }, { ripple: false }), 'into the hole');
  assert.deepEqual(COVER(back, 'v1'), COVER(doc, 'v1'));
  const closed = run(doc, removeSourceRange(doc, { track: 'v1', source: 'talk', from: 2, to: 3 }), 'closed');
  mustThrow(() => restoreSourceRange(closed, { track: 'v1', source: 'talk', from: 2, to: 3 }, { ripple: false }), 'overlap', /no room to bring back 2s to 3s of "talk" on track "v1".*Use ripple/);
});

test('restoreSourceRange: a track with nothing of the source has nothing to copy, and the linked track gets the range back too', () => {
  mustThrow(() => restoreSourceRange(talking(), { track: 'v2', source: 'talk', from: 1, to: 2 }), 'no-source', /nothing to copy the look of/);
  const doc = talking();
  const cutBoth = run(doc, removeSourceRange(doc, { track: 'v1', source: 'talk', from: 3, to: 5 }), 'cut');
  // the picture-only copy was cut with it, so asking for the range back on the copy restores v1 as well
  const back = run(cutBoth, restoreSourceRange(cutBoth, { track: 'v3', source: 'talk', from: 3, to: 5 }), 'restore via the copy');
  assert.deepEqual(COVER(back, 'v1'), COVER(doc, 'v1'));
  assert.deepEqual(COVER(back, 'v3'), COVER(doc, 'v3'));
  // if only one of the two is cut, restoring puts it back where it is missing and leaves the other alone
  const lone = structuredClone(cutBoth);
  lone.timeline.tracks[2].clips = structuredClone(doc.timeline.tracks[2].clips);
  assert.deepEqual(restoreSourceRange(lone, { track: 'v3', source: 'talk', from: 3, to: 5 }).filter((o) => o.path.includes('/tracks/2/')), []);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// words

/** Words every 0.5 s: word k is spoken from 0.5 + 0.5 k for 0.35 s. */
const sayings = (n) => Array.from({ length: n }, (_, k) => ({ text: `word${k}${k % 7 === 6 ? '.' : ''}`, start: 0.5 + 0.5 * k, end: 0.85 + 0.5 * k }));
const speaker = (words, { audio = true } = {}) => {
  const T = Math.round((Math.ceil((words.at(-1).end + 1) * 30) / 30) * 1e9) / 1e9;
  const tracks = [{ id: 'v1', type: 'video', clips: [{ id: 'main', source: 'talk', in: 0, out: T, at: 0 }] }];
  if (audio) tracks.push({ id: 'v2', type: 'video', clips: [{ id: 'main2', source: 'talk', in: 0, out: T, at: 0, mute: true }] });
  const doc = base({ fps: 30, duration: T, tracks, scenes: [{ id: 'all', start: 0, end: T }] });
  doc.sources[0].duration = T;
  return doc;
};
const REF = { track: 'v1', source: 'talk' };
const on30 = (t) => Math.abs(t * 30 - Math.round(t * 30)) < 1e-4;

test('snapCut: starts in the quiet after the word before, ends in the quiet before the word after, on whole frames', () => {
  const words = sayings(20);
  // words 6..8: the gaps are 0.15 s, so each pad is the middle of the gap
  const c = snapCut(words, words[6].start, words[8].end, { fps: 30 });
  assert.ok(on30(c.from) && on30(c.to));
  assert.ok(c.from >= words[5].end && c.from <= words[6].start, `from ${c.from}`);
  assert.ok(c.to >= words[8].end && c.to <= words[9].start, `to ${c.to}`);
  near(c.from, words[5].end + 0.075, 1 / 60 + 1e-6); near(c.to, words[9].start - 0.075, 1 / 60 + 1e-6);
  // a long pause: the cut starts at most maxPad after the word before, and ends at most maxPad before the next
  const pause = [{ text: 'a', start: 1, end: 1.3 }, { text: 'b', start: 3, end: 3.4 }, { text: 'c', start: 5, end: 5.3 }, { text: 'd', start: 5.4, end: 5.7 }];
  const p = snapCut(pause, 3, 3.4, { fps: 30 });
  near(p.from, 1.3 + 0.12, 1 / 60 + 1e-6); near(p.to, 5 - 0.12, 1 / 60 + 1e-6);
  const narrow = snapCut(pause, 3, 3.4, { fps: 30, maxPad: 0.5 });
  near(narrow.from, 1.3 + 0.5, 1 / 60 + 1e-6);
  // a selection that starts or ends inside a word is widened to whole words
  const wide = snapCut(words, words[6].start + 0.1, words[8].end - 0.1, { fps: 30 });
  assert.deepEqual(wide, c);
  // a gap narrower than one frame: the nearest frame to the middle
  const tight = [{ text: 'a', start: 1, end: 1.5 }, { text: 'b', start: 1.51, end: 2 }, { text: 'c', start: 2.01, end: 2.5 }];
  const t = snapCut(tight, 1.51, 2, { fps: 30 });
  assert.ok(on30(t.from) && on30(t.to));
  assert.ok(Math.abs(t.from - 1.505) <= 1 / 60 + 1e-6 && Math.abs(t.to - 2.005) <= 1 / 60 + 1e-6);
});

test('snapCut at the very start and the very end of the recording', () => {
  const words = sayings(12);
  const first = snapCut(words, words[0].start, words[2].end, { fps: 30 });
  assert.equal(first.from, 0, 'nothing before it to protect: the cut begins at the start of the footage');
  assert.ok(first.to >= words[2].end && first.to <= words[3].start);
  assert.deepEqual(snapCut(words, words[0].start, words[0].end, { fps: 30, start: 0.2 }).from, 0.2);
  const last = snapCut(words, words[10].start, words[11].end, { fps: 30 });
  assert.ok(last.from >= words[9].end && last.from <= words[10].start);
  assert.ok(last.to >= words[11].end && last.to <= words[11].end + 0.12 + 1 / 30 && on30(last.to), `to ${last.to}`);
  assert.equal(snapCut(words, words[10].start, words[11].end, { fps: 30, end: 20 }).to, 20, 'runs to the end of the footage when it is known');
  const everything = snapCut(words, words[0].start, words[11].end, { fps: 30, end: 12.5 });
  assert.deepEqual(everything, { from: 0, to: 12.5 });
  assert.throws(() => snapCut([], 0, 1), CutError);
});

test('wordStates: kept when the whole word is played, and where it lands on the timeline', () => {
  const words = sayings(20);
  const doc = speaker(words);
  const before = wordStates(doc, REF, words);
  assert.equal(before.length, 20);
  assert.ok(before.every((w, i) => w.kept && w.i === i && w.text === words[i].text && Math.abs(w.at - words[i].start) < 1e-9));
  const r = removeWordsInfo(doc, REF, words, 4, 7);
  const out = run(doc, r.ops, 'remove 4-7');
  const after = wordStates(out, REF, words);
  assert.deepEqual(after.filter((w) => !w.kept).map((w) => w.i), [4, 5, 6, 7]);
  assert.ok(after.filter((w) => !w.kept).every((w) => w.at === null));
  near(after[3].at, words[3].start, 1e-6);
  near(after[8].at, words[8].start - r.removed, 1e-6, 'a later word moved up by what was cut');
  near(after[19].at, words[19].start - r.removed, 1e-6);
  assert.equal(wordStates(out, { track: 'v2', source: 'talk' }, words).filter((w) => !w.kept).length, 4, 'the picture-only copy is cut the same way');
  // a word that a clip boundary cuts through is not "kept"
  const sliced = run(doc, removeSourceRange(doc, { ...REF, from: words[5].start + 0.1, to: words[5].end - 0.1 }), 'through a word');
  assert.equal(wordStates(sliced, REF, words)[5].kept, false);
  assert.equal(wordStates(sliced, REF, words)[4].kept, true);
});

test('removeWords / restoreWords: the cut sits between words, the length adds up, restoring gives it all back', () => {
  const words = sayings(40);
  const doc = speaker(words);
  const r = removeWordsInfo(doc, REF, words, 10, 14);
  assert.ok(on30(r.from) && on30(r.to) && r.from < words[10].start && r.to > words[14].end);
  assert.equal(removeWords(doc, REF, words, 10, 14).length, r.ops.length);
  const out = run(doc, r.ops, 'cut');
  near(totalDuration(doc) - totalDuration(out), r.removed, 1 / 30);
  near(r.removed, r.to - r.from, 1e-6);
  const states = wordStates(out, REF, words);
  assert.deepEqual(states.filter((w) => !w.kept).map((w) => w.i), [10, 11, 12, 13, 14]);
  // no clip starts or ends inside a word (the same test the render's speech check makes)
  for (const c of clipsOf(out, 'v1')) for (const t of [c.in, c.out]) assert.ok(!words.some((w) => w.start < t - 0.03 && w.end > t + 0.03), `boundary ${t}`);
  // cutting words that are already gone changes nothing; the same range again is a no-op
  assert.deepEqual(removeWords(out, REF, words, 11, 13), []);
  // bring back part of it
  const mid = run(out, restoreWords(out, REF, words, 12, 12), 'one word');
  assert.deepEqual(wordStates(mid, REF, words).filter((w) => !w.kept).map((w) => w.i), [10, 11, 13, 14]);
  const back = run(mid, restoreWords(mid, REF, words, 10, 14), 'all');
  assert.deepEqual(COVER(back, 'v1'), COVER(doc, 'v1'));
  assert.equal(totalDuration(back), totalDuration(doc));
  assert.equal(back.timeline.duration, doc.timeline.duration);
  assert.deepEqual(back.timeline.scenes, doc.timeline.scenes);
  assert.deepEqual(restoreWords(back, REF, words, 10, 14), [], 'already there');
  // the first and the last words
  const head = run(doc, removeWords(doc, REF, words, 0, 3), 'head words');
  assert.equal(wordStates(head, REF, words)[4].kept, true);
  assert.ok(wordStates(head, REF, words)[4].at < 0.2, 'the video now starts just before the first kept word');
  const tail = run(doc, removeWords(doc, REF, words, 36, 39), 'tail words');
  assert.deepEqual(wordStates(tail, REF, words).filter((w) => !w.kept).map((w) => w.i), [36, 37, 38, 39]);
  assert.ok(totalDuration(tail) < words[36].start + 0.1, `the video ends after the last kept word (${totalDuration(tail)})`);
  mustThrow(() => removeWords(doc, REF, words, 5, 4), 'bad-range', /Words 5 to 4 are not in this transcript/);
  mustThrow(() => removeWords(doc, REF, words, 0, 40), 'bad-range');
  mustThrow(() => removeWords(doc, REF, words, -1, 2), 'bad-range');
});

test('transcriptLines: a line per sentence, with whether it is kept', () => {
  const words = sayings(16); // a full stop after every 7th word
  const doc = speaker(words);
  const out = run(doc, removeWords(doc, REF, words, 7, 13), 'sentence');
  const lines = transcriptLines(wordStates(out, REF, words));
  assert.deepEqual(lines.map((l) => [l.i, l.j, l.kept]), [[0, 6, 'all'], [7, 13, 'none'], [14, 15, 'all']]);
  assert.equal(lines[1].at, null);
  assert.equal(lines[0].text.startsWith('word0 word1'), true);
  const part = transcriptLines(wordStates(run(doc, removeWords(doc, REF, words, 2, 3), 'part'), REF, words));
  assert.equal(part[0].kept, 'some');
  assert.equal(speechSource(base({ fps: 30, duration: 1, tracks: [] })), null);
  const withCaptions = speaker(words); withCaptions.sources[0].transcript = 'mount:footage/talk.words.json';
  assert.equal(speechSource(withCaptions), 'talk');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// property tests: random transcripts, random cuts, seeded so a failure can be replayed

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const ms = (x) => Math.round(x * 1000) / 1000;

function randomWords(rnd, n) {
  const words = [];
  let t = 0.2 + rnd() * 0.8;
  for (let k = 0; k < n; k++) {
    const dur = 0.12 + rnd() * 0.5;
    words.push({ text: `w${k}${rnd() < 0.12 ? '.' : ''}`, start: ms(t), end: ms(t + dur) });
    const kind = rnd();
    const gap = kind < 0.2 ? 0.01 + rnd() * 0.04 : kind < 0.35 ? 0.5 + rnd() * 0.9 : 0.04 + rnd() * 0.35;
    t += dur + gap;
  }
  return words;
}

/** No clip starts or ends inside a word: strictly when the silence has room for a frame, to half a frame when it has not. */
function cutsStayOutOfWords(doc, words, fps, label) {
  for (const track of doc.timeline.tracks) {
    for (const c of track.clips) {
      for (const t of [c.in, c.out]) {
        words.forEach((w, k) => {
          const prevEnd = k > 0 ? words[k - 1].end : 0;
          const roomBefore = w.start - prevEnd >= 1 / fps, roomAfter = (words[k + 1]?.start ?? Infinity) - w.end >= 1 / fps;
          const tol = roomBefore && roomAfter ? 1e-6 : 0.5 / fps + 1e-6;
          assert.ok(!(w.start + tol < t && t < w.end - tol), `${label}: clip ${c.id} has a cut at ${t} inside "${w.text}" (${w.start}-${w.end})`);
          assert.ok(!(w.start < t - 0.03 && w.end > t + 0.03), `${label}: the render's speech check would flag ${c.id} at ${t} in "${w.text}"`);
        });
      }
    }
  }
}

test('property: random transcripts and random word cuts never cut a word, keep every other word, and add up', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const rnd = mulberry32(seed);
    const n = 20 + Math.floor(rnd() * 90);
    const words = randomWords(rnd, n);
    const doc = speaker(words);
    const label = `seed ${seed}`;
    check(doc, label);
    let i = Math.floor(rnd() * n);
    let j = Math.min(n - 1, i + Math.floor(rnd() * 14));
    if (seed % 7 === 0) i = 0;
    if (seed % 11 === 0) j = n - 1;
    if (i > j) i = j;
    if (i === 0 && j === n - 1) { mustThrow(() => removeWordsInfo(doc, REF, words, i, j), 'everything'); continue; }
    const r = removeWordsInfo(doc, REF, words, i, j);
    const out = run(doc, r.ops, label);
    const states = wordStates(out, REF, words);
    states.forEach((w) => assert.equal(w.kept, w.i < i || w.i > j, `${label}: word ${w.i} (${i}-${j} cut)`));
    cutsStayOutOfWords(out, words, 30, label);
    assert.ok(r.from % (1 / 30) < 1e-4 || Math.abs((r.from * 30) % 1 - 1) < 1e-4 || on30(r.from), `${label}: from on a frame`);
    assert.ok(on30(r.to), `${label}: to on a frame`);
    near(totalDuration(doc) - totalDuration(out), r.removed, 1 / 30 + 1e-6, `${label}: length adds up`);
    // the kept words move up by exactly what was cut
    // (to within half a frame: when the quiet between two words is narrower than a frame, the cut may graze the word after it)
    for (const w of states.filter((x) => x.kept && x.i > j)) near(w.at, words[w.i].start - r.removed, 0.5 / 30 + 1e-6, `${label}: word ${w.i}`);
    // the picture-only copy is in step
    assert.deepEqual(cov(out, 'v2'), cov(out, 'v1'), `${label}: copy in step`);
    // and back again
    const back = run(out, restoreWords(out, REF, words, i, j), `${label} back`);
    if (j < n - 1) {
      assert.deepEqual(COVER(back, 'v1'), COVER(doc, 'v1'), `${label}: round trip`);
      assert.equal(totalDuration(back), totalDuration(doc), `${label}: round trip length`);
      assert.deepEqual(back.timeline.scenes, doc.timeline.scenes, `${label}: scenes`);
    } else {
      // the last words come back with a short quiet after them, not with all the footage that followed
      const c = COVER(back, 'v1');
      assert.equal(c.length, 1, `${label}: one stretch`);
      assert.ok(c[0].to >= words[n - 1].end && c[0].to <= doc.timeline.duration + 1e-6, `${label}: ends ${c[0].to}`);
    }
  }
});

test('property: a run of random cuts and restores keeps the document valid and every word where the model says', () => {
  for (let seed = 100; seed < 130; seed++) {
    const rnd = mulberry32(seed);
    const n = 30 + Math.floor(rnd() * 60);
    const words = randomWords(rnd, n);
    let doc = speaker(words);
    const model = new Array(n).fill(true);
    const label = `seed ${seed}`;
    for (let step = 0; step < 14; step++) {
      const i = Math.floor(rnd() * n);
      const j = Math.min(n - 1, i + Math.floor(rnd() * 8));
      const restore = rnd() < 0.35;
      let ops;
      try { ops = (restore ? restoreWords : removeWords)(doc, REF, words, i, j); } catch (e) {
        if (e instanceof CutError && e.code === 'everything') continue; // refused: the model stays as it was
        throw e;
      }
      doc = run(doc, ops, `${label} step ${step}`);
      for (let k = i; k <= j; k++) model[k] = restore;
      const states = wordStates(doc, REF, words);
      states.forEach((w) => assert.equal(w.kept, model[w.i], `${label} step ${step}: word ${w.i} after ${restore ? 'restore' : 'cut'} ${i}-${j}`));
      cutsStayOutOfWords(doc, words, 30, `${label} step ${step}`);
      assert.deepEqual(cov(doc, 'v2'), cov(doc, 'v1'), `${label} step ${step}: copy in step`);
      // the timeline is gap-free: the video is exactly as long as what is kept
      const keptTime = coverage(doc, REF).reduce((acc, e) => acc + (e.to - e.from), 0);
      near(totalDuration(doc), keptTime, 2 / 30, `${label} step ${step}: length is the kept footage`);
    }
    const back = run(doc, restoreSourceRange(doc, { ...REF, from: 0, to: 1000 }), `${label} all back`);
    const first = speaker(words);
    assert.deepEqual(COVER(back, 'v1'), COVER(first, 'v1'), `${label}: everything back`);
    assert.equal(totalDuration(back), totalDuration(first));
  }
});

test('cutting 75 s of words from a 120 s recording leaves the arithmetic exact, frame by frame', () => {
  // 330 words, a sentence every 11 words, the way a person talks
  const rnd = mulberry32(7);
  const words = [];
  let t = 1;
  for (let k = 0; k < 330; k++) {
    const dur = 0.2 + rnd() * 0.2;
    words.push({ text: `w${k}${k % 11 === 10 ? '.' : ''}`, start: ms(t), end: ms(t + dur) });
    t += dur + (k % 11 === 10 ? 0.6 : 0.06 + rnd() * 0.1);
  }
  const doc = speaker(words);
  const T = doc.timeline.duration;
  let out = doc;
  let removed = 0;
  for (let s = 29; s >= 0; s -= 2) { // every other sentence goes, from the end so the numbers stay valid
    const r = removeWordsInfo(out, REF, words, s * 11, s * 11 + 10);
    out = run(out, r.ops, `sentence ${s}`);
    removed += r.removed;
  }
  near(totalDuration(doc) - totalDuration(out), removed, 15 / 30, 'the lengths add up');
  assert.equal(T, totalDuration(doc));
  assert.ok(totalDuration(out) < T / 2 + 5);
  cutsStayOutOfWords(out, words, 30, 'sentences');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// documents made by hand or by other tools have clips between frames (times typed in milliseconds): nothing may be re-rounded into an overlap

/** The shape of a real reel: speech clips from far into one recording, cutaways between them, every time a few milliseconds off the frame grid. */
function offTheGrid() {
  const tracks = [{ id: 'v1', type: 'video', clips: [
    { id: 's1', source: 'talk', in: 29.65, out: 33.76, at: 0 },
    { id: 's2', source: 'talk', in: 40.19, out: 47.82, at: 4.11 },
    { id: 's3', source: 'broll', in: 3, out: 5, at: 11.74, mute: true },
    { id: 's4', source: 'broll', in: 1, out: 3.6, at: 13.74, mute: true },
    { id: 's5', source: 'talk', in: 49.01, out: 55, at: 16.34, zoom: { from: 1, to: 1.05 } },
    { id: 's6', source: 'talk', in: 58.25, out: 62.85, at: 22.33 },
  ] }];
  const doc = base({ fps: 30, duration: 26.93, tracks, scenes: [{ id: 'a', start: 0, end: 11.74 }, { id: 'b', start: 11.74, end: 26.93 }] }, { layers: [{ ...TITLE, time: { start: 17.5, end: 21.9 } }] });
  doc.sources[0].duration = 120;
  return doc;
}
const valid = (doc, label) => {
  const errors = validateDocData(doc, { brand, projectDir: SAMPLE, platforms, assets: false }).filter((i) => i.level === 'error');
  assert.deepEqual(errors, [], `${label}: the validator rejects it`);
};

test('a document whose times sit between frames stays valid: neighbours still meet exactly, and what is not cut does not move', () => {
  const doc = offTheGrid();
  valid(doc, 'fixture');
  // (a range that takes in footage no clip plays would bring that back too, so the round trips use ranges inside what is played)
  for (const [from, to, roundTrip] of [[50, 51, true], [41, 42, true], [61, 62, true], [54.5, 55, true], [30, 31, true], [54.5, 59, false], [34, 40.5, false], [29.65, 34, false]]) {
    const r = removeSourceRangeInfo(doc, { track: 'v1', source: 'talk', from, to });
    const out = apply(doc, r.ops);
    valid(out, `remove ${from}-${to}`);
    // the first clip, the cutaways and everything before the cut keep their exact times
    for (const id of ['s3', 's4']) {
      const before = clipsOf(doc, 'v1').find((c) => c.id === id), after = clipsOf(out, 'v1').find((c) => c.id === id);
      assert.ok(after.at <= before.at + 1e-9 && Math.abs(before.at - after.at) < r.removed + 1e-9);
    }
    near(totalDuration(doc) - totalDuration(out), r.removed, 1 / 30 + 1e-6, `length ${from}-${to}`);
    const back = apply(out, restoreSourceRange(out, { track: 'v1', source: 'talk', from, to }));
    valid(back, `restore ${from}-${to}`);
    if (!roundTrip) continue;
    assert.deepEqual(cov(back, 'v1').map((e) => [e.from, e.to]), cov(doc, 'v1').map((e) => [e.from, e.to]), `coverage ${from}-${to}`);
    near(totalDuration(back), totalDuration(doc), 1 / 30 + 1e-6, `length back ${from}-${to}`);
  }
  // a cut that does not reach s3 or s4 leaves them where they were, to the bit
  const early = apply(doc, removeSourceRange(doc, { track: 'v1', source: 'talk', from: 31, to: 32 }));
  assert.deepEqual(clipsOf(early, 'v1').filter((c) => c.id === 's1' || c.id === 's1-b').map((c) => [c.id, c.in, c.out]), [['s1', 29.65, 31], ['s1-b', 32, 33.76]]);
  // trim, split, move and delete on these clips
  valid(apply(doc, splitClip(doc, 's5', 18)), 'split');
  valid(apply(doc, trimClip(doc, 's5', { in: 50 }, { ripple: true })), 'trim ripple');
  valid(apply(doc, trimClip(doc, 's5', { out: 54 })), 'trim');
  valid(apply(doc, deleteClip(doc, 's4')), 'delete');
  valid(apply(doc, moveClip(doc, 's6', 24)), 'move');
});
