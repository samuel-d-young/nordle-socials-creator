// Paints fictional posters (a headline on a brand's colours) with the bundled fonts, for the Studio demo and screenshots.
// Everything drawn is invented. Uses the same browser Nordle renders with; nothing is downloaded.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openBrowser } from '../src/render/browser.mjs';
import { ROOT } from './validate.mjs';

const b64 = (rel) => readFileSync(join(ROOT, 'fonts', rel)).toString('base64');
const FONTS = `
@font-face { font-family: 'F'; font-weight: 100 900; font-style: normal; src: url(data:font/woff2;base64,${b64('fraunces/files/fraunces-latin-wght-normal.woff2')}) format('woff2'); }
@font-face { font-family: 'F'; font-weight: 100 900; font-style: italic; src: url(data:font/woff2;base64,${b64('fraunces/files/fraunces-latin-wght-italic.woff2')}) format('woff2'); }
@font-face { font-family: 'I'; font-weight: 100 900; font-style: normal; src: url(data:font/woff2;base64,${b64('inter/files/inter-latin-wght-normal.woff2')}) format('woff2'); }
`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function html({ w, h, ground, shape, ink, variant, text, brand, kind, page, pages }) {
  const base = `<style>${FONTS}*{box-sizing:border-box;margin:0}html,body{width:${w}px;height:${h}px;overflow:hidden;background:${ground};color:${ink};font-family:'I',sans-serif}
.k{position:absolute;left:80px;top:84px;font:600 26px/1 'I';letter-spacing:.16em;text-transform:uppercase}
.fine{position:absolute;left:80px;bottom:70px;font:500 28px/1 'I';opacity:.7}
.sw{position:absolute;right:80px;bottom:70px;font:600 28px/1 'I'}</style>`;
  const handle = esc(brand.handle ?? '');
  const swipe = pages > 1 ? `<div class="sw">${page === pages - 1 ? '' : 'Swipe →'}</div>` : '';
  if (kind === 'reel') {
    return `${base}<style>.sun{position:absolute;left:50%;top:26%;width:620px;height:620px;margin-left:-310px;border-radius:50%;background:${shape}}
.band{position:absolute;left:0;right:0;top:0;height:42%;background:linear-gradient(${ground},transparent)}
.cap{position:absolute;left:70px;right:70px;top:62%;font:700 92px/1.04 'F';text-align:center;color:#fff;text-shadow:0 4px 0 rgba(0,0,0,.25)}
.cap em{font-style:italic;color:${shape};filter:brightness(1.35)}
.bar{position:absolute;left:70px;right:70px;bottom:150px;height:8px;background:rgba(255,255,255,.3)}.bar i{display:block;height:100%;width:34%;background:#fff}
.k{color:#fff;opacity:.85}</style><div class="sun"></div><div class="k">${esc(brand.name)}</div><div class="cap">${esc(text)}</div><div class="bar"><i></i></div>`;
  }
  const head = `font:650 ${text.length > 34 ? 104 : 128}px/1 'F';letter-spacing:-.02em;text-wrap:balance`;
  switch (variant % 4) {
    case 0:
      return `${base}<style>.c{position:absolute;right:-220px;bottom:-240px;width:860px;height:860px;border-radius:50%;background:${shape}}.h{position:absolute;left:80px;top:190px;width:880px;${head}}</style>
<div class="c"></div><div class="k">${esc(brand.name)}</div><div class="h">${esc(text)}</div><div class="fine">${handle}</div>${swipe}`;
    case 1:
      return `${base}<style>.b{position:absolute;left:0;top:0;bottom:0;width:62%;background:${shape}}.h{position:absolute;left:80px;top:230px;width:560px;${head};color:${ground}}.k{color:${ground}}.r{position:absolute;right:70px;top:84px;font:600 26px/1 'I';letter-spacing:.16em}</style>
<div class="b"></div><div class="k">${esc(brand.name)}</div><div class="h">${esc(text)}</div><div class="fine" style="color:${ground};opacity:.85">${handle}</div>${swipe}`;
    case 2:
      return `${base}<style>.q{position:absolute;left:60px;top:60px;font:italic 400 520px/1 'F';color:${shape};opacity:.9}.h{position:absolute;left:80px;top:420px;width:900px;font:italic 500 ${text.length > 34 ? 84 : 100}px/1.08 'F';letter-spacing:-.01em}.rule{position:absolute;left:80px;top:360px;width:120px;height:8px;background:${shape}}</style>
<div class="q">“</div><div class="rule"></div><div class="h">${esc(text)}</div><div class="fine">${esc(brand.name)}</div>${swipe}`;
    default:
      return `${base}<style>.n{position:absolute;left:60px;top:70px;font:600 440px/1 'F';color:${shape};letter-spacing:-.04em}.h{position:absolute;left:80px;bottom:200px;width:900px;${head}}</style>
<div class="n">${String((page ?? 0) + 1).padStart(2, '0')}</div><div class="h">${esc(text)}</div><div class="fine">${esc(brand.name)}</div>${swipe}`;
  }
}

export async function makePainter() {
  const browser = await openBrowser();
  const contexts = new Map();
  async function pageFor(scale) {
    if (!contexts.has(scale)) {
      const ctx = await browser.newContext({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: scale });
      contexts.set(scale, await ctx.newPage());
    }
    return contexts.get(scale);
  }
  return {
    async paint(spec) {
      const scale = spec.w / 1080;
      const h1080 = Math.round(spec.h / scale);
      const page = await pageFor(scale);
      await page.setViewportSize({ width: 1080, height: h1080 });
      await page.setContent(html({ ...spec, w: 1080, h: h1080 }), { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      return page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 1080, height: h1080 } });
    },
    async close() { await browser.close(); },
  };
}
