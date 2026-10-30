// "Claude" in the left bar: what Claude is doing right now ("Changing the video ..."), what it has just finished (a tick), and a soft chime when a piece of work
// ends. The chime can be switched off with the speaker button (kept in this browser). Data: GET /api/activity every couple of seconds (src/server/activity.mjs),
// built from Claude's own requests, so it is true whether Claude was started from the Studio or works from a terminal.
// Browsers keep a page silent until the person has clicked or pressed a key in it once: before that, a chime is skipped, never an error.

import { api } from './api.js';
import { h, icon } from './dom.js';
import { S, project } from './studio-store.js';
import { elapsed } from './studio-ui.js';

const SOUND_KEY = 'nordle.activity.sound';
const SHOW_RECENT = 3;              // finished pieces of work in the list
const RECENT_FOR_MS = 20 * 60000;   // and only while they are new
const POLL_MS = 2000;

/** The one element; the left bar puts it in place each time it is drawn. */
export const activityEl = h('section', { class: 'act', 'aria-label': 'What Claude is doing', 'data-state': 'idle' });

const st = { data: null, seen: new Set(), primed: false, ctx: null, timer: 0, clock: 0 };

// ---- the sound: two soft notes made on the spot (no sound file) ----------------------------------------------------------------------------------

let audio = null;
export const soundOn = () => { try { return localStorage.getItem(SOUND_KEY) !== 'off'; } catch { return true; } };
const setSound = (on) => { try { localStorage.setItem(SOUND_KEY, on ? 'on' : 'off'); } catch { /* the choice just is not kept */ } };

function unlock() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audio ??= new AC();
    if (audio.state === 'suspended') audio.resume?.();
  } catch { /* no sound on this computer */ }
}
for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, unlock, { capture: true, passive: true });

function note(freq, at, length) {
  const o = audio.createOscillator(), g = audio.createGain();
  o.type = 'sine'; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(0.06, at + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, at + length);
  o.connect(g); g.connect(audio.destination);
  o.start(at); o.stop(at + length + 0.05);
}
/** The "done" chime. Returns whether it could play. */
export function chime() {
  if (!soundOn()) return false;
  try {
    unlock();
    if (!audio || audio.state === 'closed' || audio.state === 'suspended') return false;
    const t = audio.currentTime;
    note(659.25, t, 0.18);          // E5
    note(987.77, t + 0.15, 0.32);   // B5
    return true;
  } catch { return false; }
}

// ---- the picture --------------------------------------------------------------------------------------------------------------------------------

const clip = (s, n = 34) => (s && s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s ?? '');
const postOf = (it) => (it.doc ? S.posts.find((p) => p.project === it.project && p.docId === it.doc) : null);
const brandTick = (it) => { const pr = project(it.project); return pr ? h('i', { class: 'act-tick', style: { background: pr.color }, 'aria-hidden': 'true' }) : null; };

function workingRow(it) {
  const pct = typeof it.percent === 'number' && it.percent > 0 && it.percent < 100 ? it.percent : null;
  const post = postOf(it);
  return h('li', { class: 'act-row act-now', 'data-id': it.id },
    h('i', { class: 'act-spin', 'aria-hidden': 'true' }),
    h('span', { class: 'act-main' },
      h('b', {}, `${it.verb} ${it.what}`),
      it.title ? h('span', { class: 'act-title' }, brandTick(it), h('span', { class: 'act-tt' }, `“${clip(it.title, 70)}”`)) : null,
      h('small', { class: 'act-sub' }, [pct !== null ? `${pct} %` : null, it.steps > 1 ? `${it.steps} steps` : null, elapsed(it.startedAt)].filter(Boolean).join(' · ')),
      pct !== null ? h('span', { class: 'act-bar', role: 'progressbar', 'aria-valuenow': String(pct), 'aria-valuemin': '0', 'aria-valuemax': '100' }, h('i', { style: { width: `${pct}%` } })) : null),
    post ? h('button', { class: 'act-open', type: 'button', 'aria-label': `Open ${post.title}`, title: 'Open it', onclick: () => st.ctx?.open(post.uid) }, icon('chevR', 13)) : null);
}

function recentRow(it) {
  const post = postOf(it);
  const inner = [
    icon(it.ok === false ? 'alert' : 'check', 14),
    h('span', { class: 'act-main' },
      h('b', {}, it.ok === false ? `Did not finish: ${it.verb.toLowerCase()} ${it.what}` : `${it.past} ${it.what}`),
      it.title ? h('span', { class: 'act-title' }, brandTick(it), h('span', { class: 'act-tt' }, `“${clip(it.title, 70)}”`)) : null,
      h('small', { class: 'act-sub' }, `${elapsed(it.finishedAt)} ago${it.steps > 1 ? ` · ${it.steps} steps` : ''}`)),
  ];
  const cls = `act-row done${it.ok === false ? ' bad' : ''}${Date.now() - Date.parse(it.finishedAt) < 6000 ? ' just' : ''}`;
  return post
    ? h('li', { class: cls, 'data-id': it.id }, h('button', { class: 'act-link', type: 'button', title: 'Open it', onclick: () => st.ctx?.open(post.uid) }, ...inner))
    : h('li', { class: cls, 'data-id': it.id }, ...inner);
}

export function paintActivity() {
  const d = st.data;
  const working = d?.working ?? [];
  const recent = (d?.recent ?? []).filter((x) => Date.now() - Date.parse(x.finishedAt) < RECENT_FOR_MS).slice(0, SHOW_RECENT);
  const on = soundOn();
  activityEl.dataset.state = working.length ? 'working' : recent.length ? 'finished' : 'idle';
  activityEl.replaceChildren(
    h('div', { class: 'act-head' },
      h('h2', { class: 'lbl' }, 'Claude'),
      h('span', { class: 'act-state', role: 'status', 'data-state': 'act-status' }, working.length ? (working.length > 1 ? `${working.length} at once` : 'working') : 'idle'),
      h('button', { class: 'act-snd', type: 'button', 'data-act': 'act-sound', 'aria-pressed': String(on), 'aria-label': on ? 'Chime when Claude finishes: on' : 'Chime when Claude finishes: off', title: on ? 'Chime when Claude finishes: on (click to turn off)' : 'Chime when Claude finishes: off (click to turn on)',
        onclick: () => { setSound(!soundOn()); if (soundOn()) chime(); paintActivity(); } }, icon(on ? 'sound' : 'soundOff', 14))),
    working.length || recent.length
      ? h('ul', { class: 'act-list', 'aria-live': 'polite' }, working.slice(0, 3).map(workingRow), recent.map(recentRow))
      : h('p', { class: 'act-idle muted' }, 'Nothing right now. When Claude starts on a post, it shows here.'));
}

async function tick() {
  try {
    const d = await api.get('/activity');
    const first = !st.primed;
    st.primed = true;
    let finished = false;
    for (const it of d.recent ?? []) {
      if (st.seen.has(it.id)) continue;
      st.seen.add(it.id);
      if (!first) finished = true;       // not the ones that were already finished when the page opened
    }
    st.data = d;
    paintActivity();
    if (finished) chime();
  } catch { /* the next look tries again */ }
}

/** Start looking. `ctx.open(uid)` opens a post when a line is clicked. */
export function startActivity(ctx) {
  st.ctx = ctx;
  clearInterval(st.timer); clearInterval(st.clock);
  paintActivity();
  tick();
  st.timer = setInterval(() => { if (document.visibilityState === 'visible') tick(); }, POLL_MS);
  st.clock = setInterval(() => { if (document.visibilityState === 'visible' && st.data) paintActivity(); }, 15000);      // "2 min ago" moves on
}
