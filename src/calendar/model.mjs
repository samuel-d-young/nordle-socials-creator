// The content calendar for one project: load, save, validate. Pure data; building posts is src/calendar/run.mjs.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { ROOT } from '../../tools/validate.mjs';

let validate;
function validator() {
  if (validate) return validate;
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictRequired: false });
  addFormats(ajv);
  validate = ajv.compile(JSON.parse(readFileSync(join(ROOT, 'schemas', 'calendar.schema.json'), 'utf8')));
  return validate;
}

export const calendarPath = (projectDir) => join(projectDir, 'calendar.json');

export function newCalendar(brand, extra = {}) {
  return { schema: 'nordle.calendar/0.1', brand, ...extra, items: [] };
}

/** @returns {{ok:boolean, errors:string[]}} */
export function validateCalendar(cal) {
  const v = validator();
  const errors = [];
  if (!v(cal)) for (const e of v.errors) errors.push(`${e.instancePath || '/'}: ${e.message}${e.params?.additionalProperty ? ` (${e.params.additionalProperty})` : ''}`);
  const seen = new Set();
  for (const it of cal.items ?? []) {
    if (seen.has(it.id)) errors.push(`duplicate item id "${it.id}"`);
    seen.add(it.id);
  }
  return { ok: errors.length === 0, errors };
}

export function loadCalendar(projectDir, brand = '') {
  const file = calendarPath(projectDir);
  if (!existsSync(file)) return newCalendar(brand);
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function saveCalendar(projectDir, cal) {
  const r = validateCalendar(cal);
  if (!r.ok) throw new Error(`calendar.json would be invalid:\n${r.errors.join('\n')}`);
  const file = calendarPath(projectDir);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cal, null, 2)}\n`);
  renameSync(tmp, file);
  return cal;
}

export const monthOf = (date) => date.slice(0, 7);

/** Counts per month and format, for the "13 a month" quotas. */
export function monthStats(cal) {
  const out = {};
  for (const it of cal.items) {
    if (it.status === 'rejected') continue;
    const m = (out[monthOf(it.date)] ??= { total: 0, byFormat: {}, byStatus: {} });
    m.total++;
    m.byFormat[it.format] = (m.byFormat[it.format] ?? 0) + 1;
    m.byStatus[it.status] = (m.byStatus[it.status] ?? 0) + 1;
  }
  return out;
}

/** Approved items whose date is within `leadDays` of `today` (ISO date) and that have no document yet. */
export function dueItems(cal, today, leadDays = cal.settings?.leadDays ?? 7) {
  const limit = new Date(`${today}T00:00:00Z`);
  limit.setUTCDate(limit.getUTCDate() + leadDays);
  const cut = limit.toISOString().slice(0, 10);
  return cal.items.filter((it) => it.status === 'approved' && !it.doc && it.date <= cut).sort((a, b) => a.date.localeCompare(b.date));
}
