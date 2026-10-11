// No repeats within a month: the same photo, the same hook sentence, a near-copy of another caption, the same page headline.
// A post's month comes from its brief (postDate) or from the calendar item it was built for.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { error, warn } from './findings.mjs';
import { normaliseRef, resolveMedia } from './paths.mjs';
import { flatLayers, layerText } from './surfaces.mjs';
import { jaccard, normalise, sentences, tokens } from './text.mjs';
import { shownText } from './transcript.mjs';
import { buildTimeline } from './timeline.mjs';

const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

export function listDocs(projectDir) {
  const dir = join(projectDir, 'docs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => ({ file: join(dir, f), doc: readJson(join(dir, f)) }))
    .filter((x) => x.doc?.schema?.startsWith('nordle.doc/') && !x.doc.explore).map((x) => ({ id: x.doc.id, doc: x.doc, file: x.file }));
}

export function postDateOf(doc, calendar) {
  if (doc.brief?.postDate) return doc.brief.postDate;
  const items = calendar?.items ?? [];
  const it = items.find((x) => x.doc === doc.id) ?? items.find((x) => doc.brief?.calendarItem && x.id === doc.brief.calendarItem);
  return it?.date ?? null;
}

const isLogo = (src, brand) => Object.values(brand?.logos ?? {}).includes(src) || /(^|\/)logos?\//i.test(src) || /(^|\/)logo[^/]*$/i.test(src);
const hashFile = (abs) => { try { return createHash('sha1').update(readFileSync(abs)).digest('hex').slice(0, 16); } catch { return null; } };

/** What a post uses that must not repeat. */
export function fingerprint(doc, { projectDir, brand, withTimeline = false } = {}) {
  const photos = new Map(); // normalised path -> where
  const clips = []; // {source path, in, out}
  const headlines = [];
  for (const p of doc.pages ?? []) {
    const layers = flatLayers(p.layers);
    for (const l of layers) if (l.type === 'image' && !l.hidden && !isLogo(l.src, brand) && !/\.svg$/i.test(l.src)) photos.set(normaliseRef(l.src), { page: p.id, layer: l.id, ref: l.src });
    const texts = layers.filter((l) => l.type === 'text' && !l.hidden);
    const head = texts.reduce((best, l) => (!best || (l.style?.size ?? 0) > (best.style?.size ?? 0) ? l : best), null);
    if (head) headlines.push({ page: p.id, text: normalise(layerText(head)).replace(/\s*\n\s*/g, ' ') });
  }
  for (const l of flatLayers(doc.layers ?? [])) if (l.type === 'image' && !isLogo(l.src, brand)) photos.set(normaliseRef(l.src), { layer: l.id, ref: l.src });
  const hooks = [];
  const first = sentences(doc.copy?.caption ?? '')[0]?.text;
  if (first) hooks.push(first);
  let spoken = null;
  if (doc.kind === 'video' && doc.timeline) {
    const srcById = new Map((doc.sources ?? []).map((s) => [s.id, s]));
    for (const tr of doc.timeline.tracks) for (const c of tr.clips) {
      const s = srcById.get(c.source);
      if (s && s.type !== 'audio') clips.push({ ref: s.path, in: c.in, out: c.out, id: c.id });
      if (s?.type === 'image') photos.set(normaliseRef(s.path), { clip: c.id, ref: s.path });
    }
    if (withTimeline && projectDir) {
      const tl = buildTimeline(doc, projectDir);
      const speech = tl?.clips.filter((c) => c.audible && c.words.length).sort((a, b) => a.tlStart - b.tlStart) ?? [];
      if (speech.length) {
        spoken = speech.filter((c) => c.tlStart < speech[0].tlStart + 8).map((c) => shownText(c.words)).join(' ');
        const s1 = sentences(spoken)[0]?.text;
        if (s1) hooks.push(s1);
      }
    }
  }
  return { photos, clips, headlines, hooks, caption: tokens(doc.copy?.caption ?? ''), spoken };
}

/**
 * @returns {{findings:object[], compared:string[]}}
 */
export function checkUniqueness(doc, { projectDir, brand, docs = listDocs(projectDir), calendar = readJson(join(projectDir, 'calendar.json')) } = {}) {
  const findings = [];
  const mine = fingerprint(doc, { projectDir, brand, withTimeline: true });
  const myDate = postDateOf(doc, calendar);
  const myMonth = myDate?.slice(0, 7) ?? null;
  const rejected = new Set((calendar?.items ?? []).filter((i) => i.status === 'rejected' && i.doc).map((i) => i.doc));
  const compared = [];

  // inside the post
  const seen = new Map();
  for (const h of mine.headlines) {
    const key = h.text.toLowerCase();
    if (key.split(/\s+/).length < 2) continue;
    if (seen.has(key)) findings.push(warn('repeated-headline-in-post', `Pages "${seen.get(key)}" and "${h.page}" have the same headline, "${h.text}".`, { page: h.page, fix: 'Give each page its own headline.' }));
    else seen.set(key, h.page);
  }

  for (const other of docs) {
    if (other.id === doc.id || rejected.has(other.id)) continue;
    const theirDate = postDateOf(other.doc, calendar);
    const theirMonth = theirDate?.slice(0, 7) ?? null;
    const known = myMonth && theirMonth;
    if (known && myMonth !== theirMonth) continue;
    compared.push(other.id);
    const lvl = known ? error : warn;
    const when = known ? `, posted in the same month (${theirDate})` : ' (its posting month is not known, so it is compared anyway)';
    const theirs = fingerprint(other.doc, { projectDir, brand, withTimeline: true });

    // photos: the same path, or the same picture under another name
    for (const [k, v] of mine.photos) {
      let hit = theirs.photos.get(k);
      let how = '';
      if (!hit) {
        const a = resolveMedia(projectDir, v.ref);
        const ha = a.exists ? hashFile(a.abs) : null;
        if (ha) {
          for (const v2 of theirs.photos.values()) {
            const b = resolveMedia(projectDir, v2.ref);
            if (b.exists && hashFile(b.abs) === ha) { hit = v2; how = ` (the same picture saved as "${v2.ref}")`; break; }
          }
        }
      }
      if (hit) findings.push(lvl('reused-photo', `The photo "${v.ref}" is also used in "${other.id}"${when}${how}. A photo must not be reused within a month.`, { media: v.ref, ...(v.page ? { page: v.page } : {}), fix: 'Pick a different photo for this post. If you must reuse it, add an allow entry with the reason to nordle.project.json.' }));
    }
    // footage: the same part of the same file
    for (const a of mine.clips) for (const b of theirs.clips) {
      if (normaliseRef(a.ref) !== normaliseRef(b.ref)) continue;
      const overlap = Math.min(a.out, b.out) - Math.max(a.in, b.in);
      if (overlap > 0.5) findings.push(warn('reused-footage', `Clip "${a.id}" uses ${a.ref} from ${a.in.toFixed(1)} to ${a.out.toFixed(1)} s, and "${other.id}" uses an overlapping part (${b.in.toFixed(1)} to ${b.out.toFixed(1)} s)${when}.`, { media: a.ref, fix: 'Use a different part of the footage.' }));
    }
    // hooks
    for (const h of mine.hooks) for (const g of theirs.hooks) {
      const sim = jaccard(tokens(h), tokens(g));
      if (sim >= 0.8) findings.push(lvl('reused-hook', `The opening line "${h}" is the same as the opening line of "${other.id}" ("${g}")${when}.`, { fix: 'Write a new opening line for this post.' }));
      else if (sim >= 0.6) findings.push(warn('similar-hook', `The opening line "${h}" is very like the one in "${other.id}" ("${g}")${when}.`, { fix: 'Change the opening line so it says something different.' }));
    }
    // captions
    const sim = jaccard(new Set(mine.caption), new Set(theirs.caption));
    if (mine.caption.length > 8 && theirs.caption.length > 8) {
      if (sim >= 0.75) findings.push(lvl('near-duplicate-caption', `The caption is ${Math.round(sim * 100)}% the same words as the caption of "${other.id}"${when}.`, { fix: 'Rewrite the caption so it says something new.' }));
      else if (sim >= 0.55) findings.push(warn('similar-caption', `The caption shares ${Math.round(sim * 100)}% of its words with the caption of "${other.id}"${when}.`, { fix: 'Vary the wording so the two posts do not read alike.' }));
    }
    // headlines
    for (const h of mine.headlines) {
      const key = h.text.toLowerCase();
      if (key.split(/\s+/).length < 2) continue;
      const same = theirs.headlines.find((x) => x.text.toLowerCase() === key);
      if (same) findings.push(warn('reused-headline', `Page "${h.page}" has the headline "${h.text}", the same as page "${same.page}" of "${other.id}"${when}.`, { page: h.page, fix: 'Give this page a different headline.' }));
    }
  }
  return { findings, compared, month: myMonth };
}
