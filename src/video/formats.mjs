// Export formats of a rendered video: what each one is made of, whether this computer's ffmpeg can make it, and the
// output options for the last pass. ffmpeg is never bundled, so what it can encode depends on the build that is installed:
// the encoders are listed once (`ffmpeg -encoders`) and a missing one gives a plain message instead of a crash.
//
//   mp4     H.264 + AAC (the default; what Instagram, TikTok and the review player take)
//   webm    VP9 + Opus
//   gif     palette-based, 15 fps, 540 px wide at most, no sound, 30 s at most
//   prores  ProRes 422 HQ + 16-bit PCM in a .mov, for editing in Resolve or Premiere
//
// Sound is the separate -14 LUFS WAV in every format that has sound, joined by ffmpeg in the last pass, so picture and
// sound start together.

import { spawnSync } from 'node:child_process';
import { binary, n6 } from './ffmpeg.mjs';

export const GIF_MAX_SECONDS = 30;
export const GIF_FPS = 15;
export const GIF_MAX_WIDTH = 540;

export const FORMATS = {
  mp4: { id: 'mp4', label: 'MP4 (H.264 and AAC)', ext: 'mp4', sound: true, encoders: ['libx264', 'aac'], what: 'MP4' },
  webm: { id: 'webm', label: 'WebM (VP9 and Opus)', ext: 'webm', sound: true, encoders: ['libvpx-vp9', 'libopus'], what: 'WebM' },
  gif: { id: 'gif', label: `GIF (${GIF_FPS} fps, no sound, up to ${GIF_MAX_SECONDS} s)`, ext: 'gif', sound: false, encoders: ['gif'], what: 'GIF' },
  prores: { id: 'prores', label: 'ProRes 422 HQ (.mov, for editing)', ext: 'mov', sound: true, encoders: ['prores_ks', 'pcm_s16le'], what: 'ProRes' },
};
export const FORMAT_IDS = Object.keys(FORMATS);

/** "webm" -> "webm"; nothing -> "mp4"; anything else -> an error that lists what exists. */
export function normaliseFormat(value) {
  if (value === undefined || value === null || value === '') return 'mp4';
  const id = String(value).trim().toLowerCase();
  if (!Object.hasOwn(FORMATS, id)) throw new Error(`"${value}" is not a video format Nordle makes. Choose one of: ${FORMAT_IDS.join(', ')}.`);
  return id;
}

let encoderCache = null;

/** The names of the encoders this computer's ffmpeg has (listed once), or null when ffmpeg cannot be asked. Never throws. */
export function availableEncoders() {
  if (encoderCache) return encoderCache;
  try {
    const r = spawnSync(binary('ffmpeg'), ['-hide_banner', '-encoders'], { windowsHide: true, encoding: 'utf8', timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
    const names = new Set();
    for (const line of String(r.stdout ?? '').split(/\r?\n/)) {
      const m = /^\s*[VAS][.A-Z]{5}\s+(\S+)/.exec(line);
      if (m && m[1] !== '=') names.add(m[1]);
    }
    if (names.size) encoderCache = names;
  } catch { /* ffmpeg is missing: the render itself says so in plain words */ }
  return encoderCache;
}

/** A plain-English problem when the format cannot be made here, otherwise null. `encoders` may be given (tests). */
export function encoderProblem(format, encoders = availableEncoders()) {
  const f = FORMATS[normaliseFormat(format)];
  if (!encoders) return null; // cannot tell; the render reports what is actually wrong
  const missing = f.encoders.filter((e) => !encoders.has(e));
  if (!missing.length) return null;
  return `${f.what} export needs the ffmpeg encoder "${missing.join('" and "')}", and the ffmpeg on this computer does not have it. Install a full build of ffmpeg (the "full" or "gpl" build, not "essentials" or "minimal") and make sure it is the one on the PATH, or choose another format. MP4 needs only libx264 and aac.`;
}

/** The message for a GIF that is too long, or null. */
export function gifProblem(seconds) {
  if (!(seconds > GIF_MAX_SECONDS + 1e-6)) return null;
  return `A GIF can be at most ${GIF_MAX_SECONDS} seconds and this part of the timeline is ${seconds.toFixed(1)} s. Render a shorter part (from and to), or choose mp4 or webm.`;
}

/** Every format, for a menu: which exist here, and why one does not. */
export function formatList(encoders = availableEncoders()) {
  return FORMAT_IDS.map((id) => {
    const f = FORMATS[id];
    const problem = encoderProblem(id, encoders);
    return { id, label: f.label, ext: f.ext, sound: f.sound, available: !problem, ...(problem ? { problem } : {}), ...(id === 'gif' ? { maxSeconds: GIF_MAX_SECONDS, maxWidth: GIF_MAX_WIDTH, fps: GIF_FPS } : {}) };
  });
}

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/** The size of a GIF: no wider than maxWidth, never bigger than the picture, both sides even. */
export function gifSize(plan, maxWidth = GIF_MAX_WIDTH) {
  const w = even(Math.min(plan.width, Number.isFinite(maxWidth) && maxWidth >= 16 ? maxWidth : GIF_MAX_WIDTH));
  return { w, h: even((w * plan.height) / plan.width) };
}

/** The part of the filter graph that turns the finished picture [outv] into a palette-based [gif]. */
export function gifGraph(plan, maxWidth) {
  const { w, h } = gifSize(plan, maxWidth);
  return [
    `[outv]fps=${GIF_FPS},scale=${w}:${h}:flags=lanczos,split[ga][gb]`,
    '[ga]palettegen=max_colors=256:stats_mode=full[gp]',
    '[gb][gp]paletteuse=dither=sierra2_4a:diff_mode=rectangle[gif]',
  ].join(';\n');
}

const COLOUR = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];

/**
 * The output options of the last pass (everything between the -map options and the file name).
 * @param {string} format
 * @param {{ fps:number, frames:number, preview?:boolean }} o
 */
export function encodeArgs(format, { fps, frames, preview = false }) {
  const length = ['-frames:v', String(frames), '-t', n6(frames / fps)];
  const sound = ['-ar', '48000', '-ac', '2'];
  if (format === 'webm') {
    return [
      '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', preview ? '38' : '31', '-deadline', 'good', '-cpu-used', preview ? '5' : '2',
      '-row-mt', '1', '-tile-columns', '2', '-pix_fmt', 'yuv420p', '-r', String(fps), '-g', String(fps * 2), ...COLOUR,
      '-c:a', 'libopus', '-b:a', preview ? '96k' : '128k', ...sound, ...length,
    ];
  }
  if (format === 'prores') {
    return [
      '-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0', '-pix_fmt', 'yuv422p10le', '-r', String(fps), ...COLOUR,
      '-c:a', 'pcm_s16le', ...sound, ...length,
    ];
  }
  if (format === 'gif') return ['-an', '-f', 'gif', '-loop', '0', '-t', n6(frames / fps)];
  return [
    ...(preview
      ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '27', '-profile:v', 'high']
      : ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-profile:v', 'high']),
    '-pix_fmt', 'yuv420p', '-r', String(fps), '-g', String(fps * 2), ...COLOUR, '-movflags', '+faststart',
    '-c:a', 'aac', '-b:a', preview ? '128k' : '192k', ...sound, ...length,
  ];
}
