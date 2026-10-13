// The motion check: is this video edited and animated like a motion designer made it? Nordle's standard is "go all out", and this is where that
// standard is enforced rather than hoped for. Read from the document alone (no rendering), so it runs everywhere and in a second:
//
//   motion-text-static     text that simply appears, with no entrance at all                                         error
//   motion-dead-air        a stretch where nothing on screen moves (no footage playing, no photo push, no animation)  warn from 2.5 s, error from 4 s
//                          (the closing card may hold still for up to 3.5 s so people can read it; the cover frame at the very end is ignored)
//   motion-hook            nothing moving or written in the first half second                                       warn
//   motion-same-entrance   every element comes in the same way (fewer than three kinds of entrance)                  warn
//   motion-flat-graphics   a reel made only of graphics with nothing alive in the background (no loops, no keyframes) warn
//   motion-no-ending       the last seconds carry no closing card, logo or call to action                            warn
//
// Score: 100, less 20 for each error and 7 for each warning. It passes at 85, so one error, or three warnings, fails the post and Claude must
// improve it before the owner sees it. `motionReport(doc)` returns { score, passScore, findings, stats }.

import { error, info, warn } from './findings.mjs';

export const MOTION_PASS = 85;
const END_HOLD = 3.5;
const ENTRANCES = new Set(['fade-in', 'rise-in', 'fall-in', 'pop', 'slide-in', 'wipe', 'typewriter', 'word-by-word', 'scale-in', 'blur-in', 'spin-in', 'tracking-in', 'reveal-circle', 'count-up', 'draw']);
const LOOPS = new Set(['float', 'sway', 'pulse', 'drift']);
const r2 = (n) => Math.round(n * 100) / 100;

const hasText = (l) => l.type === 'text' || (l.type === 'group' && (l.children ?? []).some(hasText));

/** Every moment something on screen is moving: footage playing, a photo being pushed, a layer animating (entrance, exit, keyframes or a loop). */
function movingWindows(doc) {
  const out = [];
  const srcType = new Map((doc.sources ?? []).map((s) => [s.id, s.type]));
  for (const t of doc.timeline?.tracks ?? []) {
    if (t.type !== 'video') continue;
    for (const c of t.clips ?? []) {
      const len = ((c.out ?? 0) - (c.in ?? 0)) / (c.speed ?? 1);
      if (!(len > 0)) continue;
      const still = srcType.get(c.source) === 'image';
      const pushed = c.zoom && c.zoom.from !== c.zoom.to;
      if (!still || pushed || c.pan) out.push([c.at ?? 0, (c.at ?? 0) + len]);
    }
  }
  for (const l of doc.layers ?? []) {
    if (!l.time) continue;
    for (const a of l.animate ?? []) {
      const s = l.time.start + (a.at ?? 0);
      if (LOOPS.has(a.preset)) { out.push([s, l.time.end]); continue; }
      const d = a.keyframes ? Math.max(...a.keyframes.map((k) => k.t)) : (a.duration ?? 0.5);
      const start = a.preset?.endsWith('-out') && a.at === undefined ? Math.max(l.time.start, l.time.end - d) : s;
      out.push([start, start + d]);
    }
  }
  return out;
}

export function motionReport(doc) {
  const findings = [];
  if (doc.kind !== 'video') return { score: 100, passScore: MOTION_PASS, findings: [info('motion-not-video', 'Not a video: the design check covers it.')], stats: {} };
  const scenes = doc.timeline?.scenes ?? [];
  // the cover frame (a few frames of the cover picture at the very end, for the publishing service) is not part of the edit
  const coverScene = scenes.at(-1) && /cover/i.test(scenes.at(-1).title ?? '') && scenes.at(-1).end - scenes.at(-1).start <= 0.25 ? scenes.at(-1) : null;
  const dur = coverScene ? coverScene.start : (doc.timeline?.duration ?? 0);
  const lastScene = scenes.filter((s) => s !== coverScene).at(-1);
  const layers = (doc.layers ?? []).filter((l) => l.time);

  // text that just appears
  for (const l of layers) {
    if (!hasText(l)) continue;
    const on = l.time.end - l.time.start;
    if (on < 0.6) continue;
    const comesIn = (l.animate ?? []).some((a) => a.keyframes || ENTRANCES.has(a.preset));
    if (!comesIn) findings.push(error('motion-text-static', `"${l.id}" appears with no motion at all (${r2(l.time.start)} s).`, { layer: l.id, time: l.time.start, fix: 'Give it an entrance: blur-in, tracking-in, slide-in, scale-in, rise-in or typewriter (docs/VIDEO.md "The motion kit"), and stagger it against what comes in with it.' }));
  }

  // stretches where nothing moves
  const win = movingWindows(doc);
  const step = 0.1;
  let longest = 0, from = 0, runStart = null;
  for (let t = 0; t <= dur + 1e-9; t += step) {
    const moving = win.some(([a, b]) => t >= a - 1e-6 && t < b + 1e-6);
    if (!moving && runStart === null) runStart = t;
    if ((moving || t + step > dur) && runStart !== null) {
      const len = (moving ? t : dur) - runStart;
      const closingHold = !moving && len <= END_HOLD;   // the last card held so it can be read
      if (!closingHold && len > longest) { longest = len; from = runStart; }
      runStart = null;
    }
  }
  if (longest >= 4) findings.push(error('motion-dead-air', `Nothing moves for ${r2(longest)} s from ${r2(from)} s.`, { time: from, fix: 'Keep it alive: a slow push on the photo, a loop on the background (float, drift, pulse), a new element arriving, or a shorter scene.' }));
  else if (longest >= 2.5) findings.push(warn('motion-dead-air', `Nothing moves for ${r2(longest)} s from ${r2(from)} s.`, { time: from, fix: 'Add movement in that stretch (a push, a loop, a second element arriving) or shorten it.' }));

  // the first half second
  const early = win.some(([a]) => a <= 0.5) || layers.some((l) => hasText(l) && l.time.start <= 0.5);
  if (dur > 0 && !early) findings.push(warn('motion-hook', 'Nothing moves or is written in the first half second: the scroll does not stop for a still frame.', { time: 0, fix: 'Open on movement or a hook line that arrives at once.' }));

  // variety of entrances
  const used = new Set();
  let animated = 0;
  for (const l of layers) {
    const ins = (l.animate ?? []).filter((a) => ENTRANCES.has(a.preset) || a.keyframes);
    if (ins.length) animated++;
    for (const a of ins) used.add(a.keyframes ? 'keyframes' : a.preset);
  }
  if (animated >= 4 && used.size < 3) findings.push(warn('motion-same-entrance', `Every element comes in the same way (${[...used].join(', ') || 'none'}).`, { fix: 'Mix the entrances: tracking-in for kickers, blur-in or slide-in for lines, scale-in or pop for the key word or number, draw for lines and rings.' }));

  // graphics-only reels need life behind them
  const srcType = new Map((doc.sources ?? []).map((s) => [s.id, s.type]));
  const footage = (doc.timeline?.tracks ?? []).some((t) => t.type === 'video' && (t.clips ?? []).some((c) => srcType.get(c.source) === 'video'));
  const alive = layers.filter((l) => (l.animate ?? []).some((a) => LOOPS.has(a.preset) || (a.keyframes && a.keyframes.length >= 2))).length;
  if (!footage && dur > 0 && alive < 2) findings.push(warn('motion-flat-graphics', 'A reel made only of graphics with nothing alive behind the words.', { fix: 'Use motion scenes with a moving background (aurora, glow, specks) or add loops (float, drift, pulse) and keyframed shapes.' }));

  // how it ends
  const endScene = /\b(end|close|closing|cta|outro|logo|sign.?off)\b/i.test(lastScene?.title ?? '');
  const ends = endScene || layers.some((l) => l.time.end >= dur - 0.05 && l.time.start < dur && (hasText(l) || l.type === 'image'));
  if (dur > 4 && !ends) findings.push(warn('motion-no-ending', 'The last seconds have no closing card, logo or call to action.', { fix: 'End on a closing card or a logo scene (or an endPanel over the last shot).' }));

  const errors = findings.filter((f) => f.level === 'error').length, warns = findings.filter((f) => f.level === 'warn').length;
  const score = Math.max(0, 100 - errors * 20 - warns * 7);
  return { score, passScore: MOTION_PASS, findings, stats: { duration: dur, longestStill: r2(longest), entrances: [...used], animatedLayers: animated, footage, aliveLayers: alive } };
}
