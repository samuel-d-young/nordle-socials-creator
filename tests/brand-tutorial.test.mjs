// After a brand is added, "Brand added" explains what comes next: its style guide, publishing, its logo and photos, Stock and the Library (with a button for each).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { closeBrowser } from './helpers.mjs';
import { studioPage, TODAY } from './studio-helpers.mjs';

after(closeBrowser);

async function makeBrand(page, open, name) {
  await open(`#/s/month?today=${TODAY}`);
  await page.locator('[data-act="add-brand"]').click();
  await page.fill('[data-field="wz-name"]', name);
  await page.locator('[data-act="wz-next"]').click();
  await page.locator('[data-act="wz-skip"]').click();
  await page.waitForSelector('.bg-edit');
  await page.locator('[data-act="wz-create"]').click();
  await page.waitForSelector('.wz-nexts');
}

test('the Brand added page explains Stock and the Library in plain words, and each button opens the right thing', async () => {
  await studioPage(async ({ page, open }) => {
    await makeBrand(page, open, 'Tutorial Tea');
    const text = await page.locator('.wz-nexts').innerText();
    assert.match(text, /Stock: your own footage and stock, used automatically/);
    assert.match(text, /Claude searches them by itself whenever it builds a post/);
    assert.match(text, /You never have to pick files/);
    assert.match(text, /Pexels, Pixabay and Freesound/);
    assert.match(text, /Nordle never buys or signs in anywhere/);
    assert.match(text, /The Library: every brand and every post/);
    assert.match(text, /Everything stays on this computer/);
    assert.match(text, /Press Create/);
    assert.equal(await page.locator('.wz-next').count(), 6);
    await page.locator('[data-act="wz-open-stock"]').click();
    await page.waitForSelector('dialog.stk-dialog[open]');
    await page.keyboard.press('Escape');
  });
  await studioPage(async ({ page, open }) => {
    await makeBrand(page, open, 'Tutorial Coffee');
    await page.locator('[data-act="wz-open-library"]').click();
    await page.waitForFunction(() => location.hash === '#/projects');
    await page.waitForSelector('.proj');
  });
});
