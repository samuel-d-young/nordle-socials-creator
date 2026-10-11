// Watch the calendars for posts the owner sends back, and say so the moment it happens (one line per post). It is how an open Claude
// session (which is signed in, unlike a `claude -p` the server would start) can pick up "Request changes" at once:
//   node nordle.mjs calendar watch [project] [--backlog]
// Each printed line is `SENT-BACK <project> <item> doc=<doc> | <what was asked>`; the session then makes the change.
// Reading only: it never changes a calendar.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { listProjects } from './service.mjs';

const sleep = (ms, signal) => new Promise((done) => {
  const t = setTimeout(done, ms);
  signal?.addEventListener?.('abort', () => { clearTimeout(t); done(); }, { once: true });
});

/** What identifies "this post has just been sent back": it is in `changes` with a post, and how many times it has been asked. */
export const signatureOf = (item) => (item?.status === 'changes' && item.doc ? `changes|${(item.feedback ?? []).length}` : null);

const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
export function lineFor(project, item) {
  const last = [...(item.feedback ?? [])].reverse().find((f) => (f.by ?? 'owner') === 'owner');
  const ask = String(last?.comment ?? '').replace(/^Pinned notes:\s*(-\s*)?/i, '').replace(/\s*\n\s*-\s*/g, ' | ').replace(/\s+/g, ' ').trim();
  return `SENT-BACK ${project} ${item.id} doc=${item.doc} | ${clip(ask || '(no written comment: read the pins)', 400)}`;
}

/**
 * @param {{ roots?: string[], project?: string, every?: number, backlog?: boolean, out?: (line:string)=>void, signal?: AbortSignal }} [opts]
 * The first pass remembers what is already sent back (and prints it only with `backlog`); after that every newly sent-back post,
 * and every time one is sent back again, prints a line.
 */
export async function watchSentBack({ roots, project, every = 3, backlog = false, out = console.log, signal } = {}) {
  const seen = new Map();       // "project:item" -> signature
  const stamps = new Map();     // calendar file -> mtime:size, so an unchanged file is not parsed again
  let first = true;
  out(`WATCHING ${project ?? 'all projects'} for posts sent back (every ${every}s)`);
  while (!signal?.aborted) {
    for (const p of listProjects(roots).filter((x) => !project || x.id === project)) {
      const file = join(p.dir, 'calendar.json');
      if (!existsSync(file)) continue;
      let st;
      try { st = statSync(file); } catch { continue; }
      const stamp = `${st.mtimeMs}:${st.size}`;
      if (stamps.get(file) === stamp) continue;
      let cal;
      try { cal = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }      // caught mid-write: look again next time
      stamps.set(file, stamp);
      for (const item of Array.isArray(cal.items) ? cal.items : []) {
        const key = `${p.id}:${item.id}`;
        const sig = signatureOf(item);
        const before = seen.get(key) ?? null;
        if (sig) seen.set(key, sig); else seen.delete(key);
        if (sig && sig !== before && (!first || backlog)) out(lineFor(p.id, item));
      }
    }
    first = false;
    await sleep(every * 1000, signal);
  }
}
