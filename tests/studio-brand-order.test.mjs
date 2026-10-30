// The order of the brands in the Studio (src/studio/brand-order.mjs, POST /api/studio/brand-order, the left bar in app/studio.js): move a brand from its menu,
// with Alt + arrow, or by dragging; the rail, the month's lanes and the all-brands Insights follow it, and it is still there after a reload.
// The order is kept in a temporary folder (NORDLE_PUBLISH_DIR), never in the real settings.
//   node --test tests/studio-brand-order.test.mjs
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT, closeBrowser, htmlDrag } from './helpers.mjs';
import { studio, studioPage, overview, TODAY } from './studio-helpers.mjs';
import { applyBrandOrder, readBrandOrder, saveBrandOrder, studioSettingsPath } from '../src/studio/brand-order.mjs';

let state;
before(() => { state = mkdtempSync(join(tmpdir(), 'nordle-brand-order-')); process.env.NORDLE_PUBLISH_DIR = join(state, 'settings'); });
after(async () => { delete process.env.NORDLE_PUBLISH_DIR; rmSync(state, { recursive: true, force: true }); await closeBrowser(); });
beforeEach(() => { rmSync(join(state, 'settings'), { recursive: true, force: true }); mkdirSync(join(state, 'settings'), { recursive: true }); });

const ids = (list) => list.map((p) => p.id);

test('the order is applied stably: named brands first in that order, a new brand after them in its own place, an unknown id ignored', () => {
  const brands = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  assert.deepEqual(ids(applyBrandOrder(brands, [])), ['a', 'b', 'c', 'd'], 'no order saved: as it was');
  assert.deepEqual(ids(applyBrandOrder(brands, ['c', 'a'])), ['c', 'a', 'b', 'd'], 'b and d are not named: they follow, in their own order');
  assert.deepEqual(ids(applyBrandOrder(brands, ['d', 'zzz', 'b', 'a', 'c'])), ['d', 'b', 'a', 'c']);
  assert.deepEqual(ids(brands), ['a', 'b', 'c', 'd'], 'the list that was passed in is not changed');
});

test('saving keeps only brands that exist, each once, and keeps what else is in the settings file', () => {
  assert.deepEqual(readBrandOrder(), []);
  assert.deepEqual(saveBrandOrder(['b', 'a', 'b', 'ghost', 7, '../x'], ['a', 'b', 'c']), ['b', 'a']);
  assert.deepEqual(readBrandOrder(), ['b', 'a']);
  const file = JSON.parse(readFileSync(studioSettingsPath(), 'utf8'));
  assert.deepEqual(file, { brandOrder: ['b', 'a'] });
  assert.deepEqual(saveBrandOrder('not a list', ['a']), [], 'anything that is not a list saves an empty order');
});

test('the route: only the owner saves it, the studio overview follows it, and a brand keeps its colour wherever it sits', async () => {
  await studio(async ({ call }) => {
    const first = await overview(call);
    const original = first.projects.map((p) => [p.id, p.color]);
    assert.equal(original.length, 2);
    const flipped = [...original].reverse().map(([id]) => id);
    assert.equal((await call('/studio/brand-order', 'POST', { order: flipped }, AGENT)).status, 403, 'Claude cannot reorder the owner\'s brands');
    assert.equal((await call('/studio/brand-order', 'POST', { order: 'x' })).status, 400);
    assert.equal((await call('/studio/brand-order')).status, 405);
    assert.equal(existsSync(studioSettingsPath()), false, 'nothing was saved by the refused calls');
    const saved = await call('/studio/brand-order', 'POST', { order: [...flipped, 'no-such-brand'] });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.order, flipped, 'a brand that does not exist is dropped');
    const after = await overview(call);
    assert.deepEqual(after.projects.map((p) => p.id), flipped);
    assert.deepEqual(Object.fromEntries(after.projects.map((p) => [p.id, p.color])), Object.fromEntries(original), 'the colours did not move with the places');
    assert.notEqual(after.rev, first.rev, 'a new order is a new revision, so a page that is open fetches it');
  });
});

const railIds = (page) => page.locator('.rb-row').evaluateAll((rows) => rows.map((r) => r.dataset.brand));

test('the left bar: Move down in a brand\'s menu, Alt + arrow, and dragging; the month and Insights follow, and a reload keeps it', async () => {
  await studioPage(async ({ page, open, call }) => {
    const { projects } = await overview(call);
    const [a, b] = ids(projects);
    await open(`#/s/month?today=${TODAY}`);
    assert.deepEqual(await railIds(page), [a, b]);
    const names = Object.fromEntries(projects.map((p) => [p.id, p.name]));
    const lanes = () => page.locator('.m-lane-h').evaluateAll((els) => els.slice(0, 2).map((e) => e.title));     // the first week's lanes, top to bottom
    const kept = async (want) => { for (let i = 0; i < 40; i++) { if (JSON.stringify(ids((await overview(call)).projects)) === JSON.stringify(want)) return true; await page.waitForTimeout(150); } return false; };
    assert.deepEqual(await lanes(), [names[a], names[b]]);

    // the menu: the first brand cannot go up, and goes down one place
    await page.locator(`.rb-row[data-brand="${a}"] .rb-menu`).click();
    await page.waitForSelector('.popmenu');
    assert.equal(await page.locator('.popmenu [data-act="brand-up"]').isDisabled(), true, 'nothing above the first brand');
    await page.click('.popmenu [data-act="brand-down"]');
    await page.waitForFunction(([x]) => document.querySelector('.rb-row')?.dataset.brand === x, [b]);
    assert.deepEqual(await railIds(page), [b, a]);
    assert.ok(await kept([b, a]), 'it was kept on the server');
    assert.deepEqual(await lanes(), [names[b], names[a]], 'the month\'s lanes follow the new order');

    // the keyboard: Alt + arrow up moves the brand that has the focus, and it keeps the focus
    await page.focus(`.rb-row[data-brand="${a}"] .rb`);
    await page.keyboard.press('Alt+ArrowUp');
    await page.waitForFunction(([x]) => document.querySelector('.rb-row')?.dataset.brand === x, [a]);
    assert.deepEqual(await railIds(page), [a, b]);
    assert.equal(await page.evaluate(() => document.activeElement?.closest('.rb-row')?.dataset.brand), a, 'the moved brand keeps the focus, so the next arrow moves it again');

    // dragging one brand onto another puts it in that place
    await htmlDrag(page, `.rb-row[data-brand="${a}"]`, `.rb-row[data-brand="${b}"]`);
    await page.waitForFunction(([x]) => document.querySelector('.rb-row')?.dataset.brand === x, [b]);
    assert.deepEqual(await railIds(page), [b, a]);
    assert.equal(await page.locator('.rb-row.dragging, .rb-row.drop-here').count(), 0, 'no drag marks are left behind');

    // the all-brands Insights follow it, and so does a reload
    await page.goto(`${page.url().split('#')[0]}#/s/insights?today=${TODAY}`);
    await page.waitForSelector('.ov-table tbody tr');
    assert.deepEqual(await page.locator('.ov-table tbody tr').evaluateAll((rows) => rows.map((r) => r.id.replace(/^ov-/, ''))), [b, a]);
    assert.ok(await kept([b, a]), 'the last move was saved');
    await page.reload();
    await page.waitForSelector('.rb-row');
    assert.deepEqual(await railIds(page), [b, a], 'still there after a reload');
  });
});

test('a failed save puts the list back and says so', async () => {
  await studioPage(async ({ page, open, call, errors }) => {
    const { projects } = await overview(call);
    const [a, b] = ids(projects);
    await page.route('**/api/studio/brand-order', (route) => route.fulfill({ status: 500, json: { ok: false, errors: [{ path: '/', message: 'The settings folder is read only.' }] } }));
    await open(`#/s/month?today=${TODAY}`);
    await page.locator(`.rb-row[data-brand="${a}"] .rb-menu`).click();
    await page.click('.popmenu [data-act="brand-down"]');
    await page.waitForSelector('.notice:has-text("read only")');
    await page.waitForFunction(([x]) => document.querySelector('.rb-row')?.dataset.brand === x, [a]);     // what the server has is put back
    assert.deepEqual(await railIds(page), [a, b], 'the order is as it was');
    assert.equal(errors.length, 1, 'the browser logs the refused request once, and nothing else went wrong');
    errors.length = 0;
  });
});
