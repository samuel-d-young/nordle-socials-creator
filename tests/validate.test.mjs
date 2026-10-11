// Phase 0 gate: the sample project is valid, and the validator catches the mistakes it exists to catch.
//   npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, validators, validateAll, checkDoc, checkPack, resolveToken } from '../tools/validate.mjs';

const read = (...p) => JSON.parse(readFileSync(join(ROOT, ...p), 'utf8'));
const platforms = read('data', 'platforms.json');
const brand = read('samples', 'little-gannet', 'brand.json');
const baseDoc = () => structuredClone(read('samples', 'little-gannet', 'docs', 'spring-menu-carousel.json'));
const videoDoc = () => structuredClone(read('samples', 'little-gannet', 'docs', 'behind-the-roast-reel.json'));
const ctx = { brand, platforms, projectDir: join(ROOT, 'samples', 'little-gannet'), assets: false, media: false };

const schemaOf = (doc) => { const v = validators().doc; return v(doc) ? [] : v.errors.filter((e) => e.keyword !== 'if'); };
const problems = (doc) => checkDoc(doc, ctx).filter((i) => i.level === 'error').map((i) => i.message);
const has = (list, text) => list.some((m) => m.includes(text));

test('every shipped sample, schema and pack is valid (with assets)', () => {
  const results = validateAll([join(ROOT, 'data'), join(ROOT, 'samples'), join(ROOT, 'examples')], { assets: true });
  assert.ok(results.length >= 6, `expected at least 6 files, got ${results.length}`);
  const errors = results.flatMap((r) => r.issues.filter((i) => i.level === 'error').map((i) => `${r.file}: ${i.path} ${i.message}`));
  assert.deepEqual(errors, []);
});

test('the three sample documents cover graphic, carousel and video', () => {
  const kinds = validateAll([join(ROOT, 'samples')]).filter((r) => r.kind === 'doc').map((r) => r.file.split(/[\\/]/).pop());
  assert.deepEqual(kinds.sort(), ['behind-the-roast-reel.json', 'open-late-story.json', 'spring-menu-carousel.json']);
});

test('brand tokens resolve, honour colourways, and reject unknowns', () => {
  assert.equal(resolveToken('$brand.colors.accent', brand), '#D4752B');
  assert.equal(resolveToken('$brand.colors.paper', brand, 'night'), '#1F2A2E');
  assert.equal(resolveToken('$brand.colors.nope', brand), undefined);
  assert.equal(resolveToken('$brand.__proto__.x', brand), undefined);
});

test('unknown brand token is reported', () => {
  const d = baseDoc();
  d.pages[0].layers[0].style.color = '$brand.colors.nope';
  assert.ok(has(problems(d), 'does not resolve'));
});

test('font token used as a colour is rejected by the schema', () => {
  const d = baseDoc();
  d.pages[0].layers[0].style.color = '$brand.fonts.display';
  assert.ok(schemaOf(d).length > 0);
});

test('duplicate layer id in a page is reported', () => {
  const d = baseDoc();
  d.pages[0].layers[1].id = d.pages[0].layers[0].id;
  assert.ok(has(problems(d), 'duplicate layer id'));
});

test('unknown size is reported', () => {
  const d = baseDoc();
  d.sizes = ['ig-feed-9x9'];
  assert.ok(has(problems(d), 'unknown size'));
});

test('override for a size the document does not use is reported', () => {
  const d = baseDoc();
  d.pages[0].layers[0].overrides = { 'ig-reel-9x16': { hidden: true } };
  assert.ok(has(problems(d), 'not in this document'));
});

test('alt text for a page that does not exist is reported', () => {
  const d = baseDoc();
  d.copy.alt.ghost = 'nothing here';
  assert.ok(has(problems(d), 'not a page id'));
});

test('text layer without text is a schema error', () => {
  const d = baseDoc();
  delete d.pages[0].layers[0].text;
  assert.ok(schemaOf(d).length > 0);
});

test('paths that escape the project are rejected by the schema', () => {
  for (const bad of ['../secret.png', '/etc/passwd', 'C:\\Windows\\win.ini', 'a\\..\\b.png', 'sources/../../x.png']) {
    const d = baseDoc();
    d.pages[0].layers.find((l) => l.type === 'image').src = bad;
    assert.ok(schemaOf(d).length > 0, `expected "${bad}" to be rejected`);
  }
});

test('a carousel may not carry a timeline, and a video must', () => {
  const c = baseDoc();
  c.timeline = videoDoc().timeline;
  assert.ok(schemaOf(c).length > 0);
  const v = videoDoc();
  delete v.timeline;
  assert.ok(schemaOf(v).length > 0);
});

test('a single graphic holds one page at most', () => {
  const g = baseDoc();
  g.kind = 'graphic';
  assert.ok(schemaOf(g).length > 0);
});

test('overlapping clips on one track are reported', () => {
  const d = videoDoc();
  d.timeline.tracks[0].clips[1].at = 5;
  assert.ok(has(problems(d), 'overlap'));
});

test('a clip using an unknown source is reported', () => {
  const d = videoDoc();
  d.timeline.tracks[0].clips[0].source = 'nope';
  assert.ok(has(problems(d), 'unknown source'));
});

test('a clip that runs past its source is reported', () => {
  const d = videoDoc();
  d.timeline.tracks[0].clips[2].out = 60;
  assert.ok(has(problems(d), 'past the end of source'));
});

test('a clip that runs past the timeline is reported', () => {
  const d = videoDoc();
  d.timeline.duration = 12;
  assert.ok(has(problems(d), 'after the timeline'));
});

test('audio on a video track is reported', () => {
  const d = videoDoc();
  d.timeline.tracks[0].clips[0].source = 'music';
  assert.ok(has(problems(d), 'cannot use'));
});

test('ducking under an unknown track is reported', () => {
  const d = videoDoc();
  d.timeline.tracks[1].clips[0].duck.under = 'ghost';
  assert.ok(has(problems(d), 'unknown track'));
});

test('video overlays need a time range', () => {
  const d = videoDoc();
  delete d.layers[1].time;
  assert.ok(has(problems(d), 'needs a time range'));
});

test('time ranges on a carousel layer are reported', () => {
  const d = baseDoc();
  d.pages[0].layers[0].time = { start: 0, end: 1 };
  assert.ok(has(problems(d), 'only for video overlays'));
});

test('pack with a bad regex is reported', () => {
  const pack = read('examples', 'packs', 'plain-claims', 'pack.json');
  pack.rules.push({ id: 'broken', type: 'regex', severity: 'warn', message: 'x', scope: ['copy.caption'], pattern: '(unclosed' });
  assert.ok(checkPack(pack).some((i) => i.message.includes('invalid regular expression')));
});

test('a pack that runs code is flagged for approval', () => {
  const pack = read('examples', 'packs', 'plain-claims', 'pack.json');
  pack.runsCode = true;
  assert.ok(checkPack(pack).some((i) => i.level === 'warn' && i.message.includes('approve')));
});
