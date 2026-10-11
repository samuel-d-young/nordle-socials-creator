// What a post "is", read from the calendar item, its document and the media catalogs, so results can be grouped by it:
// the kind of hook, a face on the cover, reel length, caption length, music, series, occasion or evergreen, weekday and time of day.
// Every rule is written out here in plain code: a grouping is only as good as its rule, and the report names the rule.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { weekdayName } from '../calendar/dates.mjs';

const readJson = (file) => { try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null; } catch { return null; } };

// ---- the hook ----------------------------------------------------------------------------------------------------------------

export const HOOK_TYPES = ['how-to', 'number', 'myth', 'behind-the-scenes', 'announcement', 'question', 'statement'];
/** Rules in this order; the first that matches wins. Each has a name that is shown next to the result. */
export const HOOK_RULES = [
  { type: 'how-to', rule: 'starts "how to", "how I/we", "steps to", "ways to"', re: /^(how to|how (i|we|you can|do you|can you)|\d+ (steps|ways) to|steps to|ways to|the (easy|simple|right) way to)\b/i },
  { type: 'number', rule: 'starts with a number, or "N things/reasons/tips/signs/mistakes/myths"', re: /^\d+\b(?!\s*(am|pm|a\.m\.|p\.m\.|:))|\b(\d+|two|three|four|five|six|seven|eight|nine|ten)\s+(things|reasons|tips|signs|mistakes|myths|facts|questions|ways|habits)\b/i },
  { type: 'myth', rule: 'says myth, truth, actually, wrong, stop, "you\'ve been told", "not true"', re: /\b(myths?|the truth|truth about|actually|debunk\w*|busted|wrong|stop (doing|brushing|using|saying)|you'?ve been told|not true|really\?)\b/i },
  { type: 'behind-the-scenes', rule: 'says behind the scenes, meet, inside, a day in the life, sneak peek, our team', re: /\b(behind[- ]the[- ]scenes|bts|meet (the|our|dr|your)|meet\b|a day (in the life|with)|inside (the|our)|sneak peek|go behind|our team|day in the life|come with us)\b/i },
  { type: 'announcement', rule: 'says new, now open, opening, introducing, welcome, launching, coming soon, closed, hours', re: /\b(new|now (open|available|here)|opening|open (late|on|this)|introducing|welcome|launch\w*|coming soon|just (in|landed|launched)|announc\w+|we'?re (open|closed|hiring)|closed|opening hours|holiday hours|back (in|from))\b/i },
  { type: 'question', rule: 'has a question mark, or starts with what/why/when/who/which/do/does/did/is/are/can/should/will', re: /\?|^(what|why|when|who|which|do|does|did|is|are|can|could|should|will|would|have|has|ever|how (much|many|often|long))\b/i },
];
/** Which kind of hook a line is. Returns { type, rule } ('statement' when no rule matches). */
export function classifyHook(text) {
  const t = String(text ?? '').trim().split('\n')[0].replace(/^["'“‘]+/, '');
  if (!t) return { type: null, rule: 'no hook text' };
  for (const r of HOOK_RULES) if (r.re.test(t)) return { type: r.type, rule: r.rule };
  return { type: 'statement', rule: 'none of the other rules matched' };
}

// ---- buckets -----------------------------------------------------------------------------------------------------------------

export const captionLengthBucket = (caption) => {
  const n = String(caption ?? '').trim().length;
  if (!n) return null;
  return n < 150 ? 'short (under 150 characters)' : n <= 400 ? 'medium (150 to 400)' : 'long (over 400)';
};
export const reelLengthBucket = (sec) => {
  if (!Number.isFinite(sec) || sec <= 0) return null;
  return sec < 15 ? 'under 15 s' : sec < 30 ? '15 to 30 s' : sec < 60 ? '30 to 60 s' : '60 s or more';
};
/** 'HH:MM' -> morning (before 11), midday (11 to 2 pm), afternoon (2 to 6 pm), evening (6 pm on). */
export const timeBucket = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm ?? ''));
  if (!m) return null;
  const h = Number(m[1]) + Number(m[2]) / 60;
  return h < 11 ? 'morning (before 11)' : h < 14 ? 'midday (11 to 2)' : h < 18 ? 'afternoon (2 to 6)' : 'evening (6 on)';
};
export const weekdayLabel = (date) => (date ? weekdayName(date) : null);

// ---- the document ------------------------------------------------------------------------------------------------------------

export const reelSeconds = (doc) => (doc?.kind === 'video' && Number.isFinite(doc.timeline?.duration) ? doc.timeline.duration : null);

/** True when an unmuted audio clip from an audio source plays under the reel. null when there is no document to look at. */
export function hasMusic(doc) {
  if (!doc || doc.kind !== 'video') return null;
  const audioSources = new Set((doc.sources ?? []).filter((s) => s.type === 'audio').map((s) => s.id));
  for (const t of doc.timeline?.tracks ?? []) {
    if (t.type !== 'audio' || t.mute) continue;
    if ((t.clips ?? []).some((c) => !c.mute && audioSources.has(c.source))) return true;
  }
  return false;
}

/** Named series: a "series:<name>" tag on the document, or the title/hook of the "Meet the team" kind. */
export function seriesOf(item, doc) {
  const tag = (doc?.tags ?? []).find((t) => /^series:/i.test(t));
  if (tag) return tag.replace(/^series:/i, '').trim();
  if (/\bmeet the (team|dentist|staff)\b|\bmeet (dr\.?|our)\b|\bteam spotlight\b/i.test(`${item.title ?? ''} ${item.hook ?? ''}`)) return 'Meet the team';
  return null;
}

// ---- the cover ---------------------------------------------------------------------------------------------------------------

const FACE_TAG = /^(face|faces|smile|smiling|team|staff|portrait|person|people|dentist|hygienist|nurse|assistant|selfie|headshot|doctor|group)$/;
const FACE_SHOWS = /\b(faces?|smil\w+|portrait|headshot|selfie|team|staff|dentist|hygienist|assistant|nurse|doctor|person|people|woman|man|laugh\w*)\b/i;

/** Does one catalog entry show a person's face? (staff only: patients are never used) */
export function entryHasFace(entry) {
  if (!entry) return null;
  if ((entry.people ?? []).length) return true;
  if ((entry.tags ?? []).some((t) => FACE_TAG.test(String(t).toLowerCase()))) return true;
  return FACE_SHOWS.test(entry.shows ?? '');
}

/** The picture a post leads with, as a project path (assets/... or a source path), or null. */
export function coverMedia(doc, item) {
  if (doc?.kind === 'video') {
    const clips = (doc.timeline?.tracks ?? []).filter((t) => t.type === 'video').flatMap((t) => t.clips ?? []).sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    const first = clips[0];
    const src = first && (doc.sources ?? []).find((s) => s.id === first.source);
    return src?.path ?? null;
  }
  if (doc?.pages?.length) {
    const m = /"src"\s*:\s*"([^"]+)"/.exec(JSON.stringify(doc.pages[0]));
    return m ? m[1] : null;
  }
  return item?.external?.cover ?? item?.external?.slides?.[0] ?? null;
}

/** Catalog entry for a path, from assets/catalog.json or sources/catalog.json. */
export function catalogEntry(projectDir, path, cache = {}) {
  if (!path) return null;
  cache.assets ??= readJson(join(projectDir, 'assets', 'catalog.json'))?.items ?? {};
  cache.sources ??= readJson(join(projectDir, 'sources', 'catalog.json'))?.items ?? {};
  return cache.assets[path] ?? cache.sources[path] ?? null;
}

/** { face: true|false|null, media } (null = no catalog entry for the cover, so nobody knows). */
export function coverFace(projectDir, doc, item, cache) {
  const media = coverMedia(doc, item);
  if (!media) return { face: null, media: null };
  const entry = catalogEntry(projectDir, media, cache);
  return { face: entryHasFace(entry), media };
}
