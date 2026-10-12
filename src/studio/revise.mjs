// "Request changes" does the change. When the owner sends a post back in the Studio, the designer (the headless runner in
// src/calendar/run.mjs: `claude -p` with the Nordle tools) starts on it straight away, instead of the post sitting on "changes"
// until someone runs `nordle calendar run` or opens a Claude session.
//
//  - Only the owner's click gets here (the route checks the human token); the project's `autoRevise` setting (on by default) can turn it off.
//  - One revision at a time per project (the runner's own lock; clicks on other posts queue behind it). A project another
//    process is already building in is retried every 30 seconds for up to 30 minutes.
//  - Undo on the request stops a revision that is running (the child process tree is killed by PID).
//  - A restart of the server puts back what a dead run left half-done and starts that revision again.
//  - `run` is injected so tests never start a real Claude. The real server passes `createReviser()` to createNordleServer.

import { recoverStale, runDue } from '../calendar/run.mjs';
import { readRunLock } from '../calendar/lock.mjs';
import { loadProject, takeQueuedRevisions } from '../calendar/service.mjs';
import { locate } from './data.mjs';

const sleep = (ms, signal) => new Promise((done) => {
  const t = setTimeout(done, ms);
  signal?.addEventListener?.('abort', () => { clearTimeout(t); done(); }, { once: true });
});

/**
 * @param {{ run?: typeof runDue, retryMs?: number, maxWaits?: number, log?: (msg:string)=>void }} [opts]
 */
export function createReviser({ run = runDue, retryMs = 30000, maxWaits = 60, log = (m) => console.log(`[revise] ${m}`) } = {}) {
  const jobs = new Map();     // uid -> { controller, state: 'queued' | 'waiting' | 'running' | 'done', result?, done: Promise }
  const tails = new Map();    // project dir -> the last promise queued there (one revision at a time per project)

  async function work(job, dir, itemId) {
    const { signal } = job.controller;
    for (let waits = 0; !signal.aborted; waits++) {
      job.state = 'running';
      let r;
      try {
        r = await run({ projectDir: dir, itemId, yes: true, signal, log });
      } catch (e) {
        job.result = { outcome: 'failed', error: e.message };
        log(`${itemId}: ${e.message}`);
        return;
      }
      if (r.locked && waits < maxWaits) { job.state = 'waiting'; await sleep(retryMs, signal); continue; }
      job.result = r.ran?.[0] ?? (r.locked ? { outcome: 'busy', error: 'Another run held the project for too long.' } : { outcome: 'skipped' });
      log(`${itemId}: ${job.result.outcome}${job.result.error ? ` (${job.result.error})` : ''}`);
      return;
    }
  }

  function enqueue(uid, dir, itemId) {
    const job = { controller: new AbortController(), state: 'queued', result: null, done: null };
    jobs.set(uid, job);
    const run1 = (tails.get(dir) ?? Promise.resolve()).then(() => (job.controller.signal.aborted ? null : work(job, dir, itemId)));
    job.done = run1.catch((e) => { job.result = { outcome: 'failed', error: e.message }; }).finally(() => {
      job.state = 'done';
      if (jobs.get(uid) === job) jobs.delete(uid);
      if (tails.get(dir) === job.done) tails.delete(dir);
    });
    tails.set(dir, job.done);
    return job;
  }

  return {
    /**
     * Start the designer on a post the owner has just sent back.
     * @returns {{started:boolean, reason?:'off'|'no-post'|'not-sent-back', already?:boolean, job?:object}}
     */
    start(store, uid) {
      const at = locate(store, uid);
      if (!at?.item || !at.item.doc) return { started: false, reason: 'no-post' };
      if (at.item.status !== 'changes') return { started: false, reason: 'not-sent-back' };
      if (!loadProject(at.project.dir).settings.autoRevise) return { started: false, reason: 'off' };
      if (jobs.has(uid)) return { started: true, already: true, job: jobs.get(uid) };
      return { started: true, job: enqueue(uid, at.project.dir, at.item.id) };
    },

    /** The owner took the request back (Undo): stop a revision that is waiting or running. */
    cancel(uid) {
      const job = jobs.get(uid);
      if (!job) return false;
      job.controller.abort();
      return true;
    },

    /** Start the designer on posts whose changes were asked for while they were being built and are now back. Safe to call often. */
    async sweep(store) {
      const started = [];
      for (const project of store.scan()) {
        try {
          for (const id of await takeQueuedRevisions(project.dir)) { const uid = `${project.id}:${id}`; if (this.start(store, uid).started) started.push(uid); }
        } catch (e) { log(`${project.id}: could not start queued changes (${e.message})`); }
      }
      return started;
    },

    running: (uid) => jobs.has(uid),
    pending: () => [...jobs.keys()],

    /** Wait for every revision started so far (tests, and a clean shutdown). */
    async idle() { while (jobs.size) await Promise.all([...jobs.values()].map((j) => j.done)); },

    /**
     * At server start: put back what a dead run left on "building", and start those revisions again. A post that was sent back
     * earlier and never started is left alone (only the owner's click, or `nordle calendar run`, starts it).
     */
    async recover(store) {
      const started = [];
      for (const project of store.scan()) {
        try {
          if (readRunLock(project.dir)) continue;                      // somebody is running in it right now
          const back = await recoverStale(project.dir, Date.now(), 0);
          if (!back.length) continue;
          const cal = loadProject(project.dir).cal;
          for (const id of back) {
            const item = cal.items.find((i) => i.id === id);
            if (item?.status === 'changes' && item.doc) { const uid = `${project.id}:${item.id}`; if (this.start(store, uid).started) started.push(uid); }
          }
          log(`${project.id}: put back ${back.join(', ')}`);
        } catch (e) { log(`${project.id}: could not recover (${e.message})`); }
      }
      return started;
    },
  };
}
