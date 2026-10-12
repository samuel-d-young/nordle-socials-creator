// The local web server: the editor page, project files, and the JSON API the editor (and later Claude) use.
// Security: listens on 127.0.0.1 only; answers only to localhost host names (stops DNS rebinding); every /api call needs
// a token that only the served page knows; sends no CORS headers; writes must be JSON (or a named upload); bodies are capped.

import http from 'node:http';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep, basename, relative } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { applyOps } from '../shared/ops.mjs';
import { ROOT } from '../../tools/validate.mjs';
import { Store, newId, slug, writeAtomic } from './store.mjs';
import { BrowserPool } from './browserpool.mjs';
import { reviewMarkdown } from './handoff.mjs';
import { resolveSizes } from '../render/context.mjs';
import { renderDocument } from '../render/render.mjs';
import { verifyDocument } from '../render/verify.mjs';
import { critiqueDocument } from '../render/critique.mjs';
import { renderSheet } from '../render/sheet.mjs';
import { createAutoRender } from './autorender.mjs';
import { ROUTES } from './routes/index.mjs';

const JSON_LIMIT = 1024 * 1024;
const UPLOAD_LIMIT = 20 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.txt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
};
const PROJECT_FILE_TYPES = new Set(['.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.webm', '.mov', '.wav', '.mp3', '.m4a', '.json', '.woff2', '.woff', '.ttf', '.otf']);
const HIDDEN_DIRS = new Set(['history', 'review', 'checks']);
const PROXY_FILE = /^\.proxies\/[0-9a-f]{40}\.mp4$/;

const PAGE_CSP = "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
const FILE_CSP = "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'";

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(text);
}

function readBody(req, limit) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'That request is too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim();
  if (type !== 'application/json') throw new HttpError(415, 'Send JSON (Content-Type: application/json).');
  const buf = await readBody(req, JSON_LIMIT);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw new HttpError(400, 'That is not valid JSON.'); }
}

/** Serve a file from inside `base` only (symlinks included). */
function sendFile(req, res, base, rel, { csp, types, hideDirs, dotfiles = false } = {}) {
  let decoded;
  try { decoded = decodeURIComponent(rel); } catch { throw new HttpError(400, 'Bad path.'); }
  const parts = decoded.split(/[\\/]/).filter((p) => p !== '');
  if (!parts.length || parts.some((p) => p === '..' || p.includes('\0'))) throw new HttpError(404, 'Not found.');
  if (!dotfiles && parts.some((p) => p.startsWith('.'))) throw new HttpError(404, 'Not found.');
  if (hideDirs && hideDirs.has(parts[0])) throw new HttpError(404, 'Not found.');
  const abs = resolve(base, ...parts);
  if (!abs.startsWith(base + sep)) throw new HttpError(404, 'Not found.');
  const ext = extname(abs).toLowerCase();
  if (types && !types.has(ext)) throw new HttpError(404, 'Not found.');
  let real;
  try {
    real = realpathSync(abs);
    const realBase = realpathSync(base);
    if (!real.startsWith(realBase + sep) || !statSync(real).isFile()) throw new Error('outside');
  } catch { throw new HttpError(404, 'Not found.'); }
  const stat = statSync(real);
  const headers = { 'content-type': MIME[ext] ?? 'application/octet-stream', 'content-length': stat.size, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'accept-ranges': 'bytes' };
  if (csp) headers['content-security-policy'] = csp;
  // Byte ranges, so a <video> can seek: "bytes=a-b", "bytes=a-" and "bytes=-n" (the last n bytes). Anything else is served whole.
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? '').trim());
  if (range && (range[1] !== '' || range[2] !== '') && req.method !== 'HEAD') {
    let start = range[1] === '' ? Math.max(0, stat.size - Number(range[2])) : Number(range[1]);
    let end = range[1] === '' || range[2] === '' ? stat.size - 1 : Math.min(Number(range[2]), stat.size - 1);
    if (!Number.isFinite(start) || start >= stat.size || start > end) {
      res.writeHead(416, { ...headers, 'content-length': 0, 'content-range': `bytes */${stat.size}` });
      return res.end();
    }
    end = Math.min(end, stat.size - 1);
    start = Math.max(0, start);
    res.writeHead(206, { ...headers, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${stat.size}` });
    const stream = createReadStream(real, { start, end });
    res.on('close', () => stream.destroy());
    return void stream.pipe(res);
  }
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  const stream = createReadStream(real);
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

function magicOk(ext, buf) {
  if (ext === '.png') return buf.length > 8 && buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG';
  if (ext === '.jpg' || ext === '.jpeg') return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (ext === '.gif') return buf.toString('latin1', 0, 4) === 'GIF8';
  if (ext === '.webp') return buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP';
  if (ext === '.svg') return /<svg[\s>]/i.test(buf.toString('utf8', 0, Math.min(buf.length, 4096)));
  return false;
}

/**
 * @param {{roots:string[], createIn?:string, token?:string, agentToken?:string, appDir?:string, runtimeDir?:string}} opts
 *   token is the owner's (served only to the editor page); agentToken is Claude's, written to runtimeDir for the MCP server.
 */
export function createNordleServer(opts) {
  const token = opts.token ?? randomBytes(16).toString('hex');
  const agentToken = opts.agentToken ?? randomBytes(16).toString('hex');
  const store = new Store({ roots: opts.roots, createIn: opts.createIn });
  const pool = new BrowserPool();
  const autoRender = opts.autoRender ? createAutoRender(pool, typeof opts.autoRender === 'object' ? opts.autoRender : {}) : null;   // real server only: keeps out/ pictures in step with edits
  const appDir = opts.appDir ?? join(ROOT, 'app');
  const staticRoutes = [
    { prefix: '/app/', base: appDir, types: new Set(['.js', '.mjs', '.css', '.html', '.svg', '.png']) },
    { prefix: '/src/shared/', base: join(ROOT, 'src', 'shared'), types: new Set(['.mjs']) },
    { prefix: '/src/render/', base: join(ROOT, 'src', 'render'), types: new Set(['.mjs']), only: new Set(['html.mjs']) },
    { prefix: '/fonts/', base: join(ROOT, 'fonts'), types: new Set(['.css', '.woff2', '.txt', '.json']) },
  ];
  let port = 0;

  const same = (given, want) => typeof given === 'string' && given.length === want.length && timingSafeEqual(Buffer.from(given), Buffer.from(want));
  const roleOf = (given) => (same(given, token) ? 'human' : same(given, agentToken) ? 'agent' : null);
  const runtimeFile = opts.runtimeDir ? join(opts.runtimeDir, 'runtime.json') : null;

  function indexHtml() {
    return readFileSync(join(appDir, 'index.html'), 'utf8').replace('__TOKEN__', token);
  }

  function describeDoc(project, session) {
    const review = project.review(session.id);
    return {
      projectId: project.id, doc: session.doc, v: session.v, canUndo: session.undoStack.length > 0, canRedo: session.redoStack.length > 0,
      review: review.data, rv: review.rv, autonomy: review.autonomy, brand: project.brand, sizes: resolveSizes(session.doc, project.platforms),
      assets: project.assets(),
    };
  }

  function sse(req, res, project, session) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-content-type-options': 'nosniff' });
    const review = project.review(session.id);
    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    send({ type: 'hello', v: session.v, rv: review.rv });
    session.on('change', send);
    review.on('change', send);
    const beat = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(beat); session.off('change', send); review.off('change', send); });
  }

  /**
   * role is 'human' (the editor page) or 'agent' (Claude, through the MCP server). The agent cannot undo, approve, accept or
   * reject changes, restore versions, adopt takes, change the autonomy setting, or create projects: those belong to the owner.
   */
  async function api(req, res, url, role) {
    const seg = url.pathname.split('/').filter(Boolean).slice(1).map((s) => { try { return decodeURIComponent(s); } catch { throw new HttpError(400, 'Bad path.'); } });
    const method = req.method;
    const need = (cond, status, msg) => { if (!cond) throw new HttpError(status, msg); };
    const human = role === 'human';
    const needHuman = () => need(human, 403, 'Only the owner can do this, in the editor.');
    const needAgent = () => need(!human, 403, 'This is for Claude. In the editor, comment with the pin tool.');
    const origin = req.headers['x-nordle-client'];

    if (seg[0] === 'meta' && method === 'GET') return sendJson(res, 200, { app: 'nordle', version: '0.1.0', port, role });

    // Feature modules in src/server/routes/*.mjs plug in here (see routes/index.mjs for the shape of ctx).
    const routeCtx = { req, res, url, seg, method, role, human, store, pool, origin, readJsonBody, readBody, sendJson, sendFile, HttpError, need, needHuman, needAgent, ROOT, reviser: opts.reviser ?? null, pickFolder: opts.pickFolder ?? null, claudeRunner: opts.claudeRunner ?? null, pickFiles: opts.pickFiles ?? null, brandReader: opts.brandReader ?? null, updateFetch: opts.updateFetch ?? null, updateStateDir: opts.updateStateDir ?? null, importVideos: opts.importVideos ?? null, autoScheduler: opts.autoScheduler ?? null };
    for (const r of ROUTES.filter((x) => x.scope === 'root' && x.key === seg[0])) {
      if ((await r.handle(routeCtx)) !== false) return;
    }
    if (seg[0] !== 'projects' && seg[0] !== 'events') throw new HttpError(404, 'Unknown API route.');

    if (seg[0] === 'events') {
      need(method === 'GET', 405, 'GET only.');
      const project = store.project(url.searchParams.get('project') ?? '');
      const session = project?.doc(url.searchParams.get('doc') ?? '');
      need(session, 404, 'No such document.');
      return sse(req, res, project, session);
    }

    if (seg.length === 1) {
      if (method === 'GET') return sendJson(res, 200, { projects: store.list() });
      if (method === 'POST') {
        needHuman();
        const body = await readJsonBody(req);
        need(typeof body.name === 'string' && body.name.trim(), 400, 'Give the project a name.');
        const p = store.createProject({ name: body.name });
        return sendJson(res, 201, { id: p.id });
      }
      throw new HttpError(405, 'Method not allowed.');
    }

    const project = store.project(seg[1]);
    need(project, 404, 'No such project.');

    for (const r of ROUTES.filter((x) => x.scope === 'project' && x.key === seg[2])) {
      if ((await r.handle({ ...routeCtx, project })) !== false) return;
    }

    if (seg.length === 2 && method === 'GET') {
      return sendJson(res, 200, { id: project.id, brand: project.brand, docs: project.listDocs(), assets: project.assets(), platforms: project.platforms.presets });
    }

    if (seg[2] === 'assets') {
      if (method === 'GET') return sendJson(res, 200, { assets: project.assets() });
      need(method === 'POST', 405, 'Method not allowed.');
      const type = String(req.headers['content-type'] ?? '').split(';')[0].trim();
      need(type === 'application/octet-stream', 415, 'Upload the file as application/octet-stream.');
      const rawName = decodeURIComponent(String(req.headers['x-filename'] ?? ''));
      const ext = extname(rawName).toLowerCase();
      need(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].includes(ext), 415, 'Images only: PNG, JPG, WebP, GIF or SVG.');
      const buf = await readBody(req, UPLOAD_LIMIT);
      need(magicOk(ext, buf), 415, `That does not look like a real ${ext.slice(1).toUpperCase()} file.`);
      const base = slug(basename(rawName, extname(rawName)), 'image');
      let name = `${base}${ext}`;
      for (let i = 2; existsSync(join(project.dir, 'assets', name)); i++) name = `${base}-${i}${ext}`;
      mkdirSync(join(project.dir, 'assets'), { recursive: true });
      writeAtomic(join(project.dir, 'assets', name), buf);
      return sendJson(res, 201, { path: `assets/${name}`, assets: project.assets() });
    }

    need(seg[2] === 'docs', 404, 'Unknown API route.');

    if (seg.length === 3) {
      if (method === 'GET') return sendJson(res, 200, { docs: project.listDocs() });
      need(method === 'POST', 405, 'Method not allowed.');
      const body = await readJsonBody(req);
      need(typeof body.title === 'string' && body.title.trim(), 400, 'Give the post a title.');
      let session;
      try { session = store.createDoc(project.id, body); } catch (e) { throw new HttpError(400, e.message); }
      return sendJson(res, 201, { id: session.id });
    }

    const session = project.doc(seg[3]);
    need(session, 404, 'No such document.');
    const review = project.review(session.id);

    if (seg.length === 4) {
      need(method === 'GET', 405, 'Method not allowed.');
      return sendJson(res, 200, describeDoc(project, session));
    }

    const action = seg[4];
    const result = (r, extra = {}) => {
      if (!r.ok) return sendJson(res, r.status ?? 400, { ok: false, errors: r.errors });
      const { before, after, dryRun, status, ...rest } = r; // internals stay on the server
      void before; void after; void dryRun;
      return sendJson(res, 200, { ...rest, ...(status && typeof status === 'string' ? { status } : {}), ...extra });
    };

    if (action === 'patch' && method === 'POST') {
      const b = await readJsonBody(req);
      if (!Array.isArray(b.ops)) throw new HttpError(400, 'Send {"ops": [...]} with a list of JSON Patch operations.');
      if (human && b.actor !== undefined && !['human', 'claude'].includes(b.actor)) throw new HttpError(400, 'actor must be human or claude');
      if (!human || b.actor === 'claude') return result(project.claudePatch(session.id, { ops: b.ops, baseVersion: b.baseVersion, note: b.note, origin }));
      const applied = session.apply({ ops: b.ops, actor: 'human', baseVersion: b.baseVersion, note: b.note, origin });
      autoRender?.schedule(session.file);
      return result(applied);
    }
    if (action === 'undo' && method === 'POST') { needHuman(); await readJsonBody(req); const r = session.undo('human', origin); autoRender?.schedule(session.file); return result(r); }
    if (action === 'redo' && method === 'POST') { needHuman(); await readJsonBody(req); const r = session.redo('human', origin); autoRender?.schedule(session.file); return result(r); }

    if (action === 'verify' && method === 'POST') {
      await readJsonBody(req);
      const r = await pool.use((browser) => verifyDocument(session.file, { browser }));
      return sendJson(res, 200, { id: r.id, issues: r.issues, skipped: r.skipped ?? null, files: r.outputs.map((o) => relative(project.dir, o.path).split(sep).join('/')) });
    }
    // Grade the design: the technical checks plus the design rules, with a score. Claude's way of checking its own work.
    if (action === 'critique' && method === 'POST') {
      const b = await readJsonBody(req);
      const atVersion = session.v;
      const out = await pool.use(async (browser) => {
        const r = await critiqueDocument(session.file, { browser });
        let sheet = null;
        if (b.sheet !== false && r.outputs?.length > 1) {
          const first = r.outputs[0].size;
          const path = await renderSheet({ browser, projectDir: project.dir, docId: session.id, title: session.doc.title, outputs: r.outputs.filter((o) => o.size === first), outDir: join(project.dir, 'out', session.id) });
          sheet = { mime: 'image/png', base64: readFileSync(path).toString('base64'), size: first };
        }
        return { r, sheet };
      });
      const { r, sheet } = out;
      session.lastCritique = { v: atVersion, errors: r.counts?.error ?? 0, score: r.score, verdict: r.verdict, at: Date.now() };
      return sendJson(res, 200, { id: r.id, version: atVersion, score: r.score, verdict: r.verdict, passScore: r.passScore, counts: r.counts, issues: r.issues, pages: r.pages, sizes: r.sizes, skipped: r.skipped ?? null, sheet });
    }
    if (action === 'export' && method === 'POST') {
      const b = await readJsonBody(req);
      const format = b.format === 'jpg' ? 'jpg' : 'png';
      const scale = [1, 2].includes(b.scale) ? b.scale : 1;
      autoRender?.cancel(session.file);
      const r = await pool.use((browser) => renderDocument(session.file, { browser, sizes: b.sizes, pages: b.pages, format, scale, sheet: true }));
      need(!r.errors.length, 422, `The document has errors: ${r.errors.map((e) => e.message).join('; ')}`);
      const rel = (p) => relative(project.dir, p).split(sep).join('/');
      return sendJson(res, 200, { files: r.outputs.map((o) => ({ path: rel(o.path), size: o.size, page: o.page, w: o.w, h: o.h })), sheet: r.sheet ? rel(r.sheet) : null, warnings: r.warnings });
    }

    // One page at one size as a picture, so Claude can see what it is editing. A pending suggestion can be previewed too.
    if (action === 'render' && method === 'POST') {
      const b = await readJsonBody(req);
      const sizeId = b.size ?? resolveSizes(session.doc, project.platforms)[0].id;
      const pageId = b.page ?? session.doc.pages?.[0]?.id;
      let doc;
      if (b.change) {
        const ch = (review.data.changes ?? []).find((c) => c.id === b.change);
        need(ch, 404, 'No such change.');
        need(ch.mode === 'proposed' && ch.status === 'pending', 409, 'Only a pending suggestion can be previewed.');
        try { doc = applyOps(session.doc, ch.ops).doc; } catch { throw new HttpError(409, 'That suggestion no longer fits the post.'); }
      }
      const format = b.format === 'png' ? 'png' : 'jpg';
      const out = mkdtempSync(join(tmpdir(), 'nordle-still-'));
      try {
        let r;
        try {
          r = await pool.use((browser) => renderDocument(session.file, { browser, sizes: [sizeId], pages: [pageId], format, scale: [0.5, 1, 2].includes(b.scale) ? b.scale : 1, out, doc }));
        } catch (e) { throw new HttpError(400, e.message); }
        need(!r.errors.length, 422, `The document has errors: ${r.errors.map((e) => e.message).join('; ')}`);
        const o = r.outputs[0];
        return sendJson(res, 200, { mime: format === 'png' ? 'image/png' : 'image/jpeg', base64: readFileSync(o.path).toString('base64'), w: o.w, h: o.h, page: pageId, size: sizeId, warnings: r.warnings });
      } finally { rmSync(out, { recursive: true, force: true }); }
    }

    if (action === 'explore') {
      const sub = seg[5];
      if (!sub && method === 'GET') return sendJson(res, 200, { takes: project.takesOf(session.id) });
      if (!sub && method === 'POST') {
        const b = await readJsonBody(req);
        let made;
        try { made = project.createTakes(session.id, { count: b.count, labels: Array.isArray(b.labels) ? b.labels.map(String) : [], note: typeof b.note === 'string' ? b.note : undefined }); } catch (e) { throw new HttpError(400, e.message); }
        return sendJson(res, 201, { takes: made });
      }
      if (!sub && method === 'DELETE') { needHuman(); return sendJson(res, 200, { discarded: project.discardTakes(session.id) }); }
      if (sub && seg[6] === 'adopt' && method === 'POST') { needHuman(); await readJsonBody(req); return result(project.adoptTake(session.id, sub, origin)); }
    }

    if (action === 'review') {
      const sub = seg[5];
      if (!sub && method === 'GET') return sendJson(res, 200, { ...review.snapshot(), autonomy: review.autonomy });
      if (sub === 'patch' && method === 'POST') { needHuman(); const b = await readJsonBody(req); return result(review.apply({ ops: b.ops, actor: 'human' })); }

      // Claude's way to talk back
      if (sub === 'comment' && method === 'POST') { needAgent(); const b = await readJsonBody(req); return result(review.agentComment(b)); }
      if (sub === 'reply' && method === 'POST') { needAgent(); const b = await readJsonBody(req); return result(review.agentReply(b.comment, b.text)); }
      if (sub === 'resolve' && method === 'POST') { needAgent(); const b = await readJsonBody(req); return result(review.agentResolve(b.comment)); }

      if (sub === 'settings' && method === 'POST') { needHuman(); const b = await readJsonBody(req); return result(review.setAutonomy(b.autonomy)); }
      if (sub === 'changes' && seg[6] && ['accept-all', 'reject-all'].includes(seg[6]) && method === 'POST') {
        needHuman(); await readJsonBody(req);
        return result(review.decideAll(seg[6] === 'accept-all' ? 'accept' : 'reject', { origin }));
      }
      if (sub === 'changes' && seg[6] && ['accept', 'reject'].includes(seg[7]) && method === 'POST') {
        needHuman(); await readJsonBody(req);
        return result(review.decide(seg[6], seg[7], { origin }));
      }

      if (sub === 'versions' && !seg[6] && method === 'POST') { const b = await readJsonBody(req); return result(review.saveVersion({ name: b.name, note: b.note, author: human ? 'human' : 'claude' })); }
      if (sub === 'versions' && seg[7] === 'restore' && method === 'POST') {
        needHuman();
        await readJsonBody(req);
        const ops = review.restoreOps(seg[6]);
        need(ops, 404, 'No such version.');
        const name = review.data.versions.find((x) => x.id === seg[6])?.name ?? seg[6];
        return result(session.apply({ ops, actor: 'human', note: `Restored ${name}`, origin }));
      }
      if (sub === 'versions' && seg[7] === 'doc' && method === 'GET') {
        const snap = review.readVersion(seg[6]);
        need(snap, 404, 'No such version.');
        return sendJson(res, 200, { doc: snap });
      }
      if (sub === 'approve' && method === 'POST') { needHuman(); const b = await readJsonBody(req); return result(review.approve({ by: 'human', note: b.note })); }
      if (sub === 'approve' && method === 'DELETE') { needHuman(); return result(review.revokeApproval()); }
      if (sub === 'handoff' && method === 'GET') {
        const text = reviewMarkdown({ projectId: project.id, doc: session.doc, v: session.v, review: review.data });
        return sendJson(res, 200, { text });
      }
    }
    throw new HttpError(404, 'Unknown API route.');
  }

  const server = http.createServer(async (req, res) => {
    try {
      const hostOk = new RegExp(`^(127\\.0\\.0\\.1|localhost|\\[::1\\]):${port}$`).test(String(req.headers.host ?? ''));
      if (!hostOk) throw new HttpError(403, 'Unknown host name.');
      if (!['GET', 'HEAD', 'POST', 'DELETE', 'PATCH'].includes(req.method)) throw new HttpError(405, 'Method not allowed.');
      const url = new URL(req.url, `http://127.0.0.1:${port}`);

      if (url.pathname.startsWith('/api/')) {
        const given = req.headers['x-nordle-token'] ?? (req.method === 'GET' ? url.searchParams.get('t') : undefined);
        const role = roleOf(given);
        if (!role) throw new HttpError(401, 'Missing or wrong token. Open Nordle from its own address.');
        return await api(req, res, url, role);
      }
      if (req.method === 'POST' || req.method === 'DELETE' || req.method === 'PATCH') throw new HttpError(404, 'Not found.');

      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store', 'content-security-policy': PAGE_CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
        return res.end(indexHtml());
      }
      for (const r of staticRoutes) {
        if (!url.pathname.startsWith(r.prefix)) continue;
        const rel = url.pathname.slice(r.prefix.length);
        if (r.only && !r.only.has(rel)) throw new HttpError(404, 'Not found.');
        return sendFile(req, res, r.base, rel, { types: r.types, csp: url.pathname.endsWith('.html') ? PAGE_CSP : undefined });
      }
      const m = /^\/p\/([^/]+)\/(.+)$/.exec(url.pathname);
      if (m) {
        const project = store.project(decodeURIComponent(m[1]));
        if (!project) throw new HttpError(404, 'Not found.');
        // Browser-playable copies of footage (src/video/proxy.mjs) live in the dot-folder .proxies. Dot-folders are never
        // served, so this one name pattern is the only way in: <40 hex digits>.mp4 straight inside .proxies (not the notes,
        // waveforms or unfinished files beside them, and nothing from any other folder).
        let wanted;
        try { wanted = decodeURIComponent(m[2]); } catch { throw new HttpError(400, 'Bad path.'); }
        if (wanted.startsWith('.proxies/') || wanted.startsWith('.proxies\\')) {
          if (!PROXY_FILE.test(wanted)) throw new HttpError(404, 'Not found.');
          return sendFile(req, res, join(project.dir, '.proxies'), wanted.slice('.proxies/'.length), { types: new Set(['.mp4']), csp: FILE_CSP });
        }
        return sendFile(req, res, project.dir, m[2], { types: PROJECT_FILE_TYPES, hideDirs: HIDDEN_DIRS, csp: FILE_CSP });
      }
      throw new HttpError(404, 'Not found.');
    } catch (e) {
      if (res.headersSent) { res.end(); return; }
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      sendJson(res, status, { ok: false, errors: [{ path: '/', message: status === 500 ? 'Something went wrong on the server.' : e.message }] });
    }
  });

  return {
    store, token, agentToken, server, pool,
    listen(wantedPort = 0) {
      return new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(wantedPort, '127.0.0.1', () => {
          port = server.address().port;
          if (runtimeFile) {
            // Claude's token goes here, for the MCP server. The owner's token is never written anywhere.
            mkdirSync(opts.runtimeDir, { recursive: true });
            writeAtomic(runtimeFile, `${JSON.stringify({ port, agentToken, pid: process.pid, started: new Date().toISOString(), version: '0.1.0' }, null, 2)}
`);
          }
          resolveListen(port);
        });
      });
    },
    async close() {
      if (runtimeFile) { try { unlinkSync(runtimeFile); } catch { /* already gone */ } }
      await pool.close();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    },
  };
}

export { newId };
