// Deleting from the trash for good (src/studio/trash.mjs deleteFromTrash / emptyTrash, POST /api/studio/trash-delete, the Trash page): only the owner, only what is
// in the trash, one thing or all of it, asked first, and a live post or brand is never reachable. Fictional projects only.
//   node --test tests/studio-trash-delete.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT, closeBrowser } from './helpers.mjs';
import { studio, studioPage, overview, firstWhere, TODAY } from './studio-helpers.mjs';

after(closeBrowser);

const trashDirs = (work, project) => { try { return readdirSync(join(work, 'projects', project, 'trash')); } catch { return []; } };

test('a post in the trash can be deleted for good; its files go, nothing else does, and only the owner can do it', async () => {
  await studio(async ({ call, work }) => {
    const { posts } = await overview(call);
    const [a, b] = posts.filter((x) => x.status === 'built' && x.format === 'carousel' && x.docId).slice(0, 2);
    const removed = (await call('/studio/remove', 'POST', { uids: [a.uid, b.uid] })).body.removed;
    assert.equal(removed.length, 2);
    const before = (await call('/studio/trash')).body;
    assert.equal(before.posts.length, 2);
    assert.equal(trashDirs(work, a.project).length >= 1, true);

    assert.equal((await call('/studio/trash-delete', 'POST', { ids: [removed[0].id] }, AGENT)).status, 403, 'Claude cannot delete from the trash');
    assert.equal((await call('/studio/trash-delete')).status, 405);
    assert.equal((await call('/studio/trash-delete', 'POST', {})).status, 400);
    assert.equal((await call('/studio/trash')).body.posts.length, 2, 'the refused calls deleted nothing');

    const r = await call('/studio/trash-delete', 'POST', { ids: [removed[0].id] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.deleted.map((d) => [d.id, d.kind, d.title]), [[removed[0].id, 'post', removed[0].title]]);
    assert.deepEqual(r.body.failed, []);
    const after = (await call('/studio/trash')).body;
    assert.deepEqual(after.posts.map((p) => p.id), [removed[1].id], 'only the one that was named is gone');
    const folder = removed[0].id.split(':')[2];
    assert.equal(existsSync(join(work, 'projects', removed[0].id.split(':')[1], 'trash', folder)), false, 'its folder is gone from the disk');
    assert.equal((await call('/studio/trash-delete', 'POST', { ids: [removed[0].id] })).body.failed.length, 1, 'it cannot be deleted twice');
  });
});

test('only what is in the trash can be reached: a live post, a live brand, a path out of the trash and nonsense are all refused, and nothing is touched', async () => {
  await studio(async ({ call, work }) => {
    const { posts, projects } = await overview(call);
    const live = firstWhere(posts, (x) => x.docId && x.status === 'built');
    const removed = (await call('/studio/remove', 'POST', { uids: [firstWhere(posts, (x) => x.status === 'built' && x.format === 'carousel' && x.docId && x.uid !== live.uid).uid] })).body.removed[0];
    const [, project] = removed.id.split(':');
    const evil = [
      `post:${project}:..`, `post:${project}:.`, `post:${project}:../docs`, `post:${project}:..\\docs`, `post:../../${project}:x`, 'post:no-such-project:x',
      `post:${project}:${live.docId}`, `post:${project}:does-not-exist`, `brand:${projects[0].id}`, 'brand:..', 'brand:../projects', 'brand:', 'nonsense', '', '/etc/passwd',
    ];
    const r = await call('/studio/trash-delete', 'POST', { ids: evil });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.deleted, [], 'not one of them deleted anything');
    assert.equal(r.body.failed.length, evil.length, 'each one says it was refused');
    const dir = join(work, 'projects', live.project);
    assert.ok(existsSync(join(dir, 'docs', `${live.docId}.json`)), 'the live post is untouched');
    assert.ok(existsSync(join(work, 'projects', projects[0].id, 'brand.json')), 'the live brand is untouched');
    assert.equal((await call('/studio/trash')).body.posts.length, 1, 'and the thing in the trash is still there');
  });
});

test('a whole brand in the trash is deleted with its folder; emptying the trash deletes everything in it and leaves the live brands alone', async () => {
  await studio(async ({ call, work }) => {
    const { posts, projects } = await overview(call);
    const post = firstWhere(posts, (x) => x.project === projects[0].id && x.status === 'built' && x.format === 'carousel' && x.docId);
    await call('/studio/remove', 'POST', { uids: [post.uid] });
    const gone = projects[1];
    const brandName = (await call(`/projects/${gone.id}`)).body.brand.name;
    const rb = await call('/studio/remove-brand', 'POST', { project: gone.id, confirm: brandName });
    assert.equal(rb.status, 200, JSON.stringify(rb.body).slice(0, 200));
    let t = (await call('/studio/trash')).body;
    assert.deepEqual([t.posts.length, t.brands.length], [1, 1]);
    const brandFolder = t.brands[0].id.slice('brand:'.length);
    assert.ok(existsSync(join(work, 'projects', '.trash', brandFolder)), 'the brand folder is in the hidden trash');
    assert.ok(existsSync(join(work, 'projects', '.trash', `${brandFolder}.meta.json`)));

    const one = await call('/studio/trash-delete', 'POST', { ids: [t.brands[0].id] });
    assert.deepEqual(one.body.deleted.map((d) => [d.kind, d.title]), [['brand', brandName]]);
    assert.equal(existsSync(join(work, 'projects', '.trash', brandFolder)), false);
    assert.equal(existsSync(join(work, 'projects', '.trash', `${brandFolder}.meta.json`)), false, 'and its note');
    t = (await call('/studio/trash')).body;
    assert.deepEqual([t.posts.length, t.brands.length], [1, 0]);

    const all = await call('/studio/trash-delete', 'POST', { all: true });
    assert.equal(all.body.deleted.length, 1);
    assert.deepEqual((await call('/studio/trash')).body, { posts: [], brands: [] });
    assert.ok(existsSync(join(work, 'projects', projects[0].id, 'brand.json')), 'the live brand is still there');
    assert.equal((await call('/studio/trash-delete', 'POST', { all: true })).body.deleted.length, 0, 'emptying an empty trash does nothing');
  });
});

test('the Trash page: Delete asks first and can be cancelled, then deletes that one; Empty the trash lists what goes and deletes it all', async () => {
  await studioPage(async ({ page, open, call }) => {
    const { posts } = await overview(call);
    const [a, b, c] = posts.filter((x) => x.status === 'built' && x.format === 'carousel' && x.docId).slice(0, 3);
    await call('/studio/remove', 'POST', { uids: [a.uid, b.uid, c.uid] });
    await open(`#/s/trash?today=${TODAY}`);
    await page.waitForSelector('.tr-row');
    assert.equal(await page.locator('.tr-row').count(), 3);
    assert.equal(await page.locator('.tr-row').first().locator('[data-act="trash-delete"]').count(), 1);

    // cancelled: nothing happens
    await page.locator('.tr-row').first().locator('[data-act="trash-delete"]').click();
    await page.waitForSelector('dialog[open]');
    assert.match(await page.locator('dialog[open]').innerText(), /Delete .* for good\?[\s\S]*cannot be undone/);
    await page.click('dialog[open] button:has-text("Cancel")');
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    assert.equal((await call('/studio/trash')).body.posts.length, 3);

    // confirmed: that one is deleted for good
    const first = await page.locator('.tr-row').first().getAttribute('data-id');
    await page.locator('.tr-row').first().locator('[data-act="trash-delete"]').click();
    await page.waitForSelector('dialog[open]');
    await page.click('dialog[open] button:has-text("Delete forever")');
    await page.waitForFunction(() => document.querySelectorAll('.tr-row').length === 2, null, { timeout: 8000 });
    assert.ok(!(await call('/studio/trash')).body.posts.some((p) => p.id === first));
    await page.waitForSelector('.notice:has-text("is deleted")');

    // Empty the trash: the dialog lists what goes
    await page.click('[data-act="trash-empty"]');
    await page.waitForSelector('dialog[open]');
    const dlg = await page.locator('dialog[open]').innerText();
    assert.match(dlg, /Empty the trash: delete 2 things for good\?/);
    assert.ok(dlg.includes(b.title.slice(0, 12)) || dlg.includes(c.title.slice(0, 12)), 'it names what will be deleted');
    await page.click('dialog[open] button:has-text("Empty the trash")');
    await page.waitForSelector('.notice:has-text("The trash is empty")');
    await page.waitForSelector('text=The trash is empty');
    assert.deepEqual((await call('/studio/trash')).body, { posts: [], brands: [] });
  });
});
