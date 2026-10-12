// The Studio's state, in one place, and everything derived from it (which posts are in view, the four figures, the queue).
// The server owns the data; this holds the last copy of it plus what the person is looking at.

import { api } from './api.js';

export const VIEWS = ['month', 'wall', 'list', 'queue', 'plan', 'create', 'insights', 'trash'];

export const S = {
  load: 'loading',            // loading | ready | error
  error: '',
  offline: false,
  today: '',
  todayOverride: '',
  rev: null,
  trashCount: 0,
  projects: [],
  posts: [],
  byUid: new Map(),
  view: 'month',
  brand: 'all',               // 'all' or a project id
  month: '',                  // YYYY-MM shown by the month view
  f: { format: '', status: '', month: '', q: '', needs: false, failing: false, when: '' },
  sel: null,                  // uid of the highlighted post
  open: false,                // the detail sheet is showing sel
  picked: new Set(),          // posts ticked for bulk sign-off
  sort: { key: 'date', dir: 1 },
  queue: { list: [], uid: null, decided: new Map() },
  undo: [],                   // [{tokens, label}] newest last
};

const subs = new Set();
let queued = false;
export function update(patch = {}) {
  Object.assign(S, patch);
  if (queued) return;
  queued = true;
  queueMicrotask(() => { queued = false; for (const fn of [...subs]) fn(); });
}
export const subscribe = (fn) => { subs.add(fn); return () => subs.delete(fn); };

// ---- dates (all strings are YYYY-MM-DD; arithmetic is done in UTC so daylight saving never moves a day) ---------------------------

const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
export const toIso = (ms) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (s, n) => toIso(parse(s) + n * 86400000);
export const dayOfWeek = (s) => (new Date(parse(s)).getUTCDay() + 6) % 7; // Monday = 0
export const monthOf = (s) => s.slice(0, 7);
export const addMonths = (ym, n) => { const [y, m] = ym.split('-').map(Number); const t = y * 12 + (m - 1) + n; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`; };
export const daysInMonth = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
export const diffDays = (a, b) => Math.round((parse(a) - parse(b)) / 86400000);
/** The local calendar day of a timestamp (the person's own day, not UTC's). */
export const localDay = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); };

const fmt = (opts) => new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', ...opts });
const F = {
  day: fmt({ weekday: 'short', day: 'numeric', month: 'short' }),
  long: fmt({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
  monthName: fmt({ month: 'long' }),
  monthShort: fmt({ month: 'short' }),
  monthYear: fmt({ month: 'long', year: 'numeric' }),
  weekday: fmt({ weekday: 'short' }),
  dm: fmt({ day: 'numeric', month: 'short' }),
};
export const dateFmt = {
  day: (s) => F.day.format(parse(s)),
  long: (s) => F.long.format(parse(s)),
  monthName: (ym) => F.monthName.format(parse(`${ym}-01`)),
  monthShort: (ym) => F.monthShort.format(parse(`${ym}-01`)),
  monthYear: (ym) => F.monthYear.format(parse(`${ym}-01`)),
  weekday: (s) => F.weekday.format(parse(s)),
  dm: (s) => F.dm.format(parse(s)),
  ago: (iso) => {
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms)) return '';
    const m = Math.round(ms / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} h ago`;
    return F.dm.format(new Date(iso).getTime());
  },
};

// ---- loading ------------------------------------------------------------------------------------------------------------------

function ingest(r) {
  const byUid = new Map(r.posts.map((p) => [p.uid, p]));
  update({
    load: 'ready', error: '', offline: false, rev: r.rev, trashCount: r.trashCount ?? 0, projects: r.projects, posts: r.posts, byUid,
    today: S.todayOverride || r.today, month: S.month || (S.todayOverride || r.today).slice(0, 7),
  });
}

/** Fetch the posts. Returns true when something new arrived. */
export async function load({ force = false } = {}) {
  try {
    const q = new URLSearchParams();
    if (S.todayOverride) q.set('today', S.todayOverride);
    if (!force && S.rev) q.set('since', S.rev);
    const r = await api.get(`/studio${q.size ? `?${q}` : ''}`);
    if (r.unchanged) { if (S.offline) update({ offline: false }); return false; }
    ingest(r);
    return true;
  } catch (e) {
    if (S.load === 'loading' || S.load === 'error') update({ load: 'error', error: e.message });
    else update({ offline: true });
    return false;
  }
}

/** Put one fresh post (from an action's answer) into the list straight away. */
export function patchPost(post) {
  if (!post) return;
  const i = S.posts.findIndex((p) => p.uid === post.uid);
  const posts = i >= 0 ? S.posts.map((p) => (p.uid === post.uid ? post : p)) : [...S.posts, post];
  update({ posts, byUid: new Map(posts.map((p) => [p.uid, p])) });
}

// ---- what is in view ----------------------------------------------------------------------------------------------------------

export const project = (id) => S.projects.find((p) => p.id === id);
export const inBrand = (p) => S.brand === 'all' || p.project === S.brand;

export const STATUS_GROUPS = {
  '': 'Any status',
  needs: 'Needs your review',
  changes: 'Changes requested',
  'signed-off': 'Signed off',
  scheduled: 'Scheduled',
  works: 'In the works',
  idea: 'Ideas',
  rejected: 'Rejected',
  posted: 'Posted',
};
const inGroup = (p, g) => {
  if (g === 'needs') return p.needsReview;
  if (g === 'works') return p.status === 'approved' || p.status === 'building';
  return p.status === g;
};

export function matches(p, f = S.f) {
  if (!inBrand(p)) return false;
  if (f.format && p.format !== f.format) return false;
  if (f.status) { if (!inGroup(p, f.status)) return false; } else if (p.status === 'rejected') return false;
  if (f.month && (p.date ?? '').slice(0, 7) !== f.month) return false;
  if (f.needs && !p.needsReview) return false;
  if (f.when === 'next7' && (!p.date || p.date < S.today || p.date > addDays(S.today, 6))) return false;
  if (f.when === 'built-today' && !(p.builtAt && localDay(p.builtAt) === S.today && ['built', 'changes', 'signed-off'].includes(p.status))) return false;
  if (f.failing && !p.failing) return false;
  if (f.q) {
    const hay = `${p.title} ${p.hook ?? ''} ${p.pillar ?? ''} ${p.idea ?? ''} ${project(p.project)?.name ?? ''} ${p.format} ${p.status}`.toLowerCase();
    for (const word of f.q.toLowerCase().split(/\s+/).filter(Boolean)) if (!hay.includes(word)) return false;
  }
  return true;
}

let cache = { posts: null, key: '', list: [] };
/** Posts that pass the brand and filters, in date order. */
export function visible() {
  const key = `${S.brand}|${JSON.stringify(S.f)}`;
  if (cache.posts === S.posts && cache.key === key) return cache.list;
  const list = S.posts.filter((p) => matches(p));
  cache = { posts: S.posts, key, list };
  return list;
}

export function figures() {
  const scope = S.posts.filter((p) => inBrand(p) && p.status !== 'rejected');
  const end = addDays(S.today, 6);
  return {
    needs: scope.filter((p) => p.needsReview).length,
    builtToday: scope.filter((p) => p.builtAt && localDay(p.builtAt) === S.today && ['built', 'changes', 'signed-off'].includes(p.status)).length,
    failing: scope.filter((p) => p.failing && p.status !== 'posted').length,
    next7: scope.filter((p) => p.date && p.date >= S.today && p.date <= end && p.status !== 'posted').length,
    verifiedNeeds: scope.filter((p) => p.needsReview && p.verified === true && !p.openComments).length,
  };
}

export function brandCounts() {
  const out = {};
  for (const pr of S.projects) {
    const mine = S.posts.filter((p) => p.project === pr.id && p.status !== 'rejected');
    out[pr.id] = { total: mine.length, needs: mine.filter((p) => p.needsReview).length };
  }
  return out;
}

export function months() {
  const set = new Set(S.posts.filter((p) => p.date && inBrand(p)).map((p) => monthOf(p.date)));
  if (S.today) set.add(monthOf(S.today));
  return [...set].sort();
}

// ---- the review queue ---------------------------------------------------------------------------------------------------------

export function needsList() {
  // The review queue is everything that waits for the owner, in the chosen brand. Only the queue's own 'Show' menu (a format, or
  // checks failing) narrows it: the calendar's month, search and date filters must never hide posts that need a decision.
  const { format, failing } = S.f;
  return S.posts.filter((p) => inBrand(p) && p.needsReview && p.status !== 'rejected' && (!format || p.format === format) && (!failing || p.failing));
}

/** Rebuild the queue for the current brand and filters, keeping what was decided this session in place. */
export function buildQueue(startUid) {
  const fresh = needsList();
  const order = fresh.map((p) => p.uid);
  const keep = [...S.queue.decided.keys()].filter((u) => !order.includes(u) && S.byUid.has(u) && inBrand(S.byUid.get(u)));
  const list = [...order, ...keep].sort((a, b) => {
    const pa = S.byUid.get(a), pb = S.byUid.get(b);
    return (pa.date ?? '9').localeCompare(pb.date ?? '9') || pa.project.localeCompare(pb.project) || a.localeCompare(b);
  });
  let uid = startUid && list.includes(startUid) ? startUid : S.queue.uid && list.includes(S.queue.uid) ? S.queue.uid : null;
  if (!uid) uid = list.find((u) => !S.queue.decided.has(u)) ?? list[0] ?? null;
  update({ queue: { ...S.queue, list, uid } });
  return list;
}
