// What Claude is doing right now, for the Studio's left bar (root scope, /api/activity). Both tokens may read it.
//   GET /api/activity -> { seq, at, working:[{ id, project, projectName, doc, title, kind, verb, past, what, startedAt, steps, percent?, message? }],
//                          recent:[{ ...the same, finishedAt, ok }] }
// `working` is what Claude is changing, rendering, checking and so on this moment (a piece of work ends when it has been quiet for a few seconds, or when its
// render job ends); `recent` is what it finished lately, newest first. It is built from Claude's own requests (src/server/activity.mjs); nothing is saved.

export default {
  scope: 'root',
  key: 'activity',
  async handle(ctx) {
    const { seg, method, res, sendJson, need, activity } = ctx;
    if (seg[1]) return false;
    need(method === 'GET', 405, 'GET only.');
    return sendJson(res, 200, { ok: true, ...activity.snapshot() });
  },
};
