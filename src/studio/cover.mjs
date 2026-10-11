// Choosing the cover of a reel from the Studio: a time in the video. The cover picture the Studio shows is taken from the finished video
// at that time (no re-render), and the time is kept for publishing (src/publish/covers.mjs), where Buffer is told which frame to use.
// The owner can pick a frame, take one of the best few that Nordle suggests (src/video/cover-pick.mjs), or leave it: with nothing chosen
// the best one is picked automatically when the post is scheduled (ensureCover). Choosing is owner only (the route enforces it).

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { frameFromVideo } from '../video/render.mjs';
import { coverCandidates } from '../video/cover-pick.mjs';
import { getCover, setCoverTime } from '../publish/covers.mjs';
import { StudioError } from './actions.mjs';
import { detail, forget, locate } from './data.mjs';

/** The finished video of a post and the cover picture that sits beside it, both inside the project. */
function filesOf(store, uid) {
  const at = locate(store, String(uid ?? ''));
  if (!at) throw new StudioError(404, 'No such post.');
  const { project, item } = at;
  if (!item) throw new StudioError(409, 'Only a post on the calendar can have its cover chosen here.');
  const d = detail(store, String(uid));
  const videoRel = d?.media?.video ?? null;
  if (!videoRel) throw new StudioError(409, 'This post has no video to take a cover from.');
  const videoAbs = join(project.dir, videoRel);
  if (!existsSync(videoAbs) || !statSync(videoAbs).isFile()) throw new StudioError(409, 'The video file is missing: render the post first.');
  const coverRel = d.media.poster ?? (item.external?.cover ?? videoRel.replace(/\.[a-z0-9]+$/i, '-cover.jpg'));
  if (!/\.(jpg|png)$/.test(coverRel)) throw new StudioError(409, 'The cover picture is not a JPG or PNG, so it cannot be replaced from here.');
  return { project, item, videoAbs, coverRel, coverAbs: join(project.dir, coverRel), media: d.media };
}

/** Take the frame at `time`, write it as the cover picture and keep the time for publishing. */
async function apply(f, time, { auto = false } = {}) {
  await frameFromVideo(f.videoAbs, time, f.coverAbs);
  const saved = setCoverTime(f.project.dir, f.item.id, time, { auto });
  forget(join(f.project.dir, 'calendar.json'));
  return { time: saved, cover: f.coverRel, auto };
}

/** The owner chose a moment ({time}), or asked for the best one ({auto: true}). */
export async function setCover(store, { uid, time, auto } = {}) {
  const f = filesOf(store, uid);
  if (auto) {
    const [best] = await coverCandidates(f.videoAbs, { count: 1 });
    return apply(f, best?.time ?? 0, { auto: true });
  }
  const t = Number(time);
  if (!Number.isFinite(t) || t < 0) throw new StudioError(400, 'Say which moment of the video: {"time": seconds}, or {"auto": true}.');
  return apply(f, t);
}

/** The best few frames, best first, each as a small JPEG to look at. Reads only: the cover is not changed. */
export async function candidatesFor(store, { uid, count = 6 } = {}) {
  const f = filesOf(store, uid);
  const list = await coverCandidates(f.videoAbs, { count: Math.max(1, Math.min(8, Number(count) || 6)) });
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'nordle-covers-'));
  try {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const file = join(dir, `c${i}.jpg`);
      await frameFromVideo(f.videoAbs, list[i].time, file, { width: 270, height: 480 });
      out.push({ ...list[i], image: `data:image/jpeg;base64,${readFileSync(file).toString('base64')}` });
    }
    const now = getCover(f.project.dir, f.item.id);
    return { current: now ? { time: now.at, auto: !!now.auto } : null, candidates: out };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/**
 * Before a reel is handed to a publishing service: when nobody (and no designer) chose a cover, take the best frame now, so the service is
 * never left to use the first frame. `post` is a planned post (project dir, calendar item, absolute media paths). Returns the cover time.
 */
export async function ensureCover(post) {
  const video = post.media?.find((m) => m.kind === 'video');
  if (!video?.abs || !post.itemId) return null;
  const [best] = await coverCandidates(video.abs, { count: 1 });
  const time = best?.time ?? 0;
  const rel = (post.media.find((m) => m.kind === 'cover')?.abs) ?? null;
  if (rel && /\.(jpg|png)$/.test(rel)) { try { await frameFromVideo(video.abs, time, rel); } catch { /* the choice still stands: Buffer is told the time */ } }
  return setCoverTime(post.projectDir, post.itemId, time, { auto: true });
}
