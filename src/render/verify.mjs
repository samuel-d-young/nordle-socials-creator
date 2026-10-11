// `nordle verify`: validate, render every size and page, then run the checks. This is the gate before anything ships.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkDocumentCopy, checkRenderedPage } from './checks.mjs';
import { renderDocument } from './render.mjs';
import { resolveSizes } from './context.mjs';

export async function verifyDocument(file, opts = {}) {
  const issues = [];
  const rendered = await renderDocument(file, {
    ...opts, inspect: true,
    onPage: (p) => { issues.push(...checkRenderedPage(p)); },
  });
  const { ctx } = rendered;
  const result = {
    file: rendered.file, id: ctx.doc.id, kind: ctx.doc.kind, outputs: rendered.outputs, skipped: rendered.skipped,
    issues: [
      ...rendered.errors.map((i) => ({ level: i.level, rule: 'document', size: null, page: null, layer: i.path, message: i.message })),
      ...ctx.issues.filter((i) => i.level === 'warn').map((i) => ({ level: 'warn', rule: 'document', size: null, page: null, layer: i.path, message: i.message })),
    ],
  };
  if (rendered.errors.length || rendered.skipped) return result;
  result.issues.push(...rendered.warnings.map((message) => ({ level: 'warn', rule: 'font', size: null, page: null, layer: null, message })));
  result.issues.push(...checkDocumentCopy({ doc: ctx.doc, brand: ctx.brand, sizes: resolveSizes(ctx.doc, ctx.platforms) }));
  result.issues.push(...issues);
  const dir = opts.out ?? join(ctx.projectDir, 'out', ctx.doc.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'report.json'), JSON.stringify({ ...result, outputs: result.outputs.map((o) => ({ ...o, path: o.path.split(/[\\/]/).pop() })) }, null, 2));
  return result;
}
