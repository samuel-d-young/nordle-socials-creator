// Posts made by hand in Buffer, shown on Nordle's calendar.
//
// Nordle keeps the calendar; Buffer holds what is scheduled and sent. Anything that went to Buffer without Nordle (typed into Buffer, scheduled from
// the phone app, made by another tool) used to be invisible here: sync left it alone and listed it. This copies it onto the calendar so the month
// and the Wall show everything the brand posts:
//
//   * a Buffer post that no calendar item owns (its id is not recorded on an item, and its words are not the caption of one) becomes a calendar item
//     with origin 'buffer', status 'scheduled' (still to go out) or 'posted' (sent), the words, the picture as its cover, and the Buffer ids recorded
//     as publish targets. One hand-made post sent to several channels is one item with several targets.
//   * READ ONLY. Nordle never moves, deletes or edits such a post in Buffer (sync skips items whose origin is 'buffer'). Nordle only follows it:
//     a time moved in Buffer moves the item, a send marks it posted, a post deleted in Buffer marks the item rejected.
//   * It costs one request per 100 scheduled posts (the sent posts come from the history pull, src/publish/remote.mjs), keeps Buffer's allowance
//     reserve (guardAllowance), copies at most MAX_NEW new posts a run and only the last IMPORT_DAYS days, so the first run cannot flood the calendar.
//   * Owner only (role 'human'): it reads Buffer with the saved key and writes the calendar.
//
// planImport() is pure (items + posts in, what to create/update out) so it is tested without Buffer; importFromBuffer() reads Buffer and applies it.

import { basename, join } from 'node:path';
import { calendarPath } from '../calendar/model.mjs';
import { loadProject, makeItemId, mutateCalendar } from '../calendar/service.mjs';
import { forget } from '../studio/data.mjs';
import { downloadTo } from '../stock/net.mjs';
import { PublishError, appendAudit, loadSettings, resolveSettings } from './store.mjs';
import { getAdapter } from './index.mjs';
import { BUFFER_POSTS_SCHEMA, guardAllowance, readSentPosts } from './remote.mjs';
import { captionOf } from './sync.mjs';

export const IMPORT_DAYS = 90;
export const MAX_NEW = 60;
const GOING = ['scheduled', 'sending'];
const COVER_MAX_BYTES = 6 * 1024 * 1024;
const owner = (role) => { if (role !== 'human') throw new PublishError(403, 'Only the owner can copy posts in from Buffer.'); };
const norm = (t) => String(t ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 60);
const minutesOf = (hhmm) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm ?? '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const SERVICE_NAME = { instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok', linkedin: 'LinkedIn', youtube: 'YouTube', threads: 'Threads', x: 'X', pinterest: 'Pinterest', googlebusiness: 'Google Business' };

/** The local date and HH:MM of an instant on a clock in `timeZone` ({date, time, minutes}), or null. */
export function localParts(iso, timeZone) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return null;
  let parts;
  try { parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d); } catch { return null; }
  const g = (t) => parts.find((p) => p.type === t)?.value;
  const time = `${g('hour')}:${g('minute')}`;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, time, minutes: minutesOf(time) };
}

/** What kind of post it is, from what it carries. */
export function formatFromPost(p) {
  const assets = p.assets ?? [];
  const hasVideo = assets.some((a) => a.type === 'video' || /^video\//.test(a.mime ?? ''));
  const text = String(p.text ?? '').trim();
  if (!text && assets.length <= 1 && (p.service === 'instagram' || p.service === 'facebook')) return 'story';
  if (hasVideo) return 'reel';
  if (assets.filter((a) => a.type !== 'video').length > 1) return 'carousel';
  return 'post';
}

function titleFrom(p, fallback) {
  const line = String(p.text ?? '').split(/\r?\n/).map((l) => l.replace(/#[\p{L}\p{N}_]+/gu, '').replace(/\s+/g, ' ').trim()).find(Boolean) ?? '';
  const t = line.length > 80 ? `${line.slice(0, 77).trimEnd()}...` : line;
  return t || fallback;
}
const hashtagsOf = (text) => [...new Set(String(text ?? '').match(/#[\p{L}\p{N}_]+/gu) ?? [])].slice(0, 30);

/** One group per hand-made post: the same words on the same day (several channels), or the same minute and picture for a post with no words. */
function groupKey(p, tz) {
  const at = localParts(p.sentAt ?? p.dueAt, tz);
  const k = norm(p.text);
  if (k.length >= 8) return `${at?.date ?? ''}|${k}`;
  return `${(p.sentAt ?? p.dueAt ?? '').slice(0, 16)}|${p.service ?? ''}|${p.assets?.[0]?.url ?? p.id}`;
}

/**
 * What to do with the posts Buffer reports. Pure.
 * @param {{items:object[], posts:object[], tz:string, now:number, dir?:string, pendingComplete?:boolean, since?:number, maxNew?:number}} o
 * @returns {{create:{posts:object[]}[], update:{id:string, patch:object, posts:object[]}[], gone:string[], skipped:{owned:number, old:number, notPosts:number, overLimit:number}}}
 */
export function planImport({ items, posts, tz, now, dir, pendingComplete = true, since = now - IMPORT_DAYS * 86400000, maxNew = MAX_NEW }) {
  const known = new Map();                       // Buffer post id -> the item that owns it
  for (const it of items) for (const t of it.publish?.targets ?? []) if (t.remoteId) known.set(String(t.remoteId), it);
  const ownWords = new Set(items.filter((i) => i.origin !== 'buffer').map((i) => norm(dir ? captionOf(dir, i) : i.external?.caption)).filter((k) => k.length >= 20));
  const slots = items.filter((i) => i.origin !== 'buffer' && i.date && i.time && !['idea', 'rejected'].includes(i.status));
  const atNordleSlot = (p) => { const at = localParts(p.sentAt ?? p.dueAt, tz); return !!at && slots.some((i) => i.date === at.date && Math.abs(minutesOf(i.time) - at.minutes) <= 30); };

  const skipped = { owned: 0, old: 0, notPosts: 0, overLimit: 0 };
  const foreign = [];
  const seenFor = new Map();                     // imported item id -> the posts Buffer shows for it now
  for (const p of posts) {
    const own = known.get(p.id);
    if (own) {
      if (own.origin === 'buffer') (seenFor.get(own.id) ?? seenFor.set(own.id, []).get(own.id)).push(p); else skipped.owned++;
      continue;
    }
    if (p.status !== 'sent' && !GOING.includes(p.status)) { skipped.notPosts++; continue; }       // drafts, posts needing approval, errors: not posts yet
    const k = norm(p.text);
    if (k.length >= 20 && ownWords.has(k)) { skipped.owned++; continue; }                         // Nordle's own words, sent some other way
    if (!k && atNordleSlot(p)) { skipped.owned++; continue; }                                     // a story with no words at one of Nordle's own times
    const t = Date.parse(p.sentAt ?? p.dueAt ?? '');
    if (p.status === 'sent' && Number.isFinite(t) && t < since) { skipped.old++; continue; }
    foreign.push(p);
  }

  const groups = new Map();
  for (const p of foreign) (groups.get(groupKey(p, tz)) ?? groups.set(groupKey(p, tz), []).get(groupKey(p, tz))).push(p);
  let list = [...groups.values()].sort((a, b) => String(b[0].sentAt ?? b[0].dueAt).localeCompare(String(a[0].sentAt ?? a[0].dueAt)));
  if (list.length > maxNew) { skipped.overLimit = list.length - maxNew; list = list.slice(0, maxNew); }

  const update = [], gone = [];
  for (const it of items) {
    if (it.origin !== 'buffer' || ['posted', 'rejected'].includes(it.status)) continue;
    const seen = seenFor.get(it.id) ?? [];
    if (!seen.length) {
      const due = Date.parse(it.publish?.scheduledAt ?? '');
      if (pendingComplete && it.status === 'scheduled' && (!Number.isFinite(due) || due > now + 3 * 60000)) gone.push(it.id);
      continue;
    }
    const patch = {};
    if (seen.every((p) => p.status === 'sent')) {
      patch.status = 'posted';
      const at = localParts(seen[0].sentAt ?? seen[0].dueAt, tz);
      if (at && (at.date !== it.date || at.time !== it.time)) { patch.date = at.date; patch.time = at.time; }
    } else {
      const next = seen.find((p) => GOING.includes(p.status)) ?? seen[0];
      const at = localParts(next.dueAt, tz);
      if (at && (at.date !== it.date || at.time !== it.time)) { patch.date = at.date; patch.time = at.time; }
    }
    if (Object.keys(patch).length) update.push({ id: it.id, patch, posts: seen });
  }
  return { create: list.map((g) => ({ posts: g })), update, gone, skipped };
}

/** The calendar item for one group of Buffer posts. */
export function itemFor(group, { tz, cal, now, channelNames = new Map() }) {
  const first = group[0];
  const at = localParts(first.sentAt ?? first.dueAt, tz);
  const allSent = group.every((p) => p.status === 'sent');
  const format = formatFromPost(first);
  const where = [...new Set(group.map((p) => channelNames.get(p.channelId) ?? SERVICE_NAME[p.service] ?? p.service ?? 'Buffer'))].join(', ');
  const title = titleFrom(first, `${SERVICE_NAME[first.service] ?? 'Buffer'} ${format === 'reel' ? 'video' : format}`);
  const stamp = new Date(now).toISOString();
  const id = makeItemId(cal, at?.date ?? stamp.slice(0, 10), `buffer ${title}`);
  const tags = hashtagsOf(first.text);
  return {
    id, date: at?.date ?? stamp.slice(0, 10), ...(at?.time ? { time: at.time } : {}), format, title, status: allSent ? 'posted' : 'scheduled', origin: 'buffer',
    external: { source: 'Made by hand in Buffer', ...(String(first.text ?? '').trim() ? { caption: String(first.text).trim() } : {}), ...(tags.length ? { hashtags: tags } : {}),
      note: `Copied from Buffer on ${stamp.slice(0, 10)} so the calendar shows everything this brand posts. Read only: Nordle never moves, changes or deletes it in Buffer. Channels: ${where}.` },
    publish: { adapter: 'buffer', ...(first.dueAt ?? first.sentAt ? { scheduledAt: first.dueAt ?? first.sentAt } : {}), remoteId: first.id, at: stamp,
      targets: group.map((p) => ({ channel: p.channelId, ok: true, ...(p.dueAt ?? p.sentAt ? { scheduledAt: p.dueAt ?? p.sentAt } : {}), remoteId: p.id, at: stamp })) },
    updated: stamp,
  };
}

/** The address of the best picture for a cover: a video's thumbnail, else the first picture. */
export function coverUrl(group) {
  for (const p of group) for (const a of p.assets ?? []) {
    const u = a.type === 'video' ? a.thumbnail : (a.url ?? a.thumbnail);
    if (u) return u;
  }
  return null;
}

/**
 * Read Buffer (scheduled posts; the sent ones come from the last history pull) and copy what Nordle does not know onto the calendar.
 * `adapter`, `settings` and `fetchImpl` can be given so tests never touch the network.
 * @returns {{ok:true, created:number, updated:number, gone:number, requests:number, complete:boolean, covers:number, skipped:object, titles:string[]}}
 */
export async function importFromBuffer(store, { project: projectId, role, now = Date.now(), adapter = getAdapter('buffer'), settings = loadSettings(), fetchImpl = fetch, covers = true, days = IMPORT_DAYS, maxNew = MAX_NEW } = {}) {
  owner(role);
  const project = store.project(String(projectId ?? ''));
  if (!project) throw new PublishError(404, 'There is no such brand.');
  const s = resolveSettings(settings, 'buffer', project.id);
  if (!s.token) throw new PublishError(409, 'This brand has no Buffer account connected yet.');
  // only THIS brand's chosen channels: the account may hold other brands' channels too, and their posts do not belong on this calendar
  const chosen = [...new Set((s.channels ?? []).map((c) => c.id))];
  if (!chosen.length) throw new PublishError(409, 'This brand has no Buffer channels chosen yet.');
  const cache = s.channelCache ?? [];
  const names = new Map(cache.map((c) => [c.id, `${c.name} (${c.service})`]));
  const byOrg = new Map();
  for (const id of chosen) { const org = cache.find((c) => c.id === id)?.organizationId ?? s.organizationId; if (org) (byOrg.get(org) ?? byOrg.set(org, []).get(org)).push(id); }
  if (!byOrg.size) throw new PublishError(409, 'No Buffer organisation is known for this brand yet: test the connection in Publishing first.');

  // scheduled posts with their words and pictures: one request per 100 posts
  guardAllowance(s.account?.id, 'Looking for posts made in Buffer');
  const pending = [];
  let requests = 0, complete = true;
  for (const [organizationId, ids] of byOrg) {
    const r = await adapter.listPosts(s, { organizationId, channelIds: ids, filter: { status: GOING }, text: true, assets: true, maxPages: 5 });
    requests += r.pages;
    if (!r.complete) complete = false;
    pending.push(...r.posts);
  }
  const sentFile = readSentPosts(project.dir);
  const sent = sentFile.schema === BUFFER_POSTS_SCHEMA ? sentFile.posts : [];     // an older pull has no words or pictures to copy

  const { cal, timezone } = loadProject(project.dir);
  const tz = timezone ?? 'Australia/Melbourne';
  const byId = new Map();                                                          // a post can be in both lists in the hours between a send and the next pull: the sent one wins
  for (const p of [...pending, ...sent]) if (!byId.has(p.id) || p.status === 'sent') byId.set(p.id, p);
  const plan = planImport({ items: cal.items, posts: [...byId.values()], tz, now, dir: project.dir, pendingComplete: complete, since: now - days * 86400000, maxNew });

  const created = [];
  await mutateCalendar(project.dir, (c) => {
    for (const g of plan.create) { const it = itemFor(g.posts, { tz, cal: c, now, channelNames: names }); c.items.push(it); created.push({ id: it.id, posts: g.posts }); }
    const byId = new Map(c.items.map((i) => [i.id, i]));
    const stamp = new Date(now).toISOString();
    for (const u of plan.update) { const it = byId.get(u.id); if (it) { Object.assign(it, u.patch, { updated: stamp }); } }
    for (const id of plan.gone) { const it = byId.get(id); if (it) { it.status = 'rejected'; it.updated = stamp; it.notes = [it.notes, 'This post was removed in Buffer.'].filter(Boolean).join('\n'); } }
  });
  forget(calendarPath(project.dir));

  // the pictures come after, outside the calendar's lock (a slow picture must not hold the calendar still)
  let coverCount = 0;
  if (covers && created.length) {
    const done = [];
    for (const c of created) {
      const url = coverUrl(c.posts);
      if (!url) continue;
      try {
        const r = await downloadTo(join(project.dir, 'external', c.id, 'cover'), url, { kind: 'photo', fetchImpl, maxBytes: COVER_MAX_BYTES });
        done.push({ id: c.id, rel: `external/${c.id}/${basename(r.file)}` });
      } catch { /* a picture that cannot be fetched is not worth failing the import: the card shows without it */ }
    }
    if (done.length) {
      await mutateCalendar(project.dir, (c) => { for (const d of done) { const it = c.items.find((i) => i.id === d.id); if (it?.external) it.external.cover = d.rel; } });
      forget(calendarPath(project.dir));
      coverCount = done.length;
    }
  }

  if (created.length || plan.update.length || plan.gone.length) {
    appendAudit(project.dir, { event: 'buffer-import', adapter: 'buffer', account: s.account?.id, ok: true, by: 'owner', via: 'import', message: `Copied ${created.length} post${created.length === 1 ? '' : 's'} made in Buffer onto the calendar; ${plan.update.length} followed (moved or sent); ${plan.gone.length} removed in Buffer.` });
  }
  return { ok: true, created: created.length, updated: plan.update.length, gone: plan.gone.length, requests, complete, covers: coverCount, skipped: plan.skipped, titles: created.map((c) => c.id) };
}
