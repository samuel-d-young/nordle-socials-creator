// Removing posts and brands without ever deleting them. A removed post's files go to <project>/trash/<time>-<id>/ (with a meta.json
// that holds its calendar item); a removed brand's whole folder goes to <projects root>/.trash/<id>-<time>/ (with a sibling meta
// file). Both can be restored from the Studio's Trash page. Owner only (the route enforces it).

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { CalendarError, removeItem, restoreItem } from '../calendar/service.mjs';
import { readRunLock } from '../calendar/lock.mjs';
import { forget, locate, parseUid, readJsonCached, extReviewId } from './data.mjs';
import { calendarPath } from '../calendar/model.mjs';

export class TrashError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

/** Move a file or folder; if the platform will not rename it (it is open somewhere), copy it and remove the original. */
function move(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  try { renameSync(from, to); } catch (e) {
    if (!['EXDEV', 'EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
    cpSync(from, to, { recursive: true });
    try { rmSync(from, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { throw new TrashError(409, 'Something still has these files open (a video playing, or another program). Close it and try again.'); }
  }
}

/** The project files that belong to one post, as paths relative to the project folder. */
function filesOf(project, { item, docId }) {
  const rels = [];
  if (docId) {
    rels.push(`docs/${docId}.json`, `out/${docId}`, `checks/${docId}.json`, `review/${docId}.json`, `review/versions/${docId}`, `history/${docId}.jsonl`);
  }
  if (item) {
    rels.push(`external/${item.id}`, `review/${extReviewId(item.id)}.json`);
  }
  return rels.filter((r) => existsSync(join(project.dir, r)));
}

// ---- posts ----------------------------------------------------------------------------------------------------------------------

/** @returns {Promise<{removed:{uid:string,id:string,title:string}[], failed:{uid:string,reason:string}[]}>} */
export async function removePosts(store, uids) {
  const removed = [], failed = [];
  for (const uid of uids) {
    try { removed.push(await removeOne(store, uid)); } catch (e) {
      if (e instanceof TrashError || e instanceof CalendarError) failed.push({ uid, reason: e.message }); else throw e;
    }
  }
  return { removed, failed };
}

async function removeOne(store, uid) {
  const at = locate(store, uid);
  if (!at) throw new TrashError(404, 'No such post.');
  const { project, item, docId } = at;
  if (item?.status === 'scheduled') throw new TrashError(409, `“${item.title}” is scheduled${item.publish?.adapter ? ` in ${item.publish.adapter}` : ''}. Take it out of the schedule there first, so nothing goes out that you cannot see.`);
  const title = item?.title ?? (docId && project.doc(docId)?.doc?.title) ?? uid;
  const folder = `${stamp()}-${(item?.id ?? docId).slice(0, 60)}`;
  const dest = join(project.dir, 'trash', folder);
  const rels = filesOf(project, at);
  const moved = [];
  try {
    for (const rel of rels) { move(join(project.dir, rel), join(dest, rel)); moved.push(rel); }
    mkdirSync(dest, { recursive: true });
    const doc = docId ? project.doc(docId)?.doc : null;
    writeFileSync(join(dest, 'meta.json'), `${JSON.stringify({
      schema: 'nordle.trash/0.1', kind: 'post', project: project.id, uid, itemId: item?.id ?? null, docId: docId ?? null, title,
      format: item?.format ?? (doc?.kind === 'video' ? 'reel' : 'carousel'), date: item?.date ?? null, status: item?.status ?? null,
      removedAt: new Date().toISOString(), files: moved, item: item ?? null,
    }, null, 2)}\n`);
    if (docId) { project.docs.delete(docId); project.reviews.delete(docId); }
    if (item) await removeItem(project.dir, item.id, { role: 'human' });
  } catch (e) {
    for (const rel of moved.reverse()) { try { move(join(dest, rel), join(project.dir, rel)); } catch { /* best effort */ } }
    try { rmSync(dest, { recursive: true, force: true }); } catch { /* best effort */ }
    throw e instanceof CalendarError ? e : e instanceof TrashError ? e : new TrashError(409, `Could not move it to the trash: ${e.message}`);
  } finally { forget(calendarPath(project.dir)); }
  return { uid, id: `post:${project.id}:${folder}`, title };
}

export async function restorePost(store, id) {
  const m = /^post:([a-z0-9][a-z0-9_-]*):([^/\\]+)$/.exec(String(id));
  const project = m && store.project(m[1]);
  if (!project) throw new TrashError(404, 'That is not in the trash any more.');
  const dir = join(project.dir, 'trash', m[2]);
  const meta = readJson(join(dir, 'meta.json'));
  if (!meta || meta.kind !== 'post') throw new TrashError(404, 'That is not in the trash any more.');
  for (const rel of meta.files) if (existsSync(join(project.dir, rel))) throw new TrashError(409, `Something is already at ${rel}. Restoring would overwrite it.`);
  if (meta.item && readJsonCached(calendarPath(project.dir))?.items?.some((i) => i.id === meta.item.id)) throw new TrashError(409, 'The calendar already has a post with that id.');
  const back = [];
  try {
    for (const rel of meta.files) { move(join(dir, rel), join(project.dir, rel)); back.push(rel); }
    if (meta.item) await restoreItem(project.dir, meta.item, { role: 'human' });
  } catch (e) {
    for (const rel of back.reverse()) { try { move(join(project.dir, rel), join(dir, rel)); } catch { /* best effort */ } }
    throw e instanceof CalendarError || e instanceof TrashError ? e : new TrashError(409, e.message);
  } finally { forget(calendarPath(project.dir)); }
  rmSync(dir, { recursive: true, force: true });
  return { uid: meta.uid, title: meta.title };
}

// ---- brands ---------------------------------------------------------------------------------------------------------------------

export function removeBrand(store, { project: id, confirm }) {
  const project = store.project(String(id ?? ''));
  if (!project) throw new TrashError(404, 'No such brand.');
  const name = (readJson(join(project.dir, 'brand.json'))?.name ?? project.id).trim();
  if (String(confirm ?? '').trim().toLowerCase() !== name.toLowerCase()) throw new TrashError(400, `Type the brand name exactly (“${name}”) to confirm.`);
  const open = [...project.docs.values()].some((s) => s.listenerCount('change') > 0) || [...project.reviews.values()].some((r) => r.listenerCount('change') > 0);
  if (open) throw new TrashError(409, 'A post of this brand is open in the editor. Close it first (or close that browser tab), then try again.');
  if (readRunLock(project.dir)) throw new TrashError(409, 'A build is running for this brand right now. Wait for it to finish.');
  const root = dirname(project.dir);
  const folder = `${project.id}-${stamp()}`;
  try { move(project.dir, join(root, '.trash', folder)); } catch (e) {
    throw e instanceof TrashError ? e : new TrashError(409, `Could not move the brand to the trash: ${e.message}`);
  }
  writeFileSync(join(root, '.trash', `${folder}.meta.json`), `${JSON.stringify({ schema: 'nordle.trash/0.1', kind: 'brand', id: project.id, name, folder, removedAt: new Date().toISOString() }, null, 2)}\n`);
  store.projects.delete(project.id);
  store.scan();
  return { id: `brand:${folder}`, name };
}

export function restoreBrand(store, id) {
  const m = /^brand:([a-z0-9][A-Za-z0-9_.-]*)$/.exec(String(id));
  if (!m) throw new TrashError(404, 'That is not in the trash any more.');
  for (const root of store.roots) {
    const metaFile = join(root, '.trash', `${m[1]}.meta.json`);
    const meta = readJson(metaFile);
    if (!meta || meta.kind !== 'brand' || !existsSync(join(root, '.trash', m[1]))) continue;
    const target = join(root, meta.id);
    if (existsSync(target)) throw new TrashError(409, `There is already a project “${meta.id}”. Remove or rename it first.`);
    move(join(root, '.trash', m[1]), target);
    rmSync(metaFile, { force: true });
    store.scan();
    return { id: meta.id, name: meta.name };
  }
  throw new TrashError(404, 'That is not in the trash any more.');
}

// ---- looking in the trash -----------------------------------------------------------------------------------------------------

const entries = (dir) => { try { return readdirSync(dir); } catch { return []; } };

export function listTrash(store) {
  const posts = [], brands = [];
  for (const project of store.scan()) {
    const base = join(project.dir, 'trash');
    for (const folder of entries(base)) {
      const dir = join(base, folder);
      try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
      const meta = readJson(join(dir, 'meta.json'));
      if (meta?.kind === 'post') posts.push({ id: `post:${project.id}:${folder}`, project: project.id, uid: meta.uid, title: meta.title, format: meta.format, date: meta.date, status: meta.status, removedAt: meta.removedAt, files: meta.files.length });
    }
  }
  for (const root of store.roots) {
    for (const f of entries(join(root, '.trash'))) {
      if (!f.endsWith('.meta.json')) continue;
      const meta = readJson(join(root, '.trash', f));
      if (meta?.kind === 'brand' && existsSync(join(root, '.trash', meta.folder))) brands.push({ id: `brand:${meta.folder}`, name: meta.name, project: meta.id, removedAt: meta.removedAt });
    }
  }
  posts.sort((a, b) => b.removedAt.localeCompare(a.removedAt));
  brands.sort((a, b) => b.removedAt.localeCompare(a.removedAt));
  return { posts, brands };
}

/** How many things are in the trash (for the badge). */
export function trashCount(store) {
  const t = listTrash(store);
  return t.posts.length + t.brands.length;
}
export { basename, parseUid };
