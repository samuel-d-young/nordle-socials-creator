// When to post, from the account's own history. Input: the posts a brand's channels have sent, with the results Buffer measured
// (reach or impressions or views, and engagement rate). Each post is compared with ITS OWN channel's usual result, so a big page and a
// small one count the same and a Facebook page is never ranked against an Instagram account. A post scores 1.0 when it did as well as
// the channel usually does, 1.3 when it did 30% better. Posts are then grouped by weekday, by hour of the day and by both, and each
// group says how many posts it rests on and how sure the number is (a bootstrap range, so a lucky post cannot make a slot look good).
//
// What this CAN'T say: it only knows the times that have been tried. A time that was never used has no result, and a post's content,
// format and the day's news all change results too. So the answer is "of the times you have used, these did best", and the page says so.

import { zonedToUtc } from '../publish/plan.mjs';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const FULL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const median = (xs) => { const a = [...xs].sort((x, y) => x - y); const m = a.length >> 1; return a.length ? (a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2) : null; };
const clampLift = (x) => Math.min(5, Math.max(0.2, x));

/** Weekday (Mon = 0), hour and minute of an instant on a clock in `timeZone`. */
export function localParts(iso, timeZone) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  let parts;
  try { parts = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d); } catch { return null; }
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const dow = DAYS.indexOf(get('weekday'));
  return dow < 0 ? null : { dow, hour: Number(get('hour')), minute: Number(get('minute')) };
}

export const hourLabel = (h, m = 0) => {
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'am' : 'pm'}`;
};

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** { n, lift, lo, hi, verdict } for a list of log-scores. lo and hi are the 10th and 90th percentile of the bootstrap mean. */
function summarize(logs) {
  const n = logs.length;
  const mean = logs.reduce((a, b) => a + b, 0) / n;
  let lo = mean, hi = mean;
  if (n >= 3) {
    const rand = rng(Math.round(Math.abs(mean) * 1e6) + n * 7919);
    const means = [];
    for (let i = 0; i < 300; i++) { let s = 0; for (let k = 0; k < n; k++) s += logs[Math.floor(rand() * n)]; means.push(s / n); }
    means.sort((a, b) => a - b);
    lo = means[Math.floor(0.1 * means.length)]; hi = means[Math.floor(0.9 * means.length)];
  }
  const r = (x) => Math.round(Math.exp(x) * 100) / 100;
  const verdict = n < 4 ? 'thin' : n >= 6 && Math.exp(lo) > 1.05 ? 'better' : n >= 6 && Math.exp(hi) < 0.95 ? 'worse' : 'unclear';
  return { n, lift: r(mean), lo: r(lo), hi: r(hi), verdict };
}

/** The score of every usable post: { when, dow, hour, minute, channelId, log }. */
function scorePosts(posts, timeZone, now, maxAgeDays, settleHours) {
  const byChannel = new Map();
  for (const p of posts) (byChannel.get(p.channelId) ?? byChannel.set(p.channelId, []).get(p.channelId)).push(p);
  const out = [];
  for (const [channelId, list] of byChannel) {
    const exp = (m) => m?.reach ?? m?.impressions ?? m?.views ?? null;
    const base = { exposure: median(list.map((p) => exp(p.m)).filter((x) => x > 0)), er: median(list.map((p) => p.m?.engagementRate).filter((x) => x > 0)) };
    for (const p of list) {
      const sent = p.sentAt ?? p.dueAt;
      const t = Date.parse(sent ?? '');
      if (!Number.isFinite(t) || t > now - settleHours * 3600000 || t < now - maxAgeDays * 86400000) continue;
      const parts = localParts(sent, timeZone);
      if (!parts) continue;
      const logs = [];
      const e = exp(p.m);
      if (base.exposure && e > 0) logs.push(Math.log(clampLift(e / base.exposure)));
      if (base.er && p.m?.engagementRate > 0) logs.push(Math.log(clampLift(p.m.engagementRate / base.er)));
      if (!logs.length) continue;
      out.push({ when: sent, ...parts, channelId, log: logs.reduce((a, b) => a + b, 0) / logs.length });
    }
  }
  return out;
}

/**
 * @param {{channelId:string, sentAt?:string, dueAt?:string, m?:Object<string,number>}[]} posts
 * @param {{timeZone?:string, now?:number, maxAgeDays?:number, settleHours?:number}} [opts]
 */
export function analyseTimes(posts, { timeZone = 'Australia/Melbourne', now = Date.now(), maxAgeDays = 180, settleHours = 36 } = {}) {
  const scored = scorePosts(posts ?? [], timeZone, now, maxAgeDays, settleHours);
  const group = (keyOf) => {
    const m = new Map();
    for (const s of scored) { const k = keyOf(s); (m.get(k) ?? m.set(k, []).get(k)).push(s); }
    return m;
  };
  const byDay = group((s) => s.dow);
  const weekday = DAYS.map((label, i) => { const g = byDay.get(i); return { key: i, label, full: FULL[i], ...(g ? summarize(g.map((s) => s.log)) : { n: 0, lift: null, lo: null, hi: null, verdict: 'none' }) }; });
  const hours = [...group((s) => s.hour)].map(([hour, g]) => {
    const minute = (Math.round((median(g.map((s) => s.minute)) ?? 0) / 5) * 5) % 60;
    return { key: hour, hour, minute, label: hourLabel(hour), ...summarize(g.map((s) => s.log)) };
  }).sort((a, b) => a.hour - b.hour);
  const combos = [...group((s) => `${s.dow}|${s.hour}`)].map(([k, g]) => {
    const [dow, hour] = k.split('|').map(Number);
    const minute = (Math.round((median(g.map((s) => s.minute)) ?? 0) / 5) * 5) % 60;
    return { weekday: dow, day: DAYS[dow], hour, minute, label: `${DAYS[dow]} ${hourLabel(hour, minute)}`, ...summarize(g.map((s) => s.log)) };
  }).filter((c) => c.n >= 3).sort((a, b) => b.lift - a.lift || b.n - a.n);
  const usable = (xs) => xs.filter((x) => x.n >= 5);
  const best = { weekday: usable(weekday).sort((a, b) => b.lift - a.lift)[0] ?? null, hour: usable(hours).sort((a, b) => b.lift - a.lift)[0] ?? null };
  const stamps = scored.map((s) => Date.parse(s.when)).sort((a, b) => a - b);
  const tooNew = (posts ?? []).filter((p) => { const t = Date.parse(p.sentAt ?? p.dueAt ?? ''); return Number.isFinite(t) && t > now - settleHours * 3600000; }).length;
  const caveats = [];
  if (scored.length < 30) caveats.push(`Only ${scored.length} posts have settled results, so every number here is a hint, not a finding.`);
  if (hours.length <= 2) caveats.push('Almost every post went out at the same one or two times, so there is nothing to compare yet. Try a different time on purpose for a few weeks.');
  caveats.push('This only knows the days and times you have used. A time you never tried has no result, and a post\'s content and format change results too.');
  caveats.push('A score of 1.0 means a post did as well as that channel usually does. 1.3 means 30% better. The range shows how far a lucky or unlucky post could move it.');
  return {
    schema: 'nordle.besttimes/0.1', timeZone,
    counts: { posts: (posts ?? []).length, used: scored.length, tooNew, unmeasured: Math.max(0, (posts ?? []).length - scored.length - tooNew), channels: new Set(scored.map((s) => s.channelId)).size, from: stamps.length ? new Date(stamps[0]).toISOString() : null, to: stamps.length ? new Date(stamps.at(-1)).toISOString() : null },
    weekday, hour: hours, combos: combos.slice(0, 12), best, caveats,
  };
}

/**
 * The next few good moments to post, from the analysis: each is a time still ahead (not within `minLeadMin` minutes), on the brand's own clock,
 * rounded to a quarter hour. A slot is only offered when the evidence is real: at least 5 posts and a range that stays above a typical post;
 * failing that, 4 posts that look better; failing that, the best weekday at the best hour (and it says it is a guess). Middle-of-the-night
 * slots (before 6 am) are offered only on clear evidence.
 * @returns {{iso:string, label:string, lift:number, n:number, verdict:string, confidence:'clear'|'likely'|'guess', reason:string}[]}
 */
export function suggestSlots(analysis, { now = Date.now(), count = 4, minLeadMin = 20, horizonDays = 14 } = {}) {
  if (!analysis) return [];
  const tz = analysis.timeZone;
  const sensible = (c) => c.hour >= 6 || (c.verdict === 'better' && c.n >= 6);
  let pool = analysis.combos.filter((c) => c.n >= 5 && c.verdict === 'better' && sensible(c)).slice(0, 8).map((c) => ({ ...c, confidence: 'clear' }));
  if (!pool.length) pool = analysis.combos.filter((c) => c.n >= 4 && c.lift > 1.05 && c.verdict !== 'thin' && sensible(c)).slice(0, 8).map((c) => ({ ...c, confidence: 'likely' }));
  const bh = analysis.hour.filter((x) => x.n >= 5 && x.hour >= 6).sort((x, y) => y.lift - x.lift)[0] ?? null;   // (a guess never lands in the middle of the night)
  if (!pool.length && analysis.best.weekday && bh) {
    const bw = analysis.best.weekday;
    pool = [{ weekday: bw.key, day: bw.label, hour: bh.hour, minute: bh.minute, lift: Math.round(Math.sqrt(bw.lift * bh.lift) * 100) / 100, n: Math.min(bw.n, bh.n), verdict: 'unclear', confidence: 'guess', combined: true }];
  }
  const out = [];
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
  const [y, mo, d] = today.split('-').map(Number);
  for (let k = 0; k <= horizonDays; k++) {
    const date = new Date(Date.UTC(y, mo - 1, d + k));
    const dow = (date.getUTCDay() + 6) % 7;
    const ymd = date.toISOString().slice(0, 10);
    for (const c of pool) {
      if (c.weekday !== dow) continue;
      const total = Math.round((c.hour * 60 + (c.minute ?? 0)) / 15) * 15;
      const hh = Math.floor(total / 60) % 24, mm = total % 60;
      const at = zonedToUtc(ymd, `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`, tz);
      if (!at || at.getTime() < now + minLeadMin * 60000) continue;
      const label = `${DAYS[dow]} ${hourLabel(hh, mm)}`;
      const how = c.confidence === 'clear' ? 'clearly better than usual' : c.confidence === 'likely' ? 'looks better than usual, but not certain' : 'a guess: the best day and the best hour put together';
      out.push({ iso: at.toISOString(), label, lift: c.lift, n: c.n, verdict: c.verdict, confidence: c.confidence, reason: `${label}: ${c.lift}× a typical post, from ${c.n} posts (${how}).` });
    }
  }
  return out.sort((a, b) => a.iso.localeCompare(b.iso)).slice(0, count);
}
