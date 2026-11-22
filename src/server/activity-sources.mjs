// The Claude box's other sources (src/server/activity.mjs builds the box from Claude's own requests to this server). Here:
//   - the shared feed file (src/activity/feed.mjs): `nordle` commands, calendar changes made by scripts, a Claude Code session's work, from any process;
//   - the Studio's own Claude job line (src/calendar/jobs.mjs: "Build it now", "Ask Claude now"), which runs Claude headless;
//   - post media replaced on disk from outside (src/activity/watch.mjs), for work that goes through none of the above (a script that swaps a file, a hand copy).
// The owner's own clicks are never shown: a media change within a short time of the owner's own write to that brand, or of this server's own render
// job for it, is left out. Nothing here is saved; nothing here may break the box (every source is optional).

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readFeed, trimFeed } from '../activity/feed.mjs';
import { watchMedia } from '../activity/watch.mjs';
import { jobStatus } from '../calendar/jobs.mjs';
import { videoJobs } from '../video/jobs.mjs';

const OWN_MS = 15000;      // a media change this soon after the owner's own write, or this server's render, is its own doing
const FEED_CACHE_MS = 1000;

/**
 * @param {{store:object, activity:object, feedFile?:string|null, watch?:boolean, now?:()=>number, watchFn?:typeof watchMedia}} o
 */
export function createActivitySources({ store, activity, feedFile = null, watch = false, now = Date.now, watchFn = watchMedia }) {
  const human = new Map();                 // project -> when the owner last changed something in it through the Studio
  const cals = new Map();                  // project -> { mtime, items }
  let feedCache = { at: 0, value: { working: [], recent: [] } };
  let trimmedAt = 0;

  const dirOf = (p) => { try { return store.project(p)?.dir ?? null; } catch { return null; } };
  function calendarItems(p) {
    const dir = dirOf(p);
    if (!dir) return [];
    const file = join(dir, 'calendar.json');
    try {
      const m = statSync(file).mtimeMs;
      const c = cals.get(p);
      if (c && c.mtime === m) return c.items;
      const items = JSON.parse(readFileSync(file, 'utf8')).items ?? [];
      cals.set(p, { mtime: m, items });
      return items;
    } catch { return []; }
  }
  function titleOf(p, { item, doc }) {
    const items = calendarItems(p);
    const it = items.find((i) => (item && i.id === item) || (doc && (i.doc === doc || i.id === doc)));
    if (it?.title) return { title: it.title, item: it.id };
    try { const t = store.project(p)?.doc(doc)?.doc?.title; if (t) return { title: t, item: null }; } catch { /* not a document */ }
    return { title: '', item: null };
  }

  function feed() {
    if (!feedFile) return { working: [], recent: [] };
    const t = now();
    if (t - feedCache.at < FEED_CACHE_MS) return feedCache.value;
    const value = readFeed({ file: feedFile, now: t });
    for (const x of [...value.working, ...value.recent]) if (!x.title && x.project && (x.item || x.doc)) Object.assign(x, titleOf(x.project, x), { item: x.item ?? titleOf(x.project, x).item });
    feedCache = { at: t, value };
    if (t - trimmedAt > 600000) { trimmedAt = t; trimFeed({ file: feedFile }); }
    return value;
  }

  function jobs() {
    const working = [], recent = [];
    let projects = [];
    try { projects = store.scan(); } catch { return { working, recent }; }
    for (const p of projects) {
      const s = jobStatus(p.dir);
      const words = (kind) => (kind === 'build' ? { verb: 'Building', past: 'Built', what: 'the post' } : kind === 'propose' ? { verb: 'Coming up with ideas for', past: 'Came up with ideas for', what: 'the plan' } : { verb: 'Working on', past: 'Worked on', what: 'the plan' });
      const base = (j) => ({ project: p.id, doc: null, item: j.item ?? null, title: j.item ? titleOf(p.id, { item: j.item }).title : '', kind: 'job', steps: 1, source: 'claude', ...words(j.kind) });
      if (s.running) working.push({ id: `job-${p.id}-${s.running.startedAt}`, startedAt: s.running.startedAt, ...base(s.running) });
      if (s.last?.finishedAt) recent.push({ id: `job-${p.id}-${s.last.finishedAt}`, startedAt: s.last.finishedAt, finishedAt: s.last.finishedAt, ok: !['failed', 'busy', 'off'].includes(s.last.outcome), ...base(s.last) });
    }
    return { working, recent };
  }

  /** Was this media change the owner's own (a Studio upload) or this server's own render? */
  function ownDoing(project) {
    const t = now();
    if (t - (human.get(project) ?? 0) < OWN_MS) return true;
    try {
      for (const j of videoJobs.list(project)) if (j.status === 'running' || (j.finishedAt && t - j.finishedAt < OWN_MS)) return true;
    } catch { /* no job list */ }
    // a `nordle` command (or Claude through this server) already says it is working on this brand: its files are part of that line
    return feed().working.some((x) => x.project === project);
  }

  const watcher = watch ? watchFn(store.roots ?? [], (c) => {
    if (ownDoing(c.project)) return;
    const who = titleOf(c.project, c.area === 'external' ? { item: c.id } : { doc: c.id });
    activity.touch({
      project: c.project, doc: c.area === 'out' ? c.id : null, item: who.item ?? (c.area === 'external' ? c.id : null), title: who.title,
      kind: 'media', verb: 'Changing', past: 'Changed', what: c.video ? 'the video' : 'the pictures', source: 'outside',
    });
  }) : null;

  return {
    /** What the feed and the job line add to the box. */
    extra() {
      const a = feed(), b = jobs();
      return { working: [...a.working, ...b.working], recent: [...a.recent, ...b.recent] };
    },
    /** The owner changed something in this brand through the Studio. */
    noteHuman(project) { if (project) human.set(project, now()); },
    close() { watcher?.close(); },
  };
}
