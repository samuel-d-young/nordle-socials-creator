// Browser session for rendering. Pages are served from a pretend host (nordle.local) by request interception,
// so a document can only ever read files inside its own project folder (and the bundled fonts), and nothing
// else on disk or on the network.

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { chromium } from 'playwright-core';
import { ROOT } from '../../tools/validate.mjs';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
};

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());

/**
 * Should Chromium run inside its own sandbox? The renderer decodes pictures, SVGs and fonts that came from outside (a stock library, a scanned website, a cloned
 * project), so the sandbox is on wherever it works: Windows and macOS by default. On Linux it is off unless NORDLE_CHROMIUM_SANDBOX=1, because containers and CI
 * runners usually cannot create the namespaces it needs. NORDLE_NO_CHROMIUM_SANDBOX=1 turns it off everywhere (playwright adds --no-sandbox unless it is true).
 */
export function chromiumSandboxOn({ platform = process.platform, env = process.env } = {}) {
  if (truthy(env.NORDLE_NO_CHROMIUM_SANDBOX)) return false;
  if (platform === 'win32' || platform === 'darwin') return true;
  return truthy(env.NORDLE_CHROMIUM_SANDBOX);
}

export async function openBrowser() {
  const attempts = [{}, { channel: 'chrome' }, { channel: 'msedge' }];
  const chromiumSandbox = chromiumSandboxOn();
  let last;
  for (const opts of attempts) {
    try {
      return await chromium.launch({ headless: true, chromiumSandbox, args: ['--force-color-profile=srgb', '--font-render-hinting=none'], ...opts });
    } catch (e) { last = e; }
  }
  throw new Error(`No browser available for rendering. Run: npx playwright-core install chromium\n(${String(last?.message).split('\n')[0]})${chromiumSandbox ? '\nChromium runs in its sandbox here; if the sandbox is what fails, set NORDLE_NO_CHROMIUM_SANDBOX=1.' : ''}`);
}

/** Resolve a request path under a base folder, refusing anything that escapes it (including through symlinks). */
function containedFile(base, rel) {
  let decoded;
  try { decoded = decodeURIComponent(rel); } catch { return null; }
  const abs = resolve(base, decoded);
  if (abs !== base && !abs.startsWith(base + sep)) return null;
  try {
    const real = realpathSync(abs);
    const realBase = realpathSync(base);
    if (real !== realBase && !real.startsWith(realBase + sep)) return null;
    return statSync(real).isFile() ? real : null;
  } catch { return null; }
}

/**
 * One browser page sized to a canvas. Call show(html) for each page you want to render.
 * @returns {{page:import('playwright-core').Page, show:(html:string)=>Promise<void>, close:()=>Promise<void>}}
 */
export async function newCanvas(browser, { projectDir, width, height, scale = 1 }) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, serviceWorkers: 'block' });
  const page = await context.newPage();
  const jobs = new Map();
  const projectBase = resolve(projectDir);
  const fontBase = join(ROOT, 'fonts');

  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'nordle.local') return route.abort('blockedbyclient');
    const headers = { 'cache-control': 'no-store', 'access-control-allow-origin': '*' };
    if (url.pathname.startsWith('/job/')) {
      const html = jobs.get(url.pathname);
      return html === undefined
        ? route.fulfill({ status: 404, body: 'no such job' })
        : route.fulfill({ status: 200, headers, contentType: TYPES['.html'], body: html });
    }
    const [base, prefix] = url.pathname.startsWith('/project/') ? [projectBase, '/project/'] : url.pathname.startsWith('/fonts/') ? [fontBase, '/fonts/'] : [null, ''];
    const file = base ? containedFile(base, url.pathname.slice(prefix.length)) : null;
    const type = file ? TYPES[extname(file).toLowerCase()] : null;
    if (!file || !type) return route.fulfill({ status: 404, headers, body: 'not found' });
    return route.fulfill({ status: 200, headers, contentType: type, body: readFileSync(file) });
  });

  let n = 0;
  return {
    page,
    async show(html) {
      const key = `/job/${++n}.html`;
      jobs.set(key, html);
      await page.goto(`http://nordle.local${key}`, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      jobs.delete(key);
    },
    close: () => context.close(),
  };
}
