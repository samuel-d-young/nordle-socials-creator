// Campaigns: a named push with a goal, dates, one message and one call to action. Posts are made for it first and scheduled later: they sit on the calendar as ideas,
// tied to the campaign, and nothing is sent anywhere. Claude can tag its own ideas with a campaign too.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newCalendar, loadCalendar, saveCalendar } from '../src/calendar/model.mjs';
import * as S from '../src/calendar/service.mjs';
import { suggestForCampaign } from '../src/calendar/suggest-campaign.mjs';
import { AGENT, closeBrowser } from './helpers.mjs';
import { studio, studioPage, TODAY } from './studio-helpers.mjs';

const base = mkdtempSync(join(tmpdir(), 'nordle-camp-'));
before(() => { process.env.NORDLE_TODAY = '2026-10-05'; });
after(async () => { await closeBrowser(); rmSync(base, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }); delete process.env.NORDLE_TODAY; });

const BRAND = { schema: 'nordle.brand/0.1', id: 'x', name: 'Harbour Bakery', colors: { ink: '#111111', paper: '#ffffff' }, fonts: { display: { family: 'Inter', weights: [400], source: 'google' } }, voice: { tone: ['warm'], bannedPhrases: [] } };
let n = 0;
function project() {
  const id = `cp-${++n}`;
  const dir = join(base, id);
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'brand.json'), JSON.stringify({ ...BRAND, id }));
  writeFileSync(join(dir, 'facts.json'), JSON.stringify({ staff: [{ name: 'Ana Costa', title: 'Head baker', source: 'website' }] }));
  saveCalendar(dir, newCalendar(id));
  return dir;
}

test('a campaign is made, changed and removed; its posts stay on the calendar when it goes', async () => {
  const dir = project();
  const { campaign } = await S.addCampaign(dir, { name: 'Spring Open Day', goal: 'Fill the open day', start: '2026-11-02', end: '2026-11-20', message: 'Come and see how we work', cta: 'Book a place' });
  assert.equal(campaign.id, 'spring-open-day');
  assert.equal((await S.addCampaign(dir, { name: 'Spring Open Day' })).campaign.id, 'spring-open-day-2', 'a second one with the same name gets its own id');
  await assert.rejects(S.addCampaign(dir, { name: '  ' }), /name/);
  await assert.rejects(S.addCampaign(dir, { name: 'Backwards', start: '2026-11-20', end: '2026-11-02' }), /end is before the start/);
  await assert.rejects(S.addCampaign(dir, { name: 'Bad date', start: '2026-02-31' }), /real date/);
  const changed = await S.updateCampaign(dir, 'spring-open-day', { cta: 'Reserve a spot', notes: null });
  assert.equal(changed.campaign.cta, 'Reserve a spot');
  await assert.rejects(S.updateCampaign(dir, 'nope', { name: 'x' }), /No such campaign/);

  const added = await S.addItems(dir, [{ date: '2026-11-04', format: 'reel', title: 'It starts now', idea: 'Announce the open day', hook: 'Open day.', campaign: 'spring-open-day' }], { role: 'human' });
  assert.equal(added.added[0].campaign, 'spring-open-day');
  const bad = await S.addItems(dir, [{ date: '2026-11-05', format: 'post', title: 'Elsewhere', idea: 'x', hook: 'x', campaign: 'no-such-campaign' }], { role: 'human' });
  assert.equal(bad.added.length, 0);
  assert.match(bad.rejected[0].errors[0].message, /no campaign/);
  assert.equal((await S.removeCampaign(dir, 'spring-open-day')).detached, 1);
  const cal = loadCalendar(dir);
  assert.equal(cal.items.length, 1, 'the post is still there');
  assert.equal(cal.items[0].campaign, undefined, 'but no longer tied to the campaign');
  assert.ok(!(cal.campaigns ?? []).some((c) => c.id === 'spring-open-day'));
});

test('options for a campaign fall inside its dates, open it and close it, carry its id, and add up to what was asked', async () => {
  const dir = project();
  await S.addCampaign(dir, { name: 'Spring Open Day', goal: 'Fill the open day', start: '2026-11-02', end: '2026-11-20', message: 'Come and see how we work', cta: 'Book a place' });
  const r = suggestForCampaign(dir, { campaign: 'spring-open-day', today: '2026-10-05', decide: true });
  assert.ok(r.options.length >= 5, `enough options: ${r.options.length}`);
  for (const o of r.options) {
    assert.equal(o.campaign, 'spring-open-day');
    assert.ok(o.date >= '2026-11-02' && o.date <= '2026-11-20', `${o.date} is inside the window`);
    assert.ok(![0, 6].includes(new Date(`${o.date}T00:00:00Z`).getUTCDay()), `${o.date} is a weekday`);
  }
  assert.match(r.options[0].title, /it starts now/i);
  assert.match(r.options.at(-1).title, /final days/i);
  assert.match(r.request, /The campaign: Spring Open Day/);
  assert.match(r.request, /campaign: "spring-open-day"/);
  assert.match(r.request, /scheduled later/);
  const six = suggestForCampaign(dir, { campaign: 'spring-open-day', today: '2026-10-05', count: 6, formats: ['reel'] });
  assert.equal(six.options.length, 6);
  assert.ok(six.options.every((o) => o.format === 'reel'));
  assert.throws(() => suggestForCampaign(dir, { campaign: 'nope' }), /No such campaign/);
});

test('the routes: only the owner makes, changes or removes a campaign; the suggest route answers for one', async () => {
  await studio(async ({ call }) => {
    const p = (await call('/projects')).body;
    const project = (p.projects ?? p)[0].id;
    const base = `/projects/${project}/calendar`;
    assert.equal((await call(`${base}/campaigns`, 'POST', { name: 'X' }, AGENT)).status, 403, 'Claude does not make campaigns');
    const made = await call(`${base}/campaigns`, 'POST', { name: 'Autumn Sale', goal: 'Clear the shelves', start: '2026-11-09', end: '2026-11-27', cta: 'Visit us' });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const id = made.body.campaign.id;
    assert.equal((await call(`${base}/campaigns`, 'POST', { name: '' })).status, 400);
    assert.equal((await call(`${base}/campaigns/${id}`, 'POST', { message: 'Everything must go' })).body.campaign.message, 'Everything must go');
    const s = await call(`${base}/suggest?campaign=${id}&decide=1`, 'GET', undefined, AGENT);
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.ok(s.body.options.length >= 3 && s.body.options.every((o) => o.campaign === id));
    assert.equal((await call(`${base}/suggest?campaign=nope`)).status, 404);
    assert.equal((await call(`${base}/campaigns/${id}/remove`, 'POST', {}, AGENT)).status, 403);
    assert.equal((await call(`${base}/campaigns/${id}/remove`, 'POST', {})).status, 200);
  });
});

test('Claude can tag an idea it proposes with the campaign; an unknown campaign is refused in plain words', async () => {
  const dir = project();
  await S.addCampaign(dir, { name: 'Spring Open Day', start: '2026-11-02', end: '2026-11-20' });
  const ok = await S.addItems(dir, [{ date: '2026-11-10', format: 'carousel', title: 'What to know about open day', idea: 'The practical details, from facts only', hook: 'What to know.', campaign: 'spring-open-day' }], { role: 'agent', today: '2026-10-05' });
  assert.equal(ok.added[0]?.campaign, 'spring-open-day', JSON.stringify(ok.rejected));
  assert.equal(ok.added[0].status, 'idea', 'Claude\'s ideas wait for the owner');
  const no = await S.addItems(dir, [{ date: '2026-11-11', format: 'post', title: 'Another', idea: 'x', hook: 'x', campaign: 'made-up' }], { role: 'agent', today: '2026-10-05' });
  assert.equal(no.added.length, 0);
});

test('the Create page: make a campaign, see its options, add them as ideas to schedule later; they carry the campaign and nothing is scheduled', async () => {
  await studioPage(async ({ page, open, call }) => {
    await open(`#/s/create?today=${TODAY}&mode=advanced`);
    await page.waitForSelector('[data-act="camp-new"]');
    await page.locator('[data-act="camp-new"]').click();
    await page.waitForSelector('[data-section="new-campaign"]');
    await page.fill('[data-field="camp-name"]', 'Open House Week');
    await page.fill('[data-field="camp-goal"]', 'Introduce the new team');
    await page.fill('[data-field="camp-start"]', '2026-11-09');
    await page.fill('[data-field="camp-end"]', '2026-11-27');
    await page.fill('[data-field="camp-cta"]', 'Book a visit');
    await page.locator('[data-act="camp-save"]').click();
    await page.waitForSelector('.cr-camp-note');
    assert.match(await page.locator('.cr-camp-note').innerText(), /Introduce the new team/);
    assert.equal(await page.locator('[aria-label="Month"]').count(), 0, 'a campaign has its own dates, so the month and style rows go');
    await page.locator('[data-act="create-suggest"]').click();
    await page.waitForSelector('[data-state="options"] .cr-opt');
    const found = await page.locator('.cr-opt').count();
    assert.ok(found >= 3, `options for the campaign: ${found}`);
    assert.match(await page.locator('.cr-opt .cr-style').first().innerText(), /Campaign/i);
    await page.locator('[data-act="create-add-ideas"]').click();
    await page.waitForSelector('.cr-added');
    const brand = (await call('/projects')).body;
    let tagged = [];
    for (const pr of brand.projects ?? brand) {
      const cal = (await call(`/projects/${pr.id}/calendar?from=2026-11-01&to=2026-11-30`)).body.calendar;
      tagged = tagged.concat((cal.items ?? []).filter((i) => i.campaign === 'open-house-week'));
    }
    assert.equal(tagged.length, found, 'every ticked option is on the calendar for the campaign');
    assert.ok(tagged.every((i) => i.status === 'idea'), 'as ideas: nothing is approved or scheduled yet');
    assert.match(await page.locator('.cr-added').innerText(), /added as ideas/);
  });
});
