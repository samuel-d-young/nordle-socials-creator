// "Request changes" does the change: the Studio starts the designer on a post the moment the owner sends it back.
// The designer is the headless runner (src/calendar/run.mjs); here it is a fake, so no test starts a real Claude.
//   node --test tests/studio-revise.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../tools/validate.mjs';
import { newCalendar, saveCalendar, loadCalendar } from '../src/calendar/model.mjs';
import { mutateCalendar } from '../src/calendar/service.mjs';
import { runDue } from '../src/calendar/run.mjs';
import { buildPrompt } from '../src/calendar/prompts.mjs';
import { createReviser } from '../src/studio/revise.mjs';
import { AGENT, closeBrowser } from './helpers.mjs';
import { LOOSE, TODAY, studio, studioPage, overview } from './studio-helpers.mjs';

after(closeBrowser);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sendBack = (call, uid, text = 'Make the headline shorter.') => call('/studio/act', 'POST', { uid, action: 'changes', text });
const builtOnCalendar = (posts) => posts.filter((p) => p.status === 'built' && p.calendar && p.docId);
const done = (o, outcome = 'built') => ({ ran: [{ id: o.itemId, mode: 'revise', outcome }] });
const quiet = () => {};

// ---- the Studio starts the designer ------------------------------------------------------------------------------------

test('Request changes starts the designer on that post at once, without waiting for autoBuild or a daily run', async () => {
  const calls = [];
  const reviser = createReviser({ run: async (o) => { calls.push(o); return done(o); }, log: quiet });
  await studio(async ({ call, calendarOf }) => {
    const { posts } = await overview(call);
    const post = builtOnCalendar(posts)[0];
    const r = await sendBack(call, post.uid);
    assert.equal(r.status, 200);
    assert.equal(r.body.revising, true, 'the answer says the designer is on it');
    assert.equal(r.body.post.status, 'changes');
    await reviser.idle();
    assert.equal(calls.length, 1, 'one run, for that post only');
    assert.equal(calls[0].itemId, post.itemId);
    assert.equal(calls[0].yes, true, 'the owner just asked: autoBuild is not consulted');
    assert.ok(calls[0].projectDir.endsWith(post.project), 'in that post\'s own project');
    assert.equal(calendarOf(post.project).items.find((i) => i.id === post.itemId).status, 'changes', 'the fake designer changed nothing');
    // Claude's own token cannot send a post back, so it can never start a run this way
    const again = await call('/studio/act', 'POST', { uid: post.uid, action: 'changes', text: 'x' }, AGENT);
    assert.equal(again.status, 403);
    assert.equal(calls.length, 1);
  }, { reviser });
});

test('the owner can turn it off per brand (autoRevise): the post is just sent back, and the Studio says so', async () => {
  const calls = [];
  const reviser = createReviser({ run: async (o) => { calls.push(o); return done(o); }, log: quiet });
  await studio(async ({ call }) => {
    const { posts } = await overview(call);
    const post = builtOnCalendar(posts)[0];
    assert.equal(post.autoRevise, true, 'on unless the owner says otherwise');
    const set = await call(`/projects/${post.project}/calendar/settings`, 'POST', { autoRevise: false });
    assert.equal(set.status, 200);
    assert.equal(set.body.settings.autoRevise, false);
    const r = await sendBack(call, post.uid);
    assert.deepEqual([r.status, r.body.revising, r.body.reviseReason], [200, false, 'off']);
    await reviser.idle();
    assert.equal(calls.length, 0);
    assert.equal((await overview(call)).posts.find((p) => p.uid === post.uid).autoRevise, false);
    // Claude's token still cannot flip it
    assert.equal((await call(`/projects/${post.project}/calendar/settings`, 'POST', { autoRevise: true }, AGENT)).status, 403);
  }, { reviser });
});

test('a post that is not on a calendar has nothing for the designer to revise: it is only sent back', async () => {
  const calls = [];
  const reviser = createReviser({ run: async (o) => { calls.push(o); return done(o); }, log: quiet });
  await studio(async ({ call }) => {
    const { posts } = await overview(call);
    const loose = posts.find((p) => p.uid.endsWith(`:~${LOOSE}`));
    const r = await sendBack(call, loose.uid);
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.revising, r.body.reviseReason], [false, 'no-post']);
    assert.equal(calls.length, 0);
  }, { reviser });
});

test('a server without a designer (the plain test server) just records the request', async () => {
  await studio(async ({ call }) => {
    const { posts } = await overview(call);
    const r = await sendBack(call, builtOnCalendar(posts)[0].uid);
    assert.equal(r.status, 200);
    assert.equal(r.body.revising, undefined);
  });
});

test('one revision at a time per project, in the order they were asked; a project another process holds is retried', async () => {
  let active = 0, peak = 0, n = 0;
  const order = [];
  const reviser = createReviser({
    retryMs: 5,
    log: quiet,
    run: async (o) => {
      if (++n === 1) return { locked: { pid: 1 }, ran: [] };         // the first attempt finds somebody else's run in the project
      active++; peak = Math.max(peak, active); order.push(o.itemId);
      await sleep(30);
      active--;
      return done(o);
    },
  });
  await studio(async ({ call }) => {
    const { posts } = await overview(call);
    const byProject = new Map();
    for (const p of builtOnCalendar(posts)) byProject.set(p.project, [...(byProject.get(p.project) ?? []), p]);
    const two = [...byProject.values()].find((l) => l.length >= 2).slice(0, 2);
    for (const p of two) assert.equal((await sendBack(call, p.uid)).body.revising, true);
    await reviser.idle();
    assert.equal(peak, 1, 'never two at once in one project');
    assert.deepEqual(order, two.map((p) => p.itemId), 'first asked, first changed');
    assert.equal(n, 3, 'one locked attempt, then both ran');
  }, { reviser });
});

test('Undo takes the request back and stops the designer', async () => {
  let aborted = false, started;
  const begun = new Promise((r) => { started = r; });
  const reviser = createReviser({
    log: quiet,
    run: async (o) => { started(); await new Promise((res) => o.signal.addEventListener('abort', res, { once: true })); aborted = true; return done(o, 'cancelled'); },
  });
  await studio(async ({ call, calendarOf }) => {
    const { posts } = await overview(call);
    const post = builtOnCalendar(posts)[0];
    const r = await sendBack(call, post.uid);
    await begun;
    assert.equal(reviser.running(post.uid), true);
    const undone = await call('/studio/act', 'POST', { action: 'undo', tokens: [r.body.undo] });
    assert.equal(undone.status, 200);
    await reviser.idle();
    assert.equal(aborted, true, 'the designer was told to stop');
    assert.equal(reviser.running(post.uid), false);
    assert.equal(calendarOf(post.project).items.find((i) => i.id === post.itemId).status, 'built', 'the post is back as it was');
  }, { reviser });
});

// ---- what the Studio shows ----------------------------------------------------------------------------------------------

const setItem = (work, project, id, fn) => mutateCalendar(join(work, 'projects', project), (cal) => { fn(cal.items.find((i) => i.id === id)); });

test('while the designer works, the post says so and cannot be approved, and a second change waits in line; when it fails, the reason shows', async () => {
  await studio(async ({ call, work }) => {
    const { posts } = await overview(call);
    const post = builtOnCalendar(posts)[0];
    await setItem(work, post.project, post.itemId, (it) => { it.status = 'building'; it.run = { attempts: 1, startedAt: new Date().toISOString(), state: 'building' }; });
    const now = (await overview(call)).posts.find((p) => p.uid === post.uid);
    assert.deepEqual([now.status, now.revising], ['building', true]);
    const sheet = await call(`/studio/post?uid=${encodeURIComponent(post.uid)}`);
    assert.equal(sheet.body.item.run.state, 'building');
    // approving is still refused while Claude works on it; asking for another change is accepted and waits in line (it starts by itself when the work is done)
    const approve = await call('/studio/act', 'POST', { uid: post.uid, action: 'approve', text: 'again' });
    assert.equal(approve.status, 409, 'approve');
    assert.match(approve.body.errors[0].message, /Claude is (still|already) changing/);
    const queued = await call('/studio/act', 'POST', { uid: post.uid, action: 'changes', text: 'again' });
    assert.equal(queued.status, 200, JSON.stringify(queued.body));
    assert.equal(queued.body.queued, true);
    await setItem(work, post.project, post.itemId, (it) => { it.status = 'changes'; it.run = { attempts: 1, state: 'failed', lastError: 'Claude finished (exit 1) without building the post.', lastAt: new Date().toISOString() }; });
    const failed = (await overview(call)).posts.find((p) => p.uid === post.uid);
    assert.deepEqual([failed.status, failed.revising, failed.reviseFailed], ['changes', false, true]);
  });
});

test('the post sheet shows "Claude is changing this post now", then the failure with a way to try again', async () => {
  await studioPage(async ({ call, open, page, work }) => {
    const { posts } = await overview(call);
    const post = builtOnCalendar(posts).find((p) => p.date);
    // (a reload each time: opening the same address again is not always a new page, and the state was changed behind the page's back)
    const go = async () => { await open(`#/s/month?today=${TODAY}&post=${encodeURIComponent(post.uid)}&month=${post.date.slice(0, 7)}`); await page.reload(); await page.waitForSelector('.studio', { state: 'visible' }); await page.waitForSelector('.detail.open'); };
    await sendBack(call, post.uid, 'Shorter headline please.');
    await go();
    assert.match(await page.locator('.detail [data-state="waiting"]').innerText(), /Claude starts on it as soon as it is free/);
    assert.match(await page.locator('.detail .sent-note').innerText(), /Shorter headline/, 'what was asked stays in view');

    await setItem(work, post.project, post.itemId, (it) => { it.status = 'building'; it.run = { attempts: 1, startedAt: new Date().toISOString(), state: 'building' }; });
    await go();
    assert.match(await page.locator('.detail [data-state="revising"]').innerText(), /Claude is changing this post now/);
    assert.equal(await page.locator('.detail [data-act="approve"]').count(), 0, 'nothing to approve while it is being changed');

    await setItem(work, post.project, post.itemId, (it) => { it.status = 'changes'; it.run = { attempts: 3, state: 'gave-up', lastError: 'Timed out after 25 minutes.' }; });
    await go();
    const failed = page.locator('.detail [data-state="failed"]');
    assert.match(await failed.innerText(), /Claude could not make that change: Timed out after 25 minutes\. Press Ask again/);
    assert.match(await page.locator('.detail [data-act="changes"]').innerText(), /Ask again/);
  }, { viewport: { width: 1440, height: 900 } });
});

// ---- the runner: stopping it, and what it is told ------------------------------------------------------------------------

test('an abort signal stops the headless run and leaves the calendar alone', async () => {
  await studio(async ({ call, work }) => {
    const { posts } = await overview(call);
    const post = builtOnCalendar(posts)[0];
    await sendBack(call, post.uid);
    const killed = [];
    const spawn = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = { on() {}, end() {} };
      child.kill = () => { killed.push(true); setImmediate(() => child.emit('close', null, 'SIGKILL')); };
      return child;
    };
    const controller = new AbortController();
    const running = runDue({ projectDir: join(work, 'projects', post.project), itemId: post.itemId, yes: true, spawn, exec: async () => ({ code: 0, stdout: '', stderr: '' }), validate: false, signal: controller.signal, log: quiet });
    await sleep(60);
    controller.abort();
    const r = await running;
    assert.deepEqual(r.ran.map((x) => x.outcome), ['cancelled']);
    assert.ok(killed.length >= 1, 'the child was killed');
  });
});

test('when Claude Code is not signed in, the post says how to fix it instead of a raw OAuth error, and the rest are not tried', async () => {
  await studio(async ({ call, work, calendarOf }) => {
    const { posts } = await overview(call);
    const [a, b] = builtOnCalendar(posts).filter((p) => p.date);
    await sendBack(call, a.uid);
    const spawn = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = { on() {}, end() {} };
      child.kill = () => {};
      setImmediate(() => { child.stdout.emit('data', JSON.stringify({ type: 'result', is_error: true, result: 'Failed to authenticate: OAuth session expired and could not be refreshed' })); child.emit('close', 1, null); });
      return child;
    };
    await sleep(1100); // a post written in the last second before a revise starts counts as the revise's own work (src/calendar/run.mjs settle)
    const r = await runDue({ projectDir: join(work, 'projects', a.project), itemId: a.itemId, yes: true, spawn, exec: async () => ({ code: 0, stdout: '', stderr: '' }), validate: false, log: quiet });
    assert.deepEqual(r.ran.map((x) => x.outcome), ['signed-out']);
    assert.match(r.ran[0].error, /not signed in on this computer.*claude auth login/);
    const item = calendarOf(a.project).items.find((i) => i.id === a.itemId);
    assert.equal(item.status, 'changes', 'put back, not left on building');
    assert.match(item.run.lastError, /claude auth login/);
    const shown = (await overview(call)).posts.find((p) => p.uid === a.uid);
    assert.equal(shown.reviseFailed, true);
    void b;
  });
});

test('the revise brief sends Claude to the project\'s own build helper, never a plain build, and to the reel command for a reel', () => {
  const work = mkdtempSync(join(tmpdir(), 'nordle-revise-prompt-'));
  try {
    const dir = join(work, 'projects', 'little-gannet');
    cpSync(join(ROOT, 'samples', 'little-gannet'), dir, { recursive: true, filter: (s) => !/[\\/](out|sources)([\\/]|$)/.test(s) });
    const fb = [{ at: '2026-10-04T10:00:00Z', by: 'owner', comment: 'Pinned notes:\n- cover: Change this photo' }];
    saveCalendar(dir, {
      ...newCalendar('little-gannet'), timezone: 'Australia/Melbourne',
      items: [
        { id: 'a-carousel', date: '2026-10-20', format: 'carousel', title: 'A carousel', status: 'changes', doc: 'a-carousel', feedback: fb, idea: 'Three pours.', hook: 'Three pours.' },
        { id: 'a-reel', date: '2026-10-21', format: 'reel', title: 'A reel', status: 'changes', doc: 'a-reel', feedback: fb, idea: 'One pour.', hook: 'One pour.' },
      ],
    });
    mkdirSync(join(dir, 'specs'), { recursive: true });
    writeFileSync(join(dir, 'specs', '_go.mjs'), '// node projects/little-gannet/specs/_go.mjs <doc id>\n// build -> house look -> validate\n');
    writeFileSync(join(dir, 'specs', 'a-carousel.json'), '{}');
    writeFileSync(join(dir, 'specs', 'a-reel.json'), '{}');
    const carousel = buildPrompt(dir, 'a-carousel', { today: '2026-10-05' });
    assert.match(carousel, /do NOT run `nordle build`/);
    assert.ok(carousel.includes('`specs/_go.mjs`: `node projects/little-gannet/specs/_go.mjs <doc id>`'), 'the helper and how to run it');
    assert.ok(carousel.includes('specs/a-carousel.json'), 'the existing spec is edited, not rewritten');
    assert.ok(!/nordle\.mjs" build "/.test(carousel), 'no plain build command is offered');
    assert.match(carousel, /smallest change/);
    assert.match(carousel, /do NOT invent or substitute/);
    const reel = buildPrompt(dir, 'a-reel', { today: '2026-10-05' });
    assert.match(reel, /nordle\.mjs" reel ".*a-reel\.json" --render/);
    assert.match(reel, /never with `build`/);
    // a build from nothing is unchanged: it still gets the stock build
    const fresh = buildPrompt(dir, 'a-carousel', { mode: 'build', today: '2026-10-05' });
    assert.ok(fresh.includes('specs/_go.mjs'), 'a house-look project is never built plainly, even from an idea');
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  }
});

test('an imported post (made outside Nordle) that was sent back and redone goes back for another look, with its comments ticked', async () => {
  await studio(async ({ call, work, calendarOf }) => {
    const { posts } = await overview(call);
    const a = builtOnCalendar(posts)[0];
    const dir = join(work, 'projects', a.project);
    await mutateCalendar(dir, (cal) => {
      const it = cal.items.find((i) => i.id === a.itemId);
      delete it.doc;
      it.external = { source: 'elsewhere', cover: 'external/x/cover.jpg', video: 'external/x/x.mp4', caption: 'A caption.' };
      it.status = 'changes';
      it.feedback = [{ at: '2026-10-04T10:00:00Z', by: 'owner', comment: 'Pinned notes:\n- video 0:06: Add a picture of a toothbrush here' }];
    });
    const { linkDoc } = await import('../src/calendar/service.mjs');
    await assert.rejects(linkDoc(dir, a.itemId, 'no-such-doc'), (e) => e.status === 404 || e.status === 400, 'a document id is still checked when one is given');
    const r = await linkDoc(dir, a.itemId);
    assert.deepEqual([r.item.status, r.item.run.state], ['built', 'built']);
    assert.ok(r.item.feedback.every((f) => f.resolved), 'the owner\'s note is ticked off');
    assert.equal(calendarOf(a.project).items.find((i) => i.id === a.itemId).status, 'built');
    await assert.rejects(linkDoc(dir, a.itemId), (e) => e.status === 409, 'only a sent-back imported post can be taken back this way');
  });
});

test('calendar watch prints a line the moment a post is sent back (and again if it is sent back again), but not for old requests', async () => {
  const work = mkdtempSync(join(tmpdir(), 'nordle-watch-'));
  const controller = new AbortController();
  try {
    const dir = join(work, 'projects', 'little-gannet');
    cpSync(join(ROOT, 'samples', 'little-gannet'), dir, { recursive: true, filter: (s) => !/[\\/](out|sources)([\\/]|$)/.test(s) });
    const item = (id, status, feedback = []) => ({ id, date: '2026-10-20', format: 'carousel', title: id, status, doc: status === 'built' || status === 'changes' ? id : undefined, feedback, idea: 'x.', hook: 'x.' });
    const owner = (comment) => ({ at: '2026-10-04T10:00:00Z', by: 'owner', comment });
    const write = (items) => saveCalendar(dir, { ...newCalendar('little-gannet'), timezone: 'Australia/Melbourne', items });
    write([item('old', 'changes', [owner('Pinned notes:\n- cover: old ask')]), item('fresh', 'built')]);
    const lines = [];
    const { watchSentBack } = await import('../src/calendar/watch.mjs');
    const watching = watchSentBack({ roots: [join(work, 'projects')], every: 0.05, out: (l) => lines.push(l), signal: controller.signal });
    await sleep(200);
    assert.deepEqual(lines, ['WATCHING all projects for posts sent back (every 0.05s)'], 'the request that was already waiting is not announced');
    write([item('old', 'changes', [owner('Pinned notes:\n- cover: old ask')]), item('fresh', 'changes', [owner('Pinned notes:\n- cover: Change this photo\n- cta: Nicer wording')])]);
    await sleep(300);
    assert.deepEqual(lines.slice(1), ['SENT-BACK little-gannet fresh doc=fresh | cover: Change this photo | cta: Nicer wording']);
    write([item('old', 'changes', [owner('Pinned notes:\n- cover: old ask')]), item('fresh', 'built', [owner('x')])]);       // the designer finished it
    await sleep(200);
    write([item('old', 'changes', [owner('Pinned notes:\n- cover: old ask')]), item('fresh', 'changes', [owner('x'), owner('Make it shorter')])]);
    await sleep(300);
    assert.equal(lines.length, 3, 'sent back again: announced again');
    assert.match(lines[2], /fresh doc=fresh \| Make it shorter/);
    controller.abort();
    await watching;
  } finally {
    controller.abort();
    rmSync(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  }
});

test('after a restart, a revision the dead server left half-done is put back and started again; old requests are not', async () => {
  const calls = [];
  const reviser = createReviser({ run: async (o) => { calls.push(o.itemId); return done(o); }, log: quiet });
  await studio(async ({ call, work }) => {
    const { posts } = await overview(call);
    const [a, b] = builtOnCalendar(posts).filter((p) => p.date);
    await sendBack(call, a.uid);
    await sendBack(call, b.uid);
    await reviser.idle();
    calls.length = 0;
    // `a` was being changed when the server died; `b` was sent back long ago and never started
    await setItem(work, a.project, a.itemId, (it) => { it.status = 'building'; it.run = { attempts: 1, startedAt: '2026-10-05T00:00:00.000Z', state: 'building' }; });
    const { Store } = await import('../src/server/store.mjs');
    const store = new Store({ roots: [join(work, 'projects')] });
    const again = await reviser.recover(store);
    await reviser.idle();
    assert.deepEqual(again, [a.uid]);
    assert.deepEqual(calls, [a.itemId], 'only the interrupted one');
    assert.equal(loadCalendar(join(work, 'projects', b.project)).items.find((i) => i.id === b.itemId).status, 'changes', 'the old request waits for the owner\'s click or a daily run');
  }, { reviser });
});
