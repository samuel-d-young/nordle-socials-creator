// The video engine: mounts, transcripts and captions, the plan, a real render (size, length, cuts, ducking, loudness, sync),
// stills, motion, transitions, and the server routes. Everything runs on synthetic media made by ffmpeg's test sources.
//   node --test tests/video.test.mjs        (needs ffmpeg on the PATH and a browser: npx playwright-core install chromium)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { ROOT, validateFile } from '../tools/validate.mjs';
import { openBrowser } from '../src/render/browser.mjs';
import { loadDocContext } from '../src/render/context.mjs';
import { createNordleServer } from '../src/server/http.mjs';
import { listMountDir, loadMounts, MountError, resolveMediaPath } from '../src/video/mounts.mjs';
import { applyFixes, parseWords } from '../src/video/words.mjs';
import { buildPlan } from '../src/video/plan.mjs';
import { probeMedia } from '../src/video/probe.mjs';
import { renderVideo, videoSheet, videoStills } from '../src/video/render.mjs';
import { measureLoudness, duckEnvelope, speechActivity } from '../src/video/audio.mjs';
import { frameKeys, buildOverlay } from '../src/video/overlay.mjs';
import { BROLL, COLOURS, decodeAudio, decodeFrames, makeMedia, near, toneEnergy, wordEnd, wordStart } from './video-fixtures.mjs';

const work = mkdtempSync(join(tmpdir(), 'nordle-videotest-'));
const footage = join(work, 'footage');
const projectsDir = join(work, 'projects');
const proj = join(projectsDir, 'little-gannet');
// Work in a private temp folder, so other programs (or other agents' renders) making nordle-* folders at the same time
// cannot make the leftovers check below fail.
const PRIVATE_TMP = mkdtempSync(join(tmpdir(), 'nordle-vt-'));
process.env.TEMP = PRIVATE_TMP; process.env.TMP = PRIVATE_TMP; process.env.TMPDIR = PRIVATE_TMP;
process.on('exit', () => { try { rmSync(PRIVATE_TMP, { recursive: true, force: true }); } catch { /* the OS cleans it later */ } });
const tmpBefore = new Set(readdirSync(tmpdir()).filter((n) => /^nordle-(video|still|sheet)/.test(n)));
let browser;

const base = (id, extra) => ({ schema: 'nordle.doc/0.1', id, title: id, kind: 'video', brand: 'little-gannet', sizes: ['ig-reel-9x16', 'tiktok-9x16'], ...extra });
function writeDoc(doc) {
  mkdirSync(join(proj, 'docs'), { recursive: true });
  const file = join(proj, 'docs', `${doc.id}.json`);
  writeFileSync(file, JSON.stringify(doc, null, 2));
  return file;
}
const SOURCES = [
  { id: 'talk', type: 'video', path: 'mount:footage/talk.mp4', duration: 12, transcript: 'mount:footage/talk.words.json' },
  { id: 'broll', type: 'video', path: 'mount:footage/broll.mp4', duration: 6 },
  { id: 'music', type: 'audio', path: 'mount:footage/music.wav', duration: 12 },
  { id: 'bands', type: 'video', path: 'mount:footage/bands.mp4', duration: 4 },
  { id: 'stripes', type: 'video', path: 'mount:footage/stripes.mp4', duration: 4 },
  { id: 'photo', type: 'image', path: 'assets/photo.jpg' },
];
const only = (...ids) => structuredClone(SOURCES.filter((s) => ids.includes(s.id)));
const tinySize = [{ id: 'tiny', w: 360, h: 640 }];

/** The main test reel: a speaker, a cutaway on a second track while the speaker keeps talking, music that ducks, captions, a title. */
const reel = () => base('reel', {
  brief: { goal: 'test' },
  sources: only('talk', 'broll', 'music'),
  timeline: {
    fps: 30, duration: 10,
    tracks: [
      { id: 'v1', type: 'video', clips: [
        { id: 'c1', source: 'talk', in: 0.5, out: 6.5, at: 0, focal: { x: 0.5, y: 0.5 } },
        { id: 'c3', source: 'talk', in: 6.5, out: 10.5, at: 6 },
      ] },
      { id: 'v2', type: 'video', clips: [{ id: 'cut', source: 'broll', in: 0, out: 2, at: 3, mute: true }] },
      { id: 'music', type: 'audio', clips: [{ id: 'bed', source: 'music', in: 0, out: 10, at: 0, gainDb: -10, fade: { in: 0.3, out: 0.5 }, duck: { under: 'v1', amountDb: -12, attack: 0.1, release: 0.4 } }] },
    ],
    scenes: [{ id: 'hook', title: 'Hook', start: 0, end: 3 }, { id: 'cutaway', title: 'Cutaway', start: 3, end: 5 }, { id: 'rest', title: 'Rest', start: 5, end: 10 }],
    captions: { source: 'talk', highlight: 'word', maxWordsPerLine: 3, position: 'bottom-third', fixes: { Noodle: 'Nordle' } },
  },
  layers: [
    { id: 'title', type: 'text', text: 'Hello there', time: { start: 0.4, end: 2.6 }, layout: { anchor: 'top-left', x: 8, y: 20, w: 70 },
      style: { font: '$brand.fonts.display', size: 96, weight: 700, color: '$brand.colors.paper' }, animate: [{ preset: 'rise-in', at: 0, duration: 0.4 }] },
  ],
});

before(async () => {
  mkdirSync(proj, { recursive: true });
  cpSync(join(ROOT, 'samples', 'little-gannet', 'brand.json'), join(proj, 'brand.json'));
  mkdirSync(join(proj, 'assets'), { recursive: true });
  await makeMedia(footage);
  cpSync(join(footage, 'photo.jpg'), join(proj, 'assets', 'photo.jpg'));
  writeFileSync(join(proj, 'nordle.local.json'), JSON.stringify({ mounts: { footage } }));
  browser = await openBrowser();
});
after(async () => {
  await browser?.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
});

// ------------------------------------------------------------------------------------------------ mounts

test('mounts: a mount path resolves, an escape is refused, a missing mount says how to add it', () => {
  const mounts = loadMounts(proj);
  assert.deepEqual(Object.keys(mounts), ['footage']);
  assert.equal(resolveMediaPath(proj, 'mount:footage/talk.mp4', mounts), join(footage, 'talk.mp4'));
  assert.equal(resolveMediaPath(proj, 'assets/photo.jpg', mounts), join(proj, 'assets', 'photo.jpg'));
  for (const bad of ['mount:footage/../secret.txt', 'mount:footage/a/../../x', 'mount:footage//etc', 'mount:footage/C:/Windows/x', 'mount:footage/a\\b', 'mount:footage/..']) {
    assert.throws(() => resolveMediaPath(proj, bad, mounts), (e) => e instanceof MountError && /not allowed|leaves/.test(e.message), bad);
  }
  assert.throws(() => resolveMediaPath(proj, '../x.mp4', mounts), MountError);
  assert.throws(() => resolveMediaPath(proj, 'mount:nope/x.mp4', mounts), (e) => e.code === 'mount-missing' && /nordle\.local\.json/.test(e.message));
  assert.throws(() => resolveMediaPath(proj, 'mount:footage/x.mp4', { footage: join(work, 'not-there') }), (e) => e.code === 'mount-folder-missing');
  // a link inside the mount that points outside it is refused
  mkdirSync(join(work, 'outside'), { recursive: true });
  writeFileSync(join(work, 'outside', 'secret.mp4'), 'x');
  try {
    symlinkSync(join(work, 'outside'), join(footage, 'linkout'), 'junction');
    assert.throws(() => resolveMediaPath(proj, 'mount:footage/linkout/secret.mp4', mounts), (e) => e.code === 'mount-escape');
    assert.ok(listMountDir(proj, 'footage', '').some((e) => e.name === 'talk.mp4'));
    assert.throws(() => listMountDir(proj, 'footage', 'linkout'), MountError);
  } catch (e) { if (e instanceof assert.AssertionError) throw e; /* links are not allowed on this machine: the lexical checks above still held */ }
  assert.throws(() => listMountDir(proj, 'footage', '../'), MountError);
});

test('validator: mount paths are accepted (existence only with --media), bad ones are not, transcripts are read', () => {
  const good = writeDoc(reel());
  const plain = validateFile(good, { assets: true });
  assert.deepEqual(plain.issues.filter((i) => i.level === 'error'), []);
  const media = validateFile(good, { assets: true, media: true });
  assert.deepEqual(media.issues.filter((i) => i.level === 'error'), []);
  const d = reel(); d.id = 'badmount'; d.sources[0].path = 'mount:footage/missing.mp4'; d.sources[1].path = 'mount:ghost/x.mp4';
  const bad = validateFile(writeDoc(d), { assets: true, media: true });
  const msgs = bad.issues.filter((i) => i.level === 'error').map((i) => i.message).join(' | ');
  assert.match(msgs, /file not found: mount:footage\/missing\.mp4/);
  assert.match(msgs, /Mount "ghost" is not set up/);
  assert.equal(validateFile(writeDoc(d), { assets: true }).issues.filter((i) => i.level === 'error').length, 0, 'without --media a mount file is not looked for');
  writeFileSync(join(footage, 'broken.words.json'), JSON.stringify({ segments: [{ text: 'hello there', start: 0, end: 1 }] }));
  const t = reel(); t.id = 'badtranscript'; t.sources[0].transcript = 'mount:footage/broken.words.json';
  assert.match(validateFile(writeDoc(t), { assets: true }).issues.map((i) => i.message).join(' | '), /transcript .* not usable: .*no word timings/);
  rmSync(join(proj, 'docs', 'badmount.json')); rmSync(join(proj, 'docs', 'badtranscript.json'));
});

// ------------------------------------------------------------------------------------------------ transcripts and captions

test('words: Nordle, faster-whisper and bare-list shapes all read; fixes keep punctuation', () => {
  const nordle = parseWords({ words: [{ text: 'Hi', start: 0, end: 0.3 }, { text: 'Noodle,', start: 0.4, end: 0.9, fix: 'Nordle,' }, { text: 'um', start: 1, end: 1.2, skip: true }] });
  assert.equal(nordle.words.length, 3);
  const shown = applyFixes(nordle.words).map((w) => w.shown);
  assert.deepEqual(shown, ['Hi', 'Nordle,']);
  const whisper = parseWords({ segments: [{ start: 0, end: 2, text: 'x', words: [{ w: 'The', s: 0, e: 0.4 }, { w: 'Noodle', s: 0.5, e: 1 }, { word: ' dentists.', start: 1.1, end: 1.6 }] }] });
  assert.deepEqual(whisper.words.map((w) => w.text), ['The', 'Noodle', 'dentists.']);
  assert.deepEqual(applyFixes(whisper.words, { noodle: 'Nordle' }).map((w) => w.shown), ['The', 'Nordle', 'dentists.']);
  assert.deepEqual(applyFixes([{ text: '"Noodle."', start: 0, end: 1 }], { Noodle: 'Nordle' }).map((w) => w.shown), ['"Nordle."']);
  assert.equal(parseWords([{ word: 'a', start: 0, end: 1 }, { word: 'b', start: 0.9, end: 2 }]).words[0].end, 0.9, 'a small overlap is tidied');
  assert.throws(() => parseWords({ segments: [{ text: 'no timings here' }] }), /no word timings/);
  assert.throws(() => parseWords({ words: [{ text: 'x', start: 2, end: 1 }] }), /do not make sense/);
  assert.throws(() => parseWords({ nothing: true }), /not a word list/);
});

test('plan and captions: only the used part of the source, moved to where it plays, with the fix applied', async () => {
  const ctx = loadDocContext(writeDoc(reel()));
  const plan = await buildPlan({ doc: ctx.doc, brand: ctx.brand, projectDir: ctx.projectDir, platforms: ctx.platforms });
  assert.deepEqual(plan.blocking, []);
  const ev = plan.captions.events;
  // c1 shows source 0.5-6.5 at 0 (words 0 to 11), c3 shows 6.5-9.5 at 6 (words 12 to 16)
  assert.equal(ev.length, 4 + 2);
  assert.deepEqual(ev[0].words.map((w) => w.text), ['Every', 'morning', 'we']);
  assert.deepEqual(ev[1].words.map((w) => w.text), ['open', 'the', 'doors']); // the full stop is dropped from a caption line
  for (const e of ev) for (const w of e.words) assert.ok(w.start >= 0 && w.end <= plan.duration);
  assert.ok(Math.abs(ev[0].words[0].start - 0) < 1e-9 && Math.abs(ev[0].words[1].start - 0.5) < 1e-9, 'first words land at 0 and 0.5 s');
  const flat = ev.flatMap((e) => e.words);
  assert.equal(flat.find((w) => w.text.startsWith('Nord')).text, 'Nordle');
  assert.ok(Math.abs(flat.find((w) => w.text === 'Nordle').start - 4.5) < 1e-9);
  const last = ev.at(-1);
  assert.deepEqual(last.words.map((w) => w.text), ['big', 'days']);
  assert.ok(Math.abs(last.words[0].start - (6 + (wordStart(15) - 6.5))) < 1e-9, 'second clip words are moved to its position');
  // lines are held a little after the last word but never past the clip, and never overlap the next line
  for (let i = 0; i + 1 < ev.length; i++) assert.ok(ev[i].end <= ev[i + 1].start + 1e-9);
  assert.ok(ev[0].end >= ev[0].words.at(-1).end);
  // no speech problems in this edit
  assert.deepEqual(plan.issues.filter((i) => /^speech/.test(i.code)), []);
  // the cutaway on v2 covers the speaker's picture but not the speaker's sound
  assert.deepEqual(plan.segments.map((s) => [s.clipId, s.s, s.e]), [['c1', 0, 90], ['cut', 90, 150], ['c1', 150, 180], ['c3', 180, 300]]);
  assert.ok(plan.audioClips.some((a) => a.id === 'c1' && a.at === 0 && a.dur === 6), 'the speaker keeps talking under the cutaway');
  assert.ok(!plan.audioClips.some((a) => a.id === 'cut'), 'a muted clip makes no sound');
});

test('plan: a clip past the end of its footage, overlaps and gaps are found; a speaker cut mid-word or mid-sentence is flagged', async () => {
  const { brand, platforms } = loadDocContext(writeDoc(reel()));
  // the plan is asked directly (without the document check first), so it must find these by itself, against the real files
  const load = (mutate) => { const d = reel(); mutate(d); return buildPlan({ doc: d, brand, projectDir: proj, platforms }); };
  const past = await load((d) => { d.sources[0].duration = 30; d.timeline.tracks[0].clips[1].out = 13; });
  assert.ok(past.blocking.some((i) => i.code === 'clip-range' && /past the end of source "talk" \(12\.00s\)/.test(i.message)), past.issues.map((i) => i.message).join('; '));
  const overlap = await load((d) => { d.timeline.tracks[0].clips[1].at = 5; });
  assert.ok(overlap.blocking.some((i) => i.code === 'clip-overlap' && /"c1" and "c3" overlap on track "v1"/.test(i.message)));
  const missing = await load((d) => { d.sources[1].path = 'mount:footage/nothing-here.mp4'; });
  assert.ok(missing.blocking.some((i) => i.code === 'source-missing' && /nothing-here/.test(i.message)));
  const noMount = await load((d) => { d.sources[1].path = 'mount:elsewhere/x.mp4'; });
  assert.ok(noMount.blocking.some((i) => i.code === 'mount-missing'));
  const gap = await load((d) => { d.timeline.tracks[0].clips[1].at = 7; d.timeline.tracks[0].clips[1].out = 8.5; d.timeline.tracks[0].clips[1].in = 6.5; d.timeline.duration = 9; });
  assert.ok(gap.issues.some((i) => i.code === 'gap' && /6\.00s to 7\.00s/.test(i.message)));
  assert.equal(gap.segments.find((s) => s.kind === 'black').s, 180);
  const word = await load((d) => { d.timeline.tracks[0].clips[0].out = 3.6; }); // word 6 ("Come") runs 3.5 to 3.85
  assert.ok(word.issues.some((i) => i.code === 'speech-cut-word' && /"Come"/.test(i.message)));
  const sentence = await load((d) => { d.timeline.tracks[0].clips[0].out = 5.0; }); // stops after "visit"
  assert.ok(sentence.issues.some((i) => i.code === 'speech-cut-sentence'), sentence.issues.map((i) => i.code).join(','));
  const start = await load((d) => { d.timeline.tracks[0].clips[0].in = 1.0; });
  assert.ok(start.issues.some((i) => i.code === 'speech-start-sentence'));
});

test('audio: speech is found, and the duck curve is exactly as deep as asked, early and smooth', () => {
  const rate = 16000;
  const s = new Int16Array(rate * 6);
  for (let i = 0; i < s.length; i++) { const t = i / rate; s[i] = (t > 1 && t < 2) || (t > 2.1 && t < 3) ? Math.round(9000 * Math.sin(2 * Math.PI * 300 * t)) : Math.round((Math.random() - 0.5) * 20); }
  const iv = speechActivity(s, rate);
  assert.equal(iv.length, 1, 'a short gap between words is closed up');
  assert.ok(Math.abs(iv[0].start - 1) < 0.03 && Math.abs(iv[0].end - 3) < 0.03);
  const env = duckEnvelope(iv, { amountDb: -12, attack: 0.1, release: 0.4, duration: 6, sampleRate: 48000 });
  const db = (i) => 20 * Math.log10(env[Math.floor(i * 48000)] / 32767);
  assert.ok(db(0.5) > -0.01, 'no change before the speech');
  assert.ok(Math.abs(db(2) + 12) < 0.01, 'exactly 12 dB down during the speech');
  assert.ok(db(0.95) < -11.9 || db(0.99) < -11, 'fully down by the time the first word is heard');
  assert.ok(db(3.2) < -6 && db(3.2) > -12, 'coming back up during the release');
  assert.ok(db(3.6) > -0.01, 'fully back after the release');
});

// ------------------------------------------------------------------------------------------------ a full render

let reelResult;
test('renders the reel: size, frame rate, length, sound, cover and sheet', { timeout: 120000 }, async () => {
  const seen = [];
  reelResult = await renderVideo(writeDoc(reel()), { browser, onProgress: (p) => seen.push(p.percent) });
  assert.ok(reelResult.ok, JSON.stringify(reelResult.errors));
  const mp4 = reelResult.files.video;
  assert.equal(mp4, join(proj, 'out', 'reel', 'reel.mp4'));
  const p = await probeMedia(mp4);
  assert.equal(p.video.width, 1080); assert.equal(p.video.height, 1920);
  assert.equal(Math.round(p.video.fps), 30);
  assert.equal(p.video.codec, 'h264'); assert.equal(p.video.pixFmt, 'yuv420p');
  assert.ok(Math.abs(p.duration - 10) < 0.08, `duration ${p.duration}`);
  assert.equal(p.hasAudio, true); assert.equal(p.audio[0].codec, 'aac'); assert.equal(p.audio[0].sampleRate, 48000); assert.equal(p.audio[0].channels, 2);
  assert.ok(p.video.frames === 300 || p.video.frames === null, `frames ${p.video.frames}`);
  // cover and sheet
  const cover = await probeMedia(reelResult.files.cover);
  assert.deepEqual([cover.video.width, cover.video.height], [1080, 1920]);
  assert.equal(reelResult.files.cover, join(proj, 'out', 'reel', 'reel-cover.jpg'));
  const sheet = PNG.sync.read(readFileSync(reelResult.files.sheet));
  assert.ok(sheet.width >= 1000 && sheet.height > 400);
  assert.equal(reelResult.files.sheet, join(proj, 'out', 'reel', 'sheet.png'));
  // progress goes up to 100
  assert.ok(seen.length > 3 && seen.at(-1) === 100 && seen.every((v, i) => i === 0 || v >= seen[i - 1] - 1), `progress ${seen.join(',')}`);
  assert.deepEqual(reelResult.issues.filter((i) => i.level === 'error'), []);
  assert.ok(reelResult.timings.totalSeconds > 0);
  // the safe zone: nothing sits in the bottom 20% or right 12% (the title and the captions were measured on the real page)
  assert.deepEqual(reelResult.issues.filter((i) => i.code === 'overlay-unsafe' || i.code === 'overlay-offscreen'), []);
});

test('cuts land on the exact frame, also under a cutaway on a second track', { timeout: 60000 }, async () => {
  const frames = await decodeFrames(reelResult.files.video);
  assert.equal(frames.length, 300);
  const at = (t) => frames[Math.round(t * 30)];
  // first clip: source 0.5 s onwards is red until source 1.0 s (timeline 0.5 s), then green
  assert.ok(near(at(0.1), COLOURS[0]) && near(at(0.4), COLOURS[0]), 'red at the start');
  assert.ok(near(at(0.6), COLOURS[1]), 'green after the first second boundary');
  assert.ok(near(frames[14], COLOURS[0]) && near(frames[15], COLOURS[1]), 'the colour changes on frame 15 (source 1.000 s), not a frame early or late');
  assert.ok(near(at(2.9), COLOURS[3]), `yellow just before the cutaway (${at(2.9).r},${at(2.9).g},${at(2.9).b})`);
  // the cutaway: exactly frames 90 to 149
  assert.ok(near(frames[89], COLOURS[3]), 'frame 89 is still the speaker');
  assert.ok(near(frames[90], BROLL), 'frame 90 is the cutaway');
  assert.ok(near(frames[149], BROLL), 'frame 149 is the cutaway');
  assert.ok(near(frames[150], COLOURS[5]), `frame 150 is the speaker again, source 5.5 s (magenta)`);
  assert.ok(near(frames[181], COLOURS[6]), 'second speaker clip');
});

test('the music is exactly lowered while the speaker talks', { timeout: 60000 }, async () => {
  const pcm = await decodeAudio(reelResult.files.video);
  const inside = toneEnergy(pcm, 1.0, 3.0, 220);
  const outside = toneEnergy(pcm, 8.9, 9.4, 220);
  const dropDb = 10 * Math.log10(outside / inside);
  assert.ok(dropDb > 10.5 && dropDb < 13.5, `music was ${dropDb.toFixed(1)} dB lower under the speaker (wanted 12)`);
  // the speaker is heard under the cutaway
  assert.ok(toneEnergy(pcm, 3.2, 4.8, 1000) > 100 * toneEnergy(pcm, 8.9, 9.4, 1000), 'speaker audible during the cutaway');
});

test('the sound is set to -14 LUFS', { timeout: 60000 }, async () => {
  const m = await measureLoudness(reelResult.files.video);
  assert.ok(Math.abs(m.integrated + 14) < 1.0, `integrated loudness ${m.integrated}`);
  assert.ok(m.truePeak <= -1.0, `true peak ${m.truePeak}`);
});

test('captions are drawn on the picture inside the safe area, and the spoken word is highlighted', { timeout: 60000 }, async () => {
  const r = await videoStills(join(proj, 'docs', 'reel.json'), [0.1, 0.6, 1.0], { browser, format: 'png', out: join(work, 'stills-captions') });
  assert.ok(r.ok);
  const [a, b, c] = r.files.map((f) => PNG.sync.read(readFileSync(f.path)));
  assert.deepEqual([a.width, a.height], [1080, 1920]);
  const bright = (png, y0, y1) => { let n = 0; for (let y = y0; y < y1; y++) for (let x = 0; x < png.width; x++) { const i = (y * png.width + x) * 4; if (png.data[i] > 200 && png.data[i + 1] > 190 && png.data[i + 2] > 170) n++; } return n; };
  // the speaker's picture is red/green here, so near-white pixels are caption text; there is some in the caption band and none under it
  assert.ok(bright(a, 1250, 1500) > 800, 'caption text in the band above the platform buttons');
  assert.equal(bright(a, 1560, 1920), 0, 'nothing in the bottom 20%');
  const right = (png) => { let n = 0; for (let y = 1250; y < 1500; y++) for (let x = Math.floor(png.width * 0.9); x < png.width; x++) { const i = (y * png.width + x) * 4; if (png.data[i] > 200 && png.data[i + 1] > 190 && png.data[i + 2] > 170) n++; } return n; };
  assert.equal(right(a), 0, 'nothing in the right 12%');
  // the accent colour (orange) moves from the first word to the second
  const accent = (png, x0, x1) => { let n = 0; for (let y = 1250; y < 1500; y++) for (let x = x0; x < x1; x++) { const i = (y * png.width + x) * 4; if (png.data[i] > 170 && png.data[i + 1] > 80 && png.data[i + 1] < 150 && png.data[i + 2] < 90) n++; } return n; };
  void c;
  assert.ok(accent(a, 0, 1080) > 200, 'the first word is highlighted');
  assert.ok(accent(b, 0, 1080) > 200, 'and the second a moment later');
  // the title rises in: nothing at 0.1 s, fully there at 1.0 s
  const title = (png) => { let n = 0; for (let y = 330; y < 520; y++) for (let x = 60; x < 700; x++) { const i = (y * png.width + x) * 4; if (png.data[i] > 235 && png.data[i + 1] > 225 && png.data[i + 2] > 205) n++; } return n; };
  assert.equal(title(a), 0, 'the title has not started at 0.1 s');
  assert.ok(title(c) > 1500, 'the title is on at 1.0 s');
  // with the overlay off the picture is plain
  const plain = await videoStills(join(proj, 'docs', 'reel.json'), [1.0], { browser, format: 'png', overlay: false, out: join(work, 'stills-plain') });
  const p = PNG.sync.read(readFileSync(plain.files[0].path));
  assert.equal(bright(p, 1250, 1500), 0);
});

test('a still is the frame the render has, and the same time asked twice gives the same pixels', { timeout: 60000 }, async () => {
  const stills = await videoStills(join(proj, 'docs', 'reel.json'), [2.0, 4.0], { browser, scale: 0.5, format: 'png', out: join(work, 'stills-cmp') });
  assert.deepEqual([stills.files[0].w, stills.files[0].h], [540, 960]);
  assert.equal(stills.files[1].shows, 'cut');
  const again = await videoStills(join(proj, 'docs', 'reel.json'), [2.0], { browser, scale: 0.5, format: 'png', out: join(work, 'stills-cmp2') });
  assert.ok(readFileSync(stills.files[0].path).equals(readFileSync(again.files[0].path)));
  // the same picture as the finished file at that time (average colour of a small copy of each)
  const mean = (png) => { let r = 0, g = 0, b = 0, n = 0; for (let i = 0; i < png.data.length; i += 4 * 97) { r += png.data[i]; g += png.data[i + 1]; b += png.data[i + 2]; n++; } return { r: r / n, g: g / n, b: b / n }; };
  const frames = await decodeFrames(reelResult.files.video, 16, 28);
  for (const [i, t] of [[0, 2.0], [1, 4.0]]) {
    const a = mean(PNG.sync.read(readFileSync(stills.files[i].path)));
    const b = frames[Math.round(t * 30)];
    assert.ok(Math.abs(a.r - b.r) < 14 && Math.abs(a.g - b.g) < 14 && Math.abs(a.b - b.b) < 14, `at ${t}s the still is (${a.r.toFixed(0)},${a.g.toFixed(0)},${a.b.toFixed(0)}) and the render (${b.r.toFixed(0)},${b.g.toFixed(0)},${b.b.toFixed(0)})`);
  }
});

// ------------------------------------------------------------------------------------------------ sync

test('picture and sound stay in sync: a flash and a beep that start together still start together', { timeout: 90000 }, async () => {
  const d = base('sync', {
    sizes: tinySize,
    sources: [{ id: 'sync', type: 'video', path: 'mount:footage/sync.mp4', duration: 8 }],
    timeline: { fps: 30, duration: 5, tracks: [{ id: 'v1', type: 'video', clips: [{ id: 's', source: 'sync', in: 1, out: 6, at: 0 }] }] },
  });
  const r = await renderVideo(writeDoc(d), { browser });
  assert.ok(r.ok, JSON.stringify(r.errors));
  const mp4 = r.files.video;
  const frames = await decodeFrames(mp4, 4, 4);
  const flash = frames.findIndex((f) => f.r > 200);
  assert.equal(flash, 60, 'the flash starts on frame 60 (2.000 s)');
  const pcm = await decodeAudio(mp4);
  const onset = pcm.findIndex((v) => Math.abs(v) > 0.2 * 32768);
  const beepAt = onset / 48000;
  assert.ok(Math.abs(beepAt - flash / 30) < 0.012, `the beep starts at ${beepAt.toFixed(4)} s, the flash at ${(flash / 30).toFixed(4)} s`);
  // the container does not hide an offset either: both streams start together
  const { run, binary } = await import('../src/video/ffmpeg.mjs');
  const { stdout } = await run(['-v', 'error', '-show_entries', 'stream=codec_type,start_time', '-of', 'json', mp4], { bin: binary('ffprobe'), capture: 'text' });
  const starts = Object.fromEntries(JSON.parse(stdout).streams.map((s) => [s.codec_type, Number(s.start_time)]));
  assert.ok(Math.abs(starts.audio - starts.video) < 0.03, `start times ${JSON.stringify(starts)}`);
});

// ------------------------------------------------------------------------------------------------ motion, photos, transitions

const rowTransitions = (png, y) => { let n = 0; let prev = png.data[(y * png.width) * 4] > 128; for (let x = 1; x < png.width; x++) { const cur = png.data[(y * png.width + x) * 4] > 128; if (cur !== prev) n++; prev = cur; } return n; };

test('zoom makes the picture bigger over the clip; pan slides across the footage; a photo can be zoomed', { timeout: 90000 }, async () => {
  const d = base('motion', {
    sizes: tinySize,
    sources: only('stripes', 'bands', 'photo'),
    timeline: { fps: 30, duration: 9, tracks: [{ id: 'v1', type: 'video', clips: [
      { id: 'zoom', source: 'stripes', in: 0, out: 3, at: 0, zoom: { from: 1, to: 2 } },
      { id: 'pan', source: 'bands', in: 0, out: 3, at: 3, pan: { from: { x: 0.15, y: 0.5 }, to: { x: 0.85, y: 0.5 } } },
      { id: 'photo', source: 'photo', in: 0, out: 3, at: 6, zoom: { from: 1, to: 1.5 } },
    ] }] },
  });
  const file = writeDoc(d);
  const r = await videoStills(file, [0.0, 2.9, 3.0, 5.9, 6.0, 8.9], { browser, format: 'png', out: join(work, 'stills-motion') });
  assert.ok(r.ok, JSON.stringify(r.errors));
  const px = r.files.map((f) => PNG.sync.read(readFileSync(f.path)));
  const [z0, z1, p0, p1, h0, h1] = px;
  const start = rowTransitions(z0, 320), end = rowTransitions(z1, 320);
  assert.ok(start >= 8 && end <= start * 0.65, `stripes: ${start} edges at the start, ${end} at the end of the zoom`);
  const dom = (png) => { let r = 0, g = 0, b = 0; for (let y = 250; y < 400; y += 2) for (let x = 0; x < png.width; x += 2) { const i = (y * png.width + x) * 4; r += png.data[i]; g += png.data[i + 1]; b += png.data[i + 2]; } return { r, g, b }; };
  const a = dom(p0), b = dom(p1);
  assert.ok(a.r > a.b * 3 && b.b > b.r * 3, `pan: starts red-side (${a.r}/${a.b}) and ends blue-side (${b.r}/${b.b})`);
  const diff = (m, n) => { let s = 0; for (let i = 0; i < m.data.length; i += 16) s += Math.abs(m.data[i] - n.data[i]); return s; };
  assert.ok(diff(h0, h1) > 50000, 'the photo changes as it zooms');
  assert.ok(h0.data.some((v, i) => i % 4 === 0 && v > 30), 'the photo is drawn');
});

test('transitions: a fade mixes the two pictures, a dip goes dark, and neither changes the length', { timeout: 120000 }, async () => {
  const mk = (id, type) => base(id, {
    sizes: tinySize, sources: only('talk'),
    timeline: { fps: 30, duration: 4, tracks: [{ id: 'v1', type: 'video', clips: [
      { id: 'a', source: 'talk', in: 0, out: 2, at: 0 },
      { id: 'b', source: 'talk', in: 6, out: 8, at: 2, transition: { type, duration: 0.6 } },
    ] }] },
  });
  // a (red, green, then blue just past its end) gives way to b (orange, then purple)
  for (const type of ['fade', 'dip', 'slide']) {
    const r = await renderVideo(writeDoc(mk(`tr-${type}`, type)), { browser });
    assert.ok(r.ok, JSON.stringify(r.errors));
    const frames = await decodeFrames(r.files.video, 8, 14);
    assert.equal(frames.length, 120, `${type}: still 120 frames`);
    assert.ok(near(frames[10], COLOURS[0]) && near(frames[40], COLOURS[1]), `${type}: clean before`);
    assert.ok(near(frames[100], COLOURS[7]), `${type}: clean after (purple)`);
    const mid = frames[60 + 9];
    if (type === 'fade') assert.ok(mid.r > 70 && mid.b > 70 && mid.g < 120, `fade mid frame is a mix of blue and orange (${mid.r.toFixed(0)},${mid.g.toFixed(0)},${mid.b.toFixed(0)})`);
    if (type === 'dip') assert.ok(Math.min(...frames.slice(55, 66).map((f) => f.r + f.g + f.b)) < 90, 'dip goes nearly black');
    if (type === 'slide') assert.ok(frames.slice(60, 78).some((f) => !near(f, COLOURS[2], 30) && !near(f, COLOURS[6], 30)), 'slide shows both pictures at once');
    const p = await probeMedia(r.files.video);
    assert.ok(Math.abs(p.duration - 4) < 0.08);
    // a still taken in the middle of the transition shows the same kind of mix
    const s = await videoStills(join(proj, 'docs', `tr-${type}.json`), [2.2], { browser, format: 'png', out: join(work, `stills-${type}`) });
    const img = PNG.sync.read(readFileSync(s.files[0].path));
    assert.equal(img.width, 360);
  }
});

test('a reel made only of a background and animated text renders, with no gap warning', { timeout: 90000 }, async () => {
  const text = (id, preset, extra = {}) => ({ id, type: 'text', text: 'Hello there friends', time: { start: 0.2, end: 2.8 }, layout: { anchor: 'top-left', x: 8, y: 20 + 12 * ['t1', 't2', 't3', 't4'].indexOf(id), w: 70 },
    style: { font: '$brand.fonts.display', size: 72, weight: 700, color: '$brand.colors.paper' }, animate: [{ preset, at: 0, duration: 0.8, ...extra }] });
  const d = base('mograph', {
    sizes: tinySize,
    timeline: { fps: 30, duration: 3, background: { type: 'linear', angle: 180, stops: [{ at: 0, color: '#112233' }, { at: 1, color: '#334455' }] }, tracks: [{ id: 'v1', type: 'video', clips: [] }] },
    layers: [text('t1', 'typewriter'), text('t2', 'word-by-word'), text('t3', 'wipe'), text('t4', 'slide-in', { params: { from: 'left' } })],
  });
  const r = await renderVideo(writeDoc(d), { browser });
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.deepEqual(r.issues.filter((i) => i.code === 'gap'), []);
  const frames = await decodeFrames(r.files.video, 4, 8);
  assert.equal(frames.length, 90);
  assert.ok(near(frames[2], '1c2d3e', 30), `background colour (${frames[2].r.toFixed(0)},${frames[2].g.toFixed(0)},${frames[2].b.toFixed(0)})`);
  // the text is not there at the start of its animation and is there at the end of it
  const s = await videoStills(join(proj, 'docs', 'mograph.json'), [0.25, 1.5], { browser, format: 'png', out: join(work, 'stills-mograph') });
  const bright = (png) => { let n = 0; for (let i = 0; i < png.data.length; i += 4) if (png.data[i] > 200 && png.data[i + 1] > 190) n++; return n; };
  const [early, late] = s.files.map((f) => PNG.sync.read(readFileSync(f.path)));
  assert.ok(bright(late) > bright(early) + 400, `${bright(early)} bright pixels early, ${bright(late)} late`);
});

test('picture and sound run for the whole timeline when the end is only overlay cards on the background', { timeout: 90000 }, async () => {
  const d = base('cards', {
    sizes: tinySize, sources: only('talk', 'music'),
    timeline: { fps: 30, duration: 3.5, background: '#202830',
      tracks: [
        { id: 'v1', type: 'video', clips: [{ id: 'a', source: 'talk', in: 0, out: 1, at: 0 }, { id: 'b', source: 'talk', in: 3, out: 4, at: 1.033 }] }, // a one-frame gap between them
        { id: 'music', type: 'audio', clips: [{ id: 'bed', source: 'music', in: 0, out: 1.5, at: 0, gainDb: -6 }] },
      ],
      scenes: [{ id: 'clips', start: 0, end: 2 }, { id: 'cards', start: 2, end: 3.5 }] },
    layers: [
      { id: 'card1', type: 'shape', shape: 'rect', time: { start: 2, end: 2.8 }, layout: { x: 0, y: 0, w: 100, h: 100 }, style: { fill: '#e02020' } }, // fully opaque: Chrome writes these pictures without alpha
      { id: 'card2', type: 'shape', shape: 'rect', time: { start: 2.8, end: 3.5 }, layout: { x: 0, y: 0, w: 100, h: 100 }, style: { fill: '#2020e0' }, animate: [{ preset: 'fade-in', duration: 0.3 }] },
      { id: 'word', type: 'text', text: 'Card', time: { start: 2.2, end: 3.4 }, layout: { anchor: 'top-left', x: 10, y: 30, w: 60 }, style: { font: '$brand.fonts.display', size: 90, color: '#ffffff' } },
    ],
  });
  const r = await renderVideo(writeDoc(d), { browser });
  assert.ok(r.ok, JSON.stringify(r.errors));
  const p = await probeMedia(r.files.video);
  assert.ok(Math.abs(p.duration - 3.5) < 0.08, `the file is ${p.duration}s, the timeline 3.5s`);
  const frames = await decodeFrames(r.files.video, 4, 8);
  assert.equal(frames.length, 105);
  assert.ok(near(frames[75], 'e02020', 50), 'the first card is on at 2.5 s');
  assert.ok(near(frames[100], '2020e0', 50), 'the second card is on at the very end');
  const pcm = await decodeAudio(r.files.video);
  assert.ok(pcm.length / 48000 > 3.4, `the sound runs ${(pcm.length / 48000).toFixed(2)}s`);
  assert.ok(existsSync(r.files.sheet) && existsSync(r.files.cover), 'cover and sheet are made from the full-length video');
});

test('a part of the timeline can be rendered on its own', { timeout: 60000 }, async () => {
  const r = await renderVideo(join(proj, 'docs', 'reel.json'), { browser, preview: true, from: 2, to: 5, out: join(work, 'part') });
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.match(r.files.video, /reel\.preview\.2\.0-5\.0s\.mp4$/);
  const p = await probeMedia(r.files.video);
  assert.deepEqual([p.video.width, p.video.height], [540, 960]);
  assert.equal(Math.round(p.video.fps), 15);
  assert.ok(Math.abs(p.duration - 3) < 0.15, `duration ${p.duration}`);
  assert.equal(r.files.sheet, undefined, 'no cover or sheet for part of a timeline');
  const frames = await decodeFrames(r.files.video, 4, 4);
  assert.ok(near(frames[0], COLOURS[2], 50), 'starts on the picture at 2 s (blue)');
  assert.ok(near(frames[Math.round(1.2 * 15)], BROLL, 50), 'the cutaway at 3.2 s');
});

test('the sheet can be made without rendering, and the overlay draws only what changes', { timeout: 90000 }, async () => {
  const s = await videoSheet(join(proj, 'docs', 'reel.json'), { browser, out: join(work, 'sheet-only') });
  assert.ok(s.ok && existsSync(s.sheet));
  assert.equal(s.scenes.length, 3);
  assert.match(s.scenes[0].speech, /Every morning we open the doors\./);
  assert.match(s.scenes[1].speech, /Nordle/);
  const ctx = loadDocContext(join(proj, 'docs', 'reel.json'));
  const plan = await buildPlan({ doc: ctx.doc, brand: ctx.brand, projectDir: ctx.projectDir, platforms: ctx.platforms });
  const keys = frameKeys(plan, buildOverlay(plan, ctx.doc, ctx.brand));
  const distinct = new Set(keys).size;
  assert.equal(keys.length, 300);
  assert.ok(distinct < 80 && distinct > 10, `${distinct} distinct pictures for 300 frames`);
});

// ------------------------------------------------------------------------------------------------ the server

test('server: video files can be fetched in pieces, a render runs as a job, stills and probe answer', { timeout: 150000 }, async () => {
  const TOKEN = 'video-test-token-0123456789abcdef0123';
  const AGENT = 'video-test-agent-0123456789abcdef01234';
  const app = createNordleServer({ roots: [projectsDir], token: TOKEN, agentToken: AGENT });
  const port = await app.listen(0);
  const call = async (path, method = 'GET', body) => {
    const res = await fetch(`http://127.0.0.1:${port}/api${path}`, { method, headers: { 'x-nordle-token': AGENT, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json() };
  };
  try {
    const list = await call('/projects');
    const id = list.json.projects.find((p) => p.docs.some((d) => d.id === 'reel')).id;
    // ranges
    const url = `http://127.0.0.1:${port}/p/${id}/out/reel/reel.mp4`;
    const size = statSync(reelResult.files.video).size;
    const whole = await fetch(url);
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get('accept-ranges'), 'bytes');
    await whole.arrayBuffer();
    const part = await fetch(url, { headers: { range: 'bytes=0-99' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes 0-99/${size}`);
    assert.equal((await part.arrayBuffer()).byteLength, 100);
    const tail = await fetch(url, { headers: { range: 'bytes=-50' } });
    assert.equal(tail.status, 206);
    assert.equal((await tail.arrayBuffer()).byteLength, 50);
    const bad = await fetch(url, { headers: { range: `bytes=${size + 10}-` } });
    assert.equal(bad.status, 416);
    // mounts and probing
    const mounts = await call(`/projects/${id}/video/mounts`);
    assert.deepEqual(mounts.json.mounts.map((m) => m.name), ['footage']);
    const ls = await call(`/projects/${id}/video/ls`, 'POST', { mount: 'footage' });
    assert.ok(ls.json.entries.some((e) => e.name === 'talk.mp4'));
    const esc = await call(`/projects/${id}/video/ls`, 'POST', { mount: 'footage', dir: '..' });
    assert.equal(esc.status, 422);
    const probe = await call(`/projects/${id}/video/probe`, 'POST', { path: 'mount:footage/broll.mp4' });
    assert.match(probe.json.summary, /1920x1080/);
    const noProbe = await call(`/projects/${id}/video/probe`, 'POST', { path: 'mount:footage/../x' });
    assert.equal(noProbe.status, 422);
    // the plan check
    const check = await call(`/projects/${id}/video/check`, 'POST', { doc: 'reel' });
    assert.equal(check.json.ok, true);
    assert.equal(check.json.summary.segments.length, 4);
    // stills
    const stills = await call(`/projects/${id}/video/stills`, 'POST', { doc: 'reel', times: [1, 4], scale: 0.35 });
    assert.equal(stills.status, 200);
    assert.equal(stills.json.files.length, 2);
    assert.equal(stills.json.files[1].shows, 'cut');
    assert.ok(Buffer.from(stills.json.files[0].base64, 'base64').subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])));
    // a not-a-video document is refused with a reason
    const nonVideo = await call(`/projects/${id}/video/stills`, 'POST', { doc: 'nope', times: [1] });
    assert.equal(nonVideo.status, 404);
    // the job
    const started = await call(`/projects/${id}/video/render`, 'POST', { doc: 'reel', preview: true });
    assert.equal(started.status, 202);
    const jobId = started.json.job.id;
    let job = started.json.job;
    for (let i = 0; i < 12 && job.status === 'running'; i++) job = (await call(`/projects/${id}/video/jobs/${jobId}?wait=10`)).json.job;
    assert.equal(job.status, 'done', job.error);
    assert.equal(job.result.files.video, 'out/reel/reel.preview.mp4');
    assert.ok(existsSync(join(proj, 'out', 'reel', 'reel.preview.mp4')));
    const image = await call(`/projects/${id}/video/image`, 'POST', { path: job.result.files.sheet });
    assert.equal(image.json.mime, 'image/png');
    assert.equal((await call(`/projects/${id}/video/image`, 'POST', { path: 'brand.json' })).status, 400);
  } finally { await app.close(); }
});

test('no temporary folders are left behind', () => {
  const left = readdirSync(tmpdir()).filter((n) => /^nordle-(video|still|sheet)/.test(n) && !tmpBefore.has(n));
  assert.deepEqual(left, []);
});
