// Keep Buffer matching Nordle without being asked: when the calendar changes (a scheduled post is moved to another day, taken off, rejected, or a post that
// was in Buffer is no longer signed off), the server reads what Buffer holds for that brand and moves or deletes posts to match (src/publish/sync.mjs).
//
//   * It is the owner's standing instruction ("make sure Nordle deletes or moves posts on Buffer to match Nordle"), on unless the owner turns it off
//     (settings `autoSync: { enabled: false }`).
//   * It does only what `nordle publish sync` does by default: move, adopt, and delete the posts Nordle's own items say should not go. Posts that match nothing
//     in Nordle (made by hand in Buffer), drafts and errors are never touched.
//   * It is careful with Buffer's small request allowance (100 per 15 minutes, 250 a day): it watches the calendar FILES (free), waits until the calendar has
//     been quiet for a minute, waits at least ten minutes between runs for one brand, and otherwise looks only every six hours. A read costs one request per
//     100 posts, and it stops when the day's allowance is nearly used.

import { loadProject } from '../calendar/service.mjs';
import { loadSettings, resolveSettings } from './store.mjs';
import { describeSync, planSync, runSync } from './sync.mjs';

export const QUIET_MS = 60000;
export const MIN_GAP_MS = 10 * 60000;
export const EVERY_MS = 6 * 3600000;

export const autoSyncEnabled = (settings = loadSettings()) => settings.autoSync?.enabled !== false;

/** What decides whether Buffer has to change: every item's status, day and time, and where it is recorded as scheduled. */
export function calendarSignature(projectDir) {
  const { cal } = loadProject(projectDir);
  return JSON.stringify(cal.items.map((i) => [i.id, i.status, i.date, i.time ?? null, (i.publish?.targets ?? []).map((t) => `${t.remoteId}@${t.scheduledAt}`)]));
}

export function createAutoSync({ intervalMs = 30000, plan = planSync, run = runSync, now = () => Date.now(), log = (m) => console.log(`[sync] ${m}`), signature = calendarSignature } = {}) {
  let timer = null, busy = false;
  const state = new Map();      // project dir -> { sig, changedAt, lastRun }

  async function syncOne(project, t) {
    const st = state.get(project.dir);
    try {
      const s = resolveSettings(loadSettings(), 'buffer', project.id);
      if (!s.token || !(s.channelCache ?? []).length) return;
      const p = await plan(project.dir, { role: 'human', now: t });
      st.lastRun = t;
      if (!p.actions.length) { log(`${project.id}: Buffer already matches (${p.kept} posts${p.missing.length ? `, ${p.missing.length} Nordle posts are not in Buffer` : ''})`); return; }
      log(`${project.id}: ${p.actions.length} change${p.actions.length === 1 ? '' : 's'} in Buffer\n${describeSync(p)}`);
      const r = await run(project.dir, p, { role: 'human', now: t });
      log(`${project.id}: ${r.done.length} changed${r.failed.length ? `, ${r.failed.length} failed (${r.failed.map((f) => f.error).join('; ').slice(0, 200)})` : ''}`);
    } catch (e) {
      st.lastRun = t;           // do not hammer Buffer: the next try is after the minimum gap
      log(`${project.id}: could not sync (${e.message})`);
    } finally {
      try { st.sig = signature(project.dir); st.changedAt = null; } catch { /* the calendar may be mid-write */ }
    }
  }

  async function tick(store) {
    if (busy) return;
    busy = true;
    try {
      if (!autoSyncEnabled()) return;
      const t = now();
      for (const project of store.scan()) {
        let sig;
        try { sig = signature(project.dir); } catch { continue; }
        let st = state.get(project.dir);
        if (!st) { st = { sig: null, changedAt: t - QUIET_MS, lastRun: 0 }; state.set(project.dir, st); }
        if (sig !== st.sig) { if (st.sig !== null || st.changedAt === null) st.changedAt = t; st.sig = sig; if (!st.pending) st.pending = true; }
        const quiet = st.changedAt !== null && t - st.changedAt >= QUIET_MS;
        const due = (st.pending && quiet && t - st.lastRun >= MIN_GAP_MS) || t - st.lastRun >= EVERY_MS;
        if (!due) continue;
        st.pending = false;
        await syncOne(project, t);
      }
    } finally { busy = false; }
  }

  return {
    start(store) { if (timer) return; timer = setInterval(() => { tick(store).catch((e) => log(`tick failed: ${e.message}`)); }, intervalMs); timer.unref?.(); tick(store).catch((e) => log(`tick failed: ${e.message}`)); },
    stop() { if (timer) clearInterval(timer); timer = null; },
    tick,
    state,
  };
}
