// STOP 4b gate: cut a two-minute talking recording to 45 seconds by removing words, render it, and measure the file.
//   a synthetic "talking" source: 120 s, 330 words in sentences (a 300 Hz tone for each word), a white flash and a 1 kHz click together
//   every 4 s as a sync mark; made with ffmpeg and a WAV written here, nothing stored, nothing from a client.
//   The cut is made with the same functions the editor, the command line and Claude use (src/shared/cutlist.mjs).
//   Measured on the rendered mp4 with ffprobe/ffmpeg: length, the exact frame every kept flash lands on, picture against sound
//   (flash against click), and every kept sentence start against where the cut list says it is. The plan (what `video check` reads) must
//   find no cut through a word.
//   node --test tests/cut-gate.test.mjs     (needs ffmpeg and ffprobe on the PATH, and a browser: npx playwright-core install chromium)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, validateDocData, readJson } from '../tools/validate.mjs';
import { applyOps } from '../src/shared/ops.mjs';
import { coverage, removeWords, totalDuration, wordStates } from '../src/shared/cutlist.mjs';
import { binary, run } from '../src/video/ffmpeg.mjs';
import { openBrowser } from '../src/render/browser.mjs';
import { loadDocContext } from '../src/render/context.mjs';
import { buildPlan } from '../src/video/plan.mjs';
import { probeMedia } from '../src/video/probe.mjs';
import { renderVideo } from '../src/video/render.mjs';
import { decodeAudio, decodeFrames, toneEnergy } from './video-fixtures.mjs';

const FPS = 30;
const TARGET = 45;
const SOURCE_SECONDS = 120;
const WORDS = 330;
const FIRST_FLASH = 2, FLASH_EVERY = 4, FLASH_LENGTH = 0.1;
const REF = { track: 'v1', source: 'talk' };

let skip = null;
try { binary('ffmpeg'); binary('ffprobe'); } catch (e) { skip = `ffmpeg and ffprobe were not found on the PATH, so the STOP 4b gate did not run (${e.message.split('.')[0]}). Install ffmpeg (it is not bundled with Nordle).`; }
if (skip) console.log(`# SKIPPED: ${skip}`);

const work = mkdtempSync(join(tmpdir(), 'nordle-cutgate-'));
const footage = join(work, 'footage');
const proj = join(work, 'projects', 'little-gannet');
const tmpBase = mkdtempSync(join(tmpdir(), 'nordle-cg-tmp-'));
process.env.TEMP = tmpBase; process.env.TMP = tmpBase; process.env.TMPDIR = tmpBase;
process.on('exit', () => { try { rmSync(tmpBase, { recursive: true, force: true }); } catch { /* the OS cleans it later */ } });
let browser;
const state = {};

// ---- the synthetic recording ---------------------------------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const ms = (x) => Math.round(x * 1000) / 1000;
const VOCAB = 'harbour morning lantern coffee ferry quiet market bread window gull tide pier sail rope basket orchard lamp ripple signal'.split(' ');

/** 330 words in sentences of 6 to 14 words: short gaps between words, a pause between sentences, a second of lead and a few of tail. */
function makeTranscript() {
  const rnd = mulberry32(45);
  const words = [];
  const sentences = [];
  let t = 1.0;
  while (words.length < WORDS) {
    const len = Math.min(WORDS - words.length, 6 + Math.floor(rnd() * 9));
    const i = words.length;
    for (let k = 0; k < len; k++) {
      const dur = 0.13 + rnd() * 0.14;
      words.push({ text: `${VOCAB[(words.length * 7 + 3) % VOCAB.length]}${k === len - 1 ? '.' : ''}`, start: ms(t), end: ms(t + dur) });
      t += dur + (k === len - 1 ? 0.55 + rnd() * 0.35 : 0.03 + rnd() * 0.07);
    }
    sentences.push({ i, j: words.length - 1 });
  }
  return { words, sentences };
}

const flashTimes = () => Array.from({ length: Math.floor((SOURCE_SECONDS - FIRST_FLASH - FLASH_LENGTH) / FLASH_EVERY) + 1 }, (_, k) => FIRST_FLASH + k * FLASH_EVERY);

/** A 48 kHz mono WAV: a 300 Hz tone for every word and a 1 kHz click at every flash. */
function makeWav(words, flashes) {
  const rate = 48000;
  const n = rate * SOURCE_SECONDS;
  const pcm = Buffer.alloc(44 + n * 2);
  const burst = (start, end, freq, amp, edge) => {
    const a = Math.round(start * rate), b = Math.min(n, Math.round(end * rate));
    for (let s = a; s < b; s++) {
      const fadeIn = Math.min(1, (s - a) / (edge * rate)), fadeOut = Math.min(1, (b - s) / (edge * rate));
      const env = 0.5 - 0.5 * Math.cos(Math.PI * Math.min(fadeIn, fadeOut, 1));
      const v = Math.round(amp * env * Math.sin((2 * Math.PI * freq * s) / rate) * 32767) + pcm.readInt16LE(44 + s * 2);
      pcm.writeInt16LE(Math.max(-32768, Math.min(32767, v)), 44 + s * 2);
    }
  };
  for (const w of words) burst(w.start, w.end, 300, 0.4, 0.005);
  for (const t of flashes) burst(t, t + FLASH_LENGTH, 1000, 0.4, 0.002);
  pcm.write('RIFF', 0); pcm.writeUInt32LE(36 + n * 2, 4); pcm.write('WAVEfmt ', 8); pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22);
  pcm.writeUInt32LE(rate, 24); pcm.writeUInt32LE(rate * 2, 28); pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34); pcm.write('data', 36); pcm.writeUInt32LE(n * 2, 40);
  return pcm;
}

before(async () => {
  if (skip) return;
  mkdirSync(footage, { recursive: true });
  const { words, sentences } = makeTranscript();
  state.words = words; state.sentences = sentences; state.flashes = flashTimes();
  assert.equal(words.length, WORDS);
  assert.ok(words.at(-1).end < SOURCE_SECONDS - 3, `the transcript ends at ${words.at(-1).end}`);
  writeFileSync(join(footage, 'talk.wav'), makeWav(words, state.flashes));
  writeFileSync(join(footage, 'talk.words.json'), JSON.stringify({ schema: 'nordle.words/0.1', synthetic: true, words }));
  const enable = `lt(mod(t-${FIRST_FLASH},${FLASH_EVERY}),${FLASH_LENGTH})*gte(t,${FIRST_FLASH})`;
  await run([
    '-f', 'lavfi', '-i', `color=c=black:s=320x180:r=${FPS}:d=${SOURCE_SECONDS},drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='${enable}'`,
    '-i', join(footage, 'talk.wav'), '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p', '-g', String(FPS), '-c:a', 'aac', '-b:a', '160k', '-t', String(SOURCE_SECONDS), join(footage, 'talk.mp4'),
  ], { label: 'make the talking source' });
  mkdirSync(join(proj, 'docs'), { recursive: true });
  cpSync(join(ROOT, 'samples', 'little-gannet', 'brand.json'), join(proj, 'brand.json'));
  writeFileSync(join(proj, 'nordle.local.json'), JSON.stringify({ mounts: { footage } }));
  browser = await openBrowser();
});
after(async () => {
  await browser?.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
});

const reelDoc = () => ({
  schema: 'nordle.doc/0.1', id: 'cut-gate', title: 'Cut gate', kind: 'video', brand: 'little-gannet', sizes: [{ id: 'tiny', w: 360, h: 640 }],
  sources: [{ id: 'talk', type: 'video', path: 'mount:footage/talk.mp4', duration: SOURCE_SECONDS, transcript: 'mount:footage/talk.words.json' }],
  timeline: { fps: FPS, duration: SOURCE_SECONDS, tracks: [{ id: 'v1', type: 'video', clips: [{ id: 'main', source: 'talk', in: 0, out: SOURCE_SECONDS, at: 0 }] }], scenes: [{ id: 'all', title: 'All', start: 0, end: SOURCE_SECONDS }] },
});

/** Take whole sentences out (each run of neighbouring sentences in one cut), the way a person deletes words in the transcript. */
function cutSentences(doc0, removed) {
  let doc = doc0;
  const idx = [...removed].sort((a, b) => a - b);
  for (let k = 0; k < idx.length;) {
    let e = k;
    while (e + 1 < idx.length && idx[e + 1] === idx[e] + 1) e++;
    doc = applyOps(doc, removeWords(doc, REF, state.words, state.sentences[idx[k]].i, state.sentences[idx[e]].j)).doc;
    k = e + 1;
  }
  return doc;
}

// ---- 1. the cut -----------------------------------------------------------------------------------------------------------------

test('STOP 4b: delete words until a two-minute recording is exactly 45 seconds', { skip: skip ?? false, timeout: 120000 }, (t) => {
  const doc0 = reelDoc();
  assert.deepEqual(validateDocData(doc0, { brand: readJson(join(proj, 'brand.json')), projectDir: proj, platforms: readJson(join(ROOT, 'data', 'platforms.json')), assets: false }).filter((i) => i.level === 'error'), []);
  const n = state.sentences.length;
  const rnd = mulberry32(2024);
  const totalFor = (set) => totalDuration(cutSentences(doc0, set));
  // remove sentences until it is about the right length, then change one or two at a time while that gets closer to 45.000 s
  let removed = new Set();
  let cur = totalFor(removed);
  for (const k of [...Array(n).keys()].sort(() => rnd() - 0.5)) {
    if (cur <= TARGET + 0.5) break;
    const next = new Set(removed).add(k);
    const total = totalFor(next);
    if (total >= TARGET - 3) { removed = next; cur = total; }
  }
  let tries = 0;
  for (; tries < 6000 && Math.abs(cur - TARGET) > 1e-6; tries++) {
    const next = new Set(removed);
    for (let f = rnd() < 0.5 ? 1 : 2; f > 0; f--) { const k = Math.floor(rnd() * n); if (next.has(k)) next.delete(k); else next.add(k); }
    if (next.size >= n) continue;
    const total = totalFor(next);
    if (Math.abs(total - TARGET) < Math.abs(cur - TARGET)) { removed = next; cur = total; }
  }
  const doc = cutSentences(doc0, removed);
  state.doc = doc; state.removed = removed;
  t.diagnostic(`removed ${removed.size} of ${n} sentences (${[...removed].reduce((a, k) => a + state.sentences[k].j - state.sentences[k].i + 1, 0)} of ${WORDS} words), ${tries} tries; the cut list says ${totalDuration(doc)} s`);
  assert.ok(Math.abs(totalDuration(doc) - TARGET) <= 1 / FPS + 1e-6, `the cut list says ${totalDuration(doc)} s`);
  assert.equal(doc.timeline.duration, totalDuration(doc), 'the timeline length follows the cut');
  assert.deepEqual(validateDocData(doc, { brand: readJson(join(proj, 'brand.json')), projectDir: proj, platforms: readJson(join(ROOT, 'data', 'platforms.json')), assets: false }).filter((i) => i.level === 'error'), []);
  // every kept word is whole, every word of a removed sentence is gone
  const states = wordStates(doc, REF, state.words);
  state.sentences.forEach((s, k) => {
    for (let w = s.i; w <= s.j; w++) assert.equal(states[w].kept, !removed.has(k), `word ${w} of sentence ${k}`);
  });
  // on whole frames, in one stretch of picture without a gap
  for (const c of doc.timeline.tracks[0].clips) for (const x of [c.at, c.in, c.out]) assert.ok(Math.abs(x * FPS - Math.round(x * FPS)) < 1e-4, `${c.id} ${x}`);
  writeFileSync(join(proj, 'docs', 'cut-gate.json'), `${JSON.stringify(doc, null, 2)}\n`);
});

// ---- 2. what `video check` reads ----------------------------------------------------------------------------------------------------

test('STOP 4b: the plan finds no cut through a word, no gap, no overlap', { skip: skip ?? false, timeout: 120000 }, async () => {
  const ctx = loadDocContext(join(proj, 'docs', 'cut-gate.json'));
  assert.deepEqual(ctx.errors, []);
  const plan = await buildPlan({ doc: ctx.doc, brand: ctx.brand, projectDir: ctx.projectDir, platforms: ctx.platforms });
  assert.deepEqual(plan.blocking, []);
  assert.deepEqual(plan.issues.filter((i) => i.code === 'speech-cut-word'), [], 'a speaker cut in the middle of a word');
  assert.deepEqual(plan.issues.filter((i) => i.code === 'gap' || i.code === 'clip-overlap' || i.code === 'clip-range'), []);
  assert.equal(plan.totalFrames, Math.round(totalDuration(state.doc) * FPS));
  // whole sentences were taken out, so no clip stops before a sentence ends or starts in the middle of one
  assert.deepEqual(plan.issues.filter((i) => /^speech-/.test(i.code)), []);
});

// ---- 3. the finished file -----------------------------------------------------------------------------------------------------------

/** Runs of bright frames: [{start, length}] */
function brightRuns(frames) {
  const runs = [];
  frames.forEach((f, i) => {
    const bright = f.r > 200 && f.g > 200 && f.b > 200;
    if (!bright) return;
    const last = runs.at(-1);
    if (last && last.start + last.length === i) last.length++; else runs.push({ start: i, length: 1 });
  });
  return runs;
}

/** Seconds at which a tone starts near `expected`: the first 5 ms step where its energy reaches half of the loudest in the neighbourhood. */
function onsetNear(pcm, expected, freq, { before = 0.08, after = 0.12, window = 0.01, hop = 0.0025 } = {}) {
  const energies = [];
  for (let x = Math.max(0, expected - before); x <= expected + after; x += hop) energies.push({ x, e: toneEnergy(pcm, x, x + window, freq) });
  const peak = Math.max(...energies.map((s) => s.e));
  if (!(peak > 0)) return null;
  const first = energies.find((s) => s.e >= peak * 0.5);
  return first.x + window * (1 - Math.SQRT1_2); // the window that is half full of tone began this long before the tone did
}

async function measure(file, t, { label }) {
  const p = await probeMedia(file);
  const frames = await decodeFrames(file, 4, 4);
  const pcm = await decodeAudio(file);
  const doc = state.doc;
  const cov = coverage(doc, REF);
  // the flashes that sit wholly inside one stretch that was kept: where each must land, to the frame
  const sure = state.flashes.map((ft) => {
    const e = cov.find((c) => c.from <= ft - 2 / FPS + 1e-9 && ft + FLASH_LENGTH + 2 / FPS <= c.to + 1e-9);
    return e ? { source: ft, frame: Math.round((e.at + (ft - e.from)) * FPS) } : null;
  }).filter(Boolean);
  assert.ok(sure.length >= 6, `only ${sure.length} flashes were kept whole`);
  // the flash in the source is three or four frames long (ffmpeg's clock lands a hair either side of 0.1 s): it must keep that length too
  state.sourceRuns ??= brightRuns(await decodeFrames(join(footage, 'talk.mp4'), 4, 4));
  const runs = brightRuns(frames);
  const found = sure.map((s) => ({ ...s, want: state.sourceRuns.find((r) => r.start === Math.round(s.source * FPS)), run: runs.find((r) => r.start === s.frame) }));
  assert.ok(found.every((f) => f.want), 'every flash is in the source');
  const wrong = found.filter((f) => !f.run || f.run.length !== f.want.length);
  assert.deepEqual(wrong.map((w) => [w.source, w.frame, w.run, w.want]), [], `${label}: flashes not on their frame`);
  // sound against picture: each click starts where its flash does
  const offsets = sure.map((s) => (onsetNear(pcm, s.frame / FPS, 1000) - s.frame / FPS) * 1000);
  // sound against the cut list: the start of every kept sentence is where wordStates says it is
  const states = wordStates(doc, REF, state.words);
  const sentenceStarts = state.sentences.filter((s, k) => !state.removed.has(k) && state.words[s.i].start > 0.3 && !state.flashes.some((ft) => Math.abs(ft - states[s.i].start) < 0.35))
    .map((s) => ({ i: s.i, at: states[s.i].at }));
  const wordOffsets = sentenceStarts.map((w) => (onsetNear(pcm, w.at, 300, { before: 0.06, after: 0.1, window: 0.02 }) - w.at) * 1000);
  const startTimes = JSON.parse((await run(['-v', 'error', '-show_entries', 'stream=codec_type,start_time', '-of', 'json', file], { bin: binary('ffprobe'), capture: 'text' })).stdout).streams;
  const starts = Object.fromEntries(startTimes.map((s) => [s.codec_type, Number(s.start_time)]));
  const maxClick = Math.max(...offsets.map(Math.abs)), maxWord = Math.max(...wordOffsets.map(Math.abs));
  t.diagnostic(`${label}: ${p.duration.toFixed(3)} s long, ${frames.length} frames at ${p.video.fps.toFixed(2)} fps; ${sure.length} flashes on their exact frame; picture-to-sound offset: clicks ${offsets.map((o) => o.toFixed(1)).join(' ')} ms (worst ${maxClick.toFixed(1)}); ${wordOffsets.length} sentence starts, worst ${maxWord.toFixed(1)} ms; stream start times ${JSON.stringify(starts)}`);
  return { p, frames, offsets, wordOffsets, starts, maxClick, maxWord, sure: sure.length };
}

test('STOP 4b: the preview render is 45 s and every kept flash is on its frame', { skip: skip ?? false, timeout: 240000 }, async (t) => {
  const r = await renderVideo(join(proj, 'docs', 'cut-gate.json'), { browser, preview: true });
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.deepEqual(r.issues.filter((i) => i.code === 'speech-cut-word'), []);
  const p = await probeMedia(r.files.video);
  assert.equal(Math.round(p.video.fps), 15, 'the preview runs at half the frame rate');
  assert.ok(Math.abs(p.duration - TARGET) <= 1 / FPS + 0.02, `the preview is ${p.duration} s`);
  const frames = await decodeFrames(r.files.video, 4, 4);
  assert.ok(Math.abs(frames.length - TARGET * 15) <= 1, `${frames.length} frames`);
  // the preview keeps every other frame: each kept flash (three frames long) still shows in it, on the right frames, and is dark before it
  const cov = coverage(state.doc, REF);
  let checked = 0;
  for (const ft of state.flashes) {
    const e = cov.find((c) => c.from <= ft - 2 / FPS && ft + FLASH_LENGTH + 2 / FPS <= c.to);
    if (!e) continue;
    const frame = Math.round((e.at + (ft - e.from)) * FPS); // the flash's first frame in the full-rate cut
    const lo = Math.floor(frame / 2), hi = Math.ceil((frame + 3) / 2);
    assert.ok(frames.slice(lo, hi + 1).some((f) => f.r > 200), `the flash at output frame ${frame} shows in the preview`);
    assert.ok((frames[lo - 2]?.r ?? 0) < 60 && (frames[hi + 2]?.r ?? 0) < 60, `and the preview is dark around it (${frame})`);
    checked++;
  }
  assert.ok(checked >= 6);
  t.diagnostic(`preview: ${p.duration.toFixed(3)} s, ${frames.length} frames, ${checked} flashes checked`);
});

test('STOP 4b: the full render is 45 s to the frame, every cut lands on its frame, and sound stays with the picture', { skip: skip ?? false, timeout: 300000 }, async (t) => {
  const r = await renderVideo(join(proj, 'docs', 'cut-gate.json'), { browser });
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.deepEqual(r.issues.filter((i) => i.code === 'speech-cut-word' || i.level === 'error'), []);
  const m = await measure(r.files.video, t, { label: 'full render' });
  // the length: within one frame of 45 s, by the container and by counting the frames
  assert.ok(Math.abs(m.p.duration - TARGET) <= 1 / FPS, `the file is ${m.p.duration} s long`);
  assert.ok(Math.abs(m.frames.length - TARGET * FPS) <= 1, `${m.frames.length} frames`);
  assert.equal(Math.round(m.p.video.fps), FPS);
  // picture and sound start together, and stay together at every kept flash and at the start of every kept sentence
  assert.ok(Math.abs(m.starts.audio - m.starts.video) < 0.03, `start times ${JSON.stringify(m.starts)}`);
  assert.ok(m.maxClick < 20, `a click is ${m.maxClick} ms away from its flash`);
  assert.ok(m.wordOffsets.length >= 8, `${m.wordOffsets.length} sentence starts measured`);
  assert.ok(m.maxWord < 25, `a sentence starts ${m.maxWord} ms away from where the cut list puts it`);
  state.full = { duration: m.p.duration, frames: m.frames.length, maxClick: m.maxClick, maxWord: m.maxWord, flashes: m.sure, sentences: m.wordOffsets.length };
});

test('STOP 4b: the command line cuts the same recording and its --check reads the real footage', { skip: skip ?? false, timeout: 120000 }, async () => {
  const doc = reelDoc();
  doc.id = 'cut-gate-cli';
  writeFileSync(join(proj, 'docs', 'cut-gate-cli.json'), `${JSON.stringify(doc, null, 2)}\n`);
  const first = state.sentences[0];
  const out = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, 'nordle.mjs'), 'cut', proj, 'cut-gate-cli', '--source', 'talk', 'remove', `${first.i}-${first.j}`, '--check'],
      { env: { ...process.env, NORDLE_RUNTIME_DIR: mkdtempSync(join(work, 'norun-')) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  assert.equal(out.code, 0, `${out.stdout}\n${out.stderr}`);
  assert.match(out.stdout, /^CUT words 0-\d+ /m);
  assert.match(out.stdout, /check: no problems/);
});
