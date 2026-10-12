// Motion-graphics reels: with no footage at all, and timed to a voice-over word by word. Pure: the word timings are handed in, nothing is read or rendered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ROOT, readJson, validateDocData } from '../tools/validate.mjs';
import { buildReelDoc, ReelSpecError } from '../src/shared/reel-spec.mjs';
import { findPhrase, spokenWords } from '../src/shared/voice-sync.mjs';

const platforms = readJson(join(ROOT, 'data', 'platforms.json'));
const brand = readJson(join(ROOT, 'samples', 'little-gannet', 'brand.json'));
const projectDir = join(ROOT, 'samples', 'little-gannet');

// "Small batches. Roasted to order. Come and see us on Quay Street." with times
const WORDS = [['Small', 1.0, 1.3], ['batches.', 1.3, 1.9], ['Roasted', 2.6, 3.0], ['to', 3.0, 3.1], ['order.', 3.1, 3.6], ['Come', 4.4, 4.6], ['and', 4.6, 4.7], ['see', 4.7, 4.9], ['us', 4.9, 5.0], ['on', 5.0, 5.1], ['Quay', 5.1, 5.4], ['Street.', 5.4, 6.0]]
  .map(([text, start, end]) => ({ text, start, end }));

const voSpec = (over = {}) => ({
  id: 'motion-vo', title: 'Motion with a voice',
  sources: { vo: { path: 'sources/music.wav', type: 'audio', transcript: 'sources/vo.words.json' }, bed: { path: 'sources/music.wav', type: 'audio' } },
  voiceover: { source: 'vo', in: 0.8 },
  captions: { maxWordsPerLine: 3 },
  music: { source: 'bed', in: 0, gainDb: -14 },
  scenes: [
    { type: 'card', pattern: 'statement', say: 'small batches', content: { headline: 'Small batches' } },
    { type: 'card', pattern: 'statement', say: 'roasted to order', content: { headline: 'Roasted to order' } },
    { type: 'end', say: 'come and see us on Quay Street', content: { headline: 'Quay Street', logo: true } },
  ],
  ...over,
});
const build = (s) => buildReelDoc(s, { brand, platforms, transcripts: { vo: WORDS } });

test('findPhrase: ignores case and punctuation, searches in order, and "..." runs from the first words to the last', () => {
  const w = spokenWords(WORDS);
  assert.deepEqual(findPhrase(w, 'SMALL batches'), { start: 1.0, end: 1.9, first: 0, last: 1 });
  assert.equal(findPhrase(w, 'roasted to order').start, 2.6);
  assert.deepEqual([findPhrase(w, 'roasted ... quay street').start, findPhrase(w, 'roasted ... quay street').end], [2.6, 6.0]);
  assert.equal(findPhrase(w, 'small batches', { after: 1.5 }), null, 'not found after that point');
  assert.equal(findPhrase(w, 'never said'), null);
});

test('a voice-over reel: every scene runs from just before its words to just before the next scene\'s words, and the voice and captions ride along', () => {
  const { doc } = build(voSpec());
  const t = doc.timeline;
  // the recording starts 0.8 s in, so "small batches" is said at 0.2 s; scenes change 0.15 s ahead of the next words
  assert.deepEqual(t.scenes.map((s) => [s.start, s.end]), [[0, 1.65], [1.65, 3.45], [3.45, 5.5]]);
  const vo = t.tracks.find((x) => x.id === 'vo');
  assert.equal(vo.type, 'audio');
  assert.equal(vo.clips[0].in, 0.8);
  assert.ok(vo.clips[0].out > 6, 'the recording plays to the end of its words');
  assert.equal(t.tracks.find((x) => x.id === 'music').clips[0].duck.under, 'vo', 'music ducks under the voice');
  assert.equal(t.captions.source, 'vo', 'captions follow the voice-over');
  assert.equal(t.tracks.find((x) => x.id === 'v1').clips.length, 0, 'no footage at all');
  assert.ok(t.background);
  assert.deepEqual(validateDocData(doc, { brand, projectDir, platforms, assets: false }).filter((i) => i.level === 'error'), []);
});

test('layers can show by the words they go with', () => {
  const { doc } = build(voSpec({ layers: [{ id: 'tag', type: 'shape', shape: 'rect', layout: { x: 10, y: 10, w: 30, h: 1 }, style: { fill: '#ffffff' }, time: { say: 'roasted ... order', hold: 0.5 } }] }));
  const l = doc.layers.find((x) => x.id === 'tag');
  assert.deepEqual([l.time.start, l.time.end], [1.65, 3.6 - 0.8 + 0.5]);
});

test('mistakes are said plainly: words that are not said, say without a voice-over, no word timings', () => {
  assert.throws(() => build(voSpec({ scenes: [{ type: 'card', pattern: 'statement', say: 'free coffee', content: { headline: 'x' } }] })), /never says "free coffee"/);
  assert.throws(() => buildReelDoc({ ...voSpec(), voiceover: undefined }, { brand, platforms }), /needs a "voiceover"/);
  assert.throws(() => buildReelDoc(voSpec(), { brand, platforms, transcripts: {} }), /no word timings/);
  assert.throws(() => build(voSpec({ scenes: [{ type: 'talk', source: 'bed', in: 0, out: 2, say: 'small' }] })), ReelSpecError);
});

test('motion graphics only, no voice: cards and layers alone make a valid reel', () => {
  const { doc } = buildReelDoc({
    id: 'motion-only', title: 'Motion only',
    scenes: [
      { type: 'card', pattern: 'stat', dur: 2.5, content: { number: '3', label: 'steps' } },
      { type: 'card', pattern: 'list', dur: 3, content: { headline: 'What to expect', items: ['A chat', 'A look', 'A plan'] } },
      { type: 'end', dur: 3, content: { headline: 'Come and see us' } },
    ],
  }, { brand, platforms });
  assert.equal(doc.timeline.duration, 8.5);
  assert.deepEqual(doc.sources, []);
  assert.deepEqual(validateDocData(doc, { brand, projectDir, platforms, assets: false }).filter((i) => i.level === 'error'), []);
});
