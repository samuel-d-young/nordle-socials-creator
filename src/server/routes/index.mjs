// Feature routes plug into the API from here, so a new feature adds a file and does not edit http.mjs.
//
// Every other *.mjs file in this folder default-exports one route module (or an array of them):
//
//   export default {
//     scope: 'project',            // 'project' -> /api/projects/<project>/<key>/...   'root' -> /api/<key>/...
//     key: 'calendar',
//     async handle(ctx) { ... }    // send a reply with ctx.sendJson(ctx.res, 200, {...}); return false to pass
//   };
//
// ctx = { req, res, url, seg, method, role, human, project (project scope only), store, pool, origin,
//         readJsonBody, sendJson, sendFile, HttpError, need, needHuman, needAgent, ROOT, reviser }
//         (reviser: starts the designer on a post the owner sends back, src/studio/revise.mjs; null unless the real server passes one)
// `seg` is the path after /api, split: ['projects', '<project>', 'calendar', ...]  or  ['studio', ...].
// Writes by Claude use the agent token: call ctx.needHuman() for anything only the owner may do (approving, rejecting).

import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const ROUTES = [];
for (const file of readdirSync(here).filter((f) => f.endsWith('.mjs') && f !== 'index.mjs').sort()) {
  const mod = await import(pathToFileURL(join(here, file)).href);
  for (const r of [mod.default].flat().filter(Boolean)) {
    if (!['project', 'root'].includes(r.scope) || !r.key || typeof r.handle !== 'function') throw new Error(`routes/${file}: not a route module`);
    ROUTES.push(r);
  }
}
