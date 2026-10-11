// A contact sheet: every rendered page of a document in one picture, one row per size. For reviewing at a glance.

import { writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { HOST } from './urls.mjs';
import { newCanvas } from './browser.mjs';

const CELL = 340, GAP = 24, PAD = 32, HEAD = 64, LABEL = 36, CAPTION = 30;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export async function renderSheet({ browser, projectDir, docId, title, outputs, outDir, scale = 1 }) {
  const rows = [];
  for (const o of outputs) {
    let row = rows.find((r) => r.size === o.size);
    if (!row) rows.push((row = { size: o.size, cells: [], imgH: 0 }));
    const h = Math.round((CELL * o.h) / o.w);
    row.cells.push({ ...o, imgH: h });
    row.imgH = Math.max(row.imgH, h);
  }
  const cols = Math.max(...rows.map((r) => r.cells.length));
  const width = PAD * 2 + cols * CELL + (cols - 1) * GAP;
  const height = HEAD + rows.reduce((sum, r) => sum + LABEL + r.imgH + CAPTION + GAP, 0) + PAD - GAP;

  const body = rows.map((r) => `<section><h2>${esc(r.size)}</h2><div class="row">${r.cells.map((c) => {
    const src = `${HOST}/project/${relative(projectDir, c.path).split(/[\\/]/).map(encodeURIComponent).join('/')}`;
    return `<figure><img src="${src}" width="${CELL}" height="${c.imgH}" alt=""><figcaption>${esc(c.page)}</figcaption></figure>`;
  }).join('')}</div></section>`).join('');

  const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${HOST}/fonts/inter/wght.css">
<style>
html,body{margin:0;background:#e9e6e1;font-family:'Inter Variable',system-ui,sans-serif;color:#1f2a2e;width:${width}px;height:${height}px;overflow:hidden}
header{height:${HEAD}px;padding:${PAD - 8}px ${PAD}px 0;box-sizing:border-box;font-size:22px;font-weight:600}
header span{font-weight:400;color:#6f7f83;margin-left:12px}
section{padding:0 ${PAD}px;margin-bottom:${GAP}px}
h2{margin:0;height:${LABEL}px;line-height:${LABEL}px;font-size:14px;letter-spacing:.08em;text-transform:uppercase;color:#6f7f83;font-weight:600}
.row{display:flex;gap:${GAP}px;align-items:flex-start}
figure{margin:0}img{display:block;box-shadow:0 2px 10px rgba(0,0,0,.18);background:#fff}
figcaption{font-size:13px;margin-top:6px;color:#44525a}
</style></head><body><header>${esc(title)}<span>${esc(docId)}</span></header>${body}</body></html>`;

  const canvas = await newCanvas(browser, { projectDir, width, height, scale });
  try {
    await canvas.show(html);
    await canvas.page.evaluate(() => Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; })))));
    const png = await canvas.page.screenshot({ type: 'png', clip: { x: 0, y: 0, width, height } });
    const path = join(outDir, 'sheet.png');
    writeFileSync(path, png);
    return path;
  } finally {
    await canvas.close();
  }
}
