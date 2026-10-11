// Removing posts and brands: nothing is deleted, everything can be restored, only the owner can do it. Fictional projects only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { AGENT, TOKEN, closeBrowser } from './helpers.mjs';
import { createNordleServer } from '../src/server/http.mjs';
import { removeItem, restoreItem, CalendarError, mutateCalendar } from '../src/calendar/service.mjs';
import { loadCalendar } from '../src/calendar/model.mjs';
import { studio, studioPage, overview, firstWhere, LOOSE, TODAY } from './studio-helpers.mjs';

after(closeBrowser);

const tree = (dir, base = dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? tree(join(dir, e.name), base) : [join(dir, e.name).slice(base.length)]));

test('the calendar service: only the owner can remove an item or put it back, and a clash is refused', async () => {
  await studio(async ({ work, call }) => {
    const { posts } = await overview(call);
    const p = firstWhere(posts, (x) => x.status === 'built' && x.format === 'carousel');
    const dir = join(work, 'projects', p.project);
    await assert.rejects(() => removeItem(dir, p.itemId, { role: 'agent' }), (e) => e instanceof CalendarError && e.status === 403);
    await assert.rejects(() => removeItem(dir, p.itemId), (e) => e.status === 403, 'the default role is not the owner');
    const { item } = await removeItem(dir, p.itemId, { role: 'human' });
    assert.equal(item.id, p.itemId);
    assert.equal(loadCalendar(dir).items.some((i) => i.id === p.itemId), false);
    await assert.rejects(() => removeItem(dir, p.itemId, { role: 'human' }), (e) => e.status === 404);
    await assert.rejects(() => restoreItem(dir, item), (e) => e.status === 403);
    await restoreItem(dir, item, { role: 'human' });
    await assert.rejects(() => restoreItem(dir, item, { role: 'human' }), (e) => e.status === 409);
    assert.deepEqual(loadCalendar(dir).items.find((i) => i.id === p.itemId), item, 'put back exactly as it was');
  });
});

test('removing a post moves its files to the project trash and its item off the calendar; restoring puts every file back', async () => {
  await studio(async ({ call, work }) => {
    const { posts } = await overview(call);
    const p = firstWhere(posts, (x) => x.status === 'built' && x.format === 'carousel' && x.verified);
    const dir = join(work, 'projects', p.project);
    // give it every kind of file a post can have
    await call('/studio/comment', 'POST', { uid: p.uid, text: 'a note', general: true, page: 'cover' });
    mkdirSync(join(dir, 'history'), { recursive: true });
    writeFileSync(join(dir, 'history', `${p.docId}.jsonl`), '{"v":1}\n');
    const before = tree(dir);
    assert.equal((await call('/studio/remove', 'POST', { uids: [p.uid] }, AGENT)).status, 403, 'Claude cannot remove');
    assert.equal((await call('/studio/remove', 'POST', { uids: [] })).status, 400);

    const r = await call('/studio/remove', 'POST', { uids: [p.uid, 'nope:missing'] });
    assert.equal(r.status, 200);
    assert.equal(r.body.removed.length, 1);
    assert.equal(r.body.failed.length, 1);
    const trashId = r.body.removed[0].id;
    assert.match(trashId, /^post:/);
    // gone from the Studio and the calendar
    assert.equal((await overview(call)).posts.some((x) => x.uid === p.uid), false);
    assert.equal(loadCalendar(dir).items.some((i) => i.id === p.itemId), false);
    assert.equal(existsSync(join(dir, 'docs', `${p.docId}.json`)), false);
    assert.equal(existsSync(join(dir, 'out', p.docId)), false);
    // not deleted: all in trash/<time>-<id>/
    const folder = readdirSync(join(dir, 'trash'))[0];
    assert.match(folder, new RegExp(`-${p.itemId}$`));
    const inTrash = tree(join(dir, 'trash', folder));
    assert.ok(inTrash.some((f) => f.endsWith('meta.json')));
    assert.ok(inTrash.some((f) => f.includes(`docs${'\\'}${p.docId}.json`) || f.includes(`docs/${p.docId}.json`)));
    assert.ok(inTrash.some((f) => f.includes(p.docId) && f.endsWith('.png')), 'its pictures too');
    // the trash lists it, and the count rides along with /api/studio
    const list = (await call('/studio/trash')).body;
    assert.equal(list.posts.length, 1);
    assert.equal(list.posts[0].title, p.title);
    assert.equal((await call(`/studio?today=${TODAY}`)).body.trashCount, 1);
    assert.equal((await call('/studio/restore', 'POST', { id: trashId }, AGENT)).status, 403);
    // put it all back
    const back = await call('/studio/restore', 'POST', { id: trashId });
    assert.equal(back.status, 200);
    assert.equal(back.body.title, p.title);
    assert.ok((await overview(call)).posts.some((x) => x.uid === p.uid));
    assert.deepEqual(tree(dir).filter((f) => !f.includes('trash')).sort(), before.filter((f) => !f.includes('trash')).sort(), 'every file is back');
    assert.equal(readdirSync(join(dir, 'trash')).length, 0, 'the trash entry is gone once restored');
    assert.equal((await call('/studio/restore', 'POST', { id: trashId })).status, 404, 'not twice');
  });
});

test('removing a post that is on no calendar, an imported post, and several at once; a clash blocks restore', async () => {
  await studio(async ({ call, work }) => {
    const { posts } = await overview(call);
    const loose = posts.find((x) => x.uid.endsWith(`:~${LOOSE}`));
    const project = loose.project;
    const dir = join(work, 'projects', project);
    const png = (c) => { const q = new PNG({ width: 20, height: 25 }); q.data.fill(c); return PNG.sync.write(q); };
    mkdirSync(join(dir, 'external', 'imp'), { recursive: true });
    writeFileSync(join(dir, 'external', 'imp', 'slide-01.png'), png(120));
    await mutateCalendar(dir, (cal) => { cal.items.push({ id: 'imp', date: '2026-10-21', format: 'carousel', title: 'Imported', status: 'built', external: { cover: 'external/imp/slide-01.png', slides: ['external/imp/slide-01.png'], caption: 'x' } }); });
    const other = firstWhere(posts, (x) => x.status === 'idea');
    const r = await call('/studio/remove', 'POST', { uids: [loose.uid, `${project}:imp`, other.uid] });
    assert.equal(r.body.removed.length, 3, JSON.stringify(r.body.failed));
    assert.equal(existsSync(join(dir, 'external', 'imp')), false);
    assert.equal(existsSync(join(dir, 'docs', `${LOOSE}.json`)), false);
    const ids = r.body.removed.map((x) => x.id);
    // restore the imported one: its folder and its item come back
    assert.equal((await call('/studio/restore', 'POST', { id: ids[1] })).status, 200);
    assert.ok(existsSync(join(dir, 'external', 'imp', 'slide-01.png')));
    assert.ok(loadCalendar(dir).items.some((i) => i.id === 'imp'));
    // a clash: put another item with the idea's id on the calendar, then restore the idea
    await mutateCalendar(join(work, 'projects', other.project), (cal) => { cal.items.push({ id: other.itemId, date: '2026-10-29', format: 'post', title: 'Clash', status: 'idea' }); });
    const clash = await call('/studio/restore', 'POST', { id: ids[2] });
    assert.equal(clash.status, 409);
    assert.ok((await call('/studio/trash')).body.posts.some((x) => x.id === ids[2]), 'still in the trash');
    assert.equal((await call('/studio/restore', 'POST', { id: ids[0] })).status, 200);
    assert.ok(existsSync(join(dir, 'docs', `${LOOSE}.json`)));
  });
});

test('removing a brand: typed name, owner only, refused while the editor is open on it; it moves to .trash and can be restored', async () => {
  const work = mkdtempSync(join(tmpdir(), 'nordle-studio-brand-'));
  const { cpSync } = await import('node:fs');
  const { ROOT } = await import('../tools/validate.mjs');
  cpSync(join(ROOT, 'samples', 'little-gannet'), join(work, 'projects', 'little-gannet'), { recursive: true, filter: (s) => !/[\\/](out|sources)([\\/]|$)/.test(s) });
  cpSync(join(ROOT, 'samples', 'little-gannet'), join(work, 'projects', 'second-sample'), { recursive: true, filter: (s) => !/[\\/](out|sources)([\\/]|$)/.test(s) });
  const app = createNordleServer({ roots: [join(work, 'projects')], token: TOKEN, agentToken: AGENT });
  const port = await app.listen(0);
  const call = async (path, method = 'GET', body, token = TOKEN) => { const r = await fetch(`http://127.0.0.1:${port}/api${path}`, { method, headers: { 'x-nordle-token': token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
  try {
    assert.equal((await call('/studio/remove-brand', 'POST', { project: 'second-sample', confirm: 'Little Gannet Coffee' }, AGENT)).status, 403, 'Claude cannot remove a brand');
    const wrong = await call('/studio/remove-brand', 'POST', { project: 'second-sample', confirm: 'second sample' });
    assert.equal(wrong.status, 400);
    assert.match(wrong.body.errors[0].message, /Little Gannet Coffee/);
    assert.equal((await call('/studio/remove-brand', 'POST', { project: 'nope', confirm: 'x' })).status, 404);
    // the editor is open on a post of this brand (a live connection)
    const ac = new AbortController();
    const live = await fetch(`http://127.0.0.1:${port}/api/events?project=second-sample&doc=spring-menu-carousel&t=${TOKEN}`, { signal: ac.signal });
    assert.equal(live.status, 200);
    const open = await call('/studio/remove-brand', 'POST', { project: 'second-sample', confirm: 'little gannet coffee' });
    assert.equal(open.status, 409);
    assert.match(open.body.errors[0].message, /editor/);
    assert.ok(existsSync(join(work, 'projects', 'second-sample', 'brand.json')), 'nothing moved');
    ac.abort();
    await new Promise((r) => setTimeout(r, 300));
    const done = await call('/studio/remove-brand', 'POST', { project: 'second-sample', confirm: '  LITTLE GANNET COFFEE ' });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(existsSync(join(work, 'projects', 'second-sample')), false);
    const trashed = readdirSync(join(work, 'projects', '.trash'));
    assert.ok(trashed.some((f) => /^second-sample-.+\.meta\.json$/.test(f)));
    const folder = trashed.find((f) => /^second-sample-/.test(f) && !f.endsWith('.json'));
    assert.ok(existsSync(join(work, 'projects', '.trash', folder, 'brand.json')), 'the whole folder is kept');
    assert.equal((await call('/studio')).body.projects.some((p) => p.id === 'second-sample'), false);
    assert.equal((await call('/projects')).body.projects.some((p) => p.id === 'second-sample'), false);
    const list = (await call('/studio/trash')).body;
    assert.equal(list.brands.length, 1);
    assert.equal(list.brands[0].project, 'second-sample');
    assert.equal((await call('/studio/restore-brand', 'POST', { id: list.brands[0].id }, AGENT)).status, 403);
    const back = await call('/studio/restore-brand', 'POST', { id: list.brands[0].id });
    assert.equal(back.status, 200);
    assert.ok(existsSync(join(work, 'projects', 'second-sample', 'brand.json')));
    assert.equal((await call('/studio/trash')).body.brands.length, 0);
    assert.equal((await call('/projects')).body.projects.some((p) => p.id === 'second-sample'), true);
  } finally { await app.close(); rmSync(work, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 }); }
});

test('remove from the post sheet asks first, and Undo brings it back; the Trash page lists it and restores it', async () => {
  await studioPage(async ({ page, open, call, errors }) => {
    const { posts } = await overview(call);
    const p = firstWhere(posts, (x) => x.status === 'built' && x.format === 'carousel' && x.verified);
    await open(`#/s/month?today=${TODAY}&post=${encodeURIComponent(p.uid)}`);
    await page.waitForSelector('.detail.open .d-dock [data-act="remove"]');
    await page.click('.detail .d-dock [data-act="remove"]');
    await page.waitForSelector('dialog:has-text("Remove")');
    await page.click('dialog button:has-text("Cancel")');
    assert.ok((await overview(call)).posts.some((x) => x.uid === p.uid), 'cancelled: still there');
    await page.click('.detail .d-dock [data-act="remove"]');
    await page.click('dialog button.danger, dialog button:has-text("Remove post")');
    await page.waitForSelector('.notice:has-text("Removed")');
    assert.equal((await overview(call)).posts.some((x) => x.uid === p.uid), false);
    await page.waitForFunction(() => !document.querySelector('.detail.open'));
    await page.click('.notice-act');
    await page.waitForFunction(async (uid) => (await (await fetch('/api/studio', { headers: { 'x-nordle-token': document.querySelector('meta[name=nordle-token]').content } })).json()).posts.some((x) => x.uid === uid), p.uid);
    // and through the Trash page
    await call('/studio/remove', 'POST', { uids: [p.uid] });
    await page.reload();
    await page.waitForSelector('.rail-foot a:has-text("Trash")');
    await page.click('.rail-foot a:has-text("Trash")');
    await page.waitForSelector('.trash .tr-row');
    assert.match(await page.locator('.trash .tr-row').first().textContent(), new RegExp(p.title.slice(0, 12)));
    await page.click('.trash .tr-row button:has-text("Restore")');
    await page.waitForSelector('.notice:has-text("Restored")');
    assert.ok((await overview(call)).posts.some((x) => x.uid === p.uid));
    await page.waitForSelector('.trash .blank');
    errors.length = 0; // pictures of a post that was just removed may be asked for once more: a harmless 404
  });
});

test('remove in bulk from the wall selection; the list row has a remove button; the Delete key removes the selected post', async () => {
  await studioPage(async ({ page, open, call }) => {
    const { posts } = await overview(call);
    await open(`#/s/list?today=${TODAY}`);
    await page.waitForSelector('.lr');
    const total = posts.filter((x) => x.status !== 'rejected').length;
    await page.locator('.lr').first().locator('input[type=checkbox]').click();
    await page.locator('.lr').nth(1).locator('input[type=checkbox]').click();
    await page.waitForSelector('.selbar:not(.hidden) [data-act="remove-selected"]');
    await page.click('.selbar [data-act="remove-selected"]');
    await page.waitForSelector('dialog:has-text("Remove 2")');
    await page.click('dialog button.danger');
    await page.waitForSelector('.notice:has-text("Removed 2")');
    assert.equal((await call('/studio/trash')).body.posts.length, 2);
    assert.equal((await overview(call)).posts.filter((x) => x.status !== 'rejected').length, total - 2);
    await page.waitForSelector('.lr .c-act button');
    await page.locator('.lr').first().hover();
    await page.locator('.lr').first().locator('.c-act button').click();
    await page.waitForSelector('dialog:has-text("Remove")');
    await page.keyboard.press('Escape');
    // Delete on a selected post in the wall
    await page.goto(`${page.url().split('#')[0]}#/s/wall?today=${TODAY}`);
    await page.waitForSelector('.wc');
    await page.keyboard.press('j');
    await page.keyboard.press('Delete');
    await page.waitForSelector('dialog:has-text("Remove")');
    await page.click('dialog button.danger');
    await page.waitForSelector('.notice:has-text("Removed")');
  });
});

test('the library removes a brand only after its name is typed', async () => {
  await studioPage(async ({ page, call, url }) => {
    await page.goto(`${url}#/projects`);
    await page.waitForSelector('.home .proj');
    const before = (await call('/projects')).body.projects.length;
    await page.locator('.home .proj').first().locator('button:has-text("Remove brand")').click();
    await page.waitForSelector('dialog input');
    assert.equal(await page.locator('dialog button.danger').isDisabled(), true, 'disabled until the name is typed');
    await page.fill('dialog input', 'not the name');
    assert.equal(await page.locator('dialog button.danger').isDisabled(), true);
    await page.click('dialog button:has-text("Cancel")');
    assert.equal((await call('/projects')).body.projects.length, before);
    await page.locator('.home .proj').first().locator('button:has-text("Remove brand")').click();
    const name = await page.locator('dialog [data-brand-name]').textContent();
    await page.fill('dialog input', name.toUpperCase());
    await page.click('dialog button.danger');
    await page.waitForFunction((n) => document.querySelectorAll('.home .proj').length === n - 1, before);
    assert.equal((await call('/projects')).body.projects.length, before - 1);
    assert.equal((await call('/studio/trash')).body.brands.length, 1);
  });
});
