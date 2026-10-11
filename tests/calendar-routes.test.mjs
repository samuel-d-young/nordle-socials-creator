// The calendar over HTTP and through Claude's MCP tools, against a real Nordle server with the two tokens:
// the owner's (human) and Claude's (agent). The point of most of these tests is what the agent token must NOT be able to do.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../tools/validate.mjs';
import { createNordleServer } from '../src/server/http.mjs';
import { loadCalendar, newCalendar, saveCalendar, validateCalendar } from '../src/calendar/model.mjs';
import { NordleClient, NordleError } from '../src/mcp/client.mjs';
import { createTools } from '../src/mcp/tools.mjs';
import calendarRoute from '../src/server/routes/calendar.mjs';

const HUMAN = 'human-token-for-calendar-tests-0123456789';
const AGENT = 'agent-token-for-calendar-tests-0123456789';
const P = 'little-gannet';
let app, base, work, projectDir, runtimeDir;

const PILLARS = [{ id: 'drinks', name: 'The drinks', share: 0.5 }, { id: 'harbour', name: 'The harbour', share: 0.5 }];

before(async () => {
  process.env.NORDLE_TODAY = '2026-10-05';
  work = mkdtempSync(join(tmpdir(), 'nordle-calroutes-'));
  runtimeDir = join(work, 'runtime');
  projectDir = join(work, 'projects', P);
  cpSync(join(ROOT, 'samples', P), projectDir, { recursive: true, filter: (s) => !/[\\/](out|sources)([\\/]|$)/.test(s) });
  saveCalendar(projectDir, {
    ...newCalendar(P), timezone: 'Australia/Melbourne',
    settings: { leadDays: 7, perMonth: { reel: 2, carousel: 1, post: 1 }, pillars: PILLARS, regions: ['VIC'] },
    items: [{ id: 'seed-approved', date: '2026-10-08', format: 'carousel', title: 'Spring menu preview', status: 'approved', pillar: 'drinks', idea: 'Three new pours, one line each.', hook: 'Three new pours.', ideaApproval: 'owner' }],
  });
  app = createNordleServer({ roots: [join(work, 'projects')], token: HUMAN, agentToken: AGENT, runtimeDir });
  const port = await app.listen(0);
  base = `http://127.0.0.1:${port}/api/projects/${P}/calendar`;
});
after(async () => {
  await app.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  delete process.env.NORDLE_TODAY;
});

async function call(role, method, path, body, headers = {}) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'x-nordle-token': role === 'human' ? HUMAN : role === 'agent' ? AGENT : 'nope', 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}
const human = (m, p, b) => call('human', m, p, b);
const agent = (m, p, b) => call('agent', m, p, b);
const disk = () => loadCalendar(projectDir);
const onDisk = (id) => disk().items.find((i) => i.id === id);
const IDEA = { date: '2026-10-14', format: 'reel', title: 'The flat white, start to finish', pillar: 'drinks', idea: 'One flat white made at the machine, with the barista saying what they watch for in the pour.', hook: 'Watch the pour.', mediaPlan: 'The behind-the-roast clip' };

test('GET calendar: the plan, each month against its quota, occasions in range, lint, what is due', async () => {
  const r = await agent('GET', '');
  assert.equal(r.status, 200);
  const o = r.json;
  assert.deepEqual([o.project, o.today, o.timezone], [P, '2026-10-05', 'Australia/Melbourne']);
  assert.deepEqual(Object.keys(o).sort(), ['brand', 'brandName', 'calendar', 'due', 'effective', 'lint', 'months', 'occasions', 'project', 'range', 'running', 'timezone', 'today']);
  assert.deepEqual(o.range, { from: '2026-10-01', to: '2026-12-31' }, 'this month through the horizon');
  assert.deepEqual(o.months.map((m) => m.month), ['2026-10', '2026-11', '2026-12']);
  assert.deepEqual([o.months[0].quotaTotal, o.months[0].total, o.months[0].missingTotal], [4, 1, 3]);
  assert.deepEqual(Object.keys(o.months[0]).sort(), ['counts', 'byStatus', 'missing', 'missingTotal', 'month', 'ok', 'over', 'pillars', 'quota', 'quotaTotal', 'total', 'unassigned'].sort());
  assert.equal(o.months[0].pillars[0].id, 'drinks');
  assert.equal(o.calendar.items.length, 1);
  assert.deepEqual([o.effective.leadDays, o.effective.regions, o.effective.autoBuild, o.effective.ideaApproval], [7, ['VIC'], false, 'owner']);
  const names = o.occasions.map((x) => x.name);
  assert.ok(names.includes('Halloween') && names.includes('Melbourne Cup Day') && names.includes('Movember'));
  assert.ok(!names.some((n) => /^WA /.test(n)), 'only the brand\'s state');
  assert.ok(o.occasions.every((x) => ['id', 'name', 'date', 'end', 'kind', 'regions', 'tags', 'relevance', 'confidence', 'verify', 'advice'].every((k) => k in x)));
  assert.deepEqual(o.due, [{ id: 'seed-approved', mode: 'build', date: '2026-10-08' }]);
  assert.equal(o.running, null);
  assert.ok('seed-approved' in o.lint);
  const narrow = await human('GET', '?from=2026-11-01&to=2026-11-30');
  assert.deepEqual(narrow.json.months.map((m) => m.month), ['2026-11']);
  assert.equal((await human('GET', '?from=banana')).status, 400);
  assert.equal((await human('GET', '?from=2026-12-01&to=2026-11-01')).status, 400);
  assert.equal((await call('none', 'GET', '')).status, 401);
  const missing = await fetch(`${base.replace(P, 'no-such-project')}`, { headers: { 'x-nordle-token': HUMAN } });
  assert.equal(missing.status, 404);
});

test('GET due, slots, occasions and prompt', async () => {
  const due = (await agent('GET', '/due')).json;
  assert.deepEqual(due.due.map((d) => [d.mode, d.item.id]), [['build', 'seed-approved']]);
  assert.equal(due.leadDays, 7);
  const later = (await agent('GET', '/due?today=2026-09-01')).json;
  assert.deepEqual(later.due, [], 'nothing is due yet in September');
  const slots = (await agent('GET', '/slots?month=2026-11')).json;
  assert.equal(slots.slots.length, 4, 'a quota of 2 reels, 1 carousel and 1 post');
  assert.deepEqual(slots.need, { reel: 2, carousel: 1, post: 1, story: 0 });
  assert.equal((await agent('GET', '/slots?month=11')).status, 400);
  const occ = (await agent('GET', '/occasions?from=2026-11-01&to=2026-11-30&regions=WA')).json.occasions.map((o) => o.name);
  assert.ok(!occ.includes('Melbourne Cup Day') && occ.includes('Movember'));
  const build = (await agent('GET', '/prompt?item=seed-approved')).json;
  assert.equal(build.kind, 'build');
  assert.match(build.prompt, /Spring menu preview/);
  const propose = (await agent('GET', '/prompt?kind=propose&month=2026-11')).json;
  assert.match(propose.prompt, /Plan the next posts/);
  assert.equal((await agent('GET', '/prompt?kind=build')).status, 400);
  assert.equal((await agent('GET', '/prompt?item=nope')).status, 404);
});

test('Claude\'s token: ideas in, never approved; checked on the way in', async () => {
  const r = await agent('POST', '/propose', { ideas: [IDEA, { ...IDEA, date: '2026-09-01', title: 'A late idea', idea: 'Something about oat milk.', hook: 'Oat or dairy?' }, { ...IDEA, date: '2026-10-16', title: 'Hear from our customers', idea: 'World\'s best coffee, guaranteed.', hook: 'Guaranteed.' }] });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.added.length, 1);
  assert.deepEqual([r.json.added[0].status, r.json.added[0].origin, r.json.added[0].ideaApproval], ['idea', 'claude', undefined]);
  assert.equal(r.json.rejected.length, 2);
  assert.deepEqual(r.json.rejected.map((x) => x.errors[0].rule), ['past-date', 'banned-phrase']);
  assert.ok(r.json.months.some((m) => m.month === '2026-10'));
  assert.equal(validateCalendar(disk()).ok, true);

  const one = await agent('POST', '/items', { date: '2026-10-21', format: 'post', title: 'Closing early on Friday', pillar: 'harbour', idea: 'A short note about the shop closing at the usual early time on the harbour festival day.', hook: 'Festival Friday.' });
  assert.equal(one.status, 201);
  assert.equal(one.json.item.status, 'idea');
  const refused = await agent('POST', '/items', { date: '2026-10-21', format: 'post', title: 'No idea given' });
  assert.equal(refused.status, 422);
  assert.equal(refused.json.ok, false);
  assert.match(refused.json.errors[0].message, /no (description|hook)/i);
  const many = await agent('POST', '/items', { items: [{ date: '2026-11-02', format: 'story', title: 'A story about the queue', idea: 'The queue at 7:30 on festival morning.', hook: 'Look at that queue.', pillar: 'harbour' }] });
  assert.equal(many.status, 201);
  assert.equal(many.json.items.length, 1);
  const full = await agent('POST', '/items', { items: [{ date: '2026-10-22', format: 'story', title: 'One story too many', idea: 'Something about the morning rush.', hook: 'Rush hour.', pillar: 'harbour' }] });
  assert.equal(full.json.items.length, 0, 'October already has its other posts');
  assert.equal(full.json.rejected[0].errors[0].rule, 'over-quota');
  assert.equal((await agent('POST', '/items', { date: '2026-10-23', format: 'post', title: 'x', status: 'approved' })).status, 422, 'asking to be approved is refused');
  assert.equal((await agent('POST', '/items', { date: '2026-10-23', format: 'post', title: 'x', colour: 'blue' })).status, 422, 'unknown fields are refused');
  assert.equal((await agent('POST', '/propose', { nope: 1 })).status, 400);
});

test('Claude\'s token cannot approve, reject, sign off, ask for changes, retry, change settings or override', async () => {
  const id = disk().items.find((i) => i.title === 'The flat white, start to finish').id;
  const before = JSON.stringify(disk());
  for (const action of ['approve', 'unapprove', 'reject', 'signoff', 'changes', 'posted', 'retry']) {
    const r = await agent('POST', `/items/${id}/${action}`, { comment: 'because' });
    assert.equal(r.status, 403, action);
    assert.match(r.json.errors[0].message, /Only the owner/);
  }
  for (const status of ['approved', 'rejected', 'signed-off', 'changes', 'posted']) {
    for (const verb of ['POST']) {
      const r = await call('agent', verb, `/items/${id}`, { status });
      assert.equal(r.status, 403, `${verb} status ${status}`);
    }
  }
  assert.equal((await agent('POST', '/approve-all', {})).status, 403);
  assert.equal((await agent('POST', '/settings', { autoBuild: true })).status, 403);
  assert.equal((await agent('POST', '/settings', { ideaApproval: 'delegated' })).status, 403, 'Claude cannot delegate approval to itself');
  assert.equal(JSON.stringify(disk()), before, 'nothing changed');
  // reading is fine, editing the idea itself is fine
  const edit = await agent('POST', `/items/${id}`, { hook: 'Watch the pour, then taste it.' });
  assert.equal(edit.status, 200);
  assert.equal(edit.json.item.hook, 'Watch the pour, then taste it.');
});

test('the owner: approve, edit, reject, un-approve; Claude\'s edit of an approved idea sends it back', async () => {
  const id = disk().items.find((i) => i.title === 'The flat white, start to finish').id;
  const ok = await human('POST', `/items/${id}/approve`, {});
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.json.item.status, ok.json.item.ideaApproval], ['approved', 'owner']);
  const edited = await agent('POST', `/items/${id}`, { title: 'The flat white, start to finish (reel)' });
  assert.equal(edited.json.item.status, 'idea', 'Claude changing an approved idea needs the owner to approve it again');
  await human('POST', `/items/${id}/approve`, {});
  const mine = await human('POST', `/items/${id}`, { time: '07:30', hook: null });
  assert.equal(mine.json.item.time, '07:30');
  assert.equal(mine.json.item.hook, undefined);
  assert.equal(mine.json.item.status, 'approved');
  assert.equal((await human('POST', `/items/${id}`, { status: 'idea' })).json.item.status, 'idea');
  const rej = await human('POST', `/items/${id}/reject`, { comment: 'Not this month' });
  assert.equal(rej.json.item.status, 'rejected');
  assert.match(rej.json.item.notes, /Not this month/);
  assert.equal((await human('POST', `/items/${id}/signoff`, {})).status, 409);
  assert.equal((await human('POST', `/items/${id}/explode`, {})).status, 404);
  assert.equal((await human('POST', `/items/nope/approve`, {})).status, 404);
  assert.equal((await human('POST', `/items/${id}`, { date: 'someday' })).status, 400);
});

test('the build loop over HTTP: approve, build, link, owner signs off or asks for changes', async () => {
  const id = 'seed-approved';
  assert.equal((await agent('POST', `/items/${id}/link`, { doc: 'no-such-doc' })).status, 404);
  const docs = readdirSync(join(projectDir, 'docs'));
  const doc = docs[0].replace(/\.json$/, '');
  const linked = await agent('POST', `/items/${id}/link`, { doc });
  assert.equal(linked.status, 200);
  assert.deepEqual([linked.json.item.status, linked.json.item.doc], ['built', doc]);
  assert.equal((await agent('POST', `/items/${id}/link`, {})).status, 400);
  assert.equal((await human('POST', `/items/${id}/changes`, {})).status, 400, 'a comment is required');
  const back = await human('POST', `/items/${id}/changes`, { comment: 'Use the cream background.' });
  assert.equal(back.json.item.status, 'changes');
  assert.equal(back.json.item.feedback[0].comment, 'Use the cream background.');
  assert.deepEqual((await agent('GET', '/due')).json.due.map((d) => [d.mode, d.item.id]), [['revise', id]]);
  await agent('POST', `/items/${id}/link`, { doc });
  assert.ok(onDisk(id).feedback[0].resolved);
  assert.equal((await human('POST', `/items/${id}/signoff`, {})).json.item.status, 'signed-off');
  assert.equal((await agent('POST', `/items/${id}/link`, { doc })).status, 409, 'Claude cannot rebuild a signed-off post');
  assert.equal((await agent('POST', `/items/${id}`, { title: 'Sneaky retitle' })).status, 409);
  assert.equal((await human('POST', `/items/${id}/posted`, {})).json.item.status, 'posted');
});

test('settings are the owner\'s; delegating approval makes Claude\'s ideas arrive approved', async () => {
  assert.equal((await human('POST', '/settings', { leadDays: 500 })).status, 400);
  assert.equal((await human('POST', '/settings', { colour: 'red' })).status, 400);
  const s = await human('POST', '/settings', { autoBuild: true, leadDays: 10, ideaApproval: 'delegated' });
  assert.equal(s.status, 200);
  assert.deepEqual([s.json.settings.autoBuild, s.json.settings.leadDays, s.json.settings.ideaApproval], [true, 10, 'delegated']);
  const r = await agent('POST', '/propose', { ideas: [{ ...IDEA, date: '2026-11-09', title: 'Cold brew on tap', idea: 'How the cold brew is steeped overnight in the back room.', hook: 'Cold brew, slowly.' }] });
  assert.deepEqual([r.json.added[0].status, r.json.added[0].ideaApproval], ['approved', 'delegated']);
  const ask = await agent('POST', '/propose', { ideas: [{ ...IDEA, date: '2026-11-11', title: 'Asking for approval', idea: 'A different thing about tamping.', hook: 'Tamp it.', status: 'approved' }] });
  assert.equal(ask.json.added.length, 1, 'delegated: an approved status is allowed and the same as the default');
  await human('POST', '/settings', { ideaApproval: null, autoBuild: null });
  assert.equal((await agent('GET', '')).json.effective.ideaApproval, 'owner');
  const all = await human('POST', '/approve-all', { month: '2026-10' });
  assert.equal(all.status, 200);
  assert.ok(all.json.items.every((i) => i.date.startsWith('2026-10')));
});

test('writes must be JSON, and the file on disk stays valid and tidy', async () => {
  const bad = await fetch(`${base}/items`, { method: 'POST', headers: { 'x-nordle-token': HUMAN, 'content-type': 'text/plain' }, body: 'title=x' });
  assert.equal(bad.status, 415);
  assert.equal((await human('POST', '/items', '{not json')).status, 400);
  assert.equal(validateCalendar(disk()).ok, true);
  assert.deepEqual(readdirSync(projectDir).filter((f) => f.includes('.tmp')), [], 'no temporary files left behind');
  assert.ok(!existsSync(join(projectDir, '.calendar.lock')));
  const ids = disk().items.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('PATCH is handled the same as POST on an item (the route supports it once the server lets the method through)', async () => {
  const sent = [];
  const id = disk().items.find((i) => i.status === 'idea')?.id ?? disk().items[0].id;
  const ctx = {
    req: {}, res: {}, url: new URL('http://127.0.0.1/api/projects/x/calendar/items/' + id), seg: ['projects', P, 'calendar', 'items', id], method: 'PATCH',
    project: { dir: projectDir }, human: false, readJsonBody: async () => ({ notes: 'Patched note' }), sendJson: (_res, status, body) => sent.push([status, body]),
    needHuman: () => { throw new Error('not for the agent'); }, HttpError: Error,
  };
  assert.notEqual(await calendarRoute.handle(ctx), false);
  assert.equal(sent[0][0], 200);
  assert.equal(sent[0][1].item.notes, 'Patched note');
  // and the agent, by PATCH, still cannot approve
  const ctx2 = { ...ctx, readJsonBody: async () => ({ status: 'approved' }), sendJson: (_res, status, body) => sent.push([status, body]) };
  await calendarRoute.handle(ctx2);
  assert.equal(sent[1][0], 403);
});

// ---- Claude's MCP tools, through the real client and server ------------------------------------------------------------

const tools = () => {
  const client = new NordleClient({ dir: runtimeDir, autostart: false });
  return new Map(createTools(client).map((t) => [t.name, t]));
};

test('MCP: the calendar tools exist, are described, and none of them can make an owner decision', () => {
  const all = tools();
  const names = ['nordle_calendar_get', 'nordle_calendar_propose', 'nordle_calendar_update', 'nordle_calendar_due', 'nordle_calendar_prompt', 'nordle_calendar_link', 'nordle_calendar_slots'];
  for (const n of names) {
    const t = all.get(n);
    assert.ok(t, n);
    assert.ok(t.description.length > 80, `${n} needs a real description`);
    assert.equal(t.inputSchema.type, 'object');
    assert.ok(t.annotations?.readOnlyHint || t.annotations?.destructiveHint === false);
  }
  assert.ok(![...all.keys()].some((n) => /calendar.*(approve|reject|signoff|sign_off|settings)/.test(n)), 'no tool for the owner\'s steps');
  assert.ok(all.get('nordle_calendar_propose').inputSchema.properties.ideas.items.additionalProperties === false);
  assert.ok(!('status' in all.get('nordle_calendar_propose').inputSchema.properties.ideas.items.properties), 'an idea has no status to set');
});

test('MCP: get, propose, update, due, prompt, link and slots work end to end', async () => {
  const all = tools();
  const use = async (name, args) => { const r = await all.get(name).handler(args); return r; };
  await human('POST', '/settings', { ideaApproval: null });
  const got = await use('nordle_calendar_get', { project: P, from: '2026-11-01', to: '2026-11-30' });
  assert.match(got.text, /2026-11/);
  assert.ok(Array.isArray(got.json.occasions) && got.json.months.length === 1 && got.json.effective.perMonth.reel === 2);

  const slots = await use('nordle_calendar_slots', { project: P, month: '2026-12' });
  assert.match(slots.text, /open slots/);
  assert.equal(slots.json.slots.length, 4);

  const prop = await use('nordle_calendar_propose', { project: P, ideas: [
    { date: '2026-12-02', format: 'carousel', title: 'Summer iced menu', pillar: 'drinks', idea: 'Four iced drinks, one real detail each, ready for the first hot week.', hook: 'Iced season starts here.', occasion: 'First day of summer' },
    { date: '2026-12-03', format: 'post', title: 'Our usual Christmas Eve hours', pillar: 'harbour', idea: 'A short note on Christmas Eve opening, using the hours the shop gives.', hook: 'Christmas Eve coffee.', occasion: 'Christmas Eve', notes: 'This one is wrong' },
    { date: '2026-12-03', format: 'post', title: 'A bold latte', pillar: 'drinks', idea: 'Latte art on the machine, step by step.', hook: 'Guaranteed to make you look twice.' },
  ] });
  assert.match(prop.text, /2 ideas? saved as "idea"|1 idea saved as "idea"|ideas? saved/);
  assert.match(prop.text, /waiting for the owner to approve/);
  assert.match(prop.text, /refused/);
  assert.match(prop.text, /banned-phrase: Contains "guaranteed"/);
  const id = loadCalendar(projectDir).items.find((i) => i.title === 'Summer iced menu').id;

  const upd = await use('nordle_calendar_update', { project: P, item: id, set: { hook: 'Iced season starts now.', time: '08:00' } });
  assert.match(upd.text, /Updated: .*Summer iced menu/);
  assert.match(upd.text, /still needs the owner's approval/);
  await assert.rejects(use('nordle_calendar_update', { project: P, item: id, set: { status: 'approved' } }), (e) => e instanceof NordleError && e.status === 403 || /Only the owner/.test(e.message));
  assert.equal(onDisk(id).status, 'idea');

  const noDue = await use('nordle_calendar_due', { project: P });
  assert.match(noDue.text, /Nothing is due|To do/);
  await human('POST', `/items/${id}/approve`, {});
  await human('POST', '/settings', { leadDays: 120 });
  const due = await use('nordle_calendar_due', { project: P });
  assert.match(due.text, /build: .*Summer iced menu/);

  const prompt = await use('nordle_calendar_prompt', { project: P, item: id });
  assert.match(prompt.text, /Build the carousel: "Summer iced menu"/);
  assert.match(prompt.text, new RegExp(`specs/${id}\\.json`));
  const propPrompt = await use('nordle_calendar_prompt', { project: P, month: '2026-12' });
  assert.match(propPrompt.text, /Plan the next posts: Little Gannet Coffee/);
  assert.ok(!propPrompt.text.includes('AHPRA'), 'a coffee shop is not given the health rules');

  const doc = readdirSync(join(projectDir, 'docs'))[0].replace(/\.json$/, '');
  const link = await use('nordle_calendar_link', { project: P, item: id, doc });
  assert.match(link.text, /Linked: .*built/);
  assert.match(link.text, /waiting for the owner's sign-off/);
  assert.equal(onDisk(id).status, 'built');
  await assert.rejects(use('nordle_calendar_link', { project: P, item: id, doc: 'missing' }), /no document/i);
  await human('POST', '/settings', { leadDays: 7 });
});
