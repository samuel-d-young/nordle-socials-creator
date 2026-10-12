// The brand kit, Canva style: logos in several kinds (colour, black, white, icon, wordmark), a screenshot of a brand page read for its colours and fonts, and the
// choices kept when the brand is made. A fake reader stands in for Claude here: nothing real is started.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanShot, colorsFromPixels, jsonFrom, readBrandScreenshots } from '../src/brand/screenshot.mjs';
import { AGENT, TOKEN, closeBrowser } from './helpers.mjs';
import { studio, studioPage, TODAY } from './studio-helpers.mjs';

after(closeBrowser);

const dir = mkdtempSync(join(tmpdir(), 'nordle-kit-'));
const SVG = (fill) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="${fill}"/></svg>`;
const file = (name, text) => { const p = join(dir, name); writeFileSync(p, text); return p; };
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc0f01f0000050001ffa5e8fd00000000049454e44ae426082', 'hex');

const SAID = { brandName: 'Harbour Studio', colors: [{ name: 'Primary', hex: '#1b6ca8' }, { name: 'Gold', hex: '#F2A900' }, { hex: '#0B1F33' }, { hex: 'not a colour' }, { hex: '#1B6CA8' }], fonts: { heading: 'Playfair Display', body: 'Lora', subheading: '<script>x</script>' }, tone: ['Warm', 'plain-spoken'], logoSeen: true, notes: 'Hex codes were written on the page.' };

test('what a screenshot says is cleaned: real colours once each, plain font names, short tone words; nothing else gets through', () => {
  const s = cleanShot({ ...SAID, extra: 'ignored' });
  assert.deepEqual(s.colors.map((c) => c.hex), ['#1B6CA8', '#F2A900', '#0B1F33'], 'upper-cased, no duplicates, nothing that is not a hex');
  assert.equal(s.colors[0].name, 'Primary');
  assert.equal(s.fonts.heading, 'Playfair Display');
  assert.equal(s.fonts.subheading, 'scriptxscript', 'markup is stripped down to plain letters');
  assert.deepEqual(s.tone, ['warm', 'plain-spoken']);
  assert.equal(s.extra, undefined);
  assert.equal(cleanShot(null).colors.length, 0);
  assert.equal(cleanShot({ colors: Array.from({ length: 30 }, (_, i) => ({ hex: `#${String(i).padStart(2, '0')}AA00` })) }).colors.length, 12);
  assert.deepEqual(jsonFrom('Here you go: {"colors":[{"hex":"#112233"}]} done'), { colors: [{ hex: '#112233' }] });
  assert.equal(jsonFrom('no json here'), null);
});

test('with a reader the answer is used as is; with no screenshots it asks for one; the pixel fallback skips white and grey', async () => {
  const shot = file('shot.png', PNG);
  const r = await readBrandScreenshots([shot], { reader: async (files) => { assert.deepEqual(files, [shot]); return SAID; } });
  assert.equal(r.shot.fonts.body, 'Lora');
  await assert.rejects(readBrandScreenshots([join(dir, 'notes.txt')], { reader: async () => ({}) }), /at least one screenshot/);
  assert.deepEqual(colorsFromPixels([shot]), [], 'a one-pixel see-through picture has no brand colours');
});

test('the routes: only the owner reads a screenshot; the answer goes into the scan (colours, fonts, voice, name) and a made-up reply cannot slip in a bad colour', async () => {
  await studio(async ({ call, port }) => {
    const session = 'ab12cd34ef56ab99';
    const stage = (name, body) => fetch(`http://127.0.0.1:${port}/api/brand/upload`, { method: 'POST', headers: { 'x-nordle-token': TOKEN, 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(name), 'x-upload-session': session }, body });
    await stage('canva kit.png', PNG);
    assert.equal((await call('/brand/read-screenshots', 'POST', { uploadSession: session, files: ['canva kit.png'] }, AGENT)).status, 403);
    assert.equal((await call('/brand/read-screenshots', 'POST', { uploadSession: session, files: ['gone.png'] })).status, 400);
    const r = await call('/brand/read-screenshots', 'POST', { uploadSession: session, files: ['canva kit.png'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.shot.colors.map((c) => c.hex), ['#1B6CA8', '#F2A900', '#0B1F33']);
    const scan = await call('/brand/scan', 'POST', { uploadSession: session, shot: { ...r.body.shot, colors: [...r.body.shot.colors, { hex: 'javascript:alert(1)' }] } });
    assert.equal(scan.status, 200, JSON.stringify(scan.body));
    assert.equal(scan.body.draft.name, 'Harbour Studio');
    assert.equal(scan.body.draft.fonts.display.family, 'Playfair Display');
    assert.equal(scan.body.draft.fonts.body.family, 'Lora');
    assert.deepEqual(scan.body.draft.voice.tone.slice(0, 2), ['warm', 'plain-spoken']);
    assert.ok(scan.body.palette.includes('#1B6CA8') && scan.body.palette.includes('#F2A900'));
    assert.ok(scan.body.found.some((t) => /Read 3 colours from your screenshot/.test(t)));
    assert.ok(!JSON.stringify(scan.body).includes('javascript:'));
  }, { brandReader: async () => SAID });
});

test('Add a brand: logos of several kinds and a screenshot are added, shown, read, used by the scan, and kept with the new brand', async () => {
  const colour = file('colour.svg', SVG('#1B6CA8')), white = file('white.svg', SVG('#FFFFFF')), shot = file('kit.png', PNG);
  await studioPage(async ({ page, open, work }) => {
    await open(`#/s/month?today=${TODAY}`);
    await page.locator('[data-act="add-brand"]').click();
    await page.fill('[data-field="wz-name"]', 'Kit Studio');
    await page.locator('[data-act="wz-next"]').click();
    await page.waitForSelector('[data-field="logo-slots"]');
    assert.equal(await page.locator('.logo-slot').count(), 5, 'five kinds of logo');
    assert.equal(await page.locator('[data-act="wz-scan"]').isDisabled(), true);
    await page.setInputFiles('[data-field="logo-file-primary"]', colour);
    await page.waitForSelector('.logo-slot[data-kind="primary"] img');
    await page.setInputFiles('[data-field="logo-file-white"]', white);
    await page.waitForSelector('.logo-slot[data-kind="white"] img');
    assert.equal(await page.locator('.logo-slot.has').count(), 2);
    assert.equal(await page.locator('[data-act="wz-scan"]').isDisabled(), false, 'logos are something to look at');
    // a screenshot
    await page.setInputFiles('[data-field="shot-file"]', shot);
    await page.waitForSelector('.shot-th img');
    await page.locator('[data-act="shot-read"]').click();
    await page.waitForSelector('[data-state="shot-read"] .bg-sw');
    assert.equal(await page.locator('[data-state="shot-read"] .bg-sw').count(), 3);
    const read = await page.locator('[data-state="shot-read"]').innerText();
    assert.match(read, /Headings: Playfair Display/);
    assert.match(read, /Body: Lora/);
    await page.locator('[data-act="wz-scan"]').click();
    await page.waitForSelector('[data-state="scanned"]');
    const found = await page.locator('.wz-found').innerText();
    assert.match(found, /taken from your 2 logos/);
    assert.match(found, /Fonts from your screenshot: Playfair Display, .*Lora/);
    await page.locator('[data-act="wz-next"]').click();
    await page.waitForSelector('.bg-edit');
    assert.equal(await page.inputValue('[data-field="bg-font-display"]'), 'Playfair Display');
    assert.equal(await page.inputValue('[data-field="bg-font-body"]'), 'Lora');
    await page.locator('[data-act="wz-create"]').click();
    await page.waitForSelector('.wz-nexts');
    const proj = join(work, 'projects', 'kit-studio');
    const brand = JSON.parse(readFileSync(join(proj, 'brand.json'), 'utf8'));
    assert.deepEqual(Object.keys(brand.logos).sort(), ['primary', 'white']);
    assert.ok(existsSync(join(proj, 'assets/logos/primary.svg')) && existsSync(join(proj, 'assets/logos/white.svg')));
    assert.equal(brand.fonts.display.family, 'Playfair Display');
  }, { brandReader: async () => SAID });
});

test('a brand that exists: logos are added, a white one is made from the colour logo in one click, and each can be removed', async () => {
  await studioPage(async ({ page, open, call, work }) => {
    await open(`#/s/month?today=${TODAY}`);
    const p = (await call('/projects')).body;
    const id = (p.projects ?? p)[0].id;
    await page.locator('.rb-menu').first().click();
    await page.locator('[data-act="brand-guide"]').click();
    await page.waitForSelector('.bg-read');
    await page.locator('[data-act="guide-edit"]').click();
    await page.waitForSelector('[data-field="logo-slots"]');
    assert.equal(await page.locator('[data-act="logo-make-white"]').count(), 0, 'nothing to make a white one from yet');
    await page.setInputFiles('[data-field="logo-file-primary"]', file('mine.svg', SVG('#B5179E')));
    await page.waitForSelector('.logo-slot[data-kind="primary"].has');
    await page.waitForSelector('[data-act="logo-make-white"]');
    await page.locator('[data-act="logo-make-white"]').click();
    await page.waitForSelector('.logo-slot[data-kind="white"].has');
    const proj = join(work, 'projects', id);
    const brand = JSON.parse(readFileSync(join(proj, 'brand.json'), 'utf8'));
    assert.equal(brand.logos.primary, 'assets/logos/primary.svg');
    assert.match(readFileSync(join(proj, brand.logos.white), 'utf8'), /#FFFFFF/);
    await page.locator('[data-act="logo-remove-white"]').click();
    await page.waitForFunction(() => !document.querySelector('.logo-slot[data-kind="white"].has'));
    assert.equal(JSON.parse(readFileSync(join(proj, 'brand.json'), 'utf8')).logos.white, undefined);
  });
});
