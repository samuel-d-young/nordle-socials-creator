// The Create page: options worked out from a brand's own facts, the occasions, the month's mix and (once results exist) what did well;
// the route that serves them; and the page itself (choose, tick, add to the calendar).
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newCalendar, saveCalendar } from '../src/calendar/model.mjs';
import { upsertEntries } from '../src/performance/model.mjs';
import { learnFrom, suggestOptions } from '../src/calendar/suggest.mjs';
import { AGENT, closeBrowser } from './helpers.mjs';
import { studio, studioPage, TODAY } from './studio-helpers.mjs';

const base = mkdtempSync(join(tmpdir(), 'nordle-suggest-'));
before(() => { process.env.NORDLE_TODAY = '2026-10-05'; });
after(async () => { await closeBrowser(); rmSync(base, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }); delete process.env.NORDLE_TODAY; });

const BRAND = { schema: 'nordle.brand/0.1', id: 'x', name: 'Harbour Bakery', colors: { ink: '#111111', paper: '#ffffff' }, fonts: { display: { family: 'Inter', weights: [400], source: 'google' } }, voice: { tone: ['warm'], bannedPhrases: [] } };
const FACTS = { staff: [{ name: 'Ana Costa', title: 'Head baker', source: 'website' }, { name: 'Ben Lee', title: 'Manager', source: 'website' }], services: ['Sourdough classes', 'Wedding cakes'] };
let n = 0;
function project({ facts = FACTS, items = [], pillars } = {}) {
  const id = `bk-${++n}`;
  const dir = join(base, id);
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'brand.json'), JSON.stringify({ ...BRAND, id }));
  if (facts) writeFileSync(join(dir, 'facts.json'), JSON.stringify(facts));
  saveCalendar(dir, { ...newCalendar(id), items, ...(pillars ? { settings: { pillars } } : {}) });
  return dir;
}

test('options are built from the brand\'s own facts: the team and the services become real titles, with dates, formats and a reason', () => {
  const r = suggestOptions(project(), { today: '2026-10-05' });
  assert.equal(r.month, '2026-11');
  assert.ok(r.options.length >= 8, `enough options: ${r.options.length}`);
  const titles = r.options.map((o) => o.title);
  assert.ok(titles.some((t) => /Ana Costa|Ben Lee/.test(t)), `a team post by name: ${titles}`);
  assert.ok(titles.some((t) => /Sourdough classes|Wedding cakes/.test(t)), `a service post by name: ${titles}`);
  for (const o of r.options) {
    assert.match(o.date, /^2026-11-\d\d$/);
    assert.ok(['reel', 'carousel', 'post', 'story'].includes(o.format));
    assert.ok(o.title && o.idea && o.why, 'title, idea and why are all there');
  }
  assert.equal(new Set(r.options.map((o) => o.title)).size, r.options.length, 'no title twice');
  assert.ok(r.options.every((o, i, a) => i === 0 || a[i - 1].date <= o.date), 'in date order');
  assert.match(r.request, /Plan the next posts/);
  assert.match(r.request, /What the owner asked for on the Create page/);
  assert.match(r.request, /Meet Ana Costa/, 'the starting points travel with the request to Claude');
});

test('how many, which kinds, which styles: each choice is honoured, and "decide for me" fills what the month is missing', () => {
  const dir = project();
  const five = suggestOptions(dir, { today: '2026-10-05', count: 5, formats: ['reel'] });
  assert.equal(five.options.length, 5);
  assert.ok(five.options.every((o) => o.format === 'reel'));
  const teamOnly = suggestOptions(dir, { today: '2026-10-05', count: 3, styles: ['team'] });
  assert.ok(teamOnly.options.every((o) => o.style === 'team'));
  const decided = suggestOptions(dir, { today: '2026-10-05', decide: true });
  assert.equal(decided.decided, true);
  assert.equal(decided.count, 13, 'the default monthly mix is 8 reels, 3 carousels and 2 posts');
  const asked = suggestOptions(dir, { today: '2026-10-05', count: 40 });
  assert.equal(asked.count, 30, 'never more than 30 at a time');
});

test('what is already on the calendar is not suggested again, and a month that is short says so in words', () => {
  const dir = project({ items: [{ id: 'a', date: '2026-11-04', format: 'reel', title: 'Meet Ana Costa', idea: 'Meet Ana Costa the head baker', status: 'approved' }] });
  const r = suggestOptions(dir, { today: '2026-10-05', count: 6 });
  assert.ok(!r.options.some((o) => o.title === 'Meet Ana Costa'));
  const bare = suggestOptions(project({ facts: null }), { today: '2026-10-05', count: 25, styles: ['team'] });
  assert.ok(bare.options.length < 25 && /Only \d+ of the 25/.test(bare.short), String(bare.short));
});

test('results connected: with too few measured posts it says what is needed; learnFrom needs real numbers, not guesses', () => {
  const dir = project();
  const l = learnFrom(dir, { today: '2026-10-05' });
  assert.equal(l.connected, false);
  assert.ok(l.needed >= 5);
  const r = suggestOptions(dir, { today: '2026-10-05' });
  assert.equal(r.learned.connected, false);
  assert.equal(r.learnedLine, null);
  assert.equal(suggestOptions(dir, { today: '2026-10-05', learn: false }).learned, null);
});

test('results connected: the format that did best leans the mix toward it, the line says so in numbers, and the request tells Claude what worked', async () => {
  const items = [];
  const metrics = [];
  for (let i = 0; i < 12; i++) {
    const carousel = i % 2 === 0;
    const id = `p${String(i + 1).padStart(2, '0')}`;
    items.push({ id, date: `2026-09-${String(i + 2).padStart(2, '0')}`, format: carousel ? 'carousel' : 'reel', title: `${carousel ? 'Carousel' : 'Reel'} ${i + 1}`, idea: 'x', status: 'posted', pillar: 'educate' });
    metrics.push({ post: id, platform: 'instagram', window: '7d', capturedAt: '2026-10-05', metrics: carousel ? { reach: 4000 + i * 50, plays: 0, likes: 400 + i, comments: 30, shares: 40, saves: 120 } : { reach: 500 + i * 20, plays: 800, likes: 20 + i, comments: 2, shares: 1, saves: 3 } });
  }
  const dir = project({ items, pillars: [{ id: 'educate', name: 'Educate', share: 1 }] });
  await upsertEntries(dir, metrics, { role: 'human', today: '2026-10-05' });
  const l = learnFrom(dir, { today: '2026-10-05' });
  assert.equal(l.connected, true, JSON.stringify(l));
  assert.equal(l.format.key, 'carousel');
  assert.ok(l.format.ratio >= 1.25, `carousels engage a bigger share of the people they reach: ${JSON.stringify(l.format)}`);
  assert.equal(l.top.length, 3);
  const r = suggestOptions(dir, { today: '2026-10-05', decide: true });
  assert.ok((r.want.carousel ?? 0) > 3, `the mix leans toward carousels: ${JSON.stringify(r.want)}`);
  assert.match(r.learnedLine, /carousel \(format\): [\d.]+% of the people reached engaged, against [\d.]+% for the rest/);
  assert.match(r.request, /What worked \(their own results/);
  assert.match(r.request, /top post: "Carousel/);
  assert.equal(suggestOptions(dir, { today: '2026-10-05', formats: ['reel'], count: 4 }).want.reel, 4, 'but a choice the owner makes always wins');
});

test('the route: anyone with a token can ask; a bad month is refused; the answer carries options and a request for Claude', async () => {
  await studio(async ({ call }) => {
    const projects = (await call('/projects')).body;
    const id = (projects.projects ?? projects)[0].id;
    const ok = await call(`/projects/${id}/calendar/suggest?count=4&formats=reel,carousel&styles=team,educate`);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.options.length <= 4, true);
    assert.ok(ok.body.request.length > 500);
    assert.equal((await call(`/projects/${id}/calendar/suggest?month=nope`)).status, 400);
    assert.equal((await call(`/projects/${id}/calendar/suggest?count=3`, 'GET', undefined, AGENT)).status, 200, 'Claude may read the same options');
  });
});

test('the Create page: choose, see options, tick some, add them to the calendar approved or as ideas; "Decide for me" is on first', async () => {
  await studioPage(async ({ page, open, call }) => {
    await open(`#/s/create?today=${TODAY}`);
    await page.waitForSelector('[data-act="create-suggest"]');
    assert.equal(await page.locator('[data-act="create-decide"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('[data-act="create-mix"]').getAttribute('aria-pressed'), 'true');
    await page.locator('[data-count="4"]').click();
    assert.equal(await page.locator('[data-act="create-decide"]').getAttribute('aria-pressed'), 'false');
    await page.locator('[data-format="reel"]').click();
    await page.locator('[data-style="team"]').click();
    await page.locator('[data-act="create-suggest"]').click();
    await page.waitForSelector('[data-state="options"] .cr-opt');
    const found = await page.locator('.cr-opt').count();
    assert.ok(found >= 1 && found <= 4, `up to four options: ${found}`);
    assert.equal(await page.locator('[data-field="create-pick"]:checked').count(), found, 'all are ticked at first');
    await page.locator('[data-act="create-none"]').click();
    assert.equal(await page.locator('[data-act="create-add"]').isDisabled(), true, 'nothing ticked, nothing to add');
    await page.locator('[data-field="create-pick"]').first().check();
    const title = await page.locator('.cr-opt .cr-title').first().textContent();
    await page.locator('[data-act="create-add-ideas"]').click();
    await page.waitForSelector('.cr-added');
    const brand = (await page.evaluate(() => document.querySelector('.cr-head h2').textContent)).replace('For ', '');
    const projects = (await call('/projects')).body;
    let landed = null;
    for (const p of projects.projects ?? projects) {
      const cal = (await call(`/projects/${p.id}/calendar?from=2026-11-01&to=2026-11-30`)).body;
      const hit = cal.calendar.items.find((i) => i.title === title);
      if (hit) landed = hit;
    }
    assert.ok(landed, `"${title}" for ${brand} is on the calendar`);
    assert.equal(landed.status, 'idea', 'added as an idea to look at');
    assert.match(await page.locator('.cr-added').textContent(), /added as ideas/);
  });
});
