// Two everyday things while Claude works: typing is never interrupted (the page refreshes itself without taking the text box away, and a notice does
// not block what is under it), and the List makes it obvious which posts are being made or are in line. Claude is never started.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadCalendar, saveCalendar } from '../src/calendar/model.mjs';
import { acquireRunLock } from '../src/calendar/lock.mjs';
import { clearJobs } from '../src/calendar/jobs.mjs';
import { closeBrowser } from './helpers.mjs';
import { overview, studioPage, TODAY } from './studio-helpers.mjs';

after(closeBrowser);

test('typing carries on through background refreshes and with a notice showing; a notice lets clicks through except on its buttons', async () => {
  await studioPage(async ({ page, open }) => {
    await open(`#/s/create?today=${TODAY}&mode=simple`);
    await page.waitForSelector('[data-field="simple-ask"]');
    await page.click('[data-field="simple-ask"]');
    await page.keyboard.type('Three reels ');
    // the Studio refreshes itself (as it does every few seconds while Claude works) and a notice pops up
    await page.evaluate(async () => {
      const ui = await import('/app/studio-ui.js');
      ui.notify('Something finished', { kind: 'ok', action: { label: 'Review it', fn: () => {} } });
      await (await import('/app/studio-store.js')).load({ force: true });
      window.dispatchEvent(new Event('hashchange'));
    });
    await page.keyboard.type('about the team');
    assert.equal(await page.inputValue('[data-field="simple-ask"]'), 'Three reels about the team', 'nothing typed was lost');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.field), 'simple-ask', 'still typing in the same box');
    const pe = await page.evaluate(() => { const n = document.querySelector('.notice'); return [getComputedStyle(n).pointerEvents, getComputedStyle(n.querySelector('.notice-act')).pointerEvents]; });
    assert.deepEqual(pe, ['none', 'auto'], 'the notice body lets clicks through; its button still works');
  });
});

test('the List: a post being made is plainly marked (sweep, "Being made now"), the next one says "Next in line"', async () => {
  clearJobs();
  const gates = [];
  const claudeRunner = { propose: async () => ({ ran: [] }), build: () => new Promise((r) => gates.push(() => r({ ran: [{ outcome: 'built' }] }))) };
  await studioPage(async ({ page, open, call, work }) => {
    const { posts } = await overview(call);
    const project = posts.find((p) => p.calendar && p.itemId)?.project;
    const dir = join(work, 'projects', project);
    const cal = loadCalendar(dir);
    const [a, b] = cal.items.filter((i) => !i.doc && !i.external && ['idea', 'approved'].includes(i.status)).slice(0, 2);
    a.status = 'building'; a.run = { state: 'building', startedAt: new Date(Date.now() - 125000).toISOString(), attempts: 1 };
    b.status = 'approved'; b.ideaApproval = 'owner'; delete b.run;
    saveCalendar(dir, cal);
    const c = (await call(`/projects/${project}/calendar/items`, 'POST', { items: [{ date: '2026-11-20', format: 'reel', title: 'Third in the queue', idea: 'A third post to wait in line.', hook: 'Third.', status: 'approved' }] })).body.items[0];
    const lock = acquireRunLock(dir, { mode: 'build', item: a.id });
    try {
      // b starts (Claude is held there), so c waits in line behind it
      assert.equal((await call(`/projects/${project}/calendar/run`, 'POST', { action: 'build', item: b.id })).status, 202);
      assert.equal((await call(`/projects/${project}/calendar/run`, 'POST', { action: 'build', item: c.id })).body.queued, true);
      assert.equal((await call(`/projects/${project}/calendar/run`, 'POST', { action: 'build', item: b.id })).body.ok, false, 'the same post is not asked for twice');
      await open(`#/s/list?today=${TODAY}`);
      await page.waitForSelector(`.lr[data-uid="${project}:${a.id}"]`);
      const rowA = page.locator(`.lr[data-uid="${project}:${a.id}"]`);
      assert.equal(await rowA.getAttribute('data-making'), 'now');
      assert.match(await rowA.locator('.c-status').innerText(), /Being made now · \d+ (s|min)/);
      assert.match(await rowA.locator('.c-title .m').innerText(), /Claude is making this right now/);
      assert.ok(await rowA.locator('.mk-chip .spin').count(), 'a spinner');
      const anim = await rowA.evaluate((el) => getComputedStyle(el, '::after').animationName);
      assert.equal(anim, 'mk-sweep', 'the row has a moving sweep');
      await page.evaluate(() => { location.hash = '#/s/list?today=2026-10-05&q=Third'; });   // the list draws only the rows on screen
      await page.waitForSelector(`.lr[data-uid="${project}:${c.id}"]`);
      const rowC = page.locator(`.lr[data-uid="${project}:${c.id}"]`);
      assert.equal(await rowC.getAttribute('data-making'), 'line');
      assert.match(await rowC.locator('.c-status').innerText(), /Next in line/);
    } finally { lock.release(); gates.forEach((g) => g()); }
  }, { claudeRunner });
});
