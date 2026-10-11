// Cut routes: /api/projects/<project>/cut/...
//   POST words  {doc, source?, track?}   the transcript of a source with what the cut list keeps: for the editor's transcript panel
//                                         and for the cut tools. -> { source, track, fps, version, duration, total, keptWords,
//                                         words:[{i,text,start,end,kept,at,fix?,skip?}], lines:[{i,j,text,start,end,kept,at}] }
// Read-only. The edits themselves are ordinary patches (src/shared/cutlist.mjs makes the operations).

import { CutError, defaultTrack, speechSource } from '../../shared/cutlist.mjs';
import { cutOverview, loadSourceWords } from '../../video/cutwords.mjs';

export default {
  scope: 'project',
  key: 'cut',
  async handle(ctx) {
    const { seg, method, project, sendJson, HttpError, need } = ctx;
    if (seg[3] !== 'words' || method !== 'POST') return false;
    const b = await ctx.readJsonBody(ctx.req);
    need(typeof b.doc === 'string' && b.doc, 400, 'Say which document: {"doc": "<id>"}.');
    const session = project.doc(b.doc);
    need(session, 404, `There is no document "${b.doc}" in this project.`);
    need(session.doc.kind === 'video', 400, `"${b.doc}" is a ${session.doc.kind}, not a video.`);
    try {
      const source = b.source ?? speechSource(session.doc);
      const { words } = loadSourceWords(project.dir, session.doc, source);
      const track = b.track ?? defaultTrack(session.doc, source);
      need(track, 422, `No track plays source "${source}".`);
      const ov = cutOverview(session.doc, { track, source }, words);
      return sendJson(ctx.res, 200, {
        source, track, fps: session.doc.timeline.fps, version: session.v, duration: session.doc.timeline.duration, total: ov.total, keptWords: ov.keptWords,
        words: ov.states.map((w) => ({ ...w, ...(words[w.i].fix !== undefined ? { fix: words[w.i].fix } : {}), ...(words[w.i].skip ? { skip: true } : {}) })),
        lines: ov.lines,
      });
    } catch (e) {
      if (e instanceof CutError) throw new HttpError(422, e.message);
      throw e;
    }
  },
};
