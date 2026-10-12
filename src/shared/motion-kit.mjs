// The motion kit: scenes made only of animated graphics, in the brand's colours and fonts. Each recipe returns timed layers (text, shapes, drawn paths) that use the
// engine's animation presets (blur-in, tracking-in, count-up, draw, spin-in, float, ...). They design for the shape of the picture (vertical, square, landscape)
// instead of cropping one layout. Pure: no Node imports. Used by reel-spec.mjs for scenes of `type: "motion"`:
//
//   { "type": "motion", "recipe": "kinetic", "dur": 3.2, "background": "aurora", "tone": "dark",
//     "content": { "kicker": "First visit", "headline": "Nervous?\nYou are not alone", "accent": "not alone", "body": "..." } }
//
// recipes (content fields):
//   kinetic  { kicker?, headline (\n splits lines), accent? (the words to stress), body?, underline? }   lines slide and blur in; the stressed line scales in with a hand-drawn underline
//   number   { kicker?, number, suffix?, prefix?, decimals?, label, note?, progress? 0..1 }               the number counts up inside a ring that draws itself
//   list     { kicker?, headline?, items: [text x2..5] }                                                    a line draws down and each item arrives on its own numbered badge
//   quote    { quote, by? }                                                                                   a big mark pops, the words build, the name slides in
//   bars     { kicker?, headline?, items: [{ label, value, suffix? }] x2..5, max? }                       bars grow while their numbers count up
//   ticker   { words: [..], headline?, kicker? }                                                            giant words cross behind a headline at different speeds
//   reveal   { kicker?, headline, body? }                                                                   two panels part to uncover the headline
//   logo     { logo? (a path), line?, url?, phone? }                                                         the logo lands with a light sweep and a ring
// backgrounds: "aurora" (drifting colour glows), "glow" (one breathing glow), "bold" (the accent colour with a big shape), "paper" (light with soft shapes), "plain".
// options on a scene: tone (dark | light | accent), particles (floating specks, default on for aurora and glow), sweep (a colour panel that wipes across as the scene begins).

const r2 = (n) => Math.round(n * 100) / 100;
const r3 = (n) => Math.round(n * 1000) / 1000;
const hexAlpha = (hex, a) => `${String(hex).slice(0, 7)}${Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, '0')}`;

/** A small deterministic random generator, so the same scene always looks the same. */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
const hash = (str) => [...String(str)].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 7);

export const MOTION_RECIPES = ['kinetic', 'number', 'list', 'quote', 'bars', 'ticker', 'reveal', 'logo'];
export const MOTION_BACKGROUNDS = ['aurora', 'glow', 'bold', 'paper', 'plain'];

export class MotionError extends Error {}

/**
 * @param {object} o  recipe, content, size ({w,h,safe}), roles (brandRoles), f (font tokens), brand, id (layer id prefix), start, end (seconds on the reel),
 *                    tone, background, particles, sweep, logo (a resolved logo path for the logo recipe)
 * @returns {{ layers: object[], notes: string[] }}
 */
export function motionScene(o) {
  const { recipe, content = {}, size, roles, f, id, start, end } = o;
  if (!MOTION_RECIPES.includes(recipe)) throw new MotionError(`unknown motion recipe "${recipe}". Recipes: ${MOTION_RECIPES.join(', ')}.`);
  const tone = o.tone ?? 'dark';
  const background = o.background ?? 'aurora';
  if (!MOTION_BACKGROUNDS.includes(background)) throw new MotionError(`unknown background "${background}". Backgrounds: ${MOTION_BACKGROUNDS.join(', ')}.`);
  const notes = [];
  const dur = end - start;
  const W = size.w, H = size.h, u = W / 1080;
  const aspect = W / H;
  const wide = aspect > 1.2, tall = aspect < 0.7;
  const k = wide ? 0.5 : tall ? 1 : 0.8;               // type scale: sizes are px on a 1080-wide page, so a wide frame needs smaller numbers
  const fs = (px) => Math.round(px * k);
  const pxH = (refPx) => (refPx * u * 100) / H;         // a type size in the page's own px, as a percentage of the picture height
  const safe = size.safe ?? { top: 0.08, bottom: 0.12, left: 0.06, right: 0.06 };
  const L = Math.round(safe.left * 100 + 3), R = Math.round(100 - safe.right * 100 - 3);
  const T = Math.round(safe.top * 100 + 2), B = Math.round(100 - safe.bottom * 100 - 2);
  const cx = (L + R) / 2, cw = R - L;

  // ---- colours: a tone picks the ground, the text colour and the accents that read on it
  const dark = tone === 'dark', accentTone = tone === 'accent';
  const groundName = accentTone ? roles.accent : dark ? roles.ink : roles.paper;
  const ground = roles.val(groundName);
  const textName = accentTone ? roles.ink : dark ? roles.paper : roles.ink;
  const accentName = accentTone ? roles.paper : dark ? roles.accentOnInk : roles.accentOnPaper;
  const accent2Name = roles.accentLike.find((n) => n !== roles.accent && n !== groundName) ?? roles.accent;
  const ink = roles.tok(textName), acc = roles.tok(accentName), acc2 = roles.tok(accent2Name), groundTok = roles.tok(groundName);
  const accHex = roles.val(accentName), acc2Hex = roles.val(accent2Name), textHex = roles.val(textName);

  // ---- builders
  const lay = (layer, s, e, animate) => ({ ...layer, time: { start: r3(s), end: r3(Math.min(end, e)) }, ...(animate?.length ? { animate } : {}) });
  const fontFor = { head: f.headlineFont ?? f.display, kick: f.kickerFont ?? f.body, body: f.bodyFont ?? f.body };
  const txt = (name, text, p) => ({
    id: `${id}-${name}`, type: 'text', text,
    layout: { anchor: p.anchor ?? 'center', x: p.x ?? cx, y: p.y, ...(p.w !== undefined ? { w: p.w } : {}), z: p.z ?? 10 },
    style: { font: fontFor[p.font ?? 'head'], size: fs(p.size), weight: p.weight ?? 700, color: p.color ?? ink, align: p.align ?? 'center', lineHeight: p.lh ?? 1.04,
      ...(p.upper ? { uppercase: true } : {}), ...(p.italic ? { italic: true } : {}), ...(p.ls !== undefined ? { letterSpacing: p.ls } : {}), ...(p.shadow ? { shadow: p.shadow } : {}), ...(p.opacity !== undefined ? { opacity: p.opacity } : {}) },
  });
  const rect = (name, p, style) => ({ id: `${id}-${name}`, type: 'shape', shape: p.shape ?? 'rect', layout: { anchor: p.anchor ?? 'top-left', x: p.x, y: p.y, w: p.w, h: p.h, ...(p.rotate ? { rotate: p.rotate } : {}), z: p.z ?? 1 }, style });
  const path = (name, d, p, stroke) => ({ id: `${id}-${name}`, type: 'shape', shape: 'path', d, layout: { anchor: p.anchor ?? 'top-left', x: p.x, y: p.y, w: p.w, h: p.h, z: p.z ?? 8 }, style: { stroke, ...(p.fill ? { fill: p.fill } : {}) } });
  /** The largest type size (before the type scale) at which `chars` letters still fit on one line across `widthPct` of the picture. */
  const fit = (want, chars, widthPct = cw) => Math.min(want, Math.floor(((widthPct / 100) * 1080 / Math.max(chars, 4) / 0.54) / k));
  const out = [];   // finished layers, in drawing order
  const add = (layer, s, e, animate) => { out.push(lay(layer, s, e, animate)); };
  const exit = { preset: 'fade-out', duration: 0.25 };
  const squareH = (wPct) => r2((wPct * W) / H);       // the height (in % of the picture) that makes a box as tall as it is wide
  const vgap = (px) => pxH(px);

  // ---- the ground and what moves behind everything
  const ambient = () => {
    add(rect('ground', { x: 0, y: 0, w: 100, h: 100, z: 0 }, { fill: background === 'bold' ? roles.tok(roles.accent) : groundTok }), start, end, [{ preset: 'fade-in', duration: 0.2 }, { preset: 'fade-out', duration: 0.2 }]);
    const blob = (name, x0, y0, x1, y1, size0, color, alpha, delay = 0) => {
      const g = { type: 'radial', x: 50, y: 50, stops: [{ at: 0, color: hexAlpha(color, alpha) }, { at: 1, color: hexAlpha(color, 0) }] };
      const layer = rect(name, { shape: 'ellipse', anchor: 'center', x: x0, y: y0, w: size0, h: squareH(size0), z: 1 }, { fill: g, blend: dark ? 'screen' : 'normal' });
      add(layer, start, end, [{ preset: 'fade-in', duration: 0.6, at: delay }, { keyframes: [{ t: 0, prop: 'x', value: x0 }, { t: dur, prop: 'x', value: x1 }, { t: 0, prop: 'y', value: y0 }, { t: dur, prop: 'y', value: y1 }], ease: 'in-out' }, { preset: 'fade-out', duration: 0.25 }]);
    };
    if (background === 'aurora') {
      blob('aurora-1', wide ? 20 : 15, wide ? 30 : 25, wide ? 40 : 60, wide ? 55 : 40, wide ? 70 : 150, accHex, dark ? 0.55 : 0.35);
      blob('aurora-2', wide ? 85 : 90, wide ? 80 : 75, wide ? 60 : 40, wide ? 45 : 60, wide ? 65 : 140, acc2Hex, dark ? 0.5 : 0.3, 0.15);
      blob('aurora-3', 50, wide ? 105 : 110, 55, wide ? 80 : 85, wide ? 55 : 120, accHex, dark ? 0.35 : 0.22, 0.3);
    } else if (background === 'glow') {
      const g = { type: 'radial', x: 50, y: 50, stops: [{ at: 0, color: hexAlpha(accHex, dark ? 0.6 : 0.4) }, { at: 1, color: hexAlpha(accHex, 0) }] };
      add(rect('glow', { shape: 'ellipse', anchor: 'center', x: cx, y: 50, w: wide ? 75 : 170, h: squareH(wide ? 75 : 170), z: 1 }, { fill: g, blend: dark ? 'screen' : 'normal' }), start, end, [{ preset: 'fade-in', duration: 0.5 }, { preset: 'pulse', params: { amount: 0.08, period: 2.6 } }, { preset: 'fade-out', duration: 0.25 }]);
    } else if (background === 'bold') {
      const big = rect('bold-disc', { shape: 'ellipse', anchor: 'center', x: wide ? 96 : 100, y: wide ? 4 : 0, w: wide ? 42 : 130, h: squareH(wide ? 42 : 130), z: 1 }, { fill: roles.tok(roles.ink) });
      add(big, start, end, [{ preset: 'scale-in', duration: 0.9, params: { from: 0.1 }, ease: 'out-cubic' }, { preset: 'drift', params: { dx: -2, dy: 1 } }, { preset: 'fade-out', duration: 0.25 }]);
      const small = rect('bold-ring', { shape: 'ellipse', anchor: 'center', x: wide ? 8 : 5, y: wide ? 95 : 100, w: wide ? 30 : 70, h: squareH(wide ? 30 : 70), z: 1 }, { fill: roles.tok(roles.paper), opacity: 0.18 });
      add(small, start, end, [{ preset: 'scale-in', duration: 1.1, params: { from: 0.2 } }, { preset: 'pulse', params: { amount: 0.05, period: 3 } }, { preset: 'fade-out', duration: 0.25 }]);
    } else if (background === 'paper') {
      const soft = { type: 'radial', x: 50, y: 50, stops: [{ at: 0, color: hexAlpha(accHex, 0.28) }, { at: 1, color: hexAlpha(accHex, 0) }] };
      add(rect('paper-1', { shape: 'ellipse', anchor: 'center', x: wide ? 15 : 12, y: wide ? 25 : 18, w: wide ? 50 : 110, h: squareH(wide ? 50 : 110), z: 1 }, { fill: soft }), start, end, [{ preset: 'fade-in', duration: 0.6 }, { preset: 'drift', params: { dx: 2, dy: 1.5 } }, { preset: 'fade-out', duration: 0.25 }]);
      add(rect('paper-2', { shape: 'ellipse', anchor: 'center', x: wide ? 88 : 92, y: wide ? 85 : 88, w: wide ? 45 : 100, h: squareH(wide ? 45 : 100), z: 1 }, { fill: { ...soft, stops: [{ at: 0, color: hexAlpha(acc2Hex, 0.25) }, { at: 1, color: hexAlpha(acc2Hex, 0) }] } }), start, end, [{ preset: 'fade-in', duration: 0.6 }, { preset: 'drift', params: { dx: -2, dy: -1.5 } }, { preset: 'fade-out', duration: 0.25 }]);
    }
    const specks = o.particles ?? (background === 'aurora' || background === 'glow');
    if (specks) {
      const rnd = rng(hash(id));
      for (let i = 0; i < (wide ? 16 : 14); i++) {
        const s = 0.5 + rnd() * 1.1;                       // % of the width
        const sp = rect(`speck-${i + 1}`, { shape: 'ellipse', anchor: 'center', x: r2(rnd() * 100), y: r2(rnd() * 100), w: r2(s), h: squareH(r2(s)), z: 2 }, { fill: hexAlpha(i % 3 ? textHex : accHex, 1), opacity: r2(0.12 + rnd() * 0.3), blend: dark ? 'screen' : 'normal' });
        add(sp, start, end, [{ preset: 'fade-in', duration: 0.8, at: rnd() * 0.6 }, { preset: 'float', params: { amplitude: 10 + rnd() * 24, period: 2.2 + rnd() * 2.6 } }, { preset: 'drift', params: { dx: r2((rnd() - 0.5) * 8), dy: r2(-4 - rnd() * 8) } }, { preset: 'fade-out', duration: 0.25 }]);
      }
    }
    if (o.sweep) {
      const sw = rect('sweep', { anchor: 'top-left', x: -70, y: -10, w: 60, h: 120, rotate: 0, z: 40 }, { fill: roles.tok(roles.accent) });
      add(sw, start, start + 0.9, [{ keyframes: [{ t: 0, prop: 'x', value: -70 }, { t: 0.9, prop: 'x', value: 120 }], ease: 'in-out-cubic' }]);
    }
  };
  ambient();

  const kick = (name, text, y, at = 0.15) => { if (text) add(txt(name, String(text), { y, size: 28, font: 'kick', weight: 700, upper: true, ls: 0.2, color: acc, w: cw }), start + at, end, [{ preset: 'tracking-in', duration: 0.8, params: { from: 0.7 } }, exit]); };
  const lines = (str, perLine) => {
    const raw = String(str ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
    if (raw.length > 1) return raw;
    const words = raw[0]?.split(/\s+/) ?? [];
    const out2 = [];
    let cur = '';
    for (const w of words) { if ((cur + ' ' + w).trim().length > perLine && cur) { out2.push(cur); cur = w; } else cur = (cur + ' ' + w).trim(); }
    if (cur) out2.push(cur);
    return out2;
  };

  // ---- the recipes
  if (recipe === 'kinetic') {
    const ls = lines(content.headline, wide ? 26 : 14);
    if (!ls.length) throw new MotionError('a kinetic scene needs content.headline');
    const size0 = fit(wide ? 170 : ls.length > 3 ? 130 : 150, Math.max(...ls.map((l) => l.length)));
    const lineH = pxH(size0 * k * 1.12);
    const body = content.body ? 1 : 0;
    const total = ls.length * lineH + (body ? pxH(80 * k) : 0);
    const top = Math.max(T + (content.kicker ? pxH(60 * k) : 0), 50 - total / 2);
    kick('kicker', content.kicker, Math.max(T, top - pxH(70 * k)));
    const stress = String(content.accent ?? '').toLowerCase();
    ls.forEach((line, i) => {
      const hot = stress && line.toLowerCase().includes(stress);
      const from = i % 2 ? 'right' : 'left';
      const y = top + lineH * (i + 0.5);
      add(txt(`line-${i + 1}`, line, { y, w: cw, size: size0, color: hot ? acc : ink, italic: hot, weight: hot ? 800 : 700, shadow: dark ? { color: '#00000066', blur: 14, y: 4 } : undefined }),
        start + 0.25 + i * 0.22, end,
        hot ? [{ preset: 'scale-in', duration: 0.7, params: { from: 0.55 }, ease: 'out-back' }, { preset: 'blur-in', duration: 0.5, params: { amount: 18 } }, { preset: 'float', params: { amplitude: 5, period: 3.4 } }, exit]
          : [{ preset: 'slide-in', duration: 0.65, params: { from, distance: 220 }, ease: 'out-cubic' }, { preset: 'blur-in', duration: 0.65, params: { amount: 22 } }, { preset: 'float', params: { amplitude: 3, period: 3.8 + i * 0.4 } }, exit]);
      if (hot && content.underline !== false) {
        const wpx = Math.min(cw * 0.9, (Math.max(line.length, 4) * size0 * k * 0.5 * u * 100) / W);
        add(path(`swash-${i + 1}`, 'M2 55 Q 22 5 42 55 T 98 45', { anchor: 'top', x: cx, y: y + lineH * 0.42, w: r2(wpx), h: r2(pxH(34 * k)), z: 9 }, { color: acc2, width: 9 * k }),
          start + 0.25 + i * 0.22 + 0.7, end, [{ preset: 'draw', duration: 0.7, ease: 'out-cubic' }, exit]);
      }
    });
    if (content.body) add(txt('body', String(content.body), { y: top + ls.length * lineH + pxH(50 * k), w: cw * 0.9, size: 40, font: 'body', weight: 500, color: ink, opacity: 0.9 }), start + 0.4 + ls.length * 0.22, end, [{ preset: 'rise-in', duration: 0.6, params: { distance: 30 } }, { preset: 'blur-in', duration: 0.5, params: { amount: 10 } }, exit]);
  } else if (recipe === 'number') {
    const raw = String(content.number ?? '').trim();
    const num = Number(raw.replace(/[^0-9.\-]/g, ''));
    if (!raw || !Number.isFinite(num)) throw new MotionError('a number scene needs content.number (for example "98")');
    const decimals = content.decimals ?? (raw.includes('.') ? raw.split('.')[1].replace(/\D/g, '').length : 0);
    const prefix = content.prefix ?? (/^[^0-9\-]+/.exec(raw)?.[0] ?? '');
    const suffix = content.suffix ?? (/[^0-9.]+$/.exec(raw)?.[0] ?? '');
    const ringW = wide ? 36 : Math.min(76, cw);
    const cy = wide ? 50 : 42;
    const ringPx = (ringW / 100) * W;
    const numRef = (ringPx * 0.34 * (decimals ? 0.9 : 1)) / u / k;       // the number's size, as a px size before the type scale
    kick('kicker', content.kicker, Math.max(T, cy - squareH(ringW) / 2 - pxH(60 * k)));
    const progress = Math.max(0.05, Math.min(1, content.progress ?? 0.78));
    const a = progress * Math.PI * 2, ex = 50 + 46 * Math.sin(a), ey = 50 - 46 * Math.cos(a);
    const arc = progress >= 0.999 ? 'M50 4 A46 46 0 1 1 49.9 4' : `M50 4 A46 46 0 ${progress > 0.5 ? 1 : 0} 1 ${r2(ex)} ${r2(ey)}`;
    add(path('ring-track', 'M50 4 A46 46 0 1 1 49.9 4', { anchor: 'center', x: wide ? 30 : cx, y: cy, w: ringW, h: squareH(ringW), z: 5 }, { color: hexAlpha(accHex, 0.22), width: 16 * k }), start + 0.1, end, [{ preset: 'scale-in', duration: 0.6, params: { from: 0.8 } }, exit]);
    add(path('ring', arc, { anchor: 'center', x: wide ? 30 : cx, y: cy, w: ringW, h: squareH(ringW), z: 6 }, { color: acc, width: 16 * k }), start + 0.25, end, [{ preset: 'draw', duration: Math.min(1.8, dur * 0.55), ease: 'in-out-cubic' }, { preset: 'pulse', params: { amount: 0.015, period: 2.2 } }, exit]);
    add(txt('number', `${prefix}${decimals ? (0).toFixed(decimals) : '0'}${suffix}`, { x: wide ? 30 : cx, y: cy, size: numRef, w: ringW * 0.8, weight: 800, color: ink, ls: -0.02 }), start + 0.25, end,
      [{ preset: 'count-up', duration: Math.min(1.8, dur * 0.55), params: { from: 0, to: num, decimals, prefix, suffix }, ease: 'out-cubic' }, { preset: 'scale-in', duration: 0.5, params: { from: 0.8 } }, exit]);
    const lx = wide ? 54 : cx, ly = wide ? 42 : cy + squareH(ringW) / 2 + pxH(90 * k);
    const labelWide = wide ? R - 54 : cw;
    if (content.label) add(txt('label', String(content.label), { x: lx, y: ly, w: labelWide, size: fit(wide ? 120 : 84, String(content.label).length, labelWide), color: ink, align: wide ? 'left' : 'center', ...(wide ? { anchor: 'left' } : {}) }), start + 0.9, end, [{ preset: 'blur-in', duration: 0.7, params: { amount: 20 } }, { preset: 'rise-in', duration: 0.7, params: { distance: 40 } }, exit]);
    if (content.note) add(txt('note', String(content.note), { x: lx, y: ly + pxH((wide ? 190 : 100) * k), w: wide ? labelWide : cw * 0.9, size: 44, font: 'body', weight: 500, color: ink, opacity: 0.85, align: wide ? 'left' : 'center', ...(wide ? { anchor: 'left' } : {}) }), start + 1.2, end, [{ preset: 'fade-in', duration: 0.6 }, exit]);
  } else if (recipe === 'list') {
    const items = (content.items ?? []).map(String).filter(Boolean).slice(0, 5);
    if (items.length < 2) throw new MotionError('a list scene needs content.items with two to five lines');
    const head = content.headline ? 1 : 0;
    const rowH = pxH((wide ? 190 : 230) * k);
    const headH = head ? pxH(250 * k) : 0;
    const total = headH + rowH * items.length;
    const top = Math.max(T + (content.kicker ? pxH(60 * k) : 0), 50 - total / 2);
    kick('kicker', content.kicker, Math.max(T, top - pxH(60 * k)));
    if (head) add(txt('headline', String(content.headline), { x: L, y: top + headH / 2, anchor: 'left', w: cw, size: fit(wide ? 130 : 120, String(content.headline).length), color: ink, align: 'left' }), start + 0.2, end, [{ preset: 'tracking-in', duration: 0.8, params: { from: 0.5 } }, { preset: 'blur-in', duration: 0.6, params: { amount: 16 } }, exit]);
    const badge = pxH(110 * k * 0.9);
    const bx = L + (badge * H) / W / 2 + 1;
    add(rect('rail', { anchor: 'top', x: bx, y: top + headH + rowH * 0.5, w: 0.5, h: rowH * (items.length - 1), z: 4 }, { fill: hexAlpha(accHex, 0.35) }), start + 0.4, end, [{ preset: 'wipe', duration: Math.max(0.8, items.length * 0.35), params: { from: 'down' }, ease: 'linear' }, exit]);
    items.forEach((item, i) => {
      const y = top + headH + rowH * (i + 0.5);
      const at = start + 0.5 + i * 0.4;
      add(rect(`badge-${i + 1}`, { shape: 'ellipse', anchor: 'center', x: bx, y, w: r2((badge * H) / W), h: r2(badge), z: 6 }, { fill: acc }), at, end, [{ preset: 'spin-in', duration: 0.6, params: { degrees: -120 } }, { preset: 'pulse', params: { amount: 0.035, period: 2.4 + i * 0.3 } }, exit]);
      add(txt(`badge-n-${i + 1}`, String(i + 1), { x: bx, y, size: 52, font: 'head', weight: 800, color: roles.tok(dark ? roles.ink : roles.paper), w: 8, z: 7 }), at + 0.1, end, [{ preset: 'pop', duration: 0.4 }, exit]);
      add(txt(`item-${i + 1}`, item, { x: bx + (badge * H) / W / 2 + 3, y, anchor: 'left', w: R - bx - (badge * H) / W / 2 - 3, size: wide ? 78 : 76, weight: 600, color: ink, align: 'left', lh: 1.1, font: 'body' }), at + 0.15, end, [{ preset: 'slide-in', duration: 0.6, params: { from: 'right', distance: 160 } }, { preset: 'blur-in', duration: 0.6, params: { amount: 14 } }, exit]);
    });
  } else if (recipe === 'quote') {
    const q = String(content.quote ?? '').trim();
    if (!q) throw new MotionError('a quote scene needs content.quote');
    add(txt('mark', '“', { y: wide ? 24 : 24, x: wide ? L + 8 : cx, size: 520, color: acc, opacity: 0.9, weight: 800, lh: 0.8 }), start + 0.1, end, [{ preset: 'pop', duration: 0.7, params: { from: 0.3 } }, { preset: 'float', params: { amplitude: 8, period: 4 } }, exit]);
    add(txt('quote', q, { y: 52, w: wide ? cw * 0.62 : cw, size: q.length > 90 ? 92 : 118, weight: 600, color: ink, lh: 1.14, italic: true, ...(wide ? { anchor: 'left', x: L + 9, align: 'left' } : {}) }), start + 0.4, end, [{ preset: 'word-by-word', duration: Math.min(dur * 0.55, Math.max(1.2, q.split(/\s+/).length * 0.18)), ease: 'linear' }, exit]);
    if (content.by) add(txt('by', String(content.by), { y: 78, size: 38, font: 'kick', weight: 700, upper: true, ls: 0.16, color: acc, w: wide ? cw * 0.62 : cw, ...(wide ? { anchor: 'left', x: L + 9, align: 'left' } : {}) }), start + Math.min(dur - 0.8, 1.6 + q.split(/\s+/).length * 0.12), end, [{ preset: 'tracking-in', duration: 0.7, params: { from: 0.6 } }, exit]);
  } else if (recipe === 'bars') {
    const items = (content.items ?? []).filter((x) => x && x.label !== undefined).slice(0, 5);
    if (items.length < 2) throw new MotionError('a bars scene needs content.items: two to five { label, value } entries');
    const max = content.max ?? Math.max(...items.map((x) => Number(x.value) || 0), 1);
    const head = content.headline ? 1 : 0;
    const rowH = pxH((wide ? 190 : 270) * k);
    const headH = head ? pxH(250 * k) : 0;
    const total = headH + rowH * items.length;
    const top = Math.max(T + (content.kicker ? pxH(60 * k) : 0), 50 - total / 2);
    kick('kicker', content.kicker, Math.max(T, top - pxH(60 * k)));
    if (head) add(txt('headline', String(content.headline), { x: L, y: top + headH / 2, anchor: 'left', w: cw, size: fit(wide ? 130 : 120, String(content.headline).length), color: ink, align: 'left' }), start + 0.2, end, [{ preset: 'tracking-in', duration: 0.8, params: { from: 0.5 } }, { preset: 'blur-in', duration: 0.6, params: { amount: 16 } }, exit]);
    const labelW = wide ? 22 : cw;
    const barX = wide ? L + labelW + 2 : L;
    const barMax = wide ? R - barX - 14 : cw - 24;
    items.forEach((item, i) => {
      const y = top + headH + rowH * (i + 0.5);
      const at = start + 0.45 + i * 0.28;
      const val = Number(item.value) || 0;
      const w = Math.max(2, (val / max) * barMax);
      const by = wide ? y : y + pxH(56 * k);
      add(txt(`label-${i + 1}`, String(item.label), { x: L, y: wide ? y : y - pxH(48 * k), anchor: 'left', w: labelW, size: 60, font: 'body', weight: 600, color: ink, align: 'left' }), at, end, [{ preset: 'slide-in', duration: 0.5, params: { from: 'left', distance: 90 } }, exit]);
      add(rect(`track-${i + 1}`, { anchor: 'left', x: barX, y: by, w: barMax, h: pxH(70 * k), z: 4 }, { fill: hexAlpha(textHex, 0.1), radius: 999 }), at, end, [{ preset: 'fade-in', duration: 0.4 }, exit]);
      add(rect(`bar-${i + 1}`, { anchor: 'left', x: barX, y: by, w, h: pxH(70 * k), z: 5 }, { fill: { type: 'linear', angle: 90, stops: [{ at: 0, color: acc }, { at: 1, color: acc2 }] }, radius: 999 }), at + 0.1, end,
        [{ keyframes: [{ t: 0, prop: 'w', value: 0.5 }, { t: 1.1, prop: 'w', value: r2(w) }], ease: 'out-cubic' }, exit]);
      add(txt(`value-${i + 1}`, `${item.prefix ?? ''}0${item.suffix ?? ''}`, { x: barX + w + 1.5, y: by, anchor: 'left', size: 64, weight: 800, color: ink, align: 'left', w: 28, z: 7 }), at + 0.1, end,
        [{ keyframes: [{ t: 0, prop: 'x', value: barX + 0.5 }, { t: 1.1, prop: 'x', value: r2(barX + w + 1.5) }], ease: 'out-cubic' }, { preset: 'count-up', duration: 1.1, params: { from: 0, to: val, decimals: item.decimals ?? 0, prefix: item.prefix ?? '', suffix: item.suffix ?? '' } }, exit]);
    });
  } else if (recipe === 'ticker') {
    const words = (content.words ?? []).map(String).filter(Boolean).slice(0, 6);
    if (!words.length) throw new MotionError('a ticker scene needs content.words');
    const rows = wide ? 3 : 4;
    for (let i = 0; i < rows; i++) {
      const word = `${words[i % words.length]}   ${words[(i + 1) % words.length]}   ${words[(i + 2) % words.length]}`;
      const dir = i % 2 ? 1 : -1;
      const y = r2(((i + 0.5) / rows) * 100);
      add(txt(`row-${i + 1}`, word, { anchor: 'left', x: dir < 0 ? 5 : -90, y, size: 260, weight: 800, color: i % 2 ? acc : ink, opacity: i % 2 ? 0.18 : 0.1, align: 'left', w: 400, lh: 1 }), start, end,
        [{ keyframes: [{ t: 0, prop: 'x', value: dir < 0 ? 5 : -90 }, { t: dur, prop: 'x', value: dir < 0 ? -90 : 5 }], ease: 'linear' }, { preset: 'fade-in', duration: 0.5 }, exit]);
    }
    if (content.headline) {
      kick('kicker', content.kicker, Math.max(T, 50 - pxH(150 * k)));
      add(txt('headline', String(content.headline), { y: 50, w: cw, size: wide ? 160 : 130, color: ink, shadow: { color: hexAlpha(ground, 0.7), blur: 40 } }), start + 0.3, end,
        [{ preset: 'scale-in', duration: 0.8, params: { from: 0.4 }, ease: 'out-back' }, { preset: 'blur-in', duration: 0.6, params: { amount: 24 } }, { preset: 'float', params: { amplitude: 6, period: 3.2 } }, exit]);
    }
  } else if (recipe === 'reveal') {
    const head = String(content.headline ?? '').trim();
    if (!head) throw new MotionError('a reveal scene needs content.headline');
    const hl = lines(head, wide ? 24 : 13);
    const size0 = fit(wide ? 170 : 150, Math.max(...hl.map((l) => l.length)));
    const lineH = pxH(size0 * k * 1.12);
    const top = 50 - (hl.length * lineH) / 2;
    kick('kicker', content.kicker, Math.max(T, top - pxH(70 * k)), 0.7);
    hl.forEach((line, i) => add(txt(`line-${i + 1}`, line, { y: top + lineH * (i + 0.5), w: cw, size: size0, color: ink }), start + 0.55 + i * 0.12, end,
      [{ preset: 'tracking-in', duration: 0.9, params: { from: 0.45 }, ease: 'out-cubic' }, { preset: 'blur-in', duration: 0.7, params: { amount: 20 } }, exit]));
    // two panels cover the picture and part: the top one leaves upward (its bottom edge is wiped first), the bottom one leaves downward
    ['bottom', 'top'].forEach((side, i) => {
      add(rect(`panel-${i + 1}`, { anchor: i ? 'bottom' : 'top', x: 50, y: i ? 100 : 0, w: 100, h: 50.5, z: 30 }, { fill: i ? acc2 : acc }), start, start + 1.1, [{ preset: 'wipe-out', duration: 0.75, at: 0.25, params: { from: side }, ease: 'in-out-cubic' }]);
    });
    add(rect('line', { anchor: 'center', x: 50, y: 50, w: 70, h: 0.4, z: 31 }, { fill: ink }), start + 0.1, start + 0.9, [{ preset: 'wipe', duration: 0.3, params: { from: 'left' } }, { preset: 'fade-out', duration: 0.25, at: 0.45 }]);
    if (content.body) add(txt('body', String(content.body), { y: top + hl.length * lineH + pxH(60 * k), w: cw * 0.85, size: 40, font: 'body', weight: 500, color: ink, opacity: 0.9 }), start + 1.5, end, [{ preset: 'rise-in', duration: 0.6, params: { distance: 26 } }, exit]);
  } else if (recipe === 'logo') {
    const ringW = wide ? 30 : 62;
    const cy = wide ? 44 : 38;
    add(path('ring', 'M50 4 A46 46 0 1 1 49.9 4', { anchor: 'center', x: cx, y: cy, w: ringW, h: squareH(ringW), z: 5 }, { color: acc, width: 8 * k }), start + 0.1, end, [{ preset: 'draw', duration: 1.1, ease: 'in-out-cubic' }, { preset: 'pulse', params: { amount: 0.03, period: 2.4 } }, exit]);
    const logoW = ringW * 0.62;
    if (o.logo) {
      add({ id: `${id}-logo`, type: 'image', src: o.logo, alt: `${o.brand?.name ?? 'Brand'} logo`, fit: 'contain', layout: { anchor: 'center', x: cx, y: cy, w: r2(logoW), h: squareH(r2(logoW)), z: 8 } }, start + 0.5, end,
        [{ preset: 'scale-in', duration: 0.8, params: { from: 0.2 }, ease: 'out-back' }, { preset: 'blur-in', duration: 0.5, params: { amount: 20 } }, { preset: 'float', params: { amplitude: 4, period: 3 } }, exit]);
      add(rect('sheen', { anchor: 'center', x: 0, y: cy, w: 12, h: squareH(ringW) * 0.9, rotate: 18, z: 9 }, { fill: { type: 'linear', angle: 90, stops: [{ at: 0, color: '#ffffff00' }, { at: 0.5, color: '#ffffffaa' }, { at: 1, color: '#ffffff00' }] }, blend: 'plus-lighter' }),
        start + 1.1, start + 1.9, [{ keyframes: [{ t: 0, prop: 'x', value: cx - ringW / 2 }, { t: 0.8, prop: 'x', value: cx + ringW / 2 }], ease: 'in-out' }]);
    } else {
      add(txt('name', String(o.brand?.name ?? ''), { x: cx, y: cy, size: 120, w: ringW * 0.8, weight: 800, color: ink }), start + 0.5, end, [{ preset: 'tracking-in', duration: 0.9, params: { from: 0.4 } }, { preset: 'blur-in', duration: 0.6, params: { amount: 20 } }, exit]);
    }
    const ly = cy + squareH(ringW) / 2 + pxH(90 * k);
    if (content.line) add(txt('line', String(content.line), { y: ly, w: cw, size: fit(96, String(content.line).length), color: ink }), start + 1.0, end, [{ preset: 'typewriter', duration: Math.min(1.6, String(content.line).length * 0.04), ease: 'linear' }, exit]);
    const small = [content.url, content.phone].filter(Boolean).join('   ·   ');
    if (small) add(txt('small', small, { y: ly + pxH(130 * k), w: cw, size: 42, font: 'body', weight: 600, color: acc }), start + 1.8, end, [{ preset: 'rise-in', duration: 0.6, params: { distance: 24 } }, { preset: 'fade-in', duration: 0.5 }, exit]);
  }

  // layers are timed inside the scene; ones that would not finish in time are noted, not hidden
  if (dur < 1.6 && recipe !== 'quote') notes.push(`a motion scene of ${r2(dur)} s is too short for its animation to finish; 2.5 s or more reads better.`);
  return { layers: out, notes };
}
