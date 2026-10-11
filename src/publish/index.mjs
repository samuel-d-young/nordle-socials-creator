// Publishing, as one layer with adapters. An adapter turns a signed-off post into "scheduled somewhere":
//   { id, name, marksScheduled, needsAccount?, needsChannel?, accountName?,
//     describe({accounts, brands, options}) -> {configured, needs, channels, note}, async listChannels(settings),
//     async plan?(post, {settings}) -> {blockers:[{code,message}], warnings:[]},
//     async schedule(post, {channel, when}, settings, {firstOfPost, probeCache}) -> {remoteId, scheduledAt, message?},
//     async check(settings) -> {ok, message}, async finalize?(batch, {planId}) }
// where `settings` is what that BRAND needs: the token of the login the brand publishes through, that login's channels, the brand's
// channels, and the adapter's shared options (store.mjs resolveSettings). Two adapters ship: `bundle` (writes an export folder,
// nothing leaves the computer) and `buffer` (Buffer's GraphQL API).
//
// Accounts and channels. An ACCOUNT is a login (a Buffer API key); a brand picks the account it publishes through, and several brands
// can use different accounts. A CHANNEL is one place inside an account (an Instagram profile, a Facebook page). A brand can post to
// several channels, each with its own formats, time offset and hashtag rule, and a channel belongs to one brand only.
//
// The rules, in code and not only in the UI:
//   * only the owner runs anything (role 'human'); the agent may list adapters and plan, nothing else;
//   * a run needs a plan the OWNER made in the last 15 minutes; it re-reads every post and refuses the ones that moved
//     since (document version, file hash, caption, pictures, slot, channel, account) or that are no longer ready;
//   * a post that is not signed off goes only with the owner's per-post override, and never when its checks fail;
//   * a post goes to each of its channels at most once per plan; when the answer was unclear that channel is left alone until the
//     owner looks, and a failed channel can be retried without touching the ones that worked;
//   * a post becomes "scheduled" only when every channel chosen for it has gone; until then the calendar item keeps its status and
//     lists what went and what failed (item.publish.targets);
//   * every attempt is a line in <project>/publish/log.jsonl (with the account id), and a token is never in a result, a message or a log.

import { ensureCover } from '../studio/cover.mjs';
import { createHash } from 'node:crypto';
import { calendarPath } from '../calendar/model.mjs';
import { markScheduled, recordPublishTarget } from '../calendar/service.mjs';
import { forget, parseUid } from '../studio/data.mjs';
import { createBufferAdapter } from './adapters/buffer.mjs';
import { createBundleAdapter } from './adapters/bundle.mjs';
import { MAX_ITEMS, buildPlan, evaluatePost, publicPlan } from './plan.mjs';
import { checkHosting, hostingView, validateHosting } from './hosting.mjs';
import { ACCOUNT_ID, DEFAULT_ACCOUNT, PublishError, accountsFor, adapterOptions, allBrands, appendAudit, brandSetup, changeSettings, loadPlan, loadSettings, normalizeBrandChannels, readAllowance, redact, savePlan } from './store.mjs';

export { PublishError, buildPlan, publicPlan };

// ---- the adapters --------------------------------------------------------------------------------------------------------------

let config = {};
let registry = null;

/** Tests (and anything embedding Nordle) set a fake fetch or another API address here: configure({ buffer: { fetch, apiUrl } }). */
export function configure(next = {}) { config = { ...config, ...next }; registry = null; }

export function adapters() {
  if (!registry) registry = new Map([createBundleAdapter(), createBufferAdapter(config.buffer ?? {})].map((a) => [a.id, a]));
  return registry;
}

export function getAdapter(id) {
  const a = adapters().get(String(id ?? ''));
  if (!a) throw new PublishError(404, `There is no publishing adapter "${id}". Adapters: ${[...adapters().keys()].join(', ')}.`);
  return a;
}

// ---- channels of an account (loaded live, kept 10 minutes) -------------------------------------------------------------------------

export const CHANNEL_TTL_MS = 10 * 60 * 1000;
const memo = new Map();   // accountId -> { key, at, channels }
const keyOf = (acc) => createHash('sha256').update(`${acc.token}|${acc.organizationId ?? ''}`).digest('hex').slice(0, 16);
/** Forget what was loaded (tests; and after a key or organisation changes). */
export function clearChannelMemo(accountId) { if (accountId) memo.delete(accountId); else memo.clear(); }

/**
 * The channels one account offers. live: ask the adapter (at most once in 10 minutes per account; a failure falls back to the last
 * list that was saved, with `error`). Without live, only the saved list.
 */
export async function loadAccountChannels(adapter, acc, { live = false, force = false, now = Date.now() } = {}) {
  const cached = acc.channelCache;
  if (!live || !acc.token || !adapter.listChannels) return { channels: cached };
  const key = keyOf(acc), m = memo.get(acc.id);
  if (!force && m && m.key === key && now - m.at < CHANNEL_TTL_MS) return { channels: m.channels };
  try {
    const channels = await adapter.listChannels({ token: acc.token, organizationId: acc.organizationId, options: adapterOptions(loadSettings(), adapter.id), channelCache: cached });
    memo.set(acc.id, { key, at: now, channels });
    changeSettings((s) => { if (s.accounts[acc.id]) s.accounts[acc.id].channelCache = channels; });
    return { channels };
  } catch (e) {
    if (e instanceof PublishError) return { channels: cached, error: redact(e.message, acc.token) };
    throw e;
  }
}

// ---- what the Studio shows -----------------------------------------------------------------------------------------------------

const shortChannel = (c) => ({ id: c.id, name: c.name ?? null, service: c.service ?? null });

/** The brands' saved setup, with names and services filled in from each brand's account. */
function brandsView(settings, byAccount) {
  const out = {};
  for (const [project, b] of Object.entries(allBrands(settings))) {
    const known = byAccount.get(b.account) ?? [];
    out[project] = {
      account: b.account,
      channels: b.channels.map((e) => { const c = known.find((k) => k.id === e.id); return { id: e.id, name: c?.name ?? e.name ?? null, service: c?.service ?? e.service ?? null, formats: e.formats, enabled: e.enabled, offsetMinutes: e.offsetMinutes, hashtags: e.hashtags }; }),
    };
  }
  return out;
}

/**
 * One adapter as GET /api/publish/adapters shows it. live (the owner's token only): ask the adapter for each account's channels
 * (cached 10 minutes); otherwise the lists saved by the last connection test. Never a token: only `configured`.
 */
export async function describeAdapter(adapter, { live = false, now = Date.now(), settings = loadSettings() } = {}) {
  const accs = [];
  for (const acc of accountsFor(settings, adapter.id)) accs.push({ acc, ...(await loadAccountChannels(adapter, acc, { live, now })) });
  const fresh = live ? loadSettings() : settings;
  const byAccount = new Map(accs.map((a) => [a.acc.id, a.channels]));
  const options = adapterOptions(fresh, adapter.id);
  const d = adapter.describe({ accounts: accs.map((a) => ({ id: a.acc.id, label: a.acc.label, configured: !!a.acc.token, channelCache: a.channels })), brands: allBrands(fresh), options });
  const brands = brandsView(fresh, byAccount);
  return {
    id: adapter.id, name: adapter.name, configured: !!d.configured, needs: d.needs ?? [], channels: (d.channels ?? []).map(shortChannel), note: d.note ?? '', stories: !!adapter.stories,
    accounts: accs.map((a) => ({ id: a.acc.id, label: a.acc.label, configured: !!a.acc.token, lastTestedAt: a.acc.lastTestedAt, allowance: readAllowance(a.acc.id), ...(a.acc.lastTestOk === null ? {} : { lastTestOk: a.acc.lastTestOk }), channels: a.channels.map(shortChannel), ...(a.error ? { error: a.error } : {}) })),
    brands,
    selected: Object.fromEntries(Object.entries(brands).filter(([, b]) => b.channels.length).map(([p, b]) => [p, b.channels[0].id])),
    options,
    ...(adapter.id === 'bundle' ? {} : { hosting: hostingView(fresh.hosting) }),
  };
}

export async function listAdapters(opts = {}) {
  const settings = loadSettings();
  const out = [];
  for (const a of adapters().values()) out.push(await describeAdapter(a, { ...opts, settings }));
  return out;
}

// ---- settings and the connection test (owner only: the route and the command line check) --------------------------------------

const PROJECT_ID = /^[a-z0-9][a-z0-9_-]*$/;

function assertNoSharedChannels(settings) {
  const owner = new Map();
  for (const [project, b] of Object.entries(allBrands(settings))) {
    const seen = new Set();
    const known = (b.account && Array.isArray(settings.accounts?.[b.account]?.channelCache) ? settings.accounts[b.account].channelCache : []);
    for (const e of b.channels) {
      const label = e.name ?? known.find((c) => c.id === e.id)?.name ?? e.id;
      if (seen.has(e.id)) throw new PublishError(400, `${label} is listed twice for ${project}.`);
      seen.add(e.id);
      const k = `${b.account ?? ''}|${e.id}`;
      if (owner.has(k) && owner.get(k) !== project) throw new PublishError(400, `${label} is already connected to ${owner.get(k)}. A channel can belong to one brand only: take it off ${owner.get(k)} first.`);
      owner.set(k, project);
    }
  }
}

/**
 * POST /api/publish/settings (owner only). Fields, all optional, applied together or not at all:
 *   account, label, token, organizationId   make or change a login (a bare `token` is the "default" account; token null clears the key)
 *   remove                                  delete a login (refused while a brand still publishes through it)
 *   brand + useAccount                      the login a brand publishes through (null unlinks); its channels are cleared unless sent too
 *   channels { <project>: [channel] }       a brand's channels ([] or null clears; a bare id string is one enabled channel)
 *   mediaBaseUrl, options                   the adapter's shared options
 */
export function saveSettingsFor(adapterId, body = {}, role) {
  if (role !== 'human') throw new PublishError(403, 'Only the owner can change publishing settings, in the Studio.');
  const adapter = getAdapter(adapterId);
  const cleared = [];
  changeSettings((s) => {
    const accountFields = body.account !== undefined || body.label !== undefined || body.token !== undefined || body.organizationId !== undefined;

    if (body.remove !== undefined) {
      const id = String(body.remove);
      const acc = accountsFor(s, adapter.id).find((a) => a.id === id);
      if (!acc) throw new PublishError(404, `There is no ${adapter.name} account "${id}".`);
      const users = Object.entries(allBrands(s)).filter(([, b]) => b.account === id).map(([p]) => p);
      if (users.length) throw new PublishError(409, `${users.join(', ')} still publish${users.length === 1 ? 'es' : ''} through "${acc.label}". Switch ${users.length === 1 ? 'it' : 'them'} to another account first.`);
      delete s.accounts[id];
      clearChannelMemo(id);
    }

    if (accountFields) {
      if (!adapter.needsAccount) throw new PublishError(400, `${adapter.name} has no accounts to connect.`);
      const id = body.account === undefined ? DEFAULT_ACCOUNT : String(body.account);
      if (!ACCOUNT_ID.test(id)) throw new PublishError(400, `"${id}" is not an account id (lower-case letters, digits, - and _, at most 40).`);
      const existing = s.accounts[id];
      if (existing && existing.adapter !== adapter.id) throw new PublishError(409, `"${id}" is an account of another adapter.`);
      const acc = (s.accounts[id] ??= { adapter: adapter.id, label: id === DEFAULT_ACCOUNT ? adapter.name : id });
      if (body.label !== undefined) {
        if (typeof body.label !== 'string' || !body.label.trim() || body.label.length > 60) throw new PublishError(400, 'The account name must be short text (at most 60 characters).');
        acc.label = body.label.trim();
      }
      let changed = false;
      if (body.token !== undefined) {
        if (body.token === null || body.token === '') delete acc.token;
        else {
          if (typeof body.token !== 'string' || !/^[\x21-\x7e]{8,512}$/.test(body.token.trim())) throw new PublishError(400, 'That does not look like an API key (it should be one line of 8 to 512 characters, no spaces).');
          acc.token = body.token.trim();
        }
        changed = true;
      }
      if (body.organizationId !== undefined) {
        if (body.organizationId === null || body.organizationId === '') delete acc.organizationId;
        else if (typeof body.organizationId !== 'string' || body.organizationId.length > 80 || /\s/.test(body.organizationId)) throw new PublishError(400, 'organizationId must be one word.');
        else acc.organizationId = body.organizationId;
        changed = true;
      }
      if (changed) { delete acc.channelCache; delete acc.lastTestedAt; delete acc.lastTestOk; clearChannelMemo(id); }
    }

    // which login a brand publishes through
    if (body.useAccount !== undefined || body.brand !== undefined) {
      if (typeof body.brand !== 'string' || !PROJECT_ID.test(body.brand)) throw new PublishError(400, 'brand must be a project id (send brand and useAccount together).');
      if (body.useAccount === undefined) throw new PublishError(400, 'Say which account: {"brand": "<project>", "useAccount": "<account id>"} (null unlinks).');
      let next = null;
      if (body.useAccount !== null && body.useAccount !== '') {
        if (!adapter.needsAccount) throw new PublishError(400, `${adapter.name} has no accounts.`);
        next = String(body.useAccount);
        if (!accountsFor(s, adapter.id).some((a) => a.id === next)) throw new PublishError(404, `There is no ${adapter.name} account "${next}". Save it first.`);
      }
      const cur = brandSetup(s, body.brand);
      const entry = (s.brands[body.brand] = { account: next, channels: cur.channels });
      if (cur.account !== next && cur.channels.length && !(body.channels && body.channels[body.brand] !== undefined)) { entry.channels = []; cleared.push(body.brand); }
      if (!entry.account && !entry.channels.length) delete s.brands[body.brand];
    }

    // a brand's channels
    if (body.channels !== undefined) {
      if (!body.channels || typeof body.channels !== 'object' || Array.isArray(body.channels)) throw new PublishError(400, 'channels must be {"<project id>": [ {"id": "<channel id>", ...} ]}.');
      for (const [project, value] of Object.entries(body.channels)) {
        if (!PROJECT_ID.test(project)) throw new PublishError(400, `"${project}" is not a project id.`);
        const list = normalizeBrandChannels(value, { strict: true });
        let { account } = brandSetup(s, project);
        if (!account && adapter.needsAccount && list.length) {
          const mine = accountsFor(s, adapter.id);
          if (mine.length !== 1) throw new PublishError(400, mine.length ? `Choose which ${adapter.name} account ${project} publishes through first (it has more than one to pick from).` : `Connect a ${adapter.name} account first: save an API key, then choose the channels.`);
          account = mine[0].id;
        }
        const known = accountsFor(s, adapter.id).find((a) => a.id === account)?.channelCache ?? [];
        const filled = list.map((e) => {
          const c = known.find((k) => k.id === e.id);
          if (known.length && !c) throw new PublishError(400, `"${e.id}" is not one of the channels of ${project}'s account (from its last connection test). Run "Test connection" to refresh the list.`);
          return { ...e, ...(c?.name && !e.name ? { name: c.name } : {}), ...(c?.service && !e.service ? { service: c.service } : {}) };
        });
        if (!filled.length && !account) delete s.brands[project]; else s.brands[project] = { account, channels: filled };
      }
    }

    // where the files of scheduled posts are put so Buffer can read them (the owner's own bucket)
    if (body.hosting !== undefined) {
      if (adapter.id === 'bundle') throw new PublishError(400, 'The export folder needs no hosting.');
      s.hosting = validateHosting(body.hosting, s.hosting ?? null) ?? undefined;
      if (s.hosting === undefined) delete s.hosting;
    }

    // the adapter's shared options
    const opts = { ...(body.options && typeof body.options === 'object' ? body.options : {}), ...(body.mediaBaseUrl !== undefined ? { mediaBaseUrl: body.mediaBaseUrl } : {}) };
    if (body.options !== undefined && (!body.options || typeof body.options !== 'object')) throw new PublishError(400, 'options must be an object.');
    if (Object.keys(opts).length) {
      if (!adapter.validateOptions) throw new PublishError(400, `${adapter.name} has no options.`);
      const clean = adapter.validateOptions(opts);
      const cur = { ...(s.adapters[adapter.id]?.options ?? {}) };
      for (const [k, v] of Object.entries(clean)) { if (v === null || v === '') delete cur[k]; else cur[k] = v; }
      s.adapters[adapter.id] = { ...(s.adapters[adapter.id] ?? {}), options: cur };
    }

    assertNoSharedChannels(s);
  });
  return { ok: true, ...settingsSummary(adapter), ...(cleared.length ? { cleared } : {}) };
}

/** The part of the settings the Studio needs back after a save (no keys). */
function settingsSummary(adapter) {
  const s = loadSettings();
  const byAccount = new Map(accountsFor(s, adapter.id).map((a) => [a.id, a.channelCache]));
  const mine = accountsFor(s, adapter.id);
  return {
    configured: adapter.needsAccount ? mine.some((a) => !!a.token) : true,
    accounts: mine.map((a) => ({ id: a.id, label: a.label, configured: !!a.token, lastTestedAt: a.lastTestedAt })),
    brands: brandsView(s, byAccount),
  };
}

/**
 * Ask an adapter whether one account can reach its service, and when it can, remember the channels it sees (and when we asked).
 * accountId may be left out when the adapter has exactly one account.
 */
export async function testAdapter(adapterId, accountId, role) {
  if (role !== 'human') throw new PublishError(403, 'Only the owner can test a connection, in the Studio.');
  const adapter = getAdapter(adapterId);
  if (!adapter.needsAccount) { const r = await adapter.check({}); return { ok: !!r.ok, message: r.message ?? '' }; }
  const settings = loadSettings();
  const mine = accountsFor(settings, adapter.id);
  let acc;
  if (accountId) { acc = mine.find((a) => a.id === String(accountId)); if (!acc) throw new PublishError(404, `There is no ${adapter.name} account "${accountId}".`); }
  else if (mine.length === 1) acc = mine[0];
  else if (!mine.length) return { ok: false, message: `${adapter.name} is not connected yet: save an API key for an account first.` };
  else throw new PublishError(400, `Say which account to test (${mine.map((a) => a.id).join(', ')}).`);
  const per = { token: acc.token, organizationId: acc.organizationId, options: adapterOptions(settings, adapter.id), channelCache: acc.channelCache };
  const r = await adapter.check(per);
  const out = { ok: !!r.ok, message: redact(r.message ?? '', acc.token), account: acc.id };
  let channels = null;
  if (r.ok && adapter.listChannels) {
    try {
      channels = await adapter.listChannels(per);
      memo.set(acc.id, { key: keyOf(acc), at: Date.now(), channels });
      out.channels = channels.map(shortChannel);
    } catch (e) {
      if (!(e instanceof PublishError)) throw e;
      out.ok = false; out.message = redact(e.message, acc.token);
    }
  }
  changeSettings((s) => { const a = s.accounts[acc.id]; if (a) { a.lastTestedAt = new Date().toISOString(); a.lastTestOk = out.ok; if (channels) a.channelCache = channels; } });
  return out;
}

// ---- running a plan -----------------------------------------------------------------------------------------------------------

/**
 * Hand the posts of a plan over. Owner only. Items (a post to one channel) go one at a time; a rate limit stops the run (the rest
 * are reported "Not attempted"). A post becomes "scheduled" when every channel in the plan has gone, whichever run sent which.
 * @returns {Promise<{results:{uid,key,channel,ok,message,scheduledAt,remoteId}[], posts:{uid,status,done,total}[], stopped?:string, warnings?:string[]}>}
 */
export async function runPlan(store, { planId, only, override = {}, times = {}, role, via = 'studio', now = Date.now() } = {}) {
  if (role !== 'human') throw new PublishError(403, 'Only the owner can schedule posts, in the Studio.');
  const plan = loadPlan(planId);
  if (plan.by !== 'human') throw new PublishError(403, 'That plan was made by Claude, so it cannot be run. Make your own plan (it takes a second) and run that.');
  if (now > Date.parse(plan.expires)) throw new PublishError(410, 'That plan has expired (plans last 15 minutes, because posts change). Make a new plan.');
  const adapter = getAdapter(plan.adapter);
  const settings = loadSettings();
  const wants = (it) => !!override && typeof override === 'object' && (override[it.key] === true || override[it.uid] === true);

  let selected;
  if (Array.isArray(only) && only.length) {
    const asked = [...new Set(only.map(String))];
    const stray = asked.filter((k) => !plan.items.some((i) => i.key === k || i.uid === k));
    if (stray.length) throw new PublishError(400, `Not in that plan: ${stray.join(', ')}.`);
    selected = plan.items.filter((i) => asked.includes(i.key) || asked.includes(i.uid));
  } else selected = plan.items.filter((i) => i.ready || (i.overridable && wants(i)));
  if (!selected.length) throw new PublishError(409, 'Nothing in that plan is ready to send.');
  if (selected.length > MAX_ITEMS) throw new PublishError(400, `At most ${MAX_ITEMS} items in one run.`);

  plan.done = plan.done ?? {};
  const results = [], batch = [];
  const cache = new Map(), evals = new Map(), probeCache = new Map(), started = new Set(), scheduledNow = new Set();
  const mergedTimes = { ...(plan.times ?? {}), ...(times && typeof times === 'object' ? times : {}) };
  let stopped = null;

  const audit = (it, entry) => {
    const dir = store.project(parseUid(it.uid)?.project ?? '')?.dir;
    if (dir) appendAudit(dir, { event: 'schedule', adapter: adapter.id, account: it.account ?? undefined, planId: plan.planId, uid: it.uid, channel: it.channel?.id, by: 'owner', via, ...entry });
  };
  const settle = (it, result, entry = {}) => {
    results.push(result);
    audit(it, { ok: result.ok, message: result.message, scheduledAt: result.scheduledAt ?? undefined, remoteId: result.remoteId ?? undefined, ...entry });
    savePlan(plan);
  };

  for (const it of selected) {
    const base = { uid: it.uid, key: it.key, channel: it.channel ?? null, ok: false, message: '', scheduledAt: null, remoteId: null };
    if (stopped) { results.push({ ...base, message: `Not attempted: ${stopped}` }); continue; }
    const before = plan.done[it.key];
    if (before?.ok) { results.push({ ...base, message: `This plan already handed that post over${it.channel ? ` to ${it.channel.name ?? it.channel.id}` : ''}.` }); continue; }
    if (before?.uncertain) { results.push({ ...base, message: 'The last try gave no clear answer. Look in the service to see whether the post is there, then make a new plan.' }); continue; }
    let fresh = null, attempted = false, tokenOf = null;
    try {
      let evald = evals.get(it.uid);
      if (!evald) evals.set(it.uid, evald = await evaluatePost(store, it.uid, { adapter, settings, times: mergedTimes, channels: plan.channels, stories: new Set(plan.stories ?? []), now, cache }));
      fresh = evald.find((t) => t.item.key === it.key) ?? null;
      tokenOf = fresh?.settings?.token ?? null;
      if (!fresh || fresh.item.fp !== it.fp) { settle(it, { ...base, message: 'This post changed after the plan was made (edited, re-rendered, rescheduled, signed off again, or its channels or account changed). Make a new plan.' }); continue; }
      const hard = fresh.item.blockers.filter((_, i) => !(fresh.item.codes[i].overridable && wants(it)));
      if (hard.length) { settle(it, { ...base, message: `Not sent: ${hard.join(' ')}` }); continue; }
      const post = fresh.post;
      if (adapter.coverFrame && post.format === 'reel' && post.variant !== 'story' && !Number.isFinite(post.coverTime)) {   // nobody chose a cover: pick the best frame now
        try { post.coverTime = await ensureCover(post); } catch { /* the post still goes: the service uses its own first frame */ }
      }
      const first = !started.has(it.uid);
      started.add(it.uid);
      attempted = true;
      const r = await adapter.schedule(post, { channel: post.channel, when: post.when }, fresh.settings, { firstOfPost: first, probeCache });
      let note = '';
      if (adapter.marksScheduled !== false && post.itemId) {
        try {
          const cid = post.targetId ?? post.channel?.id ?? adapter.id;
          const rec = await recordPublishTarget(post.projectDir, post.itemId, { adapter: adapter.id, channel: cid, ok: true, scheduledAt: r.scheduledAt, remoteId: r.remoteId }, { role: 'human' });
          const have = new Set((rec.item.publish?.targets ?? []).filter((t) => t.ok).map((t) => t.channel));
          const needed = plan.items.filter((x) => x.uid === it.uid).map((x) => x.targetId ?? x.channel?.id ?? adapter.id);
          if (needed.every((c) => have.has(c))) { await markScheduled(post.projectDir, post.itemId, { adapter: adapter.id, targets: rec.item.publish.targets }, { role: 'human' }); scheduledNow.add(it.uid); }
        } catch (e) { note = ` The calendar could not be updated (${e.message}): note it by hand.`; }
        forget(calendarPath(post.projectDir));
      }
      const result = { ...base, ok: true, message: `${redact(r.message ?? `Handed to ${adapter.name}.`, tokenOf)}${note}`, scheduledAt: r.scheduledAt ?? null, remoteId: r.remoteId ?? null };
      plan.done[it.key] = { ok: true, remoteId: result.remoteId };
      batch.push({ post, result });
      settle(it, result, { docId: post.docId, item: post.itemId, when: post.when, override: wants(it) && fresh.item.codes.some((c) => c.overridable) ? true : undefined });
    } catch (e) {
      const known = e instanceof PublishError;
      const message = redact(known ? e.message : `Unexpected problem: ${e.message}`, tokenOf);
      if (known && e.code === 'rate-limit') stopped = message;
      if (known && e.uncertain) plan.done[it.key] = { uncertain: true };
      if (attempted && adapter.marksScheduled !== false && fresh?.post?.itemId) {
        try { await recordPublishTarget(fresh.post.projectDir, fresh.post.itemId, { adapter: adapter.id, channel: fresh.post.targetId ?? fresh.post.channel?.id ?? adapter.id, ok: false, message }, { role: 'human' }); forget(calendarPath(fresh.post.projectDir)); } catch { /* the item moved: the result below still says what happened */ }
      }
      settle(it, { ...base, message }, { uncertain: known && e.uncertain ? true : undefined });
    }
  }

  const warnings = [];
  if (adapter.finalize && batch.length) {
    try { await adapter.finalize(batch, { planId: plan.planId }); } catch (e) { warnings.push(`The schedule file could not be written: ${e.message}`); }
  }
  savePlan(plan);
  const posts = [...new Set(selected.map((i) => i.uid))].map((uid) => {
    const mine = results.filter((r) => r.uid === uid), ok = mine.filter((r) => r.ok).length;
    const total = plan.items.filter((i) => i.uid === uid).length;
    const status = adapter.marksScheduled === false ? (ok && ok === mine.length ? 'exported' : ok ? 'partial' : 'failed') : scheduledNow.has(uid) ? 'scheduled' : ok ? 'partial' : 'failed';
    return { uid, status, done: ok, total };
  });
  return { results, posts, ...(stopped ? { stopped } : {}), ...(warnings.length ? { warnings } : {}) };
}

/** Does the owner's media hosting work end to end? (Puts a small test file in the bucket and reads it back from the public address.) */
export async function testHosting({ fetchImpl } = {}) {
  const h = loadSettings().hosting;
  if (!h?.endpoint) return { ok: false, message: 'Media hosting is not set up yet: add the bucket details first.' };
  return checkHosting(h, { fetchImpl });
}
