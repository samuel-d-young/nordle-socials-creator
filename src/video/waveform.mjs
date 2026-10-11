// Waveforms for the timeline's sound lanes. The sound of a source is decoded once by ffmpeg to mono 8 kHz 16-bit samples
// and reduced to peaks while it streams in (the decoded sound is never held in memory, so an hour of footage costs the
// same as a minute). The peaks are kept next to the proxy as <hash>.peaks.json and are current for as long as the source
// file is (the name carries its path, size and modification time).
//
//   waveformFor(projectDir, source, { per, transcript, signal })
//     -> { duration, per, peaks:number[], hasAudio, speech?:[{start,end}] }
//   peaks[i] is the loudest sample (0 to 1, 3 decimals) between i*per and (i+1)*per seconds of the source's own time.
//   At most 20000 peaks: a longer source gets a larger `per` than asked for. `speech` is only there when the source has a
//   transcript: the stretches covered by its words, with gaps under 0.35 s closed up.
//
// The cache is made at the finest step that keeps it under 20000 peaks (0.01 s for anything up to 200 s), and any `per`
// that is a whole multiple of it is answered exactly by taking the loudest of the steps inside it.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { runStream } from './ffmpeg.mjs';
import { probeMedia } from './probe.mjs';
import { MountError, resolveMediaPath } from './mounts.mjs';
import { loadWordsFile } from './words.mjs';
import { locateSource, mainAudioIndex, proxyFor, proxyPaths, tidyProxies } from './proxy.mjs';

export const WAVE_RATE = 8000;
export const WAVE_MAX_PEAKS = 20000;
export const WAVE_MIN_PER = 0.01;
export const SPEECH_GAP = 0.35;
// each step is a whole multiple of the one before, so a request for any of them is answered exactly from a cache made at a finer one
const STEPS = [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 60, 600];

const r3 = (v) => Math.round(v * 1000) / 1000;

/** The finest cache step that keeps a source of this length under the peak limit. */
export function cacheStep(duration) {
  return STEPS.find((s) => Math.ceil(duration / s) <= WAVE_MAX_PEAKS) ?? STEPS.at(-1);
}

/** Reduce peaks made every `from` seconds to peaks every `to` seconds (the loudest of the steps inside each). */
export function poolPeaks(peaks, from, to, duration) {
  const count = Math.max(1, Math.ceil(duration / to - 1e-9));
  if (Math.abs(from - to) < 1e-9) return peaks.slice(0, count);
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    const a = Math.floor((i * to) / from + 1e-9);
    const b = Math.min(peaks.length, Math.ceil(((i + 1) * to) / from - 1e-9));
    let m = 0;
    for (let j = a; j < b; j++) if (peaks[j] > m) m = peaks[j];
    out[i] = m;
  }
  return out;
}

/** Where words are spoken: the stretches they cover, with gaps shorter than `gap` seconds closed up. */
export function speechRanges(words, gap = SPEECH_GAP) {
  const sorted = [...words].filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end)).sort((a, b) => a.start - b.start);
  const out = [];
  for (const w of sorted) {
    const last = out.at(-1);
    if (last && w.start - last.end < gap) last.end = Math.max(last.end, w.end);
    else out.push({ start: w.start, end: w.end });
  }
  return out.map((r) => ({ start: r3(r.start), end: r3(r.end) }));
}

/**
 * Reduces 16-bit little-endian mono samples to the loudest sample in every `step` seconds as they arrive, in pieces of
 * any size (a sample may be split between two pieces). Only the finished peaks are kept, never the samples.
 */
export function peakReducer(step, rate = WAVE_RATE) {
  const win = Math.max(1, Math.round(step * rate));
  const peaks = [];
  let max = 0, inWindow = 0, total = 0, carry = null;
  const push = () => { peaks.push(Math.min(1, r3(max / 32768))); max = 0; inWindow = 0; };
  return {
    push(chunk) {
      let buf = chunk;
      if (carry) { buf = Buffer.concat([carry, chunk]); carry = null; }
      const n = buf.length >> 1;
      if (buf.length & 1) carry = Buffer.from(buf.subarray(buf.length - 1));
      for (let i = 0; i < n; i++) {
        const s = buf.readInt16LE(i * 2);
        const a = s < 0 ? -s : s;
        if (a > max) max = a;
        if (++inWindow === win) push();
      }
      total += n;
    },
    /** The peaks, with the last part-filled step included, and how many seconds of sound went through. */
    end() { if (inWindow > 0) push(); return { peaks, seconds: total / rate }; },
  };
}

/** Decode the sound of `input` and return the loudest sample in every `step` seconds. */
async function measurePeaks(input, step, signal, track = 0) {
  const reducer = peakReducer(step);
  await runStream(
    // the sound is placed on the source's own clock (silence is added if it starts late), the way the renderer reads it
    ['-vn', '-sn', '-dn', '-i', input, '-map', `0:a:${track}`, '-af', `aresample=${WAVE_RATE}:async=1:first_pts=0`, '-ac', '1', '-ar', String(WAVE_RATE), '-c:a', 'pcm_s16le', '-f', 's16le', '-'],
    (chunk) => reducer.push(chunk),
    { signal, label: 'Reading the sound for the waveform' },
  );
  return reducer.end();
}

const computing = new Map();

function readCache(file) {
  try {
    const c = JSON.parse(readFileSync(file, 'utf8'));
    return c?.v === 1 && Array.isArray(c.peaks) && Number.isFinite(c.per) && Number.isFinite(c.duration) ? c : null;
  } catch { return null; }
}

/**
 * @param {string} projectDir
 * @param {string} source project path or mount:name/path of the media file
 * @param {{ per?:number, transcript?:string|null, signal?:AbortSignal, mounts?:object }} [opts]
 */
export async function waveformFor(projectDir, source, opts = {}) {
  const asked = Number.isFinite(Number(opts.per)) && Number(opts.per) > 0 ? Number(opts.per) : 0.05;
  const want = Math.min(600, Math.max(WAVE_MIN_PER, asked));
  const loc = locateSource(projectDir, source, opts.mounts);
  const paths = proxyPaths(projectDir, loc.key);

  let cache = readCache(paths.peaks);
  if (!cache) {
    if (!computing.has(loc.key)) {
      const job = (async () => {
        const info = await probeMedia(loc.abs);
        if (info.kind === 'image') throw new Error(`${source} is a picture and has no sound to draw.`);
        if (!info.hasAudio) return { v: 1, key: loc.key, hasAudio: false, duration: r3(info.duration), per: cacheStep(info.duration), peaks: [] };
        const step = cacheStep(info.duration || 1);
        // the proxy is a small file with the same timing and the same sound: far less to read than camera footage
        const proxy = proxyFor(projectDir, source, opts.mounts);
        const measured = await measurePeaks(proxy ?? loc.abs, step, opts.signal, proxy ? 0 : mainAudioIndex(info));
        // a proxy's AAC sound runs a few milliseconds past the footage: never longer than the source itself
        const seconds = info.duration > 0 ? Math.min(measured.seconds, info.duration) : measured.seconds;
        const peaks = measured.peaks.slice(0, Math.max(1, Math.ceil(seconds / step - 1e-9)));
        const fresh = { v: 1, key: loc.key, pathHash: loc.pathHash, hasAudio: true, duration: r3(seconds), per: step, rate: WAVE_RATE, peaks };
        if (fresh.peaks.length > WAVE_MAX_PEAKS) { fresh.peaks = poolPeaks(fresh.peaks, step, cacheStep(seconds), seconds); fresh.per = cacheStep(seconds); }
        mkdirSync(paths.dir, { recursive: true });
        tidyProxies(projectDir, loc); // what was made from an earlier version of this file
        const tmp = `${paths.peaks}.part`;
        writeFileSync(tmp, JSON.stringify(fresh));
        try { renameSync(tmp, paths.peaks); } catch (e) { rmSync(tmp, { force: true }); throw e; }
        return fresh;
      })().finally(() => computing.delete(loc.key));
      computing.set(loc.key, job);
    }
    cache = await computing.get(loc.key);
  }

  const per = Math.max(want, cache.per);
  const duration = cache.duration;
  const result = { duration, per: Number(per.toFixed(6)), hasAudio: cache.hasAudio !== false, peaks: cache.hasAudio === false ? [] : poolPeaks(cache.peaks, cache.per, per, duration) };

  if (opts.transcript) {
    try {
      const file = resolveMediaPath(projectDir, opts.transcript, opts.mounts);
      if (existsSync(file)) result.speech = speechRanges(loadWordsFile(file).words);
    } catch (e) {
      if (!(e instanceof MountError)) result.transcriptProblem = e.message;
    }
  }
  return result;
}
