// The export-folder adapter. It always works and nothing leaves the computer: for each post it writes
//   <project>/out/publish/<date>-<doc id>/   the pictures in order (01-cover.png, 02-...) or the video and its cover,
//                                            caption.txt (caption + hashtags), alt.txt
//   <post folder>/<channel id>/              only when the brand has channels set up: that channel's own caption.txt (hashtags
//                                            stripped where the channel says so) and channel.txt (name, service, when). The
//                                            pictures are not copied again: they are shared by every channel of the post.
// and, for the whole selection, one <project>/out/publish/schedule-<plan>.csv with a row per post per channel (when each goes out,
// in the brand's timezone and in UTC), so a person can upload by hand into whatever tool they use. It does not mark calendar
// items scheduled: nothing was handed to a service, so the owner marks them posted themselves.
//
// The same folder is what the Buffer adapter points Buffer at (Buffer reads pictures from public web addresses, so the folder is
// what you host), which is why the naming below is deterministic.

import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';

const safe = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'page';
const pad2 = (n) => String(n).padStart(2, '0');

/** The folder (inside <project>/out/publish) one post is exported to. */
export const bundleFolderName = (post) => `${post.date ?? 'undated'}-${post.docId}`;

/** The sub-folder name of one channel inside a post's folder. */
export const channelFolderName = (channel) => safe(channel?.id);

/** The name a media file gets inside its folder. `index` counts the pictures in order from 0. */
export function bundleFileName(media, index, docId) {
  const ext = extname(media.rel).toLowerCase() || (media.kind === 'video' ? '.mp4' : '.png');
  if (media.kind === 'video') return `${docId}${ext}`;
  if (media.kind === 'cover') return `${docId}-cover${ext}`;
  return `${pad2(index + 1)}-${safe(media.page)}${ext}`;
}

export const bundleRoot = (projectDir) => join(projectDir, 'out', 'publish');

const inside = (root, dir) => { const rel = relative(resolve(root), resolve(dir)); return !!rel && !rel.startsWith('..') && !isAbsolute(rel); };

export function altText(post) {
  const lines = post.media.filter((m) => m.kind === 'image' || m.kind === 'video').map((m) => ({ file: m.file, alt: String(m.alt ?? '').trim() })).filter((x) => x.alt);
  if (!lines.length) return 'No alt text has been written for this post.\n';
  return `Alt text, one per picture in posting order\n\n${lines.map((x) => `${x.file}\n${x.alt}`).join('\n\n')}\n`;
}

/** Copy a file unless an up-to-date copy is already there (a post with several channels exports its pictures once). */
function copyUnlessCurrent(src, dest) {
  try { if (existsSync(dest) && statSync(dest).size === statSync(src).size && statSync(dest).mtimeMs >= statSync(src).mtimeMs) return; } catch { /* copy it */ }
  copyFileSync(src, dest);
}

/**
 * Write one post's folder and return where it went. wipe (the first time a post is exported in a run) replaces the whole folder, so a
 * page removed from the post does not linger; without it only what is missing or newer is written (the next channel of the same post).
 */
export function exportBundle(post, { wipe = true } = {}) {
  const root = bundleRoot(post.projectDir);
  const dir = join(root, bundleFolderName(post));
  if (!inside(root, dir)) throw new Error('The export folder would be outside the project.');
  if (wipe && post.variant !== 'story') rmSync(dir, { recursive: true, force: true });   // (a Story never wipes: the post's own files may be waiting to be read)
  mkdirSync(dir, { recursive: true });
  for (const m of post.media) copyUnlessCurrent(m.abs, join(dir, m.file));
  // a Story of a post reuses the post's own pictures and has no words: it leaves the post's caption and alt files as they are
  if (post.variant === 'story') return { dir, rel: `out/publish/${bundleFolderName(post)}`, channelRel: null, files: post.media.map((m) => m.file) };
  writeFileSync(join(dir, 'caption.txt'), `${post.captionFull ?? post.caption}\n`);
  writeFileSync(join(dir, 'alt.txt'), altText(post));
  const rel = `out/publish/${bundleFolderName(post)}`;
  const files = [...post.media.map((m) => m.file), 'caption.txt', 'alt.txt'];
  let channelRel = null;
  if (post.channel?.id) {
    const sub = join(dir, channelFolderName(post.channel));
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, 'caption.txt'), `${post.caption}\n`);
    const heading = `${post.channel.name ?? post.channel.id}${post.channel.service ? ` (${post.channel.service})` : ''}`;
    writeFileSync(join(sub, 'channel.txt'), `${[heading, '', `Post at: ${post.whenLocal ?? post.when ?? 'not set'}`, `Pictures and alt text: the files one folder up (${rel})`].join('\n')}\n`);
    channelRel = `${rel}/${channelFolderName(post.channel)}`;
    files.push(`${channelFolderName(post.channel)}/caption.txt`, `${channelFolderName(post.channel)}/channel.txt`);
  }
  return { dir, rel, channelRel, files };
}

const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;          // a spreadsheet must never run a caption as a formula
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const CSV_COLUMNS = ['date', 'time', 'timezone', 'when_utc', 'format', 'title', 'doc', 'folder', 'files', 'caption_start', 'channel', 'channel_name', 'service'];

/** A time as the brand's own clock: { date: '2026-11-12', time: '18:30' }. */
export function localParts(iso, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(iso));
    const g = (t) => parts.find((p) => p.type === t).value;
    return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${g('hour')}:${g('minute')}` };
  } catch { return { date: '', time: '' }; }
}

/** One row per post per channel. */
export function scheduleCsv(posts) {
  const rows = posts.map((p) => {
    const local = p.when ? localParts(p.when, p.timezone) : { date: p.date ?? '', time: p.time ?? '' };
    return [local.date, local.time, p.timezone ?? '', p.when ?? '', p.format, p.title, p.docId, `out/publish/${bundleFolderName(p)}`, p.media.map((m) => m.file).join(' | '), String(p.caption).replace(/\s+/g, ' ').slice(0, 90), p.channel?.id ?? '', p.channel?.name ?? '', p.channel?.service ?? ''];
  });
  return `﻿${[CSV_COLUMNS, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

export function createBundleAdapter() {
  return {
    id: 'bundle',
    name: 'Export folder',
    marksScheduled: false,
    describe() {
      return { configured: true, needs: [], channels: [], note: 'Always available and nothing leaves this computer. Writes each post to <project>/out/publish/<date>-<doc id>/ (pictures in order or the video and its cover, caption.txt, alt.txt), one sub-folder per channel when the brand has channels set up (each with its own caption), and a schedule.csv with a row per post and channel, to upload by hand into any scheduling tool.' };
    },
    async listChannels() { return []; },
    async plan() { return { blockers: [], warnings: [] }; },
    async schedule(post, { when } = {}, _settings, ctx = {}) {
      const out = exportBundle(post, { wipe: ctx.firstOfPost !== false });
      const where = out.channelRel ?? out.rel;
      return { remoteId: where, scheduledAt: when ?? post.when ?? null, message: `Exported to ${where} (${post.media.length} file${post.media.length === 1 ? '' : 's'} + caption and alt text).` };
    },
    /** After the whole run: one schedule.csv per project, listing every post and channel that was exported. */
    async finalize(batch, { planId = 'run' } = {}) {
      const byProject = new Map();
      for (const { post, result } of batch) {
        if (!result?.ok) continue;
        (byProject.get(post.projectDir) ?? byProject.set(post.projectDir, []).get(post.projectDir)).push(post);
      }
      const files = [];
      for (const [projectDir, posts] of byProject) {
        const file = join(bundleRoot(projectDir), `schedule-${String(planId).replace(/^pl_/, '').slice(0, 8)}.csv`);
        mkdirSync(bundleRoot(projectDir), { recursive: true });
        writeFileSync(file, scheduleCsv(posts));
        files.push(file);
      }
      return { files };
    },
    async check() { return { ok: true, message: 'The export folder needs nothing to connect.' }; },
  };
}
