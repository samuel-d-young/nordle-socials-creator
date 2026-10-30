// The Stock window in the Studio: the Libraries tab (add a library, paste a key that is sent once and never shown again, test, forget, remove,
// a folder of your own stock) and the Search tab (results with pictures that come through Nordle, "Use in…", paging, plain errors).
// Nothing real is contacted: a FAKE fetch stands in for every library (the studio helper's server runs in this process, so it applies), and the
// settings live in a temporary folder (NORDLE_PUBLISH_DIR), never in .nordle/stock.json.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { AGENT, closeBrowser } from './helpers.mjs';
import { studioPage, overview, TODAY } from './studio-helpers.mjs';
import { configure, saveStockSettings } from '../src/stock/index.mjs';
import { pictures } from '../src/stock/pictures.mjs';
import { loadStock, stockPath } from '../src/stock/store.mjs';

const KEY = 'pexels-e2e-key-not-real-77123';
const WRONG = 'pexels-wrong-key-not-real-55555';
const ENVATO = 'envato-e2e-token-not-real-31337';
let state, calls, delayMs, handler;

const picture = (w, h, [r, g, b]) => {
  const p = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) { p.data[i * 4] = r; p.data[i * 4 + 1] = g; p.data[i * 4 + 2] = b; p.data[i * 4 + 3] = 255; }
  return PNG.sync.write(p);
};
const PIC = picture(48, 36, [86, 120, 150]);
const BIG = picture(64, 48, [150, 110, 80]);

const photo = (id) => ({ id, width: 4000, height: 3000, url: `https://www.pexels.com/photo/oranges-${id}/`, photographer: 'Ana Example', alt: `A bowl of oranges number ${id}`,
  src: { original: `https://images.pexels.com/photos/${id}/original.png`, large: `https://images.pexels.com/photos/${id}/large.png`, medium: `https://images.pexels.com/photos/${id}/medium.png` } });

/** The fake internet: Pexels, Envato Market and the picture servers. Everything is recorded in `calls`. */
function internet(u, init) {
  if (u.hostname === 'api.pexels.com') {
    if (init.headers?.Authorization !== KEY) return { status: 401, json: { error: 'bad key' } };
    const q = u.searchParams.get('query') ?? '';
    const page = Number(u.searchParams.get('page') ?? 1), per = Number(u.searchParams.get('per_page') ?? 15);
    if (u.pathname === '/v1/search') {
      if (/nothing/.test(q)) return { json: { total_results: 0, photos: [] } };
      return { json: { total_results: 30, photos: Array.from({ length: per }, (_, n) => photo(page * 100 + n)) } };
    }
    const one = /^\/v1\/photos\/(\d+)$/.exec(u.pathname);
    if (one) return { json: photo(Number(one[1])) };
    if (u.pathname === '/videos/search') return { json: { total_results: 1, videos: [{ id: 77, width: 1920, height: 1080, url: 'https://www.pexels.com/video/calm-sea-77/', image: 'https://images.pexels.com/videos/77/pic.png', duration: 12, user: { name: 'Bo Example' }, video_files: [] }] } };
  }
  if (u.hostname === 'images.pexels.com') {
    if (/\/(medium|pic)\.png$/.test(u.pathname)) return { type: 'image/png', body: PIC };
    if (/\/original\.png$/.test(u.pathname)) return { type: 'image/png', body: BIG };
  }
  if (u.hostname === 'api.envato.com') {
    if (init.headers?.Authorization !== `Bearer ${ENVATO}`) return { status: 401, json: {} };
    return { json: { total_hits: 2, matches: [
      { id: 9001, name: 'Beach sunrise opener', author_username: 'studio-x', url: 'https://videohive.net/item/beach-sunrise-opener/9001', previews: { thumbnail_preview: { small_url: 'https://market-resized.envatousercontent.com/t9001.png' } }, tags: [] },
      { id: 9002, name: 'Golden hour titles', author_username: 'studio-y', url: 'https://videohive.net/item/golden-hour-titles/9002', previews: { thumbnail_preview: { small_url: 'https://market-resized.envatousercontent.com/t9002.png' } }, tags: [] },
    ] } };
  }
  if (u.hostname === 'market-resized.envatousercontent.com') return { type: 'image/png', body: PIC };
  return undefined;
}

before(() => {
  state = mkdtempSync(join(tmpdir(), 'nordle-studio-stock-'));
  process.env.NORDLE_PUBLISH_DIR = join(state, 'settings');
  configure({
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), headers: init.headers ?? {} });
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const r = (handler ?? internet)(new URL(String(url)), init) ?? { status: 404, json: {} };
      if (r.json !== undefined) return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
      return new Response(r.body ?? null, { status: r.status ?? 200, headers: { 'content-type': r.type ?? 'application/octet-stream', ...(r.headers ?? {}) } });
    },
  });
});
after(async () => {
  configure({ fetch: undefined });
  delete process.env.NORDLE_PUBLISH_DIR;
  rmSync(state, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  await closeBrowser();
});
beforeEach(() => {
  rmSync(stockPath(), { force: true });
  pictures.clear();
  calls = []; delayMs = 0; handler = undefined;
});

const addPexels = (key = KEY) => saveStockSettings({ library: 'pexels', preset: 'pexels', key }, 'human');
const addEnvato = () => saveStockSettings({ library: 'envato-market', preset: 'envato-market', key: ENVATO }, 'human');
const openStock = async (page, open, hash = `#/s/month?today=${TODAY}`) => {
  await open(hash);
  await page.click('.rail-foot [data-act="open-stock"]');
  await page.waitForSelector('dialog.stk-dialog[open] .stk-tab[aria-selected="true"]');
};
const card = (page, id) => page.locator(`.stk-lib[data-library="${id}"]`);
/** A library that is not added yet is chosen from the list first: its card (with the steps for getting a key) appears. */
const choose = async (page, id) => { await page.selectOption('[data-field="stock-pick"]', id); await page.waitForSelector(`.stk-lib[data-library="${id}"]`); };
const confirmLast = (page) => page.locator('dialog[open]').last().locator('.df .btn.danger').click();
const tab = (page) => page.locator('.stk-tab[aria-selected="true"]').innerText();
/** Search on the Search tab and wait for the answer. */
async function search(page, q, { library, kind } = {}) {
  if (library) await page.selectOption('[data-field="stock-library"]', library);
  if (kind) await page.selectOption('[data-field="stock-kind"]', kind);
  await page.fill('[data-field="stock-q"]', q);
  await page.click('[data-act="stock-search"]');
  await page.waitForSelector('.stk-results[aria-busy="false"] .stk-sum');
}

test('Stock sits in the rail beside Publishing and opens the window; with nothing saved it opens on Libraries with a list to choose a site from, and a card with steps appears for the one chosen', async () => {
  await studioPage(async ({ page, open }) => {
    await open(`#/s/month?today=${TODAY}`);
    const labels = await page.locator('.rail-foot .rf span:not(.keys)').allInnerTexts();
    assert.ok(labels.indexOf('Stock') > labels.indexOf('Publishing'), `Stock is next to Publishing: ${labels.join(', ')}`);
    await page.click('.rail-foot [data-act="open-stock"]');
    await page.waitForSelector('dialog.stk-dialog.wide[open] [data-field="stock-pick"]');
    assert.equal(await tab(page), 'Libraries');
    assert.equal(await page.locator('dialog.stk-dialog .dh').innerText(), 'Stock libraries');
    assert.equal(await page.locator('.stk-lib').count(), 0, 'nothing is listed until a site is chosen');
    const options = await page.locator('[data-field="stock-pick"] option').evaluateAll((os) => os.map((o) => o.value).filter(Boolean));
    assert.deepEqual(options.sort(), ['envato-market', 'freesound', 'nokey:adobe-stock', 'nokey:artlist', 'nokey:envato-elements', 'nokey:epidemic', 'nokey:shutterstock', 'nokey:storyblocks', 'pexels', 'pixabay', 'unsplash']);
    // a site with no personal key (Epidemic Sound) says why, and points at the folder route instead of a key box
    await page.selectOption('[data-field="stock-pick"]', 'nokey:epidemic');
    await page.waitForSelector('.stk-nokey');
    assert.match(await page.locator('.stk-nokey').innerText(), /does not give subscribers an API key[\s\S]*partner/);
    assert.equal(await page.locator('.stk-nokey input[type=password]').count(), 0, 'no key box for a site that has no key');
    await page.click('[data-act="stock-nokey-folder"]');
    await page.waitForFunction(() => !document.querySelector('.stk-nokey'));
    await choose(page, 'pexels');
    const pexels = card(page, 'pexels');
    assert.match(await pexels.locator('.stk-how').innerText(), /Make a free account at pexels\.com[\s\S]*pexels\.com\/api/, 'the steps for getting a key are on the card');
    await choose(page, 'envato-market');
    await choose(page, 'freesound');
    await choose(page, 'pixabay');
    const ids = await page.locator('.stk-lib').evaluateAll((els) => els.map((e) => e.dataset.library));
    assert.deepEqual(ids.sort(), ['envato-market', 'freesound', 'pexels', 'pixabay']);
    assert.equal(await pexels.getAttribute('data-state'), 'not-added');
    assert.match(await pexels.innerText(), /Not added/);
    assert.deepEqual(await pexels.locator('.stk-chip').allInnerTexts(), ['photo', 'video']);
    assert.match(await pexels.innerText(), /Get a key at pexels\.com\/api/, 'the sign-up address is plain text');
    assert.equal(await pexels.locator('a').count(), 0, 'and not a link');
    assert.match(await pexels.innerText(), /Pexels licence: free to use/);
    assert.match(await pexels.innerText(), /Definition not yet tried with a live key/);
    assert.equal(await pexels.locator('[data-act="stock-add"]').count(), 1);
    assert.equal(await pexels.locator('[data-act="stock-test"]').count(), 0, 'nothing to test before it is added');
    const envato = card(page, 'envato-market');
    assert.match(await envato.innerText(), /Search only/);
    assert.match(await page.locator('.stk-folders').innerText(), /Envato Elements cannot be searched[\s\S]*Nordle never buys anything/);
    assert.equal(await page.locator('.stk-folders [data-field="stock-folder-path"]').getAttribute('placeholder'), 'D:/Stock/Videos');
    assert.equal(await page.locator('dialog.stk-dialog a').count(), 0, 'nothing external is linked from the Libraries tab');
  });
});

test('Stock libraries sits right under Stock in the rail and opens on the Libraries tab even when a library is ready; Stock itself opens on Search', async () => {
  await studioPage(async ({ page, open }) => {
    addPexels();
    await open(`#/s/month?today=${TODAY}`);
    const labels = (await page.locator('.rail-foot .rf span:not(.keys)').allInnerTexts()).filter((l) => l.trim());
    assert.equal(labels.indexOf('Stock libraries'), labels.indexOf('Stock') + 1, `Stock libraries follows Stock: ${labels.join(', ')}`);
    assert.ok(!labels.includes('Library'), 'the posts page is called All posts, so "Library" means one thing only');
    await page.click('.rail-foot [data-act="open-stock-libraries"]');
    await page.waitForSelector('dialog.stk-dialog[open] .stk-tab[aria-selected="true"]');
    assert.equal(await tab(page), 'Libraries');
    await page.click('[data-act="stock-close"]');
    await page.click('.rail-foot [data-act="open-stock"]');
    await page.waitForSelector('dialog.stk-dialog[open] .stk-tab[aria-selected="true"]');
    assert.equal(await tab(page), 'Search');
  });
});

test('adding a library and pasting its key: the key is sent once, tested at once, and is nowhere in the page afterwards', async () => {
  await studioPage(async ({ page, open }) => {
    const sent = [], answers = [];
    page.on('request', (r) => { if (r.url().includes('/api/stock/') && r.method() === 'POST') sent.push({ path: new URL(r.url()).pathname, body: r.postData() ?? '' }); });
    page.on('response', async (r) => { if (r.url().includes('/api/stock/')) answers.push(await r.text().catch(() => '')); });
    await openStock(page, open);
    await choose(page, 'pexels');
    const pexels = card(page, 'pexels');
    await pexels.locator('[data-act="stock-add"]').click();
    await page.waitForSelector('.stk-lib[data-library="pexels"] [data-field="stock-key-pexels"]');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.field), 'stock-key-pexels', 'the key box has the focus, ready to paste into');
    assert.equal(await page.locator('[data-field="stock-key-pexels"]').getAttribute('type'), 'password');
    assert.equal(await pexels.getAttribute('data-state'), 'needs-key');
    assert.match(await pexels.innerText(), /Needs an API key/);
    assert.equal(await pexels.locator('[data-act="stock-test"]').isDisabled(), true, 'no key, nothing to test');
    await page.fill('[data-field="stock-key-pexels"]', KEY);
    await pexels.locator('[data-act="stock-save-key"]').click();
    await page.waitForSelector('.stk-lib[data-library="pexels"] .acc-banner.ok:has-text("Key saved")');
    assert.match(await pexels.locator('.acc-banner').innerText(), /Key saved\. Pexels works[\s\S]*Pexels answered/);
    // the key box is gone; only "A key is saved" is left, with Replace and Forget key
    assert.equal(await pexels.locator('[data-field="stock-key-pexels"]').count(), 0);
    assert.match(await pexels.locator('.stk-key').innerText(), /A key is saved/);
    assert.deepEqual(await pexels.locator('.stk-key .btn').allInnerTexts(), ['Replace', 'Forget key']);
    assert.equal(await pexels.getAttribute('data-state'), 'ready');
    // sent once; kept only in the private file in the temp folder; nowhere in the page, its inputs, its storage or any answer
    assert.equal(sent.filter((s) => s.body.includes(KEY)).length, 1, 'the key went out in exactly one request');
    assert.equal(sent.find((s) => s.body.includes(KEY)).path, '/api/stock/settings');
    assert.ok(!(await page.content()).includes(KEY), 'not in the page');
    const where = await page.evaluate((k) => ({
      inputs: [...document.querySelectorAll('input, textarea, select')].some((i) => i.value.includes(k)),
      attrs: [...document.querySelectorAll('*')].some((e) => [...e.attributes].some((a) => a.value.includes(k))),
      storage: JSON.stringify([{ ...localStorage }, { ...sessionStorage }]).includes(k),
      text: document.body.innerText.includes(k),
    }), KEY);
    assert.deepEqual(where, { inputs: false, attrs: false, storage: false, text: false });
    assert.ok(answers.length >= 3 && answers.every((a) => !a.includes(KEY)), 'no answer from Nordle carries the key back');
    assert.equal(loadStock().libraries.pexels.key, KEY, 'it is in the private settings file');
    assert.ok(stockPath().startsWith(state), 'which is the temporary one, never the real .nordle/stock.json');
  });
});

test('Test shows the library\'s own message, success or not; Replace takes a new key; Forget key and Remove ask first', async () => {
  await studioPage(async ({ page, open }) => {
    addPexels(WRONG);
    await openStock(page, open);
    assert.equal(await tab(page), 'Search', 'a library with a key is ready, so it opens on Search');
    await page.click('.stk-tab[data-tab="libs"]');
    const pexels = card(page, 'pexels');   // added already, so it is listed without choosing it
    await pexels.locator('[data-act="stock-test"]').click();
    await page.waitForSelector('.stk-lib[data-library="pexels"] .acc-banner.bad');
    assert.match(await pexels.locator('.acc-banner').innerText(), /Pexels did not work[\s\S]*Pexels refused the key \(401\)/);
    assert.ok(!(await pexels.innerText()).includes(WRONG), 'even a refused key is never echoed');
    // Replace: the box opens empty, Cancel closes it again
    await pexels.locator('[data-act="stock-replace"]').click();
    await page.waitForSelector('[data-field="stock-key-pexels"]');
    assert.equal(await page.inputValue('[data-field="stock-key-pexels"]'), '');
    await pexels.locator('[data-act="stock-replace-cancel"]').click();
    assert.equal(await pexels.locator('[data-field="stock-key-pexels"]').count(), 0);
    await pexels.locator('[data-act="stock-replace"]').click();
    await page.fill('[data-field="stock-key-pexels"]', KEY);
    await page.press('[data-field="stock-key-pexels"]', 'Enter');
    await page.waitForSelector('.stk-lib[data-library="pexels"] .acc-banner.ok:has-text("Key saved")');
    assert.match(await pexels.locator('.acc-banner').innerText(), /Key saved\. Pexels works/);
    assert.equal(loadStock().libraries.pexels.key, KEY);
    await pexels.locator('[data-act="stock-test"]').click();
    await page.waitForFunction(() => { const b = document.querySelector('.stk-lib[data-library="pexels"] .acc-banner'); return b && !/Key saved/.test(b.textContent) && /works/.test(b.textContent); });
    assert.doesNotMatch(await pexels.locator('.acc-banner').innerText(), /Key saved/, 'a plain Test says only that it works');
    // Forget key: asks, and Cancel changes nothing
    await pexels.locator('[data-act="stock-forget"]').click();
    await page.locator('dialog[open]').last().locator('.df .btn', { hasText: 'Cancel' }).click();
    assert.equal(loadStock().libraries.pexels.key, KEY);
    await pexels.locator('[data-act="stock-forget"]').click();
    await confirmLast(page);
    await page.waitForSelector('.stk-lib[data-library="pexels"] [data-field="stock-key-pexels"]');
    assert.equal(loadStock().libraries.pexels.key, undefined, 'the key is gone from the settings');
    assert.equal(await pexels.getAttribute('data-state'), 'needs-key');
    // Remove: asks, and the card goes back to "not added"
    await pexels.locator('[data-act="stock-remove"]').click();
    await confirmLast(page);
    await page.waitForSelector('.stk-lib[data-library="pexels"]', { state: 'detached' });   // gone from the list...
    assert.ok((await page.locator('[data-field="stock-pick"] option').evaluateAll((os) => os.map((o) => o.value))).includes('pexels'), '...and offered in the list to choose from again');
    assert.equal(loadStock().libraries.pexels, undefined);
  });
});

test('search: only ready libraries and their own kinds; cards with pictures through Nordle, the licence, a safe link; paging', async () => {
  await studioPage(async ({ page, open, call }) => {
    addPexels();
    saveStockSettings({ library: 'pixabay', preset: 'pixabay' }, 'human');       // added, but no key: not ready
    const remote = [];
    // (a local ad blocker may add requests of its own to the page, so only a library or its picture servers count)
    page.on('request', (r) => { const u = new URL(r.url()); if (/pexels|pixabay|envato|freesound/.test(u.hostname)) remote.push(r.url()); });
    await openStock(page, open);
    assert.equal(await tab(page), 'Search');
    assert.deepEqual(await page.locator('[data-field="stock-library"] option').allInnerTexts(), ['Pexels'], 'Pixabay has no key yet, so it is not offered');
    assert.deepEqual(await page.locator('[data-field="stock-kind"] option').allInnerTexts(), ['Photos', 'Video']);
    await page.click('[data-act="stock-search"]');
    assert.match(await page.locator('.stk-problem').innerText(), /Say what to look for/, 'an empty search is told so');
    assert.equal(calls.length, 0, 'and nothing was asked of the library');
    await search(page, 'oranges');
    assert.match(await page.locator('.stk-sum').innerText(), /12 results of about 30 for “oranges” in Pexels \(photos\), page 1/);
    assert.equal(await page.locator('.stk-item').count(), 12);
    const first = page.locator('.stk-item').first();
    assert.match(await first.innerText(), /A bowl of oranges number 100[\s\S]*by Ana Example[\s\S]*4000 × 3000[\s\S]*Licence: Pexels licence: free to use/);
    // the picture is served by Nordle and really loads; the page itself never talks to a library's server
    const src = await first.locator('img').getAttribute('src');
    assert.match(src, /^\/api\/stock\/thumb\?url=https%3A%2F%2Fimages\.pexels\.com%2Fphotos%2F100%2Fmedium\.png&t=/);
    await page.waitForFunction(() => { const i = document.querySelector('.stk-item img'); return i?.complete && i.naturalWidth === 48; });
    assert.deepEqual(remote, [], 'the page never asked a library\'s server for anything: pictures come through Nordle');
    assert.ok(calls.some((c) => c.url === 'https://images.pexels.com/photos/100/medium.png' && c.headers.Authorization === undefined), 'Nordle fetched it, without the key');
    // the link to the library's page
    const link = first.locator('a[data-act="stock-view"]');
    assert.deepEqual([await link.getAttribute('href'), await link.getAttribute('target'), await link.getAttribute('rel')], ['https://www.pexels.com/photo/oranges-100/', '_blank', 'noopener noreferrer']);
    assert.match(await link.innerText(), /View on Pexels/);
    assert.equal(await page.locator('.stk-item a:not([href^="https://"])').count(), 0, 'every link is https');
    // paging
    assert.match(await page.locator('.stk-page').innerText(), /Page 1 of about 3/);
    assert.equal(await page.locator('[data-act="stock-prev"]').isDisabled(), true);
    await page.click('[data-act="stock-next"]');
    await page.waitForFunction(() => /page 2\./.test(document.querySelector('.stk-sum')?.textContent ?? ''));
    assert.ok(calls.some((c) => c.url.includes('page=2')), 'the second page was asked for');
    assert.match(await page.locator('.stk-item').first().innerText(), /number 200/);
    assert.equal(await page.locator('[data-act="stock-prev"]').isDisabled(), false);
    await page.click('[data-act="stock-prev"]');
    await page.waitForFunction(() => /page 1\./.test(document.querySelector('.stk-sum')?.textContent ?? ''));
    // results are announced for screen readers
    assert.match(await page.locator('dialog.stk-dialog p.sr[role="status"]').innerText(), /12 results of about 30 for “oranges” in Pexels/);
    // a kind of its own: video
    await search(page, 'sea', { kind: 'video' });
    assert.match(await page.locator('.stk-item').first().innerText(), /0:12[\s\S]*calm sea 77[\s\S]*1920 × 1080/, 'a video is titled by the words in its address and shows its length');
    assert.equal(await page.locator('.stk-item .stk-dur').innerText(), '0:12');
    // Claude's token can search through the same route, and read the pictures too
    const agentSearch = await call('/stock/search?library=pexels&q=oranges&kind=photo', 'GET', undefined, AGENT);
    assert.equal(agentSearch.status, 200);
    const thumbRes = await fetch(`${page.url().split('#')[0]}api/stock/thumb?url=${encodeURIComponent(agentSearch.body.items[0].thumb)}`, { headers: { 'x-nordle-token': AGENT } });
    assert.equal(thumbRes.status, 200);
  });
});

test('Use in…: saves the file in the project the window is filtered to, says where, under what licence, and that nobody has looked at it', async () => {
  await studioPage(async ({ page, open, call, work, errors }) => {
    addPexels();
    const { projects } = await overview(call);
    const second = projects[1];
    await openStock(page, open, `#/s/month?brand=${second.id}&today=${TODAY}`);
    assert.equal(await page.inputValue('[data-field="stock-project"]'), second.id, 'the brand the Studio is filtered to is the default');
    assert.deepEqual(await page.locator('[data-field="stock-project"] option').allInnerTexts(), projects.map((p) => p.name));
    await search(page, 'oranges');
    const useBtn = page.locator('.stk-item').first().locator('[data-act="stock-use"]');
    assert.equal(await useBtn.innerText(), 'Use in…');
    const described = await useBtn.getAttribute('aria-describedby');
    assert.equal(await page.locator(`#${described}`).innerText(), 'A bowl of oranges number 100', 'read out as "Use in…, <the picture\'s title>"');
    assert.equal(await page.locator('.stk-use-l .lbl-i').innerText(), 'USE IN');
    await useBtn.click();
    await page.waitForSelector('.stk-toast.ok');
    const toast = await page.locator('.stk-toast').innerText();
    assert.match(toast, new RegExp(`Saved to ${second.name}: assets/stock/pexels-100\\.png`));
    assert.match(toast, /Licence: Pexels licence: free to use/);
    assert.match(toast, /catalogued as “not looked at yet”: look at it and describe it before you use it/);
    const dir = join(work, 'projects', second.id);
    assert.deepEqual(readFileSync(join(dir, 'assets', 'stock', 'pexels-100.png')), BIG, 'the original was saved in the project');
    const ledger = JSON.parse(readFileSync(join(dir, 'assets', 'stock', 'licences.json'), 'utf8'));
    assert.equal(ledger.items['assets/stock/pexels-100.png'].by, 'owner');
    assert.match(JSON.parse(readFileSync(join(dir, 'assets', 'catalog.json'), 'utf8')).items['assets/stock/pexels-100.png'].shows, /Not looked at yet/);
    assert.match(await page.locator('.stk-item').first().locator('.stk-done').innerText(), new RegExp(`In ${second.name}:\\s*assets/stock/pexels-100\\.png`), 'the card remembers it');
    assert.equal(await useBtn.isDisabled(), false, 'and can be used again, in another project');
    // the same item again: nothing is fetched again, and it says so
    calls.length = 0;
    await useBtn.click();
    await page.waitForFunction(() => /Already in/.test(document.querySelector('.stk-toasts')?.textContent ?? ''));
    assert.match(await page.locator('.stk-toast').last().innerText(), /Already in .*Nothing was fetched again/);
    assert.equal(calls.filter((c) => c.url.includes('original.png')).length, 0);
    // another project, chosen in the window
    await page.selectOption('[data-field="stock-project"]', projects[0].id);
    await page.locator('.stk-item').nth(1).locator('[data-act="stock-use"]').click();
    await page.waitForFunction((name) => document.querySelector('.stk-toasts')?.textContent.includes(`Saved to ${name}`), projects[0].name);
    assert.ok(existsSync(join(work, 'projects', projects[0].id, 'assets', 'stock', 'pexels-101.png')));
    // a failure is said plainly, and the button comes back
    handler = (u, i) => (u.pathname.endsWith('original.png') ? { status: 500, json: {} } : internet(u, i));
    await page.locator('.stk-item').nth(2).locator('[data-act="stock-use"]').click();
    await page.waitForSelector('.stk-toast.error');
    assert.match(await page.locator('.stk-toast.error').innerText(), /was not brought in[\s\S]*would not send the file/);
    assert.equal(await page.locator('.stk-item').nth(2).locator('[data-act="stock-use"]').isDisabled(), false);
    assert.deepEqual(errors.splice(0).filter((e) => !/status of 502/.test(e)), [], 'the one refusal was on purpose (the browser logs it as "Failed to load resource")');
  });
});

test('a search-only library (Envato Market) shows its results with a link to buy, but no "Use in…", and says how to add the file', async () => {
  await studioPage(async ({ page, open }) => {
    addPexels();
    addEnvato();
    await openStock(page, open);
    await page.selectOption('[data-field="stock-library"]', 'envato-market');
    assert.equal(await page.locator('.stk-note-dl').isVisible(), true);
    assert.match(await page.locator('.stk-note-dl').innerText(), /You can look here but not download: buy it on Envato Market, then add the file through a folder library/);
    await search(page, 'sunrise', { kind: 'video' });
    assert.equal(await page.locator('.stk-item').count(), 2);
    assert.equal(await page.locator('[data-act="stock-use"]').count(), 0, 'no download from a library that sells its files');
    const view = page.locator('.stk-item').first().locator('a[data-act="stock-view"]');
    assert.equal(await view.getAttribute('href'), 'https://videohive.net/item/beach-sunrise-opener/9001');
    assert.match(await view.innerText(), /View on Envato Market/);
    await page.waitForFunction(() => document.querySelector('.stk-item img')?.naturalWidth === 48);
    // and a library that can download hides the note again
    await page.selectOption('[data-field="stock-library"]', 'pexels');
    assert.equal(await page.locator('.stk-note-dl').isVisible(), false);
    assert.equal(await page.locator('.stk-item').count(), 0, 'the old results are cleared when the library changes');
  });
});

test('a folder of your own stock: add it (with a full path, what is in it, a licence), search it, bring a file in, remove it', async () => {
  await studioPage(async ({ page, open, work }) => {
    const folder = join(state, 'my-downloads');
    mkdirSync(join(folder, 'Beaches'), { recursive: true });
    writeFileSync(join(folder, 'Beaches', 'sunrise over the bay.mp4'), 'video bytes');
    writeFileSync(join(folder, 'notes.txt'), 'not media');
    await openStock(page, open);
    const form = page.locator('.stk-folders');
    // a path that is not a full path is told so
    await form.locator('[data-field="stock-folder-path"]').fill('Stock Videos');
    await form.locator('[data-act="stock-folder-add"]').click();
    await page.waitForSelector('.stk-folders .acc-banner.bad');
    assert.match(await form.locator('.acc-banner').innerText(), /full path of the folder, such as D:\/Stock\/Videos/);
    assert.deepEqual(loadStock().libraries, {}, 'nothing was saved');
    // nothing ticked is told so too
    await form.locator('[data-field="stock-folder-path"]').fill(folder);
    await form.locator('[data-field="stock-folder-kind-video"]').uncheck();
    await form.locator('[data-act="stock-folder-add"]').click();
    await page.waitForFunction(() => /Tick what the folder holds/.test(document.querySelector('.stk-folders .acc-banner')?.textContent ?? ''));
    await form.locator('[data-field="stock-folder-kind-video"]').check();
    // a name that is already a library's gets a number: the library is never taken over
    await form.locator('[data-field="stock-folder-name"]').fill('Pexels');
    await form.locator('[data-field="stock-folder-license"]').fill('Envato Elements licence: register each download to a project in Envato’s own tool');
    await form.locator('[data-act="stock-folder-add"]').click();
    await page.waitForSelector('.stk-folders .acc-banner.ok');
    assert.match(await form.locator('.acc-banner').innerText(), /Pexels added[\s\S]*The folder is there/);
    const entry = loadStock().libraries['pexels-2'];
    assert.deepEqual([entry.type, entry.path, entry.kinds, entry.name], ['folder', folder, ['video'], 'Pexels']);
    assert.match(entry.license, /register each download/);
    assert.equal(await form.locator('.stk-frow').count(), 1);
    assert.match(await form.locator('.stk-frow').innerText(), /Pexels[\s\S]*video[\s\S]*my-downloads[\s\S]*Licence: Envato Elements licence/);
    assert.equal(await form.locator('[data-field="stock-folder-path"]').inputValue(), '', 'the form is emptied');
    assert.equal(await page.locator('.stk-lib[data-library="pexels-2"]').count(), 0, 'a folder is listed in its own section, not among the online libraries');
    // searched by file and folder names; a file is copied in, never moved
    await page.click('.stk-tab[data-tab="search"]');
    assert.deepEqual(await page.locator('[data-field="stock-kind"] option').allInnerTexts(), ['Video']);
    await search(page, 'sunrise bay');
    assert.equal(await page.locator('.stk-item').count(), 1);
    assert.equal(await page.locator('.stk-item .stk-ph').count(), 1, 'no picture to show: a stand-in');
    assert.equal(await page.locator('.stk-item a').count(), 0, 'and no page to link to');
    await page.locator('.stk-item [data-act="stock-use"]').click();
    await page.waitForSelector('.stk-toast.ok');
    const into = await page.inputValue('[data-field="stock-project"]');
    const saved = readdirSync(join(work, 'projects', into, 'assets', 'stock')).filter((n) => n.endsWith('.mp4'));
    assert.equal(saved.length, 1);
    assert.match(await page.locator('.stk-toast').innerText(), /Licence: Envato Elements licence: register each download/);
    assert.ok(existsSync(join(folder, 'Beaches', 'sunrise over the bay.mp4')), 'copied, never moved');
    // an empty answer is a plain sentence
    await search(page, 'zzz');
    assert.match(await page.locator('.stk-results').innerText(), /Nothing found for “zzz” in Pexels[\s\S]*searched by file and folder names/);
    // remove it
    await page.click('.stk-tab[data-tab="libs"]');
    await page.locator('.stk-frow [data-act="stock-folder-remove"]').click();
    await confirmLast(page);
    await page.waitForFunction(() => !document.querySelector('.stk-frow'));
    assert.equal(loadStock().libraries['pexels-2'], undefined);
    assert.ok(existsSync(join(folder, 'Beaches', 'sunrise over the bay.mp4')), 'the files in the folder are not touched');
    // a folder that is not there is added, but says it cannot be read
    await form.locator('[data-field="stock-folder-path"]').fill(join(state, 'unplugged-drive'));
    await form.locator('[data-act="stock-folder-add"]').click();
    await page.waitForSelector('.stk-folders .acc-banner.bad');
    assert.match(await form.locator('.acc-banner').innerText(), /added, but it cannot be read yet[\s\S]*is not there \(is the drive connected\?\)/);
  });
});

test('plain words when something is wrong: no library ready, a refused key (with the way to fix it), a library that says wait, nothing found', async () => {
  await studioPage(async ({ page, open, errors }) => {
    await openStock(page, open);
    await page.click('.stk-tab[data-tab="search"]');
    assert.match(await page.locator('.stk-empty').innerText(), /No library is ready to search yet[\s\S]*Libraries tab/);
    await page.click('.stk-empty [data-act="stock-go-libs"]');
    assert.equal(await tab(page), 'Libraries');
    // a key the library refuses (the window is closed and opened again: it asks the server what is ready each time it opens)
    addPexels(WRONG);
    await page.keyboard.press('Escape');
    await page.click('.rail-foot [data-act="open-stock"]');
    await page.waitForSelector('.stk-bar');
    await page.fill('[data-field="stock-q"]', 'oranges');
    await page.click('[data-act="stock-search"]');
    await page.waitForSelector('.stk-problem:has-text("refused")');
    assert.match(await page.locator('.stk-problem').innerText(), /Pexels refused the key \(401\)/);
    assert.ok(!(await page.locator('dialog.stk-dialog').innerText()).includes(WRONG));
    await page.click('.stk-problem [data-act="stock-go-libs"]');
    assert.equal(await tab(page), 'Libraries');
    // a limit
    addPexels();
    handler = (u) => (u.hostname === 'api.pexels.com' ? { status: 429, json: {} } : undefined);
    await page.click('.stk-tab[data-tab="search"]');
    await page.click('[data-act="stock-search"]');
    await page.waitForSelector('.stk-problem');
    assert.match(await page.locator('.stk-problem').innerText(), /the limit is reached for now \(429\)/);
    assert.equal(await page.locator('.stk-problem [data-act="stock-retry"]').count(), 1, 'a limit is worth trying again later');
    handler = undefined;
    await page.click('.stk-problem [data-act="stock-retry"]');
    await page.waitForSelector('.stk-sum');
    // nothing found
    await search(page, 'nothing at all');
    assert.match(await page.locator('.stk-results').innerText(), /Nothing found for “nothing at all” in Pexels[\s\S]*Try other words/);
    // Nordle itself not answering
    await page.route('**/api/stock/search*', (route) => route.abort());
    await page.click('[data-act="stock-search"]');
    await page.waitForSelector('.stk-problem:has-text("did not answer")');
    assert.match(await page.locator('.stk-problem').innerText(), /Nordle did not answer\. Is it still running\? Nothing was lost\./);
    // the browser logs the refusals above as console errors ("Failed to load resource"): they were on purpose, nothing else may be there
    assert.deepEqual(errors.splice(0).filter((e) => !/status of (401|429)|ERR_FAILED/.test(e)), []);
  });
});

test('the agent token cannot save a key or test a connection (403), but can search; the owner\'s key never reaches Claude', async () => {
  await studioPage(async ({ call }) => {
    const refused = await call('/stock/settings', 'POST', { library: 'pexels', preset: 'pexels', key: KEY }, AGENT);
    assert.equal(refused.status, 403);
    assert.equal(existsSync(stockPath()), false, 'nothing was saved');
    assert.equal((await call('/stock/test', 'POST', { library: 'pexels' }, AGENT)).status, 403);
    assert.equal((await call('/stock/settings', 'POST', { library: 'pexels', remove: true }, AGENT)).status, 403);
    addPexels();
    const libs = await call('/stock/libraries', 'GET', undefined, AGENT);
    assert.equal(libs.status, 200);
    assert.ok(!JSON.stringify(libs.body).includes(KEY));
    assert.deepEqual(libs.body.libraries.find((l) => l.id === 'pexels').hasKey, true, 'it can see that a key is saved, never the key');
    const found = await call('/stock/search?library=pexels&q=oranges&kind=photo', 'GET', undefined, AGENT);
    assert.equal(found.status, 200);
    assert.equal(found.body.items.length, 15);
  });
});

test('dark and light, keyboard only, and reduced motion', async () => {
  for (const scheme of ['light', 'dark']) {
    await studioPage(async ({ page, open }) => {
      addPexels();
      delayMs = 600;
      await openStock(page, open);
      const look = await page.evaluate(() => { const d = getComputedStyle(document.querySelector('dialog.stk-dialog')); return { bg: d.backgroundColor, fg: d.color }; });
      assert.deepEqual(look, scheme === 'dark' ? { bg: 'rgb(27, 30, 33)', fg: 'rgb(236, 233, 224)' } : { bg: 'rgb(251, 250, 247)', fg: 'rgb(23, 25, 27)' }, `the window follows the ${scheme} theme`);
      // keyboard only: the tab list takes the arrow keys; Enter in the box searches; Tab reaches the buttons
      await page.focus('.stk-tab[aria-selected="true"]');
      await page.keyboard.press('ArrowLeft');
      assert.equal(await tab(page), 'Libraries');
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'stk-tab-libs');
      await page.keyboard.press('ArrowRight');
      assert.equal(await tab(page), 'Search');
      await page.focus('[data-field="stock-q"]');
      await page.keyboard.type('oranges');
      await page.keyboard.press('Enter');
      await page.waitForSelector('.stk-loading .stk-spin');
      const spin = await page.evaluate(() => getComputedStyle(document.querySelector('.stk-spin')).animationName);
      assert.equal(spin, 'stk-spin', 'the spinner turns while it waits');
      await page.waitForSelector('.stk-sum');
      assert.equal(await page.evaluate(() => document.activeElement?.className), 'stk-sum', 'the focus moves to the summary, which is read out');
      await page.focus('.stk-item [data-act="stock-use"]');
      await page.keyboard.press('Enter');
      await page.waitForSelector('.stk-toast.ok');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('dialog[open]').count(), 0, 'Escape closes the window');
    }, { scheme, viewport: { width: 1280, height: 860 } });
  }
  await studioPage(async ({ page, open }) => {
    addPexels();
    delayMs = 600;
    await openStock(page, open);
    await page.fill('[data-field="stock-q"]', 'oranges');
    await page.click('[data-act="stock-search"]');
    await page.waitForSelector('.stk-loading .stk-spin');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.stk-spin')).animationName), 'none', 'reduced motion: no spinning');
    await page.waitForSelector('.stk-sum');
  }, { reducedMotion: 'reduce' });
});

test('on a phone-width screen the window still fits and the cards stack', async () => {
  await studioPage(async ({ page, open }) => {
    addPexels();
    await open(`#/s/month?today=${TODAY}`);
    // the rail is hidden on a phone (as it is for Publishing), so open the window the way the rail's button does
    await page.evaluate(() => document.querySelector('[data-act="open-stock"]').click());
    await page.waitForSelector('dialog.stk-dialog[open] .stk-bar');
    await search(page, 'oranges');
    const fits = await page.evaluate(() => { const d = document.querySelector('dialog.stk-dialog').getBoundingClientRect(); const db = document.querySelector('dialog.stk-dialog .db'); return { dialogW: Math.round(d.width), vw: innerWidth, overflowX: db.scrollWidth > db.clientWidth + 1 }; });
    assert.ok(fits.dialogW <= fits.vw, 'inside the screen');
    assert.equal(fits.overflowX, false, 'nothing sideways to scroll');
  }, { viewport: { width: 390, height: 800 } });
});

test('a library added without a key stays one slim line until Set up; a folder is given to chosen brands and that can be changed', async () => {
  await studioPage(async ({ page, open, call }) => {
    const folder = join(state, 'brand-downloads');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'sunrise bay.mp4'), 'video bytes');
    saveStockSettings({ library: 'pexels', preset: 'pexels' }, 'human');
    await openStock(page, open);
    const slim = page.locator('.stk-lib[data-library="pexels"]');
    assert.equal(await slim.getAttribute('data-minimised'), 'true');
    assert.equal(await slim.locator('[data-field="stock-key-pexels"]').count(), 0, 'nothing to fill in until it is opened');
    await slim.locator('[data-act="stock-open"]').click();
    await page.waitForSelector('.stk-lib[data-library="pexels"] [data-field="stock-key-pexels"]');
    assert.equal(await page.locator('.stk-lib[data-library="pexels"]').getAttribute('data-minimised'), null);

    const ids = (await call('/projects')).body.projects.map((p) => p.id);
    assert.ok(ids.length >= 2);
    const form = page.locator('.stk-folders');
    await form.locator('[data-field="stock-folder-path"]').fill(folder);
    await form.locator(`[data-field="stock-folder-brand-${ids[0]}"]`).check();
    await form.locator('[data-act="stock-folder-add"]').click();
    await page.waitForSelector('.stk-folders .acc-banner.ok');
    const id = Object.keys(loadStock().libraries).find((k) => loadStock().libraries[k].type === 'folder');
    assert.deepEqual(loadStock().libraries[id].brands, [ids[0]]);
    const row = form.locator('.stk-frow .stk-brands');
    assert.equal(await row.getAttribute('data-brands'), ids[0]);

    await form.locator('.stk-frow [data-act="stock-brands"]').click();
    await form.locator(`.stk-frow input[data-brand="${ids[1]}"]`).check();
    await form.locator('.stk-frow [data-act="stock-brands-save"]').click();
    await page.waitForFunction((v) => document.querySelector('.stk-frow .stk-brands')?.dataset.brands === v, `${ids[0]},${ids[1]}`);
    assert.deepEqual(loadStock().libraries[id].brands, [ids[0], ids[1]]);

    await form.locator('.stk-frow [data-act="stock-brands"]').click();
    for (const b of ids.slice(0, 2)) await form.locator(`.stk-frow input[data-brand="${b}"]`).uncheck();
    await form.locator('.stk-frow [data-act="stock-brands-save"]').click();
    await page.waitForFunction(() => document.querySelector('.stk-frow .stk-brands')?.dataset.brands === '');
    assert.equal(loadStock().libraries[id].brands, undefined, 'empty means every brand');
  });
});
