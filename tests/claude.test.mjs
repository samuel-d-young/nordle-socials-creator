// Claude's side of the server: what the agent token may and may not do, the autonomy dial, accept and reject,
// suggestions, Explore takes, pictures for Claude to look at.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../tools/validate.mjs';
import { createNordleServer } from '../src/server/http.mjs';

const HUMAN = 'human-token-0123456789abcdef01234567';
const AGENT = 'agent-token-0123456789abcdef01234567';
const P = 'little-gannet';
let app, base, work, projectDir, runtimeDir;

before(async () => {
  work = mkdtempSync(join(tmpdir(), 'nordle-claude-'));
  projectDir = join(work, 'projects', P);
  runtimeDir = join(work, 'runtime');
  cpSync(join(ROOT, 'samples', P), projectDir, { recursive: true, filter: (s) => !/[\\/](out|sources)([\\/]|$)/.test(s) });
  app = createNordleServer({ roots: [join(work, 'projects')], token: HUMAN, agentToken: AGENT, runtimeDir });
  const port = await app.listen(0);
  base = `http://127.0.0.1:${port}`;
});
after(async () => { await app.close(); rmSync(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }); });

async function call(role, method, path, body, headers = {}) {
  const res = await fetch(base + path, { method, headers: { 'x-nordle-token': role === 'agent' ? AGENT : HUMAN, 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json };
}
const D = (doc) => `/api/projects/${P}/docs/${doc}`;
const human = (m, p, b) => call('human', m, p, b);
const agent = (m, p, b) => call('agent', m, p, b);
const getDoc = async (doc = 'spring-menu-carousel') => (await human('GET', D(doc))).json;
const reviewOf = async (doc = 'spring-menu-carousel') => (await human('GET', `${D(doc)}/review`)).json.review;
const setAutonomy = (v, doc = 'spring-menu-carousel') => human('POST', `${D(doc)}/review/settings`, { autonomy: v });
const subText = (d) => d.doc.pages[0].layers.find((l) => l.id === 'sub').text;
const SUB = '/pages/0/layers/2/text';
const edit = (value, note = 'test') => agent('POST', `${D('spring-menu-carousel')}/patch`, { ops: [{ op: 'replace', path: SUB, value }], note });

test('the runtime file has Claude’s token and never the owner’s, and goes away on close', async () => {
  const f = join(runtimeDir, 'runtime.json');
  assert.ok(existsSync(f));
  const text = readFileSync(f, 'utf8');
  assert.ok(text.includes(AGENT));
  assert.ok(!text.includes(HUMAN));
  assert.equal(JSON.parse(text).port, Number(base.split(':').pop()));
  const extra = createNordleServer({ roots: [join(work, 'projects')], runtimeDir: join(work, 'runtime2') });
  await extra.listen(0);
  assert.ok(existsSync(join(work, 'runtime2', 'runtime.json')));
  await extra.close();
  assert.ok(!existsSync(join(work, 'runtime2', 'runtime.json')));
});

test('Claude can read and edit, but cannot do the things that belong to the owner', async () => {
  assert.equal((await agent('GET', '/api/meta')).json.role, 'agent');
  assert.equal((await human('GET', '/api/meta')).json.role, 'human');
  assert.equal((await agent('GET', D('spring-menu-carousel'))).status, 200);
  const forbidden = [
    ['POST', `${D('spring-menu-carousel')}/undo`, {}],
    ['POST', `${D('spring-menu-carousel')}/redo`, {}],
    ['POST', `${D('spring-menu-carousel')}/review/settings`, { autonomy: 'apply' }],
    ['POST', `${D('spring-menu-carousel')}/review/approve`, {}],
    ['DELETE', `${D('spring-menu-carousel')}/review/approve`],
    ['POST', `${D('spring-menu-carousel')}/review/patch`, { ops: [] }],
    ['POST', `${D('spring-menu-carousel')}/review/versions/v1/restore`, {}],
    ['POST', `${D('spring-menu-carousel')}/review/changes/accept-all`, {}],
    ['POST', `${D('spring-menu-carousel')}/review/changes/ch-x/accept`, {}],
    ['POST', `${D('spring-menu-carousel')}/review/changes/ch-x/reject`, {}],
    ['POST', `${D('spring-menu-carousel')}/explore/take-1/adopt`, {}],
    ['DELETE', `${D('spring-menu-carousel')}/explore`],
    ['POST', '/api/projects', { name: 'Sneaky' }],
  ];
  for (const [m, p, b] of forbidden) assert.equal((await agent(m, p, b)).status, 403, `${m} ${p}`);
  assert.equal((await human('POST', `${D('spring-menu-carousel')}/review/comment`, { page: 'cover', text: 'x' })).status, 403, 'the owner comments with the pin tool, not as Claude');
  assert.equal((await setAutonomy('apply')).status, 200);
  await setAutonomy('review');
});

test('default: Claude’s edit is applied and flagged for review, with a plain-words summary and what it touched', async () => {
  assert.equal((await reviewOf()).settings?.autonomy ?? 'review', 'review');
  const r = await edit('Fresh pours. Open from 7.', 'shorter subtitle');
  assert.equal(r.status, 200);
  assert.equal(r.json.mode, 'applied');
  assert.equal(r.json.status, 'pending');
  assert.match(r.json.summary[0], /^cover\/sub: text "Three new pours/);
  assert.ok(r.json.changeId);
  assert.equal(subText(await getDoc()), 'Fresh pours. Open from 7.');
  const ch = (await reviewOf()).changes.find((c) => c.id === r.json.changeId);
  assert.equal(ch.status, 'pending');
  assert.equal(ch.mode, 'applied');
  assert.deepEqual(ch.touched, [{ page: 'cover', layer: 'sub' }]);
  assert.equal(ch.regions[0].key, 'page:cover');
  const hist = readFileSync(join(projectDir, 'history', 'spring-menu-carousel.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
  assert.equal(hist.actor, 'claude');
  assert.equal(hist.note, 'shorter subtitle');
});

test('rejecting an applied change puts back exactly what was there; accepting keeps it', async () => {
  const before = (await getDoc()).doc;
  const c1 = (await edit('Reject me')).json.changeId;
  assert.notDeepEqual((await getDoc()).doc, before);
  const rej = await human('POST', `${D('spring-menu-carousel')}/review/changes/${c1}/reject`, {});
  assert.equal(rej.status, 200, JSON.stringify(rej.json));
  assert.deepEqual((await getDoc()).doc.pages, before.pages);
  assert.equal((await reviewOf()).changes.find((c) => c.id === c1).status, 'rejected');
  assert.equal((await human('POST', `${D('spring-menu-carousel')}/review/changes/${c1}/reject`, {})).status, 409, 'already decided');

  const c2 = (await edit('Keep me')).json.changeId;
  assert.equal((await human('POST', `${D('spring-menu-carousel')}/review/changes/${c2}/accept`, {})).status, 200);
  assert.equal(subText(await getDoc()), 'Keep me');
  assert.equal((await reviewOf()).changes.find((c) => c.id === c2).status, 'accepted');
});

test('rejecting is refused, with a reason, if the same part changed again afterwards', async () => {
  const c = (await edit('Claude’s words')).json.changeId;
  await human('POST', `${D('spring-menu-carousel')}/patch`, { ops: [{ op: 'replace', path: '/pages/0/layers/0/text', value: 'OWNER EDIT ON THE SAME PAGE' }] });
  const r = await human('POST', `${D('spring-menu-carousel')}/review/changes/${c}/reject`, {});
  assert.equal(r.status, 409);
  assert.match(r.json.errors[0].message, /cannot be taken back cleanly/);
  assert.equal(subText(await getDoc()), 'Claude’s words', 'nothing was changed');
  assert.equal((await human('POST', `${D('spring-menu-carousel')}/review/changes/${c}/accept`, {})).status, 200);
});

test('reject all takes back several changes on one page, newest first', async () => {
  await human('POST', `${D('spring-menu-carousel')}/review/changes/accept-all`, {}); // settle anything left over from earlier tests
  const start = (await getDoc()).doc;
  await edit('first');
  await agent('POST', `${D('spring-menu-carousel')}/patch`, { ops: [{ op: 'replace', path: '/pages/0/layers/1/style/size', value: 90 }], note: 'smaller headline' });
  await agent('POST', `${D('spring-menu-carousel')}/patch`, { ops: [{ op: 'replace', path: '/copy/caption', value: 'A new caption.' }], note: 'caption' });
  const pending = (await reviewOf()).changes.filter((c) => c.status === 'pending');
  assert.equal(pending.length, 3);
  const r = await human('POST', `${D('spring-menu-carousel')}/review/changes/reject-all`, {});
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.done, 3);
  assert.deepEqual((await getDoc()).doc, start);
});

test('autonomy "apply": the edit stands, recorded as accepted automatically', async () => {
  await setAutonomy('apply');
  const r = await edit('Straight in');
  assert.equal(r.json.mode, 'applied');
  assert.equal(r.json.status, 'accepted');
  const ch = (await reviewOf()).changes.find((c) => c.id === r.json.changeId);
  assert.equal(ch.status, 'accepted');
  assert.equal(ch.auto, true);
  assert.equal(ch.regions, undefined, 'no need to keep the old page around');
  await setAutonomy('review');
});

test('autonomy "suggest": nothing changes; the suggestion is checked, stored, previewable, and applied only when accepted', async () => {
  await setAutonomy('suggest');
  const v0 = (await getDoc()).v;
  const text0 = subText(await getDoc());
  const r = await edit('Only a suggestion');
  assert.equal(r.status, 200);
  assert.equal(r.json.mode, 'proposed');
  assert.equal((await getDoc()).v, v0, 'the document did not change');
  assert.equal(subText(await getDoc()), text0);
  const proposal = (await reviewOf()).changes.find((c) => c.id === r.json.changeId);
  assert.equal(proposal.status, 'pending');
  assert.equal(proposal.baseV, v0);

  // a bad suggestion is refused straight away, the same way an edit would be
  assert.equal((await agent('POST', `${D('spring-menu-carousel')}/patch`, { ops: [{ op: 'replace', path: '/pages/0/layers/0/style/color', value: '$brand.colors.nope' }] })).status, 422);

  // Claude can look at what the suggestion would look like
  const shot = await agent('POST', `${D('spring-menu-carousel')}/render`, { page: 'cover', size: 'ig-feed-4x5', change: proposal.id, scale: 0.5 });
  assert.equal(shot.status, 200, JSON.stringify(shot.json));
  const bytes = Buffer.from(shot.json.base64, 'base64');
  assert.equal(bytes[0], 0xff);
  assert.equal(shot.json.w, 540);
  assert.equal(subText(await getDoc()), text0, 'previewing changed nothing');

  const accept = await human('POST', `${D('spring-menu-carousel')}/review/changes/${proposal.id}/accept`, {});
  assert.equal(accept.status, 200, JSON.stringify(accept.json));
  assert.equal(subText(await getDoc()), 'Only a suggestion');
  const hist = readFileSync(join(projectDir, 'history', 'spring-menu-carousel.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
  assert.equal(hist.actor, 'human');
  assert.match(hist.note, /^Accepted:/);
  await setAutonomy('review');
});

test('a suggestion that no longer fits, or that touches something locked since, cannot be accepted', async () => {
  await setAutonomy('suggest');
  const p1 = (await edit('Stale suggestion')).json.changeId;
  await human('POST', `${D('spring-menu-carousel')}/patch`, { ops: [{ op: 'add', path: '/pages/0/layers/-', value: { id: 'late', type: 'shape', shape: 'rect' } }] });
  const stale = await human('POST', `${D('spring-menu-carousel')}/review/changes/${p1}/accept`, {});
  assert.equal(stale.status, 409);
  assert.match(stale.json.errors[0].message, /changed since Claude suggested/);
  await human('POST', `${D('spring-menu-carousel')}/review/changes/${p1}/reject`, {});

  await human('POST', `${D('spring-menu-carousel')}/patch`, { ops: [{ op: 'add', path: '/pages/0/layers/2/lock', value: false }] });
  const p2 = (await edit('Locked suggestion')).json.changeId;
  await human('POST', `${D('spring-menu-carousel')}/patch`, { ops: [{ op: 'replace', path: '/pages/0/layers/2/lock', value: true }] });
  const locked = await human('POST', `${D('spring-menu-carousel')}/review/changes/${p2}/accept`, {});
  assert.equal(locked.status, 403, 'a lock added after the suggestion still protects the layer');
  assert.match(locked.json.errors[0].message, /locked/);
  await human('POST', `${D('spring-menu-carousel')}/review/changes/${p2}/reject`, {});
  await human('POST', `${D('spring-menu-carousel')}/patch`, { ops: [{ op: 'remove', path: '/pages/0/layers/2/lock' }] });
  await setAutonomy('review');
});

test('a suggestion for a locked layer is refused when it is made', async () => {
  await human('POST', `${D('spring-menu-carousel')}/patch`, { ops: [{ op: 'add', path: '/pages/0/layers/2/lock', value: true }] });
  for (const mode of ['suggest', 'review', 'apply']) {
    await setAutonomy(mode);
    const r = await edit('Not allowed');
    assert.equal(r.status, 403, mode);
    assert.match(r.json.errors[0].message, /locked/);
  }
  await human('POST', `${D('spring-menu-carousel')}/patch`, { ops: [{ op: 'remove', path: '/pages/0/layers/2/lock' }] });
  await setAutonomy('review');
});

test('only the owner changes the dial, and the generic review route cannot reach settings or changes', async () => {
  assert.equal((await setAutonomy('wild')).status, 400);
  assert.equal((await human('POST', `${D('spring-menu-carousel')}/review/patch`, { ops: [{ op: 'add', path: '/settings', value: { autonomy: 'apply' } }] })).status, 400);
  assert.equal((await human('POST', `${D('spring-menu-carousel')}/review/patch`, { ops: [{ op: 'remove', path: '/changes' }] })).status, 400);
  const saved = JSON.parse(readFileSync(join(projectDir, 'review', 'spring-menu-carousel.json'), 'utf8'));
  assert.equal(saved.settings.autonomy, 'review');
});

test('Claude can comment, reply and resolve; it is always recorded as Claude', async () => {
  const c = await agent('POST', `${D('spring-menu-carousel')}/review/comment`, { page: 'cover', x: 0.2, y: 0.4, layer: 'headline', text: 'Should this be bigger?' });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.equal((await agent('POST', `${D('spring-menu-carousel')}/review/comment`, { page: 'nope', text: 'x' })).status, 404);
  assert.equal((await agent('POST', `${D('spring-menu-carousel')}/review/comment`, { page: 'cover', text: '  ' })).status, 400);
  assert.equal((await agent('POST', `${D('spring-menu-carousel')}/review/reply`, { comment: c.json.id, text: 'Following up' })).status, 200);
  assert.equal((await agent('POST', `${D('spring-menu-carousel')}/review/reply`, { comment: 'c-missing', text: 'x' })).status, 404);
  assert.equal((await agent('POST', `${D('spring-menu-carousel')}/review/resolve`, { comment: c.json.id })).status, 200);
  const mine = (await reviewOf()).comments.find((x) => x.id === c.json.id);
  assert.equal(mine.author, 'claude');
  assert.equal(mine.replies[0].author, 'claude');
  assert.equal(mine.status, 'resolved');
});

test('Claude can save a version (recorded as Claude’s) but cannot restore one', async () => {
  const v = await agent('POST', `${D('spring-menu-carousel')}/review/versions`, { name: 'Claude’s draft', note: 'before the rewrite' });
  assert.equal(v.status, 200);
  assert.equal(v.json.version.author, 'claude');
  assert.equal((await agent('POST', `${D('spring-menu-carousel')}/review/versions/${v.json.version.id}/restore`, {})).status, 403);
});

test('Explore: takes are separate copies; Claude edits them freely; the owner adopts one; locks carry over', async () => {
  await human('POST', `${D('spring-menu-carousel')}/patch`, { ops: [{ op: 'add', path: '/pages/0/layers/3/lock', value: true }] }); // lock the cup
  const made = await agent('POST', `${D('spring-menu-carousel')}/explore`, { count: 3, labels: ['Bold', 'Quiet'], note: 'three directions' });
  assert.equal(made.status, 201);
  assert.deepEqual(made.json.takes.map((t) => t.label), ['Bold', 'Quiet', 'Take 3']);
  const ids = made.json.takes.map((t) => t.id);
  assert.deepEqual(ids, ['spring-menu-carousel-take-1', 'spring-menu-carousel-take-2', 'spring-menu-carousel-take-3']);

  const list = (await human('GET', `/api/projects/${P}`)).json.docs;
  assert.equal(list.find((d) => d.id === ids[0]).explore.of, 'spring-menu-carousel');
  assert.deepEqual((await agent('GET', `${D('spring-menu-carousel')}/explore`)).json.takes.map((t) => t.id), ids);

  // edits to a take apply straight away and leave no pending change behind
  const before = (await reviewOf(ids[0])).changes ?? [];
  const e = await agent('POST', `${D(ids[0])}/patch`, { ops: [{ op: 'replace', path: '/pages/0/layers/1/style/size', value: 160 }], note: 'bold headline' });
  assert.equal(e.status, 200);
  assert.equal(e.json.status, 'accepted');
  assert.equal(((await reviewOf(ids[0])).changes ?? []).length, before.length);
  assert.equal((await getDoc(ids[0])).doc.pages[0].layers[1].style.size, 160);
  assert.equal((await getDoc()).doc.pages[0].layers[1].style.size, 132, 'the original is untouched');
  const locked = await agent('POST', `${D(ids[1])}/patch`, { ops: [{ op: 'replace', path: '/pages/0/layers/3/layout/w', value: 10 }] });
  assert.equal(locked.status, 403, 'the lock came with the copy');
  assert.equal((await agent('POST', `${D(ids[0])}/explore`, { count: 2 })).status, 400, 'a take cannot have takes');

  assert.equal((await agent('POST', `${D('spring-menu-carousel')}/explore/${ids[0]}/adopt`, {})).status, 403);
  const adopt = await human('POST', `${D('spring-menu-carousel')}/explore/${ids[0]}/adopt`, {});
  assert.equal(adopt.status, 200, JSON.stringify(adopt.json));
  assert.equal((await getDoc()).doc.pages[0].layers[1].style.size, 160);
  assert.equal((await getDoc()).doc.id, 'spring-menu-carousel');
  assert.equal((await getDoc()).doc.explore, undefined);
  assert.equal((await human('POST', `${D('spring-menu-carousel')}/undo`, {})).status, 200);
  assert.equal((await getDoc()).doc.pages[0].layers[1].style.size, 132, 'adopting a take can be undone');

  assert.equal((await agent('DELETE', `${D('spring-menu-carousel')}/explore`)).status, 403);
  assert.equal((await human('DELETE', `${D('spring-menu-carousel')}/explore`)).json.discarded, 3);
  assert.ok(readdirSync(join(projectDir, 'trash')).length === 3, 'moved to trash, not deleted');
  assert.equal((await human('GET', D(ids[0]))).status, 404);
  await human('POST', `${D('spring-menu-carousel')}/patch`, { ops: [{ op: 'remove', path: '/pages/0/layers/3/lock' }] });
});

test('Claude can look at a page: a real picture comes back, and bad requests are explained', async () => {
  const shot = await agent('POST', `${D('open-late-story')}/render`, {});
  assert.equal(shot.status, 200);
  assert.equal(shot.json.page, 'main');
  assert.equal(shot.json.size, 'ig-story-9x16');
  assert.equal(shot.json.mime, 'image/jpeg');
  assert.equal(Buffer.from(shot.json.base64, 'base64')[0], 0xff);
  const png = await agent('POST', `${D('open-late-story')}/render`, { format: 'png', size: 'ig-feed-4x5', scale: 0.5 });
  assert.equal(png.json.mime, 'image/png');
  assert.equal(Buffer.from(png.json.base64, 'base64').toString('latin1', 1, 4), 'PNG');
  const bad = await agent('POST', `${D('open-late-story')}/render`, { page: 'nope' });
  assert.equal(bad.status, 400);
  assert.match(bad.json.errors[0].message, /no page "nope"/i);
  assert.equal((await agent('POST', `${D('open-late-story')}/render`, { change: 'ch-missing' })).status, 404);
  assert.equal((await agent('POST', `${D('open-late-story')}/patch`, { note: 'no ops' })).status, 400);
});

test('a lock the owner sets protects against every autonomy setting, including edits Claude makes to the lock itself', async () => {
  await human('POST', `${D('open-late-story')}/patch`, { ops: [{ op: 'add', path: '/pages/0/lock', value: true }] });
  for (const mode of ['suggest', 'review', 'apply']) {
    await human('POST', `${D('open-late-story')}/review/settings`, { autonomy: mode });
    const r = await agent('POST', `${D('open-late-story')}/patch`, { ops: [{ op: 'replace', path: '/pages/0/lock', value: false }] });
    assert.equal(r.status, 403, mode);
  }
});
