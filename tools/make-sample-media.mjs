#!/usr/bin/env node
// Generates the sample project's test footage with ffmpeg, so no media is stored in git.
//   node tools/make-sample-media.mjs [project-folder]
// Everything here is synthetic (test patterns, generated tones), so it carries no licence.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const project = resolve(process.argv[2] ?? join(ROOT, 'samples', 'little-gannet'));
const out = join(project, 'sources');
mkdirSync(out, { recursive: true });

function ffmpeg(label, args) {
  process.stdout.write(`  ${label} ... `);
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', ...args], { encoding: 'utf8', windowsHide: true });
  if (r.error || r.status !== 0) {
    console.log('FAILED');
    console.error(r.error?.message ?? r.stderr);
    process.exit(1);
  }
  console.log('done');
}

console.log(`Writing test media to ${out}`);

// 40 s vertical test clip: a running timestamp over a steady tone (a stand-in for a talking take).
ffmpeg('raw-roast.mp4', [
  '-f', 'lavfi', '-i', 'testsrc=size=1080x1920:rate=30:duration=40',
  '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=40',
  '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-shortest',
  join(out, 'raw-roast.mp4'),
]);

// 10 s vertical b-roll, silent.
ffmpeg('broll.mp4', [
  '-f', 'lavfi', '-i', 'mandelbrot=size=1080x1920:rate=30',
  '-t', '10', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p', '-an',
  join(out, 'broll.mp4'),
]);

// 20 s three-note chord with a slow fade, stereo 44.1 kHz.
ffmpeg('music.wav', [
  '-f', 'lavfi', '-i', 'sine=frequency=261.63:sample_rate=44100:duration=20',
  '-f', 'lavfi', '-i', 'sine=frequency=329.63:sample_rate=44100:duration=20',
  '-f', 'lavfi', '-i', 'sine=frequency=392:sample_rate=44100:duration=20',
  '-filter_complex', '[0][1][2]amix=inputs=3:normalize=0,volume=0.3,pan=stereo|c0=c0|c1=c0',
  join(out, 'music.wav'),
]);

// Synthetic word timings for raw-roast (a stand-in for a real transcript).
const script = 'Every batch starts with a quiet morning and a hot drum. We listen for the first crack, then we slow it right down. Small batches let us taste as we go. That is how a simple bean becomes your cup. Come and see for yourself on Quay Street.'.split(' ');
let t = 2.0;
const words = script.map((text) => {
  const dur = 0.18 + Math.min(text.length, 9) * 0.035;
  const w = { text, start: Number(t.toFixed(3)), end: Number((t + dur).toFixed(3)) };
  t += dur + 0.08;
  return w;
});
writeFileSync(join(out, 'raw-roast.words.json'), JSON.stringify({ schema: 'nordle.words/0.1', synthetic: true, words }, null, 2));
console.log(`  raw-roast.words.json ... done (${words.length} words, to ${t.toFixed(1)} s)`);

if (!existsSync(join(out, 'raw-roast.mp4'))) process.exit(1);
console.log('Sample media ready. Check it with: node tools/validate.mjs --assets --media');
