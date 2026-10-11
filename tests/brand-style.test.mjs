// A brand's `posts` style changes how the patterns look (alignment, accent treatment, background, footer, logo, button)
// and the result still passes the design review.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, validateDocData, readJson } from '../tools/validate.mjs';
import { openBrowser } from '../src/render/browser.mjs';
import { critiqueDocument } from '../src/render/critique.mjs';
import { composePage } from '../src/shared/patterns.mjs';
import { postStyle } from '../src/shared/brand-style.mjs';

const platforms = readJson(join(ROOT, 'data', 'platforms.json'));
const base = readJson(join(ROOT, 'samples', 'little-gannet', 'brand.json'));
const styled = {
  ...base,
  fonts: { ...base.fonts, script: { family: 'Fraunces', source: 'google' } },
  posts: {
    align: 'center',
    headline: { weight: 600, accent: 'italic', case: 'none' },
    kicker: { case: 'upper', tracking: 0.3, size: 26 },
    background: { mode: 'gradient', gradients: { light: { type: 'linear', angle: 160, stops: [{ at: 0, color: '$brand.colors.paper' }, { at: 1, color: '#efe6d6' }] } } },
    footer: { text: 'littlegannet.example', show: 'all', case: 'upper', tracking: 0.2 },
    logo: { key: 'mark', show: 'first', placement: 'top-center', w: 14, h: 7 },
    button: { text: "DM us 'story' to get started", style: 'outline', show: 'last' },
  },
};
styled.logos = { ...(base.logos ?? {}), mark: 'assets/logo.svg' };
const sizes = ['ig-feed-4x5'].map((id) => { const p = platforms.presets.find((x) => x.id === id); return { id, w: p.w, h: p.h, safe: p.safe }; });

let browser, work, dir;
before(async () => {
  browser = await openBrowser();
  work = mkdtempSync(join(tmpdir(), 'nordle-bs-'));
  dir = join(work, 'project');
  cpSync(join(ROOT, 'samples', 'little-gannet'), dir, { recursive: true, filter: (s) => !/[\\/](out|sources)([\\/]|$)/.test(s) });
  writeFileSync(join(dir, 'brand.json'), JSON.stringify(styled, null, 2));
});
after(async () => { await browser?.close(); rmSync(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }); });

test('defaults fill in and the schema accepts a posts block', () => {
  assert.equal(postStyle(base).headline.accent, 'italic-colour');
  assert.equal(postStyle(styled).align, 'center');
  const doc = { schema: 'nordle.doc/0.1', id: 'x', title: 'x', kind: 'graphic', brand: styled.id, sizes: ['ig-feed-4x5'], pages: [composePage({ pattern: 'statement', content: { headline: 'Every cup is made to order' }, brand: styled, size: sizes[0], sizes }).page] };
  assert.deepEqual(validateDocData(doc, { brand: styled, projectDir: dir, platforms, assets: true }).filter((i) => i.level === 'error'), []);
});

test('centred text, no-picture pages; list stays left', () => {
  const cover = composePage({ pattern: 'cover', content: { kicker: 'New', headline: 'Spring menu is here', body: 'Three new pours.' }, brand: styled, size: sizes[0], sizes }).page;
  const block = cover.layers.find((l) => l.id === 'text-block');
  assert.equal(block.layout.x, 50);
  assert.equal(block.layout.anchor, 'center');
  assert.ok(block.children.every((c) => c.style.align === 'center'));
  const list = composePage({ pattern: 'list', content: { headline: 'Three ways', items: [{ title: 'Hot', text: 'a cup' }, { title: 'Iced', text: 'a cube' }] }, brand: styled, size: sizes[0], sizes }).page;
  assert.equal(list.layers.find((l) => l.id === 'text-block').layout.anchor, 'top-left');
});

test('accent styles: italic only, colour only, script', () => {
  const run = (accent) => {
    const b = { ...styled, posts: { ...styled.posts, headline: { accent } } };
    const h = composePage({ pattern: 'statement', content: { headline: 'Every cup is made to order' }, brand: b, size: sizes[0], sizes }).page.layers[0].children.find((c) => c.id === 'headline');
    return h.runs.at(-1).style;
  };
  assert.deepEqual(Object.keys(run('italic')), ['italic']);
  assert.deepEqual(Object.keys(run('colour')), ['color']);
  const script = run('script');
  assert.equal(script.font, '$brand.fonts.script');
  assert.ok(script.size > 100);
});

test('gradient background, footer, logo and button land on the right pages', () => {
  const at = (pattern, index, total, content) => composePage({ pattern, content, brand: styled, size: sizes[0], sizes, position: { index, total } }).page;
  const first = at('cover', 0, 3, { headline: 'Spring menu is here' });
  const middle = at('statement', 1, 3, { headline: 'Every cup is made to order' });
  const last = at('cta', 2, 3, { headline: 'Come say hi', body: 'Open 7 am' });
  assert.equal(first.background.type, 'linear');
  assert.ok(first.layers.some((l) => l.id === 'brand-logo'));
  assert.ok(!middle.layers.some((l) => l.id === 'brand-logo'));
  for (const p of [first, middle, last]) assert.ok(p.layers.some((l) => l.id === 'brand-footer'), p.id);
  assert.ok(last.layers.some((l) => l.id === 'brand-button'));
  assert.ok(!first.layers.some((l) => l.id === 'brand-button'));
});

test('a styled carousel still passes the design review', async () => {
  const pages = [
    composePage({ pattern: 'cover', content: { kicker: 'New this season', headline: 'Spring menu is here', body: 'Three new pours. Open from 7 am.' }, brand: styled, size: sizes[0], sizes, pageId: 'cover', position: { index: 0, total: 3 } }).page,
    composePage({ pattern: 'statement', content: { kicker: 'Our promise', headline: 'Every cup is made to order' }, brand: styled, size: sizes[0], sizes, pageId: 'promise', position: { index: 1, total: 3 } }).page,
    composePage({ pattern: 'cta', content: { headline: 'Come say hi', body: 'Quay Street, Port Wren\nOpen 7 am to 3 pm' }, brand: styled, size: sizes[0], sizes, pageId: 'visit', position: { index: 2, total: 3 } }).page,
  ];
  const doc = { schema: 'nordle.doc/0.1', id: 'styled', title: 'Styled', kind: 'carousel', brand: styled.id, sizes: ['ig-feed-4x5'], copy: { caption: 'Spring menu is here.\nCome and see.', cta: 'Come and see.', alt: { cover: 'Cover', promise: 'Promise', visit: 'Visit' } }, pages };
  const file = join(dir, 'docs', 'styled.json');
  writeFileSync(file, JSON.stringify(doc, null, 2));
  const r = await critiqueDocument(file, { browser, out: join(work, 'out') });
  const bad = r.issues.filter((i) => i.level !== 'info').map((i) => `${i.level}:${i.rule}:${i.page}/${i.layer} ${i.message}`);
  assert.deepEqual(bad, []);
  assert.ok(r.score >= 88, `score ${r.score}`);
});

test('role sizes, lower text zone, label colour, first-page pill, centred list, photo fade, end card slots', async () => {
  const b = {
    ...styled,
    posts: {
      ...styled.posts,
      headline: { sizes: { cover: 112, page: 84, end: 92 }, accent: 'colour' },
      kicker: { color: 'paper' },
      textZone: 'lower',
      photo: { fade: { colour: 'accent', from: 0.4, strength: 0.9 }, logoAvoid: 'focal' },
      button: { text: 'Swipe', show: 'first', position: 'bottom-right', chevrons: 3 },
      end: { phoneSize: 92, underlineUrl: true, logoW: 30 },
      list: { align: 'center', numbered: false },
      footer: { text: 'littlegannet.example', show: 'last' },
    },
  };
  const c = (pattern, content, i = 0, n = 3) => composePage({ pattern, content, brand: b, size: sizes[0], sizes, position: { index: i, total: n } }).page;
  const cover = c('cover', { kicker: 'New', headline: 'Spring menu', body: 'Three pours.' }, 0);
  const block = cover.layers.find((l) => l.id === 'text-block');
  assert.ok(block.layout.anchor.startsWith('bottom'), 'text sits low');
  assert.equal(block.children.find((x) => x.id === 'kicker').style.color, '$brand.colors.paper');
  assert.equal(block.children.find((x) => x.id === 'headline').style.size, 112, 'cover headline size');
  const pill = cover.layers.find((l) => l.id === 'brand-button-text');
  assert.match(pill.text, /Swipe ›››/);
  assert.equal(cover.layers.find((l) => l.id === 'brand-button').layout.anchor, 'bottom-right');

  const list = c('list', { headline: 'Three ways', items: [{ title: 'Hot', text: 'a cup' }, { title: 'Iced', text: 'a cube' }] }, 1);
  const row = list.layers.find((l) => l.id === 'text-block').children.find((x) => x.id === 'items').children[0];
  assert.equal(row.children[0].text, 'Hot', 'no numbering');
  assert.equal(row.children[0].style.align, 'center');

  const hero = c('image-hero', { image: 'assets/hero-cup.svg', imageAlt: 'x', headline: 'Open at first light', focal: { x: 0.5, y: 0.25 } }, 1);
  assert.ok(hero.layers.some((l) => l.id === 'fade'));
  assert.equal(hero.layers.find((l) => l.id === 'brand-logo'), undefined, 'logo only on the first page here');
  const first = c('image-hero', { image: 'assets/hero-cup.svg', imageAlt: 'x', headline: 'Open at first light', focal: { x: 0.5, y: 0.25 } }, 0);
  assert.notEqual(first.layers.find((l) => l.id === 'brand-logo').layout.anchor, 'top', 'logo moves off a face near the top centre');

  const end = c('cta', { lead: 'Ready when you are', headline: 'Book your visit', phone: '08 0000 0000', url: 'littlegannet.example', disclaimer: 'Always check the details with the practice.', footer: '@littlegannet' }, 2);
  const kids = end.layers.find((l) => l.id === 'text-block').children;
  assert.equal(kids.find((x) => x.id === 'phone').style.size, 92);
  assert.equal(kids.find((x) => x.id === 'url').style.underline, true);
  assert.ok(end.layers.some((l) => l.id === 'disclaimer'));

  const doc = { schema: 'nordle.doc/0.1', id: 'styled2', title: 'Styled 2', kind: 'carousel', brand: b.id, sizes: ['ig-feed-4x5'], copy: { caption: 'x', alt: { cover: 'a', list: 'b', end: 'c' } }, pages: [{ ...cover, id: 'cover' }, { ...list, id: 'list' }, { ...end, id: 'end' }] };
  const bad = validateDocData(doc, { brand: b, projectDir: dir, platforms, assets: true }).filter((i) => i.level === 'error');
  assert.deepEqual(bad, []);
});
