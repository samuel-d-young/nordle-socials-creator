// Small pieces the Studio views share: status marks, format glyphs, thumbnails, key caps, empty states, notices, tooltips.

import { api } from './api.js';
import { h, icon, dialog } from './dom.js';
import { S, dateFmt, project } from './studio-store.js';

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
    case 'approved': return { key: 'queued', label: p.build?.due ? 'Waiting for Claude' : 'Queued to build', tone: 'plain' };
    case 'building': return { key: 'building', label: p.build?.active ? (p.revising ? 'Claude is changing it' : 'Claude is building it') : p.revising ? 'Being changed' : 'Being built', tone: 'plain' };
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
  return h('span', { class: `st st-${s.tone}${p.build?.active ? ' st-live' : ''}` }, mark(s.key), h('span', {}, short ? s.label.replace('Updated · needs your review', 'Updated').replace('Needs your review', 'To review').replace('Changes requested', 'Changes') : s.label),
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
  // while Claude is working on the post, its picture shimmers and a small mark loops over it (CSS only, so it keeps going without any script)
  const box = h('span', { class: `th ${p.build?.active ? 'working ' : ''}${cls}`.trim(), style: { '--lane': laneColor(p.project) }, ...(p.build?.active ? { title: p.build.mode === 'change' ? 'Claude is changing this post now' : 'Claude is building this post now' } : {}) });
  if (p.build?.active) box.append(h('span', { class: 'th-claude', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')));
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

/**
 * A text input for a folder path with a "Choose…" button beside it that opens the system's folder window (the server shows it on this computer: a web
 * page cannot learn a folder's full path). Typing or pasting still works. `onChange` runs when a folder is chosen; `onPick(path)`, if given, takes the
 * path instead of the box (a list of folders).
 * @returns {HTMLElement} a wrapper holding `input` and the button; the input is also on `.input`.
 */
export function folderPicker(input, { title = 'Choose a folder', field = 'choose-folder', onChange, onPick } = {}) {
  const hint = h('span', { class: 'muted bg-hint pick-note', role: 'status', hidden: true });
  const button = h('button', { class: 'btn', type: 'button', 'data-act': field, 'aria-label': `${title} (opens a folder window)` }, 'Choose…');
  button.addEventListener('click', async () => {
    button.disabled = true; button.textContent = 'Waiting…'; hint.hidden = false; hint.textContent = 'A folder window is open on this computer. It may be behind this one.';
    try {
      const r = await api.post('/brand/pick-folder', { title });
      if (r.path) { if (onPick) onPick(r.path); else { input.value = r.path; input.dispatchEvent(new Event('input', { bubbles: true })); } onChange?.(r.path); hint.hidden = true; }
      else hint.textContent = r.message || 'No folder chosen.';
    } catch (e) { hint.textContent = e.message || 'The folder window could not be opened. Type or paste the path instead.'; }
    finally { button.disabled = false; button.textContent = 'Choose…'; }
  });
  const wrap = h('span', { class: 'pick-row' }, input, button, hint);
  wrap.input = input;
  return wrap;
}

/** How long since a time, in plain words that are short enough to keep counting: "40 s", "3 min", "1 h 5 min". */
export function elapsed(iso, now = Date.now()) {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 90) return `${Math.max(s, 1)} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

/**
 * What is happening to a post that is queued or being built, in one plain line that keeps counting while Claude works.
 * Returns an element, or null when the post is neither. `p.build` comes from src/studio/data.mjs (buildOf).
 */
export function buildLine(p) {
  const b = p?.build;
  if (!b) return null;
  const el = h('div', { class: `build-line${b.active ? ' live' : ''}`, role: 'status', 'data-state': b.active ? 'working' : b.stalled ? 'stalled' : b.due ? 'due' : 'queued' });
  const paint = () => {
    const kids = [];
    if (b.phase === 'building' && b.active) {
      kids.push(h('i', { class: 'spin', 'aria-hidden': 'true' }), h('span', {}, h('b', {}, b.mode === 'change' ? 'Claude is changing this post now' : 'Claude is building this post now'), h('span', { class: 'dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), b.since ? ` · started ${elapsed(b.since)} ago` : '', b.attempt > 1 ? ` · try ${b.attempt} of ${b.maxAttempts}` : '', '. It comes back here to be reviewed when it is done.'));
    } else if (b.phase === 'building') {
      kids.push(icon('alert', 14), h('span', {}, 'It was being built, but nothing is running now. It will be picked up again; or press Build it now.'));
    } else if (b.due) {
      kids.push(h('i', { class: 'wait', 'aria-hidden': 'true' }), h('span', {}, b.waiting ? (b.waiting === 1 ? 'In line: Claude builds this one next, as soon as it finishes the post it is making.' : `In line: ${b.waiting - 1} ahead of this one. Claude builds them one at a time.`) : b.busy ? `Waiting its turn${b.ahead ? ` (${b.ahead} ahead)` : ''}: Claude is busy with another post.` : b.autoBuild ? `Ready to build${b.ahead ? ` (${b.ahead} ahead of it)` : ''}. Claude starts when it is free.` : 'Ready to build. Automatic building is off, so press Build it now, or ask Claude to build it.'), b.lastError ? h('span', { class: 'bad' }, ` The last try failed: ${b.lastError.length > 160 ? `${b.lastError.slice(0, 157)}...` : b.lastError}`) : null);
    } else {
      kids.push(h('i', { class: 'wait', 'aria-hidden': 'true' }), h('span', {}, `Queued. ${b.autoBuild ? 'Claude starts' : 'It becomes due'} about ${dateFmt.long(b.startsOn)} (${b.leadDays} days before it goes out).`));
    }
    el.replaceChildren(...kids.filter(Boolean));
  };
  paint();
  if (b.active) { const t = setInterval(() => { if (!el.isConnected) clearInterval(t); else paint(); }, 15000); }
  return el;
}

/**
 * A "Sign in to Claude" button (and what it shows while you are signing in): it starts the sign-in on this computer, the browser opens, you approve there, and the
 * `onReady` callback runs the moment Claude Code says it is signed in. No terminal. Returns an element.
 */
export function claudeSignIn({ onReady, label = 'Sign in to Claude' } = {}) {
  const box = h('span', { class: 'signin', 'data-field': 'claude-signin' });
  let timer = 0;
  const stop = () => { clearInterval(timer); timer = 0; };
  const paint = (state, url, error) => {
    box.replaceChildren(...(state === 'waiting'
      ? [h('i', { class: 'spin', 'aria-hidden': 'true' }), h('span', { role: 'status', 'data-state': 'signin-waiting' }, 'A browser window opened. Sign in there and approve, and Nordle carries on by itself. '),
        url ? h('a', { href: url, target: '_blank', rel: 'noopener' }, 'If it did not open, use this link. ') : null,
        h('button', { class: 'linklike', type: 'button', 'data-act': 'claude-signin-cancel', onclick: async () => { stop(); try { await api.post('/claude/login/cancel', {}); } catch { /* ok */ } paint('idle'); } }, 'Cancel')]
      : [h('button', { class: 'btn primary', type: 'button', 'data-act': 'claude-signin', onclick: start }, label), error ? h('span', { class: 'bad', role: 'alert' }, ` ${error}`) : null]).filter(Boolean));
  };
  async function poll() {
    try {
      const r = await api.get('/claude');
      if (r.signedIn === true) { stop(); paint('idle'); onReady?.(r); return; }
      if (r.login?.state === 'waiting') paint('waiting', r.login.url);
      else if (r.login?.state === 'failed' || r.login?.state === 'cancelled') { stop(); paint('idle', null, r.login.error ?? ''); }
    } catch { /* the next look will try again */ }
  }
  async function start() {
    paint('waiting');
    try {
      const r = await api.post('/claude/login', {});
      if (r.login?.state === 'failed') { paint('idle', null, r.login.error); return; }
      if (r.login?.state === 'done') { paint('idle'); onReady?.(r); return; }
    } catch (e) { paint('idle', null, e.message); return; }
    stop(); timer = setInterval(() => { if (!box.isConnected) stop(); else poll(); }, 2000);
    poll();
  }
  paint('idle');
  return box;
}
