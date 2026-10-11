// Layout patterns must produce pages that are valid and that pass our own design review, at every common size,
// with short and long words. If a pattern cannot grade itself well, Claude cannot be expected to.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, validateDocData, readJson } from '../tools/validate.mjs';
import { openBrowser } from '../src/render/browser.mjs';
import { critiqueDocument } from '../src/render/critique.mjs';
import { composePage, listPatterns, brandRoles, toneColours, contrast } from '../src/shared/patterns.mjs';

const platforms = readJson(join(ROOT, 'data', 'platforms.json'));
const brand = readJson(join(ROOT, 'samples', 'little-gannet', 'brand.json'));
const SIZES = ['ig-feed-4x5', 'ig-feed-1x1', 'ig-story-9x16'];
const CAROUSEL_SIZES = ['ig-feed-4x5', 'ig-feed-1x1'];
const sizeObjects = (ids) => ids.map((id) => { const p = platforms.presets.find((x) => x.id === id); return { id, w: p.w, h: p.h, safe: p.safe }; });

const CONTENT = {
  cover: { kicker: 'New this season', headline: 'Spring menu is here', body: 'Three new pours. Open from 7 am.', image: 'assets/hero-cup.svg', imageAlt: 'A steaming cup of coffee', hint: 'Swipe' },
  statement: { kicker: 'Our promise', headline: 'Every cup is made to order', footer: '@littlegannet' },
  list: { kicker: 'Good to know', headline: 'Three ways to enjoy it', items: [{ title: 'Hot', text: 'Served in our own ceramic cups.' }, { title: 'Iced', text: 'Over a big, slow-melting cube.' }, { title: 'To go', text: 'Bring your own cup and we will take 50c off.' }] },
  item: { number: '01', headline: 'Honey lavender latte', body: 'House-made honey syrup and a pinch of dried lavender. Oat or dairy.', label: '6.50', image: 'assets/beans.svg', imageAlt: '' },
  stat: { kicker: 'Every day', number: '7 am', headline: 'Doors open', body: 'Pastries are out of the oven by quarter past.' },
  quote: { headline: 'We roast in small batches so every cup tastes the way it should.', body: 'Maya, head roaster' },
  'image-hero': { image: 'assets/photo.png', imageAlt: 'A cup of coffee', kicker: 'Port Wren', headline: 'Open at first light', body: 'Quay Street, from 7 am.' },
  split: { image: 'assets/photo.png', imageAlt: 'A cup of coffee', kicker: 'Behind the scenes', headline: 'Roasted every morning', body: 'Small batches, so what you drink was roasted this week.' },
  cta: { headline: 'Come say hi', body: 'Quay Street, Port Wren\nOpen 7 am to 3 pm, every day', footer: '@littlegannet', logo: 'assets/logo.svg', logoAlt: 'Little Gannet logo' },
  'closing-card': { image: 'assets/photo.png', imageAlt: 'The team at the counter', kicker: 'Questions?', headline: 'Come and say hello', url: 'littlegannet.example/visit', phone: '0400 000 000', disclaimer: 'A line of small print.', logo: 'assets/logo.svg' },
  person: { image: 'assets/photo.png', imageAlt: 'Maya at the roaster', kicker: 'Meet the team', name: 'Maya', role: 'Head roaster', body: 'Roasts every batch by hand.' },
};

let browser, work, dir;
before(async () => {
  browser = await openBrowser();
  work = mkdtempSync(join(tmpdir(), 'nordle-pat-'));
  dir = join(work, 'project');
  cpSync(join(ROOT, 'samples', 'little-gannet'), dir, { recursive: true, filter: (s) => !/[\\/](out|sources)([\\/]|$)/.test(s) });
  // a stand-in photograph: a bright-to-mid gradient with some texture, the kind of thing text has to cope with
  const photo = new PNG({ width: 800, height: 1000 });
  for (let y = 0; y < 1000; y++) for (let x = 0; x < 800; x++) {
    const i = (y * 800 + x) << 2, v = 200 - y * 0.12 + 28 * Math.sin(x / 23) * Math.cos(y / 31);
    photo.data[i] = v; photo.data[i + 1] = v * 0.93; photo.data[i + 2] = v * 0.82; photo.data[i + 3] = 255;
  }
  writeFileSync(join(dir, 'assets', 'photo.png'), PNG.sync.write(photo));
});
after(async () => { await browser?.close(); rmSync(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }); });

function docFor(pages, id, sizes = SIZES) {
  return { schema: 'nordle.doc/0.1', id, title: 'Pattern test', kind: pages.length > 1 ? 'carousel' : 'graphic', brand: 'little-gannet', sizes, copy: { caption: 'A test post.\nCome and see.', cta: 'Come and see.', alt: Object.fromEntries(pages.map((p) => [p.id, 'A test page.'])) }, pages };
}
const compose = (pattern, content = CONTENT[pattern], extra = {}) => {
  const sizes = sizeObjects(extra.sizeIds ?? SIZES);
  return composePage({ pattern, content, brand, size: sizes[0], sizes, ...extra });
};
const detail = (r) => r.issues.filter((i) => i.level !== 'info').map((i) => `${i.level}:${i.rule}:${i.page}/${i.layer}(${(i.sizes ?? []).join(',')}) ${i.message}`);

/** Review each case and report every failure at once, not just the first. */
async function reviewAll(cases, { minScore = 88 } = {}) {
  const failures = [];
  for (const [name, pages, sizes] of cases) {
    const file = join(dir, 'docs', `t-${name}.json`);
    writeFileSync(file, JSON.stringify(docFor(pages, `t-${name}`, sizes), null, 2));
    const r = await critiqueDocument(file, { browser, out: join(work, `out-${name}`) });
    if (r.counts.error > 0 || r.score < minScore) failures.push(`${name} (score ${r.score}): ${detail(r).join(' | ')}`);
  }
  return failures;
}

test('every pattern is listed with slots and an example', () => {
  const list = listPatterns();
  assert.deepEqual(list.map((p) => p.id).sort(), Object.keys(CONTENT).sort());
  for (const p of list) assert.ok(p.description.length > 30 && p.bestFor && p.slots && p.example, p.id);
});

test('brand roles are found by name, and by brightness and saturation when names are unusual', () => {
  const r = brandRoles(brand);
  assert.deepEqual([r.ink, r.paper, r.accent, r.accentOnPaper], ['ink', 'paper', 'accent', 'accentDark']);
  const o = brandRoles({ colors: { a: '#101820', b: '#f4efe6', c: '#e63946', d: '#457b9d' }, fonts: { display: { family: 'X', source: 'system' } } });
  assert.deepEqual([o.ink, o.paper, o.accent], ['a', 'b', 'c']);
  const roles = brandRoles(brand);
  for (const tone of ['light', 'dark', 'accent', 'alt']) {
    const t = toneColours(roles, tone);
    const val = (tok) => roles.val(tok.split('.').pop());
    assert.ok(contrast(val(t.text), val(t.bg)) >= 4.5, `${tone}: text ${t.text} on ${t.bg}`);
    assert.ok(contrast(val(t.accentSmall), val(t.bg)) >= 4.5, `${tone}: small accent text ${t.accentSmall} on ${t.bg}`);
  }
});

test('composing is strict about what a pattern needs', () => {
  assert.throws(() => compose('cover', {}), /needs a headline/);
  assert.throws(() => compose('split', { headline: 'x' }), /needs an image/);
  assert.throws(() => compose('nope', {}), /Unknown pattern/);
});

test('every pattern makes a valid page; other sizes get overrides where positions differ; a picture is dropped when there is no room', () => {
  for (const id of Object.keys(CONTENT)) {
    const { page } = compose(id);
    const bad = validateDocData(docFor([page], 'v'), { brand, projectDir: dir, platforms, assets: true }).filter((i) => i.level === 'error');
    assert.deepEqual(bad, [], `${id}: ${JSON.stringify(bad)}`);
  }
  const hint = compose('cover').page.layers.find((l) => l.id === 'hint');
  assert.ok(hint.overrides?.['ig-story-9x16'], 'the swipe cue moves out of the story safe zone');
  const crammed = compose('cover', { ...CONTENT.cover, headline: 'The new spring menu has arrived and it is full of lovely surprises for everyone', body: 'x'.repeat(260) }, { sizeIds: ['ig-feed-1x1'] });
  assert.ok(crammed.notes.some((n) => /no room for the picture/i.test(n)), JSON.stringify(crammed.notes));
  assert.ok(!crammed.page.layers.some((l) => l.id === 'image'));
});

test('every pattern passes the design review (score 88+, no errors) at 4:5, 1:1 and 9:16', async () => {
  const cases = Object.keys(CONTENT).map((id) => [id, [compose(id).page]]);
  const failures = await reviewAll(cases);
  assert.deepEqual(failures, []);
});

test('long words still pass: a long headline, long body copy and four list items', async () => {
  const long = {
    cover: { ...CONTENT.cover, headline: 'The new spring menu has arrived and it is full of surprises', body: 'Three brand new pours, made by hand every morning, available from seven until the beans run out.' },
    list: { ...CONTENT.list, items: [...CONTENT.list.items, { title: 'Shared', text: 'Order for the table and we will bring everything out together.' }] },
    statement: { headline: 'Coffee tastes better when somebody has taken the time to get it right' },
    item: { ...CONTENT.item, headline: 'Honey lavender latte with oat milk and a pinch of salt', body: 'House-made honey syrup, dried lavender from a farm up the coast, and your choice of milk. Served hot or over ice.' },
  };
  const failures = await reviewAll(Object.entries(long).map(([id, content]) => [`long-${id}`, [compose(id, content, { pageId: id }).page]]), { minScore: 82 });
  assert.deepEqual(failures, []);
});

test('tones change the look: every tone reads well', async () => {
  const cases = ['light', 'dark', 'accent', 'alt'].map((tone) => [`tone-${tone}`, [compose('item', CONTENT.item, { tone }).page]]);
  assert.deepEqual(await reviewAll(cases), []);
});

test('a whole carousel from patterns is graded as a set, and passes', async () => {
  const opt = { sizeIds: CAROUSEL_SIZES };
  const pages = [
    compose('cover', CONTENT.cover, { ...opt, pageId: 'cover' }).page,
    compose('item', CONTENT.item, { ...opt, pageId: 'latte' }).page,
    compose('item', { ...CONTENT.item, number: '02', headline: 'Cold brew tonic', body: 'Twelve-hour cold brew over ice, topped with tonic and an orange peel.', label: '7.00' }, { ...opt, pageId: 'tonic', tone: 'alt' }).page,
    compose('statement', CONTENT.statement, { ...opt, pageId: 'promise' }).page,
    compose('cta', CONTENT.cta, { ...opt, pageId: 'visit' }).page,
  ];
  assert.deepEqual(await reviewAll([['carousel', pages, CAROUSEL_SIZES]], { minScore: 85 }), []);
});
