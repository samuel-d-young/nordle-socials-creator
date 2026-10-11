// Stock libraries API (root scope, /api/stock/...). See docs/STOCK.md. Claude's token may search and bring a file into a project (that is a
// designer's job; the owner's key does the searching); adding or changing a library, a key or a folder is the owner's. No reply ever holds a key.
//
//   GET  /api/stock/libraries                      -> { libraries:[ { id, name, type:'rest'|'folder'|'code', kinds, added, configured, needs, takesKey, hasKey, canDownload,
//                                                                      downloadKinds, verified, note, license, path? } ] }   (hasKey says a key is saved; the key itself never leaves)
//   GET  /api/stock/search?library=&q=&kind=&page=&perPage=   -> { library, name, kind, query, page, total, license, items:[ { id, kind, title, author, page, thumb, preview,
//                                                                width, height, duration, tags, license, licenseUrl } ] }
//   GET  /api/stock/thumb?url=                     -> the picture itself (image/*, at most 3 MB), fetched through Nordle so the Studio never loads from a library's server.
//                                                                ONLY for an address that was a `thumb` or `preview` in a search result in the last 30 minutes (403 otherwise);
//                                                                either token; cached 10 minutes (src/stock/pictures.mjs)
//   POST /api/stock/get      { library, id, kind?, project }   -> { path, already, item, license }   downloads (or copies) the file to <project>/assets/stock/,
//                                                                writes its licence line and a "not looked at yet" catalog entry
//   POST /api/stock/settings (owner) { library, preset? | definition? | path? (+kinds, license), key?, name?, remove? }   -> { ok, libraries }
//   POST /api/stock/test     (owner) { library }               -> { ok, message }   one small search
// Errors: { ok:false, errors:[{path,message,code?}] } with the status (code: 'key-refused' | 'rate-limit' when the library said so).

import { StockError, getStockItem, listLibraries, saveStockSettings, searchStock, stockPicture, testStockLibrary } from '../../stock/index.mjs';

export default {
  scope: 'root',
  key: 'stock',
  async handle(ctx) {
    const { seg, method, url, req, res, store, human, sendJson, readJsonBody, need, needHuman } = ctx;
    const sub = seg[1];
    const role = human ? 'human' : 'agent';
    try {
      if (sub === 'libraries') { need(method === 'GET', 405, 'GET only.'); return sendJson(res, 200, { libraries: listLibraries() }); }
      if (sub === 'search') {
        need(method === 'GET', 405, 'GET only.');
        const q = url.searchParams;
        return sendJson(res, 200, { ok: true, ...(await searchStock({ library: q.get('library'), query: q.get('q'), kind: q.get('kind') ?? undefined, page: q.get('page') ?? 1, perPage: q.get('perPage') ?? 15, project: q.get('project') ?? undefined })) });
      }
      if (sub === 'thumb') {
        need(method === 'GET' || method === 'HEAD', 405, 'GET only.');
        const pic = await stockPicture(url.searchParams.get('url') ?? '');
        res.writeHead(200, { 'content-type': pic.type, 'content-length': pic.body.length, 'cache-control': 'private, max-age=600', 'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'" });
        return void res.end(method === 'HEAD' ? undefined : pic.body);
      }
      if (sub === 'get') {
        need(method === 'POST', 405, 'POST only.');
        const b = await readJsonBody(req);
        return sendJson(res, 200, { ok: true, ...(await getStockItem(store, { library: b.library, id: b.id, kind: b.kind, project: b.project, by: human ? 'owner' : 'claude' })) });
      }
      if (sub === 'settings') {
        need(method === 'POST', 405, 'POST only.');
        needHuman();
        return sendJson(res, 200, saveStockSettings(await readJsonBody(req), role));
      }
      if (sub === 'test') {
        need(method === 'POST', 405, 'POST only.');
        needHuman();
        return sendJson(res, 200, { ok: true, ...(await testStockLibrary(String((await readJsonBody(req)).library ?? ''), role)) });
      }
    } catch (e) {
      if (e instanceof StockError) return sendJson(res, e.status, { ok: false, errors: [{ path: '/', message: e.message, ...(e.code ? { code: e.code } : {}) }] });
      throw e;
    }
    return false;
  },
};
