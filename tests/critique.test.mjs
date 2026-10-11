// Grading a design: each rule fires on what it should and stays quiet on a good page.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { ROOT } from '../tools/validate.mjs';
import { openBrowser } from '../src/render/browser.mjs';
import { critiquePage, critiqueSet, critiqueStatic, critiqueDocument, scoreOf, backdropStats, loadRubric } from '../src/render/critique.mjs';

const R = loadRubric();
const size = { id: 'ig-feed-4x5', w: 1080, h: 1350 };
const page = { id: 'p1', layers: [{}, {}] };
const text = (id, o = {}) => ({ id, type: 'text', text: o.text ?? 'Some words here', fontSize: o.px ?? 40, fontWeight: '400', family: o.family ?? "'Inter Variable', system-ui", align: o.align ?? 'left', textWrap: o.wrap ?? 'wrap', opacity: 1,
  rect: o.rect ?? { x: 86, y: 300, w: 600, h: 60 }, boxRect: o.rect ?? { x: 86, y: 300, w: 600, h: 60 }, lineWidths: o.lines ?? [600], ignoreSafe: o.ignoreSafe });
const rules = (issues) => issues.map((i) => `${i.level}:${i.rule}`);
const solidPng = (v) => { const p = new PNG({ width: 20, height: 20 }); p.data.fill(v); return p; };

let browser, work;
before(async () => { browser = await openBrowser(); work = mkdtempSync(join(tmpdir(), 'nordle-crit-')); });
after(async () => { await browser?.close(); rmSync(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }); });

const good = () => [
  text('kicker', { px: 28, rect: { x: 86, y: 100, w: 300, h: 34 }, text: 'NEW THIS SEASON', lines: [300] }),
  text('headline', { px: 132, rect: { x: 86, y: 160, w: 840, h: 270 }, text: 'Spring menu is here', lines: [840, 520] }),
  text('sub', { px: 40, rect: { x: 86, y: 470, w: 480, h: 110 }, text: 'Three new pours. Open from 7 am.', lines: [420, 340] }),
  { id: 'cup', type: 'image', boxRect: { x: 380, y: 640, w: 640, h: 640 }, opacity: 1, naturalW: 0, vector: true },
];

test('a well-made page raises nothing', () => {
  assert.deepEqual(critiquePage({ rubric: R, size, page, layers: good() }), []);
});

test('an empty page is an error', () => {
  assert.deepEqual(rules(critiquePage({ rubric: R, size, page, layers: [] })), ['error:empty-page']);
});

test('hierarchy: a headline barely bigger than the next text is flagged, and all-one-size text is noted', () => {
  const l = good();
  l[1].fontSize = 60; // vs 40
  assert.ok(rules(critiquePage({ rubric: R, size, page, layers: l })).includes('warn:hierarchy'));
  const flat = good().map((t) => (t.type === 'text' ? { ...t, fontSize: 40 } : t));
  assert.ok(rules(critiquePage({ rubric: R, size, page, layers: flat })).includes('info:flat-hierarchy'));
});

test('type scale and fonts: too many sizes or families are flagged', () => {
  const l = [...good(), text('a', { px: 52, rect: { x: 86, y: 620, w: 200, h: 60 } }), text('b', { px: 68, rect: { x: 86, y: 700, w: 200, h: 60 } }), text('c', { px: 90, rect: { x: 86, y: 780, w: 200, h: 60 } })];
  assert.ok(rules(critiquePage({ rubric: R, size, page, layers: l })).includes('warn:type-scale'));
  const fonts = good();
  fonts[0].family = "'Fraunces Variable', serif"; fonts[2].family = "'Playfair', serif";
  assert.ok(rules(critiquePage({ rubric: R, size, page, layers: fonts })).includes('warn:type-families'));
});

test('margins and alignment', () => {
  const l = good();
  l[2].rect = { x: 20, y: 470, w: 480, h: 110 }; l[2].boxRect = l[2].rect;
  assert.ok(rules(critiquePage({ rubric: R, size, page, layers: l })).includes('warn:tight-margin'));
  l[2].ignoreSafe = true;
  assert.ok(!rules(critiquePage({ rubric: R, size, page, layers: l })).includes('warn:tight-margin'), 'bleeds that are meant to touch the edge can be marked');
  const messy = good();
  [[2, 160], [1, 300], [0, 540]].forEach(([i, x]) => { messy[i].rect = { ...messy[i].rect, x }; messy[i].boxRect = messy[i].rect; });
  messy.push(text('extra', { rect: { x: 700, y: 640, w: 200, h: 40 } }));
  assert.ok(rules(critiquePage({ rubric: R, size, page, layers: messy })).includes('warn:alignment'));
});

test('text that collides with other text is an error', () => {
  const l = good();
  l[2].rect = { x: 86, y: 300, w: 480, h: 110 }; l[2].boxRect = l[2].rect; // on top of the headline
  const r = critiquePage({ rubric: R, size, page, layers: l });
  assert.ok(rules(r).includes('error:text-collision'), JSON.stringify(rules(r)));
});

test('text over a busy image warns; over a calm area, a label on a button, or a background does not', () => {
  const busy = new PNG({ width: 1080, height: 1350 });
  for (let i = 0; i < busy.data.length; i += 4) { const v = ((i >> 2) % 7 < 3) ? 255 : 0; busy.data[i] = busy.data[i + 1] = busy.data[i + 2] = v; busy.data[i + 3] = 255; }
  const photo = { id: 'photo', type: 'image', boxRect: { x: 0, y: 500, w: 1080, h: 600 }, opacity: 1, naturalW: 2400, vector: false };
  const l = [text('headline', { px: 132, rect: { x: 86, y: 160, w: 840, h: 270 } }), text('sub', { px: 40, rect: { x: 86, y: 700, w: 480, h: 110 } }), photo];
  assert.ok(rules(critiquePage({ rubric: R, size, page, layers: l, backdrop: busy })).includes('warn:busy-background'));
  assert.ok(!rules(critiquePage({ rubric: R, size, page, layers: l, backdrop: solidPng(240) })).includes('warn:busy-background'));
  const button = { id: 'pill', type: 'shape', boxRect: { x: 60, y: 690, w: 560, h: 140 }, opacity: 1 };
  assert.ok(!rules(critiquePage({ rubric: R, size, page, layers: [l[0], l[1], button], backdrop: busy })).includes('warn:busy-background'));
  const bg = { id: 'bg', type: 'shape', boxRect: { x: 0, y: 0, w: 1080, h: 1350 }, opacity: 1 };
  assert.ok(!rules(critiquePage({ rubric: R, size, page, layers: [bg, l[0], l[1]], backdrop: busy })).includes('warn:busy-background'));
});

test('density and balance', () => {
  const sparse = [text('headline', { px: 90, rect: { x: 86, y: 100, w: 300, h: 100 } }), text('sub', { px: 40, rect: { x: 86, y: 220, w: 300, h: 50 } })];
  assert.ok(rules(critiquePage({ rubric: R, size, page, layers: sparse })).includes('warn:too-empty'));
  const crowded = Array.from({ length: 7 }, (_, i) => text(`t${i}`, { px: 40 + (i % 2) * 90, rect: { x: 60, y: 60 + i * 180, w: 960, h: 170 } }));
  assert.ok(rules(critiquePage({ rubric: R, size, page, layers: crowded })).includes('warn:too-crowded'));
  const left = [text('headline', { px: 132, rect: { x: 60, y: 560, w: 300, h: 200 } }), text('sub', { px: 40, rect: { x: 60, y: 780, w: 300, h: 60 } })];
  assert.ok(rules(critiquePage({ rubric: R, size, page, layers: left })).includes('info:balance'));
});

test('the words: long headline, orphan on the last line, long lines, lots of small text', () => {
  const l = good();
  l[1].lineWidths = [800, 780, 790, 760, 700];
  assert.ok(rules(critiquePage({ rubric: R, size, page, layers: l })).includes('warn:long-headline'));
  const widow = good();
  widow[2].lineWidths = [440, 410, 60];
  assert.ok(rules(critiquePage({ rubric: R, size, page, layers: widow })).includes('warn:widow'));
  widow[2].textWrap = 'balance';
  assert.ok(!rules(critiquePage({ rubric: R, size, page, layers: widow })).includes('warn:widow'), 'balanced text is fine');
  const longLines = good();
  longLines[2].text = 'x'.repeat(200); longLines[2].lineWidths = [440, 440];
  assert.ok(rules(critiquePage({ rubric: R, size, page, layers: longLines })).includes('info:long-lines'));
  const small = [...good(), ...[1, 2, 3, 4].map((i) => text(`s${i}`, { px: 26, rect: { x: 86, y: 1000 + i * 60, w: 300, h: 40 } }))];
  assert.ok(rules(critiquePage({ rubric: R, size, page, layers: small })).includes('info:small-text'));
});

test('a small raster picture shown big is soft; vectors and big pictures are fine', () => {
  const l = good();
  l[3] = { id: 'photo', type: 'image', boxRect: { x: 380, y: 640, w: 640, h: 640 }, opacity: 1, naturalW: 300, vector: false };
  assert.ok(rules(critiquePage({ rubric: R, size, page, layers: l })).includes('warn:soft-image'));
  l[3].naturalW = 1600;
  assert.ok(!rules(critiquePage({ rubric: R, size, page, layers: l })).includes('warn:soft-image'));
});

test('a carousel is graded as a set: margins, headline sizes, weak cover, no closing action', () => {
  const mk = (id, px, x, lastText) => ({ page: { id }, layers: [text('headline', { px, rect: { x, y: 200, w: 700, h: 200 }, text: lastText ?? 'A headline' })] });
  const doc = { copy: {} };
  const ragged = critiqueSet({ rubric: R, size, doc, pages: [mk('a', 120, 86), mk('b', 100, 150), mk('c', 100, 86), mk('d', 100, 86)] });
  assert.ok(rules(ragged).includes('warn:inconsistent-margins'));
  const sizes = critiqueSet({ rubric: R, size, doc, pages: [mk('a', 120, 86), mk('b', 100, 86), mk('c', 150, 86), mk('d', 100, 86, 'Come visit us')] });
  assert.ok(rules(sizes).includes('warn:inconsistent-headlines'));
  assert.ok(!rules(sizes).includes('info:no-closing-cta'), 'a closing page with an action is fine');
  const weak = critiqueSet({ rubric: R, size, doc, pages: [mk('a', 80, 86), mk('b', 120, 86), mk('c', 120, 86), mk('d', 120, 86)] });
  assert.ok(rules(weak).includes('info:weak-cover'));
  assert.ok(rules(weak).includes('info:no-closing-cta'));
  assert.ok(!rules(critiqueSet({ rubric: R, size, doc: { copy: { cta: 'Book now' } }, pages: [mk('a', 80, 86), mk('b', 120, 86), mk('c', 120, 86)] })).includes('info:no-closing-cta'), 'the caption can carry the call to action');
});

test('brand discipline: raw colours, off-brand fonts, caption hook and call to action', () => {
  const doc = {
    pages: [{ id: 'p', background: '#ffffff', layers: [{ id: 'a', type: 'text', text: 'x', style: { color: '#ff0000', font: 'Comic Sans MS' } }, { id: 'b', type: 'text', text: 'y', style: { color: '$brand.colors.ink', font: '$brand.fonts.body' } }] }],
    copy: { caption: `${'Long hook sentence '.repeat(10)}.` },
  };
  const r = rules(critiqueStatic({ rubric: R, doc }));
  assert.ok(r.includes('info:raw-colour'));
  assert.ok(r.includes('warn:off-brand-font'));
  assert.ok(r.includes('info:caption-hook'));
  assert.ok(r.includes('info:caption-cta'));
  assert.deepEqual(rules(critiqueStatic({ rubric: R, doc: { pages: [{ id: 'p', background: '$brand.colors.paper', layers: [] }], copy: { caption: 'Open from 7. Come visit.' } } })), []);
});

test('score: errors cost most, and an error always means "needs work"', () => {
  assert.deepEqual(scoreOf([]), { score: 100, verdict: 'good', passScore: 88 });
  assert.equal(scoreOf([{ level: 'warn' }, { level: 'warn' }, { level: 'info' }]).score, 100 - 6 - 6 - 2);
  assert.equal(scoreOf([{ level: 'warn' }, { level: 'warn' }, { level: 'warn' }]).verdict, 'needs-work');
  const withError = scoreOf([{ level: 'error' }]);
  assert.equal(withError.score, 85);
  assert.equal(withError.verdict, 'needs-work');
  assert.equal(scoreOf(Array.from({ length: 10 }, () => ({ level: 'error' }))).score, 0);
});

test('backdrop statistics tell calm from busy', () => {
  assert.ok(backdropStats(solidPng(200), { x: 0, y: 0, w: 20, h: 20 }).std < 0.001);
  const stripes = new PNG({ width: 20, height: 20 });
  for (let i = 0; i < stripes.data.length; i += 4) { const v = ((i >> 2) % 2) ? 255 : 0; stripes.data[i] = stripes.data[i + 1] = stripes.data[i + 2] = v; stripes.data[i + 3] = 255; }
  assert.ok(backdropStats(stripes, { x: 0, y: 0, w: 20, h: 20 }).std > 0.3);
});

test('the sample carousel and story are graded well, with no errors', async () => {
  for (const id of ['spring-menu-carousel', 'open-late-story']) {
    const r = await critiqueDocument(join(ROOT, 'samples', 'little-gannet', 'docs', `${id}.json`), { browser, out: join(work, id) });
    assert.equal(r.counts.error, 0, `${id}: ${JSON.stringify(r.issues.filter((i) => i.level === 'error'))}`);
    assert.ok(r.score >= 88, `${id} scored ${r.score}: ${JSON.stringify(r.issues.map((i) => `${i.level}:${i.rule}:${i.page}/${i.layer}`))}`);
    assert.equal(r.verdict, 'good');
  }
});

test('a badly made post is caught end to end, with fixes', async () => {
  const dir = join(work, 'bad');
  cpSync(join(ROOT, 'samples', 'little-gannet'), dir, { recursive: true, filter: (s) => !/[\\/](out|sources)([\\/]|$)/.test(s) });
  const file = join(dir, 'docs', 'open-late-story.json');
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const layers = doc.pages[0].layers;
  layers.find((l) => l.id === 'sub').layout = { anchor: 'top-left', x: 8, y: 20, w: 60 };       // on top of the headline
  layers.find((l) => l.id === 'headline').style.size = 80;                                         // headline no longer clearly first
  layers.find((l) => l.id === 'kicker').style.color = '#ff00ff';                                    // raw colour
  writeFileSync(file, JSON.stringify(doc, null, 2));
  const r = await critiqueDocument(file, { browser, out: join(work, 'bad-out') });
  const found = rules(r.issues);
  assert.ok(found.includes('error:text-collision'), JSON.stringify(found));
  assert.ok(found.includes('info:raw-colour'));
  assert.equal(r.verdict, 'needs-work');
  assert.ok(r.score < 88);
  assert.ok(r.issues.filter((i) => i.source === 'design').every((i) => i.fix), 'every design issue says what to do about it');
  assert.ok(r.issues[0].level === 'error', 'worst problems come first');
  mkdirSync(join(work, 'x'), { recursive: true });
});
