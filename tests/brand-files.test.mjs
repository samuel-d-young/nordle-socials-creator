// Adding files to help make a brand: a written style guide is read for what it plainly says, files are staged on the server and kept with the brand
// when it is made, and the wizard lets you add files (and several folders) and take them away again.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGuideText } from '../src/brand/guide-text.mjs';
import { scanBrand } from '../src/brand/scan.mjs';
import { AGENT, TOKEN, closeBrowser } from './helpers.mjs';
import { studio, studioPage, TODAY } from './studio-helpers.mjs';

after(closeBrowser);

const GUIDE = `# Harbour Bakery brand guide

## Colours
- Primary: #1B6CA8
- Accent colour #F2A900
- Background: #fff8ee
Some other swatch #123456 appears once.

## Typography
- Headings: Playfair Display
- Body text: Lora, serif

## Voice
Tone of voice: warm, plain-spoken and a little cheeky
Never say: cheap, best in town, amazing deal
`;

test('a written style guide gives its colours, fonts, tone and phrases to avoid, and the strong colours rank first', () => {
  const g = readGuideText(GUIDE);
  const ranked = [...g.colours].sort((a, b) => b[1] - a[1]).map(([h]) => h);
  assert.deepEqual(ranked.slice(0, 3).sort(), ['#1B6CA8', '#F2A900', '#FFF8EE'].sort());
  assert.ok(g.colours.has('#123456'));
  assert.equal(g.fonts.display, 'Playfair Display');
  assert.equal(g.fonts.body, 'Lora');
  assert.deepEqual(g.tone, ['warm', 'plain-spoken', 'a little cheeky']);
  assert.deepEqual(g.banned, ['cheap', 'best in town', 'amazing deal']);
  const css = readGuideText('h1 { font-family: "Fraunces", Georgia, serif; color: #A00; }');
  assert.deepEqual(css.fonts.other, ['Fraunces']);
  assert.ok(css.colours.has('#AA0000'), 'a short hex is widened');
  assert.deepEqual(readGuideText('Nothing useful here.').tone, []);
});

test('scanBrand reads added files: a style guide drafts colours, fonts, tone and phrases; a PDF is kept but said to be unreadable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nordle-guide-'));
  const md = join(dir, 'brand-guide.md'), pdf = join(dir, 'Brand Book.pdf');
  writeFileSync(md, GUIDE);
  writeFileSync(pdf, '%PDF-1.4 not really');
  const r = await scanBrand({ name: 'Harbour Bakery', uploads: [md, pdf, join(dir, 'missing.md')] });
  assert.ok(r.found.some((t) => /Read the style guide "brand-guide\.md"/.test(t)), JSON.stringify(r.found));
  assert.ok(r.problems.some((t) => /Brand Book\.pdf" is a PDF/.test(t)));
  assert.ok(r.palette.includes('#1B6CA8'));
  assert.equal(r.draft.fonts.display.family, 'Playfair Display');
  assert.equal(r.draft.fonts.body.family, 'Lora');
  assert.deepEqual(r.draft.voice.tone.slice(0, 2), ['warm', 'plain-spoken']);
  assert.deepEqual(r.draft.voice.bannedPhrases, ['cheap', 'best in town', 'amazing deal']);
});

test('the upload route: owner only, a safe name, a kind that makes sense, one folder per session; scan and create use only the files still wanted', async () => {
  await studio(async ({ call, port, work }) => {
    const session = 'ab12cd34ef56ab12';
    const send = (name, body, { token = TOKEN, sess = session, type = 'application/octet-stream' } = {}) =>
      fetch(`http://127.0.0.1:${port}/api/brand/upload`, { method: 'POST', headers: { 'x-nordle-token': token, 'content-type': type, 'x-filename': encodeURIComponent(name), 'x-upload-session': sess }, body })
        .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
    assert.equal((await send('guide.md', GUIDE, { token: AGENT })).status, 403, 'Claude cannot stage files');
    assert.equal((await send('virus.exe', 'x')).status, 415, 'a kind that cannot help a brand is refused in plain words');
    assert.equal((await send('guide.md', GUIDE, { sess: '../../etc' })).status, 400, 'a session is a short hex name, never a path');
    assert.equal((await send('guide.md', GUIDE, { type: 'application/json' })).status, 415);
    const a = await send('../../evil/brand guide.md', GUIDE);
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(a.body.name, 'brand guide.md', 'the name is cut down to a plain file name');
    const b = await send('brand guide.md', GUIDE);
    assert.equal(b.body.name, 'brand guide-2.md', 'a second file with the same name is kept, not overwritten');
    // scan sees only the names it is told about
    const scan = await call('/brand/scan', 'POST', { name: 'Harbour', uploadSession: session, files: ['brand guide.md', '../../secret.txt', 'nope.md'] });
    assert.equal(scan.status, 200, JSON.stringify(scan.body));
    assert.equal(scan.body.draft.fonts.display.family, 'Playfair Display');
    assert.ok(!JSON.stringify(scan.body).includes('secret'));
    // create keeps just the wanted files with the brand, and clears the staging folder
    const made = await call('/brand/create', 'POST', { name: 'Harbour Bakery', uploadSession: session, files: ['brand guide.md'] });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const kept = join(work, 'projects', made.body.id, 'assets', 'brand');
    assert.equal(readFileSync(join(kept, 'brand guide.md'), 'utf8'), GUIDE);
    assert.equal(existsSync(join(kept, 'brand guide-2.md')), false, 'a file the person removed is not kept');
  });
});

test('Add a brand: add files by the button (a style guide), see them listed, remove one; they are sent with Look and with Create', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nordle-up-'));
  const guide = join(dir, 'style-guide.md'), logo = join(dir, 'logo.png'), junk = join(dir, 'notes.exe');
  writeFileSync(guide, GUIDE);
  writeFileSync(logo, Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc0f01f0000050001ffa5e8fd00000000049454e44ae426082', 'hex'));
  writeFileSync(junk, 'x');
  await studioPage(async ({ page, open, work }) => {
    await open(`#/s/month?today=${TODAY}`);
    await page.locator('[data-act="add-brand"]').click();
    await page.fill('[data-field="wz-name"]', 'Quokka Sweets');
    await page.locator('[data-act="wz-next"]').click();
    assert.equal(await page.locator('[data-act="wz-scan"]').isDisabled(), true);
    await page.setInputFiles('[data-field="wz-file-upload"]', [guide, logo, junk]);
    await page.waitForSelector('[data-field="wz-files"]');
    const listed = () => page.$$eval('[data-field="wz-files"] .pick-path', (e) => e.map((x) => x.textContent));
    assert.deepEqual((await listed()).sort(), ['logo.png', 'style-guide.md']);
    assert.equal(await page.locator('[data-act="wz-scan"]').isDisabled(), false, 'added files are something to look at');
    await page.locator('[data-act="wz-scan"]').click();
    await page.waitForSelector('[data-state="scanned"]');
    assert.match(await page.locator('.wz-found').innerText(), /Read the style guide "style-guide\.md"/);
    // take the logo away again, then make the brand
    await page.locator('[data-act="wz-remove-file"]').filter({ has: page.locator(':scope') }).first().click();
    await page.waitForSelector('[data-field="wz-files"]');
    const left = await listed();
    assert.equal(left.length, 1);
    await page.locator('[data-act="wz-next"]').click();
    await page.waitForSelector('.bg-edit');
    await page.locator('[data-act="wz-create"]').click();
    await page.waitForSelector('.wz-nexts');
    const kept = join(work, 'projects', 'quokka-sweets', 'assets', 'brand');
    assert.equal(existsSync(join(kept, left[0])), true, 'the file that stayed in the list is kept with the brand');
    assert.equal(existsSync(join(kept, left[0] === 'logo.png' ? 'style-guide.md' : 'logo.png')), false, 'the one that was removed is not');
  });
});
