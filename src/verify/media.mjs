// "Does the caption match the photo or clip under it?" The machinery that makes the words and the picture meet.
//
// Auto part (this file): every picture and clip must have a catalog entry that says what it shows; pictures marked doNotUse or
// showing a patient are refused; a picture is not repeated; and for each picture the words attached to it (the headline and body on
// its page, its alt text, the caption sentence that names it) are compared with what the catalog says it shows. The comparison is
// careful about what it claims: it says "mismatch" only for a clear contradiction (the catalog says the picture is NOT the thing
// the words name, or it names a different person), "match" only when the words and the catalog share specific words, and
// otherwise "unsure", which a person or the independent reviewer must look at.

import { error, info, warn } from './findings.mjs';
import { resolveMedia, normaliseRef } from './paths.mjs';
import { flatLayers, layerText } from './surfaces.mjs';
import { clip, conceptOf, keywords, normalise, sentences, stem, tokens } from './text.mjs';
import { shownText } from './transcript.mjs';
import { overlaysDuring, pictureClips } from './timeline.mjs';

// Words too common to prove a picture fits, or to show it does not: they are about the post or the practice, not what is in frame.
const GENERIC_WORDS = ['practice', 'clinic', 'name', 'logo', 'frame', 'photo', 'picture', 'image', 'team', 'cover', 'meet', 'carousel', 'post', 'use', 'used', 'life', 'anonymous', 'shot', 'staff', 'dental', 'centre', 'center', 'room', 'dentist'];
const GENERIC_KEYS = new Set(['tooth', 'photo', 'dentist', 'team']);
const isGeneric = (t) => GENERIC_WORDS.includes(t) || GENERIC_WORDS.includes(stem(t)) || GENERIC_KEYS.has(conceptOf(t));
/** Concept keys of the distinctive words of a text. */
const distinct = (text, ignore = new Set()) => new Set([...keywords(tokens(text).filter((t) => !isGeneric(t)).join(' '))].filter((k) => !ignore.has(k)));
// A trap that is only a note about where the picture came from or what it must not be used for
const NOTE_TRAP = /\b(?:used by|used in|was used|already used|use as|use for|no clinic name|no logo|no name)\b/i;
const OPPOSITES = [[['indoor', 'indoors', 'interior'], ['outdoor', 'outdoors', 'exterior']], [['night', 'nighttime', 'after dark'], ['daytime', 'midday', 'sunny']]];

// ---- finding an entry in the catalog ---------------------------------------------------------------------------------------

/** The catalog entry for a project path (exactly, or written differently, or by the end of its path). */
export function lookupMedia(catalog, ref) {
  const items = catalog?.items ?? {};
  const want = normaliseRef(ref);
  if (Object.hasOwn(items, ref)) return { key: ref, item: items[ref], via: 'exact' };
  const keys = Object.keys(items);
  const same = keys.find((k) => normaliseRef(k).toLowerCase() === want.toLowerCase());
  if (same) return { key: same, item: items[same], via: 'normalised' };
  const tail = keys.filter((k) => { const n = normaliseRef(k).toLowerCase(); const w = want.toLowerCase(); return n.endsWith(`/${w}`) || w.endsWith(`/${n}`) || n.endsWith(`:${w}`); });
  if (tail.length === 1) return { key: tail[0], item: items[tail[0]], via: 'by the end of its path' };
  return null;
}

const isLogo = (src, brand) => Object.values(brand?.logos ?? {}).includes(src) || /(^|\/)logos?\//i.test(src) || /(^|\/)logo[^/]*$/i.test(src);

// ---- judging one pair ------------------------------------------------------------------------------------------------------

/** What a trap says the picture is NOT ("is the plate scanner, not the steriliser" -> "the steriliser"), or null if it says no such thing. */
function negatedPart(trap) {
  if (NOTE_TRAP.test(trap)) return null; // a usage or provenance note, not a look-alike
  const m = /(?:\bnot\b|\bisn't\b|\bis not\b|\brather than\b|\binstead of\b)\s+(.+)$/i.exec(trap);
  if (!m) return null; // "no clinic name in frame" says something is absent; it does not say what the picture is not
  return m[1];
}

/** The distinctive words of the thing a trap says the picture is not. */
const trapKeys = (part) => keywords(tokens(part).filter((t) => !isGeneric(t)).join(' '));

const nameForms = (n) => {
  const bare = normalise(n).replace(/^(?:dr|doctor|prof|professor)\.?\s+/i, '');
  const parts = tokens(bare);
  return { full: tokens(n).join(' '), parts, first: parts[0], last: parts.length > 1 ? parts.at(-1) : null };
};

/**
 * @param {{strong:string, weak?:string, media:object, staffNames?:string[], ignore?:Set<string>}} a
 * strong = words that claim something about the picture; weak = words that only happen near it (what is said while it is shown).
 * @returns {{verdict:'match'|'mismatch'|'unsure', note:string, shared:string[], reason:string}}
 */
export function judgePair({ strong, weak = '', media, staffNames = [], ignore = new Set() }) {
  const wordsK = new Set([...keywords(strong)].filter((k) => !ignore.has(k)));
  const distinctK = distinct(strong, ignore);
  const weakK = new Set([...keywords(weak)].filter((k) => !ignore.has(k)));
  const tagText = (media.tags ?? []).join(' ');
  const mediaText = [media.shows, tagText, media.setting, media.motion, media.speech].filter(Boolean).join(' ');
  const mediaK = keywords(mediaText);
  const tagK = keywords(tagText);
  const allWords = `${strong} ${weak}`;
  const allK = new Set([...wordsK, ...weakK]);

  // 1. the catalog says what this is NOT
  for (const trap of media.traps ?? []) {
    const part = negatedPart(trap);
    if (!part) continue;
    const neg = trapKeys(part);
    for (const k of mediaK) neg.delete(k);
    const hit = [...neg].find((k) => allK.has(k) && !GENERIC_KEYS.has(k));
    if (hit) {
      const w = tokens(allWords).find((t) => keywords(t).has(hit)) ?? hit;
      return { verdict: 'mismatch', reason: 'trap', shared: [], note: `The catalog warns about this picture: "${trap}". The words mention "${w}".` };
    }
  }

  // 2. the words name a person the catalog says is not in the picture
  const people = (media.people ?? []).map(nameForms);
  const text = ` ${tokens(allWords).join(' ')} `;
  const named = staffNames.map(nameForms).filter((n) => (n.full && text.includes(` ${n.full} `)) || (n.first && n.first.length >= 3 && text.includes(` ${n.first} `)) || (n.last && n.last.length >= 4 && text.includes(` ${n.last} `)));
  let peopleMatched = false;
  if (named.length && people.length) {
    const present = named.filter((n) => people.some((p) => (p.first && p.first === n.first) || (p.last && p.last === n.last) || (p.full && p.full === n.full)));
    if (!present.length) {
      return { verdict: 'mismatch', reason: 'person', shared: [], note: `The words name ${named.map((n) => n.full).join(', ')}, but the catalog says this picture shows ${(media.people ?? []).join(', ')}.` };
    }
    peopleMatched = true;
  }

  // 3. opposite things
  for (const [a, b] of OPPOSITES) {
    const inWords = (list) => list.some((w) => text.includes(` ${w} `));
    const inMedia = (list) => list.some((w) => ` ${tokens(mediaText).join(' ')} `.includes(` ${w} `));
    if ((inWords(a) && !inWords(b) && inMedia(b) && !inMedia(a)) || (inWords(b) && !inWords(a) && inMedia(a) && !inMedia(b))) {
      return { verdict: 'mismatch', reason: 'opposite', shared: [], note: `The words say "${a.find((w) => text.includes(` ${w} `)) ?? b.find((w) => text.includes(` ${w} `))}" but the catalog describes the opposite: "${clip(media.shows, 90)}".` };
    }
  }

  // 4. shared specific words
  const shared = [...distinctK].filter((k) => mediaK.has(k) && !GENERIC_KEYS.has(k));
  const tagHits = shared.filter((k) => tagK.has(k));
  if (peopleMatched || tagHits.length >= 1 || shared.length >= 2) {
    return { verdict: 'match', reason: 'overlap', shared, note: peopleMatched ? 'The words name someone the catalog says is in the picture.' : `The words and the catalog share: ${shared.slice(0, 5).join(', ')}.` };
  }
  const content = [...distinctK].filter((k) => !GENERIC_KEYS.has(k));
  if (!content.length) return { verdict: 'unsure', reason: 'generic', shared: [], note: 'The words are general (nothing specific to compare with the picture), so a person has to look.' };
  return { verdict: 'unsure', reason: 'no-overlap', shared, note: `Nothing the words say (${content.slice(0, 5).join(', ')}) is in the catalog description, so a person has to look at the picture.` };
}

// ---- gathering what to check -----------------------------------------------------------------------------------------------

/** Caption sentences that name a page (they share a specific word with its text), or all of them for a one-page post. */
export function captionSentencesFor(doc, pageWords, { first = false, only = false } = {}) {
  const caption = doc.copy?.caption ?? '';
  const list = sentences(caption);
  if (only) return list.map((s) => s.text);
  const pk = new Set([...keywords(pageWords)].filter((k) => !GENERIC_KEYS.has(k)));
  const out = list.filter((s, i) => (first && i === 0) || [...keywords(s.text)].some((k) => pk.has(k)));
  return out.map((s) => s.text);
}

/**
 * Check pictures and clips. `catalog` is loadCatalog(projectDir). Returns the findings, the pairs table, and which pages had no picture.
 */
export function checkMedia(doc, { projectDir, brand, facts, catalog, timeline } = {}) {
  const findings = [];
  const pairs = [];
  const skipped = [];
  const uses = [];
  const ignore = new Set([...keywords([brand?.name, ...(facts?.names ?? [])].filter(Boolean).join(' '))]);
  const staffNames = (facts?.staff ?? []).map((s) => s.name);
  const otherDocs = new Set();

  const record = ({ ref, kind, page, layer, clipId, time, strong, weak = '', range }) => {
    const hit = lookupMedia(catalog, ref);
    const resolved = resolveMedia(projectDir, ref);
    const where = { media: ref, ...(page ? { page } : {}), ...(layer ? { layer } : {}), ...(Number.isFinite(time) ? { time } : {}) };
    const label = `${kind === 'clip' ? 'The clip' : 'The picture'} "${ref}"${page ? ` on page "${page}"` : clipId ? ` (clip "${clipId}")` : ''}`;
    const catalogFile = ref.startsWith('assets/') || kind === 'image' ? 'assets/catalog.json' : 'sources/catalog.json';
    uses.push({ ref, kind, page, layer, clipId, time, found: Boolean(hit) });

    if (!resolved.exists && kind !== 'clip') findings.push(error('media-missing', `${label} is not in the project folder.`, { ...where, fix: 'Copy the file into the project (assets/photos/...) or pick another picture.' }));
    else if (!resolved.exists) findings.push(warn('media-unreachable', `${label} cannot be opened on this computer (${resolved.reason ?? 'file not found'}), so it was not looked at here.`, { ...where, fix: 'Mount the folder in nordle.local.json on this machine, or run the check where the footage is.' }));

    if (!hit) {
      findings.push(error('not-catalogued', `${label} has no entry in ${catalogFile}, so nothing says what it shows and no one can tell whether the words fit it.`, {
        ...where,
        fix: `Look at it, then add an entry to ${catalogFile}: "${ref}": { "shows": "one plain sentence: who, where, doing what", "tags": ["words a caption might use"], "traps": ["what it is NOT"] }.`,
      }));
      return;
    }
    const m = hit.item;
    if (m.doNotUse) findings.push(error('do-not-use', `${label} is marked do-not-use in the catalog: ${m.doNotUse}`, { ...where, fix: 'Use a different picture.' }));
    if (m.patientVisible) findings.push(error('patient-visible', `${label} shows an identifiable patient according to the catalog. Patients must not appear in posts.`, { ...where, fix: 'Use a picture of staff, rooms or equipment only.' }));
    if (m.quality === 'poor') findings.push(warn('poor-quality', `${label} is marked poor quality in the catalog.`, { ...where, fix: 'Use a better picture if there is one.' }));
    if ([...keywords([m.shows, ...(m.tags ?? [])].join(' '))].includes('child')) findings.push(warn('child-in-picture', `${label} is catalogued as showing a child. Children's faces must not be used.`, { ...where, fix: 'Confirm that no child’s face is visible, or use another picture.' }));
    if (range && ((m.start !== undefined && range.in < m.start - 0.05) || (m.end !== undefined && range.out > m.end + 0.05))) {
      findings.push(warn('outside-usable-range', `${label} plays ${range.in.toFixed(1)}–${range.out.toFixed(1)} s, but the catalog says only ${m.start ?? 0}–${m.end ?? 'the end'} s of it is usable.`, { ...where, fix: 'Keep the clip inside the usable range.' }));
    }
    for (const d of m.usedIn ?? []) if (d !== doc.id) otherDocs.add(`${ref}|${d}`);

    const words = [strong, weak && `(said: ${weak})`].filter(Boolean).join(' ');
    if (!strong.trim() && !weak.trim()) { skipped.push(`${page ?? clipId ?? ref}: no words to compare`); return; }
    const j = judgePair({ strong, weak, media: m, staffNames, ignore });
    if (!strong.trim() && j.verdict !== 'mismatch') return; // spoken words alone make no claim about the picture, unless they hit a trap
    pairs.push({ ...(page ? { page } : clipId ? { page: clipId } : {}), ...(Number.isFinite(time) ? { time: Math.round(time * 100) / 100 } : {}), media: ref, words: clip(words, 400), shows: clip([m.shows, (m.tags ?? []).length ? `[${m.tags.join(', ')}]` : '', (m.traps ?? []).length ? `NOT: ${m.traps.join('; ')}` : ''].filter(Boolean).join(' '), 400), verdict: j.verdict, note: j.note });
    if (j.verdict === 'mismatch') {
      findings.push(error('media-mismatch', `${label} does not fit its words. ${j.note}`, { ...where, fix: 'Change the words so they describe what the picture really shows, or pick a picture that fits them.' }));
    }
  };

  if (doc.kind !== 'video') {
    const seen = new Map();
    for (const page of doc.pages ?? []) {
      const layers = flatLayers(page.layers);
      const images = layers.filter((l) => l.type === 'image' && !l.hidden && !isLogo(l.src, brand));
      if (!images.length) { skipped.push(`${page.id}: no picture`); continue; }
      const text = layers.filter((l) => l.type === 'text' && !l.hidden).map(layerText).join('\n');
      const alt = [doc.copy?.alt?.[page.id], ...images.map((i) => i.alt)].filter(Boolean).join('. ');
      const only = (doc.pages ?? []).length === 1;
      const capSent = captionSentencesFor(doc, text, { first: doc.pages[0] === page, only }).join(' ');
      const strong = [text, alt, capSent].filter(Boolean).join('\n');
      for (const img of images) {
        if (/\.svg(\?|$)/i.test(img.src) && !lookupMedia(catalog, img.src)) {
          findings.push(info('vector-not-catalogued', `The artwork "${img.src}" on page "${page.id}" is a vector drawing with no catalog entry, so the words were not compared with it.`, { media: img.src, page: page.id, layer: img.id }));
          continue;
        }
        record({ ref: img.src, kind: 'image', page: page.id, layer: img.id, strong });
        if (seen.has(img.src)) findings.push(warn('picture-repeated', `The picture "${img.src}" is used on page "${seen.get(img.src)}" and again on page "${page.id}".`, { media: img.src, page: page.id, fix: 'Use a different picture on one of them.' }));
        else seen.set(img.src, page.id);
      }
    }
  } else if (timeline) {
    for (const c of pictureClips(timeline)) {
      const src = c.src;
      if (!src) continue;
      const overlays = overlaysDuring(doc, c.tlStart, c.tlEnd);
      const strong = overlays.flatMap((l) => flatLayers([l]).filter((x) => x.type === 'text' && !x.hidden).map(layerText)).join('\n');
      const weak = c.audible ? shownText(c.words) : '';
      record({ ref: src.path, kind: 'clip', clipId: c.id, time: c.tlStart, strong, weak, range: { in: c.in, out: c.out } });
    }
    for (const l of flatLayers(doc.layers ?? [])) {
      if (l.type === 'image' && !isLogo(l.src, brand) && !l.hidden) record({ ref: l.src, kind: 'image', layer: l.id, time: l.time?.start, strong: [doc.copy?.alt?.video, l.alt].filter(Boolean).join('. ') });
    }
  }

  for (const key of otherDocs) {
    const [ref, other] = key.split('|');
    findings.push(warn('used-in-other-post', `The catalog says "${ref}" was already used in "${other}". A photo should not be repeated within a month.`, { media: ref, fix: `Pick a different picture, or confirm "${other}" is posted in another month and remove it from usedIn.` }));
  }

  const unsure = pairs.filter((p) => p.verdict === 'unsure');
  if (unsure.length) {
    findings.push(warn('media-unsure', `${unsure.length} of ${pairs.length} picture${pairs.length === 1 ? '' : 's'} could not be matched to the words by the script (${unsure.slice(0, 6).map((p) => p.page ?? p.media).join(', ')}${unsure.length > 6 ? ', ...' : ''}). Someone has to look at them.`, { fix: 'Look at each picture yourself, read the words under it, and record your verdict (nordle_record_check, media-match). The independent reviewer does it again.' }));
  }
  return { findings, pairs, skipped, uses };
}
