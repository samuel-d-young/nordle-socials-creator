// Looking at what the publishing service (Buffer) holds, read only, to answer two questions:
//   1. checkScheduled: is each post Nordle scheduled still there? (It may have been deleted in Buffer.) A post that is gone can be taken
//      back (unscheduleMissing) so it can be scheduled again.
//   2. syncSentPosts: how did the posts that went out do, and when were they sent? Kept per project in performance/buffer-posts.json and
//      read by src/performance/best-time.mjs to say when to post.
// Both are owner only: they use the saved API key. They cost one request per 100 posts and stop when Buffer's allowance runs low.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadProject, markUnscheduled } from '../calendar/service.mjs';
import { forget, locate, readJsonCached } from '../studio/data.mjs';
import { calendarPath } from '../calendar/model.mjs';
import { PublishError, appendAudit, loadSettings, readAllowance, resolveSettings } from './store.mjs';
import { getAdapter } from './index.mjs';

const STORY = /#story$/;
const owner = (role) => { if (role !== 'human') throw new PublishError(403, 'Only the owner can ask the publishing service, in the Studio.'); };

// Buffer's request allowance is small (100 per 15 minutes, 250 a day on this plan) and scheduling a post needs it. So the OPTIONAL reads in this file
// (history for best times, "is it still there?") keep a reserve: they refuse to start when the daily allowance is nearly used or a burst has
// just used the 15-minute one, and a history pull is not repeated within SYNC_GAP unless the owner insists.
export const RESERVE = { day: 40, quarter: 8 };
export const SYNC_GAP_MS = 6 * 3600 * 1000;
const clockOf = (iso) => new Date(iso).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
/** Throw (429, code 'allowance') when asking for something optional would eat into what scheduling needs. */
export function guardAllowance(accountId, what, now = Date.now()) {
  const a = readAllowance(accountId, now);
  const day = a?.windows?.['1day'], quarter = a?.windows?.['15min'];
  if (Number.isFinite(day?.left) && day.left < RESERVE.day) throw new PublishError(429, `Buffer's request allowance for today is nearly used (${day.left} of ${day.limit} left, back to full at ${clockOf(day.resetsAt)}). ${what} was skipped so scheduling can still go ahead.`, { code: 'allowance' });
  if (Number.isFinite(quarter?.left) && quarter.left < RESERVE.quarter) throw new PublishError(429, `Buffer was just asked for a lot (${quarter.left} of ${quarter.limit} requests left for the next few minutes). ${what} was skipped: try again in a few minutes.`, { code: 'allowance' });
}

/** The organisation a channel belongs to, from the channel list the key last saw. */
const orgOf = (s, channelId) => s.channelCache.find((c) => c.id === channelId)?.organizationId ?? s.organizationId ?? null;

/**
 * For posts that were scheduled in Buffer: which of their channel targets Buffer still has. One listing per organisation, newest first,
 * from a day before the earliest scheduled time (so sent posts are seen too). A target is "missing" only when the listing was read to the end.
 * @returns {{ok:true, results:{uid:string, title:string, status:string, targets:{channel:string, remoteId:string, state:string, dueAt?:string|null}[], missing:string[]}[], requests:number, rate:object, incomplete?:string}}
 */
export async function checkScheduled(store, { uids, role } = {}) {
  owner(role);
  const adapter = getAdapter('buffer');
  const settings = loadSettings();
  const wanted = [...new Set((Array.isArray(uids) ? uids : []).map(String))].slice(0, 200);
  const groups = new Map();   // "<project>|<org>" -> { project, s, org, channelIds:Set, since, entries:[{uid, target}] }
  const results = new Map();
  for (const uid of wanted) {
    const at = locate(store, uid);
    const item = at?.item;
    if (!item?.publish || item.publish.adapter !== 'buffer') continue;
    const targets = (item.publish.targets ?? []).filter((t) => t.ok && t.remoteId);
    if (!targets.length) continue;
    const s = resolveSettings(settings, 'buffer', at.project.id);
    if (!s.token) continue;
    results.set(uid, { uid, title: item.title ?? uid, status: item.status, targets: targets.map((t) => ({ channel: t.channel, remoteId: t.remoteId, state: 'unknown', dueAt: t.scheduledAt ?? null })), missing: [] });
    for (const t of targets) {
      const channelId = String(t.channel).replace(STORY, '');
      const org = orgOf(s, channelId);
      if (!org) continue;
      const key = `${at.project.id}|${org}`;
      const g = groups.get(key) ?? { s, org, channelIds: new Set(), since: null, entries: [] };
      g.channelIds.add(channelId);
      const when = Date.parse(t.scheduledAt ?? '');
      if (Number.isFinite(when) && (g.since === null || when < g.since)) g.since = when;
      g.entries.push({ uid, target: t });
      groups.set(key, g);
    }
  }
  let requests = 0, rate = {}, incomplete = null;
  for (const g of groups.values()) {
    const since = new Date((g.since ?? Date.now()) - 2 * 86400000).toISOString();
    try { guardAllowance(g.s.account?.id, 'Looking in Buffer'); } catch (e) { if (e.code !== 'allowance') throw e; incomplete = e.message; continue; }
    const r = await adapter.listPosts(g.s, { organizationId: g.org, channelIds: [...g.channelIds], filter: { dueAt: { start: since } } });
    requests += r.pages; rate = r.rate;
    if (!r.complete) incomplete = r.stopped ?? 'the list was not read to the end';
    const found = new Map(r.posts.map((p) => [p.id, p]));
    for (const { uid, target } of g.entries) {
      const row = results.get(uid).targets.find((t) => t.channel === target.channel);
      const hit = found.get(String(target.remoteId));
      if (hit) { row.state = hit.status; row.dueAt = hit.dueAt ?? row.dueAt; } else if (r.complete) { row.state = 'missing'; results.get(uid).missing.push(target.channel); }
    }
  }
  return { ok: true, results: [...results.values()], requests, rate, ...(incomplete ? { incomplete } : {}) };
}

/** Take a post's missing channel targets back, so it can be scheduled again (owner only). Returns the item's new status. */
export async function unscheduleMissing(store, { uid, channels, role } = {}) {
  owner(role);
  const at = locate(store, String(uid ?? ''));
  if (!at?.item) throw new PublishError(404, 'There is no such post on the calendar.');
  const { item, project } = at;
  if (!item.publish) throw new PublishError(409, 'This post is not scheduled anywhere.');
  const list = Array.isArray(channels) && channels.length ? channels.map(String) : undefined;
  const before = (item.publish.targets ?? []).filter((t) => !list || list.includes(t.channel));
  const res = await markUnscheduled(project.dir, item.id, { remove: list }, { role: 'human' });
  forget(calendarPath(project.dir));
  appendAudit(project.dir, { event: 'unschedule', adapter: item.publish.adapter, uid: String(uid), item: item.id, ok: true, by: 'owner', via: 'studio', message: `Taken back so it can be scheduled again: ${before.map((t) => t.channel).join(', ') || 'all'}`, remoteId: before.map((t) => t.remoteId).filter(Boolean).join(',') || undefined });
  return { ok: true, status: res.item.status, removed: before.map((t) => t.channel) };
}

// ---- sent posts and how they did (for the best time to post) ----------------------------------------------------------------------

const postsFile = (dir) => join(dir, 'performance', 'buffer-posts.json');
/** 0.2 keeps each sent post's words and pictures as well as its numbers. */
export const BUFFER_POSTS_SCHEMA = 'nordle.bufferposts/0.2';

/** What was pulled before: { pulledAt, posts:[ { id, channelId, service, sentAt, dueAt, metricsUpdatedAt, m:{reach,...} } ] } (empty when none). */
export function readSentPosts(dir) {
  try { const j = JSON.parse(readFileSync(postsFile(dir), 'utf8')); return Array.isArray(j?.posts) ? j : { pulledAt: null, posts: [] }; } catch { return { pulledAt: null, posts: [] }; }
}

/**
 * Pull the posts a brand's channels have sent (with their results) from Buffer and keep them. The first time it reads the last 180 days;
 * after that only from three days before the newest one we have (results of recent posts keep changing for a day or so). Owner only.
 */
export async function syncSentPosts(store, { project: projectId, role, now = Date.now(), days = 180, force = false } = {}) {
  owner(role);
  const project = store.project(String(projectId ?? ''));
  if (!project) throw new PublishError(404, 'There is no such brand.');
  const adapter = getAdapter('buffer');
  const s = resolveSettings(loadSettings(), 'buffer', project.id);
  if (!s.token) throw new PublishError(409, 'This brand has no Buffer account connected yet.');
  const channelIds = [...new Set((s.channels ?? []).map((c) => c.id))];
  if (!channelIds.length) throw new PublishError(409, 'This brand has no Buffer channels chosen yet.');
  const byOrg = new Map();
  for (const id of channelIds) { const org = orgOf(s, id); if (org) (byOrg.get(org) ?? byOrg.set(org, []).get(org)).push(id); }
  const had = readSentPosts(project.dir);
  if (!force && had.pulledAt && now - Date.parse(had.pulledAt) < SYNC_GAP_MS) {   // pulled recently: do not spend requests again
    return { ok: true, skipped: true, fetched: 0, total: had.posts.length, requests: 0, rate: {}, pulledAt: had.pulledAt, message: `Already updated ${Math.max(1, Math.round((now - Date.parse(had.pulledAt)) / 60000))} minutes ago. Nordle waits ${SYNC_GAP_MS / 3600000} hours between pulls to save Buffer's request allowance.` };
  }
  guardAllowance(s.account?.id, 'Updating the history');
  // an earlier pull did not keep the words and pictures (needed to show posts made by hand in Buffer): read the whole window again once
  const newest = had.schema === BUFFER_POSTS_SCHEMA ? had.posts.reduce((m, p) => Math.max(m, Date.parse(p.sentAt ?? p.dueAt ?? '') || 0), 0) : 0;
  const start = new Date(newest ? Math.max(newest - 3 * 86400000, now - days * 86400000) : now - days * 86400000).toISOString();
  const merged = new Map(had.posts.map((p) => [p.id, p]));
  let requests = 0, fetched = 0, rate = {}, incomplete = null;
  for (const [organizationId, ids] of byOrg) {
    const r = await adapter.listPosts(s, { organizationId, channelIds: ids, filter: { status: ['sent'], dueAt: { start } }, metrics: true, text: true, assets: true, maxPages: 10 });
    requests += r.pages; rate = r.rate;
    if (!r.complete) incomplete = r.stopped ?? 'not everything was read';
    for (const p of r.posts) { merged.set(p.id, p); fetched++; }
  }
  const posts = [...merged.values()].sort((a, b) => String(b.sentAt ?? b.dueAt).localeCompare(String(a.sentAt ?? a.dueAt)));
  const file = postsFile(project.dir);
  mkdirSync(join(project.dir, 'performance'), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ schema: BUFFER_POSTS_SCHEMA, pulledAt: new Date(now).toISOString(), posts })}\n`);
  renameSync(tmp, file);
  return { ok: true, fetched, total: posts.length, requests, rate, pulledAt: new Date(now).toISOString(), ...(incomplete ? { incomplete } : {}), timezone: loadProject(project.dir).timezone };
}

export const hasSentPosts = (dir) => existsSync(postsFile(dir));
export { readJsonCached };
