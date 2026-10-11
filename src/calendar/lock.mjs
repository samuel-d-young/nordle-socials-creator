// Two kinds of lock for a project's calendar:
//  - withFileLock: a short lock around read-change-write of calendar.json, so the server, the CLI and the runner never
//    overwrite each other's change.
//  - the run lock (.calendar-run.lock): held for as long as the runner has Claude building something, so only one build
//    runs at a time per project, whichever scheduler or terminal started it.
// Both are plain files created with the "fail if it exists" flag; a lock whose owner has died or that is far too old is stale
// and is taken over.

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Run fn while holding a lock file. Waits up to waitMs for another holder; takes over a lock older than staleMs. */
export async function withFileLock(file, fn, { waitMs = 10000, staleMs = 30000 } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let age = 0;
      try { age = Date.now() - statSync(file).mtimeMs; } catch { continue; }
      if (age > staleMs) { try { unlinkSync(file); } catch { /* somebody else took it over */ } continue; }
      if (Date.now() - started > waitMs) throw new Error(`The calendar is busy (another change has held ${file} for ${Math.round(age / 1000)}s). Try again.`);
      await sleep(25);
    }
  }
  try { return await fn(); } finally { try { unlinkSync(file); } catch { /* already gone */ } }
}

export const runLockPath = (projectDir) => join(projectDir, '.calendar-run.lock');

/**
 * The run lock's holder, or null when nobody holds it (no file, the process is gone, or the lock is older than staleMs).
 * { pid, started, item, mode, stale:false }
 */
export function readRunLock(projectDir, { staleMs = 45 * 60 * 1000, now = Date.now() } = {}) {
  const file = runLockPath(projectDir);
  if (!existsSync(file)) return null;
  let info;
  try { info = JSON.parse(readFileSync(file, 'utf8')); } catch { info = {}; }
  const age = now - (Date.parse(info.started) || statSync(file).mtimeMs);
  if (!pidAlive(info.pid) || age > staleMs) return null;
  return info;
}

/** Take the run lock. Returns { ok:true, release() } or { ok:false, holder }. A stale lock is removed first. */
export function acquireRunLock(projectDir, info, { staleMs = 45 * 60 * 1000 } = {}) {
  const file = runLockPath(projectDir);
  const mine = { pid: process.pid, started: new Date().toISOString(), ...info };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, JSON.stringify(mine), { flag: 'wx' });
      return {
        ok: true,
        /** Say what the run is doing now (shown in the Studio as "Claude is building ..."). */
        update(patch) { Object.assign(mine, patch); try { writeFileSync(file, JSON.stringify(mine)); } catch { /* the lock was removed under us */ } },
        release() { try { unlinkSync(file); } catch { /* already gone */ } },
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const holder = readRunLock(projectDir, { staleMs });
      if (holder) return { ok: false, holder };
      try { unlinkSync(file); } catch { /* raced with another cleaner */ }
    }
  }
  return { ok: false, holder: readRunLock(projectDir, { staleMs }) ?? {} };
}
