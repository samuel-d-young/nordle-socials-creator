// The content calendar: occasions, quotas, slot spreading, idea checks, due logic, prompts, the service rules, the headless
// runner (always with a fake Claude: nothing here can start the real one) and the command line.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, validateFile } from '../tools/validate.mjs';
import { validateCalendar, loadCalendar, saveCalendar, dueItems, newCalendar } from '../src/calendar/model.mjs';
import * as D from '../src/calendar/dates.mjs';
import { loadOccasions, validateOccasions, occasionsBetween, findOccasion, nearestInstance } from '../src/calendar/occasions.mjs';
import { DEFAULT_PER_MONTH, ideaLint, monthReport, needFor, monthCounts, quotaOf, spreadSlots, bannedPhrasesOf, isRegulated, similarity } from '../src/calendar/plan.mjs';
import * as S from '../src/calendar/service.mjs';
import { buildPrompt, proposePrompt, pluginToolNames, contentRules } from '../src/calendar/prompts.mjs';
import { spawn as nodeSpawn } from 'node:child_process';
import { runDue, runPropose, runClaude, defaultExec, claudeArgs, mcpConfig } from '../src/calendar/run.mjs';
import { acquireRunLock, readRunLock, runLockPath } from '../src/calendar/lock.mjs';
import cli from '../src/cli/calendar.mjs';

let work, base;
before(() => {
  work = mkdtempSync(join(tmpdir(), 'nordle-cal-'));
  base = join(work, 'projects');
  // whatever else happens, a bug in these tests must not be able to start the real Claude
  process.env.NORDLE_CLAUDE_BIN = join(work, 'there-is-no-claude-here');
  process.env.NORDLE_PROJECTS = base;
  process.env.NORDLE_TODAY = '2026-10-05';
  delete process.env.NORDLE_AGENT_RUN;
});
after(() => { rmSync(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }); delete process.env.NORDLE_TODAY; delete process.env.NORDLE_PROJECTS; delete process.env.NORDLE_CLAUDE_BIN; });

const BRAND = {
  schema: 'nordle.brand/0.1', id: 'x', name: 'Sample Dental Practice', colors: { ink: '#111111', paper: '#ffffff' },
  fonts: { display: { family: 'Inter', weights: [400], source: 'google' } },
  voice: { audience: 'Local families who put off the dentist', tone: ['warm', 'plain'], do: ['Name one real thing'], dont: ['Never say "amazing smile"', 'Be pushy'], bannedPhrases: ['world-class'] },
};
const COFFEE = JSON.parse(readFileSync(join(ROOT, 'samples', 'little-gannet', 'brand.json'), 'utf8'));
const PILLARS = [{ id: 'educate', name: 'Educate', share: 0.4 }, { id: 'people', name: 'People', share: 0.3 }, { id: 'season', name: 'Seasonal', share: 0.3 }];

let n = 0;
/** A scratch project: brand.json (+ calendar.json if given). */
function project(calendar, { brand = BRAND, facts } = {}) {
  const id = `proj-${++n}`;
  const dir = join(base, id);
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'brand.json'), JSON.stringify({ ...brand, id }));
  if (facts) writeFileSync(join(dir, 'facts.json'), JSON.stringify(facts));
  if (calendar) saveCalendar(dir, { ...newCalendar(id), ...calendar });
  return { dir, id };
}
const item = (over) => ({ id: `i${++n}`, date: '2026-11-10', format: 'reel', title: `Item ${n}`, status: 'idea', ...over });
const writeDoc = (dir, id) => writeFileSync(join(dir, 'docs', `${id}.json`), JSON.stringify({ schema: 'nordle.doc/0.1', id }));

// ---- dates -------------------------------------------------------------------------------------------------------------

test('dates: real-date checks, weekday rules, Easter and the timezone-aware today', () => {
  assert.ok(D.isDate('2026-11-03') && !D.isDate('2026-02-31') && !D.isDate('2026-13-01') && !D.isDate('26-11-03'));
  assert.equal(D.nthWeekday(2026, 11, 2, 1), '2026-11-03');     // first Tuesday of November 2026
  assert.equal(D.nthWeekday(2027, 11, 2, 1), '2027-11-02');
  assert.equal(D.nthWeekday(2027, 5, 0, 2), '2027-05-09');      // second Sunday of May 2027
  assert.equal(D.nthWeekday(2026, 11, 1, -1), '2026-11-30');    // last Monday
  assert.equal(D.easterSunday(2026), '2026-04-05');
  assert.equal(D.easterSunday(2027), '2027-03-28');
  assert.equal(D.easterSunday(2025), '2025-04-20');
  assert.equal(D.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(D.addMonths('2026-11', 3), '2027-02');
  assert.deepEqual(D.monthsBetween('2026-11-15', '2027-01-02'), ['2026-11', '2026-12', '2027-01']);
  assert.equal(D.weekdayName('2026-10-05'), 'Monday');
  assert.equal(D.todayIn('Australia/Melbourne'), '2026-10-05', 'NORDLE_TODAY overrides the clock');
});

// ---- occasions ---------------------------------------------------------------------------------------------------------

test('occasions: the library is well formed and its rules give the right dates', () => {
  assert.deepEqual(validateOccasions(loadOccasions()), []);
  const by = (list, id) => list.find((o) => o.occasion === id);
  const all = occasionsBetween('2026-10-01', '2027-12-31');
  assert.equal(by(all, 'melbourne-cup-day').date, '2026-11-03');
  assert.equal(all.filter((o) => o.occasion === 'melbourne-cup-day').at(-1).date, '2027-11-02');
  const bf = all.filter((o) => o.occasion === 'black-friday').map((o) => o.date);
  assert.deepEqual(bf, ['2026-11-27', '2027-11-26']);
  assert.deepEqual(all.filter((o) => o.occasion === 'cyber-monday').map((o) => o.date), ['2026-11-30', '2027-11-29']);
  const mov = all.find((o) => o.occasion === 'movember');
  assert.deepEqual([mov.date, mov.end], ['2026-11-01', '2026-11-30']);
  assert.deepEqual(['good-friday', 'easter-saturday', 'easter-sunday', 'easter-monday'].map((id) => by(all, id).date), ['2027-03-26', '2027-03-27', '2027-03-28', '2027-03-29']);
  assert.equal(by(all, 'mothers-day').date, '2027-05-09');
  assert.equal(by(all, 'fathers-day').date, '2027-09-05');
  assert.equal(by(all, 'halloween').date, '2026-10-31');
  const dhw = by(all, 'dental-health-week');
  assert.deepEqual([dhw.date, dhw.end, dhw.verify], ['2027-08-02', '2027-08-08', true]);
  assert.equal(by(all, 'eofy').date, '2027-06-30');
  assert.equal(by(all, 'world-oral-health-day').date, '2027-03-20');
  assert.deepEqual(all.filter((o) => o.occasion === 'world-smile-day').map((o) => o.date), ['2026-10-02', '2027-10-01']);
});

test('occasions: honest about what it is unsure of, and filtered by state and tag', () => {
  const lib = loadOccasions();
  for (const o of lib.occasions) {
    if (o.kind === 'school') assert.equal(o.verify, true, `${o.id}: school dates are not checked against the departments`);
    if (o.confidence === 'low') assert.equal(o.verify, true, `${o.id}: a low-confidence date must say verify`);
  }
  const wa = occasionsBetween('2026-11-01', '2026-11-30', { regions: ['WA'] }).map((o) => o.occasion);
  assert.ok(!wa.includes('melbourne-cup-day'), 'a Victorian holiday is not a Western Australian one');
  assert.ok(wa.includes('movember') && wa.includes('black-friday'), 'national dates stay');
  const vic = occasionsBetween('2026-11-01', '2026-11-30', { regions: ['VIC'] }).map((o) => o.occasion);
  assert.ok(vic.includes('melbourne-cup-day'));
  const dental = occasionsBetween('2026-10-01', '2027-12-31', { tags: ['dental'], minRelevance: 'high' });
  assert.ok(dental.length >= 4 && dental.every((o) => o.relevance === 'high' && o.tags.includes('dental')));
  const hf = occasionsBetween('2026-12-01', '2026-12-31').find((o) => o.occasion === 'health-fund-reset');
  assert.equal(hf.verify, true);
  assert.match(hf.caution, /pressure/i);
  // school holidays that straddle the year are found from either side
  assert.ok(occasionsBetween('2027-01-10', '2027-01-12', { regions: ['VIC'] }).some((o) => /summer school holidays/.test(o.name)));
  assert.throws(() => occasionsBetween('nope', '2026-01-01'));
});

test('occasions: free text is matched to the library, and a date is placed against the nearest occurrence', () => {
  assert.equal(findOccasion('Cup Day').id, 'melbourne-cup-day');
  assert.equal(findOccasion('melbourne cup').id, 'melbourne-cup-day');
  assert.equal(findOccasion('EOFY').id, 'eofy');
  assert.equal(findOccasion('Mothers Day').id, 'mothers-day');
  assert.equal(findOccasion('the office party'), null);
  assert.equal(findOccasion(''), null);
  assert.equal(nearestInstance('melbourne-cup-day', '2026-10-30').daysBefore, 4);
  assert.equal(nearestInstance('melbourne-cup-day', '2026-11-03').daysBefore, 0);
  assert.equal(nearestInstance('melbourne-cup-day', '2026-11-08').daysBefore, -5);
});

// ---- quotas and slots --------------------------------------------------------------------------------------------------

test('quota: 8 reels + 5 others = 13 by default, rejected ideas do not count, other formats share one pool', () => {
  assert.deepEqual(quotaOf({ items: [] }), { reel: 8, carousel: 3, post: 2, story: 0 });
  assert.equal(Object.values(quotaOf({ items: [] })).reduce((a, b) => a + b, 0), 13);
  const items = [item({ date: '2026-11-02' }), item({ date: '2026-11-03', format: 'carousel' }), item({ date: '2026-11-04', status: 'rejected' }), item({ date: '2026-12-01' })];
  const r = monthReport({ items }, '2026-11');
  assert.equal(r.total, 2);
  assert.deepEqual(r.counts, { reel: 1, carousel: 1, post: 0, story: 0 });
  assert.deepEqual(r.missing, { reel: 7, carousel: 2, post: 2, story: 0 });
  assert.equal(r.missingTotal, 11);
  assert.equal(r.ok, false);
  // five carousels and no single posts: the "5 others" are all there
  const carousels = Array.from({ length: 5 }, (_, i) => item({ date: `2026-11-0${i + 1}`, format: 'carousel' }));
  assert.deepEqual(needFor(quotaOf({ items: [] }), monthCounts(carousels, '2026-11').counts), { reel: 8, carousel: 0, post: 0, story: 0 });
  // with no month it reports every month from the first item to the last
  assert.deepEqual(monthReport({ items: [item({ date: '2026-11-02' }), item({ date: '2027-01-05' })] }).map((m) => m.month), ['2026-11', '2026-12', '2027-01']);
  assert.deepEqual(monthReport({ items: [] }), []);
  // a custom quota in the settings
  const custom = { settings: { perMonth: { reel: 2, post: 1 } }, items: [] };
  assert.equal(monthReport(custom, '2026-11').quotaTotal, 3);
  // pillars
  const withPillars = { settings: { pillars: PILLARS }, items: Array.from({ length: 6 }, (_, i) => item({ date: `2026-11-1${i}`, pillar: 'educate' })) };
  const p = monthReport(withPillars, '2026-11').pillars.find((x) => x.id === 'educate');
  assert.deepEqual([p.target, p.actual, p.state], [5.2, 6, 'ok']);
  assert.equal(monthReport({ settings: { pillars: PILLARS }, items: [...withPillars.items, item({ date: '2026-11-20', pillar: 'educate' }), item({ date: '2026-11-21', pillar: 'educate' })] }, '2026-11').pillars[0].state, 'over');
});

const gapsOf = (dates) => dates.slice(1).map((d, i) => D.diffDays(dates[i], d));

test('slots: a month of 13 spreads evenly over weekdays, one a day, reels spaced, no format back to back', () => {
  const slots = spreadSlots('2026-11', {});
  assert.equal(slots.length, 13);
  const tally = Object.groupBy(slots, (s) => s.format);
  assert.deepEqual([tally.reel.length, tally.carousel.length, tally.post.length], [8, 3, 2]);
  assert.equal(new Set(slots.map((s) => s.date)).size, 13, 'one post a day');
  assert.ok(slots.every((s) => D.weekday(s.date) >= 1 && D.weekday(s.date) <= 5), 'weekdays only by default');
  assert.ok(slots.every((s) => s.date.startsWith('2026-11-')));
  const sorted = slots.map((s) => s.date);
  assert.deepEqual(sorted, [...sorted].sort());
  const gaps = gapsOf(sorted);
  assert.ok(Math.max(...gaps) <= 5, `no long silences: ${gaps}`);
  assert.ok(Math.min(...gaps) >= 1);
  let run = 1, longest = 1;
  for (let i = 1; i < slots.length; i++) {
    if (slots[i].format === slots[i - 1].format) { run++; longest = Math.max(longest, run); assert.equal(slots[i].format, 'reel', 'only reels may follow reels'); } else run = 1;
  }
  assert.ok(longest <= 2, `reels in a row: ${longest}`);
  assert.deepEqual(spreadSlots('2026-11', {}), slots, 'deterministic');
});

test('slots: existing items count toward the quota and keep their days; avoided days and times are respected', () => {
  const existing = [item({ date: '2026-11-04', format: 'reel' }), item({ date: '2026-11-05', format: 'carousel' }), item({ date: '2026-11-18', format: 'reel' }), item({ date: '2026-11-19', format: 'reel', status: 'rejected' })];
  const slots = spreadSlots('2026-11', { existing, avoidDates: ['2026-11-03', { date: '2026-11-26' }], postTimes: ['09:00', '18:30'] });
  assert.equal(slots.length, 10, '13 minus the three live items');
  const taken = new Set(existing.filter((e) => e.status !== 'rejected').map((e) => e.date));
  assert.ok(slots.every((s) => !taken.has(s.date) && s.date !== '2026-11-03' && s.date !== '2026-11-26'));
  assert.deepEqual([...new Set(slots.map((s) => s.time))].sort(), ['09:00', '18:30']);
  assert.ok(!slots.some((s) => s.format === 'carousel' && Math.abs(D.diffDays(s.date, '2026-11-05')) === 1), 'a carousel does not sit next to the existing carousel');
  // a full month needs nothing
  const full = Array.from({ length: 13 }, (_, i) => item({ date: `2026-11-${String(i + 2).padStart(2, '0')}`, format: i < 8 ? 'reel' : i < 11 ? 'carousel' : 'post' }));
  assert.deepEqual(spreadSlots('2026-11', { existing: full }), []);
});

test('slots: when there are not enough free weekdays it uses other days, then doubles up; holidays are the last resort', () => {
  const crowded = Array.from({ length: 14 }, (_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`);
  const slots = spreadSlots('2026-11', { avoidDates: crowded, weekdays: [1, 2] });
  assert.equal(slots.length, 13);
  assert.ok(slots.filter((s) => crowded.includes(s.date)).length === 0, 'still room outside the avoided days');
  const tiny = spreadSlots('2026-02', { perMonth: { reel: 4 }, weekdays: [1], avoidDates: [] });
  assert.equal(tiny.length, 4);
  const allAvoided = Array.from({ length: 28 }, (_, i) => `2026-02-${String(i + 1).padStart(2, '0')}`);
  assert.equal(spreadSlots('2026-02', { perMonth: { reel: 3 }, avoidDates: allAvoided }).length, 3, 'always returns what the quota needs');
});

// ---- idea lint ---------------------------------------------------------------------------------------------------------

const GOOD = { id: 'new', date: '2026-11-12', format: 'carousel', title: 'Three questions to ask before your first visit', pillar: 'educate', idea: 'A checklist for nervous first-timers, drawn from what the front desk is asked each week.', hook: 'Nervous about your first visit? Ask these three things.', status: 'idea' };
const lint = (it, ctx = {}) => ideaLint(it, { brand: BRAND, today: '2026-10-05', cal: { settings: { pillars: PILLARS }, items: [] }, ...ctx });
const rules = (r) => [...r.errors, ...r.warnings].map((x) => x.rule);

test('lint: a good idea passes; past dates, bad dates and banned phrases fail', () => {
  const ok = lint(GOOD);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.ok, true);
  assert.deepEqual(rules(lint({ ...GOOD, date: '2026-09-30' })), ['past-date']);
  assert.equal(lint({ ...GOOD, date: '2026-02-30' }).errors[0].rule, 'bad-date');
  assert.ok(lint({ ...GOOD, hook: 'Meet our world-class team.' }).errors.some((e) => e.rule === 'banned-phrase' && e.phrase === 'world-class'), 'in the title or hook it is an error');
  assert.ok(lint({ ...GOOD, title: 'Our world-class team' }).errors.some((e) => e.rule === 'banned-phrase'));
  const described = lint({ ...GOOD, idea: 'Meet our world-class team.' });
  assert.deepEqual(described.errors, []);
  assert.ok(described.warnings.some((w) => w.rule === 'banned-phrase-described'), 'in the description it is a warning');
  for (const note of ['No world-class claims anywhere.', 'Never use "world-class" in the caption.', 'Avoid world-class; keep it plain.', "The phrase 'world-class' is banned wording."]) {
    assert.ok(!rules(lint({ ...GOOD, notes: note })).includes('banned-phrase-described'), `a note about avoiding it is fine: ${note}`);
  }
  assert.ok(lint({ ...GOOD, hook: 'Get an AMAZING SMILE today' }).errors.some((e) => e.rule === 'banned-phrase' && e.phrase === 'amazing smile'), 'a quoted phrase in the "dont" list is banned too');
  assert.deepEqual(bannedPhrasesOf(BRAND).sort(), ['amazing smile', 'world-class']);
  assert.equal(lint({ ...GOOD, status: 'built', date: '2026-09-30' }).ok, true, 'a past date matters only for ideas that still have to be posted');
});

test('lint: repeats within 90 days are refused, later ones are not; an identical hook is refused at any distance', () => {
  const existing = [{ id: 'old', date: '2026-11-03', format: 'reel', title: 'Three questions to ask on your first visit', idea: 'A checklist for nervous first-timers, from what the front desk hears each week.', hook: 'Before your first visit, ask these.', status: 'approved', pillar: 'educate' }];
  const near = lint(GOOD, { existing });
  assert.ok(near.errors.some((e) => e.rule === 'duplicate-angle' && e.other === 'old'), JSON.stringify(near));
  const far = lint({ ...GOOD, date: '2027-03-20' }, { existing });
  assert.ok(!rules(far).includes('duplicate-angle') && !rules(far).includes('similar-angle'));
  assert.ok(lint({ ...GOOD, title: 'Something else', idea: 'Another thing entirely about flossing technique.', hook: 'Before your first visit, ask these!' , date: '2027-06-01' }, { existing }).errors.some((e) => e.rule === 'same-hook'));
  // a series keeps its title when what each one says is different
  const series = [{ id: 'mtt1', date: '2026-10-13', format: 'reel', title: 'Meet the team', idea: 'Dr A talks about why she became a dentist.', hook: 'Meet Dr A.', status: 'built', pillar: 'educate' }];
  const next = lint({ ...GOOD, date: '2026-11-05', title: 'Meet the team', idea: 'Dr B explains how he looks after nervous patients.', hook: 'Meet Dr B.' }, { existing: series });
  assert.deepEqual(next.errors, []);
  assert.ok(next.warnings.some((w) => w.rule === 'same-title'));
  assert.ok(lint({ ...GOOD, date: '2026-11-05', title: 'Meet the team', idea: 'Dr A talks about why she became a dentist!', hook: 'Hello, Dr A.' }, { existing: series }).errors.some((e) => e.rule === 'duplicate-angle'), 'same title and the same thing said is a repeat');
  const rejected = [{ ...existing[0], status: 'rejected' }];
  assert.equal(lint(GOOD, { existing: rejected }).ok, true, 'a rejected idea is no longer a repeat');
  assert.ok(similarity('flossing tips for busy parents', 'tips about flossing for parents who are busy') > 0.5);
  assert.ok(similarity('flossing tips', 'cup day opening hours') < 0.1);
});

test('lint: pillars, quota, crowded days and format streaks', () => {
  assert.ok(lint({ ...GOOD, pillar: 'invented' }).errors.some((e) => e.rule === 'unknown-pillar'));
  assert.ok(lint({ ...GOOD, pillar: undefined }, { strict: true }).errors.some((e) => e.rule === 'no-pillar'));
  assert.ok(lint({ ...GOOD, hook: undefined }, { strict: true }).errors.some((e) => e.rule === 'no-hook'));
  assert.ok(lint({ ...GOOD, hook: undefined }).warnings.some((e) => e.rule === 'no-hook'), 'not strict: only a warning');
  const reels = Array.from({ length: 8 }, (_, i) => item({ date: `2026-11-0${i + 1}`, format: 'reel', pillar: 'people' }));
  const cal = { settings: { pillars: PILLARS }, items: reels };
  assert.ok(lint({ ...GOOD, format: 'reel', date: '2026-11-20' }, { existing: reels, cal, checkQuota: true }).errors.some((e) => e.rule === 'over-quota'));
  assert.ok(lint({ ...GOOD, format: 'reel', date: '2026-11-20' }, { existing: reels, cal }).warnings.some((e) => e.rule === 'over-quota'), 'a warning unless the quota is enforced');
  assert.ok(!rules(lint(GOOD, { existing: reels, cal, checkQuota: true })).includes('over-quota'), 'a carousel still fits');
  const same = [item({ date: '2026-11-12', format: 'reel', title: 'Unrelated reel about parking' })];
  assert.ok(lint(GOOD, { existing: same }).warnings.some((e) => e.rule === 'crowded-day'));
  const yesterday = [item({ date: '2026-11-11', format: 'carousel', title: 'Unrelated carousel about wisdom teeth' })];
  assert.ok(lint(GOOD, { existing: yesterday }).warnings.some((e) => e.rule === 'format-streak'));
  const many = Array.from({ length: 7 }, (_, i) => item({ date: `2026-11-0${i + 1}`, format: i % 2 ? 'carousel' : 'reel', pillar: 'educate', title: `Distinct topic ${i} ${'abcdefg'[i]}` }));
  assert.ok(lint({ ...GOOD, date: '2026-11-25' }, { existing: many, cal: { settings: { pillars: PILLARS }, items: many } }).warnings.some((e) => e.rule === 'pillar-drift'));
});

test('lint: health advertising words, only for health brands', () => {
  assert.equal(isRegulated(BRAND, {}), true);
  assert.equal(isRegulated(COFFEE, {}), false);
  assert.equal(isRegulated(COFFEE, { settings: { compliance: ['ahpra'] } }), true);
  const bad = lint({ ...GOOD, idea: 'A before and after of a whitening treatment.' });
  assert.ok(bad.errors.some((e) => e.rule === 'health-advertising' && /before-and-after/.test(e.message)));
  for (const text of ['A patient testimonial reel', 'Painless check-ups, guaranteed', 'The cure for nervous patients', 'Real Google reviews from patients', 'No risk, ever']) {
    assert.ok(lint({ ...GOOD, idea: text }).errors.some((e) => e.rule === 'health-advertising'), text);
  }
  assert.ok(lint({ ...GOOD, idea: 'Free whitening for everyone who books' }).warnings.some((e) => e.rule === 'health-advertising-word'));
  assert.ok(lint({ ...GOOD, idea: 'Our best tips for a busy morning' }).warnings.some((e) => e.rule === 'health-advertising-word'));
  assert.ok(!rules(lint({ ...GOOD, idea: 'How to secure an appointment around work' })).includes('health-advertising'), '"secure" is not "cure"');
  assert.ok(lint({ ...GOOD, idea: 'An implant explainer: healing takes 3 months' }).errors.some((e) => e.rule === 'implant-timeframe'));
  assert.ok(lint({ ...GOOD, mediaPlan: 'Close-up of a patient smiling' }).warnings.some((e) => e.rule === 'identifiable-people'));
  assert.ok(!rules(ideaLint({ ...GOOD, idea: 'A before and after of a latte pour' }, { brand: COFFEE, today: '2026-10-05', cal: { items: [] } })).includes('health-advertising'), 'a coffee shop is not held to health rules');
});

test('lint: figures nobody gave us, and occasions', () => {
  const facts = { facts: [{ key: 'years', value: '12 years in the suburb', source: 'website' }, { key: 'phone', value: '03 5555 0100', source: 'website' }] };
  assert.ok(lint({ ...GOOD, idea: 'Check-ups from $49 this month' }, { facts }).warnings.some((e) => e.rule === 'unsourced-number'));
  assert.ok(lint({ ...GOOD, idea: 'Trusted by over 5000 patients' }, { facts }).warnings.some((e) => e.rule === 'unsourced-number'));
  assert.ok(lint({ ...GOOD, idea: '95% of people floss wrongly' }, { facts }).warnings.some((e) => e.rule === 'unsourced-number'));
  assert.ok(!rules(lint({ ...GOOD, idea: 'Serving the suburb for 12 years' }, { facts })).includes('unsourced-number'), 'sourced');
  assert.ok(!rules(lint({ ...GOOD, idea: 'Planned for 2026-11-12 sharp' }, { facts })).includes('unsourced-number'), 'a date is not a figure');
  const cup = lint({ ...GOOD, date: '2026-10-28', occasion: 'Melbourne Cup' }, { regions: ['VIC'] });
  assert.ok(!rules(cup).includes('occasion-too-early'));
  assert.ok(lint({ ...GOOD, date: '2026-10-05', occasion: 'Melbourne Cup' }).warnings.some((e) => e.rule === 'occasion-too-early'));
  assert.ok(lint({ ...GOOD, date: '2026-11-20', occasion: 'Melbourne Cup' }).warnings.some((e) => e.rule === 'occasion-passed'));
  assert.ok(lint({ ...GOOD, occasion: 'The practice open day' }).warnings.some((e) => e.rule === 'unknown-occasion'));
  assert.ok(lint({ ...GOOD, date: '2027-07-30', occasion: 'Dental Health Week' }).warnings.some((e) => e.rule === 'verify-date'));
  assert.ok(lint({ ...GOOD, date: '2027-04-23', occasion: 'Anzac Day' }).warnings.some((e) => e.rule === 'respectful-occasion'));
  assert.ok(lint({ ...GOOD, date: '2026-11-27', occasion: 'Black Friday' }).warnings.some((e) => e.rule === 'avoid-promo-occasion'));
  assert.ok(lint({ ...GOOD, date: '2026-12-25' }).warnings.some((e) => e.rule === 'public-holiday'));
  assert.ok(!rules(lint({ ...GOOD, date: '2026-11-03' })).includes('public-holiday'), 'with no regions set only national holidays count');
  assert.ok(lint({ ...GOOD, date: '2026-11-03' }, { regions: ['VIC'] }).warnings.some((e) => e.rule === 'public-holiday'));
});

// ---- due logic ---------------------------------------------------------------------------------------------------------

test('due: approved ideas within the lead time, soonest first; built, idea and rejected items are not due', () => {
  const cal = {
    settings: { leadDays: 7 },
    items: [
      item({ id: 'a', date: '2026-10-12', status: 'approved' }), item({ id: 'b', date: '2026-10-13', status: 'approved' }), item({ id: 'c', date: '2026-10-09', status: 'approved' }),
      item({ id: 'd', date: '2026-10-08', status: 'idea' }), item({ id: 'e', date: '2026-10-08', status: 'built', doc: 'e' }), item({ id: 'f', date: '2026-10-08', status: 'rejected' }),
      item({ id: 'g', date: '2026-10-07', status: 'approved', doc: 'g' }), item({ id: 'h', date: '2026-10-02', status: 'approved' }),
    ],
  };
  assert.deepEqual(dueItems(cal, '2026-10-05').map((i) => i.id), ['h', 'c', 'a'], 'leadDays 7 reaches 12 Oct; an overdue one is still due');
  assert.deepEqual(dueItems(cal, '2026-10-05', 0).map((i) => i.id), ['h']);
  assert.deepEqual(dueItems(cal, '2026-10-06').map((i) => i.id), ['h', 'c', 'a', 'b']);
  assert.deepEqual(dueItems({ items: cal.items }, '2026-10-05', 7).map((i) => i.id), ['h', 'c', 'a']);
  // the runner also takes posts the owner sent back, and skips what has failed too often
  const more = { settings: { leadDays: 7, maxBuildAttempts: 3 }, items: [...cal.items, item({ id: 'r', date: '2026-12-01', status: 'changes', doc: 'r' }), item({ id: 'x', date: '2026-10-06', status: 'approved', run: { attempts: 3, state: 'gave-up' } })] };
  assert.deepEqual(S.runnableItems(more, '2026-10-05').map((q) => `${q.mode}:${q.item.id}`), ['build:h', 'build:c', 'build:a', 'revise:r']);
});

// ---- the validator and the files ---------------------------------------------------------------------------------------

test('the calendar schema accepts the new settings, and nordle validate checks calendar.json', () => {
  const cal = { ...newCalendar('x'), settings: { regions: ['VIC'], ideaApproval: 'delegated', compliance: ['ahpra'], maxBuildAttempts: 2 }, items: [item({ feedback: [{ at: '2026-10-05T00:00:00Z', by: 'owner', comment: 'Shorter' }], run: { attempts: 1, state: 'failed', lastError: 'x' } })] };
  assert.deepEqual(validateCalendar(cal).errors, []);
  assert.ok(!validateCalendar({ ...cal, settings: { regions: ['MARS'] } }).ok);
  assert.ok(!validateCalendar({ ...cal, settings: { ideaApproval: 'whenever' } }).ok);
  const p = project();
  saveCalendar(p.dir, { ...newCalendar(p.id), items: [item({ id: 'one', status: 'built', doc: 'missing-doc' }), item({ id: 'two', date: '2026-02-30' })] });
  const r = validateFile(join(p.dir, 'calendar.json'));
  assert.equal(r.kind, 'calendar');
  assert.ok(r.issues.some((i) => /does not exist in docs/.test(i.message)));
  assert.ok(r.issues.some((i) => /not a real date/.test(i.message)));
  const ex = validateFile(join(ROOT, 'examples', 'calendar.example.json'));
  assert.equal(ex.kind, 'calendar');
  assert.deepEqual(ex.issues.filter((i) => i.level === 'error'), []);
});

// ---- the service: who may do what --------------------------------------------------------------------------------------

const idea = (over = {}) => ({ date: '2026-11-17', format: 'carousel', title: 'What a first check-up involves', pillar: 'educate', idea: 'Walk through a first visit step by step so nervous people know what happens.', hook: 'Never been? Here is exactly what happens.', ...over });

test('service: Claude\'s ideas arrive as ideas; it cannot approve; the owner\'s own items are approved', async () => {
  const p = project({ settings: { pillars: PILLARS } });
  const r = await S.addItems(p.dir, [idea(), idea({ date: '2026-11-18', title: 'Flossing: the five-second habit', idea: 'A quick demo of flossing technique with a model of teeth, no promises.', hook: 'Five seconds, once a day.' })], { role: 'agent' });
  assert.equal(r.added.length, 2);
  assert.ok(r.added.every((i) => i.status === 'idea' && i.origin === 'claude' && !i.ideaApproval));
  assert.match(r.added[0].id, /^2026-11-17-what-a-first-check-up/);
  assert.equal(r.months[0].month, '2026-11');
  const approving = await S.addItems(p.dir, [idea({ date: '2026-11-20', title: 'Another one', status: 'approved' })], { role: 'agent' });
  assert.equal(approving.added.length, 0);
  assert.match(approving.rejected[0].errors[0].message, /Only the owner can approve/);
  assert.ok(await S.addItems(p.dir, [idea({ date: '2026-11-17', title: 'Zzz' })], { role: 'agent', force: true }).then(() => false, (e) => e.status === 403), 'only the owner can override the checks');
  const mine = await S.addItems(p.dir, [{ date: '2026-11-23', format: 'post', title: 'Opening hours over the holidays' }], { role: 'human' });
  assert.deepEqual([mine.added[0].status, mine.added[0].origin, mine.added[0].ideaApproval], ['approved', 'owner', 'owner']);
  const asIdea = await S.addItems(p.dir, [{ date: '2026-11-24', format: 'post', title: 'Maybe a quiz' }], { role: 'human', status: 'idea' });
  assert.equal(asIdea.added[0].status, 'idea');
  assert.equal(validateCalendar(loadCalendar(p.dir)).ok, true);
});

test('service: Claude\'s ideas are checked and refused with reasons; the owner is warned, not blocked', async () => {
  const p = project({ settings: { pillars: PILLARS } }, {});
  await S.addItems(p.dir, [idea()], { role: 'agent' });
  const r = await S.addItems(p.dir, [
    idea({ date: '2026-09-01', title: 'Sterilising instruments', idea: 'Following one tray of instruments through the autoclave cycle.', hook: 'Where do the instruments go?' }),
    idea({ date: '2026-11-30', title: 'A world-class team', idea: 'Introducing the world-class team behind the desk.', hook: 'Meet the desk team.' }),
    idea({ title: 'What a first check-up involves', hook: 'A different hook entirely.' }),
    idea({ date: '2026-11-19', title: 'Reviews', idea: 'A reel of patient testimonials.', hook: 'Hear it from them.' }),
    idea({ date: '2026-11-19', title: 'Parking and access', idea: 'Where to park, which door is step-free, and how to find reception.', hook: 'Finding us is easy.', pillar: 'nope' }),
    { date: '2026-11-19', format: 'wrong', title: 'Bad format' },
    idea({ date: '2026-11-19', title: 'Fine one', idea: 'How the dental hygienist chair is cleaned between visits, on camera.', hook: 'Clean between every visit?' }),
  ], { role: 'agent' });
  assert.equal(r.added.length, 1);
  assert.equal(r.added[0].title, 'Fine one');
  const why = r.rejected.map((x) => x.errors.map((e) => e.rule ?? e.path).join(','));
  assert.deepEqual(why, ['past-date', 'banned-phrase', 'duplicate-angle', 'health-advertising', 'unknown-pillar', '/format']);
  // the owner types the same thing and is only warned
  const human = await S.addItems(p.dir, [idea({ title: 'What a first check-up involves, again' })], { role: 'human' });
  assert.equal(human.added.length, 1);
  assert.ok(Object.values(human.warnings).flat().some((w) => ['same-hook', 'duplicate-angle'].includes(w.rule) && w.overridden), 'the problem is shown as a warning');
  const forced = await S.addItems(p.dir, [idea({ date: '2026-11-25', title: 'A world-class check', idea: 'World-class care.' })], { role: 'human', delegated: true, force: true });
  assert.equal(forced.added.length, 1, 'the owner can override');
});

test('service: with approval delegated, Claude\'s ideas arrive approved and say so', async () => {
  const p = project({ settings: { ideaApproval: 'delegated', pillars: PILLARS } });
  const r = await S.addItems(p.dir, [idea()], { role: 'agent' });
  assert.deepEqual([r.added[0].status, r.added[0].ideaApproval, r.added[0].origin], ['approved', 'delegated', 'claude']);
  // the command line does the same when the owner says --delegated
  const q = project({ settings: { pillars: PILLARS } });
  const c = await S.addItems(q.dir, [idea()], { role: 'human', delegated: true });
  assert.deepEqual([c.added[0].status, c.added[0].ideaApproval, c.added[0].origin], ['approved', 'delegated', 'claude']);
  assert.equal(S.effectiveSettings(loadCalendar(q.dir)).ideaApproval, 'owner', 'the command-line flag does not change the setting');
});

test('service: only the owner moves an item along; sign-off needs a post; changes need a comment', async () => {
  const p = project({ items: [item({ id: 'a', date: '2026-11-10', status: 'idea' })] });
  const state = () => loadCalendar(p.dir).items.find((i) => i.id === 'a');
  await S.decide(p.dir, 'a', 'approve');
  assert.deepEqual([state().status, state().ideaApproval], ['approved', 'owner']);
  await assert.rejects(S.decide(p.dir, 'a', 'signoff'), (e) => e.status === 409 && /nothing to sign off|cannot be signed off/.test(e.message));
  await assert.rejects(S.linkDoc(p.dir, 'a', 'not-there'), (e) => e.status === 404);
  writeDoc(p.dir, 'a');
  await S.linkDoc(p.dir, 'a', 'a', { role: 'agent' });
  assert.deepEqual([state().status, state().doc], ['built', 'a']);
  await assert.rejects(S.decide(p.dir, 'a', 'changes'), (e) => e.status === 400 && /comment/i.test(e.message));
  await S.decide(p.dir, 'a', 'changes', { comment: 'Shorter caption please' });
  assert.deepEqual([state().status, state().feedback[0].comment], ['changes', 'Shorter caption please']);
  await S.linkDoc(p.dir, 'a', 'a');
  assert.ok(state().feedback[0].resolved, 'relinking resolves the feedback');
  await S.decide(p.dir, 'a', 'signoff');
  assert.equal(state().status, 'signed-off');
  await assert.rejects(S.linkDoc(p.dir, 'a', 'a'), (e) => e.status === 409, 'a signed-off item is not rebuilt behind the owner\'s back');
  await S.decide(p.dir, 'a', 'posted');
  assert.equal(state().status, 'posted');
  await assert.rejects(S.decide(p.dir, 'a', 'reject'), (e) => e.status === 409);
  await assert.rejects(S.decide(p.dir, 'zzz', 'approve'), (e) => e.status === 404);
  await assert.rejects(S.decide(p.dir, 'a', 'explode'), (e) => e.status === 400);
  const idle = project({ items: [item({ id: 'z', status: 'idea' })] });
  await assert.rejects(S.linkDoc(idle.dir, 'z', 'z'), (e) => e.status === 404 || e.status === 409);
  writeDoc(idle.dir, 'z');
  await assert.rejects(S.linkDoc(idle.dir, 'z', 'z'), (e) => e.status === 409 && /not been approved/.test(e.message), 'an unapproved idea cannot be built');
});

test('service: Claude\'s edits cannot move status; editing an approved idea sends it back for approval; built items only take notes', async () => {
  const p = project({ settings: { pillars: PILLARS }, items: [item({ id: 'a', status: 'approved', ideaApproval: 'owner', title: 'Floss daily', idea: 'Quick flossing demo for beginners.', hook: 'Five seconds.', pillar: 'educate', date: '2026-11-12', format: 'carousel' }), item({ id: 'b', status: 'built', doc: 'b', date: '2026-11-13', format: 'post' })] });
  for (const status of ['rejected', 'signed-off', 'changes', 'posted', 'idea']) {
    await assert.rejects(S.updateItem(p.dir, 'a', { status }, { role: 'agent' }), (e) => e.status === 403, status);
  }
  await S.addItems(p.dir, [{ date: '2026-11-27', format: 'post', title: 'Waiting for a yes' }], { role: 'human', status: 'idea' });
  await assert.rejects(S.updateItem(p.dir, '2026-11-27-waiting-for-a-yes', { status: 'approved' }, { role: 'agent' }), (e) => e.status === 403 && /Only the owner/.test(e.message), 'Claude cannot approve');
  assert.equal(loadCalendar(p.dir).items.find((i) => i.id === 'a').status, 'approved');
  assert.equal(loadCalendar(p.dir).items.find((i) => i.id === '2026-11-27-waiting-for-a-yes').status, 'idea');
  const r = await S.updateItem(p.dir, 'a', { hook: 'Five seconds, once a day.' }, { role: 'agent' });
  assert.equal(r.item.status, 'idea', 'changing what an approved idea says needs approving again');
  assert.equal(r.item.ideaApproval, undefined);
  await S.decide(p.dir, 'a', 'approve');
  const note = await S.updateItem(p.dir, 'a', { notes: 'Use the model teeth.' }, { role: 'agent' });
  assert.equal(note.item.status, 'approved', 'a note does not reset approval');
  await assert.rejects(S.updateItem(p.dir, 'b', { title: 'New title' }, { role: 'agent' }), (e) => e.status === 409);
  assert.equal((await S.updateItem(p.dir, 'b', { notes: 'Left to the owner.' }, { role: 'agent' })).item.notes, 'Left to the owner.');
  await assert.rejects(S.updateItem(p.dir, 'a', { hook: 'A world-class demo.' }, { role: 'agent' }), (e) => e.status === 422 && /world-class/.test(e.message), 'edits face the same checks');
  await assert.rejects(S.updateItem(p.dir, 'a', { date: 'tomorrow' }, { role: 'agent' }), (e) => e.status === 400);
  // the owner may set a status through the same call, and clear a field with null
  const owner = await S.updateItem(p.dir, 'a', { status: 'rejected', hook: null }, { role: 'human' });
  assert.deepEqual([owner.item.status, owner.item.hook], ['rejected', undefined]);
});

test('service: settings are checked, and the owner can reset a stuck item', async () => {
  const p = project({ items: [item({ id: 'a', status: 'approved', run: { attempts: 3, state: 'gave-up', lastError: 'x' } })] });
  await assert.rejects(S.setSettings(p.dir, { leadDays: 500 }), (e) => e.status === 400);
  await assert.rejects(S.setSettings(p.dir, { colour: 'red' }), (e) => e.status === 400 && /Unknown setting/.test(e.message));
  const s = await S.setSettings(p.dir, { leadDays: 10, autoBuild: true, regions: ['VIC'], timezone: 'Australia/Perth' });
  assert.deepEqual([s.settings.leadDays, s.settings.autoBuild, s.timezone], [10, true, 'Australia/Perth']);
  assert.equal((await S.setSettings(p.dir, { autoBuild: null })).settings.autoBuild, false);
  await S.decide(p.dir, 'a', 'retry');
  assert.equal(loadCalendar(p.dir).items[0].run, undefined);
});

test('service: many writers at once lose nothing', async () => {
  const p = project({ settings: { pillars: PILLARS } });
  const topics = [['Flossing', 'Quick demo of flossing between tight contacts'], ['Mouthguards', 'Why contact-sport players wear a fitted guard'], ['Fluoride', 'What toothpaste labels mean by parts per million'], ['Wisdom teeth', 'When removal is discussed and when it is left alone'],
    ['Dry mouth', 'Everyday habits that help a dry mouth'], ['Electric brushes', 'Choosing between oscillating and sonic heads'], ['Gum health', 'Spotting bleeding early at the basin'], ['Sensitive teeth', 'Cold drinks and exposed root surfaces'],
    ['Night grinding', 'Jaw clenching, morning headaches, and a bite guard'], ['Dummies and thumbs', 'Settling habits before the adult teeth arrive'], ['Sugar in drinks', 'Reading a sports drink label'], ['Clinic tour', 'Walking from reception to the surgery']];
  const adds = topics.map(([title, text], i) => S.addItems(p.dir, [idea({ date: `2026-11-${String(i + 2).padStart(2, '0')}`, format: i < 8 ? 'reel' : 'carousel', title, idea: text, hook: `${title}: ${text.split(' ').slice(0, 3).join(' ')}?` })], { role: 'agent' }));
  const done = await Promise.all(adds);
  assert.equal(done.reduce((a, r) => a + r.added.length, 0), 12);
  assert.equal(loadCalendar(p.dir).items.length, 12);
  assert.ok(!existsSync(join(p.dir, '.calendar.lock')), 'the lock is released');
});

// ---- prompts -----------------------------------------------------------------------------------------------------------

test('prompts: the propose prompt carries the brand, quotas, slots, occasions, history and the rules', async () => {
  const p = project({ settings: { pillars: PILLARS, regions: ['VIC'] }, items: [item({ id: 'old', date: '2026-10-20', format: 'reel', title: 'A very particular earlier topic', hook: 'The earlier hook line', status: 'posted' })] }, { facts: { facts: [{ key: 'opening', value: 'Open six days', source: 'website' }] } });
  const text = proposePrompt(p.dir, { months: ['2026-11'], today: '2026-10-05' });
  for (const must of ['Sample Dental Practice', 'Local families who put off the dentist', 'nordle_calendar_propose', '8 reels + 3 carousels + 2 posts = 13', 'Still to plan: 8 reel, 3 carousel, 2 post', 'educate', 'Melbourne Cup Day', 'Movember', 'VERIFY', 'Open six days', 'A very particular earlier topic', 'The earlier hook line',
    'Specific', 'AHPRA', 'children\'s faces', 'world-class', 'catalog.json', 'Open slots']) assert.ok(text.includes(must), `missing: ${must}`);
  assert.ok(!text.includes('WA Term'), 'only the brand\'s state');
  assert.ok(/2026-11-0[2-9]|2026-11-1\d/.test(text) && text.split('\n').filter((l) => /^- 2026-11-\d\d \w{3} \d\d:\d\d (reel|carousel|post)$/.test(l)).length === 13, 'thirteen open slots listed');
  assert.ok(text.length < 14000, `compact: ${text.length}`);
  assert.match(text, /approves, edits or rejects every idea/);
  const delegated = project({ settings: { ideaApproval: 'delegated' } });
  assert.match(proposePrompt(delegated.dir, { months: ['2026-11'], today: '2026-10-05' }), /delegated approval/);
  const coffee = project({}, { brand: COFFEE });
  const plain = proposePrompt(coffee.dir, { months: ['2026-11'], today: '2026-10-05' });
  assert.ok(!plain.includes('AHPRA') && plain.includes('Never invent a fact'), 'health rules only for health brands');
  // with no months given it plans every month of the horizon that has a gap
  const auto = proposePrompt(p.dir, { today: '2026-10-05' });
  assert.ok(auto.includes('October 2026') && auto.includes('November 2026') && auto.includes('December 2026'));
  assert.deepEqual(contentRules({ regulated: false }).length < contentRules({ regulated: true }).length, true);
});

test('facts.json: shown in the prompts, its banned claims are enforced, its risk wording is asked for', () => {
  const facts = {
    schema: 'nordle.facts/0.1', brand: 'x', names: ['Sample Dental Practice'], phones: [{ label: 'main', number: '03 5555 0100', source: 'website' }],
    staff: [{ name: 'Dr Alex Example', title: 'Principal Dentist', source: 'website' }], services: ['General dental', { name: 'Dental implants' }],
    approvedStats: [{ text: 'Open since 2010', source: 'website' }], approvedCtas: ['Call 03 5555 0100'], bannedClaims: ['gentle'],
    riskStatement: { text: 'All dental treatment carries risks.', appliesTo: ['implant'] },
  };
  const p = project({ settings: { pillars: PILLARS }, items: [item({ id: 'x1', date: '2026-11-10', format: 'carousel', status: 'approved' })] }, { facts });
  const text = proposePrompt(p.dir, { months: ['2026-11'], today: '2026-10-05' });
  for (const must of ['Dr Alex Example, Principal Dentist', 'main 03 5555 0100', 'Open since 2010', 'General dental, Dental implants', '"gentle"', 'All dental treatment carries risks.', 'Every entry above has a source', 'Call 03 5555 0100']) assert.ok(text.includes(must), `missing: ${must}`);
  assert.ok(buildPrompt(p.dir, 'x1', { today: '2026-10-05' }).includes('carries the general risk wording the practice already uses: "All dental treatment carries risks."'));
  assert.ok(bannedPhrasesOf(BRAND, facts).includes('gentle'));
  assert.ok(lint({ ...GOOD, hook: 'Gentle care for nervous people' }, { facts }).errors.some((e) => e.rule === 'banned-phrase' && e.phrase === 'gentle'));
  assert.ok(lint({ ...GOOD, title: 'Dental implants explained' }, { facts }).warnings.some((w) => w.rule === 'risk-statement'));
  assert.ok(!rules(lint({ ...GOOD, title: 'Dental implants explained', notes: 'The risk line goes on the end card.' }, { facts })).includes('risk-statement'));
  assert.ok(!rules(lint(GOOD, { facts })).includes('risk-statement'), 'only when a covered treatment is mentioned');
  // the older flat shape still shows
  const flat = project({}, { facts: { facts: [{ key: 'opening', value: 'Open six days', source: 'website' }] } });
  assert.match(proposePrompt(flat.dir, { months: ['2026-11'], today: '2026-10-05' }), /opening: Open six days \(source: website\)/);
});

test('prompts: the build prompt gives the brief, the exact toolchain, the self-check, the independent review and the rules', async () => {
  const p = project({ settings: { pillars: PILLARS }, items: [
    item({ id: 'nov-carousel', date: '2026-11-12', format: 'carousel', title: 'First visit checklist', status: 'approved', idea: 'A checklist for nervous first-timers.', hook: 'Nervous? Ask these.', mediaPlan: 'Reception photo, instrument tray', occasion: 'Movember', pillar: 'educate' }),
    item({ id: 'nov-reel', date: '2026-11-13', format: 'reel', title: 'Behind the scenes', status: 'approved', idea: 'A day at the practice.', hook: 'Seven a.m.' }),
    item({ id: 'back', date: '2026-11-14', format: 'post', title: 'Sent back', status: 'changes', doc: 'back', notes: 'Changes requested: make the headline shorter', feedback: [{ at: '2026-10-04T10:00:00Z', by: 'owner', comment: 'Use the cream background' }] }),
  ] });
  const text = buildPrompt(p.dir, 'nov-carousel', { today: '2026-10-05' });
  for (const must of ['First visit checklist', 'A checklist for nervous first-timers.', 'Nervous? Ask these.', 'Reception photo, instrument tray', 'specs/nov-carousel.json', 'nordle.mjs" build "', '--sheet', 'calendarItem": "nov-carousel"', 'cover, statement, list',
    'Designer self-check', 'critique scores 88', 'media-match', 'brief (reviewer)', 'Independent review', 'Agent tool', 'never record reviewer checks yourself', 'nordle_calendar_link', 'AHPRA', 'facts.json', 'Do not approve, reject, sign off']) assert.ok(text.includes(must), `missing: ${must}`);
  assert.ok(!/\\/.test(text.split('\n').find((l) => l.includes('nordle.mjs" build'))), 'forward slashes only: the shell collapses backslashes');
  assert.ok(text.length < 12000, `compact: ${text.length}`);
  const reel = buildPrompt(p.dir, 'nov-reel', { today: '2026-10-05' });
  assert.match(reel, /video post/);
  assert.match(reel, /speech-cuts|speaker is never cut off|sentence/i);
  assert.ok(Object.keys(pluginToolNames()).includes('calendar'));
  const revise = buildPrompt(p.dir, 'back', { today: '2026-10-05' });
  for (const must of ['Revise the post', 'Use the cream background', 'make the headline shorter', 'change the existing post', 'nordle_get_feedback']) assert.ok(revise.includes(must) || revise.toLowerCase().includes(must.toLowerCase()), `missing: ${must}`);
  assert.throws(() => buildPrompt(p.dir, 'nope'), (e) => e.status === 404);
});

// ---- the runner, with a fake Claude ------------------------------------------------------------------------------------

/** A stand-in for `claude -p`. behave({ prompt, args, opts, id, mcp }) does what Claude would do and returns an exit code, or 'hang'. */
function fakeClaude(behave) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let prompt = '';
    child.stdin = { on() {}, end(text) { prompt = String(text ?? ''); } };
    child.kill = () => { child.killed = true; setImmediate(() => child.emit('close', null, 'SIGKILL')); };
    const call = { cmd, args, opts, child, get prompt() { return prompt; }, mcp: null };
    try { call.mcp = JSON.parse(readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8')); } catch { /* not asked for */ }
    calls.push(call);
    setImmediate(async () => {
      const id = /Calendar item `([^`]+)`/.exec(prompt)?.[1];
      const code = await behave({ prompt, args, opts, id, call });
      if (code === 'hang') return;
      if (code === 'enoent') { const e = new Error('spawn claude ENOENT'); e.code = 'ENOENT'; child.emit('error', e); return; }
      child.stdout.emit('data', JSON.stringify({ type: 'result', subtype: 'success', is_error: code !== 0, result: 'Made the post.', num_turns: 12, total_cost_usd: 0.4, session_id: 's1' }));
      child.emit('close', code ?? 0, null);
    });
    return child;
  };
  return { spawn, calls };
}
const fakeExec = (validateCode = 0) => {
  const calls = [];
  return { calls, exec: async (cmd, args) => { calls.push({ cmd, args }); return { code: args.some((a) => /validate/.test(a)) ? validateCode : 0, stdout: validateCode ? 'FAIL docs/x.json\n     error /pages: bad' : 'OK', stderr: '' }; } };
};
const dueProject = (extra = {}, items) => project({ settings: { leadDays: 7, autoBuild: true, pillars: PILLARS, ...extra }, items: items ?? [item({ id: 'due-one', date: '2026-10-08', format: 'carousel', status: 'approved', title: 'Due soon', idea: 'Something specific.', hook: 'A hook.', pillar: 'educate' })] });
const itemOf = (p, id) => loadCalendar(p.dir).items.find((i) => i.id === id);
const finishBuild = (p) => async ({ id }) => { writeDoc(p.dir, id); await S.linkDoc(p.dir, id, id); return 0; };

test('runner: does nothing unless autoBuild is on or --yes is given; says why', async () => {
  const p = dueProject({ autoBuild: false });
  const f = fakeClaude(async () => 0);
  const off = await runDue({ projectDir: p.dir, today: '2026-10-05', spawn: f.spawn, exec: fakeExec().exec });
  assert.equal(off.enabled, false);
  assert.match(off.reason, /autoBuild is off/);
  assert.deepEqual(off.due.map((d) => d.id), ['due-one']);
  assert.equal(f.calls.length, 0);
  assert.equal(itemOf(p, 'due-one').status, 'approved');
});

test('runner: builds a due item with a headless Claude, then checks it and leaves it built', async () => {
  const p = dueProject();
  let seenStatus;
  const f = fakeClaude(async (ctx) => { seenStatus = itemOf(p, ctx.id).status; return finishBuild(p)(ctx); });
  const ex = fakeExec();
  const logs = [];
  const r = await runDue({ projectDir: p.dir, today: '2026-10-05', spawn: f.spawn, exec: ex.exec, log: (s) => logs.push(s) });
  assert.equal(r.enabled, true);
  assert.deepEqual(r.ran.map((x) => [x.id, x.outcome, x.doc]), [['due-one', 'built', 'due-one']]);
  assert.equal(seenStatus, 'building', 'the item is marked building while Claude works');
  assert.equal(itemOf(p, 'due-one').status, 'built');
  assert.equal(itemOf(p, 'due-one').run.attempts, 0);
  const c = f.calls[0];
  assert.equal(c.cmd, process.env.NORDLE_CLAUDE_BIN);
  assert.equal(c.opts.windowsHide, true, 'no pop-up window');
  assert.notEqual(c.opts.stdio, 'inherit');
  assert.deepEqual(c.opts.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(c.opts.env.NORDLE_AGENT_RUN, '1');
  assert.equal(c.opts.cwd, p.dir);
  assert.ok(['-p', '--output-format', 'json', '--max-turns', '--strict-mcp-config', '--allowedTools'].every((a) => c.args.includes(a)));
  assert.ok(c.args.slice(c.args.indexOf('--allowedTools')).includes('mcp__nordle'));
  assert.ok(c.mcp.mcpServers.nordle.args[0].endsWith('mcp.mjs'));
  assert.match(c.prompt, /Due soon/);
  assert.ok(!existsSync(c.args[c.args.indexOf('--mcp-config') + 1]), 'the temporary MCP config is removed');
  assert.ok(!existsSync(runLockPath(p.dir)), 'the lock is released');
  const v = ex.calls.find((x) => x.args.some((a) => /validate.mjs/.test(a)));
  assert.ok(v.args.some((a) => a.endsWith('due-one.json')), 'the finished post is validated');
  const logFile = r.ran[0].log;
  assert.ok(existsSync(logFile));
  const rec = JSON.parse(readFileSync(logFile, 'utf8'));
  assert.deepEqual([rec.outcome, rec.claude.num_turns, rec.exitCode], ['built', 12, 0]);
  assert.ok(logs.some((l) => /Building due-one/.test(l)));
});

test('runner: --yes runs even with autoBuild off; --limit and --item choose what; one at a time', async () => {
  const p = dueProject({ autoBuild: false }, [
    item({ id: 'a', date: '2026-10-07', format: 'post', status: 'approved' }), item({ id: 'b', date: '2026-10-08', format: 'post', status: 'approved' }), item({ id: 'c', date: '2026-10-09', format: 'post', status: 'approved' }),
  ]);
  let running = 0, most = 0;
  const f = fakeClaude(async (ctx) => { running++; most = Math.max(most, running); await new Promise((r) => setTimeout(r, 15)); const code = await finishBuild(p)(ctx); running--; return code; });
  const r = await runDue({ projectDir: p.dir, today: '2026-10-05', yes: true, limit: 2, spawn: f.spawn, exec: fakeExec().exec });
  assert.deepEqual(r.ran.map((x) => x.id), ['a', 'b'], 'soonest first, limited');
  assert.equal(most, 1, 'never two at once');
  assert.deepEqual(itemOf(p, 'c').status, 'approved');
  const one = await runDue({ projectDir: p.dir, today: '2026-10-05', yes: true, itemId: 'c', spawn: f.spawn, exec: fakeExec().exec });
  assert.deepEqual(one.ran.map((x) => x.id), ['c']);
});

test('runner: a failed run puts the item back, counts the attempt, and gives up after the limit; retry starts again', async () => {
  const p = dueProject({ maxBuildAttempts: 2 });
  const f = fakeClaude(async () => 1);
  const ex = fakeExec();
  const run = () => runDue({ projectDir: p.dir, today: '2026-10-05', spawn: f.spawn, exec: ex.exec });
  const first = await run();
  assert.equal(first.ran[0].outcome, 'failed');
  assert.match(first.ran[0].error, /without building the post/);
  let it = itemOf(p, 'due-one');
  assert.deepEqual([it.status, it.run.attempts, it.run.state], ['approved', 1, 'failed']);
  assert.ok(it.run.lastError.length > 0 && !it.doc);
  const second = await run();
  assert.equal(second.ran.length, 1);
  it = itemOf(p, 'due-one');
  assert.deepEqual([it.status, it.run.attempts, it.run.state], ['approved', 2, 'gave-up']);
  const third = await run();
  assert.equal(third.ran.length, 0, 'it stopped trying');
  assert.equal(f.calls.length, 2);
  await S.decide(p.dir, 'due-one', 'retry');
  assert.equal((await run()).ran.length, 1);
});

test('runner: a run that hangs is killed at the timeout and the item goes back', async () => {
  const p = dueProject();
  const f = fakeClaude(async () => 'hang');
  const t0 = Date.now();
  const r = await runDue({ projectDir: p.dir, today: '2026-10-05', timeoutMs: 120, spawn: f.spawn, exec: fakeExec().exec });
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(f.calls[0].child.killed, true);
  assert.equal(r.ran[0].outcome, 'timeout');
  assert.match(r.ran[0].error, /Timed out/);
  assert.equal(itemOf(p, 'due-one').status, 'approved');
  assert.ok(!existsSync(runLockPath(p.dir)));
});

test('runner: only one run per project at a time, and a dead run\'s lock does not block', async () => {
  const p = dueProject();
  const f = fakeClaude(finishBuild(p));
  const held = acquireRunLock(p.dir, { item: 'other', mode: 'build' });
  assert.equal(held.ok, true);
  const blocked = await runDue({ projectDir: p.dir, today: '2026-10-05', spawn: f.spawn, exec: fakeExec().exec });
  assert.ok(blocked.locked, 'another run holds the lock');
  assert.equal(blocked.locked.item, 'other');
  assert.equal(f.calls.length, 0);
  assert.equal(readRunLock(p.dir).item, 'other');
  held.release();
  // a lock whose process is gone
  writeFileSync(runLockPath(p.dir), JSON.stringify({ pid: 2147483000, started: new Date().toISOString(), item: 'ghost' }));
  const after = await runDue({ projectDir: p.dir, today: '2026-10-05', spawn: f.spawn, exec: fakeExec().exec });
  assert.equal(after.ran[0].outcome, 'built');
  // a lock held by a live process but far too old
  writeFileSync(runLockPath(p.dir), JSON.stringify({ pid: process.pid, started: '2020-01-01T00:00:00Z', item: 'old' }));
  assert.equal(readRunLock(p.dir), null);
});

test('runner: an item a crashed run left on "building" is put back and built again', async () => {
  const p = dueProject({}, [item({ id: 'stuck', date: '2026-10-07', format: 'post', status: 'building', run: { attempts: 1, state: 'building', startedAt: '2026-10-04T00:00:00Z' } })]);
  const f = fakeClaude(async () => 0);
  const logs = [];
  const r = await runDue({ projectDir: p.dir, today: '2026-10-05', spawn: f.spawn, exec: fakeExec().exec, log: (s) => logs.push(s), now: Date.parse('2026-10-05T12:00:00Z') });
  assert.ok(logs.some((l) => /left half-built: stuck/.test(l)));
  assert.equal(r.ran.length, 1, 'put back, then picked up in the same run');
  assert.equal(r.ran[0].id, 'stuck');
  assert.equal(itemOf(p, 'stuck').status, 'approved', 'this fake Claude built nothing');
  // a build that began a minute ago is somebody else\'s: leave it
  const live = dueProject({}, [item({ id: 'live', date: '2026-10-07', format: 'post', status: 'building', run: { attempts: 1, state: 'building', startedAt: new Date().toISOString() } })]);
  const none = await runDue({ projectDir: live.dir, today: '2026-10-05', spawn: f.spawn, exec: fakeExec().exec });
  assert.equal(none.ran.length, 0);
  assert.equal(itemOf(live, 'live').status, 'building');
});

test('runner: if Claude wrote the post but forgot to link it, the runner links it; if the post is invalid it is not left built', async () => {
  const p = dueProject();
  const ex = fakeExec();
  const r = await runDue({ projectDir: p.dir, today: '2026-10-05', spawn: fakeClaude(async ({ id }) => { writeDoc(p.dir, id); return 0; }).spawn, exec: ex.exec });
  assert.equal(r.ran[0].outcome, 'built');
  assert.equal(itemOf(p, 'due-one').status, 'built');

  const q = dueProject();
  const bad = await runDue({ projectDir: q.dir, today: '2026-10-05', spawn: fakeClaude(finishBuild(q)).spawn, exec: fakeExec(1).exec });
  assert.equal(bad.ran[0].outcome, 'failed');
  assert.match(bad.ran[0].error, /does not validate/);
  const it = itemOf(q, 'due-one');
  assert.deepEqual([it.status, it.doc, it.run.attempts], ['approved', undefined, 1]);

  const skip = dueProject();
  const ok = await runDue({ projectDir: skip.dir, today: '2026-10-05', validate: false, spawn: fakeClaude(finishBuild(skip)).spawn, exec: fakeExec(1).exec });
  assert.equal(ok.ran[0].outcome, 'built', 'validation can be turned off');
});

test('runner: an unexpected error mid-run never leaves an item on "building"', async () => {
  const p = dueProject();
  const r = await runDue({ projectDir: p.dir, today: '2026-10-05', spawn: fakeClaude(finishBuild(p)).spawn, exec: async () => { throw new Error('disk on fire'); } });
  assert.equal(r.ran[0].outcome, 'failed');
  assert.match(r.ran[0].error, /disk on fire/);
  const it = itemOf(p, 'due-one');
  assert.deepEqual([it.status, it.doc, it.run.attempts, it.run.state], ['approved', undefined, 1, 'failed']);
  assert.ok(!existsSync(runLockPath(p.dir)));
});

test('runner: the owner changing the item while it builds is respected', async () => {
  const p = dueProject();
  const r = await runDue({ projectDir: p.dir, today: '2026-10-05', spawn: fakeClaude(async ({ id }) => { await S.decide(p.dir, id, 'reject'); writeDoc(p.dir, id); return 0; }).spawn, exec: fakeExec().exec });
  assert.equal(r.ran[0].outcome, 'skipped');
  assert.equal(itemOf(p, 'due-one').status, 'rejected');
});

test('runner: posts the owner sent back are revised in place, not rebuilt', async () => {
  const p = dueProject({}, [item({ id: 'sent-back', date: '2026-12-20', format: 'carousel', status: 'changes', doc: 'sent-back', feedback: [{ at: '2026-10-04T00:00:00Z', by: 'owner', comment: 'Warmer headline' }] })]);
  writeDoc(p.dir, 'sent-back');
  utimesSync(join(p.dir, 'docs', 'sent-back.json'), new Date('2020-01-01'), new Date('2020-01-01'));
  const f = fakeClaude(async ({ id }) => { writeDoc(p.dir, id); return 0; });
  const r = await runDue({ projectDir: p.dir, today: '2026-10-05', spawn: f.spawn, exec: fakeExec().exec });
  assert.deepEqual(r.ran.map((x) => [x.mode, x.outcome]), [['revise', 'built']]);
  assert.match(f.calls[0].prompt, /Warmer headline/);
  const it = itemOf(p, 'sent-back');
  assert.deepEqual([it.status, it.doc], ['built', 'sent-back']);
  // a revision that touched nothing is a failure, and the post goes back to "changes"
  const q = dueProject({}, [item({ id: 'untouched', date: '2026-12-20', format: 'post', status: 'changes', doc: 'untouched', feedback: [{ at: '2026-10-04T00:00:00Z', by: 'owner', comment: 'x' }] })]);
  writeDoc(q.dir, 'untouched');
  utimesSync(join(q.dir, 'docs', 'untouched.json'), new Date('2020-01-01'), new Date('2020-01-01'));
  const bad = await runDue({ projectDir: q.dir, today: '2026-10-05', spawn: fakeClaude(async () => 0).spawn, exec: fakeExec().exec });
  assert.equal(bad.ran[0].outcome, 'failed');
  assert.equal(itemOf(q, 'untouched').status, 'changes');
});

test('runner: a dry run changes nothing and starts nothing; a missing Claude stops the run with a plain message', async () => {
  const p = dueProject();
  const f = fakeClaude(async () => 0);
  const dry = await runDue({ projectDir: p.dir, today: '2026-10-05', dryRun: true, spawn: f.spawn, exec: fakeExec().exec });
  assert.equal(f.calls.length, 0);
  assert.equal(dry.dryRun[0].id, 'due-one');
  assert.ok(dry.dryRun[0].command.includes('-p') && dry.dryRun[0].promptChars > 500);
  assert.equal(itemOf(p, 'due-one').status, 'approved');
  assert.ok(!existsSync(runLockPath(p.dir)));
  const two = dueProject({}, [item({ id: 'a', date: '2026-10-07', format: 'post', status: 'approved' }), item({ id: 'b', date: '2026-10-08', format: 'post', status: 'approved' })]);
  const missing = fakeClaude(async () => 'enoent');
  const r = await runDue({ projectDir: two.dir, today: '2026-10-05', spawn: missing.spawn, exec: fakeExec().exec });
  assert.equal(r.ran.length, 1, 'it does not try the second when Claude cannot start');
  assert.match(r.ran[0].error, /NORDLE_CLAUDE_BIN/);
  assert.equal(itemOf(two, 'a').status, 'approved');
});

test('runner: the real process handling works (stdin in, stdout out, a hung process is stopped by PID, a missing program is explained)', async () => {
  // a stand-in program (node itself): never the real Claude
  const echo = await runClaude({ spawn: nodeSpawn, exec: defaultExec, bin: process.execPath, args: ['-e', "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.stringify({result:s})))"], cwd: work, env: process.env, prompt: 'the prompt text', timeoutMs: 20000 });
  assert.equal(echo.code, 0);
  assert.equal(echo.timedOut, false);
  assert.equal(JSON.parse(echo.stdout).result, 'the prompt text');

  const hang = await runClaude({ spawn: nodeSpawn, exec: defaultExec, bin: process.execPath, args: ['-e', "console.log(process.pid);setInterval(()=>{},1000)"], cwd: work, env: process.env, prompt: '', timeoutMs: 1500 });
  assert.equal(hang.timedOut, true);
  const pid = Number(hang.stdout.trim().split('\n')[0]);
  assert.ok(pid > 4);
  let alive = true;
  for (let i = 0; i < 40 && alive; i++) { try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 100)); } catch { alive = false; } }
  assert.equal(alive, false, 'the process it started is gone');

  const gone = await runClaude({ spawn: nodeSpawn, exec: defaultExec, bin: join(work, 'no-such-program'), args: [], cwd: work, env: process.env, prompt: 'x', timeoutMs: 5000 });
  assert.match(gone.error, /NORDLE_CLAUDE_BIN/);
});

test('runner: the Claude command line is narrow and the MCP config points at this install', () => {
  const args = claudeArgs({ mcpFile: 'm.json', tools: ['mcp__nordle', 'Read'] });
  assert.deepEqual(args.slice(0, 4), ['-p', '--output-format', 'json', '--max-turns']);
  assert.ok(args.includes('--strict-mcp-config'));
  assert.deepEqual(args.slice(args.indexOf('--allowedTools') + 1), ['mcp__nordle', 'Read']);
  const cfg = mcpConfig(ROOT);
  assert.equal(cfg.mcpServers.nordle.command, process.execPath);
  assert.equal(cfg.mcpServers.nordle.args[0], join(ROOT, 'mcp.mjs'));
});

test('runner: proposing ideas happens only when asked for, once a day, and counts what Claude added', async () => {
  const p = project({ settings: { autoPropose: false, horizonMonths: 2, pillars: PILLARS, ideaApproval: 'delegated' } });
  const off = await runPropose({ projectDir: p.dir, today: '2026-10-05', spawn: fakeClaude(async () => 0).spawn, exec: fakeExec().exec });
  assert.equal(off.enabled, false);
  const f = fakeClaude(async () => { await S.addItems(p.dir, [idea({ date: '2026-10-20' })], { role: 'agent', today: '2026-10-05' }); return 0; });
  const r = await runPropose({ projectDir: p.dir, today: '2026-10-05', yes: true, spawn: f.spawn, exec: fakeExec().exec, now: Date.parse('2026-10-05T06:00:00Z') });
  assert.equal(r.ran[0].outcome, 'proposed');
  assert.equal(r.ran[0].added.length, 1);
  assert.deepEqual(r.months, ['2026-10', '2026-11']);
  assert.match(f.calls[0].prompt, /Plan the next posts/);
  assert.ok(f.calls[0].args.includes('Read') && !f.calls[0].args.includes('Bash(node:*)'), 'the planner gets no shell');
  assert.equal(itemOf(p, r.ran[0].added[0]).status, 'approved', 'delegated');
  // switched on, but it already ran this morning
  await S.setSettings(p.dir, { autoPropose: true });
  const again = await runPropose({ projectDir: p.dir, today: '2026-10-05', spawn: f.spawn, exec: fakeExec().exec, now: Date.parse('2026-10-05T12:00:00Z') });
  assert.match(again.skipped, /waiting/);
  assert.equal(f.calls.length, 1);
  const nothing = await runPropose({ projectDir: p.dir, today: '2026-10-05', yes: true, spawn: fakeClaude(async () => 0).spawn, exec: fakeExec().exec });
  assert.equal(nothing.ran[0].outcome, 'failed');
  assert.match(nothing.ran[0].error, /without adding any ideas/);
});

// ---- the command line --------------------------------------------------------------------------------------------------

async function run(...args) {
  const lines = [];
  const log = console.log, error = console.error;
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  let code;
  try { code = await cli.run(args); } finally { console.log = log; console.error = error; }
  return { code, text: lines.join('\n') };
}

test('cli: status, add, approve, list, slots, lint and the settings, as the owner', async () => {
  const p = project({ settings: { pillars: PILLARS } });
  const u = await run('help');
  assert.equal(u.code, 0);
  assert.match(u.text, /schedule-install/);
  assert.equal((await run('bogus')).code, 2);
  const st = await run('status', p.id);
  assert.match(st.text, /2026-10 {2}0\/13/);
  assert.match(st.text, /to plan: 8 reel, 3 carousel, 2 post/);
  const add = await run('add', p.id, '--date', '2026-11-12', '--format', 'carousel', '--title', 'First visit checklist', '--pillar', 'educate', '--idea', 'A checklist for nervous first-timers, from the front desk.', '--hook', 'Nervous? Ask these three things.');
  assert.equal(add.code, 0, add.text);
  assert.match(add.text, /added 2026-11-12 .*carousel +idea +2026-11-12-first-visit-checklist/);
  const refused = await run('add', p.id, '--date', '2026-01-01', '--format', 'reel', '--title', 'Past');
  assert.equal(refused.code, 1);
  assert.match(refused.text, /REFUSED/);
  assert.match(refused.text, /past-date|no-idea/);
  const file = join(work, 'ideas.json');
  writeFileSync(file, JSON.stringify({ ideas: [{ date: '2026-11-19', format: 'reel', title: 'Hygienist day', pillar: 'people', idea: 'A morning with the hygienist, filmed in the real room.', hook: 'Seven a.m. at the practice.' }] }));
  const viaFile = await run('add', p.id, '--file', file, '--delegated');
  assert.equal(viaFile.code, 0, viaFile.text);
  assert.match(viaFile.text, /reel +approved/);
  assert.equal(loadCalendar(p.dir).items.find((i) => i.title === 'Hygienist day').ideaApproval, 'delegated');
  assert.equal((await run('approve', p.id, '2026-11-12-first-visit-checklist')).code, 0);
  assert.equal(loadCalendar(p.dir).items.find((i) => i.id === '2026-11-12-first-visit-checklist').status, 'approved');
  const list = await run('list', p.id, '--month', '2026-11', '--status', 'approved');
  assert.equal(list.text.split('\n').length, 2);
  const slots = await run('slots', p.id, '2026-11');
  assert.match(slots.text, /2026-11: need 7 reel, 3 carousel|2026-11: need/);
  assert.equal((await run('slots', p.id, 'nope')).code, 2);
  const lintOut = await run('lint', p.id);
  assert.equal(lintOut.code, 0);
  assert.match((await run('settings', p.id, '--lead-days', '10', '--auto-build', 'on', '--regions', 'VIC', '--per-month', 'reel=4,carousel=2')).text, /settings saved/);
  const eff = S.effectiveSettings(loadCalendar(p.dir));
  assert.deepEqual([eff.leadDays, eff.autoBuild, eff.regions, eff.perMonth.reel], [10, true, ['VIC'], 4]);
  assert.equal((await run('settings', p.id, '--auto-build', 'maybe')).code, 2);
  const due = await run('due', p.id, '--today', '2026-11-05');
  assert.match(due.text, /build +2026-11-12/);
  assert.match((await run('occasions', p.id, '--from', '2026-11-01', '--to', '2026-11-30')).text, /Melbourne Cup Day/);
  assert.match((await run('prompt', p.id, '--month', '2026-11')).text, /Plan the next posts/);
  assert.match((await run('prompt', p.id, '2026-11-12-first-visit-checklist')).text, /Build the carousel/);
  const dry = await run('run', p.id, '--dry-run', '--today', '2026-11-05');
  assert.match(dry.text, /would build 2026-11-12-first-visit-checklist/);
  assert.equal(loadCalendar(p.dir).items.find((i) => i.id === '2026-11-12-first-visit-checklist').status, 'approved');
  await run('add', p.id, '--date', '2026-11-26', '--format', 'post', '--title', 'Mouthguard season', '--pillar', 'educate', '--idea', 'Fitted mouthguards for winter sport, what a fitting appointment involves.', '--hook', 'Footy season is coming.');
  await run('add', p.id, '--date', '2026-12-02', '--format', 'post', '--title', 'Summer sipping', '--pillar', 'educate', '--idea', 'Keeping teeth happy on hot days when cold drinks are constant.', '--hook', 'Hot day, cold drink.');
  const all = await run('approve', p.id, '--all-ideas', '--month', '2026-11');
  assert.match(all.text, /approved 1 idea/);
  assert.deepEqual(loadCalendar(p.dir).items.filter((i) => i.status === 'idea').map((i) => i.title), ['Summer sipping'], 'only the month asked for');
  assert.match((await run('changes', p.id, '2026-11-26-mouthguard-season', '--comment', 'x')).text, /cannot be sent back for changes/);
  const missing = await run('status', 'no-such-project');
  assert.equal(missing.code, 1);
  assert.match(missing.text, /no Nordle project/i);
});

test('cli: inside one of Claude\'s runs the owner\'s steps are refused', async () => {
  const p = project({ items: [item({ id: 'a', status: 'idea' })] });
  process.env.NORDLE_AGENT_RUN = '1';
  try {
    for (const args of [['approve', p.id, 'a'], ['reject', p.id, 'a'], ['signoff', p.id, 'a'], ['changes', p.id, 'a', '--comment', 'x'], ['settings', p.id, '--auto-build', 'on'], ['approve', p.id, '--all-ideas']]) {
      const r = await run(...args);
      assert.equal(r.code, 3, args.join(' '));
      assert.match(r.text, /Only the owner/);
    }
    assert.equal(loadCalendar(p.dir).items[0].status, 'idea');
    assert.equal((await run('add', p.id, '--date', '2026-11-12', '--format', 'post', '--title', 'x', '--approved')).code, 3);
    assert.equal((await run('add', p.id, '--date', '2026-11-12', '--format', 'post', '--title', 'x', '--delegated')).code, 3);
    // a plain add still works, as an idea
    const ok = await run('add', p.id, '--date', '2026-11-12', '--format', 'post', '--title', 'A plain idea', '--idea', 'Something the audience asks about.', '--hook', 'A question.');
    assert.equal(ok.code, 0, ok.text);
    assert.equal(loadCalendar(p.dir).items.find((i) => i.title === 'A plain idea').status, 'idea');
    // and reading is fine
    assert.equal((await run('status', p.id)).code, 0);
  } finally { delete process.env.NORDLE_AGENT_RUN; }
});

test('cli: schedule-install only prints; it registers nothing and runs nothing', async () => {
  const before = readFileSync(join(ROOT, 'package.json'), 'utf8');
  const r = await run('schedule-install', '--time', '07:30');
  assert.equal(r.code, 0);
  assert.match(r.text, /Nothing has been registered/);
  assert.match(r.text, /schtasks \/Create \/SC DAILY \/ST 07:30 \/TN "Nordle calendar"/);
  assert.match(r.text, /conhost\.exe --headless/);
  assert.match(r.text, /calendar run --all/);
  assert.match(r.text, /schtasks \/Delete/);
  assert.match(r.text, /30 7 \* \* \*/);
  assert.match(r.text, /crontab -e/);
  assert.equal(readFileSync(join(ROOT, 'package.json'), 'utf8'), before);
  assert.equal((await run('schedule-install', '--time', '25:99')).code, 2);
  const one = await run('schedule-install', project().id);
  assert.match(one.text, /calendar run "/);
});

test('cli: run --all goes through every project and respects each one\'s settings', async () => {
  const off = project({ settings: { autoBuild: false }, items: [item({ id: 'x', date: '2026-10-07', status: 'approved' })] });
  const r = await run('run', '--all', '--dry-run', '--today', '2026-10-05');
  assert.match(r.text, new RegExp(`${off.id}: autoBuild is off`));
});
