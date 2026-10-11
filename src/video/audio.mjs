// Sound: every clip is cut, sped, levelled and faded on its own, music is lowered while the speaker talks, everything
// is mixed, and the mix is set to -14 LUFS (two passes). The result is one WAV file; the final pass puts that WAV into the
// mp4. (Encoding the sound as AAC inside another tool's render is what adds the ~43 ms offset; a WAV muxed by ffmpeg does not.)
//
// Ducking: a compressor cannot lower the music by an exact amount, so the speaker's track is mixed on its own, the stretches
// where someone is talking are found, and a smooth gain curve (exactly `amountDb` down, `attack` before the speech starts,
// `release` after it ends) is multiplied into the music. The music is down by the time the first word is heard.

import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';
import { filterScriptArgs, n6, pool, run } from './ffmpeg.mjs';

const SR = 48000;

// ---------------------------------------------------------------- WAV helpers

/** Read a PCM WAV (16-bit) into samples. */
export function readWav16(buf) {
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') throw new Error('Not a WAV file.');
  let pos = 12;
  let fmt = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('latin1', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') fmt = { channels: buf.readUInt16LE(pos + 10), sampleRate: buf.readUInt32LE(pos + 12), bits: buf.readUInt16LE(pos + 22) };
    if (id === 'data') {
      if (!fmt || fmt.bits !== 16) throw new Error('Expected 16-bit PCM.');
      const end = Math.min(buf.length, pos + 8 + size);
      const n = Math.floor((end - pos - 8) / 2);
      const samples = new Int16Array(n);
      for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(pos + 8 + i * 2);
      return { ...fmt, samples };
    }
    pos += 8 + size + (size % 2);
  }
  throw new Error('No audio data in the WAV file.');
}

/** A mono 16-bit WAV. */
export function writeWavMono16(samples, sampleRate = SR) {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8, 'latin1');
  head.write('fmt ', 12, 'latin1'); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(sampleRate, 24); head.writeUInt32LE(sampleRate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36, 'latin1'); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

// ---------------------------------------------------------------- speech activity and the ducking curve

/**
 * Where is someone talking? Short-frame loudness against a level relative to the loud parts, with hysteresis, short
 * gaps between words closed up, and clicks ignored.
 * @returns {Array<{start:number,end:number}>} seconds
 */
export function speechActivity(samples, sampleRate, { frameMs = 10, relativeDb = 26, floorDb = -52, closeGap = 0.3, minLength = 0.12 } = {}) {
  const frame = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const count = Math.floor(samples.length / frame);
  const db = new Float64Array(count);
  for (let f = 0; f < count; f++) {
    let sum = 0;
    for (let i = f * frame; i < (f + 1) * frame; i++) sum += samples[i] * samples[i];
    db[f] = 20 * Math.log10(Math.sqrt(sum / frame) / 32768 + 1e-9);
  }
  const audible = [...db].filter((v) => v > -70).sort((a, b) => a - b);
  if (!audible.length) return [];
  const ref = audible[Math.floor(audible.length * 0.95)];
  const on = Math.max(floorDb, ref - relativeDb);
  const off = on - 4;
  const runs = [];
  let start = -1;
  for (let f = 0; f < count; f++) {
    if (start < 0 && db[f] >= on) start = f;
    else if (start >= 0 && db[f] < off) { runs.push([start, f]); start = -1; }
  }
  if (start >= 0) runs.push([start, count]);
  const sec = (f) => (f * frame) / sampleRate;
  const merged = [];
  for (const [a, b] of runs) {
    const last = merged.at(-1);
    if (last && sec(a) - last.end < closeGap) last.end = sec(b);
    else merged.push({ start: sec(a), end: sec(b) });
  }
  return merged.filter((r) => r.end - r.start >= minLength);
}

/**
 * The gain curve for one duck rule, as 16-bit samples (32767 = no change). amountDb down while speech plays, reached
 * `attack` seconds before it starts, and given back over `release` seconds after it ends.
 */
export function duckEnvelope(intervals, { amountDb, attack = 0.1, release = 0.4, duration, sampleRate = SR }) {
  const n = Math.ceil(duration * sampleRate);
  const env = new Int16Array(n).fill(32767);
  if (!intervals.length || amountDb >= 0) return env;
  const atk = Math.max(0.005, attack);
  const rel = Math.max(0.005, release);
  // speech that comes back within the fade time keeps the music down instead of pumping up and down
  const joined = [];
  for (const iv of intervals) {
    const last = joined.at(-1);
    if (last && iv.start - last.end < Math.max(0.5, atk + rel)) last.end = iv.end;
    else joined.push({ ...iv });
  }
  const gainAt = (level) => Math.round(32767 * 10 ** ((amountDb * level) / 20));
  for (const { start, end } of joined) {
    const a0 = Math.max(0, Math.floor((start - atk) * sampleRate));
    const a1 = Math.min(n, Math.floor(start * sampleRate));
    const b1 = Math.min(n, Math.floor(end * sampleRate));
    const r1 = Math.min(n, Math.floor((end + rel) * sampleRate));
    for (let i = a0; i < a1; i++) {
      const x = (i / sampleRate - (start - atk)) / atk;
      const g = gainAt(0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, x))));
      if (g < env[i]) env[i] = g;
    }
    const full = gainAt(1);
    for (let i = a1; i < b1; i++) if (full < env[i]) env[i] = full;
    for (let i = b1; i < r1; i++) {
      const x = (i / sampleRate - end) / rel;
      const g = gainAt(0.5 + 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, x))));
      if (g < env[i]) env[i] = g;
    }
  }
  return env;
}

// ---------------------------------------------------------------- the mix

function tempoChain(speed) {
  if (speed === 1) return [];
  const out = [];
  let s = speed;
  while (s < 0.5) { out.push('atempo=0.5'); s /= 0.5; }
  while (s > 2) { out.push('atempo=2'); s /= 2; }
  out.push(`atempo=${n6(s)}`);
  return out;
}

/** Noise reduction for a clip with cleanAudio when DeepFilterNet is not installed: a low cut, then the FFT denoiser (it tracks the steady noise floor: wind, crowd hum, air conditioning). */
const CLEAN_AUDIO = ['highpass=f=90', 'afftdn=nr=16:nf=-38:tn=1'];

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let deepFilterPath;
/**
 * DeepFilterNet3, an open-source neural speech denoiser (MIT / Apache-2.0), run as one program on a WAV. Looked for in NORDLE_DEEPFILTER, then
 * tools/bin/ in this repo, then the PATH. It is never bundled. Without it, cleanAudio falls back to the ffmpeg filters above. On three interviews it
 * lowered the noise floor by 27 to 35 dB with the speech level within about 2 dB; ffmpeg's FFT denoiser managed 0.5 to 2.4 dB and RNNoise models cut speech by up to 6 dB.
 */
export function findDeepFilter() {
  if (deepFilterPath !== undefined) return deepFilterPath;
  const names = process.platform === 'win32' ? ['deep-filter.exe'] : ['deep-filter'];
  const candidates = [process.env.NORDLE_DEEPFILTER, ...names.map((n) => join(REPO, 'tools', 'bin', n))].filter(Boolean);
  deepFilterPath = candidates.find((p) => existsSync(p)) ?? null;
  if (!deepFilterPath) {
    const r = spawnSync(names[0], ['--version'], { windowsHide: true, encoding: 'utf8' });
    if (r.status === 0) deepFilterPath = names[0];
  }
  return deepFilterPath;
}

/** Run DeepFilterNet over one WAV (in place). -D keeps picture and sound in step (it makes up the model's delay); -a 25 leaves the room's own sound 25 dB down instead of dead silence. */
async function denoiseWav(wav, bin, signal) {
  const dir = mkdtempSync(join(tmpdir(), 'nordle-df-'));
  try {
    await new Promise((resolve, reject) => {
      const p = spawn(bin, ['-D', '-a', '25', '-o', dir, wav], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => { err += d; });
      const stop = () => p.kill();
      signal?.addEventListener?.('abort', stop, { once: true });
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`DeepFilterNet failed (exit ${code}): ${err.trim().split('\n').slice(-2).join(' ')}`))));
    });
    copyFileSync(join(dir, basename(wav)), wav);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** What a clip needs before it can be mixed: cut out of its file, in 48 kHz stereo, at its final speed. Written once to a local WAV. `deep`: DeepFilterNet will clean it afterwards, so the ffmpeg filters are skipped. */
function extractFilters(c, deep = false) {
  return ['aresample=48000:async=1:first_pts=0', c.channels === 1 ? 'pan=stereo|c0=c0|c1=c0' : 'aformat=channel_layouts=stereo', 'aformat=sample_fmts=fltp', ...(c.cleanAudio && !deep ? CLEAN_AUDIO : []), 'asetpts=PTS-STARTPTS', ...tempoChain(c.speed), `atrim=end=${n6(c.dur)}`, 'asetpts=PTS-STARTPTS'];
}

/** The filters that level and fade one prepared clip. */
function clipFilters(c) {
  const f = ['asetpts=PTS-STARTPTS'];
  if (c.gainDb) f.push(`volume=${n6(c.gainDb)}dB`);
  if (c.fade?.in > 0) f.push(`afade=t=in:st=0:d=${n6(Math.min(c.fade.in, c.dur))}`);
  if (c.fade?.out > 0) f.push(`afade=t=out:st=${n6(Math.max(0, c.dur - c.fade.out))}:d=${n6(Math.min(c.fade.out, c.dur))}`);
  return f;
}

/**
 * Inputs and filter graph that mix a set of clips to one stereo 48 kHz stream labelled [mix].
 * @param {Array} clips plan.audioClips entries
 * @param {{ duration:number, envFiles?:Map<string,string>, trim?:{from:number,to:number} }} o
 */
function mixGraph(clips, { duration, envFiles = new Map(), trim = null, tail = '' }) {
  const inputs = [];
  const lines = [];
  const labels = [];
  clips.forEach((c, k) => {
    inputs.push('-i', c.wav);
  });
  let next = clips.length;
  clips.forEach((c, k) => {
    const filters = clipFilters(c);
    const envFile = envFiles.get(c.id);
    let cur = `[${k}:a:0]${filters.join(',')}`;
    if (envFile) {
      inputs.push('-i', envFile);
      const e = next++;
      lines.push(`${cur}[pre${k}]`);
      lines.push(`[${e}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=start=${n6(c.at)}:end=${n6(c.at + c.dur)},asetpts=PTS-STARTPTS[env${k}]`);
      lines.push(`[pre${k}][env${k}]amultiply[duck${k}]`);
      cur = `[duck${k}]`;
    }
    const delay = Math.round(c.at * SR);
    lines.push(`${cur}${envFile ? '' : ','}${delay > 0 ? `adelay=${delay}S:all=1` : 'anull'}[a${k}]`);
    labels.push(`[a${k}]`);
  });
  if (labels.length) {
    lines.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0:duration=longest:dropout_transition=0,apad=whole_dur=${n6(duration)},atrim=end=${n6(duration)},asetpts=PTS-STARTPTS${trim ? `,atrim=start=${n6(trim.from)}:end=${n6(trim.to)},asetpts=PTS-STARTPTS` : ''}${tail}[mix]`);
  } else {
    const len = trim ? trim.to - trim.from : duration;
    lines.push(`anullsrc=r=${SR}:cl=stereo:d=${n6(len)}${tail ? `,${tail.replace(/^,/, '')}` : ''}[mix]`);
  }
  return { inputs, graph: lines.join(';\n') };
}

/** loudnorm's first pass: how loud is this file? */
export async function measureLoudness(file, { target = -14, truePeak = -1.5, lra = 11, signal } = {}) {
  const { stderr } = await run(['-i', file, '-af', `loudnorm=I=${target}:TP=${truePeak}:LRA=${lra}:print_format=json`, '-f', 'null', '-'], { verbose: true, signal, label: 'Loudness measurement' });
  const m = /\{[^{}]*"input_i"[^{}]*\}/s.exec(stderr);
  if (!m) throw new Error('Could not read the loudness measurement from ffmpeg.');
  const j = JSON.parse(m[0]);
  return { integrated: Number(j.input_i), truePeak: Number(j.input_tp), range: Number(j.input_lra), threshold: Number(j.input_thresh), offset: Number(j.target_offset) };
}

async function peakDb(file, signal) {
  const { stderr } = await run(['-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { verbose: true, signal, label: 'Level check' });
  const m = /max_volume:\s*(-?[\d.]+|-inf) dB/.exec(stderr);
  return m ? Number(m[1]) : -Infinity;
}

/**
 * Render the sound of the plan (or its range) to one WAV.
 * @returns {Promise<{ wav:string, silent:boolean, loudness:object|null, ducking:Array }>}
 */
export async function renderAudio(plan, { dir, name = 'audio', normalize = true, target = -14, signal } = {}) {
  const D = plan.duration;
  const clips = plan.audioClips;
  const trim = plan.fromF > 0 || plan.toF < plan.totalFrames ? { from: plan.from, to: plan.to } : null;
  const ducking = [];

  // 0. every clip is read from its file once (footage can be big and far away), cut, and kept as a small local file
  const prepared = new Array(clips.length);
  await pool(clips, 4, async (c, i) => {
    const wav = join(dir, `${name}-clip-${i}.wav`);
    const deep = c.cleanAudio ? findDeepFilter() : null;
    await run(['-vn', '-sn', ...(c.in > 0.0005 ? ['-ss', n6(c.in)] : []), '-t', n6(c.out - c.in), '-i', c.abs, '-af', extractFilters(c, !!deep).join(','), '-c:a', 'pcm_f32le', '-ar', String(SR), '-ac', '2', wav], { signal, label: `Sound of clip "${c.id}"` });
    if (deep) await denoiseWav(wav, deep, signal);
    prepared[i] = { ...c, wav };
  });

  // 1. the track(s) the music ducks under, mixed alone and analysed
  const rules = new Map();
  for (const c of clips) if (c.duck) rules.set(`${c.duck.under}|${c.duck.amountDb}|${c.duck.attack ?? 0.1}|${c.duck.release ?? 0.4}`, c.duck);
  const underIntervals = new Map();
  for (const trackId of new Set([...rules.values()].map((r) => r.under))) {
    const sources = prepared.filter((c) => c.trackId === trackId);
    if (!sources.length) { underIntervals.set(trackId, []); continue; }
    const { inputs, graph } = mixGraph(sources.map((c) => ({ ...c, duck: null })), { duration: D, tail: ',aresample=16000,pan=mono|c0=0.5*c0+0.5*c1' });
    const analysis = join(dir, `${name}-under-${trackId}.wav`);
    await run([...inputs, ...filterScriptArgs(dir, `${name}-under-${trackId}.txt`, graph), '-map', '[mix]', '-c:a', 'pcm_s16le', '-ar', '16000', '-ac', '1', analysis], { signal, label: `Sound of track "${trackId}"` });
    const wav = readWav16(readFileSync(analysis));
    underIntervals.set(trackId, speechActivity(wav.samples, wav.sampleRate));
  }
  const envFiles = new Map();
  const envByRule = new Map();
  for (const c of prepared.filter((x) => x.duck)) {
    const key = `${c.duck.under}|${c.duck.amountDb}|${c.duck.attack ?? 0.1}|${c.duck.release ?? 0.4}`;
    if (!envByRule.has(key)) {
      const intervals = underIntervals.get(c.duck.under) ?? [];
      const file = join(dir, `${name}-duck-${envByRule.size}.wav`);
      writeFileSync(file, writeWavMono16(duckEnvelope(intervals, { amountDb: c.duck.amountDb, attack: c.duck.attack ?? 0.1, release: c.duck.release ?? 0.4, duration: D })));
      envByRule.set(key, file);
      ducking.push({ under: c.duck.under, amountDb: c.duck.amountDb, speech: intervals.map((i) => ({ start: Number(i.start.toFixed(3)), end: Number(i.end.toFixed(3)) })) });
    }
    envFiles.set(c.id, envByRule.get(key));
  }

  // 2. everything, mixed
  const mix = join(dir, `${name}-mix.wav`);
  const { inputs, graph } = mixGraph(prepared, { duration: D, envFiles, trim });
  await run([...inputs, ...filterScriptArgs(dir, `${name}-mix.txt`, graph), '-map', '[mix]', '-c:a', 'pcm_f32le', '-ar', String(SR), '-ac', '2', mix], { signal, label: 'Mixing the sound' });

  // 3. loudness
  const out = join(dir, `${name}.wav`);
  const peak = await peakDb(mix, signal);
  if (!normalize || peak < -60) {
    await run(['-i', mix, '-c:a', 'pcm_s24le', '-ar', String(SR), out], { signal, label: 'Writing the sound' });
    return { wav: out, silent: peak < -60, loudness: null, ducking };
  }
  const before = await measureLoudness(mix, { target, signal });
  const af = `loudnorm=I=${target}:TP=-1.5:LRA=11:measured_I=${before.integrated}:measured_TP=${before.truePeak}:measured_LRA=${before.range}:measured_thresh=${before.threshold}:offset=${before.offset}:linear=true,aresample=${SR}`;
  await run(['-i', mix, '-af', af, '-c:a', 'pcm_s24le', '-ar', String(SR), '-ac', '2', out], { signal, label: 'Setting the loudness' });
  return { wav: out, silent: false, loudness: { before, target }, ducking };
}
