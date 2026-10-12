// Stock libraries: a way to search photos, video, music and sound effects in outside libraries and bring the ones you choose into a project,
// with their licence written down. See docs/STOCK.md. Three kinds of library plug in:
//   * REST libraries described as data (presets.mjs, or the owner's own definition): no code, any JSON web API;
//   * folder libraries: a folder of the owner's own stock on this computer (for sites with no download API, such as Envato Elements);
//   * code libraries: a file in src/stock/libraries/*.mjs that default-exports { id, name, kinds, search(), lookup(), download() } (for an API
//     that needs more than data can say, such as a login flow).
// The rules, in code and not only in the UI:
//   * the owner adds, changes and removes libraries and keys (owner token / the command line on their own machine); Claude may search and bring
//     files into a project, because that is a designer's job, and the owner's key does the searching;
//   * a key is kept in .nordle/stock.json (0600) and is never in a result, an error or a log;
//   * every address a library gives back is checked (net.mjs): https, public hosts only, size caps, the right kind of file;
//   * Nordle never buys anything: a file that needs a purchase or a login simply cannot be downloaded;
//   * every file brought in lands under <project>/assets/stock/, with a line in assets/stock/licences.json (who, where from, licence, when,
//     by whom) and a catalog entry that says it has NOT been looked at yet: the designer must look and describe it before using it.

import { existsSync, mkdirSync, readFileSync, readdirSync, copyFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { KINDS, StockError, downloadTo } from './net.mjs';
import { PRESETS } from './presets.mjs';
import { definitionProblems, restLibrary } from './rest.mjs';
import { folderLibrary } from './folder.mjs';
import { pictures } from './pictures.mjs';
import { changeStock, loadStock } from './store.mjs';

export { KINDS, StockError };

// ---- code libraries (drop a file in src/stock/libraries/) ------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const CODE = new Map();
{
  const dir = join(here, 'libraries');
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.mjs') && !x.startsWith('_')).sort()) {
      const mod = await import(pathToFileURL(join(dir, f)).href);
      for (const lib of [mod.default].flat().filter(Boolean)) {
        if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(lib.id ?? '') || typeof lib.search !== 'function' || !Array.isArray(lib.kinds)) throw new Error(`stock/libraries/${f}: not a stock library (needs id, kinds and search)`);
        CODE.set(lib.id, lib);
      }
    }
  }
}

let config = {};
/** Tests set a fake fetch here: configure({ fetch }). */
export function configure(next = {}) { config = { ...config, ...next }; }
const fetchImpl = () => config.fetch ?? fetch;

// ---- what exists ----------------------------------------------------------------------------------------------------------------------

const ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** The kinds of a definition that can be brought into a project: it must be able to look an item up by id AND say where its file is. */
const downloadKindsOf = (def) => (def?.kinds ?? []).filter((k) => !!def.item?.[k] && !!def.download?.[k]);
const canAll = (kinds, downloadKinds) => kinds.length > 0 && downloadKinds.length === kinds.length;

/**
 * Every library the owner could use: added ones first, then presets not added yet, then code libraries. Never a key: `takesKey` says the
 * library wants one, `hasKey` that one is saved. `canDownload` (every kind it offers can be brought in) and `downloadKinds` (which can) let
 * the Studio hide "Use in..." where a library can only be searched (Envato Market: Nordle never buys).
 */
export function listLibraries(settings = loadStock()) {
  const out = [];
  const seen = new Set();
  for (const [id, e] of Object.entries(settings.libraries)) {
    seen.add(id);
    const def = e.definition ?? PRESETS[e.preset ?? id];
    const type = e.type === 'folder' ? 'folder' : 'rest';
    const kinds = type === 'folder' ? (e.kinds?.length ? e.kinds : KINDS) : e.kinds ?? def?.kinds ?? [];
    const downloadKinds = type === 'folder' ? kinds : downloadKindsOf(def);
    out.push({
      id, name: e.name ?? def?.name ?? id, type, kinds, added: true, brands: Array.isArray(e.brands) ? e.brands : [],
      configured: type === 'folder' ? !!e.path : def?.auth ? !!e.key : true,
      needs: type === 'rest' && def?.auth && !e.key ? ['an API key'] : [],
      takesKey: type === 'rest' && !!def?.auth, hasKey: type === 'rest' && !!def?.auth && !!e.key,
      canDownload: canAll(kinds, downloadKinds), downloadKinds,
      verified: type === 'rest' ? def?.verified !== false : true, note: def?.note ?? (type === 'folder' ? e.path : ''), license: def?.license ?? e.license ?? null, path: type === 'folder' ? e.path : undefined,
    });
  }
  for (const [id, def] of Object.entries(PRESETS)) {
    if (seen.has(id)) continue;
    const downloadKinds = downloadKindsOf(def);
    out.push({ id, name: def.name, type: 'rest', kinds: def.kinds, added: false, brands: [], configured: false, needs: ['an API key'], takesKey: !!def.auth, hasKey: false, canDownload: canAll(def.kinds, downloadKinds), downloadKinds, verified: def.verified !== false, note: def.note, license: def.license ?? null, preset: true });
  }
  for (const lib of CODE.values()) {
    if (seen.has(lib.id)) continue;
    const downloadKinds = typeof lib.download === 'function' ? lib.kinds : [];
    out.push({ id: lib.id, name: lib.name ?? lib.id, type: 'code', kinds: lib.kinds, added: true, brands: Array.isArray(settings.libraries[lib.id]?.brands) ? settings.libraries[lib.id].brands : [], configured: lib.configured ? !!lib.configured({}) : true, needs: [], takesKey: false, hasKey: false, canDownload: canAll(lib.kinds, downloadKinds), downloadKinds, verified: lib.verified !== false, note: lib.note ?? '', license: lib.license ?? null });
  }
  return out;
}

/**
 * Which brands may use a library: the project ids saved on it. Empty (or none saved) means every brand.
 * Throws a plain sentence when a library is set up for other brands only.
 */
export function checkBrandAllowed(id, project, settings = loadStock()) {
  const brands = settings.libraries[id]?.brands;
  if (project && Array.isArray(brands) && brands.length && !brands.includes(String(project))) {
    throw new StockError(403, `This library is set up for other brands (${brands.join(', ')}), not for "${project}". Change which brands use it in the Stock window.`);
  }
}

/**
 * The libraries Claude may search on its own for a brand while it builds: added, ready (a folder that is set, or a key that is saved) and allowed for that
 * brand, and able to bring a file in. Own folders (the owner's own footage and stock) are listed apart from online libraries. Never a key.
 * Returns null when there is none or the settings cannot be read, so a prompt simply leaves the section out.
 */
export function stockBrief(project, settings) {
  try {
    const libs = listLibraries(settings ?? loadStock()).filter((l) => l.added && l.configured && l.canDownload && (!l.brands.length || l.brands.includes(String(project))));
    const own = libs.filter((l) => l.type === 'folder').map((l) => ({ id: l.id, name: l.name, kinds: l.kinds, path: l.path }));
    const online = libs.filter((l) => l.type !== 'folder').map((l) => ({ id: l.id, name: l.name, kinds: l.downloadKinds, license: l.license ?? null }));
    return own.length || online.length ? { own, online } : null;
  } catch { return null; }
}

/** A library ready to search, or throws a plain sentence about what is missing. */
export function getLibrary(id, settings = loadStock()) {
  const e = settings.libraries[id];
  if (e?.type === 'folder') return folderLibrary({ id, name: e.name, path: e.path, kinds: e.kinds, license: e.license });
  const def = e?.definition ?? PRESETS[e?.preset ?? id];
  if (def) {
    if (!e && def.auth) throw new StockError(400, `${def.name} has not been added yet. The owner adds it with its API key: node nordle.mjs stock key ${id}`);
    return restLibrary({ ...def, id }, e?.key ?? null, { fetchImpl: fetchImpl() });
  }
  if (CODE.has(id)) {
    const lib = CODE.get(id);
    return { ...lib, type: 'code', canLookup: () => typeof lib.lookup === 'function', search: (p) => lib.search(p, { key: e?.key ?? null, entry: e ?? {}, fetchImpl: fetchImpl() }), lookup: (k, i) => lib.lookup(k, i, { key: e?.key ?? null, entry: e ?? {}, fetchImpl: fetchImpl() }), download: (k, r, i) => lib.download(k, r, i, { key: e?.key ?? null, entry: e ?? {}, fetchImpl: fetchImpl() }) };
  }
  throw new StockError(404, `There is no stock library "${id}". Libraries: ${listLibraries(settings).map((l) => l.id).join(', ') || 'none'}.`);
}

// ---- searching ---------------------------------------------------------------------------------------------------------------------------

/** @returns {Promise<{library:string, kind:string, query:string, page:number, total:number|null, items:object[]}>} */
export async function searchStock({ library, query, kind, page = 1, perPage = 15, project }) {
  const q = String(query ?? '').trim();
  if (!q) throw new StockError(400, 'Say what to look for.');
  if (q.length > 200) throw new StockError(400, 'That search is too long (200 characters at most).');
  const lib = getLibrary(String(library ?? ''));
  checkBrandAllowed(String(library ?? ''), project);
  const k = kind ?? lib.kinds[0];
  if (!KINDS.includes(k) || !lib.kinds.includes(k)) throw new StockError(400, `${lib.name} offers ${lib.kinds.join(', ')}, not "${k}".`);
  const p = Math.min(100, Math.max(1, Math.floor(Number(page)) || 1));
  const n = Math.min(40, Math.max(1, Math.floor(Number(perPage)) || 15));
  const r = await lib.search({ query: q, kind: k, page: p, perPage: n });
  pictures.remember(r.items);                         // only these pictures may be fetched for the Studio, for a while (pictures.mjs)
  return { library: lib.id, name: lib.name, kind: k, query: q, page: p, total: r.total ?? null, license: lib.license ?? null, items: r.items };
}

/** A thumbnail or preview picture that a recent search result pointed at, for the Studio (GET /api/stock/thumb). Refuses anything else. */
export const stockPicture = (url) => pictures.get(url, { fetchImpl: fetchImpl() });

// ---- bringing a file into a project ---------------------------------------------------------------------------------------------------

const safeId = (s) => String(s).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'item';
const readJson = (file, fallback) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } };
function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

/** A file already brought in for this library item (any extension), as a project-relative path, or null. */
function existingFor(dir, stem) {
  const folder = join(dir, 'assets', 'stock');
  if (!existsSync(folder)) return null;
  const hit = readdirSync(folder).find((n) => n.startsWith(`${stem}.`) && !n.endsWith('.part'));
  return hit ? `assets/stock/${hit}` : null;
}

/**
 * Bring one item into a project: download (or copy) it to assets/stock/, write its licence line and a "not looked at yet" catalog entry.
 * An item already there is not fetched again. Returns { path, already, item, license }.
 * @param {{library:string, kind:string, id:string, project:string, by?:string}} o
 */
export async function getStockItem(store, { library, kind, id, project, by = 'owner' }) {
  const proj = store.project(String(project ?? ''));
  if (!proj) throw new StockError(404, `There is no project "${project}".`);
  const lib = getLibrary(String(library ?? ''));
  checkBrandAllowed(String(library ?? ''), proj.id);
  const k = kind ?? lib.kinds[0];
  if (!KINDS.includes(k) || !lib.kinds.includes(k)) throw new StockError(400, `${lib.name} offers ${lib.kinds.join(', ')}, not "${k}".`);
  const itemId = String(id ?? '').trim();
  if (!itemId || itemId.length > 300) throw new StockError(400, 'Say which item (its id from the search).');
  const stem = `${safeId(lib.id)}-${safeId(itemId)}`;
  const have = existingFor(proj.dir, stem);
  if (have) {                                          // already in the project: nothing is fetched again (it would spend the library's allowance)
    const line = readJson(join(proj.dir, 'assets', 'stock', 'licences.json'), { items: {} }).items?.[have];
    return { path: have, already: true, item: line ? { id: line.id, title: line.title, author: line.author, page: line.page, kind: k, library: lib.id } : null, license: line?.license ?? lib.license ?? null };
  }
  const found = await lib.lookup(k, itemId);

  const target = await lib.download(k, found.raw, itemId);
  let rel;
  const noExt = join(proj.dir, 'assets', 'stock', stem);
  if (target.file) {                                   // a folder library: copy, never move
    const ext = extname(target.file).toLowerCase();
    mkdirSync(dirname(noExt), { recursive: true });
    copyFileSync(target.file, `${noExt}${ext}`);
    rel = `assets/stock/${stem}${ext}`;
  } else {
    const r = await downloadTo(noExt, target.url, { kind: k, fetchImpl: fetchImpl(), headers: target.headers ?? {} });
    rel = `assets/stock/${stem}.${r.ext}`;
  }

  const it = found.item;
  const license = it.license ?? lib.license ?? null;
  const now = new Date().toISOString();
  // the licence ledger: what the owner would need to show where a file came from and on what terms
  const ledgerFile = join(proj.dir, 'assets', 'stock', 'licences.json');
  const ledger = readJson(ledgerFile, { schema: 'nordle.stock-licences/0.1', items: {} });
  ledger.items[rel] = { library: lib.id, libraryName: lib.name, id: it.id, kind: k, title: it.title, author: it.author ?? null, page: it.page ?? null, license, licenseUrl: it.licenseUrl ?? lib.licenseUrl ?? null, downloadedAt: now, by };
  writeJson(ledgerFile, ledger);

  // the catalog: honest about not having been looked at (the picture-matches-the-words checks depend on what this says)
  const catKind = k === 'photo' ? 'assets' : 'sources';
  const catFile = join(proj.dir, catKind, 'catalog.json');
  const cat = readJson(catFile, { schema: 'nordle.catalog/0.1', brand: proj.id, items: {} });
  if (!cat.items?.[rel]) {
    cat.items = cat.items ?? {};
    cat.items[rel] = {
      shows: `Stock ${k} from ${lib.name}, titled "${it.title}". Not looked at yet: view it and rewrite this to say what it really shows.`,
      tags: it.tags ?? [],
      origin: `${lib.name}${it.page ? ` ${it.page}` : ''}${it.author ? `, by ${it.author}` : ''}${license ? `; licence: ${license}` : ''} (stock; see assets/stock/licences.json)`,
      traps: ['Brought in from a stock library and not looked at yet: nobody has checked what is in frame (people, signs, logos, other brands) or whether it suits this brand.'],
      license: license ?? undefined,
    };
    writeJson(catFile, cat);
  }
  return { path: rel, already: false, item: it, license, bytes: undefined };
}

// ---- the owner's settings ----------------------------------------------------------------------------------------------------------------------

/**
 * Add, change or remove a library. Owner only (the route and the command line check; role must be 'human').
 * body: { library, preset?, definition?, key?, clearKey?, path?, kinds?, name?, license?, remove? }
 */
export function saveStockSettings(body = {}, role) {
  if (role !== 'human') throw new StockError(403, 'Only the owner can add or change stock libraries and their keys.');
  const id = String(body.library ?? body.definition?.id ?? '');
  if (!ID.test(id)) throw new StockError(400, 'library: lower-case letters, digits, - and _ (up to 40).');
  if (body.remove) {
    changeStock((s) => { delete s.libraries[id]; });
    return { ok: true, libraries: listLibraries() };
  }
  // which brands use a library: a list of project ids; an empty list (or null) means every brand
  const cleanBrands = (v) => {
    if (v === null || v === undefined) return [];
    if (!Array.isArray(v) || v.length > 60 || !v.every((x) => typeof x === 'string' && ID.test(x))) throw new StockError(400, 'brands: a list of brand ids (empty means every brand).');
    return [...new Set(v)];
  };
  if (body.brands !== undefined && Object.keys(body).every((k) => k === 'library' || k === 'brands')) {
    if (!loadStock().libraries[id] && !CODE.has(id)) throw new StockError(404, `There is no library "${id}" to change. Add it first.`);
    const brands = cleanBrands(body.brands);
    changeStock((s) => { s.libraries[id] ??= { type: 'code', addedAt: new Date().toISOString() }; if (brands.length) s.libraries[id].brands = brands; else delete s.libraries[id].brands; });
    return { ok: true, libraries: listLibraries() };
  }
  const isFolder = body.path !== undefined || loadStock().libraries[id]?.type === 'folder';
  if (isFolder) {
    // a folder may not take the name of a library that already exists as something else (it would graft a path onto a key and a definition)
    const have = loadStock().libraries[id];
    if (body.path !== undefined && (have ? have.type !== 'folder' : PRESETS[id] || CODE.has(id))) throw new StockError(400, `"${id}" is already the name of another stock library. Give the folder a different name.`);
    if (body.path !== undefined && (typeof body.path !== 'string' || !/^([A-Za-z]:[\\/]|\/)/.test(body.path))) throw new StockError(400, 'path: the full path of the folder, such as D:/Stock Videos.');
    if (body.kinds !== undefined && (!Array.isArray(body.kinds) || !body.kinds.every((x) => KINDS.includes(x)))) throw new StockError(400, `kinds: a list of ${KINDS.join(', ')}.`);
    changeStock((s) => { s.libraries[id] = { ...(s.libraries[id] ?? {}), type: 'folder', ...(body.path !== undefined ? { path: body.path } : {}), ...(body.kinds ? { kinds: body.kinds } : {}), ...(body.name ? { name: String(body.name).slice(0, 60) } : {}), ...(body.license ? { license: String(body.license).slice(0, 300) } : {}), ...(body.brands !== undefined ? (cleanBrands(body.brands).length ? { brands: cleanBrands(body.brands) } : {}) : {}), addedAt: s.libraries[id]?.addedAt ?? new Date().toISOString() }; });
    return { ok: true, libraries: listLibraries() };
  }
  if (body.definition !== undefined) {
    const problems = definitionProblems({ ...body.definition, id });
    if (problems.length) throw new StockError(400, `That library definition cannot be used: ${problems.join(' ')}`);
  }
  if (body.preset !== undefined && !PRESETS[body.preset]) throw new StockError(400, `There is no preset "${body.preset}". Presets: ${Object.keys(PRESETS).join(', ')}.`);
  if (body.key !== undefined && body.key !== null && (typeof body.key !== 'string' || body.key.length < 6 || body.key.length > 400 || /\s/.test(body.key))) throw new StockError(400, 'key: the API key, as one piece of text.');
  const known = loadStock().libraries[id];
  if (!known && body.definition === undefined && body.preset === undefined && !PRESETS[id] && !CODE.has(id)) throw new StockError(404, `There is no library "${id}" to add. Give a preset (${Object.keys(PRESETS).join(', ')}) or a definition.`);
  changeStock((s) => {
    const cur = s.libraries[id] ?? { type: 'rest', addedAt: new Date().toISOString() };
    if (body.definition !== undefined) { cur.definition = { ...body.definition, id }; delete cur.preset; }
    else if (body.preset !== undefined) { cur.preset = body.preset; delete cur.definition; }
    else if (!cur.definition && !cur.preset && PRESETS[id]) cur.preset = id;
    if (body.key !== undefined) { if (body.key === null) delete cur.key; else cur.key = body.key; }
    if (body.name) cur.name = String(body.name).slice(0, 60);
    s.libraries[id] = cur;
  });
  return { ok: true, libraries: listLibraries() };
}

/** Does the key work? One small search. Owner only. */
export async function testStockLibrary(id, role) {
  if (role !== 'human') throw new StockError(403, 'Only the owner can test a library.');
  const lib = getLibrary(id);
  try {
    const r = await lib.search({ query: lib.kinds[0] === 'sfx' || lib.kinds[0] === 'music' ? 'rain' : 'sea', kind: lib.kinds[0], page: 1, perPage: 1 });
    return { ok: true, message: `${lib.name} answered${r.total ? ` (${r.total} results for the test search)` : ''}.` };
  } catch (e) {
    if (e instanceof StockError) return { ok: false, message: e.message };
    throw e;
  }
}
