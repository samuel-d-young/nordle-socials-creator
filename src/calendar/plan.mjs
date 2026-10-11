// Planning arithmetic for the content calendar: how many posts a month should have, where the free days are, and whether
// an idea is any good (not a repeat, not in the past, nothing the brand bans, nothing a health regulator would object to).
// Pure functions over plain data: no files, no clock (callers pass `today`).

import { addDays, diffDays, daysInMonth, isDate, iso, monthOf, monthEnd, monthStart, monthsBetween, weekday, todayIn } from './dates.mjs';
import { findOccasion, nearestInstance, occasionsBetween } from './occasions.mjs';

export const FORMATS = ['reel', 'carousel', 'post', 'story'];
export const DEFAULT_PER_MONTH = { reel: 8, carousel: 3, post: 2 };
export const DEFAULT_POST_TIMES = ['12:00'];
export const DEFAULT_LEAD_DAYS = 7;
export const DEFAULT_WEEKDAYS = [1, 2, 3, 4, 5];

const live = (it) => it.status !== 'rejected';
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

export function normaliseQuota(q = DEFAULT_PER_MONTH) {
  const out = {};
  for (const f of FORMATS) out[f] = Number.isInteger(q[f]) && q[f] > 0 ? q[f] : 0;
  return out;
}
/** The calendar's monthly quota per format: its own settings.perMonth, else 8 reels + 3 carousels + 2 posts = 13. */
export const quotaOf = (cal) => normaliseQuota(cal?.settings?.perMonth ?? DEFAULT_PER_MONTH);
export const quotaTotal = (quota) => sum(Object.values(quota));

/** Counts for one month ('YYYY-MM'), not counting rejected ideas. */
export function monthCounts(items, month) {
  const counts = Object.fromEntries(FORMATS.map((f) => [f, 0]));
  const byStatus = {}, byPillar = {};
  let total = 0;
  for (const it of items) {
    if (!live(it) || monthOf(it.date) !== month) continue;
    total++;
    counts[it.format] = (counts[it.format] ?? 0) + 1;
    byStatus[it.status] = (byStatus[it.status] ?? 0) + 1;
    byPillar[it.pillar ?? ''] = (byPillar[it.pillar ?? ''] ?? 0) + 1;
  }
  return { counts, byStatus, byPillar, total };
}

/**
 * How many more of each format a month needs. Reels are counted on their own; the other formats share one pool, so a
 * month with five carousels and no single posts has all of its "5 others" and needs nothing more there.
 */
export function needFor(quota, counts) {
  const need = { reel: Math.max(0, quota.reel - counts.reel), carousel: 0, post: 0, story: 0 };
  const others = ['carousel', 'post', 'story'];
  let otherNeed = Math.max(0, sum(others.map((f) => quota[f])) - sum(others.map((f) => counts[f] ?? 0)));
  const deficit = Object.fromEntries(others.map((f) => [f, Math.max(0, quota[f] - (counts[f] ?? 0))]));
  while (otherNeed > 0) {
    const f = [...others].sort((a, b) => deficit[b] - deficit[a] || quota[b] - quota[a])[0];
    if (deficit[f] <= 0) break;
    need[f]++; deficit[f]--; otherNeed--;
  }
  return need;
}

/**
 * A month against its quota. Stable shape (the Studio reads it):
 * { month, quota:{reel,carousel,post,story}, quotaTotal, total, counts:{...}, byStatus:{...}, missing:{...}, missingTotal,
 *   over:{reel,others}, ok, pillars:[{id,name,share,target,actual,drift,state:'under'|'ok'|'over'}], unassigned }
 * With no month, answers for every month from the first to the last item: an array of those reports.
 */
export function monthReport(cal, month) {
  if (month === undefined) {
    const months = [...new Set((cal.items ?? []).map((i) => monthOf(i.date)))].sort();
    return months.length ? monthsBetween(`${months[0]}-01`, `${months.at(-1)}-01`).map((m) => monthReport(cal, m)) : [];
  }
  const quota = quotaOf(cal);
  const { counts, byStatus, byPillar, total } = monthCounts(cal.items ?? [], month);
  const missing = needFor(quota, counts);
  const missingTotal = sum(Object.values(missing));
  const others = ['carousel', 'post', 'story'];
  const qTotal = quotaTotal(quota);
  const pillars = (cal.settings?.pillars ?? []).map((p) => {
    const target = Math.round((p.share ?? 0) * qTotal * 10) / 10;
    const actual = byPillar[p.id] ?? 0;
    const state = actual - target > 1.5 ? 'over' : target - actual > 1.5 ? 'under' : 'ok';
    return { id: p.id, name: p.name, share: p.share ?? null, target, actual, drift: total ? Math.round((actual / total - (p.share ?? 0)) * 100) / 100 : 0, state };
  });
  const known = new Set((cal.settings?.pillars ?? []).map((p) => p.id));
  const unassigned = known.size ? sum(Object.entries(byPillar).filter(([id]) => !known.has(id)).map(([, n]) => n)) : 0;
  return {
    month, quota, quotaTotal: qTotal, total, counts, byStatus, missing, missingTotal,
    over: { reel: Math.max(0, counts.reel - quota.reel), others: Math.max(0, sum(others.map((f) => counts[f])) - sum(others.map((f) => quota[f]))) },
    ok: missingTotal === 0, pillars, unassigned,
  };
}

// ---- slots -------------------------------------------------------------------------------------------------------------

const dateOf = (d) => (typeof d === 'string' ? d : d?.date);

/**
 * Free, evenly spread slots that would bring a month up to its quota: [{ date, time, format }], earliest first.
 *  - existing items count toward the quota, occupy their day, and are respected when choosing formats
 *  - at most one post a day while there are enough free days (weekdays first, then other days, then a second post on a day)
 *  - the same format is kept off back-to-back days where it can be (reels are the majority, so no more than two in a row)
 *  - avoidDates (public holidays, closures) are used only as a last resort
 */
export function spreadSlots(month, { perMonth = DEFAULT_PER_MONTH, weekdays = DEFAULT_WEEKDAYS, postTimes = DEFAULT_POST_TIMES, avoidDates = [], existing = [] } = {}) {
  const quota = normaliseQuota(perMonth);
  const mine = existing.filter((it) => live(it) && monthOf(it.date) === month);
  const need = needFor(quota, monthCounts(existing, month).counts);
  const n = sum(Object.values(need));
  if (!n) return [];

  const dim = daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)));
  const dayOf = (date) => Number(date.slice(8, 10));
  const dateAt = (day) => iso(Number(month.slice(0, 4)), Number(month.slice(5, 7)), day);
  const occupied = new Map();
  for (const it of mine) occupied.set(dayOf(it.date), (occupied.get(dayOf(it.date)) ?? 0) + 1);
  const avoid = new Set(avoidDates.map(dateOf).filter(Boolean).filter((d) => monthOf(d) === month).map(dayOf));
  const wanted = new Set(weekdays);

  const days = Array.from({ length: dim }, (_, i) => i + 1);
  const isWanted = (d) => wanted.has(weekday(dateAt(d)));
  const tiers = [
    days.filter((d) => !avoid.has(d) && !occupied.has(d) && isWanted(d)),
    days.filter((d) => !avoid.has(d) && !occupied.has(d) && !isWanted(d)),
    days.filter((d) => !avoid.has(d) && occupied.get(d) === 1 && isWanted(d)),
    days.filter((d) => !avoid.has(d) && occupied.get(d) === 1 && !isWanted(d)),
    days.filter((d) => avoid.has(d) && !occupied.has(d)),
  ];

  const points = [0, dim + 1, ...occupied.keys()];
  const chosen = [];
  const pickFrom = (pool, count) => {
    const left = new Set(pool);
    let got = 0;
    while (got < count && left.size) {
      let best = null;
      for (const d of [...left].sort((a, b) => a - b)) {
        const dist = Math.min(...points.map((p) => Math.abs(p - d)));
        if (!best || dist > best.dist) best = { d, dist };
      }
      left.delete(best.d); points.push(best.d); chosen.push(best.d); got++;
    }
    return got;
  };
  let remaining = n;
  for (const tier of tiers) { if (remaining <= 0) break; remaining -= pickFrom(tier, remaining); }
  // still short (a month full of closures): double up on the days already chosen
  for (let i = 0; remaining > 0 && chosen.length; i++, remaining--) chosen.push(chosen[i % chosen.length]);
  chosen.sort((a, b) => a - b);

  // ---- which format goes on which day ----
  const formats = smoothOrder(need, chosen.length);
  const slots = chosen.map((d, i) => ({ date: dateAt(d), format: formats[i] }));
  const context = existing.filter((it) => live(it) && it.date >= addDays(monthStart(month), -14) && it.date <= addDays(monthEnd(month), 14)).map((it) => ({ date: it.date, format: it.format, fixed: true }));
  optimiseFormats(slots, context);

  const times = postTimes.length ? postTimes : DEFAULT_POST_TIMES;
  const usedTimes = new Map();
  return slots.map((s, i) => {
    const taken = usedTimes.get(s.date) ?? new Set();
    let time = times[i % times.length];
    for (let k = 0; taken.has(time) && k < times.length; k++) time = times[(i + k + 1) % times.length];
    taken.add(time); usedTimes.set(s.date, taken);
    return { date: s.date, time, format: s.format };
  });
}

/** Smooth weighted round-robin: spreads the formats through the sequence in proportion to how many of each are needed. */
function smoothOrder(need, count) {
  const w = Object.entries(need).filter(([, c]) => c > 0).map(([f, c]) => ({ f, w: c, cw: 0 }));
  const total = sum(w.map((x) => x.w));
  const out = [];
  for (let i = 0; i < count && total; i++) {
    for (const x of w) x.cw += x.w;
    const top = w.reduce((a, b) => (b.cw > a.cw ? b : a));
    top.cw -= total;
    out.push(top.f);
  }
  return out;
}

function sequenceCost(seq) {
  let cost = 0, run = 1;
  for (let i = 1; i < seq.length; i++) {
    if (seq[i].format === seq[i - 1].format) {
      cost += seq[i].format === 'reel' ? 4 : 12;
      run++;
      if (seq[i].format === 'reel' && run >= 3) cost += 30;
    } else run = 1;
  }
  for (const f of FORMATS) {
    const at = seq.map((s, i) => (s.format === f ? i : -1)).filter((i) => i >= 0);
    if (at.length < 3) continue;
    const gaps = at.slice(1).map((v, i) => v - at[i]);
    const mean = sum(gaps) / gaps.length;
    cost += sum(gaps.map((g) => (g - mean) ** 2));
  }
  return cost;
}

function optimiseFormats(slots, context) {
  const timeline = () => [...context.map((c) => ({ ...c, order: 0 })), ...slots.map((s) => ({ ...s, order: 1 }))].sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order);
  let best = sequenceCost(timeline());
  for (let pass = 0; pass < 40; pass++) {
    let improved = false;
    for (let i = 0; i < slots.length; i++) {
      for (let j = i + 1; j < slots.length; j++) {
        if (slots[i].format === slots[j].format) continue;
        [slots[i].format, slots[j].format] = [slots[j].format, slots[i].format];
        const c = sequenceCost(timeline());
        if (c < best - 1e-9) { best = c; improved = true; } else [slots[i].format, slots[j].format] = [slots[j].format, slots[i].format];
      }
    }
    if (!improved) break;
  }
}

// ---- idea lint ---------------------------------------------------------------------------------------------------------

const STOP = new Set('a an the and or of to in on for with your you our we is are it its this that these those how why what when where who at by from as be can do does not no if but about so up out more most get have has will just all any into than then there their they them i my me us one two three new best'.split(' '));
const stem = (w) => (w.length > 5 && w.endsWith('ing') ? w.slice(0, -3) : w.length > 4 && w.endsWith('ed') ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
export const tokens = (text) => new Set(String(text ?? '').toLowerCase().replace(/[’']/g, '').split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)).map(stem));
export function similarity(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}
const norm = (s) => String(s ?? '').toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9']+/g, ' ').trim();

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A phrase as a whole-word, case-insensitive pattern (so "cure" does not hit "secure"). */
const phraseRe = (p) => new RegExp(`(?<![A-Za-z0-9])${esc(p.trim()).replace(/\s+/g, '\\s+')}(?![A-Za-z0-9])`, 'i');

/** Is the match at `index` being negated or quoted ("no results", "never say 'same day'", '"free" is banned')? */
function negated(text, index) {
  const before = text.slice(Math.max(0, index - 60), index);
  const sentence = before.split(/[.;!?\n]/).at(-1);
  if (/(?:^|[\s(])["“‘']$/.test(before.slice(-3))) return true;                                   // right after an opening quote
  return /\b(?:no|not|never|avoid(?:ing|s)?|without|don'?t|do not|doesn'?t|nor|neither|banned|ban|bans|forbidden|must not|mustn'?t|steer clear)\b/i.test(sentence);
}
/** The first match of re in text; with skipNegated, matches that are negated or quoted do not count. */
function firstHit(re, text, skipNegated) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  for (const m of text.matchAll(g)) if (!skipNegated || !negated(text, m.index)) return m;
  return null;
}

export const DEFAULT_RISK_WORDS = ['implant', 'veneer', 'cosmetic', 'smile makeover', 'aligner', 'whitening', 'all-on'];

/**
 * Words and phrases a brand bans: its voice.bannedPhrases, anything in quotes in its voice.dont list, and (when facts.json is given)
 * its bannedClaims.
 */
export function bannedPhrasesOf(brand, facts) {
  const out = new Set([...(brand?.voice?.bannedPhrases ?? []), ...(facts?.bannedClaims ?? [])].map((p) => String(p).trim()).filter(Boolean));
  for (const line of brand?.voice?.dont ?? []) {
    for (const m of String(line).matchAll(/["“”]([^"“”]{3,60})["“”]|(?:^|[\s(:,])['‘]([^'’]{3,60})['’](?=$|[\s).,;:!?])/g)) out.add((m[1] ?? m[2]).trim());
  }
  return [...out];
}

export function isRegulated(brand, cal) {
  if ((cal?.settings?.compliance ?? []).some((c) => /ahpra|health|medical/i.test(c))) return true;
  return /dental|dentist|orthodon|clinic|medical|physio|chiropract|optom|podiatr|psycholog|surgery/i.test(JSON.stringify([brand?.name, brand?.note, brand?.voice?.audience]));
}

// Health advertising in Australia (AHPRA / National Law s133). Errors are things an idea should never plan; warnings are
// words that are usually a problem and need a second look.
const HEALTH_ERRORS = [
  [/(?<![A-Za-z])before\s*(?:and|&|\/|\+|then)\s*after(?![A-Za-z])/i, 'before-and-after content is not allowed in health advertising'],
  [/(?<![A-Za-z])testimonials?(?![A-Za-z])/i, 'testimonials cannot be used in health advertising'],
  [/(?<![A-Za-z])(?:patient|client|customer|google|facebook)\s+(?:reviews?|ratings?)(?![A-Za-z])|(?<![A-Za-z])(?:five|5)[ -]?stars?(?![A-Za-z])/i, 'reviews and ratings cannot be used in health advertising'],
  [/(?<![A-Za-z])guarantee(?:d|s)?(?![A-Za-z])/i, '"guarantee" promises an outcome'],
  [/(?<![A-Za-z])pain[ -]?(?:less|free)(?![A-Za-z])/i, '"painless" and "pain-free" are unreasonable-expectation claims'],
  [/(?<![A-Za-z])cure[ds]?(?![A-Za-z])/i, '"cure" promises a result'],
  [/(?<![A-Za-z])(?:no|zero)[ -]risk(?![A-Za-z])(?!\s+(?:line|wording|text|statement|warning|disclaimer))|(?<![A-Za-z])risk[ -]free(?![A-Za-z])/i, '"no risk" is a claim a health advertiser cannot make'],
  [/(?<![A-Za-z])miracle(?![A-Za-z])/i, '"miracle" creates unreasonable expectations'],
];
const HEALTH_WARNINGS = [
  [/(?<![A-Za-z])best(?![A-Za-z])/i, '"best" is a superlative claim; it is fine for general tips ("best way to floss" is still a claim), not for the practice or its results'],
  [/(?<![A-Za-z])(?:safe|safest|safely)(?![A-Za-z])/i, '"safe" can read as a guarantee when it is about a treatment'],
  [/(?<![A-Za-z])(?:number one|no\.? ?1|#1|top[- ]rated|leading)(?![A-Za-z])/i, 'ranking claims need evidence the practice can show'],
  [/(?<![A-Za-z])free(?![A-Za-z])|(?<![A-Za-z])discount(?:s|ed)?(?![A-Za-z])|\b\d+\s*%\s*off\b|(?<![A-Za-z])special offer(?![A-Za-z])|(?<![A-Za-z])limited[ -]time(?![A-Za-z])|(?<![A-Za-z])give[ -]?aways?(?![A-Za-z])|(?<![A-Za-z])competition(?![A-Za-z])/i, 'offers and giveaways are inducements: they need their full conditions and no pressure'],
];

const TEXT_FIELDS = ['title', 'idea', 'hook', 'mediaPlan', 'audience', 'occasion', 'notes'];
const textOf = (item) => TEXT_FIELDS.map((k) => item[k]).filter(Boolean).join('\n');

const err = (rule, message, extra = {}) => ({ rule, level: 'error', message, ...extra });
const warn = (rule, message, extra = {}) => ({ rule, level: 'warn', message, ...extra });

function numbersIn(raw) {
  const found = [];
  const text = raw.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ');   // calendar dates are not figures
  for (const re of [/\$\s?\d[\d,]*(?:\.\d+)?/g, /\b\d+(?:\.\d+)?\s?%/g, /\b\d[\d\s-]{7,}\d\b/g, /\b\d{1,5}\+?\s+(?:years?|patients?|clients?|smiles?|reviews?|stars?|awards?)\b/gi]) {
    for (const m of text.matchAll(re)) found.push(m[0]);
  }
  return found;
}
const digits = (s) => String(s).replace(/\D/g, '');

/**
 * Is this idea any good? Returns { ok, errors:[{rule,level,message}], warnings:[...] }. ok = no errors.
 * ctx: { brand, facts, existing (other calendar items), today, cal (settings, pillars, quota), strict, checkQuota, regions, occasions }
 * strict is for ideas Claude proposes: a missing idea, hook or pillar is an error rather than a warning.
 * Errors: a past date, a bad date, a banned phrase, a repeat of an angle or hook, a health-advertising no-go, an unknown pillar
 * (when pillars are defined), a month already at its quota (checkQuota).
 */
export function ideaLint(item, ctx = {}) {
  const { brand, facts, existing = [], today, cal, strict = false, checkQuota = false, regions } = ctx;
  const errors = [], warnings = [];
  const missing = (rule, what) => (strict ? errors : warnings).push((strict ? err : warn)(rule, `The idea has no ${what}.`));

  if (!isDate(item.date)) { errors.push(err('bad-date', `"${item.date}" is not a real date (use YYYY-MM-DD).`)); return { ok: false, errors, warnings }; }
  if (today && ['idea', 'approved'].includes(item.status ?? 'idea') && item.date < today) errors.push(err('past-date', `${item.date} is already in the past (today is ${today}).`));
  if (!item.idea) missing('no-idea', 'description (what it says and why this audience cares)');
  if (!item.hook) missing('no-hook', 'hook (the first line or first second)');
  const pillars = cal?.settings?.pillars ?? [];
  if (!item.pillar) { if (pillars.length) missing('no-pillar', 'pillar'); }
  else if (pillars.length && !pillars.some((p) => p.id === item.pillar)) errors.push(err('unknown-pillar', `Pillar "${item.pillar}" is not one of: ${pillars.map((p) => p.id).join(', ')}.`));

  // Words. The title and hook are what the public sees, so a banned phrase there is an error. The description, media plan and
  // notes only describe the post, and often say what to avoid ("no results", "'same day' is banned wording"), so a phrase there
  // is a warning, and only when it is not being negated or quoted.
  const text = textOf(item);
  const shown = [item.title, item.hook].filter(Boolean).join('\n');
  const described = [item.idea, item.mediaPlan, item.audience, item.occasion, item.notes].filter(Boolean).join('\n');
  for (const phrase of bannedPhrasesOf(brand, facts)) {
    const re = phraseRe(phrase);
    if (firstHit(re, shown, false)) errors.push(err('banned-phrase', `Contains "${phrase}", which this brand's voice rules ban.`, { phrase }));
    else if (firstHit(re, described, true)) warnings.push(warn('banned-phrase-described', `The description uses "${phrase}", which this brand bans. Fine as a note; make sure it never reaches the post.`, { phrase }));
  }

  if (isRegulated(brand, cal)) {
    for (const [re, why] of HEALTH_ERRORS) if (firstHit(re, `${shown}\n${described}`, true)) errors.push(err('health-advertising', `${why}.`));
    for (const [re, why] of HEALTH_WARNINGS) { const m = firstHit(re, `${shown}\n${described}`, true); if (m) warnings.push(warn('health-advertising-word', `"${m[0].trim()}": ${why}.`)); }
    const rs = facts?.riskStatement;
    if (rs?.text && (rs.appliesTo?.length ? rs.appliesTo : DEFAULT_RISK_WORDS).some((w) => new RegExp(`(?<![A-Za-z])${esc(w)}`, 'i').test(text)) && !/\brisk/i.test(described)) {
      warnings.push(warn('risk-statement', 'This post needs the practice\'s general risk wording (facts.json riskStatement). Say in the media plan or notes where it goes.'));
    }
    if (/implant/i.test(text) && firstHit(/\b\d+\s*(?:-|to)?\s*\d*\s*(?:weeks?|months?)\b/i, text, true)) errors.push(err('implant-timeframe', 'Do not state implant healing or treatment time periods.'));
    if (/\b(?:patient|patients|child|children|kid|kids|baby|toddler)s?\b/i.test(item.mediaPlan ?? '') && !/\bno (?:identifiable )?(?:patients?|children)/i.test(item.mediaPlan ?? '')) {
      warnings.push(warn('identifiable-people', 'The media plan mentions patients or children: use staff, rooms, equipment and exteriors only, with no identifiable patients and no children\'s faces.'));
    }
  }

  // facts: figures that nobody gave us
  const haystack = digits(JSON.stringify(facts ?? {}));
  for (const n of numbersIn([item.title, item.hook, item.idea].filter(Boolean).join('\n'))) {
    const d = digits(n);
    if (d && !haystack.includes(d)) warnings.push(warn('unsourced-number', `"${n.trim()}" is not in the practice's facts. Leave figures out unless they are sourced.`));
  }

  // repeats
  const others = existing.filter((o) => o.id !== item.id && live(o));
  const mine = `${item.title ?? ''}\n${item.idea ?? ''}`;
  for (const o of others) {
    if (item.hook && o.hook && norm(item.hook) === norm(o.hook)) { errors.push(err('same-hook', `The hook is identical to the one on "${o.title}" (${o.date}).`, { other: o.id })); continue; }
    const apart = Math.abs(diffDays(o.date, item.date));
    const s = similarity(mine, `${o.title ?? ''}\n${o.idea ?? ''}`);
    const rounded = Math.round(s * 100) / 100;
    // the same title is fine for a series ("Meet the team", one person each time) as long as what it says is different
    if (item.title && o.title && norm(item.title) === norm(o.title) && apart <= 365) {
      if (s >= 0.5) errors.push(err('duplicate-angle', `Same title and same angle as "${o.title}" (${o.date}).`, { other: o.id, similarity: rounded }));
      else warnings.push(warn('same-title', `Same title as "${o.title}" (${o.date}): fine for a series, if what it says is different.`, { other: o.id }));
      continue;
    }
    if (apart > 90) continue;
    if (s >= 0.5) errors.push(err('duplicate-angle', `Too close to "${o.title}" on ${o.date} (the same angle within 90 days).`, { other: o.id, similarity: rounded }));
    else if (s >= 0.34) warnings.push(warn('similar-angle', `Similar to "${o.title}" on ${o.date}; make sure it says something new.`, { other: o.id, similarity: rounded }));
  }

  // rhythm, quota and balance matter while an item can still be moved; a post that is already built is not worth nagging about
  const open = ['idea', 'approved', 'changes'].includes(item.status ?? 'idea');
  const sameDay = open ? others.filter((o) => o.date === item.date) : [];
  if (sameDay.length) warnings.push(warn('crowded-day', `${sameDay.length === 1 ? 'Another post is' : `${sameDay.length} other posts are`} already planned for ${item.date}.`));
  if (open && item.format && item.format !== 'reel') {
    const near = others.filter((o) => o.format === item.format && Math.abs(diffDays(o.date, item.date)) === 1);
    if (near.length) warnings.push(warn('format-streak', `Another ${item.format} is planned the ${near[0].date < item.date ? 'day before' : 'day after'}.`));
  }

  // quota and pillar balance
  if (open && cal && item.date && item.format) {
    const month = monthOf(item.date);
    const quota = quotaOf(cal);
    const items = [...others, { ...item, status: item.status ?? 'idea' }];
    const { counts } = monthCounts(items, month);
    const nonReel = (c) => sum(['carousel', 'post', 'story'].map((f) => c[f] ?? 0));
    const nonReelQuota = sum(['carousel', 'post', 'story'].map((f) => quota[f]));
    const over = item.format === 'reel' ? counts.reel > quota.reel : nonReel(counts) > nonReelQuota;
    if (over) {
      const msg = `${month} already has its ${item.format === 'reel' ? `${quota.reel} reels` : `${nonReelQuota} other posts`}.`;
      (checkQuota ? errors : warnings).push((checkQuota ? err : warn)('over-quota', msg));
    }
    if (pillars.length && item.pillar) {
      const p = pillars.find((x) => x.id === item.pillar);
      if (p) {
        const actual = items.filter((o) => live(o) && monthOf(o.date) === month && o.pillar === p.id).length;
        const target = (p.share ?? 0) * quotaTotal(quota);
        if (actual - target > 1.5) warnings.push(warn('pillar-drift', `${month} would have ${actual} "${p.name ?? p.id}" posts against a target of about ${Math.round(target * 10) / 10}.`));
      }
    }
  }

  // occasions
  if (item.occasion && item.occasion.trim().split(/\s+/).length <= 7) {          // a longer text is a note, not a name
    const o = findOccasion(item.occasion);
    if (!o) warnings.push(warn('unknown-occasion', `"${item.occasion}" is not in the Australian occasions library: make sure it is real and say where the date comes from.`));
    else {
      const near = nearestInstance(o, item.date);
      if (near) {
        const run = o.runUpDays ?? 7;
        const { daysBefore, instance } = near;
        if (daysBefore > run) warnings.push(warn('occasion-too-early', `${item.date} is ${daysBefore} days before ${instance.name} (${instance.date}); posts usually run ${run} days ahead or less.`));
        else if (daysBefore < -2) warnings.push(warn('occasion-passed', `${instance.name} ended on ${instance.end}; this post comes ${-daysBefore} days after it.`));
      }
      if (o.verify) warnings.push(warn('verify-date', `${o.name}: the date is approximate or set each year. Confirm it from ${o.source ?? 'the organiser'} before the post states it.`));
      if (o.advice === 'respectful') warnings.push(warn('respectful-occasion', `${o.name} calls for a quiet, respectful tone: no promotion.${o.caution ? ` ${o.caution}` : ''}`));
      else if (o.advice === 'avoid-promo') warnings.push(warn('avoid-promo-occasion', `${o.name}: do not hang offers on it.${o.caution ? ` ${o.caution}` : ''}`));
      else if (o.caution) warnings.push(warn('occasion-caution', `${o.name}: ${o.caution}`));
    }
  }
  // a day most practices are closed
  {
    // with no regions set, only national holidays count: a Victorian holiday is not a reason to warn a Western Australian brand
    const closed = occasionsBetween(item.date, item.date, { regions: regions?.length ? regions : ['AU'], kinds: ['public-holiday'] }).filter((o) => o.advice === 'closed');
    if (closed.length) warnings.push(warn('public-holiday', `${item.date} is ${closed[0].name}${closed[0].verify ? ' (to be confirmed)' : ''}: most practices are closed, so do not promise bookings or replies that day.`));
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** ideaLint for every open item in a calendar: { itemId: { ok, errors, warnings } }. */
export function lintCalendar(cal, { brand, facts, today = todayIn(cal.timezone), regions } = {}) {
  const out = {};
  for (const it of cal.items) {
    if (!['idea', 'approved', 'changes', 'built'].includes(it.status)) continue;
    out[it.id] = ideaLint(it, { brand, facts, existing: cal.items, today: it.status === 'built' ? undefined : today, cal, regions: regions ?? cal.settings?.regions });
  }
  return out;
}
