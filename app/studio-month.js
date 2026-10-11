// The month view: one calendar that scrolls down through every month that has posts (and one empty month after the last), each with
// a sticky heading. One brand is a plain grid; "All brands" gives each week a band per brand. On a phone it is an agenda.

import { h } from './dom.js';
import { S, addDays, addMonths, dateFmt, dayOfWeek, daysInMonth, inBrand, monthOf, project, visible } from './studio-store.js';
import { brandName, brandTick, emptyState, FORMAT_LABEL, glyph, notScheduled, plural, postThumb, statusChip, statusOf, tipOn } from './studio-ui.js';
import { canMove } from './studio-actions.js';

export const isPhone = () => matchMedia('(max-width: 700px)').matches;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** The post being dragged to another day (null when nothing is). A drag cannot read its data until it is dropped, so the page remembers it. */
let drag = null;
const endDrag = () => {
  drag = null;
  document.querySelectorAll('.chip.dragging').forEach((c) => c.classList.remove('dragging'));
  document.querySelectorAll('.m-cell.drop-ok, .m-cell.drop-no').forEach((c) => c.classList.remove('drop-ok', 'drop-no'));
  document.querySelector('.month')?.classList.remove('dragging-chip');
};

function chip(p, ctx, { big = false } = {}) {
  const st = statusOf(p);
  const movable = !!ctx.moveDate && canMove(p);
  const el = h('button', {
    class: `chip chip-${st.key}${notScheduled(p) ? ' chip-unsched' : ''}${big ? ' chip-big' : ''}${S.picked.has(p.uid) ? ' picked' : ''}${movable ? ' movable' : ''}`, type: 'button', dataset: { uid: p.uid },
    'aria-label': `${p.title}. ${FORMAT_LABEL[p.format] ?? p.format}, ${brandName(p.project)}. ${st.label}${p.failing ? '. A check failed' : ''}${movable ? '. Drag it to another day to move it' : ''}`,
    tabindex: '-1', onclick: () => ctx.open(p.uid),
    ...(movable ? {
      draggable: 'true',
      ondragstart: (e) => {
        drag = { uid: p.uid, project: p.project, date: p.date };
        e.dataTransfer?.setData('text/plain', p.uid);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
        el.classList.add('dragging');
        el.closest('.month')?.classList.add('dragging-chip');
      },
      ondragend: endDrag,
    } : {}),
  }, postThumb(p, { w: big ? 240 : 160 }), glyph(p.format, 11), h('i', { class: 'chip-bar' }), p.failing || p.staleSignoff ? h('i', { class: 'chip-flag', title: p.failing ? 'A check failed' : 'Edited since sign-off' }) : null);
  tipOn(el, p);
  return el;
}

/** A day cell that takes a dragged post: only a day of the post's own brand lane, and not the day it is already on. */
function dropTarget(cell, day, laneId, ctx) {
  const fits = () => !!drag && drag.date !== day && (!laneId || laneId === drag.project);
  cell.addEventListener('dragover', (e) => {
    if (!drag) return;
    if (fits()) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; cell.classList.add('drop-ok'); } else cell.classList.add('drop-no');
  });
  cell.addEventListener('dragleave', (e) => { if (!cell.contains(e.relatedTarget)) cell.classList.remove('drop-ok', 'drop-no'); });
  cell.addEventListener('drop', (e) => {
    if (!fits()) return;
    e.preventDefault();
    const uid = drag.uid;
    endDrag();
    ctx.moveDate(uid, day);
  });
}

function laneLabel(pr) {
  return h('div', { class: 'm-lane-h', style: { '--lane': pr.color }, title: pr.name }, h('i', { class: 'tick' }), h('span', {}, pr.short));
}

/** The months to show: this month (or the first with a post) through the last with a post, plus one empty month. */
export function monthSpan() {
  const dated = S.posts.filter((p) => p.date && inBrand(p)).map((p) => monthOf(p.date)).sort();
  const now = monthOf(S.today || new Date().toISOString().slice(0, 10));
  const first = dated.length && dated[0] < now ? dated[0] : now;
  const last = addMonths(dated.length && dated.at(-1) > now ? dated.at(-1) : now, 1);
  const out = [];
  for (let ym = first; ym <= last; ym = addMonths(ym, 1)) out.push(ym);
  return out;
}

function monthBlock(ym, byDay, lanes, multi, ctx, all) {
  const first = `${ym}-01`;
  const offset = dayOfWeek(first);
  const start = addDays(first, -offset);
  const total = daysInMonth(ym);
  const weeks = Math.ceil((offset + total) / 7);
  const count = all.filter((p) => p.date?.startsWith(ym)).length;
  const grid = h('div', { class: `m-grid${multi ? ' multi' : ' single'}`, role: 'grid', 'aria-label': `${dateFmt.monthYear(ym)}, ${S.brand === 'all' ? 'all brands' : brandName(S.brand)}` });
  for (let w = 0; w < weeks; w++) {
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, w * 7 + i));
    const inside = days.filter((d) => d.startsWith(ym));
    const sparse = inside.length <= 2 && !inside.some((d) => (multi ? lanes.some((pr) => byDay.has(`${d}|${pr.id}`)) : byDay.has(d)));
    const week = h('div', { class: `m-week${days.includes(S.today) ? ' has-today' : ''}${sparse ? ' sparse' : ''}`, role: 'row', dataset: { week: days[0] } });
    if (multi) week.append(h('span', { class: 'm-corner' }));
    for (const day of days) {
      const out = !day.startsWith(ym);
      week.append(h('div', { class: `m-day${day === S.today ? ' today' : ''}${day < S.today ? ' past' : ''}${out ? ' out' : ''}${dayOfWeek(day) > 4 ? ' wknd' : ''}`, role: 'columnheader', dataset: { date: day } },
        out ? null : h('span', { class: 'm-dn' }, String(Number(day.slice(8)))), day === S.today ? h('span', { class: 'm-today-l' }, 'Today') : null));
    }
    for (const pr of multi ? lanes : [null]) {
      if (multi) week.append(laneLabel(pr));
      for (const day of days) {
        const out = !day.startsWith(ym);
        const posts = out ? [] : byDay.get(multi ? `${day}|${pr.id}` : day) ?? [];
        const cell = h('div', { class: `m-cell${out ? ' out' : ''}${dayOfWeek(day) > 4 ? ' wknd' : ''}${day === S.today ? ' today' : ''}`, role: 'gridcell', style: multi ? { '--lane': pr.color } : null, dataset: { date: day } },
          posts.map((p) => chip(p, ctx, { big: !multi })));
        if (!out && ctx.moveDate) dropTarget(cell, day, multi ? pr.id : null, ctx);
        week.append(cell);
      }
    }
    grid.append(week);
  }
  const now = ym === monthOf(S.today);
  return h('section', { class: 'm-month', dataset: { month: ym }, 'aria-label': dateFmt.monthYear(ym) },
    h('h2', { class: 'm-mh' }, h('span', { class: 'm-mn' }, dateFmt.monthName(ym)), h('span', { class: 'm-my' }, ym.slice(0, 4)), now ? h('span', { class: 'm-now' }, 'This month') : null,
      h('span', { class: 'm-mc' }, count ? plural(count, 'post') : 'nothing planned'),
      h('button', { class: 'linklike m-sel', type: 'button', onclick: () => ctx.selectMonth(ym) }, 'Select this month')),
    grid);
}

export function renderMonth(root, ctx) {
  const list = visible();
  if (isPhone()) return renderAgenda(root, ctx, list);
  const lanes = (S.brand === 'all' ? S.projects : [project(S.brand)].filter(Boolean));
  const multi = lanes.length > 1;
  const byDay = new Map();
  for (const p of list) {
    if (!p.date) continue;
    const key = multi ? `${p.date}|${p.project}` : p.date;
    (byDay.get(key) ?? byDay.set(key, []).get(key)).push(p);
  }
  const head = h('div', { class: `m-head${multi ? ' multi' : ''}`, role: 'row' }, multi ? h('span', { class: 'm-corner' }) : null, WEEKDAYS.map((d) => h('span', { class: 'm-wd', role: 'columnheader' }, d)));
  const loose = list.filter((p) => !p.date);
  const el = h('div', { class: 'month' }, head, monthSpan().map((ym) => monthBlock(ym, byDay, lanes, multi, ctx, list)),
    loose.length ? h('section', { class: 'm-loose' }, h('h3', { class: 'lbl' }, `Not scheduled (${loose.length})`), h('div', { class: 'm-loose-row' }, loose.map((p) => chip(p, ctx, { big: true })))) : null);
  root.replaceChildren(el);
  trackMonths(root, ctx);
}

// ---- keeping the heading and the title in step with the scroll -----------------------------------------------------------------

let off = null;
function trackMonths(root, ctx) {
  off?.();
  let raf = 0;
  const onScroll = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const top = root.getBoundingClientRect().top + 90;
      let seen = null;
      for (const m of root.querySelectorAll('.m-month')) { if (m.getBoundingClientRect().top <= top) seen = m.dataset.month; else break; }
      if (seen && seen !== S.month) ctx.monthSeen(seen);
    });
  };
  root.addEventListener('scroll', onScroll, { passive: true });
  off = () => { root.removeEventListener('scroll', onScroll); cancelAnimationFrame(raf); };
}

/** Scroll the view so a month's heading is at the top (or, for this month, so that today's week is in view). */
export function scrollToMonth(root, ym, { smooth = true, today = false } = {}) {
  const node = root.querySelector(`[data-month="${ym}"]`);
  if (!node) return false;
  const headH = (root.querySelector('.m-head')?.offsetHeight ?? 38);
  let y = node.offsetTop - headH;
  if (today) { const w = node.querySelector('.m-week.has-today'); if (w) y = node.offsetTop + w.offsetTop - headH - 44; }
  root.scrollTo({ top: Math.max(0, y), behavior: smooth && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'auto' });
  return true;
}

// ---- phones: an agenda -------------------------------------------------------------------------------------------------------------

function renderAgenda(root, ctx, list) {
  const dated = list.filter((p) => p.date).sort((a, b) => a.date.localeCompare(b.date));
  const loose = list.filter((p) => !p.date);
  if (!dated.length && !loose.length) {
    return root.replaceChildren(emptyState({ title: 'Nothing planned', body: 'Try another brand, or clear the filters.' }));
  }
  const row = (p) => {
    const st = statusOf(p);
    return h('button', { class: `ag-item chip-${st.key}${notScheduled(p) ? ' chip-unsched' : ''}`, type: 'button', dataset: { uid: p.uid }, onclick: () => ctx.open(p.uid), 'aria-label': `${p.title}. ${st.label}` },
      postThumb(p, { w: 160 }),
      h('span', { class: 'ag-body' },
        h('span', { class: 'ag-title' }, p.title),
        h('span', { class: 'ag-meta' }, brandTick(p.project), h('span', {}, brandName(p.project)), glyph(p.format, 12), h('span', {}, FORMAT_LABEL[p.format] ?? p.format)),
        statusChip(p, { short: true })));
  };
  const days = [...new Set(dated.map((p) => p.date))];
  const out = [];
  let month = '';
  let box = null;
  for (const d of days) {
    if (monthOf(d) !== month) { month = monthOf(d); box = h('section', { class: 'ag-mo' }, h('h2', { class: 'ag-month', dataset: { month } }, dateFmt.monthName(month), h('span', {}, month.slice(0, 4)))); out.push(box); }
    box.append(h('section', { class: `ag-day${d === S.today ? ' today' : ''}${d < S.today ? ' past' : ''}`, dataset: { date: d } },
      h('h3', { class: 'ag-h' }, h('span', { class: 'ag-d' }, String(Number(d.slice(8)))), h('span', { class: 'ag-w' }, dateFmt.weekday(d)), d === S.today ? h('span', { class: 'ag-today' }, 'Today') : null),
      dated.filter((p) => p.date === d).map(row)));
  }
  if (loose.length) out.push(h('section', { class: 'ag-day' }, h('h3', { class: 'ag-h' }, h('span', { class: 'ag-w' }, 'Not scheduled')), loose.map(row)));
  root.replaceChildren(h('div', { class: 'agenda' }, out));
  trackAgenda(root, ctx);
}

function trackAgenda(root, ctx) {
  off?.();
  let raf = 0;
  const onScroll = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const top = root.getBoundingClientRect().top + 60;
      let seen = null;
      for (const m of root.querySelectorAll('.ag-month')) { if (m.getBoundingClientRect().top <= top) seen = m.dataset.month; else break; }
      if (seen && seen !== S.month) ctx.monthSeen(seen);
    });
  };
  root.addEventListener('scroll', onScroll, { passive: true });
  off = () => { root.removeEventListener('scroll', onScroll); cancelAnimationFrame(raf); };
}

export function scrollAgenda(root, ym, { today = false } = {}) {
  const target = today ? root.querySelector('.ag-day.today') ?? [...root.querySelectorAll('.ag-day')].find((d) => d.dataset.date >= S.today) : root.querySelector(`.ag-month[data-month="${ym}"]`);
  if (target) root.scrollTo({ top: Math.max(0, root.scrollTop + target.getBoundingClientRect().top - root.getBoundingClientRect().top - (today ? 90 : 0)), behavior: 'auto' });
}
