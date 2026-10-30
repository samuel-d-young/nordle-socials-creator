// Small previews on demand. PNG renders are decoded and shrunk in a worker thread (never on the server's main thread) and
// cached in the system temp folder; other picture types are sent as they are (they are already small and the browser
// decodes them off the main thread).

import { createReadStream, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync, renameSync, openSync, readSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { isHiddenSegment, oddSegment } from '../server/hidden-paths.mjs';

const CACHE_DIR = join(tmpdir(), 'nordle-studio-thumbs');
export const WIDTHS = [96, 160, 240, 360, 480, 720, 1080];
const HIDDEN = new Set(['history', 'review', 'checks', 'trash']);
const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

export function snapWidth(w) {
  const n = Number(w);
  if (!Number.isFinite(n) || n <= 0) return 360;
  return WIDTHS.find((x) => x >= n) ?? WIDTHS.at(-1);
}

/** The absolute path of a picture inside a project, or null if it is not a plain picture file in there. */
export function pictureInProject(projectDir, rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 400 || /[\\\0]/.test(rel) || /^[a-zA-Z]:/.test(rel) || rel.startsWith('/')) return null;
  const parts = rel.split('/');
  if (parts.some((p) => p === '' || p === '..' || p.startsWith('.') || oddSegment(p))) return null;
  if (isHiddenSegment(parts[0], HIDDEN)) return null;   // case-insensitive: Review/ is review/ on Windows and macOS
  if (!TYPES[extname(parts.at(-1)).toLowerCase()]) return null;
  const base = resolve(projectDir);
  const abs = resolve(base, ...parts);
  if (!abs.startsWith(base + sep)) return null;
  try {
    const real = realpathSync(abs);
    if (!real.startsWith(realpathSync(base) + sep) || !statSync(real).isFile()) return null;
    return real;
  } catch { return null; }
}

function pngWidth(file) {
  const fd = openSync(file, 'r');
  try {
    const b = Buffer.alloc(24);
    readSync(fd, b, 0, 24, 0);
    return b.toString('latin1', 1, 4) === 'PNG' ? b.readUInt32BE(16) : 0;
  } finally { closeSync(fd); }
}

// ---- the worker pool: at most two threads, started on demand, never keeping the process alive ---------------------------------------
const workerFile = fileURLToPath(new URL('./thumb-worker.mjs', import.meta.url));
const pool = { workers: [], idle: [], queue: [], jobs: new Map(), next: 1, timer: null };
const armIdle = () => {
  clearTimeout(pool.timer);
  pool.timer = setTimeout(() => { if (!pool.jobs.size && !pool.queue.length) closeThumbs(); }, 2500);
  pool.timer.unref?.();
};

function spawn() {
  const worker = new Worker(workerFile);
  worker.unref();
  worker.on('message', (m) => {
    const job = pool.jobs.get(m.id);
    pool.jobs.delete(m.id);
    pool.idle.push(worker);
    if (job) (m.error ? job.reject(new Error(m.error)) : job.resolve(Buffer.from(m.bytes)));
    pump();
    armIdle();
  });
  worker.on('error', (e) => {
    for (const [id, job] of pool.jobs) if (job.worker === worker) { pool.jobs.delete(id); job.reject(e); }
    pool.workers = pool.workers.filter((w) => w !== worker);
    pool.idle = pool.idle.filter((w) => w !== worker);
    pump();
  });
  pool.workers.push(worker);
  return worker;
}
function pump() {
  while (pool.queue.length) {
    const worker = pool.idle.pop() ?? (pool.workers.length < 2 ? spawn() : null);
    if (!worker) return;
    const job = pool.queue.shift();
    job.worker = worker;
    pool.jobs.set(job.id, job);
    worker.postMessage({ id: job.id, file: job.file, w: job.w });
  }
}
const shrinkInWorker = (file, w) => new Promise((resolveJob, reject) => { pool.queue.push({ id: pool.next++, file, w, resolve: resolveJob, reject }); pump(); });

export async function closeThumbs() {
  const all = pool.workers;
  pool.workers = []; pool.idle = [];
  await Promise.all(all.map((w) => w.terminate().catch(() => {})));
}

const inflight = new Map();

/**
 * @returns {Promise<{type:string, etag:string, bytes?:Buffer, file?:string}>}
 *   `bytes` is a resized PNG; `file` means "send this file as it is".
 */
export async function thumbnail(abs, widthWanted) {
  const w = snapWidth(widthWanted);
  const st = statSync(abs);
  const ext = extname(abs).toLowerCase();
  const key = createHash('sha1').update(`${abs}|${st.mtimeMs}|${st.size}|${w}`).digest('hex');
  const etag = `"${key.slice(0, 20)}"`;
  if (ext !== '.png') return { type: TYPES[ext], etag, file: abs };
  if (pngWidth(abs) <= w) return { type: 'image/png', etag, file: abs };
  const cached = join(CACHE_DIR, `${key}.png`);
  if (existsSync(cached)) return { type: 'image/png', etag, bytes: readFileSync(cached) };
  if (!inflight.has(key)) {
    inflight.set(key, shrinkInWorker(abs, w).then((bytes) => {
      mkdirSync(CACHE_DIR, { recursive: true });
      const tmp = `${cached}.${process.pid}.tmp`;
      writeFileSync(tmp, bytes);
      renameSync(tmp, cached);
      return bytes;
    }).finally(() => inflight.delete(key)));
  }
  return { type: 'image/png', etag, bytes: await inflight.get(key) };
}

/** Write a thumbnail answer to an HTTP response (handles If-None-Match). */
export function sendThumbnail(req, res, t) {
  const headers = { 'content-type': t.type, etag: t.etag, 'cache-control': 'private, max-age=60', 'x-content-type-options': 'nosniff' };
  if (req.headers['if-none-match'] === t.etag) { res.writeHead(304, headers); return res.end(); }
  if (t.bytes) {
    res.writeHead(200, { ...headers, 'content-length': t.bytes.length });
    return req.method === 'HEAD' ? res.end() : res.end(t.bytes);
  }
  res.writeHead(200, { ...headers, 'content-length': statSync(t.file).size });
  return req.method === 'HEAD' ? res.end() : createReadStream(t.file).pipe(res);
}
