// The brand pieces of the Studio: the style guide window (read it, edit it, save) and the Add a brand steps (set it up by hand,
// or let Nordle draft it from what it can find). Nothing real is contacted: the manual path needs no network and the draft path is
// given only pasted captions, which are read on this computer.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeBrowser } from './helpers.mjs';
import { studioPage, TODAY } from './studio-helpers.mjs';

after(closeBrowser);

const HOME = `#/s/month?today=${TODAY}`;
const brandOf = (work, id) => JSON.parse(readFileSync(join(work, 'projects', id, 'brand.json'), 'utf8'));

test('the style guide window shows the brand, Edit changes it, a bad colour is refused in plain words, Save writes brand.json', async () => {
  await studioPage(async ({ page, open, work, call }) => {
    await open(HOME);
    const first = (await call('/projects')).body;
    const projects = first.projects ?? first;
    const id = projects[0].id;
    await page.locator(`.rb-menu`).first().click();
    await page.locator('[data-act="brand-guide"]').click();
    await page.waitForSelector('.bg-read');
    assert.ok((await page.locator('.bg-name').textContent()).length > 0);
    assert.ok((await page.locator('.bg-sws li').count()) >= 2, 'swatches are shown');

    await page.locator('[data-act="guide-edit"]').click();
    await page.waitForSelector('.bg-edit');
    await page.fill('[data-field="bg-color-accent"]', 'banana');
    await page.locator('[data-act="guide-save"]').click();
    await page.waitForSelector('.notice.error');
    assert.notEqual(brandOf(work, id).colors.accent, 'banana', 'nothing was written');
    assert.equal(await page.locator('.bg-edit').count(), 1, 'still editing, nothing lost');

    await page.fill('[data-field="bg-color-accent"]', '#0a7b83');
    await page.fill('[data-field="bg-name"]', 'Renamed In The Guide');
    await page.fill('[data-field="bg-tone"]', 'warm, plain');
    await page.locator('[data-act="guide-save"]').click();
    await page.waitForSelector('.bg-read');
    assert.equal(brandOf(work, id).name, 'Renamed In The Guide');
    assert.equal(brandOf(work, id).colors.accent, '#0A7B83');
    assert.deepEqual(brandOf(work, id).voice.tone, ['warm', 'plain']);
    assert.match(await page.locator('.bg-name').textContent(), /Renamed In The Guide/);
  });
});

test('Add a brand by hand: name, style, done; the new brand exists with its own folder and shows in the rail', async () => {
  await studioPage(async ({ page, open, work }) => {
    await open(HOME);
    const before = await page.locator('.rb-menu').count();
    await page.locator('[data-act="add-brand"]').click();
    await page.waitForSelector('.wz-steps');
    await page.locator('[data-act="wz-next"]').click();
    assert.match(await page.locator('.notice.error').first().textContent(), /name/i, 'a name is needed first');
    await page.fill('[data-field="wz-name"]', 'Quokka Surf School');
    await page.locator('label[data-mode="manual"]').click();
    await page.locator('[data-act="wz-next"]').click();
    await page.waitForSelector('.bg-edit');
    await page.fill('[data-field="bg-color-accent"]', '#1B6CA8');
    await page.locator('[data-act="wz-create"]').click();
    await page.waitForSelector('.wz-nexts');
    const brand = brandOf(work, 'quokka-surf-school');
    assert.equal(brand.name, 'Quokka Surf School');
    assert.equal(brand.colors.accent, '#1B6CA8');
    await page.locator('[data-act="wz-done"]').click();
    await page.waitForFunction((n) => document.querySelectorAll('.rb-menu').length === n, before + 1);
  });
});

test('Add a brand the automatic way: pasted captions give the draft its hashtags, and the draft can be changed before the brand is made', async () => {
  await studioPage(async ({ page, open, work }) => {
    await open(HOME);
    await page.locator('[data-act="add-brand"]').click();
    await page.fill('[data-field="wz-name"]', 'Seaside Cafe');
    await page.locator('[data-act="wz-next"]').click();
    assert.equal(await page.locator('[data-act="wz-scan"]').isDisabled(), true, 'nothing to look at yet');
    await page.fill('[data-field="wz-captions"]', 'Fresh today! #SeasideCafe #Coffee');
    assert.equal(await page.locator('[data-act="wz-scan"]').isDisabled(), false, 'wakes up as soon as something is filled in');
    await page.locator('[data-act="wz-scan"]').click();
    await page.waitForSelector('[data-state="scanned"]');
    await page.locator('[data-act="wz-next"]').click();
    await page.waitForSelector('.bg-edit');
    await page.fill('[data-field="bg-handle"]', '@seaside');
    await page.locator('[data-act="wz-create"]').click();
    await page.waitForSelector('.wz-nexts');
    const brand = brandOf(work, 'seaside-cafe');
    assert.equal(brand.links.handle, '@seaside');
    assert.match(brand.note ?? '', /#SeasideCafe/, 'the usual hashtags are kept in its notes');
  });
});
