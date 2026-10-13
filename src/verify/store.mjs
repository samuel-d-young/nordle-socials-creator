// The record of how each post was checked (<project>/checks/<doc>.json) and the media catalog (what each photo/clip shows).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const atomic = (file, text) => { mkdirSync(dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, text); renameSync(tmp, file); };
const readJson = (file, fallback) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback);

export const checksPath = (projectDir, docId) => join(projectDir, 'checks', `${docId}.json`);
export const loadChecks = (projectDir, docId) => readJson(checksPath(projectDir, docId), { schema: 'nordle.checks/0.1', doc: docId, entries: [] });

/** Add (or replace the same check by the same checker at the same version) an entry. */
export function recordCheck(projectDir, docId, entry) {
  const rec = loadChecks(projectDir, docId);
  const e = { at: new Date().toISOString(), ...entry };
  rec.entries = rec.entries.filter((x) => !(x.check === e.check && x.by === e.by && x.v === e.v));
  rec.entries.push(e);
  atomic(checksPath(projectDir, docId), `${JSON.stringify(rec, null, 2)}\n`);
  return rec;
}

/** What must have passed, by whom, before a post counts as verified. */
export function requiredChecks(doc) {
  const base = [
    { check: 'technical', by: ['auto'] },
    { check: 'compliance', by: ['auto'] },
    { check: 'facts', by: ['auto'] },
    { check: 'copy', by: ['auto', 'designer'] },
    { check: 'uniqueness', by: ['auto'] },
    { check: 'media-match', by: ['auto', 'designer', 'reviewer'] },
    { check: 'brief', by: ['reviewer'] },
  ];
  if (doc.kind !== 'video') base.push({ check: 'design', by: ['auto'] });
  // every video is held to the motion standard (a score from the document; the build prompt also has the designer look at the result)
  if (doc.kind === 'video') base.push({ check: 'motion', by: ['auto'] });
  if (doc.kind === 'video') base.push({ check: 'speech-cuts', by: ['auto', 'reviewer'] }, { check: 'broll', by: ['auto', 'designer', 'reviewer'] }, { check: 'audio', by: ['auto'] });
  return base;
}

/**
 * The newest entry per (check, by) that was made at version v. A check that failed blocks the post; one that is missing, or was
 * skipped because it could not run (no rendered video yet, no footage on this computer), counts as not done.
 */
export function verificationStatus(doc, v, rec) {
  const missing = [];
  const failed = [];
  const warned = [];   // a person or reviewer said "pass, but look at this": counts as verified, never silently
  for (const req of requiredChecks(doc)) {
    for (const by of req.by) {
      const e = rec.entries.filter((x) => x.check === req.check && x.by === by && x.v === v).at(-1);
      if (!e) missing.push(`${req.check} (${by})`);
      else if (e.status === 'skipped') missing.push(`${req.check} (${by}) was skipped`);
      else if (e.status === 'fail') failed.push(`${req.check} (${by})`);
      else if (e.status === 'warn' && by !== 'auto') warned.push(`${req.check} (${by})${e.summary ? `: ${String(e.summary).slice(0, 160)}` : ''}`);
    }
  }
  return { verified: !missing.length && !failed.length, missing, failed, warned };
}

export const catalogPath = (projectDir, kind = 'assets') => join(projectDir, kind, 'catalog.json');
export const loadCatalog = (projectDir, brand = '') => {
  const out = { schema: 'nordle.catalog/0.1', brand, items: {} };
  for (const kind of ['assets', 'sources']) Object.assign(out.items, readJson(catalogPath(projectDir, kind), { items: {} }).items);
  return out;
};
export function saveCatalog(projectDir, kind, cat) { atomic(catalogPath(projectDir, kind), `${JSON.stringify(cat, null, 2)}\n`); return cat; }
