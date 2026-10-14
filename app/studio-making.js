// The "being made" banner: a small bar at the top of the Studio, on every page, that says what Claude is making right now, how many are in line, what did
// not finish and what has just finished. "Show" opens the list right under it (every brand, in order), so after "Make them now" you can always see where
// your posts are. Data: the Studio's posts (status and build progress) plus GET /api/making (the job line and the revisions, held in the server's memory).

import { api } from './api.js';
import { h, icon } from './dom.js';
import { S, dateFmt, load, project } from './studio-store.js';
import { FORMAT_LABEL, elapsed, glyph, notify, plural, thumbUrl } from './studio-ui.js';

export const making = { data: null, open: false };
const JUST_FINISHED = 86400000;     // "just finished": built in the last day and waiting for review
const SHOW_FINISHED = 3600000;      // the banner stays up for an hour after something finishes, so it is not missed

/** Ask the server what is running and in line. */
export async function refreshMaking() {
  try { making.data = await api.get('/making'); } catch { /* the next look will try again */ }
  return making.data;
}

const uidOf = (projectId, itemId) => `${projectId}:${itemId}`;

/** Everything being made, sorted into: now, in line, did not finish, just finished; plus how many approved posts wait to be built. */
export function collect() {
  const d = making.data;
  const seen = new Set();
  const now = [], line = [], failed = [], done = [];
  for (const j of d?.jobs ?? []) {
    if (!j.running) continue;
    if (j.running.kind === 'propose') now.push({ projectId: j.project, title: `Ideas for ${(j.running.months ?? []).map((m) => dateFmt.monthYear(m)).join(', ') || 'the next month'}`, what: 'Claude is writing ideas', since: j.running.startedAt });
    else {
      const post = S.byUid.get(uidOf(j.project, j.running.item));
      if (post) seen.add(post.uid);
      now.push({ post, projectId: j.project, what: post?.revising ? 'Claude is changing it' : 'Claude is making it', since: j.running.startedAt });
    }
  }
  for (const r of d?.revisions ?? []) {
    const post = S.byUid.get(r.uid);
    if (!post || seen.has(post.uid) || r.state !== 'running') continue;
    seen.add(post.uid);
    now.push({ post, what: 'Claude is making the changes you asked for', since: post.build?.since });
  }
  for (const post of S.posts.filter((p) => p.status === 'building' && p.build?.active && !seen.has(p.uid))) {
    seen.add(post.uid);
    now.push({ post, what: post.revising ? 'Claude is changing it' : 'Claude is making it', since: post.build.since });
  }
  for (const j of d?.jobs ?? []) {
    for (const q of j.queue ?? []) {
      const post = q.item ? S.byUid.get(uidOf(j.project, q.item)) : null;
      if (post) seen.add(post.uid);
      line.push({ post, projectId: j.project, title: q.kind === 'propose' ? 'More ideas' : undefined, what: q.position === 1 ? 'Next' : `${q.position - 1} ahead of it` });
    }
  }
  for (const r of d?.revisions ?? []) {
    const post = S.byUid.get(r.uid);
    if (!post || seen.has(post.uid) || r.state === 'running') continue;
    seen.add(post.uid);
    line.push({ post, what: r.state === 'waiting' ? 'Your changes wait while another run finishes' : 'Your changes are next' });
  }
  for (const post of S.posts.filter((p) => p.build?.pending && !seen.has(p.uid))) line.push({ post, what: `${plural(post.build.pending, 'change')} you asked for: after this build` });
  for (const post of S.posts.filter((p) => (p.status === 'approved' && p.build?.lastError) || p.reviseFailed || (p.status === 'building' && p.build?.stalled))) {
    failed.push({ post, what: post.build?.lastError ?? (post.build?.stalled ? 'It was being made, but nothing is running now.' : 'It did not finish.'), retry: true });
  }
  for (const j of d?.jobs ?? []) {
    const l = j.last;
    if (l?.kind === 'propose' && !j.running && !['proposed', 'nothing'].includes(l.outcome) && Date.now() - Date.parse(l.finishedAt ?? 0) < JUST_FINISHED) failed.push({ projectId: j.project, title: 'Ideas', what: l.error ?? 'Claude did not add any ideas.' });
  }
  const t = Date.now();
  for (const post of S.posts.filter((p) => p.needsReview && p.finishedAt && t - Date.parse(p.finishedAt) < JUST_FINISHED).sort((a, b) => b.finishedAt.localeCompare(a.finishedAt)).slice(0, 12)) done.push({ post, what: `Finished ${elapsed(post.finishedAt)} ago`, ready: true });
  const recent = done.some((x) => t - Date.parse(x.post.finishedAt) < SHOW_FINISHED);
  const waiting = S.posts.filter((p) => p.status === 'approved' && !seen.has(p.uid) && !p.build?.lastError).length;
  return { now, line, failed, done, recent, waiting };
}

/** How many things Claude has on: running now plus in line. */
export const makingCount = () => { const c = collect(); return c.now.length + c.line.length; };

function row(x, ctx, redraw) {
  const post = x.post;
  const pr = project(post?.project ?? x.projectId);
  const thumb = post?.thumb && pr ? thumbUrl(pr.id, post.thumb, 120) : null;
  const acts = [];
  if (post && x.ready) acts.push(h('button', { class: 'btn sm go', type: 'button', 'data-act': 'making-review', onclick: () => ctx.open(post.uid) }, 'Review it'));
  else if (post && x.retry) acts.push(h('button', { class: 'btn sm', type: 'button', 'data-act': 'making-retry', onclick: (e) => { e.currentTarget.disabled = true; retry(post, redraw); } }, 'Try again'));
  if (post && !x.ready) acts.push(h('button', { class: 'btn sm quiet', type: 'button', 'data-act': 'making-open', onclick: () => ctx.open(post.uid) }, 'Open'));
  return h('li', { class: 'mk-row', dataset: post ? { uid: post.uid } : {} },
    h('span', { class: 'mk-thumb', style: { '--lane': pr?.color ?? 'var(--ink)' } }, thumb ? h('img', { src: thumb, alt: '', loading: 'lazy' }) : glyph(post?.format ?? 'post', 15)),
    h('span', { class: 'mk-main' },
      h('b', { class: 'mk-title' }, x.title ?? post?.title ?? 'A post'),
      h('span', { class: 'mk-what' }, pr ? h('span', { class: 'mk-brand' }, h('i', { style: { background: pr.color } }), pr.name) : null, post?.format ? ` · ${FORMAT_LABEL[post.format] ?? post.format}` : '', post?.date ? ` · ${dateFmt.dm(post.date)}` : '', ` · ${x.what}`, x.since ? ` · ${elapsed(x.since)}` : '')),
    acts.length ? h('span', { class: 'mk-acts' }, acts) : null);
}

async function retry(post, redraw) {
  try {
    const r = await api.post(`/projects/${encodeURIComponent(post.project)}/calendar/run`, { action: 'build', item: post.itemId });
    notify(r.queued ? `In line: “${post.title}” starts by itself when Claude is free.` : `Claude is making “${post.title}” again.`, { kind: 'ok' });
    await Promise.all([load({ force: true }), refreshMaking()]);
  } catch (e) { notify(e.message, { kind: 'error' }); }
  redraw();
}

/** Fill the banner element. Hidden when nothing is being made, nothing failed and nothing finished in the last hour. Returns whether it shows. */
export function paintMakingBanner(el, ctx, redraw) {
  const c = collect();
  const show = c.now.length || c.line.length || c.failed.length || c.recent;
  el.classList.toggle('hidden', !show);
  if (!show) { making.open = false; return false; }
  const first = c.now[0];
  const parts = [];
  if (first) parts.push(h('b', {}, `${first.post?.revising || /changes/.test(first.what) ? 'Changing' : first.title?.startsWith('Ideas') ? 'Writing' : 'Making'} “${clip(first.title ?? first.post?.title ?? 'a post')}”`), first.since ? ` · ${elapsed(first.since)}` : '', c.now.length > 1 ? ` · ${c.now.length - 1} more at the same time` : '');
  // the headline says the most useful thing: making now, else in line, else what just finished, else what did not finish
  const justNow = c.done.filter((x) => Date.now() - Date.parse(x.post.finishedAt) < SHOW_FINISHED).length;
  const kind = first ? 'now' : c.line.length ? 'line' : justNow ? 'done' : 'failed';
  if (kind === 'line') parts.push(h('b', {}, `${plural(c.line.length, 'post')} in line`));
  else if (kind === 'done') parts.push(h('b', {}, `${plural(justNow, 'post')} just finished`));
  else if (kind === 'failed') parts.push(h('b', { class: 'bad' }, `${plural(c.failed.length, 'post')} did not finish`));
  const bits = [];
  if (kind === 'now' && c.line.length) bits.push(`${c.line.length} in line`);
  if (kind !== 'failed' && c.failed.length) bits.push(h('span', { class: 'bad' }, `${c.failed.length} did not finish`));
  if (kind !== 'done' && c.done.length) bits.push(`${c.done.length} ready for you`);
  const head = h('div', { class: 'mk-bar' },
    first ? h('i', { class: 'spin', 'aria-hidden': 'true' }) : icon(c.failed.length && !c.line.length ? 'alert' : 'check', 15),
    h('span', { class: 'mk-sum', 'data-state': 'making-summary' }, ...parts, ...bits.flatMap((b) => [' · ', b])),
    h('button', { class: 'linklike mk-toggle', type: 'button', 'data-act': 'making-toggle', 'aria-expanded': String(making.open), onclick: () => { making.open = !making.open; redraw(); } }, making.open ? 'Hide' : 'Show all', icon(making.open ? 'up' : 'down', 13)));
  const sec = (key, title, list) => (list.length ? h('section', { class: 'mk-sec', 'data-section': key }, h('h4', { class: 'lbl' }, `${title} · ${list.length}`), h('ul', { class: 'mk-list' }, list.map((x) => row(x, ctx, redraw)))) : null);
  const panel = making.open ? h('div', { class: 'mk-panel', 'data-state': 'making-panel' },
    sec('now', 'Making now', c.now), sec('line', 'In line (they start by themselves, in this order)', c.line), sec('failed', 'Did not finish', c.failed), sec('done', 'Just finished', c.done),
    c.waiting ? h('p', { class: 'muted mk-wait' }, `${plural(c.waiting, 'approved post')} ${c.waiting === 1 ? 'is' : 'are'} waiting to be built as ${c.waiting === 1 ? 'its date gets' : 'their dates get'} close. `, h('a', { href: '#/s/plan' }, 'Open the plan')) : null) : null;
  el.replaceChildren(...[head, panel].filter(Boolean));
  el.dataset.state = first ? 'making' : 'working';
  return true;
}

const clip = (s) => (s.length > 48 ? `${s.slice(0, 47).trimEnd()}…` : s);
