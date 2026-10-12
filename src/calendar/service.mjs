// Everything that reads or changes a project's calendar, in one place, so the CLI, the server routes and the runner all
// follow the same rules. The one rule that matters most: only the owner approves, rejects, signs off or asks for changes.
// Claude (role 'agent') can add ideas, edit them, and link a finished post; it can never move an item along the owner's steps.
//
// Roles: 'human' = the owner (editor page, or the command line on their machine); 'agent' = Claude through the MCP server or
// a headless run; 'system' = the runner marking an item as being built.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, delimiter, join, resolve } from 'node:path';
import { ROOT } from '../../tools/validate.mjs';
import { dueItems, loadCalendar, saveCalendar, validateCalendar } from './model.mjs';
import { DEFAULT_LEAD_DAYS, DEFAULT_POST_TIMES, FORMATS, ideaLint, lintCalendar, monthReport, quotaOf } from './plan.mjs';
import { DEFAULT_TIMEZONE, addMonths, diffDays, isDate, monthEnd, monthOf, monthStart, monthsBetween, todayIn } from './dates.mjs';
import { occasionsBetween } from './occasions.mjs';
import { readRunLock, withFileLock } from './lock.mjs';
import { cleanReel } from '../shared/reel-options.mjs';

export class CalendarError extends Error {
  constructor(status, message, errors) { super(message); this.name = 'CalendarError'; this.status = status; this.errors = errors ?? [{ path: '/', message }]; }
}

// ---- projects ----------------------------------------------------------------------------------------------------------

export const projectRoots = () => (process.env.NORDLE_PROJECTS ? process.env.NORDLE_PROJECTS.split(delimiter).filter(Boolean) : [join(ROOT, 'projects')]);

/** A project folder from a path or from an id under the projects folder(s). */
export function resolveProject(arg, roots = projectRoots()) {
  if (!arg) throw new CalendarError(400, 'Say which project (its folder, or its id under projects/).');
  const pathLike = /[\\/]/.test(arg) || /^[A-Za-z]:/.test(arg) || arg.startsWith('.');
  const candidates = pathLike ? [resolve(arg)] : [...roots.map((r) => join(resolve(r), arg)), resolve(arg)];
  const dir = candidates.find((d) => existsSync(join(d, 'brand.json')));
  if (!dir) throw new CalendarError(404, `There is no Nordle project "${arg}" (a project folder has a brand.json). Looked in: ${candidates.join(', ')}`);
  return { dir, id: basename(dir) };
}

export function listProjects(roots = projectRoots()) {
  const out = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      const dir = join(resolve(root), name);
      if (/^[a-z0-9][a-z0-9_-]*$/.test(name) && existsSync(join(dir, 'brand.json')) && statSync(dir).isDirectory()) out.push({ id: name, dir });
    }
  }
  return out;
}

const readJsonIf = (file) => { try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null; } catch { return null; } };

/** Everything the planner needs about a project, read fresh from disk. */
export function loadProject(projectDir) {
  const dir = resolve(projectDir);
  const brand = readJsonIf(join(dir, 'brand.json')) ?? {};
  const facts = readJsonIf(join(dir, 'facts.json'));
  const cal = loadCalendar(dir, brand.id ?? basename(dir));
  const timezone = cal.timezone ?? readJsonIf(join(dir, 'nordle.project.json'))?.timezone ?? DEFAULT_TIMEZONE;
  return { dir, id: basename(dir), brand, facts, cal, timezone, settings: effectiveSettings(cal), today: todayIn(timezone) };
}

/** The calendar's settings with every default filled in. */
export function effectiveSettings(cal) {
  const s = cal.settings ?? {};
  return {
    leadDays: s.leadDays ?? DEFAULT_LEAD_DAYS,
    perMonth: quotaOf(cal),
    autoBuild: !!s.autoBuild,
    autoPropose: !!s.autoPropose,
    autoRevise: s.autoRevise !== false,   // on unless the owner turns it off: "Request changes" in the Studio starts the designer straight away
    horizonMonths: s.horizonMonths ?? 3,
    postTimes: s.postTimes?.length ? s.postTimes : DEFAULT_POST_TIMES,
    pillars: s.pillars ?? [],
    regions: s.regions ?? [],
    ideaApproval: s.ideaApproval ?? 'owner',
    compliance: s.compliance ?? [],
    maxBuildAttempts: s.maxBuildAttempts ?? 3,
    claudeModel: s.claudeModel ?? null, claudeEffort: s.claudeEffort ?? null, maxBudgetUsd: s.maxBudgetUsd ?? null,
    review: s.review ? { cadence: s.review.cadence ?? null, weekday: s.review.weekday ?? 'monday', autoReview: !!s.review.autoReview } : null,
  };
}

// ---- writing -----------------------------------------------------------------------------------------------------------

const chains = new Map();

/**
 * Load the calendar, let fn change it, and save it atomically if it changed. Serialised within this process and across
 * processes (a short lock file), so two writers never lose each other's change. fn may be async; throw to cancel.
 */
export function mutateCalendar(projectDir, fn) {
  const dir = resolve(projectDir);
  const run = (chains.get(dir) ?? Promise.resolve()).catch(() => {}).then(() => withFileLock(join(dir, '.calendar.lock'), async () => {
    const brand = readJsonIf(join(dir, 'brand.json')) ?? {};
    const cal = loadCalendar(dir, brand.id ?? basename(dir));
    const before = JSON.stringify(cal);
    const result = await fn(cal, { brand, facts: readJsonIf(join(dir, 'facts.json')), timezone: cal.timezone ?? readJsonIf(join(dir, 'nordle.project.json'))?.timezone ?? DEFAULT_TIMEZONE });
    if (JSON.stringify(cal) !== before) {
      try { saveCalendar(dir, cal); } catch (e) { throw new CalendarError(422, String(e.message).split('\n').slice(0, 6).join('; ')); }
    }
    return result;
  }));
  chains.set(dir, run.catch(() => {}));
  return run;
}

const nowIso = () => new Date().toISOString();
const slugify = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export function makeItemId(cal, date, title) {
  const base = `${date}-${slugify(title) || 'post'}`.slice(0, 64).replace(/-+$/, '');
  const taken = new Set(cal.items.map((i) => i.id));
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

export const EDITABLE = ['date', 'time', 'format', 'title', 'pillar', 'idea', 'hook', 'audience', 'occasion', 'mediaPlan', 'notes', 'campaign', 'reel', 'guidance'];
const CONTENT = ['date', 'format', 'title', 'pillar', 'idea', 'hook', 'audience', 'occasion', 'mediaPlan', 'reel', 'guidance'];
const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
// fields the server owns: a caller may send an item back whole, and these are ignored (never written from the outside)
const SERVER_KEYS = new Set(['id', 'status', 'comment', 'origin', 'ideaApproval', 'doc', 'external', 'run', 'feedback', 'updated', 'pendingChanges', 'queuedRevise']);

/** Pick and check the editable fields. Returns { fields, errors:[{path,message}] }. null clears a field. */
export function cleanFields(input, { forAdd = false } = {}) {
  const fields = {}, errors = [];
  for (const k of Object.keys(input)) if (!EDITABLE.includes(k) && !SERVER_KEYS.has(k)) errors.push({ path: `/${k}`, message: `unknown field "${k}". Fields: ${EDITABLE.join(', ')}` });
  for (const k of EDITABLE) {
    if (input[k] === undefined) continue;
    if (k === 'reel') {   // an object: { style, uses, seconds }
      const r = cleanReel(input.reel);
      errors.push(...r.errors);
      if (r.value) fields.reel = r.value; else if (input.reel === null && !forAdd) fields.reel = null;
      continue;
    }
    if (input[k] === null || (typeof input[k] === 'string' && !input[k].trim())) { if (!forAdd) fields[k] = null; continue; }
    if (typeof input[k] !== 'string') { errors.push({ path: `/${k}`, message: `${k} must be text` }); continue; }
    fields[k] = input[k].trim();
  }
  if (fields.date !== undefined && !isDate(fields.date)) errors.push({ path: '/date', message: `"${fields.date}" is not a real date (use YYYY-MM-DD)` });
  if (fields.format !== undefined && !FORMATS.includes(fields.format)) errors.push({ path: '/format', message: `format must be one of ${FORMATS.join(', ')}` });
  if (fields.time && !TIME.test(fields.time)) errors.push({ path: '/time', message: `time must look like 18:30` });
  if (fields.guidance && fields.guidance.length > 2000) errors.push({ path: '/guidance', message: 'guidance is over 2000 characters' });
  if (fields.title && fields.title.length > 140) errors.push({ path: '/title', message: 'title is over 140 characters' });
  if (forAdd) for (const k of ['date', 'format', 'title']) if (!fields[k]) errors.push({ path: `/${k}`, message: `${k} is required` });
  return { fields, errors };
}

const plain = (list) => list.map((e) => ({ path: e.path ?? '/', message: e.message ?? String(e) }));

const monthsTouched = (items) => [...new Set(items.map((i) => monthOf(i.date)))].sort();

/**
 * Add ideas. role 'agent' (Claude): they arrive as status idea (or approved, when the owner has set ideaApproval to
 * delegated), and the checks are strict: an idea that repeats another, uses a banned phrase, is in the past, or would
 * push a month over its quota is refused, with the reasons. role 'human': the owner's own items are approved (status 'idea'
 * if asked); lint problems come back as warnings unless strict. delegated:true (the owner's machine, "go ahead without
 * asking me") makes ideas arrive approved with ideaApproval 'delegated' and applies the strict checks.
 * @returns {Promise<{added:object[], rejected:{input:object,errors:object[],warnings:object[]}[], warnings:Object<string,object[]>, months:object[]}>}
 */
export async function addItems(projectDir, inputs, { role = 'agent', today, delegated = false, force = false, strict, status } = {}) {
  const list = Array.isArray(inputs) ? inputs : [inputs];
  if (!list.length) throw new CalendarError(400, 'Give at least one idea.');
  if (list.length > 60) throw new CalendarError(400, 'At most 60 ideas at a time.');
  if (force && role !== 'human') throw new CalendarError(403, 'Only the owner can override the checks.');
  return mutateCalendar(projectDir, async (cal, { brand, facts, timezone }) => {
    const eff = effectiveSettings(cal);
    const day = today ?? todayIn(timezone);
    const delegatedNow = role === 'human' ? delegated : eff.ideaApproval === 'delegated';
    const strictLint = strict ?? (role !== 'human' || delegated);
    const added = [], rejected = [], warnings = {};
    for (const input of list) {
      const { fields, errors } = cleanFields(input ?? {}, { forAdd: true });
      if (fields.campaign && !(cal.campaigns ?? []).some((c) => c.id === fields.campaign)) errors.push({ path: '/campaign', message: `there is no campaign "${fields.campaign}". Make it first.` });
      if (fields.reel && fields.format !== 'reel') errors.push({ path: '/reel', message: 'reel options only apply to a reel' });
      const asked = status ?? input?.status;
      if (asked !== undefined && !['idea', 'approved'].includes(asked)) errors.push({ path: '/status', message: 'a new item starts as "idea" or "approved"' });
      if (role !== 'human' && asked === 'approved' && !delegatedNow) {
        errors.push({ path: '/status', message: 'Only the owner can approve ideas. Leave status out: new ideas start as "idea".' });
      }
      if (errors.length) { rejected.push({ input, errors: plain(errors), warnings: [] }); continue; }

      // the owner's own items are approved unless they say otherwise; Claude's are ideas unless the owner delegated approval
      const approved = role === 'human' ? delegated || (asked ?? 'approved') === 'approved' : delegatedNow;
      const item = {
        id: makeItemId(cal, fields.date, fields.title),
        ...fields,
        status: approved ? 'approved' : 'idea',
        origin: role === 'human' && !delegated ? 'owner' : 'claude',
        ...(approved ? { ideaApproval: delegatedNow ? 'delegated' : 'owner' } : {}),
        updated: nowIso(),
      };
      const lint = ideaLint(item, { brand, facts, existing: cal.items, today: day, cal, strict: strictLint, checkQuota: strictLint, regions: eff.regions });
      if (!lint.ok && !force && (strictLint || role !== 'human')) { rejected.push({ input, errors: lint.errors, warnings: lint.warnings }); continue; }
      cal.items.push(item);
      added.push(item);
      // the owner's own items are never blocked: what would have been an error is shown as a warning
      const carried = lint.errors.map((e) => ({ ...e, level: 'warn', overridden: true }));
      if (lint.warnings.length || carried.length) warnings[item.id] = [...carried, ...lint.warnings];
    }
    cal.items.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? '').localeCompare(b.time ?? ''));
    return { added, rejected, warnings, months: monthsTouched(added).map((m) => monthReport(cal, m)) };
  });
}

function findItem(cal, id) {
  const item = cal.items.find((i) => i.id === id);
  if (!item) throw new CalendarError(404, `There is no calendar item "${id}".`);
  return item;
}

const OWNER_ONLY = new Set(['approved', 'rejected', 'signed-off', 'changes', 'posted', 'idea', 'scheduled']);

/**
 * Edit an item's fields. Both roles may; the owner may also pass status (it goes through the same steps as approve, reject,
 * ...). Claude may not touch the owner's steps: setting a status other than building/approved-to-building is refused, and when
 * Claude changes what an owner-approved idea says, the idea goes back to "idea" for approval again.
 * @returns {Promise<{item:object, lint:object}>}
 */
export function updateItem(projectDir, id, input, { role = 'agent', today } = {}) {
  return mutateCalendar(projectDir, async (cal, { brand, facts, timezone }) => {
    const item = findItem(cal, id);
    const eff = effectiveSettings(cal);
    const { fields, errors } = cleanFields(input ?? {});
    if (fields.campaign && !(cal.campaigns ?? []).some((c) => c.id === fields.campaign)) errors.push({ path: '/campaign', message: `there is no campaign "${fields.campaign}".` });
    if (fields.reel && (fields.format ?? item.format) !== 'reel') errors.push({ path: '/reel', message: 'reel options only apply to a reel' });
    if (errors.length) throw new CalendarError(400, errors.map((e) => `${e.path}: ${e.message}`).join('; '), errors);
    const wantStatus = input?.status;
    if (wantStatus !== undefined && wantStatus !== item.status) {
      if (role === 'human') applyTransition(cal, item, statusToAction(item, wantStatus), { comment: input?.comment });
      else if (!(item.status === 'approved' && wantStatus === 'building') && !(item.status === 'building' && wantStatus === 'approved') && !(item.status === 'changes' && wantStatus === 'building')) {
        throw new CalendarError(403, OWNER_ONLY.has(wantStatus) ? 'Only the owner can do that, in the editor.' : `An item cannot go from ${item.status} to ${wantStatus} that way.`);
      } else item.status = wantStatus;
    }
    const keys = Object.keys(fields);
    if (role !== 'human') {
      if (['built', 'signed-off', 'scheduled', 'posted', 'rejected'].includes(item.status) && keys.some((k) => k !== 'notes')) {
        throw new CalendarError(409, `This item is ${item.status}: only its notes can be changed. Ask the owner to request changes.`);
      }
      if (keys.some((k) => CONTENT.includes(k) && fields[k] !== item[k]) && item.status === 'approved' && item.ideaApproval !== 'delegated') {
        item.status = 'idea';
        delete item.ideaApproval;
      }
    }
    for (const [k, v] of Object.entries(fields)) { if (v === null) delete item[k]; else item[k] = v; }
    if (role === 'human' && item.run?.state === 'gave-up') delete item.run;   // the owner touched it: let the runner try again
    if (keys.length) item.updated = nowIso();
    const lint = ideaLint(item, { brand, facts, existing: cal.items, today: today ?? todayIn(timezone), cal, strict: role !== 'human', checkQuota: role !== 'human', regions: eff.regions });
    if (role !== 'human' && !lint.ok && keys.some((k) => CONTENT.includes(k))) {
      throw new CalendarError(422, `That edit breaks the checks: ${lint.errors.map((e) => e.message).join(' ')}`, lint.errors.map((e) => ({ path: '/', message: e.message })));
    }
    cal.items.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? '').localeCompare(b.time ?? ''));
    return { item, lint };
  });
}

// ---- the owner's steps -------------------------------------------------------------------------------------------------

const TRANSITIONS = {
  approve: { from: ['idea', 'rejected', 'approved'] },
  unapprove: { from: ['approved'] },
  reject: { from: ['idea', 'approved', 'building', 'built', 'changes', 'signed-off'] },
  signoff: { from: ['built', 'signed-off'], needsDoc: true },
  changes: { from: ['built', 'signed-off', 'changes', 'building'], needsComment: true },   // from `building` the change waits in line (pendingChanges) and starts when the build is done
  posted: { from: ['signed-off', 'built', 'scheduled', 'posted'] },
  retry: { from: ['approved', 'changes'] },       // forget the runner's failed attempts so it tries again
};
export const ACTIONS = Object.keys(TRANSITIONS);

function statusToAction(item, to) {
  const map = { approved: 'approve', idea: 'unapprove', rejected: 'reject', 'signed-off': 'signoff', changes: 'changes', posted: 'posted' };
  if (!map[to]) throw new CalendarError(400, `Status "${to}" cannot be set by hand (the runner sets building and built).`);
  return map[to];
}

function applyTransition(cal, item, action, { comment }) {
  const t = TRANSITIONS[action];
  if (!t) throw new CalendarError(400, `Unknown action "${action}". Actions: ${ACTIONS.join(', ')}.`);
  if (!t.from.includes(item.status)) {
    const done = { approve: 'approved', unapprove: 'unapproved', reject: 'rejected', signoff: 'signed off', changes: 'sent back for changes', posted: 'marked as posted', retry: 'retried' }[action];
    throw new CalendarError(409, `A ${item.status} item cannot be ${done}.`);
  }
  if (t.needsDoc && !item.doc && !item.external) throw new CalendarError(409, 'There is nothing to sign off yet: no post has been built for this item.');
  if (t.needsComment && !String(comment ?? '').trim()) throw new CalendarError(400, 'Say what should change (a comment is required).');
  const at = nowIso();
  switch (action) {
    case 'approve':
      item.status = item.status === 'rejected' && (item.doc || item.external) ? 'built' : 'approved';
      item.ideaApproval = 'owner';
      delete item.run;
      break;
    case 'unapprove': item.status = 'idea'; delete item.ideaApproval; break;
    case 'reject': item.status = 'rejected'; if (comment) item.notes = [item.notes, `Rejected: ${comment}`].filter(Boolean).join('\n'); break;
    case 'signoff': item.status = 'signed-off'; break;
    case 'changes':
      if (item.status === 'building') {
        // Claude is working on this post right now: the request waits in line and is applied the moment the build is linked (see linkDoc)
        item.pendingChanges = [...(item.pendingChanges ?? []), { at, comment: String(comment).trim() }];
        break;
      }
      item.status = 'changes';
      item.feedback = [...(item.feedback ?? []), { at, by: 'owner', comment: String(comment).trim() }];
      delete item.run;
      break;
    case 'posted': item.status = 'posted'; break;
    case 'retry': delete item.run; break;
    default: break;
  }
  item.updated = at;
  return item;
}

/** The posts that went straight back for changes because the owner asked while they were being built: their ids, and the flag is cleared so each is started once. */
export function takeQueuedRevisions(projectDir) {
  return mutateCalendar(projectDir, (cal) => {
    const ids = [];
    for (const item of cal.items) if (item.queuedRevise) { delete item.queuedRevise; if (item.status === 'changes' && item.doc) ids.push(item.id); }
    return ids;
  });
}

/** approve | unapprove | reject | signoff | changes (needs a comment) | posted. Owner only: the caller must check the role. */
export function decide(projectDir, id, action, { comment } = {}) {
  return mutateCalendar(projectDir, (cal) => {
    const item = findItem(cal, id);
    applyTransition(cal, item, action, { comment });
    return { item };
  });
}

/**
 * Record that a signed-off (or, with the owner's per-post override, built) post has been handed to a publishing adapter that
 * holds it for a later time (Buffer, say): the item becomes "scheduled" and keeps item.publish = { adapter, scheduledAt?, remoteId?, at,
 * targets?: [{ channel, ok, scheduledAt?, remoteId? }] }. With several channels, pass `targets` (or record them one by one with
 * recordPublishTarget first): they are kept as the record. Owner only (role 'human'): src/publish/index.mjs calls it after a
 * successful run, never an agent. "posted" is reachable from here.
 */
export async function markScheduled(projectDir, id, { adapter, scheduledAt, remoteId, targets } = {}, { role = 'human' } = {}) {
  if (role !== 'human') throw new CalendarError(403, 'Only the owner can schedule posts, in the Studio.');
  return mutateCalendar(projectDir, (cal) => {
    const item = findItem(cal, id);
    if (!['signed-off', 'built'].includes(item.status)) throw new CalendarError(409, `A ${item.status} item cannot be marked as scheduled.`);
    if (!item.doc && !item.external) throw new CalendarError(409, 'There is nothing to schedule yet: no post has been built for this item.');
    if (typeof adapter !== 'string' || !adapter.trim()) throw new CalendarError(400, 'Say which adapter scheduled it.');
    const at = nowIso();
    const kept = Array.isArray(targets) ? targets : item.publish?.adapter === adapter.trim() ? item.publish.targets : undefined;
    const firstOk = (kept ?? []).filter((t) => t.ok).sort((a, b) => String(a.scheduledAt ?? '').localeCompare(String(b.scheduledAt ?? '')))[0];
    const when = scheduledAt ?? firstOk?.scheduledAt, rid = remoteId ?? firstOk?.remoteId;
    item.status = 'scheduled';
    item.publish = { adapter: adapter.trim(), ...(when ? { scheduledAt: String(when) } : {}), ...(rid ? { remoteId: String(rid) } : {}), at, ...(kept?.length ? { targets: kept.map(cleanTarget) } : {}) };
    item.updated = at;
    return { item };
  });
}

/**
 * A post (or some of its channels) is no longer in the publishing service, say because it was deleted there: forget those targets so the
 * post can be scheduled again. With no `remove` list every target goes. A post with nothing left scheduled goes back to "signed-off"; one
 * with other channels still scheduled also goes back to "signed-off" (the plan then shows those channels as done and offers the rest).
 * Owner only (role 'human').
 */
export async function markUnscheduled(projectDir, id, { remove } = {}, { role = 'human' } = {}) {
  if (role !== 'human') throw new CalendarError(403, 'Only the owner can reschedule posts, in the Studio.');
  return mutateCalendar(projectDir, (cal) => {
    const item = findItem(cal, id);
    if (item.status !== 'scheduled' && !item.publish) throw new CalendarError(409, `A ${item.status} item is not scheduled, so there is nothing to take back.`);
    const at = nowIso();
    const targets = item.publish?.targets ?? [];
    const gone = new Set(Array.isArray(remove) && remove.length ? remove.map(String) : targets.map((t) => t.channel));
    const kept = targets.filter((t) => !gone.has(t.channel));
    const firstOk = kept.filter((t) => t.ok).sort((a, b) => String(a.scheduledAt ?? '').localeCompare(String(b.scheduledAt ?? '')))[0];
    if (firstOk) item.publish = { adapter: item.publish.adapter, ...(firstOk.scheduledAt ? { scheduledAt: firstOk.scheduledAt } : {}), ...(firstOk.remoteId ? { remoteId: firstOk.remoteId } : {}), at, targets: kept };
    else delete item.publish;
    if (item.status === 'scheduled') item.status = 'signed-off';
    item.updated = at;
    return { item };
  });
}

const cleanTarget = (t) => ({ channel: String(t.channel), ok: !!t.ok, ...(t.scheduledAt ? { scheduledAt: String(t.scheduledAt) } : {}), ...(t.remoteId ? { remoteId: String(t.remoteId) } : {}), ...(t.message && !t.ok ? { message: String(t.message).slice(0, 300) } : {}), ...(t.at ? { at: String(t.at) } : {}) });

/**
 * Remember the result of ONE channel of a post (item.publish.targets), without changing the item's status: the post becomes
 * "scheduled" only when every channel the owner chose has gone (markScheduled). A success is never overwritten by a later failure, so
 * a retry that only redoes the failed channels cannot undo what already worked. Owner only (role 'human').
 */
export async function recordPublishTarget(projectDir, id, { adapter, channel, ok, scheduledAt, remoteId, message } = {}, { role = 'human' } = {}) {
  if (role !== 'human') throw new CalendarError(403, 'Only the owner can schedule posts, in the Studio.');
  return mutateCalendar(projectDir, (cal) => {
    const item = findItem(cal, id);
    if (!['signed-off', 'built'].includes(item.status)) throw new CalendarError(409, `A ${item.status} item cannot take a publishing result.`);
    if (typeof adapter !== 'string' || !adapter.trim() || typeof channel !== 'string' || !channel) throw new CalendarError(400, 'Say which adapter and which channel.');
    const at = nowIso();
    const pub = item.publish && item.publish.adapter === adapter.trim() ? item.publish : (item.publish = { adapter: adapter.trim(), at });
    const kept = (pub.targets ?? []).find((t) => t.channel === channel);
    if (!(kept?.ok && !ok)) {
      const next = cleanTarget({ channel, ok, scheduledAt, remoteId, message, at });
      const list = pub.targets ?? [];
      pub.targets = kept ? list.map((t) => (t.channel === channel ? next : t)) : [...list, next];   // a channel keeps its place in the list
    }
    pub.at = at;
    item.updated = at;
    return { item };
  });
}

/**
 * Take an item off the calendar (the Studio's "Remove": it keeps the item itself in the post's trash entry so it can come back).
 * Owner only: pass role 'human'. Returns { item }.
 */
export function removeItem(projectDir, id, { role = 'agent' } = {}) {
  if (role !== 'human') return Promise.reject(new CalendarError(403, 'Only the owner can remove a post, in the Studio.'));
  return mutateCalendar(projectDir, (cal) => {
    const i = cal.items.findIndex((x) => x.id === id);
    if (i < 0) throw new CalendarError(404, `There is no calendar item "${id}".`);
    const [item] = cal.items.splice(i, 1);
    return { item };
  });
}

/** Put a removed item back exactly as it was. Owner only. Refuses if something with that id is on the calendar now. */
export function restoreItem(projectDir, item, { role = 'agent' } = {}) {
  if (role !== 'human') return Promise.reject(new CalendarError(403, 'Only the owner can restore a post, in the Studio.'));
  return mutateCalendar(projectDir, (cal) => {
    if (cal.items.some((x) => x.id === item?.id)) throw new CalendarError(409, `The calendar already has an item "${item.id}".`);
    cal.items.push(item);
    cal.items.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? '').localeCompare(b.time ?? ''));
    return { item };
  });
}

/** Approve every idea (optionally only those in a month). Owner only. */
export function approveAll(projectDir, { month } = {}) {
  return mutateCalendar(projectDir, (cal) => {
    const changed = [];
    for (const item of cal.items) if (item.status === 'idea' && (!month || monthOf(item.date) === month)) { applyTransition(cal, item, 'approve', {}); changed.push(item); }
    return { items: changed };
  });
}

/**
 * Point an item at the post that was made for it, and mark it built. Claude may do this for an item the owner approved
 * (approved, building or changes). The owner's sign-off is never touched.
 */
export function linkDoc(projectDir, id, docId, { role = 'agent' } = {}) {
  return mutateCalendar(projectDir, (cal) => {
    const item = findItem(cal, id);
    if (!docId && item.external && !item.doc) {
      // an imported post (made outside Nordle) that was sent back and has been redone: its files were replaced, so it goes back for another look
      if (item.status !== 'changes') throw new CalendarError(409, `A ${item.status} imported post has nothing to take back for review.`);
      const at = nowIso();
      item.status = 'built';
      for (const f of item.feedback ?? []) if (!f.resolved) f.resolved = at;
      item.run = { attempts: 0, state: 'built', lastAt: at };
      item.updated = at;
      return { item };
    }
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(docId ?? '')) throw new CalendarError(400, `"${docId}" is not a document id.`);
    if (!existsSync(join(resolve(projectDir), 'docs', `${docId}.json`))) throw new CalendarError(404, `There is no document "${docId}" in this project's docs folder.`);
    const ok = ['approved', 'building', 'changes', 'built'];
    if (!ok.includes(item.status)) throw new CalendarError(409, item.status === 'idea' ? 'This idea has not been approved yet, so it cannot be built.' : `A ${item.status} item cannot be linked to a new post.`);
    void role;
    const at = nowIso();
    item.doc = docId;
    item.status = 'built';
    for (const f of item.feedback ?? []) if (!f.resolved) f.resolved = at;
    item.run = { attempts: 0, state: 'built', lastAt: at };   // a finished build ends the cycle: failed attempts no longer count
    if (item.pendingChanges?.length) {
      // the owner asked for changes while this was being built: it goes straight back for them, and the Studio starts the designer on it (takeQueuedRevisions)
      item.feedback = [...(item.feedback ?? []), ...item.pendingChanges.map((p) => ({ at: p.at, by: 'owner', comment: p.comment }))];
      delete item.pendingChanges;
      item.status = 'changes';
      item.queuedRevise = true;
      delete item.run;
    }
    item.updated = at;
    return { item };
  });
}

const SETTING_KEYS = ['leadDays', 'perMonth', 'autoBuild', 'autoPropose', 'autoRevise', 'horizonMonths', 'postTimes', 'pillars', 'regions', 'ideaApproval', 'compliance', 'maxBuildAttempts', 'review', 'claudeModel', 'claudeEffort', 'maxBudgetUsd'];

/** Change calendar settings (owner only: the caller checks). A null value removes a setting. Also accepts timezone. */
export function setSettings(projectDir, patch) {
  return mutateCalendar(projectDir, (cal) => {
    const unknown = Object.keys(patch ?? {}).filter((k) => ![...SETTING_KEYS, 'timezone'].includes(k));
    if (unknown.length) throw new CalendarError(400, `Unknown setting${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. Settings: ${SETTING_KEYS.join(', ')}, timezone.`);
    cal.settings = { ...(cal.settings ?? {}) };
    for (const [k, v] of Object.entries(patch ?? {})) {
      if (k === 'timezone') { if (v === null) delete cal.timezone; else cal.timezone = v; continue; }
      if (v === null) delete cal.settings[k]; else cal.settings[k] = v;
    }
    if (!Object.keys(cal.settings).length) delete cal.settings;
    const check = validateCalendar(cal);
    if (!check.ok) throw new CalendarError(400, `Those settings are not valid: ${check.errors.join('; ')}`, check.errors.map((message) => ({ path: '/settings', message })));
    return { settings: effectiveSettings(cal), timezone: cal.timezone };
  });
}

// ---- reading -----------------------------------------------------------------------------------------------------------

/** The items the runner would act on today: approved ideas due within leadDays (build) and posts the owner sent back (revise). */
export function runnableItems(cal, today) {
  const eff = effectiveSettings(cal);
  const open = (it) => (it.run?.attempts ?? 0) < eff.maxBuildAttempts;
  const build = dueItems(cal, today, eff.leadDays).filter(open).map((item) => ({ item, mode: 'build' }));
  const revise = cal.items.filter((it) => it.status === 'changes' && it.doc && open(it)).map((item) => ({ item, mode: 'revise' }));
  return [...build, ...revise].sort((a, b) => a.item.date.localeCompare(b.item.date));
}

/** What the Studio shows: the calendar, month reports, occasions in range, lint per item, what is due and whether a run is going. */
export function overview(projectDir, { from, to, today } = {}) {
  const p = loadProject(projectDir);
  const day = today ?? p.today;
  const f = from ?? monthStart(monthOf(day));
  const t = to ?? monthEnd(addMonths(monthOf(day), p.settings.horizonMonths - 1));
  if (!isDate(f) || !isDate(t)) throw new CalendarError(400, 'from and to must be dates (YYYY-MM-DD).');
  if (t < f) throw new CalendarError(400, '"to" is before "from".');
  if (diffDays(f, t) > 800) throw new CalendarError(400, 'Ask for at most about two years at a time.');
  const lock = readRunLock(p.dir);
  return {
    project: p.id,
    brand: p.brand.id ?? p.id,
    brandName: p.brand.name ?? p.id,
    today: day,
    timezone: p.timezone,
    range: { from: f, to: t },
    calendar: p.cal,
    effective: p.settings,
    months: monthsBetween(f, t).map((m) => monthReport(p.cal, m)),
    occasions: occasionsBetween(f, t, { regions: p.settings.regions }),
    lint: lintCalendar(p.cal, { brand: p.brand, facts: p.facts, today: day, regions: p.settings.regions }),
    due: runnableItems(p.cal, day).map(({ item, mode }) => ({ id: item.id, mode, date: item.date })),
    running: lock ? { item: lock.item ?? null, mode: lock.mode ?? null, since: lock.started } : null,
  };
}

// ---- campaigns ---------------------------------------------------------------------------------------------------------------

const CAMPAIGN_TEXT = { goal: 600, message: 600, cta: 200, notes: 1200 };
const campaignId = (cal, name) => {
  const base = String(name).normalize('NFKD').replace(/[^\w\s-]/g, '').trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'campaign';
  let id = base;
  for (let n = 2; (cal.campaigns ?? []).some((c) => c.id === id); n++) id = `${base.slice(0, 36)}-${n}`;
  return id;
};
function cleanCampaign(input, { forAdd = false } = {}) {
  const out = {}, errors = [];
  const name = input.name === undefined ? undefined : String(input.name).trim();
  if (name !== undefined) { if (!name || name.length > 80) errors.push({ path: '/name', message: 'give the campaign a name (up to 80 characters)' }); else out.name = name; }
  else if (forAdd) errors.push({ path: '/name', message: 'name is required' });
  for (const [k, max] of Object.entries(CAMPAIGN_TEXT)) {
    if (input[k] === undefined) continue;
    const v = input[k] === null ? '' : String(input[k]).trim();
    if (v.length > max) errors.push({ path: `/${k}`, message: `${k} is over ${max} characters` });
    else out[k] = v || null;
  }
  for (const k of ['start', 'end']) {
    if (input[k] === undefined) continue;
    if (input[k] === null || input[k] === '') out[k] = null;
    else if (!isDate(String(input[k]))) errors.push({ path: `/${k}`, message: `${k} must be a real date (YYYY-MM-DD)` });
    else out[k] = String(input[k]);
  }
  return { out, errors };
}

/** Make a campaign: a name, what it is for, the dates it runs, the one message and what it asks. Returns { campaign }. */
export function addCampaign(projectDir, input) {
  return mutateCalendar(projectDir, async (cal) => {
    const { out, errors } = cleanCampaign(input ?? {}, { forAdd: true });
    if (out.start && out.end && out.end < out.start) errors.push({ path: '/end', message: 'the end is before the start' });
    if (errors.length) throw new CalendarError(400, errors.map((e) => `${e.path}: ${e.message}`).join('; '), errors);
    const campaign = { id: campaignId(cal, out.name), ...Object.fromEntries(Object.entries(out).filter(([, v]) => v !== null)) };
    cal.campaigns = [...(cal.campaigns ?? []), campaign];
    return { campaign };
  });
}

export function updateCampaign(projectDir, id, input) {
  return mutateCalendar(projectDir, async (cal) => {
    const c = (cal.campaigns ?? []).find((x) => x.id === id);
    if (!c) throw new CalendarError(404, 'No such campaign.');
    const { out, errors } = cleanCampaign(input ?? {});
    const next = { ...c, ...out };
    if (next.start && next.end && next.end < next.start) errors.push({ path: '/end', message: 'the end is before the start' });
    if (errors.length) throw new CalendarError(400, errors.map((e) => `${e.path}: ${e.message}`).join('; '), errors);
    for (const k of Object.keys(next)) if (next[k] === null) delete next[k];
    Object.assign(c, next);
    for (const k of Object.keys(c)) if (!(k in next)) delete c[k];
    return { campaign: c };
  });
}

/** Take a campaign away. Its posts stay on the calendar, just no longer tied to it. */
export function removeCampaign(projectDir, id) {
  return mutateCalendar(projectDir, async (cal) => {
    if (!(cal.campaigns ?? []).some((x) => x.id === id)) throw new CalendarError(404, 'No such campaign.');
    cal.campaigns = cal.campaigns.filter((x) => x.id !== id);
    if (!cal.campaigns.length) delete cal.campaigns;
    let detached = 0;
    for (const it of cal.items) if (it.campaign === id) { delete it.campaign; detached++; }
    return { removed: id, detached };
  });
}
