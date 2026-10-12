// The motion kit and the engine features under it: every recipe makes a valid document in every shape, the kit only uses animations the engine knows, and radial glows,
// blur, blend modes and drawn paths reach the page. Pure: nothing is rendered or started.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ROOT, readJson, validateDocData } from '../tools/validate.mjs';
import { buildReelDoc, ReelSpecError } from '../src/shared/reel-spec.mjs';
import { MOTION_BACKGROUNDS, MOTION_RECIPES } from '../src/shared/motion-kit.mjs';
import { PRESETS } from '../src/video/overlay.mjs';
import { buildPageHtml } from '../src/render/html.mjs';
import { NODE_URLS, loadFontManifest } from '../src/render/urls.mjs';

const platforms = readJson(join(ROOT, 'data', 'platforms.json'));
const brand = readJson(join(ROOT, 'samples', 'little-gannet', 'brand.json'));
const projectDir = join(ROOT, 'samples', 'little-gannet');

const CONTENT = {
  kinetic: { kicker: 'First visit', headline: 'Nervous?\nYou are not alone', accent: 'not alone', body: 'We go at your pace' },
  number: { kicker: 'Since 2016', number: '98', suffix: '%', label: 'Single-origin beans', note: 'Traceable to the farm', progress: 0.98 },
  list: { kicker: 'Your first visit', headline: 'What to expect', items: ['A warm welcome', 'A look at the menu', 'Your first cup'] },
  quote: { quote: 'The best coffee is the one you share.', by: 'Maya, head roaster' },
  bars: { kicker: 'On the menu', headline: 'Cups a day', items: [{ label: 'Flat white', value: 120 }, { label: 'Latte', value: 90 }, { label: 'Filter', value: 30 }] },
  ticker: { words: ['Roast', 'Pour', 'Share'], headline: 'Fresh daily' },
  reveal: { kicker: 'Opening soon', headline: 'Quay Street' },
  logo: { line: 'Come and say hello', url: 'littlegannet.example' },
};
const spec = (size, scenes) => ({ id: 'motion-kit-test', title: 'Motion kit test', sizes: [size], scenes });
const SHAPES = ['ig-reel-9x16', 'ig-feed-1x1', 'ig-feed-4x5', 'yt-landscape-16x9'];

test('every recipe, on every background, in every shape, makes a valid document with timed, animated layers', () => {
  for (const size of SHAPES) {
    const scenes = MOTION_RECIPES.map((recipe, i) => ({ type: 'motion', recipe, dur: 3.2, background: MOTION_BACKGROUNDS[i % MOTION_BACKGROUNDS.length], tone: recipe === 'quote' ? 'accent' : i % 3 === 2 ? 'light' : 'dark', sweep: i % 2 === 1, content: CONTENT[recipe] }));
    const { doc } = buildReelDoc(spec(size, scenes), { brand, platforms });
    assert.equal(doc.timeline.duration, MOTION_RECIPES.length * 3.2, size);
    const bad = validateDocData(doc, { brand, projectDir, platforms, assets: false }).filter((x) => x.level === 'error');
    assert.deepEqual(bad, [], `${size}: ${JSON.stringify(bad[0])}`);
    for (const l of doc.layers) {
      assert.ok(l.time.start >= 0 && l.time.end <= doc.timeline.duration + 1e-6 && l.time.end > l.time.start, `${size} ${l.id}: its time is inside the reel`);
    }
    assert.ok(doc.layers.length > 80, `${size}: a rich scene set (${doc.layers.length} layers)`);
  }
});

test('the kit only asks for animations the engine has, and uses the new ones', () => {
  const scenes = MOTION_RECIPES.map((recipe) => ({ type: 'motion', recipe, dur: 3, content: CONTENT[recipe] }));
  const { doc } = buildReelDoc(spec('ig-reel-9x16', scenes), { brand, platforms });
  const used = new Set();
  for (const l of doc.layers) for (const a of l.animate ?? []) if (a.preset) used.add(a.preset);
  for (const p of used) assert.ok(PRESETS.includes(p), `"${p}" is a known preset`);
  for (const p of ['blur-in', 'tracking-in', 'count-up', 'draw', 'spin-in', 'scale-in', 'float', 'pulse', 'drift', 'typewriter', 'word-by-word', 'wipe-out']) assert.ok(used.has(p), `the kit uses ${p}`);
  const shapes = new Set(doc.layers.map((l) => l.shape).filter(Boolean));
  assert.ok(shapes.has('path') && shapes.has('ellipse') && shapes.has('rect'));
  const blends = doc.layers.map((l) => l.style?.blend).filter(Boolean);
  assert.ok(blends.includes('screen'), 'glows are screened over the dark ground');
});

test('a number scene counts up to its number inside a ring that draws to its progress', () => {
  const { doc } = buildReelDoc(spec('ig-reel-9x16', [{ type: 'motion', recipe: 'number', dur: 3, content: { number: '98', suffix: '%', label: 'x', progress: 0.5 } }]), { brand, platforms });
  const num = doc.layers.find((l) => l.id.endsWith('-number'));
  const count = num.animate.find((a) => a.preset === 'count-up');
  assert.deepEqual([count.params.to, count.params.suffix, num.text], [98, '%', '0%']);
  const ring = doc.layers.find((l) => l.id.endsWith('-ring'));
  assert.equal(ring.shape, 'path');
  assert.ok(ring.animate.some((a) => a.preset === 'draw'));
  assert.match(ring.d, /A46 46 0 0 1/, 'half way round is a short arc');
});

test('motion scenes can follow a voice-over like any other scene, and mistakes are said plainly', () => {
  const words = [['Small', 1, 1.3], ['batches.', 1.3, 1.9], ['Roasted', 2.6, 3], ['to', 3, 3.1], ['order.', 3.1, 3.6]].map(([text, start, end]) => ({ text, start, end }));
  const s = {
    id: 'motion-vo-test', title: 'x', sources: { vo: { path: 'sources/music.wav', type: 'audio', transcript: 'sources/vo.words.json' } }, voiceover: { source: 'vo', in: 0.8 },
    scenes: [{ type: 'motion', recipe: 'kinetic', say: 'small batches', content: { headline: 'Small batches' } }, { type: 'motion', recipe: 'reveal', say: 'roasted to order', content: { headline: 'Roasted to order' } }],
  };
  const { doc } = buildReelDoc(s, { brand, platforms, transcripts: { vo: words } });
  assert.deepEqual(doc.timeline.scenes.map((x) => [x.start, x.end]), [[0, 1.65], [1.65, 3.1]]);
  assert.throws(() => buildReelDoc(spec('ig-reel-9x16', [{ type: 'motion', recipe: 'nope', content: {} }]), { brand, platforms }), /unknown motion recipe "nope"/);
  assert.throws(() => buildReelDoc(spec('ig-reel-9x16', [{ type: 'motion', recipe: 'kinetic', background: 'lava', content: { headline: 'x' } }]), { brand, platforms }), /unknown background "lava"/);
  assert.throws(() => buildReelDoc(spec('ig-reel-9x16', [{ type: 'motion', recipe: 'number', content: {} }]), { brand, platforms }), /needs content\.number/);
  assert.throws(() => buildReelDoc(spec('ig-reel-9x16', [{ type: 'motion', recipe: 'list', content: { items: ['one'] } }]), { brand, platforms }), ReelSpecError);
});

test('the renderer draws radial glows that fade at their own edge, blur, blend modes and paths that can be traced', () => {
  const doc = { schema: 'nordle.doc/0.1', id: 'fx', title: 'fx', kind: 'graphic', brand: brand.id, sizes: ['ig-reel-9x16'], pages: [{ id: 'p', layers: [] }] };
  const page = {
    id: 'p', background: '#000000',
    layers: [
      { id: 'glow', type: 'shape', shape: 'ellipse', layout: { x: 50, y: 50, w: 80, h: 40 }, style: { fill: { type: 'radial', x: 50, y: 50, stops: [{ at: 0, color: '#ff8800ff' }, { at: 1, color: '#ff880000' }] }, blur: 12, blend: 'screen' } },
      { id: 'swash', type: 'shape', shape: 'path', d: 'M2 55 Q 22 5 42 55 T 98 45', layout: { x: 10, y: 10, w: 50, h: 5 }, style: { stroke: { color: '#ffffff', width: 8 } } },
    ],
  };
  const { html } = buildPageHtml({ doc: { ...doc, pages: [page] }, brand, size: { id: 'ig-reel-9x16', w: 1080, h: 1920, safe: { top: 0.1, right: 0.1, bottom: 0.1, left: 0.1 } }, page, fontManifest: loadFontManifest(), urls: NODE_URLS });
  assert.match(html, /radial-gradient\(closest-side at 50% 50%/);
  assert.match(html, /filter:blur\(calc\(var\(--u\) \* 12\)\)/);
  assert.match(html, /mix-blend-mode:screen/);
  assert.match(html, /<path d="M2 55 Q 22 5 42 55 T 98 45" pathLength="1"[^>]*stroke-dasharray="1" stroke-dashoffset="0"/);
  assert.match(html, /stroke-width:calc\(var\(--u\) \* 8\)/);
});
