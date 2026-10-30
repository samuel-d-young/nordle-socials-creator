// The "Claude" area in the Studio's left bar (app/studio-activity.js): what Claude is doing, what it finished, the chime and its switch, and opening the post.
// The activity feed is faked in the page (GET /api/activity) and the browser's sound engine is a stand-in that counts the notes, so nothing is played and no real Claude runs.
//   node --test tests/studio-activity.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { closeBrowser } from './helpers.mjs';
import { studioPage, overview, TODAY } from './studio-helpers.mjs';

after(async () => { await closeBrowser(); });

const iso = (ms) => new Date(Date.now() - ms).toISOString();

/** Open the Studio with a fake feed. `feed.set({ working, recent })` changes what the next look sees. */
async function withFeed(page, open, post, initial = { working: [], recent: [] }) {
  let seq = 1, data = initial;
  await page.addInitScript(() => {
    window.__notes = 0;
    window.AudioContext = class { constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; } resume() {} createOscillator() { window.__notes++; return { type: '', frequency: {}, connect() {}, start() {}, stop() {} }; } createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; } };
  });
  await page.route('**/api/activity', (route) => route.fulfill({ json: { ok: true, seq, at: new Date().toISOString(), ...data } }));
  await open(`#/s/month?today=${TODAY}`);
  await page.waitForSelector('.act');
  return { set: (next) => { data = next; seq++; }, post };
}
const item = (post, o = {}) => ({ id: 'a1', project: post.project, projectName: 'Brand', doc: post.docId, title: post.title, kind: 'video', verb: 'Changing', past: 'Changed', what: 'the video', startedAt: iso(42000), steps: 4, ...o });
const notes = (page) => page.evaluate(() => window.__notes);

test('the Claude area: idle at first, then what Claude is changing, then a tick and one chime, and the same finished work never chimes twice', async () => {
  await studioPage(async ({ page, open, call }) => {
    const { posts } = await overview(call);
    const post = posts.find((p) => p.docId && p.format === 'carousel');
    const feed = await withFeed(page, open, post);
    assert.match(await page.locator('.act').innerText(), /Claude[\s\S]*idle[\s\S]*Nothing right now/i);
    assert.equal(await page.locator('.act').getAttribute('data-state'), 'idle');

    feed.set({ working: [item(post)], recent: [] });
    await page.waitForSelector('.act-row.act-now', { timeout: 8000 });
    const working = await page.locator('.act-row.act-now').innerText();
    assert.match(working, /Changing the video/);
    assert.ok(working.includes(post.title.slice(0, 20)), 'it names the post');
    assert.match(working, /4 steps/);
    assert.equal(await page.locator('.act').getAttribute('data-state'), 'working');
    assert.equal(await notes(page), 0, 'no chime while it is still working');

    feed.set({ working: [], recent: [item(post, { finishedAt: iso(0), ok: true })] });
    await page.waitForSelector('.act-row.done', { timeout: 8000 });
    assert.match(await page.locator('.act-row.done').innerText(), /Changed the video/);
    assert.equal(await page.locator('.act').getAttribute('data-state'), 'finished');
    await page.waitForFunction(() => window.__notes >= 2);
    assert.equal(await notes(page), 2, 'one chime is two notes');
    await page.waitForTimeout(2600);                                       // another look at the same finished work
    assert.equal(await notes(page), 2, 'the same finished work does not chime again');

    feed.set({ working: [], recent: [item(post, { id: 'a2', finishedAt: iso(0), ok: false, steps: 1 }), item(post, { finishedAt: iso(5000), ok: true })] });
    await page.waitForSelector('.act-row.done.bad', { timeout: 8000 });
    assert.match(await page.locator('.act-row.bad').innerText(), /Did not finish/);
  });
});

test('a render shows how far it is, several pieces of work are listed, and a click on finished work opens the post', async () => {
  await studioPage(async ({ page, open, call }) => {
    const { posts } = await overview(call);
    const post = posts.find((p) => p.docId && p.format === 'carousel');
    const feed = await withFeed(page, open, post);
    feed.set({ working: [item(post, { kind: 'render', verb: 'Rendering', what: 'the video', percent: 37, message: 'Drawing the titles' }), item(post, { id: 'a9', verb: 'Checking', what: 'a post', kind: 'check', title: 'Another post', doc: null })], recent: [] });
    await page.waitForSelector('.act-row.act-now', { timeout: 8000 });
    assert.equal(await page.locator('.act-row.act-now').count(), 2);
    assert.equal(await page.locator('.act-bar').getAttribute('aria-valuenow'), '37');
    assert.match(await page.locator('.act-state').innerText(), /2 at once/i);

    feed.set({ working: [], recent: [item(post, { finishedAt: iso(0), ok: true })] });
    await page.waitForSelector('.act-link', { timeout: 8000 });
    await page.click('.act-link');
    await page.waitForSelector('.detail.open', { timeout: 8000 });
    assert.ok((await page.locator('.detail.open').innerText()).includes(post.title.slice(0, 15)), 'the post that Claude worked on is the one that opened');
  });
});

test('the chime has a switch that is remembered, and work that was already finished when the page opened is silent', async () => {
  await studioPage(async ({ page, open, call }) => {
    const { posts } = await overview(call);
    const post = posts.find((p) => p.docId && p.format === 'carousel');
    const feed = await withFeed(page, open, post, { working: [], recent: [item(post, { id: 'old1', finishedAt: iso(120000), ok: true })] });     // finished before the page was opened
    await page.waitForSelector('.act-row.done', { timeout: 8000 });
    await page.waitForTimeout(2600);
    assert.equal(await notes(page), 0, 'finished before the page opened: no chime');

    assert.equal(await page.locator('[data-act="act-sound"]').getAttribute('aria-pressed'), 'true');
    await page.click('[data-act="act-sound"]');
    assert.equal(await page.locator('[data-act="act-sound"]').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.evaluate(() => localStorage.getItem('nordle.activity.sound')), 'off');
    feed.set({ working: [], recent: [item(post, { id: 'new1', finishedAt: iso(0), ok: true }), item(post, { id: 'old1', finishedAt: iso(120000), ok: true })] });
    await page.waitForFunction(() => document.querySelectorAll('.act-row.done').length === 2, null, { timeout: 8000 });
    await page.waitForTimeout(300);
    assert.equal(await notes(page), 0, 'switched off: silent');

    await page.reload();                                                    // still off after a reload
    await page.waitForSelector('.act');
    assert.equal(await page.locator('[data-act="act-sound"]').getAttribute('aria-pressed'), 'false');
    await page.click('[data-act="act-sound"]');                              // on again: it plays a sample so you know what it sounds like
    assert.equal(await page.locator('[data-act="act-sound"]').getAttribute('aria-pressed'), 'true');
    await page.waitForFunction(() => window.__notes >= 2);
  });
});
