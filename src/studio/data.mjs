// What the Studio shows: every project's posts in one pass, and one post in full. Pure reads, no rendering.
// Sources: calendar.json, docs/*.json, review/<doc>.json, checks/<doc>.json, out/<doc>/ (pictures and video), history/<doc>.jsonl
// (only its last line, for the document version). Nothing here changes a file; actions live in actions.mjs.

import { getCoverTime } from '../publish/covers.mjs';
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { readRunLock } from '../calendar/lock.mjs';
import { DEFAULT_LEAD_DAYS } from '../calendar/plan.mjs';
import { DEFAULT_TIMEZONE, addDays } from '../calendar/dates.mjs';
import { requiredChecks, verificationStatus } from '../verify/store.mjs';

// ---- cached JSON ----------------------------------------------------------------------------------------------------------

const jcache = new Map();
/** Parsed JSON, re-read only when the file's size or time changes. Callers must not change what they get back. */
export function readJsonCached(file) {
  let st;
  try { st = statSync(file); } catch { jcache.delete(file); return null; }
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = jcache.get(file);
  if (hit && hit.key === key) return hit.value;
  let value = null;
  try { value = JSON.parse(readFileSync(file, 'utf8')); } catch { value = null; }
  jcache.set(file, { key, value });
  return value;
}
export const forget = (file) => jcache.delete(file);

const hcache = new Map();
/** The `v` of the last line of a history file, reading only the end of it. */
function lastHistoryV(file) {
  let st;
  try { st = statSync(file); } catch { return 0; }
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = hcache.get(file);
  if (hit && hit.key === key) return hit.v;
  let v = 0;
  let fd;
  try {
    fd = openSync(file, 'r');
    let window = Math.min(st.size, 16384);
    for (;;) {
      const buf = Buffer.alloc(window);
      readSync(fd, buf, 0, window, st.size - window);
      const text = buf.toString('utf8').replace(/\s+$/, '');
      const nl = text.lastIndexOf('\n');
      if (nl >= 0 || window >= st.size) {
        try { v = JSON.parse(text.slice(nl + 1)).v ?? 0; } catch { v = text.split('\n').length; }
        break;
      }
      window = Math.min(st.size, window * 4);
    }
  } catch { v = 0; } finally { if (fd !== undefined) closeSync(fd); }
  hcache.set(file, { key, v });
  return v;
}

// ---- small helpers --------------------------------------------------------------------------------------------------------

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const iso = (ms) => new Date(ms).toISOString();
const sizeIdOf = (s) => (typeof s === 'string' ? s : s?.id);

export const CHECK_LABELS = {
  technical: 'Renders cleanly (sizes, text fits)',
  compliance: 'Health-advertising rules',
  facts: 'Facts are sourced',
  copy: 'Caption and alt text',
  'media-match': 'Words match the picture',
  brief: 'Does what the idea asked',
  design: 'Design quality',
  'speech-cuts': 'Nobody cut off mid-sentence',
  broll: 'Cutaways fit what is said',
  audio: 'Sound levels',
  uniqueness: 'No repeated photo or hook',
};
export const WHO_LABELS = { auto: 'Automatic', designer: 'The designer', reviewer: 'A second reviewer', owner: 'You' };

/** Today's date (YYYY-MM-DD) in a timezone; `override` lets tests and screenshots pin it. */
export function todayIn(timezone, override) {
  if (typeof override === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(override)) return override;
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: timezone || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export function initials(name) {
  const words = String(name ?? '').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return '??';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

const FALLBACK_LANES = ['#2F6F8F', '#B5651D', '#6B4C9A', '#3E7D4F'];
/** A brand's lane colour: its accent when that is a real colour (not near white, black or grey), else its most saturated mid-tone. */
function laneColor(brand, index) {
  const colors = Object.values(brand?.colors ?? {}).filter((c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c));
  let best = null;
  let bestScore = -1;
  const score = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
    return l > 0.86 || l < 0.12 ? 0 : s * (1 - Math.abs(l - 0.45));
  };
  const named = brand?.colors?.accent ?? brand?.colors?.primary;
  if (typeof named === 'string' && /^#[0-9a-f]{6}$/i.test(named) && score(named) >= 0.3) return named;
  for (const hex of colors) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
    if (l > 0.86 || l < 0.12) continue;
    const score = s * (1 - Math.abs(l - 0.45));
    if (score > bestScore) { bestScore = score; best = hex; }
  }
  return best && bestScore > 0.12 ? best : (colors.find((c) => c === brand?.colors?.accent) ?? FALLBACK_LANES[index % FALLBACK_LANES.length]);
}

// ---- reading one project's documents -------------------------------------------------------------------------------------------

function docOf(project, id) {
  const live = project.docs.get(id);
  if (live) return { doc: live.doc, v: live.v, file: live.file };
  const file = join(project.dir, 'docs', `${id}.json`);
  const doc = readJsonCached(file);
  if (!doc || !String(doc.schema ?? '').startsWith('nordle.doc/')) return null;
  return { doc, v: lastHistoryV(join(project.dir, 'history', `${id}.jsonl`)), file };
}

export const EMPTY_REVIEW = { comments: [], versions: [], approvals: [], changes: [] };
function reviewOf(project, id) {
  const live = project.reviews.get(id);
  if (live) return live.data;
  return readJsonCached(join(project.dir, 'review', `${id}.json`)) ?? EMPTY_REVIEW;
}
/** Comments on a post that was made outside Nordle live in review/ext-<item>.json (same shape as a document's review). */
export const extReviewId = (itemId) => `ext-${itemId}`.slice(0, 64).replace(/-+$/, '');
export const extReviewFile = (project, itemId) => join(project.dir, 'review', `${extReviewId(itemId)}.json`);
function extReview(project, itemId) {
  return readJsonCached(extReviewFile(project, itemId)) ?? EMPTY_REVIEW;
}
function checksOf(project, id) {
  const rec = readJsonCached(join(project.dir, 'checks', `${id}.json`));
  return rec && Array.isArray(rec.entries) ? rec : { entries: [] };
}
function listOut(project, docId) {
  try { return readdirSync(join(project.dir, 'out', docId)); } catch { return []; }
}

/** The pictures a document has rendered: pages of the first size, a cover for video, a video file. */
export function mediaOf(project, docId, doc) {
  const files = listOut(project, docId);
  const out = (n) => `out/${docId}/${n}`;
  const re = new RegExp(`^${esc(docId)}_(.+)_(\\d{2})-(.+)\\.(png|jpe?g|webp)$`, 'i');
  const bySize = new Map();
  for (const f of files) {
    const m = re.exec(f);
    if (!m || /\.safe$/.test(m[3])) continue;
    const list = bySize.get(m[1]) ?? [];
    list.push({ n: Number(m[2]), page: m[3], file: f });
    bySize.set(m[1], list);
  }
  const wanted = (doc?.sizes ?? []).map(sizeIdOf).filter(Boolean);
  const sizeId = wanted.find((s) => bySize.has(s)) ?? [...bySize.keys()].sort()[0] ?? null;
  const rendered = sizeId ? bySize.get(sizeId).sort((a, b) => a.n - b.n) : [];
  const pages = [];
  if (doc?.kind !== 'video') {
    const known = new Map(rendered.map((r) => [r.page, r]));
    for (const p of doc?.pages ?? []) {
      const r = known.get(p.id);
      pages.push({ id: p.id, title: p.title ?? p.id, path: r ? out(r.file) : null });
    }
    if (!pages.length) for (const r of rendered) pages.push({ id: r.page, title: r.page, path: out(r.file) });
  }
  const video = files.find((f) => f === `${docId}.mp4`) ?? files.find((f) => /\.(mp4|webm|mov)$/i.test(f)) ?? null;
  const cover = files.find((f) => new RegExp(`^${esc(docId)}-cover\\.(jpe?g|png|webp)$`, 'i').test(f)) ?? files.find((f) => /-cover\.(jpe?g|png|webp)$/i.test(f)) ?? null;
  return { sizeId, pages, video: video ? out(video) : null, cover: cover ? out(cover) : null, sheet: files.includes('sheet.png') ? out('sheet.png') : null };
}

/**
 * Was the video's picture or sound changed in the editor after its finished file was made? Read from the edit history: an entry that
 * touches more than the words (/copy, /title) and is newer than the file. Edits made outside the editor leave no history and do not count.
 */
export function videoOutdated(project, docId, videoRel) {
  let text, made;
  try { text = readFileSync(join(project.dir, 'history', `${docId}.jsonl`), 'utf8'); made = statSync(join(project.dir, videoRel)).mtimeMs; } catch { return false; }
  let last = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if ((e.ops ?? []).some((o) => !/^\/(copy|title)(\/|$)/.test(o.path ?? ''))) last = Math.max(last, Date.parse(e.ts) || 0);
  }
  return last > made;
}

function formatOf(item, doc) {
  if (item?.format) return item.format;
  if (doc?.kind === 'video') return 'reel';
  if ((doc?.sizes ?? []).map(sizeIdOf).some((s) => /story/.test(s ?? ''))) return 'story';
  return doc?.kind === 'graphic' ? 'post' : 'carousel';
}

const firstLine = (s) => String(s ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';

function countChecks(doc, v, rec) {
  const out = { total: 0, pass: 0, warn: 0, fail: 0, missing: 0 };
  for (const req of requiredChecks(doc)) {
    for (const by of req.by) {
      out.total += 1;
      const e = rec.entries.filter((x) => x.check === req.check && x.by === by && x.v === v).at(-1);
      if (!e) out.missing += 1;
      else if (e.status === 'fail') out.fail += 1;
      else if (e.status === 'warn') out.warn += 1;
      else out.pass += 1;
    }
  }
  return out;
}

function scoreOf(project, docId, rec, v) {
  const designs = rec.entries.filter((e) => e.check === 'design' && typeof e.score === 'number');
  const now = designs.filter((e) => e.v === v).at(-1);
  if (now) return { score: now.score, stale: false };
  const live = project.docs.get(docId)?.lastCritique;
  if (live && live.v === v && typeof live.score === 'number') return { score: live.score, stale: false };
  const old = designs.at(-1);
  return old ? { score: old.score, stale: true } : { score: null, stale: false };
}

const activeApproval = (review) => [...(review.approvals ?? [])].reverse().find((a) => !a.revoked) ?? null;

/** One post, as the grids and lists need it. */
/**
 * Is Claude working on this post, and if not, when will it be? Only for posts that are approved (queued) or being built.
 *   active   a build or a change is running right now (the run lock names this post and its process is alive)
 *   stalled  the post says "building" but nothing is running: the run stopped, and it will be tried again
 *   startsOn the day the build begins (the post's date minus the lead time); due = that day has come
 *   ahead    how many approved posts are due sooner, so "3 ahead of it" can be said
 */
function buildOf(project, item, calendar) {
  if (!item || !['approved', 'building'].includes(item.status)) return null;
  let lock = null;
  try { lock = readRunLock(project.dir); } catch { /* no lock */ }
  const lead = calendar?.settings?.leadDays ?? DEFAULT_LEAD_DAYS;
  const today = todayIn(calendar?.timezone ?? DEFAULT_TIMEZONE, process.env.NORDLE_TODAY);
  const startsOn = addDays(item.date, -lead);
  if (item.status === 'building') {
    const active = !!lock && (lock.item === item.id || (lock.item == null && item.run?.state === 'building'));
    return {
      phase: 'building', active, stalled: !active, mode: item.doc ? 'change' : 'build',
      since: active ? lock.started ?? item.run?.startedAt ?? null : item.run?.startedAt ?? null,
      attempt: item.run?.attempts ?? null, maxAttempts: calendar?.settings?.maxBuildAttempts ?? 3,
      busyWith: null,
    };
  }
  const items = Array.isArray(calendar?.items) ? calendar.items : [];
  const ahead = items.filter((i) => i.status === 'approved' && i.id !== item.id && (i.date < item.date || (i.date === item.date && i.id < item.id))).length
    + items.filter((i) => i.status === 'building').length;
  return { phase: 'queued', active: false, startsOn, due: today >= startsOn, leadDays: lead, autoBuild: !!calendar?.settings?.autoBuild, ahead, busy: !!lock, attempt: item.run?.attempts ?? null, lastError: item.run?.lastError ?? null };
}

function summarize(project, lane, item, docId, calendar) {
  const info = docId ? docOf(project, docId) : null;
  const doc = info?.doc ?? null;
  const ext = item?.external ?? null;
  const review = doc ? reviewOf(project, docId) : ext ? extReview(project, item.id) : null;
  const rec = doc ? checksOf(project, docId) : null;
  const media = doc ? mediaOf(project, docId, doc) : null;

  let status = item?.status ?? null;
  const approval = review ? activeApproval(review) : null;
  const approvalStale = !!(approval && info && approval.docV !== info.v);
  if (!item) status = approval && !approvalStale ? 'signed-off' : 'built';
  else if (status === 'built' && approval && !approvalStale) status = 'signed-off';
  const staleSignoff = status === 'signed-off' && approvalStale;
  const needsReview = status === 'built' || staleSignoff;

  const checks = doc ? countChecks(doc, info.v, rec) : null;
  const verification = doc ? verificationStatus(doc, info.v, rec) : null;
  const sc = doc ? scoreOf(project, docId, rec, info.v) : { score: null, stale: false };

  const caption = doc?.copy?.caption ?? ext?.caption ?? '';
  const format = formatOf(item, doc);
  const thumb = media?.pages.find((p) => p.path)?.path ?? media?.cover ?? ext?.cover ?? ext?.slides?.[0] ?? null;
  const video = media?.video ?? ext?.video ?? null;
  const openComments = review ? (review.comments ?? []).filter((c) => c.status === 'open').length : 0;
  const pendingChanges = review ? (review.changes ?? []).filter((c) => c.status === 'pending').length : 0;
  let builtAt = item?.updated ?? null;
  if (info?.file) { try { builtAt = iso(statSync(info.file).mtimeMs); } catch { /* keep item.updated */ } }

  const pageCount = format === 'reel' ? 0 : (media?.pages.length || ext?.slides?.length || (thumb ? 1 : 0));
  return {
    uid: `${project.id}:${item ? item.id : `~${docId}`}`,
    project: project.id,
    lane,
    itemId: item?.id ?? null,
    docId: docId ?? null,
    date: item?.date ?? null,
    time: item?.time ?? null,
    format,
    title: item?.title ?? doc?.title ?? docId,
    pillar: item?.pillar ?? null,
    hook: item?.hook || firstLine(caption) || null,
    idea: item?.idea ?? null,
    status,
    needsReview,
    staleSignoff,
    kind: doc?.kind ?? null,
    pages: pageCount,
    thumb,
    video,
    external: !!ext,
    score: sc.score,
    scoreStale: sc.stale,
    checks: checks ? { ...checks, verified: !!verification?.verified } : null,
    verified: verification ? verification.verified : null,
    failing: !!(checks && checks.fail > 0),
    approvedAt: approval && !approvalStale ? approval.date : null,
    approvalStale,
    build: buildOf(project, item, calendar),
    campaign: item?.campaign ?? null,
    revising: !!(item && item.status === 'building' && item.doc),   // the designer is changing a post the owner sent back
    // the designer has made what the owner asked for and the post is back for another look ("Updated"); false once it is signed off again
    revised: !!(item && item.status === 'built' && needsReview && (item.feedback ?? []).some((f) => (f.by ?? 'owner') === 'owner' && f.resolved)),
    revisedAt: item && item.status === 'built' ? item.run?.lastAt ?? null : null,
    reviseFailed: !!(item && item.status === 'changes' && item.doc && ['failed', 'gave-up'].includes(item.run?.state)),
    autoRevise: calendar?.settings?.autoRevise !== false,                // "Request changes" starts the designer at once unless the owner turned that off
    openComments,
    pendingChanges,
    builtAt,
    updated: item?.updated ?? builtAt,
    hasCaption: !!caption,
    calendar: !!item,
  };
}

/** Every project, every post. `today` pins "today" (tests); otherwise each calendar's timezone decides. */
export function collect(store, { today } = {}) {
  const projects = [];
  const posts = [];
  // a project can opt out of the Studio ({"studio": {"hidden": true}} in nordle.project.json), e.g. the sample
  const all = store.scan().filter((project) => readJsonCached(join(project.dir, 'nordle.project.json'))?.studio?.hidden !== true);
  all.forEach((project, index) => {
    const brand = readJsonCached(join(project.dir, 'brand.json')) ?? {};
    const calendar = readJsonCached(join(project.dir, 'calendar.json'));
    const items = Array.isArray(calendar?.items) ? calendar.items : [];
    const lane = laneColor(brand, index);
    const linked = new Set(items.map((i) => i.doc).filter(Boolean));
    for (const item of items) posts.push(summarize(project, lane, item, item.doc && docOf(project, item.doc) ? item.doc : null, calendar));
    let files = [];
    try { files = readdirSync(join(project.dir, 'docs')).filter((f) => f.endsWith('.json')); } catch { /* no docs yet */ }
    for (const f of files) {
      const id = basename(f, '.json');
      if (linked.has(id)) continue;
      const d = docOf(project, id);
      if (!d || d.doc.explore) continue;
      posts.push(summarize(project, lane, null, id, calendar));
    }
    projects.push({
      id: project.id,
      name: brand.name ?? project.id,
      short: initials(brand.name ?? project.id),
      color: lane,
      colors: brand.colors ?? {},
      handle: brand.links?.handle ?? null,
      timezone: calendar?.timezone ?? null,
      hasCalendar: !!calendar,
      campaigns: calendar?.campaigns ?? [],
      settings: {
        perMonth: calendar?.settings?.perMonth ?? null,
        pillars: calendar?.settings?.pillars ?? [],
        leadDays: calendar?.settings?.leadDays ?? null,
      },
    });
  });
  posts.sort((a, b) => (a.date ?? '9999-99-99').localeCompare(b.date ?? '9999-99-99') || (a.time ?? '').localeCompare(b.time ?? '') || a.project.localeCompare(b.project) || a.uid.localeCompare(b.uid));
  const tz = projects.find((p) => p.timezone)?.timezone;
  const now = todayIn(tz, today);
  const body = { today: now, projects, posts };
  const rev = createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 12);
  return { rev, generatedAt: new Date().toISOString(), ...body };
}

// ---- one post in full -------------------------------------------------------------------------------------------------------

export function parseUid(uid) {
  const s = String(uid ?? '');
  const i = s.indexOf(':');
  if (i < 1) return null;
  const project = s.slice(0, i);
  const rest = s.slice(i + 1);
  if (!rest) return null;
  return rest.startsWith('~') ? { project, itemId: null, docId: rest.slice(1) } : { project, itemId: rest, docId: null };
}

/** Find the calendar item and document behind a uid. */
export function locate(store, uid) {
  const p = parseUid(uid);
  const project = p && store.project(p.project);
  if (!project) return null;
  const calendar = readJsonCached(join(project.dir, 'calendar.json'));
  const item = p.itemId ? (calendar?.items ?? []).find((i) => i.id === p.itemId) ?? null : null;
  if (p.itemId && !item) return null;
  const docId = p.docId ?? item?.doc ?? null;
  if (docId && !docOf(project, docId)) return p.docId ? null : { project, item, docId: null, calendar };
  return { project, item, docId, calendar };
}

/** The grid summary of one located post (used after an action so the page can update that post at once). */
export function summaryFor(store, at) {
  const index = Math.max(0, store.scan().findIndex((p) => p.id === at.project.id));
  const lane = laneColor(readJsonCached(join(at.project.dir, 'brand.json')) ?? {}, index);
  return summarize(at.project, lane, at.item, at.docId, at.calendar);
}

function captionLimit(project, doc) {
  const presets = project.platforms?.presets ?? [];
  const limits = (doc?.sizes ?? []).map((s) => presets.find((p) => p.id === sizeIdOf(s))?.maxCaption).filter(Boolean);
  return limits.length ? Math.min(...limits) : 2200;
}

export function detail(store, uid) {
  const at = locate(store, uid);
  if (!at) return null;
  const { project, item, docId, calendar } = at;
  const lane = laneColor(readJsonCached(join(project.dir, 'brand.json')) ?? {}, Math.max(0, store.scan().findIndex((p) => p.id === project.id)));
  const info = docId ? docOf(project, docId) : null;
  const doc = info?.doc ?? null;
  const review = doc ? reviewOf(project, docId) : item?.external ? extReview(project, item.id) : null;
  const rec = doc ? checksOf(project, docId) : null;
  const post = summarize(project, lane, item, docId, calendar);
  const media = doc ? mediaOf(project, docId, doc) : null;
  const ext = item?.external ?? null;

  // the pictures
  let pages = [];
  if (media?.pages.length) pages = media.pages.filter((p) => p.path).map((p) => ({ ...p, alt: doc.copy?.alt?.[p.id] ?? '' }));
  else if (ext?.slides?.length) pages = ext.slides.map((s, i) => ({ id: `slide-${i + 1}`, title: `Slide ${i + 1}`, path: s, alt: '' }));
  else if (post.thumb && post.format !== 'reel') pages = [{ id: 'cover', title: 'Cover', path: post.thumb, alt: doc?.copy?.alt?.cover ?? '' }];
  const mediaOut = {
    kind: post.video ? 'video' : pages.length ? 'carousel' : 'none',
    pages,
    video: post.video,
    poster: media?.cover ?? ext?.cover ?? null,
    coverTime: item?.id ? getCoverTime(project.dir, item.id) : null,
    sheet: media?.sheet ?? null,
    alt: doc?.copy?.alt?.video ?? '',
    editable: !!(doc && doc.kind === 'video'),
    outdated: doc?.kind === 'video' && media?.video ? videoOutdated(project, docId, media.video) : false,
  };

  // the words
  const copy = {
    caption: doc?.copy?.caption ?? ext?.caption ?? '',
    cta: doc?.copy?.cta ?? '',
    hashtags: (doc?.copy?.hashtags ?? ext?.hashtags ?? []).map((t) => (String(t).startsWith('#') ? t : `#${t}`)),
    alt: doc?.copy?.alt ?? {},
    limit: captionLimit(project, doc),
  };

  // the checks, one row per (check, who), missing ones included
  let checks = null;
  let pairs = null;
  let critique = null;
  if (doc) {
    const v = info.v;
    const rows = [];
    const seen = new Set();
    const push = (check, by) => {
      const key = `${check}/${by}`;
      if (seen.has(key)) return;
      seen.add(key);
      const entries = rec.entries.filter((x) => x.check === check && x.by === by);
      const now = entries.filter((x) => x.v === v).at(-1);
      const last = entries.at(-1);
      rows.push(now
        ? { check, label: CHECK_LABELS[check] ?? check, by, who: WHO_LABELS[by] ?? by, status: now.status, at: now.at, v: now.v, score: now.score ?? null, summary: now.summary ?? '', findings: now.findings ?? [], required: requiredChecks(doc).some((r) => r.check === check && r.by.includes(by)) }
        : { check, label: CHECK_LABELS[check] ?? check, by, who: WHO_LABELS[by] ?? by, status: 'missing', required: true, staleFrom: last ? { v: last.v, status: last.status, at: last.at } : null, summary: '', findings: [] });
    };
    for (const req of requiredChecks(doc)) for (const by of req.by) push(req.check, by);
    for (const e of rec.entries) if (e.v === v) push(e.check, e.by);
    const vs = verificationStatus(doc, v, rec);
    checks = { v, verified: vs.verified, missing: vs.missing, failed: vs.failed, rows };

    const withPairs = rec.entries.filter((e) => e.check === 'media-match' && e.pairs?.length);
    const pick = withPairs.filter((e) => e.v === v).at(-1) ?? withPairs.at(-1);
    if (pick) {
      pairs = {
        by: pick.by, who: WHO_LABELS[pick.by] ?? pick.by, at: pick.at, v: pick.v, stale: pick.v !== v,
        items: pick.pairs.map((p) => ({
          ...p,
          mediaThumb: /^(assets|out|sources)\/[^:]+\.(png|jpe?g|webp)$/i.test(p.media ?? '') ? p.media : null,
          pageThumb: pages.find((pg) => pg.id === p.page)?.path ?? null,
        })),
      };
    }
    const d = rec.entries.filter((e) => e.check === 'design').at(-1);
    if (d || post.score !== null) critique = { score: post.score, stale: post.scoreStale, pass: 88, summary: d?.summary ?? '', findings: d?.findings ?? [], by: d?.by ?? null, at: d?.at ?? null };
  }

  const comments = review ? (review.comments ?? []).map((c) => ({ ...c, pageTitle: doc?.pages?.find((p) => p.id === c.page)?.title ?? c.page })) : [];
  const approval = review ? activeApproval(review) : null;
  const itemOut = item ? {
    id: item.id, date: item.date, time: item.time ?? null, format: item.format, title: item.title, pillar: item.pillar ?? null, idea: item.idea ?? null, hook: item.hook ?? null,
    audience: item.audience ?? null, occasion: item.occasion ?? null, mediaPlan: item.mediaPlan ?? null, status: item.status, origin: item.origin ?? null, notes: item.notes ?? null,
    note: ext?.note ?? null, publish: item.publish ?? null,
    run: item.run ? { state: item.run.state ?? null, attempts: item.run.attempts ?? 0, startedAt: item.run.startedAt ?? null, lastAt: item.run.lastAt ?? null, lastError: item.run.lastError ?? null } : null,
    feedback: (item.feedback ?? []).slice(-5).map((f) => ({ at: f.at, by: f.by ?? 'owner', comment: f.comment, resolved: f.resolved ?? null })),
  } : null;

  return {
    post,
    item: itemOut,
    brief: doc?.brief ?? null,
    copy,
    media: mediaOut,
    checks,
    critique,
    pairs,
    comments,
    versions: review ? review.versions ?? [] : [],
    approval: approval ? { ...approval, stale: info ? approval.docV !== info.v : false } : null,
    approvals: review ? review.approvals ?? [] : [],
    pendingChanges: review ? (review.changes ?? []).filter((c) => c.status === 'pending').map((c) => ({ id: c.id, note: c.note, summary: c.summary ?? [], mode: c.mode, created: c.created })) : [],
    docV: info?.v ?? null,
    sizes: (doc?.sizes ?? []).map(sizeIdOf),
    tags: doc?.tags ?? [],
  };
}
