// How a reel is made, chosen per post: Auto, cut from footage, motion graphics only, or motion graphics with a voice-over; what it uses; how long; and extra
// information to steer any post. Checked here without starting Claude: the choices, the calendar rules, what Claude is told, and the Create page.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newCalendar, loadCalendar, saveCalendar } from '../src/calendar/model.mjs';
import * as S from '../src/calendar/service.mjs';
import { buildPrompt, proposePrompt } from '../src/calendar/prompts.mjs';
import { cleanReel, defaultUses, reelPromptLines, reelStyleOf, reelSummary } from '../src/shared/reel-options.mjs';
import { closeBrowser } from './helpers.mjs';
import { studioPage, TODAY } from './studio-helpers.mjs';

const base = mkdtempSync(join(tmpdir(), 'nordle-reelopt-'));
before(() => { process.env.NORDLE_TODAY = '2026-10-05'; });
after(async () => { await closeBrowser(); rmSync(base, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }); delete process.env.NORDLE_TODAY; });

const BRAND = { schema: 'nordle.brand/0.1', id: 'x', name: 'Harbour Bakery', colors: { ink: '#111111', paper: '#ffffff' }, fonts: { display: { family: 'Inter', weights: [400], source: 'google' } }, voice: { tone: ['warm'] } };
let n = 0;
function project() {
  const id = `ro-${++n}`;
  const dir = join(base, id);
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'brand.json'), JSON.stringify({ ...BRAND, id }));
  writeFileSync(join(dir, 'facts.json'), JSON.stringify({ staff: [{ name: 'Ana Costa', title: 'Head baker', source: 'website' }] }));
  saveCalendar(dir, newCalendar(id));
  return dir;
}

test('cleanReel: styles, what it uses, length; a style that cannot use something drops it; mistakes are named', () => {
  assert.deepEqual(cleanReel({ style: 'motion', uses: ['footage', 'music', 'sfx', 'captions'], seconds: 30 }).value, { style: 'motion', uses: ['music', 'sfx'], seconds: 30 });
  assert.deepEqual(cleanReel({ style: 'voiceover', uses: ['music', 'photos'] }).value, { style: 'voiceover', uses: ['voiceover', 'music'] }, 'a voice-over reel always uses its voice-over, and has no photos');
  assert.equal(cleanReel({ style: 'auto' }).value.style, 'auto');
  assert.equal(cleanReel(null).value, null);
  assert.match(cleanReel({ style: 'nope' }).errors[0].message, /one of auto, footage, motion, voiceover/);
  assert.match(cleanReel({ uses: ['hologram'] }).errors[0].message, /unknown: hologram/);
  assert.match(cleanReel({ seconds: 300 }).errors[0].message, /5 to 90/);
  assert.match(cleanReel({ colour: 'red' }).errors[0].message, /unknown reel option/);
  assert.deepEqual(defaultUses('motion'), ['music', 'sfx', 'logo', 'endcard']);
  assert.equal(reelStyleOf({ format: 'reel' }), 'auto', 'a reel nobody chose for is Auto');
  assert.equal(reelStyleOf({ format: 'post' }), null);
  assert.equal(reelSummary({ style: 'motion', seconds: 30, uses: ['music'] }), 'Motion graphics only, about 30 s, uses music');
});

test('the calendar keeps reel choices and guidance, only for reels; Claude may set them and the owner may clear them', async () => {
  const dir = project();
  const ok = await S.addItems(dir, [
    { date: '2026-11-04', format: 'reel', title: 'Three steps', idea: 'Three steps to a first visit.', hook: 'Three steps.', reel: { style: 'motion', seconds: 20 }, guidance: 'Keep it playful. No staff on screen.' },
    { date: '2026-11-05', format: 'post', title: 'Hello', idea: 'x', hook: 'x', guidance: 'Mention the new opening hours.' },
  ], { role: 'human' });
  assert.equal(ok.added.length, 2);
  assert.deepEqual(ok.added[0].reel, { style: 'motion', seconds: 20 });
  assert.equal(ok.added[1].guidance, 'Mention the new opening hours.');
  const bad = await S.addItems(dir, [{ date: '2026-11-06', format: 'post', title: 'Not a reel', idea: 'x', hook: 'x', reel: { style: 'motion' } }], { role: 'human' });
  assert.match(bad.rejected[0].errors[0].message, /only apply to a reel/);
  const wrong = await S.addItems(dir, [{ date: '2026-11-07', format: 'reel', title: 'Bad style', idea: 'x', hook: 'x', reel: { style: 'hologram' } }], { role: 'human' });
  assert.match(wrong.rejected[0].errors[0].message, /reel style must be/);
  const id = ok.added[0].id;
  await S.updateItem(dir, id, { reel: { style: 'voiceover', seconds: 30 } }, { role: 'agent', today: '2026-10-05' });
  assert.equal(loadCalendar(dir).items.find((i) => i.id === id).reel.style, 'voiceover');
  await assert.rejects(S.updateItem(dir, ok.added[1].id, { reel: { style: 'motion' } }, { role: 'human' }), /only apply to a reel/);
  await S.updateItem(dir, id, { reel: null, guidance: null }, { role: 'human' });
  const gone = loadCalendar(dir).items.find((i) => i.id === id);
  assert.equal(gone.reel, undefined);
  assert.equal(gone.guidance, undefined);
});

test('what Claude is told: Auto decides from what exists, motion forbids footage, voice-over needs a real recording, guidance is in the brief, and the reel command is the build', async () => {
  const dir = project();
  const mk = async (reel, extra = {}) => (await S.addItems(dir, [{ date: '2026-11-09', format: 'reel', title: `R ${Math.random()}`, idea: 'An idea.', hook: 'Hook.', ...(reel ? { reel } : {}), ...extra }], { role: 'human' })).added[0];
  const auto = await mk({ style: 'auto' });
  assert.match(buildPrompt(dir, auto.id, { today: '2026-10-05' }), /Reel style: AUTO[\s\S]*Never invent footage or a voice/);
  const motion = await mk({ style: 'motion', uses: ['music', 'endcard'], seconds: 20 }, { guidance: 'Keep it playful.' });
  const t = buildPrompt(dir, motion.id, { today: '2026-10-05' });
  assert.match(t, /MOTION GRAPHICS ONLY[\s\S]*no footage, no photos, no stock/);
  assert.match(t, /This reel uses: music, a closing card\./);
  assert.match(t, /Length: about 20 seconds/);
  assert.match(t, /Extra guidance from the owner \(follow it\): Keep it playful\./);
  const voice = await mk({ style: 'voiceover' });
  const v = buildPrompt(dir, voice.id, { today: '2026-10-05' });
  assert.match(v, /VOICE-OVER[\s\S]*do NOT invent a voice/);
  assert.match(v, /`say`/);
  assert.deepEqual(reelPromptLines({ format: 'post', reel: { style: 'motion' } }), [], 'only reels');
  assert.deepEqual(reelPromptLines({ format: 'reel' }), [], 'a reel with no choices adds nothing, as before');
  assert.match(proposePrompt(dir, { months: ['2026-11'], today: '2026-10-05' }), /`reel` \(reels only, optional\)[\s\S]*`guidance` \(optional\)/);
});

test('the Create page: reel choices and extra info are saved on the reels it adds', async () => {
  await studioPage(async ({ page, open, call }) => {
    await open(`#/s/create?today=${TODAY}`);
    await page.waitForSelector('[data-state="reel-options"]');
    await page.locator('[data-reel-style="motion"]').click();
    await page.locator('[data-reel-seconds="20"]').click();
    assert.equal(await page.locator('[data-reel-use="footage"]').count(), 0, 'motion graphics have no footage to tick');
    assert.equal(await page.locator('[data-reel-use="music"][aria-pressed="true"]').count(), 1);
    await page.fill('[data-field="create-guide"]', 'Keep it playful. No staff on screen.');
    await page.locator('[data-format="reel"]').click();
    await page.locator('[data-act="create-suggest"]').click();
    await page.waitForSelector('[data-state="options"] .cr-opt');
    await page.locator('[data-act="create-add-ideas"]').click();
    await page.waitForSelector('.cr-added');
    const list = (await call('/projects')).body;
    let reels = [];
    for (const pr of list.projects ?? list) {
      const cal = (await call(`/projects/${pr.id}/calendar?from=2026-10-01&to=2026-12-31`)).body.calendar;
      reels = reels.concat((cal.items ?? []).filter((i) => i.guidance === 'Keep it playful. No staff on screen.'));
    }
    assert.ok(reels.length >= 1, 'the added posts carry the extra info');
    assert.ok(reels.every((i) => i.format === 'reel' && i.reel?.style === 'motion' && i.reel.seconds === 20), 'and the reel choices');
  });
});

test('shape: vertical, portrait, square or landscape, each with its own size; the build prompt says which and not to crop a vertical layout', async () => {
  const { REEL_SHAPES, reelSizeOf } = await import('../src/shared/reel-options.mjs');
  assert.deepEqual(REEL_SHAPES.map((s) => s.id), ['vertical', 'portrait', 'square', 'landscape']);
  assert.equal(reelSizeOf({ format: 'reel' }), 'ig-reel-9x16');
  assert.equal(reelSizeOf({ format: 'reel', reel: { shape: 'landscape' } }), 'yt-landscape-16x9');
  assert.equal(reelSizeOf({ format: 'story', reel: { shape: 'landscape' } }), 'ig-story-9x16', 'a Story is always vertical');
  assert.equal(cleanReel({ shape: 'landscape' }).value.shape, 'landscape');
  assert.match(cleanReel({ shape: 'cinema' }).errors[0].message, /shape must be one of vertical, portrait, square, landscape/);
  assert.equal(reelSummary({ shape: 'landscape', seconds: 30 }), 'Landscape 16:9, about 30 s');
  assert.equal(reelSummary({ shape: 'vertical' }), null, 'vertical is the usual shape and is not mentioned');
  const dir = project();
  const item = (await S.addItems(dir, [{ date: '2026-11-10', format: 'reel', title: 'Wide one', idea: 'x', hook: 'x', reel: { style: 'motion', shape: 'landscape' } }], { role: 'human' })).added[0];
  const t = buildPrompt(dir, item.id, { today: '2026-10-05' });
  assert.match(t, /size yt-landscape-16x9/);
  assert.match(t, /Shape: Landscape 16:9[\s\S]*"sizes": \["yt-landscape-16x9"\][\s\S]*Do not reuse a vertical layout and crop it/);
  assert.match(t, /Go all out[\s\S]*end on the logo scene/);
});
