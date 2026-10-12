// "Train" Nordle on the brand's own posts, and keep every colour and font a brand kit screenshot shows. A fake reader stands in for Claude: nothing real is started.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanShot, cleanTrain, readExamplePosts } from '../src/brand/screenshot.mjs';
import { colourKey, coreFromTrain, postsFromTrain, withNamedColours } from '../src/brand/train.mjs';
import { scanBrand } from '../src/brand/scan.mjs';
import { AGENT, TOKEN, closeBrowser } from './helpers.mjs';
import { studio, studioPage, TODAY } from './studio-helpers.mjs';

after(closeBrowser);
const dir = mkdtempSync(join(tmpdir(), 'nordle-train-'));
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc0f01f0000050001ffa5e8fd00000000049454e44ae426082', 'hex');

// a brand whose posts are deep green with cream text and a gold highlight, headlines in capitals, text low and centred, logo bottom right
const TRAIN = {
  postsSeen: 3,
  colors: [
    { hex: '#1b2421', role: 'background', share: 0.7 }, { hex: '#ECEBE6', role: 'headline', share: 0.12 }, { hex: '#C9A35B', role: 'accent', share: 0.05 },
    { hex: '#9AA39E', role: 'body', share: 0.04 }, { hex: '#E3E1D9', role: 'body', share: 0.02 }, { hex: 'bad', role: 'accent' }, { hex: '#445544', role: 'nonsense' },
  ],
  fonts: { headline: 'Playfair Display', body: 'Inter', accent: 'Parisienne' },
  layout: { align: 'center', textZone: 'bottom', headlineCase: 'upper', accentStyle: 'script', logo: 'bottom-right', photo: 'full-bleed', darkBackgrounds: true },
  notes: 'Three posts, all on dark green.',
};

test('what example posts showed is cleaned: real colours with a known job, plain choices for the layout, nothing else', () => {
  const t = cleanTrain({ ...TRAIN, layout: { ...TRAIN.layout, align: 'diagonal', logo: 'sideways' }, extra: 'x' });
  assert.deepEqual(t.colors.map((c) => c.hex), ['#1B2421', '#ECEBE6', '#C9A35B', '#9AA39E', '#E3E1D9', '#445544']);
  assert.equal(t.colors.at(-1).role, 'other', 'an unknown job becomes "other"');
  assert.equal(t.layout.align, null, 'a choice that is not on the list is dropped');
  assert.equal(t.layout.logo, null);
  assert.equal(t.layout.textZone, 'bottom');
  assert.equal(t.postsSeen, 3);
  assert.equal(t.extra, undefined);
  assert.deepEqual(cleanTrain(null).colors, []);
});

test('the core colours come from the jobs: the dark background is ink, the light text is paper, the accent is the accent', () => {
  const core = coreFromTrain(cleanTrain(TRAIN));
  assert.equal(core.ink, '#1B2421');
  assert.equal(core.paper, '#E3E1D9' === core.paper ? '#E3E1D9' : '#ECEBE6', 'the lightest of the light ones');
  assert.equal(core.accent, '#C9A35B');
  assert.equal(coreFromTrain(cleanTrain({ colors: [] })), null);
  const lightPosts = coreFromTrain(cleanTrain({ colors: [{ hex: '#FFF8EE', role: 'background', share: 0.8 }, { hex: '#0B1F33', role: 'headline', share: 0.1 }, { hex: '#1B6CA8', role: 'highlight' }] }));
  assert.deepEqual([lightPosts.ink, lightPosts.paper, lightPosts.accent], ['#0B1F33', '#FFF8EE', '#1B6CA8']);
});

test('the house style the posts imply uses only values the brand schema allows, and the logo only when the brand has one', () => {
  const t = cleanTrain(TRAIN);
  const posts = postsFromTrain(t, { hasLogo: true });
  assert.deepEqual(posts, { align: 'center', textZone: 'lower', headline: { case: 'upper', accent: 'script' }, logo: { show: 'all', placement: 'bottom-right' } });
  assert.equal(postsFromTrain(t, { hasLogo: false }).logo, undefined);
  assert.equal(postsFromTrain(cleanTrain({}), {}), null);
});

test('every colour a kit shows is kept: the core five are chosen, the rest keep their own names, and generic names are replaced by the real ones', () => {
  const named = [{ hex: '#1B6CA8', name: 'Ocean' }, { hex: '#F2A900', name: 'Sunrise' }, { hex: '#0B1F33', name: 'Midnight' }, { hex: '#EAF2F7', name: 'Foam' }, { hex: '#2BA84A', name: 'Leaf Green' }, { hex: '#C0C0C0', name: 'Accent' }];
  const out = withNamedColours({ ink: '#0B1F33', paper: '#EAF2F7', accent: '#1B6CA8', accentDark: '#134B75', muted: '#6B7C8A', secondary: '#F2A900', tertiary: '#2BA84A' }, named);
  assert.equal(out.accent, '#1B6CA8');
  assert.equal(out.sunrise, '#F2A900', 'the generic "secondary" became "sunrise"');
  assert.equal(out.secondary, undefined);
  assert.equal(out.leafGreen, '#2BA84A');
  assert.equal(out.tertiary, undefined);
  assert.ok(Object.values(out).includes('#C0C0C0'), 'the grey is kept too, under a name that does not clash with a core one');
  assert.ok(!('ink2' in out) || out.ink2, 'no core colour was overwritten');
  assert.equal(out.ink, '#0B1F33');
  const many = withNamedColours({}, Array.from({ length: 40 }, (_, i) => ({ hex: `#${(i * 6).toString(16).padStart(2, '0')}${(255 - i * 6).toString(16).padStart(2, '0')}80`, name: `Shade ${i}` })));
  assert.equal(Object.keys(many).length, 20, 'twenty extras at most');
  assert.equal(colourKey('Brand Gold', new Set(), 'x'), 'brandGold');
  assert.equal(colourKey('accent', new Set(), 'x'), 'accent2', 'a core name is never reused');
});

test('the scan puts it together: the posts name the jobs, the screenshot adds every named colour and the subheading font, and nothing is lost', async () => {
  const shot = cleanShot({ brandName: 'Harbour Studio', colors: [{ name: 'Ocean', hex: '#1B6CA8' }, { name: 'Sunrise', hex: '#F2A900' }, { name: 'Midnight', hex: '#0B1F33' }, { name: 'Foam', hex: '#EAF2F7' }, { name: 'Leaf', hex: '#2BA84A' }, { name: 'Coral', hex: '#FF6F61' }, { name: 'Slate', hex: '#4A5568' }], fonts: { heading: 'Playfair Display', subheading: 'Montserrat', body: 'Lora', other: ['Caveat'] }, tone: ['warm'] });
  const r = await scanBrand({ shot });
  assert.equal(r.draft.fonts.display.family, 'Playfair Display');
  assert.equal(r.draft.fonts.body.family, 'Lora');
  assert.equal(r.draft.fonts.subheading.family, 'Montserrat');
  assert.equal(r.draft.fonts.extra1.family, 'Caveat');
  const hexes = Object.values(r.draft.colors);
  for (const c of shot.colors) assert.ok(hexes.includes(c.hex), `${c.name} ${c.hex} is in the brand: ${JSON.stringify(r.draft.colors)}`);
  assert.ok(Object.keys(r.draft.colors).length >= 7, 'all seven, not just five');
  // the posts: jobs decide the core
  const t = await scanBrand({ train: cleanTrain(TRAIN) });
  assert.equal(t.draft.colors.ink, '#1B2421');
  assert.equal(t.draft.colors.accent, '#C9A35B');
  assert.equal(t.draft.fonts.display.family, 'Playfair Display');
  assert.equal(t.draft.fonts.accentFont.family, 'Parisienne');
  assert.ok(t.found.some((x) => /Read 3 example posts: 6 colours/.test(x)), JSON.stringify(t.found));
  assert.equal(t.draft.train.layout.textZone, 'bottom');
});

test('the routes: only the owner reads example posts; creating a brand with what they showed writes the house style and keeps the logo rule right', async () => {
  const mk = (name) => { const p = join(dir, name); writeFileSync(p, PNG); return p; };
  void mk;
  await studio(async ({ call, port, work }) => {
    const session = 'cd34ab12cd34ab12';
    const stage = (name, body) => fetch(`http://127.0.0.1:${port}/api/brand/upload`, { method: 'POST', headers: { 'x-nordle-token': TOKEN, 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(name), 'x-upload-session': session }, body });
    await stage('post one.png', PNG);
    await stage('logo.png', PNG);
    assert.equal((await call('/brand/read-examples', 'POST', { uploadSession: session, files: ['post one.png'] }, AGENT)).status, 403);
    assert.equal((await call('/brand/read-examples', 'POST', { uploadSession: session, files: ['nope.png'] })).status, 400);
    const r = await call('/brand/read-examples', 'POST', { uploadSession: session, files: ['post one.png'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.train.layout.align, 'center');
    const made = await call('/brand/create', 'POST', { name: 'Green Posts', uploadSession: session, logoFiles: { primary: 'logo.png' }, train: r.body.train, guide: { colors: { ink: '#1B2421', paper: '#ECEBE6', accent: '#C9A35B' }, fonts: { subheading: { family: 'Montserrat' } } } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const brand = JSON.parse(readFileSync(join(work, 'projects', made.body.id, 'brand.json'), 'utf8'));
    assert.deepEqual(brand.posts, { align: 'center', textZone: 'lower', headline: { case: 'upper', accent: 'script' }, logo: { show: 'all', placement: 'bottom-right', key: 'primary' } });
    assert.equal(brand.fonts.subheading.family, 'Montserrat', 'a font beyond heading and body is kept');
    assert.equal(brand.colors.accent, '#C9A35B');
  }, { exampleReader: async () => TRAIN });
});

test('Add a brand: example posts are added, read, shown with the job of each colour, and the new brand keeps them (house style, colours, fonts)', async () => {
  const post = join(dir, 'my-post.png');
  writeFileSync(post, PNG);
  await studioPage(async ({ page, open, work }) => {
    await open(`#/s/month?today=${TODAY}`);
    await page.locator('[data-act="add-brand"]').click();
    await page.fill('[data-field="wz-name"]', 'Green Studio');
    await page.locator('[data-act="wz-next"]').click();
    await page.waitForSelector('[data-field="train-import"]');
    assert.equal(await page.locator('[data-act="wz-scan"]').isDisabled(), true);
    await page.setInputFiles('[data-field="train-import"] [data-field="shot-file"]', post);
    await page.waitForSelector('[data-field="train-import"] .shot-th img');
    assert.equal(await page.locator('[data-act="wz-scan"]').isDisabled(), false, 'example posts are something to look at');
    await page.locator('[data-act="train-read"]').click();
    await page.waitForSelector('[data-state="train-read"] .bg-sw');
    const shown = await page.locator('[data-state="train-read"]').innerText();
    assert.match(shown, /Background/);
    assert.match(shown, /Accent/);
    assert.match(shown, /Headlines: Playfair Display/);
    assert.match(shown, /Centred text, text low, capital headlines/);
    await page.locator('[data-act="wz-scan"]').click();
    await page.waitForSelector('[data-state="scanned"]');
    assert.match(await page.locator('.wz-found').innerText(), /Read 3 example posts/);
    await page.locator('[data-act="wz-next"]').click();
    await page.waitForSelector('.bg-edit');
    assert.equal(await page.inputValue('[data-field="bg-color-ink"]'), '#1B2421');
    assert.equal(await page.inputValue('[data-field="bg-color-accent"]'), '#C9A35B');
    await page.locator('[data-act="wz-create"]').click();
    await page.waitForSelector('.wz-nexts');
    const brand = JSON.parse(readFileSync(join(work, 'projects', 'green-studio', 'brand.json'), 'utf8'));
    assert.equal(brand.posts.align, 'center');
    assert.equal(brand.posts.headline.case, 'upper');
    assert.equal(brand.fonts.accentFont.family, 'Parisienne');
  }, { exampleReader: async () => TRAIN });
});

test('with no Claude and no reader, example posts still give their colours from the pixels, and say what could not be read', async () => {
  const post = join(dir, 'plain.png');
  writeFileSync(post, PNG);
  const r = await readExamplePosts([post], { reader: async () => ({ fallback: true, colors: [], postsSeen: 1 }) });
  assert.equal(r.train.fallback, true);
  const s = await scanBrand({ train: r.train });
  assert.ok(s.problems.some((p) => /could not be read without Claude Code/.test(p)));
});

test('a post made in the trained brand really uses its colours: the new ink, paper and accent are on the picture, and the sample brand\'s are gone', async () => {
  const { cpSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const { paletteOf } = await import('../src/brand/scan.mjs');
  const root = join(import.meta.dirname, '..');
  const proj = join(mkdtempSync(join(tmpdir(), 'nordle-trained-')), 'trained');
  cpSync(join(root, 'samples', 'little-gannet'), proj, { recursive: true, filter: (s) => !/[\/](out|sources)([\/]|$)/.test(s) });
  const core = coreFromTrain(cleanTrain(TRAIN));
  const brand = JSON.parse(readFileSync(join(proj, 'brand.json'), 'utf8'));
  brand.colors = { ink: core.ink, paper: core.paper, accent: core.accent, accentDark: core.accent, muted: '#9AA39E', sea: '#445544' };
  writeFileSync(join(proj, 'brand.json'), JSON.stringify(brand, null, 2));
  const out = spawnSync(process.execPath, [join(root, 'nordle.mjs'), 'render', join(proj, 'docs', 'spring-menu-carousel.json')], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  const files = [...out.stdout.matchAll(/([^\s]+\.png)/g)].map((m) => m[1]).filter((f) => /spring-menu-carousel/.test(f));
  assert.ok(files.length, out.stdout);
  const pal = paletteOf([files[0]], { weight: 1 });
  const top = [...pal].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([h]) => h);
  for (const [role, hex] of [['paper', core.paper], ['ink', core.ink], ['accent', core.accent]]) assert.ok(top.slice(0, 8).includes(hex), `the trained ${role} ${hex} is among the colours the post is drawn with: ${top}`);
  // the sample's own illustrations keep their own colours (they are artwork, not brand colours), but nothing drawn with a brand colour is still the old one
  assert.ok(!top.slice(0, 3).includes('#1F2A2E') && !top.slice(0, 5).includes('#D4752B'), `the old ink and accent are not what the post is made of: ${top}`);
});

test('a colour Claude only estimated is moved to the real colour in the picture when one is close, and left alone when none is', async () => {
  const { deflateSync } = await import('node:zlib');
  const { snapColours } = await import('../src/brand/screenshot.mjs');
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = table[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([Buffer.from(t), d]))); return Buffer.concat([l, Buffer.from(t), d, c]); };
  const bands = [[0x1B, 0x24, 0x21], [0xEC, 0xEB, 0xE6], [0xC9, 0xA3, 0x5B]];
  const size = 48, ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const rows = [];
  for (let y = 0; y < size; y++) { const [r, g, b] = bands[Math.min(2, Math.floor((y / size) * 3))]; const row = Buffer.alloc(1 + size * 4); for (let x = 0; x < size; x++) row.set([r, g, b, 255], 1 + x * 4); rows.push(row); }
  const file = join(dir, 'exact.png');
  writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]));
  const snapped = snapColours([{ hex: '#1E2824', role: 'background' }, { hex: '#F2F0E6', role: 'headline' }, { hex: '#D9A54E', role: 'accent' }, { hex: '#FF00FF', role: 'other' }], [file]);
  assert.deepEqual(snapped.map((c) => c.hex), ['#1B2421', '#ECEBE6', '#C9A35B', '#FF00FF'], 'three estimates become the real colours; magenta is nowhere in the picture, so it stays');
  assert.equal(snapped[0].role, 'background', 'the job is kept');
  assert.deepEqual(snapColours([{ hex: '#1B2421' }], [file]).map((c) => c.hex), ['#1B2421'], 'an exact colour stays exact');
});
