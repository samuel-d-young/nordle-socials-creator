// Checks that need a rendered page: text that is cut off, overflows its box, sits under platform UI, is too small
// or too faint; plus document-level checks on copy (banned phrases, caption length, alt text).

import { PNG } from 'pngjs';

export const MIN_TEXT_PX = 24; // at a 1080-wide canvas

const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const luminance = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

export function decodePng(buffer) { return PNG.sync.read(buffer); }

/** Parse a computed CSS colour (rgb/rgba, or color(srgb r g b)). Returns {r,g,b,a} on 0-255 / 0-1, or null. */
export function parseColour(css) {
  let m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/.exec(css);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: +m[1], g: +m[2], b: +m[3], a };
  }
  m = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/.exec(css);
  if (m) return { r: +m[1] * 255, g: +m[2] * 255, b: +m[3] * 255, a: m[4] === undefined ? 1 : +m[4] };
  return null;
}

/** Luminance spread (5th and 95th percentile) of the pixels behind a rectangle. */
export function backdropLuminance(png, rect, scale) {
  const x0 = Math.max(0, Math.floor(rect.x * scale));
  const y0 = Math.max(0, Math.floor(rect.y * scale));
  const x1 = Math.min(png.width, Math.ceil((rect.x + rect.w) * scale));
  const y1 = Math.min(png.height, Math.ceil((rect.y + rect.h) * scale));
  if (x1 <= x0 || y1 <= y0) return null;
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 4000)));
  const values = [];
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (png.width * y + x) << 2;
      values.push(luminance(png.data[i], png.data[i + 1], png.data[i + 2]));
    }
  }
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  return { low: values[Math.floor(values.length * 0.05)], high: values[Math.floor(values.length * 0.95)] };
}

function mk(level, rule, where, message) { return { level, rule, ...where, message }; }

/** Checks for one rendered page. `layers` comes from the in-page inspector. */
export function checkRenderedPage({ size, page, layers, backdrop, scale }) {
  const issues = [];
  const where = (layer) => ({ size: size.id, page: page.id, layer });
  const u = size.w / 1080;
  const safe = size.safe && {
    left: size.w * size.safe.left, right: size.w * (1 - size.safe.right),
    top: size.h * size.safe.top, bottom: size.h * (1 - size.safe.bottom),
  };

  for (const l of layers) {
    if (l.type === 'text') {
      const r = l.rect;
      if (r.w === 0 && r.h === 0) continue;
      if (r.x < -2 || r.y < -2 || r.x + r.w > size.w + 2 || r.y + r.h > size.h + 2) {
        issues.push(mk('error', 'text-cut-off', where(l.id), 'Text runs off the edge of the picture.'));
      }
      if (l.overflowX > 2 || (l.fixedH && l.overflowY > 2)) {
        issues.push(mk('warn', 'text-overflow', where(l.id), 'Text does not fit its box (a long word or a box that is too small).'));
      }
      if (safe && !l.ignoreSafe && (r.x < safe.left - 1 || r.x + r.w > safe.right + 1 || r.y < safe.top - 1 || r.y + r.h > safe.bottom + 1)) {
        issues.push(mk('warn', 'safe-zone', where(l.id), `Text reaches into the area ${size.preset?.platform ?? 'the platform'} covers with its own buttons and captions.`));
      }
      const ref = l.fontSize / u;
      if (ref < MIN_TEXT_PX) {
        issues.push(mk('warn', 'text-small', where(l.id), `Text is ${ref.toFixed(0)} px on a 1080-wide picture; under ${MIN_TEXT_PX} px is hard to read on a phone.`));
      }
      if (backdrop) {
        const runs = l.runs?.length ? l.runs : [{ color: l.color, rect: l.rect }];
        const large = ref >= 40 || (ref >= 32 && Number(l.fontWeight) >= 700);
        const needed = large ? 3 : 4.5;
        let worst = Infinity;
        let worstColour = null;
        for (const run of runs) {
          const c = parseColour(run.color);
          const bg = backdropLuminance(backdrop, run.rect.w > 0 ? run.rect : l.rect, scale);
          if (!c || !bg) continue;
          if (c.a < 0.98) continue; // semi-transparent text: skipped, we cannot be sure what it blends with
          const t = luminance(c.r, c.g, c.b);
          const worstHere = Math.min(ratio(t, bg.low), ratio(t, bg.high));
          if (worstHere < worst) { worst = worstHere; worstColour = run.color; }
        }
        if (worst < needed) {
          const level = worst < 2 ? 'error' : 'warn';
          issues.push(mk(level, 'contrast', where(l.id), `Contrast is ${worst.toFixed(1)}:1 (${worstColour}); this size of text should reach ${needed}:1 to read well.`));
        }
      }
    } else if (l.type === 'image' && l.alt === null) {
      issues.push(mk('warn', 'image-alt', where(l.id), 'Image has no alt text. Write a description, or set alt to "" if it is only decoration.'));
    }
    if (l.type !== 'group' && l.boxRect) {
      const b = l.boxRect;
      if (b.x >= size.w || b.y >= size.h || b.x + b.w <= 0 || b.y + b.h <= 0) {
        issues.push(mk('warn', 'off-canvas', where(l.id), 'Layer is completely outside the picture at this size.'));
      }
    }
  }
  return issues;
}

const norm = (s) => String(s).toLowerCase().replace(/[‘’]/g, "'");

function layerTexts(layers, out = []) {
  for (const l of layers ?? []) {
    if (l.type === 'text') out.push({ layer: l.id, text: [l.text, ...(l.runs ?? []).map((r) => r.text), ...Object.values(l.overrides ?? {}).map((o) => o.text)].filter(Boolean).join(' ') });
    if (l.children) layerTexts(l.children, out);
  }
  return out;
}

/** Text set in the brand's script font that cannot be read there: capitals run together ("AHPRA" becomes a scrawl), and so does anything forced to upper case. */
function scriptProblems(layers, brand, out = [], page = null) {
  const family = brand?.fonts?.script?.family;
  const isScript = (f) => !!f && (f === '$brand.fonts.script' || (family && f === family));
  for (const l of layers ?? []) {
    if (l.type === 'text') {
      const whole = isScript(l.style?.font);
      const bits = whole ? [l.text, ...(l.runs ?? []).map((r) => r.text)] : (l.runs ?? []).filter((r) => isScript(r.style?.font)).map((r) => r.text);
      const upper = whole && l.style?.uppercase;
      for (const t of bits.filter(Boolean)) {
        const acronym = String(t).match(/[A-Z]{2,}[A-Za-z-]*/);
        if (acronym || upper) out.push({ page, layer: l.id, word: acronym ? acronym[0] : String(t).slice(0, 24) });
      }
    }
    if (l.children) scriptProblems(l.children, brand, out, page);
  }
  return out;
}

/** Checks on the document's words and metadata. Needs no browser. */

export function checkDocumentCopy({ doc, brand, sizes }) {
  const issues = [];
  const copy = doc.copy ?? {};
  const banned = (brand?.voice?.bannedPhrases ?? []).map(norm);

  if (banned.length) {
    const places = [
      ['copy.caption', copy.caption], ['copy.cta', copy.cta], ['copy.hashtags', (copy.hashtags ?? []).join(' ')],
      ...(doc.pages ?? []).flatMap((p) => layerTexts(p.layers).map((t) => [`${p.id}/${t.layer}`, t.text])),
      ...layerTexts(doc.layers).map((t) => [`overlay/${t.layer}`, t.text]),
    ];
    for (const [where, text] of places) {
      if (!text) continue;
      const hay = norm(text);
      for (const phrase of banned) {
        if (hay.includes(phrase)) issues.push(mk('error', 'banned-phrase', { size: null, page: null, layer: where }, `Contains "${phrase}", which this brand's voice rules ban.`));
      }
    }
  }

  const scripts = [...(doc.pages ?? []).flatMap((p) => scriptProblems(p.layers, brand, [], p.id)), ...scriptProblems(doc.layers, brand)];
  for (const sp of scripts) issues.push(mk('error', 'script-legibility', { size: null, page: sp.page, layer: sp.layer }, `"${sp.word}" is set in the script font, where capital letters run together and cannot be read. Use the display font (italic is fine) for acronyms and anything in capitals.`));

  const limits = sizes.map((s) => s.preset?.maxCaption).filter(Boolean);
  if (limits.length) {
    const limit = Math.min(...limits);
    const full = [copy.caption, copy.cta, (copy.hashtags ?? []).map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' ')].filter(Boolean).join('\n\n');
    if (full.length > limit) issues.push(mk('error', 'caption-length', { size: null, page: null, layer: 'copy' }, `Caption, call to action and hashtags total ${full.length} characters; the shortest limit among this post's platforms is ${limit}.`));
  }
  if (!copy.caption) issues.push(mk('warn', 'no-caption', { size: null, page: null, layer: 'copy' }, 'No caption written yet.'));
  for (const p of doc.pages ?? []) {
    if (!copy.alt?.[p.id]) issues.push(mk('warn', 'alt-missing', { size: null, page: p.id, layer: 'copy.alt' }, `No alt text for page "${p.id}".`));
  }
  if (doc.kind === 'video' && !copy.alt?.video) issues.push(mk('warn', 'alt-missing', { size: null, page: null, layer: 'copy.alt' }, 'No alt text for the video.'));
  return issues;
}
