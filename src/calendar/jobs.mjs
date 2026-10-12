// One Claude job at a time per project, started from the Studio ("Ask Claude now", "Build it now") and tracked here so the page can say what Claude is doing
// and what it finished. The work itself is src/calendar/run.mjs (runPropose, runDue): this only starts it in the background, remembers the outcome, and
// refuses a second job in the same project while one is running (the run lock inside run.mjs refuses it too; this answers faster and in plain words).

import { SIGNED_OUT, SIGNED_OUT_MESSAGE } from './run.mjs';

const running = new Map();   // projectDir -> { kind, startedAt, item?, months? }
const finished = new Map();  // projectDir -> { kind, finishedAt, outcome, added?, error?, item? }

/**
 * @param {string} dir
 * @param {'propose'|'build'} kind
 * @param {() => Promise<object>} work   resolves with run.mjs's result ({ ran:[{ outcome, added?, error? }] } or { locked } or { enabled:false })
 * @param {{ item?: string, months?: string[] }} [meta]
 */
export function startJob(dir, kind, work, meta = {}) {
  if (running.has(dir)) return { started: false, running: { ...running.get(dir) } };
  const info = { kind, startedAt: new Date().toISOString(), ...meta };
  running.set(dir, info);
  Promise.resolve().then(work).then(
    (res) => finished.set(dir, { kind, finishedAt: new Date().toISOString(), ...meta, ...summarise(res) }),
    (err) => finished.set(dir, { kind, finishedAt: new Date().toISOString(), ...meta, outcome: 'failed', error: String(err?.message ?? err) }),
  ).finally(() => running.delete(dir));
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
  return { outcome: first.outcome, ...(first.added ? { added: first.added.length } : {}), ...(error ? { error } : {}), runs: ran.length };
}

export const jobStatus = (dir) => ({ running: running.has(dir) ? { ...running.get(dir) } : null, last: finished.get(dir) ?? null });

/** Forget everything (tests). */
export function clearJobs() { running.clear(); finished.clear(); }
