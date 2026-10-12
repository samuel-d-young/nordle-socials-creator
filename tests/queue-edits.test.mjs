// Edits wait in line while Claude is working: a change asked for while a post is being built is kept, applied the moment the build is linked, and the designer
// then starts by itself. "Build it now" and the like retry while another run holds the brand. Nothing real is started: the designer is a fake that writes down what it was asked.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newCalendar, loadCalendar, saveCalendar } from '../src/calendar/model.mjs';
import * as S from '../src/calendar/service.mjs';
import { retryWhileLocked } from '../src/calendar/jobs.mjs';
import { createReviser } from '../src/studio/revise.mjs';
import { Store } from '../src/server/store.mjs';
import { closeBrowser } from './helpers.mjs';
import { firstWhere, overview, studioPage, TODAY, verifiedBuilt } from './studio-helpers.mjs';

const base = mkdtempSync(join(tmpdir(), 'nordle-qedits-'));
before(() => { process.env.NORDLE_TODAY = '2026-10-05'; });
after(async () => { await closeBrowser(); rmSync(base, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }); delete process.env.NORDLE_TODAY; });

const BRAND = { schema: 'nordle.brand/0.1', id: 'x', name: 'Harbour Bakery', colors: { ink: '#111111', paper: '#ffffff' }, fonts: { display: { family: 'Inter', weights: [400], source: 'google' } }, voice: { tone: ['warm'] } };
let n = 0;
function project() {
  const id = `qe-${++n}`;
  const dir = join(base, id);
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'brand.json'), JSON.stringify({ ...BRAND, id }));
  writeFileSync(join(dir, 'facts.json'), JSON.stringify({ staff: [] }));
  saveCalendar(dir, newCalendar(id));
  return dir;
}
const setStatus = (dir, id, patch) => { const cal = loadCalendar(dir); Object.assign(cal.items.find((i) => i.id === id), patch); saveCalendar(dir, cal); };

test('a change asked for while the post is being built waits, is applied when the build is linked, and is started once', async () => {
  const dir = project();
  const item = (await S.addItems(dir, [{ date: '2026-11-09', format: 'carousel', title: 'First visit', idea: 'x', hook: 'x' }], { role: 'human' })).added[0];
  setStatus(dir, item.id, { status: 'building' });
  await S.decide(dir, item.id, 'changes', { comment: 'Make the headline shorter' });
  await S.decide(dir, item.id, 'changes', { comment: 'And use the blue photo' });
  let now = loadCalendar(dir).items[0];
  assert.equal(now.status, 'building', 'the build is not disturbed');
  assert.deepEqual(now.pendingChanges.map((p) => p.comment), ['Make the headline shorter', 'And use the blue photo']);
  await assert.rejects(S.decide(dir, item.id, 'changes', { comment: '  ' }), /comment is required/);
  // Claude finishes the build and links it
  writeFileSync(join(dir, 'docs', 'first-visit.json'), '{}');
  await S.linkDoc(dir, item.id, 'first-visit');
  now = loadCalendar(dir).items[0];
  assert.equal(now.status, 'changes', 'it goes straight back for the waiting changes');
  assert.equal(now.pendingChanges, undefined);
  assert.deepEqual(now.feedback.filter((f) => !f.resolved).map((f) => f.comment), ['Make the headline shorter', 'And use the blue photo']);
  assert.equal(now.queuedRevise, true);
  assert.deepEqual(await S.takeQueuedRevisions(dir), [item.id]);
  assert.deepEqual(await S.takeQueuedRevisions(dir), [], 'each is started once');
  // a build with nothing waiting is as before
  const plain = (await S.addItems(dir, [{ date: '2026-11-10', format: 'post', title: 'Plain', idea: 'x', hook: 'x' }], { role: 'human' })).added[0];
  setStatus(dir, plain.id, { status: 'building' });
  writeFileSync(join(dir, 'docs', 'plain.json'), '{}');
  await S.linkDoc(dir, plain.id, 'plain');
  assert.equal(loadCalendar(dir).items.find((i) => i.id === plain.id).status, 'built');
});

test('the designer starts by itself on a post whose waiting changes were just applied', async () => {
  const dir = project();
  const item = (await S.addItems(dir, [{ date: '2026-11-09', format: 'carousel', title: 'Wait for it', idea: 'x', hook: 'x' }], { role: 'human' })).added[0];
  setStatus(dir, item.id, { status: 'building' });
  await S.decide(dir, item.id, 'changes', { comment: 'Warmer please' });
  writeFileSync(join(dir, 'docs', 'wait-for-it.json'), '{}');
  await S.linkDoc(dir, item.id, 'wait-for-it');
  const asked = [];
  const reviser = createReviser({ run: async (o) => { asked.push(o.itemId); return { ran: [{ outcome: 'built' }] }; }, retryMs: 1, log: () => {} });
  const store = new Store({ roots: [base] });
  const started = await reviser.sweep(store);
  assert.deepEqual(started, [`${dir.split(/[\\/]/).pop()}:${item.id}`]);
  await reviser.idle();
  assert.deepEqual(asked, [item.id]);
  assert.deepEqual(await reviser.sweep(store), [], 'nothing left to start');
});

test('retryWhileLocked waits its turn while another run holds the brand, and gives up after a while', async () => {
  const waits = [];
  let calls = 0;
  const r = await retryWhileLocked(async () => (++calls < 4 ? { locked: { pid: 1 } } : { ran: [{ outcome: 'built' }] }), { ms: 7, sleep: async (t) => { waits.push(t); } });
  assert.deepEqual([calls, waits, r.ran[0].outcome], [4, [7, 7, 7], 'built']);
  let n2 = 0;
  const never = await retryWhileLocked(async () => { n2 += 1; return { locked: { pid: 1 } }; }, { ms: 0, max: 3, sleep: async () => {} });
  assert.deepEqual([n2, !!never.locked], [4, true]);
});

test('in the Studio: a building post offers "Queue a change", and asking is accepted (not refused) and shown as queued', async () => {
  await studioPage(async ({ page, open, call, work }) => {
    const post = firstWhere((await overview(call)).posts, verifiedBuilt);
    const dir = join(work, 'projects', post.project);
    setStatus(dir, post.itemId, { status: 'building' });
    await open(`#/s/month?today=${TODAY}&post=${encodeURIComponent(post.uid)}&month=${post.date.slice(0, 7)}`);
    await page.waitForSelector('.detail.open [data-act="changes-queue"]');
    const r = await call('/studio/act', 'POST', { uid: post.uid, action: 'changes', text: 'Use a warmer headline' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.queued, true);
    const item = loadCalendar(dir).items.find((i) => i.id === post.itemId);
    assert.deepEqual([item.status, item.pendingChanges.length], ['building', 1]);
    assert.match(item.pendingChanges[0].comment, /Use a warmer headline/);
    const again = (await overview(call)).posts.find((p) => p.uid === post.uid);
    assert.equal(again.build.pending, 1, 'the post says a change is queued');
  });
});

test('while Claude works on the Create page, going to another page stays there: the page is never painted back to Create by itself', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const claudeRunner = { propose: async () => { await gate; return { ran: [{ outcome: 'proposed', added: ['a'] }] }; }, build: async () => ({ ran: [] }) };
  await studioPage(async ({ page, open }) => {
    await open(`#/s/create?today=${TODAY}`);
    await page.waitForSelector('[data-act="create-run"]');
    await page.locator('[data-act="create-run"]').click();
    await page.waitForSelector('.build-line[data-state="working"]');
    await page.evaluate(() => { location.hash = '#/s/month?today=2026-10-05'; });
    await page.waitForSelector('.view.v-month');
    await page.waitForTimeout(3800);   // longer than the job check (3 s): this is when it used to jump back
    assert.equal(await page.locator('.create').count(), 0, 'Create was not painted back');
    assert.equal(await page.evaluate(() => document.querySelector('.view')?.className.includes('v-month')), true);
    release();
    await page.waitForTimeout(3800);   // the job finishing is not a reason to move either
    assert.equal(await page.locator('.create').count(), 0);
    assert.match(await page.evaluate(() => location.hash), /\/s\/month/);
    await page.evaluate(() => { location.hash = '#/s/create?today=2026-10-05'; });
    await page.waitForSelector('.create');   // and it is there when asked for, with the result
  }, { claudeRunner });
});
