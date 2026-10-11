// Comments from the Studio: a note on the whole post, or a pin on a spot (and, for video, a second). They are ordinary review
// comments ({page, x, y, time?}). A document's comments go into its review file the way the editor writes them; a post made
// outside Nordle has no document, so its comments live in review/ext-<item>.json, the same shape.

import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { applyOps } from '../shared/ops.mjs';
import { validateReviewData } from '../../tools/validate.mjs';
import { newId } from '../server/store.mjs';
import { extReviewFile, extReviewId, forget, locate, readJsonCached } from './data.mjs';

export class CommentError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const ID = /^[a-z0-9][a-z0-9_-]*$/;
const clamp01 = (n, d = 0.5) => (Number.isFinite(Number(n)) ? Math.min(1, Math.max(0, Number(n))) : d);
const now = () => new Date().toISOString();

/** Something that can read and change the comments of one post, whichever kind it is. */
function reviewOf(at) {
  const { project, item, docId } = at;
  if (docId) {
    const review = project.review(docId);
    return {
      data: () => review.data,
      docV: () => project.doc(docId).v,
      pages: () => (project.doc(docId).doc.pages ?? []).map((p) => p.id),
      apply(ops) { const r = review.apply({ ops, actor: 'human' }); if (!r.ok) throw new CommentError(422, r.errors?.[0]?.message ?? 'That could not be saved.'); },
    };
  }
  if (!item?.external) throw new CommentError(409, 'Comments need a built post, or one that was imported with its pictures.');
  const file = extReviewFile(project, item.id);
  const load = () => structuredClone(readJsonCached(file) ?? { schema: 'nordle.review/0.1', doc: extReviewId(item.id), comments: [], versions: [], approvals: [] });
  return {
    data: load,
    docV: () => 0,
    pages: () => (item.external.slides ?? []).map((_, i) => `slide-${i + 1}`),
    apply(ops) {
      let next;
      try { next = applyOps(load(), ops).doc; } catch (e) { throw new CommentError(400, e.message); }
      const issues = validateReviewData(next);
      if (issues.length) throw new CommentError(422, issues[0].message);
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${randomBytes(3).toString('hex')}`;
      writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
      renameSync(tmp, file);
      forget(file);
    },
  };
}

function summary(c) {
  const where = typeof c.time === 'number' ? `video ${Math.floor(c.time / 60)}:${String(Math.floor(c.time % 60)).padStart(2, '0')}` : c.general ? 'whole post' : c.page.replace(/^slide-/, 'slide ');
  return `${where}: ${c.text}`;
}
/** The open pins and notes, in words, for the "request changes" note the designer reads. */
export function openNotes(store, uid) {
  const at = locate(store, uid);
  if (!at) return [];
  try { return reviewOf(at).data().comments.filter((c) => c.status === 'open' && c.author === 'human').map(summary); } catch { return []; }
}

/**
 * action add:     {text, page?, x?, y?, time?, general?}
 * action resolve | reopen | delete:  {id}
 * action reply:   {id, text}
 */
export function comment(store, body) {
  const at = locate(store, body.uid);
  if (!at) throw new CommentError(404, 'No such post.');
  const r = reviewOf(at);
  const action = body.action ?? 'add';
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (action === 'add') {
    if (!text) throw new CommentError(400, 'Write the comment first.');
    if (text.length > 4000) throw new CommentError(400, 'That comment is too long (4000 characters at most).');
    const pages = r.pages();
    const page = typeof body.page === 'string' && ID.test(body.page) ? body.page : pages[0] ?? 'video';
    const c = { id: newId('c'), page, x: clamp01(body.x), y: clamp01(body.y), text, author: 'human', created: now(), status: 'open', docV: r.docV() };
    if (typeof body.time === 'number' && body.time >= 0 && Number.isFinite(body.time)) c.time = Math.round(body.time * 100) / 100;
    if (body.general) c.general = true;
    r.apply([{ op: 'add', path: '/comments/-', value: c }]);
    return { id: c.id };
  }
  const data = r.data();
  const i = data.comments.findIndex((c) => c.id === body.id);
  if (i < 0) throw new CommentError(404, 'No such comment.');
  if (action === 'resolve' || action === 'reopen') r.apply([{ op: 'replace', path: `/comments/${i}/status`, value: action === 'resolve' ? 'resolved' : 'open' }]);
  else if (action === 'delete') r.apply([{ op: 'remove', path: `/comments/${i}` }]);
  else if (action === 'reply') {
    if (!text) throw new CommentError(400, 'Write the reply first.');
    const reply = { id: newId('r'), author: 'human', text, created: now() };
    r.apply([Array.isArray(data.comments[i].replies) ? { op: 'add', path: `/comments/${i}/replies/-`, value: reply } : { op: 'add', path: `/comments/${i}/replies`, value: [reply] }]);
  } else throw new CommentError(400, 'Unknown comment action.');
  return { id: body.id };
}
