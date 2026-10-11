// The finished video files of a post, for the editor: the monitor asks whether a preview exists (a 404 from asking the file itself
// would show up as an error in the browser's console), and the Export tab lists what has already been made.
//   GET /api/projects/<p>/video/outputs?doc=<id>  ->  { files: [{ name, path, kind: 'preview'|'export', ext, bytes, modified }] }
// `path` is relative to the project (served by the ordinary file route, with Range support). Read-only.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

const ID = /^[a-z0-9][a-z0-9_-]*$/;
const KINDS = new Set(['.mp4', '.webm', '.mov', '.gif']);

export default {
  scope: 'project',
  key: 'video',
  async handle(ctx) {
    const { seg, method, project, sendJson, need, url } = ctx;
    if (seg[3] !== 'outputs' || method !== 'GET') return false;
    const id = url.searchParams.get('doc') ?? '';
    need(ID.test(id) && project.doc(id), 404, `There is no document "${id}" in this project.`);
    const dir = join(project.dir, 'out', id);
    const files = [];
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        const ext = extname(name).toLowerCase();
        if (!KINDS.has(ext) || !name.startsWith(`${id}.`)) continue;
        const st = statSync(join(dir, name));
        if (!st.isFile()) continue;
        files.push({ name, path: `out/${id}/${name}`, kind: name.includes('.preview.') ? 'preview' : 'export', ext: ext.slice(1), bytes: st.size, modified: Math.round(st.mtimeMs) });
      }
    }
    files.sort((a, b) => b.modified - a.modified);
    return sendJson(ctx.res, 200, { files });
  },
};
