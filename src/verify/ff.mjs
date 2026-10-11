// ffmpeg and ffprobe, used only to look at media: audio levels, a still from a clip, a duration. Nothing is bundled; the tools
// must already be on this computer. Every process is started hidden so no console window flashes on Windows.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

let found;
function locate(name) {
  const env = process.env[`NORDLE_${name.toUpperCase()}`];
  // a program on the PATH, or (Windows) where Chocolatey puts it when its folder is not on the PATH of this process
  const candidates = [env, name, ...(process.platform === 'win32' && process.env.ChocolateyInstall ? [join(process.env.ChocolateyInstall, 'bin', `${name}.exe`)] : [])].filter(Boolean);
  for (const c of candidates) {
    const r = spawnSync(c, ['-version'], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
    if (!r.error && r.status === 0) return c;
  }
  return null;
}
export function ffmpegPath() { found ??= { ffmpeg: locate('ffmpeg'), ffprobe: locate('ffprobe') }; return found.ffmpeg; }
export function ffprobePath() { ffmpegPath(); return found.ffprobe; }
export const ffmpegAvailable = () => Boolean(ffmpegPath());

export function run(cmd, args, { input, timeout = 120000, encoding = null, maxBuffer = 256 * 1024 * 1024 } = {}) {
  return spawnSync(cmd, args, { windowsHide: true, input, timeout, maxBuffer, ...(encoding ? { encoding } : {}) });
}

/** Mono audio as floats in -1..1 from `start` for `duration` seconds (or to the end). null if it cannot be read. */
export function decodeAudio(file, { start = 0, duration, sampleRate = 16000 } = {}) {
  const ff = ffmpegPath();
  if (!ff || !file || !existsSync(file)) return null;
  const args = ['-nostdin', '-v', 'error', ...(start > 0 ? ['-ss', start.toFixed(3)] : []), '-i', file, ...(duration ? ['-t', duration.toFixed(3)] : []), '-vn', '-ac', '1', '-ar', String(sampleRate), '-f', 'f32le', '-'];
  const r = run(ff, args, { timeout: 180000 });
  if (r.error || r.status !== 0 || !r.stdout?.length) return null;
  const buf = r.stdout;
  const copy = new Uint8Array(buf.length - (buf.length % 4));
  copy.set(buf.subarray(0, copy.length));
  return { samples: new Float32Array(copy.buffer), sampleRate, start };
}

/** Root-mean-square level in dB over [a, b) seconds of decoded audio (-120 for silence). */
export function levelDb(audio, a, b) {
  if (!audio) return null;
  const i0 = Math.max(0, Math.floor((a - audio.start) * audio.sampleRate));
  const i1 = Math.min(audio.samples.length, Math.ceil((b - audio.start) * audio.sampleRate));
  if (i1 <= i0) return null;
  let sum = 0;
  for (let i = i0; i < i1; i++) sum += audio.samples[i] * audio.samples[i];
  const rms = Math.sqrt(sum / (i1 - i0));
  return rms > 1e-6 ? 20 * Math.log10(rms) : -120;
}

/** {duration, hasAudio, hasVideo, width, height} or null. */
export function probe(file) {
  const fp = ffprobePath();
  if (!fp || !file || !existsSync(file)) return null;
  const r = run(fp, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', file], { encoding: 'utf8', timeout: 60000 });
  if (r.error || r.status !== 0) return null;
  try {
    const j = JSON.parse(r.stdout);
    const v = (j.streams ?? []).find((s) => s.codec_type === 'video');
    return { duration: Number(j.format?.duration) || 0, hasAudio: (j.streams ?? []).some((s) => s.codec_type === 'audio'), hasVideo: Boolean(v), width: v?.width ?? 0, height: v?.height ?? 0 };
  } catch { return null; }
}

/** One frame of a video at `t` seconds, scaled to `width`, as a JPEG file. Returns true on success. */
export function extractStill(file, t, outFile, { width = 540 } = {}) {
  const ff = ffmpegPath();
  if (!ff || !file || !existsSync(file)) return false;
  mkdirSync(dirname(outFile), { recursive: true });
  const r = run(ff, ['-nostdin', '-v', 'error', '-y', '-ss', Math.max(0, t).toFixed(3), '-i', file, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '4', outFile], { timeout: 60000 });
  return !r.error && r.status === 0 && existsSync(outFile);
}

/** A small JPEG of any image or video file as a Buffer (so a picture can be handed to Claude without being huge). */
export function thumbnail(file, { width = 720, t = 0 } = {}) {
  const ff = ffmpegPath();
  if (!ff || !existsSync(file)) return null;
  const dir = mkdtempSync(join(tmpdir(), 'nordle-thumb-'));
  try {
    const out = join(dir, 'x.jpg');
    const isVideo = /\.(mp4|mov|m4v|mkv|webm|avi)$/i.test(file);
    const r = run(ff, ['-nostdin', '-v', 'error', '-y', ...(isVideo ? ['-ss', Math.max(0, t).toFixed(3)] : []), '-i', file, '-frames:v', '1', '-vf', `scale='min(${width},iw)':-2`, '-q:v', '4', out], { timeout: 60000 });
    return !r.error && r.status === 0 && existsSync(out) ? readFileSync(out) : null;
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
