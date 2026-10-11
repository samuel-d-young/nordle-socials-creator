// Brand routes (root scope, /api/brand/...): each brand's simple style guide, drafting one from existing material, and adding a brand.
//   GET  /api/brand/guide?project=<id>                 -> { guide }                       the guide as the Studio shows it
//   POST /api/brand/guide   (owner) { project, patch } -> { ok, guide }                   change name / colours / fonts / voice / links; checked against the brand schema
//   POST /api/brand/scan    (owner) { name?, website?, instagram?, folder?, captions?, bio? }
//                                                      -> { draft, found:[text], problems:[text], hashtags, palette }   reads a local folder and web pages; saves nothing
//   POST /api/brand/create  (owner) { name, guide?, timezone? } -> { ok, id }              makes the project (brand.json + folders); guide = the reviewed draft
// Claude's token may read a guide; changing one, scanning and creating are the owner's.

import { existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { GuideError, brandFile, newBrand, saveGuide, toGuide, readBrand } from '../../brand/guide.mjs';
import { scanBrand } from '../../brand/scan.mjs';
import { slug } from '../store.mjs';

const validZone = (z) => { try { new Intl.DateTimeFormat('en-AU', { timeZone: z }); return true; } catch { return false; } };

function writeAtomic(file, text) {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

export default {
  scope: 'root',
  key: 'brand',
  async handle(ctx) {
    const { seg, method, url, req, res, store, sendJson, readJsonBody, need, needHuman } = ctx;
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
        return sendJson(res, 200, { ok: true, ...(await scanBrand(b)) });
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
        return sendJson(res, 201, { ok: true, id });
      }
    } catch (e) {
      if (e instanceof GuideError) return sendJson(res, e.status, { ok: false, errors: e.errors });
      throw e;
    }
    return false;
  },
};
