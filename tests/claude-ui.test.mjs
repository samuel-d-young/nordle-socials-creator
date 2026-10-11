// Claude in the editor: the autonomy dial, Claude's changes (compare, accept, reject), suggestions, Explore, asking Claude.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { closeBrowser, editor, ready, settle, layerOf, clickLayerRow, P } from './helpers.mjs';

after(closeBrowser);

const DOC = `/projects/${P}/docs/spring-menu-carousel`;
const SUB = '/pages/0/layers/2/text';
const claudeEdit = (agent, value, note = 'a change') => agent(`${DOC}/patch`, 'POST', { ops: [{ op: 'replace', path: SUB, value }], note });
const frameText = (page) => page.evaluate(() => document.querySelector('.stage iframe:not(.back)')?.contentDocument?.body?.innerText ?? '');
const openReview = (page) => page.click('.tabs button:has-text("Review")');

test('the dial sets how far Claude may go, and it is remembered', async () => {
  await editor('spring-menu-carousel', async ({ page, api }) => {
    assert.equal(await page.locator('.dial button.on').textContent(), 'Review', 'review is the default');
    await page.click('.dial button[data-autonomy="suggest"]');
    await page.waitForFunction(() => document.querySelector('.dial button.on')?.textContent === 'Suggest');
    assert.equal((await api(`${DOC}/review`)).review.settings.autonomy, 'suggest');
    await page.reload();
    await ready(page);
    assert.equal(await page.locator('.dial button.on').textContent(), 'Suggest');
    await page.click('.dial button[data-autonomy="apply"]');
    await page.waitForFunction(() => document.querySelector('.dial button.on')?.textContent === 'Apply');
  });
});

test('a change by Claude shows up flagged; Compare shows before and after; Reject puts it back; Accept keeps it', async () => {
  await editor('spring-menu-carousel', async ({ page, doc, agent }) => {
    const original = layerOf(await doc(), 'sub').text;
    const r = await claudeEdit(agent, 'Fresh pours, open from 7.', 'shorter subtitle');
    assert.equal(r.json.status, 'pending');
    await page.waitForFunction(() => document.querySelector('.stage iframe:not(.back)')?.contentDocument?.body?.innerText.includes('Fresh pours'));
    await page.waitForSelector('.hl', { timeout: 10000 });
    await openReview(page);
    await page.waitForSelector('.change');
    assert.match(await page.locator('.change').first().textContent(), /shorter subtitle/);
    assert.match(await page.locator('.change').first().textContent(), /cover\/sub: text/);

    await page.click('.change button:has-text("Compare")');
    await page.waitForSelector('.banner:not(.hidden)');
    assert.match(await page.locator('.banner').textContent(), /Claude’s change: shorter subtitle/);
    await page.click('.banner button:has-text("Before")');
    await page.waitForFunction((t) => document.querySelector('.stage iframe:not(.back)')?.contentDocument?.body?.innerText.includes(t.split('\n')[0]), original);
    assert.ok((await frameText(page)).includes('Three new pours'), 'before shows the old words');
    await page.click('.banner button:has-text("After")');
    await page.waitForFunction(() => document.querySelector('.stage iframe:not(.back)')?.contentDocument?.body?.innerText.includes('Fresh pours'));
    await page.click('.banner button:has-text("Close")');
    await page.waitForSelector('.banner.hidden', { state: 'attached' });

    await page.click('.change button:has-text("Reject and put back")');
    await page.waitForFunction(() => !document.querySelector('.change button'), null, { timeout: 10000 });
    assert.equal(layerOf(await doc(), 'sub').text, original);
    assert.equal(await page.locator('.hl').count(), 0);

    await claudeEdit(agent, 'Keep this one', 'keeper');
    await page.waitForSelector('.change button:has-text("Accept")');
    await page.click('.change button:has-text("Accept")');
    await page.waitForFunction(() => !document.querySelector('.change button'), null, { timeout: 10000 });
    assert.equal(layerOf(await doc(), 'sub').text, 'Keep this one');
    assert.equal(await page.locator('.hl').count(), 0, 'the marker goes once it is accepted');
  });
});

test('in Suggest mode nothing changes until the owner previews and accepts', async () => {
  await editor('spring-menu-carousel', async ({ page, doc, agent }) => {
    await page.click('.dial button[data-autonomy="suggest"]');
    await page.waitForFunction(() => document.querySelector('.dial button.on')?.textContent === 'Suggest');
    const original = layerOf(await doc(), 'sub').text;
    const r = await claudeEdit(agent, 'Only a suggestion', 'try this');
    assert.equal(r.json.mode, 'proposed');
    await openReview(page);
    await page.waitForSelector('.change .badge.warn');
    assert.match(await page.locator('.change').first().textContent(), /Suggestion/);
    assert.equal(layerOf(await doc(), 'sub').text, original);
    assert.ok((await frameText(page)).includes('Three new pours'), 'the page still shows the real thing');

    await page.click('.change button:has-text("Preview")');
    await page.waitForSelector('.banner:not(.hidden)');
    assert.match(await page.locator('.banner').textContent(), /Previewing Claude’s suggestion: try this/);
    await page.waitForFunction(() => document.querySelector('.stage iframe:not(.back)')?.contentDocument?.body?.innerText.includes('Only a suggestion'));
    assert.equal(layerOf(await doc(), 'sub').text, original, 'previewing changes nothing');

    await page.click('.banner button:has-text("Accept")');
    await page.waitForSelector('.banner.hidden', { state: 'attached' });
    await settle(page);
    assert.equal(layerOf(await doc(), 'sub').text, 'Only a suggestion');
  });
});

test('rejecting is refused with a reason when the same part has changed again', async () => {
  await editor('spring-menu-carousel', async ({ page, doc, agent, api }) => {
    await claudeEdit(agent, 'Claude’s words', 'rewrite');
    await openReview(page);
    await page.waitForSelector('.change');
    await api(`${DOC}/patch`, 'POST', { ops: [{ op: 'replace', path: '/pages/0/layers/0/text', value: 'EDITED BY THE OWNER' }] });
    await page.waitForFunction(() => document.querySelector('.stage iframe:not(.back)')?.contentDocument?.body?.innerText.includes('EDITED BY THE OWNER'));
    await page.click('.change button:has-text("Reject and put back")');
    await page.waitForSelector('.toast.error');
    assert.match(await page.locator('.toast.error').first().textContent(), /cannot be taken back cleanly/);
    assert.equal(layerOf(await doc(), 'sub').text, 'Claude’s words', 'nothing was undone');
  }, { allowErrors: [/409/] }); // the browser logs the refused request; that is the point of this test
});

test('"Reject all" takes back several changes at once', async () => {
  await editor('spring-menu-carousel', async ({ page, doc, agent }) => {
    const original = (await doc()).pages[0];
    await claudeEdit(agent, 'one', 'first');
    await agent(`${DOC}/patch`, 'POST', { ops: [{ op: 'replace', path: '/pages/0/layers/1/style/size', value: 90 }], note: 'second' });
    await openReview(page);
    await page.waitForFunction(() => document.querySelectorAll('.change').length === 2);
    await page.click('button:has-text("Reject all")');
    await page.waitForFunction(() => !document.querySelector('.change button'), null, { timeout: 10000 });
    assert.deepEqual((await doc()).pages[0], original);
  });
});

test('Explore: takes appear side by side; one can be used, and the original gets it', async () => {
  await editor('spring-menu-carousel', async ({ page, doc, agent }) => {
    const made = await agent(`${DOC}/explore`, 'POST', { count: 3, labels: ['Bold', 'Quiet', 'Playful'], note: 'three moods' });
    assert.equal(made.status, 201);
    const take = made.json.takes[0].id;
    await agent(`/projects/${P}/docs/${take}/patch`, 'POST', { ops: [{ op: 'replace', path: '/pages/0/layers/1/style/size', value: 170 }], note: 'bold' });
    await page.reload();
    await ready(page);
    await page.waitForFunction(() => document.querySelector('.topbar')?.textContent.includes('Explore (3)'), null, { timeout: 15000 });
    await page.click('.topbar button:has-text("Explore (3)")');
    await page.waitForSelector('.explore figure');
    assert.equal(await page.locator('.explore figure').count(), 4, 'the original and three takes');
    assert.match(await page.locator('.explore').textContent(), /Bold/);
    assert.match(await page.locator('.explore').textContent(), /Original/);

    await page.locator(`.explore figure[data-take="${take}"] button:has-text("Use this one")`).click();
    await page.click('dialog button:has-text("Use this one")');
    await page.waitForFunction(() => !document.querySelector('.explore'), null, { timeout: 10000 });
    assert.equal((await doc()).pages[0].layers[1].style.size, 170);
    assert.equal((await doc()).explore, undefined);

    await page.click('.topbar button:has-text("Explore (3)")');
    await page.waitForSelector('.explore .bar button:has-text("Discard all takes")');
    await page.click('.explore .bar button:has-text("Discard all takes")');
    await page.click('dialog button:has-text("Discard takes")');
    await page.waitForFunction(() => !document.querySelector('.topbar')?.textContent.includes('Explore ('), null, { timeout: 10000 });
  });
});

test('a take opens like any post, points back to its original, and stays off the home screen', async () => {
  await editor('spring-menu-carousel', async ({ page, agent, port }) => {
    const made = await agent(`${DOC}/explore`, 'POST', { count: 2 });
    const take = made.json.takes[1].id;
    await page.goto(`http://127.0.0.1:${port}/#/p/${P}/${take}`);
    await page.waitForSelector('.topbar button:has-text("Original")', { timeout: 15000 });
    assert.equal(await page.locator('.topbar button:has-text("Explore")').count(), 0, 'a take has no takes of its own');
    await page.click('.topbar button[title="All projects"]');
    await page.waitForSelector('.home .card');
    assert.equal(await page.locator('.home .card:has-text("take-")').count(), 0);
    assert.match(await page.locator('.home .card:has-text("Spring menu carousel")').textContent(), /2 alternative takes in Explore/);
  });
});

test('the sparkle button asks Claude about a layer: it becomes a comment on that layer', async () => {
  await editor('spring-menu-carousel', async ({ page, api }) => {
    await clickLayerRow(page, 'Spring menu is here');
    await page.click('button[data-action="ask-claude"]');
    await page.waitForSelector('.composer textarea');
    assert.match(await page.locator('.composer').textContent(), /On layer “headline”/);
    await page.fill('.composer textarea', 'Try this in the brand’s accent colour.');
    await page.keyboard.press('Control+Enter');
    await page.waitForSelector('.pin[data-pin]');
    const c = (await api(`${DOC}/review`)).review.comments[0];
    assert.equal(c.layer, 'headline');
    assert.equal(c.page, 'cover');
    const { text } = await api(`${DOC}/review/handoff`);
    assert.match(text, /on layer "headline" \("Spring menu is here"\)(, size [\w-]+)?: Try this in the brand’s accent colour\./);
  });
});

test('Claude’s own comments show as pins and in the list, marked as Claude’s', async () => {
  await editor('spring-menu-carousel', async ({ page, agent }) => {
    const c = await agent(`${DOC}/review/comment`, 'POST', { page: 'cover', x: 0.3, y: 0.5, layer: 'sub', text: 'Should this line be shorter?' });
    assert.equal(c.status, 200);
    await page.waitForSelector('.pin[data-pin]');
    await openReview(page);
    await page.waitForSelector('.panel .comment');
    assert.match(await page.locator('.panel .comment').first().textContent(), /Claude · page cover · sub/);
    assert.match(await page.locator('.panel .comment').first().textContent(), /Should this line be shorter\?/);
  });
});
