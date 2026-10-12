// One Claude job at a time per project, started from the Studio ("Ask Claude now", "Build it now") and tracked here so the page can say what Claude is doing
// and what it finished. The work itself is src/calendar/run.mjs (runPropose, runDue): this only starts it in the background, remembers the outcome, and
// refuses a second job in the same project while one is running (the run lock inside run.mjs refuses it too; this answers faster and in plain words).

import { SIGNED_OUT, SIGNED_OUT_MESSAGE } from './run.mjs';

const running = new Map();   // projectDir -> { kind, startedAt, item?, months? }
const finished = new Map();  // projectDir -> { kind, finishedAt, outcome, added?, error?, item? }
const queued = new Map();    // projectDir -> [{ kind, work, meta, queuedAt }]: asked for while Claude was busy; each starts when the one before ends
const MAX_QUEUE = 20;

/**
 * @param {string} dir
 * @param {'propose'|'build'} kind
 * @param {() => Promise<object>} work   resolves with run.mjs's result ({ ran:[{ outcome, added?, error? }] } or { locked } or { enabled:false })
 * @param {{ item?: string, months?: string[] }} [meta]
 */
export function startJob(dir, kind, work, meta = {}) {
  if (running.has(dir)) {
    // Claude is busy: the request waits in line (one place per post or per month; asking again does not add it twice)
    const same = (a) => a.kind === kind && (a.item ?? null) === (meta.item ?? null) && JSON.stringify(a.months ?? null) === JSON.stringify(meta.months ?? null);
    const line = queued.get(dir) ?? [];
    if (same(running.get(dir))) return { started: false, queued: false, alreadyRunning: true, running: { ...running.get(dir) } };
    const at = line.findIndex((q) => same({ kind: q.kind, ...q.meta }));
    if (at >= 0) return { started: false, queued: true, already: true, position: at + 1, running: { ...running.get(dir) } };
    if (line.length >= MAX_QUEUE) return { started: false, queued: false, full: true, running: { ...running.get(dir) } };
    line.push({ kind, work, meta, queuedAt: new Date().toISOString() });
    queued.set(dir, line);
    return { started: false, queued: true, position: line.length, running: { ...running.get(dir) } };
  }
  const info = { kind, startedAt: new Date().toISOString(), ...meta };
  running.set(dir, info);
  Promise.resolve().then(work).then(
    (res) => finished.set(dir, { kind, finishedAt: new Date().toISOString(), ...meta, ...summarise(res) }),
    (err) => finished.set(dir, { kind, finishedAt: new Date().toISOString(), ...meta, outcome: 'failed', error: String(err?.message ?? err) }),
  ).finally(() => {
    running.delete(dir);
    const line = queued.get(dir) ?? [];
    const next = line.shift();
    if (!line.length) queued.delete(dir);
    if (next) startJob(dir, next.kind, next.work, next.meta);
  });
  return { started: true, running: { ...info } };
}

/** What run.mjs answered, as one outcome and a plain error when there is one. */
export function summarise(res) {
  if (res?.locked) return { outcome: 'busy', error: 'Another Claude run is already going in this brand. Wait for it to finish.' };
  if (res?.enabled === false) return { outcome: 'off', error: res.reason ?? 'That run is switched off.' };
  const ran = res?.ran ?? [];
  if (!ran.length) return { outcome: 'nothing', error: res?.skipped ?? (res?.due?.length === 0 ? 'Nothing was due to build.' : 'Nothing needed doing.') };
  const first = ran[0];
  const error = first.error && SIGNED_OUT.test(first.error) ? SIGNED_OUT_MESSAGE : first.error;
  return { outcome: first.outcome, ...(first.added ? { added: first.added.length } : {}), ...(error ? { error } : {}), ...(first.turns ? { turns: first.turns } : {}), ...(typeof first.costUsd === 'number' ? { costUsd: Math.round(first.costUsd * 100) / 100 } : {}), runs: ran.length };
}

export const jobStatus = (dir) => ({ running: running.has(dir) ? { ...running.get(dir) } : null, last: finished.get(dir) ?? null, queue: (queued.get(dir) ?? []).map((q, i) => ({ kind: q.kind, ...q.meta, position: i + 1, queuedAt: q.queuedAt })) });

/** Where a post waits in line for its project: 1 is next. 0 when it is not in line. */
export const queuePosition = (dir, itemId) => ((queued.get(dir) ?? []).findIndex((q) => q.kind === 'build' && q.meta?.item === itemId) + 1);

/** Is Claude working on anything right now, in any project? (Signing out in the middle of a job would make it fail.) */
export const anyJobRunning = () => running.size > 0;

/** Forget everything (tests). */
export function clearJobs() { running.clear(); finished.clear(); queued.clear(); }
