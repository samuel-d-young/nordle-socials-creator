// Stock thumbnails through Nordle, so the Studio never loads a picture straight from a library's server. Two reasons: the page's content-security
// policy keeps pictures same-origin, and a direct load would tell the library's server (and its CDN) the owner's address on every search.
//
// This is a picture proxy, and a proxy that fetches any address it is given is an open proxy, so it is tightly bound:
//   * only an address that appeared as `thumb` or `preview` in a search result this process returned in the last 30 minutes (remember());
//     anything else is refused with 403 and nothing is fetched;
//   * the fetch goes through net.mjs safeFetch: https only, public hosts only, redirects checked by hand;
//   * the answer must be a picture (image/*, not SVG) and at most 3 MB, counted while it arrives, not only from the header;
//   * what was fetched is kept in memory for 10 minutes (bounded in count and in bytes) so a page of results is fetched once;
//   * no key is ever sent: a picture address is not an API call.
// `createPictureProxy` takes a clock so tests can move time; `pictures` is the one the server uses (per process).

import { StockError, safeFetch } from './net.mjs';

export const PICTURE_MAX_BYTES = 3 * 1024 * 1024;

/**
 * @param {{allowMs?:number, cacheMs?:number, maxAllowed?:number, maxCached?:number, maxCacheBytes?:number, now?:()=>number}} [o]
 */
export function createPictureProxy({ allowMs = 30 * 60000, cacheMs = 10 * 60000, maxAllowed = 5000, maxCached = 150, maxCacheBytes = 48 * 1024 * 1024, now = Date.now } = {}) {
  const allowed = new Map();    // address -> when it stops being allowed (insertion order is expiry order, because the time to live is constant)
  const cache = new Map();      // address -> { type, body, expires }
  const pending = new Map();    // address -> the fetch in flight, so a page of repeats is one request
  let cachedBytes = 0;

  const dropCached = (url) => { const c = cache.get(url); if (c) { cachedBytes -= c.body.length; cache.delete(url); } };
  const sweepAllowed = () => { const t = now(); for (const [u, until] of allowed) { if (until > t) break; allowed.delete(u); } };
  const sweepCached = () => { const t = now(); for (const [u, c] of cache) { if (c.expires > t) break; dropCached(u); } };

  /** Note the pictures a search result points at (thumb and preview, https only). */
  function remember(items) {
    const t = now();
    for (const it of items ?? []) {
      for (const key of ['thumb', 'preview']) {
        const u = it?.[key];
        if (typeof u !== 'string' || !u.startsWith('https://') || u.length > 2048) continue;
        allowed.delete(u);                           // seen again: its 30 minutes start again, at the back of the line
        allowed.set(u, t + allowMs);
      }
    }
    sweepAllowed();
    while (allowed.size > maxAllowed) allowed.delete(allowed.keys().next().value);
  }

  function allows(url) {
    const until = allowed.get(url);
    if (until === undefined) return false;
    if (until <= now()) { allowed.delete(url); return false; }
    return true;
  }

  async function load(url, fetchImpl) {
    let res;
    try { res = await safeFetch(url, { headers: { accept: 'image/*', 'user-agent': 'Nordle (stock thumbnails)' } }, { fetchImpl, timeoutMs: 15000 }); } catch (e) {
      if (e instanceof StockError) throw e;
      throw new StockError(502, 'Could not fetch that picture from the library.');
    }
    if (res.status === 404) throw new StockError(404, 'The library has no such picture.');
    if (!res.ok) throw new StockError(502, `The library's picture server answered ${res.status}.`);
    const type = String(res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!/^image\/[a-z0-9.+-]+$/.test(type) || type === 'image/svg+xml') throw new StockError(422, `That address is not a picture the Studio can show (${type || 'no content type'}).`);
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > PICTURE_MAX_BYTES) throw new StockError(413, 'That picture is bigger than the 3 MB a thumbnail may be.');
    if (!res.body) throw new StockError(502, 'The library sent an empty picture.');
    const chunks = [];
    let bytes = 0;
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > PICTURE_MAX_BYTES) { await reader.cancel().catch(() => {}); throw new StockError(413, 'That picture is bigger than the 3 MB a thumbnail may be.'); }
        chunks.push(value);
      }
    } catch (e) {
      if (e instanceof StockError) throw e;
      throw new StockError(502, 'The picture stopped arriving part-way.');
    }
    if (!bytes) throw new StockError(502, 'The library sent an empty picture.');
    const body = Buffer.concat(chunks);
    dropCached(url);
    cache.set(url, { type, body, expires: now() + cacheMs });
    cachedBytes += body.length;
    while (cache.size > maxCached || cachedBytes > maxCacheBytes) dropCached(cache.keys().next().value);
    return { type, body };
  }

  /** @returns {Promise<{type:string, body:Buffer, cached:boolean}>} */
  async function get(raw, { fetchImpl = fetch } = {}) {
    const url = String(raw ?? '');
    if (!url) throw new StockError(400, 'Say which picture (url=).');
    if (!allows(url)) throw new StockError(403, 'That picture did not come from a recent search, so Nordle will not fetch it.');
    sweepCached();
    const hit = cache.get(url);
    if (hit) return { type: hit.type, body: hit.body, cached: true };
    let flight = pending.get(url);
    if (!flight) { flight = load(url, fetchImpl).finally(() => pending.delete(url)); pending.set(url, flight); }
    return { ...(await flight), cached: false };
  }

  /** Forget everything (tests). */
  function clear() { allowed.clear(); cache.clear(); pending.clear(); cachedBytes = 0; }

  return { remember, allows, get, clear, size: () => ({ allowed: allowed.size, cached: cache.size, bytes: cachedBytes }) };
}

/** The one the server uses. */
export const pictures = createPictureProxy();
