// Schedule approved posts on their own once their date is close: "if a post has been approved and its date is a week away, put it in
// Buffer". It is the owner's standing instruction, so:
//   * it is OFF until the owner turns it on in the Studio (POST /api/publish/auto-schedule needs the owner's token; Claude's cannot);
//   * it only ever does what the owner's Schedule button does, with the same plan, the same checks and the same audit log (via "auto"),
//     for posts that are signed off, ready (nothing blocks them), not scheduled yet and inside the window; a post that is not ready is
//     left alone and the reason is kept so the Studio can show it;
//   * it never invents a time: the post's own planned slot is used, and one that is already too close or past is left for the owner;
//   * it spends little: a few posts a tick, a failed or blocked post waits hours before another try (three failed tries stop it until
//     the owner looks), and it stops when the service says the rate limit is reached or the daily allowance is nearly used.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCalendar } from '../calendar/model.mjs';
import { buildPlan, describeAdapter, getAdapter, runPlan } from './index.mjs';
import { PublishError, appendAudit, changeSettings, loadSettings, publishDir, readAllowance } from './store.mjs';

export const DEFAULTS = { enabled: false, daysAhead: 7, stories: true };
const DAY = 24 * 3600 * 1000;
const HOUR = 3600 * 1000;
export const MIN_LEAD_MS = 20 * 60 * 1000;      // a slot less than this away is left to the owner
export const MAX_PER_TICK = 8;
export const MAX_TRIES = 3;
export const LOW_ALLOWANCE = 40;                // do not start a run when the day's allowance is known to be below this

/** The setting as the rest of the code sees it (with every default filled in). */
export function autoSettings(settings = loadSettings()) {
  const a = settings.auto && typeof settings.auto === 'object' ? settings.auto : {};
  const days = Number.isInteger(a.daysAhead) ? Math.min(30, Math.max(1, a.daysAhead)) : DEFAULTS.daysAhead;
  return { enabled: a.enabled === true, daysAhead: days, stories: a.stories !== false, updated: a.updated ?? null };
}

/** POST /api/publish/auto-schedule (owner only): { enabled?, daysAhead?, stories? }. */
export function saveAutoSettings(body = {}, role) {
  if (role !== 'human') throw new PublishError(403, 'Only the owner can turn automatic scheduling on or off, in the Studio.');
  const patch = {};
  if (body.enabled !== undefined) { if (typeof body.enabled !== 'boolean') throw new PublishError(400, 'enabled must be true or false.'); patch.enabled = body.enabled; }
  if (body.stories !== undefined) { if (typeof body.stories !== 'boolean') throw new PublishError(400, 'stories must be true or false.'); patch.stories = body.stories; }
  if (body.daysAhead !== undefined) {
    if (!Number.isInteger(body.daysAhead) || body.daysAhead < 1 || body.daysAhead > 30) throw new PublishError(400, 'daysAhead must be a whole number of days from 1 to 30.');
    patch.daysAhead = body.daysAhead;
  }
  changeSettings((s) => { s.auto = { ...autoSettings(s), ...patch, updated: new Date().toISOString() }; });
  return autoSettings();
}

// ---- what it remembers: tries and what happened (not the secrets) -----------------------------------------------------------------

const statePath = () => join(publishDir(), 'auto-schedule.json');
function readState() {
  try { const s = JSON.parse(readFileSync(statePath(), 'utf8')); return { posts: s.posts ?? {}, recent: s.recent ?? [], pausedUntil: s.pausedUntil ?? 0 }; } catch { return { posts: {}, recent: [], pausedUntil: 0 }; }
}
function writeState(s) {
  try {
    mkdirSync(publishDir(), { recursive: true });
    const tmp = `${statePath()}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ ...s, recent: s.recent.slice(-30) }, null, 2)}\n`);
    renameSync(tmp, statePath());
  } catch { /* remembering is a courtesy */ }
}

/** What the Studio shows: the setting, what it did lately, and the posts it could not send (with the reason). */
export function autoStatus(now = Date.now()) {
  const st = readState();
  return {
    ...autoSettings(),
    recent: st.recent.slice(-8).reverse(),
    problems: Object.entries(st.posts).filter(([, p]) => p.lastError && (p.stopped || p.blockedUntil > now)).map(([uid, p]) => ({ uid, message: p.lastError, tries: p.tries ?? 0, stopped: !!p.stopped, nextTry: p.stopped ? null : new Date(p.blockedUntil).toISOString() })),
    pausedUntil: st.pausedUntil > now ? new Date(st.pausedUntil).toISOString() : null,
  };
}

// ---- one pass ---------------------------------------------------------------------------------------------------------------------

const dayStr = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Look at every calendar and schedule what is due. Never throws for one bad post. Returns what it did.
 * @returns {Promise<{enabled:boolean, scheduled:string[], skipped:{uid:string,why:string}[], failed:{uid:string,message:string}[], reason?:string}>}
 */
export async function autoScheduleTick(store, { now = Date.now(), adapterId = 'buffer', log = () => {} } = {}) {
  const cfg = autoSettings();
  const out = { enabled: cfg.enabled, scheduled: [], skipped: [], failed: [] };
  if (!cfg.enabled) return out;
  const state = readState();
  if (state.pausedUntil > now) return { ...out, reason: 'paused-by-rate-limit' };

  const adapter = getAdapter(adapterId);
  const settings = loadSettings();
  const desc = await describeAdapter(adapter, { live: false, settings, now });
  if (!desc.configured) return { ...out, reason: 'not-configured' };

  // candidates: signed off, nothing handed over yet, date near enough that the exact slot can fall in the window
  const lo = dayStr(now - DAY), hi = dayStr(now + (cfg.daysAhead + 1) * DAY);
  const candidates = [];
  for (const project of store.scan()) {
    let cal;
    try { cal = loadCalendar(project.dir, project.id); } catch { continue; }
    for (const item of cal.items ?? []) {
      if (item.status !== 'signed-off' || !item.date || item.date < lo || item.date > hi) continue;
      if ((item.publish?.targets ?? []).some((t) => t.ok)) continue;         // part of it went: that is for the owner to finish
      const uid = `${project.id}:${item.id}`;
      const mine = state.posts[uid];
      if (mine && (mine.stopped || mine.blockedUntil > now)) { out.skipped.push({ uid, why: mine.stopped ? 'stopped' : 'waiting' }); continue; }
      candidates.push(uid);
    }
  }
  if (!candidates.length) return out;
  const uids = candidates.slice(0, MAX_PER_TICK);

  const plan = await buildPlan(store, { adapter, uids, stories: cfg.stories && adapter.stories ? uids : [], role: 'human', via: 'auto', now });
  const go = [];
  for (const uid of uids) {
    const items = plan.items.filter((i) => i.uid === uid);
    const blocked = items.find((i) => !i.ready);
    if (blocked) {
      const why = blocked.blockers?.[0] ?? 'Something needs a look first.';
      state.posts[uid] = { ...(state.posts[uid] ?? {}), tries: state.posts[uid]?.tries ?? 0, lastAt: new Date(now).toISOString(), lastError: why, blockedUntil: now + 3 * HOUR };
      out.skipped.push({ uid, why });
      continue;
    }
    const times = items.map((i) => Date.parse(i.when)).filter(Number.isFinite);
    if (!times.length || times.some((t) => t <= now + MIN_LEAD_MS)) { out.skipped.push({ uid, why: 'too-close' }); continue; }
    if (times.some((t) => t > now + cfg.daysAhead * DAY)) { out.skipped.push({ uid, why: 'not-yet' }); continue; }
    delete state.posts[uid]?.lastError;
    go.push(...items.map((i) => i.key));
  }
  if (!go.length) { writeState(state); return out; }

  // the day's allowance (what the service last said): a run that would eat the last of it waits for tomorrow
  const account = plan.items.find((i) => go.includes(i.key))?.account;
  const left = account ? readAllowance(account, now)?.windows?.['1day']?.left : null;
  if (Number.isFinite(left) && left < LOW_ALLOWANCE + go.length * 2) { writeState(state); return { ...out, reason: 'allowance-low' }; }

  const r = await runPlan(store, { planId: plan.planId, only: go, role: 'human', via: 'auto', now });
  const stamp = new Date(now).toISOString();
  for (const p of r.posts) {
    const title = plan.items.find((i) => i.uid === p.uid)?.title ?? p.uid;
    if (p.status === 'scheduled') {
      out.scheduled.push(p.uid);
      delete state.posts[p.uid];
      state.recent.push({ uid: p.uid, title, at: stamp, ok: true, message: `Scheduled automatically (${p.done} of ${p.total} sent).` });
      log(`scheduled ${p.uid}`);
    } else {
      const bad = r.results.find((x) => x.uid === p.uid && !x.ok);
      const message = bad?.message ?? 'It did not go.';
      const tries = (state.posts[p.uid]?.tries ?? 0) + 1;
      state.posts[p.uid] = { tries, lastAt: stamp, lastError: message, blockedUntil: now + 6 * HOUR * tries, stopped: tries >= MAX_TRIES };
      out.failed.push({ uid: p.uid, message });
      state.recent.push({ uid: p.uid, title, at: stamp, ok: false, message });
      log(`could not schedule ${p.uid}: ${message}`);
    }
  }
  if (r.stopped) state.pausedUntil = now + HOUR;
  writeState(state);
  return out;
}

// ---- the thing the real server runs ------------------------------------------------------------------------------------------------

/**
 * Looks every `intervalMs` (and right after the owner approves something or turns it on, via kick()). One pass at a time.
 * `tick` is injected so tests never reach Buffer.
 */
export function createAutoScheduler({ intervalMs = 15 * 60 * 1000, tick = autoScheduleTick, log = (m) => console.log(`[auto-schedule] ${m}`) } = {}) {
  let timer = null, running = false, again = false, kickTimer = null, store = null;
  async function pass() {
    if (!store) return null;
    if (running) { again = true; return null; }
    running = true;
    let result = null;
    try { result = await tick(store, { log }); } catch (e) { log(`stopped: ${e.message}`); }
    running = false;
    if (again) { again = false; kick(); }
    return result;
  }
  function kick(delay = 2000) {
    clearTimeout(kickTimer);
    kickTimer = setTimeout(() => { pass(); }, delay);
    kickTimer.unref?.();
  }
  return {
    start(s) { store = s; clearInterval(timer); timer = setInterval(() => pass(), intervalMs); timer.unref?.(); kick(5000); },
    stop() { clearInterval(timer); clearTimeout(kickTimer); timer = null; },
    /** Look soon (after an approval, or after the owner turned it on). */
    kick,
    /** Look now and wait (tests, and the "check now" button). */
    now: (s) => { store = s ?? store; return pass(); },
    isRunning: () => running,
  };
}

export const _test = { readState, writeState, statePath, existsSync };
