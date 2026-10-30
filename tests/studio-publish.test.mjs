// Scheduling from the Studio. Nothing is ever sent: the adapter list is faked in the page, Buffer's plan and run are faked, and the
// only real run is the export-folder adapter, which writes files inside the temporary fictional project.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { closeBrowser } from './helpers.mjs';
import { mutateCalendar } from '../src/calendar/service.mjs';
import { studioPage, overview, firstWhere, verifiedBuilt, TODAY } from './studio-helpers.mjs';

after(closeBrowser);

/** Tick a card on the wall. (Cards far down the page are not drawn until they are scrolled to.) */
const pick = async (page, uid) => {
  const box = page.locator(`.wc[data-uid="${uid}"] input[type=checkbox]`);
  await box.scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  await box.evaluate((el) => el.click());      // ticks it without depending on what sits over the box (a tile redrawing under a pointer click lost the tick on slow runners)
};

const BUNDLE = { id: 'bundle', name: 'Export folder', configured: true, needs: [], channels: [], note: 'Writes the pictures, captions and a schedule file to a folder.', selected: {}, options: {} };
const buffer = (over = {}) => ({ id: 'buffer', name: 'Buffer', configured: false, needs: ['an API key'], channels: [], note: 'Schedules in Buffer.', selected: {}, options: {}, ...over });

/** Never let a page reach the real publishing settings: the adapter list comes from here. */
async function fakeAdapters(page, adapters, extra = async () => false) {
  await page.route('**/api/publish/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/adapters')) return route.fulfill({ json: { adapters: typeof adapters === 'function' ? adapters() : adapters } });
    if (await extra(route, url)) return undefined;
    return route.continue();
  });
}

test('the Schedule button, a plan with what blocks each post, and the plain words when Buffer is not connected', async () => {
  await studioPage(async ({ page, open, call }) => {
    await fakeAdapters(page, [buffer(), BUNDLE]);
    const { posts } = await overview(call);
    const good = firstWhere(posts, (p) => verifiedBuilt(p) && p.date >= '2026-11-01');
    await call('/studio/act', 'POST', { uid: good.uid, action: 'approve' });
    const built = firstWhere(posts, (p) => p.status === 'built' && p.uid !== good.uid && p.verified === false);
    await open(`#/s/wall?today=${TODAY}`);
    await pick(page, good.uid);
    await pick(page, built.uid);
    await page.waitForSelector('.selbar:not(.hidden) [data-act="schedule"]');
    await page.waitForSelector('.selbar:not(.hidden) [data-act="schedule"]');
    await page.click('.selbar [data-act="schedule"]');
    await page.waitForSelector('dialog.wide .sch-dest');
    // Buffer is not set up: say so, and offer the always-working export folder
    await page.locator('.sch-opt:has-text("Buffer") input').check();
    await page.waitForSelector('.sch-note.warn:has-text("not connected")');
    assert.equal(await page.locator('[data-act="schedule-run"]').isDisabled(), true);
    await page.click('.sch-note-acts button:has-text("export folder")');
    await page.waitForSelector('.sch-row[data-uid]');
    assert.equal(await page.locator('.sch-opt.on').innerText().then((t) => /Export folder/.test(t)), true);
    // the real plan: the signed-off post is ready, the other is blocked and says why
    await page.waitForSelector(`.sch-row[data-uid="${good.uid}"] .st-stamp`);
    assert.match(await page.locator(`.sch-row[data-uid="${good.uid}"]`).innerText(), /Ready/);
    const blocked = page.locator(`.sch-row[data-uid="${built.uid}"]`);
    assert.match(await blocked.innerText(), /Blocked/);
    assert.ok(await blocked.locator('.sch-block').count() > 0, 'the plan says why');
    assert.match(await page.locator('.sch-sum').innerText(), /Export 1 post to a folder\. Nothing is sent until you press the button/);
  });
});

test('Buffer without a media web address says plainly that it cannot take files, and offers the export folder', async () => {
  await studioPage(async ({ page, open, call }) => {
    await fakeAdapters(page, [buffer({ configured: true, needs: [], channels: [{ id: 'c1', name: 'The shop', service: 'instagram' }], options: {} }), BUNDLE]);
    const { posts } = await overview(call);
    const good = firstWhere(posts, (p) => verifiedBuilt(p) && p.date >= '2026-11-01');
    await call('/studio/act', 'POST', { uid: good.uid, action: 'approve' });
    await open(`#/s/wall?today=${TODAY}`);
    await pick(page, good.uid);
    await page.waitForSelector('.selbar:not(.hidden) [data-act="schedule"]');
    await page.click('.selbar [data-act="schedule"]');
    await page.waitForSelector('dialog.wide .sch-dest');
    await page.locator('.sch-opt:has-text("Buffer") input').check();
    await page.waitForSelector('.sch-note.warn:has-text("public web address")');
    assert.match(await page.locator('.sch-note.warn').innerText(), /somewhere public to read your pictures and videos/i);
    assert.equal(await page.locator('[data-act="schedule-run"]').isDisabled(), true, 'nothing can be sent to Buffer without the address');
    assert.ok(await page.locator('.sch-note-acts button:has-text("export folder")').count() > 0);
  });
});

test('a Buffer plan (faked) shows channel and time, can include a not-yet-signed-off post on request, and sends exactly what was ticked', async () => {
  await studioPage(async ({ page, open, call }) => {
    const sent = [];
    const { posts } = await overview(call);
    const a = firstWhere(posts, (p) => verifiedBuilt(p) && p.date >= '2026-11-01');
    const b = posts.filter((p) => p.status === 'built' && p.uid !== a.uid)[0];
    const plan = {
      planId: 'plan-fake-1', adapter: 'buffer', expires: new Date(Date.now() + 900000).toISOString(),
      items: [
        { uid: a.uid, project: a.project, docId: a.docId, title: a.title, when: '2026-11-12T07:30:00Z', whenLocal: '2026-11-12 18:30', channel: 'c1', channelName: 'The shop (instagram)', caption: 'Caption for the first post.', media: ['out/a.png'], blockers: [], warnings: ['The caption is long.'], ready: true, overridable: false, format: 'carousel', status: 'signed-off', adapter: 'buffer' },
        { uid: b.uid, project: b.project, docId: b.docId, title: b.title, when: '2026-11-13T07:30:00Z', whenLocal: '2026-11-13 18:30', channel: 'c1', channelName: 'The shop (instagram)', caption: 'Caption for the second.', media: ['out/b.png', 'out/c.png'], blockers: ['Not signed off yet'], warnings: [], ready: false, overridable: true, format: 'carousel', status: 'built', adapter: 'buffer' },
      ],
      summary: { ready: 1, blocked: 1 },
    };
    await fakeAdapters(page, [buffer({ configured: true, needs: [], channels: [{ id: 'c1', name: 'The shop', service: 'instagram' }], options: { mediaBaseUrl: 'https://media.example.test/nordle' }, selected: { [a.project]: 'c1' } }), BUNDLE], async (route, url) => {
      if (url.pathname.endsWith('/plan')) { await route.fulfill({ json: plan }); return true; }
      if (url.pathname.endsWith('/run')) {
        sent.push(route.request().postDataJSON());
        await route.fulfill({ json: { results: [{ uid: a.uid, ok: true, message: 'Scheduled in Buffer.', scheduledAt: plan.items[0].when }, { uid: b.uid, ok: false, message: 'Buffer said no.' }] } });
        return true;
      }
      return false;
    });
    await open(`#/s/wall?today=${TODAY}`);
    await pick(page, a.uid);
    await pick(page, b.uid);
    await page.waitForSelector('.selbar:not(.hidden) [data-act="schedule"]');
    await page.click('.selbar [data-act="schedule"]');
    await page.waitForSelector('.sch-row[data-uid]');
    assert.match(await page.locator('.sch-opt.on').innerText(), /Buffer/, 'a connected Buffer with an address is the default');
    const rowA = await page.locator(`.sch-row[data-uid="${a.uid}"]`).innerText();
    // the time is said once, in the row of choices (the planned chip); the account line only has its name and "Ready"
    assert.ok(rowA.includes('2026-11-12 18:30') && rowA.includes('The shop (instagram)') && /Ready/.test(rowA));
    assert.match(await page.locator('.sch-sum').innerText(), /Schedule 1 post to Buffer\. Nothing is sent until you press the button\. 1 post left out/);
    await page.locator(`.sch-row[data-uid="${b.uid}"] .sch-over input`).check();
    await page.waitForFunction(() => /Schedule 2 posts to Buffer/.test(document.querySelector('.sch-sum').textContent));
    assert.equal(sent.length, 0, 'nothing sent yet');
    await page.click('[data-act="schedule-run"]');
    await page.waitForSelector('.sch-results');
    assert.deepEqual(sent[0], { planId: 'plan-fake-1', only: [a.uid, b.uid], override: { [b.uid]: true } });
    assert.match(await page.locator('.sch-results').innerText(), /Scheduled in Buffer\.[\s\S]*Buffer said no\./);
    assert.equal(sent.length, 1);
  });
});

test('the Schedule dialog can post as soon as possible or at a picked time (for this run only), and can re-run the checks first', async () => {
  await studioPage(async ({ page, open, call }) => {
    const plans = [], checks = [];
    const { posts } = await overview(call);
    const a = firstWhere(posts, (p) => verifiedBuilt(p) && p.date >= '2026-11-01');
    const item = (when, whenLocal) => ({ uid: a.uid, project: a.project, docId: a.docId, title: a.title, when, whenLocal, channel: 'c1', channelName: 'The shop (instagram)', caption: 'Caption.', media: ['out/a.png'], blockers: [], warnings: [], ready: true, overridable: false, format: 'carousel', status: 'signed-off', adapter: 'buffer' });
    await fakeAdapters(page, [buffer({ configured: true, needs: [], channels: [{ id: 'c1', name: 'The shop', service: 'instagram' }], options: { mediaBaseUrl: 'https://media.example.test/nordle' }, selected: { [a.project]: 'c1' } }), BUNDLE], async (route, url) => {
      if (url.pathname.endsWith('/plan')) {
        const b = route.request().postDataJSON();
        plans.push(b);
        const t = b.times?.[a.uid];
        await route.fulfill({ json: { planId: `plan-${plans.length}`, adapter: 'buffer', expires: new Date(Date.now() + 900000).toISOString(), items: [t === 'now' ? item('2099-01-01T00:11:00Z', 'soon') : t ? item(t, 'picked') : item('2099-11-12T07:30:00Z', 'planned')], summary: { ready: 1, blocked: 0 } } });
        return true;
      }
      return false;
    });
    await page.route('**/api/projects/*/checks/*', async (route) => {
      checks.push(new URL(route.request().url()).pathname);
      await route.fulfill({ json: { doc: a.docId, version: 1, ok: true, counts: {}, checks: [], gate: {} } });
    });
    await open(`#/s/wall?today=${TODAY}`);
    await pick(page, a.uid);
    await page.waitForSelector('.selbar:not(.hidden) [data-act="schedule"]');
    await page.click('.selbar [data-act="schedule"]');
    await page.waitForSelector('.sch-row[data-uid]');
    assert.equal(plans.at(-1).times, undefined, 'the planned time is the default: nothing is overridden');
    assert.match(await page.locator('.sch-row').innerText(), /planned/);
    await page.click('[data-act="time-now"]');
    await page.waitForFunction(() => /Planned · soon/.test(document.querySelector('.sch-row')?.textContent ?? ''));
    assert.deepEqual(plans.at(-1).times, { [a.uid]: 'now' });
    assert.match(await page.locator('[data-act="time-now"]').getAttribute('title'), /10 minutes/, 'the explanation is a tooltip, not a paragraph');
    assert.equal(await page.locator('.tchip.on').count(), 1, 'one choice is lit');
    await page.click('[data-act="time-custom"]');
    await page.waitForSelector(`[data-field="time-day-${a.uid}"]`);
    await page.fill(`[data-field="time-day-${a.uid}"]`, '2099-12-24');
    await page.fill(`[data-field="time-at-${a.uid}"]`, '18:30');
    await page.waitForFunction(() => /Planned · picked/.test(document.querySelector('.sch-row')?.textContent ?? ''));
    assert.equal(plans.at(-1).times[a.uid], new Date('2099-12-24T18:30').toISOString(), 'the picked time goes to the plan as a full time');
    await page.click('[data-act="time-planned"]');
    await page.waitForFunction(() => /Planned · planned/.test(document.querySelector('.sch-row')?.textContent ?? ''));
    assert.equal(plans.at(-1).times, undefined, 'back to the calendar time');
    const before = plans.length;
    await page.click('[data-act="schedule-recheck"]');
    await page.waitForFunction(() => /Checked 1 post: none failing/.test(document.querySelector('.sch-tools')?.textContent ?? ''));
    assert.deepEqual(checks, [`/api/projects/${a.project}/checks/${a.docId}`], 'the automatic checks ran for the post');
    assert.ok(plans.length > before, 'the plan was made again after the checks');
  });
});

test('the Schedule dialog can also make a Story of a post: one tick, a Story line under each channel, and the run sends both', async () => {
  await studioPage(async ({ page, open, call }) => {
    const plans = [], runs = [];
    const { posts } = await overview(call);
    const a = firstWhere(posts, (p) => verifiedBuilt(p) && p.date >= '2026-11-01');
    const feed = { uid: a.uid, key: `${a.uid}#c1`, project: a.project, docId: a.docId, title: a.title, when: '2099-11-12T07:30:00Z', whenLocal: 'planned', channel: { id: 'c1', name: 'The shop', service: 'instagram' }, caption: 'Caption.', media: ['out/a.png', 'out/b.png'], blockers: [], blockerCodes: [], warnings: [], ready: true, overridable: false, format: 'carousel', status: 'signed-off', adapter: 'buffer' };
    const story = { ...feed, key: `${a.uid}#c1#story`, variant: 'story', title: `${a.title} (Story)`, caption: '', media: ['out/a.png'], warnings: ['Story: only the first picture goes in the Story'] };
    await fakeAdapters(page, [buffer({ configured: true, needs: [], stories: true, channels: [{ id: 'c1', name: 'The shop', service: 'instagram' }], options: { mediaBaseUrl: 'https://media.example.test/nordle' }, selected: { [a.project]: 'c1' } }), BUNDLE], async (route, url) => {
      if (url.pathname.endsWith('/plan')) {
        const b = route.request().postDataJSON();
        plans.push(b);
        await route.fulfill({ json: { planId: `plan-${plans.length}`, adapter: 'buffer', expires: new Date(Date.now() + 900000).toISOString(), items: b.stories?.includes(a.uid) ? [feed, story] : [feed], summary: { ready: 1, blocked: 0 } } });
        return true;
      }
      if (url.pathname.endsWith('/run')) { runs.push(route.request().postDataJSON()); await route.fulfill({ json: { results: [{ uid: a.uid, key: feed.key, channel: feed.channel, ok: true, message: 'Scheduled in Buffer.' }, { uid: a.uid, key: story.key, channel: feed.channel, ok: true, message: 'Scheduled as a Story in Buffer.' }] } }); return true; }
      return false;
    });
    await open(`#/s/wall?today=${TODAY}`);
    await pick(page, a.uid);
    await page.waitForSelector('.selbar:not(.hidden) [data-act="schedule"]');
    await page.click('.selbar [data-act="schedule"]');
    await page.waitForSelector('.sch-row[data-uid]');
    // a Story goes with every post unless its tick is taken off
    // a Story that is ready is shown as a small "+ Story" tag on its account (a blocked one gets its own line)
    await page.waitForSelector('.sch-plus-story');
    assert.deepEqual(plans.at(-1).stories, [a.uid], 'ticked from the start');
    assert.equal(await page.locator(`[data-field="story-${a.uid}"]`).isChecked(), true);
    await page.uncheck(`[data-field="story-${a.uid}"]`);
    await page.waitForFunction(() => !document.querySelector('.sch-plus-story'));
    assert.equal(plans.at(-1).stories, undefined, 'unticked: no Story');
    await page.check(`[data-field="story-${a.uid}"]`);
    await page.waitForSelector('.sch-plus-story');
    assert.deepEqual(plans.at(-1).stories, [a.uid]);
    assert.match(await page.locator('.sch-acct[data-channel="c1"]').innerText(), /\+ Story[\s\S]*Ready/);
    assert.match(await page.locator('.sch-row .sch-warn').getAttribute('title'), /only the first picture goes in the Story/, 'the note is a tooltip on "1 note"');
    await page.click('[data-act="schedule-run"]');
    await page.waitForFunction(() => !document.querySelector('dialog[open]'), null, { timeout: 15000 });
    assert.deepEqual(runs[0].only, [feed.key, story.key], 'both the post and its Story were sent');
    assert.match(await page.locator('.notice').last().innerText(), /2 posts scheduled/, 'everything went, so the window closed by itself and said so');
  });
});

test('one click schedules a post with its Story from the post sheet; untick Story to leave it out; a blocked or unready post opens the full window instead', async () => {
  await studioPage(async ({ page, open, call }) => {
    const plans = [], runs = [];
    const { posts } = await overview(call);
    const a = firstWhere(posts, (p) => verifiedBuilt(p) && p.date >= '2026-11-01');
    await call('/studio/act', 'POST', { uid: a.uid, action: 'approve' });
    let block = null;
    const base = { uid: a.uid, project: a.project, docId: a.docId, title: a.title, when: '2099-11-12T07:30:00Z', whenLocal: 'Thu 12 Nov 2099, 18:30 (Australia/Melbourne)', channel: { id: 'c1', name: 'The shop', service: 'instagram' }, caption: 'Caption.', media: ['out/a.png'], warnings: [], overridable: false, format: 'carousel', status: 'signed-off', adapter: 'buffer' };
    const item = (over = {}) => ({ ...base, key: `${a.uid}#c1`, ready: !block, blockers: block ? [block.msg] : [], blockerCodes: block ? [block.code] : [], ...over });
    await fakeAdapters(page, [buffer({ configured: true, needs: [], stories: true, channels: [{ id: 'c1', name: 'The shop', service: 'instagram' }], options: { mediaBaseUrl: 'https://media.example.test/nordle' }, selected: { [a.project]: 'c1' } }), BUNDLE], async (route, url) => {
      if (url.pathname.endsWith('/plan')) {
        const b = route.request().postDataJSON();
        plans.push(b);
        const items = [item()];
        if (b.stories?.includes(a.uid)) items.push(item({ key: `${a.uid}#c1#story`, variant: 'story', title: `${a.title} (Story)`, caption: '' }));
        if (b.times?.[a.uid] === 'now') for (const it of items) { it.ready = true; it.blockers = []; it.blockerCodes = []; it.whenLocal = 'in a few minutes'; }
        await route.fulfill({ json: { planId: `plan-${plans.length}`, adapter: 'buffer', expires: new Date(Date.now() + 900000).toISOString(), items, summary: { ready: items.filter((i) => i.ready).length, blocked: items.filter((i) => !i.ready).length } } });
        return true;
      }
      if (url.pathname.endsWith('/run')) { const b = route.request().postDataJSON(); runs.push({ ...b, plan: plans.at(-1) }); await route.fulfill({ json: { results: b.only.map((k) => ({ uid: a.uid, key: k, ok: true, message: 'Scheduled.', channel: base.channel })) } }); return true; }
      return false;
    });
    await open(`#/s/month?today=${TODAY}&post=${encodeURIComponent(a.uid)}&month=${a.date.slice(0, 7)}`);
    await page.waitForSelector('.detail.open [data-act="schedule-one"]');
    await page.waitForFunction(() => /Schedule for Thu 12 Nov, 18:30/.test(document.querySelector('[data-act="schedule-one"]')?.textContent ?? ''));
    assert.equal(await page.locator('.detail [data-field="quick-story"]').isChecked(), true, 'Story is on unless taken off');
    assert.match(await page.locator('.detail [data-act="schedule"]').innerText(), /Options/, 'the full window is still one click away');
    await page.click('.detail [data-act="schedule-one"]');
    await page.waitForSelector('.notice:has-text("Scheduled")');
    assert.deepEqual(runs[0].only, [`${a.uid}#c1`, `${a.uid}#c1#story`], 'the post and its Story, nothing else asked');
    assert.match(await page.locator('.notice').first().innerText(), /on 1 account and 1 Story for Thu 12 Nov, 18:30/);
    assert.equal(await page.locator('dialog[open]').count(), 0, 'no window was needed');
    await page.waitForSelector('.detail.open', { state: 'detached' });
    assert.equal(await page.locator('.detail.open').count(), 0, 'scheduled: the sheet is closed and the calendar is back, ready for the next post');
    // without the Story
    await open(`#/s/month?today=${TODAY}&post=${encodeURIComponent(a.uid)}&month=${a.date.slice(0, 7)}`);
    await page.waitForSelector('.detail.open [data-act="schedule-one"]');
    await page.waitForFunction(() => /Schedule for Thu 12 Nov, 18:30/.test(document.querySelector('[data-act="schedule-one"]')?.textContent ?? ''));
    await page.uncheck('.detail [data-field="quick-story"]');
    await page.waitForTimeout(400);
    await page.click('.detail [data-act="schedule-one"]');
    while (runs.length < 2) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(runs.at(-1).only, [`${a.uid}#c1`], 'unticked: only the post');
    assert.equal(runs.at(-1).plan.stories, undefined, 'and the plan it came from asked for no Story');
    await page.waitForSelector('.detail.open', { state: 'detached' });
    // something blocks it: the full window opens and nothing is sent
    block = { code: 'checks-failing', msg: 'Checks are failing: facts.' };
    const sent = runs.length;
    await open(`#/s/month?today=${TODAY}&post=${encodeURIComponent(a.uid)}&month=${a.date.slice(0, 7)}`);
    await page.waitForSelector('.detail.open [data-act="schedule-one"]');
    await page.click('.detail [data-act="schedule-one"]');
    await page.waitForSelector('dialog.wide .sch-row');
    assert.equal(runs.length, sent, 'a blocked post is never sent from the one-click button');
    assert.match(await page.locator('dialog.wide').innerText(), /Checks are failing/);
  });
});

test('Schedule shows a reel\'s cover and lets you choose one from the best frames, or have Nordle pick the best', async () => {
  await studioPage(async ({ page, open, call }) => {
    const covers = [];
    let cover = { time: null, source: 'pending' };
    const { posts } = await overview(call);
    const reel = firstWhere(posts, (p) => p.format === 'reel' && p.video && p.itemId);
    const item = () => ({ uid: reel.uid, key: `${reel.uid}#c1`, project: reel.project, docId: reel.docId, title: reel.title, when: '2099-11-12T07:30:00Z', whenLocal: 'planned', channel: { id: 'c1', name: 'The shop', service: 'instagram' }, caption: 'Caption.', media: ['out/a.mp4'], blockers: [], blockerCodes: [], warnings: [], ready: true, overridable: false, format: 'reel', status: 'signed-off', adapter: 'buffer', cover });
    await fakeAdapters(page, [buffer({ configured: true, needs: [], channels: [{ id: 'c1', name: 'The shop', service: 'instagram' }], options: { mediaBaseUrl: 'https://media.example.test/nordle' }, selected: { [reel.project]: 'c1' } }), BUNDLE], async (route, url) => {
      if (url.pathname.endsWith('/plan')) { await route.fulfill({ json: { planId: 'p1', adapter: 'buffer', expires: new Date(Date.now() + 900000).toISOString(), items: [item()], summary: { ready: 1, blocked: 0 } } }); return true; }
      return false;
    });
    const dot = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
    await page.route('**/api/studio/cover-candidates**', (route) => route.fulfill({ json: { ok: true, current: null, candidates: [{ time: 8.4, score: 0.9, image: dot }, { time: 3.1, score: 0.7, image: dot }] } }));
    await page.route('**/api/studio/cover', async (route) => {
      const b = route.request().postDataJSON();
      covers.push(b);
      cover = b.auto ? { time: 5.5, source: 'auto' } : { time: b.time, source: 'chosen' };
      await route.fulfill({ json: { ok: true, time: cover.time, cover: 'out/a-cover.jpg', auto: !!b.auto } });
    });
    await open(`#/s/wall?today=${TODAY}`);
    await pick(page, reel.uid);
    await page.waitForSelector('.selbar:not(.hidden) [data-act="schedule"]');
    await page.click('.selbar [data-act="schedule"]');
    await page.waitForSelector('.sch-cover');
    assert.match(await page.locator('.sch-cover').innerText(), /Picked for you when you schedule/);
    // let Nordle pick
    await page.click('[data-act="cover-auto"]');
    await page.waitForFunction(() => /Frame at 0:05\.5, picked for you/.test(document.querySelector('.sch-cover')?.textContent ?? ''));
    assert.deepEqual(covers[0], { uid: reel.uid, auto: true });
    assert.match(await page.locator('.sch-cover').innerText(), /Frame at 0:05\.5, picked for you/);
    // choose one of the best frames
    await page.click('[data-act="cover-choose"]');
    await page.waitForSelector('dialog .cv-pick');
    assert.equal(await page.locator('dialog .cv-pick').count(), 2);
    assert.match(await page.locator('dialog .cv-pick.best').innerText(), /Best · 0:08\.4/);
    await page.locator('dialog .cv-pick').nth(1).click();
    await page.waitForFunction(() => /^Frame at 0:03\.1$/.test((document.querySelector('.sch-cover-say')?.textContent ?? '').trim()));
    assert.deepEqual(covers[1], { uid: reel.uid, time: 3.1 });
  });
});

test('Schedule can check what is still in Buffer, and Reschedule takes a deleted post back so it can go again', async () => {
  await studioPage(async ({ page, open, call }) => {
    const calls = [];
    const { posts } = await overview(call);
    const a = firstWhere(posts, (p) => verifiedBuilt(p) && p.date >= '2026-11-01');
    let taken = false;
    const base = { uid: a.uid, key: `${a.uid}#c1`, project: a.project, docId: a.docId, title: a.title, when: '2099-11-12T07:30:00Z', whenLocal: 'planned', channel: { id: 'c1', name: 'The shop', service: 'instagram' }, caption: 'Caption.', media: ['out/a.png'], warnings: [], overridable: false, format: 'carousel', adapter: 'buffer' };
    const scheduled = { ...base, status: 'scheduled', ready: false, blockers: ['Already scheduled in buffer for 2099-11-12T07:30:00Z.'], blockerCodes: ['already-scheduled'] };
    const free = { ...base, status: 'signed-off', ready: true, blockers: [], blockerCodes: [] };
    await fakeAdapters(page, [buffer({ configured: true, needs: [], channels: [{ id: 'c1', name: 'The shop', service: 'instagram' }], options: { mediaBaseUrl: 'https://media.example.test/nordle' }, selected: { [a.project]: 'c1' } }), BUNDLE], async (route, url) => {
      if (url.pathname.endsWith('/plan')) { await route.fulfill({ json: { planId: 'p1', adapter: 'buffer', expires: new Date(Date.now() + 900000).toISOString(), items: [taken ? free : scheduled], summary: { ready: taken ? 1 : 0, blocked: taken ? 0 : 1 } } }); return true; }
      if (url.pathname.endsWith('/check-scheduled')) { calls.push(['check', route.request().postDataJSON()]); await route.fulfill({ json: { ok: true, requests: 1, rate: {}, results: [{ uid: a.uid, title: a.title, status: 'scheduled', targets: [{ channel: 'c1', remoteId: 'r1', state: 'missing' }], missing: ['c1'] }] } }); return true; }
      if (url.pathname.endsWith('/unschedule')) { calls.push(['unschedule', route.request().postDataJSON()]); taken = true; await route.fulfill({ json: { ok: true, status: 'signed-off', removed: ['c1'] } }); return true; }
      return false;
    });
    await open(`#/s/wall?today=${TODAY}`);
    await pick(page, a.uid);
    await page.waitForSelector('.selbar:not(.hidden) [data-act="schedule"]');
    await page.click('.selbar [data-act="schedule"]');
    await page.waitForSelector('.sch-row[data-uid]');
    assert.equal(await page.locator('[data-act="reschedule"]').count(), 0, 'nothing to reschedule until Buffer has been asked');
    await page.click('[data-act="schedule-remote"]');
    await page.waitForSelector('.sch-remote.gone');
    assert.deepEqual(calls[0], ['check', { uids: [a.uid] }]);
    assert.match(await page.locator('.sch-remote').innerText(), /The shop[\s\S]*not in Buffer any more/);
    assert.match(await page.locator('.sch-tools').innerText(), /1 post no longer in Buffer/);
    await page.click('[data-act="reschedule"]');
    await page.waitForFunction(() => document.querySelector('.sch-row .st-stamp')?.textContent.includes('Ready'));
    assert.deepEqual(calls[1], ['unschedule', { uid: a.uid, channels: ['c1'] }]);
    assert.match(await page.locator('.sch-tools').innerText(), /taken back/);
    assert.equal(await page.locator('[data-act="schedule-run"]').isDisabled(), false, 'it can be scheduled again');
  });
});

test('the export folder really runs (it only writes files in the project) and the posts it exported are listed', async () => {
  await studioPage(async ({ page, open, call, work }) => {
    await fakeAdapters(page, [BUNDLE]);
    const { posts } = await overview(call);
    const good = firstWhere(posts, (p) => verifiedBuilt(p) && p.date >= '2026-11-01');
    await call('/studio/act', 'POST', { uid: good.uid, action: 'approve' });
    await open(`#/s/wall?today=${TODAY}`);
    await pick(page, good.uid);
    await page.waitForSelector('.selbar:not(.hidden) [data-act="schedule"]');
    await page.click('.selbar [data-act="schedule"]');
    await page.waitForSelector(`.sch-row[data-uid="${good.uid}"] .st-stamp`);
    await page.click('[data-act="schedule-run"]');
    await page.waitForSelector('.sch-results li.ok');
    const dir = join(work, 'projects', good.project, 'out', 'publish');
    assert.ok(existsSync(dir), 'the export folder was written');
    assert.ok(readdirSync(dir).some((f) => f.includes(good.docId)), 'one folder per post');
  });
});

test('Connect Buffer: the key goes to the settings call once and is never shown again; the address and a channel per brand are saved', async () => {
  await studioPage(async ({ page, open }) => {
    const calls = [];
    let channels = [];
    await fakeAdapters(page, () => [buffer({ configured: calls.length > 0, channels, options: { mediaBaseUrl: calls.find((c) => c.options)?.options.mediaBaseUrl } }), BUNDLE], async (route, url) => {
      if (url.pathname.endsWith('/settings')) { calls.push(route.request().postDataJSON()); await route.fulfill({ json: { ok: true, configured: true } }); return true; }
      if (url.pathname.endsWith('/test')) { channels = [{ id: 'c1', name: 'The shop', service: 'instagram' }, { id: 'c2', name: 'The cafe', service: 'facebook' }]; await route.fulfill({ json: { ok: true, message: 'Connected. Found 2 channels.', channels } }); return true; }
      return false;
    });
    await open(`#/s/month?today=${TODAY}`);
    await page.click('.rail-foot .rf:has-text("Publishing")');
    await page.waitForSelector('dialog.wide input[data-field="pub-token"]');
    assert.equal(await page.locator('dialog input[data-field="pub-token"]').getAttribute('type'), 'password');
    await page.fill('dialog input[data-field="pub-token"]', 'SECRET-KEY-123');
    await page.click('dialog summary:has-text("host the export folders yourself")');   // the manual address sits under media hosting
    await page.fill('dialog input[data-field="pub-base"]', 'https://media.example.test/nordle');
    await page.click('[data-act="connect-test"]');
    await page.waitForSelector('dialog .sch-msg:has-text("Found 2 channels")');
    await page.waitForSelector('.acc-brand .acc');
    assert.deepEqual(calls[0], { adapter: 'buffer', token: 'SECRET-KEY-123', options: { mediaBaseUrl: 'https://media.example.test/nordle' } });
    assert.equal(await page.locator('dialog input[data-field="pub-token"]').inputValue(), '', 'the field is emptied');
    assert.ok(!(await page.content()).includes('SECRET-KEY-123'), 'the key is nowhere in the page');
    await page.locator('.acc-brand').first().locator('.acc[data-channel="c1"] input[type=checkbox]').click();
    await page.click('[data-act="connect-save"]');
    await page.waitForFunction(() => document.querySelector('dialog .sch-msg')?.textContent === 'Saved.');
    assert.equal(Object.values(calls.at(-1).channels)[0][0].id, 'c1');
    assert.equal(calls.at(-1).token, undefined, 'the key is only sent when one is typed');
  });
});

test('"Scheduled" shows everywhere: chips, filter, plan, sheet; the review queue skips it; it cannot be removed', async () => {
  await studioPage(async ({ page, open, call, work }) => {
    const { posts } = await overview(call);
    const p = firstWhere(posts, (x) => x.status === 'built' && x.format === 'carousel' && x.date?.startsWith('2026-10'));
    await mutateCalendar(join(work, 'projects', p.project), (cal) => {
      const item = cal.items.find((i) => i.id === p.itemId);
      item.status = 'signed-off';
      item.status = 'scheduled';
      item.publish = { adapter: 'buffer', scheduledAt: '2026-11-12T07:30:00Z', remoteId: 'r1', at: new Date().toISOString() };
    });
    assert.equal((await overview(call)).posts.find((x) => x.uid === p.uid).status, 'scheduled');
    assert.equal((await overview(call)).posts.find((x) => x.uid === p.uid).needsReview, false);
    assert.equal((await call('/studio/remove', 'POST', { uids: [p.uid] })).body.failed.length, 1, 'it must be taken out of the schedule first');
    await open(`#/s/month?today=${TODAY}`);
    assert.ok(await page.locator(`.chip-scheduled[data-uid="${p.uid}"]`).count() === 1, 'a scheduled chip in the month');
    await page.goto(`${page.url().split('#')[0]}#/s/wall?today=${TODAY}&st=scheduled`);
    await page.waitForSelector('.wc');
    assert.equal(await page.locator('.wc').count(), 1);
    assert.match(await page.locator('.wc .st').innerText(), /Scheduled/);
    await page.goto(`${page.url().split('#')[0]}#/s/plan?today=${TODAY}&brand=${p.project}`);
    await page.waitForSelector('.cell.c-sched');
    assert.match(await page.locator('.legend').first().innerText(), /Scheduled/);
    await page.goto(`${page.url().split('#')[0]}#/s/month?today=${TODAY}&post=${encodeURIComponent(p.uid)}`);
    await page.waitForSelector('.detail.open .acts-done:has-text("Scheduled")');
    assert.equal(await page.locator('.detail [data-act="approve"]').count(), 0);
    assert.equal(await page.locator('.detail [data-act="remove"]').count(), 0);
    await page.goto(`${page.url().split('#')[0]}#/s/queue?today=${TODAY}`);
    await page.waitForSelector('.q-tick');
    const need = (await overview(call)).posts.filter((x) => x.needsReview).length;
    assert.equal(await page.locator('.q-tick').count(), need, 'the queue holds only what is waiting for a review');
  });
});

test('Insights has a "When to post" section: the best times coming up, days and hours as bars with how many posts, the Buffer allowance, and an update that will not spend requests twice', async () => {
  await studioPage(async ({ page, open, call }) => {
    const { projects } = (await call(`/studio?today=${TODAY}`)).body;
    const brand = projects[0];
    const row = (label, lift, lo, hi, n, verdict, extra = {}) => ({ label, lift, lo, hi, n, verdict, ...extra });
    const analysis = {
      schema: 'nordle.besttimes/0.1', timeZone: 'Australia/Melbourne', counts: { posts: 120, used: 100, tooNew: 2, unmeasured: 18, channels: 2, from: '2026-04-09T00:00:00Z', to: '2026-09-30T00:00:00Z' },
      weekday: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d, i) => row(d, i === 3 ? 1.3 : 0.9, 0.8, 1.4, 14, i === 3 ? 'better' : 'unclear', { key: i })),
      hour: [row('12 pm', 0.7, 0.6, 0.85, 40, 'worse', { hour: 12 }), row('6 pm', 1.25, 1.1, 1.4, 30, 'better', { hour: 18 })],
      combos: [row('Thu 6 pm', 1.6, 1.3, 2, 8, 'better', { weekday: 3, hour: 18 })], best: {}, caveats: ['Only times you have used can show up here.'],
    };
    const calls = [];
    await page.route('**/api/publish/best-times**', (route) => route.fulfill({ json: { ok: true, pulledAt: new Date(Date.now() - 3600000).toISOString(), allowance: { windows: { '1day': { limit: 250, left: 111 } } }, analysis, suggestions: [{ iso: '2099-11-12T07:15:00Z', label: 'Thu 6:15 pm', lift: 1.6, n: 8, verdict: 'better', confidence: 'clear', reason: 'Thu 6:15 pm: 1.6× a typical post, from 8 posts (clearly better than usual).' }] } }));
    await page.route('**/api/publish/sync-posts', async (route) => { calls.push(route.request().postDataJSON()); await route.fulfill({ json: { ok: true, skipped: true, message: 'Already updated 60 minutes ago. Nordle waits 6 hours between pulls to save Buffer\'s request allowance.' } }); });
    await open(`#/s/insights?today=${TODAY}&brand=${brand.id}`);
    await page.waitForSelector('.bt .bt-count');
    assert.match(await page.locator('.bt .bt-count').innerText(), /100 posts[\s\S]*2 channels/);
    assert.match(await page.locator('.bt-status').innerText(), /111 of 250 Buffer requests left today/);
    assert.match(await page.locator('.bt-slot').first().innerText(), /Thu 6:15 pm[\s\S]*clear evidence[\s\S]*1\.6× a typical post, 8 posts/i);
    assert.equal(await page.locator('.bt-chart').count(), 2, 'days and hours');
    assert.equal(await page.locator('.bt-chart').first().locator('.bt-row').count(), 7);
    assert.ok(await page.locator('.bt-row.better .bt-fill').count() >= 2 && await page.locator('.bt-row.worse .bt-fill').count() === 1);
    await page.click('[data-act="bt-sync"]');
    await page.waitForSelector('.notice:has-text("Already updated 60 minutes ago")');
    assert.deepEqual(calls[0], { project: brand.id }, 'an ordinary update never forces');
    await page.click('.notice button:has-text("Pull anyway")');
    await page.waitForFunction(() => true);
    assert.deepEqual(calls[1], { project: brand.id, force: true });
  });
});

test('Automatic scheduling: two quick changes do not overwrite each other, even when the first reply is slow and old', async () => {
  await studioPage(async ({ page, open }) => {
    let auto = { ok: true, enabled: false, daysAhead: 7, stories: true, recent: [], problems: [], pausedUntil: null };
    const sent = [];
    await fakeAdapters(page, [buffer({ configured: true, channels: [{ id: 'c1', name: 'The shop', service: 'instagram' }], options: { mediaBaseUrl: 'https://media.example.test/nordle' }, selected: {} }), BUNDLE], async (route, url) => {
      if (!url.pathname.endsWith('/auto-schedule')) return false;
      if (route.request().method() === 'POST') {
        const b = route.request().postDataJSON(); sent.push(b); auto = { ...auto, ...b };
        const reply = { ...auto };                                                   // what the server said when it handled THIS change
        if (sent.length === 1) await new Promise((r) => setTimeout(r, 1200));        // the first reply is the slow one, and by then it is out of date
        await route.fulfill({ json: reply });
        return true;
      }
      await route.fulfill({ json: auto });
      return true;
    });
    await open(`#/s/month?today=${TODAY}`);
    await page.click('.rail-foot .rf:has-text("Publishing")');
    await page.waitForSelector('dialog.wide [data-section="auto-schedule"]');
    await page.locator('dialog [data-field="auto-on"]').click();                     // the first change (its reply is slow)
    await page.evaluate(() => document.querySelector('dialog [data-field="auto-stories"]').click());   // the second, made at once while the first is still being saved
    await page.waitForFunction(() => /Stories\s*(not made|also made)/.test(document.querySelector('dialog.wide')?.innerText ?? ''), null, { timeout: 15000 });
    await page.waitForTimeout(1800);                                                 // long enough for any late, old reply to have redrawn the page
    assert.match(await page.locator('dialog.wide').innerText(), /Stories\s*not made/, 'the second choice (no Stories) is what the page ends up showing');
    assert.deepEqual(sent.at(-1), { stories: false }, 'and it was saved');
    assert.equal(auto.enabled, true);
    assert.equal(auto.stories, false);
  });
});

test('Automatic scheduling: the Publishing window has a switch that saves at once; an approved post says when it goes to Buffer by itself, or why it could not', async () => {
  await studioPage(async ({ page, open, call }) => {
    let auto = { ok: true, enabled: false, daysAhead: 7, stories: true, recent: [], problems: [], pausedUntil: null };
    const sent = [];
    await fakeAdapters(page, [buffer({ configured: true, channels: [{ id: 'c1', name: 'The shop', service: 'instagram' }], options: { mediaBaseUrl: 'https://media.example.test/nordle' }, selected: {} }), BUNDLE], async (route, url) => {
      if (!url.pathname.endsWith('/auto-schedule')) return false;
      if (route.request().method() === 'POST') { const b = route.request().postDataJSON(); sent.push(b); auto = { ...auto, ...b }; }
      await route.fulfill({ json: auto });
      return true;
    });
    const { posts } = await overview(call);
    const a = firstWhere(posts, (p) => verifiedBuilt(p) && p.date >= '2026-11-01');
    await call('/studio/act', 'POST', { uid: a.uid, action: 'approve' });
    const go = async () => { await open(`#/s/month?today=${TODAY}&post=${encodeURIComponent(a.uid)}&month=${a.date.slice(0, 7)}`); await page.waitForSelector('.detail.open .auto-note'); };

    await go();
    assert.match(await page.locator('.detail .auto-note[data-state="off"]').innerText(), /Automatic scheduling is off\. Turn it on/);
    await page.click('.detail [data-act="auto-open"]');
    await page.waitForSelector('dialog.wide [data-section="auto-schedule"]');
    assert.equal(await page.locator('dialog [data-field="auto-on"]').isChecked(), false);
    assert.equal(await page.locator('dialog [data-act="auto-now"]').count(), 0, 'nothing to look at while it is off');
    await page.click('dialog [data-field="auto-on"]');             // a click, not check(): check() looks at the box again afterwards, and by then the saved form may have been drawn again
    await page.waitForSelector('dialog [data-act="auto-now"]');
    assert.deepEqual(sent, [{ enabled: true }], 'saved at once, without pressing Save');
    // once saved it folds into one read-only card; changing it asks first
    assert.equal(await page.locator('dialog [data-field="auto-days"]').count(), 0, 'nothing to type in until Edit is pressed');
    const unlock = async () => { await page.click('dialog [data-act="edit-auto"]'); await page.click('dialog:has-text("Change automatic scheduling?") button:has-text("Edit it")'); await page.waitForSelector('dialog [data-field="auto-days"]'); };
    await unlock();
    await page.fill('dialog [data-field="auto-days"]', '10');
    await page.press('dialog [data-field="auto-days"]', 'Tab');
    await page.waitForFunction(() => !document.querySelector('[data-field="auto-days"]'));   // saved: folded again
    assert.deepEqual(sent.at(-1), { daysAhead: 10 });
    assert.match(await page.locator('dialog [data-section="auto"]').innerText(), /10 days before/);
    await unlock();
    await page.click('dialog [data-field="auto-stories"]');       // a click, not uncheck(): uncheck looks at the box again afterwards, and by then the saved form has folded away
    await page.waitForFunction(() => !document.querySelector('[data-field="auto-stories"]'));
    assert.deepEqual(sent.at(-1), { stories: false });

    await page.keyboard.press('Escape');
    await page.waitForFunction(() => /Goes to Buffer by itself on .*, 10 days before\./.test(document.querySelector('.detail .auto-note')?.textContent ?? ''));   // the note under the post followed the switch

    auto = { ...auto, problems: [{ uid: a.uid, message: 'Checks are failing: facts.', tries: 1, stopped: false, nextTry: null }] };
    await page.reload();
    await page.waitForSelector('.detail.open .auto-note[data-state="problem"]');
    assert.match(await page.locator('.detail .auto-note[data-state="problem"]').innerText(), /could not send this: Checks are failing: facts\./);
  });
});

test('A post the designer has just changed says "Updated" with its comments ticked, until it is approved again', async () => {
  await studioPage(async ({ page, open, call, work }) => {
    const { posts } = await overview(call);
    const a = firstWhere(posts, (p) => verifiedBuilt(p) && p.date);
    const ask = await call('/studio/act', 'POST', { uid: a.uid, action: 'changes', text: 'Use the counter photo.' });
    assert.equal(ask.status, 200);
    // the designer makes the change and links the post again (what the runner and the link command do)
    const { linkDoc } = await import('../src/calendar/service.mjs');
    await linkDoc(join(work, 'projects', a.project), a.itemId, a.docId);
    const now = (await overview(call)).posts.find((p) => p.uid === a.uid);
    assert.deepEqual([now.status, now.revised], ['built', true]);
    await fakeAdapters(page, [buffer(), BUNDLE]);
    await open(`#/s/month?today=${TODAY}&post=${encodeURIComponent(a.uid)}&month=${a.date.slice(0, 7)}`);
    await page.waitForSelector('.detail.open [data-state="updated"]');
    assert.match(await page.locator('.detail .acts-done.updated').innerText(), /Updated.*Have another look/);
    assert.match(await page.locator('.detail .st').first().innerText(), /Updated/);
    await page.click('.detail [data-act="approve"]');
    let after;
    for (let i = 0; i < 100; i++) { after = (await overview(call)).posts.find((p) => p.uid === a.uid); if (after.status === 'signed-off') break; await new Promise((r) => setTimeout(r, 100)); }
    assert.equal(after.status, 'signed-off');
    assert.equal(after.revised, false, 'once approved it is just approved');
  });
});

test('Publishing: choose a platform from a list and its steps and key box appear; a service with no key (Google) explains why; a saved key folds into a card', async () => {
  await studioPage(async ({ page, open }) => {
    const listed = [['sprout', 'Sprout Social'], ['hootsuite', 'Hootsuite'], ['later', 'Later'], ['metricool', 'Metricool'], ['publer', 'Publer'], ['planable', 'Planable']]
      .map(([id, name]) => ({ id, name, posting: false, note: '', configured: false, savedAt: null, keyHint: null }));
    const posted = [];
    await fakeAdapters(page, [buffer({ configured: true, needs: [] }), BUNDLE], async (route, url) => {
      if (!url.pathname.endsWith('/publish/platforms')) return false;
      if (route.request().method() === 'POST') {
        const b = route.request().postDataJSON();
        posted.push(b);
        const x = listed.find((p) => p.id === b.id);
        if (b.token) Object.assign(x, { configured: true, keyHint: String(b.token).slice(-4) }); else Object.assign(x, { configured: false, keyHint: null });
        await route.fulfill({ json: { ok: true, platform: x } });
        return true;
      }
      await route.fulfill({ json: { platforms: listed } });
      return true;
    });
    await open(`#/s/month?today=${TODAY}`);
    await page.click('.rail-foot .rf:has-text("Publishing")');
    await page.waitForSelector('dialog.wide [data-field="platform-pick"]');
    const options = await page.locator('[data-field="platform-pick"] option').evaluateAll((os) => os.map((o) => o.value).filter(Boolean));
    assert.deepEqual(options.sort(), ['googlebusiness', 'hootsuite', 'later', 'metricool', 'planable', 'publer', 'sprout']);
    assert.equal(await page.locator('[data-field^="platform-"]:not([data-field="platform-pick"])').count(), 0, 'no key box until a platform is chosen');
    // Sprout Social: steps and a key box
    await page.selectOption('[data-field="platform-pick"]', 'sprout');
    await page.waitForSelector('[data-platform="sprout"] [data-field="platform-sprout"]');
    assert.match(await page.locator('[data-platform="sprout"]').innerText(), /Sign in to Sprout Social[\s\S]*API[\s\S]*Nordle cannot post through this one yet/);
    assert.equal(await page.locator('[data-platform="sprout"] ol li').count() >= 3, true, 'numbered steps');
    assert.equal(await page.locator('dialog.wide a[href^="http"]').count(), 0, 'nothing is linked out: the address is plain text');
    await page.fill('[data-field="platform-sprout"]', 'sk-test-0123456789');
    await page.click('[data-act="save-sprout"]');
    await page.waitForSelector('.saved-card[data-section="platform:sprout"]');
    assert.deepEqual(posted, [{ id: 'sprout', token: 'sk-test-0123456789' }]);
    assert.match(await page.locator('.saved-card[data-section="platform:sprout"]').innerText(), /Key saved[\s\S]*••••6789/);
    assert.ok(!(await page.content()).includes('sk-test-0123456789'), 'the key is not in the page once saved');
    assert.equal(await page.locator('[data-field="platform-pick"] option[value="sprout"]').count(), 0, 'a saved platform is no longer in the list');
    // Google: no simple key, so the guide says why and there is no box
    await page.selectOption('[data-field="platform-pick"]', 'googlebusiness');
    await page.waitForSelector('[data-platform="googlebusiness"]');
    assert.match(await page.locator('[data-platform="googlebusiness"]').innerText(), /does not give out a simple key[\s\S]*Buffer/);
    assert.equal(await page.locator('[data-platform="googlebusiness"] input').count(), 0);
  });
});
