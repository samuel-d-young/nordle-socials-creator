// Draft a brand's style guide from what already exists: a folder of brand files, the website, an Instagram page, a few pasted captions.
// Best effort and honest: every source reports what it found, or why it could not be read (Instagram usually wants a sign-in, so
// pasted captions and the bio are the dependable way in). Nothing is saved here: the result is a DRAFT the person reviews and edits.
// Colours are worked out from the pictures and the CSS themselves, never invented; fonts are only named when the files or the page say so.

import { existsSync, readdirSync, statSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { binary } from '../video/ffmpeg.mjs';

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
  return { colors: { ink: toHex(ink), paper: toHex(paper), accent: toHex(accent), accentDark: toHex(accentDark), muted: toHex(mix(ink, paper, 0.55)) }, notes };
}

/** Dominant colours of picture files, as Map(hex -> weight). Uses ffmpeg (already needed by Nordle); transparent pixels are ignored. */
export function paletteOf(files, { weight = 1 } = {}) {
  const out = new Map();
  for (const file of files) {
    let r;
    try { r = spawnSync(binary('ffmpeg'), ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', 'scale=48:48:flags=area,format=rgba', '-f', 'rawvideo', '-'], { maxBuffer: 48 * 48 * 4 + 1024, windowsHide: true }); } catch { continue; }
    if (r.status !== 0 || !r.stdout?.length) continue;
    const px = r.stdout;
    for (let i = 0; i + 3 < px.length; i += 4) {
      if (px[i + 3] < 128) continue;
      const q = (v) => (v >> 4) * 16 + 8;
      const hex = toHex([q(px[i]), q(px[i + 1]), q(px[i + 2])]);
      out.set(hex, (out.get(hex) ?? 0) + weight);
    }
  }
  return out;
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
  const found = [], problems = [];
  if (!folder) return { found, problems, palette: new Map(), fonts: [] };
  if (!existsSync(folder) || !statSync(folder).isDirectory()) return { found, problems: [`The folder "${folder}" was not found.`], palette: new Map(), fonts: [] };
  const files = [];
  walk(folder, 0, files);
  const images = files.filter((f) => IMG.has(extname(f).toLowerCase()));
  const fontFiles = files.filter((f) => FONT.has(extname(f).toLowerCase()));
  const logos = images.filter((f) => /logo|brand|mark|wordmark|palette|style/i.test(basename(f)));
  const rest = images.filter((f) => !logos.includes(f)).sort((a, b) => statSync(a).size - statSync(b).size).slice(0, 6);   // small files first: graphics before big photos
  const palette = new Map();
  if (logos.length) addPalette(palette, paletteOf(logos.slice(0, 5), { weight: 4 }));
  if (rest.length) addPalette(palette, paletteOf(rest, { weight: 1 }));
  found.push(`Looked through ${files.length} files in the folder: ${images.length} pictures${logos.length ? ` (${logos.length} look like logos)` : ''}, ${fontFiles.length} font files.`);
  if (!images.length) problems.push('There are no pictures in that folder to take colours from.');
  else if (!logos.length) found.push('No file is named like a logo, so colours came from the pictures themselves. A logo gives better colours: name it with "logo" in the file name.');
  const fonts = [...new Set(fontFiles.map(familyOf).filter(Boolean))].slice(0, 4);
  if (fonts.length) found.push(`Fonts in the folder: ${fonts.join(', ')}.`);
  return { found, problems, palette, fonts, logos: logos.slice(0, 3) };
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
  const add = (hex, w) => { const h = toHex(fromHex(hex)); palette.set(h, (palette.get(h) ?? 0) + w); };
  for (const m of css.matchAll(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)) add(`#${m[1]}`, 1);
  for (const m of css.matchAll(/--[a-z0-9-]*(?:primary|brand|accent|main|theme|heading|button)[a-z0-9-]*\s*:\s*(#[0-9a-fA-F]{3,6})\b/gi)) add(m[1], 12);
  const count = { display: new Map(), body: new Map() };
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const fam = /font-family\s*:\s*([^;}]+)/i.exec(m[2]);
    if (!fam) continue;
    const first = fam[1].split(',')[0].trim().replace(/^["']|["']$/g, '').replace(/!important/i, '').trim();
    if (!first || GENERIC.has(first.toLowerCase()) || first.startsWith('var(')) continue;
    const bucket = /\bh[1-3]\b|heading|title|display|hero/i.test(m[1]) ? count.display : count.body;
    bucket.set(first, (bucket.get(first) ?? 0) + 1);
  }
  const top = (m) => [...m].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return { palette, fonts: { display: top(count.display), body: top(count.body) } };
}
const googleFonts = (html) => [...html.matchAll(/fonts\.googleapis\.com\/css2?\?([^"'<>\s]+)/gi)].flatMap((m) => [...m[1].matchAll(/family=([^&:;"']+)/g)].map((f) => decodeURIComponent(f[1].replace(/\+/g, ' '))));

export async function scanWebsite(url, { fetchImpl }) {
  const found = [], problems = [];
  const out = { found, problems, palette: new Map(), fonts: { display: null, body: null }, meta: {} };
  let page;
  try { page = await getText(url, { fetchImpl, max: MAX_HTML }); } catch (e) { problems.push(`The website could not be read (${e.cause?.code ?? e.message}).`); return out; }
  const meta = metaOf(page.text);
  out.meta = meta;
  found.push(`Read ${page.url}${meta['og:site_name'] || meta.title ? `: "${meta['og:site_name'] ?? meta.title}"` : ''}.`);
  let css = [...page.text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
  const links = [...page.text.matchAll(/<link\b[^>]*rel\s*=\s*["']?stylesheet[^>]*>/gi)].map((m) => attr(m[0], 'href')).filter(Boolean).slice(0, 3);
  for (const href of links) {
    try { css += `\n${(await getText(new URL(href, page.url).href, { fetchImpl, max: MAX_CSS })).text}`; } catch { /* a stylesheet that will not load is skipped */ }
  }
  const facts = cssFacts(css);
  addPalette(out.palette, facts.palette);
  if (meta['theme-color'] && /^#[0-9a-f]{3,6}$/i.test(meta['theme-color'])) { out.palette.set(toHex(fromHex(meta['theme-color'])), (out.palette.get(toHex(fromHex(meta['theme-color']))) ?? 0) + 40); found.push(`The site's own theme colour is ${meta['theme-color']}.`); }
  const gf = googleFonts(page.text + css);
  out.fonts = { display: facts.fonts.display ?? gf[0] ?? null, body: facts.fonts.body ?? gf[1] ?? gf[0] ?? null };
  if (out.fonts.display || out.fonts.body) found.push(`Fonts used on the site: ${[...new Set([out.fonts.display, out.fonts.body].filter(Boolean))].join(', ')}.`);
  if (!out.palette.size) problems.push('No colours were found in the site\'s styles.');
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
export async function scanBrand(input = {}) {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const found = [], problems = [];
  const palette = new Map();
  let fonts = { display: null, body: null };
  const meta = {};

  const folder = scanFolder(String(input.folder ?? '').trim());
  found.push(...folder.found); problems.push(...folder.problems);
  addPalette(palette, folder.palette);
  if (folder.fonts.length) fonts = { display: folder.fonts[0], body: folder.fonts[1] ?? folder.fonts[0] };

  if (String(input.website ?? '').trim()) {
    let url = String(input.website).trim();
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    const w = await scanWebsite(url, { fetchImpl });
    found.push(...w.found); problems.push(...w.problems);
    addPalette(palette, w.palette);
    fonts = { display: w.fonts.display ?? fonts.display, body: w.fonts.body ?? fonts.body };
    Object.assign(meta, { site: w.meta });
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
  const draft = {
    ...(name ? { name } : {}),
    ...(colors ? { colors } : {}),
    ...((fonts.display || fonts.body) ? { fonts: { ...(fonts.display ? { display: { family: fonts.display, source: folder.fonts.includes(fonts.display) ? 'system' : 'google' } } : {}), ...(fonts.body ? { body: { family: fonts.body, source: folder.fonts.includes(fonts.body) ? 'system' : 'google' } } : {}) } } : {}),
    voice: { tone: [caps.hints.emojiHeavy ? 'playful, with emoji' : null, caps.hints.exclaims ? 'upbeat' : null].filter(Boolean), bannedPhrases: [] },
    links: { ...(handle ? { handle: `@${handle}` } : {}), ...(String(input.website ?? '').trim() ? { website: /^https?:\/\//i.test(String(input.website).trim()) ? String(input.website).trim() : `https://${String(input.website).trim()}` } : {}) },
    ...(noteParts.length ? { note: noteParts.join('\n') } : {}),
  };
  return { draft, found, problems, hashtags: caps.hashtags, palette: [...palette].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([h]) => h) };
}
