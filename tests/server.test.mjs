// The editor's server: security rules, edits (validation, history, undo, locks), review (comments, versions, approvals),
// uploads, live events.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../tools/validate.mjs';
import { createNordleServer } from '../src/server/http.mjs';

let app, base, port, work, projectDir;
const P = 'little-gannet';
const DOC = `/api/projects/${P}/docs/spring-menu-carousel`;

before(async () => {
  work = mkdtempSync(join(tmpdir(), 'nordle-server-'));
  projectDir = join(work, 'projects', P);
  cpSync(join(ROOT, 'samples', P), projectDir, { recursive: true, filter: (s) => !/[\\/](out|sources)([\\/]|$)/.test(s) });
  app = createNordleServer({ roots: [join(work, 'projects')], token: 'test-token-0123456789abcdef0123456' });
  port = await app.listen(0);
  base = `http://127.0.0.1:${port}`;
});
after(async () => { await app.close(); rmSync(work, { recursive: true, force: true }); });

const H = { 'x-nordle-token': 'test-token-0123456789abcdef0123456', 'content-type': 'application/json' };
async function call(method, path, body, headers = {}) {
  const res = await fetch(base + path, { method, headers: { ...H, ...headers }, body: body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text, headers: res.headers };
}
const patch = (ops, extra = {}) => call('POST', `${DOC}/patch`, { ops, ...extra });
const getDoc = async () => (await call('GET', DOC)).json;
const textOf = (doc) => doc.pages[0].layers.find((l) => l.id === 'sub').text;

test('rejects requests for other host names, missing tokens, and the wrong content type', async () => {
  const withHost = (host) => new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/', headers: { host } }, (res) => { res.resume(); resolve(res.statusCode); });
  });
  assert.equal(await withHost('evil.example.com'), 403);
  assert.equal(await withHost(`evil.example.com:${port}`), 403);
  assert.equal(await withHost(`localhost:${port}`), 200);
  assert.equal((await fetch(`${base}/api/projects`)).status, 401);
  assert.equal((await fetch(`${base}/api/projects`, { headers: { 'x-nordle-token': 'wrong' } })).status, 401);
  assert.equal((await call('POST', `${DOC}/patch`, 'ops=1', { 'content-type': 'application/x-www-form-urlencoded' })).status, 415);
  assert.equal((await call('POST', `${DOC}/patch`, 'ops=1', { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await call('GET', '/api/nope')).status, 404);
});

test('the page carries the token and a strict content security policy; no CORS headers anywhere', async () => {
  const res = await fetch(`${base}/`);
  const html = await res.text();
  assert.match(html, /name="nordle-token" content="test-token-0123456789abcdef0123456"/);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  assert.equal((await call('GET', '/api/meta')).headers.get('access-control-allow-origin'), null);
});

test('static files: the app and shared code are served; everything else is not', async () => {
  assert.equal((await fetch(`${base}/app/main.js`)).status, 200);
  assert.equal((await fetch(`${base}/src/shared/ops.mjs`)).status, 200);
  assert.equal((await fetch(`${base}/src/render/html.mjs`)).status, 200);
  assert.equal((await fetch(`${base}/src/render/render.mjs`)).status, 404);
  assert.equal((await fetch(`${base}/src/server/store.mjs`)).status, 404);
  assert.equal((await fetch(`${base}/package.json`)).status, 404);
  assert.equal((await fetch(`${base}/fonts/manifest.json`)).status, 200);
  assert.equal((await fetch(`${base}/fonts/inter/wght.css`)).status, 200);
  for (const bad of ['/app/../package.json', '/app/%2e%2e/package.json', '/fonts/..%5cpackage.json', '/p/little-gannet/../../package.json', '/p/little-gannet/%2e%2e/%2e%2e/package.json']) {
    assert.equal((await fetch(`${base}${bad}`)).status, 404, bad);
  }
});

test('project files: images and brand are served sandboxed; history and review folders are hidden', async () => {
  const img = await fetch(`${base}/p/${P}/assets/logo.svg`);
  assert.equal(img.status, 200);
  assert.match(img.headers.get('content-security-policy'), /sandbox/);
  assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await fetch(`${base}/p/${P}/brand.json`)).status, 200);
  await patch([{ op: 'replace', path: '/title', value: 'Spring menu carousel' }]); // creates history
  assert.ok(existsSync(join(projectDir, 'history', 'spring-menu-carousel.jsonl')));
  assert.equal((await fetch(`${base}/p/${P}/history/spring-menu-carousel.jsonl`)).status, 404);
  assert.equal((await fetch(`${base}/p/${P}/review/spring-menu-carousel.json`)).status, 404);
  assert.equal((await fetch(`${base}/p/${P}/.hidden`)).status, 404);
});

test('lists projects and documents, and returns a document with its sizes and brand', async () => {
  const list = (await call('GET', '/api/projects')).json.projects;
  const p = list.find((x) => x.id === P);
  assert.ok(p && p.docs.some((d) => d.id === 'spring-menu-carousel' && d.kind === 'carousel'));
  const d = await getDoc();
  assert.equal(d.doc.id, 'spring-menu-carousel');
  assert.deepEqual(d.sizes.map((s) => s.id), ['ig-feed-4x5', 'li-feed-4x5']);
  assert.equal(d.sizes[0].w, 1080);
  assert.equal(d.brand.id, 'little-gannet');
});

test('an edit is validated, saved to disk, versioned and written to the history', async () => {
  const before = await getDoc();
  const r = await patch([{ op: 'replace', path: '/pages/0/layers/2/text', value: 'Three new pours. Open from 7.' }], { baseVersion: before.v, note: 'shorter' });
  assert.equal(r.status, 200);
  assert.equal(r.json.v, before.v + 1);
  assert.equal(textOf((await getDoc()).doc), 'Three new pours. Open from 7.');
  const onDisk = JSON.parse(readFileSync(join(projectDir, 'docs', 'spring-menu-carousel.json'), 'utf8'));
  assert.equal(textOf(onDisk), 'Three new pours. Open from 7.');
  const lines = readFileSync(join(projectDir, 'history', 'spring-menu-carousel.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const last = lines[lines.length - 1];
  assert.equal(last.v, r.json.v);
  assert.equal(last.note, 'shorter');
  assert.equal(last.actor, 'human');
  assert.equal(last.inverse[0].op, 'replace');
});

test('an edit that would break the document is refused and changes nothing', async () => {
  const before = await getDoc();
  for (const [ops, status] of [
    [[{ op: 'replace', path: '/pages/0/layers/0/style/color', value: '$brand.colors.nope' }], 422],
    [[{ op: 'replace', path: '/sizes', value: ['not-a-size'] }], 422],
    [[{ op: 'replace', path: '/pages/0/layers/9/text', value: 'x' }], 400],
    [[{ op: 'add', path: '/__proto__/x', value: 1 }], 400],
    [[{ op: 'add', path: '/pages/0/layers/-', value: { id: 'dup', type: 'text' } }], 422],
    [[{ op: 'replace', path: '/pages/0/layers/3/src', value: 'assets/does-not-exist.png' }], 422],
    [[{ op: 'replace', path: '/pages/0/layers/3/src', value: '../../secret.png' }], 422],
  ]) {
    const r = await patch(ops);
    assert.equal(r.status, status, JSON.stringify(ops));
    assert.ok(r.json.errors.length > 0);
  }
  const after = await getDoc();
  assert.equal(after.v, before.v);
  assert.deepEqual(after.doc, before.doc);
});

test('stale edits: merged when they touch different places, refused when they overlap or restructure', async () => {
  const start = await getDoc();
  const a = await patch([{ op: 'replace', path: '/pages/0/layers/0/text', value: 'NEW THIS WEEK' }], { baseVersion: start.v });
  assert.equal(a.status, 200);
  const merged = await patch([{ op: 'replace', path: '/pages/0/layers/4/text', value: 'Swipe now' }], { baseVersion: start.v });
  assert.equal(merged.status, 200, JSON.stringify(merged.json));
  const clash = await patch([{ op: 'replace', path: '/pages/0/layers/0/text', value: 'CLASH' }], { baseVersion: start.v });
  assert.equal(clash.status, 409);
  const mid = await getDoc();
  await patch([{ op: 'add', path: '/pages/0/layers/-', value: { id: 'extra', type: 'shape', shape: 'rect' } }], { baseVersion: mid.v });
  const afterStructure = await patch([{ op: 'replace', path: '/pages/0/layers/0/text', value: 'x' }], { baseVersion: mid.v });
  assert.equal(afterStructure.status, 409);
});

test('undo and redo restore exact earlier states, and a new edit clears redo', async () => {
  const s0 = await getDoc();
  await patch([{ op: 'replace', path: '/pages/0/layers/2/text', value: 'one' }]);
  await patch([{ op: 'replace', path: '/pages/0/layers/2/text', value: 'two' }]);
  assert.equal((await call('POST', `${DOC}/undo`, {})).status, 200);
  assert.equal(textOf((await getDoc()).doc), 'one');
  assert.equal((await call('POST', `${DOC}/undo`, {})).status, 200);
  assert.equal(textOf((await getDoc()).doc), textOf(s0.doc));
  assert.equal((await call('POST', `${DOC}/redo`, {})).status, 200);
  assert.equal(textOf((await getDoc()).doc), 'one');
  assert.equal((await getDoc()).canRedo, true);
  await patch([{ op: 'replace', path: '/pages/0/layers/2/text', value: 'three' }]);
  const d = await getDoc();
  assert.equal(d.canRedo, false);
  assert.equal((await call('POST', `${DOC}/redo`, {})).status, 409);
});

test('locks: Claude cannot change a locked layer or page; the owner can', async () => {
  await patch([{ op: 'add', path: '/pages/0/layers/1/lock', value: true }]);
  const asClaude = await patch([{ op: 'replace', path: '/pages/0/layers/1/style/size', value: 90 }], { actor: 'claude' });
  assert.equal(asClaude.status, 403);
  assert.match(asClaude.json.errors[0].message, /locked/);
  const unlockAsClaude = await patch([{ op: 'replace', path: '/pages/0/layers/1/lock', value: false }], { actor: 'claude' });
  assert.equal(unlockAsClaude.status, 403);
  const other = await patch([{ op: 'replace', path: '/pages/0/layers/2/text', value: 'Claude may edit this' }], { actor: 'claude' });
  assert.equal(other.status, 200);
  assert.equal((await patch([{ op: 'replace', path: '/pages/0/layers/1/style/size', value: 130 }])).status, 200);
  assert.equal((await patch([{ op: 'replace', path: '/pages/0/layers/1/lock', value: false }])).status, 200);
  await patch([{ op: 'add', path: '/pages/1/lock', value: true }]);
  assert.equal((await patch([{ op: 'replace', path: '/pages/1/layers/3/text', value: 'x' }], { actor: 'claude' })).status, 403);
  assert.equal((await patch([{ op: 'remove', path: '/pages/1' }], { actor: 'claude' })).status, 403);
  await patch([{ op: 'remove', path: '/pages/1/lock' }]);
  assert.equal((await call('POST', `${DOC}/patch`, { ops: [], actor: 'robot' })).status, 400);
});

const REVIEW = `${DOC}/review`;
const comment = (id, extra = {}) => ({ id, page: 'cover', x: 0.4, y: 0.3, layer: 'headline', text: 'Make this punchier', author: 'human', created: new Date().toISOString(), status: 'open', ...extra });

test('review: comments are validated, added, replied to and resolved', async () => {
  assert.equal((await call('POST', `${REVIEW}/patch`, { ops: [{ op: 'add', path: '/comments/-', value: { id: 'x', page: 'cover' } }] })).status, 422);
  assert.equal((await call('POST', `${REVIEW}/patch`, { ops: [{ op: 'add', path: '/comments/-', value: comment('c-one', { x: 3 }) }] })).status, 422);
  assert.equal((await call('POST', `${REVIEW}/patch`, { ops: [{ op: 'add', path: '/comments/-', value: comment('c-one') }] })).status, 200);
  const reply = { id: 'r-1', author: 'claude', text: 'Done', created: new Date().toISOString() };
  assert.equal((await call('POST', `${REVIEW}/patch`, { ops: [{ op: 'add', path: '/comments/0/replies', value: [reply] }] })).status, 200);
  assert.equal((await call('POST', `${REVIEW}/patch`, { ops: [{ op: 'replace', path: '/comments/0/status', value: 'resolved' }] })).status, 200);
  const r = (await call('GET', REVIEW)).json.review;
  assert.equal(r.comments[0].status, 'resolved');
  assert.equal(r.comments[0].replies[0].text, 'Done');
  const sneaky = { id: 'v9', name: 'Sneaky', created: new Date().toISOString(), docV: 0, file: 'review/versions/spring-menu-carousel/v9.json' };
  assert.equal((await call('POST', `${REVIEW}/patch`, { ops: [{ op: 'add', path: '/versions/-', value: sneaky }] })).status, 400, 'versions have their own action');
});

test('review: saving a version snapshots the document and marks resolved comments as fixed in it', async () => {
  const v1 = await call('POST', `${REVIEW}/versions`, { name: 'First draft', note: 'for Sam' });
  assert.equal(v1.status, 200);
  assert.equal(v1.json.version.id, 'v1');
  assert.ok(existsSync(join(projectDir, 'review', 'versions', 'spring-menu-carousel', 'v1.json')));
  const r = (await call('GET', REVIEW)).json.review;
  assert.equal(r.comments[0].resolvedIn, 'v1');
  assert.equal(r.versions[0].name, 'First draft');
  const snap = (await call('GET', `${REVIEW}/versions/v1/doc`)).json.doc;
  assert.equal(snap.id, 'spring-menu-carousel');
});

test('review: approval snapshots the current document, goes stale after a change, and can be withdrawn', async () => {
  const before = (await getDoc());
  const ap = await call('POST', `${REVIEW}/approve`, { note: 'Good to post' });
  assert.equal(ap.status, 200);
  assert.equal(ap.json.approval.docV, before.v);
  const r = (await call('GET', REVIEW)).json.review;
  assert.equal(r.versions[r.versions.length - 1].docV, before.v);
  await patch([{ op: 'replace', path: '/title', value: 'Spring menu (changed)' }]);
  const now = await getDoc();
  const active = [...now.review.approvals].reverse().find((a) => !a.revoked);
  assert.ok(active.docV < now.v);
  assert.equal((await call('DELETE', `${REVIEW}/approve`)).status, 200);
  assert.equal((await call('DELETE', `${REVIEW}/approve`)).status, 409);
});

test('review: restoring a version brings the old content back, and the restore can be undone', async () => {
  const v1doc = (await call('GET', `${REVIEW}/versions/v1/doc`)).json.doc;
  await patch([{ op: 'replace', path: '/pages/0/layers/2/text', value: 'Something else entirely' }]);
  const before = await getDoc();
  const restored = await call('POST', `${REVIEW}/versions/v1/restore`, {});
  assert.equal(restored.status, 200, JSON.stringify(restored.json));
  const after = await getDoc();
  assert.deepEqual(after.doc.pages, v1doc.pages);
  assert.equal((await call('POST', `${DOC}/undo`, {})).status, 200);
  assert.equal(textOf((await getDoc()).doc), textOf(before.doc));
});

test('hand-off text lists open comments with the words on the layer they point at', async () => {
  await call('POST', `${REVIEW}/patch`, { ops: [{ op: 'add', path: '/comments/-', value: comment('c-two', { text: 'Swap the cup for beans', x: 0.7, y: 0.8, layer: 'cup' }) }, { op: 'add', path: '/comments/-', value: comment('c-three', { layer: 'headline', text: 'Too big' }) }] });
  const { text } = (await call('GET', `${REVIEW}/handoff`)).json;
  assert.match(text, /# Nordle feedback: /);
  assert.match(text, /Open comments \(2\)/);
  assert.match(text, /\[c-three\] page "cover".*on layer "headline" \("Spring menu is here"\): Too big/);
  assert.match(text, /\[c-two\].*on layer "cup".*Swap the cup for beans/);
  assert.match(text, /Resolved \(1\)/);
  assert.match(text, /fixed in First draft/);
});

test('uploads: real images only, names are cleaned, existing files are never overwritten', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex');
  const up = (name, body, type = 'application/octet-stream') => call('POST', `/api/projects/${P}/assets`, body, { 'content-type': type, 'x-filename': encodeURIComponent(name) });
  const a = await up('My Photo (1).PNG', png);
  assert.equal(a.status, 201);
  assert.equal(a.json.path, 'assets/my-photo-1.png');
  const b = await up('My Photo (1).PNG', png);
  assert.equal(b.json.path, 'assets/my-photo-1-2.png');
  assert.equal((await fetch(`${base}/p/${P}/assets/my-photo-1.png`)).status, 200);
  assert.equal((await up('notes.txt', Buffer.from('hello'))).status, 415);
  assert.equal((await up('fake.png', Buffer.from('not a png at all'))).status, 415);
  assert.equal((await up('x.svg', Buffer.from('<html><script>alert(1)</script></html>'))).status, 415);
  assert.equal((await up('ok.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).status, 201);
  assert.equal((await up('../../evil.png', png)).json.path, 'assets/evil.png');
  assert.equal((await up('a.png', png, 'application/json')).status, 415);
});

test('creating a project and a post', async () => {
  const p = await call('POST', '/api/projects', { name: 'Test Studio' });
  assert.equal(p.status, 201);
  assert.equal(p.json.id, 'test-studio');
  const info = (await call('GET', '/api/projects/test-studio')).json;
  assert.equal(info.brand.name, 'Test Studio');
  const d = await call('POST', '/api/projects/test-studio/docs', { title: 'Hello world', kind: 'carousel', sizes: ['ig-feed-4x5', 'ig-story-9x16'] });
  assert.equal(d.status, 201);
  assert.equal(d.json.id, 'hello-world');
  const doc = (await call('GET', '/api/projects/test-studio/docs/hello-world')).json;
  assert.equal(doc.doc.pages.length, 1);
  assert.equal((await call('POST', '/api/projects/test-studio/docs', { title: 'Reel', kind: 'video' })).status, 400);
  assert.equal((await call('POST', '/api/projects/test-studio/docs', { title: '' })).status, 400);
  assert.equal((await call('POST', '/api/projects', { name: '   ' })).status, 400);
});

test('live events: another tab hears about an edit, and the editing tab can tell it was its own', async () => {
  const events = [];
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/events?project=${P}&doc=spring-menu-carousel&t=test-token-0123456789abcdef0123456`, { signal: ctrl.signal });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  (async () => {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value);
        for (const chunk of buf.split('\n\n').slice(0, -1)) if (chunk.startsWith('data: ')) events.push(JSON.parse(chunk.slice(6)));
        buf = buf.split('\n\n').pop();
      }
    } catch { /* aborted */ }
  })();
  await patch([{ op: 'replace', path: '/pages/0/layers/2/text', value: 'event test' }], { note: 'ev' });
  await call('POST', `${DOC}/patch`, { ops: [{ op: 'replace', path: '/pages/0/layers/2/text', value: 'event test 2' }] }, { 'x-nordle-client': 'tab-a' });
  for (let i = 0; i < 40 && events.filter((e) => e.type === 'doc').length < 2; i++) await new Promise((r) => setTimeout(r, 25));
  ctrl.abort();
  assert.equal(events[0].type, 'hello');
  const docEvents = events.filter((e) => e.type === 'doc');
  assert.equal(docEvents.length, 2);
  assert.equal(docEvents[1].origin, 'tab-a');
  assert.equal(docEvents[1].ops[0].value, 'event test 2');
  assert.equal(docEvents[0].v + 1, docEvents[1].v);
});

test('the body size limit is enforced', async () => {
  const big = JSON.stringify({ ops: [{ op: 'replace', path: '/title', value: 'x'.repeat(1_100_000) }] });
  const r = await call('POST', `${DOC}/patch`, big).catch((e) => ({ status: 'reset', e }));
  assert.ok(r.status === 413 || r.status === 'reset', String(r.status));
});

test('verify finds nothing wrong with the shipped sample and returns the checked files', async () => {
  writeFileSync(join(projectDir, 'docs', 'spring-menu-carousel.json'), readFileSync(join(ROOT, 'samples', P, 'docs', 'spring-menu-carousel.json')));
  mkdirSync(join(projectDir, 'out'), { recursive: true });
  const fresh = createNordleServer({ roots: [join(work, 'projects')], token: 'test-token-0123456789abcdef0123456' });
  const p2 = await fresh.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${p2}/api/projects/${P}/docs/spring-menu-carousel/verify`, { method: 'POST', headers: H, body: '{}' });
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(json.issues.filter((i) => i.level === 'error'), []);
    assert.ok(json.files.length >= 5);
    const exp = await fetch(`http://127.0.0.1:${p2}/api/projects/${P}/docs/spring-menu-carousel/export`, { method: 'POST', headers: H, body: JSON.stringify({ sizes: ['ig-feed-4x5'], format: 'png' }) });
    const ej = await exp.json();
    assert.equal(ej.files.length, 5);
    assert.ok(ej.sheet.endsWith('sheet.png'));
    assert.equal((await fetch(`http://127.0.0.1:${p2}/p/${P}/${ej.files[0].path}`)).status, 200);
  } finally { await fresh.close(); }
});
