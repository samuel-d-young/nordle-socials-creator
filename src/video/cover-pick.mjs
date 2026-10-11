// Picking a good cover frame for a finished video without a person: sample the video at an even step, look at each small frame, and
// score it. A good cover is sharp, has real contrast and detail near the middle of the picture, is neither dark nor blown out, sits in
// a steady shot (not mid-fade or mid-cut), and is not the very first instant or the closing card. The scores are only a ranking, so the
// owner is shown the best few and can choose; with no choice made the best one is used when the post is scheduled.

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { run } from './ffmpeg.mjs';
import { probeMedia } from './probe.mjs';

const W = 135, H = 240;

/** One small frame as grey values 0..255. */
function grey(file) {
  const png = PNG.sync.read(readFileSync(file));
  const out = new Float32Array(png.width * png.height);
  for (let i = 0; i < out.length; i++) out[i] = 0.299 * png.data[i * 4] + 0.587 * png.data[i * 4 + 1] + 0.114 * png.data[i * 4 + 2];
  return { g: out, w: png.width, h: png.height };
}

/** The measures of one frame. */
function measure({ g, w, h }) {
  let sum = 0, dark = 0, bright = 0;
  for (const v of g) { sum += v; if (v < 18) dark++; else if (v > 238) bright++; }
  const mean = sum / g.length;
  let varSum = 0;
  for (const v of g) varSum += (v - mean) ** 2;
  const contrast = Math.sqrt(varSum / g.length);
  // detail: the variance of a Laplacian over the whole frame (sharpness) and over the middle (where a face or the subject usually is)
  let lapAll = 0, nAll = 0, lapMid = 0, nMid = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
      lapAll += l * l; nAll++;
      if (x > w * 0.15 && x < w * 0.85 && y > h * 0.2 && y < h * 0.7) { lapMid += l * l; nMid++; }
    }
  }
  return { mean, contrast, dark: dark / g.length, bright: bright / g.length, sharp: lapAll / nAll, mid: lapMid / Math.max(1, nMid), g };
}

const rank01 = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return values.map((v) => (sorted.length < 2 ? 0.5 : sorted.indexOf(v) / (sorted.length - 1)));
};

/**
 * The best frames of a finished video, best first, at least `gap` seconds apart.
 * @param {string} file the video
 * @param {{count?:number, gap?:number, skipStart?:number, skipEnd?:number}} [opts] skipEnd is the length of the closing card or tail to keep clear of
 * @returns {Promise<{time:number, score:number}[]>}
 */
export async function coverCandidates(file, { count = 6, gap = 1.2, skipStart = 0.4, skipEnd = null } = {}) {
  const probe = await probeMedia(file);
  const duration = Number(probe.duration ?? probe.format?.duration ?? 0);
  if (!(duration > 1)) return [{ time: 0, score: 0 }];
  const endClear = skipEnd ?? Math.max(1.2, duration * 0.12);
  const step = Math.max(0.4, duration / 70);
  const dir = mkdtempSync(join(tmpdir(), 'nordle-cover-'));
  try {
    await run(['-i', file, '-vf', `fps=1/${step.toFixed(4)},scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2`, '-f', 'image2', join(dir, 'f%04d.png')], { label: 'Sampling frames for the cover' });
    const files = readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
    const frames = files.map((f, i) => ({ time: Math.round(i * step * 100) / 100, ...measure(grey(join(dir, f))) }));
    // steadiness: how much a frame differs from its neighbours (a fade or cut frame differs a lot from one side)
    for (let i = 0; i < frames.length; i++) {
      const d = (a, b) => { let s = 0; for (let k = 0; k < a.g.length; k += 3) s += Math.abs(a.g[k] - b.g[k]); return s / (a.g.length / 3); };
      const before = i > 0 ? d(frames[i], frames[i - 1]) : 0, after = i < frames.length - 1 ? d(frames[i], frames[i + 1]) : 0;
      frames[i].jump = Math.max(before, after);
    }
    const usable = frames.filter((f) => f.time >= skipStart && f.time <= duration - endClear && f.dark < 0.6 && f.bright < 0.6);
    const pool = usable.length >= 3 ? usable : frames.filter((f) => f.time >= skipStart);
    const rSharp = rank01(pool.map((f) => f.sharp)), rMid = rank01(pool.map((f) => f.mid)), rContrast = rank01(pool.map((f) => f.contrast)), rStill = rank01(pool.map((f) => -f.jump));
    pool.forEach((f, i) => {
      const exposure = 1 - Math.min(1, Math.abs(f.mean - 118) / 118);
      f.score = Math.round((0.28 * rSharp[i] + 0.22 * rMid[i] + 0.18 * rContrast[i] + 0.17 * rStill[i] + 0.15 * exposure) * 1000) / 1000;
    });
    const picked = [];
    for (const f of [...pool].sort((a, b) => b.score - a.score)) {
      if (picked.every((p) => Math.abs(p.time - f.time) >= gap)) picked.push(f);
      if (picked.length >= count) break;
    }
    return picked.map(({ time, score }) => ({ time, score }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

