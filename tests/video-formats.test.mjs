// Export formats of a rendered video: mp4 (the default, covered by video.test.mjs), webm, gif and ProRes. Every render here
// uses ffmpeg's synthetic sources (tests/video-fixtures.mjs). A format whose encoder this computer's ffmpeg lacks is skipped
// with the reason; the message that tells a person about the missing encoder is tested with a made-up encoder list.
//   node --test tests/video-formats.test.mjs        (needs ffmpeg on the PATH and a browser: npx playwright-core install chromium)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../tools/validate.mjs';
import { openBrowser } from '../src/render/browser.mjs';
import { createNordleServer } from '../src/server/http.mjs';
import { binary, run } from '../src/video/ffmpeg.mjs';
import { probeMedia } from '../src/video/probe.mjs';
import { renderVideo } from '../src/video/render.mjs';
import { FORMAT_IDS, availableEncoders, encoderProblem, formatList, gifProblem, normaliseFormat } from '../src/video/formats.mjs';
import videoTools from '../src/mcp/tools/video.mjs';
import { decodeAudio, decodeFrames, makeMedia, near, retryReset } from './video-fixtures.mjs';

const work = mkdtempSync(join(tmpdir(), 'nordle-formattest-'));
const footage = join(work, 'footage');
const projectsDir = join(work, 'projects');
const proj = join(projectsDir, 'little-gannet');
// a private temp folder, so other programs' leftovers cannot fail the check at the end
const PRIVATE_TMP = mkdtempSync(join(tmpdir(), 'nordle-ft-'));
process.env.TEMP = PRIVATE_TMP; process.env.TMP = PRIVATE_TMP; process.env.TMPDIR = PRIVATE_TMP;
process.on('exit', () => { try { rmSync(PRIVATE_TMP, { recursive: true, force: true }); } catch { /* the OS cleans it later */ } });
const tmpBefore = new Set(readdirSync(tmpdir()).filter((n) => /^nordle-(video|still|sheet)/.test(n)));
let browser;

const tinySize = [{ id: 'tiny', w: 360, h: 640 }];
const base = (id, extra) => ({ schema: 'nordle.doc/0.1', id, title: id, kind: 'video', brand: 'little-gannet', sizes: tinySize, ...extra });
function writeDoc(doc) {
  mkdirSync(join(proj, 'docs'), { recursive: true });
  const file = join(proj, 'docs', `${doc.id}.json`);
  writeFileSync(file, JSON.stringify(doc, null, 2));
  return file;
}
/** a picture and sound that start together: a white flash and a 1 kHz beep at 2.000 s of the clip */
const syncDoc = (id) => base(id, {
  sources: [{ id: 'sync', type: 'video', path: 'mount:footage/sync.mp4', duration: 8 }],
  timeline: { fps: 30, duration: 5, tracks: [{ id: 'v1', type: 'video', clips: [{ id: 's', source: 'sync', in: 1, out: 6, at: 0 }] }] },
});
/** a plain coloured background with a title: no footage at all, any length */
const cardDoc = (id, seconds, size = tinySize) => base(id, {
  sizes: size,
  timeline: { fps: 30, duration: seconds, background: '#2060c0', tracks: [{ id: 'v1', type: 'video', clips: [] }] },
  layers: [{ id: 'title', type: 'text', text: 'Hello', time: { start: 0.2, end: seconds - 0.2 }, layout: { anchor: 'top-left', x: 10, y: 30, w: 70 }, style: { font: '$brand.fonts.display', size: 90, weight: 700, color: '#ffffff' } }],
});

const can = (format) => encoderProblem(format);
const streams = async (file) => {
  const { stdout } = await run(['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,profile,pix_fmt,width,height,sample_rate,channels,start_time', '-of', 'json', file], { bin: binary('ffprobe'), capture: 'text' });
  return JSON.parse(stdout).streams;
};
/** Where the flash and the beep start, in seconds, read back from the finished file the way a player would. */
async function flashAndBeep(file) {
  const frames = await decodeFrames(file, 4, 4);
  const flash = frames.findIndex((f) => f.r > 200);
  const pcm = await decodeAudio(file);
  const onset = pcm.findIndex((v) => Math.abs(v) > 0.2 * 32768);
  return { flash, frames: frames.length, flashAt: flash / 30, beepAt: onset / 48000 };
}

before(async () => {
  mkdirSync(proj, { recursive: true });
  cpSync(join(ROOT, 'samples', 'little-gannet', 'brand.json'), join(proj, 'brand.json'));
  await makeMedia(footage);
  writeFileSync(join(proj, 'nordle.local.json'), JSON.stringify({ mounts: { footage } }));
  browser = await openBrowser();
});
after(async () => {
  await browser?.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
});

// ------------------------------------------------------------------------------------------------ the list of formats

test('formats: the names, an unknown one is refused, and a missing encoder is explained in plain words', () => {
  assert.deepEqual(FORMAT_IDS, ['mp4', 'webm', 'gif', 'prores']);
  assert.equal(normaliseFormat(undefined), 'mp4');
  assert.equal(normaliseFormat(' WebM '), 'webm');
  assert.throws(() => normaliseFormat('avi'), /"avi" is not a video format Nordle makes\. Choose one of: mp4, webm, gif, prores/);
  const list = formatList(new Set(['libx264', 'aac', 'gif']));
  assert.deepEqual(list.map((f) => [f.id, f.ext, f.available]), [['mp4', 'mp4', true], ['webm', 'webm', false], ['gif', 'gif', true], ['prores', 'mov', false]]);
  assert.match(list[1].problem, /WebM export needs the ffmpeg encoder "libvpx-vp9" and "libopus"/);
  assert.match(list[3].problem, /ProRes export needs the ffmpeg encoder "prores_ks" and "pcm_s16le"/);
  assert.equal(encoderProblem('mp4', new Set(['libx264', 'aac'])), null);
  assert.equal(encoderProblem('webm', null), null, 'when ffmpeg cannot be asked, the render reports the real problem');
  assert.match(gifProblem(42), /at most 30 seconds.*42\.0 s/);
  assert.equal(gifProblem(30), null);
  const here = availableEncoders();
  assert.ok(here === null || here.has('libx264'), 'the encoder list was read from ffmpeg');
});

test('a format this ffmpeg cannot make is refused before anything is rendered, naming the encoder', { timeout: 60000 }, async () => {
  const file = writeDoc(syncDoc('noenc'));
  const r = await renderVideo(file, { browser, format: 'webm', encoders: new Set(['libx264', 'aac']), out: join(work, 'noenc') });
  assert.equal(r.ok, false);
  assert.equal(r.format, 'webm');
  assert.equal(r.errors[0].code, 'encoder-missing');
  assert.match(r.errors[0].message, /libvpx-vp9/);
  assert.equal(existsSync(join(work, 'noenc', 'noenc.webm')), false);
  await assert.rejects(renderVideo(file, { browser, format: 'avi' }), /not a video format Nordle makes/);
});

// ------------------------------------------------------------------------------------------------ webm and ProRes keep picture and sound together

let webm, prores, gif;

test('webm: VP9 and Opus, the right size and length, and the flash and the beep still start together', { timeout: 120000 }, async (t) => {
  if (can('webm')) return t.skip(can('webm'));
  webm = await renderVideo(writeDoc(syncDoc('sync-webm')), { browser, format: 'webm' });
  assert.ok(webm.ok, JSON.stringify(webm.errors));
  assert.equal(webm.format, 'webm');
  assert.equal(webm.file, join(proj, 'out', 'sync-webm', 'sync-webm.webm'));
  assert.equal(webm.files.video, webm.file);
  const [v, a] = await streams(webm.file);
  assert.equal(v.codec_name, 'vp9'); assert.equal(v.pix_fmt, 'yuv420p');
  assert.deepEqual([v.width, v.height], [360, 640]);
  assert.equal(a.codec_name, 'opus'); assert.equal(a.channels, 2);
  const p = await probeMedia(webm.file);
  assert.ok(Math.abs(p.duration - 5) < 0.1, `duration ${p.duration}`);
  assert.equal(Math.round(p.video.fps), 30);
  assert.ok(existsSync(webm.files.cover) && existsSync(webm.files.sheet), 'cover and contact sheet are made from the webm too');
  const s = await flashAndBeep(webm.file);
  assert.equal(s.frames, 150);
  assert.equal(s.flash, 60, 'the flash starts on frame 60 (2.000 s)');
  assert.ok(Math.abs(s.beepAt - s.flashAt) < 0.012, `webm: the beep starts at ${s.beepAt.toFixed(4)} s, the flash at ${s.flashAt.toFixed(4)} s`);
  const starts = Object.fromEntries((await streams(webm.file)).map((x) => [x.codec_type, Number(x.start_time)]));
  assert.ok(Math.abs(starts.audio - starts.video) < 0.03, `start times ${JSON.stringify(starts)}`);
});

test('prores: ProRes 422 HQ with 16-bit PCM in a .mov, and the flash and the beep still start together', { timeout: 120000 }, async (t) => {
  if (can('prores')) return t.skip(can('prores'));
  prores = await renderVideo(writeDoc(syncDoc('sync-prores')), { browser, format: 'prores' });
  assert.ok(prores.ok, JSON.stringify(prores.errors));
  assert.equal(prores.file, join(proj, 'out', 'sync-prores', 'sync-prores.mov'));
  const [v, a] = await streams(prores.file);
  assert.equal(v.codec_name, 'prores'); assert.equal(v.profile, 'HQ'); assert.equal(v.pix_fmt, 'yuv422p10le');
  assert.deepEqual([v.width, v.height], [360, 640]);
  assert.equal(a.codec_name, 'pcm_s16le'); assert.equal(a.sample_rate, '48000'); assert.equal(a.channels, 2);
  const p = await probeMedia(prores.file);
  assert.ok(Math.abs(p.duration - 5) < 0.06, `duration ${p.duration}`);
  assert.ok(existsSync(prores.files.cover) && existsSync(prores.files.sheet));
  const s = await flashAndBeep(prores.file);
  assert.equal(s.frames, 150);
  assert.equal(s.flash, 60);
  assert.ok(Math.abs(s.beepAt - s.flashAt) < 0.012, `prores: the beep starts at ${s.beepAt.toFixed(4)} s, the flash at ${s.flashAt.toFixed(4)} s`);
  const starts = Object.fromEntries((await streams(prores.file)).map((x) => [x.codec_type, Number(x.start_time)]));
  assert.ok(Math.abs(starts.audio - starts.video) < 0.03, `start times ${JSON.stringify(starts)}`);
});

test('a preview keeps its name and takes the extension of its format', { timeout: 90000 }, async (t) => {
  if (can('webm')) return t.skip(can('webm'));
  const r = await renderVideo(join(proj, 'docs', 'sync-webm.json'), { browser, format: 'webm', preview: true, out: join(work, 'preview') });
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.equal(r.files.video, join(work, 'preview', 'sync-webm.preview.webm'));
  assert.equal((await probeMedia(r.files.video)).video.width, 180);
});

// ------------------------------------------------------------------------------------------------ gif

test('gif: 15 fps, no wider than 540, no sound, no cover or sheet, and the length is right', { timeout: 120000 }, async (t) => {
  if (can('gif')) return t.skip(can('gif'));
  gif = await renderVideo(writeDoc(cardDoc('card-gif', 2, [{ id: 'wide', w: 720, h: 1280 }])), { browser, format: 'gif' });
  assert.ok(gif.ok, JSON.stringify(gif.errors));
  assert.equal(gif.format, 'gif');
  assert.equal(gif.file, join(proj, 'out', 'card-gif', 'card-gif.gif'));
  assert.equal(readFileSync(gif.file).toString('latin1', 0, 6), 'GIF89a');
  const list = await streams(gif.file);
  assert.deepEqual(list.map((s) => s.codec_type), ['video'], 'no sound stream');
  assert.deepEqual([list[0].width, list[0].height], [540, 960], 'scaled down from 720 to the default 540 wide, same shape');
  const p = await probeMedia(gif.file, { animated: true });
  assert.ok(Math.abs(p.duration - 2) < 0.25, `duration ${p.duration}`);
  assert.ok(Math.abs(p.video.fps - 15) < 1.5, `fps ${p.video.fps}`);
  assert.equal(gif.output.audio, null);
  assert.equal(gif.files.cover, undefined); assert.equal(gif.files.sheet, undefined);
  assert.equal(existsSync(join(proj, 'out', 'card-gif', 'sheet.png')), false);
  const frames = await decodeFrames(gif.file, 4, 4);
  assert.ok(frames.length >= 28 && frames.length <= 32, `${frames.length} frames for 2 s at 15 fps`);
  assert.ok(near(frames[0], '2060c0', 40), `the background colour survives the palette (${frames[0].r.toFixed(0)},${frames[0].g.toFixed(0)},${frames[0].b.toFixed(0)})`);
  // a smaller width on request, and never larger than the picture itself
  const narrow = await renderVideo(join(proj, 'docs', 'card-gif.json'), { browser, format: 'gif', maxWidth: 270, out: join(work, 'gif-narrow') });
  assert.ok(narrow.ok);
  assert.deepEqual([narrow.output.width, narrow.output.height], [270, 480]);
  const small = await renderVideo(writeDoc(cardDoc('card-small', 1)), { browser, format: 'gif', out: join(work, 'gif-small') });
  assert.deepEqual([small.output.width, small.output.height], [360, 640], 'a 360 px picture is not enlarged to 540');
});

test('gif: more than 30 seconds is refused in plain words, a short part of a long timeline is fine', { timeout: 120000 }, async (t) => {
  if (can('gif')) return t.skip(can('gif'));
  const file = writeDoc(cardDoc('card-long', 31));
  const r = await renderVideo(file, { browser, format: 'gif', out: join(work, 'gif-long') });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].code, 'gif-too-long');
  assert.match(r.errors[0].message, /at most 30 seconds.*31\.0 s.*mp4 or webm/);
  assert.equal(existsSync(join(work, 'gif-long')), false, 'nothing was started');
  const part = await renderVideo(file, { browser, format: 'gif', from: 5, to: 7, out: join(work, 'gif-long') });
  assert.ok(part.ok, JSON.stringify(part.errors));
  assert.match(part.file, /card-long\.5\.0-7\.0s\.gif$/);
  assert.ok(Math.abs((await probeMedia(part.file, { animated: true })).duration - 2) < 0.25);
});

// ------------------------------------------------------------------------------------------------ wiring: CLI, route, tool, serving

test('CLI: video render --format writes the right file, an unknown format says so', { timeout: 120000 }, async (t) => {
  if (can('webm')) return t.skip(can('webm'));
  const cli = (...args) => spawnSync(process.execPath, [join(ROOT, 'nordle.mjs'), 'video', ...args], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 110000 });
  const bad = cli('render', join(proj, 'docs', 'sync-webm.json'), '--format', 'avi');
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /not a video format Nordle makes/);
  const ok = cli('render', join(proj, 'docs', 'sync-webm.json'), '--format', 'webm', '--preview', '--out', join(work, 'cli'));
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /OK\s+sync-webm \(WebM/);
  assert.ok(existsSync(join(work, 'cli', 'sync-webm.preview.webm')));
});

test('the render tool offers the formats and passes the choice on', async () => {
  const sent = [];
  const client = { post: async (path, body) => { sent.push({ path, body }); return { job: { id: 'j1', status: 'running', percent: 0, stage: 'x', message: 'x', seconds: 0, options: {} } }; } };
  const helpers = { P: { type: 'string' }, D: { type: 'string' }, READ: {}, EDIT: {}, enc: encodeURIComponent, NordleError: Error };
  const tool = videoTools(client, helpers).find((x) => x.name === 'nordle_render_video');
  assert.deepEqual(tool.inputSchema.properties.format.enum, ['mp4', 'webm', 'gif', 'prores']);
  assert.equal(tool.inputSchema.additionalProperties, false);
  const out = await tool.handler({ project: 'p', doc: 'd', format: 'gif', max_width: 400, from: 1, to: 4 });
  assert.equal(sent[0].path, '/projects/p/video/render');
  assert.deepEqual(sent[0].body, { doc: 'd', preview: undefined, from: 1, to: 4, size: undefined, format: 'gif', maxWidth: 400 });
  assert.match(out.text, /RUNNING/);
});

test('server: the render route checks the format, a job reports its file and format, and every kind of file is served in pieces', { timeout: 180000 }, async (t) => {
  const TOKEN = 'format-test-token-0123456789abcdef01';
  const AGENT = 'format-test-agent-0123456789abcdef012';
  const app = createNordleServer({ roots: [projectsDir], token: TOKEN, agentToken: AGENT });
  const port = await app.listen(0);
  const get = (u, init) => retryReset(() => fetch(u, init));
  const call = async (path, method = 'GET', body) => {
    const res = await get(`http://127.0.0.1:${port}/api${path}`, { method, headers: { 'x-nordle-token': AGENT, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json() };
  };
  try {
    const listed = await call('/projects');
    const id = listed.json.projects.find((p) => p.docs.some((d) => d.id === 'sync-webm' || d.id === 'card-long'))?.id;
    assert.equal(id, 'little-gannet');
    const formats = await call(`/projects/${id}/video/formats`);
    assert.deepEqual(formats.json.formats.map((f) => f.id), ['mp4', 'webm', 'gif', 'prores']);
    assert.ok(formats.json.formats.find((f) => f.id === 'mp4').available);
    const unknown = await call(`/projects/${id}/video/render`, 'POST', { doc: 'card-long', format: 'avi' });
    assert.equal(unknown.status, 400);
    assert.match(unknown.json.errors[0].message, /mp4, webm, gif, prores/);
    assert.equal((await call(`/projects/${id}/video/render`, 'POST', { doc: 'card-long', format: 'gif', maxWidth: 5 })).status, 400);
    if (!can('gif')) {
      const tooLong = await call(`/projects/${id}/video/render`, 'POST', { doc: 'card-long', format: 'gif' });
      assert.equal(tooLong.status, 422);
      assert.match(tooLong.json.errors[0].message, /at most 30 seconds/);
    }
    if (!can('webm')) {
      const started = await call(`/projects/${id}/video/render`, 'POST', { doc: 'sync-webm', format: 'webm', preview: true });
      assert.equal(started.status, 202);
      assert.equal(started.json.job.options.format, 'webm');
      let job = started.json.job;
      for (let i = 0; i < 14 && job.status === 'running'; i++) job = (await call(`/projects/${id}/video/jobs/${job.id}?wait=10`)).json.job;
      assert.equal(job.status, 'done', job.error);
      assert.equal(job.result.format, 'webm');
      assert.equal(job.result.file, 'out/sync-webm/sync-webm.preview.webm');
      assert.equal(job.result.files.video, job.result.file);
    }
    // webm, mov and gif are served with the right type and answer byte ranges, so a player can seek
    const served = [[webm, 'video/webm'], [prores, 'video/quicktime'], [gif, 'image/gif']].filter(([r]) => r?.ok);
    assert.ok(served.length > 0, 'at least one format was rendered above');
    for (const [r, type] of served) {
      const url = `http://127.0.0.1:${port}/p/${id}/${r.file.slice(proj.length + 1).split('\\').join('/')}`;
      const size = statSync(r.file).size;
      const whole = await get(url);
      assert.equal(whole.status, 200); assert.equal(whole.headers.get('content-type'), type); assert.equal(whole.headers.get('accept-ranges'), 'bytes');
      await whole.arrayBuffer();
      const part = await get(url, { headers: { range: 'bytes=0-99' } });
      assert.equal(part.status, 206); assert.equal(part.headers.get('content-range'), `bytes 0-99/${size}`); assert.equal((await part.arrayBuffer()).byteLength, 100);
      const tail = await get(url, { headers: { range: 'bytes=-50' } });
      assert.equal(tail.status, 206); assert.equal((await tail.arrayBuffer()).byteLength, 50);
    }
  } finally { await app.close(); }
});

test('no temporary folders are left behind', () => {
  const left = readdirSync(tmpdir()).filter((n) => /^nordle-(video|still|sheet)/.test(n) && !tmpBefore.has(n));
  assert.deepEqual(left, []);
});
