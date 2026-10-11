// A folder on this computer as a stock library: the owner's own stock (files bought or downloaded from any site, such as Envato Elements,
// which has no download API) kept in one place. Searching reads file and folder names; "downloading" copies the file into the project.
// Reads only inside the chosen folder: ids are paths relative to it, and anything that would leave it is refused.

import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { StockError } from './net.mjs';

const EXT = {
  photo: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
  video: ['mp4', 'mov', 'webm', 'm4v'],
  music: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'],
  sfx: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'],
};
const MAX_FILES = 20000, MAX_DEPTH = 8;

function walk(base, kind) {
  const exts = new Set(EXT[kind]);
  const out = [];
  const visit = (dir, depth) => {
    if (out.length >= MAX_FILES || depth > MAX_DEPTH) return;
    let names;
    try { names = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      if (e.name.startsWith('.')) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) visit(full, depth + 1);
      else if (e.isFile() && exts.has(extname(e.name).slice(1).toLowerCase())) out.push(full);
      if (out.length >= MAX_FILES) return;
    }
  };
  visit(base, 0);
  return out;
}

/** The absolute file for an id (a path relative to the folder), or throws. */
export function resolveInFolder(folder, id) {
  const rel = String(id ?? '');
  if (!rel || rel.includes('\0') || rel.includes('\\') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.split('/').includes('..')) throw new StockError(400, 'That is not a file inside the library folder.');
  const base = realpathSync(resolve(folder));
  const abs = resolve(base, rel);
  if (abs !== base && !abs.startsWith(base.endsWith(sep) ? base : base + sep)) throw new StockError(400, 'That file is outside the library folder.');
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new StockError(404, `There is no file "${rel}" in that library.`);
  const real = realpathSync(abs);
  if (real !== base && !real.startsWith(base.endsWith(sep) ? base : base + sep)) throw new StockError(400, 'That file is outside the library folder.');
  return real;
}

/** @param {{id:string, name:string, path:string, kinds?:string[], license?:string}} entry */
export function folderLibrary({ id, name, path, kinds, license }) {
  if (!isAbsolute(String(path ?? ''))) throw new StockError(400, 'A folder library needs the full path of its folder.');
  const have = (kinds?.length ? kinds : Object.keys(EXT));
  const note = license || 'Your own library: the licence is whatever you bought or were given with each file.';
  return {
    id, name: name || basename(path), kinds: have, type: 'folder', license: note, licenseUrl: null, note: path,
    canLookup: () => true,
    async search({ query, kind, page = 1, perPage = 15 }) {
      if (!existsSync(path)) throw new StockError(404, `The folder ${path} is not there (is the drive connected?).`);
      const base = realpathSync(resolve(path));
      const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      const hits = walk(base, kind)
        .map((f) => ({ f, rel: relative(base, f).split(sep).join('/') }))
        .filter(({ rel }) => words.every((w) => rel.toLowerCase().includes(w)))
        .sort((a, b) => a.rel.localeCompare(b.rel));
      const items = hits.slice((page - 1) * perPage, page * perPage).map(({ rel }) => ({
        id: rel, kind, library: id, title: basename(rel, extname(rel)).replace(/[_-]+/g, ' '), author: null, page: null, thumb: null, preview: null, width: null, height: null, duration: null,
        tags: rel.split('/').slice(0, -1).map((s) => s.toLowerCase()).slice(-4), license: note, licenseUrl: null,
      }));
      return { items, total: hits.length, page };
    },
    async lookup(kind, rel) {
      const file = resolveInFolder(path, rel);
      return { raw: { file }, item: { id: rel, kind, library: id, title: basename(rel, extname(rel)).replace(/[_-]+/g, ' '), author: null, page: null, thumb: null, preview: null, width: null, height: null, duration: null, tags: [], license: note, licenseUrl: null } };
    },
    async download(kind, raw) { return { file: raw.file }; },
  };
}
