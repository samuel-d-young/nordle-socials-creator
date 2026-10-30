// Where publishing keeps its state. Three things, three places:
//   settings  <repo>/.nordle/publish.json   Gitignored, written with mode 0600 where the OS supports it, never returned by any API
//             (only `configured: true`), never logged. It holds
//               accounts  { <accountId>: { adapter, label, token, organizationId?, lastTestedAt?, channelCache,
//                                          authType?: 'oauth', refreshToken?, expiresAt? (ISO), scope? } }   the logins: an API key, or (authType 'oauth')
//                                          a Buffer sign-in whose `token` is the access token (about an hour) and `refreshToken` renews it (src/publish/buffer-oauth.mjs).
//                                          The refresh token never leaves this file except to Buffer's token address; accountsFor/resolveSettings do not carry it.
//               brands    { <project>: { account: <accountId>|null, channels: [ {id, name?, service?, formats?, enabled?, offsetMinutes?, hashtags?} ] } }
//               adapters  { <adapter>: { options } }   shared options (the media web address, ...)
//             An older file with one key per adapter (adapters.buffer.token / .channels) is read as account "default"; the next save
//             writes the new layout.
//   plans     <repo>/.nordle/publish-plans/<planId>.json   a plan survives a server restart and the gap between
//             `publish plan` and `publish run` (two separate commands). Plans hold captions, never tokens. Old ones are pruned.
//   audit     <project>/publish/log.jsonl   one line per post per run: who, what, to which adapter, the result. No tokens.
// NORDLE_PUBLISH_DIR overrides the folder for settings and plans (tests); otherwise it is the same folder as the runtime file.

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { defaultRuntimeDir } from '../mcp/client.mjs';

export class PublishError extends Error {
  /** @param {number} status HTTP-like status (400 bad request, 403 owner only, 404 not found, 409 conflict, 410 expired, 429 rate limit, 502 the service failed) */
  constructor(status, message, extra = {}) { super(message); this.name = 'PublishError'; this.status = status; this.code = extra.code ?? null; this.retryAfter = extra.retryAfter ?? null; this.uncertain = !!extra.uncertain; }
}

export const publishDir = () => resolve(process.env.NORDLE_PUBLISH_DIR || defaultRuntimeDir());
export const settingsPath = () => join(publishDir(), 'publish.json');
export const plansDir = () => join(publishDir(), 'publish-plans');

const atomicWrite = (file, text, mode) => {
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  writeFileSync(tmp, text, mode ? { mode } : undefined);
  renameSync(tmp, file);
  if (mode) { try { chmodSync(file, mode); } catch { /* not every file system has modes */ } }
};

// ---- settings --------------------------------------------------------------------------------------------------------------

const EMPTY = () => ({ schema: 'nordle.publish/0.1', adapters: {}, accounts: {}, brands: {} });
export const DEFAULT_ACCOUNT = 'default';
export const ACCOUNT_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** Bring an older settings object up to the current layout, in memory (idempotent). The next saveSettings persists it. */
export function migrateSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : EMPTY();
  s.adapters = s.adapters && typeof s.adapters === 'object' ? s.adapters : {};
  s.accounts = s.accounts && typeof s.accounts === 'object' ? s.accounts : {};
  s.brands = s.brands && typeof s.brands === 'object' ? s.brands : {};
  for (const [adapterId, a] of Object.entries(s.adapters)) {
    if (!a || typeof a !== 'object' || (a.token === undefined && a.channels === undefined && a.channelCache === undefined)) continue;
    if (adapterId !== 'bundle' && (a.token || a.channelCache || a.channels)) {
      const acc = (s.accounts[DEFAULT_ACCOUNT] ??= { adapter: adapterId, label: adapterId === 'buffer' ? 'Buffer' : adapterId });
      if (a.token && !acc.token) acc.token = a.token;
      if (Array.isArray(a.channelCache) && !acc.channelCache) acc.channelCache = a.channelCache;
      if (a.options?.organizationId && !acc.organizationId) { acc.organizationId = a.options.organizationId; delete a.options.organizationId; }
    }
    for (const [project, value] of Object.entries(a.channels && typeof a.channels === 'object' ? a.channels : {})) {
      s.brands[project] ??= { account: adapterId === 'bundle' ? null : DEFAULT_ACCOUNT, channels: value };
    }
    delete a.token; delete a.channels; delete a.channelCache;
  }
  return s;
}

export function loadSettings() {
  try { return migrateSettings(JSON.parse(readFileSync(settingsPath(), 'utf8'))); } catch { return migrateSettings(EMPTY()); }
}

export function saveSettings(settings) {
  atomicWrite(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`, 0o600);
  return settings;
}

/** Load, let fn change, save. Used by every settings write so two changes in a row never lose each other. */
export function changeSettings(fn) {
  const s = loadSettings();
  const r = fn(s);
  saveSettings(s);
  return r;
}

// ---- the channels of a brand -----------------------------------------------------------------------------------------------------
// brands.<project>.channels is a list of the channels (an Instagram account, Facebook pages, ...) the brand posts to:
//   { id, name?, service?, formats?: ['reel','carousel','post','story'] (default all), enabled? (default true),
//     offsetMinutes? (default 0: stagger this channel's posting time), hashtags?: 'keep' | 'strip' (default keep) }
// A bare string id (the first version of this file) still reads as one enabled channel.

export const FORMATS = ['reel', 'carousel', 'post', 'story'];
export const HASHTAG_MODES = ['keep', 'strip'];
export const MAX_CHANNELS_PER_BRAND = 12;
const CHANNEL_KEYS = new Set(['id', 'name', 'service', 'formats', 'enabled', 'offsetMinutes', 'hashtags']);

/**
 * One account entry in its full form. strict (saving): bad input throws a PublishError that says what to fix.
 * Not strict (reading the file): an entry that cannot be understood comes back as null and is skipped.
 */
export function normalizeChannel(raw, { strict = false } = {}) {
  const bad = (message) => { if (strict) throw new PublishError(400, message); return null; };
  const o = typeof raw === 'string' ? { id: raw } : raw;
  if (!o || typeof o !== 'object' || Array.isArray(o)) return bad('Each channel is a channel id, or an object with an id.');
  if (strict) for (const k of Object.keys(o)) if (!CHANNEL_KEYS.has(k)) return bad(`Unknown channel setting "${k}". Settings: ${[...CHANNEL_KEYS].join(', ')}.`);
  const id = typeof o.id === 'string' ? o.id.trim() : '';
  if (!id || id.length > 120 || /\s/.test(id)) return bad('Each channel needs an id (no spaces, at most 120 characters).');
  const out = { id };
  for (const k of ['name', 'service']) {
    if (o[k] === undefined || o[k] === null || o[k] === '') continue;
    if (typeof o[k] !== 'string' || o[k].length > 120) { if (strict) return bad(`A channel's ${k} must be short text.`); continue; }
    out[k] = o[k].trim();
  }
  let formats = FORMATS;
  if (o.formats !== undefined && o.formats !== null) {
    if (!Array.isArray(o.formats) || !o.formats.length || o.formats.some((f) => !FORMATS.includes(f))) {
      if (strict) return bad(`formats must be a list of ${FORMATS.join(', ')} (at least one).`);
    } else formats = FORMATS.filter((f) => o.formats.includes(f));
  }
  out.formats = formats;
  if (o.enabled !== undefined && o.enabled !== null && typeof o.enabled !== 'boolean') { if (strict) return bad('enabled must be true or false.'); }
  out.enabled = o.enabled === false ? false : true;
  const off = o.offsetMinutes === undefined || o.offsetMinutes === null ? 0 : o.offsetMinutes;
  if (!Number.isInteger(off) || Math.abs(off) > 1440) { if (strict) return bad('offsetMinutes must be a whole number of minutes between -1440 and 1440.'); out.offsetMinutes = 0; } else out.offsetMinutes = off;
  if (o.hashtags !== undefined && o.hashtags !== null && !HASHTAG_MODES.includes(o.hashtags)) { if (strict) return bad('hashtags must be "keep" or "strip".'); }
  out.hashtags = o.hashtags === 'strip' ? 'strip' : 'keep';
  return out;
}

/** A brand's accounts from a string, an object, or a list of either. Strict: throws; otherwise bad entries are skipped. */
export function normalizeBrandChannels(value, { strict = false } = {}) {
  if (value === undefined || value === null || value === '') return [];
  const list = Array.isArray(value) ? value : [value];
  if (strict && list.length > MAX_CHANNELS_PER_BRAND) throw new PublishError(400, `At most ${MAX_CHANNELS_PER_BRAND} channels for one brand.`);
  return list.map((c) => normalizeChannel(c, { strict })).filter(Boolean);
}

/** An adapter's shared options (the media web address, ...). */
export const adapterOptions = (settings, adapterId) => {
  const own = settings.adapters?.[adapterId]?.options && typeof settings.adapters[adapterId].options === 'object' ? settings.adapters[adapterId].options : {};
  // when the owner has set up media hosting, the files live at its public address: that is the media web address
  return adapterId !== 'bundle' && settings.hosting?.publicBaseUrl ? { ...own, mediaBaseUrl: settings.hosting.publicBaseUrl } : own;
};

/**
 * The logins an adapter has: [{ id, adapter, label, token (or null), authType ('key' | 'oauth'), expiresAt (ISO or null; a Buffer sign-in's access token),
 * renews (a sign-in that can renew itself), organizationId, lastTestedAt, lastTestOk, channelCache }]. The token is for the server only; the refresh token is never carried.
 */
export function accountsFor(settings, adapterId) {
  return Object.entries(settings.accounts ?? {})
    .filter(([id, a]) => a && typeof a === 'object' && a.adapter === adapterId && ACCOUNT_ID.test(id))
    .map(([id, a]) => ({ id, adapter: a.adapter, label: typeof a.label === 'string' && a.label ? a.label : id, token: typeof a.token === 'string' && a.token ? a.token : null, authType: a.authType === 'oauth' ? 'oauth' : 'key', expiresAt: a.authType === 'oauth' && typeof a.expiresAt === 'string' ? a.expiresAt : null, renews: a.authType === 'oauth' && typeof a.refreshToken === 'string' && !!a.refreshToken, organizationId: typeof a.organizationId === 'string' && a.organizationId ? a.organizationId : null, lastTestedAt: typeof a.lastTestedAt === 'string' ? a.lastTestedAt : null, lastTestOk: typeof a.lastTestOk === 'boolean' ? a.lastTestOk : null, channelCache: Array.isArray(a.channelCache) ? a.channelCache : [] }));
}

/** One brand's setup: which login it publishes through and its channels, every default filled in (whatever form was saved). */
export function brandSetup(settings, project) {
  const b = settings.brands?.[project];
  const saved = b && typeof b.account === 'string' && b.account ? b.account : null;
  const ids = Object.keys(settings.accounts ?? {});
  // with one login in total there is nothing to choose: every brand without a pick uses it (what a single-key setup always did)
  return { account: saved ?? (ids.length === 1 ? ids[0] : null), channels: normalizeBrandChannels(b?.channels) };
}

/** Every brand that has a setup: { <project>: { account, channels:[full entries] } }. */
export function allBrands(settings) {
  const out = {};
  for (const project of Object.keys(settings.brands ?? {})) {
    const b = brandSetup(settings, project);
    if (b.account || b.channels.length) out[project] = b;
  }
  return out;
}

/**
 * What an adapter works with for ONE brand: the token of the login the brand publishes through (null if it has none), that login's
 * channel list, the brand's channels, and the adapter's shared options. The token never leaves the server.
 */
export function resolveSettings(settings, adapterId, project) {
  const b = brandSetup(settings, project);
  const acc = accountsFor(settings, adapterId).find((a) => a.id === b.account) ?? null;
  const options = adapterOptions(settings, adapterId);
  return {
    account: acc ? { id: acc.id, label: acc.label, authType: acc.authType, expiresAt: acc.expiresAt } : null,   // authType/expiresAt tell the adapter whether to renew a Buffer sign-in
    token: acc?.token ?? null,
    organizationId: acc?.organizationId ?? options.organizationId ?? null,
    options,
    hosting: settings.hosting?.endpoint ? settings.hosting : null,   // server side only: used to put a post's files in the owner's bucket
    channelCache: acc?.channelCache ?? [],
    channels: b.channels,
  };
}

// ---- the service's request allowance ----------------------------------------------------------------------------------------------
// Buffer allows a fixed number of requests (100 per 15 minutes, 250 per day, 7,500 per 30 days on the owner's plan) and says how many are
// left in every answer. Nordle remembers the last thing it was told per account, so it can show it, keep optional reading (history,
// "is it still there?") from using what scheduling needs, and warn before a run that would use most of what is left.
export const allowancePath = () => join(publishDir(), 'allowance.json');
let allowanceMemo = null;
const readAllowanceFile = () => { if (allowanceMemo) return allowanceMemo; try { allowanceMemo = JSON.parse(readFileSync(allowancePath(), 'utf8')); } catch { allowanceMemo = {}; } return allowanceMemo; };

/** Remember what the service just said is left: rate = { '15min': {limit,left,resetsIn}, '1day': {...}, '30days': {...} } (seconds to reset). */
export function recordAllowance(accountId, rate, now = Date.now()) {
  if (!accountId || !rate || !Object.keys(rate).length) return;
  const all = readAllowanceFile();
  all[accountId] = { at: new Date(now).toISOString(), windows: Object.fromEntries(Object.entries(rate).map(([k, v]) => [k, { limit: v.limit, left: v.left, resetsAt: new Date(now + v.resetsIn * 1000).toISOString() }])) };
  try { atomicWrite(allowancePath(), `${JSON.stringify(all, null, 2)}
`); } catch { /* remembering is a courtesy */ }
}

/**
 * What is known to be left for an account right now: { at, windows: { '15min': {limit,left}, '1day': ..., '30days': ... } } or null.
 * A window whose reset time has passed is back to its full limit (we cannot know what was used since, so it is shown as unknown: left = null).
 */
export function readAllowance(accountId, now = Date.now()) {
  const a = readAllowanceFile()[accountId];
  if (!a?.windows) return null;
  const windows = {};
  for (const [k, w] of Object.entries(a.windows)) windows[k] = Date.parse(w.resetsAt) > now ? { limit: w.limit, left: w.left, resetsAt: w.resetsAt } : { limit: w.limit, left: null, resetsAt: null };
  return { at: a.at, windows };
}
export const clearAllowanceMemo = () => { allowanceMemo = null; };

/** How long to wait, in words a person uses: "26 minutes", "1 hour 5 minutes", "2 hours". Never seconds (rounded up to a whole minute). */
export function waitWords(seconds) {
  const total = Math.max(1, Math.ceil(Number(seconds) / 60));
  const h = Math.floor(total / 60), m = total % 60;
  const part = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;
  return [h ? part(h, 'hour') : null, m ? part(m, 'minute') : null].filter(Boolean).join(' ');
}

/** Replace anything that looks like a secret in text that is about to be shown or logged. */
export function redact(text, ...secrets) {
  let s = String(text ?? '');
  for (const x of secrets) if (typeof x === 'string' && x.length >= 4) s = s.split(x).join('***');
  return s.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer ***');
}

// ---- plans -----------------------------------------------------------------------------------------------------------------

export const PLAN_TTL_MS = 15 * 60 * 1000;
const PLAN_ID = /^pl_[0-9a-f]{16}$/;
export const newPlanId = () => `pl_${randomBytes(8).toString('hex')}`;

export function savePlan(plan) {
  if (!PLAN_ID.test(plan.planId)) throw new PublishError(400, 'Bad plan id.');
  atomicWrite(join(plansDir(), `${plan.planId}.json`), `${JSON.stringify(plan)}\n`);
  prunePlans();
  return plan;
}

export function loadPlan(planId) {
  if (!PLAN_ID.test(String(planId ?? ''))) throw new PublishError(404, 'There is no such plan. Make one first (it must come from a plan made by you).');
  try { return JSON.parse(readFileSync(join(plansDir(), `${planId}.json`), 'utf8')); } catch { throw new PublishError(404, 'There is no such plan (it may have been cleared). Make a new plan.'); }
}

/** Forget plans more than a day old, so the folder does not grow. */
function prunePlans() {
  try {
    for (const f of readdirSync(plansDir())) {
      if (!f.endsWith('.json')) continue;
      const file = join(plansDir(), f);
      if (Date.now() - statSync(file).mtimeMs > 24 * 3600 * 1000) { try { unlinkSync(file); } catch { /* gone already */ } }
    }
  } catch { /* no folder yet */ }
}

// ---- audit -----------------------------------------------------------------------------------------------------------------

export const auditPath = (projectDir) => join(projectDir, 'publish', 'log.jsonl');

/** Append one line to the project's publishing log. Fields are copied by name so a secret can never ride along by accident. */
export function appendAudit(projectDir, entry) {
  const keep = ['event', 'adapter', 'account', 'planId', 'uid', 'docId', 'item', 'ok', 'message', 'channel', 'when', 'scheduledAt', 'remoteId', 'override', 'by', 'via', 'uncertain'];
  const line = { at: new Date().toISOString() };
  for (const k of keep) if (entry[k] !== undefined) line[k] = entry[k];
  const file = auditPath(projectDir);
  mkdirSync(join(file, '..'), { recursive: true });
  appendFileSync(file, `${JSON.stringify(line)}\n`);
  return line;
}

export function readAudit(projectDir, limit = 200) {
  const file = auditPath(projectDir);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
