// The picture: one ffmpeg command per segment of the timeline (a clip, a photo or black), cropped to the canvas
// (the faces stay in frame), moved (zoom and pan), graded, and faded. Each segment becomes a small intermediate file;
// the final pass joins them, adds the overlay and the sound. The same chain draws a single frame for stills.
//
// Cover cropping keeps the point named by `focal` (and `pan`) in the middle of the window where the picture allows it.
// Moving pictures are scaled up first (1.5x the canvas for footage, 2x for photos) and moved inside that, so a slow
// drift lands on fractions of a canvas pixel instead of jumping a whole pixel at a time.

import os from 'node:os';
import { join } from 'node:path';
import { n6, pool, run } from './ffmpeg.mjs';

const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const floorEven = (n) => Math.max(2, Math.floor(n / 2) * 2);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const GRADES = {
  none: null,
  neutral: 'eq=contrast=1.03:saturation=1.05',
  warm: 'eq=contrast=1.06:saturation=1.12:gamma_r=1.04:gamma_b=0.94,colorbalance=rs=0.03:rm=0.09:rh=0.08:bs=-0.03:bm=-0.09:bh=-0.08',
};
/** a per-source brightness correction (see `levels` in the document schema) as an ffmpeg eq filter; numbers only, so nothing from a document reaches the command line as text */
const levelsFilter = (l) => `eq=gamma=${n6(clamp(Number(l.gamma ?? 1), 0.4, 2.5))}:brightness=${n6(clamp(Number(l.brightness ?? 0), -0.4, 0.4))}:contrast=${n6(clamp(Number(l.contrast ?? 1), 0.5, 2))}:saturation=${n6(clamp(Number(l.saturation ?? 1), 0, 3))}`;
/** exposure for camera-log footage, in stops, as a shift of the 10-bit code values before the LUT (S-Log3 moves about 0.0769 of its range per stop: 78.7 of 1023) */
const logExposure = (stops) => { const d = Math.round(clamp(Number(stops) || 0, -3, 2) * 78.7); return d ? [`lutrgb=r='clip(val${d < 0 ? '-' : '+'}${Math.abs(d)},0,1023)':g='clip(val${d < 0 ? '-' : '+'}${Math.abs(d)},0,1023)':b='clip(val${d < 0 ? '-' : '+'}${Math.abs(d)},0,1023)'`] : []; };
const DENOISE = 'hqdn3d=3:2.5:6:5';
/** the look given to camera-log footage after its LUT: a gentle S-curve in RGB, then a little contrast and colour (the LUT alone is neutral and flat) */
const LOG_CURVE = "curves=all='0/0 0.2/0.15 0.5/0.5 0.85/0.88 1/1'";
const LOG_LOOK = 'eq=contrast=1.14:saturation=1.35:gamma=0.96';
/** Colour handling: pictures are limited-range BT.709 video; the overlay is full-range RGB and is converted the same way. */
export const OVERLAY_TO_YUV = 'format=rgba,scale=in_range=full:out_color_matrix=bt709:out_range=tv,format=yuva420p';
export const RGB_TO_YUV = 'scale=in_range=full:out_color_matrix=bt709:out_range=tv,format=yuv420p';
export const TO_RGB = 'scale=in_color_matrix=bt709:in_range=tv:out_range=full,format=rgb24';
const SCALER = 'flags=lanczos+accurate_rnd';

/** x264 settings for the small intermediate files: near-lossless, quick to write and read. */
export const INTERMEDIATE = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', '-g', '30'];

function easeExpr(kind, p) {
  switch (kind) {
    case 'in': return `(${p})*(${p})`;
    case 'out': return `(1-(1-(${p}))*(1-(${p})))`;
    case 'in-out': return `if(lt(${p},0.5),4*(${p})*(${p})*(${p}),1-pow(2-2*(${p}),3)/2)`;
    default: return `(${p})`;
  }
}

/** The motion of a clip, or null when it holds still. */
export function motionOf(clip) {
  const z = clip.zoom;
  const pan = clip.pan;
  const zoomFrom = z ? (z.from ?? 1) : 1;
  const zoomTo = z ? (z.to ?? (z.from !== undefined ? 1 : zoomFrom)) : 1;
  const a = pan?.from ?? clip.focal;
  const b = pan?.to ?? a;
  const moves = Math.abs(zoomFrom - zoomTo) > 1e-6 || Math.abs(a.x - b.x) > 1e-6 || Math.abs(a.y - b.y) > 1e-6;
  if (!moves) return null;
  return { zoomFrom, zoomTo, zoomEase: z?.ease ?? 'linear', panFrom: a, panTo: b, panEase: pan?.ease ?? 'linear' };
}

/**
 * The filter chain for one segment.
 * @returns {{ inputArgs:string[], vf:string, inputSeconds:number }}
 */
function chain(plan, seg, { frames, k0 = 0, srcStart }) {
  const W = plan.width, H = plan.height, F = plan.fps;
  const clip = seg.clip;
  const parts = [];

  if (seg.kind === 'black' || !clip) {
    const bg = plan.background;
    const d = n6(frames / F + 1);
    let source = `color=c=black:s=${W}x${H}:r=${F}:d=${d}`;
    let vf = 'format=yuv420p,setsar=1';
    if (bg?.kind === 'solid') { source = `color=c=${bg.hex}:s=${W}x${H}:r=${F}:d=${d}`; vf = `format=rgb24,${RGB_TO_YUV},setsar=1`; }
    if (bg?.kind === 'linear') {
      // the line of a CSS gradient: 0 degrees points up, 90 to the right, 180 (the default) down
      const a = (bg.angle * Math.PI) / 180;
      const len = Math.abs(W * Math.sin(a)) + Math.abs(H * Math.cos(a));
      const dx = Math.sin(a) * len / 2, dy = -Math.cos(a) * len / 2;
      const [cx, cy] = [W / 2, H / 2];
      const cols = bg.stops.slice(0, 8).map((s, i) => `c${i}=${s.hex}`).join(':');
      source = `gradients=s=${W}x${H}:r=${F}:d=${d}:n=${Math.min(8, bg.stops.length)}:${cols}:x0=${Math.round(cx - dx)}:y0=${Math.round(cy - dy)}:x1=${Math.round(cx + dx)}:y1=${Math.round(cy + dy)}:speed=0.00001:type=linear`;
      vf = `format=rgb24,${RGB_TO_YUV},setsar=1`;
    }
    return { inputArgs: ['-f', 'lavfi', '-i', source], vf, inputSeconds: 0 };
  }

  const probe = clip.src.probe.video;
  const sw = probe.displayWidth, sh = probe.displayHeight;
  const isImage = clip.isImage;
  const ar = W / H;
  let cw, ch;
  if (sw / sh > ar) { ch = sh; cw = sh * ar; } else { cw = sw; ch = sw / ar; }
  cw = floorEven(Math.min(cw, sw)); ch = floorEven(Math.min(ch, sh));
  const windowAt = (f) => ({ x: clamp(Math.round((f.x * sw - cw / 2) / 2) * 2, 0, sw - cw), y: clamp(Math.round((f.y * sh - ch / 2) / 2) * 2, 0, sh - ch) });
  const motion = clip.fit === 'cover' ? motionOf(clip) : null;

  // timing: speed, frame rate
  if (!isImage) {
    // -ss lands on the nearest frame at or after the wanted time, and the timestamps keep how far after it is: do not
    // reset them, so the picture stays where the sound (cut sample-exactly) says it is
    if (clip.speed !== 1) parts.push(`setpts=PTS/${n6(clip.speed)}`);
    parts.push(`fps=${F}:start_time=0`);
  }

  // progress through the whole clip (not just this segment) for motion and fades
  const clipFrames = Math.max(1, clip.endF - clip.startF);
  const offset = seg.s - clip.startF + k0;
  const progress = (counter) => `clip((${counter}+${offset})/${Math.max(1, clipFrames - 1)},0,1)`;

  if (clip.fit === 'cover') {
    if (!motion) {
      const w0 = windowAt(clip.focal);
      parts.push(`crop=${cw}:${ch}:${w0.x}:${w0.y}`);
      parts.push(`scale=${W}:${H}:${SCALER}`);
      if (isImage) parts.push(`loop=loop=-1:size=1:start=0`, `setpts=N/(${F}*TB)`);
    } else {
      const zmax = Math.max(motion.zoomFrom, motion.zoomTo);
      const q = Math.max(zmax, isImage ? 2 : 1.5);
      const IW = even(W * q), IH = even(H * q);
      const s = IW / cw;
      const wa = windowAt(motion.panFrom), wb = windowAt(motion.panTo);
      const xU = Math.min(wa.x, wb.x), yU = Math.min(wa.y, wb.y);
      const wU = Math.max(wa.x, wb.x) + cw - xU, hU = Math.max(wa.y, wb.y) + ch - yU;
      parts.push(`crop=${wU}:${hU}:${xU}:${yU}`);
      const SW = even(wU * s), SH = even(hU * s);
      parts.push(`scale=${SW}:${SH}:flags=${isImage ? 'lanczos+accurate_rnd' : 'bicubic'}`, 'format=yuv420p');
      if (isImage) parts.push(`loop=loop=-1:size=1:start=0`, `setpts=N/(${F}*TB)`);
      const panning = wa.x !== wb.x || wa.y !== wb.y;
      if (panning || SW !== IW || SH !== IH) {
        const e = easeExpr(motion.panEase, progress('n'));
        const px = (w) => ((w - xU) * s);
        const py = (w) => ((w - yU) * s);
        const x = panning ? `'clip(${n6(px(wa.x))}+(${n6(px(wb.x) - px(wa.x))})*${e},0,${SW - IW})'` : `'${clamp(Math.round(px(wa.x)), 0, SW - IW)}'`;
        const y = panning ? `'clip(${n6(py(wa.y))}+(${n6(py(wb.y) - py(wa.y))})*${e},0,${SH - IH})'` : `'${clamp(Math.round(py(wa.y)), 0, SH - IH)}'`;
        parts.push(`crop=${IW}:${IH}:x=${x}:y=${y}`);
      }
      if (Math.abs(motion.zoomFrom - motion.zoomTo) > 1e-6) {
        const e = easeExpr(motion.zoomEase, progress('on'));
        parts.push(`zoompan=z='${n6(motion.zoomFrom)}+(${n6(motion.zoomTo - motion.zoomFrom)})*${e}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${F}`);
      } else {
        parts.push(`scale=${W}:${H}:${SCALER}`);
      }
    }
  } else if (clip.fit === 'fill') {
    parts.push(`scale=${W}:${H}:${SCALER}`);
    if (isImage) parts.push(`loop=loop=-1:size=1:start=0`, `setpts=N/(${F}*TB)`);
  } else {
    // contain: the whole picture, over a soft, darkened copy of itself
    const bw = even(W / 6), bh = even(H / 6);
    parts.push(`split=2[bg][fg];[bg]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},gblur=sigma=6,scale=${W}:${H},eq=brightness=-0.12:saturation=0.9[bgb];[fg]scale=${W}:${H}:force_original_aspect_ratio=decrease:${SCALER}[fgs];[bgb][fgs]overlay=(W-w)/2:(H-h)/2`);
    if (isImage) parts.push(`loop=loop=-1:size=1:start=0`, `setpts=N/(${F}*TB)`);
  }

  // a camera-log source (S-Log3 and the like) comes through its colour LUT first, in 10 bits (so skies do not band), so every later step sees Rec.709 pictures.
  // Sony log files are full-range data that the file calls limited, so the LUT reads them as full unless the source says lutRange "tv".
  const lut = clip.src?.lutAbs;
  if (lut) parts.push(`scale=in_color_matrix=bt709:in_range=${clip.src.lutRange === 'tv' ? 'tv' : 'pc'}:out_range=full`, 'format=gbrp10le', ...logExposure(clip.src.exposure), `lut3d=file='${lut.split('\\').join('/').split(':').join('\\:')}':interp=tetrahedral`, LOG_CURVE, 'scale=in_range=full:out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+error_diffusion');
  parts.push('format=yuv420p', 'setsar=1');
  if (lut) parts.push(LOG_LOOK);
  if (clip.src?.levels) parts.push(levelsFilter(clip.src.levels));
  if (clip.denoise) parts.push(DENOISE);
  if (GRADES[clip.grade]) parts.push(GRADES[clip.grade]);

  // the picture is placed on the timeline's clock so fades land where they should, also for a single still frame
  if (k0) parts.push(`setpts=PTS+${k0}/(${F}*TB)`);
  const fadeIn = Math.max(seg.fadeIn, seg.s === clip.startF ? Math.round((clip.fade.in ?? 0) * F) : 0);
  const fadeOut = seg.ext === 0 ? Math.max(seg.fadeOut, seg.e === clip.endF ? Math.round((clip.fade.out ?? 0) * F) : 0) : 0;
  const segLen = seg.e - seg.s;
  if (fadeIn > 0) parts.push(`fade=t=in:st=0:d=${n6(fadeIn / F)}`);
  if (fadeOut > 0) parts.push(`fade=t=out:st=${n6((segLen - fadeOut) / F)}:d=${n6(fadeOut / F)}`);
  if (!isImage) parts.push('tpad=stop_mode=clone:stop_duration=2');

  const inputArgs = isImage
    ? ['-framerate', String(F), '-i', clip.src.abs]
    : ['-ss', n6(srcStart), '-t', n6((frames / F + 0.5) * clip.speed + 0.2), '-i', clip.src.abs];
  return { inputArgs, vf: parts.join(','), inputSeconds: 0 };
}

/** Frames written past a segment's end for the transition that follows it (one spare, so the transition never runs dry). */
export const tailFrames = (seg) => (seg.ext ? seg.ext + 1 : 0);

/** ffmpeg arguments that write one segment (frames of it, plus any extra frames the next transition needs) to `out`. */
export function segmentArgs(plan, seg, out) {
  const F = plan.fps;
  const frames = seg.e - seg.s + tailFrames(seg);
  const { inputArgs, vf } = chain(plan, seg, { frames, srcStart: seg.srcStart });
  return [
    ...inputArgs, '-an', '-sn', '-vf', vf, '-frames:v', String(frames),
    ...INTERMEDIATE, ...(plan.preview ? ['-crf', '20', '-preset', 'ultrafast'] : []), '-r', String(F), out,
  ];
}

/** ffmpeg arguments for one frame of a segment (k frames in), as a PNG. `extra` counts frames past the end (a transition's tail). */
export function frameArgs(plan, seg, k, out, { overlayPng = null } = {}) {
  const F = plan.fps;
  const clip = seg.clip;
  let srcStart = seg.srcStart + (clip && !clip.isImage ? (k / F) * clip.speed : 0);
  if (clip && !clip.isImage) srcStart = clamp(srcStart, 0, Math.max(0, clip.src.probe.duration - 2 / F));
  const { inputArgs, vf } = chain(plan, seg, { frames: 1, k0: k, srcStart });
  const common = ['-an', '-sn'];
  if (!overlayPng) return [...inputArgs, ...common, '-vf', `${vf},${TO_RGB}`, '-frames:v', '1', out];
  return [
    ...inputArgs, '-i', overlayPng, ...common,
    '-filter_complex', `[0:v]${vf}[pic];[1:v]${OVERLAY_TO_YUV}[ov];[pic][ov]overlay=0:0:format=auto,${TO_RGB}`,
    '-frames:v', '1', out,
  ];
}

/** Write every segment to a small file. Returns Map(segment index -> path). */
export async function renderSegments(plan, dir, { onProgress, signal, concurrency } = {}) {
  const limit = concurrency ?? Math.max(2, Math.min(5, Math.floor(os.availableParallelism() / 5)));
  const files = new Map();
  let done = 0;
  const total = plan.segments.length;
  const frameTotal = plan.segments.reduce((a, s) => a + s.e - s.s + tailFrames(s), 0);
  let framesDone = 0;
  await pool(plan.segments, limit, async (seg) => {
    const out = join(dir, `seg-${String(seg.index).padStart(3, '0')}.mp4`);
    let last = 0;
    try {
      await run(segmentArgs(plan, seg, out), {
        signal, label: `Picture for ${seg.clipId ?? 'black'} (${(seg.s / plan.fps).toFixed(2)}s)`,
        onProgress: (p) => { if (p.frame !== undefined) { framesDone += p.frame - last; last = p.frame; onProgress?.({ done: framesDone, total: frameTotal, segments: done, segmentTotal: total }); } },
      });
    } catch (e) {
      throw new Error(`${e.message}${seg.clip ? `\n(clip "${seg.clipId}", source "${seg.clip.sourceId}")` : ''}`);
    }
    framesDone += seg.e - seg.s + tailFrames(seg) - last;
    done += 1;
    onProgress?.({ done: framesDone, total: frameTotal, segments: done, segmentTotal: total });
    files.set(seg.index, out);
  });
  return files;
}
