// The Studio's API (root scope):
//   GET  /api/studio                 every project's posts in one call (no rendering). ?since=<rev> answers {unchanged:true}; ?today= pins today
//   GET  /api/studio/post?uid=       one post in full (caption, brief, checks, media pairs, comments, versions)
//   GET  /api/studio/thumb?project=&path=&w=   a small preview of a picture inside a project (PNGs shrunk in a worker, cached)
//   POST /api/studio/act             {uid, action: approve|changes|reject|reopen|idea-approve|idea-reject|edit|undo, ...}   owner only
//                                    `changes` also starts the designer on the post at once ({revising:true}; {revising:false, reviseReason:'off'|'no-post'|'not-sent-back'} when it cannot)
//   POST /api/studio/bulk            {uids, onlyVerified}                                                                 owner only
//   POST /api/studio/brand-order     {order: [brand ids]}  the order of the brands in the rail, the month's lanes and the all-brands Insights (kept on this computer, `studio.json`)   owner only
//   POST /api/studio/cover           {uid, time} or {uid, auto:true}  use the frame at that second (or the best one) of a reel as its cover (the picture is retaken, no re-render; Buffer is told the frame)   owner only
//   POST /api/studio/caption         {uid, text}  change a post's caption (a built post: its document, one undo step; an imported post: its record)   owner only
//   GET  /api/studio/cover-candidates?uid=&count=   the best few frames of a reel, best first: [{time, score, image: data URL}] and the cover now. Reads only.
// Claude's token may read everything here and decide nothing.

import { collect, detail } from '../../studio/data.mjs';
import { act, bulkApprove, StudioError } from '../../studio/actions.mjs';
import { comment, CommentError } from '../../studio/comments.mjs';
import { setCaption, CaptionError } from '../../studio/caption.mjs';
import { listTrash, removeBrand, removePosts, restoreBrand, restorePost, TrashError, trashCount } from '../../studio/trash.mjs';
import { candidatesFor, setCover } from '../../studio/cover.mjs';
import { saveBrandOrder } from '../../studio/brand-order.mjs';
import { createHash } from 'node:crypto';
import { pictureInProject, sendThumbnail, thumbnail } from '../../studio/thumb.mjs';

export default {
  scope: 'root',
  key: 'studio',
  async handle(ctx) {
    const { seg, method, url, req, res, store, sendJson, readJsonBody, HttpError, need, needHuman, reviser, autoScheduler } = ctx;
    const sub = seg[1];
    try {
      if (!sub) {
        need(method === 'GET', 405, 'GET only.');
        const data = collect(store, { today: url.searchParams.get('today') ?? undefined });
        data.trashCount = trashCount(store);
        data.rev = createHash('sha1').update(`${data.rev}|${data.trashCount}`).digest('hex').slice(0, 12);
        if (url.searchParams.get('since') === data.rev) return sendJson(res, 200, { rev: data.rev, unchanged: true });
        return sendJson(res, 200, data);
      }
      if (sub === 'post') {
        need(method === 'GET', 405, 'GET only.');
        const d = detail(store, url.searchParams.get('uid') ?? '');
        need(d, 404, 'No such post.');
        return sendJson(res, 200, d);
      }
      if (sub === 'thumb') {
        need(method === 'GET' || method === 'HEAD', 405, 'GET only.');
        const project = store.project(url.searchParams.get('project') ?? '');
        need(project, 404, 'No such project.');
        const abs = pictureInProject(project.dir, url.searchParams.get('path') ?? '');
        need(abs, 404, 'No such picture.');
        return sendThumbnail(req, res, await thumbnail(abs, url.searchParams.get('w')));
      }
      if (sub === 'brand-order') {
        // the order of the brands in the rail, the month's lanes and the all-brands Insights: the owner's choice on this computer
        need(method === 'POST', 405, 'POST only.');
        needHuman();
        const body = await readJsonBody(req);
        need(Array.isArray(body.order) && body.order.length <= 500, 400, 'Send {"order": ["brand-id", ...]}.');
        return sendJson(res, 200, { ok: true, order: saveBrandOrder(body.order, store.scan().map((p) => p.id)) });
      }
      if (sub === 'act') {
        need(method === 'POST', 405, 'POST only.');
        needHuman();
        const body = await readJsonBody(req);
        const done = await act(store, body);
        // Request changes does the change: the designer starts on it now (the project's autoRevise setting can turn this off)
        if (body.action === 'changes' && reviser) { const r = reviser.start(store, String(body.uid)); done.revising = r.started; if (!r.started) done.reviseReason = r.reason; }
        if (body.action === 'undo' && reviser) for (const uid of done.uids ?? []) reviser.cancel(uid);
        // an approval can make a post due for Buffer straight away (if the owner switched automatic scheduling on)
        if (body.action === 'approve') autoScheduler?.kick();
        return sendJson(res, 200, { ok: true, ...done });
      }
      if (sub === 'caption') {
        need(method === 'POST', 405, 'POST only.');
        needHuman();
        return sendJson(res, 200, { ok: true, ...(await setCaption(store, await readJsonBody(req))) });
      }
      if (sub === 'comment') {
        need(method === 'POST', 405, 'POST only.');
        needHuman();
        return sendJson(res, 200, { ok: true, ...comment(store, await readJsonBody(req)) });
      }
      if (sub === 'trash') {
        need(method === 'GET', 405, 'GET only.');
        return sendJson(res, 200, listTrash(store));
      }
      if (sub === 'remove') {
        need(method === 'POST', 405, 'POST only.');
        needHuman();
        const body = await readJsonBody(req);
        need(Array.isArray(body.uids) && body.uids.length > 0 && body.uids.length <= 300, 400, 'Send {"uids": [...]} with up to 300 posts.');
        return sendJson(res, 200, { ok: true, ...(await removePosts(store, body.uids.map(String))) });
      }
      if (sub === 'restore') {
        need(method === 'POST', 405, 'POST only.');
        needHuman();
        return sendJson(res, 200, { ok: true, ...(await restorePost(store, (await readJsonBody(req)).id)) });
      }
      if (sub === 'remove-brand') {
        need(method === 'POST', 405, 'POST only.');
        needHuman();
        return sendJson(res, 200, { ok: true, ...removeBrand(store, await readJsonBody(req)) });
      }
      if (sub === 'restore-brand') {
        need(method === 'POST', 405, 'POST only.');
        needHuman();
        return sendJson(res, 200, { ok: true, ...restoreBrand(store, (await readJsonBody(req)).id) });
      }
      if (sub === 'cover-candidates') {
        need(method === 'GET', 405, 'GET only.');
        return sendJson(res, 200, { ok: true, ...(await candidatesFor(store, { uid: url.searchParams.get('uid') ?? '', count: url.searchParams.get('count') ?? 6 })) });
      }
      if (sub === 'cover') {
        need(method === 'POST', 405, 'POST only.');
        needHuman();
        return sendJson(res, 200, { ok: true, ...(await setCover(store, await readJsonBody(req))) });
      }
      if (sub === 'bulk') {
        need(method === 'POST', 405, 'POST only.');
        needHuman();
        const body = await readJsonBody(req);
        need(Array.isArray(body.uids) && body.uids.length > 0 && body.uids.length <= 300, 400, 'Send {"uids": [...]} with up to 300 posts.');
        const result = await bulkApprove(store, { uids: body.uids.map(String), onlyVerified: body.onlyVerified !== false, note: typeof body.note === 'string' ? body.note : undefined });
        autoScheduler?.kick();
        return sendJson(res, 200, { ok: true, ...result });
      }
    } catch (e) {
      if (e?.name === 'CalendarError') return sendJson(res, e.status, { ok: false, errors: e.errors });
      if (e instanceof TrashError) return sendJson(res, e.status, { ok: false, errors: [{ path: '/', message: e.message }] });
      if (e instanceof CommentError || e instanceof CaptionError) return sendJson(res, e.status, { ok: false, errors: [{ path: '/', message: e.message }] });
      if (e instanceof StudioError) return sendJson(res, e.status, { ok: false, errors: [{ path: '/', message: e.message }], ...e.extra });
      if (e instanceof HttpError) throw e;
      throw e;
    }
    return false;
  },
};
