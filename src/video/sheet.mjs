// The contact sheet for a video: a few frames from every scene, with the scene's name, its time, the clips that make it
// and what is said in it. For judging the cut at a glance, and for checking that the picture fits the words.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newCanvas } from '../render/browser.mjs';
import { HOST } from '../render/urls.mjs';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Scenes to show (the document's, or one per piece of the picture) and the times to take frames at. */
export function sheetScenes(plan) {
  const d = plan.duration;
  let scenes = plan.scenes.map((s) => ({ id: s.id, title: s.title ?? s.id, start: s.start, end: Math.min(s.end, d) }));
  if (!scenes.length) {
    scenes = plan.segments.map((s) => ({ id: s.clipId ?? 'black', title: s.clipId ?? 'black', start: s.s / plan.fps, end: s.e / plan.fps }));
  }
  const per = scenes.length > 12 ? 1 : scenes.length > 7 ? 2 : 3;
  return scenes.map((sc) => {
    const len = Math.max(0.04, sc.end - sc.start);
    const fracs = len < 0.8 ? [0.5] : (per === 1 ? [0.5] : per === 2 || len < 2 ? [0.2, 0.8] : [0.1, 0.5, 0.9]);
    const times = fracs.map((f) => Math.min(Math.max(0, d - 1 / plan.fps), sc.start + len * f));
    const f0 = Math.round(sc.start * plan.fps), f1 = Math.round(sc.end * plan.fps);
    const clips = [...new Set(plan.segments.filter((s) => s.e > f0 && s.s < f1).map((s) => (s.clipId ? `${s.clipId}${s.clip.src ? ` (${s.clip.sourceId})` : ''}` : 'black')))];
    const speech = plan.speechIn(sc.start, sc.end);
    return { ...sc, times, clips, speech: speech.length > 170 ? `${speech.slice(0, 167)}...` : speech };
  });
}

/**
 * @param {{ plan:object, doc:object, browser:object, scenes:object[], frames:Map<number,{dataUrl:string}>, outDir:string, issues?:object[] }} o
 * `frames` maps the position in the flattened list of times to a JPEG/PNG data URL.
 */
export async function renderVideoSheet({ plan, doc, browser, scenes, frames, outDir, issues = [] }) {
  const portrait = plan.height >= plan.width;
  const thumbW = portrait ? 220 : 320;
  const thumbH = Math.round((thumbW * plan.height) / plan.width);
  const width = 1500;
  let n = 0;
  const groups = scenes.map((sc) => {
    const imgs = sc.times.map((t) => {
      const f = frames.get(n++);
      return `<figure><img src="${f?.dataUrl ?? ''}" width="${thumbW}" height="${thumbH}"><figcaption>${t.toFixed(1)}s</figcaption></figure>`;
    }).join('');
    return `<section><header><b>${esc(sc.title)}</b><span>${sc.start.toFixed(1)}&ndash;${sc.end.toFixed(1)} s</span></header><div class="frames">${imgs}</div>
<p class="clips">${esc(sc.clips.join(', '))}</p>${sc.speech ? `<p class="speech">&ldquo;${esc(sc.speech)}&rdquo;</p>` : '<p class="speech none">no speech</p>'}</section>`;
  }).join('');
  const bad = issues.filter((i) => i.level === 'error').length;
  const warn = issues.filter((i) => i.level === 'warn').length;
  const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${HOST}/fonts/inter/wght.css">
<style>
*{box-sizing:border-box}
html,body{margin:0;background:#e9e6e1;font-family:'Inter Variable',system-ui,sans-serif;color:#1f2a2e}
body{width:${width}px;padding:28px 32px 32px}
h1{margin:0 0 4px;font-size:22px;font-weight:650}
.meta{font-size:13px;color:#5d6d71;margin-bottom:18px}
.meta b{color:${bad ? '#b3261e' : warn ? '#9a6700' : '#1b6e3c'}}
.grid{display:flex;flex-wrap:wrap;gap:22px 26px;align-items:flex-start}
section{background:#f4f1ec;border-radius:10px;padding:12px 12px 10px;box-shadow:0 1px 6px rgba(0,0,0,.12)}
header{display:flex;justify-content:space-between;gap:16px;font-size:13px;margin-bottom:8px}
header span{color:#6f7f83}
.frames{display:flex;gap:6px}
figure{margin:0}
img{display:block;background:#222;border-radius:4px}
figcaption{font-size:11px;color:#6f7f83;margin-top:3px}
p{margin:6px 0 0;font-size:12px;line-height:1.35;max-width:${thumbW * 3 + 12}px}
.clips{color:#44525a}
.speech{color:#1f2a2e;font-style:italic}
.speech.none{color:#8a9699}
</style></head><body>
<h1>${esc(doc.title)}</h1>
<div class="meta">${esc(doc.id)} &middot; ${plan.duration.toFixed(1)} s &middot; ${plan.width}&times;${plan.height} &middot; ${plan.fps} fps &middot; <b>${bad} error${bad === 1 ? '' : 's'}, ${warn} warning${warn === 1 ? '' : 's'}</b></div>
<div class="grid">${groups}</div>
</body></html>`;
  const canvas = await newCanvas(browser, { projectDir: plan.projectDir, width, height: 800, scale: 1 });
  try {
    await canvas.show(html);
    await canvas.page.evaluate(() => Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; })))));
    const height = await canvas.page.evaluate(() => document.documentElement.scrollHeight);
    await canvas.page.setViewportSize({ width, height });
    const png = await canvas.page.screenshot({ type: 'png', clip: { x: 0, y: 0, width, height } });
    const path = join(outDir, 'sheet.png');
    writeFileSync(path, png);
    return path;
  } finally { await canvas.close(); }
}
