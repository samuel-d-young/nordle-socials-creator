// Keep Buffer in step with Nordle: what Buffer still holds to post (scheduled, sending, draft, needs approval, error) is compared with what the calendar says,
// and Buffer is changed to match. Nordle is the truth.
//
//   known       a Buffer post whose id is recorded on a calendar item (item.publish.targets[].remoteId)
//                 -> time differs from Nordle's           MOVE it to Nordle's time (the owner moved the post on the calendar: same time of day on the new day)
//   unrecorded  a scheduled Buffer post with no record, whose words (first 60 letters) are the caption of a calendar item
//                 -> that item is signed off or scheduled  ADOPT it: move it to the item's slot and record it on the item, so Nordle knows it
//                 -> that item is not signed off (built, changes, rejected, idea)   DELETE it: Nordle does not mean this to go out yet
//   unknown     a scheduled Buffer post that matches nothing in Nordle (made by hand in Buffer, a Story with no words): left alone and listed,
//               unless the owner asks for those to go too (includeUnknown)
//   stale       drafts, posts needing approval and errors: listed, never touched unless the owner asks (includeStale)
//   missing     a post Nordle thinks is scheduled for later that Buffer does not hold: listed (the Studio's "is it still there?" takes it back so it can be scheduled again)
//
// Owner only (role 'human'): it changes things in Buffer. planSync reads (one request per 100 posts); runSync does the changes (one request each) and
// writes every one to the project's publish log. A plan is bound to the moment it was made: the run changes only what the plan listed.

import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadProject, markScheduled, markUnscheduled } from '../calendar/service.mjs';
import { DEFAULT_POST_TIMES } from '../calendar/plan.mjs';
import { zonedToUtc } from './plan.mjs';
import { PublishError, appendAudit, loadSettings, resolveSettings } from './store.mjs';
import { getAdapter } from './index.mjs';
import { guardAllowance } from './remote.mjs';

const PENDING = ['scheduled', 'sending', 'draft', 'needs_approval', 'error'];
const GOING = new Set(['scheduled', 'sending']);
const STORY = /#story$/;
const MOVE_TOLERANCE_MS = 60000;
const MIN_LEAD_MS = 3 * 60000;
const MAX_CHANGES = 60;
const owner = (role) => { if (role !== 'human') throw new PublishError(403, 'Only the owner can change what is in Buffer.'); };
const dayIn = (iso, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
const clockIn = (iso, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
const norm = (t) => String(t ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 60);
const stamp = (iso, tz) => (iso ? new Date(iso).toLocaleString('en-AU', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) : 'no time');

/** the words of an item as Buffer got them (the document's caption), or '' */
export function captionOf(dir, item) {
  if (!item.doc) return item.external?.caption ?? '';
  try { return JSON.parse(readFileSync(join(dir, 'docs', `${item.doc}.json`), 'utf8'))?.copy?.caption ?? ''; } catch { return ''; }
}

/**
 * Read Buffer and work out what has to change. Reads only. Returns { project, timezone, requests, complete, actions[], unknown[], stale[], missing[], kept }.
 * `adapter` and `settings` can be given so tests never touch the network.
 */
export async function planSync(projectDir, { role, now = Date.now(), adapter = getAdapter('buffer'), settings = loadSettings(), includeUnknown = false, includeStale = false } = {}) {
  owner(role);
  const id = basename(projectDir);
  const proj = loadProject(projectDir);
  const tz = proj.timezone ?? 'Australia/Melbourne';
  const s = resolveSettings(settings, 'buffer', id);
  if (!s.token) throw new PublishError(409, 'This brand has no Buffer account connected yet.');
  const channels = s.channelCache ?? [];
  if (!channels.length) throw new PublishError(409, 'No Buffer channels are known for this brand yet: test the connection in Publishing first.');
  const chanName = new Map(channels.map((c) => [c.id, `${c.name} (${c.service})`]));
  const byOrg = new Map();
  for (const c of channels) (byOrg.get(c.organizationId) ?? byOrg.set(c.organizationId, []).get(c.organizationId)).push(c.id);

  // 1. what Buffer holds
  const held = [];
  let requests = 0, complete = true, stopped = null;
  for (const [org, ids] of byOrg) {
    guardAllowance(s.account?.id, 'Reading Buffer');
    const r = await adapter.listPosts(s, { organizationId: org, channelIds: ids, filter: { status: PENDING }, text: true, maxPages: 10 });
    requests += r.pages;
    if (!r.complete) { complete = false; stopped = r.stopped ?? 'the list was not read to the end'; }
    held.push(...r.posts);
  }
  const heldIds = new Set(held.map((p) => p.id));

  // 2. what Nordle says
  const items = proj.cal.items;
  const known = new Map();                              // remoteId -> { item, target }
  for (const it of items) for (const t of it.publish?.targets ?? []) if (t.ok && t.remoteId) known.set(String(t.remoteId), { item: it, target: t });
  const byCaption = new Map();                          // first 60 letters -> item
  for (const it of items) { if (it.origin === 'buffer') continue; const k = norm(captionOf(projectDir, it)); if (k.length >= 20 && !byCaption.has(k)) byCaption.set(k, it); }
  const defaultTime = proj.settings.postTimes?.[0] ?? DEFAULT_POST_TIMES[0];

  const actions = [], unknown = [], stale = [], missing = [];
  let kept = 0;
  const label = (p) => `${chanName.get(p.channelId) ?? p.channelId}${p.service === 'instagram' && !p.text ? ' (story?)' : ''}`;
  for (const p of held) {
    if (!GOING.has(p.status)) { stale.push({ id: p.id, status: p.status, dueAt: p.dueAt, channel: label(p), text: String(p.text ?? '').replace(/\s+/g, ' ').slice(0, 80) }); continue; }
    const k = known.get(p.id);
    if (k) {
      const { item, target } = k;
      if (item.origin === 'buffer') { kept++; continue; }          // made by hand in Buffer and copied onto the calendar (buffer-import.mjs): read only, never moved from here
      const recorded = target.scheduledAt ?? item.publish?.scheduledAt;
      const wanted = recorded && dayIn(recorded, tz) !== item.date ? zonedToUtc(item.date, clockIn(recorded, tz), tz) : new Date(recorded ?? p.dueAt);
      if (Math.abs(wanted - new Date(p.dueAt)) <= MOVE_TOLERANCE_MS) { kept++; continue; }
      if (wanted.getTime() < now + MIN_LEAD_MS) { unknown.push({ id: p.id, channel: label(p), dueAt: p.dueAt, why: `Nordle's time (${stamp(wanted, tz)}) has already passed`, item: item.title }); continue; }
      actions.push({ kind: 'move', id: p.id, channelId: p.channelId, channel: label(p), item: item.id, title: item.title, from: p.dueAt, to: wanted.toISOString(), because: `Nordle has it at ${stamp(wanted, tz)}`, target: target.channel });
      continue;
    }
    const match = p.text ? byCaption.get(norm(p.text)) : null;
    if (match) {
      if (match.status === 'signed-off' || match.status === 'scheduled') {
        const slot = zonedToUtc(match.date, match.time ?? defaultTime, tz);
        if (slot.getTime() < now + MIN_LEAD_MS) { unknown.push({ id: p.id, channel: label(p), dueAt: p.dueAt, why: `its slot in Nordle (${stamp(slot, tz)}) has already passed`, item: match.title }); continue; }
        actions.push({ kind: 'adopt', id: p.id, channelId: p.channelId, channel: label(p), item: match.id, title: match.title, from: p.dueAt, to: slot.toISOString(), because: `it is "${match.title}", signed off for ${stamp(slot, tz)}`, target: p.channelId });
      } else {
        actions.push({ kind: 'delete', id: p.id, channelId: p.channelId, channel: label(p), item: match.id, title: match.title, from: p.dueAt, because: `"${match.title}" is ${match.status} in Nordle, not signed off` });
      }
      continue;
    }
    if (includeUnknown) actions.push({ kind: 'delete', id: p.id, channelId: p.channelId, channel: label(p), title: String(p.text ?? '(no words)').replace(/\s+/g, ' ').slice(0, 60), from: p.dueAt, because: 'nothing in Nordle matches it' });
    else unknown.push({ id: p.id, channel: label(p), dueAt: p.dueAt, why: 'nothing in Nordle matches it', text: String(p.text ?? '').replace(/\s+/g, ' ').slice(0, 70) });
  }
  if (includeStale) for (const x of stale.splice(0)) actions.push({ kind: 'delete', id: x.id, channel: x.channel, title: x.text || `(${x.status})`, from: x.dueAt, because: `a ${x.status} post nobody is posting` });

  // 3. what Nordle thinks is waiting that Buffer does not hold (only when the listing was read to the end)
  if (complete) for (const [rid, { item, target }] of known) {
    const due = target.scheduledAt ?? item.publish?.scheduledAt;
    if (item.origin !== 'buffer' && item.status === 'scheduled' && !heldIds.has(rid) && due && new Date(due).getTime() > now + MIN_LEAD_MS) missing.push({ item: item.id, title: item.title, channel: chanName.get(String(target.channel).replace(STORY, '')) ?? target.channel, story: STORY.test(target.channel), dueAt: due });
  }
  return { project: id, timezone: tz, madeAt: now, requests, complete, ...(stopped ? { stopped } : {}), kept, actions: actions.slice(0, MAX_CHANGES), more: Math.max(0, actions.length - MAX_CHANGES), unknown, stale, missing };
}

/**
 * Make the changes a plan lists, one request each, and keep Nordle's own record true (a moved post gets its new time, an adopted post is recorded on its
 * item). Stops at the first Buffer error that would affect every request (rate limit, bad key). Returns { done[], failed[] }.
 */
export async function runSync(projectDir, plan, { role, adapter = getAdapter('buffer'), settings = loadSettings(), now = Date.now() } = {}) {
  owner(role);
  const id = basename(projectDir);
  const s = resolveSettings(settings, 'buffer', id);
  if (!s.token) throw new PublishError(409, 'This brand has no Buffer account connected yet.');
  if (now - plan.madeAt > 15 * 60000) throw new PublishError(409, 'That plan is more than 15 minutes old: make a new one so it matches what Buffer holds now.');
  const done = [], failed = [];
  const adopted = new Map();                                     // item id -> targets recorded
  for (const a of plan.actions) {
    try {
      let r;
      if (a.kind === 'delete') r = await adapter.deletePost(s, a.id);
      else if (a.kind === 'adopt' && Math.abs(new Date(a.to) - new Date(a.from)) <= MOVE_TOLERANCE_MS) r = { message: 'Already at the right time.', scheduledAt: a.from };
      else r = await adapter.moveDue(s, a.id, a.to);
      done.push({ ...a, message: r.message });
      appendAudit(projectDir, { event: `sync-${a.kind}`, adapter: 'buffer', account: s.account?.id, item: a.item, ok: true, by: 'owner', via: 'sync', channel: a.channelId, remoteId: a.id, scheduledAt: a.to, message: `${a.kind === 'delete' ? 'Deleted' : a.kind === 'adopt' ? 'Adopted and moved' : 'Moved'}: ${a.because}` });
      if ((a.kind === 'move' || a.kind === 'adopt') && a.item) (adopted.get(a.item) ?? adopted.set(a.item, []).get(a.item)).push({ channel: a.target, ok: true, scheduledAt: r.scheduledAt ?? a.to, remoteId: a.id });
    } catch (e) {
      failed.push({ ...a, error: e.message });
      appendAudit(projectDir, { event: `sync-${a.kind}`, adapter: 'buffer', account: s.account?.id, item: a.item, ok: false, by: 'owner', via: 'sync', channel: a.channelId, remoteId: a.id, message: e.message, uncertain: e.uncertain || undefined });
      if (e instanceof PublishError && ['rate-limit', 'auth', 'not-configured'].includes(e.code)) break;
    }
  }
  // keep Nordle's record true: a post that is already "scheduled" cannot take a new result, so it is taken back and scheduled again with the corrected targets
  for (const [itemId, targets] of adopted) {
    try {
      const item = loadProject(projectDir).cal.items.find((i) => i.id === itemId);
      if (!item) continue;
      const all = [...(item.publish?.targets ?? []).filter((t) => !targets.some((x) => x.channel === t.channel)), ...targets];
      if (item.status === 'scheduled') await markUnscheduled(projectDir, itemId, {}, { role: 'human' });
      await markScheduled(projectDir, itemId, { adapter: 'buffer', targets: all }, { role: 'human' });
    } catch (e) { failed.push({ kind: 'record', item: itemId, channel: '-', error: `Buffer was changed but Nordle could not record it: ${e.message}` }); }
  }
  return { done, failed };
}

/** The plan in words, for the command line and the Studio. */
export function describeSync(plan) {
  const tz = plan.timezone;
  const lines = [];
  const by = (k) => plan.actions.filter((a) => a.kind === k);
  lines.push(`${plan.project}: Buffer holds ${plan.kept + plan.actions.length + plan.unknown.length + plan.stale.length} not-yet-sent posts; ${plan.kept} already match Nordle.`);
  for (const a of by('move')) lines.push(`  MOVE    ${a.channel}  ${stamp(a.from, tz)} -> ${stamp(a.to, tz)}   "${a.title}" (${a.because})`);
  for (const a of by('adopt')) lines.push(`  ADOPT   ${a.channel}  ${stamp(a.from, tz)} -> ${stamp(a.to, tz)}   "${a.title}" (${a.because})`);
  for (const a of by('delete')) lines.push(`  DELETE  ${a.channel}  ${stamp(a.from, tz)}   "${a.title}" (${a.because})`);
  for (const u of plan.unknown) lines.push(`  LEFT    ${u.channel}  ${stamp(u.dueAt, tz)}   ${u.item ? `"${u.item}" ` : ''}${u.text ? `"${u.text}" ` : ''}(${u.why})`);
  for (const x of plan.stale) lines.push(`  LEFT    ${x.channel}  ${x.status}${x.dueAt ? ` ${stamp(x.dueAt, tz)}` : ''}   "${x.text}" (not going out: draft, needs approval or error)`);
  for (const m of plan.missing) lines.push(`  MISSING ${m.channel}${m.story ? ' story' : ''}  ${stamp(m.dueAt, tz)}   "${m.title}" (Nordle says scheduled, Buffer does not hold it)`);
  if (plan.more) lines.push(`  ... and ${plan.more} more changes: run again after this one`);
  if (!plan.complete) lines.push(`  NOTE    ${plan.stopped}: some posts may not be listed, so nothing is called missing`);
  return lines.join('\n');
}
