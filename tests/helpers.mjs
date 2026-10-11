// Shared by the browser tests: a fresh copy of the sample project, a server, and a page opened on one document.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../tools/validate.mjs';
import { openBrowser } from '../src/render/browser.mjs';
import { createNordleServer } from '../src/server/http.mjs';

export const TOKEN = 'e2e-token-0123456789abcdef012345678';
export const AGENT = 'e2e-agent-token-0123456789abcdef0123';
export const P = 'little-gannet';
let browserPromise;
export const getBrowser = () => (browserPromise ??= openBrowser());
export async function closeBrowser() { if (browserPromise) { await (await browserPromise).close(); browserPromise = undefined; } }

/** A fresh copy of the sample project, its own server, and a page opened on one document. */
export async function editor(docId, fn, { viewport = { width: 1440, height: 900 }, allowErrors = [] } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'nordle-e2e-'));
  cpSync(join(ROOT, 'samples', P), join(work, 'projects', P), { recursive: true, filter: (s) => !/[\\/](out|sources)([\\/]|$)/.test(s) });
  const app = createNordleServer({ roots: [join(work, 'projects')], token: TOKEN, agentToken: AGENT });
  const port = await app.listen(0);
  const context = await (await getBrowser()).newContext({ viewport, acceptDownloads: false });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const api = async (path, method = 'GET', body) => {
    const res = await fetch(`http://127.0.0.1:${port}/api${path}`, { method, headers: { 'x-nordle-token': TOKEN, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return res.json();
  };
  const doc = async () => (await api(`/projects/${P}/docs/${docId}`)).doc;
  const agent = async (path, method = 'GET', body) => {
    const res = await fetch(`http://127.0.0.1:${port}/api${path}`, { method, headers: { 'x-nordle-token': AGENT, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json() };
  };
  const ctx = { page, api, agent, doc, port, errors, work };
  try {
    await page.goto(`http://127.0.0.1:${port}/#/p/${P}/${docId}`);
    await ready(page);
    await fn(ctx);
    const unexpected = errors.filter((e) => !allowErrors.some((re) => re.test(e)));
    assert.deepEqual(unexpected, [], `the page reported errors: ${unexpected.join(' | ')}`);
  } finally {
    await context.close();
    await app.close();
    rmSync(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  }
}

export const ready = async (page) => {
  await page.waitForFunction(() => {
    const f = document.querySelector('.stage iframe:not(.back)');
    return f?.contentDocument?.querySelector('[data-layer]') && !document.querySelector('.stage iframe.back');
  });
};
export const settle = async (page) => {
  await page.waitForFunction(() => document.querySelector('.status')?.textContent === 'Saved');
  await page.waitForFunction(() => !document.querySelector('.stage iframe.back'));
  await page.waitForTimeout(60);
};
/** Page coordinates of a point given in canvas pixels (before zoom). */
export const at = async (page, x, y) => page.evaluate(([cx, cy]) => {
  const r = document.querySelector('.overlay').getBoundingClientRect();
  const zoom = r.width / document.querySelector('.stage iframe:not(.back)').offsetWidth;
  return { x: r.left + cx * zoom, y: r.top + cy * zoom };
}, [x, y]);
export const layerRect = (page, id) => page.evaluate((lid) => {
  const el = document.querySelector('.stage iframe:not(.back)').contentDocument.querySelector(`[data-layer="${lid}"]`);
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
}, id);
export const layerOf = (doc, id, page = 0) => doc.pages[page].layers.find((l) => l.id === id);
export const clickLayerRow = (page, text) => page.locator('.layer-row', { hasText: text }).first().click();
export const press = (page, key) => page.keyboard.press(key);
/** Native drag-and-drop cannot be started by a scripted mouse, so send the same events a browser would. */
export const htmlDrag = (page, fromSel, toSel) => page.evaluate(([a, b]) => {
  const from = document.querySelector(a), to = document.querySelector(b);
  const dt = new DataTransfer();
  from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
  to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
}, [fromSel, toSel]);
export const dragOnCanvas = async (page, from, to, steps = 8) => {
  const a = await at(page, from.x, from.y), b = await at(page, to.x, to.y);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps });
  await page.mouse.up();
};

