// What Claude is doing, in plain words, for the Studio's left bar ("Claude is changing the video ..." and then a tick when it is done).
// Everything Claude does in Nordle goes through the server with Claude's own token (the MCP server, the headless build runs), so the server can say what
// it is doing without asking Claude anything: a request that changes something is described, grouped by the post it is about, and shown as "working" for
// as long as requests keep coming (a short quiet gap ends a piece of work, because Claude works in bursts of small edits). A render started by Claude
// is followed through the video job list, so a long render says how far it is. Only Claude's requests are noted: the owner's own clicks are not.
// Nothing here is saved to disk. GET /api/activity returns the picture; reading it changes nothing.

import { videoJobs } from '../video/jobs.mjs';

export const QUIET_MS = 7000;       // no request for this long and the piece of work is finished
const KEEP = 12;                    // finished pieces of work kept for the list

const safe = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

/**
 * What a request from Claude does, in plain words, or null when it is not worth a line (a read). `lookup(project, doc)` says { video, title } for a document.
 * @returns {{kind:string, verb:string, past:string, what:string, project:string, doc?:string, job?:boolean}|null}
 */
export function describeRequest(method, pathname, lookup = () => ({})) {
  if (method === 'GET' || method === 'HEAD') return null;
  const seg = pathname.split('/').filter(Boolean).slice(1).map(safe);
  const [a, project, b, c, d] = seg;
  if (a === 'stock' && project === 'get') return { kind: 'stock', verb: 'Getting', past: 'Got', what: 'a stock file', project: '' };
  if (a !== 'projects' || !project) return null;
  const mk = (kind, verb, past, what, doc, job = false) => ({ kind, verb, past, what, project, ...(doc ? { doc } : {}), ...(job ? { job: true } : {}) });
  if (b === 'docs' && c) {
    const video = !!lookup(project, c).video;
    const thing = video ? 'the video' : 'the design';
    switch (d) {
      case 'patch': return mk(video ? 'video' : 'design', 'Changing', 'Changed', thing, c);
      case 'comment': case 'reply': case 'resolve': return mk('comment', 'Answering a comment on', 'Answered a comment on', 'the post', c);
      case 'versions': return mk('version', 'Saving a version of', 'Saved a version of', thing, c);
      case 'settings': return mk('settings', 'Changing the settings of', 'Changed the settings of', thing, c);
      case 'approve': return null;
      default: return mk('doc', 'Working on', 'Worked on', thing, c);
    }
  }
  if (b === 'video') {
    switch (c) {
      case 'render': return mk('render', 'Rendering', 'Rendered', 'the video', null, true);
      case 'proxy': return mk('proxy', 'Preparing', 'Prepared', 'a preview of the footage', null, true);
      case 'stills': case 'sheet': case 'image': return mk('stills', 'Taking pictures from', 'Took pictures from', 'the video');
      case 'check': return mk('check', 'Checking', 'Checked', 'the video');
      case 'probe': case 'ls': return mk('look', 'Looking at', 'Looked at', 'the footage');
      default: return null;
    }
  }
  if (b === 'cut') return mk('cut', 'Cutting', 'Cut', 'the video');
  if (b === 'checks') return mk('check', 'Checking', 'Checked', 'a post');
  if (b === 'assets') return mk('asset', 'Adding a file to', 'Added a file to', 'a post');
  if (b === 'calendar') return mk('plan', 'Updating', 'Updated', 'the plan');
  if (b === 'performance') return mk('review', 'Writing', 'Wrote', 'the review');
  return mk('other', 'Working on', 'Worked on', 'this brand');
}

/**
 * @param {{lookup?:(project:string, doc:string)=>{video?:boolean, title?:string}, nameOf?:(project:string)=>string, now?:()=>number, quietMs?:number}} o
 */
export function createActivity({ lookup = () => ({}), nameOf = (p) => p, now = Date.now, quietMs = QUIET_MS } = {}) {
  let seq = 0;
  let n = 0;
  const items = new Map();       // key -> a piece of work that is going on
  const recent = [];             // finished pieces of work, newest first
  const safeLookup = (p, d) => { try { return lookup(p, d) ?? {}; } catch { return {}; } };
  const safeName = (p) => { try { return nameOf(p) || p; } catch { return p; } };

  const jobOf = (it) => (it.jobId ? videoJobs.get(it.jobId) : null);
  const alive = (it, t) => it.inflight > 0 || t - it.lastAt < quietMs || jobOf(it)?.status === 'running';

  /** Pieces of work that have gone quiet are finished: move them to the list. */
  function settle(t = now()) {
    for (const [key, it] of items) {
      if (alive(it, t)) continue;
      const job = jobOf(it);
      it.finishedAt = job?.finishedAt ?? it.lastAt;
      it.ok = !(it.lastStatus >= 500) && !(job && job.status === 'failed');
      items.delete(key);
      recent.unshift(it);
      seq++;
    }
    recent.length = Math.min(recent.length, KEEP);
  }

  const view = (it) => {
    const job = jobOf(it);
    const info = it.doc ? safeLookup(it.project, it.doc) : {};
    const running = !it.finishedAt;
    return {
      id: it.id, project: it.project, projectName: it.project ? safeName(it.project) : '', doc: it.doc ?? null, title: info.title ?? it.title ?? (it.project ? safeName(it.project) : ''),
      kind: it.kind, verb: it.verb, past: it.past, what: it.what, startedAt: new Date(it.startedAt).toISOString(), steps: it.steps,
      ...(running ? {} : { finishedAt: new Date(it.finishedAt).toISOString(), ok: it.ok }),
      ...(job && running ? { percent: job.percent, message: job.message } : {}),
    };
  };

  return {
    /** A request from Claude has arrived. Returns { end(status, body) } to call when it is answered, or null when it is not worth a line. */
    begin(method, pathname) {
      const d = describeRequest(method, pathname, safeLookup);
      if (!d) return null;
      const t = now();
      settle(t);
      let it = null;
      const attach = (doc) => {
        const key = `${d.project}|${doc ?? d.kind}`;
        it = items.get(key);
        if (!it) {
          it = { id: `a${++n}`, key, project: d.project, doc: doc ?? null, kind: d.kind, verb: d.verb, past: d.past, what: d.what, startedAt: t, lastAt: t, steps: 0, inflight: 0, lastStatus: 0, jobId: null };
          items.set(key, it);
          seq++;
        }
        return it;
      };
      attach(d.doc);
      it.inflight++;
      it.verb = d.verb; it.past = d.past; it.what = d.what; it.kind = d.kind; it.lastAt = t;
      return {
        /** `body` is what Claude sent, when it said which document it is about (a render, a cut, a check). */
        end(status, body, extra = {}) {
          const t2 = now();
          const doc = !it.doc && body && typeof body.doc === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(body.doc) ? body.doc : null;
          if (doc) { items.delete(it.key); it.doc = doc; it.key = `${d.project}|${doc}`; const had = items.get(it.key); if (had) { had.inflight += it.inflight; had.steps += it.steps; Object.assign(had, { verb: it.verb, past: it.past, what: it.what, kind: it.kind }); it = had; } else items.set(it.key, it); }
          it.inflight = Math.max(0, it.inflight - 1);
          it.lastAt = t2; it.lastStatus = status; if (status < 400) it.steps++;      // a refused request is not a step
          if (extra.jobId) it.jobId = extra.jobId;
          seq++;
        },
      };
    },
    snapshot() {
      settle();
      return { seq, at: new Date(now()).toISOString(), working: [...items.values()].map(view), recent: recent.map(view) };
    },
  };
}
