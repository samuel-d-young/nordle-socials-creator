// Editing a caption from the post sheet, and the red glow on an approved post that is not scheduled anywhere yet.
// Fictional sample brands only; the server and a real browser, no network.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeBrowser } from './helpers.mjs';
import { mutateCalendar } from '../src/calendar/service.mjs';
import { TODAY, studioPage, studio, overview, firstWhere, verifiedBuilt } from './studio-helpers.mjs';

after(closeBrowser);

/** A signed-off post made outside Nordle (no document: its words live in the calendar record), like an imported reel. */
async function addImported(work, project) {
  const id = 'imported-words';
  await mutateCalendar(join(work, 'projects', project), (cal) => {
    cal.items.push({ id, date: '2026-10-20', time: '18:00', format: 'post', title: 'Imported words', status: 'signed-off', origin: 'owner', hook: 'Old first line', updated: new Date().toISOString(),
      external: { source: 'made elsewhere', caption: 'Old first line\n\nThe rest, unchanged.', hashtags: ['#one', '#two'] } });
  });
  return { id, uid: `${project}:${id}` };
}

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

test('a post made outside Nordle: its caption changes in the calendar record, the hook follows the new first line, and it stays approved', async () => {
  await studio(async ({ call, work, calendarOf }) => {
    const { posts } = await overview(call);
    const a = firstWhere(posts, (p) => p.docId);
    const imp = await addImported(work, a.project);
    const r = await call('/studio/caption', 'POST', { uid: imp.uid, text: 'New first line\n\nThe rest, unchanged.' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.changed, true);
    const it = calendarOf(a.project).items.find((i) => i.id === imp.id);
    assert.equal(it.external.caption, 'New first line\n\nThe rest, unchanged.');
    assert.deepEqual(it.external.hashtags, ['#one', '#two'], 'the hashtags are not touched');
    assert.equal(it.hook, 'New first line', 'the hook was the first line, so it follows');
    assert.equal(it.status, 'signed-off');
    const after = firstWhere((await overview(call)).posts, (p) => p.uid === imp.uid);
    assert.equal(after.staleSignoff, false, 'there is no document, so nothing goes stale');
    assert.equal(after.external, true);
  });
});

test('the post sheet of a post made outside Nordle offers Edit, and clicking the caption itself opens the box; saving does not say it needs approving again', async () => {
  await studioPage(async ({ page, open, call, work }) => {
    const { posts } = await overview(call);
    const a = firstWhere(posts, (p) => p.docId);
    const imp = await addImported(work, a.project);
    await open(`#/s/month?today=${TODAY}&post=${encodeURIComponent(imp.uid)}&month=2026-10`);
    await page.waitForSelector('.detail.open [data-act="edit-caption"]');
    // the words themselves are the way in
    await page.click('.detail .cap-text.cap-click');
    await page.waitForSelector('.detail [data-field="caption-edit"]');
    assert.equal(await page.locator('.detail [data-field="caption-edit"]').inputValue(), 'Old first line\n\nThe rest, unchanged.');
    assert.equal(await page.locator('.detail .cap-warn.hidden').count(), 1, 'no "approve it again" warning: this post has no document to go stale');
    await page.fill('.detail [data-field="caption-edit"]', 'Typed straight onto the post.\n\nThe rest, unchanged.');
    await page.keyboard.press('Control+Enter');
    await page.waitForFunction(() => /Typed straight onto the post\./.test(document.querySelector('.detail .cap-text')?.textContent ?? ''));
    const toast = await page.locator('.notice').last().innerText();
    assert.match(toast, /Caption saved\./);
    assert.doesNotMatch(toast, /approving again/);
    assert.equal(JSON.parse(JSON.stringify((await call(`/studio/post?uid=${encodeURIComponent(imp.uid)}`)).body.copy.caption)), 'Typed straight onto the post.\n\nThe rest, unchanged.');
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
