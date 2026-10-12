// Brand routes (root scope, /api/brand/...): each brand's simple style guide, drafting one from existing material, and adding a brand.
//   GET  /api/brand/guide?project=<id>                 -> { guide }                       the guide as the Studio shows it
//   POST /api/brand/guide   (owner) { project, patch } -> { ok, guide }                   change name / colours / fonts / voice / links; checked against the brand schema
//   POST /api/brand/scan    (owner) { name?, website?, instagram?, folder? | folders? (up to 8), captions?, bio? }
//                                                      -> { draft, found:[text], problems:[text], hashtags, palette }   reads a local folder and web pages; saves nothing
//   POST /api/brand/logo/upload?project=&variant=primary|black|white|icon|wordmark (owner, octet-stream) -> { ok, guide };  POST /api/brand/logo/derive { project, to:'black'|'white', from? };  POST /api/brand/logo/remove { project, variant }
//   POST /api/brand/read-screenshots (owner) { uploadSession, files:[names] } -> { ok, shot:{ colors:[{hex,name?}], fonts:{heading,subheading,body}, tone, brandName, logoSeen, notes }, note? }   a screenshot of a brand page (a Canva Brand Kit), read by Claude; send `shot` back to /scan
//   POST /api/brand/pick-folder (owner) { title? } -> { ok, path } | { ok, cancelled: true } | { ok: false, unavailable: true, message }   opens the system's folder window on this computer
//   POST /api/brand/upload  (owner) octet-stream, x-filename + x-upload-session -> { ok, name, size }   stages a file for the wizard (style guide, logo, fonts, photos)
//   POST /api/brand/create  (owner) { name, guide?, timezone? } -> { ok, id }              makes the project (brand.json + folders); guide = the reviewed draft
// Claude's token may read a guide; changing one, scanning and creating are the owner's.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { GuideError, brandFile, newBrand, saveGuide, toGuide, readBrand } from '../../brand/guide.mjs';
import { MAX_UPLOADS, scanBrand } from '../../brand/scan.mjs';
import { slug } from '../store.mjs';
import { PickerError, pickFolder } from '../folder-picker.mjs';
import { SHOT_EXT, cleanShot, readBrandScreenshots } from '../../brand/screenshot.mjs';
import { LOGO_MAX_BYTES, LOGO_VARIANTS, deriveLogo, removeLogo, saveLogo } from '../../brand/logos.mjs';

const validZone = (z) => { try { new Intl.DateTimeFormat('en-AU', { timeZone: z }); return true; } catch { return false; } };


// Files the person adds while setting up a brand (a style guide, a logo, fonts, photos) wait in a staging folder in the system's temp folder,
// one folder per wizard session, until the brand is made (then they are copied into the brand's assets/brand/) or they are forgotten after a day.
const UP_ROOT = join(tmpdir(), 'nordle-brand-uploads');
const UP_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.ttf', '.otf', '.woff', '.woff2', '.md', '.markdown', '.txt', '.css', '.html', '.htm', '.json', '.pdf', '.doc', '.docx', '.pages', '.key', '.pptx']);
const UP_TOTAL = 150 * 1024 * 1024;
const sessionDir = (id) => (/^[a-f0-9]{8,32}$/.test(String(id ?? '')) ? join(UP_ROOT, String(id)) : null);
const safeName = (n) => basename(String(n ?? '')).replace(/[^\p{L}\p{N}._ ()+-]/gu, '_').replace(/^\.+/, '').slice(0, 120);

function sweepStaging(now = Date.now()) {
  try { for (const d of readdirSync(UP_ROOT)) { const p = join(UP_ROOT, d); if (now - statSync(p).mtimeMs > 24 * 3600 * 1000) rmSync(p, { recursive: true, force: true }); } } catch { /* nothing staged yet */ }
}

/** Absolute paths of the staged files the person still wants (names checked against the folder, never trusted as paths). */
function stagedFiles(session, names) {
  const dir = sessionDir(session);
  if (!dir || !Array.isArray(names)) return [];
  return [...new Set(names.map(safeName))].filter(Boolean).map((n) => join(dir, n)).filter((f) => existsSync(f) && statSync(f).isFile()).slice(0, MAX_UPLOADS);
}

function writeAtomic(file, text) {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

export default {
  scope: 'root',
  key: 'brand',
  async handle(ctx) {
    const { seg, method, url, req, res, store, sendJson, readJsonBody, readBody, need, needHuman, pickFolder: pick, HttpError, brandReader } = ctx;
    const sub = seg[1];
    try {
      if (sub === 'guide') {
        if (method === 'GET') {
          const project = store.project(url.searchParams.get('project') ?? '');
          need(project, 404, 'No such brand.');
          return sendJson(res, 200, { guide: toGuide(readBrand(project.dir)) });
        }
        need(method === 'POST', 405, 'GET or POST only.');
        needHuman();
        const b = await readJsonBody(req);
        const project = store.project(String(b.project ?? ''));
        need(project, 404, 'No such brand.');
        return sendJson(res, 200, { ok: true, guide: saveGuide(project.dir, b.patch ?? {}) });
      }
      if (sub === 'scan') {
        need(method === 'POST', 405, 'POST only.');
        needHuman();
        const b = await readJsonBody(req);
        const { uploads: _ignored, logoPaths: _lp, files, uploadSession, logoFiles, shot, ...rest } = b;
        return sendJson(res, 200, { ok: true, ...(await scanBrand({ ...rest, uploads: stagedFiles(uploadSession, files), logoPaths: stagedFiles(uploadSession, logoFiles && typeof logoFiles === 'object' ? Object.values(logoFiles) : []), shot: cleanShot(shot) })) });
      }
      if (sub === 'upload') {
        need(method === 'POST', 405, 'POST only.');
        needHuman();
        need(String(req.headers['content-type'] ?? '').split(';')[0].trim() === 'application/octet-stream', 415, 'Upload the file as application/octet-stream.');
        const dir = sessionDir(req.headers['x-upload-session']);
        need(dir, 400, 'Missing upload session.');
        let raw = '';
        try { raw = decodeURIComponent(String(req.headers['x-filename'] ?? '')); } catch { raw = ''; }
        const name = safeName(raw);
        need(name && UP_EXT.has(extname(name).toLowerCase()), 415, 'That kind of file cannot be used for a brand. Add pictures (PNG, JPG, WebP, GIF, SVG), fonts, or a written style guide (MD, TXT, CSS, HTML, JSON, PDF).');
        const buf = await readBody(req, 20 * 1024 * 1024);
        need(buf.length > 0, 400, 'That file is empty.');
        sweepStaging();
        mkdirSync(dir, { recursive: true });
        const have = readdirSync(dir).map((n) => ({ n, size: statSync(join(dir, n)).size }));
        need(have.length < MAX_UPLOADS, 413, `Up to ${MAX_UPLOADS} files for one brand. Remove some, or add a folder instead.`);
        need(have.reduce((t, f) => t + f.size, 0) + buf.length <= UP_TOTAL, 413, 'That is more than 150 MB of files for one brand. Add the big ones as a folder instead.');
        const base = name.slice(0, name.length - extname(name).length);
        let final = name;
        for (let i = 2; existsSync(join(dir, final)); i++) final = `${base}-${i}${extname(name)}`;
        writeAtomic(join(dir, final), buf);
        return sendJson(res, 201, { ok: true, name: final, size: buf.length });
      }
      if (sub === 'read-screenshots') {
        need(method === 'POST', 405, 'POST only.');
        needHuman();
        const b = await readJsonBody(req);
        const files = stagedFiles(b.uploadSession, Array.isArray(b.files) ? b.files.filter((f) => SHOT_EXT.test(String(f))) : []);
        need(files.length, 400, 'Add at least one screenshot first (PNG, JPG or WebP).');
        const r = await readBrandScreenshots(files, { reader: brandReader ?? undefined });
        return sendJson(res, 200, { ok: true, ...r });
      }
      if (sub === 'logo') {
        need(method === 'POST', 405, 'POST only.');
        needHuman();
        const action = seg[2];
        if (action === 'upload') {
          const project = store.project(url.searchParams.get('project') ?? '');
          need(project, 404, 'No such brand.');
          need(String(req.headers['content-type'] ?? '').split(';')[0].trim() === 'application/octet-stream', 415, 'Upload the file as application/octet-stream.');
          let raw = '';
          try { raw = decodeURIComponent(String(req.headers['x-filename'] ?? '')); } catch { raw = ''; }
          const buf = await readBody(req, LOGO_MAX_BYTES + 1024);
          return sendJson(res, 201, { ok: true, guide: saveLogo(project.dir, String(url.searchParams.get('variant') ?? ''), basename(raw), buf) });
        }
        const b = await readJsonBody(req);
        const project = store.project(String(b.project ?? ''));
        need(project, 404, 'No such brand.');
        if (action === 'derive') return sendJson(res, 200, { ok: true, guide: deriveLogo(project.dir, String(b.to ?? ''), typeof b.from === 'string' ? b.from : 'primary') });
        if (action === 'remove') return sendJson(res, 200, { ok: true, guide: removeLogo(project.dir, String(b.variant ?? '')) });
        throw new HttpError(404, 'Unknown logo action.');
      }
      if (sub === 'pick-folder') {
        need(method === 'POST', 405, 'POST only.');
        needHuman();
        const b = await readJsonBody(req);
        try {
          const r = await (pick ?? pickFolder)({ title: typeof b.title === 'string' && b.title.trim() ? b.title.trim() : 'Choose a folder' });
          return sendJson(res, 200, { ok: true, ...r });
        } catch (e) {
          if (e instanceof PickerError) return sendJson(res, 200, { ok: false, unavailable: true, message: e.message });
          throw e;
        }
      }
      if (sub === 'create') {
        need(method === 'POST', 405, 'POST only.');
        needHuman();
        const b = await readJsonBody(req);
        const name = String(b.name ?? b.guide?.name ?? '').trim();
        need(name, 400, 'Give the brand a name.');
        const zone = String(b.timezone ?? 'Australia/Melbourne');
        need(validZone(zone), 400, `"${zone}" is not a timezone. Use a name like Australia/Melbourne.`);
        const taken = (c) => existsSync(join(store.createIn, c));
        let id = slug(name, 'brand');
        for (let n = 2; taken(id); n++) id = `${slug(name, 'brand').slice(0, 56)}-${n}`;
        const brand = newBrand(id, { ...(b.guide ?? {}), name });
        const dir = join(store.createIn, id);
        mkdirSync(join(dir, 'docs'), { recursive: true });
        mkdirSync(join(dir, 'assets'), { recursive: true });
        writeAtomic(brandFile(dir), `${JSON.stringify(brand, null, 2)}\n`);
        writeAtomic(join(dir, 'nordle.project.json'), `${JSON.stringify({ timezone: zone }, null, 2)}\n`);
        // files added during set-up (a style guide, a logo, fonts) stay with the brand
        // logos chosen in the wizard ({ primary: 'logo.png', white: 'logo-white.svg' }): each is saved as its kind
        for (const [variant, staged] of Object.entries(b.logoFiles && typeof b.logoFiles === 'object' ? b.logoFiles : {})) {
          const [file] = stagedFiles(b.uploadSession, [staged]);
          if (file) { try { saveLogo(dir, variant, basename(file), readFileSync(file)); } catch { /* a logo that is not usable is left out; the brand is still made */ } }
        }
        const keep = stagedFiles(b.uploadSession, b.files);
        if (keep.length) {
          mkdirSync(join(dir, 'assets', 'brand'), { recursive: true });
          for (const f of keep) copyFileSync(f, join(dir, 'assets', 'brand', basename(f)));
          rmSync(sessionDir(b.uploadSession), { recursive: true, force: true });
        }
        return sendJson(res, 201, { ok: true, id });
      }
    } catch (e) {
      if (e instanceof GuideError) return sendJson(res, e.status, { ok: false, errors: e.errors });
      throw e;
    }
    return false;
  },
};
