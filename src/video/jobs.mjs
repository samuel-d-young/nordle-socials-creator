// Renders take a while, so the server runs them as jobs: start one, ask how it is going (optionally waiting a little for
// news), cancel it. Jobs live in memory in the server process; the files they write are in the project's out/ folder.
// Other long work (making a browser-playable proxy of footage, src/video/proxy.mjs) runs as a job of another `kind`
// through startTask, so one list, one status call and one cancel serve them all.

import { randomBytes } from 'node:crypto';
import { relative, sep } from 'node:path';
import { renderVideo } from './render.mjs';

const rel = (dir, p) => (p ? relative(dir, p).split(sep).join('/') : p);

export class VideoJobs {
  constructor({ keep = 30 } = {}) {
    this.keep = keep;
    this.jobs = new Map();
    this.waiters = new Map();
  }

  #add(job) {
    this.jobs.set(job.id, job);
    for (const old of [...this.jobs.keys()].slice(0, Math.max(0, this.jobs.size - this.keep))) if (this.jobs.get(old).status !== 'running') this.jobs.delete(old);
  }

  /** @param {{project:object, docId:string, file:string, options?:object}} o */
  start({ project, docId, file, options = {} }) {
    const format = String(options.format ?? 'mp4');
    const busy = [...this.jobs.values()].find((j) => j.kind === 'render' && j.status === 'running' && j.projectId === project.id && j.doc === docId && j.options.preview === !!options.preview && j.options.format === format);
    if (busy) return this.snapshot(busy);
    const id = randomBytes(5).toString('hex');
    const ac = new AbortController();
    const job = {
      id, kind: 'render', projectId: project.id, doc: docId, status: 'running', percent: 0, stage: 'starting', message: 'Starting', startedAt: Date.now(), finishedAt: null,
      options: { preview: !!options.preview, from: options.from, to: options.to, size: options.size, format, maxWidth: options.maxWidth }, result: null, error: null, ac,
    };
    this.#add(job);
    renderVideo(file, {
      ...options, signal: ac.signal,
      onProgress: (p) => { job.percent = p.percent; job.stage = p.stage; job.message = p.message; this.#poke(id); },
    }).then((r) => {
      job.status = r.ok ? 'done' : 'failed';
      job.percent = r.ok ? 100 : job.percent;
      job.result = {
        ...r,
        file: rel(project.dir, r.file),
        files: Object.fromEntries(Object.entries(r.files ?? {}).map(([k, v]) => [k, rel(project.dir, v)])),
      };
      if (!r.ok) job.error = (r.errors ?? []).map((e) => e.message).join('\n') || 'The video could not be rendered.';
    }).catch((e) => {
      job.status = ac.signal.aborted ? 'cancelled' : 'failed';
      job.error = e.message;
    }).finally(() => { job.finishedAt = Date.now(); this.#poke(id); });
    return this.snapshot(job);
  }

  /**
   * Any other long job. `run({ signal, onProgress })` does the work and returns the result object; onProgress takes
   * { percent, stage?, message? }. A job of the same kind and key that is already running is returned instead of a second one.
   * @param {{project:object, kind:string, key:string, docId?:string|null, label?:string, options?:object, run:Function}} o
   */
  startTask({ project, kind, key, docId = null, label = '', options = {}, run }) {
    const same = [...this.jobs.values()].find((j) => j.status === 'running' && j.kind === kind && j.key === key && j.projectId === project.id);
    if (same) return this.snapshot(same);
    const id = randomBytes(5).toString('hex');
    const ac = new AbortController();
    const job = {
      id, kind, key, label, projectId: project.id, doc: docId, status: 'running', percent: 0, stage: 'starting', message: 'Starting', startedAt: Date.now(), finishedAt: null,
      options, result: null, error: null, ac,
    };
    this.#add(job);
    Promise.resolve().then(() => run({
      signal: ac.signal,
      onProgress: (p) => {
        if (typeof p.percent === 'number') job.percent = Math.max(0, Math.min(100, Math.round(p.percent)));
        if (p.stage) job.stage = p.stage;
        if (p.message) job.message = p.message;
        this.#poke(id);
      },
    })).then((r) => {
      job.status = 'done';
      job.percent = 100;
      job.result = r ?? null;
    }).catch((e) => {
      job.status = ac.signal.aborted ? 'cancelled' : 'failed';
      job.error = e.message;
    }).finally(() => { job.finishedAt = Date.now(); this.#poke(id); });
    return this.snapshot(job);
  }

  /** The newest job of this kind and key in this project (running, or the last one that ended), or null. */
  latest(kind, key, projectId) {
    let found = null;
    for (const j of this.jobs.values()) if (j.kind === kind && j.key === key && j.projectId === projectId) found = j;
    return found ? this.snapshot(found) : null;
  }

  snapshot(job) {
    const { ac, ...rest } = job;
    void ac;
    return { ...rest, seconds: Number((((job.finishedAt ?? Date.now()) - job.startedAt) / 1000).toFixed(1)) };
  }

  get(id) { const j = this.jobs.get(id); return j ? this.snapshot(j) : null; }

  list(projectId, kind) { return [...this.jobs.values()].filter((j) => (!projectId || j.projectId === projectId) && (!kind || j.kind === kind)).map((j) => this.snapshot(j)).reverse(); }

  cancel(id) {
    const j = this.jobs.get(id);
    if (!j || j.status !== 'running') return false;
    j.ac.abort();
    return true;
  }

  /** Resolves with the job as soon as something changes, or after `ms`. */
  wait(id, ms) {
    const j = this.jobs.get(id);
    if (!j || j.status !== 'running' || !ms) return Promise.resolve(this.get(id));
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      const list = this.waiters.get(id) ?? [];
      this.waiters.set(id, list);
      function done() { clearTimeout(timer); resolve(); }
      list.push(done);
    }).then(() => this.get(id));
  }

  #poke(id) {
    const j = this.jobs.get(id);
    if (j && j.status === 'running') return; // progress ticks do not wake waiters; only the end does
    for (const w of this.waiters.get(id) ?? []) w();
    this.waiters.delete(id);
  }
}

export const videoJobs = new VideoJobs();
