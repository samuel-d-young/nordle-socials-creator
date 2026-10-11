// Small text helpers the checks share: normalising, splitting into sentences, picking out the words that carry meaning,
// and comparing two pieces of text. No dependencies; runs anywhere.

/** Plain, comparable text: straight quotes, one kind of dash, single spaces. Keeps the case. */
export const normalise = (s) => String(s ?? '')
  .normalize('NFKC')
  .replace(/[‘’‚′]/g, "'")
  .replace(/[“”„″]/g, '"')
  .replace(/[–—−]/g, '-')
  .replace(/ /g, ' ')
  .replace(/[ \t\r\f\v]+/g, ' ')
  .trim();

export const lower = (s) => normalise(s).toLowerCase();

/** Words (letters and digits, keeping inner hyphens and apostrophes: x-ray, don't). Lower-case. */
export const tokens = (s) => lower(s).match(/[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*/gu) ?? [];

export const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** "PainFreeCare" -> "Pain Free Care" (hashtags carry words). */
export const splitCamel = (s) => String(s).replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2').replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2').replace(/_/g, ' ');

const ABBREV = new Set(['dr', 'mr', 'mrs', 'ms', 'prof', 'st', 'vs', 'eg', 'ie', 'approx', 'mt', 'ave', 'rd', 'sr', 'jr', 'dept']);

/** True if a word that ends in a full stop is really an abbreviation or an initial, not the end of a sentence. */
export function endsWithAbbreviation(word) {
  const w = lower(word).replace(/["')\]]+$/, '');
  if (!w.endsWith('.')) return false;
  if (/^[ap]\.m\.$/.test(w)) return true; // a.m. / p.m. (but "9 am." can end a sentence)
  const stem = w.slice(0, -1).replace(/\./g, '');
  if (!stem) return false;
  if (/^[a-z]$/.test(stem)) return true; // an initial: J. Citizen
  return ABBREV.has(stem);
}

/**
 * Split text into sentences. A new line always ends one. Returns [{text, start, end}] with character offsets.
 * "Dr. Smith", "9 a.m." and "J. Citizen" do not end a sentence.
 */
export function sentences(text) {
  const src = String(text ?? '');
  const out = [];
  let from = 0;
  const push = (to) => {
    const slice = src.slice(from, to);
    const trimmed = slice.trim();
    if (trimmed) {
      const lead = slice.length - slice.trimStart().length;
      out.push({ text: trimmed, start: from + lead, end: from + lead + trimmed.length });
    }
    from = to;
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\n') { push(i); from = i + 1; continue; }
    if (c !== '.' && c !== '!' && c !== '?' && c !== '…') continue;
    let j = i;
    while (j + 1 < src.length && /[.!?…]/.test(src[j + 1])) j++;
    let k = j;
    while (k + 1 < src.length && /["')\]”’]/.test(src[k + 1])) k++;
    const next = src[k + 1];
    if (next !== undefined && !/\s/.test(next)) { i = k; continue; } // 3.5, example.com
    if (c === '.' && j === i) {
      const before = src.slice(Math.max(0, src.lastIndexOf(' ', i - 1) + 1), i + 1);
      if (endsWithAbbreviation(before)) { i = k; continue; }
    }
    push(k + 1);
    i = k;
  }
  push(src.length);
  return out;
}

// ---- words that carry meaning ----------------------------------------------------------------------------------------

const STOP = new Set(`a about above after again all also am an and any are as at be because been before being below between both but by can could
did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its just let like me more
most my no nor not now of off on once only or other our ours out over own same she should so some such than that the their theirs them then there
these they this those through to too under until up us very was we were what when where which while who whom why will with would you your yours
get got make made makes making take takes see way new meet come comes learn find book call visit today tonight week day days time need needs want
wants let's lets one two three four five six seven eight nine ten first second last next every something anything everything people thing things
swipe tap link bio read more here there really keep give gives give say says said tell tells ask asks little lot lots good great best nice
ready start started starts begin begins open opens`.split(/\s+/));

// Words that mean the same thing for matching a caption to a picture. Each group collapses to its first word.
const CONCEPTS = [
  ['xray', 'x-ray', 'xray', 'xrays', 'x-rays', 'radiograph', 'radiographs', 'radiography', 'opg', 'panoramic', 'cbct', 'scan', 'scans', 'scanner', 'imaging'],
  ['team', 'team', 'staff', 'crew', 'colleagues', 'everyone', 'group'],
  ['dentist', 'dentist', 'dentists', 'doctor', 'doctors', 'dr', 'clinician', 'principal'],
  ['hygienist', 'hygienist', 'hygienists', 'hygiene'],
  ['assistant', 'assistant', 'assistants', 'nurse', 'nurses'],
  ['reception', 'reception', 'receptionist', 'front-desk', 'desk', 'welcome', 'check-in', 'lobby', 'waiting', 'waiting-room'],
  ['exterior', 'exterior', 'outside', 'building', 'street', 'shopfront', 'signage', 'entrance', 'facade', 'sign', 'storefront'],
  ['interior', 'interior', 'inside', 'indoor', 'indoors'],
  ['surgery', 'surgery', 'surgeries', 'clinic', 'treatment-room', 'operatory', 'chair', 'room'],
  ['steriliser', 'steriliser', 'sterilizer', 'autoclave', 'sterilisation', 'sterilization', 'sterile', 'sterilising', 'sterilizing', 'sterilised', 'sterilized', 'sterilise', 'sterilize'],
  ['instruments', 'instrument', 'instruments', 'tools', 'equipment'],
  ['smile', 'smile', 'smiles', 'smiling', 'grin'],
  ['tooth', 'tooth', 'teeth', 'dental', 'dentistry', 'oral'],
  ['implant', 'implant', 'implants'],
  ['whitening', 'whitening', 'whiten', 'whiter', 'bleaching', 'bleach'],
  ['aligner', 'aligner', 'aligners', 'invisalign', 'braces', 'orthodontic', 'orthodontics', 'orthodontist'],
  ['child', 'child', 'children', 'kid', 'kids', 'toddler', 'baby', 'infant', 'childrens', "children's"],
  ['brush', 'brush', 'brushing', 'toothbrush', 'floss', 'flossing', 'interdental'],
  ['microscope', 'microscope', 'microscopy', 'magnification', 'loupes'],
  ['coffee', 'coffee', 'cup', 'latte', 'espresso', 'brew', 'cortado', 'cappuccino', 'flat-white'],
  ['roast', 'roast', 'roaster', 'roasting', 'roasted', 'drum'],
  ['beans', 'bean', 'beans'],
  ['aerial', 'aerial', 'drone', 'coast', 'coastline', 'beach', 'ocean', 'sunrise', 'sunset', 'shoreline'],
  ['night', 'night', 'nighttime', 'dark'],
  ['day', 'day', 'daytime'],
  ['photo', 'photo', 'photograph', 'picture', 'image'],
];
const CONCEPT_OF = new Map();
for (const group of CONCEPTS) for (const w of group.slice(1)) if (!CONCEPT_OF.has(w)) CONCEPT_OF.set(w, group[0]);
for (const group of CONCEPTS) CONCEPT_OF.set(group[0], group[0]);

/** Light suffix stripping, so "scanning", "scanner" and "scans" meet at "scan". */
export function stem(word) {
  let w = word.toLowerCase();
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith('es') && !/(ss|us|is)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  return w;
}

export const conceptOf = (word) => CONCEPT_OF.get(word) ?? CONCEPT_OF.get(stem(word)) ?? stem(word);

/** The meaningful words of a text as concept keys (stop words, numbers and one-letter words dropped). */
export function keywords(text, { keepStop = false } = {}) {
  const out = new Set();
  for (const t of tokens(text)) {
    const parts = t.includes('-') ? [t, t.replace(/-/g, ''), ...t.split('-')] : [t];
    for (const p of parts) {
      if (p.length < 3 && !CONCEPT_OF.has(p)) continue;
      if (/^\d+$/.test(p)) continue;
      const bare = p.replace(/'s$/, '');
      if (!keepStop && STOP.has(bare)) continue;
      out.add(conceptOf(bare));
    }
  }
  return out;
}

export function jaccard(a, b) {
  const A = a instanceof Set ? a : new Set(a);
  const B = b instanceof Set ? b : new Set(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Similarity of two texts by their words, 0 to 1. */
export const textSimilarity = (a, b) => jaccard(tokens(a), tokens(b));

export const clip = (s, n = 160) => { const t = normalise(s).replace(/\s*\n\s*/g, ' / '); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };

/** Format seconds for people: 1:05.3 */
export function stamp(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
