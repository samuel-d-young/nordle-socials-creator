// What Claude is making right now, across every brand (root scope, /api/making). The Studio's "Being made" page reads it every few seconds.
//   GET /api/making -> { at, jobs: [{ project, name, running, queue:[...], last }], revisions: [{ uid, state }] }
// `running` and `queue` come from the Studio's own job line (src/calendar/jobs.mjs: "Make them now", "Build it now", "Ask Claude now"); `revisions` are
// posts the designer is changing after "Request changes" (src/studio/revise.mjs). The posts themselves (titles, status, build progress) are already in
// the Studio's data, so this only adds what is in memory. Reading it changes nothing.

import { jobStatus } from '../../calendar/jobs.mjs';

export default {
  scope: 'root',
  key: 'making',
  async handle(ctx) {
    const { seg, method, res, sendJson, need, store, reviser } = ctx;
    if (seg[1]) return false;
    need(method === 'GET', 405, 'GET only.');
    const jobs = [];
    for (const p of store.scan()) {
      const s = jobStatus(p.dir);
      if (!s.running && !s.queue.length && !s.last) continue;
      let name = p.id;
      try { name = p.brand?.name ?? p.id; } catch { /* the id will do */ }
      jobs.push({ project: p.id, name, running: s.running, queue: s.queue, last: s.last });
    }
    const revisions = typeof reviser?.states === 'function' ? reviser.states() : (reviser?.pending?.() ?? []).map((uid) => ({ uid, state: 'running' }));
    return sendJson(res, 200, { ok: true, at: new Date().toISOString(), jobs, revisions });
  },
};
