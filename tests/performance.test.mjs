// The performance loop: numbers in (CSV and by hand), a report that is honest about small numbers, reviews that tune the plan,
// who may do what over HTTP and MCP, and the optional headless review (with a fake Claude: the real one is never started).
// Everything here is fictional (the sample brand and made-up numbers).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../tools/validate.mjs';
import { createNordleServer } from '../src/server/http.mjs';
import { loadCalendar, newCalendar, saveCalendar, validateCalendar } from '../src/calendar/model.mjs';
import * as S from '../src/calendar/service.mjs';
import { NordleClient, NordleError } from '../src/mcp/client.mjs';
import { createTools } from '../src/mcp/tools.mjs';
import { isWeek, lastCompletePeriod, parsePeriod, previousPeriod, weekOf } from '../src/performance/period.mjs';
import { PerformanceError, addManualMetrics, cleanMetrics, loadMetrics, readReview, upsertEntries, validateMetrics } from '../src/performance/model.mjs';
import { HEADER_SYNONYMS, captionSimilarity, importCsvText, mapHeaders, normHeader, parseCsv, parseNumber, parseWhen, samePrefix60 } from '../src/performance/import.mjs';
import { MIN_N, evidenceFor, mannWhitneyP, median, percentileRank, reportFor, reportMarkdown } from '../src/performance/analyze.mjs';
import { captionLengthBucket, classifyHook, coverFace, entryHasFace, hasMusic, reelLengthBucket, seriesOf, timeBucket } from '../src/performance/features.mjs';
import { applyMix, applyReviewPlan, reviewDue, saveReview } from '../src/performance/review.mjs';
import { reviewPrompt } from '../src/performance/prompts.mjs';
import { reviewStep, runReview } from '../src/performance/run.mjs';
import cli from '../src/cli/performance.mjs';
import calendarCli from '../src/cli/calendar.mjs';

const HUMAN = 'human-token-for-performance-tests-0123456789';
const AGENT = 'agent-token-for-performance-tests-0123456789';
const TODAY = '2026-10-20';
let work, projects, runtimeDir, app, base, P;
let n = 0;

// ---- fixtures ----------------------------------------------------------------------------------------------------------------

const PILLARS = [{ id: 'drinks', name: 'The drinks', share: 0.5 }, { id: 'harbour', name: 'The harbour', share: 0.5 }];

/** A copy of the fictional sample brand with a calendar. items: ready-made calendar items; docs: write a minimal document with each item's caption. */
function mk(name, { items = [], settings = {}, docs = false } = {}) {
  const dir = join(projects, name);
  cpSync(join(ROOT, 'samples', 'little-gannet'), dir, { recursive: true, filter: (s) => !/[\\/](out|sources)([\\/]|$)/.test(s) });
  mkdirSync(join(dir, 'docs'), { recursive: true });
  const list = items.map((i) => {
    const { caption, ...item } = i;
    if (docs && caption) {
      writeFileSync(join(dir, 'docs', `${item.id}.json`), JSON.stringify({ schema: 'nordle.doc/0.1', id: item.id, copy: { caption } }));
      item.doc = item.id;
    }
    return item;
  });
  saveCalendar(dir, { ...newCalendar(name), timezone: 'Australia/Melbourne', settings: { pillars: PILLARS, regions: ['VIC'], perMonth: { reel: 4, carousel: 2, post: 2 }, ...settings }, items: list });
  return { id: name, dir };
}
const item = (o) => ({ status: 'posted', pillar: 'drinks', idea: 'x', ...o });

function coffeeItems() {
  return [
    item({ id: '2026-09-02-flat-white-pour', date: '2026-09-02', format: 'reel', title: 'Flat white pour', hook: 'Watch the pour.', caption: 'Watch the pour: a flat white from grind to last sip #coffee' }),
    item({ id: '2026-09-04-spring-menu', date: '2026-09-04', format: 'carousel', title: 'Spring menu', hook: 'Three new pours.', caption: 'Three new pours for spring, one line each. Swipe for the full menu' }),
    item({ id: '2026-09-04-spring-menu-recap', date: '2026-09-04', format: 'post', title: 'Spring menu recap', hook: 'Three new pours.', caption: 'Three new pours for spring, one line each. Swipe for the full menu' }),
    item({ id: '2026-09-09-oat-myth', date: '2026-09-09', format: 'reel', title: 'Oat myth', hook: 'Does oat milk always split?', caption: 'Does oat milk always split in hot coffee? Not if you do this.' }),
    item({ id: '2026-09-18-harbour-sunrise', date: '2026-09-18', format: 'post', title: 'Sunrise', pillar: 'harbour', hook: 'First light.', caption: 'First light over the harbour, and the first batch of the day.', status: 'built' }),
  ];
}

const metricsOf = (i, scale = 1) => ({ reach: Math.round((500 + i * 40) * scale), plays: Math.round((900 + i * 55) * scale), likes: Math.round((30 + (i * 7) % 25) * scale), comments: Math.round((i % 5) * scale), shares: Math.round(((i * 3) % 11) * scale), saves: Math.round(((i * 5) % 13) * scale), completionRate: 0.3 + (i % 5) / 10 });

/** n reels dated 1..n September, all with 7d numbers captured well after. */
async function seedReels(p, count, scale = 1, extra = {}) {
  const items = [];
  for (let i = 0; i < count; i++) items.push(item({ id: `r${String(i + 1).padStart(2, '0')}`, date: `2026-09-${String(i + 1).padStart(2, '0')}`, format: 'reel', title: `Reel ${i + 1}`, hook: i % 2 ? 'Is your latte too hot?' : 'We roast on Tuesdays.', ...extra }));
  const cal = loadCalendar(p.dir);
  cal.items.push(...items);
  saveCalendar(p.dir, cal);
  await upsertEntries(p.dir, items.map((it, i) => ({ post: it.id, platform: 'instagram', window: '7d', capturedAt: '2026-10-05', metrics: metricsOf(i, scale) })), { role: 'human', today: TODAY });
  return items;
}

before(async () => {
  work = mkdtempSync(join(tmpdir(), 'nordle-perf-'));
  projects = join(work, 'projects');
  runtimeDir = join(work, 'runtime');
  mkdirSync(projects, { recursive: true });
  // whatever else happens, a bug in these tests must not be able to start the real Claude
  process.env.NORDLE_CLAUDE_BIN = join(work, 'there-is-no-claude-here');
  process.env.NORDLE_PROJECTS = projects;
  process.env.NORDLE_TODAY = TODAY;
  delete process.env.NORDLE_AGENT_RUN;
  P = mk('perf-cafe', { items: coffeeItems(), docs: true });
  app = createNordleServer({ roots: [projects], token: HUMAN, agentToken: AGENT, runtimeDir });
  base = `http://127.0.0.1:${await app.listen(0)}/api/projects/${P.id}/performance`;
});
after(async () => {
  await app.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  for (const k of ['NORDLE_TODAY', 'NORDLE_PROJECTS', 'NORDLE_CLAUDE_BIN', 'NORDLE_AGENT_RUN']) delete process.env[k];
});

// ---- periods -----------------------------------------------------------------------------------------------------------------

test('periods: ISO weeks (Monday to Sunday), months, and the last complete one', () => {
  assert.equal(weekOf('2026-10-05'), '2026-W41');
  assert.equal(weekOf('2026-01-01'), '2026-W01');
  assert.equal(parsePeriod('2026-W01').from, '2025-12-29', 'ISO week 1 holds 4 January');
  assert.equal(weekOf('2027-01-01'), '2026-W53');
  assert.ok(isWeek('2026-W53') && !isWeek('2026-W54') && !isWeek('2025-W53'));
  assert.deepEqual([parsePeriod('2026-11').from, parsePeriod('2026-11').to, parsePeriod('2026-11').kind], ['2026-11-01', '2026-11-30', 'month']);
  assert.equal(parsePeriod('2026-13'), null);
  assert.equal(parsePeriod('banana'), null);
  assert.equal(lastCompletePeriod('2026-10-20', 'month').id, '2026-09');
  assert.equal(lastCompletePeriod('2026-01-10', 'month').id, '2025-12');
  assert.equal(lastCompletePeriod('2026-10-20', 'week').id, '2026-W42', 'today is Tuesday of W43; the last finished week is W42');
  assert.equal(lastCompletePeriod('2026-10-18', 'week').id, '2026-W41', 'on the Sunday itself the week is not finished yet');
  assert.equal(previousPeriod('2026-W01').id, '2025-W52');
  assert.equal(previousPeriod('2026-01').id, '2025-12');
});

// ---- the metrics file --------------------------------------------------------------------------------------------------------

test('metrics: validation, tidy numbers, one entry per post, platform and window, and who entered it', async () => {
  const p = mk('perf-model', { items: [item({ id: 'a-post', date: '2026-09-01', format: 'post', title: 'A post' })] });
  assert.equal(validateMetrics({ schema: 'nordle.metrics/0.1', brand: 'x', items: [] }).ok, true);
  assert.equal(validateMetrics({ schema: 'nordle.metrics/0.1', brand: 'x', items: [{ post: 'a', platform: 'instagram', capturedAt: '2026-10-01', window: '7d', source: 'csv', metrics: { reach: -1 } }] }).ok, false);
  assert.equal(validateMetrics({ schema: 'nordle.metrics/0.1', brand: 'x', items: [{ post: 'a', platform: 'instagram', capturedAt: '2026-10-01', window: '90d', source: 'csv', metrics: { reach: 1 } }] }).ok, false, 'only 7d, 28d, lifetime');
  const e = { post: 'a', platform: 'instagram', capturedAt: '2026-10-01', window: '7d', source: 'csv', metrics: { reach: 1 } };
  assert.match(validateMetrics({ schema: 'nordle.metrics/0.1', brand: 'x', items: [e, e] }).errors.join(), /duplicate/);

  assert.deepEqual(cleanMetrics({ reach: '1,200', completionRate: '45', likes: 3, saves: '' }).metrics, { reach: 1200, completionRate: 0.45, likes: 3 });
  assert.match(cleanMetrics({ reach: 1, colour: 2 }).errors[0].message, /unknown metric/);
  assert.match(cleanMetrics({ reach: -5 }).errors[0].message, /negative/);
  assert.match(cleanMetrics({}).errors[0].message, /at least one number/);

  const first = await addManualMetrics(p.dir, { post: 'a-post', platform: 'Instagram', window: '7d', metrics: { reach: 100, likes: 7 } }, { role: 'agent', today: TODAY });
  assert.deepEqual([first.replaced, first.entry.by, first.entry.source, first.entry.platform, first.entry.capturedAt], [false, 'claude', 'manual', 'instagram', TODAY]);
  const again = await addManualMetrics(p.dir, { post: 'a-post', platform: 'instagram', window: '7d', metrics: { reach: 150 } }, { role: 'human', today: TODAY });
  assert.deepEqual([again.replaced, again.entry.by], [true, 'owner']);
  assert.equal(loadMetrics(p.dir).items.length, 1, 'a newer capture replaces the older one');
  await addManualMetrics(p.dir, { post: 'a-post', platform: 'instagram', window: 'lifetime', metrics: { reach: 400 } }, { role: 'human', today: TODAY });
  assert.equal(loadMetrics(p.dir).items.length, 2, 'another window is another entry');
  await assert.rejects(addManualMetrics(p.dir, { post: 'no-such-post', platform: 'instagram', metrics: { reach: 1 } }, { today: TODAY }), /no calendar item/);
  await assert.rejects(addManualMetrics(p.dir, { post: 'a-post', platform: 'instagram', metrics: { reach: 1 }, capturedAt: 'yesterday' }), /capturedAt/);
  assert.ok(!existsSync(join(p.dir, '.metrics.lock')));
  assert.deepEqual(readdirSync(p.dir).filter((f) => f.includes('.tmp')), []);
  assert.equal(validateMetrics(loadMetrics(p.dir)).ok, true);
});

// ---- reading an export -------------------------------------------------------------------------------------------------------

test('csv: quotes, newlines inside a cell, other delimiters, a byte-order mark and Excel\'s sep= line', () => {
  const a = parseCsv('\uFEFFPost ID,Description,Reach\r\n1,"Hello, ""world""\nsecond line",1200\r\n2,plain,3\r\n');
  assert.deepEqual(a.rows, [['Post ID', 'Description', 'Reach'], ['1', 'Hello, "world"\nsecond line', '1200'], ['2', 'plain', '3']]);
  assert.equal(parseCsv('a;b;c\n1;2;3').delimiter, ';');
  assert.equal(parseCsv('a\tb\tc\n1\t2\t3').delimiter, '\t');
  assert.deepEqual(parseCsv('sep=;\na;b\n1;2').rows, [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('a,b\n\n1,2\n\n').rows, [['a', 'b'], ['1', '2']], 'blank lines are skipped');
});

test('csv: numbers, percentages and dates the way exports write them', () => {
  assert.equal(parseNumber('1,234'), 1234);
  assert.equal(parseNumber('1.2K'), 1200);
  assert.equal(parseNumber('3M'), 3000000);
  assert.deepEqual(parseNumber('45.5%'), { pct: 45.5 });
  for (const blank of ['', '-', '--', 'N/A', 'n/a', '—']) assert.equal(parseNumber(blank), null, blank);
  assert.equal(parseNumber('1.234,5', { decimalComma: true }), 1234.5);
  assert.equal(parseNumber('abc'), null);

  assert.deepEqual(parseWhen('2026-09-02 18:30'), [{ date: '2026-09-02', time: '18:30', ambiguous: false }]);
  assert.equal(parseWhen('2026-09-02T08:00:00Z', { timezone: 'Australia/Melbourne' })[0].time, '18:00', 'a UTC time becomes the brand\'s local time');
  assert.equal(parseWhen('2026-09-02T22:00:00Z', { timezone: 'Australia/Melbourne' })[0].date, '2026-09-03', '... and may be the next day there');
  const both = parseWhen('03/09/2026 09:15');
  assert.deepEqual(both.map((x) => x.date), ['2026-09-03', '2026-03-09'], 'day-first and month-first are both offered');
  assert.ok(both.every((x) => x.ambiguous));
  assert.equal(parseWhen('15/09/2026')[0].date, '2026-09-15');
  assert.deepEqual(parseWhen('09/15/2026 6:30 PM').map((x) => [x.date, x.time]), [['2026-09-15', '18:30']]);
  assert.equal(parseWhen('03/09/2026', { order: 'mdy' })[0].date, '2026-03-09');
  assert.equal(parseWhen('12 Nov 2026 6:30 pm')[0].time, '18:30');
  assert.equal(parseWhen('Nov 12, 2026')[0].date, '2026-11-12');
  assert.deepEqual(parseWhen('not a date'), []);
  assert.deepEqual(parseWhen('2026-02-31'), []);
});

test('csv: column names are matched case-insensitively against synonyms; units are read from the header; unknown columns are reported', () => {
  assert.equal(normHeader('  Average Watch Time (sec) '), 'average watch time');
  const m = mapHeaders(['POST ID', 'description', 'Publish Time', 'Permalink', 'Post type', 'Views', 'REACH', 'Likes', 'Shares', 'Follows', 'Comments', 'Saves', 'Avg. watch time (ms)', 'Engagement rate', 'Reposts']);
  const by = Object.fromEntries(m.mapped.map((x) => [x.field, x]));
  assert.deepEqual(Object.keys(by).sort(), ['avgWatchSec', 'caption', 'comments', 'follows', 'likes', 'permalink', 'postId', 'published', 'reach', 'saves', 'shares', 'type', 'views']);
  assert.equal(by.avgWatchSec.unit, 0.001, '(ms) is read as milliseconds');
  assert.ok(m.unknown.includes('Engagement rate'));
  assert.ok(m.unknown.some((u) => /Reposts .*second column for shares/.test(u)), 'a second column for the same field is said, not silently merged');
  // the buffer-style names
  const b = mapHeaders(['Post Created', 'Text', 'Post Link', 'Impressions', 'Reactions', 'Clicks', 'Reels Plays', 'Profile Visits']);
  assert.deepEqual(b.mapped.map((x) => x.field).sort(), ['caption', 'impressions', 'linkClicks', 'permalink', 'plays', 'profileVisits', 'published', 'likes'].sort());
  // an override
  const o = mapHeaders(['Weird Reach Thing', 'Likes'], { 'weird reach thing': 'reach' });
  assert.deepEqual(o.mapped.map((x) => x.field).sort(), ['likes', 'reach']);
  assert.ok(Object.values(HEADER_SYNONYMS).flat().every((s) => s === normHeader(s)), 'every synonym is already in its normalised form');
});

test('captions: the first 60 characters, and how alike two openings are', () => {
  assert.ok(samePrefix60('Watch the pour: a flat white from grind to last sip #coffee', 'WATCH THE POUR - a flat white from grind to last sip...'));
  assert.ok(!samePrefix60('Watch the pour', 'Watch the pour'), 'under 25 characters is too short to be sure');
  assert.ok(!samePrefix60('Does oat milk always split in hot coffee?', 'Three new pours for spring, one line each.'));
  assert.ok(captionSimilarity('Does oat milk always split in hot coffee? Not if you do this.', 'does oat milk always split in hot coffee') >= 0.9);
  assert.ok(captionSimilarity('Three new pours', 'Closing early on Friday') < 0.4);
  assert.equal(captionSimilarity('', 'x'), 0);
});

// ---- importing an export -----------------------------------------------------------------------------------------------------

const HEAD = 'Post ID,Account username,Description,Duration (sec),Publish time,Permalink,Post type,Views,Reach,Likes,Shares,Follows,Comments,Saves';
const csvOf = (rows) => `${HEAD}\n${rows.join('\n')}\n`;

test('import: matches by item id, caption and date, reports the ambiguous and the unmatched, and writes nothing on a dry run', async () => {
  const p = mk('perf-import', { items: coffeeItems(), docs: true });
  const csv = csvOf([
    // 1 caption (the first 60 characters) + date; the slash dates are month-first (row 6 proves it)
    '101,littlegannet,"Watch the pour: a flat white from grind to last sip #coffee",31,09/02/2026 08:00,https://ig/p/1,Reel,5400,3100,210,35,6,12,40',
    // 2 a shortened caption one day off: date + openings alike
    '102,littlegannet,"Does oat milk always split in your hot coffee? Not if you do this.",20,09/10/2026 07:30,https://ig/p/2,Reel,2000,1500,90,10,1,4,11',
    // 3 two posts with the very same caption on the same day: cannot be told apart
    '103,littlegannet,"Three new pours for spring, one line each. Swipe for the full menu",,09/04/2026 12:00,https://ig/p/3,Carousel,900,700,60,8,0,3,25',
    // 4 an item id in the link: that is certain
    '104,littlegannet,"Spring menu, again",,09/05/2026 12:00,https://ig/p/4?utm_content=2026-09-04-spring-menu-recap,Image,100,80,9,1,0,0,2',
    // 5 something that is not on the calendar
    '105,littlegannet,"Our new loyalty card is here, ask at the counter",,09/20/2026 09:00,https://ig/p/5,Image,50,40,2,0,0,0,0',
    // 6 proves month-first
    '106,littlegannet,"First light over the harbour, and the first batch of the day.",,09/18/2026 06:00,https://ig/p/6,Image,300,250,30,2,1,5,9',
  ]);
  const r = await importCsvText(p.dir, csv, { today: TODAY, window: '7d', filename: 'meta-export.csv' });
  assert.equal(r.dryRun, true);
  assert.match(r.dateOrder, /month first/);
  assert.equal(r.rows, 6);
  assert.deepEqual(r.matched.map((m) => [m.row, m.item, m.kind]), [
    [2, '2026-09-02-flat-white-pour', 'caption+date'],
    [3, '2026-09-09-oat-myth', 'date+caption'],
    [5, '2026-09-04-spring-menu-recap', 'id'],
    [7, '2026-09-18-harbour-sunrise', 'caption+date'],
  ]);
  assert.equal(r.ambiguous.length, 1, 'the identical captions are not guessed');
  assert.equal(r.ambiguous[0].row, 4);
  assert.deepEqual(r.ambiguous[0].candidates.map((c) => c.item).sort(), ['2026-09-04-spring-menu', '2026-09-04-spring-menu-recap']);
  assert.equal(r.unmatched.length, 1);
  assert.equal(r.unmatched[0].row, 6);
  assert.match(r.unmatched[0].reason, /no post on the calendar/);
  assert.deepEqual(r.matched[0].metrics, { views: 5400, reach: 3100, likes: 210, shares: 35, follows: 6, comments: 12, saves: 40 });
  assert.match(r.matched[3].warnings.join(), /status is "built"/);
  assert.equal(r.matched[2].warnings, undefined, 'a clean match carries no warnings');
  assert.equal(loadMetrics(p.dir).items.length, 0, 'a dry run writes nothing');
  assert.ok(!existsSync(join(p.dir, 'metrics.json')));

  const done = await importCsvText(p.dir, csv, { today: TODAY, window: '7d', yes: true, filename: 'meta-export.csv' });
  assert.deepEqual(done.written, { added: 4, replaced: 0, rejected: 0 });
  const saved = loadMetrics(p.dir).items;
  assert.equal(saved.length, 4);
  const first = saved.find((e) => e.post === '2026-09-02-flat-white-pour');
  assert.deepEqual([first.source, first.window, first.platform, first.capturedAt, first.publishedAt, first.by], ['csv', '7d', 'instagram', TODAY, '2026-09-02T08:00', 'owner']);
  assert.match(first.note, /meta-export\.csv/);
  // importing again replaces, it does not duplicate
  const again = await importCsvText(p.dir, csv, { today: TODAY, window: '7d', yes: true });
  assert.deepEqual(again.written, { added: 0, replaced: 4, rejected: 0 });
  assert.equal(loadMetrics(p.dir).items.length, 4);
  // another window is kept next to it
  await importCsvText(p.dir, csv, { today: TODAY, window: '28d', yes: true });
  assert.equal(loadMetrics(p.dir).items.length, 8);
});

test('import: two rows for one post are reported, never written; a row without numbers is not a match', async () => {
  const p = mk('perf-import-dup', { items: coffeeItems(), docs: true });
  const csv = csvOf([
    '1,x,"Watch the pour: a flat white from grind to last sip #coffee",,2026-09-02 08:00,,Reel,100,90,5,1,0,0,1',
    '2,x,"Watch the pour: a flat white from grind to last sip #coffee",,2026-09-02 08:00,,Reel,200,190,9,2,0,0,2',
    '3,x,"Does oat milk always split in hot coffee? Not if you do this.",,2026-09-09 07:00,,Reel,-,-,-,-,-,-,-',
  ]);
  const r = await importCsvText(p.dir, csv, { today: TODAY, yes: true });
  assert.equal(r.matched.length, 0);
  assert.equal(r.ambiguous.length, 2);
  assert.match(r.ambiguous[0].reason, /both match/);
  assert.match(r.unmatched[0].reason, /no usable numbers/);
  assert.equal(loadMetrics(p.dir).items.length, 0, 'nothing is written when it is not certain');
});

test('import: day-first files, a title line above the header, UTF-16 from Excel, an account filter, --map, and a file that is not an export', async () => {
  const p = mk('perf-import-misc', { items: coffeeItems(), docs: true });
  const csv = `Instagram export;;\nGenerated 2026-10-19;;\nDescription;Publish time;Reach;Likes;Weird thing\n"Does oat milk always split in hot coffee? Not if you do this.";10/09/2026 07:30;"1.234";"56";"7"\n`;
  const r = await importCsvText(p.dir, csv, { today: TODAY, columns: { 'Weird thing': 'saves' } });
  assert.equal(r.delimiter, ';');
  assert.equal(r.matched.length, 1, 'the header row was found below two title lines');
  assert.match(r.dateOrder, /^ambiguous|matched both ways|day|month/i);
  assert.deepEqual(r.matched[0].metrics, { reach: 1234, likes: 56, saves: 7 }, 'a decimal comma is read, and --map named the odd column');
  assert.equal(r.matched[0].itemDate, '2026-09-09', '10/09 was read day-first (10 Sept) because that is the date within a day of the post');
  const dmy = await importCsvText(p.dir, 'Description,Publish time,Reach\n"Watch the pour: a flat white from grind to last sip",25/09/2026 08:00,100\n"Watch the pour: a flat white from grind to last sip",02/09/2026 08:00,100\n', { today: TODAY });
  assert.match(dmy.dateOrder, /day first/);
  const accounts = await importCsvText(p.dir, 'Account username,Description,Publish time,Reach\nother,"Watch the pour: a flat white from grind to last sip",2026-09-02,1\nlittlegannet,"Watch the pour: a flat white from grind to last sip",2026-09-02,2\n', { today: TODAY, account: 'littlegannet' });
  assert.equal(accounts.skipped.length, 1);
  assert.equal(accounts.matched[0].metrics.reach, 2);
  await assert.rejects(importCsvText(p.dir, 'colour,size\nred,big\n', { today: TODAY }), (e) => e instanceof PerformanceError && /no row of column names I recognise/.test(e.message));
  await assert.rejects(importCsvText(p.dir, 'Reach\n1\n', { today: TODAY, window: '90d' }), /window must be/);
});

// ---- the maths ---------------------------------------------------------------------------------------------------------------

test('statistics: percentile with ties counted half, medians, and the rank test', () => {
  assert.equal(percentileRank([1, 2, 3, 4], 4), 0.875);
  assert.equal(percentileRank([5, 5, 5, 5], 5), 0.5);
  assert.equal(percentileRank([1], 1), 0.5);
  assert.equal(percentileRank([], 1), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
  const lo = Array.from({ length: 12 }, (_, i) => 10 + i), hi = Array.from({ length: 12 }, (_, i) => 60 + i);
  assert.ok(mannWhitneyP(lo, hi) < 0.001);
  assert.ok(mannWhitneyP(lo, lo.map((x) => x + 0.5)) > 0.5, 'nearly the same lists look the same');
  assert.equal(mannWhitneyP([], [1]), 1);
  assert.equal(mannWhitneyP([4, 4, 4], [4, 4, 4]), 1, 'all ties: no difference');
});

test('evidence labels: fewer than 5 is directional, and only a clear gap on enough posts is "stronger"', () => {
  assert.equal(MIN_N, 5);
  const lows = [10, 12, 14, 16, 18, 11, 13, 15, 17, 19, 12, 14], highs = [60, 62, 64, 66, 68, 61, 63, 65, 67, 69, 62, 64];
  assert.equal(evidenceFor([50, 60, 70], lows).level, 'directional');
  assert.match(evidenceFor([50, 60, 70], lows).note, /directional only \(n=3\)/);
  assert.equal(evidenceFor(lows, [50, 60]).level, 'directional', 'and so is a comparison with only two others');
  assert.equal(evidenceFor(highs, lows).level, 'stronger');
  assert.equal(evidenceFor(highs.slice(0, 6), lows.slice(0, 6)).level, 'suggestive', 'a clear gap on 6 against 6 is only suggestive');
  assert.equal(evidenceFor(lows, lows.map((x) => x + 1)).level, 'none');
});

// ---- scoring and segments ----------------------------------------------------------------------------------------------------

test('scores are relative to the account itself: a small account and a big one with the same shape score the same', async () => {
  const small = mk('perf-small');
  const big = mk('perf-big');
  await seedReels(small, 12, 1);
  await seedReels(big, 12, 400);
  const a = reportFor(small.dir, '2026-09', { today: TODAY }), b = reportFor(big.dir, '2026-09', { today: TODAY });
  assert.equal(a.posts.length, 12);
  assert.deepEqual(a.posts.map((x) => x.score), b.posts.map((x) => x.score));
  assert.ok(a.posts.every((x) => x.score >= 0 && x.score <= 100));
  assert.ok(Math.abs(a.headline.medianScore - 50) < 15, 'the median post sits near 50');
  const top = a.top[0];
  assert.equal(top.rank, 1);
  assert.ok(top.score >= a.posts.reduce((m, x) => Math.max(m, x.score), 0) - 1e-9);
  assert.ok(a.top.every((t) => !a.bottom.some((b2) => b2.id === t.id)), 'top and bottom never overlap');
  assert.ok(a.bottom.length && a.bottom[0].score <= a.top.at(-1).score);
  assert.ok(top.headline.ratio > 1, 'the best reel beat the account\'s typical plays');
  assert.ok(top.scoreBasis.parts.every((x) => x.pct === null || (x.pct >= 0 && x.pct <= 1)));
  assert.deepEqual(a.top[0].scoreBasis.parts.map((x) => x.id), ['audience', 'watch', 'shares', 'saves'], 'a reel is judged on plays, watching, shares and saves');
  assert.match(reportMarkdown(a), /how the posts did, September 2026/);
});

test('reports flag what is thin: small groups are directional, small history says so, numbers taken too early are left out', async () => {
  const p = mk('perf-thin');
  await seedReels(p, 4, 1);
  const r = reportFor(p.dir, '2026-09', { today: TODAY });
  assert.ok(r.gaps.some((g) => g.kind === 'small-baseline' && g.format === 'reel'), 'only 4 reels in the whole history');
  assert.ok(r.posts.every((x) => x.scoreBasis.lowBaseline));
  const hook = r.segments.hookType.groups;
  assert.ok(hook.length >= 1 && hook.every((g) => g.evidence.level === 'directional' && g.n < MIN_N));
  assert.match(reportMarkdown(r), /directional only/);
  assert.match(r.caveats.join(' '), /not what caused it/);

  // a post measured two days after publishing cannot be judged by a 7-day window
  const cal = loadCalendar(p.dir);
  cal.items.push(item({ id: 'young', date: '2026-09-25', format: 'reel', title: 'Young', hook: 'x' }), item({ id: 'silent', date: '2026-09-26', format: 'reel', title: 'No numbers yet', hook: 'x' }));
  saveCalendar(p.dir, cal);
  await upsertEntries(p.dir, [{ post: 'young', platform: 'instagram', window: '7d', capturedAt: '2026-09-27', metrics: { plays: 5000, reach: 4000 } }], { role: 'human', today: TODAY });
  const r2 = reportFor(p.dir, '2026-09', { today: TODAY });
  const young = r2.posts.find((x) => x.id === 'young');
  assert.equal(young.mature, false);
  assert.equal(young.score, null);
  assert.match(young.scoreBasis.reason, /2 days after publishing/);
  assert.ok(r2.gaps.some((g) => g.kind === 'too-early' && g.posts.includes('young')));
  assert.ok(r2.gaps.some((g) => g.kind === 'no-numbers' && g.posts.includes('silent')), 'a posted item with no numbers is named');
  assert.equal(r2.counts.missingNumbers, 1);

  // only a lifetime figure: used, but said so, and compared only with other lifetime figures
  await upsertEntries(p.dir, [{ post: 'silent', platform: 'instagram', window: 'lifetime', capturedAt: '2026-10-19', metrics: { plays: 700, reach: 600 } }], { role: 'human', today: TODAY });
  const r3 = reportFor(p.dir, '2026-09', { today: TODAY });
  const silent = r3.posts.find((x) => x.id === 'silent');
  assert.equal(silent.window, 'lifetime');
  assert.ok(r3.gaps.some((g) => g.kind === 'other-window' && g.posts.includes('silent')));
  assert.equal(r3.posts.find((x) => x.id === 'r01').window, '7d');

  // an empty period says so instead of inventing something
  const empty = reportFor(p.dir, '2026-07', { today: TODAY });
  assert.equal(empty.counts.observations, 0);
  assert.ok(empty.gaps.some((g) => g.kind === 'nothing'));
  assert.equal(empty.headline.medianScore, null);
  assert.throws(() => reportFor(p.dir, 'last-month', { today: TODAY }), /not a period/);
  assert.throws(() => reportFor(p.dir, '2026-09', { today: TODAY, window: '90d' }), /window must be/);
});

test('the report says when numbers were typed by Claude, and when a post with numbers is not marked posted; a review needs numbers, not a status', async () => {
  const p = mk('perf-marks', { settings: { review: { cadence: 'monthly' } }, items: [item({ id: 'unmarked', date: '2026-09-05', format: 'post', title: 'Unmarked', status: 'built' }), item({ id: 'typed', date: '2026-09-06', format: 'post', title: 'Typed' })] });
  await addManualMetrics(p.dir, { post: 'unmarked', platform: 'instagram', window: '7d', capturedAt: '2026-10-01', metrics: { reach: 100, likes: 5 } }, { role: 'human', today: TODAY });
  await addManualMetrics(p.dir, { post: 'typed', platform: 'instagram', window: '7d', capturedAt: '2026-10-01', metrics: { reach: 120, likes: 9 } }, { role: 'agent', today: TODAY });
  const r = reportFor(p.dir, '2026-09', { today: TODAY });
  assert.deepEqual(r.gaps.find((g) => g.kind === 'typed-by-claude').posts, ['typed']);
  assert.deepEqual(r.gaps.find((g) => g.kind === 'not-marked-posted').posts, ['unmarked']);
  const due = reviewDue(p.dir, TODAY);
  assert.equal(due.numbers.withNumbers, 2, 'both have numbers, whatever the calendar says about them');
  assert.equal(due.numbers.published, 1);
});

test('segments: a real gap on enough posts is called stronger, never causal; weekday, hook, pillar and format all group', async () => {
  const p = mk('perf-seg');
  const items = [], entries = [];
  for (let i = 0; i < 24; i++) {
    const q = i % 2 === 0;
    const id = `s${String(i + 1).padStart(2, '0')}`;
    items.push(item({ id, date: `2026-09-${String(i + 1).padStart(2, '0')}`, format: 'post', title: `Post ${i + 1}`, hook: q ? 'Is your coffee too hot?' : 'Fresh beans today.', pillar: q ? 'drinks' : 'harbour', occasion: i < 3 ? 'Melbourne Cup' : undefined }));
    entries.push({ post: id, platform: 'instagram', window: '7d', capturedAt: '2026-10-10', metrics: q ? { reach: 1000 + i * 10, likes: 100 + i, comments: 10 + (i % 3) } : { reach: 300 + i * 10, likes: 20 + i, comments: 1 } });
  }
  const cal = loadCalendar(p.dir);
  cal.items.push(...items);
  saveCalendar(p.dir, cal);
  await upsertEntries(p.dir, entries, { role: 'human', today: TODAY });
  const r = reportFor(p.dir, '2026-09', { today: TODAY });
  const hook = Object.fromEntries(r.segments.hookType.groups.map((g) => [g.key, g]));
  assert.equal(hook.question.n, 12);
  assert.equal(hook.statement.n, 12);
  assert.ok(hook.question.median > hook.statement.median + 30);
  assert.equal(hook.question.evidence.level, 'stronger');
  assert.match(hook.question.evidence.note, /not proof of cause/);
  assert.equal(r.segments.pillar.groups[0].key, 'drinks');
  assert.equal(r.segments.format.groups.length, 1);
  assert.equal(r.segments.format.comparable, false, 'one format only: nothing to compare');
  assert.equal(r.segments.occasion.groups.find((g) => g.key === 'occasion').evidence.level, 'directional', '3 occasion posts is directional');
  assert.ok(r.segments.weekday.groups.every((g) => g.n <= 4), 'a month spreads over the weekdays');
  assert.ok(r.segments.face.unknown === 24 && r.segments.face.groups.length === 0, 'with no catalog the face is unknown, not guessed');
  assert.ok(r.gaps.some((g) => g.kind === 'no-catalog'));
  assert.deepEqual(r.segmentsAll.hookType.groups.map((g) => g.key).sort(), r.segments.hookType.groups.map((g) => g.key).sort());
  const md = reportMarkdown(r);
  assert.match(md, /question: median .*n=12.*stronger/);
  assert.match(md, /Read this with care/);
});

test('a previous period gives the comparison, and the last review is carried into the report', async () => {
  const p = mk('perf-follow');
  await seedReels(p, 12, 1);
  const cal = loadCalendar(p.dir);
  for (let i = 0; i < 6; i++) cal.items.push(item({ id: `o${i}`, date: `2026-10-${String(i + 1).padStart(2, '0')}`, format: 'reel', title: `Oct ${i}`, hook: 'x', pillar: i < 5 ? 'harbour' : 'drinks' }));
  saveCalendar(p.dir, cal);
  await upsertEntries(p.dir, Array.from({ length: 6 }, (_, i) => ({ post: `o${i}`, platform: 'instagram', window: '7d', capturedAt: '2026-10-19', metrics: metricsOf(i + 3, 2) })), { role: 'human', today: TODAY });
  await saveReview(p.dir, { period: '2026-09', markdown: '## What worked\nThings.', directions: [{ kind: 'do-more', text: 'More harbour posts', confidence: 'low' }], mix: { pillars: { drinks: 0.3, harbour: 0.7 } } }, { role: 'human' });
  const r = reportFor(p.dir, '2026-10', { today: TODAY });
  assert.equal(r.headline.previousPeriod, '2026-09');
  assert.ok(r.headline.previousMedianScore !== null);
  assert.equal(r.followUp.review, '2026-09');
  assert.equal(r.followUp.directions[0].text, 'More harbour posts');
  assert.equal(r.followUp.since.items, 6);
  assert.ok(r.followUp.since.pillarShare.harbour > 0.8);
  assert.match(reportMarkdown(r), /Since the last review \(2026-09\)/);
});

// ---- what a post is ----------------------------------------------------------------------------------------------------------

test('features: hook rules in a fixed order, buckets, music, series and the face on the cover', () => {
  const t = (s) => classifyHook(s).type;
  assert.equal(t('How to pour a heart'), 'how-to');
  assert.equal(t('5 things your barista wishes you knew'), 'number');
  assert.equal(t('3 am coffee run?'), 'question', 'a time of day is not a list');
  assert.equal(t('Myth: oat milk always splits'), 'myth');
  assert.equal(t('Meet Sam, our roaster'), 'behind-the-scenes');
  assert.equal(t('Now open on Sundays'), 'announcement');
  assert.equal(t('Is your latte too hot?'), 'question');
  assert.equal(t('We roast on Tuesdays.'), 'statement');
  assert.equal(t('How much milk is too much?'), 'question', '"how much" is a question, not a how-to');
  assert.equal(classifyHook('').type, null);
  assert.ok(classifyHook('Myth: x').rule.length > 10, 'the rule is named so the report can show it');
  assert.equal(captionLengthBucket('x'.repeat(100)), 'short (under 150 characters)');
  assert.equal(captionLengthBucket('x'.repeat(300)), 'medium (150 to 400)');
  assert.equal(captionLengthBucket('x'.repeat(500)), 'long (over 400)');
  assert.equal(captionLengthBucket(''), null);
  assert.equal(reelLengthBucket(12), 'under 15 s');
  assert.equal(reelLengthBucket(45), '30 to 60 s');
  assert.equal(reelLengthBucket(null), null);
  assert.equal(timeBucket('08:30'), 'morning (before 11)');
  assert.equal(timeBucket('12:00'), 'midday (11 to 2)');
  assert.equal(timeBucket('19:15'), 'evening (6 on)');
  assert.equal(timeBucket(undefined), null);

  const reel = { kind: 'video', sources: [{ id: 'v', type: 'video', path: 'sources/a.mp4' }, { id: 'm', type: 'audio', path: 'sources/m.wav' }], timeline: { duration: 20, tracks: [{ id: 'v1', type: 'video', clips: [{ id: 'c2', source: 'v', at: 4 }, { id: 'c1', source: 'v', at: 0 }] }, { id: 'a1', type: 'audio', clips: [{ id: 'bed', source: 'm', at: 0 }] }] } };
  assert.equal(hasMusic(reel), true);
  assert.equal(hasMusic({ ...reel, timeline: { ...reel.timeline, tracks: [reel.timeline.tracks[0], { ...reel.timeline.tracks[1], mute: true }] } }), false);
  assert.equal(hasMusic(null), null);
  assert.equal(hasMusic({ kind: 'carousel' }), null);
  assert.equal(seriesOf({ title: 'Meet the team: Sam' }, null), 'Meet the team');
  assert.equal(seriesOf({ title: 'Plain', hook: 'Meet Dr Lee' }, null), 'Meet the team');
  assert.equal(seriesOf({ title: 'Plain' }, { tags: ['series:Behind the roast'] }), 'Behind the roast');
  assert.equal(seriesOf({ title: 'Plain' }, null), null);

  assert.equal(entryHasFace({ shows: 'Sam smiling at the machine', tags: [] }), true);
  assert.equal(entryHasFace({ shows: 'A close shot of the espresso machine', tags: ['machine'] }), false);
  assert.equal(entryHasFace({ shows: 'Beans in a hopper', people: ['Sam'] }), true);
  assert.equal(entryHasFace(undefined), null);
  const dir = mkdtempSync(join(work, 'cat-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'catalog.json'), JSON.stringify({ items: { 'assets/sam.jpg': { shows: 'Sam smiling at the machine' }, 'assets/beans.jpg': { shows: 'Beans in a hopper' } } }));
  const carousel = (src) => ({ pages: [{ id: 'cover', layers: [{ type: 'image', src }] }] });
  assert.equal(coverFace(dir, carousel('assets/sam.jpg'), {}).face, true);
  assert.equal(coverFace(dir, carousel('assets/beans.jpg'), {}).face, false);
  assert.equal(coverFace(dir, carousel('assets/not-catalogued.jpg'), {}).face, null);
  assert.equal(coverFace(dir, null, { external: { cover: 'assets/sam.jpg' } }).face, true);
  assert.equal(coverFace(dir, null, {}).face, null);
});

// ---- when a review is due ----------------------------------------------------------------------------------------------------

test('review due: needs a rhythm; waits until the period\'s posts are a week old; weekly on the chosen weekday; done once saved; says if numbers are missing', async () => {
  const p = mk('perf-due', { items: [item({ id: 'sep-1', date: '2026-09-05', format: 'post', title: 'A' }), item({ id: 'sep-2', date: '2026-09-12', format: 'post', title: 'B' })] });
  assert.equal(reviewDue(p.dir, '2026-10-02').configured, false);
  assert.match(reviewDue(p.dir, '2026-10-02').message, /--review monthly/);
  await S.setSettings(p.dir, { review: { cadence: 'monthly' } });
  assert.equal(reviewDue(p.dir, '2026-10-06').period, '2026-08', 'the last September post is not yet a week old, so September is not due');
  const d = reviewDue(p.dir, '2026-10-07');
  assert.deepEqual([d.configured, d.due, d.period, d.dueDate, d.autoReview], [true, true, '2026-09', '2026-10-07', false]);
  assert.deepEqual([d.numbers.published, d.numbers.withNumbers, d.numbers.missing], [2, 0, ['sep-1', 'sep-2']]);
  assert.match(d.message, /monthly review of September 2026 is due/);
  assert.match(d.message, /Add the missing numbers first/);
  assert.equal(reviewDue(p.dir, '2026-09-30').period, '2026-08', 'before the month ends, the month before is the one to review');
  await upsertEntries(p.dir, [{ post: 'sep-1', platform: 'instagram', window: '7d', capturedAt: '2026-10-07', metrics: { reach: 10 } }], { role: 'human', today: '2026-10-07' });
  assert.equal(reviewDue(p.dir, '2026-10-07').numbers.withNumbers, 1);
  await saveReview(p.dir, { period: '2026-09', markdown: '## What worked\nNot much to say yet, the data is thin.' }, { role: 'human' });
  const done = reviewDue(p.dir, '2026-10-09');
  assert.deepEqual([done.due, done.reviewed, done.lastReview], [false, true, '2026-09']);
  assert.match(done.message, /is done/);
  assert.equal(reviewDue(p.dir, '2026-11-07').period, '2026-10', 'and the next month comes round');

  await S.setSettings(p.dir, { review: { cadence: 'weekly', weekday: 'wednesday' } });
  assert.equal(reviewDue(p.dir, '2026-10-12').period, '2026-W39', 'Monday: week 40\'s posts are a week old only from the 11th and its review falls on a Wednesday, so week 39 is the latest due');
  const wed = reviewDue(p.dir, '2026-10-14');
  assert.deepEqual([wed.period, wed.dueDate, wed.kind], ['2026-W40', '2026-10-14', 'week']);
  await S.setSettings(p.dir, { review: { cadence: 'weekly' } });
  assert.equal(reviewDue(p.dir, '2026-10-12').period, '2026-W40', 'the default weekday is Monday');
  await S.setSettings(p.dir, { review: null });
  assert.equal(reviewDue(p.dir, '2026-10-12').configured, false);
  await assert.rejects(S.setSettings(p.dir, { review: { cadence: 'daily' } }), /not valid/);
  assert.equal(validateCalendar(loadCalendar(p.dir)).ok, true);
});

// ---- the plan changes a review may make --------------------------------------------------------------------------------------

function planProject(name, settings = {}) {
  return mk(name, {
    settings,
    items: [
      { id: 'idea-1', date: '2026-10-28', format: 'reel', title: 'Idea one', status: 'idea', pillar: 'drinks', idea: 'Pour a flat white from grind to sip.', hook: 'Watch the pour.' },
      { id: 'appr-1', date: '2026-10-29', format: 'carousel', title: 'Approved one', status: 'approved', pillar: 'drinks', idea: 'Three pours, one line each.', hook: 'Three new pours.', ideaApproval: 'owner' },
      { id: 'appr-del', date: '2026-10-27', format: 'reel', title: 'Delegated one', status: 'approved', ideaApproval: 'delegated', pillar: 'drinks', idea: 'Roast day at the harbour shop.', hook: 'Roast day.' },
      { id: 'built-1', date: '2026-10-30', format: 'post', title: 'Built one', status: 'built', doc: 'built-1', pillar: 'harbour', idea: 'Sunrise at the harbour.', hook: 'First light.' },
      { id: 'past-1', date: '2026-10-10', format: 'post', title: 'Past one', status: 'approved', pillar: 'harbour', idea: 'Old.', hook: 'Old hook.' },
      { id: 'done-1', date: '2026-10-31', format: 'post', title: 'Posted one', status: 'posted', pillar: 'harbour', idea: 'Done.', hook: 'Done hook.' },
    ],
  });
}

test('plan changes go through the calendar service: ideas arrive as ideas, an approved item goes back for a yes, built and past items are never touched', async () => {
  const p = planProject('perf-plan');
  const r = await applyReviewPlan(p.dir, {
    ideas: [{ date: '2026-11-04', format: 'reel', title: 'The oat milk test', pillar: 'drinks', idea: 'Same flat white three ways, with the barista saying what they watch for.', hook: 'Which milk wins?', mediaPlan: 'the pour clip' }, { date: '2026-11-05', format: 'reel', title: 'Guaranteed best coffee', pillar: 'drinks', idea: 'Our guaranteed best coffee.', hook: 'World\'s best coffee.' }],
    amend: [
      { item: 'idea-1', set: { hook: 'Watch the pour, then taste it.' }, because: 'questions beat statements' },
      { item: 'appr-1', set: { hook: 'Which of the three new pours would you try?' }, because: 'questions did better' },
      { item: 'built-1', set: { hook: 'Changed anyway' } },
      { item: 'past-1', set: { hook: 'Too late' } },
      { item: 'done-1', set: { hook: 'Too late' } },
      { item: 'idea-1', set: { date: '2026-12-01' } },
      { item: 'no-such-item', set: { hook: 'x' } },
    ],
  }, { role: 'agent', today: '2026-10-20' });
  assert.deepEqual(r.ideas.added.map((i) => [i.title, i.status]), [['The oat milk test', 'idea']]);
  assert.equal(r.ideas.refused.length, 1);
  assert.match(r.ideas.refused[0].reasons.join(), /guaranteed/i);
  const cal = loadCalendar(p.dir);
  const byId = Object.fromEntries(cal.items.map((i) => [i.id, i]));
  assert.equal(byId['idea-1'].hook, 'Watch the pour, then taste it.');
  assert.equal(byId['appr-1'].hook, 'Which of the three new pours would you try?');
  assert.equal(byId['appr-1'].status, 'idea', 'the owner approved the old hook, not this one');
  assert.equal(r.amended.find((a) => a.item === 'appr-1').sentBackToIdea, true);
  assert.equal(r.amended.find((a) => a.item === 'idea-1').sentBackToIdea, false);
  assert.equal(byId['built-1'].hook, 'First light.');
  assert.equal(byId['past-1'].hook, 'Old hook.');
  assert.equal(byId['done-1'].hook, 'Done hook.');
  assert.deepEqual(r.skipped.map((s) => s.item).sort(), ['built-1', 'done-1', 'idea-1', 'no-such-item', 'past-1'].sort());
  assert.match(r.skipped.find((s) => s.item === 'built-1').reason, /never changed by a review/);
  assert.match(r.skipped.find((s) => s.item === 'past-1').reason, /date has passed/);
  assert.equal(byId['idea-1'].date, '2026-10-28', 'a review does not move dates');
  assert.equal(validateCalendar(cal).ok, true);
});

test('delegated approval: new ideas arrive approved and delegated items stay approved; what the owner approved personally still goes back', async () => {
  const p = planProject('perf-plan-delegated', { ideaApproval: 'delegated' });
  const r = await applyReviewPlan(p.dir, { ideas: [{ date: '2026-11-04', format: 'reel', title: 'Cold brew steeping', pillar: 'drinks', idea: 'How the cold brew steeps overnight in the back room.', hook: 'Cold brew, slowly.' }], amend: [{ item: 'appr-del', set: { hook: 'Roast day, start to finish.' } }, { item: 'appr-1', set: { hook: 'Which pour would you try?' } }] }, { role: 'agent', today: '2026-10-20' });
  assert.equal(r.ideas.added[0].status, 'approved');
  const byId = Object.fromEntries(loadCalendar(p.dir).items.map((i) => [i.id, i]));
  assert.equal(byId['appr-del'].status, 'approved');
  assert.equal(byId['appr-1'].status, 'idea', 'the owner approved that one with their own hand');
  assert.deepEqual(r.amended.map((a) => a.sentBackToIdea), [false, true]);
  const saved = await saveReview(p.dir, { period: '2026-09', markdown: '## What worked\nNot much data, so this is a small review.', plan: { amend: [{ item: 'appr-del', set: { hook: 'Roast day, again.' } }] } }, { role: 'agent', today: '2026-10-20' });
  assert.match(saved.review.markdown, /still approved: approval was delegated for it/);
});

test('saving a review: the text, three to five directions, what really happened to the calendar, and the mix kept for the owner', async () => {
  const p = planProject('perf-save');
  await assert.rejects(saveReview(p.dir, { period: 'soon', markdown: '## What worked\nsomething long enough to count' }), /not a period/);
  await assert.rejects(saveReview(p.dir, { period: '2026-09', markdown: 'short' }), /empty/);
  await assert.rejects(saveReview(p.dir, { period: '2026-09', markdown: '## What worked\nsomething long enough to count', directions: [{ kind: 'maybe', text: 'x'.repeat(10) }] }), /kind must be/);
  await assert.rejects(saveReview(p.dir, { period: '2026-09', markdown: '## What worked\nsomething long enough to count', mix: { pillars: { nonsense: 1 } } }), /not a pillar/);
  await assert.rejects(saveReview(p.dir, { period: '2026-09', markdown: '## What worked\nsomething long enough to count', mix: { pillars: { drinks: 0.2, harbour: 0.2 } } }), /add up/);

  const text = '## What worked\nQuestion hooks went with a higher score (n=12 vs 12).\n\n## What did not\nStatements.\n';
  const r = await saveReview(p.dir, {
    period: '2026-09', markdown: text,
    directions: [{ kind: 'do-more', text: 'Open with a question', evidence: '12 vs 12, +40 points', confidence: 'medium' }, { kind: 'test', text: 'Two reels with a face on the cover' }],
    mix: { pillars: { drinks: 0.6, harbour: 0.4 }, formats: { carousel: 2, post: 1 } },
    plan: { amend: [{ item: 'appr-1', set: { hook: 'Which pour would you try?' }, because: 'questions did better' }, { item: 'built-1', set: { hook: 'nope' } }] },
  }, { role: 'agent', today: '2026-10-20' });
  assert.match(r.warnings.join(), /three to five directions; this has 2/);
  const saved = readReview(p.dir, '2026-09');
  assert.match(saved.markdown, /^## What worked/);
  assert.match(saved.markdown, /## What was changed in the calendar/);
  assert.match(saved.markdown, /Changed appr-1: hook \(it was approved and is back to "idea": it needs your yes again\)\. Why: questions did better/);
  assert.match(saved.markdown, /Left alone built-1: it is built/);
  assert.deepEqual([saved.meta.by, saved.meta.mix.pillars, saved.meta.directions.length, saved.meta.changes.amended], ['claude', { drinks: 0.6, harbour: 0.4 }, 2, ['appr-1']]);
  // saving again replaces, and the changes block is not stacked
  await saveReview(p.dir, { period: '2026-09', markdown: saved.markdown, directions: saved.meta.directions }, { role: 'agent', today: '2026-10-20' });
  assert.equal((readReview(p.dir, '2026-09').markdown.match(/What was changed in the calendar/g) ?? []).length, 0, 'a re-save without a plan carries no stale block');
  assert.deepEqual(readdirSync(join(p.dir, 'reviews')).sort(), ['2026-09.json', '2026-09.md']);

  // the owner applies a mix; settings are theirs
  await saveReview(p.dir, { period: '2026-08', markdown: '## What worked\nA thin month, mostly counting.', mix: { pillars: { drinks: 0.7, harbour: 0.3 } } }, { role: 'agent', today: '2026-10-20' });
  const applied = await applyMix(p.dir, '2026-08');
  assert.deepEqual(applied.settings.pillars.map((x) => [x.id, x.share, x.name]), [['drinks', 0.7, 'The drinks'], ['harbour', 0.3, 'The harbour']]);
  assert.ok(readReview(p.dir, '2026-08').meta.mixAppliedAt);
  await assert.rejects(applyMix(p.dir, '2026-07'), /no review/);
  await assert.rejects(applyMix(p.dir, '2026-09'), /no review|no pillar mix/, 'the replaced review has no mix');
});

// ---- the prompt --------------------------------------------------------------------------------------------------------------

test('the review prompt: the numbers, the rules of evidence, the last review, which upcoming items are open, and what to save', async () => {
  const p = planProject('perf-prompt', { review: { cadence: 'monthly' } });
  await seedReels(p, 8, 1);
  await saveReview(p.dir, { period: '2026-08', markdown: '## What worked\nA first look, with very little data behind it.', directions: [{ kind: 'test', text: 'Try a question hook', confidence: 'low' }], mix: { pillars: { drinks: 0.6, harbour: 0.4 } } }, { role: 'human' });
  const text = reviewPrompt(p.dir, '2026-09', { today: TODAY });
  assert.match(text, /^# Review the numbers: Little Gannet Coffee \(project "perf-prompt"\), September 2026/);
  for (const must of [
    'nordle_performance_save_review', 'nordle_performance_report', '## What worked', '## Directions', '## Mix for next month', '## Data gaps',
    'fewer than 5 posts is **directional only**', 'Say "went with", never "caused"', 'Never invent', 'p under 0.05',
    'Median score', "Last review's directions", 'Try a question hook', 'drinks 60%',
    'idea-1', 'OPEN: you may amend', 'LOCKED: leave alone', 'are never changed', 'back to "idea"',
    'You cannot change the settings', 'Monthly quota',
  ]) assert.ok(text.includes(must), `the prompt should say: ${must}`);
  assert.ok(/appr-1 \| 2026-10-29[^\n]*OPEN/.test(text), 'an approved, unbuilt item is open');
  assert.ok(/built-1 \| 2026-10-30[^\n]*LOCKED/.test(text), 'a built one is locked');
  assert.ok(!/past-1/.test(text), 'past items are not listed');
  assert.ok(!text.includes('AHPRA'), 'a coffee shop is not given the health rules');
  assert.ok(!/Facts you may rely on[\s\S]*\bC:\\|K:\\/.test(text), 'no local paths');
  assert.ok(text.length < 24000, 'compact enough to be read in one go');
  assert.match(reviewPrompt(p.dir, undefined, { today: TODAY }), /September 2026/, 'the default is the last complete month');

  await S.setSettings(p.dir, { compliance: ['ahpra'], ideaApproval: 'delegated' });
  const health = reviewPrompt(p.dir, '2026-09', { today: TODAY });
  assert.match(health, /Health advertising/);
  assert.match(health, /performance never overrides the health-advertising rules/);
  assert.match(health, /approval is delegated for this brand/);
  assert.match(health, /stay approved/);
});

// ---- the optional headless review --------------------------------------------------------------------------------------------

function fakeClaude(behave) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let prompt = '';
    child.stdin = { on() {}, end(text) { prompt = String(text ?? ''); } };
    child.kill = () => { setImmediate(() => child.emit('close', null, 'SIGKILL')); };
    const call = { cmd, args, opts, get prompt() { return prompt; } };
    calls.push(call);
    setImmediate(async () => {
      const code = await behave(call);
      if (code === 'hang') return;
      child.stdout.emit('data', JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Reviewed.', num_turns: 5, total_cost_usd: 0.2 }));
      child.emit('close', code ?? 0, null);
    });
    return child;
  };
  return { spawn, calls };
}
const noExec = { exec: async () => ({ code: 0, stdout: '', stderr: '' }) };

test('headless review: off unless autoReview is on; never starts without numbers; read tools only; the review file decides success', async () => {
  const p = planProject('perf-run', { review: { cadence: 'monthly' } });
  await seedReels(p, 6, 1);
  const f = fakeClaude(async (call) => { writeFileSync(join(p.dir, 'reviews-probe.txt'), 'x'); void call; return 0; });

  const off = await runReview({ projectDir: p.dir, today: TODAY, spawn: f.spawn, ...noExec });
  assert.equal(off.enabled, false);
  assert.match(off.reason, /autoReview is off/);
  assert.equal(f.calls.length, 0, 'nothing started');
  const step = await reviewStep(p.dir, { today: TODAY, spawn: f.spawn, ...noExec });
  assert.match(step.lines[0], /review of September 2026 is due/);
  assert.equal(f.calls.length, 0, '`calendar run` only mentions it');

  await S.setSettings(p.dir, { review: { cadence: 'monthly', autoReview: true } });
  const dry = await runReview({ projectDir: p.dir, today: TODAY, dryRun: true, spawn: f.spawn, ...noExec });
  assert.equal(dry.dryRun.length, 1);
  assert.ok(dry.dryRun[0].command.includes('--allowedTools'));
  const tools = dry.dryRun[0].command.slice(dry.dryRun[0].command.indexOf('--allowedTools') + 1);
  assert.deepEqual(tools, ['mcp__nordle', 'Read', 'Glob', 'Grep'], 'no Bash, no Write');
  assert.equal(f.calls.length, 0);

  const failed = await runReview({ projectDir: p.dir, today: TODAY, spawn: f.spawn, ...noExec });
  assert.equal(failed.ran[0].outcome, 'failed', 'Claude finished without saving a review');
  assert.match(failed.ran[0].error, /without saving a review/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].opts.env.NORDLE_AGENT_RUN, '1');
  assert.equal(f.calls[0].opts.windowsHide, true);
  assert.equal(f.calls[0].cmd, process.env.NORDLE_CLAUDE_BIN);
  assert.match(f.calls[0].prompt, /Review the numbers: Little Gannet Coffee/);
  assert.ok(!existsSync(join(p.dir, '.calendar-run.lock')), 'the run lock is released');
  assert.ok(readdirSync(join(p.dir, 'history', 'calendar-runs')).some((x) => /review/.test(x)), 'the run is logged');

  const good = fakeClaude(async () => { await saveReview(p.dir, { period: '2026-09', markdown: '## What worked\nA first review written by the fake.' }, { role: 'agent', today: TODAY }); return 0; });
  const ok = await runReview({ projectDir: p.dir, today: TODAY, spawn: good.spawn, ...noExec });
  assert.equal(ok.ran[0].outcome, 'reviewed');
  const next = await reviewStep(p.dir, { today: TODAY, spawn: good.spawn, ...noExec });
  assert.deepEqual(next.lines, [], 'done: nothing more to say');
  assert.equal(good.calls.length, 1, 'and it does not run twice');

  const nobody = planProject('perf-run-empty', { review: { cadence: 'monthly', autoReview: true } });
  const none = await runReview({ projectDir: nobody.dir, today: '2026-11-10', spawn: good.spawn, ...noExec });
  assert.match(none.skipped, /No numbers for October 2026/);
  assert.equal(good.calls.length, 1);

  const lockHeld = planProject('perf-run-locked', { review: { cadence: 'monthly', autoReview: true } });
  await seedReels(lockHeld, 3, 1);
  const { acquireRunLock } = await import('../src/calendar/lock.mjs');
  const lock = acquireRunLock(lockHeld.dir, { mode: 'build' });
  assert.equal(lock.ok, true);
  const busy = await runReview({ projectDir: lockHeld.dir, today: TODAY, spawn: good.spawn, ...noExec });
  assert.ok(busy.locked, 'one run at a time per project');
  lock.release();
});

test('`calendar run` mentions a due review and `calendar settings` sets the rhythm', async () => {
  const p = planProject('perf-cli-cal');
  const say = async (...a) => { const lines = []; const l = console.log, e = console.error; console.log = (...x) => lines.push(x.join(' ')); console.error = (...x) => lines.push(x.join(' ')); let code; try { code = await calendarCli.run(a); } finally { console.log = l; console.error = e; } return { code, text: lines.join('\n') }; };
  assert.equal((await say('settings', p.id, '--review', 'monthly', '--auto-review', 'on')).code, 0);
  assert.deepEqual(loadCalendar(p.dir).settings.review, { cadence: 'monthly', autoReview: true });
  assert.equal((await say('settings', p.id, '--review-weekday', 'Friday')).code, 0);
  assert.equal(loadCalendar(p.dir).settings.review.weekday, 'friday');
  assert.equal((await say('settings', p.id, '--auto-review', 'maybe')).code, 2);
  await seedReels(p, 3, 1);
  const dry = await say('run', p.id, '--dry-run', '--today', TODAY);
  assert.match(dry.text, /would write the 2026-09 review/);
  assert.equal((await say('settings', p.id, '--auto-review', 'off')).code, 0);
  const mention = await say('run', p.id, '--today', TODAY);
  assert.match(mention.text, new RegExp(`${p.id}: A monthly review of September 2026 is due`));
  assert.match(mention.text, /autoReview is off/);
  assert.equal((await say('settings', p.id, '--review', 'off')).code, 0);
  assert.equal(loadCalendar(p.dir).settings.review, undefined);
});

// ---- the command line --------------------------------------------------------------------------------------------------------

async function perf(...args) {
  const lines = [];
  const log = console.log, error = console.error;
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  let code;
  try { code = await cli.run(args); } finally { console.log = log; console.error = error; }
  return { code, text: lines.join('\n') };
}

test('cli: import (dry run, then --yes), add, report, due, history, save-review and the owner-only steps', async () => {
  const p = mk('perf-cli', { items: coffeeItems(), docs: true, settings: { review: { cadence: 'monthly' } } });
  const file = join(work, 'export.csv');
  writeFileSync(file, csvOf(['1,x,"Watch the pour: a flat white from grind to last sip #coffee",31,09/15/2026 08:00,,Reel,5400,3100,210,35,6,12,40', '2,x,"Something we did not post through Nordle at all",,09/20/2026 08:00,,Image,5,5,1,0,0,0,0']));
  const dry = await perf('import', p.id, file, '--window', '7d');
  assert.equal(dry.code, 0, dry.text);
  assert.match(dry.text, /2 rows: 1 matched, 0 ambiguous, 1 not on the calendar/);
  assert.match(dry.text, /Dry run: nothing was written\. Run it again with --yes/);
  assert.match(dry.text, /columns understood: .*Description -> caption/);
  assert.equal(loadMetrics(p.dir).items.length, 0);
  const real = await perf('import', p.id, file, '--window', '7d', '--yes', '--captured', '2026-09-30');
  assert.match(real.text, /Written: 1 new, 0 replaced/);
  assert.equal(loadMetrics(p.dir).items[0].capturedAt, '2026-09-30');
  assert.equal((await perf('import', p.id, join(work, 'missing.csv'))).code, 1);
  assert.equal((await perf('import', p.id)).code, 2);

  const add = await perf('add', p.id, '2026-09-04-spring-menu', '--platform', 'instagram', '--window', '28d', '--reach', '900', '--saves', '25', '--completion-rate', '40', '--note', 'from the app');
  assert.equal(add.code, 0, add.text);
  assert.match(add.text, /saved: 2026-09-04-spring-menu on instagram, 28d: reach 900, saves 25, completionRate 0.4/);
  assert.equal((await perf('add', p.id, '2026-09-04-spring-menu', '--bogus', '1')).code, 2);
  assert.equal((await perf('add', p.id, 'nope', '--reach', '1')).code, 1);

  const rep = await perf('report', p.id, '--month', '2026-09', '--today', TODAY);
  assert.equal(rep.code, 0, rep.text);
  assert.match(rep.text, /how the posts did, September 2026/);
  const json = JSON.parse((await perf('report', p.id, '--month', '2026-09', '--json', '--today', TODAY)).text);
  assert.equal(json.schema, 'nordle.performance-report/0.1');
  assert.equal((await perf('report', p.id, '--week', 'banana')).code, 2);
  assert.match((await perf('report', p.id, '--today', TODAY)).text, /September 2026/, 'the default is the last complete month');
  assert.match((await perf('report', p.id, '--week', '--today', TODAY)).text, /Week 42/);

  assert.match((await perf('due', p.id, '--today', TODAY)).text, /monthly review of September 2026 is due/);
  assert.match((await perf('due', '--all', '--today', TODAY)).text, /perf-cli/);
  const prompt = await perf('review-prompt', p.id, '2026-09', '--today', TODAY);
  assert.match(prompt.text, /Review the numbers/);

  const md = join(work, 'review.md'), extra = join(work, 'extra.json');
  writeFileSync(md, '## What worked\nOne reel did very well; one post is not a pattern.\n');
  writeFileSync(extra, JSON.stringify({ directions: [{ kind: 'test', text: 'Try another reel like it' }], mix: { pillars: { drinks: 0.5, harbour: 0.5 } } }));
  const saved = await perf('save-review', p.id, '2026-09', '--file', md, '--extra', extra);
  assert.match(saved.text, /saved reviews\/2026-09\.md/);
  const hist = await perf('history', p.id);
  assert.match(hist.text, /2026-09 +saved .* median score/);
  assert.match(hist.text, /test +Try another reel like it/);
  assert.match((await perf('due', p.id, '--today', TODAY)).text, /is done/);
  assert.equal((await perf('apply-mix', p.id, '2026-09')).code, 0);

  // inside one of Claude's runs the owner's steps are refused
  process.env.NORDLE_AGENT_RUN = '1';
  try {
    assert.equal((await perf('import', p.id, file, '--yes')).code, 3);
    assert.equal((await perf('apply-mix', p.id, '2026-09')).code, 3);
    assert.equal((await perf('add', p.id, '2026-09-04-spring-menu', '--reach', '901')).code, 0, 'typing a number in is allowed');
    assert.equal(loadMetrics(p.dir).items.find((e) => e.post === '2026-09-04-spring-menu' && e.window === '7d').by, 'claude');
  } finally { delete process.env.NORDLE_AGENT_RUN; }
  assert.equal((await perf('bogus')).code, 2);
  assert.equal((await perf('help')).code, 0);
});

// ---- over HTTP, with the two tokens ------------------------------------------------------------------------------------------

async function call(role, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'x-nordle-token': role === 'human' ? HUMAN : role === 'agent' ? AGENT : 'nope', 'content-type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}
const human = (m, p, b) => call('human', m, p, b);
const agent = (m, p, b) => call('agent', m, p, b);

test('HTTP: Claude can read, type numbers in and save a review; only the owner imports a file or applies a mix', async () => {
  assert.equal((await call('none', 'GET', '')).status, 401);
  const overview = (await agent('GET', '')).json;
  assert.deepEqual([overview.project, overview.entries, overview.windows], [P.id, 0, ['7d', '28d', 'lifetime']]);
  assert.equal(overview.review.configured, false);

  // numbers by hand: both may; the stamp says who
  const body = { post: '2026-09-02-flat-white-pour', platform: 'instagram', window: '7d', capturedAt: '2026-09-20', metrics: { plays: 5400, reach: 3100, likes: 210, shares: 35, saves: 40, completionRate: 0.52 } };
  const a = await agent('POST', '/metrics', body);
  assert.equal(a.status, 200, a.text);
  assert.equal(a.json.entry.by, 'claude');
  const h = await human('POST', '/metrics', { ...body, metrics: { ...body.metrics, plays: 5500 } });
  assert.deepEqual([h.status, h.json.replaced, h.json.entry.by], [200, true, 'owner']);
  const bad = await agent('POST', '/metrics', { ...body, post: 'nope' });
  assert.equal(bad.status, 422);
  assert.match(bad.json.errors[0].message, /no calendar item/);
  assert.equal((await agent('POST', '/metrics', { ...body, metrics: { reach: -1 } })).status, 422);
  const many = await human('POST', '/metrics', { entries: [{ post: '2026-09-09-oat-myth', platform: 'instagram', capturedAt: '2026-09-25', metrics: { plays: 2000, reach: 1500 } }, { post: 'nope', platform: 'instagram', metrics: { reach: 1 } }] });
  assert.deepEqual([many.json.added.length, many.json.rejected.length], [1, 1]);
  assert.equal((await agent('GET', '/metrics?post=2026-09-09-oat-myth')).json.items.length, 1);
  assert.equal((await agent('GET', '/metrics')).json.items.length, 2);

  // a file: the owner only
  const csv = csvOf(['1,x,"Does oat milk always split in hot coffee? Not if you do this.",,2026-09-09 07:00,,Reel,1,1,1,1,1,1,1']);
  assert.equal((await agent('POST', '/import', { csv, yes: true })).status, 403);
  const before = JSON.stringify(loadMetrics(P.dir));
  const dry = await human('POST', '/import', { csv, window: '7d', capturedAt: '2026-09-30' });
  assert.equal(dry.status, 200, dry.text);
  assert.deepEqual([dry.json.dryRun, dry.json.matched.length, dry.json.written], [true, 1, null]);
  assert.equal(JSON.stringify(loadMetrics(P.dir)), before, 'a dry run over HTTP writes nothing');
  assert.equal((await human('POST', '/import', { csv: '' })).status, 400);
  assert.equal((await human('POST', '/import', { csv: 'colour\nred' })).status, 422);
  const wrote = await human('POST', '/import', { csv, window: '28d', capturedAt: '2026-10-10', yes: true });
  assert.deepEqual(wrote.json.written, { added: 1, replaced: 0, rejected: 0 });

  // the report
  const rep = await agent('GET', '/report?period=2026-09&window=7d');
  assert.equal(rep.status, 200);
  const r = rep.json;
  assert.equal(r.schema, 'nordle.performance-report/0.1');
  assert.deepEqual([r.period.id, r.period.kind, r.window], ['2026-09', 'month', '7d']);
  for (const k of ['counts', 'headline', 'posts', 'top', 'bottom', 'segments', 'segmentsAll', 'gaps', 'caveats', 'followUp', 'markdown']) assert.ok(k in r, k);
  assert.ok(r.posts.every((x) => 'thumb' in x && 'scoreBasis' in x));
  assert.match(r.markdown, /how the posts did/);
  assert.equal((await agent('GET', '/report?period=banana')).status, 400);
  assert.equal((await agent('GET', '/report?period=2026-09&window=1y')).status, 400);
  assert.equal((await agent('GET', '/report?kind=week')).json.period.kind, 'week');
  assert.equal((await agent('GET', '/report')).json.period.id, '2026-09', 'the default is the last complete month');

  // the prompt and the due check
  const pr = await agent('GET', '/prompt?period=2026-09');
  assert.match(pr.json.prompt, /Review the numbers/);
  assert.equal((await agent('GET', '/due?today=2026-10-20')).json.configured, false);

  // reviews: Claude may save one; it cannot apply the mix
  const rv = await agent('POST', '/reviews', { period: '2026-09', markdown: '## What worked\nOne reel did well, but one post is not a pattern.', directions: [{ kind: 'test', text: 'Try another reel like it', confidence: 'low' }], mix: { pillars: { drinks: 0.6, harbour: 0.4 } } });
  assert.equal(rv.status, 200, rv.text);
  assert.equal(rv.json.review.meta.by, 'claude');
  assert.equal((await agent('POST', '/reviews/2026-09/apply-mix', {})).status, 403);
  assert.deepEqual(loadCalendar(P.dir).settings.pillars.map((x) => x.share), [0.5, 0.5], 'nothing changed');
  assert.equal((await agent('POST', '/reviews', { period: 'soon', markdown: 'x'.repeat(40) })).status, 400);
  const list = (await agent('GET', '/reviews')).json;
  assert.deepEqual(list.reviews.map((x) => x.period), ['2026-09']);
  assert.equal(list.reviews[0].directions[0].kind, 'test');
  assert.match((await agent('GET', '/reviews/2026-09')).json.markdown, /^## What worked/);
  assert.equal((await agent('GET', '/reviews/2026-08')).status, 404);
  const applied = await human('POST', '/reviews/2026-09/apply-mix', {});
  assert.equal(applied.status, 200, applied.text);
  assert.deepEqual(loadCalendar(P.dir).settings.pillars.map((x) => x.share), [0.6, 0.4]);
  assert.equal((await human('POST', '/reviews/2026-05/apply-mix', {})).status, 404);

  // plan changes by Claude over HTTP follow the calendar rules
  const planned = await agent('POST', '/reviews', { period: '2026-08', markdown: '## What worked\nNothing much; there are no numbers for August.', plan: { amend: [{ item: '2026-09-18-harbour-sunrise', set: { hook: 'changed' } }] } });
  assert.equal(planned.json.plan.skipped.length, 1, 'a built post is left alone');

  // the owner's mistakes: JSON only
  const text = await fetch(`${base}/metrics`, { method: 'POST', headers: { 'x-nordle-token': HUMAN, 'content-type': 'text/plain' }, body: 'x' });
  assert.equal(text.status, 415);
  assert.equal((await human('POST', '/metrics', '{not json')).status, 400);
  assert.equal(validateMetrics(loadMetrics(P.dir)).ok, true);
  assert.equal(validateCalendar(loadCalendar(P.dir)).ok, true);
});

// ---- Claude's MCP tools ------------------------------------------------------------------------------------------------------

test('MCP: the performance tools exist, are described, and none of them can import a file, apply a mix or change settings', async () => {
  const client = new NordleClient({ dir: runtimeDir, autostart: false });
  const all = new Map(createTools(client).map((t) => [t.name, t]));
  const names = ['nordle_performance_report', 'nordle_performance_prompt', 'nordle_performance_save_review', 'nordle_performance_add'];
  for (const name of names) {
    const t = all.get(name);
    assert.ok(t, name);
    assert.ok(t.description.length > 120, `${name} needs a real description`);
    assert.equal(t.inputSchema.type, 'object');
    assert.ok(t.annotations?.readOnlyHint || t.annotations?.destructiveHint === false);
  }
  assert.ok(![...all.keys()].some((n) => /performance.*(import|apply|settings|mix)/.test(n)));
  assert.match(all.get('nordle_performance_add').description, /never estimate/i);
  assert.match(all.get('nordle_performance_save_review').description, /must not claim that anything caused/);

  const use = (name, a) => all.get(name).handler(a);
  const added = await use('nordle_performance_add', { project: P.id, post: '2026-09-04-spring-menu', platform: 'instagram', window: '7d', capturedAt: '2026-09-20', metrics: { reach: 800, saves: 33 } });
  assert.match(added.text, /Saved the 7d numbers for 2026-09-04-spring-menu on instagram: reach 800, saves 33/);
  await assert.rejects(use('nordle_performance_add', { project: P.id, post: 'nope', platform: 'instagram', metrics: { reach: 1 } }), (e) => e instanceof NordleError || /no calendar item/.test(e.message));
  const rep = await use('nordle_performance_report', { project: P.id, period: '2026-09' });
  assert.match(rep.text, /how the posts did, September 2026/);
  assert.ok(Array.isArray(rep.json.posts) && !('markdown' in rep.json));
  assert.ok(rep.json.posts.every((x) => !('scoreBasis' in x)), 'the long score workings are trimmed from the JSON Claude gets');
  const prompt = await use('nordle_performance_prompt', { project: P.id, period: '2026-09' });
  assert.match(prompt.text, /nordle_performance_save_review/);
  const saved = await use('nordle_performance_save_review', {
    project: P.id, period: '2026-07', markdown: '## What worked\nThere were no numbers in July, so there is nothing to say yet.\n\n## What did not\nNothing.',
    directions: [{ kind: 'test', text: 'Collect the 7-day numbers for every reel' }],
    plan: { ideas: [{ date: '2026-11-18', format: 'reel', title: 'Latte art in ten seconds', pillar: 'drinks', idea: 'A ten second latte art pour, start to finish, at the machine.', hook: 'Ten seconds, one heart.' }], amend: [{ item: '2026-09-18-harbour-sunrise', set: { hook: 'x' } }] },
  });
  assert.match(saved.text, /Saved the 2026-07 review/);
  assert.match(saved.text, /Ideas: 1 added/);
  assert.match(saved.text, /Left alone: 2026-09-18-harbour-sunrise/);
  assert.equal(loadCalendar(P.dir).items.find((i) => i.title === 'Latte art in ten seconds').status, 'idea');
});

test('the build prompt is not given the performance tools as if they were verification tools', async () => {
  const { buildPrompt } = await import('../src/calendar/prompts.mjs');
  const text = buildPrompt(P.dir, '2026-09-18-harbour-sunrise', { today: TODAY, mode: 'build' });
  assert.ok(!text.includes('nordle_performance_save_review'));
  void n;
});
