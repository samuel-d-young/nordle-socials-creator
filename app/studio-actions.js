// The owner's decisions in the Studio. Each one asks the server (which writes the review file and the calendar), updates the
// page at once, and offers Undo. Only the page's own (owner) token can do these; Claude's token is refused by the server.

import { api } from './api.js';
import { h, dialog } from './dom.js';
import { S, update, patchPost, load, project, dateFmt } from './studio-store.js';
import { askConfirm, askText, notify, plural, FORMAT_LABEL } from './studio-ui.js';
import { reelOptions } from './studio-reel.js';

const short = (t, n = 48) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

function remember(tokens, label) {
  update({ undo: [...S.undo, { tokens: [].concat(tokens).filter(Boolean), label }].slice(-30) });
}

async function send(body) {
  const r = await api.post('/studio/act', body);
  patchPost(r.post);
  load({ force: true });
  return r;
}

function checkList(c) {
  const bits = [];
  if (c?.fail) bits.push(`${plural(c.fail, 'check')} failed`);
  if (c?.missing) bits.push(`${plural(c.missing, 'check')} not done yet`);
  return bits.join(' and ') || 'Some checks are not complete';
}

/** Sign a post off. Asks first if its checks are not all done and passed. Resolves true when it was signed off. */
export async function approve(post, { quiet = false } = {}) {
  let force = false;
  for (;;) {
    try {
      const r = await send({ uid: post.uid, action: 'approve', force });
      if (r.already) {   // it was signed off already: nothing new to undo
        if (!quiet) notify(r.healed ? `“${short(post.title)}” said signed off but had no approval on record. It is signed off properly now.` : `“${short(post.title)}” is already signed off. Nothing to change.`, { kind: 'ok', ...(r.undo ? { action: { label: 'Undo', key: 'U', fn: undoLast } } : {}) });
        if (r.undo) remember(r.undo, `Signed off “${short(post.title)}”`);
        return true;
      }
      remember(r.undo, `Signed off “${short(post.title)}”`);
      if (!quiet) notify(`Signed off “${short(post.title)}”.`, { kind: 'ok', action: { label: 'Undo', key: 'U', fn: undoLast } });
      return true;
    } catch (e) {
      if (e.status === 409 && e.body?.needsConfirm && !force) {
        const ok = await askConfirm({
          title: 'This post is not fully checked',
          body: `${checkList(e.body.checks)}. Sign it off anyway? The record will say you decided this yourself.`,
          ok: 'Sign off anyway',
        });
        if (!ok) return false;
        force = true;
        continue;
      }
      notify(e.message, { kind: 'error' });
      return false;
    }
  }
}

const clockOf = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const whereOf = (c) => (typeof c.time === 'number' ? `at ${clockOf(c.time)}` : c.general ? 'whole post' : c.page === 'video' ? 'video' : String(c.page).replace(/^slide-/, 'slide '));

/** The open comments you have already written, then a box for anything else. Resolves the extra note ('' when the comments are enough) or null. */
async function askChanges(post, comments) {
  let area;
  const r = await dialog({
    title: 'Request changes',
    build: (body, finish) => {
      area = h('textarea', { class: 'field ask-area', rows: 4, placeholder: comments.length ? 'Optional. The comments above go with it.' : 'For example: shorter caption, and use the photo of the counter on the second page.', 'aria-label': comments.length ? 'Anything else?' : 'What should change?', maxlength: 4000 });
      area.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); if (comments.length || area.value.trim()) finish('ok'); } });
      body.append(
        h('p', { class: 'muted ask-intro' }, `“${short(post.title, 70)}” goes back to the designer.`),
        comments.length ? h('div', { class: 'ask-comments' }, h('b', {}, `Your ${plural(comments.length, 'comment')} go with it`),
          h('ul', {}, comments.map((c) => h('li', {}, h('span', { class: 'ask-where' }, whereOf(c)), c.text)))) : null,
        h('label', { class: 'ask-label' }, comments.length ? 'Anything else? (optional)' : 'What should change?'), area, h('p', { class: 'ask-hint muted' }, 'Ctrl+Enter to send'));
    },
    onOpen: () => area.focus(),
    actions: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: comments.length ? `Send back with ${plural(comments.length, 'comment')}` : 'Send back', primary: true }],
  });
  if (r !== 'ok') return null;
  const text = area.value.trim();
  return !comments.length && !text ? null : text;
}

/** Ask what should change (your open comments are listed and go too), then send the post back to the designer. */
export async function requestChanges(post) {
  let comments = [];
  try {
    const { fetchDetail } = await import('./studio-detail.js');
    comments = ((await fetchDetail(post))?.comments ?? []).filter((c) => c.status === 'open' && c.author !== 'claude');
  } catch { /* without the list it still works: the server adds the open comments itself */ }
  const text = await askChanges(post, comments);
  if (text === null) return false;
  try {
    const r = await send({ uid: post.uid, action: 'changes', text });
    if (!r.queued) remember(r.undo, `Asked for changes on “${short(post.title)}”`);
    notify(r.queued ? `Queued: Claude is working on “${short(post.title)}” right now, so your change goes next and starts by itself.` : `Sent back “${short(post.title)}”${r.sent ? ` with ${plural(r.sent, 'comment')}` : ''}.${r.revising ? ' Claude is making the change now.' : ''}`, { kind: 'ok', ...(r.queued ? {} : { action: { label: 'Undo', key: 'U', fn: undoLast } }) });
    return true;
  } catch (e) { notify(e.message, { kind: 'error' }); return false; }
}

export async function reject(post) {
  if (!post.calendar) { notify('This post is not on a calendar, so it cannot be rejected here. Ask for changes instead.', { kind: 'error' }); return false; }
  const text = await askText({
    title: 'Reject this post?',
    intro: `“${short(post.title, 70)}” will leave the plan. You can bring it back with Undo.`,
    label: 'Why? (optional)',
    ok: 'Reject',
    danger: true,
    required: false,
  });
  if (text === null) return false;
  try {
    const r = await send({ uid: post.uid, action: 'reject', text });
    remember(r.undo, `Rejected “${short(post.title)}”`);
    notify(`Rejected “${short(post.title)}”.`, { kind: 'info', action: { label: 'Undo', key: 'U', fn: undoLast } });
    return true;
  } catch (e) { notify(e.message, { kind: 'error' }); return false; }
}

export async function reopen(post) {
  try {
    const r = await send({ uid: post.uid, action: 'reopen' });
    remember(r.undo, `Reopened “${short(post.title)}”`);
    notify(`Reopened “${short(post.title)}”.`, { kind: 'ok', action: { label: 'Undo', key: 'U', fn: undoLast } });
    return true;
  } catch (e) { notify(e.message, { kind: 'error' }); return false; }
}

export async function undoLast() {
  const last = S.undo.at(-1);
  if (!last) { notify('Nothing to undo.', { kind: 'info' }); return false; }
  update({ undo: S.undo.slice(0, -1) });
  if (last.restore) {
    try {
      for (const id of last.restore) await api.post('/studio/restore', { id });
      await load({ force: true });
      notify(`Undone: ${last.label}.`, { kind: 'info' });
      return true;
    } catch (e) { notify(`Could not undo: ${e.message}`, { kind: 'error' }); await load({ force: true }); return false; }
  }
  try {
    const r = await api.post('/studio/act', { action: 'undo', tokens: last.tokens });
    patchPost(r.post);
    await load({ force: true });
    notify(`Undone: ${last.label}.`, { kind: 'info' });
    return true;
  } catch (e) { notify(`Could not undo: ${e.message}`, { kind: 'error' }); await load({ force: true }); return false; }
}

// ---- ideas --------------------------------------------------------------------------------------------------------------------

export async function approveIdea(post) {
  try {
    const r = await send({ uid: post.uid, action: 'idea-approve' });
    remember(r.undo, `Approved the idea “${short(post.title)}”`);
    notify(`Idea approved: “${short(post.title)}”. It will be built as its date gets close.`, { kind: 'ok', action: { label: 'Undo', key: 'U', fn: undoLast } });
    return true;
  } catch (e) { notify(e.message, { kind: 'error' }); return false; }
}

export async function rejectIdea(post) {
  try {
    const r = await send({ uid: post.uid, action: 'idea-reject' });
    remember(r.undo, `Rejected the idea “${short(post.title)}”`);
    notify(`Idea rejected: “${short(post.title)}”.`, { kind: 'info', action: { label: 'Undo', key: 'U', fn: undoLast } });
    return true;
  } catch (e) { notify(e.message, { kind: 'error' }); return false; }
}

export async function editIdea(post, detail) {
  const item = detail?.item ?? {};
  const pr = project(post.project);
  const f = {
    title: h('input', { class: 'field', value: item.title ?? post.title, maxlength: 140, 'aria-label': 'Title' }),
    date: h('input', { class: 'field', type: 'date', value: item.date ?? post.date ?? '', 'aria-label': 'Date' }),
    format: h('select', { class: 'field', 'aria-label': 'Format' }, Object.entries(FORMAT_LABEL).map(([v, l]) => h('option', { value: v, selected: v === (item.format ?? post.format) }, l))),
    pillar: h('select', { class: 'field', 'aria-label': 'Pillar' }, h('option', { value: '' }, 'No pillar'), (pr?.settings.pillars ?? []).map((p) => h('option', { value: p.id, selected: p.id === (item.pillar ?? post.pillar) }, p.name))),
    idea: h('textarea', { class: 'field', rows: 4, value: item.idea ?? post.idea ?? '', 'aria-label': 'The idea' }),
    hook: h('input', { class: 'field', value: item.hook ?? post.hook ?? '', 'aria-label': 'Hook' }),
    mediaPlan: h('textarea', { class: 'field', rows: 2, value: item.mediaPlan ?? '', 'aria-label': 'Photos and footage' }),
    guidance: h('textarea', { class: 'field', rows: 3, value: item.guidance ?? '', maxlength: 2000, placeholder: 'Anything that should steer it: who to feature, what to stress, what to avoid, a look to follow.', 'aria-label': 'Extra information' }),
  };
  let reel = item.reel ?? null;
  const reelBox = h('div', { class: 'grow', 'data-field': 'reel-box' });
  const showReel = () => reelBox.replaceChildren(...(f.format.value === 'reel' ? [reelOptions({ value: reel, onChange: (r) => { reel = r; } })] : []));
  f.format.addEventListener('change', showReel);
  showReel();
  const row = (label, el) => h('div', { class: 'row edit-row' }, h('label', {}, label), h('div', { class: 'grow' }, el));
  const r = await dialog({
    title: 'Edit the idea',
    build: (body) => body.append(row('Title', f.title), row('Date', f.date), row('Format', f.format), row('Pillar', f.pillar), row('The idea', f.idea), row('Hook', f.hook), row('Media', f.mediaPlan), h('div', { class: 'row edit-row', 'data-field': 'reel-row' }, h('label', {}, 'Reel'), reelBox), row('Extra info', f.guidance)),
    onOpen: () => f.title.focus(),
    actions: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'Save', primary: true }],
  });
  if (r !== 'ok') return false;
  const fields = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value]));
  if (fields.format === 'reel') fields.reel = reel; else if (item.reel) fields.reel = null;
  if (!fields.title.trim()) { notify('Give it a title.', { kind: 'error' }); return false; }
  if (!fields.date) delete fields.date;
  try {
    const res = await send({ uid: post.uid, action: 'edit', fields });
    remember(res.undo, `Edited “${short(post.title)}”`);
    notify('Saved.', { kind: 'ok', action: { label: 'Undo', key: 'U', fn: undoLast } });
    return true;
  } catch (e) { notify(e.message, { kind: 'error' }); return false; }
}

/** Can this post be moved to another day? Not once it is scheduled in the service, has gone out, or was rejected. */
export const canMove = (p) => !!p?.date && !['scheduled', 'posted', 'rejected'].includes(p.status);

/** Move a post to another date (dragged to a day on the month view). Its time, words and pictures stay as they are. */
export async function moveDate(post, date) {
  if (!date || date === post.date) return false;
  if (!canMove(post)) { notify(post.status === 'rejected' ? 'A rejected post stays where it is. Reopen it first.' : `“${short(post.title)}” is already ${post.status === 'posted' ? 'posted' : 'scheduled'}, so it cannot move.`, { kind: 'info' }); return false; }
  const was = post.date;
  try {
    const r = await send({ uid: post.uid, action: 'edit', fields: { date } });
    remember(r.undo, `Moved “${short(post.title)}” to ${dateFmt.day(date)}`);
    const month = was?.slice(0, 7) !== date.slice(0, 7);
    notify(`Moved “${short(post.title)}” to ${dateFmt.day(date)}.${month ? ' It is in another month now: run its checks again (the same photo may not repeat within a month).' : ''}`, { kind: 'ok', ms: month ? 9000 : undefined, action: { label: 'Undo', key: 'U', fn: undoLast } });
    return true;
  } catch (e) { notify(e.message, { kind: 'error' }); return false; }
}

// ---- many at once --------------------------------------------------------------------------------------------------------------

export const eligibleForBulk = (p) => p.needsReview && p.verified === true && !p.openComments;

/** Sign off the ticked posts that are fully verified. Asks first and says what it will leave out and why. */
export async function bulkApprove(uids) {
  const posts = uids.map((u) => S.byUid.get(u)).filter(Boolean);
  const ok = posts.filter(eligibleForBulk);
  const left = posts.filter((p) => !eligibleForBulk(p));
  if (!ok.length) { notify('None of these can be signed off in one go. They need a person to look: checks are not all done, or there are open comments.', { kind: 'error' }); return false; }
  const why = (p) => (!p.needsReview ? 'not waiting for sign-off' : p.verified !== true ? 'checks not complete' : 'open comments');
  const details = h('div', { class: 'bulk-list' },
    h('ul', {}, ok.slice(0, 8).map((p) => h('li', {}, h('b', {}, short(p.title, 44)), h('span', { class: 'muted' }, ` · ${p.date ?? 'no date'}`)))),
    ok.length > 8 ? h('p', { class: 'muted' }, `and ${ok.length - 8} more`) : null,
    left.length ? h('p', { class: 'bulk-left' }, `Left out (${left.length}): ${left.slice(0, 4).map((p) => `${short(p.title, 28)} (${why(p)})`).join('; ')}${left.length > 4 ? '…' : ''}`) : null);
  const go = await askConfirm({
    title: `Sign off ${plural(ok.length, 'post')}?`,
    body: 'Each one has every required check done and passed, and no open comments. This signs off what you have not looked at one by one.',
    ok: `Sign off ${ok.length}`,
    details,
  });
  if (!go) return false;
  try {
    const r = await api.post('/studio/bulk', { uids: ok.map((p) => p.uid), onlyVerified: true });
    if (r.undo.length) remember(r.undo, `Signed off ${plural(r.done.length, 'post')}`);
    update({ picked: new Set() });
    await load({ force: true });
    notify(`Signed off ${plural(r.done.length, 'post')}${r.skipped.length ? `; ${r.skipped.length} left for you to look at` : ''}.`, { kind: 'ok', action: r.undo.length ? { label: 'Undo', key: 'U', fn: undoLast } : undefined });
    return true;
  } catch (e) { notify(e.message, { kind: 'error' }); return false; }
}

// ---- removing (to the trash, never deleted) ----------------------------------------------------------------------------------------

/** Ask, move the posts to the trash, and offer Undo. Resolves true if they were removed. */
export async function removePosts(posts) {
  const list = posts.filter(Boolean);
  if (!list.length) return false;
  const n = list.length;
  const details = h('div', { class: 'bulk-list' },
    h('ul', {}, list.slice(0, 8).map((p) => h('li', {}, h('b', {}, short(p.title, 46)), h('span', { class: 'muted' }, ` · ${p.date ?? 'no date'}`)))),
    n > 8 ? h('p', { class: 'muted' }, `and ${n - 8} more`) : null);
  const go = await askConfirm({
    title: n === 1 ? 'Remove this post?' : `Remove ${n} posts?`,
    body: 'They leave the calendar, and their files move to the project’s trash folder. Nothing is deleted: you can bring them back from Undo, or from the Trash page.',
    ok: n === 1 ? 'Remove post' : `Remove ${n} posts`,
    danger: true,
    details,
  });
  if (!go) return false;
  try {
    const r = await api.post('/studio/remove', { uids: list.map((p) => p.uid) });
    const ids = r.removed.map((x) => x.id);
    if (ids.length) update({ undo: [...S.undo, { restore: ids, label: `Removed ${plural(ids.length, 'post')}` }].slice(-30) });
    update({ picked: new Set(), open: false });
    await load({ force: true });
    if (r.failed.length) notify(`${r.failed.length} could not be removed: ${r.failed[0].reason}`, { kind: 'error' });
    if (ids.length) notify(ids.length === 1 ? `Removed “${short(r.removed[0].title)}”.` : `Removed ${ids.length} posts.`, { kind: 'info', action: { label: 'Undo', key: 'U', fn: undoLast }, ms: 10000 });
    return ids.length > 0;
  } catch (e) { notify(e.message, { kind: 'error' }); return false; }
}

export async function restoreFromTrash(id, label = 'it') {
  try {
    const r = await api.post('/studio/restore', { id });
    await load({ force: true });
    notify(`Restored “${short(r.title ?? label)}”.`, { kind: 'ok' });
    return true;
  } catch (e) { notify(e.message, { kind: 'error' }); return false; }
}

/** The typed-name confirmation. Moves the whole brand folder to the projects trash; Undo restores it. */
export async function removeBrand(brand, { afterChange } = {}) {
  const name = brand.name;
  let input;
  const r = await dialog({
    title: `Remove ${name}?`,
    build: (body) => {
      input = h('input', { class: 'field', placeholder: name, 'aria-label': 'Type the brand name to confirm', autocomplete: 'off', spellcheck: 'false', 'data-field': 'confirm-name' });
      body.append(
        h('p', { class: 'ask-body' }, 'The brand disappears from Nordle, with all its posts, calendar and files. They are moved to a hidden trash folder next to your projects, not deleted, and you can restore them from the Trash page.'),
        h('label', { class: 'ask-label' }, 'Type the brand name ', h('b', { 'data-brand-name': '' }, name), ' to confirm'), input);
    },
    onOpen: (body) => {
      const go = body.closest('dialog').querySelector('.df .danger');
      go.disabled = true;
      input.addEventListener('input', () => { go.disabled = input.value.trim().toLowerCase() !== name.trim().toLowerCase(); });
      input.focus();
    },
    actions: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'Remove brand', danger: true }],
  });
  if (r !== 'ok') return false;
  try {
    const res = await api.post('/studio/remove-brand', { project: brand.id, confirm: input.value });
    if (S.brand === brand.id) update({ brand: 'all' });
    await load({ force: true });
    await afterChange?.();
    notify(`Removed ${res.name ?? name}. It is in the Trash.`, { kind: 'info', ms: 10000, action: { label: 'Undo', fn: async () => { try { await api.post('/studio/restore-brand', { id: res.id }); await load({ force: true }); await afterChange?.(); notify(`${name} is back.`, { kind: 'ok' }); } catch (e) { notify(e.message, { kind: 'error' }); } } } });
    return true;
  } catch (e) { notify(e.message, { kind: 'error' }); return false; }
}
