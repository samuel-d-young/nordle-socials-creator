// The plan, brand by brand: are the monthly quotas met, is the mix of themes right, which ideas wait for a yes,
// and what is missing from next month.

import { h, icon } from './dom.js';
import { S, addDays, addMonths, dateFmt, dayOfWeek, daysInMonth, monthOf, project } from './studio-store.js';
import { brandName, emptyState, FORMAT_LABEL, glyph, notify, plural, statusOf } from './studio-ui.js';
import * as act from './studio-actions.js';
import { fetchDetail } from './studio-detail.js';
import { accountsOf, openConnect, serviceIcon } from './studio-publish.js';

const DEFAULT_REELS = 8;
const DEFAULT_OTHERS = 5;

function quotas(pr) {
  const pm = pr?.settings.perMonth;
  if (!pm) return { reel: DEFAULT_REELS, other: DEFAULT_OTHERS, parts: null };
  const other = Object.entries(pm).filter(([k]) => k !== 'reel').reduce((n, [, v]) => n + v, 0);
  return { reel: pm.reel ?? 0, other, parts: Object.entries(pm).filter(([k]) => k !== 'reel') };
}

const live = (p) => p.status !== 'rejected';
const kindOf = (st) => ({ scheduled: 'sched', signed: 'signed', built: 'review', stale: 'review', changes: 'changes', idea: 'idea', queued: 'queued', building: 'queued', posted: 'signed' }[st] ?? 'queued');

/** Cells, one per post wanted. Filled in the colour of the post's state; empty ones are still to plan. */
function meter(posts, target, label, hint) {
  const n = Math.max(target, posts.length);
  const order = { sched: -1, signed: 0, review: 1, changes: 2, queued: 3, idea: 4 };
  const sorted = [...posts].sort((a, b) => order[kindOf(statusOf(a).key)] - order[kindOf(statusOf(b).key)] || (a.date ?? '').localeCompare(b.date ?? ''));
  const cells = [];
  for (let i = 0; i < n; i++) {
    const p = sorted[i];
    cells.push(p
      ? h('i', { class: `cell c-${kindOf(statusOf(p).key)}${i >= target ? ' over' : ''}`, title: `${p.title} (${statusOf(p).label})` })
      : h('i', { class: 'cell c-empty', title: 'Still to plan' }));
  }
  const short = Math.max(0, target - posts.length);
  return h('div', { class: 'meter' },
    h('div', { class: 'meter-h' }, h('span', { class: 'meter-l' }, label), h('span', { class: `meter-n${short ? ' short' : ''}` }, h('b', {}, String(posts.length)), ` of ${target}`)),
    h('div', { class: 'cells', role: 'img', 'aria-label': `${label}: ${posts.length} planned of ${target}` }, cells),
    hint ? h('div', { class: 'meter-hint' }, hint) : null);
}

function monthsFor(brandPosts) {
  const set = new Set(brandPosts.filter((p) => p.date).map((p) => monthOf(p.date)));
  const now = monthOf(S.today);
  set.add(now); set.add(addMonths(now, 1));
  return [...set].sort().filter((m) => m >= addMonths(now, -1)).slice(0, 6);
}

function legend() {
  return h('div', { class: 'legend' }, [['sched', 'Scheduled'], ['signed', 'Signed off'], ['review', 'Needs your review'], ['changes', 'Changes requested'], ['queued', 'Queued or being built'], ['idea', 'Idea'], ['empty', 'Still to plan']].map(([k, l]) => h('span', {}, h('i', { class: `cell c-${k}` }), l)));
}

function gaps(pr, posts, ym) {
  const q = quotas(pr);
  const mine = posts.filter((p) => live(p) && p.date?.startsWith(ym));
  const reels = mine.filter((p) => p.format === 'reel').length;
  const others = mine.length - reels;
  const out = [];
  if (reels < q.reel) out.push(`${plural(q.reel - reels, 'more reel')}: ${reels} of ${q.reel} planned`);
  if (others < q.other) out.push(`${plural(q.other - others, 'more carousel or post', 'more carousels or posts')}: ${others} of ${q.other} planned`);
  const days = daysInMonth(ym);
  const emptyWeeks = [];
  let d = `${ym}-01`;
  d = addDays(d, -dayOfWeek(d));
  for (; d <= `${ym}-${String(days).padStart(2, '0')}`; d = addDays(d, 7)) {
    const lo = d < `${ym}-01` ? `${ym}-01` : d;
    const hiRaw = addDays(d, 6);
    const hi = hiRaw > `${ym}-${String(days).padStart(2, '0')}` ? `${ym}-${String(days).padStart(2, '0')}` : hiRaw;
    const inside = Math.round((Date.parse(`${hi}T00:00:00Z`) - Date.parse(`${lo}T00:00:00Z`)) / 86400000) + 1;
    if (inside >= 3 && !mine.some((p) => p.date >= lo && p.date <= hi)) emptyWeeks.push(`${dateFmt.dm(lo)}${lo === hi ? '' : ` to ${dateFmt.dm(hi)}`}`);
  }
  if (emptyWeeks.length) out.push(`${plural(emptyWeeks.length, 'week')} with nothing planned: ${emptyWeeks.join('; ')}`);
  const missingPillars = (pr?.settings.pillars ?? []).filter((pl) => !mine.some((p) => p.pillar === pl.id)).map((pl) => pl.name);
  if (missingPillars.length && mine.length) out.push(`No post yet for: ${missingPillars.join(', ')}`);
  return { lines: out, reels, others, q, emptyWeeks, missingPillars };
}

function pillarMix(pr, posts) {
  const mine = posts.filter(live);
  const total = mine.length || 1;
  const defs = pr?.settings.pillars ?? [];
  const ids = [...new Set([...defs.map((d) => d.id), ...mine.map((p) => p.pillar).filter(Boolean)])];
  const rows = ids.map((id) => {
    const def = defs.find((d) => d.id === id);
    const n = mine.filter((p) => p.pillar === id).length;
    return { id, name: def?.name ?? id, n, share: n / total, target: def?.share ?? null };
  });
  const noPillar = mine.filter((p) => !p.pillar).length;
  return h('div', { class: 'mix' },
    rows.map((r) => h('div', { class: 'mix-row' },
      h('span', { class: 'mix-name' }, r.name),
      h('span', { class: 'mix-bar', role: 'img', 'aria-label': `${r.name}: ${Math.round(r.share * 100)} percent${r.target !== null ? `, aim ${Math.round(r.target * 100)}` : ''}` }, h('i', { class: 'mix-fill', style: { width: `${Math.round(r.share * 100)}%` } }), r.target !== null ? h('i', { class: 'mix-target', style: { left: `${Math.round(r.target * 100)}%` }, title: `Aim: ${Math.round(r.target * 100)}%` }) : null),
      h('span', { class: 'mix-n' }, `${r.n}`, h('span', { class: 'muted' }, ` · ${Math.round(r.share * 100)}%${r.target !== null ? ` / aim ${Math.round(r.target * 100)}%` : ''}`)))),
    noPillar ? h('p', { class: 'muted mix-none' }, `${plural(noPillar, 'post')} without a pillar.`) : null);
}

function ideaRow(p, refresh) {
  const row = h('li', { class: 'idea', dataset: { uid: p.uid } },
    h('div', { class: 'idea-main' },
      h('div', { class: 'idea-top' }, glyph(p.format, 13), h('span', { class: 'idea-fmt' }, FORMAT_LABEL[p.format] ?? p.format), h('span', { class: 'idea-date' }, p.date ? dateFmt.day(p.date) : 'No date')),
      h('h4', { class: 'idea-title' }, p.title),
      p.idea ? h('p', { class: 'idea-text' }, p.idea) : null),
    h('div', { class: 'idea-acts' },
      h('button', { class: 'btn go sm', onclick: async () => { if (await act.approveIdea(p)) refresh(); } }, icon('check', 14), 'Approve'),
      h('button', { class: 'btn sm', onclick: async () => { const d = await fetchDetail(p).catch(() => null); if (await act.editIdea(p, d)) refresh(); } }, 'Edit'),
      h('button', { class: 'btn nope sm', onclick: async () => { if (await act.rejectIdea(p)) refresh(); } }, 'Reject')));
  return row;
}

function brandSection(pr, ctx) {
  const posts = S.posts.filter((p) => p.project === pr.id);
  const months = monthsFor(posts);
  const q = quotas(pr);
  const next = addMonths(monthOf(S.today), 1);
  const g = gaps(pr, posts, next);
  const ideas = posts.filter((p) => p.status === 'idea').sort((a, b) => (a.date ?? '9').localeCompare(b.date ?? '9'));
  const needs = posts.filter((p) => p.needsReview).length;
  const signed = posts.filter((p) => p.status === 'signed-off').length;
  const refresh = () => ctx.rerender();

  const monthCols = months.map((ym) => {
    const mine = posts.filter((p) => live(p) && p.date?.startsWith(ym));
    const reels = mine.filter((p) => p.format === 'reel');
    const others = mine.filter((p) => p.format !== 'reel');
    const eligible = mine.filter(act.eligibleForBulk);
    const partsHint = q.parts ? q.parts.map(([k, v]) => `${others.filter((p) => p.format === k).length}/${v} ${k === 'post' ? 'posts' : `${k}s`}`).join(' · ') : null;
    return h('article', { class: `pm${ym === monthOf(S.today) ? ' now' : ''}` },
      h('header', { class: 'pm-h' }, h('h4', {}, dateFmt.monthName(ym)), ym === monthOf(S.today) ? h('span', { class: 'pm-now' }, 'This month') : null, h('button', { class: 'linklike', onclick: () => ctx.openMonth(ym) }, 'Open calendar')),
      meter(reels, q.reel, 'Reels'),
      meter(others, q.other, 'Carousels and posts', partsHint),
      h('div', { class: 'pm-foot' },
        h('span', { class: 'muted' }, `${mine.filter((p) => p.needsReview).length} to review`),
        h('button', { class: 'btn quiet sm', type: 'button', onclick: () => ctx.selectMonth(ym), title: 'Select every post in this month, to schedule or sign off together' }, 'Select month'),
        h('button', { class: 'btn sm', disabled: !eligible.length, title: eligible.length ? 'Sign off the posts here that are fully checked' : 'None are fully verified yet', onclick: async () => { if (await act.bulkApprove(eligible.map((p) => p.uid))) refresh(); } },
          eligible.length ? `Sign off ${eligible.length} verified` : 'None verified yet')));
  });

  const request = () => {
    const parts = [`Please propose ideas for ${pr.name} for ${dateFmt.monthYear(next)}.`];
    if (g.lines.length) parts.push(`What is missing: ${g.lines.join('; ')}.`);
    parts.push('Keep to the brand voice, the health-advertising rules and the monthly mix, and leave the new ideas as ideas for me to approve.');
    navigator.clipboard?.writeText(parts.join('\n')).then(() => notify('Copied. Paste it to Claude.', { kind: 'ok' }), () => notify('Could not copy to the clipboard.', { kind: 'error' }));
  };

  return h('section', { class: 'plan-brand', style: { '--lane': pr.color }, id: `plan-${pr.id}` },
    h('header', { class: 'pb-h' }, h('i', { class: 'tick lg' }), h('h2', {}, pr.name), accountsOf(pr.id)?.length ? h('span', { class: 'pb-accts', title: 'The accounts this brand posts to' }, accountsOf(pr.id).slice(0, 5).map((c) => serviceIcon(c.service ?? 'x', 14))) : accountsOf(pr.id) ? h('button', { class: 'linklike pb-connect', type: 'button', onclick: () => openConnect('buffer').then(() => ctx.rerender()) }, 'Connect an account') : null, h('p', { class: 'pb-sum' }, `${plural(posts.filter(live).length, 'post')} planned · ${signed} signed off · ${needs} waiting for you`)),
    h('div', { class: 'pms' }, monthCols),
    legend(),
    h('div', { class: 'pb-cols' },
      h('section', { class: 'pb-mix' }, h('h3', { class: 'lbl' }, 'Mix of themes'), pillarMix(pr, posts.filter((p) => p.date && months.includes(monthOf(p.date))))),
      h('section', { class: 'pb-gaps' }, h('h3', { class: 'lbl' }, `Gaps in ${dateFmt.monthName(next)}`),
        g.lines.length ? h('ul', { class: 'gaps' }, g.lines.map((l) => h('li', {}, l))) : h('p', { class: 'muted' }, `${dateFmt.monthName(next)} has its full quota, with something every week.`),
        g.lines.length ? h('button', { class: 'btn sm', onclick: request }, icon('clipboard', 14), 'Copy a request for Claude') : null)),
    h('section', { class: 'pb-ideas' },
      h('h3', { class: 'lbl' }, `Idea backlog (${ideas.length})`),
      ideas.length ? h('ul', { class: 'ideas' }, ideas.map((p) => ideaRow(p, refresh))) : h('p', { class: 'muted' }, 'No ideas are waiting for a yes. The designer proposes more when the calendar runs short.')));
}

export function renderPlan(root, ctx) {
  const lanes = S.brand === 'all' ? S.projects : [project(S.brand)].filter(Boolean);
  if (!lanes.length) return root.replaceChildren(emptyState({ title: 'No brands yet', body: 'Add a brand from the left bar, then plan its calendar here.' }));
  root.replaceChildren(h('div', { class: 'plan' }, lanes.map((pr) => brandSection(pr, ctx))));
}
export { brandName };
