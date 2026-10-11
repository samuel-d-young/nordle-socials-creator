// The cover frame chosen for a reel: seconds into the video, kept per calendar item in <project>/publish/covers.json (auto: true when
// Nordle picked it rather than the owner). It is a publishing choice, so it lives beside the audit log and not in the post's document
// (changing a cover does not change the post, so a sign-off stays good). The Buffer adapter sends it as the video's thumbnail offset.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const file = (projectDir) => join(projectDir, 'publish', 'covers.json');

function read(projectDir) {
  try { const j = JSON.parse(readFileSync(file(projectDir), 'utf8')); return j && typeof j === 'object' && j.covers && typeof j.covers === 'object' ? j : { covers: {} }; } catch { return { covers: {} }; }
}

/** { at, set, auto? } for an item, or null when no cover was chosen. */
export function getCover(projectDir, itemId) {
  const c = read(projectDir).covers[itemId];
  return c && Number.isFinite(c.at) ? c : null;
}

/** The chosen cover time in seconds, or null when none was chosen. */
export const getCoverTime = (projectDir, itemId) => getCover(projectDir, itemId)?.at ?? null;

/** Remember a cover time (seconds, 0 or more). `auto` says Nordle picked it. */
export function setCoverTime(projectDir, itemId, seconds, { auto = false } = {}) {
  const t = Math.round(Number(seconds) * 1000) / 1000;
  if (!Number.isFinite(t) || t < 0 || t > 36000) throw new RangeError('The cover time must be a number of seconds from the start of the video.');
  const j = read(projectDir);
  j.covers[itemId] = { at: t, set: new Date().toISOString(), ...(auto ? { auto: true } : {}) };
  mkdirSync(join(projectDir, 'publish'), { recursive: true });
  const tmp = `${file(projectDir)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ schema: 'nordle.covers/0.1', covers: j.covers }, null, 2)}\n`);
  renameSync(tmp, file(projectDir));
  return t;
}

export const hasCovers = (projectDir) => existsSync(file(projectDir));
