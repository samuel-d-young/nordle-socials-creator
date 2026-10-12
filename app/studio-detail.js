// One post, in full: the pieces of its page. The detail sheet and the review queue arrange the same pieces differently.

import { api } from './api.js';
import { h, icon } from './dom.js';
import { S, dateFmt, load, project } from './studio-store.js';
import { brandName, brandTick, buildLine, emptyState, FORMAT_LABEL, glyph, kbd, mark, notify, plainWaits, plural, statusChip, statusOf } from './studio-ui.js';
import { thumbUrl } from './studio-ui.js';
import { reelSummary } from '/src/shared/reel-options.mjs';
import * as act from './studio-actions.js';
import { accountsOf, autoNote, openConnect, openSchedule, pub as pubState, quickLabel, quickReady, quickSchedule, serviceIcon } from './studio-publish.js';
import { canEditHere, editHere } from './studio-edit.js';

// ---- fetching ---------------------------------------------------------------------------------------------------------------------

const cache = new Map();
const sig = (p) => JSON.stringify([p.status, p.builtAt, p.updated, p.checks, p.score, p.approvedAt, p.pendingChanges, p.thumb, p.video, p.staleSignoff]);

/** The full record of a post. Cached until the post changes. */
export async function fetchDetail(post) {
  const key = sig(post);
  const hit = cache.get(post.uid);
  if (hit && hit.key === key) return hit.data;
  const data = await api.get(`/studio/post?uid=${encodeURIComponent(post.uid)}`);
  cache.set(post.uid, { key, data });
  if (cache.size > 60) cache.delete(cache.keys().next().value);
  return data;
}
export const forgetDetail = (uid) => cache.delete(uid);

// ---- helpers ----------------------------------------------------------------------------------------------------------------------

const FOLD = 125;
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '');

function blk(title, body, { aside, cls = '', id } = {}) {
  return h('section', { class: `blk ${cls}`.trim(), id }, h('header', { class: 'blk-h' }, h('h3', { class: 'lbl' }, title), aside ?? null), body);
}

/** Where the hook ends: the hook text if the caption starts with it, otherwise the first sentence that fits before the fold. */
export function hookEnd(caption, hook) {
  const text = caption ?? '';
  if (hook && text.toLowerCase().startsWith(hook.trim().toLowerCase())) return Math.min(hook.trim().length, text.length);
  const line = text.split('\n')[0];
  const sentence = /^.*?[.!?](\s|$)/.exec(line);
  const end = sentence ? sentence[0].trimEnd().length : line.length;
  return Math.min(end, FOLD, text.length);
}

/** The caption as it will be posted: the hook is highlighted, and nothing else is added to the words (no "…more" marker in the middle of a sentence). */
function captionText(caption, hook) {
  const end = hookEnd(caption, hook);
  return h('p', { class: 'cap-text' },
    h('mark', { class: 'hook', title: 'The hook: what people read first' }, caption.slice(0, end)),
    caption.slice(end));
}

// ---- the pieces -------------------------------------------------------------------------------------------------------------------

export function head(d, post) {
  const pr = project(post.project);
  const date = post.date ? dateFmt.long(post.date) : 'Not scheduled yet';
  return h('header', { class: 'ph' },
    h('div', { class: 'ph-meta' }, brandTick(post.project), h('span', { class: 'ph-brand' }, pr?.name ?? post.project), h('span', { class: 'ph-sep' }, '·'), glyph(post.format), h('span', {}, FORMAT_LABEL[post.format] ?? post.format), post.pillar ? h('span', { class: 'ph-pillar' }, pillarName(post)) : null),
    h('h2', { class: 'ph-title' }, post.title),
    h('div', { class: 'ph-line' }, h('span', { class: 'ph-date' }, date, post.time ? ` · ${post.time}` : ''), statusChip(post)));
}
export const pillarName = (post) => project(post.project)?.settings.pillars.find((p) => p.id === post.pillar)?.name ?? post.pillar;

/** One plain line on where a sent-back post is: waiting for Claude, being changed now, or the change did not work. */
function designerLine(d, post) {
  const run = d.item?.run;
  if (post.revising) return `Claude is changing this post now${run?.startedAt ? ` (started ${when(run.startedAt)})` : ''}. It comes back here for another look when it is done.`;
  if (post.reviseFailed) return `Claude could not make that change${run?.lastError ? `: ${run.lastError.length > 220 ? `${run.lastError.slice(0, 217)}...` : run.lastError}` : '.'} Press Ask again to try again.`;
  return post.autoRevise ? 'Sent back. Claude starts on it as soon as it is free.' : 'Sent back. Waiting for the designer.';
}

/** What you asked the designer to change (your note and the comments that went with it), shown while the post is sent back. */
function sentNote(d) {
  const ask = [...(d.item?.feedback ?? [])].reverse().find((f) => f.by === 'owner' && !f.resolved);
  return ask?.comment ? h('div', { class: 'sent-note' }, h('span', { class: 'lbl-i' }, 'What you asked for'), h('p', {}, ask.comment)) : null;
}

/**
 * "Check in Buffer" for a scheduled post: asks Buffer (read only) whether it is still there. When it was deleted there, "Reschedule" takes it
 * back (it becomes signed off again) and opens the Schedule window so a time can be chosen.
 */
function bufferCheck(post, afterAction, onResolved) {
  const note = h('span', { class: 'bc-note muted', role: 'status' });
  let gone = [];
  const again = h('button', { class: 'btn go hidden', type: 'button', 'data-act': 'reschedule-now', onclick: async () => {
    again.disabled = true;
    try {
      await api.post('/publish/unschedule', { uid: post.uid, channels: gone });
      forgetDetail(post.uid);
      await load({ force: true });
      afterAction?.();
      openSchedule([post.uid], { onScheduled: onResolved ?? afterAction });
    } catch (e) { note.textContent = e.message; again.disabled = false; }
  } }, icon('calendarSend', 14), 'Reschedule…');
  const check = h('button', { class: 'btn', type: 'button', 'data-act': 'check-buffer', onclick: async () => {
    check.disabled = true; note.textContent = 'Asking Buffer…'; again.classList.add('hidden');
    try {
      const r = await api.post('/publish/check-scheduled', { uids: [post.uid] });
      const x = r.results[0];
      gone = x?.missing ?? [];
      if (!x) note.textContent = 'This post is not scheduled in Buffer.';
      else if (gone.length) { note.textContent = `${gone.length === x.targets.length ? 'It is no longer in Buffer.' : 'Part of it is no longer in Buffer.'} It was probably deleted there.`; again.classList.remove('hidden'); }
      else note.textContent = `Still in Buffer${r.incomplete ? ' (could not read everything, so not certain)' : ''}: ${x.targets.map((t) => t.state).join(', ')}.`;
    } catch (e) { note.textContent = e.message; }
    check.disabled = false;
  } }, icon('calendarSend', 14), 'Check in Buffer');
  return h('div', { class: 'bc' }, check, again, note);
}

/**
 * A reel edited in the video editor after its video was made: the video on the sheet (and what Schedule would send) is the old one.
 * Say so under the video, with one button that makes the finished MP4 again and then shows it.
 */
export function videoNotice(d, post, onDone) {
  if (!d.media?.outdated || !post.docId) return null;
  const base = `/projects/${encodeURIComponent(post.project)}/video`;
  const note = h('span', { class: 'vo-text' }, 'You edited this reel after its video was made, so the video above is the old one. Scheduling waits until it is made again.');
  const bar = h('progress', { class: 'vo-bar hidden', max: 100, value: 0, 'aria-label': 'Making the video' });
  const go = h('button', { class: 'btn', type: 'button', 'data-act': 'remake-video', onclick: async () => {
    go.disabled = true; bar.classList.remove('hidden'); note.textContent = 'Making the video…';
    try {
      let j = (await api.post(`${base}/render`, { doc: post.docId, format: 'mp4' })).job;
      while (j.status === 'running') {
        await new Promise((r) => setTimeout(r, 1000));
        j = (await api.get(`${base}/jobs/${encodeURIComponent(j.id)}`)).job;
        bar.value = j.percent ?? 0;
        note.textContent = `Making the video… ${Math.round(j.percent ?? 0)}%`;
      }
      if (j.status !== 'done') throw new Error(j.message || 'The video could not be made.');
      forgetDetail(post.uid);
      onDone?.();
    } catch (e) { note.textContent = e.message; go.disabled = false; bar.classList.add('hidden'); }
  } }, icon('film', 14), 'Make the video again');
  return h('div', { class: 'video-outdated', role: 'status', 'data-state': 'video-outdated' }, icon('alert', 16), note, bar, go);
}

/** The buttons. What is offered depends on where the post is in its life. */
export function actions(d, post, { afterAction, onResolved, compact = false, split = false } = {}) {
  const done = async (fn) => { const ok = await fn(); if (ok) afterAction?.(); return ok; };
  // a decision settles the post: the sheet that was open for it goes away (the toast says what happened and offers Undo)
  const decided = async (fn) => { const ok = await fn(); if (ok) (onResolved ?? afterAction)?.(); return ok; };
  const href = post.docId ? `#/p/${encodeURIComponent(post.project)}/${encodeURIComponent(post.docId)}` : null;
  // a reel opens the video editor: that button sits with the decisions, under the video, where it is seen (not in the dock at the bottom)
  const isVideo = !!post.docId && (post.kind === 'video' || !!d.media?.editable);
  const editor = !href ? null : isVideo
    ? h('a', { class: 'btn edit-video', href, 'data-act': 'edit-video', title: 'Cut, trim and change this reel in the video editor (E). "Back to reels" brings you back here.' }, icon('film', 15), 'Edit video', kbd('E'))
    : h('a', { class: 'btn quiet', href, title: 'Open this post in the editor' }, icon('external', 14), 'Open in editor', kbd('E'));
  // an imported reel (made outside Nordle) is a finished file with no timeline behind it: say so where the button would be
  const noTimeline = !post.docId && post.format === 'reel' ? h('span', { class: 'muted no-timeline', 'data-state': 'no-timeline' }, 'Made outside Nordle, so there is no timeline to edit here.') : null;
  // the full editor in a window over this page: move a picture, resize, change words, without asking the designer
  const editNow = canEditHere(post) ? h('button', { class: 'btn', type: 'button', 'data-act': 'edit-here', title: 'Move, resize or change anything on this post, right here', onclick: async () => { if (await editHere(post)) afterAction?.(); } }, icon('cursor', 14), 'Edit here') : null;
  /** One click: schedule this post in Buffer, with its Story (untick "Story" to leave it out). The label says exactly when. */
  const oneClick = () => {
    const tick = h('input', { type: 'checkbox', checked: true, 'data-field': 'quick-story', 'aria-label': 'Also add a Story' });
    const label = h('span', {}, 'Schedule');
    const go = h('button', { class: 'btn go', type: 'button', 'data-act': 'schedule-one', onclick: async () => {
      go.disabled = true; label.textContent = 'Scheduling…';
      // scheduled: the sheet closes and the calendar is back, so the next post can be dealt with (a blocked post leaves it open)
      const ok = await quickSchedule(post, { story: tick.checked, afterAction: onResolved ?? afterAction });
      go.disabled = false; if (!ok) refresh();
    } }, icon('calendarSend', 14), label);
    async function refresh() {
      const t = await quickLabel(post, { story: tick.checked });
      label.textContent = t ?? 'Schedule';
      go.title = t ? `${t}${tick.checked ? ', with a Story' : ', without a Story'}. One click.` : 'Something needs a look first: the full window opens.';
    }
    tick.addEventListener('change', refresh);
    refresh();
    return h('span', { class: 'quick' }, go, h('label', { class: 'quick-story', title: 'Also post this as a Story on each Instagram and Facebook channel' }, tick, 'Story'));
  };
  const scheduleBtn = () => {
    const mine = accountsOf(post.project);
    return h('span', { class: 'sch-btn' }, quickReady() ? oneClick() : null, h('button', { class: `btn${quickReady() ? ' quiet' : ''}`, type: 'button', 'data-act': 'schedule', title: 'Choose the time, the cover, the accounts and more', onclick: () => openSchedule([post.uid], { onScheduled: onResolved ?? afterAction }) }, icon('calendarSend', 14), quickReady() ? 'Options…' : 'Schedule…'),
      mine && !mine.length ? h('button', { class: 'linklike', type: 'button', 'data-act': 'connect-account', onclick: () => openConnect('buffer') }, 'Connect an account') : null);
  };
  const rm = h('button', { class: 'btn quiet rm', type: 'button', 'data-act': 'remove', title: 'Remove this post (Delete)', onclick: () => done(() => act.removePosts([post])) }, icon('trash', 14), 'Remove');
  // split (the post sheet): the decisions go under the picture and its words; "Open in editor" and "Remove" stay in the dock at the bottom
  const wrap = (...kids) => {
    const list = kids.filter(Boolean);
    if (split) {
      const low = list.filter((k) => k === editor && !isVideo);
      return { decide: h('div', { class: 'acts decide', role: 'group', 'aria-label': 'Decide' }, list.filter((k) => !low.includes(k))), dock: h('div', { class: 'acts rest', role: 'group', 'aria-label': 'More' }, [...low, noTimeline, rm].filter(Boolean)) };
    }
    const body = compact && list.length > 2 ? [list[0], h('div', { class: 'row2' }, list.slice(1)), rm] : [...list, rm];
    return h('div', { class: `acts${compact ? ' compact' : ''}`, role: 'group', 'aria-label': 'Decide' }, body);
  };
  const s = post.status;
  if (s === 'scheduled') {
    const pub = d.item?.publish;
    const lines = publishLines(pub);
    const kids = [h('div', { class: 'acts-done' }, mark('scheduled'), 'Scheduled', pub && !lines.length ? h('span', { class: 'muted' }, ` via ${pub.adapter}${pub.scheduledAt ? ` for ${when(pub.scheduledAt)}` : ''}`) : null),
      lines.length ? h('ul', { class: 'sched-list', 'aria-label': 'Where it is scheduled' }, lines.map((l) => h('li', { class: l.ok ? '' : 'bad' }, serviceIcon(l.service), h('b', {}, l.name), h('span', { class: 'muted' }, l.ok ? (l.at ? when(l.at) : '') : l.message ?? 'Did not go')))) : null];
    if (pub?.adapter === 'buffer') kids.push(bufferCheck(post, afterAction, onResolved));
    if (split) return { decide: h('div', { class: 'acts sched decide', role: 'group', 'aria-label': 'Scheduled' }, kids), dock: h('div', { class: 'acts rest', role: 'group', 'aria-label': 'More' }, [editor, noTimeline].filter(Boolean)) };   // (a scheduled post cannot be removed: take it out of the schedule first)
    return h('div', { class: 'acts sched', role: 'group', 'aria-label': 'Scheduled' }, kids, editor);
  }
  if (post.needsReview || s === 'changes' || (s === 'signed-off' && !post.staleSignoff)) {
    const signed = s === 'signed-off' && !post.staleSignoff;
    const waiting = s === 'changes';
    const updated = post.revised && !signed && !waiting ? h('div', { class: 'acts-done updated', role: 'status', 'data-state': 'updated' }, icon('check', 16), `Updated${post.revisedAt ? ` ${when(post.revisedAt)}` : ''}. Have another look, then approve it or ask for more.`) : null;
    return wrap(
      updated,
      signed ? h('button', { class: 'btn approved', type: 'button', disabled: true, 'data-act': 'approved', 'aria-label': `Approved${d.approval ? ` ${when(d.approval.date)}` : ''}`, title: d.approval ? `Approved ${when(d.approval.date)}` : 'Already approved' }, icon('check', 16), 'Approved', d.approval ? h('span', { class: 'ap-when' }, when(d.approval.date)) : null)
        : waiting ? h('div', { class: 'sent' }, h('div', { class: `acts-done muted${post.reviseFailed ? ' bad' : ''}`, role: 'status', 'data-state': post.reviseFailed ? 'failed' : 'waiting' }, designerLine(d, post)), sentNote(d))
          : h('button', { class: 'btn go', 'data-act': 'approve', onclick: () => decided(() => act.approve(post)) }, icon('check', 16), 'Approve', kbd('A')),
      h('button', { class: 'btn ask', 'data-act': 'changes', onclick: () => done(() => act.requestChanges(post)) }, s === 'changes' ? 'Ask again' : 'Request changes', kbd('X')),   // only the comment window closes: the post stays open, and its comments show where they stand
      editNow,
      isVideo ? editor : null,
      signed ? scheduleBtn() : null,
      signed ? autoNote(post) : null,
      signed && publishLines(d.item?.publish).length ? h('ul', { class: 'sched-list partial', 'aria-label': 'Partly scheduled' }, publishLines(d.item?.publish).map((l) => h('li', { class: l.ok ? '' : 'bad' }, serviceIcon(l.service), h('b', {}, l.name), h('span', { class: 'muted' }, l.ok ? `Scheduled ${l.at ? when(l.at) : ''}` : `Did not go: ${l.message ?? ''}`)))) : null,
      post.calendar ? h('button', { class: 'btn nope', 'data-act': 'reject', onclick: () => decided(() => act.reject(post)) }, 'Reject', kbd('R')) : null,
      compact || isVideo ? null : editor);
  }
  if (s === 'idea') {
    return wrap(
      h('button', { class: 'btn go', 'data-act': 'idea-approve', onclick: () => decided(() => act.approveIdea(post)) }, icon('check', 16), 'Approve idea', kbd('A')),
      h('button', { class: 'btn ask', 'data-act': 'idea-edit', onclick: () => done(() => act.editIdea(post, d)) }, 'Edit', kbd('X')),
      h('button', { class: 'btn nope', 'data-act': 'idea-reject', onclick: () => decided(() => act.rejectIdea(post)) }, 'Reject', kbd('R')));
  }
  if (s === 'rejected') return wrap(h('button', { class: 'btn', 'data-act': 'reopen', onclick: () => done(() => act.reopen(post)) }, 'Reopen this post'));
  if (s === 'building' && post.revising) {
    return wrap(h('div', { class: 'sent' }, post.build?.active ? buildLine(post) : h('div', { class: 'acts-done muted revising', role: 'status', 'data-state': 'revising' }, h('i', { class: 'spin', 'aria-hidden': 'true' }), designerLine(d, post)), sentNote(d)), editor);
  }
  if (s === 'approved' || s === 'building') {
    return wrap(post.build ? buildLine(post) : h('div', { class: 'acts-done muted' }, s === 'approved' ? 'Approved. Waiting to be built.' : 'Being built. Nothing to review yet.'),
      post.build && !post.build.active ? h('button', { class: 'btn go', 'data-act': 'build-now', onclick: async (e) => { e.currentTarget.disabled = true; try { await api.post(`/projects/${encodeURIComponent(post.project)}/calendar/run`, { action: 'build', item: post.itemId }); notify('Claude is on it. This page shows when it starts and when it is done.', { kind: 'ok' }); await load({ force: true }); } catch (err) { notify(err.message, { kind: 'error' }); e.currentTarget.disabled = false; } } }, icon('check', 16), 'Build it now') : null,
      h('button', { class: 'btn nope', 'data-act': 'idea-reject', onclick: () => decided(() => act.rejectIdea(post)) }, 'Drop it'), editor);
  }
  return wrap(h('div', { class: 'acts-done muted' }, s === 'posted' ? 'Posted.' : ''), editor);
}

/** Where a scheduled post is going: one line per account, with its time. */
export function publishLines(pub) {
  if (!pub) return [];
  const names = new Map();
  for (const a of pubState.adapters) { for (const c of a.channels ?? []) names.set(c.id, c); for (const acc of a.accounts ?? []) for (const c of acc.channels ?? []) names.set(c.id, c); }
  const list = pub.targets ?? pub.accounts;
  if (Array.isArray(list) && list.length) {
    return list.map((x) => { const id = typeof x.channel === 'string' ? x.channel : x.channel?.id ?? x.id; const c = names.get(id); return { name: x.name ?? c?.name ?? id ?? pub.adapter, service: x.service ?? c?.service, at: x.scheduledAt ?? x.when ?? x.at, ok: x.ok !== false, message: x.message ? plainWaits(x.message) : x.message }; });
  }
  return pub.scheduledAt ? [{ name: pub.adapter ?? 'Scheduled', service: null, at: pub.scheduledAt, ok: true }] : [];
}

/** Can the words of this post be changed here? A built post (its document) or one imported with its pictures; not an idea with nothing written. */
const canEditCaption = (d, post) => !!post.docId || !!d.item?.external;

/**
 * The caption, with an Edit button. Edit turns it into a box (Ctrl+Enter saves, Esc cancels). A post that is approved, or already
 * scheduled in a service, says what changing the words means before it is saved. `onChanged` redraws whatever is showing the post.
 */
export function caption(d, post, { onChanged } = {}) {
  const c = d.copy;
  const editable = canEditCaption(d, post);
  const body = h('div', {});
  const aside = h('span', { class: 'cap-aside' });
  const root = blk('Caption', body, { cls: 'cap', aside });
  const total = [c.caption, c.cta, c.hashtags.join(' ')].filter(Boolean).join('\n\n').length;
  const over = total > c.limit;
  const alts = Object.entries(c.alt ?? {});
  const editBtn = editable ? h('button', { class: 'btn quiet sm cap-edit', type: 'button', 'data-act': 'edit-caption', title: 'Change the words of this post', onclick: () => edit() }, icon('cursor', 13), 'Edit') : null;

  function show() {
    aside.replaceChildren(...[h('span', { class: `count${over ? ' over' : ''}`, title: `Caption, call to action and hashtags together. Shortest limit for this post: ${c.limit}.` }, `${total.toLocaleString('en-AU')} of ${c.limit.toLocaleString('en-AU')}`), editBtn].filter(Boolean));
    if (!c.caption && !c.hashtags.length) { body.replaceChildren(h('p', { class: 'muted' }, post.status === 'idea' ? 'No caption yet: it is written when the post is built.' : 'No caption written yet.')); return; }
    body.replaceChildren(...[
      c.caption ? captionText(c.caption, d.item?.hook || post.hook) : null,
      c.cta && !c.caption.includes(c.cta) ? h('p', { class: 'cap-cta' }, h('span', { class: 'lbl-i' }, 'Call to action'), c.cta) : null,
      c.hashtags.length ? h('div', { class: 'tags' }, c.hashtags.map((t) => h('span', { class: 'tag' }, t))) : null,
      alts.length ? h('details', { class: 'alt' }, h('summary', {}, `Alt text (${alts.length})`), h('ul', {}, alts.map(([k, v]) => h('li', {}, h('b', {}, `${k}: `), v)))) : null].filter(Boolean));
  }

  function edit() {
    const area = h('textarea', { class: 'field cap-area', rows: Math.min(18, Math.max(5, String(c.caption).split('\n').length + 2)), 'aria-label': 'Caption', 'data-field': 'caption-edit', maxlength: 5000 });
    area.value = c.caption ?? '';
    const note = h('p', { class: 'cap-warn', role: 'status' });
    const signed = post.status === 'signed-off' && !post.staleSignoff;
    const scheduled = post.status === 'scheduled' || post.status === 'posted';
    if (scheduled) note.textContent = 'This post is already in a publishing service. It keeps the words it was given, so change them there too.';
    else if (signed) note.textContent = 'This post is approved. If you change the words, you will need to approve it again.';
    note.classList.toggle('hidden', !note.textContent);
    const count = h('span', { class: 'muted cap-count' });
    const extra = [c.cta && !String(c.caption ?? '').includes(c.cta) ? c.cta : '', c.hashtags.join(' ')].filter(Boolean).join('\n\n');
    const paint = () => { const n = [area.value.trim(), extra].filter(Boolean).join('\n\n').length; count.textContent = `${n.toLocaleString('en-AU')} of ${c.limit.toLocaleString('en-AU')}`; count.classList.toggle('over', n > c.limit); };
    area.addEventListener('input', paint);
    area.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); save(); } else if (e.key === 'Escape') { e.preventDefault(); show(); } e.stopPropagation(); });
    area.addEventListener('keyup', (e) => e.stopPropagation());
    const saveBtn = h('button', { class: 'btn go sm', type: 'button', 'data-act': 'caption-save', onclick: () => save() }, icon('check', 14), 'Save caption');
    async function save() {
      saveBtn.disabled = true;
      try {
        const r = await api.post('/studio/caption', { uid: post.uid, text: area.value });
        if (!r.changed) { show(); return; }
        forgetDetail(post.uid);
        await load({ force: true });
        notify(scheduled ? 'Caption saved here. Change it in the publishing service too.' : signed ? 'Caption saved. It needs approving again.' : 'Caption saved.', { kind: 'ok' });
        onChanged?.();
      } catch (e) { note.textContent = e.message; note.classList.remove('hidden'); saveBtn.disabled = false; }
    }
    aside.replaceChildren(count);
    paint();
    body.replaceChildren(area, note, h('div', { class: 'cap-acts' }, saveBtn, h('button', { class: 'btn quiet sm', type: 'button', 'data-act': 'caption-cancel', onclick: () => show() }, 'Cancel'), h('span', { class: 'muted cap-hint' }, 'Ctrl+Enter saves')));
    area.focus();
  }

  show();
  return root;
}

export function why(d, post, { collapsed = false } = {}) {
  const it = d.item;
  const b = d.brief;
  const rows = [];
  const dl = (k, v) => v && (Array.isArray(v) ? v.length : true) && rows.push(h('div', { class: 'kv' }, h('dt', {}, k), h('dd', {}, Array.isArray(v) ? v.join(' · ') : v)));
  dl('Audience', b?.audience ?? it?.audience);
  dl('Message', b?.message);
  dl('Goal', b?.goal);
  dl('Tone', b?.tone);
  dl('Must include', b?.mustInclude);
  dl('Must avoid', b?.mustAvoid);
  dl('Occasion', it?.occasion);
  dl('Photos and footage', it?.mediaPlan);
  dl('How the reel is made', it?.reel ? (reelSummary(it.reel) ?? 'Auto') : null);
  dl('Extra info', it?.guidance);
  const idea = it?.idea ?? post.idea;
  if (!idea && !rows.length) return null;
  const body = h('div', {}, idea ? h('p', { class: 'why-idea' }, idea) : null, it?.hook ? h('p', { class: 'why-hook' }, h('span', { class: 'lbl-i' }, 'Hook'), it.hook) : null, rows.length ? h('dl', { class: 'kvs' }, rows) : null, it?.notes ? h('p', { class: 'muted why-notes' }, it.notes) : null);
  if (!collapsed) return blk('Why this post', body, { cls: 'why' });
  return h('details', { class: 'blk why fold-blk' }, h('summary', { class: 'blk-h' }, h('h3', { class: 'lbl' }, 'Why this post'), h('span', { class: 'count' }, 'brief and idea')), body);
}

const CK = { pass: 'Passed', warn: 'To look at', fail: 'Failed', missing: 'Not done yet', skipped: 'Skipped' };
const ckMark = (status) => h('span', { class: `ck ck-${status}`, title: CK[status] }, h('i', { 'aria-hidden': 'true' }), h('span', { class: 'sr' }, CK[status]));

function checkRow(r) {
  const body = [];
  if (r.status === 'missing') {
    body.push(h('p', { class: 'ck-sum' }, `Waiting for ${r.who.toLowerCase()}.`, r.staleFrom ? ` An earlier check on an older version ${r.staleFrom.status === 'pass' ? 'passed' : r.staleFrom.status === 'fail' ? 'failed' : 'ran'}, but the post has changed since.` : ''));
  } else {
    if (r.summary) body.push(h('p', { class: 'ck-sum' }, r.summary));
    for (const f of r.findings ?? []) body.push(h('p', { class: `ck-find ${f.level ?? ''}` }, f.page ? h('b', {}, `${f.page}: `) : null, f.message, f.fix ? h('span', { class: 'ck-fix' }, ` Fix: ${f.fix}`) : null));
  }
  return h('li', { class: `ck-row ck-r-${r.status}` }, ckMark(r.status),
    h('div', { class: 'ck-main' }, h('div', { class: 'ck-top' }, h('span', { class: 'ck-name' }, r.label), h('span', { class: 'ck-who' }, r.who, r.at && r.status !== 'missing' ? ` · ${when(r.at)}` : '')), ...body));
}

export function checks(d, post, { open = false } = {}) {
  if (!d.checks) {
    return blk('Checks', h('p', { class: 'muted' }, post.external ? 'This post was made outside Nordle, so there is no check record. Look at it closely.' : 'There is no document to check yet.'), { cls: 'chk' });
  }
  const rows = d.checks.rows;
  const rank = { fail: 0, missing: 1, warn: 2, pass: 3, skipped: 3 };
  const attention = rows.filter((r) => rank[r.status] < 3).sort((a, b) => rank[a.status] - rank[b.status]);
  const passed = rows.filter((r) => rank[r.status] === 3);
  const c = post.checks;
  const headline = d.checks.verified
    ? h('p', { class: 'chk-line good' }, mark('signed'), `All ${c.total} required checks are done and passed.`)
    : h('p', { class: 'chk-line bad' }, mark('built'), [c.fail && `${c.fail} failed`, c.missing && `${c.missing} not done yet`, c.warn && `${c.warn} to look at`].filter(Boolean).join(' · ') || 'Not verified');
  const crit = d.critique;
  const score = crit && crit.score !== null
    ? h('div', { class: `crit ${crit.score >= crit.pass ? 'good' : 'low'}`, title: `Design score. The pass mark is ${crit.pass}.` }, h('span', { class: 'crit-n' }, String(crit.score)), h('span', { class: 'crit-l' }, `design score${crit.stale ? ' (older version)' : ''}`, h('span', { class: 'crit-pass' }, `pass mark ${crit.pass}`)))
    : null;
  return blk('Checks', h('div', {},
    h('div', { class: 'chk-head' }, headline, score),
    attention.length ? h('ul', { class: 'ck-list' }, attention.map(checkRow)) : null,
    passed.length ? h('details', { class: 'ck-passed', open }, h('summary', {}, `${passed.length} passed`), h('ul', { class: 'ck-list' }, passed.map(checkRow))) : null),
  { cls: 'chk', id: 'checks' });
}

export function pairs(d, post) {
  if (!d.pairs) return null;
  const p = d.pairs;
  const row = (x) => {
    const img = x.mediaThumb ?? x.pageThumb;
    return h('li', { class: `pair pair-${x.verdict}` },
      img ? h('span', { class: 'pair-img' }, h('img', { src: thumbUrl(post.project, img, 160), alt: '', loading: 'lazy', decoding: 'async' })) : h('span', { class: 'pair-img none' }, x.media ? h('span', {}, x.media.length > 18 ? `${x.media.slice(0, 16)}…` : x.media) : null),
      h('div', { class: 'pair-words' }, h('span', { class: 'lbl-i' }, 'The words say'), h('p', {}, x.words || '–')),
      h('div', { class: 'pair-shows' }, h('span', { class: 'lbl-i' }, 'The picture shows'), h('p', {}, x.shows || '–'), x.note ? h('p', { class: 'pair-note' }, x.note) : null),
      h('span', { class: `verdict v-${x.verdict}` }, x.verdict === 'match' ? 'Match' : x.verdict === 'mismatch' ? 'Mismatch' : 'Unsure'));
  };
  const bad = p.items.filter((x) => x.verdict !== 'match').length;
  return blk('Words and pictures', h('ul', { class: 'pairs' }, p.items.map(row)), {
    cls: 'prs',
    aside: h('span', { class: `count${bad ? ' over' : ''}` }, bad ? `${bad} of ${p.items.length} to look at` : `${p.items.length} match`),
  });
}

export function comments(d, post) {
  const list = d.comments ?? [];
  const open = list.filter((c) => c.status === 'open');
  const body = list.length
    ? h('ul', { class: 'cmts' }, [...open, ...list.filter((c) => c.status !== 'open')].map((c) => h('li', { class: `cmt ${c.status}` },
      h('div', { class: 'cmt-h' }, h('b', {}, c.author === 'claude' ? 'Designer' : 'You'), h('span', { class: 'muted' }, ` · ${c.pageTitle || c.page} · ${when(c.created)}`), c.status === 'resolved' ? h('span', { class: 'cmt-done' }, 'resolved') : null),
      h('p', {}, c.text),
      (c.replies ?? []).map((r) => h('p', { class: 'cmt-reply' }, h('b', {}, r.author === 'claude' ? 'Designer' : 'You'), `: ${r.text}`)))))
    : h('p', { class: 'muted' }, 'No comments. “Request changes” writes one here and sends the post back.');
  return blk('Comments', body, { cls: 'cmt-blk', aside: open.length ? h('span', { class: 'count over' }, `${open.length} open`) : null });
}

export function history(d, post) {
  const events = [];
  for (const v of d.versions ?? []) events.push({ at: v.created, text: `Saved ${v.name}${v.note ? `: ${v.note}` : ''}`, who: v.author === 'claude' ? 'Designer' : 'You' });
  for (const a of d.approvals ?? []) {
    events.push({ at: a.date, text: `Signed off${a.note ? `: ${a.note}` : ''}`, who: a.by === 'human' ? 'You' : a.by });
    if (a.revoked) events.push({ at: a.revoked, text: 'Sign-off withdrawn', who: 'You' });
  }
  events.sort((a, b) => b.at.localeCompare(a.at));
  const pending = d.pendingChanges ?? [];
  if (!events.length && !pending.length && d.docV === null) return null;
  return blk('History', h('div', {},
    pending.length ? h('p', { class: 'hist-pending' }, `The designer has ${plural(pending.length, 'change')} waiting for you in the editor.`) : null,
    events.length ? h('ul', { class: 'hist' }, events.slice(0, 8).map((e) => h('li', {}, h('span', { class: 'hist-t' }, when(e.at)), h('span', {}, `${e.who}: ${e.text}`)))) : h('p', { class: 'muted' }, 'No saved versions or sign-offs yet.'),
    d.docV !== null ? h('p', { class: 'muted hist-v' }, `Document version ${d.docV}${post.builtAt ? ` · built ${dateFmt.ago(post.builtAt)}` : ''}`) : null), { cls: 'hist-blk' });
}

export const loadingBlock = () => h('div', { class: 'skel-detail', 'aria-hidden': 'true' }, h('i', { class: 'sk-media' }), h('b', {}), h('b', {}), h('b', { style: { width: '60%' } }));
export const errorBlock = (message, retry) => emptyState({ title: 'This post would not open', body: message, tone: 'bad', action: h('button', { class: 'btn', onclick: retry }, 'Try again') });
export { statusOf };
