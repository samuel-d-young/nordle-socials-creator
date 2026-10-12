// Videos you already have: chosen on this computer (a fake file window here), left where they are, and turned into posts with their picture and sound on the
// timeline, on the calendar, ready for the video editor.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { binary } from '../src/video/ffmpeg.mjs';
import { pickFiles } from '../src/server/folder-picker.mjs';
import { AGENT, closeBrowser } from './helpers.mjs';
import { studio, studioPage, TODAY } from './studio-helpers.mjs';

const have = spawnSync(binary('ffmpeg'), ['-version'], { windowsHide: true }).status === 0;
const skip = !have && 'ffmpeg is not installed';
let dir;
const clip = (name, secs = 2) => {
  const out = join(dir, name);
  const r = spawnSync(binary('ffmpeg'), ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=320x240:rate=30:duration=${secs}`, '-f', 'lavfi', '-i', `sine=frequency=440:duration=${secs}`, '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', out], { windowsHide: true });
  assert.equal(r.status, 0, String(r.stderr));
  return out;
};
before(() => { process.env.NORDLE_TODAY = TODAY; dir = mkdtempSync(join(tmpdir(), 'nordle-myvideos-')); });
after(async () => { await closeBrowser(); delete process.env.NORDLE_TODAY; });

const firstProject = async (call) => { const r = (await call('/projects')).body; return (r.projects ?? r)[0].id; };

test('the file window: Windows, macOS and Linux each ask the system, and return every file chosen', async () => {
  const fake = (r) => { const seen = []; const run = async (cmd, args) => { seen.push([cmd, args]); return { code: 0, stdout: '', stderr: '', missing: false, ...r }; }; run.seen = seen; return run; };
  const win = fake({ stdout: 'D:\\Clips\\a.mp4\nD:\\Clips\\b.mov' });
  assert.deepEqual(await pickFiles({ platform: 'win32', run: win }), { paths: ['D:\\Clips\\a.mp4', 'D:\\Clips\\b.mov'] });
  assert.match(win.seen[0][1].at(-1), /OpenFileDialog/);
  assert.match(win.seen[0][1].at(-1), /Multiselect = \$true/);
  const mac = fake({ stdout: '/Users/me/a.mp4\n/Users/me/b.mov\n' });
  assert.deepEqual(await pickFiles({ platform: 'darwin', run: mac }), { paths: ['/Users/me/a.mp4', '/Users/me/b.mov'] });
  assert.ok(mac.seen[0][1].some((a) => /multiple selections allowed/.test(a)));
  assert.deepEqual(await pickFiles({ platform: 'darwin', run: fake({ code: 1, stderr: 'User canceled. (-128)' }) }), { cancelled: true });
  assert.deepEqual(await pickFiles({ platform: 'linux', run: fake({ stdout: '/home/me/a.mp4\n' }) }), { paths: ['/home/me/a.mp4'] });
  await assert.rejects(pickFiles({ platform: 'linux', run: fake({ missing: true }) }), /zenity or kdialog/);
});

test('the routes: only the owner; a picked list comes back; a cancel is a cancel', async () => {
  const answers = [{ paths: ['/x/a.mp4'] }, { cancelled: true }];
  await studio(async ({ call }) => {
    assert.equal((await call('/import/pick-files', 'POST', {}, AGENT)).status, 403);
    assert.deepEqual((await call('/import/pick-files', 'POST', {})).body.paths, ['/x/a.mp4']);
    assert.equal((await call('/import/pick-files', 'POST', {})).body.cancelled, true);
    assert.equal((await call('/import/videos', 'POST', { project: 'x', paths: ['/a.mp4'] }, AGENT)).status, 403);
    assert.equal((await call('/import/videos', 'POST', { project: 'no-such', paths: [] })).status, 404);
  }, { pickFiles: async () => answers.shift() });
});

test('importing: the files stay put, a mount is written, each video becomes a built post on the calendar with its picture and sound', { skip, timeout: 120000 }, async () => {
  const a = clip('Morning Rush.mp4', 2), b = clip('second_take.mp4', 3);
  await studio(async ({ call, work }) => {
    const project = await firstProject(call);
    const bad = await call('/import/videos', 'POST', { project, paths: [join(dir, 'notes.txt')] });
    assert.equal(bad.status, 400);
    assert.match(bad.body.errors[0].message, /not a video file/);
    assert.equal((await call('/import/videos', 'POST', { project, paths: [join(dir, 'gone.mp4')] })).status, 404);
    assert.equal((await call('/import/videos', 'POST', { project, paths: [] })).status, 400);
    assert.equal((await call('/import/videos', 'POST', { project, paths: [a], size: 'nope' })).status, 400);

    const r = await call('/import/videos', 'POST', { project, paths: [a, b], size: 'ig-reel-9x16', mode: 'each' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.posts.length, 2);
    const [p1, p2] = r.body.posts;
    assert.equal(p1.title, 'Morning Rush');
    assert.equal(p2.title, 'Second take');
    assert.ok(Math.abs(p1.seconds - 2) < 0.2 && Math.abs(p2.seconds - 3) < 0.2);
    assert.equal(Object.keys(r.body.mounts).length, 1, 'one folder was written down, once');
    assert.ok(existsSync(a) && existsSync(b), 'the originals are untouched');
    const projDir = join(work, 'projects', project);
    const local = JSON.parse(readFileSync(join(projDir, 'nordle.local.json'), 'utf8'));
    assert.ok(Object.values(local.mounts).includes(dir));
    const doc = JSON.parse(readFileSync(join(projDir, 'docs', `${p1.docId}.json`), 'utf8'));
    assert.equal(doc.kind, 'video');
    const src = Object.values(doc.sources)[0];
    assert.match(src.path, /^mount:footage[\w-]*\/Morning Rush\.mp4$/);
    const clips = doc.timeline.tracks.flatMap((t) => t.clips);
    assert.ok(clips.some((c) => Math.abs(c.out - c.in - 2) < 0.2), 'the whole video is on the timeline');
    assert.ok(!clips.some((c) => c.mute), 'with its sound');
    const cal = (await call(`/projects/${project}/calendar?from=2026-10-01&to=2026-12-31`)).body.calendar.items;
    const item = cal.find((i) => i.id === p1.itemId);
    assert.equal(item.status, 'built');
    assert.equal(item.doc, p1.docId);
    assert.equal(item.format, 'reel');
    assert.notEqual(p1.date, p2.date, 'each on its own weekday');
    // the same folder again does not add another mount; a second import joins two videos into one post
    const c = clip('third.mp4', 1);
    const j = await call('/import/videos', 'POST', { project, paths: [a, c], mode: 'together' });
    assert.equal(j.status, 201, JSON.stringify(j.body));
    assert.deepEqual(j.body.mounts, {}, 'the folder is already known');
    assert.equal(j.body.posts.length, 1);
    assert.match(j.body.posts[0].title, /and 1 more/);
    const joined = JSON.parse(readFileSync(join(projDir, 'docs', `${j.body.posts[0].docId}.json`), 'utf8'));
    assert.equal(joined.timeline.tracks.flatMap((t) => t.clips).length >= 2, true);
  });
});

test('the Create page: Choose videos, see them listed, bring them in, and open one in the video editor', { skip, timeout: 180000 }, async () => {
  const v = clip('page-test.mp4', 2);
  await studioPage(async ({ page, open }) => {
    await open(`#/s/create?today=${TODAY}`);
    await page.waitForSelector('[data-section="videos"]');
    assert.equal(await page.locator('[data-act="create-import-videos"]').isDisabled(), true, 'nothing chosen yet');
    await page.locator('[data-act="create-pick-videos"]').click();
    await page.waitForSelector('[data-field="create-videos"] .pick-path');
    assert.equal(await page.locator('[data-field="create-videos"] .pick-path').innerText(), 'page-test.mp4');
    await page.locator('[data-act="create-import-videos"]').click();
    await page.waitForSelector('[data-state="videos-done"] [data-act="open-video-editor"]', { timeout: 60000 });
    assert.match(await page.locator('[data-state="videos-done"]').innerText(), /Page test/);
    await page.locator('[data-act="open-video-editor"]').click();
    await page.waitForSelector('.vt-clip', { timeout: 60000 });
    assert.equal(await page.locator('.vt-clip').count() >= 1, true, 'the video opens in the editor with its clip on the timeline');
  }, { pickFiles: async () => ({ paths: [v] }) });
});
