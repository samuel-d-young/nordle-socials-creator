// Small pieces the Studio views share: status marks, format glyphs, thumbnails, key caps, empty states, notices, tooltips.

import { h, icon, dialog } from './dom.js';
import { S, project } from './studio-store.js';

const token = document.querySelector('meta[name="nordle-token"]')?.content ?? '';

export const FORMAT_LABEL = { reel: 'Reel', carousel: 'Carousel', post: 'Post', story: 'Story' };
export const FORMAT_PLURAL = { reel: 'Reels', carousel: 'Carousels', post: 'Posts', story: 'Stories' };

const GLYPH = {
  reel: '<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M6.8 5.7v4.6L10.7 8z" fill="currentColor" stroke="none"/>',
  carousel: '<rect x="2.5" y="5.5" width="8" height="8" rx="1"/><path d="M5.5 3.5h8v8"/>',
  post: '<rect x="2.5" y="2.5" width="11" height="11" rx="1"/><path d="M2.5 11l3.4-3.2 2.4 2.1 2-1.6 3.2 2.7"/>',
  story: '<rect x="4.5" y="1.5" width="7" height="13" rx="1.5"/><circle cx="8" cy="5.6" r="1.2"/>',
};
export function glyph(format, size = 14) {
  const s = h('span', { class: `glyph glyph-${format}`, 'aria-hidden': 'true' });
  s.innerHTML = `<svg viewBox="0 0 16 16" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round">${GLYPH[format] ?? GLYPH.post}</svg>`;
  return s;
}

/** Plain-English status, its tone (colour family) and the shape that carries it besides colour. */
export function statusOf(p) {
  if (p.staleSignoff) return { key: 'stale', label: 'Edited since sign-off', tone: 'proof' };
  switch (p.status) {
    case 'built': return { key: 'built', label: p.revised ? 'Updated · needs your review' : 'Needs your review', tone: 'ink' };
    case 'changes': return { key: 'changes', label: 'Changes requested', tone: 'pencil' };
    case 'signed-off': return { key: 'signed', label: 'Signed off', tone: 'stamp' };
    case 'scheduled': return { key: 'scheduled', label: 'Scheduled', tone: 'stamp' };
    case 'approved': return { key: 'queued', label: 'Queued to build', tone: 'plain' };
    case 'building': return { key: 'building', label: p.revising ? 'Being changed' : 'Being built', tone: 'plain' };
    case 'idea': return { key: 'idea', label: 'Idea', tone: 'ghost' };
    case 'rejected': return { key: 'rejected', label: 'Rejected', tone: 'ghost' };
    case 'posted': return { key: 'posted', label: 'Posted', tone: 'plain' };
    default: return { key: 'other', label: p.status, tone: 'plain' };
  }
}
export const mark = (key) => h('i', { class: `mk mk-${key}`, 'aria-hidden': 'true' });
/** Approved, but not put in any publishing platform yet: these get a red glow so they are not forgotten. */
export const notScheduled = (p) => p.status === 'signed-off' && !p.staleSignoff;
export const UNSCHED_TIP = 'Approved, but not scheduled in a platform yet';
export function statusChip(p, { short = false } = {}) {
  const s = statusOf(p);
  return h('span', { class: `st st-${s.tone}` }, mark(s.key), h('span', {}, short ? s.label.replace('Updated · needs your review', 'Updated').replace('Needs your review', 'To review').replace('Changes requested', 'Changes') : s.label),
    notScheduled(p) ? h('span', { class: 'st-unsched', title: UNSCHED_TIP }, 'Not scheduled') : null);
}

export function laneColor(id) { return project(id)?.color ?? 'var(--ink-3)'; }
export function brandName(id) { return project(id)?.name ?? id; }
export function brandTick(id) { return h('i', { class: 'tick', style: { '--lane': laneColor(id) }, 'aria-hidden': 'true' }); }

// ---- pictures ---------------------------------------------------------------------------------------------------------------

// The browser keeps a picture for a minute, so after a post is redrawn (edited here) every picture address gets a new stamp and is fetched again.
let pictureStamp = '';
export const bumpPictures = () => { pictureStamp = String(Date.now()); };
export function thumbUrl(projectId, path, w = 240) {
  return `/api/studio/thumb?project=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}&w=${w}&t=${encodeURIComponent(token)}${pictureStamp ? `&r=${pictureStamp}` : ''}`;
}
export const fileUrl = (projectId, path) => `/p/${encodeURIComponent(projectId)}/${path.split('/').map(encodeURIComponent).join('/')}`;

/** A framed small picture of a post (or an index-card stand-in when it has none yet). */
export function postThumb(p, { w = 240, eager = false, cls = '' } = {}) {
  const box = h('span', { class: `th ${cls}`.trim(), style: { '--lane': laneColor(p.project) } });
  if (p.thumb) {
    const img = h('img', { src: thumbUrl(p.project, p.thumb, w), alt: '', loading: eager ? 'eager' : 'lazy', decoding: 'async', draggable: 'false' });
    img.addEventListener('error', () => { box.classList.add('th-missing'); img.remove(); box.prepend(h('span', { class: 'th-ph' }, h('span', {}, p.title))); });
    box.append(img);
  } else {
    box.classList.add('th-none');
    box.append(h('span', { class: 'th-ph' }, h('span', {}, p.title)));
  }
  return box;
}

/** Tiny squares, one per check that is required: passed, to look at, failed, not done. */
export function checkDots(c) {
  if (!c) return h('span', { class: 'cbar none', title: 'No checks recorded' }, h('span', { class: 'cbar-none' }, 'no check record'));
  const dots = [];
  for (let i = 0; i < c.pass; i++) dots.push('pass');
  for (let i = 0; i < c.warn; i++) dots.push('warn');
  for (let i = 0; i < c.fail; i++) dots.push('fail');
  for (let i = 0; i < c.missing; i++) dots.push('miss');
  const bits = [`${c.pass} passed`, c.warn && `${c.warn} to look at`, c.fail && `${c.fail} failed`, c.missing && `${c.missing} not done yet`].filter(Boolean);
  return h('span', { class: 'cbar', title: bits.join(', '), role: 'img', 'aria-label': `Checks: ${bits.join(', ')}` }, dots.map((d) => h('i', { class: d })));
}

export function scoreBadge(p) {
  if (p.score === null || p.score === undefined) return h('span', { class: 'score none', title: 'No design score yet' }, '–');
  return h('span', { class: `score ${p.score >= 88 ? 'good' : 'low'}${p.scoreStale ? ' stale' : ''}`, title: `Design score ${p.score} of 100 (pass mark 88)${p.scoreStale ? ', from an older version' : ''}` }, String(p.score));
}

export const kbd = (...keys) => h('span', { class: 'keys' }, keys.map((k) => h('kbd', {}, k)));

// ---- states -----------------------------------------------------------------------------------------------------------------

export function emptyState({ title, body, action, tone = '' }) {
  return h('div', { class: `blank ${tone}` }, h('div', { class: 'blank-rule' }), h('h2', {}, title), body ? h('p', {}, body) : null, action ?? null);
}

export function skeleton(rows = 6) {
  return h('div', { class: 'skel', 'aria-hidden': 'true' }, Array.from({ length: rows }, () => h('div', { class: 'skel-row' }, h('i'), h('b'), h('b'))));
}

// ---- notices (with an Undo button) ---------------------------------------------------------------------------------------------

let notices;
/**
 * "Try again in 1583 seconds" -> "Try again in 27 minutes" (and "in 3900 seconds" -> "1 hour 5 minutes"). Waiting times are never shown
 * as seconds. Also fixes messages saved by an older version, so what is on screen always reads the same way.
 */
export function plainWaits(text) {
  return String(text ?? '').replace(/\b(in|after|for)\s+(\d+)\s+seconds?\b/gi, (all, word, n) => {
    const total = Math.max(1, Math.ceil(Number(n) / 60)), hh = Math.floor(total / 60), mm = total % 60;
    const part = (k, one) => `${k} ${one}${k === 1 ? '' : 's'}`;
    return `${word} ${[hh ? part(hh, 'hour') : null, mm ? part(mm, 'minute') : null].filter(Boolean).join(' ')}`;
  });
}

export function notify(message, { kind = 'info', action, ms = 6500 } = {}) {
  notices ??= document.body.appendChild(h('div', { class: 'notices', role: 'status', 'aria-live': 'polite' }));
  const el = h('div', { class: `notice ${kind}` }, h('span', { class: 'notice-text' }, typeof message === 'string' ? plainWaits(message) : message));
  if (action) el.append(h('button', { class: 'notice-act', onclick: () => { action.fn(); el.remove(); } }, action.label, action.key ? kbd(action.key) : null));
  const close = h('button', { class: 'notice-x', 'aria-label': 'Dismiss', onclick: () => el.remove() }, icon('x', 12));
  el.append(close);
  notices.append(el);
  while (notices.children.length > 3) notices.firstChild.remove();
  setTimeout(() => el.remove(), kind === 'error' ? Math.max(ms, 9000) : ms);
}

// ---- a tooltip that says what a thumbnail is ------------------------------------------------------------------------------------

let tipEl;
export function showTip(target, build) {
  tipEl ??= document.body.appendChild(h('div', { class: 'tip hidden', role: 'tooltip' }));
  tipEl.replaceChildren(build());
  tipEl.classList.remove('hidden');
  const r = target.getBoundingClientRect();
  const t = tipEl.getBoundingClientRect();
  let x = r.left + r.width / 2 - t.width / 2;
  let y = r.bottom + 8;
  if (y + t.height > innerHeight - 8) y = r.top - t.height - 8;
  x = Math.max(8, Math.min(innerWidth - t.width - 8, x));
  tipEl.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}
export function hideTip() { tipEl?.classList.add('hidden'); }

export function postTip(p) {
  const st = statusOf(p);
  return h('div', { class: 'tip-in' },
    h('div', { class: 'tip-meta' }, brandTick(p.project), h('span', {}, `${brandName(p.project)} · ${FORMAT_LABEL[p.format] ?? p.format}${p.date ? ` · ${p.date.slice(8)}/${p.date.slice(5, 7)}` : ''}`)),
    h('div', { class: 'tip-title' }, p.title),
    h('div', { class: `tip-status st-${st.tone}` }, mark(st.key), st.label, p.failing ? ' · a check failed' : ''));
}

/** Attach the hover/focus tooltip to something that shows a post. Mouse and keyboard only (not touch). */
export function tipOn(el, p) {
  el.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') showTip(el, () => postTip(p)); });
  el.addEventListener('pointerleave', hideTip);
  el.addEventListener('focus', () => { if (el.matches(':focus-visible')) showTip(el, () => postTip(p)); });
  el.addEventListener('blur', hideTip);
}

// ---- dialogs ----------------------------------------------------------------------------------------------------------------

/** Ask for some words. Resolves with the text, or null if cancelled. */
export async function askText({ title, label, placeholder = '', ok = 'Save', required = true, intro, value = '', danger = false }) {
  let area;
  const r = await dialog({
    title,
    build: (body, finish) => {
      area = h('textarea', { class: 'field ask-area', rows: 4, placeholder, value, 'aria-label': label, maxlength: 4000 });
      area.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); if (!required || area.value.trim()) finish('ok'); } });
      body.append(intro ? h('p', { class: 'muted ask-intro' }, intro) : null, h('label', { class: 'ask-label' }, label), area, h('p', { class: 'ask-hint muted' }, 'Ctrl+Enter to save'));
    },
    onOpen: () => area.focus(),
    actions: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: ok, primary: !danger, danger }],
  });
  if (r !== 'ok') return null;
  const text = area.value.trim();
  if (required && !text) return null;
  return text;
}

export async function askConfirm({ title, body, ok = 'Yes', danger = false, details }) {
  const r = await dialog({
    title,
    build: (b) => b.append(...[h('p', { class: 'ask-body' }, body), details].filter(Boolean)),   // (append(null) would print the word "null")
    actions: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: ok, primary: !danger, danger }],
  });
  return r === 'ok';
}

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function themeMode() {
  try { return localStorage.getItem('nordle-theme') || 'system'; } catch { return 'system'; }
}
export function setTheme(mode) {
  try { if (mode === 'system') localStorage.removeItem('nordle-theme'); else localStorage.setItem('nordle-theme', mode); } catch { /* storage blocked */ }
  if (mode === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = mode;
}

export function cycleThemeGlobal() {
  const order = ['system', 'light', 'dark'];
  setTheme(order[(order.indexOf(themeMode()) + 1) % 3]);
}
export { S };
