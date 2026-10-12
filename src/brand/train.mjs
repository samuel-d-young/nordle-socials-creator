// "Train" Nordle on the brand's own posts. Claude looks at example posts (src/brand/screenshot.mjs readExamplePosts) and says which colour does which job and how the
// posts are laid out. This turns that into what a brand really has: the five core colours, and the house style for posts (alignment, where the text sits, capitals, how
// an emphasised word is set, where the logo goes). Only values the brand schema allows are ever produced, so a wrong reading can never break a brand.

const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lum = (h) => { const [r, g, b] = hexToRgb(h).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const dist = (a, b) => Math.hypot(...hexToRgb(a).map((v, i) => v - hexToRgb(b)[i]));
const big = (list) => [...list].sort((a, b) => (b.share ?? 0.1) - (a.share ?? 0.1));

/** The core roles the example posts show: ink (the main dark colour), paper (the main light one), accent, muted. Null where the posts did not show it. */
export function coreFromTrain(train) {
  const cs = train?.colors ?? [];
  if (!cs.length) return null;
  const by = (...roles) => big(cs.filter((c) => roles.includes(c.role))).map((c) => c.hex);
  const base = [...by('background'), ...by('headline'), ...by('body')];
  const dark = base.filter((h) => lum(h) < 0.25).sort((a, b) => lum(a) - lum(b));
  const light = base.filter((h) => lum(h) > 0.6).sort((a, b) => lum(b) - lum(a));
  const accent = by('accent')[0] ?? by('highlight')[0] ?? by('button')[0] ?? null;
  const muted = by('muted')[0] ?? null;
  const out = { ink: dark[0] ?? null, paper: light[0] ?? null, accent, muted };
  return Object.values(out).some(Boolean) ? out : null;
}

/** The `posts` house style the example posts imply. Only valid values. `logo` needs the brand to have one. */
export function postsFromTrain(train, { hasLogo = false } = {}) {
  const L = train?.layout ?? {};
  if (!train || !(train.postsSeen > 0 || train.colors?.length)) return null;
  const posts = {};
  if (L.align === 'left' || L.align === 'center') posts.align = L.align;
  if (L.textZone === 'bottom') posts.textZone = 'lower';
  else if (L.textZone === 'middle') posts.textZone = 'centre';
  const headline = {};
  if (L.headlineCase === 'upper') headline.case = 'upper';
  if (['italic-colour', 'colour', 'italic', 'script', 'none'].includes(L.accentStyle)) headline.accent = L.accentStyle;
  if (Object.keys(headline).length) posts.headline = headline;
  if (hasLogo && L.logo && L.logo !== 'none') posts.logo = { show: 'all', placement: L.logo };
  return Object.keys(posts).length ? posts : null;
}

/** A colour name as a brand colour key: letters and digits, lower-case, not one of the core names, unique. */
export function colourKey(name, taken, fallback) {
  const base = String(name ?? '').normalize('NFKD').replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 3).map((w, i) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join('') || fallback;
  let key = /^[a-z]/.test(base) ? base.slice(0, 24) : `c${base}`.slice(0, 24);
  const reserved = new Set(['ink', 'paper', 'accent', 'accentDark', 'muted']);
  for (let n = 2; taken.has(key) || reserved.has(key); n++) key = `${base.slice(0, 20)}${n}`;
  taken.add(key);
  return key;
}

/**
 * Every named colour the screenshot or the example posts showed that the core five do not already hold, as extra brand colours (up to `max`).
 * Colours the scan had already put under a generic name (secondary, tertiary, highlight) are renamed to the real name when they are the same colour.
 */
export function withNamedColours(colors, named, { max = 20 } = {}) {
  const out = { ...colors };
  const taken = new Set(Object.keys(out));
  let added = 0;
  for (const c of named) {
    const hex = c.hex.toUpperCase();
    const same = Object.entries(out).find(([, v]) => dist(v, hex) < 14);
    if (same) {
      if (/^(secondary|tertiary|highlight)$/.test(same[0]) && c.name) { const k = colourKey(c.name, taken, same[0]); delete out[same[0]]; out[k] = hex; }
      continue;
    }
    if (added >= max) break;
    out[colourKey(c.name ?? c.role, taken, `colour${added + 1}`)] = hex;
    added++;
  }
  return out;
}
