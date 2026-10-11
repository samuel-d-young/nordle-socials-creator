// Synthetic media for the video tests, made by ffmpeg's test sources: nothing is stored, nothing is client material.
//   talk.mp4    1280x720 at 25 fps, 12 s. A new flat colour every second; a 1 kHz tone in bursts that match talk.words.json
//   broll.mp4   1920x1080 at 30 fps, 6 s of one flat colour, no sound
//   bands.mp4   1280x720, 4 s: red | green | blue vertical thirds
//   stripes.mp4 1280x720, 4 s: black and white vertical stripes (zoom makes them wider)
//   sync.mp4    1280x720 at 30 fps, 8 s: black with a white flash and a 1 kHz beep, both from exactly 3.000 s
//   music.wav   12 s of 220 Hz, stereo
//   photo.jpg   1200x800
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/video/ffmpeg.mjs';

export const COLOURS = ['ff0000', '00ff00', '0000ff', 'ffff00', '00ffff', 'ff00ff', 'ff8000', '8000ff', '80ff00', '0080ff', 'ff0080', '808080'];
export const BROLL = 'c040c0';

export const SCRIPT = 'Every morning we open the doors. Come and visit Noodle House today. Small things make big days.'.split(' ');
/** Word i is spoken from 0.5 + 0.5 i for 0.35 s, in the talk.mp4 sound. */
export const wordStart = (i) => 0.5 + 0.5 * i;
export const wordEnd = (i) => wordStart(i) + 0.35;

const lavfi = (spec) => ['-f', 'lavfi', '-i', spec];

export async function makeMedia(footageDir) {
  mkdirSync(footageDir, { recursive: true });
  const out = (name) => join(footageDir, name);
  await Promise.all([
    run([
      ...COLOURS.flatMap((c) => lavfi(`color=c=0x${c}:s=1280x720:r=25:d=1`)),
      ...lavfi("aevalsrc='0.5*sin(2*PI*1000*t)*gte(t,0.5)*lt(t,9)*lt(mod(t-0.5,0.5),0.35)':s=48000:d=12"),
      '-filter_complex', `${COLOURS.map((_, i) => `[${i}:v]`).join('')}concat=n=${COLOURS.length}:v=1:a=0[v]`,
      '-map', '[v]', '-map', `${COLOURS.length}:a`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-pix_fmt', 'yuv420p', '-g', '25', '-c:a', 'aac', '-b:a', '160k', out('talk.mp4'),
    ]),
    run([...lavfi(`color=c=0x${BROLL}:s=1920x1080:r=30:d=6`), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-pix_fmt', 'yuv420p', out('broll.mp4')]),
    run([...lavfi('color=c=black:s=1280x720:r=25:d=4'), '-vf', "geq=r='if(lt(X,427),255,0)':g='if(between(X,427,853),255,0)':b='if(gt(X,853),255,0)'", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', out('bands.mp4')]),
    run([...lavfi('color=c=black:s=1280x720:r=25:d=4'), '-vf', "geq=lum='if(lt(mod(floor(X/40),2),1),235,16)':cb=128:cr=128", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', out('stripes.mp4')]),
    run([
      ...lavfi("color=c=black:s=1280x720:r=30:d=8,drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='between(t,3,3.1)'"),
      ...lavfi("aevalsrc='0.8*sin(2*PI*1000*t)*between(t,3,3.1)':s=48000:d=8"),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-pix_fmt', 'yuv420p', '-g', '30', '-c:a', 'aac', '-b:a', '160k', out('sync.mp4'),
    ]),
    run([...lavfi('sine=frequency=220:sample_rate=44100:duration=12'), '-af', 'volume=0.5,pan=stereo|c0=c0|c1=c0', out('music.wav')]),
    run([...lavfi('testsrc=size=1200x800:rate=1:duration=1'), '-frames:v', '1', '-q:v', '3', out('photo.jpg')]),
  ]);
  const words = SCRIPT.map((text, i) => ({ text, start: wordStart(i), end: wordEnd(i) }));
  writeFileSync(out('talk.words.json'), JSON.stringify({ schema: 'nordle.words/0.1', synthetic: true, words }, null, 2));
}

/** One frame of a finished video, scaled small, as RGB: decode a whole file to a list of tiny frames. */
export async function decodeFrames(file, w = 8, h = 14, fps = null) {
  const { stdout } = await run(['-i', file, '-an', '-vf', `${fps ? `fps=${fps},` : ''}scale=${w}:${h}:flags=area,scale=in_color_matrix=bt709:in_range=tv:out_range=full,format=rgb24`, '-f', 'rawvideo', '-'], { label: 'decode frames' });
  const size = w * h * 3;
  const frames = [];
  for (let i = 0; i + size <= stdout.length; i += size) {
    let r = 0, g = 0, b = 0;
    for (let p = 0; p < size; p += 3) { r += stdout[i + p]; g += stdout[i + p + 1]; b += stdout[i + p + 2]; }
    const n = w * h;
    frames.push({ r: r / n, g: g / n, b: b / n, raw: stdout.subarray(i, i + size) });
  }
  return frames;
}

/** Mono 16-bit samples of a file's sound at 48 kHz (decoded the way a player does, so edit lists count). */
export async function decodeAudio(file) {
  const { stdout } = await run(['-i', file, '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', '-'], { label: 'decode audio' });
  return new Int16Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 2));
}

/** Energy of one frequency in a stretch of samples (Goertzel). */
export function toneEnergy(samples, from, to, freq, rate = 48000) {
  const a = Math.floor(from * rate), b = Math.min(samples.length, Math.floor(to * rate));
  const k = 2 * Math.cos((2 * Math.PI * freq) / rate);
  let s1 = 0, s2 = 0;
  for (let i = a; i < b; i++) { const s = samples[i] / 32768 + k * s1 - s2; s2 = s1; s1 = s; }
  const power = s1 * s1 + s2 * s2 - k * s1 * s2;
  return power / Math.max(1, b - a) ** 2;
}

/**
 * Run a request again when Windows drops a new loopback connection (ECONNRESET before anything was sent: about one in ten
 * new sockets on this machine, whatever the server does). Only that error is retried; any answer, good or bad, is returned.
 */
export async function retryReset(fn, tries = 8) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= tries || (e?.cause?.code ?? e?.code) !== 'ECONNRESET') throw e;
    }
  }
}

/** How close a colour is to a 6-digit hex. */
export function near(frame, hex, tol = 60) {
  const t = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return Math.abs(frame.r - t[0]) <= tol && Math.abs(frame.g - t[1]) <= tol && Math.abs(frame.b - t[2]) <= tol;
}
