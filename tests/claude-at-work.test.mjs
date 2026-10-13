// "Is Claude working on it?": a queued post says when it will be built, a post being built says Claude is on it (and since when), and the owner can start Claude
// from the Studio (Ask Claude now, Build it now) instead of pasting a prompt. A fake runner stands in for `claude`; nothing real is started.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadCalendar, saveCalendar } from '../src/calendar/model.mjs';
import { addDays } from '../src/calendar/dates.mjs';
import { acquireRunLock } from '../src/calendar/lock.mjs';
import { clearJobs, summarise } from '../src/calendar/jobs.mjs';
import { SIGNED_OUT_MESSAGE } from '../src/calendar/run.mjs';
import { AGENT, closeBrowser } from './helpers.mjs';
import { overview, studio, studioPage, TODAY } from './studio-helpers.mjs';

before(() => { process.env.NORDLE_TODAY = TODAY; });
after(async () => { await closeBrowser(); delete process.env.NORDLE_TODAY; });

const firstProject = async (call) => { const r = (await call('/projects')).body; return (r.projects ?? r)[0].id; };

/** Put one item of the project into the given state and return it. */
function setItem(work, project, patch, pick = (i) => (i.status === 'idea' || i.status === 'approved') && !i.doc && !i.external) {
  const dir = join(work, 'projects', project);
  const cal = loadCalendar(dir);
  const item = cal.items.find(pick);
  Object.assign(item, patch);
  saveCalendar(dir, cal);
  return { dir, item };
}

test('a queued post says when it starts, and when it is due; a post being built says whether Claude is really running', async () => {
  await studio(async ({ call, work }) => {
    const project = await firstProject(call);
    const far = setItem(work, project, { status: 'approved', date: '2026-12-20' });
    let posts = (await overview(call)).posts;
    const q = posts.find((p) => p.uid === `${project}:${far.item.id}`);
    assert.equal(q.build.phase, 'queued');
    assert.equal(q.build.active, false);
    assert.equal(q.build.due, false);
    assert.equal(q.build.startsOn, addDays('2026-12-20', -q.build.leadDays), 'the post date minus the lead time');

    const near = setItem(work, project, { status: 'approved', date: '2026-10-08' }, (i) => i.id !== far.item.id && !i.doc && !i.external);
    posts = (await overview(call)).posts;
    assert.equal(posts.find((p) => p.uid === `${project}:${near.item.id}`).build.due, true, 'its day has come');

    // being built, but nothing is running: stalled, in plain words
    const b = setItem(work, project, { status: 'building', run: { state: 'building', startedAt: '2026-10-05T01:00:00.000Z', attempts: 2 } }, (i) => i.id !== far.item.id && i.id !== near.item.id && !i.doc && !i.external);
    posts = (await overview(call)).posts;
    let built = posts.find((p) => p.uid === `${project}:${b.item.id}`);
    assert.equal(built.build.phase, 'building');
    assert.equal(built.build.active, false);
    assert.equal(built.build.stalled, true);

    // now a real run lock naming it (this test's own process is alive): Claude is on it
    const lock = acquireRunLock(b.dir, { mode: 'build', item: b.item.id });
    try {
      posts = (await overview(call)).posts;
      built = posts.find((p) => p.uid === `${project}:${b.item.id}`);
      assert.equal(built.build.active, true);
      assert.equal(built.build.stalled, false);
      assert.equal(built.build.attempt, 2);
      assert.ok(built.build.since, 'it says since when');
    } finally { lock.release(); }
  });
});

test('the run route: only the owner starts Claude; one job at a time; the answer is a plain status; a signed-out Claude says how to fix it', async () => {
  clearJobs();
  let release;
  const gate = new Promise((r) => { release = r; });
  const seen = [];
  const claudeRunner = {
    propose: async (o) => { seen.push(['propose', o.months, o.extra]); await gate; return { ran: [{ outcome: 'proposed', added: ['a', 'b', 'c'] }] }; },
    build: async (o) => { seen.push(['build', o.itemId]); return { ran: [{ outcome: 'failed', error: 'Failed to authenticate: OAuth session expired' }] }; },
  };
  await studio(async ({ call, work }) => {
    const project = await firstProject(call);
    const base = `/projects/${project}/calendar`;
    assert.equal((await call(`${base}/run`, 'POST', { action: 'propose' }, AGENT)).status, 403, 'Claude does not start Claude');
    assert.equal((await call(`${base}/run`, 'POST', { action: 'nope' })).status, 400);
    const started = await call(`${base}/run`, 'POST', { action: 'propose', months: ['2026-11', 'garbage'], extra: 'three reels about the team' });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    assert.equal(started.body.running.kind, 'propose');
    assert.deepEqual(seen[0], ['propose', ['2026-11'], 'three reels about the team'], 'only real months, and the owner\'s words, reach Claude');
    const again = await call(`${base}/run`, 'POST', { action: 'propose', months: ['2026-11'] });
    assert.equal(again.status, 409, 'exactly the same job twice is refused');
    assert.match(again.body.errors[0].message, /already doing exactly this/);
    assert.equal((await call(`${base}/run-status`)).body.running.kind, 'propose');
    release();
    for (let i = 0; i < 50 && (await call(`${base}/run-status`)).body.running; i++) await new Promise((r) => setTimeout(r, 40));
    const done = (await call(`${base}/run-status`)).body;
    assert.equal(done.running, null);
    assert.deepEqual([done.last.kind, done.last.outcome, done.last.added], ['propose', 'proposed', 3]);

    const { item } = setItem(work, project, { status: 'approved', date: '2026-10-09' });
    assert.equal((await call(`${base}/run`, 'POST', { action: 'build', item: 'no-such' })).status, 404);
    const built = await call(`${base}/run`, 'POST', { action: 'build', item: item.id });
    assert.equal(built.status, 202);
    for (let i = 0; i < 50 && (await call(`${base}/run-status`)).body.running; i++) await new Promise((r) => setTimeout(r, 40));
    const last = (await call(`${base}/run-status`)).body.last;
    assert.equal(last.kind, 'build');
    assert.equal(last.error, SIGNED_OUT_MESSAGE, 'a signed-out Claude says how to fix it, not the raw error');
    assert.deepEqual(seen[1], ['build', item.id]);
    setItem(work, project, { status: 'idea' }, (i) => i.id === item.id);
    assert.equal((await call(`${base}/run`, 'POST', { action: 'build', item: item.id })).status, 409, 'an idea is not waiting to be built');
  }, { claudeRunner });
});

test('summarise: a busy brand, a switched-off run and nothing-to-do are each said in words', () => {
  assert.equal(summarise({ locked: { pid: 1 } }).outcome, 'busy');
  assert.match(summarise({ enabled: false, reason: 'autoBuild is off' }).error, /autoBuild is off/);
  assert.equal(summarise({ ran: [] , due: [] }).outcome, 'nothing');
  assert.deepEqual(summarise({ ran: [{ outcome: 'built' }] }), { outcome: 'built', runs: 1 });
});

test('the Studio: a queued post shows its line and a Build it now button; "Ask Claude now" on the Create page shows Claude working, then what it added', async () => {
  clearJobs();
  let release;
  const gate = new Promise((r) => { release = r; });
  const claudeRunner = {
    propose: async () => { await gate; return { ran: [{ outcome: 'proposed', added: ['x', 'y'] }] }; },
    build: async () => ({ ran: [{ outcome: 'built' }] }),
  };
  await studioPage(async ({ page, open, call, work }) => {
    const project = await firstProject(call);
    const { item } = setItem(work, project, { status: 'approved', date: '2026-10-08' });
    await open(`#/s/month?today=${TODAY}`);
    const uid = `${project}:${item.id}`;
    await page.evaluate((u) => { location.hash = `#/s/list?today=2026-10-05&post=${encodeURIComponent(u)}`; }, uid);
    await page.waitForSelector('[data-act="build-now"]');
    assert.match(await page.locator('.build-line').first().innerText(), /Ready to build|Waiting its turn/);
    assert.equal(await page.locator('[data-act="build-now"]').count(), 1);

    await open(`#/s/create?today=${TODAY}&mode=advanced`);
    await page.waitForSelector('[data-act="create-run"]');
    await page.fill('[data-field="create-prompt"]', 'Two reels about the team');
    await page.locator('[data-act="create-run"]').click();
    await page.waitForSelector('.build-line[data-state="working"]');
    assert.match(await page.locator('.build-line').first().innerText(), /Claude is writing ideas/);
    assert.equal(await page.locator('[data-act="create-run"]').isDisabled(), true, 'one job at a time');
    release();
    await page.waitForSelector('.build-line[data-state="done"]', { timeout: 15000 });
    assert.match(await page.locator('.build-line[data-state="done"]').innerText(), /Claude added 2 ideas/);
  }, { claudeRunner });
});

test('while Claude is on a post: its picture loops with an animation, the top bar says so, and the animation stops when the run ends', async () => {
  clearJobs();
  await studioPage(async ({ page, open, call, work }) => {
    const project = await firstProject(call);
    const { dir, item } = setItem(work, project, { status: 'building', run: { state: 'building', startedAt: '2026-10-05T01:00:00.000Z', attempts: 1 } });
    const lock = acquireRunLock(dir, { mode: 'build', item: item.id });
    try {
      await open(`#/s/list?today=${TODAY}`);
      await page.waitForSelector('.th.working', { timeout: 20000 });
      assert.ok((await page.locator('.th.working .th-claude i').count()) >= 3, 'three dots loop on the picture');
      assert.equal(await page.locator('.th.working').first().evaluate((el) => getComputedStyle(el, '::after').animationName), 'nv-sweep', 'and a light sweeps across it, over and over');
      assert.match(await page.locator('.working .spin + span').first().innerText(), /Claude is building/);
      await page.evaluate((u) => { location.hash = `#/s/list?today=2026-10-05&post=${encodeURIComponent(u)}`; }, `${project}:${item.id}`);
      await page.waitForSelector('.build-line.live .dots');
      assert.equal(await page.locator('.build-line.live').evaluate((el) => getComputedStyle(el, '::after').animationName), 'nv-slide');
    } finally { lock.release(); }
    await page.evaluate(() => document.querySelector('.rn[data-view="list"], .rn')?.click());
    await open(`#/s/list?today=${TODAY}`);
    await page.waitForFunction(() => !document.querySelector('.th.working'), null, { timeout: 40000 });
  });
});
