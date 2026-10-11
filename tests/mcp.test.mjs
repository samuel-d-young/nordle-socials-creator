// The MCP server, spoken to the way Claude Code speaks to it: JSON-RPC lines over stdio, against a real Nordle server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../tools/validate.mjs';
import { createNordleServer } from '../src/server/http.mjs';

const P = 'little-gannet';
let app, work, runtimeDir, mcp, HUMAN;

class McpProcess {
  constructor(env) {
    this.child = spawn(process.execPath, [join(ROOT, 'mcp.mjs')], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.nextId = 1;
    this.waiting = new Map();
    this.stderr = '';
    this.buffer = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (d) => {
      this.buffer += d;
      let i;
      while ((i = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, i); this.buffer = this.buffer.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line); // anything on stdout that is not JSON would break the protocol: let this throw
        this.waiting.get(msg.id)?.(msg);
      }
    });
    this.child.stderr.on('data', (d) => { this.stderr += d; });
  }
  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no reply to ${method}. stderr: ${this.stderr}`)), 60000);
      this.waiting.set(id, (m) => { clearTimeout(t); resolve(m); });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  notify(method, params) { this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`); }
  async tool(name, args = {}) {
    const m = await this.request('tools/call', { name, arguments: args });
    assert.ok(m.result, JSON.stringify(m));
    return m.result;
  }
  text(result) { return result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'); }
  close() { this.child.stdin.end(); this.child.kill(); }
}

before(async () => {
  work = mkdtempSync(join(tmpdir(), 'nordle-mcp-'));
  runtimeDir = join(work, 'runtime');
  cpSync(join(ROOT, 'samples', P), join(work, 'projects', P), { recursive: true, filter: (s) => !/[\\/](out|sources)([\\/]|$)/.test(s) });
  HUMAN = 'human-token-for-mcp-tests-0123456789';
  app = createNordleServer({ roots: [join(work, 'projects')], token: HUMAN, runtimeDir });
  await app.listen(0);
  mcp = new McpProcess({ NORDLE_RUNTIME_DIR: runtimeDir, NORDLE_NO_AUTOSTART: '1' });
});
after(async () => {
  mcp?.close();
  await app.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

const human = async (method, path, body) => {
  const info = JSON.parse(readFileSync(join(runtimeDir, 'runtime.json'), 'utf8'));
  const res = await fetch(`http://127.0.0.1:${info.port}/api${path}`, { method, headers: { 'x-nordle-token': HUMAN, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return res.json();
};
const DOC = '/projects/little-gannet/docs/spring-menu-carousel';

test('initialize, list the tools, ping, and refuse what it does not know', async () => {
  const init = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'nordle');
  assert.ok(init.result.capabilities.tools);
  assert.match(init.result.instructions, /nordle_render/);
  mcp.notify('notifications/initialized');
  const old = await mcp.request('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  assert.equal(old.result.protocolVersion, '2024-11-05');

  const list = await mcp.request('tools/list');
  const names = list.result.tools.map((t) => t.name);
  for (const n of ['nordle_list_projects', 'nordle_get_guide', 'nordle_get_brand', 'nordle_get_doc', 'nordle_render', 'nordle_update_layer', 'nordle_add_layer',
    'nordle_remove_layer', 'nordle_add_page', 'nordle_set_copy', 'nordle_patch_doc', 'nordle_check', 'nordle_critique', 'nordle_get_feedback', 'nordle_comment', 'nordle_reply',
    'nordle_resolve', 'nordle_new_doc', 'nordle_import_image', 'nordle_save_version', 'nordle_explore', 'nordle_open_editor']) assert.ok(names.includes(n), n);
  for (const t of list.result.tools) {
    assert.match(t.name, /^[a-zA-Z0-9_-]{1,64}$/);
    assert.ok(t.description.length > 40, `${t.name} needs a real description`);
    assert.equal(t.inputSchema.type, 'object');
  }
  assert.deepEqual(list.result.tools.filter((t) => !t.annotations?.readOnlyHint).map((t) => t.annotations?.destructiveHint), list.result.tools.filter((t) => !t.annotations?.readOnlyHint).map(() => false));

  assert.deepEqual((await mcp.request('ping')).result, {});
  assert.equal((await mcp.request('resources/list')).error.code, -32601);
  assert.equal((await mcp.request('tools/call', { name: 'nope', arguments: {} })).error.code, -32602);
  const bad = await mcp.tool('nordle_get_doc', { project: 'little-gannet' });
  assert.equal(bad.isError, true);
  assert.match(mcp.text(bad), /arguments are not right.*doc/);
});

test('reads: projects, guide, brand and a document', async () => {
  const projects = JSON.parse(mcp.text(await mcp.tool('nordle_list_projects')));
  assert.equal(projects[0].project, 'little-gannet');
  assert.ok(projects[0].posts.some((p) => p.doc === 'spring-menu-carousel' && p.kind === 'carousel'));
  assert.match(mcp.text(await mcp.tool('nordle_get_guide')), /Autonomy: what happens to your edit/);
  const brand = JSON.parse(mcp.text(await mcp.tool('nordle_get_brand', { project: P })));
  assert.equal(brand.colors['$brand.colors.accent'], '#D4752B');
  assert.ok(brand.fonts['$brand.fonts.display'].startsWith('Fraunces'));
  assert.ok(brand.voice.bannedPhrases.includes('guaranteed'));
  const doc = JSON.parse(mcp.text(await mcp.tool('nordle_get_doc', { project: P, doc: 'spring-menu-carousel' })));
  assert.equal(doc.autonomy, 'review');
  assert.equal(doc.document.pages.length, 5);
  assert.equal(doc.sizes[0].caption_limit, 2200);
  assert.deepEqual(doc.locked, []);
});

test('Claude looks at a page and gets a real picture back', async () => {
  const r = await mcp.tool('nordle_render', { project: P, doc: 'spring-menu-carousel', page: 'cover', size: 'ig-feed-4x5', scale: 0.5 });
  const img = r.content.find((c) => c.type === 'image');
  assert.equal(img.mimeType, 'image/jpeg');
  assert.equal(Buffer.from(img.data, 'base64')[0], 0xff);
  assert.match(mcp.text(r), /Page "cover" at ig-feed-4x5, 540x675/);
});

test('editing by layer id: update (shared and one size only), add, remove, copy, pages; each says what happened', async () => {
  const upd = await mcp.tool('nordle_update_layer', { project: P, doc: 'spring-menu-carousel', page: 'cover', layer: 'headline', set: { 'style.size': 120, 'layout.x': 10 }, note: 'tighten' });
  assert.notEqual(upd.isError, true, mcp.text(upd));
  assert.match(mcp.text(upd), /APPLIED\. It is flagged in the editor/);
  assert.match(mcp.text(upd), /cover\/headline: .*style\.size 132 → 120/);
  let doc = (await human('GET', DOC)).doc;
  assert.equal(doc.pages[0].layers[1].style.size, 120);

  const one = await mcp.tool('nordle_update_layer', { project: P, doc: 'spring-menu-carousel', layer: 'sub', size: 'li-feed-4x5', set: { 'layout.y': 40 } });
  assert.notEqual(one.isError, true, mcp.text(one));
  doc = (await human('GET', DOC)).doc;
  const sub = doc.pages[0].layers.find((l) => l.id === 'sub');
  assert.equal(sub.layout.y, 36, 'the shared position is untouched');
  assert.equal(sub.overrides['li-feed-4x5'].layout.y, 40);

  const add = await mcp.tool('nordle_add_layer', { project: P, doc: 'spring-menu-carousel', page: 'cover', layer: { type: 'shape', shape: 'ellipse', layout: { anchor: 'center', x: 85, y: 12, w: 8, h: 6 }, style: { fill: '$brand.colors.accent' } } });
  assert.notEqual(add.isError, true, mcp.text(add));
  doc = (await human('GET', DOC)).doc;
  assert.equal(doc.pages[0].layers.at(-1).id, 'ellipse');
  const rm = await mcp.tool('nordle_remove_layer', { project: P, doc: 'spring-menu-carousel', page: 'cover', layers: ['ellipse'] });
  assert.notEqual(rm.isError, true, mcp.text(rm));
  assert.equal((await human('GET', DOC)).doc.pages[0].layers.some((l) => l.id === 'ellipse'), false);

  const copy = await mcp.tool('nordle_set_copy', { project: P, doc: 'spring-menu-carousel', caption: 'Spring has arrived at the harbour.', hashtags: ['#springmenu', '#portwren'], alt: { cover: 'A cup of coffee under the words Spring menu is here.' } });
  assert.notEqual(copy.isError, true, mcp.text(copy));
  doc = (await human('GET', DOC)).doc;
  assert.equal(doc.copy.caption, 'Spring has arrived at the harbour.');
  assert.deepEqual(doc.copy.hashtags, ['#springmenu', '#portwren']);

  const page = await mcp.tool('nordle_add_page', { project: P, doc: 'spring-menu-carousel', duplicate_of: 'cover', title: 'Cover B' });
  assert.match(mcp.text(page), /New page id: "cover-copy"/);
  assert.equal((await human('GET', DOC)).doc.pages.length, 6);

  const none = await mcp.tool('nordle_update_layer', { project: P, doc: 'spring-menu-carousel', page: 'cover', layer: 'headline', set: { 'style.size': 120 } });
  assert.match(mcp.text(none), /already has those values/);
});

test('clear errors for the mistakes a model makes', async () => {
  const noLayer = await mcp.tool('nordle_update_layer', { project: P, doc: 'spring-menu-carousel', page: 'cover', layer: 'nope', set: { text: 'x' } });
  assert.equal(noLayer.isError, true);
  assert.match(mcp.text(noLayer), /no layer "nope"/);
  const noPage = await mcp.tool('nordle_add_layer', { project: P, doc: 'spring-menu-carousel', page: 'zzz', layer: { type: 'text', text: 'x' } });
  assert.match(mcp.text(noPage), /no page "zzz"/);
  const needPage = await mcp.tool('nordle_add_layer', { project: P, doc: 'spring-menu-carousel', layer: { type: 'text', text: 'x' } });
  assert.match(mcp.text(needPage), /several pages.*Say which page/);
  const badToken = await mcp.tool('nordle_update_layer', { project: P, doc: 'spring-menu-carousel', page: 'cover', layer: 'headline', set: { 'style.color': '$brand.colors.nope' } });
  assert.equal(badToken.isError, true);
  assert.match(mcp.text(badToken), /does not resolve|pattern|match/i);
  const idChange = await mcp.tool('nordle_update_layer', { project: P, doc: 'spring-menu-carousel', page: 'cover', layer: 'headline', set: { id: 'other' } });
  assert.match(mcp.text(idChange), /cannot be changed/);
  const badSize = await mcp.tool('nordle_update_layer', { project: P, doc: 'spring-menu-carousel', page: 'cover', layer: 'headline', size: 'nope-1', set: { 'layout.x': 5 } });
  assert.match(mcp.text(badSize), /no size "nope-1"/);
  const srcSize = await mcp.tool('nordle_update_layer', { project: P, doc: 'spring-menu-carousel', page: 'cover', layer: 'cup', size: 'ig-feed-4x5', set: { src: 'assets/beans.svg' } });
  assert.match(mcp.text(srcSize), /same at every size/);
});

test('locks: Claude is told plainly, and the lock holds', async () => {
  await human('POST', `${DOC}/patch`, { ops: [{ op: 'add', path: '/pages/0/layers/3/lock', value: true }] });
  const doc = JSON.parse(mcp.text(await mcp.tool('nordle_get_doc', { project: P, doc: 'spring-menu-carousel' })));
  assert.deepEqual(doc.locked, ['layer "cup" on page "cover"']);
  const r = await mcp.tool('nordle_update_layer', { project: P, doc: 'spring-menu-carousel', page: 'cover', layer: 'cup', set: { 'layout.w': 30 } });
  assert.equal(r.isError, true);
  assert.match(mcp.text(r), /locked/);
  await human('POST', `${DOC}/patch`, { ops: [{ op: 'remove', path: '/pages/0/layers/3/lock' }] });
});

test('suggest mode: the result says SUGGESTED, NOT APPLIED, and the suggestion can be previewed', async () => {
  await human('POST', `${DOC}/review/settings`, { autonomy: 'suggest' });
  const before = (await human('GET', DOC)).v;
  const r = await mcp.tool('nordle_update_layer', { project: P, doc: 'spring-menu-carousel', page: 'cover', layer: 'sub', set: { text: 'Only if you say so.' } });
  const text = mcp.text(r);
  assert.match(text, /SUGGESTED, NOT APPLIED/);
  assert.equal((await human('GET', DOC)).v, before);
  const id = /Change id: (\S+)/.exec(text)[1];
  assert.match(text, new RegExp(`preview_change "${id}"`));
  const shot = await mcp.tool('nordle_render', { project: P, doc: 'spring-menu-carousel', page: 'cover', scale: 0.5, preview_change: id });
  assert.ok(shot.content.some((c) => c.type === 'image'));
  assert.match(mcp.text(shot), /preview of the suggestion/);
  await human('POST', `${DOC}/review/changes/${id}/reject`, {});
  await human('POST', `${DOC}/review/settings`, { autonomy: 'review' });
});

test('feedback: comments arrive with their layer’s words; Claude replies and resolves; its own changes show their fate', async () => {
  await human('POST', `${DOC}/review/patch`, { ops: [{ op: 'add', path: '/comments/-', value: { id: 'c-mcp1', page: 'cover', x: 0.4, y: 0.2, layer: 'headline', text: 'Can this be calmer?', author: 'human', created: new Date().toISOString(), status: 'open' } }] });
  const fb = await mcp.tool('nordle_get_feedback', { project: P, doc: 'spring-menu-carousel' });
  const text = mcp.text(fb);
  assert.match(text, /\[c-mcp1\] page "cover".*on layer "headline" \("Spring menu is here"\): Can this be calmer\?/);
  assert.match(text, /"open_comment_ids"/);
  assert.match(text, /"your_changes"/);
  await mcp.tool('nordle_reply', { project: P, doc: 'spring-menu-carousel', comment: 'c-mcp1', text: 'Lightened the weight and cut the size.' });
  await mcp.tool('nordle_resolve', { project: P, doc: 'spring-menu-carousel', comment: 'c-mcp1' });
  const note = await mcp.tool('nordle_comment', { project: P, doc: 'spring-menu-carousel', page: 'latte', text: 'The price looks like it needs a currency sign. Which one?', layer: 'price', x: 0.1, y: 0.9 });
  assert.match(mcp.text(note), /Comment added/);
  const review = (await human('GET', `${DOC}/review`)).review;
  assert.equal(review.comments.find((c) => c.id === 'c-mcp1').status, 'resolved');
  assert.equal(review.comments.find((c) => c.id === 'c-mcp1').replies[0].author, 'claude');
});

test('new post, image import, saved version, check, and Explore', async () => {
  const made = await mcp.tool('nordle_new_doc', { project: P, title: 'Friday music', kind: 'graphic', sizes: ['ig-story-9x16'] });
  assert.match(mcp.text(made), /Created document "friday-music"/);

  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex');
  const file = join(work, 'pixel.png');
  writeFileSync(file, png);
  const imp = await mcp.tool('nordle_import_image', { project: P, file_path: file });
  assert.match(mcp.text(imp), /assets\/pixel\.png/);
  assert.equal((await mcp.tool('nordle_import_image', { project: P, file_path: join(work, 'missing.png') })).isError, true);

  const v = await mcp.tool('nordle_save_version', { project: P, doc: 'spring-menu-carousel', name: 'Before takes' });
  assert.match(mcp.text(v), /Saved as "Before takes"/);

  const chk = await mcp.tool('nordle_check', { project: P, doc: 'open-late-story' });
  assert.match(mcp.text(chk), /^0 problems/);

  const ex = await mcp.tool('nordle_explore', { project: P, doc: 'open-late-story', count: 2, labels: ['Bold', 'Quiet'], note: 'two moods' });
  assert.match(mcp.text(ex), /open-late-story-take-1 \(Bold\)/);
  const take = await mcp.tool('nordle_update_layer', { project: P, doc: 'open-late-story-take-1', layer: 'headline', set: { 'style.size': 210 } });
  assert.match(mcp.text(take), /^APPLIED\.\n/, 'takes apply directly');
  const list = JSON.parse(mcp.text(await mcp.tool('nordle_list_projects')))[0].posts;
  assert.equal(list.find((p) => p.doc === 'open-late-story-take-1').take_of, 'open-late-story');
});

test('critique: grades the post out of 100, shows all pages together, and says how to fix what is wrong', async () => {
  const ok = await mcp.tool('nordle_critique', { project: P, doc: 'open-late-story' });
  assert.notEqual(ok.isError, true);
  assert.match(mcp.text(ok), /^Design score \d+\/100 \(pass mark 88\)\. Verdict: (GOOD|NEEDS WORK)/);
  const sheet = await mcp.tool('nordle_critique', { project: P, doc: 'spring-menu-carousel' });
  assert.ok(sheet.content.some((c) => c.type === 'image' && c.mimeType === 'image/png'), 'a carousel comes with a picture of all its pages');
  await human('POST', DOC + '/patch', { ops: [{ op: 'replace', path: '/pages/0/layers/2/layout', value: { anchor: 'top-left', x: 10, y: 15, w: 60 } }] });
  const bad = mcp.text(await mcp.tool('nordle_critique', { project: P, doc: 'spring-menu-carousel', sheet: false }));
  assert.match(bad, /Verdict: NEEDS WORK/);
  assert.match(bad, /\[error\] text-collision page cover/);
  assert.match(bad, /Fix: Move one of them/);
  assert.match(bad, /Fix the errors first/);
});

test('open_editor gives the address; raw patches work and are checked like any other edit', async () => {
  const open = await mcp.tool('nordle_open_editor', { project: P, doc: 'spring-menu-carousel' });
  assert.match(mcp.text(open), /http:\/\/127\.0\.0\.1:\d+\/#\/p\/little-gannet\/spring-menu-carousel/);
  const raw = await mcp.tool('nordle_patch_doc', { project: P, doc: 'spring-menu-carousel', ops: [{ op: 'replace', path: '/pages/0/layers/0/text', value: 'NEW THIS WEEK' }], note: 'raw' });
  assert.notEqual(raw.isError, true, mcp.text(raw));
  const bad = await mcp.tool('nordle_patch_doc', { project: P, doc: 'spring-menu-carousel', ops: [{ op: 'replace', path: '/pages/9/layers/0/text', value: 'x' }] });
  assert.equal(bad.isError, true);
});

test('layout patterns: list them, compose a page from words, replace a page, set a brief', async () => {
  const names = (await mcp.request('tools/list', {})).result.tools.map((t) => t.name);
  for (const n of ['nordle_list_patterns', 'nordle_compose_page', 'nordle_set_brief']) assert.ok(names.includes(n), n);
  const list = JSON.parse(mcp.text(await mcp.tool('nordle_list_patterns')));
  assert.equal(list.length, 11);
  assert.ok(list.every((p) => p.slots && p.example));

  const made = await mcp.tool('nordle_new_doc', { project: P, title: 'Patterns test', kind: 'carousel', sizes: ['ig-feed-4x5'] });
  const id = /"([a-z0-9-]+)"/.exec(mcp.text(made))?.[1] ?? 'patterns-test';
  const add = await mcp.tool('nordle_compose_page', { project: P, doc: id, pattern: 'statement', content: { kicker: 'Our promise', headline: 'Every cup is made to order' }, page_id: 'promise' });
  assert.equal(add.isError, undefined, mcp.text(add));
  assert.match(mcp.text(add), /Page id: "promise"/);
  const doc1 = JSON.parse(mcp.text(await mcp.tool('nordle_get_doc', { project: P, doc: id })));
  assert.ok(doc1.document.pages.some((p) => p.id === 'promise'));

  const bad = await mcp.tool('nordle_compose_page', { project: P, doc: id, pattern: 'split', content: { headline: 'No picture here' } });
  assert.equal(bad.isError, true);
  assert.match(mcp.text(bad), /needs an image/);

  const replaced = await mcp.tool('nordle_compose_page', { project: P, doc: id, pattern: 'cta', content: { headline: 'Come say hi', body: 'Open 7 am' }, replace_page: 'promise' });
  assert.equal(replaced.isError, undefined, mcp.text(replaced));
  const doc2 = JSON.parse(mcp.text(await mcp.tool('nordle_get_doc', { project: P, doc: id })));
  assert.equal(doc2.document.pages.filter((p) => p.id === 'promise').length, 1);
  assert.ok(doc2.document.pages.find((p) => p.id === 'promise').layers.some((l) => l.id === 'text-block'));

  const brief = await mcp.tool('nordle_set_brief', { project: P, doc: id, goal: 'Get people to visit', audience: 'locals', must_avoid: ['prices'] });
  assert.equal(brief.isError, undefined, mcp.text(brief));
  const doc3 = JSON.parse(mcp.text(await mcp.tool('nordle_get_doc', { project: P, doc: id })));
  assert.equal(doc3.document.brief.goal, 'Get people to visit');
  assert.deepEqual(doc3.document.brief.mustAvoid, ['prices']);
});

test('with no server running it explains itself, or starts one when allowed', async () => {
  const lonely = new McpProcess({ NORDLE_RUNTIME_DIR: join(work, 'nowhere'), NORDLE_NO_AUTOSTART: '1' });
  try {
    await lonely.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const r = await lonely.tool('nordle_list_projects');
    assert.equal(r.isError, true);
    assert.match(lonely.text(r), /Nordle is not running\. Start it with "npm start"/);
  } finally { lonely.close(); }

  const dir = join(work, 'autostart');
  const auto = new McpProcess({ NORDLE_RUNTIME_DIR: dir, NORDLE_PROJECTS: join(work, 'projects'), NORDLE_PORT: '0' });
  let pid;
  try {
    await auto.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const r = await auto.tool('nordle_open_editor');
    assert.match(auto.text(r), /Nordle is running\. Open: http:\/\/127\.0\.0\.1:\d+\//);
    pid = JSON.parse(readFileSync(join(dir, 'runtime.json'), 'utf8')).pid;
    assert.ok(pid > 0);
    const list = JSON.parse(auto.text(await auto.tool('nordle_list_projects')));
    assert.equal(list[0].project, 'little-gannet');
  } finally {
    auto.close();
    if (pid) { try { process.kill(pid); } catch { /* already gone */ } }
  }
  assert.ok(existsSync(join(work, 'projects', P)));
});
