// node nordle.mjs reel <project folder> <reel spec.json> [--sheet] [--stills 1.5,6] [--render] [--preview]
// Turns a reel spec (see src/shared/reel-spec.mjs) into a video document, checks the cut, and (on request) draws a contact
// sheet of frames, single frames, or the finished mp4. Run it again after changing the spec: it overwrites the same document.

import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ROOT, readJson } from '../../tools/validate.mjs';
import { buildReelDoc, ReelSpecError } from '../shared/reel-spec.mjs';
import { linkDoc } from '../calendar/service.mjs';

const atomic = (file, text) => { mkdirSync(dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, text); renameSync(tmp, file); };

export default {
  name: 'reel',
  usage: 'reel <project> <spec.json> [--sheet] [--stills a,b] [--render]',
  summary: 'turn a reel spec into a video post, then check the cut and look at it',
  async run(args) {
    const flags = new Map();
    const rest = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i].startsWith('--')) { const k = args[i].slice(2); flags.set(k, ['stills', 'size'].includes(k) ? args[++i] : true); } else rest.push(args[i]);
    }
    const [projectArg, specArg] = rest;
    if (!projectArg || !specArg) { console.error('Usage: node nordle.mjs reel <project folder> <spec.json> [--sheet] [--stills 1.5,6] [--render] [--preview]'); return 2; }
    const projectDir = resolve(projectArg);
    if (!existsSync(join(projectDir, 'brand.json'))) { console.error(`${projectDir} is not a Nordle project (no brand.json).`); return 2; }
    const brand = readJson(join(projectDir, 'brand.json'));
    const platforms = readJson(join(ROOT, 'data', 'platforms.json'));
    const spec = readJson(resolve(specArg));

    let built;
    try { built = buildReelDoc(spec, { brand, platforms }); } catch (e) {
      if (e instanceof ReelSpecError) { console.error(`SPEC ERROR: ${e.message}`); return 2; }
      throw e;
    }
    const { doc, notes } = built;
    const file = join(projectDir, 'docs', `${doc.id}.json`);
    atomic(file, `${JSON.stringify(doc, null, 2)}\n`);
    console.log(`WROTE ${file}  (${doc.timeline.duration} s, ${doc.timeline.scenes.length} scenes)`);
    for (const n of notes) console.log(`     note ${n}`);

    const itemId = doc.brief?.calendarItem;
    if (itemId && existsSync(join(projectDir, 'calendar.json'))) {
      try { linkDoc(projectDir, itemId, doc.id); console.log(`     calendar item ${itemId} -> built`); } catch (e) { console.log(`     warn calendar: ${e.message}`); }
    }

    const { loadDocContext } = await import('../render/context.mjs');
    const c = loadDocContext(file);
    if (c.errors.length) {
      console.log(`FAIL ${doc.id}: the document has errors`);
      for (const e of c.errors) console.log(`     ${e.path}: ${e.message}`);
      return 1;
    }
    const { buildPlan, summarisePlan } = await import('../video/plan.mjs');
    const plan = await buildPlan({ doc: c.doc, brand: c.brand, projectDir: c.projectDir, platforms: c.platforms });
    const s = summarisePlan(plan);
    console.log(`${plan.blocking.length ? 'FAIL' : 'OK  '} cut: ${s.size}, ${s.seconds}s, ${s.segments.length} pieces of picture`);
    for (const i of s.issues) console.log(`     ${i.level === 'error' ? 'error' : i.level === 'warn' ? 'warn ' : 'info '} ${i.code}: ${i.message}`);
    let code = plan.blocking.length || s.issues.some((i) => i.level === 'error') ? 1 : 0;

    const common = { preview: !!flags.get('preview') };
    if (flags.get('sheet')) {
      const { videoSheet } = await import('../video/render.mjs');
      const r = await videoSheet(file, common);
      if (r.ok) { console.log(`SHEET ${r.sheet}`); for (const sc of r.scenes) console.log(`     ${sc.title} ${sc.start.toFixed(1)}-${sc.end.toFixed(1)}s${sc.speech ? `  says: "${sc.speech}"` : ''}`); } else { console.log('FAIL sheet'); code = 1; }
    }
    if (flags.get('stills')) {
      const { videoStills } = await import('../video/render.mjs');
      const times = String(flags.get('stills')).split(',').map(Number).filter(Number.isFinite);
      const r = await videoStills(file, times, { ...common, scale: 0.5, format: 'jpg', out: join(projectDir, 'out', 'stills') });
      if (r.ok) for (const f of r.files) console.log(`STILL ${f.time.toFixed(2)}s ${f.path}`); else { console.log('FAIL stills'); code = 1; }
    }
    if (flags.get('render')) {
      const { renderVideo } = await import('../video/render.mjs');
      const r = await renderVideo(file, { ...common, normalize: true });
      if (!r.ok) { console.log('FAIL render'); for (const e of r.errors ?? []) console.log(`     ${e.message}`); return 1; }
      console.log(`RENDERED ${r.files.video ?? r.output?.path ?? ''} ${r.output.width}x${r.output.height} ${r.output.duration}s ${(r.output.bytes / 1e6).toFixed(1)} MB in ${r.timings.totalSeconds}s`);
    }
    return code;
  },
};
