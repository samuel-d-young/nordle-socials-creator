// Editing a caption from the post sheet, and the red glow on an approved post that is not scheduled anywhere yet.
// Fictional sample brands only; the server and a real browser, no network.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeBrowser } from './helpers.mjs';
import { TODAY, studioPage, studio, overview, firstWhere, verifiedBuilt } from './studio-helpers.mjs';

after(closeBrowser);

test('POST /studio/caption changes a built post\'s caption as one undoable step, and an approval taken before it goes stale', async () => {
  await studio(async ({ call, work, calendarOf }) => {
    const { posts } = await overview(call);
    const a = firstWhere(posts, (p) => verifiedBuilt(p) && p.docId);
    await call('/studio/act', 'POST', { uid: a.uid, action: 'approve' });
    const r = await call('/studio/caption', 'POST', { uid: a.uid, text: '  A better first line.\r\n\r\nAnd a second paragraph.  ' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.changed, true);
    assert.equal(r.body.caption, 'A better first line.\n\nAnd a second paragraph.');
    const doc = JSON.parse(readFileSync(join(work, 'projects', a.project, 'docs', `${a.docId}.json`), 'utf8'));
    assert.equal(doc.copy.caption, 'A better first line.\n\nAnd a second paragraph.');
    const history = readFileSync(join(work, 'projects', a.project, 'history', `${a.docId}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(history.at(-1).note, 'Edit caption');
    assert.deepEqual(history.at(-1).ops.map((o) => o.path), ['/copy/caption']);
    assert.equal(history.at(-1).actor, 'human');
    // saving the same words again changes nothing
    assert.equal((await call('/studio/caption', 'POST', { uid: a.uid, text: 'A better first line.\n\nAnd a second paragraph.' })).body.changed, false);
    // the post said "signed off" before; now it asks to be approved again
    const after = firstWhere((await overview(call)).posts, (p) => p.uid === a.uid);
    assert.equal(after.staleSignoff, true, 'edited since sign-off');
    // refusals
    assert.equal((await call('/studio/caption', 'POST', { uid: a.uid, text: 'x'.repeat(5001) })).status, 400);
    assert.equal((await call('/studio/caption', 'POST', { uid: a.uid })).status, 400);
    assert.equal((await call('/studio/caption', 'POST', { uid: 'nope:none', text: 'x' })).status, 404);
    void calendarOf;
  });
});

test('the post sheet: Edit turns the caption into a box, Cancel leaves it alone, Save changes it and says an approved post needs approving again', async () => {
  await studioPage(async ({ page, open, call }) => {
    const { posts } = await overview(call);
    const a = firstWhere(posts, (p) => verifiedBuilt(p) && p.docId);
    await call('/studio/act', 'POST', { uid: a.uid, action: 'approve' });
    await open(`#/s/month?today=${TODAY}&post=${encodeURIComponent(a.uid)}&month=${a.date.slice(0, 7)}`);
    await page.waitForSelector('.detail.open [data-act="edit-caption"]');
    const before = await page.locator('.detail .cap-text').innerText();
    await page.click('.detail [data-act="edit-caption"]');
    await page.waitForSelector('.detail [data-field="caption-edit"]');
    assert.equal(await page.locator('.detail [data-field="caption-edit"]').inputValue(), before.replace(/\n+$/, '').length ? await page.locator('.detail [data-field="caption-edit"]').inputValue() : '');
    assert.match(await page.locator('.detail .cap-warn').innerText(), /approved[\s\S]*approve it again/i, 'an approved post says what changing the words means');
    // Cancel: nothing changes, the text is back
    await page.fill('.detail [data-field="caption-edit"]', 'Something else entirely.');
    await page.click('.detail [data-act="caption-cancel"]');
    assert.equal(await page.locator('.detail .cap-text').innerText(), before);
    // Save
    await page.click('.detail [data-act="edit-caption"]');
    await page.fill('.detail [data-field="caption-edit"]', 'A warmer opening line.\n\nThe rest, as written.');
    await page.keyboard.press('Control+Enter');
    await page.waitForFunction(() => /A warmer opening line\./.test(document.querySelector('.detail .cap-text')?.textContent ?? ''));
    assert.match(await page.locator('.notice').last().innerText(), /Caption saved\. It needs approving again/);
    assert.equal(await page.locator('.detail.open').count(), 1, 'the sheet stays open');
    const doc = (await call(`/studio/post?uid=${encodeURIComponent(a.uid)}`)).body;
    assert.equal(doc.copy.caption, 'A warmer opening line.\n\nThe rest, as written.');
  });
});

test('an approved post that is not scheduled in any platform gets the red glow and a "Not scheduled" tag; a post still being reviewed does not', async () => {
  await studioPage(async ({ page, open, call }) => {
    const { posts } = await overview(call);
    const a = firstWhere(posts, (p) => verifiedBuilt(p) && p.date >= '2026-11-01');
    const waiting = firstWhere(posts, (p) => p.status === 'built' && p.uid !== a.uid);
    await call('/studio/act', 'POST', { uid: a.uid, action: 'approve' });
    await open(`#/s/wall?today=${TODAY}`);
    const card = page.locator(`.wc[data-uid="${a.uid}"] .wc-pic`);
    await card.waitFor();
    assert.match(await card.getAttribute('class'), /chip-signed/);
    assert.match(await card.getAttribute('class'), /chip-unsched/, 'approved, not scheduled: red glow');
    assert.match(await page.locator(`.wc[data-uid="${a.uid}"]`).textContent(), /Not scheduled/);
    assert.doesNotMatch(await page.locator(`.wc[data-uid="${waiting.uid}"] .wc-pic`).getAttribute('class'), /chip-unsched/, 'a post waiting for review is not flagged');
    // the glow is a real red shadow, and the green bar is thick enough to see
    const look = await page.evaluate((uid) => {
      const pic = document.querySelector(`.wc[data-uid="${uid}"] .wc-pic`);
      return { glow: getComputedStyle(pic.querySelector('.th')).boxShadow, bar: parseFloat(getComputedStyle(pic.querySelector('.chip-bar')).height) };
    }, a.uid);
    assert.match(look.glow, /rgb/);
    assert.ok(look.bar >= 10, `the green bar is ${look.bar}px`);
  });
});
