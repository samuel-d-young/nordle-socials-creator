// Several accounts per brand, and separate Buffer logins. The publishing service is faked in the page: nothing is ever sent anywhere.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { closeBrowser } from './helpers.mjs';
import { mutateCalendar } from '../src/calendar/service.mjs';
import { join } from 'node:path';
import { studioPage, overview, firstWhere, verifiedBuilt, TODAY } from './studio-helpers.mjs';

after(closeBrowser);

const BUNDLE = { id: 'bundle', name: 'Export folder', configured: true, needs: [], channels: [], note: 'Writes files to a folder.', options: {} };
const SHOP = { id: 'ig1', name: 'The shop', service: 'instagram' };
const PAGE = { id: 'fb1', name: 'The shop page', service: 'facebook' };
const TOK = { id: 'tt1', name: 'The shop on TikTok', service: 'tiktok' };
const OTHER = { id: 'ig9', name: 'The agency', service: 'instagram' };

const pick = async (page, uid) => { const box = page.locator(`.wc[data-uid="${uid}"] input[type=checkbox]`); await box.scrollIntoViewIfNeeded(); await page.waitForTimeout(150); await box.click({ force: true }); };

async function fake(page, adapters, extra = async () => false) {
  await page.route('**/api/publish/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/adapters')) return route.fulfill({ json: { adapters: typeof adapters === 'function' ? adapters() : adapters } });
    if (await extra(route, url)) return undefined;
    return route.continue();
  });
}

test('connect: Buffer accounts (add, test, remove), a brand publishes through one, ticks its channels, sets formats, stagger and strip hashtags', async () => {
  await studioPage(async ({ page, open }) => {
    const calls = [];
    const state = { accounts: [{ id: 'agency', label: 'Agency login', configured: true, lastTestedAt: '2026-10-05T01:00:00Z', channels: [SHOP, PAGE, TOK, OTHER] }], brands: {} };
    const adapters = () => [{ id: 'buffer', name: 'Buffer', configured: state.accounts.length > 0, needs: [], note: '', accounts: state.accounts, brands: state.brands, channels: [], options: {} }, BUNDLE];
    await fake(page, adapters, async (route, url) => {
      if (url.pathname.endsWith('/settings')) {
        const b = route.request().postDataJSON();
        calls.push(b);
        if (b.token && b.account) state.accounts.push({ id: b.account, label: b.label, configured: true, lastTestedAt: null, channels: [] });
        if (b.remove) state.accounts = state.accounts.filter((x) => x.id !== b.account);
        if (b.brand) state.brands[b.brand] = { account: b.useAccount, channels: b.channels?.[b.brand] ?? [] };
        await route.fulfill({ json: { ok: true } });
        return true;
      }
      if (url.pathname.endsWith('/test')) { calls.push({ test: route.request().postDataJSON() }); await route.fulfill({ json: { ok: true, message: 'Connected. 4 channels.' } }); return true; }
      return false;
    });
    await open(`#/s/month?today=${TODAY}`);
    await page.click('.rail-foot .rf:has-text("Publishing")');
    await page.waitForSelector('dialog.wide .bacc');
    assert.match(await page.locator('.bacc').first().innerText(), /Agency login[\s\S]*Connected[\s\S]*Tested/);
    assert.equal(await page.locator('.bacc [data-act="test-account"]').count(), 1);
    // a brand with no account says so
    assert.match(await page.locator('.acc-brand').first().innerText(), /Connect a Buffer account for|No account yet/);
    // add a second Buffer login: the key is sent once and never shown again
    await page.fill('dialog input[data-field="pub-label"]', 'Studio login');
    await page.fill('dialog input[data-field="pub-token"]', 'SECRET-TWO');
    await page.click('[data-act="add-account"]');
    await page.waitForSelector('.bacc[data-account="studio-login"]');
    assert.deepEqual(calls[0], { adapter: 'buffer', account: 'studio-login', label: 'Studio login', token: 'SECRET-TWO' });
    assert.ok(!(await page.content()).includes('SECRET-TWO'), 'the key is nowhere in the page');
    assert.equal(await page.locator('dialog input[data-field="pub-token"]').inputValue(), '');
    // the first brand publishes through the agency login and ticks two channels
    const first = page.locator('.acc-brand').first();
    await first.locator('select').selectOption('agency');
    await first.locator('.acc[data-channel="ig1"] input[type=checkbox]').click();
    await first.locator('.acc[data-channel="fb1"] input[type=checkbox]').click();
    // the same channel cannot belong to two brands
    const second = page.locator('.acc-brand').nth(1);
    await second.locator('select').selectOption('agency');
    assert.equal(await second.locator('.acc[data-channel="ig1"] input[type=checkbox]').isDisabled(), true);
    assert.match(await second.locator('.acc[data-channel="ig1"]').innerText(), /Already used by/);
    // formats (chips), stagger, strip hashtags (Facebook only), on/off
    const fb = first.locator('.acc[data-channel="fb1"]');
    await fb.locator('.fchip[data-format="story"]').click();
    await fb.locator('.fchip[data-format="reel"]').click();
    await fb.locator('input[type=number]').fill('30');
    await fb.locator('input[type=number]').dispatchEvent('change');
    await fb.locator('.acc-strip:has-text("Strip hashtags") input').check();
    assert.equal(await first.locator('.acc[data-channel="ig1"] .acc-strip:has-text("Strip hashtags")').count(), 0, 'only Facebook pages offer it');
    await page.click('[data-act="connect-save"]');
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));   // saved: the window goes away
    await page.waitForSelector('.notice:has-text("Publishing settings saved")');
    const body = calls.find((c) => c.brand && c.channels[c.brand]?.length);
    const sent = body.channels[body.brand];
    assert.equal(body.useAccount, 'agency');
    assert.deepEqual(sent.map((c) => c.id), ['ig1', 'fb1']);
    const fbSaved = sent.find((c) => c.id === 'fb1');
    assert.deepEqual(fbSaved.formats.sort(), ['carousel', 'post']);
    assert.equal(fbSaved.offsetMinutes, 30);
    assert.equal(fbSaved.hashtags, 'strip');
    assert.equal(sent.find((c) => c.id === 'ig1').formats, undefined, 'all formats means no restriction');
    // test and remove an account (the window is opened again)
    await page.click('.rail-foot .rf:has-text("Publishing")');
    await page.waitForSelector('dialog.wide .bacc[data-account="agency"]');
    await page.click('.bacc[data-account="agency"] [data-act="test-account"]');
    await page.waitForSelector('dialog .acc-banner.ok:has-text("Agency login is connected")');
    assert.match(await page.locator('.acc-banner').innerText(), /4 channels found/);
    assert.deepEqual(calls.at(-1), { test: { adapter: 'buffer', account: 'agency' } });
    await page.click('.bacc[data-account="studio-login"] [data-act="remove-account"]');
    await page.waitForSelector('dialog:has-text("Remove “Studio login”?")');
    await page.click('dialog button.danger');
    await page.waitForFunction(() => !document.querySelector('.bacc[data-account="studio-login"]'));
    assert.deepEqual(calls.at(-1), { adapter: 'buffer', account: 'studio-login', remove: true });
  });
});

test('schedule: one line per post and account, grouped by brand with the Buffer account; an account can be left out; the summary counts all of it', async () => {
  await studioPage(async ({ page, open, call }) => {
    const plans = [];
    const { posts } = await overview(call);
    const a = firstWhere(posts, (p) => verifiedBuilt(p) && p.date >= '2026-11-01');
    const b = posts.find((p) => p.status === 'built' && p.project !== a.project && p.format === 'carousel' && p.date >= '2026-11-01');
    const item = (p, c, over = {}) => ({ uid: p.uid, project: p.project, docId: p.docId, title: p.title, when: '2026-11-12T07:30:00Z', whenLocal: '2026-11-12 18:30', channel: c, caption: `Caption of ${p.title}`, media: ['out/a.png'], blockers: [], warnings: [], ready: true, overridable: false, format: 'carousel', status: 'signed-off', adapter: 'buffer', ...over });
    const full = [item(a, SHOP), item(a, PAGE, { whenLocal: '2026-11-12 19:00' }), item(b, OTHER, { blockers: ['Not signed off yet'], ready: false, overridable: true })];
    await fake(page, [{ id: 'buffer', name: 'Buffer', configured: true, needs: [], note: '', channels: [], mediaBaseUrl: 'https://media.example.test/n', accounts: [{ id: 'agency', label: 'Agency login', configured: true, channels: [SHOP, PAGE] }, { id: 'other', label: 'Second login', configured: true, channels: [OTHER] }], brands: { [a.project]: { account: 'agency', channels: [{ id: 'ig1' }, { id: 'fb1' }] }, [b.project]: { account: 'other', channels: [{ id: 'ig9' }] } }, options: {} }, BUNDLE], async (route, url) => {
      if (url.pathname.endsWith('/plan')) {
        const body = route.request().postDataJSON();
        plans.push(body);
        const off = (uid) => body.channels?.[uid];
        const items = full.filter((it) => !off(it.uid) || off(it.uid).includes(it.channel.id));
        await route.fulfill({ json: { planId: `p${plans.length}`, adapter: 'buffer', expires: new Date(Date.now() + 9e5).toISOString(), items, summary: { ready: items.filter((i) => i.ready).length, blocked: 0 } } });
        return true;
      }
      return false;
    });
    await open(`#/s/wall?today=${TODAY}`);
    await pick(page, a.uid);
    await pick(page, b.uid);
    await page.waitForSelector('.selbar:not(.hidden) [data-act="schedule"]');
    await page.click('.selbar [data-act="schedule"]');
    await page.waitForSelector('.sch-brand-group');
    assert.equal(await page.locator('.sch-brand-group').count(), 2, 'one group per brand');
    assert.match(await page.locator(`.sch-brand-group[data-project="${a.project}"] .sch-via`).innerText(), /through Agency login/);
    assert.match(await page.locator(`.sch-brand-group[data-project="${b.project}"] .sch-via`).innerText(), /through Second login/);
    const rowA = page.locator(`.sch-row[data-uid="${a.uid}"]`);
    assert.equal(await rowA.locator('.sch-acct').count(), 2, 'two accounts for the first post');
    assert.match(await rowA.innerText(), /The shop[\s\S]*The shop page/);
    // the time is said once, in the row of choices; an account repeats it only when it goes at a different time (the shop page does: 19:00)
    assert.match(await rowA.locator('.sch-acct[data-channel="fb1"]').innerText(), /2026-11-12 19:00/);
    assert.doesNotMatch(await rowA.locator('.sch-acct').first().innerText(), /2026-11-12 18:30/);
    assert.match(await page.locator('.sch-sum').innerText(), /Schedule 1 post to 2 accounts\. Nothing is sent until you press the button\. 1 post left out/);
    // leave the Facebook page out for this run: the plan is made again without it
    await rowA.locator('.sch-acct[data-channel="fb1"] input[type=checkbox]').click();
    await page.waitForFunction(() => /Schedule 1 post to Buffer/.test(document.querySelector('.sch-sum')?.textContent ?? ''));
    assert.deepEqual(plans.at(-1).channels, { [a.uid]: ['ig1'] });
    assert.ok(await rowA.locator('.sch-acct.off').count() === 1);
    await rowA.locator('.sch-acct[data-channel="fb1"] input[type=checkbox]').click();
    await page.waitForFunction(() => /to 2 accounts\./.test(document.querySelector('.sch-sum')?.textContent ?? ''));
  });
});

test('schedule: a partial failure is listed per account and "Retry" plans only the ones that failed', async () => {
  await studioPage(async ({ page, open, call }) => {
    const plans = [], runs = [];
    const { posts } = await overview(call);
    const a = firstWhere(posts, (p) => verifiedBuilt(p) && p.date >= '2026-11-01');
    const mk = (c) => ({ uid: a.uid, project: a.project, docId: a.docId, title: a.title, when: '2026-11-12T07:30:00Z', whenLocal: '2026-11-12 18:30', channel: c, caption: 'x', media: ['out/a.png'], blockers: [], warnings: [], ready: true, overridable: false, format: 'carousel', status: 'signed-off', adapter: 'buffer' });
    await fake(page, [{ id: 'buffer', name: 'Buffer', configured: true, needs: [], note: '', channels: [], mediaBaseUrl: 'https://media.example.test/n', accounts: [{ id: 'agency', label: 'Agency login', configured: true, channels: [SHOP, PAGE, TOK] }], brands: { [a.project]: { account: 'agency', channels: [{ id: 'ig1' }, { id: 'fb1' }, { id: 'tt1' }] } }, options: {} }, BUNDLE], async (route, url) => {
      if (url.pathname.endsWith('/plan')) {
        const body = route.request().postDataJSON();
        plans.push(body);
        const keep = body.channels?.[a.uid];
        const items = [SHOP, PAGE, TOK].filter((c) => !keep || keep.includes(c.id)).map(mk);
        await route.fulfill({ json: { planId: `p${plans.length}`, adapter: 'buffer', expires: new Date(Date.now() + 9e5).toISOString(), items, summary: { ready: items.length, blocked: 0 } } });
        return true;
      }
      if (url.pathname.endsWith('/run')) {
        runs.push(route.request().postDataJSON());
        const ok = runs.length > 1;
        const rs = [{ uid: a.uid, channel: 'ig1', ok: true, message: 'Scheduled.' }, { uid: a.uid, channel: 'fb1', ok, message: ok ? 'Scheduled.' : 'Facebook said the page is locked.' }, { uid: a.uid, channel: 'tt1', ok, message: ok ? 'Scheduled.' : 'Rate limit.' }];
        await route.fulfill({ json: { results: ok ? rs.slice(1) : rs } });
        return true;
      }
      return false;
    });
    await open(`#/s/wall?today=${TODAY}`);
    await pick(page, a.uid);
    await page.waitForSelector('.selbar:not(.hidden) [data-act="schedule"]');
    await page.click('.selbar [data-act="schedule"]');
    await page.waitForSelector('.sch-acct[data-channel="tt1"] .st-stamp');
    assert.match(await page.locator('.sch-sum').innerText(), /Schedule 1 post to 3 accounts\./);
    await page.click('[data-act="schedule-run"]');
    await page.waitForSelector('.sch-res.part');
    assert.match(await page.locator('.sch-res-h').innerText(), /Scheduled on 1 of 3 accounts/);
    assert.match(await page.locator('.sch-res-l.bad').first().innerText(), /The shop page[\s\S]*locked/);
    assert.equal(await page.locator('.sch-res-l.ok').count(), 1);
    await page.click('[data-act="schedule-retry"]');
    await page.waitForSelector('.sch-acct[data-channel="fb1"] .st-stamp');
    assert.deepEqual(plans.at(-1), { adapter: 'buffer', uids: [a.uid], channels: { [a.uid]: ['fb1', 'tt1'] } }, 'only what failed is planned again');
    assert.equal(runs.length, 1, 'nothing is sent until the button is pressed again');
    assert.match(await page.locator('.sch-sum').innerText(), /Schedule 1 post to 2 accounts\./);
    await page.click('[data-act="schedule-run"]');
    await page.waitForFunction(() => !document.querySelector('dialog[open]'), null, { timeout: 15000 });   // everything went: the window closes by itself
    assert.match(await page.locator('.notice').last().innerText(), /2 posts scheduled/);
  });
});

test('the post sheet says where a scheduled post is going (accounts and times); a brand with no account says so in the plan and the sheet', async () => {
  await studioPage(async ({ page, open, call, work }) => {
    const { posts } = await overview(call);
    const p = firstWhere(posts, (x) => x.status === 'built' && x.format === 'carousel' && x.date?.startsWith('2026-10'));
    await mutateCalendar(join(work, 'projects', p.project), (cal) => {
      const it = cal.items.find((i) => i.id === p.itemId);
      it.status = 'signed-off'; it.status = 'scheduled';
      it.publish = { adapter: 'buffer', scheduledAt: '2026-11-12T07:30:00Z', at: new Date().toISOString(), targets: [{ channel: 'ig1', ok: true, scheduledAt: '2026-11-12T07:30:00Z' }, { channel: 'fb1', ok: true, scheduledAt: '2026-11-12T08:00:00Z' }] };
    });
    await fake(page, [{ id: 'buffer', name: 'Buffer', configured: true, needs: [], note: '', channels: [], accounts: [{ id: 'agency', label: 'Agency login', configured: true, channels: [SHOP, PAGE] }], brands: {}, options: {} }, BUNDLE]);
    await open(`#/s/month?today=${TODAY}&post=${encodeURIComponent(p.uid)}`);
    await page.waitForSelector('.detail.open .sched-list li');
    assert.equal(await page.locator('.sched-list li').count(), 2);
    assert.match(await page.locator('.sched-list').innerText(), /The shop[\s\S]*The shop page/);
    // a signed-off post of a brand with no Buffer account: the sheet offers to connect one
    const q = firstWhere(posts, (x) => verifiedBuilt(x) && x.uid !== p.uid);
    await call('/studio/act', 'POST', { uid: q.uid, action: 'approve' });
    await page.goto(`${page.url().split('#')[0]}#/s/month?today=${TODAY}&post=${encodeURIComponent(q.uid)}&brand=${q.project}`);
    await page.waitForSelector('.detail.open [data-act="schedule"]');
    assert.ok(await page.locator('.detail [data-act="connect-account"]').count() === 1, 'Connect an account is offered');
    await page.goto(`${page.url().split('#')[0]}#/s/plan?today=${TODAY}&brand=${q.project}`);
    await page.waitForSelector('.pb-connect');
    assert.match(await page.locator('.pb-connect').innerText(), /Connect an account/);
  });
});

test('schedule: a channel an earlier run already sent shows as "Already scheduled" (not a problem) and the run names posts by key', async () => {
  await studioPage(async ({ page, open, call }) => {
    const runs = [];
    const { posts } = await overview(call);
    const a = firstWhere(posts, (p) => verifiedBuilt(p) && p.date >= '2026-11-01');
    const mk = (c, over = {}) => ({ uid: a.uid, key: `${a.uid}#${c.id}`, project: a.project, docId: a.docId, title: a.title, when: '2026-11-12T07:30:00Z', whenLocal: '2026-11-12 18:30', channel: c, caption: 'x', media: ['out/a.png'], blockers: [], blockerCodes: [], warnings: [], ready: true, overridable: false, format: 'carousel', status: 'signed-off', adapter: 'buffer', ...over });
    const items = [mk(SHOP, { ready: false, blockers: ['Already scheduled on The shop for 2026-11-12T07:30:00Z.'], blockerCodes: ['already-scheduled-channel'] }), mk(PAGE)];
    await fake(page, [{ id: 'buffer', name: 'Buffer', configured: true, needs: [], note: '', channels: [], mediaBaseUrl: 'https://media.example.test/n', accounts: [{ id: 'agency', label: 'Agency login', configured: true, channels: [SHOP, PAGE] }], brands: { [a.project]: { account: 'agency', channels: [{ id: 'ig1' }, { id: 'fb1' }] } }, options: {} }, BUNDLE], async (route, url) => {
      if (url.pathname.endsWith('/plan')) { await route.fulfill({ json: { planId: 'p1', adapter: 'buffer', expires: new Date(Date.now() + 9e5).toISOString(), items, summary: { ready: 1, blocked: 1 } } }); return true; }
      if (url.pathname.endsWith('/run')) { runs.push(route.request().postDataJSON()); await route.fulfill({ json: { results: [{ uid: a.uid, key: `${a.uid}#fb1`, channel: PAGE, ok: true, message: 'Scheduled.' }] } }); return true; }
      return false;
    });
    await open(`#/s/wall?today=${TODAY}`);
    await pick(page, a.uid);
    await page.waitForSelector('.selbar:not(.hidden) [data-act="schedule"]');
    await page.click('.selbar [data-act="schedule"]');
    await page.waitForSelector('.sch-acct[data-channel="fb1"] .st-stamp');
    const done = page.locator('.sch-acct[data-channel="ig1"]');
    assert.match(await done.innerText(), /Already scheduled/);
    assert.equal(await done.locator('.st-proof').count(), 0, 'not shown as blocked');
    assert.equal(await done.locator('input[type=checkbox]').isDisabled(), true);
    assert.match(await page.locator('.sch-sum').innerText(), /Schedule 1 post to Buffer\. Nothing is sent/);
    await page.click('[data-act="schedule-run"]');
    await page.waitForFunction(() => !document.querySelector('dialog[open]'), null, { timeout: 15000 });   // it went: the window closes by itself
    assert.deepEqual(runs[0].only, [`${a.uid}#fb1`], 'only the channel that goes, by key');
  });
});

test('connect: adding an account says so out loud, checks the key, and matches the login to the brand it plainly belongs to', async () => {
  await studioPage(async ({ page, open, call }) => {
    const { projects } = await overview(call);
    const brand = projects[0];
    const calls = [];
    const state = { accounts: [], brands: {} };
    const adapters = () => [{ id: 'buffer', name: 'Buffer', configured: state.accounts.length > 0, needs: [], note: '', accounts: state.accounts, brands: state.brands, channels: [], options: {} }, BUNDLE];
    await fake(page, adapters, async (route, url) => {
      if (url.pathname.endsWith('/settings')) {
        const b = route.request().postDataJSON();
        calls.push(b);
        if (b.token && b.account) state.accounts.push({ id: b.account, label: b.label, configured: true, lastTestedAt: null, channels: [] });
        if (b.brand) state.brands[b.brand] = { account: b.useAccount, channels: b.channels?.[b.brand] ?? [] };
        await route.fulfill({ json: { ok: true } });
        return true;
      }
      if (url.pathname.endsWith('/test')) {
        const b = route.request().postDataJSON();
        const acc = state.accounts.find((x) => x.id === b.account);
        acc.lastTestedAt = '2026-10-05T01:00:00Z';
        acc.channels = acc.label === 'Zebra' ? [{ id: 'z1', name: 'Zebra stripes', service: 'instagram' }] : [{ id: 'm1', name: `${brand.name} page`, service: 'facebook' }, { id: 'm2', name: 'Someone else', service: 'instagram' }];
        await route.fulfill({ json: { ok: true, message: `Connected. ${acc.channels.length} channel${acc.channels.length === 1 ? '' : 's'}.` } });
        return true;
      }
      return false;
    });
    await open(`#/s/month?today=${TODAY}`);
    await page.click('.rail-foot .rf:has-text("Publishing")');
    await page.waitForSelector('dialog.wide .bacc-add');
    // a login named after the brand: connected out loud, and the brand takes it with the channel that carries its name
    await page.fill('dialog input[data-field="pub-label"]', brand.name);
    await page.fill('dialog input[data-field="pub-token"]', 'SECRET-ONE');
    await page.click('[data-act="add-account"]');
    await page.waitForSelector('.acc-banner.ok');
    const said = await page.locator('.acc-banner').innerText();
    assert.ok(said.includes(`${brand.name} is connected`) && said.includes('2 channels found') && said.includes(`Matched to ${brand.name} (1 channel)`), said);
    assert.equal(await page.locator('.bacc.fresh').count(), 1, 'the new login is highlighted');
    assert.match(await page.locator('.bacc').first().innerText(), /Connected/);
    const link = calls.find((c) => c.brand === brand.id);
    assert.equal(link.useAccount, state.accounts[0].id);
    assert.deepEqual(link.channels[brand.id].map((c) => c.id), ['m1'], 'only the channel that carries the brand name');
    // saved on the server, so it is folded into one read-only card (with an Edit button) instead of open fields
    const card = page.locator(`.saved-card[data-section="brand:${brand.id}"]`);
    assert.match(await card.innerText(), /Saved[\s\S]*Account[\s\S]*Channels[\s\S]*page/);
    assert.equal(await card.locator('input, select').count(), 0, 'nothing in it can be edited until Edit is pressed');
    assert.equal(await page.locator(`.acc-brand[data-project="${brand.id}"]`).count(), 0);
    assert.ok(await page.locator('.notice.ok').count() >= 1, 'and a notice for when the window is closed');
    // a login whose name matches nothing: still connected out loud, and it says what to do next (nothing is guessed)
    await page.fill('dialog input[data-field="pub-label"]', 'Zebra');
    await page.fill('dialog input[data-field="pub-token"]', 'SECRET-TWO');
    await page.click('[data-act="add-account"]');
    await page.waitForFunction(() => /Zebra is connected/.test(document.querySelector('.acc-banner')?.textContent ?? ''));
    assert.match(await page.locator('.acc-banner').innerText(), /choose which brand/);
    assert.equal(calls.filter((c) => c.brand).length, 1, 'no brand was linked to it');
    // a brand with no login says what to do, not that nothing is connected
    const other = page.locator(`.acc-brand:not([data-project="${brand.id}"])`).first();
    assert.match(await other.locator('h3').innerText(), /Choose an account/);
    assert.match(await other.locator('select option').first().innerText(), /Choose an account/);
  });
});

test('media hosting: the bucket keys are entered once, sent to the server, never shown again, and Test says whether Buffer will be able to read the files', async () => {
  await studioPage(async ({ page, open }) => {
    const calls = [];
    const state = { hosting: { configured: false } };
    const adapters = () => [{ id: 'buffer', name: 'Buffer', configured: true, needs: [], note: '', accounts: [{ id: 'agency', label: 'Agency login', configured: true, lastTestedAt: null, channels: [SHOP] }], brands: {}, channels: [], options: {}, hosting: state.hosting }, BUNDLE];
    await fake(page, adapters, async (route, url) => {
      if (url.pathname.endsWith('/settings')) {
        const b = route.request().postDataJSON();
        calls.push(b);
        if (b.hosting) state.hosting = { configured: true, kind: 's3', endpoint: b.hosting.endpoint, region: b.hosting.region, bucket: b.hosting.bucket, publicBaseUrl: b.hosting.publicBaseUrl, accessKeyHint: `…${b.hosting.accessKeyId.slice(-4)}` };
        await route.fulfill({ json: { ok: true } });
        return true;
      }
      if (url.pathname.endsWith('/test-hosting')) { calls.push({ test: 'hosting' }); await route.fulfill({ json: { ok: true, message: 'Working: a test file went into "posts" and was read back from pub-1.r2.example.dev.' } }); return true; }
      return false;
    });
    await open(`#/s/month?today=${TODAY}`);
    await page.click('.rail-foot .rf:has-text("Publishing")');
    await page.waitForSelector('dialog.wide .host');
    assert.match(await page.locator('.host').innerText(), /Not set up/);
    assert.equal(await page.locator('[data-act="host-test"]').isDisabled(), true, 'nothing to test yet');
    await page.fill('[data-field="host-endpoint"]', 'https://acct.r2.example.com');
    await page.fill('[data-field="host-bucket"]', 'posts');
    await page.fill('[data-field="host-accessKeyId"]', 'AKIDEXAMPLE1234');
    await page.fill('[data-field="host-secretAccessKey"]', 'SECRETSECRET');
    await page.fill('[data-field="host-publicBaseUrl"]', 'https://pub-1.r2.example.dev');
    await page.click('[data-act="host-save"]');
    await page.waitForSelector('.acc-banner.ok:has-text("Media hosting saved")');
    assert.equal(calls.at(-1).hosting.secretAccessKey, 'SECRETSECRET');
    assert.equal(calls.at(-1).hosting.region, 'auto');
    // saved: folded into one read-only card that says what was saved (never the secret)
    const saved = page.locator('.saved-card[data-section="hosting"]');
    assert.match(await saved.innerText(), /Media hosting[\s\S]*Set up[\s\S]*posts[\s\S]*…1234/);
    assert.equal(await saved.locator('input').count(), 0, 'no field can be typed in until Edit is pressed');
    assert.equal(await page.locator('.host').count(), 0);
    assert.ok(!(await page.content()).includes('SECRETSECRET'), 'the secret is nowhere in the page after saving');
    await page.click('[data-act="host-test"]');
    await page.waitForSelector('.acc-banner.ok:has-text("Media hosting works")');
    assert.match(await page.locator('.acc-banner').innerText(), /read back from/);
  });
});

test('media hosting: the window\'s own Save button keeps the bucket details too (they were lost when only "Save hosting" sent them)', async () => {
  await studioPage(async ({ page, open }) => {
    const calls = [];
    const state = { hosting: { configured: false } };
    const adapters = () => [{ id: 'buffer', name: 'Buffer', configured: true, needs: [], note: '', accounts: [{ id: 'agency', label: 'Agency login', configured: true, lastTestedAt: null, channels: [SHOP] }], brands: {}, channels: [], options: {}, hosting: state.hosting }, BUNDLE];
    await fake(page, adapters, async (route, url) => {
      if (url.pathname.endsWith('/settings')) {
        const b = route.request().postDataJSON();
        calls.push(b);
        if (b.hosting) state.hosting = { configured: true, kind: 's3', endpoint: b.hosting.endpoint, region: b.hosting.region, bucket: b.hosting.bucket, publicBaseUrl: b.hosting.publicBaseUrl, accessKeyHint: `…${b.hosting.accessKeyId.slice(-4)}` };
        await route.fulfill({ json: { ok: true } });
        return true;
      }
      return false;
    });
    await open(`#/s/month?today=${TODAY}`);
    await page.click('.rail-foot .rf:has-text("Publishing")');
    await page.waitForSelector('dialog.wide .host');
    await page.fill('[data-field="host-endpoint"]', 'https://acct.r2.example.com');
    await page.fill('[data-field="host-bucket"]', 'posts');
    await page.fill('[data-field="host-accessKeyId"]', 'AKIDEXAMPLE1234');
    await page.fill('[data-field="host-secretAccessKey"]', 'SECRETSECRET');
    await page.fill('[data-field="host-publicBaseUrl"]', 'https://pub-1.r2.example.dev');
    await page.click('[data-act="connect-save"]');                       // the window's Save, not "Save hosting"
    await page.waitForSelector('.acc-banner.ok:has-text("Media hosting saved")');
    const sent = calls.find((c) => c.hosting);
    assert.ok(sent, 'the hosting details were sent');
    assert.equal(sent.hosting.bucket, 'posts');
    assert.equal(sent.hosting.secretAccessKey, 'SECRETSECRET');
    assert.ok(await page.locator('dialog.wide .saved-card[data-section="hosting"]').count(), 'the window stays open, showing what was saved, so it can be tested');
    assert.equal(await page.locator('[data-act="host-test"]').isDisabled(), false);
    assert.ok(!(await page.content()).includes('SECRETSECRET'), 'the secret is nowhere in the page after saving');
  });
});
