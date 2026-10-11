// The Studio: its API (every post in one call, one post in full, thumbnails, decisions, bulk sign-off) and the page, driven like a
// person would drive it. Only fictional data: a generated workspace of made-up brands (tools/studio-fixtures.mjs).
//   node --test tests/studio.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { ROOT } from '../tools/validate.mjs';
import { createNordleServer } from '../src/server/http.mjs';
import { validateCalendar, loadCalendar } from '../src/calendar/model.mjs';
import { mutateCalendar } from '../src/calendar/service.mjs';
import { closeBrowser, getBrowser, TOKEN, AGENT } from './helpers.mjs';
import { built, LOOSE, TODAY, studio, studioPage, overview, firstWhere, verifiedBuilt } from './studio-helpers.mjs';

after(closeBrowser);

// ---- API -----------------------------------------------------------------------------------------------------------------------

test('GET /api/studio gives every project\'s posts in one call, and needs a token', async () => {
  await studio(async ({ call, port }) => {
    const r = await call(`/studio?today=${TODAY}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.today, TODAY);
    assert.equal(r.body.projects.length, 2);
    const items = built.projects.reduce((n, p) => n + p.items, 0);
    assert.equal(r.body.posts.length, items + 1, 'every calendar item plus the one loose document');
    for (const p of r.body.posts) {
      assert.ok(p.uid && p.title && p.status && p.format, 'each post has the basics');
      assert.ok(['reel', 'carousel', 'post', 'story'].includes(p.format));
    }
    const loose = r.body.posts.find((p) => p.uid.endsWith(`:~${LOOSE}`));
    assert.ok(loose && loose.date === null && loose.calendar === false && loose.status === 'built', 'a document with no calendar item is still a post');
    assert.ok(r.body.posts.some((p) => p.needsReview));
    assert.ok(r.body.posts.some((p) => p.checks && p.checks.missing > 0 && p.verified === false), 'missing checks are counted');
    assert.ok(r.body.posts.some((p) => p.failing), 'failing checks are flagged');
    assert.ok(r.body.projects.every((p) => /^#[0-9a-f]{6}$/i.test(p.color) && p.short.length === 2));
    const same = await call(`/studio?today=${TODAY}&since=${r.body.rev}`);
    assert.deepEqual(same.body, { rev: r.body.rev, unchanged: true });
    assert.equal((await call('/studio', 'GET', undefined, 'wrong')).status, 401);
    assert.equal((await call('/studio', 'GET', undefined, AGENT)).status, 200, 'Claude can read it');
    const t = Date.now();
    await call('/studio');
    assert.ok(Date.now() - t < 1500, 'it is fast: no rendering');
    void port;
  });
});

test('GET /api/studio/post gives the post in full: pictures, words, brief, the checks (missing ones too), pairs', async () => {
  await studio(async ({ call }) => {
    const { posts } = await overview(call);
    const carousel = firstWhere(posts, verifiedBuilt);
    const d = (await call(`/studio/post?uid=${encodeURIComponent(carousel.uid)}`)).body;
    assert.equal(d.media.kind, 'carousel');
    assert.equal(d.media.pages.length, 3);
    assert.ok(d.media.pages.every((p) => /^out\/[^/]+\/.+\.png$/.test(p.path)));
    assert.match(d.copy.caption, /\S/);
    assert.equal(d.copy.limit, 2200);
    assert.ok(d.copy.hashtags.every((t) => t.startsWith('#')));
    assert.ok(d.brief?.goal && d.item?.idea);
    assert.equal(d.checks.verified, true);
    assert.ok(d.checks.rows.length >= 9 && d.checks.rows.every((r) => r.status === 'pass'));
    assert.ok(d.critique.score >= 88);
    assert.ok(d.pairs.items.length >= 2 && d.pairs.items[0].words && d.pairs.items[0].shows);

    const gap = firstWhere(posts, (p) => p.checks && p.checks.missing > 0 && p.format === 'carousel');
    const g = (await call(`/studio/post?uid=${encodeURIComponent(gap.uid)}`)).body;
    assert.equal(g.checks.verified, false);
    const missing = g.checks.rows.filter((r) => r.status === 'missing');
    assert.ok(missing.length > 0 && missing.every((r) => r.who && r.label), 'a check that has not run is listed, with who owes it');

    const bad = firstWhere(posts, (p) => p.failing);
    const b = (await call(`/studio/post?uid=${encodeURIComponent(bad.uid)}`)).body;
    assert.ok(b.pairs.items.some((x) => x.verdict === 'mismatch'), 'a caption claim that the picture does not show is a mismatch');
    assert.ok(b.checks.rows.some((r) => r.status === 'fail' && r.findings.length));

    const reel = firstWhere(posts, (p) => p.format === 'reel' && p.status === 'built');
    const r = (await call(`/studio/post?uid=${encodeURIComponent(reel.uid)}`)).body;
    assert.equal(r.media.kind === 'video' || r.media.kind === 'none', true);
    assert.ok(r.media.poster, 'a reel has a cover');

    const idea = firstWhere(posts, (p) => p.status === 'idea');
    const i = (await call(`/studio/post?uid=${encodeURIComponent(idea.uid)}`)).body;
    assert.equal(i.media.kind, 'none');
    assert.equal(i.checks, null);
    assert.equal((await call('/studio/post?uid=nope:nothing')).status, 404);
  });
});

test('thumbnails: PNGs are shrunk off the main thread and cached; paths are contained', async () => {
  await studio(async ({ call, work, port }) => {
    const { posts } = await overview(call);
    const p = firstWhere(posts, verifiedBuilt);
    const big = new PNG({ width: 1080, height: 1350 });
    big.data.fill(200);
    const dir = join(work, 'projects', p.project);
    mkdirSync(join(dir, 'out', 'huge'), { recursive: true });
    writeFileSync(join(dir, 'out', 'huge', 'big.png'), PNG.sync.write(big));
    const get = (path, w, headers = {}) => fetch(`http://127.0.0.1:${port}/api/studio/thumb?project=${p.project}&path=${encodeURIComponent(path)}&w=${w}`, { headers: { 'x-nordle-token': TOKEN, ...headers } });
    const r = await get('out/huge/big.png', 200);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/png');
    const png = PNG.sync.read(Buffer.from(await r.arrayBuffer()));
    assert.equal(png.width, 240, 'asked for 200, given the next size up (240)');
    assert.equal(png.height, 300);
    const etag = r.headers.get('etag');
    assert.ok(etag);
    assert.equal((await get('out/huge/big.png', 200, { 'if-none-match': etag })).status, 304);
    const small = await get(p.thumb, 1080);
    assert.equal(small.status, 200, 'a picture smaller than asked for is sent as it is');
    for (const bad of ['../brand.json', 'review/x.png', 'history/x.png', 'out/../../x.png', '.hidden/x.png', 'C:/x.png', 'out\\huge\\big.png', 'brand.json', 'docs/' + p.docId + '.json', '']) {
      assert.equal((await get(bad, 200)).status, 404, `refused: ${bad}`);
    }
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/studio/thumb?project=${p.project}&path=out`, {})).status, 401);
  });
});

test('files can be asked for in ranges, so a video can seek', async () => {
  await studio(async ({ work, port, call }) => {
    const { projects } = await overview(call);
    const id = projects[0].id;
    const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
    mkdirSync(join(work, 'projects', id, 'out', 'clip'), { recursive: true });
    writeFileSync(join(work, 'projects', id, 'out', 'clip', 'clip.mp4'), bytes);
    const url = `http://127.0.0.1:${port}/p/${id}/out/clip/clip.mp4`;
    const whole = await fetch(url);
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get('accept-ranges'), 'bytes');
    const part = await fetch(url, { headers: { range: 'bytes=10-19' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 10-19/1000');
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), bytes.subarray(10, 20));
    const tail = await fetch(url, { headers: { range: 'bytes=-5' } });
    assert.equal(tail.status, 206);
    assert.deepEqual(Buffer.from(await tail.arrayBuffer()), bytes.subarray(995));
    const open = await fetch(url, { headers: { range: 'bytes=990-' } });
    assert.equal(open.headers.get('content-range'), 'bytes 990-999/1000');
    await open.arrayBuffer();
    const past = await fetch(url, { headers: { range: 'bytes=5000-' } });
    assert.equal(past.status, 416);
    await past.arrayBuffer();
  });
});

test('sign off: writes the approval and the calendar, asks first when checks are open, and can be undone', async () => {
  await studio(async ({ call, calendarOf }) => {
    const { posts } = await overview(call);
    const post = firstWhere(posts, verifiedBuilt);
    const r = await call('/studio/act', 'POST', { uid: post.uid, action: 'approve' });
    assert.equal(r.status, 200);
    assert.equal(r.body.post.status, 'signed-off');
    assert.equal(calendarOf(post.project).items.find((i) => i.id === post.itemId).status, 'signed-off');
    assert.equal(validateCalendar(calendarOf(post.project)).ok, true);
    const d = (await call(`/studio/post?uid=${encodeURIComponent(post.uid)}`)).body;
    assert.equal(d.approval?.by, 'human');
    const twice = await call('/studio/act', 'POST', { uid: post.uid, action: 'approve' });
    assert.deepEqual([twice.status, twice.body.already, twice.body.post.status], [200, true, 'signed-off'], 'a second press confirms, it is not an error');

    const undone = await call('/studio/act', 'POST', { action: 'undo', tokens: [r.body.undo] });
    assert.equal(undone.status, 200);
    assert.equal(undone.body.post.status, 'built');
    assert.equal(calendarOf(post.project).items.find((i) => i.id === post.itemId).status, 'built');
    assert.equal((await call(`/studio/post?uid=${encodeURIComponent(post.uid)}`)).body.approval, null);

    const open = firstWhere(posts, (p) => p.status === 'built' && p.verified === false);
    const ask = await call('/studio/act', 'POST', { uid: open.uid, action: 'approve' });
    assert.equal(ask.status, 409);
    assert.equal(ask.body.needsConfirm, true);
    assert.ok(ask.body.checks.missing + ask.body.checks.fail > 0);
    assert.equal(calendarOf(open.project).items.find((i) => i.id === open.itemId).status, 'built', 'nothing changed');
    assert.equal((await call('/studio/act', 'POST', { uid: open.uid, action: 'approve', force: true })).status, 200);

    const notBuilt = firstWhere(posts, (p) => p.status === 'approved');
    assert.equal((await call('/studio/act', 'POST', { uid: notBuilt.uid, action: 'approve' })).status, 409, 'nothing to sign off before it is built');
  });
});

test('request changes writes a note on the post and sends it back; reject and reopen; the calendar stays valid', async () => {
  await studio(async ({ call, calendarOf }) => {
    const { posts } = await overview(call);
    const post = firstWhere(posts, verifiedBuilt);
    assert.equal((await call('/studio/act', 'POST', { uid: post.uid, action: 'changes', text: '   ' })).status, 400, 'a note is required');
    const r = await call('/studio/act', 'POST', { uid: post.uid, action: 'changes', text: 'Shorter caption, and use the counter photo.' });
    assert.equal(r.status, 200);
    assert.equal(r.body.post.status, 'changes');
    const item = calendarOf(post.project).items.find((i) => i.id === post.itemId);
    assert.equal(item.status, 'changes');
    assert.equal(item.feedback.at(-1).comment, 'Shorter caption, and use the counter photo.');
    const d = (await call(`/studio/post?uid=${encodeURIComponent(post.uid)}`)).body;
    assert.equal(d.comments.length, 1);
    assert.equal(d.comments[0].author, 'human');
    assert.equal(d.comments[0].status, 'open');
    assert.match(d.comments[0].text, /Shorter caption/);
    assert.equal(validateCalendar(calendarOf(post.project)).ok, true);

    const undone = await call('/studio/act', 'POST', { action: 'undo', tokens: [r.body.undo] });
    assert.equal(undone.body.post.status, 'built');
    assert.equal((await call(`/studio/post?uid=${encodeURIComponent(post.uid)}`)).body.comments.length, 0);

    const rj = await call('/studio/act', 'POST', { uid: post.uid, action: 'reject', text: 'Not this month' });
    assert.equal(rj.body.post.status, 'rejected');
    assert.match(calendarOf(post.project).items.find((i) => i.id === post.itemId).notes, /Not this month/);
    const back = await call('/studio/act', 'POST', { uid: post.uid, action: 'reopen' });
    assert.equal(back.body.post.status, 'built');
  });
});

test('ideas: approve, reject, edit; only the owner can decide anything', async () => {
  await studio(async ({ call, calendarOf }) => {
    const { posts } = await overview(call);
    const ideas = posts.filter((p) => p.status === 'idea');
    assert.ok(ideas.length >= 2);
    const [a, b] = ideas;
    assert.equal((await call('/studio/act', 'POST', { uid: a.uid, action: 'idea-approve' }, AGENT)).status, 403, 'Claude cannot approve');
    assert.equal((await call('/studio/bulk', 'POST', { uids: [a.uid] }, AGENT)).status, 403);
    assert.equal((await call('/studio/act', 'POST', { uid: a.uid, action: 'idea-approve' })).body.post.status, 'approved');
    assert.equal(calendarOf(a.project).items.find((i) => i.id === a.itemId).ideaApproval, 'owner');
    assert.equal((await call('/studio/act', 'POST', { uid: b.uid, action: 'idea-reject' })).body.post.status, 'rejected');
    const e = await call('/studio/act', 'POST', { uid: b.uid, action: 'edit', fields: { title: 'A better title', hook: 'A better hook.' } });
    assert.equal(e.status, 200);
    assert.equal(calendarOf(b.project).items.find((i) => i.id === b.itemId).title, 'A better title');
    assert.equal((await call('/studio/act', 'POST', { uid: b.uid, action: 'edit', fields: { date: 'tomorrow' } })).status, 400);
    assert.equal((await call('/studio/act', 'POST', { uid: a.uid, action: 'nonsense' })).status, 400);
  });
});

test('bulk sign-off takes only fully verified posts and says why it left the others', async () => {
  await studio(async ({ call, calendarOf }) => {
    const { posts } = await overview(call);
    const good = posts.filter((p) => p.needsReview && p.verified === true && !p.openComments).slice(0, 3);
    const bad = firstWhere(posts, (p) => p.needsReview && p.verified === false);
    const idea = firstWhere(posts, (p) => p.status === 'idea');
    assert.equal(good.length, 3);
    const r = await call('/studio/bulk', 'POST', { uids: [...good.map((p) => p.uid), bad.uid, idea.uid] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.done.sort(), good.map((p) => p.uid).sort());
    assert.equal(r.body.skipped.length, 2);
    assert.ok(r.body.skipped.every((s) => s.reason));
    for (const p of good) assert.equal(calendarOf(p.project).items.find((i) => i.id === p.itemId).status, 'signed-off');
    assert.equal(calendarOf(bad.project).items.find((i) => i.id === bad.itemId).status, 'built');
    assert.equal((await call('/studio/bulk', 'POST', { uids: [] })).status, 400);
    const undo = await call('/studio/act', 'POST', { action: 'undo', tokens: r.body.undo });
    assert.equal(undo.status, 200);
    for (const p of good) assert.equal(calendarOf(p.project).items.find((i) => i.id === p.itemId).status, 'built');
  });
});

test('a finished document that is on no calendar can still be signed off', async () => {
  await studio(async ({ call }) => {
    const { posts } = await overview(call);
    const loose = posts.find((p) => p.uid.endsWith(`:~${LOOSE}`));
    const r = await call('/studio/act', 'POST', { uid: loose.uid, action: 'approve', force: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.post.status, 'signed-off');
    assert.equal((await call('/studio/act', 'POST', { uid: loose.uid, action: 'reject' })).status, 409, 'there is no calendar item to reject');
  });
});

test('the colour tokens keep text above 4.5:1 in light and dark', () => {
  const css = readFileSync(join(ROOT, 'app', 'styles.css'), 'utf8');
  const block = (re) => Object.fromEntries([...re.exec(css)[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]));
  const light = block(/:root \{([\s\S]*?)\n\}/);
  const dark = { ...light, ...block(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/) };
  const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    for (const bg of ['paper', 'rail', 'surface']) {
      for (const fg of ['ink', 'ink-2', 'ink-3', 'proof', 'stamp', 'pencil']) assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${name}: ${fg} on ${bg} is ${ratio(t[fg], t[bg]).toFixed(2)}`);
    }
    assert.ok(ratio(t.paper, t.ink) >= 4.5, `${name}: text on the primary button`);
    assert.ok(ratio(t['on-color'], t.stamp) >= 4.5, `${name}: label on the approve button`);
  }
});

// ---- the page --------------------------------------------------------------------------------------------------------------------

test('a post can be dragged to another day on the month view: only within its own brand, with an Undo; a scheduled one stays put', async () => {
  await studioPage(async ({ page, open, call, calendarOf, work }) => {
    const { posts } = await overview(call);
    const post = firstWhere(posts, (p) => p.date >= '2026-10-12' && p.date < '2026-10-26' && p.status === 'built');
    await open(`#/s/month?today=${TODAY}&month=${post.date.slice(0, 7)}`);
    const sel = `.chip[data-uid="${post.uid}"]`;
    await page.waitForSelector(sel);
    assert.equal(await page.locator(sel).getAttribute('draggable'), 'true', 'a post that can still move is draggable');
    const dragTo = (toSel) => page.evaluate(([a, b]) => {
      const from = document.querySelector(a), to = document.querySelector(b);
      const dt = new DataTransfer();
      from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      const overOk = to.classList.contains('drop-ok');
      to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
      return overOk;
    }, [sel, toSel]);
    // another brand's band on the same week: refused
    const other = await page.evaluate(([s]) => {
      const cell = document.querySelector(s).parentElement;
      const week = cell.closest('.m-week');
      const lanes = [...week.querySelectorAll('.m-cell')];
      const mine = lanes.indexOf(cell);
      const col = mine % 7;
      const row = Math.floor(mine / 7);
      const elsewhere = lanes[(row === 0 ? 1 : 0) * 7 + col];
      elsewhere.dataset.testother = '1';
      return elsewhere.dataset.date;
    }, [sel]);
    assert.equal(await dragTo('[data-testother="1"]'), false, 'the other brand\'s lane does not take it');
    assert.equal(calendarOf(post.project).items.find((i) => i.id === post.itemId).date, post.date, 'nothing moved');
    // the next day in its own lane: moves
    const next = await page.evaluate(([s]) => { const t = document.querySelector(s).parentElement.nextElementSibling; t.dataset.testnext = '1'; return t.dataset.date; }, [sel]);
    assert.ok(next > post.date);
    assert.equal(await dragTo('[data-testnext="1"]'), true, 'its own lane takes it');
    await page.waitForFunction(([s, d]) => document.querySelector(s)?.parentElement.dataset.date === d, [sel, next]);
    assert.equal(calendarOf(post.project).items.find((i) => i.id === post.itemId).date, next, 'the calendar has the new date');
    assert.equal(validateCalendar(calendarOf(post.project)).ok, true);
    await page.waitForSelector('.notice:has-text("Moved")');
    await page.click('.notice [data-act="undo"], .notice button:has-text("Undo")');
    await page.waitForFunction(([s, d]) => document.querySelector(s)?.parentElement.dataset.date === d, [sel, post.date]);
    assert.equal(calendarOf(post.project).items.find((i) => i.id === post.itemId).date, post.date, 'Undo puts it back');
    assert.ok(other, 'the other brand\'s lane was found');
    // a post already scheduled in the service cannot be moved (the server says no too)
    await mutateCalendar(join(work, 'projects', post.project), (cal) => {
      const item = cal.items.find((i) => i.id === post.itemId);
      item.status = 'signed-off';
      item.status = 'scheduled';
      item.publish = { adapter: 'buffer', scheduledAt: '2026-11-12T07:30:00Z', remoteId: 'r1', at: new Date().toISOString() };
    });
    const r = await call('/studio/act', 'POST', { uid: post.uid, action: 'edit', fields: { date: next } });
    assert.equal(r.status, 409);
    assert.match(r.body.error ?? r.body.message ?? JSON.stringify(r.body), /already scheduled/);
    assert.equal(calendarOf(post.project).items.find((i) => i.id === post.itemId).date, post.date, 'a scheduled post stays on its day');
  });
});

test('the cover of a reel can be chosen: the picture is retaken from the video at that second, the choice is kept for publishing, and only the owner can do it', async () => {
  await studio(async ({ call, work }) => {
    const { body } = await call(`/studio?today=${TODAY}`);
    const reel = body.posts.find((p) => p.format === 'reel' && p.video && p.thumb && p.itemId);
    assert.ok(reel, 'the workspace has a reel with a video');
    const before = statSync(join(work, 'projects', reel.project, reel.thumb)).mtimeMs;
    const agent = await call('/studio/cover', 'POST', { uid: reel.uid, time: 2 }, AGENT);
    assert.equal(agent.status, 403, 'Claude cannot choose a cover');
    const bad = await call('/studio/cover', 'POST', { uid: reel.uid, time: -3 });
    assert.equal(bad.status, 400);
    await new Promise((r) => setTimeout(r, 30));
    const r = await call('/studio/cover', 'POST', { uid: reel.uid, time: 2.4 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.time, 2.4);
    assert.ok(statSync(join(work, 'projects', reel.project, r.body.cover)).mtimeMs > before, 'the cover picture was taken again');
    const kept = JSON.parse(readFileSync(join(work, 'projects', reel.project, 'publish', 'covers.json'), 'utf8'));
    assert.equal(kept.covers[reel.itemId].at, 2.4);
    const d = (await call(`/studio/post?uid=${encodeURIComponent(reel.uid)}`)).body;
    assert.equal(d.media.coverTime, 2.4, 'the post says which frame is its cover');
    // the best frames: a few, best first, each a small picture, at least a moment apart
    const cands = await call(`/studio/cover-candidates?uid=${encodeURIComponent(reel.uid)}&count=3`);
    assert.equal(cands.status, 200, JSON.stringify(cands.body));
    assert.ok(cands.body.candidates.length >= 1 && cands.body.candidates.length <= 3);
    for (const c of cands.body.candidates) assert.ok(/^data:image\/jpeg;base64,/.test(c.image) && c.time >= 0 && c.time < 6, 'a picture and a time inside the video');
    assert.ok(cands.body.candidates.every((c, i, all) => i === 0 || all[i - 1].score >= c.score), 'best first');
    assert.deepEqual(cands.body.current, { time: 2.4, auto: false }, 'it says which cover is chosen now');
    // Nordle picks one for you
    const auto = await call('/studio/cover', 'POST', { uid: reel.uid, auto: true });
    assert.equal(auto.status, 200, JSON.stringify(auto.body));
    assert.equal(auto.body.auto, true);
    assert.ok(auto.body.time >= 0 && auto.body.time < 6);
    assert.equal(JSON.parse(readFileSync(join(work, 'projects', reel.project, 'publish', 'covers.json'), 'utf8')).covers[reel.itemId].auto, true, 'it is on record that Nordle picked it');
    assert.equal((await call('/studio/cover', 'POST', { uid: reel.uid, auto: true }, AGENT)).status, 403, 'Claude cannot have it picked either');
    const none = await call('/studio/cover', 'POST', { uid: 'nope:none', time: 1 });
    assert.equal(none.status, 404);
  });
});

test('the front door is the month: one band per brand, thumbnails per day, the four figures, no errors', async () => {
  await studioPage(async ({ page, open, call }) => {
    await open(`#/s/month?today=${TODAY}`);
    assert.equal(await page.locator('.m-grid.multi').count(), 3, 'October, November and one empty month');
    assert.equal(await page.locator('.m-week').first().locator('.m-lane-h').count(), 2, 'a lane per brand in every week');
    const chips = await page.locator('.m-cell .chip').count();
    assert.ok(chips >= 20, `${chips} thumbnails in the month`);
    assert.match(await page.locator('.mast-h').textContent(), /October/);
    assert.equal(await page.locator('.m-day.today').count(), 1);
    const { posts } = await overview(call);
    const need = posts.filter((p) => p.needsReview).length;
    assert.equal(Number(await page.locator('.fig.cta .fig-n').textContent()), need);
    assert.equal(await page.locator('.figs .fig').count(), 4);
    await page.waitForFunction(() => [...document.querySelectorAll('.chip img')].filter((i) => i.complete && i.naturalWidth > 0).length > 5);
    assert.equal(await page.locator('.rb').count(), 3, 'all brands, then each');
    await page.click('.rb:has-text("Harbour")');
    await page.waitForFunction(() => document.querySelector('.m-grid.single'));
    assert.ok(location_hash(await page.evaluate(() => location.hash)).brand === 'harbour-bakery');
    await page.goto(`${page.url().split('#')[0]}`);
    await page.waitForSelector('.studio .view');
  });
});

function location_hash(h) { return Object.fromEntries(new URLSearchParams(h.split('?')[1] ?? '')); }

test('keyboard: g then w, j/k, arrows, Enter opens, Esc closes, / searches', async () => {
  await studioPage(async ({ page, open }) => {
    await open(`#/s/month?today=${TODAY}`);
    await page.keyboard.press('g');
    await page.keyboard.press('w');
    await page.waitForSelector('.wall .wc');
    assert.match(await page.evaluate(() => location.hash), /#\/s\/wall/);
    await page.keyboard.press('j');
    await page.waitForSelector('.wc.is-sel');
    const sel = () => page.evaluate(() => document.querySelector('.wc.is-sel')?.dataset.uid);
    const first = await sel();
    assert.ok(first);
    await page.keyboard.press('j');
    await page.waitForFunction((u) => document.querySelector('.wc.is-sel')?.dataset.uid !== u, first);
    const second = await sel();
    assert.notEqual(first, second, 'j moves on');
    await page.keyboard.press('k');
    await page.waitForFunction((u) => document.querySelector('.wc.is-sel')?.dataset.uid === u, first);
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction((u) => document.querySelector('.wc.is-sel')?.dataset.uid !== u, first);
    await page.keyboard.press('Enter');
    await page.waitForSelector('.detail.open .ph-title');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.detail.open'));
    const total = Number((await page.locator('.f-count').textContent()).split(' of ')[0]);
    await page.keyboard.press('/');
    assert.equal(await page.evaluate(() => document.activeElement?.className), 'f-q');
    await page.keyboard.type('reel');
    await page.waitForFunction((t) => Number(document.querySelector('.f-count').textContent.split(' of ')[0]) < t, total);
    await page.keyboard.press('Escape');
    await page.keyboard.press('g');
    await page.keyboard.press('q');
    await page.waitForSelector('.queue .q-media');
    await page.keyboard.press('?');
    await page.waitForSelector('dialog .keymap');
    await page.keyboard.press('Escape');
  });
});

test('the post sheet: caption with the hook marked, checks with the missing ones, words and pictures, and sign-off with undo', async () => {
  await studioPage(async ({ page, open, call, calendarOf, errors }) => {
    const { posts } = await overview(call);
    const post = firstWhere(posts, verifiedBuilt);
    await open(`#/s/month?today=${TODAY}&post=${encodeURIComponent(post.uid)}&month=${post.date.slice(0, 7)}`);
    await page.waitForSelector('.detail.open .cv-track');
    assert.equal(await page.locator('.detail .cv-slide').count(), 3);
    assert.equal(await page.locator('.detail .cv-strip .cv-t').count(), 3);
    assert.match(await page.locator('.detail .ph-title').textContent(), /\S/);
    assert.ok((await page.locator('.detail mark.hook').textContent()).length > 3, 'the hook is highlighted');
    assert.match(await page.locator('.detail .blk.cap .count').textContent(), /of 2,200/);
    assert.ok(await page.locator('.detail .chk').count() === 1);
    assert.ok(await page.locator('.detail .pair').count() >= 2);
    await page.locator('.detail .cv-next').dispatchEvent('click');
    await page.waitForFunction(() => document.querySelector('.detail .cv-count')?.textContent.startsWith('2'));
    await page.click('.detail .acts.decide [data-act="approve"]');
    await page.waitForSelector('.notice:has-text("Signed off")');
    // the decision is made, so the sheet that was open for it goes away
    await page.waitForFunction(() => !document.querySelector('.detail.open'));
    assert.equal(calendarOf(post.project).items.find((i) => i.id === post.itemId).status, 'signed-off');
    // opened again, the Approve button is a greyed-out "Approved" that cannot be pressed
    await page.goto(`${page.url().split('#')[0]}#/s/month?today=${TODAY}&post=${encodeURIComponent(post.uid)}&month=${post.date.slice(0, 7)}`);
    await page.waitForFunction(() => document.querySelector('.detail .btn.approved')?.textContent.includes('Approved'));
    assert.equal(await page.locator('.detail [data-act="approve"]').count(), 0);
    assert.equal(await page.locator('.detail .btn.approved').isDisabled(), true);
    await page.click('.notice-act');
    await page.waitForFunction(() => document.querySelector('.detail [data-act="approve"]'));
    assert.equal(calendarOf(post.project).items.find((i) => i.id === post.itemId).status, 'built');

    const gap = firstWhere(posts, (p) => p.checks && p.checks.missing > 0 && p.format === 'carousel');
    await page.goto(`${page.url().split('#')[0]}#/s/month?today=${TODAY}&post=${encodeURIComponent(gap.uid)}&month=${gap.date.slice(0, 7)}`);
    await page.waitForSelector('.detail.open .ck-r-missing');
    assert.ok(await page.locator('.detail .ck-r-missing').count() > 0, 'a check that has not run looks different from a passed one');
    await page.click('.detail .acts.decide [data-act="approve"]');
    await page.waitForSelector('dialog:has-text("not fully checked")');
    await page.click('dialog button:has-text("Cancel")');
    assert.equal(calendarOf(gap.project).items.find((i) => i.id === gap.itemId).status, 'built', 'cancelled: nothing changed');
    errors.length = 0; // the 409 that asked "are you sure" is logged by the browser, on purpose
  });
});

test('the post sheet puts the decisions under the picture and its words; only "Open in editor" and "Remove" stay in the dock at the bottom', async () => {
  await studioPage(async ({ page, open, call }) => {
    const { posts } = await overview(call);
    const post = firstWhere(posts, (p) => verifiedBuilt(p) && p.docId && p.format !== 'reel');
    await open(`#/s/wall?today=${TODAY}&post=${encodeURIComponent(post.uid)}`);
    await page.waitForSelector('.detail.open .acts.decide [data-act="approve"]');
    const decide = await page.locator('.detail .acts.decide').boundingBox();
    const title = await page.locator('.detail .ph-title').boundingBox();
    const media = await page.locator('.detail .d-scroll > :first-child').boundingBox();
    assert.ok(decide.y >= media.y + media.height - 2 && decide.y + decide.height <= title.y + 2, 'the decisions sit between the picture and the title');
    for (const act of ['approve', 'changes', 'reject']) assert.equal(await page.locator(`.detail .acts.decide [data-act="${act}"]`).count(), 1, `${act} is under the picture`);
    assert.equal(await page.locator('.detail .d-dock [data-act="approve"], .detail .d-dock [data-act="changes"], .detail .d-dock [data-act="reject"]').count(), 0, 'none of the decisions are left in the dock');
    assert.equal(await page.locator('.detail .d-dock [data-act="remove"]').count(), 1, 'Remove stays at the bottom');
    assert.match(await page.locator('.detail .d-dock').innerText(), /Open in editor/, 'so does Open in editor');
  });
});

test('request changes from the keyboard: x, write the note, Ctrl+Enter', async () => {
  await studioPage(async ({ page, open, call, calendarOf }) => {
    const { posts } = await overview(call);
    const post = firstWhere(posts, verifiedBuilt);
    await open(`#/s/wall?today=${TODAY}&post=${encodeURIComponent(post.uid)}`);
    await page.waitForSelector('.detail.open .d-dock');
    await page.keyboard.press('x');
    await page.waitForSelector('dialog textarea');
    await page.fill('dialog textarea', 'Try a shorter first line.');
    await page.keyboard.press('Control+Enter');
    await page.waitForSelector('.notice:has-text("Sent back")');
    const item = calendarOf(post.project).items.find((i) => i.id === post.itemId);
    assert.equal(item.status, 'changes');
    assert.equal(item.feedback.at(-1).comment, 'Try a shorter first line.');
    await page.waitForFunction(() => !document.querySelector('.detail.open'), null, { timeout: 5000 });   // sent: the sheet goes away
    await page.keyboard.press('u');
    await page.waitForSelector('.notice:has-text("Undone")');
    assert.equal(calendarOf(post.project).items.find((i) => i.id === post.itemId).status, 'built');
  });
});

test('approving a post that already says signed off is never an error: it confirms the sign-off, or puts right a missing approval', async () => {
  await studio(async ({ call, work, calendarOf }) => {
    const { posts } = await overview(call);
    const post = firstWhere(posts, (p) => p.status === 'built' && p.format === 'carousel' && p.verified);
    const approve = () => call('/studio/act', 'POST', { uid: post.uid, action: 'approve' });
    const first = await approve();
    assert.equal(first.status, 200);
    assert.ok(!first.body.already);
    // pressing it again confirms: still signed off, nothing broken, nothing to undo
    const again = await approve();
    assert.equal(again.status, 200);
    assert.deepEqual([again.body.already, again.body.healed, again.body.undo], [true, false, null]);
    assert.equal(again.body.post.status, 'signed-off');
    // a post the calendar says is signed off (set by hand or by an older tool) but that has no approval on record
    const other = firstWhere(posts, (p) => p.status === 'built' && p.format === 'carousel' && p.uid !== post.uid && p.verified);
    await mutateCalendar(join(work, 'projects', other.project), (cal) => { cal.items.find((i) => i.id === other.itemId).status = 'signed-off'; });
    const healed = await call('/studio/act', 'POST', { uid: other.uid, action: 'approve' });
    assert.equal(healed.status, 200);
    assert.deepEqual([healed.body.already, healed.body.healed], [true, true]);
    const fresh = (await call(`/studio/post?uid=${encodeURIComponent(other.uid)}`)).body;
    assert.ok(fresh.approval, 'there is a live approval on record now');
    assert.equal(calendarOf(other.project).items.find((i) => i.id === other.itemId).status, 'signed-off');
    assert.equal((await call('/studio/act', 'POST', { uid: other.uid, action: 'approve' })).body.healed, false, 'and the next press just confirms');
  });
});

test('the review queue steps through what needs you: a approves, x sends back, k goes back, s skips', async () => {
  await studioPage(async ({ page, open, call, calendarOf }) => {
    const { posts } = await overview(call);
    const need = posts.filter((p) => p.needsReview).sort((a, b) => (a.date ?? '9').localeCompare(b.date ?? '9') || a.project.localeCompare(b.project) || a.uid.localeCompare(b.uid));
    await open(`#/s/queue?today=${TODAY}`);
    await page.waitForSelector('.queue .q-side .ph-title');
    assert.equal(await page.locator('.q-tick').count(), need.length);
    assert.match(await page.locator('.q-count').textContent(), new RegExp(`1 of ${need.length}`));
    assert.equal(await page.locator('.queue .ph-title').textContent(), need[0].title);
    assert.ok(await page.locator('.q-media .cv, .q-media .vp, .q-media .cv-none').count() === 1);
    await page.keyboard.press('s');
    await page.waitForFunction((t) => document.querySelector('.queue .ph-title')?.textContent !== t, need[0].title);
    assert.match(await page.locator('.q-count').textContent(), /2 of/);
    await page.keyboard.press('k');
    await page.waitForFunction((t) => document.querySelector('.queue .ph-title')?.textContent === t, need[0].title);
    await page.keyboard.press('j');
    await page.waitForSelector('.queue .q-actions [data-act="approve"]');
    // the second post: send it back with a note
    const second = need[1];
    await page.waitForFunction((t) => document.querySelector('.queue .ph-title')?.textContent === t, second.title);
    await page.keyboard.press('x');
    await page.waitForSelector('dialog textarea');
    await page.fill('dialog textarea', 'The photo does not match the line.');
    await page.keyboard.press('Control+Enter');
    await page.waitForSelector('.stamp');
    assert.match(await page.locator('.stamp').textContent(), /Sent back/);
    assert.equal(calendarOf(second.project).items.find((i) => i.id === second.itemId).status, 'changes');
    // then sign off the next one that is verified
    const target = need.slice(2).find((p) => p.verified);
    await page.waitForSelector('.stamp', { state: 'detached' });
    await page.locator('.q-tick').nth(need.indexOf(target)).click();
    await page.waitForFunction((n) => document.querySelector('.q-tick.now') === document.querySelectorAll('.q-tick')[n], need.indexOf(target));
    await page.waitForSelector('.queue .q-actions [data-act="approve"]');
    await page.keyboard.press('a');
    await page.waitForSelector('.stamp');
    assert.match(await page.locator('.stamp').textContent(), /Signed off/);
    assert.equal(calendarOf(target.project).items.find((i) => i.id === target.itemId).status, 'signed-off');
    await page.waitForSelector('.q-tick.d-approved');
    assert.equal(await page.locator('.q-tick.d-changes').count(), 1);
    assert.equal(await page.locator('.q-tick.d-approved').count(), 1);
  });
});

test('the review queue lists every post that needs you, whatever the calendar was filtered to before', async () => {
  await studioPage(async ({ page, open, call }) => {
    const { posts } = await overview(call);
    const need = posts.filter((p) => p.needsReview && p.status !== 'rejected');
    assert.ok(need.length > 3);
    // a month with no posts, a search that matches nothing, a status, a date window: none of it may hide a post that waits for a decision
    await open(`#/s/queue?today=${TODAY}&mo=2099-01&q=zzzz-nothing&st=posted&when=next7&needs=0`);
    await page.waitForSelector('.queue .q-side .ph-title');
    assert.equal(await page.locator('.q-tick').count(), need.length);
    assert.match(await page.locator('.q-count').textContent(), new RegExp(`1 of ${need.length}`));
    assert.equal(await page.locator('.queue .nothing-waiting, .queue .q-empty').count(), 0);
  });
});

test('a long caption is shown as written: no "…more" marker is put in the middle of it', async () => {
  await studioPage(async ({ page, open }) => {
    await open(`#/s/queue?today=${TODAY}`);
    await page.waitForSelector('.queue .cap-text');
    let long = 0;
    for (let i = 0; i < 12; i++) {
      const text = await page.locator('.queue .cap-text').first().innerText();
      if (text.length > 125) long++;
      assert.ok(!text.includes('…more') && !text.includes('...more'), text);
      assert.equal(await page.locator('.queue .fold').count(), 0);
      await page.keyboard.press('s');
      await page.waitForTimeout(120);
    }
    assert.ok(long > 0, 'at least one caption was longer than the old fold');
  });
});

test('Edit here opens the editor over the review page; after a change the pictures are drawn again and the post comes back for a decision', async () => {
  await studioPage(async ({ page, open, call, work }) => {
    const { posts } = await overview(call);
    const post = firstWhere(posts, verifiedBuilt);
    const outDir = join(work, 'projects', post.project, 'out', post.docId);
    const newest = () => Math.max(0, ...readdirSync(outDir).filter((f) => f.endsWith('.png')).map((f) => statSync(join(outDir, f)).mtimeMs));
    const before = newest();
    await open(`#/s/month?today=${TODAY}&post=${encodeURIComponent(post.uid)}&month=${post.date.slice(0, 7)}`);
    await page.waitForSelector('.detail.open .acts.decide [data-act="edit-here"]');
    await page.click('.detail [data-act="edit-here"]');
    await page.waitForSelector('dialog.edit-here iframe.eh-frame');
    const frame = page.frameLocator('dialog.edit-here iframe.eh-frame');
    await frame.locator('.workspace:not(.hidden)').waitFor({ timeout: 20000 });
    // a change made in the editor (here by the same call the editor makes when a layer is moved)
    const doc = (await call(`/projects/${post.project}/docs/${post.docId}`)).body;
    const move = await call(`/projects/${post.project}/docs/${post.docId}/patch`, 'POST', { ops: [{ op: 'replace', path: '/title', value: `${doc.doc.title} (moved)` }], baseVersion: doc.v, actor: 'human' });
    assert.equal(move.status, 200);
    await page.click('dialog.edit-here [data-act="edit-done"]');
    await page.waitForFunction(() => !document.querySelector('dialog.edit-here'), null, { timeout: 60000 });
    await page.waitForSelector('.notice:has-text("was edited")', { timeout: 60000 });
    assert.ok(newest() > before, 'the pictures were drawn again from the edited post');
    // and the page shows them: every picture address carries a new stamp, so the browser does not keep serving the old ones for a minute
    await page.waitForFunction(() => /&r=\d+/.test(document.querySelector('.detail .cv-slide img')?.getAttribute('src') ?? ''), null, { timeout: 15000 });
  });
});

test('the wall filters (needs my review, checks failing, format) and ticks verified posts for bulk sign-off', async () => {
  await studioPage(async ({ page, open, call, calendarOf }) => {
    const { posts } = await overview(call);
    await open(`#/s/wall?today=${TODAY}`);
    const all = Number((await page.locator('.f-count').textContent()).split(' of ')[0]);
    assert.ok(all > 30);
    await page.click('.f-chip:has-text("Checks failing")');
    await page.waitForFunction((n) => Number(document.querySelector('.f-count').textContent.split(' of ')[0]) === n, posts.filter((p) => p.failing && p.status !== 'rejected').length);
    assert.match(await page.evaluate(() => location.hash), /fail=1/);
    await page.click('.linklike.f-clear');
    await page.click('.f-seg button:has-text("Reels")');
    await page.waitForFunction(() => document.querySelectorAll('.wc').length > 0);
    assert.equal(await page.locator('.wc:has(.glyph-carousel)').count(), 0);
    await page.click('.f-seg button:has-text("All")');
    await page.click('.f-chip:has-text("Needs my review")');
    const eligible = posts.filter((p) => p.needsReview && p.verified === true && !p.openComments);
    await page.click('.f-verified');
    await page.waitForSelector('.selbar:not(.hidden)');
    assert.equal(Number(await page.locator('.selbar .sb-n b').textContent()), eligible.length);
    await page.click('.selbar .btn.go');
    await page.waitForSelector('dialog:has-text("Sign off")');
    await page.click('dialog button.primary');
    await page.waitForSelector('.notice:has-text("Signed off")');
    for (const p of eligible.slice(0, 3)) assert.equal(calendarOf(p.project).items.find((i) => i.id === p.itemId).status, 'signed-off');
    await page.waitForFunction(() => !document.querySelector('.selbar:not(.hidden)'));
  });
});

test('the list shows only the rows on screen, sorts by a column, and opens a post', async () => {
  await studioPage(async ({ page, open, call }) => {
    const { posts } = await overview(call);
    await open(`#/s/list?today=${TODAY}`);
    await page.waitForSelector('.lr');
    const mounted = await page.locator('.lr').count();
    assert.ok(mounted > 8 && mounted < posts.length, `${mounted} rows mounted of ${posts.length}`);
    await page.click('.lh .c-title button');
    const titles = await page.locator('.lr .c-title .t').allTextContents();
    assert.deepEqual(titles, [...titles].sort((a, b) => a.localeCompare(b)));
    await page.evaluate(() => { document.querySelector('.lscroll').scrollTop = 4000; });
    await page.waitForFunction((first) => document.querySelector('.lr .c-title .t')?.textContent !== first, titles[0]);
    await page.locator('.lr').nth(3).click();
    await page.waitForSelector('.detail.open .ph-title');
  });
});

test('the plan: quotas as meters, the idea backlog with approve, and a request to copy', async () => {
  await studioPage(async ({ page, open, call, calendarOf }) => {
    const { posts } = await overview(call);
    await open(`#/s/plan?today=${TODAY}&brand=little-gannet`);
    await page.waitForSelector('.plan-brand .meter');
    assert.equal(await page.locator('.plan-brand').count(), 1);
    assert.ok(await page.locator('.pm').count() >= 2);
    assert.match(await page.locator('.pm').first().locator('.meter-n').first().textContent(), /of 8/);
    assert.match(await page.locator('.pm').first().locator('.meter-n').nth(1).textContent(), /of 5/);
    assert.ok(await page.locator('.mix-row').count() >= 3, 'pillar mix');
    const ideas = posts.filter((p) => p.project === 'little-gannet' && p.status === 'idea');
    assert.equal(await page.locator('.idea').count(), ideas.length);
    await page.locator('.idea').first().locator('button:has-text("Approve")').click();
    await page.waitForSelector('.notice:has-text("Idea approved")');
    const first = ideas[0];
    assert.equal(calendarOf('little-gannet').items.find((i) => i.id === first.itemId).status, 'approved');
    await page.waitForFunction((n) => document.querySelectorAll('.idea').length === n - 1, ideas.length);
  });
});

test('a phone gets an agenda and a tab bar, nothing scrolls sideways, and the sheet fills the screen', async () => {
  await studioPage(async ({ page, open, call }) => {
    const { posts } = await overview(call);
    await open(`#/s/month?today=${TODAY}`);
    assert.equal(await page.locator('.tabbar').isVisible(), true);
    assert.equal(await page.locator('.rail').isVisible(), false);
    await page.waitForSelector('.agenda .ag-item');
    for (const hash of ['month', 'wall', 'list', 'queue', 'plan']) {
      await page.goto(`${page.url().split('#')[0]}#/s/${hash}?today=${TODAY}`);
      await page.waitForSelector(`.studio[data-view="${hash}"] .view > *`);
      await page.waitForTimeout(300);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(over <= 1, `${hash}: horizontal overflow ${over}px`);
    }
    const post = firstWhere(posts, verifiedBuilt);
    await page.goto(`${page.url().split('#')[0]}#/s/month?today=${TODAY}&post=${encodeURIComponent(post.uid)}&month=${post.date.slice(0, 7)}`);
    await page.waitForSelector('.detail.open .d-dock');
    const box = await page.locator('.detail').boundingBox();
    assert.ok(box.width >= 389, `the sheet is full width (${box.width})`);
    const dock = await page.locator('.acts.decide [data-act="approve"]').boundingBox();
    assert.ok(dock.height >= 44, 'the approve button is thumb sized');
  }, { viewport: { width: 390, height: 844 }, page: true });
});

test('light and dark: the theme follows the system and a toggle can force one; reduced motion switches the slide off', async () => {
  await studioPage(async ({ page, open }) => {
    await open(`#/s/month?today=${TODAY}`);
    const bg = () => page.evaluate(() => getComputedStyle(document.querySelector('.studio')).backgroundColor);
    assert.equal(await bg(), 'rgb(19, 21, 23)', 'dark system, dark Darkroom paper');
    const text = await page.evaluate(() => getComputedStyle(document.querySelector('.mast-h')).color);
    assert.notEqual(text, 'rgb(23, 25, 27)');
    await page.click('.rail-foot .rf:has-text("Theme")');
    await page.click('.rail-foot .rf:has-text("Theme")');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    await page.click('.rail-foot .rf:has-text("Theme")');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), undefined, 'back to following the system');
    await page.click('.rail-foot .rf:has-text("Theme")');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.studio')).backgroundColor === 'rgb(242, 240, 234)');
    assert.match(await page.evaluate(() => getComputedStyle(document.querySelector('.detail')).transitionDuration), /^0(.001)?s$/);
  }, { page: true, scheme: 'dark', reducedMotion: 'reduce' });
});

test('every control has a name and every picture has an alt attribute', async () => {
  await studioPage(async ({ page, open }) => {
    for (const view of ['month', 'wall', 'list', 'queue', 'plan']) {
      await open(`#/s/${view}?today=${TODAY}`);
      await page.waitForTimeout(400);
      const bad = await page.evaluate(() => [...document.querySelectorAll('.studio button, .studio a[href], .studio select, .studio input')].filter((e) => {
        if (e.offsetParent === null) return false;
        const name = (e.getAttribute('aria-label') || e.textContent || e.getAttribute('title') || e.labels?.[0]?.textContent || e.getAttribute('placeholder') || '').trim();
        return !name;
      }).map((e) => e.outerHTML.slice(0, 90)));
      assert.deepEqual(bad, [], `${view}: controls without a name`);
      const noAlt = await page.evaluate(() => [...document.querySelectorAll('.studio img')].filter((i) => !i.hasAttribute('alt')).length);
      assert.equal(noAlt, 0, `${view}: pictures without alt`);
    }
    // focus is visible on a keyboard user
    await page.keyboard.press('Tab');
    const ring = await page.evaluate(() => { const a = document.activeElement; return a ? getComputedStyle(a).outlineStyle : 'none'; });
    assert.notEqual(ring, 'none');
  }, { page: true });
});

test('a reel plays in a real player with a key-frame strip; "Open in editor" and the back arrow lead there and home', async () => {
  await studioPage(async ({ page, open, call }) => {
    const { posts } = await overview(call);
    const reel = firstWhere(posts, (p) => p.format === 'reel' && p.video && p.status === 'built');
    const carousel = firstWhere(posts, verifiedBuilt);
    if (reel) {
      await open(`#/s/wall?today=${TODAY}&post=${encodeURIComponent(reel.uid)}`);
      await page.waitForSelector('.detail.open video.vp-video');
      assert.match(await page.locator('video.vp-video').getAttribute('src'), /\.mp4/);
      await page.waitForFunction(() => document.querySelector('video.vp-video')?.duration > 0, null, { timeout: 15000 });
      await page.waitForFunction(() => document.querySelectorAll('.vp-f img').length >= 4, null, { timeout: 20000 });
      await page.keyboard.press('Escape');
    }
    await open(`#/s/wall?today=${TODAY}&post=${encodeURIComponent(carousel.uid)}`);
    await page.waitForSelector('.detail.open a:has-text("Open in editor")');
    await page.click('.detail.open a:has-text("Open in editor")');
    await page.waitForSelector('.page-item');
    await page.click('.topbar button[title="Back to the Studio"]');
    await page.waitForSelector('.studio .detail.open');
    assert.match(await page.evaluate(() => location.hash), /#\/s\/wall/);
  }, { page: true });
});

test('a sample project with no calendar still shows its documents', async () => {
  const work = mkdtempSync(join(tmpdir(), 'nordle-studio-sample-'));
  cpSync(join(ROOT, 'samples', 'little-gannet'), join(work, 'projects', 'little-gannet'), { recursive: true, filter: (s) => !/[\\/](out|sources)([\\/]|$)/.test(s) });
  const app = createNordleServer({ roots: [join(work, 'projects')], token: TOKEN, agentToken: AGENT });
  const port = await app.listen(0);
  try {
    const r = await (await fetch(`http://127.0.0.1:${port}/api/studio`, { headers: { 'x-nordle-token': TOKEN } })).json();
    assert.equal(r.projects.length, 1);
    assert.deepEqual(r.posts.map((p) => p.uid).sort(), ['little-gannet:~behind-the-roast-reel', 'little-gannet:~open-late-story', 'little-gannet:~spring-menu-carousel']);
    assert.ok(r.posts.every((p) => p.date === null && p.status === 'built'));
  } finally { await app.close(); rmSync(work, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 }); }
});

test('an empty workspace gets a designed screen, not a blank one', async () => {
  const work = mkdtempSync(join(tmpdir(), 'nordle-studio-empty-'));
  mkdirSync(join(work, 'projects'));
  const app = createNordleServer({ roots: [join(work, 'projects')], token: TOKEN, agentToken: AGENT });
  const port = await app.listen(0);
  const context = await (await getBrowser()).newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(`http://127.0.0.1:${port}/#/s/wall`);
    await page.waitForSelector('.blank h2');
    assert.match(await page.locator('.blank h2').textContent(), /No posts yet/);
    await page.goto(`http://127.0.0.1:${port}/#/s/plan`);
    await page.waitForSelector('.blank h2');
    assert.match(await page.locator('.blank h2').textContent(), /No brands yet/);
  } finally { await app.close(); await context.close(); rmSync(work, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 }); }
});
