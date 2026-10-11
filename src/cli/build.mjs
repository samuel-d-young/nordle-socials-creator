// node nordle.mjs build <project folder> <spec.json> [--no-critique] [--sheet] [--json]
// Turns a post spec (see src/shared/build-spec.mjs) into a document in the project, validates it, renders a contact sheet
// and grades the design. Run it again after changing the spec; it overwrites the same document.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ROOT, readJson, validateDocData } from '../../tools/validate.mjs';
import { buildDocFromSpec, SpecError } from '../shared/build-spec.mjs';
import { linkDoc } from '../calendar/service.mjs';

const atomic = (file, text) => { mkdirSync(dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, text); renameSync(tmp, file); };

export default {
  name: 'build',
  usage: 'build <project> <spec.json> [--sheet]',
  summary: 'turn a post spec into a finished document, then check it',
  async run(args) {
    const flags = new Set(args.filter((a) => a.startsWith('--')));
    const [projectArg, specArg] = args.filter((a) => !a.startsWith('--'));
    if (!projectArg || !specArg) { console.error('Usage: node nordle.mjs build <project folder> <spec.json> [--sheet] [--no-critique] [--json]'); return 2; }
    const projectDir = resolve(projectArg);
    const brandFile = join(projectDir, 'brand.json');
    if (!existsSync(brandFile)) { console.error(`${projectDir} is not a Nordle project (no brand.json).`); return 2; }
    const brand = readJson(brandFile);
    const platforms = readJson(join(ROOT, 'data', 'platforms.json'));
    const spec = readJson(resolve(specArg));

    let built;
    try { built = buildDocFromSpec(spec, { brand, platforms }); } catch (e) {
      if (e instanceof SpecError) { console.error(`SPEC ERROR: ${e.message}`); return 2; }
      throw e;
    }
    const { doc, notes } = built;
    const bad = validateDocData(doc, { brand, projectDir, platforms, assets: true }).filter((i) => i.level === 'error');
    if (bad.length) {
      console.log(`FAIL ${doc.id}: the document is not valid`);
      for (const b of bad) console.log(`     ${b.path}: ${b.message}`);
      return 1;
    }
    const file = join(projectDir, 'docs', `${doc.id}.json`);
    atomic(file, `${JSON.stringify(doc, null, 2)}\n`);
    console.log(`WROTE ${file}`);
    for (const n of notes) console.log(`     note ${n}`);

    // link the calendar item, when the brief names one (the calendar service owns the status rules and its lock)
    const itemId = doc.brief?.calendarItem;
    if (itemId && existsSync(join(projectDir, 'calendar.json'))) {
      try { linkDoc(projectDir, itemId, doc.id); console.log(`     calendar item ${itemId} -> built`); } catch (e) { console.log(`     warn calendar: ${e.message}`); }
    }
    if (flags.has('--no-critique')) return 0;

    const { openBrowser } = await import('../render/browser.mjs');
    const { critiqueDocument } = await import('../render/critique.mjs');
    const { renderSheet } = await import('../render/sheet.mjs');
    const browser = await openBrowser();
    try {
      const r = await critiqueDocument(file, { browser });
      if (flags.has('--json')) { const { ctx, outputs, ...slim } = r; void ctx; void outputs; console.log(JSON.stringify(slim, null, 2)); } else {
        console.log(`${r.verdict === 'good' ? 'GOOD' : 'NEEDS WORK'} ${r.id}: design score ${r.score}/100 (pass mark ${r.passScore}), ${r.counts.error} error(s), ${r.counts.warn} warning(s), ${r.counts.info} suggestion(s)`);
        for (const i of r.issues) {
          const where = [i.page, i.layer].filter(Boolean).join(' / ');
          console.log(`     ${i.level === 'error' ? 'error' : i.level === 'warn' ? 'warn ' : 'info '} ${i.rule}${where ? ` ${where}` : ''}: ${i.message}`);
          if (i.fix) console.log(`           fix: ${i.fix}`);
        }
      }
      if (r.outputs?.length) {
        // pages that no longer exist must not linger as pictures of an older version of the post
        try {
          const keep = new Set(r.outputs.map((o) => resolve(o.path)));
          const outDir = join(projectDir, 'out', doc.id);
          for (const f of existsSync(outDir) ? readdirSync(outDir) : []) {
            if (f.startsWith(`${doc.id}_`) && /\.(png|jpg)$/.test(f) && !keep.has(resolve(join(outDir, f)))) rmSync(join(outDir, f), { force: true });
          }
        } catch { /* leftovers are harmless */ }
        const first = r.outputs[0].size;
        const sheet = await renderSheet({ browser, projectDir, docId: doc.id, title: doc.title, outputs: r.outputs.filter((o) => o.size === first), outDir: join(projectDir, 'out', doc.id) });
        console.log(`SHEET ${sheet}`);
      }
      return r.counts.error ? 1 : 0;
    } finally { await browser.close(); }
  },
};
void readFileSync;
