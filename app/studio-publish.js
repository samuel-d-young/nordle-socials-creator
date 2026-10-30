// Scheduling and the accounts behind it. A brand can post to several accounts (an Instagram, a Facebook page...); each account takes
// the formats it should, can run a few minutes behind, and can drop hashtags. The Schedule dialog shows one line per post and account,
// lets one account be switched off for this run, and says what will be sent before the button is pressed. Nothing is sent until then.

import { api } from './api.js';
import { h, icon } from './dom.js';
import { S, load, update } from './studio-store.js';
import { askConfirm, brandName, notify, plainWaits, plural } from './studio-ui.js';
import { openCoverPicker } from './studio-cover.js';
import { PUBLISH_GUIDES, guideBlock } from './platform-guides.js';
import { loadSignInStatus, onSignInChange, resetSignIn, setSignInSink, signInBox, signInCardText, startSignIn } from './studio-buffer-signin.js';

const FORMATS = [['reel', 'Reels'], ['carousel', 'Carousels'], ['post', 'Posts'], ['story', 'Stories']];

// ---- small shared pieces --------------------------------------------------------------------------------------------------------------

function modal(title) {
  const body = h('div', { class: 'db' });
  const foot = h('div', { class: 'df' });
  const dlg = h('dialog', { class: 'wide', 'aria-label': title }, h('div', { class: 'dh' }, title), body, foot);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  return { dlg, body, foot, close: () => dlg.close() };
}
const btn = (label, opts = {}, ...kids) => h('button', { class: `btn${opts.primary ? ' primary' : ''}${opts.go ? ' go' : ''}${opts.quiet ? ' quiet' : ''}`, type: 'button', disabled: !!opts.disabled, onclick: opts.onclick, 'data-act': opts.act, title: opts.title }, ...kids, label);
const short = (s, n = 90) => { const t = plainWaits(s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

const SVC = {
  instagram: '<rect x="3.5" y="3.5" width="17" height="17" rx="5"/><circle cx="12" cy="12" r="4"/><path d="M17 7v.01"/>',
  facebook: '<circle cx="12" cy="12" r="9"/><path d="M13.5 20v-7h2.3l.4-2.7h-2.7V8.6c0-.8.3-1.3 1.4-1.3h1.4V4.9c-.3 0-1.1-.1-2-.1-2 0-3.4 1.2-3.4 3.4v2.1H8.6V13h2.3v7"/>',
  youtube: '<rect x="2.5" y="6" width="19" height="12" rx="3.5"/><path d="M10 9.5v5l4.3-2.5z"/>',
  tiktok: '<path d="M14 4v10.2a3.2 3.2 0 1 1-3.2-3.2M14 4c.3 2.4 1.9 3.8 4.2 4"/>',
  linkedin: '<rect x="3.5" y="3.5" width="17" height="17" rx="2.5"/><path d="M8 10.5V16M8 7.8v.01M11.5 16v-3.2c0-1.4 1-2.3 2.2-2.3s2.1.8 2.1 2.3V16M11.5 10.5V16"/>',
  x: '<path d="M5 5l14 14M19 5L5 19"/>',
  threads: '<path d="M16.5 10.5c-.6-2.2-2.2-3.5-4.5-3.5-3 0-4.8 2.3-4.8 5s1.9 5 4.8 5c2.5 0 4.2-1.4 4.2-3.3 0-1.7-1.5-2.7-3.6-2.7-1.6 0-2.6.7-2.6 1.7s.8 1.6 1.9 1.6c1.7 0 2.4-1.3 2.4-3.3"/>',
  pinterest: '<circle cx="12" cy="12" r="9"/><path d="M11 15.5l1.6-7M10 17l.9-3.6"/>',
};
/** A small line glyph for an account's service (Instagram, Facebook...). */
export function serviceIcon(service, size = 15) {
  const s = h('span', { class: `svc svc-${service}`, 'aria-hidden': 'true', title: service });
  s.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${SVC[service] ?? '<circle cx="12" cy="12" r="4"/>'}</svg>`;
  return s;
}
const SERVICE_NAME = { instagram: 'Instagram', facebook: 'Facebook', youtube: 'YouTube', tiktok: 'TikTok', linkedin: 'LinkedIn', x: 'X', threads: 'Threads', pinterest: 'Pinterest' };

// ---- what the server says about adapters, accounts and brands ---------------------------------------------------------------------------

export const pub = { adapters: [], loaded: false, auto: null };
const getAdapters = async () => (await api.get('/publish/adapters')).adapters;

export async function loadPublish() {
  try { pub.adapters = await getAdapters(); pub.loaded = true; update(); } catch { /* publishing is optional: the Studio works without it */ }
  try { pub.auto = await api.get('/publish/auto-schedule'); autoChanged(); update(); } catch { pub.auto = null; }
}

/** A Buffer sign-in that finishes while the Publishing window is closed: say so, and pick up the new account. (The window sets its own handler while it is open.) */
const signedInWhileClosed = async (r) => {
  notify(r.ok ? 'Signed in with Buffer. Open Publishing to choose which brand uses it.' : `Signed in with Buffer, but ${short(r.message ?? 'Nordle could not reach Buffer with it', 140)}`, { kind: r.ok ? 'ok' : 'error', ms: 9000 });
  await loadPublish();
};
setSignInSink(signedInWhileClosed);

/** Cheap (local files on the server): what automatic scheduling did lately and what it could not send. Re-draws only when something changed. */
export async function refreshAuto() {
  try {
    const next = await api.get('/publish/auto-schedule');
    if (JSON.stringify(next) !== JSON.stringify(pub.auto)) { pub.auto = next; autoChanged(); update(); }
  } catch { /* the note simply stays as it was */ }
}

const dayLabel = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
const minusDays = (iso, n) => { const d = new Date(`${iso}T12:00:00`); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };

/**
 * One line under an approved post that is not scheduled yet: when Nordle will put it in Buffer by itself (or why it could not, or how to
 * turn that on). Null when it does not apply (no calendar date, nothing to say yet).
 */
export function autoNote(post) {
  const wrap = h('div', { class: 'auto-wrap' });
  const paint = () => wrap.replaceChildren(...[noteFor(post)].filter(Boolean));
  // it repaints itself when the setting changes (the switch lives in a window that can open over the sheet)
  const on = () => { if (!wrap.isConnected) document.removeEventListener(AUTO_EVENT, on); else paint(); };
  document.addEventListener(AUTO_EVENT, on);
  paint();
  return wrap;
}
const AUTO_EVENT = 'nordle-auto';
const autoChanged = () => document.dispatchEvent(new Event(AUTO_EVENT));

function noteFor(post) {
  const au = pub.auto;
  if (!au || !post.calendar || !post.date) return null;
  const problem = (au.problems ?? []).find((x) => x.uid === post.uid);
  if (!au.enabled) {
    return h('p', { class: 'auto-note muted', 'data-state': 'off' }, 'Automatic scheduling is off. ', h('button', { class: 'linklike', type: 'button', 'data-act': 'auto-open', onclick: () => openConnect('buffer') }, 'Turn it on'));
  }
  if (problem) return h('p', { class: 'auto-note bad', 'data-state': 'problem', role: 'status' }, `Automatic scheduling could not send this${problem.stopped ? ' and has stopped trying' : ''}: ${short(problem.message, 160)}`);
  const from = minusDays(post.date, au.daysAhead);
  const soon = from <= S.today;
  return h('p', { class: 'auto-note muted', 'data-state': soon ? 'soon' : 'later' }, soon ? 'Goes to Buffer by itself within minutes.' : `Goes to Buffer by itself on ${dayLabel(from)}, ${plural(au.daysAhead, 'day')} before.`);
}

/** Each brand's saved accounts for an adapter: [{id, name?, service?, formats?, enabled?, offsetMinutes?, hashtags?}]. Older servers kept one id per brand. */
export function mappingsOf(a) {
  if (a?.brands) return a.brands;
  return Object.fromEntries(Object.entries(a?.selected ?? {}).map(([p, id]) => [p, id ? [{ id }] : []]));
}
/** The accounts a brand posts to (null until we know). */
export function accountsOf(projectId, adapterId = 'buffer') {
  const a = pub.adapters.find((x) => x.id === adapterId);
  return pub.loaded && a ? brandMapping(a, projectId).channels : null;
}
const chanOf = (it) => (it.channel && typeof it.channel === 'object' ? it.channel : it.channel ? { id: it.channel, name: it.channelName ?? it.channel } : null);
const alreadyDone = (it) => !!it && (it.blockerCodes ?? []).includes('already-scheduled-channel');
const resultChan = (r) => (r.channel && typeof r.channel === 'object' ? r.channel.id : r.channel ?? '');
const mediaBase = (a) => a?.mediaBaseUrl ?? a?.options?.mediaBaseUrl ?? '';
const accountLabel = (c) => (c ? `${c.name ?? c.id}${c.service && !String(c.name ?? '').toLowerCase().includes(c.service) ? ` (${SERVICE_NAME[c.service] ?? c.service})` : ''}` : 'Export folder');

// ---- the Schedule dialog --------------------------------------------------------------------------------------------------------------------

/** `onScheduled` runs once everything asked for has gone (the window then closes by itself): the post sheet uses it to get out of the way. */
export async function openSchedule(uids, { onScheduled } = {}) {
  const posts = uids.map((u) => S.byUid.get(u)).filter(Boolean);
  if (!posts.length) { notify('Pick some posts first.', { kind: 'info' }); return; }
  const m = modal(posts.length === 1 ? 'Schedule this post' : `Schedule ${posts.length} posts`);
  const st = { adapters: [], adapter: null, plan: null, error: '', busy: false, include: new Set(), results: null, loadingPlan: false, off: new Map(), known: new Map(), only: null, times: new Map(), stories: new Set(), checking: null, checkNote: '', remote: new Map(), remoteBusy: false, remoteNote: '', best: new Map(), coverBusy: new Set() };
  const adapter = () => st.adapters.find((a) => a.id === st.adapter);

  /** Make (or remake) the plan. `only` limits it to some uid+account pairs (a retry); switched-off accounts are left out. */
  async function plan({ only = st.only, keepOff = false } = {}) {
    st.error = ''; st.loadingPlan = true; st.results = null; st.only = only;
    if (!keepOff) { st.off = new Map(); st.known = new Map(); }
    draw();
    const body = { adapter: st.adapter, uids: only ? Object.keys(only) : uids };
    const channels = {};
    for (const uid of body.uids) {
      const allowed = only ? only[uid] : st.known.get(uid)?.map((c) => c.id).filter((id) => !st.off.get(uid)?.has(id));
      if (allowed && (only || st.off.get(uid)?.size)) channels[uid] = allowed;
    }
    if (Object.keys(channels).length) body.channels = channels;
    const times = Object.fromEntries([...st.times].filter(([uid]) => body.uids.includes(uid)));
    if (Object.keys(times).length) body.times = times;
    // a Story of each post is the default (untick it per post); only where the destination can make Stories
    const stories = adapter()?.stories ? [...st.stories].filter((u) => body.uids.includes(u)) : [];
    if (stories.length) body.stories = stories;
    try {
      st.plan = await api.post('/publish/plan', body);
      for (const it of st.plan.items) {
        const c = chanOf(it);
        const list = st.known.get(it.uid) ?? [];
        if (c && !list.some((x) => x.id === c.id)) list.push(c);
        st.known.set(it.uid, list);
      }
    } catch (e) { st.plan = null; st.error = e.message; }
    st.loadingPlan = false; draw();
  }

  function toggleAccount(uid, id, on) {
    const set = st.off.get(uid) ?? new Set();
    if (on) set.delete(id); else set.add(id);
    st.off.set(uid, set);
    plan({ only: null, keepOff: true });
  }

  const replan = () => plan({ only: st.only, keepOff: true });
  const localInput = (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  const clock = (d) => d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, ' ');
  const dayWord = (d) => {
    const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate())) / 86400000);
    return days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
  };
  /** A few ready-made times that are still ahead, on the owner's own clock: this evening, tomorrow morning, tomorrow evening. */
  function quickTimes() {
    const out = [];
    const soon = Date.now() + 15 * 60000;
    for (const [add, hh, mm] of [[0, 12, 0], [0, 18, 0], [0, 19, 30], [1, 9, 0], [1, 12, 0], [1, 18, 0]]) {
      const d = new Date(); d.setDate(d.getDate() + add); d.setHours(hh, mm, 0, 0);
      if (d.getTime() > soon) out.push({ iso: d.toISOString(), label: `${dayWord(d)} ${clock(d)}` });
    }
    return out.slice(0, 4);
  }
  const dateOf = (iso) => { const d = new Date(iso); const p = (n) => String(n).padStart(2, '0'); return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
  const timeOf = (iso) => { const d = new Date(iso); const p = (n) => String(n).padStart(2, '0'); return Number.isNaN(d.getTime()) ? '' : `${p(d.getHours())}:${p(d.getMinutes())}`; };

  /**
   * When this post goes, in one row of choices: its planned time, as soon as possible, a ready-made time, or a day and time of the owner's own.
   * For this run only: the calendar keeps its time. With several posts, "Same for all" copies the choice to every one of them.
   */
  function whenControl(uid, items) {
    if (items.length && items.every(alreadyDone)) return null;
    const quick = quickTimes().slice(0, 1);   // one ready-made time is enough: anything else is "Pick a day and time"
    const best = (st.best.get(S.byUid.get(uid)?.project) ?? []).slice(0, 1);   // the brand's own best time (Insights > When to post)
    const cur = st.times.get(uid);
    const custom = !!cur && cur !== 'now' && ![...best, ...quick].some((q) => q.iso === cur);
    const mode = !cur ? 'planned' : cur === 'now' ? 'now' : custom ? 'custom' : 'quick';
    const plannedLabel = items.find((it) => it.whenLocal)?.whenLocal;
    const set = (v) => { if (v == null) st.times.delete(uid); else st.times.set(uid, v); replan(); };
    const chip = (label, on, act, onclick, title) => h('button', { class: `tchip${on ? ' on' : ''}`, type: 'button', 'aria-pressed': String(on), 'data-act': act, title, onclick }, label);
    const startCustom = () => {
      const planned = items.find((it) => it.when)?.when;
      set(planned && Date.parse(planned) > Date.now() + 15 * 60000 ? planned : new Date(Math.ceil((Date.now() + 3600000) / 900000) * 900000).toISOString());
    };
    const dateIn = h('input', { class: 'field sch-time-d', type: 'date', value: custom ? dateOf(cur) : '', min: dateOf(new Date().toISOString()), 'aria-label': 'Day to post', 'data-field': `time-day-${uid}` });
    const timeIn = h('input', { class: 'field sch-time-t', type: 'time', step: '300', value: custom ? timeOf(cur) : '', 'aria-label': 'Time to post', 'data-field': `time-at-${uid}` });
    const apply = () => {
      if (!dateIn.value || !timeIn.value) return;
      const t = new Date(`${dateIn.value}T${timeIn.value}`);
      if (!Number.isNaN(t.getTime())) set(t.toISOString());
    };
    dateIn.addEventListener('change', apply);
    timeIn.addEventListener('change', apply);
    const picked = cur && cur !== 'now' ? new Date(cur) : null;
    return h('div', { class: 'sch-time', dataset: { mode } },
      h('div', { class: 'tchips', role: 'group', 'aria-label': `When to post ${S.byUid.get(uid)?.title ?? ''}`.trim() },
        chip(plannedLabel ? `Planned · ${plannedLabel.replace(/\s*\(.*\)$/, '').replace(/\s20\d\d(?=,)/, '')}` : 'Planned time', mode === 'planned', 'time-planned', () => set(null), 'The date and time on the calendar'),
        chip('As soon as possible', mode === 'now', 'time-now', () => set('now'), 'About 10 minutes from now: the soonest Buffer is asked for'),
        ...best.map((b) => chip(`Best · ${b.label}`, cur === b.iso, 'time-best', () => set(b.iso), `${b.reason} Worked out from this brand's own posts in Buffer.`)),
        ...quick.map((q) => chip(q.label, cur === q.iso, 'time-quick', () => set(q.iso))),
        chip('Pick a day…', mode === 'custom', 'time-custom', startCustom, 'Choose any day and time')),
      mode === 'custom' ? h('div', { class: 'sch-time-pick' }, dateIn, timeIn,
        picked && !Number.isNaN(picked.getTime()) ? h('span', { class: 'muted' }, `${dayWord(picked)} ${clock(picked)}`) : null) : null,
      // only this run changes: the calendar keeps its own time (said once, in the chip's tooltip, and only here when there are several posts)
      mode !== 'planned' && uids.length > 1 ? h('span', { class: 'sch-time-note muted' }, h('button', { class: 'linklike', type: 'button', 'data-act': 'time-all', onclick: () => { for (const u of uids) st.times.set(u, cur); replan(); } }, 'Same for all posts')) : null);
  }

  const mmss = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
  /** A reel's cover: who chose it and which frame, with "Choose…" (the best few frames, or any moment) and "Pick the best for me". Nothing chosen = picked automatically on Schedule. */
  function coverControl(uid, items) {
    const it = items.find((x) => x.cover && x.variant !== 'story');
    if (!it || alreadyDone(it)) return null;
    const c = it.cover;
    const say = c.source === 'chosen' ? `Frame at ${mmss(c.time)}` : c.source === 'auto' ? `Frame at ${mmss(c.time)}, picked for you` : c.source === 'designer' ? `Frame at ${mmss(c.time)}` : 'Picked for you when you schedule';
    const busy = st.coverBusy.has(uid);
    const autoPick = async () => {
      st.coverBusy.add(uid); draw();
      try { const r = await api.post('/studio/cover', { uid, auto: true }); notify(`Cover picked: the frame at ${mmss(r.time)}.`, { kind: 'ok' }); } catch (e) { notify(e.message, { kind: 'error' }); }
      st.coverBusy.delete(uid); await replan();
    };
    return h('div', { class: 'sch-cover', dataset: { source: c.source } },
      h('span', { class: 'lbl-i' }, 'Cover'), h('span', { class: 'sch-cover-say' }, busy ? 'Looking for the best frame…' : say),
      btn('Change', { quiet: true, act: 'cover-choose', disabled: busy, onclick: async () => { const post = S.byUid.get(uid); if (post && await openCoverPicker(post)) await replan(); } }),
      btn('Best frame', { quiet: true, act: 'cover-auto', disabled: busy, title: 'Let Nordle pick the best frame', onclick: autoPick }));
  }

  /** "Also add to Stories": the same post again as a Story on each Instagram and Facebook channel, at the same moment. */
  function storyControl(uid, items) {
    if (!adapter()?.stories || (items.length && items.every(alreadyDone))) return null;
    const on = st.stories.has(uid);
    const isReel = items.some((it) => it.format === 'reel');
    return h('label', { class: 'sch-story' },
      h('input', { type: 'checkbox', checked: on, 'aria-label': `Also add ${S.byUid.get(uid)?.title ?? 'this post'} to Stories`, 'data-field': `story-${uid}`, onchange: (e) => { if (e.target.checked) st.stories.add(uid); else st.stories.delete(uid); replan(); } }),
      h('span', { title: isReel ? 'The video, shared again as a Story' : 'The first picture, as a Story' }, 'Also add to Stories'));
  }

  /** Run the automatic checks again on every post in this window (the pictures, words and facts as they are now), then make the plan again. */
  async function recheck() {
    const seen = new Map();
    for (const uid of uids) { const p = S.byUid.get(uid); if (p?.docId && p.project && !p.external && !seen.has(`${p.project}/${p.docId}`)) seen.set(`${p.project}/${p.docId}`, p); }
    const targets = [...seen.values()];
    if (!targets.length) { st.checkNote = 'None of these posts has a document to check.'; draw(); return; }
    st.checking = { done: 0, total: targets.length }; st.checkNote = ''; draw();
    let failing = 0, broken = 0;
    for (const p of targets) {
      try { const r = await api.post(`/projects/${encodeURIComponent(p.project)}/checks/${encodeURIComponent(p.docId)}`, {}); if (!r.ok) failing++; } catch { broken++; }
      st.checking.done++; draw();
    }
    st.checking = null;
    st.checkNote = `Checked ${plural(targets.length, 'post')}: ${failing ? `${failing} failing` : 'none failing'}${broken ? `, ${broken} could not be checked` : ''}.`;
    try { await load({ force: true }); } catch { /* the plan below says what it can */ }
    await replan();
  }

  /** Posts here that are already scheduled (wholly or in part): the ones that can be looked up in Buffer. */
  const scheduledUids = () => [...new Set((st.plan?.items ?? []).filter((it) => (it.blockerCodes ?? []).some((c) => c.startsWith('already-scheduled'))).map((it) => it.uid))];
  const chanName = (uid, channel) => { const id = String(channel).replace(/#story$/, ''); const c = st.known.get(uid)?.find((k) => k.id === id); return `${c ? accountLabel(c) : id}${/#story$/.test(String(channel)) ? ' · Story' : ''}`; };
  const STATE_WORD = { scheduled: 'in Buffer, waiting for its time', sending: 'being sent now', sent: 'already posted', draft: 'a draft in Buffer', needs_approval: 'waiting for approval in Buffer', error: 'Buffer shows an error', missing: 'not in Buffer any more', unknown: 'could not be confirmed' };

  /** Ask Buffer (read only) whether the scheduled posts here are still there. */
  async function checkBuffer() {
    const list = scheduledUids();
    if (!list.length) { st.remoteNote = 'Nothing here is scheduled in Buffer.'; draw(); return; }
    st.remoteBusy = true; st.remoteNote = ''; draw();
    try {
      const r = await api.post('/publish/check-scheduled', { uids: list });
      st.remote = new Map(r.results.map((x) => [x.uid, x]));
      const gone = r.results.filter((x) => x.missing.length).length;
      st.remoteNote = !r.results.length ? 'None of these is scheduled in Buffer.' : gone ? `${plural(gone, 'post')} no longer in Buffer. Press Reschedule on each, or Reschedule all.` : `All ${plural(r.results.length, 'post')} are still in Buffer.`;
      if (r.incomplete) st.remoteNote += ` (${r.incomplete}, so some could not be confirmed.)`;
    } catch (e) { st.remoteNote = e.message; }
    st.remoteBusy = false; draw();
  }
  /** Take what is gone in Buffer back, so the post can be scheduled again (an old time that has passed becomes "as soon as possible"). */
  async function reschedule(uids2) {
    st.remoteBusy = true; draw();
    let done = 0, failed = '';
    for (const uid of uids2) {
      const r = st.remote.get(uid);
      try {
        const planned = st.plan.items.find((it) => it.uid === uid && it.when)?.when;
        await api.post('/publish/unschedule', { uid, channels: r?.missing });
        st.remote.delete(uid);
        if (planned && Date.parse(planned) < Date.now() + 15 * 60000 && !st.times.has(uid)) st.times.set(uid, 'now');
        done++;
      } catch (e) { failed = e.message; }
    }
    try { await load({ force: true }); } catch { /* the plan below says what it can */ }
    st.remoteNote = failed ? `${plural(done, 'post')} taken back. ${failed}` : `${plural(done, 'post')} taken back. Check the time below and schedule ${done === 1 ? 'it' : 'them'} again.`;
    st.remoteBusy = false;
    await replan();
  }

  function tools() {
    if (!st.plan && !st.checking) return null;
    const gone = [...st.remote.values()].filter((x) => x.missing.length).map((x) => x.uid);
    return h('div', { class: 'sch-tools' },
      btn(st.checking ? `Checking ${st.checking.done + 1} of ${st.checking.total}…` : 'Re-check', { quiet: true, act: 'schedule-recheck', title: 'Check the pictures, words and facts again on every post here, then make the plan again', disabled: !!st.checking || st.busy || st.loadingPlan, onclick: recheck }, icon('check', 14)),
      scheduledUids().length ? btn(st.remoteBusy ? 'Asking Buffer…' : 'Check what is still in Buffer', { quiet: true, act: 'schedule-remote', disabled: st.remoteBusy || st.busy || st.loadingPlan, onclick: checkBuffer }, icon('calendarSend', 14)) : null,
      gone.length > 1 ? btn(`Reschedule all ${gone.length}`, { act: 'reschedule-all', disabled: st.remoteBusy, onclick: () => reschedule(gone) }) : null,
      (st.remoteNote || st.checkNote) ? h('span', { class: 'muted' }, st.remoteNote || st.checkNote) : null);
  }

  function destination() {
    // two plain choices side by side; the long explanation lives in the tooltip, not on the screen
    return h('fieldset', { class: 'sch-dest' }, h('legend', { class: 'lbl' }, 'Send to'),
      st.adapters.map((a) => h('label', { class: `sch-opt${a.id === st.adapter ? ' on' : ''}`, title: a.note || (a.needs?.length ? `Needs: ${a.needs.join('; ')}` : '') },
        h('input', { type: 'radio', name: 'dest', value: a.id, checked: a.id === st.adapter, onchange: () => { st.adapter = a.id; plan({ only: null }); } }),
        h('span', { class: 'sch-opt-t' }, h('b', {}, a.id === 'bundle' ? 'Export folder' : a.name), h('span', { class: `sch-conn ${a.configured ? 'ok' : ''}` }, a.configured ? '' : 'Set up needed')))));
  }

  const useExport = () => { st.adapter = st.adapters.find((x) => x.id === 'bundle')?.id ?? st.adapter; plan({ only: null }); };
  const reconnect = async () => { await openConnect('buffer'); st.adapters = await getAdapters(); pub.adapters = st.adapters; plan({ only: null }); };

  function notice() {
    const a = adapter();
    if (!a) return null;
    if (a.id === 'buffer' && !a.configured) {
      return h('div', { class: 'sch-note warn' }, h('p', {}, 'Buffer is not connected yet.'),
        h('div', { class: 'sch-note-acts' }, btn('Connect Buffer…', { onclick: reconnect }, icon('calendarSend', 14)), btn('Use the export folder instead', { onclick: useExport })));
    }
    if (a.id === 'buffer' && !mediaBase(a)) {
      return h('div', { class: 'sch-note warn' }, h('p', {}, 'Buffer needs somewhere public to read your pictures and videos from (a public web address).'),
        h('div', { class: 'sch-note-acts' }, btn('Set up media hosting…', { onclick: reconnect }), btn('Use the export folder instead', { onclick: useExport })));
    }
    if (a.id === 'bundle') return h('div', { class: 'sch-note' }, h('p', { class: 'muted' }, 'Writes each post to a folder on this computer. Nothing is sent anywhere.'));
    return null;
  }

  /** What Buffer said about a scheduled post: where it stands on each channel, and Reschedule for the ones that are gone. */
  function remoteBlock(uid) {
    const r = st.remote.get(uid);
    if (!r) return null;
    return h('div', { class: `sch-remote${r.missing.length ? ' gone' : ''}`, dataset: { uid } },
      r.targets.map((t) => h('span', { class: `rt rt-${t.state}` }, `${chanName(uid, t.channel)}: ${STATE_WORD[t.state] ?? t.state}`)),
      r.missing.length ? btn(st.remoteBusy ? 'Working…' : 'Reschedule', { act: 'reschedule', disabled: st.remoteBusy, onclick: () => reschedule([uid]) }) : null);
  }

  /** One post: its words, and one line per account it will go to. */
  function postRow(uid) {
    const items = st.plan.items.filter((it) => it.uid === uid);
    const first = items[0];
    const post = S.byUid.get(uid);
    const accounts = st.known.get(uid) ?? [];
    const lines = accounts.length ? accounts : [null];
    const blockedAll = items.length && items.every((it) => !it.ready && !alreadyDone(it));
    return h('div', { class: `sch-row${blockedAll ? ' blocked' : ''}`, role: 'group', 'aria-label': first?.title ?? post?.title, dataset: { uid } },
      h('div', { class: 'sch-post' }, h('b', {}, first?.title ?? post?.title ?? uid), uids.length > 1 ? h('span', { class: 'sch-brand muted' }, brandName(post?.project ?? first?.project)) : null,
        h('span', { class: 'sch-cap' }, short(first?.caption, 70) || 'No caption'),
        (() => { const ws = [...new Set(items.flatMap((it) => it.warnings ?? []))]; return ws.length ? h('span', { class: 'sch-warn', title: ws.join('\n\n') }, icon('info', 13), plural(ws.length, 'note'), ' · hover to read') : null; })()),
      whenControl(uid, items),
      storyControl(uid, items),
      // a video over 100 MB is not made into a Story: said in plain words on the post, not hidden in a tooltip
      (() => { const why = items.find((it) => it.storySkipped)?.storySkipped; return why ? h('p', { class: 'sch-story-skip', 'data-state': 'story-skipped', role: 'status' }, icon('info', 14), why) : null; })(),
      coverControl(uid, items),
      remoteBlock(uid),
      h('div', { class: 'sch-accts' }, lines.flatMap((c) => {
        const storyIt = items.find((x) => x.variant === 'story' && (chanOf(x)?.id ?? null) === (c?.id ?? null));
        const it = items.find((x) => x.variant !== 'story' && (chanOf(x)?.id ?? null) === (c?.id ?? null));
        const off = c && st.off.get(uid)?.has(c.id);
        const blockers = it?.blockers ?? [];
        const done = alreadyDone(it);   // an earlier run already sent this one: shown as done, not as a problem
        const feed = h('div', { class: `sch-acct${off ? ' off' : ''}${it && !it.ready && !done ? ' bad' : ''}${done ? ' done' : ''}`, dataset: { channel: c?.id ?? '' } },
          c ? h('label', { class: 'sch-chip', title: done ? 'Already scheduled' : off ? 'Switched off for this run' : 'Click to leave this account out of this run' },
            h('input', { type: 'checkbox', checked: done || !off, disabled: done, 'aria-label': `Post to ${accountLabel(c)}`, onchange: (e) => toggleAccount(uid, c.id, e.target.checked) }), serviceIcon(c.service), h('span', {}, accountLabel(c)), it?.accountLabel ?? it?.account?.label ? h('span', { class: 'sch-acctl muted' }, it.accountLabel ?? it.account.label) : null)
            : h('span', { class: 'sch-chip static' }, accountLabel(null)),
          // the time is said once, in the row of choices above; an account only repeats it when it goes at a different time
          h('span', { class: 'sch-when', title: it?.whenLocal ?? '' }, off || done || !it?.whenLocal || it.whenLocal === first?.whenLocal ? '' : it.whenLocal.replace(/\s*\(.*\)$/, '').replace(/\s20\d\d(?=,)/, '')),
          h('span', { class: 'sch-state' }, off ? h('span', { class: 'muted' }, 'Left out') : !it ? null
            : done ? h('span', { class: 'st st-stamp', title: 'An earlier run sent this one; it will not be sent again.' }, h('i', { class: 'mk mk-signed' }), 'Already scheduled')
            : it.ready ? h('span', { class: 'st st-stamp' }, h('i', { class: 'mk mk-signed' }), 'Ready')
              : [h('span', { class: 'st st-proof' }, h('i', { class: 'mk mk-built' }), 'Blocked'),
                ...blockers.slice(0, 2).map((b) => h('span', { class: 'sch-block' }, b)), blockers.length > 2 ? h('span', { class: 'sch-block muted', title: blockers.slice(2).join(' ') }, `and ${blockers.length - 2} more`) : null,
                blockers.some((b) => /channel|account/i.test(b)) && !c ? btn('Connect an account', { quiet: true, onclick: reconnect }) : null]));
        // the Story of the same post on the same channel, when one was asked for
        const sDone = alreadyDone(storyIt);
        // a Story that is ready needs no line of its own: it shows as "+ Story" on its account. Only a blocked or finished one is spelled out.
        if (storyIt && !off && storyIt.ready && !sDone) { feed.querySelector('.sch-chip')?.append(h('span', { class: 'sch-plus-story', title: 'A Story of this post goes out too' }, '+ Story')); return [feed]; }
        const storyLine = storyIt && !off ? h('div', { class: `sch-acct sch-story-line${!storyIt.ready && !sDone ? ' bad' : ''}${sDone ? ' done' : ''}`, dataset: { channel: c?.id ?? '', variant: 'story' } },
          h('span', { class: 'sch-chip static' }, serviceIcon(c?.service), h('span', {}, 'Story')),
          h('span', { class: 'sch-when' }, sDone ? '' : storyIt.whenLocal ?? ''),
          h('span', { class: 'sch-state' }, sDone ? h('span', { class: 'st st-stamp' }, h('i', { class: 'mk mk-signed' }), 'Already scheduled')
            : storyIt.ready ? h('span', { class: 'st st-stamp' }, h('i', { class: 'mk mk-signed' }), 'Ready')
              : [h('span', { class: 'st st-proof' }, h('i', { class: 'mk mk-built' }), 'Blocked'), ...(storyIt.blockers ?? []).slice(0, 2).map((b) => h('span', { class: 'sch-block' }, b))])) : null;
        return [feed, storyLine];
      })),
      items.some((it) => it.overridable && !it.ready) ? h('label', { class: 'sch-over' }, h('input', { type: 'checkbox', checked: st.include.has(uid), onchange: (e) => { if (e.target.checked) st.include.add(uid); else st.include.delete(uid); draw(); } }), 'Include anyway, I have looked at it') : null);
  }

  const goes = (it) => it.ready || st.include.has(it.uid);
  function table() {
    if (st.loadingPlan) return h('p', { class: 'muted sch-load' }, 'Making the plan…');
    if (st.error) return h('div', { class: 'sch-note bad' }, h('p', {}, st.error), btn('Try again', { onclick: () => plan({ only: null }) }));
    if (!st.plan) return null;
    const order = [...new Set(st.plan.items.map((it) => it.uid))];
    const brands = [...new Set(order.map((uid) => S.byUid.get(uid)?.project ?? st.plan.items.find((it) => it.uid === uid)?.project))];
    return h('div', { class: 'sch-table', role: 'list', 'aria-label': 'The plan' }, brands.map((pid) => {
      const acct = adapter()?.id === 'buffer' ? accountFor(adapter(), pid) : null;
      const p = S.projects.find((x) => x.id === pid);
      return h('section', { class: 'sch-brand-group', dataset: { project: pid } },
        brands.length === 1 && order.length === 1 && acct ? null : h('h3', { class: 'sch-bg' }, h('i', { class: 'tick', style: { '--lane': p?.color } }), ` ${brandName(pid)}`,
          adapter()?.id === 'buffer' ? (acct ? h('span', { class: 'sch-via' }, 'through ', h('b', {}, acct.label)) : h('span', { class: 'sch-via none' }, `Connect a Buffer account for ${brandName(pid)}`, ' ', btn('Connect…', { quiet: true, onclick: reconnect }))) : null),
        order.filter((uid) => (S.byUid.get(uid)?.project ?? st.plan.items.find((it) => it.uid === uid)?.project) === pid).map(postRow));
    }));
  }

  function summary() {
    if (!st.plan || st.loadingPlan) return null;
    const a = adapter();
    const going = st.plan.items.filter(goes);
    const postsN = new Set(going.map((it) => it.uid)).size;
    const accountsN = new Set(going.map((it) => chanOf(it)?.id).filter(Boolean)).size;
    const left = new Set(st.plan.items.filter((it) => !alreadyDone(it)).map((it) => it.uid)).size - postsN;
    if (!going.length) return h('p', { class: 'sch-sum' }, 'Nothing can go yet. Only approved posts can be scheduled: approve them, or fix what is blocking them.');
    // each post to each channel is one request: say so when that is most of what Buffer has left today
    const al = a?.id === 'buffer' ? (a.accounts ?? []).map((x) => x.allowance?.windows?.['1day']).filter((d) => Number.isFinite(d?.left)).sort((x, y) => x.left - y.left)[0] : null;
    const needs = going.length;
    const tight = al && needs > al.left * 0.5;
    const where = a?.id === 'bundle' ? 'to a folder' : accountsN > 1 ? `to ${accountsN} accounts` : `to ${a?.name ?? 'the destination'}`;
    // Buffer's request allowance only gets a line when it is nearly used up; otherwise it is out of the way
    return h('div', {}, h('p', { class: 'sch-sum' }, `${a?.id === 'bundle' ? 'Export' : 'Schedule'} ${plural(postsN, 'post')} ${where}. Nothing is sent until you press the button.${left > 0 ? ` ${plural(left, 'post')} left out.` : ''}`),
      al && tight ? h('p', { class: 'sch-allow muted tight', role: 'alert' }, `Buffer has ${al.left} of ${al.limit} requests left today (full again at ${new Date(al.resetsAt).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' })}), and this needs ${needs}.${needs > al.left ? ' Buffer will stop part-way; the rest can go later.' : ''}`) : null);
  }

  function resultsView() {
    const r = st.results;
    const byUid = new Map();
    for (const x of r.results) byUid.set(x.uid, [...(byUid.get(x.uid) ?? []), x]);
    return h('div', {},
      h('p', { class: 'sch-sum' }, r.stopped ? `Stopped: ${r.stopped}` : 'Done.'),
      h('ul', { class: 'sch-results' }, [...byUid].map(([uid, list]) => {
        const okN = list.filter((x) => x.ok).length;
        return h('li', { class: `sch-res ${okN === list.length ? 'ok' : okN ? 'part' : 'bad'}`, dataset: { uid } },
          h('div', { class: 'sch-res-h' }, h('i', { class: `mk ${okN === list.length ? 'mk-signed' : 'mk-built'}` }), h('b', {}, S.byUid.get(uid)?.title ?? uid),
            list.length > 1 ? h('span', { class: 'muted' }, okN === list.length ? `Scheduled on all ${list.length} accounts` : `Scheduled on ${okN} of ${list.length} accounts`) : null),
          list.map((x) => {
            const c = st.known.get(uid)?.find((k) => k.id === resultChan(x));
            return h('div', { class: `sch-res-l ${x.ok ? 'ok' : 'bad'}`, dataset: { channel: resultChan(x) } }, c ? serviceIcon(c.service) : null, h('span', { class: 'sch-res-n' }, `${c ? accountLabel(c) : adapter()?.name ?? ''}${String(x.key ?? '').endsWith('#story') ? ' · Story' : ''}`), h('span', {}, plainWaits(x.message) || (x.ok ? 'Scheduled.' : 'Not scheduled.')));
          }));
      })));
  }

  async function run() {
    const going = st.plan.items.filter(goes);
    // one entry per post per account ("<uid>#<channel>"; just the uid when the plan has no channel, e.g. the export folder)
    const only = [...new Set(going.map((it) => it.key ?? it.uid))];
    st.busy = true; draw();
    try {
      st.results = await api.post('/publish/run', { planId: st.plan.planId, only, override: Object.fromEntries([...st.include].map((u) => [u, true])) });
      await load({ force: true });
      const okN = st.results.results.filter((r) => r.ok).length;
      const badN = st.results.results.length - okN;
      notify(`${plural(okN, 'post')} ${adapter()?.id === 'bundle' ? 'exported' : 'scheduled'}${badN ? `, ${badN} did not go` : ''}.`, { kind: okN ? 'ok' : 'error' });
      // all gone: nothing more to look at here, so back to the calendar (a failure keeps this window open to read it and retry)
      // (an export keeps its list: it says where the files went)
      if (okN && !badN && adapter()?.id !== 'bundle') { st.busy = false; m.close(); onScheduled?.(); return; }
    } catch (e) { st.error = e.message; }
    st.busy = false; draw();
  }

  /** Only what failed: the same posts, only the accounts that did not take them. */
  function retry() {
    const only = {};
    for (const r of st.results.results) if (!r.ok && resultChan(r)) (only[r.uid] ??= []).push(resultChan(r));
    st.include = new Set();
    plan({ only });
  }

  function draw() {
    const a = adapter();
    const blockedMedia = a?.id === 'buffer' && (!a.configured || !mediaBase(a));
    const going = st.plan ? st.plan.items.filter(goes) : [];
    const failed = st.results ? st.results.results.filter((r) => !r.ok && resultChan(r)).length : 0;
    m.body.replaceChildren(...[st.results ? resultsView() : [destination(), notice(), tools(), table(), summary()]].flat(Infinity).filter(Boolean));
    const label = `${a?.id === 'bundle' ? 'Export' : 'Schedule'} ${plural(new Set(going.map((it) => it.uid)).size, 'post')}`;
    m.foot.replaceChildren(...[
      btn(st.results ? 'Close' : 'Cancel', { onclick: m.close }),
      st.results && failed ? btn(`Retry the ${failed} that failed`, { act: 'schedule-retry', onclick: retry }) : null,
      st.results ? null : btn(st.busy ? 'Sending…' : label, { go: true, act: 'schedule-run', disabled: st.busy || !going.length || blockedMedia || st.loadingPlan || !!st.checking, onclick: run })].filter(Boolean));
  }

  try {
    st.adapters = await getAdapters();
    pub.adapters = st.adapters; pub.loaded = true;
    st.adapter = (st.adapters.find((a) => a.id === 'buffer' && a.configured && mediaBase(a)) ?? st.adapters.find((a) => a.id === 'bundle') ?? st.adapters[0])?.id;
    if (adapter()?.stories) for (const u of uids) st.stories.add(u);          // Stories go with every post unless this tick is taken off
    await Promise.all([...new Set(posts.map((p) => p.project))].map(async (pid) => { try { const r = await api.get(`/publish/best-times?project=${encodeURIComponent(pid)}&count=3`); if (r.suggestions?.length) st.best.set(pid, r.suggestions); } catch { /* no history yet: no best times */ } }));
    draw();
    await plan({ only: null });
  } catch (e) { st.error = e.message; draw(); }
}

// ---- one-click scheduling ---------------------------------------------------------------------------------------------------------------

/** Can a post be scheduled in one click? Buffer connected with somewhere public for the files. */
export const quickReady = () => pub.adapters.some((a) => a.id === 'buffer' && a.configured && mediaBase(a));
const stampOf = (it) => String(it?.whenLocal ?? '').replace(/\s*\(.*\)$/, '').replace(/\s20\d\d(?=,)/, '');

/** Plan one post with its Story: { plan, going, blocked, nowUsed } where a time that has passed or is too close becomes "as soon as possible". */
async function planOne(post, { story = true } = {}) {
  const a = pub.adapters.find((x) => x.id === 'buffer');
  const body = { adapter: 'buffer', uids: [post.uid], ...(story && a?.stories ? { stories: [post.uid] } : {}) };
  let plan = await api.post('/publish/plan', body);
  let nowUsed = false;
  if (plan.items.length && plan.items.every((it) => !it.ready && !alreadyDone(it) && (it.blockerCodes ?? []).length && it.blockerCodes.every((c) => c === 'past'))) {
    plan = await api.post('/publish/plan', { ...body, times: { [post.uid]: 'now' } });
    nowUsed = true;
  }
  return { plan, going: plan.items.filter((it) => it.ready), blocked: plan.items.filter((it) => !it.ready && !alreadyDone(it)), nowUsed };
}

/** What the one-click button will do, in words: "Schedule for Thu 8 Oct, 6:30 pm" (or "now"), or null when it needs the full window. */
export async function quickLabel(post, { story = true } = {}) {
  try {
    const { going, blocked, nowUsed } = await planOne(post, { story });
    if (!going.length || blocked.length) return null;
    return nowUsed ? 'Schedule now' : `Schedule for ${stampOf(going[0])}`;
  } catch { return null; }
}

/**
 * Schedule one post with one click: plan it (with its Story unless `story` is false), and when everything in the plan is ready, send it. If
 * anything needs a person (a blocker, no Buffer yet), the full window opens instead, so nothing is sent half-checked. A time that has passed
 * becomes "as soon as possible". Returns true when something was scheduled.
 */
export async function quickSchedule(post, { story = true, afterAction } = {}) {
  if (!quickReady()) { await openSchedule([post.uid], { onScheduled: afterAction }); return false; }
  let r;
  try {
    const p = await planOne(post, { story });
    if (!p.going.length || p.blocked.length) { await openSchedule([post.uid], { onScheduled: afterAction }); return false; }
    r = await api.post('/publish/run', { planId: p.plan.planId, only: p.going.map((it) => it.key ?? it.uid) });
    const ok = r.results.filter((x) => x.ok), bad = r.results.filter((x) => !x.ok);
    const stories = ok.filter((x) => String(x.key ?? '').endsWith('#story')).length;
    const feeds = ok.length - stories;
    await load({ force: true });
    if (bad.length) notify(`${plural(ok.length, 'post')} scheduled, ${bad.length} did not go: ${bad[0].message}`, { kind: 'error', ms: 14000 });
    else notify(`Scheduled “${short(post.title, 40)}” on ${plural(feeds, 'account')}${stories ? ` and ${plural(stories, 'Story', 'Stories')}` : ''}${p.nowUsed ? ' as soon as possible' : ` for ${stampOf(p.going[0])}`}.${p.plan.items.find((it) => it.storySkipped) ? ' No Story: the video is over 100 MB.' : ''}`, { kind: 'ok', ms: p.plan.items.some((it) => it.storySkipped) ? 14000 : 9000 });
    afterAction?.();
    return ok.length > 0;
  } catch (e) { notify(e.message, { kind: 'error', ms: 12000 }); return false; }
}

// ---- connecting accounts ------------------------------------------------------------------------------------------------------------------

const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'account';

/** The Buffer accounts (separate API keys) of an adapter. An older server has just one key, which we show as one account. */
/** "112 of 250 requests left today" from what Buffer last said (nothing when it has not said, or the day has rolled over). */
export const allowanceText = (al) => { const d = al?.windows?.['1day']; return Number.isFinite(d?.left) ? `${d.left} of ${d.limit} Buffer requests left today` : ''; };
export const bufferAccounts = (a) => (Array.isArray(a?.accounts) ? a.accounts : [{ id: 'default', label: a?.name ?? 'Buffer', configured: !!a?.configured, lastTestedAt: null, channels: a?.channels ?? [] }]);
/** What one brand has saved: which account it publishes through and its channels there. */
export function brandMapping(a, project) {
  const m = a?.brands?.[project];
  if (Array.isArray(m)) return { account: bufferAccounts(a)[0]?.id ?? 'default', channels: m };
  if (m) return { account: m.account ?? null, channels: m.channels ?? [] };
  const legacy = a?.selected?.[project];
  return { account: legacy ? bufferAccounts(a)[0]?.id ?? 'default' : null, channels: legacy ? [{ id: legacy }] : [] };
}
/** The account a brand publishes through (or null): {id, label,...}. */
export function accountFor(a, project) {
  const id = brandMapping(a, project).account;
  return id ? bufferAccounts(a).find((x) => x.id === id) ?? { id, label: id } : null;
}

const squash = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const nameFits = (x, y) => { const p = squash(x), q = squash(y); return p.length >= 4 && q.length >= 4 && (p.includes(q) || q.includes(p)); };
/** Does this login obviously belong to this brand? Its own name, or the name of one of its channels, carries the brand's name (or the reverse). */
export function accountFit(account, project) {
  const channels = (account.channels ?? []).filter((c) => nameFits(c.name, project.name));
  const by = nameFits(account.label, project.name) || nameFits(account.id, project.id) ? 'name' : channels.length ? 'channels' : '';
  return { by, channels };
}
/**
 * For each brand with no login saved: the connected login that plainly belongs to it, when exactly one does. One login and one
 * brand is the other plain case ('only'). With several brands and no name to go by, nothing is guessed. Returns Map(projectId -> { account, why, channels }).
 */
export function suggestAccounts(a, projects) {
  const live = bufferAccounts(a).filter((x) => x.configured);
  const out = new Map();
  for (const p of projects) {
    if (brandMapping(a, p.id).account) continue;
    const fits = live.map((x) => ({ x, ...accountFit(x, p) })).filter((f) => f.by);
    if (fits.length === 1) out.set(p.id, { account: fits[0].x, why: fits[0].by, channels: fits[0].channels });
    else if (!fits.length && live.length === 1 && projects.length === 1) out.set(p.id, { account: live[0], why: 'only', channels: [] });
  }
  return out;
}

/**
 * The accounts of the publishing service, the media address, and which accounts each brand posts to.
 * work[project] = { account, chans: Map(channelId -> {id, name, service, formats:Set|null, offsetMinutes, hashtags, enabled}) }
 */
export async function openConnect(adapterId = 'buffer') {
  let adapters = await getAdapters();
  let a = adapters.find((x) => x.id === adapterId);
  if (!a) { notify('That destination is not available.', { kind: 'error' }); return false; }
  const m = modal('Publishing');
  let message = '';
  let banner = null;      // { ok, title, text }: the big "connected" (or "did not connect") note at the top of this window
  let flash = null;       // the account just connected: its row is highlighted
  let saved = false;
  let work = {};
  const fields = {};
  const multi = () => Array.isArray(a.accounts);

  // ---- saved settings stay folded and read-only until the person chooses to edit them (and is warned what that changes) ----
  const unlocked = new Set();
  let platforms = [];
  const keyInputs = new Map();   // platform id -> its key box
  let chosen = '';   // the platform picked from the list, whose steps and key box are showing
  const WARN = {
    hosting: { title: 'Change the media hosting?', body: 'This is where your pictures and videos are sent when you schedule. Files already uploaded stay in the old bucket, and posts already scheduled in Buffer may still point at it, so do not delete anything there until those posts have gone out.' },
    base: { title: 'Change the media web address?', body: 'Buffer reads each picture and video from this address. Posts already scheduled may still point at the old one, so keep it up until they have gone out.' },
    auto: { title: 'Change automatic scheduling?', body: 'This changes which approved posts are put in Buffer on their own, and how early. Posts already scheduled are not affected.' },
    brand: (p) => ({ title: `Change how ${p.name} publishes?`, body: 'This decides which Buffer account and channels its posts go to. Posts already scheduled stay where they are; only posts you schedule from now on use the new setting.' }),
    platform: (x) => ({ title: `Change the saved ${x.name} key?`, body: `Anything that used the old key will stop using it. Nordle does not post through ${x.name} yet, so no scheduled post is affected.` }),
  };
  async function unlock(key, warn) {
    if (!(await askConfirm({ ...warn, ok: 'Edit it' }))) return;
    unlocked.add(key); draw();
  }
  const relock = (key) => { unlocked.delete(key); draw(); };
  /** A saved setting, folded into one tidy card: a green tick, what it is, what was saved, and an Edit button. */
  const savedCard = ({ key, title, status = 'Saved', lines = [], warn, extra = null }) => h('section', { class: 'saved-card', dataset: { section: key, state: 'saved' } },
    h('div', { class: 'saved-h' }, h('span', { class: 'saved-tick', 'aria-hidden': 'true' }, icon('check', 14)), h('b', {}, title), h('span', { class: 'saved-st' }, status), h('span', { class: 'sp' }), extra,
      btn('Edit', { quiet: true, act: `edit-${key}`, onclick: () => unlock(key, warn) })),
    lines.length ? h('dl', { class: 'saved-d' }, lines.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])) : null);
  /** The note over a saved setting that is open for editing. */
  const editingNote = (key) => h('div', { class: 'editing-note', role: 'status' }, icon('alert', 14), h('span', {}, 'You are changing a saved setting.'), btn('Cancel', { quiet: true, act: `cancel-${key}`, onclick: () => { if (key === 'hosting') for (const el of Object.values(fields.host ?? {})) el.value = ''; startWork(); relock(key); } }));
  const hostName = (hv) => {
    let host = '';
    try { host = new URL(hv.endpoint).host; } catch { /* keep blank */ }
    return /r2\.cloudflarestorage\.com$/.test(host) ? 'Cloudflare R2' : /amazonaws\.com$/.test(host) ? 'Amazon S3' : /backblazeb2\.com$/.test(host) ? 'Backblaze B2' : /wasabisys\.com$/.test(host) ? 'Wasabi' : host || 'Storage bucket';
  };

  const startWork = () => {
    work = {};
    const hints = suggestAccounts(a, S.projects);
    for (const p of S.projects) {
      const map = brandMapping(a, p.id);
      const known = (bufferAccounts(a).find((x) => x.id === map.account)?.channels) ?? [];
      work[p.id] = {
        account: map.account,
        chans: new Map(map.channels.map((c) => {
          const k = known.find((x) => x.id === c.id);
          return [c.id, { id: c.id, name: c.name ?? k?.name ?? c.id, service: c.service ?? k?.service, formats: c.formats?.length ? new Set(c.formats) : null, offsetMinutes: c.offsetMinutes ?? 0, hashtags: c.hashtags ?? 'keep', enabled: c.enabled !== false }];
        })),
      };
      // a login that plainly belongs to a brand with none yet is chosen for it (until Save it is only on this screen, and it says so)
      const hint = hints.get(p.id);
      if (hint) {
        work[p.id].account = hint.account.id;
        work[p.id].auto = hint.why;
        for (const c of hint.channels) work[p.id].chans.set(c.id, { id: c.id, name: c.name, service: c.service, formats: null, offsetMinutes: 0, hashtags: 'keep', enabled: true });
      }
    }
  };
  startWork();
  const accountsList = () => bufferAccounts(a);
  const owner = (channelId, except) => S.projects.find((p) => p.id !== except && work[p.id]?.chans.has(channelId));
  const stamp = (iso) => (iso ? new Date(iso).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '');

  function accountRow(p, c) {
    const w = work[p.id];
    const mine = w.chans.get(c.id);
    const other = owner(c.id, p.id);
    const on = !!mine;
    const row = h('div', { class: `acc${on ? ' on' : ''}${other ? ' taken' : ''}`, dataset: { channel: c.id, project: p.id } },
      h('label', { class: 'acc-main' },
        h('input', { type: 'checkbox', checked: on, disabled: !!other, 'aria-label': `${p.name} posts to ${c.name}`, onchange: (e) => { if (e.target.checked) w.chans.set(c.id, { id: c.id, name: c.name, service: c.service, formats: null, offsetMinutes: 0, hashtags: 'keep', enabled: true }); else w.chans.delete(c.id); draw(); } }),
        serviceIcon(c.service), h('span', { class: 'acc-name' }, c.name), h('span', { class: 'acc-svc muted' }, SERVICE_NAME[c.service] ?? c.service ?? ''),
        other ? h('span', { class: 'acc-taken' }, `Already used by ${other.name}`) : null));
    if (on) {
      row.append(h('div', { class: 'acc-set' },
        h('div', { class: 'acc-fmts', role: 'group', 'aria-label': 'Formats this account takes' }, h('span', { class: 'lbl-i' }, 'Takes'),
          FORMATS.map(([f, l]) => h('button', { class: `fchip${!mine.formats || mine.formats.has(f) ? ' on' : ''}`, type: 'button', 'aria-pressed': String(!mine.formats || mine.formats.has(f)), 'data-format': f, onclick: () => {
            const set = mine.formats ?? new Set(FORMATS.map(([x]) => x));
            if (set.has(f)) set.delete(f); else set.add(f);
            mine.formats = set.size === FORMATS.length ? null : set;
            draw();
          } }, l))),
        h('label', { class: 'acc-off', title: 'Each post has a planned time. 0 posts to this account at that time; 30 posts it half an hour later, so two accounts do not publish in the same minute.' }, h('span', { class: 'lbl-i' }, 'Post later by (minutes)'),
          h('input', { class: 'field num', type: 'number', min: 0, max: 1440, step: 5, value: String(mine.offsetMinutes), 'aria-label': `Minutes after, for ${c.name}`, onchange: (e) => { mine.offsetMinutes = Math.max(0, Math.min(1440, Number(e.target.value) || 0)); e.target.value = String(mine.offsetMinutes); e.target.nextElementSibling.textContent = mine.offsetMinutes ? `${plural(mine.offsetMinutes, 'minute')} after the planned time` : 'at the planned time'; } }),
          h('span', { class: 'acc-hint muted' }, mine.offsetMinutes ? `${plural(mine.offsetMinutes, 'minute')} after the planned time` : 'at the planned time')),
        c.service === 'facebook' ? h('label', { class: 'acc-strip' }, h('input', { type: 'checkbox', checked: mine.hashtags === 'strip', onchange: (e) => { mine.hashtags = e.target.checked ? 'strip' : 'keep'; } }), 'Strip hashtags') : null,
        h('label', { class: 'acc-strip' }, h('input', { type: 'checkbox', checked: mine.enabled, onchange: (e) => { mine.enabled = e.target.checked; } }), 'Publishing on')));
    }
    return row;
  }

  function accountsSection() {
    const list = accountsList();
    return [
      h('div', { class: 'acc-head' }, h('h3', { class: 'lbl' }, multi() ? `Buffer accounts (${list.filter((x) => x.configured).length})` : 'Your accounts')),
      multi() ? h('ul', { class: 'bacc-list' }, list.length ? list.map((x) => h('li', { class: `bacc${flash === x.id ? ' fresh' : ''}`, dataset: { account: x.id, auth: x.authType === 'oauth' ? 'oauth' : 'key' } },
        h('b', {}, x.label), h('span', { class: `bacc-st ${x.configured && x.lastTestOk !== false ? 'ok' : ''}` }, !x.configured ? 'Not connected' : x.lastTestOk === false ? 'Could not connect' : 'Connected'),
        h('span', { class: 'muted bacc-t' }, [x.lastTestedAt ? `Tested ${stamp(x.lastTestedAt)}` : (x.channels ?? []).length ? '' : 'Not tested yet', (x.channels ?? []).length ? plural(x.channels.length, 'channel') : '', allowanceText(x.allowance)].filter(Boolean).join(' · ')),
        x.authType === 'oauth' ? h('span', { class: 'muted bsi-card', 'data-field': `signin-${x.id}` }, signInCardText(x)) : null,
        h('span', { class: 'bacc-acts' },
          !x.configured || (x.authType === 'oauth' && x.lastTestOk === false) ? btn('Sign in again', { quiet: true, act: 'buffer-signin-again', onclick: () => startSignIn({ account: x.id, label: x.label }) }) : null,
          btn('Test', { quiet: true, act: 'test-account', onclick: () => testAccount(x) }),
          x.authType === 'oauth' && x.configured ? btn('Disconnect', { quiet: true, act: 'disconnect-account', onclick: () => disconnectAccount(x) }) : null,
          btn('Remove', { quiet: true, act: 'remove-account', onclick: () => removeAccount(x) })))) : [h('li', { class: 'muted' }, 'No Buffer account is connected yet.')]) : null,
      multi() ? signInBox({ args: () => { const label = fields.label.value.trim(); return label ? { account: slug(label), label } : {}; } }) : null,
      multi() ? h('div', { class: 'bacc-add' },
        h('h4', {}, 'Or paste an API key'),
        h('div', { class: 'bacc-add-row' },
          fields.label, fields.token,
          btn('Add account', { act: 'add-account', onclick: addAccount })),
        h('p', { class: 'sch-help' }, 'In Buffer open Settings, then API, create a key and paste it here. It is sent once to Nordle on this computer, kept in a private file, and never shown again. Use a different key for each Buffer login. A key is still the way to go where the sign-in is not available.')) : null,
    ];
  }

  function brandSection(p) {
    const w = work[p.id];
    const list = accountsList().filter((x) => x.configured);
    const acct = multi() ? list.find((x) => x.id === w.account) : list[0];
    const chans = acct?.channels ?? [];
    // already saved on the server: folded and read-only until Edit
    const stored = brandMapping(a, p.id);
    if (stored.account && stored.channels.length && !w.auto && !unlocked.has(`brand:${p.id}`)) {
      const sa = accountsList().find((x) => x.id === stored.account);
      return savedCard({ key: `brand:${p.id}`, title: p.name, status: 'Saved', warn: WARN.brand(p), lines: [
        ['Account', sa?.label ?? stored.account],
        ['Channels', stored.channels.map((c) => `${c.name ?? c.id}${c.service ? ` (${SERVICE_NAME[c.service] ?? c.service})` : ''}`).join(', ')],
      ] });
    }
    const state = !acct ? h('span', { class: 'acc-st' }, list.length ? 'Choose an account' : 'Not connected')
      : h('span', { class: 'acc-st ok' }, 'Connected', ' · ', acct.label, w.chans.size ? ` · ${plural(w.chans.size, 'channel')}` : '');
    return h('section', { class: 'acc-brand', dataset: { project: p.id }, style: { '--lane': p.color } },
      h('h3', {}, h('i', { class: 'tick', style: { '--lane': p.color } }), ` ${p.name}`, state),
      multi() ? h('label', { class: 'acc-via' }, h('span', { class: 'lbl-i' }, 'Publishes through'),
        h('select', { class: 'field', 'aria-label': `Buffer account for ${p.name}`, onchange: (e) => { w.account = e.target.value || null; w.auto = null; w.chans = new Map(); draw(); } },
          h('option', { value: '' }, list.length ? 'Choose an account…' : 'No account connected'), list.map((x) => h('option', { value: x.id, selected: x.id === w.account }, x.label)))) : null,
      w.auto && acct ? h('p', { class: 'muted acc-auto' }, w.auto === 'only' ? 'This is your only Buffer account, so it is chosen here. Press Save to keep it.' : 'Chosen because the name matches. Check it, then press Save to keep it.') : null,
      !list.length ? h('p', { class: 'acc-none' }, `Connect a Buffer account for ${p.name}.`, ' ', multi() ? btn('Add an account', { quiet: true, onclick: () => fields.label.focus() }) : null)
        : !acct ? h('p', { class: 'acc-none' }, `Connect a Buffer account for ${p.name}: choose which one it publishes through.`)
          : !chans.length ? h('p', { class: 'muted' }, 'This account has no channels loaded. Press Test on it to load them.')
            : [!w.chans.size ? h('p', { class: 'acc-none' }, 'No channel ticked yet. Tick the ones that belong to this brand.') : null, ...chans.map((c) => accountRow(p, c))]);
  }

  const hostField = (key, label, { type = 'text', placeholder = '', value = '' } = {}) => {
    fields.host ??= {};
    fields.host[key] ??= h('input', { class: 'field', type, autocomplete: 'off', spellcheck: 'false', placeholder, value, 'aria-label': label, 'data-field': `host-${key}` });
    return h('label', { class: 'host-f' }, h('span', { class: 'lbl-i' }, label), fields.host[key]);
  };
  /** Where the pictures and video live so Buffer can read them: the owner's own bucket, filled by Nordle when posts are scheduled. */
  function hostingSection() {
    const hv = a.hosting ?? { configured: false };
    if (hv.configured && !unlocked.has('hosting')) {
      return savedCard({ key: 'hosting', title: `Media hosting · ${hostName(hv)}`, status: 'Set up', warn: WARN.hosting,
        extra: btn('Test it', { quiet: true, act: 'host-test', onclick: testHostingNow }),
        lines: [['Bucket', hv.bucket], ['Storage address', hv.endpoint], ['Region', hv.region], ['Read from', hv.publicBaseUrl], ['Access key', hv.accessKeyHint]] });
    }
    return h('section', { class: 'host', dataset: { configured: String(!!hv.configured) } },
      hv.configured ? editingNote('hosting') : null,
      h('div', { class: 'acc-head' }, h('h3', { class: 'lbl' }, 'Where your pictures and video go'),
        h('span', { class: `bacc-st ${hv.configured ? 'ok' : ''}` }, hv.configured ? `Set up · ${hv.bucket}` : 'Not set up')),
      h('p', { class: 'sch-help' }, 'Buffer cannot take files from this computer: it reads each picture and video from a public web address when the post goes out. Give Nordle a storage bucket of yours (Cloudflare R2 is free for this) and it uploads the files of the posts you schedule, only when you press Schedule.'),
      hv.configured ? h('p', { class: 'muted host-now' }, `Files go to “${hv.bucket}” at ${new URL(hv.endpoint).host} and are read from ${hv.publicBaseUrl}. Key ${hv.accessKeyHint}. Leave a box empty to keep what is saved.`) : null,
      h('div', { class: 'host-grid' },
        hostField('endpoint', 'Storage address (endpoint)', { placeholder: 'https://<account>.r2.cloudflarestorage.com' }),
        hostField('bucket', 'Bucket name', { placeholder: 'nordle-posts' }),
        hostField('region', 'Region', { placeholder: 'auto', value: hv.configured ? hv.region : 'auto' }),
        hostField('accessKeyId', 'Access key ID'),
        hostField('secretAccessKey', 'Secret access key', { type: 'password' }),
        hostField('publicBaseUrl', 'Public address of the bucket', { placeholder: 'https://pub-….r2.dev' })),
      h('div', { class: 'host-acts' }, btn(hv.configured ? 'Save changes' : 'Save hosting', { act: 'host-save', onclick: saveHosting }), btn('Test it', { act: 'host-test', quiet: true, disabled: !hv.configured, onclick: testHostingNow }),
        hv.configured ? btn('Turn off', { quiet: true, act: 'host-off', onclick: turnOffHosting }) : null),
      h('details', { class: 'host-how' }, h('summary', {}, 'How to set up Cloudflare R2'),
        h('ol', {}, [
          'In the Cloudflare dashboard open R2 and create a bucket (any name).',
          'In the bucket’s Settings turn on the “Public Development URL” and copy it: that is the public address.',
          'In R2 choose Manage API tokens, create a token with Object Read & Write for that bucket, and copy the Access Key ID, the Secret and the S3 address.',
          'Paste them above, Save, then press Test it. The keys stay on this computer.',
        ].map((t) => h('li', {}, t)))));
  }
  /**
   * The platforms Nordle knows about, one line each. Buffer and the export folder work. The others are listed with a place for the key;
   * Nordle keeps it but does not post through them yet, and says so on each one.
   */
  function platformsSection() {
    const bufferOk = a.id === 'buffer' && accountsList().some((x) => x.configured);
    const row = (name, status, tone, note) => h('li', { class: 'plat' }, h('b', {}, name), h('span', { class: `plat-st ${tone}` }, status), note ? h('span', { class: 'muted plat-n' }, note) : null);
    const keyCard = (x, key) => {
      const g = PUBLISH_GUIDES[x.id];
      // one box per platform, kept across redraws: the window redraws when a background request finishes, and a half-typed key must survive that
      if (!keyInputs.has(x.id)) keyInputs.set(x.id, h('input', { class: 'field', type: 'password', autocomplete: 'off', spellcheck: 'false', 'aria-label': `${x.name} API key`, 'data-field': `platform-${x.id}` }));
      const input = keyInputs.get(x.id);
      input.placeholder = x.configured ? 'Paste the new key' : 'Paste the API key';
      const put = async () => {
        const token = input.value.trim();
        if (!token) { input.focus(); return; }
        try { await api.post('/publish/platforms', { id: x.id, token }); input.value = ''; keyInputs.delete(x.id); unlocked.delete(key); chosen = ''; banner = { ok: true, title: `${x.name} key saved`, text: 'Kept on this computer and never shown again. Nordle does not post through it yet.' }; await loadPlatforms(); } catch (e) { banner = { ok: false, title: `${x.name} key not saved`, text: e.message }; draw(); }
      };
      const forget = async () => {
        if (!(await askConfirm({ title: `Forget the ${x.name} key?`, body: 'Only the saved key is removed.', ok: 'Forget key', danger: true }))) return;
        try { await api.post('/publish/platforms', { id: x.id, token: null }); unlocked.delete(key); banner = null; await loadPlatforms(); } catch (e) { message = e.message; draw(); }
      };
      const keyArea = h('div', { class: 'plat-add' }, input, btn('Save key', { act: `save-${x.id}`, onclick: put }), x.configured ? btn('Forget', { quiet: true, onclick: forget }) : null);
      return h('section', { class: 'plat-card', dataset: { platform: x.id } }, x.configured ? editingNote(key) : null, g ? guideBlock(g, keyArea) : keyArea);
    };
    // keys already saved: folded cards (changing one asks first)
    const savedCards = platforms.filter((x) => x.configured).map((x) => {
      const key = `platform:${x.id}`;
      return unlocked.has(key) ? keyCard(x, key) : savedCard({ key, title: x.name, status: 'Key saved', warn: WARN.platform(x), lines: [['Key', `••••${x.keyHint}`], ['Posting', 'Not built into Nordle yet. Use Buffer or the export folder for now.']] });
    });
    // everything else is chosen from a list: pick one and its steps and key box appear
    const choices = [...platforms.filter((x) => !x.configured).map((x) => [x.id, x.name]), ...Object.entries(PUBLISH_GUIDES).filter(([id, g]) => !g.key).map(([id, g]) => [id, g.name])];
    const picker = choices.length ? h('label', { class: 'plat-pick' }, h('span', { class: 'lbl-i' }, 'Add a platform'),
      h('select', { class: 'field', 'data-field': 'platform-pick', 'aria-label': 'Choose a platform to set up', onchange: (e) => { chosen = e.target.value; draw(); } },
        h('option', { value: '' }, 'Choose a platform…'), choices.map(([id, name]) => h('option', { value: id, selected: id === chosen }, name)))) : null;
    const pick = platforms.find((x) => x.id === chosen && !x.configured);
    const guideOnly = PUBLISH_GUIDES[chosen] && !PUBLISH_GUIDES[chosen].key ? PUBLISH_GUIDES[chosen] : null;
    return h('section', { class: 'platforms', 'data-section': 'platforms' },
      h('h3', { class: 'lbl' }, 'Publishing platforms'),
      h('ul', { class: 'plat-list' }, row('Buffer', bufferOk ? 'Connected' : 'Not connected', bufferOk ? 'ok' : 'warn', 'Set up below'), row('Export folder', 'Always ready', 'ok', 'Upload by hand anywhere')),
      savedCards,
      picker,
      pick ? keyCard(pick, `platform:${pick.id}`) : guideOnly ? h('section', { class: 'plat-card', dataset: { platform: chosen } }, guideBlock(guideOnly)) : null);
  }
  async function loadPlatforms() {
    try { platforms = (await api.get('/publish/platforms')).platforms; } catch { platforms = []; }
    draw();
  }
  const hostValues = () => Object.fromEntries(Object.entries(fields.host ?? {}).map(([k, el]) => [k, el.value.trim()]).filter(([, v]) => v));
  async function saveHosting() {
    try {
      await api.post('/publish/settings', { adapter: a.id, hosting: hostValues() });
      for (const k of ['secretAccessKey', 'accessKeyId']) if (fields.host?.[k]) fields.host[k].value = '';
      saved = true; unlocked.delete('hosting'); banner = { ok: true, title: 'Media hosting saved', text: 'Press “Test it” to check that Nordle can put a file there and read it back, the way Buffer will.' }; message = '';
    } catch (e) { banner = { ok: false, title: 'Hosting not saved', text: e.message }; }
    await refresh();
  }
  async function testHostingNow() {
    banner = { ok: true, title: 'Testing…', text: 'Sending a small test file and reading it back.' }; draw();
    try {
      const r = await api.post('/publish/test-hosting', {});
      banner = r.ok ? { ok: true, title: 'Media hosting works', text: r.message } : { ok: false, title: 'Media hosting did not work', text: r.message };
      notify(r.ok ? 'Media hosting works.' : 'Media hosting did not work.', { kind: r.ok ? 'ok' : 'error' });
    } catch (e) { banner = { ok: false, title: 'Media hosting did not work', text: e.message }; }
    saved = true; draw();
  }
  async function turnOffHosting() {
    if (!(await askConfirm({ title: 'Turn off media hosting?', body: 'The bucket keys are forgotten. Files already in the bucket stay there. Nothing changes in Buffer.', ok: 'Turn off', danger: true }))) return;
    try { await api.post('/publish/settings', { adapter: a.id, hosting: null }); saved = true; banner = null; message = 'Media hosting turned off.'; } catch (e) { message = e.message; }
    fields.host = null; await refresh();
  }

  function draw() {
    fields.token = fields.token ?? h('input', { class: 'field', type: 'password', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Buffer API key', 'data-field': 'pub-token' });
    fields.token.placeholder = multi() ? 'Paste the API key' : a.configured ? 'A key is saved. Paste a new one to replace it' : 'Paste your Buffer API key';
    fields.label = fields.label ?? h('input', { class: 'field', autocomplete: 'off', 'aria-label': 'A name for this Buffer account', placeholder: 'A name, e.g. Agency login', 'data-field': 'pub-label', maxlength: 60 });
    fields.base = fields.base ?? h('input', { class: 'field', type: 'url', autocomplete: 'off', 'aria-label': 'Media web address', placeholder: 'https://media.example.com/nordle', value: mediaBase(a), 'data-field': 'pub-base' });
    m.body.replaceChildren(...[
      banner ? h('div', { class: `acc-banner ${banner.ok ? 'ok' : 'bad'}`, role: 'status' },
        h('span', { class: 'acc-banner-i' }, icon(banner.ok ? 'check' : 'alert', 18)),
        h('div', {}, h('b', {}, banner.title), banner.text ? h('p', {}, banner.text) : null),
        h('button', { class: 'notice-x', type: 'button', 'aria-label': 'Dismiss', onclick: () => { banner = null; flash = null; draw(); } }, icon('x', 12))) : null,
      platformsSection(),
      multi() ? null : [h('p', { class: 'sch-help' }, 'Create an API key in Buffer under Settings, API, and paste it here. It is sent to Nordle on this computer, kept in a private file, and never shown again.'), h('label', { class: 'ask-label' }, 'API key'), fields.token],
      hostingSection(),
      mediaBase(a) && !unlocked.has('base')
        ? savedCard({ key: 'base', title: 'Media web address', warn: WARN.base, lines: [['Address', mediaBase(a)]] })
        : h('details', { class: 'host-manual', open: unlocked.has('base') }, h('summary', {}, 'Or host the export folders yourself'),
          mediaBase(a) ? editingNote('base') : null,
          h('label', { class: 'ask-label' }, 'Media web address'), fields.base,
          h('p', { class: 'sch-help' }, 'Host the contents of each project’s out/publish folder at this address (one folder per brand), and keep it up until the posts are out. Nordle checks every file answers before it asks Buffer. Not needed when media hosting above is set up.')),
      multi() ? null : h('div', { class: 'acc-head' }, btn((a.channels ?? []).length ? 'Load accounts again' : 'Load accounts', { act: 'load-accounts', onclick: () => save(true) })),
      accountsSection(),
      autoSection(),
      h('h3', { class: 'lbl sch-gap' }, 'Which accounts each brand posts to'),
      S.projects.map(brandSection),
      message ? h('p', { class: 'sch-msg', role: 'status' }, message) : null].flat(Infinity).filter(Boolean));
    m.foot.replaceChildren(...[
      btn(saved ? 'Close' : 'Cancel', { onclick: m.close }),
      btn('Save', { act: 'connect-save', go: multi(), onclick: () => save(false) }),
      multi() ? null : btn('Save and test the connection', { go: true, act: 'connect-test', onclick: () => save(true) })].filter(Boolean));
  }

  const refresh = async () => { adapters = await getAdapters(); pub.adapters = adapters; pub.loaded = true; a = adapters.find((x) => x.id === a.id) ?? a; startWork(); draw(); update(); };

  // Automatic scheduling: the owner's standing instruction. Each change is saved at once (it does not wait for Save).
  let auto = pub.auto;
  if (!auto) api.get('/publish/auto-schedule').then((r) => { auto = pub.auto = r; draw(); }, () => {});
  async function setAuto(patch) {
    try {
      auto = pub.auto = await api.post('/publish/auto-schedule', patch);
      unlocked.delete('auto');
      if (patch.enabled !== undefined) notify(patch.enabled ? `Approved posts will go to Buffer on their own, ${plural(auto.daysAhead, 'day')} before their time.` : 'Automatic scheduling is off.', { kind: 'ok' });
      autoChanged(); update();
    } catch (e) { message = e.message; }
    draw();
  }
  async function lookNow() {
    try {
      const r = await api.post('/publish/auto-schedule', { now: true });
      auto = pub.auto = r;
      const n = r.ran?.scheduled?.length ?? 0;
      notify(n ? `${plural(n, 'post')} scheduled.` : r.ran?.reason === 'allowance-low' ? 'Buffer’s allowance for today is nearly used, so nothing was sent.' : 'Nothing is due yet.', { kind: n ? 'ok' : 'info' });
      autoChanged();
      await load({ force: true });
    } catch (e) { message = e.message; }
    draw();
  }
  function autoSection() {
    if (a.id !== 'buffer' || !auto) return null;
    if (auto.enabled && !unlocked.has('auto')) {
      return savedCard({ key: 'auto', title: 'Automatic scheduling', status: 'On', warn: WARN.auto, extra: btn('Look now', { quiet: true, act: 'auto-now', onclick: lookNow }), lines: [
        ['Approved posts', `go to Buffer on their own, ${plural(auto.daysAhead, 'day')} before their time`], ['Stories', auto.stories ? 'also made' : 'not made'],
        ...((auto.problems ?? []).length ? [['Needs a look', plural(auto.problems.length, 'post')]] : [])] });
    }
    return h('section', { class: 'auto', 'data-section': 'auto-schedule' },
      auto.enabled ? editingNote('auto') : null,
      h('h3', { class: 'lbl sch-gap' }, 'Schedule approved posts automatically'),
      h('label', { class: 'acc-strip' }, h('input', { type: 'checkbox', checked: auto.enabled, 'data-field': 'auto-on', onchange: (e) => setAuto({ enabled: e.target.checked }) }), 'Put approved posts in Buffer on their own'),
      h('label', { class: 'acc-off' }, h('span', { class: 'lbl-i' }, 'When a post is within'),
        h('input', { class: 'field num', type: 'number', min: 1, max: 30, step: 1, value: String(auto.daysAhead), 'data-field': 'auto-days', 'aria-label': 'Days before the post’s time', onchange: (e) => setAuto({ daysAhead: Math.max(1, Math.min(30, Math.round(Number(e.target.value)) || 7)) }) }),
        h('span', { class: 'acc-hint muted' }, 'days of its planned time')),
      h('label', { class: 'acc-strip' }, h('input', { type: 'checkbox', checked: auto.stories, 'data-field': 'auto-stories', onchange: (e) => setAuto({ stories: e.target.checked }) }), 'Also make a Story of each one'),
      h('p', { class: 'sch-help' }, 'It does what the Schedule button does, with the same checks: only posts you have approved, with nothing blocking them, at their own planned time. A post that is not ready is left alone, and the reason shows on the post. Nothing goes live from here: Buffer posts it at its time.'),
      auto.pausedUntil ? h('p', { class: 'sch-msg', role: 'status' }, 'Paused for now: Buffer said its limit was reached.') : null,
      (auto.problems ?? []).length ? h('ul', { class: 'auto-list bad' }, auto.problems.slice(0, 5).map((x) => h('li', {}, h('b', {}, short(S.byUid.get(x.uid)?.title ?? x.uid, 50)), ` ${short(x.message, 140)}`))) : null,
      (auto.recent ?? []).length ? h('ul', { class: 'auto-list' }, auto.recent.slice(0, 4).map((x) => h('li', { class: x.ok ? '' : 'bad' }, h('b', {}, short(x.title, 50)), ` ${short(x.message, 110)} `, h('span', { class: 'muted' }, stamp(x.at))))) : null,
      auto.enabled ? h('div', { class: 'acc-head' }, btn('Look now', { quiet: true, act: 'auto-now', onclick: lookNow })) : null);
  }

  async function addAccount() {
    const label = fields.label.value.trim();
    const token = fields.token.value.trim();
    if (!label || !token) { message = 'Give the account a name and paste its API key.'; draw(); return; }
    const id = slug(label);
    try {
      await api.post('/publish/settings', { adapter: a.id, account: id, label, token });
      fields.token.value = ''; fields.label.value = '';
      saved = true; message = `Added “${label}”.`;
    } catch (e) { message = e.message; await refresh(); return; }
    await checkAccount({ id, label });
  }
  /** After an account's channels are known: brands with none that this login plainly belongs to get it, and their own channels, straight
   * away. Only Nordle's settings change; nothing goes to Buffer. Returns the brands it matched. */
  async function linkMatches(accountId) {
    const done = [];
    for (const [pid, hint] of suggestAccounts(a, S.projects)) {
      if (hint.account.id !== accountId) continue;
      const channels = hint.channels.map((c) => ({ id: c.id, name: c.name, ...(c.service ? { service: c.service } : {}) }));
      await api.post('/publish/settings', { adapter: a.id, brand: pid, useAccount: accountId, channels: { [pid]: channels } });
      done.push(`${S.projects.find((q) => q.id === pid)?.name ?? pid}${channels.length ? ` (${plural(channels.length, 'channel')})` : ''}`);
    }
    return done;
  }
  /** Ask Buffer whether the key works (this loads the account's channels), then match the account to the brands it belongs to. */
  async function checkAccount(x) {
    let r;
    try { r = await api.post('/publish/test', { adapter: a.id, account: x.id }); } catch (e) { r = { ok: false, message: e.message }; }
    await afterCheck(x, r);
  }
  /** A Buffer sign-in has just finished (the server already tested it): the same banner, matching and notice as after a key is added. */
  const afterSignIn = (r) => afterCheck({ id: r.account, label: r.label }, r);
  async function afterCheck(x, r) {
    saved = true;
    await refresh();
    let linked = [];
    if (r.ok) { try { linked = await linkMatches(x.id); } catch (e) { r = { ...r, message: `${r.message ?? 'Connected.'} Could not match it to a brand: ${e.message}` }; } if (linked.length) await refresh(); }
    const base = plainWaits(r.message ?? (r.ok ? 'Connected.' : 'Could not connect.'));
    const chans = accountsList().find((y) => y.id === x.id)?.channels ?? [];
    const label = accountsList().find((y) => y.id === x.id)?.label ?? x.label;
    // the confirmation sits at the top of this window, where the person is looking (a toast would be hidden behind it)
    banner = r.ok
      ? { ok: true, title: `${label} is connected`, text: [chans.length ? `${plural(chans.length, 'channel')} found: ${chans.slice(0, 4).map((c) => c.name).join(', ')}${chans.length > 4 ? '…' : ''}.` : base,
        linked.length ? `Matched to ${linked.join(' and ')}.` : S.projects.some((p) => !work[p.id].account) ? 'Now choose which brand it publishes for, below.' : '', r.note ? plainWaits(r.note) : ''].filter(Boolean).join(' ') }
      : { ok: false, title: `${label} did not connect`, text: base };
    flash = r.ok ? x.id : null;
    notify(r.ok ? `${label} is connected to ${a.name}.` : `${label} could not connect to ${a.name}.`, { kind: r.ok ? 'ok' : 'error' });
    message = '';
    draw();
    m.body.querySelector('.acc-banner')?.scrollIntoView({ block: 'nearest' });
  }
  const testAccount = (x) => checkAccount(x);
  /** Forget a Buffer sign-in on this computer. The account stays, so its brands keep their channels and it can be signed in again. */
  async function disconnectAccount(x) {
    if (!(await askConfirm({ title: `Disconnect “${x.label}”?`, body: 'Nordle forgets this Buffer sign-in on this computer and stops using it. To take Nordle’s access away inside Buffer as well, use Buffer’s own settings: only you can do that part, and Nordle cannot do it for you.', ok: 'Disconnect', danger: true }))) return;
    try { await api.post('/publish/oauth/buffer/disconnect', { account: x.id }); saved = true; banner = { ok: true, title: `${x.label} is disconnected`, text: 'Its sign-in is forgotten here. Press “Sign in again” to connect it again.' }; flash = null; message = ''; } catch (e) { banner = { ok: false, title: `${x.label} was not disconnected`, text: e.message }; }
    await refresh();
  }
  async function removeAccount(x) {
    const using = S.projects.filter((p) => work[p.id].account === x.id).map((p) => p.name);
    if (!(await askConfirm({ title: `Remove “${x.label}”?`, body: `${x.authType === 'oauth' ? 'Its Buffer sign-in is forgotten' : 'Its API key is forgotten'}${using.length ? `, and ${using.join(', ')} will have no Buffer account until you pick another` : ''}. Nothing in Buffer changes.`, ok: 'Remove account', danger: true }))) return;
    try {
      for (const p of S.projects.filter((q) => work[q.id].account === x.id)) await api.post('/publish/settings', { adapter: a.id, brand: p.id, useAccount: null });
      await api.post('/publish/settings', { adapter: a.id, account: x.id, remove: true }); saved = true; banner = null; flash = null; message = `Removed “${x.label}”.`; } catch (e) { message = e.message; }
    await refresh();
  }

  async function save(test) {
    try {
      // Anything typed in the hosting boxes is saved by every Save button, not only by "Save hosting": the boxes are part of this window.
      const hv = hostValues();
      const hostTyped = Object.keys(hv).some((k) => k !== 'region') || (hv.region && hv.region !== 'auto');
      if (hostTyped) {
        await api.post('/publish/settings', { adapter: a.id, hosting: hv });
        for (const k of ['secretAccessKey', 'accessKeyId']) if (fields.host?.[k]) fields.host[k].value = '';
        banner = { ok: true, title: 'Media hosting saved', text: 'Press “Test it” to check that Nordle can put a file there and read it back, the way Buffer will.' };
      }
      const v = fields.base.value.trim();
      const brandBody = (p) => [...work[p.id].chans.values()].map((c) => ({
        id: c.id, name: c.name, ...(c.service ? { service: c.service } : {}), ...(c.formats ? { formats: [...c.formats] } : {}),
        ...(c.offsetMinutes ? { offsetMinutes: c.offsetMinutes } : {}), ...(c.hashtags === 'strip' ? { hashtags: 'strip' } : {}), ...(c.enabled === false ? { enabled: false } : {}),
      }));
      if (multi()) {
        if (v) await api.post('/publish/settings', { adapter: a.id, mediaBaseUrl: v });
        for (const p of S.projects) await api.post('/publish/settings', { adapter: a.id, brand: p.id, useAccount: work[p.id].account ?? null, channels: { [p.id]: brandBody(p) } });
      } else {
        const body = { adapter: a.id };
        if (v) { if (a.brands) body.mediaBaseUrl = v; else body.options = { mediaBaseUrl: v }; }
        const token = fields.token.value.trim();
        if (token) body.token = token;
        if ((a.channels ?? []).length || S.projects.some((p) => work[p.id].chans.size)) body.channels = Object.fromEntries(S.projects.map((p) => [p.id, brandBody(p)]));
        await api.post('/publish/settings', body);
        fields.token.value = '';
        if (test) { const r = await api.post('/publish/test', { adapter: a.id }); message = plainWaits(r.message ?? (r.ok ? 'Connected.' : 'Could not connect.')); }
      }
      saved = true;
      for (const k of [...unlocked]) if (k.startsWith('brand:') || k === 'base' || (hostTyped && k === 'hosting')) unlocked.delete(k);   // saved: folded away again
      if (multi() && !test && !hostTyped) { await refresh(); notify('Publishing settings saved.', { kind: 'ok' }); m.close(); return; }   // saved: the window has done its job (stays open after hosting is saved, so it can be tested)
      if (!test || multi()) message = 'Saved.';
    } catch (e) { message = e.message; }
    await refresh();
  }

  // Sign in with Buffer: while this window is open it redraws as the sign-in goes along, and takes the finished answer itself
  const stopWatching = onSignInChange(() => { if (m.dlg.isConnected) draw(); });
  setSignInSink(async (r) => { if (r.account) await afterSignIn(r); });
  resetSignIn();
  if (multi()) loadSignInStatus();

  draw();
  loadPlatforms();
  await new Promise((r) => m.dlg.addEventListener('close', r, { once: true }));
  stopWatching();
  setSignInSink(signedInWhileClosed);
  return saved;
}
