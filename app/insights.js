// Insights: how the posts did, what to do about it. One brand at a time; "All brands" is its own screen (insights-overview.js: every brand side by side).
// Numbers come from the owner (an exported CSV, or typed in); scores are relative to the account's own history; every group shows its
// n and says "directional only" under 5 posts. The review (written by Claude, saved under reviews/) is shown below the numbers.
// Data: GET /api/projects/<p>/performance/{report,reviews,reviews/<period>,prompt,metrics}; POST .../{metrics,import,reviews/<period>/apply-mix}.
// The JSON shapes are documented at the top of src/server/routes/performance.mjs.

import { h, icon, dialog } from './dom.js';
import { api } from './api.js';
import { S, addMonths, dateFmt, load, monthOf, project } from './studio-store.js';
import { FORMAT_LABEL, emptyState, glyph, notify, plural, skeleton, thumbUrl } from './studio-ui.js';
import { timesPanel, totalsPanel } from './insights-times.js';
import { renderOverview } from './insights-overview.js';

// ---- periods (the same rules as src/performance/period.mjs) ---------------------------------------------------------------------------

const DAY = 86400000;
const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const mondayOf = (ms) => ms - ((new Date(ms).getUTCDay() + 6) % 7) * DAY;
function weekId(date) {
  const mon = mondayOf(parse(date));
  const y = new Date(mon + 3 * DAY).getUTCFullYear();
  const w1 = mondayOf(Date.UTC(y, 0, 4));
  return `${y}-W${String(Math.round((mon - w1) / (7 * DAY)) + 1).padStart(2, '0')}`;
}
function weekStart(id) {
  const [, y, w] = /^(\d{4})-W(\d{2})$/.exec(id);
  return iso(mondayOf(Date.UTC(+y, 0, 4)) + (Number(w) - 1) * 7 * DAY);
}
const isWeek = (id) => /^\d{4}-W\d{2}$/.test(id ?? '');
const kindOf = (id) => (isWeek(id) ? 'week' : 'month');
const periodOfDate = (date, kind) => (kind === 'week' ? weekId(date) : date.slice(0, 7));
const lastComplete = (today, kind) => (kind === 'week' ? weekId(iso(mondayOf(parse(today)) - DAY)) : addMonths(monthOf(today), -1));
function stepPeriod(id, delta) {
  if (isWeek(id)) return weekId(iso(parse(weekStart(id)) + delta * 7 * DAY));
  return addMonths(id, delta);
}
function labelOf(id) {
  if (isWeek(id)) {
    const from = weekStart(id);
    return `Week ${Number(id.slice(6))} · ${dateFmt.dm(from)} to ${dateFmt.dm(iso(parse(from) + 6 * DAY))}`;
  }
  return `${dateFmt.monthName(id)} ${id.slice(0, 4)}`;
}

// ---- state --------------------------------------------------------------------------------------------------------------------------

const st = { window: '7d', scope: 'period', cache: new Map(), token: 0 };
const WINDOWS = [['7d', '7 days after posting'], ['28d', '28 days after posting'], ['lifetime', 'Lifetime so far']];
const PLATFORMS = ['instagram', 'facebook', 'tiktok', 'linkedin', 'youtube'];
const nf = new Intl.NumberFormat('en-AU', { maximumFractionDigits: 1 });
const num = (x) => (x === null || x === undefined ? '–' : nf.format(x));
const bust = () => { st.cache.clear(); };
const periodNow = () => S.insights || lastComplete(S.today, 'month');

function cached(key, fn) {
  if (!st.cache.has(key)) st.cache.set(key, fn().catch((e) => { st.cache.delete(key); throw e; }));
  return st.cache.get(key);
}
const base = (pr) => `/projects/${encodeURIComponent(pr.id)}/performance`;
const getReport = (pr, period) => cached(`r|${pr.id}|${period}|${st.window}`, () => api.get(`${base(pr)}/report?period=${encodeURIComponent(period)}&window=${st.window}`));
const getReviews = (pr) => cached(`v|${pr.id}`, () => api.get(`${base(pr)}/reviews`));
const getReview = (pr, period) => cached(`m|${pr.id}|${period}`, () => api.get(`${base(pr)}/reviews/${encodeURIComponent(period)}`).catch((e) => { if (e.status === 404) return null; throw e; }));

// ---- small pieces -------------------------------------------------------------------------------------------------------------------

const EVIDENCE = {
  directional: { label: 'directional only', tip: 'Fewer than 5 posts, or fewer than 5 to compare with. Worth testing, not worth believing.' },
  suggestive: { label: 'suggestive', tip: 'A gap of 8 points or more on at least 5 posts each side. Worth testing on purpose.' },
  stronger: { label: 'clearer gap', tip: 'A gap of 10 points or more on at least 10 posts each side. Still not proof of cause.' },
};
const evidenceChip = (ev) => (EVIDENCE[ev.level] ? h('span', { class: `ins-ev ev-${ev.level}`, title: EVIDENCE[ev.level].tip }, EVIDENCE[ev.level].label) : null);

const KEY_METRICS = ['plays', 'views', 'reach', 'likes', 'comments', 'shares', 'saves', 'follows'];
const METRIC_WORD = { plays: 'plays', views: 'views', reach: 'reach', likes: 'likes', comments: 'comments', shares: 'shares', saves: 'saves', follows: 'follows' };
function numberChips(m) {
  const keys = KEY_METRICS.filter((k) => typeof m[k] === 'number').slice(0, 5);
  return h('ul', { class: 'ins-nums' }, keys.map((k) => h('li', {}, h('b', {}, num(m[k])), ` ${METRIC_WORD[k]}`)));
}

function pic(pr, r) {
  const box = h('span', { class: 'th', style: { '--lane': pr.color } });
  if (r.thumb) {
    const img = h('img', { src: thumbUrl(pr.id, r.thumb, 200), alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' });
    img.addEventListener('error', () => { img.remove(); box.append(h('span', { class: 'th-ph' }, h('span', {}, r.title))); });
    box.append(img);
  } else box.append(h('span', { class: 'th-ph' }, h('span', {}, r.title)));
  return box;
}

function postCard(pr, r, ctx, onEdit, { tone } = {}) {
  const uid = `${pr.id}:${r.id}`;
  const open = S.byUid.has(uid);
  const vs = r.headline?.ratio ? `${nf.format(r.headline.ratio)}x your usual ${r.headline.label.toLowerCase()}` : null;
  return h('article', { class: `ins-post ${tone ?? ''}`, style: { '--lane': pr.color } },
    open ? h('button', { class: 'ins-pic', type: 'button', onclick: () => ctx.open(uid), 'aria-label': `Open ${r.title}` }, pic(pr, r)) : h('span', { class: 'ins-pic' }, pic(pr, r)),
    h('div', { class: 'ins-pbody' },
      h('div', { class: 'ins-pmeta' }, glyph(r.format, 13), h('span', {}, `${FORMAT_LABEL[r.format] ?? r.format} · ${dateFmt.day(r.date)}`), r.platform !== 'instagram' ? h('span', { class: 'ins-plat' }, r.platform) : null),
      h('h4', {}, r.title),
      h('p', { class: 'ins-hook' }, `“${r.hook}”`, r.hookType ? h('span', { class: 'ins-tag', title: r.hookRule }, r.hookType) : null),
      numberChips(r.metrics),
      h('div', { class: 'ins-pfoot' },
        h('span', { class: 'ins-score', title: 'Compared with this account\'s own posts of the same format. 50 is a typical one.' }, h('b', {}, num(r.score)), ' of 100'),
        vs ? h('span', { class: 'muted' }, vs) : null,
        r.scoreBasis.lowBaseline ? h('span', { class: 'ins-ev ev-directional', title: 'Fewer than 5 posts of this format have settled numbers.' }, 'directional only') : null,
        h('button', { class: 'linklike ins-edit', type: 'button', onclick: () => onEdit(r.id) }, 'Edit results'))));
}

function bars(dim, id) {
  if (!dim?.groups.length) return null;
  if (!dim.comparable) return h('div', { class: 'ins-dim' }, h('h4', { class: 'lbl' }, dim.label), h('p', { class: 'muted ins-one' }, `Only one kind so far (${dim.groups[0].key}, n=${dim.groups[0].n}): nothing to compare yet.`));
  return h('div', { class: 'ins-dim', id },
    h('h4', { class: 'lbl' }, dim.label),
    dim.groups.map((g) => h('div', { class: `ins-row${g.n < 5 ? ' low' : ''}` },
      h('span', { class: 'ins-name' }, g.key),
      h('span', { class: 'ins-bar', role: 'img', 'aria-label': `${g.key}: median score ${num(g.median)} from ${g.n} posts${g.n < 5 ? ', directional only' : ''}` },
        h('i', { class: 'ins-fill', style: { width: `${Math.max(1, Math.min(100, g.median))}%` } }), h('i', { class: 'ins-mid', title: '50 = a typical post' })),
      h('span', { class: 'ins-n' }, h('b', {}, num(g.median)), ` · n=${g.n}`),
      evidenceChip(g.evidence))),
    dim.unknown ? h('p', { class: 'muted ins-unk' }, `${plural(dim.unknown, 'post')} could not be sorted into this.`) : null);
}

// ---- tiny markdown (headings, lists, bold, code; nothing else, and no HTML) ------------------------------------------------------------

function inline(text) {
  const out = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(m[1] !== undefined ? h('strong', {}, m[1]) : h('code', {}, m[2]));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
export function markdownNodes(md) {
  const out = [];
  let list = null, para = [];
  const flush = () => { if (para.length) { out.push(h('p', {}, inline(para.join(' ')))); para = []; } };
  const endList = () => { list = null; };
  for (const raw of String(md ?? '').replace(/<!--.*?-->/g, '').split('\n')) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { flush(); endList(); continue; }
    if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) { flush(); endList(); out.push(h(m[1].length <= 2 ? 'h3' : 'h4', { class: 'ins-mh' }, inline(m[2]))); continue; }
    if ((m = /^\s*(?:[-*]|\d+[.)])\s+(.*)$/.exec(line))) {
      flush();
      if (!list) { list = h('ul', { class: 'ins-ul' }); out.push(list); }
      list.append(h('li', {}, inline(m[1])));
      continue;
    }
    if ((m = /^>\s?(.*)$/.exec(line))) { flush(); endList(); out.push(h('blockquote', {}, inline(m[1]))); continue; }
    endList();
    para.push(line.trim());
  }
  flush();
  return out;
}

// ---- adding numbers by hand ----------------------------------------------------------------------------------------------------------

const FIELDS = {
  reel: [['plays', 'Plays'], ['reach', 'Reach'], ['likes', 'Likes'], ['comments', 'Comments'], ['shares', 'Shares'], ['saves', 'Saves'], ['follows', 'Follows'], ['avgWatchSec', 'Average watch (seconds)'], ['completionRate', 'Watched to the end (%)']],
  carousel: [['reach', 'Reach'], ['likes', 'Likes'], ['comments', 'Comments'], ['shares', 'Shares'], ['saves', 'Saves'], ['follows', 'Follows'], ['swipes', 'Swipes']],
  post: [['reach', 'Reach'], ['likes', 'Likes'], ['comments', 'Comments'], ['shares', 'Shares'], ['saves', 'Saves'], ['follows', 'Follows']],
  story: [['reach', 'Reach'], ['comments', 'Replies'], ['shares', 'Shares'], ['follows', 'Follows']],
};
const MORE_FIELDS = [['views', 'Views'], ['impressions', 'Impressions'], ['profileVisits', 'Profile visits'], ['linkClicks', 'Link clicks'], ['watchTimeSec', 'Watch time (seconds)'], ['dmStarts', 'DM starts']];

async function addResults(pr, postId, after) {
  const published = S.posts.filter((p) => p.project === pr.id && p.itemId && p.status !== 'rejected' && p.status !== 'idea' && p.date && p.date <= S.today).sort((a, b) => b.date.localeCompare(a.date));
  if (!published.length) { notify('Nothing in this brand has reached its date yet, so there is nothing to add numbers to.', { kind: 'info' }); return; }
  let existing = [];
  const inputs = {};
  const fieldBox = h('div', { class: 'ins-fields' });
  const err = h('p', { class: 'ins-err', role: 'alert' });
  const pick = h('select', { class: 'field', 'aria-label': 'Post' }, published.map((p) => h('option', { value: p.itemId, selected: p.itemId === postId }, `${dateFmt.day(p.date)} · ${FORMAT_LABEL[p.format] ?? p.format} · ${p.title}`)));
  const plat = h('select', { class: 'field', 'aria-label': 'Platform' }, PLATFORMS.map((p) => h('option', { value: p }, p)));
  const win = h('select', { class: 'field', 'aria-label': 'Window' }, WINDOWS.map(([v, l]) => h('option', { value: v, selected: v === st.window }, l)));
  const captured = h('input', { class: 'field', type: 'date', value: S.today, 'aria-label': 'Numbers read on' });
  const note = h('input', { class: 'field', type: 'text', maxlength: 300, placeholder: 'Optional', 'aria-label': 'Note' });
  const save = h('button', { class: 'btn primary', type: 'button' }, 'Save results');
  const formatOf = () => published.find((p) => p.itemId === pick.value)?.format ?? 'post';

  const fill = () => {
    const entry = existing.find((e) => e.platform === plat.value && e.window === win.value);
    fieldBox.replaceChildren(...[...(FIELDS[formatOf()] ?? FIELDS.post), ...MORE_FIELDS].map(([k, label], i) => {
      const input = h('input', { class: 'field', type: 'number', min: '0', step: k === 'completionRate' || k.endsWith('Sec') ? 'any' : '1', inputmode: 'decimal', 'aria-label': label, value: entry?.metrics?.[k] !== undefined ? String(k === 'completionRate' ? Math.round(entry.metrics[k] * 1000) / 10 : entry.metrics[k]) : '' });
      inputs[k] = input;
      return h('label', { class: `ins-f${i >= (FIELDS[formatOf()] ?? FIELDS.post).length ? ' more' : ''}` }, h('span', {}, label), input);
    }));
    if (entry) { captured.value = entry.capturedAt.slice(0, 10); note.value = entry.note ?? ''; }
  };
  const reload = async () => { try { existing = (await api.get(`${base(pr)}/metrics?post=${encodeURIComponent(pick.value)}`)).items; } catch { existing = []; } fill(); };
  for (const el of [plat, win]) el.addEventListener('change', fill);
  pick.addEventListener('change', reload);

  await dialog({
    title: 'Add results',
    build: (body, finish) => {
      save.addEventListener('click', async () => {
        err.textContent = '';
        const metrics = {};
        for (const [k, input] of Object.entries(inputs)) {
          if (input.value === '') continue;
          metrics[k] = k === 'completionRate' ? Number(input.value) / 100 : Number(input.value);
        }
        if (!Object.keys(metrics).length) { err.textContent = 'Type at least one number.'; return; }
        save.disabled = true;
        try {
          await api.post(`${base(pr)}/metrics`, { post: pick.value, platform: plat.value, window: win.value, capturedAt: captured.value, metrics, ...(note.value.trim() ? { note: note.value.trim() } : {}) });
          bust();
          finish('saved');
        } catch (e) { err.textContent = e.message; save.disabled = false; }
      });
      body.append(
        h('p', { class: 'muted ins-intro' }, 'Copy the numbers exactly as the platform shows them. Leave out any you do not have: nothing is estimated. Saving again for the same post, platform and window replaces the earlier numbers.'),
        h('div', { class: 'ins-form' },
          h('label', { class: 'ins-f wide' }, h('span', {}, 'Post'), pick),
          h('label', { class: 'ins-f' }, h('span', {}, 'Platform'), plat),
          h('label', { class: 'ins-f' }, h('span', {}, 'Numbers cover'), win),
          h('label', { class: 'ins-f' }, h('span', {}, 'Read off the platform on'), captured),
          h('label', { class: 'ins-f' }, h('span', {}, 'Note'), note)),
        fieldBox,
        err, h('div', { class: 'ins-formfoot' }, save));
    },
    onOpen: () => { reload(); pick.focus(); },
    actions: [{ id: 'close', label: 'Close' }],
  }).then((r) => { if (r === 'saved') { notify('Results saved.', { kind: 'ok' }); after?.(); } });
}

// ---- importing an export -------------------------------------------------------------------------------------------------------------

async function importCsv(pr, after) {
  let text = '', filename = '';
  const out = h('div', { class: 'ins-import-out', 'aria-live': 'polite' });
  const file = h('input', { type: 'file', accept: '.csv,text/csv,.txt', 'aria-label': 'CSV file' });
  const plat = h('select', { class: 'field', 'aria-label': 'Platform' }, PLATFORMS.map((p) => h('option', { value: p }, p)));
  const win = h('select', { class: 'field', 'aria-label': 'Window' }, WINDOWS.map(([v, l]) => h('option', { value: v, selected: v === st.window }, l)));
  const captured = h('input', { class: 'field', type: 'date', value: S.today, 'aria-label': 'Exported on' });
  const check = h('button', { class: 'btn primary', type: 'button', disabled: true }, 'Check the file');

  const body = () => ({ csv: text, filename, platform: plat.value, window: win.value, capturedAt: captured.value });
  const list = (items, render, max = 12) => h('ul', { class: 'ins-ilist' }, items.slice(0, max).map(render), items.length > max ? h('li', { class: 'muted' }, `… and ${items.length - max} more`) : null);

  function show(r, finish) {
    const matched = r.matched.length;
    out.replaceChildren(...[
      h('p', { class: 'ins-sum' }, h('b', {}, `${r.rows} rows`), `: ${matched} matched, ${r.ambiguous.length} ambiguous, ${r.unmatched.length} not on the calendar${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}.`),
      r.dryRun ? h('div', { class: 'ins-formfoot left' }, h('button', {
        class: 'btn go', type: 'button', disabled: !matched,
        onclick: async (e) => {
          e.currentTarget.disabled = true;
          try { const done = await api.post(`${base(pr)}/import`, { ...body(), yes: true }); bust(); notify(`Imported: ${done.written.added} new, ${done.written.replaced} replaced.`, { kind: 'ok' }); finish('imported'); } catch (er) { notify(er.message, { kind: 'error' }); e.currentTarget.disabled = false; }
        },
      }, matched ? `Import ${plural(matched, 'matched row')}` : 'Nothing matched')) : null,
      r.columns.unknown.length ? h('p', { class: 'muted' }, `Columns ignored: ${r.columns.unknown.join(', ')}`) : null,
      r.dateOrder ? h('p', { class: 'muted' }, `Dates read as: ${r.dateOrder}.`) : null,
      ...r.warnings.map((w) => h('p', { class: 'ins-warn' }, w)),
      matched ? h('section', {}, h('h4', { class: 'lbl' }, 'Matched (these are written)'), list(r.matched, (m) => h('li', {}, h('b', {}, m.title), h('span', { class: 'muted' }, ` · ${m.kind} · ${Object.entries(m.metrics).slice(0, 4).map(([k, v]) => `${num(v)} ${k}`).join(', ')}`), ...(m.warnings ?? []).map((w) => h('div', { class: 'ins-warn' }, w))))) : null,
      r.ambiguous.length ? h('section', {}, h('h4', { class: 'lbl' }, 'Ambiguous (not written; type these in by hand)'), list(r.ambiguous, (a) => h('li', {}, `Row ${a.row}: ${a.reason}. Could be ${a.candidates.map((c) => c.title ?? c.item).join(' or ')}.`))) : null,
      r.unmatched.length ? h('section', {}, h('h4', { class: 'lbl' }, 'Not on the calendar (nothing written)'), list(r.unmatched, (u) => h('li', {}, `Row ${u.row}: ${u.caption ? `“${u.caption.slice(0, 50)}” ` : ''}${u.reason}`), 6)) : null,
    ].filter(Boolean));
  }

  await dialog({
    title: 'Import a CSV export',
    build: (bodyEl, finish) => {
      file.addEventListener('change', async () => {
        const f = file.files?.[0];
        if (!f) return;
        filename = f.name;
        text = await f.text();
        check.disabled = !text.trim();
        out.replaceChildren(h('p', { class: 'muted' }, `${f.name}: ${nf.format(f.size / 1024)} KB. Choose the window and the day you exported it, then check it.`));
      });
      check.addEventListener('click', async () => {
        check.disabled = true;
        out.replaceChildren(h('p', { class: 'muted' }, 'Checking…'));
        try { show(await api.post(`${base(pr)}/import`, body()), finish); } catch (e) { out.replaceChildren(h('p', { class: 'ins-err' }, e.message)); }
        check.disabled = false;
      });
      bodyEl.append(
        h('p', { class: 'muted ins-intro' }, 'Export the posts from Meta Business Suite (Insights > Content > Export data) or from Buffer (Analyze > Export as CSV; unzip it and use the Posts file), then choose the file here. Nothing is written until you confirm.'),
        h('div', { class: 'ins-form' },
          h('label', { class: 'ins-f wide' }, h('span', {}, 'CSV file'), file),
          h('label', { class: 'ins-f' }, h('span', {}, 'Platform'), plat),
          h('label', { class: 'ins-f' }, h('span', {}, 'Numbers cover'), win),
          h('label', { class: 'ins-f' }, h('span', {}, 'Exported on'), captured)),
        h('div', { class: 'ins-formfoot' }, check), out);
    },
    actions: [{ id: 'close', label: 'Close' }],
  }).then((r) => { if (r === 'imported') after?.(); });
}

// ---- the review prompt ---------------------------------------------------------------------------------------------------------------

async function copyReviewPrompt(pr, period) {
  let prompt;
  try { prompt = (await api.get(`${base(pr)}/prompt?period=${encodeURIComponent(period)}&window=${st.window}`)).prompt; } catch (e) { notify(e.message, { kind: 'error' }); return; }
  try { await navigator.clipboard.writeText(prompt); notify('Copied. Paste it to Claude: it writes the review and proposes the changes for you to approve.', { kind: 'ok' }); return; } catch { /* fall through to a box to copy from */ }
  const area = h('textarea', { class: 'field', rows: 14, readonly: true }, prompt);
  area.value = prompt;
  await dialog({ title: 'Copy this for Claude', build: (b) => b.append(area), onOpen: () => area.select(), actions: [{ id: 'close', label: 'Close', primary: true }] });
}

// ---- one brand ----------------------------------------------------------------------------------------------------------------------

function periodPicker(period, ctx) {
  const kind = kindOf(period);
  const nowP = periodOfDate(S.today, kind);
  const go = (id) => { S.insights = id; ctx.sync(); ctx.rerender(); };
  return h('div', { class: 'ins-picker' },
    h('div', { class: 'f-seg', role: 'radiogroup', 'aria-label': 'Month or week' }, [['month', 'Month'], ['week', 'Week']].map(([k, l]) =>
      h('button', { class: kind === k ? 'on' : '', type: 'button', role: 'radio', 'aria-checked': String(kind === k), onclick: () => { if (kind !== k) go(lastComplete(S.today, k)); } }, l))),
    h('div', { class: 'ins-step' },
      h('button', { class: 'btn quiet icon', type: 'button', onclick: () => go(stepPeriod(period, -1)), 'aria-label': 'Earlier period', title: 'Earlier' }, icon('chevL', 16)),
      h('span', { class: 'ins-period', 'aria-live': 'polite' }, labelOf(period), period === nowP ? h('span', { class: 'ins-now' }, 'so far') : null),
      h('button', { class: 'btn quiet icon', type: 'button', disabled: period >= nowP, onclick: () => go(stepPeriod(period, 1)), 'aria-label': 'Later period', title: 'Later' }, icon('chevR', 16))),
    h('select', { class: 'f-sel', 'aria-label': 'Which numbers', title: 'Which capture of the numbers to judge by. Numbers taken before the window has passed are left out.', onchange: (e) => { st.window = e.target.value; ctx.rerender(); } },
      WINDOWS.map(([v, l]) => h('option', { value: v, selected: v === st.window }, l))));
}

function headline(report, pr) {
  const hl = report.headline;
  const sums = hl.sums;
  const audience = sums.reach !== undefined ? ['Reach', sums.reach] : sums.plays !== undefined ? ['Plays', sums.plays] : sums.views !== undefined ? ['Views', sums.views] : null;
  const delta = hl.medianScore !== null && hl.previousMedianScore !== null ? hl.medianScore - hl.previousMedianScore : null;
  const figs = [
    { n: `${report.counts.scored}`, of: report.counts.observations > report.counts.scored ? ` of ${report.counts.observations}` : '', l: 'Posts scored', note: report.counts.missingNumbers ? `${plural(report.counts.missingNumbers, 'post')} without numbers` : report.counts.tooEarly ? `${report.counts.tooEarly} measured too early` : 'every published post has numbers', warn: report.counts.missingNumbers > 0 },
    { n: num(hl.medianScore), l: 'Median score', note: hl.previousMedianScore === null ? 'nothing earlier to compare with' : `${delta > 0 ? '+' : ''}${nf.format(delta)} on ${labelOf(hl.previousPeriod)} (n=${hl.previousScored})` },
    { n: audience ? num(audience[1]) : '–', l: audience ? `Total ${audience[0].toLowerCase()}` : 'Reach', note: audience ? `across ${plural(report.counts.observations - report.counts.tooEarly, 'settled post')}` : 'no reach numbers yet' },
    { n: hl.bestFormat ? FORMAT_LABEL[hl.bestFormat.key] ?? hl.bestFormat.key : '–', l: 'Strongest format', note: hl.bestFormat ? `median ${num(hl.bestFormat.median)}, n=${hl.bestFormat.n}${hl.bestFormat.n < 5 ? ' (directional)' : ''}` : 'needs scored posts', text: true },
  ];
  return h('ul', { class: 'ins-figs' }, figs.map((f) => h('li', { class: f.warn ? 'warn' : '' }, h('span', { class: `ins-fn${f.text ? ' text' : ''}` }, f.n, f.of ? h('small', {}, f.of) : null), h('span', { class: 'ins-fl' }, f.l), h('span', { class: 'ins-fnote' }, f.note))));
}

function reviewPanel(pr, period, list, ctx, rerender) {
  const box = h('section', { class: 'ins-review' }, h('h3', { class: 'lbl' }, 'The review'));
  const mine = list.reviews.find((r) => r.period === period) ?? null;
  const shown = mine ?? list.reviews[0] ?? null;
  if (!shown) {
    box.append(h('p', { class: 'muted' }, list.due.configured ? list.due.message : 'No review has been written yet. When there are numbers for a week or a month, ask Claude for one: it says what worked, what did not, and what to post next, and proposes the changes for you to approve.'));
    return box;
  }
  const body = h('div', { class: 'ins-md' });
  box.append(...[
    h('p', { class: 'ins-rmeta muted' }, mine ? `Review of ${labelOf(shown.period)}` : `Latest review (${labelOf(shown.period)}); none yet for ${labelOf(period)}`, ` · saved ${dateFmt.dm(shown.savedAt.slice(0, 10))}${shown.by ? ` by ${shown.by === 'claude' ? 'Claude' : 'you'}` : ''}${shown.medianScore !== null ? ` · median score ${num(shown.medianScore)} (n=${shown.scoredPosts})` : ''}`),
    shown.directions.length ? h('ol', { class: 'ins-dirs' }, shown.directions.map((d) => h('li', { class: `dir-${d.kind}` },
      h('span', { class: 'ins-dk' }, { 'do-more': 'Do more', stop: 'Stop', test: 'Test' }[d.kind]),
      h('span', { class: 'ins-dt' }, d.text, d.evidence ? h('span', { class: 'ins-de' }, `Evidence: ${d.evidence}`) : null),
      d.confidence ? h('span', { class: `ins-conf c-${d.confidence}` }, `${d.confidence} confidence`) : null))) : null,
    body].filter(Boolean));
  getReview(pr, shown.period).then((r) => { if (r) body.replaceChildren(...markdownNodes(r.markdown)); }).catch((e) => body.replaceChildren(h('p', { class: 'ins-err' }, e.message)));

  const mix = shown.mix?.pillars;
  const defs = project(pr.id)?.settings.pillars ?? [];
  if (mix && defs.length) {
    const changed = defs.some((d) => (mix[d.id] ?? d.share ?? 0) !== (d.share ?? 0));
    box.append(h('div', { class: 'ins-mix' },
      h('h4', { class: 'lbl' }, `Mix recommended for next month${shown.mixApplied ? ' (applied)' : ''}`),
      defs.map((d) => h('div', { class: 'ins-row' },
        h('span', { class: 'ins-name' }, d.name),
        h('span', { class: 'ins-bar', role: 'img', 'aria-label': `${d.name}: now ${Math.round((d.share ?? 0) * 100)} percent, recommended ${Math.round((mix[d.id] ?? 0) * 100)} percent` },
          h('i', { class: 'ins-fill', style: { width: `${Math.round((mix[d.id] ?? 0) * 100)}%` } }), h('i', { class: 'ins-now-mark', style: { left: `${Math.round((d.share ?? 0) * 100)}%` }, title: 'The current share' })),
        h('span', { class: 'ins-n' }, h('b', {}, `${Math.round((mix[d.id] ?? 0) * 100)}%`), ` · now ${Math.round((d.share ?? 0) * 100)}%`))),
      shown.mix.note ? h('p', { class: 'muted' }, shown.mix.note) : null,
      h('div', { class: 'ins-formfoot left' }, h('button', {
        class: 'btn', type: 'button', disabled: !changed || !!shown.mixApplied,
        title: 'Changes how many posts each pillar should get in the plan. The monthly quota stays as it is.',
        onclick: async (e) => {
          e.currentTarget.disabled = true;
          try { await api.post(`${base(pr)}/reviews/${encodeURIComponent(shown.period)}/apply-mix`, {}); bust(); notify('Pillar shares updated in the plan.', { kind: 'ok' }); await load({ force: true }); rerender(); } catch (er) { notify(er.message, { kind: 'error' }); e.currentTarget.disabled = false; }
        },
      }, shown.mixApplied ? 'Mix applied' : 'Apply this mix to the plan'))));
  }
  return box;
}

function postsTable(pr, report, ctx, onEdit) {
  const missing = report.gaps.find((g) => g.kind === 'no-numbers')?.posts ?? [];
  const row = (r) => h('tr', {},
    h('td', { class: 'c-post' }, h('button', { class: 'linklike', type: 'button', onclick: () => S.byUid.has(`${pr.id}:${r.id}`) && ctx.open(`${pr.id}:${r.id}`) }, r.title), h('span', { class: 'muted' }, ` · ${dateFmt.dm(r.date)}`)),
    h('td', {}, glyph(r.format, 13), ' ', FORMAT_LABEL[r.format] ?? r.format),
    h('td', { class: 'r' }, r.score === null ? h('span', { class: 'muted', title: r.scoreBasis.reason }, r.mature ? '–' : 'too early') : h('b', {}, num(r.score))),
    h('td', { class: 'c-nums' }, numberChips(r.metrics)),
    h('td', {}, h('button', { class: 'linklike', type: 'button', onclick: () => onEdit(r.id) }, 'Edit')));
  return h('table', { class: 'ins-table' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Post'), h('th', {}, 'Format'), h('th', { class: 'r' }, 'Score'), h('th', {}, 'Numbers'), h('th', {}, ''))),
    h('tbody', {}, report.posts.map(row), missing.map((id) => {
      const p = S.byUid.get(`${pr.id}:${id}`);
      return h('tr', { class: 'miss' }, h('td', { class: 'c-post' }, p?.title ?? id, h('span', { class: 'muted' }, p?.date ? ` · ${dateFmt.dm(p.date)}` : '')), h('td', {}, p ? [glyph(p.format, 13), ' ', FORMAT_LABEL[p.format] ?? p.format] : ''), h('td', { class: 'r muted' }, '–'), h('td', { class: 'muted' }, 'no numbers yet'), h('td', {}, h('button', { class: 'btn sm', type: 'button', onclick: () => onEdit(id) }, 'Add results')));
    })));
}

async function fillBrand(box, pr, ctx, token) {
  const period = periodNow();
  const rerender = () => { bust(); ctx.rerender(); };
  const onEdit = (postId) => addResults(pr, postId, rerender);
  try {
    const [report, reviews] = await Promise.all([getReport(pr, period), getReviews(pr)]);
    if (token !== st.token) return;
    const due = reviews.due;
    const nothing = report.counts.observations === 0;
    box.replaceChildren(...[
      due.configured && due.due ? h('div', { class: 'ins-due', role: 'status' }, h('span', {}, due.message), h('button', { class: 'btn sm', type: 'button', onclick: () => copyReviewPrompt(pr, due.period) }, icon('clipboard', 14), `Run the ${labelOf(due.period)} review with Claude`)) : null,
      headline(report, pr),
      nothing
        ? h('div', { class: 'ins-empty' },
          h('h3', {}, `No numbers for ${labelOf(period)} yet`),
          h('p', {}, report.gaps.find((g) => g.kind === 'nothing')?.message ?? 'Add the numbers for the posts that went out, and this page shows what worked.'),
          h('div', { class: 'ins-acts' }, h('button', { class: 'btn primary', type: 'button', onclick: () => importCsv(pr, rerender) }, 'Import a CSV'), h('button', { class: 'btn', type: 'button', onclick: () => addResults(pr, null, rerender) }, 'Add results by hand')))
        : [
          h('div', { class: 'ins-two' },
            h('section', {}, h('h3', { class: 'lbl' }, 'Did best'), report.top.length ? h('div', { class: 'ins-cards' }, report.top.map((r) => postCard(pr, r, ctx, onEdit, { tone: 'best' }))) : h('p', { class: 'muted' }, 'Nothing is scored yet. Posts need settled numbers first.')),
            h('section', {}, h('h3', { class: 'lbl' }, 'Did least well'), report.bottom.length ? h('div', { class: 'ins-cards' }, report.bottom.map((r) => postCard(pr, r, ctx, onEdit, { tone: 'weak' }))) : h('p', { class: 'muted' }, report.top.length ? 'Too few scored posts to name a weakest one.' : 'Nothing is scored yet.'))),
          groupsSection(report),
          h('section', { class: 'ins-posts' }, h('h3', { class: 'lbl' }, `All posts in ${labelOf(period)}`), postsTable(pr, report, ctx, onEdit)),
        ],
      reviewPanel(pr, period, reviews, ctx, rerender),
      report.gaps.length || report.caveats.length ? h('details', { class: 'ins-fold' }, h('summary', {}, h('span', { class: 'lbl' }, `What is missing, and how to read this (${report.gaps.length + report.caveats.length})`)),
        report.gaps.length ? h('ul', { class: 'ins-ul' }, report.gaps.map((g) => h('li', {}, g.message))) : null,
        h('ul', { class: 'ins-ul muted' }, report.caveats.map((c) => h('li', {}, c)))) : null].flat().filter(Boolean));
  } catch (e) {
    if (token !== st.token) return;
    box.replaceChildren(emptyState({ tone: 'bad', title: 'Insights could not load', body: e.message, action: h('button', { class: 'btn primary', type: 'button', onclick: () => { bust(); ctx.rerender(); } }, 'Try again') }));
  }
}

function groupsSection(report) {
  const segs = st.scope === 'history' ? report.segmentsAll : report.segments;
  const main = ['pillar', 'format', 'hookType', 'weekday'];
  const more = ['timeOfDay', 'face', 'reelLength', 'captionLength', 'music', 'series', 'occasion'];
  const set = (ids) => ids.map((id) => bars(segs[id], `ins-g-${id}`)).filter(Boolean);
  const moreBars = set(more);
  return h('section', { class: 'ins-groups' },
    h('div', { class: 'ins-ghead' },
      h('h3', { class: 'lbl' }, 'Results by group'),
      h('div', { class: 'f-seg', role: 'radiogroup', 'aria-label': 'Which posts' }, [['period', 'This period'], ['history', 'Whole history']].map(([v, l]) =>
        h('button', { class: st.scope === v ? 'on' : '', type: 'button', role: 'radio', 'aria-checked': String(st.scope === v), onclick: () => { st.scope = v; document.dispatchEvent(new CustomEvent('insights:rescope')); } }, l)))),
    h('p', { class: 'ins-gnote muted' }, 'Bars are the median score of the group (50 is a typical post for this account). Every group shows how many posts it rests on. “Directional only” means under 5 posts: treat it as an idea to test, never as a finding. Nothing here shows what caused a result.'),
    h('div', { class: 'ins-dims' }, set(main)),
    moreBars.length ? h('details', { class: 'ins-fold' }, h('summary', {}, h('span', { class: 'lbl' }, 'More ways to group')), h('div', { class: 'ins-dims' }, moreBars)) : null);
}

function brandSection(pr, ctx, token) {
  const period = periodNow();
  const box = h('div', { class: 'ins-body' }, skeleton(4));
  const section = h('section', { class: 'ins-brand', style: { '--lane': pr.color }, id: `ins-${pr.id}` },
    h('header', { class: 'ins-h' },
      h('i', { class: 'tick lg' }), h('h2', {}, pr.name),
      h('div', { class: 'ins-hacts' },
        h('button', { class: 'btn', type: 'button', onclick: () => addResults(pr, null, () => { bust(); ctx.rerender(); }) }, 'Add results'),
        h('button', { class: 'btn', type: 'button', onclick: () => importCsv(pr, () => { bust(); ctx.rerender(); }) }, 'Import CSV'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => copyReviewPrompt(pr, period), title: 'Copies a request for Claude: the numbers, the rules of evidence and what to save. Paste it to Claude.' }, icon('clipboard', 14), 'Run a review with Claude'))),
    totalsPanel(pr),
    timesPanel(pr),
    box);
  fillBrand(box, pr, ctx, token);
  return section;
}

// ---- the view ------------------------------------------------------------------------------------------------------------------------

let rescopeBound = false;
let lastCtx = null;

export function renderInsights(root, ctx) {
  lastCtx = ctx;
  if (!rescopeBound) { rescopeBound = true; document.addEventListener('insights:rescope', () => lastCtx?.rerender()); }
  const lanes = S.brand === 'all' ? S.projects : [project(S.brand)].filter(Boolean);
  if (!lanes.length) { root.replaceChildren(emptyState({ title: 'No brands yet', body: 'Add a brand from the left bar, then follow how its posts do here.' })); return; }
  const token = ++st.token;
  if (S.brand === 'all' && lanes.length > 1) {      // every brand side by side: its own screen (posts and audience from Buffer), not one scored summary per brand
    renderOverview(root, ctx, { lanes, alive: () => token === st.token, dueOf: async (pr) => (await getReviews(pr)).due });
    return;
  }
  const period = periodNow();
  root.replaceChildren(h('div', { class: 'ins' },
    h('div', { class: 'ins-top' },
      h('p', { class: 'ins-lede' }, 'What worked, what did not, and what to post next. Scores compare each post with the same account\'s own history, so a small account and a big one are judged fairly.'),
      periodPicker(period, ctx)),
    lanes.map((pr) => brandSection(pr, ctx, token))));
}
