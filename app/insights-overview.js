// The all-brands Insights screen: every brand side by side, from what Buffer reports (the pull Nordle already keeps on disk), so nothing here
// asks Buffer for anything. Per brand: posts sent and the audience and engagement they got against the same length of time before, how often
// the brand posts, how long since the last post, and what is coming up. Then what needs a look, and the posts that beat their own brand's usual.
// Data: GET /api/publish/buffer-overview?days=7|28|90 (src/performance/from-buffer.mjs bufferOverview); POST /api/publish/sync-posts {project}.
// A brand's own scored report (CSV or typed numbers) stays on that brand's page: "Open insights".

import { api } from './api.js';
import { h, icon } from './dom.js';
import { S, dateFmt } from './studio-store.js';
import { emptyState, notify, plural, skeleton } from './studio-ui.js';
import { openPullOptions } from './buffer-pull-options.js';

const nf0 = new Intl.NumberFormat('en-AU', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('en-AU', { maximumFractionDigits: 1 });
const compact = new Intl.NumberFormat('en-AU', { notation: 'compact', maximumFractionDigits: 1 });
const num = (x) => (x === null || x === undefined ? '–' : x >= 100000 ? compact.format(x) : nf0.format(x));
const WINDOWS = [[7, '7 days'], [28, '28 days'], [90, '90 days']];
const SERVICE = { instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok', linkedin: 'LinkedIn', youtube: 'YouTube', threads: 'Threads', x: 'X', pinterest: 'Pinterest', googlebusiness: 'Google' };
const AUDIENCE = { reach: 'reach', views: 'views' };
const STALE_POST_DAYS = 10;       // no post for this long, and nothing scheduled: worth saying
const DAY = 86400000;

const state = { days: 28 };

const daysSince = (iso) => { const ms = Date.now() - Date.parse(iso); return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / DAY)) : null; };
const wordsAgo = (iso) => { const d = daysSince(iso); return d === null ? '' : d === 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`; };
const addDay = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const nameOf = (id) => S.projects.find((p) => p.id === id)?.name ?? id;

/** "up 12%" next to a number, against the same length of time before. Nothing when there is nothing earlier to compare with. */
function change(now, before, { count = false, label } = {}) {
  if (now === null || now === undefined || before === null || before === undefined) return null;
  const title = `${num(before)}${label ? ` ${label}` : ''} in the ${state.days} days before`;
  if (count) {
    const d = now - before;
    if (!d) return h('span', { class: 'ov-d same', title }, 'same as before');
    return h('span', { class: `ov-d ${d > 0 ? 'up' : 'down'}`, title }, `${d > 0 ? '+' : '−'}${Math.abs(d)}`, h('span', { class: 'sr' }, d > 0 ? ' more than before' : ' fewer than before'));
  }
  if (!before) return null;
  const pct = Math.round(((now - before) / before) * 100);
  if (Math.abs(pct) < 3) return h('span', { class: 'ov-d same', title }, 'about the same');
  return h('span', { class: `ov-d ${pct > 0 ? 'up' : 'down'}`, title }, `${Math.abs(pct)}%`, h('span', { class: 'sr' }, pct > 0 ? ' up on before' : ' down on before'));
}

/**
 * Totals are only compared when both stretches of time have results for most of their posts (and for at least 3): a stretch where half the
 * posts have no results yet would look like a fall that never happened. Per-post averages (further on) do not have this problem.
 */
const COVERAGE = 0.6;
const comparable = (d) => d.hasPull && d.before.withNumbers >= 3 && d.before.withNumbers >= d.before.posts * COVERAGE && d.now.withNumbers >= d.now.posts * COVERAGE;

const figure = (value, delta, note) => h('div', { class: 'ov-fig' }, h('b', {}, value), delta, note ? h('small', { class: 'muted' }, note) : null);

function spark(series) {
  const max = Math.max(1, ...series.map((s) => s.posts));
  return h('span', { class: 'ov-spark', role: 'img', 'aria-label': `Posts per ${state.days <= 14 ? 'day' : 'week'}, oldest first: ${series.map((s) => s.posts).join(', ')}` },
    series.map((s) => h('i', { class: s.posts ? '' : 'zero', style: { height: `${s.posts ? Math.max(14, Math.round((s.posts / max) * 100)) : 4}%` }, title: `${plural(s.posts, 'post')} from ${dateFmt.dm(s.from)}` })));
}

/** What the calendar holds for a brand over the next two weeks. */
function comingUp(id) {
  const from = S.today, to = addDay(S.today, 13);
  const mine = S.posts.filter((p) => p.project === id && p.date && p.date >= from && p.date <= to && !['idea', 'rejected', 'posted'].includes(p.status));
  return { scheduled: mine.filter((p) => p.status === 'scheduled').length, notYet: mine.filter((p) => p.status !== 'scheduled').length, review: S.posts.filter((p) => p.project === id && p.needsReview).length };
}

function totalsOf(rows) {
  const t = { posts: 0, before: 0, eng: 0, engBefore: 0, aud: 0, audBefore: 0, follows: 0, followsBefore: 0, hasFollows: false, key: null, counted: 0, like: true };
  const pulled = rows.filter((r) => r.d.hasPull);
  t.like = pulled.every((r) => comparable(r.d));       // a change in the totals is only said when every brand in them can be compared
  t.key = pulled.some((r) => r.d.audienceKey === 'reach') ? 'reach' : pulled.some((r) => r.d.audienceKey === 'views') ? 'views' : null;   // reach (people) and views (plays) are not added together
  for (const { d } of pulled) {
    t.counted++; t.posts += d.now.posts; t.before += d.before.posts; t.eng += d.now.engagement; t.engBefore += d.before.engagement;
    if (t.key && d.audienceKey === t.key) { t.aud += d.now.audience ?? 0; t.audBefore += d.before.audience ?? 0; }
    if (d.now.follows !== null) { t.hasFollows = true; t.follows += d.now.follows; t.followsBefore += d.before.follows ?? 0; }
  }
  return t;
}

/** What needs a look, worst first. Each item says which brand and what to do about it. */
function attention(rows, ctx, { autoPull, dues, refreshOne }) {
  const out = [];
  const staleHours = Math.max(24, (autoPull?.everyHours ?? 6) * 2);
  for (const { pr, d, up } of rows) {
    if (!d.connected && !d.hasPull) out.push({ tone: 'info', rank: 5, brand: pr, text: 'has no Buffer numbers yet. Connect Buffer in Publishing, or add results by hand on its page.', act: { label: 'Open insights', fn: () => ctx.setBrand(pr.id) } });
    else if (d.connected && !d.hasPull) out.push({ tone: 'warn', rank: 2, brand: pr, text: 'is connected to Buffer, but nothing has been read from it yet.', act: { label: 'Update from Buffer', fn: () => refreshOne(pr.id) } });
    else if (d.hasPull && d.pulledAt && (Date.now() - Date.parse(d.pulledAt)) / 3600000 > staleHours) {
      out.push({ tone: 'warn', rank: 3, brand: pr, text: `was last read from Buffer ${wordsAgo(d.pulledAt)}${autoPull?.enabled === false ? ', and reading by itself is switched off' : ''}.`, act: { label: 'Update from Buffer', fn: () => refreshOne(pr.id) } });
    }
    if (d.hasPull && d.lastPostAt && daysSince(d.lastPostAt) >= STALE_POST_DAYS && !up.scheduled) out.push({ tone: 'bad', rank: 1, brand: pr, text: `has not posted for ${daysSince(d.lastPostAt)} days and nothing is scheduled.`, act: { label: 'Open insights', fn: () => ctx.setBrand(pr.id) } });
    const due = dues.get(pr.id);
    if (due) out.push({ tone: 'info', rank: 6, brand: pr, text: `is due a ${due.cadence ?? 'regular'} review of ${due.label ?? due.period}.`, act: { label: 'Open insights', fn: () => ctx.setBrand(pr.id) } });
  }
  return out.sort((a, b) => a.rank - b.rank).slice(0, 6);
}

function brandRow(r, ctx) {
  const { pr, d, up } = r;
  const key = d.audienceKey;
  const none = !d.hasPull;
  const cell = (label, ...kids) => h('td', { 'data-label': label }, ...kids);
  const dash = h('span', { class: 'muted' }, '–');
  return h('tr', { style: { '--lane': pr.color }, id: `ov-${pr.id}` },
    h('th', { scope: 'row', class: 'ov-brand' }, h('i', { class: 'tick' }), h('span', {}, h('b', {}, pr.name),
      none ? h('small', { class: 'muted' }, d.connected ? 'Nothing read from Buffer yet' : 'Buffer not connected') : h('small', { class: 'muted' }, d.channels.length ? d.channels.map((c) => `${SERVICE[c.service] ?? c.service} ${c.posts}`).join(' · ') : 'No posts in this time'))),
    cell('Posts sent', none ? dash : figure(nf0.format(d.now.posts), change(d.now.posts, d.before.posts, { count: true }), d.now.posts && d.now.withNumbers < d.now.posts ? `${d.now.withNumbers} with results` : '')),
    cell(key ? `Audience (${AUDIENCE[key]})` : 'Audience', none || !key ? dash : figure(num(d.now.audience), comparable(d) ? change(d.now.audience, d.before.audience, { label: AUDIENCE[key] }) : null, AUDIENCE[key])),
    cell('Engagement', none || !d.now.withNumbers ? dash : figure(num(d.now.engagement), comparable(d) ? change(d.now.engagement, d.before.engagement) : null, 'likes, comments, shares, saves')),
    cell('Per post', none || d.usualEngagement === null ? dash : figure(nf1.format(d.usualEngagement), d.now.withNumbers >= 3 && d.before.withNumbers >= 3 ? change(d.usualEngagement, d.usualEngagementBefore) : null, 'engagement each')),
    cell('Posting', none ? dash : h('div', { class: 'ov-rhythm' }, spark(d.series), h('small', { class: d.lastPostAt && daysSince(d.lastPostAt) >= STALE_POST_DAYS ? 'warn' : 'muted' }, d.lastPostAt ? `Last: ${wordsAgo(d.lastPostAt)}` : 'No posts yet'))),
    cell('Coming up', h('div', { class: 'ov-up' },
      up.scheduled || up.notYet ? h('span', {}, h('b', {}, up.scheduled), ' scheduled', up.notYet ? h('small', { class: 'muted' }, `${up.notYet} not scheduled yet`) : null) : h('span', { class: 'warn' }, 'Nothing in the next 2 weeks'),
      up.review ? h('small', { class: 'ov-review' }, `${up.review} to review`) : null)),
    h('td', { class: 'ov-go' }, h('button', { class: 'btn quiet', type: 'button', 'data-act': 'ov-open', 'aria-label': `Open insights for ${pr.name}`, onclick: () => ctx.setBrand(pr.id) }, 'Open', icon('chevR', 14))));
}

function bestPosts(rows) {
  const all = rows.flatMap(({ pr, d }) => (d.top ?? []).filter((t) => t.lift !== null).map((t) => ({ pr, d, t })));
  return all.sort((a, b) => b.t.lift - a.t.lift || b.t.engagement - a.t.engagement).slice(0, 5);
}

function bestSection(rows) {
  const best = bestPosts(rows);
  return h('section', { class: 'ov-sec', 'aria-label': 'Posts that beat their brand’s usual' },
    h('h3', { class: 'lbl' }, 'Posts that beat their own brand’s usual'),
    best.length
      ? h('ol', { class: 'ov-best' }, best.map(({ pr, d, t }) => h('li', { style: { '--lane': pr.color } },
        h('div', { class: 'ov-bmeta' }, h('i', { class: 'tick' }), h('b', {}, pr.name), h('span', { class: 'muted' }, ` · ${SERVICE[t.service] ?? t.service}${t.sentAt ? ` · ${dateFmt.dm(t.sentAt.slice(0, 10))}` : ''}`)),
        t.text ? h('p', { class: 'ov-btext' }, `“${t.text}”`) : h('p', { class: 'ov-btext muted' }, 'No caption'),
        h('div', { class: 'ov-bnums' }, h('b', {}, `${nf1.format(t.lift)}×`), ' this brand’s usual engagement', h('span', { class: 'muted' }, ` · ${plural(t.engagement, 'engagement')}${t.audience !== null && d.audienceKey ? `, ${num(t.audience)} ${AUDIENCE[d.audienceKey]}` : ''}`)))))
      : h('p', { class: 'muted' }, 'A brand needs at least 5 posts with results in this time before one can be said to beat its usual. Pick a longer time, or wait for more results to come in.'));
}

function attentionSection(items) {
  return h('section', { class: 'ov-sec ov-attn', 'aria-label': 'Needs a look' },
    h('h3', { class: 'lbl' }, 'Needs a look'),
    items.length
      ? h('ul', { class: 'ov-items' }, items.map((it) => h('li', { class: `ov-item ${it.tone}`, style: { '--lane': it.brand.color } },
        h('i', { class: 'tick' }), h('span', { class: 'ov-itext' }, h('b', {}, it.brand.name), ' ', it.text),
        h('button', { class: 'btn sm', type: 'button', onclick: it.act.fn }, it.act.label))))
      : h('p', { class: 'ov-ok' }, icon('check', 15), 'Every brand has recent numbers, something coming up, and nothing waiting on you.'));
}

function totalsStrip(rows) {
  const t = totalsOf(rows);
  if (!t.counted) return null;
  return h('ul', { class: 'ov-totals', 'aria-label': 'All brands together' }, [
    h('li', {}, h('span', { class: 'ov-tl' }, 'Posts sent'), figure(nf0.format(t.posts), change(t.posts, t.before, { count: true }), plural(t.counted, 'brand'))),
    t.key ? h('li', {}, h('span', { class: 'ov-tl' }, t.key === 'reach' ? 'Reach' : 'Views'), figure(num(t.aud), t.like ? change(t.aud, t.audBefore) : null, t.key === 'reach' ? 'people reached' : 'plays')) : null,
    h('li', {}, h('span', { class: 'ov-tl' }, 'Engagement'), figure(num(t.eng), t.like ? change(t.eng, t.engBefore) : null, 'likes, comments, shares, saves')),
    t.follows > 0 ? h('li', {}, h('span', { class: 'ov-tl' }, 'New followers'), figure(num(t.follows), t.like ? change(t.follows, t.followsBefore) : null, 'where Buffer reports them')) : null,
  ].filter(Boolean));
}

/**
 * Build the screen into `root`. `alive()` says whether the page has moved on (so a late answer is ignored); `dueOf(pr)` resolves a brand's
 * review-due notice (or null).
 */
export function renderOverview(root, ctx, { lanes, alive, dueOf }) {
  const status = h('span', { class: 'muted ov-status', role: 'status' });
  const body = h('div', { class: 'ov-body' }, skeleton(5));
  let data = null;
  let busy = false;

  const picker = h('div', { class: 'f-seg', role: 'radiogroup', 'aria-label': 'How far back' }, WINDOWS.map(([v, l]) =>
    h('button', { class: state.days === v ? 'on' : '', type: 'button', role: 'radio', 'aria-checked': String(state.days === v), 'data-days': String(v), onclick: () => { if (state.days === v) return; state.days = v; for (const b of picker.children) { const on = b.dataset.days === String(v); b.className = on ? 'on' : ''; b.setAttribute('aria-checked', String(on)); } load(); } }, l)));
  const updateBtn = h('button', { class: 'btn primary', type: 'button', 'data-act': 'ov-update', title: 'Ask Buffer for the posts that have gone out and how they did, for every brand that has Buffer connected (a few requests each)', onclick: () => updateAll() }, icon('calendarSend', 14), 'Update all from Buffer');
  const optionsBtn = h('button', { class: 'btn quiet', type: 'button', 'data-act': 'ov-options', title: 'How often, and what, Nordle reads from Buffer by itself', onclick: () => lanes[0] && openPullOptions(lanes[0]) }, 'Options');

  async function dues() {
    const m = new Map();
    await Promise.all(lanes.map(async (pr) => { try { const due = await dueOf(pr); if (due?.configured && due.due) m.set(pr.id, due); } catch { /* a review notice is optional */ } }));
    return m;
  }

  function draw() {
    if (!alive()) return;
    const by = new Map(data.brands.map((b) => [b.project, b]));
    const rows = lanes.map((pr) => ({ pr, d: by.get(pr.id), up: comingUp(pr.id) })).filter((r) => r.d);
    const ap = data.autoPull ?? {};
    status.textContent = ap.enabled === false ? 'Reading Buffer by itself is off.' : `Nordle reads Buffer by itself about every ${ap.everyHours ?? 6} hours.`;
    const anyPulled = rows.some((r) => r.d.hasPull);
    const attn = h('div', { class: 'ov-attn-slot' });          // filled once the review notices are in; the rest does not wait for them
    body.replaceChildren(...[
      anyPulled ? totalsStrip(rows) : null,
      attn,
      h('div', { class: 'ov-tablewrap' }, h('table', { class: 'ov-table' },
        h('caption', { class: 'sr' }, `Every brand, last ${state.days} days`),
        h('thead', {}, h('tr', {}, ['Brand', 'Posts sent', 'Audience', 'Engagement', 'Per post', 'Posting', 'Coming up', ''].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', {}, rows.map((r) => brandRow(r, ctx))))),
      anyPulled ? null : h('div', { class: 'ov-empty' }, h('h3', {}, 'No Buffer numbers yet'), h('p', {}, 'Connect Buffer in Publishing, then press “Update all from Buffer”. After that Nordle keeps these numbers up to date by itself.')),
      anyPulled ? bestSection(rows) : null,
      h('p', { class: 'ov-note muted' }, 'Engagement is likes, comments, shares and saves. Reach counts people and views count plays, so a brand shown in views is not comparable with one shown in reach. The arrows compare with the same length of time just before. The last day and a half are still settling in Buffer, so the newest posts look smaller than they will end up.'),
    ].filter(Boolean));
    const fill = (dm) => attn.replaceChildren(attentionSection(attention(rows, ctx, { autoPull: data.autoPull, dues: dm, refreshOne })));
    fill(new Map());                                            // at once, without the review notices (they need a call per brand) ...
    dues().then((dm) => { if (alive() && attn.isConnected && dm.size) fill(dm); });   // ... and again with them
  }

  async function load() {
    try {
      data = await api.get(`/publish/buffer-overview?days=${state.days}`);
      draw();
    } catch (e) { if (alive()) body.replaceChildren(emptyState({ tone: 'bad', title: 'The overview could not load', body: e.message, action: h('button', { class: 'btn primary', type: 'button', onclick: () => load() }, 'Try again') })); }
  }

  async function pull(ids) {
    let fetched = 0, skipped = 0;
    const failed = [];
    for (const [i, id] of ids.entries()) {
      status.textContent = `Asking Buffer for ${nameOf(id)}${ids.length > 1 ? ` (${i + 1} of ${ids.length})` : ''}…`;
      try { const r = await api.post('/publish/sync-posts', { project: id }); if (r.skipped) skipped++; else fetched += r.fetched ?? 0; } catch (e) { failed.push(`${nameOf(id)}: ${e.message}`); }
    }
    return { fetched, skipped, failed };
  }
  async function updateAll() {
    const ids = (data?.brands ?? []).filter((b) => b.connected && b.channelCount).map((b) => b.project);
    if (!ids.length) { notify('No brand has Buffer connected with channels chosen yet. Connect it in Publishing first.', { kind: 'info' }); return; }
    if (busy) return;
    busy = true; updateBtn.disabled = true;
    const r = await pull(ids);
    busy = false; updateBtn.disabled = false;
    notify(`${r.fetched ? `Read ${plural(r.fetched, 'post')} from Buffer.` : 'Nothing new from Buffer.'}${r.skipped ? ` ${plural(r.skipped, 'brand')} read in the last few hours, left alone.` : ''}${r.failed.length ? ` Could not read: ${r.failed.join('; ')}` : ''}`, { kind: r.failed.length ? 'error' : 'ok', ms: 10000 });
    document.dispatchEvent(new Event('nordle-insights-refresh'));
    await load();
  }
  async function refreshOne(id) {
    if (busy) return;
    busy = true; updateBtn.disabled = true;
    const r = await pull([id]);
    busy = false; updateBtn.disabled = false;
    notify(r.failed.length ? `Could not read: ${r.failed.join('; ')}` : r.skipped ? `${nameOf(id)} was read in the last few hours, so it was left alone.` : `Read ${plural(r.fetched, 'post')} from Buffer for ${nameOf(id)}.`, { kind: r.failed.length ? 'error' : 'ok', ms: 8000 });
    await load();
  }

  root.replaceChildren(h('div', { class: 'ins ov' },
    h('div', { class: 'ins-top' },
      h('p', { class: 'ins-lede' }, 'Every brand side by side: what went out, what it got, and what needs you. Read from Buffer, and kept up to date by Nordle. Open a brand for its scored posts and its review.'),
      h('div', { class: 'ov-tools' }, picker, updateBtn, optionsBtn)),
    h('div', { class: 'ov-statusline' }, status),
    body));
  load();
}
