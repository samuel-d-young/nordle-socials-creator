// Loads a document together with its brand, project folder and platform presets.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT, readJson, projectFor, validateFile } from '../../tools/validate.mjs';

export function loadDocContext(file, { assets = true } = {}) {
  const abs = resolve(file);
  const result = validateFile(abs, { assets });
  if (result.kind !== 'doc') throw new Error(`${abs} is not a Nordle document`);
  const doc = readJson(abs);
  const { projectDir, brand } = projectFor(abs);
  const platforms = readJson(join(ROOT, 'data', 'platforms.json'));
  return {
    file: abs, doc, brand, projectDir, platforms,
    issues: result.issues,
    errors: result.issues.filter((i) => i.level === 'error'),
  };
}

/** Every document file for a path: a document file itself, or a project folder (its docs/*.json). */
export function docFilesFor(target) {
  const abs = resolve(target);
  if (!existsSync(abs)) throw new Error(`not found: ${target}`);
  if (statSync(abs).isFile()) return [abs];
  const dir = existsSync(join(abs, 'docs')) ? join(abs, 'docs') : abs;
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => join(dir, f))
    .filter((f) => { try { return readJson(f).schema?.startsWith('nordle.doc/'); } catch { return false; } });
}

/** Sizes for a document as {id, w, h, safe?, preset?}. */
export function resolveSizes(doc, platforms) {
  const presets = new Map(platforms.presets.map((p) => [p.id, p]));
  return doc.sizes.map((s) => {
    if (typeof s === 'object') return { id: s.id, w: s.w, h: s.h };
    const p = presets.get(s);
    return { id: p.id, w: p.w, h: p.h, safe: p.safe, preset: p };
  });
}
