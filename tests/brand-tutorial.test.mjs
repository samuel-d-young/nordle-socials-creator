// After a brand is added, "Brand added" explains what comes next: its style guide, publishing, its logo and photos, Stock and All posts (with a button for each).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('the Brand added page explains Stock and All posts in plain words, and each button opens the right thing', async () => {
  await studioPage(async ({ page, open }) => {
    await makeBrand(page, open, 'Tutorial Tea');
    const text = await page.locator('.wz-nexts').innerText();
    assert.match(text, /Stock: your own footage and stock, used automatically/);
    assert.match(text, /Claude searches them by itself whenever it builds a post/);
    assert.match(text, /You never have to pick files/);
    assert.match(text, /Pexels, Pixabay and Freesound/);
    assert.match(text, /Nordle never buys or signs in anywhere/);
    assert.match(text, /All posts: every brand and every post/);
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

test('setup can add a footage and stock folder right on the Brand added page; it is saved for that brand and Claude will search it itself', async () => {
  const settings = mkdtempSync(join(tmpdir(), 'nordle-wzstock-set-'));
  const footage = mkdtempSync(join(tmpdir(), 'nordle-wzstock-footage-'));
  mkdirSync(join(footage, 'shoot'), { recursive: true });
  process.env.NORDLE_PUBLISH_DIR = settings;   // never the real stock settings
  try {
    await studioPage(async ({ page, open, call }) => {
      await makeBrand(page, open, 'Footage First');
      await page.waitForSelector('[data-field="wz-stock"]');
      await page.locator('[data-act="wz-stock-add"]').click();
      assert.match(await page.locator('[data-state="wz-stock-note"]').innerText(), /Choose the folder first/);
      await page.fill('[data-field="wz-stock-path"]', footage);
      await page.fill('[data-field="wz-stock-name"]', 'My footage');
      await page.locator('[data-field="wz-stock-kind-photo"]').uncheck();
      await page.locator('[data-act="wz-stock-add"]').click();
      await page.waitForSelector('.wz-stock-list li');
      assert.match(await page.locator('.wz-stock-list').innerText(), /My footage[\s\S]*added for Footage First\. Claude will search it itself when it builds/);
      const libs = (await call('/stock/libraries')).body.libraries;
      const mine = libs.find((l) => l.id === 'my-footage');
      assert.ok(mine, 'the folder library exists');
      assert.deepEqual([mine.type, mine.kinds, mine.brands, mine.path], ['folder', ['video'], ['footage-first'], footage]);
      assert.equal(await page.locator('[data-act="wz-stock-add"]').innerText(), 'Add another folder');
    });
  } finally {
    delete process.env.NORDLE_PUBLISH_DIR;
    rmSync(settings, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
    rmSync(footage, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  }
});

test('Create page: the brand the posts are for can be chosen right there, whatever the left bar shows; suggestions are asked for that brand', async () => {
  await studioPage(async ({ page, open }) => {
    await makeBrand(page, open, 'Chooser Two');   // the left bar now shows this new brand
    await page.locator('[data-act="wz-done"]').click();
    await open(`#/s/create?today=${TODAY}&mode=advanced`);
    await page.waitForSelector('[data-state="brand-pick"]');
    const chips = await page.$$eval('[data-state="brand-pick"] .cr-chip', (b) => b.map((x) => [x.dataset.brand, x.getAttribute('aria-pressed')]));
    assert.ok(chips.length >= 2, `a chip per brand: ${chips.length}`);
    assert.equal(chips.filter(([, p]) => p === 'true').length, 1);
    const before = await page.locator('.cr-head h2').innerText();
    const other = chips.find(([, p]) => p !== 'true')[0];
    await page.locator(`[data-state="brand-pick"] [data-brand="${other}"]`).click();
    await page.waitForFunction((id) => document.querySelector(`[data-state="brand-pick"] [data-brand="${id}"]`)?.getAttribute('aria-pressed') === 'true', other);
    assert.notEqual(await page.locator('.cr-head h2').innerText(), before, 'the page is now for the other brand');
    const asked = page.waitForRequest((r) => /\/calendar\/suggest\?/.test(r.url()));
    await page.locator('[data-act="create-suggest"]').click();
    assert.ok((await asked).url().includes(`/projects/${encodeURIComponent(other)}/calendar/suggest`), 'the options are for the brand that was chosen');
  });
});
