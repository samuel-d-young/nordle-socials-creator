// The overlay: the document's timed layers and the captions, drawn by the same HTML renderer as every other Nordle
// page, on a transparent page, one persistent page per worker. Time is set by a script in the page, so any moment can be
// drawn on its own. A frame is only drawn when something is different from the frame before it: a title that stays still
// is drawn once, and only the frames where something moves are drawn one by one.

import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { buildPageHtml } from '../render/html.mjs';
import { NODE_URLS, loadFontManifest } from '../render/urls.mjs';
import { newCanvas } from '../render/browser.mjs';
import { resolveToken } from '../shared/tokens.mjs';
import { installOverlayRuntime } from './overlay-runtime.mjs';

const DEFAULT_DURATION = { 'fade-in': 0.5, 'fade-out': 0.4, 'rise-in': 0.55, 'rise-out': 0.4, 'fall-in': 0.55, pop: 0.4, 'slide-in': 0.5, 'slide-out': 0.4, wipe: 0.6, 'wipe-out': 0.5, 'scale-in': 0.5, 'blur-in': 0.6, 'blur-out': 0.5, 'spin-in': 0.7, 'tracking-in': 0.8, draw: 0.8, 'draw-out': 0.5, 'reveal-circle': 0.8, 'count-up': 1.4, shake: 0.5 };
/** Loops run for as long as the layer is on screen. */
const LOOPS = ['float', 'sway', 'pulse', 'drift'];
export const PRESETS = ['fade-in', 'fade-out', 'rise-in', 'rise-out', 'fall-in', 'pop', 'slide-in', 'slide-out', 'wipe', 'wipe-out', 'typewriter', 'word-by-word', 'scale-in', 'blur-in', 'blur-out', 'spin-in', 'tracking-in', 'draw', 'draw-out', 'reveal-circle', 'count-up', 'shake', ...LOOPS];
const EASES = new Set(['linear', 'in', 'out', 'in-out', 'in-cubic', 'out-cubic', 'in-out-cubic', 'out-back']);
const countChars = (layer) => [...(layer.text ?? (layer.runs ?? []).map((r) => r.text).join(''))].filter((c) => !/\s/.test(c)).length;
const countWords = (layer) => (layer.text ?? (layer.runs ?? []).map((r) => r.text).join('')).split(/\s+/).filter(Boolean).length;

/** Animations of one layer in plain numbers: start and duration in seconds from the layer's own start. */
function normaliseAnims(layer, brand, issues) {
  const span = layer.time.end - layer.time.start;
  const brandEase = EASES.has(brand.motion?.ease) ? brand.motion.ease : 'out-cubic';
  const out = [];
  for (const a of layer.animate ?? []) {
    const ease = a.ease && EASES.has(a.ease) ? a.ease : brandEase;
    if (a.ease && !EASES.has(a.ease)) issues.push({ level: 'warn', code: 'overlay-ease', message: `Layer "${layer.id}": the easing "${a.ease}" is not known (use ${[...EASES].join(', ')}). "${brandEase}" is used instead.`, layer: layer.id });
    if (a.keyframes) {
      const at = a.at ?? 0;
      const last = Math.max(...a.keyframes.map((k) => k.t));
      out.push({ preset: 'keyframes', start: at, dur: last, ease, keyframes: a.keyframes, params: {} });
      continue;
    }
    if (!PRESETS.includes(a.preset)) {
      issues.push({ level: 'warn', code: 'overlay-preset', message: `Layer "${layer.id}": the animation "${a.preset}" is not known and is ignored. Presets: ${PRESETS.join(', ')}.`, layer: layer.id });
      continue;
    }
    if (LOOPS.includes(a.preset)) { out.push({ preset: a.preset, start: a.at ?? 0, dur: span, ease, params: a.params ?? {} }); continue; }
    let dur = a.duration ?? DEFAULT_DURATION[a.preset];
    if (dur === undefined) dur = a.preset === 'typewriter' ? Math.max(0.6, countChars(layer) * 0.045) : Math.max(0.6, countWords(layer) * 0.2);
    const exit = a.preset.endsWith('-out');
    const start = a.at ?? (exit ? Math.max(0, span - dur) : 0);
    if (start + dur > span + 1e-6) issues.push({ level: 'warn', code: 'overlay-anim-long', message: `Layer "${layer.id}": the ${a.preset} animation runs to ${(start + dur).toFixed(2)}s but the layer is only on for ${span.toFixed(2)}s.`, layer: layer.id });
    out.push({ preset: a.preset, start, dur, ease, params: a.params ?? {} });
  }
  return out;
}

/** Position of the caption block inside the platform's safe area. */
function captionLayout(plan, position) {
  const s = plan.size.safe;
  const left = s.left * 100, right = s.right * 100;
  const w = 100 - left - right;
  const x = left + w / 2;
  if (position === 'top-third') return { anchor: 'top', x, y: s.top * 100 + 3, w };
  if (position === 'center') return { anchor: 'center', x, y: 50, w };
  return { anchor: 'bottom', x, y: 100 - s.bottom * 100 - 2, w };
}

/**
 * Everything needed to draw the overlay: the page HTML and the timing of every layer.
 * @returns {{ html:string, metas:object[], issues:object[], empty:boolean, warnings:string[] }}
 */
export function buildOverlay(plan, doc, brand) {
  const issues = [];
  const metas = [];
  const layers = [];
  const caps = plan.captions;

  if (caps?.enabled && caps.events.length) {
    const cfg = caps.cfg;
    const place = captionLayout(plan, cfg.position ?? 'bottom-third');
    const highlight = cfg.highlight ?? 'word';
    const hi = typeof caps.highlightColor === 'string' && caps.highlightColor.startsWith('$brand.') ? resolveToken(caps.highlightColor, brand, doc.colourway) ?? '#FFD400' : caps.highlightColor;
    const style = { align: 'center', lineHeight: 1.14, balance: true, letterSpacing: 0.005, ...caps.style };
    for (const ev of caps.events) {
      const id = `nv-${ev.id}`;
      layers.push({
        id, type: 'text', layout: place, style,
        runs: ev.words.map((w, i) => ({ text: i < ev.words.length - 1 ? `${w.text} ` : w.text })),
        time: { start: ev.start, end: ev.end },
      });
      metas.push({
        id, kind: 'caption', start: ev.start, end: ev.end,
        anim: cfg.animate === false ? [] : [{ preset: 'pop', start: 0, dur: 0.12, ease: 'out-cubic', params: { from: 0.92 } }],
        caption: { wordStarts: ev.words.map((w) => w.start), highlight, hi },
      });
    }
  }

  (doc.layers ?? []).forEach((layer) => {
    if (layer.hidden) return;
    if (layer.type === 'video') { issues.push({ level: 'warn', code: 'overlay-video-layer', message: `Layer "${layer.id}" is a video layer, which is not drawn yet: put the clip on a video track instead.`, layer: layer.id }); return; }
    layers.push(layer);
    metas.push({ id: layer.id, kind: 'layer', start: layer.time.start, end: layer.time.end, anim: normaliseAnims(layer, brand, issues), ignoreSafe: !!layer.ignoreSafe });
  });

  const pseudoPage = { id: 'overlay', background: 'transparent', layers };
  const pdoc = { ...doc, pages: [pseudoPage] };
  const built = buildPageHtml({
    doc: pdoc, brand, size: { id: plan.size.id, w: plan.width, h: plan.height, safe: plan.size.safe },
    page: pseudoPage, fontManifest: loadFontManifest(), urls: NODE_URLS,
  });
  // the page is transparent, and captions get a soft dark halo so they read over any picture
  // The top-left pixel is cut out of the page so every picture keeps an alpha channel: Chrome writes a fully opaque screenshot
  // (a full-screen card) as RGB, and ffmpeg cannot follow a picture sequence that changes pixel format part way through.
  const extra = `html,body,#canvas{background:transparent !important}
#canvas{clip-path:polygon(1px 0,100% 0,100% 100%,0 100%,0 1px,1px 1px)}
[data-layer^="nv-cap-"]{text-shadow:0 0 calc(var(--u) * 1.5) rgba(0,0,0,.9),0 0 calc(var(--u) * 5) rgba(0,0,0,.7),0 calc(var(--u) * 4) calc(var(--u) * 16) rgba(0,0,0,.5) !important}
`;
  const html = built.html.split('</style>').join(`${extra}</style>`);
  return { html, metas, issues, empty: metas.length === 0, warnings: built.warnings };
}

// ---------------------------------------------------------------- the persistent page

/** One page with the overlay loaded and its clock script installed. */
export async function openOverlayPage(browser, plan, overlay) {
  const canvas = await newCanvas(browser, { projectDir: plan.projectDir, width: plan.width, height: plan.height, scale: 1 });
  await canvas.show(overlay.html);
  const cfg = {
    u: plan.width / 1080,
    layers: overlay.metas.map((m) => ({ id: m.id, start: m.start, end: m.end, anim: m.anim, caption: m.caption })),
  };
  const info = await canvas.page.evaluate(installOverlayRuntime, cfg);
  await canvas.page.evaluate(() => document.fonts.ready);
  return {
    info,
    async setTime(t) { await canvas.page.evaluate((x) => window.__nv.setTime(x), t); },
    async measure(t) { return canvas.page.evaluate((x) => window.__nv.measure(x), t); },
    async png(t) {
      await canvas.page.evaluate((x) => window.__nv.setTime(x), t);
      return canvas.page.screenshot({ type: 'png', omitBackground: true, clip: { x: 0, y: 0, width: plan.width, height: plan.height } });
    },
    close: () => canvas.close(),
  };
}

/** A PNG with an alpha channel (colour type 6). A picture without one is converted, so the sequence never changes format. */
export function ensureRgba(buf) {
  if (buf[25] === 6) return buf;
  const png = PNG.sync.read(buf);
  return PNG.sync.write(png, { colorType: 6, inputColorType: 6, inputHasAlpha: true, deflateLevel: 1 });
}

/** A fully transparent PNG of the canvas size. */
export function transparentPng(width, height) {
  return PNG.sync.write(new PNG({ width, height }), { deflateLevel: 1 });
}

// ---------------------------------------------------------------- which frames differ

const activeIndex = (times, t) => { let idx = -1; for (let i = 0; i < times.length; i++) if (times[i] <= t + 1e-6) idx = i; return idx; };

function keyFor(m, t, fps) {
  if (t < m.start - 1e-6 || t >= m.end - 1e-6) return '';
  const lt = t - m.start;
  let k = m.id;
  for (const a of m.anim) {
    if (lt < a.start - 1e-6) k += ':b';
    else if (lt >= a.start + a.dur - 1e-6) k += ':a';
    else k += `:${Math.round(t * fps)}`;
  }
  if (m.caption?.highlight === 'word') k += `:w${activeIndex(m.caption.wordStarts, t)}`;
  return k;
}

/** The state of every output frame, as a string. Equal strings draw the same picture. */
export function frameKeys(plan, overlay) {
  const keys = new Array(plan.frames);
  for (let f = 0; f < plan.frames; f++) {
    const t = (plan.fromF + f) / plan.fps;
    let key = '';
    for (const m of overlay.metas) { const k = keyFor(m, t, plan.fps); if (k) key += `${key ? '|' : ''}${k}`; }
    keys[f] = key;
  }
  return keys;
}

/**
 * Draw the overlay for the whole render. Writes the distinct pictures and a concat list that holds each for as long as
 * it lasts. Returns null when there is nothing to draw.
 */
export async function renderOverlaySequence(browser, plan, overlay, dir, { onProgress, workers } = {}) {
  if (overlay.empty) return null;
  const keys = frameKeys(plan, overlay);
  const runs = [];
  keys.forEach((key, f) => { const last = runs.at(-1); if (last && last.key === key) last.count += 1; else runs.push({ key, f0: f, count: 1 }); });
  if (runs.every((r) => r.key === '')) return null;
  mkdirSync(dir, { recursive: true });

  const unique = new Map(); // key -> { file, f0 }
  for (const r of runs) if (!unique.has(r.key)) unique.set(r.key, { file: `ov-${String(unique.size).padStart(4, '0')}.png`, f0: r.f0 });
  const blank = unique.get('');
  if (blank) writeFileSync(join(dir, blank.file), transparentPng(plan.width, plan.height));
  const todo = [...unique.entries()].filter(([key]) => key !== '');

  const n = Math.max(1, Math.min(workers ?? Math.floor(os.availableParallelism() / 6), todo.length, 4));
  const pages = await Promise.all(Array.from({ length: n }, () => openOverlayPage(browser, plan, overlay)));
  let done = 0;
  try {
    let next = 0;
    await Promise.all(pages.map(async (page) => {
      for (;;) {
        const i = next++;
        if (i >= todo.length) return;
        const [, u] = todo[i];
        writeFileSync(join(dir, u.file), ensureRgba(await page.png((plan.fromF + u.f0) / plan.fps)));
        done += 1;
        onProgress?.({ done, total: todo.length });
      }
    }));
  } finally {
    await Promise.all(pages.map((p) => p.close().catch(() => {})));
  }
  const lines = ['ffconcat version 1.0'];
  for (const r of runs) lines.push(`file '${unique.get(r.key).file}'`, `duration ${(r.count / plan.fps).toFixed(6)}`);
  lines.push(`file '${unique.get(runs.at(-1).key).file}'`);
  const list = join(dir, 'overlay.ffconcat');
  writeFileSync(list, `${lines.join('\n')}\n`);
  return { list, distinct: unique.size, drawn: todo.length, frames: plan.frames };
}

// ---------------------------------------------------------------- checks

/** Does anything sit under the platform's buttons or off the canvas? Measured on the real page at the time each is fully in. */
export async function checkOverlayPlacement(browser, plan, overlay) {
  const issues = [];
  if (overlay.empty) return issues;
  const page = await openOverlayPage(browser, plan, overlay);
  try {
    const { width: W, height: H } = plan;
    const s = plan.size.safe;
    const lim = { left: s.left * W, right: W - s.right * W, top: s.top * H, bottom: H - s.bottom * H };
    const tol = Math.max(2, W / 360);
    const pct = (v, total) => `${Math.round((v / total) * 100)}%`;
    if (page.info.missing) issues.push({ level: 'info', code: 'overlay-missing', message: `${page.info.missing} overlay layer(s) could not be drawn (hidden for this size).` });
    for (const m of overlay.metas) {
      const rest = Math.min(m.end - 0.001, m.start + Math.max(0, ...m.anim.map((a) => a.start + a.dur)) + 0.001);
      const t = m.kind === 'caption' ? Math.min(m.end - 0.001, m.start + 0.2) : rest;
      const hit = (await page.measure(t)).find((r) => r.id === m.id);
      if (!hit || hit.w < 1 || hit.h < 1) continue;
      if (hit.type === 'shape' || (hit.w >= W * 0.95 && hit.h >= H * 0.95 && hit.type !== 'text')) continue; // cards, scrims and full-bleed pictures are backgrounds, not things to read
      const right = hit.x + hit.w, bottom = hit.y + hit.h;
      const label = m.kind === 'caption' ? `The caption line at ${m.start.toFixed(1)}s` : `Layer "${m.id}"`;
      if (hit.x < -tol || hit.y < -tol || right > W + tol || bottom > H + tol) {
        issues.push({ level: 'warn', code: 'overlay-offscreen', message: `${label} runs off the picture (it spans ${pct(hit.x, W)} to ${pct(right, W)} across and ${pct(hit.y, H)} to ${pct(bottom, H)} down).`, layer: m.id, time: m.start });
        continue;
      }
      if (hit.ignoreSafe || m.ignoreSafe) continue;
      const sides = [];
      if (hit.x < lim.left - tol) sides.push(`the left ${Math.round(s.left * 100)}%`);
      if (right > lim.right + tol) sides.push(`the right ${Math.round(s.right * 100)}%`);
      if (hit.y < lim.top - tol) sides.push(`the top ${Math.round(s.top * 100)}%`);
      if (bottom > lim.bottom + tol) sides.push(`the bottom ${Math.round(s.bottom * 100)}%`);
      if (sides.length) issues.push({ level: 'warn', code: 'overlay-unsafe', message: `${label} reaches into ${sides.join(' and ')}, which ${plan.size.sharedWith.join(' and ') || plan.size.id} cover with buttons and the caption. Move it inside the safe area.`, layer: m.id, time: m.start });
    }
  } finally { await page.close(); }
  // many caption lines may repeat the same complaint: keep the first few
  const seen = new Map();
  return issues.filter((i) => { if (!i.code.startsWith('overlay-') || !i.message.startsWith('The caption line')) return true; const n = (seen.get(i.code) ?? 0) + 1; seen.set(i.code, n); return n <= 3; });
}

