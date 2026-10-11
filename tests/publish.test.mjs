// Publishing: plans and their blockers, the export folder, the Buffer adapter against a FAKE Buffer on 127.0.0.1 (nothing real is ever
// contacted), who may run what, plan expiry and staleness, secrets never leaking, and the calendar's "scheduled" step.
//   node --test tests/publish.test.mjs
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../tools/validate.mjs';
import { createNordleServer } from '../src/server/http.mjs';
import { setCoverTime } from '../src/publish/covers.mjs';
import { readSentPosts } from '../src/publish/remote.mjs';
import { allowancePath, clearAllowanceMemo, recordAllowance } from '../src/publish/store.mjs';
import { Store } from '../src/server/store.mjs';
import { loadCalendar, newCalendar, saveCalendar, validateCalendar } from '../src/calendar/model.mjs';
import { decide, markScheduled, recordPublishTarget, updateItem } from '../src/calendar/service.mjs';
import { NordleClient, NordleError } from '../src/mcp/client.mjs';
import { createTools } from '../src/mcp/tools.mjs';
import { clearChannelMemo, configure, buildPlan, describeAdapter, getAdapter, runPlan } from '../src/publish/index.mjs';
import { zonedToUtc, parseWhen } from '../src/publish/plan.mjs';
import { auditPath, loadSettings, publishDir, settingsPath } from '../src/publish/store.mjs';

const HUMAN = 'human-token-for-publish-tests-0123456789';
const AGENT = 'agent-token-for-publish-tests-0123456789';
const KEY = 'test-key-not-a-real-key-1234';
const KEY2 = 'second-key-not-a-real-key-5678';
const P2 = 'harbour';
const P = 'gannet';
let work, projectDir, harbourDir, app, port, runtimeDir, fake, store;
const dirOf = (project) => (project === P2 ? harbourDir : projectDir);

// ---- a fake Buffer (GraphQL) and a fake media host ------------------------------------------------------------------------------

function startFake() {
  const state = {
    requests: [], creates: [], createKeys: [], media: [], missing: new Set(), n: 0, posts: [], deleted: new Set(),
    // each login sees its own organisation and channels
    logins: {
      [KEY]: { org: 'org_1', name: 'Test Org', channels: [
        { id: 'ch_ig', name: 'Gannet IG', service: 'instagram', isDisconnected: false, isLocked: false },
        { id: 'ch_fb', name: 'Gannet FB', service: 'facebook', isDisconnected: false, isLocked: false },
      ] },
      [KEY2]: { org: 'org_2', name: 'Harbour Org', channels: [
        { id: 'b_ig', name: 'Harbour IG', service: 'instagram', isDisconnected: false, isLocked: false },
        { id: 'b_fb1', name: 'Harbour Page One', service: 'facebook', isDisconnected: false, isLocked: false },
        { id: 'b_fb2', name: 'Harbour Page Two', service: 'facebook', isDisconnected: false, isLocked: false },
        { id: 'b_fb3', name: 'Harbour Page Three', service: 'facebook', isDisconnected: false, isLocked: false },
      ] },
    },
    create: (input, n) => ({ data: { createPost: { __typename: 'PostActionSuccess', post: { id: `post_${n}`, dueAt: input.dueAt } } } }),
    status: null,
  };
  const origin = 'http://fake.buffer.test';
  /** The fake service itself: (method, path, headers, body text) -> { status, headers, body }. Both transports below call it. */
  const serve = (method, path, headers, raw) => {
    const reply = (status, obj, extra = {}) => ({ status, headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify(obj) });
    if (path.startsWith('/media/')) {
      state.media.push(`${method} ${path}`);
      if (state.missing.has(decodeURIComponent(path))) return { status: 404, headers: {}, body: '' };
      return { status: 200, headers: { 'content-type': /\.mp4$/.test(path) ? 'video/mp4' : 'image/png' }, body: '' };
    }
    const body = JSON.parse(raw || '{}');
    state.requests.push({ headers, body });
    const bearer = String(headers.authorization ?? '').replace(/^Bearer /, '');
    const login = state.logins[bearer];
    if (!login) return reply(200, { errors: [{ message: 'bad key', extensions: { code: 'UNAUTHORIZED' } }] });
    if (state.status) return reply(state.status.code, state.status.body, state.status.headers);
    if (/GetOrganizations/.test(body.query)) return reply(200, { data: { account: { organizations: [{ id: login.org, name: login.name }] } } });
    if (/GetChannels/.test(body.query)) return reply(200, { data: { channels: body.query.includes(JSON.stringify(login.org)) ? login.channels : [] } });
    if (/createPost/.test(body.query)) {
      const input = body.variables.input;
      if (!login.channels.some((c) => c.id === input.channelId)) return reply(200, { data: { createPost: { __typename: 'MutationError', message: 'That channel is not in this Buffer account.' } } });
      state.creates.push(input);
      state.createKeys.push(bearer);
      state.n += 1;
      state.posts.push({ id: `post_${state.n}`, channelId: input.channelId, channelService: login.channels.find((c) => c.id === input.channelId)?.service, status: 'scheduled', dueAt: input.dueAt, sentAt: null });
      return reply(200, state.create(input, state.n));
    }
    if (/ListPosts/.test(body.query)) {   // what Buffer still holds: posts that were created and not deleted, for the channels asked about
      const f = body.variables?.filter ?? {};
      const edges = state.posts.filter((p) => !state.deleted.has(p.id) && (!f.channelIds || f.channelIds.includes(p.channelId)) && (!f.status || f.status.includes(p.status))).map((node) => ({ node }));
      return reply(200, { data: { posts: { edges, pageInfo: { hasNextPage: false, endCursor: null } } } }, { ratelimit: '"100-in-15min"; r=90; t=60, "250-in-1day"; r=200; t=5000' });
    }
    return reply(400, { errors: [{ message: 'unknown query' }] });
  };
  // Transport 1: in-process, no sockets at all (deterministic: loopback sockets on Windows drop a connection now and then)
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const r = serve(init.method ?? 'GET', `${u.pathname}${u.search}`, headers, typeof init.body === 'string' ? init.body : '');
    return new Response(init.method === 'HEAD' ? null : r.body, { status: r.status, headers: r.headers });
  };
  // Transport 2: a real HTTP server on 127.0.0.1, for the one smoke test that sends the adapter's real fetch over a socket
  const listen = () => new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const r = serve(req.method, req.url, req.headers, Buffer.concat(chunks).toString('utf8'));
      res.writeHead(r.status, r.headers);
      res.end(r.body);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
  return { state, origin, fetch: fetchImpl, listen };
}

// ---- a workspace with synthetic posts ---------------------------------------------------------------------------------------------

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('synthetic picture')]);
const FUTURE = '2099-11';
let counter = 0;

/** Write a post (document, rendered pictures, checks) and its calendar item. Returns the uid. */
function addPost(o = {}) {
  const id = o.id ?? `post-${++counter}`;
  const proj = o.project ?? P, projectDir = dirOf(proj);
  const format = o.format ?? 'carousel';
  const pages = o.pages ?? ['cover', 'tip', 'cta'];
  const kind = format === 'reel' ? 'video' : format === 'post' ? 'graphic' : 'carousel';
  const doc = {
    schema: 'nordle.doc/0.1', id, title: o.title ?? `Post ${id}`, kind, brand: proj, sizes: ['ig-feed-4x5'],
    copy: { caption: o.caption ?? 'Fresh beans, roasted this morning.\nCome and say hello.', hashtags: o.hashtags ?? ['#coffee', '#melbourne'], alt: o.alt ?? Object.fromEntries(pages.map((p) => [p, `Picture of ${p}`])), ...(format === 'reel' ? { alt: { video: 'A barista pours a flat white' } } : {}) },
    pages: format === 'reel' ? [] : pages.map((p) => ({ id: p, title: p, layers: [] })),
  };
  if (o.noCaption) doc.copy.caption = '';
  writeFileSync(join(projectDir, 'docs', `${id}.json`), JSON.stringify(doc, null, 2));
  mkdirSync(join(projectDir, 'out', id), { recursive: true });
  if (format === 'reel') {
    if (!o.noMedia) { writeFileSync(join(projectDir, 'out', id, `${id}.mp4`), Buffer.from('fake mp4 bytes')); writeFileSync(join(projectDir, 'out', id, `${id}-cover.jpg`), Buffer.from([0xff, 0xd8, 0xff, 0x00])); }
  } else {
    pages.forEach((p, i) => { if (!(o.skipPage === p || o.noMedia)) writeFileSync(join(projectDir, 'out', id, `${id}_ig-feed-4x5_${String(i + 1).padStart(2, '0')}-${p}.png`), PNG); });
  }
  if (o.failing) {
    mkdirSync(join(projectDir, 'checks'), { recursive: true });
    writeFileSync(join(projectDir, 'checks', `${id}.json`), JSON.stringify({ schema: 'nordle.checks/0.1', doc: id, entries: [{ check: 'technical', by: 'auto', status: 'fail', v: 0, at: new Date().toISOString(), summary: 'text does not fit' }] }));
  }
  const cal = loadCalendar(projectDir, proj);
  cal.items.push({ id, date: o.date ?? `${FUTURE}-12`, ...(o.time === null ? {} : { time: o.time ?? '18:30' }), format, title: o.title ?? `Post ${id}`, status: o.status ?? 'signed-off', ...(o.noDoc ? {} : { doc: id }), updated: new Date().toISOString() });
  cal.items.sort((a, b) => a.date.localeCompare(b.date));
  saveCalendar(projectDir, cal);
  return `${proj}:${id}`;
}
const itemOn = (id, proj = P) => loadCalendar(dirOf(proj), proj).items.find((i) => i.id === id);
const idOf = (uid) => uid.split(':')[1];

async function api(role, method, path, body) {
  // Loopback on Windows now and then drops a connection ("fetch failed"). Every call here is safe to repeat: a plan is only a preview,
  // settings and tests are idempotent, and a repeated run is refused per post by the plan's own "already handed over" record.
  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(`http://127.0.0.1:${port}/api/publish${path}`, { method, headers: { 'x-nordle-token': role === 'human' ? HUMAN : AGENT, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      break;
    } catch (e) { if (attempt >= 2 || !(e instanceof TypeError)) throw e; }
  }
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}
const human = (m, p, b) => api('human', m, p, b);
const agent = (m, p, b) => api('agent', m, p, b);
const planOf = async (adapter, uids, extra = {}) => { const r = await human('POST', '/plan', { adapter, uids, ...extra }); assert.equal(r.status, 200, r.text); return r.json; };

/** Connect the fake Buffer: key, channel list, one channel for the brand and the media address. */
async function connectBuffer({ channel = 'ch_ig' } = {}) {
  assert.equal((await human('POST', '/settings', { adapter: 'buffer', token: KEY })).status, 200);
  const t = await human('POST', '/test', { adapter: 'buffer' });
  assert.equal(t.json.ok, true, t.text);
  const s = await human('POST', '/settings', { adapter: 'buffer', channels: { [P]: channel }, options: { mediaBaseUrl: `${fake.origin}/media/` } });
  assert.equal(s.status, 200, s.text);
}

before(async () => {
  work = mkdtempSync(join(tmpdir(), 'nordle-publish-'));
  process.env.NORDLE_PUBLISH_DIR = join(work, 'state');
  runtimeDir = join(work, 'runtime');
  projectDir = join(work, 'projects', P);
  cpSync(join(ROOT, 'samples', 'little-gannet'), projectDir, { recursive: true, filter: (s) => !/[\\/](out|sources|docs)([\\/]|$)/.test(s) });
  mkdirSync(join(projectDir, 'docs'), { recursive: true });
  saveCalendar(projectDir, { ...newCalendar('little-gannet'), timezone: 'Australia/Melbourne', items: [] });
  harbourDir = join(work, 'projects', P2);
  cpSync(projectDir, harbourDir, { recursive: true });
  const harbourBrand = JSON.parse(readFileSync(join(harbourDir, 'brand.json'), 'utf8'));
  writeFileSync(join(harbourDir, 'brand.json'), JSON.stringify({ ...harbourBrand, id: P2, name: 'Harbour Test Co' }, null, 2));
  saveCalendar(harbourDir, { ...newCalendar(P2), timezone: 'Australia/Perth', items: [] });
  fake = startFake();
  configure({ buffer: { fetch: fake.fetch, apiUrl: `${fake.origin}/`, allowHttpMedia: true } });
  store = new Store({ roots: [join(work, 'projects')] });
  app = createNordleServer({ roots: [join(work, 'projects')], token: HUMAN, agentToken: AGENT, runtimeDir });
  port = await app.listen(0);
});
after(async () => {
  await app.close();
  configure({ buffer: {} });
  rmSync(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  delete process.env.NORDLE_PUBLISH_DIR;
});
beforeEach(() => {
  rmSync(settingsPath(), { force: true });
  clearChannelMemo();
  fake.state.createKeys.length = 0;
  fake.state.n = 0; fake.state.posts.length = 0; fake.state.deleted.clear(); fake.state.requests.length = 0; fake.state.creates.length = 0; fake.state.media.length = 0; fake.state.missing.clear(); fake.state.status = null;
  fake.state.create = (input, n) => ({ data: { createPost: { __typename: 'PostActionSuccess', post: { id: `post_${n}`, dueAt: input.dueAt } } } });
});

// ---- time -------------------------------------------------------------------------------------------------------------------------

test('times: the brand\'s own clock becomes the right instant, in summer and winter', () => {
  assert.equal(zonedToUtc('2099-11-12', '18:30', 'Australia/Melbourne').toISOString(), '2099-11-12T07:30:00.000Z');   // AEDT +11
  assert.equal(zonedToUtc('2026-07-01', '12:00', 'Australia/Melbourne').toISOString(), '2026-07-01T02:00:00.000Z');   // AEST +10
  assert.equal(zonedToUtc('2026-11-12', '09:00', 'Australia/Perth').toISOString(), '2026-11-12T01:00:00.000Z');       // AWST +8
  assert.equal(parseWhen('2026-11-12 18:30', 'Australia/Melbourne').toISOString(), '2026-11-12T07:30:00.000Z');
  assert.equal(parseWhen('2026-11-12T07:30:00Z', 'Australia/Melbourne').toISOString(), '2026-11-12T07:30:00.000Z');
  assert.equal(parseWhen('tomorrow', 'Australia/Melbourne'), null);
  assert.equal(parseWhen('2026-02-31 10:00', 'Australia/Melbourne'), null);
});

// ---- plans and their blockers ---------------------------------------------------------------------------------------------------

test('plan: a signed-off post with its pictures is ready; the contract shape is exact', async () => {
  const uid = addPost({ id: 'ready-one' });
  const plan = await planOf('bundle', [uid]);
  assert.deepEqual(Object.keys(plan).sort(), ['adapter', 'expires', 'items', 'planId', 'summary']);
  assert.match(plan.planId, /^pl_[0-9a-f]{16}$/);
  assert.deepEqual(plan.summary, { ready: 1, blocked: 0 });
  const left = Date.parse(plan.expires) - Date.now();
  assert.ok(left > 14 * 60 * 1000 && left <= 15 * 60 * 1000, 'plans last 15 minutes');
  const it = plan.items[0];
  for (const k of ['uid', 'project', 'docId', 'title', 'when', 'channel', 'caption', 'media', 'blockers', 'warnings']) assert.ok(k in it, k);
  assert.deepEqual([it.uid, it.project, it.docId, it.blockers], [uid, P, 'ready-one', []]);
  assert.equal(it.when, '2099-11-12T07:30:00.000Z', '18:30 in Melbourne');
  assert.equal(it.caption, 'Fresh beans, roasted this morning.\nCome and say hello.\n\n#coffee #melbourne');
  assert.equal(it.media.length, 3);
  assert.deepEqual(it.media.map((m) => m.replace(/^.*_(\d\d-.*)$/, '$1')), ['01-cover.png', '02-tip.png', '03-cta.png'], 'in posting order');
  assert.ok(!('fp' in it) && !('codes' in it), 'internals stay on the server');
});

test('plan: unsigned, not built, failing checks, missing pictures, no caption, past time and already scheduled are all blocked, with reasons', async () => {
  const unsigned = addPost({ id: 'b-unsigned', status: 'built' });
  const idea = addPost({ id: 'b-idea', status: 'approved', noDoc: true, noMedia: true });
  const failing = addPost({ id: 'b-failing', failing: true });
  const noPage = addPost({ id: 'b-nopage', skipPage: 'tip' });
  const noCaption = addPost({ id: 'b-nocap', noCaption: true });
  const past = addPost({ id: 'b-past', date: '2001-01-05' });
  const reelNoVideo = addPost({ id: 'b-reel', format: 'reel', noMedia: true });
  const done = addPost({ id: 'b-sched', status: 'scheduled' });
  const posted = addPost({ id: 'b-posted', status: 'posted' });
  const plan = await planOf('bundle', [unsigned, idea, failing, noPage, noCaption, past, reelNoVideo, done, posted]);
  assert.deepEqual(plan.summary, { ready: 0, blocked: 9 });
  const by = Object.fromEntries(plan.items.map((i) => [i.docId, i]));
  assert.match(by['b-unsigned'].blockers.join(' '), /Not signed off/);
  assert.equal(by['b-unsigned'].overridable, true, 'the owner may override an unsigned post');
  assert.match(by['b-idea'].blockers.join(' '), /not been built/);
  assert.match(by['b-failing'].blockers.join(' '), /Checks are failing: technical \(auto\)/);
  assert.equal(by['b-failing'].overridable, false);
  assert.match(by['b-nopage'].blockers.join(' '), /Page "tip" has not been rendered/);
  assert.match(by['b-nocap'].blockers.join(' '), /no caption/i);
  assert.match(by['b-past'].blockers.join(' '), /passed or is too close/);
  assert.match(by['b-reel'].blockers.join(' '), /video has not been rendered/);
  assert.match(by['b-sched'].blockers.join(' '), /Already scheduled/);
  assert.match(by['b-posted'].blockers.join(' '), /already gone out/);
  for (const i of plan.items) if (i.docId !== 'b-unsigned') assert.equal(i.overridable, false, `${i.docId} cannot be overridden`);
});

test('plan: a post edited after sign-off is stale and blocked; a whole month is planned, ideas left out; a bad request is refused', async () => {
  const stale = addPost({ id: 'm-stale', date: `${FUTURE}-20` });
  mkdirSync(join(projectDir, 'review'), { recursive: true });
  mkdirSync(join(projectDir, 'history'), { recursive: true });
  writeFileSync(join(projectDir, 'review', 'm-stale.json'), JSON.stringify({ comments: [], versions: [], approvals: [{ id: 'a1', by: 'human', date: new Date().toISOString(), docV: 1 }], changes: [] }));
  writeFileSync(join(projectDir, 'history', 'm-stale.jsonl'), `${JSON.stringify({ v: 1 })}\n${JSON.stringify({ v: 2 })}\n`);
  addPost({ id: 'm-ok', date: `${FUTURE}-21` });
  const cal = loadCalendar(projectDir, P);
  cal.items.push({ id: 'm-idea', date: `${FUTURE}-22`, format: 'post', title: 'Just an idea', status: 'idea' });
  saveCalendar(projectDir, cal);
  const r = await human('POST', '/plan', { adapter: 'bundle', project: P, month: FUTURE });
  assert.equal(r.status, 200, r.text);
  const ids = r.json.items.map((i) => i.docId);
  assert.ok(ids.includes('m-stale') && ids.includes('m-ok') && !ids.includes('m-idea'), 'ideas are not planned');
  assert.ok(ids.indexOf('m-stale') < ids.indexOf('m-ok'), 'in date order');
  assert.match(r.json.items.find((i) => i.docId === 'm-stale').blockers.join(' '), /edited after it was signed off/);
  assert.equal((await human('POST', '/plan', { adapter: 'bundle' })).status, 400);
  assert.equal((await human('POST', '/plan', { adapter: 'nope', uids: [stale] })).status, 404);
  assert.equal((await human('POST', '/plan', { adapter: 'bundle', month: 'banana' })).status, 400);
  const unknown = (await human('POST', '/plan', { adapter: 'bundle', uids: [`${P}:no-such-item`] })).json;
  assert.match(unknown.items[0].blockers[0], /no such post/i);
});

// ---- the export folder -----------------------------------------------------------------------------------------------------------

test('bundle: pictures in order, caption.txt, alt.txt and a schedule.csv; the calendar stays as it was and an audit line is written', async () => {
  const car = addPost({ id: 'bd-car', title: '=SUM(1+1) menu, "quoted"', date: `${FUTURE}-13` });
  const reel = addPost({ id: 'bd-reel', format: 'reel', date: `${FUTURE}-14`, time: null });
  const plan = await planOf('bundle', [car, reel]);
  assert.equal(plan.summary.ready, 2);
  assert.equal(plan.items[1].when, '2099-11-14T01:00:00.000Z', 'no time on the item: the first calendar post time, 12:00 in Melbourne');
  assert.equal(plan.items[1].media.length, 2, 'reel: the mp4 and its cover');
  const r = await human('POST', '/run', { planId: plan.planId });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.results.map((x) => x.ok), [true, true]);
  const dir = join(projectDir, 'out', 'publish', `${FUTURE}-13-bd-car`);
  assert.deepEqual(['01-cover.png', '02-tip.png', '03-cta.png', 'alt.txt', 'caption.txt'].filter((f) => existsSync(join(dir, f))).length, 5);
  assert.equal(readFileSync(join(dir, 'caption.txt'), 'utf8'), 'Fresh beans, roasted this morning.\nCome and say hello.\n\n#coffee #melbourne\n');
  const alt = readFileSync(join(dir, 'alt.txt'), 'utf8');
  assert.match(alt, /01-cover\.png\nPicture of cover/);
  assert.match(alt, /03-cta\.png\nPicture of cta/);
  assert.equal(readFileSync(join(dir, '01-cover.png')).equals(PNG), true, 'the files are copies of the rendered pictures');
  const rdir = join(projectDir, 'out', 'publish', `${FUTURE}-14-bd-reel`);
  assert.ok(existsSync(join(rdir, 'bd-reel.mp4')) && existsSync(join(rdir, 'bd-reel-cover.jpg')) && existsSync(join(rdir, 'caption.txt')));
  const csv = readdirSyncSafe(join(projectDir, 'out', 'publish')).find((f) => f.startsWith('schedule-') && f.endsWith('.csv'));
  assert.ok(csv, 'one schedule.csv for the selection');
  const text = readFileSync(join(projectDir, 'out', 'publish', csv), 'utf8');
  assert.match(text, /^﻿date,time,timezone,when_utc,format,title,doc,folder,files,caption_start/);
  assert.match(text, /2099-11-13,18:30,Australia\/Melbourne,2099-11-13T07:30:00.000Z,carousel,"'=SUM\(1\+1\) menu, ""quoted""",bd-car,out\/publish\/2099-11-13-bd-car,01-cover\.png \| 02-tip\.png \| 03-cta\.png/, 'a title that starts with = is not a formula, and quotes are escaped');
  assert.equal(itemOn('bd-car').status, 'signed-off', 'nothing was handed to a service, so it is not "scheduled"');
  const audit = readFileSync(auditPath(projectDir), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(audit.length >= 2 && audit.every((l) => l.adapter === 'bundle' && l.by === 'owner' && l.planId === plan.planId && l.at));
  assert.deepEqual(audit.filter((l) => l.uid === car).map((l) => l.ok), [true]);
  // exporting again replaces the folder (a page removed from the post does not linger)
  writeFileSync(join(dir, 'stray.png'), 'x');
  const again = await planOf('bundle', [car]);
  await human('POST', '/run', { planId: again.planId });
  assert.equal(existsSync(join(dir, 'stray.png')), false);
});

function readdirSyncSafe(dir) { try { return readdirSync(dir); } catch { return []; } }

// ---- Buffer, against the fake -------------------------------------------------------------------------------------------------

test('buffer: not connected, no channel, no public address and stories are blockers; plan never touches the network', async () => {
  const uid = addPost({ id: 'bf-block' });
  const story = addPost({ id: 'bf-story', format: 'story' });
  let plan = await planOf('buffer', [uid]);
  assert.equal(plan.items.length, 1, 'a brand with no account is one blocked item, not an error');
  assert.equal(plan.items[0].channel, null);
  assert.equal(plan.items[0].blockers.length, 2);
  assert.match(plan.items[0].blockers[0], /^Connect a Buffer account for Little Gannet Coffee/);
  assert.match(plan.items[0].blockers[1], /public web address.*export folder/);
  assert.deepEqual(plan.items[0].blockerCodes, ['no-account', 'no-public-url']);
  await human('POST', '/settings', { adapter: 'buffer', token: KEY });
  plan = await planOf('buffer', [uid, story]);
  assert.match(plan.items[0].blockers[0], /^Choose the channels Little Gannet Coffee posts to/, 'a key but no channel');
  assert.ok(!plan.items[0].blockers.some((b) => /Connect a Buffer account/.test(b)));
  assert.equal(fake.state.requests.length, 0, 'planning and describing make no request at all');
  await connectBuffer();
  plan = await planOf('buffer', [story]);
  assert.ok(plan.items[0].blockers.some((b) => /Stories are not scheduled/.test(b)));
  assert.equal(plan.items[0].channel.id, 'ch_ig');
  fake.state.requests.length = 0;
  const ad = (await agent('GET', '/adapters')).json.adapters.find((a) => a.id === 'buffer');
  assert.equal(ad.configured, true);
  assert.equal(fake.state.requests.length, 0);
});

test('buffer: the request is what Buffer\'s docs describe; the post becomes "scheduled" in the calendar with its publish record', async () => {
  await connectBuffer();
  const uid = addPost({ id: 'bf-car', date: `${FUTURE}-15` });
  const reel = addPost({ id: 'bf-reel', format: 'reel', date: `${FUTURE}-16`, time: '07:05' });
  const plan = await planOf('buffer', [uid, reel]);
  assert.deepEqual(plan.summary, { ready: 2, blocked: 0 }, JSON.stringify(plan.items.map((i) => i.blockers)));
  assert.deepEqual(plan.items[0].channel, { id: 'ch_ig', name: 'Gannet IG', service: 'instagram' });
  assert.equal(plan.items[0].channelName, 'Gannet IG');
  assert.deepEqual([plan.items[0].account, plan.items[0].key], ['default', `${uid}#ch_ig`]);
  assert.ok(plan.items[1].warnings.some((w) => /No cover frame is chosen for this reel yet/.test(w)));
  const r = await human('POST', '/run', { planId: plan.planId });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.results.map((x) => [x.uid, x.ok, x.remoteId]), [[uid, true, 'post_1'], [reel, true, 'post_2']]);
  assert.equal(r.json.results[0].scheduledAt, '2099-11-15T07:30:00.000Z');

  const [carReq, reelReq] = fake.state.requests.filter((q) => /createPost/.test(q.body.query));
  assert.equal(carReq.headers.authorization, `Bearer ${KEY}`);
  assert.match(carReq.body.query, /createPost\(input: \$input\)/);
  assert.match(carReq.body.query, /\.\.\. on PostActionSuccess/);
  assert.match(carReq.body.query, /\.\.\. on MutationError \{ message \}/);
  const input = carReq.body.variables.input;
  assert.deepEqual(Object.keys(input).sort(), ['assets', 'channelId', 'dueAt', 'metadata', 'mode', 'schedulingType', 'text']);
  assert.deepEqual([input.channelId, input.schedulingType, input.mode, input.dueAt], ['ch_ig', 'automatic', 'customScheduled', '2099-11-15T07:30:00.000Z']);
  assert.equal(input.text, 'Fresh beans, roasted this morning.\nCome and say hello.\n\n#coffee #melbourne');
  assert.deepEqual(input.metadata, { instagram: { type: 'post', shouldShareToFeed: true } });
  const base = `${fake.origin}/media/${P}/${FUTURE}-15-bf-car`;
  assert.deepEqual(input.assets, [
    { image: { url: `${base}/01-cover.png`, metadata: { altText: 'Picture of cover' } } },
    { image: { url: `${base}/02-tip.png`, metadata: { altText: 'Picture of tip' } } },
    { image: { url: `${base}/03-cta.png`, metadata: { altText: 'Picture of cta' } } },
  ], 'the pictures in order, as public addresses');
  assert.ok(fake.state.media.filter((m) => m.startsWith('HEAD')).length >= 4, 'every address was checked before Buffer was asked');
  const rin = reelReq.body.variables.input;
  assert.deepEqual(rin.metadata, { instagram: { type: 'reel', shouldShareToFeed: true } });
  assert.deepEqual(rin.assets, [{ video: { url: `${fake.origin}/media/${P}/${FUTURE}-16-bf-reel/bf-reel.mp4` } }], 'a reel is its video; the cover file is not sent');
  assert.equal(rin.dueAt, '2099-11-15T20:05:00.000Z');
  assert.ok(existsSync(join(projectDir, 'out', 'publish', `${FUTURE}-15-bf-car`, '01-cover.png')), 'the export folder Buffer is pointed at exists');

  const it = itemOn('bf-car');
  assert.equal(it.status, 'scheduled');
  assert.deepEqual([it.publish.adapter, it.publish.remoteId, it.publish.scheduledAt], ['buffer', 'post_1', '2099-11-15T07:30:00.000Z']);
  assert.ok(it.publish.at);
  assert.equal(validateCalendar(loadCalendar(projectDir, P)).ok, true);
  const again = await human('POST', '/run', { planId: plan.planId, only: [uid] });
  assert.equal(again.json.results[0].ok, false);
  assert.match(again.json.results[0].message, /already handed/);
  assert.equal(fake.state.creates.length, 2, 'never handed over twice');
  const replan = await planOf('buffer', [uid]);
  assert.match(replan.items[0].blockers.join(' '), /Already scheduled in buffer/);
});

test('buffer: refusals and failures are reported per post, change nothing, and one failure does not stop the others', async () => {
  await connectBuffer();
  const a = addPost({ id: 'pf-a', date: `${FUTURE}-17` }), b = addPost({ id: 'pf-b', date: `${FUTURE}-18` }), c = addPost({ id: 'pf-c', date: `${FUTURE}-19` });
  fake.state.create = (input, n) => (n === 2
    ? { data: { createPost: { __typename: 'MutationError', message: `The post is too long for this channel (key ${KEY})` } } }
    : { data: { createPost: { __typename: 'PostActionSuccess', post: { id: `post_${n}`, dueAt: input.dueAt } } } });
  const plan = await planOf('buffer', [a, b, c]);
  const r = (await human('POST', '/run', { planId: plan.planId })).json;
  assert.deepEqual(r.results.map((x) => x.ok), [true, false, true], 'partial failure');
  assert.match(r.results[1].message, /Buffer refused it: The post is too long/);
  assert.ok(!r.results[1].message.includes(KEY), 'a key echoed by the service is redacted');
  assert.deepEqual([itemOn('pf-a').status, itemOn('pf-b').status, itemOn('pf-c').status], ['scheduled', 'signed-off', 'scheduled']);
});

test('buffer: a file Buffer could not read later stops that post before Buffer is asked', async () => {
  await connectBuffer();
  const uid = addPost({ id: 'mu-1', date: `${FUTURE}-17` });
  fake.state.missing.add(`/media/${P}/${FUTURE}-17-mu-1/02-tip.png`);
  const plan = await planOf('buffer', [uid]);
  const r = (await human('POST', '/run', { planId: plan.planId })).json;
  assert.equal(r.results[0].ok, false);
  assert.match(r.results[0].message, /would not be able to read this file later.*02-tip\.png answered 404.*Host the export folder/);
  assert.equal(fake.state.creates.length, 0);
  assert.equal(itemOn('mu-1').status, 'signed-off');
});

test('buffer: the rate limit (HTTP 429 or RATE_LIMIT_EXCEEDED) stops the run, the rest are not attempted, nothing is lost', async () => {
  await connectBuffer();
  const [a, b, c] = [addPost({ id: 'rl-a', date: `${FUTURE}-17` }), addPost({ id: 'rl-b', date: `${FUTURE}-18` }), addPost({ id: 'rl-c', date: `${FUTURE}-19` })];
  fake.state.create = (input, n) => (n === 1 ? { data: { createPost: { __typename: 'PostActionSuccess', post: { id: 'post_1', dueAt: input.dueAt } } } } : { errors: [{ message: 'Too many requests', extensions: { code: 'RATE_LIMIT_EXCEEDED', window: '15m' } }] });
  let plan = await planOf('buffer', [a, b, c]);
  let r = (await human('POST', '/run', { planId: plan.planId })).json;
  assert.deepEqual(r.results.map((x) => x.ok), [true, false, false]);
  assert.match(r.results[1].message, /rate limit is used up \(15m\)/);
  assert.match(r.results[2].message, /^Not attempted/);
  assert.match(r.stopped, /rate limit/);
  assert.equal(fake.state.creates.length, 2, 'the third was never sent');
  // and a real 429 with Retry-After
  fake.state.status = { code: 429, body: { errors: [{ message: 'Too many requests from this client.', extensions: { code: 'RATE_LIMIT_EXCEEDED', window: '15m' } }] }, headers: { 'retry-after': '120' } };
  plan = await planOf('buffer', [b, c]);
  r = (await human('POST', '/run', { planId: plan.planId })).json;
  assert.match(r.results[0].message, /try again in 2 minutes/i, 'a wait is said in minutes (and hours), never in seconds');
  assert.doesNotMatch(r.results[0].message, /seconds/i);
  assert.equal(r.results[1].message.startsWith('Not attempted'), true);
  assert.equal(itemOn('rl-b').status, 'signed-off');
});

test('buffer: a refused key is explained, and an answer that never comes is "uncertain": that post is not retried blindly', async () => {
  await connectBuffer();
  const uid = addPost({ id: 'un-1', date: `${FUTURE}-17` });
  let plan = await planOf('buffer', [uid]);
  await human('POST', '/settings', { adapter: 'buffer', token: 'a-different-key-9999' });
  let r = (await human('POST', '/run', { planId: plan.planId })).json;
  assert.match(r.results[0].message, /Buffer refused: bad key/);
  assert.equal(fake.state.creates.length, 0);
  await human('POST', '/settings', { adapter: 'buffer', token: KEY });
  // the reply is a post-less success: unclear whether it was created
  fake.state.create = () => ({ data: { createPost: { __typename: 'SomethingNew' } } });
  plan = await planOf('buffer', [uid]);
  r = (await human('POST', '/run', { planId: plan.planId })).json;
  assert.equal(r.results[0].ok, false);
  assert.match(r.results[0].message, /Look in Buffer before trying again/);
  r = (await human('POST', '/run', { planId: plan.planId, only: [uid] })).json;
  assert.match(r.results[0].message, /no clear answer/, 'the same plan will not try again');
  assert.equal(fake.state.creates.length, 1);
  const log = readFileSync(auditPath(projectDir), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.uid === uid);
  assert.ok(log.some((l) => l.uncertain === true));
});

test('buffer: the cover frame chosen for a reel goes to Buffer as the video\'s thumbnail offset in milliseconds; with none chosen the plan says so', async () => {
  await connectBuffer();
  const plain = addPost({ id: 'cv-none', format: 'reel', date: `${FUTURE}-16`, time: '07:05' });
  const p0 = await planOf('buffer', [plain]);
  assert.ok(p0.items[0].warnings.some((w) => /No cover frame is chosen/.test(w)), 'no cover chosen: the plan says Buffer will use the first frame');
  const reel = addPost({ id: 'cv-reel', format: 'reel', date: `${FUTURE}-16`, time: '08:05' });
  setCoverTime(dirOf(P), 'cv-reel', 8.5);
  const plan = await planOf('buffer', [reel]);
  assert.ok(!plan.items[0].warnings.some((w) => /No cover frame/.test(w)));
  const r = (await human('POST', '/run', { planId: plan.planId })).json;
  assert.equal(r.results[0].ok, true, r.results[0].message);
  assert.deepEqual(fake.state.creates.at(-1).assets, [{ video: { url: `${fake.origin}/media/${P}/${FUTURE}-16-cv-reel/cv-reel.mp4`, metadata: { thumbnailOffset: 8500 } } }]);
  assert.throws(() => setCoverTime(dirOf(P), 'cv-reel', -1), /seconds/);
});

test('buffer: a post deleted in Buffer is found by Check, Reschedule takes it back, and it can be scheduled again; only the owner may ask', async () => {
  await connectBuffer();
  const uid = addPost({ id: 'rs-1', date: `${FUTURE}-19`, time: '09:00' });
  const plan = await planOf('buffer', [uid], { stories: [uid] });
  const run = (await human('POST', '/run', { planId: plan.planId })).json;
  assert.ok(run.results.every((x) => x.ok), JSON.stringify(run.results));
  assert.equal(itemOn('rs-1').status, 'scheduled');
  assert.equal((await agent('POST', '/check-scheduled', { uids: [uid] })).status, 403, 'Claude cannot ask Buffer');
  assert.equal((await agent('POST', '/unschedule', { uid })).status, 403, 'Claude cannot take a post back');
  let c = (await human('POST', '/check-scheduled', { uids: [uid] })).json;
  assert.deepEqual(c.results[0].targets.map((t) => [t.channel, t.state]), [['ch_ig', 'scheduled'], ['ch_ig#story', 'scheduled']]);
  assert.deepEqual(c.results[0].missing, [], 'both are in Buffer');
  assert.ok(!JSON.stringify(c).includes(KEY), 'the key is never in an answer');
  // the Story is deleted in Buffer
  fake.state.deleted.add('post_2');
  c = (await human('POST', '/check-scheduled', { uids: [uid] })).json;
  assert.deepEqual(c.results[0].missing, ['ch_ig#story']);
  assert.equal(c.results[0].targets.find((t) => t.channel === 'ch_ig#story').state, 'missing');
  const back = (await human('POST', '/unschedule', { uid, channels: c.results[0].missing })).json;
  assert.equal(back.status, 'signed-off');
  assert.deepEqual(itemOn('rs-1').publish.targets.map((t) => t.channel), ['ch_ig'], 'what is still in Buffer is remembered');
  const again = await planOf('buffer', [uid], { stories: [uid] });
  assert.deepEqual(again.items.map((i) => [i.key.split(':')[1], i.ready, i.blockerCodes.includes('already-scheduled-channel')]), [['rs-1#ch_ig', false, true], ['rs-1#ch_ig#story', true, false]], 'the post is done, the Story can go again');
  const r2 = (await human('POST', '/run', { planId: again.planId, only: [again.items[1].key] })).json;
  assert.ok(r2.results[0].ok, r2.results[0].message);
  assert.equal(itemOn('rs-1').status, 'scheduled', 'both channels are scheduled again');
  // the whole post is deleted: everything goes back
  fake.state.deleted.add('post_1'); fake.state.deleted.add('post_3');
  c = (await human('POST', '/check-scheduled', { uids: [uid] })).json;
  assert.deepEqual(c.results[0].missing.sort(), ['ch_ig', 'ch_ig#story']);
  assert.equal((await human('POST', '/unschedule', { uid })).json.status, 'signed-off');
  assert.equal(itemOn('rs-1').publish, undefined, 'nothing is left scheduled');
  const fresh = await planOf('buffer', [uid]);
  assert.equal(fresh.items[0].ready, true, 'it can be scheduled again');
  const log = readFileSync(auditPath(projectDir), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.event === 'unschedule');
  assert.equal(log.length, 2, 'taking a post back is on the record');
  assert.equal((await human('POST', '/unschedule', { uid })).status, 409, 'a post that is not scheduled has nothing to take back');
});

test('buffer: the history pull keeps what Buffer measured, is not repeated within hours, and never spends the allowance scheduling needs', async () => {
  await connectBuffer();
  const sent = (id, at, reach, er) => ({ id, channelId: 'ch_ig', channelService: 'instagram', status: 'sent', dueAt: at, sentAt: at, metricsUpdatedAt: at, metrics: [{ type: 'reach', value: reach, unit: 'count' }, { type: 'engagementRate', value: er, unit: 'percentage' }] });
  fake.state.posts.push(sent('s1', '2026-09-01T07:00:00.000Z', 100, 5), sent('s2', '2026-09-03T08:00:00.000Z', 300, 9), sent('s3', '2026-09-05T09:00:00.000Z', 150, 6));
  assert.equal((await agent('POST', '/sync-posts', { project: P })).status, 403, 'only the owner asks Buffer');
  const first = (await human('POST', '/sync-posts', { project: P })).json;
  assert.equal(first.ok, true);
  assert.equal(first.fetched, 3);
  assert.equal(first.requests, 1, 'three posts are one request');
  const kept = readSentPosts(dirOf(P));
  assert.deepEqual(kept.posts.map((x) => x.id).sort(), ['s1', 's2', 's3']);
  assert.deepEqual(kept.posts.find((x) => x.id === 's2').m, { reach: 300, engagementRate: 9 }, 'the results are kept by name');
  assert.ok(!JSON.stringify(kept).includes(KEY));
  const asked = fake.state.requests.length;
  const again = (await human('POST', '/sync-posts', { project: P })).json;
  assert.equal(again.skipped, true, 'not repeated so soon');
  assert.equal(fake.state.requests.length, asked, 'and no request was made');
  assert.match(again.message, /waits 6 hours/);
  fake.state.posts.push(sent('s4', '2026-09-07T09:00:00.000Z', 200, 7));
  const forced = (await human('POST', '/sync-posts', { project: P, force: true })).json;
  assert.equal(forced.total, 4, 'when the owner insists, new posts are merged in without duplicates');
  // the best-times answer reads only the local file
  const before = fake.state.requests.length;
  const bt = (await human('GET', `/best-times?project=${P}`)).json;
  assert.equal(fake.state.requests.length, before, 'asking for best times costs Buffer nothing');
  assert.ok(bt.analysis && bt.analysis.counts.posts === 4);
  assert.equal(bt.allowance.windows['1day'].left, 200, 'it tells what Buffer said is left today');
  // Buffer said how much is left, and the adapter list shows it
  const list = (await human('GET', '/adapters')).json.adapters.find((x) => x.id === 'buffer');
  assert.equal(list.accounts[0].allowance.windows['1day'].left, 200);
  // nearly out for the day: optional reading stops, scheduling is untouched
  recordAllowance('default', { '15min': { limit: 100, left: 90, resetsIn: 600 }, '1day': { limit: 250, left: 12, resetsIn: 3600 } });
  const blocked = await human('POST', '/sync-posts', { project: P, force: true });
  assert.equal(blocked.status, 429);
  assert.match(JSON.stringify(blocked.json), /nearly used \(12 of 250 left/);
  const uid = addPost({ id: 'al-1', date: `${FUTURE}-20`, time: '09:00' });
  const checkLow = (await human('POST', '/check-scheduled', { uids: [uid] })).json;
  assert.deepEqual(checkLow.results, [], 'nothing scheduled, nothing to look up');
  const plan = await planOf('buffer', [uid]);
  const run = (await human('POST', '/run', { planId: plan.planId })).json;
  assert.ok(run.results[0].ok, 'scheduling still goes ahead on a low allowance');
  rmSync(allowancePath(), { force: true }); clearAllowanceMemo();   // leave nothing behind for the other tests
});

test('buffer: a video over 100 MB is not made into a Story; the post itself still goes, and the plan says why in words', async () => {
  await connectBuffer();
  const big = addPost({ id: 'st-big', format: 'reel', date: `${FUTURE}-19`, time: '10:00' });
  const small = addPost({ id: 'st-small', format: 'reel', date: `${FUTURE}-19`, time: '11:00' });
  const file = join(dirOf(P), 'out', 'st-big', 'st-big.mp4');
  truncateSync(file, 101 * 1024 * 1024);   // a sparse file: it reports 101 MB and takes no space
  const plan = await planOf('buffer', [big, small], { stories: [big, small] });
  const keys = plan.items.map((i) => [i.key.split(':')[1], i.variant ?? 'feed']);
  assert.deepEqual(keys, [['st-big#ch_ig', 'feed'], ['st-small#ch_ig', 'feed'], ['st-small#ch_ig#story', 'story']], 'the big one has no Story item; the small one does');
  const bigFeed = plan.items.find((i) => i.key.includes('st-big'));
  assert.equal(bigFeed.ready, true, 'the post itself is still ready to go');
  assert.match(bigFeed.storySkipped, /No Story was made: the video is 101 MB, over the 100 MB limit for Stories/);
  assert.ok(bigFeed.warnings.includes(bigFeed.storySkipped));
  assert.equal(plan.items.find((i) => i.key.includes('st-small') && !i.variant).storySkipped, undefined);
  // exactly 100 MB is still fine
  truncateSync(file, 100 * 1024 * 1024);
  const fits = await planOf('buffer', [big], { stories: [big] });
  assert.equal(fits.items.length, 2);
});

test('buffer: "also add to Stories" makes a second item per channel (the video, or the first picture, no words), sends it as a story, and the post is scheduled once both went', async () => {
  await connectBuffer();
  const car = addPost({ id: 'st-car', date: `${FUTURE}-18`, time: '09:00' });
  const reel = addPost({ id: 'st-reel', format: 'reel', date: `${FUTURE}-18`, time: '10:00' });
  const plain = await planOf('buffer', [car]);
  assert.equal(plain.items.length, 1, 'no story unless asked for');
  const plan = await planOf('buffer', [car, reel], { stories: [car, reel] });
  assert.deepEqual(plan.items.map((i) => [i.key.split(':')[1], i.variant ?? 'feed']), [['st-car#ch_ig', 'feed'], ['st-car#ch_ig#story', 'story'], ['st-reel#ch_ig', 'feed'], ['st-reel#ch_ig#story', 'story']]);
  const [, cs, , rs] = plan.items;
  assert.equal(cs.media.length, 1, 'a carousel\'s Story is its first picture');
  assert.equal(cs.caption, '', 'a Story has no words');
  assert.equal(rs.media.length, 1, 'a reel\'s Story is the video alone (no cover file)');
  assert.ok(cs.warnings.some((w) => /only the first picture/.test(w)) && rs.warnings.some((w) => /at most 60 seconds/.test(w)));
  assert.ok(plan.items.every((i) => i.ready), plan.items.map((i) => i.blockers.join(' ')).join(' | '));
  const r = (await human('POST', '/run', { planId: plan.planId })).json;
  assert.ok(r.results.every((x) => x.ok), JSON.stringify(r.results));
  const sent = fake.state.creates.slice(-4);
  assert.equal(sent[0].metadata.instagram.type, 'post');
  assert.deepEqual(sent[1].metadata, { instagram: { type: 'story', shouldShareToFeed: false } });
  assert.ok(!('text' in sent[1]) && sent[1].assets.length === 1 && sent[1].assets[0].image, 'a story carries no text and one picture');
  assert.deepEqual(sent[3].metadata, { instagram: { type: 'story', shouldShareToFeed: false } });
  assert.ok(sent[3].assets.length === 1 && sent[3].assets[0].video && !sent[3].assets[0].video.metadata, 'the reel\'s story is the video, with no cover frame');
  assert.equal(sent[1].dueAt, sent[0].dueAt, 'a Story goes at the same moment as its post');
  const cal = itemOn('st-car');
  assert.equal(cal.status, 'scheduled');
  assert.deepEqual(cal.publish.targets.map((t) => t.channel).sort(), ['ch_ig', 'ch_ig#story']);
  const again = await planOf('buffer', [car], { stories: [car] });
  assert.ok(again.items.every((i) => !i.ready && i.blockerCodes.includes('already-scheduled')), 'both are shown as done, and nothing goes twice');
});

test('buffer: Instagram\'s caption limit counts a line break as two; a channel that is not Instagram gets no Instagram settings', async () => {
  await connectBuffer();
  const ok = 'x'.repeat(2196);
  const lines = 'x\n'.repeat(750);                              // 1500 characters, but 750 line breaks count twice: over the limit
  const fits = addPost({ id: 'cl-ok', caption: ok, hashtags: [], date: `${FUTURE}-17` });
  const long = addPost({ id: 'cl-long', caption: lines, hashtags: [], date: `${FUTURE}-17` });
  const plan = await planOf('buffer', [fits, long]);
  assert.deepEqual(plan.items.map((i) => i.ready), [true, false]);
  assert.match(plan.items[1].blockers.join(' '), /\d+ characters \(a line break counts as 2\) and Instagram takes 2196/);
  await human('POST', '/settings', { adapter: 'buffer', channels: { [P]: 'ch_fb' } });
  const fb = await planOf('buffer', [fits]);
  const r = (await human('POST', '/run', { planId: fb.planId })).json;
  assert.equal(r.results[0].ok, true, r.results[0].message);
  assert.deepEqual(fake.state.creates.at(-1).metadata, { facebook: { type: 'post' } }, 'a facebook channel gets a type (Buffer refuses a Facebook post without one) and no instagram block');
});

test('buffer: when Buffer cannot be reached the post is left alone and marked uncertain; the connection test says so', async () => {
  await connectBuffer();
  const uid = addPost({ id: 'net-1', date: `${FUTURE}-17` });
  const plan = await planOf('buffer', [uid]);
  configure({ buffer: { fetch: async (url, init) => { if (String(url).includes('/media/')) return fake.fetch(url, init); throw new TypeError(`fetch failed (${KEY})`); }, apiUrl: `${fake.origin}/`, allowHttpMedia: true } });
  try {
    const t = await human('POST', '/test', { adapter: 'buffer' });
    assert.equal(t.json.ok, false);
    assert.match(t.json.message, /Could not reach Buffer/);
    assert.ok(!t.text.includes(KEY));
    const r = (await human('POST', '/run', { planId: plan.planId })).json;
    assert.equal(r.results[0].ok, false);
    assert.match(r.results[0].message, /may or may not have been created/);
    assert.ok(!r.results[0].message.includes(KEY));
    assert.equal(itemOn('net-1').status, 'signed-off');
    const again = (await human('POST', '/run', { planId: plan.planId, only: [uid] })).json;
    assert.match(again.results[0].message, /no clear answer/);
  } finally { configure({ buffer: { fetch: fake.fetch, apiUrl: `${fake.origin}/`, allowHttpMedia: true } }); }
});

test('buffer over a real socket: the adapter\'s own fetch talks to a local server (one smoke test; retried because loopback can drop a connection)', async () => {
  await human('POST', '/settings', { adapter: 'buffer', token: KEY });
  const { server, port } = await fake.listen();
  configure({ buffer: { apiUrl: `http://127.0.0.1:${port}/`, allowHttpMedia: true } });
  try {
    let t;
    for (let attempt = 0; attempt < 4; attempt++) {
      t = (await human('POST', '/test', { adapter: 'buffer' })).json;
      if (t.ok) break;
    }
    assert.equal(t.ok, true, t.message);
    assert.deepEqual(t.channels.map((c) => [c.id, c.service]), [['ch_ig', 'instagram'], ['ch_fb', 'facebook']]);
    assert.match(t.message, /Test Org/);
    const sent = fake.state.requests.at(-1);
    assert.equal(sent.headers.authorization, `Bearer ${KEY}`);
    assert.equal(sent.headers['content-type'], 'application/json');
  } finally {
    configure({ buffer: { fetch: fake.fetch, apiUrl: `${fake.origin}/`, allowHttpMedia: true } });
    await new Promise((r) => server.close(r));
  }
});

// ---- who may do what ----------------------------------------------------------------------------------------------------------

test('the agent token can list and plan, nothing else; a plan it made cannot be run', async () => {
  const uid = addPost({ id: 'ag-1' });
  assert.equal((await agent('GET', '/adapters')).status, 200);
  assert.equal((await agent('GET', '/describe?adapter=buffer')).status, 200);
  const plan = await agent('POST', '/plan', { adapter: 'bundle', uids: [uid] });
  assert.equal(plan.status, 200);
  const before = JSON.stringify(loadCalendar(projectDir, P));
  assert.equal((await agent('POST', '/run', { planId: plan.json.planId })).status, 403);
  assert.equal((await agent('POST', '/settings', { adapter: 'buffer', token: KEY })).status, 403);
  assert.equal((await agent('POST', '/test', { adapter: 'buffer' })).status, 403);
  assert.equal(existsSync(settingsPath()), false, 'nothing was saved');
  const mine = await human('POST', '/run', { planId: plan.json.planId });
  assert.equal(mine.status, 403, 'the owner cannot run a plan Claude made either');
  assert.match(mine.json.errors[0].message, /made by Claude/);
  assert.equal(JSON.stringify(loadCalendar(projectDir, P)), before);
  assert.equal(existsSync(join(projectDir, 'out', 'publish', `${FUTURE}-12-ag-1`)), false, 'nothing was exported');
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/publish/adapters`)).status, 401);
  // the library enforces it too, not only the route
  const p = await buildPlan(store, { adapter: getAdapter('bundle'), uids: [uid], role: 'human' });
  await assert.rejects(runPlan(store, { planId: p.planId, role: 'agent' }), /Only the owner/);
});

test('the command line refuses to run or change settings inside one of Claude\'s runs, and needs --yes', () => {
  const env = { ...process.env, NORDLE_PROJECTS: join(work, 'projects'), NORDLE_PUBLISH_DIR: join(work, 'state') };
  const cli = (args, extra = {}) => spawnSync(process.execPath, [join(ROOT, 'nordle.mjs'), 'publish', ...args], { env: { ...env, ...extra }, encoding: 'utf8', windowsHide: true, input: '' });
  const uid = addPost({ id: 'cli-1' });
  let r = cli(['run', 'bundle', uid, '--yes'], { NORDLE_AGENT_RUN: '1' });
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stderr, /Only the owner can schedule posts/);
  r = cli(['settings', 'buffer', '--token-stdin'], { NORDLE_AGENT_RUN: '1' });
  assert.equal(r.status, 3);
  assert.equal(existsSync(settingsPath()), false);
  r = cli(['run', 'bundle', uid]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--yes/);
  r = cli(['plan', 'bundle', uid], { NORDLE_AGENT_RUN: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /READY .*cli-1/);
  r = cli(['plan', 'buffer', uid]);
  assert.match(r.stdout, /BLOCKED/);
  assert.match(r.stdout, /Connect a Buffer account for Little Gannet Coffee/);
  r = cli(['run', 'bundle', uid, '--yes']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /OK .*Exported to out\/publish\/2099-11-12-cli-1/);
  assert.ok(existsSync(join(projectDir, 'out', 'publish', `${FUTURE}-12-cli-1`, 'caption.txt')));
});

test('override: the owner can send a built post one at a time, never one with failing checks', async () => {
  await connectBuffer();
  const unsigned = addPost({ id: 'ov-1', status: 'built', date: `${FUTURE}-17` });
  const failing = addPost({ id: 'ov-2', status: 'built', failing: true, date: `${FUTURE}-18` });
  const plan = await planOf('buffer', [unsigned, failing]);
  assert.deepEqual(plan.summary, { ready: 0, blocked: 2 });
  assert.equal((await human('POST', '/run', { planId: plan.planId })).status, 409, 'nothing ready, nothing sent');
  const r = (await human('POST', '/run', { planId: plan.planId, only: [unsigned, failing], override: { [unsigned]: true, [failing]: true } })).json;
  assert.deepEqual(r.results.map((x) => x.ok), [true, false]);
  assert.match(r.results[1].message, /Checks are failing/);
  assert.equal(itemOn('ov-1').status, 'scheduled', 'built -> scheduled');
  const log = readFileSync(auditPath(projectDir), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(log.find((l) => l.uid === unsigned && l.ok).override, true, 'an override is on the record');
});

test('a per-run time overrides the calendar time; a time in the past is refused', async () => {
  await connectBuffer();
  const uid = addPost({ id: 'tm-1', date: `${FUTURE}-17` });
  const plan = await planOf('buffer', [uid]);
  const r = (await human('POST', '/run', { planId: plan.planId, times: { [uid]: '2099-11-17 09:15' } })).json;
  assert.equal(r.results[0].ok, true, r.results[0].message);
  assert.equal(fake.state.creates.at(-1).dueAt, '2099-11-16T22:15:00.000Z');
  const uid2 = addPost({ id: 'tm-2', date: `${FUTURE}-17` });
  const p2 = await planOf('buffer', [uid2], { times: { [uid2]: '2001-01-01 09:00' } });
  assert.match(p2.items[0].blockers.join(' '), /passed or is too close/);
  const p3 = await planOf('buffer', [uid2], { times: { [uid2]: 'next tuesday' } });
  assert.match(p3.items[0].blockers.join(' '), /is not a time/);
});

test('"now" means as soon as the service will take it: ten minutes and a bit ahead, on a whole minute, and the run works it out again', async () => {
  await connectBuffer();
  const uid = addPost({ id: 'tm-now', date: '2001-02-03' });           // a calendar time long gone: "now" does not care
  const before = Date.now();
  const plan = await planOf('buffer', [uid], { times: { [uid]: 'now' } });
  const it = plan.items[0];
  assert.equal(it.ready, true, it.blockers.join(' '));
  const lead = Date.parse(it.when) - before;
  assert.ok(lead >= 10 * 60000 && lead <= 12.2 * 60000, `about eleven minutes ahead (was ${lead / 60000})`);
  assert.equal(Date.parse(it.when) % 60000, 0, 'on a whole minute');
  const r = (await human('POST', '/run', { planId: plan.planId })).json;
  assert.equal(r.results[0].ok, true, r.results[0].message);
  const sent = Date.parse(fake.state.creates.at(-1).dueAt) - before;
  assert.ok(sent >= 10 * 60000 && sent <= 12.5 * 60000, 'sent to Buffer as a time still in the future');
});

// ---- plans expire and are bound to what they saw -------------------------------------------------------------------------------

test('plans expire after 15 minutes and the run says so; unknown or forged plan ids are refused', async () => {
  const uid = addPost({ id: 'ex-1' });
  const plan = await buildPlan(store, { adapter: getAdapter('bundle'), uids: [uid], role: 'human', now: Date.now() - 16 * 60 * 1000 });
  await assert.rejects(runPlan(store, { planId: plan.planId, role: 'human' }), (e) => e.status === 410 && /expired/.test(e.message));
  assert.equal((await human('POST', '/run', { planId: plan.planId })).status, 410);
  assert.equal((await human('POST', '/run', { planId: 'pl_0123456789abcdef' })).status, 404);
  assert.equal((await human('POST', '/run', { planId: '../../etc/passwd' })).status, 404);
  assert.equal((await human('POST', '/run', {})).status, 404);
  assert.equal(existsSync(join(projectDir, 'out', 'publish', `${FUTURE}-12-ex-1`)), false);
});

test('a post that changed after the plan is refused: the caption, a picture, the calendar slot, or its status', async () => {
  await connectBuffer();
  const caption = addPost({ id: 'st-cap', date: `${FUTURE}-17` }), pic = addPost({ id: 'st-pic', date: `${FUTURE}-17` });
  const slot = addPost({ id: 'st-slot', date: `${FUTURE}-17` }), unsign = addPost({ id: 'st-uns', date: `${FUTURE}-17` }), same = addPost({ id: 'st-same', date: `${FUTURE}-17` });
  const plan = await planOf('buffer', [caption, pic, slot, unsign, same]);
  assert.equal(plan.summary.ready, 5);
  const doc = JSON.parse(readFileSync(join(projectDir, 'docs', 'st-cap.json'), 'utf8'));
  doc.copy.caption = `${doc.copy.caption} And a surprise extra line that nobody approved.`;
  writeFileSync(join(projectDir, 'docs', 'st-cap.json'), JSON.stringify(doc, null, 2));
  writeFileSync(join(projectDir, 'out', 'st-pic', 'st-pic_ig-feed-4x5_02-tip.png'), Buffer.concat([PNG, Buffer.from(' re-rendered')]));
  await updateItem(projectDir, 'st-slot', { time: '07:00' }, { role: 'human' });
  await decide(projectDir, 'st-uns', 'changes', { comment: 'make the cover warmer' });
  const r = (await human('POST', '/run', { planId: plan.planId })).json;
  const by = Object.fromEntries(r.results.map((x) => [x.uid, x]));
  for (const u of [caption, pic, slot]) { assert.equal(by[u].ok, false, u); assert.match(by[u].message, /changed after the plan was made/, u); }
  assert.equal(by[unsign].ok, false);
  assert.match(by[unsign].message, /changed after the plan|sent this post back/);
  assert.equal(by[same].ok, true, 'the untouched post still goes');
  assert.equal(fake.state.creates.length, 1);
});

// ---- secrets ------------------------------------------------------------------------------------------------------------------

test('the key is never returned, logged or put in the repo or the project; the settings file is private', async () => {
  const saved = await human('POST', '/settings', { adapter: 'buffer', token: KEY });
  assert.deepEqual([saved.json.ok, saved.json.configured], [true, true]);
  assert.deepEqual(saved.json.accounts.map((a) => [a.id, a.label, a.configured]), [['default', 'Buffer', true]], 'a bare token is the default account');
  assert.ok(!saved.text.includes(KEY));
  await connectBuffer();
  const uid = addPost({ id: 'sc-1', date: `${FUTURE}-17` });
  const plan = await planOf('buffer', [uid]);
  const run = await human('POST', '/run', { planId: plan.planId });
  const everything = [
    (await human('GET', '/adapters')).text, (await agent('GET', '/adapters')).text, (await agent('GET', '/describe?adapter=buffer')).text,
    JSON.stringify(plan), run.text, (await human('POST', '/test', { adapter: 'buffer' })).text,
    readFileSync(auditPath(projectDir), 'utf8'), readFileSync(join(publishDir(), 'publish-plans', `${plan.planId}.json`), 'utf8'),
  ];
  for (const text of everything) assert.ok(!text.includes(KEY), 'the key appears nowhere a client or a log can see');
  assert.ok(readFileSync(settingsPath(), 'utf8').includes(KEY), 'it lives only in the settings file');
  if (process.platform !== 'win32') assert.equal(statSync(settingsPath()).mode & 0o777, 0o600);
  assert.ok(!settingsPath().startsWith(projectDir), 'not in a project');
  const ad = (await human('GET', '/adapters')).json.adapters.find((a) => a.id === 'buffer');
  assert.deepEqual(Object.keys(ad).sort(), ['accounts', 'brands', 'channels', 'configured', 'hosting', 'id', 'name', 'needs', 'note', 'options', 'selected', 'stories']);
  assert.deepEqual(Object.keys(ad.accounts[0]).sort(), ['allowance', 'channels', 'configured', 'id', 'label', 'lastTestOk', 'lastTestedAt']);
  assert.ok(ad.accounts[0].lastTestedAt && ad.accounts[0].lastTestOk === true, 'when it was last tested');
  assert.equal(ad.channels.length, 2);
  assert.deepEqual(ad.selected, { [P]: 'ch_ig' });
  assert.equal(ad.needs.length, 0);
  assert.ok(!('token' in ad) && !('token' in ad.options));
  // validation: nothing odd is saved
  assert.equal((await human('POST', '/settings', { adapter: 'buffer', token: 'has spaces in it' })).status, 400);
  assert.equal((await human('POST', '/settings', { adapter: 'buffer', options: { mediaBaseUrl: 'ftp://x.example' } })).status, 400);
  assert.equal((await human('POST', '/settings', { adapter: 'buffer', channels: { [P]: 'not-in-the-list' } })).status, 400);
  assert.equal((await human('POST', '/settings', { adapter: 'buffer', options: { apiUrl: 'https://evil.example' } })).status, 400, 'the API address is not a setting');
  assert.equal(loadSettings().accounts.default.token, KEY, 'a refused save leaves it as it was');
  assert.equal((await human('POST', '/settings', { adapter: 'buffer', token: null })).json.configured, false);
  assert.equal(loadSettings().accounts.default.token, undefined);
  const wrong = await human('POST', '/test', { adapter: 'buffer' });
  assert.equal(wrong.json.ok, false);
  assert.match(wrong.json.message, /not connected/);
});

// ---- the calendar's "scheduled" step ---------------------------------------------------------------------------------------------

test('calendar: signed-off or built -> scheduled (owner only), and posted is reachable from it', async () => {
  const mk = (id, status) => { addPost({ id, status, date: `${FUTURE}-24` }); return id; };
  const info = { adapter: 'buffer', scheduledAt: '2099-11-24T07:30:00.000Z', remoteId: 'abc' };
  const a = mk('cs-a', 'signed-off'), b = mk('cs-b', 'built');
  const r = await markScheduled(projectDir, a, info);
  assert.equal(r.item.status, 'scheduled');
  assert.deepEqual({ ...r.item.publish, at: 'x' }, { ...info, at: 'x' });
  assert.equal((await markScheduled(projectDir, b, info, { role: 'human' })).item.status, 'scheduled');
  assert.equal(validateCalendar(loadCalendar(projectDir, P)).ok, true);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(projectDir, 'calendar.json'), 'utf8')).items.find((i) => i.id === a).publish).sort(), ['adapter', 'at', 'remoteId', 'scheduledAt']);
  await assert.rejects(markScheduled(projectDir, a, info), (e) => e.status === 409 && /scheduled item cannot be marked/.test(e.message), 'only once');
  for (const bad of ['idea', 'approved', 'changes', 'rejected', 'posted']) {
    const id = mk(`cs-${bad}`, bad);
    await assert.rejects(markScheduled(projectDir, id, info), (e) => e.status === 409, bad);
  }
  await assert.rejects(markScheduled(projectDir, mk('cs-agent', 'signed-off'), info, { role: 'agent' }), (e) => e.status === 403);
  assert.equal(itemOn('cs-agent').status, 'signed-off');
  await assert.rejects(markScheduled(projectDir, mk('cs-noadapter', 'signed-off'), {}), (e) => e.status === 400);
  const posted = await decide(projectDir, a, 'posted');
  assert.equal(posted.item.status, 'posted');
  assert.equal(posted.item.publish.remoteId, 'abc', 'the record stays');
  // nobody can reach "scheduled" by hand: not the agent, not the owner through a status edit; the agent cannot edit a scheduled item
  await assert.rejects(updateItem(projectDir, 'cs-noadapter', { status: 'scheduled' }, { role: 'human' }), (e) => e.status === 400);
  await assert.rejects(updateItem(projectDir, 'cs-noadapter', { status: 'scheduled' }, { role: 'agent' }), (e) => e.status === 403);
  await assert.rejects(updateItem(projectDir, b, { title: 'Sneaky rename' }, { role: 'agent' }), (e) => e.status === 409);
  assert.equal((await updateItem(projectDir, b, { notes: 'a note is fine' }, { role: 'agent' })).item.notes, 'a note is fine');
});

// ---- Claude's tools ---------------------------------------------------------------------------------------------------------------

test('MCP: Claude gets adapters and plan, and no way to schedule', async () => {
  const client = new NordleClient({ dir: runtimeDir, autostart: false });
  const all = new Map(createTools(client).map((t) => [t.name, t]));
  assert.deepEqual([...all.keys()].filter((n) => /publish/.test(n)).sort(), ['nordle_publish_adapters', 'nordle_publish_plan']);
  assert.match(all.get('nordle_publish_plan').description, /only the owner/i);
  assert.match(all.get('nordle_publish_adapters').description, /only the owner schedules/i);
  const uid = addPost({ id: 'mc-1' });
  const bad = addPost({ id: 'mc-2', status: 'built' });
  const list = await all.get('nordle_publish_adapters').handler({});
  assert.match(list.text, /bundle \(Export folder\): connected/);
  assert.match(list.text, /buffer \(Buffer\): not connected/);
  const plan = await all.get('nordle_publish_plan').handler({ adapter: 'bundle', uids: [uid, bad] });
  assert.match(plan.text, /1 ready, 1 blocked/);
  assert.match(plan.text, /blocked: Not signed off yet/);
  assert.match(plan.text, /only the owner can run it/);
  await assert.rejects(all.get('nordle_publish_plan').handler({ adapter: 'nope', uids: [uid] }), (e) => e instanceof NordleError && e.status === 404);
  const run = await new NordleClient({ dir: runtimeDir, autostart: false }).post('/publish/run', { planId: plan.json.planId }).catch((e) => e);
  assert.equal(run.status, 403, 'even by hand, the agent token cannot run');
});

// ==== several channels per brand, and a Buffer login per brand ================================================================

/** Two Buffer logins: "default" (KEY) for the first brand, "harbour" (KEY2) for the second, both tested so their channels are known. */
async function connectBoth() {
  assert.equal((await human('POST', '/settings', { adapter: 'buffer', token: KEY })).status, 200);
  assert.equal((await human('POST', '/settings', { adapter: 'buffer', account: 'harbour', label: 'Harbour Test Co', token: KEY2 })).status, 200);
  for (const account of ['default', 'harbour']) { const t = await human('POST', '/test', { adapter: 'buffer', account }); assert.equal(t.json.ok, true, t.text); }
  assert.equal((await human('POST', '/settings', { adapter: 'buffer', brand: P, useAccount: 'default' })).status, 200);
  assert.equal((await human('POST', '/settings', { adapter: 'buffer', brand: P2, useAccount: 'harbour', mediaBaseUrl: `${fake.origin}/media/` })).status, 200);
}
const HARBOUR_CHANNELS = [{ id: 'b_ig' }, { id: 'b_fb1', formats: ['carousel', 'post'], hashtags: 'strip' }, { id: 'b_fb2', offsetMinutes: 10, hashtags: 'strip' }, { id: 'b_fb3', enabled: false }];
const setChannels = async (project, list) => { const r = await human('POST', '/settings', { adapter: 'buffer', channels: { [project]: list } }); assert.equal(r.status, 200, r.text); return r.json; };
const createsFor = (channelId) => fake.state.creates.filter((c) => c.channelId === channelId);

test('settings: a brand\'s channels in the array form, the old bare id, defaults filled in, and every bad value refused with a reason', async () => {
  await human('POST', '/settings', { adapter: 'buffer', token: KEY });
  await human('POST', '/test', { adapter: 'buffer' });
  const saved = await setChannels(P, [{ id: 'ch_ig' }, { id: 'ch_fb', formats: ['carousel', 'post'], offsetMinutes: 15, hashtags: 'strip' }]);
  assert.deepEqual(saved.brands[P], { account: 'default', channels: [
    { id: 'ch_ig', name: 'Gannet IG', service: 'instagram', formats: ['reel', 'carousel', 'post', 'story'], enabled: true, offsetMinutes: 0, hashtags: 'keep' },
    { id: 'ch_fb', name: 'Gannet FB', service: 'facebook', formats: ['carousel', 'post'], enabled: true, offsetMinutes: 15, hashtags: 'strip' },
  ] }, 'names and services come from the login\'s own channel list; a single login is used without being picked');
  const legacy = await setChannels(P, 'ch_ig');
  assert.deepEqual(legacy.brands[P].channels.map((c) => [c.id, c.enabled, c.offsetMinutes, c.hashtags]), [['ch_ig', true, 0, 'keep']], 'a bare id is one enabled channel');
  const bad = (channels, re) => human('POST', '/settings', { adapter: 'buffer', channels }).then((r) => { assert.equal(r.status, 400, r.text); assert.match(r.json.errors[0].message, re); });
  await bad({ [P]: [{ id: 'ch_ig' }, { id: 'ch_ig' }] }, /listed twice/);
  await bad({ [P]: [{ id: 'ch_ig', formats: ['reel', 'tiktok'] }] }, /formats must be a list of reel, carousel, post, story/);
  await bad({ [P]: [{ id: 'ch_ig', formats: [] }] }, /at least one/);
  await bad({ [P]: [{ id: 'ch_ig', hashtags: 'maybe' }] }, /"keep" or "strip"/);
  await bad({ [P]: [{ id: 'ch_ig', offsetMinutes: 'soon' }] }, /whole number of minutes/);
  await bad({ [P]: [{ id: 'ch_ig', offsetMinutes: 99999 }] }, /between -1440 and 1440/);
  await bad({ [P]: [{ id: 'ch_ig', enabled: 'yes' }] }, /true or false/);
  await bad({ [P]: [{ id: 'ch_ig', colour: 'red' }] }, /Unknown channel setting "colour"/);
  await bad({ [P]: [{ id: 'has space' }] }, /needs an id/);
  await bad({ [P]: [{ id: 'not-one-of-them' }] }, /not one of the channels/);
  await bad({ [P]: Array.from({ length: 13 }, (_, i) => ({ id: `c${i}` })) }, /At most 12 channels/);
  await bad({ 'Bad Project': [{ id: 'ch_ig' }] }, /not a project id/);
  assert.deepEqual((await human('GET', '/adapters')).json.adapters.find((a) => a.id === 'buffer').brands[P].channels.map((c) => c.id), ['ch_ig'], 'refused saves changed nothing');
  // the same channel cannot serve two brands (the second brand has no login of its own here, so it shares the first one)
  await human('POST', '/settings', { adapter: 'buffer', account: 'harbour', label: 'Harbour Test Co', token: KEY2 });
  await human('POST', '/test', { adapter: 'buffer', account: 'harbour' });
  await human('POST', '/settings', { adapter: 'buffer', brand: P2, useAccount: 'default' });
  const clash = await human('POST', '/settings', { adapter: 'buffer', channels: { [P2]: [{ id: 'ch_ig' }] } });
  assert.equal(clash.status, 400);
  assert.match(clash.json.errors[0].message, /Gannet IG is already connected to gannet\. A channel can belong to one brand only/);
  // clearing a brand: [] or null
  await setChannels(P, []);
  assert.equal((await human('GET', '/adapters')).json.adapters.find((a) => a.id === 'buffer').brands[P]?.channels.length ?? 0, 0);
});

test('settings: the media web address can be sent at the top level; an older one-key settings file is read as the "default" account and rewritten on the next save', async () => {
  const r = await human('POST', '/settings', { adapter: 'buffer', mediaBaseUrl: 'https://media.example.com/nordle/' });
  assert.equal(r.status, 200, r.text);
  assert.equal((await human('GET', '/adapters')).json.adapters.find((a) => a.id === 'buffer').options.mediaBaseUrl, 'https://media.example.com/nordle');
  assert.equal((await human('POST', '/settings', { adapter: 'buffer', mediaBaseUrl: 'ftp://media.example.com' })).status, 400);
  mkdirSync(publishDir(), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify({ schema: 'nordle.publish/0.1', adapters: { buffer: { token: KEY, channels: { [P]: 'ch_ig' }, options: { mediaBaseUrl: `${fake.origin}/media` }, channelCache: [{ id: 'ch_ig', name: 'Gannet IG', service: 'instagram' }] } } }));
  const ad = (await agent('GET', '/adapters')).json.adapters.find((a) => a.id === 'buffer');
  assert.deepEqual(ad.accounts.map((a) => [a.id, a.configured]), [['default', true]]);
  assert.deepEqual(ad.brands[P], { account: 'default', channels: [{ id: 'ch_ig', name: 'Gannet IG', service: 'instagram', formats: ['reel', 'carousel', 'post', 'story'], enabled: true, offsetMinutes: 0, hashtags: 'keep' }] });
  const uid = addPost({ id: 'lg-1' });
  const plan = await planOf('buffer', [uid]);
  assert.equal(plan.summary.ready, 1, JSON.stringify(plan.items.map((i) => i.blockers)));
  await human('POST', '/settings', { adapter: 'buffer', channels: { [P]: [{ id: 'ch_ig', hashtags: 'strip' }] } });
  const file = JSON.parse(readFileSync(settingsPath(), 'utf8'));
  assert.equal(file.accounts.default.token, KEY);
  assert.equal(file.adapters.buffer.token, undefined, 'the old per-adapter key is gone');
  assert.deepEqual(Object.keys(file).sort(), ['accounts', 'adapters', 'brands', 'schema']);
  assert.equal(file.brands[P].account, 'default');
});

test('channels are loaded live for the owner and kept 10 minutes per account; Claude\'s token never causes a request; a failure falls back to the saved list', async () => {
  await human('POST', '/settings', { adapter: 'buffer', token: KEY });
  fake.state.requests.length = 0;
  assert.equal((await agent('GET', '/adapters')).json.adapters.find((a) => a.id === 'buffer').channels.length, 0, 'nothing saved yet and Claude asks for nothing');
  assert.equal(fake.state.requests.length, 0, 'the agent token makes no request to Buffer');
  const first = (await human('GET', '/adapters')).json.adapters.find((a) => a.id === 'buffer');
  assert.deepEqual(first.channels.map((c) => c.id), ['ch_ig', 'ch_fb']);
  assert.deepEqual(first.accounts[0].channels.map((c) => c.id), ['ch_ig', 'ch_fb']);
  assert.equal(fake.state.requests.length, 2, 'organisations, then channels');
  await human('GET', '/adapters');
  assert.equal(fake.state.requests.length, 2, 'the second look is from the 10-minute cache');
  assert.deepEqual((await agent('GET', '/adapters')).json.adapters.find((a) => a.id === 'buffer').channels.map((c) => c.id), ['ch_ig', 'ch_fb'], 'Claude sees what was loaded');
  assert.equal(fake.state.requests.length, 2);
  const ad = getAdapter('buffer');
  await describeAdapter(ad, { live: true, now: Date.now() + 9 * 60 * 1000 });
  assert.equal(fake.state.requests.length, 2, 'still fresh after 9 minutes');
  await describeAdapter(ad, { live: true, now: Date.now() + 11 * 60 * 1000 });
  assert.equal(fake.state.requests.length, 4, 'asked again after 10 minutes');
  clearChannelMemo();
  fake.state.status = { code: 500, body: { error: 'boom' }, headers: {} };
  const down = (await human('GET', '/adapters')).json.adapters.find((a) => a.id === 'buffer');
  assert.match(down.accounts[0].error, /Buffer answered 500/);
  assert.deepEqual(down.accounts[0].channels.map((c) => c.id), ['ch_ig', 'ch_fb'], 'the last saved list is shown');
});

test('plan: one post goes to every channel its brand switched on that takes its format, each with its own time, caption and blockers', async () => {
  await connectBoth();
  await setChannels(P2, HARBOUR_CHANNELS);
  const car = addPost({ id: 'ex-car', project: P2, date: `${FUTURE}-12` });
  const reel = addPost({ id: 'ex-reel', project: P2, format: 'reel', date: `${FUTURE}-13`, time: '09:00' });
  const story = addPost({ id: 'ex-story', project: P2, format: 'story', date: `${FUTURE}-14` });
  const plan = await planOf('buffer', [car, reel, story]);
  const keys = plan.items.map((i) => i.key);
  assert.deepEqual(keys, [`${car}#b_ig`, `${car}#b_fb1`, `${car}#b_fb2`, `${reel}#b_ig`, `${reel}#b_fb2`, `${story}#b_ig`, `${story}#b_fb2`], 'a disabled channel is not planned, and a channel is skipped for formats it does not take');
  const by = Object.fromEntries(plan.items.map((i) => [i.key, i]));
  const ig = by[`${car}#b_ig`], fb1 = by[`${car}#b_fb1`], fb2 = by[`${car}#b_fb2`];
  assert.deepEqual(ig.channel, { id: 'b_ig', name: 'Harbour IG', service: 'instagram' });
  assert.deepEqual([ig.account, ig.accountLabel], ['harbour', 'Harbour Test Co']);
  assert.deepEqual([ig.when, fb1.when, fb2.when], ['2099-11-12T10:30:00.000Z', '2099-11-12T10:30:00.000Z', '2099-11-12T10:40:00.000Z'], '18:30 in Perth (+8), and +10 minutes for the second page');
  assert.equal(ig.caption, 'Fresh beans, roasted this morning.\nCome and say hello.\n\n#coffee #melbourne');
  assert.equal(fb1.caption, 'Fresh beans, roasted this morning.\nCome and say hello.', 'hashtags stripped for the page that wants none');
  assert.ok(ig.ready && fb1.ready && fb2.ready);
  assert.ok(by[`${story}#b_ig`].blockers.some((b) => /Stories are not scheduled/.test(b)), 'a story on Buffer is blocked, per channel');
  assert.equal(by[`${reel}#b_fb2`].ready, true);
  assert.ok(by[`${reel}#b_fb2`].warnings.some((w) => /Facebook: this is sent to Buffer as a Facebook Reel/.test(w)));
  assert.deepEqual(plan.summary, { ready: plan.items.filter((i) => i.ready).length, blocked: plan.items.filter((i) => !i.ready).length });
  // leave some channels out for one run
  const picked = await planOf('buffer', [car], { channels: { [car]: ['b_fb1'] } });
  assert.deepEqual(picked.items.map((i) => i.channel.id), ['b_fb1']);
  const none = await planOf('buffer', [car], { channels: { [car]: ['b_fb3', 'nope'] } });
  assert.equal(none.items.length, 1);
  assert.equal(none.items[0].channel, null);
  assert.match(none.items[0].blockers[0], /None of the channels chosen for this run belong to Harbour Test Co/);
  assert.equal((await human('POST', '/plan', { adapter: 'buffer', uids: [car], channels: { [car]: 'b_fb1' } })).status, 400);
  // a brand's own settings say what is missing, as a blocker and not an error
  const noAccount = addPost({ id: 'ex-none', project: P });
  await human('POST', '/settings', { adapter: 'buffer', brand: P, useAccount: null });
  const plan2 = await planOf('buffer', [noAccount]);
  assert.equal(plan2.items.length, 1);
  assert.match(plan2.items[0].blockers[0], /^Connect a Buffer account for Little Gannet Coffee/);
  await human('POST', '/settings', { adapter: 'buffer', brand: P, useAccount: 'default' });
  assert.match((await planOf('buffer', [noAccount])).items[0].blockers[0], /^Choose the channels Little Gannet Coffee posts to/);
  await setChannels(P, [{ id: 'ch_ig', enabled: false }]);
  assert.match((await planOf('buffer', [noAccount])).items[0].blockers[0], /All of Little Gannet Coffee's channels are switched off/);
  await setChannels(P, [{ id: 'ch_fb', formats: ['post'] }]);
  assert.match((await planOf('buffer', [noAccount])).items[0].blockers[0], /None of Little Gannet Coffee's channels are set to take carousel posts/);
});

test('run: two brands, two Buffer logins; each post goes out under its own brand\'s key, to every channel, once', async () => {
  await connectBoth();
  await setChannels(P, [{ id: 'ch_ig' }, { id: 'ch_fb', hashtags: 'strip' }]);
  await setChannels(P2, HARBOUR_CHANNELS);
  await human('POST', '/settings', { adapter: 'buffer', mediaBaseUrl: `${fake.origin}/media/` });
  const g = addPost({ id: 'rn-g', project: P, date: `${FUTURE}-15` });
  const h = addPost({ id: 'rn-h', project: P2, date: `${FUTURE}-15` });
  const plan = await planOf('buffer', [g, h]);
  assert.deepEqual(plan.summary, { ready: 5, blocked: 0 }, JSON.stringify(plan.items.map((i) => i.blockers)));
  const run = (await human('POST', '/run', { planId: plan.planId })).json;
  assert.equal(run.results.length, 5);
  assert.ok(run.results.every((x) => x.ok), JSON.stringify(run.results));
  assert.deepEqual(run.results.map((x) => x.channel.id), ['ch_ig', 'ch_fb', 'b_ig', 'b_fb1', 'b_fb2'], 'results are per post and channel');
  assert.deepEqual(Object.keys(run.results[0]).sort(), ['channel', 'key', 'message', 'ok', 'remoteId', 'scheduledAt', 'uid']);
  assert.deepEqual(run.posts, [{ uid: g, status: 'scheduled', done: 2, total: 2 }, { uid: h, status: 'scheduled', done: 3, total: 3 }]);
  // keys are isolated: a channel is only ever used with its own brand's login
  assert.equal(fake.state.creates.length, 5, 'one post per channel, nothing sent twice');
  for (const [i, c] of fake.state.creates.entries()) assert.equal(fake.state.createKeys[i], ['ch_ig', 'ch_fb'].includes(c.channelId) ? KEY : KEY2, `${c.channelId} went out under its own account`);
  assert.equal(createsFor('b_fb3').length, 0, 'the switched-off channel got nothing');
  assert.equal(createsFor('b_ig')[0].dueAt, '2099-11-15T10:30:00.000Z');
  assert.equal(createsFor('b_fb2')[0].dueAt, '2099-11-15T10:40:00.000Z', 'staggered by the channel\'s offset');
  assert.ok(createsFor('b_ig')[0].text.endsWith('#coffee #melbourne') && !createsFor('b_fb1')[0].text.includes('#'), 'hashtags kept for one channel, stripped for the other');
  assert.ok(createsFor('b_ig')[0].metadata?.instagram && !createsFor('b_ig')[0].metadata?.facebook, 'Instagram settings only on the Instagram channel');
  assert.ok(createsFor('b_fb1')[0].metadata?.facebook?.type && !createsFor('b_fb1')[0].metadata?.instagram, 'a Facebook channel always says what kind of post it is');
  assert.equal(fake.state.media.filter((m) => m.startsWith('HEAD') && m.includes('rn-h')).length, 3, 'each of the 3 pictures was checked once, not once per channel');
  // the calendar
  const gi = itemOn('rn-g', P), hi = itemOn('rn-h', P2);
  assert.deepEqual([gi.status, hi.status], ['scheduled', 'scheduled']);
  assert.deepEqual(hi.publish.targets.map((t) => [t.channel, t.ok, !!t.remoteId, !!t.scheduledAt]), [['b_ig', true, true, true], ['b_fb1', true, true, true], ['b_fb2', true, true, true]]);
  assert.equal(hi.publish.adapter, 'buffer');
  assert.equal(validateCalendar(loadCalendar(harbourDir, P2)).ok, true);
  // the audit log names the account, never the key
  const log = readFileSync(auditPath(harbourDir), 'utf8');
  assert.match(log, /"account":"harbour"/);
  assert.match(readFileSync(auditPath(projectDir), 'utf8'), /"account":"default"/);
  // keys never leave
  const everything = [(await human('GET', '/adapters')).text, (await agent('GET', '/adapters')).text, JSON.stringify(plan), JSON.stringify(run), log, readFileSync(auditPath(projectDir), 'utf8'), readFileSync(join(publishDir(), 'publish-plans', `${plan.planId}.json`), 'utf8')];
  for (const text of everything) assert.ok(!text.includes(KEY) && !text.includes(KEY2), 'no key in any reply, plan or log');
  const ad = (await human('GET', '/adapters')).json.adapters.find((a) => a.id === 'buffer');
  assert.deepEqual(ad.accounts.map((a) => [a.id, a.label, a.configured, a.channels.map((c) => c.id)]), [['default', 'Buffer', true, ['ch_ig', 'ch_fb']], ['harbour', 'Harbour Test Co', true, ['b_ig', 'b_fb1', 'b_fb2', 'b_fb3']]], 'each login lists its own channels');
  assert.deepEqual(ad.brands[P2].channels.map((c) => [c.id, c.enabled]), [['b_ig', true], ['b_fb1', true], ['b_fb2', true], ['b_fb3', false]]);
  assert.equal(ad.brands[P2].account, 'harbour');
  assert.equal(ad.configured, true);
});

test('run: when one channel fails the others stay, the post is not "scheduled" yet, and a retry sends only the one that failed', async () => {
  await connectBoth();
  await setChannels(P2, [{ id: 'b_ig' }, { id: 'b_fb1' }, { id: 'b_fb2' }]);
  const uid = addPost({ id: 'pt-1', project: P2, date: `${FUTURE}-16` });
  fake.state.create = (input, n) => (input.channelId === 'b_fb1'
    ? { data: { createPost: { __typename: 'MutationError', message: `This page cannot take the post right now (key ${KEY2})` } } }
    : { data: { createPost: { __typename: 'PostActionSuccess', post: { id: `post_${n}`, dueAt: input.dueAt } } } });
  const plan = await planOf('buffer', [uid]);
  const r = (await human('POST', '/run', { planId: plan.planId })).json;
  assert.deepEqual(r.results.map((x) => [x.channel.id, x.ok]), [['b_ig', true], ['b_fb1', false], ['b_fb2', true]]);
  assert.match(r.results[1].message, /Buffer refused it: This page cannot take the post right now/);
  assert.ok(!JSON.stringify(r).includes(KEY2));
  assert.deepEqual(r.posts, [{ uid, status: 'partial', done: 2, total: 3 }]);
  const mid = itemOn('pt-1', P2);
  assert.equal(mid.status, 'signed-off', 'not scheduled until every channel has gone');
  assert.deepEqual(mid.publish.targets.map((t) => [t.channel, t.ok]), [['b_ig', true], ['b_fb1', false], ['b_fb2', true]]);
  assert.ok(mid.publish.targets[1].message.includes('cannot take the post') && !mid.publish.targets[1].message.includes(KEY2));
  assert.equal(validateCalendar(loadCalendar(harbourDir, P2)).ok, true);
  // the same plan will not hand the finished channels over again
  const same = (await human('POST', '/run', { planId: plan.planId, only: [`${uid}#b_ig`] })).json;
  assert.match(same.results[0].message, /already handed that post over to Harbour IG/);
  // a new plan: the two that worked are shown as done, the failed one is ready
  const again = await planOf('buffer', [uid]);
  assert.deepEqual(again.items.map((i) => [i.channel.id, i.ready]), [['b_ig', false], ['b_fb1', true], ['b_fb2', false]]);
  assert.match(again.items[0].blockers[0], /Already scheduled on Harbour IG for 2099-11-16T10:30:00.000Z/);
  fake.state.create = (input, n) => ({ data: { createPost: { __typename: 'PostActionSuccess', post: { id: `post_${n}`, dueAt: input.dueAt } } } });
  fake.state.creates.length = 0;
  const retry = (await human('POST', '/run', { planId: again.planId })).json;
  assert.deepEqual(retry.results.map((x) => [x.channel.id, x.ok]), [['b_fb1', true]]);
  assert.deepEqual(fake.state.creates.map((c) => c.channelId), ['b_fb1'], 'only the failed channel was sent: no duplicates');
  assert.deepEqual(retry.posts, [{ uid, status: 'scheduled', done: 1, total: 3 }]);
  const done = itemOn('pt-1', P2);
  assert.equal(done.status, 'scheduled');
  assert.deepEqual(done.publish.targets.map((t) => [t.channel, t.ok]), [['b_ig', true], ['b_fb1', true], ['b_fb2', true]], 'a channel keeps its place when it is retried');
  assert.equal(done.publish.targets[1].message, undefined, 'the failure note is gone once it worked');
});

test('accounts: add, test, pick per brand, remove; a brand\'s channels belong to the account it picked', async () => {
  await human('POST', '/settings', { adapter: 'buffer', token: KEY });
  await human('POST', '/test', { adapter: 'buffer' });
  await setChannels(P, [{ id: 'ch_ig' }]);
  const added = await human('POST', '/settings', { adapter: 'buffer', account: 'harbour', label: 'Harbour Test Co', token: KEY2 });
  assert.deepEqual(added.json.accounts.map((a) => [a.id, a.configured]), [['default', true], ['harbour', true]]);
  assert.equal((await human('POST', '/settings', { adapter: 'buffer', account: 'Bad Id', token: KEY2 })).status, 400);
  assert.equal((await human('POST', '/settings', { adapter: 'buffer', account: 'other', label: '' })).status, 400);
  assert.equal((await human('POST', '/test', { adapter: 'buffer' })).status, 400, 'two accounts: say which');
  assert.equal((await human('POST', '/test', { adapter: 'buffer', account: 'nope' })).status, 404);
  const before = Date.now();
  const t = (await human('POST', '/test', { adapter: 'buffer', account: 'harbour' })).json;
  assert.deepEqual([t.ok, t.account, t.channels.map((c) => c.id)], [true, 'harbour', ['b_ig', 'b_fb1', 'b_fb2', 'b_fb3']]);
  assert.match(t.message, /Harbour Org/);
  assert.equal(fake.state.requests.at(-1).headers.authorization, `Bearer ${KEY2}`, 'the test used that account\'s own key');
  const acc = (await human('GET', '/adapters')).json.adapters.find((a) => a.id === 'buffer').accounts.find((a) => a.id === 'harbour');
  assert.ok(Date.parse(acc.lastTestedAt) >= before - 1000 && acc.lastTestOk === true);
  // a brand picks its account; its old channels (the other account's) are cleared unless new ones come with it
  const sw = await human('POST', '/settings', { adapter: 'buffer', brand: P, useAccount: 'harbour' });
  assert.deepEqual(sw.json.cleared, [P]);
  assert.deepEqual(sw.json.brands[P], { account: 'harbour', channels: [] });
  assert.equal((await human('POST', '/settings', { adapter: 'buffer', brand: P, useAccount: 'nope' })).status, 404);
  assert.equal((await human('POST', '/settings', { adapter: 'buffer', brand: P, channels: undefined })).status, 400);
  const together = await human('POST', '/settings', { adapter: 'buffer', brand: P, useAccount: 'default', channels: { [P]: [{ id: 'ch_fb' }] } });
  assert.deepEqual([together.json.brands[P].account, together.json.brands[P].channels.map((c) => c.id), together.json.cleared], ['default', ['ch_fb'], undefined]);
  assert.equal((await human('POST', '/settings', { adapter: 'buffer', channels: { [P]: [{ id: 'b_ig' }] } })).status, 400, 'a channel of the other account is not this brand\'s');
  // an account that a brand uses cannot be removed
  const refuse = await human('POST', '/settings', { adapter: 'buffer', remove: 'default' });
  assert.equal(refuse.status, 409);
  assert.match(refuse.json.errors[0].message, /gannet still publishes through "Buffer"/);
  assert.equal((await human('POST', '/settings', { adapter: 'buffer', remove: 'harbour' })).status, 200);
  assert.equal((await human('POST', '/settings', { adapter: 'buffer', remove: 'harbour' })).status, 404);
  assert.ok(!readFileSync(settingsPath(), 'utf8').includes(KEY2), 'a removed account\'s key is gone from the file');
  assert.equal((await agent('POST', '/settings', { adapter: 'buffer', account: 'x', token: KEY2 })).status, 403);
  assert.equal((await agent('POST', '/settings', { adapter: 'buffer', remove: 'default' })).status, 403);
  assert.equal((await agent('POST', '/test', { adapter: 'buffer', account: 'default' })).status, 403);
});

test('bundle: a brand with channels gets one sub-folder per channel (its own caption), the pictures once, and a csv row per channel', async () => {
  await connectBoth();
  await setChannels(P2, [{ id: 'b_ig' }, { id: 'b_fb1', hashtags: 'strip', offsetMinutes: 5 }]);
  const uid = addPost({ id: 'bn-1', project: P2, date: `${FUTURE}-18` });
  const plan = await planOf('bundle', [uid]);
  assert.deepEqual(plan.items.map((i) => [i.channel?.id, i.ready]), [['b_ig', true], ['b_fb1', true]]);
  const run = (await human('POST', '/run', { planId: plan.planId })).json;
  assert.deepEqual(run.results.map((x) => x.ok), [true, true]);
  assert.deepEqual(run.posts, [{ uid, status: 'exported', done: 2, total: 2 }]);
  const dir = join(harbourDir, 'out', 'publish', `${FUTURE}-18-bn-1`);
  assert.deepEqual(readdirSync(dir).sort(), ['01-cover.png', '02-tip.png', '03-cta.png', 'alt.txt', 'b_fb1', 'b_ig', 'caption.txt']);
  assert.ok(readFileSync(join(dir, 'b_ig', 'caption.txt'), 'utf8').endsWith('#coffee #melbourne\n'));
  assert.equal(readFileSync(join(dir, 'b_fb1', 'caption.txt'), 'utf8'), 'Fresh beans, roasted this morning.\nCome and say hello.\n');
  assert.match(readFileSync(join(dir, 'b_fb1', 'channel.txt'), 'utf8'), /Harbour Page One \(facebook\)/);
  const csv = readdirSync(join(harbourDir, 'out', 'publish')).find((f) => f.endsWith('.csv'));
  const lines = readFileSync(join(harbourDir, 'out', 'publish', csv), 'utf8').trim().split('\r\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /,caption_start,channel,channel_name,service$/);
  assert.match(lines[1], /^2099-11-18,18:30,Australia\/Perth,2099-11-18T10:30:00.000Z,.*,b_ig,Harbour IG,instagram$/);
  assert.match(lines[2], /^2099-11-18,18:35,Australia\/Perth,2099-11-18T10:35:00.000Z,.*,b_fb1,Harbour Page One,facebook$/);
  assert.equal(itemOn('bn-1', P2).status, 'signed-off', 'an export is not a schedule');
  assert.equal(fake.state.creates.length, 0, 'nothing was sent anywhere');
});

test('calendar: recordPublishTarget keeps each channel\'s result, never lets a failure undo a success, and the owner alone may call it', async () => {
  const id = 'rt-1';
  addPost({ id, status: 'signed-off', date: `${FUTURE}-24` });
  await assert.rejects(recordPublishTarget(projectDir, id, { adapter: 'buffer', channel: 'c1', ok: true }, { role: 'agent' }), (e) => e.status === 403);
  const a = await recordPublishTarget(projectDir, id, { adapter: 'buffer', channel: 'c1', ok: true, scheduledAt: '2099-11-24T07:30:00.000Z', remoteId: 'r1' });
  assert.equal(a.item.status, 'signed-off', 'recording a channel does not schedule the post');
  await recordPublishTarget(projectDir, id, { adapter: 'buffer', channel: 'c2', ok: false, message: 'refused' });
  const b = await recordPublishTarget(projectDir, id, { adapter: 'buffer', channel: 'c1', ok: false, message: 'a later failure' });
  assert.deepEqual(b.item.publish.targets.map((t) => [t.channel, t.ok, t.remoteId]), [['c1', true, 'r1'], ['c2', false, undefined]], 'the success stands, and each channel keeps its place');
  const c = await recordPublishTarget(projectDir, id, { adapter: 'buffer', channel: 'c2', ok: true, scheduledAt: '2099-11-24T07:40:00.000Z', remoteId: 'r2' });
  assert.equal(c.item.publish.targets.find((t) => t.channel === 'c2').message, undefined);
  const m = await markScheduled(projectDir, id, { adapter: 'buffer', targets: c.item.publish.targets });
  assert.equal(m.item.status, 'scheduled');
  assert.deepEqual([m.item.publish.scheduledAt, m.item.publish.remoteId, m.item.publish.targets.length], ['2099-11-24T07:30:00.000Z', 'r1', 2], 'the earliest channel is the headline');
  assert.equal(validateCalendar(loadCalendar(projectDir, P)).ok, true);
  await assert.rejects(recordPublishTarget(projectDir, id, { adapter: 'buffer', channel: 'c3', ok: true }), (e) => e.status === 409, 'a scheduled post takes no more results');
  await assert.rejects(recordPublishTarget(projectDir, 'cs-idea-x', { adapter: 'buffer', channel: 'c3', ok: true }), (e) => e.status === 404);
});

test('command line: logins, a brand\'s login and channels, from the owner\'s own machine only', async () => {
  const env = { ...process.env, NORDLE_PROJECTS: join(work, 'projects'), NORDLE_PUBLISH_DIR: join(work, 'state') };
  const cli = (args, extra = {}, input = '') => spawnSync(process.execPath, [join(ROOT, 'nordle.mjs'), 'publish', ...args], { env: { ...env, ...extra }, encoding: 'utf8', windowsHide: true, input });
  let r = cli(['settings', 'buffer', '--account', 'harbour', '--label', 'Harbour Test Co', '--token-stdin'], { NORDLE_AGENT_RUN: '1' }, KEY2);
  assert.equal(r.status, 3);
  assert.equal(existsSync(settingsPath()), false);
  r = cli(['settings', 'buffer', '--account', 'harbour', '--label', 'Harbour Test Co', '--token-stdin'], {}, `${KEY2}\n`);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!r.stdout.includes(KEY2) && !r.stderr.includes(KEY2), 'the key is never printed');
  r = cli(['settings', 'buffer', '--brand', P2, '--use-account', 'harbour', '--channel', `${P2}=b_ig`, '--channel', `${P2}=b_fb1,hashtags=strip,offset=5,formats=carousel+post,name=Page One`, '--media-base-url', 'https://media.example.com/n']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  r = cli(['adapters']);
  assert.match(r.stdout, /account harbour {2}"Harbour Test Co" {2}key saved/);
  assert.match(r.stdout, /brand harbour {2}account harbour/);
  assert.match(r.stdout, /Page One.* {2}id b_fb1 {2}on {2}carousel\+post {2}offset 5 min {2}no hashtags/);
  assert.match(r.stdout, /media web address: https:\/\/media.example.com\/n/);
  assert.ok(!r.stdout.includes(KEY2));
  r = cli(['settings', 'buffer', '--brand', P2, '--use-account', 'nope']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /There is no Buffer account "nope"/);
  r = cli(['settings', 'buffer', '--channel', 'bad']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--channel takes <project>=<channel id>/);
  assert.equal(JSON.parse(readFileSync(settingsPath(), 'utf8')).accounts.harbour.token, KEY2);
});

// ---- automatic scheduling: approved posts a week away go to Buffer on their own ---------------------------------------------------

const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const autoRound = async () => {
  const auto = await import('../src/publish/auto.mjs');
  rmSync(auto._test.statePath(), { force: true });
  return auto;
};

test('auto-schedule: off until the owner switches it on, and only the owner can; bad values are refused', async () => {
  await autoRound();
  const off = await agent('GET', '/auto-schedule');
  assert.equal(off.status, 200);
  assert.deepEqual([off.json.enabled, off.json.daysAhead, off.json.stories], [false, 7, true]);
  assert.equal((await agent('POST', '/auto-schedule', { enabled: true })).status, 403, 'Claude cannot turn it on');
  assert.equal((await agent('POST', '/auto-schedule', { now: true })).status, 403);
  assert.equal((await human('POST', '/auto-schedule', { daysAhead: 0 })).status, 400);
  assert.equal((await human('POST', '/auto-schedule', { daysAhead: 99 })).status, 400);
  assert.equal((await human('POST', '/auto-schedule', { enabled: 'yes' })).status, 400);
  const on = await human('POST', '/auto-schedule', { enabled: true, daysAhead: 10 });
  assert.equal(on.status, 200, on.text);
  assert.deepEqual([on.json.enabled, on.json.daysAhead], [true, 10]);
  assert.equal(loadSettings().auto.enabled, true, 'saved in the owner\'s publish settings');
  assert.ok(!JSON.stringify(on.json).includes(KEY));
  await human('POST', '/auto-schedule', { enabled: false, daysAhead: 7 });
});

test('auto-schedule: a signed-off post inside the window goes to Buffer with its Story; later, unsigned and already-scheduled ones are left alone', async () => {
  const { autoScheduleTick, saveAutoSettings } = await autoRound();
  await connectBuffer();
  const soon = addPost({ id: 'auto-soon', date: inDays(3) });
  const later = addPost({ id: 'auto-later', date: inDays(20) });
  addPost({ id: 'auto-unsigned', date: inDays(3), status: 'built' });
  // switched off: nothing happens
  saveAutoSettings({ enabled: false }, 'human');
  assert.deepEqual((await autoScheduleTick(store)).scheduled, []);
  assert.equal(fake.state.creates.length, 0);
  saveAutoSettings({ enabled: true, daysAhead: 7, stories: true }, 'human');
  const r = await autoScheduleTick(store);
  assert.deepEqual(r.scheduled, [soon]);
  assert.equal(fake.state.creates.length, 2, 'the post and its Story');
  assert.equal(itemOn('auto-soon').status, 'scheduled');
  assert.equal(itemOn('auto-later').status, 'signed-off');
  assert.equal(itemOn('auto-unsigned').status, 'built');
  const log = readFileSync(auditPath(projectDir), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(log.some((l) => l.uid === soon && l.via === 'auto' && l.ok === true && l.by === 'owner'), 'the audit log says it was automatic');
  // a second look sends nothing more
  const again = await autoScheduleTick(store);
  assert.deepEqual(again.scheduled, []);
  assert.equal(fake.state.creates.length, 2);
  // the window moves with the setting
  saveAutoSettings({ daysAhead: 25 }, 'human');
  assert.deepEqual((await autoScheduleTick(store)).scheduled, [later]);
  saveAutoSettings({ enabled: false }, 'human');
});

test('auto-schedule: Stories can be left out; a post whose time is today is left for the owner', async () => {
  const { autoScheduleTick, saveAutoSettings } = await autoRound();
  await connectBuffer();
  const plain = addPost({ id: 'auto-plain', date: inDays(2) });
  addPost({ id: 'auto-close', date: inDays(0), time: '00:05' });
  saveAutoSettings({ enabled: true, daysAhead: 7, stories: false }, 'human');
  const r = await autoScheduleTick(store);
  assert.deepEqual(r.scheduled, [plain]);
  assert.equal(fake.state.creates.length, 1, 'no Story');
  assert.equal(itemOn('auto-close').status, 'signed-off', 'its time has passed or is too close: nothing is guessed');
  saveAutoSettings({ enabled: false, stories: true }, 'human');
});

test('auto-schedule: a post that is not ready is left alone with the reason, and not looked at again for hours', async () => {
  const { autoScheduleTick, autoStatus, saveAutoSettings } = await autoRound();
  await connectBuffer();
  const bad = addPost({ id: 'auto-blocked', date: inDays(3), noMedia: true });
  saveAutoSettings({ enabled: true, daysAhead: 7 }, 'human');
  const r = await autoScheduleTick(store);
  assert.deepEqual(r.scheduled, []);
  assert.ok((r.skipped.find((s) => s.uid === bad)?.why ?? '').length > 5, 'the reason is kept');
  assert.equal(fake.state.creates.length, 0);
  const status = autoStatus();
  assert.equal(status.problems.find((p) => p.uid === bad)?.stopped, false);
  assert.ok(status.problems.find((p) => p.uid === bad).message.length > 5);
  const second = await autoScheduleTick(store);
  assert.deepEqual(second.skipped.filter((s) => s.uid === bad).map((s) => s.why), ['waiting'], 'not planned again straight away');
  saveAutoSettings({ enabled: false }, 'human');
});

test('auto-schedule: when Buffer refuses, it tries again later, stops after three failures, and never sends the same post twice', async () => {
  const { autoScheduleTick, autoStatus, saveAutoSettings, _test } = await autoRound();
  await connectBuffer();
  const uid = addPost({ id: 'auto-refused', date: inDays(3) });
  fake.state.create = () => ({ data: { createPost: { __typename: 'MutationError', message: 'Buffer said no.' } } });
  saveAutoSettings({ enabled: true, daysAhead: 7, stories: false }, 'human');
  const first = await autoScheduleTick(store);
  assert.deepEqual(first.failed.map((f) => f.uid), [uid]);
  assert.match(first.failed[0].message, /Buffer said no/);
  assert.equal(itemOn('auto-refused').status, 'signed-off');
  assert.deepEqual((await autoScheduleTick(store)).failed, [], 'not at once');
  const wait = () => { const s = _test.readState(); s.posts[uid].blockedUntil = 0; _test.writeState(s); };
  for (let i = 0; i < 2; i++) { wait(); assert.equal((await autoScheduleTick(store)).failed.length, 1); }
  const stopped = autoStatus().problems.find((p) => p.uid === uid);
  assert.deepEqual([stopped.stopped, stopped.tries], [true, 3]);
  wait();
  assert.deepEqual((await autoScheduleTick(store)).skipped.filter((s) => s.uid === uid), [{ uid, why: 'stopped' }], 'three tries and it waits for the owner');
  saveAutoSettings({ enabled: false }, 'human');
});

test('auto-schedule: the scheduler looks every so often, soon after a kick, one pass at a time, and never throws', async () => {
  const { createAutoScheduler } = await autoRound();
  let calls = 0, release;
  const gate = new Promise((r) => { release = r; });
  const messages = [];
  const sched = createAutoScheduler({ intervalMs: 3600000, log: (m) => messages.push(m), tick: async () => { calls++; if (calls === 1) await gate; if (calls === 3) throw new Error('boom'); return { scheduled: [] }; } });
  const first = sched.now(store);                         // a pass is running (held at the gate)
  assert.equal(sched.isRunning(), true);
  assert.equal(await sched.now(store), null, 'a second look while one is running just asks for another afterwards');
  release();
  await first;
  await new Promise((r) => setTimeout(r, 2500));          // the "again" kick (2 s) fires
  assert.equal(calls, 2);
  await sched.now(store);                                 // the third call throws: it is logged, not thrown
  assert.ok(messages.some((m) => /boom/.test(m)));
  sched.stop();
});
