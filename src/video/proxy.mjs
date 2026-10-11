// Proxies: small copies of footage that a browser can play and scrub. A 4K All-Intra camera file cannot be played in a
// page, so the timeline player uses a proxy instead (about 540 px on the short side, H.264, a keyframe at least every
// half second so seeking is instant, AAC 96k). The footage itself is never copied or changed: a proxy is only for
// looking at. Renders always read the original.
//
//   <project>/.proxies/<sha1 of source path + mtime + size>.mp4        the proxy (appears only when it is complete)
//   <project>/.proxies/<sha1>.mp4.part                                 being made (renamed when finished)
//   <project>/.proxies/<sha1>.json                                     what it was made from (for tidying)
//   <project>/.proxies/<sha1>.peaks.json                               the sound's waveform (src/video/waveform.mjs)
//
// The name changes when the source file does, so a stale proxy is simply not found and a new one is made (the old
// one is deleted when the new one is finished). Timing is untouched: frame rate and timestamps are kept, so a time
// in the proxy is the same time in the source.
//
//   proxyFor(projectDir, source)                       -> the proxy's path when it is there and current, else null
//   makeProxy(projectDir, source, { onProgress, signal, force })
//                                                      -> { file, key, cached, duration, width, height }
//   source: a project path (assets/clip.mp4) or mount:name/path. Anything that leaves the project or its mount is refused.
// At most two proxies are made at once; the rest wait their turn.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FfmpegError, ffmpegVersion, run } from './ffmpeg.mjs';
import { probeMedia } from './probe.mjs';
import { MountError, resolveMediaPath } from './mounts.mjs';

export const PROXY_DIR = '.proxies';
export const PROXY_SHORT_SIDE = 540;
export const PROXY_MAX_AT_ONCE = 2;
export const PROXY_NAME = /^[0-9a-f]{40}$/;

const sha1 = (text) => createHash('sha1').update(text).digest('hex');
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

// ------------------------------------------------------------------------------------------------ where things are

/** Find the source file and what identifies it: where it is, when it last changed, how big it is. */
export function locateSource(projectDir, source, mounts) {
  if (typeof source !== 'string' || !source) throw new MountError('Say which file: a project path or mount:name/path.', 'path-escape');
  const abs = resolveMediaPath(projectDir, source, mounts);
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new MountError(`There is no file at ${source}.`, 'source-missing');
  const st = statSync(abs);
  const where = process.platform === 'win32' ? abs.toLowerCase() : abs;
  const key = sha1(`${where}|${Math.floor(st.mtimeMs)}|${st.size}`);
  return { ref: source, abs, size: st.size, mtimeMs: Math.floor(st.mtimeMs), key, pathHash: sha1(where) };
}

/** The files that belong to one proxy key. */
export function proxyPaths(projectDir, key) {
  const dir = join(projectDir, PROXY_DIR);
  return { dir, file: join(dir, `${key}.mp4`), part: join(dir, `${key}.mp4.part`), meta: join(dir, `${key}.json`), peaks: join(dir, `${key}.peaks.json`) };
}

/** The address the editor page plays a finished proxy from (served by the project file route, Range included). */
export const proxyUrl = (projectId, key) => `/p/${encodeURIComponent(projectId)}/${PROXY_DIR}/${key}.mp4`;

function readMeta(paths) {
  try { return JSON.parse(readFileSync(paths.meta, 'utf8')); } catch { return null; }
}

/** The proxy of this source when it exists and is current (the file has not changed since), otherwise null. */
export function proxyFor(projectDir, source, mounts) {
  let loc;
  try { loc = locateSource(projectDir, source, mounts); } catch (e) {
    if (e instanceof MountError && e.code === 'source-missing') return null;
    throw e;
  }
  const { file } = proxyPaths(projectDir, loc.key);
  return existsSync(file) ? file : null;
}

// ------------------------------------------------------------------------------------------------ at most two at once

class Slots {
  constructor(limit) { this.limit = limit; this.active = 0; this.peak = 0; this.queue = []; }
  acquire(signal, onWait) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new FfmpegError('Cancelled.', { code: 'ABORT' }));
      const entry = { resolve: () => { signal?.removeEventListener('abort', onAbort); this.active++; this.peak = Math.max(this.peak, this.active); resolve(); } };
      const onAbort = () => { this.queue = this.queue.filter((q) => q !== entry); reject(new FfmpegError('Cancelled.', { code: 'ABORT' })); };
      if (this.active < this.limit) return entry.resolve();
      onWait?.();
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(entry);
    });
  }
  release() {
    this.active--;
    this.queue.shift()?.resolve();
  }
}
const slots = new Slots(PROXY_MAX_AT_ONCE);

/** How many proxies are being made and waiting right now, and the most there were at once (for tests and the status line). */
export const proxyStats = () => ({ active: slots.active, waiting: slots.queue.length, peak: slots.peak, limit: slots.limit });

// ------------------------------------------------------------------------------------------------ making one

/** The size of the proxy: the short side is 540 (or what the footage has when that is smaller), both sides even. */
export function proxySize(info) {
  const w = info.video.displayWidth, h = info.video.displayHeight;
  const short = Math.min(w, h);
  const f = short > PROXY_SHORT_SIDE ? PROXY_SHORT_SIDE / short : 1;
  return { w: even(w * f), h: even(h * f) };
}

/**
 * Which sound stream of a probed file is its sound: the one with the most channels, the first of those (the choice ffmpeg
 * makes when nothing is mapped, so the proxy, the waveform and the render all use the same one).
 */
export function mainAudioIndex(info) {
  let best = 0;
  info.audio.forEach((a, i) => { if (a.channels > info.audio[best].channels) best = i; });
  return best;
}

/** ffmpeg arguments for a proxy of this probed file, written to `out` (an mp4 whatever the name). */
export function proxyArgs(info, abs, out) {
  const args = ['-i', abs, '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1'];
  const track = mainAudioIndex(info);
  const sound = ['-c:a', 'aac', '-b:a', '96k', '-ar', '48000', ...((info.audio[track]?.channels ?? 2) > 2 ? ['-ac', '2'] : [])];
  if (info.kind === 'video') {
    const { w, h } = proxySize(info);
    const fps = info.video.fps || 30;
    const v = ffmpegVersion();
    args.push(
      '-map', '0:v:0', ...(info.hasAudio ? ['-map', `0:a:${track}`] : ['-an']),
      '-vf', `scale=${w}:${h}:flags=bicubic,format=yuv420p`,
      // the source's own timing: no frame-rate change, timestamps carried over, so a time in the proxy is a time in the source
      ...(v.major > 5 || (v.major === 5 && v.minor >= 1) ? ['-fps_mode', 'passthrough'] : ['-vsync', 'passthrough']),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-profile:v', 'high',
      // a keyframe at least every half second (15 frames at 30 fps), on a fixed grid, so any jump lands near a keyframe
      '-g', String(Math.max(1, Math.floor(fps * 0.5))), '-sc_threshold', '0',
      ...(info.hasAudio ? sound : []),
    );
  } else {
    args.push('-map', `0:a:${track}`, '-vn', ...sound);
  }
  args.push('-movflags', '+faststart', '-f', 'mp4', out);
  return args;
}

const building = new Map();

/** Delete a proxy's files (the video, what it was made from, its waveform). */
function removeProxy(projectDir, key) {
  const p = proxyPaths(projectDir, key);
  for (const f of [p.file, p.part, p.meta, p.peaks]) { try { rmSync(f, { force: true }); } catch { /* in use: the next build tidies it */ } }
}

/**
 * Delete what was made from an earlier version of this source file (its proxy, note and waveform, found by the hash of
 * its path) and unfinished work that was abandoned hours ago.
 */
export function tidyProxies(projectDir, loc) {
  const dir = join(projectDir, PROXY_DIR);
  let names;
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    const key = n.slice(0, 40);
    if (/^[0-9a-f]{40}\.(json|peaks\.json)$/.test(n) && key !== loc.key) {
      try {
        const meta = JSON.parse(readFileSync(join(dir, n), 'utf8'));
        if (meta.pathHash === loc.pathHash) removeProxy(projectDir, key);
      } catch { /* unreadable note: leave it */ }
    } else if (n.endsWith('.mp4.part') && !building.has(key)) {
      try { if (Date.now() - statSync(join(dir, n)).mtimeMs > 2 * 3600 * 1000) rmSync(join(dir, n), { force: true }); } catch { /* gone already */ }
    }
  }
}

/**
 * Make the proxy (or return the one that is there). Several calls for the same file share one piece of work.
 * @param {string} projectDir
 * @param {string} source project path or mount:name/path
 * @param {{ onProgress?:(p:{percent:number, stage:string, message:string})=>void, signal?:AbortSignal, force?:boolean, mounts?:object }} [opts]
 * @returns {Promise<{ file:string, key:string, cached:boolean, duration:number, width:number, height:number, hasAudio:boolean, kind:string }>}
 */
export function makeProxy(projectDir, source, opts = {}) {
  const loc = locateSource(projectDir, source, opts.mounts);
  const paths = proxyPaths(projectDir, loc.key);
  if (!opts.force && existsSync(paths.file)) {
    const meta = readMeta(paths);
    return Promise.resolve({ file: paths.file, key: loc.key, cached: true, duration: meta?.duration ?? 0, width: meta?.width ?? 0, height: meta?.height ?? 0, hasAudio: !!meta?.hasAudio, kind: meta?.kind ?? 'video' });
  }
  if (building.has(loc.key)) return building.get(loc.key);
  const work = build(projectDir, loc, paths, opts).finally(() => building.delete(loc.key));
  building.set(loc.key, work);
  return work;
}

async function build(projectDir, loc, paths, opts) {
  const { signal, onProgress } = opts;
  await slots.acquire(signal, () => onProgress?.({ percent: 0, stage: 'waiting', message: 'Waiting for another proxy to finish' }));
  try {
    const info = await probeMedia(loc.abs);
    if (info.kind === 'image') throw new Error(`${loc.ref} is a picture. Pictures play in the page as they are, so they need no proxy.`);
    if (info.kind === 'audio' && !info.hasAudio) throw new Error(`${loc.ref} has no picture and no sound, so there is nothing to make a proxy of.`);
    mkdirSync(paths.dir, { recursive: true });
    tidyProxies(projectDir, loc);
    rmSync(paths.part, { force: true });
    onProgress?.({ percent: 1, stage: 'encoding', message: 'Making the proxy' });
    const total = info.duration || 0;
    let last = -1;
    try {
      await run(proxyArgs(info, loc.abs, paths.part), {
        signal, label: 'Making the proxy',
        onProgress: (p) => {
          if (p.seconds === undefined || !total) return;
          const percent = Math.min(99, Math.round((p.seconds / total) * 100));
          if (percent !== last) { last = percent; onProgress?.({ percent, stage: 'encoding', message: `Making the proxy ${percent}%` }); }
        },
      });
      // the file changed while it was being read: what was made is of the old version
      const now = statSync(loc.abs);
      if (now.size !== loc.size || Math.floor(now.mtimeMs) !== loc.mtimeMs) throw new Error(`${loc.ref} changed while its proxy was being made. Ask for the proxy again.`);
      renameSync(paths.part, paths.file);
    } catch (e) {
      rmSync(paths.part, { force: true });
      throw e;
    }
    const size = info.video ? proxySize(info) : { w: 0, h: 0 };
    const meta = { v: 1, pathHash: loc.pathHash, source: loc.ref, size: loc.size, mtimeMs: loc.mtimeMs, kind: info.kind, duration: Number(info.duration.toFixed(3)), width: size.w, height: size.h, hasAudio: info.hasAudio, bytes: statSync(paths.file).size, builtAt: new Date().toISOString() };
    writeFileSync(paths.meta, `${JSON.stringify(meta, null, 2)}\n`);
    onProgress?.({ percent: 100, stage: 'done', message: 'Proxy ready' });
    return { file: paths.file, key: loc.key, cached: false, duration: meta.duration, width: meta.width, height: meta.height, hasAudio: meta.hasAudio, kind: meta.kind };
  } finally {
    slots.release();
  }
}
