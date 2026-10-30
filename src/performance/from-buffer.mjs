// Buffer's sent posts -> Nordle's numbers. The Buffer pull (src/publish/remote.mjs) keeps every sent post of a brand with the results Buffer
// reports for it (<project>/performance/buffer-posts.json). Insights reads <project>/metrics.json, which is keyed by calendar item, so the
// two never met and Insights showed nothing. This is the bridge, in two parts:
//
//   importBufferMetrics(dir)  writes a metrics entry (source 'buffer', window 'lifetime') for every sent post that can be tied to a calendar
//                             item: by the Buffer post id Nordle was given when it scheduled the post, or, for a post scheduled outside
//                             Nordle, by being the ONLY calendar item at that time on that day. A post that cannot be tied to one item is
//                             left alone (a number is never given to a post it might not belong to). All-zero results are skipped: Buffer
//                             sends zeros for results it does not have yet, and a zero that is not a measurement must not be saved as one.
//   bufferTotals(dir, {days}) the brand's own totals for the last N days straight from the pull, tied to no calendar item, so numbers show
//                             at once even for posts made before Nordle existed.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSentPosts } from '../publish/remote.mjs';
import { loadProject } from '../calendar/service.mjs';
import { upsertEntries } from './model.mjs';

/** Buffer's names for the numbers -> ours. engagementRate is a ratio Nordle works out itself, so it is not copied. */
const MAP = { reactions: 'likes', comments: 'comments', shares: 'shares', saves: 'saves', follows: 'follows', views: 'views', reach: 'reach', impressions: 'impressions', clicks: 'linkClicks' };

export function mapNumbers(m) {
  const out = {};
  for (const [from, to] of Object.entries(MAP)) { const v = m?.[from]; if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[to] = v; }
  return out;
}
const hasSignal = (n) => Object.values(n).some((v) => v > 0);

/** The local date and HH:MM of an instant on a clock in `timeZone`. */
function localDateTime(iso, timeZone) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  let parts;
  try { parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d); } catch { return null; }
  const g = (t) => parts.find((p) => p.type === t)?.value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, minutes: Number(g('hour')) * 60 + Number(g('minute')) };
}
const minutesOf = (hhmm) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm ?? '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const dayOf = (iso) => String(iso ?? '').slice(0, 10);
export const SERVICE_OK = new Set(['instagram', 'facebook', 'tiktok', 'linkedin', 'youtube', 'threads', 'x', 'pinterest', 'googlebusiness']);

/**
 * Which calendar item does each sent Buffer post belong to? Returns Map(bufferPostId -> itemId) and how many were left unmatched.
 * Stories (a Buffer post Nordle made as a Story of an item) are not the item's own post and are left out.
 */
export function matchPosts(posts, items, timeZone, { slackMinutes = 30 } = {}) {
  const byRemote = new Map();
  const stories = new Set();
  for (const it of items) for (const t of it.publish?.targets ?? []) {
    if (!t.remoteId) continue;
    if (String(t.channel ?? '').endsWith('#story')) stories.add(t.remoteId); else byRemote.set(t.remoteId, it.id);
  }
  const live = items.filter((i) => i.date && !['idea', 'rejected'].includes(i.status));
  const matched = new Map();
  let unmatched = 0, skippedStories = 0;
  for (const p of posts) {
    if (stories.has(p.id)) { skippedStories++; continue; }
    if (byRemote.has(p.id)) { matched.set(p.id, byRemote.get(p.id)); continue; }
    const at = localDateTime(p.dueAt ?? p.sentAt, timeZone);
    const near = at ? live.filter((i) => i.date === at.date && minutesOf(i.time) !== null && Math.abs(minutesOf(i.time) - at.minutes) <= slackMinutes) : [];
    if (near.length === 1) matched.set(p.id, near[0].id); else unmatched++;
  }
  return { matched, unmatched, skippedStories };
}

/** Write the entries. Safe to run again: a newer pull replaces the earlier numbers for the same post, channel kind and window. */
export async function importBufferMetrics(projectDir, { today } = {}) {
  const sent = readSentPosts(projectDir);
  const p = loadProject(projectDir);
  const items = p.cal.items;
  const withNumbers = sent.posts.filter((x) => hasSignal(mapNumbers(x.m)));
  const { matched, unmatched, skippedStories } = matchPosts(withNumbers, items, p.timezone);
  // one entry per (item, platform): when a post went to several channels of one service, the one with most reach stands for the item
  const best = new Map();
  for (const post of withNumbers) {
    const item = matched.get(post.id);
    if (!item || !SERVICE_OK.has(post.service)) continue;
    const numbers = mapNumbers(post.m);
    const k = `${item}|${post.service}`;
    const score = (numbers.reach ?? 0) + (numbers.views ?? 0);
    if (!best.has(k) || score > best.get(k).score) best.set(k, { score, input: { post: item, platform: post.service, publishedAt: post.sentAt ?? post.dueAt, capturedAt: String(post.metricsUpdatedAt ?? sent.pulledAt ?? today ?? '').slice(0, 10) || today, window: 'lifetime', metrics: numbers, source: 'buffer', note: 'From Buffer.' } });
  }
  const inputs = [...best.values()].map((x) => x.input);
  if (!inputs.length) return { ok: true, pulled: sent.posts.length, withNumbers: withNumbers.length, matched: 0, unmatched, entries: 0, added: 0, replaced: 0, rejected: 0, skippedStories };
  const r = await upsertEntries(projectDir, inputs, { role: 'human', today, requirePost: true });
  return { ok: true, pulled: sent.posts.length, withNumbers: withNumbers.length, matched: matched.size, unmatched, entries: inputs.length, added: r.added.length, replaced: r.replaced.length, rejected: r.rejected.length, skippedStories };
}

/** The brand's own totals for the last `days` days (default 28) from the pull alone, with the same numbers per service. */
export function bufferTotals(projectDir, { days = 28, now = Date.now() } = {}) {
  const sent = readSentPosts(projectDir);
  const from = now - days * 86400000;
  const inRange = sent.posts.filter((x) => { const t = Date.parse(x.sentAt ?? x.dueAt ?? ''); return t >= from && t <= now; });
  const total = { posts: 0, withNumbers: 0, metrics: {} };
  const byService = {};
  for (const x of inRange) {
    const n = mapNumbers(x.m);
    const svc = (byService[x.service ?? 'other'] ??= { posts: 0, withNumbers: 0, metrics: {} });
    for (const t of [total, svc]) {
      t.posts++;
      if (hasSignal(n)) { t.withNumbers++; for (const [k, v] of Object.entries(n)) t.metrics[k] = (t.metrics[k] ?? 0) + v; }
    }
  }
  return { pulledAt: sent.pulledAt, days, ...total, byService, hasPull: existsSync(join(projectDir, 'performance', 'buffer-posts.json')) };
}

// ---- the all-brands overview --------------------------------------------------------------------------------------------------------

const ENGAGEMENT = ['likes', 'comments', 'shares', 'saves'];
const engagementOf = (n) => ENGAGEMENT.reduce((t, k) => t + (n[k] ?? 0), 0);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : 0; };
/** A caption on one line, cut at a word with an ellipsis when it is long. */
const oneLine = (t, max = 140) => {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max), at = cut.lastIndexOf(' ');
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:.\-–—]+$/, '')}…`;
};

/**
 * What the all-brands Insights screen shows for one brand, from the pull alone (no request to Buffer): how many posts went out in the
 * last `days` days and in the window before it, the audience and engagement they got, the posts that beat the brand's own usual, posts per
 * week, the channels used and how long since the last post. A post's lift is its engagement over this brand's median post in the same
 * window, and is only given when at least five posts have numbers (fewer is not a usual to compare with).
 */
export function bufferOverview(projectDir, { days = 28, now = Date.now() } = {}) {
  const sent = readSentPosts(projectDir);
  const at = (x) => Date.parse(x.sentAt ?? x.dueAt ?? '');
  const inWindow = (from, to) => sent.posts.filter((x) => { const t = at(x); return t >= from && t < to; });
  const sum = (list) => {
    const out = { posts: list.length, withNumbers: 0, metrics: {}, engagement: 0 };
    for (const x of list) {
      const n = mapNumbers(x.m);
      if (!hasSignal(n)) continue;
      out.withNumbers++; out.engagement += engagementOf(n);
      for (const [k, v] of Object.entries(n)) out.metrics[k] = (out.metrics[k] ?? 0) + v;
    }
    return out;
  };
  const span = days * 86400000;
  const inNow = inWindow(now - span, now + 1), inBefore = inWindow(now - 2 * span, now - span);
  const a = sum(inNow), b = sum(inBefore);
  const audienceKey = (a.metrics.reach ?? 0) > 0 ? 'reach' : (a.metrics.views ?? 0) > 0 ? 'views' : null;

  const scored = inNow.map((x) => ({ x, n: mapNumbers(x.m) })).filter((r) => hasSignal(r.n)).map((r) => ({ ...r, eng: engagementOf(r.n) }));
  const usual = median(scored.map((r) => r.eng));
  const top = [...scored].sort((p, q) => q.eng - p.eng || (q.n[audienceKey ?? 'reach'] ?? 0) - (p.n[audienceKey ?? 'reach'] ?? 0)).slice(0, 3).map((r) => ({
    id: r.x.id, service: r.x.service ?? 'other', sentAt: r.x.sentAt ?? r.x.dueAt ?? null, text: oneLine(r.x.text), engagement: r.eng,
    audience: audienceKey ? r.n[audienceKey] ?? null : null, lift: scored.length >= 5 && usual > 0 ? Math.round((r.eng / usual) * 10) / 10 : null,
  }));

  // posts per bucket, oldest first: one a day for a short window, otherwise one a week
  const len = (days <= 14 ? 1 : 7) * 86400000, count = Math.min(13, Math.ceil(span / len));
  const series = Array.from({ length: count }, (_, i) => {
    const to = now + 1 - (count - 1 - i) * len, from = to - len;
    const list = inWindow(Math.max(from, now - span), to);
    return { from: new Date(from).toISOString().slice(0, 10), posts: list.length, audience: audienceKey ? list.reduce((t, x) => t + (mapNumbers(x.m)[audienceKey] ?? 0), 0) : 0 };
  });
  const channels = {};
  for (const x of inNow) channels[x.service ?? 'other'] = (channels[x.service ?? 'other'] ?? 0) + 1;
  const last = sent.posts.reduce((m, x) => Math.max(m, at(x) || 0), 0);
  return {
    days, pulledAt: sent.pulledAt, hasPull: existsSync(join(projectDir, 'performance', 'buffer-posts.json')),
    now: { posts: a.posts, withNumbers: a.withNumbers, engagement: a.engagement, audience: audienceKey ? a.metrics[audienceKey] : null, follows: a.metrics.follows ?? null },
    before: { posts: b.posts, withNumbers: b.withNumbers, engagement: b.engagement, audience: audienceKey ? b.metrics[audienceKey] ?? 0 : null, follows: b.metrics.follows ?? null },
    audienceKey, usualEngagement: a.withNumbers ? Math.round((a.engagement / a.withNumbers) * 10) / 10 : null,
    usualEngagementBefore: b.withNumbers ? Math.round((b.engagement / b.withNumbers) * 10) / 10 : null,
    top, series, channels: Object.entries(channels).sort((p, q) => q[1] - p[1]).map(([service, posts]) => ({ service, posts })),
    lastPostAt: last ? new Date(last).toISOString() : null,
  };
}
