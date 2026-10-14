// The "being made" banner: after posts are sent to Claude, a small bar at the top of every page says what is being made, what is in line, and opens the
// list. Claude is never started: a fake runner holds each build until the test lets it finish.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadCalendar, saveCalendar } from '../src/calendar/model.mjs';
import { clearJobs } from '../src/calendar/jobs.mjs';
import { closeBrowser } from './helpers.mjs';
import { overview, studioPage, TODAY } from './studio-helpers.mjs';

after(closeBrowser);

test('two builds: the banner says what is being made and what is in line, on every page, lists them in order, and goes when they are done', async () => {
  clearJobs();
  const gates = [];
  const started = [];
  const claudeRunner = { propose: async () => ({ ran: [] }), build: (o) => { started.push(o.itemId); return new Promise((r) => gates.push(() => r({ ran: [{ outcome: 'built' }] }))); } };
  await studioPage(async ({ page, open, call, work }) => {
    const { posts } = await overview(call);
    const project = posts.find((p) => p.calendar && p.itemId)?.project;
    const dir = join(work, 'projects', project);
    // two posts approved and waiting to be built
    const cal = loadCalendar(dir);
    const two = cal.items.filter((i) => !i.doc && !i.external && ['idea', 'approved'].includes(i.status)).slice(0, 2);
    for (const it of two) { it.status = 'approved'; it.ideaApproval = 'owner'; delete it.run; }
    saveCalendar(dir, cal);
    for (const it of two) assert.equal((await call(`/projects/${project}/calendar/run`, 'POST', { action: 'build', item: it.id })).status, 202);

    const api = (await call('/making')).body;
    const mine = api.jobs.find((j) => j.project === project);
    assert.deepEqual([mine.running.item, mine.queue.map((q) => q.item)], [two[0].id, [two[1].id]], 'one running, one in line');
    assert.equal((await call('/making', 'POST', {})).status, 405);

    await open(`#/s/month?today=${TODAY}`);
    await page.waitForSelector('.working:not(.hidden) [data-state="making-summary"]');
    const sum = await page.locator('[data-state="making-summary"]').innerText();
    assert.match(sum, new RegExp(`Making “${two[0].title.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(sum, /1 in line/);
    await page.locator('[data-act="making-toggle"]').click();
    await page.waitForSelector('[data-state="making-panel"]');
    assert.equal(await page.locator('[data-section="now"] .mk-row').count(), 1);
    assert.equal(await page.locator('[data-section="line"] .mk-row').count(), 1);
    assert.match(await page.locator('[data-section="line"] .mk-row').innerText(), /Next/);
    // on another page it is still there
    await page.evaluate(() => { location.hash = '#/s/list?today=2026-10-05'; });
    await page.waitForSelector('.view.v-list');
    assert.equal(await page.locator('.working:not(.hidden) [data-state="making-summary"]').count(), 1);
    // both finish: the line empties, and the banner goes (nothing was really built, so nothing is "just finished")
    gates.shift()();
    for (let i = 0; i < 50 && gates.length < 1; i++) await page.waitForTimeout(100);
    gates.shift()();
    for (let i = 0; i < 50 && ((await call('/making')).body.jobs.find((j) => j.project === project)?.running); i++) await page.waitForTimeout(100);
    assert.deepEqual(started, two.map((t) => t.id), 'built in order');
    await page.evaluate(async () => { const m = await import('/app/studio-making.js'); await m.refreshMaking(); await (await import('/app/studio-store.js')).load({ force: true }); });
    // nothing is being made or in line any more (the test data has an older post that did not finish, which the banner rightly still mentions)
    await page.waitForFunction(() => { const t = document.querySelector('.working')?.innerText ?? ''; return !/Making|in line/.test(t); }, null, { timeout: 10000 });
  }, { claudeRunner });
});
