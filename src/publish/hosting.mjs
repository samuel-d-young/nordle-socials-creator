// Media hosting: Buffer takes pictures and video only as public web addresses (it has no upload), so Nordle can put the files of the
// posts being scheduled into the owner's own bucket (Cloudflare R2, Amazon S3, Backblaze B2, Wasabi... anything that speaks the S3 API)
// and hand Buffer the addresses. The owner enters the bucket's keys once; they are kept in the same private file as the Buffer keys
// and never leave the server. Files go up only when the owner presses Schedule, and only for the posts in that run.
//
//   settings.hosting = { kind: 's3', endpoint, region, bucket, accessKeyId, secretAccessKey, publicBaseUrl }
//
// A file lands at <bucket>/<project>/<post folder>/<file> and is read back at <publicBaseUrl>/<project>/<post folder>/<file>, which is
// exactly the address the Buffer adapter builds from the media web address. (The bucket has to allow public reads: for R2 turn on the
// public development URL or attach a domain; the Test button checks this.) `fetch` is injectable so tests never touch the network.

import { createHash, createHmac } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { PublishError, redact } from './store.mjs';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
const rfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * AWS Signature Version 4 for one request. Pure (the date is passed in) so it can be checked against Amazon's published examples.
 * headers: every header to sign, names lower-case. Returns the headers to send, with Authorization added.
 */
export function signRequest({ method, host, path, query = '', headers = {}, payloadHash, accessKeyId, secretAccessKey, region, service = 's3', amzDate }) {
  const date = amzDate.slice(0, 8);
  const all = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')])) };
  const names = Object.keys(all).sort();
  const canonicalHeaders = names.map((n) => `${n}:${all[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [method, path, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), region), service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return { ...all, authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`, signature, canonicalRequest };
}

const isoDate = (d = new Date()) => d.toISOString().replace(/[:-]|\.\d{3}/g, '');

const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.txt': 'text/plain; charset=utf-8' };
export const contentTypeOf = (file) => TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';

/** What the owner may save. A key left out keeps the one already saved. Returns the full object to store. */
export function validateHosting(input, current = null) {
  if (input === null) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PublishError(400, 'hosting must be an object, or null to switch it off.');
  const known = ['kind', 'endpoint', 'region', 'bucket', 'accessKeyId', 'secretAccessKey', 'publicBaseUrl'];
  for (const k of Object.keys(input)) if (!known.includes(k)) throw new PublishError(400, `Unknown hosting setting "${k}". Settings: ${known.join(', ')}.`);
  if (input.kind !== undefined && input.kind !== 's3') throw new PublishError(400, 'Only S3-compatible hosting (Cloudflare R2, Amazon S3, Backblaze B2...) is supported: kind "s3".');
  const pick = (k) => (input[k] !== undefined && input[k] !== '' ? input[k] : current?.[k]);
  const out = { kind: 's3' };
  const text = (k, label, { max = 200, pattern } = {}) => {
    const v = pick(k);
    if (typeof v !== 'string' || !v.trim()) throw new PublishError(400, `${label} is needed.`);
    if (v.length > max || (pattern && !pattern.test(v.trim()))) throw new PublishError(400, `${label} does not look right.`);
    return v.trim();
  };
  const url = (k, label) => {
    let u;
    try { u = new URL(text(k, label, { max: 300 })); } catch (e) { if (e instanceof PublishError) throw e; throw new PublishError(400, `${label} must be a full address, like https://pub-123.r2.dev`); }
    if (u.protocol !== 'https:') throw new PublishError(400, `${label} must start with https:// (Buffer only fetches HTTPS).`);
    if (u.username || u.password || u.search || u.hash) throw new PublishError(400, `${label} must be a plain address (no password, query or #).`);
    return u.toString().replace(/\/+$/, '');
  };
  out.endpoint = url('endpoint', 'The storage address (endpoint)');
  out.region = text('region', 'The region', { max: 40, pattern: /^[a-z0-9-]+$/i });
  out.bucket = text('bucket', 'The bucket name', { max: 63, pattern: /^[a-z0-9][a-z0-9._-]{1,62}$/i });
  out.accessKeyId = text('accessKeyId', 'The access key ID', { max: 128, pattern: /^[A-Za-z0-9/+=_-]+$/ });
  out.secretAccessKey = text('secretAccessKey', 'The secret access key', { max: 200, pattern: /^\S+$/ });
  out.publicBaseUrl = url('publicBaseUrl', 'The public address of the bucket');
  return out;
}

/** What the Studio may see: everything but the secret, and only the end of the key ID. */
export function hostingView(h) {
  if (!h?.endpoint) return { configured: false };
  return { configured: true, kind: 's3', endpoint: h.endpoint, region: h.region, bucket: h.bucket, publicBaseUrl: h.publicBaseUrl, accessKeyHint: `…${String(h.accessKeyId ?? '').slice(-4)}` };
}

function target(h, key) {
  const u = new URL(h.endpoint);
  const path = `${u.pathname.replace(/\/+$/, '')}/${rfc3986(h.bucket)}/${key.split('/').map(rfc3986).join('/')}`;
  return { url: `${u.origin}${path}`, host: u.host, path };
}

async function request(h, method, key, { body, contentType, fetchImpl, timeoutMs = 120000 } = {}) {
  const t = target(h, key);
  const payloadHash = sha256(body ?? '');
  const headers = signRequest({
    method, host: t.host, path: t.path, payloadHash, accessKeyId: h.accessKeyId, secretAccessKey: h.secretAccessKey, region: h.region, amzDate: isoDate(),
    headers: contentType ? { 'content-type': contentType } : {},
  });
  const send = { ...headers }; delete send.signature; delete send.canonicalRequest; delete send.host;
  try {
    return await (fetchImpl ?? globalThis.fetch)(t.url, { method, headers: send, body, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new PublishError(502, `Could not reach the storage at ${new URL(h.endpoint).host} (${redact(e.message, h.secretAccessKey, h.accessKeyId)}).`, { code: 'hosting-network' });
  }
}

const explain = (res, h) => {
  if (res.status === 403) return 'The storage refused the keys (403). Check the access key ID, the secret and that the key may write to this bucket.';
  if (res.status === 404) return 'The storage says the bucket was not found (404). Check the bucket name and the endpoint.';
  return `The storage answered ${res.status}.`;
};

/** Put one file in the bucket unless the same size is already there. Returns 'uploaded' or 'kept'. */
export async function putFile(h, key, absPath, { fetchImpl } = {}) {
  const body = readFileSync(absPath);
  const head = await request(h, 'HEAD', key, { fetchImpl, timeoutMs: 20000 });
  if (head.ok && Number(head.headers.get('content-length')) === body.length) return 'kept';
  const res = await request(h, 'PUT', key, { body, contentType: contentTypeOf(absPath), fetchImpl });
  if (!res.ok) throw new PublishError(502, `${explain(res, h)} (while sending ${key.split('/').pop()})`, { code: 'hosting-refused' });
  return 'uploaded';
}

/** The key a post's file gets: the same path the Buffer adapter builds its address from. */
export const keyFor = (project, folder, file) => `${project}/${folder}/${file}`;

/**
 * Send these files (the ones a post's addresses point at). files: [{ key, abs }]. Returns { uploaded, kept }.
 * (statSync first so a missing file is a clear message, not a stack trace.)
 */
export async function uploadAll(h, files, { fetchImpl } = {}) {
  let uploaded = 0, kept = 0;
  for (const f of files) {
    try { statSync(f.abs); } catch { throw new PublishError(409, `The file ${f.key.split('/').pop()} is not in the export folder yet.`, { code: 'hosting-missing-file' }); }
    if ((await putFile(h, f.key, f.abs, { fetchImpl })) === 'uploaded') uploaded++; else kept++;
  }
  return { uploaded, kept };
}

/** Does it work end to end? Puts a tiny file and reads it back from the public address, like Buffer will. */
export async function checkHosting(h, { fetchImpl } = {}) {
  const key = '_nordle-check/ok.txt';
  const body = Buffer.from(`nordle ${new Date().toISOString()}\n`);
  try {
    const res = await request(h, 'PUT', key, { body, contentType: 'text/plain; charset=utf-8', fetchImpl });
    if (!res.ok) return { ok: false, message: explain(res, h) };
    let back;
    try { back = await (fetchImpl ?? globalThis.fetch)(`${h.publicBaseUrl}/${key}`, { redirect: 'manual', signal: AbortSignal.timeout(20000) }); }
    catch (e) { return { ok: false, message: `The test file went up, but ${new URL(h.publicBaseUrl).host} could not be reached (${e.message}). Check the public address.` }; }
    if (back.status >= 300 && back.status < 400) return { ok: false, message: 'The public address redirects. Buffer needs the address of the file itself: use the bucket\'s own public address, not a redirect.' };
    if (!back.ok) return { ok: false, message: `The test file went up, but the public address answers ${back.status} for it. The bucket has to allow public reads: for Cloudflare R2 turn on the "Public Development URL" (or connect a domain) in the bucket settings.` };
    const text = await back.text();
    if (text !== body.toString()) return { ok: false, message: 'The public address answers, but with something else than the file that was just sent. Check that it points at this bucket.' };
    return { ok: true, message: `Working: a test file went into "${h.bucket}" and was read back from ${new URL(h.publicBaseUrl).host}.` };
  } catch (e) {
    if (e instanceof PublishError) return { ok: false, message: e.message };
    throw e;
  }
}
