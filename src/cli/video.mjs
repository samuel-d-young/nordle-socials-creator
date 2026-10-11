// node nordle.mjs video <render|stills|sheet|check|probe|proxy> ...
//   video render <doc> [--preview] [--from s] [--to s] [--size id] [--out dir] [--format mp4|webm|gif|prores] [--max-width px]
//   video stills <doc> --at 1.5,3.0 [--preview|--scale 0.5] [--format png|jpg] [--out dir] [--no-overlay]
//   video sheet  <doc>
//   video check  <doc>                  the plan's problems, nothing drawn
//   video probe  <file | mount:name/path> [--project <folder>]
//   video proxy  <doc> [--source id] [--force]    small browser-playable copies of the footage, in <project>/.proxies

import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const USAGE = `Usage:
  node nordle.mjs video render <doc.json> [--preview] [--from 2] [--to 10] [--size ig-reel-9x16] [--out dir] [--format mp4|webm|gif|prores] [--max-width 540]
  node nordle.mjs video stills <doc.json> --at 1.5,3.0 [--preview | --scale 0.5] [--format png|jpg] [--out dir] [--no-overlay]
  node nordle.mjs video sheet  <doc.json>
  node nordle.mjs video check  <doc.json>
  node nordle.mjs video probe  <file | mount:name/path> [--project <project folder>]
  node nordle.mjs video proxy  <doc.json> [--source <source id>] [--force]`;

function parse(list) {
  const o = { _: [] };
  const bools = new Set(['preview', 'no-overlay', 'keep-temp', 'json', 'no-normalize', 'force']);
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const key = a.slice(2);
    if (bools.has(key)) o[key] = true; else o[key] = list[++i];
  }
  return o;
}

const num = (v) => (v === undefined ? undefined : Number(v));
const print = (issues) => {
  for (const i of issues) console.log(`     ${i.level === 'error' ? 'error' : i.level === 'warn' ? 'warn ' : 'info '} ${i.code}: ${i.message}`);
};

export default {
  name: 'video',
  usage: 'video <render|stills|sheet|check|probe|proxy> <doc> [...]',
  summary: 'render a video post to mp4, webm, gif or ProRes, look at frames of it, or make proxies of its footage',
  async run(args) {
    const [sub, ...rest] = args;
    const o = parse(rest);
    if (!['render', 'stills', 'sheet', 'check', 'probe', 'proxy'].includes(sub)) { console.error(USAGE); return 2; }

    if (sub === 'probe') {
      const { probeFor } = await import('../video/render.mjs');
      const { describeProbe, probeMedia } = await import('../video/probe.mjs');
      const target = o._[0];
      if (!target) { console.error(USAGE); return 2; }
      try {
        // a mount reference needs the project's nordle.local.json; a plain file on this computer is probed as it is
        const p = target.startsWith('mount:') ? await probeFor(resolve(o.project ?? '.'), target) : await probeMedia(resolve(target));
        console.log(describeProbe(p));
        if (o.json) console.log(JSON.stringify({ ...p, path: undefined }, null, 2));
        return 0;
      } catch (e) {
        console.error(e.message);
        return 1;
      }
    }

    const docArg = o._[0];
    if (!docArg) { console.error(USAGE); return 2; }
    const file = resolve(docArg);
    if (!existsSync(file)) { console.error(`Not found: ${docArg}`); return 2; }
    const common = { out: o.out ? resolve(o.out) : undefined, size: o.size, preview: !!o.preview };

    if (sub === 'check') {
      const { loadDocContext } = await import('../render/context.mjs');
      const { buildPlan, summarisePlan } = await import('../video/plan.mjs');
      const c = loadDocContext(file);
      if (c.errors.length) { console.log(`FAIL ${c.doc.id}: the document has errors`); print(c.errors.map((e) => ({ level: 'error', code: 'document', message: `${e.path}: ${e.message}` }))); return 1; }
      const plan = await buildPlan({ doc: c.doc, brand: c.brand, projectDir: c.projectDir, platforms: c.platforms, size: o.size });
      const s = summarisePlan(plan);
      console.log(`${plan.blocking.length ? 'FAIL' : 'OK  '} ${c.doc.id}: ${s.size}, ${s.seconds}s, ${s.segments.length} pieces of picture`);
      for (const g of s.segments) console.log(`     ${g.from.toFixed(2)}-${g.to.toFixed(2)}s  ${g.shows}${g.source ? ` (${g.source})` : ''}${g.transition ? `  [${g.transition} in]` : ''}`);
      print(s.issues);
      return plan.blocking.length || s.issues.some((i) => i.level === 'error') ? 1 : 0;
    }

    if (sub === 'proxy') {
      const { loadDocContext } = await import('../render/context.mjs');
      const { makeProxy } = await import('../video/proxy.mjs');
      const c = loadDocContext(file);
      if (c.errors.length) { console.log(`FAIL ${c.doc.id}: the document has errors`); print(c.errors.map((e) => ({ level: 'error', code: 'document', message: `${e.path}: ${e.message}` }))); return 1; }
      const all = (c.doc.sources ?? []).filter((s) => s.type !== 'image');
      const chosen = o.source ? all.filter((s) => s.id === o.source) : all;
      if (!chosen.length) { console.error(o.source ? `There is no video or audio source "${o.source}" in ${c.doc.id}.` : `${c.doc.id} has no video or audio sources to make proxies of.`); return 2; }
      let failed = 0;
      // makeProxy keeps to two at once, so all of them are asked for together
      await Promise.all(chosen.map(async (s) => {
        try {
          const r = await makeProxy(c.projectDir, s.path, { force: !!o.force });
          console.log(`OK   ${s.id}: ${r.cached ? 'already made' : 'made'}  ${r.width && r.height ? `${r.width}x${r.height}, ` : ''}${r.duration}s, ${(statSync(r.file).size / 1e6).toFixed(1)} MB  ${r.file}`);
        } catch (e) { failed++; console.log(`FAIL ${s.id}: ${e.message}`); }
      }));
      return failed ? 1 : 0;
    }

    if (sub === 'render') {
      const { renderVideo } = await import('../video/render.mjs');
      const { FORMATS, normaliseFormat } = await import('../video/formats.mjs');
      let format;
      try { format = normaliseFormat(o.format); } catch (e) { console.error(e.message); return 2; }
      let last = -1;
      const r = await renderVideo(file, {
        ...common, from: num(o.from), to: num(o.to), keepTemp: !!o['keep-temp'], normalize: !o['no-normalize'], format, maxWidth: num(o['max-width']),
        onProgress: (p) => { if (p.percent !== last && process.stdout.isTTY) { last = p.percent; process.stdout.write(`\r  ${String(p.percent).padStart(3)}%  ${p.message}                    `); } },
      });
      if (process.stdout.isTTY) process.stdout.write('\r\x1b[K');
      if (!r.ok) { console.log(`FAIL ${r.doc}: cannot render`); print(r.errors ?? []); return 1; }
      console.log(`OK   ${r.doc}${format === 'mp4' ? '' : ` (${FORMATS[format].label})`}: ${r.output.width}x${r.output.height} ${r.output.fps} fps, ${r.output.duration}s, ${(r.output.bytes / 1e6).toFixed(1)} MB in ${r.timings.totalSeconds}s`);
      for (const [k, v] of Object.entries(r.files)) console.log(`     ${k}: ${v}`);
      console.log(`     timings: picture ${r.timings.picturesSeconds}s, overlay ${r.timings.overlaySeconds}s, sound ${r.timings.audioSeconds}s, final pass ${r.timings.finalSeconds}s${r.timings.sheetSeconds ? `, sheet ${r.timings.sheetSeconds}s` : ''}`);
      print(r.issues);
      return r.issues.some((i) => i.level === 'error') ? 1 : 0;
    }

    if (sub === 'stills') {
      const { videoStills } = await import('../video/render.mjs');
      const times = (o.at ?? '').split(',').map((s) => s.trim()).filter(Boolean).map(Number);
      if (!times.length || times.some((t) => !Number.isFinite(t) || t < 0)) { console.error('Give the times in seconds: --at 1.5,3.0'); return 2; }
      const r = await videoStills(file, times, { ...common, scale: num(o.scale), format: o.format === 'jpg' ? 'jpg' : 'png', out: common.out ?? join(resolve(file, '..', '..'), 'out', 'stills'), overlay: !o['no-overlay'] });
      if (!r.ok) { console.log('FAIL: cannot draw frames'); print(r.errors ?? []); return 1; }
      for (const f of r.files) console.log(`OK   ${f.time.toFixed(2)}s  ${f.shows}  ${f.path}`);
      print(r.issues.filter((i) => i.level !== 'info'));
      return 0;
    }

    if (sub === 'sheet') {
      const { videoSheet } = await import('../video/render.mjs');
      const r = await videoSheet(file, common);
      if (!r.ok) { console.log('FAIL: cannot build the sheet'); print(r.errors ?? []); return 1; }
      console.log(`OK   sheet ${r.sheet}`);
      for (const s of r.scenes) console.log(`     ${s.title} ${s.start.toFixed(1)}-${s.end.toFixed(1)}s: ${s.clips.join(', ')}${s.speech ? `  says: "${s.speech}"` : ''}`);
      print(r.issues.filter((i) => i.level !== 'info'));
      return 0;
    }
    return 2;
  },
};
