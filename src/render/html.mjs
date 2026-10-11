// Turns one page of a Nordle document, at one size, into a self-contained HTML page.
// Every length is computed from --cw / --ch (canvas width/height) and --u (1px per 1080 px of canvas width),
// so the same document lays out the same at every size.
//
// This file runs in Node (for exports) and in the browser (for the editor): no Node imports here.
// The caller supplies the bundled-font list and the URL prefixes for project files and fonts.

import { resolveToken } from '../shared/tokens.mjs';

const SYSTEM_STACK = "system-ui, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const ANCHORS = {
  'top-left': [0, 0], top: [0.5, 0], 'top-right': [1, 0],
  left: [0, 0.5], center: [0.5, 0.5], right: [1, 0.5],
  'bottom-left': [0, 1], bottom: [0.5, 1], 'bottom-right': [1, 1],
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (n) => String(Number(Number(n).toFixed(4)));
const cssSafe = (s) => String(s).replace(/["'\\;{}<>]/g, '');

function len(v, axis) {
  if (typeof v === 'number') return `calc(var(--${axis === 'x' ? 'cw' : 'ch'}) * ${num(v / 100)})`;
  const m = /^(-?\d+(?:\.\d+)?)(%|px)$/.exec(v);
  return m[2] === '%' ? len(Number(m[1]), axis) : `calc(var(--u) * ${num(m[1])})`;
}

function radius(v) {
  if (typeof v === 'number') return `calc(var(--u) * ${num(v)})`;
  const m = /^(-?\d+(?:\.\d+)?)(%|px)$/.exec(v);
  return m[2] === '%' ? `${num(m[1])}%` : `calc(var(--u) * ${num(m[1])})`;
}

/** Collects the fonts a page uses and the stylesheets and @font-face rules they need. */
class FontBook {
  constructor(manifest, urls) {
    this.manifest = manifest; this.urls = urls;
    this.links = new Set(); this.faces = []; this.warnings = new Set(); this.count = 0; this.cache = new Map();
  }

  use(spec) {
    const key = JSON.stringify(spec);
    if (this.cache.has(key)) return this.cache.get(key);
    const family = cssSafe(spec.family);
    const bundled = Object.entries(this.manifest).find(([name]) => name.toLowerCase() === family.toLowerCase());
    let stack;
    if (spec.source === 'file') {
      const alias = `nordle-file-${++this.count}`;
      for (const [weight, path] of Object.entries(spec.files ?? {})) {
        const m = /^(\d{3})(italic)?$/.exec(weight);
        if (!m) { this.warnings.add(`Font file key "${weight}" for "${family}" should look like 400 or 700italic.`); continue; }
        this.faces.push(`@font-face{font-family:"${alias}";font-weight:${m[1]};font-style:${m[2] ? 'italic' : 'normal'};src:url("${this.urls.project}/${encodeURI(path)}");}`);
      }
      stack = `'${alias}', '${family}', ${SYSTEM_STACK}`;
    } else if (spec.source !== 'system' && bundled) {
      this.links.add(bundled[1].css);
      stack = `'${bundled[1].family}', ${bundled[1].fallback}`;
    } else {
      if (spec.source === 'google') this.warnings.add(`Font "${family}" is not bundled with Nordle, so a fallback font is used instead.`);
      stack = `'${family}', ${SYSTEM_STACK}`;
    }
    this.cache.set(key, stack);
    return stack;
  }
}

function makeContext({ doc, brand, size, fonts, urls }) {
  const tok = (v) => (typeof v === 'string' && v.startsWith('$brand.') ? resolveToken(v, brand, doc.colourway) : v);
  const colour = (v) => (v === undefined ? undefined : tok(v));
  const fill = (v) => {
    if (v === undefined) return undefined;
    if (typeof v === 'object') {
      return `linear-gradient(${num(v.angle ?? 180)}deg, ${v.stops.map((s) => `${colour(s.color)} ${num(s.at * 100)}%`).join(', ')})`;
    }
    return colour(v);
  };
  const defaultFont = brand.fonts.body ?? Object.values(brand.fonts)[0];
  const font = (ref) => fonts.use(ref ? (typeof tok(ref) === 'object' ? tok(ref) : { family: ref, source: 'system' }) : defaultFont);
  const defaultColour = colour(brand.colors.ink ? '$brand.colors.ink' : '#111111');
  return { doc, brand, size, urls, tok, colour, fill, font, defaultColour };
}

function boxCss(layout, extra = []) {
  const [ax, ay] = ANCHORS[layout.anchor ?? 'top-left'];
  const css = ['position:absolute', `left:${len(layout.x ?? 0, 'x')}`, `top:${len(layout.y ?? 0, 'y')}`];
  if (layout.w !== undefined && layout.w !== 'auto') css.push(`width:${len(layout.w, 'x')}`);
  if (layout.h !== undefined && layout.h !== 'auto') css.push(`height:${len(layout.h, 'y')}`);
  css.push(`transform-origin:${ax * 100}% ${ay * 100}%`);
  css.push(`transform:translate(${-ax * 100}%,${-ay * 100}%) rotate(${num(layout.rotate ?? 0)}deg)`);
  if (layout.z !== undefined) css.push(`z-index:${layout.z}`);
  return [...css, ...extra].join(';');
}

function textCss(style, c) {
  const css = [];
  css.push(`font-family:${c.font(style.font)}`);
  css.push(`font-size:calc(var(--u) * ${num(style.size ?? 40)})`);
  if (style.weight) css.push(`font-weight:${style.weight}`);
  if (style.italic) css.push('font-style:italic');
  if (style.uppercase) css.push('text-transform:uppercase');
  if (style.underline) css.push('text-decoration:underline');
  css.push(`color:${c.colour(style.color) ?? c.defaultColour}`);
  if (style.align) css.push(`text-align:${style.align}`);
  css.push(`line-height:${num(style.lineHeight ?? 1.2)}`);
  if (style.letterSpacing !== undefined) css.push(`letter-spacing:${num(style.letterSpacing)}em`);
  if (style.balance) css.push('text-wrap:balance');
  if (style.maxLines) css.push(`display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:${style.maxLines};overflow:hidden`);
  if (style.opacity !== undefined) css.push(`opacity:${num(style.opacity)}`);
  if (style.shadow) {
    const s = style.shadow;
    css.push(`text-shadow:calc(var(--u) * ${num(s.x ?? 0)}) calc(var(--u) * ${num(s.y ?? 0)}) calc(var(--u) * ${num(s.blur)}) ${c.colour(s.color)}`);
  }
  if (style.stroke) css.push(`-webkit-text-stroke:calc(var(--u) * ${num(style.stroke.width)}) ${c.colour(style.stroke.color)}`);
  return css.join(';');
}

function runStyle(style, c) {
  const css = [];
  if (style.font) css.push(`font-family:${c.font(style.font)}`);
  if (style.size) css.push(`font-size:calc(var(--u) * ${num(style.size)})`);
  if (style.weight) css.push(`font-weight:${style.weight}`);
  if (style.italic !== undefined) css.push(`font-style:${style.italic ? 'italic' : 'normal'}`);
  if (style.uppercase !== undefined) css.push(`text-transform:${style.uppercase ? 'uppercase' : 'none'}`);
  if (style.color) css.push(`color:${c.colour(style.color)}`);
  if (style.letterSpacing !== undefined) css.push(`letter-spacing:${num(style.letterSpacing)}em`);
  return css.join(';');
}

/** Position for a layer that sits inside a stack: it flows, so only its size counts. */
function flowCss(layout, extra = []) {
  const css = ['position:relative', 'flex:none'];
  if (layout.w !== undefined && layout.w !== 'auto') css.push(`width:${len(layout.w, 'x')}`);
  if (layout.h !== undefined && layout.h !== 'auto') css.push(`height:${len(layout.h, 'y')}`);
  if (layout.z !== undefined) css.push(`z-index:${layout.z}`);
  return [...css, ...extra].join(';');
}

function layerHtml(layer, c, path, inStack = false) {
  const o = layer.overrides?.[c.size.id] ?? {};
  if (o.hidden ?? layer.hidden) return '';
  const layout = { ...(layer.layout ?? {}), ...(o.layout ?? {}) };
  const style = { ...(layer.style ?? {}), ...(o.style ?? {}) };
  const attrs = `data-layer="${esc(layer.id)}" data-path="${esc(path)}" data-type="${layer.type}" data-safe="${layer.ignoreSafe ? 0 : 1}" data-fixed-h="${layout.h !== undefined && layout.h !== 'auto' ? 1 : 0}"`;
  const shared = [];
  const box = (extra) => (inStack ? flowCss(layout, extra) : boxCss(layout, extra));
  if (layer.type !== 'text' && style.opacity !== undefined) shared.push(`opacity:${num(style.opacity)}`);

  switch (layer.type) {
    case 'text': {
      const text = o.text ?? layer.text;
      const inner = o.text !== undefined
        ? esc(text)
        : layer.runs
          ? layer.runs.map((r, i) => `<span data-run="${i}" style="${runStyle(r.style ?? {}, c)}">${esc(r.text)}</span>`).join('')
          : esc(layer.text);
      const width = layout.w === undefined ? [inStack ? 'width:100%' : 'width:max-content'] : [];
      return `<div class="layer text" ${attrs} style="${box([...width, 'white-space:pre-line', textCss(style, c)])}">${inner}</div>`;
    }
    case 'image': {
      const focal = layer.focal ?? { x: 0.5, y: 0.5 };
      const extra = ['display:block', `object-fit:${layer.fit ?? 'cover'}`, `object-position:${num(focal.x * 100)}% ${num(focal.y * 100)}%`, ...shared];
      if (style.radius !== undefined) extra.push(`border-radius:${radius(style.radius)};overflow:hidden`);
      const alt = layer.alt === undefined ? '' : ` alt="${esc(layer.alt)}"`;
      return `<img class="layer image" ${attrs}${alt} src="${c.urls.project}/${esc(encodeURI(layer.src))}" style="${box(extra)}">`;
    }
    case 'shape': {
      const extra = ['box-sizing:border-box', ...shared];
      const f = c.fill(style.fill);
      if (layer.shape === 'line') {
        extra.push(`height:calc(var(--u) * ${num(style.stroke?.width ?? 2)})`, `background:${c.colour(style.stroke?.color) ?? f ?? c.defaultColour}`);
      } else {
        if (f) extra.push(`background:${f}`);
        if (layer.shape === 'ellipse') extra.push('border-radius:50%');
        else if (style.radius !== undefined) extra.push(`border-radius:${radius(style.radius)}`);
        if (style.stroke) extra.push(`border:calc(var(--u) * ${num(style.stroke.width)}) solid ${c.colour(style.stroke.color)}`);
      }
      return `<div class="layer shape" ${attrs} style="${box(extra)}"></div>`;
    }
    case 'group': {
      const stack = layer.stack;
      const kids = layer.children.map((k, i) => layerHtml(k, c, `${path}/children/${i}`, !!stack)).join('');
      const flow = stack ? ['display:flex', 'flex-direction:column', `gap:calc(var(--u) * ${num(stack.gap ?? 0)})`, `align-items:${{ start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch' }[stack.align ?? 'stretch']}`] : [];
      return `<div class="layer group${stack ? ' stack' : ''}" ${attrs} style="${box([...shared, ...flow])}">${kids}</div>`;
    }
    default:
      return ''; // video layers belong to the video renderer (Phase 4)
  }
}

function safeOverlay(safe) {
  const band = (css) => `<div style="position:absolute;${css};background:rgba(255,40,60,.28)"></div>`;
  const pct = (f) => `calc(var(--ch) * ${num(f)})`;
  const pctW = (f) => `calc(var(--cw) * ${num(f)})`;
  return `<div id="safe-overlay" style="position:absolute;inset:0;pointer-events:none;z-index:99999">
${band(`left:0;top:0;right:0;height:${pct(safe.top)}`)}
${band(`left:0;bottom:0;right:0;height:${pct(safe.bottom)}`)}
${band(`left:0;top:${pct(safe.top)};bottom:${pct(safe.bottom)};width:${pctW(safe.left)}`)}
${band(`right:0;top:${pct(safe.top)};bottom:${pct(safe.bottom)};width:${pctW(safe.right)}`)}
<div style="position:absolute;left:${pctW(safe.left)};right:${pctW(safe.right)};top:${pct(safe.top)};bottom:${pct(safe.bottom)};outline:calc(var(--u) * 3) dashed rgba(255,40,60,.9)"></div>
</div>`;
}

/**
 * @param {{doc:object, brand:object, size:{id:string,w:number,h:number,safe?:object}, page:object, showSafe?:boolean,
 *          fontManifest:object, urls:{project:string, fonts:string}}} input
 * @returns {{html:string, warnings:string[], fontFamilies:string[]}}
 */
export function buildPageHtml({ doc, brand, size, page, showSafe = false, fontManifest, urls }) {
  if (!fontManifest || !urls) throw new Error('buildPageHtml needs fontManifest and urls');
  const fonts = new FontBook(fontManifest, urls);
  const c = makeContext({ doc, brand, size, fonts, urls });
  const background = c.fill(page.background) ?? c.colour('$brand.colors.paper') ?? '#ffffff';
  const body = page.layers.map((l, i) => layerHtml(l, c, `/pages/${doc.pages.indexOf(page)}/layers/${i}`)).join('\n');
  const links = [...fonts.links].map((href) => `<link rel="stylesheet" href="${urls.fonts}/${href}">`).join('\n');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(doc.title)}</title>
${links}
<style>
${fonts.faces.join('\n')}
:root{--cw:${size.w}px;--ch:${size.h}px;--u:calc(var(--cw) / 1080)}
*{box-sizing:border-box}
html,body{margin:0;padding:0;width:var(--cw);height:var(--ch);overflow:hidden;background:#fff}
body{-webkit-font-smoothing:antialiased;text-rendering:geometricPrecision;font-kerning:normal;font-optical-sizing:auto}
#canvas{position:relative;width:var(--cw);height:var(--ch);overflow:hidden;background:${background}}
.layer{margin:0}
.text{overflow-wrap:normal}
</style></head>
<body><div id="canvas">
${body}
${showSafe && size.safe ? safeOverlay(size.safe) : ''}
</div></body></html>`;
  return { html, warnings: [...fonts.warnings], fontFamilies: [...fonts.cache.values()] };
}

export { len as lengthCss, ANCHORS };
