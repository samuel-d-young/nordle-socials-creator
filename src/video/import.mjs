// Videos you already have, brought into Nordle to edit: the files stay where they are (a "mount" points at their folder, see mounts.mjs), each becomes a video
// post with its footage on the timeline (picture and sound), on the calendar as a built post waiting for you, ready to open in the video editor.
// Nothing is copied or changed on disk apart from the project's own nordle.local.json (which folders the project may read), its docs/ and its calendar.

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { buildReelDoc } from '../shared/reel-spec.mjs';
import { addItems, linkDoc, loadProject } from '../calendar/service.mjs';
import { addDays, weekday } from '../calendar/dates.mjs';
import { MOUNT_FILE, loadMounts, safeRest } from './mounts.mjs';
import { probeFor } from './render.mjs';

export const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi', '.mts', '.m2ts', '.mxf', '.mpg', '.mpeg']);
export const MAX_FILES = 12;
export const MAX_CLIP_SECONDS = 180;
export class ImportError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }

const slug = (s) => String(s).normalize('NFKD').replace(/[^\w\s-]/g, '').trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'video';
const pretty = (file) => basename(file, extname(file)).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^./, (c) => c.toUpperCase()).slice(0, 80) || 'Video';
const formatOf = (sizeId) => (/story/.test(sizeId) ? 'story' : /reel|tiktok|shorts/.test(sizeId) ? 'reel' : 'post');

function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** The mount that already covers this folder, or a new one for it. Returns { name, rest } for the file. */
function mountFor(projectDir, file, mounts) {
  const abs = resolve(file);
  const folder = dirname(abs);
  for (const [name, root] of Object.entries(mounts)) {
    if (folder === root || folder.startsWith(root.endsWith(sep) ? root : root + sep)) {
      const rest = abs.slice(root.length).replace(/^[\\/]+/, '').split(sep).join('/');
      if (safeRest(rest)) return { name, rest, added: false };
    }
  }
  let name = 'footage';
  for (let n = 2; mounts[name]; n++) name = `footage-${n}`;
  mounts[name] = folder;
  return { name, rest: basename(abs), added: true };
}

function saveMounts(projectDir, mounts) {
  const file = join(projectDir, MOUNT_FILE);
  let data = {};
  try { data = JSON.parse(readFileSync(file, 'utf8')); } catch { /* none yet */ }
  writeAtomic(file, `${JSON.stringify({ ...data, mounts: { ...(data.mounts ?? {}), ...mounts } }, null, 2)}\n`);
}

/**
 * @param {string} projectDir
 * @param {string[]} files   absolute paths of video files on this computer
 * @param {{ size?: string, mode?: 'each'|'together', today?: string, brand: object, platforms: object }} o
 */
export async function importVideos(projectDir, files, { size = 'ig-reel-9x16', mode = 'each', today, brand, platforms } = {}) {
  const list = [...new Set((files ?? []).map((f) => String(f ?? '').trim()).filter(Boolean))];
  if (!list.length) throw new ImportError('Choose at least one video.');
  if (list.length > MAX_FILES) throw new ImportError(`Up to ${MAX_FILES} videos at a time.`);
  for (const f of list) {
    if (!isAbsolute(f)) throw new ImportError(`"${f}" is not a full path to a file.`);
    if (!VIDEO_EXT.has(extname(f).toLowerCase())) throw new ImportError(`"${basename(f)}" is not a video file Nordle can read (${[...VIDEO_EXT].join(', ')}).`);
    if (!existsSync(f) || !statSync(f).isFile()) throw new ImportError(`There is no file at ${f}.`, 404);
  }
  const preset = platforms.presets.find((p) => p.id === size && p.kinds?.includes('video'));
  if (!preset) throw new ImportError(`"${size}" is not a video size.`);

  const mounts = { ...loadMounts(projectDir) };
  const refs = list.map((f) => { const m = mountFor(projectDir, f, mounts); return { file: f, ...m, ref: `mount:${m.name}/${m.rest}` }; });
  // the folders are written down first (a probe finds a file through its mount), then every file is looked at
  const fresh = refs.filter((r) => r.added);
  if (fresh.length) saveMounts(projectDir, Object.fromEntries(fresh.map((r) => [r.name, mounts[r.name]])));
  const probes = [];
  for (const r of refs) {
    const p = await probeFor(projectDir, r.ref).catch((e) => { throw new ImportError(`"${basename(r.file)}" could not be read: ${e.message}`); });
    if (!p.video) throw new ImportError(`"${basename(r.file)}" has no picture in it.`);
    probes.push(p);
  }

  const taken = (id) => existsSync(join(projectDir, 'docs', `${id}.json`));
  const uniqueId = (base) => { let id = base; for (let n = 2; taken(id); n++) id = `${base.slice(0, 54)}-${n}`; return id; };
  const groups = mode === 'together' ? [refs.map((r, i) => ({ r, p: probes[i] }))] : refs.map((r, i) => [{ r, p: probes[i] }]);
  const out = [];
  const p0 = loadProject(projectDir);
  let day = today ?? p0.today;
  const occupied = new Set((p0.cal.items ?? []).map((i) => i.date));
  const nextDay = () => { do { day = addDays(day, 1); } while (weekday(day) === 0 || weekday(day) === 6 || occupied.has(day)); occupied.add(day); return day; };

  for (const g of groups) {
    const title = g.length > 1 ? `${pretty(g[0].r.file)} and ${g.length - 1} more` : pretty(g[0].r.file);
    const id = uniqueId(`${slug(pretty(g[0].r.file))}${g.length > 1 ? '-joined' : ''}`);
    const sources = Object.fromEntries(g.map((x, i) => [`v${i + 1}`, { path: x.r.ref }]));
    const spec = {
      id, title, sizes: [size], sources,
      scenes: g.map((x, i) => ({ type: 'clip', source: `v${i + 1}`, in: 0, dur: Math.round(Math.min(x.p.duration, MAX_CLIP_SECONDS) * 100) / 100, audio: true })),
    };
    const built = buildReelDoc(spec, { brand, platforms });
    writeAtomic(join(projectDir, 'docs', `${built.doc.id}.json`), `${JSON.stringify(built.doc, null, 2)}\n`);
    const date = nextDay();
    const added = await addItems(projectDir, [{ date, format: formatOf(size), title, idea: 'A video you already had, brought in to edit in Nordle.', hook: title, status: 'approved' }], { role: 'human', today: today ?? p0.today, delegated: false });
    const item = added.added[0];
    if (item) await linkDoc(projectDir, item.id, built.doc.id, { role: 'human' });
    out.push({ docId: built.doc.id, itemId: item?.id ?? null, title, seconds: Math.round(g.reduce((t, x) => t + Math.min(x.p.duration, MAX_CLIP_SECONDS), 0) * 10) / 10, files: g.map((x) => basename(x.r.file)), notes: built.notes ?? [], date });
  }
  return { posts: out, mounts: Object.fromEntries(refs.filter((r) => r.added).map((r) => [r.name, mounts[r.name]])) };
}
