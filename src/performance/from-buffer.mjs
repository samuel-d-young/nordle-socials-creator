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
