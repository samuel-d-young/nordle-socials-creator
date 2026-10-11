// What the owner can decide in the Studio: sign off, ask for changes, reject, the idea backlog (approve, reject, edit), undo, and a
// bulk sign-off of fully verified posts. Human-only (the route enforces it). Calendar changes go only through
// src/calendar/service.mjs (file lock, status rules); approvals and comments go to the review file the way the editor writes them.

import { calendarPath } from '../calendar/model.mjs';
import { CalendarError, decide, mutateCalendar, updateItem } from '../calendar/service.mjs';
import { newId } from '../server/store.mjs';
import { forget, locate, summaryFor } from './data.mjs';
import { openNotes } from './comments.mjs';

export class StudioError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

const undoLog = new Map();
function remember(record) {
  const token = newId('u');
  undoLog.set(token, { ...record, at: Date.now() });
  while (undoLog.size > 300) undoLog.delete(undoLog.keys().next().value);
  return token;
}

const now = () => new Date().toISOString();
const activeApproval = (review) => [...review.data.approvals].reverse().find((a) => !a.revoked) ?? null;

/** Run a service call; turn its errors into ours and make sure the next read sees the new file. */
async function svc(project, fn) {
  try { return await fn(); } catch (e) {
    if (e instanceof CalendarError) throw new StudioError(e.status, e.message);
    throw e;
  } finally { forget(calendarPath(project.dir)); }
}

const reviewFor = (project, docId) => (docId ? project.review(docId) : null);
const pageFor = (project, docId, wanted) => {
  const pages = project.doc(docId)?.doc?.pages ?? [];
  return wanted && pages.some((p) => p.id === wanted) ? wanted : pages[0]?.id ?? 'video';
};
const notBuilt = (s) => ['idea', 'approved', 'building'].includes(s);

// ---- the decisions --------------------------------------------------------------------------------------------------------------

async function approve(store, at, body) {
  const { project, item, docId } = at;
  const sum = summaryFor(store, at);
  if (sum.status === 'signed-off' && !sum.staleSignoff) {
    // Already signed off: make sure the records agree (the calendar says so, and the review file holds a live approval), then say so.
    // Pressing Approve again is never an error: it either confirms it or puts right whatever was missing.
    const review = reviewFor(project, docId);
    if (review && !activeApproval(review)) {
      const approvalId = review.approve({ by: 'human', note: typeof body.note === 'string' ? body.note.slice(0, 900) : '' }).approval.id;
      return { already: true, healed: true, undo: remember({ kind: 'approve', uid: body.uid, before: item ? structuredClone(item) : null, approvalId }) };
    }
    return { already: true, healed: false, undo: null };
  }
  if (sum.revising) throw new StudioError(409, 'Claude is still changing this post. It comes back for another look when it is done.');
  if (notBuilt(sum.status)) throw new StudioError(409, 'This post has not been built yet, so there is nothing to sign off.');
  if (sum.status === 'rejected') throw new StudioError(409, 'This post was rejected. Reopen it first.');
  if (sum.status === 'changes') throw new StudioError(409, 'This post was sent back for changes. It can be signed off when the designer has revised it.');
  if (sum.status === 'posted') throw new StudioError(409, 'This post has already gone out.');
  if (docId && sum.verified === false && !body.force) throw new StudioError(409, 'Some checks have not passed yet.', { needsConfirm: true, checks: sum.checks });
  const before = item ? structuredClone(item) : null;
  if (item && item.status !== 'signed-off') await svc(project, () => decide(project.dir, item.id, 'signoff'));
  const review = reviewFor(project, docId);
  const approvalId = review ? review.approve({ by: 'human', note: typeof body.note === 'string' ? body.note.slice(0, 900) : '' }).approval.id : null;
  return { undo: remember({ kind: 'approve', uid: body.uid, before, approvalId }) };
}

async function requestChanges(store, at, body) {
  const { project, item, docId } = at;
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const pins = openNotes(store, body.uid);
  // the owner's open comments go with the request, so a note on top of them is optional
  if (!text && !pins.length) throw new StudioError(400, 'Say what should change, so the designer knows.');
  if (text.length > 4000) throw new StudioError(400, 'That note is too long (4000 characters at most).');
  const sum = summaryFor(store, at);
  if (sum.revising) throw new StudioError(409, 'Claude is already changing this post. It comes back for another look when it is done.');
  if (notBuilt(sum.status)) throw new StudioError(409, 'This post has not been built yet. Edit the idea instead.');
  if (['rejected', 'posted'].includes(sum.status)) throw new StudioError(409, `This post is ${sum.status}.`);
  const before = item ? structuredClone(item) : null;
  const note = [text, text && pins.length ? '' : null, pins.length ? 'Pinned notes:' : null, ...pins.map((p) => `- ${p}`)].filter((x) => x !== null).join('\n');
  if (item) await svc(project, () => decide(project.dir, item.id, 'changes', { comment: note }));
  const review = reviewFor(project, docId);
  let commentId = null;
  let revoked = false;
  if (review) {
    if (text) {
      const comment = { id: newId('c'), page: pageFor(project, docId, body.page), x: 0.5, y: 0.5, text, author: 'human', created: now(), status: 'open', docV: project.doc(docId).v };
      const r = review.apply({ ops: [{ op: 'add', path: '/comments/-', value: comment }], actor: 'human' });
      if (!r.ok) throw new StudioError(422, r.errors?.[0]?.message ?? 'The note could not be saved.');
      commentId = comment.id;
    }
    if (activeApproval(review)) { review.revokeApproval(); revoked = true; }
  }
  return { undo: remember({ kind: 'changes', uid: body.uid, before, commentId, revokedApproval: revoked }), sent: pins.length };
}

async function reject(store, at, body) {
  const { project, item, docId } = at;
  if (!item) throw new StudioError(409, 'Only posts on the calendar can be rejected here.');
  const reason = typeof body.text === 'string' ? body.text.trim().slice(0, 600) : '';
  const before = structuredClone(item);
  await svc(project, () => decide(project.dir, item.id, 'reject', { comment: reason || undefined }));
  const review = reviewFor(project, docId);
  let revoked = false;
  if (review && activeApproval(review)) { review.revokeApproval(); revoked = true; }
  return { undo: remember({ kind: 'reject', uid: body.uid, before, revokedApproval: revoked }) };
}

async function reopen(store, at, body) {
  const { project, item } = at;
  if (!item || item.status !== 'rejected') throw new StudioError(409, 'Only a rejected post can be reopened.');
  const before = structuredClone(item);
  await svc(project, () => decide(project.dir, item.id, 'approve'));
  return { undo: remember({ kind: 'plain', uid: body.uid, before }) };
}

async function ideaDecision(store, at, body, action) {
  const { project, item } = at;
  if (!item || item.status !== 'idea') throw new StudioError(409, 'That is not an idea waiting for a decision.');
  const before = structuredClone(item);
  await svc(project, () => decide(project.dir, item.id, action));
  return { undo: remember({ kind: 'plain', uid: body.uid, before }) };
}

async function edit(store, at, body) {
  const { project, item } = at;
  if (!item) throw new StudioError(409, 'Only posts on the calendar can be edited here.');
  const fields = body.fields && typeof body.fields === 'object' ? body.fields : {};
  if (fields.date !== undefined && fields.date !== item.date && ['scheduled', 'posted'].includes(item.status)) {
    throw new StudioError(409, item.status === 'posted' ? 'This post has already gone out, so its date cannot move.' : 'This post is already scheduled in the publishing service: moving its date here would not move it there. Remove it from the service first.');
  }
  const before = structuredClone(item);
  await svc(project, () => updateItem(project.dir, item.id, fields, { role: 'human' }));
  return { undo: remember({ kind: 'plain', uid: body.uid, before }) };
}

// ---- undo -----------------------------------------------------------------------------------------------------------------------

async function undoOne(store, token) {
  const rec = undoLog.get(token);
  if (!rec) throw new StudioError(404, 'That can no longer be undone.');
  const at = locate(store, rec.uid);
  if (!at) throw new StudioError(404, 'That post is gone.');
  const { project, docId } = at;
  const review = reviewFor(project, docId);
  if (rec.kind === 'approve' && review && rec.approvalId) {
    const active = activeApproval(review);
    if (active?.id === rec.approvalId) review.revokeApproval();
    else if (!review.data.approvals.find((a) => a.id === rec.approvalId)?.revoked) throw new StudioError(409, 'The approval has changed since, so it cannot be undone from here.');
  }
  if (rec.kind === 'changes' && review && rec.commentId) {
    const i = review.data.comments.findIndex((c) => c.id === rec.commentId);
    if (i >= 0) review.apply({ ops: [{ op: 'remove', path: `/comments/${i}` }], actor: 'human' });
  }
  if ((rec.kind === 'changes' || rec.kind === 'reject') && rec.revokedApproval && review && rec.before?.status === 'signed-off') review.approve({ by: 'human', note: 'Restored after undo' });
  if (rec.before) {
    await svc(project, () => mutateCalendar(project.dir, (cal) => {
      const i = cal.items.findIndex((x) => x.id === rec.before.id);
      if (i >= 0) cal.items[i] = rec.before;
    }));
  }
  undoLog.delete(token);
  return rec.uid;
}

// ---- entry points ---------------------------------------------------------------------------------------------------------------

/** @returns {Promise<{post:object, undo?:string}>} */
export async function act(store, body) {
  const action = body.action;
  if (action === 'undo') {
    const tokens = (Array.isArray(body.tokens) ? body.tokens : [body.token]).map(String).reverse();
    const uids = [];
    for (const t of tokens) uids.push(await undoOne(store, t));
    const at = uids.length ? locate(store, uids.at(-1)) : null;
    return { post: at ? summaryFor(store, at) : null, uids };
  }
  const at = locate(store, body.uid);
  if (!at) throw new StudioError(404, 'No such post.');
  let r;
  switch (action) {
    case 'approve': r = await approve(store, at, body); break;
    case 'changes': r = await requestChanges(store, at, body); break;
    case 'reject': r = await reject(store, at, body); break;
    case 'reopen': r = await reopen(store, at, body); break;
    case 'idea-approve': r = await ideaDecision(store, at, body, 'approve'); break;
    case 'idea-reject': r = await ideaDecision(store, at, body, 'reject'); break;
    case 'edit': r = await edit(store, at, body); break;
    default: throw new StudioError(400, 'Unknown action.');
  }
  const fresh = locate(store, body.uid);
  return { ...r, post: fresh ? summaryFor(store, fresh) : null };
}

/** Sign off many posts at once: only posts waiting for sign-off, fully verified, with no open comments. */
export async function bulkApprove(store, { uids, onlyVerified = true, note }) {
  const done = [], skipped = [], undo = [];
  for (const uid of uids) {
    const at = locate(store, uid);
    if (!at) { skipped.push({ uid, reason: 'No such post.' }); continue; }
    const sum = summaryFor(store, at);
    if (!sum.needsReview) { skipped.push({ uid, reason: 'Not waiting for sign-off.' }); continue; }
    if (onlyVerified && sum.verified !== true) { skipped.push({ uid, reason: 'Checks are not all done and passed.' }); continue; }
    if (sum.openComments) { skipped.push({ uid, reason: 'Has open comments.' }); continue; }
    try {
      undo.push((await approve(store, at, { uid, note, force: !onlyVerified })).undo);
      done.push(uid);
    } catch (e) {
      if (e instanceof StudioError) skipped.push({ uid, reason: e.message }); else throw e;
    }
  }
  return { done, skipped, undo };
}
