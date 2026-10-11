// Turn a brand's numbers into insight, honestly.
//
//  - Every post gets a score from 0 to 100 that means "how this post did compared with this account's own other posts of the same
//    format": each number (reach, shares per reach, saves per reach ...) is turned into a percentile among the account's own
//    history, and the percentiles are averaged with weights that depend on the format. A small account and a large one compare fairly
//    because nobody is compared with anybody else. 50 is the account's typical post.
//  - Posts are grouped (pillar, format, hook type, weekday, time of day, face on the cover, reel length, caption length, music, series,
//    occasion or evergreen). Every group shows n. Under 5 posts is "directional only"; a difference is called "suggestive" or
//    "stronger" only with the counts and the size of the gap to back it. Nothing here says one thing caused another.
//  - Gaps are said out loud: posts without numbers, numbers taken too early for their window, posts we could not classify.
//
// reportFor(projectDir, period) -> a JSON report; reportMarkdown(report) -> the plain-language summary.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { addDays, diffDays } from '../calendar/dates.mjs';
import { loadProject } from '../calendar/service.mjs';
import { METRIC_KEYS, METRIC_LABELS, PerformanceError, WINDOWS, listReviews, loadMetrics } from './model.mjs';
import { currentPeriod, inPeriod, lastCompletePeriod, parsePeriod, previousPeriod } from './period.mjs';
import { captionLengthBucket, classifyHook, coverFace, hasMusic, reelLengthBucket, reelSeconds, seriesOf, timeBucket, weekdayLabel } from './features.mjs';

export const MIN_N = 5;
export const REPORT_SCHEMA = 'nordle.performance-report/0.1';
const MATURE_AFTER_DAYS = { '7d': 7, '28d': 28, lifetime: 7 };
const MIN_DENOMINATOR = 20;

// ---- small statistics --------------------------------------------------------------------------------------------------------

export const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round = (x, d = 1) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

/** Where a value sits among a sorted-or-not list that contains it: 0..1, ties count half. */
export function percentileRank(values, v) {
  if (!values.length) return null;
  let below = 0, equal = 0;
  for (const x of values) { if (x < v) below++; else if (x === v) equal++; }
  return (below + equal / 2) / values.length;
}

const erf = (x) => {   // Abramowitz and Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
};
/** Two-sided p-value of the Mann-Whitney U test (normal approximation with a tie correction). */
export function mannWhitneyP(a, b) {
  const n1 = a.length, n2 = b.length;
  if (!n1 || !n2) return 1;
  const all = [...a.map((v) => ({ v, g: 0 })), ...b.map((v) => ({ v, g: 1 }))].sort((x, y) => x.v - y.v);
  const ranks = new Array(all.length);
  let tie = 0;
  for (let i = 0; i < all.length;) {
    let j = i;
    while (j + 1 < all.length && all[j + 1].v === all[i].v) j++;
    for (let k = i; k <= j; k++) ranks[k] = (i + j) / 2 + 1;
    const t = j - i + 1;
    tie += t ** 3 - t;
    i = j + 1;
  }
  const r1 = all.reduce((s, x, i) => s + (x.g === 0 ? ranks[i] : 0), 0);
  const u1 = r1 - (n1 * (n1 + 1)) / 2;
  const N = n1 + n2;
  const sigma = Math.sqrt(((n1 * n2) / 12) * (N + 1 - tie / (N * (N - 1))));
  if (!sigma) return 1;
  const z = (Math.abs(u1 - (n1 * n2) / 2) - 0.5) / sigma;
  return Math.max(0, Math.min(1, 1 - erf(z / Math.SQRT2)));
}

// ---- how each format is scored ------------------------------------------------------------------------------------------------

const AUDIENCE_REEL = ['plays', 'views', 'reach'];
const AUDIENCE_OTHER = ['reach', 'views', 'impressions'];
const DENOMINATORS = ['reach', 'views', 'plays', 'impressions'];
/** Components per format. count/direct take the first number present; rate is "per reach" when a reach-like number is there. */
export const FORMULAS = {
  reel: [
    { id: 'audience', label: 'Plays', weight: 0.30, count: AUDIENCE_REEL },
    { id: 'watch', label: 'Watching to the end', weight: 0.25, direct: ['completionRate', 'avgWatchSec'] },
    { id: 'shares', label: 'Shares', weight: 0.25, rate: 'shares' },
    { id: 'saves', label: 'Saves', weight: 0.20, rate: 'saves' },
  ],
  carousel: [
    { id: 'saves', label: 'Saves', weight: 0.35, rate: 'saves' },
    { id: 'shares', label: 'Shares', weight: 0.25, rate: 'shares' },
    { id: 'audience', label: 'Reach', weight: 0.25, count: AUDIENCE_OTHER },
    { id: 'swipes', label: 'Swipes', weight: 0.15, rate: 'swipes' },
  ],
  post: [
    { id: 'audience', label: 'Reach', weight: 0.35, count: AUDIENCE_OTHER },
    { id: 'likes', label: 'Likes', weight: 0.35, rate: 'likes' },
    { id: 'comments', label: 'Comments', weight: 0.30, rate: 'comments' },
  ],
  story: [
    { id: 'audience', label: 'Reach', weight: 0.50, count: AUDIENCE_OTHER },
    { id: 'comments', label: 'Replies', weight: 0.25, rate: 'comments' },
    { id: 'shares', label: 'Shares', weight: 0.25, rate: 'shares' },
  ],
};

/** One component's number for one entry: { v, mode } or null. The mode says what kind of number it is, so only like is compared with like. */
export function componentValue(comp, m) {
  if (comp.count || comp.direct) {
    for (const k of comp.count ?? comp.direct) if (typeof m[k] === 'number') return { v: m[k], mode: `${comp.count ? 'count' : 'direct'}:${k}` };
    return null;
  }
  const num = m[comp.rate];
  if (typeof num !== 'number') return null;
  for (const d of DENOMINATORS) if (typeof m[d] === 'number' && m[d] >= MIN_DENOMINATOR) return { v: (num / m[d]) * 1000, mode: `per1000:${d}` };
  return { v: num, mode: 'raw' };
}

// ---- loading the facts -------------------------------------------------------------------------------------------------------

const readJson = (file) => { try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null; } catch { return null; } };

function localTime(publishedAt) {
  const m = /T(\d{2}:\d{2})/.exec(String(publishedAt ?? ''));
  return m ? m[1] : null;
}

/** Every observation (a post on a platform, in one window) joined with what we know about the post, scored against the account's own history. */
export function buildRows(projectDir, { window = '7d', platform, today } = {}) {
  const dir = resolve(projectDir);
  const p = loadProject(dir);
  const day = today ?? p.today;
  const metrics = loadMetrics(dir, p.brand.id ?? p.id);
  const itemsById = new Map(p.cal.items.map((i) => [i.id, i]));
  const catalogCache = {};

  // one entry per (post, platform): the preferred window if it has settled, else the first window that has
  const groups = new Map();
  for (const e of metrics.items) {
    if (platform && platform !== 'all' && e.platform !== platform) continue;
    if (!itemsById.has(e.post)) continue;
    const k = `${e.post}|${e.platform}`;
    (groups.get(k) ?? groups.set(k, []).get(k)).push(e);
  }
  const rows = [];
  for (const entries of groups.values()) {
    const item = itemsById.get(entries[0].post);
    const order = [window, ...WINDOWS.filter((w) => w !== window)];
    const sorted = [...entries].sort((a, b) => order.indexOf(a.window) - order.indexOf(b.window));
    const dateOf = (e) => (e.publishedAt ?? item.date).slice(0, 10);
    const settled = (e) => diffDays(dateOf(e), e.capturedAt.slice(0, 10)) >= MATURE_AFTER_DAYS[e.window];
    const e = sorted.find(settled) ?? sorted[0];
    const published = dateOf(e);
    const daysAfter = diffDays(published, e.capturedAt.slice(0, 10));
    const doc = item.doc ? readJson(join(dir, 'docs', `${item.doc}.json`)) : null;
    const caption = doc?.copy?.caption ?? item.external?.caption ?? '';
    const hookText = item.hook || String(caption).split('\n').find((l) => l.trim()) || item.title;
    const hook = classifyHook(hookText);
    const face = coverFace(dir, doc, item, catalogCache);
    const time = localTime(e.publishedAt) ?? item.time ?? null;
    const series = seriesOf(item, doc);
    rows.push({
      id: item.id, platform: e.platform, date: published, time, status: item.status, format: item.format, pillar: item.pillar ?? null, title: item.title,
      hook: hookText, hookType: hook.type, hookRule: hook.rule,
      hasFace: face.face, faceMedia: face.media,
      reelLength: item.format === 'reel' ? reelLengthBucket(reelSeconds(doc)) : null, reelSeconds: item.format === 'reel' ? reelSeconds(doc) : null,
      captionLength: captionLengthBucket(caption), captionChars: String(caption).trim().length || null,
      music: item.format === 'reel' ? hasMusic(doc) : null,
      series: series ?? 'standalone', occasion: item.occasion ? 'occasion' : 'evergreen',
      weekday: weekdayLabel(published), timeOfDay: timeBucket(time),
      doc: item.doc ?? null, window: e.window, windowWanted: window, capturedAt: e.capturedAt.slice(0, 10), daysAfter,
      mature: settled(e), metrics: e.metrics, by: e.by ?? null, source: e.source, note: e.note ?? null,
      score: null, scoreBasis: null, headline: null,
    });
  }

  // baselines: all settled observations of the same platform, format and window, by component and kind of number
  const base = new Map();
  const bkey = (r, comp, mode) => `${r.platform}|${r.format}|${r.window}|${comp.id}|${mode}`;
  for (const r of rows) {
    if (!r.mature) continue;
    for (const comp of FORMULAS[r.format] ?? []) {
      const val = componentValue(comp, r.metrics);
      if (!val) continue;
      const k = bkey(r, comp, val.mode);
      (base.get(k) ?? base.set(k, []).get(k)).push(val.v);
    }
  }
  for (const r of rows) {
    const comps = FORMULAS[r.format] ?? [];
    const totalW = comps.reduce((s, c) => s + c.weight, 0);
    const parts = [];
    for (const comp of comps) {
      const val = componentValue(comp, r.metrics);
      if (!val) continue;
      const pool = base.get(bkey(r, comp, val.mode)) ?? [];
      const n = pool.length;
      const pct = r.mature && n ? percentileRank(pool, val.v) : null;
      parts.push({ id: comp.id, label: comp.label, mode: val.mode, value: round(val.v, 2), weight: comp.weight, n, median: round(median(pool), 2), pct: pct === null ? null : round(pct, 3) });
    }
    const used = parts.filter((x) => x.pct !== null);
    const w = used.reduce((s, x) => s + x.weight, 0);
    const coverage = totalW ? w / totalW : 0;
    const audience = parts.find((x) => x.id === 'audience');
    r.headline = audience ? { label: audience.label, value: audience.value, median: audience.median, ratio: audience.median ? round(audience.value / audience.median, 2) : null } : null;
    if (r.mature && used.length && coverage >= 0.5) {
      const baselineN = Math.min(...used.map((x) => x.n));
      r.score = round((used.reduce((s, x) => s + x.pct * x.weight, 0) / w) * 100, 1);
      r.scoreBasis = { baselineN, lowBaseline: baselineN < MIN_N, coverage: round(coverage, 2), parts };
    } else {
      r.scoreBasis = { baselineN: 0, lowBaseline: true, coverage: round(coverage, 2), parts, reason: !r.mature ? `taken ${r.daysAfter} days after publishing; the ${r.window} window needs ${MATURE_AFTER_DAYS[r.window]}` : parts.length ? 'too few of the numbers this format is judged on' : 'no numbers this format is judged on' };
    }
  }
  return { rows, project: p, today: day };
}

// ---- segments ----------------------------------------------------------------------------------------------------------------

export const DIMENSIONS = [
  { id: 'pillar', label: 'Pillar', of: (r) => r.pillar ?? '(no pillar)' },
  { id: 'format', label: 'Format', of: (r) => r.format },
  { id: 'hookType', label: 'Hook type', of: (r) => r.hookType },
  { id: 'weekday', label: 'Weekday', of: (r) => r.weekday },
  { id: 'timeOfDay', label: 'Time of day', of: (r) => r.timeOfDay },
  { id: 'face', label: 'Face on the cover', of: (r) => (r.hasFace === null ? null : r.hasFace ? 'a face on the cover' : 'no face on the cover') },
  { id: 'reelLength', label: 'Reel length', of: (r) => r.reelLength },
  { id: 'captionLength', label: 'Caption length', of: (r) => r.captionLength },
  { id: 'music', label: 'Music (reels)', of: (r) => (r.music === null ? null : r.music ? 'with music' : 'no music') },
  { id: 'series', label: 'Series', of: (r) => r.series },
  { id: 'occasion', label: 'Occasion or evergreen', of: (r) => r.occasion },
];

/** How firmly a group differs from the rest. Never causal: "suggestive" means "worth testing on purpose". */
export function evidenceFor(group, rest) {
  if (group.length < MIN_N || rest.length < MIN_N) return { level: 'directional', note: `directional only (n=${group.length}${rest.length < MIN_N ? `, and only ${rest.length} others` : ''})` };
  const gap = median(group) - median(rest);
  const p = mannWhitneyP(group, rest);
  if (group.length >= 10 && rest.length >= 10 && Math.abs(gap) >= 10 && p < 0.05) return { level: 'stronger', gap: round(gap), p: round(p, 3), note: 'a clear gap on enough posts, still not proof of cause' };
  if (Math.abs(gap) >= 8) return { level: 'suggestive', gap: round(gap), p: round(p, 3), note: 'a gap worth testing on purpose' };
  return { level: 'none', gap: round(gap), p: round(p, 3), note: 'no clear difference' };
}

export function segmentRows(rows) {
  const scored = rows.filter((r) => r.score !== null);
  const out = {};
  for (const dim of DIMENSIONS) {
    const buckets = new Map();
    let unknown = 0;
    for (const r of scored) {
      const key = dim.of(r);
      if (key === null || key === undefined) { unknown++; continue; }
      (buckets.get(key) ?? buckets.set(key, []).get(key)).push(r);
    }
    const groups = [...buckets.entries()].map(([key, rs]) => {
      const scores = rs.map((r) => r.score);
      const rest = scored.filter((r) => !rs.includes(r) && dim.of(r) !== null).map((r) => r.score);
      return { key, n: rs.length, median: round(median(scores)), mean: round(mean(scores)), lowBaseline: rs.some((r) => r.scoreBasis.lowBaseline), evidence: evidenceFor(scores, rest), posts: rs.map((r) => r.id) };
    }).sort((a, b) => b.median - a.median || b.n - a.n);
    out[dim.id] = { label: dim.label, groups, unknown, comparable: groups.length >= 2 };
  }
  return out;
}

// ---- the report --------------------------------------------------------------------------------------------------------------

const published = (it, today) => it.status === 'posted' || (['scheduled', 'signed-off'].includes(it.status) && it.date < today);

/**
 * The report for a period ('2026-11' or '2026-W45'; default the last complete month).
 * opts: window ('7d' default), platform ('all' default), today, kind ('week'|'month' when no period is given).
 */
export function reportFor(projectDir, period, opts = {}) {
  const dir = resolve(projectDir);
  const window = opts.window ?? '7d';
  if (!WINDOWS.includes(window)) throw new PerformanceError(400, `window must be one of ${WINDOWS.join(', ')}`);
  const { rows: all, project: p, today } = buildRows(dir, { window, platform: opts.platform, today: opts.today });
  const per = typeof period === 'string' && period ? parsePeriod(period) : lastCompletePeriod(today, opts.kind ?? 'month');
  if (!per) throw new PerformanceError(400, `"${period}" is not a period (use 2026-11 or 2026-W45).`);
  const prev = previousPeriod(per);

  const rows = all.filter((r) => inPeriod(r.date, per)).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const scored = rows.filter((r) => r.score !== null);
  const baselineScored = all.filter((r) => r.score !== null);
  const rank = [...scored].sort((a, b) => b.score - a.score);
  const top = rank.slice(0, 3);
  const bottom = rank.length >= 2 ? [...rank].reverse().filter((r) => !top.includes(r)).slice(0, 3) : [];
  rank.forEach((r, i) => { r.rank = i + 1; });

  // gaps
  const gaps = [];
  const items = p.cal.items.filter((i) => i.status !== 'rejected' && inPeriod(i.date, per));
  const withNumbers = new Set(rows.map((r) => r.id));
  const missing = items.filter((i) => published(i, today) && !withNumbers.has(i.id));
  if (missing.length) gaps.push({ kind: 'no-numbers', message: `${missing.length} published post${missing.length > 1 ? 's have' : ' has'} no numbers yet: ${missing.slice(0, 8).map((i) => i.id).join(', ')}${missing.length > 8 ? ' ...' : ''}`, posts: missing.map((i) => i.id) });
  const notYet = items.filter((i) => i.date >= today && !withNumbers.has(i.id)).length;
  const young = rows.filter((r) => !r.mature);
  if (young.length) gaps.push({ kind: 'too-early', message: `${young.length} post${young.length > 1 ? 's were' : ' was'} measured before the ${window} window had passed and ${young.length > 1 ? 'are' : 'is'} left out of the scores: ${young.slice(0, 6).map((r) => r.id).join(', ')}`, posts: young.map((r) => r.id) });
  const off = rows.filter((r) => r.window !== window && r.mature);
  if (off.length) gaps.push({ kind: 'other-window', message: `${off.length} post${off.length > 1 ? 's only have' : ' only has'} numbers from a different window than ${window} (${[...new Set(off.map((r) => r.window))].join(', ')}); they are scored against posts with the same window only`, posts: off.map((r) => r.id) });
  for (const f of Object.keys(FORMULAS)) {
    const n = baselineScored.filter((r) => r.format === f).length;
    const inP = scored.filter((r) => r.format === f).length;
    if (inP && n < MIN_N) gaps.push({ kind: 'small-baseline', message: `Only ${n} ${f}${n === 1 ? '' : 's'} with settled numbers in the whole history: ${f} scores are directional until there are ${MIN_N}`, format: f });
  }
  const partial = scored.filter((r) => r.scoreBasis.coverage < 1);
  if (partial.length) {
    const lack = {};
    for (const r of partial) for (const c of FORMULAS[r.format]) if (!r.scoreBasis.parts.some((x) => x.id === c.id)) lack[`${r.format} ${c.label.toLowerCase()}`] = (lack[`${r.format} ${c.label.toLowerCase()}`] ?? 0) + 1;
    gaps.push({ kind: 'partial', message: `Some numbers are missing from ${partial.length} post${partial.length > 1 ? 's' : ''}, so they are scored on less: ${Object.entries(lack).map(([k, n]) => `${k} (${n})`).join(', ')}` });
  }
  const noFace = scored.filter((r) => r.hasFace === null).length;
  if (noFace) gaps.push({ kind: 'no-catalog', message: `${noFace} scored post${noFace > 1 ? 's have' : ' has'} a cover that is not in the media catalog, so "face on the cover" is unknown for ${noFace > 1 ? 'them' : 'it'}` });
  const typed = rows.filter((r) => r.by === 'claude');
  if (typed.length) gaps.push({ kind: 'typed-by-claude', message: `${typed.length} post${typed.length > 1 ? 's have' : ' has'} numbers that Claude typed in from what you told it: check ${typed.length > 1 ? 'them' : 'it'} against the platform`, posts: typed.map((r) => r.id) });
  const unmarked = rows.filter((r) => r.status !== 'posted');
  if (unmarked.length) gaps.push({ kind: 'not-marked-posted', message: `${unmarked.length} post${unmarked.length > 1 ? 's have' : ' has'} numbers but ${unmarked.length > 1 ? 'are' : 'is'} not marked posted in the calendar: mark ${unmarked.length > 1 ? 'them' : 'it'} posted so the plan knows ${unmarked.length > 1 ? 'they' : 'it'} went out`, posts: unmarked.map((r) => r.id) });
  if (!rows.length) gaps.push({ kind: 'nothing', message: notYet && !missing.length ? `Nothing in ${per.label} has gone out yet.` : `There are no numbers for ${per.label}. Add them (Studio: Insights > Add results or Import CSV; or: node nordle.mjs performance import).` });

  const sums = {};
  for (const r of rows.filter((x) => x.mature)) for (const k of METRIC_KEYS) if (['reach', 'views', 'plays', 'impressions', 'likes', 'comments', 'shares', 'saves', 'follows', 'profileVisits', 'linkClicks', 'dmStarts'].includes(k) && typeof r.metrics[k] === 'number') sums[k] = (sums[k] ?? 0) + r.metrics[k];
  const prevScored = all.filter((r) => inPeriod(r.date, prev) && r.score !== null);
  const headline = {
    posts: rows.length, scored: scored.length, medianScore: round(median(scored.map((r) => r.score))), previousPeriod: prev.id, previousMedianScore: round(median(prevScored.map((r) => r.score))), previousScored: prevScored.length,
    sums, bestFormat: null,
  };

  const segments = segmentRows(scored);
  const fmt = segments.format.groups.filter((g) => g.n >= 1);
  if (fmt.length) headline.bestFormat = { key: fmt[0].key, median: fmt[0].median, n: fmt[0].n };

  // did last time's advice get followed, and did the score move?
  const prior = listReviews(dir).find((rv) => rv.to < per.from && rv.directions.length + (rv.mix ? 1 : 0) > 0);
  let followUp = null;
  if (prior) {
    const since = p.cal.items.filter((i) => i.status !== 'rejected' && i.date > prior.to && i.date <= per.to);
    const share = (key) => { const c = {}; for (const i of since) c[i[key] ?? '(none)'] = (c[i[key] ?? '(none)'] ?? 0) + 1; return Object.fromEntries(Object.entries(c).map(([k, v]) => [k, round(v / since.length, 2)])); };
    followUp = {
      review: prior.period, savedAt: prior.savedAt, directions: prior.directions, recommendedMix: prior.mix,
      since: { from: addDays(prior.to, 1), to: per.to, items: since.length, pillarShare: since.length ? share('pillar') : {}, formatShare: since.length ? share('format') : {} },
      medianScoreThen: round(median(all.filter((r) => inPeriod(r.date, parsePeriod(prior.period)) && r.score !== null).map((r) => r.score))), medianScoreNow: headline.medianScore,
    };
  }

  const caveats = [
    'Scores compare each post with this account\'s own history: 50 is a typical post of that format, not "good" or "bad" in general.',
    `A group of fewer than ${MIN_N} posts is directional only. Even a clear gap shows what went with what, not what caused it: the topic, the day, a boost, the algorithm and plain luck all move a post.`,
    'About a dozen groupings are compared at once, so one standing out is partly expected by chance. Treat a pattern as a thing to test on purpose, not a rule.',
    'Numbers are what the owner copied from the platform on the capture date. Nothing here is estimated.',
  ];

  return {
    schema: REPORT_SCHEMA, project: p.id, brand: p.brand.id ?? p.id, brandName: p.brand.name ?? p.id, today,
    period: per, window, platform: opts.platform ?? 'all',
    counts: { observations: rows.length, scored: scored.length, tooEarly: young.length, missingNumbers: missing.length, history: baselineScored.length },
    headline, posts: rows, top, bottom, segments, segmentsAll: segmentRows(baselineScored), gaps, caveats, followUp,
  };
}

/** The report for the period holding today, or the last complete one. */
export const defaultPeriodFor = (today, kind = 'month', current = false) => (current ? currentPeriod(today, kind) : lastCompletePeriod(today, kind));

// ---- the plain-language summary ----------------------------------------------------------------------------------------------

const nf = new Intl.NumberFormat('en-AU', { maximumFractionDigits: 1 });
const num = (x) => (x === null || x === undefined ? '-' : nf.format(x));
const FMT_NAME = { reel: 'reel', carousel: 'carousel', post: 'post', story: 'story' };

function postLine(r) {
  const m = r.metrics;
  const bits = ['plays', 'views', 'reach', 'likes', 'comments', 'shares', 'saves', 'follows'].filter((k) => typeof m[k] === 'number').slice(0, 6).map((k) => `${num(m[k])} ${METRIC_LABELS[k].toLowerCase()}`);
  const vs = r.headline?.ratio ? `, ${r.headline.ratio}x your usual ${r.headline.label.toLowerCase()}` : '';
  return `- ${r.date} ${FMT_NAME[r.format] ?? r.format}${r.platform !== 'instagram' ? ` on ${r.platform}` : ''}: "${r.title}" (score ${num(r.score)}${vs}) hook "${String(r.hook).slice(0, 70)}" [${r.hookType ?? 'no hook'}${r.pillar ? `, ${r.pillar}` : ''}] ${bits.join(', ')}`;
}

function segmentTable(segs, { only } = {}) {
  const out = [];
  for (const dim of DIMENSIONS) {
    if (only && !only.includes(dim.id)) continue;
    const s = segs[dim.id];
    if (!s?.comparable) continue;
    out.push(`**${s.label}**`);
    for (const g of s.groups) out.push(`- ${g.key}: median ${num(g.median)}, n=${g.n}${g.evidence.level === 'directional' ? ' (directional only)' : g.evidence.level === 'none' ? '' : ` (${g.evidence.level}: ${g.evidence.gap > 0 ? '+' : ''}${g.evidence.gap} points vs the rest)`}`);
    if (s.unknown) out.push(`- (${s.unknown} post${s.unknown > 1 ? 's' : ''} could not be classified)`);
  }
  return out;
}

export function reportMarkdown(report) {
  const r = report;
  const o = [];
  o.push(`# ${r.brandName}: how the posts did, ${r.period.label}`, '');
  o.push(`${r.counts.observations} post${r.counts.observations === 1 ? '' : 's'} with numbers in the period (${r.counts.scored} scored), ${r.counts.history} scored in the whole history. Window: ${r.window}. Scores are relative to this account's own history (50 is a typical post of its format).`, '');
  if (r.headline.medianScore !== null) {
    o.push(`Median score: **${num(r.headline.medianScore)}**${r.headline.previousMedianScore !== null ? ` (${r.headline.previousPeriod}: ${num(r.headline.previousMedianScore)}, n=${r.headline.previousScored})` : ' (no earlier period to compare with)'}.`);
    const sums = Object.entries(r.headline.sums).map(([k, v]) => `${num(v)} ${METRIC_LABELS[k].toLowerCase()}`);
    if (sums.length) o.push(`Totals over the settled posts: ${sums.join(', ')}.`);
    o.push('');
  }
  if (r.top.length) o.push('## Best', '', ...r.top.map(postLine), '');
  if (r.bottom.length) o.push('## Weakest', '', ...r.bottom.map(postLine), '');
  const period = segmentTable(r.segments);
  if (period.length) o.push('## Results by group, this period', '', ...period, '');
  const hist = segmentTable(r.segmentsAll);
  if (hist.length && r.counts.history !== r.counts.scored) o.push('## Results by group, the whole history', '', ...hist, '');
  else if (hist.length) o.push('The whole history is the same posts as this period, so the groups above are the long view too.', '');
  if (r.followUp) {
    o.push(`## Since the last review (${r.followUp.review})`, '');
    o.push(`Median score then ${num(r.followUp.medianScoreThen)}, now ${num(r.followUp.medianScoreNow)}. ${r.followUp.since.items} posts planned since (${Object.entries(r.followUp.since.pillarShare).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(', ') || 'none'}).`);
    for (const d of r.followUp.directions) o.push(`- ${d.kind}: ${d.text}`);
    o.push('');
  }
  if (r.gaps.length) o.push('## What is missing', '', ...r.gaps.map((g) => `- ${g.message}`), '');
  o.push('## Read this with care', '', ...r.caveats.map((c) => `- ${c}`), '');
  return `${o.join('\n')}\n`;
}
