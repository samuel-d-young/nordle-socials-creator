// The all-brands Insights screen: every brand side by side, from the Buffer pull kept on disk (src/performance/from-buffer.mjs bufferOverview,
// GET /api/publish/buffer-overview, app/insights-overview.js). Fictional brands, made-up numbers, no network: the publishing settings live in a
// temporary folder and nothing here ever asks Buffer for anything.
//   node --test tests/insights-overview.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeBrowser } from './helpers.mjs';
import { studioPage, studio, overview, TODAY } from './studio-helpers.mjs';
import { bufferOverview } from '../src/performance/from-buffer.mjs';

const DAY = 86400000;
let state;
before(() => { state = mkdtempSync(join(tmpdir(), 'nordle-insights-overview-')); process.env.NORDLE_PUBLISH_DIR = join(state, 'settings'); mkdirSync(process.env.NORDLE_PUBLISH_DIR, { recursive: true }); });
after(async () => { delete process.env.NORDLE_PUBLISH_DIR; rmSync(state, { recursive: true, force: true }); await closeBrowser(); });

const NOW = Date.parse('2026-10-30T00:00:00Z');
let n = 0;
/** A sent post `ago` days before `at`, with Buffer's names for its numbers (nothing for a post with no results yet). */
const sent = (ago, m = null, o = {}, at = NOW) => ({ id: `p${++n}`, channelId: 'c1', service: 'instagram', status: 'sent', sentAt: new Date(at - ago * DAY).toISOString(), dueAt: new Date(at - ago * DAY).toISOString(), metricsUpdatedAt: new Date(at).toISOString(), text: `Post ${n}`, m: m ?? { reactions: 0, comments: 0, shares: 0, saves: 0, reach: 0, views: 0 }, ...o });
const withNumbers = (reactions, reach = 100, extra = {}) => ({ reactions, comments: 0, shares: 0, saves: 0, reach, views: reach * 2, ...extra });
const pull = (dir, posts, pulledAt = new Date(NOW).toISOString()) => { mkdirSync(join(dir, 'performance'), { recursive: true }); writeFileSync(join(dir, 'performance', 'buffer-posts.json'), JSON.stringify({ schema: 'nordle.bufferposts/0.2', pulledAt, posts })); };
const tmp = () => mkdtempSync(join(state, 'brand-'));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('a brand\'s overview counts this stretch and the one before, sums engagement and reach, and names its best posts against its own usual', () => {
  const dir = tmp();
  pull(dir, [
    sent(1, withNumbers(10)), sent(3, withNumbers(20)), sent(6, withNumbers(30)), sent(10, withNumbers(40)), sent(15, withNumbers(50)), sent(20, withNumbers(200), { service: 'facebook', text: 'The big one' }),
    sent(2),                                              // no results yet: counted as a post, not as one with numbers
    sent(30, withNumbers(5)), sent(35, withNumbers(5)), sent(50, withNumbers(10)),     // the 28 days before
    sent(100, withNumbers(999)),                            // before both: ignored
  ]);
  const o = bufferOverview(dir, { days: 28, now: NOW });
  assert.equal(o.hasPull, true);
  assert.deepEqual([o.now.posts, o.now.withNumbers, o.now.engagement, o.now.audience], [7, 6, 350, 600]);
  assert.deepEqual([o.before.posts, o.before.withNumbers, o.before.engagement, o.before.audience], [3, 3, 20, 300]);
  assert.equal(o.audienceKey, 'reach');
  assert.equal(o.usualEngagement, 58.3, 'average engagement of a post that has results');
  assert.equal(o.top[0].engagement, 200);
  assert.equal(o.top[0].text, 'The big one');
  assert.equal(o.top[0].service, 'facebook');
  assert.equal(o.top[0].lift, 5.7, '200 against this brand\'s median post (35)');
  assert.equal(o.top.length, 3);
  assert.deepEqual(o.channels, [{ service: 'instagram', posts: 6 }, { service: 'facebook', posts: 1 }]);
  assert.equal(o.series.length, 4, 'four weeks for 28 days');
  assert.equal(o.series.reduce((t, s) => t + s.posts, 0), 7, 'every post in the stretch is in exactly one week');
  assert.equal(o.lastPostAt, new Date(NOW - 1 * DAY).toISOString());
});

test('a lift is only given when at least five posts have results, a long caption is cut at a word, and views stand in when there is no reach', () => {
  const dir = tmp();
  pull(dir, [sent(1, { reactions: 4, views: 300 }, { text: 'word '.repeat(60) }), sent(2, { reactions: 1, views: 100 })]);
  const o = bufferOverview(dir, { days: 28, now: NOW });
  assert.equal(o.audienceKey, 'views');
  assert.equal(o.now.audience, 400);
  assert.equal(o.top[0].lift, null, 'two posts are not a usual to compare with');
  assert.match(o.top[0].text, /^(word ){10,}word…$/, 'cut at a word, with an ellipsis');
  assert.ok(o.top[0].text.length <= 141);
  assert.equal(bufferOverview(dir, { days: 7, now: NOW }).series.length, 7, 'one a day for a week');
});

test('a brand that was never read from Buffer says so, and a brand whose pull has no posts has no last post', () => {
  const none = bufferOverview(tmp(), { days: 28, now: NOW });
  assert.equal(none.hasPull, false);
  assert.deepEqual([none.now.posts, none.lastPostAt, none.audienceKey, none.usualEngagement, none.top], [0, null, null, null, []]);
  const dir = tmp(); pull(dir, []);
  const empty = bufferOverview(dir, { days: 28, now: NOW });
  assert.deepEqual([empty.hasPull, empty.now.posts, empty.lastPostAt], [true, 0, null]);
});

/** Posts for the real clock (the server uses it): `ago` days back from now. */
const live = (ago, m, o) => sent(ago, m, o, Date.now());
const livePull = (dir, posts) => pull(dir, posts, new Date().toISOString());

test('the route: every brand, local files only, the window must be 7, 28 or 90 and anything else is 28', async () => {
  await studio(async ({ call, work }) => {
    const { projects } = await overview(call);
    assert.equal(projects.length, 2);
    livePull(join(work, 'projects', projects[0].id), [live(1, withNumbers(10)), live(40, withNumbers(10))]);
    const r = await call('/publish/buffer-overview?days=28');
    assert.equal(r.status, 200);
    assert.equal(r.body.days, 28);
    assert.equal(r.body.brands.length, 2);
    const a = r.body.brands.find((b) => b.project === projects[0].id), b = r.body.brands.find((x) => x.project === projects[1].id);
    assert.deepEqual([a.hasPull, a.now.posts, a.before.posts, a.connected], [true, 1, 1, false]);
    assert.deepEqual([b.hasPull, b.now.posts, b.connected, b.channelCount], [false, 0, false, 0]);
    assert.equal(r.body.autoPull.everyHours, 6, 'what Nordle reads by itself is on the page too');
    assert.equal((await call('/publish/buffer-overview?days=5')).body.days, 28);
    assert.equal((await call('/publish/buffer-overview?days=90')).body.days, 90);
    assert.equal((await call('/publish/buffer-overview', 'POST', {})).status, 405);
  });
});

test('All brands in Insights: one row a brand with posts, audience and engagement against before, what needs a look, and the best posts; no scored-posts tiles', async () => {
  await studioPage(async ({ page, open, call, work }) => {
    const { projects } = await overview(call);
    const [one, two] = projects;
    livePull(join(work, 'projects', one.id), [
      live(1, withNumbers(10)), live(4, withNumbers(20)), live(8, withNumbers(30)), live(12, withNumbers(40)), live(16, withNumbers(50)), live(20, withNumbers(400, 100, { saves: 20 }), { text: 'Our best post this month' }),
      live(32, withNumbers(10, 50)), live(36, withNumbers(10, 50)), live(40, withNumbers(10, 50)), live(44, withNumbers(10, 50)),
    ]);
    const requests = [];
    page.on('request', (r) => { if (r.url().includes('/api/publish/buffer-overview')) requests.push(r.url()); });
    await open(`#/s/insights?today=${TODAY}`);
    await page.waitForSelector('.ov-table tbody tr');
    assert.equal(await page.locator('.ins-figs').count(), 0, 'the posts-scored tiles are not on this screen');
    assert.equal(await page.locator('.ins-brand').count(), 0, 'and neither is one section a brand');
    assert.equal(await page.locator('.ov-table tbody tr').count(), 2);
    const row = page.locator(`#ov-${one.id}`);
    assert.match(await row.locator('td[data-label="Posts sent"]').innerText(), /6[\s\S]*\+2/, '6 posts, 2 more than the 4 before');
    assert.match(await row.locator('td[data-label^="Audience"]').innerText(), /600[\s\S]*reach/);
    assert.ok(await row.locator('td[data-label^="Audience"] .ov-d.up').count(), 'the audience is up on before, and says so');
    assert.match(await row.locator('td[data-label="Engagement"]').innerText(), /570/, 'likes, saves and the rest added up');
    assert.match(await row.locator('td[data-label="Posting"]').innerText(), /Last: (yesterday|today|2 days ago)/);
    assert.equal(await row.locator('.ov-spark i').count(), 4);
    assert.match(await page.locator(`#ov-${two.id}`).innerText(), /Buffer not connected/);
    const totals = await page.locator('.ov-totals').innerText();
    assert.match(totals, /posts sent[\s\S]*6[\s\S]*reach[\s\S]*600[\s\S]*engagement[\s\S]*570/i);       // the labels are drawn in capitals
    // what needs a look: the brand with nothing from Buffer says so and offers a way in
    await page.waitForSelector('.ov-attn .ov-item');
    assert.match(await page.locator('.ov-attn').innerText(), new RegExp(`${esc(two.name)}[\\s\\S]*no Buffer numbers yet`));
    // the best posts, against each brand's own usual
    const best = await page.locator('.ov-best li').first().innerText();
    assert.match(best, new RegExp(esc(one.name)));
    assert.match(best, /Our best post this month/);
    assert.match(best, /\d+(\.\d)?× this brand’s usual engagement/);
    // Open takes you to that brand's own page
    await row.locator('[data-act="ov-open"]').click();
    await page.waitForSelector('.ins-brand');
    assert.equal(await page.locator('.ov-table').count(), 0);
    await page.click('.rb:has-text("All brands")');
    await page.waitForSelector('.ov-table tbody tr');
    // the window changes what is asked for
    await page.click('.f-seg button[data-days="7"]');
    await page.waitForFunction(() => document.querySelector('.f-seg button[data-days="7"]').getAttribute('aria-checked') === 'true');
    await page.waitForFunction(() => /last 7 days/.test(document.querySelector('.ov-table caption')?.textContent ?? ''));
    assert.ok(requests.some((u) => u.includes('days=7')), 'the 7 day view asked for 7 days');
    // nothing is connected here, so Update all says so in words and asks Buffer for nothing
    await page.click('[data-act="ov-update"]');
    await page.waitForSelector('.notice:has-text("No brand has Buffer connected")');
    // a narrow window turns the table into one card a brand, with no sideways scroll
    await page.setViewportSize({ width: 760, height: 900 });
    assert.equal(await row.evaluate((el) => getComputedStyle(el).display), 'grid');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'the page does not scroll sideways');
  });
});

test('a change is only said when both stretches have results for most of their posts, so a fall that never happened is not shown', async () => {
  await studioPage(async ({ page, open, call, work }) => {
    const { projects } = await overview(call);
    const [one] = projects;
    livePull(join(work, 'projects', one.id), [
      live(1, withNumbers(10)), live(4, withNumbers(10)), live(8, withNumbers(10)), live(12, withNumbers(10)),
      live(32, withNumbers(100)), live(36), live(40), live(44), live(48),       // before: one post in five has results
    ]);
    await open(`#/s/insights?today=${TODAY}`);
    await page.waitForSelector('.ov-table tbody tr');
    const row = page.locator(`#ov-${one.id}`);
    assert.match(await row.locator('td[data-label="Posts sent"]').innerText(), /4[\s\S]*−1/, 'the number of posts is always comparable');
    assert.equal(await row.locator('td[data-label^="Audience"] .ov-d').count(), 0, 'no audience change from a stretch with results for 1 post in 5');
    assert.equal(await row.locator('td[data-label="Engagement"] .ov-d').count(), 0);
    assert.equal(await page.locator('.ov-totals .ov-d').count(), 1, 'only the post count has a change in the totals');
  });
});
