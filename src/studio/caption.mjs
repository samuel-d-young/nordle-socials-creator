// Edit a post's caption from the Studio's post sheet.
//   * a built post: the caption lives in its document (copy.caption). The change goes through the same patch path the editor uses, so it is
//     one undoable step in the history, and an approval taken before it shows "edited since sign-off" (the owner approves the new words).
//   * a post made outside Nordle (imported with its pictures): the caption is the imported record's, in the calendar (item.external.caption).
// A post already scheduled in a publishing service is changed here only: the service keeps the words it was given, and the result says so.

import { mutateCalendar } from '../calendar/service.mjs';
import { forget, locate } from './data.mjs';
import { join } from 'node:path';

export class CaptionError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const MAX_CAPTION = 5000;

/** @returns {{caption:string, scheduled:boolean, signedOff:boolean}} */
export async function setCaption(store, { uid, text } = {}) {
  const at = locate(store, String(uid ?? ''));
  if (!at) throw new CaptionError(404, 'There is no such post.');
  if (typeof text !== 'string') throw new CaptionError(400, 'Send the new caption as text.');
  const caption = text.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
  if (caption.length > MAX_CAPTION) throw new CaptionError(400, `That caption is ${caption.length} characters; the most Nordle keeps is ${MAX_CAPTION}.`);
  const { project, item, docId } = at;
  const scheduled = ['scheduled', 'posted'].includes(item?.status);
  const signedOff = item?.status === 'signed-off' || item?.status === 'scheduled';

  if (docId) {
    const session = project.doc(docId);
    if (!session) throw new CaptionError(404, 'This post has no document to change.');
    const current = session.doc.copy?.caption ?? null;
    if ((current ?? '') === caption) return { caption, changed: false, scheduled, signedOff };
    const ops = session.doc.copy ? [{ op: current === null ? 'add' : 'replace', path: '/copy/caption', value: caption }] : [{ op: 'add', path: '/copy', value: { caption } }];
    const r = session.apply({ ops, actor: 'human', note: 'Edit caption' });
    if (!r.ok) throw new CaptionError(422, r.errors?.[0]?.message ?? 'That caption could not be saved.');
    return { caption, changed: true, scheduled, signedOff };
  }

  if (item?.external) {
    let changed = false;
    await mutateCalendar(project.dir, (cal) => {
      const it = cal.items.find((i) => i.id === item.id);
      if (!it?.external) throw new CaptionError(409, 'This post has nothing to change.');
      if ((it.external.caption ?? '') === caption) return;
      it.external.caption = caption;
      it.updated = new Date().toISOString();
      changed = true;
    });
    forget(join(project.dir, 'calendar.json'));
    return { caption, changed, scheduled, signedOff };
  }
  throw new CaptionError(409, 'This post has no caption to change yet: it is written when the post is built.');
}
