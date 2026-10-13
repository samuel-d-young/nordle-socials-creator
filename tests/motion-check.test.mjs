// "Go all out" is enforced, not hoped for: every video must pass the motion check, and every build prompt carries the standard. Pure: nothing is rendered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ROOT, readJson } from '../tools/validate.mjs';
import { buildReelDoc } from '../src/shared/reel-spec.mjs';
import { MOTION_PASS, motionReport } from '../src/verify/motion.mjs';
import { requiredChecks } from '../src/verify/store.mjs';
import { CHECKS } from '../src/verify/run.mjs';
import { newCalendar, saveCalendar } from '../src/calendar/model.mjs';
import * as S from '../src/calendar/service.mjs';
import { buildPrompt, standardLines } from '../src/calendar/prompts.mjs';

const platforms = readJson(join(ROOT, 'data', 'platforms.json'));
const brand = readJson(join(ROOT, 'samples', 'little-gannet', 'brand.json'));
const rules = (r) => r.findings.filter((f) => f.level !== 'info').map((f) => `${f.rule}${f.level === 'error' ? '!' : ''}`);

/** A bare video document: some text layers over a still background, timed by hand. */
const bare = (layers, { duration = 8, scenes } = {}) => ({
  schema: 'nordle.doc/0.1', id: 'm', title: 'm', kind: 'video', brand: brand.id, sizes: ['ig-reel-9x16'], sources: [],
  timeline: { fps: 30, duration, tracks: [{ id: 'v1', type: 'video', clips: [] }], scenes: scenes ?? [{ id: 's1', title: 'card', start: 0, end: duration }], background: '#111111' },
  layers,
});
const text = (id, start, end, animate) => ({ id, type: 'text', text: 'Hello', layout: { x: 50, y: 50 }, time: { start, end }, ...(animate ? { animate } : {}) });

test('every video must pass the motion check; it is listed with the other checks', () => {
  assert.ok(CHECKS.includes('motion'));
  assert.deepEqual(requiredChecks({ kind: 'video' }).find((c) => c.check === 'motion'), { check: 'motion', by: ['auto'] });
  assert.equal(requiredChecks({ kind: 'carousel' }).some((c) => c.check === 'motion'), false, 'pictures have the design check instead');
  assert.equal(MOTION_PASS, 85);
});

test('the motion kit and the reel builder\'s own defaults pass; text that just appears, dead air and sameness fail', () => {
  const kit = buildReelDoc({ id: 'k', title: 'k', scenes: [
    { type: 'motion', recipe: 'kinetic', dur: 3, content: { headline: 'Small batches.\nBig flavour.', accent: 'Big flavour' } },
    { type: 'motion', recipe: 'number', dur: 3, content: { number: '98', suffix: '%', label: 'Single origin' } },
    { type: 'motion', recipe: 'logo', dur: 3, content: { line: 'Come and say hello' } },
  ] }, { brand, platforms }).doc;
  assert.deepEqual([motionReport(kit).score, rules(motionReport(kit))], [100, []]);
  const cards = buildReelDoc({ id: 'c', title: 'c', scenes: [
    { type: 'card', pattern: 'statement', dur: 2.4, content: { headline: 'Every cup is made to order' } },
    { type: 'card', pattern: 'stat', dur: 2.4, content: { number: '3', headline: 'steps' } },
    { type: 'end', dur: 3, content: { headline: 'Come and see us' } },
  ] }, { brand, platforms }).doc;
  assert.ok(motionReport(cards).score >= MOTION_PASS, `plain cards built with the defaults pass: ${motionReport(cards).score} ${rules(motionReport(cards))}`);

  const flat = motionReport(bare([text('a', 0, 8)]));
  assert.ok(rules(flat).includes('motion-text-static!'));
  assert.ok(rules(flat).includes('motion-dead-air!'), 'eight seconds of nothing moving');
  assert.ok(flat.score < MOTION_PASS);

  const same = motionReport(bare([0, 1.5, 3, 4.5, 6].map((s, i) => text(`t${i}`, s, s + 1.5, [{ preset: 'fade-in', duration: 0.5 }, { preset: 'float', params: {} }]))));
  assert.ok(rules(same).includes('motion-same-entrance'));
});

test('a closing card may hold still to be read, and the cover frame at the very end is not counted', () => {
  const layers = [text('hook', 0, 4.5, [{ preset: 'blur-in' }, { preset: 'float' }]), text('end', 4.5, 8, [{ preset: 'scale-in' }])];
  const r = motionReport(bare(layers, { duration: 8.1, scenes: [{ id: 's1', title: 'card', start: 0, end: 4.5 }, { id: 's2', title: 'End', start: 4.5, end: 8 }, { id: 's3', title: 'Cover', start: 8, end: 8.1 }] }));
  assert.equal(rules(r).some((x) => x.startsWith('motion-dead-air')), false, `the closing hold is allowed: ${rules(r)}`);
  assert.equal(rules(r).includes('motion-no-ending'), false);
  const noEnd = motionReport(bare([text('a', 0, 3, [{ preset: 'blur-in' }, { preset: 'float' }])], { duration: 8 }));
  assert.ok(rules(noEnd).includes('motion-no-ending'));
  assert.ok(rules(noEnd).some((x) => x.startsWith('motion-dead-air')), 'five seconds of nothing at the end is more than a closing hold');
});

test('the standard is in every build prompt: go all out for video (and the motion check must pass), a top designer for pictures', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'nordle-standard-')), 'p');
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'brand.json'), JSON.stringify({ schema: 'nordle.brand/0.1', id: 'p', name: 'Harbour Bakery', colors: { ink: '#111111', paper: '#ffffff' }, fonts: { display: { family: 'Inter', weights: [400], source: 'google' } }, voice: { tone: ['warm'] } }));
  writeFileSync(join(dir, 'facts.json'), '{}');
  saveCalendar(dir, newCalendar('p'));
  try {
    const [reel, carousel] = (await S.addItems(dir, [
      { date: '2026-11-09', format: 'reel', title: 'A reel', idea: 'x', hook: 'x' },
      { date: '2026-11-10', format: 'carousel', title: 'A carousel', idea: 'x', hook: 'x' },
    ], { role: 'human' })).added;
    const r = buildPrompt(dir, reel.id, { today: '2026-10-05' });
    assert.match(r, /## The standard: go all out/);
    assert.match(r, /first half second/);
    assert.match(r, /motion check[\s\S]*must pass \(85\)/);
    assert.match(r, /Good enough is not the bar/);
    const c = buildPrompt(dir, carousel.id, { today: '2026-10-05' });
    assert.match(c, /top designer[\s\S]*design check must pass \(88\)/);
    assert.equal(standardLines({ format: 'story' })[3].includes('top editor and motion designer'), true);
  } finally { rmSync(join(dir, '..'), { recursive: true, force: true }); }
});
