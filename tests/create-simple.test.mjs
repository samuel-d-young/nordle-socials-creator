// The Create page's Simple mode: say what you want, pick from a board of sketched ideas, and Claude makes them. Advanced keeps every control.
// Claude is never started: a fake runner records what it was asked and, for "Let Claude write them", writes ideas the way Claude would.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { addItems } from '../src/calendar/service.mjs';
import { loadCalendar } from '../src/calendar/model.mjs';
import { closeBrowser } from './helpers.mjs';
import { studioPage, TODAY } from './studio-helpers.mjs';

after(closeBrowser);

test('reading the sentence: kind, number and style come from the words; the chips win when chosen; ideas are drawn frame by frame', async () => {
  await studioPage(async ({ page, open }) => {
    await open(`#/s/create?today=${TODAY}`);
    const r = await page.evaluate(async () => {
      const m = await import('/app/studio-create-simple.js');
      return {
        a: m.readAsk('Three reels introducing the team'),
        b: m.readAsk('a carousel explaining how whitening works', { count: 8 }),
        c: m.readAsk('something for christmas', { kind: 'post', count: 3 }),
        reel: m.framesFor({ format: 'reel', title: 'T', hook: 'H', idea: 'One. Two. Three.' }, 'Brand').map((f) => [f.k, f.at]),
        carousel: m.framesFor({ format: 'carousel', title: 'T', hook: 'H', idea: 'One. Two.' }, 'Brand').map((f) => f.k),
        post: m.framesFor({ format: 'post', title: 'T', hook: 'H', idea: 'x' }, 'Brand').length,
      };
    });
    assert.deepEqual(r.a, { formats: ['reel'], styles: ['team'], count: 3 });
    assert.deepEqual(r.b, { formats: ['carousel'], styles: ['educate'], count: 1 });
    assert.deepEqual(r.c, { formats: ['post'], styles: ['seasonal'], count: 3 });
    assert.deepEqual(r.reel, [['Hook', '0s'], ['Shot', '2s'], ['Shot', '5s'], ['End card', '8s']]);
    assert.deepEqual(r.carousel, ['Cover', 'Slide', 'Slide', 'Slide', 'Last slide']);
    assert.equal(r.post, 1);
  });
});

const firstBrand = async (call) => (await call('/studio?today=' + TODAY)).body.projects[0].id;

test('Simple is the default: three steps, one question, Advanced one click away and remembered', async () => {
  await studioPage(async ({ page, open }) => {
    await page.evaluate(() => { try { localStorage.removeItem('nordle.create.mode'); } catch { /* fine */ } });
    await open(`#/s/create?today=${TODAY}`);
    await page.waitForSelector('[data-state="create-simple"]');
    assert.deepEqual(await page.$$eval('.sp-step', (s) => s.map((x) => x.textContent.replace(/^\d/, '').trim())), ['Say what you want', 'Pick from the board', 'Claude makes them']);
    assert.equal(await page.locator('.sp-step.now').innerText().then((t) => t.includes('Say what you want')), true);
    assert.equal(await page.locator('[data-act="create-suggest"]').count(), 0, 'none of the advanced controls');
    assert.equal(await page.locator('[data-state="reel-options"]').count(), 0);
    await page.locator('[data-mode="advanced"]').click();
    await page.waitForSelector('[data-act="create-suggest"]');
    assert.equal(await page.evaluate(() => localStorage.getItem('nordle.create.mode')), 'advanced');
    await page.reload();
    await page.waitForSelector('[data-act="create-suggest"]');
    await page.locator('[data-mode="simple"]').click();
    await page.waitForSelector('[data-state="create-simple"]');
    await page.locator('[data-act="to-advanced"]').click();
    await page.waitForSelector('[data-act="create-suggest"]');
  });
});

test('say it, see the board, swap one, pin a note, make them: they go on the calendar approved with the note, and Claude builds each one in turn', async () => {
  const built = [];
  const claudeRunner = { propose: async () => ({ ran: [] }), build: async (o) => { built.push(o.itemId); return { ran: [{ outcome: 'built' }] }; } };
  await studioPage(async ({ page, open, call, work }) => {
    await page.evaluate(() => { try { localStorage.removeItem('nordle.create.mode'); } catch { /* fine */ } });
    await open(`#/s/create?today=${TODAY}`);
    await page.waitForSelector('[data-field="simple-ask"]');
    await page.fill('[data-field="simple-ask"]', 'Three carousels explaining things people ask');
    await page.locator('[data-act="simple-ideas"]').click();
    await page.waitForSelector('[data-state="simple-board"] .sb-card');
    const cards = await page.locator('.sb-card').count();
    assert.ok(cards >= 1 && cards <= 3, `up to three ideas: ${cards}`);
    assert.deepEqual([...new Set(await page.$$eval('.sb-card .cr-fmt', (e) => e.map((x) => x.textContent)))], ['Carousel'], 'the words chose the kind');
    assert.ok(await page.locator('.sb-card').first().locator('.sb-frame').count() >= 3, 'each idea is drawn frame by frame');
    assert.match(await page.locator('.sp-step.now').innerText(), /Pick from the board/);
    // another take on the first idea, if Nordle has one
    const before = await page.locator('.sb-card .cr-title').first().innerText();
    await page.locator('.sb-card [data-act="simple-another"]').first().click();
    const afterTitle = await page.locator('.sb-card .cr-title').first().innerText();
    assert.ok(afterTitle !== before || await page.locator('.notice:has-text("No more ideas like this")').count() === 1, 'swapped, or said why not');
    // a note pinned on it
    await page.locator('.sb-card [data-act="simple-note"]').first().click();
    await page.fill('[data-field="simple-note"]', 'Use the reception photo');
    await page.locator('[data-act="simple-note-done"]').click();
    assert.match(await page.locator('.sb-note').first().innerText(), /Use the reception photo/);
    const firstTitle = await page.locator('.sb-card .cr-title').first().innerText();
    await page.locator('[data-act="simple-make"]').click();
    await page.waitForSelector('[data-state="simple-progress"] .sp-made');
    assert.match(await page.locator('.sp-step.now').innerText(), /Claude makes them/);
    assert.equal(await page.locator('.sp-made').count(), cards);
    const project = await firstBrand(call);
    const items = loadCalendar(join(work, 'projects', project)).items;
    const mine = items.find((i) => i.title === firstTitle);
    assert.equal(mine.status === 'approved' || mine.status === 'building' || mine.status === 'built', true, `approved for building: ${mine.status}`);
    assert.equal(mine.guidance, 'Use the reception photo', 'the note went with it');
    for (let i = 0; i < 40 && built.length < cards; i++) await page.waitForTimeout(150);
    assert.equal(built.length, cards, 'Claude was asked to build each one');
    assert.ok(built.includes(mine.id));
  }, { claudeRunner });
});

test('"Let Claude write them": Claude\'s ideas land on the board, and Make approves them', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const asked = [];
  const claudeRunner = {
    propose: async (o) => {
      asked.push(o.extra);
      await gate;
      await addItems(o.projectDir, [
        { date: '2026-11-12', format: 'reel', title: 'Claude idea one', idea: 'A short walk from the door to the chair.', hook: 'What happens first?', status: 'idea' },
        { date: '2026-11-19', format: 'reel', title: 'Claude idea two', idea: 'The three questions people ask most, answered on camera.', hook: 'You asked.', status: 'idea' },
      ], { role: 'human', force: true });
      return { ran: [{ outcome: 'proposed', added: ['a', 'b'] }] };
    },
    build: async () => ({ ran: [{ outcome: 'built' }] }),
  };
  await studioPage(async ({ page, open, call, work }) => {
    await page.evaluate(() => { try { localStorage.removeItem('nordle.create.mode'); } catch { /* fine */ } });
    await open(`#/s/create?today=${TODAY}`);
    await page.fill('[data-field="simple-ask"]', 'Two reels for nervous first-timers');
    await page.locator('[data-act="simple-claude"]').click();
    await page.waitForSelector('[data-state="simple-claude-working"]');
    assert.match(asked[0], /Two reels for nervous first-timers/);
    assert.match(asked[0], /Propose exactly 2 idea/);
    release();
    await page.waitForSelector('.sb-card .cr-title:has-text("Claude idea one")', { timeout: 20000 });
    assert.equal(await page.locator('.sb-card').count(), 2);
    assert.match(await page.locator('.sb-card .cr-style').first().innerText(), /written by claude/i);
    await page.locator('[data-act="simple-save"]').click();
    await page.waitForSelector('[data-state="simple-progress"]');
    const project = await firstBrand(call);
    const items = loadCalendar(join(work, 'projects', project)).items.filter((i) => /^Claude idea/.test(i.title));
    assert.deepEqual(items.map((i) => i.status).sort(), ['idea', 'idea'], 'Save for later leaves them as ideas');
  }, { claudeRunner });
});
