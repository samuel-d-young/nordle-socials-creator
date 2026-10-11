// /api/projects/<project>/checks/...  how a post was checked, and the way to check it.
//   GET  checks                    every post: is it verified, and what is missing
//   GET  checks/<doc>              the record (who checked what at which version) and the gate
//   POST checks/<doc>              run the automatic checks (body: {only?: ["facts", ...]})
//   POST checks/<doc>/record       record a judgement: {check, by, status, summary, pairs?, findings?}
//                                  by "designer" or "reviewer" is Claude's; by "owner" is the owner's and needs the owner's token
//   POST checks/<doc>/media        the picture/words pairs, with the pictures themselves
//   POST checks/<doc>/packet       build the reviewer's packet (for an independent Claude), with its images

import { readFileSync } from 'node:fs';
import { thumbnail } from '../../verify/ff.mjs';
import { checkPost, docIds, finishGate, loadDoc, mediaReport, recordManual, reviewerPacket } from '../../verify/run.mjs';
import { loadChecks, requiredChecks } from '../../verify/store.mjs';

const ID = /^[a-z0-9][a-z0-9_-]*$/;

/** A picture as base64 for Claude to look at: a small JPEG where ffmpeg can make one, else the file itself if it is small enough. */
function inline(path, label) {
  const small = thumbnail(path, { width: 900 });
  if (small) return { label, mime: 'image/jpeg', base64: small.toString('base64') };
  try {
    const buf = readFileSync(path);
    return buf.length < 1_500_000 ? { label, mime: path.endsWith('.png') ? 'image/png' : 'image/jpeg', base64: buf.toString('base64') } : null;
  } catch { return null; }
}

const slim = (r) => ({
  doc: r.doc, version: r.v, ok: r.ok, counts: r.counts, packs: r.packs,
  checks: Object.values(r.results).map((c) => ({
    check: c.check, status: c.status, summary: c.summary, ...(c.score !== undefined ? { score: c.score } : {}),
    findings: c.findings.filter((f) => f.level !== 'info' || c.status === 'fail').slice(0, 40), ...(c.pairs?.length ? { pairs: c.pairs } : {}),
  })),
});

export default {
  scope: 'project',
  key: 'checks',
  async handle(ctx) {
    const { seg, method, project, pool, human, needHuman, sendJson, readJsonBody, need } = ctx;
    const docId = seg[3];
    const sub = seg[4];

    if (!docId) {
      need(method === 'GET', 405, 'Method not allowed.');
      return sendJson(ctx.res, 200, { docs: docIds(project.dir).map((id) => { const g = finishGate(project.dir, id); return { id, verified: g.verified, missing: g.missing, failed: g.failed }; }) });
    }
    need(ID.test(docId) && project.doc(docId), 404, 'No such document.');

    if (!sub) {
      if (method === 'GET') {
        const doc = loadDoc(project.dir, docId);
        return sendJson(ctx.res, 200, { gate: finishGate(project.dir, docId), record: loadChecks(project.dir, docId), required: requiredChecks(doc) });
      }
      need(method === 'POST', 405, 'Method not allowed.');
      const b = await readJsonBody(ctx.req);
      const only = Array.isArray(b.only) && b.only.length ? b.only.map(String) : undefined;
      const r = await pool.use((browser) => checkPost(project.dir, docId, { browser, only }));
      return sendJson(ctx.res, 200, { ...slim(r), gate: finishGate(project.dir, docId) });
    }

    need(method === 'POST', 405, 'Method not allowed.');
    if (sub === 'record') {
      const b = await readJsonBody(ctx.req);
      if (b.by === 'owner') needHuman(); else need(!human, 403, 'Designer and reviewer judgements are Claude’s. The owner records theirs (by "owner") from the editor.');
      if (b.by === 'owner') {
        const r = recordManual(project.dir, docId, { check: b.check, by: 'owner', status: b.status, summary: b.summary ?? '', allowOwner: true });
        return sendJson(ctx.res, r.ok ? 200 : 400, r.ok ? { entry: r.entry, gate: r.gate } : { ok: false, errors: r.errors.map((m) => ({ path: '/', message: m })) });
      }
      const r = recordManual(project.dir, docId, { check: b.check, by: b.by, status: b.status, summary: b.summary, pairs: b.pairs, findings: b.findings });
      return sendJson(ctx.res, r.ok ? 200 : 400, r.ok ? { entry: r.entry, gate: r.gate } : { ok: false, errors: r.errors.map((m) => ({ path: '/', message: m })) });
    }
    if (sub === 'media') {
      await readJsonBody(ctx.req);
      const r = await pool.use((browser) => mediaReport(project.dir, docId, { browser }));
      const images = r.images.slice(0, 12).map((i) => inline(i.path, i.label)).filter(Boolean);
      return sendJson(ctx.res, 200, { doc: r.doc, version: r.v, pairs: r.pairs, findings: r.findings.filter((f) => f.level !== 'info'), skipped: r.skipped, images });
    }
    if (sub === 'packet') {
      await readJsonBody(ctx.req);
      const r = await pool.use((browser) => reviewerPacket(project.dir, docId, { browser }));
      const images = r.images.slice(0, 14).map((i) => ({ ...inline(i.path, i.label), path: i.path })).filter((i) => i.base64);
      return sendJson(ctx.res, 200, { path: r.path, markdown: r.markdown, questions: r.questions, pairs: r.pairs, imagePaths: r.images, images, version: r.v, hash: r.hash });
    }
    return false;
  },
};
