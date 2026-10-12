// The video editor in a real browser against a real server, driven like a person would: the timeline, cutting, the transcript,
// keyframes, the monitor (frame, cut, source), the check, export, and the places it meets the rest of the app.
// Footage is invented (ffmpeg's test sources). Needs ffmpeg on the PATH and the rendering browser.
//   node --test tests/video-editor.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../tools/validate.mjs';
import { createNordleServer } from '../src/server/http.mjs';
import { applyOps } from '../src/shared/ops.mjs';
import { removeWords, totalDuration } from '../src/shared/cutlist.mjs';
import { closeBrowser, getBrowser, TOKEN, AGENT } from './helpers.mjs';
import { SCRIPT, wordEnd, wordStart } from './video-fixtures.mjs';
import { buildEditorProject, P, reelDoc } from './video-editor-fixtures.mjs';
import { studioPage, overview, firstWhere, TODAY } from './studio-helpers.mjs';

let fx;
const WORDS = SCRIPT.map((text, i) => ({ text, start: wordStart(i), end: wordEnd(i) }));
const REF = { track: 'v1', source: 'talk' };

before(async () => {
  fx = await buildEditorProject(mkdtempSync(join(tmpdir(), 'nordle-vedit-')));
  // a picture post, to prove pictures still open after a video
  cpSync(join(ROOT, 'samples', P, 'docs', 'spring-menu-carousel.json'), join(fx.proj, 'docs', 'spring-menu-carousel.json'));
  cpSync(join(ROOT, 'samples', P, 'assets'), join(fx.proj, 'assets'), { recursive: true });
  cpSync(join(fx.footage, 'photo.jpg'), join(fx.proj, 'assets', 'photo.jpg'));
});
after(async () => {
  await closeBrowser();
  rmSync(fx.root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
});

/** A fresh copy of the project, its own server, and a page opened on one video document. */
async function videoEditor(docId, fn, { viewport = { width: 1440, height: 900 }, allowErrors = [], setup, scheme, reducedMotion, waitFor = '.vt-clip' } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'nordle-vedit-run-'));
  cpSync(fx.projectsDir, join(work, 'projects'), { recursive: true });
  const projDir = join(work, 'projects', P);
  await setup?.(projDir);
  const app = createNordleServer({ roots: [join(work, 'projects')], token: TOKEN, agentToken: AGENT });
  const port = await app.listen(0);
  const context = await (await getBrowser()).newContext({ viewport, colorScheme: scheme, reducedMotion, acceptDownloads: false });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const call = async (path, method = 'GET', body) => {
    const res = await fetch(`http://127.0.0.1:${port}/api${path}`, { method, headers: { 'x-nordle-token': TOKEN, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return res.json();
  };
  const doc = async (id = docId) => (await call(`/projects/${P}/docs/${id}`)).doc;
  const settle = async () => {
    await page.waitForFunction(() => document.querySelector('.status')?.textContent === 'Saved');
    await page.waitForTimeout(40);
  };
  const clip = (id) => page.locator(`.vt-clip[data-id="${id}"]`);
  const clock = async () => page.locator('.vt-clock').innerText();
  /** The playhead in seconds, read from the clock above the lanes. */
  const playhead = async () => { const m = /^(\d+):(\d+\.\d+)$/.exec(await clock()); return Number(m[1]) * 60 + Number(m[2]); };
  const ctx = { page, call, doc, settle, clip, clock, playhead, port, errors, work, projDir };
  try {
    await page.goto(`http://127.0.0.1:${port}/#/p/${P}/${docId}`);
    await page.waitForSelector(waitFor);
    await fn(ctx);
    const unexpected = errors.filter((e) => !allowErrors.some((re) => re.test(e)));
    assert.deepEqual(unexpected, [], `the page reported errors: ${unexpected.join(' | ')}`);
  } finally {
    await context.close();
    await app.close();
    rmSync(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  }
}

const drag = async (page, from, to, { steps = 10, keys = [] } = {}) => {
  for (const k of keys) await page.keyboard.down(k);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
  for (const k of keys) await page.keyboard.up(k);
};
const center = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} is not within ${tol} of ${b}`);
const clipOf = (doc, id) => doc.timeline.tracks.flatMap((t) => t.clips).find((c) => c.id === id);
const gotoSeconds = async (page, s) => { await page.keyboard.press('Home'); for (let i = 0; i < Math.floor(s); i++) await page.keyboard.press('Shift+ArrowRight'); const frames = Math.round((s % 1) * 30); for (let i = 0; i < frames; i++) await page.keyboard.press('ArrowRight'); };

// ------------------------------------------------------------------------------------------------------------ the picture

test('a video opens in the timeline editor: lanes, clips, waveforms, captions, scenes, titles and the playhead', { timeout: 120000 }, async () => {
  await videoEditor('reel-edit', async ({ page }) => {
    // the lanes, top track first, then sound, then captions
    await page.waitForSelector('.vt-lane[data-lane="captions"]');
    await page.waitForSelector('.vt-lane[data-lane="checks"]');
    const lanes = await page.$$eval('.vt-lane', (els) => els.map((e) => e.dataset.lane));
    assert.deepEqual(lanes, ['checks', 'scenes', 'layers', 'track:v2', 'track:v1', 'track:music', 'captions']);
    assert.equal(await page.locator('.vt-clip').count(), 5);
    assert.deepEqual(await page.$$eval('.vt-scene .vt-label', (e) => e.map((x) => x.textContent)), ['Hook', 'Rest']);
    assert.equal(await page.locator('.vt-layer .vt-label').innerText(), 'Hello there');
    assert.match(await page.locator('.vt-lane[data-lane="track:v1"] .vt-head').innerText(), /Picture/);
    // a waveform is really drawn (and the speaker's part is tinted differently from the music)
    await page.waitForFunction(() => document.querySelectorAll('.vt-wave[data-ready="1"]').length >= 3);
    const drawn = await page.$$eval('.vt-wave[data-ready="1"]', (cs) => cs.map((c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let on = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) on++; return on; }));
    assert.ok(drawn.every((n) => n > 50), `every waveform has pixels: ${drawn}`);
    const speaker = await page.evaluate(() => { const c = document.querySelector('.vt-clip[data-id="c1"] .vt-wave'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; const seen = new Set(); for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0) seen.add(`${d[i]},${d[i + 1]},${d[i + 2]}`); return [...seen]; });
    assert.ok(speaker.includes('23,103,74'), `the speech tint is in the speaker's clip: ${speaker}`);
    // the captions lane is a canvas with one block per word that is kept
    assert.equal(await page.locator('.vt-caps').getAttribute('data-words'), '16');
    // the length line and the platform limits
    assert.match(await page.locator('.vt-length').innerText(), /10 s long.*Fits under 15, 30, 60 and 90 s.*Instagram Reel 9:16 allows up to 180 s/);
    // the monitor, the tabs, the toolbar
    assert.deepEqual(await page.$$eval('.vx-tabs button', (b) => b.map((x) => x.firstChild.textContent)), ['Inspector', 'Transcript', 'Check', 'Review', 'Export']);
    assert.equal(await page.getAttribute('.vt-scroll', 'role'), 'application');
    assert.ok(await page.getAttribute('.vt-scroll', 'aria-describedby'));
    assert.equal(await page.locator('.vm-head [data-mode][aria-pressed="true"]').getAttribute('data-mode'), 'frame');
    // the picture editor's panels are not there for a video
    assert.equal(await page.locator('.page-item:visible').count(), 0);
    assert.equal(await page.locator('.workspace:visible').count(), 0);
  });
});

test('fits at 1280 and at 1920 wide: nothing runs off the page, the monitor, side panel and timeline all have room', { timeout: 120000 }, async () => {
  for (const viewport of [{ width: 1280, height: 720 }, { width: 1920, height: 1080 }]) {
    await videoEditor('reel-edit', async ({ page }) => {
      const r = await page.evaluate(() => {
        const box = (s) => { const b = document.querySelector(s).getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
        return { monitor: box('.vx-monitor'), frame: box('.vm-frame'), side: box('.vx-side'), timeline: box('.vx-timeline'), scrollW: document.documentElement.scrollWidth, innerW: innerWidth, innerH: innerHeight, scrollH: document.documentElement.scrollHeight };
      });
      assert.ok(r.scrollW <= r.innerW && r.scrollH <= r.innerH, `${viewport.width}: the page itself does not scroll (${r.scrollW}x${r.scrollH})`);
      assert.ok(r.frame.h >= 200 && r.frame.w >= 110, `${viewport.width}: the picture has room: ${JSON.stringify(r.frame)}`);
      assert.ok(r.timeline.h >= 190, `${viewport.width}: the timeline has room: ${r.timeline.h}`);
      assert.ok(r.side.w >= 280 && r.side.x + r.side.w <= r.innerW + 1, `${viewport.width}: the side panel is on the page`);
      assert.ok(r.timeline.x === 0 && Math.abs(r.timeline.w - r.innerW) <= 1, `${viewport.width}: the timeline is full width`);
      assert.ok(r.frame.y >= 48 && r.frame.y + r.frame.h <= r.timeline.y + 1, `${viewport.width}: the picture sits above the timeline`);
      // the whole video fits in the timeline window (no sideways scroll to see the end)
      assert.ok(await page.evaluate(() => { const s = document.querySelector('.vt-scroll'); return s.scrollWidth <= s.clientWidth + 2; }), 'zoom to fit shows everything');
    }, { viewport });
  }
});

test('the lanes and the clips are labelled for a keyboard and a screen reader', { timeout: 60000 }, async () => {
  await videoEditor('reel-edit', async ({ page, clip }) => {
    assert.match(await clip('c2').getAttribute('aria-label'), /^Clip c2, video track Picture, source talk, starts at 0:02\.90, lasts 5 s/);
    assert.equal(await clip('c2').getAttribute('role'), 'button');
    assert.equal(await clip('c2').getAttribute('aria-pressed'), 'false');
    await clip('c2').click();
    assert.equal(await clip('c2').getAttribute('aria-pressed'), 'true');
    for (const act of ['mute', 'solo', 'lock']) assert.match(await page.locator(`.vt-lane[data-lane="track:v1"] [data-act="${act}"]`).getAttribute('aria-label'), new RegExp(`${act} track Picture`, 'i'));
    // every button on the page has a name
    const nameless = await page.$$eval('.vx button, .vx [role="button"]', (els) => els.filter((e) => !(e.getAttribute('aria-label') || e.textContent.trim() || e.title)).map((e) => e.outerHTML.slice(0, 80)));
    assert.deepEqual(nameless, []);
    // focus is visible for someone using the keyboard
    await clip('c1').focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.id), 'c1');
    assert.notEqual(await clip('c1').evaluate((e) => getComputedStyle(e).outlineStyle), 'none');
  });
});

// ------------------------------------------------------------------------------------------------------------ cutting

test('click selects; S splits at the playhead; Delete ripples and the length updates; Ctrl+Z puts it back exactly', { timeout: 120000 }, async () => {
  await videoEditor('reel-edit', async ({ page, doc, settle, clip, playhead }) => {
    const original = await doc();
    // click selects, and the Inspector fills in
    await clip('c2').click();
    assert.match(await clip('c2').getAttribute('class'), /selected/);
    await page.waitForSelector('.vx-panel[data-panel="inspector"] [data-field="clip-at"]');
    assert.equal(await page.inputValue('[data-field="clip-at"]'), '2.9');
    // the playhead to 4 s, split
    await gotoSeconds(page, 4);
    near(await playhead(), 4, 0.001, 'playhead');
    await page.keyboard.press('s');
    await settle();
    let d = await doc();
    assert.deepEqual(d.timeline.tracks[0].clips.map((c) => c.id), ['c1', 'c2', 'c2-b', 'pic']);
    near(clipOf(d, 'c2').out, 4.5, 0.001); near(clipOf(d, 'c2-b').in, 4.5, 0.001); near(clipOf(d, 'c2-b').at, 4, 0.001);
    assert.equal(await page.locator('.vt-clip').count(), 6);
    // delete the first clip: the rest closes up and the video is shorter by exactly its length
    await clip('c1').click();
    await page.keyboard.press('Delete');
    await settle();
    d = await doc();
    assert.deepEqual(d.timeline.tracks[0].clips.map((c) => c.id), ['c2', 'c2-b', 'pic']);
    near(clipOf(d, 'c2').at, 0, 1e-6); near(clipOf(d, 'c2-b').at, 1.1, 1e-6); near(clipOf(d, 'pic').at, 6.1, 1e-6);
    near(d.timeline.duration, 7.1, 1e-6, 'duration');
    assert.match(await page.locator('.vt-length').innerText(), /^7\.1 s long \(213 frames/);
    // the scenes and the title moved with it (the title sat inside the cut part, so it is shortened or gone)
    assert.ok(d.timeline.scenes.every((s) => s.end <= 7.1 + 1e-6));
    // undo twice: exactly what it was
    await page.keyboard.press('Control+z'); await settle();
    await page.keyboard.press('Control+z'); await settle();
    assert.deepEqual(await doc(), original);
    assert.equal(await page.locator('.vt-clip').count(), 5);
    // redo brings the split back
    await page.keyboard.press('Control+y'); await settle();
    assert.deepEqual((await doc()).timeline.tracks[0].clips.map((c) => c.id), ['c1', 'c2', 'c2-b', 'pic']);
  });
});

test('the ripple toggle: with it off, Delete leaves a gap; the toolbar says which it is', { timeout: 60000 }, async () => {
  await videoEditor('reel-edit', async ({ page, doc, settle, clip }) => {
    const btn = page.locator('.vt-tools [data-act="ripple"]');
    assert.equal(await btn.getAttribute('aria-pressed'), 'true');
    assert.match(await btn.getAttribute('aria-label'), /Ripple delete is on/);
    await btn.click();
    assert.equal(await btn.getAttribute('aria-pressed'), 'false');
    assert.match(await btn.getAttribute('aria-label'), /Ripple delete is off/);
    await clip('c1').click();
    await page.keyboard.press('Delete');
    await settle();
    const d = await doc();
    near(clipOf(d, 'c2').at, 2.9, 1e-6, 'nothing closed up');
    near(d.timeline.duration, 10, 1e-6);
    // the toolbar button does the same as the key
    await clip('c2').click();
    await page.click('.vt-tools [data-act="delete"]');
    await settle();
    assert.equal(clipOf(await doc(), 'c2'), undefined);
  });
});

test('dragging a clip edge trims it (source in and out shown while dragging, one undo step); a photo stretches', { timeout: 120000 }, async () => {
  await videoEditor('reel-edit', async ({ page, doc, settle, clip }) => {
    const original = await doc();
    const b = await clip('c2').boundingBox();
    const pps = b.width / 5;
    // the tail: 0.8 s shorter (the clip must be selected for its handles... they are there always)
    await clip('c2').click();
    await drag(page, { x: b.x + b.width - 3, y: b.y + b.height / 2 }, { x: b.x + b.width - 3 - 0.8 * pps, y: b.y + b.height / 2 });
    await settle();
    let d = await doc();
    near(clipOf(d, 'c2').out, 8.4 - 0.8, 0.12, 'out');
    assert.equal(clipOf(d, 'c2').in, 3.4);
    near(clipOf(d, 'c2').at, 2.9, 1e-6);
    // the head: 0.5 s later, the tail stays where it is
    const b2 = await clip('c2').boundingBox();
    const tailBefore = clipOf(d, 'c2').at + (clipOf(d, 'c2').out - clipOf(d, 'c2').in);
    await drag(page, { x: b2.x + 3, y: b2.y + b2.height / 2 }, { x: b2.x + 3 + 0.5 * pps, y: b2.y + b2.height / 2 });
    await settle();
    d = await doc();
    near(clipOf(d, 'c2').in, 3.4 + 0.5, 0.12, 'in');
    near(clipOf(d, 'c2').at + (clipOf(d, 'c2').out - clipOf(d, 'c2').in), tailBefore, 0.01, 'the tail stays');
    // a tooltip shows the source times while the pointer is down
    const b3 = await clip('c1').boundingBox();
    await page.mouse.move(b3.x + b3.width - 3, b3.y + b3.height / 2);
    await page.mouse.down();
    await page.mouse.move(b3.x + b3.width - 30, b3.y + b3.height / 2, { steps: 5 });
    await page.waitForFunction(() => /source in 0:00\.50 to/.test(document.querySelector('.vt-tip')?.textContent ?? ''));
    await page.mouse.up();
    await settle();
    // two trims + the third: three undo steps take it back exactly
    for (let i = 0; i < 3; i++) { await page.keyboard.press('Control+z'); await settle(); }
    assert.deepEqual(await doc(), original);
    // a photo can be stretched (it has no footage to run out of)
    await page.click('.vt-tools [data-act="zoom-out"]');
    const p2 = await clip('pic').boundingBox();
    await drag(page, { x: p2.x + p2.width - 3, y: p2.y + p2.height / 2 }, { x: p2.x + p2.width - 3 + 40, y: p2.y + p2.height / 2 });
    await settle();
    d = await doc();
    assert.ok(clipOf(d, 'pic').out > 1.3, `the photo is shown for longer: ${clipOf(d, 'pic').out}`);
    assert.equal(clipOf(d, 'pic').in, 0);
  });
});

test('dragging a clip moves it and snaps; moving onto another clip is refused in plain words and nothing changes', { timeout: 120000 }, async () => {
  await videoEditor('reel-edit', async ({ page, doc, settle, clip }) => {
    const original = await doc();
    const b = await clip('cutaway').boundingBox();
    const pps = (await clip('c2').boundingBox()).width / 5;
    // a free move: one second later (snapping lands it on a frame or an edge)
    await drag(page, center(b), { x: b.x + b.width / 2 + pps, y: b.y + b.height / 2 });
    await settle();
    let d = await doc();
    near(clipOf(d, 'cutaway').at, 4, 0.2, 'moved');
    near(clipOf(d, 'cutaway').at * 30, Math.round(clipOf(d, 'cutaway').at * 30), 1e-6, 'on a whole frame');
    await page.keyboard.press('Control+z'); await settle();
    assert.deepEqual(await doc(), original);
    // onto a neighbour: refused
    const c1 = await clip('c1').boundingBox();
    await drag(page, center(c1), { x: c1.x + c1.width / 2 + pps, y: c1.y + c1.height / 2 });
    await page.waitForSelector('.toast.error');
    assert.match(await page.locator('.toast.error').first().innerText(), /already plays/);
    await settle();
    assert.deepEqual(await doc(), original, 'the document is untouched');
    // and the clip is back where it was on screen
    near((await clip('c1').boundingBox()).x, c1.x, 1);
    // Shift ripples: moving c1 later pushes the clips after it along
    await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
    await drag(page, center(c1), { x: c1.x + c1.width / 2 + pps * 0.5, y: c1.y + c1.height / 2 }, { keys: ['Shift'] });
    await settle();
    d = await doc();
    assert.ok(clipOf(d, 'c1').at > 0.3 && clipOf(d, 'c2').at > 2.9 + 0.3, `c1 at ${clipOf(d, 'c1').at}, c2 at ${clipOf(d, 'c2').at}`);
  });
});

test('mute, solo and lock on a track header are written to the track', { timeout: 60000 }, async () => {
  await videoEditor('reel-edit', async ({ page, doc, settle, clip }) => {
    const lane = (id) => page.locator(`.vt-lane[data-lane="track:${id}"]`);
    await lane('v1').locator('[data-act="mute"]').click(); await settle();
    assert.equal((await doc()).timeline.tracks[0].mute, true);
    assert.equal(await lane('v1').locator('[data-act="mute"]').getAttribute('aria-pressed'), 'true');
    await lane('music').locator('[data-act="solo"]').click(); await settle();
    assert.equal((await doc()).timeline.tracks[2].solo, true);
    assert.match(await lane('v1').getAttribute('class'), /dim/, 'other tracks are dimmed while one is soloed');
    await lane('v1').locator('[data-act="mute"]').click(); await settle();
    assert.equal('mute' in (await doc()).timeline.tracks[0], false, 'turned off, the key is removed');
    // a locked track cannot be cut
    await lane('v1').locator('[data-act="lock"]').click(); await settle();
    assert.equal((await doc()).timeline.tracks[0].lock, true);
    await clip('c1').click();
    await page.keyboard.press('Delete');
    await page.waitForSelector('.toast.error');
    assert.match(await page.locator('.toast.error').first().innerText(), /locked/);
    // the Inspector shows the track and its switches
    await lane('v1').locator('.vt-name').click();
    await page.waitForSelector('[data-field="track-name"]');
    await page.fill('[data-field="track-name"]', 'Main picture'); await page.keyboard.press('Tab'); await settle();
    assert.equal((await doc()).timeline.tracks[0].name, 'Main picture');
  });
});

test('scenes: drag a boundary (both scenes follow), rename, add one at the playhead, delete', { timeout: 120000 }, async () => {
  await videoEditor('reel-edit', async ({ page, doc, settle }) => {
    const hook = await page.locator('.vt-scene[data-id="hook"]').boundingBox();
    const pps = hook.width / 3;
    // the edge between Hook and Rest, a second earlier
    await drag(page, { x: hook.x + hook.width - 2, y: hook.y + hook.height / 2 }, { x: hook.x + hook.width - 2 - pps, y: hook.y + hook.height / 2 });
    await settle();
    let d = await doc();
    near(d.timeline.scenes[0].end, 2, 0.12, 'hook ends earlier');
    assert.equal(d.timeline.scenes[1].start, d.timeline.scenes[0].end, 'the next scene starts where it ends');
    // rename by double-click
    await page.locator('.vt-scene[data-id="rest"]').dblclick();
    await page.fill('dialog input', 'The rest');
    await page.click('dialog .btn.primary');
    await settle();
    assert.equal((await doc()).timeline.scenes[1].title, 'The rest');
    // add a scene at the playhead: splits the one under it
    await gotoSeconds(page, 6);
    await page.click('.vt-lane[data-lane="scenes"] .vt-add');
    await settle();
    d = await doc();
    assert.equal(d.timeline.scenes.length, 3);
    near(d.timeline.scenes[1].end, 6, 0.001);
    near(d.timeline.scenes[2].start, 6, 0.001);
    // delete the selected scene
    await page.locator('.vt-scene[data-id="rest-2"]').click();
    await page.keyboard.press('Delete');
    await settle();
    assert.equal((await doc()).timeline.scenes.length, 2);
  });
});

test('titles: drag the bar to move it, drag an edge to change when it goes; the Inspector edits its text and times', { timeout: 120000 }, async () => {
  await videoEditor('reel-edit', async ({ page, doc, settle }) => {
    const bar = await page.locator('.vt-layer[data-id="title"]').boundingBox();
    const pps = (await page.locator('.vt-clip[data-id="c2"]').boundingBox()).width / 5;
    await drag(page, center(bar), { x: bar.x + bar.width / 2 + pps, y: bar.y + bar.height / 2 });
    await settle();
    let t = (await doc()).layers[0].time;
    near(t.start, 1.4, 0.15); near(t.end - t.start, 2.2, 0.001, 'length unchanged');
    const bar2 = await page.locator('.vt-layer[data-id="title"]').boundingBox();
    await drag(page, { x: bar2.x + bar2.width - 3, y: bar2.y + bar2.height / 2 }, { x: bar2.x + bar2.width - 3 + pps * 0.5, y: bar2.y + bar2.height / 2 });
    await settle();
    t = (await doc()).layers[0].time;
    near(t.end, 3.6 + 0.5, 0.15);
    await page.waitForSelector('[data-field="layer-text"]');
    await page.fill('[data-field="layer-text"]', 'A new title'); await page.keyboard.press('Tab'); await settle();
    assert.equal((await doc()).layers[0].text, 'A new title');
    assert.equal(await page.locator('.vt-layer .vt-label').innerText(), 'A new title');
    await page.fill('[data-field="layer-start"]', '0.5'); await page.keyboard.press('Tab'); await settle();
    near((await doc()).layers[0].time.start, 0.5, 1e-6);
    // an end before the start is refused with the server's own words, and the field goes back
    await page.fill('[data-field="layer-end"]', '0.1'); await page.keyboard.press('Tab');
    await page.waitForSelector('.toast.error');
    assert.ok(((await doc()).layers[0].time.end) > 0.5);
  });
});

test('the keyboard alone: pick a clip, move the playhead, split, nudge, set the start, delete, undo', { timeout: 120000 }, async () => {
  await videoEditor('reel-edit', async ({ page, doc, settle, clip, playhead }) => {
    const original = await doc();
    await clip('c2').focus();
    await page.keyboard.press('Enter');
    assert.equal(await clip('c2').getAttribute('aria-pressed'), 'true');
    // one frame, one second, home, end
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    near(await playhead(), 1 / 30, 0.006);
    await page.keyboard.press('Shift+ArrowRight');
    near(await playhead(), 1 + 1 / 30, 0.006);
    await page.keyboard.press('End');
    assert.ok((await playhead()) >= 9.9);
    // Alt+arrow moves the selection along the track
    await page.keyboard.press('Alt+ArrowLeft');
    assert.equal(await clip('c1').getAttribute('aria-pressed'), 'true');
    await page.keyboard.press('Alt+ArrowRight');
    assert.equal(await clip('c2').getAttribute('aria-pressed'), 'true');
    // split at 4 s
    await gotoSeconds(page, 4);
    await page.keyboard.press('s'); await settle();
    assert.ok(clipOf(await doc(), 'c2-b'));
    // I sets the start of the selected clip at the playhead (here the clip c2 is now 2.9 to 4)
    await gotoSeconds(page, 3);
    await page.keyboard.press('i'); await settle();
    near(clipOf(await doc(), 'c2').in, 3.4 + 0.1, 0.001, 'in moved by the 0.1 s the playhead is past the start');
    // delete, then undo everything
    await page.keyboard.press('Delete'); await settle();
    assert.equal(clipOf(await doc(), 'c2'), undefined);
    for (let i = 0; i < 3; i++) { await page.keyboard.press('Control+z'); await settle(); }
    assert.deepEqual(await doc(), original);
    // the zoom keys
    const before = (await clip('c1').boundingBox()).width;
    await page.keyboard.press('+');
    assert.ok((await clip('c1').boundingBox()).width > before * 1.2);
    await page.keyboard.press('0');
    near((await clip('c1').boundingBox()).width, before, 2);
  });
});

// ------------------------------------------------------------------------------------------------------------ the transcript

test('transcript: select words and Delete cuts them (one undo step, the exact cut list), a struck word brings it back, the running line says how much is kept', { timeout: 120000 }, async () => {
  await videoEditor('reel-edit', async ({ page, doc, settle }) => {
    const original = await doc();
    await page.click('[data-tab="transcript"]');
    await page.waitForFunction(() => document.querySelectorAll('.tw').length === 17);
    assert.equal(await page.locator('.tw.cut').count(), 1, 'the last word is already out of the video');
    assert.equal(await page.locator('.tw.cut').innerText(), 'days.');
    assert.match(await page.locator('.vtr-summary').innerText(), /^Kept 7\.9 s of 12 s \(1 word cut\)\. The video is 10 s long\./);
    // click puts the playhead on the word (word 6 "Come" starts at 3.5 s in the recording = 3.0 s in the video)
    await page.locator('.tw[data-i="6"]').click();
    await page.waitForFunction(() => document.querySelector('.vt-clock').textContent === '0:03.00');
    // click, then Shift+click selects a range: words 2 to 4
    await page.locator('.tw[data-i="2"]').click();
    await page.locator('.tw[data-i="4"]').click({ modifiers: ['Shift'] });
    assert.equal(await page.locator('.tw.picked').count(), 3);
    await page.keyboard.press('Delete');
    await settle();
    const expected = applyOps(original, removeWords(original, REF, WORDS, 2, 4)).doc;
    const cut = await doc();
    assert.deepEqual(cut.timeline, expected.timeline, 'exactly the cut list the module makes');
    assert.ok(totalDuration(cut) < totalDuration(original) - 1);
    assert.equal(await page.locator('.tw.cut').count(), 4);
    assert.match(await page.locator('.vtr-summary').innerText(), /4 words cut/);
    assert.match(await page.locator('.vt-length').innerText(), new RegExp(`^${Number(totalDuration(cut).toFixed(2))} s long`));
    // one undo step
    await page.keyboard.press('Control+z'); await settle();
    assert.deepEqual(await doc(), original);
    await page.keyboard.press('Control+y'); await settle();
    assert.deepEqual((await doc()).timeline, expected.timeline);
    // click a struck word: it comes back (the whole stretch of words 2 to 4 is cut, one word returns)
    await page.locator('.tw[data-i="3"]').click();
    await settle();
    assert.equal(await page.locator('.tw.cut').count(), 3);
    // select the other two struck words and press Enter: they come back too
    await page.locator('.tw[data-i="2"]').click({ modifiers: ['Control'] });
    await page.locator('.tw[data-i="4"]').click({ modifiers: ['Control'] });
    await page.keyboard.press('Enter');
    await settle();
    assert.equal(await page.locator('.tw.cut').count(), 1);
    near(totalDuration(await doc()), 10, 0.1, 'about the length it was (the quiet around the words comes back too)');
    // dragging across words selects a range
    const a = await page.locator('.tw[data-i="9"]').boundingBox();
    const b = await page.locator('.tw[data-i="11"]').boundingBox();
    await drag(page, center(a), center(b), { steps: 12 });
    assert.equal(await page.locator('.tw.picked').count(), 3);
    assert.match(await page.locator('[data-act="cut-words"]').innerText(), /Cut 3 words/);
  });
});

test('transcript: search highlights matching words, and the filler button selects every um, uh and like for one cut', { timeout: 120000 }, async () => {
  await videoEditor('reel-fillers', async ({ page, doc, settle }) => {
    const original = await doc();
    await page.click('[data-tab="transcript"]');
    await page.waitForFunction(() => document.querySelectorAll('.tw').length === 17);
    // search
    await page.fill('.vtr-search', 'house');
    assert.equal(await page.locator('.tw.hit').count(), 1);
    assert.match(await page.locator('.vtr-hits').innerText(), /0 of 1|1 of 1/);
    await page.fill('.vtr-search', 'visit noodle');
    assert.equal(await page.locator('.tw.hit').count(), 2, 'a phrase highlights each of its words');
    await page.fill('.vtr-search', '');
    assert.equal(await page.locator('.tw.hit').count(), 0);
    // fillers
    const btn = page.locator('[data-act="fillers"]');
    assert.equal(await btn.innerText(), 'Select fillers (3)');
    await btn.click();
    assert.equal(await page.locator('.tw.picked').count(), 3);
    assert.deepEqual(await page.$$eval('.tw.picked', (e) => e.map((x) => x.textContent)), ['um', 'uh', 'like']);
    await page.keyboard.press('Delete');
    await settle();
    // the same cut the module makes, one run at a time
    const fill = SCRIPT.map((text, i) => ({ text: { 2: 'um', 7: 'uh', 14: 'like' }[i] ?? text, start: wordStart(i), end: wordEnd(i) }));
    let want = original;
    for (const i of [2, 7, 14]) want = applyOps(want, removeWords(want, REF, fill, i, i)).doc;
    assert.deepEqual((await doc()).timeline, want.timeline);
    assert.equal(await btn.innerText(), 'Select fillers (0)');
    assert.equal(await btn.isDisabled(), true);
    // one undo brings all three back
    await page.keyboard.press('Control+z'); await settle();
    assert.deepEqual(await doc(), original);
  });
});

// ------------------------------------------------------------------------------------------------------------ keyframes

test('keyframes: add at the playhead, edit the value, delete; animation presets add and remove', { timeout: 120000 }, async () => {
  await videoEditor('reel-edit', async ({ page, doc, settle }) => {
    await page.locator('.vt-layer[data-id="title"]').click();
    await page.waitForSelector('[data-act="add-keyframe"]');
    // outside the title: refused with a plain message
    await gotoSeconds(page, 6);
    await page.click('[data-act="add-keyframe"]');
    await page.waitForSelector('.toast.error');
    assert.match(await page.locator('.toast.error').first().innerText(), /Move the playhead onto "title"/);
    // inside: 1.0 s into the video is 0.6 s into the title (it starts at 0.4)
    await gotoSeconds(page, 1);
    await page.selectOption('[data-field="kf-prop"]', 'scale');
    await page.click('[data-act="add-keyframe"]');
    await settle();
    let anim = (await doc()).layers[0].animate;
    const kf = anim.find((a) => a.keyframes).keyframes;
    assert.equal(kf.length, 2, 'a keyframe animation needs two, so a matching one is added at the other end');
    assert.deepEqual(kf.map((k) => k.prop), ['scale', 'scale']);
    near(kf[0].t, 0.6, 1e-6); near(kf[1].t, 2.2, 1e-6);
    assert.equal(anim[0].preset, 'rise-in', 'the preset is still there');
    // a third at 2.0 s, edit its value
    await gotoSeconds(page, 2);
    await page.click('[data-act="add-keyframe"]');
    await settle();
    anim = (await doc()).layers[0].animate;
    assert.equal(anim.find((a) => a.keyframes).keyframes.length, 3);
    await page.waitForSelector('[data-field="kf-3-value"], [data-field="kf-2-value"]');
    const field = (await page.locator('[data-field="kf-2-value"]').count()) ? 'kf-2-value' : 'kf-3-value';
    await page.fill(`[data-field="${field}"]`, '1.4'); await page.keyboard.press('Tab'); await settle();
    assert.ok((await doc()).layers[0].animate.find((a) => a.keyframes).keyframes.some((k) => k.value === 1.4));
    // delete one: two are left
    await page.locator('.vi-kf [aria-label^="Delete the scale keyframe"]').first().click(); await settle();
    assert.equal((await doc()).layers[0].animate.find((a) => a.keyframes).keyframes.length, 2);
    // deleting another would leave one: the animation goes (and the message says so)
    await page.locator('.vi-kf [aria-label^="Delete the scale keyframe"]').first().click(); await settle();
    assert.equal((await doc()).layers[0].animate.some((a) => a.keyframes), false);
    // presets
    await page.selectOption('[data-field="layer-add-preset"]', 'slide-in'); await settle();
    let a = (await doc()).layers[0].animate;
    assert.deepEqual(a.map((x) => x.preset), ['rise-in', 'slide-in']);
    await page.fill('[data-field="anim-1-duration"]', '0.8'); await page.keyboard.press('Tab'); await settle();
    await page.selectOption('[data-field="anim-1-from"]', 'left'); await settle();
    await page.selectOption('[data-field="anim-1-ease"]', 'out-back'); await settle();
    a = (await doc()).layers[0].animate;
    assert.equal(a[1].duration, 0.8); assert.equal(a[1].ease, 'out-back'); assert.deepEqual(a[1].params, { from: 'left' });
    await page.click('[aria-label="Remove the slide-in animation"]'); await settle();
    assert.deepEqual((await doc()).layers[0].animate.map((x) => x.preset), ['rise-in']);
    // the title bar shows it has motion until the last animation goes
    assert.equal(await page.locator('.vt-layer[data-id="title"]').getAttribute('class').then((c) => /kf/.test(c)), false);
  });
});

test('the Inspector edits a clip: speed, fit, focal point, zoom, grade, transition, sound, ducking; a bad value is refused with a message', { timeout: 120000 }, async () => {
  await videoEditor('reel-edit', async ({ page, doc, settle, clip }) => {
    await clip('c1').click();
    await page.waitForSelector('[data-field="clip-speed"]');
    await page.selectOption('[data-field="clip-fit"]', 'contain'); await settle();
    assert.equal(clipOf(await doc(), 'c1').fit, 'contain');
    await page.fill('[data-field="zoom-from"]', '1'); await page.keyboard.press('Tab'); await settle();
    await page.fill('[data-field="zoom-to"]', '1.2'); await page.keyboard.press('Tab'); await settle();
    assert.deepEqual(clipOf(await doc(), 'c1').zoom, { from: 1, to: 1.2 });
    await page.fill('[data-field="zoom-to"]', ''); await page.keyboard.press('Tab'); await settle();
    await page.fill('[data-field="zoom-from"]', ''); await page.keyboard.press('Tab'); await settle();
    assert.equal('zoom' in clipOf(await doc(), 'c1'), false, 'an empty zoom is removed, not left as {}');
    await page.selectOption('[data-field="clip-grade"]', 'warm'); await settle();
    await page.selectOption('[data-field="tr-type"]', 'slide'); await settle();
    await page.selectOption('[data-field="tr-direction"]', 'up'); await settle();
    assert.deepEqual(clipOf(await doc(), 'c1').transition, { type: 'slide', direction: 'up' });
    await page.fill('[data-field="clip-gain"]', '-6'); await page.keyboard.press('Tab'); await settle();
    await page.check('[data-field="clip-mute"]'); await settle();
    assert.equal(clipOf(await doc(), 'c1').gainDb, -6); assert.equal(clipOf(await doc(), 'c1').mute, true);
    assert.match(await clip('c1').getAttribute('class'), /muted/);
    // a focal point by clicking the little picture (needs the small copy of the footage, so use the number fields too)
    await page.fill('[data-field="focal-x"]', '0.3'); await page.keyboard.press('Tab'); await settle();
    assert.deepEqual(clipOf(await doc(), 'c1').focal, { x: 0.3, y: 0.5 });
    // speed that would run into the next clip is refused before it is sent
    await page.fill('[data-field="clip-speed"]', '0.5'); await page.keyboard.press('Tab');
    await page.waitForSelector('.toast.error');
    assert.match(await page.locator('.toast.error').first().innerText(), /run into "c2"/);
    assert.equal(clipOf(await doc(), 'c1').speed, undefined);
    // faster is fine; the clip gets shorter
    await page.fill('[data-field="clip-speed"]', '2'); await page.keyboard.press('Tab'); await settle();
    assert.equal(clipOf(await doc(), 'c1').speed, 2);
    // ducking on the music clip
    await clip('bed').click();
    await page.waitForSelector('[data-field="duck-on"]');
    await page.uncheck('[data-field="duck-on"]'); await settle();
    assert.equal('duck' in clipOf(await doc(), 'bed'), false);
    await page.check('[data-field="duck-on"]'); await settle();
    assert.deepEqual(clipOf(await doc(), 'bed').duck, { under: 'v1', amountDb: -12 });
    // the server's own message when the document would be invalid (a value out of range)
    await page.fill('[data-field="clip-gain"]', '40'); await page.keyboard.press('Tab');
    await page.waitForFunction(() => document.querySelectorAll('.toast.error').length >= 2);
  }, { allowErrors: [/Failed to load resource/] });
});

// ------------------------------------------------------------------------------------------------------------ the monitor

test('Frame mode: when the playhead rests the real picture (footage, title, captions) is fetched; an answer that arrives late is thrown away', { timeout: 120000 }, async () => {
  await videoEditor('reel-edit', async ({ page }) => {
    const sample = () => page.evaluate(() => new Promise((resolve) => {
      const img = document.querySelector('.vm-img');
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const x = c.getContext('2d'); x.drawImage(img, 0, 0);
      const d = x.getImageData(4, 4, 1, 1).data; // the corner: no title or caption there
      resolve({ r: d[0], g: d[1], b: d[2], w: c.width, h: c.height });
    }));
    await page.waitForSelector('.vm-img[src^="data:image/jpeg"]');
    const first = await sample();
    assert.ok(first.r > 200 && first.g < 80 && first.b < 80, `the first second of the recording is red: ${JSON.stringify(first)}`);
    assert.ok(first.h > first.w, 'a tall reel');
    // a title is drawn over the picture at 1 s (the Frame is the real render, not a guess)
    await page.keyboard.press('Shift+ArrowRight');
    await page.waitForFunction(() => document.querySelector('.vm-frame').classList.contains('stale') === false);
    // a picture is on its way (2 s in: the blue second of the recording) when the playhead moves on to 5 s (magenta): the blue one must never be shown
    await page.evaluate(() => {
      window.__seen = [];
      const img = document.querySelector('.vm-img');
      img.addEventListener('load', () => { const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; const x = c.getContext('2d'); x.drawImage(img, 0, 0); const d = x.getImageData(4, 4, 1, 1).data; window.__seen.push([d[0], d[1], d[2]]); });
    });
    const asked = page.waitForRequest((r) => /video\/stills/.test(r.url()) && r.method() === 'POST', { timeout: 10000 });
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+ArrowRight'); await page.keyboard.press('Shift+ArrowRight');
    assert.deepEqual(JSON.parse((await asked).postData()).times, [2], 'the 2 s picture is being drawn');
    for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight');
    await page.waitForFunction(() => document.querySelector('.vt-clock').textContent === '0:05.00');
    await page.waitForFunction(() => !document.querySelector('.vm-frame').classList.contains('stale') && !document.querySelector('.vm-frame').hasAttribute('aria-busy'), null, { timeout: 30000 });
    const last = await sample();
    assert.ok(last.r > 200 && last.b > 200 && last.g < 80, `5 s in is the magenta second of the recording (source 5.5 s): ${JSON.stringify(last)}`);
    const seen = await page.evaluate(() => window.__seen);
    assert.ok(seen.length >= 1);
    assert.ok(!seen.some(([r, g, b]) => b > 200 && g < 80 && r < 80), `the late blue picture was never shown: ${JSON.stringify(seen)}`);
    // the Frame carries the title: at 1 s the picture is not the plain colour all over
    await page.keyboard.press('Home'); await page.keyboard.press('Shift+ArrowRight');
    await page.waitForFunction(() => !document.querySelector('.vm-frame').classList.contains('stale'), null, { timeout: 30000 });
    const varied = await page.evaluate(() => { const img = document.querySelector('.vm-img'); const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; const x = c.getContext('2d'); x.drawImage(img, 0, 0); const d = x.getImageData(0, 0, c.width, c.height).data; const seen = new Set(); for (let i = 0; i < d.length; i += 4 * 97) seen.add(`${d[i] >> 5},${d[i + 1] >> 5},${d[i + 2] >> 5}`); return seen.size; });
    assert.ok(varied > 3, `title and captions are in the picture (${varied} colours)`);
  });
});

test('Render preview starts a job with progress, then Cut mode plays it and the playhead and the video stay in step', { timeout: 240000 }, async () => {
  await videoEditor('reel-edit', async ({ page, call }) => {
    assert.equal((await call(`/projects/${P}/video/outputs?doc=reel-edit`)).files.length, 0, 'no preview yet');
    await page.click('.vm-head [data-mode="cut"]');
    await page.waitForFunction(() => /no preview of this video yet/i.test(document.querySelector('.vm-note')?.textContent ?? ''));
    await page.click('[data-act="render-preview"]');
    await page.waitForSelector('.vm-prog progress');
    await page.waitForFunction(() => { const v = document.querySelector('.vm-video'); return v && v.style.display !== 'none' && v.readyState >= 1 && /\.preview\.mp4/.test(v.getAttribute('src') ?? ''); }, null, { timeout: 200000 });
    assert.equal(await page.locator('.vm-prog').count() === 0 || await page.locator('.vm-prog.hidden').count() === 1, true, 'the progress goes away when it is done');
    const dur = await page.evaluate(() => document.querySelector('.vm-video').duration);
    near(dur, 10, 0.2, 'the preview is the whole video');
    const out = await call(`/projects/${P}/video/outputs?doc=reel-edit`);
    assert.deepEqual(out.files.map((f) => [f.name, f.kind]), [['reel-edit.preview.mp4', 'preview']]);
    // playhead -> video: a step moves the picture
    await page.keyboard.press('Home');
    for (let i = 0; i < 15; i++) await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => Math.abs(document.querySelector('.vm-video').currentTime - 0.5) < 0.1);
    // video -> playhead: play for a moment and the clock follows
    await page.keyboard.press('Space');
    await page.waitForFunction(() => !document.querySelector('.vm-video').paused);
    await page.waitForTimeout(900);
    await page.keyboard.press('Space');
    await page.waitForFunction(() => document.querySelector('.vm-video').paused);
    const t = await page.evaluate(() => document.querySelector('.vm-video').currentTime);
    const clock = await page.locator('.vt-clock').innerText();
    const [, m, s] = /^(\d+):(\d+\.\d+)$/.exec(clock);
    assert.ok(t > 0.9, `it played: ${t}`);
    near(Number(m) * 60 + Number(s), t, 1 / 30 + 0.02, 'the clock shows where the video stopped');
    // the pause snaps the playhead to a frame
    const frame = Number(/frame (\d+)/.exec(await page.locator('.vm-time').innerText())[1]);
    assert.ok(Math.abs(frame - Math.round(t * 30)) <= 1, `frame ${frame} for ${t} s`);
    // an edit makes the preview out of date, and says so
    await page.locator('.vt-clip[data-id="cutaway"]').click();
    await page.keyboard.press('Delete');
    await page.waitForFunction(() => !document.querySelector('.vm-stale').classList.contains('hidden'));
    assert.match(await page.locator('.vm-stale').innerText(), /before your latest edits/);
  });
});

test('Source mode plays the small copy of the selected clip\'s footage; I and O set the clip\'s start and end from the monitor', { timeout: 180000 }, async () => {
  await videoEditor('reel-edit', async ({ page, doc, settle, clip }) => {
    await clip('c2').click();
    await page.click('.vm-head [data-mode="source"]');
    await page.waitForSelector('.vm-sbar:not(.hidden)', { timeout: 120000 });
    const src = await page.getAttribute('.vm-video', 'src');
    assert.match(src, /^\/p\/little-gannet\/\.proxies\/[0-9a-f]{40}\.mp4$/, 'only the small copy is ever loaded');
    await page.waitForFunction(() => document.querySelector('.vm-video').readyState >= 1);
    // it starts where the clip starts (3.4 s of the recording)
    await page.waitForFunction(() => Math.abs(document.querySelector('.vm-video').currentTime - 3.4) < 0.1);
    assert.match(await page.locator('.vm-sinfo').innerText(), /plays 0:03\.40 to 0:08\.40/);
    // find a better start: 4.0 s, press I
    await page.evaluate(() => { document.querySelector('.vm-video').currentTime = 4.0; });
    await page.waitForFunction(() => Math.abs(document.querySelector('.vm-video').currentTime - 4.0) < 0.05);
    await page.keyboard.press('i'); await settle();
    near(clipOf(await doc(), 'c2').in, 4.0, 0.04, 'in');
    await page.evaluate(() => { document.querySelector('.vm-video').currentTime = 7.0; });
    await page.waitForFunction(() => Math.abs(document.querySelector('.vm-video').currentTime - 7.0) < 0.05);
    await page.click('[data-act="set-out"]'); await settle();
    near(clipOf(await doc(), 'c2').out, 7.0, 0.04, 'out');
    // the marked part moved in the bar
    assert.match(await page.locator('.vm-sinfo').innerText(), /plays 0:04\.0\d to 0:07\.0\d/);
    // Escape goes back to the frame
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.vm-head [data-mode][aria-pressed="true"]').getAttribute('data-mode'), 'frame');
  });
});

test('pin a comment on the picture at a moment: it appears on the ruler, clicking it goes there, and the Review tab lists it', { timeout: 120000 }, async () => {
  await videoEditor('reel-edit', async ({ page, call, settle }) => {
    await gotoSeconds(page, 2);
    await page.click('[data-act="pin"]');
    const box = await page.locator('.vm-frame').boundingBox();
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.4);
    await page.fill('dialog textarea', 'Make this word bigger');
    await page.click('dialog .btn.primary');
    await page.waitForSelector('.vt-pin');
    const review = (await call(`/projects/${P}/docs/reel-edit/review`)).review;
    assert.equal(review.comments.length, 1);
    assert.equal(review.comments[0].time, 2); assert.equal(review.comments[0].page, 'video');
    near(review.comments[0].x, 0.3, 0.02);
    assert.equal(await page.locator('.vt-pin').innerText(), '1');
    await page.keyboard.press('Home');
    await page.locator('.vt-pin').click();
    await page.waitForFunction(() => document.querySelector('.vt-clock').textContent === '0:02.00');
    assert.equal(await page.locator('.vx-tabs [aria-selected="true"]').getAttribute('data-tab'), 'review');
    assert.match(await page.locator('.vx-panel[data-panel="review"]').innerText(), /Make this word bigger/);
    assert.match(await page.locator('.vx-panel[data-panel="review"] .comment .hd').first().innerText(), /at 0:02\.00/);
    // a comment made from the Review tab at the playhead
    await gotoSeconds(page, 5);
    await page.click('[data-act="comment-here"]');
    await page.fill('dialog textarea', 'Cut here?');
    await page.click('dialog .btn.primary');
    await page.waitForFunction(() => document.querySelectorAll('.vt-pin').length === 2);
    await settle();
  });
});

// ------------------------------------------------------------------------------------------------------------ the check, export

test('the Check tab lists what the plan finds (a gap, a cut before a sentence ends); click one to go there; problems are marked on the timeline', { timeout: 120000 }, async () => {
  await videoEditor('reel-edit', async ({ page, clip }) => {
    await page.click('[data-tab="check"]');
    await page.waitForSelector('.vck-item[data-code="gap"]');
    assert.match(await page.locator('.vck-item[data-code="gap"]').innerText(), /Nothing is on the picture tracks from 7\.90s to 9\.00s/);
    assert.match(await page.locator('.vck-status').innerText(), /warning/);
    assert.ok(await page.locator('.vt-lane[data-lane="checks"] .vt-mark').count() >= 1, 'marked on the timeline');
    await page.locator('.vck-item[data-code="gap"]').click();
    await page.waitForFunction(() => document.querySelector('.vt-clock').textContent === '0:07.90');
    // a clip with a problem selects it
    const clipIssue = page.locator('.vck-item[data-code^="speech-"]').first();
    if (await clipIssue.count()) { await clipIssue.click(); }
    // fix the gap (move the photo up to meet the end of c2): the list updates by itself
    await clip('pic').click();
    await page.click('[data-tab="inspector"]');
    await page.fill('[data-field="clip-at"]', '7.9'); await page.keyboard.press('Tab');
    await page.click('[data-tab="check"]');
    await page.waitForFunction(() => !document.querySelector('.vck-item[data-code="gap"]'), null, { timeout: 20000 });
  });
});

test('Export: every format this computer can make is offered (one it cannot says why and is greyed out); a GIF is made with progress and a download link', { timeout: 240000 }, async () => {
  await videoEditor('reel-edit', async ({ page, call }) => {
    await page.click('.topbar [data-act="topbar-export"]');
    await page.waitForSelector('.vex-format');
    assert.deepEqual(await page.$$eval('.vex-format button', (b) => b.map((x) => x.dataset.format)), ['mp4', 'webm', 'gif', 'prores']);
    const formats = (await call(`/projects/${P}/video/formats`)).formats;
    for (const f of formats) assert.equal(await page.locator(`[data-format="${f.id}"]`).isDisabled(), !f.available);
    // a GIF (the quickest)
    await page.click('[data-format="gif"]');
    await page.waitForSelector('.vex-done a[download]', { timeout: 200000 });
    const href = await page.getAttribute('.vex-done a[download]', 'href');
    assert.match(href, /\/out\/reel-edit\/reel-edit\.gif$/);
    const res = await fetch(`http://127.0.0.1:${new URL(page.url()).port}${href}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/gif');
    assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 4).toString('latin1'), 'GIF8');
    // the list of what has been made
    await page.click('[data-tab="inspector"]'); await page.click('[data-tab="export"]');
    assert.match(await page.locator('.vx-panel[data-panel="export"]').innerText(), /reel-edit\.gif/);
  });
});

test('Export: a format this computer cannot make is greyed out and says why', { timeout: 60000 }, async () => {
  await videoEditor('reel-edit', async ({ page }) => {
    await page.route('**/video/formats', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ formats: [
      { id: 'mp4', label: 'MP4', ext: 'mp4', sound: true, available: true },
      { id: 'webm', label: 'WebM', ext: 'webm', sound: true, available: false, problem: 'This computer\'s ffmpeg has no libvpx-vp9 encoder. Install a full ffmpeg build.' },
      { id: 'gif', label: 'GIF', ext: 'gif', sound: false, available: true },
      { id: 'prores', label: 'ProRes', ext: 'mov', sound: true, available: true }] }) }));
    await page.click('.topbar [data-act="topbar-export"]');
    await page.waitForSelector('[data-format="webm"]');
    assert.equal(await page.locator('[data-format="webm"]').isDisabled(), true);
    assert.match(await page.locator('.vex-format:has([data-format="webm"])').innerText(), /Not available on this computer: This computer's ffmpeg has no libvpx-vp9 encoder/);
    assert.equal(await page.locator('[data-format="mp4"]').isDisabled(), false);
  });
});

// ------------------------------------------------------------------------------------------------------------ trouble

test('an unplugged drive: the editor says which footage cannot be read and how to fix it, and Try again works once it is back', { timeout: 120000 }, async () => {
  let realFootage;
  await videoEditor('reel-edit', async ({ page, projDir }) => {
    await page.waitForSelector('.vt-problems:not(.hidden)', { timeout: 30000 });
    const text = await page.locator('.vt-problems').innerText();
    assert.match(text, /Footage "talk" cannot be read/);
    assert.match(text, /is the drive connected/i, `the message says what to check: ${text}`);
    assert.match(text, /nordle\.local\.json/, 'and how to fix it');
    assert.ok(await page.locator('.vt-clip.problem').count() >= 1);
    // the Check tab and the Inspector say it too
    await page.click('[data-tab="check"]');
    assert.ok(await page.locator('.vck-item[role="alert"]').count() >= 1);
    // plug it back in
    writeFileSync(join(projDir, 'nordle.local.json'), JSON.stringify({ mounts: { footage: realFootage } }));
    await page.click('.vt-problems button');
    await page.waitForSelector('.vt-problems.hidden', { state: 'attached', timeout: 30000 });
    await page.waitForFunction(() => document.querySelectorAll('.vt-wave[data-ready="1"]').length >= 3, null, { timeout: 30000 });
  }, {
    allowErrors: [/Failed to load resource/],
    setup: (projDir) => { realFootage = JSON.parse(readFileSync(join(projDir, 'nordle.local.json'), 'utf8')).mounts.footage; writeFileSync(join(projDir, 'nordle.local.json'), JSON.stringify({ mounts: { footage: join(projDir, 'not-plugged-in') } })); },
  });
});

test('a conflict (the document changed somewhere else) says so, loads the latest, and nothing is lost', { timeout: 120000 }, async () => {
  await videoEditor('reel-edit', async ({ page, call, settle, clip }) => {
    // an edit that is sent against an old version, as a second tab or Claude would cause
    await page.route('**/patch', async (route) => {
      const body = JSON.parse(route.request().postData());
      await route.continue({ postData: JSON.stringify({ ...body, baseVersion: 0 }) });
    });
    // make the server's version move on first
    // (an added key cannot be merged with an edit made against the old version, so the server refuses the edit with a 409)
    await call(`/projects/${P}/docs/reel-edit/patch`, 'POST', { ops: [{ op: 'add', path: '/tags', value: ['elsewhere'] }], baseVersion: 0, actor: 'human' });
    await clip('c2').click();
    await page.keyboard.press('Delete');
    await page.waitForSelector('.toast.error');
    assert.match(await page.locator('.toast.error').first().innerText(), /changed somewhere else/);
    await page.unroute('**/patch');
    await settle();
    assert.ok(clipOf((await call(`/projects/${P}/docs/reel-edit`)).doc, 'c2'), 'the refused edit was not applied');
    assert.equal(await page.locator('.vt-clip').count(), 5, 'the page shows what the server has');
  }, { allowErrors: [/Failed to load resource/] });
});

test('older versions are looked at read-only: editing is off with a message and a way back', { timeout: 120000 }, async () => {
  await videoEditor('reel-edit', async ({ page, settle, clip }) => {
    await page.click('[data-tab="review"]');
    await page.click('button:has-text("Save version")');
    await page.fill('dialog input', 'First cut');
    await page.click('dialog .btn.primary');
    await page.waitForSelector('.version');
    await clip('c1').click(); await page.keyboard.press('Delete'); await settle();
    assert.equal(await page.locator('.vt-clip').count(), 4);
    await page.click('.version button:has-text("View")');
    await page.waitForSelector('.vx-banner:not(.hidden)');
    assert.match(await page.locator('.vx-banner').innerText(), /Viewing First cut/);
    assert.equal(await page.locator('.vt-clip').count(), 5, 'the timeline shows the old version');
    await clip('c2').click();
    await page.keyboard.press('Delete');
    await page.waitForSelector('.toast.error');
    assert.match(await page.locator('.toast.error').first().innerText(), /looking at First cut/);
    await page.click('.vx-banner button:has-text("Back to current")');
    await page.waitForFunction(() => document.querySelectorAll('.vt-clip').length === 4);
  });
});

test('dark mode and reduced motion: the editor uses the theme tokens and nothing animates', { timeout: 120000 }, async () => {
  await videoEditor('reel-edit', async ({ page }) => {
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.match(bg, /rgb\(14, 16, 18\)/, `dark page: ${bg}`);
    const clipBg = await page.evaluate(() => getComputedStyle(document.querySelector('.vt-clip.video')).backgroundColor);
    assert.match(clipBg, /rgb\(38, 56, 74\)/, `dark clip colour: ${clipBg}`);
    const text = await page.evaluate(() => getComputedStyle(document.querySelector('.vt-label')).color);
    assert.notEqual(text, clipBg);
    // reduced motion: transitions are cut to nothing by the shared rule
    const t = await page.evaluate(() => getComputedStyle(document.querySelector('.vm-img')).transitionDuration);
    assert.match(t, /^0\.001s|1ms/);
  }, { scheme: 'dark', reducedMotion: 'reduce' });
});

test('a large video (20 clips, 8 tracks) stays quick: lanes are blocks, drags are one update a frame', { timeout: 180000 }, async () => {
  const many = () => {
    const d = reelDoc('big-reel');
    d.timeline.duration = 60;
    d.timeline.tracks = [];
    for (let t = 0; t < 6; t++) d.timeline.tracks.push({ id: `v${t + 1}`, type: 'video', clips: Array.from({ length: 3 }, (_, i) => ({ id: `v${t + 1}-c${i + 1}`, source: 'broll', in: i * 1.5, out: i * 1.5 + 1.4, at: i * 4 + t * 0.3 })) });
    d.timeline.tracks.push({ id: 'music', type: 'audio', clips: [{ id: 'bed', source: 'music', in: 0, out: 12, at: 0 }, { id: 'bed2', source: 'music', in: 0, out: 12, at: 13 }] });
    d.timeline.tracks.push({ id: 'sfx', type: 'audio', clips: Array.from({ length: 3 }, (_, i) => ({ id: `sfx${i}`, source: 'music', in: i, out: i + 1, at: 30 + i * 2 })) });
    d.timeline.scenes = []; d.layers = []; delete d.timeline.captions;
    return d;
  };
  await videoEditor('big-reel', async ({ page, settle }) => {
    assert.equal(await page.locator('.vt-clip').count(), 18 + 2 + 3);
    assert.equal(await page.locator('.vt-lane[data-lane^="track:"]').count(), 8);
    // a zoom in and out and a scrub, timed: no step takes long
    const t0 = Date.now();
    for (let i = 0; i < 6; i++) await page.keyboard.press('+');
    for (let i = 0; i < 6; i++) await page.keyboard.press('-');
    await page.keyboard.press('0');
    const ruler = await page.locator('.vt-rbody').boundingBox();
    await drag(page, { x: ruler.x + 20, y: ruler.y + 14 }, { x: ruler.x + ruler.width - 20, y: ruler.y + 14 }, { steps: 40 });
    assert.ok(Date.now() - t0 < 8000, `zoom and scrub took ${Date.now() - t0} ms`);
    // a drag does not rebuild the clips: the same element is there before and after
    const marked = await page.evaluate(() => { const el = document.querySelector('.vt-clip[data-id="v1-c1"]'); el.dataset.mark = 'same'; return !!el; });
    assert.ok(marked);
    const b = await page.locator('.vt-clip[data-id="v1-c1"]').boundingBox();
    await drag(page, center(b), { x: b.x + b.width / 2 + 12, y: b.y + b.height / 2 });
    await settle();
    assert.equal(await page.locator('.vt-clip[data-id="v1-c1"]').getAttribute('data-mark'), 'same');
    // vertical scroll: the headers stay put on the left while the lanes scroll sideways
    await page.keyboard.press('+'); await page.keyboard.press('+'); await page.keyboard.press('+');
    await page.evaluate(() => { document.querySelector('.vt-scroll').scrollLeft = 400; });
    const head = await page.locator('.vt-lane[data-lane="track:v1"] .vt-head').boundingBox();
    const scroll = await page.locator('.vt-scroll').boundingBox();
    near(head.x, scroll.x, 1, 'the header stays at the left edge');
  }, { setup: (projDir) => { writeFileSync(join(projDir, 'docs', 'big-reel.json'), JSON.stringify(many(), null, 2)); }, viewport: { width: 1440, height: 900 } });
});

// ------------------------------------------------------------------------------------------------------------ the rest of the app

test('pictures still open as before after a video, and the library lists videos as openable', { timeout: 120000 }, async () => {
  await videoEditor('reel-edit', async ({ page, port }) => {
    await page.evaluate(() => { location.hash = '#/p/little-gannet/spring-menu-carousel'; });
    await page.waitForSelector('.page-item');
    assert.equal(await page.locator('.page-item').count(), 5);
    assert.equal(await page.locator('.vx:visible').count(), 0, 'the video editor is gone');
    await page.waitForFunction(() => document.querySelector('.stage iframe:not(.back)')?.contentDocument?.querySelector('[data-layer]'));
    // and back to the video: it opens fresh
    await page.evaluate(() => { location.hash = '#/p/little-gannet/reel-edit'; });
    await page.waitForSelector('.vt-clip');
    assert.equal(await page.locator('.page-item:visible').count(), 0);
    // the library
    await page.evaluate(() => { location.hash = '#/projects'; });
    await page.waitForSelector('.card');
    assert.equal(await page.locator('.card.disabled').count(), 0, 'no card is greyed out any more');
    assert.equal(await page.locator('.card[href$="/reel-edit"]').count(), 1);
    void port;
  });
});

test('the Studio\'s "Open in editor" opens a video post in the timeline editor', { timeout: 180000 }, async () => {
  await studioPage(async (ctx) => {
    const { page, open, call } = ctx;
    const { posts } = await overview(call);
    const reel = firstWhere(posts, (p) => p.format === 'reel' && p.docId && p.status === 'built');
    assert.ok(reel, 'the workspace has a built reel with a document');
    await open(`#/s/wall?today=${TODAY}&post=${encodeURIComponent(reel.uid)}`);
    // a reel's editor button sits with the decisions under the video, not in the dock at the bottom
    const edit = page.locator('.detail.open .acts.decide a[data-act="edit-video"]');
    await edit.waitFor();
    assert.match(await edit.innerText(), /Edit video/);
    assert.equal(await page.locator('.detail.open .d-dock a[data-act="edit-video"]').count(), 0);
    assert.match(await edit.getAttribute('href'), new RegExp(`#/p/${reel.project}/${reel.docId}$`));
    await edit.click();
    await page.waitForSelector('.vx .vt-lane');
    assert.equal(await page.locator('.topbar input.title').inputValue(), reel.title);
    assert.equal(await page.locator('.page-item:visible').count(), 0);
    // the way back: a labelled button that returns to the same reel's sheet
    assert.match(await page.locator('.topbar a[data-act="back-to-reels"]').innerText(), /Back to reels/);
    await page.click('.topbar a[data-act="back-to-reels"]');
    await page.waitForSelector('.studio .detail.open');
    assert.match(await page.evaluate(() => decodeURIComponent(location.hash)), new RegExp(`post=${reel.uid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    // these invented reels have no footage, so the picture cannot be drawn: that one request failing is expected
    ctx.errors = ctx.errors.filter((e) => !/Failed to load resource/.test(e));
  }, { page: true });
});

// ------------------------------------------------------------------------------------------------------------ the one route this adds

test('GET video/outputs lists the finished video files of a post, newest first, and nothing else', { timeout: 60000 }, async () => {
  const work = mkdtempSync(join(tmpdir(), 'nordle-vedit-outputs-'));
  cpSync(fx.projectsDir, join(work, 'projects'), { recursive: true });
  const out = join(work, 'projects', P, 'out', 'reel-edit');
  mkdirSync(out, { recursive: true });
  for (const [name, age] of [['reel-edit.preview.mp4', 3], ['reel-edit.mp4', 2], ['reel-edit.2.0-5.0s.gif', 1], ['reel-edit-cover.jpg', 1], ['sheet.png', 1], ['elsewhere.mp4', 1], ['reel-edit.txt', 1]]) {
    writeFileSync(join(out, name), 'x'.repeat(10));
    const t = new Date(Date.now() - age * 60000);
    utimesSync(join(out, name), t, t);
  }
  const app = createNordleServer({ roots: [join(work, 'projects')], token: TOKEN, agentToken: AGENT });
  const port = await app.listen(0);
  const get = async (path, token = TOKEN) => { const res = await fetch(`http://127.0.0.1:${port}/api/projects/${P}/video/${path}`, { headers: { 'x-nordle-token': token } }); return { status: res.status, json: await res.json() }; };
  try {
    const r = await get('outputs?doc=reel-edit');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.files.map((f) => [f.name, f.kind, f.ext, f.path]), [
      ['reel-edit.2.0-5.0s.gif', 'export', 'gif', 'out/reel-edit/reel-edit.2.0-5.0s.gif'],
      ['reel-edit.mp4', 'export', 'mp4', 'out/reel-edit/reel-edit.mp4'],
      ['reel-edit.preview.mp4', 'preview', 'mp4', 'out/reel-edit/reel-edit.preview.mp4'],
    ]);
    assert.equal(r.json.files[0].bytes, 10);
    assert.deepEqual((await get('outputs?doc=reel-fillers')).json.files, [], 'a post with nothing made says so');
    for (const bad of ['outputs?doc=nope', 'outputs?doc=..%2F..%2Fx', 'outputs?doc=', 'outputs']) assert.equal((await get(bad)).status, 404, bad);
    assert.equal((await get('outputs?doc=reel-edit', AGENT)).status, 200, 'Claude can read it too');
    const noToken = await fetch(`http://127.0.0.1:${port}/api/projects/${P}/video/outputs?doc=reel-edit`);
    assert.equal(noToken.status, 401);
    const post = await fetch(`http://127.0.0.1:${port}/api/projects/${P}/video/outputs?doc=reel-edit`, { method: 'POST', headers: { 'x-nordle-token': TOKEN, 'content-type': 'application/json' }, body: '{}' });
    assert.notEqual(post.status, 200, 'read only');
  } finally {
    await app.close();
    rmSync(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  }
});

test('Ctrl+click adds clips to the selection: the Inspector counts them, Split works on those under the playhead, Delete takes them all out in one undo step', { timeout: 120000 }, async () => {
  await videoEditor('reel-edit', async ({ page, doc, settle, clip }) => {
    const original = await doc();
    await clip('c1').click();
    await clip('c2').click({ modifiers: ['Control'] });
    await clip('cutaway').click({ modifiers: ['Control'] });
    for (const id of ['c1', 'c2', 'cutaway']) assert.equal(await clip(id).getAttribute('aria-pressed'), 'true');
    assert.equal(await clip('pic').getAttribute('aria-pressed'), 'false');
    assert.match(await page.locator('.vx-panel[data-panel="inspector"]').innerText(), /3 clips selected/i);
    // Ctrl+click on one that is selected takes it out again
    await clip('cutaway').click({ modifiers: ['Control'] });
    assert.equal(await clip('cutaway').getAttribute('aria-pressed'), 'false');
    // split at 4 s: only c2 is under the playhead (c1 ends at 2.9)
    await gotoSeconds(page, 4);
    await page.keyboard.press('s'); await settle();
    assert.deepEqual((await doc()).timeline.tracks[0].clips.map((c) => c.id), ['c1', 'c2', 'c2-b', 'pic']);
    // delete both selected clips at once
    await page.keyboard.press('Delete'); await settle();
    assert.deepEqual((await doc()).timeline.tracks[0].clips.map((c) => c.id), ['c2-b', 'pic']);
    await page.keyboard.press('Control+z'); await settle();
    assert.deepEqual((await doc()).timeline.tracks[0].clips.map((c) => c.id), ['c1', 'c2', 'c2-b', 'pic'], 'one undo brought both back');
    await page.keyboard.press('Control+z'); await settle();
    assert.deepEqual(await doc(), original);
  });
});

test('text on the picture: a title can be clicked to select it, double-clicked to change its words in place; captions point to the transcript', { timeout: 120000 }, async () => {
  await videoEditor('reel-edit', async ({ page, doc, settle }) => {
    await gotoSeconds(page, 2);
    await page.waitForSelector('.vm-tbox[data-layer="title"]', { timeout: 30000 });
    assert.equal(await page.locator('.vm-tbox[data-layer="title"]').getAttribute('data-editable'), '1');
    await page.locator('.vm-tbox[data-layer="title"]').click();
    assert.match(await page.locator('.vt-layer[data-id="title"]').getAttribute('class'), /selected/, 'the same title is selected on the timeline');
    assert.ok(await page.locator('[data-field="layer-text"]').count(), 'and its settings open on the right');
    await page.locator('.vm-tbox[data-layer="title"]').dblclick();
    await page.waitForSelector('[data-field="frame-text"]');
    assert.equal(await page.inputValue('[data-field="frame-text"]'), (await doc()).layers[0].text, 'the box starts with the words that are there');
    await page.fill('[data-field="frame-text"]', 'Changed on the picture');
    await page.keyboard.press('Enter');
    await settle();
    assert.equal((await doc()).layers[0].text, 'Changed on the picture');
    assert.equal(await page.locator('[data-field="frame-text"]').count(), 0, 'the box closes');
    // Escape leaves it as it was
    await page.waitForSelector('.vm-tbox[data-layer="title"]', { timeout: 30000 });
    await page.locator('.vm-tbox[data-layer="title"]').dblclick();
    await page.fill('[data-field="frame-text"]', 'Not kept');
    await page.keyboard.press('Escape');
    await settle();
    assert.equal((await doc()).layers[0].text, 'Changed on the picture');
  });
});
