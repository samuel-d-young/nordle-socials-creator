// The wall: a contact sheet. Big pictures, grouped by week, every one ticked or opened with a click or a key.

import { h, icon } from './dom.js';
import { S, addDays, dateFmt, dayOfWeek, update, visible } from './studio-store.js';
import { brandName, brandTick, checkDots, emptyState, FORMAT_LABEL, glyph, notScheduled, plural, postThumb, scoreBadge, statusChip, statusOf, tipOn } from './studio-ui.js';
import { eligibleForBulk } from './studio-actions.js';

const PAGE = 240;
let shown = PAGE;

const weekStart = (d) => addDays(d, -dayOfWeek(d));

function card(p, ctx) {
  const st = statusOf(p);
  const picked = S.picked.has(p.uid);
  const pic = h('button', { class: `wc-pic chip-${st.key}${notScheduled(p) ? ' chip-unsched' : ''}`, type: 'button', 'aria-label': `${p.title}. ${st.label}`, onclick: () => ctx.open(p.uid), tabindex: '-1' },
    postThumb(p, { w: 360 }), glyph(p.format, 13), h('i', { class: 'chip-bar' }), p.failing || p.staleSignoff ? h('i', { class: 'chip-flag', title: p.failing ? 'A check failed' : 'Edited since sign-off' }) : null);
  tipOn(pic, p);
  const box = h('input', { type: 'checkbox', checked: picked, 'aria-label': `Select ${p.title}`, onchange: (e) => ctx.pick(p.uid, e.target.checked) });
  return h('article', { class: `wc${picked ? ' picked' : ''}`, dataset: { uid: p.uid } },
    pic,
    h('label', { class: 'wc-pick', title: 'Select for sign-off' }, box),
    h('div', { class: 'wc-cap' },
      h('div', { class: 'wc-meta' }, brandTick(p.project), h('span', {}, p.date ? dateFmt.day(p.date) : 'Not scheduled'), h('span', { class: 'wc-fmt' }, FORMAT_LABEL[p.format] ?? p.format)),
      h('h3', { class: 'wc-title' }, p.title),
      h('div', { class: 'wc-foot' }, statusChip(p, { short: true }), scoreBadge(p)),
      checkDots(p.checks)));
}

export function renderWall(root, ctx) {
  const list = visible();
  if (!list.length) {
    return root.replaceChildren(emptyState({
      title: Object.values(S.f).some(Boolean) ? 'Nothing matches these filters' : 'No posts yet',
      body: Object.values(S.f).some(Boolean) ? 'Loosen a filter, or clear them all.' : 'When the designer plans and builds posts, they appear here.',
      action: Object.values(S.f).some(Boolean) ? h('button', { class: 'btn', onclick: ctx.clearFilters }, 'Clear filters') : null,
    }));
  }
  const cut = list.slice(0, shown);
  const groups = [];
  for (const p of cut) {
    const key = p.date ? weekStart(p.date) : 'none';
    let g = groups.at(-1);
    if (!g || g.key !== key) { g = { key, posts: [] }; groups.push(g); }
    g.posts.push(p);
  }
  const wall = h('div', { class: 'wall' });
  for (const g of groups) {
    const label = g.key === 'none' ? 'Not scheduled' : `${dateFmt.dm(g.key)} – ${dateFmt.dm(addDays(g.key, 6))}`;
    const now = g.key !== 'none' && S.today >= g.key && S.today <= addDays(g.key, 6);
    const needs = g.posts.filter((p) => p.needsReview).length;
    wall.append(h('section', { class: 'wk' },
      h('header', { class: 'wk-h' }, h('h2', { class: 'wk-t' }, label), now ? h('span', { class: 'wk-now' }, 'This week') : null, h('span', { class: 'wk-n' }, plural(g.posts.length, 'post'), needs ? ` · ${needs} to review` : '')),
      h('div', { class: 'wk-grid' }, g.posts.map((p) => card(p, ctx)))));
  }
  if (list.length > cut.length) {
    wall.append(h('div', { class: 'wall-more' }, h('button', { class: 'btn', onclick: () => { shown += PAGE; update(); } }, `Show ${Math.min(PAGE, list.length - cut.length)} more`), h('span', { class: 'muted' }, `${cut.length} of ${list.length} shown`)));
  }
  root.replaceChildren(wall);
}
export const resetWall = () => { shown = PAGE; };
export const revealAll = (n) => { if (n > shown) { shown = Math.ceil(n / PAGE) * PAGE; return true; } return false; };
export { eligibleForBulk };
