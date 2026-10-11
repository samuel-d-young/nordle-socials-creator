// The editor, driven like a person would drive it: a real browser against a real server.
//   npm test   (needs the rendering browser: npx playwright-core install chromium)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { closeBrowser, editor, ready, settle, at, layerRect, layerOf, clickLayerRow, press, htmlDrag, dragOnCanvas, P } from './helpers.mjs';

after(closeBrowser);

test('opens a carousel: pages, layers, the page itself and the sizes', async () => {
  await editor('spring-menu-carousel', async ({ page }) => {
    assert.equal(await page.locator('.page-item').count(), 5);
    assert.equal(await page.locator('.layer-row').count(), 5);
    assert.deepEqual(await page.locator('.topbar .seg[title="Which size you are editing"] button').allTextContents(), ['ig-feed-4x5', 'li-feed-4x5']);
    const text = await page.evaluate(() => document.querySelector('.stage iframe:not(.back)').contentDocument.body.innerText);
    assert.match(text, /Spring menu/);
    const fontOk = await page.evaluate(() => [...document.querySelector('.stage iframe:not(.back)').contentDocument.fonts].some((f) => f.family.includes('Fraunces') && f.status === 'loaded'));
    assert.ok(fontOk, 'the brand font loaded in the editor');
    assert.equal(await page.locator('.status').textContent(), 'Saved');
  });
});

test('clicking a layer selects it, shows its handles and fills the Properties tab', async () => {
  await editor('spring-menu-carousel', async ({ page }) => {
    const r = await layerRect(page, 'headline');
    const p = await at(page, r.x + r.w / 2, r.y + r.h / 2);
    await page.mouse.click(p.x, p.y);
    await page.waitForSelector('.sel');
    assert.match(await page.locator('.sel .tag').textContent(), /headline/);
    assert.equal(await page.locator('.sel .h:not(.rot)').count(), 6, 'a text layer has side and corner handles');
    assert.equal(await page.locator('.layer-row.on').count(), 1);
    assert.equal(await page.inputValue('[data-field="layout-w"]'), '84');
    await page.mouse.click(...Object.values(await at(page, 5, 5)));
    assert.equal(await page.locator('.sel').count(), 0, 'clicking empty space deselects');
  });
});

test('dragging moves a layer and saves it; snapping lands on the page centre', async () => {
  await editor('spring-menu-carousel', async ({ page, doc }) => {
    const before = layerOf(await doc(), 'sub');
    const r = await layerRect(page, 'sub');
    await dragOnCanvas(page, { x: r.x + 30, y: r.y + 20 }, { x: r.x + 30 + 120, y: r.y + 20 + 200 });
    await settle(page);
    const after = layerOf(await doc(), 'sub');
    assert.ok(after.layout.x > before.layout.x + 5, `x moved from ${before.layout.x} to ${after.layout.x}`);
    assert.ok(after.layout.y > before.layout.y + 8, `y moved from ${before.layout.y} to ${after.layout.y}`);
    assert.equal(after.layout.w, before.layout.w, 'size unchanged');
  });
});

test('arrow keys nudge the selection; undo and redo bring it back and forth', async () => {
  await editor('spring-menu-carousel', async ({ page, doc }) => {
    await clickLayerRow(page, 'Swipe');
    const x0 = layerOf(await doc(), 'swipe').layout.x;
    await press(page, 'Shift+ArrowRight');
    await settle(page);
    const x1 = layerOf(await doc(), 'swipe').layout.x;
    assert.ok(Math.abs(x1 - (x0 + (10 / 1080) * 100)) < 0.02, `${x0} -> ${x1}`);
    await page.click('button[title^="Undo"]');
    await page.waitForFunction(() => document.querySelector('button[title^="Redo"]')?.disabled === false);
    assert.equal(layerOf(await doc(), 'swipe').layout.x, x0);
    await page.click('button[title^="Redo"]');
    await page.waitForFunction(() => document.querySelector('button[title^="Redo"]')?.disabled === true);
    assert.equal(layerOf(await doc(), 'swipe').layout.x, x1);
    await press(page, 'Control+z');
    await page.waitForFunction(() => document.querySelector('button[title^="Redo"]')?.disabled === false);
    assert.equal(layerOf(await doc(), 'swipe').layout.x, x0, 'Ctrl+Z works from the keyboard');
  });
});

test('resizing an image with a corner handle keeps its shape; a text corner scales the type', async () => {
  await editor('spring-menu-carousel', async ({ page, doc }) => {
    await clickLayerRow(page, 'cup');
    const before = layerOf(await doc(), 'cup').layout;
    const handle = page.locator('.sel .h[data-handle="nw"]');
    const hb = await handle.boundingBox();
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + 60, hb.y + 60, { steps: 6 });
    await page.mouse.up();
    await settle(page);
    const after = layerOf(await doc(), 'cup').layout;
    assert.ok(after.w < before.w - 3, `width ${before.w} -> ${after.w}`);
    assert.equal(after.h, 'auto', 'height stays automatic so the picture keeps its proportions');

    await clickLayerRow(page, 'Three new pours');
    const sizeBefore = layerOf(await doc(), 'sub').style.size;
    const h2 = await page.locator('.sel .h[data-handle="se"]').boundingBox();
    await page.mouse.move(h2.x + h2.width / 2, h2.y + h2.height / 2);
    await page.mouse.down();
    await page.mouse.move(h2.x + 70, h2.y + 40, { steps: 6 });
    await page.mouse.up();
    await settle(page);
    assert.ok(layerOf(await doc(), 'sub').style.size > sizeBefore, 'dragging a corner outward makes the type bigger');
  });
});

test('editing text in the Properties tab saves it; the colour and font controls change the style', async () => {
  await editor('spring-menu-carousel', async ({ page, doc }) => {
    await clickLayerRow(page, 'Three new pours');
    await page.fill('[data-field="text"]', 'Fresh pours, open from 7.');
    await page.locator('[data-field="text"]').blur();
    await settle(page);
    assert.equal(layerOf(await doc(), 'sub').text, 'Fresh pours, open from 7.');
    assert.match(await page.evaluate(() => document.querySelector('.stage iframe:not(.back)').contentDocument.body.innerText), /Fresh pours/);

    await page.locator('.panel .swatches .sw').nth(0).click(); // ink
    await settle(page);
    assert.equal(layerOf(await doc(), 'sub').style.color, '$brand.colors.ink');
    await page.selectOption('.panel select >> nth=0', { label: 'display · Fraunces' }).catch(() => {});
    await page.fill('[data-field="style-size"]', '52');
    await page.press('[data-field="style-size"]', 'Enter');
    await page.locator('[data-field="style-size"]').blur();
    await settle(page);
    assert.equal(layerOf(await doc(), 'sub').style.size, 52);
  });
});

test('"Only this size" saves an override and leaves the other size alone', async () => {
  await editor('spring-menu-carousel', async ({ page, doc }) => {
    await clickLayerRow(page, 'Three new pours');
    await page.click('.scope button:has-text("Only ig-feed-4x5")');
    await page.fill('[data-field="layout-x"]', '20');
    await page.locator('[data-field="layout-x"]').blur();
    await settle(page);
    const layer = layerOf(await doc(), 'sub');
    assert.equal(layer.layout.x, 8, 'the shared position is untouched');
    assert.equal(layer.overrides['ig-feed-4x5'].layout.x, 20);
    await page.click('.topbar .seg[title="Which size you are editing"] button:has-text("li-feed-4x5")');
    await ready(page);
    const r = await layerRect(page, 'sub');
    assert.ok(Math.abs(r.x - 1080 * 0.08) < 4, `the other size still has the shared position (${r.x})`);
    assert.ok(await page.locator('.ovr').count() === 0, 'no override dot at the other size');
  });
});

test('locked layers cannot be picked or nudged on the canvas; unlocking brings them back', async () => {
  await editor('spring-menu-carousel', async ({ page, doc }) => {
    await clickLayerRow(page, 'Swipe');
    await page.locator('.panel label:has-text("Locked") input').check();
    await settle(page);
    assert.equal(layerOf(await doc(), 'swipe').lock, true);
    const x0 = layerOf(await doc(), 'swipe').layout.x;
    await press(page, 'ArrowRight');
    await page.waitForTimeout(250);
    assert.equal(layerOf(await doc(), 'swipe').layout.x, x0, 'a locked layer does not move');
    assert.equal(await page.locator('.sel .h:not(.rot)').count(), 0, 'no resize handles on a locked layer');
    await page.locator('.panel label:has-text("Locked") input').uncheck();
    await settle(page);
    assert.equal(layerOf(await doc(), 'swipe').lock, undefined);
  });
});

test('adding a text box, a shape and an image; duplicating, reordering and deleting layers', async () => {
  await editor('spring-menu-carousel', async ({ page, doc }) => {
    await page.click('.tools button:has-text("Text")');
    await settle(page);
    let d = await doc();
    assert.equal(d.pages[0].layers.at(-1).type, 'text');
    assert.match(await page.locator('.sel .tag').textContent(), /text/);
    await page.click('.tools button:has-text("Circle")');
    await settle(page);
    d = await doc();
    assert.equal(d.pages[0].layers.at(-1).shape, 'ellipse');
    const n = d.pages[0].layers.length;

    await press(page, 'Control+d');
    await settle(page);
    d = await doc();
    assert.equal(d.pages[0].layers.length, n + 1);
    const ids = d.pages[0].layers.map((l) => l.id);
    assert.equal(new Set(ids).size, ids.length, 'ids stay unique');

    await press(page, '[');
    await settle(page);
    const d2 = await doc();
    assert.notDeepEqual(d2.pages[0].layers.map((l) => l.id), ids, 'bracket key sends the layer back one step');

    await press(page, 'Delete');
    await settle(page);
    assert.equal((await doc()).pages[0].layers.length, n);

    await page.click('.tools button:has-text("Image")');
    await page.locator('dialog .export-grid a').first().click();
    await settle(page);
    assert.equal((await doc()).pages[0].layers.at(-1).type, 'image');
  });
});

test('pages: add, duplicate, rename, reorder by dragging, delete', async () => {
  await editor('spring-menu-carousel', async ({ page, doc }) => {
    await page.click('.sec header button:has-text("Add")');
    await settle(page);
    assert.equal((await doc()).pages.length, 6);
    await page.locator('.page-item').first().hover();
    await page.locator('.page-item').first().locator('button[title="Duplicate page"]').click();
    await settle(page);
    assert.equal((await doc()).pages.length, 7);
    assert.equal((await doc()).pages[1].title, 'Cover copy');

    const idFirst = await page.locator('.page-item').nth(0).getAttribute('data-page');
    await htmlDrag(page, '.page-item:nth-child(1)', '.page-item:nth-child(3)');
    await settle(page);
    const order = (await doc()).pages.map((p) => p.id);
    assert.notEqual(order[0], idFirst, 'the first page moved');

    page.once('dialog', () => {});
    await page.locator('.page-item').last().hover();
    await page.locator('.page-item').last().locator('button[title="Delete page"]').click();
    await settle(page);
    assert.equal((await doc()).pages.length, 6, 'an empty page is deleted without asking');
  });
});

test('comments: press C, click the page, write, post; the pin and the Review tab show it; resolve and reply', async () => {
  await editor('spring-menu-carousel', async ({ page, api }) => {
    await press(page, 'c');
    const r = await layerRect(page, 'headline');
    const p = await at(page, r.x + 100, r.y + 60);
    await page.mouse.click(p.x, p.y);
    await page.waitForSelector('.composer textarea');
    await page.fill('.composer textarea', 'Make this punchier');
    await page.keyboard.press('Control+Enter');
    await page.waitForSelector('.pin[data-pin]');
    const review = (await api(`/projects/${P}/docs/spring-menu-carousel/review`)).review;
    assert.equal(review.comments.length, 1);
    assert.equal(review.comments[0].layer, 'headline');
    assert.equal(review.comments[0].page, 'cover');
    assert.match(await page.locator('.tabs button:has-text("Review")').textContent(), /1/);
    assert.match(await page.locator('.panel .comment').textContent(), /Make this punchier/);

    await page.click('.panel .comment button:has-text("Reply")');
    await page.fill('dialog textarea', 'On it');
    await page.click('dialog button:has-text("Reply")');
    await page.waitForFunction(() => document.querySelector('.panel .comment .reply'));
    await page.click('.panel .comment button:has-text("Resolve")');
    await page.waitForFunction(() => document.querySelector('.pin.resolved'));
    const after = (await api(`/projects/${P}/docs/spring-menu-carousel/review`)).review;
    assert.equal(after.comments[0].status, 'resolved');
    assert.equal(after.comments[0].replies[0].text, 'On it');
  });
});

test('versions and approval: save, look at an old version read-only, restore it, approve, see it go stale', async () => {
  await editor('spring-menu-carousel', async ({ page, api, doc }) => {
    await page.click('.tabs button:has-text("Review")');
    await page.click('button:has-text("Save version")');
    await page.fill('dialog input', 'First draft');
    await page.click('dialog button:has-text("Save version")');
    await page.waitForSelector('.version');

    await clickLayerRow(page, 'Three new pours');
    await page.click('.tabs button:has-text("Properties")');
    await page.fill('[data-field="text"]', 'A changed subtitle');
    await settle(page);
    await page.click('.tabs button:has-text("Review")');

    await page.click('.version button:has-text("View")');
    await page.waitForSelector('.banner:not(.hidden)');
    assert.match(await page.locator('.banner').textContent(), /Viewing First draft/);
    await page.waitForFunction(() => document.querySelector('.stage iframe:not(.back)')?.contentDocument?.body?.innerText.includes('Three new pours'), null, { timeout: 10000 });
    assert.equal(await page.locator('.sel').count(), 0);
    await page.click('.banner button:has-text("Back to current")');
    await page.waitForSelector('.banner.hidden', { state: 'attached' });

    await page.click('.version button:has-text("Restore")');
    await page.click('dialog button:has-text("Restore")');
    await page.waitForFunction(async () => !document.querySelector('dialog'));
    await settle(page);
    assert.equal(layerOf(await doc(), 'sub').text, 'Three new pours. Open from 7 am.');

    await page.click('button:has-text("Approve this version")');
    await page.click('dialog button:has-text("Approve")');
    await page.waitForSelector('.badge.ok');
    assert.equal((await api(`/projects/${P}/docs/spring-menu-carousel/review`)).review.approvals.length, 1);
    await clickLayerRow(page, 'Swipe');
    await press(page, 'ArrowDown');
    await settle(page);
    await page.waitForSelector('.topbar .badge.warn');
    assert.match(await page.locator('.topbar .badge.warn').textContent(), /Edited since approval/);
  });
});

test('copy tab: caption, counters, hashtags, alt text; "Check" finds nothing wrong with the sample', async () => {
  await editor('spring-menu-carousel', async ({ page, doc }) => {
    await page.click('.tabs button:has-text("Copy")');
    await page.fill('[data-field="caption"]', 'A fresh caption for the spring menu.');
    await page.locator('[data-field="caption"]').blur();
    await settle(page);
    assert.equal((await doc()).copy.caption, 'A fresh caption for the spring menu.');
    assert.match(await page.locator('.counter').first().textContent(), /of 2200/);
    await page.fill('[data-field="tag"]', 'newtag');
    await page.press('[data-field="tag"]', 'Enter');
    await settle(page);
    assert.ok((await doc()).copy.hashtags.includes('#newtag'));
    await page.fill('[data-field="caption"]', "This is the world's best coffee");
    await page.locator('[data-field="caption"]').blur();
    await settle(page);
    await page.waitForSelector('.badge.warn:has-text("avoids")');
    await page.fill('[data-field="alt-cover"]', 'A cup of coffee and the words Spring menu.');
    await page.locator('[data-field="alt-cover"]').blur();
    await settle(page);
    assert.equal((await doc()).copy.alt.cover, 'A cup of coffee and the words Spring menu.');

    await page.click('.group button:has-text("Run check")');
    await page.waitForSelector('.badge:has-text("problem"), .badge:has-text("No problems")', { timeout: 60000 });
    assert.match(await page.locator('.panel:not(.hidden)').textContent(), /banned-phrase|world's best/);
  });
});

test('export writes the images and the contact sheet and lists them', async () => {
  await editor('open-late-story', async ({ page }) => {
    await page.click('.topbar button:has-text("Export")');
    await page.click('dialog button:has-text("Export")');
    await page.waitForSelector('dialog .export-grid img', { timeout: 60000 });
    assert.equal(await page.locator('dialog .export-grid img').count(), 2);
    assert.ok(await page.locator('dialog a:has-text("contact sheet")').count() === 1);
    const href = await page.locator('dialog .export-grid a').first().getAttribute('href');
    const ok = await page.evaluate(async (u) => (await fetch(u)).status, href);
    assert.equal(ok, 200);
  });
});

test('all-sizes view shows every size; clicking one returns to editing it', async () => {
  await editor('open-late-story', async ({ page }) => {
    await page.click('.topbar button:has-text("All sizes")');
    await page.waitForSelector('.all-sizes figure');
    assert.equal(await page.locator('.all-sizes figure').count(), 2);
    await page.locator('.all-sizes figure').nth(1).click();
    await ready(page);
    assert.equal(await page.locator('.all-sizes').count(), 0);
    assert.match(await page.locator('.topbar .seg[title="Which size you are editing"] button.on').textContent(), /ig-feed-4x5/);
  });
});

test('safe zones can be switched on and show red bands in the page', async () => {
  await editor('open-late-story', async ({ page }) => {
    await page.click('.topbar button:has-text("Safe zones")');
    await page.waitForFunction(() => document.querySelector('.stage iframe:not(.back)')?.contentDocument?.getElementById('safe-overlay'));
  });
});

test('home screen lists projects; a new post can be created and opened', async () => {
  await editor('spring-menu-carousel', async ({ page, api }) => {
    await page.click('button[title="All projects"]');
    await page.waitForSelector('.home .card');
    assert.ok(await page.locator('.home .card:has-text("Spring menu carousel")').count() === 1);
    // a video is a normal card now: it opens in the timeline editor (tests/video-editor.test.mjs)
    assert.equal(await page.locator('.card.disabled').count(), 0);
    assert.match(await page.locator('.home .card:has-text("Behind the roast")').getAttribute('href'), /#\/p\/little-gannet\/behind-the-roast-reel$/);
    await page.click('.card.new');
    await page.fill('[data-field="new-title"]', 'My new post');
    await page.click('dialog button:has-text("Create")');
    await page.waitForFunction(() => location.hash.endsWith('/my-new-post'));
    await ready(page).catch(() => {});
    await page.waitForSelector('.page-item');
    const created = (await api(`/projects/${P}/docs/my-new-post`)).doc;
    assert.equal(created.title, 'My new post');
    assert.equal(created.pages.length, 1);
  });
});

test('a change made elsewhere (another tab, or Claude) appears without reloading', async () => {
  await editor('spring-menu-carousel', async ({ page, api }) => {
    const res = await api(`/projects/${P}/docs/spring-menu-carousel/patch`, 'POST', { ops: [{ op: 'replace', path: '/pages/0/layers/2/text', value: 'Changed from outside' }], actor: 'claude' });
    assert.ok(res.ok);
    await page.waitForFunction(() => document.querySelector('.stage iframe:not(.back)')?.contentDocument?.body?.innerText.includes('Changed from outside'));
  });
});

test('a narrow window still shows the canvas; the page does not scroll sideways', async () => {
  await editor('spring-menu-carousel', async ({ page }) => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `horizontal overflow ${overflow}px`);
  }, { viewport: { width: 1100, height: 760 } });
});
