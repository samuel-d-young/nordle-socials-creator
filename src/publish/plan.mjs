// Planning: look at posts the owner picked (or a whole month) and say, for one adapter, what would be sent, when, to which
// channels (a brand can have several, each with its own time offset and hashtag rule), and what stops it. A plan never touches the network and never changes a post. It is saved with an id, expires in 15
// minutes, and is bound to what it saw: the document version and file hash, the caption and alt text, every media file's hash,
// the calendar slot and the channel. A run (src/publish/index.mjs) re-reads all of it and refuses any post that has moved.
//
// What stops a post (blockers): not on the calendar, not built, not signed off (the owner may override a built or stale post one
// at a time), failing checks, no caption, a missing picture, a time in the past, or whatever the adapter says (no channel, no public
// address...). Everything else worth knowing is a warning.

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { detail, locate, mediaOf, parseUid, readJsonCached } from '../studio/data.mjs';
import { loadProject } from '../calendar/service.mjs';
import { DEFAULT_TIMEZONE, isDate, isMonth } from '../calendar/dates.mjs';
import { DEFAULT_POST_TIMES } from '../calendar/plan.mjs';
import { bundleFileName } from './adapters/bundle.mjs';
import { PLAN_TTL_MS, PublishError, loadSettings, newPlanId, resolveSettings, savePlan } from './store.mjs';
import { getCover } from './covers.mjs';

export const MAX_POSTS = 100;
const MIN_LEAD_MS = 10 * 60 * 1000;

// ---- time ----------------------------------------------------------------------------------------------------------------------

function offsetMs(utcMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(utcMs));
  const g = (t) => Number(parts.find((p) => p.type === t).value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - Math.floor(utcMs / 1000) * 1000;
}

/** A wall-clock date and time in an IANA timezone, as the instant it is (a Date). Handles daylight saving. */
export function zonedToUtc(date, time, timeZone) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const first = offsetMs(guess, timeZone);
  let utc = guess - first;
  const second = offsetMs(utc, timeZone);
  if (second !== first) utc = guess - second;
  return new Date(utc);
}

const validZone = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };

/** "2026-11-12 18:30" / "2026-11-12T18:30" (the brand's local time) or a full ISO time with Z or an offset. null if it is neither. */
export function parseWhen(input, timeZone) {
  const s = String(input ?? '').trim();
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(s) && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) { const t = new Date(s.replace(' ', 'T')); return Number.isNaN(t.getTime()) ? null : t; }
  const m = /^(\d{4}-\d{2}-\d{2})[T ]([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
  return m && isDate(m[1]) ? zonedToUtc(m[1], `${m[2]}:${m[3]}`, timeZone) : null;
}

const localLabel = (date, timeZone) => {
  try { return `${new Intl.DateTimeFormat('en-AU', { timeZone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(date)} (${timeZone})`; } catch { return date.toISOString(); }
};

// ---- small helpers -------------------------------------------------------------------------------------------------------------

const sha = (file) => new Promise((resolve, reject) => {
  const h = createHash('sha256');
  createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
});
const sha1 = (text) => createHash('sha256').update(String(text)).digest('hex');
const safeRel = (rel) => typeof rel === 'string' && rel && !rel.includes('..') && !rel.includes('\\') && !/^[A-Za-z]:|^\//.test(rel);

/** Drop the hashtag lines at the end of a caption (the block people add under the words). Hashtags inside a sentence are left alone. */
export function stripTrailingHashtags(text) {
  const lines = String(text).trimEnd().split('\n');
  while (lines.length) {
    const last = lines.at(-1).trim();
    if (last === '' || /^(#[\p{L}\p{N}_]+\s*)+$/u.test(last)) lines.pop(); else break;
  }
  return lines.join('\n').trimEnd();
}

/** The words that go out: the caption, then the hashtags that are not already in it ('keep'), or no hashtags at all ('strip'). */
export function composeCaption(copy, hashtags = 'keep') {
  const base = String(copy.caption ?? '').trim();
  if (hashtags === 'strip') return stripTrailingHashtags(base);
  const tags = (copy.hashtags ?? []).filter((t) => t && !base.toLowerCase().includes(String(t).toLowerCase()));
  return tags.length ? `${base}\n\n${tags.join(' ')}` : base;
}

/** The public face of a plan item: what the Studio and the tools show. Internals (the fingerprint, blocker flags) stay in the saved plan. */
export function publicItem(it) {
  const { fp, codes, ...rest } = it;   // eslint-disable-line no-unused-vars
  return rest;
}

/** The most a video can weigh and still be made into a Story (100 MB). */
export const STORY_MAX_BYTES = 100 * 1024 * 1024;

const channelOf = (entry, cached) => (entry ? { id: entry.id, name: cached?.name ?? entry.name ?? null, service: cached?.service ?? entry.service ?? null } : null);

// ---- one post ------------------------------------------------------------------------------------------------------------------

/**
 * Look at one post for one adapter. The post goes to every channel its brand has switched on that takes this format, so the answer is
 * a LIST: one { item, post, settings } per channel (or one blocked entry saying what is missing: no Buffer login for the brand, no
 * channels chosen, ...). `item` is the plan line (with fp and codes for the saved plan), `post` is the full object an adapter works
 * with (absolute paths included) and `settings` is what the adapter needs for this brand (including its token): none of the last two
 * ever goes to a client.
 * @param {object} settings the whole publish settings (see store.mjs loadSettings)
 * @param {Object<string,string[]>} [channels] per post: only these channel ids, for this one run
 */
export async function evaluatePost(store, uid, { adapter, settings, times = {}, channels: pick, stories = new Set(), now = Date.now(), cache = new Map() }) {
  const blockers = [], warnings = [];
  const block = (code, message, overridable = false) => blockers.push({ code, message, overridable });
  const parsed = parseUid(uid);
  const skeleton = (over = {}) => ({
    uid, key: uid, project: parsed?.project ?? null, docId: null, title: String(uid), when: null, whenLocal: null, channel: null, channelName: null, account: null, accountLabel: null,
    caption: '', media: [], blockers: [], warnings: [], blockerCodes: [], overridable: false, ready: false, format: null, status: null, adapter: adapter.id, ...over,
  });
  const finish = (item, bl, wr) => {
    item.blockers = bl.map((b) => b.message);
    item.warnings = wr;
    item.blockerCodes = bl.map((b) => b.code);
    item.codes = bl.map(({ code, overridable }) => ({ code, overridable }));
    item.ready = !bl.length;
    item.overridable = bl.length > 0 && bl.every((b) => b.overridable);
    return item;
  };
  const early = () => [{ item: finish(skeleton(), blockers, warnings), post: null, settings: null }];

  const at = locate(store, uid);
  if (!at) { block('no-post', 'There is no such post.'); return early(); }
  const { project, item: cal } = at;
  const d = detail(store, uid);
  if (!d) { block('no-post', 'There is no such post.'); return early(); }
  const docId = at.docId ?? cal?.id ?? null;
  const title = d.post.title ?? String(uid);
  const format = d.post.format;

  if (!cal) block('not-on-calendar', 'This post is not on the calendar, so it has no date or time. Add it to the calendar first.');
  else if (!at.docId && !cal.external) block('not-built', 'No post has been built for this calendar item yet.');

  // who said it is ready
  const status = d.post.status;
  if (cal) {
    if (status === 'scheduled') block('already-scheduled', `Already scheduled${cal.publish ? ` in ${cal.publish.adapter}${cal.publish.scheduledAt ? ` for ${cal.publish.scheduledAt}` : ''}` : ''}.`);
    else if (status === 'posted') block('posted', 'This post has already gone out.');
    else if (['idea', 'approved', 'building'].includes(status)) block('not-built', 'This post has not been built yet.');
    else if (status === 'changes') block('changes', 'You sent this post back for changes: it is not ready.');
    else if (status === 'rejected') block('rejected', 'This post was rejected.');
    else if (d.post.staleSignoff) block('stale-signoff', 'The post was edited after it was signed off. Sign it off again, or override this one.', true);
    else if (status === 'built') block('not-signed-off', 'Not signed off yet. Sign it off first, or override this one.', true);
    else if (status !== 'signed-off') block('not-signed-off', `Status "${status}" is not signed off.`);
  }

  // checks
  if (d.post.failing) block('checks-failing', `Checks are failing: ${(d.checks?.failed ?? []).slice(0, 4).join(', ') || 'see the post'}.`);
  else if (d.post.verified === false) warnings.push(`Some checks have not been recorded${d.checks?.missing?.length ? ` (${d.checks.missing.slice(0, 3).join(', ')}${d.checks.missing.length > 3 ? ', ...' : ''})` : ''}.`);
  if (d.post.openComments) warnings.push(`${d.post.openComments} open comment${d.post.openComments === 1 ? '' : 's'} on this post.`);

  // words
  const alt = d.copy.alt && typeof d.copy.alt === 'object' ? d.copy.alt : {};
  if (!String(d.copy.caption ?? '').trim()) block('no-caption', 'There is no caption.');

  // pictures
  const media = [];
  const exists = (rel) => safeRel(rel) && existsSync(join(project.dir, rel)) && statSync(join(project.dir, rel)).isFile();
  if (format === 'reel') {
    if (!d.media.video || !exists(d.media.video)) block('no-media', 'The video has not been rendered yet.');
    else if (d.media.outdated) block('video-outdated', 'The reel was edited after its video was made. Press "Make the video again" on the post first.');
    else media.push({ kind: 'video', rel: d.media.video, page: 'video', alt: alt.video ?? '' });
    if (d.media.poster && exists(d.media.poster)) media.push({ kind: 'cover', rel: d.media.poster, page: 'cover', alt: '' });
    else warnings.push('There is no cover image for this reel.');
  } else {
    const doc = at.docId ? readJsonCached(join(project.dir, 'docs', `${at.docId}.json`)) : null;
    const pages = doc ? mediaOf(project, at.docId, doc).pages : d.media.pages;
    if (!pages.length) block('no-media', 'There are no pictures: render the post first.');
    for (const p of pages) {
      if (!p.path || !exists(p.path)) block('page-missing', `Page "${p.title ?? p.id}" has not been rendered.`);
      else media.push({ kind: 'image', rel: p.path, page: p.id, alt: String(alt[p.id] ?? p.alt ?? '') });
    }
    const missingAlt = media.filter((m) => m.kind === 'image' && !m.alt.trim()).length;
    if (missingAlt) warnings.push(`${missingAlt} picture${missingAlt === 1 ? ' has' : 's have'} no alt text.`);
    if (format === 'post' && media.length > 1) warnings.push(`This is a single post with ${media.length} pictures: all are sent, as a carousel.`);
  }
  let pictureIndex = 0;
  for (const m of media) { m.abs = join(project.dir, m.rel); m.file = bundleFileName(m, m.kind === 'image' ? pictureIndex++ : 0, docId); }

  // the cover of a reel: the frame the owner chose in the Studio (or Nordle picked earlier), else the one the designer set; with neither, one is picked
  // automatically when the plan runs (src/studio/cover.mjs ensureCover), so Buffer is never left to use the first frame
  let coverTime = null, coverSource = null;
  if (format === 'reel' && cal) {
    const chosen = getCover(project.dir, cal.id);
    if (chosen) { coverTime = chosen.at; coverSource = chosen.auto ? 'auto' : 'chosen'; }
    else if (at.docId) {
      const tl = readJsonCached(join(project.dir, 'docs', `${at.docId}.json`))?.timeline;
      if (Number.isFinite(tl?.cover)) { coverTime = tl.cover; coverSource = 'designer'; }
    }
  }

  // when (before any channel's own offset)
  let proj = cache.get(project.dir);
  if (!proj) cache.set(project.dir, proj = loadProject(project.dir));
  const tz = validZone(proj.timezone) ? proj.timezone : DEFAULT_TIMEZONE;
  let baseWhen = null;
  if (cal?.date) {
    const defaultTime = proj.settings.postTimes?.[0] ?? DEFAULT_POST_TIMES[0];
    if (times[uid] !== undefined) {
      // "now" = as soon as the service will take it: the shortest lead time plus a minute, on a whole minute (worked out again when the plan runs)
      baseWhen = String(times[uid]).trim().toLowerCase() === 'now' ? new Date(Math.ceil((now + MIN_LEAD_MS + 60000) / 60000) * 60000) : parseWhen(times[uid], tz);
      if (!baseWhen) block('bad-time', `"${times[uid]}" is not a time. Use 2026-11-12 18:30 (the brand's own time), a full ISO time, or "now".`);
    } else baseWhen = zonedToUtc(cal.date, cal.time ?? defaultTime, tz);
  }

  // what the plan is bound to (the same for every channel of this post)
  const hashes = [];
  for (const m of media) { try { hashes.push({ rel: m.rel, sha: await sha(m.abs) }); } catch { hashes.push({ rel: m.rel, sha: null }); } }
  let docSha = null;
  try { docSha = at.docId ? sha1(readFileSync(join(project.dir, 'docs', `${at.docId}.json`))) : sha1(JSON.stringify(cal?.external ?? {})); } catch { /* the document went away */ }
  const bound = { v: d.docV, docSha, alt, slot: [cal?.date, cal?.time ?? null, format, cal?.id], hashes, adapter: adapter.id };

  // where: this brand's login and channels
  const s = resolveSettings(settings, adapter.id, project.id);
  const brandName = project.brand?.name ?? project.id;
  const service = adapter.accountName ?? adapter.name;
  const specs = [];
  if (adapter.needsAccount && !s.token) {
    specs.push({ entry: null, extra: [s.account
      ? { code: 'no-key', message: `The ${service} account "${s.account.label}" for ${brandName} has no API key yet: save one in the publishing settings.` }
      : { code: 'no-account', message: `Connect a ${service} account for ${brandName}: choose which ${service} account it publishes through in the publishing settings.` }] });
  } else if (!s.channels.length) {
    specs.push({ entry: null, extra: adapter.needsChannel ? [{ code: 'no-channel', message: `Choose the channels ${brandName} posts to: add at least one ${service} channel for it in the publishing settings.` }] : [] });
  } else {
    const on = s.channels.filter((e) => e.enabled);
    const chosen = pick && Array.isArray(pick[uid]) ? on.filter((e) => pick[uid].includes(e.id)) : on;
    const fits = chosen.filter((e) => e.formats.includes(format));
    if (fits.length) for (const entry of fits) specs.push({ entry });
    else {
      const message = !on.length ? `All of ${brandName}'s channels are switched off.` : !chosen.length ? `None of the channels chosen for this run belong to ${brandName}.` : `None of ${brandName}'s channels are set to take ${format} posts.`;
      specs.push({ entry: null, extra: [{ code: 'no-target', message }] });
    }
  }

  // the Story that can go with a post (same channel, same moment): the video, or the first picture. Only Instagram and Facebook take them.
  const storyMedia = media.some((m) => m.kind === 'video') ? media.filter((m) => m.kind === 'video') : media.filter((m) => m.kind === 'image').slice(0, 1);
  // A video over 100 MB is not made into a Story: the post goes out as usual and the plan says so, in words, on the post.
  let storyBytes = 0;
  for (const m of storyMedia) if (m.kind === 'video') { try { storyBytes += statSync(m.abs).size; } catch { /* a missing file is reported elsewhere */ } }
  const storyTooBig = storyBytes > STORY_MAX_BYTES;
  const storySkippedNote = `No Story was made: the video is ${Math.round(storyBytes / 1048576)} MB, over the ${STORY_MAX_BYTES / 1048576} MB limit for Stories. The post itself goes out as normal.`;
  const storyOk = (channel) => !!adapter.stories && ['instagram', 'facebook'].includes(channel?.service) && storyMedia.length > 0 && !storyTooBig;

  const out = [];
  for (const spec of specs) {
    const entry = spec.entry;
    const cached = s.channelCache.find((c) => c.id === entry?.id);
    const channel = channelOf(entry, cached);
    const variants = ['feed'];
    const storyNote = [];
    let storySkipped = null;
    if (stories.has(uid)) {
      if (storyOk(channel)) variants.push('story');
      else if (adapter.stories && ['instagram', 'facebook'].includes(channel?.service) && storyTooBig) { storySkipped = storySkippedNote; storyNote.push(storySkippedNote); }
      else storyNote.push(adapter.stories ? `A Story was asked for, but ${channel?.name ?? 'this channel'} cannot take one (only Instagram and Facebook can).` : `A Story was asked for, but ${adapter.name} cannot make Stories.`);
    }
    for (const variant of variants) {
      const story = variant === 'story';
      const bl = [...blockers, ...(spec.extra ?? [])];
      const wr = [...warnings, ...(story ? [] : storyNote)];
      const caption = story ? '' : composeCaption(d.copy, entry?.hashtags ?? 'keep');
      if (!story && !caption.trim() && String(d.copy.caption ?? '').trim()) bl.push({ code: 'no-caption', message: `Nothing is left of the caption once the hashtags are removed for ${channel?.name ?? channel?.id}.`, overridable: false });
      const when = baseWhen ? new Date(baseWhen.getTime() + (entry?.offsetMinutes ?? 0) * 60000) : null;
      const targetId = `${channel?.id ?? adapter.id}${story ? '#story' : ''}`;
      const mine = story ? storyMedia : media;
      const item = skeleton({
        key: channel ? `${uid}#${channel.id}${story ? '#story' : ''}` : uid, project: project.id, docId, title: story ? `${title} (Story)` : title, format, status, caption, media: mine.map((m) => m.rel),
        channel, channelName: channel?.name ?? null, account: s.account?.id ?? null, accountLabel: s.account?.label ?? null, ...(story ? { variant: 'story' } : {}), targetId,
        ...(format === 'reel' && !story ? { cover: { time: coverTime, source: coverSource ?? 'pending' } } : {}),
        ...(!story && storySkipped ? { storySkipped } : {}),
      });
      if (when) {
        item.when = when.toISOString();
        item.whenLocal = localLabel(when, tz);
        if (when.getTime() < now + MIN_LEAD_MS) bl.push({ code: 'past', message: `The time (${item.whenLocal}) has passed or is too close. Pick a later one for this run.`, overridable: false });
      }
      const done = adapter.marksScheduled !== false && cal?.publish?.adapter === adapter.id ? (cal.publish.targets ?? []).find((t) => t.ok && t.channel === targetId) : null;
      if (done && status !== 'scheduled') bl.push({ code: 'already-scheduled-channel', message: `Already scheduled${story ? ' as a Story' : ''} on ${channel?.name ?? channel?.id ?? adapter.name}${done.scheduledAt ? ` for ${done.scheduledAt}` : ''}.`, overridable: false });
      const post = {
        uid, project: project.id, projectDir: project.dir, itemId: cal?.id ?? null, docId, title, format, date: cal?.date ?? null, time: cal?.time ?? null,
        timezone: tz, when: item.when, whenLocal: item.whenLocal, caption, captionFull: composeCaption(d.copy, 'keep'), hashtags: d.copy.hashtags ?? [], media: mine, coverTime: story ? null : coverTime, channel,
        account: s.account ?? null, variant, targetId,
      };
      if (adapter.plan) {
        const r = await adapter.plan(post, { settings: s, now });
        for (const b of r.blockers ?? []) bl.push({ code: b.code ?? 'adapter', message: b.message ?? String(b), overridable: false });
        wr.push(...(r.warnings ?? []));
      }
      finish(item, bl, wr);
      item.fp = sha1(JSON.stringify({ ...bound, caption, channel: channel?.id ?? null, cfg: entry ? [entry.offsetMinutes, entry.hashtags] : null, account: s.account?.id ?? null, ...(story ? { variant } : {}) }));
      out.push({ item, post, settings: s });
    }
  }
  return out;
}

// ---- a plan --------------------------------------------------------------------------------------------------------------------

/** The uids a month of a project (or every project) holds: everything but ideas and rejects, so blockers explain what is missing. */
export function uidsForMonth(store, { project, month }) {
  if (!isMonth(month)) throw new PublishError(400, 'month must look like 2026-11.');
  const projects = store.scan().filter((p) => !project || p.id === project);
  if (project && !projects.length) throw new PublishError(404, `There is no project "${project}".`);
  const out = [];
  for (const p of projects) {
    const cal = readJsonCached(join(p.dir, 'calendar.json'));
    for (const it of cal?.items ?? []) if (it.date.startsWith(month) && !['idea', 'rejected'].includes(it.status)) out.push({ uid: `${p.id}:${it.id}`, date: it.date, time: it.time ?? '' });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.uid.localeCompare(b.uid)).map((x) => x.uid);
}

/** channels: { <uid>: [channel ids] } -> the same, checked. */
function cleanPick(channels) {
  if (channels === undefined || channels === null) return undefined;
  if (typeof channels !== 'object' || Array.isArray(channels)) throw new PublishError(400, 'channels must be {"<uid>": ["<channel id>", ...]}.');
  const out = {};
  for (const [uid, list] of Object.entries(channels)) {
    if (!Array.isArray(list) || list.some((c) => typeof c !== 'string')) throw new PublishError(400, 'channels must be {"<uid>": ["<channel id>", ...]}.');
    out[uid] = list;
  }
  return out;
}

export const MAX_ITEMS = 400;

/**
 * Make, save and return a plan: one item per post per channel.
 * @param {object} store the server's Store
 * @param {{adapter:object, uids?:string[], project?:string, month?:string, times?:Object<string,string>, channels?:Object<string,string[]>, role?:'human'|'agent', via?:string, now?:number}} o
 */
export async function buildPlan(store, { adapter, uids, project, month, times = {}, channels, stories, role = 'agent', via = 'studio', now = Date.now() }) {
  let list;
  if (Array.isArray(uids) && uids.length) list = [...new Set(uids.map(String))];
  else if (month) list = uidsForMonth(store, { project, month });
  else throw new PublishError(400, 'Say which posts: {"uids":["project:item", ...]} or {"project":"id","month":"2026-11"}.');
  if (!list.length) throw new PublishError(404, 'There are no posts to plan.');
  if (list.length > MAX_POSTS) throw new PublishError(400, `At most ${MAX_POSTS} posts in one plan (asked for ${list.length}).`);
  if (times && typeof times !== 'object') throw new PublishError(400, 'times must be {"<uid>": "2026-11-12 18:30"}.');
  const pick = cleanPick(channels);
  const withStories = new Set((Array.isArray(stories) ? stories : stories && typeof stories === 'object' ? Object.keys(stories).filter((k) => stories[k]) : []).map(String).filter((u) => list.includes(u)));
  const settings = loadSettings();
  const cache = new Map();
  const items = [];
  for (const uid of list) for (const t of await evaluatePost(store, uid, { adapter, settings, times, channels: pick, stories: withStories, now, cache })) items.push(t.item);
  if (items.length > MAX_ITEMS) throw new PublishError(400, `That is ${items.length} posts-to-channels in one plan: ask for fewer posts (at most ${MAX_ITEMS}).`);
  const plan = {
    planId: newPlanId(), adapter: adapter.id, created: new Date(now).toISOString(), expires: new Date(now + PLAN_TTL_MS).toISOString(), by: role, via,
    times: Object.fromEntries(Object.entries(times ?? {}).filter(([uid]) => list.includes(uid))),
    channels: pick ? Object.fromEntries(Object.entries(pick).filter(([uid]) => list.includes(uid))) : {},
    stories: [...withStories],
    items, summary: { ready: items.filter((i) => i.ready).length, blocked: items.filter((i) => !i.ready).length },
  };
  savePlan(plan);
  return plan;
}

/** What goes over the wire: the plan without its fingerprints and blocker flags. */
export function publicPlan(plan) {
  return { planId: plan.planId, adapter: plan.adapter, expires: plan.expires, items: plan.items.map(publicItem), summary: plan.summary };
}
