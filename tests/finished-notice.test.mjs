// When Claude finishes building a post, the Studio says so with a notice that has a Review button. Nothing opens by itself, and above all not the video editor.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadCalendar, saveCalendar } from '../src/calendar/model.mjs';
import { closeBrowser } from './helpers.mjs';
import { overview, studioPage, TODAY, verifiedBuilt } from './studio-helpers.mjs';

after(closeBrowser);

test('a post that was being built and is now built shows a notice with a Review button; the page does not move and no editor opens', async () => {
  await studioPage(async ({ page, open, call, work }) => {
    const post = (await overview(call)).posts.find(verifiedBuilt);
    const dir = join(work, 'projects', post.project);
    const setStatus = (status) => { const cal = loadCalendar(dir); cal.items.find((i) => i.id === post.itemId).status = status; saveCalendar(dir, cal); };
    setStatus('building');
    await open(`#/s/month?today=${TODAY}&month=${post.date.slice(0, 7)}`);
    await page.evaluate(async () => { await (await import('/app/studio-store.js')).load({ force: true }); });
    const hashBefore = await page.evaluate(() => location.hash);
    assert.equal(await page.locator('.notice').count(), 0, 'nothing to announce yet');
    setStatus('built');
    await page.evaluate(async () => { await (await import('/app/studio-store.js')).load({ force: true }); });
    await page.waitForSelector('.notice:has-text("is built and waiting for your review")');
    assert.match(await page.locator('.notice').first().innerText(), new RegExp(post.title.slice(0, 12).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(await page.evaluate(() => location.hash), hashBefore, 'the page did not move');
    assert.equal(await page.locator('.video-editor, .vt-timeline').count(), 0, 'no editor opened');
    await page.locator('.notice-act:has-text("Review it")').click();
    await page.waitForSelector('.detail.open');
    assert.ok(!(await page.evaluate(() => location.hash)).startsWith('#/p/'), 'Review opens the post sheet, not the editor');
  });
});
