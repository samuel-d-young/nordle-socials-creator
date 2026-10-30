// Posts made by hand in Buffer shown on the calendar (src/publish/buffer-import.mjs), and Buffer read by itself every few hours (src/publish/auto-pull.mjs).
// A FAKE adapter holds the "Buffer" posts and a fake fetch the pictures, so nothing real is ever contacted.
//   node --test tests/buffer-import.test.mjs
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { newCalendar, saveCalendar, loadCalendar, validateCalendar } from '../src/calendar/model.mjs';
import { BUFFER_POSTS_SCHEMA } from '../src/publish/remote.mjs';
import { IMPORT_DAYS, MAX_NEW, coverUrl, formatFromPost, importFromBuffer, localParts, planImport } from '../src/publish/buffer-import.mjs';
import { createAutoPull } from '../src/publish/auto-pull.mjs';
import { planSync } from '../src/publish/sync.mjs';

const HOUR = 3600000, DAY = 24 * HOUR;
const ID = 'import-brand';
const TZ = 'Australia/Melbourne';
let root, dir, now, settings, buffer, listCalls, fetched, state;
const iso = (ms) => new Date(ms).toISOString();
const png = () => { const p = new PNG({ width: 4, height: 4 }); p.data.fill(200); return PNG.sync.write(p); };

before(() => { state = mkdtempSync(join(tmpdir(), 'nordle-import-state-')); process.env.NORDLE_PUBLISH_DIR = join(state, 'settings'); });
after(() => { delete process.env.NORDLE_PUBLISH_DIR; rmSync(state, { recursive: true, force: true }); });

const item = (id, o = {}) => ({ id, date: '2026-11-10', time: '12:00', format: 'post', title: `Title ${id}`, pillar: 'p', idea: 'An idea that is long enough to pass the checks.', status: 'signed-off', ...o });
const writeCal = (items) => { const cal = newCalendar(ID); cal.items = items; cal.timezone = TZ; saveCalendar(dir, cal); };
const readCal = () => loadCalendar(dir, ID);
const post = (id, o = {}) => ({ id, channelId: 'ch_ig', service: 'instagram', status: 'scheduled', dueAt: iso(now + 3 * DAY), sentAt: null, text: 'A hand made post about the new tasting menu we are trying this week.', createdAt: iso(now - HOUR),
  assets: [{ type: 'image', url: 'https://cdn.example.com/menu.png', thumbnail: null, mime: 'image/png' }], ...o });
const sentPost = (id, o = {}) => post(id, { status: 'sent', dueAt: iso(now - 2 * DAY), sentAt: iso(now - 2 * DAY), ...o });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nordle-import-'));
  dir = join(root, ID);
  mkdirSync(dir, { recursive: true });
  now = Date.parse('2026-10-10T00:00:00Z');
  buffer = []; listCalls = []; fetched = [];
  settings = {
    accounts: { acct: { adapter: 'buffer', token: 'not-a-real-key-123456', organizationId: 'org_1', channelCache: [
      { id: 'ch_ig', name: 'IG', service: 'instagram', organizationId: 'org_1' }, { id: 'ch_fb', name: 'FB', service: 'facebook', organizationId: 'org_1' }, { id: 'ch_other', name: 'Another brand', service: 'instagram', organizationId: 'org_1' }] } },
    brands: { [ID]: { account: 'acct', channels: [{ id: 'ch_ig', name: 'IG', service: 'instagram' }, { id: 'ch_fb', name: 'FB', service: 'facebook' }] } },
  };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const adapter = () => ({ async listPosts(_s, o) { listCalls.push(o); return { posts: buffer.filter((p) => o.channelIds.includes(p.channelId) && (o.filter?.status ?? ['scheduled', 'sending']).includes(p.status)).map((p) => ({ ...p })), pages: 1, complete: true, rate: {} }; } });
const fakeFetch = async (url) => { fetched.push(String(url)); return new Response(png(), { status: 200, headers: { 'content-type': 'image/png' } }); };
const store = () => ({ project: (id) => (id === ID ? { id: ID, dir } : null), scan: () => [{ id: ID, dir }] });
const run = (o = {}) => importFromBuffer(store(), { project: ID, role: 'human', now, adapter: adapter(), settings, fetchImpl: fakeFetch, ...o });
const writeSent = (posts) => { mkdirSync(join(dir, 'performance'), { recursive: true }); writeFileSync(join(dir, 'performance', 'buffer-posts.json'), JSON.stringify({ schema: BUFFER_POSTS_SCHEMA, pulledAt: iso(now - HOUR), posts })); };

// ---- planImport (pure) --------------------------------------------------------------------------------------------------------------

test('what is copied: posts nothing in Nordle owns; what is not: Nordle\'s own posts (by id or by words), drafts, a story at one of Nordle\'s own times, and very old posts', () => {
  const own = item('own', { status: 'scheduled', publish: { adapter: 'buffer', remoteId: 'b_own', at: iso(now), targets: [{ channel: 'ch_ig', ok: true, remoteId: 'b_own' }] } });
  const wordsItem = item('words', { external: { caption: 'Exactly the words of a post Nordle made and sent some other way, long enough to match.' } });
  const slotItem = item('slot', { date: '2026-10-13', time: '10:00' });
  const posts = [
    post('b_own'), post('b_words', { text: 'Exactly the words of a post Nordle made and sent some other way, long enough to match.' }), post('b_draft', { status: 'draft' }),
    post('b_story', { text: '', dueAt: '2026-10-12T23:10:00Z' }),                                   // 10:10 on the 13th in Melbourne: at the slot item's time
    sentPost('b_old', { sentAt: iso(now - (IMPORT_DAYS + 5) * DAY), dueAt: iso(now - (IMPORT_DAYS + 5) * DAY) }),
    post('b_new1', { text: 'Fresh tasting menu, hand typed in Buffer on the phone app today.' }),
  ];
  const r = planImport({ items: [own, wordsItem, slotItem], posts, tz: TZ, now });
  assert.deepEqual(r.create.map((g) => g.posts.map((p) => p.id)), [['b_new1']]);
  assert.deepEqual(r.skipped, { owned: 3, old: 1, notPosts: 1, overLimit: 0 });
});

test('one hand-made post sent to two channels is one item with two targets; a story with no words is grouped by its minute and picture', () => {
  const words = 'Same words on two channels, typed once in Buffer and sent to both pages.';
  const r = planImport({ items: [], posts: [post('b1', { text: words }), post('b2', { channelId: 'ch_fb', service: 'facebook', text: words, dueAt: iso(now + 3 * DAY + 30000) }), post('s1', { text: '', service: 'instagram', dueAt: iso(now + 4 * DAY) })], tz: TZ, now });
  assert.equal(r.create.length, 2);
  assert.deepEqual(r.create.map((g) => g.posts.length).sort(), [1, 2]);
});

test('an item copied from Buffer follows it: sent becomes posted, a moved time moves the item, a post deleted in Buffer is marked removed', () => {
  const mk = (id, o = {}) => item(id, { origin: 'buffer', status: 'scheduled', date: '2026-10-13', time: '10:00', publish: { adapter: 'buffer', scheduledAt: iso(now + 3 * DAY), remoteId: `r_${id}`, at: iso(now), targets: [{ channel: 'ch_ig', ok: true, remoteId: `r_${id}` }] }, ...o });
  const items = [mk('sent'), mk('moved'), mk('deleted'), mk('done', { status: 'posted' })];
  const sentAt = '2026-10-12T05:00:00Z';                                                              // 16:00 on the 12th in Melbourne
  const r = planImport({ items, posts: [post('r_sent', { status: 'sent', sentAt, dueAt: sentAt }), post('r_moved', { dueAt: '2026-10-15T01:30:00Z' })], tz: TZ, now });
  assert.deepEqual(r.update.find((u) => u.id === 'sent').patch, { status: 'posted', date: '2026-10-12', time: '16:00' });
  assert.deepEqual(r.update.find((u) => u.id === 'moved').patch, { date: '2026-10-15', time: '12:30' });
  assert.deepEqual(r.gone, ['deleted']);
  assert.equal(planImport({ items, posts: [], tz: TZ, now, pendingComplete: false }).gone.length, 0, 'a list that was not read to the end proves nothing is gone');
});

test('at most MAX_NEW new posts are copied in one run, newest first, and the rest are counted', () => {
  const posts = Array.from({ length: MAX_NEW + 7 }, (_, i) => post(`p${i}`, { text: `Hand made post number ${i} with enough words to be told apart from the rest.`, dueAt: iso(now + (i + 1) * HOUR) }));
  const r = planImport({ items: [], posts, tz: TZ, now });
  assert.equal(r.create.length, MAX_NEW);
  assert.equal(r.skipped.overLimit, 7);
});

test('formats and local times', () => {
  assert.equal(formatFromPost({ service: 'instagram', text: '', assets: [{ type: 'image' }] }), 'story');
  assert.equal(formatFromPost({ service: 'instagram', text: 'x', assets: [{ type: 'video' }] }), 'reel');
  assert.equal(formatFromPost({ service: 'instagram', text: 'x', assets: [{ type: 'image' }, { type: 'image' }] }), 'carousel');
  assert.equal(formatFromPost({ service: 'facebook', text: 'x', assets: [] }), 'post');
  assert.deepEqual(localParts('2026-10-12T05:00:00Z', TZ), { date: '2026-10-12', time: '16:00', minutes: 960 });
  assert.equal(coverUrl([{ assets: [{ type: 'video', url: 'https://c.example/v.mp4', thumbnail: 'https://c.example/t.jpg' }] }]), 'https://c.example/t.jpg');
});

// ---- importFromBuffer ---------------------------------------------------------------------------------------------------------------

test('a post made by hand in Buffer appears on the calendar, read only, with its words, channels and picture; the calendar stays valid', async () => {
  writeCal([item('mine', { status: 'idea' })]);
  buffer = [post('b1', { text: 'Tasting menu is here. Come and try three new plates this weekend. #menu #local' }), post('b_other', { channelId: 'ch_other', text: 'A different brand shares this Buffer account and its post must not appear here.' })];
  const r = await run();
  assert.equal(r.ok, true);
  assert.equal(r.created, 1);
  assert.deepEqual(listCalls.flatMap((c) => c.channelIds).sort(), ['ch_fb', 'ch_ig'], 'only this brand\'s chosen channels are asked for, not the whole account');
  const cal = readCal();
  assert.equal(validateCalendar(cal).ok, true);
  const it = cal.items.find((i) => i.origin === 'buffer');
  assert.equal(it.status, 'scheduled');
  assert.equal(it.format, 'post');
  assert.equal(it.title, 'Tasting menu is here. Come and try three new plates this weekend.');
  assert.deepEqual(it.external.hashtags, ['#menu', '#local']);
  assert.match(it.external.note, /Read only/);
  assert.equal(it.publish.targets[0].remoteId, 'b1');
  assert.equal(it.publish.targets[0].channel, 'ch_ig');
  assert.deepEqual(fetched, ['https://cdn.example.com/menu.png']);
  assert.equal(it.external.cover, `external/${it.id}/cover.png`);
  assert.ok(existsSync(join(dir, it.external.cover)), 'the picture was saved in the project');
  assert.equal(cal.items.find((i) => i.id === 'mine').status, 'idea', 'Nordle\'s own items are not touched');
});

test('running it again adds nothing; when Buffer sends the post the item becomes posted; when the post is deleted in Buffer the item is marked rejected', async () => {
  writeCal([]);
  buffer = [post('b1', { dueAt: iso(now + 2 * DAY) })];
  assert.equal((await run()).created, 1);
  assert.equal((await run()).created, 0, 'the second run finds it already owned');
  assert.equal(readCal().items.length, 1);

  buffer = [];
  writeSent([sentPost('b1', { sentAt: '2026-10-12T05:00:00Z', dueAt: '2026-10-12T05:00:00Z' })]);
  const r2 = await run({ now: now + 3 * DAY });
  assert.equal(r2.updated, 1);
  const it = readCal().items[0];
  assert.equal(it.status, 'posted');
  assert.equal(it.date, '2026-10-12');
  assert.equal(it.time, '16:00');

  writeCal([{ ...it, status: 'scheduled', publish: { ...it.publish, scheduledAt: iso(now + 9 * DAY) } }]);
  writeSent([]);
  const r3 = await run();
  assert.equal(r3.gone, 1);
  assert.equal(readCal().items[0].status, 'rejected');
  assert.match(readCal().items[0].notes, /removed in Buffer/);
});

test('a picture on a private address is never fetched, and a picture that fails does not stop the import', async () => {
  writeCal([]);
  buffer = [post('b1', { assets: [{ type: 'image', url: 'https://localhost/secret.png', thumbnail: null, mime: 'image/png' }] }), post('b2', { text: 'Second hand made post with enough words to be its own group today.', assets: [{ type: 'image', url: 'https://cdn.example.com/b.png', thumbnail: null, mime: 'image/png' }] })];
  const r = await run({ fetchImpl: async (url) => { fetched.push(String(url)); throw new Error('network down'); } });
  assert.equal(r.created, 2);
  assert.equal(r.covers, 0);
  assert.deepEqual(fetched, ['https://cdn.example.com/b.png'], 'only the public address was tried');
  assert.ok(readCal().items.every((i) => !i.external.cover));
});

test('only the owner may copy posts in, a brand with no Buffer account or channels says so, and drafts are not copied', async () => {
  writeCal([]);
  await assert.rejects(run({ role: 'agent' }), (e) => e.status === 403);
  await assert.rejects(run({ settings: { accounts: {}, brands: {} } }), (e) => e.status === 409);
  await assert.rejects(run({ settings: { ...settings, brands: { [ID]: { account: 'acct', channels: [] } } } }), (e) => e.status === 409);
  buffer = [post('b_draft', { status: 'draft' })];
  assert.equal((await run()).created, 0);
});

test('sync never moves, adopts or deletes a post that belongs to an item copied from Buffer', async () => {
  const caption = 'A hand made post about the new tasting menu we are trying this week with three plates.';
  writeCal([item('copied', { origin: 'buffer', status: 'scheduled', date: '2026-10-20', time: '09:00', external: { caption }, publish: { adapter: 'buffer', scheduledAt: iso(now + 3 * DAY), remoteId: 'b1', at: iso(now), targets: [{ channel: 'ch_ig', ok: true, scheduledAt: iso(now + 3 * DAY), remoteId: 'b1' }] } })]);
  buffer = [post('b1', { text: caption, dueAt: iso(now + 3 * DAY) }), post('b2', { text: caption, channelId: 'ch_fb', service: 'facebook' })];
  const syncSettings = { accounts: { [ID]: { adapter: 'buffer', token: 'not-a-real-key-123456', channelCache: settings.accounts.acct.channelCache } }, brands: {} };
  const p = await planSync(dir, { role: 'human', now, adapter: adapter(), settings: syncSettings });
  assert.deepEqual(p.actions, [], 'no move, adopt or delete is planned for it');
  assert.equal(p.missing.length, 0);
});

// ---- the automatic pull -------------------------------------------------------------------------------------------------------------

test('the automatic pull reads Buffer for a connected brand when it is due, not again until six hours have passed, waits an hour after a failure, and can be turned off', async () => {
  const calls = [];
  let clock = now, last = 0, fail = false;
  const mk = (s = settings) => createAutoPull({
    now: () => clock, log: () => {}, settingsOf: () => s, lastPull: () => last,
    pull: async () => { calls.push('pull'); if (fail) throw new Error('allowance'); last = clock; return { fetched: 3, requests: 1 }; },
    metrics: async () => { calls.push('metrics'); return { matched: 2 }; },
    bring: async () => { calls.push('bring'); return { created: 1, updated: 0, gone: 0 }; },
  });
  const s = store();
  const ap = mk();
  await ap.tick(s);
  assert.deepEqual(calls, ['pull', 'metrics', 'bring']);
  clock += 2 * HOUR; await ap.tick(s);
  assert.equal(calls.length, 3, 'two hours later nothing is asked');
  clock += 5 * HOUR; await ap.tick(s);
  assert.equal(calls.length, 6, 'seven hours later it reads again');

  fail = true; clock += 7 * HOUR; await ap.tick(s);
  assert.equal(calls.length, 7, 'a failed read is tried once');
  clock += 20 * 60000; await ap.tick(s);
  assert.equal(calls.length, 7, 'and not again for an hour');
  fail = false; clock += HOUR; await ap.tick(s);
  assert.equal(calls.length, 10, 'then it tries again');

  const before = calls.length;
  clock += 8 * HOUR;
  await mk({ ...settings, autoPull: { enabled: false } }).tick(s);
  await mk({ accounts: {}, brands: {} }).tick(s);
  assert.equal(calls.length, before, 'switched off, or a brand with no Buffer account: nothing is asked');
});
