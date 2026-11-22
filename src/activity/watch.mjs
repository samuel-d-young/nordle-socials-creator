// Watches the project folders for a post's video or pictures being replaced from outside the Studio (a script, a Claude Code session, a file copy),
// so the left bar's Claude box can say "Changing the video ... 'Morning at the pier'". Only finished media in a post's own folder counts:
//   <project>/external/<calendar item id>/<file>     a reel or picture made outside Nordle
//   <project>/out/<document id>/<file>               what Nordle rendered
// Temporary and backup names (.tmp, .part, .steady., .pre-*, ~) are ignored. The server leaves out changes it made itself (its own render jobs, the
// owner's own uploads): see `quiet` in src/server/http.mjs.

import { statSync, watch } from 'node:fs';
import { join, sep } from 'node:path';

const MEDIA = /\.(mp4|mov|webm|m4v|jpe?g|png|webp)$/i;
const SCRATCH = /(\.tmp|\.part|\.steady\.|\.pre-[a-z0-9-]+\.|~$|\.crdownload$)|(^|[\\/])\./i;
const ID = /^[a-z0-9][a-z0-9_-]*$/;
const FRESH_MS = 15000;

/**
 * Was the file written just now? Windows also reports a change when a file is only READ (its last-access time moves), so opening the Studio, which
 * loads every thumbnail, looked like a change to each of those posts. A write, copy or rename moves mtime or ctime; a read moves neither.
 */
export const writtenJustNow = (stat, now = Date.now()) => now - Math.max(stat.mtimeMs, stat.ctimeMs) < FRESH_MS;

/** A changed file, relative to a projects folder, as { project, area, id, video } or null when it is not a post's media. */
export function mediaChange(rel) {
  const parts = String(rel).split(/[\\/]/).filter(Boolean);
  if (parts.length < 4) return null;
  const [project, area, id] = parts;
  const file = parts.at(-1);
  if (!['external', 'out'].includes(area) || !ID.test(project) || !ID.test(id)) return null;
  if (!MEDIA.test(file) || SCRATCH.test(file)) return null;
  return { project, area, id, video: /\.(mp4|mov|webm|m4v)$/i.test(file) };
}

/**
 * Start watching. `onChange({project, area, id, video})` is called for each change worth a line. Returns { close() }.
 * Recursive watching works on Windows and macOS, and on Linux with a recent Node; where it does not, nothing is watched and nothing breaks.
 */
export function watchMedia(roots, onChange, { watchFn = watch, statFn = statSync, now = Date.now } = {}) {
  const watchers = [];
  for (const root of roots) {
    try {
      const w = watchFn(root, { recursive: true, persistent: false }, (_type, name) => {
        if (!name) return;
        const c = mediaChange(String(name).split(sep).join('/'));
        if (!c) return;
        try {
          if (writtenJustNow(statFn(join(root, String(name))), now())) onChange(c);
        } catch { /* already gone, or a bad line: neither may stop the watcher */ }
      });
      w.on('error', () => { try { w.close(); } catch { /* gone */ } });
      watchers.push(w);
    } catch { /* this computer cannot watch folders this way */ }
  }
  return { close() { for (const w of watchers) { try { w.close(); } catch { /* gone */ } } } };
}
