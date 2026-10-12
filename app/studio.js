// The Studio: Nordle's front door. Owns the page frame (rail, masthead, filters, views, detail sheet), the URL, the keyboard and
// the refresh. The views themselves live in studio-month / wall / list / queue / plan; the post's page in studio-detail.

import { openClaudeAccount } from './studio-claude.js';
import { h, icon, dialog } from './dom.js';
import {
  S, VIEWS, STATUS_GROUPS, addMonths, brandCounts, buildQueue, dateFmt, figures, inBrand, load, matches, months, monthOf, patchPost, project, subscribe, update, visible,
} from './studio-store.js';
import {
  claudeSignIn, cycleThemeGlobal, elapsed, emptyState, hideTip, kbd, notify, skeleton, themeMode,
} from './studio-ui.js';
import { releaseViewer, activeViewer, mediaViewer } from './studio-media.js';
import { renderMonth, isPhone, monthSpan, scrollToMonth, scrollAgenda } from './studio-month.js';
import { renderWall, resetWall, revealAll } from './studio-wall.js';
import { renderList, sorted, resetList } from './studio-list.js';
import { renderPlan } from './studio-plan.js';
import { renderCreate } from './studio-create.js';
import { renderInsights } from './insights.js';
import { renderTrash } from './studio-trash.js';
import * as Q from './studio-queue.js';
import * as D from './studio-detail.js';
import { commentsPanel } from './studio-comments.js';
import { loadPublish, openConnect, openSchedule, pub, refreshAuto } from './studio-publish.js';
import { openAddBrand, openGuide } from './studio-brand.js';
import { openStock } from './studio-stock.js';
import * as act from './studio-actions.js';
import { api } from './api.js';

const VIEW_META = {
  month: { label: 'Month', icon: 'month', key: 'm' },
  wall: { label: 'Wall', icon: 'wall', key: 'w' },
  queue: { label: 'Review', icon: 'queue', key: 'q' },
  list: { label: 'List', icon: 'list', key: 'l' },
  create: { label: 'Create', icon: 'plus', key: 'n' },
  plan: { label: 'Plan', icon: 'plan', key: 'p' },
  insights: { label: 'Insights', icon: 'insights', key: 'i' },
  trash: { label: 'Trash', icon: 'trash', key: 't' },
};
const NAV_ORDER = ['create', 'month', 'wall', 'queue', 'list', 'plan', 'insights'];

let root = null;
let active = false;
const el = {};
const sigs = {};
const ids = new WeakMap();
let idn = 0;
const idOf = (o) => ids.get(o) ?? (ids.set(o, ++idn), idn);
let detailToken = 0;
let lastView = null;
let writing = false;
let gPending = 0;
let pollTimer = 0;
let filtersOpen = false;

// ---- the address bar ---------------------------------------------------------------------------------------------------------------

function hashFor(over = {}) {
  const s = { view: S.view, brand: S.brand, month: S.month, post: S.open ? S.sel : S.view === 'queue' ? S.queue.uid : '', f: S.f, ...over };
  const q = new URLSearchParams();
  if (s.brand && s.brand !== 'all') q.set('brand', s.brand);
  if (s.view === 'month' && s.month && s.month !== monthOf(S.today || s.month)) q.set('month', s.month);
  if (s.post) q.set('post', s.post);
  if (s.view === 'insights' && S.insights) q.set('ip', S.insights);
  const f = s.f;
  if (f.format) q.set('fmt', f.format);
  if (f.status) q.set('st', f.status);
  if (f.month) q.set('mo', f.month);
  if (f.q) q.set('q', f.q);
  if (f.needs) q.set('needs', '1');
  if (f.failing) q.set('fail', '1');
  if (f.when) q.set('when', f.when);
  if (S.todayOverride) q.set('today', S.todayOverride);
  return `#/s/${s.view}${q.size ? `?${q}` : ''}`;
}

function writeUrl(push = false) {
  const url = hashFor();
  if (url === location.hash) return;
  writing = true;
  try { history[push ? 'pushState' : 'replaceState'](null, '', url); } finally { writing = false; }
}

function applyHash(hash) {
  const m = /^#\/s\/(month|wall|list|queue|plan|create|insights|trash)(?:\?(.*))?$/.exec(hash);
  const q = new URLSearchParams(m?.[2] ?? '');
  if (q.get('today')) S.todayOverride = q.get('today');
  if (m?.[1] === 'insights') S.insights = q.get('ip') || S.insights;
  if (!m) return; // plain "#/": keep whatever the Studio was showing
  const post = q.get('post') || null;
  update({
    view: m[1],
    brand: q.get('brand') || 'all',
    month: q.get('month') || (S.today ? S.today.slice(0, 7) : S.month),
    f: { format: q.get('fmt') || '', status: q.get('st') || '', month: q.get('mo') || '', q: q.get('q') || '', needs: q.get('needs') === '1', failing: q.get('fail') === '1', when: q.get('when') || '' },
    sel: post ?? S.sel,
    open: !!post && m[1] !== 'queue',
    queue: m[1] === 'queue' && post ? { ...S.queue, uid: post } : S.queue,
  });
}

// ---- state changes ------------------------------------------------------------------------------------------------------------------

function setView(view, { push = true } = {}) {
  if (!VIEWS.includes(view)) return;
  if (view === S.view) return;
  releaseViewer();
  const patch = { view, open: false };
  if (view === 'queue') { Object.assign(patch, {}); update(patch); buildQueue(S.sel && S.byUid.get(S.sel)?.needsReview ? S.sel : undefined); } else update(patch);
  if (view === 'wall') resetWall();
  if (view === 'list') resetList();
  writeUrl(push);
}

function setBrand(brand) {
  if (brand === S.brand) return;
  update({ brand, sel: null, open: false, picked: new Set(), queue: { ...S.queue, list: [], uid: null } });
  if (S.view === 'queue') buildQueue();
  writeUrl(true);
}

function setFilter(patch) {
  update({ f: { ...S.f, ...patch }, picked: new Set() });
  if (S.view === 'queue') buildQueue();
  resetWall();
  writeUrl(false);
}
const clearFilters = () => setFilter({ format: '', status: '', month: '', q: '', needs: false, failing: false, when: '' });

/** Go to a month: the calendar is one long page, so this scrolls (this month: to the week with today in it). */
function setMonth(ym) {
  const span = monthSpan();
  ym = ym < span[0] ? span[0] : ym > span.at(-1) ? span.at(-1) : ym;
  update({ month: ym });
  writeUrl(false);
  const today = ym === monthOf(S.today);
  if (isPhone()) scrollAgenda(el.view, ym, { today }); else scrollToMonth(el.view, ym, { today });
}

/** The scroll reached a new month: the title follows, and so does the address (after a pause). */
let seenTimer = 0;
function monthSeen(ym) {
  update({ month: ym });
  clearTimeout(seenTimer);
  seenTimer = setTimeout(() => writeUrl(false), 400);
}

function selectMonth(ym) {
  const uids = S.posts.filter((p) => matches(p) && p.date?.startsWith(ym)).map((p) => p.uid);
  update({ picked: new Set(uids) });
  if (!uids.length) notify('Nothing in that month to select.', { kind: 'info' });
}

function select(uid, { open = S.open, scroll = true } = {}) {
  update({ sel: uid, open: S.view === 'queue' ? false : open });
  writeUrl(false);
  if (scroll) queueMicrotask(() => markSelection(true));
}

function togglePick(uid, on) {
  const picked = new Set(S.picked);
  if (on) picked.add(uid); else picked.delete(uid);
  update({ picked });
}
function pickMany(uids, on) {
  const picked = new Set(S.picked);
  for (const u of uids) { if (on) picked.add(u); else picked.delete(u); }
  update({ picked });
}

/** Remove posts (after asking). In the review queue, move on to the next one that is still waiting. */
async function removePostsHere(posts) {
  const inQueue = S.view === 'queue';
  const gone = new Set(posts.map((p) => p.uid));
  const rest = S.queue.list.filter((u) => !gone.has(u));
  const at = S.queue.list.indexOf(S.queue.uid);
  const ok = await act.removePosts(posts);
  if (!ok) return false;
  if (inQueue) {
    const list = rest.filter((u) => S.byUid.has(u));
    const uid = list.slice(Math.max(0, at)).find((u) => !S.queue.decided.has(u)) ?? list.find((u) => !S.queue.decided.has(u)) ?? null;
    update({ queue: { ...S.queue, list, uid } });
  }
  update({ sel: null });
  writeUrl(false);
  return true;
}

const ctx = {
  open: (uid) => select(uid, { open: true }),
  pick: togglePick,
  pickMany,
  clearFilters,
  monthSeen,
  selectMonth,
  setFilter,
  setBrand,
  setView,
  remove: removePostsHere,
  moveDate: (uid, date) => { const p = S.byUid.get(uid); return p ? act.moveDate(p, date) : false; },
  rerender: () => { sigs.view = ''; sigs.detail = ''; update(); },
  sync: () => { writeUrl(false); update(); },
  openMonth: (ym) => { update({ view: 'month', month: ym, open: false }); writeUrl(true); },
};

// ---- the frame ------------------------------------------------------------------------------------------------------------------------

function build() {
  el.rail = h('aside', { class: 'rail', 'aria-label': 'Studio' });
  el.mast = h('header', { class: 'mast' });
  el.filters = h('div', { class: 'filters', role: 'search' });
  el.view = h('main', { class: 'view', id: 'studio-view', tabindex: '-1' });
  el.selbar = h('div', { class: 'selbar hidden', role: 'region', 'aria-label': 'Selected posts' });
  el.banner = h('div', { class: 'offline hidden', role: 'status' });
  el.working = h('div', { class: 'working hidden', role: 'status', 'data-state': 'working' });
  el.update = h('div', { class: 'update hidden', role: 'status', 'data-state': 'update' });
  el.claude = h('div', { class: 'update claude-bar hidden', role: 'status', 'data-state': 'claude' });
  el.main = h('div', { class: 's-main' }, el.banner, el.claude, el.update, el.working, el.mast, el.filters, el.view, el.selbar);
  el.scrim = h('div', { class: 'scrim', onclick: closeDetail });
  el.detail = h('aside', { class: 'detail', 'aria-label': 'Post', 'aria-hidden': 'true' });
  el.tabbar = h('nav', { class: 'tabbar', 'aria-label': 'Views' });
  el.studio = h('div', { class: 'studio' }, h('a', { class: 'skip', href: '#studio-view', onclick: (e) => { e.preventDefault(); el.view.focus(); } }, 'Skip to the posts'), el.rail, el.main, el.scrim, el.detail, el.tabbar);
  root.replaceChildren(el.studio);
}

function cached(name, sig, fn) {
  if (sigs[name] === sig) return false;
  sigs[name] = sig;
  fn();
  return true;
}

function renderRail() {
  const bc = brandCounts();
  const fig = figures();
  const needsAll = S.posts.filter((p) => p.needsReview).length;
  el.rail.replaceChildren(
    h('a', { class: 'wordmark', href: '#/s/month', onclick: (e) => { e.preventDefault(); setView('month'); }, 'aria-label': 'Nordle Studio' }, 'Nordle', h('i', { 'aria-hidden': 'true' }, '.')),
    h('nav', { class: 'rail-nav', 'aria-label': 'Views' }, NAV_ORDER.map((v) => {
      const m = VIEW_META[v];
      return h('a', { class: `rn${S.view === v ? ' on' : ''}`, href: hashFor({ view: v, post: '' }), 'aria-current': S.view === v ? 'page' : null, onclick: (e) => { e.preventDefault(); setView(v); } },
        icon(m.icon, 16), h('span', { class: 'rn-l' }, m.label), v === 'queue' && fig.needs ? h('span', { class: 'rn-n' }, String(fig.needs)) : null, h('span', { class: 'rn-k' }, 'g ', m.key));
    })),
    h('div', { class: 'rail-sec' },
      h('div', { class: 'rail-sec-h' }, h('h2', { class: 'lbl' }, 'Brands'),
        h('button', { class: 'rail-add', type: 'button', 'data-act': 'add-brand', title: 'Add a brand', 'aria-label': 'Add a brand', onclick: () => openAddBrand({ onCreated: (id) => setBrand(id), openPublishing: () => openConnect('buffer') }) }, icon('plus', 14), h('span', {}, 'Add'))),
      h('button', { class: `rb${S.brand === 'all' ? ' on' : ''}`, type: 'button', 'aria-pressed': String(S.brand === 'all'), onclick: () => setBrand('all') },
        h('span', { class: 'rb-ticks', 'aria-hidden': 'true' }, S.projects.map((p) => h('i', { style: { '--lane': p.color } }))), h('span', { class: 'rb-n' }, 'All brands'), needsAll ? h('span', { class: 'rb-c', title: 'Waiting for your review' }, String(needsAll)) : null),
      S.projects.map((p, i) => h('div', { class: 'rb-row' },
        h('button', { class: `rb${S.brand === p.id ? ' on' : ''}`, type: 'button', 'aria-pressed': String(S.brand === p.id), onclick: () => setBrand(p.id), title: `${p.name} (${i + 2})` },
          h('i', { class: 'tick', style: { '--lane': p.color }, 'aria-hidden': 'true' }), h('span', { class: 'rb-n' }, p.name), bc[p.id]?.needs ? h('span', { class: 'rb-c', title: 'Waiting for your review' }, String(bc[p.id].needs)) : null),
        h('button', { class: 'rb-menu', type: 'button', 'aria-label': `More for ${p.name}`, 'aria-haspopup': 'menu', onclick: (e) => openBrandMenu(e.currentTarget, p) }, icon('dots', 15))))),
    h('div', { class: 'rail-foot' },
      h('button', { class: 'rf', type: 'button', onclick: cycleTheme, title: 'Colour theme: follows the computer, or fixed light or dark' }, icon(themeMode() === 'dark' ? 'moon' : themeMode() === 'light' ? 'sun' : 'system', 15), h('span', {}, `Theme: ${themeMode()}`)),
      h('button', { class: 'rf', type: 'button', onclick: showKeys }, icon('keys', 15), h('span', {}, 'Shortcuts'), kbd('?')),
      h('a', { class: `rf${S.view === 'trash' ? ' on' : ''}`, href: hashFor({ view: 'trash', post: '' }), onclick: (e) => { e.preventDefault(); setView('trash'); } }, icon('trash', 15), h('span', {}, 'Trash'), S.trashCount ? h('span', { class: 'rf-n' }, String(S.trashCount)) : null),
      h('button', { class: 'rf', type: 'button', onclick: () => openConnect('buffer'), title: hostingNote() || 'Publishing: platforms, accounts and where your pictures and video are hosted' }, icon('calendarSend', 15), h('span', {}, 'Publishing'),
        hostingNote() ? h('span', { class: 'rf-n rf-ok', 'data-state': 'hosting-ready', title: hostingNote() }, 'Hosting on') : null),
      h('button', { class: 'rf', type: 'button', 'data-act': 'open-stock', onclick: () => openStock({ project: S.brand !== 'all' ? S.brand : '' }), title: 'Stock libraries: add a library and its key, and search photos, video, music and sound effects' }, icon('film', 15), h('span', {}, 'Stock')),
      h('button', { class: 'rf', type: 'button', 'data-act': 'open-claude-account', onclick: openClaudeAccount, title: 'The Claude account Nordle uses: see who it is, sign out, or switch to another' }, icon('sparkle', 15), h('span', {}, 'Claude account')),
      h('a', { class: 'rf', href: '#/projects' }, icon('home', 15), h('span', {}, 'Library')),
      h('a', { class: 'rf rf-credit', href: 'https://github.com/samuel-d-young/nordle-socials-creator', target: '_blank', rel: 'noopener', title: 'Nordle was created by Samuel Young and is free to use under CC BY 4.0. Credit him if you share it or build on it.' }, h('span', {}, 'Nordle by Samuel Young'))));
}

/** "Media hosting is set up: Cloudflare R2, bucket nordle-posts" once a hosting bucket is saved, else ''. The rail shows it so it is never a surprise. */
function hostingNote() {
  const hv = pub.adapters.find((a) => a.id === 'buffer')?.hosting;
  if (!hv?.configured) return '';
  let host = '';
  try { host = new URL(hv.endpoint).host; } catch { /* leave blank */ }
  const name = /r2\.cloudflarestorage\.com$/.test(host) ? 'Cloudflare R2' : /amazonaws\.com$/.test(host) ? 'Amazon S3' : /backblazeb2\.com$/.test(host) ? 'Backblaze B2' : host || 'a storage bucket';
  return `Media hosting is set up: ${name}, bucket ${hv.bucket}`;
}

/** The small menu beside a brand in the rail. */
function openBrandMenu(button, p) {
  document.querySelector('.popmenu')?.remove();
  const r = button.getBoundingClientRect();
  const menu = h('div', { class: 'popmenu', role: 'menu', style: { left: `${Math.round(r.left)}px`, top: `${Math.round(r.bottom + 4)}px` } },
    h('button', { role: 'menuitem', type: 'button', 'data-act': 'brand-guide', onclick: () => { menu.remove(); openGuide(p.id, { brandName: p.name }); } }, icon('eyeView', 14), 'Style guide…'),
    h('button', { role: 'menuitem', type: 'button', onclick: () => { menu.remove(); act.removeBrand(p); } }, icon('trash', 14), 'Remove brand…'));
  button.setAttribute('aria-expanded', 'true');
  const close = () => { menu.remove(); button.setAttribute('aria-expanded', 'false'); document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', esc, true); };
  const away = (e) => { if (!menu.contains(e.target)) close(); };
  const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); button.focus(); } };
  document.addEventListener('pointerdown', away, true);
  document.addEventListener('keydown', esc, true);
  document.body.append(menu);
  menu.querySelector('button').focus();
}

function cycleTheme() {
  cycleThemeGlobal();
  sigs.rail = '';
  update();
}

const VIEW_TITLE = { wall: 'The wall', list: 'Every post', queue: 'Review', plan: 'The plan', create: 'Make posts', insights: 'Insights', trash: 'The trash' };
function renderMast() {
  const fig = figures();
  const phone = isPhone();
  const title = S.view === 'month'
    ? h('h1', { class: 'mast-h' }, dateFmt.monthName(S.month), h('span', { class: 'mast-y' }, S.month.slice(0, 4)))
    : h('h1', { class: 'mast-h' }, VIEW_TITLE[S.view]);
  const figs = [
    { k: 'needs', n: fig.needs, label: fig.needs ? 'Need your review' : 'Nothing to review', cta: S.view !== 'queue' && fig.needs > 0, go: () => { if (fig.needs) setView('queue'); } },
    { k: 'built', n: fig.builtToday, label: 'Built today', go: () => { update({ f: { ...S.f, when: 'built-today' } }); setView('list'); writeUrl(false); } },
    { k: 'fail', n: fig.failing, label: 'Checks failing', tone: fig.failing ? 'pencil' : '', go: () => { update({ f: { ...S.f, failing: true } }); setView('wall'); writeUrl(false); } },
    { k: 'next', n: fig.next7, label: 'Next 7 days', go: () => { update({ f: { ...S.f, when: 'next7' } }); setView('list'); writeUrl(false); } },
  ];
  el.mast.replaceChildren(
    h('div', { class: 'mast-top' },
      h('div', { class: 'mast-title' }, phone ? null : h('p', { class: 'mast-date' }, S.today ? dateFmt.long(S.today) : ''), h('div', { class: 'mast-row' }, title,
      S.view === 'month' ? h('div', { class: 'mast-nav', role: 'group', 'aria-label': 'Month' },
        h('button', { class: 'btn quiet icon', type: 'button', onclick: () => setMonth(addMonths(S.month, -1)), 'aria-label': 'Previous month', title: 'Previous month ([)' }, icon('chevL', 16)),
        h('button', { class: 'btn quiet', type: 'button', onclick: () => setMonth(monthOf(S.today)), title: 'Back to this month (T)' }, 'Today'),
        h('button', { class: 'btn quiet icon', type: 'button', onclick: () => setMonth(addMonths(S.month, 1)), 'aria-label': 'Next month', title: 'Next month (])' }, icon('chevR', 16))) : null)),
      h('ul', { class: 'figs' }, figs.map((f) => h('li', {}, h('button', { class: `fig${f.tone ? ` ${f.tone}` : ''}${f.n ? '' : ' zero'}${f.cta ? ' cta' : ''}`, type: 'button', onclick: f.go, title: f.cta ? 'Step through the posts waiting for you (Q)' : 'Show these' },
        h('span', { class: 'fig-n' }, String(f.n)), h('span', { class: 'fig-l' }, f.label), f.cta ? h('span', { class: 'fig-go' }, 'Start reviewing', icon('chevR', 13)) : null))))));
}

function renderFilters() {
  const shown = S.view !== 'plan' && S.view !== 'create' && S.view !== 'insights' && S.view !== 'trash';
  el.filters.classList.toggle('hidden', !shown);
  if (!shown) return;
  const fq = h('input', { class: 'f-q', type: 'search', placeholder: 'Search posts', 'aria-label': 'Search posts', value: S.f.q, 'data-field': 'f-q', autocomplete: 'off', spellcheck: 'false' });
  let t = 0;
  fq.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => setFilter({ q: fq.value.trim() }), 160); });
  fq.addEventListener('keydown', (e) => { if (e.key === 'Escape') { fq.value = ''; setFilter({ q: '' }); fq.blur(); } });
  const sel = (label, value, opts, on) => {
    const s = h('select', { class: 'f-sel', 'aria-label': label, onchange: (e) => on(e.target.value) }, opts.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
    return s;
  };
  const count = S.view === 'queue' ? Q.currentPost() && S.queue.list.length : visible().length;
  const total = S.posts.filter(inBrand).length;
  const anyFilter = Object.values(S.f).some(Boolean);
  const eligible = visible().filter(act.eligibleForBulk);
  const needsN = S.posts.filter((p) => inBrand(p) && p.needsReview).length;
  const failN = S.posts.filter((p) => inBrand(p) && p.failing && p.status !== 'rejected').length;
  const when = { next7: 'Next 7 days', 'built-today': 'Built today' }[S.f.when];
  el.filters.replaceChildren(...[
    h('label', { class: 'f-search' }, icon('search', 15), fq, h('span', { class: 'f-slash', 'aria-hidden': 'true' }, '/')),
    h('button', { class: 'btn quiet f-toggle', type: 'button', 'aria-expanded': String(filtersOpen), onclick: () => { filtersOpen = !filtersOpen; sigs.filters = ''; update(); } }, icon('filter', 14), 'Filters', anyFilter ? h('span', { class: 'f-dot' }) : null),
    h('div', { class: `f-rest${filtersOpen ? ' open' : ''}` },
      sel('Brand', S.brand, [['all', 'All brands'], ...S.projects.map((p) => [p.id, p.name])], (v) => setBrand(v)),
      h('div', { class: 'f-seg', role: 'radiogroup', 'aria-label': 'Format' }, [['', 'All'], ['reel', 'Reels'], ['carousel', 'Carousels'], ['post', 'Posts'], ['story', 'Stories']].map(([v, l]) =>
        h('button', { class: S.f.format === v ? 'on' : '', type: 'button', role: 'radio', 'aria-checked': String(S.f.format === v), onclick: () => setFilter({ format: v }) }, l))),
      S.view === 'queue' ? null : sel('Status', S.f.status, Object.entries(STATUS_GROUPS), (v) => setFilter({ status: v })),
      S.view === 'month' || S.view === 'queue' ? null : sel('Month', S.f.month, [['', 'Any month'], ...months().map((m) => [m, `${dateFmt.monthName(m)} ${m.slice(0, 4)}`])], (v) => setFilter({ month: v })),
      S.view === 'queue' ? null : h('button', { class: `f-chip${S.f.needs ? ' on' : ''}`, type: 'button', 'aria-pressed': String(S.f.needs), onclick: () => setFilter({ needs: !S.f.needs }) }, 'Needs my review', h('b', {}, String(needsN))),
      h('button', { class: `f-chip${S.f.failing ? ' on' : ''}`, type: 'button', 'aria-pressed': String(S.f.failing), onclick: () => setFilter({ failing: !S.f.failing }) }, 'Checks failing', h('b', {}, String(failN))),
      when ? h('button', { class: 'f-chip on', type: 'button', 'aria-pressed': 'true', onclick: () => setFilter({ when: '' }), title: 'Remove this filter' }, when, icon('x', 12)) : null,
      anyFilter ? h('button', { class: 'linklike f-clear', type: 'button', onclick: clearFilters }, 'Clear') : null),
    h('span', { class: 'f-count', 'aria-live': 'polite' }, `${count ?? 0} of ${total}`),
    (S.view === 'wall' || S.view === 'list') && eligible.length ? h('button', { class: 'btn quiet f-verified', type: 'button', onclick: () => pickMany(eligible.map((p) => p.uid), !eligible.every((p) => S.picked.has(p.uid))), title: 'Tick every post shown whose checks are all done and passed' }, eligible.every((p) => S.picked.has(p.uid)) ? 'Untick verified' : `Tick ${eligible.length} verified`) : null].filter(Boolean));
  // keep typing where it was after a redraw
  if (document.activeElement?.dataset?.field === 'f-q') { /* the redraw replaced it; the new one takes focus below */ }
}

function renderBoot() {
  if (S.load === 'loading') {
    el.view.replaceChildren(h('div', { class: 'boot' }, skeleton(8)));
  } else {
    el.view.replaceChildren(emptyState({ tone: 'bad', title: 'The Studio could not load', body: `${S.error || 'Nordle did not answer.'} Is it still running? Your work on this computer is safe.`, action: h('button', { class: 'btn primary', onclick: () => { update({ load: 'loading' }); load({ force: true }); } }, 'Try again') }));
  }
}

function renderView() {
  const view = S.view;
  const scrollKey = view === 'month' ? `month|${S.brand}` : `${view}|${S.month}|${S.brand}`;
  const prevTop = sigs.scrollKey === scrollKey ? el.view.scrollTop : 0;
  const r = el.view;
  r.className = `view v-${view}`;
  if (view === 'month') renderMonth(r, ctx);
  else if (view === 'wall') renderWall(r, ctx);
  else if (view === 'list') renderList(r, ctx);
  else if (view === 'queue') Q.renderQueue(r, ctx);
  else if (view === 'plan') renderPlan(r, ctx);
  else if (view === 'create') renderCreate(r, ctx);
  else if (view === 'insights') renderInsights(r, ctx);
  else if (view === 'trash') renderTrash(r, ctx);
  if (sigs.scrollKey === scrollKey) r.scrollTop = prevTop;
  else if (view === 'month') queueMicrotask(() => { const today = S.month === monthOf(S.today); if (isPhone()) scrollAgenda(r, S.month, { today }); else scrollToMonth(r, S.month, { smooth: false, today }); });
  sigs.scrollKey = scrollKey;
  markSelection(false);
}

const viewSig = () => {
  const base = `${S.view}|${idOf(S.posts)}|${S.brand}|${JSON.stringify(S.f)}|${S.today}`;
  switch (S.view) {
    case 'month': return `${base}|${[...S.picked].join()}|${isPhone()}`;
    case 'wall': return `${base}|${[...S.picked].join()}|${S.month}`;
    case 'list': return `${base}|${[...S.picked].join()}|${S.sort.key}${S.sort.dir}`;
    case 'queue': return `${S.view}|${S.brand}|${JSON.stringify(S.f)}|${Q.queueSig()}`;
    default: return `${base}|${S.month}|${pub.loaded}${JSON.stringify(pub.adapters.map((a) => a.brands ?? a.selected ?? null))}`;
  }
};

function markSelection(scroll) {
  const uid = S.view === 'queue' ? null : S.sel;
  for (const n of el.view.querySelectorAll('.is-sel')) n.classList.remove('is-sel');
  for (const n of el.view.querySelectorAll('[data-uid][tabindex="0"]')) n.tabIndex = -1;
  if (!uid) { const first = el.view.querySelector('.chip[data-uid], .wc-pic'); if (first) first.tabIndex = 0; return; }
  let node = el.view.querySelector(`[data-uid="${CSS.escape(uid)}"]`);
  if (!node && S.view === 'list') node = el.view.querySelector('.lscroll')?.showRow?.(uid);
  if (!node) return;
  node.classList.add('is-sel');
  const focusable = node.matches('button, a') ? node : node.querySelector('button, a') ?? node;
  focusable.tabIndex = 0;
  if (scroll) {
    if (S.view === 'list') el.view.querySelector('.lscroll')?.showRow?.(uid);
    else node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (!S.open && document.activeElement !== focusable && !document.activeElement?.matches?.('input, textarea, select')) focusable.focus({ preventScroll: true });
  }
}

// ---- the detail sheet -----------------------------------------------------------------------------------------------------------------------

function closeDetail() {
  if (!S.open) return;
  const uid = S.sel;
  update({ open: false });
  writeUrl(false);
  releaseViewer();
  queueMicrotask(() => { markSelection(false); el.view.querySelector(`[data-uid="${CSS.escape(uid)}"]`)?.querySelector?.('button, a')?.focus?.({ preventScroll: true }); (el.view.querySelector(`.chip[data-uid="${CSS.escape(uid)}"]`))?.focus?.({ preventScroll: true }); });
}

function neighbour(delta) {
  const order = orderedUids();
  const i = order.indexOf(S.sel);
  const next = order[Math.max(0, Math.min(order.length - 1, i < 0 ? 0 : i + delta))];
  if (next) select(next, { open: S.open });
}

function renderDetailSheet() {
  const post = S.open && S.sel ? S.byUid.get(S.sel) : null;
  const open = !!post && S.view !== 'queue';
  el.detail.classList.toggle('open', open);
  el.scrim.classList.toggle('on', open);
  el.detail.setAttribute('aria-hidden', String(!open));
  if (!open) { if (sigs.detailUid) { sigs.detailUid = ''; detailToken++; el.detail.replaceChildren(); } return; }
  const token = ++detailToken;
  const first = sigs.detailUid !== post.uid;
  sigs.detailUid = post.uid;
  const order = orderedUids();
  const i = order.indexOf(post.uid);
  const bar = h('div', { class: 'd-bar' },
    h('button', { class: 'btn quiet icon', type: 'button', onclick: closeDetail, 'aria-label': 'Close', title: 'Close (Esc)' }, icon('x', 16)),
    h('span', { class: 'd-pos' }, i >= 0 ? `${i + 1} of ${order.length}` : ''),
    h('span', { class: 'sp' }),
    h('button', { class: 'btn quiet icon', type: 'button', onclick: () => neighbour(-1), disabled: i <= 0, 'aria-label': 'Previous post', title: 'Previous (K)' }, icon('chevL', 16)),
    h('button', { class: 'btn quiet icon', type: 'button', onclick: () => neighbour(1), disabled: i < 0 || i >= order.length - 1, 'aria-label': 'Next post', title: 'Next (J)' }, icon('chevR', 16)));
  const body = h('div', { class: 'd-body' }, D.loadingBlock());
  if (first) el.detail.replaceChildren(bar, body); else { el.detail.firstChild?.replaceWith(bar); }
  const target = first ? body : el.detail.querySelector('.d-body');
  D.fetchDetail(post).then((d) => {
    if (token !== detailToken) return;
    let cp;
    const viewer = mediaViewer(d, post, { w: 720, comments: d.comments, onDraft: (dr) => cp?.draft(dr), onPin: (c) => cp?.highlight(c.id), onMode: (on) => cp?.mode(on) });
    cp = commentsPanel({ d, post, viewer });
    const refresh = () => { sigs.detail = ''; D.forgetDetail(post.uid); update(); };
    // the decisions sit under the picture and its words; only "Open in editor" and "Remove" stay at the bottom
    const parts = D.actions(d, post, { afterAction: refresh, onResolved: closeDetail, split: true });
    const dock = parts.dock.childElementCount ? h('div', { class: 'd-dock' }, parts.dock) : null;   // nothing at the bottom when there is nothing to put there
    target.replaceChildren(...[
      h('div', { class: 'd-scroll' },
        viewer.el, D.videoNotice(d, post, refresh), parts.decide, D.head(d, post), cp.el, D.caption(d, post, { onChanged: refresh }), D.why(d, post), D.checks(d, post), D.pairs(d, post), D.history(d, post)),
      dock].filter(Boolean));
    if (first) el.detail.querySelector('.d-scroll')?.scrollTo?.(0, 0);
  }).catch((e) => { if (token === detailToken) target.replaceChildren(D.errorBlock(e.message, () => { sigs.detail = ''; update(); })); });
}

// ---- bulk selection bar ------------------------------------------------------------------------------------------------------------------

function renderSelbar() {
  const n = S.picked.size;
  el.selbar.classList.toggle('hidden', n === 0 || S.view === 'queue');
  if (n === 0) return;
  const posts = [...S.picked].map((u) => S.byUid.get(u)).filter(Boolean);
  const ok = posts.filter(act.eligibleForBulk);
  el.selbar.replaceChildren(
    h('span', { class: 'sb-n' }, h('b', {}, String(n)), ' selected'),
    h('span', { class: 'sb-ok' }, ok.length === n ? 'All can be signed off together' : `${ok.length} can be signed off together; ${n - ok.length} need a person to look`),
    h('span', { class: 'sp' }),
    h('button', { class: 'btn quiet', type: 'button', onclick: () => update({ picked: new Set() }) }, 'Clear'),
    h('button', { class: 'btn quiet nope', type: 'button', 'data-act': 'remove-selected', onclick: () => ctx.remove(posts) }, icon('trash', 14), 'Remove'),
    h('button', { class: 'btn', type: 'button', 'data-act': 'schedule', onclick: () => openSchedule([...S.picked]) }, icon('calendarSend', 14), 'Schedule…'),
    h('button', { class: 'btn go', type: 'button', disabled: !ok.length, onclick: () => act.bulkApprove([...S.picked]) }, icon('check', 15), `Sign off ${ok.length}`));
}

function renderTabbar() {
  const fig = figures();
  el.tabbar.replaceChildren(...NAV_ORDER.map((v) => {
    const m = VIEW_META[v];
    return h('a', { class: `tb${S.view === v ? ' on' : ''}`, href: hashFor({ view: v, post: '' }), 'aria-current': S.view === v ? 'page' : null, onclick: (e) => { e.preventDefault(); setView(v); } },
      h('span', { class: 'tb-i' }, icon(m.icon, 20), v === 'queue' && fig.needs ? h('b', {}, String(fig.needs)) : null), h('span', {}, m.label));
  }));
}

// ---- the whole page ---------------------------------------------------------------------------------------------------------------------

function render() {
  if (!active) return;
  el.studio.classList.toggle('is-queue', S.view === 'queue');
  el.studio.classList.toggle('with-detail', S.open && S.view !== 'queue');
  el.studio.dataset.view = S.view;
  const live = S.posts.filter((p) => p.build?.active);
  el.working.classList.toggle('hidden', !live.length);
  if (live.length) {
    const first = live[0];
    el.working.replaceChildren(h('i', { class: 'spin', 'aria-hidden': 'true' }), h('span', {}, h('b', {}, first.build.mode === 'change' ? 'Claude is changing ' : 'Claude is building '), `“${first.title}”`, first.build.since ? ` · ${elapsed(first.build.since)}` : '', live.length > 1 ? ` · and ${live.length - 1} more` : ''), h('button', { class: 'linklike', type: 'button', onclick: () => select(first.uid, { open: true }) }, 'Open it'));
  }
  el.banner.classList.toggle('hidden', !S.offline);
  if (S.offline) el.banner.replaceChildren(icon('alert', 15), h('span', {}, 'Nordle is not answering. This is the last copy it sent.'), h('button', { class: 'linklike', onclick: () => load({ force: true }) }, 'Try again'));
  if (S.load !== 'ready') { cached('boot', `${S.load}|${S.error}`, renderBoot); renderRail0(); return; }
  sigs.boot = '';
  cached('rail', JSON.stringify([S.view, S.brand, S.projects.map((p) => p.id), brandCounts(), themeMode(), idOf(S.posts), S.sel, S.trashCount, hostingNote()]), renderRail);
  cached('mast', JSON.stringify([S.view, S.month, S.brand, S.today, figures(), idOf(S.posts), isPhone()]), renderMast);
  cached('filters', JSON.stringify([S.view, S.brand, S.f, visible().length, filtersOpen, [...S.picked].length, idOf(S.posts), S.queue.list.length]), renderFilters);
  const vs = viewSig();
  if (sigs.view !== vs) {
    if (lastView !== S.view) { lastView = S.view; document.title = `${VIEW_META[S.view].label} · Nordle`; }
    sigs.view = vs;
    renderView();
  } else markSelection(false);
  const post = S.open ? S.byUid.get(S.sel) : null;
  const ds = JSON.stringify([S.open, S.sel, post && [post.status, post.builtAt, post.checks, post.score, post.staleSignoff], S.view === 'queue', idOf(S.posts) && S.open ? 1 : 0, pub.loaded, JSON.stringify(pub.adapters.map((a) => a.brands ?? a.selected ?? null))]);
  if (sigs.detail !== ds) { sigs.detail = ds; renderDetailSheet(); }
  cached('selbar', `${[...S.picked].join()}|${S.view}|${idOf(S.posts)}`, renderSelbar);
  cached('tabbar', JSON.stringify([S.view, figures().needs]), renderTabbar);
}

function renderRail0() {
  cached('rail0', 'x', () => el.rail.replaceChildren(h('a', { class: 'wordmark', href: '#/' }, 'Nordle', h('i', {}, '.'))));
}

// ---- keyboard ---------------------------------------------------------------------------------------------------------------------------

function orderedUids() {
  if (S.view === 'queue') return S.queue.list;
  if (S.view === 'list') return sorted().map((p) => p.uid);
  const list = visible();
  return list.map((p) => p.uid);
}

function spatial(dir) {
  const nodes = [...el.view.querySelectorAll('[data-uid]')].filter((n) => n.offsetParent !== null && !n.classList.contains('lr'));
  if (!nodes.length) return null;
  const cur = S.sel && nodes.find((n) => n.dataset.uid === S.sel);
  if (!cur) return nodes[0].dataset.uid;
  const a = cur.getBoundingClientRect();
  const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
  let best = null, bestScore = Infinity;
  for (const n of nodes) {
    if (n === cur) continue;
    const r = n.getBoundingClientRect();
    const dx = r.left + r.width / 2 - ax, dy = r.top + r.height / 2 - ay;
    let score;
    if (dir === 'right' && dx > 4) score = dx + Math.abs(dy) * 3;
    else if (dir === 'left' && dx < -4) score = -dx + Math.abs(dy) * 3;
    else if (dir === 'down' && dy > 4) score = dy + Math.abs(dx) * 3;
    else if (dir === 'up' && dy < -4) score = -dy + Math.abs(dx) * 3;
    else continue;
    if (score < bestScore) { bestScore = score; best = n; }
  }
  return best?.dataset.uid ?? null;
}

function move(dir) {
  if (S.view === 'queue') return;
  if (S.view === 'list' || dir === 'next' || dir === 'prev') {
    const order = orderedUids();
    if (!order.length) return;
    const i = order.indexOf(S.sel);
    const step = dir === 'down' || dir === 'next' ? 1 : -1;
    if (S.view === 'wall') revealAll(i + 2);
    select(order[Math.max(0, Math.min(order.length - 1, i < 0 ? 0 : i + step))]);
    return;
  }
  const target = spatial(dir);
  if (target) select(target); else if (dir === 'right' || dir === 'left') move(dir === 'right' ? 'next' : 'prev');
}

async function quick(kind) {
  const post = S.view === 'queue' ? Q.currentPost() : S.sel ? S.byUid.get(S.sel) : null;
  if (!post) { notify('Pick a post first: click one, or use the arrow keys.', { kind: 'info' }); return; }
  if (S.view === 'queue') { Q.decide({ a: 'approved', x: 'changes', r: 'rejected' }[kind]); return; }
  if (post.status === 'idea') {
    let ok = false;
    if (kind === 'a') ok = await act.approveIdea(post);
    else if (kind === 'x') await act.editIdea(post, await D.fetchDetail(post).catch(() => null));
    else ok = await act.rejectIdea(post);
    if (ok && S.open) closeDetail();
    return;
  }
  if (post.status === 'rejected') { if (kind === 'a') await act.reopen(post); return; }
  if (!post.docId && !post.external && kind !== 'r') { notify('This post is not built yet, so there is nothing to sign off.', { kind: 'info' }); return; }
  if (kind === 'a' && post.status === 'signed-off' && !post.staleSignoff) { notify('Already approved.', { kind: 'info' }); return; }
  const ok = kind === 'a' ? await act.approve(post) : kind === 'x' ? await act.requestChanges(post) : await act.reject(post);
  if (ok && S.open) closeDetail();
}

function showKeys() {
  const rows = [
    ['Go to', [['g m', 'Month'], ['g w', 'Wall'], ['g q', 'Review queue'], ['g l', 'List'], ['g p', 'Plan'], ['1 2 3 4', 'All brands, then each brand'], ['[  ]', 'Previous, next month'], ['T', 'Today']]],
    ['Move', [['J  K', 'Next, previous post'], ['← → ↑ ↓', 'Move around the grid'], ['Enter', 'Open the post'], ['Esc', 'Close, or clear the selection'], ['/', 'Search']]],
    ['Decide', [['C', 'Pin a comment on the picture'], ['A', 'Approve (sign off)'], ['X', 'Request changes'], ['R', 'Reject'], ['U', 'Undo the last decision'], ['E', 'Open in the editor']]],
    ['In a post', [[', .', 'Previous, next page (or 5 s back, forward)'], ['← →', 'Pages or seek, with the picture focused'], ['Space', 'Play or pause'], ['S', 'Skip (review queue)']]],
  ];
  dialog({
    title: 'Keyboard shortcuts',
    build: (b) => b.append(h('div', { class: 'keymap' }, rows.map(([t, items]) => h('section', {}, h('h3', { class: 'lbl' }, t), h('dl', {}, items.map(([k, l]) => h('div', {}, h('dt', {}, k.split(/\s{1,2}/).map((x) => h('kbd', {}, x))), h('dd', {}, l)))))))),
    actions: [{ id: 'close', label: 'Close', primary: true }],
  });
}

function typing(e) {
  const t = e.target;
  return t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && !(t.type === 'checkbox'));
}

function onKey(e) {
  if (!active || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  if (document.querySelector('dialog[open]')) return;
  if (typing(e)) return;
  const k = e.key;
  const inMedia = e.target instanceof HTMLElement && e.target.closest('.cv-track, .vp-video');
  if (inMedia && /^Arrow/.test(k)) return; // the picture handles its own arrows
  if (S.load !== 'ready') return;

  if (gPending && Date.now() - gPending < 1400) {
    gPending = 0;
    const view = Object.entries(VIEW_META).find(([, m]) => m.key === k.toLowerCase())?.[0];
    document.querySelector('.g-hint')?.remove();
    if (view) { e.preventDefault(); setView(view); }
    return;
  }
  const lower = k.length === 1 ? k.toLowerCase() : k;
  switch (lower) {
    case 'g': gPending = Date.now(); document.body.append(h('div', { class: 'g-hint' }, 'g…  ', h('span', {}, 'n create · m month · w wall · q review · l list · p plan · i insights'))); setTimeout(() => document.querySelector('.g-hint')?.remove(), 1400); e.preventDefault(); return;
    case '/': e.preventDefault(); (el.filters.querySelector('.f-q') ?? el.filters.querySelector('input'))?.focus(); return;
    case '?': e.preventDefault(); showKeys(); return;
    case 'Escape':
      if (activeViewer()?.pinMode?.()) { e.preventDefault(); activeViewer().setPinMode(false); return; }
      if (S.open) { e.preventDefault(); closeDetail(); } else if (S.picked.size) update({ picked: new Set() }); else if (S.sel && S.view !== 'queue') update({ sel: null });
      return;
    case '[': case 'PageUp': if (S.view === 'month') { e.preventDefault(); setMonth(addMonths(S.month, -1)); } return;
    case ']': case 'PageDown': if (S.view === 'month') { e.preventDefault(); setMonth(addMonths(S.month, 1)); } return;
    case 't': if (S.view === 'month') { setMonth(monthOf(S.today)); sigs.scrollKey = ''; } return;
    case '1': setBrand('all'); return;
    case '2': case '3': case '4': { const p = S.projects[Number(lower) - 2]; if (p) setBrand(p.id); return; }
    case 'u': e.preventDefault(); act.undoLast(); return;
    case 'Delete': { const p = S.view === 'queue' ? Q.currentPost() : S.sel && S.byUid.get(S.sel); if (p) { e.preventDefault(); ctx.remove([p]); } return; }
    case 'c': { const v = activeViewer(); if (v && v.kind !== 'none') { e.preventDefault(); v.setPinMode(!v.pinMode()); } else notify('Open a post to put a pin on its picture.', { kind: 'info' }); return; }
    case 'a': case 'x': case 'r': e.preventDefault(); quick(lower); return;
    case 'e': { const p = S.view === 'queue' ? Q.currentPost() : S.sel && S.byUid.get(S.sel); if (p?.docId) location.hash = `#/p/${encodeURIComponent(p.project)}/${encodeURIComponent(p.docId)}`; return; }
    default:
  }
  if (S.view === 'queue') {
    if (lower === 'j' || lower === 'n') { e.preventDefault(); Q.next(); }
    else if (lower === 'k' || lower === 'p') { e.preventDefault(); Q.prev(); }
    else if (lower === 's') { e.preventDefault(); Q.skip(); }
    else if (lower === 'ArrowRight' || lower === '.') { e.preventDefault(); Q.step(1); }
    else if (lower === 'ArrowLeft' || lower === ',') { e.preventDefault(); Q.step(-1); }
    else if (lower === ' ') { e.preventDefault(); Q.toggle(); }
    return;
  }
  if (S.view === 'plan' || S.view === 'create' || S.view === 'insights') return;
  if (lower === 'j') { e.preventDefault(); move('next'); }
  else if (lower === 'k') { e.preventDefault(); move('prev'); }
  else if (lower === 'ArrowRight') { e.preventDefault(); move('right'); }
  else if (lower === 'ArrowLeft') { e.preventDefault(); move('left'); }
  else if (lower === 'ArrowDown') { e.preventDefault(); move('down'); }
  else if (lower === 'ArrowUp') { e.preventDefault(); move('up'); }
  else if (lower === 'Enter') { if (S.sel) { e.preventDefault(); select(S.sel, { open: true }); } }
  else if (lower === '.' || lower === ',') { activeViewer()?.step(lower === '.' ? 1 : -1); }
  else if (lower === ' ' && S.open) { e.preventDefault(); activeViewer()?.toggle(); }
}

// ---- mounting ---------------------------------------------------------------------------------------------------------------------------

export function mountStudio(host) {
  root = host;
  build();
  subscribe(render);
  document.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', () => { if (active && document.visibilityState === 'visible') load(); });
  matchMedia('(max-width: 700px)').addEventListener('change', () => { sigs.view = ''; sigs.mast = ''; update(); });
  window.addEventListener('beforeunload', () => clearInterval(pollTimer));
}

export function showStudio(hash) {
  const first = !active;
  active = true;
  root.classList.remove('hidden');
  applyHash(hash);
  if (first) {
    Object.keys(sigs).forEach((k) => delete sigs[k]);
    update({ load: S.load === 'ready' ? 'ready' : 'loading' });
    load({ force: true }).then(() => { if (S.view === 'queue') buildQueue(S.queue.uid ?? undefined); update(); loadPublish(); startUpdateChecks(); });
    clearInterval(pollTimer);
    pollTimer = setInterval(() => { if (document.visibilityState === 'visible' && !document.querySelector('dialog[open]')) { load(); refreshAuto(); } }, 15000);
  } else {
    if (S.view === 'queue') buildQueue(S.queue.uid ?? undefined);
    update();
    load();
  }
}

export function hideStudio() {
  active = false;
  clearInterval(pollTimer);
  releaseViewer();
  hideTip();
  root?.classList.add('hidden');
}

/** Where the Studio is right now, so the editor's back button can return to the same place. */
export const studioHash = () => (S.load === 'ready' ? hashFor() : '#/');


// ---- "Nordle has been updated on GitHub" -----------------------------------------------------------------------------------------------
// Asks the server (which asks GitHub at most every six hours). It only tells you; the two commands to run are one click away.
let updateTimer = 0;
async function checkUpdate({ force = false } = {}) {
  let u;
  try { u = await api.get(`/update${force ? '?force=1' : ''}`); } catch { return; }
  S.updateInfo = u;
  const show = u.enabled && u.updateAvailable && !u.dismissed;
  el.update.classList.toggle('hidden', !show);
  if (!show) return;
  const n = u.behindBy || u.changes.length || 0;
  el.update.replaceChildren(icon('alert', 15),
    h('span', {}, h('b', {}, 'Nordle has been updated on GitHub'), n ? ` · ${n} new change${n === 1 ? '' : 's'}` : '', u.latest?.message ? ` · latest: ${u.latest.message}` : ''),
    h('button', { class: 'linklike', type: 'button', 'data-act': 'update-info', onclick: () => showUpdate(u) }, 'What changed'),
    h('button', { class: 'linklike', type: 'button', 'data-act': 'update-copy', onclick: () => { navigator.clipboard?.writeText(u.command).then(() => notify('Copied. Paste it in a terminal, then restart the Studio.', { kind: 'ok' }), () => notify(u.command, { kind: 'info' })); } }, 'Copy the update command'),
    h('button', { class: 'linklike', type: 'button', 'data-act': 'update-dismiss', onclick: async () => { try { await api.post('/update/dismiss', { sha: u.latest.sha }); } catch { /* it comes back next time */ } el.update.classList.add('hidden'); } }, 'Not now'));
}
function showUpdate(u) {
  const body = h('div', { class: 'db' },
    h('p', {}, 'These changes are on GitHub and not in your copy yet:'),
    h('ul', { class: 'upd-list' }, (u.changes.length ? u.changes : [{ sha: (u.latest?.sha ?? '').slice(0, 7), message: u.latest?.message ?? '' }]).map((c) => h('li', {}, h('code', {}, c.sha), ' ', c.message))),
    h('p', {}, 'To update, run this in a terminal, then restart the Studio:'), h('pre', { class: 'upd-cmd' }, u.command),
    h('p', { class: 'muted' }, 'Nordle only tells you; it never installs anything itself. Your projects and settings are not touched. ', h('a', { href: u.url, target: '_blank', rel: 'noopener' }, 'See everything on GitHub')),
    h('p', { class: 'muted' }, 'Created by Samuel Young. ', h('button', { class: 'linklike', type: 'button', onclick: async () => { try { await api.post('/update/settings', { enabled: false }); notify('Update checks are off. Turn them on again with: node nordle.mjs update --on', { kind: 'info' }); el.update.classList.add('hidden'); } catch (e) { notify(e.message, { kind: 'error' }); } } }, 'Stop checking for updates')));
  const dlg = h('dialog', { class: 'wide', 'aria-label': 'What changed in Nordle' }, h('div', { class: 'dh' }, 'What changed'), body, h('div', { class: 'df' }, h('button', { class: 'btn primary', type: 'button', onclick: () => dlg.close() }, 'Close')));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg); dlg.showModal();
}
/** Claude Code is what builds posts, writes ideas and reads screenshots. If it is installed but not signed in, say so once, with a button: no terminal. */
async function checkClaude() {
  let c;
  try { c = await api.get('/claude'); } catch { return; }
  if (!c.found) { el.claude.replaceChildren(icon('alert', 15), h('span', {}, h('b', {}, 'Claude Code is not installed on this computer. '), 'Nordle uses it to build posts, write ideas and read pictures. Nothing else in Nordle needs it.')); el.claude.classList.remove('hidden'); return; }
  if (c.signedIn !== false) { el.claude.classList.add('hidden'); return; }
  el.claude.replaceChildren(icon('alert', 15), h('span', {}, h('b', {}, 'Claude is not signed in on this computer. '), 'Sign in once so Nordle can build posts, write ideas and read pictures for you. '),
    claudeSignIn({ onReady: () => { el.claude.classList.add('hidden'); notify('Signed in. Nordle can use Claude now.', { kind: 'ok' }); } }));
  el.claude.classList.remove('hidden');
}
export function startUpdateChecks() { window.addEventListener('nordle:claude', checkClaude); checkClaude(); checkUpdate(); clearInterval(updateTimer); updateTimer = setInterval(() => { if (document.visibilityState === 'visible') checkUpdate(); }, 6 * 3600 * 1000); }
