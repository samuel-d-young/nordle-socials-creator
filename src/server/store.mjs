// The document store: opens projects, keeps each document and its review file in memory, applies edits (validating
// them, checking locks, recording history) and tells listeners what changed.

import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ROOT, readJson, validateDocData, validateReviewData } from '../../tools/validate.mjs';
import { applyOps, deepEqual, isPrefix, lockViolations, touchedPaths, PatchError } from '../shared/ops.mjs';
import { computeRegions, describeChange, regionOps } from '../shared/diff.mjs';

const ID = /^[a-z0-9][a-z0-9_-]*$/;
export const slug = (s, fallback = 'item') => {
  const out = String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return ID.test(out) ? out : fallback;
};
export const newId = (prefix) => `${prefix}-${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;

function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

const fail = (status, errors) => ({ ok: false, status, errors: Array.isArray(errors) ? errors : [{ path: '/', message: String(errors) }] });

/** One open document. */
export class DocSession extends EventEmitter {
  constructor(project, file) {
    super();
    this.project = project;
    this.file = file;
    this.doc = readJson(file);
    this.id = this.doc.id;
    this.historyFile = join(project.dir, 'history', `${this.id}.jsonl`);
    this.v = this.#lastVersion();
    this.undoStack = [];
    this.redoStack = [];
    this.recent = [];
  }

  #lastVersion() {
    if (!existsSync(this.historyFile)) return 0;
    const lines = readFileSync(this.historyFile, 'utf8').split('\n').filter(Boolean);
    try { return JSON.parse(lines[lines.length - 1]).v; } catch { return lines.length; }
  }

  get context() {
    return { brand: this.project.brand, projectDir: this.project.dir, platforms: this.project.platforms, assets: true };
  }

  snapshot() {
    return { doc: this.doc, v: this.v, canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0 };
  }

  #commit(newDoc, { ops, inverse, actor, note, undoOf, origin }) {
    this.doc = newDoc;
    this.v += 1;
    const record = { v: this.v, ts: new Date().toISOString(), actor, note: note ?? '', ops, inverse, ...(undoOf ? { undoOf } : {}) };
    writeAtomic(this.file, `${JSON.stringify(newDoc, null, 2)}\n`);
    mkdirSync(dirname(this.historyFile), { recursive: true });
    appendFileSync(this.historyFile, `${JSON.stringify(record)}\n`);
    this.recent.push(record);
    if (this.recent.length > 200) this.recent.shift();
    this.emit('change', { type: 'doc', v: this.v, actor, note: record.note, ops, origin });
    return record;
  }

  /**
   * Apply an edit. Returns {ok:true, v, before, after} or {ok:false, status, errors}.
   * dryRun: check everything but change nothing (used to validate a suggestion).
   * enforceLocks: respect locks even for a human (used when accepting Claude's suggestion).
   */
  apply({ ops, actor = 'human', baseVersion, note, origin, dryRun = false, enforceLocks = false }) {
    if (!['human', 'claude'].includes(actor)) return fail(400, 'actor must be human or claude');
    if (baseVersion !== undefined && baseVersion !== this.v) {
      // Merge only when we remember every edit since then and none of them restructured anything or touched the same place.
      const since = this.recent.filter((r) => r.v > baseVersion);
      const mine = touchedPaths(Array.isArray(ops) ? ops : []);
      const mergeable = since.length === this.v - baseVersion
        && since.every((r) => r.ops.every((o) => o.op === 'replace' && !mine.some((p) => isPrefix(p, o.path))));
      if (!mergeable) return fail(409, `The document changed since you loaded it (you have version ${baseVersion}, it is at ${this.v}). Reload and try again.`);
    }
    let result;
    try { result = applyOps(this.doc, ops); } catch (e) {
      if (e instanceof PatchError) return fail(400, e.message);
      throw e;
    }
    if (actor === 'claude' || enforceLocks) {
      const violations = lockViolations(this.doc, result.doc);
      if (violations.length) return fail(403, violations.map((v) => ({ path: v.layer ? `${v.page}/${v.layer}` : v.page, message: v.message })));
    }
    const issues = validateDocData(result.doc, this.context).filter((i) => i.level === 'error');
    if (issues.length) return fail(422, issues);
    const before = this.doc;
    if (dryRun) return { ok: true, v: this.v, before, after: result.doc, dryRun: true };
    const record = this.#commit(result.doc, { ops, inverse: result.inverse, actor, note, origin });
    this.undoStack.push({ v: record.v, inverse: result.inverse });
    if (this.undoStack.length > 500) this.undoStack.shift();
    this.redoStack = [];
    return { ok: true, v: this.v, before, after: result.doc };
  }

  #step(from, to, label, actor, origin) {
    const entry = from.pop();
    if (!entry) return fail(409, `Nothing to ${label}.`);
    let result;
    try { result = applyOps(this.doc, entry.inverse); } catch (e) {
      if (e instanceof PatchError) return fail(409, `Cannot ${label}: later changes are in the way (${e.message})`);
      throw e;
    }
    const issues = validateDocData(result.doc, this.context).filter((i) => i.level === 'error');
    if (issues.length) return fail(422, issues);
    const record = this.#commit(result.doc, { ops: entry.inverse, inverse: result.inverse, actor, note: label, undoOf: entry.v, origin });
    to.push({ v: record.v, inverse: result.inverse });
    return { ok: true, v: this.v };
  }

  undo(actor = 'human', origin) { return this.#step(this.undoStack, this.redoStack, 'undo', actor, origin); }
  redo(actor = 'human', origin) { return this.#step(this.redoStack, this.undoStack, 'redo', actor, origin); }
}

/** The review file for one document: comments, saved versions, approvals. */
export class ReviewSession extends EventEmitter {
  constructor(project, docSession) {
    super();
    this.project = project;
    this.docSession = docSession;
    this.file = join(project.dir, 'review', `${docSession.id}.json`);
    this.data = existsSync(this.file) ? readJson(this.file) : { schema: 'nordle.review/0.1', doc: docSession.id, comments: [], versions: [], approvals: [] };
    this.rv = 0;
  }

  snapshot() { return { review: this.data, rv: this.rv }; }

  #save(actor, what) {
    writeAtomic(this.file, `${JSON.stringify(this.data, null, 2)}\n`);
    this.rv += 1;
    this.emit('change', { type: 'review', rv: this.rv, actor, what });
  }

  /** Edit the review file with ops (comments, replies, status). Versions, approvals, settings and changes have their own methods. */
  apply({ ops, actor = 'human' }) {
    let result;
    try { result = applyOps(this.data, ops); } catch (e) {
      if (e instanceof PatchError) return fail(400, e.message);
      throw e;
    }
    const issues = validateReviewData(result.doc);
    if (issues.length) return fail(422, issues);
    if (result.doc.versions.length !== this.data.versions.length || result.doc.approvals.length !== this.data.approvals.length) {
      return fail(400, 'Versions and approvals have their own actions.');
    }
    if (!deepEqual(result.doc.settings, this.data.settings) || !deepEqual(result.doc.changes, this.data.changes)) {
      return fail(400, 'Settings and Claude’s changes have their own actions.');
    }
    this.data = result.doc;
    this.#save(actor, 'comments');
    return { ok: true, rv: this.rv };
  }

  // ---- what Claude is allowed to do here -------------------------------------------------------------------------------

  /** How far Claude may go on this document: suggest, review (default) or apply. Only the owner changes it. */
  get autonomy() { return this.data.settings?.autonomy ?? 'review'; }

  setAutonomy(value) {
    if (!['suggest', 'review', 'apply'].includes(value)) return fail(400, 'autonomy must be suggest, review or apply');
    this.data.settings = { ...(this.data.settings ?? {}), autonomy: value };
    this.#save('human', 'settings');
    return { ok: true, autonomy: value };
  }

  agentComment({ page, x, y, layer, text, time }) {
    const isVideo = this.docSession.doc.kind === 'video' && page === 'video';
    if (!isVideo && !this.docSession.doc.pages?.some((p) => p.id === page)) return fail(404, `No page "${page}" in this document.`);
    if (typeof text !== 'string' || !text.trim()) return fail(400, 'A comment needs some text.');
    const c = { id: newId('c'), page, x: Number(x ?? 0.5), y: Number(y ?? 0.5), text: text.trim(), author: 'claude', created: new Date().toISOString(), status: 'open', docV: this.docSession.v, ...(layer ? { layer } : {}), ...(typeof time === 'number' && time >= 0 ? { time } : {}) };
    const r = this.apply({ ops: [{ op: 'add', path: '/comments/-', value: c }], actor: 'claude' });
    return r.ok ? { ok: true, id: c.id } : r;
  }

  agentReply(commentId, text) {
    const i = this.data.comments.findIndex((c) => c.id === commentId);
    if (i < 0) return fail(404, `No comment "${commentId}".`);
    if (typeof text !== 'string' || !text.trim()) return fail(400, 'A reply needs some text.');
    const reply = { id: newId('r'), author: 'claude', text: text.trim(), created: new Date().toISOString() };
    const has = Array.isArray(this.data.comments[i].replies);
    return this.apply({ ops: [has ? { op: 'add', path: `/comments/${i}/replies/-`, value: reply } : { op: 'add', path: `/comments/${i}/replies`, value: [reply] }], actor: 'claude' });
  }

  agentResolve(commentId) {
    const i = this.data.comments.findIndex((c) => c.id === commentId);
    if (i < 0) return fail(404, `No comment "${commentId}".`);
    return this.apply({ ops: [{ op: 'replace', path: `/comments/${i}/status`, value: 'resolved' }], actor: 'claude' });
  }

  // ---- Claude's changes: pending until the owner accepts or rejects them --------------------------------------------------

  recordChange(fields) {
    const change = { id: newId('ch'), created: new Date().toISOString(), ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) };
    change.note ??= '';
    (this.data.changes ??= []).push(change);
    while (this.data.changes.length > 60) {
      const i = this.data.changes.findIndex((c) => c.status !== 'pending');
      if (i < 0) break;
      this.data.changes.splice(i, 1);
    }
    this.#save('claude', 'change');
    return change;
  }

  /** Accept or reject one change. Rejecting an applied change puts back exactly what it replaced, if nothing else touched that part since. */
  decide(id, decision, { origin } = {}) {
    const change = (this.data.changes ?? []).find((c) => c.id === id);
    if (!change) return fail(404, 'No such change.');
    if (change.status !== 'pending') return fail(409, `That change was already ${change.status}.`);
    const ds = this.docSession;
    if (decision === 'accept') {
      if (change.mode === 'proposed') {
        const r = ds.apply({ ops: change.ops, actor: 'human', enforceLocks: true, baseVersion: change.baseV, note: `Accepted: ${change.note}`, origin });
        if (!r.ok) return r.status === 409 ? fail(409, 'The post has changed since Claude suggested this, so it cannot be applied as it is. Reject it and ask Claude to try again.') : r;
        change.v = r.v;
      }
    } else if (decision === 'reject') {
      if (change.mode === 'applied') {
        let ops;
        try { ops = regionOps(ds.doc, change.regions ?? [], 'before'); } catch (e) {
          if (e.conflict) return fail(409, `This cannot be taken back cleanly. ${e.message}. Undo the later edits first, or restore a saved version.`);
          throw e;
        }
        const r = ds.apply({ ops, actor: 'human', note: `Rejected: ${change.note}`, origin });
        if (!r.ok) return r;
      }
    } else {
      return fail(400, 'decision must be accept or reject');
    }
    change.status = decision === 'accept' ? 'accepted' : 'rejected';
    change.decided = new Date().toISOString();
    this.#save('human', 'change');
    return { ok: true, change: { id: change.id, status: change.status } };
  }

  decideAll(decision, opts) {
    const pending = (this.data.changes ?? []).filter((c) => c.status === 'pending');
    const order = decision === 'reject' ? [...pending].reverse() : pending; // newest first, so each one can be taken back cleanly
    const failed = [];
    let done = 0;
    for (const c of order) {
      const r = this.decide(c.id, decision, opts);
      if (r.ok) done += 1; else failed.push({ id: c.id, error: r.errors?.[0]?.message ?? 'failed' });
    }
    return { ok: failed.length === 0, status: failed.length ? 409 : 200, done, failed, errors: failed.map((f) => ({ path: f.id, message: f.error })) };
  }

  #versionPath(id) { return join(this.project.dir, 'review', 'versions', this.docSession.id, `${id}.json`); }
  readVersion(id) {
    const v = this.data.versions.find((x) => x.id === id);
    if (!v) return null;
    return readJson(this.#versionPath(id));
  }

  saveVersion({ name, note = '', author = 'human' } = {}) {
    const n = this.data.versions.length + 1;
    const id = `v${n}`;
    const version = {
      id, name: name?.trim() || `V${n}`, note, created: new Date().toISOString(), docV: this.docSession.v,
      file: `review/versions/${this.docSession.id}/${id}.json`, author,
    };
    writeAtomic(this.#versionPath(id), `${JSON.stringify(this.docSession.doc, null, 2)}\n`);
    this.data.versions.push(version);
    for (const c of this.data.comments) if (c.status === 'resolved' && !c.resolvedIn) c.resolvedIn = id;
    this.#save(author, 'version');
    return { ok: true, version };
  }

  approve({ by = 'human', note = '' } = {}) {
    const latest = this.data.versions[this.data.versions.length - 1];
    let versionId = latest?.id;
    if (!latest || latest.docV !== this.docSession.v) versionId = this.saveVersion({ note: note || 'Approved', author: by === 'claude' ? 'claude' : 'human' }).version.id;
    const approval = { id: newId('a'), versionId, docV: this.docSession.v, by, date: new Date().toISOString(), ...(note ? { note } : {}) };
    this.data.approvals.push(approval);
    this.#save(by, 'approval');
    return { ok: true, approval };
  }

  revokeApproval() {
    const active = [...this.data.approvals].reverse().find((a) => !a.revoked);
    if (!active) return fail(409, 'There is no approval to withdraw.');
    active.revoked = new Date().toISOString();
    this.#save('human', 'approval');
    return { ok: true };
  }

  /** Operations that turn the current document into a saved version. */
  restoreOps(id) {
    const snap = this.readVersion(id);
    return snap ? wholeDocOps(this.docSession.doc, snap) : null;
  }
}

/** Operations that make `cur` look like `snap`, except for the keys that identify the document. */
function wholeDocOps(cur, snap, keep = ['schema', 'id', 'kind', 'brand', 'explore', '$schema']) {
  const skip = new Set(keep);
  const ops = [];
  for (const key of new Set([...Object.keys(cur), ...Object.keys(snap)])) {
    if (skip.has(key)) continue;
    const p = `/${key}`;
    if (!(key in snap)) ops.push({ op: 'remove', path: p });
    else if (!(key in cur)) ops.push({ op: 'add', path: p, value: snap[key] });
    else ops.push({ op: 'replace', path: p, value: snap[key] });
  }
  return ops;
}

/** A project is a folder with a brand.json and a docs/ folder. */
class Project {
  constructor(id, dir, platforms) {
    this.id = id; this.dir = dir; this.platforms = platforms;
    this.docs = new Map();
    this.reviews = new Map();
  }
  get brand() { return readJson(join(this.dir, 'brand.json')); }
  docFiles() {
    const dir = join(this.dir, 'docs');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => join(dir, f));
  }
  listDocs() {
    return this.docFiles().map((f) => {
      try {
        const d = this.docs.get(basename(f, '.json'))?.doc ?? readJson(f);
        if (!String(d.schema).startsWith('nordle.doc/')) return null;
        return { id: d.id, title: d.title, kind: d.kind, pages: d.pages?.length ?? 0, sizes: d.sizes.map((s) => (typeof s === 'string' ? s : s.id)), file: basename(f), ...(d.explore ? { explore: d.explore } : {}) };
      } catch { return null; }
    }).filter(Boolean);
  }

  // ---- Claude's edits --------------------------------------------------------------------------------------------------

  /**
   * An edit from Claude, handled according to the owner's autonomy setting for this document:
   * suggest = checked and stored as a proposal, nothing changes; review = applied and flagged for the owner; apply = applied.
   * Alternative takes (Explore) are scratch work and are always applied.
   */
  claudePatch(docId, { ops, note, baseVersion, origin }) {
    const session = this.doc(docId), review = this.review(docId);
    const scratch = !!session.doc.explore;
    const mode = scratch ? 'apply' : review.autonomy;
    if (mode === 'suggest') {
      const r = session.apply({ ops, actor: 'claude', baseVersion, note, dryRun: true });
      if (!r.ok) return r;
      const d = describeChange(r.before, r.after);
      if (!d.lines.length) return { ok: true, mode: 'proposed', noChange: true, v: session.v, summary: [] };
      const change = review.recordChange({ mode: 'proposed', status: 'pending', note, ops, baseV: session.v, summary: d.lines, touched: d.touched });
      return { ok: true, mode: 'proposed', status: 'pending', changeId: change.id, v: session.v, summary: d.lines };
    }
    const r = session.apply({ ops, actor: 'claude', baseVersion, note, origin });
    if (!r.ok) return r;
    const d = describeChange(r.before, r.after);
    if (scratch || !d.lines.length) return { ok: true, mode: 'applied', status: 'accepted', v: r.v, summary: d.lines };
    const pending = mode === 'review';
    const change = review.recordChange({
      mode: 'applied', status: pending ? 'pending' : 'accepted', auto: pending ? undefined : true, note, ops, v: r.v, summary: d.lines, touched: d.touched,
      regions: pending ? computeRegions(r.before, r.after) : undefined,
    });
    return { ok: true, mode: 'applied', status: change.status, changeId: change.id, v: r.v, summary: d.lines };
  }

  // ---- Explore: several alternative takes of one document -------------------------------------------------------------------

  takesOf(docId) {
    return this.listDocs().filter((d) => d.explore?.of === docId).map((d) => ({ id: d.id, title: d.title, label: d.explore.label ?? d.id, note: d.explore.note }));
  }

  createTakes(docId, { count = 3, labels = [], note } = {}) {
    const src = this.doc(docId);
    if (!src) return null;
    if (src.doc.explore) throw new Error('This document is already one of several takes. Make takes from the original.');
    const n = Math.max(1, Math.min(6, Number(count) || 3));
    const made = [];
    for (let i = 0, k = 1; i < n; i++, k++) {
      let id = `${docId}-take-${k}`;
      while (existsSync(join(this.dir, 'docs', `${id}.json`))) { k += 1; id = `${docId}-take-${k}`; }
      const doc = structuredClone(src.doc);
      doc.id = id;
      doc.title = `${src.doc.title} (take ${k})`;
      doc.explore = { of: docId, label: labels[i] ?? `Take ${k}`, ...(note ? { note } : {}) };
      writeAtomic(join(this.dir, 'docs', `${id}.json`), `${JSON.stringify(doc, null, 2)}\n`);
      made.push({ id, label: doc.explore.label });
    }
    return made;
  }

  /** Make the original look like the chosen take (an ordinary edit, so it can be undone). */
  adoptTake(docId, takeId, origin) {
    const src = this.doc(docId), take = this.doc(takeId);
    if (!src || !take || take.doc.explore?.of !== docId) return fail(404, 'That take does not belong to this document.');
    return src.apply({ ops: wholeDocOps(src.doc, take.doc), actor: 'human', note: `Used ${take.doc.explore.label ?? takeId}`, origin });
  }

  /** Move every take of a document to trash/ (nothing is deleted outright). */
  discardTakes(docId) {
    const takes = this.takesOf(docId);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    mkdirSync(join(this.dir, 'trash'), { recursive: true });
    for (const t of takes) {
      renameSync(join(this.dir, 'docs', `${t.id}.json`), join(this.dir, 'trash', `${stamp}-${t.id}.json`));
      this.docs.delete(t.id);
      this.reviews.delete(t.id);
    }
    return takes.length;
  }
  doc(id) {
    if (!ID.test(id)) return null;
    if (this.docs.has(id)) return this.docs.get(id);
    const file = join(this.dir, 'docs', `${id}.json`);
    if (!existsSync(file)) return null;
    const session = new DocSession(this, file);
    this.docs.set(id, session);
    return session;
  }
  review(docId) {
    const d = this.doc(docId);
    if (!d) return null;
    if (!this.reviews.has(docId)) this.reviews.set(docId, new ReviewSession(this, d));
    return this.reviews.get(docId);
  }
  assets() {
    const dir = join(this.dir, 'assets');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => /\.(png|jpe?g|webp|gif|svg)$/i.test(f)).sort().map((f) => ({ path: `assets/${f}`, bytes: statSync(join(dir, f)).size }));
  }
}

export class Store {
  /** @param {{roots:string[], createIn?:string}} opts */
  constructor({ roots, createIn }) {
    this.roots = roots.map((r) => resolve(r));
    this.createIn = resolve(createIn ?? roots[0]);
    this.platforms = readJson(join(ROOT, 'data', 'platforms.json'));
    this.projects = new Map();
  }

  scan() {
    const seen = new Set();
    for (const root of this.roots) {
      if (!existsSync(root)) continue;
      for (const name of readdirSync(root)) {
        const dir = join(root, name);
        if (!ID.test(name) || !existsSync(join(dir, 'brand.json')) || !statSync(dir).isDirectory()) continue;
        seen.add(name);
        if (!this.projects.has(name)) this.projects.set(name, new Project(name, dir, this.platforms));
      }
    }
    for (const id of [...this.projects.keys()]) if (!seen.has(id)) this.projects.delete(id);
    return [...this.projects.values()];
  }

  project(id) {
    if (!ID.test(id)) return null;
    this.scan();
    return this.projects.get(id) ?? null;
  }

  list() {
    return this.scan().map((p) => {
      const brand = p.brand;
      return { id: p.id, name: brand.name, brand: brand.id, colors: brand.colors, docs: p.listDocs() };
    });
  }

  createProject({ name }) {
    const id = this.#unique(slug(name, 'project'), (c) => existsSync(join(this.createIn, c)));
    const dir = join(this.createIn, id);
    const brand = {
      $schema: '../../schemas/brand.schema.json',
      schema: 'nordle.brand/0.1', id, name: String(name).trim() || id,
      colors: { ink: '#1F2933', paper: '#FAF7F2', accent: '#C2410C', accentDark: '#9A3412', muted: '#6B7280' },
      fonts: {
        display: { family: 'Fraunces', weights: [600, 700], source: 'google' },
        body: { family: 'Inter', weights: [400, 600], source: 'google' },
      },
      voice: { tone: [], bannedPhrases: [] },
      motion: { personality: 'calm', ease: 'out-cubic' },
    };
    mkdirSync(join(dir, 'docs'), { recursive: true });
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeAtomic(join(dir, 'brand.json'), `${JSON.stringify(brand, null, 2)}\n`);
    return this.project(id);
  }

  createDoc(projectId, { title, kind = 'carousel', sizes }) {
    const project = this.project(projectId);
    if (!project) return null;
    if (!['graphic', 'carousel'].includes(kind)) throw new Error('New documents can be a graphic or a carousel for now.');
    const brand = project.brand;
    const chosen = (sizes?.length ? sizes : kind === 'carousel' ? ['ig-feed-4x5'] : ['ig-feed-4x5']);
    const id = this.#unique(slug(title, 'post'), (c) => existsSync(join(project.dir, 'docs', `${c}.json`)));
    const doc = {
      $schema: '../../../schemas/doc.schema.json',
      schema: 'nordle.doc/0.1', id, title: String(title).trim() || id, kind, brand: brand.id, sizes: chosen,
      copy: {},
      pages: [{ id: 'page-1', title: 'Page 1', background: brand.colors.paper ? '$brand.colors.paper' : '#ffffff', layers: [] }],
    };
    writeAtomic(join(project.dir, 'docs', `${id}.json`), `${JSON.stringify(doc, null, 2)}\n`);
    return project.doc(id);
  }

  #unique(base, taken) {
    if (!taken(base)) return base;
    for (let i = 2; i < 1000; i++) if (!taken(`${base}-${i}`)) return `${base}-${i}`;
    return `${base}-${randomBytes(3).toString('hex')}`;
  }
}

export { writeAtomic };
