// The list: a dense table of every post, sortable, with only the rows on screen in the page (so 500 posts scroll as smoothly as 50).

import { h, icon } from './dom.js';
import { S, dateFmt, project, update, visible } from './studio-store.js';
import { brandName, brandTick, checkDots, emptyState, FORMAT_LABEL, glyph, makingChip, makingState, postThumb, scoreBadge, statusChip, statusOf } from './studio-ui.js';

const ROW = 46;
const HEAD = 34;
const OVER = 8;

const ORDER = { built: 0, changes: 1, signed: 3 };
const COLS = [
  { key: 'pick', label: '', cls: 'c-pick' },
  { key: 'pic', label: '', cls: 'c-pic' },
  { key: 'date', label: 'Date', cls: 'c-date', sort: (a, b) => (a.date ?? '9').localeCompare(b.date ?? '9') || (a.time ?? '').localeCompare(b.time ?? '') },
  { key: 'brand', label: 'Brand', cls: 'c-brand', sort: (a, b) => brandName(a.project).localeCompare(brandName(b.project)) },
  { key: 'format', label: 'Format', cls: 'c-fmt', sort: (a, b) => a.format.localeCompare(b.format) },
  { key: 'title', label: 'Title', cls: 'c-title', sort: (a, b) => a.title.localeCompare(b.title) },
  { key: 'pillar', label: 'Pillar', cls: 'c-pillar', sort: (a, b) => (a.pillar ?? '').localeCompare(b.pillar ?? '') },
  { key: 'status', label: 'Status', cls: 'c-status', sort: (a, b) => (ORDER[statusOf(a).key] ?? 2) - (ORDER[statusOf(b).key] ?? 2) },
  { key: 'score', label: 'Score', cls: 'c-score', sort: (a, b) => (a.score ?? -1) - (b.score ?? -1) },
  { key: 'act', label: '', cls: 'c-act' },
  { key: 'checks', label: 'Checks', cls: 'c-checks', sort: (a, b) => ((b.checks?.fail ?? 0) * 100 + (b.checks?.missing ?? 0)) - ((a.checks?.fail ?? 0) * 100 + (a.checks?.missing ?? 0)) },
];

export function sorted() {
  const list = [...visible()];
  const col = COLS.find((c) => c.key === S.sort.key) ?? COLS[2];
  const cmp = col.sort ?? COLS[2].sort;
  list.sort((a, b) => cmp(a, b) * S.sort.dir || (a.date ?? '9').localeCompare(b.date ?? '9') || a.uid.localeCompare(b.uid));
  return list;
}

function row(p, i, ctx) {
  const picked = S.picked.has(p.uid);
  const pr = project(p.project);
  const mk = makingState(p);   // being made, in line, stopped or failed: the whole row says so, not only a small picture
  const el = h('div', { class: `lr${picked ? ' picked' : ''}${mk ? ` making mk-row-${mk.key}` : ''}`, role: 'row', 'data-making': mk?.key, style: { transform: `translateY(${i * ROW}px)` }, dataset: { uid: p.uid, i: String(i) }, onclick: (e) => { if (!e.target.closest('input')) ctx.open(p.uid); } },
    h('span', { class: 'c-pick' }, h('input', { type: 'checkbox', checked: picked, 'aria-label': `Select ${p.title}`, onchange: (e) => ctx.pick(p.uid, e.target.checked) })),
    h('span', { class: 'c-pic' }, postThumb(p, { w: 96 })),
    h('span', { class: 'c-date' }, p.date ? dateFmt.day(p.date) : 'Not set'),
    h('span', { class: 'c-brand', title: pr?.name }, brandTick(p.project), h('span', {}, pr?.name ?? p.project)),
    h('span', { class: 'c-fmt' }, glyph(p.format, 13), h('span', {}, FORMAT_LABEL[p.format] ?? p.format)),
    h('span', { class: 'c-title' }, h('span', { class: 't' }, p.title), h('span', { class: 'm' }, mk?.key === 'now' ? 'Claude is making this right now' : `${pr?.short ?? ''} · ${p.date ? dateFmt.day(p.date) : 'no date'}`)),
    h('span', { class: 'c-pillar' }, pr?.settings.pillars.find((x) => x.id === p.pillar)?.name ?? p.pillar ?? ''),
    h('span', { class: 'c-status' }, makingChip(p) ?? statusChip(p)),
    h('span', { class: 'c-score' }, scoreBadge(p)),
    h('span', { class: 'c-act' }, h('button', { type: 'button', title: 'Remove this post', 'aria-label': `Remove ${p.title}`, onclick: (e) => { e.stopPropagation(); ctx.remove([p]); } }, icon('trash', 15))),
    h('span', { class: 'c-checks' }, checkDots(p.checks)));
  return el;
}

let lastScroll = 0;
export function renderList(root, ctx) {
  const rows = sorted();
  if (!rows.length) {
    return root.replaceChildren(emptyState({
      title: Object.values(S.f).some(Boolean) ? 'Nothing matches these filters' : 'No posts yet',
      body: Object.values(S.f).some(Boolean) ? 'Loosen a filter, or clear them all.' : 'When the designer plans and builds posts, they appear here.',
      action: Object.values(S.f).some(Boolean) ? h('button', { class: 'btn', onclick: ctx.clearFilters }, 'Clear filters') : null,
    }));
  }
  const header = h('div', { class: 'lh', role: 'row' }, COLS.map((c) => {
    if (!c.sort) return h('span', { class: c.cls, role: 'columnheader' }, c.key === 'pick' ? h('input', { type: 'checkbox', 'aria-label': 'Select every post shown', checked: rows.length > 0 && rows.every((p) => S.picked.has(p.uid)), onchange: (e) => ctx.pickMany(rows.map((p) => p.uid), e.target.checked) }) : null);
    const on = S.sort.key === c.key;
    return h('span', { class: `${c.cls}${on ? ' on' : ''}`, role: 'columnheader', 'aria-sort': on ? (S.sort.dir > 0 ? 'ascending' : 'descending') : 'none' },
      h('button', { type: 'button', onclick: () => update({ sort: { key: c.key, dir: on ? -S.sort.dir : 1 } }) }, c.label, on ? h('i', { class: 'sortmark' }, S.sort.dir > 0 ? '↑' : '↓') : null));
  }));
  const sizer = h('div', { class: 'l-sizer', style: { height: `${rows.length * ROW}px` } });
  const scroller = h('div', { class: 'lscroll', role: 'table', 'aria-label': 'Posts', 'aria-rowcount': String(rows.length + 1), tabindex: '-1' }, header, sizer);

  let first = -1, last = -1;
  const mounted = new Map();
  function paint() {
    const top = scroller.scrollTop - HEAD;
    const a = Math.max(0, Math.floor(top / ROW) - OVER);
    const b = Math.min(rows.length - 1, Math.ceil((top + scroller.clientHeight) / ROW) + OVER);
    if (a === first && b === last) return;
    first = a; last = b;
    for (const [i, el] of mounted) if (i < a || i > b) { el.remove(); mounted.delete(i); }
    for (let i = a; i <= b; i++) if (!mounted.has(i)) { const el = row(rows[i], i, ctx); mounted.set(i, el); sizer.append(el); }
    lastScroll = scroller.scrollTop;
  }
  let raf = 0;
  scroller.addEventListener('scroll', () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(paint); }, { passive: true });
  root.replaceChildren(scroller);
  scroller.scrollTop = lastScroll;
  paint();
  // keyboard: bring a row into view even when it is not in the page yet
  scroller.showRow = (uid) => {
    const i = rows.findIndex((p) => p.uid === uid);
    if (i < 0) return null;
    const y = HEAD + i * ROW;
    if (y < scroller.scrollTop + HEAD) scroller.scrollTop = y - HEAD;
    else if (y + ROW > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = y + ROW - scroller.clientHeight;
    paint();
    return sizer.querySelector(`[data-uid="${CSS.escape(uid)}"]`);
  };
  scroller.order = rows.map((p) => p.uid);
  return scroller;
}
export const resetList = () => { lastScroll = 0; };
