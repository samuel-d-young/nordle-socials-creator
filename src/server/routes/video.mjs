// Video routes: /api/projects/<project>/video/...
//   POST render   {doc, preview?, from?, to?, size?, format?, maxWidth?}   start a render job   -> {job}
//                 format: mp4 (default) | webm | gif | prores; maxWidth only for a GIF (default 540). A GIF is at most 30 s.
//                 The finished job's result has `format`, `file` (e.g. out/<doc>/<doc>.webm) and `files`.
//   GET  formats                                          the formats, and which this computer's ffmpeg can make
//   GET  jobs/<id>[?wait=<seconds>]                       how is it going               -> {job}
//   POST jobs/<id>/cancel
//   GET  jobs[?kind=render|proxy]                         this project's jobs
//   POST stills   {doc, times:[s], preview?, scale?, format?, overlay?}   real frames   -> {files:[{base64,mime,...}]}
//   POST sheet    {doc}                                   contact sheet                 -> {base64, scenes}
//   POST image    {path}                                  a picture from out/ as base64 (the sheet, the cover)
//   POST check    {doc}                                   the plan's problems, no render
//   POST probe    {path}                                  what is in a media file (project path or mount:name/path)
//   GET  mounts                                           the mounts set up for this project (names only)
//   POST ls       {mount, dir?}                           the files in a folder of a mount
//   POST proxy    {doc?, source}                          make a browser-playable proxy of footage. source is a source id in
//                                                         `doc` or a path (project path or mount:name/path). Already there ->
//                                                         200 {ready:true, progress:100, url}; otherwise a job starts ->
//                                                         202 {ready:false, progress, job} (poll jobs/<id> or GET proxy)
//   GET  proxy?doc=&source=                               -> {ready, progress (0-100), url?, error?, job?}
//   GET  waveform?doc=&source=&per=0.05                   -> {duration, per, peaks:[0..1], hasAudio, speech?:[{start,end}]}
//                                                         (at most 20000 peaks: a longer source gets a larger per)
// The rendered files are served by the ordinary project file route (/p/<project>/out/...), with Range support. A finished
// proxy is served by the same route from /p/<project>/.proxies/<40 hex>.mp4 (only that name pattern, nothing else in .proxies).

import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { videoJobs } from '../../video/jobs.mjs';
import { videoSheet, videoStills, probeFor } from '../../video/render.mjs';
import { buildPlan, summarisePlan } from '../../video/plan.mjs';
import { describeProbe } from '../../video/probe.mjs';
import { listMountDir, loadMounts, MountError } from '../../video/mounts.mjs';
import { FORMAT_IDS, encoderProblem, formatList, gifProblem } from '../../video/formats.mjs';
import { locateSource, makeProxy, proxyFor, proxyUrl } from '../../video/proxy.mjs';
import { waveformFor } from '../../video/waveform.mjs';
import { loadDocContext } from '../../render/context.mjs';

const rel = (dir, p) => relative(dir, p).split(sep).join('/');
const BARE_ID = /^[a-z0-9][a-z0-9_-]*$/; // a source id (no dot, slash or colon), as opposed to a path

export default {
  scope: 'project',
  key: 'video',
  async handle(ctx) {
    const { seg, method, project, sendJson, HttpError, need, pool, url } = ctx;
    const readJsonBody = () => ctx.readJsonBody(ctx.req);
    const sub = seg[3];
    const docOf = (id) => {
      need(typeof id === 'string' && id, 400, 'Say which document: {"doc": "<id>"}.');
      const session = project.doc(id);
      need(session, 404, `There is no document "${id}" in this project.`);
      need(session.doc.kind === 'video', 400, `"${id}" is a ${session.doc.kind}, not a video.`);
      return session;
    };
    const failed = (r) => { throw new HttpError(422, (r.errors ?? []).map((e) => e.message).join('\n') || 'That could not be done.'); };
    // a source named by id (in the document `doc`) or by path: -> { ref: the media path, entry: the document's source or null }
    const sourceOf = ({ doc, source }) => {
      need(typeof source === 'string' && source, 400, 'Say which source: "source" is a source id in the document (with "doc") or a path such as mount:footage/clip.mp4.');
      let entry = null;
      if (doc) {
        entry = (docOf(doc).doc.sources ?? []).find((s) => s.id === source) ?? null;
        need(entry || !BARE_ID.test(source), 404, `There is no source "${source}" in "${doc}".`);
      } else {
        need(!BARE_ID.test(source), 400, `"${source}" looks like a source id. Add "doc" to say which document it is in, or give a path such as mount:footage/clip.mp4.`);
      }
      need(entry?.type !== 'image', 422, `Source "${source}" is a picture. Pictures play in the page as they are: no proxy, and no sound to draw.`);
      return { ref: entry ? entry.path : source, entry };
    };

    try {
      if (sub === 'render' && method === 'POST') {
        const b = await readJsonBody();
        const session = docOf(b.doc);
        const num = (v) => (v === undefined || v === null ? undefined : Number(v));
        const format = b.format === undefined || b.format === null || b.format === '' ? 'mp4' : String(b.format).toLowerCase();
        need(FORMAT_IDS.includes(format), 400, `"format" is one of: ${FORMAT_IDS.join(', ')}.`);
        const options = { preview: !!b.preview, from: num(b.from), to: num(b.to), size: typeof b.size === 'string' ? b.size : undefined, format, maxWidth: num(b.maxWidth) };
        need([options.from, options.to].every((v) => v === undefined || Number.isFinite(v)), 400, 'from and to are seconds.');
        need(options.maxWidth === undefined || (Number.isFinite(options.maxWidth) && options.maxWidth >= 64 && options.maxWidth <= 4320), 400, '"maxWidth" is a width in pixels (64 to 4320).');
        // say so at once when this computer cannot make the format, or a GIF would be too long, instead of failing in a job
        const missing = encoderProblem(format);
        if (missing) throw new HttpError(422, missing);
        if (format === 'gif') {
          const total = Number(session.doc.timeline?.duration) || 0;
          const tooLong = gifProblem(Math.max(0, Math.min(options.to ?? total, total) - (options.from ?? 0)));
          if (tooLong) throw new HttpError(422, tooLong);
        }
        const started = videoJobs.start({ project, docId: session.id, file: session.file, options });
        if (ctx.role === 'agent') ctx.req.nordleJob = started.id;      // a render Claude started is followed in the Studio's left bar until it ends (src/server/activity.mjs)
        return sendJson(ctx.res, 202, { job: started });
      }
      if (sub === 'formats' && method === 'GET') return sendJson(ctx.res, 200, { formats: formatList() });
      if (sub === 'proxy' && method === 'POST') {
        const b = await readJsonBody();
        const { ref } = sourceOf(b);
        const loc = locateSource(project.dir, ref);
        if (proxyFor(project.dir, ref)) return sendJson(ctx.res, 200, { ready: true, progress: 100, key: loc.key, url: proxyUrl(project.id, loc.key) });
        const job = videoJobs.startTask({
          project, kind: 'proxy', key: loc.key, docId: typeof b.doc === 'string' ? b.doc : null, label: ref, options: { source: b.source },
          run: async ({ signal, onProgress }) => {
            const r = await makeProxy(project.dir, ref, { signal, onProgress });
            return { ready: true, key: r.key, url: proxyUrl(project.id, r.key), duration: r.duration, width: r.width, height: r.height, hasAudio: r.hasAudio };
          },
        });
        return sendJson(ctx.res, 202, { ready: false, progress: job.percent, key: loc.key, job });
      }
      if (sub === 'proxy' && method === 'GET') {
        const { ref } = sourceOf({ doc: url.searchParams.get('doc') || undefined, source: url.searchParams.get('source') ?? '' });
        const loc = locateSource(project.dir, ref);
        if (proxyFor(project.dir, ref)) return sendJson(ctx.res, 200, { ready: true, progress: 100, key: loc.key, url: proxyUrl(project.id, loc.key) });
        const job = videoJobs.latest('proxy', loc.key, project.id);
        if (job?.status === 'running') return sendJson(ctx.res, 200, { ready: false, progress: job.percent, stage: job.stage, message: job.message, key: loc.key, job: job.id });
        if (job?.status === 'failed') return sendJson(ctx.res, 200, { ready: false, progress: 0, key: loc.key, error: job.error, job: job.id });
        return sendJson(ctx.res, 200, { ready: false, progress: 0, key: loc.key });
      }
      if (sub === 'waveform' && method === 'GET') {
        const { ref, entry } = sourceOf({ doc: url.searchParams.get('doc') || undefined, source: url.searchParams.get('source') ?? '' });
        const per = Number(url.searchParams.get('per') ?? 0.05);
        need(Number.isFinite(per) && per > 0 && per <= 600, 400, '"per" is the seconds each peak covers, for example 0.05.');
        return sendJson(ctx.res, 200, await waveformFor(project.dir, ref, { per, transcript: entry?.transcript ?? null }));
      }
      if (sub === 'jobs' && !seg[4] && method === 'GET') return sendJson(ctx.res, 200, { jobs: videoJobs.list(project.id, url.searchParams.get('kind') || undefined) });
      if (sub === 'jobs' && seg[4]) {
        const job = videoJobs.get(seg[4]);
        need(job && job.projectId === project.id, 404, 'No such render job.');
        if (seg[5] === 'cancel' && method === 'POST') { await readJsonBody(); return sendJson(ctx.res, 200, { cancelled: videoJobs.cancel(seg[4]) }); }
        need(method === 'GET', 405, 'Method not allowed.');
        const wait = Math.min(55, Math.max(0, Number(url.searchParams.get('wait') ?? 0) || 0));
        return sendJson(ctx.res, 200, { job: await videoJobs.wait(seg[4], wait * 1000) });
      }
      if (sub === 'stills' && method === 'POST') {
        const b = await readJsonBody();
        const session = docOf(b.doc);
        need(Array.isArray(b.times) && b.times.length > 0 && b.times.length <= 24 && b.times.every((t) => Number.isFinite(Number(t)) && Number(t) >= 0), 400, 'Give "times": a list of 1 to 24 times in seconds.');
        const format = b.format === 'png' ? 'png' : 'jpg';
        const out = mkdtempSync(join(tmpdir(), 'nordle-stills-'));
        try {
          const r = await pool.use((browser) => videoStills(session.file, b.times.map(Number), { browser, boxes: b.boxes === true, preview: b.preview !== false, scale: [0.25, 0.35, 0.5, 0.75, 1].includes(b.scale) ? b.scale : undefined, format, overlay: b.overlay !== false, size: b.size, out }));
          if (!r.ok) failed(r);
          const files = r.files.map((f) => ({ t: f.t, time: f.time, frame: f.frame, shows: f.shows, w: f.w, h: f.h, mime: format === 'png' ? 'image/png' : 'image/jpeg', base64: readFileSync(f.path).toString('base64'), ...(f.boxes ? { boxes: f.boxes } : {}) }));
          return sendJson(ctx.res, 200, { files, issues: r.issues });
        } finally { rmSync(out, { recursive: true, force: true }); }
      }
      if (sub === 'sheet' && method === 'POST') {
        const b = await readJsonBody();
        const session = docOf(b.doc);
        const r = await pool.use((browser) => videoSheet(session.file, { browser, size: b.size }));
        if (!r.ok) failed(r);
        return sendJson(ctx.res, 200, { path: rel(project.dir, r.sheet), mime: 'image/png', base64: readFileSync(r.sheet).toString('base64'), scenes: r.scenes, issues: r.issues });
      }
      if (sub === 'check' && method === 'POST') {
        const b = await readJsonBody();
        const session = docOf(b.doc);
        const c = loadDocContext(session.file);
        if (c.errors.length) return sendJson(ctx.res, 200, { ok: false, issues: c.errors.map((e) => ({ level: 'error', code: 'document', message: `${e.path}: ${e.message}` })) });
        const plan = await buildPlan({ doc: c.doc, brand: c.brand, projectDir: c.projectDir, platforms: c.platforms, size: b.size });
        return sendJson(ctx.res, 200, { ok: !plan.blocking.length, summary: summarisePlan(plan) });
      }
      if (sub === 'image' && method === 'POST') {
        // a picture the render wrote (the contact sheet, the cover), as base64, for Claude
        const b = await readJsonBody();
        need(typeof b.path === 'string' && /^out\/[a-z0-9][a-z0-9_-]*\/[A-Za-z0-9._-]+\.(png|jpg)$/i.test(b.path) && !b.path.includes('..'), 400, 'Give "path": a png or jpg inside out/<post>/.');
        const abs = join(project.dir, ...b.path.split('/'));
        need(existsSync(abs), 404, 'No such picture.');
        return sendJson(ctx.res, 200, { mime: b.path.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg', base64: readFileSync(abs).toString('base64') });
      }
      if (sub === 'probe' && method === 'POST') {
        const b = await readJsonBody();
        need(typeof b.path === 'string' && b.path, 400, 'Give "path": a project path or mount:name/path.');
        const p = await probeFor(project.dir, b.path);
        return sendJson(ctx.res, 200, { probe: { ...p, path: undefined }, summary: describeProbe(p) });
      }
      if (sub === 'mounts' && method === 'GET') {
        const mounts = loadMounts(project.dir);
        return sendJson(ctx.res, 200, { mounts: Object.entries(mounts).map(([name, folder]) => ({ name, available: existsSync(folder) })) });
      }
      if (sub === 'ls' && method === 'POST') {
        const b = await readJsonBody();
        need(typeof b.mount === 'string' && b.mount, 400, 'Give "mount": the mount name.');
        const entries = listMountDir(project.dir, b.mount, typeof b.dir === 'string' ? b.dir : '');
        return sendJson(ctx.res, 200, { mount: b.mount, dir: b.dir ?? '', entries: entries.slice(0, 400), truncated: entries.length > 400 });
      }
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if (e instanceof MountError || e?.name === 'FfmpegError' || e?.name === 'WordsError') throw new HttpError(422, e.message);
      throw new HttpError(422, e?.message ?? 'That could not be done.');
    }
    return false;
  },
};
