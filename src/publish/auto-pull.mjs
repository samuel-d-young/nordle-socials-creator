// Pull what Buffer knows by itself, so nobody has to press "Update from Buffer".
//
// Every few hours (the owner's choice), for each brand that has a Buffer account and chosen channels:
//   1. the posts that went out and how they did (src/publish/remote.mjs `syncSentPosts`, one request per 100 posts; "When to post" reads this),
//   2. those numbers become Insights entries on the posts they belong to (src/performance/from-buffer.mjs),            [option `results`]
//   3. posts made by hand in Buffer are copied onto the calendar, read only (src/publish/buffer-import.mjs).           [option `handMade`]
//
// How often and what to read are the owner's options (src/publish/pull-options.mjs, shown in Insights > Options). On unless switched off. It is careful
// with Buffer's small request allowance (100 per 15 minutes, 250 a day): a brand is read at most as often as the owner chose (the time of the last pull is
// on disk, so a restart does not read again), the optional-read reserve in remote.mjs still applies, and a refused or failed try waits an hour.
// Nothing here writes to Buffer.

import { loadSettings, resolveSettings } from './store.mjs';
import { readSentPosts, syncSentPosts } from './remote.mjs';
import { importFromBuffer } from './buffer-import.mjs';
import { pullOptions } from './pull-options.mjs';
import { importBufferMetrics } from '../performance/from-buffer.mjs';

export const EVERY_MS = 6 * 3600000;       // the default; the owner can choose 1, 3, 6, 12 or 24 hours
export const RETRY_MS = 3600000;
export const autoPullEnabled = (settings = loadSettings()) => pullOptions(settings).enabled;

/** Is this brand connected enough to ask Buffer anything? */
export const connected = (settings, projectId) => { const s = resolveSettings(settings, 'buffer', projectId); return !!s.token && (s.channels ?? []).length > 0; };

export function createAutoPull({ intervalMs = 10 * 60000, pull = syncSentPosts, metrics = importBufferMetrics, bring = importFromBuffer, now = () => Date.now(), log = (m) => console.log(`[buffer] ${m}`), settingsOf = loadSettings, lastPull = (dir) => Date.parse(readSentPosts(dir).pulledAt ?? '') || 0 } = {}) {
  let timer = null, busy = false;
  const state = new Map();        // project dir -> { failedAt }

  async function one(store, project, t, o) {
    const st = state.get(project.dir) ?? state.set(project.dir, { failedAt: 0 }).get(project.dir);
    if (t - lastPull(project.dir) < o.everyHours * 3600000 || t - st.failedAt < RETRY_MS) return;
    try {
      const got = await pull(store, { project: project.id, role: 'human', now: t });
      if (got.skipped) return;
      const parts = [`read ${got.fetched} sent post${got.fetched === 1 ? '' : 's'} from Buffer (${got.requests} request${got.requests === 1 ? '' : 's'})`];
      if (o.results) { const m = await metrics(project.dir, { today: new Date(t).toISOString().slice(0, 10) }); parts.push(`numbers for ${m.matched ?? 0} of your posts`); }
      if (o.handMade) {
        const c = await bring(store, { project: project.id, role: 'human', now: t, days: o.days, maxNew: o.maxNew, covers: o.covers });
        parts.push(`${c.created} post${c.created === 1 ? '' : 's'} made in Buffer added to the calendar${c.updated || c.gone ? `, ${c.updated} followed, ${c.gone} removed` : ''}`);
      }
      log(`${project.id}: ${parts.join('; ')}`);
      st.failedAt = 0;
    } catch (e) {
      st.failedAt = t;                                  // do not hammer Buffer: the next try is in an hour
      log(`${project.id}: could not read Buffer (${String(e.message).slice(0, 200)})`);
    }
  }

  async function tick(store) {
    if (busy) return;
    busy = true;
    try {
      const settings = settingsOf();
      const o = pullOptions(settings);
      if (!o.enabled) return;
      const t = now();
      for (const project of store.scan()) {
        if (!connected(settings, project.id)) continue;
        await one(store, project, t, o);
      }
    } finally { busy = false; }
  }

  return {
    start(store) { if (timer) return; timer = setInterval(() => { tick(store).catch((e) => log(`tick failed: ${e.message}`)); }, intervalMs); timer.unref?.(); setTimeout(() => tick(store).catch((e) => log(`tick failed: ${e.message}`)), 15000).unref?.(); },
    stop() { if (timer) clearInterval(timer); timer = null; },
    tick,
    state,
  };
}
