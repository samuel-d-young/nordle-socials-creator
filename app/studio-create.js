// Make posts: tell Claude what you want, or pick from options Nordle has worked out for the next month (from the brand's own facts, the occasions,
// the monthly mix and, once results are connected, what did well). Tick the ones you like and they go on the calendar. Nothing is posted.
// Server: GET /api/projects/<id>/calendar/suggest (src/calendar/suggest.mjs), POST /api/projects/<id>/calendar/items.

import { api } from './api.js';
import { h, icon } from './dom.js';
import { S, addMonths, dateFmt, monthOf, project, load } from './studio-store.js';
import { FORMAT_LABEL, elapsed, emptyState, glyph, notify, plural } from './studio-ui.js';

const FORMATS = ['reel', 'carousel', 'post', 'story'];
const FORMAT_WORD = { reel: 'Reels', carousel: 'Carousels', post: 'Posts', story: 'Stories' };
const COUNTS = [4, 8, 12];

const st = { job: null, jobTimer: 0, brand: null, prompt: '', month: null, decide: true, count: 8, formats: new Set(), styles: new Set(), learn: true, result: null, picked: new Set(), loading: false, error: '', added: null };

function brandId() {
  if (S.brand && S.brand !== 'all') return S.brand;
  if (!st.brand || !project(st.brand)) st.brand = S.projects[0]?.id ?? null;
  return st.brand;
}
const nextMonth = () => addMonths(monthOf(S.today), 1);

async function suggest(redraw) {
  const id = brandId();
  if (!id) return;
  st.loading = true; st.error = ''; st.added = null; redraw();
  const q = new URLSearchParams({ month: st.month ?? nextMonth(), learn: st.learn ? '1' : '0' });
  if (st.decide) q.set('decide', '1'); else q.set('count', String(st.count));
  if (st.formats.size) q.set('formats', [...st.formats].join(','));
  if (st.styles.size) q.set('styles', [...st.styles].join(','));
  if (st.prompt.trim()) q.set('prompt', st.prompt.trim());
  try {
    st.result = await api.get(`/projects/${encodeURIComponent(id)}/calendar/suggest?${q}`);
    st.picked = new Set(st.result.options.map((o) => o.id));
  } catch (e) { st.error = e.message; }
  st.loading = false; redraw();
}

/** Start Claude on this month, from here: no pasting. Nordle runs `claude` on this computer (it must be signed in: claude auth login). */
async function askClaude(redraw) {
  const id = brandId();
  if (!id) return;
  if (!st.result) await suggest(() => {});
  try {
    await api.post(`/projects/${encodeURIComponent(id)}/calendar/run`, { action: 'propose', months: [st.month ?? nextMonth()], extra: st.result?.ask ?? st.prompt });
  } catch (e) { st.error = e.message; return redraw(); }
  watchJob(redraw);
}

async function checkJob(redraw) {
  const id = brandId();
  if (!id) return;
  try {
    const r = await api.get(`/projects/${encodeURIComponent(id)}/calendar/run-status`);
    const was = st.job?.running;
    st.job = r;
    if (r.running) { clearTimeout(st.jobTimer); st.jobTimer = setTimeout(() => checkJob(redraw), 3000); }
    else if (was) { await load({ force: true }); }
  } catch { /* the next look will try again */ }
  redraw();
}
function watchJob(redraw) { clearTimeout(st.jobTimer); checkJob(redraw); }

function jobPanel() {
  const j = st.job;
  if (!j || (!j.running && !j.last) || (j.last && j.last.kind !== 'propose' && !j.running)) return null;
  if (j.running?.kind === 'propose') {
    return h('div', { class: 'build-line live', role: 'status', 'data-state': 'working' }, h('i', { class: 'spin', 'aria-hidden': 'true' }),
      h('span', {}, h('b', {}, 'Claude is writing ideas'), ` for ${(j.running.months ?? []).map((m) => dateFmt.monthYear(m)).join(', ') || 'the next month'} · ${elapsed(j.running.startedAt)}. This takes a few minutes. You can leave this page; the ideas appear in the Plan.`));
  }
  if (j.running) return null;
  const l = j.last;
  if (l.outcome === 'proposed') return h('div', { class: 'build-line', role: 'status', 'data-state': 'done' }, icon('check', 14), h('span', {}, h('b', {}, `Claude added ${plural(l.added ?? 0, 'idea')}`), ' for you to look at. ', h('a', { href: '#/s/plan' }, 'Open the plan')));
  return h('div', { class: 'build-line', role: 'alert', 'data-state': 'failed' }, icon('alert', 14), h('span', { class: 'bad' }, l.error ?? 'Claude did not add any ideas.'));
}

async function addPicked(redraw, { approved }) {
  const id = brandId();
  const chosen = st.result.options.filter((o) => st.picked.has(o.id));
  if (!chosen.length) return;
  st.loading = true; redraw();
  try {
    const items = chosen.map(({ date, time, format, title, idea, hook, pillar, occasion }) => ({ date, ...(time ? { time } : {}), format, title, idea, hook, ...(pillar ? { pillar } : {}), ...(occasion ? { occasion } : {}), status: approved ? 'approved' : 'idea' }));
    const r = await api.post(`/projects/${encodeURIComponent(id)}/calendar/items`, { items });
    const done = r.items?.length ?? 0, left = r.rejected?.length ?? 0;
    st.added = { done, left, note: left ? `${plural(left, 'option')} could not be added: ${r.rejected[0].errors?.[0]?.message ?? 'a check failed'}.` : '', approved };
    st.result.options = st.result.options.filter((o) => !st.picked.has(o.id) || (r.rejected ?? []).some((x) => x.input?.title === o.title));
    st.picked = new Set();
    await load({ force: true });
    notify(`${plural(done, 'post')} added to the calendar${approved ? '' : ' as ideas'}.`, { kind: 'ok' });
  } catch (e) { st.error = e.message; }
  st.loading = false; redraw();
}

const chip = (label, on, onclick, extra = {}) => h('button', { class: `cr-chip${on ? ' on' : ''}`, type: 'button', 'aria-pressed': on ? 'true' : 'false', onclick, ...extra }, label);

function copyRequest(text) {
  navigator.clipboard?.writeText(text).then(() => notify('Copied. Paste it into Claude Code (with Nordle connected).', { kind: 'ok' }), () => notify('Could not copy to the clipboard.', { kind: 'error' }));
}

function optionCard(o, redraw) {
  const on = st.picked.has(o.id);
  return h('li', { class: `cr-opt${on ? ' on' : ''}`, dataset: { id: o.id } },
    h('label', { class: 'cr-opt-main' },
      h('input', { type: 'checkbox', checked: on, 'data-field': 'create-pick', 'aria-label': `Add ${o.title}`, onchange: (e) => { if (e.target.checked) st.picked.add(o.id); else st.picked.delete(o.id); redraw(); } }),
      h('span', { class: 'cr-opt-body' },
        h('span', { class: 'cr-opt-top' }, glyph(o.format, 13), h('span', { class: 'cr-fmt' }, FORMAT_LABEL[o.format] ?? o.format), h('span', { class: 'cr-date' }, `${dateFmt.weekday(o.date)} ${dateFmt.dm(o.date)}`), h('span', { class: 'cr-style' }, o.styleLabel)),
        h('strong', { class: 'cr-title' }, o.title),
        h('span', { class: 'cr-idea' }, o.idea),
        h('span', { class: 'cr-why muted' }, o.why))));
}

function controls(pr, redraw) {
  const months = [0, 1, 2].map((i) => addMonths(monthOf(S.today), i + 1));
  const month = st.month ?? months[0];
  const learned = st.result?.learned;
  return h('section', { class: 'cr-card', 'aria-label': 'Choose what to make' },
    h('h3', { class: 'lbl' }, 'Or choose, and Nordle suggests'),
    S.brand === 'all' && S.projects.length > 1 ? h('div', { class: 'cr-row' }, h('span', { class: 'lbl-i' }, 'Brand'),
      h('select', { class: 'field', 'data-field': 'create-brand', onchange: (e) => { st.brand = e.target.value; st.result = null; st.job = null; redraw(); } }, S.projects.map((p) => h('option', { value: p.id, selected: p.id === pr.id }, p.name)))) : null,
    h('div', { class: 'cr-row' }, h('span', { class: 'lbl-i' }, 'For'),
      h('div', { class: 'cr-chips', role: 'group', 'aria-label': 'Month' }, months.map((m) => chip(dateFmt.monthYear(m), m === month, () => { st.month = m; st.result = null; redraw(); }, { 'data-month': m })))),
    h('div', { class: 'cr-row' }, h('span', { class: 'lbl-i' }, 'How many'),
      h('div', { class: 'cr-chips', role: 'group', 'aria-label': 'How many posts' },
        chip('Decide for me', st.decide, () => { st.decide = true; redraw(); }, { 'data-act': 'create-decide' }),
        COUNTS.map((n) => chip(String(n), !st.decide && st.count === n, () => { st.decide = false; st.count = n; redraw(); }, { 'data-count': n })),
        h('input', { class: 'field cr-num', type: 'number', min: 1, max: 30, value: String(st.count), 'aria-label': 'A number of posts', 'data-field': 'create-count', onchange: (e) => { st.decide = false; st.count = Math.max(1, Math.min(30, Number(e.target.value) || 8)); redraw(); } }))),
    h('div', { class: 'cr-row' }, h('span', { class: 'lbl-i' }, 'Kinds'),
      h('div', { class: 'cr-chips', role: 'group', 'aria-label': 'Kinds of post' },
        chip('A mix for me', st.formats.size === 0, () => { st.formats = new Set(); redraw(); }, { 'data-act': 'create-mix' }),
        FORMATS.map((f) => chip(FORMAT_WORD[f], st.formats.has(f), () => { if (st.formats.has(f)) st.formats.delete(f); else st.formats.add(f); redraw(); }, { 'data-format': f })))),
    h('div', { class: 'cr-row' }, h('span', { class: 'lbl-i' }, 'Style'),
      h('div', { class: 'cr-chips', role: 'group', 'aria-label': 'Style of post' },
        chip('Any style', st.styles.size === 0, () => { st.styles = new Set(); redraw(); }, { 'data-act': 'create-any-style' }),
        (st.result?.styles ?? STYLES_FALLBACK).map((s) => chip(s.label, st.styles.has(s.id), () => { if (st.styles.has(s.id)) st.styles.delete(s.id); else st.styles.add(s.id); redraw(); }, { 'data-style': s.id, title: s.hint })))),
    h('label', { class: 'cr-learn' },
      h('input', { type: 'checkbox', checked: st.learn, 'data-field': 'create-learn', onchange: (e) => { st.learn = e.target.checked; redraw(); } }),
      h('span', {}, h('b', {}, 'Learn from my results'), h('span', { class: 'muted' }, learned?.connected
        ? ` Your results are connected (${plural(learned.posts, 'post')} measured). ${st.result.learnedLine ?? 'No clear winner yet, so the mix stays balanced.'}`
        : ' Connect your results in Insights and Nordle will lean toward the formats and themes that did best. Until then it uses your brand, its facts and the calendar.'))),
    h('div', { class: 'cr-go' },
      h('button', { class: 'btn primary start', type: 'button', 'data-act': 'create-suggest', disabled: st.loading, onclick: () => suggest(redraw) }, st.loading ? 'Working…' : (st.result ? 'Show me new options' : 'Show me options'))));
}

const STYLES_FALLBACK = [
  { id: 'team', label: 'Meet the team', hint: 'The people behind the brand' }, { id: 'educate', label: 'Explain something', hint: 'What it is, what to expect' },
  { id: 'faq', label: 'Answer a question', hint: 'One real question, answered' }, { id: 'behind', label: 'Behind the scenes', hint: 'How things are really done' },
  { id: 'seasonal', label: 'Seasons and occasions', hint: 'Dates worth a post' }, { id: 'community', label: 'Community and local', hint: 'Your area and what you support' },
  { id: 'invite', label: 'A gentle invitation', hint: 'A soft call to book, call or visit' },
];

export function renderCreate(root, ctx) {
  const redraw = () => renderCreate(root, ctx);
  const id = brandId();
  const pr = id && project(id);
  if (!pr) return root.replaceChildren(emptyState({ title: 'No brands yet', body: 'Add a brand first, then you can make posts for it here.' }));
  const r = st.result;
  const picked = r ? r.options.filter((o) => st.picked.has(o.id)) : [];
  const ask = h('section', { class: 'cr-card', 'aria-label': 'Ask Claude' },
    h('h3', { class: 'lbl' }, 'Tell Claude what you want'),
    (() => { const t = h('textarea', { class: 'field cr-prompt', rows: 3, 'data-field': 'create-prompt', placeholder: 'e.g. Three reels about meeting the team, and a carousel on what to expect at a first visit. Keep it light.' }); t.value = st.prompt; t.addEventListener('input', () => { st.prompt = t.value; }); return t; })(),
    h('div', { class: 'cr-go' },
      h('button', { class: 'btn primary', type: 'button', 'data-act': 'create-run', disabled: !!st.job?.running, onclick: () => askClaude(redraw) }, 'Ask Claude now'),
      h('button', { class: 'btn', type: 'button', 'data-act': 'create-ask', onclick: () => { if (r) return copyRequest(r.request); suggest(redraw).then(() => st.result && copyRequest(st.result.request)); } }, icon('clipboard', 14), 'Copy for Claude Code instead'),
      h('span', { class: 'muted' }, 'Nordle starts Claude on this computer and the ideas land in your Plan. Claude Code must be signed in (claude auth login). Or pick from the options below.')),
    jobPanel());

  const results = r ? h('section', { class: 'cr-card cr-results', 'aria-label': 'Options', 'data-state': 'options' },
    h('header', { class: 'cr-rh' },
      h('h3', { class: 'lbl' }, `${plural(r.options.length, 'option')} for ${r.monthLabel}`),
      r.options.length ? h('span', { class: 'cr-sel' }, h('button', { class: 'linklike', type: 'button', 'data-act': 'create-all', onclick: () => { st.picked = new Set(r.options.map((o) => o.id)); redraw(); } }, 'Tick all'), ' · ', h('button', { class: 'linklike', type: 'button', 'data-act': 'create-none', onclick: () => { st.picked = new Set(); redraw(); } }, 'Tick none')) : null),
    r.short ? h('p', { class: 'cr-note', role: 'note' }, r.short) : null,
    r.options.length ? h('ul', { class: 'cr-opts' }, r.options.map((o) => optionCard(o, redraw))) : h('p', { class: 'muted' }, st.added ? 'Those are all on the calendar. Choose again for more.' : 'Nothing to suggest with those choices. Try another style or kind.'),
    h('footer', { class: 'cr-foot' },
      h('span', { class: 'cr-count' }, `${picked.length} ticked`),
      h('button', { class: 'btn go', type: 'button', 'data-act': 'create-add', disabled: !picked.length || st.loading, onclick: () => addPicked(redraw, { approved: true }), title: 'They go on the calendar approved: Claude builds each one as its date gets close' }, `Add ${picked.length || ''} to the calendar`.replace('  ', ' ')),
      h('button', { class: 'btn', type: 'button', 'data-act': 'create-add-ideas', disabled: !picked.length || st.loading, onclick: () => addPicked(redraw, { approved: false }), title: 'They wait in the Plan as ideas until you say yes' }, 'Add as ideas to look at'),
      h('button', { class: 'btn quiet', type: 'button', 'data-act': 'create-copy', onclick: () => copyRequest(r.request) }, icon('clipboard', 14), 'Ask Claude to improve these')),
    st.added ? h('p', { class: 'cr-added', role: 'status' }, `${plural(st.added.done, 'post')} ${st.added.approved ? 'added and approved' : 'added as ideas'}. `, st.added.note, ' ', h('a', { href: '#/s/plan' }, 'Open the plan')) : null) : null;

  if (!st.job) { st.job = { running: null, last: null }; checkJob(redraw); }
  root.replaceChildren(h('div', { class: 'create' },
    h('header', { class: 'cr-head' },
      h('h2', {}, `For ${pr.name}`),
      h('p', { class: 'muted' }, 'Start with a few words, or let Nordle suggest posts for the next month. You choose what goes on the calendar; nothing is posted.')),
    ask, controls(pr, redraw), st.error ? h('p', { class: 'cr-err', role: 'alert' }, st.error) : null, results));
}
