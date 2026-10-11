// The review loop's rules in one place: when a review is due, saving a review, the plan changes a review may make (always through
// src/calendar/service.mjs, so every calendar rule still applies), and applying a recommended pillar mix (the owner's step).
//
// What a review may change, and what it may not:
//   - propose new ideas            -> arrive as "idea" (or "approved" when the owner delegated approval)
//   - amend UPCOMING items that are still "idea" or "approved" and have no post built yet (hook, idea, title, mediaPlan, audience,
//     occasion, pillar, notes). Claude's edit of an owner-approved idea sends it back to "idea" for the owner's yes, unless approval
//     is delegated. Built, signed-off, scheduled, posted, rejected or past items are never touched.
//   - recommend a pillar mix        -> saved with the review; only the OWNER applies it (settings are owner-only)

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { addDays, weekday } from '../calendar/dates.mjs';
import { CalendarError, addItems, loadProject, setSettings, updateItem } from '../calendar/service.mjs';
import { PerformanceError, listReviews, loadMetrics, patchReviewMeta, readReview, writeReview } from './model.mjs';
import { inPeriod, lastCompletePeriod, parsePeriod, previousPeriod } from './period.mjs';

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
export const DIRECTION_KINDS = ['do-more', 'stop', 'test'];
export const AMENDABLE = ['title', 'hook', 'idea', 'mediaPlan', 'audience', 'occasion', 'pillar', 'notes'];
const UNTOUCHABLE = ['building', 'built', 'changes', 'signed-off', 'scheduled', 'posted', 'rejected'];

// ---- when is a review due ----------------------------------------------------------------------------------------------------

/** A review waits until every post in the period is this old, so the 7-day numbers have settled. */
export const SETTLE_DAYS = 7;

function firstWeekdayOnOrAfter(date, name) {
  const want = Math.max(0, WEEKDAYS.indexOf(name ?? 'monday'));
  for (let i = 0; i < 7; i++) { const d = addDays(date, i); if (weekday(d) === want) return d; }
  return date;
}

/** How many of a period's published posts already have numbers. */
export function numbersIn(projectDir, per, today) {
  const p = loadProject(projectDir);
  const withMetrics = new Set(loadMetrics(projectDir, p.id).items.map((e) => e.post));
  const inPer = p.cal.items.filter((i) => i.status !== 'rejected' && inPeriod(i.date, per));
  const out = inPer.filter((i) => i.status === 'posted' || (['scheduled', 'signed-off'].includes(i.status) && i.date < today));
  // numbers count whatever the calendar says about the post: the owner may not have marked it posted
  return { published: out.length, withNumbers: inPer.filter((i) => withMetrics.has(i.id)).length, missing: out.filter((i) => !withMetrics.has(i.id)).map((i) => i.id) };
}

/**
 * Is a review due? Needs calendar settings.review = { cadence: 'weekly' | 'monthly', weekday?: 'monday', autoReview?: false }.
 * A review waits until every post of the period is 7 days old (so the 7-day numbers have settled): a monthly one falls due on the 7th of the
 * next month; a weekly one on `weekday` (default Monday) on or after the Sunday a week after the period ends.
 * Returns { configured, due, period, kind, label, dueDate, reviewed, numbers, autoReview, message, today }.
 */
export function reviewDue(projectDir, today) {
  const p = loadProject(projectDir);
  const day = today ?? p.today;
  const cfg = p.settings.review;
  if (!cfg?.cadence) {
    return { project: p.id, today: day, configured: false, due: false, message: `No review rhythm is set for ${p.id}. Choose one: node nordle.mjs calendar settings ${p.id} --review monthly (or weekly).` };
  }
  const kind = cfg.cadence === 'weekly' ? 'week' : 'month';
  let per = lastCompletePeriod(day, kind);
  const dueDate = (x) => (kind === 'week' ? firstWeekdayOnOrAfter(addDays(x.to, SETTLE_DAYS), cfg.weekday) : addDays(x.to, SETTLE_DAYS));
  while (dueDate(per) > day) per = previousPeriod(per);
  const existing = existsSync(join(resolve(projectDir), 'reviews', `${per.id}.md`));
  const numbers = numbersIn(projectDir, per, day);
  const last = listReviews(projectDir)[0] ?? null;
  const message = existing
    ? `The ${cfg.cadence} review of ${per.label} is done.`
    : `A ${cfg.cadence} review of ${per.label} is due (since ${dueDate(per)}). ${numbers.published ? `${numbers.withNumbers} of ${numbers.published} published posts have numbers.` : 'No posts in it are marked posted.'}${numbers.missing.length ? ' Add the missing numbers first (node nordle.mjs performance import, or the Studio: Insights).' : ''}`;
  return {
    project: p.id, today: day, configured: true, cadence: cfg.cadence, weekday: cfg.weekday, autoReview: cfg.autoReview, kind,
    due: !existing, reviewed: existing, period: per.id, label: per.label, dueDate: dueDate(per), numbers, lastReview: last?.period ?? null, message,
  };
}

// ---- changes to the plan -----------------------------------------------------------------------------------------------------

const plainErrors = (xs) => (xs ?? []).map((e) => e.message ?? String(e));

/**
 * Apply the calendar changes of a review through the calendar service, as the caller's role.
 * plan = { ideas?: [idea], amend?: [{ item, set: { hook?, idea?, ... }, because? }] }
 * Returns { ideas:{ added:[{id,date,title,status}], refused:[{title,reasons}] }, amended:[{item, ok, changed, status, sentBackToIdea, error?}], skipped:[{item, reason}] }.
 */
export async function applyReviewPlan(projectDir, plan, { role = 'agent', today } = {}) {
  const dir = resolve(projectDir);
  const out = { ideas: { added: [], refused: [] }, amended: [], skipped: [] };
  if (!plan || typeof plan !== 'object') return out;
  const day = today ?? loadProject(dir).today;

  if (Array.isArray(plan.ideas) && plan.ideas.length) {
    const r = await addItems(dir, plan.ideas, { role, today: day });
    out.ideas.added = r.added.map((i) => ({ id: i.id, date: i.date, title: i.title, status: i.status }));
    out.ideas.refused = r.rejected.map((x) => ({ title: x.input?.title ?? '?', date: x.input?.date ?? null, reasons: plainErrors(x.errors) }));
  }
  for (const a of Array.isArray(plan.amend) ? plan.amend : []) {
    const id = a?.item;
    const item = loadProject(dir).cal.items.find((i) => i.id === id);
    if (!item) { out.skipped.push({ item: id ?? '?', reason: 'there is no such calendar item' }); continue; }
    if (UNTOUCHABLE.includes(item.status) || item.doc || item.external) { out.skipped.push({ item: id, reason: `it is ${item.status}${item.doc ? ' and already has a post built' : ''}: built and finished posts are never changed by a review` }); continue; }
    if (item.date < day) { out.skipped.push({ item: id, reason: 'its date has passed' }); continue; }
    const set = Object.fromEntries(Object.entries(a.set ?? {}).filter(([k]) => AMENDABLE.includes(k)));
    const bad = Object.keys(a.set ?? {}).filter((k) => !AMENDABLE.includes(k));
    if (!Object.keys(set).length) { out.skipped.push({ item: id, reason: `nothing to change (a review may change: ${AMENDABLE.join(', ')})${bad.length ? `; not allowed: ${bad.join(', ')}` : ''}` }); continue; }
    const before = { status: item.status, ...Object.fromEntries(Object.keys(set).map((k) => [k, item[k] ?? null])) };
    try {
      const r = await updateItem(dir, id, set, { role, today: day });
      out.amended.push({ item: id, ok: true, changed: Object.keys(set).filter((k) => (r.item[k] ?? null) !== before[k]), status: r.item.status, sentBackToIdea: before.status === 'approved' && r.item.status === 'idea', because: a.because ?? null });
    } catch (e) {
      if (!(e instanceof CalendarError)) throw e;
      out.amended.push({ item: id, ok: false, error: e.message, status: item.status });
    }
  }
  return out;
}

/** The plain-words block saved at the end of a review: what actually happened to the calendar. */
export function changesBlock(result, { delegated = false } = {}) {
  const l = ['<!-- nordle:changes -->', '## What was changed in the calendar', ''];
  const added = result?.ideas?.added ?? [], refused = result?.ideas?.refused ?? [], amended = result?.amended ?? [], skipped = result?.skipped ?? [];
  if (!added.length && !refused.length && !amended.length && !skipped.length) l.push('Nothing in the calendar was changed by this review.');
  for (const i of added) l.push(`- New idea ${i.date}: "${i.title}" (${i.status === 'approved' ? 'approved: the owner delegated approval' : 'waiting for your approval'})`);
  for (const i of refused) l.push(`- Idea refused by the checks: "${i.title}" (${i.reasons.join('; ')})`);
  for (const a of amended) l.push(a.ok ? `- Changed ${a.item}: ${a.changed.join(', ') || 'no difference'}${a.sentBackToIdea ? ' (it was approved and is back to "idea": it needs your yes again)' : a.status === 'approved' ? ' (still approved: approval was delegated for it)' : ''}${a.because ? `. Why: ${a.because}` : ''}` : `- Could not change ${a.item}: ${a.error}`);
  for (const s of skipped) l.push(`- Left alone ${s.item}: ${s.reason}`);
  if (delegated && added.some((i) => i.status === 'approved')) l.push('', 'Approval is delegated for this brand, so the new ideas above are already approved and will be built as their dates near.');
  return l.join('\n');
}

// ---- saving a review ---------------------------------------------------------------------------------------------------------

function cleanDirections(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new PerformanceError(400, 'directions must be a list');
  if (list.length > 8) throw new PerformanceError(400, 'At most 8 directions: a review that says everything says nothing.');
  return list.map((d, i) => {
    const kind = String(d?.kind ?? '').toLowerCase().replace(/\s+/g, '-');
    if (!DIRECTION_KINDS.includes(kind)) throw new PerformanceError(400, `direction ${i + 1}: kind must be one of ${DIRECTION_KINDS.join(', ')}`);
    if (typeof d.text !== 'string' || d.text.trim().length < 5) throw new PerformanceError(400, `direction ${i + 1}: say what to ${kind.replace('-', ' ')}`);
    const confidence = d.confidence ? String(d.confidence).toLowerCase() : undefined;
    if (confidence && !['low', 'medium', 'high'].includes(confidence)) throw new PerformanceError(400, `direction ${i + 1}: confidence is low, medium or high`);
    return { kind, text: d.text.trim().slice(0, 400), ...(d.evidence ? { evidence: String(d.evidence).trim().slice(0, 400) } : {}), ...(confidence ? { confidence } : {}) };
  });
}

function cleanMix(projectDir, mix) {
  if (mix === undefined || mix === null) return null;
  const p = loadProject(projectDir);
  const known = new Set(p.settings.pillars.map((x) => x.id));
  const out = {};
  if (mix.pillars && typeof mix.pillars === 'object') {
    const entries = Object.entries(mix.pillars);
    for (const [id, share] of entries) {
      if (known.size && !known.has(id)) throw new PerformanceError(400, `mix: "${id}" is not a pillar of this brand (${[...known].join(', ')})`);
      if (typeof share !== 'number' || share < 0 || share > 1) throw new PerformanceError(400, `mix: the share for "${id}" must be a number between 0 and 1`);
    }
    const sum = entries.reduce((s, [, v]) => s + v, 0);
    if (entries.length && (sum < 0.85 || sum > 1.15)) throw new PerformanceError(400, `mix: the pillar shares add up to ${Math.round(sum * 100)} percent; they should add up to 100`);
    out.pillars = Object.fromEntries(entries.map(([id, v]) => [id, Math.round((v / (sum || 1)) * 100) / 100]));
  }
  if (mix.formats && typeof mix.formats === 'object') out.formats = Object.fromEntries(Object.entries(mix.formats).filter(([, v]) => Number.isInteger(v) && v >= 0));
  if (mix.note) out.note = String(mix.note).slice(0, 300);
  return Object.keys(out).length ? out : null;
}

/**
 * Save a review: reviews/<period>.md for the owner to read and reviews/<period>.json (directions, recommended mix, what was changed).
 * Applies `plan` through the calendar service first (as `role`) and appends what really happened to the text.
 * Returns { review, plan, warnings }.
 */
export async function saveReview(projectDir, { period, markdown, directions, mix, plan }, { role = 'agent', today } = {}) {
  const dir = resolve(projectDir);
  const per = parsePeriod(period);
  if (!per) throw new PerformanceError(400, `"${period}" is not a period (use 2026-11 or 2026-W45).`);
  const dirs = cleanDirections(directions);
  const cleanedMix = cleanMix(dir, mix);
  const warnings = [];
  if (role === 'agent' && dirs.length && (dirs.length < 3 || dirs.length > 5)) warnings.push(`A review should have three to five directions; this has ${dirs.length}.`);
  if (role === 'agent' && !/\bworked\b/i.test(markdown ?? '')) warnings.push('The text has no "what worked" section.');
  const planResult = plan ? await applyReviewPlan(dir, plan, { role, today }) : null;
  const delegated = loadProject(dir).settings.ideaApproval === 'delegated';
  let text = String(markdown ?? '').replace(/\n*<!-- nordle:changes -->[\s\S]*$/, '').trim();
  if (planResult) text = `${text}\n\n${changesBlock(planResult, { delegated })}`;
  const review = writeReview(dir, per.id, {
    markdown: text,
    meta: { by: role === 'human' ? 'owner' : 'claude', directions: dirs, mix: cleanedMix, changes: planResult ? { ideasAdded: planResult.ideas.added.map((i) => i.id), amended: planResult.amended.filter((a) => a.ok).map((a) => a.item), skipped: planResult.skipped.length + planResult.amended.filter((a) => !a.ok).length + planResult.ideas.refused.length } : null },
  });
  return { review, plan: planResult, warnings };
}

/**
 * Apply a review's recommended pillar mix to settings.pillars (the shares only; names, descriptions and the monthly quota stay).
 * Owner only: the caller checks the role. Returns { settings, applied }.
 */
export async function applyMix(projectDir, period) {
  const dir = resolve(projectDir);
  const r = readReview(dir, period);
  if (!r) throw new PerformanceError(404, `There is no review for ${period}.`);
  const mix = r.meta.mix?.pillars;
  if (!mix) throw new PerformanceError(409, 'That review has no pillar mix to apply.');
  const p = loadProject(dir);
  if (!p.settings.pillars.length) throw new PerformanceError(409, 'This brand has no pillars set, so there is nothing to re-weight.');
  const pillars = p.settings.pillars.map((x) => ({ ...x, ...(mix[x.id] !== undefined ? { share: mix[x.id] } : {}) }));
  const res = await setSettings(dir, { pillars });
  patchReviewMeta(dir, period, { mixAppliedAt: new Date().toISOString() });
  return { settings: res.settings, applied: mix };
}

// ---- history -----------------------------------------------------------------------------------------------------------------

/** Saved reviews, newest first, each with the median score of its period (when it can be worked out). */
export async function reviewHistory(projectDir) {
  const { reportFor } = await import('./analyze.mjs');
  return listReviews(projectDir).map((rv) => {
    let median = null, posts = 0;
    try { const rep = reportFor(projectDir, rv.period); median = rep.headline.medianScore; posts = rep.counts.scored; } catch { /* no numbers any more */ }
    return { ...rv, medianScore: median, scoredPosts: posts };
  });
}
