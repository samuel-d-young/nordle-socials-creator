// Bringing in what you already have (root scope, /api/import/...):
//   POST /api/import/pick-files (owner) { title? }                                       -> { ok, paths:[...] } | { ok, cancelled:true } | { ok:false, unavailable:true, message }
//        opens the system's file window on this computer (videos); a web page cannot learn a file's full path
//   POST /api/import/videos (owner) { project, paths:[...], size?, mode?: 'each'|'together' } -> 201 { ok, posts:[{ docId, itemId, title, seconds, files, date }], mounts }
//        the files stay where they are; each becomes a video post (picture and sound on the timeline) on the calendar, ready for the video editor
// Claude's token cannot do either: choosing files on the owner's screen and reading their folders is the owner's.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, readJson } from '../../../tools/validate.mjs';
import { PickerError, pickFiles } from '../folder-picker.mjs';
import { ImportError, importVideos } from '../../video/import.mjs';

export default {
  scope: 'root',
  key: 'import',
  async handle(ctx) {
    const { seg, method, req, res, store, sendJson, readJsonBody, need, needHuman, pickFiles: pick, importVideos: doImport } = ctx;
    const sub = seg[1];
    try {
      if (sub === 'pick-files') {
        need(method === 'POST', 405, 'POST only.');
        needHuman();
        const b = await readJsonBody(req);
        try {
          const r = await (pick ?? pickFiles)({ title: typeof b.title === 'string' && b.title.trim() ? b.title.trim() : 'Choose videos', kind: 'video' });
          return sendJson(res, 200, { ok: true, ...r });
        } catch (e) {
          if (e instanceof PickerError) return sendJson(res, 200, { ok: false, unavailable: true, message: e.message });
          throw e;
        }
      }
      if (sub === 'videos') {
        need(method === 'POST', 405, 'POST only.');
        needHuman();
        const b = await readJsonBody(req);
        const project = store.project(String(b.project ?? ''));
        need(project, 404, 'No such brand.');
        const brand = readJson(join(project.dir, 'brand.json'));
        const platforms = readJson(join(ROOT, 'data', 'platforms.json'));
        const r = await (doImport ?? importVideos)(project.dir, Array.isArray(b.paths) ? b.paths : [], { size: typeof b.size === 'string' ? b.size : undefined, mode: b.mode === 'together' ? 'together' : 'each', brand, platforms });
        return sendJson(res, 201, { ok: true, ...r });
      }
    } catch (e) {
      if (e instanceof ImportError) return sendJson(res, e.status, { ok: false, errors: [{ message: e.message }] });
      if (e?.name === 'ReelSpecError') return sendJson(res, 400, { ok: false, errors: [{ message: e.message }] });
      throw e;
    }
    return false;
  },
};
