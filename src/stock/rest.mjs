// A stock library described as DATA: any library with a JSON web API can be added without writing code, by saying where to search, how
// the key is sent, and which fields of the answer are the id, title, picture and so on. Example (Pexels, abridged):
//
//   { "id": "pexels", "name": "Pexels", "kinds": ["photo", "video"],
//     "auth": { "in": "header", "name": "Authorization" },                      // or { "in": "query", "name": "key" }; "prefix": "Bearer " if it needs one
//     "license": "Pexels licence: free to use, no attribution needed", "licenseUrl": "https://www.pexels.com/license/",
//     "search": { "photo": { "url": "https://api.pexels.com/v1/search?query={query}&per_page={perPage}&page={page}", "itemsPath": "photos", "totalPath": "total_results",
//                            "map": { "id": "id", "title": "alt", "author": "photographer", "page": "url", "thumb": "src.medium", "preview": "src.large", "width": "width", "height": "height" } } },
//     "item":   { "photo": { "url": "https://api.pexels.com/v1/photos/{id}" } },                      // one item by id (needed to download by id)
//     "download": { "photo": { "urlPath": "src.original" } } }
//
// Paths are dotted ("src.original", "video_files.0.link"). Placeholders in a url: {query} {page} {perPage} {id} (always encoded).
// A download is one of: { urlPath } (a field of the item), { listPath, urlKey, where?: {file_type: "video/mp4"}, sortKey?: "width", max?: 1920 }
// (pick the file from a list: the widest not wider than max), or { request: { url, urlPath } } (one more call that answers with the file's address).
// The key is sent as the definition says and is never in a result or an error. Every address is checked in net.mjs before it is used.

import { KINDS, StockError, assertPublicHttps, safeFetch } from './net.mjs';

const ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const PATH = /^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+)*$/;

export const pathGet = (obj, path) => {
  if (!path) return undefined;
  let cur = obj;
  for (const part of String(path).split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
};

/** Everything wrong with a definition, as plain sentences (empty list: usable). */
export function definitionProblems(def) {
  const bad = [];
  const need = (cond, msg) => { if (!cond) bad.push(msg); };
  if (!def || typeof def !== 'object' || Array.isArray(def)) return ['A library definition is a JSON object.'];
  need(ID.test(def.id ?? ''), 'id: lower-case letters, digits, - and _ (up to 40), starting with a letter or digit.');
  need(typeof def.name === 'string' && def.name.trim().length > 0 && def.name.length <= 60, 'name: a short name to show.');
  need(Array.isArray(def.kinds) && def.kinds.length > 0 && def.kinds.every((k) => KINDS.includes(k)), `kinds: a list of ${KINDS.join(', ')}.`);
  if (def.auth !== undefined) {
    need(def.auth && ['header', 'query'].includes(def.auth.in) && typeof def.auth.name === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(def.auth.name), 'auth: { "in": "header" or "query", "name": "...", "prefix"?: "..." }.');
    need(def.auth?.prefix === undefined || (typeof def.auth.prefix === 'string' && def.auth.prefix.length <= 20), 'auth.prefix: short text such as "Bearer ".');
  }
  for (const kind of Array.isArray(def.kinds) ? def.kinds : []) {
    const s = def.search?.[kind];
    if (!s) { bad.push(`search.${kind}: say how to search for ${kind}.`); continue; }
    need(typeof s.url === 'string' && s.url.includes('{query}'), `search.${kind}.url: a web address containing {query}.`);
    try { assertPublicHttps(String(s.url).replace(/\{[a-zA-Z]+\}/g, 'x'), `search.${kind}.url`); } catch (e) { bad.push(e.message); }
    need(typeof s.itemsPath === 'string' && PATH.test(s.itemsPath), `search.${kind}.itemsPath: where the list of results is in the answer (dotted, e.g. "photos").`);
    need(s.map && typeof s.map.id === 'string' && PATH.test(s.map.id), `search.${kind}.map.id: which field is the item's id.`);
    for (const [k, p] of Object.entries(s.map ?? {})) need(typeof p === 'string' && PATH.test(p), `search.${kind}.map.${k}: a dotted path such as "src.medium".`);
    const d = def.download?.[kind];
    if (d) {
      const forms = [d.urlPath, d.listPath, d.request].filter((x) => x !== undefined).length;
      need(forms === 1, `download.${kind}: exactly one of urlPath, listPath (with urlKey) or request.`);
      if (d.urlPath !== undefined) need(PATH.test(d.urlPath), `download.${kind}.urlPath: a dotted path.`);
      if (d.listPath !== undefined) need(PATH.test(d.listPath) && typeof d.urlKey === 'string' && PATH.test(d.urlKey), `download.${kind}: listPath and urlKey are dotted paths.`);
      if (d.request) { need(typeof d.request.url === 'string' && d.request.url.includes('{id}') && PATH.test(d.request.urlPath ?? ''), `download.${kind}.request: { "url": "...{id}...", "urlPath": "..." }.`); }
    }
    const it = def.item?.[kind];
    if (it) need(typeof it.url === 'string' && it.url.includes('{id}') && (it.itemPath === undefined || PATH.test(it.itemPath)), `item.${kind}.url: a web address containing {id}.`);
  }
  need(def.license === undefined || (typeof def.license === 'string' && def.license.length <= 300), 'license: a short sentence.');
  need(def.licenseUrl === undefined || /^https:\/\//.test(def.licenseUrl), 'licenseUrl: an https address.');
  return bad;
}

const fill = (tpl, vars) => String(tpl).replace(/\{([a-zA-Z]+)\}/g, (_, k) => encodeURIComponent(String(vars[k] ?? '')));
const asText = (v) => (v === undefined || v === null ? '' : typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const asNumber = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
const asTags = (v) => (Array.isArray(v) ? v.map(asText) : asText(v).split(/[,;]\s*/)).map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 20);

/**
 * A library made from a definition and a key. `fetchImpl` is injected by tests.
 * @returns {{id:string, name:string, kinds:string[], search:Function, lookup:Function, download:Function}}
 */
export function restLibrary(def, key, { fetchImpl = fetch } = {}) {
  const problems = definitionProblems(def);
  if (problems.length) throw new StockError(400, `That library definition cannot be used: ${problems[0]}`);
  const secrets = [key].filter(Boolean);
  const scrub = (text) => secrets.reduce((t, s) => String(t).split(s).join('[key]'), String(text));

  const request = (rawUrl, vars) => {
    let url = fill(rawUrl, vars);
    const headers = { accept: 'application/json', 'user-agent': 'Nordle (stock search)' };
    if (def.auth && key) {
      if (def.auth.in === 'header') headers[def.auth.name] = `${def.auth.prefix ?? ''}${key}`;
      else url += `${url.includes('?') ? '&' : '?'}${encodeURIComponent(def.auth.name)}=${encodeURIComponent(key)}`;
    }
    return { url, headers };
  };

  async function getJson(rawUrl, vars) {
    if (def.auth && !key) throw new StockError(400, `${def.name} needs an API key first (the owner adds it with: node nordle.mjs stock key ${def.id}).`);
    const { url, headers } = request(rawUrl, vars);
    let res;
    try { res = await safeFetch(url, { headers }, { fetchImpl }); } catch (e) { if (e instanceof StockError) throw new StockError(e.status, scrub(e.message)); throw new StockError(502, `Could not reach ${def.name}: ${scrub(e.message)}`); }
    if (res.status === 401 || res.status === 403) throw new StockError(401, `${def.name} refused the key (${res.status}). Check it, or save a new one.`, { code: 'key-refused' });
    if (res.status === 404) throw new StockError(404, `${def.name} has nothing there (404).`);
    if (res.status === 429) throw new StockError(429, `${def.name} says the limit is reached for now (429). Try again later.`, { code: 'rate-limit' });
    if (!res.ok) throw new StockError(502, `${def.name} answered ${res.status}.`);
    try { return await res.json(); } catch { throw new StockError(502, `${def.name} did not answer in a form Nordle can read.`); }
  }

  const shape = (kind, raw) => {
    const m = def.search[kind].map;
    const id = asText(pathGet(raw, m.id));
    return {
      id, kind, library: def.id,
      title: asText(pathGet(raw, m.title)).slice(0, 200) || `${def.name} ${kind} ${id}`,
      author: asText(pathGet(raw, m.author)).slice(0, 120) || null,
      page: asText(pathGet(raw, m.page)).startsWith('https://') ? asText(pathGet(raw, m.page)) : null,
      thumb: asText(pathGet(raw, m.thumb)).startsWith('https://') ? asText(pathGet(raw, m.thumb)) : null,
      preview: asText(pathGet(raw, m.preview)).startsWith('https://') ? asText(pathGet(raw, m.preview)) : null,
      width: asNumber(pathGet(raw, m.width)), height: asNumber(pathGet(raw, m.height)), duration: asNumber(pathGet(raw, m.duration)),
      tags: asTags(pathGet(raw, m.tags)),
      license: asText(pathGet(raw, m.license)) || def.license || null,
      licenseUrl: def.licenseUrl ?? null,
    };
  };

  return {
    id: def.id, name: def.name, kinds: def.kinds, type: 'rest', license: def.license ?? null, licenseUrl: def.licenseUrl ?? null, note: def.note ?? '',
    canLookup: (kind) => !!def.item?.[kind],
    async search({ query, kind, page = 1, perPage = 15 }) {
      const s = def.search[kind];
      const json = await getJson(s.url, { query, page, perPage });
      const list = pathGet(json, s.itemsPath);
      if (!Array.isArray(list)) throw new StockError(422, `${def.name} answered, but there was no list at "${s.itemsPath}". The library definition may be out of date.`);
      const items = list.slice(0, perPage).map((raw) => shape(kind, raw)).filter((it) => it.id);
      return { items, total: s.totalPath ? asNumber(pathGet(json, s.totalPath)) : null, page };
    },
    /** One item by id (the raw answer), for downloading. */
    async lookup(kind, id) {
      const it = def.item?.[kind];
      if (!it) throw new StockError(400, `${def.name} has no lookup by id in its definition, so it cannot be downloaded by id.`);
      const json = await getJson(it.url, { id });
      const raw = it.itemPath ? pathGet(json, it.itemPath) : json;
      if (!raw || typeof raw !== 'object') throw new StockError(404, `${def.name} has no ${kind} "${id}".`);
      return { raw, item: shape(kind, raw) };
    },
    /** The address of the file for an item: { url, headers? }. */
    async download(kind, raw, id) {
      const d = def.download?.[kind];
      if (!d) throw new StockError(400, `${def.name} has no download for ${kind} in its definition.`);
      let url;
      if (d.urlPath) url = asText(pathGet(raw, d.urlPath));
      else if (d.listPath) {
        let list = pathGet(raw, d.listPath);
        if (!Array.isArray(list)) throw new StockError(422, `${def.name} answered, but there was no list of files at "${d.listPath}".`);
        if (d.where) list = list.filter((f) => Object.entries(d.where).every(([k, v]) => pathGet(f, k) === v));
        list = list.filter((f) => asText(pathGet(f, d.urlKey)).startsWith('https://'));
        if (d.sortKey) {
          const size = (f) => asNumber(pathGet(f, d.sortKey)) ?? 0;
          const fits = d.max ? list.filter((f) => size(f) <= d.max) : list;
          list = (fits.length ? fits : list).sort((a, b) => (fits.length ? size(b) - size(a) : size(a) - size(b)));
        }
        url = list.length ? asText(pathGet(list[0], d.urlKey)) : '';
      } else if (d.request) {
        const json = await getJson(d.request.url, { id });
        url = asText(pathGet(json, d.request.urlPath));
      }
      if (!url) throw new StockError(422, `${def.name} did not give a file address for ${kind} "${id}". It may need a purchase or a login that Nordle does not do.`);
      return { url };
    },
  };
}
