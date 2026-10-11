// The render plan: turns a video document's timeline into exactly what has to be drawn and heard, frame by frame,
// and finds the problems that would make the result wrong (a clip past the end of its source, a gap, a speaker cut off).
//
// Everything is counted in frames at the output frame rate, so neighbouring clips never overlap or leave a gap by rounding.
// The picture is a list of segments, each showing one clip (the highest video track wins where clips overlap) or black.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveSizes } from '../render/context.mjs';
import { loadMounts, resolveMediaPath, MountError } from './mounts.mjs';
import { probeMedia, describeProbe } from './probe.mjs';
import { buildCaptions, checkSpeechCuts, speechIn } from './captions.mjs';
import { fillSpec } from './colour.mjs';

export const previewFps = (fps) => Math.max(10, Math.round(fps / 2));
const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** Which platform sizes can carry this video, and how it will be drawn: { id, w, h, safe } */
export function pickSize(doc, platforms, sizeId) {
  const sizes = resolveSizes(doc, platforms);
  const wanted = sizeId ? sizes.find((s) => s.id === sizeId) : sizes.find((s) => !s.preset || s.preset.kinds?.includes('video')) ?? sizes[0];
  if (!wanted) throw new Error(`This document has no size "${sizeId}". Its sizes: ${sizes.map((s) => s.id).join(', ')}`);
  // one render can serve every size with the same pixel shape, so keep text out of all their covered areas
  const same = sizes.filter((s) => s.w === wanted.w && s.h === wanted.h && s.safe);
  const safe = same.length ? {
    top: Math.max(...same.map((s) => s.safe.top)), right: Math.max(...same.map((s) => s.safe.right)),
    bottom: Math.max(...same.map((s) => s.safe.bottom)), left: Math.max(...same.map((s) => s.safe.left)),
  } : wanted.safe ?? { top: 0.05, right: 0.06, bottom: 0.05, left: 0.06 };
  return { id: wanted.id, w: wanted.w, h: wanted.h, safe, sharedWith: same.map((s) => s.id) };
}

/**
 * @param {{doc:object, brand:object, projectDir:string, platforms:object, size?:string, preview?:boolean, scale?:number,
 *          from?:number, to?:number, mounts?:Record<string,string>, fps?:number}} opts
 */
export async function buildPlan(opts) {
  const { doc, brand, projectDir, platforms } = opts;
  const tl = doc.timeline;
  if (!tl) throw new Error('This document has no timeline.');
  const issues = [];
  const add = (level, code, message, extra = {}) => issues.push({ level, code, message, ...extra });
  const block = (code, message, extra = {}) => add('error', code, message, { blocking: true, ...extra });

  const size = pickSize(doc, platforms, opts.size);
  const scale = opts.scale ?? (opts.preview ? 0.5 : 1);
  const width = even(size.w * scale);
  const height = even(size.h * scale);
  const fps = opts.fps ?? (opts.preview ? previewFps(tl.fps) : tl.fps);
  const totalFrames = Math.max(1, Math.round(tl.duration * fps));
  const fromF = clamp(Math.round((opts.from ?? 0) * fps), 0, totalFrames - 1);
  const toF = clamp(Math.round((opts.to ?? tl.duration) * fps), fromF + 1, totalFrames);
  const mounts = opts.mounts ?? loadMounts(projectDir);
  // nordle.project.json {"video": {"footageGrade": "warm"}} grades all real footage in this project's videos the same way
  // (clips that name their own grade keep it), so a look can change without editing any post.
  let projectGrade = null;
  try { projectGrade = JSON.parse(readFileSync(join(projectDir, 'nordle.project.json'), 'utf8'))?.video?.footageGrade ?? null; } catch { /* no project settings */ }
  const preview = !!opts.preview;

  // ---- sources: where they are, what they really contain
  const sources = new Map();
  const used = new Set(tl.tracks.flatMap((t) => t.clips.map((c) => c.source)));
  if (tl.captions) used.add(tl.captions.source);
  for (const s of doc.sources ?? []) {
    if (!used.has(s.id)) continue;
    const entry = { id: s.id, type: s.type, rel: s.path, note: s.note, abs: null, probe: null, transcriptAbs: null, lutAbs: null, lutRange: s.lutRange ?? 'full', levels: s.levels ?? null, exposure: typeof s.exposure === 'number' ? s.exposure : 0 };
    sources.set(s.id, entry);
    let rel = s.path;
    if (preview && s.proxy) {
      try { const p = resolveMediaPath(projectDir, s.proxy, mounts); if (existsSync(p)) { rel = s.proxy; entry.usingProxy = true; } } catch { /* use the original */ }
    }
    if (s.lut) {
      try { entry.lutAbs = resolveMediaPath(projectDir, s.lut, mounts); if (!existsSync(entry.lutAbs)) { block('lut-missing', `Source "${s.id}": the colour LUT ${s.lut} is not there.`, { source: s.id }); entry.lutAbs = null; } } catch (e) { block('lut-path', `Source "${s.id}": ${e.message}`, { source: s.id }); }
    }
    try {
      entry.abs = resolveMediaPath(projectDir, rel, mounts);
      if (!existsSync(entry.abs)) { block('source-missing', `Source "${s.id}": the file ${rel} is not there.`, { source: s.id }); continue; }
      entry.probe = await probeMedia(entry.abs);
    } catch (e) {
      block(e instanceof MountError ? e.code : 'source-unreadable', `Source "${s.id}": ${e.message}`, { source: s.id });
      continue;
    }
    const kind = entry.probe.kind;
    if (s.type === 'audio' && !entry.probe.hasAudio) block('source-kind', `Source "${s.id}" is meant to be audio but the file has no sound (${describeProbe(entry.probe)}).`, { source: s.id });
    if (s.type === 'video' && kind === 'audio') block('source-kind', `Source "${s.id}" is meant to be video but the file is audio only.`, { source: s.id });
    if (s.type === 'video' && kind === 'image') block('source-kind', `Source "${s.id}" is declared as video but the file is a picture. Declare it as type "image".`, { source: s.id });
    if (s.type === 'image' && kind !== 'image') block('source-kind', `Source "${s.id}" is declared as an image but the file is ${kind}.`, { source: s.id });
    if (s.type === 'video' && kind === 'video' && s.duration && Math.abs(entry.probe.duration - s.duration) > 0.5) {
      add('warn', 'source-duration', `Source "${s.id}": the document says ${s.duration}s but the file is ${entry.probe.duration.toFixed(2)}s long.`, { source: s.id });
    }
    if (s.transcript) {
      try { entry.transcriptAbs = resolveMediaPath(projectDir, s.transcript, mounts); } catch (e) { add('warn', 'transcript-path', `Source "${s.id}": ${e.message}`, { source: s.id }); }
      if (entry.transcriptAbs && !existsSync(entry.transcriptAbs)) { add('warn', 'transcript-missing', `Source "${s.id}": the transcript ${s.transcript} is not there.`, { source: s.id }); entry.transcriptAbs = null; }
    }
  }

  // ---- clips
  const soloed = tl.tracks.some((t) => t.solo);
  const clips = [];
  tl.tracks.forEach((track, trackIndex) => {
    const own = [];
    for (const c of track.clips) {
      const src = sources.get(c.source);
      const isImage = src?.probe?.kind === 'image';
      const speed = isImage ? 1 : c.speed ?? 1;
      const span = c.out - c.in;
      const dur = isImage ? span : span / speed;
      const startF = Math.round(c.at * fps);
      const endF = Math.max(startF + 1, Math.round((c.at + dur) * fps));
      const clip = {
        id: c.id, raw: c, trackId: track.id, trackType: track.type, trackIndex, sourceId: c.source, src, isImage,
        in: c.in, out: c.out, at: c.at, speed, dur, startF, endF,
        fit: c.fit ?? 'cover', focal: c.focal ?? { x: 0.5, y: 0.5 }, mute: !!c.mute || !!track.mute || (soloed && !track.solo),
        gainDb: c.gainDb ?? 0, fade: c.fade ?? {}, duck: c.duck ?? null,
        grade: !isImage && projectGrade && (!c.grade || c.grade === 'neutral' || c.grade === 'none') ? projectGrade : c.grade ?? 'none', denoise: !!c.denoise, cleanAudio: !!c.cleanAudio, transition: c.transition ?? null, zoom: c.zoom ?? null, pan: c.pan ?? null,
      };
      if (src?.probe && !isImage) {
        const limit = src.probe.duration;
        if (c.in >= limit - 0.001) block('clip-range', `Clip "${c.id}" starts at ${c.in}s but source "${c.source}" is only ${limit.toFixed(2)}s long.`, { clip: c.id });
        else if (c.out > limit + 0.1) block('clip-range', `Clip "${c.id}" runs to ${c.out}s, past the end of source "${c.source}" (${limit.toFixed(2)}s).`, { clip: c.id });
        else if (c.out > limit) clip.out = limit;
      }
      if (track.type === 'video' && src?.probe && !src.probe.video) block('clip-kind', `Clip "${c.id}" is on a video track but source "${c.source}" has no picture.`, { clip: c.id });
      if (clip.endF > totalFrames) add('warn', 'clip-past-end', `Clip "${c.id}" runs past the end of the timeline and is cut off at ${tl.duration}s.`, { clip: c.id });
      own.push(clip);
    }
    own.sort((a, b) => a.startF - b.startF);
    for (let i = 1; i < own.length; i++) {
      if (own[i].startF < own[i - 1].endF) block('clip-overlap', `Clips "${own[i - 1].id}" and "${own[i].id}" overlap on track "${track.id}". Put one on another track.`, { clip: own[i].id });
    }
    clips.push(...own);
  });

  // ---- the picture: segments of the timeline, each showing one clip or black
  const videoClips = clips.filter((c) => c.trackType === 'video');
  const bounds = new Set([0, totalFrames]);
  for (const c of videoClips) { bounds.add(clamp(c.startF, 0, totalFrames)); bounds.add(clamp(c.endF, 0, totalFrames)); }
  const cuts = [...bounds].sort((a, b) => a - b);
  const raw = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const [s, e] = [cuts[i], cuts[i + 1]];
    if (e <= s) continue;
    const covering = videoClips.filter((c) => c.startF <= s && c.endF >= e);
    const top = covering.sort((a, b) => b.trackIndex - a.trackIndex)[0] ?? null;
    const last = raw.at(-1);
    if (last && last.clip === top && last.e === s) last.e = e;
    else raw.push({ clip: top, s, e });
  }
  let segments = raw.map((r) => ({
    kind: r.clip ? 'clip' : 'black', clip: r.clip, clipId: r.clip?.id ?? null, s: r.s, e: r.e,
    srcStart: r.clip && !r.clip.isImage ? r.clip.in + ((r.s - r.clip.startF) / fps) * r.clip.speed : 0,
    srcSpan: r.clip && !r.clip.isImage ? ((r.e - r.s) / fps) * r.clip.speed : 0,
    ext: 0, transitionIn: null, fadeIn: 0, fadeOut: 0,
  }));
  const background = fillSpec(tl.background, brand, doc.colourway);
  for (const g of segments.filter((s) => s.kind === 'black')) {
    if (!background && g.e - g.s >= 2) add('warn', 'gap', `Nothing is on the picture tracks from ${(g.s / fps).toFixed(2)}s to ${(g.e / fps).toFixed(2)}s, so it will be black.`, { time: g.s / fps });
  }

  // transitions: a clip's `transition` happens at its own first frame, so only a segment that begins the clip can have one
  segments.forEach((seg, i) => {
    const c = seg.clip;
    const tr = c?.transition;
    if (i === 0 || !c || !tr || tr.type === 'cut' || seg.s !== c.startF) return;
    const prev = segments[i - 1];
    const wanted = Math.max(1, Math.round((tr.duration ?? 0.4) * fps));
    const d = Math.min(wanted, seg.e - seg.s, prev.e - prev.s);
    if (d < wanted) add('warn', 'transition-short', `The ${tr.type} into "${c.id}" was shortened to ${(d / fps).toFixed(2)}s because a neighbouring clip is that short.`, { clip: c.id });
    if (tr.type === 'dip') { prev.fadeOut = Math.max(prev.fadeOut, Math.ceil(d / 2)); seg.fadeIn = Math.max(seg.fadeIn, Math.floor(d / 2) || 1); } else {
      seg.transitionIn = { type: tr.type, frames: d, direction: tr.direction ?? 'left' };
      prev.ext = d;
    }
  });
  // a second transition may not start while the one before it is still going
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    const prev = segments[i - 1];
    if (seg.transitionIn && prev.transitionIn && prev.transitionIn.frames + seg.transitionIn.frames > prev.e - prev.s) {
      add('warn', 'transition-overlap', `The transitions into "${prev.clipId}" and "${seg.clipId}" would overlap, so the second one was turned into a cut.`, { clip: seg.clipId });
      prev.ext = 0;
      seg.transitionIn = null;
    }
  }

  // ---- only the part of the timeline that is wanted (a partial render)
  if (fromF > 0 || toF < totalFrames) {
    segments = segments.filter((s) => s.e > fromF && s.s < toF).map((s) => {
      const out = { ...s };
      out.s = Math.max(s.s, fromF);
      out.e = Math.min(s.e, toF);
      if (s.clip && !s.clip.isImage) { out.srcStart = s.srcStart + ((out.s - s.s) / fps) * s.clip.speed; out.srcSpan = ((out.e - out.s) / fps) * s.clip.speed; }
      if (out.s !== s.s) { out.transitionIn = null; out.fadeIn = 0; }
      if (out.e !== s.e) { out.ext = 0; out.fadeOut = 0; }
      return out;
    });
    for (let i = 0; i < segments.length; i++) {
      if (segments[i].transitionIn && (i === 0 || segments[i - 1].ext === 0)) segments[i].transitionIn = null;
    }
  }
  segments.forEach((s, i) => { s.index = i; });

  // ---- audio: every clip that makes sound
  const audioClips = [];
  for (const c of clips) {
    if (c.mute || !c.src?.probe?.hasAudio || c.isImage) continue;
    audioClips.push({
      id: c.id, trackId: c.trackId, sourceId: c.sourceId, abs: c.src.abs, in: c.in, out: c.out, at: c.at, speed: c.speed, dur: c.dur,
      gainDb: c.gainDb, fade: c.fade, duck: c.duck, cleanAudio: c.cleanAudio, channels: c.src.probe.audio[0]?.channels ?? 2,
    });
  }
  for (const c of clips) {
    if (c.duck && !tl.tracks.some((t) => t.id === c.duck.under)) block('duck-track', `Clip "${c.id}" ducks under track "${c.duck.under}", which does not exist.`, { clip: c.id });
  }

  const plan = {
    docId: doc.id, size, width, height, scale, fps, preview, background,
    duration: tl.duration, totalFrames, fromF, toF, frames: toF - fromF, from: fromF / fps, to: toF / fps,
    sources, clips, segments, audioClips, issues, projectDir, brand, mounts,
    scenes: tl.scenes ?? [],
    captions: null,
  };

  // ---- captions and speech checks
  try {
    const captions = await buildCaptions(plan, doc, brand);
    plan.captions = captions;
    issues.push(...captions.issues);
  } catch (e) {
    add('error', 'captions', `Captions could not be built: ${e.message}`, { blocking: true });
  }
  issues.push(...(await checkSpeechCuts(plan)));

  plan.blocking = issues.filter((i) => i.blocking);
  plan.problems = (level) => issues.filter((i) => i.level === level);
  plan.speechIn = (start, end) => speechIn(plan, start, end);
  return plan;
}

/** The segment that is on screen at output frame f (an absolute timeline frame), and how far into it. */
export function locate(plan, f) {
  const seg = plan.segments.find((s) => f >= s.s && f < s.e) ?? plan.segments.at(-1);
  return { seg, k: clamp(f - seg.s, 0, seg.e - seg.s - 1) };
}

/** A short, plain description of the plan for people and Claude. */
export function summarisePlan(plan) {
  const t = (f) => Number((f / plan.fps).toFixed(2));
  return {
    size: `${plan.width}x${plan.height} at ${plan.fps} fps`,
    seconds: Number((plan.frames / plan.fps).toFixed(2)),
    segments: plan.segments.map((s) => ({
      from: t(s.s), to: t(s.e), shows: s.clipId ?? (plan.background ? 'background' : 'black'), source: s.clip?.sourceId,
      ...(s.transitionIn ? { transition: `${s.transitionIn.type} ${t(s.transitionIn.frames)}s` } : {}),
    })),
    issues: plan.issues.map(({ level, code, message, clip, time }) => ({ level, code, message, ...(clip ? { clip } : {}), ...(time !== undefined ? { time: Number(time.toFixed(2)) } : {}) })),
  };
}
