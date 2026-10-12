// Layout patterns: proven page designs that take your words (and an image) and a brand, and give back a finished page.
// Text sits in a stack, so it flows and can never collide; sizes, margins and colours are chosen from the brand and the
// platform's safe zones, and a picture is fitted into the room the words leave. Claude starts from a pattern and then
// refines. Pure: runs in Node and in the browser.

import { resolveToken } from './tokens.mjs';
import { postStyle, fontToken, showsOn } from './brand-style.mjs';

// ---- colour ----------------------------------------------------------------------------------------------------------

const rgb = (hex) => {
  const h = String(hex).replace('#', '');
  const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6);
  return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16));
};
const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const luminance = (hex) => { const [r, g, b] = rgb(hex); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); };
export const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const saturation = (hex) => { const [r, g, b] = rgb(hex).map((v) => v / 255); const mx = Math.max(r, g, b), mn = Math.min(r, g, b); return mx === 0 ? 0 : (mx - mn) / mx; };

/** Which of the brand's colours plays which part. Uses the usual names when present, otherwise brightness and saturation. */
export function brandRoles(brand, colourway) {
  const names = Object.keys(brand.colors);
  const val = (n) => resolveToken(`$brand.colors.${n}`, brand, colourway);
  const tok = (n) => `$brand.colors.${n}`;
  const find = (...c) => c.find((n) => names.includes(n));
  const byLum = [...names].sort((a, b) => luminance(val(a)) - luminance(val(b)));
  const ink = find('ink', 'text', 'dark', 'black') ?? byLum[0];
  const paper = find('paper', 'background', 'bg', 'light', 'cream', 'white') ?? byLum.at(-1);
  const rest = names.filter((n) => n !== ink && n !== paper);
  const accent = find('accent', 'highlight', 'brand', 'primary') ?? [...rest].sort((a, b) => saturation(val(b)) - saturation(val(a)))[0] ?? ink;
  const accentLike = [accent, find('accentDark', 'accent2', 'secondary'), ...rest].filter((n, i, a) => n && a.indexOf(n) === i);
  const accentOnPaper = accentLike.find((n) => contrast(val(n), val(paper)) >= 4.5) ?? ink;
  const accentOnInk = accentLike.find((n) => contrast(val(n), val(ink)) >= 3) ?? paper;
  const accentOnInkSmall = accentLike.find((n) => contrast(val(n), val(ink)) >= 4.5) ?? paper;
  const muted = find('muted', 'grey', 'gray', 'subtle') ?? rest.find((n) => contrast(val(n), val(paper)) >= 4.5 && contrast(val(n), val(paper)) <= 8) ?? ink;
  const alt = rest.find((n) => n !== accent && ![find('accentDark', 'accent2'), muted].includes(n) && contrast(val(n), val(paper)) >= 2.5);
  return { names, val, tok, ink, paper, accent, accentLike, accentOnPaper, accentOnInk, accentOnInkSmall, muted, alt };
}

/** Text and background colours for a tone, each text colour checked against its background. `accentSmall` is safe for small text. */
export function toneColours(r, tone) {
  const best = (bg) => (contrast(r.val(r.ink), r.val(bg)) >= contrast(r.val(r.paper), r.val(bg)) ? r.ink : r.paper);
  const readable = (bg, ...prefer) => prefer.find((n) => contrast(r.val(n), r.val(bg)) >= 4.5) ?? best(bg);
  let bg = r.paper, text = r.ink, sub = r.muted, accent = r.accentOnPaper, accentSmall = r.accentOnPaper;
  if (tone === 'dark') { bg = r.ink; text = r.paper; sub = r.paper; accent = r.accentOnInk; accentSmall = r.accentOnInkSmall; }
  else if (tone === 'accent') {
    // the pure accent colour if plain text is readable on it, otherwise the next accent-like colour that can carry text
    bg = r.accentLike.find((n) => contrast(r.val(best(n)), r.val(n)) >= 4.5) ?? r.accent;
    text = best(bg); sub = text; accent = text; accentSmall = text;
  } else if (tone === 'alt' && r.alt) { bg = r.alt; text = readable(r.alt, r.paper, r.ink); sub = text; accent = text; accentSmall = text; }
  else if (contrast(r.val(sub), r.val(bg)) < 4.5) sub = r.ink;
  if (contrast(r.val(accent), r.val(bg)) < 3) accent = text;
  if (contrast(r.val(accentSmall), r.val(bg)) < 4.5) accentSmall = text;
  return { bg: r.tok(bg), text: r.tok(text), sub: r.tok(sub), accent: r.tok(accent), accentSmall: r.tok(accentSmall), subDimmed: sub === text, paper: r.tok(r.paper), ink: r.tok(r.ink) };
}

// ---- building blocks ---------------------------------------------------------------------------------------------------

const FALLBACK_SAFE = { top: 0.04, right: 0.06, bottom: 0.04, left: 0.06 };
const safeOf = (size) => ({ ...FALLBACK_SAFE, ...(size.safe ?? {}) });
const pct = (n) => Math.round(n * 100) / 100;
const topY = (size) => pct(Math.max(7, safeOf(size).top * 100 + 3.5));
const bottomY = (size) => pct(100 - Math.max(6, safeOf(size).bottom * 100 + 3));
const sideX = (size) => pct(Math.max(8, safeOf(size).left * 100 + 2));

const fonts = (brand) => {
  const keys = Object.keys(brand.fonts);
  const st = postStyle(brand);
  const display = `$brand.fonts.${keys.includes('display') ? 'display' : keys[0]}`;
  const body = `$brand.fonts.${keys.includes('body') ? 'body' : keys.at(-1)}`;
  return {
    display, body, st,
    script: keys.includes('script') ? '$brand.fonts.script' : null,
    // fonts chosen by the brand's post style (headline, kicker and body can each use a different one)
    headlineFont: fontToken(brand, st.headline.font, 'display'),
    kickerFont: fontToken(brand, st.kicker.font, 'body'),
    bodyFont: fontToken(brand, st.body.font, 'body'),
  };
};

function headlinePx(text, base = 150) {
  const n = String(text).length;
  return n <= 14 ? base : n <= 24 ? Math.round(base * 0.88) : n <= 40 ? Math.round(base * 0.75) : n <= 64 ? Math.round(base * 0.6) : Math.round(base * 0.5);
}

/** How many lines a piece of text will take, roughly (the real renderer decides; this keeps pictures out of the way). */
function estimateLines(value, px, widthPx, kind = 'body') {
  const perLine = Math.max(1, Math.floor(widthPx / (px * (kind === 'display' ? 0.58 : 0.52))));
  return String(value).split('\n').reduce((n, part) => n + Math.max(1, Math.ceil(part.length / perLine)), 0);
}
const estimateHeight = (parts, gap, widthPx) => parts.reduce((h, p) => h + estimateLines(p.text, p.px, widthPx, p.kind) * p.px * p.lh, 0) + gap * Math.max(0, parts.length - 1);

/** Script lettering cannot carry capitals that run together (an acronym like AHPRA turns into a scrawl). */
const scriptSafe = (str) => !/[A-Z]{2,}/.test(String(str ?? ''));

/** The headline as text runs, with one phrase in italics and the accent colour (default: the last word or two). */
function headlineRuns(text, accent, emphasis, tc, f, px) {
  const t = String(text);
  const mode = f?.st?.headline?.accent ?? 'italic-colour';
  if (emphasis === 'none' || mode === 'none') return null;
  let target = accent;
  if (!target) {
    const words = t.trim().split(/\s+/);
    if (words.length < 3) return null;
    target = words.slice(words.length > 5 ? -2 : -1).join(' ');
  }
  const i = t.toLowerCase().lastIndexOf(String(target).toLowerCase());
  if (i < 0) return null;
  const parts = [];
  if (i > 0) parts.push({ text: t.slice(0, i) });
  const h = f?.st?.headline;
  const accentStyle = mode === 'italic' ? { italic: true }
    : mode === 'colour' ? { color: tc.accent }
      : mode === 'script' && f?.script && scriptSafe(target) ? { font: f.script, weight: 400, size: Math.round((px ?? 100) * (h?.accentScale ?? 1.2)), color: tc.accent }
        : { italic: true, color: tc.accent };
  parts.push({ text: t.slice(i, i + target.length), style: accentStyle });
  if (i + target.length < t.length) parts.push({ text: t.slice(i + target.length) });
  return parts;
}

const text = (id, value, style, layout = {}) => {
  const layer = { id, type: 'text', style, layout };
  if (Array.isArray(value)) layer.runs = value; else layer.text = value;
  return layer;
};
const stack = (id, layout, children, { gap = 28, align = 'stretch' } = {}) => ({ id, type: 'group', layout, stack: { gap, align }, children });

function kicker(content, f, tc, align) {
  if (!content.kicker) return null;
  const k = f.st.kicker;
  const a = align ? { align } : {};
  const kc = k.color ? { paper: tc.paper, ink: tc.ink, accent: tc.accent, text: tc.text, sub: tc.sub }[k.color] ?? tc.accentSmall : tc.accentSmall;
  if (k.style === 'script' && f.script && scriptSafe(content.kicker)) return text('kicker', String(content.kicker), { font: f.script, size: k.scriptSize, weight: 400, lineHeight: 1.05, color: k.color ? kc : tc.accent, ...a });
  return text('kicker', k.case === 'upper' ? String(content.kicker).toUpperCase() : String(content.kicker), { font: f.kickerFont, size: k.size, weight: k.weight, letterSpacing: k.tracking, color: kc, ...a });
}
/** The headline size a brand asks for by role (cover / page / end) replaces the pattern's own base size. */
const baseFor = (f, role, base) => f.st.headline.sizes?.[role] ?? base;
function headline(content, f, tc, { base = 150, align, lh = 1.02, role = 'page' } = {}) {
  const h = f.st.headline;
  const px = Math.round((content.headlineSize ?? headlinePx(content.headline, baseFor(f, content.role ?? role, base))) * h.sizeScale);
  const runs = headlineRuns(content.headline, content.accent, content.emphasis, tc, f, px);
  const style = { font: f.headlineFont, size: px, weight: h.weight, lineHeight: h.lineHeight ?? lh, color: tc.text, balance: true, ...(h.case === 'upper' ? { uppercase: true } : {}), ...(h.tracking ? { letterSpacing: h.tracking } : {}), ...(h.shadow ? { shadow: h.shadow } : {}), ...(align ? { align } : {}) };
  return text('headline', runs ?? String(content.headline), style);
}
function body(content, f, tc, { id = 'body', size = 42, align } = {}) {
  const b = f.st.body;
  return content.body ? text(id, String(content.body), { font: f.bodyFont, size: Math.round(size * b.sizeScale), weight: b.weight, lineHeight: 1.32, color: tc.sub, balance: true, ...(tc.subDimmed ? { opacity: 0.9 } : {}), ...(align ? { align } : {}) }) : null;
}
const imageLayer = (content, id, layout, extra = {}) => ({ id, type: 'image', src: content.image, alt: content.imageAlt ?? '', fit: 'contain', layout, ...extra });
const small = (id, value, f, tc, layout, o = {}) => text(id, value, { font: f.body, size: 30, weight: 600, letterSpacing: 0.08, color: o.color ?? tc.text, ...(o.align ? { align: o.align } : {}) }, layout);

/** A full-bleed photo with the brand's fade across its lower part. Used by the full-picture and person patterns. */
function photoBackdrop(content, f, roles) {
  const fd = f.st.photo.fade;
  const fadeHex = fd?.colour ? (roles.names.includes(fd.colour) ? roles.val(fd.colour) : fd.colour) : roles.val(roles.ink);
  const alpha = Math.round(255 * (fd?.strength ?? 1)).toString(16).padStart(2, '0');
  const fadeColour = fd?.strength && fd.strength < 1 ? `${String(fadeHex).slice(0, 7)}${alpha}` : (fd?.colour && roles.names.includes(fd.colour) ? roles.tok(fd.colour) : fd?.colour ?? roles.tok(roles.ink));
  return [
    { id: 'photo', type: 'image', src: content.image, alt: content.imageAlt ?? '', fit: 'cover', ...(content.focal ? { focal: content.focal } : {}), layout: { anchor: 'top-left', x: 0, y: 0, w: 100, h: 100 } },
    { id: 'fade', type: 'shape', shape: 'rect', layout: { anchor: 'bottom-left', x: 0, y: 100, w: 100, h: fd?.height ?? 72 }, style: { fill: { type: 'linear', angle: 180, stops: [{ at: 0, color: 'transparent' }, { at: fd?.from ?? 0.5, color: fadeColour }, { at: 1, color: fadeColour }] } } },
  ];
}

// ---- the closing card ------------------------------------------------------------------------------------------------------
// A clean card that sits over a real picture: the logo, a short headline and how to book. It replaces a screen of flat colour with a
// thin outlined "button" (which cannot be pressed on a picture and reads as generated). Used for the last page of a carousel (pattern
// "closing-card") and over the end of a reel (reel-spec `endPanel`). Sizes are px on the 1080-wide reference.

/** How tall the card is (px on the 1080 reference): the small print needs another two lines. */
export const closingCardHeight = (c = {}) => (c.disclaimer ? 665 : 590);

/**
 * @param {{id:string, size:{w:number,h:number}, brand:object, tc:object, f:object, roles:object, content:object, top:number}} o
 *   content: { logo (path), kicker, headline, label (false = none), url, phoneLine, disclaimer }; top: px from the top of the page to the card.
 * @returns {{panel:object, parts:object[]}} layers in percent of the page; the caller adds timing when it is a video.
 */
export function closingCard({ id, size, brand, tc, f, roles, content: c, top: T }) {
  const refH = (size.h * 1080) / size.w;
  const y = (px) => pct((px / refH) * 100);
  const x = (px) => pct((px / 1080) * 100);
  const H = closingCardHeight(c);
  const bg = roles.names.includes('white') ? roles.tok('white') : tc.bg;
  const X0 = 46, L = 86, W = 908;                       // the card, then the text inside it (the same left margin the brand's pages use)
  // the headline takes the largest size that fits on two lines across the card; the lines below stay clearly smaller
  const headLen = String(c.headline ?? '').length;
  const headSize = [88, 72, 64, 56, 48, 44, 40].find((sz) => (sz < 88 || headLen <= 16) && Math.ceil((headLen * sz * 0.58) / W) <= 2) ?? 40;   // a very short line (a phone number) may go big
  const lineSize = Math.max(26, Math.min(40, Math.floor(headSize / 1.9)));
  const t = (name, txt, top, o) => text(`${id}-${name}`, txt, { font: o.font ?? f.display, size: o.size, weight: o.weight, color: o.color, lineHeight: o.lh ?? 1.2, letterSpacing: o.ls ?? 0, align: 'left', ...(o.balance ? { balance: true } : {}), ...(o.upper ? { uppercase: true } : {}) }, { anchor: 'top-left', x: x(o.x ?? L), y: y(top), w: x(o.w ?? W) });
  const parts = [
    // the logo sits in a fixed box (any shape of logo is fitted inside it, so it never runs into the lines below)
    c.logo ? { id: `${id}-logo`, type: 'image', src: c.logo, alt: c.logoAlt ?? `${brand.name ?? 'Brand'} logo`, fit: 'contain', layout: { anchor: 'top-left', x: x(L), y: y(T + 40), w: x(210), h: y(136) } } : null,
    c.kicker ? t('kicker', String(c.kicker), T + 92, { x: L + 210 + 40, w: W - 250, size: 24, weight: 700, color: tc.accentSmall, ls: String(c.kicker).length > 24 ? 0.02 : 0.08, upper: true }) : null,
    c.headline ? t('headline', String(c.headline), T + 198, { size: headSize, weight: 600, color: tc.text, lh: 1.1, balance: true }) : null,
    { id: `${id}-rule`, type: 'shape', shape: 'rect', layout: { anchor: 'top-left', x: x(L), y: y(T + 392), w: x(W), h: y(2) }, style: { fill: tc.accent } },
    c.label !== false ? t('label', String(c.label ?? 'Book online'), T + 418, { size: 24, weight: 700, color: tc.accentSmall, ls: 0.22, upper: true }) : null,
    c.url ? t('url', String(c.url), T + 452, { size: lineSize, weight: 600, color: tc.text }) : null,
    c.phoneLine ? t('phone', String(c.phoneLine), T + 452 + Math.round(lineSize * 1.45), { size: Math.max(24, lineSize - 4), weight: 500, color: tc.sub }) : null,
    c.disclaimer ? t('disclaimer', String(c.disclaimer), T + 568, { size: 24, weight: 500, color: tc.sub, lh: 1.35 }) : null,
  ].filter(Boolean);
  const panel = { id: `${id}-panel`, type: 'shape', shape: 'rect', layout: { anchor: 'top-left', x: x(X0), y: y(T), w: x(1080 - 2 * X0), h: y(H) }, style: { fill: bg, radius: 40, shadow: { color: '#00000055', blur: 48, y: 12 } } };
  return { panel, parts };
}

// ---- the patterns --------------------------------------------------------------------------------------------------------

/** @type {Record<string, {name:string, description:string, bestFor:string, tone:string, slots:Record<string,string>, example:object, build:Function}>} */
export const PATTERNS = {
  cover: {
    name: 'Cover',
    description: 'The first page of a carousel, or a single bold post: a small label, a big headline with one accent phrase, a supporting line, and optionally a picture and a "swipe" cue.',
    bestFor: 'Opening a carousel; announcements; a single hero graphic.',
    tone: 'light',
    slots: { kicker: 'small label above the headline', headline: 'required', accent: 'phrase in the headline to put in italics and the accent colour (default: its last word)', body: 'one supporting line', image: 'project path of a picture or illustration (fitted into the room the words leave, bottom right)', imageAlt: 'alt text for the image', hint: 'small cue at the bottom, e.g. "Swipe" (carousels only)' },
    example: { kicker: 'New this season', headline: 'Spring menu is here', body: 'Three new pours. Open from 7 am.', image: 'assets/hero-cup.svg', imageAlt: 'A steaming cup of coffee', hint: 'Swipe' },
    build({ content, f, tc, size, notes }) {
      const x = sideX(size), hasImage = !!content.image, widthPx = ((100 - 2 * x) / 100) * size.w;
      const hpx = content.headlineSize ?? headlinePx(content.headline, baseFor(f, content.role ?? 'cover', hasImage ? 144 : 168));
      const kids = [kicker(content, f, tc), headline({ ...content, headlineSize: hpx }, f, tc, { role: 'cover' }), body(content, f, tc, { size: 42 })].filter(Boolean);
      const layers = [stack('text-block', hasImage ? { anchor: 'top-left', x, y: topY(size), w: 100 - 2 * x } : { anchor: 'left', x, y: 50, w: 100 - 2 * x }, kids, { gap: 30 })];
      if (hasImage) {
        const parts = [content.kicker && { text: content.kicker, px: 28, lh: 1.2 }, { text: content.headline, px: hpx, lh: 1.02, kind: 'display' }, content.body && { text: content.body, px: 42, lh: 1.32 }].filter(Boolean);
        const free = size.h - (topY(size) / 100) * size.h - estimateHeight(parts, 30, widthPx) - 70 - (content.hint ? 0.1 : 0.03) * size.h;
        const side = Math.min(free, 0.72 * size.w);
        if (side < 0.22 * size.w) notes.push(`There is no room for the picture on a ${size.w}x${size.h} page with this much text, so it is left out at ${size.id}. Shorten the words or leave the picture out.`);
        else layers.push(imageLayer(content, 'image', { anchor: 'bottom-right', x: 104, y: 100, w: pct((side / size.w) * 100), h: content.imageFit === 'cover' ? pct((side / size.h) * 100) : 'auto' }, content.imageFit === 'cover' ? { fit: 'cover', ...(content.focal ? { focal: content.focal } : {}) } : {}));
      }
      if (content.hint) layers.push(small('hint', content.hint, f, tc, { anchor: 'bottom-left', x, y: bottomY(size) }));
      return layers;
    },
  },

  statement: {
    name: 'Big statement',
    description: 'One sentence, set large and centred, with an optional small label and sign-off.',
    bestFor: 'A promise, a principle, a one-line announcement, a strong middle page.',
    tone: 'dark',
    slots: { kicker: 'small label above', headline: 'required: the statement', accent: 'phrase to emphasise', footer: 'small line at the bottom, e.g. a handle' },
    example: { kicker: 'Our promise', headline: 'Every cup is made to order', footer: '@littlegannet' },
    build({ content, f, tc, size }) {
      const x = sideX(size);
      const kids = [kicker(content, f, tc, 'center'), headline(content, f, tc, { base: 150, align: 'center' })].filter(Boolean);
      const layers = [stack('text-block', { anchor: 'center', x: 50, y: 50, w: 100 - 2 * x }, kids, { gap: 36 })];
      if (content.footer) layers.push(small('footer', content.footer, f, tc, { anchor: 'bottom', x: 50, y: bottomY(size), w: 84 }, { align: 'center', color: tc.accentSmall }));
      return layers;
    },
  },

  list: {
    name: 'List',
    description: 'A title and up to four short items, each with a bold name and one line of detail.',
    bestFor: 'Tips, steps, a menu, "three things to know".',
    tone: 'light',
    slots: { kicker: 'small label', headline: 'required: the title', accent: 'phrase to emphasise', items: 'list of {title, text}, up to 4' },
    example: { kicker: 'Good to know', headline: 'Three ways to enjoy it', items: [{ title: 'Hot', text: 'Served in our own ceramic cups.' }, { title: 'Iced', text: 'Over a big, slow-melting cube.' }, { title: 'To go', text: 'Bring your own and we will take 50c off.' }] },
    build({ content, f, tc, size, notes }) {
      const x = sideX(size), widthPx = ((100 - 2 * x) / 100) * size.w;
      const items = (content.items ?? []).slice(0, 4);
      const n = items.length;
      const sizes = (k) => ({ h: Math.round(headlinePx(content.headline, 124) * k), t: Math.round((n > 3 ? 52 : 56) * k), d: Math.round((n > 3 ? 34 : 38) * k), gap: Math.round((n > 3 ? 36 : 48) * k) });
      const est = (k) => {
        const z = sizes(k);
        let h = estimateLines(content.headline, z.h, widthPx, 'display') * z.h * 1.02 + (content.kicker ? 28 * 1.2 + 52 : 0) + 52;
        for (const it of items) h += z.t * 1.2 + (it.text ? 8 + estimateLines(it.text, z.d, widthPx) * z.d * 1.3 : 0);
        return h + Math.max(0, n - 1) * z.gap;
      };
      const room = ((bottomY(size) - topY(size)) / 100) * size.h;
      let k = 1;
      while (k > 0.7 && est(k) > room) k = Math.round((k - 0.05) * 100) / 100;
      if (est(k) > room) notes.push(`This much text is tight on a ${size.w}x${size.h} page (${size.id}). Shorten the items or use fewer.`);
      const z = sizes(k);
      const centreList = f.st.list.align === 'center';
      const kids = [kicker(content, f, tc, centreList ? 'center' : undefined), headline({ ...content, headlineSize: z.h }, f, tc, centreList ? { align: 'center' } : {})].filter(Boolean);
      const rows = items.map((it, i) => stack(`item-${i + 1}`, {}, [
        text(`item-${i + 1}-title`, f.st.list.numbered === false ? String(it.title) : `${String(i + 1).padStart(2, '0')}  ${it.title}`, { font: f.display, size: z.t, weight: 700, color: tc.accent, ...(f.st.list.align === 'center' ? { align: 'center' } : {}) }),
        ...(it.text ? [text(`item-${i + 1}-text`, String(it.text), { font: f.body, size: z.d, weight: 400, lineHeight: 1.3, color: tc.sub, balance: true, ...(f.st.list.align === 'center' ? { align: 'center' } : {}) })] : []),
      ], { gap: 8 }));
      return [stack('text-block', { anchor: 'top-left', x, y: topY(size), w: 100 - 2 * x }, [...kids, stack('items', {}, rows, { gap: z.gap })], { gap: Math.round(52 * k) })];
    },
  },

  item: {
    name: 'Feature or menu item',
    description: 'A number, a name, a short description and a price or label at the bottom, with a picture or illustration bottom right.',
    bestFor: 'One product, dish, service or feature per page in a carousel.',
    tone: 'dark',
    slots: { number: 'e.g. "01"', headline: 'required: the name', accent: 'phrase to emphasise', body: 'description', label: 'price or short label at the bottom left', image: 'picture or illustration (fitted into the room the words leave)', imageAlt: 'alt text' },
    example: { number: '01', headline: 'Honey lavender latte', body: 'House-made honey syrup and a pinch of dried lavender. Oat or dairy.', label: '6.50', image: 'assets/beans.svg' },
    build({ content, f, tc, size, notes }) {
      const x = sideX(size), widthPx = ((100 - 2 * x) / 100) * size.w;
      const hpx = content.headlineSize ?? headlinePx(content.headline, 132);
      const kids = [content.number ? text('number', String(content.number), { font: f.display, size: 56, weight: 600, color: tc.accent }) : null,
        headline({ ...content, headlineSize: hpx }, f, tc, { lh: 1.04 }), body(content, f, tc, { size: 40 })].filter(Boolean);
      const layers = [stack('text-block', { anchor: 'top-left', x, y: topY(size), w: 100 - 2 * x }, kids, { gap: 34 })];
      if (content.image) {
        const parts = [content.number && { text: content.number, px: 56, lh: 1.2 }, { text: content.headline, px: hpx, lh: 1.04, kind: 'display' }, content.body && { text: content.body, px: 40, lh: 1.32 }].filter(Boolean);
        const free = size.h - (topY(size) / 100) * size.h - estimateHeight(parts, 34, widthPx) - 60;
        const side = Math.min(free, 0.74 * size.w);
        if (side < 0.2 * size.w) notes.push(`There is no room for the picture at ${size.id} with this much text, so it is left out there.`);
        else layers.unshift(imageLayer(content, 'image', { anchor: 'bottom-right', x: 108, y: 104, w: pct((side / size.w) * 100), h: 'auto' }));
      }
      if (content.label) layers.push(text('label', String(content.label), { font: f.display, size: 56, weight: 600, color: tc.accent }, { anchor: 'bottom-left', x, y: bottomY(size) }));
      return layers;
    },
  },

  stat: {
    name: 'Big number',
    description: 'One very large figure with a label and a sentence of context. Use only figures you were given.',
    bestFor: 'A milestone, a date, a price, an opening time.',
    tone: 'accent',
    slots: { kicker: 'small label', number: 'required: the figure, e.g. "7 am"', headline: 'what the figure is, e.g. "Doors open"', body: 'context' },
    example: { kicker: 'Every day', number: '7 am', headline: 'Doors open', body: 'Pastries are out of the oven by quarter past.' },
    build({ content, f, tc, size }) {
      const x = sideX(size);
      const figure = String(content.number ?? content.headline);
      const kids = [kicker(content, f, tc), text('number', figure, { font: f.display, size: figure.length <= 4 ? 300 : figure.length <= 8 ? 220 : 150, weight: 700, lineHeight: 0.95, color: tc.text }),
        content.number && content.headline ? text('headline', String(content.headline), { font: f.display, size: 84, weight: 700, color: tc.text, balance: true }) : null, body(content, f, tc, { size: 42 })].filter(Boolean);
      return [stack('text-block', { anchor: 'left', x, y: 50, w: 100 - 2 * x }, kids, { gap: 30 })];
    },
  },

  quote: {
    name: 'Quote',
    description: 'A large quotation with a source line. Only use words someone actually said, with their permission. (Regulated industries: do not use client testimonials.)',
    bestFor: 'A quote from the owner, a team member, a review you are allowed to share.',
    tone: 'alt',
    slots: { headline: 'required: the quote, without quotation marks', body: 'who said it, e.g. "Maya, head roaster"' },
    example: { headline: 'We roast in small batches so every cup tastes the way it should.', body: 'Maya, head roaster' },
    build({ content, f, tc, size }) {
      const x = sideX(size);
      const kids = [text('mark', '“', { font: f.display, size: 260, weight: 700, lineHeight: 0.7, color: tc.accent }),
        text('headline', String(content.headline), { font: f.display, size: headlinePx(content.headline, 104), weight: 600, lineHeight: 1.12, color: tc.text, balance: true }),
        content.body ? text('source', String(content.body), { font: f.body, size: 36, weight: 600, letterSpacing: 0.06, color: tc.sub }) : null].filter(Boolean);
      return [stack('text-block', { anchor: 'left', x, y: 50, w: 100 - 2 * x }, kids, { gap: 34 })];
    },
  },

  'image-hero': {
    name: 'Full picture',
    description: 'A full-page photo with a soft dark fade at the bottom and the headline over it.',
    bestFor: 'When you have one strong photo.',
    tone: 'dark',
    slots: { image: 'required: a photo (project path)', imageAlt: 'alt text', kicker: 'small label', headline: 'required', accent: 'phrase to emphasise', body: 'one supporting line' },
    example: { image: 'assets/photo.jpg', imageAlt: 'The shop front at dawn', kicker: 'Port Wren', headline: 'Open at first light', body: 'Quay Street, from 7 am.' },
    build({ content, f, tc, size, roles }) {
      const x = sideX(size);
      const kids = [kicker(content, f, tc), headline(content, f, tc, { base: 132, role: content.role ?? 'page' }), body(content, f, tc, { size: 40 })].filter(Boolean);
      return [
        ...photoBackdrop(content, f, roles),
        stack('text-block', { anchor: 'bottom-left', x, y: bottomY(size), w: 100 - 2 * x }, kids, { gap: 26 }),
      ];
    },
  },

  'closing-card': {
    name: 'Closing card on a picture',
    description: 'The last page: a real photo with a clean card over it holding the logo, a short headline and how to book. Use this instead of a flat-colour end page.',
    bestFor: 'The final page of a carousel for a brand that wants a human, photographic ending.',
    tone: 'light',
    slots: { image: 'required: a photo', imageAlt: 'alt text', focal: 'where the subject is', kicker: 'small label (one line)', headline: 'required: the action', url: 'the web address', phone: 'the phone number (shown as "or call ...")', label: 'the small line above the address (default "Book online", false for none)', position: '"top" puts the card at the top, for a picture whose subject is low', disclaimer: 'small print', logo: 'logo path (default: the brand logo)' },
    example: { image: 'assets/photo.jpg', imageAlt: 'The team at the front desk', kicker: 'Questions?', headline: 'Come and say hello', url: 'example.com/book', phone: '0400 000 000' },
    build({ content, f, tc, size, roles }) {
      const H = closingCardHeight({ disclaimer: content.disclaimer });
      const refH = (size.h * 1080) / size.w;
      const top = content.position === 'top' ? Math.round(refH * Math.max(0.06, (size.safe?.top ?? 0) + 0.02))   // a picture whose subject is low: the card goes at the top
        : Math.round(refH * Math.min(0.94, 1 - (size.safe?.bottom ?? 0) - 0.02) - H);                            // otherwise it sits low and clear of what the platform covers; the picture shows above it
      const { panel, parts } = closingCard({
        id: 'cc', size, brand: content.__brand, tc, f, roles, top,
        content: { logo: content.logo, logoAlt: content.logoAlt, kicker: content.kicker, headline: content.headline, label: content.label, url: content.url, phoneLine: content.phoneLine ?? (content.phone ? `or call ${content.phone}` : null), disclaimer: content.disclaimer },
      });
      return [
        { id: 'photo', type: 'image', src: content.image, alt: content.imageAlt ?? '', fit: 'cover', ...(content.focal ? { focal: content.focal } : {}), layout: { anchor: 'top-left', x: 0, y: 0, w: 100, h: 100 } },
        panel, ...parts,
      ];
    },
  },

  split: {
    name: 'Picture and words',
    description: 'A picture across the top half and the words below.',
    bestFor: 'A photo with a proper explanation; before-you-visit information.',
    tone: 'light',
    slots: { image: 'required: a photo', imageAlt: 'alt text', kicker: 'small label', headline: 'required', accent: 'phrase to emphasise', body: 'supporting text' },
    example: { image: 'assets/photo.jpg', imageAlt: 'Beans being poured into the roaster', kicker: 'Behind the scenes', headline: 'Roasted every morning', body: 'Small batches, so what you drink was roasted this week.' },
    build({ content, f, tc, size }) {
      const x = sideX(size);
      const kids = [kicker(content, f, tc), headline(content, f, tc, { base: 100 }), body(content, f, tc, { size: 38 })].filter(Boolean);
      return [
        { id: 'photo', type: 'image', src: content.image, alt: content.imageAlt ?? '', fit: 'cover', layout: { anchor: 'top-left', x: 0, y: 0, w: 100, h: 50 } },
        stack('text-block', { anchor: 'top-left', x, y: 56, w: 100 - 2 * x }, kids, { gap: 24 }),
      ];
    },
  },

  person: {
    name: 'Person',
    description: 'A team member on a full-bleed photo: their name large, a short rule, their role in small capitals, and an optional line, over the brand fade.',
    bestFor: 'Meet the team, introductions, "who answers the phone".',
    tone: 'dark',
    slots: { image: 'required: a photo of them (project path)', imageAlt: 'alt text', focal: '{x,y} where their face is, 0-1, so crops and the logo keep clear of it', name: 'required: their name as it should read', role: 'their title, taken from the practice site', kicker: 'series label, e.g. "Meet the team"', body: 'one line' },
    example: { image: 'assets/photo.jpg', imageAlt: 'Maya at the roaster', kicker: 'Meet the team', name: 'Maya', role: 'Head roaster', body: 'Roasts every batch by hand.' },
    build({ content, f, tc, size, roles }) {
      const x = sideX(size), ps = f.st.person;
      const name = String(content.name ?? content.headline);
      const nameRuns = headline({ ...content, headline: name, emphasis: 'none', headlineSize: ps.nameSize }, f, tc, { role: 'page' });
      nameRuns.id = 'name';
      const kids = [
        kicker(content, f, tc),
        nameRuns,
        ps.rule ? { id: 'rule', type: 'shape', shape: 'rect', layout: { w: 14, h: 0.35 }, style: { fill: tc.accent } } : null,
        content.role ? text('role', ps.roleCase === 'upper' ? String(content.role).toUpperCase() : String(content.role), { font: f.kickerFont, size: 30, weight: 500, letterSpacing: 0.2, color: tc.text }) : null,
        body(content, f, tc, { size: 38 }),
      ].filter(Boolean);
      return [...photoBackdrop(content, f, roles), stack('text-block', { anchor: 'bottom-left', x, y: bottomY(size), w: 100 - 2 * x }, kids, { gap: 22 })];
    },
  },

  cta: {
    name: 'Closing call to action',
    description: 'The last page: what to do next, with the details and the handle, centred. Can carry a lead line, a large phone number, an underlined web address and a small disclaimer at the foot.',
    bestFor: 'The final page of a carousel, an enquiry or booking post.',
    tone: 'light',
    slots: { lead: 'a short line above the headline (set in italics when the brand does)', headline: 'required: the action, e.g. "Come say hi"', accent: 'phrase to emphasise', phone: 'the phone number, set large', body: 'details, one per line', url: 'web address (underlined when the brand does)', footer: 'handle or website, small at the bottom', disclaimer: 'small print at the very bottom (e.g. required risk wording)', logo: 'a project path to a logo image (default: none)' },
    example: { headline: 'Come say hi', body: 'Quay Street, Port Wren\nOpen 7 am to 3 pm, every day', footer: '@littlegannet', logo: 'assets/logo.svg' },
    build({ content, f, tc, size }) {
      const x = sideX(size), end = f.st.end;
      // with a big phone number, the phone is the hero: the lines around it step down so the hierarchy is clear
      const sub = content.phone ? Math.round(end.phoneSize / 1.95) : 54;
      const lead = content.lead ? text('lead', String(content.lead), { font: f.headlineFont, size: sub, weight: 400, lineHeight: 1.2, color: tc.text, align: 'center', balance: true, ...(end.leadStyle === 'italic' ? { italic: true } : {}) }) : null;
      const phone = content.phone ? text('phone', String(content.phone), { font: f.headlineFont, size: end.phoneSize, weight: f.st.headline.weight, lineHeight: 1.05, color: tc.text, align: 'center' }) : null;
      const url = content.url ? text('url', String(content.url), { font: f.bodyFont, size: 38, weight: 500, letterSpacing: 0.02, color: tc.text, align: 'center', ...(end.underlineUrl ? { underline: true } : {}) }) : null;
      const kids = [lead, headline({ ...content, ...(content.phone ? { headlineSize: Math.round(sub / f.st.headline.sizeScale) } : {}) }, f, tc, { base: 150, align: 'center', role: 'end' }), phone, body(content, f, tc, { size: 40, align: 'center' }), url].filter(Boolean);
      const layers = [stack('text-block', { anchor: 'center', x: 50, y: 50, w: 100 - 2 * x }, kids, { gap: 36 })];
      if (content.logo) layers.push({ id: 'logo', type: 'image', src: content.logo, alt: content.logoAlt ?? 'Logo', fit: 'contain', layout: { anchor: 'top', x: 50, y: topY(size), w: end.logoW, h: 'auto' } });
      const discLines = content.disclaimer ? Math.max(1, Math.ceil(String(content.disclaimer).length / Math.floor((0.86 * size.w) / (end.disclaimerSize * 0.5)))) : 0;
      const discH = discLines * end.disclaimerSize * 1.3;
      if (content.disclaimer) layers.push(text('disclaimer', String(content.disclaimer), { font: f.bodyFont, size: end.disclaimerSize, weight: 400, lineHeight: 1.3, color: tc.text, align: 'center', balance: true }, { anchor: 'bottom', x: 50, y: bottomY(size), w: 86 }));
      if (content.footer) layers.push(small('footer', content.footer, f, tc, { anchor: 'bottom', x: 50, y: pct(bottomY(size) - (discH / size.h) * 100 - (content.disclaimer ? 2 : 0)), w: 84 }, { align: 'center', color: tc.accentSmall }));
      return layers;
    },
  },
};

export function listPatterns() {
  return Object.entries(PATTERNS).map(([id, p]) => ({ id, name: p.name, description: p.description, bestFor: p.bestFor, defaultTone: p.tone, slots: p.slots, example: p.example }));
}

// ---- composing a page ------------------------------------------------------------------------------------------------

function flatten(layers, out = new Map()) {
  for (const l of layers) { out.set(l.id, l); if (l.children) flatten(l.children, out); }
  return out;
}

const differs = (a, b) => JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);

/**
 * Build a page from a pattern.
 * @param {{pattern:string, content:object, brand:object, colourway?:string, tone?:string, size:object, sizes?:object[], pageId?:string, title?:string, position?:{index:number,total:number}}} o
 * `size` is the main size ({id,w,h,safe}); `sizes` are all the sizes the document has, so other sizes get overrides where the
 * safe zones or the room for a picture make positions differ. `position` (this page's place in the post) lets the brand's
 * footer, logo and button appear on the first/last/every page, as its post style says.
 * @returns {{page:object, notes:string[]}} notes say anything the pattern had to give up to make it fit
 */
export function composePage({ pattern, content = {}, brand, colourway, tone, size, sizes = [], pageId, title, position }) {
  const p = PATTERNS[pattern];
  if (!p) throw new Error(`Unknown pattern "${pattern}". Patterns: ${Object.keys(PATTERNS).join(', ')}.`);
  if (pattern === 'person' && !content.name && !content.headline) throw new Error('The "person" pattern needs a name.');
  if (['cover', 'statement', 'list', 'item', 'quote', 'image-hero', 'split', 'cta', 'closing-card'].includes(pattern) && !content.headline) throw new Error(`The "${pattern}" pattern needs a headline.`);
  if (pattern === 'stat' && !content.number && !content.headline) throw new Error('The "stat" pattern needs a number.');
  if ((pattern === 'image-hero' || pattern === 'split' || pattern === 'person' || pattern === 'closing-card') && !content.image) throw new Error(`The "${pattern}" pattern needs an image.`);
  const roles = brandRoles(brand, colourway);
  const toneName = tone ?? p.tone;
  const tc = toneColours(roles, toneName);
  const f = fonts(brand);
  const notes = [];
  const build = (s) => applyBrandStyle(p.build({ content: pattern === 'closing-card' ? { ...content, __brand: brand, logo: content.logo ?? brand.logos?.primary ?? logoFor(brand, 'light') } : content, f, tc, size: s, roles, notes }), { pattern, content, f, tc, size: s, brand, position, toneName });
  const layers = build(size);
  const base = flatten(layers);
  for (const other of sizes) {
    if (other.id === size.id) continue;
    const variant = flatten(build(other));
    for (const [id, layer] of base) {
      const v = variant.get(id);
      if (!v) { layer.overrides = { ...(layer.overrides ?? {}), [other.id]: { hidden: true } }; continue; }
      const o = {};
      if (differs(layer.layout, v.layout)) o.layout = v.layout;
      if (differs(layer.style, v.style)) o.style = v.style;
      if (Object.keys(o).length) layer.overrides = { ...(layer.overrides ?? {}), [other.id]: o };
    }
  }
  const gradient = f.st.background.mode === 'gradient' ? f.st.background.gradients?.[toneName] : null;
  return { page: { id: pageId ?? pattern, title: title ?? p.name, background: gradient ?? tc.bg, layers }, notes: [...new Set(notes)] };
}

/** The brand's logo for a page tone: its light-background version on light pages, the normal one elsewhere. */
export function logoFor(brand, toneName) {
  const lg = postStyle(brand).logo;
  const key = toneName === 'light' && lg.keyLight ? lg.keyLight : lg.key;
  if (key) return brand.logos?.[key] ?? null;
  // no logo chosen in the house style: a brand that has a white or a black version gets the one that reads on this background (white on dark, colour on light)
  const L = brand.logos ?? {};
  if (L.white || L.black) return toneName === 'dark' || toneName === 'accent' ? (L.white ?? L.primary ?? L.black ?? null) : (L.primary ?? L.black ?? L.white ?? null);
  return null;
}

// ---- the brand's house style, applied on top of a pattern ----------------------------------------------------------------

const CENTRE_ANCHOR = { 'top-left': 'top', left: 'center', 'bottom-left': 'bottom' };
const BOTTOM_ANCHOR = { 'top-left': 'bottom-left', top: 'bottom', left: 'bottom-left', center: 'bottom', 'bottom-left': 'bottom-left', bottom: 'bottom' };

function mapText(layer, fn) {
  if (layer.type === 'text') fn(layer);
  for (const c of layer.children ?? []) mapText(c, fn);
}
const centreText = (layer) => mapText(layer, (t) => { t.style = { ...(t.style ?? {}), align: 'center' }; });

/** Pick a corner/edge for the logo that keeps clear of the face (focal point) in a full-bleed photo. */
function logoSpotAwayFrom(focal, wanted) {
  if (!focal) return wanted;
  const nearTop = focal.y < 0.42;
  if (wanted.startsWith('top') && nearTop) return focal.x < 0.5 ? 'top-right' : 'top-left';
  if (wanted.startsWith('bottom') && focal.y > 0.62) return focal.x < 0.5 ? 'bottom-right' : 'bottom-left';
  return wanted;
}

function applyBrandStyle(layers, { pattern, content, f, tc, size, brand, position, toneName }) {
  if (pattern === 'closing-card') return layers;   // composed whole: picture, card, logo and details
  const st = f.st;
  const photoPage = ['image-hero', 'person'].includes(pattern);
  const hasPictureBeside = !!content.image && ['cover', 'item'].includes(pattern);
  const block = layers.find((l) => l.id === 'text-block');

  // centred text blocks
  if (st.align === 'center' && !hasPictureBeside && pattern !== 'list') {
    for (const l of layers) {
      if (l.id !== 'text-block' || !CENTRE_ANCHOR[l.layout?.anchor]) continue;
      l.layout = { ...l.layout, anchor: CENTRE_ANCHOR[l.layout.anchor], x: 50 };
      if (l.stack) l.stack = { ...l.stack, align: 'center' };
      centreText(l);
    }
  }
  if (pattern === 'list' && st.list.align === 'center' && block && CENTRE_ANCHOR[block.layout.anchor]) block.layout = { ...block.layout, anchor: CENTRE_ANCHOR[block.layout.anchor], x: 50 };
  if (st.photo.radius) for (const l of layers) if (l.type === 'image' && l.id === 'image') l.style = { ...(l.style ?? {}), radius: st.photo.radius };

  const ids = new Set(flatten(layers).keys());
  const nudge = (dy) => { if (block && /^(top|bottom)/.test(block.layout.anchor)) block.layout = { ...block.layout, y: pct(block.layout.y + dy) }; };

  // what will sit along the bottom edge (so a bottom-anchored block clears it)
  // a "Swipe" cue on the first page means nothing on a one-page post
  const lonely = position?.total === 1;
  const wantButton = !!st.button.text && !(lonely && st.button.show === 'first') && (st.button.show === 'last' && pattern === 'cta' ? true : showsOn(st.button.show, position));
  const buttonAtBottom = wantButton && st.button.position === 'bottom-center';
  const wantFooter = !!st.footer.text && showsOn(st.footer.show, position) && !ids.has('footer') && !ids.has('hint') && !ids.has('label') && !ids.has('url') && !ids.has('disclaimer');

  // text zone: lower third instead of the top of the page
  const zoneable = ['cover', 'list', 'item', 'stat', 'quote', 'statement'].includes(pattern) && !hasPictureBeside;
  if (block && zoneable && st.textZone === 'lower' && BOTTOM_ANCHOR[block.layout.anchor]) {
    const reserve = (buttonAtBottom ? 9 : 0) + (wantFooter ? 6 : 0);
    block.layout = { ...block.layout, anchor: BOTTOM_ANCHOR[block.layout.anchor], y: pct(bottomY(size) - reserve - 4) };
  } else if (block && zoneable && st.textZone === 'centre' && block.layout.anchor !== 'center') {
    block.layout = { ...block.layout, anchor: block.layout.anchor.endsWith('left') ? 'left' : 'center', y: 50 };
  }

  // text shadow over photographs
  if (photoPage && st.photo.textShadow && block) mapText(block, (t) => { t.style = { ...(t.style ?? {}), shadow: { ...st.photo.textShadow, ...(t.style?.shadow ?? {}) } }; });

  // logo
  const logoPath = logoFor(brand, toneName);
  if (logoPath && showsOn(st.logo.show, position) && !ids.has('logo')) {
    const spot = st.photo.logoAvoid === 'focal' && (photoPage || content.focal) ? logoSpotAwayFrom(content.focal, st.logo.placement) : st.logo.placement;
    const [vert, horiz = 'center'] = spot.split('-');
    const top = vert === 'top';
    const w = pattern === 'cta' && st.end.logoW ? st.end.logoW : st.logo.w;
    const reserve = (st.logo.h ?? 7) + 3;
    layers.push({
      id: 'brand-logo', type: 'image', src: logoPath, alt: `${brand.name} logo`, fit: 'contain',
      layout: { anchor: horiz === 'center' ? vert : `${vert}-${horiz}`, x: horiz === 'left' ? sideX(size) : horiz === 'right' ? 100 - sideX(size) : 50, y: top ? topY(size) : bottomY(size), w, h: 'auto' },
    });
    if (top && block?.layout.anchor.startsWith('top') && horiz === 'center') nudge(reserve);
    if (!top && block?.layout.anchor.startsWith('bottom') && horiz === 'center') nudge(-reserve);
  }
  // footer line
  if (wantFooter) {
    const t = st.footer.case === 'upper' ? st.footer.text.toUpperCase() : st.footer.text;
    layers.push(text('brand-footer', t, { font: fontToken(brand, st.footer.font, 'body'), size: st.footer.size, weight: 500, letterSpacing: st.footer.tracking, color: tc.sub, align: 'center' }, { anchor: 'bottom', x: 50, y: bottomY(size), w: 84 }));
  }
  // button / pill (closing page, or "Swipe" on the first page, as the brand's style says)
  if (wantButton) {
    const label = st.button.text + (st.button.chevrons ? ` ${'›'.repeat(st.button.chevrons)}` : '');
    const where = st.button.position;
    const corner = where === 'bottom-right' || where === 'bottom-left';
    const w = corner ? 30 : 62;
    const x = where === 'bottom-right' ? 100 - sideX(size) : where === 'bottom-left' ? sideX(size) : 50;
    const anchor = where === 'bottom-center' ? 'bottom' : where;
    const y = pct(bottomY(size) - (!corner && (ids.has('footer') || st.footer.text) ? 9 : 0));
    const lay = { anchor, x, y, w, h: 5.6 };
    const tx = where === 'bottom-right' ? x - w / 2 : where === 'bottom-left' ? x + w / 2 : 50;
    layers.push(
      { id: 'brand-button', type: 'shape', shape: 'rect', layout: lay, style: st.button.style === 'fill' ? { fill: tc.accent, radius: 999 } : { fill: 'transparent', stroke: { color: tc.text, width: 3 }, radius: 999 } },
      text('brand-button-text', label, { font: f.bodyFont, size: corner ? 28 : 34, weight: 600, letterSpacing: 0.06, color: st.button.style === 'fill' ? tc.bg : tc.text, align: 'center' }, { anchor: 'center', x: tx, y: pct(y - 2.8), w: w - 4 }),
    );
  }
  return layers;
}

/** Building blocks, for other composers (the reel composer) that want the same brand-styled text. */
export const blocks = { fonts, kicker, headline, body, text, stack, sideX, topY, bottomY, pct, headlinePx, flatten };
