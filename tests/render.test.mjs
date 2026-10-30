// Phase 1 gate: documents render to the right pixels, the browser can only read the project, and verify finds real problems.
//   npm test   (needs a browser: npx playwright-core install chromium)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { ROOT } from '../tools/validate.mjs';
import { openBrowser, newCanvas, chromiumSandboxOn } from '../src/render/browser.mjs';
import { renderDocument } from '../src/render/render.mjs';
import { verifyDocument } from '../src/render/verify.mjs';
import { parseColour, backdropLuminance } from '../src/render/checks.mjs';

const SAMPLE = join(ROOT, 'samples', 'little-gannet');
let browser;
let work;

before(async () => {
  browser = await openBrowser();
  work = mkdtempSync(join(tmpdir(), 'nordle-test-'));
});
after(async () => {
  await browser?.close();
  if (work) rmSync(work, { recursive: true, force: true });
});

/** A throwaway copy of the sample project with one document replaced by `mutate(doc)`. */
function projectWith(name, mutate, from = 'spring-menu-carousel') {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  cpSync(join(SAMPLE, 'assets'), join(dir, 'assets'), { recursive: true });
  cpSync(join(SAMPLE, 'brand.json'), join(dir, 'brand.json'));
  mkdirSync(join(dir, 'docs'));
  const doc = JSON.parse(readFileSync(join(SAMPLE, 'docs', `${from}.json`), 'utf8'));
  mutate(doc);
  const file = join(dir, 'docs', `${from}.json`);
  writeFileSync(file, JSON.stringify(doc, null, 2));
  return { dir, file };
}

const rules = (r) => r.issues.filter((i) => i.level !== 'info').map((i) => `${i.level}:${i.rule}`);

test('renders every size and page at the preset pixel size', async () => {
  const out = join(work, 'out-all');
  const r = await renderDocument(join(SAMPLE, 'docs', 'spring-menu-carousel.json'), { browser, out });
  assert.equal(r.outputs.length, 10); // 5 pages x 2 sizes
  for (const o of r.outputs) {
    const png = PNG.sync.read(readFileSync(o.path));
    assert.equal(png.width, 1080);
    assert.equal(png.height, 1350);
  }
  assert.ok(r.outputs[0].path.endsWith('spring-menu-carousel_ig-feed-4x5_01-cover.png'));
});

test('scale 2 doubles the pixels', async () => {
  const r = await renderDocument(join(SAMPLE, 'docs', 'open-late-story.json'), { browser, out: join(work, 'out-2x'), sizes: ['ig-story-9x16'], scale: 2 });
  const png = PNG.sync.read(readFileSync(r.outputs[0].path));
  assert.deepEqual([png.width, png.height], [2160, 3840]);
});

test('page background and per-size override are honoured', async () => {
  const r = await renderDocument(join(SAMPLE, 'docs', 'open-late-story.json'), { browser, out: join(work, 'out-bg'), sizes: ['ig-story-9x16'] });
  const png = PNG.sync.read(readFileSync(r.outputs[0].path));
  // top-left pixel is the gradient's start: the night colourway turns "paper" into the dark ink
  const [red, green, blue] = [png.data[0], png.data[1], png.data[2]];
  assert.ok(red < 60 && green < 70 && blue < 70, `expected a dark top-left pixel, got ${red},${green},${blue}`);
  // the pill button is hidden in the feed size (override) and shown in the story size
  const seen = {};
  for (const size of ['ig-story-9x16', 'ig-feed-4x5']) {
    await renderDocument(join(SAMPLE, 'docs', 'open-late-story.json'), {
      browser, out: join(work, 'out-' + size), sizes: [size], inspect: true, onPage: ({ layers }) => { seen[size] = layers.map((l) => l.id); },
    });
  }
  assert.ok(seen['ig-story-9x16'].includes('pill'));
  assert.ok(!seen['ig-feed-4x5'].includes('pill'));
});

test('the bundled fonts really load (a missing font would silently fall back)', async () => {
  const dir = join(SAMPLE);
  const canvas = await newCanvas(browser, { projectDir: dir, width: 400, height: 200 });
  try {
    await canvas.show(`<!doctype html><link rel="stylesheet" href="http://nordle.local/fonts/fraunces/wght.css"><link rel="stylesheet" href="http://nordle.local/fonts/inter/wght.css">
      <p style="font-family:'Fraunces Variable'">Hello</p><p style="font-family:'Inter Variable'">Hello</p><p style="font-family:'Fraunces Variable';font-style:italic">Hello</p>`);
    const loaded = await canvas.page.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').map((f) => `${f.family}/${f.style}`));
    assert.ok(loaded.some((f) => f.includes('Fraunces Variable/normal')), loaded.join(', '));
    assert.ok(loaded.some((f) => f.includes('Inter Variable/normal')), loaded.join(', '));
    assert.ok(loaded.some((f) => f.includes('Fraunces Variable/italic')), loaded.join(', '));
  } finally { await canvas.close(); }
});

test('a page can read its own project files but nothing else, and cannot reach the network', async () => {
  const canvas = await newCanvas(browser, { projectDir: SAMPLE, width: 200, height: 100 });
  try {
    await canvas.show('<!doctype html><p>probe</p>');
    const probe = (url) => canvas.page.evaluate(async (u) => { try { const r = await fetch(u); return r.status; } catch { return 'blocked'; } }, url);
    assert.equal(await probe('http://nordle.local/project/brand.json'), 200);
    assert.equal(await probe('http://nordle.local/project/../../package.json'), 404);
    assert.equal(await probe('http://nordle.local/project/%2e%2e/%2e%2e/package.json'), 404);
    assert.equal(await probe('http://nordle.local/project/..%5c..%5cpackage.json'), 404);
    assert.equal(await probe('http://nordle.local/fonts/../package.json'), 404);
    assert.equal(await probe('http://example.com/'), 'blocked');
    assert.equal(await probe('file:///C:/Windows/win.ini'), 'blocked');
  } finally { await canvas.close(); }
});

test('verify passes the shipped sample documents with no errors and no warnings', async () => {
  for (const id of ['spring-menu-carousel', 'open-late-story']) {
    const r = await verifyDocument(join(SAMPLE, 'docs', `${id}.json`), { browser, out: join(work, `verify-${id}`) });
    assert.deepEqual(rules(r), [], `${id}: ${JSON.stringify(r.issues)}`);
    assert.ok(existsSync(join(work, `verify-${id}`, 'report.json')));
  }
});

test('verify flags low contrast', async () => {
  const { file } = projectWith('contrast', (d) => { d.pages[0].layers[0].style.color = '$brand.colors.muted'; d.pages[0].layers[0].style.size = 28; });
  const r = await verifyDocument(file, { browser, out: join(work, 'v1'), sizes: ['ig-feed-4x5'], pages: ['cover'] });
  assert.ok(rules(r).some((x) => x.endsWith(':contrast')), JSON.stringify(rules(r)));
});

test('verify flags text cut off by the edge of the picture', async () => {
  const { file } = projectWith('cutoff', (d) => { d.pages[0].layers[1].layout.x = -5; d.pages[0].layers[1].layout.w = 140; });
  const r = await verifyDocument(file, { browser, out: join(work, 'v2'), sizes: ['ig-feed-4x5'], pages: ['cover'] });
  assert.ok(rules(r).includes('error:text-cut-off'), JSON.stringify(rules(r)));
});

test('verify flags text in the area platform buttons cover', async () => {
  const { file } = projectWith('safe', (d) => {
    d.kind = 'graphic'; d.sizes = ['ig-reel-9x16']; d.pages = [d.pages[0]]; d.copy.alt = { cover: 'A steaming cup of coffee.' };
    d.pages[0].layers.find((l) => l.id === 'swipe').layout = { anchor: 'bottom-left', x: 8, y: 96 };
  });
  const r = await verifyDocument(file, { browser, out: join(work, 'v3') });
  assert.ok(rules(r).includes('warn:safe-zone'), JSON.stringify(rules(r)));
});

test('verify flags a brand-banned phrase in on-screen text and in the caption', async () => {
  const { file } = projectWith('banned', (d) => {
    d.pages[0].layers[2].text = "The world's best coffee";
    d.copy.caption = 'Guaranteed to make your morning.';
  });
  const r = await verifyDocument(file, { browser, out: join(work, 'v4'), sizes: ['ig-feed-4x5'], pages: ['cover'] });
  const banned = r.issues.filter((i) => i.rule === 'banned-phrase').map((i) => i.layer);
  assert.ok(banned.includes('cover/sub'), JSON.stringify(banned));
  assert.ok(banned.includes('copy.caption'), JSON.stringify(banned));
});

test('verify flags a caption over the platform limit and an image with no alt text', async () => {
  const { file } = projectWith('limits', (d) => {
    d.copy.caption = 'x'.repeat(2300);
    delete d.pages[0].layers.find((l) => l.type === 'image').alt;
  });
  const r = await verifyDocument(file, { browser, out: join(work, 'v5'), sizes: ['ig-feed-4x5'], pages: ['cover'] });
  assert.ok(rules(r).includes('error:caption-length'), JSON.stringify(rules(r)));
  assert.ok(rules(r).includes('warn:image-alt'), JSON.stringify(rules(r)));
});

test('verify refuses to render a document that does not validate', async () => {
  const { file } = projectWith('invalid', (d) => { d.pages[0].layers[0].style.color = '$brand.colors.nope'; });
  const r = await verifyDocument(file, { browser, out: join(work, 'v6') });
  assert.equal(r.outputs.length, 0);
  assert.ok(r.issues.some((i) => i.level === 'error' && i.message.includes('does not resolve')));
});

test('a font token can be missing from the bundle: the user is told, not silently given a fallback', async () => {
  const { file } = projectWith('font', (d) => { void d; });
  const brandFile = join(file, '..', '..', 'brand.json');
  const brand = JSON.parse(readFileSync(brandFile, 'utf8'));
  brand.fonts.display = { family: 'Some Unbundled Font', source: 'google', weights: [700] };
  writeFileSync(brandFile, JSON.stringify(brand));
  const r = await verifyDocument(file, { browser, out: join(work, 'v7'), sizes: ['ig-feed-4x5'], pages: ['cover'] });
  assert.ok(r.issues.some((i) => i.rule === 'font' && i.message.includes('Some Unbundled Font')), JSON.stringify(r.issues));
});

test('colour parsing and backdrop sampling', () => {
  assert.deepEqual(parseColour('rgb(1, 2, 3)'), { r: 1, g: 2, b: 3, a: 1 });
  assert.equal(parseColour('rgba(1, 2, 3, 0.5)').a, 0.5);
  assert.equal(parseColour('nonsense'), null);
  const png = new PNG({ width: 10, height: 10 });
  png.data.fill(255);
  const lum = backdropLuminance(png, { x: 0, y: 0, w: 10, h: 10 }, 1);
  assert.ok(lum.low > 0.99 && lum.high > 0.99);
});

test('the browser keeps its sandbox on Windows and macOS, Linux asks for it, and either can be switched off', () => {
  const on = (platform, env = {}) => chromiumSandboxOn({ platform, env });
  assert.deepEqual(['win32', 'darwin'].map((p) => on(p)), [true, true]);
  assert.equal(on('linux'), false, 'containers and CI runners usually cannot use it');
  assert.equal(on('linux', { NORDLE_CHROMIUM_SANDBOX: '1' }), true);
  for (const p of ['win32', 'darwin', 'linux']) assert.equal(on(p, { NORDLE_NO_CHROMIUM_SANDBOX: '1', NORDLE_CHROMIUM_SANDBOX: '1' }), false, `${p}: the opt-out wins`);
  assert.equal(on('win32', { NORDLE_NO_CHROMIUM_SANDBOX: '0' }), true);
});
