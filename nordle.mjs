#!/usr/bin/env node
// Nordle command line.  node nordle.mjs <command> [options]

import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [cmd, ...args] = process.argv.slice(2);

const HELP = `Nordle

  node nordle.mjs doctor [--ci] [--json]            check this computer can run Nordle
  node nordle.mjs validate [paths] [--assets]       check documents, brand kits, packs against the formats
  node nordle.mjs render <doc|project> [options]    render graphics and carousels to image files
  node nordle.mjs verify <doc|project> [options]    render, then check contrast, safe zones, text fit, copy
  node nordle.mjs critique <doc|project> [--json]   grade the design out of 100 (hierarchy, spacing, collisions, consistency) with fixes

render / verify options:
  --out <dir>        output folder (default: <project>/out/<doc id>)
  --size <id,id>     only these sizes (default: all the document lists)
  --page <id,id>     only these pages
  --format png|jpg   image format (default png)
  --scale <n>        pixel density, e.g. 2 for double size (default 1)
  --safe             render: draw the platform's covered areas in red
  --sheet            render: also write sheet.png, every page of every size on one picture
  --json             verify: print the report as JSON
`;

function parse(list) {
  const opts = { _: [] };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.startsWith('--')) { opts._.push(a); continue; }
    const key = a.slice(2);
    if (['safe', 'json', 'sheet'].includes(key)) opts[key] = true;
    else opts[key] = list[++i];
  }
  if (opts.size) opts.sizes = opts.size.split(',');
  if (opts.page) opts.pages = opts.page.split(',');
  if (opts.scale) opts.scale = Number(opts.scale);
  if (opts.safe) opts.showSafe = true;
  return opts;
}

async function delegate(script) {
  process.argv = [process.argv[0], join(here, 'tools', script), ...args];
  await import(`./tools/${script}`);
}

function groupIssues(issues) {
  const groups = new Map();
  for (const i of issues) {
    const key = [i.level, i.rule, i.page, i.layer, i.message].join('|');
    const g = groups.get(key) ?? { ...i, sizes: [] };
    if (i.size) g.sizes.push(i.size);
    groups.set(key, g);
  }
  return [...groups.values()];
}

// Feature commands live in src/cli/*.mjs; each default-exports { name, summary, run(args) } (see src/cli/README.md).
// They load only when asked for (or for help), so they cannot disturb the core commands below.
const CORE = new Set(['doctor', 'validate', 'render', 'verify', 'critique']);
const plugins = new Map();
async function loadFile(f) {
  for (const c of [(await import(pathToFileURL(join(here, 'src', 'cli', f)).href)).default].flat().filter(Boolean)) plugins.set(c.name, c);
}
/** Load only what a command needs: the file named after it if there is one (so a half-edited sibling cannot break it), else everything. */
async function loadPlugins(cmd) {
  if (cmd && existsSync(join(here, 'src', 'cli', `${cmd}.mjs`))) { await loadFile(`${cmd}.mjs`); if (plugins.has(cmd)) return; }
  for (const f of readdirSync(join(here, 'src', 'cli')).filter((x) => x.endsWith('.mjs')).sort()) { try { await loadFile(f); } catch (e) { if (!cmd) throw e; } }
}

async function main() {
  if (cmd && !CORE.has(cmd) && !['help', '--help'].includes(cmd)) {
    await loadPlugins(cmd);
    if (plugins.has(cmd)) { process.exitCode = (await plugins.get(cmd).run(args)) ?? 0; return; }
  }
  switch (cmd) {
    case 'doctor': return delegate('doctor.mjs');
    case 'validate': return delegate('validate.mjs');
    case 'render':
    case 'verify':
    case 'critique': {
      const opts = parse(args);
      if (!opts._.length) { console.error(`Usage: node nordle.mjs ${cmd} <document.json | project folder>`); process.exitCode = 2; return; }
      const { docFilesFor } = await import('./src/render/context.mjs');
      const { openBrowser } = await import('./src/render/browser.mjs');
      const { renderDocument } = await import('./src/render/render.mjs');
      const { verifyDocument } = await import('./src/render/verify.mjs');
      const { critiqueDocument } = await import('./src/render/critique.mjs');
      const files = opts._.flatMap(docFilesFor);
      if (!files.length) { console.error('No documents found.'); process.exitCode = 2; return; }
      const browser = await openBrowser();
      let failed = false;
      const reports = [];
      try {
        for (const file of files) {
          if (cmd === 'render') {
            const r = await renderDocument(file, { ...opts, browser });
            if (r.errors.length) {
              failed = true;
              console.log(`FAIL ${r.ctx.doc.id}: the document has errors (run: node nordle.mjs validate ${file})`);
              for (const e of r.errors) console.log(`     ${e.path}: ${e.message}`);
            } else if (r.skipped) {
              console.log(`skip ${r.doc.id}: ${r.skipped}`);
            } else {
              console.log(`OK   ${r.doc.id}: ${r.outputs.length} image${r.outputs.length === 1 ? '' : 's'}`);
              for (const o of r.outputs) console.log(`     ${o.path}  (${o.w}x${o.h}, ${(o.bytes / 1024).toFixed(0)} KB)`);
              if (r.sheet) console.log(`     sheet ${r.sheet}`);
              for (const w of r.warnings) console.log(`     warn ${w}`);
            }
          } else if (cmd === 'critique') {
            const r = await critiqueDocument(file, { ...opts, browser });
            const { ctx, outputs, ...slim } = r;
            void ctx; void outputs;
            reports.push(slim);
            if (opts.json) continue;
            if (r.skipped) { console.log(`skip ${r.id}: ${r.skipped}`); continue; }
            if (r.counts.error) failed = true;
            console.log(`${r.verdict === 'good' ? 'GOOD' : 'NEEDS WORK'} ${r.id}: design score ${r.score}/100 (pass mark ${r.passScore}), ${r.counts.error} error(s), ${r.counts.warn} warning(s), ${r.counts.info} suggestion(s)`);
            for (const i of r.issues) {
              const where = [i.page, i.layer].filter(Boolean).join(' / ');
              console.log(`     ${i.level === 'error' ? 'error' : i.level === 'warn' ? 'warn ' : 'info '} ${i.rule}${where ? ` ${where}` : ''}${i.sizes?.length ? ` [${i.sizes.join(', ')}]` : ''}: ${i.message}`);
              if (i.fix) console.log(`           fix: ${i.fix}`);
            }
          } else {
            const r = await verifyDocument(file, { ...opts, browser });
            reports.push(r);
            if (opts.json) continue;
            const errors = r.issues.filter((i) => i.level === 'error').length;
            const warns = r.issues.filter((i) => i.level === 'warn').length;
            if (errors) failed = true;
            const state = r.skipped ? 'skip' : errors ? 'FAIL' : 'OK  ';
            console.log(`${state} ${r.id} (${r.kind}): ${r.outputs.length} images, ${errors} error${errors === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'}`);
            if (r.skipped) console.log(`     ${r.skipped}`);
            for (const g of groupIssues(r.issues)) {
              const where = [g.page, g.layer].filter(Boolean).join(' / ');
              const sizes = g.sizes.length ? ` [${[...new Set(g.sizes)].join(', ')}]` : '';
              console.log(`     ${g.level === 'error' ? 'error' : g.level === 'warn' ? 'warn ' : 'info '} ${g.rule}${where ? ` ${where}` : ''}: ${g.message}${sizes}`);
            }
          }
        }
      } finally {
        await browser.close();
      }
      if (opts.json) console.log(JSON.stringify(reports.map((r) => ({ ...r, outputs: r.outputs?.map((o) => o.path) })), null, 2));
      if (cmd !== 'render') failed = failed || reports.some((r) => r.issues.some((i) => i.level === 'error'));
      process.exitCode = failed ? 1 : 0;
      return;
    }
    default:
      await loadPlugins();
      console.log(HELP + [...plugins.values()].map((c) => `  node nordle.mjs ${c.usage ?? c.name}`.padEnd(54) + c.summary).join('\n') + '\n');
      process.exitCode = cmd && cmd !== 'help' && cmd !== '--help' ? 2 : 0;
  }
}

main().catch((e) => { console.error(`nordle: ${e.message}`); process.exitCode = 1; });
