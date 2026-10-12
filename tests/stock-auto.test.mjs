// Stock libraries are used automatically: the build prompt tells Claude which of the owner's libraries are ready for this brand, own folders first, and to look at
// every file it brings in. Settings are handed in; the real stock settings are never read.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newCalendar, saveCalendar } from '../src/calendar/model.mjs';
import * as S from '../src/calendar/service.mjs';
import { buildPrompt, stockLines } from '../src/calendar/prompts.mjs';
import { stockBrief } from '../src/stock/index.mjs';

const base = mkdtempSync(join(tmpdir(), 'nordle-stockauto-'));
before(() => { process.env.NORDLE_TODAY = '2026-10-05'; });
after(() => { rmSync(base, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }); delete process.env.NORDLE_TODAY; });

const SETTINGS = { libraries: {
  'my-footage': { type: 'folder', name: 'My footage', path: 'D:/Footage', kinds: ['video', 'photo'] },
  'empty-folder': { type: 'folder', name: 'No path yet', kinds: ['video'] },
  pexels: { preset: 'pexels', key: 'KEY-NOT-SHOWN-ANYWHERE' },
  pixabay: { preset: 'pixabay' },
  'other-brand': { type: 'folder', name: 'Other brand only', path: 'D:/Other', kinds: ['photo'], brands: ['someone-else'] },
} };

test('stockBrief: ready libraries for this brand only, own folders apart from online ones, never a key', () => {
  const b = stockBrief('harbour', SETTINGS);
  assert.deepEqual(b.own.map((l) => l.id), ['my-footage']);
  assert.equal(b.own[0].path, 'D:/Footage');
  assert.deepEqual(b.online.map((l) => l.id), ['pexels'], 'pixabay has no key saved, so it is not ready');
  assert.ok(!JSON.stringify(b).includes('KEY-NOT-SHOWN-ANYWHERE'));
  assert.equal(stockBrief('someone-else', SETTINGS).own.some((l) => l.id === 'other-brand'), true, 'a library limited to a brand is for that brand');
  assert.equal(stockBrief('harbour', { libraries: {} }), null);
});

test('the build prompt sends Claude to the libraries itself, own folders first; a motion-graphics reel and a project with none get nothing', () => {
  const dir = join(base, 'harbour');
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'brand.json'), JSON.stringify({ schema: 'nordle.brand/0.1', id: 'harbour', name: 'Harbour Bakery', colors: { ink: '#111111', paper: '#ffffff' }, fonts: { display: { family: 'Inter', weights: [400], source: 'google' } }, voice: { tone: ['warm'] } }));
  writeFileSync(join(dir, 'facts.json'), JSON.stringify({ staff: [] }));
  saveCalendar(dir, newCalendar('harbour'));
  const mk = async (format, reel) => (await S.addItems(dir, [{ date: '2026-11-09', format, title: `T ${Math.random()}`, idea: 'An idea.', hook: 'Hook.', ...(reel ? { reel } : {}) }], { role: 'human' })).added[0];
  return Promise.all([mk('reel'), mk('reel', { style: 'motion' }), mk('carousel')]).then(([reel, motion, carousel]) => {
    const stock = stockBrief('harbour', SETTINGS);
    const t = buildPrompt(dir, reel.id, { today: '2026-10-05', stock });
    assert.match(t, /The owner's media libraries \(use them yourself\)/);
    assert.match(t, /do not ask which files to use/);
    assert.match(t, /OWN FOLDER, use first: "My footage"/);
    assert.match(t, /Online, only for a shot the owner's own material cannot cover: "Pexels"/);
    assert.match(t, /never use one you have not looked at/);
    assert.ok(t.indexOf('OWN FOLDER') < t.indexOf('Online, only'), 'own folders come first');
    assert.match(buildPrompt(dir, carousel.id, { today: '2026-10-05', stock }), /OWN FOLDER, use first/, 'carousels too');
    assert.doesNotMatch(buildPrompt(dir, motion.id, { today: '2026-10-05', stock }), /media libraries/, 'a motion-graphics reel uses no media');
    assert.doesNotMatch(buildPrompt(dir, reel.id, { today: '2026-10-05' }), /media libraries/, 'nothing set up, nothing said');
    assert.ok(t.length < 14000, `still compact: ${t.length}`);
    assert.deepEqual(stockLines(null, reel), []);
  });
});
