// Renders a video document to an mp4 (or webm, gif, ProRes), and looks at frames of it without rendering all of it.
//
//   renderVideo(docFile, { out, from, to, preview, browser, onProgress, size, signal, format, maxWidth })
//       -> <project>/out/<doc id>/<doc id>.<mp4|webm|gif|mov>, <doc id>-cover.jpg and sheet.png (not for a GIF)
//          format: 'mp4' (default) | 'webm' | 'gif' | 'prores'  (src/video/formats.mjs); the result says which in `format` and `file`
//   videoStills(docFile, [seconds], { preview|scale, format })   real picture + overlay at exactly those times, no full render
//   videoSheet(docFile)                                          a few frames per scene with what is said, written to sheet.png
//
// The picture, the overlay and the sound are made at the same time, each by its own program, into a temporary folder
// (os.tmpdir(), removed afterwards). One last ffmpeg pass joins them. Footage is only read where the timeline uses it.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { loadDocContext } from '../render/context.mjs';
import { openBrowser } from '../render/browser.mjs';
import { binary, filterScriptArgs, n6, pool, run } from './ffmpeg.mjs';
import { probeMedia } from './probe.mjs';
import { FORMATS, GIF_FPS, encodeArgs, encoderProblem, gifGraph, gifProblem, normaliseFormat } from './formats.mjs';
import { buildPlan, locate, summarisePlan } from './plan.mjs';
import { OVERLAY_TO_YUV, TO_RGB, frameArgs, renderSegments, segmentArgs, tailFrames } from './picture.mjs';
import { renderAudio } from './audio.mjs';
import { buildOverlay, checkOverlayPlacement, frameKeys, openOverlayPage, renderOverlaySequence } from './overlay.mjs';
import { renderVideoSheet, sheetScenes } from './sheet.mjs';

const now = () => Date.now();
const secs = (ms) => Number((ms / 1000).toFixed(2));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** Load, validate and plan a video document. Returns { ctx, plan } or { ctx, errors } when it cannot be rendered. */
async function prepare(docFile, opts) {
  const ctx = loadDocContext(docFile);
  if (ctx.doc.kind !== 'video') throw new Error(`"${ctx.doc.id}" is a ${ctx.doc.kind}, not a video. Video documents have kind "video" and a timeline.`);
  if (ctx.errors.length) return { ctx, errors: ctx.errors.map((e) => ({ level: 'error', code: 'document', message: `${e.path}: ${e.message}`, blocking: true })) };
  const doc = opts.doc ?? ctx.doc;
  const plan = await buildPlan({
    doc, brand: ctx.brand, projectDir: ctx.projectDir, platforms: ctx.platforms,
    size: opts.size, preview: opts.preview, scale: opts.scale, from: opts.from, to: opts.to, fps: opts.fps,
  });
  if (plan.blocking.length) return { ctx, plan, errors: plan.blocking };
  return { ctx, plan };
}

function assembleGraph(plan, overlayIndex) {
  const F = plan.fps;
  const lines = [];
  plan.segments.forEach((s, i) => lines.push(`[${i}:v]setpts=PTS-STARTPTS,fps=${F},format=yuv420p,setsar=1[v${i}]`));
  let cur = 'v0';
  for (let i = 1; i < plan.segments.length; i++) {
    const s = plan.segments[i];
    const tin = s.transitionIn;
    if (tin) {
      const name = tin.type === 'slide' ? `slide${tin.direction}` : 'fade';
      lines.push(`[${cur}][v${i}]xfade=transition=${name}:duration=${n6(tin.frames / F)}:offset=${n6((s.s - plan.fromF) / F)}[x${i}]`);
    } else {
      // concat counts in microseconds; bring the clock back to frames so a later xfade sees matching time bases
      lines.push(`[${cur}][v${i}]concat=n=2:v=1:a=0,fps=${F}[x${i}]`);
    }
    cur = `x${i}`;
  }
  if (overlayIndex === null) {
    lines.push(`[${cur}]fps=${F},format=yuv420p,setsar=1[outv]`);
  } else {
    lines.push(`[${cur}]fps=${F},format=yuv420p[base]`);
    lines.push(`[${overlayIndex}:v]setpts=PTS-STARTPTS,fps=${F},${OVERLAY_TO_YUV}[ov]`);
    lines.push('[base][ov]overlay=0:0:format=auto:eof_action=pass:repeatlast=0,format=yuv420p,setsar=1[outv]');
  }
  return lines.join(';\n');
}

/** One frame of a finished video as a JPEG or PNG file. */
async function frameFromVideo(file, t, out, { width, height } = {}) {
  const jpg = out.endsWith('.jpg');
  const scale = width ? `scale=${width}:${height}:flags=lanczos,` : '';
  const vf = `${scale}${TO_RGB}${jpg ? ',format=yuvj420p' : ''}`;
  const tail = [...(jpg ? ['-q:v', '2'] : []), out];
  await run(['-ss', n6(Math.max(0, t)), '-i', file, '-frames:v', '1', '-vf', vf, ...tail], { label: 'Frame of the finished video' });
  // a time at or past the last frame gives no picture and no error: take the last frame instead
  if (!existsSync(out)) await run(['-sseof', '-0.2', '-i', file, '-vf', vf, '-update', '1', ...tail], { label: 'Last frame of the finished video' });
  if (!existsSync(out)) throw new Error(`Could not take a frame at ${t}s from the finished video.`);
}

/**
 * @param {string} docFile path to a video document
 * @param {{ out?:string, from?:number, to?:number, preview?:boolean, browser?:object, onProgress?:Function, size?:string,
 *           signal?:AbortSignal, keepTemp?:boolean, normalize?:boolean, format?:'mp4'|'webm'|'gif'|'prores', maxWidth?:number,
 *           encoders?:Set<string> }} [opts]
 *   format: the kind of file (default mp4). A GIF has no sound, is at most 30 s and `maxWidth` (default 540) wide.
 *   encoders: the encoder names to believe instead of asking ffmpeg (tests).
 */
export async function renderVideo(docFile, opts = {}) {
  const started = now();
  const timings = {};
  const format = normaliseFormat(opts.format);
  const spec = FORMATS[format];
  const prep = await prepare(docFile, opts);
  const { ctx } = prep;
  const doc = ctx.doc;
  if (prep.errors) return { ok: false, doc: doc.id, format, errors: prep.errors, issues: prep.plan?.issues ?? prep.errors, files: {} };
  const { plan } = prep;
  timings.planSeconds = secs(now() - started);
  // a format this ffmpeg cannot make, or a GIF that is too long: say so before any work is done
  const refuse = (code, message) => ({ ok: false, doc: doc.id, format, errors: [{ level: 'error', code, message, blocking: true }], issues: [{ level: 'error', code, message, blocking: true }], files: {} });
  const missing = encoderProblem(format, opts.encoders);
  if (missing) return refuse('encoder-missing', missing);
  if (format === 'gif') {
    const tooLong = gifProblem(plan.frames / plan.fps);
    if (tooLong) return refuse('gif-too-long', tooLong);
  }

  const partial = plan.fromF > 0 || plan.toF < plan.totalFrames;
  const outDir = opts.out ?? join(ctx.projectDir, 'out', doc.id);
  mkdirSync(outDir, { recursive: true });
  const suffix = [opts.preview ? 'preview' : null, partial ? `${plan.from.toFixed(1)}-${plan.to.toFixed(1)}s` : null].filter(Boolean).join('.');
  const baseName = `${doc.id}${suffix ? `.${suffix}` : ''}`;
  const video = join(outDir, `${baseName}.${spec.ext}`);

  const tmp = mkdtempSync(join(os.tmpdir(), 'nordle-video-'));
  const ac = new AbortController();
  if (opts.signal) opts.signal.addEventListener('abort', () => ac.abort(), { once: true });
  const signal = ac.signal;
  const W = { pictures: 0.38, overlay: 0.1, audio: 0.05, final: 0.47 };
  const prog = { pictures: 0, overlay: 0, audio: 0, final: 0 };
  const report = (stage, fraction, message) => {
    prog[stage] = clamp(fraction, 0, 1);
    const percent = Math.round(Object.keys(W).reduce((a, k) => a + W[k] * prog[k], 0) * 100);
    opts.onProgress?.({ stage, percent, message });
  };

  let browser = opts.browser;
  const ownBrowser = !browser;
  try {
    const overlay = buildOverlay(plan, doc, ctx.brand);
    plan.issues.push(...overlay.issues);
    if (!overlay.empty && !browser) browser = await openBrowser();

    // the three parts, at the same time
    const guarded = (fn) => fn().catch((e) => { ac.abort(); throw e; });
    const picturesAt = now();
    let audioMs = 0, overlayMs = 0, picturesMs = 0;
    const [segmentFiles, audio, overlaySeq] = await Promise.all([
      guarded(async () => {
        const r = await renderSegments(plan, tmp, { signal, onProgress: (p) => report('pictures', p.done / Math.max(1, p.total), `Picture ${p.segments}/${p.segmentTotal}`) });
        picturesMs = now() - picturesAt;
        return r;
      }),
      guarded(async () => {
        const t0 = now();
        if (!spec.sound) { report('audio', 1, 'No sound in this format'); return { wav: null, silent: true, loudness: null, ducking: [] }; }
        const r = await renderAudio(plan, { dir: tmp, normalize: opts.normalize !== false, signal });
        audioMs = now() - t0;
        report('audio', 1, 'Sound ready');
        return r;
      }),
      guarded(async () => {
        const t0 = now();
        if (overlay.empty) { report('overlay', 1, 'No overlay'); return null; }
        const placement = await checkOverlayPlacement(browser, plan, overlay);
        plan.issues.push(...placement);
        const r = await renderOverlaySequence(browser, plan, overlay, join(tmp, 'overlay'), { onProgress: (p) => report('overlay', p.done / Math.max(1, p.total), `Overlay ${p.done}/${p.total}`) });
        overlayMs = now() - t0;
        report('overlay', 1, 'Overlay ready');
        return r;
      }),
    ]);
    timings.picturesSeconds = secs(picturesMs);
    timings.audioSeconds = secs(audioMs);
    timings.overlaySeconds = secs(overlayMs);

    // the final pass
    const finalAt = now();
    const inputs = [];
    for (const s of plan.segments) inputs.push('-i', segmentFiles.get(s.index));
    let overlayIndex = null;
    if (overlaySeq) { overlayIndex = plan.segments.length; inputs.push('-f', 'concat', '-safe', '0', '-i', overlaySeq.list); }
    const audioIndex = plan.segments.length + (overlaySeq ? 1 : 0);
    if (spec.sound) inputs.push('-i', audio.wav);
    let graph = assembleGraph(plan, overlayIndex);
    let pictureLabel = '[outv]';
    if (format === 'gif') { graph += `;\n${gifGraph(plan, opts.maxWidth)}`; pictureLabel = '[gif]'; }
    const preview = !!opts.preview;
    const outFrames = format === 'gif' ? Math.max(1, Math.round((plan.frames / plan.fps) * GIF_FPS)) : plan.frames;
    await run([
      ...inputs, ...filterScriptArgs(tmp, 'final.txt', graph),
      '-map', pictureLabel, ...(spec.sound ? ['-map', `${audioIndex}:a:0`] : []),
      ...encodeArgs(format, { fps: plan.fps, frames: plan.frames, preview }),
      video,
    ], { signal, label: 'Joining picture, overlay and sound', onProgress: (p) => { if (p.frame !== undefined) report('final', p.frame / outFrames, `Encoding ${Math.round(clamp(p.frame / outFrames, 0, 1) * 100)}%`); } });
    report('final', 1, 'Encoded');
    timings.finalSeconds = secs(now() - finalAt);

    // what came out
    const probed = await probeMedia(video, { animated: true });
    const output = {
      width: probed.video.width, height: probed.video.height, fps: Number(probed.video.fps.toFixed(3)), duration: Number(probed.duration.toFixed(3)),
      expectedDuration: Number((plan.frames / plan.fps).toFixed(3)), videoCodec: probed.video.codec, audio: probed.audio[0] ? `${probed.audio[0].codec} ${probed.audio[0].sampleRate} Hz ${probed.audio[0].channels} ch` : null, bytes: probed.size,
    };
    if (Math.abs(output.duration - output.expectedDuration) > 0.2) plan.issues.push({ level: 'warn', code: 'duration', message: `The file is ${output.duration}s long but the timeline is ${output.expectedDuration}s.` });

    const files = { video };
    // a GIF keeps no cover or contact sheet: pictures taken from a 256-colour, 15 fps copy would be poor (`video sheet` makes one without rendering)
    if (!partial && format !== 'gif') {
      // cover
      const coverT = clamp(doc.timeline.cover ?? ((plan.scenes[0]?.start ?? 0) + 0.3), 0, plan.duration - 1 / plan.fps);
      if (!preview) {
        files.cover = join(outDir, `${doc.id}-cover.jpg`);
        await frameFromVideo(video, coverT, files.cover);
      }
      // contact sheet, from the finished file
      const sheetAt = now();
      const scenes = sheetScenes(plan);
      const times = scenes.flatMap((s) => s.times);
      const thumbs = new Map();
      const thumbW = 360, thumbH = Math.round((thumbW * plan.height) / plan.width / 2) * 2;
      await pool(times, 6, async (t, i) => {
        const f = join(tmp, `thumb-${i}.jpg`);
        await frameFromVideo(video, t, f, { width: thumbW, height: thumbH });
        thumbs.set(i, { dataUrl: `data:image/jpeg;base64,${readFileSync(f).toString('base64')}` });
      });
      browser ??= await openBrowser();
      files.sheet = await renderVideoSheet({ plan, doc, browser, scenes, frames: thumbs, outDir, issues: plan.issues });
      timings.sheetSeconds = secs(now() - sheetAt);
    }
    report('final', 1, 'Done');
    timings.totalSeconds = secs(now() - started);
    const issues = plan.issues.filter((i) => !i.blocking);
    return {
      ok: true, doc: doc.id, format, file: video, files, output, timings, issues,
      summary: summarisePlan(plan),
      overlay: overlaySeq ? { distinctPictures: overlaySeq.distinct, drawn: overlaySeq.drawn, frames: overlaySeq.frames } : null,
      audio: { loudness: audio.loudness ? { measuredBefore: audio.loudness.before.integrated, target: audio.loudness.target } : null, ducking: audio.ducking, silent: audio.silent },
      captions: plan.captions?.enabled ? { lines: plan.captions.events.length } : null,
    };
  } finally {
    if (ownBrowser) await browser?.close().catch(() => {});
    if (!opts.keepTemp && process.env.NORDLE_KEEP_TEMP !== '1') try { rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }); } catch { /* a handle still open; the OS temp cleaner takes it */ }
  }
}

// ------------------------------------------------------------------------------------------------ stills

/**
 * Real frames, at exactly these times, with the overlay on top. Each one is drawn on its own: only the footage around
 * that moment is read.
 * @returns {Promise<{ ok:boolean, files:Array<{t:number, frame:number, path:string, w:number, h:number}>, issues:Array, errors?:Array }>}
 */
export async function videoStills(docFile, times, opts = {}) {
  const scale = opts.scale ?? (opts.preview ? 0.5 : 1);
  const prep = await prepare(docFile, { ...opts, scale, preview: false });
  if (prep.errors) return { ok: false, errors: prep.errors, files: [], issues: prep.errors };
  const { ctx, plan } = prep;
  const doc = ctx.doc;
  const format = opts.format === 'jpg' ? 'jpg' : 'png';
  const outDir = opts.out ?? mkdtempSync(join(os.tmpdir(), 'nordle-stills-'));
  mkdirSync(outDir, { recursive: true });
  const tmp = mkdtempSync(join(os.tmpdir(), 'nordle-still-work-'));
  let browser = opts.browser;
  const ownBrowser = !browser;
  try {
    const overlay = opts.overlay === false ? { empty: true, metas: [] } : buildOverlay(plan, doc, ctx.brand);
    if (overlay.issues) plan.issues.push(...overlay.issues);
    let page = null;
    if (!overlay.empty) { browser ??= await openBrowser(); page = await openOverlayPage(browser, plan, overlay); }
    const picks = times.map((t) => ({ t, f: clamp(Math.round(t * plan.fps), 0, plan.totalFrames - 1) }));
    const files = [];
    // overlays first (one page, in order), then the pictures in parallel
    const overlayFor = new Map();
    for (const { f } of picks) {
      if (overlayFor.has(f) || !page) continue;
      const t = f / plan.fps;
      if (!overlay.metas.some((m) => t >= m.start - 1e-6 && t < m.end - 1e-6)) { overlayFor.set(f, null); continue; }
      const file = join(tmp, `ov-${f}.png`);
      writeFileSync(file, await page.png(t));
      overlayFor.set(f, file);
    }
    await page?.close();
    await pool(picks, 4, async ({ t, f }, i) => {
      const { seg, k } = locate(plan, f);
      const out = join(outDir, `${doc.id}-t${(f / plan.fps).toFixed(2).replace('.', '_')}.${format}`);
      const overlayPng = overlayFor.get(f) ?? null;
      const tin = seg.transitionIn;
      if (tin && k < tin.frames && seg.index > 0) {
        await blendedFrame(plan, seg, k, out, tmp, overlayPng, i);
      } else {
        await run(frameArgs(plan, seg, k, out, { overlayPng }), { label: `Frame at ${(f / plan.fps).toFixed(2)}s` });
      }
      files[i] = { t, frame: f, time: f / plan.fps, path: out, w: plan.width, h: plan.height, shows: seg.clipId ?? 'black' };
    });
    return { ok: true, files, issues: plan.issues.filter((x) => !x.blocking), doc: doc.id, outDir };
  } finally {
    if (ownBrowser) await browser?.close().catch(() => {});
    try { rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }); } catch { /* a handle still open; the OS temp cleaner takes it */ }
  }
}

/** A frame inside a fade or slide: the outgoing picture's tail and the incoming picture, mixed the way the real render mixes them. */
async function blendedFrame(plan, seg, k, out, tmp, overlayPng, n) {
  const F = plan.fps;
  const prev = plan.segments[seg.index - 1];
  const a = join(tmp, `blend-a-${n}.png`), b = join(tmp, `blend-b-${n}.png`);
  await run(frameArgs(plan, prev, prev.e - prev.s + k, a), { label: 'Outgoing frame' });
  await run(frameArgs(plan, seg, k, b), { label: 'Incoming frame' });
  const tin = seg.transitionIn;
  const name = tin.type === 'slide' ? `slide${tin.direction}` : 'fade';
  const mixed = overlayPng ? join(tmp, `blend-m-${n}.png`) : out;
  const len = n6((tin.frames + 1) / F);
  await run(['-loop', '1', '-framerate', String(F), '-t', len, '-i', a, '-loop', '1', '-framerate', String(F), '-t', len, '-i', b,
    '-filter_complex', `[0:v]format=yuv420p[a];[1:v]format=yuv420p[b];[a][b]xfade=transition=${name}:duration=${n6(tin.frames / F)}:offset=0,select='eq(n,${k})',format=rgb24`,
    '-frames:v', '1', mixed], { label: 'Transition frame' });
  if (overlayPng) {
    const jpg = out.endsWith('.jpg');
    await run(['-i', mixed, '-i', overlayPng, '-filter_complex', `[0:v]format=rgba[p];[1:v]format=rgba[o];[p][o]overlay=0:0:format=auto,format=${jpg ? 'yuvj420p' : 'rgb24'}`, '-frames:v', '1', ...(jpg ? ['-q:v', '3'] : []), out], { label: 'Overlay on transition frame' });
  }
}

/** The contact sheet without a full render: a few frames per scene, drawn on their own. Written to out/<doc>/sheet.png. */
export async function videoSheet(docFile, opts = {}) {
  const prep = await prepare(docFile, { ...opts, scale: 0.35, preview: false });
  if (prep.errors) return { ok: false, errors: prep.errors, issues: prep.errors };
  const { ctx, plan } = prep;
  const outDir = opts.out ?? join(ctx.projectDir, 'out', ctx.doc.id);
  mkdirSync(outDir, { recursive: true });
  let browser = opts.browser;
  const ownBrowser = !browser;
  const tmp = mkdtempSync(join(os.tmpdir(), 'nordle-sheet-'));
  try {
    browser ??= await openBrowser();
    const scenes = sheetScenes(plan);
    const times = scenes.flatMap((s) => s.times);
    const stills = await videoStills(docFile, times, { ...opts, scale: 0.35, format: 'jpg', out: tmp, browser });
    if (!stills.ok) return { ok: false, errors: stills.errors, issues: stills.issues };
    const frames = new Map();
    stills.files.forEach((f, i) => frames.set(i, { dataUrl: `data:image/jpeg;base64,${readFileSync(f.path).toString('base64')}` }));
    const sheet = await renderVideoSheet({ plan, doc: ctx.doc, browser, scenes, frames, outDir, issues: plan.issues });
    return { ok: true, sheet, scenes: scenes.map((s) => ({ id: s.id, title: s.title, start: s.start, end: s.end, times: s.times, clips: s.clips, speech: s.speech })), issues: plan.issues.filter((x) => !x.blocking) };
  } finally {
    if (ownBrowser) await browser?.close().catch(() => {});
    try { rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }); } catch { /* a handle still open; the OS temp cleaner takes it */ }
  }
}

/** Probe a media file: absolute path, project path or mount:name/path. */
export async function probeFor(projectDir, path) {
  const { resolveMediaPath } = await import('./mounts.mjs');
  const abs = resolveMediaPath(projectDir, path);
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`There is no file at ${path}.`);
  return probeMedia(abs);
}

export { buildPlan, summarisePlan, frameKeys, segmentArgs, tailFrames, binary, frameFromVideo };
