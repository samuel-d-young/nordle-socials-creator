// How often and what Nordle reads from Buffer by itself (src/publish/pull-options.mjs, routes/buffer-pull.mjs, app/buffer-pull-options.js, auto-pull.mjs).
// Nothing real is contacted: the pull functions are fakes, and the settings live in a temporary folder (NORDLE_PUBLISH_DIR), never in .nordle/publish.json.
//   node --test tests/buffer-pull-options.test.mjs
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeBrowser, AGENT, TOKEN } from './helpers.mjs';
import { studio, studioPage, TODAY } from './studio-helpers.mjs';
import { PULL_CHOICES, PULL_DEFAULTS, cleanPullOptions, pullOptions } from '../src/publish/pull-options.mjs';
import { createAutoPull } from '../src/publish/auto-pull.mjs';
import { loadSettings, settingsPath } from '../src/publish/store.mjs';

const HOUR = 3600000;
let state;
before(() => { state = mkdtempSync(join(tmpdir(), 'nordle-pull-options-')); process.env.NORDLE_PUBLISH_DIR = join(state, 'settings'); });
after(async () => { delete process.env.NORDLE_PUBLISH_DIR; rmSync(state, { recursive: true, force: true }); await closeBrowser(); });
beforeEach(() => { rmSync(join(state, 'settings'), { recursive: true, force: true }); });

test('the options: defaults when nothing is saved, saved values that are one of the choices are kept, anything else falls back to the default', () => {
  assert.deepEqual(pullOptions({}), PULL_DEFAULTS);
  assert.deepEqual(pullOptions({ autoPull: { enabled: false, everyHours: 12, days: 30, maxNew: 10, results: false, handMade: false, covers: false } }), { enabled: false, everyHours: 12, results: false, handMade: false, days: 30, maxNew: 10, covers: false });
  assert.deepEqual(pullOptions({ autoPull: { everyHours: 5, days: '90', maxNew: 61, enabled: 'yes', results: 1 } }), PULL_DEFAULTS, 'a value that is not one of the choices is ignored');
  assert.deepEqual(PULL_DEFAULTS, { enabled: true, everyHours: 6, results: true, handMade: true, days: 90, maxNew: 60, covers: true });
  assert.ok(PULL_CHOICES.everyHours.every((h) => h >= 1 && h <= 24));
});

test('what the owner sends is checked: only the known options, each one of its choices; the rest is said in words', () => {
  assert.deepEqual(cleanPullOptions({ everyHours: 3, handMade: false }), { value: { everyHours: 3, handMade: false }, errors: [] });
  const bad = cleanPullOptions({ everyHours: 2, enabled: 'on', nope: 1, days: 90 });
  assert.deepEqual(bad.value, { days: 90 });
  assert.equal(bad.errors.length, 3);
  assert.match(bad.errors.map((e) => e.message).join(' | '), /everyHours must be one of 1, 3, 6, 12, 24[\s\S]*enabled must be true or false[\s\S]*unknown option "nope"/);
});

test('the route: anyone reads it, only the owner saves, a bad value is refused, and the choice is kept in the publishing settings', async () => {
  await studio(async ({ call }) => {
    const first = await call('/buffer-pull');
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.options, PULL_DEFAULTS);
    assert.deepEqual(first.body.choices, PULL_CHOICES);
    assert.equal((await call('/buffer-pull', 'POST', { everyHours: 12 }, AGENT)).status, 403, 'Claude cannot change what is read from Buffer');
    assert.equal((await call('/buffer-pull', 'POST', { everyHours: 7 })).status, 422);
    const saved = await call('/buffer-pull', 'POST', { everyHours: 12, handMade: false, days: 30 });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.options, { ...PULL_DEFAULTS, everyHours: 12, handMade: false, days: 30 });
    assert.deepEqual(pullOptions(loadSettings()), saved.body.options, 'it is in the publishing settings file');
    const again = await call('/buffer-pull', 'POST', { results: false });
    assert.deepEqual(again.body.options, { ...PULL_DEFAULTS, everyHours: 12, handMade: false, days: 30, results: false }, 'a second save merges, it does not reset the rest');
    const brand = (await call(`/buffer-pull?project=${first.body.brand?.id ?? 'little-gannet'}`)).body.brand;
    assert.equal(brand.connected, false, 'a brand with no Buffer account says so');
    assert.equal(brand.copied, 0);
  });
});

test('the automatic pull follows the choices: how often, whether to copy numbers, whether to copy posts made by hand, and what limits to pass on', async () => {
  const calls = [];
  let clock = Date.parse('2026-10-10T00:00:00Z'), last = 0, settings;
  const store = { scan: () => [{ id: 'b', dir: '/x/b' }] };
  const conn = { accounts: { acct: { adapter: 'buffer', token: 'not-a-real-key-123456', channelCache: [] } }, brands: { b: { account: 'acct', channels: [{ id: 'c1', name: 'IG', service: 'instagram' }] } } };
  const make = () => createAutoPull({
    now: () => clock, log: () => {}, settingsOf: () => settings, lastPull: () => last,
    pull: async () => { calls.push('pull'); last = clock; return { fetched: 1, requests: 1 }; },
    metrics: async () => { calls.push('metrics'); return { matched: 1 }; },
    bring: async (_s, o) => { calls.push(['bring', o.days, o.maxNew, o.covers]); return { created: 0, updated: 0, gone: 0 }; },
  });

  settings = { ...conn, autoPull: { everyHours: 12, results: false, handMade: true, days: 30, maxNew: 10, covers: false } };
  const ap = make();
  await ap.tick(store);
  assert.deepEqual(calls, ['pull', ['bring', 30, 10, false]], 'no numbers were asked for, and the owner\'s limits reached the importer');
  clock += 7 * HOUR; await ap.tick(store);
  assert.equal(calls.length, 2, 'seven hours is not twelve');
  clock += 6 * HOUR; await ap.tick(store);
  assert.equal(calls.length, 4, 'thirteen hours is');

  calls.length = 0; clock += 30 * HOUR;
  settings = { ...conn, autoPull: { everyHours: 1, handMade: false } };
  await make().tick(store);
  assert.deepEqual(calls, ['pull', 'metrics'], 'posts made by hand were not asked for');
  calls.length = 0; clock += 2 * HOUR;
  settings = { ...conn, autoPull: { enabled: false } };
  await make().tick(store);
  assert.deepEqual(calls, [], 'switched off');
});

// ---- the Options window in Insights -------------------------------------------------------------------------------------------------

test('Insights > Options: opens with the saved choices, the sub-options follow "posts made by hand", Save keeps them, and a second look shows them', async () => {
  await studioPage(async ({ page, open, call }) => {
    await open(`#/s/insights?today=${TODAY}&brand=little-gannet`);
    await page.locator('[data-act="bt-options"]').first().click();
    await page.waitForSelector('dialog.bp-dialog[open]');
    assert.equal(await page.locator('[data-field="bp-every"]').inputValue(), '6');
    assert.equal(await page.locator('[data-field="bp-days"]').inputValue(), '90');
    assert.equal(await page.locator('[data-field="bp-handMade"]').isChecked(), true);
    assert.match(await page.locator('[data-field="bp-status"]').innerText(), /no Buffer account and channels yet/);
    await page.selectOption('[data-field="bp-every"]', '12');
    await page.selectOption('[data-field="bp-days"]', '30');
    await page.uncheck('[data-field="bp-results"]');
    await page.uncheck('[data-field="bp-handMade"]');
    assert.equal(await page.locator('[data-field="bp-days"]').isDisabled(), true, 'the limits only matter while posts made by hand are copied');
    await page.click('[data-act="bp-save"]');
    await page.waitForSelector('dialog.bp-dialog', { state: 'detached' });
    assert.deepEqual((await call('/buffer-pull')).body.options, { ...PULL_DEFAULTS, everyHours: 12, days: 30, results: false, handMade: false });
    assert.ok(existsSync(settingsPath()), 'the choices are in the publishing settings file');

    await page.locator('[data-act="bt-options"]').first().click();
    await page.waitForSelector('dialog.bp-dialog[open]');
    assert.equal(await page.locator('[data-field="bp-every"]').inputValue(), '12');
    assert.equal(await page.locator('[data-field="bp-results"]').isChecked(), false);
    await page.click('[data-act="bp-close"]');
    await page.waitForSelector('dialog.bp-dialog', { state: 'detached' });
  });
});
