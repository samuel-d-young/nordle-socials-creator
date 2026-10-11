// A brand's house style for posts: the `posts` block in brand.json. Layout patterns read it, so the same pattern looks like
// each brand's own posts (its headline font and casing, its accent treatment, centred or left, gradient backgrounds, a footer,
// the logo, a button). Everything is optional; with no block a brand gets Nordle's plain defaults. Pure: runs in Node and in the browser.

export const DEFAULT_POST_STYLE = {
  align: 'left',
  headline: { font: 'display', weight: 700, case: 'none', tracking: 0, lineHeight: null, accent: 'italic-colour', accentFont: 'script', accentScale: 1.2, sizeScale: 1, sizes: null, shadow: null },
  kicker: { font: 'body', size: 28, weight: 600, case: 'upper', tracking: 0.18, style: 'label', scriptSize: 84, color: null },
  textZone: 'auto',
  body: { font: 'body', weight: 400, sizeScale: 1 },
  background: { mode: 'flat', gradients: {} },
  footer: { text: null, show: 'none', size: 26, tracking: 0.16, case: 'none', font: 'body' },
  logo: { key: null, keyLight: null, show: 'none', placement: 'top-center', w: 16 },
  button: { text: null, style: 'outline', show: 'none', position: 'bottom-center', chevrons: 0 },
  photo: { radius: 0, fade: null, textShadow: null, logoAvoid: null },
  end: { leadStyle: 'italic', phoneSize: 92, underlineUrl: false, disclaimerSize: 25, logoW: 30 },
  list: { align: null, numbered: true },
  person: { nameSize: 100, rule: true, roleCase: 'upper' },
};

const merge = (base, over) => {
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' ? merge(base[k], v) : v;
  return out;
};

/** The brand's post style with every default filled in. */
export function postStyle(brand) {
  return merge(DEFAULT_POST_STYLE, brand?.posts);
}

/** A font token for a key in brand.fonts ('display', 'body', 'script'), falling back sensibly. */
export function fontToken(brand, key, fallbackKey = 'body') {
  const keys = Object.keys(brand.fonts ?? {});
  const pick = keys.includes(key) ? key : keys.includes(fallbackKey) ? fallbackKey : keys[0];
  return `$brand.fonts.${pick}`;
}

/** Should an element with this `show` rule appear on a page at this position? */
export function showsOn(show, position) {
  if (!show || show === 'none') return false;
  if (show === 'all') return true;
  if (!position) return false;
  const first = position.index === 0, last = position.index === position.total - 1;
  if (show === 'first') return first;
  if (show === 'last') return last;
  return false;
}
