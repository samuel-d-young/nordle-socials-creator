// Shared by the Studio tests: a generated fictional workspace, a server on a random port per test, and a browser page.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { ROOT } from '../tools/validate.mjs';
import { buildWorkspace } from '../tools/studio-fixtures.mjs';
import { createNordleServer } from '../src/server/http.mjs';
import { loadCalendar, validateCalendar } from '../src/calendar/model.mjs';
import { closeBrowser, getBrowser, TOKEN, AGENT } from './helpers.mjs';


export const base = mkdtempSync(join(tmpdir(), 'nordle-studio-base-'));
export const built = await buildWorkspace(base, { brands: 2, months: ['2026-10', '2026-11'], size: 'small' });
// one finished post that is not on any calendar
export const LOOSE = 'loose-post';
{
  const dir = join(base, 'projects', built.projects[0].id);
  const src = loadCalendar(dir).items.find((i) => i.doc && i.format === 'carousel' && i.status === 'built');
  const doc = JSON.parse(readFileSync(join(dir, 'docs', `${src.doc}.json`), 'utf8'));
  doc.id = LOOSE; doc.title = 'A loose post';
  writeFileSync(join(dir, 'docs', `${LOOSE}.json`), JSON.stringify(doc, null, 2));
  cpSync(join(dir, 'out', src.doc), join(dir, 'out', LOOSE), { recursive: true });
  for (const f of ['_ig-feed-4x5_01-cover.png', '_ig-feed-4x5_02-p2.png', '_ig-feed-4x5_03-p3.png']) {
    try { cpSync(join(dir, 'out', LOOSE, `${src.doc}${f}`), join(dir, 'out', LOOSE, `${LOOSE}${f}`)); } catch { /* fewer pages */ }
  }
}
process.on('exit', () => { try { rmSync(base, { recursive: true, force: true }); } catch { /* temp */ } });

export const TODAY = '2026-10-05';

/** A fresh copy of the workspace and its own server. */
export async function studio(fn, { viewport = { width: 1440, height: 900 }, page: wantPage = false, scheme, reducedMotion, reviser, pickFolder, claudeRunner, pickFiles, importVideos, updateFetch, updateStateDir, brandReader } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'nordle-studio-e2e-'));
  cpSync(join(base, 'projects'), join(work, 'projects'), { recursive: true });
  const app = createNordleServer({ roots: [join(work, 'projects')], token: TOKEN, agentToken: AGENT, reviser, pickFolder, claudeRunner, pickFiles, importVideos, brandReader, updateFetch: updateFetch ?? (async () => { throw new Error('no network in tests'); }), updateStateDir: updateStateDir ?? join(work, '.nordle-update') });
  const port = await app.listen(0);
  const call = async (path, method = 'GET', body, token = TOKEN) => {
    const res = await fetch(`http://127.0.0.1:${port}/api${path}`, { method, headers: { 'x-nordle-token': token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
  };
  const calendarOf = (p) => loadCalendar(join(work, 'projects', p));
  const ctx = { port, call, work, calendarOf, errors: [], url: `http://127.0.0.1:${port}/` };
  let context;
  try {
    if (wantPage) {
      context = await (await getBrowser()).newContext({ viewport, colorScheme: scheme, reducedMotion });
      const page = await context.newPage();
      page.on('pageerror', (e) => ctx.errors.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error') ctx.errors.push(m.text()); });
      ctx.page = page;
      ctx.open = async (hash = '') => { await page.goto(`${ctx.url}${hash}`); await page.waitForSelector('.studio', { state: 'visible' }); await page.waitForFunction(() => document.querySelector('.s-main .view') && !document.querySelector('.skel')); };
    }
    await fn(ctx);
    assert.deepEqual(ctx.errors, [], `the page reported errors: ${ctx.errors.join(' | ')}`);
  } finally {
    await context?.close();
    await app.close();
    rmSync(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  }
}

export const studioPage = (fn, o = {}) => studio(fn, { ...o, page: true });
export const overview = async (call) => (await call(`/studio?today=${TODAY}`)).body;
export const firstWhere = (posts, fn) => posts.find(fn);
export const verifiedBuilt = (p) => p.status === 'built' && p.verified === true && p.format === 'carousel' && !p.openComments;

