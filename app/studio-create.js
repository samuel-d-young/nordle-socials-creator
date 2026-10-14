// Make posts: tell Claude what you want, or pick from options Nordle has worked out for the next month (from the brand's own facts, the occasions,
// the monthly mix and, once results are connected, what did well). Tick the ones you like and they go on the calendar. Nothing is posted.
// Server: GET /api/projects/<id>/calendar/suggest (src/calendar/suggest.mjs), POST /api/projects/<id>/calendar/items.

import { api } from './api.js';
import { h, icon } from './dom.js';
import { S, addMonths, dateFmt, monthOf, project, load } from './studio-store.js';
import { reelOptions } from './studio-reel.js';
import { simpleView } from './studio-create-simple.js';
import { reelSummary } from '/src/shared/reel-options.mjs';
import { FORMAT_LABEL, claudeSignIn, elapsed, emptyState, glyph, keepTyping, notify, plural } from './studio-ui.js';

const FORMATS = ['reel', 'carousel', 'post', 'story'];
const FORMAT_WORD = { reel: 'Reels', carousel: 'Carousels', post: 'Posts', story: 'Stories' };
const COUNTS = [4, 8, 12];

const vid = { paths: [], typed: '', size: 'ig-reel-9x16', mode: 'each', busy: false, note: '', done: null };
const VID_SIZES = [['ig-reel-9x16', 'Reel (tall)'], ['ig-story-9x16', 'Story (tall)'], ['ig-feed-4x5', 'Feed (4:5)'], ['ig-feed-1x1', 'Feed (square)'], ['yt-landscape-16x9', 'Landscape (16:9)']];
const base = (p) => p.split(/[\\/]/).pop();
const st = { campaign: null, newCamp: null, job: null, jobTimer: 0, brand: null, prompt: '', guide: '', reel: null, month: null, decide: true, count: 8, formats: new Set(), styles: new Set(), learn: true, result: null, picked: new Set(), loading: false, error: '', added: null };

function brandId() {
  if (st.pick && st.pickAt === S.brand && project(st.pick)) return st.pick;   // chosen on this page, while the left bar stayed as it was
  if (S.brand && S.brand !== 'all') return S.brand;
  if (!st.brand || !project(st.brand)) st.brand = S.projects[0]?.id ?? null;
  return st.brand;
}
/** Make posts for another brand, from this page (the left bar's filter is left alone). Everything shown belongs to the brand, so it starts fresh. */
function chooseBrand(id, redraw) {
  if (id === brandId()) return;
  Object.assign(st, { pick: id, pickAt: S.brand, brand: id, result: null, picked: new Set(), job: null, campaign: null, newCamp: null, added: null, error: '', reel: null, guide: '', prompt: '' });
  vid.done = null; vid.note = '';
  redraw();
}
const nextMonth = () => addMonths(monthOf(S.today), 1);

/** Simple (three steps) or Advanced (every control). Remembered in this browser; Simple until the person picks Advanced. */
const MODE_KEY = 'nordle.create.mode';
let mode = (() => { try { return localStorage.getItem(MODE_KEY) === 'advanced' ? 'advanced' : 'simple'; } catch { return 'simple'; } })();
function setMode(m, redraw) { mode = m; try { localStorage.setItem(MODE_KEY, m); } catch { /* private window: it lasts until the page reloads */ } redraw(); }

async function suggest(redraw) {
  const id = brandId();
  if (!id) return;
  st.loading = true; st.error = ''; st.added = null; redraw();
  const q = new URLSearchParams({ month: st.month ?? nextMonth(), learn: st.learn ? '1' : '0' });
  if (st.campaign) q.set('campaign', st.campaign);
  if (st.decide) q.set('decide', '1'); else q.set('count', String(st.count));
  if (st.formats.size) q.set('formats', [...st.formats].join(','));
  if (st.styles.size) q.set('styles', [...st.styles].join(','));
  if (asked()) q.set('prompt', asked());
  try {
    st.result = await api.get(`/projects/${encodeURIComponent(id)}/calendar/suggest?${q}`);
    st.picked = new Set(st.result.options.map((o) => o.id));
  } catch (e) { st.error = e.message; }
  st.loading = false; redraw();
}

/** What the owner typed to steer Claude: the request, any extra information, and the reel choices. */
const asked = () => {
  const reel = reelSummary(st.reel);
  return [st.prompt.trim(), st.guide.trim() ? `Extra information from the owner (copy it into each post's \`guidance\`): ${st.guide.trim()}` : '', reel ? `For reels, the owner chose: ${reel}. Put that in each reel's \`reel\` field (style, uses, seconds).` : ''].filter(Boolean).join('\n');
};

/** Start Claude on this month, from here: no pasting. Nordle runs `claude` on this computer (it must be signed in: the Sign in to Claude button does that). */
async function askClaude(redraw) {
  const id = brandId();
  if (!id) return;
  if (!st.result) await suggest(() => {});
  try {
    await api.post(`/projects/${encodeURIComponent(id)}/calendar/run`, { action: 'propose', months: [st.result?.month ?? st.month ?? nextMonth()], extra: st.result?.ask ?? asked() });
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
  const signedOut = /not signed in/i.test(l.error ?? '');
  return h('div', { class: 'build-line', role: 'alert', 'data-state': 'failed' }, icon('alert', 14), h('span', { class: 'bad' }, signedOut ? 'Claude is not signed in on this computer. ' : (l.error ?? 'Claude did not add any ideas.')),
    signedOut ? claudeSignIn({ onReady: () => { st.job = { running: null, last: null }; notify('Signed in. Press Ask Claude now again.', { kind: 'ok' }); renderAgain?.(); } }) : null);
}

/** Videos that already exist on this computer: choose them (the system's file window), and each becomes a post to edit. They are not copied. */
async function chooseVideos(redraw) {
  vid.busy = true; vid.note = 'A file window is open on this computer. It may be behind this one.'; redraw();
  try {
    const r = await api.post('/import/pick-files', { title: 'Choose the videos to edit' });
    if (r.paths?.length) { for (const p of r.paths) if (!vid.paths.includes(p)) vid.paths.push(p); vid.note = ''; vid.done = null; }
    else vid.note = r.message || 'No videos chosen.';
  } catch (e) { vid.note = e.message; }
  vid.busy = false; redraw();
}
async function bringIn(redraw) {
  const id = brandId();
  if (!id || !vid.paths.length) return;
  vid.busy = true; vid.note = 'Looking at the videos…'; redraw();
  try {
    const r = await api.post('/import/videos', { project: id, paths: vid.paths, size: vid.size, mode: vid.mode });
    vid.done = r.posts; vid.paths = []; vid.note = '';
    await load({ force: true });
    notify(`${plural(r.posts.length, 'video post')} ready to edit.`, { kind: 'ok' });
  } catch (e) { vid.note = e.message; }
  vid.busy = false; redraw();
}

function videosCard(pr, redraw) {
  const addTyped = () => { const p = vid.typed.trim(); if (p && !vid.paths.includes(p)) { vid.paths.push(p); vid.typed = ''; vid.note = ''; redraw(); } };
  const typed = h('input', { class: 'field', placeholder: 'Or paste the full path of a video', 'data-field': 'create-video-path', 'aria-label': 'Path of a video' });
  typed.value = vid.typed;
  typed.addEventListener('input', () => { vid.typed = typed.value; });
  typed.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addTyped(); } });
  return h('section', { class: 'cr-card', 'aria-label': 'Edit videos you already have', 'data-section': 'videos' },
    h('h3', { class: 'lbl' }, 'Edit videos you already have'),
    h('p', { class: 'muted' }, 'The files stay where they are. Each one becomes a post with its picture and sound on the timeline: cut it, add titles and captions, and schedule it when you are ready.'),
    h('div', { class: 'cr-go' },
      h('button', { class: 'btn', type: 'button', 'data-act': 'create-pick-videos', disabled: vid.busy, onclick: () => chooseVideos(redraw) }, 'Choose videos…'),
      typed, h('button', { class: 'btn', type: 'button', 'data-act': 'create-add-video-path', onclick: addTyped }, 'Add')),
    vid.paths.length ? h('ul', { class: 'pick-list', 'data-field': 'create-videos', 'aria-label': 'Videos chosen' }, vid.paths.map((p) => h('li', {},
      h('span', { class: 'pick-path', title: p }, base(p)), h('span', { class: 'muted' }, p.slice(0, p.length - base(p).length)),
      h('button', { class: 'btn quiet', type: 'button', 'data-act': 'create-remove-video', 'aria-label': `Remove ${base(p)}`, onclick: () => { vid.paths = vid.paths.filter((x) => x !== p); redraw(); } }, 'Remove')))) : null,
    h('div', { class: 'cr-row' }, h('span', { class: 'lbl-i' }, 'Size'),
      h('div', { class: 'cr-chips', role: 'group', 'aria-label': 'Size of the post' }, VID_SIZES.map(([sid, label]) => chip(label, vid.size === sid, () => { vid.size = sid; redraw(); }, { 'data-vsize': sid })))),
    h('div', { class: 'cr-row' }, h('span', { class: 'lbl-i' }, 'Make'),
      h('div', { class: 'cr-chips', role: 'group', 'aria-label': 'One post or several' },
        chip('One post for each video', vid.mode === 'each', () => { vid.mode = 'each'; redraw(); }, { 'data-vmode': 'each' }),
        chip('Join them into one', vid.mode === 'together', () => { vid.mode = 'together'; redraw(); }, { 'data-vmode': 'together' }))),
    h('div', { class: 'cr-go' },
      h('button', { class: 'btn primary cr-big', type: 'button', 'data-act': 'create-import-videos', disabled: vid.busy || !vid.paths.length, onclick: () => bringIn(redraw) }, vid.busy ? 'Working…' : `Bring ${vid.paths.length === 1 ? 'it' : vid.paths.length ? 'them' : 'them'} into Nordle`),
      vid.note ? h('span', { class: vid.busy ? 'muted' : 'bad', role: 'status', 'data-state': 'video-note' }, vid.note) : null),
    vid.done ? h('ul', { class: 'cr-opts', 'data-state': 'videos-done' }, vid.done.map((p) => h('li', { class: 'cr-opt on' },
      h('span', { class: 'cr-opt-main' }, h('span', { class: 'cr-opt-body' },
        h('strong', { class: 'cr-title' }, p.title), h('span', { class: 'cr-idea' }, `${p.seconds} s · ${p.files.join(', ')}`),
        h('span', { class: 'cr-why muted' }, `On the calendar for ${dateFmt.weekday(p.date)} ${dateFmt.dm(p.date)}, waiting for you. Move or schedule it whenever you like.`),
        h('a', { class: 'btn go', href: `#/p/${encodeURIComponent(pr.id)}/${encodeURIComponent(p.docId)}`, 'data-act': 'open-video-editor' }, 'Open in the video editor')))))) : null);
}

async function addPicked(redraw, { approved }) {
  const id = brandId();
  const chosen = st.result.options.filter((o) => st.picked.has(o.id));
  if (!chosen.length) return;
  st.loading = true; redraw();
  try {
    const guidance = st.guide.trim().slice(0, 2000);
    const items = chosen.map(({ date, time, format, title, idea, hook, pillar, occasion, campaign }) => ({ date, ...(time ? { time } : {}), format, title, idea, hook, ...(format === 'reel' && st.reel ? { reel: st.reel } : {}), ...(guidance ? { guidance } : {}), ...(pillar ? { pillar } : {}), ...(occasion ? { occasion } : {}), ...(campaign ? { campaign } : {}), status: approved ? 'approved' : 'idea' }));
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

/** A campaign: a named push with a goal, dates, one message and one call to action. Posts are made for it first and scheduled later. */
async function saveCampaign(pr, redraw) {
  const f = st.newCamp;
  if (!f.name.trim()) { st.error = 'Give the campaign a name.'; return redraw(); }
  try {
    const r = await api.post(`/projects/${encodeURIComponent(pr.id)}/calendar/campaigns`, { name: f.name, goal: f.goal, start: f.start || null, end: f.end || null, message: f.message, cta: f.cta });
    await load({ force: true });
    st.campaign = r.campaign.id; st.newCamp = null; st.result = null; st.error = '';
  } catch (e) { st.error = e.message; }
  redraw();
}

function campaignForm(pr, redraw) {
  const f = st.newCamp;
  const field = (key, label, ph, { type = 'text', rows } = {}) => {
    const el = rows ? h('textarea', { class: 'field', rows, placeholder: ph, 'data-field': `camp-${key}`, 'aria-label': label }) : h('input', { class: 'field', type, placeholder: ph, 'data-field': `camp-${key}`, 'aria-label': label });
    el.value = f[key] ?? '';
    el.addEventListener('input', () => { f[key] = el.value; });
    return h('label', { class: 'bg-f' }, h('span', { class: 'lbl-i' }, label), el);
  };
  return h('section', { class: 'cr-card', 'aria-label': 'A new campaign', 'data-section': 'new-campaign' },
    h('h3', { class: 'lbl' }, 'A new campaign'),
    h('div', { class: 'bg-grid' }, field('name', 'Name', 'e.g. Spring open day'), field('cta', 'What it asks people to do', 'e.g. Book a place')),
    field('goal', 'What it is for', 'e.g. Fill the open day and introduce the new team', { rows: 2 }),
    h('div', { class: 'bg-grid' }, field('start', 'Starts', '', { type: 'date' }), field('end', 'Ends', '', { type: 'date' })),
    field('message', 'The one thing it says', 'e.g. Come and see how we work', { rows: 2 }),
    h('div', { class: 'cr-go' },
      h('button', { class: 'btn primary', type: 'button', 'data-act': 'camp-save', onclick: () => saveCampaign(pr, redraw) }, 'Make the campaign'),
      h('button', { class: 'btn quiet', type: 'button', 'data-act': 'camp-cancel', onclick: () => { st.newCamp = null; redraw(); } }, 'Cancel')));
}

function campaignRow(pr, redraw) {
  const camps = pr.campaigns ?? [];
  const posts = (c) => S.posts.filter((p) => p.project === pr.id && p.campaign === c.id);
  const cur = camps.find((c) => c.id === st.campaign);
  return h('div', { class: 'cr-row' }, h('span', { class: 'lbl-i' }, 'Campaign'),
    h('div', { class: 'cr-chips', role: 'group', 'aria-label': 'Campaign' },
      chip('No campaign', !st.campaign, () => { st.campaign = null; st.result = null; redraw(); }, { 'data-act': 'camp-none' }),
      camps.map((c) => chip(c.name, st.campaign === c.id, () => { st.campaign = c.id; st.result = null; redraw(); }, { 'data-campaign': c.id })),
      chip('+ New campaign', !!st.newCamp, () => { st.newCamp = st.newCamp ?? { name: '', goal: '', start: '', end: '', message: '', cta: '' }; redraw(); }, { 'data-act': 'camp-new' })),
    cur ? h('p', { class: 'muted cr-camp-note' }, [cur.goal, cur.start || cur.end ? `${cur.start ? dateFmt.dm(cur.start) : 'now'} to ${cur.end ? dateFmt.dm(cur.end) : 'open'}` : null, `${plural(posts(cur).length, 'post')} so far`].filter(Boolean).join(' · '), ' ', h('a', { href: `#/s/list?brand=${encodeURIComponent(pr.id)}&q=${encodeURIComponent(cur.name)}` }, 'See its posts')) : null);
}

function controls(pr, redraw) {
  const months = [0, 1, 2].map((i) => addMonths(monthOf(S.today), i + 1));
  const month = st.month ?? months[0];
  const learned = st.result?.learned;
  return h('section', { class: 'cr-card', 'aria-label': 'Choose what to make' },
    h('h3', { class: 'lbl' }, 'Or choose, and Nordle suggests'),
    campaignRow(pr, redraw),
    st.campaign ? null : h('div', { class: 'cr-row' }, h('span', { class: 'lbl-i' }, 'For'),
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
    st.formats.size === 0 || st.formats.has('reel') ? h('div', { class: 'cr-reel', 'data-state': 'reel-options' }, h('h4', { class: 'lbl' }, 'Reels'), reelOptions({ value: st.reel, onChange: (r) => { st.reel = r; } })) : null,
    st.campaign ? null : h('div', { class: 'cr-row' }, h('span', { class: 'lbl-i' }, 'Style'),
      h('div', { class: 'cr-chips', role: 'group', 'aria-label': 'Style of post' },
        chip('Any style', st.styles.size === 0, () => { st.styles = new Set(); redraw(); }, { 'data-act': 'create-any-style' }),
        (st.result?.styles ?? STYLES_FALLBACK).map((s) => chip(s.label, st.styles.has(s.id), () => { if (st.styles.has(s.id)) st.styles.delete(s.id); else st.styles.add(s.id); redraw(); }, { 'data-style': s.id, title: s.hint })))),
    h('label', { class: 'cr-learn' },
      h('input', { type: 'checkbox', checked: st.learn, 'data-field': 'create-learn', onchange: (e) => { st.learn = e.target.checked; redraw(); } }),
      h('span', {}, h('b', {}, 'Learn from my results'), h('span', { class: 'muted' }, learned?.connected
        ? ` Your results are connected (${plural(learned.posts, 'post')} measured). ${st.result.learnedLine ?? 'No clear winner yet, so the mix stays balanced.'}`
        : ' Connect your results in Insights and Nordle will lean toward the formats and themes that did best. Until then it uses your brand, its facts and the calendar.'))),
    h('div', { class: 'cr-go' },
      h('button', { class: 'btn primary cr-big', type: 'button', 'data-act': 'create-suggest', disabled: st.loading, onclick: () => suggest(redraw) }, st.loading ? 'Working…' : (st.result ? 'Show me new options' : 'Show me options'))));
}

const STYLES_FALLBACK = [
  { id: 'team', label: 'Meet the team', hint: 'The people behind the brand' }, { id: 'educate', label: 'Explain something', hint: 'What it is, what to expect' },
  { id: 'faq', label: 'Answer a question', hint: 'One real question, answered' }, { id: 'behind', label: 'Behind the scenes', hint: 'How things are really done' },
  { id: 'seasonal', label: 'Seasons and occasions', hint: 'Dates worth a post' }, { id: 'community', label: 'Community and local', hint: 'Your area and what you support' },
  { id: 'invite', label: 'A gentle invitation', hint: 'A soft call to book, call or visit' },
];

let renderAgain = null;
export function renderCreate(root, ctx) {
  // timers and finished requests call this later: if the person has gone to another page by then, it must not paint Create back over it
  const redraw = () => { if (S.view === 'create') keepTyping(root, () => renderCreate(root, ctx)); };
  renderAgain = redraw;
  const id = brandId();
  const pr = id && project(id);
  if (!pr) return root.replaceChildren(emptyState({ title: 'No brands yet', body: 'Add a brand first, then you can make posts for it here.' }));
  const r = st.result;
  const picked = r ? r.options.filter((o) => st.picked.has(o.id)) : [];
  const ask = h('section', { class: 'cr-card', 'aria-label': 'Ask Claude' },
    h('h3', { class: 'lbl' }, 'Tell Claude what you want'),
    (() => { const t = h('textarea', { class: 'field cr-prompt', rows: 3, 'data-field': 'create-prompt', placeholder: 'e.g. Three reels about meeting the team, and a carousel on what to expect at a first visit. Keep it light.' }); t.value = st.prompt; t.addEventListener('input', () => { st.prompt = t.value; }); return t; })(),
    (() => { const t = h('textarea', { class: 'field cr-prompt', rows: 2, maxlength: 2000, 'data-field': 'create-guide', 'aria-label': 'Extra information for these posts', placeholder: 'Extra info to guide the reels and posts (optional): who to feature, what to stress, what to avoid, a look to follow.' }); t.value = st.guide; t.addEventListener('input', () => { st.guide = t.value; }); return t; })(),
    h('div', { class: 'cr-go' },
      h('button', { class: 'btn primary', type: 'button', 'data-act': 'create-run', disabled: !!st.job?.running, onclick: () => askClaude(redraw) }, 'Ask Claude now'),
      h('button', { class: 'btn', type: 'button', 'data-act': 'create-ask', onclick: () => { if (r) return copyRequest(r.request); suggest(redraw).then(() => st.result && copyRequest(st.result.request)); } }, icon('clipboard', 14), 'Copy for Claude Code instead'),
      h('span', { class: 'muted' }, 'Nordle starts Claude on this computer and the ideas land in your Plan. If Claude is not signed in yet, Nordle shows a Sign in button. Or pick from the options below.')),
    jobPanel());

  const results = r ? h('section', { class: 'cr-card cr-results', 'aria-label': 'Options', 'data-state': 'options' },
    h('header', { class: 'cr-rh' },
      h('h3', { class: 'lbl' }, `${plural(r.options.length, 'option')} for ${r.monthLabel}`),
      r.options.length ? h('span', { class: 'cr-sel' }, h('button', { class: 'linklike', type: 'button', 'data-act': 'create-all', onclick: () => { st.picked = new Set(r.options.map((o) => o.id)); redraw(); } }, 'Tick all'), ' · ', h('button', { class: 'linklike', type: 'button', 'data-act': 'create-none', onclick: () => { st.picked = new Set(); redraw(); } }, 'Tick none')) : null),
    r.short ? h('p', { class: 'cr-note', role: 'note' }, r.short) : null,
    r.options.length ? h('ul', { class: 'cr-opts' }, r.options.map((o) => optionCard(o, redraw))) : h('p', { class: 'muted' }, st.added ? 'Those are all on the calendar. Choose again for more.' : 'Nothing to suggest with those choices. Try another style or kind.'),
    h('footer', { class: 'cr-foot' },
      h('span', { class: 'cr-count' }, `${picked.length} ticked`),
      h('button', { class: `btn${st.campaign ? '' : ' go'}`, type: 'button', 'data-act': 'create-add', disabled: !picked.length || st.loading, onclick: () => addPicked(redraw, { approved: true }), title: 'They go on the calendar approved: Claude builds each one as its date gets close' }, `Add ${picked.length || ''} to the calendar`.replace('  ', ' ')),
      h('button', { class: `btn${st.campaign ? ' go' : ''}`, type: 'button', 'data-act': 'create-add-ideas', disabled: !picked.length || st.loading, onclick: () => addPicked(redraw, { approved: false }), title: 'They wait in the Plan as ideas. Nothing is scheduled: schedule them later, when you are ready' }, st.campaign ? 'Add as ideas, schedule later' : 'Add as ideas to look at'),
      h('button', { class: 'btn quiet', type: 'button', 'data-act': 'create-copy', onclick: () => copyRequest(r.request) }, icon('clipboard', 14), 'Ask Claude to improve these')),
    st.added ? h('p', { class: 'cr-added', role: 'status' }, `${plural(st.added.done, 'post')} ${st.added.approved ? 'added and approved' : 'added as ideas'}. `, st.added.note, ' ', h('a', { href: '#/s/plan' }, 'Open the plan')) : null) : null;

  // an address can ask for a mode (…/create?mode=advanced), for links and tests; it is remembered like a click
  const asked = /[?&]mode=(simple|advanced)\b/.exec(location.hash)?.[1];
  if (asked && asked !== mode) { mode = asked; try { localStorage.setItem(MODE_KEY, mode); } catch { /* fine */ } }
  const modes = h('div', { class: 'cr-mode', role: 'group', 'aria-label': 'Simple or advanced' },
    chip('Simple', mode === 'simple', () => setMode('simple', redraw), { 'data-mode': 'simple', title: 'Three steps: say what you want, pick from the board, Claude makes them' }),
    chip('Advanced', mode === 'advanced', () => setMode('advanced', redraw), { 'data-mode': 'advanced', title: 'Every control: campaigns, months, styles, reel options, learning from results, your own videos' }));
  const brandRow = S.projects.length > 1 ? h('div', { class: 'cr-row cr-brands', 'data-state': 'brand-pick' }, h('span', { class: 'lbl-i' }, 'Brand'),
    h('div', { class: 'cr-chips', role: 'group', 'aria-label': 'Which brand the posts are for' }, S.projects.map((p) => chip(p.name, p.id === pr.id, () => chooseBrand(p.id, redraw), { 'data-brand': p.id })))) : null;
  if (mode === 'simple') {
    root.replaceChildren(h('div', { class: 'create simple', 'data-state': 'create-simple' },
      h('header', { class: 'cr-head' }, h('div', { class: 'cr-head-top' }, h('h2', {}, `Make posts for ${pr.name}`), modes), brandRow),
      ...simpleView(pr, redraw),
      h('p', { class: 'muted sp-more' }, 'Campaigns, choosing the month, reel options, learning from your results and editing videos you already have are in ', h('button', { class: 'linklike', type: 'button', 'data-act': 'to-advanced', onclick: () => setMode('advanced', redraw) }, 'Advanced'), '.')));
    return;
  }
  if (!st.job) { st.job = { running: null, last: null }; checkJob(redraw); }
  root.replaceChildren(h('div', { class: 'create' },
    h('header', { class: 'cr-head' },
      h('div', { class: 'cr-head-top' }, h('h2', {}, `For ${pr.name}`), modes),
      brandRow,
      h('p', { class: 'muted' }, 'Start with a few words, or let Nordle suggest posts for the next month. You choose what goes on the calendar; nothing is posted.')),
    ask, st.newCamp ? campaignForm(pr, redraw) : null, controls(pr, redraw), videosCard(pr, redraw), st.error ? h('p', { class: 'cr-err', role: 'alert' }, st.error) : null, results));
}
