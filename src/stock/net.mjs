// The only way stock libraries reach the internet. Everything a library's answer can point Nordle at (a preview, a file to download)
// is checked here before it is fetched, because the address comes from someone else's server:
//   * https only, no user:password in the address, no localhost or private/link-local/loopback numbers (a library cannot aim Nordle at
//     the owner's own machine or network);
//   * redirects are followed by hand, a few hops, each one checked again;
//   * a download has a size cap per kind and must look like the right kind of file (a web page saved as "photo.jpg" is refused);
//   * the file is written next to its final name and renamed when complete, so a failed download never leaves a half file behind.
// `fetchImpl` is injected so tests never touch the network. DNS is not re-resolved: this is a guard against a careless or hostile
// address in an API answer, not a firewall (see docs/STOCK.md).

import { createWriteStream, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, extname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export class StockError extends Error {
  /** @param {number} status 400 bad request, 403 owner only, 404 not found, 413 too big, 422 unusable answer, 429 rate limit, 502 the library failed */
  constructor(status, message, extra = {}) { super(message); this.name = 'StockError'; this.status = status; this.code = extra.code ?? null; }
}

export const MAX_BYTES = { photo: 60 * 1024 * 1024, video: 800 * 1024 * 1024, music: 100 * 1024 * 1024, sfx: 50 * 1024 * 1024 };
export const KINDS = Object.keys(MAX_BYTES);

const PRIVATE_V4 = [[0, 8], [10, 8], [100.64, 10], [127, 8], [169.254, 16], [172.16, 12], [192, 24], [192.168, 16], [198.18, 15], [224, 4], [240, 4]];
const v4 = (host) => { const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host); return m ? m.slice(1).map(Number) : null; };
function privateV4([a, b, c, d]) {
  const n = ((a << 24) >>> 0) + (b << 16) + (c << 8) + d;
  return PRIVATE_V4.some(([base, bits]) => {
    const [x, y = 0, z = 0] = String(base).split('.').map(Number);
    const baseN = ((x << 24) >>> 0) + (y << 16) + (z << 8);
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((n & mask) >>> 0) === ((baseN & mask) >>> 0);
  });
}

/** Throws unless `value` is a public https address. Returns the parsed URL. */
export function assertPublicHttps(value, what = 'The address') {
  let u;
  try { u = new URL(String(value)); } catch { throw new StockError(422, `${what} is not a web address.`); }
  if (u.protocol !== 'https:') throw new StockError(422, `${what} must start with https:// (it was ${u.protocol}//).`);
  if (u.username || u.password) throw new StockError(422, `${what} must not carry a user name or password.`);
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.') && !host.includes(':')) {
    throw new StockError(422, `${what} points at this computer or a private network, which a stock library may not do.`);
  }
  const ip = v4(host);
  if (ip && (ip.some((n) => n > 255) || privateV4(ip))) throw new StockError(422, `${what} is a private or reserved number, which a stock library may not use.`);
  if (host.includes(':') && (host === '::1' || host === '::' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith('::ffff:'))) throw new StockError(422, `${what} is a private or reserved number, which a stock library may not use.`);
  return u;
}

/** fetch with each redirect checked by hand. */
export async function safeFetch(url, init = {}, { fetchImpl = fetch, maxRedirects = 3, timeoutMs = 30000 } = {}) {
  let target = assertPublicHttps(url).href;
  for (let hop = 0; ; hop++) {
    const res = await fetchImpl(target, { ...init, redirect: 'manual', signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      if (hop >= maxRedirects) throw new StockError(502, 'The library sent the request round in circles.');
      target = assertPublicHttps(new URL(res.headers.get('location'), target).href, 'A redirect').href;
      continue;
    }
    return res;
  }
}

const TYPE_EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/flac': 'flac' };
const KNOWN_EXT = new Set(Object.values(TYPE_EXT));
const KIND_PREFIX = { photo: 'image/', video: 'video/', music: 'audio/', sfx: 'audio/' };

/** The file extension to save as, from the content type or the address; null when it is not a file of that kind. */
export function extensionFor(kind, contentType, url) {
  const type = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  if (type && TYPE_EXT[type] && type.startsWith(KIND_PREFIX[kind])) return TYPE_EXT[type];
  if (type && !['application/octet-stream', 'binary/octet-stream', ''].includes(type)) return null;
  let ext = '';
  try { ext = extname(new URL(url).pathname).slice(1).toLowerCase(); } catch { /* no usable address */ }
  if (ext === 'jpeg') ext = 'jpg';
  const wanted = { photo: ['jpg', 'png', 'webp', 'gif'], video: ['mp4', 'mov', 'webm'], music: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'], sfx: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'] }[kind] ?? [];
  return KNOWN_EXT.has(ext) && wanted.includes(ext) ? ext : null;
}

/**
 * Download `url` to `file` (without its extension: it is chosen from the answer). Returns { file, bytes, ext }.
 * @param {{kind:string, fetchImpl?:Function, headers?:object, maxBytes?:number}} o
 */
export async function downloadTo(fileNoExt, url, { kind, fetchImpl = fetch, headers = {}, maxBytes = MAX_BYTES[kind] } = {}) {
  const res = await safeFetch(url, { headers }, { fetchImpl, timeoutMs: 120000 });
  if (!res.ok) throw new StockError(res.status === 429 ? 429 : 502, `The library would not send the file (it answered ${res.status}).`);
  const ext = extensionFor(kind, res.headers.get('content-type'), res.url || url);
  if (!ext) throw new StockError(422, `The library sent something that is not ${kind === 'photo' ? 'a picture' : kind === 'video' ? 'a video' : 'a sound'} (${String(res.headers.get('content-type') ?? 'unknown type').split(';')[0]}), so it was not saved.`);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new StockError(413, `That file is ${Math.round(declared / 1048576)} MB; the limit for ${kind} is ${Math.round(maxBytes / 1048576)} MB.`);
  const file = `${fileNoExt}.${ext}`;
  const part = `${file}.part`;
  mkdirSync(dirname(file), { recursive: true });
  let bytes = 0;
  const counter = new Transform({ transform(chunk, _enc, cb) { bytes += chunk.length; cb(bytes > maxBytes ? new StockError(413, `That file is bigger than the ${Math.round(maxBytes / 1048576)} MB limit for ${kind}, so it was stopped.`) : null, chunk); } });
  try {
    if (!res.body) throw new StockError(502, 'The library sent an empty answer.');
    await pipeline(Readable.fromWeb(res.body), counter, createWriteStream(part));
    if (!bytes) throw new StockError(502, 'The library sent an empty file.');
    renameSync(part, file);
  } catch (e) {
    rmSync(part, { force: true });
    if (e instanceof StockError) throw e;
    throw new StockError(502, `The download failed: ${e.message}`);
  }
  return { file, bytes, ext };
}
