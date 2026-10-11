// The month page: every upcoming month in one scroll, sticky month headings, Today, lazy pictures, and a phone agenda that does the same.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { closeBrowser } from './helpers.mjs';
import { studioPage, TODAY } from './studio-helpers.mjs';

after(closeBrowser);

const title = (page) => page.evaluate(() => document.querySelector('.mast-h').textContent);

test('the calendar scrolls down through every month with posts, plus one empty month, each with a heading', async () => {
  await studioPage(async ({ page, open }) => {
    await open(`#/s/month?today=${TODAY}`);
    const months = await page.locator('.m-month').evaluateAll((els) => els.map((e) => e.dataset.month));
    assert.deepEqual(months, ['2026-10', '2026-11', '2026-12'], 'this month, next month, and one empty month after the last post');
    assert.match(await page.locator('.m-month').nth(2).locator('.m-mc').textContent(), /nothing planned/);
    assert.match(await page.locator('.m-month').first().locator('.m-mc').textContent(), /\d+ posts/);
    assert.equal(await page.locator('.m-day.today').count(), 1);
    assert.ok(await page.locator('.chip').count() > 40, 'every month is on the page');
    assert.ok(await page.locator('.chip img[loading="lazy"]').count() > 40, 'pictures load as they come into view');
    assert.match(await title(page), /October/);

    // scroll down: the title and the sticky heading follow
    await page.locator('.view').evaluate((v) => { v.scrollTop = document.querySelector('[data-month="2026-11"]').offsetTop + 20; });
    await page.waitForFunction(() => document.querySelector('.mast-h').textContent.startsWith('November'));
    const stuck = await page.evaluate(() => {
      const v = document.querySelector('.view').getBoundingClientRect().top;
      const h = document.querySelector('[data-month="2026-11"] .m-mh').getBoundingClientRect().top - v;
      return h;
    });
    assert.ok(stuck >= 0 && stuck < 80, `the November heading is stuck near the top (${stuck}px)`);
    await page.waitForFunction(() => /month=2026-11/.test(location.hash));

    // keys and buttons move between months; Today comes back
    await page.keyboard.press(']');
    await page.waitForFunction(() => document.querySelector('.mast-h').textContent.startsWith('December'));
    await page.keyboard.press('[');
    await page.waitForFunction(() => document.querySelector('.mast-h').textContent.startsWith('November'));
    await page.click('.mast-nav button:has-text("Today")');
    await page.waitForFunction(() => document.querySelector('.mast-h').textContent.startsWith('October'));
    await page.waitForFunction(() => { const t = document.querySelector('.m-week.has-today').getBoundingClientRect(); return t.top > 0 && t.bottom < innerHeight; });
    await page.click('.mast-nav button[aria-label="Next month"]');
    await page.waitForFunction(() => document.querySelector('.mast-h').textContent.startsWith('November'));
  });
});

test('the month page keeps its place and its lanes when the brand or filters change; a link to a month opens there', async () => {
  await studioPage(async ({ page, open }) => {
    await open(`#/s/month?today=${TODAY}&month=2026-11`);
    await page.waitForFunction(() => document.querySelector('.mast-h').textContent.startsWith('November'));
    const top = await page.evaluate(() => document.querySelector('[data-month="2026-11"] .m-mh').getBoundingClientRect().top - document.querySelector('.view').getBoundingClientRect().top);
    assert.ok(top < 70 && top >= 0, `opened at November (${top}px)`);
    await page.click('.rb:has-text("Harbour")');
    await page.waitForSelector('.m-grid.single');
    assert.equal(await page.locator('.m-grid.single').count(), 3);
    await page.click('.rb:has-text("All brands")');
    await page.waitForSelector('.m-grid.multi');
    await page.click('.f-seg button:has-text("Reels")');
    await page.waitForFunction(() => !document.querySelector('.chip .glyph-carousel'));
    assert.equal(await page.locator('.m-month').count(), 3, 'the months stay even when a filter empties some days');
  });
});

test('a phone gets one agenda through all the months, with month headings', async () => {
  await studioPage(async ({ page, open }) => {
    await open(`#/s/month?today=${TODAY}`);
    await page.waitForSelector('.agenda .ag-month');
    const heads = await page.locator('.ag-month').evaluateAll((els) => els.map((e) => e.dataset.month));
    assert.deepEqual(heads, ['2026-10', '2026-11']);
    assert.ok(await page.locator('.ag-item').count() > 30);
    await page.locator('.view').evaluate((v) => { v.scrollTop = document.querySelector(".ag-month[data-month=\"2026-11\"]").parentElement.offsetTop + 30; });
    await page.waitForFunction(() => document.querySelector('.mast-h').textContent.startsWith('November'));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 1);
  }, { viewport: { width: 390, height: 844 } });
});
