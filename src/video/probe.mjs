// ffprobe wrapper: what is really inside a media file (duration, size, rotation, frame rate, codec, audio streams).

import { statSync } from 'node:fs';
import { extname } from 'node:path';
import { binary, run } from './ffmpeg.mjs';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff']);
const cache = new Map();

const fraction = (s) => {
  if (!s || s === '0/0') return 0;
  const [a, b] = String(s).split('/').map(Number);
  return b ? a / b : a;
};

function rotationOf(stream) {
  const side = (stream.side_data_list ?? []).find((d) => d.rotation !== undefined);
  let r = side ? Number(side.rotation) : Number(stream.tags?.rotate ?? 0);
  if (!Number.isFinite(r)) r = 0;
  // ffprobe reports the display matrix as a counter-clockwise angle: normalise to 0, 90, 180, 270 clockwise
  r = ((Math.round(-r / 90) * 90) % 360 + 360) % 360;
  return r;
}

/**
 * @param {string} file absolute path
 * @returns {Promise<{path:string, kind:'video'|'audio'|'image', duration:number, size:number, format:string,
 *   video:null|{codec:string,width:number,height:number,displayWidth:number,displayHeight:number,rotation:number,fps:number,pixFmt:string,bitDepth:number,colorSpace:string|null,frames:number|null,bitRate:number|null},
 *   audio:Array<{codec:string,sampleRate:number,channels:number}>, hasAudio:boolean}>}
 */
export async function probeMedia(file, { animated = false } = {}) {
  // `animated`: this is a finished render, so a .gif is a moving picture with a length, not a still (used on the output of a GIF export)
  const st = statSync(file);
  const key = `${file}|${st.size}|${st.mtimeMs}|${animated ? 'a' : ''}`;
  if (cache.has(key)) return cache.get(key);
  const { stdout } = await run(['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { bin: binary('ffprobe'), capture: 'text', label: 'ffprobe' });
  const data = JSON.parse(stdout);
  const streams = data.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1) ?? streams.find((s) => s.codec_type === 'video');
  const audio = streams.filter((s) => s.codec_type === 'audio').map((s) => ({ codec: s.codec_name, sampleRate: Number(s.sample_rate) || 48000, channels: Number(s.channels) || 2, duration: Number(s.duration) || null }));
  const ext = extname(file).toLowerCase();
  const isImage = !animated && !!v && (IMAGE_EXT.has(ext) || ['image2', 'png_pipe', 'jpeg_pipe', 'webp_pipe', 'gif'].includes(data.format?.format_name) && Number(v.nb_frames) <= 1);
  const rotation = v ? rotationOf(v) : 0;
  const swap = rotation === 90 || rotation === 270;
  const width = v ? Number(v.width) : 0;
  const height = v ? Number(v.height) : 0;
  const duration = Number(data.format?.duration) || Number(v?.duration) || audio[0]?.duration || 0;
  const info = {
    path: file,
    kind: isImage ? 'image' : v ? 'video' : 'audio',
    duration: isImage ? 0 : duration,
    size: Number(data.format?.size) || st.size,
    format: data.format?.format_name ?? '',
    video: v ? {
      codec: v.codec_name, width, height, rotation,
      displayWidth: swap ? height : width, displayHeight: swap ? width : height,
      fps: fraction(v.avg_frame_rate) || fraction(v.r_frame_rate),
      pixFmt: v.pix_fmt, bitDepth: Number(v.bits_per_raw_sample) || (/10(le|be)?$/.test(v.pix_fmt ?? '') ? 10 : 8),
      colorSpace: v.color_space ?? null, frames: Number(v.nb_frames) || null, bitRate: Number(v.bit_rate) || null,
    } : null,
    audio,
    hasAudio: audio.length > 0,
  };
  cache.set(key, info);
  return info;
}

/** Plain-words summary of a probe, for people and for Claude. */
export function describeProbe(p) {
  const bits = [p.kind];
  if (p.video) bits.push(`${p.video.displayWidth}x${p.video.displayHeight}${p.video.rotation ? ` (rotated ${p.video.rotation} degrees)` : ''}`, p.kind === 'video' ? `${Number(p.video.fps.toFixed(3))} fps` : '', p.video.codec, p.video.pixFmt);
  if (p.kind !== 'image') bits.push(`${p.duration.toFixed(2)} s`);
  bits.push(p.hasAudio ? `audio ${p.audio.map((a) => `${a.codec} ${a.sampleRate} Hz ${a.channels} ch`).join(', ')}` : 'no audio');
  return bits.filter(Boolean).join(', ');
}
