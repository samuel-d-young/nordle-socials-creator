// The reel composer: a short list of scenes becomes a valid video document with the right timeline, tracks, overlays and captions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ROOT, readJson, validateDocData } from '../tools/validate.mjs';
import { buildReelDoc, ReelSpecError } from '../src/shared/reel-spec.mjs';

const platforms = readJson(join(ROOT, 'data', 'platforms.json'));
const brand = readJson(join(ROOT, 'samples', 'little-gannet', 'brand.json'));
const projectDir = join(ROOT, 'samples', 'little-gannet');

const spec = () => ({
  id: 'reel-test', title: 'Reel test', label: 'Little Gannet', grade: 'warm',
  copy: { caption: 'Meet Maya.\nCome and see.', hashtags: ['#littlegannet'] },
  sources: {
    maya: { path: 'sources/raw-roast.mp4', transcript: 'sources/raw-roast.words.json' },
    shop: { path: 'sources/broll.mp4' },
    bed: { path: 'sources/music.wav', type: 'audio' },
  },
  captions: { source: 'maya', maxWordsPerLine: 3 },
  music: { source: 'bed', in: 1, gainDb: -12, duckDb: -14 },
  scenes: [
    { type: 'talk', source: 'maya', in: 2, out: 8, focal: { x: 0.45, y: 0.4 }, text: { kicker: 'Meet the team', headline: 'Maya', body: 'Head roaster' } },
    { type: 'cutaway', source: 'shop', in: 1, dur: 1.5, at: 2 },
    { type: 'clip', source: 'shop', in: 0, dur: 2.5, transition: 'fade', text: { headline: 'Small batches', pos: 'center' } },
    { type: 'card', pattern: 'statement', dur: 2, tone: 'dark', content: { headline: 'Every cup is made to order' } },
    { type: 'end', dur: 3, content: { headline: 'Come say hi', body: 'Quay Street, Port Wren', logo: true } },
  ],
});

test('scenes are laid end to end; cutaways sit on their own track over the talk; music ducks under the picture track', () => {
  const { doc } = buildReelDoc(spec(), { brand, platforms });
  const t = doc.timeline;
  assert.equal(doc.kind, 'video');
  assert.equal(t.duration, 6 + 2.5 + 2 + 3);
  assert.deepEqual(t.scenes.map((s) => [s.start, s.end]), [[0, 6], [6, 8.5], [8.5, 10.5], [10.5, 13.5]]);
  const v1 = t.tracks.find((x) => x.id === 'v1').clips;
  assert.deepEqual(v1.map((c) => [c.at, c.out - c.in]), [[0, 6], [6, 2.5]]);
  assert.equal(v1[0].grade, 'warm');
  assert.ok(!v1[0].mute, 'a talking clip keeps its sound');
  assert.equal(v1[1].mute, true, 'b-roll is silent');
  assert.deepEqual(v1[1].transition, { type: 'fade', duration: 0.3 });
  const v2 = t.tracks.find((x) => x.id === 'v2').clips;
  assert.equal(v2.length, 1);
  assert.equal(v2[0].at, 2, 'cutaway starts 2 s into the talking scene');
  const bed = t.tracks.find((x) => x.id === 'music').clips[0];
  assert.equal(bed.out - bed.in, t.duration);
  assert.deepEqual([bed.duck.under, bed.duck.amountDb], ['v1', -14]);
  assert.equal(t.captions.source, 'maya');
  assert.ok(t.background, 'cards need something behind them');
});

test('titles, label and card layers are timed, uniquely named, animated and inside the document', () => {
  const { doc } = buildReelDoc(spec(), { brand, platforms });
  const ids = new Set();
  const walk = (ls) => { for (const l of ls) { assert.ok(!ids.has(l.id), `duplicate ${l.id}`); ids.add(l.id); walk(l.children ?? []); } };
  walk(doc.layers);
  for (const l of doc.layers) { assert.ok(l.time && l.time.end > l.time.start, l.id); assert.ok(l.time.end <= doc.timeline.duration + 0.001, l.id); }
  assert.ok(doc.layers.some((l) => l.id.startsWith('label-')));
  assert.ok(doc.layers.some((l) => l.id === 's1-text' && l.animate?.some((a) => a.preset === 'rise-in')));
  assert.ok(doc.layers.some((l) => l.id === 's4-card' && l.shape === 'rect'), 'a card gets a full-page background shape');
  const bad = validateDocData(doc, { brand, projectDir, platforms, assets: false }).filter((i) => i.level === 'error');
  assert.deepEqual(bad, []);
});

test('a photo scene registers an image source with a slow zoom; mistakes are explained', () => {
  const s = spec();
  s.scenes.splice(2, 0, { type: 'photo', image: 'assets/hero-cup.svg', dur: 2 });
  const { doc } = buildReelDoc(s, { brand, platforms });
  const img = doc.sources.find((x) => x.type === 'image');
  assert.equal(img.path, 'assets/hero-cup.svg');
  assert.ok(doc.timeline.tracks[0].clips.some((c) => c.source === img.id && c.zoom?.to > 1));
  assert.throws(() => buildReelDoc({ ...spec(), scenes: [{ type: 'cutaway', source: 'shop', in: 0, dur: 1 }] }, { brand, platforms }), /needs a talk scene/);
  assert.throws(() => buildReelDoc({ ...spec(), scenes: [{ type: 'talk', source: 'nobody', in: 0, out: 3 }] }, { brand, platforms }), /unknown source "nobody"/);
  assert.throws(() => buildReelDoc({ ...spec(), scenes: [{ type: 'talk', source: 'maya', in: 0 }] }, { brand, platforms }), /needs "in" and "out"/);
  assert.throws(() => buildReelDoc({ ...spec(), scenes: [{ type: 'zoom' }] }, { brand, platforms }), ReelSpecError);
});

test('a closing panel rises over the end of a footage scene, inside the safe area, timed to that scene, and the doc stays valid', () => {
  const s = spec();
  s.scenes = [
    { type: 'clip', source: 'shop', in: 0, dur: 3, text: { headline: 'Small batches' } },
    { type: 'clip', source: 'shop', in: 3, dur: 3.2, zoom: { from: 1, to: 1.04 }, endPanel: { kicker: 'Come by', headline: 'Come and say hello', url: 'littlegannet.example/visit', phoneLine: 'or call 0400 000 000', disclaimer: 'A short line of small print.' } },
  ];
  const { doc } = buildReelDoc(s, { brand, platforms });
  assert.equal(doc.timeline.duration, 6.2);
  assert.ok(!doc.timeline.background, 'the reel ends on footage, not on a card');
  const panel = doc.layers.find((l) => l.id === 's2-end-panel');
  assert.ok(panel, 'the panel card is there');
  assert.ok(panel.time.start >= 3 && panel.time.end === 6.2, 'it appears inside the last scene and stays to the end');
  assert.ok(panel.layout.y + panel.layout.h <= 80.5, `the card ends above the covered strip (${panel.layout.y + panel.layout.h}%)`);
  for (const id of ['kicker', 'headline', 'url', 'phone', 'disclaimer', 'rule']) {
    const l = doc.layers.find((x) => x.id === `s2-end-${id}`);
    assert.ok(l, `${id} is drawn`);
    assert.ok(l.layout.y >= panel.layout.y && l.layout.y < panel.layout.y + panel.layout.h, `${id} sits on the card`);
    assert.ok(l.time.start >= panel.time.start, `${id} comes in with or after the card`);
  }
  assert.equal(doc.layers.filter((l) => l.id.startsWith('s1-end')).length, 0, 'nothing on the first scene');
  assert.deepEqual(validateDocData(doc, { projectDir }).errors ?? [], []);
});

test('the closing card can sit at the top when the subject is low in the picture, and its small line never wraps onto the headline', () => {
  const s = spec();
  s.scenes = [{ type: 'clip', source: 'shop', in: 0, dur: 3.2, endPanel: { kicker: 'Questions about your dentures?', headline: 'Ask us at your next visit', url: 'x.example/book', position: 'top' } }];
  const { doc } = buildReelDoc(s, { brand, platforms });
  const panel = doc.layers.find((l) => l.id === 's1-end-panel');
  assert.ok(panel.layout.y >= 13, `the top card starts under the covered top strip (${panel.layout.y}%)`);
  const kicker = doc.layers.find((l) => l.id === 's1-end-kicker');
  const head = doc.layers.find((l) => l.id === 's1-end-headline');
  const lines = Math.ceil((kicker.text.length * (kicker.style.size * 0.66 + kicker.style.size * kicker.style.letterSpacing)) / ((kicker.layout.w / 100) * 1080));
  assert.equal(lines, 1, 'the kicker fits on one line');
  assert.ok(kicker.style.size < 26 && head.layout.y > kicker.layout.y, 'and sits above the headline');
  assert.deepEqual(validateDocData(doc, { projectDir }).errors ?? [], []);
});

test('cleanAudio on a reel spec reaches every footage clip, and the document is still valid', () => {
  const { doc } = buildReelDoc({ ...spec(), cleanAudio: true }, { brand, platforms });
  const footage = doc.timeline.tracks.flatMap((t) => t.clips).filter((c) => c.source && c.source !== 'bed');
  assert.ok(footage.length >= 2);
  assert.ok(footage.every((c) => c.cleanAudio === true), 'every footage clip asks for noise reduction');
  assert.deepEqual(validateDocData(doc, { projectDir }).errors ?? [], []);
  const plain = buildReelDoc(spec(), { brand, platforms }).doc.timeline.tracks.flatMap((t) => t.clips);
  assert.ok(plain.every((c) => c.cleanAudio === undefined), 'off unless asked for');
});

test('the soft grade (neutral with a hint of warmth) is accepted by the document and put on every footage clip', () => {
  const { doc } = buildReelDoc({ ...spec(), grade: 'soft' }, { brand, platforms });
  const clips = doc.timeline.tracks.flatMap((t) => t.clips).filter((c) => c.source && c.type !== 'audio' && c.grade);
  assert.ok(clips.length >= 2 && clips.every((c) => c.grade === 'soft'), 'footage clips carry the soft grade');
  const bad = validateDocData(doc, { brand, projectDir, platforms, assets: false }).filter((i) => i.level === 'error');
  assert.deepEqual(bad, []);
});
