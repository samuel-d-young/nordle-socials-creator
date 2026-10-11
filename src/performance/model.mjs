// The performance numbers for one project: <project>/metrics.json (schemas/metrics.schema.json). Load, validate, save atomically,
// change under a short lock (same pattern as the calendar), and the saved reviews under <project>/reviews/.
// Nothing here estimates a number: an entry is what a platform showed, typed in or imported by the owner.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { ROOT } from '../../tools/validate.mjs';
import { withFileLock } from '../calendar/lock.mjs';
import { isDate } from '../calendar/dates.mjs';
import { parsePeriod } from './period.mjs';

export const SCHEMA = 'nordle.metrics/0.1';
export const WINDOWS = ['7d', '28d', 'lifetime'];
export const SOURCES = ['csv', 'manual', 'buffer', 'meta'];
/** Every number a metrics entry may hold, with a plain label for the Studio and the prompts. */
export const METRIC_LABELS = {
  reach: 'Reach', impressions: 'Impressions', plays: 'Plays', views: 'Views', likes: 'Likes', comments: 'Comments', shares: 'Shares', saves: 'Saves',
  follows: 'Follows', profileVisits: 'Profile visits', linkClicks: 'Link clicks', watchTimeSec: 'Watch time (s)', avgWatchSec: 'Average watch (s)',
  completionRate: 'Completion rate', dmStarts: 'DM starts', swipes: 'Swipes',
};
export const METRIC_KEYS = Object.keys(METRIC_LABELS);

export class PerformanceError extends Error {
  constructor(status, message, errors) { super(message); this.name = 'PerformanceError'; this.status = status; this.errors = errors ?? [{ path: '/', message }]; }
}

let validate;
function validator() {
  if (validate) return validate;
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictRequired: false });
  addFormats(ajv);
  validate = ajv.compile(JSON.parse(readFileSync(join(ROOT, 'schemas', 'metrics.schema.json'), 'utf8')));
  return validate;
}

export const metricsPath = (projectDir) => join(projectDir, 'metrics.json');
export const newMetrics = (brand, extra = {}) => ({ schema: SCHEMA, brand, ...extra, items: [] });
export const entryKey = (e) => `${e.post}|${e.platform}|${e.window}`;

/** @returns {{ok:boolean, errors:string[]}} */
export function validateMetrics(data) {
  const v = validator();
  const errors = [];
  if (!v(data)) for (const e of v.errors) errors.push(`${e.instancePath || '/'}: ${e.message}${e.params?.additionalProperty ? ` (${e.params.additionalProperty})` : ''}`);
  const seen = new Set();
  for (const e of data?.items ?? []) {
    const k = entryKey(e);
    if (seen.has(k)) errors.push(`duplicate entry for post "${e.post}" on ${e.platform}, window ${e.window}`);
    seen.add(k);
    if (e.publishedAt !== undefined && !/^\d{4}-\d{2}-\d{2}/.test(e.publishedAt)) errors.push(`/items: publishedAt "${e.publishedAt}" must start with a date (YYYY-MM-DD)`);
    if (e.capturedAt && !isDate(String(e.capturedAt).slice(0, 10))) errors.push(`/items: capturedAt "${e.capturedAt}" is not a real date`);
  }
  return { ok: errors.length === 0, errors };
}

export function loadMetrics(projectDir, brand = '') {
  const file = metricsPath(projectDir);
  if (!existsSync(file)) return newMetrics(brand || basename(resolve(projectDir)));
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function saveMetrics(projectDir, data) {
  const r = validateMetrics(data);
  if (!r.ok) throw new Error(`metrics.json would be invalid:\n${r.errors.join('\n')}`);
  const file = metricsPath(projectDir);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, file);
  return data;
}

const chains = new Map();
const readJsonIf = (file) => { try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null; } catch { return null; } };

/** Load, let fn change it, save atomically if it changed. Serialised in this process and across processes (.metrics.lock). */
export function mutateMetrics(projectDir, fn) {
  const dir = resolve(projectDir);
  const run = (chains.get(dir) ?? Promise.resolve()).catch(() => {}).then(() => withFileLock(join(dir, '.metrics.lock'), async () => {
    const brand = readJsonIf(join(dir, 'brand.json'))?.id ?? basename(dir);
    const data = loadMetrics(dir, brand);
    const before = JSON.stringify(data);
    const result = await fn(data);
    if (JSON.stringify(data) !== before) {
      try { saveMetrics(dir, data); } catch (e) { throw new PerformanceError(422, String(e.message).split('\n').slice(0, 6).join('; ')); }
    }
    return result;
  }));
  chains.set(dir, run.catch(() => {}));
  return run;
}

// ---- cleaning one entry ------------------------------------------------------------------------------------------------------

const toNumber = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.replace(/[,\s]/g, '').replace(/%$/, '');
  if (!s || !/^-?\d*\.?\d+$/.test(s)) return null;
  return Number(s);
};

/** Check and tidy a metrics object: unknown keys and negatives are errors; a completion rate given as 45 (percent) becomes 0.45. */
export function cleanMetrics(input) {
  const metrics = {}, errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { metrics, errors: [{ path: '/metrics', message: 'metrics must be an object of numbers' }] };
  for (const [k, raw] of Object.entries(input)) {
    if (raw === null || raw === undefined || raw === '') continue;
    if (!METRIC_KEYS.includes(k)) { errors.push({ path: `/metrics/${k}`, message: `unknown metric "${k}". Metrics: ${METRIC_KEYS.join(', ')}` }); continue; }
    let n = toNumber(raw);
    if (n === null) { errors.push({ path: `/metrics/${k}`, message: `${k} must be a number (got "${raw}")` }); continue; }
    if (n < 0) { errors.push({ path: `/metrics/${k}`, message: `${k} cannot be negative` }); continue; }
    if (k === 'completionRate' && n > 1) n /= 100;
    if (k === 'completionRate' && n > 1) { errors.push({ path: '/metrics/completionRate', message: 'completionRate is a share between 0 and 1 (or a percentage up to 100)' }); continue; }
    metrics[k] = n;
  }
  if (!Object.keys(metrics).length && !errors.length) errors.push({ path: '/metrics', message: 'Give at least one number.' });
  return { metrics, errors };
}

/** A whole entry from loose input. Returns { entry, errors }. `today` fills capturedAt. */
export function cleanEntry(input, { today, defaults = {} } = {}) {
  const errors = [];
  const src = { ...defaults, ...(input ?? {}) };
  const { metrics, errors: me } = cleanMetrics(src.metrics);
  errors.push(...me);
  const post = String(src.post ?? '').trim();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(post)) errors.push({ path: '/post', message: 'post must be a calendar item id' });
  const platform = String(src.platform ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(platform)) errors.push({ path: '/platform', message: 'say which platform (instagram, facebook, tiktok, linkedin ...)' });
  const window = src.window ?? '7d';
  if (!WINDOWS.includes(window)) errors.push({ path: '/window', message: `window must be one of ${WINDOWS.join(', ')}` });
  const capturedAt = String(src.capturedAt ?? today ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(capturedAt) || !isDate(capturedAt.slice(0, 10))) errors.push({ path: '/capturedAt', message: 'capturedAt must be a date (YYYY-MM-DD): the day the numbers were read off the platform' });
  const source = src.source ?? 'manual';
  if (!SOURCES.includes(source)) errors.push({ path: '/source', message: `source must be one of ${SOURCES.join(', ')}` });
  if (src.publishedAt !== undefined && src.publishedAt !== null && src.publishedAt !== '' && !/^\d{4}-\d{2}-\d{2}/.test(String(src.publishedAt))) errors.push({ path: '/publishedAt', message: 'publishedAt must start with a date (YYYY-MM-DD)' });
  const entry = {
    post, platform, ...(src.publishedAt ? { publishedAt: String(src.publishedAt) } : {}), capturedAt, window, metrics, source,
    ...(src.by ? { by: src.by } : {}), ...(src.note ? { note: String(src.note).slice(0, 500) } : {}),
  };
  return { entry, errors };
}

/**
 * Add or replace entries (one per post, platform and window: a newer capture replaces the older one). role 'agent' entries are
 * stamped by: 'claude'. Every post must be on the calendar. Returns { added, replaced, rejected:[{input,errors}] }.
 */
export async function upsertEntries(projectDir, inputs, { role = 'agent', today, defaults = {}, requirePost = true } = {}) {
  const dir = resolve(projectDir);
  const list = Array.isArray(inputs) ? inputs : [inputs];
  if (!list.length) throw new PerformanceError(400, 'Give at least one entry.');
  if (list.length > 500) throw new PerformanceError(400, 'At most 500 entries at a time.');
  const calendar = readJsonIf(join(dir, 'calendar.json'));
  const ids = new Set((calendar?.items ?? []).map((i) => i.id));
  return mutateMetrics(dir, (data) => {
    const added = [], replaced = [], rejected = [];
    for (const input of list) {
      const { entry, errors } = cleanEntry(input, { today, defaults });
      if (requirePost && entry.post && !ids.has(entry.post)) errors.push({ path: '/post', message: `there is no calendar item "${entry.post}"` });
      if (errors.length) { rejected.push({ input, errors }); continue; }
      entry.by = role === 'human' ? 'owner' : 'claude';
      const i = data.items.findIndex((e) => entryKey(e) === entryKey(entry));
      if (i >= 0) { replaced.push({ before: data.items[i], after: entry }); data.items[i] = entry; } else { data.items.push(entry); added.push(entry); }
    }
    data.items.sort((a, b) => a.post.localeCompare(b.post) || a.platform.localeCompare(b.platform) || a.window.localeCompare(b.window));
    return { added, replaced: replaced.map((r) => r.after), rejected };
  });
}

/** Manual entry (the Studio's "Add results" form, `performance add`, Claude's tool). One post, one platform, one window. */
export async function addManualMetrics(projectDir, input, opts = {}) {
  const r = await upsertEntries(projectDir, [{ ...input, source: 'manual' }], opts);
  if (r.rejected.length) throw new PerformanceError(422, r.rejected[0].errors.map((e) => `${e.path}: ${e.message}`).join('; '), r.rejected[0].errors);
  return { entry: r.added[0] ?? r.replaced[0], replaced: r.replaced.length > 0 };
}

// ---- saved reviews -----------------------------------------------------------------------------------------------------------

export const reviewsDir = (projectDir) => join(projectDir, 'reviews');
const reviewFile = (projectDir, period, ext) => join(reviewsDir(projectDir), `${period}.${ext}`);

export function listReviews(projectDir) {
  const dir = reviewsDir(projectDir);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.md'))) {
    const id = f.slice(0, -3);
    const p = parsePeriod(id);
    if (!p) continue;
    const meta = readJsonIf(reviewFile(projectDir, id, 'json'));
    out.push({
      period: id, kind: p.kind, label: p.label, from: p.from, to: p.to, savedAt: meta?.savedAt ?? new Date(statSync(join(dir, f)).mtimeMs).toISOString(),
      directions: meta?.directions ?? [], mix: meta?.mix ?? null, mixApplied: meta?.mixAppliedAt ?? null, by: meta?.by ?? null, changes: meta?.changes ?? null,
    });
  }
  return out.sort((a, b) => b.from.localeCompare(a.from) || (a.kind === 'month' ? -1 : 1));
}

export function readReview(projectDir, period) {
  if (!parsePeriod(period)) throw new PerformanceError(400, `"${period}" is not a period (use 2026-11 or 2026-W45).`);
  const md = reviewFile(projectDir, period, 'md');
  if (!existsSync(md)) return null;
  const meta = readJsonIf(reviewFile(projectDir, period, 'json')) ?? {};
  return { period, markdown: readFileSync(md, 'utf8'), meta };
}

/** Write reviews/<period>.md (the text the owner reads) and reviews/<period>.json (directions, the recommended mix, what was changed). */
export function writeReview(projectDir, period, { markdown, meta = {} }) {
  const p = parsePeriod(period);
  if (!p) throw new PerformanceError(400, `"${period}" is not a period (use 2026-11 or 2026-W45).`);
  if (typeof markdown !== 'string' || markdown.trim().length < 20) throw new PerformanceError(400, 'The review text is empty.');
  if (markdown.length > 60000) throw new PerformanceError(400, 'The review is over 60,000 characters.');
  const dir = reviewsDir(projectDir);
  mkdirSync(dir, { recursive: true });
  const put = (file, text) => { const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, text); renameSync(tmp, file); };
  put(reviewFile(projectDir, period, 'md'), `${markdown.trim()}\n`);
  put(reviewFile(projectDir, period, 'json'), `${JSON.stringify({ period, kind: p.kind, savedAt: new Date().toISOString(), ...meta }, null, 2)}\n`);
  return readReview(projectDir, period);
}

export function patchReviewMeta(projectDir, period, patch) {
  const file = reviewFile(projectDir, period, 'json');
  const cur = readJsonIf(file) ?? { period };
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...cur, ...patch }, null, 2)}\n`);
  renameSync(tmp, file);
}
