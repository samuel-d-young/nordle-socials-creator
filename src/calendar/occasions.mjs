// Dates a post can ride on: Australian public holidays, awareness days, seasons, school terms, the health-fund year.
// The data is data/occasions-au.json (rules, not lists of years). Nothing here is invented: an entry we are not sure of
// is marked verify:true, and callers must tell the owner to confirm it before a post states the date.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../../tools/validate.mjs';
import { addDays, easterSunday, isDate, nthWeekday, iso, daysInMonth, diffDays } from './dates.mjs';

export const KINDS = ['public-holiday', 'observance', 'awareness', 'commercial', 'cultural', 'school', 'finance', 'season'];
export const CONFIDENCE = ['high', 'medium', 'low'];
export const RELEVANCE = ['high', 'medium', 'low'];
export const ADVICE = ['closed', 'respectful', 'avoid-promo', 'post-ok'];
const RANK = { high: 3, medium: 2, low: 1 };

let cached;
export function loadOccasions(file = join(ROOT, 'data', 'occasions-au.json')) {
  if (file === join(ROOT, 'data', 'occasions-au.json') && cached) return cached;
  const data = JSON.parse(readFileSync(file, 'utf8'));
  if (file === join(ROOT, 'data', 'occasions-au.json')) cached = data;
  return data;
}

/** Problems with an occasions file, as words. Empty when it is fine. */
export function validateOccasions(data) {
  const errors = [];
  const ids = new Set();
  for (const o of data.occasions ?? []) {
    const at = `occasion "${o.id}"`;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(o.id ?? '')) errors.push(`${at}: bad id`);
    if (ids.has(o.id)) errors.push(`${at}: duplicate id`);
    ids.add(o.id);
    if (!o.name) errors.push(`${at}: no name`);
    if (!KINDS.includes(o.kind)) errors.push(`${at}: kind "${o.kind}" is not one of ${KINDS.join(', ')}`);
    if (!CONFIDENCE.includes(o.confidence)) errors.push(`${at}: confidence must be ${CONFIDENCE.join('|')}`);
    if (!RELEVANCE.includes(o.relevance)) errors.push(`${at}: relevance must be ${RELEVANCE.join('|')}`);
    if (!ADVICE.includes(o.advice)) errors.push(`${at}: advice must be ${ADVICE.join('|')}`);
    if (typeof o.verify !== 'boolean') errors.push(`${at}: verify must be true or false`);
    if (o.confidence === 'low' && o.verify !== true) errors.push(`${at}: low confidence entries must be verify:true`);
    if (!Array.isArray(o.regions) || !o.regions.length) errors.push(`${at}: needs regions`);
    if (!Array.isArray(o.tags) || !o.tags.length) errors.push(`${at}: needs tags`);
    const r = o.rule ?? {};
    if (!['fixed', 'nth-weekday', 'easter', 'month', 'dates'].includes(r.type)) errors.push(`${at}: unknown rule type "${r.type}"`);
    if (r.type === 'dates') for (const d of r.dates ?? []) { if (!isDate(d.date) || (d.end && !isDate(d.end))) errors.push(`${at}: bad date ${d.date}`); }
  }
  return errors;
}

/** The dates (as {date,end,name,verify}) a rule produces in one year. */
function instancesOf(o, year) {
  const r = o.rule;
  const span = Math.max(1, r.span ?? 1);
  const one = (date) => ({ date, end: addDays(date, span - 1) });
  switch (r.type) {
    case 'fixed': {
      if (r.day > daysInMonth(year, r.month)) return [];
      return [one(iso(year, r.month, r.day))];
    }
    case 'nth-weekday': {
      const base = nthWeekday(year, r.month, r.weekday, r.nth);
      return base ? [one(addDays(base, r.plus ?? 0))] : [];
    }
    case 'easter': return [one(addDays(easterSunday(year), r.offset))];
    case 'month': return [{ date: iso(year, r.month, 1), end: iso(year, r.month, daysInMonth(year, r.month)) }];
    case 'dates': return (r.dates ?? []).filter((d) => d.date.startsWith(`${year}-`) || (d.end ?? d.date).startsWith(`${year}-`)).map((d) => ({ date: d.date, end: d.end ?? d.date, name: d.name, verify: d.verify }));
    default: return [];
  }
}

const matchesRegion = (o, regions) => !regions?.length || o.regions.includes('AU') || o.regions.some((r) => regions.includes(r));

/**
 * Occasions that overlap the dates from..to (inclusive ISO dates), earliest first.
 * Options: regions (['VIC'] keeps national entries plus Victoria's), tags (any of), kinds (any of), minRelevance
 * ('high'|'medium'|'low'), data (a different occasions file already loaded).
 * Each result: { id, occasion, name, date, end, kind, regions, tags, relevance, confidence, verify, advice, runUpDays,
 *                note?, caution?, source? }  (id is unique: "<occasion>-<date>").
 */
export function occasionsBetween(from, to, { regions, tags, kinds, minRelevance, data } = {}) {
  if (!isDate(from) || !isDate(to)) throw new Error('occasionsBetween needs two ISO dates');
  const lib = data ?? loadOccasions();
  const out = [];
  const y0 = Number(from.slice(0, 4)), y1 = Number(to.slice(0, 4));
  for (const o of lib.occasions) {
    if (!matchesRegion(o, regions)) continue;
    if (tags?.length && !tags.some((t) => o.tags.includes(t))) continue;
    if (kinds?.length && !kinds.includes(o.kind)) continue;
    if (minRelevance && RANK[o.relevance] < RANK[minRelevance]) continue;
    const seen = new Set();
    for (let y = y0 - 1; y <= y1; y++) {
      for (const inst of instancesOf(o, y)) {
        if (inst.end < from || inst.date > to) continue;
        const key = `${o.id}-${inst.date}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          id: key, occasion: o.id, name: inst.name ?? o.name, date: inst.date, end: inst.end, kind: o.kind, regions: o.regions, tags: o.tags,
          relevance: o.relevance, confidence: o.confidence, verify: inst.verify ?? o.verify, advice: o.advice, runUpDays: o.runUpDays ?? 7,
          ...(o.note ? { note: o.note } : {}), ...(o.caution ? { caution: o.caution } : {}), ...(o.source ? { source: o.source } : {}),
        });
      }
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
}

const norm = (s) => String(s).toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Find the library entry a free-text occasion ("Melbourne Cup", "EOFY") refers to. Returns the occasion rule entry or null.
 * Matches the id, the name or an alias, whole phrase, ignoring case and punctuation.
 */
export function findOccasion(text, { data } = {}) {
  if (!text) return null;
  const want = norm(text);
  if (!want) return null;
  const lib = data ?? loadOccasions();
  let best = null;
  for (const o of lib.occasions) {
    const names = [o.id.replace(/-/g, ' '), o.name, ...(o.aliases ?? [])].map(norm);
    for (const n of names) {
      if (!n) continue;
      if (want === n) return o;
      if (want.includes(n) || n.includes(want)) { if (!best || n.length > best.len) best = { o, len: n.length }; }
    }
  }
  return best && best.len >= 4 ? best.o : null;
}

/**
 * How a post date sits against an occasion: the nearest instance of that occasion's rule to `date`.
 * Returns { instance, daysBefore } (daysBefore > 0 = the post comes before the occasion) or null.
 */
export function nearestInstance(o, date, { data } = {}) {
  const y = Number(date.slice(0, 4));
  const lib = data ?? loadOccasions();
  const entry = typeof o === 'string' ? lib.occasions.find((x) => x.id === o) : o;
  if (!entry) return null;
  const all = [y - 1, y, y + 1].flatMap((yr) => instancesOf(entry, yr));
  let best = null;
  for (const inst of all) {
    const before = diffDays(date, inst.date);       // > 0: the post is before the occasion starts
    const after = diffDays(inst.end, date);         // > 0: the post is after it ended
    const gap = before > 0 ? before : after > 0 ? -after : 0;
    if (!best || Math.abs(gap) < Math.abs(best.daysBefore)) best = { instance: { ...inst, name: inst.name ?? entry.name, verify: inst.verify ?? entry.verify }, daysBefore: gap };
  }
  return best;
}
