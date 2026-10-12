// Draft a brand's style guide from what already exists: a folder of brand files, the website, an Instagram page, a few pasted captions.
// Best effort and honest: every source reports what it found, or why it could not be read (Instagram usually wants a sign-in, so
// pasted captions and the bio are the dependable way in). Nothing is saved here: the result is a DRAFT the person reviews and edits.
// Colours are worked out from the pictures and the CSS themselves, never invented; fonts are only named when the files or the page say so.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { binary } from '../video/ffmpeg.mjs';
import { UNREADABLE_DOC_EXT, readGuideFile } from './guide-text.mjs';
import { cleanIndustry, detectIndustry } from './industry.mjs';

const IMG = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const FONT = new Set(['.ttf', '.otf', '.woff', '.woff2']);
const MAX_HTML = 1_500_000, MAX_CSS = 400_000;
const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'inherit', 'initial', 'unset', 'ui-sans-serif', 'ui-serif', 'ui-monospace', '-apple-system', 'blinkmacsystemfont', 'segoe ui', 'arial', 'helvetica', 'helvetica neue', 'times new roman', 'georgia', 'roboto']);

// ---- colour maths -----------------------------------------------------------------------------------------------------------------

const toHex = ([r, g, b]) => `#${[r, g, b].map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
const fromHex = (h) => { const s = h.replace('#', ''); const f = s.length === 3 ? [...s].map((c) => c + c).join('') : s; return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16)); };
function hsl([r, g, b]) {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B), l = (max + min) / 2, d = max - min;
  if (!d) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return { h: ((h * 60) + 360) % 360, s, l };
}
function fromHsl({ h, s, l }) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** A palette: Map(hex -> weight). Turns it into the five colours the style guide asks for. */
export function colorsFromPalette(palette) {
  const items = [...palette].map(([hex, w]) => ({ hex, w, rgb: fromHex(hex), ...hsl(fromHex(hex)) })).sort((a, b) => b.w - a.w);
  const notes = [];
  if (!items.length) return { colors: null, notes: ['No colours could be read.'] };
  const light = items.filter((c) => c.l > 0.9 && c.s < 0.35);
  const dark = items.filter((c) => c.l < 0.28);
  const vivid = items.filter((c) => c.s > 0.22 && c.l > 0.2 && c.l < 0.8);
  const paper = light[0]?.rgb ?? [250, 247, 242];
  const accent = vivid[0]?.rgb ?? (items.find((c) => c.l > 0.25 && c.l < 0.75)?.rgb ?? [194, 65, 12]);
  const ink = dark[0]?.rgb ?? fromHsl({ ...hsl(accent), l: 0.14, s: Math.min(0.5, hsl(accent).s) });
  const accentDark = fromHsl({ ...hsl(accent), l: Math.max(0.12, hsl(accent).l * 0.72) });
  if (!light.length) notes.push('No light background colour found: a soft off-white was used.');
  if (!vivid.length) notes.push('No strong colour found: the most common mid-tone was used as the accent.');
  // the brand's other colours: distinct, still-weighty ones the five above do not already cover (a second brand colour, a highlight)
  const taken = [paper, accent, ink, accentDark];
  const extras = items.filter((c) => c.w >= Math.max(3, items[0].w * 0.04) && c.s > 0.18 && c.l > 0.12 && c.l < 0.92 && taken.every((t) => dist(t, c.rgb) > 60));
  const more = {};
  for (const name of ['secondary', 'tertiary', 'highlight']) {
    const c = extras.find((e) => taken.every((t) => dist(t, e.rgb) > 60));
    if (!c) break;
    more[name] = toHex(c.rgb); taken.push(c.rgb);
  }
  return { colors: { ink: toHex(ink), paper: toHex(paper), accent: toHex(accent), accentDark: toHex(accentDark), muted: toHex(mix(ink, paper, 0.55)), ...more }, notes };
}

/**
 * Dominant colours of picture files, as Map(hex -> weight). Uses ffmpeg (already needed by Nordle); transparent pixels are ignored.
 * Pixels are grouped into coarse bins to find what is common, but each group is reported as the exact colour most often seen in it, so a logo's
 * #1B6CA8 comes back as #1B6CA8 and not as the middle of its bin. The picture is sampled, not blended, so flat logo colours stay exact.
 */
export function paletteOf(files, { weight = 1 } = {}) {
  const out = new Map();
  for (const file of files) {
    let r;
    try { r = spawnSync(binary('ffmpeg'), ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', 'scale=96:96:flags=neighbor,format=rgba', '-f', 'rawvideo', '-'], { maxBuffer: 96 * 96 * 4 + 1024, windowsHide: true }); } catch { continue; }
    if (r.status !== 0 || !r.stdout?.length) continue;
    const px = r.stdout;
    const bins = new Map();                       // bin -> Map(exact hex -> count)
    for (let i = 0; i + 3 < px.length; i += 4) {
      if (px[i + 3] < 128) continue;
      const bin = ((px[i] >> 4) << 8) | ((px[i + 1] >> 4) << 4) | (px[i + 2] >> 4);
      const exact = toHex([px[i], px[i + 1], px[i + 2]]);
      const m = bins.get(bin) ?? bins.set(bin, new Map()).get(bin);
      m.set(exact, (m.get(exact) ?? 0) + 1);
    }
    for (const m of bins.values()) {
      let total = 0, best = null, bestN = 0;
      for (const [hex, n] of m) { total += n; if (n > bestN) { best = hex; bestN = n; } }
      out.set(best, (out.get(best) ?? 0) + total * weight);
    }
  }
  return out;
}

/** Colours written in an SVG (fill, stroke, stop-color, style): Map(hex -> weight). */
export function svgPalette(text, weight = 1) {
  const out = new Map();
  const body = String(text ?? '').slice(0, 400_000);
  for (const m of body.matchAll(/(?:fill|stroke|stop-color|flood-color|color)\s*[:=]\s*["']?\s*(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3})\b/g)) { const h = toHex(fromHex(m[1])); out.set(h, (out.get(h) ?? 0) + weight); }
  for (const m of body.matchAll(/(?:fill|stroke|stop-color)\s*[:=]\s*["']?\s*(rgba?\([^)]*\))/gi)) { const h = parseColour(m[1]); if (h) out.set(h, (out.get(h) ?? 0) + weight); }
  return out;
}

/** A CSS colour (#abc, #aabbcc, rgb(), rgba(), hsl(), hsla()) as #RRGGBB; null when it is not one or is mostly see-through. */
export function parseColour(raw) {
  const v = String(raw ?? '').trim();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(v);
  if (m) { const h = m[1].length === 8 ? m[1].slice(0, 6) : m[1]; if (m[1].length === 8 && parseInt(m[1].slice(6), 16) < 128) return null; return toHex(fromHex(`#${h}`)); }
  m = /^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(v);
  if (m) {
    const ch = (x) => (x.endsWith('%') ? (parseFloat(x) / 100) * 255 : parseFloat(x));
    const alpha = m[4] === undefined ? 1 : (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
    return alpha < 0.5 ? null : toHex([ch(m[1]), ch(m[2]), ch(m[3])]);
  }
  m = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)(%?)\s+([\d.]+)(?:deg)?(?:\s*\/\s*([\d.]+%?))?\s*\)$/i.exec(v);
  if (m) {
    const alpha = m[6] === undefined ? 1 : (m[6].endsWith('%') ? parseFloat(m[6]) / 100 : parseFloat(m[6]));
    if (alpha < 0.5) return null;
    const L = m[2] ? parseFloat(m[1]) / 100 : parseFloat(m[1]), C = m[4] ? (parseFloat(m[3]) / 100) * 0.4 : parseFloat(m[3]), H = (parseFloat(m[5]) * Math.PI) / 180;
    const a = C * Math.cos(H), b = C * Math.sin(H);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, ss = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const lin = [4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * ss, -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * ss, -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * ss];
    const gamma = (x) => { const c = Math.min(1, Math.max(0, x)); return (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055) * 255; };
    return toHex(lin.map(gamma));
  }
  m = /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(v);
  if (m) {
    const alpha = m[4] === undefined ? 1 : (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
    if (alpha < 0.5) return null;
    const hh = (parseFloat(m[1]) % 360 + 360) % 360 / 360, ss = parseFloat(m[2]) / 100, ll = parseFloat(m[3]) / 100;
    const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss, pp = 2 * ll - q;
    const f = (t) => { t = (t + 1) % 1; return t < 1 / 6 ? pp + (q - pp) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? pp + (q - pp) * (2 / 3 - t) * 6 : pp; };
    return toHex([f(hh + 1 / 3) * 255, f(hh) * 255, f(hh - 1 / 3) * 255]);
  }
  return null;
}

const addPalette = (into, from) => { for (const [k, v] of from) into.set(k, (into.get(k) ?? 0) + v); return into; };

// ---- a folder --------------------------------------------------------------------------------------------------------------------

function walk(dir, depth, out) {
  if (depth > 3 || out.length > 400) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || ['node_modules', '$RECYCLE.BIN', 'System Volume Information'].includes(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, depth + 1, out);
    else if (e.isFile()) out.push(p);
  }
}

/** Font family guessed from a font file name: "SortsMillGoudy-Italic.otf" -> "Sorts Mill Goudy". */
export function familyOf(file) {
  const base = basename(file, extname(file)).replace(/[-_ ](regular|bold|italic|light|medium|semibold|extrabold|black|thin|book|roman|oblique|variable|\d{3})+.*$/i, '');
  return base.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function scanFolder(folder) {
  if (!folder) return { found: [], problems: [], palette: new Map(), fonts: [], docs: [] };
  if (!existsSync(folder) || !statSync(folder).isDirectory()) return { found: [], problems: [`The folder "${folder}" was not found.`], palette: new Map(), fonts: [], docs: [] };
  const files = [];
  walk(folder, 0, files);
  return scanFileList(files, { where: 'the folder' });
}

/** Read a set of files (from a folder, or ones the person added): pictures for colours, font files for fonts, written style guides for what they say. */
export function scanFileList(files, { where = 'the files you added' } = {}) {
  const found = [], problems = [];
  const images = files.filter((f) => IMG.has(extname(f).toLowerCase()));
  const fontFiles = files.filter((f) => FONT.has(extname(f).toLowerCase()));
  const logos = images.filter((f) => /logo|brand|mark|wordmark|palette|style/i.test(basename(f)));
  const rest = images.filter((f) => !logos.includes(f)).sort((a, b) => statSync(a).size - statSync(b).size).slice(0, 6);   // small files first: graphics before big photos
  const palette = new Map();
  if (logos.length) addPalette(palette, paletteOf(logos.slice(0, 5), { weight: 4 }));
  if (rest.length) addPalette(palette, paletteOf(rest, { weight: 1 }));
  const svgs = files.filter((f) => /\.svg$/i.test(f)).slice(0, 8);
  for (const f of svgs) { try { addPalette(palette, svgPalette(readFileSync(f, 'utf8'), /logo|brand|mark|wordmark/i.test(basename(f)) ? 400 : 60)); } catch { /* unreadable svg */ } }
  if (svgs.length) found.push(`Read the colours in ${svgs.length} SVG file${svgs.length === 1 ? '' : 's'}.`);
  found.push(`Looked through ${files.length} files in ${where}: ${images.length} pictures${logos.length ? ` (${logos.length} look like logos)` : ''}, ${fontFiles.length} font files.`);
  // written style guides: any text file, but in a big folder only the ones named like a guide
  const textFiles = files.filter((f) => /\.(md|markdown|txt|css|html?|json)$/i.test(f)).filter((f) => files.length <= 12 || /style|brand|guide|voice|tone|identity|colou?r|typo/i.test(basename(f))).slice(0, 6);
  const docs = textFiles.map(readGuideFile).filter((d) => d && (d.colours.size || d.fonts.display || d.fonts.body || d.fonts.other.length || d.tone.length || d.banned.length));
  for (const d of docs) {
    for (const [k, v] of d.colours) palette.set(k, (palette.get(k) ?? 0) + v);
    const named = [...new Set([d.fonts.display, d.fonts.body, ...d.fonts.other].filter(Boolean))];
    const bits = [d.colours.size ? `${d.colours.size} colours` : null, named.length ? `fonts (${named.slice(0, 3).join(', ')})` : null, d.tone.length ? `tone (${d.tone.slice(0, 4).join(', ')})` : null, d.banned.length ? `${d.banned.length} phrases to avoid` : null].filter(Boolean);
    found.push(`Read the style guide "${d.name}": ${bits.join('; ')}.`);
  }
  for (const f of files.filter((x) => UNREADABLE_DOC_EXT.has(extname(x).toLowerCase()))) problems.push(`"${basename(f)}" is a ${extname(f).slice(1).toUpperCase()} file, which Nordle cannot read yet. It is kept with the brand: paste its colours, fonts and tone into the boxes instead.`);
  if (!images.length && !docs.length && !svgs.length) problems.push(`There are no pictures or readable style guides in ${where} to take colours from.`);
  else if (images.length && !logos.length) found.push('No file is named like a logo, so colours came from the pictures themselves. A logo gives better colours: name it with "logo" in the file name.');
  const fileFonts = [...new Set(fontFiles.map(familyOf).filter(Boolean))].slice(0, 4);
  if (fileFonts.length) found.push(`Fonts in ${where}: ${fileFonts.join(', ')}.`);
  const guideFonts = docs.flatMap((d) => [d.fonts.display, d.fonts.body, ...d.fonts.other]).filter(Boolean);
  const fonts = [...new Set([...fileFonts, ...guideFonts])].slice(0, 4);
  return { found, problems, palette, fonts, fileFonts, docs, logos: logos.slice(0, 3) };
}

// ---- web pages ---------------------------------------------------------------------------------------------------------------------

async function getText(url, { fetchImpl, max, timeout = 10000 }) {
  if (!/^https?:\/\//i.test(url)) throw new Error('Only web addresses (http or https) can be read.');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const res = await fetchImpl(url, { signal: ac.signal, redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (compatible; NordleBrandSetup/0.1)', accept: 'text/html,text/css,*/*' } });
    if (!res.ok) throw new Error(`the site answered ${res.status}`);
    const text = await res.text();
    return { text: text.slice(0, max), url: res.url || url };
  } finally { clearTimeout(timer); }
}
async function getImage(url, { fetchImpl }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10000);
  try {
    const res = await fetchImpl(url, { signal: ac.signal, headers: { 'user-agent': 'Mozilla/5.0 (compatible; NordleBrandSetup/0.1)' } });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > 6_000_000) return null;
    return buf;
  } catch { return null; } finally { clearTimeout(timer); }
}

const attr = (tag, name) => { const m = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag); return m ? (m[2] ?? m[3]) : null; };
export function metaOf(html) {
  const meta = {};
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const key = (attr(m[0], 'property') ?? attr(m[0], 'name') ?? '').toLowerCase();
    const content = attr(m[0], 'content');
    if (key && content && !(key in meta)) meta[key] = decodeEntities(content);
  }
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (t) meta.title = decodeEntities(t[1].trim().replace(/\s+/g, ' '));
  return meta;
}
const decodeEntities = (s) => s.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'");

/** Colours and fonts a page's CSS says it uses. Returns { palette: Map, fonts: {display, body} }. */
export function cssFacts(css) {
  const palette = new Map();
  const add = (hex, w) => { if (!hex) return; const h = toHex(fromHex(hex)); palette.set(h, (palette.get(h) ?? 0) + w); };
  const text = String(css ?? '');
  // every colour written anywhere counts a little; the places that do a job count more
  const seen = new Map();
  for (const m of text.matchAll(/#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b|rgba?\([^)]*\)|hsla?\([^)]*\)|oklch\([^)]*\)/g)) { const c = parseColour(m[0]); if (c) seen.set(c, (seen.get(c) ?? 0) + 1); }
  for (const [c, n] of seen) add(c, Math.min(4, Math.log2(n + 1)));
  const rules = [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].replace(/\/\*[\s\S]*?\*\//g, '').split(';').pop().trim(), decls: [...m[2].matchAll(/([a-z-]+|--[\w-]+)\s*:\s*([^;}]+)/gi)].map((d) => [d[1].toLowerCase(), d[2].trim()]) }));
  const vars = new Map();
  for (const r of rules) for (const [k, v] of r.decls) if (k.startsWith('--')) vars.set(k, v);
  const resolve = (v, depth = 0) => { const m = /^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)$/i.exec(String(v).trim()); return m && depth < 4 ? resolve(vars.get(m[1]) ?? m[2] ?? '', depth + 1) : String(v).trim(); };
  const NAMED = /primary|brand|accent|main|theme|heading|button|secondary|cta|link|highlight|colou?r-?\d|logo/i;
  for (const [k, v] of vars) { const c = parseColour(resolve(v)); if (c) add(c, NAMED.test(k) ? 12 : /colou?r|bg|background|text|ink|paper|surface/i.test(k) ? 6 : 0); }
  const DOES_A_JOB = /(^|[\s,>.#])(h[1-4]|a|button|nav|header|footer|btn|button|cta|hero|primary|accent|brand|logo|badge)\b/i;
  for (const r of rules) for (const [k, v0] of r.decls) {
    if (k.startsWith('--')) continue;
    const c = parseColour(resolve(v0.split(/\s+/).find((t) => /^(#|rgb|hsl|var)/i.test(t)) ?? v0));
    if (!c) continue;
    if (/^(body|html|:root)\b/.test(r.sel) && /^background(-color)?$/.test(k)) add(c, 8);
    else if (/^(body|html|:root|p)\b/.test(r.sel) && k === 'color') add(c, 8);
    else if (DOES_A_JOB.test(r.sel) && /^(color|background(-color)?|border(-color)?|fill)$/.test(k)) add(c, 5);
  }
  // fonts: through var(--font-x), @font-face (a font the site ships itself), and what headings and the body use
  const count = { display: new Map(), body: new Map() };
  const faces = new Set();
  const first = (raw) => { const f = resolve(raw).split(',')[0].trim().replace(/^["']|["']$/g, '').replace(/!important/i, '').trim(); return f && !GENERIC.has(f.toLowerCase()) && !f.startsWith('var(') ? f : null; };
  for (const r of rules) {
    const fam = r.decls.find(([k]) => k === 'font-family');
    if (!fam) continue;
    const name = first(fam[1]);
    if (!name) continue;
    if (/^@font-face/i.test(r.sel)) { faces.add(name); continue; }
    const bucket = /\bh[1-4]\b|heading|title|display|hero|headline/i.test(r.sel) ? count.display : count.body;
    const weight = /^(body|html|:root|\*)$/i.test(r.sel) || /\bh1\b/i.test(r.sel) ? 3 : 1;
    bucket.set(name, (bucket.get(name) ?? 0) + weight);
  }
  for (const [k, v] of vars) {
    if (!/^--(font|type|typeface|ff)[\w-]*/i.test(k)) continue;
    const name = first(v);
    if (!name) continue;
    const bucket = /head|display|title|serif-?display/i.test(k) ? count.display : /body|text|base|sans|copy|paragraph/i.test(k) ? count.body : null;
    if (bucket) bucket.set(name, (bucket.get(name) ?? 0) + 4);
  }
  const top = (m) => [...m].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const display = top(count.display), body = top(count.body);
  const shipped = [...faces];
  return { palette, fonts: { display: display ?? shipped[0] ?? null, body: body ?? shipped.find((f) => f !== display) ?? null }, shipped };
}
const googleFonts = (html) => [...html.matchAll(/fonts\.googleapis\.com\/css2?\?([^"'<>\s]+)/gi)].flatMap((m) => [...m[1].matchAll(/family=([^&:;"']+)/g)].map((f) => decodeURIComponent(f[1].replace(/\+/g, ' '))));

export async function scanWebsite(url, { fetchImpl }) {
  const found = [], problems = [];
  const out = { found, problems, palette: new Map(), fonts: { display: null, body: null }, meta: {} };
  let page;
  try { page = await getText(url, { fetchImpl, max: MAX_HTML }); } catch (e) { problems.push(`The website could not be read (${e.cause?.code ?? e.message}).`); return out; }
  const meta = metaOf(page.text);
  out.meta = meta;
  const strip = (html) => html.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&amp;|&#?\w+;/g, ' ').replace(/\s+/g, ' ');
  const heads = [...page.text.matchAll(/<h[1-2][^>]*>([\s\S]*?)<\/h[1-2]>/gi)].map((m) => strip(m[1])).join(' . ');
  out.words = [{ text: [meta.title, meta['og:site_name'], meta['og:title'], meta.description, meta['og:description']].filter(Boolean).join(' . '), weight: 3 }, { text: heads, weight: 2 }, { text: strip(page.text).slice(0, 8000), weight: 1 }];
  found.push(`Read ${page.url}${meta['og:site_name'] || meta.title ? `: "${meta['og:site_name'] ?? meta.title}"` : ''}.`);
  let css = [...page.text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
  const links = [...page.text.matchAll(/<link\b[^>]*rel\s*=\s*["']?stylesheet[^>]*>/gi)].map((m) => attr(m[0], 'href')).filter(Boolean).filter((h) => !/fonts\.googleapis\.com/i.test(h)).slice(0, 8);
  const seenCss = new Set();
  const loadCss = async (href, depth = 0) => {
    let abs; try { abs = new URL(href, page.url).href; } catch { return; }
    if (seenCss.has(abs) || seenCss.size >= 10) return;
    seenCss.add(abs);
    try {
      const got = (await getText(abs, { fetchImpl, max: MAX_CSS })).text;
      css += `\n${got}`;
      if (depth < 1) for (const m of got.matchAll(/@import\s+(?:url\()?["']?([^"')\s;]+)/gi)) if (!/fonts\.googleapis\.com/i.test(m[1])) await loadCss(new URL(m[1], abs).href, depth + 1);
    } catch { /* a stylesheet that will not load is skipped */ }
  };
  for (const href of links) await loadCss(href);
  const facts = cssFacts(css);
  addPalette(out.palette, facts.palette);
  if (meta['theme-color'] && /^#[0-9a-f]{3,6}$/i.test(meta['theme-color'])) { out.palette.set(toHex(fromHex(meta['theme-color'])), (out.palette.get(toHex(fromHex(meta['theme-color']))) ?? 0) + 40); found.push(`The site's own theme colour is ${meta['theme-color']}.`); }
  const gf = googleFonts(page.text + css);
  out.fonts = { display: facts.fonts.display ?? gf[0] ?? null, body: facts.fonts.body ?? gf[1] ?? gf[0] ?? null };
  if (out.fonts.display || out.fonts.body) found.push(`Fonts used on the site: ${[...new Set([out.fonts.display, out.fonts.body].filter(Boolean))].join(', ')}.`);
  if (facts.shipped?.length) found.push(`Fonts the site ships itself: ${facts.shipped.slice(0, 4).join(', ')}.`);
  if (!out.palette.size) problems.push('No colours were found in the site\'s styles. Sites that draw themselves with JavaScript, or load their styles late, cannot be read this way: add the logo as a file instead.');
  // the logo (and the site's icon) are the truest brand colours on the page
  const imgTags = [...page.text.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  const logoTag = imgTags.find((t) => /logo/i.test(t));
  const iconTag = [...page.text.matchAll(/<link\b[^>]*rel\s*=\s*["']?(?:apple-touch-icon|icon|shortcut icon)[^>]*>/gi)].map((m) => m[0])[0];
  for (const [label, tag, w] of [['logo', logoTag, 8], ['icon', iconTag, 3]]) {
    const src = tag && (attr(tag, label === 'logo' ? 'src' : 'href') ?? attr(tag, 'data-src'));
    if (!src || src.startsWith('data:')) continue;
    let abs; try { abs = new URL(src, page.url).href; } catch { continue; }
    const got = await getImage(abs, { fetchImpl });
    if (!got) continue;
    const head = got.subarray(0, 400).toString('utf8');
    let pal = new Map();
    if (/<svg[\s>]/i.test(head) || /\.svg(\?|$)/i.test(abs)) pal = svgPalette(got.toString('utf8'), w * 10);
    else { const dir2 = mkdtempSync(join(tmpdir(), 'nordle-scan-')); try { const f = join(dir2, 'img'); writeFileSync(f, got); pal = paletteOf([f], { weight: w }); } finally { rmSync(dir2, { recursive: true, force: true }); } }
    if (pal.size) { addPalette(out.palette, pal); found.push(`Colours were also taken from the site's ${label}.`); }
  }
  const img = meta['og:image'] ? await getImage(new URL(meta['og:image'], page.url).href, { fetchImpl }) : null;
  if (img) {
    const dir = mkdtempSync(join(tmpdir(), 'nordle-scan-'));
    try { const f = join(dir, 'og'); writeFileSync(f, img); addPalette(out.palette, paletteOf([f], { weight: 3 })); found.push('Colours were also taken from the site\'s share picture.'); } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  return out;
}

export const handleOf = (s) => {
  const m = /instagram\.com\/([A-Za-z0-9._]+)/i.exec(String(s ?? ''));
  const h = m ? m[1] : String(s ?? '').trim().replace(/^@/, '');
  return /^[A-Za-z0-9._]{1,30}$/.test(h) ? h : '';
};

export async function scanInstagram(input, { fetchImpl }) {
  const found = [], problems = [];
  const handle = handleOf(input);
  const out = { found, problems, palette: new Map(), handle, meta: {} };
  if (!handle) { if (input) problems.push('That does not look like an Instagram name or address.'); return out; }
  found.push(`Instagram: @${handle}.`);
  let page;
  try { page = await getText(`https://www.instagram.com/${handle}/`, { fetchImpl, max: MAX_HTML }); } catch (e) { problems.push(`Instagram would not show @${handle} without signing in. Paste the bio and a few captions below instead.`); return out; }
  const meta = metaOf(page.text);
  out.meta = meta;
  const desc = meta['og:description'] ?? meta.description ?? '';
  if (!desc || /log in|login/i.test(meta.title ?? '') && !desc) { problems.push(`Instagram would not show @${handle} without signing in. Paste the bio and a few captions below instead.`); return out; }
  found.push(`From the page preview: ${desc.slice(0, 220)}`);
  const img = meta['og:image'] ? await getImage(meta['og:image'], { fetchImpl }) : null;
  if (img) {
    const dir = mkdtempSync(join(tmpdir(), 'nordle-scan-'));
    try { const f = join(dir, 'pp'); writeFileSync(f, img); addPalette(out.palette, paletteOf([f], { weight: 2 })); found.push('Colours were taken from the profile picture.'); } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  return out;
}

/** Hashtags and style hints from pasted captions. */
export function scanCaptions(text) {
  const t = String(text ?? '').trim();
  if (!t) return { found: [], hashtags: [], hints: {} };
  const tags = new Map();
  for (const m of t.matchAll(/#[\p{L}\p{N}_]{2,40}/gu)) tags.set(m[0], (tags.get(m[0]) ?? 0) + 1);
  const hashtags = [...tags].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k]) => k);
  const emoji = (t.match(/\p{Extended_Pictographic}/gu) ?? []).length;
  const words = t.split(/\s+/).filter(Boolean).length;
  const found = [`Read ${words} words of captions${hashtags.length ? `; usual hashtags: ${hashtags.join(' ')}` : ''}.`];
  const hints = { emojiHeavy: emoji / Math.max(1, words) > 0.04, usesHashtags: hashtags.length > 0, exclaims: (t.match(/!/g) ?? []).length / Math.max(1, words) > 0.03 };
  return { found, hashtags, hints };
}

// ---- the whole scan ----------------------------------------------------------------------------------------------------------------

/**
 * @param {{name?:string, website?:string, instagram?:string, folder?:string, captions?:string, bio?:string, fetchImpl?:Function}} input
 * @returns {Promise<{draft:object, found:string[], problems:string[], hashtags:string[], palette:string[]}>}
 */
/** The most folders one scan reads. */
export const MAX_FOLDERS = 8;
/** The most added files one scan reads. */
export const MAX_UPLOADS = 60;

export async function scanBrand(input = {}) {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const found = [], problems = [];
  const palette = new Map();
  let fonts = { display: null, body: null };
  const meta = {};
  const wordSources = [{ text: input.name, weight: 2 }, { text: input.bio, weight: 3 }, { text: input.captions, weight: 1 }];

  // one folder (`folder`) or several (`folders`): each is read in turn and what they hold is put together
  const folderList = [...new Set([...(Array.isArray(input.folders) ? input.folders : []), input.folder].map((f) => String(f ?? '').trim()).filter(Boolean))].slice(0, MAX_FOLDERS);
  const folderFonts = [];
  const guideDocs = [];
  const uploaded = Array.isArray(input.uploads) ? input.uploads.filter((f) => typeof f === 'string' && existsSync(f)).slice(0, MAX_UPLOADS) : [];
  const sources = [...folderList.map((path) => ({ path, one: scanFolder(path) })), ...(uploaded.length ? [{ path: 'the files you added', one: scanFileList(uploaded, { where: 'the files you added' }) }] : [])];
  for (const { path, one } of sources) {
    found.push(...(sources.length > 1 ? one.found.map((t, i) => (i === 0 ? `${path}: ${t}` : t)) : one.found));
    problems.push(...one.problems);
    addPalette(palette, one.palette);
    folderFonts.push(...(one.fileFonts ?? one.fonts));
    guideDocs.push(...(one.docs ?? []));
  }
  if (folderFonts.length) fonts = { display: folderFonts[0], body: folderFonts[1] ?? folderFonts[0] };
  else {   // no font files: take the fonts a written style guide names
    const named = guideDocs.flatMap((d) => [d.fonts.display, d.fonts.body, ...d.fonts.other]).filter(Boolean);
    const display = guideDocs.map((d) => d.fonts.display).find(Boolean) ?? named[0] ?? null;
    const body = guideDocs.map((d) => d.fonts.body).find(Boolean) ?? named.find((f) => f !== display) ?? display;
    if (display || body) fonts = { display, body };
  }
  for (const d of guideDocs) wordSources.push({ text: d.snippet, weight: 1 });
  const guideTone = [...new Set(guideDocs.flatMap((d) => d.tone))].slice(0, 8);
  const guideBanned = [...new Set(guideDocs.flatMap((d) => d.banned))].slice(0, 12);

  if (String(input.website ?? '').trim()) {
    let url = String(input.website).trim();
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    const w = await scanWebsite(url, { fetchImpl });
    found.push(...w.found); problems.push(...w.problems);
    addPalette(palette, w.palette);
    fonts = { display: w.fonts.display ?? fonts.display, body: w.fonts.body ?? fonts.body };
    Object.assign(meta, { site: w.meta });
    wordSources.push(...(w.words ?? []));
  }
  let handle = '';
  if (String(input.instagram ?? '').trim()) {
    const ig = await scanInstagram(input.instagram, { fetchImpl });
    found.push(...ig.found); problems.push(...ig.problems);
    addPalette(palette, ig.palette);
    handle = ig.handle;
    Object.assign(meta, { ig: ig.meta });
  }
  const caps = scanCaptions(input.captions);
  found.push(...caps.found);

  const { colors, notes } = colorsFromPalette(palette);
  problems.push(...notes.filter((n) => palette.size));
  if (!colors && !problems.length) problems.push('No colours could be found: add a folder with the logo, or a website, or set the colours by hand.');
  const name = String(input.name ?? '').trim() || (meta.site?.['og:site_name'] ?? '').trim();
  const bio = String(input.bio ?? '').trim();
  const noteParts = [bio ? `Bio: ${bio}` : '', caps.hashtags.length ? `Usual hashtags: ${caps.hashtags.join(' ')}` : ''].filter(Boolean);
  // what field it is in: the words it uses about itself, counted; the owner can always change or add to this
  const said0 = String(input.industry ?? '').trim();
  const detected = detectIndustry(wordSources);
  if (said0) { /* the owner named it, so detection only supplies the other possibilities */ } else if (detected.best && detected.confidence !== 'low') found.push(`It looks like a ${detected.best.label.toLowerCase()} business (${detected.confidence === 'high' ? 'clearly' : 'probably'}: found "${detected.best.evidence.slice(0, 4).join('", "')}").`);
  else if (!said0 && detected.best) problems.push(`Could not tell what field this is in. The nearest is ${detected.best.label.toLowerCase()} (found "${detected.best.evidence.slice(0, 3).join('", "')}"): choose the field yourself below.`);
  else if (!said0 && wordSources.some((x) => String(x.text ?? '').trim())) problems.push('Could not tell what field this is in from the words found: choose it yourself below.');
  const said = String(input.industry ?? '').trim();
  const industry = said ? cleanIndustry({ label: said }) : detected.best && detected.confidence !== 'low' ? { id: detected.best.id, label: detected.best.label, regulated: detected.best.regulated } : undefined;
  if (said) found.push(`Field: ${industry.label} (as you said).`);
  const draft = {
    ...(name ? { name } : {}),
    ...(industry ? { industry } : {}),
    ...(colors ? { colors } : {}),
    ...((fonts.display || fonts.body) ? { fonts: { ...(fonts.display ? { display: { family: fonts.display, source: folderFonts.includes(fonts.display) ? 'system' : 'google' } } : {}), ...(fonts.body ? { body: { family: fonts.body, source: folderFonts.includes(fonts.body) ? 'system' : 'google' } } : {}) } } : {}),
    voice: { tone: [...guideTone, caps.hints.emojiHeavy ? 'playful, with emoji' : null, caps.hints.exclaims ? 'upbeat' : null].filter(Boolean), bannedPhrases: guideBanned },
    links: { ...(handle ? { handle: `@${handle}` } : {}), ...(String(input.website ?? '').trim() ? { website: /^https?:\/\//i.test(String(input.website).trim()) ? String(input.website).trim() : `https://${String(input.website).trim()}` } : {}) },
    ...(noteParts.length ? { note: noteParts.join('\n') } : {}),
  };
  return { draft, found, problems, industry: detected, hashtags: caps.hashtags, palette: [...palette].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([h]) => h) };
}
