// Cutting by words from the outside: the command line (with and without a running editor), the transcript route, and the MCP tools
// (through the real patch path: baseVersion, Claude as the actor, the owner's autonomy setting). No ffmpeg is needed: only the
// document and its transcript are used, never the footage.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../tools/validate.mjs';
import { createNordleServer } from '../src/server/http.mjs';
import { coverage, totalDuration } from '../src/shared/cutlist.mjs';

const P = 'little-gannet';
const DOC = 'cut-talk';
const words = Array.from({ length: 40 }, (_, k) => ({ text: `word${k}${k % 8 === 7 ? '.' : ''}`, start: 0.5 + 0.5 * k, end: 0.85 + 0.5 * k }));

const talkDoc = () => ({
  schema: 'nordle.doc/0.1', id: DOC, title: 'Cut talk', kind: 'video', brand: P, sizes: ['ig-reel-9x16'],
  sources: [{ id: 'talk', type: 'video', path: 'mount:footage/talk.mp4', duration: 22, transcript: 'mount:footage/talk.words.json' }],
  timeline: {
    fps: 30, duration: 22,
    tracks: [{ id: 'v1', type: 'video', clips: [{ id: 'main', source: 'talk', in: 0, out: 22, at: 0 }] }],
    scenes: [{ id: 'all', start: 0, end: 22 }],
  },
});

/** A copy of the sample project with the talking document, its transcript and a footage mount (the footage itself is never read). */
function makeProject(root) {
  const proj = join(root, 'projects', P);
  cpSync(join(ROOT, 'samples', P), proj, { recursive: true, filter: (s) => !/[\\/](out|sources)([\\/]|$)/.test(s) });
  const footage = join(root, 'footage');
  mkdirSync(footage, { recursive: true });
  writeFileSync(join(footage, 'talk.words.json'), JSON.stringify({ schema: 'nordle.words/0.1', words }));
  writeFileSync(join(proj, 'nordle.local.json'), JSON.stringify({ mounts: { footage } }));
  writeFileSync(join(proj, 'docs', `${DOC}.json`), `${JSON.stringify(talkDoc(), null, 2)}\n`);
  return proj;
}

let work, serverProj, cliProj, app, runtimeDir, mcp, HUMAN;
const emptyRuntime = () => mkdtempSync(join(work, 'norun-'));
const readDoc = (proj) => JSON.parse(readFileSync(join(proj, 'docs', `${DOC}.json`), 'utf8'));
const cov = (doc) => coverage(doc, { track: 'v1', source: 'talk' }).map((e) => [e.from, e.to, e.at]);

/** nordle.mjs cut ..., with no editor running unless a runtime folder is given. Asynchronous: the test server lives in this process. */
function cli(args, { runtime = emptyRuntime() } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, 'nordle.mjs'), 'cut', ...args], { env: { ...process.env, NORDLE_RUNTIME_DIR: runtime }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

class McpProcess {
  constructor(env) {
    this.child = spawn(process.execPath, [join(ROOT, 'mcp.mjs')], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.nextId = 1; this.waiting = new Map(); this.stderr = ''; this.buffer = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (d) => {
      this.buffer += d;
      let i;
      while ((i = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, i); this.buffer = this.buffer.slice(i + 1);
        if (line.trim()) { const msg = JSON.parse(line); this.waiting.get(msg.id)?.(msg); }
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
  async tool(name, args = {}) {
    const m = await this.request('tools/call', { name, arguments: args });
    assert.ok(m.result, JSON.stringify(m));
    return m.result;
  }
  text(result) { return result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'); }
  close() { this.child.stdin.end(); this.child.kill(); }
}

const human = async (method, path, body) => {
  const info = JSON.parse(readFileSync(join(runtimeDir, 'runtime.json'), 'utf8'));
  const res = await fetch(`http://127.0.0.1:${info.port}/api${path}`, { method, headers: { 'x-nordle-token': HUMAN, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json() };
};

before(async () => {
  work = mkdtempSync(join(tmpdir(), 'nordle-cuttools-'));
  serverProj = makeProject(join(work, 'server'));
  cliProj = makeProject(join(work, 'cli'));
  runtimeDir = join(work, 'runtime');
  HUMAN = 'human-token-for-cut-tests-0123456789';
  app = createNordleServer({ roots: [join(work, 'server', 'projects')], token: HUMAN, runtimeDir });
  await app.listen(0);
  mcp = new McpProcess({ NORDLE_RUNTIME_DIR: runtimeDir, NORDLE_NO_AUTOSTART: '1' });
});
after(async () => {
  mcp?.close();
  await app?.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// the command line, with no editor running: the document file is written the way the editor writes it

test('cut words: the transcript is numbered and says what is kept', async () => {
  const r = await cli(['words', cliProj, DOC, '--source', 'talk']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Source "talk" on track "v1": 40 of 40 words kept\. The video is 0:22\.0 \(22\.0 s\) long\./);
  assert.match(r.out, /0-7 +0:00\.5 +word0 word1 .* word7\./);
  assert.match(r.out, /32-39 /);
  const all = await cli(['words', cliProj, DOC, '--all']);
  assert.match(all.out, /0:word0 1:word1/, 'the source is found from the document');
  const json = JSON.parse((await cli(['words', cliProj, DOC, '--json'])).out);
  assert.equal(json.words.length, 40); assert.equal(json.total, 22);
});

test('cut remove --dry-run shows the operations and changes nothing', async () => {
  const before = readFileSync(join(cliProj, 'docs', `${DOC}.json`), 'utf8');
  const r = await cli([cliProj, DOC, '--source', 'talk', 'remove', '8-15', '--dry-run']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^CUT words 8-15 \("word8 word9/m);
  assert.match(r.out, /dry run: \d+ operations?, nothing changed\. The video is 18\.\d+ s long \(was 22\.00 s\)\./);
  assert.match(r.out, /"op":"add","path":"\/timeline\/tracks\/0\/clips\/1"/);
  assert.equal(readFileSync(join(cliProj, 'docs', `${DOC}.json`), 'utf8'), before);
  assert.ok(!existsSync(join(cliProj, 'history', `${DOC}.jsonl`)));
  const json = JSON.parse((await cli([cliProj, DOC, '--source', 'talk', 'remove', '8-15', '--dry-run', '--json'])).out);
  assert.ok(json.ops.length > 2 && json.total < json.before);
});

test('cut remove then restore: the file is written with a history entry, and the words come back', async () => {
  const original = readDoc(cliProj);
  const r = await cli([cliProj, DOC, '--source', 'talk', 'remove', '8-15']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /WROTE .*cut-talk\.json \(version 1\)\. The video is 18\.\d+ s long \(was 22\.00 s\)\./);
  const cut = readDoc(cliProj);
  assert.ok(totalDuration(cut) < 19 && cut.timeline.duration === totalDuration(cut));
  const history = readFileSync(join(cliProj, 'history', `${DOC}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(history.length, 1);
  assert.equal(history[0].actor, 'human'); assert.match(history[0].note, /words 8-15/); assert.ok(history[0].inverse.length > 0);
  const listing = (await cli(['words', cliProj, DOC])).out;
  assert.match(listing, /8-15 +\[cut\] +\(word8 /);
  assert.match(listing, /\n16-23 +0:\d\d\.\d +word16/);
  // nothing to do the second time
  assert.match((await cli([cliProj, DOC, '--source', 'talk', 'remove', '9-10'])).out, /^NOTHING words 9-10 .* are already cut out/m);
  const back = await cli([cliProj, DOC, '--source', 'talk', 'restore', '8-15']);
  assert.equal(back.code, 0, back.err);
  assert.match(back.out, /WROTE .*version 2\)/);
  const restored = readDoc(cliProj);
  assert.deepEqual(cov(restored), cov(original));
  assert.equal(totalDuration(restored), totalDuration(original));
  assert.equal(restored.timeline.duration, 22);
});

test('cut: split, trim, move and delete a clip, and errors are said plainly', async () => {
  // start again from the document as it was written (the test before this one left it cut and brought back)
  writeFileSync(join(cliProj, 'docs', `${DOC}.json`), `${JSON.stringify(talkDoc(), null, 2)}\n`);
  rmSync(join(cliProj, 'history'), { recursive: true, force: true });
  const split = await cli([cliProj, DOC, 'split', 'main', '6']);
  assert.equal(split.code, 0, split.err);
  assert.match(split.out, /^SPLIT clip "main" at 6 s/m);
  assert.deepEqual(readDoc(cliProj).timeline.tracks[0].clips.map((c) => [c.id, c.in, c.out, c.at]), [['main', 0, 6, 0], ['main-b', 6, 22, 6]]);
  const trim = await cli([cliProj, DOC, 'trim', 'main-b', '--out', '20', '--ripple']);
  assert.equal(trim.code, 0, trim.err);
  assert.equal(readDoc(cliProj).timeline.duration, 20);
  const bad = await cli([cliProj, DOC, 'trim', 'main-b', '--out', '40']);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /cannot run to 40s: the footage is only 22s long/);
  const move = await cli([cliProj, DOC, 'move', 'main', '3']);
  assert.equal(move.code, 1);
  assert.match(move.err, /"main" would run from 3s to 9s on track "v1", where "main-b" already plays/);
  const del = await cli([cliProj, DOC, 'delete', 'main']);
  assert.equal(del.code, 0, del.err);
  assert.deepEqual(readDoc(cliProj).timeline.tracks[0].clips.map((c) => [c.id, c.at]), [['main-b', 0]]);
  assert.equal(readDoc(cliProj).timeline.duration, 14);
  // usage and unknowns
  assert.equal((await cli([cliProj, DOC, 'remove', 'nine'])).code, 2);
  assert.equal((await cli([cliProj, 'no-such-doc', 'remove', '1-2'])).code, 2);
  assert.equal((await cli([join(work, 'nowhere'), DOC, 'remove', '1-2'])).code, 2);
  const range = await cli([cliProj, DOC, 'remove', '50-60', '--source', 'talk']);
  assert.equal(range.code, 1);
  assert.match(range.err, /Words 50 to 60 are not in this transcript\. It has 40 words/);
  assert.match((await cli([cliProj, DOC, 'remove', '1-2', '--source', 'nothing'])).err, /There is no source "nothing"/);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// the transcript route, the MCP tools and the command line through a running editor

test('the transcript route returns the words with what is kept, for the editor and for Claude', async () => {
  const r = await human('POST', `/projects/${P}/cut/words`, { doc: DOC });
  assert.equal(r.status, 200);
  assert.equal(r.json.source, 'talk'); assert.equal(r.json.track, 'v1'); assert.equal(r.json.fps, 30);
  assert.equal(r.json.words.length, 40);
  assert.deepEqual(r.json.words[3], { i: 3, text: 'word3', start: 2, end: 2.35, kept: true, at: 2 });
  assert.equal(r.json.total, 22); assert.equal(r.json.keptWords, 40);
  assert.equal(r.json.lines.length, 5);
  assert.equal((await human('POST', `/projects/${P}/cut/words`, { doc: 'nope' })).status, 404);
  assert.equal((await human('POST', `/projects/${P}/cut/words`, { doc: DOC, source: 'zzz' })).status, 422);
  const withoutTranscript = talkDoc(); withoutTranscript.id = 'no-transcript'; delete withoutTranscript.sources[0].transcript;
  writeFileSync(join(serverProj, 'docs', 'no-transcript.json'), JSON.stringify(withoutTranscript));
  const none = await human('POST', `/projects/${P}/cut/words`, { doc: 'no-transcript', source: 'talk' });
  assert.equal(none.status, 422);
  assert.match(JSON.stringify(none.json), /has no transcript/);
  rmSync(join(serverProj, 'docs', 'no-transcript.json'));
});

test('MCP: nordle_cut_list and nordle_cut_words go through the editor’s patch path and say how long the video is now', async () => {
  const list = await mcp.request('tools/list');
  const names = list.result.tools.map((t) => t.name);
  assert.ok(names.includes('nordle_cut_list') && names.includes('nordle_cut_words'));
  assert.equal(list.result.tools.find((t) => t.name === 'nordle_cut_list').annotations.readOnlyHint, true);
  const before = (await human('GET', `/projects/${P}/docs/${DOC}`)).json;
  const first = mcp.text(await mcp.tool('nordle_cut_list', { project: P, doc: DOC }));
  assert.match(first, /40 of 40 words kept/);
  assert.match(first, /0-7 +0:00\.5 +word0/);
  const cut = await mcp.tool('nordle_cut_words', { project: P, doc: DOC, from: 16, to: 23, note: 'drop the tangent' });
  const text = mcp.text(cut);
  assert.notEqual(cut.isError, true, text);
  assert.match(text, /Cut words 16-23 \("word16 word17/);
  assert.match(text, /The video is 18\.\d+ s long \(was 22\.00 s\) once this is applied\./);
  assert.match(text, /APPLIED/);
  const after = (await human('GET', `/projects/${P}/docs/${DOC}`)).json;
  assert.equal(after.v, before.v + 1);
  assert.ok(totalDuration(after.doc) < 19);
  assert.equal(after.doc.timeline.duration, totalDuration(after.doc));
  const second = mcp.text(await mcp.tool('nordle_cut_list', { project: P, doc: DOC }));
  assert.match(second, /32 of 40 words kept/);
  assert.match(second, /16-23 +\[cut\] +\(word16 /);
  assert.match(mcp.text(await mcp.tool('nordle_cut_list', { project: P, doc: DOC, all: true })), /\(16:word16\)/);
  const again = mcp.text(await mcp.tool('nordle_cut_words', { project: P, doc: DOC, from: 17, to: 18 }));
  assert.match(again, /Nothing to change: words 17-18 .* are already cut out/);
  const back = mcp.text(await mcp.tool('nordle_cut_words', { project: P, doc: DOC, from: 16, to: 23, restore: true }));
  assert.match(back, /Brought back words 16-23/);
  const restored = (await human('GET', `/projects/${P}/docs/${DOC}`)).json.doc;
  assert.deepEqual(cov(restored), [[0, 22, 0]].map((e) => e), 'everything is back, as one stretch');
  assert.equal(totalDuration(restored), 22);
  const bad = await mcp.tool('nordle_cut_words', { project: P, doc: DOC, from: 30, to: 99 });
  assert.equal(bad.isError, true);
  assert.match(mcp.text(bad), /Words 30 to 99 are not in this transcript/);
  const none = await mcp.tool('nordle_cut_words', { project: P, doc: DOC, from: 0, to: 39 });
  assert.equal(none.isError, true);
  assert.match(mcp.text(none), /cut out everything of "talk"/);
});

test('MCP: in suggest mode the cut waits for the owner (SUGGESTED, NOT APPLIED) and nothing changes', async () => {
  const docPath = `/projects/${P}/docs/${DOC}`;
  await human('POST', `${docPath}/review/settings`, { autonomy: 'suggest' });
  const v = (await human('GET', docPath)).json.v;
  const r = mcp.text(await mcp.tool('nordle_cut_words', { project: P, doc: DOC, from: 0, to: 7 }));
  assert.match(r, /SUGGESTED, NOT APPLIED/);
  assert.equal((await human('GET', docPath)).json.v, v);
  await human('POST', `${docPath}/review/settings`, { autonomy: 'review' });
});

test('the command line uses the running editor when it serves this project, so the change is the editor’s own validated patch', async () => {
  const docPath = `/projects/${P}/docs/${DOC}`;
  const runtime = runtimeDir;
  const r = await cli([serverProj, DOC, '--source', 'talk', 'remove', '24-31'], { runtime });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /APPLIED through the running editor \(version \d+\)/);
  assert.match(r.out, /The video is 1\d\.\d+ s long \(was 22\.00 s\)\./);
  const file = readDoc(serverProj);
  assert.ok(totalDuration(file) < 19, 'the editor wrote the file');
  assert.deepEqual((await human('GET', docPath)).json.doc, file);
  const history = readFileSync(join(serverProj, 'history', `${DOC}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(history.at(-1).actor, 'claude', 'the editor records it as an edit made through the agent path');
});
