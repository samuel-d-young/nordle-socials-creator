// The review queue: the morning job. One post at a time, large, with the evidence beside it and the decision under your thumb.
// A for approve, X for changes, R for reject, J / K for next / previous, Space or arrows for pages and playback.

import { h, icon } from './dom.js';
import { S, buildQueue, update } from './studio-store.js';
import { emptyState, kbd, plural, thumbUrl } from './studio-ui.js';
import { mediaViewer, releaseViewer, activeViewer } from './studio-media.js';
import { commentsPanel } from './studio-comments.js';
import * as D from './studio-detail.js';
import * as act from './studio-actions.js';

const qv = { root: null, ctx: null, hold: false, dir: 1, token: 0, post: null, detail: null };
const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const currentPost = () => (S.queue.uid ? S.byUid.get(S.queue.uid) : null);
const index = () => S.queue.list.indexOf(S.queue.uid);

export function go(uid, dir = 1) {
  if (!uid || uid === S.queue.uid) return;
  qv.dir = dir;
  update({ queue: { ...S.queue, uid } });
  qv.ctx?.sync?.();
}
export function next() {
  const i = index();
  const list = S.queue.list;
  // the next one nobody has decided yet (wrapping round to the start), and when there is none, the end screen
  const target = list.slice(i + 1).find((u) => !S.queue.decided.has(u)) ?? list.slice(0, Math.max(0, i)).find((u) => !S.queue.decided.has(u));
  if (target) go(target, 1);
  else { qv.dir = 1; update({ queue: { ...S.queue, uid: null } }); qv.ctx?.sync?.(); }
}
export function prev() {
  const i = index();
  if (i > 0) go(S.queue.list[i - 1], -1);
}
export function step(n) { activeViewer()?.step(n); }
export function toggle() { activeViewer()?.toggle(); }

function tally() {
  const t = { approved: 0, changes: 0, rejected: 0, skipped: 0 };
  for (const v of S.queue.decided.values()) t[v] = (t[v] ?? 0) + 1;
  return t;
}

/** Make a decision on the post on screen: ask, show the stamp, move on. */
export async function decide(kind) {
  const post = currentPost();
  if (!post || qv.hold) return false;
  const fn = { approved: act.approve, changes: act.requestChanges, rejected: act.reject }[kind];
  qv.hold = true;
  const ok = await fn(post);
  if (!ok) { qv.hold = false; return false; }
  S.queue.decided.set(post.uid, kind);
  showStamp(kind);
  await sleep(reduce() ? 120 : 420);
  qv.hold = false;
  if (S.queue.uid === post.uid) next(); // unless the person already moved on while the stamp showed
  qv.ctx?.sync?.();
  return true;
}
export function skip() {
  const post = currentPost();
  if (!post) return;
  if (!S.queue.decided.has(post.uid)) S.queue.decided.set(post.uid, 'skipped');
  next();
}

function showStamp(kind) {
  const layer = qv.root?.querySelector('.q-media');
  if (!layer) return;
  const words = { approved: 'Signed off', changes: 'Sent back', rejected: 'Rejected' }[kind];
  layer.append(h('div', { class: `stamp stamp-${kind}`, 'aria-hidden': 'true' }, h('span', {}, words)));
}

// ---- drawing ---------------------------------------------------------------------------------------------------------------------

function progress() {
  const list = S.queue.list;
  const i = index();
  const ticks = list.map((u, n) => {
    const p = S.byUid.get(u);
    const d = S.queue.decided.get(u);
    return h('button', { class: `q-tick${n === i ? ' now' : ''}${d ? ` d-${d}` : ''}`, type: 'button', title: p?.title ?? u, 'aria-label': `${n + 1}. ${p?.title ?? ''}${d ? `, ${d}` : ''}`, onclick: () => go(u, n > i ? 1 : -1) });
  });
  const left = list.filter((u) => !S.queue.decided.has(u)).length;
  return h('div', { class: 'q-prog' },
    h('div', { class: 'q-count' }, h('b', {}, String(i + 1)), h('span', {}, ` of ${list.length}`), h('span', { class: 'q-left' }, left ? `${left} left` : 'all looked at')),
    h('div', { class: 'q-ticks', role: 'group', 'aria-label': 'Posts in this review' }, ticks));
}

function done() {
  const t = tally();
  const bits = [t.approved && `${t.approved} signed off`, t.changes && `${t.changes} sent back`, t.rejected && `${t.rejected} rejected`, t.skipped && `${t.skipped} skipped`].filter(Boolean);
  return emptyState({
    title: S.queue.decided.size ? 'That is all of them' : 'Nothing is waiting for you',
    body: S.queue.decided.size ? `${bits.join(', ')}.${t.skipped ? ' Skipped posts are still waiting.' : ''}` : 'Every built post has had a decision. New ones appear here as the designer finishes them.',
    action: h('div', { class: 'blank-acts' },
      t.skipped ? h('button', { class: 'btn go', onclick: () => { for (const [u, v] of [...S.queue.decided]) if (v === 'skipped') S.queue.decided.delete(u); buildQueue(); qv.ctx.sync(); } }, `Look at the ${t.skipped} skipped`) : null,
      h('button', { class: 'btn', onclick: () => qv.ctx.setView('month') }, 'Back to the calendar'),
      h('button', { class: 'btn', onclick: () => qv.ctx.setView('wall') }, 'Open the wall')),
  });
}

export function renderQueue(root, ctx) {
  if (qv.hold && qv.root === root) return;
  qv.root = root; qv.ctx = ctx;
  releaseViewer();
  const list = S.queue.list.length || S.queue.decided.size ? S.queue.list : buildQueue();
  const post = currentPost();
  if (!list.length || !post) return root.replaceChildren(h('div', { class: 'queue q-empty' }, done()));
  qv.post = post;
  const token = ++qv.token;
  const media = h('div', { class: 'q-media' }, D.loadingBlock());
  const side = h('div', { class: 'q-side' }, h('div', { class: 'q-side-in' }, D.loadingBlock()));
  const anim = reduce() ? '' : qv.dir > 0 ? ' enter-next' : ' enter-prev';
  const shell = h('div', { class: `queue${anim}`, dataset: { uid: post.uid } },
    h('div', { class: 'q-stage' },
      h('div', { class: 'q-bar' }, progress(),
        h('div', { class: 'q-show' },
          h('select', { class: 'f-sel q-brand', 'aria-label': 'Brand', onchange: (e) => ctx.setBrand(e.target.value) }, [h('option', { value: 'all', selected: S.brand === 'all' }, 'All brands'), ...S.projects.map((p) => h('option', { value: p.id, selected: S.brand === p.id }, p.name))]),
          h('select', { class: 'f-sel', 'aria-label': 'Show', onchange: (e) => { const v = e.target.value; ctx.setFilter({ format: ['reel', 'carousel', 'post', 'story'].includes(v) ? v : '', failing: v === 'failing' }); } },
            [['', 'Everything'], ['reel', 'Reels only'], ['carousel', 'Carousels only'], ['post', 'Posts only'], ['story', 'Stories only'], ['failing', 'Checks failing']].map(([v, l]) => h('option', { value: v, selected: v === (S.f.failing ? 'failing' : S.f.format) }, l)))),
        h('div', { class: 'q-nav' },
          h('button', { class: 'btn quiet', onclick: prev, disabled: index() === 0, 'aria-label': 'Previous post' }, icon('chevL', 14), kbd('K')),
          h('button', { class: 'btn quiet', onclick: skip, 'aria-label': 'Skip this post for now' }, 'Skip', kbd('S')),
          h('button', { class: 'btn quiet', onclick: next, 'aria-label': 'Next post' }, icon('chevR', 14), kbd('J')))),
      media),
    side);
  root.replaceChildren(shell);

  D.fetchDetail(post).then((d) => {
    if (token !== qv.token) return;
    qv.detail = d;
    let cp;
    const viewer = mediaViewer(d, post, { w: 1080, comments: d.comments, onDraft: (dr) => cp?.draft(dr), onPin: (c) => cp?.highlight(c.id), onMode: (on) => cp?.mode(on) });
    cp = commentsPanel({ d, post, viewer });
    media.replaceChildren(viewer.el);
    const parts = [D.videoNotice(d, post, () => { if (token === qv.token) renderQueue(root, ctx); }), D.head(d, post)];
    const note = (d.comments ?? []).filter((c) => c.status === 'open' && c.author === 'human').at(-1);
    if (post.status === 'changes' && note) parts.push(h('p', { class: 'q-note' }, h('span', { class: 'lbl-i' }, 'You asked for changes'), note.text));
    parts.push(cp.el, D.caption(d, post, { onChanged: () => { if (token === qv.token) renderQueue(root, ctx); } }), D.checks(d, post), D.pairs(d, post), D.why(d, post, { collapsed: true }), D.history(d, post));
    side.replaceChildren(
      h('div', { class: 'q-side-in' }, parts.filter(Boolean)),
      h('div', { class: 'q-actions' }, D.actions(d, post, { compact: true, afterAction: null })));
    // wire the buttons to the queue's own flow (stamp, then next)
    const rmb = side.querySelector('[data-act="remove"]');
    if (rmb) rmb.onclick = () => ctx.remove([post]);
    for (const [attr, kind] of [['approve', 'approved'], ['changes', 'changes'], ['reject', 'rejected']]) {
      const old = side.querySelector(`[data-act="${attr}"]`);
      if (!old) continue;
      // a copy without the button's own click handler (h() adds it with addEventListener, so assigning onclick would run both: two dialogs)
      const b = old.cloneNode(true);
      old.replaceWith(b);
      b.onclick = () => decide(kind);
    }
    // warm up the next two
    for (const u of S.queue.list.slice(index() + 1, index() + 3)) {
      const np = S.byUid.get(u);
      if (!np) continue;
      D.fetchDetail(np).then((nd) => { const first = nd.media.pages[0]?.path ?? nd.media.poster; if (first) new Image().src = thumbUrl(np.project, first, 1080); }).catch(() => {});
    }
  }).catch((e) => {
    if (token !== qv.token) return;
    media.replaceChildren(D.errorBlock(e.message, () => ctx.sync()));
    side.replaceChildren();
  });
}

/** What the view needs to know to decide whether to draw again. */
export const queueSig = () => JSON.stringify([S.queue.uid, S.queue.list.length, S.queue.decided.size, [...S.queue.decided.values()].join(''), currentPost() && [currentPost().status, currentPost().builtAt, currentPost().checks]]);
export { plural };
