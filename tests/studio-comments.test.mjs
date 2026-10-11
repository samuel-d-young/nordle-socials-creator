// Comments and pins in the Studio: notes, pins on a spot, pins at a second of a reel, and how they reach the designer.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { AGENT, closeBrowser } from './helpers.mjs';
import { studio, studioPage, overview, firstWhere, verifiedBuilt, TODAY } from './studio-helpers.mjs';

after(closeBrowser);

test('comments: a note, a pin on a spot, a pin at a second of a reel; resolve, reply, delete; the handoff says "at 0:07"', async () => {
  await studio(async ({ call, calendarOf }) => {
    const { posts } = await overview(call);
    const car = firstWhere(posts, (p) => p.status === 'built' && p.format === 'carousel');
    const uid = encodeURIComponent(car.uid);
    assert.equal((await call('/studio/comment', 'POST', { uid: car.uid, text: 'x' }, AGENT)).status, 403, 'only the owner comments here');
    assert.equal((await call('/studio/comment', 'POST', { uid: car.uid, text: '   ' })).status, 400);
    const note = await call('/studio/comment', 'POST', { uid: car.uid, text: 'Whole post: the tone is right.', general: true, page: 'cover' });
    const pin = await call('/studio/comment', 'POST', { uid: car.uid, text: 'Move this line up.', page: 'p2', x: 0.25, y: 1.7 });
    assert.equal(note.status, 200);
    let d = (await call(`/studio/post?uid=${uid}`)).body;
    assert.equal(d.comments.length, 2);
    assert.equal(d.comments[0].general, true);
    assert.deepEqual([d.comments[1].page, d.comments[1].x, d.comments[1].y], ['p2', 0.25, 1], 'a spot is kept inside the picture');
    assert.equal((await overview(call)).posts.find((p) => p.uid === car.uid).openComments, 2);
    await call('/studio/comment', 'POST', { uid: car.uid, action: 'reply', id: pin.body.id, text: 'On it' });
    await call('/studio/comment', 'POST', { uid: car.uid, action: 'resolve', id: note.body.id });
    d = (await call(`/studio/post?uid=${uid}`)).body;
    assert.equal(d.comments.find((c) => c.id === pin.body.id).replies[0].text, 'On it');
    assert.equal(d.comments.find((c) => c.id === note.body.id).status, 'resolved');
    // the editor reads the very same review file, and the hand-off to Claude lists the pin
    const hand = await call(`/projects/${car.project}/docs/${car.docId}/review/handoff`);
    assert.match(hand.body.text, /Move this line up/);
    assert.match(hand.body.text, /25% across/);
    // the pins go to the designer with "request changes"
    await call('/studio/act', 'POST', { uid: car.uid, action: 'changes', text: 'Please fix the pins.' });
    const fb = calendarOf(car.project).items.find((i) => i.id === car.itemId).feedback.at(-1).comment;
    assert.match(fb, /Please fix the pins\./);
    assert.match(fb, /Pinned notes:\n- p2: Move this line up\./);
    await call('/studio/comment', 'POST', { uid: car.uid, action: 'delete', id: pin.body.id });
    assert.equal((await call(`/studio/post?uid=${uid}`)).body.comments.length, 2, 'the note and the request-changes comment remain');

    const reel = firstWhere(posts, (p) => p.status === 'built' && p.format === 'reel');
    const t = await call('/studio/comment', 'POST', { uid: reel.uid, text: 'Cut here.', page: 'video', time: 7.4, x: 0.5, y: 0.4 });
    assert.equal(t.status, 200);
    const rd = (await call(`/studio/post?uid=${encodeURIComponent(reel.uid)}`)).body;
    assert.equal(rd.comments[0].time, 7.4);
    const rh = await call(`/projects/${reel.project}/docs/${reel.docId}/review/handoff`);
    assert.match(rh.body.text, /the video at 0:07/);
    // Claude can pin at a second too, through the existing comment route
    const ac = await call(`/projects/${reel.project}/docs/${reel.docId}/review/comment`, 'POST', { page: 'video', time: 3, x: 0.2, y: 0.2, text: 'Is this the right clip?' }, AGENT);
    assert.equal(ac.status, 200);
    assert.equal((await call(`/studio/post?uid=${encodeURIComponent(reel.uid)}`)).body.comments.find((c) => c.author === 'claude').time, 3);
  });
});

test('a post made outside Nordle can be commented on too (its own review file, same shape)', async () => {
  await studio(async ({ call, work }) => {
    const { posts } = await overview(call);
    const project = posts[0].project;
    const dir = join(work, 'projects', project);
    const png = (c) => { const p = new PNG({ width: 54, height: 68 }); p.data.fill(c); return PNG.sync.write(p); };
    mkdirSync(join(dir, 'external', 'imported'), { recursive: true });
    writeFileSync(join(dir, 'external', 'imported', 'slide-01.png'), png(180));
    writeFileSync(join(dir, 'external', 'imported', 'slide-02.png'), png(90));
    const { mutateCalendar } = await import('../src/calendar/service.mjs');
    await mutateCalendar(dir, (cal) => { cal.items.push({ id: 'imported', date: '2026-10-20', format: 'carousel', title: 'An imported carousel', status: 'built', external: { cover: 'external/imported/slide-01.png', slides: ['external/imported/slide-01.png', 'external/imported/slide-02.png'], caption: 'Imported words.' } }); });
    const uid = `${project}:imported`;
    const d0 = (await call(`/studio/post?uid=${encodeURIComponent(uid)}`)).body;
    assert.equal(d0.media.pages.length, 2);
    const r = await call('/studio/comment', 'POST', { uid, text: 'The second slide is dark.', page: 'slide-2', x: 0.6, y: 0.3 });
    assert.equal(r.status, 200);
    const d = (await call(`/studio/post?uid=${encodeURIComponent(uid)}`)).body;
    assert.deepEqual([d.comments[0].page, d.comments[0].x], ['slide-2', 0.6]);
    assert.equal((await overview(call)).posts.find((p) => p.uid === uid).openComments, 1);
    assert.ok(existsSync(join(dir, 'review', 'ext-imported.json')));
    assert.equal((await call('/studio/comment', 'POST', { uid, action: 'resolve', id: r.body.id })).status, 200);
    assert.equal((await call('/studio/act', 'POST', { uid, action: 'changes', text: 'Brighten slide two.' })).status, 200);
  });
});

test('the comments block sits at the top of the sheet, always with a box; a note and a pin on a page are saved and shown', async () => {
  await studioPage(async ({ page, open, call }) => {
    const { posts } = await overview(call);
    const car = firstWhere(posts, verifiedBuilt);
    await open(`#/s/month?today=${TODAY}&post=${encodeURIComponent(car.uid)}`);
    await page.waitForSelector('.detail.open .cm-top textarea');
    const order = await page.evaluate(() => [...document.querySelectorAll('.d-scroll > *')].map((e) => e.className.split(' ').find((c) => ['cv', 'ph', 'cm-top', 'cap', 'chk', 'why'].includes(c))).filter(Boolean));
    assert.ok(order.indexOf('cm-top') < order.indexOf('cap') && order.indexOf('cm-top') < order.indexOf('chk'), `comments come first: ${order}`);
    await page.fill('.cm-top textarea', 'A plain note.');
    await page.keyboard.press('Control+Enter');
    await page.waitForSelector('.cm-top .cmt:has-text("A plain note.")');
    assert.equal(await page.locator('.spin:not(.new)').count(), 0, 'a note is not a pin');
    await page.locator('.cm-pin').click();
    await page.waitForSelector('.cv.pinning');
    await page.locator('.cm-pin').click();
    await page.keyboard.press('c');
    await page.waitForSelector('.cv.pinning');
    const layer = page.locator('.detail .cv-slide').first().locator('.sp-layer');
    const box = await layer.boundingBox();
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.6);
    await page.waitForSelector('.spin.new');
    assert.match(await page.locator('.cm-chip').textContent(), /Pinned on cover/);
    await page.fill('.cm-top textarea', 'Make this bigger.');
    await page.keyboard.press('Control+Enter');
    await page.waitForSelector('.spin[data-comment]');
    const saved = (await call(`/studio/post?uid=${encodeURIComponent(car.uid)}`)).body.comments.find((c) => c.text === 'Make this bigger.');
    assert.equal(saved.page, 'cover');
    assert.ok(Math.abs(saved.x - 0.3) < 0.08 && Math.abs(saved.y - 0.6) < 0.08, `spot ${saved.x},${saved.y}`);
    await page.locator('.cm-top .cmt:has-text("Make this bigger.") button:has-text("Resolve")').click();
    // resolved: the pin leaves the picture at once and the comment folds under "Resolved"
    await page.waitForFunction(() => !document.querySelector('.spin[data-comment]'));
    assert.match(await page.locator('.cm-top .cmt-resolved summary').textContent(), /Resolved \(1\)/);
    assert.equal(await page.locator('.cm-top > ul.cmts > .cmt:has-text("Make this bigger.")').count(), 0, 'it is no longer in the open list');
  });
});

test('a reel: pin at a moment, the pin shows only near its time, a marker on the timeline, clicking the comment seeks', async () => {
  await studioPage(async ({ page, open, call }) => {
    const { posts } = await overview(call);
    const reel = firstWhere(posts, (p) => p.format === 'reel' && p.video && p.status === 'built');
    if (!reel) return;
    await open(`#/s/wall?today=${TODAY}&post=${encodeURIComponent(reel.uid)}`);
    await page.waitForSelector('.detail.open video.vp-video');
    await page.waitForFunction(() => document.querySelector('video.vp-video')?.duration > 3, null, { timeout: 15000 });
    await page.evaluate(() => { document.querySelector('video.vp-video').currentTime = 4; });
    await page.waitForFunction(() => Math.abs(document.querySelector('video.vp-video').currentTime - 4) < 0.2);
    await page.keyboard.press('c');
    await page.waitForSelector('.vp.pinning');
    const box = await page.locator('.vp-stage').boundingBox();
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.3);
    await page.waitForSelector('.spin.new');
    assert.match(await page.locator('.cm-chip').textContent(), /Pinned at 0:04/);
    await page.fill('.cm-top textarea', 'Cut a second earlier.');
    await page.keyboard.press('Control+Enter');
    await page.waitForSelector('.spin[data-comment]');
    const saved = (await call(`/studio/post?uid=${encodeURIComponent(reel.uid)}`)).body.comments[0];
    assert.equal(saved.page, 'video');
    assert.ok(Math.abs(saved.time - 4) < 0.3, `time ${saved.time}`);
    assert.equal(await page.locator('.vp-marks .vp-mark').count(), 1);
    assert.match(await page.locator('.cmt-where.time').textContent(), /0:04/);
    await page.evaluate(() => { document.querySelector('video.vp-video').currentTime = 0.2; });
    await page.waitForFunction(() => !document.querySelector('.vp-stage .spin[data-comment]'));
    await page.locator('.cm-top .cmt').first().locator('.cmt-text').click();
    await page.waitForFunction(() => Math.abs(document.querySelector('video.vp-video').currentTime - 4) < 0.3);
    await page.waitForSelector('.vp-stage .spin[data-comment]');
  });
});

test('the review queue has the comments block at the top of its panel too', async () => {
  await studioPage(async ({ page, open }) => {
    await open(`#/s/queue?today=${TODAY}`);
    await page.waitForSelector('.q-side .cm-top textarea');
    const order = await page.evaluate(() => [...document.querySelectorAll('.q-side-in > *')].map((e) => e.className.split(' ').find((c) => ['ph', 'cm-top', 'cap', 'chk'].includes(c))).filter(Boolean));
    assert.deepEqual(order.slice(0, 3), ['ph', 'cm-top', 'cap']);
  });
});

test('request changes lists the comments you already wrote, sends them without a second note, and shows what was asked', async () => {
  await studioPage(async ({ page, open, call, calendarOf }) => {
    const { posts } = await overview(call);
    const car = firstWhere(posts, verifiedBuilt);
    await open(`#/s/month?today=${TODAY}&post=${encodeURIComponent(car.uid)}`);
    await page.waitForSelector('.detail.open .cm-top textarea');
    await page.fill('.cm-top textarea', 'Use a warmer photo on page one.');
    await page.keyboard.press('Control+Enter');
    await page.waitForSelector('.cm-top .cmt:has-text("Use a warmer photo on page one.")');
    await page.locator('.detail [data-act="changes"]').click();
    await page.waitForSelector('dialog .ask-comments');
    assert.match(await page.locator('dialog .ask-comments').innerText(), /Your 1 comment go with it[\s\S]*Use a warmer photo on page one\./);
    // the comment is enough: no second note is needed
    await page.locator('dialog button:has-text("Send back with 1 comment")').click();
    // sent: only the question window goes away; the post sheet stays open, and the comment says it is with the designer
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    await page.waitForSelector('.detail.open .cm-top .cmt.sent');
    assert.equal(await page.locator('.detail.open').count(), 1, 'the sheet is still open');
    assert.match(await page.locator('.cm-top .cmt.sent [data-state="reviewing"]').innerText(), /designer/i);
    const item = calendarOf(car.project).items.find((i) => i.id === car.itemId);
    assert.equal(item.status, 'changes');
    assert.match(item.feedback.at(-1).comment, /Use a warmer photo on page one\./);
    // opened again, the sheet says what was asked
    await page.goto(`${page.url().split('#')[0]}#/s/month?today=${TODAY}&post=${encodeURIComponent(car.uid)}`);
    await page.waitForSelector('.detail .sent-note');
    assert.match(await page.locator('.detail .sent-note').innerText(), /what you asked for[\s\S]*Use a warmer photo on page one\./i);
  });
});

test('once a comment exists, a Request changes button sits right under the comments and sends them back', async () => {
  await studioPage(async ({ page, open, call, calendarOf }) => {
    const { posts } = await overview(call);
    const car = firstWhere(posts, verifiedBuilt);
    await open(`#/s/month?today=${TODAY}&post=${encodeURIComponent(car.uid)}`);
    await page.waitForSelector('.detail.open .cm-top textarea');
    assert.equal(await page.locator('.cm-top [data-act="comments-request-changes"]').isVisible(), false, 'no comment yet, so no button');
    await page.fill('.cm-top textarea', 'Make the headline shorter.');
    await page.keyboard.press('Control+Enter');
    await page.waitForSelector('.cm-top .cmt:has-text("Make the headline shorter.")');
    const btn = page.locator('.cm-top [data-act="comments-request-changes"]');
    await btn.waitFor({ state: 'visible' });
    const list = await page.locator('.cm-top .cmts').boundingBox();
    const at = await btn.boundingBox();
    assert.ok(at.y >= list.y + list.height - 2, 'the button is below the comment list');
    assert.match(await page.locator('.cm-send-note').innerText(), /Sends this comment to the designer/);
    await btn.click();
    await page.waitForSelector('dialog .ask-comments');
    await page.locator('dialog button:has-text("Send back with 1 comment")').click();
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    await page.waitForSelector('.detail.open .cm-top .cmt.sent');   // the sheet stays; its comment turns orange and greyed out
    assert.equal(calendarOf(car.project).items.find((i) => i.id === car.itemId).status, 'changes');
  });
});

test('in the review queue, Request changes opens one window, and it is gone once the post is sent back', async () => {
  await studioPage(async ({ page, open }) => {
    await open(`#/s/queue?today=${TODAY}`);
    await page.waitForSelector('.queue .q-side .ph-title');
    await page.fill('.queue .cm-top textarea', 'Make it shorter.');
    await page.keyboard.press('Control+Enter');
    await page.waitForSelector('.queue .cmt');
    await page.locator('.queue [data-act="comments-request-changes"]').click();
    await page.waitForSelector('dialog[open] .ask-comments');
    assert.equal(await page.locator('dialog[open]').count(), 1, 'one window, not two on top of each other');
    await page.locator('dialog[open] button:has-text("Send back with 1 comment")').click();
    await page.waitForFunction(() => document.querySelectorAll('dialog').length === 0);
    await page.waitForSelector('.queue .stamp-changes');
  });
});
