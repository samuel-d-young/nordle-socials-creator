// Keeping Buffer in step with Nordle (src/publish/sync.mjs, auto-sync.mjs): a FAKE adapter holds the "Buffer" posts, so nothing real is ever contacted.
//   node --test tests/publish-sync.test.mjs
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newCalendar, saveCalendar, loadCalendar } from '../src/calendar/model.mjs';
import { describeSync, planSync, runSync } from '../src/publish/sync.mjs';
import { createAutoSync, calendarSignature } from '../src/publish/auto-sync.mjs';

const HOUR = 3600000;
let dir, now, buffer, adapter, settings, calls;
const ID = 'sync-brand';
const iso = (ms) => new Date(ms).toISOString();

function item(id, o = {}) {
  return { id, date: '2026-11-10', time: '12:00', format: 'post', title: `Title ${id}`, pillar: 'p', idea: 'An idea that is long enough to pass the checks.', status: 'signed-off', ...o };
}
const writeCal = (items) => { const cal = newCalendar(ID); cal.items = items; cal.timezone = 'Australia/Melbourne'; saveCalendar(dir, cal); };
const readCal = () => loadCalendar(dir, ID);
const captionDoc = (doc, caption) => { mkdirSync(join(dir, 'docs'), { recursive: true }); writeFileSync(join(dir, 'docs', `${doc}.json`), JSON.stringify({ copy: { caption } })); };
const post = (id, o = {}) => ({ id, channelId: 'ch_ig', service: 'instagram', status: 'scheduled', dueAt: iso(now + 5 * 24 * HOUR), text: '', createdAt: iso(now - HOUR), ...o });

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'nordle-sync-')), ID);
  mkdirSync(dir, { recursive: true });
  now = Date.parse('2026-10-10T00:00:00Z');
  buffer = [];
  calls = [];
  adapter = {
    async listPosts() { return { posts: buffer.map((p) => ({ ...p })), pages: 1, complete: true, rate: {} }; },
    async deletePost(_s, id) { calls.push(['delete', id]); buffer = buffer.filter((p) => p.id !== id); return { message: 'Deleted from Buffer.' }; },
    async moveDue(_s, id, when) { calls.push(['move', id, when]); const p = buffer.find((x) => x.id === id); p.dueAt = new Date(when).toISOString(); return { scheduledAt: p.dueAt, message: 'Moved in Buffer.' }; },
  };
  settings = { accounts: { [ID]: { adapter: 'buffer', token: 'not-a-real-key-123456', channelCache: [{ id: 'ch_ig', name: 'IG', service: 'instagram', organizationId: 'org_1' }] } }, brands: {} };
});
afterEach(() => rmSync(join(dir, '..'), { recursive: true, force: true }));

const plan = (o = {}) => planSync(dir, { role: 'human', now, adapter, settings, ...o });

test('only the owner may look, plan or change (the agent gets 403)', async () => {
  writeCal([item('a')]);
  await assert.rejects(planSync(dir, { role: 'agent', adapter, settings }), (e) => e.status === 403);
  const p = await plan();
  await assert.rejects(runSync(dir, p, { role: 'agent', adapter, settings }), (e) => e.status === 403);
});

test('a post moved on the calendar is moved in Buffer to the new day, at the same time of day, and Nordle keeps its record', async () => {
  const due = Date.parse('2026-11-03T02:00:00Z');                 // 13:00 Melbourne
  writeCal([item('a', { doc: 'a', status: 'scheduled', date: '2026-11-05', time: '13:00', publish: { adapter: 'buffer', scheduledAt: iso(due), remoteId: 'b1', at: iso(now), targets: [{ channel: 'ch_ig', ok: true, scheduledAt: iso(due), remoteId: 'b1' }] } })]);
  buffer = [post('b1', { dueAt: iso(due) })];
  const p = await plan();
  assert.equal(p.actions.length, 1);
  assert.equal(p.actions[0].kind, 'move');
  assert.equal(p.actions[0].to, '2026-11-05T02:00:00.000Z');
  const r = await runSync(dir, p, { role: 'human', adapter, settings, now });
  assert.deepEqual(r.failed, []);
  assert.deepEqual(calls, [['move', 'b1', '2026-11-05T02:00:00.000Z']]);
  const it = readCal().items[0];
  assert.equal(it.status, 'scheduled');
  assert.equal(it.publish.targets[0].scheduledAt, '2026-11-05T02:00:00.000Z');
  assert.equal((await plan()).actions.length, 0, 'a second look finds nothing left to change');
});

test('an unrecorded Buffer post whose words are a signed-off post is adopted, and one for a post that is not signed off is deleted', async () => {
  const caption = 'Meet the team who will look after you when you visit our practice this month.';
  const other = 'Everything you need to know before your first implant visit, in plain words.';
  writeCal([item('team', { doc: 'team', date: '2026-10-20', time: '09:00' }), item('implant', { doc: 'implant', status: 'built', date: '2026-10-22' })]);
  captionDoc('team', caption); captionDoc('implant', other);
  buffer = [post('t1', { text: `${caption}\n\n#team`, dueAt: iso(now + 40 * 24 * HOUR) }), post('i1', { text: other, dueAt: iso(now + 6 * 24 * HOUR) })];
  const p = await plan();
  assert.deepEqual(p.actions.map((a) => [a.kind, a.id]).sort(), [['adopt', 't1'], ['delete', 'i1']]);
  const r = await runSync(dir, p, { role: 'human', adapter, settings, now });
  assert.deepEqual(r.failed, []);
  assert.deepEqual(buffer.map((x) => x.id), ['t1']);
  assert.equal(buffer[0].dueAt, '2026-10-19T22:00:00.000Z', 'moved to the slot Nordle has: 20 Oct 09:00 in Melbourne');
  const team = readCal().items.find((i) => i.id === 'team');
  assert.equal(team.status, 'scheduled');
  assert.equal(team.publish.targets[0].remoteId, 't1');
});

test('posts that match nothing in Nordle, drafts and errors are left alone unless the owner asks', async () => {
  writeCal([item('a')]);
  buffer = [post('m1', { text: 'A post somebody wrote by hand in Buffer.' }), post('d1', { status: 'draft', dueAt: null, text: 'A draft' }), post('e1', { status: 'error', text: 'Failed once' })];
  const p = await plan();
  assert.equal(p.actions.length, 0);
  assert.equal(p.unknown.length, 1);
  assert.equal(p.stale.length, 2);
  assert.match(describeSync(p), /LEFT/);
  const all = await plan({ includeUnknown: true, includeStale: true });
  assert.deepEqual(all.actions.map((a) => a.id).sort(), ['d1', 'e1', 'm1']);
});

test('a scheduled post that Buffer no longer holds is reported missing, never invented', async () => {
  const due = now + 3 * 24 * HOUR;
  writeCal([item('a', { status: 'scheduled', publish: { adapter: 'buffer', scheduledAt: iso(due), remoteId: 'gone', at: iso(now), targets: [{ channel: 'ch_ig', ok: true, scheduledAt: iso(due), remoteId: 'gone' }] } })]);
  const p = await plan();
  assert.equal(p.actions.length, 0);
  assert.equal(p.missing.length, 1);
  assert.equal(p.missing[0].item, 'a');
});

test('a plan older than 15 minutes is refused, and Buffer is not called when the plan is empty', async () => {
  writeCal([item('a')]);
  const p = await plan();
  await assert.rejects(runSync(dir, p, { role: 'human', adapter, settings, now: now + 16 * 60000 }), (e) => e.status === 409);
  assert.deepEqual(calls, []);
});

test('the automatic sync waits for the calendar to be quiet, then runs once, and its own changes do not start it again', async () => {
  writeCal([item('a')]);
  let t = now;
  const logs = [];
  const ran = [];
  const store = { scan: () => [{ id: ID, dir }] };
  const sync = createAutoSync({ now: () => t, log: (m) => logs.push(m), plan: async (d) => { ran.push('plan'); return { actions: [], kept: 0, missing: [], unknown: [], stale: [] }; }, run: async () => ({ done: [], failed: [] }) });
  // settings come from the real settings file; point it at a throw-away folder with a key for this brand
  process.env.NORDLE_PUBLISH_DIR = join(dir, '..', 'publish');
  mkdirSync(process.env.NORDLE_PUBLISH_DIR, { recursive: true });
  writeFileSync(join(process.env.NORDLE_PUBLISH_DIR, 'publish.json'), JSON.stringify({ schema: 'nordle.publish/0.1', accounts: { [ID]: { adapter: 'buffer', token: 'not-a-real-key-123456', channelCache: [{ id: 'ch_ig', name: 'IG', service: 'instagram', organizationId: 'org_1' }] } } }));
  await sync.tick(store);
  assert.equal(ran.length, 1, 'looks once when the server starts');
  t += 5 * 60000;
  await sync.tick(store);
  assert.equal(ran.length, 1, 'nothing changed, so nothing is read');
  writeCal([item('a', { date: '2026-11-12' })]);
  t += 60000;
  await sync.tick(store);
  assert.equal(ran.length, 1, 'the calendar just changed: wait until it has been quiet for a minute');
  t += 11 * 60000;
  await sync.tick(store);
  assert.equal(ran.length, 2, 'changed, quiet, and the minimum gap has passed: one run');
  await sync.tick(store);
  assert.equal(ran.length, 2);
  assert.notEqual(calendarSignature(dir), '');
  delete process.env.NORDLE_PUBLISH_DIR;
});
