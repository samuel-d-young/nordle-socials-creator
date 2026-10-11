// Renders a Nordle document to image files, one per size and page.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { buildPageHtml } from './html.mjs';
import { NODE_URLS, loadFontManifest } from './urls.mjs';
import { renderSheet } from './sheet.mjs';
import { newCanvas, openBrowser } from './browser.mjs';
import { decodePng } from './checks.mjs';
import { loadDocContext, resolveSizes } from './context.mjs';
import { validateDocData } from '../../tools/validate.mjs';

/** Runs inside the page: where every layer ended up, and how its text looks. */
function inspectLayers() {
  const out = [];
  for (const el of document.querySelectorAll('[data-layer]')) {
    const cs = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    const type = el.dataset.type;
    const info = {
      id: el.dataset.layer, path: el.dataset.path, type, ignoreSafe: el.dataset.safe === '0', fixedH: el.dataset.fixedH === '1',
      boxRect: { x: box.x, y: box.y, w: box.width, h: box.height },
      alt: type === 'image' ? el.getAttribute('alt') : undefined,
    };
    if (type === 'text') {
      const range = document.createRange();
      range.selectNodeContents(el);
      const r = range.getBoundingClientRect();
      info.rect = { x: r.x, y: r.y, w: r.width, h: r.height };
      info.fontSize = parseFloat(cs.fontSize);
      info.fontWeight = cs.fontWeight;
      info.color = cs.color;
      // How far the text itself pokes out of its box (italic overhang is ignored: we measure advance widths).
      info.overflowX = Math.max(0, r.right - box.right);
      info.overflowY = Math.max(0, r.bottom - box.bottom);
      info.runs = [...el.querySelectorAll('[data-run]')].map((s) => {
        const rr = document.createRange();
        rr.selectNodeContents(s);
        const b = rr.getBoundingClientRect();
        return { color: getComputedStyle(s).color, rect: { x: b.x, y: b.y, w: b.width, h: b.height } };
      });
      // lines: group the text's line boxes by where they sit vertically
      const parts = [...range.getClientRects()].filter((q) => q.width > 1 && q.height > 1).sort((a, b) => a.top - b.top || a.left - b.left);
      const lines = [];
      for (const q of parts) {
        const last = lines[lines.length - 1];
        if (last && Math.abs((q.top + q.height / 2) - (last.top + last.height / 2)) < Math.max(q.height, last.height) * 0.5) {
          last.left = Math.min(last.left, q.left); last.right = Math.max(last.right, q.right);
          last.height = Math.max(last.height, q.height);
        } else {
          lines.push({ top: q.top, left: q.left, right: q.right, height: q.height });
        }
      }
      info.lineWidths = lines.map((l) => l.right - l.left);
      info.family = cs.fontFamily;
      info.align = cs.textAlign;
      info.textWrap = cs.textWrap || cs.getPropertyValue('text-wrap');
      info.text = el.textContent.replace(/\s+/g, ' ').trim();
    } else if (type === 'image') {
      info.naturalW = el.naturalWidth || 0;
      info.naturalH = el.naturalHeight || 0;
      info.vector = /\.svg(\?|$)/i.test(el.getAttribute('src') || '');
    }
    info.opacity = parseFloat(cs.opacity);
    out.push(info);
  }
  return out;
}

const pad = (n) => String(n).padStart(2, '0');

/**
 * @param {string} file path to a document
 * @param {{out?:string, sizes?:string[], pages?:string[], format?:'png'|'jpg', scale?:number, showSafe?:boolean,
 *          inspect?:boolean, onPage?:Function, browser?:object}} opts
 */
export async function renderDocument(file, opts = {}) {
  const ctx = loadDocContext(file);
  if (opts.doc) {
    // render a version of the document that is not saved (for example a suggestion that has not been accepted)
    ctx.doc = opts.doc;
    ctx.errors = validateDocData(opts.doc, { brand: ctx.brand, projectDir: ctx.projectDir, platforms: ctx.platforms, assets: true }).filter((i) => i.level === 'error');
  }
  const result ={ file: ctx.file, doc: ctx.doc, ctx, outputs: [], warnings: [], errors: ctx.errors, skipped: null };
  if (ctx.errors.length) return result;
  if (ctx.doc.kind === 'video') {
    result.skipped = 'Video documents are rendered by the video renderer (not built yet); this command handles graphics and carousels.';
    return result;
  }

  const format = opts.format ?? 'png';
  const scale = opts.scale ?? 1;
  const outDir = opts.out ?? join(ctx.projectDir, 'out', ctx.doc.id);
  mkdirSync(outDir, { recursive: true });

  let sizes = resolveSizes(ctx.doc, ctx.platforms);
  if (opts.sizes?.length) {
    const unknown = opts.sizes.filter((id) => !sizes.some((s) => s.id === id));
    if (unknown.length) throw new Error(`This document has no size "${unknown.join('", "')}". Its sizes: ${sizes.map((s) => s.id).join(', ')}`);
    sizes = sizes.filter((s) => opts.sizes.includes(s.id));
  }
  const pages = ctx.doc.pages.map((p, i) => ({ page: p, index: i })).filter(({ page }) => !opts.pages?.length || opts.pages.includes(page.id));
  if (opts.pages?.length && pages.length !== opts.pages.length) {
    throw new Error(`This document has no page "${opts.pages.filter((id) => !pages.some((p) => p.page.id === id)).join('", "')}". Its pages: ${ctx.doc.pages.map((p) => p.id).join(', ')}`);
  }

  const browser = opts.browser ?? (await openBrowser());
  try {
    for (const size of sizes) {
      const canvas = await newCanvas(browser, { projectDir: ctx.projectDir, width: size.w, height: size.h, scale });
      try {
        for (const { page, index } of pages) {
          const built = buildPageHtml({ doc: ctx.doc, brand: ctx.brand, size, page, showSafe: opts.showSafe, fontManifest: loadFontManifest(), urls: NODE_URLS });
          for (const w of built.warnings) if (!result.warnings.includes(w)) result.warnings.push(w);
          await canvas.show(built.html);

          const shot = await canvas.page.screenshot({
            type: format === 'jpg' ? 'jpeg' : 'png', quality: format === 'jpg' ? 92 : undefined,
            clip: { x: 0, y: 0, width: size.w, height: size.h },
          });
          const name = `${ctx.doc.id}_${size.id}_${pad(index + 1)}-${page.id}${opts.showSafe ? '.safe' : ''}.${format}`;
          const path = join(outDir, name);
          writeFileSync(path, shot);
          result.outputs.push({ path, size: size.id, page: page.id, w: size.w * scale, h: size.h * scale, bytes: shot.length });

          if (opts.inspect && opts.onPage) {
            const layers = await canvas.page.evaluate(inspectLayers);
            await canvas.page.addStyleTag({ content: '[data-type="text"]{visibility:hidden !important}#safe-overlay{display:none !important}' });
            const backdrop = decodePng(await canvas.page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: size.w, height: size.h } }));
            await opts.onPage({ size, page, index, layers, backdrop, scale });
          }
        }
      } finally {
        await canvas.close();
      }
    }
    if (opts.sheet && result.outputs.length && !opts.showSafe) {
      if (relative(ctx.projectDir, outDir).startsWith('..')) {
        result.warnings.push('Contact sheet skipped: the output folder is outside the project folder.');
      } else {
        result.sheet = await renderSheet({ browser, projectDir: ctx.projectDir, docId: ctx.doc.id, title: ctx.doc.title, outputs: result.outputs, outDir });
      }
    }
  } finally {
    if (!opts.browser) await browser.close();
  }
  return result;
}
